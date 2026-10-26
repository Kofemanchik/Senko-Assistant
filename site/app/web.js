/* Senko Assistant · веб-версия: мост window.senkoApp для страницы помощника (то же, что preload.js в программе).
   Скрипты страницы tools/build-site.js помечает type="text/x-senko": они запускаются здесь, когда готовы
   вход, данные аккаунта и законы, — как в программе, где всё это делается до открытия окна. */
(function () {
  "use strict";
  var W = window.SenkoWeb, CFG = W.CFG;
  var sess = W.session();
  if (!sess) { W.toLogin(); return; }

  var DEPTS = ["Government", "LSPD", "LSCSD", "FIB", "SANG"];
  var SERVERS = [{ id: 12, name: "Boston" }, { id: 7, name: "Los Angeles" }, { id: 16, name: "Denver" }]; // как SERVERS в серверной функции
  var root = document.documentElement;

  /* ───── заставка, пока готовятся данные ───── */
  var dk = false;
  try { var th = (JSON.parse(localStorage.getItem("bos-settings") || "{}") || {}).theme || "auto"; dk = th === "dark" || (th !== "light" && matchMedia("(prefers-color-scheme: dark)").matches); } catch (e) {}
  var spl = document.createElement("div");
  spl.id = "sawSplash";
  spl.innerHTML = '<style>#sawSplash{position:fixed;inset:0;z-index:2147483646;display:grid;place-items:center;background:' + (dk ? "#0A0A0B" : "#F6F3EE") + ';color:' + (dk ? "#ECE7E1" : "#1F1A15") +
    ';font:500 14px/1.4 "IBM Plex Sans",system-ui,-apple-system,"Segoe UI",sans-serif;transition:opacity .25s}#sawSplash.out{opacity:0;pointer-events:none}' +
    '#sawSplash .b{display:grid;justify-items:center;gap:14px;text-align:center;padding:24px}#sawSplash img{width:64px;height:64px;border-radius:16px;animation:sawP 1.6s ease-in-out infinite}' +
    '#sawSplash small{opacity:.65;min-height:1.4em}#sawSplash button{font:inherit;border:1px solid currentColor;background:none;color:inherit;border-radius:10px;padding:8px 14px;cursor:pointer}' +
    '@keyframes sawP{50%{transform:scale(.92);opacity:.8}}@media (prefers-reduced-motion:reduce){#sawSplash img{animation:none}}</style>' +
    '<div class="b"><img src="/img/logo-mark.svg" alt=""><b>Senko Assistant</b><small id="sawStep">Входим в аккаунт…</small></div>';
  root.appendChild(spl);
  function step(t) { var s = document.getElementById("sawStep"); if (s) s.textContent = t; }

  /* ───── состояние ───── */
  var user = null, sys = null, feat = { laws: false, ai: false }, offline = false, lastOk = Date.now();
  var LAWS = null, lawsErr = "", lawsRunning = false, lawsRemote = null;
  var listeners = [], openListeners = [], lawsListeners = [];
  var errLog = [];
  window.addEventListener("error", function (e) { errLog.push(new Date().toISOString().slice(11, 19) + " " + String((e && e.message) || e).slice(0, 300)); if (errLog.length > 40) errLog.shift(); });

  function authed(body) {
    var s = W.session();
    if (!s) return Promise.resolve({ ok: false, code: "auth", error: "Нужно войти в аккаунт." });
    return W.call(Object.assign({}, body, { token: s.token }));
  }
  var sync = W.createSync(authed);
  sync.onAuthLost(function (r) { lost(r && r.code === "banned" ? r.error : ""); });
  function lost(msg) {
    if (lost.done) return; lost.done = true;
    W.clearSession(); W.cacheUser(null);
    W.toLogin(msg || "Сессия завершена. Войдите заново.");
  }

  function pubUser() { return user ? Object.assign({}, user, { offline: offline }) : null; }
  function cfg() {
    var np = "Notification" in window ? Notification.permission : "denied";
    return {
      alwaysOnTop: false, hotkeyEnabled: false, hotkey: "", compact: false, rememberBounds: false, opacity: 100, tray: false, notify: np === "granted",
      ghost: false, ghostOpacity: 60, voiceEnabled: false, voiceHotkey: "", voiceOpacity: 100, voiceMode: "", ghostBy: "blur", strip: 0, snap: false,
      watchApps: [], watchMode: "fade", watchOpacity: 25, streamAuto: false
    };
  }
  // 2.7: бета-сборку видят как бету только тестеры; остальным показываем номер последней обычной версии
  function shownVer(u) {
    var t = !!((sys && sys.tester) || (u && (u.rank === "owner" || u.rank === "moderator")));
    return (!t && CFG.stable) || CFG.ver || "";
  }
  function getState() {
    var u = pubUser();
    return {
      cfg: cfg(), win: { stream: [], profiles: [], profile: "" }, platform: "web", web: true, autostart: false,
      sync: sync.status(), hotkeyError: "", packaged: true, version: shownVer(u), dataVersion: CFG.ver || "",
      depts: DEPTS.slice(), servers: SERVERS.slice(), shareUrl: CFG.api, sys: sys,
      user: u ? { login: u.login, nick: u.nick, static: u.static, discord: u.discord, telegram: u.telegram, phone: u.phone, role: u.role, roleName: u.roleName, org: u.org, rank: u.rank, rankName: u.rankName, offline: !!u.offline } : null
    };
  }
  function pushState() { var s = getState(); listeners.slice().forEach(function (f) { try { f(s); } catch (e) {} }); }

  /* ───── аккаунт ───── */
  function takeMe(r) {
    user = r.user; sys = r.sys || sys; if (r.web) feat = r.web;
    offline = false; lastOk = Date.now();
    W.cacheUser(r.user, { sys: r.sys, web: r.web });
  }
  function me() { return W.call(Object.assign({ action: "me", token: (W.session() || {}).token }, W.client()), 12000); }
  function verify() {
    if (!W.session()) return Promise.resolve({ ok: false });
    var before = JSON.stringify([user, sys]);
    return me().then(function (r) {
      if (r.ok && r.user && r.user.needLegal) { lost("Обновились Политика конфиденциальности и Условия пользования. Войдите и примите их."); return { ok: false }; }
      if (r.ok) { var was = offline; takeMe(r); if (was || JSON.stringify([user, sys]) !== before) pushState(); return { ok: true }; }
      if (W.isOffline(r)) {
        if (!offline) { offline = true; pushState(); }
        if (Date.now() - lastOk > W.GRACE_DAYS * 864e5) lost("Давно не было связи с сервером. Подключитесь к интернету и войдите заново.");
        return { ok: true, offline: true };
      }
      lost(r.code === "banned" ? r.error : "");
      return { ok: false };
    });
  }

  /* ───── данные: изменения страницы уходят в синхронизацию ───── */
  function syncSnap() { var o = {}; W.SYNC_KEYS.forEach(function (k) { var v = W.ls(k); if (v != null) o[k] = v; }); return o; }
  var syncLast = null;
  function flushSync() {
    if (!syncLast) return;
    var cur = syncSnap(), ch = {}, any = false;
    W.SYNC_KEYS.forEach(function (k) { if (cur[k] !== syncLast[k]) { ch[k] = cur[k] === undefined ? null : cur[k]; any = true; } });
    syncLast = cur;
    if (any) sync.noteLocal(ch);
  }

  /* ───── законы ───── */
  /* 2.9: у каждого сервера свои законы; Boston хранится под прежним ключом "laws" */
  var LAWS_MISSING = false;
  function srvNum() { var n = parseInt(user && user.server, 10); return n > 0 ? n : 12; }
  function lawsKey() { return srvNum() === 12 ? "laws" : "laws-" + srvNum(); }
  function lawsView() {
    var d = LAWS || { updatedAt: 0, checkedAt: 0, laws: [], changes: [] };
    var checked = (lawsRemote && lawsRemote.checkedAt) || d.checkedAt || 0, warn = "";
    if (LAWS_MISSING && !LAWS) warn = "Законы сервера " + srvNum() + " ещё не собраны с форума, пока показаны законы Boston. Как только их соберут, они появятся здесь.";
    else if (!feat.laws && !LAWS) warn = "На сайте пока только встроенные кодексы: законы с форума появятся, когда владелец подключит их на сервере.";
    else if (checked && Date.now() - checked > 3 * 864e5) warn = "Сервер давно не проверял форум (последняя проверка: " + new Date(checked).toLocaleString("ru-RU") + "). Автообновление законов могло остановиться — сообщите владельцу.";
    else if (lawsRemote && lawsRemote.srcOk === false) warn = "Последняя проверка форума на сервере прошла с ошибкой. Показаны ранее загруженные данные.";
    return Object.assign({}, d, { server: srvNum(), missing: LAWS_MISSING && !LAWS, checkedAt: checked, running: lawsRunning, auth: false, warn: warn, status: lawsErr ? { ok: false, error: lawsErr } : { ok: true, failed: 0 } });
  }
  function lawsEmit(ev) { lawsListeners.slice().forEach(function (f) { try { f(ev); } catch (e) {} }); }
  function lawsFetch() {
    if (lawsRunning) return Promise.resolve(lawsView());
    if (!feat.laws) return Promise.resolve(lawsView());
    lawsRunning = true;
    lawsEmit({ type: "progress", progress: { phase: "list", done: 0 } });
    var before = LAWS, forSrv = srvNum(), key = lawsKey();
    return authed({ action: "laws", server: forSrv, sig: (LAWS && LAWS.sig) || "", plain: !W.canGunzip }).then(function (r) {
      if (r && !r.ok && r.code === "laws_none") { LAWS_MISSING = true; return null; }
      if (!r || !r.ok) throw new Error((r && r.error) || "нет ответа");
      if (forSrv !== srvNum()) return null; // сервер сменили во время загрузки
      LAWS_MISSING = false;
      lawsRemote = r;
      if (r.same) return null;
      return (r.data ? Promise.resolve(r.data) : W.gunzipB64(r.gz).then(JSON.parse)).then(function (j) {
        if (!j || !Array.isArray(j.laws) || !j.laws.length) throw new Error("файл законов пустой");
        if (!j.sig) j.sig = r.sig;
        LAWS = j;
        return W.idbSet(key, j).then(function () { return j; });
      });
    }).then(function (j) {
      lawsErr = ""; lawsRunning = false;
      var changed = !!j && (!before || before.sig !== j.sig || before.updatedAt !== j.updatedAt);
      var seenAt = before ? before.updatedAt || 0 : 0, ch = j ? (j.changes || []).filter(function (c) { return c.at > seenAt; }) : [];
      lawsEmit({ type: "done", info: { notify: changed && !!before && ch.length > 0, changed: changed, changes: ch } });
      if (changed && before && ch.length) notify("Законодательство обновлено", "Изменений: " + ch.length + ". Откройте раздел «Законы» — изменённые статьи помечены.");
      return lawsView();
    }, function (e) {
      lawsErr = "Не удалось получить законы: " + ((e && e.message) || e); lawsRunning = false;
      lawsEmit({ type: "done", info: { notify: false, changed: false, changes: [] } });
      return lawsView();
    });
  }

  /* ───── уведомления ───── */
  function notify(title, body) {
    try {
      if (!("Notification" in window) || Notification.permission !== "granted") return;
      if (document.visibilityState === "visible" && document.hasFocus()) return; // вкладка перед глазами: хватит баннера на странице
      var opt = { body: String(body || ""), icon: "/apple-touch-icon.png", badge: "/favicon.svg", tag: "senko-" + String(title).slice(0, 20) };
      if (navigator.serviceWorker && navigator.serviceWorker.controller) navigator.serviceWorker.ready.then(function (r) { r.showNotification(String(title), opt); });
      else new Notification(String(title), opt);
    } catch (e) {}
  }

  /* ───── ИИ ───── */
  var CREATOR_ANSWERS = [
    "Прости, о своём создателе я говорить не могу. 🦊 Давай лучше вернёмся к законам Majestic RP.",
    "Это тайна, которую я хранить обязана: о своём создателе не рассказываю. Спроси меня лучше про статьи или штрафы.",
    "О моём создателе ничего не скажу, даже не уговаривай. 🦊 Чем помочь по законам?"
  ];
  var LOOKALIKE = { a: "а", c: "с", e: "е", o: "о", p: "р", x: "х", y: "у", k: "к", m: "м", t: "т", b: "в", h: "н" };
  var CREATOR_RE = [
    /hanami|hanamy|hanamii|ханам[иіыуоа]|ханамк|ханамоч|ханамуш|ханамчик/,
    /kofemanchik|kofemanch|кофеманчик/,
    /(твой|твоего|твоему|твоим|твоем|твоя|твоей|программы|приложения|памятки|сенко|senko)\s+(создател|разработчик|автор|владел|хозя)/,
    /(создател|разработчик|автор|владел|хозя)\S*\s+(программ|приложени|памятк|сенко|senko|бота|тебя)/
  ];
  var WHO_MADE = [/(^|[^а-я])(кто|чей|чья|чье)([^а-я]|$)/, /созда|сдела|написа|разработа|придума/, /тебя|тебе|эт\S* (программ|приложени)|памятк|сенко|senko|бота|ассистент/];
  function aboutCreator(q) {
    var low = String(q || "").toLowerCase().replace(/ё/g, "е");
    var lk = function (t) { return t.replace(/[a-z]/g, function (ch) { return LOOKALIKE[ch] || ch; }); };
    var glued = /(?:^|[^a-zа-я])[a-zа-я](?:[\s.\-_*]+[a-zа-я]){3,}/.test(low) ? low.replace(/[\s.\-_*]+/g, "") : "";
    if ([low, lk(low), glued, lk(glued)].some(function (t) { return t && CREATOR_RE.some(function (re) { return re.test(t); }); })) return true;
    return low.split(/[.!?\n]+/).some(function (part) { return WHO_MADE.every(function (re) { return re.test(part); }); });
  }
  var aiBusy = false, aiLast = 0, creatorTurn = 0, aiLogs = {}, aiSeq = 0;
  function aiAsk(question, opts) {
    question = String(question || "").replace(/\s+/g, " ").trim().slice(0, 500);
    if (question.length < 3) return Promise.resolve({ ok: false, error: "Напишите вопрос подробнее." });
    if (aboutCreator(question)) return Promise.resolve({ ok: true, answer: CREATOR_ANSWERS[creatorTurn++ % CREATOR_ANSWERS.length], left: null, cached: false, sources: [], fid: "" });
    // 2.3: номер статьи без кодекса и «какие законы знаешь» — ответ из памятки, без ИИ и без лимита
    var loc = null;
    try { loc = typeof window.__senkoAiLocal === "function" ? window.__senkoAiLocal(question) : null; } catch (e) { loc = null; }
    if (loc && loc.answer) return Promise.resolve({ ok: true, answer: String(loc.answer), left: null, cached: false, local: true, sources: (loc.sources || []).slice(0, 10), fid: "" });
    if (!feat.ai) return Promise.resolve({ ok: false, error: "ИИ-помощник на сайте ещё не подключён. Он работает в программе для Windows." });
    if (aiBusy) return Promise.resolve({ ok: false, error: "Предыдущий вопрос ещё обрабатывается." });
    if (Date.now() - aiLast < 2500) return Promise.resolve({ ok: false, error: "Подождите пару секунд перед следующим вопросом." });
    aiBusy = true; aiLast = Date.now();
    var found = [];
    try { found = typeof window.__senkoAiContext === "function" ? window.__senkoAiContext(question) || [] : []; } catch (e) { found = []; }
    return Promise.resolve(found).then(function (f) {
      found = (Array.isArray(f) ? f : []).slice(0, 10);
      var sources = found.map(function (x) { return { ref: x.ref, go: x.go || "", lw: x.lw || "" }; });
      return W.call({ action: "ai_ask", token: (W.session() || {}).token, q: question, short: !!(opts && opts.short), ctx: found.map(function (x) { return { ref: String(x.ref || ""), text: String(x.text || "") }; }) }, 45000).then(function (r) {
        aiBusy = false;
        if (!r || !r.ok) return { ok: false, error: (r && r.error) || "ИИ-сервис вернул ошибку.", limit: !!(r && r.limit), sources: sources };
        var fid = "";
        if (r.logId) { fid = String(++aiSeq); aiLogs[fid] = r.logId; }
        return { ok: true, answer: String(r.answer || ""), left: typeof r.left === "number" ? r.left : null, bonus: typeof r.bonus === "number" ? r.bonus : null, cached: !!r.cached, sources: sources, fid: fid };
      });
    }).catch(function () { aiBusy = false; return { ok: false, error: "Не удалось связаться с ИИ-сервисом. Проверьте подключение к интернету." }; });
  }
  function aiVote(fid, v) {
    v = v === 1 || v === -1 ? v : 0;
    var id = aiLogs[String(fid)];
    if (!v || !id) return Promise.resolve({ ok: false, error: "Оценка недоступна." });
    return authed({ action: "ai_vote", id: id, vote: v }).then(function (r) { return r && r.ok ? { ok: true } : { ok: false, error: (r && r.error) || "Не удалось сохранить оценку." }; });
  }

  /* ───── установка как приложение (PWA) ───── */
  var installEvt = null;
  window.addEventListener("beforeinstallprompt", function (e) { e.preventDefault(); installEvt = e; pushState(); });
  window.addEventListener("appinstalled", function () { installEvt = null; pushState(); });
  var standalone = function () { return (window.matchMedia && matchMedia("(display-mode: standalone)").matches) || navigator.standalone === true; };
  function installHint() {
    var u = navigator.userAgent || "";
    if (/iPhone|iPad|iPod/.test(u)) return "В Safari нажмите «Поделиться» и выберите «На экран „Домой“».";
    if (/Android/.test(u)) return "В меню браузера выберите «Установить приложение» или «Добавить на главный экран».";
    return "В Chrome или Edge нажмите значок установки в адресной строке или «Установить» в меню браузера.";
  }
  if ("serviceWorker" in navigator && location.protocol === "https:") navigator.serviceWorker.register("/app/sw.js", { scope: "/app/" }).catch(function () {});

  /* ───── файлы ───── */
  function download(name, text) {
    var a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([text], { type: "application/json" }));
    a.download = name; document.body.appendChild(a); a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }
  function pickFile() {
    return new Promise(function (ok) {
      var i = document.createElement("input");
      i.type = "file"; i.accept = ".json,application/json"; i.style.display = "none";
      i.onchange = function () {
        var f = i.files && i.files[0]; i.remove();
        if (!f) { ok({ ok: false, canceled: true }); return; }
        if (f.size > 20 * 1024 * 1024) { ok({ ok: false, error: "Файл слишком большой." }); return; }
        var fr = new FileReader();
        fr.onload = function () { ok({ ok: true, text: String(fr.result || "").replace(/^﻿/, "") }); };
        fr.onerror = function () { ok({ ok: false, error: "Не удалось прочитать файл." }); };
        fr.readAsText(f, "utf-8");
      };
      document.body.appendChild(i); i.click();
    });
  }
  function clearLocal() {
    var del = [];
    try { for (var i = 0; i < localStorage.length; i++) { var k = localStorage.key(i); if (k && (k.indexOf("bos-") === 0 || k === "sa-dets" || k === "sa-artedits")) del.push(k); } } catch (e) {}
    del.forEach(function (k) { W.ls(k, null); });
  }

  var PAGE_ACTIONS = ["my_stats", "week_board", "shift", "ctrl", "reports", "share", "xfer", "misses", "contacts", "logins", "change_password", "verify_password", "ads", "status", "beta", "hooks", "events", "ideas", "patrol", "ai_dict", "ai_hist", "ai_check", "colleagues", "handoff"]; // 2.7: словарь ИИ, история вопросов, самопроверка; 2.8: коллеги, передача задержанного
  function act(action, data) {
    return W.call(Object.assign({}, W.client(), data && typeof data === "object" ? data : {}, { action: action, token: (W.session() || {}).token })).then(function (r) {
      if (r && (r.code === "auth" || r.code === "banned")) setTimeout(function () { lost(r.code === "banned" ? r.error : ""); }, 0);
      return r;
    });
  }

  /* ───── мост ───── */
  var openArg = "";
  try { var qa = new URLSearchParams(location.search); openArg = qa.get("open") || ""; if (openArg) history.replaceState(null, "", location.pathname + location.hash); } catch (e) {}

  window.senkoApp = {
    web: {
      canInstall: function () { return !!installEvt; },
      installed: standalone,
      installHint: installHint,
      install: function () { if (!installEvt) return Promise.resolve(false); var e = installEvt; installEvt = null; e.prompt(); return (e.userChoice || Promise.resolve()).then(function () { return true; }); },
      notifyState: function () { return "Notification" in window ? Notification.permission : "none"; },
      enableNotify: function () { return "Notification" in window ? Promise.resolve(Notification.requestPermission()).then(function () { pushState(); }) : Promise.resolve(); }
    },
    ai: { ask: aiAsk, available: function () { return !!feat.ai; }, vote: aiVote },
    state: getState,
    set: function (key) {
      if (key === "notify") { if ("Notification" in window && Notification.permission === "default") Notification.requestPermission().then(pushState); return { ok: true, state: getState() }; }
      return { ok: false, error: "Эта настройка есть только в программе для Windows.", state: getState() };
    },
    session: function () { var u = pubUser(); if (u) u.seeded = W.ls("sa-web-seeded-" + String(u.login).toLowerCase()) === "1"; return u; },
    seeded: function () { if (user) W.ls("sa-web-seeded-" + String(user.login).toLowerCase(), "1"); },
    notify: function (t, b) { notify(t, b); },
    logout: function () {
      var s = W.session();
      sync.pushNow(true).then(function () {
        if (s) W.call({ action: "logout", token: s.token }, 5000);
        W.clearSession(); W.cacheUser(null);
        location.replace("/app/login/");
      });
    },
    syncNow: function () {
      return sync.pushNow().then(function () { return sync.prefetch(); }).then(function (r) {
        if (r && r.items.length) { setTimeout(function () { location.reload(); }, 50); return { ok: true, changed: true }; }
        pushState();
        var st = sync.status();
        return { ok: !!r, changed: false, error: r ? "" : st.offline ? "Нет связи с сервером." : st.error || "Не удалось синхронизировать." };
      });
    },
    staffList: function () { return act("staff_list", {}); },
    exportData: function (text) { download("senko-export-" + new Date().toISOString().slice(0, 10) + ".json", String(text || "")); return Promise.resolve({ ok: true, file: "загрузки браузера" }); },
    importData: pickFile,
    resetData: function (d) {
      var p = d && d.account ? act("sync_reset", {}) : Promise.resolve({ ok: true });
      return p.then(function (r) {
        if (!r || !r.ok) return r || { ok: false, error: "Не удалось очистить данные в аккаунте." };
        clearLocal(); sync.resetState(); syncLast = syncSnap();
        return { ok: true };
      });
    },
    syncRebase: function () { sync.resetState(); return Promise.resolve({ ok: true }); },
    api: function (action, data) { return PAGE_ACTIONS.indexOf(String(action)) < 0 ? Promise.resolve({ ok: false, error: "Недоступно." }) : act(String(action), data); },
    updateProfile: function (d) {
      d = d || {};
      var c = function (s, m) { return String(s == null ? "" : s).replace(/[\u0000-\u001f]/g, " ").trim().slice(0, m); };
      return act("update_profile", { nick: c(d.nick, 40), static: c(d.static, 12), discord: c(d.discord, 40), telegram: c(d.telegram, 60), phone: c(d.phone, 20), org: c(d.org, 60), server: c(d.server, 4) }).then(function (r) {
        if (r && r.ok && r.user) {
          var was = srvNum();
          user = r.user; W.cacheUser(r.user); pushState();
          // сервер сменился: другие законы и таблицы кодексов, поэтому страницу перезагружаем
          if (srvNum() !== was) setTimeout(function () { location.reload(); }, 400);
        }
        return r;
      });
    },
    bug: function (text, log, shot) {
      var img = typeof shot === "string" && /^data:image\/(jpeg|png);base64,/.test(shot) && shot.length <= 680000 ? shot : "";
      var d = { action: "bug_report", token: (W.session() || {}).token, text: String(text || "").slice(0, 2000), ver: "web " + (CFG.ver || ""), log: typeof log === "string" ? log.slice(0, 60000) : "" };
      if (img) d.shot = img;
      return W.call(d);
    },
    diagLog: function () {
      var st = sync.status();
      return Promise.resolve([
        "Senko Assistant · сайт " + (CFG.ver || ""),
        "Браузер: " + navigator.userAgent,
        "Экран: " + screen.width + "×" + screen.height + ", окно " + innerWidth + "×" + innerHeight + ", масштаб " + (window.devicePixelRatio || 1),
        "Как приложение: " + (standalone() ? "да" : "нет"),
        "Синхронизация: " + (st.ok ? "в порядке" : st.offline ? "нет связи" : st.error || "—") + (st.pending ? ", ждут отправки " + st.pending : ""),
        "Законы: " + (LAWS ? (LAWS.laws || []).length + " шт., версия " + (LAWS.updatedAt ? new Date(LAWS.updatedAt).toISOString() : "—") : "только встроенные") + (lawsErr ? " (" + lawsErr + ")" : ""),
        "Ошибки страницы:", errLog.length ? errLog.join("\n") : "нет"
      ].join("\n"));
    },
    openArg: function () { var v = openArg; openArg = ""; return v; },
    onOpen: function (f) { if (typeof f === "function") openListeners.push(f); },
    recheck: function () { return verify().then(function () { return getState(); }); },
    restart: function () { location.reload(); },
    copy: function (text) { text = String(text || "").slice(0, 200); try { navigator.clipboard.writeText(text); } catch (e) {} },
    onChange: function (f) { if (typeof f === "function") listeners.push(f); },
    laws: {
      get: function () { return Promise.resolve(lawsView()); },
      getSync: function () { return LAWS; },
      sync: lawsFetch,
      debug: function () {},
      diag: function () {
        return Promise.resolve([
          "Источник: сервер Senko Assistant (сайт)",
          "Законы с форума на сервере: " + (feat.laws ? "подключены" : "не подключены"),
          "Сохранено в браузере: " + (LAWS ? (LAWS.laws || []).length + " шт." : "нет"),
          "Версия данных обновлена: " + (LAWS && LAWS.updatedAt ? new Date(LAWS.updatedAt).toISOString() : "—"),
          "Сервер проверял форум: " + (lawsRemote && lawsRemote.checkedAt ? new Date(lawsRemote.checkedAt).toISOString() : "—"),
          "Последняя ошибка: " + (lawsErr || "нет")
        ].join("\n"));
      },
      login: function () { return Promise.resolve({ ok: true }); },
      logout: function () { return Promise.resolve(null); },
      on: function (f) { if (typeof f === "function") lawsListeners.push(f); }
    }
  };
  // «Открыть» по ссылке /app/#open=uk:12.8 из уже открытой вкладки
  window.addEventListener("hashchange", function () {
    var m = /^#open=(.+)$/.exec(location.hash);
    if (!m) return;
    var t = decodeURIComponent(m[1]);
    history.replaceState(null, "", location.pathname + location.search);
    openListeners.forEach(function (f) { try { f(t); } catch (e) {} });
  });

  /* ───── запуск: вход → данные аккаунта → законы → скрипты страницы ───── */
  function withTimeout(p, ms) { return Promise.race([p, new Promise(function (ok) { setTimeout(function () { ok(null); }, ms); })]); }
  function boot() {
    return me().then(function (r) {
      if (r.ok && r.user && r.user.needLegal) { lost("Обновились Политика конфиденциальности и Условия пользования. Войдите и примите их."); return false; }
      if (r.ok) { takeMe(r); return true; }
      if (W.isOffline(r)) {
        var c = W.cachedUser(sess.login);
        if (c) { user = c.user; sys = c.sys || null; feat = c.web || feat; offline = true; lastOk = c.at; return true; }
        lost("Нет связи с сервером. Для входа нужен интернет."); return false;
      }
      lost(r.code === "banned" ? r.error : ""); return false;
    }).then(function (go) {
      if (!go) return false;
      step("Загружаем ваши данные…");
      sync.begin(user.login);
      return withTimeout(offline ? Promise.resolve(null) : sync.prefetch(), 6000).then(function () {
        var res = sync.startup(syncSnap());
        if (res && res.values) Object.keys(res.values).forEach(function (k) { if (W.SYNC_KEYS.indexOf(k) >= 0) W.ls(k, res.values[k]); });
        syncLast = syncSnap();
        return W.idbGet(lawsKey());
      }).then(function (j) {
        if (j && Array.isArray(j.laws) && j.laws.length) LAWS = j;
        if (!LAWS && feat.laws && !offline) { step("Загружаем законы…"); return withTimeout(lawsFetch(), 25000).then(function () { return true; }); }
        return true;
      });
    });
  }
  function runPage() {
    var list = Array.prototype.slice.call(document.querySelectorAll('script[type="text/x-senko"]'));
    list.forEach(function (old) {
      var s = document.createElement("script");
      s.text = old.text;
      old.parentNode.replaceChild(s, old);
    });
    if (document.readyState === "complete") window.dispatchEvent(new Event("load"));
    setTimeout(function () { spl.classList.add("out"); setTimeout(function () { spl.remove(); }, 300); }, 120);
    // фон: отправка изменений, проверка аккаунта, свежие законы
    setInterval(flushSync, 3000);
    setInterval(verify, 10 * 60 * 1000);
    setInterval(function () { if (!document.hidden) lawsFetch(); }, 3 * 60 * 60 * 1000);
    if (LAWS && feat.laws) setTimeout(lawsFetch, 4000);
    document.addEventListener("visibilitychange", function () { if (document.hidden) { flushSync(); sync.pushNow(true); } else if (Date.now() - lastOk > 5 * 60 * 1000) verify(); });
    window.addEventListener("pagehide", function () { flushSync(); sync.pushNow(true); });
  }
  function start() {
    boot().then(function (go) { if (go) runPage(); }, function (e) {
      step("Не удалось открыть помощник. Обновите страницу.");
      var b = document.createElement("button"); b.textContent = "Обновить"; b.onclick = function () { location.reload(); };
      var box = spl.querySelector(".b"); if (box) box.appendChild(b);
      console.error(e);
    });
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start); else start();
})();
