const {
  app, BrowserWindow, shell, Menu, ipcMain, dialog, net, Tray, Notification,
  globalShortcut, screen, nativeImage, safeStorage, clipboard, nativeTheme
} = require("electron");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const voice = require("./voice"); // голосовой ввод и оверлей
const radio = require("./dispatch"); // 2.6: рация диспетчера
const mini = require("./mini"); // 2.4: мини-окно задержания поверх игры
const trayMenu = require("./traymenu"); // 2.5: своё меню значка в трее вместо системного
const dialogs = require("./dialogs"); // 2.8.0-beta.5: окна-сообщения в стиле программы
const ai = require("./ai");       // ИИ-помощник (через прокси)

// ───────────── НАСТРОЙКИ ─────────────
// Папка в репозитории GitHub, где лежат version.json и index.html для обновления данных памятки.
const UPDATE_BASE = "https://raw.githubusercontent.com/Kofemanchik/Senko-Assistant/main/update/";
const UPDATE_EVERY_MS = 3 * 60 * 60 * 1000; // повторная проверка раз в 3 часа
const KEEP_BACKUPS = 14;                    // сколько дневных копий хранить
const COMPACT_W = 360;                      // ширина «узкого» окна
// ──────────────────────────────────────

app.setAppUserModelId("local.boston.pamyatka"); // нужен для системных уведомлений Windows

// Папка данных: «%APPDATA%\Senko Assistant». До версии 2.2.0 она называлась «Boston»:
// при первом запуске новой версии содержимое переносится, заметки и настройки сохраняются.
const DATA_DIR = path.join(app.getPath("appData"), "Senko Assistant");
const OLD_DATA_DIR = path.join(app.getPath("appData"), "Boston");
// служебные папки Chromium: если такая уже есть в новой папке, старую копию можно просто удалить
const CHROMIUM_CACHES = ["Crashpad", "Cache", "Code Cache", "GPUCache", "DawnCache", "DawnGraphiteCache", "DawnWebGPUCache", "GrShaderCache", "ShaderCache", "blob_storage", "Shared Dictionary"];
function migrateDataDir() {
  try {
    if (!fs.existsSync(OLD_DATA_DIR)) return DATA_DIR;
    // перенос уже был (или программой уже пользовались с новой папкой)
    if (["app-settings.json", "session.json", "Local Storage"].some((f) => fs.existsSync(path.join(DATA_DIR, f)))) return DATA_DIR;
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const moved = [];
    try {
      for (const name of fs.readdirSync(OLD_DATA_DIR)) {
        const to = path.join(DATA_DIR, name);
        if (fs.existsSync(to)) {
          if (CHROMIUM_CACHES.includes(name)) continue;
          throw new Error("уже есть " + name);
        }
        fs.renameSync(path.join(OLD_DATA_DIR, name), to);
        moved.push(name);
      }
    } catch (e) {
      // файл занят (например, открыта старая версия) — возвращаем всё как было и работаем со старой папкой
      for (const name of moved.reverse()) {
        try { fs.renameSync(path.join(DATA_DIR, name), path.join(OLD_DATA_DIR, name)); } catch (e2) {}
      }
      return OLD_DATA_DIR;
    }
    for (const name of CHROMIUM_CACHES) {
      try { fs.rmSync(path.join(OLD_DATA_DIR, name), { recursive: true, force: true }); } catch (e) {}
    }
    try { fs.rmdirSync(OLD_DATA_DIR); } catch (e) {}
    return DATA_DIR;
  } catch (e) {
    return fs.existsSync(OLD_DATA_DIR) ? OLD_DATA_DIR : DATA_DIR;
  }
}
app.setPath("userData", migrateDataDir());

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.quit();

let win = null;       // главное окно (памятка)
let authWin = null;   // окно авторизации
let staffWin = null;  // окно «Список сотрудников»
let quitting = false; // true — программа действительно закрывается (а не прячется в трей)
let startHidden = process.argv.includes("--hidden"); // запуск из автозагрузки
// 2.2: ярлык «сразу на вкладке или статье»: Senko Assistant.exe --open=calc | --open=uk:12.8 | --open=field:f_radio
const OPEN_RE = /^[a-z_]{2,12}(?::[0-9a-z_.]{1,16})?$/i;
function openArg(argv) {
  const a = (argv || []).find((x) => /^--open=/.test(String(x)));
  const v = a ? String(a).slice(7).trim() : "";
  return OPEN_RE.test(v) ? v : "";
}
let pendingOpen = openArg(process.argv);

// ───────────── Автосохранение данных ─────────────
// Файл виден пользователю: Документы\Senko Assistant\Автосохранение
function saveDir() {
  return path.join(app.getPath("documents"), "Senko Assistant", "Автосохранение");
}
const mainFile = () => path.join(saveDir(), "senko-data.json");
const backupDir = () => path.join(saveDir(), "Резервные копии");

function readJson(file) {
  try {
    const j = JSON.parse(fs.readFileSync(file, "utf8"));
    return j && typeof j === "object" ? j : null;
  } catch (e) {
    return null;
  }
}

function writeAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, text, "utf8");
  fs.renameSync(tmp, file);
}

function newestBackup() {
  try {
    const files = fs.readdirSync(backupDir()).filter((f) => f.endsWith(".json")).sort().reverse();
    for (const f of files) {
      const j = readJson(path.join(backupDir(), f));
      if (j && j.data) return j;
    }
  } catch (e) {}
  return null;
}

ipcMain.on("sa:load", (e) => {
  let j = readJson(mainFile());
  if (!j || !j.data) j = newestBackup(); // основной файл повреждён → берём последнюю копию
  e.returnValue = j;
});

ipcMain.on("sa:save", (_e, data) => {
  try {
    if (!data || typeof data !== "object") return;
    fs.mkdirSync(backupDir(), { recursive: true });
    const payload = JSON.stringify(
      { app: "Senko Assistant", version: currentVersion(), savedAt: new Date().toISOString(), data },
      null,
      2
    );
    writeAtomic(mainFile(), payload);

    // Одна резервная копия в день (последнее состояние дня перезаписывает копию)
    const day = new Date().toISOString().slice(0, 10);
    fs.writeFileSync(path.join(backupDir(), `senko-data-${day}.json`), payload, "utf8");
    const old = fs.readdirSync(backupDir()).filter((f) => f.endsWith(".json")).sort().reverse().slice(KEEP_BACKUPS);
    for (const f of old) fs.unlinkSync(path.join(backupDir(), f));
  } catch (err) {
    console.error("autosave failed:", err);
  }
});

// ───────────── Аккаунты ─────────────
// Аккаунты хранятся на сервере (Supabase), см. accounts.js и server-config.js
const accounts = require("./accounts")({
  dataDir: () => app.getPath("userData"),
  docsDir: () => path.join(app.getPath("documents"), "Senko Assistant"),
  fetch: (url, opts) => net.fetch(url, opts),
  safeStorage,
  config: require("./server-config"),
  version: app.getVersion()
});

// Синхронизация данных работы (задержания, тесты, статистика) между компьютерами, см. sync.js
const sync = require("./sync")({
  dataDir: () => app.getPath("userData"),
  authed: (body) => accounts.authed(body),
  onAuthLost: (r) => setTimeout(() => logout(r.error), 0),
  backupDir: () => path.join(app.getPath("documents"), "Senko Assistant", "Автосохранение", "Данные другого аккаунта")
});

// ───────────── Настройки программы (.exe) ─────────────
const DEFAULTS = {
  alwaysOnTop: false,    // окно поверх всех окон
  hotkeyEnabled: false,  // глобальная горячая клавиша
  hotkey: "Ctrl+Alt+S",
  compact: false,        // узкий компактный режим
  rememberBounds: true,  // помнить размер и позицию
  opacity: 100,          // прозрачность окна, %
  tray: false,           // значок в трее + работа в фоне
  notify: true,          // системные уведомления таймера
  bounds: null,          // последние границы обычного окна
  compactBounds: null,   // последние границы узкого окна
  maximized: false,
  voiceEnabled: true,        // голосовой ввод (оверлей)
  voiceHotkey: "Ctrl+Alt+V", // горячая клавиша голосового ввода
  voiceOpacity: 80,          // непрозрачность оверлея, %
  voicePos: null,            // позиция оверлея на экране {x, y} (null — по центру сверху)
  voiceMode: "search",       // режим оверлея: search — поиск по памятке, ai — вопрос ИИ
  voiceHide: 10,             // 2.3: через сколько секунд оверлей прячется после ответа (3–60)
  voiceSize: "m",            // 2.3: размер окна оверлея s | m | l
  voiceFont: 100,            // 2.3: размер шрифта оверлея, % (80–150)
  voicePtt: false,           // 2.3: «нажал и держи» — запись, пока клавиша зажата
  voiceMic: "",              // 2.3: выбранный микрофон (deviceId окна оверлея; пусто — как в Windows)
  ghost: false,              // «призрачный режим»: окно становится полупрозрачным, когда переключаешься в игру
  ghostOpacity: 55,          // прозрачность окна в призрачном режиме, %
  miniEnabled: true,         // 2.4: мини-окно задержания по горячей клавише
  miniHotkey: "Ctrl+Alt+M",
  miniOpacity: 90,           // непрозрачность мини-окна, %
  miniWidth: 320,            // ширина мини-окна: 260 | 320 | 400
  miniPos: null,             // позиция мини-окна {x, y}
  betaUpdates: false,        // 2.4: бета-версии через автообновление (только для тестеров)
  radioEnabled: true,        // 2.6: рация диспетчера (говорить, пока зажата клавиша)
  radioHotkey: "Ctrl+Alt+R",
  radioPin: false,           // рация всегда на экране (иначе прячется после ответа)
  radioHide: 20,             // через сколько секунд прятать рацию (5–120)
  radioVoice: true,          // диспетчер отвечает голосом
  radioVoiceName: "",        // голос Windows (пусто — первый русский)
  radioRate: 105,            // скорость речи, % (60–180)
  radioSfx: true,            // щелчки и шипение рации
  radioOnline: true,         // 2.6.1: распознавать речь онлайн (Whisper через ИИ-прокси), без сети — офлайн
  radioSize: "m",            // размер рации s | m | l
  radioPos: null             // позиция рации {x, y}
};
// 2.2: режимы окна (призрак по курсору, полоска, прилипание, профили, реакция на программу, поиск OBS и т. п.)
const winx = require("./winx")({
  win: () => win, cfg: () => cfg, save: () => saveCfg(), apply: () => applyWindowCfg(), push: () => pushState(),
  setCompact: (on) => setCompact(on), visible: (b) => visibleBounds(b)
});
Object.assign(DEFAULTS, winx.defaults);
let cfg = { ...DEFAULTS };
const cfgFile = () => path.join(app.getPath("userData"), "app-settings.json");

function loadCfg() {
  const j = readJson(cfgFile()) || {};
  cfg = { ...DEFAULTS, ...j };
  for (const k of ["alwaysOnTop", "hotkeyEnabled", "compact", "rememberBounds", "tray", "notify", "maximized", "voiceEnabled", "ghost", "voicePtt", "miniEnabled", "betaUpdates", "radioEnabled", "radioPin", "radioVoice", "radioSfx", "radioOnline"]) cfg[k] = !!cfg[k];
  if (!validHotkey(cfg.radioHotkey)) cfg.radioHotkey = DEFAULTS.radioHotkey;
  cfg.radioHide = Math.min(120, Math.max(5, Math.round(+cfg.radioHide || DEFAULTS.radioHide)));
  cfg.radioRate = Math.min(180, Math.max(60, Math.round(+cfg.radioRate || DEFAULTS.radioRate)));
  if (!["s", "m", "l"].includes(cfg.radioSize)) cfg.radioSize = "m";
  cfg.radioVoiceName = typeof cfg.radioVoiceName === "string" ? cfg.radioVoiceName.slice(0, 200) : "";
  { const rp = cfg.radioPos; cfg.radioPos = rp && Number.isFinite(+rp.x) && Number.isFinite(+rp.y) ? { x: Math.round(+rp.x), y: Math.round(+rp.y) } : null; }
  cfg.miniOpacity = Math.min(100, Math.max(30, Math.round(+cfg.miniOpacity || DEFAULTS.miniOpacity)));
  if (!validHotkey(cfg.miniHotkey)) cfg.miniHotkey = DEFAULTS.miniHotkey;
  const mp = cfg.miniPos;
  cfg.miniPos = mp && Number.isFinite(+mp.x) && Number.isFinite(+mp.y) ? { x: Math.round(+mp.x), y: Math.round(+mp.y) } : null;
  cfg.ghostOpacity = Math.min(90, Math.max(20, Math.round(+cfg.ghostOpacity || DEFAULTS.ghostOpacity)));
  cfg.voiceOpacity = Math.min(100, Math.max(30, Math.round(+cfg.voiceOpacity || DEFAULTS.voiceOpacity)));
  const vp = cfg.voicePos;
  cfg.voicePos = vp && Number.isFinite(+vp.x) && Number.isFinite(+vp.y) ? { x: Math.round(+vp.x), y: Math.round(+vp.y) } : null;
  if (!validHotkey(cfg.voiceHotkey)) cfg.voiceHotkey = DEFAULTS.voiceHotkey;
  if (cfg.voiceMode !== "ai") cfg.voiceMode = "search";
  cfg.voiceHide = Math.min(60, Math.max(3, Math.round(+cfg.voiceHide || DEFAULTS.voiceHide)));
  if (!["s", "m", "l"].includes(cfg.voiceSize)) cfg.voiceSize = "m";
  cfg.voiceFont = Math.min(150, Math.max(80, Math.round(+cfg.voiceFont || DEFAULTS.voiceFont)));
  cfg.voiceMic = typeof cfg.voiceMic === "string" && cfg.voiceMic.length <= 200 ? cfg.voiceMic : "";
  cfg.opacity = Math.min(100, Math.max(30, Math.round(+cfg.opacity || 100)));
  if (!validHotkey(cfg.hotkey)) cfg.hotkey = DEFAULTS.hotkey;
  winx.fix(cfg);
}
let cfgTimer = null;
function saveCfg() {
  clearTimeout(cfgTimer);
  cfgTimer = setTimeout(() => {
    try { writeAtomic(cfgFile(), JSON.stringify(cfg, null, 2)); } catch (e) {}
  }, 300);
}
function saveCfgNow() {
  clearTimeout(cfgTimer);
  try { writeAtomic(cfgFile(), JSON.stringify(cfg, null, 2)); } catch (e) {}
}

// ───────────── Обновление данных (index.html) через GitHub ─────────────
const updDir = () => path.join(app.getPath("userData"), "app");
const updIndex = () => path.join(updDir(), "index.html");
const updMeta = () => path.join(updDir(), "meta.json");
const bundledIndex = () => path.join(__dirname, "app", "index.html");
const updPrev = () => path.join(updDir(), "index.prev.html");
const updPrevMeta = () => path.join(updDir(), "meta.prev.json");
const holdFile = () => path.join(app.getPath("userData"), "data-hold.json"); // 2.2: откат данных ставит автообновление на паузу
const holdGet = () => readJson(holdFile()) || {};
function holdSet(k, v) { const h = holdGet(); if (v) h[k] = v; else delete h[k]; try { writeAtomic(holdFile(), JSON.stringify(h)); } catch (e) {} }

function cmpVer(a, b) {
  const pa = String(a).split(".").map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d > 0 ? 1 : -1;
  }
  return 0;
}

// Какая версия HTML сейчас используется: скачанная (если новее встроенной) или встроенная
function pickIndex() {
  const meta = readJson(updMeta());
  if (meta && meta.version && fs.existsSync(updIndex()) && cmpVer(meta.version, app.getVersion()) > 0) {
    return { file: updIndex(), version: meta.version };
  }
  return { file: bundledIndex(), version: app.getVersion() };
}
function currentVersion() {
  return pickIndex().version;
}

// Родитель для диалогов: только если окно сейчас на экране
function dlgParent() {
  return win && !win.isDestroyed() && win.isVisible() && !win.isMinimized() ? win : null;
}
// 2.8.0-beta.5: сообщения рисуются своим окном в стиле программы; системное окно Windows — только если своё не открылось
function box(opts) {
  const p = dlgParent();
  try {
    return dialogs.show(opts, p);
  } catch (e) {
    const o = { ...opts }; delete o.rows;
    if (opts.rows && opts.rows.length) o.detail = opts.rows.map((r) => r[0] + ": " + r[1]).join("\n") + (opts.detail ? "\n\n" + opts.detail : "");
    return p ? dialog.showMessageBox(p, o) : dialog.showMessageBox(o);
  }
}

async function checkForUpdate(manual) {
  if (UPDATE_BASE.includes("OWNER/REPO")) return; // заглушка не заменена — обновления выключены
  if (holdGet().memo) return; // пользователь откатил данные: ждём, пока он сам вернёт обновления
  try {
    const t = Date.now();
    const res = await net.fetch(UPDATE_BASE + "version.json?t=" + t, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) return;
    const info = await res.json();
    if (!info || !info.version || !info.sha256) return;
    if (cmpVer(info.version, currentVersion()) <= 0) return;

    const fileRes = await net.fetch(UPDATE_BASE + (info.file || "index.html") + "?t=" + t, {
      signal: AbortSignal.timeout(60000)
    });
    if (!fileRes.ok) return;
    const buf = Buffer.from(await fileRes.arrayBuffer());

    // Проверки целостности: хэш, размер, что это HTML
    const hash = crypto.createHash("sha256").update(buf).digest("hex");
    if (hash !== String(info.sha256).toLowerCase()) return;
    if (buf.length < 50 * 1024) return;
    if (!/^\s*<!doctype html/i.test(buf.subarray(0, 64).toString("utf8"))) return;

    fs.mkdirSync(updDir(), { recursive: true });
    // прошлая скачанная версия остаётся для отката (Настройки → «Откат данных»)
    try { if (fs.existsSync(updIndex()) && fs.existsSync(updMeta())) { fs.copyFileSync(updIndex(), updPrev()); fs.copyFileSync(updMeta(), updPrevMeta()); } } catch (e) {}
    fs.writeFileSync(updIndex() + ".tmp", buf);
    fs.renameSync(updIndex() + ".tmp", updIndex());
    fs.writeFileSync(updMeta(), JSON.stringify({ version: info.version, hash, at: new Date().toISOString() }));

    if (win && !win.isDestroyed()) {
      const r = await box({
        type: "info",
        title: "Обновление",
        message: `Доступна новая версия памятки (${info.version}).`,
        detail: (info.notes ? info.notes + "\n\n" : "") + "Данные уже скачаны. Перезагрузить сейчас?",
        buttons: ["Перезагрузить", "Позже"],
        defaultId: 0,
        cancelId: 1
      });
      if (r.response === 0 && win && !win.isDestroyed()) win.loadFile(pickIndex().file);
    }
  } catch (e) {
    // нет сети / GitHub недоступен — работаем с тем, что есть
  }
}

// ───────────── Автообновление самой программы (установщика) ─────────────
// Работает через GitHub Releases: electron-updater читает latest.yml из последнего релиза,
// скачивает новый установщик в фоне и предлагает перезапуск.
// Каждое ручное нажатие «Проверить обновления» получает ответ: найдено / скачивается / готово / последняя версия / ошибка.
// Всё, что делает обновлятор, пишется в «%APPDATA%\Senko Assistant\updater.log» (до 2.2.0 — «%APPDATA%\Boston\updater.log»).
const RELEASES_URL = "https://github.com/Kofemanchik/Senko-Assistant/releases/latest";
let updater = null;
let manualCheck = false;
let manualTimer = null;
const upd = { state: "idle", version: "", percent: 0 };

// 2.9: экран загрузки обновления. Появляется, когда найдена новая версия, и не исчезает, пока она не скачается; показывает шкалу и проценты
let updWin = null;
function showUpdScreen() {
  if (updWin && !updWin.isDestroyed()) { updWin.show(); return; }
  updWin = new BrowserWindow({
    width: 440, height: 330, resizable: false, minimizable: false, maximizable: false, fullscreenable: false,
    alwaysOnTop: true, center: true, frame: false, show: false, title: "Обновление Senko Assistant", autoHideMenuBar: true,
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#0A0A0B" : "#F6F3EE", icon: iconPath(),
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: false }
  });
  const w = updWin;
  w.setMenu(null);
  w.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  w.webContents.on("will-navigate", (e) => e.preventDefault());
  w.once("ready-to-show", () => { if (!w.isDestroyed()) { w.show(); setUpdScreen(); } });
  w.on("close", (e) => { if (!quitting && updWin === w) e.preventDefault(); }); // пока идёт загрузка, окно не закрывается (кроме выхода из программы)
  w.on("closed", () => { if (updWin === w) updWin = null; });
  w.loadFile(path.join(__dirname, "app", "update.html")).catch(() => {});
}
function setUpdScreen() {
  if (!updWin || updWin.isDestroyed()) return;
  updWin.webContents.executeJavaScript(`setV(${JSON.stringify(String(upd.version || ""))});setP(${+upd.percent || 0})`).catch(() => {});
}
function hideUpdScreen() {
  if (!updWin || updWin.isDestroyed()) { updWin = null; return; }
  const w = updWin; updWin = null;
  w.destroy();
}

function info(message, detail) {
  return box({ type: "info", title: "Senko Assistant", message, detail, buttons: ["OK"], noLink: true });
}
const updLogFile = () => path.join(app.getPath("userData"), "updater.log");
function updLog(level, ...a) {
  try {
    const f = updLogFile();
    try { if (fs.statSync(f).size > 256 * 1024) fs.renameSync(f, f + ".old"); } catch (e) {}
    fs.appendFileSync(f, `${new Date().toISOString()} ${level} ${a.map((x) => (x instanceof Error ? x.stack || x.message : typeof x === "string" ? x : JSON.stringify(x))).join(" ")}\n`);
  } catch (e) {}
}
function endManual() {
  manualCheck = false;
  clearTimeout(manualTimer);
}
// 2.2: техническую ошибку переводим в понятную причину и совет, что делать
const UPD_REASONS = [
  [/ERR_INTERNET_DISCONNECTED|ENOTFOUND|ERR_NAME_NOT_RESOLVED|EAI_AGAIN|ERR_NETWORK_CHANGED/i, "Нет интернета или не открывается GitHub.", "Проверьте подключение к интернету и попробуйте ещё раз."],
  [/ETIMEDOUT|ERR_TIMED_OUT|ERR_CONNECTION_TIMED_OUT|timeout|не ответила за/i, "GitHub не ответил вовремя.", "Скорее всего, медленный интернет или GitHub перегружен. Попробуйте через несколько минут."],
  [/ECONNRESET|ERR_CONNECTION_RESET|ERR_CONNECTION_CLOSED|socket hang up/i, "Соединение оборвалось во время загрузки.", "Повторите проверку. Если повторяется, мешает антивирус, VPN или прокси."],
  [/ERR_PROXY|ERR_TUNNEL/i, "Не удалось пройти через прокси.", "Проверьте настройки прокси или VPN в Windows."],
  [/CERT|certificate|self.signed|UNABLE_TO_VERIFY/i, "Ошибка сертификата защищённого соединения.", "Проверьте дату и время на компьютере. Иногда соединение подменяет антивирус."],
  [/\b404\b|latest\.yml|Cannot find|No published versions|not found/i, "В релизе на GitHub нет нужных файлов обновления.", "Релиз ещё собирается или в нём нет latest.yml. Подождите или скачайте установщик вручную."],
  [/\b403\b|rate limit|\b429\b/i, "GitHub временно ограничил запросы.", "Подождите час и попробуйте снова."],
  [/sha512|checksum|mismatch/i, "Скачанный файл повреждён: контрольная сумма не совпала.", "Попробуйте ещё раз. Если повторяется, скачайте установщик вручную."],
  [/ENOSPC|no space/i, "На диске не хватает места.", "Освободите место на диске C и повторите."],
  [/EPERM|EACCES|EBUSY|operation not permitted|access is denied/i, "Нет доступа к папке обновлений или файл занят.", "Закройте другие копии программы. Иногда файл держит антивирус."],
  [/not signed|publisherName|signature/i, "Подпись установщика не прошла проверку.", "Скачайте установщик вручную со страницы релизов."]
];
function updReason(err, message) {
  const raw = err ? String((err && err.message) || err).split("\n")[0].slice(0, 300) : "";
  const hay = raw + " " + (message || "");
  for (const [re, why, tip] of UPD_REASONS) if (re.test(hay)) return { why, tip, raw };
  return { why: raw || message || "Неизвестная ошибка.", tip: "Посмотрите журнал обновлений или скачайте установщик вручную.", raw };
}
// Ошибка или нет ответа: показать причину и дать скачать установщик вручную
async function updFail(message, err) {
  const R = updReason(err, message);
  upd.lastError = { at: Date.now(), message, why: R.why, raw: R.raw };
  updLog("error", "fail:", message, "| причина:", R.why, R.raw ? "| " + R.raw : "");
  const r = await box({
    type: "warning",
    title: "Senko Assistant",
    message: message + " " + R.why,
    detail: "Что делать: " + R.tip + (R.raw && R.raw !== R.why ? "\n\nТехнически: " + R.raw : "") + "\n\nНовую версию можно скачать вручную со страницы релизов: установщик ставится поверх, данные сохранятся. Подробности в журнале: " + updLogFile(),
    buttons: ["Скачать вручную", "Открыть журнал", "Закрыть"],
    defaultId: 0,
    cancelId: 2,
    noLink: true
  });
  if (r.response === 0) shell.openExternal(RELEASES_URL);
  else if (r.response === 1) shell.openPath(updLogFile());
}
async function askRestart() {
  const r = await box({
    type: "info",
    title: "Обновление программы",
    message: `Новая версия Senko Assistant (${upd.version}) загружена.`,
    detail: "Перезапустить программу и установить обновление сейчас? Заметки и настройки сохранятся.",
    buttons: ["Перезапустить и обновить", "Позже"],
    defaultId: 0,
    cancelId: 1
  });
  if (r.response === 0 && updater) {
    quitting = true;
    updater.quitAndInstall(true, true); // тихо: у установщика теперь мастер, при обновлении его показывать не нужно
  } // «Позже» — обновление установится при следующем выходе из программы
}

function initUpdater() {
  if (!app.isPackaged) return; // в режиме разработки (npm start) не работает
  try {
    const { autoUpdater } = require("electron-updater");
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.allowPrerelease = !!cfg.betaUpdates; // 2.4: тестеры получают бета-версии
    autoUpdater.logger = { info: (...a) => updLog("info", ...a), warn: (...a) => updLog("warn", ...a), error: (...a) => updLog("error", ...a), debug: () => {} };
    autoUpdater.on("checking-for-update", () => { if (upd.state !== "ready" && upd.state !== "downloading") upd.state = "checking"; });
    autoUpdater.on("update-available", (i) => {
      upd.state = "downloading"; upd.version = i.version; upd.percent = 0;
      showUpdScreen();
      if (manualCheck) {
        endManual();
      }
    });
    autoUpdater.on("download-progress", (p) => { upd.percent = Math.round(p.percent || 0); setUpdScreen(); });
    autoUpdater.on("update-not-available", () => {
      if (upd.state === "checking") upd.state = "idle";
      if (manualCheck) {
        endManual();
        info("У вас последняя версия программы.", `Версия ${app.getVersion()}`);
      }
    });
    autoUpdater.on("error", (err) => {
      updLog("error", "updater:", err);
      upd.lastError = { at: Date.now(), message: "Фоновая проверка", why: updReason(err).why, raw: updReason(err).raw };
      if (upd.state !== "ready") upd.state = "idle";
      hideUpdScreen();
      if (manualCheck) {
        endManual();
        updFail("Не удалось проверить или скачать обновление.", err);
      }
    });
    autoUpdater.on("update-downloaded", (i) => {
      endManual();
      upd.state = "ready"; upd.version = i.version; upd.percent = 100;
      setUpdScreen();
      setTimeout(() => { hideUpdScreen(); askRestart(); }, 900);
    });
    updater = autoUpdater;
    updLog("info", `start ${app.getVersion()}`);
  } catch (e) {
    updater = null; // electron-updater не установлен
    updLog("error", "electron-updater не загрузился:", e);
  }
}

function checkForAppUpdate(manual) {
  if (!updater) {
    if (manual) updFail(app.isPackaged ? "Модуль обновлений не загрузился." : "Автообновление работает только в установленной версии программы.");
    return;
  }
  if (manual) {
    // обновление уже скачано или качается: сразу говорим, что с ним
    if (upd.state === "ready") { askRestart(); return; }
    if (upd.state === "downloading") {
      showUpdScreen();
      return;
    }
    manualCheck = true;
    clearTimeout(manualTimer);
    manualTimer = setTimeout(() => {
      if (!manualCheck) return;
      endManual();
      updFail("Проверка обновлений не ответила за 40 секунд.");
    }, 40000);
  }
  // фоновая проверка не сбрасывает ручную: ответ на нажатие всё равно придёт
  updater.checkForUpdates().catch((err) => {
    updLog("error", "checkForUpdates:", err);
    if (manualCheck) {
      endManual();
      updFail("Не удалось проверить обновления.", err);
    }
  });
}

// ───────────── Окно: границы, режимы ─────────────
const iconPath = () => path.join(__dirname, "build", "icon.ico");
const boundsKey = () => (cfg.compact ? "compactBounds" : "bounds");

function visibleBounds(b) {
  if (!b || ![b.x, b.y, b.width, b.height].every(Number.isFinite)) return null;
  if (b.width < 200 || b.height < 300) return null;
  const ok = screen.getAllDisplays().some((d) => {
    const a = d.workArea;
    return b.x + b.width > a.x + 60 && b.x < a.x + a.width - 60 && b.y >= a.y - 10 && b.y < a.y + a.height - 60;
  });
  return ok ? { x: Math.round(b.x), y: Math.round(b.y), width: Math.round(b.width), height: Math.round(b.height) } : null;
}

function saveBoundsNow() {
  if (winx.stripped()) return; // свёрнутое в полоску окно не запоминаем
  if (!cfg.rememberBounds || !win || win.isDestroyed() || win.isMinimized() || win.isFullScreen()) return;
  if (win.isMaximized()) {
    if (!cfg.compact) cfg.maximized = true;
  } else {
    if (!cfg.compact) cfg.maximized = false;
    cfg[boundsKey()] = win.getBounds();
  }
  saveCfg();
}
let boundsTimer = null;
function saveBoundsSoon() {
  clearTimeout(boundsTimer);
  boundsTimer = setTimeout(saveBoundsNow, 500);
}

function setCompact(on) {
  if (!win || win.isDestroyed()) { cfg.compact = on; return; }
  saveBoundsNow(); // запомнить границы прежнего режима
  if (win.isMaximized()) win.unmaximize();
  const cur = win.getBounds();
  cfg.compact = on;
  if (on) cfg.maximized = false;
  win.setMinimumSize(on ? 300 : 380, on ? 400 : 600);
  const saved = cfg.rememberBounds ? visibleBounds(cfg[boundsKey()]) : null;
  win.setBounds(saved || { x: cur.x, y: cur.y, width: on ? COMPACT_W : 560, height: cur.height });
}

function applyWindowCfg() {
  if (!win || win.isDestroyed()) return;
  win.setAlwaysOnTop(cfg.alwaysOnTop, "screen-saver");
  win.setOpacity(windowOpacity() / 100);
}
// Призрачный режим: пока окно не в фокусе (или курсор ушёл с окна), оно полупрозрачное.
// Когда активна выбранная программа (например, игра), окно может стать ещё прозрачнее.
function windowOpacity() {
  let o = cfg.opacity;
  if (cfg.ghost && winx.ghostNow()) o = Math.min(o, cfg.ghostOpacity);
  if (winx.fadeNow()) o = Math.min(o, cfg.watchOpacity);
  return o;
}

// ───────────── Своя строка заголовка (окно без системной рамки) ─────────────
function winState() {
  const w = win && !win.isDestroyed() ? win : null;
  return {
    max: !!(w && w.isMaximized()), focused: !!(w && w.isFocused()),
    top: cfg.alwaysOnTop, compact: cfg.compact, ghost: cfg.ghost, opacity: cfg.opacity, ghostOpacity: cfg.ghostOpacity,
    tray: !!(cfg.tray && tray), hotkey: cfg.hotkeyEnabled ? cfg.hotkey : "", version: app.getVersion(),
    staff: accounts.isStaff(), user: !!accounts.current(), ...winx.state()
  };
}
function pushWin() {
  if (win && !win.isDestroyed()) win.webContents.send("senko:winstate", winState());
}
// Прижать окно к краю экрана во всю высоту: удобно держать памятку рядом с игрой
function dockWindow(side) {
  if (!win || win.isDestroyed()) return;
  if (win.isMaximized()) win.unmaximize();
  const area = screen.getDisplayMatching(win.getBounds()).workArea;
  const width = Math.min(Math.max(win.getBounds().width, cfg.compact ? COMPACT_W : 420), Math.round(area.width / 2));
  win.setBounds({ x: side === "left" ? area.x : area.x + area.width - width, y: area.y, width, height: area.height });
}

function showWindow() {
  if (!win || win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.moveTop();
  win.focus();
}
function toggleWindow() {
  if (!win || win.isDestroyed()) return;
  if (win.isVisible() && !win.isMinimized() && win.isFocused()) {
    if (cfg.tray) win.hide();
    else win.minimize();
  } else {
    showWindow();
  }
}

// ───────────── Горячая клавиша ─────────────
const HOTKEY_RE = /^((Ctrl|Alt|Shift|Super)\+)+([A-Z0-9]|F([1-9]|1[0-9]|2[0-4])|Space|Tab|Enter|Backspace|Delete|Insert|Home|End|PageUp|PageDown|Up|Down|Left|Right)$/;
function validHotkey(s) {
  return typeof s === "string" && HOTKEY_RE.test(s) && /(Ctrl|Alt|Super)\+/.test(s);
}
let hotkeyActive = null;
let hotkeyError = "";
function registerHotkey() {
  if (hotkeyActive) {
    try { globalShortcut.unregister(hotkeyActive); } catch (e) {}
    hotkeyActive = null;
  }
  hotkeyError = "";
  if (!cfg.hotkeyEnabled) return { ok: true };
  try {
    if (globalShortcut.register(cfg.hotkey, toggleWindow)) {
      hotkeyActive = cfg.hotkey;
      return { ok: true };
    }
    hotkeyError = "Это сочетание занято другой программой.";
  } catch (e) {
    hotkeyError = "Недопустимое сочетание клавиш.";
  }
  return { ok: false, error: hotkeyError };
}

// ───────────── Трей ─────────────
let tray = null;
function ensureTray() {
  if (cfg.tray && !tray) {
    try {
      tray = new Tray(nativeImage.createFromPath(iconPath()));
      tray.setToolTip("Senko Assistant");
      tray.on("click", toggleWindow);
      // В Linux значок трея не получает правый щелчок без системного меню, там остаётся оно
      if (process.platform !== "linux") tray.on("right-click", (e, b) => trayMenu.show(b || (tray && tray.getBounds())));
      updateTrayMenu();
    } catch (e) {
      tray = null;
    }
  } else if (!cfg.tray && tray) {
    tray.destroy();
    tray = null;
  }
}
function trayState() {
  const u = accounts.current();
  const P = cfg.winProfiles || {};
  return {
    version: app.getVersion(),
    user: u ? { login: u.login, nick: u.nick, offline: !!u.offline } : null,
    visible: !!(win && !win.isDestroyed() && win.isVisible() && !win.isMinimized()),
    alwaysOnTop: !!cfg.alwaysOnTop, compact: !!cfg.compact,
    voiceEnabled: !!cfg.voiceEnabled, voiceHotkey: cfg.voiceHotkey,
    mini: mini.isOpen(), miniHotkey: cfg.miniHotkey,
    radio: radio.isOpen(), radioEnabled: !!cfg.radioEnabled, radioHotkey: cfg.radioHotkey,
    profiles: [["game", "В игре"], ["desk", "За столом"]].filter(([k]) => P[k]).map(([k, n]) => ({ k, n, on: cfg.winProfile === k })),
    staff: accounts.isStaff()
  };
}
// действие из меню трея; true — меню остаётся открытым (переключатели), false — закрывается
function trayAct(k, v) {
  if (["alwaysOnTop", "compact", "voiceEnabled", "mini", "radio"].includes(k)) { applySet(k, !!v); return true; }
  if (k === "profile") { if (cfg.winProfiles && cfg.winProfiles[v]) { winx.profUse(v); updateTrayMenu(); } return true; }
  if (k === "toggle") {
    if (win && !win.isDestroyed() && win.isVisible() && !win.isMinimized()) { if (cfg.tray) win.hide(); else win.minimize(); }
    else showWindow();
  } else if (k === "staff") openStaff();
  else if (k === "update") { checkForAppUpdate(true); checkForUpdate(true); }
  else if (k === "about") showAbout();
  else if (k === "logout") logout();
  else if (k === "quit") { quitting = true; app.quit(); }
  return false;
}
function updateTrayMenu() {
  if (!tray) return;
  if (process.platform !== "linux") { trayMenu.refresh(); return; }
  const u = accounts.current();
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "Показать / скрыть окно", click: toggleWindow },
      { type: "separator" },
      { label: "Поверх всех окон", type: "checkbox", checked: cfg.alwaysOnTop, click: (m) => applySet("alwaysOnTop", m.checked) },
      { label: "Компактный режим", type: "checkbox", checked: cfg.compact, click: (m) => applySet("compact", m.checked) },
      ...(cfg.winProfiles.game || cfg.winProfiles.desk ? [{ label: "Профиль окна", submenu: [["game", "В игре"], ["desk", "За столом"]].filter(([k]) => cfg.winProfiles[k]).map(([k, n]) => ({ label: n, type: "radio", checked: cfg.winProfile === k, click: () => { winx.profUse(k); updateTrayMenu(); } })) }] : []),
      { label: `Голосовой ввод (${cfg.voiceHotkey})`, type: "checkbox", checked: cfg.voiceEnabled, click: (m) => applySet("voiceEnabled", m.checked) },
      { label: `Мини-окно задержания (${cfg.miniHotkey})`, type: "checkbox", checked: mini.isOpen(), click: (m) => applySet("mini", m.checked) },
      ...(cfg.radioEnabled ? [{ label: `Рация диспетчера (${cfg.radioHotkey})`, type: "checkbox", checked: radio.isOpen(), click: (m) => applySet("radio", m.checked) }] : []),
      { type: "separator" },
      ...(accounts.isStaff() ? [{ label: "Список сотрудников", click: openStaff }] : []),
      { label: "О программе", click: showAbout },
      { label: "Проверить обновления", click: () => { checkForAppUpdate(true); checkForUpdate(true); } },
      ...(u ? [{ label: `Выйти из аккаунта (${u.login})`, click: () => logout() }] : []),
      { type: "separator" },
      { label: "Выход", click: () => { quitting = true; app.quit(); } }
    ])
  );
}

// ───────────── Автозапуск ─────────────
// Запись в реестре (HKCU\...\Run) сравнивается вместе с аргументами, поэтому проверять её нужно с теми же
// path и args, с какими она записана. Путь в кавычках: в нём есть пробелы («Senko Assistant.exe»).
const LOGIN_ITEM = () => ({ path: `"${process.execPath}"`, args: ["--hidden"] });
function getAutostart() {
  try { return !!app.getLoginItemSettings(LOGIN_ITEM()).openAtLogin; } catch (e) { return false; }
}
function setAutostart(on, enabled = true) {
  app.setLoginItemSettings({ openAtLogin: !!on, enabled, ...LOGIN_ITEM() });
}
// Если автозапуск был включён, но запись ведёт на старое место программы (папка «boston-pamyatka»)
// или записана в старом формате (путь без кавычек), переписываем её на текущий exe.
// Отключение в Диспетчере задач (StartupApproved) сохраняется.
function refreshAutostart() {
  if (!app.isPackaged || process.platform !== "win32") return;
  const name = "local.boston.pamyatka"; // = AppUserModelId: под этим именем Electron пишет запись в Run
  const KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion";
  const { execFile } = require("child_process");
  execFile("reg", ["query", KEY + "\\Run", "/v", name], { windowsHide: true }, (err, out) => {
    if (err || !out || getAutostart()) return; // записи нет (автозапуск выключен) или она уже правильная
    execFile("reg", ["query", KEY + "\\Explorer\\StartupApproved\\Run", "/v", name], { windowsHide: true }, (err2, out2) => {
      const disabled = !err2 && /REG_BINARY\s+0[13]/i.test(out2 || "");
      try { setAutostart(true, !disabled); } catch (e) {}
    });
  });
}
// До 2.2.0 программа стояла в «...\Programs\boston-pamyatka», а обновления качала в «boston-pamyatka-updater».
// После переезда (см. build/installer.nsh) от них остаются пустая папка и старый кэш загрузки.
function removeOldFolders() {
  const base = process.env.LOCALAPPDATA;
  if (!app.isPackaged || !base) return;
  try { fs.rmSync(path.join(base, "boston-pamyatka-updater"), { recursive: true, force: true }); } catch (e) {}
  try { fs.rmdirSync(path.join(path.dirname(path.dirname(process.execPath)), "boston-pamyatka")); } catch (e) {} // только если пустая
}

// ───────────── Состояние для окна памятки ─────────────
function getState() {
  const u = accounts.current();
  return {
    cfg: {
      alwaysOnTop: cfg.alwaysOnTop, hotkeyEnabled: cfg.hotkeyEnabled, hotkey: cfg.hotkey,
      compact: cfg.compact, rememberBounds: cfg.rememberBounds, opacity: cfg.opacity,
      tray: cfg.tray, notify: cfg.notify, ghost: cfg.ghost, ghostOpacity: cfg.ghostOpacity,
      voiceEnabled: cfg.voiceEnabled, voiceHotkey: cfg.voiceHotkey, voiceOpacity: cfg.voiceOpacity, voiceMode: cfg.voiceMode,
      voiceHide: cfg.voiceHide, voiceSize: cfg.voiceSize, voiceFont: cfg.voiceFont, voicePtt: cfg.voicePtt, voiceMic: cfg.voiceMic,
      ghostBy: cfg.ghostBy, strip: cfg.strip, snap: cfg.snap, watchApps: cfg.watchApps.slice(), watchMode: cfg.watchMode, watchOpacity: cfg.watchOpacity, streamAuto: cfg.streamAuto,
      miniEnabled: cfg.miniEnabled, miniHotkey: cfg.miniHotkey, miniOpacity: cfg.miniOpacity, betaUpdates: cfg.betaUpdates,
      radioEnabled: cfg.radioEnabled, radioHotkey: cfg.radioHotkey, radioPin: cfg.radioPin, radioHide: cfg.radioHide, radioVoice: cfg.radioVoice,
      radioVoiceName: cfg.radioVoiceName, radioRate: cfg.radioRate, radioSfx: cfg.radioSfx, radioOnline: cfg.radioOnline, radioSize: cfg.radioSize
    },
    miniOpen: mini.isOpen(),
    radioOpen: radio.isOpen(),
    radioError: radio.hotkeyError(),
    miniError: mini.hotkeyError(),
    win: winx.state(),
    platform: process.platform,
    autostart: getAutostart(),
    sync: sync.status(),
    hotkeyError,
    packaged: app.isPackaged,
    version: app.getVersion(),
    dataVersion: currentVersion(),
    depts: accounts.DEPTS,
    servers: accounts.SERVERS,
    shareUrl: require("./server-config").API_URL,
    sys: accounts.sys(),
    user: u ? { login: u.login, nick: u.nick, static: u.static, discord: u.discord, telegram: u.telegram, phone: u.phone, role: u.role, roleName: u.roleName, org: u.org, server: u.server || accounts.DEFAULT_SERVER, serverName: u.serverName || "", staffServer: u.staffServer || 0, rank: u.rank, rankName: u.rankName, offline: !!u.offline } : null
  };
}
function pushState() {
  if (win && !win.isDestroyed()) win.webContents.send("senko:cfg", getState());
  pushWin();
}

function applySet(key, val) {
  const bools = ["alwaysOnTop", "hotkeyEnabled", "compact", "rememberBounds", "tray", "notify", "voiceEnabled", "ghost", "voicePtt", "miniEnabled", "betaUpdates", "radioEnabled", "radioPin", "radioVoice", "radioSfx", "radioOnline"];
  let result = { ok: true };
  if (key === "autostart") {
    if (!app.isPackaged) return { ok: false, error: "Автозапуск доступен только в установленной версии." };
    setAutostart(val);
  } else if (bools.includes(key)) {
    val = !!val;
    if (key !== "compact") cfg[key] = val; // compact переключает setCompact (ему нужны границы прежнего режима)
    if (key === "alwaysOnTop" || key === "ghost") applyWindowCfg();
    if (key === "compact") setCompact(val);
    if (key === "rememberBounds" && val) saveBoundsNow();
    if (key === "tray") {
      ensureTray();
      if (!val && win && !win.isDestroyed() && !win.isVisible()) showWindow();
    }
    if (key === "hotkeyEnabled") {
      result = registerHotkey();
      if (!result.ok) { cfg.hotkeyEnabled = false; registerHotkey(); }
    }
    if (key === "voiceEnabled") {
      result = voice.registerHotkey();
      if (!result.ok) { cfg.voiceEnabled = false; voice.registerHotkey(); }
      voice.applyOpts();
    }
    if (key === "voicePtt") voice.applyOpts();
    if (key === "miniEnabled") {
      result = mini.registerHotkey();
      if (!result.ok) { cfg.miniEnabled = false; mini.registerHotkey(); }
      if (!val) mini.toggle(false);
    }
    if (key === "radioEnabled") {
      result = radio.registerHotkey();
      if (!result.ok) { cfg.radioEnabled = false; radio.registerHotkey(); }
      if (!cfg.radioEnabled) radio.toggle(false);
    }
    if (key === "radioPin" || key === "radioVoice" || key === "radioSfx" || key === "radioOnline") radio.applyOpts();
    if (key === "betaUpdates") {
      if (updater) updater.allowPrerelease = val;
      if (val) setTimeout(() => checkForAppUpdate(false), 1500);
    }
  } else if (key === "mini") {
    mini.toggle(val === undefined || val === null ? undefined : !!val);
  } else if (key === "miniHotkey") {
    if (!validHotkey(val)) return { ok: false, error: "Нужно сочетание с Ctrl, Alt или Win и обычной клавишей." };
    if ((val === cfg.hotkey && cfg.hotkeyEnabled) || (val === cfg.voiceHotkey && cfg.voiceEnabled)) return { ok: false, error: "Это сочетание уже занято в программе." };
    const oldM = cfg.miniHotkey;
    cfg.miniHotkey = val;
    if (cfg.miniEnabled) {
      result = mini.registerHotkey();
      if (!result.ok) { cfg.miniHotkey = oldM; mini.registerHotkey(); }
    }
  } else if (key === "radio") {
    if (!cfg.radioEnabled) return { ok: false, error: "Рация выключена в настройках." };
    radio.toggle(val === undefined || val === null ? undefined : !!val);
  } else if (key === "radioHotkey") {
    if (!validHotkey(val)) return { ok: false, error: "Нужно сочетание с Ctrl, Alt или Win и обычной клавишей." };
    if ((val === cfg.hotkey && cfg.hotkeyEnabled) || (val === cfg.voiceHotkey && cfg.voiceEnabled) || (val === cfg.miniHotkey && cfg.miniEnabled)) return { ok: false, error: "Это сочетание уже занято в программе." };
    const oldR = cfg.radioHotkey;
    cfg.radioHotkey = val;
    if (cfg.radioEnabled) {
      result = radio.registerHotkey();
      if (!result.ok) { cfg.radioHotkey = oldR; radio.registerHotkey(); }
    }
    radio.applyOpts();
  } else if (key === "radioHide") {
    cfg.radioHide = Math.min(120, Math.max(5, Math.round(+val || DEFAULTS.radioHide)));
    radio.applyOpts();
  } else if (key === "radioRate") {
    cfg.radioRate = Math.min(180, Math.max(60, Math.round(+val || DEFAULTS.radioRate)));
    radio.applyOpts();
  } else if (key === "radioVoiceName") {
    cfg.radioVoiceName = typeof val === "string" ? val.slice(0, 200) : "";
    radio.applyOpts();
  } else if (key === "radioSize") {
    cfg.radioSize = ["s", "m", "l"].includes(val) ? val : "m";
    radio.applyOpts();
  } else if (key === "radioPosReset") {
    cfg.radioPos = null;
  } else if (key === "miniOpacity") {
    cfg.miniOpacity = Math.min(100, Math.max(30, Math.round(+val || DEFAULTS.miniOpacity)));
    mini.applyOpacity();
  } else if (key === "hotkey") {
    if (!validHotkey(val)) return { ok: false, error: "Нужно сочетание с Ctrl, Alt или Win и обычной клавишей." };
    const old = cfg.hotkey;
    cfg.hotkey = val;
    if (cfg.hotkeyEnabled) {
      result = registerHotkey();
      if (!result.ok) { cfg.hotkey = old; registerHotkey(); }
    }
  } else if (key === "voiceHotkey") {
    if (!validHotkey(val)) return { ok: false, error: "Нужно сочетание с Ctrl, Alt или Win и обычной клавишей." };
    if (val === cfg.hotkey && cfg.hotkeyEnabled) return { ok: false, error: "Это сочетание уже занято для показа окна." };
    const oldV = cfg.voiceHotkey;
    cfg.voiceHotkey = val;
    if (cfg.voiceEnabled) {
      result = voice.registerHotkey();
      if (!result.ok) { cfg.voiceHotkey = oldV; voice.registerHotkey(); }
    }
    voice.applyOpts();
  } else if (key === "voiceMode") {
    cfg.voiceMode = val === "ai" ? "ai" : "search";
    voice.applyOpts();
  } else if (key === "voiceOpacity") {
    cfg.voiceOpacity = Math.min(100, Math.max(30, Math.round(+val || DEFAULTS.voiceOpacity)));
    voice.applyOpts();
  } else if (key === "voiceHide") {
    cfg.voiceHide = Math.min(60, Math.max(3, Math.round(+val || DEFAULTS.voiceHide)));
    voice.applyOpts();
  } else if (key === "voiceSize") {
    cfg.voiceSize = ["s", "m", "l"].includes(val) ? val : "m";
    voice.applyOpts();
  } else if (key === "voiceFont") {
    cfg.voiceFont = Math.min(150, Math.max(80, Math.round(+val || DEFAULTS.voiceFont)));
    voice.applyOpts();
  } else if (key === "voiceMic") {
    cfg.voiceMic = typeof val === "string" && val.length <= 200 ? val : "";
    voice.applyOpts();
  } else if (key === "voicePosReset") {
    cfg.voicePos = null;
    voice.resetPos();
  } else if (key === "opacity") {
    cfg.opacity = Math.min(100, Math.max(30, Math.round(+val || 100)));
    applyWindowCfg();
  } else if (key === "ghostOpacity") {
    cfg.ghostOpacity = Math.min(90, Math.max(20, Math.round(+val || DEFAULTS.ghostOpacity)));
    applyWindowCfg();
  } else if (winx.keys.includes(key)) {
    result = winx.set(key, val);
    if (!result.ok) return result;
  } else {
    return { ok: false, error: "Неизвестная настройка." };
  }
  saveCfg();
  // ползунки прозрачности шлют значение на каждом шаге: окно меняется сразу, а меню трея и страница обновляются после паузы
  if (key === "opacity" || key === "ghostOpacity" || key === "voiceOpacity" || key === "watchOpacity" || key === "voiceHide" || key === "voiceFont" || key === "miniOpacity" || key === "radioRate" || key === "radioHide") {
    clearTimeout(slideTimer);
    slideTimer = setTimeout(() => { updateTrayMenu(); pushState(); }, 250);
    return result;
  }
  updateTrayMenu();
  pushState();
  return result;
}
let slideTimer = null;

// ───────────── О программе ─────────────
function releaseDate() {
  let d = null;
  const bi = readJson(path.join(__dirname, "build-info.json"));
  if (bi && bi.date) d = new Date(bi.date);
  if (!d || isNaN(d)) {
    try { d = fs.statSync(app.getAppPath()).mtime; } catch (e) {}
  }
  return d && !isNaN(d) ? d.toLocaleDateString("ru-RU", { day: "2-digit", month: "long", year: "numeric" }) : "—";
}

async function showAbout() {
  const u = accounts.current();
  const dv = currentVersion();
  const rows = [
    ["Версия программы", app.getVersion()],
    ["Данные памятки", dv],
    ["Дата выпуска", releaseDate()],
    ["Автор", "Hanami Senko | Senko Corporation"],
    ["Движок", `Electron ${process.versions.electron} · Chromium ${process.versions.chrome}`]
  ];
  if (u) rows.push(["Вы вошли как", `${u.login} (${u.nick})`]);
  const r = await box({
    type: "info",
    title: "О программе",
    message: "Senko Assistant",
    rows,
    buttons: ["Закрыть", "Проверить обновления", "Папка с данными"],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
    icon: nativeImage.createFromPath(iconPath())
  });
  if (r.response === 1) { checkForAppUpdate(true); checkForUpdate(true); }
  if (r.response === 2) shell.openPath(path.join(app.getPath("documents"), "Senko Assistant"));
}

// ───────────── IPC главного окна ─────────────
const fromMain = (e) => win && !win.isDestroyed() && e.sender === win.webContents;

ipcMain.on("senko:win-state", (e) => { e.returnValue = fromMain(e) ? winState() : null; });
ipcMain.on("senko:win", (e, action, val) => {
  if (!fromMain(e) || !win || win.isDestroyed()) return;
  switch (String(action)) {
    case "min": win.minimize(); break;
    case "max": if (win.isMaximized()) win.unmaximize(); else win.maximize(); break;
    case "close": win.close(); break; // с треем крестик прячет окно (обработчик close)
    case "hide": if (cfg.tray && tray) win.hide(); else win.minimize(); break;
    case "top": applySet("alwaysOnTop", !cfg.alwaysOnTop); break;
    case "compact": applySet("compact", !cfg.compact); break;
    case "ghost": applySet("ghost", !cfg.ghost); break;
    case "opacity": applySet("opacity", val); break;
    case "dock": dockWindow(val === "left" ? "left" : "right"); break;
    case "prof-save": winx.profSave(String(val)); updateTrayMenu(); break;
    case "prof-use": winx.profUse(String(val)); updateTrayMenu(); break;
    case "reload": win.webContents.reload(); break;
    case "about": showAbout(); break;
    case "update": checkForAppUpdate(true); checkForUpdate(true); break;
    case "staff": openStaff(); break;
    case "quit": quitting = true; app.quit(); break;
  }
});
ipcMain.on("senko:get", (e) => { e.returnValue = fromMain(e) ? getState() : null; });
ipcMain.on("senko:set", (e, key, val) => {
  e.returnValue = fromMain(e) ? { ...applySet(String(key), val), state: getState() } : { ok: false };
});
ipcMain.on("senko:session", (e) => {
  e.returnValue = fromMain(e) ? accounts.current() : null;
});
ipcMain.on("senko:seeded", (e) => { if (fromMain(e)) accounts.markSeeded(); });
ipcMain.on("senko:about", (e) => { if (fromMain(e)) showAbout(); });
ipcMain.on("senko:check-update", (e) => { if (fromMain(e)) { checkForAppUpdate(true); checkForUpdate(true); } });
ipcMain.on("senko:logout", (e) => { if (fromMain(e)) logout(); });
ipcMain.on("senko:staff", (e) => { if (fromMain(e)) openStaff(); });
// Панель руководителя в главном окне: тот же список, что и в окне «Сотрудники»
ipcMain.handle("senko:staff-list", async (e) => {
  if (!fromMain(e)) return { ok: false, error: "Недоступно." };
  const r = await accounts.staffList();
  if (r && (r.code === "auth" || r.code === "banned")) setTimeout(() => logout(r.error), 0);
  return r;
});
// Личный кабинет: изменение данных в аккаунте (сервер уведомляет владельца в Telegram)
ipcMain.handle("senko:profile-update", async (e, d) => {
  if (!fromMain(e)) return { ok: false, error: "Недоступно." };
  const srvBefore = parseInt((accounts.current() || {}).server, 10) || 12;
  const r = await accounts.updateProfile(d || {});
  if (r && (r.code === "auth" || r.code === "banned")) setTimeout(() => logout(r.error), 0);
  else if (r && r.ok) {
    updateTrayMenu(); pushState();
    // 2.9: сервер сменился — у него свои законы и таблицы кодексов: подгружаем их и перезагружаем окно
    if ((parseInt((accounts.current() || {}).server, 10) || 12) !== srvBefore) {
      laws.sync().catch(() => {}).then(() => { if (win && !win.isDestroyed()) win.loadFile(pickIndex().file); });
    }
  }
  return r;
});
// Копия текущих данных перед сбросом или загрузкой из файла: дневная копия за сегодня потом перезапишется
function safetyCopy(tag) {
  try {
    if (!fs.existsSync(mainFile())) return;
    fs.mkdirSync(backupDir(), { recursive: true });
    const day = new Date().toISOString().slice(0, 10);
    fs.copyFileSync(mainFile(), path.join(backupDir(), `senko-data-${day}-${tag}.json`));
  } catch (e) {}
}
// После сброса или загрузки из файла: забыть, что уже отправлено на сервер, и заново скачать данные аккаунта
async function syncRebase() {
  if (!sync.hasState()) return;
  sync.resetState();
  await Promise.race([sync.prefetch().catch(() => null), new Promise((res) => setTimeout(res, 4000))]);
}
// Перенос данных одним файлом: экспорт и импорт (заметки, избранное, папки, настройки, история)
ipcMain.handle("senko:export-data", async (e, text) => {
  if (!fromMain(e)) return { ok: false, error: "Недоступно." };
  const day = new Date().toISOString().slice(0, 10);
  const r = await dialog.showSaveDialog(win, {
    title: "Сохранить данные Senko Assistant",
    defaultPath: path.join(app.getPath("documents"), "Senko Assistant", `senko-export-${day}.json`),
    filters: [{ name: "Данные Senko Assistant", extensions: ["json"] }]
  });
  if (r.canceled || !r.filePath) return { ok: false, canceled: true };
  try {
    fs.mkdirSync(path.dirname(r.filePath), { recursive: true });
    fs.writeFileSync(r.filePath, String(text || ""), "utf8");
    return { ok: true, file: path.basename(r.filePath) };
  } catch (err) {
    return { ok: false, error: "Не удалось записать файл." };
  }
});
ipcMain.handle("senko:import-data", async (e) => {
  if (!fromMain(e)) return { ok: false, error: "Недоступно." };
  const r = await dialog.showOpenDialog(win, {
    title: "Загрузить данные Senko Assistant",
    defaultPath: path.join(app.getPath("documents"), "Senko Assistant"),
    filters: [{ name: "Данные Senko Assistant", extensions: ["json"] }],
    properties: ["openFile"]
  });
  if (r.canceled || !r.filePaths || !r.filePaths[0]) return { ok: false, canceled: true };
  try {
    const st = fs.statSync(r.filePaths[0]);
    if (st.size > 20 * 1024 * 1024) return { ok: false, error: "Файл слишком большой." };
    safetyCopy("before-import");
    return { ok: true, text: fs.readFileSync(r.filePaths[0], "utf8").replace(/^\uFEFF/, "") };
  } catch (err) {
    return { ok: false, error: "Не удалось прочитать файл." };
  }
});
// Карточки задержанных (2.5): отдельный файл detainees.json в папке данных, не синхронизируется
const detsFile = () => path.join(app.getPath("userData"), "detainees.json");
ipcMain.on("senko:dets-load", (e) => {
  if (!fromMain(e)) { e.returnValue = null; return; }
  const j = readJson(detsFile());
  e.returnValue = j && Array.isArray(j.list) ? j.list : [];
});
ipcMain.on("senko:dets-save", (e, list) => {
  if (!fromMain(e) || !Array.isArray(list)) return;
  try {
    const text = JSON.stringify({ app: "Senko Assistant", savedAt: new Date().toISOString(), list: list.slice(0, 3000) });
    if (text.length > 8 * 1024 * 1024) return;
    writeAtomic(detsFile(), text);
  } catch (err) {}
});
ipcMain.on("senko:dets-open", (e) => {
  if (!fromMain(e)) return;
  if (fs.existsSync(detsFile())) shell.showItemInFolder(detsFile());
  else shell.openPath(app.getPath("userData"));
});
// Правка данных статей (срок, розыск, штраф): только на этом компьютере, отдельный файл в папке данных
const artEditsFile = () => path.join(app.getPath("userData"), "article-edits.json");
ipcMain.on("senko:artedit-load", (e) => {
  if (!fromMain(e)) { e.returnValue = null; return; }
  const j = readJson(artEditsFile());
  e.returnValue = j && j.edits && typeof j.edits === "object" && !Array.isArray(j.edits) ? j.edits : {};
});
ipcMain.on("senko:artedit-save", (e, edits) => {
  if (!fromMain(e) || !edits || typeof edits !== "object" || Array.isArray(edits)) return;
  try {
    const text = JSON.stringify({ app: "Senko Assistant", savedAt: new Date().toISOString(), edits }, null, 1);
    if (text.length > 2 * 1024 * 1024) return;
    writeAtomic(artEditsFile(), text);
  } catch (err) {}
});
ipcMain.on("senko:artedit-open", (e) => {
  if (!fromMain(e)) return;
  if (fs.existsSync(artEditsFile())) shell.showItemInFolder(artEditsFile());
  else shell.openPath(app.getPath("userData"));
});
// Ежедневные копии данных: список и заметки из выбранной копии (откат заметок)
const BK_RE = /^senko-data-(\d{4}-\d{2}-\d{2})(-[\w-]+)?\.json$/;
ipcMain.on("senko:bk-list", (e) => {
  if (!fromMain(e)) { e.returnValue = []; return; }
  try {
    e.returnValue = fs.readdirSync(backupDir()).filter((f) => BK_RE.test(f)).sort().reverse().slice(0, 30).map((f) => {
      let at = 0;
      try { at = fs.statSync(path.join(backupDir(), f)).mtimeMs; } catch (err) {}
      return { name: f, day: BK_RE.exec(f)[1], tag: (BK_RE.exec(f)[2] || "").slice(1), at };
    });
  } catch (err) { e.returnValue = []; }
});
ipcMain.on("senko:bk-key", (e, name, key) => {
  if (!fromMain(e) || !BK_RE.test(String(name)) || !/^bos-[\w-]{1,40}$/.test(String(key))) { e.returnValue = null; return; }
  const j = readJson(path.join(backupDir(), String(name)));
  const v = j && j.data && j.data[key];
  e.returnValue = typeof v === "string" ? v : null;
});
ipcMain.on("senko:open-backups", (e) => { if (fromMain(e)) { fs.mkdirSync(backupDir(), { recursive: true }); shell.openPath(backupDir()); } });
// Сброс всех данных: автосохранение очищается (дневные копии остаются), по желанию — данные в аккаунте
ipcMain.handle("senko:reset-data", async (e, d) => {
  if (!fromMain(e)) return { ok: false, error: "Недоступно." };
  safetyCopy("before-reset");
  if (d && d.account) {
    const r = await accounts.act("sync_reset", {});
    if (!r || !r.ok) {
      if (r && (r.code === "auth" || r.code === "banned")) setTimeout(() => logout(r.error), 0);
      return r || { ok: false, error: "Не удалось очистить данные в аккаунте." };
    }
  }
  try {
    writeAtomic(mainFile(), JSON.stringify({ app: "Senko Assistant", version: currentVersion(), savedAt: new Date().toISOString(), data: {} }, null, 2));
  } catch (err) {}
  // карточки задержанных: копия уходит к резервным, сам файл очищается
  try {
    if (fs.existsSync(detsFile())) {
      fs.mkdirSync(backupDir(), { recursive: true });
      fs.copyFileSync(detsFile(), path.join(backupDir(), `detainees-${new Date().toISOString().slice(0, 10)}-before-reset.json`));
      fs.rmSync(detsFile(), { force: true });
    }
    if (fs.existsSync(artEditsFile())) {
      fs.mkdirSync(backupDir(), { recursive: true });
      fs.copyFileSync(artEditsFile(), path.join(backupDir(), `article-edits-${new Date().toISOString().slice(0, 10)}-before-reset.json`));
      fs.rmSync(artEditsFile(), { force: true });
    }
  } catch (err) {}
  await syncRebase(); // без галочки данные аккаунта вернутся на этот компьютер при перезагрузке страницы
  return { ok: true };
});
ipcMain.handle("senko:sync-rebase", async (e) => {
  if (!fromMain(e)) return { ok: false };
  await syncRebase();
  return { ok: true };
});

// Прогресс, рейтинг недели, смены и контрольные тесты (этап 4): только перечисленные действия сервера
const PAGE_ACTIONS = ["my_stats", "week_board", "shift", "ctrl", "reports", "share", "xfer", "misses", "contacts", "logins", "change_password", "verify_password", "ads",
  "status", "beta", "hooks", "discord_link", "srv_cfg", "events", "ideas", "patrol", // 2.4
  "ai_dict", "ai_hist", "ai_check", "colleagues", "handoff", "svc"]; // 2.7, 2.8: коллеги, передача задержанного; 3.2: служебные сообщения
// 2.3: список микрофонов и проверка уровня для настроек (микрофон доступен только окну оверлея)
ipcMain.handle("senko:voice-mics", async (e) => (fromMain(e) ? voice.mics() : { ok: false, error: "Недоступно." }));
ipcMain.handle("senko:voice-test", async (e, on) => (fromMain(e) ? voice.test(!!on) : { ok: false, error: "Недоступно." }));
ipcMain.handle("senko:api", async (e, action, data) => {
  if (!fromMain(e) || !PAGE_ACTIONS.includes(String(action))) return { ok: false, error: "Недоступно." };
  const r = await accounts.act(String(action), data && typeof data === "object" ? data : {});
  if (r && (r.code === "auth" || r.code === "banned")) setTimeout(() => logout(r.error), 0);
  return r;
});
// Сообщение об ошибке (уходит владельцу в Telegram) и ручная сверка с сервером (кнопка «Проверить снова»)
ipcMain.handle("senko:bug", async (e, text, log, shot) => (fromMain(e) ? accounts.bugReport(text, log, shot) : { ok: false, error: "Недоступно." }));
// 2.4: снимок окна программы для сообщения об ошибке (JPEG, не больше 1280 px по ширине)
ipcMain.handle("senko:shot", async (e) => {
  if (!fromMain(e) || !win || win.isDestroyed()) return null;
  try {
    let img = await win.webContents.capturePage();
    const sz = img.getSize();
    if (sz.width > 1280) img = img.resize({ width: 1280, quality: "good" });
    let q = 75, buf = img.toJPEG(q);
    while (buf.length > 480000 && q > 35) { q -= 15; buf = img.toJPEG(q); }
    return "data:image/jpeg;base64," + buf.toString("base64");
  } catch (err) {
    return null;
  }
});
ipcMain.handle("senko:recheck", async (e) => {
  if (!fromMain(e)) return null;
  await verifySession();
  pushState();
  return getState();
});
// Перезапуск программы (например, после смены организации): сначала отправляем несохранённые изменения
ipcMain.on("senko:restart", (e) => {
  if (!fromMain(e)) return;
  quitting = true;
  const go = () => { app.relaunch(); app.quit(); };
  Promise.race([sync.pushNow().catch(() => {}), new Promise((r) => setTimeout(r, 3000))]).then(go, go);
});
ipcMain.on("senko:copy", (e, text) => { if (fromMain(e)) clipboard.writeText(String(text).slice(0, 200)); });

// ───────────── 2.2: ярлыки, откат данных, экран «Состояние», журнал для сообщения об ошибке ─────────────
ipcMain.on("senko:open-arg", (e) => { e.returnValue = fromMain(e) ? pendingOpen : ""; if (fromMain(e)) pendingOpen = ""; });
ipcMain.handle("senko:shortcut", (e, d) => {
  if (!fromMain(e)) return { ok: false, error: "Недоступно." };
  const target = String((d && d.target) || "");
  if (!OPEN_RE.test(target)) return { ok: false, error: "Неверная цель ярлыка." };
  if (process.platform !== "win32") return { ok: false, error: "Ярлыки создаются только в Windows." };
  const name = String((d && d.name) || "Senko Assistant").replace(/[\\/:*?"<>|]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 60) || "Senko Assistant";
  const file = path.join(app.getPath("desktop"), name + ".lnk");
  const ok = shell.writeShortcutLink(file, fs.existsSync(file) ? "replace" : "create", {
    target: process.execPath, args: `--open=${target}`, icon: process.execPath, iconIndex: 0, description: "Senko Assistant: " + name, appUserModelId: "local.boston.pamyatka"
  });
  return ok ? { ok: true, file } : { ok: false, error: "Windows не дала создать ярлык." };
});
function memoVersions() {
  const cur = pickIndex(), m = readJson(updMeta()), pm = readJson(updPrevMeta());
  return {
    current: cur.version, bundled: app.getVersion(), usingDownloaded: cur.file === updIndex(),
    downloaded: m && fs.existsSync(updIndex()) ? { version: m.version, at: m.at } : null,
    prev: pm && fs.existsSync(updPrev()) ? { version: pm.version, at: pm.at } : null,
    hold: !!holdGet().memo
  };
}
// 2.2: размер данных и дата последнего автосохранения (для настроек)
function fileSize(f) { try { return fs.statSync(f).size; } catch (e) { return 0; } }
ipcMain.handle("senko:save-info", (e) => {
  if (!fromMain(e)) return null;
  let savedAt = 0, backups = 0, backupsSize = 0;
  try { savedAt = fs.statSync(mainFile()).mtimeMs; } catch (err) {}
  try { fs.readdirSync(backupDir()).filter((f) => f.endsWith(".json")).forEach((f) => { backups++; backupsSize += fileSize(path.join(backupDir(), f)); }); } catch (err) {}
  const ud = app.getPath("userData");
  return {
    savedAt, size: fileSize(mainFile()), backups, backupsSize,
    laws: (() => { let n = 0; try { fs.readdirSync(ud).forEach((f) => { if (/^laws(-\d+)?\.json$/.test(f)) n += fileSize(path.join(ud, f)); else if (/^laws-history(-\d+)?$/.test(f)) fs.readdirSync(path.join(ud, f)).forEach((h) => { n += fileSize(path.join(ud, f, h)); }); }); } catch (err) {} return n; })(),
    extra: fileSize(path.join(ud, "detainees.json")) + fileSize(path.join(ud, "article-edits.json")),
    folder: saveDir().split(require("os").homedir()).join("~")
  };
});
ipcMain.handle("senko:data-versions", (e) => (fromMain(e) ? { memo: memoVersions(), laws: laws.versions() } : null));
ipcMain.handle("senko:data-rollback", (e, d) => {
  if (!fromMain(e)) return { ok: false, error: "Недоступно." };
  const kind = d && d.kind, id = String((d && d.id) || "");
  try {
    if (kind === "laws") {
      const r = laws.restore(id);
      if (!r.ok) return r;
    } else if (kind === "memo") {
      if (id === "prev") {
        if (!fs.existsSync(updPrev()) || !fs.existsSync(updPrevMeta())) return { ok: false, error: "Прошлой версии данных нет." };
        fs.copyFileSync(updPrev(), updIndex()); fs.copyFileSync(updPrevMeta(), updMeta());
        fs.rmSync(updPrev(), { force: true }); fs.rmSync(updPrevMeta(), { force: true });
      } else if (id === "bundled") {
        if (fs.existsSync(updIndex())) { fs.copyFileSync(updIndex(), updPrev()); if (fs.existsSync(updMeta())) fs.copyFileSync(updMeta(), updPrevMeta()); }
        fs.rmSync(updIndex(), { force: true }); fs.rmSync(updMeta(), { force: true });
      } else return { ok: false, error: "Неизвестная версия." };
      holdSet("memo", Date.now());
    } else return { ok: false, error: "Неизвестный вид данных." };
    updLog("info", "data rollback:", kind, id);
    setTimeout(() => { if (win && !win.isDestroyed()) win.loadFile(pickIndex().file); }, 300);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: "Откат не удался: " + ((err && err.message) || err) };
  }
});
ipcMain.handle("senko:data-resume", (e, d) => {
  if (!fromMain(e)) return { ok: false };
  const kind = d && d.kind;
  if (kind === "memo") { holdSet("memo", 0); checkForUpdate(true); }
  else if (kind === "laws") laws.resume();
  return { ok: true };
});
function tailFile(f, n) {
  try { const t = fs.readFileSync(f, "utf8"); return t.split("\n").slice(-n).join("\n"); } catch (e) { return ""; }
}
async function diagInfo() {
  const v = voice.status ? voice.status() : {};
  let lawsDiag = "";
  try { lawsDiag = await laws.diagnose(); } catch (e) {}
  return {
    versions: { app: app.getVersion(), data: currentVersion(), electron: process.versions.electron, chrome: process.versions.chrome, node: process.versions.node },
    os: `${process.platform} ${require("os").release()} ${process.arch}`,
    packaged: app.isPackaged,
    userData: app.getPath("userData"),
    voice: v,
    hotkey: { enabled: cfg.hotkeyEnabled, key: cfg.hotkey, error: hotkeyError || "" },
    updater: { state: upd.state, version: upd.version, percent: upd.percent, lastError: upd.lastError || null, module: !!updater },
    memo: memoVersions(),
    laws: lawsDiag,
    sync: sync.status()
  };
}
ipcMain.handle("senko:diag", async (e) => (fromMain(e) ? diagInfo() : null));
// журнал для «Сообщить об ошибке»: версии, состояние и хвост updater.log (без токенов и паролей)
ipcMain.handle("senko:diag-log", async (e) => {
  if (!fromMain(e)) return "";
  const d = await diagInfo();
  const L = [
    "Senko Assistant " + d.versions.app + " (данные " + d.versions.data + "), Electron " + d.versions.electron + ", " + d.os,
    "Установлена: " + (d.packaged ? "да" : "нет (разработка)"),
    "Горячая клавиша окна: " + (d.hotkey.enabled ? d.hotkey.key : "выключена") + (d.hotkey.error ? " (ошибка: " + d.hotkey.error + ")" : ""),
    "Голос: " + JSON.stringify(d.voice),
    "Обновления программы: " + JSON.stringify(d.updater),
    "Данные памятки: " + JSON.stringify(d.memo),
    "Синхронизация: " + JSON.stringify(d.sync),
    "", "— Законы —", d.laws, "", "— updater.log (последние строки) —", tailFile(updLogFile(), 80)
  ];
  // папка пользователя Windows содержит его имя: в журнал она уходит как «~»
  const home = require("os").homedir();
  return L.join("\n").split(home).join("~").replace(/[0-9a-f]{64}/gi, "[скрыто]").slice(0, 60000);
});

// Синхронизация данных: слияние при запуске страницы, отправка изменений, ручной запуск
ipcMain.on("sync:startup", (e, local) => { e.returnValue = fromMain(e) ? sync.startup(local || {}) : null; });
ipcMain.on("sync:local", (e, map) => { if (fromMain(e)) sync.noteLocal(map); });
ipcMain.handle("senko:sync", async (e) => {
  if (!fromMain(e)) return { ok: false };
  await sync.pushNow();
  const r = await sync.prefetch();
  if (r && r.items.length && win && !win.isDestroyed()) {
    win.webContents.reload(); // страница перечитает слитые данные
    return { ok: true, changed: true };
  }
  pushState();
  const st = sync.status();
  return { ok: !!r, changed: false, error: r ? "" : st.offline ? "Нет связи с сервером." : st.error || "Не удалось синхронизировать." };
});

// ───────────── Законы с форума (сервер парсит форум раз в сутки в 00:05 МСК, приложение сверяет версию каждые 3 часа) ─────────────
const laws = require("./laws-sync")({
  dataDir: () => app.getPath("userData"),
  // 2.9: законы берутся для сервера вошедшего игрока (Boston, если не вошёл или старый профиль)
  server: () => { const u = accounts.current(); return (u && parseInt(u.server, 10)) || 12; },
  // тексты законов отдаёт сервер (расшифровка там, ключа в программе нет)
  api: (b) => accounts.authed(b, 90000),
  onProgress: (p) => {
    if (win && !win.isDestroyed()) win.webContents.send("laws:event", { type: "progress", progress: p });
  },
  onUpdate: (info) => {
    if (win && !win.isDestroyed()) win.webContents.send("laws:event", { type: "done", info });
    if (info && info.notify && cfg.notify && Notification.isSupported()) {
      const n = new Notification({
        title: "Законодательство обновлено",
        body: `Изменений: ${info.changes.length}. Откройте раздел «Законы» — изменённые статьи помечены.`,
        icon: nativeImage.createFromPath(iconPath())
      });
      n.on("click", showWindow);
      n.show();
    }
  }
});
ipcMain.handle("laws:get", (e) => (fromMain(e) ? laws.get() : null));
// Синхронное чтение сохранённых законов при старте окна: из них собираются актуальные УК/АК/ДК/ПК
ipcMain.on("laws:get-sync", (e) => { e.returnValue = fromMain(e) ? laws.peek() : null; });
ipcMain.handle("laws:sync", (e) => (fromMain(e) ? laws.sync() : null));
ipcMain.handle("laws:diag", (e) => (fromMain(e) ? laws.diagnose() : ""));
ipcMain.handle("laws:login", (e) => (fromMain(e) ? laws.login() : { ok: false }));
ipcMain.handle("laws:logout", (e) => (fromMain(e) ? laws.logout() : null));
ipcMain.on("laws:debug", (e) => {
  if (!fromMain(e)) return;
  const f = fs.existsSync(laws.debugPath()) ? laws.debugPath() : laws.dataPath();
  if (fs.existsSync(f)) shell.showItemInFolder(f); else shell.openPath(app.getPath("userData"));
});

// Системное уведомление (сигнал таймера) — работает и при скрытом/свёрнутом окне
ipcMain.on("senko:notify", (e, title, body) => {
  if (!fromMain(e) || !cfg.notify || !Notification.isSupported()) return;
  if (win.isVisible() && !win.isMinimized() && win.isFocused()) return; // окно и так перед глазами
  const n = new Notification({
    title: String(title).slice(0, 80) || "Senko Assistant",
    body: String(body).slice(0, 250),
    icon: nativeImage.createFromPath(iconPath())
  });
  n.on("click", showWindow);
  n.show();
});

// ───────────── Окно авторизации ─────────────
const fromAuth = (e) => authWin && !authWin.isDestroyed() && e.sender === authWin.webContents;

ipcMain.handle("auth:state", (e) =>
  fromAuth(e)
    ? {
        lastLogin: accounts.lastLogin(),
        depts: accounts.DEPTS,
        servers: accounts.SERVERS,
        defaultServer: accounts.DEFAULT_SERVER,
        roles: accounts.ROLES,
        gov: accounts.GOV_ORG,
        version: app.getVersion(),
        notice: accounts.takeNotice()
      }
    : null
);
ipcMain.handle("auth:login", async (e, d) => {
  if (!fromAuth(e)) return { ok: false, error: "Недоступно." };
  const r = await accounts.login(d || {});
  if (r.ok && !r.needLegal) setTimeout(enterApp, 0); // при needLegal окно сначала просит принять документы
  return r;
});
ipcMain.handle("auth:register", async (e, d) => {
  if (!fromAuth(e)) return { ok: false, error: "Недоступно." };
  // Программа откроется после auth:enter, когда пользователь подтвердит, что сохранил код восстановления
  return accounts.register(d || {});
});
ipcMain.on("auth:enter", (e) => {
  if (!fromAuth(e) || !accounts.current()) return;
  accounts.commit();
  enterApp();
});
ipcMain.handle("auth:accept-legal", (e, version) => (fromAuth(e) ? accounts.acceptLegal(version) : { ok: false }));
ipcMain.handle("auth:reset-request", (e, d) => (fromAuth(e) ? accounts.resetRequest(d || {}) : { ok: false }));
ipcMain.handle("auth:reset-status", (e, d) => (fromAuth(e) ? accounts.resetStatus(d || {}) : { ok: false }));
ipcMain.handle("auth:reset-complete", (e, d) => (fromAuth(e) ? accounts.resetComplete(d || {}) : { ok: false }));
ipcMain.on("auth:copy", (e, text) => { if (fromAuth(e)) clipboard.writeText(String(text).slice(0, 200)); });
ipcMain.handle("auth:save-code", async (e, login, code) => {
  if (!fromAuth(e)) return { ok: false };
  const safe = String(login).replace(/[^\w.-]/g, "_").slice(0, 24) || "user";
  const r = await dialog.showSaveDialog(authWin, {
    title: "Сохранить код восстановления",
    defaultPath: path.join(app.getPath("documents"), `senko-recovery-${safe}.txt`),
    filters: [{ name: "Текст", extensions: ["txt"] }]
  });
  if (r.canceled || !r.filePath) return { ok: false };
  try {
    fs.writeFileSync(
      r.filePath,
      `Senko Assistant\nЛогин: ${login}\nКод восстановления пароля: ${code}\n\nХраните файл в надёжном месте. Код нужен, если вы забудете пароль.\n`,
      "utf8"
    );
    return { ok: true };
  } catch (err) {
    return { ok: false };
  }
});
ipcMain.on("auth:quit", (e) => { if (fromAuth(e)) { quitting = true; app.quit(); } });
ipcMain.on("auth:win", (e, a) => {
  if (!fromAuth(e)) return;
  if (a === "min") authWin.minimize();
  else if (a === "close") authWin.close();
});

function createAuthWindow() {
  Menu.setApplicationMenu(null);
  authWin = new BrowserWindow({
    width: 460,
    height: 780,
    minWidth: 400,
    minHeight: 640,
    title: "Senko Assistant — вход",
    autoHideMenuBar: true,
    frame: false, // своя строка окна рисуется в auth.html
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#0A0A0B" : "#F6F3EE",
    icon: iconPath(),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      preload: path.join(__dirname, "auth-preload.js")
    }
  });
  authWin.loadFile(path.join(__dirname, "app", "auth.html"));
  authWin.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  authWin.webContents.on("will-navigate", (e) => e.preventDefault());
  const w = authWin;
  authWin.on("closed", () => {
    if (authWin === w) authWin = null;
    if (!win && !quitting) app.quit(); // закрыли окно входа, не войдя
  });
}

function enterApp() {
  createMainWindow();
  if (authWin && !authWin.isDestroyed()) authWin.close();
}

// ───────────── Список сотрудников (руководство, модераторы, владелец) ─────────────
const fromStaff = (e) => staffWin && !staffWin.isDestroyed() && e.sender === staffWin.webContents;
ipcMain.handle("staff:list", async (e) => {
  if (!fromStaff(e)) return { ok: false, error: "Недоступно." };
  const r = await accounts.staffList();
  if (r && (r.code === "auth" || r.code === "banned")) setTimeout(() => logout(r.error), 0);
  return r;
});
ipcMain.on("staff:copy", (e, text) => { if (fromStaff(e)) clipboard.writeText(String(text).slice(0, 200)); });

function openStaff() {
  if (!accounts.isStaff()) return;
  if (staffWin && !staffWin.isDestroyed()) {
    if (staffWin.isMinimized()) staffWin.restore();
    staffWin.show();
    staffWin.focus();
    return;
  }
  const w = new BrowserWindow({
    width: 980,
    height: 640,
    minWidth: 640,
    minHeight: 420,
    title: "Senko Assistant — сотрудники",
    autoHideMenuBar: true,
    backgroundColor: "#EDF0F3",
    icon: iconPath(),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      preload: path.join(__dirname, "staff-preload.js")
    }
  });
  staffWin = w;
  w.setMenuBarVisibility(false);
  w.loadFile(path.join(__dirname, "app", "staff.html"));
  w.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  w.webContents.on("will-navigate", (ev) => ev.preventDefault());
  w.on("closed", () => { if (staffWin === w) staffWin = null; });
}

// Периодическая сверка с сервером: блокировка, смена прав, обновление профиля
async function verifySession() {
  if (!accounts.current()) return;
  const r = await accounts.verify();
  if (!r.ok) { logout(r.error); return; }
  if (r.changed) {
    if (!accounts.isStaff() && staffWin && !staffWin.isDestroyed()) staffWin.destroy();
    updateTrayMenu();
    pushState();
  }
}

function logout(reason) {
  sync.pushNow().catch(() => {}); // токен захватывается до выхода, последние изменения уходят на сервер
  accounts.logout();
  if (reason) accounts.setNotice(reason);
  if (staffWin && !staffWin.isDestroyed()) staffWin.destroy();
  tearDownSystem();
  const old = win;
  win = null;
  createAuthWindow();
  if (old && !old.isDestroyed()) old.destroy();
}

// ───────────── Главное окно ─────────────
function initSystem() {
  ensureTray();
  registerHotkey();
  voice.registerHotkey();
  mini.registerHotkey();
  radio.registerHotkey();
  applyWindowCfg();
  updateTrayMenu();
}
function tearDownSystem() {
  if (tray) { tray.destroy(); tray = null; }
  trayMenu.destroy();
  try { globalShortcut.unregisterAll(); } catch (e) {}
  hotkeyActive = null;
  voice.destroy();
  mini.destroy();
  radio.destroy();
  mini.registerHotkey(); // сбросить запомненную клавишу (все уже сняты выше); снова включится в initSystem

}

function createMainWindow() {
  Menu.setApplicationMenu(null);
  // законы получаются только после входа: сверяемся сразу, как открылось окно памятки
  setTimeout(() => laws.sync(), 3000);
  const saved = cfg.rememberBounds ? visibleBounds(cfg[boundsKey()]) : null;
  const w = new BrowserWindow({
    width: cfg.compact ? COMPACT_W : 560,
    height: 900,
    ...(saved || {}),
    minWidth: cfg.compact ? 300 : 380,
    minHeight: cfg.compact ? 400 : 600,
    show: false,
    title: "Senko Assistant",
    frame: false, // системную серую рамку заменяет своя строка заголовка (её рисует preload.js)
    autoHideMenuBar: true,
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#0A0A0B" : "#F6F3EE",
    icon: iconPath(),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      backgroundThrottling: false, // таймер должен идти и при скрытом окне
      preload: path.join(__dirname, "preload.js")
    }
  });
  win = w;

  w.once("ready-to-show", () => {
    if (startHidden && cfg.tray) { startHidden = false; return; } // запуск из автозагрузки — сразу в трей
    startHidden = false;
    if (cfg.rememberBounds && cfg.maximized && !cfg.compact) w.maximize();
    w.show();
  });

  // Перед показом страницы скачиваем общие данные аккаунта (не дольше 4 секунд),
  // чтобы страница сразу стартовала с ними; без сети работаем с локальными.
  const u0 = accounts.current();
  const loadPage = () => { if (!w.isDestroyed()) w.loadFile(pickIndex().file); };
  if (u0) {
    sync.begin(u0.login);
    Promise.race([sync.prefetch().catch(() => null), new Promise((res) => setTimeout(res, 4000))]).then(loadPage, loadPage);
  } else {
    loadPage();
  }
  initSystem();

  w.on("resize", saveBoundsSoon);
  w.on("move", saveBoundsSoon);
  w.on("maximize", () => { saveBoundsSoon(); pushWin(); });
  w.on("unmaximize", () => { saveBoundsSoon(); pushWin(); });
  w.on("focus", () => { if (cfg.ghost) applyWindowCfg(); pushWin(); });
  w.on("blur", () => { if (cfg.ghost) applyWindowCfg(); pushWin(); });
  w.on("always-on-top-changed", pushWin);
  winx.start();
  // правый клик по строке заголовка: вместо серого системного меню — своё
  w.on("system-context-menu", (e, point) => {
    e.preventDefault();
    if (w.isDestroyed()) return;
    const cb = w.getContentBounds();
    w.webContents.send("senko:winmenu", point ? { x: point.x - cb.x, y: point.y - cb.y } : null);
  });
  w.on("close", (e) => {
    winx.unstrip();
    saveBoundsNow();
    saveCfgNow();
    if (cfg.tray && tray && !quitting) { // «работает в фоне»: крестик прячет окно в трей
      e.preventDefault();
      w.hide();
    }
  });
  w.on("closed", () => { if (win === w) win = null; });

  // Внешние ссылки открываем в браузере, а не внутри приложения
  w.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });
  w.webContents.on("will-navigate", (e, url) => {
    if (/^https?:/i.test(url)) {
      e.preventDefault();
      shell.openExternal(url);
    }
  });
}

app.on("second-instance", (_e, argv) => {
  const o = openArg(argv);
  if (o && win && !win.isDestroyed()) win.webContents.send("senko:open", o);
  else if (o) pendingOpen = o;
  if (win && !win.isDestroyed()) showWindow();
  else if (authWin && !authWin.isDestroyed()) {
    if (authWin.isMinimized()) authWin.restore();
    authWin.focus();
  }
});

app.on("before-quit", () => { quitting = true; winx.stop(); sync.pushNow().catch(() => {}); });
app.on("will-quit", () => { try { globalShortcut.unregisterAll(); } catch (e) {} });
app.on("window-all-closed", () => app.quit());

app.whenReady().then(() => {
  if (!gotLock) return;
  loadCfg();
  setTimeout(() => { refreshAutostart(); removeOldFolders(); }, 8000);
  voice.init({
    getWin: () => (win && !win.isDestroyed() ? win : null),
    getCfg: () => cfg,
    isPackaged: app.isPackaged,
    applySet,  // оверлей переключает настройки через общий обработчик (трей и окно памятки обновятся сами)
    saveCfg,   // сохранить конфиг (позиция оверлея)
    askAi: ai.ask,               // вопрос ИИ из оверлея
    // 2.3: клик по карточке или команда «открой…» — показать окно памятки на нужной статье или вкладке
    openTarget: (t) => {
      if (!win || win.isDestroyed()) return;
      showWindow();
      if (typeof t === "string" && (OPEN_RE.test(t) || /^law:[\w-]{1,40}(?::[\w.\-]{1,60})?$/.test(t))) win.webContents.send("senko:open", t);
    },
    showMain: () => { if (win && !win.isDestroyed()) showWindow(); },
    sendMain: (ch, data) => { if (win && !win.isDestroyed()) win.webContents.send(ch, data); },
    aiAvailable: ai.configured,  // подключён ли ИИ-сервис (иначе переключатель режима неактивен)
    micOk: (wc) => radio.isWc(wc) // 2.6: микрофон и окну рации
  });
  trayMenu.init({ state: trayState, act: trayAct });
  dialogs.init();
  mini.init({
    getCfg: () => cfg,
    saveCfg,
    changed: () => { updateTrayMenu(); pushState(); },
    fromMain,
    openTarget: (t) => {
      if (!win || win.isDestroyed()) return;
      showWindow();
      if (OPEN_RE.test(t)) win.webContents.send("senko:open", t);
    },
    padCheck: (i) => { // 2.8: блокнот в мини-окне: галочка или -1 — открыть блокнот
      if (!win || win.isDestroyed()) return;
      if (i < 0) showWindow();
      win.webContents.send("senko:pad-check", i);
    }
  });
  radio.init({
    getWin: () => (win && !win.isDestroyed() ? win : null),
    getCfg: () => cfg,
    saveCfg,
    changed: () => { updateTrayMenu(); pushState(); },
    fromMain,
    stt: (d) => accounts.act("stt", d, 22000),
    openTarget: (t) => {
      if (!win || win.isDestroyed()) return;
      showWindow();
      if (OPEN_RE.test(t)) win.webContents.send("senko:open", t);
    }
  });
  ai.init({
    getWin: () => (win && !win.isDestroyed() ? win : null),
    // вопрос уходит на сервер: он обращается к ИИ, сохраняет вопрос в аккаунте и возвращает номер записи для 👍/👎 (см. Политику, раздел 6)
    ask: (d, ms) => accounts.act("ai_ask", d, ms),
    vote: (id, v) => accounts.act("ai_vote", { id, vote: v })
  });
  initUpdater();
  laws.start();

  // запомненный вход проверяется на сервере (без связи — по сохранённому профилю)
  accounts.restore().then((u) => { if (u) createMainWindow(); else createAuthWindow(); }, () => createAuthWindow());
  setTimeout(verifySession, 20000);
  setInterval(verifySession, 20 * 60 * 1000);
  // Вернулись в окно программы: сверяемся с сервером (не чаще раза в 2 минуты), чтобы смена организации или прав была видна сразу
  let lastFocusCheck = 0;
  app.on("browser-window-focus", (_e, w) => {
    if (!win || w !== win || Date.now() - lastFocusCheck < 120000) return;
    lastFocusCheck = Date.now();
    verifySession();
  });

  setTimeout(() => { checkForUpdate(); checkForAppUpdate(false); }, 5000);
  setInterval(() => { checkForUpdate(); checkForAppUpdate(false); }, UPDATE_EVERY_MS);
});
