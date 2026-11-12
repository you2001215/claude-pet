'use strict';
// The desktop link to AstrBot (「阿鲸」): one WebSocket to the desktop adapter, per docs/桌面连接接口说明.md v1.0.
// No electron here (the token store and the UI are passed in), so the tests can run it against a fake adapter.
//
// What it guarantees:
// - nothing that must arrive is lost: chat.send / offline.batch / event.care sit in a persisted outbox until acked
//   and go out again, with the same id, after a reconnect (the adapter de-duplicates by id);
// - every chat() settles exactly once: her reply, "merged into another reply", an error, or a timeout
//   (a reply that turns up after the timeout comes out as a 'late' event instead);
// - the log never sees chat text, the token or a pairing code: only types, ids, counts and lengths.
const EventEmitter = require('events');
const store = require('../store');
const P = require('./protocol');

const DAY = 86400000;
// timers never keep the process alive on their own (tests, and quitting the app)
const later = (fn, ms) => { const h = setTimeout(fn, ms); if (h.unref) h.unref(); return h; };
const every = (fn, ms) => { const h = setInterval(fn, ms); if (h.unref) h.unref(); return h; };
const OUTBOX_MAX = 500;
const ID_PREFIX = { 'event.watch': 'w', 'event.mode': 'o', 'event.typing': 'y', 'event.point': 'q', 'event.screen': 'x',
  'event.presence': 'p', 'event.emotion': 'f', 'event.say_seen': 'n' };
// phase ③ commands and the welcome.features entry each one needs (spec 17.1)
const NEEDS = { 'cmd.mood': 'mood', 'cmd.act': 'act', 'cmd.quiet': 'presence' };
const SEEN_MAX = 2000;

class LinkClient extends EventEmitter {
  constructor(o) {
    super();
    this.url = o.url || P.DEFAULT_URL;
    this.hello = o.hello || {};
    this.getToken = o.getToken || (() => '');
    this.setToken = o.setToken || (() => {});
    this.statePath = o.statePath || '';
    this.WS = o.WebSocket || require('ws');
    this.log = o.log || (() => {});
    const t = o.timers || {};
    this.pingMs = t.pingMs || 30000;
    this.pongMs = t.pongMs || 10000;
    this.welcomeMs = t.welcomeMs || 15000;
    this.backoff = t.backoff || [1000, 2000, 4000, 8000, 16000, 30000];
    this.jitter = t.jitter == null ? 0.3 : t.jitter;
    this.replyTimeoutMs = t.replyTimeoutMs || 240000;
    this.limits = { text_max: 4000, batch_max: 200 };
    this.onSay = o.onSay || (async () => ({ ok: true }));
    this.onSnapshot = o.onSnapshot || (async () => {});
    this.onMode = o.onMode || (async () => ({ ok: true }));      // cmd.mode (watch-together mode said in chat)
    this.onPoint = o.onPoint || (async () => ({ ok: true }));    // cmd.point (「她指他点」)
    this.onMood = o.onMood || (async () => ({ ok: true }));      // cmd.mood (her mood of the hour, phase ③)
    this.onAct = o.onAct || (async () => ({ ok: false, code: 'unknown' }));   // cmd.act (she asks for an action)
    this.onQuiet = o.onQuiet || (async () => ({ ok: true }));    // cmd.quiet (「别吵我」)
    this.features = [];           // what her side said it supports (welcome.features): 'watch', 'images', 'presence', 'mood', 'act'
    this._status = 'off';
    this.detail = '';
    this.deviceId = '';
    this.ws = null;
    this.wanted = false;
    this.tries = 0;
    this.pending = new Map();     // chat.send id -> { resolve, reject, timer }
    this.bad = 0;                 // frames we could not read
    this.unknown = 0;             // frames of a type we don't know
    this.refused = 0;             // our frames her side acked with ok:false (invalid, too_long…): not sent again
    this.timers = {};
    this.state = this._load();
  }

  // ---- state on disk: outbox, offline items not yet batched, ids seen, care counts
  _load() {
    const empty = { outbox: [], offline: [], seen: {}, care: {}, careLocal: {}, dropped: 0 };
    if (!this.statePath) return empty;
    const r = store.readJsonSync(this.statePath, empty);
    const s = r && r.data && typeof r.data === 'object' ? r.data : empty;
    for (const k of Object.keys(empty)) if (s[k] == null || typeof s[k] !== typeof empty[k] || Array.isArray(s[k]) !== Array.isArray(empty[k])) s[k] = empty[k];
    return s;
  }
  _save() {
    const now = Date.now(), s = this.state;
    const before = s.outbox.length;
    s.outbox = s.outbox.filter((e) => now - e.at < 7 * DAY).slice(-OUTBOX_MAX);
    s.offline = s.offline.filter((e) => now - e.ts < 7 * DAY).slice(-OUTBOX_MAX);
    s.dropped += before - s.outbox.length;
    const seen = Object.entries(s.seen).filter(([, at]) => now - at < 7 * DAY).sort((a, b) => a[1] - b[1]).slice(-SEEN_MAX);
    s.seen = Object.fromEntries(seen);
    const old = (k) => k.split('|')[1] < P.careDay(now - 3 * DAY);
    for (const box of [s.care, s.careLocal]) for (const k of Object.keys(box)) if (old(k)) delete box[k];
    if (!this.statePath) return;
    try { store.writeJsonSync(this.statePath, s); } catch (e) { this.log(`保存连接状态失败：${e.code || e.message}`); }
  }

  get status() { return this._status; }
  get online() { return this._status === 'online'; }
  _setStatus(s, detail = '') {
    if (s === this._status && detail === this.detail) return;
    this._status = s; this.detail = detail;
    this.log(`状态：${s}${detail ? '（' + detail + '）' : ''}`);
    this.emit('status', s, detail);
  }
  info() {
    return { status: this._status, detail: this.detail, deviceId: this.deviceId, outbox: this.state.outbox.length,
      offline: this.state.offline.length, dropped: this.state.dropped, bad: this.bad, unknown: this.unknown, refused: this.refused };
  }

  // ---- connecting
  start() {
    this.wanted = true;
    if (!this.getToken()) return this._setStatus('needs_pair');
    if (this.ws) return;
    this._connect({ token: this.getToken() });
  }
  stop() {
    this.wanted = false;
    this._clearTimers();
    if (this.pairing) { this.pairing.reject(Object.assign(new Error('stopped'), { code: 'stopped' })); this.pairing = null; }
    const ws = this.ws; this.ws = null;
    if (ws) { try { ws.removeAllListeners(); ws.on('error', () => {}); ws.close(1000); } catch (_) {} }
    for (const [id, p] of this.pending) { clearTimeout(p.timer); p.reject(Object.assign(new Error('offline'), { code: 'offline', id })); }
    this.pending.clear();
    this._setStatus('off');
  }
  // first-time pairing with the 6-digit code from 「/桌宠配对」. Resolves with the device id; one try per code.
  pair(code) {
    code = String(code || '').trim();
    if (!/^\d{6}$/.test(code)) return Promise.reject(Object.assign(new Error('配对码是 6 位数字'), { code: 'bad_code' }));
    this.stop();
    this.wanted = true;
    return new Promise((resolve, reject) => {
      this.pairing = { resolve, reject };
      this._connect({ pair_code: code });
    });
  }

  _connect(auth) {
    this._clearTimers();
    this._setStatus('connecting');
    let ws;
    try {
      // no Origin header (the adapter refuses any connection that has one), no compression, no frames over 2 MiB
      ws = new this.WS(this.url, { handshakeTimeout: 10000, perMessageDeflate: false, maxPayload: 2 * 1024 * 1024, followRedirects: false });
    } catch (e) {
      this.log(`地址不对：${e.code || e.message}`);
      return this._closed(0, '');
    }
    this.ws = ws;
    ws.on('open', () => {
      if (this.ws !== ws) return;
      this._send(P.frame('hello', { proto: [P.PROTO], app: 'ClaudePet', ...this.hello, auth }, P.newId('h')));
      this.timers.welcome = later(() => { if (this.ws === ws) ws.terminate(); }, this.welcomeMs);
    });
    ws.on('message', (data, isBinary) => { if (this.ws === ws && !isBinary) this._onFrame(String(data)); });
    ws.on('error', (e) => { if (this.ws === ws) this.log(`连接出错：${e.code || e.message}`); });
    ws.on('close', (code, reason) => { if (this.ws === ws) { this.ws = null; this._closed(code, String(reason || '')); } });
  }

  _closed(code, reason) {
    this._clearTimers();
    const wasPairing = this.pairing;
    this.pairing = null;
    this.log(`断开：${code}${reason ? ' ' + reason.slice(0, 40) : ''}`);
    if (wasPairing) {
      const why = code === P.CLOSE.PAIR_CODE_INVALID ? 'pair_code_invalid' : code === P.CLOSE.RATE_LIMITED ? 'rate_limited'
        : code === P.CLOSE.PROTO_UNSUPPORTED ? 'proto_unsupported' : 'unreachable';
      wasPairing.reject(Object.assign(new Error(why), { code: why }));
      if (!this.getToken()) { this.wanted = false; return this._setStatus('needs_pair', why); }
    }
    if (code === P.CLOSE.TOKEN_INVALID) { this.wanted = false; this.setToken(null, ''); return this._setStatus('revoked'); }
    if (code === P.CLOSE.PROTO_UNSUPPORTED) { this.wanted = false; return this._setStatus('outdated'); }
    if (code === P.CLOSE.REPLACED) { this.wanted = false; return this._setStatus('replaced'); }
    if (code === P.CLOSE.PAIR_CODE_INVALID) { this.wanted = false; return this._setStatus('needs_pair'); }
    if (!this.wanted) return this._setStatus('off');
    let wait;
    if (code === P.CLOSE.RATE_LIMITED) {
      const m = /retry_after=(\d+)/.exec(reason);
      wait = (m ? Number(m[1]) : 60) * 1000;
    } else {
      wait = this.backoff[Math.min(this.tries, this.backoff.length - 1)];
      wait += Math.round(wait * this.jitter * Math.random());
    }
    this.tries++;
    this._setStatus('waiting');
    this.timers.retry = later(() => { if (this.wanted && !this.ws) this._connect({ token: this.getToken() }); }, wait);
  }

  _clearTimers() {
    for (const k of Object.keys(this.timers)) { clearTimeout(this.timers[k]); clearInterval(this.timers[k]); }
    this.timers = {};
  }

  _send(f) {
    const ws = this.ws;
    if (!ws || ws.readyState !== 1) return false;
    try { ws.send(JSON.stringify(f)); return true; } catch (e) { this.log(`发送失败：${f.type} ${e.code || e.message}`); return false; }
  }

  // ---- incoming
  _onFrame(text) {
    const f = P.parse(text);
    if (!f) { this.bad++; return; }
    const d = f.data;
    switch (f.type) {
      case 'welcome': return this._welcome(d);
      case 'pong': clearTimeout(this.timers.pong); return;
      case 'ack': return this._ack(d);
      case 'chat.done': return this._done(d);
      case 'chat.error': return this._error(d);
      case 'cmd.say': return this._incoming(f, () => this.onSay(d, f));
      case 'snapshot.data': return this._incoming(f, async () => { await this.onSnapshot(d, f); return { ok: true }; });
      case 'event.care': return this._incoming(f, async () => { this._careState(d, f.ts); return { ok: true }; });
      case 'cmd.mode': return this._incoming(f, () => this.onMode(d, f));
      case 'cmd.point': return this._incoming(f, () => this.onPoint(d, f));
      // not switched on by her side (welcome.features): not ours to act on (17.8 case 9)
      case 'cmd.mood': case 'cmd.act': case 'cmd.quiet': {
        if (!this.features.includes(NEEDS[f.type])) return this._incoming(f, async () => ({ ok: false, code: 'not_allowed' }));
        const run = { 'cmd.mood': this.onMood, 'cmd.act': this.onAct, 'cmd.quiet': this.onQuiet }[f.type];
        return this._incoming(f, () => run(d, f));
      }
      default: this.unknown++;
    }
  }

  _welcome(d) {
    clearTimeout(this.timers.welcome);
    this.deviceId = String(d.device_id || '');
    this.features = Array.isArray(d.features) ? d.features.map(String) : [];
    if (d.token) this.setToken(String(d.token), this.deviceId);
    if (d.limits && typeof d.limits === 'object') {
      if (d.limits.text_max > 0) this.limits.text_max = d.limits.text_max;
      if (d.limits.batch_max > 0) this.limits.batch_max = d.limits.batch_max;
    }
    if (d.reply_timeout_s > 0) this.replyTimeoutMs = d.reply_timeout_s * 1000;
    if (typeof d.server_time === 'number' && Math.abs(d.server_time - Date.now()) > 120000) this.log(`两边时间差 ${Math.round((d.server_time - Date.now()) / 1000)} 秒`);
    this.tries = 0;
    if (this.pairing) { this.pairing.resolve(this.deviceId); this.pairing = null; }
    this._setStatus('online');
    this.timers.ping = every(() => {
      if (!this._send(P.frame('ping', {}, P.newId('p')))) return;
      clearTimeout(this.timers.pong);
      const ws = this.ws;
      this.timers.pong = later(() => { if (ws && this.ws === ws) ws.terminate(); }, this.pongMs);
    }, this.pingMs);
    this._flush();
  }

  // something the adapter sent that must be acked: run it once per id, ack again (without running) on a repeat
  async _incoming(f, run) {
    if (this.state.seen[f.id]) return this._send(P.frame('ack', { ref: f.id, ok: true, code: 'duplicate' }, P.newId('a')));
    let r;
    try { r = (await run()) || { ok: true }; } catch (e) { this.log(`处理 ${f.type} 出错：${e.code || e.message}`); return; }   // no ack: it comes again
    this.state.seen[f.id] = Date.now();
    this._save();
    // held: a proactive line kept for when the owner is back (17.3)
    this._send(P.frame('ack', { ref: f.id, ok: r.ok !== false, ...(r.code ? { code: r.code } : {}), ...(r.held ? { held: true } : {}) }, P.newId('a')));
  }

  _ack(d) {
    const ref = String(d.ref || '');
    const i = this.state.outbox.findIndex((e) => e.f.id === ref);
    if (i < 0) return;
    const [e] = this.state.outbox.splice(i, 1);
    this._save();
    if (d.ok === false && d.code !== 'duplicate') {
      this.refused++;
      this.log(`对方没收：${e.f.type} ${d.code || ''}`);
      if (e.f.type === 'chat.send') this._settle(ref, null, Object.assign(new Error(d.code || 'refused'), { code: d.code || 'refused', retry: true }));
    }
  }

  _settle(id, value, err) {
    const p = this.pending.get(id);
    if (!p) return false;
    clearTimeout(p.timer);
    this.pending.delete(id);
    if (err) { err.id = id; p.reject(err); } else p.resolve({ id, ...value });
    return true;
  }

  _done(d) {
    const to = String(d.reply_to || '');
    const ids = [...new Set([to, ...(Array.isArray(d.merged) ? d.merged.map(String) : [])])].filter(Boolean);
    // a reply also proves the message arrived, even if its ack got lost
    const before = this.state.outbox.length;
    this.state.outbox = this.state.outbox.filter((e) => !(e.f.type === 'chat.send' && ids.includes(e.f.id)));
    if (this.state.outbox.length !== before) this._save();
    const mine = this._settle(to, { kind: 'done', data: d });
    for (const id of ids) if (id !== to) this._settle(id, { kind: 'merged', into: to });
    if (!mine) this.emit('late', d);
  }

  _error(d) {
    this._settle(String(d.reply_to || ''), null, Object.assign(new Error(String(d.code || 'model_failed')), { code: String(d.code || 'model_failed'), retry: d.retry !== false }));
  }

  // ---- outgoing
  _queue(f) {
    this.state.outbox.push({ f, at: Date.now() });
    this._save();
    if (this.online) this._send(f);
  }
  // after (re)connecting: everything still unacked goes out again, oldest first, with its original id
  _flush() {
    this._batchOffline();
    for (const e of this.state.outbox) if (!this._send(e.f)) break;
  }
  // offline items -> offline.batch frames in the outbox; returns the new frames
  _batchOffline() {
    const s = this.state, made = [];
    while (s.offline.length) {
      const items = s.offline.splice(0, this.limits.batch_max);
      const f = P.frame('offline.batch', { from: items[0].ts, to: items[items.length - 1].ts, items }, P.newId('b'));
      s.outbox.push({ f, at: Date.now() });
      made.push(f);
    }
    this._save();
    return made;
  }

  hasFeature(name) { return this.online && this.features.includes(name); }

  // any other message: acked ones wait in the outbox like chat.send, the rest only go out while connected
  // (progress, typing: stale a moment later anyway). Returns the id, or '' when it wasn't sent.
  send(type, data = {}, { ack = false } = {}) {
    const f = P.frame(type, data, P.newId(ID_PREFIX[type] || type[0]));
    if (ack) { this._queue(f); return f.id; }
    return this.online && this._send(f) ? f.id : '';
  }

  // ask her. Resolves { id, kind: 'done', data } or { id, kind: 'merged', into }; rejects with code
  // offline | timeout | model_failed | ... (err.id is the message id either way, for reply_to)
  // extra: { context, images } (watch-together play point, a screenshot she was asked to look at)
  chat(text, input = 'text', extra = {}) {
    const id = P.newId('m');
    if (!this.online) return Promise.reject(Object.assign(new Error('offline'), { code: 'offline', id }));
    const data = { text: String(text).slice(0, this.limits.text_max), input: input === 'voice' ? 'voice' : 'text' };
    if (extra.context && typeof extra.context === 'object') data.context = extra.context;
    if (Array.isArray(extra.images) && extra.images.length) data.images = extra.images.slice(0, 1);
    const f = P.frame('chat.send', data, id);
    const done = new Promise((resolve, reject) => {
      const timer = later(() => this._settle(id, null, Object.assign(new Error('timeout'), { code: 'timeout', retry: true })), this.replyTimeoutMs);
      this.pending.set(id, { resolve, reject, timer });
    });
    this._queue(f);
    return done;
  }

  // things said while she wasn't there (or the pet's stand-in answers): [{ role, text, input?, reply_to?, ts? }]
  offline(items) {
    const now = Date.now();
    for (const it of items || []) {
      if (!it || !it.text) continue;
      const item = { id: it.id || P.newId('m'), ts: it.ts || now, kind: it.kind || 'chat', role: it.role === 'user' ? 'user' : 'pet', text: String(it.text).slice(0, this.limits.text_max) };
      if (it.input) item.input = it.input === 'voice' ? 'voice' : 'text';
      if (it.reply_to) item.reply_to = String(it.reply_to);
      this.state.offline.push(item);
    }
    if (this.online) { for (const f of this._batchOffline()) this._send(f); } else this._save();
  }

  // ---- sleep / meal questions, counted with the QQ side (spec 10)
  // her side keeps the count for both sides; a state covers every question it had received when it was made (its
  // ts), so the pet's own questions after that are added on top, and so are any still waiting in the outbox (asked
  // while she was away: the state she pushes on connecting is newer than they are but doesn't have them yet)
  _careState(d, at) {
    if (d.action !== 'state' || !d.kind || !d.slot) return;
    this.state.care[`${d.kind}|${d.slot}`] = {
      asked_qq: Number(d.asked_qq) || 0, asked_desktop: Number(d.asked_desktop) || 0,
      answered: !!d.answered, stopped: !!d.stopped, limit: Number(d.limit) || P.CARE_LIMIT[d.kind] || 1,
      at: Number(at) || Date.now(),
    };
  }
  careAllowed(kind, slot) {
    if (!slot) return false;
    const key = `${kind}|${slot}`;
    const st = this.state.care[key], mine = this.state.careLocal[key] || {};
    const asks = (Array.isArray(mine.asks) ? mine.asks : []).map((a) => (typeof a === 'number' ? { t: a } : a));
    if (mine.answered || mine.stopped || (st && (st.answered || st.stopped))) return false;
    const unsent = new Set(this.state.outbox.map((e) => e.f.id));
    const asked = st ? st.asked_qq + st.asked_desktop + asks.filter((a) => a.t >= st.at || unsent.has(a.id)).length : asks.length;
    return asked < ((st && st.limit) || P.CARE_LIMIT[kind] || 1);
  }
  care(kind, slot, action) {
    if (!slot) return;
    const key = `${kind}|${slot}`;
    const mine = this.state.careLocal[key] || (this.state.careLocal[key] = {});
    if (!Array.isArray(mine.asks)) mine.asks = [];
    const f = P.frame('event.care', { kind, slot, action, side: 'desktop' }, P.newId('c'));
    if (action === 'asked') mine.asks.push({ t: Date.now(), id: f.id });
    if (action === 'answered') mine.answered = true;
    if (action === 'stop') mine.stopped = true;
    this._queue(f);
  }
}

module.exports = { LinkClient };
