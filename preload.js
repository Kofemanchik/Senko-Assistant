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

// 1b) Общие данные аккаунта (задержания, тесты, статистика, избранное, заметки, папки): слияние с сервером до запуска страницы.
const SYNC_KEYS = ["bos-thist", "bos-dlog", "bos-tests", "bos-qstat", "bos-xp", "bos-daily", "bos-streak",
  "bos-favs", "bos-notes", "bos-labels", "bos-folders", "bos-favorder"];
function syncSnapshot() {
  const o = {};
  for (const k of SYNC_KEYS) {
    try {
      const v = localStorage.getItem(k);
      if (v != null) o[k] = v;
    } catch (e) {}
  }
  return o;
}
try {
  const r = ipcRenderer.sendSync("sync:startup", syncSnapshot());
  if (r && r.values) {
    for (const k of Object.keys(r.values)) {
      if (SYNC_KEYS.indexOf(k) < 0) continue;
      const v = r.values[k];
      if (v === null) localStorage.removeItem(k);
      else if (typeof v === "string") localStorage.setItem(k, v);
    }
  }
} catch (e) {}
let syncLast = syncSnapshot();
// Об изменениях общих данных, сделанных страницей, сообщаем главному процессу (он отправит их на сервер)
function flushSync() {
  try {
    const cur = syncSnapshot();
    const ch = {};
    let any = false;
    for (const k of SYNC_KEYS) {
      if (cur[k] !== syncLast[k]) { ch[k] = cur[k] === undefined ? null : cur[k]; any = true; }
    }
    syncLast = cur;
    if (any) ipcRenderer.send("sync:local", ch);
  } catch (e) {}
}

// 2) Автосохранение: раз в 3 секунды, только если что-то изменилось, и при закрытии.
let last = JSON.stringify(snapshot());

function flush(force) {
  flushSync();
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

const openListeners = new Set();
ipcRenderer.on("senko:open", (_e, target) => { openListeners.forEach((f) => { try { f(String(target || "")); } catch (e) {} }); });
// 2.8: галочка блокнота, нажатая в мини-окне (-1 — открыть блокнот)
const padListeners = new Set();
ipcRenderer.on("senko:pad-check", (_e, i) => { padListeners.forEach((f) => { try { f(Number.isInteger(i) ? i : -1); } catch (e) {} }); });
const levelListeners = new Set();
ipcRenderer.on("senko:voice-level", (_e, v) => { levelListeners.forEach((f) => { try { f(v || {}); } catch (e) {} }); });
const lawsListeners = new Set();
ipcRenderer.on("laws:event", (_e, ev) => {
  lawsListeners.forEach((f) => {
    try { f(ev); } catch (e) {}
  });
});

contextBridge.exposeInMainWorld("senkoApp", {
  // ИИ-помощник: ask(вопрос) → {ok, answer, sources, left, error}; available() — подключён ли сервис
  ai: {
    ask: (q) => ipcRenderer.invoke("ai:ask", String(q || "").slice(0, 500)),
    available: () => ipcRenderer.sendSync("ai:available"),
    vote: (fid, v) => ipcRenderer.invoke("ai:vote", String(fid || ""), v === 1 ? 1 : v === -1 ? -1 : 0) // 👍 1 / 👎 -1
  },
  state: () => ipcRenderer.sendSync("senko:get"),
  set: (key, value) => ipcRenderer.sendSync("senko:set", key, value),
  session: () => ipcRenderer.sendSync("senko:session"),
  seeded: () => ipcRenderer.send("senko:seeded"),
  notify: (title, body) => ipcRenderer.send("senko:notify", String(title || ""), String(body || "")),
  about: () => ipcRenderer.send("senko:about"),
  checkUpdate: () => ipcRenderer.send("senko:check-update"),
  logout: () => ipcRenderer.send("senko:logout"),
  syncNow: () => ipcRenderer.invoke("senko:sync"), // синхронизировать сейчас
  staff: () => ipcRenderer.send("senko:staff"), // окно «Список сотрудников» (для руководства и выше)
  staffList: () => ipcRenderer.invoke("senko:staff-list"), // данные для панели руководителя
  exportData: (text) => ipcRenderer.invoke("senko:export-data", String(text || "")), // сохранить данные в файл
  importData: () => ipcRenderer.invoke("senko:import-data"), // выбрать файл с данными → {ok, text}
  openBackups: () => ipcRenderer.send("senko:open-backups"), // папка с ежедневными резервными копиями
  // карточки задержанных: отдельный файл detainees.json в папке данных
  dets: {
    load: () => ipcRenderer.sendSync("senko:dets-load"),
    save: (list) => ipcRenderer.send("senko:dets-save", Array.isArray(list) ? list : []),
    open: () => ipcRenderer.send("senko:dets-open")
  },
  // правка данных статей (только этот компьютер): отдельный файл article-edits.json
  artEdits: {
    load: () => ipcRenderer.sendSync("senko:artedit-load"),
    save: (edits) => ipcRenderer.send("senko:artedit-save", edits && typeof edits === "object" ? edits : {}),
    open: () => ipcRenderer.send("senko:artedit-open")
  },
  // ежедневные копии данных: список и одно значение из копии (для отката заметок)
  backups: {
    list: () => ipcRenderer.sendSync("senko:bk-list"),
    key: (name, key) => ipcRenderer.sendSync("senko:bk-key", String(name || ""), String(key || ""))
  },
  resetData: (d) => ipcRenderer.invoke("senko:reset-data", { account: !!(d && d.account) }), // сброс всех данных
  syncRebase: () => ipcRenderer.invoke("senko:sync-rebase"), // перед загрузкой данных из файла: заново слить с аккаунтом
  api: (action, data) => ipcRenderer.invoke("senko:api", String(action || ""), data || {}), // прогресс, рейтинг, смены, контрольные тесты
  updateProfile: (d) => ipcRenderer.invoke("senko:profile-update", d || {}), // сохранить данные кабинета в аккаунт
  bug: (text, log, shot) => ipcRenderer.invoke("senko:bug", String(text || "").slice(0, 2000), typeof log === "string" ? log.slice(0, 60000) : "", typeof shot === "string" ? shot : ""), // сообщение об ошибке (+ журнал, + снимок окна с 2.4)
  shot: () => ipcRenderer.invoke("senko:shot"), // 2.4: снимок окна программы (data:image/jpeg)
  miniState: (d) => ipcRenderer.send("senko:mini-state", d && typeof d === "object" ? d : {}), // 2.4: данные для мини-окна задержания
  radioState: (d) => ipcRenderer.send("senko:radio-state", d && typeof d === "object" ? d : {}), // 2.6: задержания для экрана рации
  radioSay: (r) => ipcRenderer.send("senko:radio-say", r && typeof r === "object" ? r : {}), // 2.6: ответ диспетчера голосом рации
  // 2.2: журнал и экран «Состояние», откат данных, ярлыки на вкладку или статью
  diag: () => ipcRenderer.invoke("senko:diag"),
  diagLog: () => ipcRenderer.invoke("senko:diag-log"),
  dataVersions: () => ipcRenderer.invoke("senko:data-versions"),
  dataRollback: (kind, id) => ipcRenderer.invoke("senko:data-rollback", { kind: String(kind || ""), id: String(id || "") }),
  dataResume: (kind) => ipcRenderer.invoke("senko:data-resume", { kind: String(kind || "") }),
  // 2.3: голосовой ввод — микрофоны и проверка уровня звука (через окно оверлея)
  voiceMics: () => ipcRenderer.invoke("senko:voice-mics"),
  voiceTest: (on) => ipcRenderer.invoke("senko:voice-test", !!on),
  onVoiceLevel: (f) => { if (typeof f === "function") levelListeners.add(f); },
  openArg: () => ipcRenderer.sendSync("senko:open-arg"),
  onOpen: (f) => { if (typeof f === "function") openListeners.add(f); },
  onPadCheck: (f) => { if (typeof f === "function") padListeners.add(f); }, // 2.8
  shortcut: (target, name) => ipcRenderer.invoke("senko:shortcut", { target: String(target || ""), name: String(name || "") }),
  // 2.2: размер данных и «Сохранить сейчас», профили окна «в игре» / «за столом»
  saveInfo: () => ipcRenderer.invoke("senko:save-info"),
  saveNow: () => { flush(true); return ipcRenderer.invoke("senko:save-info"); },
  winProfile: (op, name) => ipcRenderer.send("senko:win", op === "save" ? "prof-save" : "prof-use", String(name || "")),
  recheck: () => ipcRenderer.invoke("senko:recheck"), // сверка с сервером сейчас
  restart: () => ipcRenderer.send("senko:restart"), // перезапуск программы
  copy: (text) => ipcRenderer.send("senko:copy", String(text || "").slice(0, 200)),
  onChange: (f) => { if (typeof f === "function") listeners.add(f); },
  // Законы с форума: данные, ручное обновление, события (progress/done), папка диагностики
  laws: {
    get: () => ipcRenderer.invoke("laws:get"),
    getSync: () => ipcRenderer.sendSync("laws:get-sync"), // сохранённые законы сразу при старте (для автообновления УК/АК/ДК/ПК)
    sync: () => ipcRenderer.invoke("laws:sync"),
    debug: () => ipcRenderer.send("laws:debug"),
    diag: () => ipcRenderer.invoke("laws:diag"),
    login: () => ipcRenderer.invoke("laws:login"),
    logout: () => ipcRenderer.invoke("laws:logout"),
    on: (f) => { if (typeof f === "function") lawsListeners.add(f); }
  }
});

// ───────────── Своя строка заголовка вместо серой системной рамки ─────────────
// Рисуется здесь, а не в index.html, чтобы кнопки окна были при любой версии страницы.
// Цвета берутся из токенов страницы (--side, --ink, --accent…), поэтому строка меняется вместе с темой.
(function titleBar() {
  const H = 36;
  let ws = null;
  try { ws = ipcRenderer.sendSync("senko:win-state"); } catch (e) {}
  if (!ws) return;
  const SVG = (d, extra) => `<svg viewBox="0 0 24 24" aria-hidden="true"${extra || ""}>${d}</svg>`;
  const IC = {
    fox: '<svg class="fx" viewBox="0 0 512 512" aria-hidden="true"><rect width="512" height="512" rx="38" fill="#090D15"/><path fill="#EEE8E4" d="M226.5 474.3C140.3 461.4 69.1 397.3 48 313.5C41.1 286.4 39.1 254.6 42.5 227.9C56.7 115.3 146.3 34 256 34C296.9 34 334.9 44.8 369.7 66.3C442.8 111.7 483.7 206.1 468.4 294.4C452.1 388.9 377.9 461.4 284.2 474.4C269.9 476.4 240.3 476.4 226.5 474.3ZM278.5 461.5C331.4 450.5 385.4 406 412.1 351.5C423.5 328.2 428.8 307.5 429.7 283C430.3 266 430.7 265.9 434.1 282.3C440.2 312.6 432.9 350.2 415 380C409.3 389.5 409.9 389.4 418 379.5C465.3 321.6 472.3 231.3 435.2 157.5C393.4 74.3 300.6 30.9 209.7 52.1C96.7 78.5 28.2 200.5 61.5 316C81.7 386.1 139.5 441.7 209.9 458.7C232.8 464.2 260.3 465.3 278.5 461.5ZM234.5 451.9C220.9 450.1 192 441.2 192 438.9C192 438.6 195 438.2 198.8 438.1C214 437.7 234.2 433 251.1 425.8C266.9 419.1 267.1 418.4 253.7 418.8C216.8 419.9 178.6 408.5 151.8 388.5C141.6 380.8 126.8 365.6 120.9 356.6C118.6 353 116.5 350.2 116.3 350.4C115.7 351 120.3 363.7 123.6 370.5C130.3 384.2 143.6 399 157.3 408C161 410.4 163.8 412.5 163.6 412.7C163 413.3 145.6 405.8 139.7 402.4C108.6 384.2 83.9 347.8 77.6 311.1C75 295.8 76.2 281.4 81.2 268.4L83.5 262.5L84.1 275C84.7 287.9 86.9 298.3 90.9 307L93 311.5L92.4 307.6C92.1 305.5 91.9 297.9 91.9 290.6C91.9 270.1 96.4 255.2 107.4 238.6C121.1 218.1 145.8 200.6 169 195.1C180.8 192.2 180.9 192.3 174.4 199.2C143 233.2 138.9 280.9 164.1 320.1C167.9 326.1 168.7 325.8 166.7 319.3C164.3 311.9 163 303.4 163 295.1L163.1 287.5L165.9 294.7C181 332.9 215.9 361.4 265 375.5C271.7 377.4 281.2 379.6 286.1 380.2C296.4 381.6 295.6 382.3 281.5 384.1C262.9 386.4 236 383.1 213.8 375.6C208.4 373.9 204 372.6 204.1 372.9C204.1 373.8 214.8 382.2 221.9 387C248.2 404.7 280.6 408.8 312.5 398.5C330.5 392.7 349.2 381.3 364.9 366.5C368.8 362.8 372 360.1 372 360.6C372 361.1 369.7 366.2 366.9 372C350.6 406 321.6 433.9 291 445C272.7 451.7 251.7 454.3 234.5 451.9ZM377 373.9C377 373.6 378.3 370.4 379.9 366.9C385.2 355.2 393.3 324.9 391.1 325C390.8 325.1 388.5 327.8 386 331.1C373 348.6 352.6 362.4 332.8 366.9C310 372.2 294.7 370.1 268.4 358.5C253.7 351.9 246.8 350 237.3 350C233.3 350 230 349.7 230 349.3C230 347.2 239.2 335.1 244.7 330.1C257.1 318.7 270.3 313.5 286.5 313.6C296.4 313.7 298.6 314.1 309 317.5C324 322.4 333 323.1 342.8 320.1C372.4 311.1 390.1 269.1 379.4 233.6C378.3 230.3 384.5 234.7 391.9 242.7C421.1 273.8 417.7 331.9 384.8 366.4C380.5 370.9 377.1 374.2 377 373.9ZM199.3 307.9C196.3 307 196.1 306.8 197.2 304.4C198.6 301.3 196.4 299 192.2 299C190.9 299 189 298.5 188 298C186.2 297.1 186.5 296.1 192.5 283.9C202.5 263.2 203.4 257.3 199.5 236C193.7 204.4 206.1 173.8 233.4 152.1C238.4 148.1 249.3 141 250.3 141C250.5 141 249.1 145.4 247.4 150.8C241.6 168.3 242 170 249 156.5C268.7 118.5 293.4 77.7 299.2 73.5C305.2 69.3 310.8 74.1 319.3 90.6C339.8 130.8 342 173.5 325 199.9L321 206L327.9 206C331.6 206 338.1 206.9 342.4 208C349.8 209.9 366 217.4 366 219C366 219.4 363.7 220 360.9 220.3C352.9 221.3 343 224.8 329.2 231.5L316.5 237.7L322.2 238.9C330.5 240.7 339.6 245.6 345.9 251.7C348.9 254.6 351.1 257.2 350.8 257.5C350.5 257.8 347.2 257.3 343.4 256.3C333 253.8 312.1 254 300.8 256.8C288.6 259.8 277.9 264.1 268 270C256.9 276.6 256.6 277.1 264.2 275.2C274.2 272.7 291.9 273.1 299.9 275.9C312.4 280.3 322.5 289.3 326.5 299.5C327.3 301.8 327.5 302.7 326.7 301.6C317.1 287.3 306 281.1 288.5 280.2C272.4 279.5 258.9 283.7 237 296.3C216.6 308.1 216.2 308.3 209.1 308.6C205.5 308.8 201.1 308.5 199.3 307.9ZM412.2 260.6C402.2 228.6 375.6 199 349.5 191.1C347.3 190.4 345 189.7 344.3 189.5C343.5 189.2 343.8 187 345.2 181.8C346.9 175.9 347.3 171.5 347.3 159.2L347.3 144L350.9 144.6C367 147.3 381.5 153.6 392.3 162.5C396.1 165.6 399 168.3 398.8 168.5C398.6 168.7 396 168.2 393 167.4C389.6 166.5 383.9 166.1 378.1 166.2L368.7 166.5L374.6 168.9C386.5 173.7 396.1 180.2 406.6 190.5C421.2 204.9 429.9 219.2 435.4 238.3C437.6 245.9 440.2 260 439.5 260.8C439.4 260.9 437.4 257.2 435.2 252.6C429.5 240.6 423.9 232.7 415.2 224.2C411.1 220.2 407.6 217 407.5 217.2C407.3 217.4 408.2 220.7 409.5 224.5C413.5 236.4 415.1 246.6 414.8 257.8L414.5 268.2L412.2 260.6ZM236.2 251.9C240.4 248.6 245.1 244.3 246.6 242.2C248.1 240.2 250.9 236.5 252.7 234.1C254.5 231.7 255.8 229.5 255.6 229.3C254.9 228.6 244.1 233.8 238.4 237.6C231.8 242 227.8 247.8 225 256.9C222.5 264.9 222.5 265.2 225.8 261.1C227.2 259.3 231.9 255.1 236.2 251.9ZM296.8 193.5C314.5 185 322 171.2 322 146.5C322 140.4 321.3 131.4 320.4 126.5C317.7 110.4 308.2 85.8 304.3 84.3C299.7 82.5 287.8 107.4 272.1 152L268 163.5L276.3 155C280.8 150.3 288 142.7 292.3 138L300 129.5L300 137.5C300 150.3 295.5 164.5 288 175.8L285.7 179.1L291.4 176.6C294.5 175.2 298.5 173.1 300.1 171.9C304 169.2 304.4 169.7 302.5 175C300.4 181 297.4 185.7 291.6 191.8C285.9 197.9 286.9 198.3 296.8 193.5ZM204.2 171.9C203.7 170.6 200.5 162.2 197.1 153.2C183.1 116.2 176.1 91.5 178 86.4C179.8 81.7 187.3 84.4 208.9 97.7C226.1 108.3 252 127.1 252 128.9C252 129.3 249.1 131.2 245.6 133.2C231.3 141.5 219.2 153 209.8 167.2C205.3 174 205 174.3 204.2 171.9Z"/></svg>',
    down: SVG('<path d="m7 10 5 5 5-5"/>'),
    pin: SVG('<path d="M9 4h6l-1 6 4 4H6l4-4z"/><path d="M12 14v6"/>'),
    ghost: SVG('<path d="M5 20V10a7 7 0 0 1 14 0v10l-2.5-2-2.5 2-2-2-2 2-2.5-2z"/><circle cx="9.5" cy="10.5" r="1"/><circle cx="14.5" cy="10.5" r="1"/>'),
    min: SVG('<path d="M6 12h12"/>'),
    max: SVG('<rect x="6" y="6" width="12" height="12" rx="1.5"/>'),
    restore: SVG('<rect x="5" y="9" width="10" height="10" rx="1.5"/><path d="M9 9V6.5A1.5 1.5 0 0 1 10.5 5H17.5A1.5 1.5 0 0 1 19 6.5V13.5A1.5 1.5 0 0 1 17.5 15H15"/>'),
    close: SVG('<path d="m7 7 10 10M17 7 7 17"/>'),
    timer: SVG('<circle cx="12" cy="13" r="8"/><path d="M12 9v4l2.5 2.5M9 2h6"/>'),
    narrow: SVG('<rect x="8" y="3" width="8" height="18" rx="2"/>'),
    left: SVG('<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 4h7v16H3z" fill="currentColor" stroke="none" opacity=".35"/>'),
    right: SVG('<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M14 4h7v16h-7z" fill="currentColor" stroke="none" opacity=".35"/>'),
    full: SVG('<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>'),
    reload: SVG('<path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 4v7h-7"/>'),
    upd: SVG('<path d="M12 4v11M7 10l5 5 5-5M5 20h14"/>'),
    info: SVG('<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>'),
    tray: SVG('<path d="M4 15h4l2 3h4l2-3h4"/><path d="M4 15V6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v9v4a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1z"/>'),
    quit: SVG('<path d="M12 3v9"/><path d="M6.3 7.5a8 8 0 1 0 11.4 0"/>')
  };
  const css = `
html.sa-framed{--tbar:${H}px}
html.sa-framed body{padding-top:${H}px}
.sat{position:fixed;left:0;right:0;top:0;height:${H}px;z-index:2147483000;display:flex;align-items:center;gap:2px;padding:0 0 0 8px;
  background:var(--side,var(--bg,#F6F3EE));color:var(--ink,#1F1A15);border-bottom:1px solid var(--line,#E5DED4);
  font:500 13px/1 var(--f-body,"Segoe UI",system-ui,sans-serif);-webkit-app-region:drag;user-select:none;box-sizing:border-box}
.sat *{box-sizing:border-box}
.sat button{-webkit-app-region:no-drag;font:inherit;color:inherit;border:0;background:none;cursor:pointer;display:grid;place-items:center;padding:0}
.sat svg{width:16px;height:16px;fill:none;stroke:currentColor;stroke-width:1.9;stroke-linecap:round;stroke-linejoin:round}
.sat .fx{width:18px;height:18px;border-radius:4px;stroke:none;flex:0 0 auto}
.sat-app{display:flex!important;align-items:center;gap:7px;height:28px;padding:0 8px 0 6px!important;border-radius:8px!important}
.sat-app:hover,.sat-app[aria-expanded="true"]{background:var(--chip,#F1EBE3)}
.sat-app b{font-weight:600;font-size:12.5px;letter-spacing:.01em}
.sat-app .dn{width:13px;height:13px;opacity:.6}
.sat-drag{flex:1;min-width:24px;height:100%;display:flex;align-items:center;justify-content:center}
.sat-timer{display:flex!important;align-items:center;gap:6px;height:24px;padding:0 10px!important;border-radius:999px!important;background:var(--soft,#FCEFE5)!important;color:var(--accent,#C2530E)!important;font:600 12.5px/1 var(--f-mono,Consolas,monospace)!important}
.sat-timer svg{width:14px;height:14px}
.sat-timer.late{background:#c0392b!important;color:#fff!important}
.sat-timer.pause{opacity:.75}
.sat-b{width:40px;height:${H}px;color:var(--muted,#6B625A)!important}
.sat-b:hover{background:var(--chip,#F1EBE3)!important;color:var(--ink,#1F1A15)!important}
.sat-b[aria-pressed="true"]{color:var(--accent,#C2530E)!important}
.sat-b.x:hover{background:#e5484d!important;color:#fff!important}
.sat-sep{width:1px;height:16px;background:var(--line,#E5DED4);margin:0 4px}
html.sa-blur .sat{color:var(--muted,#6B625A)}
@media (max-width:420px){.sat-app b{display:none}.sat-b{width:34px}}
@media print{.sat,.satm{display:none!important}html.sa-framed body{padding-top:0}}
.satm{position:fixed;z-index:2147483001;width:288px;max-height:calc(100vh - ${H + 12}px);overflow-y:auto;background:var(--surface,#fff);color:var(--ink,#1F1A15);
  border:1px solid var(--line,#E5DED4);border-radius:14px;box-shadow:0 18px 50px rgba(0,0,0,.28);padding:6px;font:13.5px/1.35 var(--f-body,"Segoe UI",system-ui,sans-serif);animation:satIn .12s ease}
@keyframes satIn{from{opacity:0;transform:translateY(-4px)}to{opacity:1;transform:none}}
html.noanim .satm{animation:none}
.satm-h{display:flex;align-items:center;gap:10px;padding:8px 10px 10px}
.satm-h .lg{width:34px;height:34px;border-radius:9px;overflow:hidden;flex:0 0 auto;box-shadow:0 0 0 1px var(--line,#E5DED4)}
.satm-h .lg svg{display:block;width:100%;height:100%;stroke:none}
.satm-h b{display:block;font-size:14px}
.satm-h small{display:block;font-size:11.5px;color:var(--muted,#6B625A);margin-top:2px}
.satm-g{font:600 10.5px/1 var(--f-body,system-ui);text-transform:uppercase;letter-spacing:.08em;color:var(--muted,#6B625A);padding:10px 10px 6px}
.satm-i{display:flex;align-items:center;gap:10px;width:100%;border:0;background:none;color:inherit;font:inherit;text-align:left;padding:7px 10px;border-radius:9px;cursor:pointer}
.satm-i:hover,.satm-i:focus-visible{background:var(--chip,#F1EBE3);outline:none}
.satm-i svg{width:17px;height:17px;flex:0 0 auto;fill:none;stroke:currentColor;stroke-width:1.9;stroke-linecap:round;stroke-linejoin:round;color:var(--muted,#6B625A)}
.satm-i span{flex:1;min-width:0}
.satm-i small{display:block;font-size:11.5px;color:var(--muted,#6B625A);margin-top:1px}
.satm-i kbd{font:500 11px var(--f-mono,Consolas,monospace);color:var(--muted,#6B625A)}
.satm-sw{width:32px;height:18px;border-radius:9px;background:var(--line,#E5DED4);position:relative;flex:0 0 auto;transition:background .15s}
.satm-sw::after{content:"";position:absolute;top:2px;left:2px;width:14px;height:14px;border-radius:50%;background:#fff;box-shadow:0 1px 2px rgba(0,0,0,.25);transition:left .15s}
.satm-i[aria-checked="true"] .satm-sw{background:var(--accent,#C2530E)}
.satm-i[aria-checked="true"] .satm-sw::after{left:16px}
.satm-r{display:flex;align-items:center;gap:10px;padding:6px 10px 8px}
.satm-r input{flex:1;accent-color:var(--accent,#C2530E)}
.satm-r output{font:600 12px var(--f-mono,Consolas,monospace);min-width:3.2em;text-align:right}
.satm-dock{display:grid;grid-template-columns:repeat(4,1fr);gap:4px;padding:0 6px 6px}
.satm-dock button{border:1px solid var(--line,#E5DED4);background:none;color:inherit;border-radius:9px;padding:7px 2px 6px;font:500 11.5px var(--f-body,system-ui);display:flex;flex-direction:column;align-items:center;gap:4px;cursor:pointer}
.satm-dock button:hover{border-color:var(--accent,#C2530E);color:var(--accent,#C2530E)}
.satm-dock svg{width:18px;height:18px;fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}
.satm-sep{height:1px;background:var(--line,#E5DED4);margin:6px 4px}
.satm-i.danger{color:#d6453d}.satm-i.danger svg{color:#d6453d}
`;
  function sw(k, on, t, d) { return `<button type="button" class="satm-i" role="menuitemcheckbox" aria-checked="${!!on}" data-w="${k}">${IC[k === "top" ? "pin" : k] || ""}<span>${t}${d ? `<small>${d}</small>` : ""}</span><i class="satm-sw" aria-hidden="true"></i></button>`; }
  function it(k, icon, t, d, cls) { return `<button type="button" class="satm-i${cls ? " " + cls : ""}" role="menuitem" data-w="${k}">${IC[icon]}<span>${t}${d ? `<small>${d}</small>` : ""}</span></button>`; }
  function menuHtml() {
    const s = ws;
    return `<div class="satm-h"><span class="lg">${IC.fox.replace(' class="fx"', "")}</span><span><b>Senko Assistant</b><small>Версия ${s.version}${s.hotkey ? " · показать/скрыть: " + s.hotkey : ""}</small></span></div>` +
      `<div class="satm-g">Окно</div>` +
      sw("top", s.top, "Поверх всех окон", "Памятка не прячется за игру") +
      sw("ghost", s.ghost, "Призрачный режим", "Становится прозрачной, когда вы в игре") +
      sw("narrow", s.compact, "Узкое окно", "Не закрывает игру") +
      `<div class="satm-g">Прозрачность</div><div class="satm-r"><input type="range" min="30" max="100" step="5" value="${s.opacity}" data-w="opacity" aria-label="Прозрачность окна"><output>${s.opacity}%</output></div>` +
      `<div class="satm-g">Расположить</div><div class="satm-dock">` +
      `<button type="button" data-w="dock-left" title="Прижать к левому краю экрана во всю высоту">${IC.left}Слева</button>` +
      `<button type="button" data-w="dock-right" title="Прижать к правому краю экрана во всю высоту">${IC.right}Справа</button>` +
      `<button type="button" data-w="max" title="${s.max ? "Вернуть прежний размер" : "Развернуть на весь экран"}">${s.max ? IC.restore : IC.full}${s.max ? "Обычно" : "Во весь"}</button>` +
      `<button type="button" data-w="min" title="Свернуть в панель задач">${IC.min}Свернуть</button></div>` +
      `<div class="satm-sep"></div>` +
      it("reload", "reload", "Перезагрузить памятку", "Если что-то отображается не так") +
      it("update", "upd", "Проверить обновления") +
      it("about", "info", "О программе") +
      `<div class="satm-sep"></div>` +
      (s.tray ? it("hide", "tray", "Скрыть в трей", "Программа продолжит работать") : "") +
      it("quit", "quit", "Выйти из программы", "", "danger");
  }
  let bar = null, menu = null, timerEl = null;
  function paintBar() {
    if (!bar) return;
    bar.querySelector('[data-w="top"]').setAttribute("aria-pressed", String(!!ws.top));
    bar.querySelector('[data-w="ghost"]').setAttribute("aria-pressed", String(!!ws.ghost));
    const mx = bar.querySelector('[data-w="max"]');
    mx.innerHTML = ws.max ? IC.restore : IC.max;
    mx.title = ws.max ? "Вернуть прежний размер" : "Развернуть";
    mx.setAttribute("aria-label", mx.title);
    const cl = bar.querySelector('[data-w="close"]');
    cl.title = ws.tray ? "Закрыть (программа останется в трее)" : "Закрыть";
    document.documentElement.classList.toggle("sa-blur", !ws.focused);
  }
  function closeMenu() {
    if (!menu) return;
    menu.remove(); menu = null;
    const a = bar && bar.querySelector(".sat-app"); if (a) a.setAttribute("aria-expanded", "false");
  }
  function openMenu(pt) {
    closeMenu();
    try { ws = ipcRenderer.sendSync("senko:win-state") || ws; } catch (e) {}
    menu = document.createElement("div");
    menu.className = "satm"; menu.setAttribute("role", "menu"); menu.setAttribute("aria-label", "Меню окна");
    menu.innerHTML = menuHtml();
    document.body.appendChild(menu);
    const w = menu.offsetWidth, h = menu.offsetHeight;
    let x = pt ? pt.x : 6, y = pt ? pt.y : H + 4;
    x = Math.max(6, Math.min(x, window.innerWidth - w - 6));
    y = Math.max(H + 4, Math.min(y, window.innerHeight - h - 6));
    menu.style.left = x + "px"; menu.style.top = y + "px";
    if (!pt) bar.querySelector(".sat-app").setAttribute("aria-expanded", "true");
    const f = menu.querySelector(".satm-i"); if (f) f.focus();
    menu.addEventListener("click", (e) => { const b = e.target.closest("[data-w]"); if (b && b.tagName === "BUTTON") act(b.dataset.w, b); });
    menu.addEventListener("input", (e) => {
      if (e.target.dataset.w !== "opacity") return;
      e.target.nextElementSibling.textContent = e.target.value + "%";
      ipcRenderer.send("senko:win", "opacity", +e.target.value);
    });
    menu.addEventListener("keydown", (e) => {
      if (e.key === "Escape") { e.stopPropagation(); closeMenu(); return; }
      if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
      e.preventDefault();
      const items = [...menu.querySelectorAll("button")], i = items.indexOf(document.activeElement);
      const n = items[(i + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length]; if (n) n.focus();
    });
  }
  function act(k) {
    const keep = ["top", "ghost"].indexOf(k) >= 0; // переключатели меню не закрывают
    if (k === "menu") { if (menu) closeMenu(); else openMenu(null); return; }
    if (k === "timer") { document.documentElement.setAttribute("data-sa-cmd", "timer|" + Date.now()); return; }
    if (k === "narrow") k = "compact";
    if (k === "dock-left" || k === "dock-right") { ipcRenderer.send("senko:win", "dock", k.slice(5)); closeMenu(); return; }
    ipcRenderer.send("senko:win", k);
    if (keep && menu) {
      setTimeout(() => { try { ws = ipcRenderer.sendSync("senko:win-state") || ws; } catch (e) {} const b = menu && menu.querySelector(`[data-w="${k}"]`); if (b) b.setAttribute("aria-checked", String(!!ws[k])); paintBar(); }, 60);
    } else closeMenu();
  }
  // таймер задержания в заголовке: страница пишет его в атрибуты <html data-sa-timer data-sa-timer-st>
  function paintTimer() {
    if (!timerEl) return;
    const r = document.documentElement, t = r.getAttribute("data-sa-timer") || "", st = r.getAttribute("data-sa-timer-st") || "";
    timerEl.hidden = !t;
    if (!t) return;
    timerEl.querySelector("span").textContent = t;
    timerEl.className = "sat-timer" + (st ? " " + st : "");
    timerEl.title = st === "late" ? "Час задержания истёк. Открыть «Задержание»" : st === "pause" ? "Задержание на паузе. Открыть «Задержание»" : "Осталось до конца часа задержания. Открыть «Задержание»";
  }
  function build() {
    if (bar || !document.body) return;
    const st = document.createElement("style"); st.id = "saTbarCss"; st.textContent = css; document.head.appendChild(st);
    document.documentElement.classList.add("sa-framed");
    bar = document.createElement("div");
    bar.className = "sat"; bar.id = "saTbar"; bar.setAttribute("role", "toolbar"); bar.setAttribute("aria-label", "Окно программы");
    bar.innerHTML =
      `<button type="button" class="sat-app" data-w="menu" aria-haspopup="menu" aria-expanded="false" title="Меню окна: поверх окон, прозрачность, расположение">${IC.fox}<b>Senko Assistant</b>${IC.down.replace("<svg", '<svg class="dn"')}</button>` +
      `<div class="sat-drag"><button type="button" class="sat-timer" data-w="timer" hidden>${IC.timer}<span></span></button></div>` +
      `<button type="button" class="sat-b" data-w="top" aria-pressed="false" title="Поверх всех окон" aria-label="Поверх всех окон">${IC.pin}</button>` +
      `<button type="button" class="sat-b" data-w="ghost" aria-pressed="false" title="Призрачный режим: окно становится прозрачным, когда вы переключаетесь в игру" aria-label="Призрачный режим">${IC.ghost}</button>` +
      `<span class="sat-sep" aria-hidden="true"></span>` +
      `<button type="button" class="sat-b" data-w="min" title="Свернуть" aria-label="Свернуть">${IC.min}</button>` +
      `<button type="button" class="sat-b" data-w="max" title="Развернуть" aria-label="Развернуть">${IC.max}</button>` +
      `<button type="button" class="sat-b x" data-w="close" title="Закрыть" aria-label="Закрыть">${IC.close}</button>`;
    document.body.insertBefore(bar, document.body.firstChild);
    timerEl = bar.querySelector(".sat-timer");
    bar.addEventListener("click", (e) => { const b = e.target.closest("[data-w]"); if (b) act(b.dataset.w); });
    bar.addEventListener("dblclick", (e) => { if (!e.target.closest("button")) ipcRenderer.send("senko:win", "max"); });
    document.addEventListener("mousedown", (e) => { if (menu && !menu.contains(e.target) && !e.target.closest(".sat-app")) closeMenu(); }, true);
    window.addEventListener("blur", closeMenu);
    new MutationObserver(paintTimer).observe(document.documentElement, { attributes: true, attributeFilter: ["data-sa-timer", "data-sa-timer-st"] });
    paintBar(); paintTimer();
  }
  ipcRenderer.on("senko:winstate", (_e, s) => { if (s) { ws = s; paintBar(); document.documentElement.classList.toggle("sa-strip", !!s.strip); } });
  ipcRenderer.on("senko:winmenu", (_e, pt) => openMenu(pt && Number.isFinite(pt.x) ? pt : null));
  if (document.body) build(); else document.addEventListener("DOMContentLoaded", build);
})();
