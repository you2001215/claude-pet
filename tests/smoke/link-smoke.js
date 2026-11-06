'use strict';
// Runs inside the unpackaged app (PET_TEST=this file, through scripts/smoke-test.js tests/smoke/link-smoke.js) and
// walks through the desktop link to 「阿鲸」 against the fake adapter (tests/link/fake-adapter.js), never a real bot:
// pairing from the settings page, a chat through her, a reminder and a sticker she sends, the snapshot, the pet's own
// AI staying quiet while connected, and falling back when she's gone. Writes { ok, checks, ... } to PET_SMOKE_OUT.
// PET_SMOKE_SHOTS=<folder> also saves screenshots of the chat window and the settings card there.
const { app, webContents } = require('electron');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { FakeAdapter } = require('../link/fake-adapter');

const OUT = process.env.PET_SMOKE_OUT || path.join(app.getPath('userData'), 'smoke-result.json');
const SHOTS = process.env.PET_SMOKE_SHOTS || '';
const HARD_MS = 150000;
const checks = [], consoleErrors = [], problems = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const short = (v) => (typeof v === 'string' ? v : JSON.stringify(v)).slice(0, 300);

function watch(wc) {
  const where = () => { try { return wc.getURL().split('/').pop() || wc.getURL(); } catch (_) { return '?'; } };
  wc.on('console-message', (e, level, message) => {
    const lv = e && e.level !== undefined ? e.level : level;
    if (lv === 'error' || lv === 3) consoleErrors.push(`[${where()}] ${(e && e.message) || message}`);
  });
  wc.on('render-process-gone', (_e, d) => problems.push(`render process gone [${where()}]: ${JSON.stringify(d)}`));
  wc.on('preload-error', (_e, p, err) => problems.push(`preload error ${p}: ${err && err.message}`));
}
for (const wc of webContents.getAllWebContents()) watch(wc);
app.on('web-contents-created', (_e, wc) => watch(wc));

async function until(fn, ms = 5000, every = 100) {
  const end = Date.now() + ms;
  let v;
  for (;;) {
    try { v = await fn(); } catch (_) { v = undefined; }
    if (v || Date.now() > end) return v;
    await sleep(every);
  }
}
async function waitLoad(w) {
  if (w && w.webContents.isLoading()) await Promise.race([new Promise((r) => w.webContents.once('did-finish-load', r)), sleep(15000)]);
}
const withTimeout = (p, ms, what) => Promise.race([p, sleep(ms).then(() => { throw new Error(`${what} took longer than ${ms / 1000} s`); })]);
async function check(name, fn) {
  try {
    const r = await withTimeout(Promise.resolve().then(fn), 30000, name);
    checks.push({ name, ok: r.ok === null ? null : !!r.ok, detail: short(r.detail === undefined ? '' : r.detail) });
  } catch (e) { checks.push({ name, ok: false, detail: short(String((e && e.stack) || e)) }); }
}
async function shot(w, name) {
  if (!SHOTS || !w) return;
  try { fs.mkdirSync(SHOTS, { recursive: true }); fs.writeFileSync(path.join(SHOTS, name), (await w.webContents.capturePage()).toPNG()); } catch (_) {}
}
const readErrorLog = () => { try { return fs.readFileSync(path.join(app.getPath('userData'), 'error.log'), 'utf8'); } catch (_) { return ''; } };
let finished = false;
function finish(extra = {}) {
  if (finished) return;
  finished = true;
  const errorLog = readErrorLog();
  const failed = checks.filter((c) => c.ok === false).length;
  const result = {
    ok: !failed && !consoleErrors.length && !problems.length && !errorLog.trim() && !extra.timeout,
    platform: `${process.platform} ${process.arch}`, electron: process.versions.electron, version: app.getVersion(),
    checks, consoleErrors, problems, errorLog: errorLog.slice(-4000), ...extra,
  };
  try { fs.writeFileSync(OUT, JSON.stringify(result, null, 1)); } catch (e) { console.error('smoke: cannot write result', e); }
  app.exit(0);
}

module.exports = async (getWin) => {
  const hard = setTimeout(() => finish({ timeout: true }), HARD_MS);
  const fake = await new FakeAdapter({ answer: (t) => [{ text: `（假阿鲸）收到：${t}` }] }).start();
  try {
    const P = global.__pet;
    const L = P.link;
    const w = await until(() => getWin(), 15000);
    await waitLoad(w);
    const pet = () => w.webContents.executeJavaScript('window.__pet ? window.__pet.bubble : ""', true);
    // her replies are read aloud like the pet's own; a test machine may not reach the Edge voice, so stay quiet here
    P.voice.setMuted(true);
    await sleep(6000);    // let the start-up greeting finish

    await check('连接默认关着', async () => {
      const c = L.getConfig();
      return { ok: !c.enabled && !c.paired && !L.online(), detail: `enabled=${c.enabled} status=${c.status}` };
    });

    let sw = null;
    await check('设置页里配对（打开开关、填配对码）', async () => {
      L.setConfig({ url: fake.url });
      P.openSettings();
      sw = await until(() => P.settingsWin(), 5000);
      await waitLoad(sw);
      await until(() => sw.webContents.executeJavaScript('!!document.getElementById("linkOn")'), 5000);
      const code = fake.issueCode();
      await sw.webContents.executeJavaScript(`(() => { const on = document.getElementById('linkOn'); on.checked = true; on.dispatchEvent(new Event('change')); return 1; })()`);
      await until(() => sw.webContents.executeJavaScript(`getComputedStyle(document.getElementById('linkBody')).display !== 'none'`), 3000);
      await sw.webContents.executeJavaScript(`(() => { document.getElementById('linkCode').value = '${code}'; document.getElementById('linkPair').click(); return 1; })()`);
      const state = await until(() => sw.webContents.executeJavaScript(`(() => { const t = document.getElementById('linkState').textContent; return t.includes('已连上') ? t : ''; })()`), 8000);
      const msg = await sw.webContents.executeJavaScript(`document.getElementById('linkMsg').textContent`);
      await sw.webContents.executeJavaScript(`document.getElementById('linkCard').scrollIntoView(); 1`);
      await sleep(300);
      await shot(sw, '设置页-连接阿鲸.png');
      return { ok: !!state && L.online(), detail: `${state || '没连上'} / ${msg}` };
    });

    await check('钥匙存在本机（Windows、Mac 上加密），界面和诊断信息里都没有', async () => {
      const raw = fs.readFileSync(path.join(app.getPath('userData'), 'link.json'), 'utf8');
      const j = JSON.parse(raw);
      const page = await sw.webContents.executeJavaScript('document.body.innerText');
      const diag = await P.diagnosticsText();
      const tokenHashes = [...fake.devices.keys()];
      const leaks = [raw, page, diag].some((t) => tokenHashes.some((h) => t.includes(h)));
      return { ok: !!(j.token && j.token.blob) && !leaks && !/token|令牌：/i.test(page) && diag.includes('连接阿鲸'), detail: `plain=${j.token && j.token.plain}` };
    });

    let cw = null;
    await check('在聊天窗里说话，回答来自阿鲸', async () => {
      P.openChat();
      cw = await until(() => P.chatWin(), 5000);
      await waitLoad(cw);
      await until(() => cw.webContents.executeJavaScript('!!document.getElementById("input")'), 5000);
      await cw.webContents.executeJavaScript(`(() => { document.getElementById('input').value = '你好呀'; document.getElementById('send').click(); return 1; })()`);
      const text = await until(() => cw.webContents.executeJavaScript(`(() => { const t = document.getElementById('log').innerText; return t.includes('（假阿鲸）收到：你好呀') ? t : ''; })()`), 8000);
      const sent = fake.received('chat.send').map((f) => f.data);
      return { ok: !!text && sent.length === 1 && sent[0].text === '你好呀' && sent[0].input === 'text', detail: `bot got ${JSON.stringify(sent)}` };
    });

    await check('桌宠气泡里也是阿鲸的回答', async () => {
      const b = await until(async () => { const t = await pet(); return t && t.includes('假阿鲸') ? t : ''; }, 4000);
      return { ok: !!b, detail: b || await pet() };
    });

    await check('阿鲸发来的到点提醒和表情包会显示，并回执', async () => {
      const acks0 = fake.acks.length;
      fake.push('cmd.say', { source: 'reminder', parts: [{ text: '3 点啦，去开会咯' }], expires_at: Date.now() + 60000 });
      // a WebP, as her side sends (big stickers are shrunk to WebP there)
      const png = fs.readFileSync(path.join(__dirname, '..', '..', 'assets', 'memes', '哦鲸鲸.webp'));
      fake.push('cmd.say', { source: 'sticker', parts: [{ image: { mime: 'image/webp', sha256: crypto.createHash('sha256').update(png).digest('hex'), size: png.length, data: png.toString('base64') } }], expires_at: Date.now() + 120000 });
      fake.push('cmd.say', { source: 'reminder', parts: [{ text: '过期的提醒' }], expires_at: Date.now() - 1000 });
      await until(() => fake.acks.length >= acks0 + 3, 5000);
      const text = await until(() => cw.webContents.executeJavaScript(`(() => { const t = document.getElementById('log').innerText; return t.includes('3 点啦') ? t : ''; })()`), 5000);
      const img = await until(() => cw.webContents.executeJavaScript(`(() => { const i = [...document.querySelectorAll('#log img.sticker')].find((x) => x.src.includes('linkmedia')); return i && i.naturalWidth > 0 ? i.src : ''; })()`), 5000);
      const acks = fake.acks.slice(acks0);
      const expired = acks.find((a) => a.code === 'expired');
      await sleep(400);
      await shot(cw, '聊天窗-连着阿鲸.png');
      return { ok: !!text && !!img && !!expired && !text.includes('过期的提醒'), detail: `acks=${JSON.stringify(acks)}` };
    });

    await check('快照存在本机', async () => {
      const acks0 = fake.acks.length;
      fake.push('snapshot.data', { made_at: Date.now(), profile: '（测试用）主人喜欢猫', diary: [{ date: '2026-11-06', text: '今天一起聊了桌宠' }], recent: [{ ts: Date.now(), side: 'qq', who: 'user', text: '晚上吃火锅' }] });
      await until(() => fake.acks.length > acks0, 5000);
      const f = path.join(app.getPath('userData'), 'link-snapshot.json');
      return { ok: fs.existsSync(f) && L.getSnapshot().profile.includes('猫'), detail: f.replace(app.getPath('userData'), '~') };
    });

    await check('连着阿鲸时，桌宠自己的 AI 不主动开口（闲聊、「你回来啦」不说；休息用固定台词）', async () => {
      const chat = await P.speakUp('chat');
      const back = await P.speakUp('return', { awayMin: 30 });
      const rest = await P.speakUp('rest', { activeMin: 50 });
      const b = await pet();
      const whisper = await w.webContents.executeJavaScript('window.pet.whisperAI({ action: "" })');
      return { ok: chat === false && back === false && rest === true && whisper && whisper.reason === 'linked', detail: `chat=${chat} return=${back} rest=${rest} bubble=${b} whisper=${JSON.stringify(whisper)}` };
    });

    await check('深夜问睡觉：报给阿鲸、两边合起来算', async () => {
      const slot = '2026-11-06/night';
      fake.push('event.care', { kind: 'sleep', slot, action: 'state', asked_qq: 1, asked_desktop: 0, answered: false, stopped: false, limit: 2 });
      await sleep(300);
      const before = L.careAllowed('sleep', slot);
      L.care('sleep', slot, 'asked');
      await until(() => fake.received('event.care').length > 0, 3000);
      const after = L.careAllowed('sleep', slot);
      return { ok: before && !after && fake.received('event.care')[0].data.side === 'desktop', detail: `before=${before} after=${after}` };
    });

    await check('阿鲸断开以后：设置页显示不在线，桌宠退回自己', async () => {
      await fake.close();
      const st = await until(() => sw.webContents.executeJavaScript(`(() => { const t = document.getElementById('linkState').textContent; return t.includes('不在线') ? t : ''; })()`), 8000);
      return { ok: !!st && L.away() && !L.online(), detail: st };
    });

    await check('没连上时聊天（没有 DeepSeek Key）：给出提示，不卡住', async () => {
      await cw.webContents.executeJavaScript(`(() => { document.getElementById('input').value = '还在吗'; document.getElementById('send').click(); return 1; })()`);
      const t = await until(() => cw.webContents.executeJavaScript(`(() => { const e = [...document.querySelectorAll('#log .msg.error')].pop(); return e ? e.textContent : ''; })()`), 8000);
      return { ok: !!t, detail: t };
    });
  } catch (e) {
    checks.push({ name: '测试脚本', ok: false, detail: short(String((e && e.stack) || e)) });
  } finally {
    clearTimeout(hard);
    try { await fake.close(); } catch (_) {}
    finish();
  }
};
