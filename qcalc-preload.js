"use strict";
// 3.8: мост мини-калькулятора: отправить строку статей и получить итог
const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("senkoQcalc", {
  ask: (q) => ipcRenderer.send("qcalc:ask", String(q || "")),
  add: (q) => ipcRenderer.send("qcalc:add", String(q || "")),
  close: () => ipcRenderer.send("qcalc:close"),
  onResult: (cb) => ipcRenderer.on("qcalc:result", (e, d) => cb(d || {})),
  onShow: (cb) => ipcRenderer.on("qcalc:show", (e, d) => cb(d || {})),
});
