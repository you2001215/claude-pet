'use strict';
// Timed reminders the user explicitly asks for ("17点提醒我开会").
const { app } = require('electron');
const fs = require('fs');
const path = require('path');

let file;
let list = [];   // { id, at, text, created, done }

function init() {
  file = path.join(app.getPath('userData'), 'reminders.json');
  try { list = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { list = []; }
  if (!Array.isArray(list)) list = [];
}
function save() {
  // keep pending ones plus the last few finished
  const pending = list.filter((r) => !r.done);
  const done = list.filter((r) => r.done).slice(-20);
  list = [...done, ...pending];
  fs.writeFileSync(file, JSON.stringify(list, null, 1));
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

function cancel(keyword) {
  const k = String(keyword || '').trim();
  const pending = list.filter((r) => !r.done);
  const hit = /^(全部|所有|all)$/i.test(k) ? pending : pending.filter((r) => k && (r.text.includes(k) || k.includes(r.text)));
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

module.exports = { init, add, cancel, remove, pending, takeDue, contextLine, fmt };
