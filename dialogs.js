"use strict";
// 2.8.0-beta.5: окна-сообщения в стиле программы вместо системных окон Windows.
// show(opts, parent) принимает те же поля, что dialog.showMessageBox (type, title, message, detail, buttons, defaultId, cancelId),
// плюс rows: [[подпись, значение]] для таблицы («О программе»), и так же возвращает Promise<{ response }>.
const { BrowserWindow, ipcMain, screen, nativeTheme } = require("electron");
const path = require("path");

const W = 540;
const open = new Map(); // webContents.id → { win, done }

function center(win, parent, h) {
  let area;
  if (parent && !parent.isDestroyed()) {
    const b = parent.getBounds();
    area = { x: b.x, y: b.y, width: b.width, height: b.height };
  } else area = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
  const x = Math.round(area.x + (area.width - W) / 2), y = Math.round(area.y + Math.max(20, (area.height - h) / 2.6));
  win.setBounds({ x, y, width: W, height: h });
}

function show(opts, parent) {
  return new Promise((resolve) => {
    const p = parent && !parent.isDestroyed() ? parent : null;
    const win = new BrowserWindow({
      width: W, height: 240, show: false, frame: false, transparent: true, backgroundColor: "#00000000", hasShadow: false,
      resizable: false, minimizable: false, maximizable: false, fullscreenable: false,
      parent: p || undefined, modal: !!p, skipTaskbar: !!p, alwaysOnTop: !p,
      title: String(opts.title || "Senko Assistant"),
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: false, preload: path.join(__dirname, "dlg-preload.js") }
    });
    const id = win.webContents.id;
    let answered = false;
    const cancel = typeof opts.cancelId === "number" ? opts.cancelId : (opts.buttons || []).length - 1;
    const done = (i) => {
      if (answered) return;
      answered = true;
      open.delete(id);
      if (!win.isDestroyed()) win.destroy();
      resolve({ response: typeof i === "number" && i >= 0 ? i : Math.max(0, cancel) });
    };
    open.set(id, { win, done, parent: p, sized: false });
    win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    win.webContents.on("will-navigate", (e) => e.preventDefault());
    win.on("closed", () => done(cancel));
    win.loadFile(path.join(__dirname, "app", "dialog", "dialog.html"));
    win.webContents.once("did-finish-load", () => {
      if (win.isDestroyed()) return;
      win.webContents.send("dlg:init", {
        type: opts.type || "info", title: String(opts.title || ""), message: String(opts.message || ""), detail: String(opts.detail || ""),
        rows: Array.isArray(opts.rows) ? opts.rows.map((r) => [String(r[0] || ""), String(r[1] || "")]) : [],
        buttons: (opts.buttons && opts.buttons.length ? opts.buttons : ["OK"]).map(String),
        defaultId: typeof opts.defaultId === "number" ? opts.defaultId : 0, cancelId: cancel,
        dark: nativeTheme.shouldUseDarkColors
      });
    });
  });
}

function init() {
  ipcMain.on("dlg:fit", (e, h) => {
    const o = open.get(e.sender.id);
    if (!o || o.win.isDestroyed()) return;
    const n = Math.max(140, Math.min(720, Math.round(+h || 0)));
    center(o.win, o.parent, n);
    if (!o.sized) { o.sized = true; o.win.show(); o.win.focus(); }
  });
  ipcMain.on("dlg:choose", (e, i) => {
    const o = open.get(e.sender.id);
    if (o) o.done(+i);
  });
}
module.exports = { init, show };
