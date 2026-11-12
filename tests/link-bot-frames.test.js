'use strict';
// The frames the real AstrBot desktop adapter sent in its own test run (tests/link/bot-frames.json, made-up content),
// replayed as they are to the pet's link code: does the pet read every one of them the way the spec says?
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const P = require('../link/protocol');

const BOT = JSON.parse(fs.readFileSync(path.join(__dirname, 'link', 'bot-frames.json'), 'utf8'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// a care slot's day moves with the frame's time, like its ts (the pet forgets counts older than 3 days)
const shiftSlot = (slot, d) => String(slot).replace(/^(\d{4}-\d\d-\d\d)/, (day) => P.careDay(Date.parse(day + 'T12:00:00') + d));
async function until(fn, ms = 3000) { const end = Date.now() + ms; while (Date.now() < end) { if (fn()) return; await sleep(10); } throw new Error('timeout'); }
const fakeSafe = {
  isEncryptionAvailable: () => true,
  encryptString: (s) => Buffer.from([...Buffer.from(s, 'utf8')].map((b) => b ^ 0x5a)),
  decryptString: (b) => Buffer.from([...b].map((x) => x ^ 0x5a)).toString('utf8'),
};

// a server that answers with the bot's own frames, only ids and times changed to fit this run
async function replayServer() {
  const got = [];
  const server = http.createServer();
  const wss = new WebSocketServer({ server });
  let sock = null;
  const now = Date.now();
  const shift = (f) => {
    const g = JSON.parse(JSON.stringify(f));
    const d = now - f.ts;
    g.ts += d;
    if (g.data.expires_at) g.data.expires_at += d;
    if (g.data.made_at) g.data.made_at += d;
    if (g.data.server_time) g.data.server_time += d;
    if (g.data.slot) g.data.slot = shiftSlot(g.data.slot, d);
    return g;
  };
  wss.on('connection', (ws) => {
    sock = ws;
    ws.on('message', (raw) => {
      const f = JSON.parse(String(raw));
      got.push(f);
      if (f.type === 'hello') {
        const w = shift(BOT.welcome);
        w.data.token = crypto.randomBytes(32).toString('base64url');   // the placeholder stands for 43 chars of base64url
        ws.send(JSON.stringify(w));
      } else if (f.type === 'chat.send') {
        ws.send(JSON.stringify({ v: 1, type: 'ack', id: 'a_' + f.id, ts: Date.now(), data: { ref: f.id, ok: true } }));
        const r = shift(f.data.text === '出错吧' ? BOT['chat.error'] : BOT['chat.done']);
        r.data.reply_to = f.id;
        if (r.data.merged) r.data.merged = [f.id];
        ws.send(JSON.stringify(r));
      }
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    url: `ws://127.0.0.1:${server.address().port}/desktop/v1`, got, now,
    send: (name) => sock.send(JSON.stringify(shift(BOT[name]))),
    acks: () => got.filter((f) => f.type === 'ack').map((f) => f.data),
    close: async () => { for (const c of wss.clients) c.terminate(); await new Promise((r) => wss.close(r)); await new Promise((r) => server.close(r)); },
  };
}

test("the bot's own frames: welcome, chat.done, chat.error, cmd.say (reminder, sticker), care state, snapshot", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'petlink-'));
  const srv = await replayServer();
  const said = [];
  try {
    delete require.cache[require.resolve('../link/index.js')];
    const link = require('../link/index.js');
    link.init({ userData: dir, safeStorage: fakeSafe, timers: { backoff: [20], jitter: 0 }, onSay: async (d) => { said.push(d); return { ok: true }; } });
    link.setConfig({ url: srv.url });

    // welcome (pairing): token kept, limits and the reply time-out taken
    const pr = await link.pair('123456');
    assert.ok(pr.ok, pr.error);
    assert.ok(link.online() && link.paired());
    assert.strictEqual(link.getConfig().deviceTail, '7f3a');

    // chat.done: her text and emotion
    const r = await link.chat('今天好累啊');
    assert.strictEqual(r.kind, 'done');
    assert.deepStrictEqual(link.toReply(r.data.parts), { text: '（她回的一句，编的）', stickers: [] });
    assert.deepStrictEqual(P.emotionOf(r.data.emotion), { name: '开心', level: 2 });

    // chat.error: model_failed, retry -> the pet answers by itself
    await assert.rejects(link.chat('出错吧'), (e) => e.code === 'model_failed' && e.retry === true);

    // cmd.say reminder and sticker: handled once each and acked ok; the 1-pixel PNG passes its sha256 check
    srv.send('cmd.say reminder');
    srv.send('cmd.say sticker');
    await until(() => srv.acks().length === 2);
    assert.ok(srv.acks().every((a) => a.ok === true));
    assert.strictEqual(said[0].source, 'reminder');
    assert.ok(said[0].expires_at > Date.now(), 'expires_at is in milliseconds');
    assert.strictEqual(link.toReply(said[0].parts).text, '（到点提醒：三点开会别忘了，编的）');
    const st = link.toReply(said[1].parts);
    assert.strictEqual(said[1].source, 'sticker');
    assert.strictEqual(st.stickers.length, 1, 'the sticker image is accepted');
    assert.ok(fs.existsSync(link.mediaPath(st.stickers[0].url.split('/').pop())));

    // event.care state: QQ 0 + desktop 1 of 2 -> one more is allowed
    srv.send('event.care state');
    await until(() => srv.acks().length === 3);
    const careFrame = BOT['event.care state'];
    const night = shiftSlot(careFrame.data.slot, srv.now - careFrame.ts);
    assert.ok(link.careAllowed('sleep', night));
    link.care('sleep', night, 'asked');
    assert.ok(!link.careAllowed('sleep', night), 'and then that was the last one');

    // snapshot.data: kept, filtered counts not needed
    srv.send('snapshot.data');
    await until(() => srv.acks().length === 4);
    const snap = link.getSnapshot();
    assert.strictEqual(snap.profile, '（小抄，编的一句）');
    assert.strictEqual(snap.weekly[0].week, '2026-W45');
    assert.strictEqual(snap.recent[0].who, 'user');
    link.stop();
  } finally { await srv.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
