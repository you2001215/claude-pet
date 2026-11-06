'use strict';
// The desktop link to AstrBot, as the rest of the pet sees it: settings, the device token (encrypted like the
// API key), the offline snapshot, received images, and one LinkClient. Off until the user turns it on and pairs.
// electron's safeStorage is passed in, so this file loads in plain Node too (tests).
//
// Files in the user-data folder (never in the shared folder, never in a diagnostics report):
//   link.json          on/off, address, device name, device id, the token (encrypted)
//   link-state.json    outbox, offline items, ids seen, sleep/meal counts (link/client.js)
//   link-snapshot.json the latest snapshot from her, for when she's not there (only the newest one is kept)
//   link-media/        images she sent, named by sha256
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const store = require('../store');
const P = require('./protocol');
const { LinkClient } = require('./client');

const MEDIA_MAX = 700 * 1024;
const MEDIA_KEEP = 300;
const MIME_EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };
const MEDIA_RE = /^[0-9a-f]{64}\.(png|jpg|gif|webp)$/;

let dir = '', safe = null, log = () => {}, appVersion = '', hooks = {};
let cfg = { enabled: false, url: P.DEFAULT_URL, deviceName: '', deviceId: '', token: null, pairedAt: 0 };
let client = null, snapshot = null;

const file = (n) => path.join(dir, n);
const defaultName = () => String(os.hostname() || '这台电脑').replace(/\.local$/i, '').slice(0, 32);

function saveCfg() {
  try { store.writeJsonSync(file('link.json'), cfg); } catch (e) { log(`保存连接设置失败：${e.code || e.message}`); }
}

// the token can do whatever the owner can do on her bot: kept encrypted, in this process only
function setToken(t, deviceId) {
  if (!t) { cfg.token = null; cfg.deviceId = ''; cfg.pairedAt = 0; saveCfg(); return; }
  cfg.token = safe && safe.isEncryptionAvailable()
    ? { blob: safe.encryptString(t).toString('base64'), plain: false }
    : { blob: Buffer.from(t, 'utf8').toString('base64'), plain: true };
  cfg.deviceId = String(deviceId || '');
  cfg.pairedAt = Date.now();
  saveCfg();
}
function getToken() {
  if (!cfg.token || !cfg.token.blob) return '';
  try {
    const buf = Buffer.from(cfg.token.blob, 'base64');
    return cfg.token.plain ? buf.toString('utf8') : safe.decryptString(buf);
  } catch (_) { return ''; }
}

function hello() {
  let tz = '';
  try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch (_) {}
  return { app_version: appVersion, platform: process.platform, device_name: (cfg.deviceName || defaultName()).slice(0, 32), tz, tz_offset_min: -new Date().getTimezoneOffset() };
}

function makeClient() {
  if (client) { client.stop(); client.removeAllListeners(); }
  client = new LinkClient({
    url: cfg.url, hello: hello(), getToken, setToken, statePath: file('link-state.json'),
    log: (m) => log(m), timers: hooks.timers,
    onSay: (d, f) => (hooks.onSay ? hooks.onSay(d, f) : { ok: true }),
    onSnapshot: (d) => saveSnapshot(d),
  });
  client.on('status', (s, detail) => { if (hooks.onStatus) hooks.onStatus(s, detail); });
  client.on('late', (d) => { if (hooks.onLate) hooks.onLate(d); });
}

// o: { userData, safeStorage, appVersion, log, onSay(data) -> { ok, code }, onStatus(status), onLate(chatDone), timers }
function init(o) {
  dir = o.userData; safe = o.safeStorage || null; appVersion = o.appVersion || ''; log = o.log || log;
  hooks = { onSay: o.onSay, onStatus: o.onStatus, onLate: o.onLate, timers: o.timers };
  const r = store.readJsonSync(file('link.json'), null);
  if (r && r.data && typeof r.data === 'object') cfg = { ...cfg, ...r.data };
  if (!P.urlOk(cfg.url)) cfg.url = P.DEFAULT_URL;
  const s = store.readJsonSync(file('link-snapshot.json'), null);
  snapshot = s && s.data && typeof s.data === 'object' ? s.data : null;
  makeClient();
  if (cfg.enabled) client.start();
}

const paired = () => !!(cfg.token && cfg.token.blob);
const online = () => !!(cfg.enabled && client && client.online);
// on and paired but she can't be reached right now: the pet talks with its own brain and keeps notes for her
const away = () => !!(cfg.enabled && paired() && client && !client.online);
// on and paired, reachable or not: what the pet says and does is kept for her
const linked = () => !!(cfg.enabled && paired());

// the snapshot as a block of the pet's own system prompt, only while she can't be reached
const p2 = (n) => String(n).padStart(2, '0');
function when(t) {
  const d = new Date(Number(t) || 0), today = new Date().toDateString() === d.toDateString();
  return `${today ? '' : `${d.getMonth() + 1}-${d.getDate()} `}${p2(d.getHours())}:${p2(d.getMinutes())}`;
}
function offlinePrompt() {
  if (!away() || !snapshot) return '';
  const cut = (x, n) => String(x || '').slice(0, n);
  const list = (a, n) => (Array.isArray(a) ? a.slice(-n) : []);
  const out = [`（阿鲸那边现在连不上，你在用备份记忆和用户说话，备份是 ${when(snapshot.made_at)} 的。想不起来的事就照实说想不起来，别编。）`];
  if (snapshot.profile) out.push('关于用户：\n' + cut(snapshot.profile, 2000));
  if (snapshot.impression) out.push('你对用户的印象：\n' + cut(snapshot.impression, 1500));
  const diary = list(snapshot.diary, 7), weekly = list(snapshot.weekly, 3), hobbies = list(snapshot.hobbies, 8), recent = list(snapshot.recent, 60);
  if (diary.length) out.push('最近的日记：\n' + diary.map((d) => `${cut(d.date, 10)}：${cut(d.text, 600)}`).join('\n'));
  if (weekly.length) out.push('周记：\n' + weekly.map((w) => `${cut(w.week, 10)}：${cut(w.text, 900)}`).join('\n'));
  if (hobbies.length) out.push('你在追的东西：\n' + hobbies.map((h) => `${cut(h.name, 30)}：${cut(h.text, 400)}`).join('\n'));
  if (snapshot.mood && snapshot.mood.name) out.push(`你这一阵的心情：${cut(snapshot.mood.name, 4)}${snapshot.mood.line ? '，' + cut(snapshot.mood.line, 100) : ''}`);
  if (recent.length) {
    const who = (r) => (r.who === 'user' ? '用户' : r.who === 'pet' ? '桌宠' : '你');
    out.push('最近 24 小时说过的话：\n' + recent.map((r) => `[${when(r.ts)} ${r.side === 'qq' ? '聊天软件里' : '桌面上'} ${who(r)}] ${cut(r.text, 100)}`).join('\n'));
  }
  return out.join('\n\n').slice(0, 14000);
}

function getConfig() {
  return {
    enabled: !!cfg.enabled, url: cfg.url, defaultUrl: P.DEFAULT_URL, deviceName: cfg.deviceName, defaultName: defaultName(),
    paired: paired(), deviceTail: cfg.deviceId ? cfg.deviceId.slice(-4) : '', pairedAt: cfg.pairedAt || 0,
    status: client ? client.status : 'off', detail: client ? client.detail : '', snapshotAt: snapshot ? snapshot.made_at || 0 : 0,
    plainToken: !!(cfg.token && cfg.token.plain),
  };
}

function setConfig(s = {}) {
  if (s.url !== undefined) {
    const url = String(s.url || '').trim() || P.DEFAULT_URL;
    if (!P.urlOk(url)) return { ok: false, error: '地址要用 ws:// 开头（只能是这台电脑、局域网或组网工具的地址），其他地址要用 wss://' };
    cfg.url = url;
  }
  if (s.deviceName !== undefined) cfg.deviceName = String(s.deviceName || '').trim().slice(0, 32);
  if (s.enabled !== undefined) cfg.enabled = !!s.enabled;
  saveCfg();
  makeClient();
  if (cfg.enabled) client.start();
  return { ok: true, config: getConfig() };
}

const PAIR_ERRORS = {
  bad_code: '配对码是 6 位数字',
  pair_code_invalid: '配对码不对，或者已经过期、用过了。在 QQ 私聊里给阿鲸再发一次「/桌宠配对」，5 分钟内填进来',
  rate_limited: '试得太多了，等一分钟再试',
  proto_unsupported: '桌宠和阿鲸那边的版本对不上，需要更新',
  unreachable: '连不上阿鲸：确认 AstrBot 开着、地址没填错',
  stopped: '已经停下了',
};
async function pair(code) {
  if (!cfg.enabled) { cfg.enabled = true; saveCfg(); }
  try {
    await client.pair(code);
    return { ok: true, config: getConfig() };
  } catch (e) {
    return { ok: false, error: PAIR_ERRORS[e.code] || '配对没成功', code: e.code || '' };
  }
}
function unpair() {
  setToken(null);
  makeClient();
  if (cfg.enabled) client.start();
  return { ok: true, config: getConfig() };
}

// ---- snapshot: only the newest, only on this computer
function saveSnapshot(d) {
  const keep = {
    made_at: Number(d.made_at) || Date.now(), profile: String(d.profile || ''), impression: String(d.impression || ''),
    diary: Array.isArray(d.diary) ? d.diary : [], weekly: Array.isArray(d.weekly) ? d.weekly : [],
    hobbies: Array.isArray(d.hobbies) ? d.hobbies : [], mood: d.mood && typeof d.mood === 'object' ? d.mood : null,
    recent: Array.isArray(d.recent) ? d.recent : [],
  };
  store.writeJsonSync(file('link-snapshot.json'), keep);   // throws on failure: no ack, she sends it again
  snapshot = keep;
}
const getSnapshot = () => snapshot;

// ---- images she sends: checked against their sha256, kept by it, served as app://pet/linkmedia/<name>
function saveImage(img) {
  if (!img || typeof img.data !== 'string') return null;
  const ext = MIME_EXT[String(img.mime || '').toLowerCase()];
  if (!ext) return null;
  let buf;
  try { buf = Buffer.from(img.data, 'base64'); } catch (_) { return null; }
  if (!buf.length || buf.length > MEDIA_MAX) return null;
  const sha = crypto.createHash('sha256').update(buf).digest('hex');
  if (String(img.sha256 || '').toLowerCase() !== sha) { log('图片校验值对不上，丢掉了'); return null; }
  const name = `${sha}.${ext}`;
  const md = file('link-media');
  try {
    fs.mkdirSync(md, { recursive: true });
    const p = path.join(md, name);
    if (!fs.existsSync(p)) { fs.writeFileSync(p, buf); pruneMedia(md); }
  } catch (e) { log(`保存图片失败：${e.code || e.message}`); return null; }
  return { id: 'link-' + sha.slice(0, 12), url: 'app://pet/linkmedia/' + name, alt: '阿鲸发的图' };
}
function pruneMedia(md) {
  try {
    const all = fs.readdirSync(md).filter((n) => MEDIA_RE.test(n)).map((n) => ({ n, t: fs.statSync(path.join(md, n)).mtimeMs })).sort((a, b) => b.t - a.t);
    for (const x of all.slice(MEDIA_KEEP)) fs.unlinkSync(path.join(md, x.n));
  } catch (_) {}
}
// for the app:// handler: the file for a name we made, or '' for anything else
const mediaPath = (name) => (MEDIA_RE.test(String(name)) ? path.join(dir, 'link-media', name) : '');

// a reply's parts -> { text, stickers } in the shape the pet already uses for stickers
function toReply(parts) {
  const { text, images } = P.splitParts(parts);
  return { text, stickers: images.map(saveImage).filter(Boolean) };
}

function diagnostics() {
  const c = getConfig(), i = client ? client.info() : {};
  return {
    开着: c.enabled, 已配对: c.paired, 状态: c.status + (c.detail ? `（${c.detail}）` : ''), 默认地址: c.url === P.DEFAULT_URL,
    待发: i.outbox || 0, 待补交: i.offline || 0, 丢弃: i.dropped || 0, 看不懂的帧: i.bad || 0, 不认识的类型: i.unknown || 0,
    有快照: !!snapshot, 令牌没加密: c.plainToken,
  };
}

module.exports = {
  init, getConfig, setConfig, pair, unpair, paired, online, away, linked, offlinePrompt, getSnapshot, toReply, mediaPath, diagnostics,
  chat: (text, input) => client.chat(text, input),
  offline: (items) => { if (linked() && client) client.offline(items); },
  careAllowed: (kind, slot) => !!client && client.careAllowed(kind, slot),
  care: (kind, slot, action) => { if (linked() && client) client.care(kind, slot, action); },
  stop: () => { if (client) client.stop(); },
};
