'use strict';
// 大肥鱼 sticker support, based on the data and conventions of
// https://github.com/Loping151/dsh-nekowhale-stickers (knowledge data CC BY-NC 4.0).
// Sticker artwork by 可以叫我云大人 / 雾雪 (https://space.bilibili.com/103739, https://kiriyuki.com);
// the GIFs are fetched from kiriyuki.com at runtime and cached locally, never bundled.
const { app, net } = require('electron');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SITE = process.env.PET_STICKER_SITE || 'https://kiriyuki.com';
const UA = 'nekowhale-stickers (+https://kiriyuki.com)';
const MARK = /\[(?:sticker|表情)[:：]\s*([^\]\n]{1,40})\]/giu;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let lastError = null;
let meta = null;          // bundled knowledge file
let memes = [];           // 大肥鱼 meme pictures bundled from dsh-pet: [{ name, desc }]
let manifest = null;      // site manifest (file names + hashes)
let manifestTried = 0;
let dir;

function init() {
  dir = path.join(app.getPath('userData'), 'stickers');
  fs.mkdirSync(path.join(dir, 'gif'), { recursive: true });
  try { meta = JSON.parse(fs.readFileSync(path.join(__dirname, 'assets', 'stickers', 'nekowhale.json'), 'utf8')); } catch (_) { meta = { stickers: [], emotions: [] }; }
  try { manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')); } catch (_) {}
  try { memes = JSON.parse(fs.readFileSync(path.join(__dirname, 'assets', 'memes', 'memes.json'), 'utf8')).memes || []; } catch (_) { memes = []; }
}
const squash = (x) => String(x).replace(/[\s，,。.!！?？～~]/g, '').toLowerCase();
function pickMeme(ref) {
  const r = squash(ref);
  if (!r) return null;
  const hit = memes.find((m) => squash(m.name) === r)
    || (r.length >= 3 ? memes.find((m) => squash(m.name).includes(r) || r.includes(squash(m.name))) : null);
  return hit ? { id: 'meme/' + hit.name, meme: true } : null;
}

const attribution = () => (meta && meta.attribution) || { text: '表情包作者：B站 可以叫我云大人（space.bilibili.com/103739），kiriyuki.com 制作' };

function emotions() {
  return (meta.emotions || []).filter((e) => e !== '其他');
}

function pool(packs) {
  const want = new Set(packs && packs.length ? packs : ['大肥鱼']);
  return meta.stickers.filter((s) => want.has(s.id.split('/')[0]));
}

// REF is a sticker name, an emotion word, or a scene word; emotion/scene picks one at random
function pick(ref, packs) {
  const r = String(ref).trim().replace(/\.(gif|png|webp)$/i, '');
  if (packs && packs.includes('meme')) { const m = pickMeme(r); if (m) return m; }
  const all = pool(packs);
  if (!r || !all.length) return null;
  const stem = (s) => s.id.split('/').slice(1).join('/');
  const name = (s) => stem(s).replace(/^[0-9A-Za-z]+_/, '');
  const exact = all.filter((s) => s.id === r || stem(s) === r || name(s) === r);
  if (exact.length) return exact[0];
  const words = r.split(/[\s,，、/]+/).filter(Boolean);
  let best = [], bestScore = 0;
  for (const s of all) {
    let score = 0;
    for (const w of words) {
      if (s.emotion === w) score += 3;
      if ((s.tags || []).includes(w)) score += 2;
      else if ((s.tags || []).some((t) => t.includes(w) || w.includes(t))) score += 1;
      if (name(s).includes(w)) score += 2;
    }
    if (score > bestScore) { best = [s]; bestScore = score; }
    else if (score === bestScore && score > 0) best.push(s);
  }
  return best.length ? best[Math.floor(Math.random() * best.length)] : null;
}

// split a reply into clean text + stickers
function parseReply(text, packs) {
  const found = [];
  const clean = text.replace(MARK, (_m, ref) => {
    const s = pick(ref, packs);
    if (s && found.length < 2) found.push(s);
    return '';
  }).replace(/[ \t]+\n/g, '\n').trim();
  return { text: clean, stickers: found.map(toRef) };
}

function toRef(s) {
  if (s.meme) {
    const name = s.id.slice('meme/'.length);
    return { id: s.id, url: 'app://pet/assets/memes/' + encodeURIComponent(name) + '.webp', alt: name };
  }
  return {
    id: s.id,
    url: 'app://pet/sticker/' + encodeURIComponent(s.id) + '.gif',
    remote: gifUrlFor(s.id).url,      // fallback: let the window load it straight from the site
    alt: s.id.split('/').pop().replace(/^[0-9A-Za-z]+_/, ''),
  };
}

// Download with several strategies: Node's fetch with the plugin's UA (exactly what the dsh plugin does),
// then Chromium's network stack with its normal browser UA, then Chromium with the plugin UA.
async function download(url) {
  const errors = [];
  const ways = [
    ['node', () => fetch(url, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(30000) })],
    ['chromium', () => net.fetch(url)],
    ['chromium+ua', () => net.fetch(url, { headers: { 'user-agent': UA } })],
  ];
  for (const [name, go] of ways) {
    for (let i = 0; i < 3; i++) {
      try {
        const r = await go();
        if (r.ok) return Buffer.from(await r.arrayBuffer());
        errors.push(`${name}: HTTP ${r.status}`);
        if (r.status !== 429 && r.status !== 570 && r.status < 500) break;
        await sleep(1000 * (i + 1));
      } catch (e) {
        errors.push(`${name}: ${(e && (e.cause && e.cause.code || e.message)) || e}`);
        break;
      }
    }
  }
  throw new Error(errors.join('；'));
}

function logError(id, e) {
  lastError = { time: new Date().toISOString(), id, message: String(e && e.message || e) };
  try {
    const f = path.join(dir, 'error.log');
    let old = '';
    try { old = fs.readFileSync(f, 'utf8').split('\n').slice(-50).join('\n'); } catch (_) {}
    fs.writeFileSync(f, old + `${lastError.time} ${id} ${lastError.message}\n`);
  } catch (_) {}
}

// hide a half-written mark while the reply is streaming
function hidePartial(text) {
  return text.replace(MARK, '').replace(/\[(?:s(?:t(?:i(?:c(?:k(?:e(?:r(?:[:：][^\]\n]*)?)?)?)?)?)?)?|表(?:情(?:[:：][^\]\n]*)?)?)$/u, '');
}

async function fetchJson(url) {
  return JSON.parse((await download(url)).toString('utf8'));
}

async function ensureManifest() {
  if (manifest || Date.now() - manifestTried < 10 * 60 * 1000) return manifest;
  manifestTried = Date.now();
  for (const src of ['/api/kit/nekowhale', '/api/manifest']) {
    try {
      const m = await fetchJson(SITE + src);
      if (m && Array.isArray(m.items)) {
        manifest = m;
        fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(m));
        return manifest;
      }
    } catch (e) { logError('manifest' + src, e); }
  }
  return manifest;
}

function gifUrlFor(id) {
  const pack = id.split('/')[0];
  const stem = id.split('/').slice(1).join('/');
  const it = manifest && manifest.items.find((x) => x.id === id || (x.pack === pack && (x.stem === stem || x.file === stem + '.gif')));
  const m = meta.stickers.find((s) => s.id === id);
  const hash = (it && it.hash) || (m && m.hash) || '';
  const base = (manifest && manifest.gif_base) || '/media/gif';
  const file = (it && it.file) || stem + '.gif';
  return { url: `${SITE}${base}/${encodeURIComponent(pack)}/${encodeURIComponent(file)}${hash ? '?h=' + hash : ''}`, hash };
}

const inflight = new Map();
// returns a local file path for the sticker GIF (downloading once, then cached)
async function file(id) {
  const key = crypto.createHash('sha1').update(id).digest('hex').slice(0, 16);
  const local = path.join(dir, 'gif', key + '.gif');
  if (fs.existsSync(local)) return local;
  if (inflight.has(id)) return inflight.get(id);
  const job = (async () => {
    await ensureManifest();
    const { url } = gifUrlFor(id);
    let buf;
    try { buf = await download(url); } catch (e) { logError(id, e); throw e; }
    if (buf.length < 6 || buf.slice(0, 3).toString('ascii') !== 'GIF') { const e = new Error('不是 GIF（可能被网站拦截了）'); logError(id, e); throw e; }
    fs.writeFileSync(local + '.tmp', buf);
    fs.renameSync(local + '.tmp', local);
    lastError = null;
    return local;
  })().finally(() => inflight.delete(id));
  inflight.set(id, job);
  return job;
}

function promptHint(freq, withMemes) {
  const em = emotions().join('、');
  const how = freq === 'often' ? '大概每两三句发一次' : '偶尔发，大概四五句发一次，别每句都发';
  let t = `你可以发表情包：在回复最后单独写 [sticker:词]，词用一个情绪词（${em}），也可以再加一个场景词，比如 [sticker:开心 早安]。${how}；一次最多一个。`;
  if (withMemes && memes.length) {
    t += '\n还有一套你自己的梗图，特别贴合语境时可以用原名发，比如 [sticker:吃白饭的大肥鱼]：\n' + memes.map((m) => `- ${m.name}：${m.desc}`).join('\n');
  }
  return t;
}

// settings page: try one sticker end to end and report what happened
async function selfTest() {
  const s = pool(['大肥鱼'])[0];
  if (!s) return { ok: false, error: '表情数据没有加载' };
  const key = crypto.createHash('sha1').update(s.id).digest('hex').slice(0, 16);
  try { fs.unlinkSync(path.join(dir, 'gif', key + '.gif')); } catch (_) {}
  manifestTried = 0;
  const t0 = Date.now();
  try {
    const f = await file(s.id);
    return { ok: true, ms: Date.now() - t0, bytes: fs.statSync(f).size, manifest: !!manifest, sticker: toRef(s) };
  } catch (e) {
    return { ok: false, error: String(e.message || e), manifest: !!manifest, url: gifUrlFor(s.id).url };
  }
}
function status() {
  let cached = 0;
  try { cached = fs.readdirSync(path.join(dir, 'gif')).filter((f) => f.endsWith('.gif')).length; } catch (_) {}
  return { cached, manifest: !!manifest, lastError };
}

module.exports = { init, selfTest, status, parseReply, hidePartial, promptHint, file, attribution, pick: (r, p) => { const s = pick(r, p); return s ? toRef(s) : null; } };
