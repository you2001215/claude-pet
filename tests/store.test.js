'use strict';
// Safe JSON files: atomic writes, the .bak copy, and what happens to a file that can't be read.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const store = require('../store');

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'pet-store-'));
const readJ = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const brokenCopies = (dir, base) => fs.readdirSync(dir).filter((n) => n.startsWith(base + '.broken-'));
const tmpLeft = (dir) => fs.readdirSync(dir).filter((n) => n.endsWith('.tmp'));

test('store loads without electron', () => {
  assert.ok(!Object.keys(require.cache).some((f) => /[\\/]node_modules[\\/]electron[\\/]/.test(f)));
});

test('writeJsonSync writes the file atomically and leaves no .tmp', (t) => {
  const dir = tmpDir(); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const f = path.join(dir, 'chat.json');
  const data = { messages: [{ id: 'a', content: '你好' }] };
  store.writeJsonSync(f, data);
  assert.deepEqual(readJ(f), data);
  assert.equal(fs.readFileSync(f, 'utf8'), JSON.stringify(data, null, 1));
  assert.equal(fs.existsSync(f + '.tmp'), false);
  assert.equal(fs.existsSync(f + '.bak'), false, 'nothing to back up on the first write');
});

test('.bak holds the previous good version', (t) => {
  const dir = tmpDir(); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const f = path.join(dir, 'ai.json');
  store.writeJsonSync(f, { v: 1 });
  store.writeJsonSync(f, { v: 2 });
  assert.deepEqual(readJ(f), { v: 2 });
  assert.deepEqual(readJ(f + '.bak'), { v: 1 });
  store.writeJsonSync(f, { v: 3 });
  assert.deepEqual(readJ(f + '.bak'), { v: 2 });
  assert.equal(fs.existsSync(f + '.tmp'), false);
});

test('a broken current file is never copied over the .bak', (t) => {
  const dir = tmpDir(); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const f = path.join(dir, 'ai.json');
  store.writeJsonSync(f, { v: 1 });
  store.writeJsonSync(f, { v: 2 });
  fs.writeFileSync(f, '{"v": 2, "half');
  store.writeJsonSync(f, { v: 3 });
  assert.deepEqual(readJ(f), { v: 3 });
  assert.deepEqual(readJ(f + '.bak'), { v: 1 });
  // and the broken one is kept, not written over
  const kept = brokenCopies(dir, 'ai.json');
  assert.equal(kept.length, 1);
  assert.equal(fs.readFileSync(path.join(dir, kept[0]), 'utf8'), '{"v": 2, "half');
  assert.deepEqual(tmpLeft(dir), []);
});

test('backup: false writes no .bak', (t) => {
  const dir = tmpDir(); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const f = path.join(dir, 'x.json');
  store.writeJsonSync(f, { v: 1 }, { backup: false });
  store.writeJsonSync(f, { v: 2 }, { backup: false });
  assert.deepEqual(readJ(f), { v: 2 });
  assert.equal(fs.existsSync(f + '.bak'), false);
});

test('readJsonSync: ok and missing', (t) => {
  const dir = tmpDir(); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const f = path.join(dir, 'settings.json');
  const fallback = { size: 1 };
  assert.deepEqual(store.readJsonSync(f, fallback), { data: fallback, status: 'missing' });
  store.writeJsonSync(f, { size: 2 });
  assert.deepEqual(store.readJsonSync(f, fallback), { data: { size: 2 }, status: 'ok' });
});

test('readJsonSync: a broken file is set aside and the .bak is used', (t) => {
  const dir = tmpDir(); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const f = path.join(dir, 'chat.json');
  store.writeJsonSync(f, { messages: ['old'] });
  store.writeJsonSync(f, { messages: ['old', 'new'] });
  fs.writeFileSync(f, '{"messages": ["old", "ne');   // power cut in the middle of a write
  const r = store.readJsonSync(f, { messages: [] });
  assert.equal(r.status, 'recovered');
  assert.deepEqual(r.data, { messages: ['old'] });
  const copies = brokenCopies(dir, 'chat.json');
  assert.equal(copies.length, 1);
  assert.match(copies[0], /^chat\.json\.broken-\d{8}-\d{6}/);
  assert.equal(fs.readFileSync(path.join(dir, copies[0]), 'utf8'), '{"messages": ["old", "ne', 'the broken file is kept as it was');
  assert.deepEqual(readJ(f + '.bak'), { messages: ['old'] }, 'the backup is left alone');
});

test('readJsonSync: a broken file without .bak gives the fallback and is still kept', (t) => {
  const dir = tmpDir(); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const f = path.join(dir, 'reminders.json');
  fs.writeFileSync(f, 'not json at all');
  const r = store.readJsonSync(f, []);
  assert.equal(r.status, 'broken');
  assert.deepEqual(r.data, []);
  assert.equal(brokenCopies(dir, 'reminders.json').length, 1);
  // saving afterwards must not bring the broken text back as a backup
  store.writeJsonSync(f, [{ at: 1 }]);
  assert.deepEqual(readJ(f), [{ at: 1 }]);
  assert.equal(fs.existsSync(f + '.bak'), false);
});

test('readJsonSync: a missing file with a .bak is recovered from it', (t) => {
  const dir = tmpDir(); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const f = path.join(dir, 'voice.json');
  fs.writeFileSync(f + '.bak', JSON.stringify({ engine: 'edge' }));
  const r = store.readJsonSync(f, {});
  assert.equal(r.status, 'recovered');
  assert.deepEqual(r.data, { engine: 'edge' });
});

test('async readJson rejects with ENOENT or EBROKEN', async (t) => {
  const dir = tmpDir(); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const f = path.join(dir, '记忆.json');
  await assert.rejects(store.readJson(f), (e) => e.code === 'ENOENT');
  fs.writeFileSync(f, '{"memories": [');
  await assert.rejects(store.readJson(f), (e) => e.code === 'EBROKEN');
  fs.writeFileSync(f, '{"memories": []}');
  assert.deepEqual(await store.readJson(f), { memories: [] });
});

test('async readJson: the EBROKEN message says where, never what (it may reach a diagnostics report)', async (t) => {
  const dir = tmpDir(); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const f = path.join(dir, '记忆.json');
  // a trailing comma: V8 quotes the end of the file in its own message
  fs.writeFileSync(f, '{"memories": [{"text": "我家猫叫小橘子"},]}');
  await assert.rejects(store.readJson(f), (e) => e.code === 'EBROKEN' && e.path === f && !e.message.includes('小橘子'));
  fs.writeFileSync(f, '{\n "a": 1\n "b": 2}');
  await assert.rejects(store.readJson(f), (e) => /第 3 行第 2 列/.test(e.message));
});

test('overlapping async writes of one file never leave it broken', async (t) => {
  const dir = tmpDir(); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const f = path.join(dir, '聊天记录.json');
  const big = { messages: Array.from({ length: 300 }, (_, i) => ({ id: 'a' + i, content: 'x'.repeat(50) })) };
  const small = { messages: [{ id: 'b' }] };
  for (let i = 0; i < 30; i++) {
    const r = await Promise.allSettled([store.writeJson(f, big), store.writeJson(f, small)]);
    assert.deepEqual(r.map((x) => x.status), ['fulfilled', 'fulfilled']);
    readJ(f);
  }
  assert.deepEqual(tmpLeft(dir), []);
});

test('a file that was locked at load is not written over, and is kept once it can be read', (t) => {
  const dir = tmpDir(); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const f = path.join(dir, 'chat.json');
  fs.writeFileSync(f, JSON.stringify({ notes: ['真的'] }));
  const read = fs.readFileSync;
  let locked = true;
  fs.readFileSync = function (p, ...a) { if (locked && p === f) throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' }); return read.call(this, p, ...a); };
  try {
    const r = store.readJsonSync(f, null);
    assert.equal(r.status, 'broken');
    assert.throws(() => store.writeJsonSync(f, { notes: [] }), /先不覆盖/);
  } finally { locked = false; fs.readFileSync = read; }
  assert.deepEqual(readJ(f), { notes: ['真的'] });
  store.writeJsonSync(f, { notes: [] });
  const kept = brokenCopies(dir, 'chat.json');
  assert.equal(kept.length, 1);
  assert.deepEqual(readJ(path.join(dir, kept[0])), { notes: ['真的'] });
});

test('async writeJson is atomic and keeps no .bak (the shared folder is synced)', async (t) => {
  const dir = tmpDir(); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const f = path.join(dir, '聊天记录.json');
  await store.writeJson(f, { messages: [1] });
  await store.writeJson(f, { messages: [1, 2] });
  assert.deepEqual(readJ(f), { messages: [1, 2] });
  assert.equal(fs.readFileSync(f, 'utf8'), JSON.stringify({ messages: [1, 2] }, null, 1));
  assert.equal(fs.existsSync(f + '.tmp'), false);
  assert.equal(fs.existsSync(f + '.bak'), false);
});
