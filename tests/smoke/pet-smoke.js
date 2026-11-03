'use strict';
// Runs inside the unpackaged app (PET_TEST=this file, started by scripts/smoke-test.js) and clicks through the
// basics: boot, the Claude outfit's reactions, switching outfits, the chat and settings windows, the navigation
// guard, error.log and renderer errors. Writes { ok, checks, ... } as JSON to PET_SMOKE_OUT and quits.
// Not a node:test file (it needs electron), so `npm test` doesn't pick it up.
const { app, webContents } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');

const OUT = process.env.PET_SMOKE_OUT || path.join(app.getPath('userData'), 'smoke-result.json');
const HARD_MS = 150000;
const ROOT = path.join(__dirname, '..', '..');
const checks = [];
const consoleErrors = [];
const problems = [];   // crashed renderers, failed page loads, preload errors
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const short = (v) => (typeof v === 'string' ? v : JSON.stringify(v)).slice(0, 300);

function watch(wc) {
  const where = () => { try { return wc.getURL().split('/').pop() || wc.getURL(); } catch (_) { return '?'; } };
  wc.on('console-message', (e, level, message) => {
    // Electron 45 passes the details on the event; older versions as arguments
    const lv = e && e.level !== undefined ? e.level : level;
    if (lv === 'error' || lv === 3) consoleErrors.push(`[${where()}] ${(e && e.message) || message}`);
  });
  wc.on('render-process-gone', (_e, d) => problems.push(`render process gone [${where()}]: ${JSON.stringify(d)}`));
  wc.on('preload-error', (_e, p, err) => problems.push(`preload error ${p}: ${err && err.message}`));
  wc.on('did-fail-load', (_e, code, desc, url, isMain) => { if (isMain && String(url).startsWith('app://')) problems.push(`load failed ${url}: ${code} ${desc}`); });
}
for (const wc of webContents.getAllWebContents()) watch(wc);
app.on('web-contents-created', (_e, wc) => watch(wc));

// poll until fn() gives something truthy (or the time is up); returns the last value
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

// one check: fn returns { ok, detail } or throws; a skipped check has ok null
async function check(name, fn) {
  try {
    const r = await withTimeout(Promise.resolve().then(fn), 30000, name);
    checks.push({ name, ok: r.ok === null ? null : !!r.ok, detail: short(r.detail === undefined ? '' : r.detail) });
  } catch (e) {
    checks.push({ name, ok: false, detail: short(String((e && e.stack) || e)) });
  }
}

const readErrorLog = () => { try { return fs.readFileSync(path.join(app.getPath('userData'), 'error.log'), 'utf8'); } catch (_) { return ''; } };
let errorLogCut = null;   // error.log length before the record-only checks, whose own log lines don't count
let finished = false;
function finish(extra = {}) {
  if (finished) return;
  finished = true;
  const fullLog = readErrorLog();
  // frontApp lines only get recorded: PowerShell may be blocked or slow on a machine, which is not a failure
  const errorLog = (errorLogCut === null ? fullLog : fullLog.slice(0, errorLogCut)).split('\n').filter((l) => !l.includes('[front-app]')).join('\n');
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
  try {
    const P = global.__pet;
    let M = {};
    try { M = JSON.parse(fs.readFileSync(path.join(ROOT, 'assets', 'claude', 'clips.json'), 'utf8')); } catch (_) {}
    const w = await until(() => getWin(), 15000);
    if (!w) throw new Error('no pet window');
    await waitLoad(w);
    const ev = (js) => w.webContents.executeJavaScript(js, true);
    const pet = () => ev('window.__pet ? { state: window.__pet.state, maid: window.__pet.maid, clip: window.__pet.claudeClip, maidClip: window.__pet.clip, bubble: window.__pet.bubble } : null');
    const show = (s) => s && `state=${s.state} clip=${s.maid ? s.maidClip : s.clip}${s.bubble ? ` bubble=${s.bubble}` : ''}`;

    await check('启动（桌宠窗口和测试钩子）', async () => {
      const s = await until(pet, 15000);
      return { ok: !!s && typeof s.state === 'string' && !!s.state, detail: show(s) || 'window.__pet missing' };
    });
    if (await ev('window.__pet && window.__pet.maid')) { P.setOutfit('claude'); await sleep(1500); }
    // on the ground before poking her (she may still be dropping in)
    await until(async () => { const s = await pet(); return s && !['fall', 'drag'].includes(s.state); }, 8000);
    // the start-up greeting (a wave about 0.6 s after boot) must be over, or it can replace the first reactions
    await sleep(1500);
    await until(async () => { const s = await pet(); return s && s.state !== 'wave'; }, 10000);

    await check('Claude 装视频能解码', async () => {
      const r = await until(() => ev(`(() => { try {
        const vs = window.ClaudeClips.layers().map((l) => l.v).filter((v) => v instanceof HTMLVideoElement);
        const v = vs.find((x) => x.readyState >= 2 && x.videoWidth > 0);
        return v ? v.videoWidth + 'x' + v.videoHeight + ' ' + decodeURIComponent(v.src.split('/').pop()) : '';
      } catch (e) { return ''; } })()`), 8000);
      return { ok: !!r, detail: r || 'no clip frame decoded (VP9 with alpha)' };
    });

    // each reaction from a calm start; the expected clip names come from assets/claude/clips.json
    const reactions = [
      ['点她', 'window.__pet.click()', (s) => s.state === 'act' && (M.clicks || []).includes(s.clip)],
      ['摸头', 'window.__pet.pat()', (s) => s.state === 'pat' && s.clip === M.pat],
      ['睡觉', 'window.__pet.sleep()', (s) => s.state === 'sleep' && s.clip === M.sleep],
      ['叫醒（起身那段）', 'window.__pet.wake()', (s) => s.state === 'act' && s.clip === M.sleep],
      ['走路', 'window.__pet.walk(1)', (s) => s.state === 'walk' && (M.walk || []).includes(s.clip)],
      ['东张西望', 'window.__pet.lookClip()', (s) => s.state === 'look' && (M.turn || []).includes(s.clip)],
    ];
    const act = Object.keys(M.acts || {})[0];
    if (act) reactions.push([`小动作（${act}）`, `window.__pet.claudeAct(${JSON.stringify(act)})`, (s) => s.state === 'act' && s.clip === act]);
    for (const [name, js, good] of reactions) {
      await check(name, async () => {
        if (!name.startsWith('叫醒')) await ev("window.__pet.setState('idle', 30)");
        await ev(js);
        const s = await until(async () => { const x = await pet(); return x && good(x) ? x : null; }, 2500);
        return { ok: !!s, detail: show(s || await pet()) };
      });
    }

    await check('换女仆装', async () => {
      P.setOutfit('maid');
      const s = await until(async () => { const x = await pet(); return x && x.maid && x.maidClip ? x : null; }, 10000);
      return { ok: !!s, detail: show(s || await pet()) };
    });
    await check('女仆装点她', async () => {
      await ev("window.__pet.setState('idle', 30)");
      const before = (await pet()).maidClip;
      await ev('window.__pet.click()');
      const s = await until(async () => { const x = await pet(); return x && x.maidClip && x.maidClip !== before ? x : null; }, 4000);
      return { ok: !!s, detail: show(s || await pet()) };
    });
    await check('换回 Claude 装', async () => {
      P.setOutfit('claude');
      const s = await until(async () => { const x = await pet(); return x && !x.maid && x.clip ? x : null; }, 10000);
      return { ok: !!s, detail: show(s || await pet()) };
    });

    let cw = null;
    await check('聊天窗', async () => {
      P.openChat();
      cw = await until(() => P.chatWin(), 5000);
      await waitLoad(cw);
      const text = await until(() => cw.webContents.executeJavaScript('(document.getElementById("log") || {}).innerText || ""'), 5000);
      return { ok: !!text && cw.webContents.getURL().startsWith('app://pet/'), detail: text.replace(/\s+/g, ' ').slice(0, 120) };
    });
    let settingsPage = null;
    await check('设置页', async () => {
      P.openSettings();
      const sw = await until(() => P.settingsWin(), 5000);
      await waitLoad(sw);
      settingsPage = await until(() => sw.webContents.executeJavaScript(`(() => {
        const k = document.getElementById('keyState');
        return k && k.textContent ? { keyState: k.textContent, chars: document.body.innerText.length,
          diagButton: [...document.querySelectorAll('button')].some((b) => b.textContent.includes('导出诊断')),
          bridge: typeof window.ui.exportDiagnostics } : null; })()`), 8000);
      return { ok: !!settingsPage, detail: settingsPage ? `key: ${settingsPage.keyState}, ${settingsPage.chars} chars` : 'settings page did not fill in' };
    });
    await check('设置页有「导出诊断信息」按钮', async () => {
      const r = settingsPage || {};
      return { ok: r.diagButton && r.bridge === 'function', detail: `button ${r.diagButton ? 'yes' : 'no'}, ui.exportDiagnostics ${r.bridge}` };
    });
    await check('聊天窗不能被网页带走（跳转外部网址被拦下）', async () => {
      if (!cw || cw.isDestroyed()) return { ok: false, detail: 'no chat window' };
      await cw.webContents.executeJavaScript("location.href = 'http://127.0.0.1:9/smoke-should-not-load'; 1");
      await sleep(2000);
      const url = cw.webContents.getURL();
      return { ok: url.startsWith('app://pet/'), detail: url };
    });
    await check('app:// 读不到程序目录以外的文件', async () => {
      // one step out of the app folder: the guard itself must answer 403 (a missing file would only give 404);
      // on Windows a backslash (%5c) is a path separator too
      const tries = ['..%2fpackage.json', ...(process.platform === 'win32' ? ['..%5cpackage.json'] : [])];
      const got = {};
      for (const t of tries) got[t] = await ev(`fetch('app://pet/${t}').then((r) => r.status).catch(() => 'refused')`);
      return { ok: Object.values(got).every((st) => st === 403), detail: got };
    });
    // on Windows the report runs frontApp(); its one-time log line is left out of the error.log check by finish()
    await check('诊断信息里没有用户目录和用户名', async () => {
      if (typeof P.diagnosticsText !== 'function') return { ok: null, detail: 'global.__pet.diagnosticsText not there' };
      const text = String(await P.diagnosticsText());
      const home = os.homedir();
      let user = ''; try { user = os.userInfo().username; } catch (_) {}
      const leaks = [home, home.replace(/\\/g, '/'), user.length >= 3 ? user : ''].filter((x) => x && text.toLowerCase().includes(x.toLowerCase()));
      return { ok: text.length > 200 && !leaks.length, detail: leaks.length ? `contains ${leaks.join(', ')}` : `${text.length} chars` };
    });
    await sleep(1500);   // let late errors reach error.log / the console
    if (process.platform === 'win32') {
      // PowerShell may be blocked on some machines; that is logged once to error.log and shown here, not failed
      errorLogCut = readErrorLog().length;
      await check('Windows 前台窗口（只记录，取不到不算失败）', async () => {
        const f = await withTimeout(P.frontApp(), 20000, 'frontApp').catch((e) => ({ error: e.message }));
        // what PowerShell logged during the whole run (the diagnostics report already called it once)
        const logged = readErrorLog().split('\n').filter((l) => l.includes('[front-app]')).join('\n').trim();
        return { ok: true, detail: { ...f, ...(logged ? { errorLog: logged.slice(-200) } : {}) } };
      });
    }
  } catch (e) {
    checks.push({ name: '测试脚本本身', ok: false, detail: short(String((e && e.stack) || e)) });
  }
  clearTimeout(hard);
  finish();
};
