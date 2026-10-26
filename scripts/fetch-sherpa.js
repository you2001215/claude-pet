#!/usr/bin/env node
// Downloads the sherpa-onnx native runtime (offline speech engine) into vendor/sherpa.
// It is not kept in git (≈90 MB of binaries); run once before `npm start` or building:
//   node scripts/fetch-sherpa.js            -> this computer's platform (for npm start)
//   node scripts/fetch-sherpa.js win mac    -> what the Windows and macOS builds bundle
'use strict';
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const VERSION = '1.13.8';
const DEST = path.join(__dirname, '..', 'vendor', 'sherpa');
const PLATFORM_PKG = { win: 'sherpa-onnx-win-x64', mac: 'sherpa-onnx-darwin-arm64', 'mac-x64': 'sherpa-onnx-darwin-x64', linux: 'sherpa-onnx-linux-x64' };

function here() {
  if (process.platform === 'win32') return 'win';
  if (process.platform === 'darwin') return process.arch === 'arm64' ? 'mac' : 'mac-x64';
  return 'linux';
}

const wanted = process.argv.slice(2).length ? process.argv.slice(2) : [here()];
const pkgs = ['sherpa-onnx-node', ...wanted.map((w) => {
  if (!PLATFORM_PKG[w]) { console.error(`unknown target "${w}" (use: ${Object.keys(PLATFORM_PKG).join(', ')})`); process.exit(1); }
  return PLATFORM_PKG[w];
})];

fs.mkdirSync(DEST, { recursive: true });
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
for (const name of pkgs) {
  const out = path.join(DEST, name);
  try {
    if (JSON.parse(fs.readFileSync(path.join(out, 'package.json'), 'utf8')).version === VERSION) { console.log(`ok   ${name}@${VERSION}`); continue; }
  } catch (_) { /* not there yet */ }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sherpa-'));
  console.log(`get  ${name}@${VERSION}`);
  const file = execFileSync(npm, ['pack', `${name}@${VERSION}`, '--silent', '--pack-destination', tmp], { encoding: 'utf8', shell: process.platform === 'win32' }).trim().split(/\r?\n/).pop();
  execFileSync('tar', ['-xzf', path.join(tmp, file), '-C', tmp]);
  fs.rmSync(out, { recursive: true, force: true });
  fs.cpSync(path.join(tmp, 'package'), out, { recursive: true });   // copy, not rename: the temp folder may be on another drive
  fs.rmSync(tmp, { recursive: true, force: true });
}
console.log('sherpa-onnx runtime ready in vendor/sherpa');
