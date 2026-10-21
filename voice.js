"use strict";
// Голосовой ввод + оверлей (Senko Assistant). Распознавание офлайн (Vosk) работает в окне оверлея,
// а этот модуль создаёт окно, раздаёт ему файлы через протокол senko-voice:// и ищет ответ в окне памятки.
const { BrowserWindow, ipcMain, globalShortcut, protocol, session, screen } = require("electron");
const path = require("path");
const fs = require("fs");

const SCHEME = "senko-voice";
// Схему нужно объявить до готовности приложения — поэтому на уровне модуля.
protocol.registerSchemesAsPrivileged([
  { scheme: SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } }
]);

// 2.3: размер окна выбирается в настройках (voiceSize)
const SIZES = { s: [400, 380], m: [480, 460], l: [580, 560] };
const ow = () => (SIZES[ctx && ctx.getCfg().voiceSize] || SIZES.m)[0];
const oh = () => (SIZES[ctx && ctx.getCfg().voiceSize] || SIZES.m)[1];
const MIN_VISIBLE = 120; // сколько пикселей окна минимум должно оставаться на экране при перетаскивании
const IDLE_DESTROY_MS = 10 * 60 * 1000; // выгрузить распознавание (и освободить память) после 10 минут без использования
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".gz": "application/gzip" };

let ctx = null;
let overlay = null;
let overlayReady = false;
let pendingStart = false;
let state = "idle"; // idle | loading | listening | thinking | answer | error
let hotkeyActive = null;
let hotkeyError = "";
let idleTimer = null;
let inited = false;

const live = () => !!overlay && !overlay.isDestroyed();

function fileMap() {
  const dir = path.join(__dirname, "app", "voice");
  const modelDir = ctx.isPackaged ? path.join(process.resourcesPath, "voice-model") : path.join(__dirname, "voice-model");
  return {
    "overlay.html": path.join(dir, "overlay.html"),
    "overlay.js": path.join(dir, "overlay.js"),
    "numbers.js": path.join(dir, "numbers.js"),
    "vosk.js": path.join(dir, "vosk.js"),
    "model.tar.gz": path.join(modelDir, "model.tar.gz")
  };
}

// Код, который выполняется внутри страницы памятки. С 2.3 ищет по данным всех кодексов и законов (window.__senkoVoiceSearch),
// не трогая открытую вкладку и строку поиска. Старый путь через строку поиска — запасной.
function pageSearch(cands) {
  try {
    if (typeof window.__senkoVoiceSearch === "function") return window.__senkoVoiceSearch(cands);
    var KN = { uk: "УК", ak: "АК", dk: "ДК", pk: "ПК" };
    var sel = document.querySelector('.tab[aria-selected="true"]');
    var cur = sel && sel.getAttribute("data-tab");
    if (["uk", "ak", "dk", "pk"].indexOf(cur) < 0) {
      var tab = document.querySelector('.tab[data-tab="uk"]');
      if (tab) tab.click();
    }
    var qEl = document.getElementById("q");
    if (!qEl || qEl.disabled) return { ok: false, error: "Поиск сейчас недоступен." };
    var txt = function (el) { return el ? (el.textContent || "").replace(/\s+/g, " ").trim() : ""; };
    var lawFn = window.__senkoLawSearch; // поиск по остальным законам (определён в index.html)
    var lawRes = [];
    for (var i = 0; i < cands.length; i++) {
      qEl.value = cands[i];
      qEl.dispatchEvent(new Event("input", { bubbles: true }));
      var arts = document.querySelectorAll("#view .art");
      var lw = { total: 0, items: [] };
      try { if (typeof lawFn === "function") lw = lawFn(cands[i]) || lw; } catch (e) {}
      if (!arts.length && !lw.items.length) continue;
      var items = [];
      for (var a = 0; a < arts.length && a < 3; a++) {
        var art = arts[a], parts = [], ps = art.querySelectorAll(".part");
        for (var p = 0; p < ps.length && p < 2; p++) {
          var chips = [], cs = ps[p].querySelectorAll(".meta .chip");
          for (var c = 0; c < cs.length; c++) chips.push(txt(cs[c]));
          parts.push({ pn: txt(ps[p].querySelector(".pn")), text: txt(ps[p].querySelector(".note, .ptext")).slice(0, 320), chips: chips });
        }
        items.push({
          kind: KN[art.getAttribute("data-k")] || "",
          code: art.getAttribute("data-c") || "",
          title: txt(art.querySelector("h3")),
          parts: parts,
          more: Math.max(0, ps.length - 2)
        });
      }
      // статьи кодексов — первыми; свободные места (до 3) занимают статьи остальных законов
      for (var l = 0; l < lw.items.length && items.length < 3; l++) items.push(lw.items[l]);
      var ref = document.querySelector("#view .refbar");
      return { ok: true, query: cands[i], total: arts.length + (lw.total || 0), ref: ref ? txt(ref).slice(0, 400) : "", items: items };
    }
    return { ok: true, query: cands[0], total: 0, items: [] };
  } catch (e) {
    return { ok: false, error: "Ошибка поиска." };
  }
}

async function runSearch(cands) {
  const w = ctx.getWin();
  if (!w || w.isDestroyed()) return { ok: false, error: "Окно памятки не запущено." };
  const list = Array.isArray(cands) ? cands.map((s) => String(s).slice(0, 120)).filter(Boolean).slice(0, 4) : [];
  if (!list.length) return { ok: false, error: "Пустой запрос." };
  try {
    return await w.webContents.executeJavaScript(`(${pageSearch.toString()})(${JSON.stringify(list)})`, false);
  } catch (e) {
    return { ok: false, error: "Не удалось выполнить поиск." };
  }
}

function setupPermissions() {
  const ses = session.defaultSession;
  const isOverlay = (wc) => live() && !!wc && wc === overlay.webContents;
  // Микрофон — только окну оверлея. Остальное ведёт себя как раньше (по умолчанию разрешено).
  ses.setPermissionRequestHandler((wc, permission, cb) => cb(permission === "media" ? isOverlay(wc) : true));
  ses.setPermissionCheckHandler((wc, permission) => (permission === "media" ? isOverlay(wc) : true));
}

function sendOpts() {
  if (!live()) return;
  const c = ctx.getCfg();
  // размер окна мог поменяться в настройках
  if (overlay.isVisible()) { const b = overlay.getBounds(); if (b.width !== ow() || b.height !== oh()) overlay.setBounds({ x: b.x, y: b.y, width: ow(), height: oh() }); }
  try { overlay.webContents.setZoomFactor(Math.min(1.5, Math.max(0.8, (+c.voiceFont || 100) / 100))); } catch (e) {} // шрифт оверлея
  if (overlayReady) overlay.webContents.send("voice:opts", {
    opacity: c.voiceOpacity, hotkey: c.voiceHotkey, enabled: !!c.voiceEnabled, mode: c.voiceMode === "ai" ? "ai" : "search",
    aiOk: !!(typeof ctx.aiAvailable === "function" && ctx.aiAvailable()),
    hide: c.voiceHide || 10, font: c.voiceFont || 100, ptt: !!c.voicePtt, mic: c.voiceMic || ""
  });
}

function ensureOverlay() {
  clearTimeout(idleTimer);
  if (live()) return overlay;
  overlayReady = false;
  const w = new BrowserWindow({
    width: ow(), height: oh(), show: false,
    frame: false, transparent: true, backgroundColor: "#00000000", hasShadow: false,
    resizable: false, movable: true, minimizable: false, maximizable: false, fullscreenable: false,
    skipTaskbar: true, focusable: false, alwaysOnTop: true,
    webPreferences: {
      contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: false,
      backgroundThrottling: false,
      autoplayPolicy: "no-user-gesture-required", // иначе звук с микрофона не стартует без клика по окну
      preload: path.join(__dirname, "voice-preload.js")
    }
  });
  overlay = w;
  w.setAlwaysOnTop(true, "screen-saver");
  w.setIgnoreMouseEvents(true, { forward: true }); // клики проходят насквозь; движение мыши пробрасывается, чтобы панель управления могла «поймать» курсор
  w.loadURL(`${SCHEME}://app/overlay.html`);
  w.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  w.webContents.on("will-navigate", (e) => e.preventDefault());
  w.on("closed", () => {
    if (overlay === w) { stopDrag(false); overlay = null; overlayReady = false; state = "idle"; pendingStart = false; }
  });
  return w;
}

// Позиция по умолчанию: по центру сверху, на мониторе, где сейчас курсор
function defaultPos() {
  const a = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
  return { x: Math.round(a.x + (a.width - ow()) / 2), y: a.y + 16 };
}

// Сохранённая позиция — только если окно всё ещё попадает на какой-либо экран (монитор мог отключиться)
function savedPos() {
  const p = ctx.getCfg().voicePos;
  if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) return null;
  const ok = screen.getAllDisplays().some((d) => {
    const a = d.workArea;
    return p.x + ow() - MIN_VISIBLE > a.x && p.x + MIN_VISIBLE < a.x + a.width && p.y >= a.y - 8 && p.y < a.y + a.height - 60;
  });
  return ok ? { x: Math.round(p.x), y: Math.round(p.y) } : null;
}

function showOverlay() {
  if (!live()) return;
  if (!overlay.isVisible()) { // уже на экране — не двигаем, чтобы не сбрасывать позицию, выбранную мышкой
    const p = savedPos() || defaultPos();
    overlay.setBounds({ x: p.x, y: p.y, width: ow(), height: oh() });
  }
  overlay.setIgnoreMouseEvents(true, { forward: true });
  overlay.setAlwaysOnTop(true, "screen-saver");
  overlay.showInactive(); // показать, не забирая фокус
}

// ───── перетаскивание мышкой ─────
// Курсор читаем в главном процессе: так не зависим от масштаба экрана и от того,
// что окно двигается под курсором.
let drag = null;
function clampPos(x, y, cursor) {
  const a = screen.getDisplayNearestPoint(cursor).workArea;
  return {
    x: Math.round(Math.min(a.x + a.width - MIN_VISIBLE, Math.max(a.x - ow() + MIN_VISIBLE, x))),
    y: Math.round(Math.min(a.y + a.height - 60, Math.max(a.y - 8, y)))
  };
}
function tickDrag() {
  if (!drag || !live()) { stopDrag(false); return; }
  const c = screen.getCursorScreenPoint();
  const p = clampPos(drag.origin.x + c.x - drag.start.x, drag.origin.y + c.y - drag.start.y, c);
  if (p.x === drag.last.x && p.y === drag.last.y) return;
  drag.last = p;
  drag.moved = true;
  overlay.setBounds({ x: p.x, y: p.y, width: ow(), height: oh() }); // размер задаём явно — без «ползущих» размеров при масштабе 125/150%
}
function startDrag() {
  if (!live()) return;
  stopDrag(false);
  const b = overlay.getBounds();
  drag = { origin: { x: b.x, y: b.y }, start: screen.getCursorScreenPoint(), last: { x: b.x, y: b.y }, moved: false, timer: null };
  drag.timer = setInterval(tickDrag, 15);
}
function stopDrag(save) {
  if (!drag) return;
  clearInterval(drag.timer);
  const moved = drag.moved;
  drag = null;
  if (save && moved && live()) {
    const b = overlay.getBounds();
    ctx.getCfg().voicePos = { x: b.x, y: b.y };
    ctx.saveCfg();
  }
}

function scheduleIdle() {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => { if (live() && state === "idle") overlay.destroy(); }, IDLE_DESTROY_MS);
}

// 2.3: «нажал и держи». Пока клавиша зажата, Windows повторяет сочетание (автоповтор клавиатуры),
// и globalShortcut срабатывает снова и снова. Повторы прекратились — клавишу отпустили: останавливаем запись.
// Если повторов нет совсем (короткое нажатие или система их не шлёт), запись идёт как обычно: до паузы или второго нажатия.
const PTT_RELEASE_MS = 450, PTT_FIRST_MS = 1100;
let ptt = null; // {t0, last, reps, timer}
function pttStop() { if (ptt) { clearInterval(ptt.timer); ptt = null; } }
function pttTick() {
  if (!ptt) return;
  const now = Date.now();
  if (ptt.reps > 0 && now - ptt.last > PTT_RELEASE_MS) { pttStop(); send("voice:cmd", "stop"); return; }
  if (ptt.reps === 0 && now - ptt.t0 > PTT_FIRST_MS) { pttStop(); send("voice:cmd", "ptt-off"); }
}
function send(ch, v) { if (live() && overlayReady) overlay.webContents.send(ch, v); }
function onHotkey() {
  const cfg = ctx.getCfg();
  if (!cfg.voiceEnabled || !ctx.getWin()) return;
  if (ptt) { ptt.last = Date.now(); ptt.reps++; return; } // автоповтор зажатой клавиши
  const w = ensureOverlay();
  showOverlay();
  if (cfg.voicePtt && state !== "listening") {
    ptt = { t0: Date.now(), last: Date.now(), reps: 0, timer: setInterval(pttTick, 60) };
    if (!overlayReady) { pendingStart = "start-ptt"; return; }
    w.webContents.send("voice:cmd", "start-ptt");
    return;
  }
  if (!overlayReady) { pendingStart = true; return; }
  w.webContents.send("voice:cmd", state === "listening" ? "stop" : "start");
}

// 2.3: список микрофонов и проверка уровня для настроек памятки. Доступ к микрофону есть только у окна оверлея,
// поэтому запрос идёт через него (окно при этом не показывается).
let micSeq = 0;
const micWait = new Map();
function whenReady(ms) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const tick = () => { if (live() && overlayReady) resolve(true); else if (Date.now() - t0 > ms) resolve(false); else setTimeout(tick, 80); };
    tick();
  });
}
async function mics() {
  if (!ctx) return { ok: false, error: "Недоступно." };
  ensureOverlay();
  if (!(await whenReady(8000))) return { ok: false, error: "Окно голосового ввода не запустилось." };
  const id = ++micSeq;
  const r = await new Promise((resolve) => {
    micWait.set(id, resolve);
    overlay.webContents.send("voice:mics-req", id);
    setTimeout(() => { if (micWait.has(id)) { micWait.delete(id); resolve({ ok: false, error: "Нет ответа от окна голосового ввода." }); } }, 8000);
  });
  if (!overlay.isVisible()) scheduleIdle();
  return r;
}
async function test(on) {
  if (!ctx) return { ok: false, error: "Недоступно." };
  if (!on) { send("voice:test", { on: false }); return { ok: true }; }
  ensureOverlay();
  if (!(await whenReady(8000))) return { ok: false, error: "Окно голосового ввода не запустилось." };
  overlay.webContents.send("voice:test", { on: true, mic: ctx.getCfg().voiceMic || "" });
  scheduleIdle();
  return { ok: true };
}
function resetPos() {
  if (!live()) return;
  stopDrag(false);
  const p = defaultPos();
  if (overlay.isVisible()) overlay.setBounds({ x: p.x, y: p.y, width: ow(), height: oh() });
}

function registerHotkey() {
  if (hotkeyActive) { try { globalShortcut.unregister(hotkeyActive); } catch (e) {} hotkeyActive = null; }
  hotkeyError = "";
  const cfg = ctx.getCfg();
  if (!cfg.voiceEnabled) return { ok: true };
  try {
    if (globalShortcut.register(cfg.voiceHotkey, onHotkey)) { hotkeyActive = cfg.voiceHotkey; return { ok: true }; }
    hotkeyError = "Это сочетание занято другой программой.";
  } catch (e) {
    hotkeyError = "Недопустимое сочетание клавиш.";
  }
  return { ok: false, error: hotkeyError };
}

function destroy() {
  clearTimeout(idleTimer);
  stopDrag(false); pttStop();
  if (hotkeyActive) { try { globalShortcut.unregister(hotkeyActive); } catch (e) {} hotkeyActive = null; }
  if (live()) overlay.destroy();
  overlay = null; overlayReady = false; state = "idle"; pendingStart = false;
}

function init(c) {
  ctx = c; // { getWin, getCfg, isPackaged }
  if (inited) return;
  inited = true;
  setupPermissions();

  protocol.handle(SCHEME, async (req) => {
    try {
      const name = decodeURIComponent(new URL(req.url).pathname.replace(/^\/+/, ""));
      const map = fileMap();
      if (!Object.prototype.hasOwnProperty.call(map, name)) return new Response("Not found", { status: 404 });
      const buf = await fs.promises.readFile(map[name]);
      return new Response(buf, { headers: { "content-type": MIME[path.extname(name)] || "application/octet-stream", "cache-control": "no-store" } });
    } catch (e) {
      return new Response("Not found", { status: 404 });
    }
  });

  const fromOverlay = (e) => live() && e.sender === overlay.webContents;
  ipcMain.on("voice:ready", (e) => {
    if (!fromOverlay(e)) return;
    overlayReady = true;
    sendOpts();
    if (pendingStart) { const c = pendingStart === "start-ptt" ? "start-ptt" : "start"; pendingStart = false; overlay.webContents.send("voice:cmd", c); }
  });
  ipcMain.on("voice:status", (e, s) => { if (fromOverlay(e)) state = String(s); });
  ipcMain.on("voice:hide", (e) => {
    if (!fromOverlay(e)) return;
    stopDrag(false); pttStop();
    overlay.setIgnoreMouseEvents(true, { forward: true });
    overlay.hide(); state = "idle";
    if (ctx.getCfg().voiceEnabled) scheduleIdle();
    else overlay.destroy(); // голосовой ввод выключен — освобождаем память под распознавание сразу
  });

  // Панель управления оверлея: ловим мышь только пока курсор над ней, всё остальное остаётся «насквозь»
  ipcMain.on("voice:interactive", (e, on) => {
    if (!fromOverlay(e)) return;
    overlay.setIgnoreMouseEvents(!on, { forward: true });
  });
  ipcMain.on("voice:drag-start", (e) => { if (fromOverlay(e)) startDrag(); });
  ipcMain.on("voice:drag-end", (e) => { if (fromOverlay(e)) stopDrag(true); });
  ipcMain.on("voice:reset-pos", (e) => {
    if (!fromOverlay(e)) return;
    stopDrag(false);
    ctx.getCfg().voicePos = null;
    ctx.saveCfg();
    const p = defaultPos();
    overlay.setBounds({ x: p.x, y: p.y, width: ow(), height: oh() });
  });
  ipcMain.on("voice:set-opacity", (e, v) => {
    if (!fromOverlay(e)) return;
    ctx.applySet("voiceOpacity", v); // сохранит, обновит настройки в окне памятки и вернёт значение оверлею
  });
  ipcMain.on("voice:set-mode", (e, m) => {
    if (!fromOverlay(e)) return;
    ctx.applySet("voiceMode", m === "ai" ? "ai" : "search"); // сохранит режим и вернёт его оверлею
  });
  ipcMain.handle("voice:set-enabled", (e, on) => {
    if (!fromOverlay(e)) return { ok: false, enabled: !!ctx.getCfg().voiceEnabled, error: "Недоступно." };
    const r = ctx.applySet("voiceEnabled", !!on) || {};
    return { ok: r.ok !== false, error: r.error || "", enabled: !!ctx.getCfg().voiceEnabled };
  });
  ipcMain.handle("voice:search", (e, cands) => (fromOverlay(e) ? runSearch(cands) : { ok: false, error: "Недоступно." }));
  // 2.3: клик по карточке → статья в окне памятки; голосовые команды выполняет страница памятки (window.SA_voiceCmd)
  ipcMain.on("voice:open", (e, t) => { if (fromOverlay(e) && typeof ctx.openTarget === "function") ctx.openTarget(String(t || "").slice(0, 120)); });
  ipcMain.handle("voice:page-cmd", async (e, o) => {
    if (!fromOverlay(e)) return { handled: false };
    const w = ctx.getWin();
    if (!w || w.isDestroyed()) return { handled: false };
    const arg = { text: String((o && o.text) || "").slice(0, 300), query: String((o && o.query) || "").slice(0, 300) };
    try {
      const r = await w.webContents.executeJavaScript(`(typeof window.SA_voiceCmd==="function")?window.SA_voiceCmd(${JSON.stringify(arg)}):{handled:false}`, false);
      if (r && r.handled && r.show && typeof ctx.showMain === "function") ctx.showMain();
      return r && typeof r === "object" ? { handled: !!r.handled, ok: r.ok !== false, text: String(r.text || "").slice(0, 300) } : { handled: false };
    } catch (err) {
      return { handled: false };
    }
  });
  ipcMain.on("voice:mics-res", (e, id, r) => {
    if (!fromOverlay(e)) return;
    const done = micWait.get(id);
    if (!done) return;
    micWait.delete(id);
    const list = r && Array.isArray(r.list) ? r.list.slice(0, 30).map((m) => ({ id: String((m && m.id) || "").slice(0, 200), label: String((m && m.label) || "").slice(0, 120) })) : [];
    done(r && r.ok ? { ok: true, list } : { ok: false, error: String((r && r.error) || "Микрофон недоступен.").slice(0, 200) });
  });
  ipcMain.on("voice:level", (e, v) => {
    if (!fromOverlay(e) || typeof ctx.sendMain !== "function") return;
    ctx.sendMain("senko:voice-level", { level: Math.max(0, Math.min(1, +((v && v.level) || 0))), end: !!(v && v.end), error: v && v.error ? String(v.error).slice(0, 200) : "" });
  });
  // Вопрос ИИ из оверлея (текст уже распознан офлайн; аудио никуда не уходит)
  ipcMain.handle("voice:ai", (e, q) => (fromOverlay(e) && typeof ctx.askAi === "function" ? ctx.askAi(String(q || "").slice(0, 500), { short: true }) : { ok: false, error: "Недоступно." }));
}

// 2.2: для экрана «Состояние»: модель распознавания, состояние и клавиша
function status() {
  let model = { found: false, size: 0, path: "" };
  try {
    if (ctx) {
      const f = fileMap()["model.tar.gz"];
      model.path = f;
      if (fs.existsSync(f)) model = { found: true, size: fs.statSync(f).size, path: f };
    }
  } catch (e) {}
  return { inited: !!ctx, state, overlay: live(), model, hotkey: hotkeyActive || "", hotkeyError };
}

module.exports = { init, registerHotkey, destroy, applyOpts: sendOpts, hotkeyError: () => hotkeyError, status, mics, test, resetPos };
