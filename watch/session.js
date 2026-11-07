'use strict';
// Watching together (phase 2): turns what the browser script reports (watch/server.js) into event.watch for her
// side, per docs/桌面连接接口说明.md section 16.3. No electron here.
//
// - start: the first report of a video (and again after a leave, when you come back to it)
// - progress: while playing, at most one every 10 s; play / pause / seek / rate / ended go out at once
// - leave: page closed, another video, the tab hidden for 10 s, or no report for 15 s
// start / ended / leave are acked (kept for the "what we watched" record); the rest are dropped when not connected.
const EventEmitter = require('events');

const later = (fn, ms) => { const h = setTimeout(fn, ms); if (h.unref) h.unref(); return h; };
const num = (x, d = 0) => (Number.isFinite(Number(x)) ? Number(x) : d);
const ACKED = new Set(['start', 'ended', 'leave']);
const KINDS = new Set(['heartbeat', 'play', 'pause', 'seek', 'rate', 'ended', 'switch', 'hidden', 'visible', 'leave']);

class WatchSession extends EventEmitter {
  // o.send(kind, data, ack): hand one event.watch to the link; o.mode(): { mode, hourly_max }
  constructor(o = {}) {
    super();
    this.sendOut = o.send || (() => {});
    this.mode = o.mode || (() => ({ mode: 'normal', hourly_max: 25 }));
    this.now = o.now || Date.now;
    const t = o.timers || {};
    this.progressMs = t.progressMs || 10000;
    this.leaveMs = t.leaveMs || 15000;
    this.hiddenMs = t.hiddenMs || 10000;
    this.cur = null;
    this.cmds = [];          // for the script: [{ id, type: 'seek', t, at }]
    this.timers = {};
    this.lastScriptAt = 0;
  }

  // one report from the script -> the answer for it ({ ok, cmd })
  report(ev) {
    const now = this.now();
    this.lastScriptAt = now;
    if (!ev || typeof ev !== 'object' || !KINDS.has(ev.kind)) return { ok: false, error: 'bad kind' };
    const done = new Set(Array.isArray(ev.done) ? ev.done.map(String) : []);
    this.cmds = this.cmds.filter((c) => !done.has(c.id) && now - c.at < 30000);
    if (ev.kind === 'leave') { this._leave(); this.cur = null; return this._answer(); }

    const v = ev.video && typeof ev.video === 'object' ? ev.video : {};
    const video = {
      site: 'bilibili', bvid: String(v.bvid || '').slice(0, 20), cid: num(v.cid), p: num(v.p, 1) || 1,
      title: String(v.title || '').slice(0, 80), dur: Math.max(0, num(v.dur)),
    };
    if (v.ep) video.ep = num(v.ep);
    if (!video.bvid && !video.cid && !video.ep) return { ok: false, error: 'no video' };
    const key = `${video.bvid}|${video.cid || video.ep}|${video.p}`;
    if (this.cur && this.cur.key !== key) { this._leave(); this.cur = null; }
    if (!this.cur) this.cur = { key, started: false, lastSentAt: 0, hidden: false };
    const c = this.cur;
    c.video = video;
    c.t = Math.max(0, num(ev.t));
    c.paused = !!ev.paused;
    c.rate = num(ev.rate, 1) || 1;
    c.at = now;

    clearTimeout(this.timers.gone);
    this.timers.gone = later(() => { this._leave(); this.cur = null; }, this.leaveMs);
    const hidden = ev.kind === 'hidden' || (ev.kind !== 'visible' && ev.hidden === true);
    if (hidden && !c.hidden) { c.hidden = true; this.timers.hidden = later(() => this._leave(), this.hiddenMs); }
    if (!hidden && c.hidden) { c.hidden = false; clearTimeout(this.timers.hidden); }

    if (!c.started) {
      if (!c.hidden) this._out('start');
      return this._answer();
    }
    if (['play', 'pause', 'rate', 'ended'].includes(ev.kind)) this._out(ev.kind);
    else if (ev.kind === 'seek') this._out('seek', { from: Number.isFinite(Number(ev.from)) ? Number(ev.from) : null });
    else if (!c.paused && now - c.lastSentAt >= this.progressMs) this._out('progress');
    return this._answer();
  }

  _answer() { return { ok: true, cmd: this.cmds.map(({ id, type, t }) => ({ id, type, t })) }; }

  _out(kind, extra = {}) {
    const c = this.cur;
    if (!c) return;
    if (kind === 'start') { c.started = true; c.left = false; }
    c.lastSentAt = this.now();
    const m = this.mode();
    const data = { kind, video: c.video, t: Math.round(c.t * 10) / 10, paused: c.paused, rate: c.rate, from: null, mode: m.mode, hourly_max: m.hourly_max, ...extra };
    this.sendOut(kind, data, ACKED.has(kind));
    this.emit('event', kind, data);
  }

  _leave() {
    clearTimeout(this.timers.hidden); clearTimeout(this.timers.gone);
    const c = this.cur;
    if (!c || !c.started || c.left) return;
    this._out('leave');
    c.left = true; c.started = false;      // coming back to the same video sends start again
  }

  // where you are now (null when not watching): for chat.send's context.watch and for checking her lines
  position() {
    const c = this.cur;
    if (!c || !c.started || c.left || this.now() - c.at > 30000) return null;
    const t = c.paused ? c.t : c.t + ((this.now() - c.at) / 1000) * c.rate;
    return { bvid: c.video.bvid, cid: c.video.cid, p: c.video.p, ep: c.video.ep || 0, t: Math.round(t * 10) / 10, paused: c.paused, title: c.video.title };
  }

  // is anchor a (from her side: { bvid, ep, cid, p }) about the video being watched? bvid when it has one, else ep;
  // p too when it says which part
  same(a, p = this.position()) {
    if (!a || !p) return false;
    if (a.bvid) { if (a.bvid !== p.bvid) return false; }
    else if (a.ep) { if (num(a.ep) !== num(p.ep)) return false; }
    else return false;
    return !(a.p && p.p && num(a.p) !== num(p.p));
  }

  // a line she said about point `w.t` of video `w.bvid`: still worth showing? (section 16.7)
  fresh(w, mode = 'normal') {
    if (!w || typeof w !== 'object') return false;
    if (w.end) return true;                 // the "we're done" line / the quiet-mode summary: only the expiry counts
    const p = this.position();
    if (!p || !this.same(w, p)) return false;
    if (p.paused && mode !== 'chatty') return false;
    return Math.abs(p.t - num(w.t, -1e9)) <= 20;
  }

  // 「跳过去」: the script jumps there on its next report
  seek(t) {
    const id = `j_${this.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    this.cmds.push({ id, type: 'seek', t: Math.max(0, num(t)), at: this.now() });
    return id;
  }

  stop() { clearTimeout(this.timers.hidden); clearTimeout(this.timers.gone); this.cur = null; this.cmds = []; }
}

module.exports = { WatchSession };
