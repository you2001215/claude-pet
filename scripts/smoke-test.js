#!/usr/bin/env node
// Start-up test: runs the unpackaged app with a fresh, temporary user data folder (so it never touches the real
// chat history and doesn't collide with an installed copy's single-instance lock), loads tests/smoke/pet-smoke.js
// inside it through PET_TEST, waits for its JSON result and prints a summary. Exit code 1 when anything failed.
//   npm run test:smoke            (Linux without a screen: runs under xvfb-run automatically)
//   SMOKE_KEEP=1 npm run test:smoke   keeps the temporary folder (result.json, error.log) for a look afterwards
//   node scripts/smoke-test.js tests/smoke/link-smoke.js   runs another in-app script (npm run test:smoke:link)
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const LIMIT_MS = Number(process.env.SMOKE_TIMEOUT_MS) || 240000;
const isWin = process.platform === 'win32', isLinux = process.platform === 'linux';

let electron;
try { electron = require('electron'); } catch (e) { console.error(`electron isn't installed (run npm ci first): ${e.message}`); process.exit(1); }
if (typeof electron !== 'string' || !fs.existsSync(electron)) { console.error(`electron binary not found: ${electron}`); process.exit(1); }

// the long form of the temp path (Windows may hand out C:\Users\RUNNER~1\...)
const tmp = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'claude-pet-smoke-'));
const userData = path.join(tmp, 'userData');
const out = path.join(tmp, `result-${process.pid}-${Date.now()}.json`);
const script = process.argv[2] ? path.resolve(process.argv[2]) : path.join(ROOT, 'tests', 'smoke', 'pet-smoke.js');
const env = { ...process.env, PET_TEST: script, PET_SMOKE_OUT: out };
delete env.ELECTRON_RUN_AS_NODE;
// --user-data-dir is what actually moves the data folder on every system; the variables are a second fence
if (isLinux) env.XDG_CONFIG_HOME = path.join(tmp, 'config');
if (isWin) { env.APPDATA = path.join(tmp, 'AppData', 'Roaming'); fs.mkdirSync(env.APPDATA, { recursive: true }); }

let cmd = electron;
let args = [...(isLinux ? ['--no-sandbox'] : []), `--user-data-dir=${userData}`, ROOT];
if (isLinux && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) { args = ['-a', cmd, ...args]; cmd = 'xvfb-run'; }

console.log(`smoke: ${path.basename(cmd)} … (${process.platform} ${process.arch}), data in ${tmp}`);
const tail = [];
const keep = (buf) => { for (const l of String(buf).split(/\r?\n/)) if (l.trim()) { tail.push(l); if (tail.length > 120) tail.shift(); } };
// its own process group on Linux/macOS, so a stuck run can be stopped with xvfb and every helper process
const child = spawn(cmd, args, { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'], detached: !isWin, windowsHide: true });
child.stdout.on('data', keep);
child.stderr.on('data', keep);
let exited = false, exitInfo = '';
child.on('error', (e) => { exited = true; exitInfo = e.code === 'ENOENT' ? `cannot start ${cmd} (on Linux without a screen, install xvfb)` : e.message; });
child.on('exit', (code, sig) => { exited = true; exitInfo = exitInfo || `exit code ${code}${sig ? `, signal ${sig}` : ''}`; });

function stop() {
  if (exited) return;
  try { if (isWin) child.kill(); else process.kill(-child.pid, 'SIGKILL'); } catch (_) { try { child.kill('SIGKILL'); } catch (__) {} }
}
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { stop(); process.exit(1); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const start = Date.now();
  let resultAt = 0, timedOut = false;
  while (!exited) {
    if (!resultAt && fs.existsSync(out)) resultAt = Date.now();
    if (resultAt && Date.now() - resultAt > 20000) { stop(); break; }   // result is in but the app hangs on the way out
    if (Date.now() - start > LIMIT_MS) { timedOut = true; stop(); break; }
    await sleep(300);
  }
  await sleep(500);
  let r = null;
  try { r = JSON.parse(fs.readFileSync(out, 'utf8')); } catch (_) {}
  if (!r) {
    console.error(`\nsmoke: FAILED, no result (${timedOut ? `timed out after ${LIMIT_MS / 1000} s` : exitInfo}). Last output of the app:`);
    console.error(tail.slice(-60).join('\n') || '(nothing)');
    console.error(`kept: ${tmp}`);
    process.exit(1);
  }
  const mark = (ok) => (ok === null ? '-' : ok ? '✔' : '✘');
  console.log(`\n大肥鱼启动测试（${path.basename(script)}）  ${r.version}  ${r.platform}  Electron ${r.electron}`);
  for (const c of r.checks) console.log(`  ${mark(c.ok)} ${c.name}${c.detail ? `  ${c.detail}` : ''}`);
  console.log(`  ${mark(!r.consoleErrors.length)} 渲染进程没有报错${r.consoleErrors.length ? '：' : ''}`);
  for (const m of r.consoleErrors) console.log(`      ${m}`);
  console.log(`  ${mark(!r.problems.length)} 页面没有崩溃或加载失败${r.problems.length ? '：' : ''}`);
  for (const m of r.problems) console.log(`      ${m}`);
  console.log(`  ${mark(!r.errorLog.trim())} error.log 是空的${r.errorLog.trim() ? '：' : ''}`);
  if (r.errorLog.trim()) console.log(r.errorLog.trim().split('\n').slice(-20).map((l) => '      ' + l).join('\n'));
  if (r.timeout) console.log('  ✘ the in-app script hit its own time limit');
  const failed = r.checks.filter((c) => c.ok === false).length;
  console.log(`\n${r.ok ? 'PASS' : 'FAIL'}: ${r.checks.filter((c) => c.ok).length} passed, ${failed} failed, ${r.checks.filter((c) => c.ok === null).length} skipped`);
  if (!r.ok || process.env.SMOKE_KEEP) console.log(`kept: ${tmp}`);
  else {
    // Chromium helpers or a virus scan may still hold files in the profile for a moment (Windows): retry, never fail
    try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch (e) { console.log(`could not delete ${tmp}: ${e.code || e.message}`); }
  }
  process.exit(r.ok ? 0 : 1);
})();
