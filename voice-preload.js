"use strict";
const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("senkoVoice", {
  onCmd: (cb) => ipcRenderer.on("voice:cmd", (_e, c) => cb(String(c))),
  onOpts: (cb) => ipcRenderer.on("voice:opts", (_e, o) => cb(o || {})),
  ready: () => ipcRenderer.send("voice:ready"),
  status: (s) => ipcRenderer.send("voice:status", String(s)),
  search: (cands) => ipcRenderer.invoke("voice:search", cands),
  ask: (q) => ipcRenderer.invoke("voice:ai", String(q || "")), // вопрос ИИ → {ok, answer, sources, left, error}
  hide: () => ipcRenderer.send("voice:hide"),
  // управление самим оверлеем
  interactive: (on) => ipcRenderer.send("voice:interactive", !!on),   // ловить ли клики мышью (иначе — насквозь)
  dragStart: () => ipcRenderer.send("voice:drag-start"),
  dragEnd: () => ipcRenderer.send("voice:drag-end"),
  resetPos: () => ipcRenderer.send("voice:reset-pos"),
  setOpacity: (v) => ipcRenderer.send("voice:set-opacity", +v),
  setMode: (m) => ipcRenderer.send("voice:set-mode", m === "ai" ? "ai" : "search"),
  setEnabled: (on) => ipcRenderer.invoke("voice:set-enabled", !!on),
  // 2.3: карточка → статья в окне памятки, голосовые команды, микрофоны и уровень для настроек
  open: (t) => ipcRenderer.send("voice:open", String(t || "")),
  cmd: (o) => ipcRenderer.invoke("voice:page-cmd", { text: String((o && o.text) || ""), query: String((o && o.query) || "") }),
  onMicsReq: (cb) => ipcRenderer.on("voice:mics-req", (_e, id) => cb(id)),
  micsRes: (id, r) => ipcRenderer.send("voice:mics-res", id, r || {}),
  onTest: (cb) => ipcRenderer.on("voice:test", (_e, o) => cb(o || {})),
  level: (v) => ipcRenderer.send("voice:level", v || {})
});
