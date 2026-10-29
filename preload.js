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
    fox: '<svg class="fx" viewBox="0 0 512 512" aria-hidden="true"><image width="512" height="512" href="data:image/png;base64,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"/></svg>',
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
