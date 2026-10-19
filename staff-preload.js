// Мост для окна «Список сотрудников» (app/staff.html)
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("senkoStaff", {
  list: () => ipcRenderer.invoke("staff:list"),
  copy: (text) => ipcRenderer.send("staff:copy", String(text || ""))
});
