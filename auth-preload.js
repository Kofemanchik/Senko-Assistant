// Мост для окна авторизации (app/auth.html)
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("senkoAuth", {
  state: () => ipcRenderer.invoke("auth:state"),
  login: (d) => ipcRenderer.invoke("auth:login", d),
  register: (d) => ipcRenderer.invoke("auth:register", d),
  quit: () => ipcRenderer.send("auth:quit")
});
