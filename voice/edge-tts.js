'use strict';
// Microsoft Edge "Read aloud" neural voices over WebSocket (the same service the Edge browser uses).
// Unofficial interface: the protocol and the Sec-MS-GEC token scheme are ported from edge-tts
// (https://github.com/rany2/edge-tts, Copyright (c) rany <rany@riseup.net>), which is licensed under LGPLv3.
//
// SPDX-License-Identifier: LGPL-3.0-only
// Because it is a port of LGPL code, THIS FILE (and only this file) is licensed under the
// GNU Lesser General Public License v3.0 — see LICENSES/LGPL-3.0.txt and LICENSES/GPL-3.0.txt.
// The rest of the project is MIT (see LICENSE).
const crypto = require('crypto');
const WebSocket = require('ws');

const TRUSTED_CLIENT_TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4';
const CHROMIUM_FULL_VERSION = '143.0.3650.75';
const CHROMIUM_MAJOR = CHROMIUM_FULL_VERSION.split('.')[0];
const SEC_MS_GEC_VERSION = `2-${CHROMIUM_FULL_VERSION}`;
const WSS_URL = process.env.PET_EDGE_WSS || `wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1?TrustedClientToken=${TRUSTED_CLIENT_TOKEN}`;
const HEADERS = {
  Pragma: 'no-cache',
  'Cache-Control': 'no-cache',
  Origin: 'chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold',
  'User-Agent': `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROMIUM_MAJOR}.0.0.0 Safari/537.36 Edg/${CHROMIUM_MAJOR}.0.0.0`,
  'Accept-Encoding': 'gzip, deflate, br, zstd',
  'Accept-Language': 'en-US,en;q=0.9',
};

// ---------- Sec-MS-GEC v2 token (port of edge_tts/drm.py) ----------
const U = (x) => x >>> 0;
const rol16 = (v) => U((v << 16) | (v >>> 16));
const rotr = (v, n) => U((v >>> n) | (v << (32 - n)));
const sig0 = (v) => U(rotr(v, 7) ^ rotr(v, 18) ^ (v >>> 3));
const sig1 = (v) => U(rotr(v, 17) ^ rotr(v, 19) ^ (v >>> 10));
const SHA_INITIAL = [0x6A09E667, 0xBB67AE85, 0x3C6EF372, 0xA54FF53A, 0x510E527F, 0x9B05688C, 0x1F83D9AB, 0x5BE0CD19];
const SHA_STATE = [0xFD9FBEA2, 0x91243CE7, 0xBE499094, 0xCD2E1E0A, 0x6C006F49, 0x04BD35AB, 0xFEB0A7E4, 0x03EFFBD2];
const SHA_SCHEDULE = [0xEB24BF9E, 0x1558691F, 0xA0C09EE2, 0x0CFA32BA, 0xA622EE8C, 0xD1DD9491, 0xC0DD25A0, 0xF9E70AB6,
  0xF0C31573, 0x7058CE4E, 0x7188E606, 0x00E5AB33, 0xD258B060, 0x72766564];
const K = [
  0x428A2F98, 0x71374491, 0xB5C0FBCF, 0xE9B5DBA5, 0x3956C25B, 0x59F111F1, 0x923F82A4, 0xAB1C5ED5,
  0xD807AA98, 0x12835B01, 0x243185BE, 0x550C7DC3, 0x72BE5D74, 0x80DEB1FE, 0x9BDC06A7, 0xC19BF174,
  0xE49B69C1, 0xEFBE4786, 0x0FC19DC6, 0x240CA1CC, 0x2DE92C6F, 0x4A7484AA, 0x5CB0A9DC, 0x76F988DA,
  0x983E5152, 0xA831C66D, 0xB00327C8, 0xBF597FC7, 0xC6E00BF3, 0xD5A79147, 0x06CA6351, 0x14292967,
  0x27B70A85, 0x2E1B2138, 0x4D2C6DFC, 0x53380D13, 0x650A7354, 0x766A0ABB, 0x81C2C92E, 0x92722C85,
  0xA2BFE8A1, 0xA81A664B, 0xC24B8B70, 0xC76C51A3, 0xD192E819, 0xD6990624, 0xF40E3585, 0x106AA070,
  0x19A4C116, 0x1E376C08, 0x2748774C, 0x34B0BCB5, 0x391C0CB3, 0x4ED8AA4A, 0x5B9CCA4F, 0x682E6FF3,
  0x748F82EE, 0x78A5636F, 0x84C87814, 0x8CC70208, 0x90BEFFFA, 0xA4506CEB, 0xBEF9A3F7, 0xC67178F2,
];
const SHA_ADJ = 0xC9DC06A7;
const K_BLOCK = K.slice(0, 14).concat([SHA_ADJ], K.slice(15));
const SIGMA0_ADJ = 0x059C0B80, SIGMA1_ADJ = 0x000B92C0;
const CS64 = [
  [0xE82E91B1, 0xB32700D0], [0x44DE24C6, 0x88DFF51D], [0x3BEB65BC, 0x29514038], [0xC89C5933, 0xB328CBDF],
  [0x8D1EC211, 0xD405B4D5], [0x314EF5D5, 0x26E55F3C], [0xE92491B1, 0x607801C6], [0xF0A5B9D5, 0x82B2C1FB],
  [0x06064CF3, 0xFA51A3DA], [0xDA79FA60, 0x207CC464], [0xBED20560, 0x3C3C74F3], [0x89F9C9F8, 0xD2D14B61],
  [0x35FA38C6, 0xBB04A2C1], [0xCB49E3C6, 0xC5626167],
];
const CS64_FACTOR = 0x82893933, CS64_ADJ0 = 0xF2F90B1A, CS64_ADJ1 = 0x0B1A0000;

function rounds(state, w, first, k) {
  let [a, b, c, d, e, f, g, h] = state;
  for (let i = first; i < 64; i++) {
    const t1 = U(h + U(rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + U(g ^ (e & (f ^ g))) + k[i] + w[i]);
    const t2 = U(U(rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + U((a & b) | (c & (a | b))));
    h = g; g = f; f = e; e = U(d + t1); d = c; c = b; b = a; a = U(t1 + t2);
  }
  return [a, b, c, d, e, f, g, h];
}
function expand(w, from) {
  for (let i = from; i < 64; i++) w[i] = U(sig1(w[i - 2]) + w[i - 7] + sig0(w[i - 15]) + w[i - 16]);
}
function shaInit(d7) {
  const w = new Array(14).fill(0);
  w.push(U((d7[0] << 16) | (d7[1] << 8) | d7[2]));
  w.push(d7.readUInt32BE(3));
  for (let i = 16; i < 30; i++) {
    let v = SHA_SCHEDULE[i - 16];
    v += i === 16 ? U(sig1(w[i - 2]) ^ SIGMA1_ADJ) : sig1(w[i - 2]);
    if (i - 7 >= 14) v += w[i - 7];
    if (i - 15 >= 14) v += i === 29 ? U(sig0(w[i - 15]) ^ SIGMA0_ADJ) : sig0(w[i - 15]);
    w.push(U(v));
  }
  w.push(U(sig1(w[28]) + w[23] + sig0(w[15]) + w[14] + SHA_ADJ - K[14]));
  expand(w, 31);
  const working = rounds(SHA_STATE, w, 14, K_BLOCK);
  return SHA_INITIAL.map((x, i) => U(x + working[i]));
}
function shaDigest(data) {
  const length = 57 + data.length;
  const zeros = (((55 - length) % 64) + 64) % 64;
  const len = Buffer.alloc(8);
  len.writeBigUInt64BE(BigInt(length * 8));
  const padded = Buffer.concat([data.subarray(7), Buffer.from([0x80]), Buffer.alloc(zeros), len]);
  let state = shaInit(data.subarray(0, 7));
  for (let off = 0; off < padded.length; off += 64) {
    const w = [];
    for (let i = 0; i < 16; i++) w.push(padded.readUInt32BE(off + i * 4));
    expand(w, 16);
    const working = rounds(state, w, 0, K);
    state = state.map((x, i) => U(x + working[i]));
  }
  const out = Buffer.alloc(32);
  state.forEach((x, i) => out.writeUInt32BE(x, i * 4));
  return out;
}
const mul = (a, b) => U(Math.imul(a, b));
function cs64Digest(data, digest) {
  const keyA = U(digest.readUInt32LE(0) | 1), keyB = U(digest.readUInt32LE(4) | 1);
  const factors = [mul(keyA, CS64_FACTOR), mul(keyB, CS64_FACTOR)];
  const terms = CS64.map(([c], i) => mul(c, factors[i % 2]));
  const offsets = CS64.map(([, o]) => o);
  const raw = Buffer.concat([Buffer.from([0]), data]);
  const padded = Buffer.concat([raw, Buffer.alloc((4 - (raw.length % 4)) % 4)]);
  const words = [];
  for (let i = 0; i < padded.length; i += 4) words.push(padded.readUInt32LE(i));
  if (words.length % 2) words.push(0);
  words.forEach((word, i) => {
    let term = mul(word, i % 2 === 0 ? keyA : keyB);
    let off = mul(rol16(word), i % 2 === 0 ? 0xEF0569FB : 0xC31713DB);
    if (i === 0) { term = U(term + mul(CS64_ADJ0, factors[0])); off = U(off + CS64_ADJ1); }
    terms.push(term); offsets.push(off);
  });
  let swapAcc = 0, swapLast = 0, state = 0, acc = 0;
  for (let i = 0; i < terms.length; i += 2) {
    const x = terms[i], y = terms[i + 1];
    let t = rol16(U(offsets[i] + x));
    let q = mul(t, 0x76F50F34);
    swapAcc = U(swapAcc + U(mul(rol16(q), 0xC3EFEA97) + q));
    t = rol16(U(offsets[i + 1] + y));
    q = mul(t, 0x1881CE3C);
    swapLast = U(mul(rol16(q), 0x35BD1EC9) + q);
    swapAcc = U(swapAcc + swapLast);
    state = U(mul(state, keyA) + x);
    state = mul(rol16(state), 0xCF98B111);
    state = mul(rol16(state), 0x87085B9F);
    state = mul(rol16(state), 0x12CEB96D);
    state = mul(rol16(state), 0x257E1D83);
    acc = U(acc + state);
    t = U(mul(state, keyB) + y);
    t = mul(rol16(t), 0xA27416F5);
    t = mul(rol16(t), 0xD38396FF);
    state = mul(rol16(mul(rol16(t), 0x7C932B89)), 0xBFA49F69);
    acc = U(acc + state);
  }
  return [U(swapLast ^ state), U(swapAcc ^ acc)];
}

let clockSkew = 0;   // seconds, corrected from the server's Date header after a 403
function secMsGec(unixSeconds) {
  let s = (unixSeconds ?? Date.now() / 1000 + clockSkew) + 11644473600;
  s = Math.floor(s / 300) * 300;
  const data = Buffer.from(String(BigInt(s) * 10000000n) + TRUSTED_CLIENT_TOKEN, 'ascii');
  const digest = shaDigest(data);
  const [c0, c1] = cs64Digest(data, digest);
  const cs = Buffer.alloc(8); cs.writeUInt32LE(c0, 0); cs.writeUInt32LE(c1, 4);
  return `${cs.toString('hex').toUpperCase()}-${digest.toString('hex').toUpperCase()}`;
}

// ---------- synthesis ----------
const xmlEscape = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
const jsDate = () => new Date().toUTCString().replace(/^(\w+), (\d+) (\w+) (\d+) /, '$1 $3 $2 $4 ').replace('GMT', 'GMT+0000 (Coordinated Universal Time)');
const signed = (n, unit) => `${n >= 0 ? '+' : ''}${Math.round(n)}${unit}`;

function synthesizeOnce({ text, voice, rate = 0, pitch = 0, volume = 0, timeoutMs = 15000, signal }) {
  return new Promise((resolve, reject) => {
    const url = `${WSS_URL}&ConnectionId=${crypto.randomUUID().replace(/-/g, '')}&Sec-MS-GEC=${secMsGec()}&Sec-MS-GEC-Version=${SEC_MS_GEC_VERSION}`;
    const ws = new WebSocket(url, { headers: { ...HEADERS, Cookie: `muid=${crypto.randomBytes(16).toString('hex').toUpperCase()};` }, perMessageDeflate: true, handshakeTimeout: Math.min(timeoutMs, 10000) });
    const chunks = [];
    let finished = false;
    const done = (err, val) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
      try { ws.terminate(); } catch (_) {}
      err ? reject(err) : resolve(val);
    };
    const onAbort = () => done(Object.assign(new Error('aborted'), { code: 'aborted' }));
    if (signal) { if (signal.aborted) return onAbort(); signal.addEventListener('abort', onAbort); }
    const timer = setTimeout(() => done(Object.assign(new Error('Edge 语音超时'), { code: 'timeout' })), timeoutMs);
    ws.on('unexpected-response', (_req, res) => {
      const err = Object.assign(new Error(`Edge 语音被拒绝（HTTP ${res.statusCode}）`), { code: 'http', status: res.statusCode, serverDate: res.headers.date });
      done(err);
    });
    ws.on('error', (e) => done(Object.assign(new Error('Edge 语音连不上：' + (e.code || e.message)), { code: 'net' })));
    ws.on('open', () => {
      ws.send(`X-Timestamp:${jsDate()}\r\nContent-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n` +
        '{"context":{"synthesis":{"audio":{"metadataoptions":{"sentenceBoundaryEnabled":"false","wordBoundaryEnabled":"false"},"outputFormat":"audio-24khz-48kbitrate-mono-mp3"}}}}\r\n');
      const ssml = `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='en-US'><voice name='${voice}'>` +
        `<prosody pitch='${signed(pitch, 'Hz')}' rate='${signed(rate, '%')}' volume='${signed(volume, '%')}'>${xmlEscape(text)}</prosody></voice></speak>`;
      ws.send(`X-RequestId:${crypto.randomUUID().replace(/-/g, '')}\r\nContent-Type:application/ssml+xml\r\nX-Timestamp:${jsDate()}Z\r\nPath:ssml\r\n\r\n${ssml}`);
    });
    ws.on('message', (data, isBinary) => {
      if (isBinary) {
        const buf = Buffer.isBuffer(data) ? data : Buffer.concat(data);
        if (buf.length < 2) return;
        const hl = buf.readUInt16BE(0);
        const head = buf.subarray(2, 2 + hl).toString('utf8');
        if (!/Path:audio/i.test(head)) return;
        const body = buf.subarray(2 + hl);
        if (body.length) chunks.push(body);
      } else {
        const s = data.toString();
        if (/Path:turn\.end/i.test(s)) {
          if (!chunks.length) return done(Object.assign(new Error('Edge 语音没有返回声音'), { code: 'empty' }));
          done(null, Buffer.concat(chunks));
        }
      }
    });
    ws.on('close', () => done(chunks.length ? null : Object.assign(new Error('Edge 语音连接被关闭'), { code: 'closed' }), Buffer.concat(chunks)));
  });
}

async function synthesize(opts) {
  try {
    return await synthesizeOnce(opts);
  } catch (e) {
    // a 403 usually means our clock is off: adopt the server's clock and try once more
    if (e.code === 'http' && e.status === 403 && e.serverDate) {
      const server = Date.parse(e.serverDate);
      if (Number.isFinite(server)) {
        clockSkew = server / 1000 - Date.now() / 1000;
        return synthesizeOnce(opts);
      }
    }
    throw e;
  }
}

const VOICES = [
  { id: 'zh-CN-XiaoyiNeural', name: '晓伊（活泼）' },
  { id: 'zh-CN-XiaoxiaoNeural', name: '晓晓（温柔）' },
  { id: 'zh-CN-liaoning-XiaobeiNeural', name: '晓北（东北话）' },
  { id: 'zh-CN-shaanxi-XiaoniNeural', name: '晓妮（陕西话）' },
  { id: 'zh-TW-HsiaoYuNeural', name: '曉雨（台湾腔）' },
  { id: 'zh-TW-HsiaoChenNeural', name: '曉臻（台湾腔）' },
  { id: 'zh-HK-HiuGaaiNeural', name: '曉佳（粤语）' },
  { id: 'zh-HK-HiuMaanNeural', name: '曉曼（粤语）' },
  { id: 'zh-CN-YunxiaNeural', name: '云夏（小男孩）' },
  { id: 'ja-JP-NanamiNeural', name: '七海（日语）' },
];

module.exports = { synthesize, secMsGec, VOICES };
