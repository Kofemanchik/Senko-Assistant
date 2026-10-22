"use strict";
const { contextBridge, ipcRenderer } = require("electron");
// 2.6: окно рации диспетчера
contextBridge.exposeInMainWorld("senkoRadio", {
  onState: (cb) => ipcRenderer.on("radio:state", (_e, d) => cb(d || {})),
  onOpts: (cb) => ipcRenderer.on("radio:opts", (_e, o) => cb(o || {})),
  onCmd: (cb) => ipcRenderer.on("radio:cmd", (_e, c) => cb(String(c))),
  onSay: (cb) => ipcRenderer.on("radio:say", (_e, r) => cb(r || {})),
  ready: () => ipcRenderer.send("radio:ready"),
  status: (s) => ipcRenderer.send("radio:status", String(s)),
  text: (t, alt) => ipcRenderer.invoke("radio:text", String(t || ""), String(alt || "")),
  select: (id) => ipcRenderer.send("radio:select", +id || 0),
  hide: () => ipcRenderer.send("radio:hide"),
  open: (t) => ipcRenderer.send("radio:open", String(t || "")),
  dragStart: () => ipcRenderer.send("radio:drag-start"),
  dragEnd: () => ipcRenderer.send("radio:drag-end"),
  resetPos: () => ipcRenderer.send("radio:reset-pos")
});
