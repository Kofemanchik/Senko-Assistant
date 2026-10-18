// Клиентская часть «Законов»: больше не ходит на форум сама.
// Раз в сутки (и по кнопке) скачивает update/laws.json из репозитория, куда его кладёт GitHub Actions.
// API тот же, что был раньше: start, get, sync, diagnose, login, logout, debugPath, dataPath.
const fs = require("fs");
const path = require("path");
const { net } = require("electron");

const LAWS_URL = "https://raw.githubusercontent.com/Kofemanchik/Senko-Assistant/main/update/laws.json";
const EVERY_MS = 6 * 60 * 60 * 1000; // как часто проверять, не вышла ли новая версия файла

module.exports = function (opts) {
  const file = () => path.join(opts.dataDir(), "laws.json");
  let data = null, running = false, timer = null, lastErr = "";

  function read() {
    if (data) return data;
    try { data = JSON.parse(fs.readFileSync(file(), "utf8")); } catch (e) { data = null; }
    return data;
  }
  function view() {
    const d = read() || { updatedAt: 0, checkedAt: 0, laws: [], changes: [] };
    return Object.assign({}, d, {
      running,
      auth: true,
      status: lastErr ? { ok: false, error: lastErr } : (d.status || { ok: true })
    });
  }

  async function sync() {
    if (running) return view();
    running = true;
    opts.onProgress && opts.onProgress({ phase: "list", done: 0 });
    const before = read();
    try {
      const res = await net.fetch(LAWS_URL + "?t=" + Date.now(), { signal: AbortSignal.timeout(60000) });
      if (!res.ok) throw new Error("Сервер вернул " + res.status + ". Файл законов ещё не опубликован?");
      const j = await res.json();
      if (!j || !Array.isArray(j.laws) || !j.laws.length) throw new Error("Файл законов пустой или повреждён.");
      const had = before && before.updatedAt === j.updatedAt && before.laws.length === j.laws.length;
      fs.mkdirSync(path.dirname(file()), { recursive: true });
      fs.writeFileSync(file() + ".tmp", JSON.stringify(j));
      fs.renameSync(file() + ".tmp", file());
      data = j; lastErr = "";
      const fresh = !had;
      const seenAt = before ? before.updatedAt || 0 : 0;
      const newCh = (j.changes || []).filter((c) => c.at > seenAt);
      running = false;
      opts.onUpdate && opts.onUpdate({ notify: fresh && !!before && newCh.length > 0, changes: newCh });
    } catch (e) {
      lastErr = "Не удалось получить законы: " + (e && e.message ? e.message : e);
      running = false;
      opts.onUpdate && opts.onUpdate({ notify: false, changes: [] });
    }
    return view();
  }

  return {
    start() {
      setTimeout(sync, 4000);
      timer = setInterval(sync, EVERY_MS);
    },
    get: async () => view(),
    sync,
    diagnose: async () => [
      "Источник: " + LAWS_URL,
      "Файл на диске: " + file() + (fs.existsSync(file()) ? "" : " (нет)"),
      "Законов: " + ((read() && read().laws.length) || 0),
      "Обновлено: " + (read() && read().updatedAt ? new Date(read().updatedAt).toISOString() : "—"),
      "Проверено: " + (read() && read().checkedAt ? new Date(read().checkedAt).toISOString() : "—"),
      "Последняя ошибка: " + (lastErr || "нет")
    ].join("\n"),
    login: async () => ({ ok: true }),
    logout: async () => null,
    debugPath: () => path.join(opts.dataDir(), "laws-debug.txt"),
    dataPath: () => file()
  };
};
