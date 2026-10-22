"use strict";
// 2.4: мост для мини-окна задержания: только получение данных и пара кнопок
const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("senkoMini", {
  onState: (cb) => ipcRenderer.on("mini:state", (e, d) => cb(d)),
  ready: () => ipcRenderer.send("mini:ready"),
  close: () => ipcRenderer.send("mini:close"),
  open: (t) => ipcRenderer.send("mini:open", String(t || "timer")),
  fit: (h) => ipcRenderer.send("mini:fit", +h || 0),
  width: () => ipcRenderer.send("mini:width"),
  dragStart: () => ipcRenderer.send("mini:drag-start"),
  dragEnd: () => ipcRenderer.send("mini:drag-end")
});
