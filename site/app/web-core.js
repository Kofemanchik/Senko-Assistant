/* Senko Assistant · веб-версия: общее для окна входа и помощника.
   Запросы к серверу, сессия в браузере, синхронизация данных аккаунта (как sync.js в программе), законы в IndexedDB.
   Адрес сервера и версию подставляет tools/build-site.js в window.SENKO_WEB. */
(function () {
  "use strict";
  var CFG = window.SENKO_WEB || {};
  var OFFLINE_GRACE_DAYS = 14;

  function ls(k, v) {
    try {
      if (v === undefined) return localStorage.getItem(k);
      if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v);
    } catch (e) { return null; }
  }
  function ss(k, v) {
    try {
      if (v === undefined) return sessionStorage.getItem(k);
      if (v === null) sessionStorage.removeItem(k); else sessionStorage.setItem(k, v);
    } catch (e) { return null; }
  }
  function readJ(s) { try { var j = JSON.parse(s || "null"); return j && typeof j === "object" ? j : null; } catch (e) { return null; } }
  function rndHex(n) {
    var a = new Uint8Array(n);
    (window.crypto || window.msCrypto).getRandomValues(a);
    return Array.prototype.map.call(a, function (b) { return ("0" + b.toString(16)).slice(-2); }).join("");
  }

  /* ───── запросы ───── */
  // Обычный POST с текстом: браузер не делает предварительный запрос OPTIONS
  function call(body, ms) {
    var ctl = window.AbortController ? new AbortController() : null;
    var t = ctl ? setTimeout(function () { ctl.abort(); }, ms || 20000) : 0;
    return fetch(CFG.api, { method: "POST", body: JSON.stringify(body), signal: ctl ? ctl.signal : undefined, keepalive: !!(body && body._keep) })
      .then(function (r) {
        clearTimeout(t);
        return r.json().catch(function () { return null; }).then(function (j) {
          if (!j || typeof j !== "object") return { ok: false, code: "server", error: "Сервер временно недоступен. Попробуйте позже." };
          return j;
        });
      }, function () {
        clearTimeout(t);
        return { ok: false, code: "network", error: "Нет связи с сервером. Проверьте подключение к интернету." };
      });
  }
  var isOffline = function (r) { return r && (r.code === "network" || r.code === "server"); };

  /* ───── устройство и сессия ───── */
  function deviceId() {
    var d = ls("sa-web-device");
    if (!/^[0-9a-f]{32}$/.test(d || "")) { d = rndHex(16); ls("sa-web-device", d); }
    return d;
  }
  function osName() {
    var u = navigator.userAgent || "", s = "Браузер";
    if (/iPhone|iPad|iPod/.test(u)) s += " · iOS";
    else if (/Android/.test(u)) s += " · Android";
    else if (/Windows/.test(u)) s += " · Windows";
    else if (/Mac OS X/.test(u)) s += " · macOS";
    else if (/Linux/.test(u)) s += " · Linux";
    return s;
  }
  var client = function () { return { ver: "web " + (CFG.ver || ""), device: deviceId(), os: osName() }; };

  // «Запомнить меня» → localStorage (60 дней на сервере), иначе только эта вкладка (sessionStorage)
  function session() {
    var j = readJ(ls("sa-web-sess")) || readJ(ss("sa-web-sess"));
    return j && /^[0-9a-f]{64}$/.test(j.token || "") && j.login ? j : null;
  }
  function saveSession(login, token, remember) {
    var rec = JSON.stringify({ login: login, token: token, remember: !!remember });
    if (remember) { ls("sa-web-sess", rec); ss("sa-web-sess", null); } else { ss("sa-web-sess", rec); ls("sa-web-sess", null); }
  }
  function clearSession() { ls("sa-web-sess", null); ss("sa-web-sess", null); }
  function cacheUser(u, extra) {
    if (!u) { ls("sa-web-user", null); return; }
    var c = readJ(ls("sa-web-user")) || {};
    c.user = u; c.at = Date.now();
    if (extra) { if (extra.sys) c.sys = extra.sys; if (extra.web) c.web = extra.web; }
    ls("sa-web-user", JSON.stringify(c));
  }
  function cachedUser(login) {
    var c = readJ(ls("sa-web-user"));
    if (!c || !c.user || String(c.user.login).toLowerCase() !== String(login).toLowerCase()) return null;
    if (Date.now() - (c.at || 0) > OFFLINE_GRACE_DAYS * 864e5) return null;
    return c;
  }
  function notice(t) { if (t === undefined) { var n = ss("sa-web-notice"); ss("sa-web-notice", null); return n || ""; } ss("sa-web-notice", t || null); }
  function toLogin(msg) {
    if (msg) notice(msg);
    var next = location.pathname.indexOf("/app") === 0 && !/\/login/.test(location.pathname) ? location.search + location.hash : "";
    location.replace("/app/login/" + (next && next.length < 300 ? "?next=" + encodeURIComponent(next) : ""));
  }

  /* ───── синхронизация (как sync.js) ───── */
  function canon(v) {
    if (Array.isArray(v)) return "[" + v.map(canon).join(",") + "]";
    if (v && typeof v === "object") return "{" + Object.keys(v).sort().map(function (k) { return JSON.stringify(k) + ":" + canon(v[k]); }).join(",") + "}";
    return JSON.stringify(v === undefined ? null : v);
  }
  // хэш только для сравнения «менялось ли» на этом устройстве: на сервер не уходит
  function hash(v) {
    var str = canon(v), h1 = 0xdeadbeef, h2 = 0x41c6ce57;
    for (var i = 0, ch; i < str.length; i++) { ch = str.charCodeAt(i); h1 = Math.imul(h1 ^ ch, 2654435761); h2 = Math.imul(h2 ^ ch, 1597334677); }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return ("00000000" + (h2 >>> 0).toString(16)).slice(-8) + ("00000000" + (h1 >>> 0).toString(16)).slice(-8) + ":" + str.length.toString(36);
  }
  function parse(str) { if (typeof str !== "string") return undefined; try { return JSON.parse(str); } catch (e) { return undefined; } }
  var isObj = function (v) { return !!v && typeof v === "object" && !Array.isArray(v); };

  function mergeQstat(a, b) {
    var ok = function (x) { return x && typeof x === "object" && x.q && typeof x.q === "object" && x.tp && typeof x.tp === "object"; };
    if (!ok(a)) return ok(b) ? b : { q: {}, tp: {} };
    if (!ok(b)) return a;
    var ea = +a._e || 0, eb = +b._e || 0;
    if (ea !== eb) return ea > eb ? a : b;
    var out = { q: {}, tp: {} };
    if (ea) out._e = ea;
    var pick = function (x, y) { return !x ? y : !y ? x : (+y.a || 0) > (+x.a || 0) || ((+y.a || 0) === (+x.a || 0) && (+y.t || 0) > (+x.t || 0)) ? y : x; };
    var ids = {}, id;
    Object.keys(a.q).concat(Object.keys(b.q)).forEach(function (k) { ids[k] = 1; });
    for (id in ids) out.q[id] = pick(a.q[id], b.q[id]);
    ids = {};
    Object.keys(a.tp).concat(Object.keys(b.tp)).forEach(function (k) { ids[k] = 1; });
    for (id in ids) out.tp[id] = pick(a.tp[id], b.tp[id]);
    return out;
  }
  function mergeDaily(a, b) {
    a = a && typeof a === "object" ? a : { d: "", s: 0, n: 0 }; b = b && typeof b === "object" ? b : { d: "", s: 0, n: 0 };
    if (String(a.d) !== String(b.d)) return String(a.d) > String(b.d) ? a : b;
    return (+b.s || 0) > (+a.s || 0) ? b : a;
  }
  function mergeStreak(a, b) {
    a = a && typeof a === "object" ? a : { last: "", n: 0 }; b = b && typeof b === "object" ? b : { last: "", n: 0 };
    if (String(a.last) !== String(b.last)) return String(a.last) > String(b.last) ? a : b;
    return (+b.n || 0) > (+a.n || 0) ? b : a;
  }
  function mergeFolders(a, b) {
    var ok = function (x) { return Array.isArray(x) ? x.filter(function (f) { return f && typeof f.id === "string"; }) : []; };
    var out = ok(a).map(function (f) { return Object.assign({}, f, { a: Array.isArray(f.a) ? f.a.slice() : [] }); });
    var byId = {};
    out.forEach(function (f) { byId[f.id] = f; });
    ok(b).forEach(function (f) {
      var cur = byId[f.id];
      if (!cur) { var c = Object.assign({}, f, { a: Array.isArray(f.a) ? f.a.slice() : [] }); out.push(c); byId[f.id] = c; return; }
      (Array.isArray(f.a) ? f.a : []).forEach(function (k) { if (cur.a.indexOf(k) < 0) cur.a.push(k); });
    });
    return out;
  }
  var KEYS = {
    "bos-thist": { kind: "thist", list: true, idOf: function (r) { return r.id; }, order: function (r) { return Number(r.end || r.start || r.id) || 0; }, cap: 100 },
    "bos-dlog": { kind: "dlog", list: true, idOf: function (r) { return r.id; }, order: function (r) { return Number(r.id) || 0; }, cap: 40 },
    "bos-tests": { kind: "tests", list: true, idOf: function (r) { return r.t; }, order: function (r) { return Number(r.t) || 0; }, cap: 30 },
    "bos-qstat": { kind: "qstat", merge: mergeQstat, def: { q: {}, tp: {} } },
    "bos-xp": { kind: "xp", merge: function (a, b) { return Math.max(+a || 0, +b || 0); }, def: 0 },
    "bos-daily": { kind: "daily", merge: mergeDaily, def: { d: "", s: 0, n: 0 } },
    "bos-streak": { kind: "streak", merge: mergeStreak, def: { last: "", n: 0 } },
    "bos-favs": { kind: "favs", map: true },
    "bos-notes": { kind: "notes", map: true },
    "bos-labels": { kind: "labels", map: true },
    "bos-folders": { kind: "folders", lww: true, merge: mergeFolders, def: [] },
    "bos-favorder": { kind: "favorder", lww: true, merge: function (a, b) { return Array.isArray(a) && a.length ? a : b; }, def: [] }
  };
  var KEY_LIST = Object.keys(KEYS), KV_ID = "1";

  function createSync(authed) {
    var login = "", state = null, foreign = false, remote = null, latest = {}, liveKeys = {}, timer = null, pushing = null;
    var status = { at: 0, ok: null, offline: false, error: "" };
    var stKey = function () { return "sa-web-sync-" + String(login).toLowerCase(); };
    var save = function () { if (state) ls(stKey(), JSON.stringify(state)); };
    var onAuthLost = null;
    function fail(r) {
      status.ok = false;
      if (r && (r.code === "network" || r.code === "server")) { status.offline = true; status.error = ""; }
      else {
        status.offline = false; status.error = (r && r.error) || "Ошибка синхронизации.";
        if (r && (r.code === "auth" || r.code === "banned") && onAuthLost) onAuthLost(r);
      }
    }
    function good() { status.ok = true; status.offline = false; status.error = ""; status.at = Date.now(); }

    function begin(name) {
      login = String(name);
      var owner = (readJ(ls("sa-web-sync-owner")) || {}).login;
      foreign = !!owner && owner.toLowerCase() !== login.toLowerCase();
      state = readJ(ls(stKey()));
      if (!state || !state.snap) state = { device: rndHex(8), cursor: 0, snap: {} };
      if (foreign) { state.cursor = 0; state.snap = {}; }
      remote = null; latest = {}; liveKeys = {};
    }
    function prefetch() {
      if (!state) return Promise.resolve(null);
      var items = [], cursor = state.cursor, i = 0;
      function step() {
        return authed({ action: "sync", device: state.device, pull: true, since: cursor, items: [] }).then(function (r) {
          if (!r || !r.ok) { fail(r); return null; }
          items.push.apply(items, r.items || []);
          cursor = r.cursor;
          if (r.more && ++i < 20) return step();
          good();
          remote = { items: items, cursor: cursor };
          return remote;
        });
      }
      return step();
    }
    // local — строки из localStorage; возвращает {values}: что записать (null — удалить)
    function startup(local) {
      if (!state) return null;
      var values = {}, loc = {};
      KEY_LIST.forEach(function (k) { loc[k] = foreign ? undefined : parse(local && local[k]); });
      if (foreign && local) {
        try { ls("sa-web-foreign-" + ((readJ(ls("sa-web-sync-owner")) || {}).login || "unknown"), JSON.stringify(local)); } catch (e) {}
      }
      var byKind = {};
      if (remote) remote.items.forEach(function (it) { (byKind[it.kind] = byKind[it.kind] || {})[it.id] = it; });
      KEY_LIST.forEach(function (k) {
        var cfg = KEYS[k], rem = byKind[cfg.kind] || {}, snap = (state.snap[cfg.kind] = state.snap[cfg.kind] || {}), out;
        if (cfg.list) {
          var arr = Array.isArray(loc[k]) ? loc[k].filter(function (r) { return r && typeof r === "object" && cfg.idOf(r) != null; }) : [];
          var map = new Map(), modified = {};
          arr.forEach(function (r) { var id = String(cfg.idOf(r)); map.set(id, r); if (!snap[id] || snap[id].h !== hash(r)) modified[id] = 1; });
          Object.keys(rem).forEach(function (id) {
            var it = rem[id];
            if (it.del) { if (map.has(id) && !modified[id]) map.delete(id); if (!map.has(id)) delete snap[id]; return; }
            if (!it.data || typeof it.data !== "object") return;
            if (map.has(id) && modified[id]) return;
            map.set(id, it.data);
            snap[id] = { h: hash(it.data), o: cfg.order(it.data) };
          });
          var res = Array.from(map.values()).sort(function (a, b) { return cfg.order(b) - cfg.order(a); });
          if (res.length > cfg.cap) res.length = cfg.cap;
          out = res;
          if (!res.length && foreign) out = undefined;
        } else if (cfg.map) {
          var obj = isObj(loc[k]) ? Object.assign({}, loc[k]) : {}, mod = {};
          Object.keys(obj).forEach(function (id) { if (!snap[id] || snap[id].h !== hash(obj[id])) mod[id] = 1; });
          Object.keys(rem).forEach(function (id) {
            var it = rem[id];
            if (it.del) { if (id in obj && !mod[id]) delete obj[id]; if (!(id in obj)) delete snap[id]; return; }
            if (!isObj(it.data) || !("v" in it.data)) return;
            if (id in obj && mod[id]) return;
            obj[id] = it.data.v;
            snap[id] = { h: hash(it.data.v) };
          });
          out = Object.keys(obj).length || isObj(loc[k]) ? obj : undefined;
        } else {
          var r = rem[KV_ID], serverVal = r && !r.del ? r.data : undefined, lv = loc[k], merged;
          if (serverVal === undefined) merged = lv;
          else if (lv === undefined) merged = serverVal;
          else if (cfg.lww && snap[KV_ID]) merged = hash(lv) === snap[KV_ID].h ? serverVal : lv;
          else merged = cfg.merge(lv, serverVal);
          if (serverVal !== undefined) snap[KV_ID] = { h: hash(serverVal) };
          out = merged;
        }
        var prev = local ? local[k] : undefined;
        if (out === undefined) { if (prev != null && foreign) values[k] = null; }
        else { var str = JSON.stringify(out); if (str !== prev) values[k] = str; latest[k] = str; }
        if (!(k in latest) && prev != null && !foreign) latest[k] = prev;
      });
      if (remote) { state.cursor = remote.cursor; remote = null; }
      ls("sa-web-sync-owner", JSON.stringify({ login: login }));
      foreign = false;
      save();
      return { values: values };
    }
    function buildItems() {
      var items = [], apply = [], t = Date.now();
      KEY_LIST.forEach(function (k) {
        if (!(k in latest)) return;
        var cfg = KEYS[k], v = parse(latest[k]), snap = state.snap[cfg.kind] || {};
        if (cfg.list) {
          var arr = Array.isArray(v) ? v.filter(function (r) { return r && typeof r === "object" && cfg.idOf(r) != null; }) : [];
          var seen = {}, minOrder = Infinity;
          arr.forEach(function (r) {
            var id = String(cfg.idOf(r)), h = hash(r);
            seen[id] = 1; minOrder = Math.min(minOrder, cfg.order(r));
            if (!snap[id] || snap[id].h !== h) { items.push({ kind: cfg.kind, id: id, data: r, u: t }); apply.push({ kind: cfg.kind, id: id, h: h, o: cfg.order(r) }); }
          });
          Object.keys(snap).forEach(function (id) {
            if (seen[id]) return;
            var o = snap[id].o || 0, cleared = !arr.length && liveKeys[k];
            if (cleared || (arr.length && o > minOrder)) { items.push({ kind: cfg.kind, id: id, u: t, del: true }); apply.push({ kind: cfg.kind, id: id, del: true }); }
            else if (arr.length) apply.push({ kind: cfg.kind, id: id, del: true, silent: true });
          });
        } else if (cfg.map) {
          if (!isObj(v)) return;
          Object.keys(v).forEach(function (id) {
            if (String(id).length > 40) return;
            var h = hash(v[id]);
            if (!snap[id] || snap[id].h !== h) { items.push({ kind: cfg.kind, id: id, data: { v: v[id] }, u: t }); apply.push({ kind: cfg.kind, id: id, h: h }); }
          });
          Object.keys(snap).forEach(function (id) {
            if (id in v) return;
            items.push({ kind: cfg.kind, id: id, u: t, del: true }); apply.push({ kind: cfg.kind, id: id, del: true });
          });
        } else if (v !== undefined) {
          var h = hash(v), cur = snap[KV_ID], isDef = h === hash(cfg.def);
          if ((!cur && !isDef) || (cur && cur.h !== h)) { items.push({ kind: cfg.kind, id: KV_ID, data: v, u: t }); apply.push({ kind: cfg.kind, id: KV_ID, h: h }); }
        }
      });
      return { items: items, apply: apply };
    }
    function commit(apply) {
      apply.forEach(function (a) {
        var snap = (state.snap[a.kind] = state.snap[a.kind] || {});
        if (a.del) delete snap[a.id]; else snap[a.id] = { h: a.h, o: a.o };
      });
      save();
    }
    function pushNow(keep) {
      if (!state || !login) return Promise.resolve({ ok: false });
      clearTimeout(timer); timer = null;
      if (pushing) return pushing.then(function () { return pushNow(keep); });
      var b = buildItems(), items = b.items;
      if (!items.length) return Promise.resolve({ ok: true, sent: 0 });
      var chunks = [];
      for (var i = 0; i < items.length; i += 200) chunks.push(items.slice(i, i + 200));
      var n = 0;
      function next() {
        if (n >= chunks.length) { commit(b.apply); good(); return { ok: true, sent: items.length }; }
        var body = { action: "sync", device: state.device, items: chunks[n++] };
        if (keep) body._keep = 1;
        return authed(body).then(function (r) { if (!r || !r.ok) { fail(r); return { ok: false }; } return next(); });
      }
      pushing = next().then(function (r) { pushing = null; return r; }, function () { pushing = null; return { ok: false }; });
      return pushing;
    }
    function noteLocal(map) {
      if (!state || !map) return;
      Object.keys(map).forEach(function (k) {
        if (!KEYS[k]) return;
        if (map[k] == null) delete latest[k]; else latest[k] = String(map[k]);
        liveKeys[k] = 1;
      });
      clearTimeout(timer);
      timer = setTimeout(function () { pushNow(); }, 5000);
    }
    function resetState() {
      if (!state) return;
      clearTimeout(timer); timer = null;
      state.device = rndHex(8); state.cursor = 0; state.snap = {};
      remote = null; latest = {}; liveKeys = {};
      save();
    }
    return {
      KEY_LIST: KEY_LIST, begin: begin, prefetch: prefetch, startup: startup, noteLocal: noteLocal, pushNow: pushNow, resetState: resetState,
      status: function () { return Object.assign({}, status, { pending: state ? buildItems().items.length : 0 }); },
      hasState: function () { return !!state; },
      onAuthLost: function (f) { onAuthLost = f; }
    };
  }

  /* ───── IndexedDB: законы и прочее крупное ───── */
  var idbP = null;
  function idb() {
    if (idbP) return idbP;
    idbP = new Promise(function (ok, no) {
      if (!window.indexedDB) { no(new Error("no idb")); return; }
      var r = indexedDB.open("senko-web", 1);
      r.onupgradeneeded = function () { r.result.createObjectStore("kv"); };
      r.onsuccess = function () { ok(r.result); };
      r.onerror = function () { no(r.error); };
    });
    idbP.catch(function () { idbP = null; });
    return idbP;
  }
  function idbGet(k) {
    return idb().then(function (d) {
      return new Promise(function (ok) { var q = d.transaction("kv").objectStore("kv").get(k); q.onsuccess = function () { ok(q.result); }; q.onerror = function () { ok(undefined); }; });
    }).catch(function () { return undefined; });
  }
  function idbSet(k, v) {
    return idb().then(function (d) {
      return new Promise(function (ok) { var tx = d.transaction("kv", "readwrite"); tx.objectStore("kv").put(v, k); tx.oncomplete = function () { ok(true); }; tx.onerror = function () { ok(false); }; });
    }).catch(function () { return false; });
  }
  function idbDel(k) {
    return idb().then(function (d) {
      return new Promise(function (ok) { var tx = d.transaction("kv", "readwrite"); tx.objectStore("kv").delete(k); tx.oncomplete = function () { ok(true); }; tx.onerror = function () { ok(false); }; });
    }).catch(function () { return false; });
  }
  function gunzipB64(b64) {
    var bin = atob(b64), u = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
    return new Response(new Blob([u]).stream().pipeThrough(new DecompressionStream("gzip"))).text();
  }

  window.SenkoWeb = {
    CFG: CFG, ls: ls, ss: ss, readJ: readJ, call: call, isOffline: isOffline, client: client, deviceId: deviceId,
    session: session, saveSession: saveSession, clearSession: clearSession, cacheUser: cacheUser, cachedUser: cachedUser,
    notice: notice, toLogin: toLogin, createSync: createSync, SYNC_KEYS: KEY_LIST,
    idbGet: idbGet, idbSet: idbSet, idbDel: idbDel, gunzipB64: gunzipB64, canGunzip: typeof DecompressionStream === "function",
    GRACE_DAYS: OFFLINE_GRACE_DAYS
  };
})();
