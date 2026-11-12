'use strict';
// Phase 3 (docs/桌面连接接口说明.md section 17): at the computer or not, the pet's body stimuli, held lines, mood,
// quiet time; and the link client's side of cmd.mood / cmd.act / cmd.quiet and held acks, against the fake adapter.
const test = require('node:test');
const assert = require('node:assert');
const { Presence, Feelings, Held, readMood, moodNow, quietUntil, ACTS } = require('../link/presence');
const { LinkClient } = require('../link/client');
const { FakeAdapter } = require('./link/fake-adapter');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 3000, what = 'condition') {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (fn()) return; await sleep(10); }
  throw new Error('timed out waiting for ' + what);
}
function clock(t0 = 1794100000000) { const c = { t: t0, now: () => c.t, add: (ms) => { c.t += ms; } }; return c; }
function presence(o = {}) {
  const c = clock(), sent = [];
  const p = new Presence({ now: c.now, send: (d) => sent.push(d), ...o });
  return { c, p, sent };
}

test('presence: start reports the current state once; lock and sleep count at once; coming back says how long', () => {
  const { c, p, sent } = presence();
  p.sample({ idle_s: 3, front: { app: 'Google Chrome', title: '一个视频 - 哔哩哔哩' } });
  assert.strictEqual(sent.length, 0, 'nothing before start');
  p.start();
  assert.deepStrictEqual(sent[0], { state: 'here', why: 'start', idle_s: 3, away_s: 0, watching: false, front: { app: 'Google Chrome', title: '一个视频 - 哔哩哔哩' } });
  c.add(5000); p.sample({ idle_s: 0, locked: true });
  assert.deepStrictEqual(sent[1], { state: 'away', why: 'locked', idle_s: 0, away_s: 0, watching: false }, 'no front while away');
  c.add(25 * 60000); p.sample({ idle_s: 1 });
  assert.strictEqual(sent[2].state, 'here');
  assert.strictEqual(sent[2].away_s, 25 * 60, 'away for 25 minutes');
  c.add(5000); p.sample({ idle_s: 0, asleep: true });
  assert.strictEqual(sent[3].why, 'sleep');
});

test('presence: away while the link was down, back before it came up: the next start says how long', () => {
  const { c, p, sent } = presence();
  p.start();
  c.add(5000); p.sample({ idle_s: 0, asleep: true });          // away goes out before the network does
  assert.deepStrictEqual([sent[1].state, sent[1].why], ['away', 'sleep']);
  p.stop();                                                     // the link drops while asleep
  c.add(90 * 60000); p.sample({ idle_s: 2 });                   // awake again, not connected yet
  assert.strictEqual(sent.length, 2, 'nothing while disconnected');
  p.start();
  assert.deepStrictEqual([sent[2].state, sent[2].why, sent[2].away_s], ['here', 'start', 90 * 60]);
  p.stop(); p.start();
  assert.strictEqual(sent[3].away_s, 0, 'only once');
});

test('presence: 10 minutes idle is away, unless a video plays; the idle time counts from the last input', () => {
  const { c, p, sent } = presence();
  p.start();
  c.add(9 * 60000); p.sample({ idle_s: 599 });
  assert.strictEqual(sent.length, 1, 'still here at 9:59');
  c.add(1000); p.sample({ idle_s: 600 });
  assert.deepStrictEqual([sent[1].state, sent[1].why], ['away', 'idle']);
  c.add(5 * 60000); p.sample({ idle_s: 2 });
  assert.strictEqual(sent[2].away_s, 600 + 300, 'away since the last input, 15 minutes ago');
  // a video: idle long, still here
  c.add(20 * 60000); p.sample({ idle_s: 1200, watching: true });
  assert.strictEqual(sent.length, 4, 'the watching flag changed: one report');
  assert.deepStrictEqual([sent[3].state, sent[3].why, sent[3].watching], ['here', 'video', true]);
  c.add(5000); p.sample({ idle_s: 1205, watching: false });
  assert.deepStrictEqual([sent[4].state, sent[4].why], ['away', 'idle'], 'the video stopped: away');
});

test('presence: only the front window changed -> merged, at most one every 15 s; titles cut at 80', () => {
  const { c, p, sent } = presence();
  p.sample({ idle_s: 0, front: { app: 'A' } });
  p.start();
  c.add(5000); p.sample({ idle_s: 0, front: { app: 'B' } });
  c.add(5000); p.sample({ idle_s: 0, front: { app: 'C' } });
  assert.strictEqual(sent.length, 1, 'within 15 s of the last report: held back');
  c.add(5000); p.sample({ idle_s: 0, front: { app: 'C' } });
  assert.strictEqual(sent.length, 2);
  assert.deepStrictEqual([sent[1].why, sent[1].front.app], ['front', 'C']);
  c.add(20000); p.sample({ idle_s: 0, front: { app: 'C' } });
  assert.strictEqual(sent.length, 2, 'nothing changed: nothing sent');
  c.add(20000); p.sample({ idle_s: 0, front: { app: 'C', title: 'x'.repeat(200) } });
  assert.strictEqual(Array.from(sent[2].front.title).length, 80);
  c.add(20000); p.sample({ idle_s: 0, front: null });
  assert.ok(!('front' in sent[3]), 'app sharing off: no front at all');
});

test('feelings: drop at most once a minute; poke and calm each time', () => {
  const c = clock(), sent = [];
  const f = new Feelings({ now: c.now, send: (d) => sent.push(d) });
  assert.deepStrictEqual(f.stimulus('drop'), { name: '委屈', level: 1, cause: 'drop', text: '被摔疼了' });
  c.add(30000); assert.strictEqual(f.stimulus('drop'), null, 'again within a minute: not sent');
  c.add(31000); assert.ok(f.stimulus('drop'));
  assert.deepStrictEqual([f.stimulus('poke').name, f.stimulus('poke').level], ['烦', 2]);
  assert.deepStrictEqual([f.stimulus('calm').name, f.stimulus('calm').level], ['开心', 1]);
  assert.strictEqual(f.stimulus('nonsense'), null);
  assert.strictEqual(sent.length, 6);
});

test('feelings: 2 hours ignored counts only time the owner is here, not watching, not in quiet time; once per stretch', () => {
  const sent = [];
  const f = new Feelings({ send: (d) => sent.push(d), ignoredMs: 1000 });
  const here = { here: true, watching: false, quiet: false };
  f.tick(600, here);
  f.tick(5000, { ...here, here: false });        // away: doesn't count
  f.tick(5000, { ...here, watching: true });     // watching: doesn't count
  f.tick(5000, { ...here, quiet: true });        // 「别吵我」: doesn't count, isn't sent
  assert.strictEqual(sent.length, 0);
  assert.ok(f.tick(400, here), 'reached');
  assert.deepStrictEqual([sent[0].name, sent[0].cause], ['无聊', 'ignored']);
  f.tick(5000, here);
  assert.strictEqual(sent.length, 1, 'once per stretch');
  f.interacted();
  f.tick(999, here); assert.strictEqual(sent.length, 1);
  f.tick(1, here); assert.strictEqual(sent.length, 2, 'after the owner paid attention, a new stretch');
});

test('held lines: shown when the owner is back if still fresh, missed otherwise', () => {
  const c = clock();
  const h = new Held({ now: c.now });
  h.hold('s_1', { expires_at: c.t + 600000, parts: [{ text: '在干嘛呀' }] });
  h.hold('s_2', { expires_at: c.t + 60000, parts: [{ text: '我先睡啦' }] });
  c.add(120000);
  assert.deepStrictEqual(h.expire(), ['s_2'], 'past its time while away');
  h.hold('s_3', { expires_at: c.t + 1000 });
  c.add(5000);
  const r = h.release();
  assert.deepStrictEqual(r.show.map((x) => x.id), ['s_1']);
  assert.deepStrictEqual(r.missed, ['s_3']);
  assert.strictEqual(h.size, 0);
});

test('mood and quiet: known names only, level 1 to 3, mood kept 2 hours without until; quiet capped at 12 hours', () => {
  const now = 1794100000000;
  assert.strictEqual(readMood({ name: '生气', level: 1 }, now), null, 'not one of her 8');
  const m = readMood({ name: '无聊', level: 9 }, now, now);
  assert.deepStrictEqual(m, { name: '无聊', level: 3, until: 0, ts: now });
  assert.ok(moodNow(m, now + 3600000));
  assert.strictEqual(moodNow(m, now + 2 * 3600000 + 1), null);
  const u = readMood({ name: '开心', level: 1, until: now + 600000, note: '以后加的字段' }, now);
  assert.strictEqual(moodNow(u, now + 600001), null, 'until wins');
  assert.strictEqual(quietUntil(now + 3600000, now), now + 3600000);
  assert.strictEqual(quietUntil(now + 48 * 3600000, now), now + 12 * 3600000);
  assert.strictEqual(quietUntil(0, now), 0);
  assert.strictEqual(quietUntil(now - 1, now), 0);
  assert.strictEqual(ACTS.length, 18);
});

function client(fake, o = {}) {
  const box = { token: '' };
  return new LinkClient({
    url: fake.url, hello: { app_version: 'test', platform: 'linux', device_name: '测试电脑' },
    getToken: () => box.token, setToken: (t) => { box.token = t || ''; },
    timers: { backoff: [20], jitter: 0, pingMs: 60000, pongMs: 60000, welcomeMs: 2000 }, ...o,
  });
}

test('client: cmd.mood / cmd.act / cmd.quiet need their feature, otherwise not_allowed', async () => {
  const fake = await new FakeAdapter().start();
  try {
    const got = [];
    const c = client(fake, { onMood: async (d) => { got.push(d); return { ok: true }; } });
    await c.pair(fake.issueCode());
    fake.push('cmd.mood', { name: '无聊', level: 1 });
    fake.push('cmd.act', { name: '挥手打招呼' });
    fake.push('cmd.quiet', { until: Date.now() + 60000 });
    await until(() => fake.acks.length === 3, 2000, 'acks');
    assert.ok(fake.acks.every((a) => a.ok === false && a.code === 'not_allowed'), JSON.stringify(fake.acks));
    assert.strictEqual(got.length, 0, 'not acted on');
    c.stop();
  } finally { await fake.close(); }
});

test('client: with the features on they reach the pet; a held proactive line is acked with held', async () => {
  const fake = await new FakeAdapter({ features: ['presence', 'mood', 'act'] }).start();
  try {
    const seen = [];
    const c = client(fake, {
      onMood: async (d) => { seen.push(['mood', d.name]); return { ok: true }; },
      onAct: async (d) => { seen.push(['act', d.name]); return { ok: false, code: 'busy' }; },
      onQuiet: async (d) => { seen.push(['quiet', !!d.until]); return { ok: true }; },
      onSay: async (d) => (d.source === 'proactive' ? { ok: true, held: true } : { ok: true }),
    });
    await c.pair(fake.issueCode());
    fake.push('cmd.mood', { name: '无聊', level: 1 });
    fake.push('cmd.act', { name: '挥手打招呼' });
    fake.push('cmd.quiet', { until: Date.now() + 60000 });
    const say = fake.push('cmd.say', { source: 'proactive', parts: [{ text: '在吗' }], expires_at: Date.now() + 600000 });
    await until(() => fake.acks.length === 4, 2000, 'acks');
    assert.deepStrictEqual(seen, [['mood', '无聊'], ['act', '挥手打招呼'], ['quiet', true]]);
    assert.deepStrictEqual(fake.acks[1], { ref: fake.acks[1].ref, ok: false, code: 'busy' });
    const held = fake.acks.find((a) => a.ref === say.id);
    assert.deepStrictEqual(held, { ref: say.id, ok: true, held: true });
    // event.presence / event.emotion / event.say_seen: no ack, sent only while connected
    assert.ok(c.send('event.presence', { state: 'here', why: 'start', idle_s: 0, away_s: 0, watching: false }));
    assert.ok(c.send('event.say_seen', { id: say.id, shown: true, at: Date.now() }));
    await until(() => fake.received('event.say_seen').length === 1, 2000, 'say_seen');
    assert.ok(fake.received('event.presence')[0].id.startsWith('p_'));
    c.stop();
    assert.strictEqual(c.send('event.emotion', { name: '委屈', level: 1, cause: 'drop' }), '', 'offline: dropped, not queued');
    assert.strictEqual(c.state.outbox.length, 0);
  } finally { await fake.close(); }
});
