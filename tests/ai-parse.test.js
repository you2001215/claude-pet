'use strict';
// The control tags in AI replies: what the user sees (visible) and what the program acts on (parseControl).
const test = require('node:test');
const assert = require('node:assert/strict');
const { visible, parseControl, allowCancel, LIMITS } = require('../ai-parse');

test('ai-parse loads without electron', () => {
  assert.ok(!Object.keys(require.cache).some((f) => /[\\/]node_modules[\\/]electron[\\/]/.test(f)));
});

test('LIMITS are the documented caps', () => {
  assert.deepEqual({ ...LIMITS }, { memories: 3, memoryChars: 100, reminders: 3, cancels: 3 });
});

test('visible: closed tags are hidden, the rest stays', () => {
  const s = '好的，记住啦～<memory>他喜欢猫</memory>\n明天见<remind at="2026-11-04 18:00">开会</remind><remind-cancel>喝水</remind-cancel>';
  assert.equal(visible(s), '好的，记住啦～\n明天见');
  assert.equal(visible(s, { final: true }), '好的，记住啦～\n明天见');
});

test('visible: sticker marks are left for the sticker parser', () => {
  assert.equal(visible('哼[sticker:生气]', { final: true }), '哼[sticker:生气]');
});

test('visible: tags are matched case-insensitively', () => {
  assert.equal(visible('嗯<MEMORY>x</Memory>好', { final: true }), '嗯好');
  assert.equal(visible('嗯<Remind AT="2026-11-04 18:00">开会</REMIND>好', { final: true }), '嗯好');
  assert.equal(visible('嗯<Remind-Cancel>开会</Remind-Cancel>好', { final: true }), '嗯好');
});

test('visible: <think> blocks are hidden', () => {
  assert.equal(visible('<think>先想想他要什么</think>你好呀', { final: true }), '你好呀');
  // case-insensitive, and the line break after it doesn't matter to the user
  assert.equal(visible('<THINK>\n多行\n推理\n</THINK>\n你好呀').trim(), '你好呀');
});

test('visible while streaming: an unclosed tag hides everything after it', () => {
  assert.equal(visible('你好<memory>他叫小'), '你好');
  assert.equal(visible('你好<memory>他叫小\n后面还有'), '你好');
  assert.equal(visible('你好<remind at="2026-11-04 18'), '你好');
  assert.equal(visible('你好<think>还在想\n还在想'), '你好');
  assert.equal(visible('你好<mem'), '你好');
  assert.equal(visible('你好<'), '你好');
});

test('visible final: an unclosed <memory>/<remind> only takes its own line', () => {
  assert.equal(visible('好的<memory>他叫小明\n明天见', { final: true }), '好的\n明天见');
  assert.equal(visible('好<remind at="2026-11-04 18:00">开会\n下一行', { final: true }), '好\n下一行');
});

test('visible final: an unclosed <think> removes everything after it', () => {
  assert.equal(visible('答案是这样<think>其实\n我还在想\n很多行', { final: true }), '答案是这样');
});

test('parseControl: memories, reminders and cancels are read out', () => {
  const r = parseControl('好<memory>他叫小明</memory><remind at="2026-11-04 18:00">开会</remind><remind-cancel>喝水</remind-cancel>', '别提醒我喝水了');
  assert.deepEqual(r.memories, ['他叫小明']);
  assert.deepEqual(r.remindAdd, [{ at: '2026-11-04 18:00', text: '开会' }]);
  assert.deepEqual(r.remindCancel, ['喝水']);
  assert.deepEqual(r.dropped, { memories: 0, reminders: 0, cancels: 0, refused: 0 });
});

test('parseControl: memory tags are case-insensitive, duplicates kept once', () => {
  const r = parseControl('<MEMORY>喜欢猫</MEMORY><Memory>喜欢猫</Memory><memory>住在上海</memory>', '');
  assert.deepEqual(r.memories, ['喜欢猫', '住在上海']);
});

test('parseControl: at most 3 memories, at most 100 characters each', () => {
  const five = [1, 2, 3, 4, 5].map((i) => `<memory>第${i}件事</memory>`).join('');
  const r = parseControl(five, '');
  assert.deepEqual(r.memories, ['第1件事', '第2件事', '第3件事']);
  assert.equal(r.dropped.memories, 2);
  const ok = '记'.repeat(LIMITS.memoryChars), long = '长'.repeat(LIMITS.memoryChars + 1);
  const r2 = parseControl(`<memory>${long}</memory><memory>${ok}</memory>`, '');
  assert.deepEqual(r2.memories, [ok]);
  assert.equal(r2.dropped.memories, 1);
});

test('parseControl: memories inside <think> are not stored', () => {
  const r = parseControl('<think>也许 <memory>猜的</memory></think>好的<memory>他说的</memory>', '');
  assert.deepEqual(r.memories, ['他说的']);
});

test('parseControl: remind accepts single, curly and full-width quotes and time=', () => {
  const s = [
    "<remind at='2026-11-04 18:00'>单引号</remind>",
    '<remind at=“2026-11-04 18:10”>中文引号</remind>',
    '<remind time="2026-11-04 18:20">time 写法</remind>',
  ].join('');
  assert.deepEqual(parseControl(s, '').remindAdd, [
    { at: '2026-11-04 18:00', text: '单引号' },
    { at: '2026-11-04 18:10', text: '中文引号' },
    { at: '2026-11-04 18:20', text: 'time 写法' },
  ]);
  assert.deepEqual(parseControl('<remind at=＂2026-11-04 18:30＂>全角引号</remind>', '').remindAdd, [{ at: '2026-11-04 18:30', text: '全角引号' }]);
  assert.deepEqual(parseControl('<REMIND AT="2026-11-04 18:40">大写</REMIND>', '').remindAdd, [{ at: '2026-11-04 18:40', text: '大写' }]);
});

test('parseControl: at most 3 reminders per reply', () => {
  const s = [1, 2, 3, 4].map((i) => `<remind at="2026-11-04 1${i}:00">事${i}</remind>`).join('');
  const r = parseControl(s, '');
  assert.equal(r.remindAdd.length, 3);
  assert.equal(r.dropped.reminders, 1);
});

test('parseControl: cancels need the user to have asked, at most 3', () => {
  const tags = ['a', 'b', 'c', 'd'].map((k) => `<remind-cancel>${k}</remind-cancel>`).join('');
  const asked = parseControl(tags, '这几个都取消吧');
  assert.deepEqual(asked.remindCancel, ['a', 'b', 'c']);
  assert.equal(asked.dropped.cancels, 1);
  const notAsked = parseControl('<remind-cancel>开会</remind-cancel>', '今天好累');
  assert.deepEqual(notAsked.remindCancel, []);
  // refused (she wasn't asked) is counted apart from the per-reply limit
  assert.equal(notAsked.dropped.cancels, 0);
  assert.equal(notAsked.dropped.refused, 1);
  assert.equal(asked.dropped.refused, 0);
  const noUser = parseControl('<remind-cancel>开会</remind-cancel>', '');
  assert.deepEqual(noUser.remindCancel, []);
  assert.equal(noUser.dropped.refused, 1);
});

test('allowCancel rules', () => {
  assert.equal(allowCancel('', '开会'), false);
  assert.equal(allowCancel('   ', '开会'), false);
  assert.equal(allowCancel('今天天气不错', '开会'), false);
  for (const u of ['取消开会的提醒', '把喝水那个删了', '不用提醒我了', '不要提醒了', '别提醒我开会', '改一下时间', '换个时间', '推迟半小时', '延后一点', '提前十分钟', '挪到明天', '算了', 'Cancel it', 'please delete that', 'remove the meeting'])
    assert.equal(allowCancel(u, '开会'), true, u);
  // 全部 / 所有 / all also need the user to say "all"
  assert.equal(allowCancel('删掉开会提醒', '全部'), false);
  assert.equal(allowCancel('取消提醒', '所有'), false);
  assert.equal(allowCancel('cancel it', 'all'), false);
  assert.equal(allowCancel('提醒全部取消', '全部'), true);
  assert.equal(allowCancel('把所有提醒删了', '所有'), true);
  assert.equal(allowCancel('都不用提醒了', '全部'), true);
  assert.equal(allowCancel('cancel ALL', 'all'), true);
});

test('reschedule: 把开会提醒改到六点 gives a cancel and an add', () => {
  const reply = '好嘞，改到六点啦～<remind-cancel>开会</remind-cancel>\n<remind at="2026-11-04 18:00">开会</remind>';
  const r = parseControl(reply, '把开会提醒改到六点');
  assert.deepEqual(r.remindCancel, ['开会']);
  assert.deepEqual(r.remindAdd, [{ at: '2026-11-04 18:00', text: '开会' }]);
  assert.equal(visible(reply, { final: true }), '好嘞，改到六点啦～');
});
