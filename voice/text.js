'use strict';
// Text clean-up before speaking. Plain Node (no electron) so tests can require it directly.

function cleanForSpeech(t) {
  let s = String(t || '');
  s = s.replace(/\[(?:sticker|表情)[:：][^\]\n]*\]/giu, '');
  s = s.replace(/<[^>]{1,80}>/g, '');
  s = s.replace(/[（(][^（）()\n]{0,16}[）)]/g, '');           // （歪头） stage directions and (≧▽≦) faces
  s = s.replace(/\*[^*\n]{1,16}\*/g, '');                      // *叉腰*
  s = s.replace(/https?:\/\/\S+/g, '这个链接');
  s = s.replace(/[\p{Extended_Pictographic}\u{1F1E6}-\u{1F1FF}\u{1F3FB}-\u{1F3FF}️‍]/gu, '');
  s = s.replace(/[♪♫♬★☆♥♡❤✧✦✨・ω]+/g, '');
  s = s.replace(/[~～]{2,}/g, '～');
  s = s.replace(/\s+/g, ' ').trim();
  return Array.from(s).slice(0, 400).join('');
}
const speakable = (s) => /[\p{L}\p{N}]/u.test(s);
// split into pieces of at most ~max characters, preferring sentence ends, then commas
function splitForSpeech(s, max) {
  const sentences = s.match(/[^。！？!?；;\n]+[。！？!?；;\n]*|[。！？!?；;\n]+/g) || [s];
  const out = [];
  let cur = '';
  const push = (t) => { if (t.trim()) out.push(t.trim()); };
  for (let sen of sentences) {
    while (Array.from(sen).length > max) {
      const a = Array.from(sen);
      let cut = a.slice(0, max).join('').search(/[，,、：:][^，,、：:]*$/);
      cut = cut > max / 3 ? cut + 1 : max;
      push(cur); cur = '';
      push(a.slice(0, cut).join(''));
      sen = a.slice(cut).join('');
    }
    if (Array.from(cur + sen).length > max) { push(cur); cur = sen; } else cur += sen;
  }
  push(cur);
  return out.length ? out : [s];
}
function forKokoro(s) {
  return s
    .replace(/claude/gi, '克劳德')
    .replace(/deep\s?seek/gi, '迪普西克')
    .replace(/(\d{1,2})[:：](\d{2})/g, (_, h, m) => `${+h}点${m === '00' ? '' : (+m) + '分'}`)
    .replace(/[!！]+\s*(?=[A-Za-z])/g, '。')
    .replace(/～/g, '，');
}

module.exports = { cleanForSpeech, splitForSpeech, forKokoro, speakable };
