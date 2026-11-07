'use strict';
// The little local endpoint the watch-together browser script talks to (docs/桌面连接接口说明.md 16.2).
// Only on 127.0.0.1, only with this computer's key, only small JSON bodies, never from a web page.
// No electron here.
const http = require('http');
const crypto = require('crypto');

const BODY_MAX = 16 * 1024;
// a browser script manager (Tampermonkey, Violentmonkey) sends from its extension, or without an Origin at all;
// a page on some website would have its own https:// origin and is refused
const ORIGIN_OK = /^(chrome-extension|moz-extension|safari-web-extension|safari-extension):\/\//;

const same = (a, b) => {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

// o: { port, key, onEvent(body) -> answer object, log }. Resolves { port, close() }.
function start(o) {
  const log = o.log || (() => {});
  const reply = (res, code, body) => {
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(body));
  };
  const server = http.createServer((req, res) => {
    const host = String(req.headers.host || '');
    if (!/^(127\.0\.0\.1|localhost):\d+$/.test(host)) return reply(res, 403, { ok: false, error: 'host' });
    const origin = req.headers.origin;
    if (origin && !ORIGIN_OK.test(origin)) return reply(res, 403, { ok: false, error: 'origin' });
    if (!same(req.headers['x-pet-key'] || '', o.key)) return reply(res, 403, { ok: false, error: 'key' });
    if (req.method === 'GET' && req.url === '/watch/v1/ping') return reply(res, 200, { ok: true, app: 'ClaudePet' });
    if (req.method !== 'POST' || req.url !== '/watch/v1/event') return reply(res, 404, { ok: false });
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > BODY_MAX) { reply(res, 413, { ok: false, error: 'too big' }); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (size > BODY_MAX) return;
      let body;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (_) { return reply(res, 400, { ok: false, error: 'json' }); }
      let answer;
      try { answer = o.onEvent(body) || { ok: true }; } catch (e) { log(`一起看出错：${e.message}`); answer = { ok: false }; }
      reply(res, 200, answer);
    });
  });
  server.on('clientError', (_e, sock) => { try { sock.destroy(); } catch (_) {} });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(o.port, '127.0.0.1', () => {
      server.removeListener('error', reject);
      server.on('error', (e) => log(`一起看接口出错：${e.code || e.message}`));
      resolve({ port: server.address().port, close: () => new Promise((r) => { server.close(() => r()); if (server.closeAllConnections) server.closeAllConnections(); }) });
    });
  });
}

module.exports = { start };
