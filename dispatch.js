"use strict";
// 2.6: рация диспетчера — окно-рация поверх игры. Говорить: зажать клавишу (radioHotkey) или кнопку PTT на рации.
// Распознавание идёт в окне рации (Vosk, файлы отдаёт протокол senko-voice:// из voice.js), команды выполняет окно памятки (window.SA_radioCmd).
const { BrowserWindow, ipcMain, globalShortcut, screen } = require("electron");
const path = require("path");

const BASE = [236, 540];
const SCALE = { s: 0.8, m: 1, l: 1.2 };
let ctx = null;
let win = null;
let ready = false;
let pending = [];
let last = null; // последнее состояние задержаний от окна памятки
let state = "idle";
let hotkeyActive = null;
let hotkeyError = "";
let drag = null;
const live = () => !!win && !win.isDestroyed();
const k = () => SCALE[ctx.getCfg().radioSize] || 1;
const ww = () => Math.round(BASE[0] * k());
const wh = () => Math.round(BASE[1] * k());

function send(ch, v) {
  if (!live()) return;
  if (!ready) { pending.push([ch, v]); return; }
  win.webContents.send(ch, v);
}
function opts() {
  const c = ctx.getCfg();
  return { voice: !!c.radioVoice, sfx: !!c.radioSfx, rate: c.radioRate, voiceName: c.radioVoiceName || "", pin: !!c.radioPin, hide: c.radioHide, hotkey: c.radioEnabled ? c.radioHotkey : "", mic: c.voiceMic || "", online: !!c.radioOnline };
}
function clampPos(x, y, near) {
  const a = screen.getDisplayNearestPoint(near || { x, y }).workArea;
  return { x: Math.round(Math.min(a.x + a.width - 80, Math.max(a.x - ww() + 80, x))), y: Math.round(Math.min(a.y + a.height - 80, Math.max(a.y - 8, y))) };
}
function startPos() {
  const p = ctx.getCfg().radioPos;
  if (p && Number.isFinite(+p.x) && Number.isFinite(+p.y)) {
    const d = screen.getDisplayNearestPoint({ x: +p.x, y: +p.y }).workArea;
    if (+p.x < d.x + d.width - 40 && +p.y < d.y + d.height - 40) return clampPos(+p.x, +p.y);
  }
  const a = screen.getPrimaryDisplay().workArea;
  return { x: a.x + a.width - ww() - 16, y: a.y + a.height - wh() - 8 };
}
function create() {
  const p = startPos();
  ready = false; pending = [];
  const w = new BrowserWindow({
    width: ww(), height: wh(), x: p.x, y: p.y,
    show: false, frame: false, transparent: true, backgroundColor: "#00000000", hasShadow: false,
    resizable: false, movable: true, minimizable: false, maximizable: false, fullscreenable: false,
    skipTaskbar: true, focusable: false, alwaysOnTop: true,
    webPreferences: {
      contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: false, backgroundThrottling: false,
      autoplayPolicy: "no-user-gesture-required", preload: path.join(__dirname, "radio-preload.js")
    }
  });
  win = w;
  w.setAlwaysOnTop(true, "screen-saver");
  w.loadURL("senko-voice://app/radio.html");
  w.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  w.webContents.on("will-navigate", (e) => e.preventDefault());
  w.webContents.on("did-finish-load", () => { try { w.webContents.setZoomFactor(k()); } catch (e) {} });
  w.once("ready-to-show", () => { if (live()) w.showInactive(); });
  w.on("closed", () => { if (win === w) { win = null; ready = false; state = "idle"; pttStop(); stopDrag(false); } ctx.changed(); });
  return w;
}
function show() {
  if (!live()) create();
  else if (!win.isVisible()) { win.showInactive(); send("radio:cmd", "shown"); }
  win.setAlwaysOnTop(true, "screen-saver");
  setTimeout(() => ctx.changed(), 50);
}
function hide() {
  if (!live()) return;
  pttStop(); stopDrag(false);
  win.hide();
  setTimeout(() => ctx.changed(), 50);
}
function toggle(on) {
  const vis = live() && win.isVisible();
  if (on === undefined) on = !vis;
  if (on) show(); else hide();
  return { ok: true, open: on };
}
function applyOpts() {
  if (!live()) return;
  const b = win.getBounds();
  if (b.width !== ww() || b.height !== wh()) { win.setBounds({ x: b.x, y: b.y, width: ww(), height: wh() }); try { win.webContents.setZoomFactor(k()); } catch (e) {} }
  send("radio:opts", opts());
}

// ───── «нажал и держи»: пока клавиша зажата, Windows повторяет сочетание; повторы прекратились — клавишу отпустили
const PTT_RELEASE_MS = 450;
let ptt = null;
function pttStop() { if (ptt) { clearInterval(ptt.timer); ptt = null; } }
function pttTick() {
  if (!ptt) return;
  if (ptt.reps > 0 && Date.now() - ptt.last > PTT_RELEASE_MS) { pttStop(); send("radio:cmd", "stop"); }
  else if (ptt.reps === 0 && Date.now() - ptt.t0 > 1500) pttStop(); // короткое нажатие: запись до второго нажатия или паузы в 30 с
}
function onHotkey() {
  const c = ctx.getCfg();
  if (!c.radioEnabled || !ctx.getWin()) return;
  if (ptt) { ptt.last = Date.now(); ptt.reps++; return; }
  show();
  if (state === "listening" || state === "loading") { send("radio:cmd", "stop"); return; }
  ptt = { t0: Date.now(), last: Date.now(), reps: 0, timer: setInterval(pttTick, 60) };
  send("radio:cmd", "start");
}
function registerHotkey() {
  if (hotkeyActive) { try { globalShortcut.unregister(hotkeyActive); } catch (e) {} hotkeyActive = null; }
  hotkeyError = "";
  const c = ctx.getCfg();
  if (!c.radioEnabled || !c.radioHotkey) return { ok: true };
  try {
    if (globalShortcut.register(c.radioHotkey, onHotkey)) { hotkeyActive = c.radioHotkey; return { ok: true }; }
    hotkeyError = "Это сочетание занято другой программой.";
  } catch (e) {
    hotkeyError = "Недопустимое сочетание клавиш.";
  }
  return { ok: false, error: hotkeyError };
}

// ───── перетаскивание ─────
function tickDrag() {
  if (!drag || !live()) { stopDrag(false); return; }
  const c = screen.getCursorScreenPoint();
  const p = clampPos(drag.origin.x + c.x - drag.start.x, drag.origin.y + c.y - drag.start.y, c);
  if (p.x === drag.last.x && p.y === drag.last.y) return;
  drag.last = p; drag.moved = true;
  win.setBounds({ x: p.x, y: p.y, width: ww(), height: wh() });
}
function startDrag() {
  if (!live()) return;
  stopDrag(false);
  const b = win.getBounds();
  drag = { origin: { x: b.x, y: b.y }, start: screen.getCursorScreenPoint(), last: { x: b.x, y: b.y }, moved: false, timer: setInterval(tickDrag, 15) };
}
function stopDrag(save) {
  if (!drag) return;
  clearInterval(drag.timer);
  const moved = drag.moved;
  drag = null;
  if (save && moved && live()) { const b = win.getBounds(); ctx.getCfg().radioPos = { x: b.x, y: b.y }; ctx.saveCfg(); }
}

// ───── команды выполняет окно памятки ─────
async function page(fn, arg) {
  const w = ctx.getWin();
  if (!w || w.isDestroyed()) return null;
  try { return await w.webContents.executeJavaScript(`(typeof window.${fn}==="function")?window.${fn}(${JSON.stringify(arg)}):null`, false); }
  catch (e) { return null; }
}
const clip = (s, n) => String(s || "").slice(0, n);

function init(c) {
  ctx = c; // { getWin, getCfg, saveCfg, changed, fromMain, stt, openTarget }
  const own = (e) => live() && e.sender === win.webContents;
  ipcMain.on("radio:ready", (e) => {
    if (!own(e)) return;
    ready = true;
    win.webContents.send("radio:opts", opts());
    if (last) win.webContents.send("radio:state", last);
    pending.splice(0).forEach(([ch, v]) => win.webContents.send(ch, v));
  });
  ipcMain.on("radio:status", (e, s) => { if (own(e)) state = String(s).slice(0, 20); });
  ipcMain.handle("radio:text", async (e, t, alt) => {
    if (!own(e)) return { say: "", show: "" };
    const r = await page("SA_radioCmd", { text: clip(t, 400), alt: clip(alt, 400) });
    if (!r || typeof r !== "object") return { say: "Нет связи с программой.", show: "Нет связи с программой." };
    return { say: clip(r.say, 600), show: clip(r.show, 400), close: !!r.close };
  });
  // 2.6.1: онлайн-распознавание. Подсказка Whisper: типовая фраза и имена текущих задержаний, чтобы имена и номера писались верно
  ipcMain.handle("radio:stt", async (e, b64) => {
    if (!own(e) || !ctx.getCfg().radioOnline || typeof b64 !== "string" || b64.length < 2000 || b64.length > 1100000) return { ok: false };
    const names = ((last && last.timers) || []).map((t) => t.nick).filter(Boolean).slice(-4);
    const prompt = "Диспетчер, задержан гражданин Hanami Senko, паспорт 42051, статья 12.8 часть 1 УК. Вызван адвокат, адвокат прибыл. Найдено 2 куста и 7 пакетиков." + (names.length ? " Задержанные: " + names.join(", ") + "." : "");
    try { const r = await ctx.stt({ audio: b64, prompt }); return r && r.ok ? { ok: true, text: clip(r.text, 600) } : { ok: false, error: clip(r && r.error, 200) }; }
    catch (x) { return { ok: false }; }
  });
  ipcMain.on("radio:select", (e, id) => { if (own(e)) page("SA_radioSel", +id || 0); });
  ipcMain.on("radio:hide", (e) => { if (own(e)) hide(); });
  ipcMain.on("radio:open", (e, t) => { if (own(e)) ctx.openTarget(clip(t, 40) || "radio"); });
  ipcMain.on("radio:drag-start", (e) => { if (own(e)) startDrag(); });
  ipcMain.on("radio:drag-end", (e) => { if (own(e)) stopDrag(true); });
  ipcMain.on("radio:reset-pos", (e) => {
    if (!own(e)) return;
    ctx.getCfg().radioPos = null; ctx.saveCfg();
    const p = startPos(); win.setBounds({ x: p.x, y: p.y, width: ww(), height: wh() });
  });
  // от окна памятки: задержания для экрана рации и ответ на команду, набранную текстом
  ipcMain.on("senko:radio-state", (e, d) => {
    if (!ctx.fromMain(e)) return;
    try { last = JSON.parse(JSON.stringify(d || {})); } catch (x) { last = null; }
    if (live() && ready) win.webContents.send("radio:state", last);
  });
  ipcMain.on("senko:radio-say", (e, r) => {
    if (!ctx.fromMain(e) || !ctx.getCfg().radioEnabled) return;
    show();
    send("radio:say", { say: clip(r && r.say, 600), show: clip(r && r.show, 400) });
  });
}

module.exports = {
  init, toggle, registerHotkey, applyOpts,
  isOpen: () => live() && win.isVisible(),
  isWc: (wc) => live() && !!wc && wc === win.webContents,
  hotkeyError: () => hotkeyError,
  destroy: () => { pttStop(); stopDrag(false); if (hotkeyActive) { try { globalShortcut.unregister(hotkeyActive); } catch (e) {} hotkeyActive = null; } if (live()) win.destroy(); }
};
