// Paths + the single persisted config file. Everything Kairos owns lives under DATA.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const VENDOR = process.env.KAIROS_VENDOR || path.join(ROOT, 'vendor');
const DATA = process.env.KAIROS_DATA || (process.platform === 'darwin'
  ? path.join(os.homedir(), 'Library', 'Application Support', 'Kairos')
  : path.join(process.env.APPDATA || os.homedir(), 'Kairos'));
// macOS guards ~/Documents from background processes (no prompt can appear), so Mac uses ~/Kairos.
const DOCS = process.env.KAIROS_DOCS || (process.platform === 'darwin' ? path.join(os.homedir(), 'Kairos') : path.join(os.homedir(), 'Documents', 'Kairos'));

const paths = {
  root: ROOT,
  vendor: VENDOR,
  data: DATA,
  docs: DOCS,
  node: path.join(VENDOR, 'node', process.platform === 'win32' ? 'node.exe' : 'bin/node'),
  openwa: path.join(VENDOR, 'openwa'),
  openwaData: path.join(DATA, 'openwa'),
  epsilon: path.join(DATA, 'epsilon'),
  logs: path.join(DATA, 'logs'),
  config: path.join(DATA, 'config.json'),
};

const PORTS = { engine: 2790, openwa: 2785, epsilon: 2791 };
let VERSION = '0.0.0';
try { VERSION = require(path.join(ROOT, 'package.json')).version; } catch {}
let PKG = {};
try { PKG = require(path.join(ROOT, 'package.json')); } catch {}

const DEFAULTS = {
  token: null, // UI <-> engine bearer
  openwaKey: null, // OpenWA admin key (API_MASTER_KEY)
  webhookSecret: null,
  sessionId: null,
  everLinked: false, // true once a phone was linked: a later QR means "session ended, re-scan"
  paused: false,
  monitored: {}, // chatId -> { name, number, role: 'contact' | 'employee', mode: 'all' | 'docs' | 'everything', since }
  people: {}, // chatId -> { pageId, db }
  notion: null, // { token, parentId, workspace, dbs: { contacts: { db, ds, url }, ... } }
  epsilon: { enabled: true },
  stats: { logged: 0, noise: 0, documents: 0, meetings: 0, orders: 0 },
  waEngine: 'whatsapp-web.js', // or 'baileys' (no headless Chrome)
  lastSeen: {}, // chatId -> unix seconds of the newest message Kairos has seen there
  pauses: [], // { id, from, to, state: 'open' | 'pending' | 'synced' | 'skipped' }
  digest: true, // daily summary notification
  lastDigest: null,
  releases: null, // "owner/repo" override for update checks
};

for (const p of [paths.data, paths.openwaData, paths.epsilon, paths.logs, paths.docs]) fs.mkdirSync(p, { recursive: true });

// Reads a JSON file; a corrupt one is set aside (never silently overwritten) and the backup used.
function readJson(file) {
  for (const f of [file, file + '.bak']) {
    if (!fs.existsSync(f)) continue;
    try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch {
      if (f === file) fs.copyFileSync(f, `${f}.corrupt-${Date.now()}`);
    }
  }
  return null;
}

function writeJson(file, data) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data));
  if (fs.existsSync(file)) fs.copyFileSync(file, file + '.bak'); // last good copy
  fs.renameSync(tmp, file); // atomic swap, a crash never leaves half a file
}

let cfg;
function load() {
  cfg = { ...structuredClone(DEFAULTS), ...(readJson(paths.config) || {}) };
  const rnd = () => crypto.randomBytes(24).toString('hex');
  cfg.token ||= rnd();
  cfg.openwaKey ||= 'owa_' + rnd();
  cfg.webhookSecret ||= rnd();
  save();
  return cfg;
}

function save() { writeJson(paths.config, cfg); }

// A small JSON file under DATA with debounced, atomic saves (activity, outbox, buffers...).
function store(name, fallback) {
  const file = path.join(DATA, name);
  const s = { data: readJson(file) ?? fallback, timer: null };
  s.save = () => { clearTimeout(s.timer); s.timer = setTimeout(s.flush, 800); };
  s.flush = () => { clearTimeout(s.timer); try { writeJson(file, s.data); } catch {} };
  return s;
}

module.exports = { paths, PORTS, VERSION, PKG, load, save, store, readJson, writeJson, get: () => cfg };
