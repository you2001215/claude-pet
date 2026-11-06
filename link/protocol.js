'use strict';
// The desktop link to AstrBot (「阿鲸」): message format shared by the client and the tests.
// Spec: docs/桌面连接接口说明.md (v1.0). No electron here.
const crypto = require('crypto');

const PROTO = 1;
const DEFAULT_URL = 'ws://127.0.0.1:6230/desktop/v1';
const ID_MAX = 64;

// close codes that mean "don't try again on your own" (spec 12.1)
const CLOSE = {
  BAD_FRAME: 4400, TOKEN_INVALID: 4401, PAIR_CODE_INVALID: 4403, TIMEOUT: 4408,
  REPLACED: 4409, PROTO_UNSUPPORTED: 4426, RATE_LIMITED: 4429, SERVER_ERROR: 4500,
};
const NO_RECONNECT = new Set([CLOSE.TOKEN_INVALID, CLOSE.PAIR_CODE_INVALID, CLOSE.REPLACED, CLOSE.PROTO_UNSUPPORTED]);

// ids: a prefix, the time and some randomness; sortable enough to read in a log, never longer than ID_MAX
const newId = (prefix = 'x') => `${prefix}_${Date.now().toString(36)}${crypto.randomBytes(6).toString('hex')}`.slice(0, ID_MAX);

const frame = (type, data = {}, id = newId(type[0])) => ({ v: PROTO, type, id, ts: Date.now(), data });

// -> the parsed frame, or null when it isn't one of ours (the caller counts those, never logs the text)
function parse(text) {
  let f;
  try { f = JSON.parse(String(text)); } catch (_) { return null; }
  if (!f || typeof f !== 'object' || Array.isArray(f)) return null;
  if (f.v !== PROTO || typeof f.type !== 'string' || typeof f.id !== 'string' || !f.id || f.id.length > ID_MAX) return null;
  if (f.data == null) f.data = {};
  if (typeof f.data !== 'object' || Array.isArray(f.data)) return null;
  return f;
}

// ws:// only to this computer, the local network or a Tailscale-style address; anything else must be wss://
const PRIVATE4 = /^(127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/;
function urlOk(s) {
  let u;
  try { u = new URL(String(s)); } catch (_) { return false; }
  if (u.username || u.password) return false;           // a token never goes in the address
  if (u.protocol === 'wss:') return !!u.hostname;
  if (u.protocol !== 'ws:') return false;
  const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  return host === 'localhost' || host === '::1' || PRIVATE4.test(host) || /^f[cd][0-9a-f]{2}:/.test(host);
}

// days start at 4 am (spec 10): 00:30 on the 7th still belongs to the night of the 6th
const p2 = (n) => String(n).padStart(2, '0');
function careDay(t = Date.now()) {
  const d = new Date(t - 4 * 3600000);
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
}
// the slot a care question at time t belongs to, or '' outside the hours she may ask in
function careSlot(kind, t = Date.now()) {
  const d = new Date(t), m = d.getHours() * 60 + d.getMinutes();
  if (kind === 'sleep') return m >= 30 && m < 240 ? `${careDay(t)}/night` : '';
  if (kind === 'meal') {
    if (m >= 11 * 60 && m < 14 * 60) return `${careDay(t)}/lunch`;
    if (m >= 17 * 60 && m < 20 * 60) return `${careDay(t)}/dinner`;
  }
  return '';
}
const CARE_LIMIT = { sleep: 2, meal: 1 };

// a reply's parts -> { text, images } (images: [{ mime, sha256, size, data }]); anything else is dropped
function splitParts(parts) {
  const text = [], images = [];
  for (const p of Array.isArray(parts) ? parts : []) {
    if (p && typeof p.text === 'string' && p.text.trim()) text.push(p.text.trim());
    else if (p && p.image && typeof p.image === 'object') images.push(p.image);
  }
  return { text: text.join('\n'), images };
}

const EMOTIONS = ['开心', '得意', '上头', '平静', '无聊', '烦', '委屈', '担心'];
const emotionOf = (e) => (e && EMOTIONS.includes(e.name) ? { name: e.name, level: Math.min(3, Math.max(1, Number(e.level) || 1)) } : null);

module.exports = { PROTO, DEFAULT_URL, CLOSE, NO_RECONNECT, newId, frame, parse, urlOk, careDay, careSlot, CARE_LIMIT, splitParts, EMOTIONS, emotionOf };
