'use strict';
// Fixed lines for while she is connected through AstrBot: the pet's own AI stays quiet then (user's choice, 11-06),
// so a greeting, a rest nudge and the late-night question use these instead. No 「该……了」: she asks, she doesn't order.
const LINES = {
  startup: ['我来啦～', '嘿嘿，又见面了', '今天也在这儿陪你哦～'],
  rest: ['坐好久啦，起来动一动？', '眼睛累不累呀，看看远处吧～', '喝口水，歇一小会儿嘛'],
  sleep: ['还不睡呀？', '这么晚了，还在忙吗？', '夜深啦…你困不困？'],
};
const pick = (a) => a[Math.floor(Math.random() * a.length)];
const line = (kind) => (LINES[kind] ? pick(LINES[kind]) : '');
module.exports = { LINES, line };
