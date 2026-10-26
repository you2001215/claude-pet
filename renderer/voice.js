'use strict';
// Plays her voice in the pet window and exposes a loudness level so she can bob while talking.
(() => {
  const P = window.pet;
  let ctx = null, gain = null, analyser = null;
  let job = 0, nextT = 0, sources = [], endMarked = false;
  let sysSpeaking = false, sysStart = 0;
  let queue = Promise.resolve();
  const td = new Float32Array(512);
  let level = 0;

  function ensure() {
    if (!ctx) {
      ctx = new AudioContext();
      gain = ctx.createGain();
      analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      gain.connect(analyser);
      analyser.connect(ctx.destination);
    }
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    return ctx;
  }

  function stopAll() {
    for (const s of sources) { try { s.onended = null; s.stop(); } catch (_) {} }
    sources = [];
    nextT = 0;
    endMarked = false;
    if (sysSpeaking || (window.speechSynthesis && speechSynthesis.speaking)) { try { speechSynthesis.cancel(); } catch (_) {} }
    sysSpeaking = false;
  }

  function checkEnd() {
    if (endMarked && !sources.length) { endMarked = false; }
  }

  async function handlePlay(m) {
    if (m.job !== job) { stopAll(); job = m.job; }
    if (m.kind === 'end') { endMarked = true; checkEnd(); return; }
    const c = ensure();
    gain.gain.value = m.volume ?? 0.9;
    let buf;
    if (m.kind === 'mp3') {
      const u8 = m.data instanceof Uint8Array ? m.data : new Uint8Array(m.data);
      buf = await c.decodeAudioData(u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength));
    } else {
      const s = m.samples instanceof Float32Array ? m.samples : new Float32Array(m.samples);
      buf = c.createBuffer(1, s.length, m.sampleRate);
      buf.copyToChannel(s, 0);
    }
    if (m.job !== job) return;
    const src = c.createBufferSource();
    src.buffer = buf;
    src.connect(gain);
    const at = Math.max(c.currentTime + 0.04, nextT);
    src.start(at);
    nextT = at + buf.duration;
    sources.push(src);
    src.onended = () => { sources = sources.filter((x) => x !== src); checkEnd(); };
  }

  function voicesReady() {
    return new Promise((resolve) => {
      const v = speechSynthesis.getVoices();
      if (v.length) return resolve(v);
      const t = setTimeout(() => resolve(speechSynthesis.getVoices()), 1200);
      speechSynthesis.addEventListener('voiceschanged', () => { clearTimeout(t); resolve(speechSynthesis.getVoices()); }, { once: true });
    });
  }
  async function handleSystem(m) {
    stopAll();
    job = m.job;
    if (!window.speechSynthesis) return;
    const vs = await voicesReady();
    if (m.job !== job) return;
    const u = new SpeechSynthesisUtterance(m.text);
    const v = vs.find((x) => x.name === m.voice) || vs.find((x) => /^zh[-_]CN/i.test(x.lang)) || vs.find((x) => /^zh/i.test(x.lang));
    if (v) { u.voice = v; u.lang = v.lang; } else u.lang = 'zh-CN';
    u.rate = Math.max(0.5, Math.min(2, m.rate || 1));
    u.pitch = Math.max(0.5, Math.min(1.8, m.pitch || 1));
    u.volume = Math.max(0, Math.min(1, m.volume ?? 0.9));
    const fin = () => { if (job === m.job) sysSpeaking = false; };
    u.onend = fin; u.onerror = fin;
    sysSpeaking = true; sysStart = performance.now();
    speechSynthesis.speak(u);
  }

  P.onVoice((ch, m) => {
    if (ch === 'voice:stop') { queue = queue.then(() => stopAll()); return; }
    if (ch === 'voice:system') { queue = queue.then(() => handleSystem(m)).catch(() => {}); return; }
    if (ch === 'voice:play') queue = queue.then(() => handlePlay(m)).catch((e) => console.warn('voice', e));
  });

  function speaking() {
    if (sysSpeaking) return true;
    return !!ctx && (sources.length > 0 && ctx.currentTime < nextT + 0.05);
  }
  // 0..1 loudness, smoothed; the system voice has no signal to measure, so fake a gentle talk rhythm
  function readLevel() {
    let target = 0;
    if (sysSpeaking) {
      const t = (performance.now() - sysStart) / 1000;
      target = 0.35 + 0.3 * Math.abs(Math.sin(t * 7.3)) * Math.abs(Math.sin(t * 2.1 + 1));
    } else if (analyser && sources.length) {
      analyser.getFloatTimeDomainData(td);
      let sum = 0;
      for (let i = 0; i < td.length; i++) sum += td[i] * td[i];
      target = Math.min(1, Math.sqrt(sum / td.length) * 5);
    }
    level += (target - level) * (target > level ? 0.5 : 0.18);
    return level;
  }

  window.petVoice = {
    get speaking() { return speaking(); },
    level: readLevel,
    stop: () => { stopAll(); P.voiceStop(); },
  };
})();
