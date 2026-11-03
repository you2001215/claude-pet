'use strict';
// Timed reminders the user explicitly asks for ("17点提醒我开会").
// electron is only loaded inside init() (to find the data folder), so tests can require this file from plain Node.
const path = require('path');
const store = require('./store');

let file;
let list = [];   // { id, at, text, created, done }
let warning = '';
let logger = null;
const early = [];   // messages logged before setLogger was called
const log = (msg) => { if (logger) { try { logger('reminders', msg); } catch (_) {} } else early.push(msg); };
function setLogger(fn) { logger = typeof fn === 'function' ? fn : null; if (logger) early.splice(0).forEach(log); }

function init(dir) {
  file = path.join(dir || require('electron').app.getPath('userData'), 'reminders.json');
  const r = store.readJsonSync(file, []);
  list = (Array.isArray(r.data) ? r.data : []).filter((x) => x && typeof x === 'object' && Number.isFinite(x.at));
  for (const x of list) x.text = String(x.text == null ? '' : x.text);
  warning = store.loadWarning(r, '提醒文件', '之前设的提醒没有了，要重新设一下');
  if (warning) log(warning);
}
function save() {
  // keep pending ones plus the last few finished
  const pending = list.filter((r) => !r.done);
  const done = list.filter((r) => r.done).slice(-20);
  list = [...done, ...pending];
  if (!file) return;   // init() not called (tests): memory only
  try { store.writeJsonSync(file, list); } catch (e) { log('保存提醒失败：' + e.message); }
}

// "2026-10-25 17:00" (local time) -> ms
function parseLocal(s) {
  const m = String(s).trim().match(/^(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})日?[ T]+(\d{1,2})[:：](\d{2})(?:[:：](\d{2}))?$/);
  if (!m) return NaN;
  const [, y, mo, d, h, mi, se] = m.map((x) => (x === undefined ? undefined : Number(x)));
  const dt = new Date(y, mo - 1, d, h, mi, se || 0, 0);
  return dt.getTime();
}

const fmt = (ms) => {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const day = new Date(ms); day.setHours(0, 0, 0, 0);
  const diff = Math.round((day - today) / 86400000);
  const prefix = diff === 0 ? '今天' : diff === 1 ? '明天' : diff === 2 ? '后天' : `${d.getMonth() + 1}月${d.getDate()}日`;
  return `${prefix} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

function add(at, text) {
  const t = parseLocal(at);
  if (!Number.isFinite(t)) return { ok: false, error: `看不懂的时间：${at}` };
  if (t < Date.now() - 2 * 60000) return { ok: false, error: `这个时间已经过去了：${fmt(t)}` };
  if (t > Date.now() + 366 * 86400000) return { ok: false, error: '太远了，一年以内的提醒才行' };
  const r = { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), at: t, text: String(text || '').trim().slice(0, 200) || '到时间啦', created: Date.now(), done: false };
  list.push(r);
  save();
  return { ok: true, reminder: r, label: `${fmt(t)} ${r.text}` };
}

// does a cancel keyword hit this reminder? The other way round (the reminder's text inside the keyword, "开会提醒" for
// "开会") counts for texts of 2+ characters, so a one-character reminder like "水" isn't hit by every keyword that
// happens to contain it. Filler words the model adds to a keyword ("的提醒", "那个") are tried without as well.
const FILLER = /(?:的?提醒(?:我)?|那个|这个|一下|我的|我)/g;
function matches(keyword, text) {
  const k = String(keyword || '').trim(), t = String(text || '').trim();
  if (!k || !t) return false;
  if (t.includes(k) || (Array.from(t).length >= 2 && k.includes(t))) return true;
  const bare = k.replace(FILLER, '').trim();
  return !!bare && bare !== k && Array.from(bare).length >= 2 && t.includes(bare);
}

function cancel(keyword) {
  const k = String(keyword || '').trim();
  const pending = list.filter((r) => !r.done);
  const hit = /^(全部|所有|all)$/i.test(k) ? pending : pending.filter((r) => matches(k, r.text));
  for (const r of hit) r.done = true;
  if (hit.length) save();
  return hit.map((r) => `${fmt(r.at)} ${r.text}`);
}

function remove(id) {
  const r = list.find((x) => x.id === id);
  if (r) { r.done = true; save(); }
  return !!r;
}

function pending() {
  return list.filter((r) => !r.done).sort((a, b) => a.at - b.at).map((r) => ({ ...r, label: fmt(r.at) }));
}

// reminders that are due now; anything more than a day late is dropped quietly
function takeDue(now = Date.now()) {
  const due = [];
  for (const r of list) {
    if (r.done || r.at > now) continue;
    r.done = true;
    if (now - r.at <= 24 * 3600000) due.push({ ...r, lateMin: Math.max(0, Math.round((now - r.at) / 60000)) });
  }
  if (due.length) save();
  return due;
}

// a short line for the model so it knows what is already scheduled
function contextLine() {
  const p = pending().slice(0, 8);
  return p.length ? '已设的提醒：' + p.map((r) => `${r.label} ${r.text}`).join('；') : '';
}

module.exports = { init, add, cancel, remove, pending, takeDue, contextLine, fmt, parseLocal, matches, setLogger, warning: () => warning };
