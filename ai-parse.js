'use strict';
// The control tags in an AI reply: <memory>, <remind at="...">, <remind-cancel>, plus <think> from reasoning models.
// visible() hides them from the user, parseControl() reads them out, with limits so one reply can't flood the
// memory or the reminders, and a cancel only counts when the user actually asked for one.
// No electron here, so tests can load it.

const LIMITS = Object.freeze({ memories: 3, memoryChars: 100, reminders: 3, cancels: 3 });

const THINK = /<think\b[^>]*>[\s\S]*?<\/think\s*>/gi;
const THINK_CLOSE = /<\/think\s*>/gi;
const MEMORY = /<memory\b[^>]*>([\s\S]*?)<\/memory\s*>/gi;
const CANCEL = /<remind-cancel\b[^>]*>([\s\S]*?)<\/remind-cancel\s*>/gi;
const Q = '"\'“”‘’＂＇';
// at= or time=, with straight, curly or full-width quotes (or none)
const REMIND = new RegExp(`<remind\\s+(?:at|time)\\s*=\\s*[${Q}]?([^${Q}>]*?)[${Q}]?\\s*>([\\s\\S]*?)<\\/remind\\s*>`, 'gi');
const ANY_REMIND = /<remind(?!-cancel)\b[^>]*>[\s\S]*?<\/remind\s*>/gi;
const STRAY_CLOSE = /<\/(?:memory|remind-cancel|remind)\s*>/gi;
const NAMES = ['memory', 'remind', 'remind-cancel', 'think'];

const CANCEL_WORDS = /取消|删|不用|不要|别|改|换|推迟|延后|提前|挪|算了|cancel|delete|remove/i;
const ALL_WORDS = /全部|所有|都|全|all/i;
const ALL_KEY = /^(?:全部|所有|all)$/i;

function stripThink(s) {
  s = s.replace(THINK, '');
  // some servers drop the opening <think> and only send the closing one: everything before it was the reasoning
  let end = -1;
  for (const m of s.matchAll(THINK_CLOSE)) end = m.index + m[0].length;
  return end >= 0 ? s.slice(end) : s;
}

// a half-typed tag at the very end ("<mem", "</remi"), which the stream was cut off in the middle of
function cutPartial(s) {
  const m = /<\/?([a-z-]{0,14})$/i.exec(s);
  return m && NAMES.some((n) => n.startsWith(m[1].toLowerCase())) ? s.slice(0, m.index) : s;
}

// final: the whole reply is here. While streaming an unclosed tag hides everything after it (the rest is still
// arriving); in the final text an unclosed <memory>/<remind> only takes its own line with it, an unclosed <think> the rest.
function visible(text, { final = false } = {}) {
  let s = stripThink(String(text || ''))
    .replace(MEMORY, '')
    .replace(CANCEL, '')
    .replace(ANY_REMIND, '')
    .replace(STRAY_CLOSE, '');
  if (!final) s = s.replace(/<(?:memory|remind|think)[\s\S]*$/i, '').replace(/<[a-z-]{0,14}$/i, '');
  else s = cutPartial(s.replace(/<think\b[\s\S]*$/i, '').replace(/<(?:memory|remind)\b[^\n]*/gi, ''));
  return s.replace(/\n{3,}/g, '\n\n').trimEnd();
}

// the model may only cancel reminders when the user's own message asks to cancel or move something
function allowCancel(userText, keyword) {
  const u = String(userText || '');
  if (!u.trim() || !CANCEL_WORDS.test(u)) return false;
  if (ALL_KEY.test(String(keyword || '').trim()) && !ALL_WORDS.test(u)) return false;
  return true;
}

function parseControl(fullText, userText) {
  const s = stripThink(String(fullText || ''));
  // cancels: over the limit; refused: the user never asked to cancel anything (allowCancel)
  const dropped = { memories: 0, reminders: 0, cancels: 0, refused: 0 };
  const memories = [];
  for (const m of s.matchAll(MEMORY)) {
    // one line, so it survives the one-per-line list on the settings page
    const t = m[1].replace(/\s*\n+\s*/g, ' ').trim();
    if (!t || memories.includes(t)) continue;
    if (Array.from(t).length > LIMITS.memoryChars || memories.length >= LIMITS.memories) { dropped.memories++; continue; }
    memories.push(t);
  }
  const remindAdd = [];
  for (const m of s.matchAll(REMIND)) {
    const at = m[1].trim(), text = m[2].trim();
    if (remindAdd.some((r) => r.at === at && r.text === text)) continue;
    if (remindAdd.length >= LIMITS.reminders) { dropped.reminders++; continue; }
    remindAdd.push({ at, text });
  }
  const remindCancel = [];
  for (const m of s.matchAll(CANCEL)) {
    const k = m[1].trim();
    if (!k || remindCancel.includes(k)) continue;
    if (!allowCancel(userText, k)) { dropped.refused++; continue; }
    if (remindCancel.length >= LIMITS.cancels) { dropped.cancels++; continue; }
    remindCancel.push(k);
  }
  return { memories, remindAdd, remindCancel, dropped };
}

module.exports = { visible, parseControl, allowCancel, LIMITS };
