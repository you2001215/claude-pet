'use strict';
// The watch-together browser script (Tampermonkey / Violentmonkey) for bilibili video pages, as the settings page
// hands it out: this computer's port and key are filled in. It only tells the pet where the video is (which video,
// how far, paused or not, speed); it never reads danmaku, comments, the account or cookies, and it only moves the
// video when the pet asks (the user clicked 「跳过去」). docs/桌面连接接口说明.md 16.2.

function script({ port, key }) {
  if (!/^\d{1,5}$/.test(String(port)) || !/^[0-9a-f]{32,64}$/.test(String(key))) throw new Error('bad port or key');
  return `// ==UserScript==
// @name         大肥鱼一起看（ClaudePet）
// @namespace    claudepet
// @version      1.0
// @description  把 B 站视频播到哪了告诉这台电脑上的桌宠，好让阿鲸陪你一起看。只发进度，不读弹幕、评论、账号。
// @match        https://www.bilibili.com/video/*
// @match        https://www.bilibili.com/bangumi/play/*
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @connect      127.0.0.1
// @run-at       document-idle
// @noframes
// ==/UserScript==
(function () {
  'use strict';
  var PORT = ${Number(port)}, KEY = '${key}';
  var W = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
  var video = null, lastT = 0, seekFrom = null, done = [], fails = 0, quietUntil = 0, page = '';
  var r1 = function (x) { return Math.round(x * 10) / 10; };

  function info() {
    var st = W.__INITIAL_STATE__ || {}, path = location.pathname, m, out = { site: 'bilibili', bvid: '', cid: 0, p: 1, title: '' };
    if ((m = /\\/video\\/(BV[0-9A-Za-z]+)/.exec(path))) {
      out.bvid = m[1];
      out.p = Number(new URLSearchParams(location.search).get('p')) || 1;
      var vd = st.videoData || {};
      if (vd.bvid === out.bvid) {               // the page data can be from the video before (switching in the page)
        var pg = (vd.pages || [])[out.p - 1];
        out.cid = Number((pg && pg.cid) || vd.cid) || 0;
        out.title = vd.title || '';
      }
    } else if ((m = /\\/bangumi\\/play\\/ep(\\d+)/.exec(path))) {
      out.ep = Number(m[1]);
      var ep = st.epInfo || {};
      if (Number(ep.id || ep.ep_id) === out.ep) {
        out.cid = Number(ep.cid) || 0;
        out.bvid = ep.bvid || '';
        out.title = [st.mediaInfo && st.mediaInfo.title, ep.long_title || ep.title].filter(Boolean).join(' ');
      }
    }
    if (!out.title) out.title = document.title.replace(/_哔哩哔哩.*$/, '').trim();
    out.title = out.title.slice(0, 80);
    out.dur = video && isFinite(video.duration) ? r1(video.duration) : 0;
    return out;
  }

  function send(kind, extra) {
    if (!video || Date.now() < quietUntil) return;
    var body = { kind: kind, video: info(), t: r1(video.currentTime || 0), paused: !!video.paused, rate: video.playbackRate || 1,
      hidden: document.hidden, from: null, done: done };
    for (var k in (extra || {})) body[k] = extra[k];
    done = [];
    GM_xmlhttpRequest({
      method: 'POST', url: 'http://127.0.0.1:' + PORT + '/watch/v1/event', timeout: 3000,
      headers: { 'Content-Type': 'application/json', 'X-Pet-Key': KEY }, data: JSON.stringify(body),
      onload: function (r) {
        fails = 0;
        try { (JSON.parse(r.responseText).cmd || []).forEach(run); } catch (e) {}
      },
      // the pet isn't running: try again less and less often (at most once a minute)
      onerror: function () { fails++; quietUntil = Date.now() + Math.min(60000, 5000 * fails); },
      ontimeout: function () { fails++; quietUntil = Date.now() + Math.min(60000, 5000 * fails); },
    });
  }

  // the only thing the pet may ask: jump to a point (after you clicked 「跳过去」 on the pet)
  function run(c) {
    if (c && c.type === 'seek' && video && isFinite(c.t)) { video.currentTime = Math.max(0, Number(c.t)); done.push(String(c.id)); }
  }

  function attach(v) {
    if (video === v) return;
    video = v;
    v.addEventListener('play', function () { send('play'); });
    v.addEventListener('pause', function () { if (!v.ended) send('pause'); });
    v.addEventListener('ratechange', function () { send('rate'); });
    v.addEventListener('ended', function () { send('ended'); });
    v.addEventListener('seeking', function () { if (seekFrom === null) seekFrom = r1(lastT); });
    v.addEventListener('seeked', function () { send('seek', { from: seekFrom }); seekFrom = null; });
    v.addEventListener('timeupdate', function () { if (!v.seeking) lastT = v.currentTime; });
    send('heartbeat');
  }

  setInterval(function () {
    var v = document.querySelector('video, bwp-video');
    if (v) attach(v);
    var now = location.pathname + '?p=' + (new URLSearchParams(location.search).get('p') || '1');
    if (page && now !== page) send('switch');
    page = now;
  }, 1000);
  setInterval(function () { if (video && !document.hidden) send('heartbeat'); }, 5000);
  document.addEventListener('visibilitychange', function () { send(document.hidden ? 'hidden' : 'visible'); });
  window.addEventListener('pagehide', function () { send('leave'); });
})();
`;
}

module.exports = { script };
