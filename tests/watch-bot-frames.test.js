'use strict';
// The watch-together frames AstrBot's own end-to-end test sent (tests/link/bot-frames-watch.json): does the pet read
// them the way the spec (section 16) says?
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const P = require('../link/protocol');
const { WatchSession } = require('../watch/session');

const BOT = JSON.parse(fs.readFileSync(path.join(__dirname, 'link', 'bot-frames-watch.json'), 'utf8'));
const report = (s, video, t, o = {}) => s.report({ kind: 'heartbeat', video: { site: 'bilibili', p: 1, title: '', ...video }, t, paused: false, rate: 1, ...o });

test('every frame parses as one of ours', () => {
  for (const [k, f] of Object.entries(BOT)) if (!k.startsWith('_') && k !== 'features') assert.ok(P.parse(JSON.stringify(f)), k);
});

test('her line about the video being watched: shown near the point, dropped far from it; the end line always', () => {
  let now = 1e9;
  const s = new WatchSession({ now: () => now, send: () => {} });
  report(s, { bvid: 'BV1xx411c7mD', cid: 123456 }, 312);
  const w = BOT['cmd.say watch'].data;
  assert.ok(s.fresh(w.watch));
  assert.deepStrictEqual(P.emotionOf(w.emotion), { name: '开心', level: 1 });
  assert.strictEqual(P.splitParts(w.parts).text, '这段弹幕笑死了QWE');
  now += 60000; report(s, { bvid: 'BV1xx411c7mD', cid: 123456 }, 400);
  assert.ok(!s.fresh(w.watch), '85 s later: stale');
  s.report({ kind: 'leave' });
  assert.ok(s.fresh(BOT['cmd.say watch end'].data.watch), 'end: only the expiry counts');
});

test('bangumi: no bvid, matched by ep (and p)', () => {
  const s = new WatchSession({ send: () => {} });
  report(s, { bvid: '', cid: 0, ep: 778899 }, 31);
  assert.ok(s.fresh(BOT['cmd.say watch 番剧'].data.watch));
  assert.ok(s.same(BOT['cmd.point 番剧'].data));
  assert.ok(!s.same(BOT['cmd.point'].data), 'the other video');
  const other = new WatchSession({ send: () => {} });
  report(other, { bvid: '', ep: 111 }, 31);
  assert.ok(!other.fresh(BOT['cmd.say watch 番剧'].data.watch), 'another episode');
});

test('cmd.point on the video being watched; cmd.mode switches the mode', () => {
  const s = new WatchSession({ send: () => {} });
  report(s, { bvid: 'BV1xx411c7mD', cid: 123456 }, 100);
  assert.ok(s.same(BOT['cmd.point'].data));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'petwatch-'));
  try {
    delete require.cache[require.resolve('../watch/index.js')];
    const watch = require('../watch/index.js');
    return watch.init({ userData: dir, link: { feature: () => false, send: () => '' } }).then(() => {
      assert.deepStrictEqual(watch.applyMode(BOT['cmd.mode'].data), { ok: true });
      assert.strictEqual(watch.status().mode, 'quiet');
      assert.strictEqual(watch.applyMode({ mode: 'loud' }).ok, false);
      return watch.stop();
    });
  } finally { setTimeout(() => fs.rmSync(dir, { recursive: true, force: true }), 50); }
});
