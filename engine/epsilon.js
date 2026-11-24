// Epsilon runtime — a port of Epsilon v2's TieredModelManager (single fast tier) for Windows.
// Kairos only needs to sort messages, so the tier is a 132 MB multilingual embedding model:
// messages are matched against the example bank (examples.js), ~10 ms each on CPU.
// Installs llama-server + model on first run, starts lazily, unloads after Epsilon's idle_timeout.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');
const { paths, PORTS } = require('./config');

const LLAMA_BUILD = 'b11685';
// llama.cpp release asset per platform. Mac archives wrap everything in one folder (strip it).
const ASSETS = {
  'win32-x64': { file: `llama-${LLAMA_BUILD}-bin-win-cpu-x64.zip`, strip: 0 },
  'darwin-arm64': { file: `llama-${LLAMA_BUILD}-bin-macos-arm64.tar.gz`, strip: 1 },
  'darwin-x64': { file: `llama-${LLAMA_BUILD}-bin-macos-x64.tar.gz`, strip: 1 },
};
const ASSET = ASSETS[`${process.platform}-${process.arch}`];
const MODEL = {
  name: 'multilingual-e5-small (Q8)',
  file: 'multilingual-e5-small-q8_0.gguf',
  url: 'https://huggingface.co/keisuke-miyako/multilingual-e5-small-gguf-q8_0/resolve/main/multilingual-e5-small-Q8_0.gguf',
};
const IDLE_TIMEOUT_MS = 300_000; // Epsilon config.yaml: idle_timeout: 300
const BIN = path.join(paths.epsilon, 'bin', process.platform === 'win32' ? 'llama-server.exe' : 'llama-server');
const MODEL_PATH = path.join(paths.epsilon, 'models', MODEL.file);
const BASE = `http://127.0.0.1:${PORTS.epsilon}`;

const state = { phase: 'idle', progress: 0, error: null }; // idle | installing | ready | error
let proc = null;
let starting = null;
let lastUse = 0;

const installed = () => fs.existsSync(BIN) && fs.existsSync(MODEL_PATH);

async function download(url, dest, onProgress) {
  const part = dest + '.part';
  const have = fs.existsSync(part) ? fs.statSync(part).size : 0; // resume after a dropped connection
  const res = await fetch(url, { headers: have ? { Range: `bytes=${have}-` } : {} });
  if (!res.ok && res.status !== 206) throw new Error(`Download failed ${res.status}: ${url}`);
  const resumed = res.status === 206;
  const total = Number(res.headers.get('content-length') || 0) + (resumed ? have : 0);
  let done = resumed ? have : 0;
  const body = Readable.fromWeb(res.body);
  body.on('data', (c) => { done += c.length; total && onProgress(done / total); });
  await pipeline(body, fs.createWriteStream(part, { flags: resumed ? 'a' : 'w' }));
  fs.renameSync(part, dest);
}

async function install(onChange = () => {}) {
  if (state.phase === 'installing') return;
  const set = (patch) => { Object.assign(state, patch); onChange(status()); };
  try {
    set({ phase: 'installing', progress: 0, error: null });
    if (!fs.existsSync(BIN)) {
      if (!ASSET) throw new Error(`Epsilon has no build for ${process.platform}-${process.arch}`);
      const archive = path.join(os.tmpdir(), ASSET.file);
      await download(`https://github.com/ggml-org/llama.cpp/releases/download/${LLAMA_BUILD}/${ASSET.file}`, archive, (p) => set({ progress: p * 0.15 }));
      fs.mkdirSync(path.dirname(BIN), { recursive: true });
      // bsdtar ships with Windows 10+ and macOS and reads both zip and tar.gz.
      execFileSync('tar', ['-xf', archive, '-C', path.dirname(BIN), ...(ASSET.strip ? [`--strip-components=${ASSET.strip}`] : [])]);
      fs.rmSync(archive, { force: true });
    }
    if (!fs.existsSync(MODEL_PATH)) {
      fs.mkdirSync(path.dirname(MODEL_PATH), { recursive: true });
      await download(MODEL.url, MODEL_PATH, (p) => set({ progress: 0.15 + p * 0.85 }));
    }
    set({ phase: 'ready', progress: 1 });
  } catch (e) {
    set({ phase: 'error', error: e.message });
  }
}

async function ensureRunning() {
  if (proc) return;
  if (starting) return starting;
  starting = (async () => {
    const threads = Math.max(1, Math.min(2, os.cpus().length >> 2)); // stay polite on the user's CPU
    proc = spawn(BIN, ['-m', MODEL_PATH, '--embedding', '--pooling', 'mean', '-c', '512', '-t', String(threads),
      '--host', '127.0.0.1', '--port', String(PORTS.epsilon), '--log-disable'], { cwd: path.dirname(BIN), stdio: 'ignore', windowsHide: true });
    proc.on('exit', () => { proc = null; });
    const until = Date.now() + 60_000;
    while (Date.now() < until) {
      try {
        const r = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(2000) });
        if (r.ok) return;
      } catch {}
      if (!proc) throw new Error('llama-server exited during startup');
      await new Promise((r) => setTimeout(r, 300));
    }
    throw new Error('Epsilon model did not load in 60s');
  })().finally(() => { starting = null; });
  return starting;
}

const normalize = (v) => { const n = Math.hypot(...v) || 1; return v.map((x) => x / n); };

// Unit-length embeddings for each text (e5 expects the "query: " prefix).
async function embed(texts) {
  if (!installed()) throw new Error('Epsilon is not installed');
  lastUse = Date.now();
  await ensureRunning();
  const res = await fetch(`${BASE}/v1/embeddings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ input: texts.map((t) => 'query: ' + t) }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`Epsilon ${res.status}: ${await res.text()}`);
  return (await res.json()).data.map((d) => normalize(d.embedding));
}

setInterval(() => {
  if (proc && Date.now() - lastUse > IDLE_TIMEOUT_MS) proc.kill(); // idle watchdog
}, 30_000).unref();

function stop() { if (proc) proc.kill(); }

function status() {
  return { ...state, phase: installed() && state.phase !== 'installing' ? 'ready' : state.phase, model: MODEL.name, loaded: !!proc };
}

module.exports = { install, embed, status, installed, stop };
