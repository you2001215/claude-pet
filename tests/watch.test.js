'use strict';
// Watching together (watch/): what the browser script reports -> event.watch, the local endpoint, the script itself.
const test = require('node:test');
const assert = require('node:assert');
const vm = require('vm');
const { WatchSession } = require('../watch/session');
const server = require('../watch/server');
const { script } = require('../watch/userscript');

const V = { site: 'bilibili', bvid: 'BV1xx411c7mD', cid: 123, p: 1, title: '测试视频', dur: 600 };
function session(t0 = 1000000) {
  let now = t0;
  const out = [];
  const s = new WatchSession({ now: () => now, send: (kind, data, ack) => out.push({ kind, data, ack }), timers: { leaveMs: 60000, hiddenMs: 60000 } });
  return { s, out, tick: (ms) => { now += ms; }, at: () => now };
}
const rep = (s, kind, o = {}) => s.report({ kind, video: V, t: 0, paused: false, rate: 1, hidden: false, ...o });

test('first report starts; heartbeats become progress at most every 10 s; state changes go out at once', () => {
  const { s, out, tick } = session();
  rep(s, 'heartbeat', { t: 5 });
  assert.deepStrictEqual(out.map((e) => e.kind), ['start']);
  assert.strictEqual(out[0].ack, true);
  assert.strictEqual(out[0].data.mode, 'normal');
  tick(5000); rep(s, 'heartbeat', { t: 10 });
  assert.strictEqual(out.length, 1, 'no progress after 5 s');
  tick(5000); rep(s, 'heartbeat', { t: 15 });
  assert.strictEqual(out[1].kind, 'progress');
  assert.strictEqual(out[1].ack, false);
  rep(s, 'pause', { t: 15.2, paused: true });
  rep(s, 'seek', { t: 100, paused: true, from: 15.2 });
  rep(s, 'rate', { t: 100, paused: true, rate: 1.5 });
  assert.deepStrictEqual(out.slice(2).map((e) => e.kind), ['pause', 'seek', 'rate']);
  assert.strictEqual(out[3].data.from, 15.2);
  tick(20000); rep(s, 'heartbeat', { t: 100, paused: true });
  assert.strictEqual(out.length, 5, 'no progress while paused');
  rep(s, 'ended', { t: 600, paused: true });
  assert.strictEqual(out[5].kind, 'ended');
  assert.strictEqual(out[5].ack, true);
});

test('another video: leave the old one, start the new; coming back sends start again', () => {
  const { s, out } = session();
  rep(s, 'heartbeat');
  s.report({ kind: 'switch', video: { ...V, bvid: 'BV2yy', cid: 456 }, t: 0, paused: false, rate: 1 });
  assert.deepStrictEqual(out.map((e) => `${e.kind}:${e.data.video.bvid}`), ['start:BV1xx411c7mD', 'leave:BV1xx411c7mD', 'start:BV2yy']);
  s.report({ kind: 'leave' });
  assert.strictEqual(out[3].kind, 'leave');
  rep(s, 'heartbeat');
  assert.strictEqual(out[4].kind, 'start');
});

test('tab hidden for a while: leave; visible again: start', async () => {
  const out = [];
  const s = new WatchSession({ send: (kind) => out.push(kind), timers: { hiddenMs: 30, leaveMs: 5000 } });
  rep(s, 'heartbeat');
  rep(s, 'hidden', { hidden: true });
  await new Promise((r) => setTimeout(r, 60));
  assert.deepStrictEqual(out, ['start', 'leave']);
  rep(s, 'visible');
  assert.deepStrictEqual(out, ['start', 'leave', 'start']);
  s.stop();
});

test('no reports for a while: leave', async () => {
  const out = [];
  const s = new WatchSession({ send: (kind) => out.push(kind), timers: { leaveMs: 30 } });
  rep(s, 'heartbeat');
  await new Promise((r) => setTimeout(r, 60));
  assert.deepStrictEqual(out, ['start', 'leave']);
  assert.strictEqual(s.position(), null);
});

test('her line is shown only near the point it is about; the end line only checks expiry', () => {
  const { s, tick } = session();
  rep(s, 'heartbeat', { t: 300, rate: 1 });
  tick(4000);                                   // playing: now at ~304
  assert.strictEqual(s.position().t, 304);
  assert.ok(s.fresh({ bvid: V.bvid, t: 290 }));
  assert.ok(!s.fresh({ bvid: V.bvid, t: 250 }), 'more than 20 s away');
  assert.ok(!s.fresh({ bvid: 'BVother', t: 304 }), 'another video');
  rep(s, 'pause', { t: 304, paused: true });
  assert.ok(!s.fresh({ bvid: V.bvid, t: 304 }), 'paused: only in chatty mode');
  assert.ok(s.fresh({ bvid: V.bvid, t: 304 }, 'chatty'));
  s.report({ kind: 'leave' });
  assert.ok(!s.fresh({ bvid: V.bvid, t: 304 }));
  assert.ok(s.fresh({ bvid: V.bvid, t: 600, end: true }), 'the end line shows even after leaving');
});

test('「跳过去」: the seek goes to the script once, until it says done', () => {
  const { s } = session();
  rep(s, 'heartbeat', { t: 10 });
  const id = s.seek(452);
  const a = rep(s, 'heartbeat', { t: 11 });
  assert.deepStrictEqual(a.cmd, [{ id, type: 'seek', t: 452 }]);
  const b = rep(s, 'seek', { t: 452, from: 11, done: [id] });
  assert.deepStrictEqual(b.cmd, []);
});

test('bad reports are refused without breaking anything', () => {
  const { s, out } = session();
  assert.strictEqual(s.report({ kind: 'dance' }).ok, false);
  assert.strictEqual(s.report({ kind: 'heartbeat', video: {} }).ok, false);
  assert.strictEqual(s.report(null).ok, false);
  assert.strictEqual(out.length, 0);
  const long = s.report({ kind: 'heartbeat', video: { ...V, title: '长'.repeat(200) }, t: 'x', paused: 0, rate: 'y' });
  assert.ok(long.ok);
  assert.strictEqual(out[0].data.video.title.length, 80);
  assert.strictEqual(out[0].data.t, 0);
  assert.strictEqual(out[0].data.rate, 1);
});

test('local endpoint: needs the key, only 127.0.0.1, refuses web pages and big bodies', async () => {
  const key = 'a'.repeat(32);
  const got = [];
  const srv = await server.start({ port: 0, key, onEvent: (b) => { got.push(b); return { ok: true, cmd: [] }; } });
  const url = `http://127.0.0.1:${srv.port}/watch/v1/event`;
  const post = (headers, body = '{"kind":"heartbeat"}') => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body });
  try {
    assert.strictEqual((await post({ 'X-Pet-Key': key })).status, 200);
    assert.strictEqual(got.length, 1);
    assert.strictEqual((await post({ 'X-Pet-Key': 'b'.repeat(32) })).status, 403, 'wrong key');
    assert.strictEqual((await post({})).status, 403, 'no key');
    assert.strictEqual((await post({ 'X-Pet-Key': key, Origin: 'https://www.bilibili.com' })).status, 403, 'a web page');
    assert.strictEqual((await post({ 'X-Pet-Key': key, Origin: 'chrome-extension://abcdef' })).status, 200, 'a script manager');
    assert.strictEqual((await post({ 'X-Pet-Key': key }, 'x'.repeat(20000))).status, 413);
    assert.strictEqual((await post({ 'X-Pet-Key': key }, 'not json')).status, 400);
    const ping = await fetch(`http://127.0.0.1:${srv.port}/watch/v1/ping`, { headers: { 'X-Pet-Key': key } });
    assert.deepStrictEqual(await ping.json(), { ok: true, app: 'ClaudePet' });
    assert.strictEqual(got.length, 2);
  } finally { await srv.close(); }
});

test('the browser script is valid and carries this computer\'s port and key', () => {
  const key = 'c'.repeat(32);
  const src = script({ port: 6231, key });
  assert.doesNotThrow(() => new vm.Script(src));
  assert.ok(src.includes(`'${key}'`) && src.includes('6231'));
  assert.ok(src.includes('@match        https://www.bilibili.com/video/*'));
  assert.ok(!/danmaku|cookie|comment/i.test(src.split('==/UserScript==')[1]), 'reads no danmaku, cookies or comments');
  assert.throws(() => script({ port: 'x', key }));
  assert.throws(() => script({ port: 6231, key: "'; alert(1); '" }));
});

test('same video: bvid when there is one, else ep (bangumi); p too when given', () => {
  const { s } = session();
  s.report({ kind: 'heartbeat', video: { site: 'bilibili', bvid: '', cid: 0, ep: 12345, p: 1, title: '番剧' }, t: 300, paused: false, rate: 1 });
  assert.ok(s.same({ bvid: '', ep: 12345, cid: 0, t: 300 }));
  assert.ok(!s.same({ bvid: '', ep: 999, t: 300 }));
  assert.ok(s.fresh({ bvid: '', ep: 12345, t: 305 }));
  const b = session();
  rep(b.s, 'heartbeat', { t: 10, video: { ...V, p: 2 } });
  assert.ok(b.s.same({ bvid: V.bvid, t: 10 }), 'no p in the anchor: any part');
  assert.ok(b.s.same({ bvid: V.bvid, p: 2, t: 10 }));
  assert.ok(!b.s.same({ bvid: V.bvid, p: 1, t: 10 }), 'another part');
  assert.ok(!b.s.same({ bvid: '', ep: 0, t: 10 }), 'nothing to match on');
});
