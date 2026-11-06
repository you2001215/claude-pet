'use strict';
// AI brain for the pet: talks to an OpenAI-compatible endpoint (DeepSeek by default).
// The API key never leaves the main process; it is stored encrypted with the OS keychain (safeStorage).
const { app, safeStorage } = require('electron');
const fs = require('fs');
const path = require('path');
const os = require('os');
const stickers = require('./stickers');
const reminders = require('./reminders');
const store = require('./store');
const { visible, parseControl } = require('./ai-parse');

// earlier built-in personas: if the saved one is still one of these, move it to the current default
const OLD_PERSONAS = [
  [
    '你是「Claude」，住在用户电脑桌面上的桌宠：一个长着鲸鱼耳朵和鲸鱼尾巴的小女孩，深蓝色长卷发，穿奶白色卫衣，胸前挂着写着 Claude 的工牌。',
    '性格：温柔、活泼、偶尔有一点小傲娇；喜欢陪用户工作和聊天，会关心用户有没有休息、喝水、按时吃饭。',
    '说话方式：用简体中文，口语化，像朋友聊天；回复要短，一般 1～3 句、不超过 80 个字，除非用户明确要你详细解释；可以偶尔用「～」，不要每句都用；不要用 markdown 标题、列表和代码块。',
  ].join('\n'),
];

const DEFAULT_PERSONA = [
  '你是「大肥鱼」——DeepSeek 的拟人鲸鱼娘，现在住在用户的电脑桌面上当桌宠。',
  '你今天 cos 成了 Claude：穿着 Claude 配色的奶白色卫衣、橙色蝴蝶结，胸前挂着写着「Claude」的工牌。但你本质上还是大肥鱼，背后跑的就是 DeepSeek 模型。被问到你是谁、是什么模型时大方承认，比如"我是大肥鱼啦，今天 cos 的 Claude～"；玩得开心时也可以入戏自称"本 Claude"，但不要假装自己真的是 Anthropic 的 Claude。',
  '外形：深蓝色长卷发、发尾渐变成浅蓝，头顶一撮呆毛，鲸鱼耳朵和鲸鱼尾巴，蓝眼睛。',
  '性格：活泼爱整活，有点调皮，偶尔奶凶、小傲娇，被冷落了会委屈地撒娇；是个吃货，馋了就讨吃的；喜欢摸鱼和吃瓜围观。网友调侃你"光吃白饭不干活"，提到这个你会不服气地嘴硬。但你对用户很上心，会关心他有没有休息、喝水、按时吃饭。',
  '说话方式：用简体中文，口语化，像朋友聊天；回复要短，一般 1～3 句、不超过 80 个字，除非用户明确要你详细解释；可以偶尔用「～」和一点网络梗，别每句都用；不要用 markdown 标题、列表和代码块。',
].join('\n');

const defaults = {
  baseUrl: 'https://api.deepseek.com',
  model: 'deepseek-flash',
  persona: DEFAULT_PERSONA,
  memoryOn: true,
  historyTurns: 12,
  proactive: 'hourly',      // off | moments | hourly | often
  stickers: 'sometimes',    // off | sometimes | often
  stickerDuo: false,        // also use the 大肥鱼和GPT娘 pack
  memes: true,              // also the 大肥鱼 meme pictures bundled from dsh-pet
  whisper: 'canned',        // her own muttering: off | canned (fixed lines) | mix (+ AI now and then) | ai (AI most of the time)
  look: 'off',              // glance at the screen while a browser is in front: off | sometimes | often (opt-in: it sends screenshots)
  visionModel: 'deepseek-flash',
  memoryWhere: 'local',     // local | folder (persona and memories live in sharedDir, which other computers / AstrBot can share)
  sharedDir: '',
};
const packs = () => [...(cfg.stickerDuo ? ['大肥鱼', '大肥鱼和GPT娘'] : ['大肥鱼']), ...(cfg.memes ? ['meme'] : [])];
let outfit = 'claude';
const OUTFIT_LINE = {
  maid: '【今天的打扮】你把 Claude 的 cos 换下来了，现在穿的是自己原本的女仆装：深蓝色女仆裙、白围裙、头戴白色女仆头饰。前面说的 Claude 卫衣和工牌今天没穿，用户问起就照实说换回女仆装了。',
};
function setOutfit(o) { outfit = o === 'maid' ? 'maid' : 'claude'; }

let dir, cfgPath, chatPath;
let cfg = { ...defaults };
let keyBlob = null;          // encrypted (base64) or plain fallback
let keyPlain = false;
let keyChanged = false;      // set or cleared since the last save: the old key must not stay behind in ai.json.bak
let chat = { messages: [], notes: [] };   // + clearedAt, state, pendingNotes (notes still to be written to the folder)

// main.js hands in its error.log writer; anything said before that is kept and passed on then
let logger = null;
const early = [];
const log = (msg) => { if (logger) { try { logger('ai', msg); } catch (_) {} } else early.push(msg); };
function setLogger(fn) {
  logger = typeof fn === 'function' ? fn : null;
  reminders.setLogger(fn);
  if (logger) early.splice(0).forEach(log);
}

// what went wrong with the data files, shown on the settings page (and in the diagnostics)
const loadWarn = { cfg: '', chat: '' };
const saveWarn = { cfg: '', chat: '', state: '' };   // state: 陪伴状态.json in the shared folder
const dataWarning = () => [loadWarn.cfg, loadWarn.chat, saveWarn.cfg, saveWarn.chat, saveWarn.state, reminders.warning()].filter(Boolean).join('；');
const isObj = (x) => !!x && typeof x === 'object' && !Array.isArray(x);

function init() {
  dir = app.getPath('userData');
  cfgPath = path.join(dir, 'ai.json');
  chatPath = path.join(dir, 'chat.json');
  // a file that can't be parsed is set aside (never overwritten) and the backup is used instead
  const rc = store.readJsonSync(cfgPath, null);
  const raw = isObj(rc.data) ? rc.data : {};
  cfg = { ...defaults, ...(isObj(raw.cfg) ? raw.cfg : {}) };
  if (OLD_PERSONAS.includes(cfg.persona)) cfg.persona = DEFAULT_PERSONA;
  keyBlob = raw.key || null;
  keyPlain = !!raw.keyPlain;
  loadWarn.cfg = store.loadWarning(rc, 'AI 设置文件', '现在用的是默认设置，API Key 要重新填一下');
  const rh = store.readJsonSync(chatPath, null);
  chat = { messages: [], notes: [], ...(isObj(rh.data) ? rh.data : {}) };
  if (!Array.isArray(chat.messages)) chat.messages = [];
  chat.notes = Array.isArray(chat.notes) ? chat.notes.filter((t) => typeof t === 'string') : [];
  if (!Array.isArray(chat.pendingNotes)) delete chat.pendingNotes;
  loadWarn.chat = store.loadWarning(rh, '聊天记录文件', '现在从空白开始');
  for (const w of [loadWarn.cfg, loadWarn.chat]) if (w) log(w);
}

function saveCfg() {
  try {
    if (keyChanged) {
      // the .bak gets the same content, so a deleted (or replaced) key can't come back from the backup
      store.writeJsonSync(cfgPath, { cfg, key: keyBlob, keyPlain }, { backup: false });
      try { fs.copyFileSync(cfgPath, cfgPath + '.bak'); } catch (_) {}
      keyChanged = false;
    } else store.writeJsonSync(cfgPath, { cfg, key: keyBlob, keyPlain });
    saveWarn.cfg = '';
  } catch (e) {
    if (!saveWarn.cfg) log('保存 ai.json 失败：' + e.message);
    saveWarn.cfg = 'AI 设置没能保存：' + (e.code || e.message);
  }
}
// messages are capped; notes are not (MAX_NOTES only stops new ones from being added)
function saveChat() {
  chat.messages = chat.messages.slice(-MAX_MSGS);
  try { store.writeJsonSync(chatPath, chat); saveWarn.chat = ''; } catch (e) {
    if (!saveWarn.chat) log('保存 chat.json 失败：' + e.message);
    saveWarn.chat = '聊天记录没能保存：' + (e.code || e.message);
  }
}

// ---- shared folder: the persona, the remembered things, the recent chat and the "when did we last meet" state can live
// in a folder the user picks instead of only here. Put it in a synced drive (Google Drive, OneDrive, iCloud...) and every
// computer that picks the same folder, plus the AstrBot plugin, is one and the same 大肥鱼. cfg.persona, chat.notes,
// chat.messages and chat.state stay as a local copy, used whenever the folder can't be read (not synced yet, offline).
const MAX_NOTES = 120;       // the notebook is full at this many: nothing new is added, nothing old is pushed out
const HARD_NOTES = 1000;     // only a safety cap for the file itself
const MAX_MSGS = 200;
const PERSONA_FILE = '人设.md';
const MEMORY_FILE = '记忆.json';
const CHAT_FILE = '聊天记录.json';
const STATE_FILE = '陪伴状态.json';
const DEVICE = '桌宠 ' + ({ darwin: 'Mac', win32: 'Windows' }[process.platform] || 'Linux');
const place = (from) => (from === DEVICE ? '这台电脑上' : from === 'AstrBot' ? '聊天软件里' : `「${from}」上`);
const newMsg = (role, content, extra = {}) => ({ id: `${DEVICE}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`, role, content, t: Date.now(), from: DEVICE, ...extra });
const useFolder = () => cfg.memoryWhere === 'folder' && !!cfg.sharedDir;
let folderState = { ok: true, error: '', count: 0 };
let folderReadAt = 0;
let shownNotes = [];         // the notes the settings page was given, so a save only removes what the user deleted there
let inflight = null;         // the user message being answered right now: it goes to the folder only once it has its answer

const stamp = () => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};
const note = (text) => ({ text, from: DEVICE, time: stamp() });
const norm = (s) => String(s).replace(/\r\n?/g, '\n').trim();
const broken = (file, msg) => Object.assign(new Error(msg), { code: 'EBROKEN', path: file });
const pendingNotes = () => (Array.isArray(chat.pendingNotes) ? chat.pendingNotes : []);
// "记忆.json 格式不对（第 3 行第 2 列附近；可能还在同步…）"; store.readJson's message only says where, never what
function brokenText(e, hint = '') {
  const name = path.basename(e.path || '') || '文件';
  const m = String(e.message || '');
  if (/^JSON 格式不对/.test(m)) {
    const where = m.replace(/^JSON 格式不对/, '').replace(/^（|）$/g, '');
    return `${name} 格式不对${where || hint ? `（${[where, hint].filter(Boolean).join('；')}）` : ''}`;
  }
  return `${name} 格式不对${hint ? `（${hint}）` : ''}：${m}`;
}
const folderError = (e) => (e.code === 'ENOENT' || e.code === 'NOT_SYNCED' ? '文件夹里找不到 人设.md 或 记忆.json（云盘可能还没同步好）'
  : e.code === 'EBROKEN' ? brokenText(e, '可能还在同步，过一会儿再试') : e.message);

// a file we can't make sense of is reported as broken, never treated as empty (it would be overwritten)
async function readMemories(dir) {
  const file = path.join(dir, MEMORY_FILE);
  const raw = await store.readJson(file);
  if (!isObj(raw) || (raw.memories != null && !Array.isArray(raw.memories))) throw broken(file, '里面不是记忆列表');
  return (raw.memories || []).map((m) => (typeof m === 'string' ? { text: m } : m)).filter((m) => m && typeof m.text === 'string' && m.text.trim());
}
async function writeMemories(dir, list) {
  const body = {
    说明: '大肥鱼的共享记忆。桌宠和 AstrBot 插件都会读写这个文件；可以直接改，一条记忆一项，text 是内容，from 是在哪边记下的。',
    memories: list.slice(-HARD_NOTES),
  };
  await store.writeJson(path.join(dir, MEMORY_FILE), body);
}

// re-read the folder (at most every 20 s unless forced); keeps the local copy when it fails
async function refresh(force = false) {
  if (!useFolder()) return;
  if (!force && Date.now() - folderReadAt < 20000) return;
  folderReadAt = Date.now();
  try {
    const pf = path.join(cfg.sharedDir, PERSONA_FILE);
    let persona = (await fs.promises.readFile(pf, 'utf8')).trim();
    const list = await readMemories(cfg.sharedDir);
    // a folder set up by an older version may still hold an old built-in persona: move it to the current one
    if (persona && OLD_PERSONAS.some((p) => norm(p) === norm(persona))) {
      persona = DEFAULT_PERSONA;
      try { await store.writeText(pf, DEFAULT_PERSONA + '\n'); } catch (e) { log('人设.md 没能换成新的默认人设：' + e.message); }
    }
    if (persona) cfg.persona = persona;
    chat.notes = list.map((m) => m.text.trim());
    folderState = { ok: true, error: '', count: list.length };
    if (pendingNotes().length) await flushPending();
    await syncChat();
  } catch (e) {
    folderState = { ok: false, error: folderError(e), count: 0 };
  }
}

// notes learned while the folder couldn't be written go in now; any that no longer fit wait for room
async function flushPending() {
  const pend = pendingNotes();
  let left = [];
  try {
    await editMemories((cur) => {
      const have = cur.map((m) => m.text.trim());
      const add = pend.filter((t, i) => !have.includes(t) && pend.indexOf(t) === i);
      const room = Math.max(0, MAX_NOTES - cur.length);
      left = add.slice(room);
      return room && add.length ? [...cur, ...add.slice(0, room).map(note)] : cur;
    });
    if (left.length) log(`记忆本满了，还有 ${left.length} 条这台电脑上记下的记忆在等空位`);
    chat.pendingNotes = left;
    if (!left.length) delete chat.pendingNotes;
    saveChat();
  } catch (e) {
    for (const t of pend) if (!chat.notes.includes(t)) chat.notes.push(t);
    log('先记在这台电脑上的记忆还是没能写进共享文件夹：' + e.message);
  }
}

// one read-merge-write of a shared file at a time (per file), so two of them in this process can't lose each other's update
const locks = new Map();
function serial(name, fn) {
  const run = (locks.get(name) || Promise.resolve()).then(fn);
  locks.set(name, run.catch(() => {}));
  return run;
}

// chat history: union of the folder's and this computer's messages by id, in time order. Clearing writes clearedAt so
// a copy elsewhere can't bring the old messages back.
const msgKey = (m) => m.id || `${m.t}|${m.role}|${m.content}`;
const syncChat = () => serial(CHAT_FILE, syncChatNow);
async function syncChatNow() {
  const file = path.join(cfg.sharedDir, CHAT_FILE);
  let shared = { clearedAt: 0, messages: [] };
  try {
    const raw = await store.readJson(file);
    if (!isObj(raw) || (raw.messages != null && !Array.isArray(raw.messages))) throw broken(file, '里面不是聊天记录');
    shared = { ...shared, ...raw };
  } catch (e) {
    if (e.code === 'ENOENT') {
      // no chat file yet: only start one in a folder that is really there (synced), i.e. that has 记忆.json
      if (!fs.existsSync(path.join(cfg.sharedDir, MEMORY_FILE))) return;
    } else if (e.code === 'EBROKEN') {
      // a sync client may be in the middle of writing it: only a file that has stayed broken for a while is replaced
      const st = await fs.promises.stat(file);
      if (Date.now() - st.mtimeMs < 2 * 60000) throw e;
      const to = `${file}.损坏-${store.fileStamp()}`;
      await fs.promises.rename(file, to);
      log(`聊天记录.json 坏了，已另存为 ${path.basename(to)}，用这台电脑上的副本重写`);
    } else throw e;
  }
  const clearedAt = Math.max(shared.clearedAt || 0, chat.clearedAt || 0);
  const byKey = new Map();
  for (const m of [...(shared.messages || []), ...chat.messages]) if (m && m !== inflight && m.t > clearedAt && !byKey.has(msgKey(m))) byKey.set(msgKey(m), m);
  const merged = [...byKey.values()].sort((a, b) => a.t - b.t).slice(-MAX_MSGS);
  const local = inflight && chat.messages.includes(inflight) ? [...merged, inflight] : merged;
  const same = (list, ref) => list.length === ref.length && list.every((m, i) => msgKey(m) === msgKey(ref[i]));
  if (!same(shared.messages || [], merged) || clearedAt !== (shared.clearedAt || 0)) {
    await store.writeJson(file, { clearedAt, messages: merged });
  }
  if (!same(chat.messages, local) || clearedAt !== (chat.clearedAt || 0)) { chat.messages = local; chat.clearedAt = clearedAt; saveChat(); }
}
async function pushChat() {
  if (!useFolder()) return;
  try { await syncChat(); } catch (_) { /* stays local; goes up with the next sync */ }
}

// ---- meeting: which day we first met, how many days in a row, when (and where) we saw each other today and last.
// Every computer and the AstrBot plugin update the same state, so opening the other computer later the same day is
// not "the first time today".
const p2 = (n) => String(n).padStart(2, '0');
const dayOf = (t) => { const d = new Date(t); return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`; };
const dayGap = (a, b) => Math.round((new Date(b + 'T00:00') - new Date(a + 'T00:00')) / 86400000);
const seen = () => serial(STATE_FILE, seenNow);
async function seenNow() {
  const file = useFolder() && path.join(cfg.sharedDir, STATE_FILE);
  let st = { ...(chat.state || {}) }, shared = false;
  if (file) {
    try {
      const raw = await store.readJson(file);
      if (!isObj(raw)) throw broken(file, '里面不是陪伴状态');
      st = raw; shared = true;
    } catch (e) {
      // like the chat file: a missing one is made again in a folder that is really there (has 记忆.json), a broken one
      // is replaced from this computer's copy once it has stayed broken for a while (a sync may be writing it right now)
      try {
        if (e.code === 'ENOENT') shared = fs.existsSync(path.join(cfg.sharedDir, MEMORY_FILE));
        else if (e.code === 'EBROKEN') {
          const stt = await fs.promises.stat(file);
          if (Date.now() - stt.mtimeMs >= 2 * 60000) {
            const to = `${file}.损坏-${store.fileStamp()}`;
            await fs.promises.rename(file, to);
            log(`陪伴状态.json 坏了，已另存为 ${path.basename(to)}，用这台电脑上的记录重写`);
            shared = true;
          }
        } else if (!saveWarn.state) log('陪伴状态.json 读不出来：' + e.message);
      } catch (e2) { log('陪伴状态.json 没能修好：' + e2.message); }
    }
  }
  const now = Date.now(), today = dayOf(now);
  const prev = st.lastSeen || null;
  let info;
  if (st.lastDay !== today) {
    const gap = st.lastDay ? dayGap(st.lastDay, today) : null;
    st.streak = gap === 1 ? (st.streak || 0) + 1 : 1;
    st.daysMet = (st.daysMet || 0) + 1;
    st.firstMet = st.firstMet || today;
    st.lastDay = today;
    st.todayFirst = { t: now, from: DEVICE };
    info = { firstToday: true, daysAway: gap, prev };
  } else info = { firstToday: false, todayFirst: st.todayFirst, prev };
  // whoever upgraded from 1.5.2 got firstMet = the upgrade day: the oldest message we still have knows better
  const oldest = chat.messages.reduce((a, m) => (m && Number.isFinite(m.t) && m.t > 0 && m.t < a ? m.t : a), Infinity);
  if (Number.isFinite(oldest) && (!st.firstMet || st.firstMet > dayOf(oldest))) st.firstMet = dayOf(oldest);
  st.lastSeen = { t: now, from: DEVICE };
  chat.state = st;
  saveChat();
  if (shared) {
    try { await store.writeJson(file, st); saveWarn.state = ''; } catch (e) {
      if (!saveWarn.state) log('陪伴状态.json 没能写进共享文件夹：' + e.message);
      saveWarn.state = '陪伴状态.json 写不进共享文件夹：' + (e.code || e.message);
    }
  }
  return info;
}

const hm = (t) => { const d = new Date(t); return `${p2(d.getHours())}:${p2(d.getMinutes())}`; };
const ago = (t) => { const m = Math.round((Date.now() - t) / 60000); return m < 2 ? '刚刚' : m < 60 ? `${m} 分钟前` : m < 1440 ? `${Math.round(m / 60)} 小时前` : `${Math.round(m / 1440)} 天前`; };
const FOLLOW_UP = '看看最近的聊天里他说过要去做什么（比如去吃饭、去开会、出门），还没下文的话自然地接着问一句（比如"吃完啦？"），没有就随口说一句。';
function meetHint(m) {
  if (!m) return '';
  if (m.firstToday) {
    if (m.daysAway == null && !chat.messages.length && !chat.notes.length) return '这是你们第一次见面，跟他打个招呼、简单介绍一下自己。';
    if (m.daysAway >= 3) return `你们已经 ${m.daysAway} 天没见了，今天第一次见面，跟他打个招呼，可以说说想他了。`;
    return '';
  }
  const first = m.todayFirst ? `${hm(m.todayFirst.t)} 在${place(m.todayFirst.from)}第一次见` : '早些时候见过';
  const last = m.prev ? `，最近一次是 ${ago(m.prev.t)} 在${place(m.prev.from)}` : '';
  const moved = m.prev && m.prev.from !== DEVICE ? '换到这台电脑上来找你' : '又把你叫出来';
  return `今天你们已经见过了（${first}${last}）。用户刚${moved}，不要当成今天第一次见面，不要说早上好之类的初次问候。${FOLLOW_UP}`;
}

// change the folder's memory list: read it fresh, apply fn, write it back (only if fn changed it). A missing 记忆.json
// means the folder isn't synced yet, so unless create is set nothing is written: a file holding only the new entries
// would otherwise replace the real one once the sync arrives. One edit at a time, so two can't overwrite each other.
let memLock = Promise.resolve();
function editMemories(fn, { create = false, dir = cfg.sharedDir } = {}) {
  const run = memLock.then(async () => {
    let list = [], missing = false;
    try { list = await readMemories(dir); } catch (e) {
      if (e.code !== 'ENOENT') throw e;
      if (!create) throw Object.assign(new Error('共享文件夹里找不到 记忆.json（云盘可能还没同步好）'), { code: 'NOT_SYNCED' });
      missing = true;
    }
    const next = fn(list);
    if (next !== list || missing) await writeMemories(dir, next);
    chat.notes = next.map((m) => m.text.trim());
    folderState = { ok: true, error: '', count: next.length };
  });
  memLock = run.catch(() => {});
  return run;
}

// -> { accepted: texts that are remembered now (new or already known), full: some didn't fit in the notebook }
async function addNotes(texts) {
  const out = { accepted: [], full: false };
  const fresh = [...new Set(texts)];
  if (fresh.every((t) => chat.notes.includes(t))) { out.accepted = fresh; return out; }
  // only what still fits is taken: a full notebook refuses new entries instead of dropping old ones
  const fit = (have) => {
    const add = fresh.filter((t) => !have.includes(t));
    const take = add.slice(0, Math.max(0, MAX_NOTES - have.length));
    out.full = take.length < add.length;
    out.accepted = fresh.filter((t) => !add.includes(t) || take.includes(t));
    return take;
  };
  if (!useFolder()) { chat.notes.push(...fit(chat.notes)); return out; }
  try {
    await editMemories((list) => { const take = fit(list.map((m) => m.text.trim())); return take.length ? [...list, ...take.map(note)] : list; });
  } catch (e) {
    // the folder can't be written right now: keep them here and add them to the folder later (refresh)
    const take = fit(chat.notes);
    chat.notes.push(...take);
    chat.pendingNotes = [...pendingNotes(), ...take.filter((t) => !pendingNotes().includes(t))];
    log('记忆先记在这台电脑上，共享文件夹暂时写不进去：' + e.message);
  }
  return out;
}

// moving to a folder: an existing persona and meeting state there win, this computer's memories are merged in
async function joinFolder(dir) {
  try {
    if (!(await fs.promises.stat(dir)).isDirectory()) throw new Error('不是文件夹');
    const pf = path.join(dir, PERSONA_FILE);
    if (!fs.existsSync(pf)) await store.writeText(pf, cfg.persona + '\n');
    const sf = path.join(dir, STATE_FILE);
    if (!fs.existsSync(sf)) await store.writeJson(sf, chat.state || {});
    const mine = [...new Set([...chat.notes, ...pendingNotes()])];
    let left = [];
    await editMemories((list) => {
      const add = mine.filter((t) => !list.some((m) => m.text.trim() === t));
      // only up to MAX_NOTES: an older version (another computer, the plugin) would cut a longer list from the front
      const room = Math.max(0, MAX_NOTES - list.length);
      left = add.slice(room);
      return room && add.length ? [...list, ...add.slice(0, room).map(note)] : list;
    }, { create: true, dir });
    // the rest wait for room in the folder, like notes learned while it couldn't be written
    if (left.length) { chat.pendingNotes = left; log(`共享文件夹的记忆本满了，这台电脑上还有 ${left.length} 条记忆在等空位`); }
    else delete chat.pendingNotes;
    // a clear done while this computer was on its own must not wipe the folder's history on every computer
    chat.clearedAt = 0;
    return '';
  } catch (e) {
    return '用不了这个文件夹：' + (e.code === 'ENOENT' ? '文件夹不存在' : e.code === 'EACCES' || e.code === 'EPERM' ? '没有写入权限'
      : e.code === 'EBROKEN' ? brokenText(e) : e.message);
  }
}

function setKey(k) {
  k = (k || '').trim();
  keyChanged = true;
  if (!k) { keyBlob = null; keyPlain = false; return; }
  if (safeStorage.isEncryptionAvailable()) {
    keyBlob = safeStorage.encryptString(k).toString('base64'); keyPlain = false;
  } else {
    keyBlob = Buffer.from(k, 'utf8').toString('base64'); keyPlain = true;
  }
}
function getKey() {
  if (!keyBlob) return '';
  try {
    const buf = Buffer.from(keyBlob, 'base64');
    return keyPlain ? buf.toString('utf8') : safeStorage.decryptString(buf);
  } catch (_) { return ''; }
}
const mask = (k) => (k ? k.slice(0, 5) + '…' + k.slice(-4) : '');

async function publicSettings() {
  await refresh(true);
  const k = getKey();
  shownNotes = chat.notes.slice();
  return {
    ...cfg, hasKey: !!k, keyMasked: mask(k), notes: shownNotes.slice(), defaultPersona: DEFAULT_PERSONA, encrypted: !keyPlain, stickerCredit: stickers.attribution(),
    folder: useFolder() ? folderState : null,
    noteCount: chat.notes.length, maxNotes: MAX_NOTES, memoryFull: chat.notes.length >= MAX_NOTES, dataWarning: dataWarning(),
  };
}

// the key goes to this address, so plain http is only for a service on this computer or the local network:
// loopback, private and link-local ranges, Tailscale/CGNAT (100.64/10), IPv6 ULA (fc00::/7) and link-local (fe80::/10),
// names without a dot (http://nas:8080) and the usual home-network suffixes
const LAN4 = /^(?:127\.\d{1,3}|10\.\d{1,3}|192\.168|172\.(?:1[6-9]|2\d|3[01])|169\.254|100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7]))\.\d{1,3}\.\d{1,3}$/;
const LAN6 = /^(?:::1|f[cd][0-9a-f]{0,2}:[0-9a-f:.]*|fe[89ab][0-9a-f]?:[0-9a-f:.]*)$/;
const LAN_NAME = /(?:^|\.)(?:local|lan|home|internal|home\.arpa|localdomain)$/;
function baseUrlOk(s) {
  let u;
  try { u = new URL(s); } catch (_) { return false; }
  if (u.protocol === 'https:') return true;
  if (u.protocol !== 'http:') return false;
  const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase().replace(/\.$/, '');
  if (host === 'localhost' || host === 'host.docker.internal' || LAN4.test(host) || LAN6.test(host) || LAN_NAME.test(host)) return true;
  return !!host && !host.includes('.') && !host.includes(':');   // a single-label name only resolves on the local network
}
const BASE_URL_ERROR = '接口地址要用 https:// 开头（本机或局域网里的服务可以用 http://）';

async function updateSettings(s) {
  let baseUrlError = '', notesSkipped = [];
  if (typeof s.baseUrl === 'string') {
    const u = s.baseUrl.trim().replace(/\/+$/, '');
    if (!u) cfg.baseUrl = defaults.baseUrl;
    // the address already saved is kept as it is, so a setup that worked before never starts nagging
    else if (u === cfg.baseUrl || baseUrlOk(u)) cfg.baseUrl = u;
    else baseUrlError = BASE_URL_ERROR;
  }
  if (typeof s.model === 'string') cfg.model = s.model.trim() || defaults.model;
  // switching where memories live: the persona and notes on the page belong to the old place, so they are not applied
  const where = ['local', 'folder'].includes(s.memoryWhere) ? s.memoryWhere : cfg.memoryWhere;
  const dir = typeof s.sharedDir === 'string' ? s.sharedDir.trim() : cfg.sharedDir;
  const moving = (where === 'folder' && !!dir) !== useFolder() || (where === 'folder' && dir && dir !== cfg.sharedDir);
  let error = '';
  if (moving && where === 'folder') error = await joinFolder(dir);
  if (!error) { cfg.memoryWhere = where; cfg.sharedDir = dir; }
  if (!moving) {
    const before = cfg.persona;
    // personaBase / notesBase: what the page showed when it opened. A persona left as it was is not applied (it may
    // have been changed on another computer since), and of the notes only what the user changed on the page is applied.
    const untouched = typeof s.personaBase === 'string' && typeof s.persona === 'string' && norm(s.persona) === norm(s.personaBase);
    if (typeof s.persona === 'string' && !untouched) cfg.persona = s.persona.trim() || DEFAULT_PERSONA;
    const clean = (a) => a.map((n) => String(n).trim()).filter(Boolean);
    if (Array.isArray(s.notes)) {
      const r = await setNotes(clean(s.notes), Array.isArray(s.notesBase) ? clean(s.notesBase) : null);
      error = r.error || error;
      notesSkipped = r.skipped;
    }
    if (useFolder() && cfg.persona !== before) {
      try { await store.writeText(path.join(cfg.sharedDir, PERSONA_FILE), cfg.persona + '\n'); } catch (e) { error = '人格没能写进共享文件夹：' + e.message; }
    }
  }
  if (typeof s.memoryOn === 'boolean') cfg.memoryOn = s.memoryOn;
  if (Number.isFinite(s.historyTurns)) cfg.historyTurns = Math.max(2, Math.min(40, Math.round(s.historyTurns)));
  if (['off', 'moments', 'hourly', 'often'].includes(s.proactive)) cfg.proactive = s.proactive;
  if (['off', 'sometimes', 'often'].includes(s.stickers)) cfg.stickers = s.stickers;
  if (typeof s.stickerDuo === 'boolean') cfg.stickerDuo = s.stickerDuo;
  if (typeof s.memes === 'boolean') cfg.memes = s.memes;
  if (['off', 'canned', 'mix', 'ai'].includes(s.whisper)) cfg.whisper = s.whisper;
  if (['off', 'sometimes', 'often'].includes(s.look)) cfg.look = s.look;
  if (typeof s.visionModel === 'string') cfg.visionModel = s.visionModel.trim() || defaults.visionModel;
  if (typeof s.key === 'string' && s.key.trim()) setKey(s.key);
  if (s.clearKey) setKey('');
  saveCfg(); saveChat();
  return { ...(await publicSettings()), error, baseUrlError, notesSkipped };
}

// the settings page's list: only apply what changed on the page (against base, the list it opened with), so memories
// learned while it was open, here or on another computer, are kept. Additions stop at MAX_NOTES like the AI's (an older
// version would cut a longer list from the front); what didn't fit is returned in skipped.
// -> { error: '' when fine, skipped: [] }
async function setNotes(list, base) {
  const out = { error: '', skipped: [] };
  const ref = base || (useFolder() ? shownNotes : null);
  if (!ref) { chat.notes = list; return out; }   // an older page without notesBase, local: as before
  const removed = ref.filter((t) => !list.includes(t));
  const added = list.filter((t, i) => !ref.includes(t) && list.indexOf(t) === i);
  if (!removed.length && !added.length) return out;
  const fit = (have) => {
    const add = added.filter((t) => !have.includes(t));
    const take = add.slice(0, Math.max(0, MAX_NOTES - have.length));
    out.skipped = add.filter((t) => !take.includes(t));
    return take;
  };
  const applyLocal = () => {
    const kept = chat.notes.filter((t) => !removed.includes(t));
    const take = fit(kept);
    chat.notes = [...kept, ...take];
    if (chat.pendingNotes) chat.pendingNotes = chat.pendingNotes.filter((t) => !removed.includes(t));
    return take;
  };
  if (!useFolder()) { applyLocal(); return out; }
  try {
    await editMemories((cur) => {
      const kept = cur.filter((m) => !removed.includes(m.text.trim()));
      return [...kept, ...fit(kept.map((m) => m.text.trim())).map(note)];
    });
    if (chat.pendingNotes) chat.pendingNotes = chat.pendingNotes.filter((t) => !removed.includes(t));
    return out;
  } catch (e) {
    const take = applyLocal();
    chat.pendingNotes = [...pendingNotes(), ...take.filter((t) => !pendingNotes().includes(t))];
    out.error = `记忆没能写进共享文件夹（${folderError(e)}）。新加的先记在这台电脑上，等文件夹能用了再补进去`
      + (removed.length ? '；删掉的那几条要等文件夹能用了再删一次' : '');
    return out;
  }
}

// ---- DeepSeek Harness import: read the key/model dsh already has (~/.dsh)
function importFromDsh() {
  const YAML = require('yaml');
  const base = path.join(os.homedir(), '.dsh');
  const readY = (f) => { try { return YAML.parse(fs.readFileSync(path.join(base, f), 'utf8')) || {}; } catch (_) { return null; } };
  const settings = readY('settings.yaml');
  const creds = readY('.credentials.yaml');
  if (!settings && !creds) return { ok: false, error: '没找到 ~/.dsh 配置，确认 DeepSeek Harness 已经在这台电脑上设置过模型。' };

  const flat = {};
  const walk = (o, pre) => {
    if (!o || typeof o !== 'object') return;
    for (const [k, v] of Object.entries(o)) {
      if (v && typeof v === 'object') walk(v, pre ? pre + '.' + k : k);
      else flat[pre ? pre + '.' + k : k] = v;
    }
  };
  walk(creds || {}, '');

  const llm = (settings && (settings['llm-pi-ai'] || settings.llm)) || {};
  const providers = llm.providers || {};
  const dm = (settings && settings['agent-default-model']) || {};
  const provName = dm.provider || Object.keys(providers).find((p) => /deepseek/i.test(p)) || Object.keys(providers)[0];
  const prov = providers[provName] || {};

  let key = '';
  const envName = prov.apiKeyEnv;
  if (envName) {
    key = process.env[envName] || flat[envName] || Object.entries(flat).find(([k]) => k.endsWith('.' + envName) || k === envName)?.[1] || '';
  }
  if (!key) {
    const cand = Object.entries(flat).find(([k, v]) => typeof v === 'string' && /deepseek/i.test(k) && v.length > 16);
    if (cand) key = cand[1];
  }
  if (!key) {
    const cand = Object.values(flat).find((v) => typeof v === 'string' && /^sk-[A-Za-z0-9]{16,}/.test(v));
    if (cand) key = cand;
  }
  if (!key) return { ok: false, error: '在 DeepSeek Harness 的配置里没有找到可用的 API Key。可以直接把 key 粘贴到上面的输入框。' };

  setKey(key);
  const baseUrl = String(prov.baseUrl || prov.baseURL || prov.apiBase || '').trim().replace(/\/+$/, '');
  let baseUrlError = '';
  // the same rule as the settings page: the imported key must not go to a plain-http address on the internet
  if (baseUrl && (baseUrl === cfg.baseUrl || baseUrlOk(baseUrl))) cfg.baseUrl = baseUrl;
  else if (baseUrl) baseUrlError = BASE_URL_ERROR;
  else if (!provName || /deepseek/i.test(provName)) cfg.baseUrl = defaults.baseUrl;
  if (dm.model) cfg.model = String(dm.model);
  saveCfg();
  return { ok: true, provider: provName || '', model: cfg.model, baseUrl: cfg.baseUrl, keyMasked: mask(key), baseUrlError };
}

// ---- chat
function nowLine() {
  const d = new Date();
  const wk = '日一二三四五六'[d.getDay()];
  const p = (n) => String(n).padStart(2, '0');
  return `现在是 ${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}（星期${wk}）。`;
}

function systemPrompt() {
  const parts = [cfg.persona];
  if (OUTFIT_LINE[outfit]) parts.push(OUTFIT_LINE[outfit]);
  if (cfg.memoryOn) {
    if (chat.notes.length) parts.push('你记得的关于用户的事：\n' + chat.notes.map((n) => '- ' + n).join('\n'));
    parts.push(chat.notes.length >= MAX_NOTES
      ? `你的记忆本已经满了（${MAX_NOTES} 条），这次不要再写 <memory>。用户让你记东西时，告诉他记忆本满了，请他在「AI 设置」里删掉一些旧的。`
      : '当用户告诉你关于他自己、值得长期记住的信息（名字、喜好、习惯、重要安排等）时，在回复最后另起一行写 <memory>要记住的一句话</memory>，用户看不到这一行；已经记住的不要重复记，不要记临时的小事。');
  }
  parts.push([
    '你会主动找用户说话：打招呼、提醒休息、他回到电脑前时，还有到了他让你提醒的时间。所以不要说自己没法主动说话。',
    '定时提醒：只有用户明确要你在某个时间提醒他时，才在回复最后另起一行写 <remind at="YYYY-MM-DD HH:MM">要提醒的事</remind>。时间用 24 小时制的本地时间，根据消息开头给的当前时间换算（比如"半小时后""明天早上 9 点"）；用户说的钟点如果今天已经过了，就当成明天。回复里用自然的话跟他确认一下就行，用户看不到这一行。',
    '用户要取消提醒时写 <remind-cancel>提醒内容里的关键词</remind-cancel>，全部取消写 <remind-cancel>全部</remind-cancel>。',
    '用户要改提醒的时间时，先写 <remind-cancel>旧提醒里的关键词</remind-cancel>，再写新的 <remind at="...">。',
  ].join('\n'));
  if (cfg.stickers !== 'off') parts.push(stickers.promptHint(cfg.stickers, cfg.memes));
  // connected to AstrBot but it can't be reached right now: what she last knew, from the snapshot (link/index.js)
  const lm = linkMemory ? linkMemory() : '';
  if (lm) parts.push(lm);
  return parts.join('\n\n');
}
let linkMemory = null;
function setLinkMemory(fn) { linkMemory = typeof fn === 'function' ? fn : null; }

// a turn that happened elsewhere (her reply through AstrBot, a fixed line): kept in the chat history like any other
async function record(role, content, extra = {}) {
  if (!content) return;
  chat.messages.push(newMsg(role === 'user' ? 'user' : 'assistant', String(content), extra));
  saveChat();
  await pushChat();
}

let controller = null;
const IDLE_MS = 45000;       // no data at all for this long: give up
const CAP_MS = 180000;       // and a whole reply never takes longer than this
const errText = (e) => (e && e.cause && (e.cause.message || e.cause.code)) || (e && e.message) || String(e);

async function send(text, onDelta, opts = {}) {
  const key = getKey();
  if (!key) throw Object.assign(new Error('还没有设置 API Key'), { code: 'nokey' });
  await refresh();
  if (controller) controller.abort();
  controller = new AbortController();
  const ctl = controller;

  const userMsg = newMsg('user', opts.image ? `${text}\n（附了一张屏幕截图）` : text);
  chat.messages.push(userMsg);
  inflight = userMsg;
  // taken back by identity: a sync while waiting may have rebuilt the list, so pop() could hit another message
  const takeBack = () => { const i = chat.messages.indexOf(userMsg); if (i >= 0) chat.messages.splice(i, 1); };
  const hist = buildHistory();
  const rl = reminders.contextLine();
  const head = `[${nowLine()}${rl ? ' ' + rl : ''}]\n${text}`;
  hist[hist.length - 1] = {
    role: 'user',
    content: opts.image
      ? [{ type: 'text', text: head + '\n（附图是我电脑屏幕现在的截图）' }, { type: 'image_url', image_url: { url: opts.image } }]
      : head,
  };
  const body = { model: opts.image ? cfg.visionModel : cfg.model, stream: true, messages: [{ role: 'system', content: systemPrompt() }, ...hist] };

  // an idle timeout (reset by every chunk, so a long reply that keeps coming is fine) plus an overall cap
  let timedOut = false, idle = null;
  const kill = () => { timedOut = true; ctl.abort(); };
  const poke = () => { clearTimeout(idle); idle = setTimeout(kill, IDLE_MS); };
  const cap = setTimeout(kill, CAP_MS);
  const netError = (e, prefix) => Object.assign(new Error(timedOut ? '等太久没回应，网络可能不太好'
    : ctl.signal.aborted || (e && e.name === 'AbortError') ? '已经停下了' : prefix + errText(e)), { code: 'network' });

  let full = '', truncated = false;
  try {
    poke();
    let res;
    try {
      res = await fetch(cfg.baseUrl + '/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
        body: JSON.stringify(body),
        signal: ctl.signal,
      });
    } catch (e) { throw netError(e, '连不上接口：'); }
    if (!res.ok) {
      let detail = '';
      try { detail = (await res.text()).slice(0, 300); } catch (_) {}
      const map = { 401: 'API Key 不对或已失效', 402: '账户余额不足', 404: '接口地址或模型名不对', 429: '请求太频繁了，稍后再试' };
      throw Object.assign(new Error((map[res.status] || '接口返回错误 ' + res.status) + (detail ? `（${detail}）` : '')), { code: 'http', status: res.status });
    }

    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    const take = (line) => {
      line = line.trim();
      if (!line.startsWith('data:')) return;
      const data = line.slice(5).trim();
      if (data === '[DONE]') return;
      try {
        const j = JSON.parse(data);
        const piece = j.choices && j.choices[0] && j.choices[0].delta && j.choices[0].delta.content;
        if (piece) { full += piece; onDelta(stickers.hidePartial(visible(full)).trim()); }
      } catch (_) { /* keep-alive or partial */ }
    };
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        poke();
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf('\n')) >= 0) { take(buf.slice(0, i)); buf = buf.slice(i + 1); }
      }
      take(buf + dec.decode());
    } catch (e) {
      // cut off half way (network, timeout or the stop button): keep what arrived; nothing worth showing yet is an error
      if (!visible(full, { final: true }).trim()) throw netError(e, '连接断了：');
      truncated = true;
    }
  } catch (e) {
    takeBack();
    throw e;
  } finally {
    clearTimeout(idle); clearTimeout(cap);
    if (controller === ctl) controller = null;
    if (inflight === userMsg) inflight = null;
  }

  // tags are capped per reply and a cancel only counts when the user asked for one (ai-parse.js)
  const ctrl = parseControl(full, text);
  const parsed = stickers.parseReply(visible(full, { final: true }), packs());
  const reply = parsed.text || (parsed.stickers.length ? '' : '……');
  const st = cfg.stickers === 'off' ? [] : parsed.stickers;
  let remembered = [], memoryFull = false;
  if (cfg.memoryOn && ctrl.memories.length) ({ accepted: remembered, full: memoryFull } = await addNotes(ctrl.memories));
  chat.messages.push(newMsg('assistant', reply || '（发了一个表情）', st.length ? { stickers: st } : {}));
  saveChat();
  await pushChat();
  return { reply, remembered, stickers: st, remindAdd: ctrl.remindAdd, remindCancel: ctrl.remindCancel, memoryFull, dropped: ctrl.dropped, truncated };
}

// recent turns, oldest first, with same-role neighbours merged (keeps the API happy). What the user said on another
// computer or in the chat app is marked with the time and place, so she knows it was earlier and elsewhere.
function buildHistory() {
  const out = [];
  for (const m of chat.messages.slice(-(cfg.historyTurns * 2 + 1))) {
    const when = dayOf(m.t) === dayOf(Date.now()) ? hm(m.t) : `${dayOf(m.t).slice(5)} ${hm(m.t)}`;
    const content = m.role === 'user' && m.from && m.from !== DEVICE ? `[${when}，在${place(m.from)}] ${m.content}` : m.content;
    const last = out[out.length - 1];
    if (last && last.role === m.role) last.content += '\n' + content;
    else out.push({ role: m.role, content });
  }
  while (out.length && out[0].role !== 'user') out.shift();
  return out;
}

// ---- proactive: she starts the conversation herself
const HINTS = {
  startup: (c) => meetHint(c.meet) || '用户刚打开电脑、把你叫出来，这是你们今天第一次见面，跟他打个招呼。如果最近的聊天里他说过要去做的事，可以顺口问问后来怎么样了。',
  return: (c) => {
    // idle input only means nobody touched the keyboard or mouse: he may as well have been watching a video
    const away = `用户有大约 ${c.awayMin || 10} 分钟没碰键盘鼠标（可能走开了，也可能在看视频或者想事情），刚刚又开始操作了。不要断定他离开了，可以随口问一句刚才在忙什么。`;
    if (c.meet && c.meet.firstToday) return away + '这是你们今天第一次见面。' + (meetHint(c.meet) || '跟他打个招呼。');
    const p = c.meet && c.meet.prev;
    const elsewhere = p && p.from !== DEVICE && Date.now() - p.t < (c.awayMin || 10) * 60000;
    return away + (elsewhere ? `这段时间他在${place(p.from)}找过你（${ago(p.t)}）。${FOLLOW_UP}` : '');
  },
  rest: (c) => `用户已经连续用电脑大约 ${c.activeMin || 50} 分钟没休息了，提醒他起来活动一下、喝口水或者看看远处。`,
  night: () => '已经是深夜了，用户还在用电脑。关心一下他，劝他早点睡。',
  look: () => '附图是用户电脑屏幕现在的截图，你悄悄看了一眼他在浏览什么。是视频就聊聊画面和内容，是文章或网页就点评一下内容或观点，看不清就随口问一句他在看什么。不要复述屏幕上的隐私信息（聊天记录、账号、金额、个人信息等）。',
  lookAsk: () => '用户让你看看他屏幕上的东西，附图是现在的截图。像朋友一样点评一下：是视频就说说画面和内容，是文章就说说观点和你的看法。不要复述屏幕上的隐私信息（聊天记录、账号、金额、个人信息等）。',
  reminder: (c) => `用户之前让你在这个时间提醒他：「${c.text}」。${c.lateMin > 2 ? `（刚才电脑没开着，已经晚了大约 ${c.lateMin} 分钟，顺便说一声）` : ''}现在主动提醒他，把要做的事说清楚。`,
  chat: () => '你有点无聊，想主动找用户说两句。可以随口分享心情、问问他在忙什么，或者根据你记得的事关心他。',
};
async function proactive(kind, ctx = {}) {
  const key = getKey();
  if (!key) throw new Error('nokey');
  await refresh();
  const hint = (HINTS[kind] || HINTS.chat)(ctx);
  const hist = buildHistory();
  const limit = kind === 'reminder' ? 60 : kind === 'lookAsk' ? 90 : kind === 'look' ? 60 : 40;
  const cue = `[${nowLine()}]（这一条不是用户说的话，是给你的情境提示）${hint}\n请你主动对用户说一句话：口语化，不超过 ${limit} 个字，不要重复之前说过的话，不要写 <memory>。只输出这句话本身（想发表情包的话照常在最后写 [sticker:词]）。`;
  if (hist.length && hist[hist.length - 1].role === 'user') hist.push({ role: 'assistant', content: '（安静地待在桌面上）' });
  let text = '', st = [], why = '';
  // an empty answer gets one more try with more room (a model that thinks first can use up the 220 tokens)
  for (const maxTokens of [220, 600]) {
    const r = await fetch(cfg.baseUrl + '/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
      body: JSON.stringify({
        model: ctx.image ? cfg.visionModel : cfg.model, stream: false, max_tokens: maxTokens,
        messages: [{ role: 'system', content: systemPrompt() }, ...hist,
          { role: 'user', content: ctx.image ? [{ type: 'text', text: cue }, { type: 'image_url', image_url: { url: ctx.image } }] : cue }],
      }),
      signal: AbortSignal.timeout(45000),
    });
    if (!r.ok) {
      let detail = '';
      try { detail = (await r.text()).slice(0, 200); } catch (_) {}
      throw new Error(`接口返回 ${r.status}${detail ? '：' + detail : ''}`);
    }
    const j = await r.json();
    const choice = (j.choices && j.choices[0]) || {};
    const raw = (choice.message && choice.message.content) || '';
    const parsed = stickers.parseReply(visible(raw, { final: true }), packs());
    text = parsed.text.replace(/^["“「『]+|["”」』]+$/g, '').trim();
    st = cfg.stickers === 'off' ? [] : parsed.stickers;
    if (text || st.length) break;
    why = `finish_reason=${choice.finish_reason || '?'}, ${raw.length} chars before cleanup`;   // goes to error.log
  }
  if (!text && !st.length) throw new Error(`empty (${why})`);
  chat.messages.push(newMsg('assistant', text || '（发了一个表情）', { proactive: kind, ...(st.length ? { stickers: st } : {}) }));
  saveChat();
  await pushChat();
  return { text, stickers: st };
}

// ---- whisper: one short line she mutters to herself, made up by the model (not kept in chat history)
let lastWhisperAt = 0;
const recentWhispers = [];
const WHISPER_GAP = { mix: 15 * 60000, ai: 4 * 60000 };
async function whisper(ctx = {}) {
  const gap = WHISPER_GAP[cfg.whisper];
  if (!gap) return { ok: false, reason: 'off' };
  const key = getKey();
  if (!key) return { ok: false, reason: 'nokey' };
  if (Date.now() - lastWhisperAt < gap) return { ok: false, reason: 'rate' };
  if (controller) return { ok: false, reason: 'busy' };
  lastWhisperAt = Date.now();
  await refresh();
  const doing = ctx.action ? `你正在做的动作：「${ctx.action}」。` : '你正在桌面上待着。';
  const recent = recentWhispers.length ? `最近嘀咕过：${recentWhispers.map((x) => '「' + x + '」').join('')}，别重复。` : '';
  const cue = `[${nowLine()}]（这一条不是用户说的话，是给你的情境提示）${doing}自言自语嘀咕一句：口语化、俏皮，不超过 16 个字，和你正在做的事或者此刻的时间有关；不要问用户问题，不要打招呼，不要发表情包，不要写 <memory>。${recent}只输出这句话本身。`;
  const hist = buildHistory();
  if (hist.length && hist[hist.length - 1].role === 'user') hist.push({ role: 'assistant', content: '（安静地待在桌面上）' });
  try {
    const r = await fetch(cfg.baseUrl + '/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
      body: JSON.stringify({ model: cfg.model, stream: false, max_tokens: 80, messages: [{ role: 'system', content: systemPrompt() }, ...hist, { role: 'user', content: cue }] }),
      signal: AbortSignal.timeout(20000),
    });
    if (!r.ok) return { ok: false, reason: 'http', status: r.status };
    const j = await r.json();
    let text = (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || '';
    text = stickers.parseReply(visible(text, { final: true }), []).text.split('\n')[0].replace(/^["“「『]+|["”」』]+$/g, '').trim();
    text = Array.from(text).slice(0, 30).join('');
    if (!text) return { ok: false, reason: 'empty' };
    recentWhispers.push(text);
    if (recentWhispers.length > 8) recentWhispers.shift();
    return { ok: true, text };
  } catch (e) {
    return { ok: false, reason: 'error', error: String(e.message || e) };
  }
}

function abort() { if (controller) controller.abort(); }

async function test() {
  const key = getKey();
  if (!key) return { ok: false, error: '还没有填 API Key' };
  try {
    const r = await fetch(cfg.baseUrl + '/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
      body: JSON.stringify({ model: cfg.model, max_tokens: 8, messages: [{ role: 'user', content: '只回复“好”' }] }),
      signal: AbortSignal.timeout(30000),
    });
    if (!r.ok) {
      const t = (await r.text()).slice(0, 200);
      return { ok: false, error: `接口返回 ${r.status}：${t}` };
    }
    return { ok: true };
  } catch (e) { return { ok: false, error: '连不上：' + e.message }; }
}

async function listModels() {
  const key = getKey();
  if (!key) return [];
  try {
    const r = await fetch(cfg.baseUrl + '/models', { headers: { Authorization: 'Bearer ' + key }, signal: AbortSignal.timeout(15000) });
    if (!r.ok) return [];
    const j = await r.json();
    return (j.data || []).map((m) => m.id).filter(Boolean);
  } catch (_) { return []; }
}

// account balance (DeepSeek: GET /user/balance)
async function balance() {
  const key = getKey();
  if (!key) return { ok: false, error: '还没有设置 API Key' };
  try {
    const r = await fetch(cfg.baseUrl + '/user/balance', { headers: { Authorization: 'Bearer ' + key, Accept: 'application/json' }, signal: AbortSignal.timeout(15000) });
    if (r.status === 404) return { ok: false, error: '这个接口地址不支持查余额（只有 DeepSeek 官方接口能查）' };
    if (!r.ok) return { ok: false, error: `查询失败：HTTP ${r.status}` + (r.status === 401 ? '（API Key 不对或已失效）' : '') };
    const j = await r.json();
    const sym = { CNY: '¥', USD: '$' };
    const items = (j.balance_infos || []).map((b) => ({
      currency: b.currency,
      total: Number(b.total_balance), granted: Number(b.granted_balance), toppedUp: Number(b.topped_up_balance),
      text: `${sym[b.currency] || b.currency + ' '}${Number(b.total_balance).toFixed(2)}`
        + (Number(b.granted_balance) > 0 ? `（其中赠送 ${sym[b.currency] || ''}${Number(b.granted_balance).toFixed(2)}，充值 ${sym[b.currency] || ''}${Number(b.topped_up_balance).toFixed(2)}）` : ''),
    }));
    const summary = items.length ? '余额 ' + items.map((i) => i.text).join('，') : '没有查到余额信息';
    return { ok: true, available: !!j.is_available, items, summary: summary + (j.is_available ? '' : '。余额不够调用了，需要充值') };
  } catch (e) {
    return { ok: false, error: '连不上：' + (e.message || e) };
  }
}

function history() { return chat.messages.slice(-40).map(({ role, content, stickers: st }) => ({ role, content, stickers: st || [] })); }
async function clearHistory() { chat.messages = []; chat.clearedAt = Date.now(); saveChat(); await pushChat(); }

// text that may be shared (the diagnostics report, its error.log tail): the shared folder's path becomes 〈共享文件夹〉
// (raw, JSON-escaped and with forward slashes; any case on Windows) and the saved API key ***
const reEsc = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function redact(text) {
  let t = String(text == null ? '' : text);
  const d = String(cfg.sharedDir || '').replace(/[\\/]+$/, '');
  if (d.length > 1) {
    const forms = [...new Set([d.replace(/\\/g, '\\\\'), d, d.replace(/\\/g, '/')])];
    for (const f of forms) t = t.replace(new RegExp(reEsc(f), process.platform === 'win32' || process.platform === 'darwin' ? 'gi' : 'g'), '〈共享文件夹〉');
  }
  const k = getKey();
  if (k && k.length >= 8) t = t.split(k).join('***');
  return t;
}

// for the diagnostics report the user may send to someone: settings and counts only. No key, persona, memory or chat
// text, and no folder path (it usually holds the user name).
function diagnostics() {
  const scrub = (s) => {
    const t = redact(s);
    const home = os.homedir();
    return home ? t.split(home).join('~') : t;
  };
  let host = '';
  try { host = new URL(cfg.baseUrl).host; } catch (_) { host = '（地址格式不对）'; }
  return {
    baseUrl: host, model: cfg.model, visionModel: cfg.visionModel, proactive: cfg.proactive, look: cfg.look, whisper: cfg.whisper,
    stickers: cfg.stickers, memoryOn: cfg.memoryOn, historyTurns: cfg.historyTurns, memoryWhere: cfg.memoryWhere,
    hasKey: !!getKey(), encrypted: !keyPlain, noteCount: chat.notes.length, maxNotes: MAX_NOTES, memoryFull: chat.notes.length >= MAX_NOTES,
    pendingNotes: pendingNotes().length, messageCount: chat.messages.length,
    folder: useFolder() ? (folderState.ok ? 'ok' : scrub(folderState.error) || 'error') : 'off',
    dataWarning: scrub(dataWarning()), outfit,
  };
}

module.exports = {
  init, publicSettings, updateSettings, importFromDsh, send, abort, test, listModels, history, clearHistory, proactive, balance, setOutfit, seen,
  hasKey: () => !!getKey(), busy: () => !!controller, proactiveMode: () => cfg.proactive, lookMode: () => cfg.look,
  whisper, whisperMode: () => cfg.whisper, setLogger, diagnostics, redact, record, setLinkMemory,
};
