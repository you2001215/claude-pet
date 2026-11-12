'use strict';
// 「连接阿鲸（AstrBot）」 in the settings page: on/off, pairing code, address and device name (link/index.js)
(() => {
  const U = window.ui;
  const $ = (id) => document.getElementById(id);
  const STATUS = {
    off: '关着',
    needs_pair: '还没配对',
    connecting: '正在连接…',
    online: '✅ 已连上阿鲸',
    waiting: '阿鲸现在不在线，桌宠先自己陪你，连上了会自动接上',
    revoked: '这台电脑和阿鲸的连接被撤销了，要重新配对',
    outdated: '桌宠或阿鲸那边需要更新，版本对不上',
    replaced: '这台电脑在别处又连了一次，这边先停下了。重新打开开关就能接回来',
  };
  const msg = (text, ok) => { const el = $('linkMsg'); el.textContent = text || ''; el.className = 'msgline ' + (ok ? 'ok' : 'err'); };

  function show(c) {
    $('linkOn').checked = !!c.enabled;
    $('linkBody').style.display = c.enabled ? '' : 'none';
    let st = STATUS[c.status] || c.status;
    if (c.status === 'needs_pair' && c.paired === false && c.detail === 'pair_code_invalid') st = '还没配对（刚才的配对码不对或过期了）';
    if (c.paired && c.deviceTail) st += `（这台电脑的编号后 4 位：${c.deviceTail}）`;
    if (c.plainToken) st += '。注意：这台电脑不支持加密保存，配对用的钥匙是明文存的';
    $('linkState').textContent = st;
    $('linkPairRow').style.display = c.paired ? 'none' : '';
    $('linkUnpair').style.display = c.paired ? '' : 'none';
    $('linkShareApp').checked = c.shareApp !== false;
    $('linkShareTitle').checked = c.shareTitle !== false;
    $('linkShareTitle').disabled = c.shareApp === false;
    if (document.activeElement !== $('linkUrl')) $('linkUrl').value = c.url || c.defaultUrl;
    if (document.activeElement !== $('linkName')) { $('linkName').value = c.deviceName || ''; $('linkName').placeholder = c.defaultName || ''; }
  }
  async function load() { try { show(await U.linkGet()); } catch (_) {} }

  $('linkOn').addEventListener('change', async () => {
    const r = await U.linkSet({ enabled: $('linkOn').checked });
    if (r.ok) { show(r.config); msg(''); } else msg(r.error);
  });
  $('linkPair').addEventListener('click', async () => {
    const code = $('linkCode').value.trim();
    if (!/^\d{6}$/.test(code)) return msg('配对码是 6 位数字');
    $('linkPair').disabled = true; msg('正在配对…', true);
    try {
      const r = await U.linkPair(code);
      if (r.ok) { $('linkCode').value = ''; msg('配对好了！以后打开桌宠会自动连上阿鲸', true); show(r.config); } else msg(r.error);
    } finally { $('linkPair').disabled = false; }
  });
  $('linkCode').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('linkPair').click(); });
  // what she may know of the front window (spec 17.2): saved at once, no reconnect
  for (const [id, key] of [['linkShareApp', 'shareApp'], ['linkShareTitle', 'shareTitle']]) {
    $(id).addEventListener('change', async () => {
      const r = await U.linkSet({ [key]: $(id).checked });
      if (r.ok) { show(r.config); msg(''); } else msg(r.error);
    });
  }
  $('linkSave').addEventListener('click', async () => {
    const r = await U.linkSet({ url: $('linkUrl').value.trim(), deviceName: $('linkName').value.trim() });
    if (r.ok) { msg('保存好了', true); show(r.config); } else msg(r.error);
  });
  $('linkUnpair').addEventListener('click', async () => {
    if (!confirm('取消配对以后，要在 QQ 里重新拿配对码才能再连上。QQ 那边「/桌宠设备」里的这台电脑也请用「/桌宠吊销」撤掉。确定吗？')) return;
    const r = await U.linkUnpair();
    if (r.ok) { msg('已取消配对', true); show(r.config); }
  });
  U.onLinkStatus((c) => show(c));
  load();
})();
