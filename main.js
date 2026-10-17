const { app, BrowserWindow, shell, Menu, ipcMain, dialog, net } = require("electron");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");

// ───────────── НАСТРОЙКИ ─────────────
// Папка в репозитории GitHub, где лежат version.json и index.html для обновлений.
// После создания репозитория замените OWNER и REPO (см. README.md).
const UPDATE_BASE = "https://raw.githubusercontent.com/Kofemanchik/Senko-Assistant/main/update/";
const UPDATE_EVERY_MS = 3 * 60 * 60 * 1000; // повторная проверка раз в 3 часа
const KEEP_BACKUPS = 14;                    // сколько дневных копий хранить
// ──────────────────────────────────────

// Имя программы теперь «Senko Assistant», но папку данных оставляем прежней («Boston»),
// чтобы у тех, кто уже пользовался приложением, не пропали заметки и настройки.
app.setPath("userData", path.join(app.getPath("appData"), "Boston"));

if (!app.requestSingleInstanceLock()) {
  app.quit();
}

let win;

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
    // Атомарная запись: сначала временный файл, потом переименование
    const tmp = mainFile() + ".tmp";
    fs.writeFileSync(tmp, payload, "utf8");
    fs.renameSync(tmp, mainFile());

    // Одна резервная копия в день (последнее состояние дня перезаписывает копию)
    const day = new Date().toISOString().slice(0, 10);
    fs.writeFileSync(path.join(backupDir(), `senko-data-${day}.json`), payload, "utf8");
    const old = fs.readdirSync(backupDir()).filter((f) => f.endsWith(".json")).sort().reverse().slice(KEEP_BACKUPS);
    for (const f of old) fs.unlinkSync(path.join(backupDir(), f));
  } catch (err) {
    console.error("autosave failed:", err);
  }
});

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

async function checkForUpdate() {
  if (UPDATE_BASE.includes("Kofemanchik/Senko-Assistant")) return; // ещё не настроено
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
      const r = await dialog.showMessageBox(win, {
        type: "info",
        title: "Обновление",
        message: `Доступна новая версия памятки (${info.version}).`,
        detail: (info.notes ? info.notes + "\n\n" : "") + "Данные уже скачаны. Перезагрузить сейчас?",
        buttons: ["Перезагрузить", "Позже"],
        defaultId: 0,
        cancelId: 1
      });
      if (r.response === 0) win.loadFile(pickIndex().file);
    }
  } catch (e) {
    // нет сети / GitHub недоступен — работаем с тем, что есть
  }
}

// ───────────── Окно ─────────────
function createWindow() {
  Menu.setApplicationMenu(null);
  win = new BrowserWindow({
    width: 560,
    height: 900,
    minWidth: 380,
    minHeight: 600,
    title: "Памятка Boston",
    autoHideMenuBar: true,
    backgroundColor: "#EDF0F3",
    icon: path.join(__dirname, "build", "icon.ico"),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      preload: path.join(__dirname, "preload.js")
    }
  });

  win.loadFile(pickIndex().file);

  // Внешние ссылки открываем в браузере, а не внутри приложения
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (e, url) => {
    if (/^https?:/i.test(url)) {
      e.preventDefault();
      shell.openExternal(url);
    }
  });
}

app.on("second-instance", () => {
  if (win) {
    if (win.isMinimized()) win.restore();
    win.focus();
  }
});

app.whenReady().then(() => {
  createWindow();
  setTimeout(checkForUpdate, 4000);
  setInterval(checkForUpdate, UPDATE_EVERY_MS);
});
app.on("window-all-closed", () => app.quit());
