'use strict';
const { app, BrowserWindow, ipcMain, screen, Menu, Tray, nativeImage, protocol, net, powerMonitor, shell, Notification, desktopCapturer, systemPreferences } = require('electron');
const { execFile } = require('child_process');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');
const ai = require('./ai');
const stickers = require('./stickers');
const reminders = require('./reminders');
const voice = require('./voice');

// serve the UI from app://pet/... so canvas pixels stay same-origin (needed for click-through hit tests)
protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
]);
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif',
  '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.wav': 'audio/wav', '.ttf': 'font/ttf', '.txt': 'text/plain; charset=utf-8',
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
    const p = path.normalize(path.join(root, decodeURIComponent(u.pathname)));
    if (!p.startsWith(root)) return new Response('forbidden', { status: 403 });
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

const isMac = process.platform === 'darwin';
const isWin = process.platform === 'win32';
// Windows with a virtual display driver (ToDesk, remote desktop, emulators...) crashes Chromium's
// sandboxed GPU process on start-up; this window only draws our own local files, so drop that sandbox.
// (fix found in github.com/PC2005-cloud/dsh-pet)
if (isWin && process.env.PET_GPU_SANDBOX !== '1') app.commandLine.appendSwitch('disable-gpu-sandbox');

if (!app.requestSingleInstanceLock()) {
  app.quit();
}

// ---------- settings ----------
const SIZES = { small: 150, medium: 200, large: 260, huge: 340 };
const SIZE_LABELS = { small: '小', medium: '中', large: '大', huge: '特大' };
const defaults = { size: 'medium', walk: true, alwaysOnTop: true, x: null, y: null, outfit: 'claude' };
const OUTFITS = { claude: 'Claude 装', maid: '女仆装（原版大肥鱼）' };
let settingsPath;
let settings = { ...defaults };

function loadSettings() {
  settingsPath = path.join(app.getPath('userData'), 'settings.json');
  try {
    settings = { ...defaults, ...JSON.parse(fs.readFileSync(settingsPath, 'utf8')) };
  } catch (_) { settings = { ...defaults }; }
  if (!SIZES[settings.size]) settings.size = 'medium';
  if (!OUTFITS[settings.outfit]) settings.outfit = 'claude';
}
let saveTimer = null;
function saveSettings() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try { fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 1)); } catch (_) {}
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
    { label: '开机自动启动', type: 'checkbox', checked: loginOn, click: (i) => app.setLoginItemSettings({ openAtLogin: i.checked }) },
    { label: '回到屏幕中间', click: () => resetPosition() },
    { label: 'AI 设置…', click: () => openSettings() },
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
    else if (['done', 'proactive', 'reminder'].includes(ev.type) && ev.text) voice.speak(ev.text);
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

ipcMain.handle('ai:send', async (_e, text, withScreen) => {
  pro.lastUserChat = Date.now();
  send('ai', { type: 'thinking' });
  try {
    let image = null;
    if (withScreen) {
      try { image = await captureScreen(); } catch (e) { logError('capture', e); throw Object.assign(new Error('截屏失败：' + e.message + (isMac ? '（Mac 需要在「系统设置 → 隐私与安全性 → 录屏与系统录音」里允许 ClaudePet，然后重启它）' : '')), { code: 'capture' }); }
    }
    const r = await ai.send(String(text || '').slice(0, 4000), (t) => {
      if (chatWin) chatWin.webContents.send('ai:delta', t);
      send('ai', { type: 'delta', text: t });
    }, { image });
    const remindSet = [], remindFail = [], remindCancelled = [];
    for (const x of r.remindAdd || []) {
      const res = reminders.add(x.at, x.text);
      if (res.ok) remindSet.push(res.label); else remindFail.push(res.error);
    }
    for (const k of r.remindCancel || []) remindCancelled.push(...reminders.cancel(k));
    if (remindSet.length || remindCancelled.length) refreshTray();
    send('ai', { type: 'done', text: r.reply, remembered: r.remembered, stickers: r.stickers, remindSet });
    pro.lastUserChat = Date.now();
    return { ok: true, reply: r.reply, remembered: r.remembered, stickers: r.stickers, remindSet, remindFail, remindCancelled };
  } catch (e) {
    send('ai', { type: 'error', code: e.code || '', text: e.message });
    return { ok: false, error: e.message, code: e.code || '' };
  }
});
ipcMain.on('ai:stop', () => ai.abort());
ipcMain.handle('ai:history', () => ai.history());
ipcMain.handle('ai:sticker-credit', () => stickers.attribution());
ipcMain.handle('stickers:test', () => stickers.selfTest());
ipcMain.handle('reminders:list', () => reminders.pending());
ipcMain.handle('ai:balance', async () => {
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
ipcMain.handle('reminders:delete', (_e, id) => { const ok = reminders.remove(id); refreshTray(); return ok; });
ipcMain.handle('stickers:status', () => stickers.status());
ipcMain.handle('ai:clear', () => { ai.clearHistory(); return true; });
ipcMain.handle('ai:settings:get', () => ai.publicSettings());
ipcMain.handle('ai:settings:set', (_e, s) => { const r = ai.updateSettings(s || {}); planNextChat(); planNextLook(); pushSettings(); return r; });
ipcMain.handle('ai:import-dsh', () => { try { return ai.importFromDsh(); } catch (e) { return { ok: false, error: e.message }; } });
ipcMain.handle('ai:test', () => ai.test());
ipcMain.handle('ai:models', () => ai.listModels());
ipcMain.on('ui:open-settings', () => openSettings());
ipcMain.on('ui:open-chat', () => openChat());
ipcMain.handle('voice:mic-access', async () => {
  if (!isMac) return true;
  try {
    if (systemPreferences.getMediaAccessStatus('microphone') === 'granted') return true;
    return await systemPreferences.askForMediaAccess('microphone');
  } catch (_) { return false; }
});
ipcMain.on('ui:close', (e) => { const w = BrowserWindow.fromWebContents(e.sender); if (w) w.close(); });
ipcMain.on('ui:open-url', (_e, url) => {
  try {
    const h = new URL(url).hostname;
    if (['kiriyuki.com', 'space.bilibili.com', 'github.com', 'creativecommons.org', 'platform.deepseek.com', 'api-docs.deepseek.com', 'www.bilibili.com'].includes(h)) shell.openExternal(url);
  } catch (_) {}
});
ipcMain.handle('ai:will-greet', () => ai.hasKey() && ai.proactiveMode() !== 'off');
ipcMain.on('ai:greet', () => { speakUp('startup'); });

// ---------- proactive talk: she starts a conversation by herself ----------
const pro = {
  lastSaid: 0, lastUserChat: 0, away: false, awayStart: 0,
  restAnchor: Date.now(), nightKey: '', nextChatAt: 0, busy: false,
};
const CHAT_GAP = { hourly: [50, 75], often: [18, 26] };
function planNextChat() {
  const g = CHAT_GAP[ai.proactiveMode()];
  pro.nextChatAt = g ? Date.now() + (g[0] + Math.random() * (g[1] - g[0])) * 60000 : Infinity;
}
async function speakUp(kind, ctx) {
  if (pro.busy || !ai.hasKey() || ai.proactiveMode() === 'off') return false;
  pro.busy = true;
  pro.lastSaid = Date.now();
  planNextChat();
  try {
    const r = await ai.proactive(kind, ctx);
    send('ai', { type: 'proactive', kind, text: r.text, stickers: r.stickers });
    if (chatWin && !chatWin.isDestroyed()) chatWin.webContents.send('ai:proactive', r);
    return true;
  } catch (e) {
    send('ai', { type: 'proactive-failed', kind });
    return false;
  } finally { pro.busy = false; }
}
// ---------- looking at the screen ----------
const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));
// capture the display the cursor is on; our own windows are hidden from the capture
async function captureScreen() {
  const d = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
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

// name of the app in front (used so she only glances while you are in a browser)
function frontApp() {
  return new Promise((resolve) => {
    if (isWin) {
      const ps = 'Add-Type -Namespace W -Name U -MemberDefinition \'[DllImport("user32.dll")] public static extern System.IntPtr GetForegroundWindow(); [DllImport("user32.dll")] public static extern int GetWindowThreadProcessId(System.IntPtr h, out int p);\'; $p=0; [void][W.U]::GetWindowThreadProcessId([W.U]::GetForegroundWindow(), [ref]$p); (Get-Process -Id $p).ProcessName';
      // -EncodedCommand avoids Windows command-line quoting problems with the C# snippet
      const enc = Buffer.from(ps, 'utf16le').toString('base64');
      execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', enc], { windowsHide: true, timeout: 10000 }, (err, out) => resolve(err ? '' : String(out).trim()));
    } else if (isMac) {
      execFile('/bin/sh', ['-c', 'lsappinfo info -only name "$(lsappinfo front)"'], { timeout: 5000 }, (err, out) => {
        const m = String(out || '').match(/=\s*"([^"]+)"/);
        resolve(err ? '' : (m ? m[1] : String(out || '').trim()));
      });
    } else resolve('');
  });
}
const BROWSER_RE = /chrome|msedge|edge|firefox|brave|opera|vivaldi|safari|arc|360se|360chrome|qqbrowser|sogou|maxthon|yandex|chromium|zen|whale|liebao|2345/i;

async function lookAndComment(kind) {
  if (!ai.hasKey()) { send('ai', { type: 'error', code: 'nokey', text: '' }); return false; }
  if (pro.busy) return false;
  pro.busy = true;
  if (kind === 'lookAsk') send('ai', { type: 'looking' });
  try {
    const image = await captureScreen();
    const r = await ai.proactive(kind, { image });
    send('ai', { type: 'proactive', kind, text: r.text, stickers: r.stickers });
    if (chatWin && !chatWin.isDestroyed()) chatWin.webContents.send('ai:proactive', r);
    pro.lastSaid = Date.now();
    return true;
  } catch (e) {
    logError('look', e);
    if (kind === 'lookAsk') send('ai', { type: 'error', code: 'look', text: e.message });
    return false;
  } finally { pro.busy = false; }
}
ipcMain.on('ai:look', () => { lookAndComment('lookAsk'); });

const LOOK_GAP = { sometimes: [30, 50], often: [10, 18] };
let nextLookAt = Date.now() + 10 * 60000;
function planNextLook(min) {
  const g = LOOK_GAP[ai.lookMode()];
  nextLookAt = Date.now() + (min != null ? min : g ? g[0] + Math.random() * (g[1] - g[0]) : 60) * 60000;
}
let lookChecking = false;
async function lookTick() {
  if (lookChecking || !ai.hasKey() || ai.lookMode() === 'off' || Date.now() < nextLookAt) return;
  if (powerMonitor.getSystemIdleTime() > 120 || sleeping || pro.busy) return;
  const chatting = Date.now() - pro.lastUserChat < 5 * 60000 || ai.busy() || (chatWin && !chatWin.isDestroyed() && chatWin.isFocused());
  if (chatting || Date.now() - pro.lastSaid < 8 * 60000) return;
  lookChecking = true;
  try {
    const name = await frontApp();
    if (!BROWSER_RE.test(name)) { planNextLook(3); return; }   // not in a browser: check again in a few minutes
    planNextLook();
    await lookAndComment('look');
  } finally { lookChecking = false; }
}

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
  if (ai.hasKey()) {
    try { const out = await ai.proactive('reminder', { text: r.text, lateMin: r.lateMin }); text = out.text; st = out.stickers; } catch (_) {}
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
    if (now - pro.lastSaid > 5 * 60000) speakUp('return', { awayMin });
    return;
  }
  const chatting = now - pro.lastUserChat < 5 * 60000 || ai.busy() || (chatWin && !chatWin.isDestroyed() && chatWin.isFocused());
  if (chatting) { pro.restAnchor = Math.max(pro.restAnchor, now - 45 * 60000); return; }
  const d = new Date();
  const h = d.getHours(), m = d.getMinutes();
  const nightKey = d.toDateString();
  if (((h === 0 && m >= 30) || (h >= 1 && h < 4)) && pro.nightKey !== nightKey && now - pro.lastSaid > 20 * 60000) {
    pro.nightKey = nightKey; speakUp('night'); return;
  }
  if (now - pro.restAnchor >= 50 * 60000 && now - pro.lastSaid > 10 * 60000) {
    pro.restAnchor = now; speakUp('rest', { activeMin: 50 }); return;
  }
  if (!sleeping && now >= pro.nextChatAt && now - pro.lastSaid > 15 * 60000) speakUp('chat');
}

// ---------- ipc ----------
ipcMain.on('set-pos', (_e, x, y) => {
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
ipcMain.handle('get-bounds', () => {
  if (!win) return null;
  const b = win.getBounds();
  return { bounds: b, workArea: workAreaAt(b.x + b.width / 2, b.y + b.height - 10) };
});
ipcMain.handle('get-cursor', () => screen.getCursorScreenPoint());
ipcMain.handle('get-settings', () => ({ size: settings.size, height: SIZES[settings.size], walk: settings.walk, outfit: settings.outfit, whisper: ai.whisperMode() }));
// a line made up by the model for her muttering; skipped while you are away so it costs nothing
ipcMain.handle('ai:whisper', async (_e, ctx) => {
  if (powerMonitor.getSystemIdleTime() > 600) return { ok: false, reason: 'away' };
  return ai.whisper({ action: String((ctx && ctx.action) || '').slice(0, 40) });
});
ipcMain.handle('ui:outfit', () => settings.outfit);
ipcMain.on('ui:set-outfit', (_e, k) => setOutfit(k));
ipcMain.on('ignore-mouse', (_e, ignore) => {
  if (!win) return;
  if (ignore) win.setIgnoreMouseEvents(true, { forward: true });
  else win.setIgnoreMouseEvents(false);
});
ipcMain.on('context-menu', () => {
  if (!win) return;
  buildMenu().popup({ window: win });
});
ipcMain.on('sleep-state', (_e, v) => { sleeping = !!v; refreshTray(); });

// ---------- lifecycle ----------
app.on('second-instance', () => { if (win) { win.showInactive(); send('cmd', 'talk'); } });

app.whenReady().then(() => {
  registerAppProtocol();
  loadSettings();
  stickers.init();
  ai.init();
  ai.setOutfit(settings.outfit);
  reminders.init();
  voice.init({ toPet: (ch, payload) => { if (win && !win.isDestroyed()) win.webContents.send(ch, payload); }, broadcast: (ch, p) => { broadcast(ch, p); if (ch === 'voice:changed') refreshTray(); }, logError });
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
  if (process.env.PET_TEST) { global.__pet = { speakUp, pro, checkReminders, reminders, lookAndComment, frontApp, captureScreen, voice, openChat, chatWin: () => chatWin, settingsWin: () => settingsWin, openSettings, setOutfit, send, settings: () => settings, stickers, pushSettings, ai }; require(process.env.PET_TEST)(() => win); }
  screen.on('display-removed', () => send('cmd', 'display-changed'));
});

app.on('window-all-closed', () => app.quit());
app.on('before-quit', () => ai.abort());
