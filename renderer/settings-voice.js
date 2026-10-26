'use strict';
// "语音" card in the settings window. Changes are saved as soon as they are made.
(() => {
  const U = window.ui;
  const $ = (id) => document.getElementById(id);
  let st = null;

  const MB = (b) => (b / 1048576).toFixed(b > 104857600 ? 0 : 1) + ' MB';
  function msg(text, ok) { const el = $('vMsg'); el.textContent = text; el.className = 'msgline ' + (ok ? 'ok' : 'err'); }

  // Kokoro v1.1 speakers: 3–57 Chinese female, 58–102 Chinese male
  function fillKokoro() {
    const sel = $('vKokoroSid');
    if (sel.options.length) return;
    for (let i = 3; i <= 102; i++) {
      const o = document.createElement('option');
      o.value = String(i);
      o.textContent = i <= 57 ? `女声 ${String(i - 2).padStart(2, '0')}` : `男声 ${String(i - 57).padStart(2, '0')}`;
      sel.appendChild(o);
    }
  }
  function fillEdge(list) {
    const sel = $('vEdgeVoice');
    if (sel.options.length) return;
    for (const v of list) { const o = document.createElement('option'); o.value = v.id; o.textContent = v.name; sel.appendChild(o); }
  }
  function fillSystem(selected) {
    const sel = $('vSystemVoice');
    const vs = (window.speechSynthesis && speechSynthesis.getVoices()) || [];
    const zh = vs.filter((v) => /^zh/i.test(v.lang));
    const rest = vs.filter((v) => !/^zh/i.test(v.lang));
    sel.innerHTML = '';
    const auto = document.createElement('option'); auto.value = ''; auto.textContent = zh.length ? '自动（系统里的中文语音）' : '自动（没找到中文语音，可能念不了中文）';
    sel.appendChild(auto);
    for (const v of zh.concat(rest)) { const o = document.createElement('option'); o.value = v.name; o.textContent = `${v.name}（${v.lang}）`; sel.appendChild(o); }
    sel.value = selected || '';
  }
  if (window.speechSynthesis) speechSynthesis.addEventListener('voiceschanged', () => fillSystem(st && st.systemVoice));

  function showEngine(e) {
    document.querySelectorAll('#voiceCard [data-eng]').forEach((el) => { el.style.display = el.dataset.eng === e ? '' : 'none'; });
    document.querySelectorAll('#voiceCard [data-pitch]').forEach((el) => { el.style.display = e === 'kokoro' ? 'none' : ''; });
  }
  function sliderLabels() {
    const r = +$('vRate').value, p = +$('vPitch').value, v = +$('vVolume').value;
    $('vRateV').textContent = r === 0 ? '正常' : (r > 0 ? `快 ${r}%` : `慢 ${-r}%`);
    $('vPitchV').textContent = p === 0 ? '正常' : (p > 0 ? `高 ${p}` : `低 ${-p}`);
    $('vVolumeV').textContent = v + '%';
  }

  function fill(s) {
    st = s;
    fillEdge(s.edgeVoices);
    fillKokoro();
    fillSystem(s.systemVoice);
    $('vSpeak').value = s.speak;
    $('vMuted').checked = !!s.muted;
    $('vEngine').value = s.engine;
    $('vEdgeVoice').value = s.edgeVoice;
    $('vKokoroSid').value = String(s.kokoroSid);
    $('vRate').value = s.rate;
    $('vPitch').value = s.pitch;
    $('vVolume').value = Math.round(s.volume * 100);
    $('vAutoSend').checked = !!s.autoSend;
    sliderLabels();
    showEngine(s.engine);
    renderModels(s.models);
  }

  function collect() {
    return {
      speak: $('vSpeak').value,
      muted: $('vMuted').checked,
      engine: $('vEngine').value,
      edgeVoice: $('vEdgeVoice').value,
      kokoroSid: +$('vKokoroSid').value,
      systemVoice: $('vSystemVoice').value,
      rate: +$('vRate').value,
      pitch: +$('vPitch').value,
      volume: +$('vVolume').value / 100,
      autoSend: $('vAutoSend').checked,
    };
  }
  async function saveNow() { const s = await U.voiceSet(collect()); st = s; showEngine(s.engine); }

  ['vSpeak', 'vMuted', 'vEngine', 'vEdgeVoice', 'vKokoroSid', 'vSystemVoice', 'vAutoSend'].forEach((id) => $(id).addEventListener('change', saveNow));
  ['vRate', 'vPitch', 'vVolume'].forEach((id) => {
    $(id).addEventListener('input', sliderLabels);
    $(id).addEventListener('change', saveNow);
  });
  $('vEngine').addEventListener('change', () => {
    showEngine($('vEngine').value);
    if ($('vEngine').value === 'kokoro' && st && !st.models.tts.installed) msg('离线语音要先下载模型（下面的按钮）。没下载之前会先用电脑自带的语音。', false);
    else msg('', true);
  });

  const NAMES = { edge: 'Edge 在线语音', kokoro: '离线语音', system: '电脑自带的语音' };
  $('vTest').addEventListener('click', async () => {
    msg('生成中…', true);
    const r = await U.voiceTest(collect());
    if (r.ok) {
      const extra = r.errors && r.errors.length ? `（${r.errors[r.errors.length - 1]}，所以换成了${NAMES[r.engine]}）` : '';
      msg(`正在用${NAMES[r.engine]}念${extra}`, !extra);
    } else msg('没念出来：' + r.error, false);
  });
  $('vStop').addEventListener('click', () => U.voiceStop());

  // ---------- model download boxes ----------
  const progress = {};
  function renderModel(boxId, m, what) {
    const box = $(boxId);
    const p = progress[m.id];
    box.innerHTML = '';
    const top = document.createElement('div'); top.className = 'top';
    const name = document.createElement('b'); name.textContent = m.title;
    const state = document.createElement('span'); state.className = 'state' + (m.installed ? ' ok' : '');
    top.append(name, state);
    if (m.installed) {
      state.textContent = `已下载，${what}`;
      const del = document.createElement('button'); del.className = 'ghost'; del.textContent = '删除模型';
      del.addEventListener('click', async () => {
        if (!confirm(`删除${m.title}？（以后用的时候可以再下载）`)) return;
        renderModels((await U.voiceGet()).models, await U.voiceRemoveModel(m.id));
      });
      top.append(del);
    } else if (m.downloading || p) {
      const pr = p || m.progress || { done: 0, total: m.total };
      state.textContent = `下载中 ${MB(pr.done)} / ${MB(pr.total)}`;
      const cancel = document.createElement('button'); cancel.className = 'ghost'; cancel.textContent = '取消';
      cancel.addEventListener('click', () => U.voiceCancelDownload(m.id));
      top.append(cancel);
      const bar = document.createElement('progress'); bar.max = pr.total; bar.value = pr.done;
      const sub = document.createElement('div'); sub.className = 'sub';
      sub.textContent = pr.source ? `来源：${pr.source.replace('https://', '')}　${pr.file || ''}` : '准备中…';
      box.append(top, bar, sub);
      return;
    } else {
      state.textContent = `还没下载（约 ${MB(m.total)}）`;
      const go = document.createElement('button'); go.textContent = '下载';
      go.addEventListener('click', () => startDownload(m.id));
      top.append(go);
    }
    box.append(top);
    if (m.lastError) { const sub = document.createElement('div'); sub.className = 'sub'; sub.style.color = 'var(--danger)'; sub.textContent = m.lastError; box.append(sub); }
  }
  const lastErr = {};
  function renderModels(models) {
    if (!models) return;
    renderModel('mAsr', { ...models.asr, lastError: lastErr.asr }, '可以用麦克风跟她说话了');
    renderModel('mTts', { ...models.tts, lastError: lastErr.tts }, '断网也能说话');
    if (st) st.models = models;
  }
  async function startDownload(id) {
    lastErr[id] = '';
    progress[id] = { id, done: 0, total: st.models[id].total };
    renderModels(st.models);
    const r = await U.voiceDownload(id);
    delete progress[id];
    if (!r.ok) lastErr[id] = r.code === 'aborted' ? '已取消（再点下载会接着下）' : r.error;
    renderModels((await U.voiceGet()).models);
  }
  U.onVoiceProgress((p) => { if (p.done < p.total) progress[p.id] = p; if (st) renderModels(st.models); });
  U.onVoiceModels((m) => renderModels(m));
  U.onVoiceChanged((s) => fill(s));

  U.voiceGet().then(fill);
})();
