'use strict';
// Voice for the pet: she reads her replies aloud, and you can talk to her through the mic.
//   speaking: Edge neural voices (online) -> Kokoro (offline, optional download) -> system voice
//   listening: SenseVoice (offline, optional download)
const { app, ipcMain } = require('electron');
const path = require('path');
const edge = require('./edge-tts');
const models = require('./models');
const host = require('./engine-host');
const store = require('../store');
const { cleanForSpeech, splitForSpeech, forKokoro, speakable } = require('./text');

const DEFAULTS = {
  speak: 'ai',          // off | ai (her AI replies) | all (also the little canned reactions)
  muted: false,         // quick mute from the tray menu
  engine: 'edge',       // edge | kokoro | system
  edgeVoice: 'zh-CN-XiaoyiNeural',
  rate: 0,              // -50..+50 (%)
  pitch: 0,             // -30..+30 (Hz, Edge) — Kokoro/system map it to their own range
  kokoroSid: 3,
  systemVoice: '',
  volume: 0.9,
  autoSend: true,       // send what you said right after it's recognised
};

let cfg = { ...DEFAULTS };
let cfgPath = null;
let toPet = () => {}, broadcast = () => {}, logError = () => {};
const lastError = { edge: '', kokoro: '', system: '' };
let speakSeq = 0;
let currentKokoro = null;

function load() {
  cfgPath = path.join(app.getPath('userData'), 'voice.json');
  // tmp + rename with a .bak like the other data files; a hand-edited file goes through the same checks as the
  // settings page (unknown extra fields are kept)
  const r = store.readJsonSync(cfgPath, null);
  const raw = r.data && typeof r.data === 'object' && !Array.isArray(r.data) ? r.data : null;
  try { cfg = raw ? sanitize({ ...raw, ...DEFAULTS }, raw) : { ...DEFAULTS }; } catch (_) { cfg = { ...DEFAULTS }; }
  const w = store.loadWarning(r, '语音设置文件（voice.json）', '语音设置回到了默认');
  if (w) logError('voice', w);
}
function save() { try { store.writeJsonSync(cfgPath, cfg); } catch (e) { logError('voice', '保存 voice.json 失败：' + e.message); } }

function publicSettings() {
  return {
    ...cfg,
    edgeVoices: edge.VOICES,
    models: { asr: models.status('asr'), tts: models.status('tts') },
    lastError: { ...lastError },
  };
}
// only known values get through: voice:test uses this too, so nothing unchecked reaches Edge's SSML
function sanitize(base, s) {
  const n = { ...base };
  if (['off', 'ai', 'all'].includes(s.speak)) n.speak = s.speak;
  if (typeof s.muted === 'boolean') n.muted = s.muted;
  if (['edge', 'kokoro', 'system'].includes(s.engine)) n.engine = s.engine;
  if (typeof s.edgeVoice === 'string' && /^[a-z]{2}-[A-Za-z-]+Neural$/.test(s.edgeVoice)) n.edgeVoice = s.edgeVoice;
  if (Number.isFinite(+s.rate)) n.rate = Math.max(-50, Math.min(50, Math.round(+s.rate)));
  if (Number.isFinite(+s.pitch)) n.pitch = Math.max(-30, Math.min(30, Math.round(+s.pitch)));
  if (Number.isFinite(+s.kokoroSid)) n.kokoroSid = Math.max(0, Math.min(102, Math.round(+s.kokoroSid)));
  if (typeof s.systemVoice === 'string') n.systemVoice = s.systemVoice.slice(0, 200);
  if (Number.isFinite(+s.volume)) n.volume = Math.max(0, Math.min(1, +s.volume));
  if (typeof s.autoSend === 'boolean') n.autoSend = s.autoSend;
  return n;
}
function update(s) {
  cfg = sanitize(cfg, s || {});
  save();
  return publicSettings();
}

// ---------- speaking ----------
function stopSpeaking() {
  speakSeq++;
  if (currentKokoro) { try { currentKokoro.cancel(); } catch (_) {} currentKokoro = null; }
  toPet('voice:stop');
}

function engineOrder(c) {
  const kok = models.isInstalled('tts');
  if (c.engine === 'system') return ['system'];
  if (c.engine === 'kokoro') return kok ? ['kokoro', 'system'] : ['system'];
  return kok ? ['edge', 'kokoro', 'system'] : ['edge', 'system'];
}
// Edge unreachable twice in a row (offline, blocked network): skip it for a while so she does not stall
// 12 s before every line; a settings-page test always tries it
const EDGE_TRIP = ['net', 'timeout', 'http', 'closed'];
const edgeBreak = { fails: 0, until: 0 };

async function speakWith(c, text, why) {
  const clean = cleanForSpeech(text);
  if (!speakable(clean)) return { ok: false, error: '没有可以念的文字' };
  stopSpeaking();
  const job = speakSeq;
  const errors = [];
  if (c.engine === 'kokoro' && !models.isInstalled('tts')) errors.push('离线语音模型还没下载，先用系统语音');
  for (const eng of engineOrder(c)) {
    if (job !== speakSeq) return { ok: false, error: 'interrupted' };
    if (eng === 'edge' && why !== 'test' && Date.now() < edgeBreak.until) continue;
    try {
      if (eng === 'edge') {
        // long replies go in pieces: the first plays while the next one is being made
        const parts = splitForSpeech(clean, 90);
        const synth = (t) => edge.synthesize({ text: t, voice: c.edgeVoice, rate: c.rate, pitch: c.pitch, timeoutMs: 12000 });
        const first = await synth(parts[0]);
        if (job !== speakSeq) return { ok: false, error: 'interrupted' };
        toPet('voice:play', { job, kind: 'mp3', data: first, volume: c.volume });
        lastError.edge = '';
        edgeBreak.fails = 0; edgeBreak.until = 0;
        (async () => {
          for (const t of parts.slice(1)) {
            if (job !== speakSeq) return;
            const mp3 = await synth(t);
            if (job !== speakSeq) return;
            toPet('voice:play', { job, kind: 'mp3', data: mp3, volume: c.volume });
          }
        })().catch((e) => logError('voice:edge-rest', e)).finally(() => { if (job === speakSeq) toPet('voice:play', { job, kind: 'end' }); });
        return { ok: true, engine: eng, errors };
      }
      if (eng === 'kokoro') {
        let got = 0, firstChunk;
        const started = new Promise((r) => { firstChunk = r; });
        const speed = Math.max(0.6, Math.min(1.6, 1 + c.rate / 100));
        const k = host.tts(models.dirOf('tts'), forKokoro(clean), c.kokoroSid, speed, (m) => {
          if (job !== speakSeq) return;
          got++;
          toPet('voice:play', { job, kind: 'pcm', samples: m.samples, sampleRate: m.sampleRate, volume: c.volume });
          firstChunk();
        });
        currentKokoro = k;
        const finished = k.done.finally(() => { if (currentKokoro === k) currentKokoro = null; });
        finished.catch(() => {});   // handled below / by the fallback
        // answer as soon as she starts talking; the rest keeps streaming in
        await Promise.race([started, finished]);
        if (job !== speakSeq) return { ok: false, error: 'interrupted' };
        if (!got) throw new Error('离线语音没有生成声音');
        finished.then(() => { if (job === speakSeq) toPet('voice:play', { job, kind: 'end' }); }, (e) => logError('voice:kokoro-rest', e));
        lastError.kokoro = '';
        return { ok: true, engine: eng, errors };
      }
      toPet('voice:system', { job, text: clean, voice: c.systemVoice, rate: 1 + c.rate / 100, pitch: 1 + c.pitch / 60, volume: c.volume });
      return { ok: true, engine: 'system', errors };
    } catch (e) {
      lastError[eng] = e.message;
      errors.push(e.message);
      logError('voice:' + eng + (why ? ':' + why : ''), e);
      if (eng === 'edge' && EDGE_TRIP.includes(e.code) && ++edgeBreak.fails >= 2) {
        edgeBreak.fails = 0; edgeBreak.until = Date.now() + 10 * 60000;
        lastError.edge = e.message + '（连续两次没连上，接下来 10 分钟先用别的声音，之后再试）';
      }
    }
  }
  return { ok: false, error: errors.join('；'), errors };
}

// get the offline engine ready before it is needed
function warm(what) {
  if (what === 'tts' && !(cfg.engine === 'kokoro' && !cfg.muted && cfg.speak !== 'off')) return;
  if (!models.isInstalled(what)) return;
  host.warm(what, models.dirOf(what));
}

// called for everything she says; canned = the little built-in reactions
function speak(text, { canned = false } = {}) {
  if (cfg.muted || cfg.speak === 'off') return Promise.resolve({ ok: false, error: 'off' });
  if (canned && cfg.speak !== 'all') return Promise.resolve({ ok: false, error: 'off' });
  return speakWith(cfg, text, canned ? 'canned' : 'ai').catch((e) => ({ ok: false, error: e.message }));
}

// ---------- listening ----------
async function transcribe(buf, sampleRate) {
  if (!models.isInstalled('asr')) return { ok: false, code: 'nomodel', error: '还没下载语音识别模型，去「AI 设置 → 语音」里下载一下' };
  const samples = buf instanceof Float32Array ? buf : new Float32Array(buf.buffer ? buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) : buf);
  const rate = sampleRate || 16000;
  if (samples.length < rate * 0.35) return { ok: false, code: 'short', error: '太短了，没听清' };
  let peak = 0;
  for (let i = 0; i < samples.length; i++) { const v = Math.abs(samples[i]); if (v > peak) peak = v; }
  if (peak < 0.01) return { ok: false, code: 'silent', error: '没听到声音，看看麦克风是不是静音了' };
  try {
    const t0 = Date.now();
    let text = await host.asr(models.dirOf('asr'), samples, rate);
    text = text.replace(/\s+/g, ' ').trim();
    if (!text || !/[\p{L}\p{N}]/u.test(text)) return { ok: false, code: 'empty', error: '没听清，再说一次？' };
    return { ok: true, text, ms: Date.now() - t0 };
  } catch (e) {
    logError('voice:asr', e);
    return { ok: false, code: 'engine', error: '识别出错了：' + e.message };
  }
}

// ---------- setup ----------
// IPC is only taken from our own pages (app://pet/...); main.js passes in its guarded helpers, these are the fallback
const fromApp = (e) => { try { return String((e && e.senderFrame && e.senderFrame.url) || '').startsWith('app://pet/'); } catch (_) { return false; } };
const guardHandle = (ch, fn) => ipcMain.handle(ch, (e, ...a) => (fromApp(e) ? fn(e, ...a) : undefined));
const guardOn = (ch, fn) => ipcMain.on(ch, (e, ...a) => { if (fromApp(e)) fn(e, ...a); });
const known = (id) => typeof id === 'string' && Object.prototype.hasOwnProperty.call(models.CATALOG, id);

function init(opts) {
  toPet = opts.toPet; broadcast = opts.broadcast; logError = opts.logError || logError;
  const handle = opts.handle || guardHandle, on = opts.on || guardOn;
  load();
  handle('voice:get', () => publicSettings());
  handle('voice:set', (_e, s) => update(s || {}));
  handle('voice:test', (_e, s, text) => speakWith(sanitize(cfg, s || {}), typeof text === 'string' && text.trim() ? text : '你好呀，我是大肥鱼！今天也要好好吃饭哦。', 'test').catch((e) => ({ ok: false, error: e.message })));
  handle('voice:transcribe', (_e, buf, rate) => transcribe(buf, rate));
  handle('voice:download', async (_e, id) => {
    if (!known(id)) return { ok: false, error: 'unknown' };
    try {
      await models.download(id, (p) => broadcast('voice:progress', p));
      broadcast('voice:models', publicSettings().models);
      return { ok: true, status: models.status(id) };
    } catch (e) {
      broadcast('voice:models', publicSettings().models);
      return { ok: false, error: e.message, code: e.code };
    }
  });
  handle('voice:cancel-download', (_e, id) => { if (known(id)) models.cancel(id); return true; });
  handle('voice:remove-model', (_e, id) => {
    if (!known(id)) return null;
    host.stop();
    const st = models.remove(id);
    broadcast('voice:models', publicSettings().models);
    return st;
  });
  on('voice:stop', () => stopSpeaking());
  on('voice:warm', (_e, what) => { if (what === 'asr' || what === 'tts') warm(what); });
  setTimeout(() => warm('tts'), 20000);
  on('voice:line', (_e, text) => { speak(text, { canned: true }); });
}

const isMuted = () => cfg.muted;
function setMuted(v) { cfg.muted = !!v; save(); if (v) stopSpeaking(); broadcast('voice:changed', publicSettings()); }
const autoSend = () => cfg.autoSend;

module.exports = { init, warm, speak, speakWith, splitForSpeech, stopSpeaking, isMuted, setMuted, autoSend, cleanForSpeech, forKokoro, transcribe, publicSettings, update };
