'use strict';
// Safe JSON files. A save goes to <file>.tmp first and is renamed over the old file, so a crash or power cut leaves
// either the old or the new version, never half of one. The last good version is kept as <file>.bak, and a file that
// can't be parsed is never overwritten: it is renamed to <file>.broken-<time> first (kept, never deleted).
// No electron here, so tests and other plain-Node code can load it.
const fs = require('fs');
const path = require('path');

// Windows: an antivirus scan or a sync client can hold the file for a moment
const RETRY = new Set(['EPERM', 'EBUSY', 'EACCES']);
const TRIES = 5;
const pause = (i) => 20 * (i + 1);
const sleepSync = (ms) => { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch (_) {} };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const p2 = (n) => String(n).padStart(2, '0');
// 20261103-213005, used in the names of broken copies
const fileStamp = (d = new Date()) => `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}`;
// Notepad on Windows may save with a BOM, which JSON.parse refuses
const parse = (text) => JSON.parse(String(text).replace(/^﻿/, ''));
// a temp name of our own: two writers (two saves here, or the pet and AstrBot on one computer) never share a .tmp
const tmpName = (file) => `${file}.${process.pid}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}.tmp`;
// V8 quotes a piece of the file in "Unexpected token" errors, which may be memory or chat text: keep only the position
function parseMessage(e) {
  const m = String((e && e.message) || '');
  const lc = /\(line (\d+) column (\d+)\)/.exec(m), pos = /at position (\d+)/.exec(m);
  return 'JSON 格式不对' + (lc ? `（第 ${lc[1]} 行第 ${lc[2]} 列附近）` : pos ? `（第 ${Number(pos[1]) + 1} 个字符附近）` : /end of JSON/i.test(m) ? '（文件不完整）' : '');
}
// files that existed but could not be read at load (locked by an antivirus or backup tool, no permission): the
// program runs on a fallback, so the real file must not simply be written over (see writeTextSync)
const unreadable = new Set();

function readTextSync(file) {
  for (let i = 0; ; i++) {
    try { return fs.readFileSync(file, 'utf8'); } catch (e) {
      if (!RETRY.has(e.code) || i >= TRIES) throw e;
      sleepSync(pause(i));
    }
  }
}

// move an unreadable file out of the way so nothing overwrites it; returns the new path ('' if it couldn't be moved).
// copy: leave the file where it is and only keep a copy
function keepBroken(file, { copy = false } = {}) {
  let to = `${file}.broken-${fileStamp()}`;
  for (let n = 2; fs.existsSync(to); n++) to = `${file}.broken-${fileStamp()}-${n}`;
  if (!copy) try { fs.renameSync(file, to); return to; } catch (_) {}
  try { fs.copyFileSync(file, to); return to; } catch (_) { return ''; }
}

function readBak(file) {
  try { return { ok: true, data: parse(fs.readFileSync(file + '.bak', 'utf8')) }; } catch (_) { return { ok: false }; }
}

// -> { data, status }: ok | missing | recovered (came from .bak) | broken (fallback used).
// recovered/broken results also carry non-enumerable extras: brokenPath (where the bad file was set aside, '' if it
// wasn't), keepFailed (it couldn't be set aside) and error (the file is there but couldn't be read).
function readJsonSync(file, fallback) {
  let text = null, readError = null;
  try { text = readTextSync(file); } catch (e) { if (e.code !== 'ENOENT') readError = e; }
  if (readError) unreadable.add(file); else unreadable.delete(file);
  if (text === null && !readError) {
    const bak = readBak(file);
    return bak.ok ? { data: bak.data, status: 'recovered' } : { data: fallback, status: 'missing' };
  }
  if (text !== null) {
    try { return { data: parse(text), status: 'ok' }; } catch (_) { /* fall through */ }
  }
  const brokenPath = text !== null ? keepBroken(file) : '';
  const bak = readBak(file);
  const out = bak.ok ? { data: bak.data, status: 'recovered' } : { data: fallback, status: 'broken' };
  Object.defineProperty(out, 'brokenPath', { value: brokenPath });
  if (text !== null && !brokenPath) Object.defineProperty(out, 'keepFailed', { value: true });
  if (readError) Object.defineProperty(out, 'error', { value: readError });
  return out;
}

// fsync is best effort: some virtual and network drives don't support it, and the rename still protects the file
function writeDurableSync(file, text) {
  const fd = fs.openSync(file, 'w');
  try { fs.writeFileSync(fd, text); try { fs.fsyncSync(fd); } catch (_) {} } finally { fs.closeSync(fd); }
}

// before replacing a file: one that couldn't be read at load is kept (a copy) or, while still locked, not written
// over; one that doesn't parse is set aside; a good one becomes the .bak
function guardOld(file, backup) {
  let text;
  try { text = readTextSync(file); } catch (e) {
    if (e.code === 'ENOENT') { unreadable.delete(file); return; }
    if (unreadable.has(file)) throw Object.assign(new Error(`${path.basename(file)} 还是读不出来（${e.code || e.message}），先不覆盖它`), { code: e.code || 'EUNREAD' });
    return;
  }
  if (unreadable.has(file)) {
    // it was locked when we loaded, so what we hold now isn't based on it: keep the real one next to it
    unreadable.delete(file);
    keepBroken(file, { copy: true });
    return;
  }
  let good = true;
  try { parse(text); } catch (_) { good = false; }
  if (!good) keepBroken(file, { copy: true });
  else if (backup) { try { fs.copyFileSync(file, file + '.bak'); } catch (_) {} }
}

function writeTextSync(file, text, { backup = true } = {}) {
  guardOld(file, backup);
  const tmp = tmpName(file);
  try { writeDurableSync(tmp, text); } catch (e) { try { fs.unlinkSync(tmp); } catch (_) {} throw e; }
  for (let i = 0; ; i++) {
    try { fs.renameSync(tmp, file); return; } catch (e) {
      if (!RETRY.has(e.code)) { try { fs.unlinkSync(tmp); } catch (_) {} throw e; }
      if (i >= TRIES) break;
      sleepSync(pause(i));
    }
  }
  // last resort: something keeps the old file open and won't let it be replaced, so write it in place
  fs.writeFileSync(file, text);
  try { fs.unlinkSync(tmp); } catch (_) {}
}

function writeJsonSync(file, data, opts = {}) {
  writeTextSync(file, JSON.stringify(data, null, 1), opts);
}

// ---- async, for the shared folder (no .bak there: every copy would be synced to the other computers too)

// resolves the parsed value; rejects with the original error (ENOENT stays ENOENT), parse errors get code EBROKEN
// and a message without the file's text (it may end up in error.log or a diagnostics report)
async function readJson(file) {
  const text = await fs.promises.readFile(file, 'utf8');
  try { return parse(text); } catch (e) { throw Object.assign(new Error(parseMessage(e)), { code: 'EBROKEN', path: file }); }
}

async function writeText(file, text) {
  const tmp = tmpName(file);
  try {
    const fh = await fs.promises.open(tmp, 'w');
    try { await fh.writeFile(text); try { await fh.sync(); } catch (_) {} } finally { await fh.close(); }
  } catch (e) { await fs.promises.unlink(tmp).catch(() => {}); throw e; }
  for (let i = 0; ; i++) {
    try { await fs.promises.rename(tmp, file); return; } catch (e) {
      if (!RETRY.has(e.code)) { await fs.promises.unlink(tmp).catch(() => {}); throw e; }
      if (i >= TRIES) break;
      await sleep(pause(i) * 2);
    }
  }
  await fs.promises.writeFile(file, text);
  await fs.promises.unlink(tmp).catch(() => {});
}

async function writeJson(file, data) {
  await writeText(file, JSON.stringify(data, null, 1));
}

// a readJsonSync result as a short note for the user ('' when the file was fine or simply not there yet);
// what names the file ("聊天记录文件"), fresh says what happens without it ("现在从空白开始")
function loadWarning(r, what, fresh) {
  if (!r || (r.status !== 'recovered' && r.status !== 'broken')) return '';
  const name = r.brokenPath ? path.basename(r.brokenPath) : '';
  const how = r.brokenPath ? '损坏了' : r.error ? `读不出来（${r.error.code || r.error.message}）` : r.keepFailed ? '损坏了（没能另存一份）' : r.status === 'recovered' ? '不见了' : '损坏了';
  if (r.status === 'recovered') return `${what}${how}，已经从备份恢复${name ? `（坏的那份另存为 ${name}）` : ''}`;
  return `${what}${how}，${name ? `已另存为 ${name}，` : ''}${fresh}`;
}

module.exports = { readJsonSync, writeJsonSync, readJson, writeJson, writeText, fileStamp, loadWarning, parseMessage };
