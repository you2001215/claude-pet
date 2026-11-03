'use strict';
// What gets read aloud: clean-up of the reply, the Kokoro wording fixes, and splitting into pieces.
const test = require('node:test');
const assert = require('node:assert/strict');
const { cleanForSpeech, splitForSpeech, forKokoro } = require('../voice/text');

test('voice/text loads without electron', () => {
  assert.ok(!Object.keys(require.cache).some((f) => /[\\/]node_modules[\\/]electron[\\/]/.test(f)));
});

test('forKokoro: names are written the way Kokoro can say them', () => {
  assert.equal(forKokoro('我是Claude'), '我是克劳德');
  assert.equal(forKokoro('CLAUDE 和 claude'), '克劳德 和 克劳德');
  assert.equal(forKokoro('背后是DeepSeek'), '背后是迪普西克');
  assert.equal(forKokoro('deep seek 和 DEEPSEEK'), '迪普西克 和 迪普西克');
});

test('forKokoro: clock times become 点/分', () => {
  assert.equal(forKokoro('13:30开会'), '13点30分开会');
  assert.equal(forKokoro('9:00起床'), '9点起床');
  assert.equal(forKokoro('09:05'), '9点5分');
  assert.equal(forKokoro('13：30'), '13点30分');
});

test('forKokoro: ！ right before latin letters is replaced', () => {
  assert.equal(forKokoro('太好了！OK'), '太好了。OK');
  assert.equal(forKokoro('好耶!!  yes'), '好耶。yes');
  assert.equal(forKokoro('好耶！你真棒'), '好耶！你真棒');
});

test('cleanForSpeech: stage directions, stickers, tags and emoji are not read', () => {
  assert.equal(cleanForSpeech('（歪头）你好呀'), '你好呀');
  assert.equal(cleanForSpeech('(≧▽≦)好耶'), '好耶');
  assert.equal(cleanForSpeech('*叉腰*哼'), '哼');
  assert.equal(cleanForSpeech('好的[sticker:开心]'), '好的');
  assert.equal(cleanForSpeech('好的[表情：开心]'), '好的');
  assert.equal(cleanForSpeech('你好<b>呀</b>'), '你好呀');
  assert.equal(cleanForSpeech('好耶🎉😀'), '好耶');
  assert.equal(cleanForSpeech('比心❤️✨'), '比心');
  assert.equal(cleanForSpeech('好～～～'), '好～');
});

test('cleanForSpeech: links become 这个链接', () => {
  assert.equal(cleanForSpeech('看 https://example.com/a?b=1 这个'), '看 这个链接 这个');
  assert.equal(cleanForSpeech('http://x.cn'), '这个链接');
});

test('cleanForSpeech: long replies are capped at 400 characters', () => {
  assert.equal(Array.from(cleanForSpeech('啊'.repeat(1000))).length, 400);
});

test('splitForSpeech: every piece stays within the limit and nothing is lost', () => {
  const texts = [
    '今天天气真好。我们出去走走吧！好不好？',
    '这是一句非常非常长的话，中间有逗号，也有顿号、还有冒号：但是就是没有句号'.repeat(4),
    '没有任何标点的长句子'.repeat(20),
    'Short one. Another one! And a question? Yes.',
    '一\n二\n三',
  ];
  for (const max of [10, 30, 60]) {
    for (const s of texts) {
      const parts = splitForSpeech(s, max);
      assert.ok(parts.length >= 1);
      for (const p of parts) assert.ok(Array.from(p).length <= max, `${JSON.stringify(p)} > ${max}`);
      assert.equal(parts.join('').replace(/\s/g, ''), s.replace(/\s/g, ''));
    }
  }
});

test('splitForSpeech: a short text stays in one piece', () => {
  assert.deepEqual(splitForSpeech('你好呀。', 60), ['你好呀。']);
});
