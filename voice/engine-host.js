'use strict';
// Main-process side of the native voice engine: starts the utility process on demand,
// routes requests, and shuts it down after a while of not being used to give back memory.
const { app, utilityProcess } = require('electron');
const path = require('path');
const os = require('os');

const IDLE_MS = 15 * 60 * 1000;
let proc = null, ready = null;
const pending = new Map();   // id -> { resolve, reject, onChunk }
let seq = 0, idleTimer = null;

function sherpaDir() {
  // packaged: Contents/Resources/sherpa (mac) or resources/sherpa (win); dev: vendor/sherpa
  return app.isPackaged ? path.join(process.resourcesPath, 'sherpa') : path.join(__dirname, '..', 'vendor', 'sherpa');
}
const threads = () => Math.max(1, Math.min(4, Math.floor((os.cpus().length || 2) / 2)));

function start() {
  if (ready) return ready;
  ready = new Promise((resolve, reject) => {
    const env = { ...process.env, PET_SHERPA_DIR: sherpaDir() };
    if (process.platform === 'linux') env.LD_LIBRARY_PATH = path.join(sherpaDir(), 'sherpa-onnx-linux-x64') + ':' + (process.env.LD_LIBRARY_PATH || '');
    const p = utilityProcess.fork(path.join(__dirname, 'engine-worker.js'), [], { serviceName: 'ClaudePet Voice', env, stdio: 'pipe' });
    proc = p;
    const log = (d) => { if (process.env.PET_VOICE_DEBUG) process.stdout.write('[voice] ' + d); };
    if (p.stdout) p.stdout.on('data', log);
    if (p.stderr) p.stderr.on('data', log);
    const t = setTimeout(() => reject(new Error('语音引擎启动超时')), 20000);
    p.on('message', (m) => {
      if (m && m.op === 'ready') { clearTimeout(t); resolve(p); return; }
      const job = m && pending.get(m.id);
      if (!job) return;
      if (m.op === 'chunk') { try { job.onChunk && job.onChunk(m); } catch (_) {} return; }
      pending.delete(m.id);
      if (m.op === 'error') job.reject(new Error(m.message));
      else job.resolve(m);
      armIdle();
    });
    p.on('exit', (code) => {
      clearTimeout(t);
      if (proc === p) { proc = null; ready = null; }
      for (const [, job] of pending) job.reject(new Error(`语音引擎退出了（${code}）`));
      pending.clear();
      reject(new Error(`语音引擎没能启动（${code}）`));
    });
  });
  ready.catch(() => { ready = null; });
  return ready;
}

function armIdle() {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => { if (!pending.size) stop(); }, IDLE_MS);
}
function stop() {
  clearTimeout(idleTimer);
  // quitting or removing a model: finish outstanding jobs quietly instead of as errors
  for (const [, job] of pending) job.resolve({ op: 'done', stopped: true });
  pending.clear();
  if (proc) { try { proc.kill(); } catch (_) {} }
  proc = null; ready = null;
}

async function call(msg, onChunk) {
  const p = await start();
  clearTimeout(idleTimer);
  const id = ++seq;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject, onChunk });
    p.postMessage({ ...msg, id, threads: threads() });
  });
}
function cancel(id) { if (proc && id) try { proc.postMessage({ op: 'cancel', id }); } catch (_) {} }

// Kokoro: stream sentence chunks to onChunk({ samples, sampleRate }); returns { id, done: Promise }
function tts(dir, text, sid, speed, onChunk) {
  const job = { id: 0 };
  job.done = (async () => {
    const p = await start();
    clearTimeout(idleTimer);
    const id = job.id = ++seq;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject, onChunk });
      p.postMessage({ op: 'tts', id, dir, text, sid, speed, threads: threads() });
    });
  })();
  job.cancel = () => cancel(job.id);
  return job;
}

// load a model ahead of time (e.g. while the AI is still thinking, or while you are still talking)
function warm(what, dir) { return call({ op: 'warm', what, dir }).catch(() => {}); }

async function asr(dir, samples, sampleRate) {
  const r = await call({ op: 'asr', dir, samples, sampleRate });
  return String(r.text || '').trim();
}

app.on('before-quit', stop);
module.exports = { tts, asr, warm, stop, start, sherpaDir };
