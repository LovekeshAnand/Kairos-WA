// Builds dist/Kairos-mac.tar.gz: the browser edition for macOS (no Electron, no code signing).
// The Mac downloads its own Node, OpenWA packages, Chrome and Epsilon at install time, so the
// package only carries platform-neutral code.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'dist', 'mac-build', 'Kairos-mac'); // staging; the .tar.gz is the deliverable
const OPENWA = path.join(ROOT, 'vendor', 'openwa');
const copy = (from, to, filter) => fs.cpSync(path.join(ROOT, from), path.join(OUT, to), { recursive: true, filter });

if (!fs.existsSync(path.join(OPENWA, 'dist', 'main.js'))) throw new Error('Run "npm run setup" first (OpenWA is not built).');
fs.rmSync(OUT, { recursive: true, force: true });

// Kairos itself: engine + UI + its single pure-JS dependency.
copy('engine', 'payload/app/engine', (f) => !f.endsWith('.test.js'));
copy('app/ui', 'payload/app/app/ui');
copy('node_modules/@notionhq/client', 'payload/app/node_modules/@notionhq/client');
const pkg = require(path.join(ROOT, 'package.json'));
fs.writeFileSync(path.join(OUT, 'payload/app/package.json'), JSON.stringify({ name: pkg.name, version: pkg.version, private: true }, null, 2));

// OpenWA, prebuilt (dist/ is plain JS). Its packages are installed on the Mac.
copy('vendor/openwa/dist', 'payload/openwa/dist');
copy('vendor/openwa/scripts', 'payload/openwa/scripts');
for (const f of ['package.json', 'package-lock.json']) copy(`vendor/openwa/${f}`, `payload/openwa/${f}`);

// The Kairos app (menu bar + window) is built by Tauri on a Mac (CI); without it install.sh
// falls back to a small launcher that opens the page in the browser.
const tauriApp = process.env.KAIROS_MAC_APP;
if (tauriApp && fs.existsSync(tauriApp)) fs.cpSync(tauriApp, path.join(OUT, 'payload', 'Kairos.app'), { recursive: true, verbatimSymlinks: true });

// Scripts + readme, with Unix line endings (bash chokes on CRLF). The release repo is baked into
// install.sh so the one-line installer knows where to download from.
const repo = pkg.kairos?.releases || '__REPO__';
for (const f of ['install.sh', 'uninstall.sh', 'README.txt']) {
  const text = fs.readFileSync(path.join(ROOT, 'mac', f), 'utf8').replace(/\r\n/g, '\n').replaceAll('__REPO__', repo);
  fs.writeFileSync(path.join(OUT, f), text, { mode: 0o755 });
}
fs.mkdirSync(path.join(ROOT, 'dist'), { recursive: true });
fs.copyFileSync(path.join(OUT, 'install.sh'), path.join(ROOT, 'dist', 'install.sh')); // release asset for curl | bash

const tarball = path.join(path.dirname(OUT), 'Kairos-mac.tar.gz');
fs.rmSync(tarball, { force: true });
execFileSync('tar', ['-czf', 'Kairos-mac.tar.gz', 'Kairos-mac'], { cwd: path.dirname(OUT) }); // relative: GNU tar reads 'D:' as a host

fs.renameSync(tarball, path.join(ROOT, 'dist', 'Kairos-mac.tar.gz'));
console.log(`Built dist/Kairos-mac.tar.gz (${(fs.statSync(path.join(ROOT, 'dist', 'Kairos-mac.tar.gz')).size / 1e6).toFixed(1)} MB)`);
