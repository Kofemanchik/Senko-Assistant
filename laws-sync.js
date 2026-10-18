// Клиентская часть «Законов»: на форум сама не ходит.
// Тексты законов GitHub Actions раз в сутки кладёт в репозиторий в ЗАШИФРОВАННОМ виде (update/laws.enc),
// рядом лежит крошечный update/laws-status.json (время проверки и «подпись» версии, без текстов).
// Приложение сверяет подпись и скачивает/расшифровывает файл только если версия новая.
// API прежний: start, get, sync, diagnose, login, logout, debugPath, dataPath (+ peek для синхронного чтения при старте).
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const crypto = require("crypto");
const { net } = require("electron");

const BASE = "https://raw.githubusercontent.com/Kofemanchik/Senko-Assistant/main/update/";
const EVERY_MS = 3 * 60 * 60 * 1000;   // как часто сверять подпись версии (скачивание — только если версия новая)
const STALE_MS = 3 * 24 * 60 * 60 * 1000; // если сервер не проверял форум дольше — предупредить: автообновление встало
const MAGIC = Buffer.from("SLW1");

function loadKey() {
  if (process.env.LAWS_KEY) return String(process.env.LAWS_KEY);
  for (const f of [path.join(__dirname, "laws-key.json"), path.join(process.resourcesPath || "", "laws-key.json")]) {
    try { const j = JSON.parse(fs.readFileSync(f, "utf8")); if (j && j.key) return String(j.key); } catch (e) {}
  }
  return "";
}
function decrypt(buf, secret) {
  if (!secret) throw new Error("в этой сборке программы нет ключа расшифровки законов — скачайте последнюю версию с GitHub Releases");
  if (buf.length < 32 || !buf.subarray(0, 4).equals(MAGIC)) throw new Error("файл законов имеет неверный формат");
  const d = crypto.createDecipheriv("aes-256-gcm", crypto.createHash("sha256").update(secret, "utf8").digest(), buf.subarray(4, 16));
  d.setAuthTag(buf.subarray(16, 32));
  return zlib.gunzipSync(Buffer.concat([d.update(buf.subarray(32)), d.final()])).toString("utf8");
}

module.exports = function (opts) {
  const file = () => path.join(opts.dataDir(), "laws.json");
  const metaFile = () => path.join(opts.dataDir(), "laws-meta.json");
  let data = null, running = false, timer = null, lastErr = "", remote = null, lastOkAt = 0;

  function read() {
    if (data) return data;
    try { data = JSON.parse(fs.readFileSync(file(), "utf8")); } catch (e) { data = null; }
    return data;
  }
  try { const m = JSON.parse(fs.readFileSync(metaFile(), "utf8")); remote = m.remote || null; lastOkAt = m.lastOkAt || 0; } catch (e) {}
  const saveMeta = () => { try { fs.writeFileSync(metaFile(), JSON.stringify({ remote, lastOkAt })); } catch (e) {} };

  function view() {
    const d = read() || { updatedAt: 0, checkedAt: 0, laws: [], changes: [] };
    const checked = Math.max((remote && remote.checkedAt) || 0, lastOkAt || 0);
    let warn = "";
    if (checked && Date.now() - checked > STALE_MS) warn = "Сервер давно не проверял форум (последняя проверка: " + new Date(checked).toLocaleString("ru-RU") + "). Автообновление законов могло остановиться — сообщите владельцу.";
    else if (remote && remote.ok === false) warn = "Последняя проверка форума на сервере прошла с ошибкой" + (remote.error ? ": " + remote.error : "") + ". Показаны ранее загруженные данные.";
    return Object.assign({}, d, {
      checkedAt: checked || d.checkedAt || 0,
      running,
      auth: true,
      warn,
      status: lastErr ? { ok: false, error: lastErr } : { ok: true, failed: (remote && remote.failed) || 0 }
    });
  }

  async function getBuf(url, ms) {
    const res = await net.fetch(url + "?t=" + Date.now(), { signal: AbortSignal.timeout(ms) });
    if (!res.ok) throw new Error("сервер вернул " + res.status + " для " + url.split("/").pop());
    return Buffer.from(await res.arrayBuffer());
  }

  async function sync() {
    if (running) return view();
    running = true;
    opts.onProgress && opts.onProgress({ phase: "list", done: 0 });
    const before = read();
    try {
      let st = null;
      try { st = JSON.parse((await getBuf(BASE + "laws-status.json", 20000)).toString("utf8")); } catch (e) { st = null; }
      if (st) { remote = st; saveMeta(); }

      const same = st && before && before.sig && st.sig === before.sig;
      let changed = false, newCh = [];
      if (!same) {
        const enc = await getBuf(BASE + "laws.enc", 90000);
        let j;
        try { j = JSON.parse(decrypt(enc, loadKey())); } catch (e) { throw new Error("не удалось расшифровать файл законов (" + (e && e.message ? e.message : e) + ")"); }
        if (!j || !Array.isArray(j.laws) || !j.laws.length) throw new Error("файл законов пустой или повреждён");
        fs.mkdirSync(path.dirname(file()), { recursive: true });
        fs.writeFileSync(file() + ".tmp", JSON.stringify(j));
        fs.renameSync(file() + ".tmp", file());
        changed = !before || before.sig !== j.sig || before.updatedAt !== j.updatedAt;
        const seenAt = before ? before.updatedAt || 0 : 0;
        newCh = (j.changes || []).filter((c) => c.at > seenAt);
        data = j;
      }
      lastErr = ""; lastOkAt = Date.now(); saveMeta();
      running = false;
      opts.onUpdate && opts.onUpdate({ notify: changed && !!before && newCh.length > 0, changed, changes: newCh });
    } catch (e) {
      lastErr = "Не удалось получить законы: " + (e && e.message ? e.message : e);
      running = false;
      opts.onUpdate && opts.onUpdate({ notify: false, changed: false, changes: [] });
    }
    return view();
  }

  return {
    start() {
      setTimeout(sync, 4000);
      timer = setInterval(sync, EVERY_MS);
    },
    peek: () => read(),
    get: async () => view(),
    sync,
    diagnose: async () => {
      const d = read();
      return [
        "Источник: " + BASE,
        "Ключ расшифровки: " + (loadKey() ? "есть" : "НЕТ"),
        "Файл на диске: " + file() + (fs.existsSync(file()) ? "" : " (нет)"),
        "Законов: " + ((d && d.laws.length) || 0),
        "Версия данных обновлена: " + (d && d.updatedAt ? new Date(d.updatedAt).toISOString() : "—"),
        "Сервер проверял форум: " + (remote && remote.checkedAt ? new Date(remote.checkedAt).toISOString() : "—") + (remote && remote.ok === false ? " (с ошибкой: " + remote.error + ")" : ""),
        "Последняя успешная сверка в приложении: " + (lastOkAt ? new Date(lastOkAt).toISOString() : "—"),
        "Последняя ошибка: " + (lastErr || "нет")
      ].join("\n");
    },
    login: async () => ({ ok: true }),
    logout: async () => null,
    debugPath: () => path.join(opts.dataDir(), "laws-debug.txt"),
    dataPath: () => file()
  };
};
