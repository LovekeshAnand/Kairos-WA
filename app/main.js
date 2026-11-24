// Kairos desktop shell. The window is just a view: monitoring lives in the detached engine
// process, so closing (or quitting) the window never stops Kairos from watching.
const { app, BrowserWindow, Tray, Menu, Notification, ipcMain, shell, nativeImage, dialog } = require('electron');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const ENGINE = 'http://127.0.0.1:2790';
const ROOT = path.join(__dirname, '..');
const VENDOR = app.isPackaged ? path.join(process.resourcesPath, 'vendor') : path.join(ROOT, 'vendor');
const DATA = path.join(process.env.APPDATA, 'Kairos');
const ASSETS = path.join(__dirname, 'ui', 'assets');
const HIDDEN = process.argv.includes('--hidden');
const DOCS = path.join(app.getPath('documents'), 'Kairos');

app.setAppUserModelId('app.kairos.desktop');
app.setPath('userData', path.join(DATA, 'ui'));
if (!app.requestSingleInstanceLock()) app.quit();

let win = null;
let tray = null;
let quitting = false;
let wa = {};
let paused = false;

// --- engine -------------------------------------------------------------------------------

const health = () => fetch(`${ENGINE}/health`, { signal: AbortSignal.timeout(1500) }).then((r) => r.json()).catch(() => null);
// Kairos 1.0.0 engines answered {ok, pid} without the "app" marker.
const isKairos = (h) => !!h && (h.app === 'kairos' || (h.ok === true && h.app === undefined && typeof h.pid === 'number'));
const ping = async () => isKairos(await health());

async function ensureEngine() {
  const h = await health();
  if (h && !isKairos(h)) {
    dialog.showErrorBox('Kairos cannot start', `Another program is using port 2790, which Kairos needs. Close it and open Kairos again.`);
    return app.exit(1);
  }
  if (h && h.version === app.getVersion()) return;
  if (h) { // an older engine survived an update: replace it so the new code runs
    await engine('POST', '/api/shutdown').catch(() => {});
    for (let i = 0; i < 40 && (await health()); i++) await new Promise((r) => setTimeout(r, 250));
  }
  const ui = app.isPackaged ? { cmd: process.execPath, args: [] } : { cmd: process.execPath, args: [app.getAppPath()] };
  const env = { ...process.env, KAIROS_VENDOR: VENDOR, KAIROS_DOCS: DOCS, KAIROS_UI: JSON.stringify(ui) };
  delete env.ELECTRON_RUN_AS_NODE;
  spawn(path.join(VENDOR, 'node', 'node.exe'), [path.join(ROOT, 'engine', 'index.js')], {
    detached: true, stdio: 'ignore', windowsHide: true, env,
  }).unref();
  for (let i = 0; i < 40 && !(await ping()); i++) await new Promise((r) => setTimeout(r, 250));
}

const token = () => JSON.parse(fs.readFileSync(path.join(DATA, 'config.json'), 'utf8')).token;

async function engine(method, p, body) {
  const r = await fetch(ENGINE + p, { method, headers: { Authorization: `Bearer ${token()}`, 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) });
  return r.json();
}

// Main-process event stream: drives the tray and pops the window when WhatsApp needs a re-scan.
function listen() {
  const req = http.get(`${ENGINE}/events?token=${token()}`, (res) => {
    let buf = '';
    res.setEncoding('utf8');
    res.on('data', (chunk) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const type = /^event: (.+)$/m.exec(block)?.[1];
        const data = /^data: (.+)$/m.exec(block)?.[1];
        if (!type || !data) continue;
        const d = JSON.parse(data);
        if (type === 'state') { wa = d.wa; paused = d.paused; }
        if (type === 'wa') wa = d;
        if (type === 'relogin') {
          show();
          new Notification({ title: 'Kairos needs you', body: 'Your WhatsApp session ended. Scan the QR code to keep monitoring.', icon: path.join(ASSETS, 'icon.png') }).show();
        }
        updateTray();
      }
    });
    res.on('end', () => setTimeout(listen, 3000));
  });
  req.on('error', () => setTimeout(() => ensureEngine().then(listen), 3000));
}

// --- window + tray -----------------------------------------------------------------------

function createWindow() {
  win = new BrowserWindow({
    width: 1220, height: 800, minWidth: 980, minHeight: 640,
    show: false,
    backgroundColor: '#ffffff',
    title: 'Kairos',
    icon: path.join(ASSETS, 'icon.png'),
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#ffffff', symbolColor: '#1b1712', height: 46 },
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true },
  });
  win.loadURL(ENGINE + '/'); // the engine serves the UI (same page Mac users open in a browser)
  win.once('ready-to-show', () => { if (!HIDDEN) win.show(); });
  win.on('close', (e) => {
    if (quitting) return;
    e.preventDefault();
    win.hide();
    if (!fs.existsSync(path.join(DATA, 'ui', '.hinted'))) {
      fs.writeFileSync(path.join(DATA, 'ui', '.hinted'), '1');
      new Notification({ title: 'Kairos is still watching', body: 'Monitoring continues in the background. Find Kairos in the system tray.', icon: path.join(ASSETS, 'icon.png') }).show();
    }
  });
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https:\/\//.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e, url) => { if (!url.startsWith(ENGINE + '/')) e.preventDefault(); });
}

function show() {
  if (!win) createWindow();
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

const STATUS_LABEL = { ready: 'Connected', qr_ready: 'Waiting for QR scan', initializing: 'Connecting…', authenticating: 'Connecting…', disconnected: 'Disconnected', failed: 'Connection failed', created: 'Not connected', booting: 'Starting…' };

function updateTray() {
  if (!tray) return;
  const label = STATUS_LABEL[wa.status] || 'Starting…';
  tray.setToolTip(`Kairos — WhatsApp: ${label}${paused ? ' · paused' : ''}`);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open Kairos', click: show },
    { label: `WhatsApp: ${label}`, enabled: false },
    { type: 'separator' },
    { label: paused ? 'Resume monitoring' : 'Pause monitoring', click: () => engine('POST', '/api/pause', { paused: !paused }).then((r) => { paused = r.paused; updateTray(); }) },
    { label: 'Start with Windows', type: 'checkbox', checked: loginItem(), click: (i) => loginItem(i.checked) },
    { type: 'separator' },
    { label: 'Close window (keep monitoring)', click: () => { quitting = true; app.quit(); } },
    { label: 'Quit and stop monitoring', click: () => engine('POST', '/api/shutdown').catch(() => {}).finally(() => { quitting = true; app.quit(); }) },
  ]));
}

function loginItem(on) {
  const args = app.isPackaged ? ['--hidden'] : [app.getAppPath(), '--hidden'];
  if (on !== undefined) app.setLoginItemSettings({ openAtLogin: on, path: process.execPath, args });
  return app.getLoginItemSettings({ path: process.execPath, args }).openAtLogin;
}

// --- IPC for the renderer (narrow on purpose) ------------------------------------------------

ipcMain.handle('kairos:open', (_, target) => {
  const p = path.resolve(String(target));
  if (p === DOCS || p.startsWith(DOCS + path.sep)) return shell.openPath(p); // only Kairos' own folder
});
ipcMain.handle('kairos:reveal', (_, target) => {
  const p = path.resolve(String(target));
  if (p.startsWith(DOCS + path.sep)) shell.showItemInFolder(p);
});
ipcMain.handle('kairos:external', (_, url) => { if (/^https:\/\/([a-z0-9-]+\.)?notion\.(so|com)\//.test(url)) shell.openExternal(url); });
ipcMain.handle('kairos:loginItem', (_, on) => loginItem(on));

app.on('second-instance', show);
app.on('before-quit', () => { quitting = true; });
app.on('window-all-closed', (e) => e.preventDefault());

app.whenReady().then(async () => {
  // First launch: start with Windows by default, so monitoring survives reboots.
  const marker = path.join(DATA, 'ui', '.installed');
  if (!fs.existsSync(marker)) { loginItem(true); fs.mkdirSync(path.dirname(marker), { recursive: true }); fs.writeFileSync(marker, '1'); }

  tray = new Tray(nativeImage.createFromPath(path.join(ASSETS, 'tray.png')));
  tray.on('click', show);
  updateTray();
  await ensureEngine();
  createWindow();
  listen();
});
