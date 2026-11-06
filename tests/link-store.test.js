'use strict';
// link/index.js: settings, the encrypted token, images checked by sha256, the snapshot (no electron needed).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { FakeAdapter } = require('./link/fake-adapter');

// a stand-in for electron's safeStorage: reversible, but not plain text
const fakeSafe = {
  isEncryptionAvailable: () => true,
  encryptString: (s) => Buffer.from([...Buffer.from(s, 'utf8')].map((b) => b ^ 0x5a)),
  decryptString: (b) => Buffer.from([...b].map((x) => x ^ 0x5a)).toString('utf8'),
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 3000) { const end = Date.now() + ms; while (Date.now() < end) { if (fn()) return; await sleep(10); } throw new Error('timeout'); }
const fresh = () => { delete require.cache[require.resolve('../link/index.js')]; return require('../link/index.js'); };

test('off by default; pairing stores the token encrypted; unpair forgets it', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'petlink-'));
  const fake = await new FakeAdapter().start();
  try {
    const link = fresh();
    link.init({ userData: dir, safeStorage: fakeSafe, appVersion: '1.7.0', timers: { backoff: [20], jitter: 0 } });
    assert.strictEqual(link.getConfig().enabled, false);
    assert.strictEqual(link.online(), false);
    assert.ok(!link.setConfig({ url: 'ws://example.com/x' }).ok, 'plain ws:// to the internet is refused');
    assert.ok(link.setConfig({ url: fake.url }).ok);
    const r = await link.pair(fake.issueCode());
    assert.ok(r.ok, r.error);
    assert.ok(link.online());
    const saved = JSON.parse(fs.readFileSync(path.join(dir, 'link.json'), 'utf8'));
    assert.strictEqual(saved.enabled, true);
    assert.strictEqual(saved.token.plain, false);
    const token = fakeSafe.decryptString(Buffer.from(saved.token.blob, 'base64'));
    assert.ok(token.length >= 40);
    assert.ok(!fs.readFileSync(path.join(dir, 'link.json'), 'utf8').includes(token), 'token is not in the file as plain text');
    assert.ok(!JSON.stringify(link.diagnostics()).includes(token));
    const bad = await link.pair('999999');
    assert.ok(!bad.ok && /配对码不对/.test(bad.error));
    link.unpair();
    assert.strictEqual(link.paired(), false);
    link.stop();
  } finally { await fake.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('images: kept only when the sha256 matches, the type is known and the size is small', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'petlink-'));
  try {
    const link = fresh();
    link.init({ userData: dir, safeStorage: fakeSafe });
    const buf = Buffer.from('GIF89a-test');
    const sha = crypto.createHash('sha256').update(buf).digest('hex');
    const ok = link.toReply([{ text: '看' }, { image: { mime: 'image/gif', sha256: sha, size: buf.length, data: buf.toString('base64') } }]);
    assert.strictEqual(ok.text, '看');
    assert.strictEqual(ok.stickers.length, 1);
    assert.strictEqual(ok.stickers[0].url, `app://pet/linkmedia/${sha}.gif`);
    assert.ok(fs.existsSync(link.mediaPath(`${sha}.gif`)));
    const wrong = link.toReply([{ image: { mime: 'image/gif', sha256: '0'.repeat(64), size: buf.length, data: buf.toString('base64') } }]);
    assert.strictEqual(wrong.stickers.length, 0, 'sha256 mismatch is dropped');
    const odd = link.toReply([{ image: { mime: 'text/html', sha256: sha, size: buf.length, data: buf.toString('base64') } }]);
    assert.strictEqual(odd.stickers.length, 0, 'unknown type is dropped');
    const big = Buffer.alloc(800 * 1024, 1);
    const huge = link.toReply([{ image: { mime: 'image/png', sha256: crypto.createHash('sha256').update(big).digest('hex'), size: big.length, data: big.toString('base64') } }]);
    assert.strictEqual(huge.stickers.length, 0, 'over 700 KB is dropped');
    assert.strictEqual(link.mediaPath('../link.json'), '');
    assert.strictEqual(link.mediaPath('abc.gif'), '');
    assert.deepStrictEqual(link.toReply([]), { text: '', stickers: [] }, 'an empty reply shows nothing');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the snapshot is kept on disk, only the newest one', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'petlink-'));
  const fake = await new FakeAdapter().start();
  try {
    let link = fresh();
    link.init({ userData: dir, safeStorage: fakeSafe, timers: { backoff: [20], jitter: 0 } });
    link.setConfig({ url: fake.url });
    await link.pair(fake.issueCode());
    fake.push('snapshot.data', { made_at: 1, profile: '旧的' });
    fake.push('snapshot.data', { made_at: 2, profile: '新的', recent: [{ ts: 1, side: 'qq', who: 'user', text: '晚安' }] });
    await until(() => fake.acks.length === 2);
    link.stop();
    link = fresh();
    link.init({ userData: dir, safeStorage: fakeSafe });
    assert.strictEqual(link.getSnapshot().profile, '新的');
    assert.strictEqual(link.getSnapshot().recent[0].text, '晚安');
    link.stop();
  } finally { await fake.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
