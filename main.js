'use strict';
const { app, BrowserWindow, ipcMain, screen, Menu, Tray, nativeImage, protocol, net, powerMonitor, shell, Notification, desktopCapturer, systemPreferences, dialog, session, safeStorage } = require('electron');
// an installed copy ignores the hooks that load a test script or point Edge voice / stickers at another server
// (read when the modules below load, so this has to come first)
if (app.isPackaged) for (const k of ['PET_TEST', 'PET_EDGE_WSS', 'PET_STICKER_SITE']) delete process.env[k];
const { execFile } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { pathToFileURL } = require('url');
const ai = require('./ai');
const stickers = require('./stickers');
const reminders = require('./reminders');
const store = require('./store');
const voice = require('./voice');
const voiceHost = require('./voice/engine-host');
// the desktop link to AstrBot (「阿鲸」), off until the user turns it on and pairs: docs/桌面连接接口说明.md
const link = require('./link');
const linkLines = require('./link/lines');
const linkProto = require('./link/protocol');
// watching videos together (phase 2): the browser script's local endpoint and what goes to her side
const watch = require('./watch');

// serve the UI from app://pet/... so canvas pixels stay same-origin (needed for click-through hit tests)
protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
]);
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif',
  '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.wav': 'audio/wav', '.ttf': 'font/ttf', '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
};
// video clips need byte ranges so the player can seek and loop
const mediaCache = new Map();
async function serveMedia(file, req) {
  let buf = mediaCache.get(file);
  if (!buf) {
    try { buf = await fs.promises.readFile(file); } catch (_) { return new Response('not found', { status: 404 }); }
    mediaCache.set(file, buf);
    if (mediaCache.size > 24) mediaCache.delete(mediaCache.keys().next().value);
  }
  const size = buf.length;
  const type = 'video/webm';
  const m = /bytes=(\d*)-(\d*)/.exec(req.headers.get('range') || '');
  if (!m) return new Response(buf, { status: 200, headers: { 'Content-Type': type, 'Content-Length': String(size), 'Accept-Ranges': 'bytes' } });
  let start = m[1] ? Number(m[1]) : Math.max(0, size - Number(m[2] || 0));
  let end = m[1] && m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
  if (start >= size || start > end) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
  const part = buf.subarray(start, end + 1);
  return new Response(part, { status: 206, headers: { 'Content-Type': type, 'Content-Length': String(part.length), 'Content-Range': `bytes ${start}-${end}/${size}`, 'Accept-Ranges': 'bytes' } });
}
function registerAppProtocol() {
  const root = __dirname;
  protocol.handle('app', async (req) => {
    const u = new URL(req.url);
    if (u.pathname.startsWith('/sticker/')) {
      try {
        const id = decodeURIComponent(u.pathname.slice('/sticker/'.length)).replace(/\.gif$/, '');
        const f = await stickers.file(id);
        return net.fetch(pathToFileURL(f).toString());
      } catch (e) {
        return new Response('sticker unavailable', { status: 404 });
      }
    }
    if (u.pathname.startsWith('/linkmedia/')) {
      const f = link.mediaPath(decodeURIComponent(u.pathname.slice('/linkmedia/'.length)));
      if (!f) return new Response('forbidden', { status: 403 });
      try { return new Response(await fs.promises.readFile(f), { status: 200, headers: { 'Content-Type': MIME[path.extname(f).toLowerCase()] || 'application/octet-stream' } }); } catch (_) { return new Response('not found', { status: 404 }); }
    }
    const p = path.normalize(path.join(root, decodeURIComponent(u.pathname)));
    if (p !== root && !p.startsWith(root + path.sep)) return new Response('forbidden', { status: 403 });
    if (/\.webm$/i.test(p)) return serveMedia(p, req);
    // read through fs (asar-aware) rather than a file:// fetch, which fails on non-ASCII names inside app.asar
    try {
      const body = await fs.promises.readFile(p);
      return new Response(body, { status: 200, headers: { 'Content-Type': MIME[path.extname(p).toLowerCase()] || 'application/octet-stream' } });
    } catch (_) {
      if (process.env.PET_DEBUG) console.log('[app://] missing', u.pathname);
      return new Response('not found', { status: 404 });
    }
  });
}

// ---------- error log instead of crash dialogs ----------
function logError(where, e) {
  try {
    const f = path.join(app.getPath('userData'), 'error.log');
    let old = '';
    try { old = fs.readFileSync(f, 'utf8').split('\n').slice(-200).join('\n'); } catch (_) {}
    fs.writeFileSync(f, old + `${new Date().toISOString()} [${where}] ${(e && e.stack) || e}\n`);
  } catch (_) {}
}
process.on('uncaughtException', (e) => logError('uncaught', e));
process.on('unhandledRejection', (e) => logError('unhandledRejection', e));

// ---------- IPC only from our own pages ----------
const ipcWarned = new Set();
function fromApp(e, ch) {
  let url = '';
  try { url = String((e && e.senderFrame && e.senderFrame.url) || ''); } catch (_) {}
  if (url.startsWith('app://pet/')) return true;
  if (!ipcWarned.has(ch)) { ipcWarned.add(ch); logError('ipc', `ignored ${ch} from ${url.slice(0, 120) || 'an unknown frame'}`); }
  return false;
}
const handle = (ch, fn) => ipcMain.handle(ch, (e, ...a) => (fromApp(e, ch) ? fn(e, ...a) : undefined));
const on = (ch, fn) => ipcMain.on(ch, (e, ...a) => { if (fromApp(e, ch)) fn(e, ...a); });

const isMac = process.platform === 'darwin';
const isWin = process.platform === 'win32';
// Windows with a virtual display driver (ToDesk, remote desktop, emulators...) crashes Chromium's
// sandboxed GPU process on start-up; this window only draws our own local files, so drop that sandbox.
// (fix found in github.com/PC2005-cloud/dsh-pet)
if (isWin && process.env.PET_GPU_SANDBOX !== '1') app.commandLine.appendSwitch('disable-gpu-sandbox');

// a second copy only pokes the running one (second-instance below): no window, no tray, no data writes
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.quit();

// ---------- settings ----------
const SIZES = { small: 150, medium: 200, large: 260, huge: 340 };
const SIZE_LABELS = { small: '小', medium: '中', large: '大', huge: '特大' };
const defaults = { size: 'medium', walk: true, alwaysOnTop: true, x: null, y: null, outfit: 'claude' };
const OUTFITS = { claude: 'Claude 装', maid: '女仆装（原版大肥鱼）' };
let settingsPath;
let settings = { ...defaults };

function loadSettings() {
  settingsPath = path.join(app.getPath('userData'), 'settings.json');
  // tmp + rename with a .bak, like the AI files: it is rewritten after every drag, so a power cut can hit it
  const r = store.readJsonSync(settingsPath, null);
  const raw = r.data && typeof r.data === 'object' && !Array.isArray(r.data) ? r.data : {};
  settings = { ...defaults, ...raw };
  const w = store.loadWarning(r, '桌宠设置文件（settings.json）', '大小、位置和造型回到了默认');
  if (w) logError('settings', w);
  if (!SIZES[settings.size]) settings.size = 'medium';
  if (!OUTFITS[settings.outfit]) settings.outfit = 'claude';
}
let saveTimer = null, settingsSaveWarned = false;
function saveSettings() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try { store.writeJsonSync(settingsPath, settings); settingsSaveWarned = false; } catch (e) {
      if (!settingsSaveWarned) logError('settings', '保存 settings.json 失败：' + e.message);   // once, it is saved after every drag
      settingsSaveWarned = true;
    }
  }, 400);
}

// ---------- window geometry ----------
function winSizeFor(sizeKey, outfit = settings.outfit) {
  const h = SIZES[sizeKey];
  // maid clips are 640x360 frames with the standing girl 266 px tall; props can reach the frame edges
  if (outfit === 'maid') return { width: Math.round(Math.max(280, h * 640 / 266)), height: Math.round(h + 170) };
  return { width: Math.round(Math.max(280, h * 1.4)), height: Math.round(h + 170) };
}

function workAreaAt(x, y) {
  const d = screen.getDisplayNearestPoint({ x: Math.round(x), y: Math.round(y) });
  return d.workArea;
}

let win = null;
let tray = null;
let sleeping = false;

function createWindow() {
  const { width, height } = winSizeFor(settings.size);
  const primary = screen.getPrimaryDisplay().workArea;
  let x = settings.x, y = settings.y;
  const valid = x !== null && y !== null &&
    screen.getAllDisplays().some(d => {
      const b = d.workArea;
      return x + width / 2 >= b.x && x + width / 2 <= b.x + b.width && y >= b.y - height && y <= b.y + b.height;
    });
  if (!valid) {
    x = primary.x + primary.width - width - 80;
    y = primary.y + primary.height - height;
  }

  win = new BrowserWindow({
    width, height, x: Math.round(x), y: Math.round(y),
    transparent: true,
    backgroundColor: '#00000000',
    frame: false,
    hasShadow: false,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: settings.alwaysOnTop,
    show: false,
    title: 'Claude',
    acceptFirstMouse: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
      spellcheck: false,
      autoplayPolicy: 'no-user-gesture-required',   // she may talk without a click first
    },
  });
  applyOnTop();
  if (isMac) {
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
  }
  win.setIgnoreMouseEvents(true, { forward: true });
  win.loadURL('app://pet/renderer/index.html');
  win.once('ready-to-show', () => win.showInactive());
  win.on('closed', () => { win = null; });
  reloadOnCrash(win, 'pet', 1000);
  win.on('unresponsive', () => logError('pet', 'window unresponsive'));
  win.on('responsive', () => logError('pet', 'window responsive again'));
}

// a crashed page comes back by itself instead of leaving an invisible window; at most 5 times in 10 minutes
function reloadOnCrash(w, name, delay) {
  const times = [];
  w.webContents.on('render-process-gone', (_e, d) => {
    if (d.reason === 'clean-exit') return;
    logError(name, `page process gone: ${d.reason} (${d.exitCode})`);
    const t = Date.now();
    while (times.length && t - times[0] > 10 * 60000) times.shift();
    if (times.length >= 5) { logError(name, 'crashed 5 times in 10 minutes, not reloading'); return; }
    times.push(t);
    setTimeout(() => { if (!w.isDestroyed()) w.webContents.reload(); }, delay);
  });
}

function applyOnTop() {
  if (!win) return;
  if (settings.alwaysOnTop) win.setAlwaysOnTop(true, isMac ? 'floating' : 'screen-saver');
  else win.setAlwaysOnTop(false);
}

// ---------- menus ----------
function reminderItems() {
  const p = reminders.pending();
  if (!p.length) return [];
  return [{
    label: `提醒（${p.length}）`,
    submenu: p.slice(0, 10).map((r) => ({
      label: `${r.label}  ${r.text.slice(0, 24)}`,
      submenu: [{ label: '删除这个提醒', click: () => { reminders.remove(r.id); refreshTray(); } }],
    })),
  }];
}
function buildMenu() {
  const sizeItems = Object.keys(SIZES).map(k => ({
    label: SIZE_LABELS[k], type: 'radio', checked: settings.size === k,
    click: () => setSize(k),
  }));
  const loginOn = app.getLoginItemSettings().openAtLogin;
  return Menu.buildFromTemplate([
    { label: '和她聊天', click: () => openChat() },
    { label: '跟她说话（语音）', click: () => openChat({ mic: true }) },
    ...reminderItems(),
    { label: '看看我在看什么', click: () => lookAndComment('lookAsk') },
    { label: '说句话', click: () => send('cmd', 'talk') },
    { label: '查 API 余额', click: async () => { const b = await ai.balance(); send('ai', { type: 'notice', text: b.ok ? b.summary : b.error, tier: balanceTier(b) }); } },
    { label: sleeping ? '叫醒她' : '去睡觉', click: () => send('cmd', sleeping ? 'wake' : 'sleep') },
    { type: 'separator' },
    { label: '静音', type: 'checkbox', checked: voice.isMuted(), click: (i) => { voice.setMuted(i.checked); } },
    { label: '自由走动', type: 'checkbox', checked: settings.walk, click: (i) => { settings.walk = i.checked; saveSettings(); pushSettings(); } },
    { label: '大小', submenu: sizeItems },
    { label: '换装', submenu: Object.entries(OUTFITS).map(([k, label]) => ({ label, type: 'radio', checked: settings.outfit === k, click: () => setOutfit(k) })) },
    { label: '始终在最前面', type: 'checkbox', checked: settings.alwaysOnTop, click: (i) => { settings.alwaysOnTop = i.checked; applyOnTop(); saveSettings(); } },
    // a dev run (npm start) would point autostart at the dev Electron instead of the installed app
    app.isPackaged
      ? { label: '开机自动启动', type: 'checkbox', checked: loginOn, click: (i) => app.setLoginItemSettings({ openAtLogin: i.checked }) }
      : { label: '开机自动启动（开发版不能设）', type: 'checkbox', checked: loginOn, enabled: false },
    { label: '回到屏幕中间', click: () => resetPosition() },
    { label: 'AI 设置…', click: () => openSettings() },
    { label: '导出诊断信息…', click: () => exportFromMenu() },
    { type: 'separator' },
    { label: '退出', click: () => app.quit() },
  ]);
}

function refreshTray() {
  if (tray) tray.setContextMenu(buildMenu());
}

function setupTray() {
  const dir = path.join(__dirname, 'assets', 'pet');
  let img;
  if (isMac) {
    img = nativeImage.createFromPath(path.join(dir, 'tray.png')); // picks tray@2x.png on Retina
  } else {
    img = nativeImage.createEmpty();
    img.addRepresentation({ scaleFactor: 1, buffer: fs.readFileSync(path.join(dir, 'tray_16.png')) });
    img.addRepresentation({ scaleFactor: 2, buffer: fs.readFileSync(path.join(dir, 'tray_32.png')) });
  }
  tray = new Tray(img);
  tray.setToolTip('大肥鱼（cos Claude）');
  tray.setContextMenu(buildMenu());
  if (isWin) tray.on('click', () => { if (win) { win.showInactive(); send('cmd', 'talk'); } });
}

function send(ch, ...args) {
  if (win && !win.isDestroyed()) win.webContents.send(ch, ...args);
  if (ch === 'ai') {
    const ev = args[0] || {};
    if ((ev.type === 'thinking' || ev.type === 'looking')) { voice.stopSpeaking(); voice.warm('tts'); }
    else if (['done', 'proactive', 'reminder'].includes(ev.type) && ev.text && !ev.silent) voice.speak(ev.text);
  }
}
function broadcast(ch, payload) {
  for (const w of BrowserWindow.getAllWindows()) { if (!w.isDestroyed()) w.webContents.send(ch, payload); }
}
function pushSettings() {
  send('settings', { size: settings.size, height: SIZES[settings.size], walk: settings.walk, outfit: settings.outfit, whisper: ai.whisperMode() });
  refreshTray();
}
function setOutfit(k) {
  if (!OUTFITS[k] || !win) return;
  settings.outfit = k;
  ai.setOutfit(k);
  setSize(settings.size);          // same size, new window shape for the outfit
  for (const w of [chatWin, settingsWin]) if (w && !w.isDestroyed()) w.webContents.send('ui:outfit', k);
}

// window coordinates: Electron rejects -0 ("conversion failure"), which Math.round gives for -0.5..0; -0 + 0 is 0
const px = (v) => Math.round(v) + 0;

function setSize(k) {
  if (!win) return;
  const old = win.getBounds();
  settings.size = k;
  const { width, height } = winSizeFor(k);
  const cx = old.x + old.width / 2;
  const bottom = old.y + old.height;
  win.setBounds({ x: px(cx - width / 2), y: px(bottom - height), width, height });
  saveSettings();
  pushSettings();
}

function resetPosition() {
  if (!win) return;
  const b = win.getBounds();
  const wa = screen.getPrimaryDisplay().workArea;
  win.setPosition(px(wa.x + wa.width / 2 - b.width / 2), px(wa.y + wa.height / 2 - b.height / 2));
  send('cmd', 'dropped');
}

// ---------- chat & settings windows ----------
let chatWin = null, settingsWin = null;
function uiWindow(file, opts) {
  const w = new BrowserWindow({
    show: false,
    backgroundColor: '#fffaf2',
    autoHideMenuBar: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    webPreferences: { preload: path.join(__dirname, 'preload-ui.js'), contextIsolation: true, nodeIntegration: false, spellcheck: false },
    ...opts,
  });
  if (!isMac) w.setMenu(null);
  reloadOnCrash(w, file, 500);
  w.loadURL('app://pet/renderer/' + file);
  w.once('ready-to-show', () => { w.show(); w.focus(); if (isMac) app.focus({ steal: true }); });
  return w;
}
function openChat(opts = {}) {
  if (chatWin && !chatWin.isDestroyed()) {
    chatWin.show(); chatWin.focus(); if (isMac) app.focus({ steal: true });
    if (opts.mic) chatWin.webContents.send('ui:start-mic');
    return;
  }
  const W = 360, H = 500;
  let x, y;
  if (win) {
    const b = win.getBounds();
    const wa = workAreaAt(b.x + b.width / 2, b.y + b.height / 2);
    x = b.x - W + 30;
    if (x < wa.x) x = b.x + b.width - 30;
    x = Math.max(wa.x, Math.min(x, wa.x + wa.width - W));
    y = Math.max(wa.y, Math.min(b.y + b.height - H, wa.y + wa.height - H));
  }
  chatWin = uiWindow('chat.html', { width: W, height: H, minWidth: 300, minHeight: 360, x, y, title: '和大肥鱼聊天', alwaysOnTop: true });
  if (opts.mic) { const w = chatWin; w.webContents.once('did-finish-load', () => setTimeout(() => { if (!w.isDestroyed()) w.webContents.send('ui:start-mic'); }, 300)); }
  chatWin.on('closed', () => { chatWin = null; });
}
function openSettings() {
  if (settingsWin && !settingsWin.isDestroyed()) { settingsWin.show(); settingsWin.focus(); if (isMac) app.focus({ steal: true }); return; }
  settingsWin = uiWindow('settings.html', { width: 480, height: 720, minWidth: 420, minHeight: 480, title: 'AI 设置' });
  settingsWin.on('closed', () => { settingsWin = null; if (chatWin) chatWin.webContents.send('ai:settings-changed'); });
}

// ---------- chat ----------
const NO_DROPS = { memories: 0, reminders: 0, cancels: 0, refused: 0 };
// her reply through AstrBot: shown like the pet's own, kept in the chat history
async function linkedChat(text, input, extra) {
  const r = await link.chat(text, input, extra);
  if (r.kind === 'merged') {
    // answered together with the message before it: that reply covers this one too
    await ai.record('user', text);
    return { ok: true, reply: '', merged: true, stickers: [], remembered: [], remindSet: [], remindFail: [], remindCancelled: [], memoryFull: false, dropped: NO_DROPS, truncated: false, via: 'ajing' };
  }
  const { text: reply, stickers: st } = link.toReply(r.data.parts);
  const emotion = linkProto.emotionOf(r.data.emotion);
  await ai.record('user', text);
  if (reply || st.length) await ai.record('assistant', reply || '（发了一个表情）', { via: 'ajing', ...(st.length ? { stickers: st } : {}) });
  send('ai', { type: 'done', text: reply, stickers: st, remembered: [], remindSet: [], emotion });
  return { ok: true, reply, stickers: st, remembered: [], remindSet: [], remindFail: [], remindCancelled: [], memoryFull: false, dropped: NO_DROPS, truncated: false, via: 'ajing' };
}
// the pet answered for her (she didn't reply in time, or her side failed): say so, and tell her what was said
const STAND_IN = '（阿鲸刚才没接上，这句是我自己说的）';

handle('ai:send', async (_e, text, withScreen, input) => {
  pro.lastUserChat = Date.now();
  careHeard(String(text || ''));
  input = input === 'voice' ? 'voice' : 'text';
  let standInFor = '';
  if (link.online() && (!withScreen || link.feature('images'))) {
    send('ai', { type: 'thinking' });
    try {
      const extra = {};
      const at = link.feature('watch') ? watch.position() : null;
      if (at) extra.context = { watch: { bvid: at.bvid, cid: at.cid, t: at.t, paused: at.paused } };
      if (withScreen) {
        let shot;
        try { shot = await captureScreen(); } catch (e) { logError('capture', e); screenHint(e); throw Object.assign(new Error(captureError(e)), { code: 'capture' }); }
        const img = imagePart(shot);
        if (!img) throw Object.assign(new Error('截图太大了，没发出去'), { code: 'capture' });
        extra.images = [img];
      }
      const r = await linkedChat(String(text || '').slice(0, 4000), input, extra);
      pro.lastUserChat = Date.now();
      return r;
    } catch (e) {
      if (e.code === 'capture') { send('ai', { type: 'error', code: 'capture', text: e.message }); return { ok: false, error: e.message, code: 'capture' }; }
      if (!e.retry && e.code !== 'offline') {
        send('ai', { type: 'error', code: e.code || '', text: '阿鲸那边没收下这句话' });
        return { ok: false, error: '阿鲸那边没收下这句话（' + (e.code || '出错了') + '）', code: e.code || '' };
      }
      standInFor = e.code === 'offline' ? '' : e.id;   // offline in between: handled below like any offline chat
    }
  }
  send('ai', { type: 'thinking' });
  try {
    let image = null;
    if (withScreen) {
      try { image = await captureScreen(); } catch (e) { logError('capture', e); screenHint(e); throw Object.assign(new Error(captureError(e)), { code: 'capture' }); }
    }
    const r = await ai.send(String(text || '').slice(0, 4000), (t) => {
      if (chatWin) chatWin.webContents.send('ai:delta', t);
      send('ai', { type: 'delta', text: t });
    }, { image });
    const remindSet = [], remindFail = [], remindCancelled = [];
    // cancel first: "move my 3 pm meeting to 4" is a cancel plus an add with the same words, and the new one must survive
    for (const k of r.remindCancel || []) remindCancelled.push(...reminders.cancel(k));
    for (const x of r.remindAdd || []) {
      const res = reminders.add(x.at, x.text);
      if (res.ok) remindSet.push(res.label); else remindFail.push(res.error);
    }
    if (remindSet.length || remindCancelled.length) refreshTray();
    send('ai', { type: 'done', text: r.reply, remembered: r.remembered, stickers: r.stickers, remindSet });
    pro.lastUserChat = Date.now();
    // connected to 阿鲸: what was said here goes to her too (only the pet's line when it stood in for her reply)
    if (standInFor) link.offline([{ role: 'pet', text: r.reply, reply_to: standInFor }]);
    else if (link.linked()) link.offline([{ role: 'user', text: String(text || '').slice(0, 4000), input }, { role: 'pet', text: r.reply }]);
    return {
      standIn: standInFor ? STAND_IN : '',
      ok: true, reply: r.reply, remembered: r.remembered, stickers: r.stickers, remindSet, remindFail, remindCancelled,
      memoryFull: !!r.memoryFull, dropped: r.dropped || { memories: 0, reminders: 0, cancels: 0, refused: 0 }, truncated: !!r.truncated,
    };
  } catch (e) {
    send('ai', { type: 'error', code: e.code || '', text: e.message });
    return { ok: false, error: e.message, code: e.code || '' };
  }
});
on('ai:stop', () => ai.abort());
handle('ai:history', () => ai.history());
handle('ai:sticker-credit', () => stickers.attribution());
handle('stickers:test', () => stickers.selfTest());
handle('reminders:list', () => reminders.pending());
handle('ai:balance', async () => {
  const b = await ai.balance();
  if (b.ok) send('ai', { type: 'notice', text: b.summary, tier: balanceTier(b) });
  return b;
});
// 0 (plenty) .. 5 (nothing left), like dsh-pet: ¥20 counts as a full purse
function balanceTier(b) {
  if (!b || !b.ok) return null;
  const it = (b.items || []).find((i) => i.currency === 'CNY') || (b.items || [])[0];
  if (!it || !b.available) return 5;
  const cny = it.currency === 'USD' ? it.total * 7.2 : it.total;
  if (cny <= 0) return 5;
  const used = Math.max(0, Math.min(100, (20 - cny) / 20 * 100));
  return Math.min(4, Math.floor(used / 20));
}
handle('reminders:delete', (_e, id) => { const ok = reminders.remove(id); refreshTray(); return ok; });
handle('stickers:status', () => stickers.status());
handle('ai:clear', async () => { await ai.clearHistory(); return true; });
handle('ai:settings:get', () => ai.publicSettings());
handle('ai:settings:set', async (_e, s) => { const r = await ai.updateSettings(s || {}); planNextChat(); planNextLook(); pushSettings(); return r; });
handle('ai:pick-folder', async () => {
  const r = await dialog.showOpenDialog(settingsWin || undefined, { title: '选择存放人格和记忆的文件夹', properties: ['openDirectory', 'createDirectory'] });
  return r.canceled ? '' : r.filePaths[0] || '';
});
handle('ai:import-dsh', () => { try { return ai.importFromDsh(); } catch (e) { return { ok: false, error: e.message }; } });
handle('ai:test', () => ai.test());
handle('ai:models', () => ai.listModels());
on('ui:open-settings', () => openSettings());
on('ui:open-chat', () => openChat());
handle('voice:mic-access', async () => {
  if (!isMac) return true;
  try {
    if (systemPreferences.getMediaAccessStatus('microphone') === 'granted') return true;
    return await systemPreferences.askForMediaAccess('microphone');
  } catch (_) { return false; }
});
on('ui:close', (e) => { const w = BrowserWindow.fromWebContents(e.sender); if (w) w.close(); });
on('ui:open-url', (_e, url) => {
  try {
    const u = new URL(String(url));
    if (u.protocol === 'https:' && ['kiriyuki.com', 'space.bilibili.com', 'github.com', 'creativecommons.org', 'platform.deepseek.com', 'api-docs.deepseek.com', 'www.bilibili.com'].includes(u.hostname)) shell.openExternal(u.href);
  } catch (_) {}
});
// the AI hello is said once per start; a page reloaded after a crash gets the built-in greeting instead
let greeted = false;
handle('ai:will-greet', () => !greeted && ai.hasKey() && ai.proactiveMode() !== 'off');
let startMeet = Promise.resolve(null);
on('ai:greet', async () => { if (greeted) return; greeted = true; speakUp('startup', { meet: await startMeet }); });

// ---------- proactive talk: she starts a conversation by herself ----------
const pro = {
  lastSaid: 0, lastUserChat: 0, away: false, awayStart: 0,
  restAnchor: Date.now(), nightKey: '', nextChatAt: 0, busy: false,
  nightAskAt: 0, careAsk: null,     // connected to 阿鲸: the last sleep question, to tell her when it was answered
};
// a chat within 15 minutes of the sleep question answers it (or asks her to stop, counted with QQ)
function careHeard(text) {
  const c = pro.careAsk;
  if (!c || Date.now() - c.at > 15 * 60000) return;
  pro.careAsk = null;
  link.care(c.kind, c.slot, /别管|不用管|别催|别问了|不要管|别操心/.test(text) ? 'stop' : 'answered');
}
const CHAT_GAP = { hourly: [50, 75], often: [18, 26] };
function planNextChat() {
  const g = CHAT_GAP[ai.proactiveMode()];
  pro.nextChatAt = g ? Date.now() + (g[0] + Math.random() * (g[1] - g[0])) * 60000 : Infinity;
}
// connected to 阿鲸: no AI lines of the pet's own (small talk and "welcome back" wait for her, phase 3)
async function speakFixed(kind) {
  const text = linkLines.line(kind);
  if (!text) return false;
  pro.lastSaid = Date.now();
  if (kind !== 'chat') pro.nextChatAt = Math.max(pro.nextChatAt, Date.now() + 15 * 60000);
  send('ai', { type: 'proactive', kind, text, stickers: [] });
  if (chatWin && !chatWin.isDestroyed()) chatWin.webContents.send('ai:proactive', { text, stickers: [] });
  await ai.record('assistant', text, { proactive: kind, fixed: true });
  return true;
}
async function speakUp(kind, ctx) {
  if (pro.busy || ai.proactiveMode() === 'off') return false;
  if (link.online()) return speakFixed(kind);
  if (!ai.hasKey()) return false;
  pro.busy = true;
  pro.lastSaid = Date.now();
  // only small talk sets the next small talk; a greeting, a rest or night nudge just keeps it 15+ minutes away
  if (kind === 'chat') planNextChat();
  else pro.nextChatAt = Math.max(pro.nextChatAt, Date.now() + 15 * 60000);
  try {
    const r = await ai.proactive(kind, ctx);
    send('ai', { type: 'proactive', kind, text: r.text, stickers: r.stickers });
    if (chatWin && !chatWin.isDestroyed()) chatWin.webContents.send('ai:proactive', r);
    if (link.linked() && r.text) link.offline([{ role: 'pet', text: r.text }]);
    return true;
  } catch (e) {
    logError('proactive:' + kind, e);
    send('ai', { type: 'proactive-failed', kind });
    return false;
  } finally { pro.busy = false; }
}
// ---------- looking at the screen ----------
const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));
// capture one display (by default the one the cursor is on); our own windows are hidden from the capture
async function captureScreen(display) {
  const d = display || screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const pw = Math.round(d.size.width * d.scaleFactor), ph = Math.round(d.size.height * d.scaleFactor);
  const k = Math.min(1, 1600 / pw);
  const mine = [win, chatWin, settingsWin].filter((w) => w && !w.isDestroyed());
  mine.forEach((w) => { try { w.setContentProtection(true); } catch (_) {} });
  await sleepMs(200);
  try {
    const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: Math.round(pw * k), height: Math.round(ph * k) } });
    const src = sources.find((s) => String(s.display_id) === String(d.id)) || sources[0];
    if (!src || src.thumbnail.isEmpty()) throw new Error('没拿到屏幕画面');
    return 'data:image/jpeg;base64,' + src.thumbnail.toJPEG(78).toString('base64');
  } finally {
    mine.forEach((w) => { try { if (!w.isDestroyed()) w.setContentProtection(false); } catch (_) {} });
  }
}

// the app in front (so she only glances while you are in a browser): { name, rect }, rect = the front window in
// physical pixels on Windows (to capture the screen the browser is on), null elsewhere
// Windows PowerShell 5.1 writes in the console code page (CP936 on Chinese Windows) and wraps errors in CLIXML, so
// the script catches its own errors and prints everything as ASCII (\uXXXX escapes): 'name|l|t|r|b' or 'ERR|reason'
const FRONT_PS = [
  "$ProgressPreference='SilentlyContinue'; $ErrorActionPreference='Stop';",
  "function A([string]$s) { -join ($s.ToCharArray() | % { if ([int]$_ -lt 128) { [string]$_ } else { '\\u{0:x4}' -f [int]$_ } }) };",
  'try {',
  'Add-Type -Namespace W -Name U -MemberDefinition \'',
  '[DllImport("user32.dll")] public static extern System.IntPtr GetForegroundWindow();',
  '[DllImport("user32.dll")] public static extern int GetWindowThreadProcessId(System.IntPtr h, out int p);',
  '[DllImport("user32.dll")] public static extern System.IntPtr SetThreadDpiAwarenessContext(System.IntPtr c);',
  '[DllImport("user32.dll")] public static extern bool GetWindowRect(System.IntPtr h, out RECT r);',
  'public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }\';',
  // per-monitor aware v2, so the rectangle is in real pixels on scaled displays (missing before Windows 10 1607)
  'try { [void][W.U]::SetThreadDpiAwarenessContext([System.IntPtr](-4)) } catch {};',
  '$h=[W.U]::GetForegroundWindow(); $p=0; [void][W.U]::GetWindowThreadProcessId($h, [ref]$p);',
  '$r=New-Object "W.U+RECT"; [void][W.U]::GetWindowRect($h, [ref]$r);',
  'A ((Get-Process -Id $p).ProcessName + "|" + $r.Left + "|" + $r.Top + "|" + $r.Right + "|" + $r.Bottom)',
  "} catch { 'ERR|' + (A $_.Exception.Message) }",
].join(' ');
// each different PowerShell problem goes to error.log once (a few at most), so a real-machine check can read it
const psWarned = new Set();
function warnPs(msg) {
  if (psWarned.has(msg) || psWarned.size >= 3) return;
  psWarned.add(msg);
  logError('front-app', msg + '（同样的只记一次）');
}
const unescPs = (s) => String(s).replace(/\\u([0-9a-f]{4})/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));
// stderr of a failed run: CLIXML records and XML escapes are noise
const psStderr = (s) => String(s || '').replace(/#< CLIXML/g, ' ').replace(/_x000[DA]_/g, ' ').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 300);
function parseFront(out) {
  const [name = '', ...nums] = String(out || '').trim().split('|');
  const [l, t, r, b] = nums.map(Number);
  const rect = nums.length === 4 && [l, t, r, b].every(Number.isFinite) && r > l && b > t ? { x: l, y: t, width: r - l, height: b - t } : null;
  return { name: name.trim(), rect };
}
function frontApp() {
  return new Promise((resolve) => {
    if (isWin) {
      // -EncodedCommand avoids Windows command-line quoting problems with the C# snippet
      const enc = Buffer.from(FRONT_PS, 'utf16le').toString('base64');
      execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', enc], { windowsHide: true, timeout: 10000 }, (err, out, errOut) => {
        // not err.message: it starts with the whole command line, i.e. the long base64 blob
        if (err) { warnPs(`PowerShell 没跑成：code=${err.code} killed=${err.killed} signal=${err.signal} ${psStderr(errOut)}`); return resolve({ name: '', rect: null }); }
        const line = String(out || '').split(/\r?\n/).map((x) => x.trim()).filter(Boolean).pop() || '';
        if (line.startsWith('ERR|')) { warnPs('PowerShell 报错：' + unescPs(line.slice(4)).replace(/\s+/g, ' ').slice(0, 300)); return resolve({ name: '', rect: null }); }
        resolve(parseFront(unescPs(line)));
      });
    } else if (isMac) {
      execFile('/bin/sh', ['-c', 'lsappinfo info -only name "$(lsappinfo front)"'], { timeout: 5000 }, (err, out) => {
        const m = String(out || '').match(/=\s*"([^"]+)"/);
        resolve({ name: err ? '' : (m ? m[1] : String(out || '').trim()), rect: null });
      });
    } else resolve({ name: '', rect: null });
  });
}
// matched at the start of a word, so "SearchApp" is not Arc and "citizen" is not Zen
const BROWSER_RE = /(?:^|[^a-z0-9])(?:chrome|msedge|edge|firefox|brave|opera|vivaldi|safari|arc|360se|360chrome|qqbrowser|sogou|maxthon|yandex|chromium|zen|whale|liebao|2345)/i;
const isBrowser = (front) => BROWSER_RE.test((front && front.name) || '');

// the display the front window is on (Windows), otherwise the cursor's
function displayFor(front) {
  try {
    if (isWin && front && front.rect) return screen.getDisplayMatching(screen.screenToDipRect(null, front.rect));
  } catch (e) { logError('look-display', e); }
  return screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
}

async function lookAndComment(kind, front) {
  // you asked her to look and her side takes pictures: she looks herself (no words of yours: text is empty)
  const toHer = kind === 'lookAsk' && link.online() && link.feature('images');
  if (!toHer && !ai.hasKey()) { send('ai', { type: 'error', code: 'nokey', text: '' }); return false; }
  if (pro.busy) return false;
  pro.busy = true;
  const auto = kind !== 'lookAsk';
  // an automatic look is announced first and given a moment, so it never happens behind your back
  send('ai', auto ? { type: 'looking', auto: true } : { type: 'looking' });
  try {
    if (auto) {
      await sleepMs(1500);
      if (ai.busy()) return false;              // you started chatting meanwhile: that reply takes over the bubble
    }
    const image = await captureScreen(auto ? displayFor(front) : null);
    if (toHer) {
      const img = imagePart(image);
      if (!img) throw new Error('截图太大了，没发出去');
      const at = link.feature('watch') ? watch.position() : null;
      await linkedChat('', 'text', { images: [img], ...(at ? { context: { watch: { bvid: at.bvid, cid: at.cid, t: at.t, paused: at.paused } } } : {}) });
      pro.lastSaid = Date.now();
      return true;
    }
    const r = await ai.proactive(kind, { image });
    send('ai', { type: 'proactive', kind, text: r.text, stickers: r.stickers });
    if (chatWin && !chatWin.isDestroyed()) chatWin.webContents.send('ai:proactive', r);
    if (link.linked() && r.text) link.offline([{ role: 'pet', text: r.text }]);
    pro.lastSaid = Date.now();
    if (auto) lookFails = 0;
    return true;
  } catch (e) {
    logError('look', e);
    screenHint(e);
    // she already said she was looking, so even an automatic look has to end the "looking" pose (pet.js keeps it soft)
    send('ai', { type: 'error', code: 'look', text: e.message, auto });
    // a vision model or endpoint that keeps refusing images: wait 2 h, then 4, 8... (up to a day) instead of every round
    if (auto) { lookFails++; planNextLook(Math.min(120 * 2 ** (lookFails - 1), 24 * 60)); }
    return false;
  } finally { pro.busy = false; }
}
let lookFails = 0;
on('ai:look', () => { lookAndComment('lookAsk'); });

const LOOK_GAP = { sometimes: [30, 50], often: [10, 18] };
let nextLookAt = Date.now() + 10 * 60000;
function planNextLook(min) {
  const g = LOOK_GAP[ai.lookMode()];
  nextLookAt = Date.now() + (min != null ? min : g ? g[0] + Math.random() * (g[1] - g[0]) : 60) * 60000;
}
// macOS: without the screen-recording permission an automatic look would only bring up the system prompt
function mayCaptureScreen() {
  if (!isMac) return true;
  try { return systemPreferences.getMediaAccessStatus('screen') === 'granted'; } catch (_) { return false; }
}
let lookChecking = false, macLookTold = false, lastFront = null;
async function lookTick() {
  if (lookChecking || !ai.hasKey() || ai.lookMode() === 'off' || Date.now() < nextLookAt || link.online()) return;
  if (powerMonitor.getSystemIdleTime() > 120 || sleeping || pro.busy) return;
  const chatting = Date.now() - pro.lastUserChat < 5 * 60000 || ai.busy() || (chatWin && !chatWin.isDestroyed() && chatWin.isFocused());
  if (chatting || Date.now() - pro.lastSaid < 8 * 60000) return;
  if (!mayCaptureScreen()) {
    // macOS only lists ClaudePet under screen recording after one manual look has asked; say so once per run
    if (!macLookTold) { macLookTold = true; send('ai', { type: 'notice', text: '想让我自动看屏幕的话，Mac 要先允许录屏：右键点一次「看看我在看什么」，在系统弹窗里允许，再重启我' }); }
    planNextLook(60); return;
  }
  lookChecking = true;
  try {
    const front = await frontApp();
    // kept for the diagnostics report: at export time the window in front is the pet's own
    lastFront = { name: front.name, rect: front.rect, browser: isBrowser(front), display: isWin ? (() => { try { return displayFor(front).id; } catch (_) { return null; } })() : null, at: Date.now() };
    if (!isBrowser(front)) { planNextLook(5); return; }   // not in a browser: check again in a few minutes
    planNextLook();
    await lookAndComment('look', front);
  } finally { lookChecking = false; }
}

// ---------- what 阿鲸 sends on her own (cmd.say) and replies that came after the pet gave up waiting ----------
async function linkSay(d) {
  if (d.expires_at && Date.now() > Number(d.expires_at)) return { ok: false, code: 'expired' };
  const source = String(d.source || '');
  // watching together: a line about a moment you have already left behind is dropped (section 16.7)
  if (source === 'watch' && !watch.fresh(d.watch)) return { ok: false, code: 'stale' };
  const { text, stickers: st } = link.toReply(d.parts);
  if (!text && !st.length) return { ok: true };
  if (source === 'watch') {
    send('ai', { type: 'proactive', kind: 'link-watch', text, stickers: [], silent: !watch.speakOn() });
    if (chatWin && !chatWin.isDestroyed()) chatWin.webContents.send('ai:proactive', { text, stickers: [] });
    await ai.record('assistant', text, { via: 'ajing', source });
    pro.lastSaid = Date.now();
    return { ok: true };
  }
  if (source === 'reminder') {
    send('ai', { type: 'reminder', text, stickers: st, task: text });
    try {
      if (Notification.isSupported()) {
        const n = new Notification({ title: '阿鲸提醒你', body: text || '到点啦', silent: false });
        n.on('click', () => openChat());
        n.show();
      }
    } catch (_) {}
  } else send('ai', { type: 'proactive', kind: 'link-' + source, text, stickers: st });
  if (chatWin && !chatWin.isDestroyed()) chatWin.webContents.send('ai:proactive', { text, stickers: st });
  await ai.record('assistant', text || '（发了一个表情）', { via: 'ajing', source, ...(st.length ? { stickers: st } : {}) });
  pro.lastSaid = Date.now();
  return { ok: true };
}
async function linkLate(d) {
  const { text, stickers: st } = link.toReply(d.parts);
  if (!text && !st.length) return;
  send('ai', { type: 'proactive', kind: 'link-late', text, stickers: st });
  if (chatWin && !chatWin.isDestroyed()) chatWin.webContents.send('ai:proactive', { text, stickers: st });
  await ai.record('assistant', text || '（发了一个表情）', { via: 'ajing', late: true, ...(st.length ? { stickers: st } : {}) });
}
// 「她指他点」: she points at a moment; the bubble offers 「跳过去」, and only your click moves the video
let pointNow = null;     // { ref, t, timer }
function linkPoint(d, f) {
  if (d.expires_at && Date.now() > Number(d.expires_at)) return { ok: false, code: 'expired' };
  const at = watch.position();
  if (!at || (d.bvid && d.bvid !== at.bvid)) return { ok: false, code: 'stale' };
  if (pointNow) clearTimeout(pointNow.timer);
  const ref = f.id;
  pointNow = { ref, t: Number(d.t) || 0, timer: setTimeout(() => {
    if (pointNow && pointNow.ref === ref) { pointNow = null; link.send('event.point', { ref, action: 'ignored' }, { ack: true }); }
  }, 15000) };
  send('ai', { type: 'point', ref, text: String(d.text || '这段你看看～').slice(0, 60), t: pointNow.t });
  return { ok: true };
}
on('watch:point-jump', (_e, ref) => {
  if (!pointNow || pointNow.ref !== ref) return;
  clearTimeout(pointNow.timer);
  watch.seek(pointNow.t);
  link.send('event.point', { ref, action: 'jumped' }, { ack: true });
  pointNow = null;
});
// typing in the chat box: she holds back while you're writing (chatty mode); same state at most once per 5 s
let typingLast = { active: false, at: 0 };
on('chat:typing', (_e, active) => {
  active = !!active;
  if (!link.feature('watch')) return;
  if (active === typingLast.active && Date.now() - typingLast.at < 5000) return;
  typingLast = { active, at: Date.now() };
  link.send('event.typing', { active });
});

// ---------- screen capture problems ----------
const SCREEN_PANE = 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture';
function captureError(e) {
  if (!isMac) return '截屏失败：' + e.message;
  return '截屏失败：' + e.message + '（Mac 要在「系统设置 → 隐私与安全性 → 录屏与系统录音」里允许 ClaudePet。如果已经开着，可能是给旧版本开的：把 ClaudePet 删掉（「−」）再加回来（「+」），然后重启她）';
}
// a Mac that says the permission is on but gives no picture: the permission belongs to an older build. Said once a run.
let screenHinted = false;
function screenHint(e) {
  if (!isMac || screenHinted) return;
  let status = '';
  try { status = systemPreferences.getMediaAccessStatus('screen'); } catch (_) {}
  if (status === 'granted' && !/Failed to get sources/i.test(String((e && e.message) || ''))) return;
  screenHinted = true;
  send('ai', { type: 'hint', action: 'screen-settings', text: '我看不到你的屏幕……Mac 的录屏权限可能是给旧版本开的。去设置里把 ClaudePet 删掉再加回来，然后重启我就好～' });
}
on('ui:open-screen-settings', () => { if (isMac) shell.openExternal(SCREEN_PANE).catch(() => {}); });
// a screenshot for her (chat.send.images): JPEG, long side <= 1600 px, <= 700 KB
function imagePart(dataUrl) {
  try {
    let img = nativeImage.createFromDataURL(String(dataUrl || ''));
    if (img.isEmpty()) return null;
    const { width, height } = img.getSize();
    const scale = Math.min(1, 1600 / Math.max(width, height));
    if (scale < 1) img = img.resize({ width: Math.round(width * scale), height: Math.round(height * scale), quality: 'good' });
    for (const q of [80, 70, 60, 50, 40]) {
      const buf = img.toJPEG(q);
      if (buf.length <= 700 * 1024) return { mime: 'image/jpeg', sha256: require('crypto').createHash('sha256').update(buf).digest('hex'), size: buf.length, data: buf.toString('base64') };
    }
  } catch (e) { logError('capture', e); }
  return null;
}
handle('watch:get', () => watch.status());
handle('watch:set', (_e, s) => watch.setConfig(s || {}));
handle('watch:script', () => watch.script());
handle('watch:new-key', () => watch.newKey());

// a few recent link events (types, ids, counts only) for the diagnostics report
const linkLog = [];
const linkNote = (m) => { linkLog.push(`${new Date().toISOString().slice(11, 19)} ${m}`); if (linkLog.length > 40) linkLog.shift(); };
handle('link:get', () => link.getConfig());
handle('link:set', (_e, s) => link.setConfig(s || {}));
handle('link:pair', (_e, code) => link.pair(code));
handle('link:unpair', () => link.unpair());

// ---------- reminders the user asked for ----------
let firing = false;
async function checkReminders() {
  if (firing) return;
  const due = reminders.takeDue();
  if (!due.length) return;
  firing = true;
  try {
    for (const r of due) await fireReminder(r);
  } finally { firing = false; refreshTray(); }
}
async function fireReminder(r) {
  let text = '', st = [];
  if (ai.hasKey() && !link.online()) {
    try { const out = await ai.proactive('reminder', { text: r.text, lateMin: r.lateMin }); text = out.text; st = out.stickers; } catch (e) { logError('proactive:reminder', e); }
  }
  if (!text) text = `到点啦！${r.text}` + (r.lateMin > 2 ? `（刚才电脑没开，晚了 ${r.lateMin} 分钟）` : '');
  send('ai', { type: 'reminder', text, stickers: st, task: r.text });
  if (chatWin && !chatWin.isDestroyed()) chatWin.webContents.send('ai:proactive', { text, stickers: st });
  try {
    if (Notification.isSupported()) {
      const n = new Notification({ title: '大肥鱼提醒你', body: text, silent: false });
      n.on('click', () => openChat());
      n.show();
    }
  } catch (_) {}
  pro.lastSaid = Date.now();
}

function proactiveTick() {
  if (!ai.hasKey() || ai.proactiveMode() === 'off') return;
  const now = Date.now();
  const idle = powerMonitor.getSystemIdleTime();               // seconds without keyboard/mouse
  if (idle >= 600) { if (!pro.away) { pro.away = true; pro.awayStart = now - idle * 1000; } return; }
  if (idle >= 300) pro.restAnchor = now;                       // a 5-minute break counts as rest
  if (pro.away) {
    if (idle > 30) return;
    pro.away = false; pro.restAnchor = now;
    const awayMin = Math.round((now - pro.awayStart) / 60000);
    if (now - pro.lastSaid > 5 * 60000) ai.seen().then((meet) => speakUp('return', { awayMin, meet }), () => speakUp('return', { awayMin }));
    return;
  }
  const chatting = now - pro.lastUserChat < 5 * 60000 || ai.busy() || (chatWin && !chatWin.isDestroyed() && chatWin.isFocused());
  if (chatting) { pro.restAnchor = Math.max(pro.restAnchor, now - 45 * 60000); return; }
  const d = new Date();
  const h = d.getHours(), m = d.getMinutes();
  const nightKey = d.toDateString();
  if (((h === 0 && m >= 30) || (h >= 1 && h < 4)) && now - pro.lastSaid > 20 * 60000) {
    if (link.linked()) {
      const slot = linkProto.careSlot('sleep');
      if (link.careAllowed('sleep', slot) && now - pro.nightAskAt > 60 * 60000) {
        pro.nightAskAt = now;
        speakUp('night').then((ok) => { if (ok) { link.care('sleep', slot, 'asked'); pro.careAsk = { kind: 'sleep', slot, at: Date.now() }; } });
        return;
      }
    } else if (pro.nightKey !== nightKey) { pro.nightKey = nightKey; speakUp('night'); return; }
  }
  if (now - pro.restAnchor >= 50 * 60000 && now - pro.lastSaid > 10 * 60000) {
    pro.restAnchor = now; speakUp('rest', { activeMin: 50 }); return;
  }
  if (!sleeping && now >= pro.nextChatAt && now - pro.lastSaid > 15 * 60000) speakUp('chat');
}

// ---------- ipc ----------
on('set-pos', (_e, x, y) => {
  if (!win) return;
  const nx = px(x), ny = px(y);
  // never hand the OS a broken coordinate (NaN / absurd values): ignore it and let the renderer resync
  if (!Number.isFinite(nx) || !Number.isFinite(ny) || Math.abs(nx) > 100000 || Math.abs(ny) > 100000) {
    logError('set-pos', new Error(`bad position ${x}, ${y}`));
    send('cmd', 'display-changed');
    return;
  }
  const [cx, cy] = win.getPosition();
  if (cx !== nx || cy !== ny) win.setPosition(nx, ny);
  settings.x = nx; settings.y = ny; saveSettings();
});
handle('get-bounds', () => {
  if (!win) return null;
  const b = win.getBounds();
  return { bounds: b, workArea: workAreaAt(b.x + b.width / 2, b.y + b.height - 10) };
});
handle('get-cursor', () => screen.getCursorScreenPoint());
handle('get-settings', () => ({ size: settings.size, height: SIZES[settings.size], walk: settings.walk, outfit: settings.outfit, whisper: ai.whisperMode() }));
// a line made up by the model for her muttering; skipped while you are away so it costs nothing
handle('ai:whisper', async (_e, ctx) => {
  if (powerMonitor.getSystemIdleTime() > 600) return { ok: false, reason: 'away' };
  if (link.online()) return { ok: false, reason: 'linked' };
  return ai.whisper({ action: String((ctx && ctx.action) || '').slice(0, 40) });
});
handle('ui:outfit', () => settings.outfit);
on('ui:set-outfit', (_e, k) => setOutfit(k));
on('ignore-mouse', (_e, ignore) => {
  if (!win) return;
  if (ignore) win.setIgnoreMouseEvents(true, { forward: true });
  else win.setIgnoreMouseEvents(false);
});
on('context-menu', () => {
  if (!win) return;
  buildMenu().popup({ window: win });
});
on('sleep-state', (_e, v) => { sleeping = !!v; refreshTray(); });

// ---------- diagnostics: a plain-text report to send along when something goes wrong ----------
const stamp = (d = new Date()) => { const p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`; };
const reEsc = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function tailFile(f, n) {
  try { return fs.readFileSync(f, 'utf8').split(/\r?\n/).filter(Boolean).slice(-n).join('\n') || '（空）'; } catch (_) { return '（没有这个文件）'; }
}
// the home folder and the account name become ~ (paths also show up JSON-escaped and with forward slashes);
// anything shaped like an API key is masked in case an error message echoed one
function scrub(text) {
  const home = os.homedir();
  let user = '';
  try { user = os.userInfo().username || ''; } catch (_) {}
  let t = String(text);
  // the shared folder (it may be outside the home folder, e.g. D:\坚果云\...) and the saved key
  if (typeof ai.redact === 'function') { try { t = ai.redact(t); } catch (_) {} }
  // an older JSON.parse message quotes a piece of the file, which may be memory or chat text
  t = t.replace(/(Unexpected token [^\n]*?), (?:\.\.\.)?"[\s\S]{0,400}?" is not valid JSON/g, '$1 …');
  for (const h of [...new Set([home.replace(/\\/g, '\\\\'), home, home.replace(/\\/g, '/')])]) if (h && h.length > 1) t = t.replace(new RegExp(reEsc(h), 'gi'), '~');
  // a very short ASCII name ("a", "pc") would eat ordinary words, so it is only replaced as a path segment
  if (user) t = t.replace(new RegExp(user.length >= 3 || /[^\x00-\x7f]/.test(user) ? reEsc(user) : `(?<=[\\\\/])${reEsc(user)}(?![\\w.-])`, 'gi'), '~');
  return t.replace(/\b(sk-)[A-Za-z0-9_-]{12,}/g, '$1***');
}
const when = (ms) => (Number.isFinite(ms) && ms > 0 ? new Date(ms).toLocaleString('zh-CN', { hour12: false }) : '不会');
async function diagnosticsText() {
  const L = [];
  const sec = (title) => L.push('', `==== ${title} ====`);
  const kv = (k, v) => L.push(`${k}：${typeof v === 'string' ? v : JSON.stringify(v)}`);
  const safe = (fn) => { try { return fn(); } catch (e) { return `（读取失败：${e.message}）`; } };
  const block = (o) => { if (o && typeof o === 'object' && !Array.isArray(o)) for (const [k, v] of Object.entries(o)) kv(k, v); else kv('结果', o); };
  L.push('ClaudePet 诊断信息', `生成时间：${new Date().toLocaleString('zh-CN', { hour12: false })}`,
    '（这里面没有 API Key、人设、记忆和聊天内容；用户目录和用户名已经换成 ~）');

  sec('程序');
  kv('版本', app.getVersion());
  kv('安装版', app.isPackaged ? '是' : '否（开发版，npm start）');
  kv('Electron / Chrome / Node', `${process.versions.electron} / ${process.versions.chrome} / ${process.versions.node}`);
  kv('系统', `${process.platform} ${process.arch}，内核 ${os.release()}${typeof os.version === 'function' ? `（${safe(() => os.version())}）` : ''}`);
  kv('语言', `${app.getLocale()}${typeof app.getSystemLocale === 'function' ? ` / 系统 ${safe(() => app.getSystemLocale())}` : ''}`);
  kv('已运行', `${Math.round(process.uptime() / 60)} 分钟`);
  kv('数据目录', app.getPath('userData'));

  sec('显示器');
  const primaryId = safe(() => screen.getPrimaryDisplay().id);
  for (const d of safe(() => screen.getAllDisplays()) || []) {
    kv(`显示器 ${d.id}${d.id === primaryId ? '（主屏）' : ''}`, { bounds: d.bounds, workArea: d.workArea, scaleFactor: d.scaleFactor, rotation: d.rotation, internal: d.internal });
  }
  if (win && !win.isDestroyed()) kv('桌宠窗口', win.getBounds());

  sec('显卡');
  block(safe(() => app.getGPUFeatureStatus()));

  sec('内存和 CPU');
  const metrics = safe(() => app.getAppMetrics());
  if (Array.isArray(metrics)) {
    let total = 0;
    for (const m of metrics) {
      const mb = ((m.memory && m.memory.workingSetSize) || 0) / 1024;
      total += mb;
      const what = [m.serviceName, m.name].find((x) => x && x !== m.type) || '';
      L.push(`${m.type}${what ? ' ' + what : ''}：内存 ${mb.toFixed(1)} MB，CPU ${((m.cpu && m.cpu.percentCPUUsage) || 0).toFixed(1)}%`);
    }
    kv('合计', `${metrics.length} 个进程，内存 ${total.toFixed(1)} MB`);
  } else kv('进程', metrics);

  sec('桌宠设置（settings.json）');
  block(settings);
  kv('开机自动启动', safe(() => app.getLoginItemSettings().openAtLogin));

  sec('AI');
  if (typeof ai.diagnostics === 'function') block(await Promise.resolve().then(() => ai.diagnostics()).catch((e) => `（读取失败：${e.message}）`));
  else { kv('有 Key', ai.hasKey()); kv('主动搭话', ai.proactiveMode()); kv('看屏幕', ai.lookMode()); }
  kv('下次闲聊', when(pro.nextChatAt));
  kv('下次自动看屏幕', ai.lookMode() === 'off' ? '不会（关着）' : when(nextLookAt));

  sec('连接阿鲸（AstrBot）');
  block(safe(() => link.diagnostics()));
  sec('一起看');
  block(safe(() => { const w = watch.status(); return { 开着: w.enabled, 接口开着: w.listening, 端口: w.port, 档位: w.mode, 话多每小时: w.hourly_max, 念出来: w.speak, 脚本上次来: w.scriptSeenAt ? when(w.scriptSeenAt) : '没来过', 正在看: !!w.watching, 阿鲸那边支持: w.herSide, 出错: w.error || '' }; }));
  if (linkLog.length) kv('最近的连接记录', '\n' + linkLog.slice(-15).join('\n'));

  sec('语音');
  block(safe(() => { const v = voice.publicSettings(); delete v.edgeVoices; return v; }));
  const sherpa = safe(() => voiceHost.sherpaDir());
  kv('离线语音运行库', fs.existsSync(path.join(sherpa, 'sherpa-onnx-node')) ? `有（${safe(() => fs.readdirSync(sherpa).join('、'))}）` : `没有（应该在 ${sherpa}）`);

  sec('表情包');
  block(safe(() => stickers.status()));

  sec('提醒');
  kv('待提醒', `${safe(() => reminders.pending().length)} 个`);
  if (typeof reminders.warning === 'function' && reminders.warning()) kv('提醒文件', reminders.warning());

  if (isWin || lastFront) {
    sec('前台窗口（自动看屏幕用）');
    if (lastFront) {
      kv('上次自动看屏幕检查时', when(lastFront.at));
      kv('　前台程序', lastFront.name || '（没取到，PowerShell 可能被拦了）');
      kv('　窗口位置（物理像素）', lastFront.rect);
      kv('　算作浏览器', lastFront.browser ? '是' : '否');
      if (isWin) kv('　会截', `显示器 ${lastFront.display}`);
    } else kv('上次自动看屏幕检查时', ai.lookMode() === 'off' ? '还没检查过（自动看屏幕关着）' : '这次启动后还没检查过');
    if (isWin) {
      // exporting from the settings page or the tray brings the pet's own window to the front
      const f = await frontApp();
      kv('导出时的前台窗口（一般是桌宠自己的窗口）', f.name || '（没取到，PowerShell 可能被拦了）');
      kv('　窗口位置（物理像素）', f.rect);
      kv('　所在', `显示器 ${safe(() => displayFor(f).id)}`);
    }
  }
  if (isMac) {
    sec('Mac 权限');
    kv('录屏', safe(() => systemPreferences.getMediaAccessStatus('screen')));
    kv('麦克风', safe(() => systemPreferences.getMediaAccessStatus('microphone')));
  }

  const ud = app.getPath('userData');
  sec('错误日志（error.log 最后 300 行）');
  L.push(tailFile(path.join(ud, 'error.log'), 300));
  sec('表情包错误日志（stickers/error.log 最后 300 行）');
  L.push(tailFile(path.join(ud, 'stickers', 'error.log'), 300));
  return scrub(L.join('\n') + '\n');
}
async function exportDiagnostics(parent) {
  try {
    let dir;
    try { dir = app.getPath('desktop'); } catch (_) { dir = os.homedir(); }
    if (isMac) app.focus({ steal: true });
    const r = await dialog.showSaveDialog(parent || undefined, {
      title: '导出诊断信息', defaultPath: path.join(dir, `ClaudePet-诊断-${stamp()}.txt`), filters: [{ name: '文本文件', extensions: ['txt'] }],
    });
    if (r.canceled || !r.filePath) return { ok: false, canceled: true, error: '已取消' };
    const text = await diagnosticsText();
    // BOM + CRLF on Windows so old Notepad shows the Chinese text properly
    await fs.promises.writeFile(r.filePath, '\ufeff' + (isWin ? text.replace(/\n/g, '\r\n') : text), 'utf8');
    return { ok: true, path: r.filePath };
  } catch (e) {
    logError('diag', e);
    return { ok: false, error: '导出失败：' + e.message };
  }
}
async function exportFromMenu() {
  const r = await exportDiagnostics();
  if (r.ok) { send('ai', { type: 'notice', text: '诊断信息存好啦：' + path.basename(r.path) }); shell.showItemInFolder(r.path); }
  else if (!r.canceled) send('ai', { type: 'notice', text: r.error });
}
handle('diag:export', (e) => exportDiagnostics(BrowserWindow.fromWebContents(e.sender)));

// ---------- hardening: pages stay on app://pet/, open nothing, get no permissions except the chat's microphone ----------
app.on('web-contents-created', (_e, wc) => {
  wc.on('will-navigate', (ev, url) => { if (!String((ev && ev.url) || url || '').startsWith('app://pet/')) ev.preventDefault(); });
  wc.setWindowOpenHandler(() => ({ action: 'deny' }));
  wc.on('will-attach-webview', (ev) => ev.preventDefault());
});
function guardPermissions() {
  session.defaultSession.setPermissionRequestHandler((wc, permission, cb, details) => {
    let url = (details && details.requestingUrl) || '';
    try { if (!url && wc && !wc.isDestroyed()) url = wc.getURL(); } catch (_) {}
    url = String(url);
    const types = (details && details.mediaTypes) || [];
    cb(permission === 'media' && url.startsWith('app://pet/renderer/chat.html') && types.every((t) => t === 'audio'));
  });
}
app.on('child-process-gone', (_e, d) => {
  // the voice engine is stopped by us after 15 idle minutes; that is not worth a log line
  if (d.reason === 'clean-exit' || (d.serviceName === 'ClaudePet Voice' && d.reason === 'killed')) return;
  logError('child-process-gone', `${d.type}${d.serviceName ? ' ' + d.serviceName : ''}${d.name ? ' ' + d.name : ''}: ${d.reason} (${d.exitCode})`);
});

// ---------- lifecycle ----------
app.on('second-instance', () => { if (win) { win.showInactive(); send('cmd', 'talk'); } });

app.whenReady().then(() => {
  if (!gotLock) return;
  guardPermissions();
  registerAppProtocol();
  loadSettings();
  stickers.init();
  if (typeof ai.setLogger === 'function') ai.setLogger(logError);
  if (typeof reminders.setLogger === 'function') reminders.setLogger(logError);
  ai.init();
  link.init({
    userData: app.getPath('userData'), safeStorage, appVersion: app.getVersion(), log: linkNote,
    onSay: (d) => linkSay(d), onLate: (d) => linkLate(d).catch((e) => logError('link:late', e)),
    onStatus: () => { broadcast('link:status', link.getConfig()); broadcast('watch:status', watch.status()); },
    onMode: (d) => watch.applyMode(d), onPoint: (d, f) => linkPoint(d, f), onOnline: () => watch.tellMode('connect'),
  });
  watch.init({ userData: app.getPath('userData'), link, log: linkNote, onChange: (st) => broadcast('watch:status', st) }).catch((e) => logError('watch', e));
  ai.setLinkMemory(() => link.offlinePrompt());
  // when we met (today first / last time, on which computer) is shared through the memory folder: note this start,
  // and keep noting it every few minutes while the user is at the computer
  startMeet = ai.seen().catch(() => null);
  setInterval(() => { if (powerMonitor.getSystemIdleTime() < 300) ai.seen().catch(() => {}); }, 5 * 60000);
  ai.setOutfit(settings.outfit);
  reminders.init();
  voice.init({ toPet: (ch, payload) => { if (win && !win.isDestroyed()) win.webContents.send(ch, payload); }, broadcast: (ch, p) => { broadcast(ch, p); if (ch === 'voice:changed') refreshTray(); }, logError, handle, on });
  planNextChat();
  setInterval(proactiveTick, 30000);
  setInterval(checkReminders, 15000);
  setInterval(lookTick, 60000);
  setTimeout(checkReminders, 5000);
  powerMonitor.on('resume', () => setTimeout(checkReminders, 3000));
  powerMonitor.on('unlock-screen', () => setTimeout(checkReminders, 1500));
  if (isWin) app.setAppUserModelId('com.fanmade.claudepet');
  if (isMac && app.dock) app.dock.hide();
  createWindow();
  setupTray();
  screen.on('display-metrics-changed', () => send('cmd', 'display-changed'));
  if (process.env.PET_TEST) {
    global.__pet = { speakUp, pro, checkReminders, reminders, lookAndComment, frontApp, captureScreen, voice, openChat, chatWin: () => chatWin, settingsWin: () => settingsWin, openSettings, setOutfit, send, settings: () => settings, stickers, pushSettings, ai,
      lookTick, planNextLook, parseFront, isBrowser, displayFor, diagnosticsText, exportDiagnostics, scrub, buildMenu, link, careHeard, watch, linkPoint, imagePart };
    require(process.env.PET_TEST)(() => win);
  }
  screen.on('display-removed', () => send('cmd', 'display-changed'));
});

app.on('window-all-closed', () => app.quit());
app.on('before-quit', () => { ai.abort(); link.stop(); watch.stop(); });
