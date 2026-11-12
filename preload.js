'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('pet', {
  platform: process.platform,
  setPos: (x, y) => ipcRenderer.send('set-pos', x, y),
  getBounds: () => ipcRenderer.invoke('get-bounds'),
  getCursor: () => ipcRenderer.invoke('get-cursor'),
  getSettings: () => ipcRenderer.invoke('get-settings'),
  ignoreMouse: (v) => ipcRenderer.send('ignore-mouse', !!v),
  contextMenu: () => ipcRenderer.send('context-menu'),
  sleepState: (v) => ipcRenderer.send('sleep-state', !!v),
  onCmd: (fn) => ipcRenderer.on('cmd', (_e, c) => fn(c)),
  onSettings: (fn) => ipcRenderer.on('settings', (_e, s) => fn(s)),
  onAi: (fn) => ipcRenderer.on('ai', (_e, ev) => fn(ev)),
  openChat: () => ipcRenderer.send('ui:open-chat'),
  aiWillGreet: () => ipcRenderer.invoke('ai:will-greet'),
  aiGreet: () => ipcRenderer.send('ai:greet'),
  onVoice: (fn) => {
    for (const ch of ['voice:play', 'voice:stop', 'voice:system']) ipcRenderer.on(ch, (_e, m) => fn(ch, m));
  },
  speakLine: (text) => ipcRenderer.send('voice:line', String(text || '')),
  whisperAI: (ctx) => ipcRenderer.invoke('ai:whisper', ctx),
  voiceStop: () => ipcRenderer.send('voice:stop'),
  pointJump: (ref) => ipcRenderer.send('watch:point-jump', String(ref || '')),
  openScreenSettings: () => ipcRenderer.send('ui:open-screen-settings'),
  // phase ③ (spec 17): her mood and quiet time in, the pet's body stimuli and actions she asked for out
  onMood: (fn) => ipcRenderer.on('pet:mood', (_e, m) => fn(m)),
  onQuiet: (fn) => ipcRenderer.on('pet:quiet', (_e, until) => fn(until)),
  onAct: (fn) => ipcRenderer.on('pet:act', (_e, a) => fn(a)),
  actDone: (id, r) => ipcRenderer.send('pet:act-done', String(id || ''), r && typeof r === 'object' ? { ok: !!r.ok, code: String(r.code || '') } : { ok: false, code: 'busy' }),
  emotion: (cause) => ipcRenderer.send('pet:emotion', String(cause || '')),
  interacted: () => ipcRenderer.send('pet:interact'),
});
