'use strict';
// Microphone recorder: 16 kHz mono Float32, for the offline SenseVoice recogniser.
window.Mic = (() => {
  const RATE = 16000;
  const MAX_SEC = 30;
  let stream = null, ctx = null, node = null, src = null, sink = null;
  let chunks = [], total = 0, onLevel = null, onAutoStop = null;
  let starting = false, abort = false;

  // resolves true once recording, false when it did not start (already on, another start under way, cancelled meanwhile).
  // Everything is built on locals and kept only at the end, so a failed or cancelled start never leaves the mic open.
  async function start(opts = {}) {
    if (ctx || starting) return false;   // two quick clicks open the microphone once
    starting = true; abort = false;
    let s = null, c = null;
    try {
      s = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      if (abort) return false;
      c = new AudioContext({ sampleRate: RATE });
      await c.audioWorklet.addModule('mic-worklet.js');
      if (abort) return false;
      const sr = c.createMediaStreamSource(s);
      const nd = new AudioWorkletNode(c, 'pcm-capture');
      const sk = c.createGain();
      sk.gain.value = 0;                 // keep the graph pulled without playing the mic back
      onLevel = opts.onLevel || null;
      onAutoStop = opts.onAutoStop || null;
      chunks = []; total = 0;
      nd.port.onmessage = (e) => {
        const a = e.data;
        chunks.push(a);
        total += a.length;
        if (onLevel) {
          let sum = 0;
          for (let i = 0; i < a.length; i++) sum += a[i] * a[i];
          onLevel(Math.min(1, Math.sqrt(sum / a.length) * 6), total / RATE);
        }
        if (total >= MAX_SEC * RATE && onAutoStop) { const f = onAutoStop; onAutoStop = null; f(); }
      };
      sr.connect(nd);
      nd.connect(sk);
      sk.connect(c.destination);
      stream = s; ctx = c; src = sr; node = nd; sink = sk;
      s = c = null;                      // kept: cleanup() releases them from now on
      return true;
    } finally {
      starting = false;
      if (s) s.getTracks().forEach((t) => t.stop());
      if (c) c.close().catch(() => {});
    }
  }

  function cleanup() {
    if (starting) abort = true;          // a start still waiting for the mic gives it back as soon as it gets it
    try { if (src) src.disconnect(); } catch (_) {}
    try { if (node) { node.port.onmessage = null; node.disconnect(); } } catch (_) {}
    if (stream) stream.getTracks().forEach((t) => t.stop());
    if (ctx) ctx.close().catch(() => {});
    stream = ctx = node = src = sink = null;
  }

  // stop and return the recording, with leading/trailing quiet trimmed
  function stop() {
    cleanup();
    const out = new Float32Array(total);
    let o = 0;
    for (const c of chunks) { out.set(c, o); o += c.length; }
    chunks = []; total = 0;
    return trim(out);
  }
  function cancel() { cleanup(); chunks = []; total = 0; }

  function trim(a) {
    const win = 320;                     // 20 ms
    const rms = (i) => { let s = 0; for (let j = i; j < Math.min(a.length, i + win); j++) s += a[j] * a[j]; return Math.sqrt(s / win); };
    let peak = 0;
    for (let i = 0; i < a.length; i += win) peak = Math.max(peak, rms(i));
    const th = Math.max(0.004, peak * 0.08);
    let s = 0, e = a.length;
    while (s < e && rms(s) < th) s += win;
    while (e > s && rms(Math.max(0, e - win)) < th) e -= win;
    s = Math.max(0, s - RATE * 0.25); e = Math.min(a.length, e + RATE * 0.3);
    return a.slice(s, e);
  }

  return { start, stop, cancel, get recording() { return !!ctx; }, get starting() { return starting; }, RATE };
})();
