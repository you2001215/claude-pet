'use strict';
// Watching together (phase 2), as the rest of the pet sees it: settings (watch.json), the local endpoint for the
// browser script, the WatchSession, and what goes to her side. Off until the user turns it on in the settings page.
// Only does anything towards her while her side says it supports it (welcome.features has "watch").
// No electron here: the link and a logger are passed in.
const crypto = require('crypto');
const path = require('path');
const store = require('../store');
const server = require('./server');
const { WatchSession } = require('./session');
const { script } = require('./userscript');

const MODES = ['quiet', 'normal', 'chatty'];
const DEFAULTS = { enabled: false, port: 6231, key: '', mode: 'normal', hourly_max: 25, speak: false };
let dir = '', link = null, log = () => {}, onChange = () => {};
let cfg = { ...DEFAULTS };
let srv = null, session = null, srvError = '', starting = null;

const file = () => path.join(dir, 'watch.json');
function save() { try { store.writeJsonSync(file(), cfg); } catch (e) { log(`保存一起看设置失败：${e.code || e.message}`); } }
const clampMax = (n) => Math.min(60, Math.max(10, Math.round(Number(n) || 25)));

function modeNow() { return { mode: cfg.mode, hourly_max: cfg.hourly_max }; }

// o: { userData, link, log, onChange(status), timers }
function init(o) {
  dir = o.userData; link = o.link; log = o.log || log; onChange = o.onChange || onChange;
  const r = store.readJsonSync(file(), null);
  if (r && r.data && typeof r.data === 'object') cfg = { ...cfg, ...r.data };
  if (!/^[0-9a-f]{32,64}$/.test(String(cfg.key))) { cfg.key = crypto.randomBytes(16).toString('hex'); save(); }
  if (!MODES.includes(cfg.mode)) cfg.mode = 'normal';
  cfg.hourly_max = clampMax(cfg.hourly_max);
  session = new WatchSession({
    mode: modeNow, timers: o.timers,
    send: (kind, data, ack) => { if (link && link.feature('watch')) link.send('event.watch', data, { ack }); },
  });
  session.on('event', () => onChange(status()));
  return restart();
}

async function restart() {
  if (starting) await starting.catch(() => {});
  starting = (async () => {
    if (srv) { const s = srv; srv = null; await s.close().catch(() => {}); }
    srvError = '';
    if (!cfg.enabled) { session.stop(); return; }
    try {
      srv = await server.start({ port: cfg.port, key: cfg.key, log, onEvent: (b) => session.report(b) });
    } catch (e) {
      srvError = e.code === 'EADDRINUSE' ? `端口 ${cfg.port} 被别的程序占着了，换一个端口试试` : `一起看的接口开不了：${e.code || e.message}`;
      log(srvError);
    }
  })();
  await starting;
  starting = null;
  onChange(status());
}

function status() {
  const p = session ? session.position() : null;
  return {
    enabled: cfg.enabled, port: cfg.port, mode: cfg.mode, hourly_max: cfg.hourly_max, speak: cfg.speak,
    listening: !!srv, error: srvError, scriptSeenAt: session ? session.lastScriptAt : 0,
    watching: p ? { title: p.title, t: p.t, paused: p.paused } : null,
    herSide: !!(link && link.feature('watch')),
  };
}

// her side should know the mode: when it changes in the settings page, and when the link comes up
function tellMode(by) {
  if (link && link.feature('watch')) link.send('event.mode', { ...modeNow(), by }, { ack: true });
}

async function setConfig(s = {}) {
  let again = false, modeChanged = false;
  if (s.enabled !== undefined && !!s.enabled !== cfg.enabled) { cfg.enabled = !!s.enabled; again = true; }
  if (s.port !== undefined) {
    const port = Math.round(Number(s.port));
    if (!(port >= 1024 && port <= 65535)) return { ok: false, error: '端口要在 1024～65535 之间' };
    if (port !== cfg.port) { cfg.port = port; again = true; }
  }
  if (s.mode !== undefined && MODES.includes(s.mode) && s.mode !== cfg.mode) { cfg.mode = s.mode; modeChanged = true; }
  if (s.hourly_max !== undefined && clampMax(s.hourly_max) !== cfg.hourly_max) { cfg.hourly_max = clampMax(s.hourly_max); modeChanged = true; }
  if (s.speak !== undefined) cfg.speak = !!s.speak;
  save();
  if (modeChanged) tellMode('settings');
  if (again) await restart(); else onChange(status());
  return { ok: true, status: status() };
}

// cmd.mode: she heard 「安静看片」/「随便说」 in a chat. Acking it is enough (no event.mode back).
function applyMode(d) {
  if (!d || !MODES.includes(d.mode)) return { ok: false, code: 'bad_mode' };
  cfg.mode = d.mode;
  if (d.hourly_max !== undefined) cfg.hourly_max = clampMax(d.hourly_max);
  save();
  onChange(status());
  return { ok: true };
}

// a new key makes the old script stop working (when it was shared by mistake)
function newKey() { cfg.key = crypto.randomBytes(16).toString('hex'); save(); return restart().then(() => ({ ok: true })); }

module.exports = {
  init, restart, status, setConfig, applyMode, tellMode, newKey,
  script: () => script({ port: cfg.port, key: cfg.key }),
  position: () => (session ? session.position() : null),
  fresh: (w) => !!session && session.fresh(w, cfg.mode),
  seek: (t) => (session ? session.seek(t) : ''),
  speakOn: () => cfg.speak,
  stop: () => { if (session) session.stop(); if (srv) { const s = srv; srv = null; return s.close(); } return Promise.resolve(); },
};
