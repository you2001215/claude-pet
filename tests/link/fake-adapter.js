'use strict';
// A stand-in for the AstrBot desktop adapter, for tests: it follows docs/桌面连接接口说明.md v1.0 closely enough to
// check the pet's side (pairing, tokens, acks and de-duplication, replies, merges, errors, cmd.say, snapshot, care).
// Never talks to a real bot. Listens on 127.0.0.1 only, on a free port.
const http = require('http');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
let n = 0;
const id = (p) => `${p}_fake${(++n).toString(36)}`;
const frame = (type, data, fid = id(type[0])) => ({ v: 1, type, id: fid, ts: Date.now(), data });

class FakeAdapter {
  constructor(o = {}) {
    this.opts = { replyTimeoutS: 240, answer: (text) => [{ text: `收到：${text}` }], ...o };
    this.codes = new Map();      // code -> { until, misses }
    this.devices = new Map();    // tokenHash -> { id, name, revoked }
    this.conns = new Map();      // deviceId -> ws
    this.seen = new Set();       // ids already handled
    this.got = [];               // every frame received
    this.handshakes = [];        // request headers of every upgrade
    this.answered = [];          // chat.send ids that got a chat.done
    this.acks = [];              // acks the pet sent
    this.pong = true;
    this.ackOn = true;
    this.hold = null;            // when set: chat.send ids are queued here instead of answered
  }

  async start() {
    this.server = http.createServer();
    this.wss = new WebSocketServer({
      noServer: true, maxPayload: 2 * 1024 * 1024,
    });
    this.server.on('upgrade', (req, sock, head) => {
      this.handshakes.push({ ...req.headers });
      const host = String(req.headers.host || '');
      if (req.headers.origin || !/^(127\.0\.0\.1|localhost):\d+$/.test(host) || req.url !== '/desktop/v1') {
        sock.write('HTTP/1.1 403 Forbidden\r\n\r\n'); sock.destroy(); return;
      }
      this.wss.handleUpgrade(req, sock, head, (ws) => this._conn(ws));
    });
    await new Promise((r) => this.server.listen(0, '127.0.0.1', r));
    this.port = this.server.address().port;
    this.url = `ws://127.0.0.1:${this.port}/desktop/v1`;
    return this;
  }
  async close() {
    for (const ws of this.wss.clients) ws.terminate();
    await new Promise((r) => this.wss.close(() => r()));
    await new Promise((r) => this.server.close(() => r()));
  }

  issueCode(ttlMs = 5 * 60000) {
    const code = String(crypto.randomInt(0, 1e6)).padStart(6, '0');
    this.codes.set(code, { until: Date.now() + ttlMs, misses: 0 });
    return code;
  }
  revoke(deviceId) {
    for (const d of this.devices.values()) if (d.id === deviceId) d.revoked = true;
    const ws = this.conns.get(deviceId);
    if (ws) ws.close(4401, 'token_invalid');
  }
  // the connection of the only (or given) device
  ws(deviceId) { return deviceId ? this.conns.get(deviceId) : [...this.conns.values()][0]; }
  push(type, data, fid, deviceId) { const f = frame(type, data, fid); this.ws(deviceId).send(JSON.stringify(f)); return f; }
  drop(code = 1006) { const w = this.ws(); if (code === 1006) w.terminate(); else w.close(code); }

  _conn(ws) {
    let dev = null;
    const helloTimer = setTimeout(() => ws.close(4408, 'hello_timeout'), 10000);
    ws.on('message', (raw, bin) => {
      if (bin) return ws.close(4400, 'bad_frame');
      let f;
      try { f = JSON.parse(String(raw)); } catch (_) { return ws.close(4400, 'bad_frame'); }
      this.got.push(f);
      if (!dev) {
        if (f.type !== 'hello') return ws.close(4400, 'bad_frame');
        clearTimeout(helloTimer);
        const a = (f.data && f.data.auth) || {};
        let token = null;
        if (a.pair_code) {
          const c = this.codes.get(a.pair_code);
          if (!c || c.until < Date.now() || c.misses >= 5) {
            for (const v of this.codes.values()) v.misses++;      // a wrong code counts against every open code
            return ws.close(4403, 'pair_code_invalid');
          }
          this.codes.delete(a.pair_code);
          token = crypto.randomBytes(32).toString('base64url');
          dev = { id: id('dev'), name: String(f.data.device_name || '').slice(0, 32), revoked: false };
          this.devices.set(sha(token), dev);
        } else {
          dev = this.devices.get(sha(a.token || ''));
          if (!dev || dev.revoked) { dev = null; return ws.close(4401, 'token_invalid'); }
        }
        const old = this.conns.get(dev.id);
        if (old && old !== ws) old.close(4409, 'replaced');
        this.conns.set(dev.id, ws);
        ws.on('close', () => { if (this.conns.get(dev.id) === ws) this.conns.delete(dev.id); });
        ws.send(JSON.stringify(frame('welcome', {
          proto: 1, device_id: dev.id, ...(token ? { token } : {}), server_time: Date.now(),
          limits: { text_max: 4000, frame_max: 1048576, batch_max: this.opts.batchMax || 200 }, reply_timeout_s: this.opts.replyTimeoutS, features: this.opts.features || [],
        })));
        return;
      }
      this._frame(ws, f);
    });
  }

  _ack(ws, ref, extra = {}) { if (this.ackOn) ws.send(JSON.stringify(frame('ack', { ref, ok: true, ...extra }))); }

  _frame(ws, f) {
    const d = f.data || {};
    switch (f.type) {
      case 'ping': if (this.pong) ws.send(JSON.stringify(frame('pong', { ref: f.id }))); return;
      case 'ack': this.acks.push(d); return;
      case 'chat.send':
        if (this.seen.has(f.id)) return this._ack(ws, f.id, { code: 'duplicate' });
        this.seen.add(f.id);
        if (String(d.text || '').length > 4000) return ws.send(JSON.stringify(frame('ack', { ref: f.id, ok: false, code: 'too_long' })));
        this._ack(ws, f.id);
        if (this.hold) { this.hold.push(f.id); return; }
        if (this.opts.fail) return ws.send(JSON.stringify(frame('chat.error', { reply_to: f.id, code: 'model_failed', retry: true })));
        if (this.opts.silent) return;
        setTimeout(() => this.answer(f.id, this.opts.answer(d.text)), this.opts.delayMs || 0);
        return;
      case 'offline.batch':
        if (this.seen.has(f.id)) return this._ack(ws, f.id, { code: 'duplicate' });
        if ((d.items || []).length > (this.opts.batchMax || 200)) return ws.send(JSON.stringify(frame('ack', { ref: f.id, ok: false, code: 'too_long' })));
        this.seen.add(f.id);
        return this._ack(ws, f.id);
      case 'event.care':
        if (!this.seen.has(f.id)) this.seen.add(f.id);
        return this._ack(ws, f.id);
      case 'event.watch':       // only start / ended / leave want an ack (section 16.3)
        if (['start', 'ended', 'leave'].includes(d.kind)) return this._ack(ws, f.id);
        return;
      case 'event.mode': case 'event.point': case 'event.screen':
        return this._ack(ws, f.id);
      case 'event.typing': return;
      default: // unknown types are ignored
    }
  }

  // answer chat.send `to` (and the ones in merged) with these parts
  answer(to, parts, merged = [to], extra = {}) {
    const ws = this.ws();
    if (!ws) return;
    this.answered.push(to);
    ws.send(JSON.stringify(frame('chat.done', { reply_to: to, merged, parts, ...extra })));
  }

  received(type) { return this.got.filter((f) => f.type === type); }
}

module.exports = { FakeAdapter, frame };
