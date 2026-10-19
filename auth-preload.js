// Мост для окна авторизации (app/auth.html)
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("senkoAuth", {
  state: () => ipcRenderer.invoke("auth:state"),
  login: (d) => ipcRenderer.invoke("auth:login", d),
  register: (d) => ipcRenderer.invoke("auth:register", d),
  acceptLegal: (version) => ipcRenderer.invoke("auth:accept-legal", String(version || "")),
  enter: () => ipcRenderer.send("auth:enter"), // после регистрации: код сохранён, открыть программу
  resetRequest: (d) => ipcRenderer.invoke("auth:reset-request", d),
  resetStatus: (d) => ipcRenderer.invoke("auth:reset-status", d),
  resetComplete: (d) => ipcRenderer.invoke("auth:reset-complete", d),
  copy: (text) => ipcRenderer.send("auth:copy", String(text || "")),
  saveCode: (login, code) => ipcRenderer.invoke("auth:save-code", String(login || ""), String(code || "")),
  quit: () => ipcRenderer.send("auth:quit")
});
