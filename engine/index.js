// Kairos engine: a background service that outlives the window. It runs OpenWA, receives its
// webhooks, sorts messages from monitored DMs and files the ones that matter into Notion.
const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { spawn } = require('child_process');
const config = require('./config');
const openwa = require('./openwa');
const epsilon = require('./epsilon');
const notion = require('./notion');
const { classify, parseWhen } = require('./classify');
const { mergeContacts, digits } = require('./contacts');
const { windowFor, closeWindow, catchUpSince, slim, newerVersion } = require('./sync');

const { paths, PORTS, VERSION } = config;
const cfg = config.load();
// Paused by an older Kairos (no windows yet): open one so nothing is filed while paused.
if (cfg.paused && !cfg.pauses.some((w) => w.state === 'open')) { cfg.pauses.push({ id: crypto.randomUUID(), from: Date.now(), to: null, state: 'open' }); config.save(); }
const wa = openwa.createClient(cfg.openwaKey);
const logger = notion.createLogger(config.get, config.save);
const HOOK_URL = `http://127.0.0.1:${PORTS.engine}/hook`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const nowS = () => Math.floor(Date.now() / 1000);

const logFile = fs.createWriteStream(path.join(paths.logs, 'engine.log'), { flags: 'a' });
const log = (...a) => logFile.write(`[${new Date().toISOString()}] ${a.join(' ')}\n`);

// --- persisted state ------------------------------------------------------------------------

const activity = config.store('activity.json', []);
const seenStore = config.store('seen.json', []); // webhook deliveries and catch-up overlap: dedupe across restarts
const outbox = config.store('outbox.json', []); // filings that failed or wait for Notion, retried with backoff
const buffer = config.store('pause-buffer.json', {}); // pause window id -> [{ chatId, m }] received while paused
const docIndex = config.store('documents.json', {}); // sha256 -> { chatId, localPath, at }: skip duplicate files
const alive = config.store('alive.json', { at: null }); // heartbeat: how long Kairos was off
const seen = new Set(seenStore.data);
for (const j of outbox.data) delete j.running;

// --- live state + server-sent events ------------------------------------------------------

const state = { wa: { status: 'starting', qr: null, me: null, restriction: null, error: null, relogin: false, since: Date.now() }, update: null };
const health = {
  startedAt: Date.now(),
  notion: { ok: null, at: null, error: null },
  lastMessageAt: null,
  catchup: { running: false, done: 0, total: 0, found: 0, at: null, error: null },
};

const clients = new Set();
function broadcast(type, data) {
  const line = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) res.write(line);
}

let catchUpTimer = null;
function setWa(patch) {
  const was = state.wa.status;
  Object.assign(state.wa, patch);
  if (patch.status && patch.status !== was) {
    state.wa.since = Date.now();
    // Freshly connected: give WhatsApp Web a moment to sync, then fetch what was missed.
    if (patch.status === 'ready') { clearTimeout(catchUpTimer); catchUpTimer = setTimeout(() => catchUp('reconnected'), 20_000); }
  }
  broadcast('wa', state.wa);
}

function addActivity(entry) {
  const e = { id: crypto.randomUUID(), at: new Date().toISOString(), ...entry };
  activity.data.unshift(e);
  activity.data = activity.data.slice(0, 500);
  activity.save();
  broadcast('activity', e);
  return e;
}

function patchActivity(id, patch) {
  const e = activity.data.find((a) => a.id === id);
  if (!e) return;
  Object.assign(e, patch);
  activity.save();
  broadcast('activity-update', e);
}

const outboxSummary = () => ({
  pending: outbox.data.filter((j) => !j.waiting).length,
  waiting: outbox.data.filter((j) => j.waiting).length,
  nextAt: outbox.data.filter((j) => !j.waiting).map((j) => j.nextAt).sort((a, b) => a - b)[0] || null,
});

function pauseSummary() {
  return cfg.pauses.filter((w) => w.state !== 'done').map((w) => {
    const items = buffer.data[w.id] || [];
    const chats = {};
    for (const { chatId } of items) chats[chatId] = (chats[chatId] || 0) + 1;
    return { ...w, count: items.length, chats: Object.entries(chats).map(([chatId, count]) => ({ chatId, count, name: cfg.monitored[chatId]?.name || cfg.monitored[chatId]?.number || chatId })) };
  }).filter((w) => w.state === 'open' || w.count);
}

function snapshot() {
  const n = cfg.notion;
  return {
    version: VERSION,
    platform: process.platform,
    wa: state.wa,
    waEngine: cfg.waEngine,
    notion: n ? { workspace: n.workspace, ready: !!n.dbs, parent: n.parent?.title, homeUrl: n.homeUrl, dbs: n.dbs && Object.fromEntries(Object.entries(n.dbs).map(([k, v]) => [k, v.url])) } : null,
    epsilon: { ...epsilon.status(), enabled: cfg.epsilon.enabled },
    paused: cfg.paused,
    pauses: pauseSummary(),
    stats: cfg.stats,
    monitored: Object.keys(cfg.monitored).length,
    docsDir: paths.docs,
    health,
    outbox: outboxSummary(),
    update: state.update,
    digest: cfg.digest,
    activity: activity.data.slice(0, 80),
  };
}
const pushHealth = () => broadcast('health', { health, outbox: outboxSummary(), pauses: pauseSummary(), paused: cfg.paused });

// --- WhatsApp session -----------------------------------------------------------------------

async function ensureSession({ start = false } = {}) {
  let [s] = await wa.get(`/api/sessions?name=${openwa.SESSION_NAME}`);
  if (!s) s = await wa.post('/api/sessions', { name: openwa.SESSION_NAME, config: { maxReconnectAttempts: 10, reconnectBaseDelay: 15000 } });
  if (cfg.sessionId !== s.id) { cfg.sessionId = s.id; config.save(); }

  // Re-register our webhook on every boot so its secret always matches the config.
  const hooks = await wa.get(`/api/sessions/${s.id}/webhooks`);
  for (const h of hooks.filter((h) => h.url === HOOK_URL)) await wa.del(`/api/sessions/${s.id}/webhooks/${h.id}`);
  await wa.post(`/api/sessions/${s.id}/webhooks`, {
    url: HOOK_URL,
    secret: cfg.webhookSecret,
    events: ['message.received', 'message.sent', 'session.status', 'session.qr', 'session.authenticated', 'session.disconnected', 'session.restriction'],
  });

  if ((start || cfg.everLinked) && !s.engineLoaded) s = await wa.post(`/api/sessions/${s.id}/start`);
  syncSession(s);
}

function syncSession(s) {
  setWa({ status: s.status, me: s.phone ? { phone: s.phone, name: s.pushName } : state.wa.me, restriction: s.restriction, error: s.lastError });
}

async function refreshQr() {
  try {
    const r = await wa.get(`/api/sessions/${cfg.sessionId}/qr`);
    onQr(r.qrCode);
  } catch {}
}

function onQr(qr) {
  const relogin = cfg.everLinked; // a QR after a successful link means the session ended
  setWa({ status: 'qr_ready', qr, relogin });
  if (relogin) {
    broadcast('relogin', {});
    if (!clients.size) launchUi(['--relogin']); // window closed: bring it back to show the QR
  }
}

// Brings the UI back (e.g. to show a fresh QR). Desktop: relaunch the app. Browser (Mac): open the page.
function launchUi(args) {
  try {
    const ui = JSON.parse(process.env.KAIROS_UI || 'null');
    if (!ui) return;
    if (ui.url) {
      osOpen(ui.url + (args.includes('--relogin') ? '#relogin' : ''));
      if (process.platform === 'darwin') notify('Your WhatsApp session ended. Scan the QR code to keep monitoring.');
    } else spawn(ui.cmd, [...ui.args, ...args], { detached: true, stdio: 'ignore' }).unref();
  } catch (e) { log('launchUi failed', e.message); }
}

function osOpen(target, reveal = false) {
  if (process.platform === 'darwin') spawn('open', reveal ? ['-R', target] : [target], { detached: true, stdio: 'ignore' }).unref();
  else if (process.platform === 'win32') spawn('explorer.exe', reveal ? [`/select,${target}`] : [target], { detached: true, stdio: 'ignore' }).unref();
  else spawn('xdg-open', [reveal ? path.dirname(target) : target], { detached: true, stdio: 'ignore' }).unref();
}

function notify(text) {
  if (process.platform !== 'darwin') return;
  const q = (t) => JSON.stringify(String(t)); // AppleScript string literal
  spawn('osascript', ['-e', `display notification ${q(text)} with title "Kairos"`], { stdio: 'ignore' }).unref();
}

// Only paths inside the Kairos documents folder may be opened from the UI.
function insideDocs(p) {
  const abs = path.resolve(String(p || ''));
  if (abs !== paths.docs && !abs.startsWith(paths.docs + path.sep)) throw Object.assign(new Error('Not a Kairos document'), { status: 400 });
  return abs;
}

// Mac start-at-login is a LaunchAgent written by install.sh; toggling parks it as *.disabled.
const AGENT = path.join(require('os').homedir(), 'Library', 'LaunchAgents', 'app.kairos.engine.plist');
// Windows (Tauri shell): the per-user Run key starts the app hidden at login.
const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
function autostart(on) {
  if (process.platform === 'win32') {
    const ui = JSON.parse(process.env.KAIROS_UI || 'null');
    if (process.env.KAIROS_SHELL !== 'tauri' || !ui?.cmd) return { supported: false };
    const reg = (...a) => require('child_process').execFileSync('reg', a, { stdio: 'pipe', windowsHide: true });
    try {
      if (on === true) reg('add', RUN_KEY, '/v', 'Kairos', '/t', 'REG_SZ', '/d', `"${ui.cmd}" --hidden`, '/f');
      if (on === false) reg('delete', RUN_KEY, '/v', 'Kairos', '/f');
    } catch (e) { if (on !== false) throw e; } // deleting a missing value is fine
    try { reg('query', RUN_KEY, '/v', 'Kairos'); return { supported: true, on: true }; } catch { return { supported: true, on: false }; }
  }
  if (process.platform !== 'darwin') return { supported: false };
  if (on === true && fs.existsSync(AGENT + '.disabled')) fs.renameSync(AGENT + '.disabled', AGENT);
  if (on === false && fs.existsSync(AGENT)) fs.renameSync(AGENT, AGENT + '.disabled');
  return { supported: true, on: fs.existsSync(AGENT) };
}

// --- contacts -------------------------------------------------------------------------------

const CONTACTS_FILE = path.join(paths.data, 'contacts.json');
let contacts = { at: 0, list: [] };
try { contacts = JSON.parse(fs.readFileSync(CONTACTS_FILE, 'utf8')); } catch {}

// Reads every page of a list endpoint (OpenWA caps a page at 1000).
async function readAll(p) {
  const out = [];
  for (let offset = 0; ; offset += 1000) {
    const page = await wa.get(`${p}?limit=1000&offset=${offset}`, { timeout: 240_000 }); // big accounts are slow
    out.push(...page);
    if (page.length < 1000) return out;
  }
}

// Background loader. Right after linking, WhatsApp Web syncs history and reloads its page a few
// times, so reads fail for a few minutes: retry gently instead of surfacing an error.
// Anti-ban: the address book is read at most every 10 minutes, and profile pictures never.
const contactsJob = { loading: false, error: null, attempt: 0 };
function refreshContacts(force) {
  if (contactsJob.loading) return;
  if (contacts.list.length && (!force || Date.now() - contacts.at < 10 * 60_000)) return;
  contactsJob.loading = true;
  broadcast('contacts', { loading: true });
  loadContacts()
    .then(() => { contactsJob.attempt = 0; contactsJob.error = null; })
    .catch((e) => {
      contactsJob.error = e.message;
      log('contacts', e.message);
      if (++contactsJob.attempt <= 6) setTimeout(() => refreshContacts(true), 20_000 * 2 ** (contactsJob.attempt - 1)); // 20s … ~10m
    })
    .finally(() => { contactsJob.loading = false; broadcast('contacts', { loading: false, error: contactsJob.error }); });
}

async function loadContacts() {
  const sid = cfg.sessionId;
  const chats = await readAll(`/api/sessions/${sid}/chats`);
  const people = await readAll(`/api/sessions/${sid}/contacts`).catch(() => []);
  const list = mergeContacts(chats, people, state.wa.me?.phone);
  const me = list.find((r) => r.self);
  for (const r of list) if (cfg.monitored[r.id]) Object.assign(cfg.monitored[r.id], { name: r.name, number: r.number }); // fix stale ids-as-numbers
  cfg.selfIds = [...new Set([state.wa.me?.phone && `${state.wa.me.phone}@c.us`, me?.id].filter(Boolean))]; // your "message yourself" chat
  config.save();
  contacts = { at: Date.now(), list };
  fs.writeFile(CONTACTS_FILE, JSON.stringify(contacts), () => {});
  return contacts.list;
}

// --- message intake -------------------------------------------------------------------------

let queue = Promise.resolve();
const enqueue = (fn) => (queue = queue.then(fn).catch((e) => log('pipeline', e.stack)));

// Returns true when the message was new and accepted (filed, buffered or queued).
// live: delivered by a webhook just now (vs. read back from history during catch-up).
function onMessage(m, live = false) {
  let chatId = m.chatId || m.from;
  const dm = m.kind ? m.kind === 'individual' : /@(c\.us|lid)$/.test(chatId || '');
  const selfChat = (cfg.selfIds || []).includes(chatId);
  if (!dm || (m.fromMe && !selfChat)) return false; // your own messages count only in your self-chat (notes, forwards)
  // WhatsApp's privacy ids: a person can deliver from …@lid while being watched under another id.
  if (!cfg.monitored[chatId] && m.senderPhone) {
    const hit = Object.entries(cfg.monitored).find(([, w]) => w.number && digits(w.number) === digits(m.senderPhone));
    if (hit) chatId = hit[0];
  }
  const who = cfg.monitored[chatId];
  if (!who || !m.id || seen.has(m.id)) return false;
  seen.add(m.id);
  seenStore.data.push(m.id);
  if (seenStore.data.length > 6000) { seenStore.data = seenStore.data.slice(-5000); seen.clear(); seenStore.data.forEach((x) => seen.add(x)); }
  seenStore.save();

  const ts = m.timestamp || nowS();
  if (ts > (cfg.lastSeen[chatId] || 0)) cfg.lastSeen[chatId] = ts;
  health.lastMessageAt = Date.now();

  // Arrived (or was sent) during a pause: keep it aside until the user decides to sync or skip.
  // Live arrivals while paused always count as paused: WhatsApp times are whole seconds and phone
  // clocks drift, so the timestamp alone is only trusted for history read back later.
  const win = (live && cfg.paused && cfg.pauses.find((w) => w.state === 'open')) || windowFor(cfg.pauses, ts * 1000);
  if (win) {
    (buffer.data[win.id] ||= []).push({ chatId, m: slim(m) });
    if (buffer.data[win.id].length > 5000) buffer.data[win.id].shift();
    if (win.state === 'done') win.state = 'pending'; // late arrival (catch-up) for a settled window
    buffer.save(); config.save(); pushHealth();
    return true;
  }
  config.save();
  enqueue(() => handleMessage(chatId, who, m));
  return true;
}

// --- documents --------------------------------------------------------------------------------

const safe = (s) => String(s || 'Unknown').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/\.+$/, '').trim().slice(0, 80) || 'Unknown';
const EXT = { 'application/pdf': 'pdf', 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'video/mp4': 'mp4' };

async function saveMedia(chatId, who, m) {
  const res = await wa.get(`/api/sessions/${cfg.sessionId}/messages/${encodeURIComponent(chatId)}/${encodeURIComponent(m.id)}/media`, { raw: true, timeout: 120000 });
  const buffer = Buffer.from(await res.arrayBuffer());
  const hash = crypto.createHash('sha256').update(buffer).digest('hex');
  const dup = docIndex.data[hash];
  if (dup && dup.chatId === chatId && fs.existsSync(dup.localPath)) return { duplicate: dup, name: path.basename(dup.localPath), localPath: dup.localPath };

  const mimetype = (res.headers.get('content-type') || m.media?.mimetype || 'application/octet-stream').split(';')[0];
  const fromHeader = /filename\*?=(?:UTF-8'')?"?([^";]+)/i.exec(res.headers.get('content-disposition') || '')?.[1];
  const d = new Date((m.timestamp || nowS()) * 1000);
  let name = safe(m.media?.filename || (fromHeader && decodeURIComponent(fromHeader)) || `${m.type}-${d.toISOString().slice(0, 19).replace(/[:T]/g, '-')}.${EXT[mimetype] || 'bin'}`);
  const dir = path.join(paths.docs, safe(who.name || who.number), `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
  fs.mkdirSync(dir, { recursive: true });
  const { name: base, ext } = path.parse(name);
  for (let i = 2; fs.existsSync(path.join(dir, name)); i++) name = `${base} (${i})${ext}`;
  const localPath = path.join(dir, name);
  fs.writeFileSync(localPath, buffer);
  docIndex.data[hash] = { chatId, localPath, at: new Date().toISOString() };
  docIndex.save();
  return { mimetype, name, localPath };
}

// --- filing (with retries) ------------------------------------------------------------------

// Re-runs the idempotent Notion setup: recreates deleted databases, adds missing columns.
async function healNotion() {
  if (!cfg.notion?.token || !cfg.notion.parent) return;
  Object.assign(cfg.notion, await notion.ensure(cfg.notion.token, cfg.notion.parent));
  config.save();
}
const notionGone = (e) => e.code === 'object_not_found' || /archived|in_trash|Could not find/i.test(e.message || '');

function notionStatus(ok, error) {
  const was = health.notion.ok;
  Object.assign(health.notion, { ok, at: Date.now(), error: ok ? null : String(error || '').slice(0, 200) });
  if (was !== ok) pushHealth();
}

async function fileToNotion(kind, chatId, who, ev, file) {
  try {
    let r;
    try { r = await logger[kind](chatId, who, ev, file); } catch (e) {
      if (!notionGone(e)) throw e;
      log('notion target missing, healing', e.message);
      delete cfg.people[chatId]; // the person's page may be the thing that was deleted
      await healNotion();
      r = await logger[kind](chatId, who, ev, file);
    }
    notionStatus(true);
    return r;
  } catch (e) { notionStatus(false, e.message); throw e; }
}

// One filing attempt. A job is { id (activity id), chatId, who, ev, msg, file?, attempts, nextAt }.
async function runJob(job) {
  if (job.ev.kind === 'document' && !job.file) {
    const f = await saveMedia(job.chatId, job.who, job.msg);
    job.file = { localPath: f.localPath, name: f.name, mimetype: f.mimetype, duplicate: f.duplicate?.at || null };
    patchActivity(job.id, { localPath: f.localPath, title: f.name });
  }
  if (job.file?.duplicate) return { note: `Same file as one received ${new Date(job.file.duplicate).toLocaleDateString()} — not filed twice` };
  if (!cfg.notion?.dbs) throw Object.assign(new Error('Waiting for Notion'), { waiting: true });
  const file = job.file && { ...job.file, buffer: fs.readFileSync(job.file.localPath) };
  return fileToNotion(job.ev.kind, job.chatId, job.who, job.ev, file);
}

const running = new Set();
async function attempt(job) {
  if (running.has(job.id)) return;
  running.add(job.id);
  try {
    const r = await runJob(job);
    outbox.data = outbox.data.filter((j) => j.id !== job.id);
    patchActivity(job.id, { pending: false, error: null, note: r.note || null, notionUrl: r.url || null, undo: r.undo || [] });
  } catch (e) {
    if (!outbox.data.includes(job)) outbox.data.push(job);
    if (e.waiting) {
      job.waiting = true;
      patchActivity(job.id, { pending: true, error: null, note: 'Waiting for Notion — files itself once you connect' });
    } else {
      job.waiting = false;
      job.attempts = (job.attempts || 0) + 1;
      job.nextAt = Date.now() + Math.min(6 * 3600_000, 60_000 * 2 ** (job.attempts - 1)); // 1m, 2m, 4m … 6h
      job.error = e.message.slice(0, 300);
      log('file', job.ev.kind, e.message);
      patchActivity(job.id, { pending: true, error: job.error, retryAt: job.nextAt, note: null });
    }
  } finally {
    running.delete(job.id);
    outbox.save();
    pushHealth();
  }
}

function retryOutbox(force) {
  const now = Date.now();
  for (const job of outbox.data) {
    if (job.waiting ? !cfg.notion?.dbs : !force && job.nextAt > now) continue;
    enqueue(() => attempt(job));
  }
}

async function handleMessage(chatId, who, m) {
  const useModel = cfg.epsilon.enabled && epsilon.installed();
  const ev = await classify(m, useModel ? epsilon.embed : null);
  const mode = who.mode || 'all';
  if (mode === 'everything' && ev.kind === 'noise' && ['epsilon', 'rules'].includes(ev.reason)) Object.assign(ev, { kind: 'important', title: (m.body || '').trim().split('\n')[0].slice(0, 90) });
  if (mode === 'docs' && ev.kind !== 'document') ev.kind = 'noise';
  if (ev.kind === 'noise') { cfg.stats.noise++; config.save(); broadcast('stats', cfg.stats); return; }

  ev.text = m.body || '';
  cfg.stats.logged++;
  const key = { document: 'documents', meeting: 'meetings', order: 'orders' }[ev.kind];
  if (key) cfg.stats[key]++;
  config.save();
  broadcast('stats', cfg.stats);

  const entry = addActivity({ kind: ev.kind, chatId, name: who.name || who.number, title: ev.title, when: ev.when || null, text: ev.text.slice(0, 2000), msgAt: m.timestamp || nowS(), pending: true });
  await attempt({ id: entry.id, chatId, who: { ...who }, ev, msg: slim(m), attempts: 0, nextAt: 0 });
}

// Moves an already-filed item to another kind (or drops it as noise), undoing its Notion blocks.
async function refile(id, kind) {
  const e = activity.data.find((a) => a.id === id);
  if (!e) throw Object.assign(new Error('Item not found'), { status: 404 });
  if (!['meeting', 'order', 'important', 'noise'].includes(kind) || e.kind === 'document') throw Object.assign(new Error('This item cannot be re-filed'), { status: 400 });
  if (e.pending) throw Object.assign(new Error('Still syncing — try again in a moment'), { status: 409 });
  if (cfg.notion?.dbs && e.undo?.length) await logger.undo(e.undo);
  const counter = { meeting: 'meetings', order: 'orders' };
  if (counter[e.kind]) cfg.stats[counter[e.kind]] = Math.max(0, cfg.stats[counter[e.kind]] - 1);
  if (kind === 'noise') {
    cfg.stats.logged = Math.max(0, cfg.stats.logged - 1);
    cfg.stats.noise++;
    activity.data = activity.data.filter((a) => a !== e);
    activity.save();
    config.save();
    broadcast('activity-remove', { id });
    broadcast('stats', cfg.stats);
    return { removed: true };
  }
  if (counter[kind]) cfg.stats[counter[kind]]++;
  config.save();
  broadcast('stats', cfg.stats);
  const who = cfg.monitored[e.chatId] || { name: e.name };
  const ev = { kind, title: e.title, text: e.text || e.title, when: kind === 'meeting' ? parseWhen(e.text || e.title, new Date((e.msgAt || nowS()) * 1000)) : null };
  patchActivity(id, { kind, when: ev.when, undo: [], notionUrl: null, pending: true });
  await attempt({ id, chatId: e.chatId, who, ev, msg: { id: e.msgId }, attempts: 0, nextAt: 0 });
  return activity.data.find((a) => a.id === id);
}

// --- pause windows ------------------------------------------------------------------------

function setPaused(on) {
  on = !!on;
  if (on === cfg.paused) return;
  cfg.paused = on;
  if (on) cfg.pauses.push({ id: crypto.randomUUID(), from: Date.now(), to: null, state: 'open' });
  else for (const w of cfg.pauses) if (w.state === 'open') closeWindow(w, (buffer.data[w.id] || []).length);
  // Keep a month of settled windows: late catch-up messages still need to know they were paused.
  cfg.pauses = cfg.pauses.filter((w) => w.state !== 'done' || Date.now() - (w.to || 0) < 30 * 86400_000);
  config.save();
  broadcast('state', snapshot());
}

// Sync (file) or skip the buffered messages of one window, for all or some chats.
function settleWindow(id, chats, sync) {
  const w = cfg.pauses.find((x) => x.id === id);
  if (!w) throw Object.assign(new Error('Pause not found'), { status: 404 });
  const items = buffer.data[id] || [];
  const pick = (x) => !chats?.length || chats.includes(x.chatId);
  let n = 0;
  for (const { chatId, m } of items.filter(pick)) {
    n++;
    if (!sync) continue;
    const who = cfg.monitored[chatId];
    if (who) enqueue(() => handleMessage(chatId, who, m));
  }
  buffer.data[id] = items.filter((x) => !pick(x));
  if (!buffer.data[id].length) { delete buffer.data[id]; if (w.state !== 'open') w.state = 'done'; }
  buffer.save();
  config.save();
  pushHealth();
  return { [sync ? 'synced' : 'skipped']: n };
}

// --- catch-up: messages that arrived while Kairos was off, asleep or disconnected -----------

let catching = false;
let pendingGap = null; // activity id of the latest offline gap, credited with what catch-up finds

async function catchUp(reason) {
  if (catching || state.wa.status !== 'ready' || !cfg.sessionId) return;
  const chats = Object.keys(cfg.monitored);
  if (!chats.length) return;
  // Baileys has no history read; WhatsApp replays offline messages to it on reconnect instead.
  if (cfg.waEngine === 'baileys') { if (pendingGap) patchActivity(pendingGap, { caught: 'replayed by WhatsApp' }); pendingGap = null; return; }
  catching = true;
  Object.assign(health.catchup, { running: true, done: 0, total: chats.length, found: 0, error: null, reason });
  pushHealth();
  try {
    for (const chatId of chats) {
      const since = catchUpSince(cfg.lastSeen[chatId], cfg.monitored[chatId]?.since, alive.prev, nowS());
      if (since !== null) {
        const gapH = (nowS() - since) / 3600;
        try {
          // Reads WhatsApp Web's local copy of the chat: no messages sent, nothing marked as read.
          const msgs = await wa.get(`/api/sessions/${cfg.sessionId}/messages/${encodeURIComponent(chatId)}/history?limit=${gapH > 24 ? 100 : 40}`, { timeout: 90_000 });
          for (const m of msgs || []) if ((m.timestamp || 0) > since && onMessage({ ...m, chatId })) health.catchup.found++;
        } catch (e) {
          if (e.status === 501) break;
          health.catchup.error = e.message.slice(0, 200);
          log('catchup', chatId, e.message);
        }
      }
      if (!cfg.lastSeen[chatId]) cfg.lastSeen[chatId] = nowS(); // nothing older will ever be fetched again
      health.catchup.done++;
      pushHealth();
      await sleep(2500); // one chat at a time, gently
    }
  } finally {
    Object.assign(health.catchup, { running: false, at: Date.now() });
    config.save();
    if (pendingGap) patchActivity(pendingGap, { caught: health.catchup.found });
    pendingGap = null;
    catching = false;
    pushHealth();
    log(`catch-up (${reason}): ${health.catchup.found} new`);
  }
}

function addGap(from, to, reason) {
  if (to - from < 120_000) return;
  pendingGap = addActivity({ kind: 'gap', name: 'Kairos', title: reason, from: new Date(from).toISOString(), to: new Date(to).toISOString(), caught: null }).id;
}

// Heartbeat: a tick that arrives much later than scheduled means the computer slept.
alive.prev = alive.data.at ? Math.floor(alive.data.at / 1000) : null;
let lastTick = Date.now();
setInterval(() => {
  const now = Date.now();
  if (now - lastTick > 90_000) {
    log(`woke up after ${Math.round((now - lastTick) / 1000)}s`);
    addGap(lastTick, now, 'Computer was asleep');
    // The hidden browser may be stale after sleep: re-read the session, then fetch what was missed.
    setTimeout(() => wa.get(`/api/sessions/${cfg.sessionId}`).then(syncSession).then(() => catchUp('woke up')).catch(() => {}), 15_000);
  }
  lastTick = now;
  alive.data.at = now;
  alive.save();
}, 15_000).unref();

// --- daily digest ---------------------------------------------------------------------------

function digest() {
  const today = new Date().toDateString();
  if (!cfg.digest || cfg.lastDigest === today || new Date().getHours() < 9) return;
  cfg.lastDigest = today;
  config.save();
  const day = activity.data.filter((a) => Date.now() - new Date(a.at) < 86400_000);
  const count = (k) => day.filter((a) => a.kind === k).length;
  const todayIso = new Date().toLocaleDateString('en-CA');
  const meetingsToday = activity.data.filter((a) => a.kind === 'meeting' && a.when?.startsWith(todayIso)).length;
  const parts = [[meetingsToday, 'meeting', 'today'], [count('order'), 'new order'], [count('document'), 'document'], [count('important'), 'note']]
    .filter(([n]) => n).map(([n, w, s]) => `${n} ${w}${n > 1 ? 's' : ''}${s ? ' ' + s : ''}`);
  if (!parts.length) return;
  const text = parts.join(' · ');
  broadcast('digest', { text });
  if (!clients.size) notify(`Today: ${text}`);
}
setInterval(digest, 10 * 60_000).unref();

// --- updates --------------------------------------------------------------------------------

async function checkUpdate() {
  const repo = cfg.releases || config.PKG.kairos?.releases;
  if (!repo) return;
  try {
    const r = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Kairos' }, signal: AbortSignal.timeout(15000) });
    if (!r.ok) return;
    const rel = await r.json();
    const v = String(rel.tag_name || '').replace(/^v/, '');
    if (!newerVersion(v, VERSION)) return;
    const asset = (re) => rel.assets?.find((a) => re.test(a.name))?.browser_download_url || null;
    state.update = { version: v, url: rel.html_url, win: asset(/\.exe$/i), mac: asset(/mac.*\.tar\.gz$/i), repo };
    broadcast('update', state.update);
  } catch (e) { log('update check', e.message); }
}
setInterval(checkUpdate, 12 * 3600_000).unref();

// --- diagnostics ----------------------------------------------------------------------------

function tail(file, lines) {
  try { return fs.readFileSync(file, 'utf8').split('\n').slice(-lines).join('\n'); } catch { return '(none)'; }
}
function diagnostics() {
  const s = snapshot();
  const text = [
    `Kairos ${VERSION} · ${process.platform}-${process.arch} · node ${process.version} · engine ${cfg.waEngine}`,
    `WhatsApp: ${s.wa.status} since ${new Date(s.wa.since).toISOString()} ${s.wa.error || ''}`,
    `Notion: ${s.notion ? (s.notion.ready ? 'ready' : 'set up incomplete') : 'not connected'} · last ${JSON.stringify(health.notion)}`,
    `Monitored: ${s.monitored} · paused: ${cfg.paused} · outbox: ${JSON.stringify(s.outbox)} · catch-up: ${JSON.stringify(health.catchup)}`,
    `Epsilon: ${JSON.stringify(s.epsilon)}`,
    '', '--- engine.log ---', tail(path.join(paths.logs, 'engine.log'), 150),
    '', '--- openwa.log ---', tail(path.join(paths.logs, 'openwa.log'), 80),
  ].join('\n');
  // Strip every secret Kairos knows, plus phone numbers.
  let out = text;
  for (const secret of [cfg.token, cfg.openwaKey, cfg.webhookSecret, cfg.notion?.token].filter(Boolean)) out = out.split(secret).join('[secret]');
  return out
    .replace(/\d{6,}(?=@(c\.us|lid|s\.whatsapp\.net))/g, (d) => d.slice(0, 3) + '…') // WhatsApp ids
    .replace(/\+\d[\d\s-]{8,}\d/g, '+…') // formatted numbers
    .replace(/("(phone|number|senderPhone)"\s*:\s*")\d+/g, '$1…');
}

// --- webhook receiver -----------------------------------------------------------------------

function onHook(raw, sig) {
  const want = 'sha256=' + crypto.createHmac('sha256', cfg.webhookSecret).update(raw).digest('hex');
  if (!sig || sig.length !== want.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(want))) return false;
  const { event, data } = JSON.parse(raw);
  switch (event) {
    case 'message.received':
    case 'message.sent': onMessage(data, true); break; // .sent only matters for your self-chat
    case 'session.qr': onQr(data.qr); break;
    case 'session.status':
      setWa({ status: data.status, ...(data.status === 'ready' ? { qr: null, relogin: false } : {}) });
      if (data.status === 'qr_ready' && !state.wa.qr) refreshQr();
      if (data.status === 'ready') refreshContacts(true);
      break;
    case 'session.authenticated':
      cfg.everLinked = true;
      config.save();
      setWa({ status: 'ready', qr: null, relogin: false, me: { phone: data.phone, name: data.pushName } });
      break;
    case 'session.disconnected': setWa({ status: 'disconnected', error: data.reason || null }); break;
    case 'session.restriction': setWa({ restriction: data.restriction ?? data }); break;
  }
  return true;
}

// --- HTTP API for the window ----------------------------------------------------------------

const bad = (msg, status = 400) => Object.assign(new Error(msg), { status });

const routes = {
  'GET /api/state': () => snapshot(),
  'GET /api/activity': () => activity.data, // everything kept (500), for search and CSV export
  // Answers from cache immediately; a background load (with retries) fills it in and pushes 'contacts'.
  'GET /api/contacts': (_, q) => {
    if (state.wa.status === 'ready') refreshContacts(q.get('refresh') === '1' || !contacts.list.length);
    const list = contacts.list.map((c) => ({ ...c, monitored: !!cfg.monitored[c.id], role: cfg.monitored[c.id]?.role || 'contact', mode: cfg.monitored[c.id]?.mode || 'all', lastSeen: cfg.lastSeen[c.id] || null }));
    return { list, loading: contactsJob.loading, error: list.length ? null : contactsJob.error };
  },
  'POST /api/monitor': ({ chatId, on, role, name, number, mode }) => {
    if (!chatId) throw bad('chatId missing');
    const prev = cfg.monitored[chatId];
    if (on) {
      cfg.monitored[chatId] = {
        name, number,
        role: role === 'employee' ? 'employee' : 'contact',
        mode: ['all', 'docs', 'everything'].includes(mode) ? mode : prev?.mode || 'all',
        since: prev?.since || nowS(), // never backfill history from before you switched a chat on
      };
    } else delete cfg.monitored[chatId];
    config.save();
    // The person's page appears in Contacts/Employees right away, and moves when the role changes.
    const who = cfg.monitored[chatId];
    if (who && cfg.notion?.dbs && (!prev || prev.role !== who.role)) enqueue(() => logger.person(chatId, who).then((p) => broadcast('person', { chatId, url: p.url, db: p.db })).catch((e) => log('person', e.message)));
    return { monitored: Object.keys(cfg.monitored).length };
  },
  'POST /api/pause': ({ paused }) => { setPaused(paused); return { paused: cfg.paused, pauses: pauseSummary() }; },
  'GET /api/pauses': () => pauseSummary(),
  'POST /api/pauses/sync': ({ id, chats }) => settleWindow(id, chats, true),
  'POST /api/pauses/skip': ({ id, chats }) => settleWindow(id, chats, false),
  'POST /api/outbox/retry': () => { retryOutbox(true); return outboxSummary(); },
  'POST /api/outbox/dismiss': ({ id }) => {
    outbox.data = outbox.data.filter((j) => j.id !== id);
    outbox.save();
    patchActivity(id, { pending: false, error: 'Not synced (dismissed)', note: null });
    pushHealth();
    return outboxSummary();
  },
  'POST /api/activity/refile': ({ id, kind }) => refile(id, kind),
  'POST /api/catchup': () => { catchUp('manual'); return health.catchup; },
  'POST /api/wa/connect': async () => { await ensureSession({ start: true }); setTimeout(refreshQr, 4000); return state.wa; },
  'POST /api/wa/logout': async () => {
    await wa.post(`/api/sessions/${cfg.sessionId}/logout`);
    cfg.everLinked = false;
    config.save();
    setWa({ status: 'disconnected', me: null, qr: null, relogin: false });
    return state.wa;
  },
  // Switches the WhatsApp engine. Each engine keeps its own login, so the new one needs one QR scan.
  'POST /api/wa/engine': async ({ engine }) => {
    if (!['whatsapp-web.js', 'baileys'].includes(engine)) throw bad('Unknown engine');
    if (engine === cfg.waEngine) return { waEngine: cfg.waEngine };
    if (cfg.sessionId) await wa.post(`/api/sessions/${cfg.sessionId}/stop`, null, { timeout: 15000 }).catch(() => {});
    cfg.waEngine = engine;
    cfg.everLinked = false; // a QR now is expected, not a "session ended" alarm
    config.save();
    setWa({ status: 'booting', qr: null, relogin: false, error: null });
    broadcast('state', snapshot());
    openwa.restart(cfg, log).then(() => boot({ start: true })).catch((e) => log('engine switch', e.stack));
    return { waEngine: cfg.waEngine };
  },
  // One step: validate the secret, pick where Kairos lives, build (or reuse) the four databases.
  'POST /api/notion/connect': async ({ token, pageId }) => {
    token = String(token || cfg.notion?.token || '').trim();
    if (!token) throw bad('Paste your Notion integration secret first');
    const r = await notion.connect(token);
    const parent = pageId ? r.pages.find((p) => p.id === pageId) : notion.pickParent(r.pages);
    if (!parent) throw bad('No pages are shared with this integration yet. In Notion open a page → ••• → Connections → add your integration, then try again.');
    const moved = cfg.notion?.homeId && cfg.notion.parent?.id !== parent.id;
    cfg.notion = { token, workspace: r.workspace, parent: { id: parent.id, title: parent.title, top: parent.top }, ...(await notion.ensure(token, parent)) };
    if (moved) cfg.people = {}; // new databases: person pages are recreated on demand
    config.save();
    notionStatus(true);
    retryOutbox(true); // everything that waited for Notion files itself now
    return { notion: snapshot().notion, pages: r.pages };
  },
  'POST /api/notion/disconnect': () => { cfg.notion = null; cfg.people = {}; config.save(); return {}; },
  'GET /api/notion/pages': async () => {
    if (!cfg.notion?.token) throw bad('Connect Notion first');
    return (await notion.connect(cfg.notion.token)).pages;
  },
  'POST /api/epsilon/install': () => { epsilon.install((s) => broadcast('epsilon', { ...s, enabled: cfg.epsilon.enabled })); return epsilon.status(); },
  'POST /api/epsilon/enabled': ({ enabled }) => { cfg.epsilon.enabled = !!enabled; config.save(); return { enabled: cfg.epsilon.enabled }; },
  'POST /api/digest': ({ on }) => { cfg.digest = !!on; config.save(); return { digest: cfg.digest }; },
  'POST /api/update/check': async () => { await checkUpdate(); return { update: state.update }; },
  'GET /api/diagnostics': () => ({ text: diagnostics() }),
  'POST /api/shutdown': () => { setTimeout(shutdown, 100); return {}; },
  'POST /api/os/open': ({ path: p }) => { osOpen(insideDocs(p)); return {}; },
  'POST /api/os/reveal': ({ path: p }) => { osOpen(insideDocs(p), true); return {}; },
  'POST /api/os/external': ({ url }) => {
    const ok = /^https:\/\/([a-z0-9-]+\.)?notion\.(so|com)\//.test(url || '') || /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/releases\//.test(url || '');
    if (!ok) throw bad('Only Notion and Kairos release links open from here');
    osOpen(url);
    return {};
  },
  'GET /api/os/autostart': () => autostart(),
  'POST /api/os/autostart': ({ on }) => autostart(!!on),
};

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => { size += c.length; if (size > 5e6) req.destroy(); else chunks.push(c); })
      .on('end', () => resolve(Buffer.concat(chunks).toString('utf8'))).on('error', reject);
  });
}

// The UI (desktop window and Mac browser alike) is served from here, same-origin, so no CORS.
const UI_DIR = path.join(paths.root, 'app', 'ui');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.otf': 'font/otf', '.ttf': 'font/ttf', '.svg': 'image/svg+xml', '.txt': 'text/plain' };
const HOSTS = new Set([`127.0.0.1:${PORTS.engine}`, `localhost:${PORTS.engine}`]);

function serveUi(res, pathname) {
  let file;
  try { file = path.resolve(UI_DIR, '.' + decodeURIComponent(pathname === '/' ? '/index.html' : pathname)); } catch { res.writeHead(400); return res.end(); }
  if (!file.startsWith(UI_DIR + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); return res.end(); }
  let body = fs.readFileSync(file);
  // The page learns its API token from the HTML. Cross-site pages cannot read it (no CORS),
  // and the Host check below stops DNS-rebinding tricks.
  if (file.endsWith('index.html')) body = body.toString().replace('<meta charset="utf-8" />', `<meta charset="utf-8" />
  <meta name="kairos-token" content="${cfg.token}" />`);
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache', 'X-Frame-Options': 'DENY' });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const send = (code, body) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
  if (!HOSTS.has(req.headers.host)) return send(403, { error: 'bad host' });

  try {
    if (url.pathname === '/health') return send(200, { ok: true, app: 'kairos', version: VERSION, pid: process.pid });
    if (req.method === 'GET' && !url.pathname.startsWith('/api/') && url.pathname !== '/events') return serveUi(res, url.pathname);
    if (url.pathname === '/hook' && req.method === 'POST') {
      const ok = onHook(await readBody(req), req.headers['x-openwa-signature']);
      return send(ok ? 200 : 401, { ok });
    }
    const bearer = (req.headers.authorization || '').replace('Bearer ', '') || url.searchParams.get('token');
    if (bearer !== cfg.token) return send(401, { error: 'unauthorized' });

    if (url.pathname === '/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      res.write(`event: state\ndata: ${JSON.stringify(snapshot())}\n\n`);
      clients.add(res);
      const ping = setInterval(() => res.write(': ping\n\n'), 25000);
      req.on('close', () => { clients.delete(res); clearInterval(ping); });
      return;
    }
    const handler = routes[`${req.method} ${url.pathname}`];
    if (!handler) return send(404, { error: 'not found' });
    let body = {};
    if (req.method === 'POST') {
      try { body = JSON.parse((await readBody(req)) || '{}'); } catch { throw bad('Invalid request body'); }
    }
    send(200, await handler(body, url.searchParams));
  } catch (e) {
    log('api', req.url, e.status && e.status < 500 ? e.message : e.stack);
    send(e.status && e.status < 500 ? e.status : 500, { error: e.message });
  }
});

// --- lifecycle ------------------------------------------------------------------------------

let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  log('shutting down');
  for (const s of [activity, seenStore, outbox, buffer, docIndex, alive]) s.flush();
  // Graceful stop closes the browser and flushes the WhatsApp profile; boot restarts it (everLinked).
  if (cfg.sessionId) await wa.post(`/api/sessions/${cfg.sessionId}/stop`, null, { timeout: 8000 }).catch(() => {});
  await openwa.stop();
  epsilon.stop();
  setTimeout(() => process.exit(0), 1500);
}
process.on('SIGINT', shutdown).on('SIGTERM', shutdown);
process.on('uncaughtException', (e) => log('uncaught', e.stack));
process.on('unhandledRejection', (e) => log('unhandled', e?.stack || e));

server.on('error', (e) => { log('engine already running?', e.message); process.exit(1); });
server.listen(PORTS.engine, '127.0.0.1', async () => {
  log(`engine ${VERSION} listening on ${PORTS.engine}`);
  if (alive.data.at) addGap(alive.data.at, Date.now(), 'Kairos was not running');
  // First run under the desktop shell: start at login by default, so monitoring survives reboots.
  if (process.env.KAIROS_SHELL === 'tauri' && !cfg.autostartSet) { try { autostart(true); cfg.autostartSet = true; config.save(); } catch (e) { log('autostart', e.message); } }
  // First run: set up Epsilon in the background so the user never has to.
  if (cfg.epsilon.enabled && !epsilon.installed()) epsilon.install((s) => broadcast('epsilon', { ...s, enabled: cfg.epsilon.enabled }));
  healNotion().then(() => cfg.notion && notionStatus(true), (e) => { log('notion heal', e.message); if (cfg.notion) notionStatus(false, e.message); }); // databases deleted while Kairos was off
  // An OpenWA left over from a crashed engine is adopted (the watchdog supervises it). If it is
  // still booting, wait for it rather than starting a second one that would fight for the port.
  if (!(await openwa.live()) && openwa.leftover()) await openwa.waitHealthy(90_000).catch(() => log('leftover openwa never answered'));
  if (!(await openwa.live())) openwa.start(cfg, log);
  boot();
  setTimeout(checkUpdate, 60_000);
  setTimeout(digest, 30_000);
});

// Keeps trying until OpenWA answers: a slow cold boot must not leave WhatsApp off for good.
let polling = null;
async function boot(opts) {
  try {
    setWa({ status: 'booting' });
    await openwa.waitHealthy();
    await ensureSession(opts);
  } catch (e) {
    log('boot', e.stack);
    setWa({ status: 'failed', error: e.message });
    return setTimeout(() => boot(opts), 30_000);
  }
  // Local status poll (never touches WhatsApp) in case a webhook was missed.
  polling ||= setInterval(() => wa.get(`/api/sessions/${cfg.sessionId}`).then(syncSession).catch(() => {}), 30_000).unref();
}

// Watchdog: restarts an OpenWA that died or hung (including one adopted from a crashed engine),
// and forgives the crash backoff once it has been healthy for a while.
let downChecks = 0;
let healthySince = null;
setInterval(async () => {
  if (shuttingDown) return;
  if (await openwa.live()) {
    downChecks = 0;
    healthySince ||= Date.now();
    if (Date.now() - healthySince > 10 * 60_000) openwa.resetBackoff();
    return;
  }
  healthySince = null;
  downChecks++;
  if (!openwa.running() && downChecks >= 2) { log('watchdog: openwa down, starting'); openwa.start(cfg, log); }
  else if (openwa.running() && downChecks >= 10) { log('watchdog: openwa unresponsive for 5m, restarting'); downChecks = 0; openwa.restart(cfg, log).catch((e) => log('watchdog', e.message)); }
}, 30_000).unref();

// Retries failed filings, and catches up periodically in case a webhook was dropped.
setInterval(() => retryOutbox(false), 20_000).unref();
setInterval(() => catchUp('periodic'), 30 * 60_000).unref();
