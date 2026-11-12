'use strict';
// Runs inside the unpackaged app (node scripts/smoke-test.js tests/smoke/presence-smoke.js) and walks through phase 3
// (docs/桌面连接接口说明.md section 17) against the fake adapter: at the computer or not (event.presence, the front
// window as far as the owner allows), her proactive lines held while away (event.say_seen), 「别吵我」 (cmd.quiet),
// the pet's body stimuli (event.emotion), her mood (cmd.mood) and the actions she asks for (cmd.act).
// The mouse and the lock screen are played by the test hooks: there is no real owner on a test machine.
const { app, webContents } = require('electron');
const fs = require('fs');
const path = require('path');
const { FakeAdapter } = require('../link/fake-adapter');

const OUT = process.env.PET_SMOKE_OUT || path.join(app.getPath('userData'), 'smoke-result.json');
const SHOTS = process.env.PET_SMOKE_SHOTS || '';
const HARD_MS = 150000;
const checks = [], consoleErrors = [], problems = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const short = (v) => (typeof v === 'string' ? v : JSON.stringify(v)).slice(0, 300);
function watchWc(wc) {
  const where = () => { try { return wc.getURL().split('/').pop() || wc.getURL(); } catch (_) { return '?'; } };
  wc.on('console-message', (e, level, message) => { const lv = e && e.level !== undefined ? e.level : level; if (lv === 'error' || lv === 3) consoleErrors.push(`[${where()}] ${(e && e.message) || message}`); });
  wc.on('render-process-gone', (_e, d) => problems.push(`render process gone [${where()}]: ${JSON.stringify(d)}`));
}
for (const wc of webContents.getAllWebContents()) watchWc(wc);
app.on('web-contents-created', (_e, wc) => watchWc(wc));
async function until(fn, ms = 5000, every = 100) {
  const end = Date.now() + ms;
  let v;
  for (;;) { try { v = await fn(); } catch (_) { v = undefined; } if (v || Date.now() > end) return v; await sleep(every); }
}
async function waitLoad(w) { if (w && w.webContents.isLoading()) await Promise.race([new Promise((r) => w.webContents.once('did-finish-load', r)), sleep(15000)]); }
const withTimeout = (p, ms, what) => Promise.race([p, sleep(ms).then(() => { throw new Error(`${what} took longer than ${ms / 1000} s`); })]);
async function check(name, fn) {
  if (process.env.PET_SMOKE_TRACE) console.log('[smoke] ' + name);
  try { const r = await withTimeout(Promise.resolve().then(fn), 30000, name); checks.push({ name, ok: r.ok === null ? null : !!r.ok, detail: short(r.detail === undefined ? '' : r.detail) }); } catch (e) { checks.push({ name, ok: false, detail: short(String((e && e.stack) || e)) }); }
}
async function shot(w, name) { if (!SHOTS || !w) return; try { fs.mkdirSync(SHOTS, { recursive: true }); fs.writeFileSync(path.join(SHOTS, name), (await w.webContents.capturePage()).toPNG()); } catch (_) {} }
const readErrorLog = () => { try { return fs.readFileSync(path.join(app.getPath('userData'), 'error.log'), 'utf8'); } catch (_) { return ''; } };
let finished = false;
function finish(extra = {}) {
  if (finished) return;
  finished = true;
  const errorLog = readErrorLog();
  const failed = checks.filter((c) => c.ok === false).length;
  const result = { ok: !failed && !consoleErrors.length && !problems.length && !errorLog.trim() && !extra.timeout, platform: `${process.platform} ${process.arch}`, electron: process.versions.electron, version: app.getVersion(), checks, consoleErrors, problems, errorLog: errorLog.slice(-4000), ...extra };
  try { fs.writeFileSync(OUT, JSON.stringify(result, null, 1)); } catch (e) { console.error('smoke: cannot write result', e); }
  app.exit(0);
}


module.exports = async (getWin) => {
  const hard = setTimeout(() => finish({ timeout: true }), HARD_MS);
  const fake = await new FakeAdapter({ features: ['presence', 'mood', 'act'], answer: (t) => [{ text: `（假阿鲸）收到：${t}` }] }).start();
  try {
    const P = global.__pet;
    const L = P.link;
    const w = await until(() => getWin(), 15000);
    await waitLoad(w);
    P.voice.setMuted(true);
    await sleep(6000);
    const pet = (expr) => w.webContents.executeJavaScript(expr, true);
    const bubble = () => pet('window.__pet ? window.__pet.bubble : ""');
    const presenceFrames = () => fake.received('event.presence');
    const emotions = (cause) => fake.received('event.emotion').filter((f) => !cause || f.data.cause === cause);
    const ackOf = (f) => until(() => fake.acks.find((a) => a.ref === f.id), 3000);
    // the owner: at the keyboard, nothing locked; the front window is played by a fixed value
    P.sys.idle = 0;
    P.presence.mergeMs = 0;
    P.frontCheck.at = Date.now() + 3600000;
    P.frontCheck.v = { app: 'TestApp', title: '测试窗口：周报.docx' };

    await check('连上（她那边开了 presence、mood、act）：先报一次在不在，带程序名和窗口标题', async () => {
      L.setConfig({ url: fake.url, enabled: true });
      const pr = await L.pair(fake.issueCode());
      const f = await until(() => presenceFrames()[0], 5000);
      const d = f && f.data;
      return { ok: pr.ok && d && d.state === 'here' && d.why === 'start' && d.front && d.front.app === 'TestApp' && d.front.title === '测试窗口：周报.docx', detail: JSON.stringify(d) };
    });

    await check('锁屏立刻算不在（不带程序名）；解锁回来报离开了多久', async () => {
      const n0 = presenceFrames().length;
      P.sys.locked = true; await P.presenceTick();
      const away = await until(() => presenceFrames()[n0], 3000);
      await sleep(1100);
      P.sys.locked = false; await P.presenceTick();
      const back = await until(() => presenceFrames()[n0 + 1], 3000);
      return { ok: away && away.data.state === 'away' && away.data.why === 'locked' && !away.data.front && back && back.data.state === 'here' && back.data.away_s >= 1, detail: `${JSON.stringify(away && away.data)} / ${JSON.stringify(back && back.data)}` };
    });

    await check('关掉「窗口标题」：只报程序名；10 分钟没动算不在', async () => {
      L.setConfig({ shareTitle: false });
      P.frontCheck.v = { app: 'OtherApp', title: '不该被报出去的标题' };
      const n0 = presenceFrames().length;
      await P.presenceTick();
      const f = await until(() => presenceFrames()[n0], 3000);
      P.sys.idle = 700; await P.presenceTick();
      const idle = await until(() => presenceFrames()[n0 + 1], 3000);
      P.sys.idle = 0; await P.presenceTick();
      L.setConfig({ shareTitle: true });
      const leaked = JSON.stringify(fake.got).includes('不该被报出去的标题');
      return { ok: f && f.data.why === 'front' && f.data.front.app === 'OtherApp' && !('title' in f.data.front) && !leaked && idle && idle.data.why === 'idle', detail: `${JSON.stringify(f && f.data)} / ${idle && idle.data.why}` };
    });

    await check('她主动找你时你刚好走开：回执 held，回来才显示并告诉她看到了；过期的告诉她没看到', async () => {
      P.sys.locked = true; await P.presenceTick();
      const a = fake.push('cmd.say', { source: 'proactive', parts: [{ text: '你去哪儿啦～' }], expires_at: Date.now() + 600000 });
      const b = fake.push('cmd.say', { source: 'proactive', parts: [{ text: '这句会过期' }], expires_at: Date.now() + 800 });
      const ackA = await ackOf(a), ackB = await ackOf(b);
      const early = await bubble();
      await sleep(1200);
      await P.presenceTick();                                   // still away: the short one has expired
      const missed = await until(() => fake.received('event.say_seen').find((f) => f.data.id === b.id), 3000);
      P.sys.locked = false; await P.presenceTick();
      const shown = await until(async () => { const t = await bubble(); return t && t.includes('你去哪儿啦') ? t : ''; }, 6000);
      const seen = await until(() => fake.received('event.say_seen').find((f) => f.data.id === a.id), 3000);
      return { ok: ackA && ackA.held === true && ackB && ackB.held === true && !String(early).includes('你去哪儿啦') && missed && missed.data.shown === false && !!shown && seen && seen.data.shown === true,
        detail: `acks=${JSON.stringify([ackA, ackB])} missed=${JSON.stringify(missed && missed.data)} seen=${JSON.stringify(seen && seen.data)}` };
    });

    await check('「别吵我」：回执 ok、存下来（最多 12 小时）、碎碎念不说；until 0 恢复', async () => {
      await sleep(5500);                                        // the line before is still "being said"
      const q = fake.push('cmd.quiet', { until: Date.now() + 48 * 3600000 });
      const ack = await ackOf(q);
      const until1 = L.quietUntil();
      const capped = until1 > Date.now() && until1 <= Date.now() + 12 * 3600000 + 1000;
      const inPet = await until(() => pet('window.__pet.quietUntil'), 2000);
      // a bubble gone in 50 ms leaves nothing on screen; then she may mutter (or not)
      const quietBubble = async () => { await pet(`window.__pet.say('.', 0.05); 1`); await sleep(600); await pet('window.__pet.whisperNow(); 1'); await sleep(500); return bubble(); };
      const during = await quietBubble();
      const stored = JSON.parse(fs.readFileSync(path.join(app.getPath('userData'), 'link.json'), 'utf8')).quietUntil;
      const off = fake.push('cmd.quiet', { until: 0 });
      await ackOf(off);
      const petCleared = await until(async () => !(await pet('window.__pet.quietUntil')), 2000);
      const afterwards = await quietBubble();                   // the control: without quiet time she does mutter
      return { ok: ack && ack.ok && capped && inPet > 0 && !during && stored === until1 && !L.quietUntil() && petCleared === true && !!afterwards,
        detail: `ack=${JSON.stringify(ack)} capped=${capped} during=${JSON.stringify(during)} afterwards=${JSON.stringify(afterwards)}` };
    });

    await check('身体刺激：连戳 5 下 → 烦 2；生气时摸头 → 消气、开心 1；重摔 → 委屈 1（1 分钟内不重复）', async () => {
      for (let i = 0; i < 5; i++) { await pet('window.__pet.click(); 1'); await sleep(60); }
      const poke = await until(() => emotions('poke')[0], 3000);
      const st = await pet('window.__pet.state');
      await pet('window.__pet.pat(); 1');
      const calm = await until(() => emotions('calm')[0], 3000);
      await sleep(800);
      const calmLine = await bubble();
      P.feelings.stimulus('drop'); P.feelings.stimulus('drop');
      await until(() => emotions('drop').length > 0, 3000);
      await sleep(300);
      return { ok: poke && poke.data.name === '烦' && poke.data.level === 2 && st === 'sulk' && calm && calm.data.name === '开心' && !!calmLine && emotions('drop').length === 1,
        detail: `poke=${JSON.stringify(poke && poke.data)} state=${st} calm=${JSON.stringify(calm && calm.data)} line=${calmLine} drops=${emotions('drop').length}` };
    });

    await check('两小时没人理（在电脑前、没看视频）：无聊 1，一段只记一次', async () => {
      P.feelings.ignoredMs = 50;
      P.feelings.interacted();
      await sleep(80); await P.presenceTick();
      await sleep(80); await P.presenceTick();
      await sleep(80); await P.presenceTick();
      const n = emotions('ignored').length;
      P.feelings.ignoredMs = 2 * 3600000;
      return { ok: n === 1 && emotions('ignored')[0].data.name === '无聊', detail: `ignored=${n}` };
    });

    await check('心境：认识的回 ok、桌宠跟着变；不认识的回 invalid', async () => {
      const m = fake.push('cmd.mood', { name: '无聊', level: 2, until: Date.now() + 2 * 3600000, note: '以后可能加的字段' });
      const ack = await ackOf(m);
      const inPet = await until(() => pet('window.__pet.mood && window.__pet.mood.name'), 2000);
      const bad = fake.push('cmd.mood', { name: '生气', level: 1 });
      const ackBad = await ackOf(bad);
      return { ok: ack && ack.ok && inPet === '无聊' && ackBad && ackBad.ok === false && ackBad.code === 'invalid', detail: `${JSON.stringify(ack)} pet=${inPet} bad=${JSON.stringify(ackBad)}` };
    });

    await check('指挥动作：认识的照做；1 分钟内第二个回 rate；不认识回 unknown；主人不在回 away；过期回 expired', async () => {
      const go = (name, extra = {}) => fake.push('cmd.act', { name, expires_at: Date.now() + 60000, ...extra });
      const a1 = await ackOf(go('挥手打招呼'));
      const st = await pet('window.__pet.state');
      const a2 = await ackOf(go('吐泡泡'));
      const a3 = await ackOf(go('翻跟头'));
      P.sys.locked = true; await P.presenceTick();
      const a4 = await ackOf(go('思考中'));
      P.sys.locked = false; await P.presenceTick();
      const a5 = await ackOf(go('思考中', { expires_at: Date.now() - 1000 }));
      return { ok: a1 && a1.ok && ['wave', 'act'].includes(st) && a2.code === 'rate' && a3.code === 'unknown' && a4.code === 'away' && a5.code === 'expired',
        detail: `state=${st} ${[a1, a2, a3, a4, a5].map((a) => (a ? (a.ok ? 'ok' : a.code) : '-')).join(',')}` };
    });

    await check('设置页有「告诉阿鲸我在用什么程序」「窗口标题」两个勾，默认勾上，点了就存', async () => {
      P.openSettings();
      const sw = await until(() => P.settingsWin(), 5000);
      await waitLoad(sw);
      const both = await until(() => sw.webContents.executeJavaScript(`(() => { const a = document.getElementById('linkShareApp'), t = document.getElementById('linkShareTitle'); return a && t && a.checked && t.checked; })()`), 5000);
      await sw.webContents.executeJavaScript(`(() => { const t = document.getElementById('linkShareTitle'); t.checked = false; t.dispatchEvent(new Event('change')); return 1; })()`);
      const saved = await until(() => L.getConfig().shareTitle === false, 3000);
      L.setConfig({ shareTitle: true });
      return { ok: !!both && !!saved, detail: `both=${!!both} saved=${!!saved}` };
    });

    await check('读前台程序和窗口标题（Mac 走新的 CoreGraphics 写法；测试机没有录屏权限时标题是空的）', async () => {
      const t0 = Date.now();
      const f = await P.frontApp({ title: true });
      const ms = Date.now() - t0;
      const detail = `name=${f.name ? 'yes' : 'no'} title=${f.title ? Array.from(f.title).length + ' chars' : 'none'} ${ms} ms`;
      // only the Mac test machine is sure to have a front app; elsewhere it's just reported
      return { ok: process.platform === 'darwin' ? !!f.name && ms < 5000 : null, detail };
    });

    await check('诊断信息：有在不在、心情，没有程序名和窗口标题', async () => {
      const t = await P.diagnosticsText();
      return { ok: /在不在电脑前/.test(t) && /她的心情/.test(t) && !t.includes('TestApp') && !t.includes('周报'), detail: (t.match(/在不在电脑前[^\n]*/) || [''])[0] };
    });
  } catch (e) {
    checks.push({ name: '测试脚本', ok: false, detail: short(String((e && e.stack) || e)) });
  } finally {
    clearTimeout(hard);
    try { await fake.close(); } catch (_) {}
    finish();
  }
};
