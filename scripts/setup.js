// One-time developer setup: portable Node 22, OpenWA (pinned) built with it, headless Chrome.
// End users never run this — the installer ships the result (see "build" in package.json).
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const VENDOR = path.join(ROOT, 'vendor');
const NODE_VERSION = 'v22.23.3';
const OPENWA_REPO = 'https://github.com/rmyndharis/OpenWA.git';
const OPENWA_COMMIT = 'fd8c6e376a8f91a4fd3bf1f8b08d286d154488d5';

const nodeDir = path.join(VENDOR, 'node');
const openwa = path.join(VENDOR, 'openwa');
fs.mkdirSync(VENDOR, { recursive: true });

if (!fs.existsSync(path.join(nodeDir, 'node.exe'))) {
  console.log(`Downloading Node ${NODE_VERSION}…`);
  const zip = path.join(os.tmpdir(), `node-${NODE_VERSION}.zip`);
  execFileSync('curl.exe', ['-sSL', '-o', zip, `https://nodejs.org/dist/${NODE_VERSION}/node-${NODE_VERSION}-win-x64.zip`], { stdio: 'inherit' });
  execFileSync('tar', ['-xf', zip, '-C', VENDOR]);
  fs.renameSync(path.join(VENDOR, `node-${NODE_VERSION}-win-x64`), nodeDir);
}

if (!fs.existsSync(openwa)) {
  console.log('Cloning OpenWA…');
  execFileSync('git', ['clone', OPENWA_REPO, openwa], { stdio: 'inherit' });
  execFileSync('git', ['checkout', OPENWA_COMMIT], { cwd: openwa, stdio: 'inherit' });
}

// better-sqlite3 13.0.3 was published without its prebuilt binaries, which forces a C++
// toolchain on every machine. 13.0.2 ships them (N-API, any Node 22+).
const pkgPath = path.join(openwa, 'package.json');
const pkg = fs.readFileSync(pkgPath, 'utf8').replace(/^﻿/, '');
fs.writeFileSync(pkgPath, pkg.replace(/"better-sqlite3": "\^13\.0\.3"/, '"better-sqlite3": "13.0.2"'));

// OpenWA binds every interface; Kairos only ever talks to it locally. Loopback-only keeps it
// off the LAN and avoids the Windows Firewall prompt on first run.
const mainTs = path.join(openwa, 'src', 'main.ts');
fs.writeFileSync(mainTs, fs.readFileSync(mainTs, 'utf8').replace('await app.listen(port);', "await app.listen(port, '127.0.0.1');"));

const env = { ...process.env, PATH: `${nodeDir}${path.delimiter}${process.env.PATH}`, PUPPETEER_CACHE_DIR: path.join(VENDOR, 'puppeteer') };
const npm = (args) => execSync(`npm ${args}`, { cwd: openwa, env, stdio: 'inherit' });
console.log('Installing OpenWA dependencies (downloads headless Chrome)…');
npm('install --no-audit --no-fund');
console.log('Building OpenWA…');
npm('run build');
console.log('\nDone. Run "npm start" to launch Kairos.');
