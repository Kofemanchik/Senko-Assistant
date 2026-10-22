"use strict";
// 2.5: меню значка в трее. Вместо системного меню Windows открывается своё маленькое окно в стиле программы:
// шапка с версией и аккаунтом, кнопка показа окна, переключатели и действия. Закрывается, когда теряет фокус.
const { BrowserWindow, ipcMain, screen, nativeTheme } = require("electron");
const path = require("path");

const W = 300;
let ctx = null;
let win = null;
let height = 420;
let anchor = null;
let hiddenAt = 0;
const live = () => !!win && !win.isDestroyed();

function create() {
  win = new BrowserWindow({
    width: W, height, show: false, frame: false, transparent: true, backgroundColor: "#00000000", hasShadow: false,
    resizable: false, movable: false, minimizable: false, maximizable: false, fullscreenable: false,
    skipTaskbar: true, alwaysOnTop: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: false, preload: path.join(__dirname, "tray-preload.js") }
  });
  win.setAlwaysOnTop(true, "pop-up-menu");
  win.loadFile(path.join(__dirname, "app", "tray", "tray.html"));
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (e) => e.preventDefault());
  win.on("blur", () => hide());
  win.on("closed", () => { win = null; });
}
// окно ставится к значку: над панелью задач, если она снизу, и под ней, если сверху
function place() {
  if (!live()) return;
  const pt = anchor && anchor.width ? { x: anchor.x + anchor.width / 2, y: anchor.y + anchor.height / 2 } : screen.getCursorScreenPoint();
  const d = screen.getDisplayNearestPoint(pt), a = d.workArea, b = d.bounds;
  let x = Math.round(pt.x - W / 2), y;
  if (a.y > b.y) y = a.y + 6; // панель сверху
  else if (pt.y > a.y + a.height / 2) y = Math.round(Math.min(pt.y, a.y + a.height) - height - 8);
  else y = Math.round(pt.y + 8);
  if (a.x > b.x && pt.x < a.x) x = a.x + 6; // панель слева
  if (a.x + a.width < b.x + b.width && pt.x > a.x + a.width) x = a.x + a.width - W - 6; // панель справа
  x = Math.max(a.x + 6, Math.min(a.x + a.width - W - 6, x));
  y = Math.max(a.y + 6, Math.min(a.y + a.height - height - 6, y));
  win.setBounds({ x, y, width: W, height });
}
function push() {
  if (live()) win.webContents.send("tray:state", { ...ctx.state(), dark: nativeTheme.shouldUseDarkColors });
}
function show(bounds) {
  // повторный щелчок по значку, пока меню открыто, его закрывает (blur успевает раньше щелчка)
  if (Date.now() - hiddenAt < 250) return;
  anchor = bounds || null;
  if (!live()) create();
  push();
  place();
  const go = () => { if (live()) { place(); win.show(); win.focus(); } };
  if (win.webContents.isLoading()) win.webContents.once("did-finish-load", () => { push(); go(); });
  else go();
}
function hide() {
  if (live() && win.isVisible()) { win.hide(); hiddenAt = Date.now(); }
}
function init(c) {
  ctx = c;
  ipcMain.on("tray:fit", (e, h) => {
    if (!live() || e.sender !== win.webContents) return;
    const n = Math.max(160, Math.min(720, Math.round(+h || 0)));
    if (n !== height) { height = n; place(); }
  });
  ipcMain.on("tray:act", (e, k, v) => {
    if (!live() || e.sender !== win.webContents) return;
    const keep = ctx.act(String(k || ""), v);
    if (keep) push(); else hide();
  });
  ipcMain.on("tray:close", (e) => { if (live() && e.sender === win.webContents) hide(); });
}
const refresh = () => { if (live() && win.isVisible()) push(); };
const destroy = () => { if (live()) win.destroy(); win = null; };
module.exports = { init, show, hide, refresh, destroy };
