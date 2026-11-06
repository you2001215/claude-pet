'use strict';
// The desktop link (link/) against a fake AstrBot adapter: docs/桌面连接接口说明.md v1.0, section 14.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const WebSocket = require('ws');
const P = require('../link/protocol');
const { LinkClient } = require('../link/client');
const { FakeAdapter } = require('./link/fake-adapter');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 3000, what = 'condition') {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (fn()) return; await sleep(10); }
  throw new Error('timed out waiting for ' + what);
}
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'petlink-'));
const FAST = { backoff: [20, 40, 80], jitter: 0, pingMs: 60000, pongMs: 60000, welcomeMs: 2000 };

// a client with an in-memory token, optionally sharing a token box with another client
function makeClient(fake, o = {}) {
  const box = o.box || { token: '', deviceId: '' };
  const c = new LinkClient({
    url: fake.url, hello: { app_version: 'test', platform: 'linux', device_name: o.name || '测试电脑' },
    getToken: () => box.token, setToken: (t, d) => { box.token = t || ''; box.deviceId = d || ''; },
    statePath: o.statePath || '', timers: { ...FAST, ...(o.timers || {}) }, onSay: o.onSay, onSnapshot: o.onSnapshot,
  });
  c.box = box;
  return c;
}
async function paired(fake, o) {
  const c = makeClient(fake, o);
  await c.pair(fake.issueCode());
  return c;
}

test('protocol: urlOk only lets ws:// go to this computer or private networks', () => {
  for (const u of ['ws://127.0.0.1:6230/desktop/v1', 'ws://localhost:6230/x', 'ws://192.168.1.5:1/', 'ws://100.101.2.3:6230/', 'wss://example.com/x', 'ws://[::1]:6230/'])
    assert.ok(P.urlOk(u), u);
  for (const u of ['ws://example.com/x', 'ws://8.8.8.8/', 'http://127.0.0.1/', 'ws://user:pw@127.0.0.1/', 'ws://100.128.0.1/', 'nonsense'])
    assert.ok(!P.urlOk(u), u);
});

test('protocol: care slots start the day at 4 am', () => {
  const at = (s) => new Date(s).getTime();
  assert.strictEqual(P.careSlot('sleep', at('2026-11-07T00:30:00')), '2026-11-06/night');
  assert.strictEqual(P.careSlot('sleep', at('2026-11-07T03:59:00')), '2026-11-06/night');
  assert.strictEqual(P.careSlot('sleep', at('2026-11-07T00:29:00')), '');
  assert.strictEqual(P.careSlot('sleep', at('2026-11-07T04:00:00')), '');
  assert.strictEqual(P.careSlot('meal', at('2026-11-07T12:00:00')), '2026-11-07/lunch');
  assert.strictEqual(P.careSlot('meal', at('2026-11-07T19:59:00')), '2026-11-07/dinner');
  assert.strictEqual(P.careSlot('meal', at('2026-11-07T15:00:00')), '');
});

test('pairing, then reconnecting with the token; no Origin header is ever sent', async () => {
  const fake = await new FakeAdapter().start();
  try {
    const c = await paired(fake);
    assert.strictEqual(c.status, 'online');
    assert.ok(c.box.token.length >= 40, 'got a token');
    assert.ok(c.box.deviceId.startsWith('dev_'));
    c.stop();
    c.start();
    await until(() => c.online, 2000, 'online with token');
    c.stop();
    assert.ok(fake.handshakes.length >= 2);
    for (const h of fake.handshakes) assert.strictEqual(h.origin, undefined);
    // the pairing code never appears in what the pet keeps
    assert.ok(!JSON.stringify(c.state).includes('pair_code'));
  } finally { await fake.close(); }
});

test('a web page (has an Origin header) is refused', async () => {
  const fake = await new FakeAdapter().start();
  try {
    const err = await new Promise((resolve) => {
      const ws = new WebSocket(fake.url, { origin: 'https://evil.example' });
      ws.on('open', () => resolve(null));
      ws.on('error', (e) => resolve(e));
    });
    assert.ok(err, 'connection with Origin must fail');
  } finally { await fake.close(); }
});

test('wrong, expired or used pairing codes: 4403 and no retrying on its own', async () => {
  const fake = await new FakeAdapter().start();
  try {
    const c = makeClient(fake);
    await assert.rejects(c.pair('123456'), { code: 'pair_code_invalid' });
    assert.strictEqual(c.status, 'needs_pair');
    const shakes = fake.handshakes.length;
    await sleep(200);
    assert.strictEqual(fake.handshakes.length, shakes, 'no reconnect after 4403');
    // expired
    const old = fake.issueCode(1);
    await sleep(5);
    await assert.rejects(makeClient(fake).pair(old), { code: 'pair_code_invalid' });
    // used
    const code = fake.issueCode();
    const a = makeClient(fake);
    await a.pair(code);
    await assert.rejects(makeClient(fake).pair(code), { code: 'pair_code_invalid' });
    a.stop();
    // not 6 digits: refused before connecting
    await assert.rejects(makeClient(fake).pair('12ab'), { code: 'bad_code' });
  } finally { await fake.close(); }
});

test('five wrong tries spoil the open code', async () => {
  const fake = await new FakeAdapter().start();
  try {
    const good = fake.issueCode();
    for (let i = 0; i < 5; i++) await assert.rejects(makeClient(fake).pair(good === '000000' ? '000001' : '000000'), { code: 'pair_code_invalid' });
    await assert.rejects(makeClient(fake).pair(good), { code: 'pair_code_invalid' });
  } finally { await fake.close(); }
});

test('revoked: cut off at once, token forgotten, no reconnect', async () => {
  const fake = await new FakeAdapter().start();
  try {
    const c = await paired(fake);
    fake.revoke(c.box.deviceId);
    await until(() => c.status === 'revoked', 2000, 'revoked');
    assert.strictEqual(c.box.token, '');
    const shakes = fake.handshakes.length;
    await sleep(200);
    assert.strictEqual(fake.handshakes.length, shakes);
  } finally { await fake.close(); }
});

test('the same device connecting twice: the old connection is replaced (4409)', async () => {
  const fake = await new FakeAdapter().start();
  try {
    const a = await paired(fake);
    const b = makeClient(fake, { box: a.box });
    b.start();
    await until(() => b.online && a.status === 'replaced', 2000, 'replaced');
    b.stop();
  } finally { await fake.close(); }
});

test('a reply with text and an image; text is cut to text_max', async () => {
  const png = Buffer.from('89504e470d0a1a0a', 'hex');
  const img = { mime: 'image/png', sha256: crypto.createHash('sha256').update(png).digest('hex'), size: png.length, data: png.toString('base64') };
  const fake = await new FakeAdapter({ answer: (t) => [{ text: '嗨～' }, { image: img }], }).start();
  try {
    const c = await paired(fake);
    const r = await c.chat('你好');
    assert.strictEqual(r.kind, 'done');
    const { text, images } = P.splitParts(r.data.parts);
    assert.strictEqual(text, '嗨～');
    assert.strictEqual(images[0].sha256, img.sha256);
    await c.chat('长'.repeat(5000));
    const sent = fake.received('chat.send').pop();
    assert.strictEqual(sent.data.text.length, 4000);
    assert.strictEqual(c.state.outbox.length, 0, 'acked messages leave the outbox');
    c.stop();
  } finally { await fake.close(); }
});

test('sent, then the line drops before the ack: resent with the same id, answered once', async () => {
  const fake = await new FakeAdapter().start();
  try {
    const c = await paired(fake);
    fake.ackOn = false; fake.hold = [];
    const p = c.chat('在吗');
    await until(() => fake.received('chat.send').length === 1, 2000, 'first send');
    fake.drop();
    await until(() => fake.received('chat.send').length === 2, 3000, 'resend after reconnect');
    const [a, b] = fake.received('chat.send');
    assert.strictEqual(a.id, b.id);
    assert.deepStrictEqual(fake.hold, [a.id], 'the repeat is not answered again');
    fake.ackOn = true;
    fake.answer(a.id, [{ text: '在的' }]);
    const r = await p;
    assert.strictEqual(r.data.parts[0].text, '在的');
    assert.strictEqual(c.state.outbox.length, 0);
    c.stop();
  } finally { await fake.close(); }
});

test('the outbox survives a restart of the pet', async () => {
  const fake = await new FakeAdapter().start();
  const dir = tmp();
  const statePath = path.join(dir, 'link-state.json');
  try {
    const c = await paired(fake, { statePath });
    fake.ackOn = false; fake.hold = [];
    c.chat('记得我').catch(() => {});
    await until(() => fake.received('chat.send').length === 1, 2000, 'sent');
    c.stop();
    fake.ackOn = true;
    const c2 = makeClient(fake, { box: c.box, statePath });
    c2.start();
    await until(() => fake.received('chat.send').length === 2, 2000, 'resent by the new instance');
    const late = new Promise((r) => c2.once('late', r));
    const id = fake.received('chat.send')[0].id;
    fake.answer(id, [{ text: '记得' }]);
    const d = await late;
    assert.strictEqual(d.reply_to, id, 'a reply nobody waits for any more comes out as late');
    c2.stop();
  } finally { await fake.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('merged: the second message is answered inside the first reply', async () => {
  const fake = await new FakeAdapter().start();
  try {
    const c = await paired(fake);
    fake.hold = [];
    const pa = c.chat('第一句'), pb = c.chat('第二句');
    await until(() => fake.hold.length === 2, 2000, 'both held');
    fake.answer(fake.hold[0], [{ text: '两句一起回' }], [...fake.hold]);
    const [ra, rb] = await Promise.all([pa, pb]);
    assert.strictEqual(ra.kind, 'done');
    assert.strictEqual(rb.kind, 'merged');
    assert.strictEqual(rb.into, ra.id);
    c.stop();
  } finally { await fake.close(); }
});

test('chat.error and timeouts reject; a reply after the timeout comes out as late', async () => {
  const fake = await new FakeAdapter({ fail: true }).start();
  try {
    const c = await paired(fake);
    await assert.rejects(c.chat('hi'), (e) => e.code === 'model_failed' && e.retry === true && !!e.id);
    c.stop();
  } finally { await fake.close(); }
  const slow = await new FakeAdapter({ replyTimeoutS: 0.15, silent: true }).start();
  try {
    const c = await paired(slow);
    let err;
    try { await c.chat('慢慢回'); } catch (e) { err = e; }
    assert.strictEqual(err.code, 'timeout');
    const late = new Promise((r) => c.once('late', r));
    slow.answer(err.id, [{ text: '我来晚了' }]);
    assert.strictEqual((await late).reply_to, err.id);
    c.stop();
  } finally { await slow.close(); }
});

test('offline items go out as offline.batch, split by batch_max, also while connected', async () => {
  const fake = await new FakeAdapter({ batchMax: 3 }).start();
  try {
    const c = await paired(fake);
    c.stop();
    c.offline([1, 2, 3, 4, 5].map((i) => ({ role: i % 2 ? 'user' : 'pet', text: `离线第${i}句`, ts: Date.now() + i })));
    c.start();
    await until(() => fake.received('offline.batch').length === 2, 2000, 'two batches');
    const [b1, b2] = fake.received('offline.batch');
    assert.strictEqual(b1.data.items.length, 3);
    assert.strictEqual(b2.data.items.length, 2);
    assert.strictEqual(b1.data.items[0].role, 'user');
    assert.strictEqual(b1.data.items[1].role, 'pet');
    c.offline([{ role: 'pet', text: '替她答的', reply_to: 'm_x' }]);
    await until(() => fake.received('offline.batch').length === 3, 2000, 'batch while online');
    assert.strictEqual(fake.received('offline.batch')[2].data.items[0].reply_to, 'm_x');
    await until(() => c.state.outbox.length === 0, 2000, 'all acked');
    c.stop();
  } finally { await fake.close(); }
});

test('cmd.say runs once per id and is acked; snapshot is stored and acked', async () => {
  const fake = await new FakeAdapter().start();
  const said = [], snaps = [];
  try {
    const c = await paired(fake, {
      onSay: async (d) => { said.push(d); return d.source === 'sticker' ? { ok: false, code: 'expired' } : { ok: true }; },
      onSnapshot: async (d) => { snaps.push(d); },
    });
    const f = fake.push('cmd.say', { source: 'reminder', parts: [{ text: '3 点啦' }], expires_at: Date.now() + 60000 });
    await until(() => fake.acks.length === 1, 2000, 'ack');
    fake.push('cmd.say', { source: 'reminder', parts: [{ text: '3 点啦' }] }, f.id);
    await until(() => fake.acks.length === 2, 2000, 'second ack');
    assert.strictEqual(said.length, 1, 'a repeat is not shown twice');
    assert.strictEqual(fake.acks[1].code, 'duplicate');
    fake.push('cmd.say', { source: 'sticker', parts: [] });
    await until(() => fake.acks.length === 3, 2000, 'third ack');
    assert.strictEqual(fake.acks[2].ok, false);
    assert.strictEqual(fake.acks[2].code, 'expired');
    fake.push('snapshot.data', { made_at: 1, profile: '小档案' });
    await until(() => fake.acks.length === 4, 2000, 'snapshot ack');
    assert.strictEqual(snaps[0].profile, '小档案');
    c.stop();
  } finally { await fake.close(); }
});

test('sleep questions are counted together with QQ', async () => {
  const fake = await new FakeAdapter().start();
  try {
    const c = await paired(fake);
    const slot = '2026-11-06/night';
    assert.ok(c.careAllowed('sleep', slot), 'nothing asked yet');
    fake.push('event.care', { kind: 'sleep', slot, action: 'state', asked_qq: 1, asked_desktop: 0, answered: false, stopped: false, limit: 2 });
    await until(() => fake.acks.length === 1, 2000, 'state acked');
    assert.ok(c.careAllowed('sleep', slot), '1 of 2 used');
    c.care('sleep', slot, 'asked');
    assert.ok(!c.careAllowed('sleep', slot), 'QQ once + desktop once = 2, no third');
    await until(() => fake.received('event.care').length === 1, 2000, 'care sent');
    assert.strictEqual(fake.received('event.care')[0].data.side, 'desktop');
    fake.push('event.care', { kind: 'meal', slot: '2026-11-06/lunch', action: 'state', asked_qq: 0, asked_desktop: 0, answered: true, stopped: false, limit: 1 });
    await until(() => fake.acks.length === 2, 2000, 'meal state');
    assert.ok(!c.careAllowed('meal', '2026-11-06/lunch'), 'answered: no more');
    c.stop();
  } finally { await fake.close(); }
});

test('frames it cannot read or does not know are ignored, the line stays up', async () => {
  const fake = await new FakeAdapter().start();
  try {
    const c = await paired(fake);
    fake.ws().send('not json');
    fake.push('cmd.dance', { x: 1 });
    await until(() => c.info().bad === 1 && c.info().unknown === 1, 2000, 'counted');
    assert.ok(c.online);
    const r = await c.chat('还在吗');
    assert.strictEqual(r.kind, 'done');
    c.stop();
  } finally { await fake.close(); }
});

test('no pong: the line is dropped and comes back; 4429 waits; 4426 stops', async () => {
  const fake = await new FakeAdapter().start();
  try {
    const c = await paired(fake, { timers: { pingMs: 50, pongMs: 50 } });
    const seen = [];
    c.on('status', (s) => seen.push(s));
    try {
      fake.pong = false;
      const shakes = fake.handshakes.length;
      await until(() => fake.handshakes.length > shakes, 3000, 'reconnect after a missing pong');
      fake.pong = true;
      await until(() => c.online, 2000, 'back online');
      seen.length = 0;
      fake.ws().close(4429, 'retry_after=0');
      await until(() => seen.includes('waiting') && c.online, 2000, 'waited, then online again');
      fake.ws().close(4426, 'proto_unsupported');
      await until(() => c.status === 'outdated', 1000, 'outdated');
      const shakes2 = fake.handshakes.length;
      await sleep(200);
      assert.strictEqual(fake.handshakes.length, shakes2, 'no reconnect after 4426');
    } finally { c.stop(); }
  } finally { await fake.close(); }
});

test('the log never gets chat text, the token or the pairing code', async () => {
  const fake = await new FakeAdapter().start();
  const lines = [];
  try {
    const box = { token: '', deviceId: '' };
    const c = new LinkClient({ url: fake.url, hello: {}, getToken: () => box.token, setToken: (t) => { box.token = t || ''; }, timers: FAST, log: (m) => lines.push(m) });
    const code = fake.issueCode();
    await c.pair(code);
    await c.chat('我的秘密是喜欢吃香菜');
    fake.drop();
    await until(() => c.online, 2000, 'reconnected');
    c.stop();
    const all = lines.join('\n');
    assert.ok(!all.includes('香菜') && !all.includes(code) && !all.includes(box.token), all);
  } finally { await fake.close(); }
});
