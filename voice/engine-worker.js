'use strict';
// Runs in an Electron utility process: loads sherpa-onnx (native) so heavy CPU work and any
// native crash stay out of the main process. Messages come from voice/engine-host.js.
const path = require('path');

const port = process.parentPort;
let sherpa = null;
function lib() {
  if (!sherpa) sherpa = require(path.join(process.env.PET_SHERPA_DIR, 'sherpa-onnx-node'));
  return sherpa;
}

let tts = null, ttsKey = '';
let asr = null, asrKey = '';
const cancelled = new Set();

async function loadTts(dir, threads) {
  const key = dir + '|' + threads;
  if (tts && ttsKey === key) return tts;
  const p = (n) => path.join(dir, n);
  tts = await lib().OfflineTts.createAsync({
    model: {
      kokoro: { model: p('model.int8.onnx'), voices: p('voices.bin'), tokens: p('tokens.txt'),
        dataDir: p('espeak-ng-data'), lexicon: `${p('lexicon-us-en.txt')},${p('lexicon-zh.txt')}` },
      numThreads: threads, provider: 'cpu', debug: false,
    },
    maxNumSentences: 1,
    ruleFsts: ['phone-zh.fst', 'date-zh.fst', 'number-zh.fst'].map(p).join(','),
  });
  ttsKey = key;
  return tts;
}

function loadAsr(dir, threads) {
  const key = dir + '|' + threads;
  if (asr && asrKey === key) return asr;
  asr = new (lib().OfflineRecognizer)({
    featConfig: { sampleRate: 16000, featureDim: 80 },
    modelConfig: {
      senseVoice: { model: path.join(dir, 'model.int8.onnx'), language: 'auto', useInverseTextNormalization: 1 },
      tokens: path.join(dir, 'tokens.txt'), numThreads: threads, provider: 'cpu', debug: 0,
    },
  });
  asrKey = key;
  return asr;
}

// copy out of native memory: Electron's V8 sandbox does not allow external buffers
const copy = (a) => Float32Array.from(a);

async function handle(m) {
  if (m.op === 'cancel') { cancelled.add(m.id); return; }
  if (m.op === 'ping') { port.postMessage({ id: m.id, op: 'ok', pid: process.pid }); return; }
  if (m.op === 'tts') {
    const engine = await loadTts(m.dir, m.threads);
    let sent = 0;
    const res = await engine.generateAsync({
      text: m.text, sid: m.sid, speed: m.speed || 1, enableExternalBuffer: false,
      onProgress: (info) => {
        if (cancelled.has(m.id)) return 0;
        if (info && info.samples && info.samples.length) {
          port.postMessage({ id: m.id, op: 'chunk', samples: copy(info.samples), sampleRate: engine.sampleRate });
          sent++;
        }
        return 1;
      },
    });
    if (!sent && !cancelled.has(m.id) && res && res.samples && res.samples.length) {
      port.postMessage({ id: m.id, op: 'chunk', samples: copy(res.samples), sampleRate: res.sampleRate });
    }
    cancelled.delete(m.id);
    port.postMessage({ id: m.id, op: 'done' });
    return;
  }
  if (m.op === 'asr') {
    const rec = loadAsr(m.dir, m.threads);
    const stream = rec.createStream();
    stream.acceptWaveform({ sampleRate: m.sampleRate || 16000, samples: m.samples });
    rec.decode(stream);
    const r = rec.getResult(stream);
    port.postMessage({ id: m.id, op: 'done', text: (r && r.text) || '', lang: r && r.lang, emotion: r && r.emotion });
    return;
  }
  if (m.op === 'warm') {
    if (m.what === 'tts') await loadTts(m.dir, m.threads);
    if (m.what === 'asr') loadAsr(m.dir, m.threads);
    port.postMessage({ id: m.id, op: 'done' });
    return;
  }
  if (m.op === 'unload') {
    if (m.what === 'tts') { tts = null; ttsKey = ''; }
    if (m.what === 'asr') { asr = null; asrKey = ''; }
    port.postMessage({ id: m.id, op: 'done' });
  }
}

// one job at a time; TTS sentences stream back as they are produced
let chain = Promise.resolve();
port.on('message', (e) => {
  const m = e.data;
  if (m && m.op === 'cancel') { cancelled.add(m.id); return; }
  chain = chain.then(() => handle(m)).catch((err) => {
    port.postMessage({ id: m && m.id, op: 'error', message: String((err && err.message) || err) });
  });
});
port.postMessage({ op: 'ready' });
