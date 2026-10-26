'use strict';
// Video clips for the maid outfit (transparent VP9 webm from dsh-pet): plays one clip at a time,
// cross-fades between clips, loops a section for long states, and knows which seasonal clips fit today.
function makeClips(BASE) {
  const FADE_MS = 160;
  let M = null;
  const cache = new Map();          // name -> <video>, most recently used last
  let cur = null, next = null, prev = null, fadeAt = 0;

  async function load() {
    if (!M) M = await (await fetch(BASE + 'clips.json')).json();
    return M;
  }
  const dur = (name) => (M && M.duration[name]) || 10;
  const busy = () => [cur, next, prev].filter(Boolean).map((c) => c.v);

  function video(name) {
    let v = cache.get(name);
    if (v) { cache.delete(name); cache.set(name, v); return v; }
    v = document.createElement('video');
    v.muted = true; v.playsInline = true; v.preload = 'auto'; v.disablePictureInPicture = true;
    v.src = BASE + encodeURIComponent(name) + '.webm';
    cache.set(name, v);
    // keep a handful of decoders around, never the ones on screen
    const live = busy();
    for (const [k, old] of cache) {
      if (cache.size <= 8) break;
      if (old === v || live.includes(old)) continue;
      old.pause(); old.removeAttribute('src'); old.load();
      cache.delete(k);
    }
    return v;
  }

  function segOf(name, loop) {
    if (!loop) return null;
    if (Array.isArray(loop)) return loop;
    return (M && M.loops[name]) || [0, dur(name)];
  }

  // ask for a clip; same clip already playing/queued is left alone unless restart is set
  function play(name, { loop = false, from = 0, restart = false } = {}) {
    if (!M || !name) return;
    const target = next || cur;
    if (target && target.name === name && !restart) { target.loop = segOf(name, loop); return; }
    const v = video(name);
    if (next && next.v !== v && (!cur || next.v !== cur.v)) next.v.pause();   // a switch that never showed
    const item = { name, v, loop: segOf(name, loop), ready: false, from };
    next = item;
    try { v.currentTime = from; } catch (_) {}
    const p = v.play(); if (p && p.catch) p.catch(() => {});
    const mark = () => { if (next === item) item.ready = true; };
    if (typeof v.requestVideoFrameCallback === 'function') v.requestVideoFrameCallback(mark);
    v.addEventListener('playing', mark, { once: true });
    if (v.readyState >= 2 && !v.seeking && from === 0 && v.currentTime < 0.05) setTimeout(mark, 30);
  }

  function tick() {
    const t = performance.now();
    if (next && next.ready) {
      if (cur && cur.v !== next.v) { prev = cur; fadeAt = t; } else prev = null;
      cur = next; next = null; cur.since = t;
    }
    if (cur) {
      const v = cur.v;
      if (cur.loop) {
        const [a, b] = cur.loop;
        if (v.ended || v.currentTime >= b - 0.03) { try { v.currentTime = a; } catch (_) {} const p = v.play(); if (p && p.catch) p.catch(() => {}); }
      }
    }
    if (prev && t - fadeAt > FADE_MS) { if (!cur || prev.v !== cur.v) prev.v.pause(); prev = null; }
  }

  // what to draw this frame: [{ v, a }]
  function layers() {
    const out = [];
    const ok = (c) => c && c.v.readyState >= 2;
    if (prev && ok(prev) && ok(cur)) {
      const k = Math.min(1, (performance.now() - fadeAt) / FADE_MS);
      out.push({ v: prev.v, a: 1 - k }, { v: cur.v, a: k });
    } else if (ok(cur)) out.push({ v: cur.v, a: 1 });
    else if (ok(prev)) out.push({ v: prev.v, a: 1 });
    return out;
  }

  const current = () => (next || cur || {}).name || '';
  const ended = () => !!(cur && !next && !cur.loop && (cur.v.ended || cur.v.currentTime >= dur(cur.name) - 0.06));

  function stopAll() {
    for (const v of cache.values()) { v.pause(); }
    cur = next = prev = null;
  }

  // ---------- which random actions fit right now ----------
  // lunar festivals by Gregorian date; [month-day] windows are inclusive
  const LUNAR = {
    spring: ['2027-02-06', '2028-01-26', '2029-02-13'],
    lantern: ['2027-02-20', '2028-02-09', '2029-02-27'],
    dragon: ['2027-06-09', '2028-05-28', '2029-06-16'],
    qixi: ['2026-08-19', '2027-08-08', '2028-08-26'],
    ghost: ['2026-08-27', '2027-08-16', '2028-09-03'],
    midautumn: ['2026-09-25', '2027-09-15', '2028-10-03'],
    chongyang: ['2026-10-18', '2027-10-08', '2028-10-26'],
    laba: ['2027-01-15', '2028-01-04', '2029-01-22'],
  };
  const dayMs = 86400000;
  const near = (key, before, after, d) => LUNAR[key].some((s) => {
    const x = new Date(s + 'T00:00:00').getTime();
    return d.getTime() >= x - before * dayMs && d.getTime() <= x + (after + 1) * dayMs;
  });
  const md = (d) => (d.getMonth() + 1) * 100 + d.getDate();
  const between = (d, a, b) => (a <= b ? md(d) >= a && md(d) <= b : md(d) >= a || md(d) <= b);
  const SEASONAL = {
    收红包: (d) => near('spring', 8, 14, d), 写福字: (d) => near('spring', 8, 14, d), 舞狮头: (d) => near('spring', 3, 14, d),
    吃年糕: (d) => near('spring', 8, 14, d), 吃饺子: (d) => near('spring', 1, 5, d) || between(d, 1220, 1223),
    放烟花: (d) => near('spring', 1, 14, d) || between(d, 1231, 101),
    吃汤圆: (d) => near('lantern', 2, 1, d) || between(d, 1220, 1223), 放孔明灯: (d) => near('lantern', 2, 1, d),
    吃青团: (d) => between(d, 401, 408), 吃粽子: (d) => near('dragon', 4, 1, d), 穿针乞巧: (d) => near('qixi', 2, 1, d),
    放河灯: (d) => near('ghost', 2, 1, d), 中秋赏月吃月饼: (d) => near('midautumn', 6, 2, d),
    吃重阳糕: (d) => near('chongyang', 3, 1, d), 插茱萸赏菊: (d) => near('chongyang', 3, 1, d),
    吃腊八粥: (d) => near('laba', 2, 1, d), 讨糖南瓜灯: (d) => between(d, 1024, 1101), 萌化小幽灵: (d) => between(d, 1024, 1101),
    装点圣诞树: (d) => between(d, 1215, 1226), 被落叶淹没: (d) => between(d, 920, 1130), 堆雪人: (d) => between(d, 1201, 228),
  };
  const HOURS = { 吃早餐: [6, 10], 晨间刷牙: [6, 10], 吃午餐: [11, 14], 吃晚餐: [17, 21], 摇扇纳凉: [0, 24], 吃西瓜: [0, 24] };
  const SUMMERY = { 摇扇纳凉: 1, 吃西瓜: 1, 玩水枪: 1, 吃冰淇淋融化: 1 };
  function fits(name, d = new Date()) {
    if (SEASONAL[name]) return SEASONAL[name](d);
    const h = HOURS[name];
    if (h && !(d.getHours() >= h[0] && d.getHours() < h[1])) return false;
    if (SUMMERY[name] && !between(d, 501, 930)) return false;
    return true;
  }

  // pick the next random thing to do: { kind: 'idle'|'turn'|'move'|'act', clip }
  let lastAct = '';
  function roll() {
    const d = new Date();
    const pools = M.categories.map((c) => ({ ...c, actions: c.actions.filter((n) => n !== lastAct && fits(n, d)) })).filter((c) => c.actions.length);
    const opts = [{ kind: 'idle', w: 34 }, { kind: 'turn', w: 8 }, { kind: 'move', w: 8 }, ...pools.map((c) => ({ kind: 'act', w: c.weight * 0.7, c }))];
    // a festival today: make its clips show up more
    const fest = pools.find((c) => c.id === '时节');
    if (fest) opts.find((o) => o.c === fest).w *= 1.6;
    let r = Math.random() * opts.reduce((s, o) => s + o.w, 0);
    for (const o of opts) {
      r -= o.w;
      if (r > 0) continue;
      if (o.kind === 'act') { const n = o.c.actions[Math.floor(Math.random() * o.c.actions.length)]; lastAct = n; return { kind: 'act', clip: n }; }
      if (o.kind === 'turn') return { kind: 'turn', clip: M.turn[Math.floor(Math.random() * M.turn.length)] };
      if (o.kind === 'move') return { kind: 'move', clip: M.walk[0] };
      return { kind: 'idle', clip: M.idle };
    }
    return { kind: 'idle', clip: M.idle };
  }

  const active = () => !!(cur || next);
  return { load, play, tick, layers, current, ended, dur, roll, fits, stopAll, active, get M() { return M; } };
}
window.Clips = makeClips('../assets/maid/');          // maid outfit (from dsh-pet)
window.ClaudeClips = makeClips('../assets/claude/');  // Claude outfit: our own generated clips, used where they exist
