'use strict';
// 「一起看视频（B 站）」 in the settings page: on/off, mode, read aloud or not, the browser script (watch/index.js)
(() => {
  const U = window.ui;
  const $ = (id) => document.getElementById(id);
  const msg = (text, ok) => { const el = $('watchMsg'); el.textContent = text || ''; el.className = 'msgline ' + (ok ? 'ok' : 'err'); };
  const ago = (t) => { const s = Math.round((Date.now() - t) / 1000); return s < 60 ? `${s} 秒前` : s < 3600 ? `${Math.round(s / 60)} 分钟前` : `${Math.round(s / 3600)} 小时前`; };
  const mmss = (t) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;

  function show(w) {
    $('watchOn').checked = !!w.enabled;
    $('watchBody').style.display = w.enabled ? '' : 'none';
    const parts = [];
    if (w.error) parts.push('⚠ ' + w.error);
    else if (!w.listening) parts.push('没开');
    else if (w.scriptSeenAt && Date.now() - w.scriptSeenAt < 20000) parts.push('✅ 脚本连上了');
    else parts.push(w.scriptSeenAt ? `脚本 ${ago(w.scriptSeenAt)}来过，现在没在看视频` : '还没收到脚本的消息（装好脚本后打开一个 B 站视频）');
    if (w.watching) parts.push(`正在看「${w.watching.title || '视频'}」${w.watching.paused ? '，暂停在' : '，播到'} ${mmss(w.watching.t)}`);
    parts.push(w.herSide ? '阿鲸那边支持一起看' : '阿鲸那边还不支持一起看（或者没连上），她暂时不会说话');
    $('watchState').textContent = parts.join('；');
    if (document.activeElement !== $('watchMode')) $('watchMode').value = w.mode;
    if (document.activeElement !== $('watchMax')) $('watchMax').value = w.hourly_max;
    $('watchMaxRow').style.display = w.mode === 'chatty' ? '' : 'none';
    $('watchSpeak').checked = !!w.speak;
    if (document.activeElement !== $('watchPort')) $('watchPort').value = w.port;
  }
  const set = async (s, okText) => {
    const r = await U.watchSet(s);
    if (r.ok) { show(r.status); if (okText) msg(okText, true); } else msg(r.error);
  };
  async function load() { try { show(await U.watchGet()); } catch (_) {} }

  $('watchOn').addEventListener('change', () => set({ enabled: $('watchOn').checked }));
  $('watchMode').addEventListener('change', () => set({ mode: $('watchMode').value }, '换好了'));
  $('watchMax').addEventListener('change', () => set({ hourly_max: Number($('watchMax').value) }, '保存好了'));
  $('watchSpeak').addEventListener('change', () => set({ speak: $('watchSpeak').checked }));
  $('watchPortSave').addEventListener('click', () => set({ port: Number($('watchPort').value) }, '端口改好了，记得重新复制、安装一次脚本'));
  $('watchCopy').addEventListener('click', async () => {
    const text = await U.watchScript();
    try { await navigator.clipboard.writeText(text); msg('复制好了，去 Tampermonkey 里新建脚本粘贴进去', true); } catch (_) {
      const ta = document.createElement('textarea'); ta.value = text; document.body.appendChild(ta); ta.select();
      const ok = document.execCommand('copy'); ta.remove();
      msg(ok ? '复制好了，去 Tampermonkey 里新建脚本粘贴进去' : '没复制成功，再点一次试试', ok);
    }
  });
  $('watchNewKey').addEventListener('click', async () => {
    if (!confirm('换口令以后，浏览器里旧的脚本就不能用了，要重新复制、安装一次。确定吗？')) return;
    await U.watchNewKey();
    msg('换好了，请重新复制脚本装一次', true);
    load();
  });
  U.onWatchStatus((w) => show(w));
  setInterval(load, 5000);     // "脚本连上了" / the play point stay current
  load();
})();
