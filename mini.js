"use strict";
// 2.4: мини-окно задержания поверх игры. Маленькое окно всегда сверху: таймеры задержаний, статьи и итог калькулятора.
// Данные присылает окно памятки (senko:mini-state), окно только показывает их и считает время само.
// Прозрачное окно в Windows не тянется за край, поэтому ширина выбирается кнопкой, а высота подгоняется под содержимое.
const { BrowserWindow, ipcMain, globalShortcut, screen } = require("electron");
const path = require("path");

const WIDTHS = [260, 320, 400];
let ctx = null;
let mini = null;
let last = null; // последнее состояние от окна памятки
let hotkeyActive = null;
let hotkeyError = "";
let height = 150;
let drag = null;
const live = () => !!mini && !mini.isDestroyed();
const mw = () => (WIDTHS.includes(ctx.getCfg().miniWidth) ? ctx.getCfg().miniWidth : 320);
const opa = () => Math.max(0.3, Math.min(1, (ctx.getCfg().miniOpacity || 90) / 100));

function clampPos(x, y, near) {
  const a = screen.getDisplayNearestPoint(near || { x, y }).workArea;
  return {
    x: Math.round(Math.min(a.x + a.width - 80, Math.max(a.x - mw() + 80, x))),
    y: Math.round(Math.min(a.y + a.height - 40, Math.max(a.y - 8, y)))
  };
}
function startPos() {
  const p = ctx.getCfg().miniPos;
  if (p && Number.isFinite(+p.x) && Number.isFinite(+p.y)) {
    const d = screen.getDisplayNearestPoint({ x: +p.x, y: +p.y }).workArea;
    if (+p.x < d.x + d.width - 40 && +p.y < d.y + d.height - 40) return clampPos(+p.x, +p.y);
  }
  const a = screen.getPrimaryDisplay().workArea;
  return { x: a.x + a.width - mw() - 24, y: a.y + 90 };
}
function create() {
  const p = startPos();
  const w = new BrowserWindow({
    width: mw(), height, x: p.x, y: p.y,
    show: false, frame: false, transparent: true, backgroundColor: "#00000000", hasShadow: false,
    resizable: false, movable: true, minimizable: false, maximizable: false, fullscreenable: false,
    skipTaskbar: true, focusable: false, alwaysOnTop: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: false, backgroundThrottling: false, preload: path.join(__dirname, "mini-preload.js") }
  });
  mini = w;
  w.setAlwaysOnTop(true, "screen-saver");
  w.setOpacity(opa());
  w.loadFile(path.join(__dirname, "app", "mini", "mini.html"));
  w.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  w.webContents.on("will-navigate", (e) => e.preventDefault());
  w.once("ready-to-show", () => { if (live()) { w.showInactive(); push(); } });
  w.on("closed", () => { if (mini === w) mini = null; stopDrag(false); ctx.changed(); });
  return w;
}
function push() {
  if (live()) mini.webContents.send("mini:state", { ...(last || {}), width: mw() });
}
function toggle(on) {
  if (on === undefined) on = !live();
  if (on && !live()) create();
  else if (!on && live()) mini.close();
  setTimeout(() => ctx.changed(), 50);
  return { ok: true, open: on };
}
function fit(h) {
  height = Math.max(70, Math.min(640, Math.round(+h || 150)));
  if (!live()) return;
  const b = mini.getBounds();
  if (b.height !== height || b.width !== mw()) mini.setBounds({ x: b.x, y: b.y, width: mw(), height });
}
function tickDrag() {
  if (!drag || !live()) { stopDrag(false); return; }
  const c = screen.getCursorScreenPoint();
  const p = clampPos(drag.origin.x + c.x - drag.start.x, drag.origin.y + c.y - drag.start.y, c);
  if (p.x === drag.last.x && p.y === drag.last.y) return;
  drag.last = p;
  drag.moved = true;
  mini.setBounds({ x: p.x, y: p.y, width: mw(), height });
}
function startDrag() {
  if (!live()) return;
  stopDrag(false);
  const b = mini.getBounds();
  drag = { origin: { x: b.x, y: b.y }, start: screen.getCursorScreenPoint(), last: { x: b.x, y: b.y }, moved: false, timer: setInterval(tickDrag, 15) };
}
function stopDrag(save) {
  if (!drag) return;
  clearInterval(drag.timer);
  const moved = drag.moved;
  drag = null;
  if (save && moved && live()) {
    const b = mini.getBounds();
    ctx.getCfg().miniPos = { x: b.x, y: b.y };
    ctx.saveCfg();
  }
}
function registerHotkey() {
  if (hotkeyActive) {
    try { globalShortcut.unregister(hotkeyActive); } catch (e) {}
    hotkeyActive = null;
  }
  hotkeyError = "";
  const c = ctx.getCfg();
  if (!c.miniEnabled || !c.miniHotkey) return { ok: true };
  try {
    if (globalShortcut.register(c.miniHotkey, () => toggle())) { hotkeyActive = c.miniHotkey; return { ok: true }; }
    hotkeyError = "Это сочетание занято другой программой.";
  } catch (e) {
    hotkeyError = "Недопустимое сочетание клавиш.";
  }
  return { ok: false, error: hotkeyError };
}
function init(c) {
  ctx = c;
  const own = (e) => live() && e.sender === mini.webContents;
  ipcMain.on("senko:mini-state", (e, data) => {
    if (!ctx.fromMain(e)) return;
    try { last = JSON.parse(JSON.stringify(data || {})); } catch (x) { last = null; }
    push();
  });
  ipcMain.on("mini:close", (e) => { if (own(e)) toggle(false); });
  ipcMain.on("mini:open", (e, t) => { if (own(e)) ctx.openTarget(String(t || "timer")); });
  ipcMain.on("mini:ready", (e) => { if (own(e)) push(); });
  ipcMain.on("mini:fit", (e, h) => { if (own(e)) fit(h); });
  ipcMain.on("mini:drag-start", (e) => { if (own(e)) startDrag(); });
  ipcMain.on("mini:drag-end", (e) => { if (own(e)) stopDrag(true); });
  ipcMain.on("mini:width", (e) => {
    if (!own(e)) return;
    const cfg = ctx.getCfg();
    cfg.miniWidth = WIDTHS[(WIDTHS.indexOf(mw()) + 1) % WIDTHS.length];
    ctx.saveCfg();
    fit(height);
    push();
  });
}
module.exports = {
  init, toggle, registerHotkey, push,
  isOpen: () => live(),
  hotkeyError: () => hotkeyError,
  applyOpacity: () => { if (live()) mini.setOpacity(opa()); },
  destroy: () => { stopDrag(false); if (live()) mini.destroy(); }
};
