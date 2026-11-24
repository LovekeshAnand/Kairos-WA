// Packs everything the engine needs into src-tauri/runtime.tar (one file instead of ~50k, so the
// installer stays fast). The desktop shell unpacks it once per version on first launch.
//   app/    engine + UI + @notionhq/client + package.json
//   vendor/ portable Node, OpenWA (dist + node_modules), headless Chrome
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const STAGE = path.join(ROOT, 'dist', 'runtime-stage');
const OUT = path.join(ROOT, 'src-tauri', 'runtime.tar');
const win = process.platform === 'win32';

if (!fs.existsSync(path.join(ROOT, 'vendor', 'openwa', 'dist', 'main.js'))) throw new Error('Run "npm run setup" first.');
fs.rmSync(STAGE, { recursive: true, force: true });
const copy = (from, to, filter) => fs.cpSync(path.join(ROOT, from), path.join(STAGE, to), { recursive: true, filter, dereference: true });

copy('engine', 'app/engine', (f) => !f.endsWith('.test.js'));
copy('app/ui', 'app/app/ui');
copy('node_modules/@notionhq/client', 'app/node_modules/@notionhq/client');
copy('package.json', 'app/package.json');
fs.writeFileSync(path.join(STAGE, 'VERSION'), require(path.join(ROOT, 'package.json')).version);

// Large trees are not copied: tar reads them straight from vendor/.
fs.rmSync(OUT, { force: true });
const args = ['-cf', OUT, '-C', STAGE, 'app', 'VERSION', '-C', path.join(ROOT), 'vendor/node', 'vendor/openwa/dist', 'vendor/openwa/node_modules', 'vendor/openwa/package.json'];
if (fs.existsSync(path.join(ROOT, 'vendor', 'puppeteer', 'chrome'))) args.push('vendor/puppeteer/chrome');
// Windows' bsdtar takes drive-letter paths; GNU tar (Git Bash) would read "D:" as a remote host.
execFileSync(win ? path.join(process.env.SystemRoot, 'System32', 'tar.exe') : 'tar', args, { stdio: 'inherit' });
fs.rmSync(STAGE, { recursive: true, force: true });
console.log(`Packed ${path.relative(ROOT, OUT)} (${(fs.statSync(OUT).size / 1e6).toFixed(0)} MB)`);
