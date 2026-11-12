'use strict';
// Phase ③ (docs/桌面连接接口说明.md section 17), the parts that don't need electron, so they can be tested alone:
//   Presence   is the owner at the computer? -> event.presence (17.2)
//   Feelings   the pet's body stimuli -> event.emotion, with the pet-side limits, and "2 hours ignored" (17.4)
//   Held       her proactive lines that came while the owner had just walked away (17.3)
//   moodNow / quietUntil   the mood she sends (17.5) and "don't bother me" time (17.3)
// main.js feeds them samples and sends what they hand back.

const AWAY_IDLE_S = 600;          // 10 minutes without keyboard or mouse = away (unless a video is playing)
const MERGE_MS = 15000;           // only the app / title / video flag changed: at most one report per 15 s
const TITLE_MAX = 80;
const MOODS = ['开心', '得意', '上头', '平静', '无聊', '烦', '委屈', '担心'];
const QUIET_MAX_MS = 12 * 3600000;
const MOOD_KEEP_MS = 2 * 3600000; // a mood without `until` lasts 2 hours after the link drops
const IGNORED_MS = 2 * 3600000;
// cmd.act names: the 「动作」 column of design/亲密度与事件.xlsx (17.6)
const ACTS = ['待机', '东张西望', '原地走路', '思考中', '说话', '挥手打招呼', '被摸头', '被点开心', '傲娇生气', '睡觉', '打哈欠伸懒腰',
  '吃白饭', '到点提醒', '看屏幕', '敲键盘', '吐泡泡', '余额充足', '余额见底'];

const cut = (s, n) => Array.from(String(s || '')).slice(0, n).join('');

class Presence {
  // send(data): hand one event.presence data object to the link
  constructor({ now = Date.now, send = () => {}, mergeMs = MERGE_MS, awayIdleS = AWAY_IDLE_S } = {}) {
    this.now = now; this.out = send; this.mergeMs = mergeMs; this.awayIdleS = awayIdleS;
    this.state = 'here'; this.why = 'active'; this.awaySince = 0; this.watching = false;
    this.front = null; this.idle = 0;
    this.sentKey = ''; this.sentAt = 0; this.started = false;
    this.backAwayS = 0;           // came back while the link was down: told with the next `start`
  }
  get here() { return this.state === 'here'; }

  // s: { idle_s, locked, asleep, watching, front: { app, title } | null }
  sample(s = {}) {
    const t = this.now();
    const idle = Math.max(0, Number(s.idle_s) || 0);
    const watching = !!s.watching;
    let state, why;
    if (s.asleep) { state = 'away'; why = 'sleep'; }
    else if (s.locked) { state = 'away'; why = 'locked'; }
    else if (idle >= this.awayIdleS && !watching) { state = 'away'; why = 'idle'; }
    else { state = 'here'; why = idle >= this.awayIdleS ? 'video' : 'active'; }
    const front = state === 'here' && s.front && s.front.app ? { app: cut(s.front.app, 60), ...(s.front.title ? { title: cut(s.front.title, TITLE_MAX) } : {}) } : null;
    const was = this.state;
    this.idle = idle; this.watching = watching; this.front = front;
    if (state !== was) {
      let awayS = 0;
      if (state === 'away') this.awaySince = why === 'idle' ? t - idle * 1000 : t;
      else awayS = this.awaySince ? Math.max(0, Math.round((t - this.awaySince) / 1000)) : 0;
      this.state = state; this.why = why;
      if (this.started) this._send(why, awayS);
      else this.backAwayS = state === 'here' ? awayS : 0;
      return;
    }
    this.why = why;
    if (!this.started || state !== 'here') return;
    // only what she can see changed (app, title, video): merged
    if (this._key() !== this.sentKey && t - this.sentAt >= this.mergeMs) {
      const onlyFront = this._watchKey() === this.sentWatch;
      this._send(onlyFront ? 'front' : why, 0);
    }
  }
  // right after welcome: the current state once (17.2 `why: "start"`)
  start() {
    this.started = true;
    this._send('start', this.state === 'here' ? this.backAwayS : 0);
    this.backAwayS = 0;
  }
  stop() { this.started = false; }

  _key() { return JSON.stringify([this.state, this.watching, this.front]); }
  _watchKey() { return String(this.watching); }
  _send(why, awayS) {
    const d = { state: this.state, why, idle_s: Math.round(this.idle), away_s: awayS, watching: this.watching };
    if (this.state === 'here' && this.front) d.front = this.front;
    this.sentKey = this._key(); this.sentWatch = this._watchKey(); this.sentAt = this.now();
    this.out(d);
  }
  info() { return { state: this.state, why: this.why, watching: this.watching, started: this.started }; }
}

// cause -> what it means to her (17.4); the limits are the pet's own
const STIMULI = {
  drop: { name: '委屈', level: 1, text: '被摔疼了', gapMs: 60000 },
  poke: { name: '烦', level: 2, text: '被连着戳生气了', gapMs: 0 },
  calm: { name: '开心', level: 1, text: '被摸头哄好了', gapMs: 0 },
  ignored: { name: '无聊', level: 1, text: '两小时没人理', gapMs: 0 },
};
class Feelings {
  // send(data): one event.emotion data object (only called while it can go out; offline ones are dropped, 17.4)
  constructor({ now = Date.now, send = () => {}, ignoredMs = IGNORED_MS } = {}) {
    this.now = now; this.out = send; this.ignoredMs = ignoredMs;
    this.last = {}; this.alone = 0; this.ignoredSent = false; this.sent = 0;
  }
  // the pet felt something: returns the data sent, or null when a limit held it back
  stimulus(cause) {
    const s = STIMULI[cause];
    if (!s) return null;
    const t = this.now();
    if (s.gapMs && t - (this.last[cause] || -1e15) < s.gapMs) return null;
    this.last[cause] = t;
    const d = { name: s.name, level: s.level, cause, text: s.text };
    this.out(d); this.sent++;
    return d;
  }
  // the owner did something with the pet (chat on the desktop, click, pat, drag): the 2 hours start again
  interacted() { this.alone = 0; this.ignoredSent = false; }
  // called every few seconds: only time the owner is here, not watching a video and not in quiet time counts
  tick(dtMs, { here, watching, quiet }) {
    if (!here || watching || quiet) return null;
    this.alone += Math.max(0, dtMs);
    if (this.alone < this.ignoredMs || this.ignoredSent) return null;
    this.ignoredSent = true;     // once per stretch: the next one only after the owner pays her attention again
    return this.stimulus('ignored');
  }
}

// her lines held while the owner was away (17.3): shown on return if still fresh; she is told either way
class Held {
  constructor({ now = Date.now, max = 20 } = {}) { this.now = now; this.max = max; this.items = []; }
  hold(id, d) {
    this.items.push({ id: String(id), d, exp: Number(d.expires_at) || this.now() + 600000 });
    if (this.items.length > this.max) this.items.shift();
  }
  // the owner is back: { show: [{ id, d }], missed: [id] }
  release() {
    const t = this.now(), show = [], missed = [];
    for (const it of this.items) { if (t <= it.exp) show.push({ id: it.id, d: it.d }); else missed.push(it.id); }
    this.items = [];
    return { show, missed };
  }
  // past their time while the owner is still away: missed
  expire() {
    const t = this.now();
    const gone = this.items.filter((it) => t > it.exp).map((it) => it.id);
    this.items = this.items.filter((it) => t <= it.exp);
    return gone;
  }
  get size() { return this.items.length; }
}

// cmd.mood -> what the pet keeps; null = not a mood we know
function readMood(d, ts, now = Date.now()) {
  if (!d || !MOODS.includes(String(d.name))) return null;
  const level = Math.min(3, Math.max(1, Math.round(Number(d.level) || 1)));
  const until = Number(d.until) > 0 ? Number(d.until) : 0;
  return { name: String(d.name), level, until, ts: Number(ts) || now };
}
// the mood in effect now: a mood stays until its `until` (or 2 hours after it came), then it's calm again
function moodNow(m, now = Date.now()) {
  if (!m) return null;
  const end = m.until || m.ts + MOOD_KEEP_MS;
  return now <= end ? m : null;
}
// cmd.quiet's until, capped at 12 hours from now; 0 = over
function quietUntil(until, now = Date.now()) {
  const u = Number(until) || 0;
  if (u <= now) return 0;
  return Math.min(u, now + QUIET_MAX_MS);
}

module.exports = { Presence, Feelings, Held, readMood, moodNow, quietUntil, MOODS, ACTS, STIMULI, AWAY_IDLE_S, TITLE_MAX };
