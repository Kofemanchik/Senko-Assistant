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
  resetData: (d) => ipcRenderer.invoke("senko:reset-data", { account: !!(d && d.account) }), // сброс всех данных
  syncRebase: () => ipcRenderer.invoke("senko:sync-rebase"), // перед загрузкой данных из файла: заново слить с аккаунтом
  api: (action, data) => ipcRenderer.invoke("senko:api", String(action || ""), data || {}), // прогресс, рейтинг, смены, контрольные тесты
  updateProfile: (d) => ipcRenderer.invoke("senko:profile-update", d || {}), // сохранить данные кабинета в аккаунт
  bug: (text) => ipcRenderer.invoke("senko:bug", String(text || "").slice(0, 2000)), // сообщение об ошибке
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
    fox: '<svg viewBox="0 0 64 64" aria-hidden="true" class="fx"><path d="M7 6l15 13h20L57 6l-1 22c-1 5-4 9-9 12L32 58 17 40c-5-3-8-7-9-12z"/></svg>',
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
.sat .fx{width:16px;height:16px;fill:var(--accent,#C2530E);stroke:none}
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
.satm-h .lg{width:32px;height:32px;border-radius:10px;background:var(--accent,#C2530E);display:grid;place-items:center;flex:0 0 auto}
.satm-h .lg svg{width:20px;height:20px;fill:var(--accent-ink,#fff)}
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
  ipcRenderer.on("senko:winstate", (_e, s) => { if (s) { ws = s; paintBar(); } });
  ipcRenderer.on("senko:winmenu", (_e, pt) => openMenu(pt && Number.isFinite(pt.x) ? pt : null));
  if (document.body) build(); else document.addEventListener("DOMContentLoaded", build);
})();
