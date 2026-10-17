// Preload: восстановление данных из файла и автосохранение localStorage в файл.
// Выполняется ДО скриптов страницы, поэтому index.html сразу видит восстановленные данные.
const { ipcRenderer, contextBridge } = require("electron");

const PREFIX = "bos-";

function snapshot() {
  const data = {};
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.indexOf(PREFIX) === 0) data[k] = localStorage.getItem(k);
    }
  } catch (e) {}
  return data;
}

// 1) Восстановление: только если в приложении нет ни одного ключа bos-*
//    (первый запуск после установки, очистка данных, переезд на другой ПК).
try {
  if (Object.keys(snapshot()).length === 0) {
    const saved = ipcRenderer.sendSync("sa:load");
    if (saved && saved.data && typeof saved.data === "object") {
      for (const k of Object.keys(saved.data)) {
        if (k.indexOf(PREFIX) === 0 && typeof saved.data[k] === "string") {
          localStorage.setItem(k, saved.data[k]);
        }
      }
    }
  }
} catch (e) {}

// 2) Автосохранение: раз в 3 секунды, только если что-то изменилось, и при закрытии.
let last = JSON.stringify(snapshot());

function flush(force) {
  try {
    const data = snapshot();
    const json = JSON.stringify(data);
    if (!force && json === last) return;
    if (Object.keys(data).length === 0) return; // пустой снимок не затирает резервную копию
    last = json;
    ipcRenderer.send("sa:save", data);
  } catch (e) {}
}

setInterval(flush, 3000);
window.addEventListener("pagehide", () => flush(true));
window.addEventListener("beforeunload", () => flush(true));
// Первое сохранение сразу после загрузки, чтобы файл появился в самом начале.
window.addEventListener("DOMContentLoaded", () => setTimeout(() => flush(true), 1500));

// ───────────── Мост «памятка ↔ программа» (настройки .exe, уведомления, аккаунт) ─────────────
// Страница видит его как window.senkoApp. Вне программы (в обычном браузере) его нет.
const listeners = new Set();
ipcRenderer.on("senko:cfg", (_e, state) => {
  listeners.forEach((f) => {
    try { f(state); } catch (e) {}
  });
});

contextBridge.exposeInMainWorld("senkoApp", {
  state: () => ipcRenderer.sendSync("senko:get"),
  set: (key, value) => ipcRenderer.sendSync("senko:set", key, value),
  session: () => ipcRenderer.sendSync("senko:session"),
  seeded: () => ipcRenderer.send("senko:seeded"),
  notify: (title, body) => ipcRenderer.send("senko:notify", String(title || ""), String(body || "")),
  about: () => ipcRenderer.send("senko:about"),
  checkUpdate: () => ipcRenderer.send("senko:check-update"),
  logout: () => ipcRenderer.send("senko:logout"),
  onChange: (f) => { if (typeof f === "function") listeners.add(f); }
});
