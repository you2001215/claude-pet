'use strict';
// Microphone recorder: 16 kHz mono Float32, for the offline SenseVoice recogniser.
window.Mic = (() => {
  const RATE = 16000;
  const MAX_SEC = 30;
  let stream = null, ctx = null, node = null, src = null, sink = null;
  let chunks = [], total = 0, onLevel = null, onAutoStop = null;

  async function start(opts = {}) {
    if (ctx) return;
    onLevel = opts.onLevel || null;
    onAutoStop = opts.onAutoStop || null;
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    ctx = new AudioContext({ sampleRate: RATE });
    await ctx.audioWorklet.addModule('mic-worklet.js');
    src = ctx.createMediaStreamSource(stream);
    node = new AudioWorkletNode(ctx, 'pcm-capture');
    sink = ctx.createGain();
    sink.gain.value = 0;                 // keep the graph pulled without playing the mic back
    chunks = []; total = 0;
    node.port.onmessage = (e) => {
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
    src.connect(node);
    node.connect(sink);
    sink.connect(ctx.destination);
  }

  function cleanup() {
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

  return { start, stop, cancel, get recording() { return !!ctx; }, RATE };
})();
