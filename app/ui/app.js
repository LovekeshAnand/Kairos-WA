// Kairos window. Vanilla JS: state arrives from the engine over SSE, views are template strings.
'use strict';

const I = {
  home: '<path d="M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1z"/>',
  wa: '<path d="M20.5 11.6a8.5 8.5 0 0 1-12.6 7.4L3.5 20.5l1.6-4.2A8.5 8.5 0 1 1 20.5 11.6z"/><path d="M9 9.5c.3 2.2 2.3 4.4 4.6 5l1.4-1.4 2 1"/>',
  chats: '<path d="M21 15a2 2 0 0 1-2 2H8l-5 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/><path d="M8 9h8M8 13h5"/>',
  notion: '<rect x="4" y="3" width="16" height="18" rx="2"/><path d="M9 8v8M9 8l6 8M15 8v8"/>',
  activity: '<path d="M3 12h4l3-8 4 16 3-8h4"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-1.8-.3 1.6 1.6 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.6 1.6 0 0 0-1-1.5 1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0 .3-1.8 1.6 1.6 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.6 1.6 0 0 0 1.5-1 1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3H9a1.6 1.6 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 1 1.5 1.6 1.6 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8V9a1.6 1.6 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1z"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  refresh: '<path d="M21 12a9 9 0 1 1-2.6-6.4L21 8"/><path d="M21 3v5h-5"/>',
  meeting: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M16 3v4M8 3v4M3 10h18"/>',
  document: '<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6M8 13h8M8 17h5"/>',
  order: '<path d="M6 2 3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4z"/><path d="M3 6h18M16 10a4 4 0 0 1-8 0"/>',
  important: '<path d="M21 15a2 2 0 0 1-2 2H8l-5 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/><path d="M12 7v4M12 14h.01"/>',
  product: '<path d="m21 8-9-5-9 5 9 5z"/><path d="M3 8v8l9 5 9-5V8M12 13v8"/>',
  noise: '<path d="M3 6h18M7 12h10M10 18h4"/>',
  external: '<path d="M14 3h7v7M10 14 21 3M21 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5"/>',
  folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  check: '<path d="m5 12 5 5L20 7"/>',
  shield: '<path d="M12 3 4 6v6c0 5 3.4 8.4 8 9 4.6-.6 8-4 8-9V6z"/><path d="m9 12 2 2 4-4"/>',
  spark: '<path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M6 18l2.5-2.5M15.5 8.5 18 6"/>',
};
const icon = (n, s = 18) => `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${I[n]}</svg>`;
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const $ = (s) => document.querySelector(s);

const S = { snap: null, view: 'home', contacts: null, contactsErr: null, filter: 'all', q: '', actFilter: 'all', pages: null, busy: {}, loginItem: null };
let conn;

// OS actions: a desktop shell (Tauri/Electron) may provide some of them; the engine does the rest.
const native = window.kairos || null;
const BROWSER = !native;
const MAC = /Mac/i.test(navigator.platform || navigator.userAgent);
const K = {
  open: (p) => (native?.open ? native.open(p) : api('POST', '/api/os/open', { path: p })),
  reveal: (p) => (native?.reveal ? native.reveal(p) : api('POST', '/api/os/reveal', { path: p })),
  external: (url) => (native?.external ? native.external(url) : api('POST', '/api/os/external', { url }).catch((e) => toast(e.message, true))),
  // null = this platform has no start-at-login switch
  loginItem: async (on) => (native?.loginItem ? native.loginItem(on) : (await (on === undefined ? api('GET', '/api/os/autostart') : api('POST', '/api/os/autostart', { on }))).on ?? null),
};
const nativeNotifies = !!native?.notifies; // the shell's tray already shows OS notifications

async function api(method, path, body) {
  const r = await fetch(conn.base + path, { method, headers: { Authorization: `Bearer ${conn.token}`, 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `Request failed (${r.status})`);
  return j;
}

function toast(msg, bad) {
  const el = document.createElement('div');
  el.className = 'toast' + (bad ? ' bad' : '');
  el.textContent = msg;
  $('#toasts').append(el);
  setTimeout(() => el.remove(), 4200);
}

async function busy(key, fn) {
  if (S.busy[key]) return;
  S.busy[key] = true; render();
  try { await fn(); } catch (e) { toast(e.message, true); } finally { S.busy[key] = false; render(); }
}

// --- helpers --------------------------------------------------------------------------------

const TONES = [['#fff1e4', '#b45614'], ['#f5efe7', '#1b1712'], ['#ffe6d1', '#9a4a12'], ['#fbf3ea', '#5d554b']];
function avatar(name, id) {
  const label = (name || '').replace(/[^\p{L}\p{N} ]/gu, '').trim();
  const ini = label ? label.split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase() : '#';
  let h = 0; for (const c of id || name || '') h = (h * 31 + c.charCodeAt(0)) >>> 0;
  const [bg, fg] = TONES[h % TONES.length];
  return `<div class="avatar" style="background:${bg};color:${fg}">${esc(ini)}</div>`;
}
function ago(iso) {
  const s = (Date.now() - new Date(iso)) / 1000;
  if (s < 0) return 'in ' + dur(-s * 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}
function dur(ms) {
  const m = Math.round(ms / 60000);
  if (m < 60) return `${Math.max(1, m)} min`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h${m % 60 ? ` ${m % 60}m` : ''}`;
  return `${Math.round(h / 24)} days`;
}
const clock = (t) => new Date(t).toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' });
const fmtPhone = (n) => (n && /^\d{8,}$/.test(n) ? '+' + n : n || '');
const waReady = () => S.snap?.wa.status === 'ready';
const notionReady = () => !!S.snap?.notion?.ready;
const WA_LABEL = { ready: 'Connected', qr_ready: 'Scan QR', initializing: 'Connecting', authenticating: 'Connecting', booting: 'Starting', starting: 'Starting', disconnected: 'Offline', failed: 'Error', created: 'Not linked', action_required: 'Action needed' };

// --- layout -----------------------------------------------------------------------------------

const NAV = [['home', 'Home'], ['whatsapp', 'WhatsApp', 'wa'], ['chats', 'Chats'], ['notion', 'Notion'], ['activity', 'Activity'], ['settings', 'Settings']];

function renderNav() {
  const s = S.snap;
  $('#nav').innerHTML = NAV.map(([id, label, ic]) => {
    let extra = '';
    if (id === 'whatsapp') extra = `<span class="dot ${waReady() ? 'on' : s?.wa.status === 'qr_ready' ? 'warn' : ''}"></span>`;
    if (id === 'chats' && s?.monitored) extra = `<span class="badge">${s.monitored}</span>`;
    if (id === 'notion') extra = `<span class="dot ${notionReady() ? 'on' : ''}"></span>`;
    return `<button class="${S.view === id ? 'active' : ''}" data-nav="${id}">${icon(ic || id)}<span>${label}</span>${extra}</button>`;
  }).join('');
  const watching = waReady() && !s?.paused && s?.monitored > 0;
  $('#sideFoot').innerHTML = `<img class="side-art" src="assets/cat-peek.png" alt="" /><div class="watch ${watching ? '' : 'off'}"><span class="pulse"></span><div><b>${watching ? 'Watching quietly' : s?.paused ? 'Paused' : 'Not watching yet'}</b><small>${watching ? `${s.monitored} chat${s.monitored > 1 ? 's' : ''} · runs in background` : 'Finish setup on Home'}</small></div></div>`;
}

function render() {
  if (!S.snap) return;
  renderNav();
  const v = VIEWS[S.view]();
  $('#view').innerHTML = `<div class="page${S.shown === S.view ? '' : ' enter'}">${banners()}${v}</div>`; // animate only on navigation
  S.shown = S.view;
  if (S.view === 'chats') renderList();
  if (S.view === 'activity') renderFeed();
  renderModal();
}

function renderModal() {
  const w = S.snap.wa;
  $('#modal').innerHTML = w.relogin && w.status === 'qr_ready' && w.qr ? `
    <div class="modal">
      ${qrBox(w.qr)}
      <h2>Your WhatsApp session ended</h2>
      <p class="sub">Scan to pick up where Kairos left off. Open WhatsApp → <b>Settings</b> → <b>Linked devices</b> → <b>Link a device</b>.</p>
      <p class="hint mt">This usually happens when the phone was offline for about two weeks. Messages from the last 7 days are caught up once you're linked again. This closes on its own once you're connected.</p>
    </div>` : '';
}

// --- banners + health -----------------------------------------------------------------------

function banner(tone, iconName, html, actions = '') {
  return `<div class="banner ${tone}">${icon(iconName, 18)}<div class="b-txt">${html}</div>${actions ? `<div class="row-actions">${actions}</div>` : ''}</div>`;
}

function banners() {
  const s = S.snap;
  const out = [];
  if (S.offline) out.push(banner('bad', 'refresh', '<b>Reconnecting to Kairos…</b> The background service is restarting or was stopped. This page updates itself when it is back.'));
  if (s.update) out.push(banner('accent', 'spark', `<b>Kairos ${esc(s.update.version)} is available.</b> You have ${esc(s.version)}.${MAC ? ' Update by running the install command again.' : ''}`,
    `<button class="btn small accent" data-ext="${esc(s.update.url)}">${MAC ? 'View release' : 'Download'}</button>`));
  if (s.wa.restriction) out.push(banner('bad', 'shield', `<b>WhatsApp reports a restriction on this account.</b> Kairos keeps reading quietly; consider pausing for a while.`, `<button class="btn small ghost" data-nav="whatsapp">Details</button>`));
  if (s.paused) {
    const open = s.pauses.find((w) => w.state === 'open');
    out.push(banner('warn', 'noise', `<b>Monitoring is paused${open ? ` since ${esc(clock(open.from))}` : ''}.</b> ${open?.count ? `${open.count} message${open.count > 1 ? 's' : ''} kept aside — you choose what to sync when you resume.` : 'Messages that arrive are kept aside; nothing is filed.'}`,
      `<button class="btn small" data-act="resume">Resume</button>`));
  }
  for (const w of s.pauses.filter((x) => x.state === 'pending')) out.push(pauseCard(w));
  const ob = s.outbox;
  if (ob?.pending) out.push(banner('bad', 'notion', `<b>${ob.pending} item${ob.pending > 1 ? 's' : ''} couldn't reach Notion.</b> ${ob.nextAt ? `Retrying ${ago(new Date(ob.nextAt).toISOString())}.` : ''} ${s.health.notion.error ? `<span class="muted">${esc(s.health.notion.error)}</span>` : ''}`,
    `<button class="btn small ghost" data-act="retry" ${S.busy.retry ? 'disabled' : ''}>Retry now</button>`));
  if (ob?.waiting && !notionReady()) out.push(banner('warn', 'notion', `<b>${ob.waiting} item${ob.waiting > 1 ? 's are' : ' is'} waiting for Notion.</b> They file themselves as soon as you connect.`, `<button class="btn small ghost" data-nav="notion">Connect Notion</button>`));
  return out.length ? `<div class="banners">${out.join('')}</div>` : '';
}

function pauseCard(w) {
  const picking = S.pickWin === w.id;
  const sel = S.pickSel || {};
  const range = `${clock(w.from)} → ${clock(w.to)}`;
  return `<div class="banner warn col">
    <div class="b-row">${icon('noise', 18)}<div class="b-txt"><b>You paused Kairos ${esc(range)}</b> (${dur(w.to - w.from)}). ${w.count} message${w.count > 1 ? 's' : ''} from ${w.chats.length} chat${w.chats.length > 1 ? 's' : ''} arrived meanwhile.</div>
      <div class="row-actions">${picking ? '' : `<button class="btn small" data-pause="sync" data-win="${w.id}">Sync all</button><button class="btn small ghost" data-pause="pick" data-win="${w.id}">Choose chats</button><button class="btn small ghost" data-pause="skip" data-win="${w.id}">Skip</button>`}</div></div>
    ${picking ? `<div class="pick">${w.chats.map((c) => `<label class="pick-row"><input type="checkbox" data-picksel="${esc(c.chatId)}" ${sel[c.chatId] ? 'checked' : ''} /><span>${esc(c.name)}</span><small class="muted">${c.count} message${c.count > 1 ? 's' : ''}</small></label>`).join('')}
      <div class="row-actions mt"><button class="btn small" data-pause="sync-sel" data-win="${w.id}">Sync selected</button><button class="btn small ghost" data-pause="skip-sel" data-win="${w.id}">Skip selected</button><button class="link" data-pause="cancel">Cancel</button></div></div>` : ''}
  </div>`;
}

function healthStrip() {
  const s = S.snap;
  const h = s.health;
  const w = s.wa;
  const cell = (tone, label, value, sub) => `<div class="h-cell"><span class="h-dot ${tone}"></span><div><small>${label}</small><b>${value}</b><span class="muted">${sub}</span></div></div>`;
  const waTone = w.status === 'ready' ? 'good' : ['qr_ready', 'booting', 'starting', 'initializing', 'authenticating'].includes(w.status) ? 'warn' : 'bad';
  const n = s.notion;
  const nTone = !n ? '' : h.notion.ok === false ? 'bad' : s.outbox.pending ? 'warn' : 'good';
  const c = h.catchup;
  return `<div class="card health">
    ${cell(S.offline ? 'bad' : 'good', 'Kairos engine', S.offline ? 'Reconnecting' : 'Running', `v${esc(s.version)} · up ${dur(Date.now() - h.startedAt)}`)}
    ${cell(waTone, 'WhatsApp', esc(WA_LABEL[w.status] || w.status), `${w.status === 'ready' ? 'connected' : 'since'} ${ago(new Date(w.since).toISOString())}`)}
    ${cell(nTone, 'Notion', !n ? 'Not connected' : h.notion.ok === false ? 'Unreachable' : 'Syncing', !n ? 'connect to file items' : s.outbox.pending ? `${s.outbox.pending} waiting to retry` : h.notion.at ? `last write ${ago(new Date(h.notion.at).toISOString())}` : 'ready')}
    ${cell(c.running ? 'warn' : 'good', 'Catch-up', c.running ? `Checking ${c.done}/${c.total}` : 'Up to date', c.running ? `${c.found} missed so far` : h.lastMessageAt ? `last message ${ago(new Date(h.lastMessageAt).toISOString())}` : c.at ? `checked ${ago(new Date(c.at).toISOString())}` : 'nothing missed')}
  </div>`;
}

const qrBox = (qr) => `<div class="qr-wrap"><img class="qr" src="${esc(qr)}" alt="WhatsApp QR code" /><img class="cat" src="assets/logo.png" alt="" /></div>`;

// --- views ------------------------------------------------------------------------------------

const VIEWS = {
  home() {
    const s = S.snap;
    const hr = new Date().getHours();
    const hello = hr < 5 ? 'Still up?' : hr < 12 ? 'Good morning' : hr < 17 ? 'Good afternoon' : 'Good evening';
    const steps = [
      [waReady(), 'Connect WhatsApp', 'Link Kairos as a device — just like WhatsApp Web.', 'whatsapp'],
      [notionReady(), 'Connect Notion', 'Kairos creates Products, Contacts, Employees and Orders.', 'notion'],
      [s.monitored > 0, 'Pick chats to watch', 'Only the DMs you choose are ever read.', 'chats'],
      [s.epsilon.phase === 'ready', 'Epsilon on-device model', s.epsilon.phase === 'installing' ? `Setting up… ${Math.round(s.epsilon.progress * 100)}%` : 'Sorts signal from noise, offline.', 'settings'],
    ];
    const done = steps.every((x) => x[0]);
    const st = s.stats;
    const recent = s.activity.filter((a) => a.kind !== 'gap').slice(0, 5);
    return `
      <section class="hero">
        <div class="hero-copy">
          <span class="pill">${icon('spark', 14)} ${done ? 'All set' : 'Setup'}</span>
          <h1 style="margin-top:14px">${hello}.</h1>
          <p>${done ? `Kairos is quietly watching ${s.monitored} chat${s.monitored > 1 ? 's' : ''}. Meetings, documents and orders land in Notion — the small talk never does.` : 'A few quick steps and Kairos will start turning your WhatsApp DMs into a tidy Notion workspace — on this PC, with nothing sent anywhere else.'}</p>
          <div class="row-actions">${done ? `<button class="btn accent" data-nav="activity">See what's new</button><button class="btn ghost" data-nav="chats" style="background:transparent;color:#fff;border-color:rgba(255,255,255,.2)">Manage chats</button>` : `<button class="btn accent" data-nav="${steps.find((x) => !x[0])[3]}">Continue setup</button>`}</div>
        </div>
        <div class="hero-art"></div>
      </section>
      ${healthStrip()}
      ${done ? '' : `<div class="card"><h2>Get started</h2><p class="sub" style="margin-bottom:16px">Four steps, about two minutes.</p><div class="steps">${steps.map(([ok, t, d, go], i) => `
        <div class="step ${ok ? 'done' : ''}"><span class="num">${ok ? icon('check', 16) : i + 1}</span><div class="txt"><b>${t}</b><small>${d}</small></div>${ok ? '<span class="pill good"><i></i>Done</span>' : `<button class="btn small ghost" data-nav="${go}">Open</button>`}</div>`).join('')}</div></div>`}
      <div class="grid g5 mt">
        ${[['Logged', st.logged, 'spark'], ['Meetings', st.meetings, 'meeting'], ['Documents', st.documents, 'document'], ['Orders', st.orders, 'order']].map(([l, n, ic]) => `<div class="card stat"><div class="l">${icon(ic, 16)}${l}</div><div class="n">${n}</div></div>`).join('')}
        <div class="card stat hl"><div class="l">${icon('noise', 16)}Noise filtered</div><div class="n">${st.noise}</div></div>
      </div>
      <div class="sect-title"><h2>Recent</h2>${recent.length ? '<button class="link" data-nav="activity">View all →</button>' : ''}</div>
      ${recent.length ? `<div class="feed">${recent.map(evRow).join('')}</div>` : emptyState('Nothing logged yet', 'When a watched contact asks for a meeting, sends a document or places an order, it shows up here.')}`;
  },

  whatsapp() {
    const w = S.snap.wa;
    let body;
    if (w.status === 'ready') {
      body = `<div class="card"><div class="me">${avatar(w.me?.name || 'Me', w.me?.phone)}<div style="flex:1"><h2>${esc(w.me?.name || 'Your WhatsApp')}</h2><span class="muted">${esc(fmtPhone(w.me?.phone))}</span></div><span class="pill good"><i></i>Connected</span><button class="btn small danger" data-act="logout" ${S.busy.logout ? 'disabled' : ''}>Disconnect</button></div></div>`;
    } else if (w.status === 'qr_ready' && w.qr) {
      body = `<div class="card"><div class="connect">${qrBox(w.qr)}<div><h2>Scan with your phone</h2><ol class="howto"><li>Open <b>WhatsApp</b> on your phone</li><li>Tap <b>Settings</b> (iPhone) or <b>⋮</b> (Android) → <b>Linked devices</b></li><li>Tap <b>Link a device</b> and point your phone at this code</li></ol><p class="hint mt">The code refreshes by itself. Kairos stays linked across restarts — you only do this once.</p></div></div></div>`;
    } else if (['initializing', 'authenticating', 'booting', 'starting'].includes(w.status) || S.busy.connect) {
      body = `<div class="card empty"><div class="spinner" style="margin:0 auto 16px"></div><b>Starting a private WhatsApp Web session…</b>This runs in a hidden browser on this PC. Takes a few seconds.</div>`;
    } else {
      body = `<div class="card empty"><img src="assets/logo.png" alt="" /><b>Link your WhatsApp</b>Kairos connects as a linked device, the same way WhatsApp Web does.${w.error ? `<p class="err">${esc(w.error)}</p>` : ''}<div class="mt"><button class="btn accent" data-act="connect">Connect WhatsApp</button></div></div>`;
    }
    const r = w.restriction;
    return `
      <div class="page-head"><div><h1>WhatsApp</h1><p class="sub">Your account, linked privately to this computer.</p></div><span class="pill ${waReady() ? 'good' : 'warn'}"><i></i>${WA_LABEL[w.status] || w.status}</span></div>
      ${r ? `<div class="card" style="border-color:#f9cfc8;background:var(--bad-soft);margin-bottom:16px"><b>WhatsApp reports a restriction on this account</b> <span class="muted">(${esc(r.kind || r.code || 'restricted')})</span><p class="sub">Kairos will keep reading quietly but you may want to pause monitoring for a while.</p></div>` : ''}
      ${body}
      <div class="card mt"><h2>${icon('shield', 18)} How Kairos keeps your number safe</h2><p class="sub">WhatsApp bans accounts that behave like bots. Kairos behaves like a phone sitting on your desk.</p>
        <div class="shield mt">${[
          ['Read-only, enforced in code', 'Kairos can never send, react, type or mark messages as read.'],
          ['Runs on your own PC', 'A home connection looks like you — no data-centre IPs.'],
          ['One linked device, remembered', 'The session is kept, so no repeated QR logins.'],
          ['Gentle reconnects', 'Backs off for longer each time instead of hammering.'],
          ['Contacts read sparingly', 'The address book is fetched at most every 10 minutes. No profile-photo scraping.'],
          ['No status crawling', 'Stories and groups are ignored entirely.'],
        ].map(([t, d]) => `<div>${icon('check', 16)}<span><b style="color:var(--ink)">${t}.</b> ${d}</span></div>`).join('')}</div>
      </div>`;
  },

  chats() {
    if (!waReady()) return `<div class="page-head"><div><h1>Chats</h1><p class="sub">Choose which DMs Kairos may read.</p></div></div>${emptyState('Connect WhatsApp first', 'Your chats appear here once Kairos is linked.', '<button class="btn accent" data-nav="whatsapp">Connect WhatsApp</button>')}`;
    return `
      <div class="page-head"><div><h1>Chats</h1><p class="sub">Switch on the DMs you want logged. Everything else is never read.</p></div><span class="count-chip">${S.snap.monitored} watching</span></div>
      <div class="toolbar">
        <div class="search">${icon('search', 16)}<input class="input" id="q" placeholder="Search by name or number" value="${esc(S.q)}" /></div>
        <div class="tabs">${[['all', 'All'], ['on', 'Watching'], ['saved', 'Saved contacts']].map(([k, l]) => `<button class="${S.filter === k ? 'active' : ''}" data-filter="${k}">${l}</button>`).join('')}</div>
        <button class="btn ghost small" data-act="refresh" title="Refresh (at most every 10 minutes)" ${S.busy.refresh ? 'disabled' : ''}>${icon('refresh', 15)}</button>
      </div>
      <div class="card" style="padding:8px"><div class="list" id="list"></div></div>`;
  },

  notion() {
    const n = S.snap.notion;
    if (n?.ready) {
      const meta = { contacts: ['🐈‍⬛', 'Contacts', 'Everyone you watch, with a timeline of meetings, files and notes'], employees: ['🧑‍💼', 'Employees', 'Team members you tag as Employee in Chats'], products: ['📦', 'Products', 'Catalog items shared with you'], orders: ['🧾', 'Orders', 'Orders detected in your DMs, linked to the contact'] };
      const where = n.parent && n.parent.toLowerCase() !== 'kairos' ? `${esc(n.parent)} › Kairos` : 'Kairos';
      return `
        <div class="page-head"><div><h1>Notion</h1><p class="sub">Connected to <b>${esc(n.workspace)}</b>. Everything lives in <b>${where}</b> — you own it all.</p></div><span class="pill good"><i></i>Synced</span></div>
        <div class="card db-card" style="margin-bottom:16px"><div class="em">🐾</div><div style="flex:1"><b>Your Kairos page</b><small class="muted">Kairos checks these databases every time it starts and quietly rebuilds any that go missing.</small></div><button class="btn small" data-ext="${esc(n.homeUrl)}">${icon('external', 14)} Open in Notion</button></div>
        <div class="grid g2">${Object.entries(meta).map(([k, [em, t, d]]) => `<div class="card db-card"><div class="em">${em}</div><div style="flex:1"><b>${t}</b><small class="muted">${d}</small></div><button class="btn small ghost" data-ext="${esc(n.dbs[k])}">${icon('external', 14)} Open</button></div>`).join('')}</div>
        <div class="card mt">
          <div class="set" style="padding-top:0"><div class="t"><b>Move Kairos</b><small>Set Kairos up inside a different shared page. Your current databases stay where they are.</small></div><button class="btn small ghost" data-act="notion-pages" ${S.busy.npages ? 'disabled' : ''}>Choose page</button></div>
          ${S.pages ? `<div class="pages" style="margin-bottom:12px">${S.pages.map((p) => `<button class="page-opt" data-move="${esc(p.id)}"><span>${esc(p.icon || '📄')}</span>${esc(p.title)}</button>`).join('')}</div>` : ''}
          <div class="set" style="padding-bottom:0"><div class="t"><b>Disconnect Notion</b><small>Kairos stops writing. Your databases and pages stay in Notion untouched.</small></div><button class="btn small danger" data-act="notion-off">Disconnect</button></div>
        </div>`;
    }
    return `
      <div class="page-head"><div><h1>Notion</h1><p class="sub">Paste one secret and Kairos builds everything for you.</p></div><span class="pill"><i></i>Not connected</span></div>
      <div class="grid g2">
        <div class="card">
          <h2>Connect in three steps</h2>
          <ol class="howto">
            <li>Open <button class="link" data-ext="https://www.notion.so/profile/integrations">Notion integrations ${icon('external', 12)}</button> → <b>New integration</b>. Name it <b>Kairos</b>, type <b>Internal</b>, pick your workspace, save.</li>
            <li>On the integration's page, copy the <b>Internal Integration Secret</b> (starts with <code>ntn_</code>).</li>
            <li>In Notion, open any page (or make one called <b>Kairos</b>) → <b>•••</b> → <b>Connections</b> → add <b>Kairos</b>.</li>
          </ol>
          <div class="field"><label for="ntoken">Integration secret</label><input class="input" id="ntoken" type="password" placeholder="ntn_…" autocomplete="off" /><span class="hint">Stored only on this PC. Kairos only sees pages you connect it to.</span></div>
          <button class="btn accent mt" data-act="notion-connect" ${S.busy.nconnect ? 'disabled' : ''}>${S.busy.nconnect ? 'Building your workspace…' : 'Connect & set up'}</button>
        </div>
        <div class="card">
          <h2>What Kairos creates</h2>
          <p class="sub">A <b>Kairos</b> page with four linked databases — or, if you shared a page called Kairos, right inside it.</p>
          <div class="steps mt">${[['🐈‍⬛', 'Contacts', 'People you watch + their timeline'], ['🧑‍💼', 'Employees', 'Your team'], ['📦', 'Products', 'Catalog items shared in chats'], ['🧾', 'Orders', 'Linked to the contact who ordered']].map(([e, t, d]) => `<div class="step"><span class="num" style="background:var(--surface)">${e}</span><div class="txt"><b>${t}</b><small>${d}</small></div></div>`).join('')}</div>
        </div>
      </div>`;
  },

  activity() {
    return `
      <div class="page-head"><div><h1>Activity</h1><p class="sub">Everything Kairos filed for you, and when it was offline. Noise is counted, never stored.</p></div>
        <div class="tabs">${[['all', 'All'], ['meeting', 'Meetings'], ['document', 'Documents'], ['order', 'Orders'], ['important', 'Notes'], ['gap', 'Offline']].map(([k, l]) => `<button class="${S.actFilter === k ? 'active' : ''}" data-actf="${k}">${l}</button>`).join('')}</div></div>
      <div class="toolbar">
        <div class="search">${icon('search', 16)}<input class="input" id="aq" placeholder="Search by person or text" value="${esc(S.aq || '')}" /></div>
        <button class="btn ghost small" data-act="catchup" title="Check watched chats for missed messages" ${S.snap.health.catchup.running ? 'disabled' : ''}>${icon('refresh', 15)} Check for missed</button>
        <button class="btn ghost small" data-act="export">${icon('document', 15)} Export CSV</button>
      </div>
      <div id="feed"></div>`;
  },

  settings() {
    const s = S.snap;
    const e = s.epsilon;
    return `
      <div class="page-head"><div><h1>Settings</h1><p class="sub">Kairos runs on its own after setup. These are here if you need them.</p></div></div>
      <div class="card">
        <h2>Epsilon · on-device model</h2>
        <p class="sub">A small multilingual model (${esc(e.model)}) that sorts messages into meetings, orders, notes and noise — English, Hindi and Hinglish. Runs offline, loads only when a message arrives, unloads after 5 idle minutes.</p>
        ${e.phase === 'installing' ? `<div class="progress"><i style="width:${Math.round(e.progress * 100)}%"></i></div><p class="hint">Downloading Epsilon… ${Math.round(e.progress * 100)}%</p>` : ''}
        ${e.phase === 'error' ? `<p class="err mt">${esc(e.error)}</p>` : ''}
        <div class="set"><div class="t"><b>${e.phase === 'ready' ? 'Installed' : 'Not installed'}</b><small>${e.phase === 'ready' ? (e.loaded ? 'Loaded right now' : 'Sleeping until the next message') : 'Without it Kairos uses keyword rules only.'}</small></div>
          ${e.phase === 'ready' ? `<label class="switch"><input type="checkbox" data-toggle="epsilon" ${e.enabled ? 'checked' : ''} /><span></span></label>` : `<button class="btn small" data-act="epsilon" ${e.phase === 'installing' ? 'disabled' : ''}>Install</button>`}</div>
      </div>
      <div class="card mt">
        <h2>WhatsApp engine</h2>
        <p class="sub">How Kairos connects. Each engine keeps its own login, so switching needs one QR scan (switching back usually doesn't).</p>
        ${[['whatsapp-web.js', 'Standard', 'Runs WhatsApp Web in a hidden browser. Can check chats for messages missed while Kairos was off (up to 7 days back).'],
          ['baileys', 'Lightweight (beta)', 'Talks to WhatsApp directly, no hidden browser — uses far less memory. WhatsApp itself replays missed messages when it reconnects.']].map(([k, t, d]) => `
          <div class="set"><div class="t"><b>${t}${s.waEngine === k ? ' <span class="pill good" style="margin-left:6px"><i></i>In use</span>' : ''}</b><small>${d}</small></div>
          ${s.waEngine === k ? '' : S.engineConfirm === k ? `<button class="btn small accent" data-act="engine" data-engine="${k}" ${S.busy.engine ? 'disabled' : ''}>Confirm — I'll scan a QR</button>` : `<button class="btn small ghost" data-act="engine-ask" data-engine="${k}">Switch</button>`}</div>`).join('')}
      </div>
      <div class="card mt">
        ${S.loginItem === null ? '' : `<div class="set"><div class="t"><b>Start ${BROWSER || MAC ? 'at login' : 'with Windows'}</b><small>Kairos starts quietly in the background and keeps watching after a restart.</small></div><label class="switch"><input type="checkbox" data-toggle="login" ${S.loginItem ? 'checked' : ''} /><span></span></label></div>`}
        <div class="set"><div class="t"><b>Pause monitoring</b><small>Stop logging without unlinking WhatsApp.</small></div><label class="switch"><input type="checkbox" data-toggle="pause" ${s.paused ? 'checked' : ''} /><span></span></label></div>
        <div class="set"><div class="t"><b>Daily summary</b><small>A 9 AM notification: today's meetings, new orders, documents and notes. Skipped on quiet days.</small></div><label class="switch"><input type="checkbox" data-toggle="digest" ${s.digest ? 'checked' : ''} /><span></span></label></div>
        <div class="set"><div class="t"><b>Documents folder</b><small>${esc(s.docsDir)} — sorted by contact and month.</small></div><button class="btn small ghost" data-act="docs">${icon('folder', 14)} Open</button></div>
      </div>
      <div class="card mt">
        <div class="set" style="padding-top:0"><div class="t"><b>Kairos ${esc(s.version)}</b><small>${s.update ? `Version ${esc(s.update.version)} is available.` : 'Checks for updates twice a day.'}</small></div><button class="btn small ghost" data-act="update" ${S.busy.update ? 'disabled' : ''}>Check now</button></div>
        <div class="set" style="padding-bottom:0"><div class="t"><b>Diagnostics</b><small>Copies recent logs with secrets and phone numbers removed — paste them when asking for help.</small></div><button class="btn small ghost" data-act="diag" ${S.busy.diag ? 'disabled' : ''}>Copy diagnostics</button></div>
      </div>
      ${BROWSER ? `<div class="card mt"><div class="set" style="padding:0"><div class="t"><b>Stop Kairos</b><small>Closing this tab keeps Kairos watching. Stop it here; open the Kairos app to start it again.</small></div><button class="btn small danger" data-act="stop">Stop monitoring</button></div></div>` : `<p class="hint mt">Closing the window keeps Kairos running in the ${MAC ? 'menu bar' : 'tray'}. To stop it completely, ${MAC ? 'click' : 'right-click'} the Kairos ${MAC ? 'menu bar icon' : 'tray cat'} → <b>Quit and stop monitoring</b>.</p>`}`;
  },
};

function emptyState(title, text, action = '') {
  return `<div class="card empty"><img src="assets/logo.png" alt="" /><b>${esc(title)}</b>${esc(text)}${action ? `<div class="mt">${action}</div>` : ''}</div>`;
}

const KIND = { meeting: 'Meeting request', document: 'Document', order: 'Order', important: 'Note', product: 'Product', gap: 'Offline' };
const REFILE = [['meeting', 'Meeting'], ['order', 'Order'], ['important', 'Note'], ['noise', 'Not important (remove)']];

function gapRow(a) {
  const caught = a.caught === null || a.caught === undefined ? '<span class="pill">checking for missed messages…</span>'
    : typeof a.caught === 'number' ? `<span class="pill ${a.caught ? 'warn' : 'good'}">${a.caught ? `caught up ${a.caught} missed message${a.caught > 1 ? 's' : ''}` : 'nothing was missed'}</span>`
    : `<span class="pill good">${esc(a.caught)}</span>`;
  return `<div class="ev gap"><div class="ico">${icon('noise', 18)}</div><div class="body">
    <b>${esc(a.title)}</b> <span class="muted">for ${dur(new Date(a.to) - new Date(a.from))}</span>
    <p>${esc(clock(a.from))} → ${esc(clock(a.to))}</p>
    <div class="meta"><time>${ago(a.at)}</time>${caught}</div></div></div>`;
}

function evRow(a) {
  if (a.kind === 'gap') return gapRow(a);
  const when = a.when ? ` · <b style="color:var(--ink)">${esc(new Date(a.when).toLocaleString(undefined, a.when.length > 10 ? { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' } : { weekday: 'short', day: 'numeric', month: 'short' }))}</b>` : '';
  const canRefile = !a.pending && ['meeting', 'order', 'important', 'product'].includes(a.kind);
  return `<div class="ev ${esc(a.kind)}"><div class="ico">${icon(a.kind in I ? a.kind : 'important', 18)}</div><div class="body">
    <b>${esc(KIND[a.kind] || a.kind)}</b> <span class="muted">from ${esc(a.name)}</span>
    <p>${esc(a.title)}${when}</p>
    <div class="meta"><time>${ago(a.at)}</time>
      ${a.notionUrl ? `<button class="link" data-ext="${esc(a.notionUrl)}">${icon('external', 12)} Notion</button>` : ''}
      ${a.localPath ? `<button class="link" data-reveal="${esc(a.localPath)}">${icon('folder', 12)} Show file</button>` : ''}
      ${a.pending && !a.error && !a.note ? '<span class="pill">syncing…</span>' : ''}
      ${a.note ? `<span class="pill warn">${esc(a.note)}</span>` : ''}
      ${a.error ? `<span class="err">${esc(a.error)}${a.pending && a.retryAt ? ` · retrying ${ago(new Date(a.retryAt).toISOString())}` : ''}</span>` : ''}
      ${a.pending && a.error ? `<button class="link" data-act="retry">Retry now</button><button class="link" data-dismiss="${esc(a.id)}">Dismiss</button>` : ''}
      ${canRefile ? `<select class="role refile" data-refile="${esc(a.id)}" title="Filed wrong? Move it"><option value="">Re-file as…</option>${REFILE.filter(([k]) => k !== a.kind).map(([k, l]) => `<option value="${k}">${l}</option>`).join('')}</select>` : ''}
    </div></div></div>`;
}

function activityRows(all) {
  const q = (S.aq || '').toLowerCase();
  return (all || S.snap.activity).filter((a) => (S.actFilter === 'all' || a.kind === S.actFilter)
    && (!q || [a.name, a.title, a.text].some((x) => (x || '').toLowerCase().includes(q))));
}

function renderFeed() {
  const el = $('#feed');
  if (!el) return;
  const list = activityRows();
  el.innerHTML = list.length ? `<div class="feed">${list.map(evRow).join('')}</div>` : emptyState(S.aq ? 'Nothing matches' : 'Quiet so far', S.aq ? 'Try another name or word.' : 'Kairos only logs what matters. Small talk and memes are filtered out.');
}

async function exportCsv() {
  const cell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const rows = activityRows(await api('GET', '/api/activity')).filter((a) => a.kind !== 'gap');
  const csv = [['When', 'Type', 'From', 'Title', 'Meeting date', 'Notion', 'File', 'Message'], ...rows.map((a) => [a.at, KIND[a.kind] || a.kind, a.name, a.title, a.when || '', a.notionUrl || '', a.localPath || '', a.text || ''])]
    .map((r) => r.map(cell).join(',')).join('\r\n');
  const link = document.createElement('a');
  link.href = URL.createObjectURL(new Blob(['﻿' + csv], { type: 'text/csv' }));
  link.download = `kairos-activity-${new Date().toISOString().slice(0, 10)}.csv`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 5000);
}

function renderList() {
  const el = $('#list');
  if (!el) return;
  if (!S.contacts?.length && S.contactsErr && !S.contactsLoading) { el.innerHTML = `<div class="empty"><b>WhatsApp is still getting ready</b>Kairos keeps retrying on its own. Right after linking, WhatsApp syncs your history for a few minutes.<p class="hint">${esc(S.contactsErr)}</p><button class="btn small ghost mt" data-act="refresh">Try now</button></div>`; return; }
  if (!S.contacts?.length) { el.innerHTML = `<div class="empty"><div class="spinner" style="margin:0 auto 12px"></div><b>Syncing your chats from WhatsApp…</b>The first sync after linking can take a few minutes. This list fills in by itself.</div>`; return; }
  const q = S.q.toLowerCase();
  const rows = S.contacts.filter((c) =>
    (S.filter === 'all' || (S.filter === 'on' && c.monitored) || (S.filter === 'saved' && c.saved)) &&
    (!q || (c.name || '').toLowerCase().includes(q) || (c.number || '').includes(q.replace(/\D/g, '') || '\u0000')));
  el.innerHTML = rows.length ? rows.slice(0, 400).map((c) => `
    <div class="row ${c.monitored ? 'on' : ''}">
      ${avatar(c.name, c.id)}
      <div class="who"><b>${esc(c.name || fmtPhone(c.number) || 'WhatsApp contact')}${c.self ? ' <span class="pill warn" style="padding:1px 8px;margin-left:6px">You</span>' : ''}</b><small>${esc([c.number && fmtPhone(c.number), c.self ? 'Your notes-to-self chat — your own messages count here' : c.last, c.monitored && c.lastSeen ? `last message ${ago(new Date(c.lastSeen * 1000).toISOString())}` : ''].filter(Boolean).join(' · '))}</small></div>
      ${c.monitored ? `<select class="role" data-mode="${esc(c.id)}" title="What to log from this chat">${[['all', 'What matters'], ['docs', 'Documents only'], ['everything', 'Everything']].map(([k, l]) => `<option value="${k}" ${c.mode === k ? 'selected' : ''}>${l}</option>`).join('')}</select>
        <select class="role" data-role="${esc(c.id)}"><option value="contact" ${c.role !== 'employee' ? 'selected' : ''}>Contact</option><option value="employee" ${c.role === 'employee' ? 'selected' : ''}>Employee</option></select>` : ''}
      <label class="switch" title="Watch this chat"><input type="checkbox" data-mon="${esc(c.id)}" ${c.monitored ? 'checked' : ''} /><span></span></label>
    </div>`).join('') : `<div class="empty"><b>No chats match</b>Try a different search.</div>`;
}

async function loadContacts(refresh) {
  try {
    const r = await api('GET', '/api/contacts' + (refresh ? '?refresh=1' : ''));
    S.contacts = r.list; S.contactsLoading = r.loading; S.contactsErr = r.error;
  } catch (e) { S.contactsErr = e.message; S.contactsLoading = false; }
  if (S.view === 'chats') renderList();
}

// --- events -----------------------------------------------------------------------------------

document.addEventListener('click', async (e) => {
  const t = e.target.closest('[data-nav],[data-act],[data-filter],[data-actf],[data-move],[data-ext],[data-reveal],[data-pause],[data-dismiss]');
  if (!t) return;
  const d = t.dataset;
  if (d.nav) { S.view = d.nav; if (d.nav === 'chats' && !S.contacts && waReady()) loadContacts(); if (d.nav === 'settings') S.loginItem = await K.loginItem(); render(); $('#view').scrollTop = 0; return; }
  if (d.filter) { S.filter = d.filter; render(); return; }
  if (d.actf) { S.actFilter = d.actf; render(); return; }
  if (d.dismiss) return busy('dismiss', async () => { S.snap.outbox = await api('POST', '/api/outbox/dismiss', { id: d.dismiss }); });
  if (d.pause) {
    const sel = Object.keys(S.pickSel || {}).filter((k) => S.pickSel[k]);
    if (d.pause === 'pick') { S.pickWin = d.win; S.pickSel = {}; return render(); }
    if (d.pause === 'cancel') { S.pickWin = null; return render(); }
    if (d.pause.endsWith('-sel') && !sel.length) return toast('Tick at least one chat', true);
    const sync = d.pause.startsWith('sync');
    return busy('pause', async () => {
      const r = await api('POST', `/api/pauses/${sync ? 'sync' : 'skip'}`, { id: d.win, chats: d.pause.endsWith('-sel') ? sel : undefined });
      S.pickWin = null;
      toast(sync ? `Filing ${r.synced} message${r.synced === 1 ? '' : 's'} from the paused period` : `Skipped ${r.skipped} message${r.skipped === 1 ? '' : 's'}`);
    });
  }
  if (d.move) return busy('nmove', async () => { S.snap.notion = (await api('POST', '/api/notion/connect', { pageId: d.move })).notion; S.pages = null; toast('Kairos moved — new databases are ready'); });
  if (d.ext) { K.external(d.ext); return; }
  if (d.reveal) { K.reveal(d.reveal); return; }
  switch (d.act) {
    case 'connect': return busy('connect', () => api('POST', '/api/wa/connect'));
    case 'logout': return busy('logout', async () => { await api('POST', '/api/wa/logout'); S.contacts = null; toast('WhatsApp disconnected'); });
    case 'refresh': return busy('refresh', () => loadContacts(true));
    case 'notion-connect': {
      const token = $('#ntoken').value.trim();
      if (!token) return toast('Paste your integration secret first', true);
      return busy('nconnect', async () => { S.snap.notion = (await api('POST', '/api/notion/connect', { token })).notion; S.pages = null; toast('Your Kairos workspace is ready in Notion'); });
    }
    case 'notion-pages': return busy('npages', async () => { S.pages = await api('GET', '/api/notion/pages'); });
    case 'notion-off': return busy('noff', async () => { await api('POST', '/api/notion/disconnect'); S.snap.notion = null; S.pages = null; });
    case 'epsilon': return busy('eps', () => api('POST', '/api/epsilon/install'));
    case 'docs': return K.open(S.snap.docsDir);
    case 'stop': return busy('stop', async () => { await api('POST', '/api/shutdown'); toast('Kairos stopped. Open the Kairos app to start it again.'); });
    case 'resume': return busy('resume', async () => { const r = await api('POST', '/api/pause', { paused: false }); Object.assign(S.snap, r); });
    case 'retry': return busy('retry', async () => { S.snap.outbox = await api('POST', '/api/outbox/retry'); toast('Retrying now'); });
    case 'catchup': return busy('catchup', async () => { await api('POST', '/api/catchup'); toast(S.snap.waEngine === 'baileys' ? 'WhatsApp replays missed messages itself on this engine' : 'Checking watched chats for missed messages…'); });
    case 'export': return busy('export', exportCsv);
    case 'engine-ask': S.engineConfirm = d.engine; return render();
    case 'engine': return busy('engine', async () => {
      await api('POST', '/api/wa/engine', { engine: d.engine });
      S.snap.waEngine = d.engine; S.engineConfirm = null; S.view = 'whatsapp';
      toast('Switching engine — a QR code appears here in a moment');
    });
    case 'update': return busy('update', async () => { const r = await api('POST', '/api/update/check'); S.snap.update = r.update; if (!r.update) toast("You're on the latest version"); });
    case 'diag': return busy('diag', async () => {
      const { text } = await api('GET', '/api/diagnostics');
      try { await navigator.clipboard.writeText(text); toast('Diagnostics copied — paste them in your message'); } catch {
        const ta = Object.assign(document.createElement('textarea'), { value: text }); document.body.append(ta); ta.select(); document.execCommand('copy'); ta.remove(); toast('Diagnostics copied');
      }
    });
  }
});

document.addEventListener('change', async (e) => {
  const t = e.target;
  try {
    if (t.dataset.mon) {
      const c = S.contacts.find((x) => x.id === t.dataset.mon);
      c.monitored = t.checked;
      const r = await api('POST', '/api/monitor', { chatId: c.id, on: c.monitored, role: c.role, mode: c.mode, name: c.name, number: c.number });
      S.snap.monitored = r.monitored;
      renderNav(); renderList();
      const chip = document.querySelector('.count-chip'); if (chip) chip.textContent = `${r.monitored} watching`;
    }
    if (t.dataset.role) {
      const c = S.contacts.find((x) => x.id === t.dataset.role);
      c.role = t.value;
      await api('POST', '/api/monitor', { chatId: c.id, on: true, role: c.role, mode: c.mode, name: c.name, number: c.number });
      toast(`${c.name || fmtPhone(c.number)} will be filed under ${c.role === 'employee' ? 'Employees' : 'Contacts'}`);
    }
    if (t.dataset.mode) {
      const c = S.contacts.find((x) => x.id === t.dataset.mode);
      c.mode = t.value;
      await api('POST', '/api/monitor', { chatId: c.id, on: true, role: c.role, mode: c.mode, name: c.name, number: c.number });
      toast({ all: 'Logging what matters', docs: 'Logging documents only', everything: 'Logging every real message as a note' }[c.mode] + ` from ${c.name || fmtPhone(c.number)}`);
    }
    if (t.dataset.refile && t.value) {
      const kind = t.value;
      t.disabled = true;
      await api('POST', '/api/activity/refile', { id: t.dataset.refile, kind });
      toast(kind === 'noise' ? 'Removed from Notion and counted as noise' : `Re-filed as ${KIND[kind]}`);
    }
    if (t.dataset.picksel) { S.pickSel = { ...S.pickSel, [t.dataset.picksel]: t.checked }; }
    if (t.dataset.toggle === 'digest') S.snap.digest = (await api('POST', '/api/digest', { on: t.checked })).digest;

    if (t.dataset.toggle === 'pause') { S.snap.paused = (await api('POST', '/api/pause', { paused: t.checked })).paused; render(); }
    if (t.dataset.toggle === 'epsilon') S.snap.epsilon.enabled = (await api('POST', '/api/epsilon/enabled', { enabled: t.checked })).enabled;
    if (t.dataset.toggle === 'login') S.loginItem = await K.loginItem(t.checked);
  } catch (err) { toast(err.message, true); }
});

document.addEventListener('input', (e) => {
  if (e.target.id === 'q') { S.q = e.target.value; renderList(); }
  if (e.target.id === 'aq') { S.aq = e.target.value; renderFeed(); }
});

function stream() {
  const es = new EventSource(`${conn.base}/events?token=${conn.token}`);
  const on = (type, fn) => es.addEventListener(type, (m) => fn(JSON.parse(m.data)));
  // Re-render, except while the user is typing in a search box (it would lose focus).
  const soft = () => { if (['q', 'aq'].includes(document.activeElement?.id)) { renderNav(); renderModal(); if (S.view === 'activity') renderFeed(); } else render(); };
  on('state', (s) => { S.snap = s; S.offline = false; render(); });
  on('wa', (w) => {
    const was = S.snap.wa.status;
    S.snap.wa = w;
    if (w.status === 'ready' && was !== 'ready') { if (S.view === 'whatsapp') toast('WhatsApp connected'); if (S.view === 'chats') loadContacts(); }
    soft();
  });
  on('health', (h) => { Object.assign(S.snap, h); soft(); });
  on('update', (u) => { S.snap.update = u; soft(); });
  on('activity-update', (a) => { const i = S.snap.activity.findIndex((x) => x.id === a.id); if (i >= 0) S.snap.activity[i] = a; else S.snap.activity.unshift(a); if (S.view === 'home' || S.view === 'activity') soft(); });
  on('activity-remove', ({ id }) => { S.snap.activity = S.snap.activity.filter((x) => x.id !== id); if (S.view === 'home' || S.view === 'activity') soft(); });
  on('digest', (d) => { if (!nativeNotifies && 'Notification' in window) new Notification('Kairos · Today', { body: d.text, icon: 'assets/icon.png' }); });
  on('contacts', (d) => { S.contactsLoading = d.loading; if (!d.loading) loadContacts(); else if (S.view === 'chats') renderList(); });
  on('person', (p) => toast(`Added to Notion ${p.db === 'employees' ? 'Employees' : 'Contacts'}`));
  on('stats', (st) => { S.snap.stats = st; if (S.view === 'home') soft(); });
  on('epsilon', (e) => { S.snap.epsilon = e; if (S.view === 'settings' || S.view === 'home') render(); });
  on('activity', (a) => {
    S.snap.activity.unshift(a);
    if (S.view === 'home' || S.view === 'activity') soft(); else renderNav();
    if (!nativeNotifies && 'Notification' in window && ['meeting', 'document', 'order'].includes(a.kind)) new Notification(`${KIND[a.kind]} · ${a.name}`, { body: a.title, icon: 'assets/icon.png', silent: false });
  });
  es.onerror = () => { // engine restarting or stopped: say so, keep trying
    es.close();
    if (!S.offline) { S.offline = true; if (S.snap) render(); }
    setTimeout(stream, 2500);
  };
}

(async () => {
  conn = { base: location.origin, token: document.querySelector('meta[name="kairos-token"]').content };
  if (BROWSER && 'Notification' in window && Notification.permission === 'default') document.addEventListener('click', () => Notification.requestPermission(), { once: true });
  try { S.snap = await api('GET', '/api/state'); } catch {}
  render();
  stream();
})();
