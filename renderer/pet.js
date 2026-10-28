'use strict';
/* Claude 桌宠 — renderer: animation, physics, interaction */
(() => {
  const P = window.pet;
  const L = window.LINES;
  const canvas = document.getElementById('c');
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const bubbleEl = document.getElementById('bubble');
  const bubbleText = document.getElementById('bubble-text');
  const bubbleSticker = document.getElementById('bubble-sticker');
  function showSticker(list) {
    const st = list && list[0];
    if (!st) { bubbleSticker.hidden = true; bubbleSticker.removeAttribute('src'); return; }
    bubbleSticker.hidden = true;
    let triedRemote = false;
    bubbleSticker.onload = () => { bubbleSticker.hidden = false; placeBubble(); };
    bubbleSticker.onerror = () => {
      if (!triedRemote && st.remote) { triedRemote = true; bubbleSticker.src = st.remote; return; }
      bubbleSticker.hidden = true; placeBubble();
    };
    bubbleSticker.src = st.url;
    bubbleSticker.alt = st.alt || '';
  }

  const rand = (a, b) => a + Math.random() * (b - a);
  const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const now = () => performance.now() / 1000;

  // ---------------- assets ----------------
  let M = null;               // manifest
  const views = {};           // name -> { imgs[], feetX, feetY, headTop, facing, fps }
  const has = (n) => !!views[n];
  const firstView = (...names) => names.find(has);
  const scaleOf = (v) => S / (v.res || 1);
  function anchorOf(v, frame) {
    const fx = Array.isArray(v.feetX) ? (v.feetX[frame] ?? v.feetX[0]) : v.feetX;
    const fy = Array.isArray(v.feetY) ? (v.feetY[frame] ?? v.feetY[0]) : v.feetY;
    return { fx, fy };
  }

  async function loadAssets() {
    const res = await fetch('../assets/pet/pet.json');
    M = await res.json();
    const jobs = [];
    for (const [name, v] of Object.entries(M.views)) {
      const imgs = v.frames.map((f) => {
        const im = new Image();
        im.src = '../assets/pet/' + f;
        jobs.push(im.decode().catch(() => {}));
        return im;
      });
      views[name] = { ...v, imgs };
    }
    await Promise.all(jobs);
  }

  // ---------------- layout ----------------
  let cfg = { height: 200, walk: true };
  let W = 250, H = 310, dpr = 1, S = 0.45;   // window size, device ratio, sprite scale
  // maid outfit: transparent video clips instead of sprites (renderer/clips.js)
  const C = window.Clips;
  let maid = false, CM = null, CS = 1;        // on/off, clip manifest, clip scale
  const FOOT = 6;                             // feet distance from window bottom
  function layout() {
    W = window.innerWidth; H = window.innerHeight;
    dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    S = cfg.height / (M ? M.baseHeight : 439);
    CS = CM ? cfg.height / (CM.feetY - CM.headTop) : 1;
  }
  window.addEventListener('resize', layout);

  // ---------------- world / window position ----------------
  const pos = { x: 0, y: 0 };      // window top-left in screen coords (float)
  const vel = { x: 0, y: 0 };
  let wa = { x: 0, y: 0, width: 1440, height: 900 };
  let sentX = null, sentY = null;
  function pushPos() {
    if (!Number.isFinite(pos.x) || !Number.isFinite(pos.y)) {
      // something produced a bad number: drop the motion and resync with the real window
      vel.x = 0; vel.y = 0; theta = 0; omega = 0; squash = 0; squashV = 0;
      syncBounds(true).catch(() => {});
      return;
    }
    const rx = Math.round(pos.x), ry = Math.round(pos.y);
    if (rx !== sentX || ry !== sentY) { sentX = rx; sentY = ry; P.setPos(rx, ry); }
  }
  const groundY = () => wa.y + wa.height - H;
  const minX = () => wa.x - W / 2 + 40;
  const maxX = () => wa.x + wa.width - W / 2 - 40;

  async function syncBounds(force) {
    const r = await P.getBounds();
    if (!r) return;
    wa = r.workArea;
    const b = r.bounds;
    if (force || (!dragging && (Math.abs(b.x - pos.x) > 3 || Math.abs(b.y - pos.y) > 3))) {
      pos.x = b.x; pos.y = b.y; sentX = b.x; sentY = b.y;
    }
  }

  // ---------------- state ----------------
  let state = 'idle', stateT = 0, stateDur = 4;
  let dir = -1;                 // -1 left, +1 right
  let lookDir = -1;
  let walkDist = 0;
  let lastInteract = now();
  let sleeping = false;
  let jumpT = -1;               // >=0 while jumping (seconds)
  let happyUntil = 0;
  let pokeTimes = [];
  let patTimes = [], lastPatDirX = 0, lastPatSampleX = null;
  let blinkAt = now() + rand(2, 5), blinkUntil = 0;
  let squash = 0, squashV = 0;  // spring for squash & stretch
  let theta = 0, omega = 0;     // dangle pendulum
  let grab = { x: 0, y: 0 };
  let dragging = false, pressed = null;
  let dragSamples = [];
  let lastNudge = now();
  let nextIdleTalk = now() + rand(150, 300);
  let zTimer = 0, heartTimer = 0, sweatTimer = 0;
  let sitFlip = 1;
  let aiStreaming = false;
  const V = window.petVoice || null;   // her voice (renderer/voice.js)
  let talkAmp = 0;
  let aiOn = false;
  let fallFlip = 1;

  function setState(s, dur) {
    if (maid && CM) {
      // the maid clips have their own versions of these
      if (s === 'wave') return setAct('act', pick(CM.greet));
      if (s === 'stretch') return setAct('act', pick(CM.rest));
      if (s === 'sit') return setAct('act', C.roll().clip || CM.idle);
    }
    state = s; stateT = 0; stateDur = dur ?? 4;
    if (s === 'walk') { walkDist = 0; }
    // Claude outfit: waving, sulking and stretching have clips; the state lasts as long as the clip
    if (!maid && (s === 'wave' || s === 'sulk' || s === 'stretch')) {
      const list = CCM ? { wave: CCM.greet, sulk: CCM.sulk && [CCM.sulk], stretch: CCM.rest }[s] : null;
      ccAct = list && list.length ? pick(list) : '';
      if (ccAct) { CC.play(ccAct, { restart: true }); stateDur = Math.max(stateDur, CC.dur(ccAct) - 0.12); }
    }
  }
  // play a one-off clip as a state that lasts as long as the clip
  let actClip = '', actFrom = 0;
  function setAct(s, clip, from = 0) {
    if (!clip) { state = 'idle'; stateT = 0; stateDur = 4; return; }
    actClip = clip; actFrom = from;
    C.play(clip, { from, restart: true });
    state = s; stateT = 0; stateDur = Math.max(1, C.dur(clip) - from - 0.12);
  }
  let aiTalkUntil = 0;     // she is "saying" something in the bubble (used to pick a talking clip)
  // which clip goes with what she is doing right now
  function maidClip() {
    const talking = (V && V.speaking) || now() < aiTalkUntil;
    switch (state) {
      case 'drag': case 'fall': return C.play(CM.drag, { loop: true });
      case 'sleep': return C.play(CM.sleep, { loop: true });
      case 'pat': return C.play(CM.pat, { loop: true });
      case 'think': return C.play(lookingScreen ? CM.looking : aiStreaming ? CM.working : CM.think, { loop: true });
      case 'walk': return C.play(CM.walk[0], { loop: true });
      case 'act': case 'look': case 'sulk': return C.play(actClip, { from: actFrom });
      default:
        if (talking && talkClip) return C.play(talkClip, { loop: true });
        if (aiStreaming) return C.play(CM.working, { loop: true });
        return C.play(CM.idle, { loop: true });
    }
  }
  let talkClip = '', lookingScreen = false;

  // ---------------- muttering (碎碎念) ----------------
  // off | canned (fixed lines) | mix (+ an AI line now and then) | ai (AI most of the time); main rate-limits the AI
  let whisperMode = 'canned', CL = null, lineToken = 0, lastClipLineAt = 0;
  const whisperGap = () => (whisperMode === 'off' ? 1e9 : whisperMode === 'ai' ? rand(240, 360) : rand(360, 600));
  const bubbleBusy = () => now() < aiTalkUntil || aiStreaming || state === 'think' || (V && V.speaking);
  async function whisperLine(action, canned) {
    if (whisperMode === 'mix' || whisperMode === 'ai') {
      try { const r = await P.whisperAI({ action }); if (r && r.ok && r.text) return r.text; } catch (_) {}
    }
    return canned || '';
  }
  // something to say while a maid clip plays: the clip's own lines, or an AI line for the talking ones
  function clipLine(clip) {
    if (whisperMode === 'off' || !CL) return;
    const token = ++lineToken;
    const still = () => lineToken === token && actClip === clip && (state === 'act' || state === 'look') && !bubbleBusy();
    const seq = CL.seq && CL.seq[clip];
    if (seq) { for (const [sec, txt] of seq) setTimeout(() => { if (still()) say(txt, 2400); }, sec * 1000); return; }
    const talky = (CL.talk || []).includes(clip);
    const lines = CL.lines && CL.lines[clip];
    if (!talky && (!lines || Math.random() > 0.3 || now() - lastClipLineAt < 40)) return;
    lastClipLineAt = now();
    const canned = lines ? pick(lines) : pick(L.whisperMaid.concat(L.whisper));
    const ask = talky && whisperMode !== 'canned' ? whisperLine(clip, canned) : Promise.resolve(canned);
    ask.then((txt) => setTimeout(() => { if (txt && still()) say(txt); }, 600));
  }
  // every few minutes she mutters something on her own
  async function idleWhisper() {
    nextIdleTalk = now() + whisperGap();
    if (whisperMode === 'off' || bubbleHideAt || bubbleBusy()) return;
    const pool = maid ? L.whisperMaid.concat(L.whisper) : L.idle.concat(L.whisper);
    const canned = pick(pool);
    const txt = await whisperLine(maid ? '在桌面上发呆碎碎念' : '', canned);
    if (!txt || bubbleHideAt || bubbleBusy() || ['sleep', 'drag', 'fall'].includes(state)) return;
    if (maid && CM) {
      if (state !== 'idle') return;
      talkClip = pick(CM.talk);
      aiTalkUntil = now() + clamp(Array.from(txt).length * 0.25 + 3, 4, 10);
      say(txt);
      return;
    }
    if (CCM && CCM.talk && state === 'idle') aiTalkUntil = now() + clamp(Array.from(txt).length * 0.25 + 3, 4, 10);
    say(txt);
    if (txt.includes('伸懒腰') && has('stretch')) setState('stretch', 2.6);
    else if (Math.random() < 0.3 && has('wave') && state === 'idle') setState('wave', 2.2);
  }

  function interact() { lastInteract = now(); }

  // ---------------- speech bubble ----------------
  let bubbleHideAt = 0, typing = null;
  function say(text, ms) {
    if (!text) return;
    showSticker(null);
    clearInterval(typing);
    bubbleText.textContent = '';
    bubbleEl.classList.remove('hidden');
    let i = 0;
    const chars = Array.from(text);
    typing = setInterval(() => {
      i++;
      bubbleText.textContent = chars.slice(0, i).join('');
      placeBubble();
      if (i >= chars.length) clearInterval(typing);
    }, 45);
    bubbleHideAt = now() + (ms ?? Math.max(2.6, chars.length * 0.18 + 1.6));
    placeBubble();
    if (!(V && V.speaking)) P.speakLine(text);   // never talk over her own AI reply
  }
  function sayLive(text, holdSec) {
    clearInterval(typing);
    showSticker(null);
    bubbleText.style.display = '';
    bubbleEl.classList.remove('hidden');
    bubbleText.textContent = text;
    bubbleHideAt = now() + (holdSec ?? 30);
    placeBubble();
  }
  const shorten = (t, n = 90) => { const a = Array.from(t.replace(/\s+/g, ' ').trim()); return a.length > n ? a.slice(0, n - 1).join('') + '…' : a.join(''); };
  function hideBubble() { bubbleEl.classList.add('hidden'); bubbleHideAt = 0; clearInterval(typing); showSticker(null); }
  function headTopY() {
    if (claudeVideo() && state !== 'drag') return H - FOOT - cfg.height + 4;   // clips are drawn head-to-feet = cfg.height
    if (maid && CM) {
      if (state === 'drag') return grab.y + 4 - drawOffY;
      return H - FOOT - (CM.feetY - CM.headTop) * CS + 4;
    }
    const v = views[currentViewName] || views.front;
    if (state === 'drag' && v.hangY !== undefined) return grab.y + 4 - drawOffY;
    const { fy } = anchorOf(v, currentFrame);
    return H - FOOT - (fy - (v.headTop || 0)) * scaleOf(v) + 6;
  }
  function placeBubble() {
    const bw = bubbleEl.offsetWidth, bh = bubbleEl.offsetHeight;
    const cx = W / 2 + drawOffX;
    let left = clamp(cx - bw / 2, 6, W - bw - 6);
    let top = Math.max(4, headTopY() + drawOffY - bh - 10);
    bubbleEl.style.left = left + 'px';
    bubbleEl.style.top = top + 'px';
    bubbleEl.style.setProperty('--tail-x', clamp(cx - left, 14, bw - 14) + 'px');
  }
  bubbleEl.addEventListener('mousedown', (e) => { e.stopPropagation(); hideBubble(); if (V && V.speaking) V.stop(); });

  // ---------------- particles ----------------
  const parts = [];
  function spawn(type, x, y, o = {}) {
    parts.push({ type, x, y, vx: o.vx ?? rand(-12, 12), vy: o.vy ?? rand(-45, -30), life: 0, max: o.max ?? 1.4, size: o.size ?? 1, rot: rand(-0.3, 0.3) });
  }
  function headPoint() {
    return { x: W / 2 + drawOffX, y: headTopY() + drawOffY + 30 * (S / 0.45) };
  }
  function drawHeart(x, y, s, a) {
    ctx.save(); ctx.globalAlpha = a; ctx.translate(x, y); ctx.scale(s, s);
    ctx.beginPath();
    ctx.moveTo(0, 4);
    ctx.bezierCurveTo(-8, -2, -5, -9, 0, -4.5);
    ctx.bezierCurveTo(5, -9, 8, -2, 0, 4);
    ctx.fillStyle = '#ff7aa2'; ctx.fill();
    ctx.lineWidth = 1.1; ctx.strokeStyle = '#d94a7a'; ctx.stroke();
    ctx.restore();
  }
  function drawSweat(x, y, s, a) {
    ctx.save(); ctx.globalAlpha = a; ctx.translate(x, y); ctx.scale(s, s);
    ctx.beginPath();
    ctx.moveTo(0, -6);
    ctx.bezierCurveTo(4, 0, 4, 4, 0, 4.5);
    ctx.bezierCurveTo(-4, 4, -4, 0, 0, -6);
    ctx.fillStyle = '#9fd4ff'; ctx.fill();
    ctx.lineWidth = 1; ctx.strokeStyle = '#4a86c5'; ctx.stroke();
    ctx.restore();
  }
  function drawGlyph(ch, x, y, s, a, color) {
    ctx.save(); ctx.globalAlpha = a; ctx.translate(x, y); ctx.scale(s, s);
    ctx.font = 'bold 15px "Avenir Next", "Segoe UI", sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(255,255,255,0.95)';
    ctx.strokeText(ch, 0, 0);
    ctx.fillStyle = color; ctx.fillText(ch, 0, 0);
    ctx.restore();
  }
  function updateParticles(dt) {
    for (let i = parts.length - 1; i >= 0; i--) {
      const p = parts[i];
      p.life += dt;
      if (p.life >= p.max) { parts.splice(i, 1); continue; }
      p.x += p.vx * dt; p.y += p.vy * dt;
      if (p.type === 'z') p.vx = 10 + Math.sin(p.life * 3) * 8;
      if (p.type === 'sweat') p.vy += 60 * dt;
    }
  }
  function drawParticles() {
    const k = S / 0.45;
    for (const p of parts) {
      const t = p.life / p.max;
      const a = t < 0.15 ? t / 0.15 : 1 - Math.max(0, (t - 0.6) / 0.4);
      const s = k * p.size * (0.7 + 0.5 * Math.min(1, t * 3));
      if (p.type === 'heart') drawHeart(p.x, p.y, s * 1.3, a);
      else if (p.type === 'z') drawGlyph('Z', p.x, p.y, s * (0.8 + t * 0.6), a, '#5b78c7');
      else if (p.type === 'note') drawGlyph('♪', p.x, p.y, s * 1.1, a, '#e88b3a');
      else if (p.type === 'sweat') drawSweat(p.x, p.y, s * 1.2, a);
    }
  }

  // ---------------- view selection & drawing ----------------
  let currentViewName = 'front';
  let currentFrame = 0;
  let drawOffX = 0, drawOffY = 0;

  function chooseView(t) {
    // returns { name, frame, flip }
    const eyesHappy = now() < happyUntil;
    if (state === 'drag') {
      const n = firstView('dangle', 'front');
      return { name: n, frame: 0, flip: 1 };
    }
    if (state === 'fall') return { name: (stateT > 0.12 || vel.y < -50) ? firstView('fall', 'front') : 'front', frame: 0, flip: fallFlip };
    if (state === 'wave' && has('wave')) return { name: 'wave', frame: frameFor('wave', t, 4), flip: 1 };
    if (state === 'stretch' && has('stretch')) return { name: 'stretch', frame: 0, flip: 1 };
    if (state === 'sleep') {
      const n = firstView('sleep', 'front_closed');
      return { name: n, frame: frameFor(n, t, 2), flip: 1 };
    }
    if (state === 'sulk') {
      const n = (has('angry') && stateT < 2.2) ? 'angry' : 'back';
      return { name: n, frame: frameFor(n, t, 22), flip: 1 };
    }
    if (state === 'walk') {
      const n = firstView('walk', 'side');
      const v = views[n];
      const facingLeft = (v.facing || 'left') === 'left';
      const flip = (dir > 0) === facingLeft ? -1 : 1;
      let frame;
      if (n === 'walk') frame = Math.floor(walkDist / (7.5 * S / 0.45)) % v.imgs.length;
      else frame = frameFor(n, t, 15);
      return { name: n, frame, flip };
    }
    if (state === 'sit' && has('sit')) return { name: 'sit', frame: 0, flip: sitFlip };
    if (state === 'think') return { name: firstView('think', 'front'), frame: 0, flip: 1 };
    if (state === 'look') {
      const v = views.side;
      const facingLeft = (v.facing || 'left') === 'left';
      return { name: 'side', frame: frameFor('side', t, 9), flip: (lookDir > 0) === facingLeft ? -1 : 1 };
    }
    if (eyesHappy || state === 'pat') {
      const n = firstView('happy', 'front_happy');
      return { name: n, frame: 0, flip: 1 };
    }
    // idle: blink
    const tt = now();
    if (tt >= blinkAt) {
      blinkUntil = tt + 0.11;
      blinkAt = tt + (Math.random() < 0.2 ? 0.25 : rand(2.2, 6));
    }
    if (tt < blinkUntil) return { name: 'front_closed', frame: 0, flip: 1 };
    return { name: 'front', frame: 0, flip: 1 };
  }

  function frameFor(name, t, fps) {
    const v = views[name];
    if (!v || v.imgs.length <= 1) return 0;
    return Math.floor(t * (v.fps || fps)) % v.imgs.length;
  }

  function render(t) {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';

    if (maid && CM) { renderMaid(t); return; }
    if (claudeVideo()) { if (renderClaudeVideo(t)) return; }
    else if (CCM && CC.active()) CC.stopAll();
    const sel = chooseView(t);
    currentViewName = sel.name;
    currentFrame = sel.frame;
    const v = views[sel.name];
    const img = v.imgs[sel.frame] || v.imgs[0];
    const sv = scaleOf(v);
    const anc = anchorOf(v, sel.frame);

    // procedural motion
    let offX = 0, offY = 0, rot = 0, skew = 0;
    let sx = 1, sy = 1;
    const k = S / 0.45;
    if (state === 'idle' || state === 'look' || state === 'pat' || state === 'sit' || state === 'think') {
      const br = Math.sin(t * 2 * Math.PI / 3.2);
      sy *= 1 + br * 0.012; sx *= 1 - br * 0.006;
      skew = Math.sin(t * 2 * Math.PI / 5.3) * 0.012;
      if (state === 'pat') { rot = Math.sin(t * 9) * 0.035; }
    } else if (state === 'sleep') {
      const br = Math.sin(t * 2 * Math.PI / 4.2);
      sy *= 1 + br * 0.02; sx *= 1 - br * 0.01;
      if (sel.name === 'front_closed') { offY += 3 * k; rot = 0.03; }
    } else if (state === 'walk') {
      const ph = walkDist / (24 * k);
      if (sel.name === 'walk') {
        offY -= Math.abs(Math.sin(Math.PI * walkDist / (15 * k))) * 1.5 * k;
      } else {
        offY -= Math.abs(Math.sin(Math.PI * ph)) * 5 * k;
        rot = Math.sin(2 * Math.PI * ph) * 0.04;
      }
    } else if (state === 'sulk') {
      const br = Math.sin(t * 7);
      sy *= 1 + br * 0.01;
      offX += Math.sin(t * 31) * (t < 0.6 ? 1.5 : 0) * k;
    } else if (state === 'wave') {
      rot = Math.sin(stateT * 9) * 0.035;
      const br = Math.sin(t * 2 * Math.PI / 3.2);
      sy *= 1 + br * 0.01;
    } else if (state === 'stretch') {
      const p = clamp(stateT / stateDur, 0, 1);
      sy *= 1 + Math.sin(Math.PI * p) * 0.035; sx *= 1 - Math.sin(Math.PI * p) * 0.015;
    } else if (state === 'fall') {
      rot = (sel.name === 'fall' ? 0 : clamp(vel.x / 3000, -0.25, 0.25)) + Math.sin(t * 12) * 0.04;
    }
    if (jumpT >= 0) {
      const J = 0.42;
      if (jumpT < J) offY -= Math.sin(Math.PI * jumpT / J) * 22 * k;
    }
    // talking: a little bounce that follows how loud she is
    if (talkAmp > 0.01 && state !== 'drag' && state !== 'fall' && state !== 'sleep') {
      sy *= 1 + talkAmp * 0.035; sx *= 1 - talkAmp * 0.015;
      offY -= talkAmp * 2.2 * k;
    }
    // squash & stretch spring
    sy *= 1 - squash; sx *= 1 + squash * 0.6;

    drawOffX = offX; drawOffY = offY;
    const ax = W / 2 + offX, ay = H - FOOT + offY;

    ctx.save();
    if (state === 'drag' && v.hangX !== undefined) {
      // held by the hood: hang point stays under the cursor, body swings below
      ctx.translate(grab.x, grab.y);
      ctx.rotate(theta);
      const kick = Math.sin(t * 11) * 0.012;
      ctx.scale(sv * (1 + kick), sv * (1 - kick));
      ctx.drawImage(img, -v.hangX, -v.hangY);
    } else {
      if (state === 'drag') {
        // pendulum around the grab point
        ctx.translate(grab.x, grab.y);
        ctx.rotate(theta);
        ctx.translate(-grab.x, -grab.y);
      }
      ctx.translate(ax, ay);
      ctx.rotate(rot);
      ctx.transform(1, 0, skew, 1, 0, 0);
      ctx.scale(sx * sel.flip * sv, sy * sv);
      ctx.drawImage(img, -anc.fx, -anc.fy);
    }
    ctx.restore();

    drawParticles();
    if (bubbleHideAt) placeBubble();
  }

  function renderMaid(t) {
    C.tick();
    maidClip();
    renderClipLayers(C.layers(), CM, t);
  }
  // Claude outfit: our own clips where we have them; sprites for everything else (sleep, sit, drag, fall…)
  const CC = window.ClaudeClips;
  let CCM = null, ccAct = '';
  const ONE_SHOT = ['look', 'act', 'sulk', 'wave', 'stretch'];   // these play ccAct once; the rest loop
  function claudeClip() {   // which clip goes with what she is doing right now ('' = draw the sprite)
    if (maid || !CCM) return '';
    if (sleeping) return state === 'sleep' && CCM.sleep ? CCM.sleep : '';
    if (ONE_SHOT.includes(state)) return ccAct;
    const talking = (V && V.speaking) || now() < aiTalkUntil || aiStreaming;
    switch (state) {
      case 'idle': return talking && CCM.talk ? CCM.talk[0] : CCM.idle;
      case 'walk': return CCM.walk ? CCM.walk[0] : '';
      case 'think': return CCM.think || '';
      case 'pat': return CCM.pat || '';
      default: return '';
    }
  }
  const claudeVideo = () => !!claudeClip();
  // an occasional small action that fits the hour (clips.json "acts"); each one at most every 20 minutes
  const actAt = {};
  function claudeAct() {
    if (!CCM || !CCM.acts) return '';
    const h = new Date().getHours(), t = now();
    const ok = Object.entries(CCM.acts).filter(([name, a]) => t - (actAt[name] ?? -1e9) > 20 * 60
      && (!a.hours || a.hours.some(([from, to]) => h >= from && h < to)));
    if (!ok.length) return '';
    const name = pick(ok)[0];
    actAt[name] = t;
    return name;
  }
  function playClaudeAct(name, from = 0) {
    ccAct = name; CC.play(name, { from, restart: true }); setState('act', CC.dur(name) - from - 0.12);
  }
  function renderClaudeVideo(t) {
    CC.tick();
    const name = claudeClip();
    if (ONE_SHOT.includes(state)) CC.play(name); else CC.play(name, { loop: true });
    const layers = CC.layers();
    if (!layers.length) return false;          // first frame not decoded yet: draw the sprite meanwhile
    renderClipLayers(layers, CCM, t, state === 'walk' && dir > 0 ? -1 : 1);   // the walk clip faces left
    return true;
  }
  function renderClipLayers(layers, MM, t, flip = 1) {
    const k = S / 0.45;
    let offY = 0, rot = 0, sx = 1, sy = 1;
    if (state === 'fall') rot = clamp(vel.x / 3000, -0.25, 0.25) + Math.sin(t * 12) * 0.04;
    if (jumpT >= 0) { const J = 0.42; if (jumpT < J) offY -= Math.sin(Math.PI * jumpT / J) * 22 * k; }
    sy *= 1 - squash; sx *= 1 + squash * 0.6;
    drawOffX = 0; drawOffY = offY;
    const ax = W / 2, ay = H - FOOT + offY;
    if (talkAmp > 0.01 && !maid) { sy *= 1 + talkAmp * 0.035; sx *= 1 - talkAmp * 0.015; }
    const cs = cfg.height / (MM.feetY - MM.headTop);
    for (const L2 of layers) {
      ctx.save();
      ctx.globalAlpha = L2.a;
      if (state === 'drag' && MM.hang) {
        ctx.translate(grab.x, grab.y);
        ctx.rotate(theta);
        ctx.scale(cs, cs);
        ctx.drawImage(L2.v, -MM.hang[0], -MM.hang[1]);
      } else {
        ctx.translate(ax, ay);
        ctx.rotate(rot);
        ctx.scale(sx * cs * flip, sy * cs);
        ctx.drawImage(L2.v, -MM.feetX, -MM.feetY);
      }
      ctx.restore();
    }
    drawParticles();
    if (bubbleHideAt) placeBubble();
  }

  // ---------------- update / physics ----------------
  let prevVX = 0, smoothAX = 0;
  function update(dt) {
    const t = now();
    stateT += dt;
    if (jumpT >= 0) { jumpT += dt; if (jumpT > 0.42) { jumpT = -1; squashV += 2.2; } }

    // squash spring
    const kS = 260, cS = 16;
    squashV += (-kS * squash - cS * squashV) * dt;
    squash += squashV * dt;
    squash = clamp(squash, -0.18, 0.28);
    squashV = clamp(squashV, -12, 12);
    if (!Number.isFinite(squash) || !Number.isFinite(squashV)) { squash = 0; squashV = 0; }
    if (!Number.isFinite(vel.x) || !Number.isFinite(vel.y)) { vel.x = 0; vel.y = 0; }

    const talking = !!(V && V.speaking);
    talkAmp = V ? V.level() : 0;
    if (maid && CM && talking && (state === 'act' || state === 'look')) setState('idle', rand(3, 5));
    if (maid && CM && talking && !talkClip) talkClip = pick(CM.talk);
    if (maid && !talking && now() > aiTalkUntil) talkClip = '';
    if (talking && bubbleHideAt) bubbleHideAt = Math.max(bubbleHideAt, t + 1.2);
    if (bubbleHideAt && t > bubbleHideAt) hideBubble();

    const onGround = pos.y >= groundY() - 0.5;

    switch (state) {
      case 'drag': {
        const vx = (pos.x - (update._px ?? pos.x)) / Math.max(dt, 1e-3);
        const axr = (vx - prevVX) / Math.max(dt, 1e-3);
        prevVX = vx;
        smoothAX += (axr - smoothAX) * Math.min(1, dt * 12);
        const Lp = 95 * (S / 0.45);
        const alpha = -(1800 / Lp) * Math.sin(theta) - 3.2 * omega + (clamp(smoothAX, -9000, 9000) / Lp) * Math.cos(theta);
        omega += alpha * dt;
        theta = clamp(theta + omega * dt, -0.45, 0.45);
        sweatTimer -= dt;
        if (sweatTimer <= 0) { const h = headPoint(); spawn('sweat', h.x + 26 * (S / 0.45), h.y - 6, { vx: 8, vy: -20, max: 0.9 }); sweatTimer = rand(1.4, 2.6); }
        break;
      }
      case 'fall': {
        vel.y += 2100 * dt;
        vel.x *= Math.exp(-0.9 * dt);
        pos.x += vel.x * dt; pos.y += vel.y * dt;
        if (pos.x < minX()) { pos.x = minX(); vel.x = Math.abs(vel.x) * 0.5; }
        if (pos.x > maxX()) { pos.x = maxX(); vel.x = -Math.abs(vel.x) * 0.5; }
        if (pos.y >= groundY()) {
          pos.y = groundY();
          const impact = vel.y;
          squashV += clamp(impact / 450, 0.6, 3.2);
          if (impact > 650) {
            vel.y = -impact * 0.28; vel.x *= 0.6;
            if (!update._saidLand) { say(pick(L.dropHard)); update._saidLand = true; }
            spawn('sweat', W / 2 + 30 * (S / 0.45), headPoint().y, { vx: 12, vy: -50, max: 0.9 });
          } else {
            vel.x = 0; vel.y = 0;
            if (!update._saidLand && Math.random() < 0.5) say(pick(L.dropSoft));
            update._saidLand = false;
            setState('idle', rand(2, 4));
          }
        }
        break;
      }
      case 'walk': {
        if (!onGround) { vel.x = 0; vel.y = 0; setState('fall'); break; }
        const speed = 42 * (S / 0.45);
        pos.x += dir * speed * dt;
        walkDist += speed * dt;
        if (pos.x < minX()) { pos.x = minX(); dir = 1; }
        if (pos.x > maxX()) { pos.x = maxX(); dir = -1; }
        if (stateT > stateDur || !cfg.walk) setState('idle', rand(3, 7));
        break;
      }
      case 'sleep': {
        zTimer -= dt;
        // the Claude sleep clip has its own Z's
        if (zTimer <= 0 && !maid && !claudeVideo()) { const h = headPoint(); spawn('z', h.x + 24 * (S / 0.45), h.y - 8, { vx: 10, vy: -16, max: 2.4, size: rand(0.8, 1.15) }); zTimer = rand(1.3, 1.9); }
        if (!onGround) { pos.y = Math.min(pos.y + 600 * dt, groundY()); }
        break;
      }
      case 'pat': {
        heartTimer -= dt;
        // the Claude pat clip has its own hearts
        if (heartTimer <= 0 && !claudeVideo()) { const h = headPoint(); spawn('heart', h.x + rand(-28, 28) * (S / 0.45), h.y - 4, { max: 1.3 }); heartTimer = rand(0.25, 0.45); }
        if (t - (patTimes[patTimes.length - 1] || 0) > 1.3) { setState('idle', rand(2, 4)); happyUntil = t + 0.8; }
        break;
      }
      case 'sulk': {
        if (stateT > stateDur) { setState('idle', rand(3, 5)); say(pick(L.forgive)); happyUntil = t + 1.2; }
        break;
      }
      case 'look': {
        if (stateT > stateDur) setState('idle', rand(2, 5));
        break;
      }
      case 'think': {
        if (!onGround) { vel.x = 0; vel.y = 0; update._saidLand = true; setState('fall'); break; }
        if (!aiStreaming) {
          const dots = '…'.repeat(1 + (Math.floor(stateT * 2.5) % 3));
          if (bubbleText.textContent !== '嗯' + dots) sayLive('嗯' + dots, 5);
        }
        if (stateT > 120) setState('idle', rand(2, 4));
        break;
      }
      case 'act': {
        if (!onGround) { vel.x = 0; vel.y = 0; update._saidLand = true; setState('fall'); break; }
        if (stateT > stateDur || (stateT > 0.5 && (maid ? C : CC).ended())) {
          if (lookingScreen) setState('think', 1e9);
          else setState('idle', rand(2, 4));
        }
        break;
      }
      case 'wave':
      case 'stretch': {
        if (!onGround) { vel.x = 0; vel.y = 0; update._saidLand = true; setState('fall'); break; }
        if (stateT > stateDur) setState('idle', rand(2, 5));
        break;
      }
      case 'sit': {
        if (!onGround) { vel.x = 0; vel.y = 0; update._saidLand = true; setState('fall'); break; }
        if (stateT > stateDur) {
          const idleFor = t - lastInteract;
          if (idleFor > 6 * 60 && Math.random() < 0.6) { goSleep(); break; }
          setState('idle', rand(2, 4)); jumpT = 0; squashV -= 0.8;
        }
        if (t > nextIdleTalk) idleWhisper();
        break;
      }
      case 'idle':
      default: {
        if (!onGround) { vel.x = 0; vel.y = 0; update._saidLand = true; setState('fall'); break; }
        if (stateT > stateDur && jumpT < 0) {
          const idleFor = t - lastInteract;
          const hour = new Date().getHours();
          const night = hour >= 0 && hour < 6;
          if ((idleFor > 8 * 60 || (night && idleFor > 3 * 60)) && Math.random() < 0.45) { goSleep(); break; }
          if (maid && CM) {
            if ((V && V.speaking) || now() < aiTalkUntil) { stateDur = stateT + 2; break; }
            const pickd = C.roll();
            if (pickd.kind === 'act') { setAct('act', pickd.clip); clipLine(pickd.clip); }
            else if (pickd.kind === 'turn') { setAct('look', pickd.clip); clipLine(pickd.clip); }
            else if (pickd.kind === 'move' && cfg.walk) { dir = Math.random() < 0.5 ? -1 : 1; setState('walk', rand(4, 9)); }
            else setState('idle', C.dur(CM.idle));
            break;
          }
          if (CCM && CCM.talk && ((V && V.speaking) || now() < aiTalkUntil)) { stateDur = stateT + 2; break; }   // keep the talking clip on
          const r = Math.random();
          let act;
          if (cfg.walk && r < 0.45) { dir = Math.random() < 0.5 ? -1 : 1; setState('walk', rand(3, 9)); }
          else if (r < 0.6) {
            lookDir = Math.random() < 0.5 ? -1 : 1;
            if (CCM && CCM.turn && CCM.turn.length) { ccAct = pick(CCM.turn); CC.play(ccAct, { restart: true }); setState('look', CC.dur(ccAct) - 0.12); }
            else { ccAct = ''; setState('look', rand(1.4, 2.6)); }
          }
          else if (r < 0.68 && (act = claudeAct())) playClaudeAct(act);
          else if (r < 0.78 && has('sit')) { sitFlip = 1; setState('sit', rand(12, 40)); squashV += 1.2; }
          else setState('idle', rand(3, 7));
        }
        if (t > nextIdleTalk) idleWhisper();
        break;
      }
    }
    update._px = pos.x;
    if (state !== 'drag') { theta *= Math.exp(-6 * dt); omega = 0; }
    updateParticles(dt);
    if (!dragging) pushPos();
  }

  function goSleep() {
    if (state === 'drag') return;
    sleeping = true; P.sleepState(true);
    setState('sleep', 1e9);
    say(pick(L.sleep), 2600);
    zTimer = 0.6;
  }
  function wake(text) {
    if (!sleeping) return;
    sleeping = false; P.sleepState(false);
    if (maid && CM) { setAct('act', CM.sleep, 7.4); interact(); say(text || pick(L.wake)); return; }
    if (CCM && CCM.sleep && CCM.wakeFrom) playClaudeAct(CCM.sleep, CCM.wakeFrom);   // the end of the sleep clip: she stands up
    else if (has('stretch')) { setState('stretch', 2.4); }
    else { setState('idle', rand(3, 5)); jumpT = 0; squashV -= 1.2; }
    interact();
    say(text || pick(L.wake));
  }

  // ---------------- reactions ----------------
  function onClick() {
    interact();
    const t = now();
    if (state === 'sleep') { wake(); return; }
    if (state === 'sulk') { say('哼！'); stateDur = Math.max(stateDur, stateT + 2.5); return; }
    pokeTimes = pokeTimes.filter((x) => t - x < 3).concat(t);
    if (pokeTimes.length >= 5) {
      pokeTimes = [];
      if (maid && CM) setAct('sulk', CM.sulk); else setState('sulk', 4.5);
      say(pick(L.sulk));
      spawn('sweat', headPoint().x + 26 * (S / 0.45), headPoint().y, { vx: 10, vy: -40, max: 1 });
      return;
    }
    if (maid && CM) {
      if (state === 'sulk') return;
      setAct('act', pick(CM.clicks.filter((c) => c !== actClip)));
      squashV -= 0.8;
      const h0 = headPoint();
      for (let i = 0; i < 2; i++) spawn(Math.random() < 0.6 ? 'heart' : 'note', h0.x + rand(-24, 24) * (S / 0.45), h0.y, {});
      say(pick(L.click));
      return;
    }
    if (CCM && CCM.clicks && CCM.clicks.length && ['idle', 'walk', 'look', 'sit', 'wave', 'stretch', 'act'].includes(state)) {
      ccAct = pick(CCM.clicks); CC.play(ccAct, { restart: true }); setState('act', CC.dur(ccAct) - 0.12);   // the clip does the hop
    } else {
      if (['walk', 'look', 'sit', 'wave', 'stretch'].includes(state)) setState('idle', rand(3, 5));
      if (jumpT < 0) { jumpT = 0; squashV -= 1.6; }
    }
    happyUntil = t + 0.9;
    const h = headPoint();
    for (let i = 0; i < 2; i++) spawn(Math.random() < 0.6 ? 'heart' : 'note', h.x + rand(-24, 24) * (S / 0.45), h.y, {});
    say(pick(L.click));
  }

  function onPat() {
    interact();
    if (state === 'sleep') { wake('唔…摸头会醒的啦…'); return; }
    if (state === 'drag' || state === 'fall' || state === 'sulk') return;
    if (state !== 'pat') {
      setState('pat', 1e9);
      heartTimer = 0;
      if (!bubbleHideAt || Math.random() < 0.5) say(pick(L.pat));
    }
  }

  // ---------------- input ----------------
  let ignoring = true;
  let lastMouse = { x: -1, y: -1 };
  function alphaAt(x, y) {
    if (x < 0 || y < 0 || x >= W || y >= H) return 0;
    try {
      const d = ctx.getImageData(Math.floor(x * dpr), Math.floor(y * dpr), 1, 1).data;
      return d[3];
    } catch (_) { return 255; }
  }
  function overBubble(x, y) {
    if (bubbleEl.classList.contains('hidden')) return false;
    const r = bubbleEl.getBoundingClientRect();
    return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
  }
  function hitTest(x, y) {
    if (overBubble(x, y)) return true;
    // a small cross pattern makes thin parts (ahoge, tail) easier to grab
    return alphaAt(x, y) > 30 || alphaAt(x + 2, y) > 30 || alphaAt(x - 2, y) > 30 || alphaAt(x, y + 2) > 30;
  }
  function setIgnore(v) {
    if (v === ignoring) return;
    ignoring = v;
    P.ignoreMouse(v);
  }

  window.addEventListener('mousemove', (e) => {
    const x = e.clientX, y = e.clientY;
    lastMouse = { x, y };
    if (pressed) {
      const dx = e.screenX - pressed.sx, dy = e.screenY - pressed.sy;
      if (!dragging && Math.hypot(dx, dy) > 4) startDrag(pressed.cx, pressed.cy);
      if (dragging) {
        pos.x = e.screenX - grab.x;
        pos.y = e.screenY - grab.y;
        if (Number.isFinite(pos.x) && Number.isFinite(pos.y)) { P.setPos(pos.x, pos.y); sentX = Math.round(pos.x); sentY = Math.round(pos.y); }
        dragSamples.push({ t: now(), x: e.screenX, y: e.screenY });
        if (dragSamples.length > 12) dragSamples.shift();
      }
      return;
    }
    const hit = hitTest(x, y);
    setIgnore(!hit);
    if (hit) detectPat(e, x, y);
  });

  function detectPat(e, x, y) {
    const top = headTopY() + drawOffY;
    const headBottom = top + (maid && CM ? (CM.feetY - CM.headTop) * CS : views.front.feetY * S) * 0.36;
    if (y < top - 4 || y > headBottom) { lastPatSampleX = null; return; }
    if (lastPatSampleX === null) { lastPatSampleX = x; return; }
    const dx = x - lastPatSampleX;
    if (Math.abs(dx) < 5) return;
    const d = Math.sign(dx);
    lastPatSampleX = x;
    if (d !== lastPatDirX) {
      lastPatDirX = d;
      const t = now();
      patTimes = patTimes.filter((p) => t - p < 1.4).concat(t);
      if (patTimes.length >= 4 || state === 'pat') onPat();
    }
  }

  window.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    if (!hitTest(e.clientX, e.clientY)) return;
    pressed = { sx: e.screenX, sy: e.screenY, cx: e.clientX, cy: e.clientY, t: now() };
    setIgnore(false);
  });

  function startDrag(cx, cy) {
    dragging = true;
    interact();
    if (sleeping) { sleeping = false; P.sleepState(false); }
    grab = { x: cx, y: cy };
    if (maid && CM) {
      const hx = W / 2, hy = Math.max(30, H - FOOT - (CM.feetY - CM.hang[1]) * CS);
      const sx = pos.x + cx, sy = pos.y + cy;
      grab = { x: hx, y: hy };
      pos.x = sx - hx; pos.y = sy - hy;
      P.setPos(pos.x, pos.y); sentX = Math.round(pos.x); sentY = Math.round(pos.y);
    } else if (has('dangle')) {
      // re-seat the window so the cursor is holding her hood
      const v = views.dangle, sv = scaleOf(v);
      const hx = W / 2, hy = Math.max(30, H - FOOT - (v.feetY - v.hangY) * sv);
      const sx = pos.x + cx, sy = pos.y + cy;     // cursor in screen coords
      grab = { x: hx, y: hy };
      pos.x = sx - hx; pos.y = sy - hy;
      P.setPos(pos.x, pos.y); sentX = Math.round(pos.x); sentY = Math.round(pos.y);
    }
    theta = 0; omega = 0; prevVX = 0; smoothAX = 0;
    jumpT = -1;
    dragSamples = [];
    setState('drag', 1e9);
    sweatTimer = 0.4;
    say(pick(L.drag), 2200);
  }

  function endPress(e) {
    if (!pressed) return;
    const wasDrag = dragging;
    pressed = null;
    if (wasDrag) {
      dragging = false;
      const t = now();
      const recent = dragSamples.filter((s) => t - s.t < 0.09);
      let vx = 0, vy = 0;
      if (recent.length >= 2) {
        const a = recent[0], b = recent[recent.length - 1];
        const dtt = Math.max(0.016, b.t - a.t);
        vx = (b.x - a.x) / dtt; vy = (b.y - a.y) / dtt;
      }
      vel.x = clamp(vx, -2200, 2200);
      vel.y = clamp(vy, -1600, 1600);
      fallFlip = vel.x > 150 ? -1 : 1;
      update._saidLand = false;
      setState('fall');
      syncBounds(false).catch(() => {});
    } else if (e && e.button === 0) {
      onClick();
    }
  }
  window.addEventListener('mouseup', endPress);
  window.addEventListener('blur', () => { if (dragging) endPress(null); });
  document.addEventListener('mouseleave', () => {
    if (!pressed) setIgnore(true);
    lastPatSampleX = null;
  });
  window.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    if (hitTest(e.clientX, e.clientY)) { interact(); P.contextMenu(); }
  });

  // when the pet walks away from a still cursor, release clicks again
  setInterval(async () => {
    if (ignoring || pressed) return;
    try {
      const c = await P.getCursor();
      const x = c.x - pos.x, y = c.y - pos.y;
      if (!hitTest(x, y)) setIgnore(true);
    } catch (_) {}
  }, 250);

  // ---------------- commands from menu / main ----------------
  P.onCmd((c) => {
    if (c === 'talk') {
      interact();
      if (sleeping) { wake(); return; }
      say(pick(L.idle.concat(L.click)));
      if (has('wave') && ['idle', 'look', 'walk'].includes(state)) setState('wave', 2.4);
      else happyUntil = now() + 1;
    }
    else if (c === 'sleep') { interact(); goSleep(); }
    else if (c === 'wake') wake();
    else if (c === 'dropped') { syncBounds(true).then(() => { update._saidLand = false; setState('fall'); }); }
    else if (c === 'display-changed') syncBounds(true);
  });
  P.onAi((ev) => {
    interact();
    if (ev.type === 'thinking') {
      aiStreaming = false;
      if (sleeping) { sleeping = false; P.sleepState(false); }
      if (state !== 'drag') setState('think', 1e9);
    } else if (ev.type === 'delta') {
      aiStreaming = true;
      if (state === 'think') setState('idle', 30);
      showSticker(null);
      sayLive(shorten(ev.text) || '…', 30);
    } else if (ev.type === 'done') {
      aiStreaming = false; lookingScreen = false;
      aiTalkUntil = now() + clamp(Array.from(ev.text || '').length * 0.22 + 2.5, 4, 14);
      if (maid && CM) talkClip = pick(CM.talk);
      if (state === 'think') setState('idle', rand(4, 7));
      const t = shorten(ev.text);
      sayLive(t, clamp(Array.from(t).length * 0.22 + 2.5 + (ev.stickers && ev.stickers.length ? 2 : 0), 4, 16));
      bubbleText.style.display = t ? '' : 'none';
      showSticker(ev.stickers);
      if (ev.remembered && ev.remembered.length) { const h = headPoint(); spawn('heart', h.x, h.y, { max: 1.3 }); }
      if (ev.remindSet && ev.remindSet.length) { const h = headPoint(); spawn('note', h.x + 18, h.y, { max: 1.4 }); spawn('note', h.x - 18, h.y - 4, { max: 1.4 }); }
    } else if (ev.type === 'proactive') {
      aiStreaming = false; lookingScreen = false;
      aiTalkUntil = now() + clamp(Array.from(ev.text || '').length * 0.25 + 3, 5, 14);
      if (maid && CM) talkClip = pick(CM.talk);
      if (state === 'think') setState('idle', rand(4, 7));
      const t = shorten(ev.text || '', ev.kind === 'lookAsk' ? 110 : 90);
      if (sleeping && ev.kind !== 'chat') { sleeping = false; P.sleepState(false); setState('idle', 3); }
      if (!['drag', 'fall'].includes(state)) {
        if ((ev.kind === 'startup' || ev.kind === 'return') && has('wave')) setState('wave', 2.8);
        else if ((ev.kind === 'rest' || ev.kind === 'night') && has('stretch')) setState('stretch', 2.6);
        else { happyUntil = now() + 1.2; if (state === 'sit' || state === 'walk') setState('idle', rand(4, 7)); }
      }
      sayLive(t, clamp(Array.from(t).length * 0.25 + 4, 6, 16));
      bubbleText.style.display = t ? '' : 'none';
      showSticker(ev.stickers);
      const h = headPoint(); spawn('note', h.x + 20, h.y, { max: 1.3 });
    } else if (ev.type === 'notice') {
      sayLive(ev.text || '', 8);
      happyUntil = now() + 1;
      if (ev.tier != null && !['drag', 'fall', 'sleep'].includes(state)) {
        if (maid && CM) setAct('act', CM.balance[clamp(ev.tier, 0, 5)]);
        else if (CCM && CCM.balance && CCM.balance[clamp(ev.tier, 0, 5)]) playClaudeAct(CCM.balance[clamp(ev.tier, 0, 5)]);
        else if (ev.tier >= 4) { spawn('sweat', headPoint().x + 26 * (S / 0.45), headPoint().y, { vx: 10, vy: -40, max: 1 }); }
      }
    } else if (ev.type === 'looking') {
      if (sleeping) { sleeping = false; P.sleepState(false); }
      lookingScreen = true;
      // Claude outfit: the magnifying glass first; the 'act' end goes on to thinking while she is still looking
      if (!maid && CCM && CCM.look && !['drag', 'fall'].includes(state)) playClaudeAct(CCM.look);
      else if (state !== 'drag') setState('think', 1e9);
      aiStreaming = true;
      sayLive('让我看看你在看什么…', 30);
    } else if (ev.type === 'reminder') {
      if (sleeping) { sleeping = false; P.sleepState(false); }
      if (!['drag', 'fall'].includes(state)) {
        if (maid && CM) setAct('act', CM.reminder);
        else if (CCM && CCM.reminder) playClaudeAct(CCM.reminder);
        else if (has('wave')) setState('wave', 4); else { happyUntil = now() + 2; jumpT = 0; }
      }
      const t = shorten(ev.text || '', 110);
      sayLive(t, 75);                      // stays up for a while; click the bubble to dismiss
      showSticker(ev.stickers);
      const h = headPoint();
      for (let i = 0; i < 3; i++) spawn('note', h.x + rand(-26, 26) * (S / 0.45), h.y - i * 6, { max: 1.6 });
    } else if (ev.type === 'proactive-failed') {
      if (ev.kind === 'startup') say(L.greet(new Date().getHours()), 4200);
    } else if (ev.type === 'error') {
      aiStreaming = false; lookingScreen = false;
      if (state === 'think') setState('idle', rand(3, 5));
      if (maid && CM && !['drag', 'fall', 'sleep'].includes(state)) setAct('act', CM.error);
      say(ev.code === 'nokey' ? '还没给我设置 API Key 呢…右键选「AI 设置」' : ev.code === 'look' ? '呜…没看清你的屏幕' : '呜…刚刚没接上话');
    }
  });
  window.addEventListener('dblclick', (e) => {
    if (hitTest(e.clientX, e.clientY)) P.openChat();
  });

  async function applyOutfit() {
    const want = cfg.outfit === 'maid';
    if (want && !CM) { try { CM = await C.load(); } catch (e) { console.warn('clips', e); } }
    if (!CCM) { try { CCM = await CC.load(); } catch (_) { CCM = null; } }
    if (want && !CL) { try { CL = await (await fetch('../assets/maid/lines.json')).json(); } catch (_) { CL = { talk: [], seq: {}, lines: {} }; } }
    const wm = cfg.whisper || 'canned';
    if (wm !== whisperMode) { whisperMode = wm; nextIdleTalk = Math.min(nextIdleTalk, now() + whisperGap()); }
    const was = maid;
    maid = want && !!CM;
    if (!maid && was) C.stopAll();
    if (maid !== was) { actClip = ''; talkClip = ''; if (!['drag', 'fall', 'sleep'].includes(state)) setState('idle', rand(2, 4)); }
    layout();
  }
  P.onSettings(async (s) => {
    cfg = { ...cfg, ...s };
    await applyOutfit();
    setTimeout(() => { layout(); syncBounds(true); }, 30);
  });

  // ---------------- main loop ----------------
  let last = performance.now(), lastRender = 0, t0 = now();
  function loop(ms) {
    const dt = Math.max(0, Math.min(0.05, (ms - last) / 1000));
    last = ms;
    update(dt);
    const lazy = maid
      ? !(state === 'drag' || state === 'fall' || jumpT >= 0 || parts.length)   // video runs at 24 fps anyway
      : claudeVideo() ? !(jumpT >= 0 || parts.length)
      : (state === 'sleep' || (state === 'idle' && jumpT < 0 && Math.abs(squash) < 0.002)) && parts.length === 0 && !bubbleHideAt && talkAmp < 0.01;
    if (!lazy || ms - lastRender > 33) { render(now() - t0); lastRender = ms; }
    requestAnimationFrame(loop);
  }

  async function boot() {
    await loadAssets();
    cfg = await P.getSettings();
    await applyOutfit();
    await syncBounds(true);
    setInterval(() => syncBounds(false).catch(() => {}), 2000);
    setInterval(() => { if (Math.abs((window.devicePixelRatio || 1) - dpr) > 0.01) layout(); }, 1000);
    if (pos.y < groundY() - 1) { update._saidLand = true; setState('fall'); }
    else setState('idle', rand(2, 4));
    requestAnimationFrame(loop);
    let aiGreet = false;
    try { aiGreet = await P.aiWillGreet(); } catch (_) {}
    aiOn = aiGreet;
    nextIdleTalk = now() + whisperGap();
    setTimeout(() => {
      if (aiGreet) { sayLive('…', 20); P.aiGreet(); }
      else say(L.greet(new Date().getHours()), 4200);
      if (has('wave') && state === 'idle') setState('wave', 2.8);
      else { happyUntil = now() + 1.2; jumpT = 0; }
    }, 600);
  }
  // small hook for automated checks
  window.__pet = {
    get state() { return state; },
    get pos() { return { ...pos }; },
    setState: (s, d) => setState(s, d), walk: (d) => { dir = d; setState('walk', 30); },
    look: (d) => { lookDir = d; setState('look', 30); },
    sleep: () => goSleep(), wake: () => wake(), click: () => onClick(), pat: () => onPat(), say,
    get clip() { return maid ? C.current() : ''; }, act: (c) => setAct('act', c), get maid() { return maid; },
    line: (c) => { setAct('act', c); clipLine(c); }, whisperNow: () => idleWhisper(), get bubble() { return bubbleEl.classList.contains('hidden') ? '' : bubbleText.textContent; },
    get whisperMode() { return whisperMode; },
    get claudeClip() { return claudeVideo() ? CC.current() : ''; },
    claudeAct: (c) => playClaudeAct(c),
    lookClip: () => { if (CCM) { ccAct = CCM.turn[0]; CC.play(ccAct, { restart: true }); setState('look', CC.dur(ccAct) - 0.12); } },
  };
  boot();
})();
