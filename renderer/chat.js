'use strict';
(() => {
  const U = window.ui;
  const log = document.getElementById('log');
  const input = document.getElementById('input');
  const sendBtn = document.getElementById('send');
  const status = document.getElementById('status');
  let busy = false;
  let withScreen = false;
  const shotBtn = document.getElementById('shot');
  shotBtn.addEventListener('click', () => {
    withScreen = !withScreen;
    shotBtn.classList.toggle('on', withScreen);
    input.placeholder = withScreen ? '发送时会附上一张屏幕截图，问她点什么…' : '和她说点什么…（Enter 发送，输入「余额」查 API 余额）';
    input.focus();
  });
  let live = null;

  function addStickers(el, list) {
    for (const st of list || []) {
      const img = document.createElement('img');
      img.className = 'sticker';
      img.alt = st.alt || '';
      let triedRemote = false;
      img.onerror = () => { if (!triedRemote && st.remote) { triedRemote = true; img.src = st.remote; } else img.remove(); };
      img.onload = () => { log.scrollTop = log.scrollHeight; };
      img.src = st.url;
      el.appendChild(img);
    }
  }
  function add(role, text, extra, stickers) {
    const el = document.createElement('div');
    el.className = 'msg ' + role;
    el.textContent = text === '（发了一个表情）' && stickers && stickers.length ? '' : text;
    addStickers(el, stickers);
    if (extra) { const s = document.createElement('span'); s.className = 'mem'; s.textContent = extra; el.appendChild(s); }
    log.appendChild(el);
    log.scrollTop = log.scrollHeight;
    return el;
  }

  async function refreshHint() {
    const s = await U.getSettings();
    if (!s.hasKey) {
      add('hint', '大肥鱼还没连上 AI。点右上角「设置」，从 DeepSeek Harness 导入 key，或者直接粘贴 DeepSeek 的 API Key。');
    }
  }

  async function boot() {
    const h = await U.history();
    if (!h.length) add('hint', '这里是和她的聊天记录。她会记住你告诉她的事。');
    for (const m of h) add(m.role, m.content, null, m.stickers);
    refreshHint();
    input.focus();
  }

  async function send() {
    let text = input.value.trim();
    if (busy) return;
    // local commands, answered here without calling the model
    const isBalance = /^[\/／]?(查)?(询)?(api)?\s*余额(查询)?[？?！!。]*$/i.test(text) || /^[\/／](balance|余额)$/i.test(text)
      || (text.length <= 14 && /余额/.test(text) && /查|多少|还剩|还有|看看/.test(text));
    if (isBalance) {
      input.value = '';
      add('user', text);
      const el = add('hint', '查询中…');
      const b = await U.balance();
      el.textContent = b.ok ? `💰 ${b.summary}` : `查不到余额：${b.error}`;
      if (b.ok && !b.available) el.style.color = 'var(--danger)';
      return;
    }
    if (!text && withScreen) text = '你看看我在看什么？';
    if (!text) return;
    busy = true; sendBtn.disabled = true;
    input.value = '';
    add('user', withScreen ? text + '（📷 附上了屏幕截图）' : text);
    live = add('assistant', '');
    live.classList.add('typing');
    status.textContent = '正在想…';
    const r = await U.send(text, withScreen);
    withScreen = false; shotBtn.classList.remove('on'); input.placeholder = '和她说点什么…（Enter 发送，输入「余额」查 API 余额）';
    live.classList.remove('typing');
    if (r.ok) {
      live.textContent = r.reply;
      addStickers(live, r.stickers);
      const notes = [];
      if (r.remembered && r.remembered.length) notes.push('记住了：' + r.remembered.join('；'));
      if (r.remindSet && r.remindSet.length) notes.push('⏰ 已设提醒：' + r.remindSet.join('；'));
      if (r.remindCancelled && r.remindCancelled.length) notes.push('已取消提醒：' + r.remindCancelled.join('；'));
      if (r.remindFail && r.remindFail.length) notes.push('提醒没设成功：' + r.remindFail.join('；'));
      for (const n of notes) {
        const s = document.createElement('span'); s.className = 'mem';
        s.textContent = '（' + n + '）';
        live.appendChild(s);
      }
      status.textContent = '在你桌面上待着';
    } else {
      live.remove();
      add('error', r.error || '出错了');
      status.textContent = '刚刚没接上话';
      if (r.code === 'nokey') refreshHint();
    }
    live = null;
    log.scrollTop = log.scrollHeight;
    busy = false; sendBtn.disabled = false;
    input.focus();
  }

  // ---------- voice input ----------
  const micBtn = document.getElementById('mic');
  const micTime = document.getElementById('micTime');
  let micBusy = false;
  function micIdle() { micBtn.classList.remove('rec', 'busy'); micTime.textContent = ''; micBtn.style.removeProperty('--lvl'); }
  async function micStart() {
    if (busy || micBusy || Mic.recording) return;
    if (!(await U.micAccess())) { add('error', '没有麦克风权限。Mac：系统设置 → 隐私与安全性 → 麦克风 里允许 ClaudePet。'); return; }
    const vs = await U.voiceGet();
    if (!vs.models.asr.installed) {
      const el = add('hint', '语音输入要先下载识别模型（约 230 MB，只需一次）。');
      const go = document.createElement('a'); go.href = '#'; go.textContent = ' 去设置里下载';
      go.addEventListener('click', (e) => { e.preventDefault(); U.openSettings(); });
      el.appendChild(go);
      return;
    }
    U.voiceStop();
    U.voiceWarm('asr');
    try {
      await Mic.start({
        onLevel: (lv, sec) => { micBtn.style.setProperty('--lvl', lv.toFixed(2)); micTime.textContent = Math.floor(sec) + 's'; },
        onAutoStop: () => micStop(),
      });
    } catch (e) {
      micIdle();
      const why = e && e.name === 'NotAllowedError' ? '麦克风被系统拒绝了（Windows：设置 → 隐私和安全性 → 麦克风，打开「允许桌面应用访问麦克风」）'
        : e && e.name === 'NotFoundError' ? '没找到麦克风' : '打不开麦克风：' + ((e && e.message) || e);
      add('error', why);
      return;
    }
    micBtn.classList.add('rec');
    micTime.textContent = '0s';
    status.textContent = '在听你说…（再按一次麦克风结束）';
    input.placeholder = '正在听…再按一次结束';
  }
  async function micStop() {
    if (!Mic.recording) return;
    const samples = Mic.stop();
    micIdle();
    micBusy = true; micBtn.classList.add('busy');
    status.textContent = '在听清你说的话…';
    input.placeholder = '和她说点什么…（Enter 发送，输入「余额」查 API 余额）';
    try {
      const r = await U.transcribe(samples, Mic.RATE);
      if (!r.ok) { add('hint', r.error); status.textContent = '在你桌面上待着'; return; }
      const vs = await U.voiceGet();
      input.value = (input.value.trim() ? input.value.trim() + ' ' : '') + r.text;
      status.textContent = '在你桌面上待着';
      if (vs.autoSend) send(); else input.focus();
    } finally { micBusy = false; micBtn.classList.remove('busy'); }
  }
  micBtn.addEventListener('click', () => { if (Mic.recording) micStop(); else micStart(); });
  U.onStartMic(() => { if (!Mic.recording) micStart(); });
  window.addEventListener('keydown', (e) => { if (e.key === 'Escape' && Mic.recording) { Mic.cancel(); micIdle(); status.textContent = '在你桌面上待着'; } });

  const outfitTag = (k) => { document.getElementById('outfitTag').textContent = k === 'maid' ? '（今天穿女仆装）' : '（今天 cos Claude）'; };
  U.outfit().then(outfitTag);
  U.onOutfit(outfitTag);

  U.onProactive((r) => { add('assistant', r.text, null, r.stickers); });
  U.onDelta((t) => { if (live) { live.textContent = t; log.scrollTop = log.scrollHeight; } });

  sendBtn.addEventListener('click', send);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); }
  });
  document.getElementById('settings').addEventListener('click', () => U.openSettings());
  document.getElementById('clear').addEventListener('click', async () => {
    if (!confirm('清空聊天记录？（她记住的事不会被清掉，可以在设置里管理）')) return;
    await U.clear();
    log.innerHTML = '';
    add('hint', '聊天记录清空了。');
  });
  U.onSettingsChanged(() => { /* key may have been added */ });
  boot();
})();
