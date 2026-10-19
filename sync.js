// Синхронизация данных работы между компьютерами (задержания, результаты тестов, статистика тренажёра).
//
// Как это работает:
//  • Данные живут в localStorage страницы (ключи bos-*). Эта часть работает в главном процессе.
//  • При запуске окна программа заранее скачивает с сервера изменения (prefetch), затем preload отдаёт сюда
//    локальные значения, а мы возвращаем слитый результат (startup) — страница стартует уже с общими данными.
//  • Во время работы preload сообщает об изменениях (noteLocal), через несколько секунд они уходят на сервер (pushNow).
//  • Списки (задержания, тесты, журнал) синхронизируются по элементам: у каждого есть id, конфликт решает «последняя правка»,
//    удаление передаётся отдельной записью. Счётчики (статистика, XP, серия) сливаются без потерь: берётся большее значение.
//  • Чьи это данные: если на компьютере вошёл другой аккаунт, чужие локальные данные не передаются на сервер
//    (копия сохраняется в папку foreign-backup), а загружаются данные нового аккаунта.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const KEYS = {
  "bos-thist": { kind: "thist", list: true, idOf: (r) => r.id, order: (r) => Number(r.end || r.start || r.id) || 0, cap: 100 },
  "bos-dlog": { kind: "dlog", list: true, idOf: (r) => r.id, order: (r) => Number(r.id) || 0, cap: 40 },
  "bos-tests": { kind: "tests", list: true, idOf: (r) => r.t, order: (r) => Number(r.t) || 0, cap: 30 },
  "bos-qstat": { kind: "qstat", merge: mergeQstat, def: { q: {}, tp: {} } },
  "bos-xp": { kind: "xp", merge: (a, b) => Math.max(+a || 0, +b || 0), def: 0 },
  "bos-daily": { kind: "daily", merge: mergeDaily, def: { d: "", s: 0, n: 0 } },
  "bos-streak": { kind: "streak", merge: mergeStreak, def: { last: "", n: 0 } }
};
const KEY_LIST = Object.keys(KEYS);
const KIND_KEY = {};
KEY_LIST.forEach((k) => (KIND_KEY[KEYS[k].kind] = k));
const KV_ID = "1";

// ───────────── слияние счётчиков ─────────────
function mergeQstat(a, b) {
  const ok = (x) => x && typeof x === "object" && x.q && typeof x.q === "object" && x.tp && typeof x.tp === "object";
  if (!ok(a)) return ok(b) ? b : { q: {}, tp: {} };
  if (!ok(b)) return a;
  const ea = +a._e || 0, eb = +b._e || 0;
  if (ea !== eb) return ea > eb ? a : b; // сброс статистики (новая «эпоха») сильнее старых значений
  const out = { q: {}, tp: {} };
  if (ea) out._e = ea;
  const pick = (x, y) => (!x ? y : !y ? x : (+y.a || 0) > (+x.a || 0) || ((+y.a || 0) === (+x.a || 0) && (+y.t || 0) > (+x.t || 0)) ? y : x);
  for (const id of new Set([...Object.keys(a.q), ...Object.keys(b.q)])) out.q[id] = pick(a.q[id], b.q[id]);
  for (const id of new Set([...Object.keys(a.tp), ...Object.keys(b.tp)])) out.tp[id] = pick(a.tp[id], b.tp[id]);
  return out;
}
function mergeDaily(a, b) {
  a = a && typeof a === "object" ? a : { d: "", s: 0, n: 0 };
  b = b && typeof b === "object" ? b : { d: "", s: 0, n: 0 };
  if (String(a.d) !== String(b.d)) return String(a.d) > String(b.d) ? a : b;
  return (+b.s || 0) > (+a.s || 0) ? b : a;
}
function mergeStreak(a, b) {
  a = a && typeof a === "object" ? a : { last: "", n: 0 };
  b = b && typeof b === "object" ? b : { last: "", n: 0 };
  if (String(a.last) !== String(b.last)) return String(a.last) > String(b.last) ? a : b;
  return (+b.n || 0) > (+a.n || 0) ? b : a;
}

// ───────────── вспомогательное ─────────────
function canon(v) {
  if (Array.isArray(v)) return "[" + v.map(canon).join(",") + "]";
  if (v && typeof v === "object") return "{" + Object.keys(v).sort().map((k) => JSON.stringify(k) + ":" + canon(v[k])).join(",") + "}";
  return JSON.stringify(v === undefined ? null : v);
}
const hash = (v) => crypto.createHash("sha1").update(canon(v)).digest("hex").slice(0, 16);
function parse(str) {
  if (typeof str !== "string") return undefined;
  try {
    return JSON.parse(str);
  } catch (e) {
    return undefined;
  }
}

module.exports = function createSync({ dataDir, authed, now, onAuthLost, backupDir }) {
  const clock = now || Date.now;
  const stateFile = (login) => path.join(dataDir(), `sync-${String(login).toLowerCase().replace(/[^\w.-]/g, "_")}.json`);
  const ownerFile = () => path.join(dataDir(), "sync-owner.json");

  let login = "";
  let state = null; // { device, cursor, snap: { kind: { id: {h, o} } } }
  let foreign = false; // локальные данные принадлежат другому аккаунту
  let remote = null; // скачанные с сервера изменения { items, cursor }
  let latest = {}; // последние известные локальные значения (строки)
  let liveKeys = new Set(); // ключи, изменённые за время работы страницы
  let timer = null;
  let pushing = null;
  const status = { at: 0, ok: null, offline: false, error: "" };

  const readJson = (f) => {
    try {
      const j = JSON.parse(fs.readFileSync(f, "utf8"));
      return j && typeof j === "object" ? j : null;
    } catch (e) {
      return null;
    }
  };
  const writeJson = (f, o) => {
    try {
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f + ".tmp", JSON.stringify(o), "utf8");
      fs.renameSync(f + ".tmp", f);
    } catch (e) {
      console.error("sync state failed:", e);
    }
  };
  const save = () => state && writeJson(stateFile(login), state);

  function fail(r) {
    if (r && (r.code === "network" || r.code === "server")) {
      status.ok = false;
      status.offline = true;
      status.error = "";
    } else {
      status.ok = false;
      status.offline = false;
      status.error = (r && r.error) || "Ошибка синхронизации.";
      if (r && (r.code === "auth" || r.code === "banned") && onAuthLost) onAuthLost(r);
    }
  }
  const good = () => {
    status.ok = true;
    status.offline = false;
    status.error = "";
    status.at = clock();
  };

  // ───────────── начало сеанса ─────────────
  function begin(loginName) {
    login = String(loginName);
    const owner = (readJson(ownerFile()) || {}).login;
    foreign = !!owner && owner.toLowerCase() !== login.toLowerCase();
    state = readJson(stateFile(login));
    if (!state || typeof state !== "object" || !state.snap) state = { device: crypto.randomBytes(8).toString("hex"), cursor: 0, snap: {} };
    if (foreign) {
      state.cursor = 0; // чужие локальные данные не используем: берём всё с сервера
      state.snap = {};
    }
    remote = null;
    latest = {};
    liveKeys = new Set();
  }

  // Скачать изменения с сервера (до открытия страницы)
  async function prefetch() {
    if (!state) return null;
    const items = [];
    let cursor = state.cursor;
    for (let i = 0; i < 20; i++) {
      const r = await authed({ action: "sync", device: state.device, pull: true, since: cursor, items: [] });
      if (!r || !r.ok) {
        fail(r);
        return null;
      }
      items.push(...(r.items || []));
      cursor = r.cursor;
      if (!r.more) break;
    }
    good();
    remote = { items, cursor };
    return remote;
  }

  // Слияние при запуске страницы: local — строки из localStorage; возвращает значения, которые нужно записать
  function startup(local) {
    if (!state) return null;
    const values = {};
    const loc = {};
    for (const k of KEY_LIST) loc[k] = foreign ? undefined : parse(local && local[k]);
    if (foreign && local) {
      try {
        const dir = backupDir ? backupDir() : path.join(dataDir(), "foreign-backup");
        const prev = (readJson(ownerFile()) || {}).login || "unknown";
        writeJson(path.join(dir, `local-data-of-${prev}-${clock()}.json`), local);
      } catch (e) {}
    }
    const byKind = {};
    if (remote) for (const it of remote.items) (byKind[it.kind] = byKind[it.kind] || {})[it.id] = it;

    for (const k of KEY_LIST) {
      const cfg = KEYS[k];
      const rem = byKind[cfg.kind] || {};
      const snap = (state.snap[cfg.kind] = state.snap[cfg.kind] || {});
      let out;
      if (cfg.list) {
        const arr = Array.isArray(loc[k]) ? loc[k].filter((r) => r && typeof r === "object" && cfg.idOf(r) != null) : [];
        const map = new Map();
        const modified = new Set();
        for (const r of arr) {
          const id = String(cfg.idOf(r));
          map.set(id, r);
          if (!snap[id] || snap[id].h !== hash(r)) modified.add(id);
        }
        for (const id of Object.keys(rem)) {
          const it = rem[id];
          if (it.del) {
            if (map.has(id) && !modified.has(id)) map.delete(id);
            if (!map.has(id)) delete snap[id];
            continue;
          }
          if (!it.data || typeof it.data !== "object") continue;
          if (map.has(id) && modified.has(id)) continue; // локальная правка новее — отправим её
          map.set(id, it.data);
          snap[id] = { h: hash(it.data), o: cfg.order(it.data) };
        }
        let res = [...map.values()].sort((a, b) => cfg.order(b) - cfg.order(a));
        if (res.length > cfg.cap) res.length = cfg.cap;
        out = res;
        if (!res.length && foreign) out = undefined;
      } else {
        const r = rem[KV_ID];
        const serverVal = r && !r.del ? r.data : undefined;
        const lv = loc[k];
        let merged;
        if (serverVal === undefined) merged = lv;
        else if (lv === undefined) merged = serverVal;
        else merged = cfg.merge(lv, serverVal);
        if (serverVal !== undefined) snap[KV_ID] = { h: hash(serverVal) };
        out = merged;
      }
      const prev = local ? local[k] : undefined;
      if (out === undefined) {
        if (prev != null && foreign) values[k] = null; // у нового аккаунта этого нет — убираем чужое
      } else {
        const str = JSON.stringify(out);
        if (str !== prev) values[k] = str;
        latest[k] = str;
      }
      if (!(k in latest) && prev != null && !foreign) latest[k] = prev;
    }
    if (remote) {
      state.cursor = remote.cursor;
      remote = null;
    }
    writeJson(ownerFile(), { login });
    foreign = false;
    save();
    return { values };
  }

  // ───────────── отправка локальных изменений ─────────────
  function buildItems() {
    const items = [];
    const apply = []; // что записать в snap после подтверждения
    const t = clock();
    for (const k of KEY_LIST) {
      if (!(k in latest)) continue;
      const cfg = KEYS[k];
      const v = parse(latest[k]);
      const snap = state.snap[cfg.kind] || {};
      if (cfg.list) {
        const arr = Array.isArray(v) ? v.filter((r) => r && typeof r === "object" && cfg.idOf(r) != null) : [];
        const seen = new Set();
        let minOrder = Infinity;
        for (const r of arr) {
          const id = String(cfg.idOf(r));
          seen.add(id);
          minOrder = Math.min(minOrder, cfg.order(r));
          const h = hash(r);
          if (!snap[id] || snap[id].h !== h) {
            items.push({ kind: cfg.kind, id, data: r, u: t });
            apply.push({ kind: cfg.kind, id, h, o: cfg.order(r) });
          }
        }
        for (const id of Object.keys(snap)) {
          if (seen.has(id)) continue;
          const o = snap[id].o || 0;
          const cleared = !arr.length && liveKeys.has(k); // список опустел во время работы — это очистка истории
          if (cleared || (arr.length && o > minOrder)) {
            items.push({ kind: cfg.kind, id, u: t, del: true });
            apply.push({ kind: cfg.kind, id, del: true });
          } else if (arr.length) {
            apply.push({ kind: cfg.kind, id, del: true, silent: true }); // выпал из лимита списка: на сервере остаётся
          }
        }
      } else if (v !== undefined) {
        const h = hash(v);
        const cur = snap[KV_ID];
        const isDefault = h === hash(cfg.def);
        if ((!cur && !isDefault) || (cur && cur.h !== h)) {
          items.push({ kind: cfg.kind, id: KV_ID, data: v, u: t });
          apply.push({ kind: cfg.kind, id: KV_ID, h });
        }
      }
    }
    return { items, apply };
  }

  function commit(apply) {
    for (const a of apply) {
      const snap = (state.snap[a.kind] = state.snap[a.kind] || {});
      if (a.del) delete snap[a.id];
      else snap[a.id] = { h: a.h, o: a.o };
    }
    save();
  }

  // Отправить накопленные изменения (токен берётся синхронно, до первого await)
  function pushNow() {
    if (!state || !login) return Promise.resolve({ ok: false });
    clearTimeout(timer);
    timer = null;
    if (pushing) return pushing.then(() => pushNow());
    const { items, apply } = buildItems();
    if (!items.length) return Promise.resolve({ ok: true, sent: 0 });
    const chunks = [];
    for (let i = 0; i < items.length; i += 200) chunks.push(items.slice(i, i + 200));
    pushing = (async () => {
      try {
        for (let i = 0; i < chunks.length; i++) {
          const r = await authed({ action: "sync", device: state.device, items: chunks[i] });
          if (!r || !r.ok) {
            fail(r);
            return { ok: false };
          }
        }
        commit(apply);
        good();
        return { ok: true, sent: items.length };
      } finally {
        pushing = null;
      }
    })();
    return pushing;
  }

  // Изменения от страницы (preload): { ключ: строка }
  function noteLocal(map) {
    if (!state || !map) return;
    for (const k of Object.keys(map)) {
      if (!KEYS[k]) continue;
      if (map[k] == null) delete latest[k];
      else latest[k] = String(map[k]);
      liveKeys.add(k);
    }
    clearTimeout(timer);
    timer = setTimeout(() => {
      pushNow().catch(() => {});
    }, 5000);
  }

  function stop() {
    clearTimeout(timer);
    timer = null;
  }

  return {
    KEYS,
    KEY_LIST,
    begin,
    prefetch,
    startup,
    noteLocal,
    pushNow,
    stop,
    status: () => ({ ...status, pending: state ? buildItems().items.length : 0 }),
    hasState: () => !!state,
    _mergeQstat: mergeQstat
  };
};
module.exports.mergeQstat = mergeQstat;
