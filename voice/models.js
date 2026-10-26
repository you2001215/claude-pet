'use strict';
// On-demand model downloads (pinned revisions, size + sha256 checked, resumable).
// Sources: hf-mirror.com first (fast in mainland China), then huggingface.co.
const { app, net } = require('electron');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SOURCES = process.env.PET_MODEL_SOURCES ? process.env.PET_MODEL_SOURCES.split(',') : ['https://hf-mirror.com', 'https://huggingface.co'];

const CATALOG = {
  asr: {
    title: '语音识别模型（SenseVoice）',
    dir: 'sensevoice-int8-2024-07-17',
    repo: 'csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17',
    rev: '2365baeacb507f821a0c8120fcee3d484dba7a07',
    files: [
      { name: 'model.int8.onnx', bytes: 239233841, sha256: 'c71f0ce00bec95b07744e116345e33d8cbbe08cef896382cf907bf4b51a2cd51' },
      { name: 'tokens.txt', bytes: 315894, sha256: 'f449eb28dc567533d7fa59be34e2abca8784f771850c78a47fb731a31429a1dc' },
    ],
  },
  tts: {
    title: '离线语音模型（Kokoro）',
    dir: 'kokoro-int8-multi-lang-v1_1',
    repo: 'csukuangfj/kokoro-int8-multi-lang-v1_1',
    rev: '155831f1b4ba23b1f5c058be6a61df90cefb2a37',
    files: [
      { name: 'model.int8.onnx', bytes: 114299010, sha256: 'bda15858163726a492d02a9a727bc263551b86ac77f90812c4b30ff41d380e26' },
      { name: 'voices.bin', bytes: 53790720, sha256: 'e64a5a581d8c2a350d848f51c3121657cd83aa07ed6109172177345874a7244c' },
      { name: 'lexicon-us-en.txt', bytes: 5956885, sha256: '7daaab53a181be9885b853a8582bf1838186317e5dadacbcef9c426d6fa0da14' },
      { name: 'lexicon-zh.txt', bytes: 2119465, sha256: '11111d8cd695fba2ace1367a1d0a708b586e6ef5c1f9be91da5d7eef129b651c' },
      { name: 'tokens.txt', bytes: 1111, sha256: '931ab2df2400cd65d580a22402024c2347ced8ae9ea300e545144b1aacc48e14' },
      { name: 'phone-zh.fst', bytes: 88630, sha256: '1ac2b6fa56b1442320c4de7db08353bab8963a2b57f365eebcdd3a2d3562f8d7' },
      { name: 'date-zh.fst', bytes: 59154, sha256: 'eb8aa079ae3cb81d8f4404992f39d61a0cb990947512b5b8d1e54d1f6980e718' },
      { name: 'number-zh.fst', bytes: 64482, sha256: '743f402181fcfebf76cc2f0546b71fa26476e626fbe4e460fb7b4c3a7a8bd5bd' },
      { name: 'LICENSE', bytes: 11358, sha256: 'cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30' },
      // the part of espeak-ng-data Kokoro needs for English words
      { name: 'espeak-ng-data/en_dict', bytes: 166944, sha256: '71bd330ba8a2e3e8076e631508208ef49449d6147c17b7bd2b4b1e1468292e35' },
      { name: 'espeak-ng-data/intonations', bytes: 2040, sha256: '3f8af65fd3eda9759a10f021d61361c120871f463515229c925995c7f90918cc' },
      { name: 'espeak-ng-data/phondata', bytes: 550424, sha256: '4e0288957874029a8c3c9f41a8f517ad4bf18127046decbdd4b9d1d6807ce3a3' },
      { name: 'espeak-ng-data/phonindex', bytes: 39074, sha256: '3ca7b8fa3b42624e4b0f152707e7a39245fce569aa99ea47c055d9e622fcf0c4' },
      { name: 'espeak-ng-data/phontab', bytes: 55796, sha256: '886f3fa402cb0ba73d483aa8ad000af47a6b7cc06293c75a97913fba68a530f6' },
      { name: 'espeak-ng-data/lang/gmw/en', bytes: 140, sha256: '4605d5330801de3641c6e366d15f129ea1f5ffbce8722642aba01ace07ab9c83' },
      { name: 'espeak-ng-data/lang/gmw/en-US', bytes: 257, sha256: '41534c2a22df5dd4f1052ff9e1a33a3ea7bff5a26b5c02bdad5ba8ddb7524704' },
    ],
  },
};
for (const m of Object.values(CATALOG)) m.total = m.files.reduce((s, f) => s + f.bytes, 0);

let root = null;
function rootDir() {
  if (!root) root = process.env.PET_VOICE_MODELS || path.join(app.getPath('userData'), 'voice-models');
  return root;
}
const dirOf = (id) => path.join(rootDir(), CATALOG[id].dir);

function isInstalled(id) {
  const m = CATALOG[id];
  try {
    const mark = JSON.parse(fs.readFileSync(path.join(dirOf(id), '.ok.json'), 'utf8'));
    if (mark.rev !== m.rev) return false;
    return m.files.every((f) => { try { return fs.statSync(path.join(dirOf(id), f.name)).size === f.bytes; } catch (_) { return false; } });
  } catch (_) { return false; }
}

const jobs = {};   // id -> { abort, progress }
function status(id) {
  const m = CATALOG[id];
  const j = jobs[id];
  return { id, title: m.title, total: m.total, installed: isInstalled(id), downloading: !!j, progress: j ? j.progress : null, dir: dirOf(id) };
}

function sha256File(file, upto) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    const s = fs.createReadStream(file, upto != null ? { end: upto - 1 } : {});
    s.on('data', (d) => h.update(d));
    s.on('end', () => resolve(h));
    s.on('error', reject);
  });
}

let preferred = 0;   // the source that worked last time goes first
async function fetchFile(m, f, dest, onBytes, signal) {
  const part = dest + '.part';
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  let lastErr = null;
  const order = SOURCES.map((_, i) => (i + preferred) % SOURCES.length);
  for (const si of order) {
    const src = SOURCES[si];
    const url = `${src}/${m.repo}/resolve/${m.rev}/${f.name}`;
    for (let attempt = 0; attempt < 2; attempt++) {
      if (signal.aborted) throw Object.assign(new Error('已取消'), { code: 'aborted' });
      let have = 0;
      try { have = fs.statSync(part).size; } catch (_) {}
      if (have > f.bytes) { fs.rmSync(part, { force: true }); have = 0; }
      // per-attempt abort: the user's cancel, or no data for a while (a stuck mirror)
      const ctrl = new AbortController();
      const onCancel = () => ctrl.abort();
      signal.addEventListener('abort', onCancel);
      let stalled = false, idle = null;
      const kick = (ms) => { clearTimeout(idle); idle = setTimeout(() => { stalled = true; ctrl.abort(); }, ms); };
      try {
        kick(25000);
        const headers = have > 0 && have < f.bytes ? { Range: `bytes=${have}-` } : {};
        let hash;
        let res = null;
        if (have < f.bytes) {
          res = await net.fetch(url, { headers, signal: ctrl.signal, cache: 'no-store' });
          if (res.status === 200) { have = 0; hash = crypto.createHash('sha256'); }
          else if (res.status === 206 && have > 0) hash = await sha256File(part, have);
          else throw Object.assign(new Error(`HTTP ${res.status}`), { code: 'http', status: res.status });
        } else hash = await sha256File(part, f.bytes);
        onBytes(have, src);
        if (res) {
          const out = fs.createWriteStream(part, { flags: have > 0 ? 'a' : 'w' });
          const reader = res.body.getReader();
          try {
            for (;;) {
              const { done, value } = await reader.read();
              if (done) break;
              const buf = Buffer.from(value);
              kick(30000);
              hash.update(buf);
              have += buf.length;
              if (!out.write(buf)) await new Promise((r) => out.once('drain', r));
              onBytes(have, src);
              if (have > f.bytes) throw new Error('文件比预期大');
            }
          } finally { await new Promise((r) => out.end(r)); }
        }
        if (have !== f.bytes) throw new Error(`下载不完整（${have}/${f.bytes}）`);
        const digest = hash.digest('hex');
        if (digest !== f.sha256) { fs.rmSync(part, { force: true }); throw new Error('校验失败（文件内容不对）'); }
        fs.renameSync(part, dest);
        preferred = si;
        return;
      } catch (e) {
        if (signal.aborted) throw Object.assign(new Error('已取消'), { code: 'aborted' });
        lastErr = stalled ? new Error('连接卡住了') : e;
        // a 4xx from this source will not get better by retrying it
        if ((e.code === 'http' && e.status >= 400 && e.status < 500) || stalled) break;
      } finally {
        clearTimeout(idle);
        signal.removeEventListener('abort', onCancel);
      }
    }
  }
  throw Object.assign(new Error(`下载 ${f.name} 失败：${lastErr ? lastErr.message : '未知错误'}`), { code: 'download' });
}

// download everything that is missing; onProgress({ done, total, file, source })
function download(id, onProgress) {
  if (jobs[id]) return jobs[id].promise;
  const m = CATALOG[id];
  const ctrl = new AbortController();
  const job = { abort: () => ctrl.abort(), progress: { done: 0, total: m.total, file: '', source: '' } };
  jobs[id] = job;
  let lastEmit = 0;
  const emit = (force) => {
    const t = Date.now();
    if (!force && t - lastEmit < 250) return;
    lastEmit = t;
    try { onProgress && onProgress({ id, ...job.progress }); } catch (_) {}
  };
  job.promise = (async () => {
    const dir = dirOf(id);
    fs.mkdirSync(dir, { recursive: true });
    try { fs.rmSync(path.join(dir, '.ok.json'), { force: true }); } catch (_) {}
    let base = 0;
    for (const f of m.files) {
      const dest = path.join(dir, f.name);
      let ok = false;
      try { ok = fs.statSync(dest).size === f.bytes; } catch (_) {}
      if (!ok) {
        job.progress.file = f.name;
        await fetchFile(m, f, dest, (n, src) => { job.progress.done = base + n; job.progress.source = src; emit(); }, ctrl.signal);
      }
      base += f.bytes;
      job.progress.done = base;
      emit(true);
    }
    fs.writeFileSync(path.join(dir, '.ok.json'), JSON.stringify({ rev: m.rev, at: new Date().toISOString() }));
    return status(id);
  })().finally(() => { delete jobs[id]; emit(true); });
  return job.promise;
}

function cancel(id) { if (jobs[id]) jobs[id].abort(); }
function remove(id) {
  cancel(id);
  fs.rmSync(dirOf(id), { recursive: true, force: true });
  return status(id);
}

module.exports = { CATALOG, status, download, cancel, remove, dirOf, isInstalled };
