'use strict';
// AI brain for the pet: talks to an OpenAI-compatible endpoint (DeepSeek by default).
// The API key never leaves the main process; it is stored encrypted with the OS keychain (safeStorage).
const { app, safeStorage } = require('electron');
const fs = require('fs');
const path = require('path');
const os = require('os');
const stickers = require('./stickers');
const reminders = require('./reminders');

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
  look: 'sometimes',        // glance at the screen while a browser is in front: off | sometimes | often
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
let chat = { messages: [], notes: [] };

function init() {
  dir = app.getPath('userData');
  cfgPath = path.join(dir, 'ai.json');
  chatPath = path.join(dir, 'chat.json');
  try {
    const raw = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    cfg = { ...defaults, ...(raw.cfg || {}) };
    if (OLD_PERSONAS.includes(cfg.persona)) cfg.persona = DEFAULT_PERSONA;
    keyBlob = raw.key || null;
    keyPlain = !!raw.keyPlain;
  } catch (_) { /* first run */ }
  try { chat = { messages: [], notes: [], ...JSON.parse(fs.readFileSync(chatPath, 'utf8')) }; } catch (_) {}
}

function saveCfg() {
  fs.writeFileSync(cfgPath, JSON.stringify({ cfg, key: keyBlob, keyPlain }, null, 1));
}
function saveChat() {
  chat.messages = chat.messages.slice(-MAX_MSGS);
  chat.notes = chat.notes.slice(-MAX_NOTES);
  fs.writeFileSync(chatPath, JSON.stringify(chat, null, 1));
}

// ---- shared folder: the persona, the remembered things, the recent chat and the "when did we last meet" state can live
// in a folder the user picks instead of only here. Put it in a synced drive (Google Drive, OneDrive, iCloud...) and every
// computer that picks the same folder, plus the AstrBot plugin, is one and the same 大肥鱼. cfg.persona, chat.notes,
// chat.messages and chat.state stay as a local copy, used whenever the folder can't be read (not synced yet, offline).
const MAX_NOTES = 120;
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

const stamp = () => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

async function readMemories(dir) {
  const raw = JSON.parse(await fs.promises.readFile(path.join(dir, MEMORY_FILE), 'utf8'));
  return (Array.isArray(raw.memories) ? raw.memories : []).filter((m) => m && typeof m.text === 'string' && m.text.trim());
}
async function writeMemories(dir, list) {
  const body = {
    说明: '大肥鱼的共享记忆。桌宠和 AstrBot 插件都会读写这个文件；可以直接改，一条记忆一项，text 是内容，from 是在哪边记下的。',
    memories: list.slice(-MAX_NOTES),
  };
  await fs.promises.writeFile(path.join(dir, MEMORY_FILE), JSON.stringify(body, null, 1));
}

// re-read the folder (at most every 20 s unless forced); keeps the local copy when it fails
async function refresh(force = false) {
  if (!useFolder()) return;
  if (!force && Date.now() - folderReadAt < 20000) return;
  folderReadAt = Date.now();
  try {
    const persona = (await fs.promises.readFile(path.join(cfg.sharedDir, PERSONA_FILE), 'utf8')).trim();
    const list = await readMemories(cfg.sharedDir);
    if (persona) cfg.persona = persona;
    chat.notes = list.map((m) => m.text.trim());
    await syncChat();
    folderState = { ok: true, error: '', count: list.length };
  } catch (e) {
    folderState = { ok: false, error: e.code === 'ENOENT' ? '文件夹里找不到 人设.md 或 记忆.json（云盘可能还没同步好）' : e.message, count: 0 };
  }
}

// chat history: union of the folder's and this computer's messages by id, in time order. Clearing writes clearedAt so
// a copy elsewhere can't bring the old messages back.
const msgKey = (m) => m.id || `${m.t}|${m.role}|${m.content}`;
async function syncChat() {
  let shared = { clearedAt: 0, messages: [] };
  try { shared = { ...shared, ...JSON.parse(await fs.promises.readFile(path.join(cfg.sharedDir, CHAT_FILE), 'utf8')) }; } catch (e) { if (e.code !== 'ENOENT') throw e; }
  const clearedAt = Math.max(shared.clearedAt || 0, chat.clearedAt || 0);
  const seen = new Map();
  for (const m of [...(shared.messages || []), ...chat.messages]) if (m && m.t > clearedAt && !seen.has(msgKey(m))) seen.set(msgKey(m), m);
  const merged = [...seen.values()].sort((a, b) => a.t - b.t).slice(-MAX_MSGS);
  const same = (list) => list.length === merged.length && list.every((m, i) => msgKey(m) === msgKey(merged[i]));
  if (!same(shared.messages || []) || clearedAt !== (shared.clearedAt || 0)) {
    await fs.promises.writeFile(path.join(cfg.sharedDir, CHAT_FILE), JSON.stringify({ clearedAt, messages: merged }, null, 1));
  }
  if (!same(chat.messages) || clearedAt !== (chat.clearedAt || 0)) { chat.messages = merged; chat.clearedAt = clearedAt; saveChat(); }
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
async function seen() {
  const file = useFolder() && path.join(cfg.sharedDir, STATE_FILE);
  let st = { ...(chat.state || {}) };
  if (file) { try { st = JSON.parse(await fs.promises.readFile(file, 'utf8')); } catch (_) { /* new folder or unreadable: start from the local copy */ } }
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
  st.lastSeen = { t: now, from: DEVICE };
  chat.state = st;
  saveChat();
  if (file) { try { await fs.promises.writeFile(file, JSON.stringify(st, null, 1)); } catch (_) {} }
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

// change the folder's memory list: read it fresh, apply fn, write it back
async function editMemories(fn) {
  let list = [];
  try { list = await readMemories(cfg.sharedDir); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  list = fn(list);
  await writeMemories(cfg.sharedDir, list);
  chat.notes = list.map((m) => m.text.trim()).slice(-MAX_NOTES);
  folderState = { ok: true, error: '', count: list.length };
}

async function addNotes(texts) {
  texts = texts.filter((t) => !chat.notes.includes(t));
  if (!texts.length) return;
  if (!useFolder()) { chat.notes.push(...texts); return; }
  try {
    await editMemories((list) => [...list, ...texts.filter((t) => !list.some((m) => m.text.trim() === t)).map((text) => ({ text, from: DEVICE, time: stamp() }))]);
  } catch (_) { chat.notes.push(...texts); }   // keep it locally at least
}

// moving to a folder: an existing persona there wins, this computer's memories are merged in
async function joinFolder(dir) {
  try {
    if (!(await fs.promises.stat(dir)).isDirectory()) throw new Error('不是文件夹');
    const pf = path.join(dir, PERSONA_FILE);
    if (!fs.existsSync(pf)) await fs.promises.writeFile(pf, cfg.persona + '\n');
    let list = [];
    try { list = await readMemories(dir); } catch (e) { if (e.code !== 'ENOENT') throw new Error('记忆.json 格式不对：' + e.message); }
    const add = chat.notes.filter((t) => !list.some((m) => m.text.trim() === t)).map((text) => ({ text, from: DEVICE, time: stamp() }));
    if (add.length || !fs.existsSync(path.join(dir, MEMORY_FILE))) await writeMemories(dir, [...list, ...add]);
    return '';
  } catch (e) { return '用不了这个文件夹：' + (e.code === 'ENOENT' ? '文件夹不存在' : e.code === 'EACCES' || e.code === 'EPERM' ? '没有写入权限' : e.message); }
}

function setKey(k) {
  k = (k || '').trim();
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
  };
}

async function updateSettings(s) {
  if (typeof s.baseUrl === 'string') cfg.baseUrl = s.baseUrl.trim().replace(/\/+$/, '') || defaults.baseUrl;
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
    if (typeof s.persona === 'string') cfg.persona = s.persona.trim() || DEFAULT_PERSONA;
    if (Array.isArray(s.notes)) await setNotes(s.notes.map((n) => String(n).trim()).filter(Boolean));
    if (useFolder() && cfg.persona !== before) {
      try { await fs.promises.writeFile(path.join(cfg.sharedDir, PERSONA_FILE), cfg.persona + '\n'); } catch (e) { error = '人格没能写进共享文件夹：' + e.message; }
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
  return { ...(await publicSettings()), error };
}

// the settings page's list: in a shared folder only apply what changed on the page, so memories that another computer
// added in the meantime are kept
async function setNotes(list) {
  if (!useFolder()) { chat.notes = list.slice(-MAX_NOTES); return; }
  const removed = shownNotes.filter((t) => !list.includes(t));
  const added = list.filter((t) => !shownNotes.includes(t));
  if (!removed.length && !added.length) return;
  try {
    await editMemories((cur) => [
      ...cur.filter((m) => !removed.includes(m.text.trim())),
      ...added.filter((t) => !cur.some((m) => m.text.trim() === t)).map((text) => ({ text, from: DEVICE, time: stamp() })),
    ]);
  } catch (_) { chat.notes = list.slice(-MAX_NOTES); }
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
  const baseUrl = prov.baseUrl || prov.baseURL || prov.apiBase || '';
  if (baseUrl) cfg.baseUrl = String(baseUrl).replace(/\/+$/, '');
  else if (!provName || /deepseek/i.test(provName)) cfg.baseUrl = defaults.baseUrl;
  if (dm.model) cfg.model = String(dm.model);
  saveCfg();
  return { ok: true, provider: provName || '', model: cfg.model, baseUrl: cfg.baseUrl, keyMasked: mask(key) };
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
    parts.push('当用户告诉你关于他自己、值得长期记住的信息（名字、喜好、习惯、重要安排等）时，在回复最后另起一行写 <memory>要记住的一句话</memory>，用户看不到这一行；已经记住的不要重复记，不要记临时的小事。');
  }
  parts.push([
    '你会主动找用户说话：打招呼、提醒休息、他回到电脑前时，还有到了他让你提醒的时间。所以不要说自己没法主动说话。',
    '定时提醒：只有用户明确要你在某个时间提醒他时，才在回复最后另起一行写 <remind at="YYYY-MM-DD HH:MM">要提醒的事</remind>。时间用 24 小时制的本地时间，根据消息开头给的当前时间换算（比如"半小时后""明天早上 9 点"）；用户说的钟点如果今天已经过了，就当成明天。回复里用自然的话跟他确认一下就行，用户看不到这一行。',
    '用户要取消提醒时写 <remind-cancel>提醒内容里的关键词</remind-cancel>，全部取消写 <remind-cancel>全部</remind-cancel>。',
  ].join('\n'));
  if (cfg.stickers !== 'off') parts.push(stickers.promptHint(cfg.stickers, cfg.memes));
  return parts.join('\n\n');
}

let controller = null;

async function send(text, onDelta, opts = {}) {
  const key = getKey();
  if (!key) throw Object.assign(new Error('还没有设置 API Key'), { code: 'nokey' });
  await refresh();
  if (controller) controller.abort();
  controller = new AbortController();
  const ctl = controller;

  chat.messages.push(newMsg('user', opts.image ? `${text}\n（附了一张屏幕截图）` : text));
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

  const timeout = setTimeout(() => ctl.abort(), 90000);
  let res;
  try {
    res = await fetch(cfg.baseUrl + '/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
      body: JSON.stringify(body),
      signal: ctl.signal,
    });
  } catch (e) {
    clearTimeout(timeout);
    chat.messages.pop();
    throw Object.assign(new Error(e.name === 'AbortError' ? '等太久没回应，网络可能不太好' : '连不上接口：' + e.message), { code: 'network' });
  }
  if (!res.ok) {
    clearTimeout(timeout);
    chat.messages.pop();
    let detail = '';
    try { detail = (await res.text()).slice(0, 300); } catch (_) {}
    const map = { 401: 'API Key 不对或已失效', 402: '账户余额不足', 404: '接口地址或模型名不对', 429: '请求太频繁了，稍后再试' };
    throw Object.assign(new Error((map[res.status] || '接口返回错误 ' + res.status) + (detail ? `（${detail}）` : '')), { code: 'http', status: res.status });
  }

  let full = '';
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (data === '[DONE]') continue;
        try {
          const j = JSON.parse(data);
          const piece = j.choices && j.choices[0] && j.choices[0].delta && j.choices[0].delta.content;
          if (piece) { full += piece; onDelta(stickers.hidePartial(visible(full)).trim()); }
        } catch (_) { /* keep-alive or partial */ }
      }
    }
  } finally {
    clearTimeout(timeout);
    if (controller === ctl) controller = null;
  }

  const mems = [...full.matchAll(/<memory>([\s\S]*?)<\/memory>/g)].map((m) => m[1].trim()).filter(Boolean);
  const remindAdd = [...full.matchAll(/<remind\s+at\s*=\s*["“]?([^"”>]+)["”]?\s*>([\s\S]*?)<\/remind>/g)].map((m) => ({ at: m[1].trim(), text: m[2].trim() }));
  const remindCancel = [...full.matchAll(/<remind-cancel>([\s\S]*?)<\/remind-cancel>/g)].map((m) => m[1].trim());
  const parsed = stickers.parseReply(visible(full), packs());
  const reply = parsed.text || (parsed.stickers.length ? '' : '……');
  const st = cfg.stickers === 'off' ? [] : parsed.stickers;
  if (cfg.memoryOn) await addNotes(mems);
  chat.messages.push(newMsg('assistant', reply || '（发了一个表情）', st.length ? { stickers: st } : {}));
  saveChat();
  await pushChat();
  return { reply, remembered: mems, stickers: st, remindAdd, remindCancel };
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
    if (c.meet && c.meet.firstToday) return `用户离开电脑大约 ${c.awayMin || 10} 分钟，刚刚回来，这是你们今天第一次见面。` + (meetHint(c.meet) || '跟他打个招呼。');
    const p = c.meet && c.meet.prev;
    const elsewhere = p && p.from !== DEVICE && Date.now() - p.t < (c.awayMin || 10) * 60000;
    return `用户离开这台电脑大约 ${c.awayMin || 10} 分钟，刚刚回来。` + (elsewhere ? `这段时间他在${place(p.from)}找过你（${ago(p.t)}）。${FOLLOW_UP}` : '');
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
    const parsed = stickers.parseReply(visible(raw), packs());
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
    text = stickers.parseReply(visible(text), []).text.split('\n')[0].replace(/^["“「『]+|["”」』]+$/g, '').trim();
    text = Array.from(text).slice(0, 30).join('');
    if (!text) return { ok: false, reason: 'empty' };
    recentWhispers.push(text);
    if (recentWhispers.length > 8) recentWhispers.shift();
    return { ok: true, text };
  } catch (e) {
    return { ok: false, reason: 'error', error: String(e.message || e) };
  }
}

function visible(s) {
  // hide control tags (memory / reminders), including one that is still arriving at the end
  return s
    .replace(/<memory>[\s\S]*?<\/memory>/g, '')
    .replace(/<remind-cancel>[\s\S]*?<\/remind-cancel>/g, '')
    .replace(/<remind\b[^>]*>[\s\S]*?<\/remind>/g, '')
    .replace(/<(memory|remind)[\s\S]*$/, '')
    .replace(/<[a-z-]{0,14}$/i, '')
    .replace(/\n{3,}/g, '\n\n').trimEnd();
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

module.exports = {
  init, publicSettings, updateSettings, importFromDsh, send, abort, test, listModels, history, clearHistory, proactive, balance, setOutfit, seen,
  hasKey: () => !!getKey(), busy: () => !!controller, proactiveMode: () => cfg.proactive, lookMode: () => cfg.look,
  whisper, whisperMode: () => cfg.whisper,
};
