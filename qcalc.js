"use strict";
// 3.8 (п. 30): мини-калькулятор поверх игры. Горячая клавиша открывает маленькое окно с полем ввода:
// «12.8 17.6» → итоговый срок, штраф, розыск и залог. Считает окно памятки (те же данные и правила, что в калькуляторе),
// мини-калькулятор только показывает ответ. Окно прячется, если перейти в игру (потеря фокуса) или нажать Esc.
const { BrowserWindow, ipcMain, globalShortcut, screen } = require("electron");
const path = require("path");

let ctx = null, win = null, hotkeyActive = null, hotkeyError = "", seq = 0;
const live = () => !!win && !win.isDestroyed();

function create() {
  const a = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
  const w = new BrowserWindow({
    width: 380, height: 250, x: Math.round(a.x + (a.width - 380) / 2), y: Math.round(a.y + a.height * 0.18),
    show: false, frame: false, resizable: false, minimizable: false, maximizable: false, fullscreenable: false,
    skipTaskbar: true, alwaysOnTop: true, backgroundColor: "#1b1714",
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: false, preload: path.join(__dirname, "qcalc-preload.js") },
  });
  win = w;
  w.setAlwaysOnTop(true, "screen-saver");
  w.loadFile(path.join(__dirname, "app", "qcalc", "qcalc.html"));
  w.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  w.webContents.on("will-navigate", (e) => e.preventDefault());
  w.on("blur", () => { if (live()) w.hide(); });
  w.on("closed", () => { if (win === w) win = null; });
  return w;
}
function toggle(on) {
  if (on === undefined) on = !(live() && win.isVisible());
  if (!on) { if (live()) win.hide(); return; }
  const w = live() ? win : create();
  const show = () => { if (!live()) return; w.show(); w.focus(); w.webContents.send("qcalc:show", { accent: ctx.accent ? ctx.accent() : "" }); };
  if (w.webContents.isLoading()) w.once("ready-to-show", show); else show();
}
function registerHotkey() {
  if (hotkeyActive) { try { globalShortcut.unregister(hotkeyActive); } catch (e) {} hotkeyActive = null; }
  hotkeyError = "";
  const k = ctx && ctx.getCfg().qcalcHotkey;
  if (!k) return { ok: true };
  try {
    if (globalShortcut.register(k, () => toggle())) { hotkeyActive = k; return { ok: true }; }
    hotkeyError = "Это сочетание занято другой программой.";
  } catch (e) { hotkeyError = "Недопустимое сочетание клавиш."; }
  return { ok: false, error: hotkeyError };
}
function init(c) {
  ctx = c;
  const own = (e) => live() && e.sender === win.webContents;
  // мини-калькулятор → окно памятки: посчитать строку
  ipcMain.on("qcalc:ask", (e, q) => {
    if (!own(e)) return;
    const main = ctx.getWin();
    if (!main) { win.webContents.send("qcalc:result", { ok: false, error: "Окно памятки закрыто." }); return; }
    main.webContents.send("qcalc:ask", { id: ++seq, q: String(q || "").slice(0, 200) });
  });
  ipcMain.on("qcalc:add", (e, q) => { if (own(e) && ctx.getWin()) ctx.getWin().webContents.send("qcalc:add", String(q || "").slice(0, 200)); });
  ipcMain.on("qcalc:close", (e) => { if (own(e)) toggle(false); });
  // окно памятки → мини-калькулятор: ответ
  ipcMain.on("qcalc:reply", (e, d) => { if (ctx.fromMain(e) && live()) win.webContents.send("qcalc:result", d && typeof d === "object" ? d : { ok: false }); });
}
function destroy() { if (live()) win.destroy(); win = null; }
module.exports = { init, toggle, registerHotkey, destroy, hotkeyError: () => hotkeyError };
