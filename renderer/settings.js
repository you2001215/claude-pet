'use strict';
(() => {
  const U = window.ui;
  const $ = (id) => document.getElementById(id);
  let current = null;

  function fill(s) {
    current = s;
    $('keyState').textContent = s.hasKey ? `已保存：${s.keyMasked}${s.encrypted ? '' : '（这台电脑不支持加密保存）'}` : '还没有';
    $('baseUrl').value = s.baseUrl;
    $('model').value = s.model;
    $('persona').value = s.persona;
    $('memoryOn').checked = s.memoryOn;
    $('notes').value = (s.notes || []).join('\n');
    $('turns').value = s.historyTurns;
    $('proactive').value = s.proactive;
    $('whisper').value = s.whisper || 'canned';
    $('stickers').value = s.stickers;
    $('stickerDuo').checked = !!s.stickerDuo;
    $('memes').checked = s.memes !== false;
    $('look').value = s.look;
    $('visionModel').value = s.visionModel;
  }

  function collect() {
    return {
      key: $('key').value,
      baseUrl: $('baseUrl').value,
      model: $('model').value,
      persona: $('persona').value,
      memoryOn: $('memoryOn').checked,
      notes: $('notes').value.split('\n'),
      historyTurns: Number($('turns').value) || 12,
      proactive: $('proactive').value,
      whisper: $('whisper').value,
      stickers: $('stickers').value,
      stickerDuo: $('stickerDuo').checked,
      memes: $('memes').checked,
      look: $('look').value,
      visionModel: $('visionModel').value,
    };
  }

  function msg(id, text, ok) {
    const el = $(id);
    el.textContent = text;
    el.className = 'msgline ' + (ok ? 'ok' : 'err');
  }

  async function loadModels() {
    const list = await U.models();
    const dl = $('modelList');
    dl.innerHTML = '';
    for (const m of list) { const o = document.createElement('option'); o.value = m; dl.appendChild(o); }
  }

  async function save() {
    const s = await U.saveSettings(collect());
    $('key').value = '';
    fill(s);
    return s;
  }

  $('import').addEventListener('click', async () => {
    const r = await U.importDsh();
    if (r.ok) {
      msg('connMsg', `导入成功：${r.provider || 'DeepSeek'} · ${r.model} · ${r.keyMasked}`, true);
      fill(await U.getSettings());
      loadModels();
    } else msg('connMsg', r.error, false);
  });
  $('test').addEventListener('click', async () => {
    await save();
    msg('connMsg', '测试中…', true);
    const r = await U.test();
    if (r.ok) { msg('connMsg', '连上了！可以去和她聊天了。', true); loadModels(); }
    else msg('connMsg', r.error, false);
  });
  $('balanceBtn').addEventListener('click', async () => {
    msg('connMsg', '查询中…', true);
    const b = await U.balance();
    msg('connMsg', b.ok ? b.summary : b.error, b.ok && b.available);
  });
  $('clearKey').addEventListener('click', async () => {
    if (!confirm('删除保存的 API Key？')) return;
    fill(await U.saveSettings({ clearKey: true }));
    msg('connMsg', 'key 已删除', true);
  });
  $('resetPersona').addEventListener('click', () => { if (current) $('persona').value = current.defaultPersona; });
  $('save').addEventListener('click', async () => { await save(); msg('saveMsg', '已保存', true); });
  $('cancel').addEventListener('click', () => U.close());

  async function refreshStickerState() {
    const st = await U.stickerStatus();
    $('stickerState').textContent = `已缓存 ${st.cached} 张` + (st.lastError ? `，最近一次失败：${st.lastError.message}` : '');
  }
  $('stickerTest').addEventListener('click', async () => {
    msg('stickerMsg', '下载中…', true);
    const r = await U.stickerTest();
    if (r.ok) {
      msg('stickerMsg', `成功：${Math.round(r.bytes / 1024)} KB，用时 ${(r.ms / 1000).toFixed(1)} 秒`, true);
      const img = $('stickerPreview'); img.src = r.sticker.url + '?t=' + Date.now(); img.style.display = 'block';
    } else {
      msg('stickerMsg', `失败：${r.error}`, false);
    }
    refreshStickerState();
  });
  refreshStickerState();

  async function refreshReminders() {
    const list = await U.reminders();
    const box = $('remList');
    box.innerHTML = '';
    if (!list.length) { box.textContent = '现在没有待提醒的事。'; return; }
    for (const r of list) {
      const row = document.createElement('div');
      row.className = 'inline';
      row.style.marginBottom = '6px';
      const t = document.createElement('span');
      t.style.flex = '1';
      t.textContent = `${r.label}　${r.text}`;
      const del = document.createElement('button');
      del.className = 'ghost';
      del.textContent = '删除';
      del.addEventListener('click', async () => { await U.deleteReminder(r.id); refreshReminders(); });
      row.append(t, del);
      box.appendChild(row);
    }
  }
  refreshReminders();

  document.querySelectorAll('a[data-url]').forEach((a) => a.addEventListener('click', (e) => { e.preventDefault(); U.openUrl(a.dataset.url); }));
  U.getSettings().then((s) => { fill(s); if (s.hasKey) loadModels(); });
  U.outfit().then((k) => { $('outfit').value = k; });
  $('outfit').addEventListener('change', () => U.setOutfit($('outfit').value));
  U.onOutfit((k) => { $('outfit').value = k; });
})();
