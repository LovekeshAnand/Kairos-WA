// Runs OpenWA (headless WhatsApp Web) as a child process and talks to it through a
// deliberately read-only client: Kairos never sends, reads-receipts, types or goes "online".
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { paths, PORTS } = require('./config');

const BASE = `http://127.0.0.1:${PORTS.openwa}`;
const SESSION_NAME = 'kairos';

// Anti-ban guard: the only writes Kairos may ever make are session lifecycle + webhook wiring.
// Anything that would act on WhatsApp (send, seen, presence, typing, react...) throws here.
const ALLOWED_WRITES = [
  /^POST \/api\/sessions$/,
  /^POST \/api\/sessions\/[^/]+\/(start|stop|logout)$/,
  /^(POST|PUT|DELETE) \/api\/sessions\/[^/]+\/webhooks(\/[^/]+)?$/,
];

function assertReadOnly(method, p) {
  if (method === 'GET') return;
  const sig = `${method} ${p.split('?')[0]}`;
  if (!ALLOWED_WRITES.some((re) => re.test(sig))) throw new Error(`Blocked by Kairos read-only guard: ${sig}`);
}

function createClient(apiKey) {
  async function call(method, p, body, { raw = false, timeout = 30000 } = {}) {
    assertReadOnly(method, p);
    const res = await fetch(BASE + p, {
      method,
      headers: { 'X-API-Key': apiKey, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeout),
    });
    if (!res.ok) {
      const err = new Error(`OpenWA ${method} ${p} -> ${res.status} ${await res.text().catch(() => '')}`.slice(0, 400));
      err.status = res.status;
      throw err;
    }
    if (raw) return res;
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  }
  return {
    get: (p, o) => call('GET', p, null, o),
    post: (p, b, o) => call('POST', p, b, o),
    del: (p) => call('DELETE', p),
  };
}

// --- child process ---------------------------------------------------------

let child = null;
let stopping = false;
let restarts = 0;

function env(cfg) {
  const d = paths.openwaData;
  return {
    ...process.env,
    NODE_ENV: 'production',
    PORT: String(PORTS.openwa),
    API_MASTER_KEY: cfg.openwaKey,
    LOG_LEVEL: 'warn',
    DATABASE_TYPE: 'sqlite',
    DATABASE_NAME: path.join(d, 'openwa.sqlite'),
    MAIN_DATABASE_NAME: path.join(d, 'main.sqlite'),
    PLUGIN_STATE_DIR: d,
    BOOTSTRAP_KEY_FILE: path.join(d, '.api-key'),
    BAILEYS_AUTH_DIR: path.join(d, 'baileys'),
    DATABASE_SYNCHRONIZE: 'false',
    ENGINE_TYPE: cfg.waEngine === 'baileys' ? 'baileys' : 'whatsapp-web.js',
    BAILEYS_MARK_ONLINE_ON_CONNECT: 'false', // Baileys defaults to "online", which silences the phone's notifications
    BAILEYS_SYNC_FULL_HISTORY: 'false',
    SESSION_DATA_PATH: path.join(d, 'sessions'), // persisted login: no repeated QR scans
    STORAGE_TYPE: 'local',
    STORAGE_LOCAL_PATH: path.join(d, 'media'),
    PLUGINS_DIR: path.join(d, 'plugins'),
    PUPPETEER_HEADLESS: 'true',
    PUPPETEER_CACHE_DIR: path.join(paths.vendor, 'puppeteer'),
    PUPPETEER_ARGS: '--disable-dev-shm-usage,--disable-gpu' + (process.platform === 'darwin' ? ',--use-mock-keychain' : ''), // no Keychain prompt on Mac
    AUTO_START_SESSIONS: 'true',
    REDIS_ENABLED: 'false',
    QUEUE_ENABLED: 'false',
    CACHE_ENABLED: 'false',
    SERVE_DASHBOARD: 'false',
    ENABLE_SWAGGER: 'false',
    MCP_ENABLED: 'false',
    STATUS_SEED_ON_READY: 'false', // don't crawl everyone's status stories on connect
    SSRF_ALLOWED_HOSTS: '127.0.0.1', // our webhook receiver is local
    WEBHOOK_MEDIA_INLINE_MAX_BYTES: '0', // fetch media on demand, only for monitored chats
    WEBHOOK_CONTACT_DETAILS: 'true',
    RESOLVE_LID_TO_PHONE: 'true',
    MEDIA_DOWNLOAD_MAX_BYTES: String(64 * 1024 * 1024),
  };
}

const PID_FILE = path.join(paths.openwaData, 'openwa.pid');
let pendingRestart = null;

function start(cfg, log) {
  stopping = false;
  clearTimeout(pendingRestart); pendingRestart = null;
  if (child) return;
  const entry = path.join(paths.openwa, 'dist', 'main.js');
  if (!fs.existsSync(entry)) throw new Error(`OpenWA is not built (${entry}). Run "npm run setup".`);
  const out = fs.openSync(path.join(paths.logs, 'openwa.log'), 'a');
  // cwd must sit on the same drive as dist/: TypeORM's entity globbing breaks across drives.
  // Every data path is passed explicitly above, so nothing is written next to the code.
  child = spawn(paths.node, [entry], { cwd: paths.openwa, env: env(cfg), stdio: ['ignore', out, out], windowsHide: true });
  fs.closeSync(out);
  fs.writeFileSync(PID_FILE, String(child.pid));
  log(`openwa started (pid ${child.pid}, ${cfg.waEngine})`);
  child.on('exit', (code) => {
    child = null;
    if (stopping) return;
    // Exponential backoff so a crash loop never hammers WhatsApp with reconnects.
    const delay = Math.min(5 * 60_000, 5000 * 2 ** restarts++);
    log(`openwa exited (${code}); restarting in ${delay / 1000}s`);
    pendingRestart = setTimeout(() => !stopping && start(cfg, log), delay);
  });
}

function killTree(pid) {
  if (!pid) return;
  try {
    if (process.platform === 'win32') spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    else process.kill(pid, 'SIGTERM');
  } catch {}
}

// Stops our child, or an OpenWA left behind by a crashed engine (found through its pid file).
// The pid file is only trusted while OpenWA still answers, so a reused pid is never killed.
async function stop() {
  stopping = true;
  clearTimeout(pendingRestart); pendingRestart = null;
  // Windows has no SIGTERM: kill the whole tree so headless Chrome doesn't linger.
  if (child) return killTree(child.pid);
  const pid = Number(fs.existsSync(PID_FILE) && fs.readFileSync(PID_FILE, 'utf8'));
  if (pid && pid !== process.pid && (await live())) killTree(pid);
}

// Kills OpenWA and starts it again right away (engine switch, hung process).
async function restart(cfg, log) {
  const was = child;
  await stop();
  if (was) await new Promise((r) => (was.exitCode !== null ? r() : was.once('exit', r)));
  for (let i = 0; i < 40 && (await live()); i++) await new Promise((r) => setTimeout(r, 250)); // port free
  restarts = 0;
  start(cfg, log);
}

const live = () => fetch(`${BASE}/api/health/live`, { signal: AbortSignal.timeout(2000) }).then((r) => r.ok).catch(() => false);
const running = () => !!child || !!pendingRestart;
// An OpenWA from a previous engine whose process still exists (it may still be booting).
function leftover() {
  const pid = Number(fs.existsSync(PID_FILE) && fs.readFileSync(PID_FILE, 'utf8'));
  if (!pid || child) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}
const resetBackoff = () => { restarts = 0; };

async function waitHealthy(timeoutMs = 300000) { // cold boots have been seen taking >2 min
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    try {
      const r = await fetch(`${BASE}/api/health/live`, { signal: AbortSignal.timeout(2000) });
      if (r.ok) { restarts = 0; return; }
    } catch {}
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error('OpenWA did not come up in time — see logs/openwa.log');
}

module.exports = { createClient, start, stop, restart, live, running, leftover, resetBackoff, waitHealthy, SESSION_NAME, assertReadOnly };
