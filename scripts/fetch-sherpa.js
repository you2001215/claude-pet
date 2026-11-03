#!/usr/bin/env node
// Downloads the sherpa-onnx native runtime (offline speech engine) into vendor/sherpa.
// It is not kept in git (≈90 MB of binaries); run once before `npm start` or building:
//   node scripts/fetch-sherpa.js            -> this computer's platform (for npm start)
//   node scripts/fetch-sherpa.js win mac    -> what the Windows and macOS builds bundle
//   add --verify (the dist scripts and CI do) -> only folders this script downloaded and checked itself count
// Every tarball is checked against the sha512 pinned below before it is unpacked, because these binaries end up
// inside the installer: a tampered registry copy must stop the build, not ship. Without --verify (npm start), a
// folder of the right version that an older copy of this script fetched without checking is kept as it is, so an
// existing checkout doesn't download ~90 MB again (and npm start doesn't need the network for it).
'use strict';
const { execFileSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const VERSION = '1.13.8';
const DEST = path.join(__dirname, '..', 'vendor', 'sherpa');
const PLATFORM_PKG = { win: 'sherpa-onnx-win-x64', mac: 'sherpa-onnx-darwin-arm64', 'mac-x64': 'sherpa-onnx-darwin-x64', linux: 'sherpa-onnx-linux-x64' };
// npm view <pkg>@1.13.8 dist.integrity  (update together with VERSION)
const INTEGRITY = {
  'sherpa-onnx-node': 'sha512-MsDMBdhLFTZ1GwvcGSSQhnS7g/EA8OMH6IYysCVUOM7j8Icty9KRc0E6YT1A5fWBsZwRfKOeh88QC95aRvS8ag==',
  'sherpa-onnx-win-x64': 'sha512-oZF1c9VPOKtMwn83Bboc5XSWL+76BRoyB3eUuVnCknBKxwSULZU2Foia9VHWzU+n4I12rPsP6z6H9Rp1hD9o8g==',
  'sherpa-onnx-darwin-arm64': 'sha512-FPNgJMgnWVl/KhRTIhG3KL3A4Om63Rn4YKXc9/uHY7SzLcvqLJLc/h7UBWJwduXvv7K18t5NpxHR6XgXn4sjWw==',
  'sherpa-onnx-darwin-x64': 'sha512-7BLRpjM6w4f9W46/nmkmq8lEKUayhebvcpslCVQ+6QN2uReYlZEMDZlSpXMjme+hUFrPfRz8P3UNq8ep/4d19g==',
  'sherpa-onnx-linux-x64': 'sha512-6plnhjagsSeTntCgnlag86hWbs/uZE9Crms1LgOb68/1nKsIQjMd+WG519m+aPwT6TrsBOiEMzrx41t8sL5L5g==',
};

function here() {
  if (process.platform === 'win32') return 'win';
  if (process.platform === 'darwin') return process.arch === 'arm64' ? 'mac' : 'mac-x64';
  return 'linux';
}

const args = process.argv.slice(2);
const verify = args.includes('--verify');
const targets = args.filter((a) => a !== '--verify');
const wanted = targets.length ? targets : [here()];
const pkgs = ['sherpa-onnx-node', ...wanted.map((w) => {
  if (!PLATFORM_PKG[w]) { console.error(`unknown target "${w}" (use: ${Object.keys(PLATFORM_PKG).join(', ')})`); process.exit(1); }
  return PLATFORM_PKG[w];
})];

const sri = (file) => 'sha512-' + crypto.createHash('sha512').update(fs.readFileSync(file)).digest('base64');
// sits next to the package folder (not inside it, so it is not copied into the installer by extraResources)
const markerOf = (name) => path.join(DEST, name + '.integrity');
const UNCHECKED = ' unchecked';   // marker of a folder kept from before the check existed
// ok: downloaded and checked here | unchecked: the right version, not checked | missing: anything else
function state(name) {
  let version = null, mark = '';
  try { version = JSON.parse(fs.readFileSync(path.join(DEST, name, 'package.json'), 'utf8')).version; } catch (_) {}
  if (version !== VERSION) return 'missing';
  try { mark = fs.readFileSync(markerOf(name), 'utf8').trim(); } catch (_) {}
  if (mark === INTEGRITY[name]) return 'ok';
  return !mark || mark === INTEGRITY[name] + UNCHECKED ? 'unchecked' : 'missing';
}

fs.mkdirSync(DEST, { recursive: true });
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
// Windows' own tar (bsdtar). In Git Bash, "tar" is GNU tar, which reads "C:\..." as host "C" and fails
const winTar = process.platform === 'win32' && path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
const tar = winTar && fs.existsSync(winTar) ? winTar : 'tar';
for (const name of pkgs) {
  const out = path.join(DEST, name);
  const st = state(name);
  if (st === 'ok') { console.log(`ok   ${name}@${VERSION}`); continue; }
  if (st === 'unchecked' && !verify) {
    try { fs.writeFileSync(markerOf(name), INTEGRITY[name] + UNCHECKED + '\n'); } catch (_) {}
    console.log(`ok   ${name}@${VERSION}（之前下载的，没重新校验；打包前会用 --verify 重新下载校验）`);
    continue;
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sherpa-'));
  try {
    console.log(`get  ${name}@${VERSION}`);
    // run inside tmp with relative names: no quoting trouble with spaces or Chinese in the user's temp path
    // (npm.cmd needs a shell on Windows), and GNU tar never sees a drive letter
    const file = execFileSync(npm, ['pack', `${name}@${VERSION}`, '--silent'], { cwd: tmp, encoding: 'utf8', shell: process.platform === 'win32' }).trim().split(/\r?\n/).pop().trim();
    const got = sri(path.join(tmp, file));
    if (got !== INTEGRITY[name]) {
      console.error(`\n${name}@${VERSION} 校验失败：下载到的文件和记录的不一样，已停止（没有解压）。\n` +
        `  expected ${INTEGRITY[name]}\n  got      ${got}\n` +
        'The download does not match the pinned sha512. Check the npm registry / mirror you use; if sherpa-onnx was\n' +
        'upgraded on purpose, update VERSION and INTEGRITY in scripts/fetch-sherpa.js.');
      process.exitCode = 1;
      break;
    }
    execFileSync(tar, ['-xzf', file], { cwd: tmp });
    fs.rmSync(markerOf(name), { force: true });   // no marker while the folder is half replaced
    fs.rmSync(out, { recursive: true, force: true });
    fs.cpSync(path.join(tmp, 'package'), out, { recursive: true });   // copy, not rename: the temp folder may be on another drive
    fs.writeFileSync(markerOf(name), INTEGRITY[name] + '\n');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
if (!process.exitCode) console.log('sherpa-onnx runtime ready in vendor/sherpa');
