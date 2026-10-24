"use strict";
// 2.8.0-beta.5: мост для окон-сообщений в стиле программы (обновления, «О программе», ошибки)
const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("senkoDlg", {
  onInit: (cb) => ipcRenderer.on("dlg:init", (e, d) => cb(d)),
  fit: (h) => ipcRenderer.send("dlg:fit", +h || 0),
  choose: (i) => ipcRenderer.send("dlg:choose", +i)
});
