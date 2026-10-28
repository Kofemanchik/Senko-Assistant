// Клиентская часть «Законов»: на форум сама не ходит.
// Тексты законов GitHub Actions раз в сутки кладёт в репозиторий в ЗАШИФРОВАННОМ виде (update/laws.enc),
// рядом лежит крошечный update/laws-status.json (время проверки и «подпись» версии, без текстов).
// Приложение сверяет подпись и, если версия новая, получает законы с сервера Senko (действие "laws"):
// расшифровка идёт на сервере, ключа в программе нет (с 2.2.1). Нужен вход в аккаунт.
// API прежний: start, get, sync, diagnose, login, logout, debugPath, dataPath (+ peek для синхронного чтения при старте).
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const { net } = require("electron");

const BASE = "https://raw.githubusercontent.com/Kofemanchik/Senko-Assistant/main/update/";
const EVERY_MS = 3 * 60 * 60 * 1000;   // как часто сверять подпись версии (скачивание — только если версия новая)
const STALE_MS = 3 * 24 * 60 * 60 * 1000; // если сервер не проверял форум дольше — предупредить: автообновление встало
const RETRY_MS = 60 * 1000;            // не вошли или нет связи: попробовать снова через минуту

const DEFAULT_SERVER = 12; // Boston: его файлы называются как раньше (laws.json, laws-meta.json, laws-history), остальные — с номером сервера

module.exports = function (opts) {
  // 2.9: у каждого сервера свои законы. Сервер берётся из профиля вошедшего игрока (opts.server), при его смене состояние перечитывается
  const srv = () => { const n = parseInt(opts.server && opts.server(), 10); return n > 0 ? n : DEFAULT_SERVER; };
  const sfx = () => (srv() === DEFAULT_SERVER ? "" : "-" + srv());
  const file = () => path.join(opts.dataDir(), "laws" + sfx() + ".json");
  const metaFile = () => path.join(opts.dataDir(), "laws-meta" + sfx() + ".json");
  const histDir = () => path.join(opts.dataDir(), "laws-history" + sfx()); // 2.2: прошлые версии для отката (3 последние)
  let data = null, running = false, timer = null, retry = null, lastErr = "", remote = null, lastOkAt = 0, hold = 0, loadedFor = 0, missing = false;

  function loadState() {
    if (loadedFor === srv()) return;
    loadedFor = srv(); data = null; remote = null; lastOkAt = 0; hold = 0; lastErr = ""; missing = false;
    try { const m = JSON.parse(fs.readFileSync(metaFile(), "utf8")); remote = m.remote || null; lastOkAt = m.lastOkAt || 0; hold = m.hold || 0; } catch (e) {}
  }
  function read() {
    loadState();
    if (data) return data;
    try { data = JSON.parse(fs.readFileSync(file(), "utf8")); } catch (e) { data = null; }
    return data;
  }
  const saveMeta = () => { try { fs.writeFileSync(metaFile(), JSON.stringify({ remote, lastOkAt, hold })); } catch (e) {} };
  function keepHistory() {
    try {
      if (!fs.existsSync(file())) return;
      const cur = read();
      fs.mkdirSync(histDir(), { recursive: true });
      fs.copyFileSync(file(), path.join(histDir(), "laws-" + ((cur && cur.updatedAt) || Date.now()) + ".json"));
      const all = fs.readdirSync(histDir()).filter((f) => /^laws-\d+\.json$/.test(f)).sort((a, b) => parseInt(b.slice(5), 10) - parseInt(a.slice(5), 10));
      all.slice(3).forEach((f) => { try { fs.rmSync(path.join(histDir(), f)); } catch (e) {} });
    } catch (e) {}
  }
  function versions() {
    const d = read();
    let list = [];
    try {
      list = fs.readdirSync(histDir()).filter((f) => /^laws-\d+\.json$/.test(f)).map((f) => {
        let n = 0;
        try { const j = JSON.parse(fs.readFileSync(path.join(histDir(), f), "utf8")); n = (j.laws || []).length; } catch (e) {}
        return { id: f.slice(5, -5), updatedAt: parseInt(f.slice(5), 10), count: n };
      }).filter((x) => !d || x.updatedAt !== d.updatedAt).sort((a, b) => b.updatedAt - a.updatedAt);
    } catch (e) {}
    return { current: d ? { updatedAt: d.updatedAt || 0, count: (d.laws || []).length } : null, history: list, hold: !!hold };
  }
  function restore(id) {
    if (!/^\d+$/.test(String(id))) return { ok: false, error: "Неизвестная версия законов." };
    const f = path.join(histDir(), "laws-" + id + ".json");
    if (!fs.existsSync(f)) return { ok: false, error: "Эта версия законов уже удалена." };
    let j;
    try { j = JSON.parse(fs.readFileSync(f, "utf8")); } catch (e) { return { ok: false, error: "Файл версии повреждён." }; }
    if (!j || !Array.isArray(j.laws) || !j.laws.length) return { ok: false, error: "Файл версии пустой." };
    keepHistory();
    fs.writeFileSync(file() + ".tmp", JSON.stringify(j));
    fs.renameSync(file() + ".tmp", file());
    data = j; hold = Date.now(); saveMeta();
    return { ok: true };
  }

  function view() {
    const d = read() || { updatedAt: 0, checkedAt: 0, laws: [], changes: [] };
    const sn = srv();
    const checked = Math.max((remote && remote.checkedAt) || 0, lastOkAt || 0);
    let warn = "";
    if (checked && Date.now() - checked > STALE_MS) warn = "Сервер давно не проверял форум (последняя проверка: " + new Date(checked).toLocaleString("ru-RU") + "). Автообновление законов могло остановиться — сообщите владельцу.";
    else if (missing && !read()) warn = "Законы сервера " + sn + " ещё не собраны с форума, пока показаны законы Boston. Как только их соберут, программа обновится сама.";
    else if (remote && remote.ok === false) warn = "Последняя проверка форума на сервере прошла с ошибкой" + (remote.error ? ": " + remote.error : "") + ". Показаны ранее загруженные данные.";
    return Object.assign({}, d, {
      checkedAt: checked || d.checkedAt || 0,
      running,
      server: sn,
      missing: !!missing && !read(),
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
    loadState();
    if (running) return view();
    running = true;
    const sn = srv();
    opts.onProgress && opts.onProgress({ phase: "list", done: 0 });
    const before = read();
    try {
      let st = null;
      try { st = JSON.parse((await getBuf(BASE + "laws-status" + sfx() + ".json", 20000)).toString("utf8")); } catch (e) { st = null; }
      if (st) { remote = st; saveMeta(); }

      // после отката пользователь сам возвращает обновления: до этого новую версию не скачиваем
      const same = hold || (st && before && before.sig && st.sig === before.sig);
      let changed = false, newCh = [];
      if (!same) {
        const r = await opts.api({ action: "laws", server: sn, sig: (before && before.sig) || "", want: (st && st.sig) || "" });
        if (r && !r.ok && r.code === "laws_none") {
          // законы этого сервера ещё не собраны: это не ошибка связи, повторять каждую минуту не нужно
          missing = true; lastErr = "";
          running = false;
          opts.onUpdate && opts.onUpdate({ notify: false, changed: false, changes: [] });
          return view();
        }
        if (!r || !r.ok) {
          const e = new Error((r && r.error) || "сервер не ответил");
          e.code = r && r.code;
          throw e;
        }
        // сервер мог вернуть законы другого сервера, если профиль сменился во время загрузки: не сохраняем
        if (r.server && r.server !== srv()) throw new Error("сервер игрока изменился во время загрузки, повторим");
        missing = false;
        // сервер ответил «та же версия» (например, если GitHub не отдал laws-status.json): ничего не меняем
        if (!r.same) {
          let j = null;
          try { j = JSON.parse(zlib.gunzipSync(Buffer.from(String(r.gz || ""), "base64")).toString("utf8")); } catch (e) { throw new Error("сервер прислал повреждённый файл законов"); }
          if (!j || !Array.isArray(j.laws) || !j.laws.length) throw new Error("файл законов пустой или повреждён");
          fs.mkdirSync(path.dirname(file()), { recursive: true });
          keepHistory();
          fs.writeFileSync(file() + ".tmp", JSON.stringify(j));
          fs.renameSync(file() + ".tmp", file());
          changed = !before || before.sig !== j.sig || before.updatedAt !== j.updatedAt;
          const seenAt = before ? before.updatedAt || 0 : 0;
          newCh = (j.changes || []).filter((c) => c.at > seenAt);
          data = j;
        }
      }
      lastErr = ""; lastOkAt = Date.now(); saveMeta();
      running = false;
      opts.onUpdate && opts.onUpdate({ notify: changed && !!before && newCh.length > 0, changed, changes: newCh });
    } catch (e) {
      lastErr = "Не удалось получить законы: " + (e && e.message ? e.message : e);
      running = false;
      // не вошли в аккаунт или нет связи: повторим чуть позже, не дожидаясь трёх часов
      if (e && (e.code === "auth" || e.code === "network" || e.code === "server") && !retry) retry = setTimeout(() => { retry = null; sync(); }, RETRY_MS);
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
    versions,
    restore,
    resume() { hold = 0; saveMeta(); return sync(); },
    get: async () => view(),
    sync,
    diagnose: async () => {
      const d = read();
      return [
        "Сервер игрока: " + srv() + (missing ? " (законы ещё не собраны, используются законы Boston)" : ""),
        "Источник: " + BASE + " (версия), сервер Senko (тексты)",
        "Файл на диске: " + file() + (fs.existsSync(file()) ? "" : " (нет)"),
        "Законов: " + ((d && d.laws.length) || 0),
        "Версия данных обновлена: " + (d && d.updatedAt ? new Date(d.updatedAt).toISOString() : "—"),
        "Сервер проверял форум: " + (remote && remote.checkedAt ? new Date(remote.checkedAt).toISOString() : "—") + (remote && remote.ok === false ? " (с ошибкой: " + remote.error + ")" : ""),
        "Последняя успешная сверка в приложении: " + (lastOkAt ? new Date(lastOkAt).toISOString() : "—"),
        "Последняя ошибка: " + (lastErr || "нет"),
        "Автообновление законов: " + (hold ? "на паузе после отката (" + new Date(hold).toISOString() + ")" : "включено")
      ].join("\n");
    },
    login: async () => ({ ok: true }),
    logout: async () => null,
    debugPath: () => path.join(opts.dataDir(), "laws-debug.txt"),
    dataPath: () => file()
  };
};
