"use strict";
// 2.5: мост для меню значка в трее
const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("senkoTray", {
  onState: (cb) => ipcRenderer.on("tray:state", (e, d) => cb(d)),
  act: (k, v) => ipcRenderer.send("tray:act", String(k || ""), v),
  fit: (h) => ipcRenderer.send("tray:fit", +h || 0),
  close: () => ipcRenderer.send("tray:close")
});
