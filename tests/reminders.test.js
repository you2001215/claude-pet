'use strict';
// Reminders: the time format the AI writes, which reminder a cancel keyword hits, and moving a reminder.
// init() is not called, so nothing is written to disk (the module keeps the list in memory).
const test = require('node:test');
const assert = require('node:assert/strict');
const reminders = require('../reminders');

const p2 = (n) => String(n).padStart(2, '0');
const local = (d) => `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`;
const tomorrowAt = (h, m = 0) => { const d = new Date(); d.setDate(d.getDate() + 1); d.setHours(h, m, 0, 0); return d; };

test('reminders loads without electron', () => {
  assert.ok(!Object.keys(require.cache).some((f) => /[\\/]node_modules[\\/]electron[\\/]/.test(f)));
});

test('parseLocal: the formats the AI writes', () => {
  const want = new Date(2026, 9, 25, 17, 0, 0, 0).getTime();
  for (const s of ['2026-10-25 17:00', '2026/10/25 17:00', '2026.10.25 17:00', '2026-10-25T17:00', '2026年10月25日 17:00', '2026-10-25 17：00', '  2026-10-25 17:00  '])
    assert.equal(reminders.parseLocal(s), want, s);
  assert.equal(reminders.parseLocal('2026-1-5 9:05'), new Date(2026, 0, 5, 9, 5).getTime());
  assert.equal(reminders.parseLocal('2026-10-25 17:00:30'), new Date(2026, 9, 25, 17, 0, 30).getTime());
});

test('parseLocal: anything else is NaN', () => {
  for (const s of ['', '明天 17:00', '17:00', '2026-10-25', 'soon', '2026-10-25 1700'])
    assert.ok(Number.isNaN(reminders.parseLocal(s)), s);
});

test('matches: keyword inside the reminder text', () => {
  assert.equal(reminders.matches('开会', '下午三点开会'), true);
  assert.equal(reminders.matches('开会', '开会'), true);
  assert.equal(reminders.matches('喝水', '下午开会'), false);
  assert.equal(reminders.matches('', '开会'), false);
  assert.equal(reminders.matches('开会', ''), false);
});

test('matches: a reminder text inside the keyword counts from 2 characters', () => {
  assert.equal(reminders.matches('取消下午开会的提醒', '下午开会'), true);
  assert.equal(reminders.matches('提醒我拿快递', '拿快递'), true);
  // two-character reminders are common: 开会, 吃药, 喝水
  assert.equal(reminders.matches('开会提醒', '开会'), true);
  assert.equal(reminders.matches('吃药的提醒', '吃药'), true);
  assert.equal(reminders.matches('去喝水吧', '喝水'), true);
  // a one-character text is not hit by every keyword that contains it
  assert.equal(reminders.matches('喝水的提醒', '水'), false);
});

test('matches: filler words in the keyword are tried without', () => {
  assert.equal(reminders.matches('那个吃药的提醒', '晚上吃药'), true);
  assert.equal(reminders.matches('的提醒', '喝水'), false);
});

test('add, cancel and the reschedule order (cancel first, then add)', () => {
  const at5 = local(tomorrowAt(17)), at6 = local(tomorrowAt(18));
  const a = reminders.add(at5, '开会');
  assert.equal(a.ok, true, a.error);
  const b = reminders.add(local(tomorrowAt(20)), '喝水');
  assert.equal(b.ok, true, b.error);
  // 把开会提醒改到六点: the AI sends <remind-cancel>开会</remind-cancel> and <remind at="…18:00">开会</remind>
  const cancelled = reminders.cancel('开会');
  assert.equal(cancelled.length, 1);
  assert.equal(reminders.add(at6, '开会').ok, true);
  const left = reminders.pending().map((r) => [r.text, new Date(r.at).getHours()]);
  assert.deepEqual(left, [['开会', 18], ['喝水', 20]]);
  assert.deepEqual(reminders.cancel('全部').length, 2);
  assert.equal(reminders.pending().length, 0);
});

test('add refuses unreadable, past and far-away times', () => {
  assert.equal(reminders.add('明天下午', 'x').ok, false);
  assert.equal(reminders.add('2001-01-01 10:00', 'x').ok, false);
  const far = new Date(); far.setFullYear(far.getFullYear() + 2);
  assert.equal(reminders.add(local(far), 'x').ok, false);
  assert.equal(reminders.pending().length, 0);
});
