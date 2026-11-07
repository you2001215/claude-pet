#!/usr/bin/env node
// CI only (macOS). Signs the packaged app with a fixed certificate, and checks the result.
//   node scripts/mac-sign.js sign  <ClaudePet.app> <cert sha1> <keychain>
//   node scripts/mac-sign.js check <ClaudePet.app> <cert sha1> [file with the expected sha1]
// Why: an ad-hoc signature's designated requirement is only the cdhash, which changes with every build, so macOS
// forgets the screen recording and microphone permissions after each update. Signed with the same certificate, the
// requirement is `identifier "com.fanmade.claudepet" and certificate leaf = H"<sha1>"` and stays the same.
// `check` fails (no package) when the requirement is anything else, or names another certificate than expected.
'use strict';
const { execFileSync } = require('child_process');
const fs = require('fs');

const APP_ID = 'com.fanmade.claudepet';
const [cmd, app, sha1Arg, extra] = process.argv.slice(2);
const sha1 = String(sha1Arg || '').toLowerCase();
const die = (m) => { console.error(`::error::${m}`); process.exit(1); };
if (!app || !/^[0-9a-f]{40}$/.test(sha1)) die('usage: mac-sign.js sign|check <app> <sha1> [keychain|expected-file]');

async function sign() {
  const { sign: osxSign } = require('@electron/osx-sign');
  await osxSign({
    app, platform: 'darwin', identity: sha1, identityValidation: false, keychain: extra,
    preAutoEntitlements: false,
    // same as the ad-hoc build: no hardened runtime (package.json build.mac.hardenedRuntime)
    optionsForFile: () => ({ hardenedRuntime: false }),
  });
  execFileSync('codesign', ['--verify', '--deep', '--strict', app], { stdio: 'inherit' });
  console.log('signed with the fixed certificate');
}

function check() {
  const out = execFileSync('codesign', ['-d', '-r-', app], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const line = out.split('\n').find((l) => l.startsWith('designated =>')) || '';
  const dr = line.replace(/^designated =>\s*/, '').trim();
  const m = /^identifier "([^"]+)" and certificate (?:leaf|root) = H"([0-9a-f]{40})"$/i.exec(dr);
  if (!m) die(`designated requirement is not "identifier + certificate": ${dr || '(none)'}`);
  if (m[1] !== APP_ID) die(`designated requirement names ${m[1]}, not ${APP_ID}`);
  if (m[2].toLowerCase() !== sha1) die(`designated requirement names certificate ${m[2]}, not the one just used (${sha1})`);
  if (extra) {
    if (fs.existsSync(extra)) {
      const want = fs.readFileSync(extra, 'utf8').trim().toLowerCase();
      if (want && want !== sha1) die(`certificate changed: expected ${want} (${extra}), got ${sha1}. The owner would have to grant the permissions again.`);
    } else console.log(`::notice::first build with this certificate; its sha1 is ${sha1} — commit it to ${extra} so a changed certificate is caught`);
  }
  console.log(dr);
}

(cmd === 'sign' ? sign() : cmd === 'check' ? Promise.resolve(check()) : Promise.reject(new Error('sign or check')))
  .catch((e) => die(e.message || String(e)));
