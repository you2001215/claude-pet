'use strict';
// Voice for the pet: she reads her replies aloud, and you can talk to her through the mic.
//   speaking: Edge neural voices (online) -> Kokoro (offline, optional download) -> system voice
//   listening: SenseVoice (offline, optional download)
const { app, ipcMain } = require('electron');
const fs = require('fs');
const path = require('path');
const edge = require('./edge-tts');
const models = require('./models');
const host = require('./engine-host');

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
  try { cfg = { ...DEFAULTS, ...JSON.parse(fs.readFileSync(cfgPath, 'utf8')) }; } catch (_) { cfg = { ...DEFAULTS }; }
}
function save() { try { fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 1)); } catch (_) {} }

function publicSettings() {
  return {
    ...cfg,
    edgeVoices: edge.VOICES,
    models: { asr: models.status('asr'), tts: models.status('tts') },
    lastError: { ...lastError },
  };
}
function update(s) {
  const n = { ...cfg };
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
  cfg = n;
  save();
  return publicSettings();
}

// ---------- text clean-up ----------
function cleanForSpeech(t) {
  let s = String(t || '');
  s = s.replace(/\[(?:sticker|表情)[:：][^\]\n]*\]/giu, '');
  s = s.replace(/<[^>]{1,80}>/g, '');
  s = s.replace(/[（(][^（）()\n]{0,16}[）)]/g, '');           // （歪头） stage directions and (≧▽≦) faces
  s = s.replace(/\*[^*\n]{1,16}\*/g, '');                      // *叉腰*
  s = s.replace(/https?:\/\/\S+/g, '这个链接');
  s = s.replace(/[\p{Extended_Pictographic}\u{1F1E6}-\u{1F1FF}\u{1F3FB}-\u{1F3FF}\uFE0F\u200D]/gu, '');
  s = s.replace(/[♪♫♬★☆♥♡❤✧✦✨・ω]+/g, '');
  s = s.replace(/[~～]{2,}/g, '～');
  s = s.replace(/\s+/g, ' ').trim();
  return Array.from(s).slice(0, 400).join('');
}
const speakable = (s) => /[\p{L}\p{N}]/u.test(s);
// split into pieces of at most ~max characters, preferring sentence ends, then commas
function splitForSpeech(s, max) {
  const sentences = s.match(/[^。！？!?；;\n]+[。！？!?；;\n]*|[。！？!?；;\n]+/g) || [s];
  const out = [];
  let cur = '';
  const push = (t) => { if (t.trim()) out.push(t.trim()); };
  for (let sen of sentences) {
    while (Array.from(sen).length > max) {
      const a = Array.from(sen);
      let cut = a.slice(0, max).join('').search(/[，,、：:][^，,、：:]*$/);
      cut = cut > max / 3 ? cut + 1 : max;
      push(cur); cur = '';
      push(a.slice(0, cut).join(''));
      sen = a.slice(cut).join('');
    }
    if (Array.from(cur + sen).length > max) { push(cur); cur = sen; } else cur += sen;
  }
  push(cur);
  return out.length ? out : [s];
}
function forKokoro(s) {
  return s
    .replace(/claude/gi, '克劳德')
    .replace(/deep\s?seek/gi, '迪普西克')
    .replace(/(\d{1,2})[:：](\d{2})/g, (_, h, m) => `${+h}点${m === '00' ? '' : (+m) + '分'}`)
    .replace(/[!！]+\s*(?=[A-Za-z])/g, '。')
    .replace(/～/g, '，');
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

async function speakWith(c, text, why) {
  const clean = cleanForSpeech(text);
  if (!speakable(clean)) return { ok: false, error: '没有可以念的文字' };
  stopSpeaking();
  const job = speakSeq;
  const errors = [];
  if (c.engine === 'kokoro' && !models.isInstalled('tts')) errors.push('离线语音模型还没下载，先用系统语音');
  for (const eng of engineOrder(c)) {
    if (job !== speakSeq) return { ok: false, error: 'interrupted' };
    try {
      if (eng === 'edge') {
        // long replies go in pieces: the first plays while the next one is being made
        const parts = splitForSpeech(clean, 90);
        const synth = (t) => edge.synthesize({ text: t, voice: c.edgeVoice, rate: c.rate, pitch: c.pitch, timeoutMs: 12000 });
        const first = await synth(parts[0]);
        if (job !== speakSeq) return { ok: false, error: 'interrupted' };
        toPet('voice:play', { job, kind: 'mp3', data: first, volume: c.volume });
        lastError.edge = '';
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
function init(opts) {
  toPet = opts.toPet; broadcast = opts.broadcast; logError = opts.logError || logError;
  load();
  ipcMain.handle('voice:get', () => publicSettings());
  ipcMain.handle('voice:set', (_e, s) => update(s || {}));
  ipcMain.handle('voice:test', (_e, s, text) => speakWith({ ...cfg, ...(s || {}) }, text || '你好呀，我是大肥鱼！今天也要好好吃饭哦。', 'test').catch((e) => ({ ok: false, error: e.message })));
  ipcMain.handle('voice:transcribe', (_e, buf, rate) => transcribe(buf, rate));
  ipcMain.handle('voice:download', async (_e, id) => {
    if (!models.CATALOG[id]) return { ok: false, error: 'unknown' };
    try {
      await models.download(id, (p) => broadcast('voice:progress', p));
      broadcast('voice:models', publicSettings().models);
      return { ok: true, status: models.status(id) };
    } catch (e) {
      broadcast('voice:models', publicSettings().models);
      return { ok: false, error: e.message, code: e.code };
    }
  });
  ipcMain.handle('voice:cancel-download', (_e, id) => { models.cancel(id); return true; });
  ipcMain.handle('voice:remove-model', (_e, id) => {
    if (!models.CATALOG[id]) return null;
    host.stop();
    const st = models.remove(id);
    broadcast('voice:models', publicSettings().models);
    return st;
  });
  ipcMain.on('voice:stop', () => stopSpeaking());
  ipcMain.on('voice:warm', (_e, what) => { if (what === 'asr' || what === 'tts') warm(what); });
  setTimeout(() => warm('tts'), 20000);
  ipcMain.on('voice:line', (_e, text) => { speak(text, { canned: true }); });
}

const isMuted = () => cfg.muted;
function setMuted(v) { cfg.muted = !!v; save(); if (v) stopSpeaking(); broadcast('voice:changed', publicSettings()); }
const autoSend = () => cfg.autoSend;

module.exports = { init, warm, speak, speakWith, splitForSpeech, stopSpeaking, isMuted, setMuted, autoSend, cleanForSpeech, forKokoro, transcribe, publicSettings, update };
