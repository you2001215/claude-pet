'use strict';
// Video clips (transparent VP9 webm; maid ones from dsh-pet): plays one clip at a time, cross-fades between
// clips, loops a section for long states, and knows which seasonal clips fit today.
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

  // A seek drops the element to readyState 1 for a few frames, with nothing to draw. Right before an on-screen
  // element seeks, its frame is copied here and drawn meanwhile, so loops and restarts never blink.
  const snaps = new Map();          // <video> -> <canvas>
  function snapshot(v) {
    if (v.readyState < 2 || v.seeking || !v.videoWidth) return;   // no fresh frame: keep the older still
    let c = snaps.get(v);
    if (!c) { c = document.createElement('canvas'); snaps.set(v, c); }
    if (c.width !== v.videoWidth || c.height !== v.videoHeight) { c.width = v.videoWidth; c.height = v.videoHeight; }
    const g = c.getContext('2d');
    g.clearRect(0, 0, c.width, c.height);
    try { g.drawImage(v, 0, 0, c.width, c.height); } catch (_) { snaps.delete(v); }
  }
  // every currentTime change goes through here
  function seek(v, t) {
    if (busy().includes(v)) snapshot(v);
    try { v.currentTime = t; } catch (_) {}
  }

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
      cache.delete(k); snaps.delete(old);
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
    const v = video(name), seg = segOf(name, loop);
    // the same element already on screen (waking: the sleep clip from wakeFrom) takes the new loop now, or tick()
    // would see it past its old loop end and seek it straight back before the new item is ready
    for (const c of [cur, next]) if (c && c.v === v) { c.name = name; c.loop = seg; }
    if (!busy().includes(v)) snaps.delete(v);                                 // a still from an earlier play
    if (next && next.v !== v && (!cur || next.v !== cur.v)) next.v.pause();   // a switch that never showed
    seek(v, from);
    const item = { name, v, loop: seg, ready: false, from };
    next = item;
    const p = v.play(); if (p && p.catch) p.catch(() => {});
    const mark = () => { if (next === item) item.ready = true; };
    if (typeof v.requestVideoFrameCallback === 'function') v.requestVideoFrameCallback(mark);
    v.addEventListener('playing', mark, { once: true });
    if (v.readyState >= 2 && !v.seeking && from === 0 && v.currentTime < 0.05) setTimeout(mark, 30);
  }

  function tick() {
    const t = performance.now();
    if (next && next.ready) {
      if (prev && prev.v !== next.v && prev.v !== (cur && cur.v)) prev.v.pause();   // a fade cut short
      if (cur && cur.v !== next.v) { prev = cur; fadeAt = t; } else prev = null;
      cur = next; next = null; cur.since = t;
    }
    if (cur) {
      const v = cur.v;
      if (cur.loop) {
        const [a, b] = cur.loop;
        if (v.ended || v.currentTime >= b - 0.03) { seek(v, a); const p = v.play(); if (p && p.catch) p.catch(() => {}); }
      }
    }
    if (prev && t - fadeAt > FADE_MS) { if (prev.v !== (cur && cur.v) && prev.v !== (next && next.v)) prev.v.pause(); prev = null; }
  }

  // what to draw this frame: [{ v, a }], v being the video or, while it seeks, its still
  const frameOf = (c) => (!c ? null : c.v.readyState >= 2 && !c.v.seeking ? c.v : snaps.get(c.v) || null);
  function layers() {
    const out = [];
    const a = frameOf(prev), b = frameOf(cur);
    if (a && b) {
      const k = Math.min(1, (performance.now() - fadeAt) / FADE_MS);
      out.push({ v: a, a: 1 - k }, { v: b, a: k });
    } else if (b) out.push({ v: b, a: 1 });
    else if (a) out.push({ v: a, a: 1 });
    return out;
  }

  const current = () => (next || cur || {}).name || '';
  const ended = () => !!(cur && !next && !cur.loop && (cur.v.ended || cur.v.currentTime >= dur(cur.name) - 0.06));

  function stopAll() {
    for (const v of cache.values()) { v.pause(); }
    cur = next = prev = null;
    snaps.clear();
  }

  // ---------- which random actions fit right now ----------
  // lunar festivals by Gregorian date through 2040; [month-day] windows are inclusive. Worked out with Intl's
  // chinese calendar (leap months skipped), each month start checked against the new moon in Beijing time: ICU is a
  // day late for 2027 and early for 2030 Spring Festival, whose new moons fall a few minutes from midnight.
  const LUNAR = {
    spring: ['2027-02-06', '2028-01-26', '2029-02-13', '2030-02-03', '2031-01-23', '2032-02-11', '2033-01-31',
      '2034-02-19', '2035-02-08', '2036-01-28', '2037-02-15', '2038-02-04', '2039-01-24', '2040-02-12'],
    lantern: ['2027-02-20', '2028-02-09', '2029-02-27', '2030-02-17', '2031-02-06', '2032-02-25', '2033-02-14',
      '2034-03-05', '2035-02-22', '2036-02-11', '2037-03-01', '2038-02-18', '2039-02-07', '2040-02-26'],
    dragon: ['2027-06-09', '2028-05-28', '2029-06-16', '2030-06-05', '2031-06-24', '2032-06-12', '2033-06-01',
      '2034-06-20', '2035-06-10', '2036-05-30', '2037-06-18', '2038-06-07', '2039-05-27', '2040-06-14'],
    qixi: ['2026-08-19', '2027-08-08', '2028-08-26', '2029-08-16', '2030-08-05', '2031-08-24', '2032-08-12',
      '2033-08-01', '2034-08-20', '2035-08-10', '2036-08-28', '2037-08-17', '2038-08-07', '2039-08-26', '2040-08-14'],
    ghost: ['2026-08-27', '2027-08-16', '2028-09-03', '2029-08-24', '2030-08-13', '2031-09-01', '2032-08-20',
      '2033-08-09', '2034-08-28', '2035-08-18', '2036-09-05', '2037-08-25', '2038-08-15', '2039-09-03', '2040-08-22'],
    midautumn: ['2026-09-25', '2027-09-15', '2028-10-03', '2029-09-22', '2030-09-12', '2031-10-01', '2032-09-19',
      '2033-09-08', '2034-09-27', '2035-09-16', '2036-10-04', '2037-09-24', '2038-09-13', '2039-10-02', '2040-09-20'],
    chongyang: ['2026-10-18', '2027-10-08', '2028-10-26', '2029-10-16', '2030-10-05', '2031-10-24', '2032-10-12',
      '2033-10-01', '2034-10-20', '2035-10-09', '2036-10-27', '2037-10-17', '2038-10-07', '2039-10-26', '2040-10-14'],
    laba: ['2027-01-15', '2028-01-04', '2029-01-22', '2030-01-11', '2031-01-01', '2032-01-20', '2033-01-08',
      '2034-01-27', '2035-01-16', '2036-01-05', '2037-01-23', '2038-01-12', '2039-01-02', '2040-01-21'],
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
