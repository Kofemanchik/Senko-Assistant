const {
  app, BrowserWindow, shell, Menu, ipcMain, dialog, net, Tray, Notification,
  globalShortcut, screen, nativeImage
} = require("electron");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const voice = require("./voice"); // голосовой ввод и оверлей

// ───────────── НАСТРОЙКИ ─────────────
// Папка в репозитории GitHub, где лежат version.json и index.html для обновления данных памятки.
const UPDATE_BASE = "https://raw.githubusercontent.com/Kofemanchik/Senko-Assistant/main/update/";
const UPDATE_EVERY_MS = 3 * 60 * 60 * 1000; // повторная проверка раз в 3 часа
const KEEP_BACKUPS = 14;                    // сколько дневных копий хранить
const COMPACT_W = 360;                      // ширина «узкого» окна
// ──────────────────────────────────────

app.setAppUserModelId("local.boston.pamyatka"); // нужен для системных уведомлений Windows

// Имя программы теперь «Senko Assistant», но папку данных оставляем прежней («Boston»),
// чтобы у тех, кто уже пользовался приложением, не пропали заметки и настройки.
app.setPath("userData", path.join(app.getPath("appData"), "Boston"));

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.quit();

let win = null;       // главное окно (памятка)
let authWin = null;   // окно авторизации
let quitting = false; // true — программа действительно закрывается (а не прячется в трей)
let startHidden = process.argv.includes("--hidden"); // запуск из автозагрузки

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
const accounts = require("./accounts")({
  dataDir: () => app.getPath("userData"),
  docsDir: () => path.join(app.getPath("documents"), "Senko Assistant")
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
  voicePos: null             // позиция оверлея на экране {x, y} (null — по центру сверху)
};
let cfg = { ...DEFAULTS };
const cfgFile = () => path.join(app.getPath("userData"), "app-settings.json");

function loadCfg() {
  const j = readJson(cfgFile()) || {};
  cfg = { ...DEFAULTS, ...j };
  for (const k of ["alwaysOnTop", "hotkeyEnabled", "compact", "rememberBounds", "tray", "notify", "maximized", "voiceEnabled"]) cfg[k] = !!cfg[k];
  cfg.voiceOpacity = Math.min(100, Math.max(30, Math.round(+cfg.voiceOpacity || DEFAULTS.voiceOpacity)));
  const vp = cfg.voicePos;
  cfg.voicePos = vp && Number.isFinite(+vp.x) && Number.isFinite(+vp.y) ? { x: Math.round(+vp.x), y: Math.round(+vp.y) } : null;
  if (!validHotkey(cfg.voiceHotkey)) cfg.voiceHotkey = DEFAULTS.voiceHotkey;
  cfg.opacity = Math.min(100, Math.max(30, Math.round(+cfg.opacity || 100)));
  if (!validHotkey(cfg.hotkey)) cfg.hotkey = DEFAULTS.hotkey;
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
function box(opts) {
  const p = dlgParent();
  return p ? dialog.showMessageBox(p, opts) : dialog.showMessageBox(opts);
}

async function checkForUpdate(manual) {
  if (UPDATE_BASE.includes("OWNER/REPO")) return; // заглушка не заменена — обновления выключены
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
let updater = null;
let manualCheck = false;

function info(message, detail) {
  return box({ type: "info", title: "Senko Assistant", message, detail, buttons: ["OK"], noLink: true });
}

function initUpdater() {
  if (!app.isPackaged) return; // в режиме разработки (npm start) не работает
  try {
    const { autoUpdater } = require("electron-updater");
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.logger = null;
    autoUpdater.on("update-available", (i) => {
      if (manualCheck) info(`Найдена версия ${i.version}`, "Она скачивается в фоне. Когда загрузка закончится, программа предложит перезапуск.");
    });
    autoUpdater.on("update-not-available", () => {
      if (manualCheck) info("У вас последняя версия программы.", `Версия ${app.getVersion()}`);
      manualCheck = false;
    });
    autoUpdater.on("error", () => {
      if (manualCheck) info("Не удалось проверить обновления.", "Проверьте подключение к интернету и попробуйте позже.");
      manualCheck = false;
    });
    autoUpdater.on("update-downloaded", async (i) => {
      manualCheck = false;
      const r = await box({
        type: "info",
        title: "Обновление программы",
        message: `Новая версия Senko Assistant (${i.version}) загружена.`,
        detail: "Перезапустить программу и установить обновление сейчас? Заметки и настройки сохранятся.",
        buttons: ["Перезапустить и обновить", "Позже"],
        defaultId: 0,
        cancelId: 1
      });
      if (r.response === 0) {
        quitting = true;
        autoUpdater.quitAndInstall(false, true);
      } // «Позже» — обновление установится при следующем выходе из программы
    });
    updater = autoUpdater;
  } catch (e) {
    updater = null; // electron-updater не установлен
  }
}

function checkForAppUpdate(manual) {
  if (!updater) {
    if (manual) info("Автообновление работает только в установленной версии программы.");
    return;
  }
  manualCheck = !!manual;
  updater.checkForUpdates().catch(() => {
    if (manualCheck) info("Не удалось проверить обновления.", "Проверьте подключение к интернету и попробуйте позже.");
    manualCheck = false;
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
  win.setOpacity(cfg.opacity / 100);
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
      updateTrayMenu();
    } catch (e) {
      tray = null;
    }
  } else if (!cfg.tray && tray) {
    tray.destroy();
    tray = null;
  }
}
function updateTrayMenu() {
  if (!tray) return;
  const u = accounts.current();
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "Показать / скрыть окно", click: toggleWindow },
      { type: "separator" },
      { label: "Поверх всех окон", type: "checkbox", checked: cfg.alwaysOnTop, click: (m) => applySet("alwaysOnTop", m.checked) },
      { label: "Компактный режим", type: "checkbox", checked: cfg.compact, click: (m) => applySet("compact", m.checked) },
      { label: `Голосовой ввод (${cfg.voiceHotkey})`, type: "checkbox", checked: cfg.voiceEnabled, click: (m) => applySet("voiceEnabled", m.checked) },
      { type: "separator" },
      { label: "О программе", click: showAbout },
      { label: "Проверить обновления", click: () => { checkForAppUpdate(true); checkForUpdate(true); } },
      ...(u ? [{ label: `Выйти из аккаунта (${u.login})`, click: logout }] : []),
      { type: "separator" },
      { label: "Выход", click: () => { quitting = true; app.quit(); } }
    ])
  );
}

// ───────────── Автозапуск ─────────────
function getAutostart() {
  try { return !!app.getLoginItemSettings().openAtLogin; } catch (e) { return false; }
}

// ───────────── Состояние для окна памятки ─────────────
function getState() {
  const u = accounts.current();
  return {
    cfg: {
      alwaysOnTop: cfg.alwaysOnTop, hotkeyEnabled: cfg.hotkeyEnabled, hotkey: cfg.hotkey,
      compact: cfg.compact, rememberBounds: cfg.rememberBounds, opacity: cfg.opacity,
      tray: cfg.tray, notify: cfg.notify,
      voiceEnabled: cfg.voiceEnabled, voiceHotkey: cfg.voiceHotkey, voiceOpacity: cfg.voiceOpacity
    },
    autostart: getAutostart(),
    hotkeyError,
    packaged: app.isPackaged,
    version: app.getVersion(),
    dataVersion: currentVersion(),
    user: u ? { login: u.login, nick: u.nick, roleName: u.roleName, org: u.org } : null
  };
}
function pushState() {
  if (win && !win.isDestroyed()) win.webContents.send("senko:cfg", getState());
}

function applySet(key, val) {
  const bools = ["alwaysOnTop", "hotkeyEnabled", "compact", "rememberBounds", "tray", "notify", "voiceEnabled"];
  let result = { ok: true };
  if (key === "autostart") {
    if (!app.isPackaged) return { ok: false, error: "Автозапуск доступен только в установленной версии." };
    app.setLoginItemSettings({ openAtLogin: !!val, args: ["--hidden"] });
  } else if (bools.includes(key)) {
    val = !!val;
    if (key !== "compact") cfg[key] = val; // compact переключает setCompact (ему нужны границы прежнего режима)
    if (key === "alwaysOnTop") applyWindowCfg();
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
    }
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
  } else if (key === "voiceOpacity") {
    cfg.voiceOpacity = Math.min(100, Math.max(30, Math.round(+val || DEFAULTS.voiceOpacity)));
    voice.applyOpts();
  } else if (key === "opacity") {
    cfg.opacity = Math.min(100, Math.max(30, Math.round(+val || 100)));
    applyWindowCfg();
  } else {
    return { ok: false, error: "Неизвестная настройка." };
  }
  saveCfg();
  updateTrayMenu();
  pushState();
  return result;
}

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
  const lines = [
    `Версия программы: ${app.getVersion()}`,
    `Версия данных памятки: ${dv}`,
    `Дата выпуска: ${releaseDate()}`,
    `Автор: Boston`,
    `Electron ${process.versions.electron} · Chromium ${process.versions.chrome}`
  ];
  if (u) lines.push("", `Вы вошли как: ${u.login} (${u.nick})`);
  const r = await box({
    type: "info",
    title: "О программе",
    message: "Senko Assistant",
    detail: lines.join("\n"),
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

// ───────────── Законы с форума (сервер парсит форум раз в сутки в 00:05 МСК, приложение сверяет версию каждые 3 часа) ─────────────
const laws = require("./laws-sync")({
  dataDir: () => app.getPath("userData"),
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
    ? { hasUsers: accounts.hasUsers(), depts: accounts.DEPTS, roles: accounts.ROLES, version: app.getVersion() }
    : null
);
ipcMain.handle("auth:login", (e, d) => {
  if (!fromAuth(e)) return { ok: false, error: "Недоступно." };
  const r = accounts.login(d || {});
  if (r.ok) setTimeout(enterApp, 0);
  return r;
});
ipcMain.handle("auth:register", (e, d) => {
  if (!fromAuth(e)) return { ok: false, error: "Недоступно." };
  const r = accounts.register(d || {});
  if (r.ok) setTimeout(enterApp, 0);
  return r;
});
ipcMain.on("auth:quit", (e) => { if (fromAuth(e)) { quitting = true; app.quit(); } });

function createAuthWindow() {
  Menu.setApplicationMenu(null);
  authWin = new BrowserWindow({
    width: 460,
    height: 780,
    minWidth: 400,
    minHeight: 640,
    title: "Senko Assistant — вход",
    autoHideMenuBar: true,
    backgroundColor: "#EDF0F3",
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

function logout() {
  accounts.logout();
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
  applyWindowCfg();
  updateTrayMenu();
}
function tearDownSystem() {
  if (tray) { tray.destroy(); tray = null; }
  try { globalShortcut.unregisterAll(); } catch (e) {}
  hotkeyActive = null;
  voice.destroy();
}

function createMainWindow() {
  Menu.setApplicationMenu(null);
  const saved = cfg.rememberBounds ? visibleBounds(cfg[boundsKey()]) : null;
  const w = new BrowserWindow({
    width: cfg.compact ? COMPACT_W : 560,
    height: 900,
    ...(saved || {}),
    minWidth: cfg.compact ? 300 : 380,
    minHeight: cfg.compact ? 400 : 600,
    show: false,
    title: "Памятка Boston",
    autoHideMenuBar: true,
    backgroundColor: "#EDF0F3",
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

  w.loadFile(pickIndex().file);
  initSystem();

  w.on("resize", saveBoundsSoon);
  w.on("move", saveBoundsSoon);
  w.on("maximize", saveBoundsSoon);
  w.on("unmaximize", saveBoundsSoon);
  w.on("close", (e) => {
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

app.on("second-instance", () => {
  if (win && !win.isDestroyed()) showWindow();
  else if (authWin && !authWin.isDestroyed()) {
    if (authWin.isMinimized()) authWin.restore();
    authWin.focus();
  }
});

app.on("before-quit", () => { quitting = true; });
app.on("will-quit", () => { try { globalShortcut.unregisterAll(); } catch (e) {} });
app.on("window-all-closed", () => app.quit());

app.whenReady().then(() => {
  if (!gotLock) return;
  loadCfg();
  voice.init({
    getWin: () => (win && !win.isDestroyed() ? win : null),
    getCfg: () => cfg,
    isPackaged: app.isPackaged,
    applySet,  // оверлей переключает настройки через общий обработчик (трей и окно памятки обновятся сами)
    saveCfg    // сохранить конфиг (позиция оверлея)
  });
  initUpdater();
  laws.start();

  if (accounts.restore()) createMainWindow(); // запомненный вход
  else createAuthWindow();

  setTimeout(() => { checkForUpdate(); checkForAppUpdate(false); }, 5000);
  setInterval(() => { checkForUpdate(); checkForAppUpdate(false); }, UPDATE_EVERY_MS);
});
