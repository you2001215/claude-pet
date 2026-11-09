'use strict';
// Runs inside the unpackaged app (node scripts/smoke-test.js tests/smoke/watch-smoke.js) and walks through watching
// together (phase 2) against the fake adapter, with the browser script played by plain HTTP requests to the local
// endpoint: start / pause / seek / leave going to her side, her lines checked against the play point (and silent),
// 「她指他点」 with the 「跳过去」 button, cmd.mode, the typing signal, the play point with a chat, a screenshot part.
// PET_SMOKE_SHOTS=<folder> saves a screenshot of the settings card and of the pet with the 「跳过去」 bubble.
const { app, webContents, nativeImage, BrowserWindow } = require('electron');
const http = require('http');
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

const VIDEO = { site: 'bilibili', bvid: 'BV1smoke411', cid: 777, p: 1, title: '（测试）一起看的视频', dur: 1325 };

module.exports = async (getWin) => {
  const hard = setTimeout(() => finish({ timeout: true }), HARD_MS);
  const fake = await new FakeAdapter({ features: ['watch', 'images'], answer: (t) => [{ text: `（假阿鲸）收到：${t}` }] }).start();
  try {
    const P = global.__pet;
    const L = P.link, W = P.watch;
    const w = await until(() => getWin(), 15000);
    await waitLoad(w);
    P.voice.setMuted(true);
    await sleep(6000);
    const bubble = () => w.webContents.executeJavaScript('window.__pet ? window.__pet.bubble : ""', true);
    const watchFrames = (kind) => fake.received('event.watch').filter((f) => !kind || f.data.kind === kind);

    await check('一起看默认关着', async () => ({ ok: !W.status().enabled && !W.status().listening, detail: JSON.stringify(W.status()) }));

    let key = '', port = 0;
    await check('打开一起看、连上阿鲸（她那边支持 watch 和 images）', async () => {
      L.setConfig({ url: fake.url, enabled: true });
      const pr = await L.pair(fake.issueCode());
      const r = await W.setConfig({ enabled: true, port: 26231 });
      const src = W.script();
      key = /KEY = '([0-9a-f]+)'/.exec(src)[1]; port = Number(/PORT = (\d+)/.exec(src)[1]);
      await until(() => fake.received('event.mode').length > 0, 3000);
      const mode = fake.received('event.mode')[0];
      return { ok: pr.ok && r.ok && W.status().listening && L.feature('watch') && L.feature('images') && mode && mode.data.by === 'connect', detail: `port=${port} mode=${mode && JSON.stringify(mode.data)}` };
    });

    const report = async (kind, o = {}) => {
      const res = await fetch(`http://127.0.0.1:${port}/watch/v1/event`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Pet-Key': key },
        body: JSON.stringify({ kind, video: VIDEO, t: 0, paused: false, rate: 1, hidden: false, from: null, done: [], ...o }) });
      return res.json();
    };

    await check('脚本报进度 → 阿鲸收到 start、pause、seek（不带口令的被拒）', async () => {
      const bad = await fetch(`http://127.0.0.1:${port}/watch/v1/event`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      await report('heartbeat', { t: 10 });
      await report('pause', { t: 12, paused: true });
      await report('seek', { t: 30, paused: true, from: 12 });
      await report('play', { t: 30 });
      await until(() => watchFrames('play').length > 0, 3000);
      const kinds = watchFrames().map((f) => f.data.kind);
      const start = watchFrames('start')[0];
      return { ok: bad.status === 403 && kinds.join(',') === 'start,pause,seek,play' && start.data.video.bvid === VIDEO.bvid && start.data.mode === 'normal', detail: `${bad.status} ${kinds}` };
    });

    await check('她说的话：跟得上播放点的显示（不念）；差太多的回 stale', async () => {
      const acks0 = fake.acks.length;
      fake.push('cmd.say', { source: 'watch', parts: [{ text: '这段弹幕笑死' }], watch: { bvid: VIDEO.bvid, t: 31 }, expires_at: Date.now() + 20000 });
      const b = await until(async () => { const t = await bubble(); return t && t.includes('笑死') ? t : ''; }, 4000);
      fake.push('cmd.say', { source: 'watch', parts: [{ text: '早就过去的一句' }], watch: { bvid: VIDEO.bvid, t: 300 }, expires_at: Date.now() + 20000 });
      await until(() => fake.acks.length >= acks0 + 2, 4000);
      const acks = fake.acks.slice(acks0);
      return { ok: !!b && acks[0].ok === true && acks[1].ok === false && acks[1].code === 'stale', detail: `bubble=${b} acks=${JSON.stringify(acks)}` };
    });

    await check('她指他点：气泡上有「跳过去」，点了脚本就跳过去，阿鲸收到 jumped', async () => {
      const acks0 = fake.acks.length;
      const pf = fake.push('cmd.point', { bvid: VIDEO.bvid, cid: VIDEO.cid, t: 452, text: '07:32 这段你一定要看', expires_at: Date.now() + 300000 });
      await until(() => fake.acks.length > acks0, 4000);
      const btn = await until(() => w.webContents.executeJavaScript(`(() => { const b = document.getElementById('bubble-act'); return b && !b.hidden ? b.textContent : ''; })()`), 4000);
      await sleep(300);
      await shot(w, '桌宠-跳过去.png');
      await w.webContents.executeJavaScript(`document.getElementById('bubble-act').dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); 1`);
      const ans = await until(async () => { const a = await report('heartbeat', { t: 40 }); return a.cmd && a.cmd.length ? a : null; }, 4000);
      await until(() => fake.received('event.point').length > 0, 3000);
      const ep = fake.received('event.point')[0];
      const seek = ans && ans.cmd[0];
      const after = await report('seek', { t: 452, from: 40, done: [seek && seek.id] });
      return { ok: btn.includes('跳过去') && seek && seek.type === 'seek' && seek.t === 452 && ep.data.ref === pf.id && ep.data.action === 'jumped' && after.cmd.length === 0, detail: `btn=${btn} cmd=${JSON.stringify(ans && ans.cmd)} point=${JSON.stringify(ep && ep.data)}` };
    });

    await check('「安静看片」：cmd.mode 改了桌宠的档位，回执 ok', async () => {
      const acks0 = fake.acks.length;
      fake.push('cmd.mode', { mode: 'quiet', hourly_max: 25, by: 'chat' });
      await until(() => fake.acks.length > acks0, 3000);
      return { ok: W.status().mode === 'quiet' && fake.acks[acks0].ok === true, detail: JSON.stringify(W.status()) };
    });

    let sw = null;
    await check('设置页里换档：阿鲸收到 event.mode（by settings）', async () => {
      P.openSettings();
      sw = await until(() => P.settingsWin(), 5000);
      await waitLoad(sw);
      await until(() => sw.webContents.executeJavaScript(`document.getElementById('watchMode') && document.getElementById('watchMode').value === 'quiet'`), 5000);
      const before = fake.received('event.mode').length;
      await sw.webContents.executeJavaScript(`(() => { const s = document.getElementById('watchMode'); s.value = 'chatty'; s.dispatchEvent(new Event('change')); return 1; })()`);
      await until(() => fake.received('event.mode').length > before, 3000);
      const m = fake.received('event.mode').pop();
      await sw.webContents.executeJavaScript(`document.getElementById('watchCard').scrollIntoView(); 1`);
      await sleep(400);
      await shot(sw, '设置页-一起看.png');
      const state = await sw.webContents.executeJavaScript(`document.getElementById('watchState').textContent`);
      return { ok: m.data.mode === 'chatty' && m.data.by === 'settings' && /脚本连上了/.test(state), detail: `${JSON.stringify(m.data)} / ${state}` };
    });

    await check('一起看时在聊天框打字和说话：阿鲸收到打字信号，说的话带着播放点', async () => {
      P.openChat();
      const cw = await until(() => P.chatWin(), 5000);
      await waitLoad(cw);
      await until(() => cw.webContents.executeJavaScript('!!document.getElementById("input")'), 5000);
      await report('heartbeat', { t: 455 });
      await cw.webContents.executeJavaScript(`(() => { const i = document.getElementById('input'); i.value = '这段'; i.dispatchEvent(new Event('input')); return 1; })()`);
      await until(() => fake.received('event.typing').length > 0, 3000);
      await cw.webContents.executeJavaScript(`(() => { document.getElementById('input').value = '这段真好笑'; document.getElementById('send').click(); return 1; })()`);
      await until(() => fake.received('chat.send').length > 0, 4000);
      const cs = fake.received('chat.send').pop();
      const typing = fake.received('event.typing').map((f) => f.data.active);
      const ctx = cs.data.context && cs.data.context.watch;
      return { ok: typing[0] === true && ctx && ctx.bvid === VIDEO.bvid && Math.abs(ctx.t - 455) < 5 && cs.data.text === '这段真好笑', detail: `typing=${typing} context=${JSON.stringify(cs.data.context)}` };
    });

    await check('截图压成 JPEG（长边 ≤1600、≤700 KB）才发', async () => {
      const big = nativeImage.createFromPath(path.join(__dirname, '..', '..', 'art-source', '立绘', '三视图.jpg'));
      const src = big.isEmpty() ? nativeImage.createFromPath(path.join(__dirname, '..', '..', 'assets', 'pet', 'angry.png')) : big;
      const part = P.imagePart(src.resize({ width: 3200 }).toDataURL());
      const img = part && nativeImage.createFromBuffer(Buffer.from(part.data, 'base64'));
      const sz = img && img.getSize();
      return { ok: part && part.mime === 'image/jpeg' && part.size <= 700 * 1024 && Math.max(sz.width, sz.height) <= 1600, detail: part ? `${part.size} bytes ${sz.width}x${sz.height}` : 'no part' };
    });

    await check('离开视频：阿鲸收到 leave，打字信号不再发；看完那句（end）离开后照样显示', async () => {
      await report('leave');
      await until(() => watchFrames('leave').length > 0, 3000);
      // not watching any more: typing in the chat box is nobody's business
      const typed0 = fake.received('event.typing').length;
      const cw = P.chatWin();
      if (cw) await cw.webContents.executeJavaScript(`(() => { const i = document.getElementById('input'); i.value = '还在吗'; i.dispatchEvent(new Event('input')); i.value = ''; i.dispatchEvent(new Event('input')); return 1; })()`);
      await sleep(600);
      const typedAfter = fake.received('event.typing').length - typed0;
      const acks0 = fake.acks.length;
      // the quiet-mode summary: up to 3 lines, kept as lines
      fake.push('cmd.say', { source: 'watch', parts: [{ text: '看完啦\n今天这个好好笑\n下次还一起看' }], watch: { bvid: VIDEO.bvid, t: 1325, end: true }, expires_at: Date.now() + 600000 });
      await until(() => fake.acks.length > acks0, 3000);
      const b = await until(async () => { const t = await bubble(); return t && t.includes('看完啦') ? t : ''; }, 4000);
      const lines = String(b || '').split('\n');
      await sleep(300);
      await shot(w, '桌宠-看完小结.png');
      return { ok: !!cw && typedAfter === 0 && fake.acks[acks0].ok === true && lines.length === 3 && lines[2] === '下次还一起看', detail: `typing after leave=${typedAfter} bubble=${JSON.stringify(b)}` };
    });
    await check('真的油猴脚本：在一个假的 B 站视频页里跑，报的进度和「跳过去」都对', async () => {
      // a page shaped like a bilibili video page, with a real playing video
      const clip = fs.readdirSync(path.join(__dirname, '..', '..', 'assets', 'claude')).find((n) => n.endsWith('.webm'));
      const page = `<!doctype html><meta charset="utf-8"><title>假页面里的视频_哔哩哔哩_bilibili</title>
        <script>window.__INITIAL_STATE__ = { videoData: { bvid: 'BV1page411', cid: 888, title: '假页面里的视频', pages: [{ cid: 888, page: 1 }] } };</script>
        <video src="/clip.webm" muted loop autoplay style="width:320px"></video>`;
      const srv = http.createServer((req, res) => {
        if (req.url.startsWith('/clip.webm')) {
          // byte ranges, like a real video server: without them the browser can't seek
          const f = path.join(__dirname, '..', '..', 'assets', 'claude', clip), size = fs.statSync(f).size;
          const m = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '');
          if (!m) { res.writeHead(200, { 'Content-Type': 'video/webm', 'Content-Length': size, 'Accept-Ranges': 'bytes' }); fs.createReadStream(f).pipe(res); return; }
          const a = m[1] ? Number(m[1]) : 0, b = m[2] ? Number(m[2]) : size - 1;
          res.writeHead(206, { 'Content-Type': 'video/webm', 'Content-Length': b - a + 1, 'Content-Range': `bytes ${a}-${b}/${size}`, 'Accept-Ranges': 'bytes' });
          fs.createReadStream(f, { start: a, end: b }).pipe(res);
          return;
        }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(page);
      });
      await new Promise((r) => srv.listen(0, '127.0.0.1', r));
      const bw = new BrowserWindow({ show: true, x: 0, y: 0, width: 400, height: 300, focusable: false, webPreferences: { backgroundThrottling: false, autoplayPolicy: 'no-user-gesture-required' } });
      try {
        await bw.loadURL(`http://127.0.0.1:${srv.address().port}/video/BV1page411?p=1`);
        const ev = (js) => bw.webContents.executeJavaScript(js, true);
        // stands in for the script manager: the script's requests go out from here (no Origin, like an extension)
        await ev(`window.__gm = []; window.__gmOpen = {}; window.__gmN = 0; window.unsafeWindow = window;
          window.GM_xmlhttpRequest = (o) => { const id = ++window.__gmN; window.__gmOpen[id] = o; window.__gm.push({ id, url: o.url, headers: o.headers, data: o.data }); }; 1`);
        await ev(W.script());
        let pumping = true;
        const pump = (async () => {
          while (pumping && !bw.isDestroyed()) {
            const reqs = await ev('window.__gm.splice(0)').catch(() => []);
            for (const q of reqs) {
              let text = '';
              try { text = await (await fetch(q.url, { method: 'POST', headers: q.headers, body: q.data })).text(); } catch (_) {}
              await ev(`(() => { const o = window.__gmOpen[${q.id}]; delete window.__gmOpen[${q.id}]; if (o && o.onload) o.onload({ responseText: ${JSON.stringify(text)} }); return 1; })()`).catch(() => {});
            }
            await sleep(100);
          }
        })();
        const pageStart = () => watchFrames('start').find((f) => f.data.video.bvid === 'BV1page411');
        const st = await until(pageStart, 8000);
        await ev(`document.querySelector('video').pause(); 1`);
        const paused = await until(() => watchFrames('pause').find((f) => f.data.video.bvid === 'BV1page411'), 5000);
        const id = W.seek(1.5);
        const seeked = await until(() => watchFrames('seek').find((f) => f.data.video.bvid === 'BV1page411'), 9000);
        const t = await ev(`document.querySelector('video').currentTime`);
        pumping = false;
        await pump;
        return { ok: !!st && st.data.video.cid === 888 && st.data.video.title === '假页面里的视频' && !!paused && !!seeked && Math.abs(t - 1.5) < 0.6 && !!id,
          detail: `start=${st && JSON.stringify(st.data.video)} pause=${!!paused} seek=${seeked && JSON.stringify({ t: seeked.data.t, from: seeked.data.from })} video.t=${t}` };
      } finally { if (!bw.isDestroyed()) bw.destroy(); srv.close(); }
    });
  } catch (e) {
    checks.push({ name: '测试脚本', ok: false, detail: short(String((e && e.stack) || e)) });
  } finally {
    clearTimeout(hard);
    try { await fake.close(); } catch (_) {}
    finish();
  }
};
