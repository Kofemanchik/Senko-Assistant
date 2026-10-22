/* Senko Assistant · панель владельца и модераторов (/panel/).
   Всё выполняет серверная функция senko (action: "panel"): права проверяются там же, где у бота.
   Ответы бота приходят сюда как сообщения с кнопками; HTML из них проходит через белый список тегов (tgHtml). */
(function () {
  "use strict";
  var CFG = window.SENKO_WEB || {};
  var API = CFG.api || "";
  var SKEY = "sa-panel";
  var DEPTS = ["Government", "LSPD", "LSCSD", "FIB", "SANG"];
  var RANKS = { user: "Пользователь", leader: "Руководство", moderator: "Модератор памятки", owner: "Владелец" };
  var ME = null, TOKEN = null, DASH = null;

  function $(id) { return document.getElementById(id); }
  function ss(k, v) { try { if (v === undefined) return sessionStorage.getItem(k); if (v === null) sessionStorage.removeItem(k); else sessionStorage.setItem(k, v); } catch (e) {} return null; }
  function ls(k, v) { try { if (v === undefined) return localStorage.getItem(k); if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch (e) {} return null; }

  // ───── построение разметки без innerHTML для пользовательских данных
  function h(tag, p) {
    var el = document.createElement(tag);
    p = p || {};
    for (var k in p) {
      var v = p[k];
      if (v == null || v === false || k === "value") continue;
      if (k === "class") el.className = v;
      else if (k === "text") el.textContent = v;
      else if (k === "html") el.innerHTML = v; // только для tgHtml() и своих иконок
      else if (k === "on") for (var ev in v) el.addEventListener(ev, v[ev]);
      else if (k === "style") el.setAttribute("style", v);
      else if (k in el && typeof v !== "string") el[k] = v;
      else el.setAttribute(k, v === true ? "" : v);
    }
    for (var i = 2; i < arguments.length; i++) add(el, arguments[i]);
    if (p.value != null) el.value = p.value; // после детей: у select значение выбирается из уже добавленных option
    return el;
  }
  function add(el, c) {
    if (c == null || c === false) return el;
    if (Array.isArray(c)) { c.forEach(function (x) { add(el, x); }); return el; }
    el.appendChild(typeof c === "object" ? c : document.createTextNode(String(c)));
    return el;
  }
  function ico(id) { return h("span", { html: '<svg class="ico"><use href="#' + id + '"/></svg>', style: "display:contents" }); }
  function btn(label, onClick, cls, icon) { return h("button", { type: "button", class: "btn " + (cls || ""), on: { click: onClick } }, icon ? ico(icon) : null, label); }
  function pill(text, cls) { return h("span", { class: "pill " + (cls || ""), text: text }); }
  function fmt(d) {
    if (!d) return "—";
    try { return new Date(d).toLocaleString("ru-RU", { timeZone: "Europe/Moscow", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" }); } catch (e) { return String(d); }
  }
  function ago(d) {
    if (!d) return "никогда";
    var m = Math.round((Date.now() - new Date(d).getTime()) / 60000);
    if (m < 2) return "только что";
    if (m < 60) return m + " мин назад";
    if (m < 1440) return Math.round(m / 60) + " ч назад";
    if (m < 43200) return Math.round(m / 1440) + " дн. назад";
    return fmt(d).slice(0, 10);
  }
  var toastT = 0;
  function toast(text, bad) {
    var t = $("toast");
    t.textContent = text;
    t.className = "toast show" + (bad ? " bad" : "");
    clearTimeout(toastT);
    toastT = setTimeout(function () { t.className = "toast" + (bad ? " bad" : ""); }, bad ? 5200 : 3200);
  }

  // ───── HTML из ответов бота: только теги Telegram, ссылки только https
  var TAGS = { b: "b", strong: "b", i: "i", em: "i", u: "u", ins: "u", s: "s", del: "s", strike: "s", code: "code", pre: "pre", blockquote: "blockquote" };
  function txt(t) { return t.replace(/&(?!(?:amp|lt|gt|quot|#\d{1,6});)/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); }
  function tgHtml(s) {
    s = String(s == null ? "" : s);
    var out = "", re = /<(\/?)([a-z][a-z0-9-]*)([^<>]*)>/gi, last = 0, m;
    while ((m = re.exec(s))) {
      out += txt(s.slice(last, m.index));
      last = re.lastIndex;
      var close = m[1] === "/", tag = m[2].toLowerCase();
      if (tag === "tg-spoiler") { out += close ? "</span>" : '<span class="spoiler" title="Нажмите, чтобы показать">'; continue; }
      if (tag === "a") {
        if (close) { out += "</a>"; continue; }
        var hm = /href\s*=\s*"([^"]*)"/i.exec(m[3]), href = hm ? hm[1].replace(/&amp;/g, "&") : "";
        out += /^https:\/\/[^\s"<>]+$/i.test(href) ? '<a href="' + txt(href) + '" target="_blank" rel="noopener noreferrer">' : "<a>";
        continue;
      }
      if (TAGS[tag]) out += close ? "</" + TAGS[tag] + ">" : "<" + TAGS[tag] + ">";
    }
    return out + txt(s.slice(last));
  }
  function plain(s) { var d = document.createElement("div"); d.innerHTML = tgHtml(s); return d.textContent; }
  document.addEventListener("click", function (e) { var sp = e.target.closest && e.target.closest(".spoiler"); if (sp) sp.classList.toggle("show"); });

  // ───── связь с сервером
  function api(op, data) {
    var body = Object.assign({ action: "panel", op: op, ptoken: TOKEN || undefined }, data || {});
    if (!API) return Promise.resolve({ ok: false, error: "Не найден адрес сервера (app/config.js). Сайт собран без tools/build-site.js." });
    return fetch(API, { method: "POST", body: JSON.stringify(body), cache: "no-store" })
      .then(function (r) { return r.json().catch(function () { return { ok: false, error: "Сервер вернул ошибку " + r.status + "." }; }); })
      .catch(function () { return { ok: false, error: "Нет связи с сервером. Проверьте интернет." }; })
      .then(function (r) {
        if (r && !r.ok && r.code === "auth" && op !== "login") { leave(r.error); return r; }
        return r || { ok: false, error: "Пустой ответ сервера." };
      });
  }

  // ───── ответы бота: сообщения, кнопки, файлы
  function download(name, text, type) {
    var a = h("a", { href: URL.createObjectURL(new Blob([text], { type: type || "application/octet-stream" })), download: name });
    document.body.appendChild(a); a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1500);
  }
  function renderOut(out, feed, after) {
    var nodes = [];
    (out || []).forEach(function (o) {
      if (o.t === "toast") { if (o.alert || !/^(Выполняю|Отменено)$/.test(o.text)) toast(o.text, o.alert); return; }
      if (o.t === "file") {
        download(o.name, o.text, o.type);
        nodes.push(h("div", { class: "msg file" }, ico("i-save"), h("div", { style: "flex:1;min-width:0" }, h("b", { text: o.name }), h("div", { class: "muted small", html: tgHtml(o.caption) })),
          btn("Скачать ещё раз", function () { download(o.name, o.text, o.type); }, "btn-sm")));
        return;
      }
      var m = h("div", { class: "msg", html: tgHtml(o.html) });
      if (o.buttons && o.buttons.length) {
        var kb = h("div", { class: "kb" });
        o.buttons.forEach(function (row) {
          kb.appendChild(h("div", null, row.map(function (b) {
            if (b.url) return h("a", { class: "btn btn-sm", href: b.url, target: "_blank", rel: "noopener noreferrer", text: b.text });
            return btn(b.text, function () { press(b.data, m, feed); }, "btn-sm" + (/^(✅|🚫|🗑)/.test(b.text) ? " btn-p" : ""));
          })));
        });
        m.appendChild(kb);
      }
      nodes.push(m);
    });
    if (!nodes.length && !(out || []).some(function (o) { return o.t === "toast"; })) nodes.push(h("div", { class: "msg muted", text: "Готово." }));
    var ref = after ? after.nextSibling : null;
    nodes.forEach(function (n) { if (ref) feed.insertBefore(n, ref); else feed.appendChild(n); });
    return nodes;
  }
  function press(data, msg, feed) {
    var kb = msg.querySelector(".kb");
    msg.querySelectorAll(".kb button").forEach(function (b) { b.disabled = true; });
    return api("cb", { data: data }).then(function (r) {
      if (!r.ok) { toast(r.error || "Не получилось.", true); msg.querySelectorAll(".kb button").forEach(function (b) { b.disabled = false; }); return; }
      if (kb) kb.remove();
      renderOut(r.out, feed, msg);
      if (feed.onDone) feed.onDone();
    });
  }
  function errMsg(r) { return h("div", { class: "msg err", text: (r && r.error) || "Не получилось." }); }
  // Команда бота: ответ появляется в ленте feed
  function run(text, feed, opts) {
    opts = opts || {};
    if (opts.clear) feed.textContent = "";
    if (opts.echo) feed.appendChild(h("div", { class: "msg me", text: text }));
    var wait = h("div", { class: "load", text: "Выполняю…" });
    feed.appendChild(wait);
    return api("cmd", { text: text }).then(function (r) {
      wait.remove();
      if (!r.ok) { feed.appendChild(errMsg(r)); return r; }
      var nodes = renderOut(r.out, feed);
      if (opts.scroll !== false && nodes[0] && opts.echo) nodes[nodes.length - 1].scrollIntoView({ block: "nearest", behavior: "smooth" });
      if (feed.onDone) feed.onDone();
      return r;
    });
  }
  // Короткий итог команды во всплывающем сообщении (режимы, кнопки «Включить»)
  function runToast(text, feed) {
    return run(text, feed, { clear: true }).then(function (r) {
      if (r.ok && r.out && r.out[0] && r.out[0].t === "msg") toast(plain(r.out[0].html).split("\n")[0].slice(0, 160));
      return r;
    });
  }

  // ───── окно (форма действия)
  function dlg(title, body, wide) {
    $("dlg-t").textContent = title;
    var b = $("dlg-b");
    b.textContent = "";
    add(b, body);
    $("dlg").hidden = false;
    $("dlg").firstChild.className = "dlg" + (wide ? " wide" : "");
    var f = b.querySelector("input,textarea,select");
    setTimeout(function () { (f || $("dlg-x")).focus(); }, 30);
  }
  function closeDlg() { $("dlg").hidden = true; $("dlg-b").textContent = ""; }
  $("dlg-x").addEventListener("click", closeDlg);
  $("dlg").addEventListener("click", function (e) { if (e.target === $("dlg")) closeDlg(); });
  document.addEventListener("keydown", function (e) { if (e.key === "Escape" && !$("dlg").hidden) closeDlg(); });

  function field(f) {
    var inp;
    if (f.type === "textarea") inp = h("textarea", { maxlength: f.max || 1500, placeholder: f.ph || "" });
    else if (f.type === "select") inp = h("select", null, f.options.map(function (o) { return h("option", { value: o[0], text: o[1] }); }));
    else inp = h("input", { type: f.type || "text", maxlength: f.max || 200, placeholder: f.ph || "", spellcheck: "false" });
    if (f.value != null) inp.value = f.value;
    inp.dataset.k = f.k;
    return h("label", { class: "fld" }, h("span", { text: f.label }), inp, f.hint ? h("span", { class: "hint", text: f.hint }) : null);
  }
  // Форма → команда бота. build(values) возвращает текст команды или {error}
  function form(title, fields, submit, build, done, danger) {
    var err = h("div", { class: "auth-err" });
    var f = h("form", { novalidate: true }, fields.map(field), err,
      h("div", { class: "dlg-f" }, btn("Отмена", closeDlg), h("button", { type: "submit", class: "btn " + (danger ? "btn-d" : "btn-p"), text: submit })));
    f.addEventListener("submit", function (e) {
      e.preventDefault();
      var v = {};
      f.querySelectorAll("[data-k]").forEach(function (x) { v[x.dataset.k] = x.value.replace(/[\r\n]+/g, x.tagName === "TEXTAREA" ? "\n" : " ").trim(); });
      for (var i = 0; i < fields.length; i++) if (fields[i].req && !v[fields[i].k]) { err.textContent = "Заполните поле «" + fields[i].label + "»."; return; }
      var c = build(v);
      if (c && c.error) { err.textContent = c.error; return; }
      closeDlg();
      done(c, v);
    });
    dlg(title, f);
  }
  function confirmDlg(title, text, label, fn, danger) {
    dlg(title, [h("p", { text: text, style: "margin-bottom:14px" }), h("div", { class: "dlg-f" }, btn("Отмена", closeDlg), btn(label, function () { closeDlg(); fn(); }, danger ? "btn-d" : "btn-p"))]);
  }
  function word(s) { return String(s || "").replace(/\s+/g, " ").trim(); }

  // ───── вход и выход
  function showAuth(msg) {
    $("shell").hidden = true;
    $("auth").hidden = false;
    $("a-err").textContent = msg || "";
    var last = ls("sa-panel-last");
    if (last && !$("a-login").value) $("a-login").value = last;
    setTimeout(function () { ($("a-login").value ? $("a-pass") : $("a-login")).focus(); }, 30);
  }
  function leave(msg) {
    TOKEN = null; ME = null;
    ss(SKEY, null);
    closeDlg();
    showAuth(msg);
  }
  $("a-eye").addEventListener("click", function () { var k = $("a-key"); k.type = k.type === "password" ? "text" : "password"; });
  $("auth-form").addEventListener("submit", function (e) {
    e.preventDefault();
    var login = $("a-login").value.trim(), pass = $("a-pass").value, key = $("a-key").value.trim();
    if (!login || !pass || !key) { $("a-err").textContent = "Заполните все три поля."; return; }
    if (key.replace(/[^a-z0-9]/gi, "").length !== 32) { $("a-err").textContent = "Пароль панели — 32 знака: латинские буквы и цифры."; return; }
    var go = $("a-go");
    go.disabled = true; go.textContent = "Вхожу…";
    api("login", { login: login, password: pass, key: key }).then(function (r) {
      go.disabled = false; go.textContent = "Войти";
      if (!r.ok) { $("a-err").textContent = r.error || "Не удалось войти."; $("a-key").select(); return; }
      ls("sa-panel-last", login);
      $("a-pass").value = ""; $("a-key").value = "";
      TOKEN = r.ptoken; ss(SKEY, TOKEN);
      start(r.me);
    });
  });
  $("logout").addEventListener("click", function () { api("logout").then(function () { leave("Вы вышли из панели."); }); });

  // ───── тема
  function themeIco() {
    var t = document.documentElement.dataset.theme || "auto";
    $("theme").innerHTML = '<svg class="ico"><use href="#' + (t === "light" ? "i-sun" : t === "dark" ? "i-moon" : "i-auto") + '"/></svg>';
    $("theme").title = "Тема: " + (t === "light" ? "светлая" : t === "dark" ? "тёмная" : "как в системе");
  }
  $("theme").addEventListener("click", function () {
    var t = document.documentElement.dataset.theme || "auto";
    var n = t === "auto" ? "light" : t === "light" ? "dark" : "auto";
    if (n === "auto") { delete document.documentElement.dataset.theme; ls("site-theme", null); } else { document.documentElement.dataset.theme = n; ls("site-theme", n); }
    themeIco();
  });

  // ───── меню
  var NAV = [
    ["Обзор", [["dash", "i-home", "Сводка", "Цифры и режимы"], ["health", "i-pulse", "Состояние", "Сервисы, версии, поиск"]]],
    ["Люди", [["users", "i-users", "Пользователи", "Поиск и действия"], ["staff", "i-key", "Роли и доступ", "Модераторы и руководство"], ["queue", "i-inbox", "Заявки и сбросы", "Новички и пароли", "queue"]]],
    ["Работа", [["reports", "i-file", "Рапорты", "Рапорты сотрудников", "reports"], ["rating", "i-trophy", "Рейтинг", "Неделя и контрольные"], ["news", "i-mega", "Рассылки", "Сообщения в программе", null, 1], ["bugs", "i-bug", "Ошибки", "Сообщения пользователей", "bugs", 1], ["ideas", "i-mega", "Идеи", "Предложения пользователей"]]],
    ["Тестирование", [["beta", "i-shield", "Тестеры", "Роль, задания, функции"]]],
    ["Управление", [["modes", "i-sliders", "Режимы", "Техработы, регистрация", null, 1], ["ads", "i-ad", "Реклама", "Баннеры на сайте и в программе", null, 1], ["db", "i-db", "База данных", "Таблицы и правки", null, 1], ["backup", "i-save", "Резервная копия", "Скачать базу", null, 1], ["audit", "i-list", "Журнал", "Кто что делал", null, 1]]],
    ["Сервис", [["console", "i-term", "Консоль бота", "Любая команда"]]],
  ];
  function buildNav() {
    var nav = $("nav");
    nav.textContent = "";
    NAV.forEach(function (g) {
      var items = g[1].filter(function (x) { return !x[5] || ME.owner; });
      if (!items.length) return;
      nav.appendChild(h("div", { class: "grp", text: g[0] }));
      items.forEach(function (x) {
        nav.appendChild(h("a", { class: "it", href: "#" + x[0], "data-p": x[0] }, ico(x[1]), h("span", null, h("b", { text: x[2] }), h("small", { text: x[3] })), x[4] ? h("span", { class: "cnt", "data-c": x[4], hidden: true }) : null));
      });
    });
  }
  function counts(d) {
    if (!d) return;
    var c = { queue: (d.users.pending || 0) + (d.resets || 0), reports: d.reports || 0, bugs: d.bugs || 0 };
    document.querySelectorAll("[data-c]").forEach(function (el) { var n = c[el.dataset.c]; el.textContent = n; el.hidden = !n; });
  }
  function refreshCounts() { return api("dash").then(function (d) { if (d.ok) { DASH = d; counts(d); } return d; }); }
  $("burger").addEventListener("click", function () { $("shell").classList.add("menu"); });
  $("scrim").addEventListener("click", function () { $("shell").classList.remove("menu"); });

  // ───── страницы
  function head(el, title, sub, right) {
    $("bar-title").textContent = title;
    document.title = title + " · Панель Senko Assistant";
    el.appendChild(h("div", { class: "ph" }, h("div", null, h("h1", { text: title }), sub ? h("p", { text: sub }) : null), right || null));
  }
  function feedBox() { return h("div", { class: "feed" }); }
  function card(title, sub) { var c = h("div", { class: "card" }); if (title) c.appendChild(h("h2", { text: title })); if (sub) c.appendChild(h("p", { class: "sub", text: sub })); return c; }
  function ownerOnly(el) { el.appendChild(h("div", { class: "card" }, h("p", { text: "Этот раздел доступен только владельцу." }))); }

  var PAGES = {};

  PAGES.dash = function (el) {
    head(el, "Сводка", "Главное о пользователях и режимах работы", btn("Обновить", function () { route(true); }, "btn-sm", "i-refresh"));
    var box = h("div", { class: "load", text: "Загружаю…" });
    el.appendChild(box);
    return refreshCounts().then(function (d) {
      box.remove();
      if (!d.ok) return el.appendChild(errMsg(d));
      var u = d.users;
      var T = [
        ["Пользователей", u.total, "новых за 7 дней: " + u.week, "#users"],
        ["В сети за час", u.online, "за сутки: " + u.today, "#users/online"],
        ["Ждут подтверждения", u.pending, "заявки новичков", "#queue", u.pending > 0],
        ["Сброс пароля", d.resets, "ждут решения", "#queue", d.resets > 0],
        ["Новые рапорты", d.reports, "ещё не проверены", "#reports"],
        ME.owner ? ["Ошибки без ответа", d.bugs, "сообщения из программы", "#bugs", d.bugs > 0] : null,
        ["Заблокировано", u.banned, "аккаунтов", "#users/banned"],
        ["Модераторы", u.mods, "руководство: " + u.leaders, "#staff"],
      ].filter(Boolean);
      el.appendChild(h("div", { class: "tiles" }, T.map(function (t) { return h("a", { class: "tile" + (t[4] ? " hot" : ""), href: t[3] }, h("small", { text: t[0] }), h("b", { text: String(t[1]) }), h("i", { text: t[2] })); })));
      // регистрации за 14 дней (МСК)
      var byDay = {};
      (d.days || []).forEach(function (x) { byDay[x.d] = x.n; });
      var days = [];
      for (var i = 13; i >= 0; i--) { var iso = new Date(Date.now() + 3 * 3600e3 - i * 864e5).toISOString(); var k = iso.slice(8, 10) + "." + iso.slice(5, 7); days.push([k, byDay[k] || 0]); }
      var max = Math.max.apply(null, days.map(function (x) { return x[1]; }).concat([1]));
      var c1 = card("Регистрации за 14 дней", "Сколько новых аккаунтов в день, время московское");
      c1.appendChild(h("div", { class: "bars", role: "img", "aria-label": "Регистрации по дням" }, days.map(function (x) {
        return h("div", { title: x[0] + ": " + x[1] }, x[1] ? h("b", { text: String(x[1]) }) : null, h("span", { style: "height:" + Math.max(3, Math.round((x[1] / max) * 92)) + "%" }), h("em", { text: x[0].slice(0, 2) }));
      })));
      var omax = Math.max.apply(null, (d.orgs || []).map(function (x) { return x.n; }).concat([1]));
      var c2 = card("Организации", "Аккаунтов всего; в скобках — заходили за 7 дней");
      c2.appendChild(h("div", { class: "olist" }, (d.orgs || []).map(function (o) {
        return h("a", { class: "orow", href: "#users", on: { click: function () { UF.org = DEPTS.indexOf(o.org) >= 0 ? o.org : ""; } }, style: "color:inherit;text-decoration:none" },
          h("span", { text: o.org }), h("span", { class: "track" }, h("span", { style: "width:" + Math.round((o.n / omax) * 100) + "%" })), h("b", { text: o.n + " (" + o.active + ")" }));
      })));
      el.appendChild(h("div", { class: "grid g2 sec" }, c1, c2));
      var m = d.modes, P = [];
      P.push(pill(m.maintenance && m.maintenance.on ? "Техработы: включены" : "Техработы: выключены", m.maintenance && m.maintenance.on ? "warn" : "off"));
      P.push(pill(m.regs && m.regs.open === false ? "Регистрация закрыта" : "Регистрация открыта" + (m.regs && m.regs.limit ? ", до " + m.regs.limit + " в сутки" : ""), m.regs && m.regs.open === false ? "bad" : "on"));
      P.push(pill(m.approval && m.approval.on ? "Приём новичков: с подтверждением" : "Приём новичков: сразу", m.approval && m.approval.on ? "acc" : "off"));
      if (ME.owner) {
        P.push(pill(m.summary && m.summary.time ? "Сводка в " + m.summary.time + " МСК" : "Сводка выключена", m.summary && m.summary.time ? "on" : "off"));
        P.push(pill(m.orgreport && m.orgreport.on === false ? "Отчёт руководству выключен" : "Отчёт руководству по понедельникам", m.orgreport && m.orgreport.on === false ? "off" : "on"));
        P.push(pill("Чёрный список: " + (m.blacklist || []).length + " слов", "off"));
      }
      var c3 = card("Режимы работы");
      c3.appendChild(h("div", { class: "pills" }, P));
      if (ME.owner) c3.appendChild(h("div", { style: "margin-top:14px" }, h("a", { class: "btn btn-sm", href: "#modes", text: "Изменить режимы" })));
      var sec = h("div", { class: "sec" }, c3);
      el.appendChild(sec);
    });
  };

  PAGES.health = function (el) {
    head(el, "Состояние", "Сервисы, версии программы у пользователей, что ищут и не находят");
    var feed = feedBox();
    var Q = [["Статус сервисов", "/health"], ["Версии программы", "/versions"], ["Кто в сети", "/online"], ["Поиски без результата", "/misses"], ["Похожие аккаунты", "/dups"]];
    if (ME.owner) Q.push(["Статистика", "/stats"], ["Давно не заходили", "/inactive"], ["Вопросы к ИИ", "/ailog 7"], ["Проверки законов", "/laws status"], ["Проверить законы сейчас", "/laws"]);
    el.appendChild(h("div", { class: "quick" }, Q.map(function (q) { return btn(q[0], function () { run(q[1], feed, { clear: true }); }, "btn-sm"); })));
    el.appendChild(feed);
    return run("/health", feed);
  };

  // Пользователи
  var UF = { q: "", rank: "", org: "", state: "", sort: "new", page: 0 };
  PAGES.users = function (el, arg) {
    if (arg === "online" || arg === "banned" || arg === "pending") { UF.state = arg; UF.page = 0; }
    head(el, "Пользователи", "Поиск по логину, нику, статику и Discord" + (ME.owner ? ", Telegram" : "") + "; #тег — по тегу");
    var q = h("input", { type: "search", placeholder: "Найти пользователя", value: UF.q, maxlength: 40, spellcheck: "false" });
    function sel(k, opts) { var s = h("select", { "aria-label": k, on: { change: function () { UF[k] = s.value; UF.page = 0; load(); } } }, opts.map(function (o) { return h("option", { value: o[0], text: o[1] }); })); s.value = UF[k]; return s; }
    el.appendChild(h("div", { class: "tools" }, h("label", { class: "search" }, ico("i-search"), q),
      sel("rank", [["", "Все роли"]].concat(Object.keys(RANKS).map(function (k) { return [k, RANKS[k]]; }))),
      sel("org", [["", "Все организации"]].concat(DEPTS.map(function (d) { return [d, d]; }))),
      sel("state", [["", "Любой статус"], ["online", "В сети за час"], ["banned", "Заблокированы"], ["pending", "Ждут подтверждения"]]),
      sel("sort", [["new", "Сначала новые"], ["seen", "Недавно в сети"], ["login", "По логину"]])));
    var list = h("div", null, h("div", { class: "load", text: "Загружаю…" }));
    el.appendChild(list);
    var t = 0;
    q.addEventListener("input", function () { clearTimeout(t); t = setTimeout(function () { UF.q = q.value.trim(); UF.page = 0; load(); }, 300); });
    function status(r) {
      var P = [];
      if (r.banned) P.push(pill(r.banned_until ? "блок до " + fmt(r.banned_until).slice(0, 10) : "заблокирован", "bad"));
      if (r.approval && r.approval !== "ok") P.push(pill(r.approval === "pending" ? "ждёт подтверждения" : "отклонён", "warn"));
      if (r.warns) P.push(pill("⚠ " + r.warns, "warn"));
      if (r.rank !== "user") P.push(pill(RANKS[r.rank], "acc"));
      (r.tags || []).slice(0, 3).forEach(function (x) { P.push(pill("#" + x)); });
      return P;
    }
    function load() {
      return api("users", UF).then(function (r) {
        list.textContent = "";
        if (!r.ok) return list.appendChild(errMsg(r));
        if (!r.rows.length) return list.appendChild(h("div", { class: "card empty", text: "Никого не нашлось." }));
        var go = function (login) { return function () { location.hash = "#user/" + encodeURIComponent(login); }; };
        list.appendChild(h("div", { class: "tbl-wrap resp" }, h("table", { class: "tbl" },
          h("thead", null, h("tr", null, ["Логин и ник", "Статик", "Организация", "Статус", "Был в сети", "Регистрация"].map(function (x) { return h("th", { text: x }); }))),
          h("tbody", null, r.rows.map(function (u) {
            return h("tr", { tabindex: 0, on: { click: go(u.login), keydown: function (e) { if (e.key === "Enter") go(u.login)(); } } },
              h("td", null, h("div", { class: "lg", text: u.login }), h("div", { class: "nick", text: u.nick })),
              h("td", { class: "mono", text: u.static_id }), h("td", { text: u.org }), h("td", null, h("div", { class: "pills" }, status(u))),
              h("td", { text: ago(u.last_seen) }), h("td", { text: fmt(u.created_at).slice(0, 10) }));
          })))));
        list.appendChild(h("div", { class: "cards" }, r.rows.map(function (u) {
          return h("button", { type: "button", class: "ucard", on: { click: go(u.login) } }, h("div", { class: "t" }, h("b", { text: u.login }), h("span", { class: "muted small", text: ago(u.last_seen) })),
            h("div", { class: "m", text: u.nick + " · " + u.static_id + " · " + u.org }), h("div", { class: "pills" }, status(u)));
        })));
        list.appendChild(h("div", { class: "pager" },
          btn("← Назад", function () { UF.page--; load(); }, "btn-sm", null),
          h("span", { text: "Найдено: " + r.total + (r.total > 40 ? " · стр. " + (r.page + 1) : "") }),
          btn("Дальше →", function () { UF.page++; load(); }, "btn-sm")));
        var pb = list.querySelectorAll(".pager button");
        pb[0].disabled = r.page === 0; pb[1].disabled = !r.more;
        if (!r.page && !r.more) { pb[0].hidden = pb[1].hidden = true; }
      });
    }
    return load();
  };

  // Карточка пользователя и действия с ним (через команды бота, опасные — с подтверждением кнопкой)
  PAGES.user = function (el, login) {
    login = decodeURIComponent(login || "");
    el.appendChild(h("a", { href: "#users", class: "btn btn-sm", style: "margin-bottom:14px" }, ico("i-back"), "К списку"));
    var box = h("div", { class: "load", text: "Загружаю…" });
    el.appendChild(box);
    var feed = feedBox();
    var left = h("div"), right = h("div"), actsBox = h("div"), progBox = h("div");
    var R = card("Ответы бота");
    R.style.marginTop = "14px";
    R.appendChild(feed);
    right.appendChild(actsBox);
    right.appendChild(R);
    feed.onDone = function () { load(); };
    function load() {
      return api("user", { login: login }).then(function (r) {
        box.remove();
        if (!r.ok) { left.textContent = ""; left.appendChild(errMsg(r)); return r; }
        var old = el.querySelector(".ph");
        if (old) old.remove();
        var P = h("div", { class: "pills" }, pill(r.user.rankName, r.user.rank === "user" ? "" : "acc"), r.user.beta ? pill("бета-тестер", "acc") : null, r.user.banned ? pill("заблокирован", "bad") : null, r.user.approval !== "ok" ? pill("ждёт подтверждения", "warn") : null);
        head(el, r.user.login, r.user.nick + " · " + r.user.static + " · " + r.user.org, P);
        el.insertBefore(el.querySelector(".ph"), el.children[1]);
        if (!right.parentNode) el.appendChild(h("div", { class: "ubox" }, left, right));
        left.textContent = "";
        var c = card(null);
        c.appendChild(h("div", { class: "msg", html: tgHtml(r.html), style: "border:0;box-shadow:none;padding:0" }));
        left.appendChild(c);
        if (r.panelKey) left.appendChild(h("div", { class: "card" }, h("h3", { text: "Пароль панели" }), h("p", { class: "muted small", text: "Выдан " + fmt(r.panelKey.created) + ", последний вход: " + fmt(r.panelKey.used) })));
        if (r.logins && r.logins.length) {
          left.appendChild(h("div", { class: "card" }, h("h3", { text: "Последние входы" }), h("p", { class: "sub", text: "Открытых сессий в программе: " + r.sessions }),
            h("div", { class: "tbl-wrap", style: "box-shadow:none" }, h("table", { class: "tbl" }, h("tbody", null, r.logins.map(function (x) {
              return h("tr", { style: "cursor:default" }, h("td", { class: "mono small", text: fmt(x.at) }), h("td", { text: { login: "вход", register: "регистрация", fail: "неверный пароль", password: "смена пароля", reset: "сброс пароля", logout_all: "выход везде" }[x.kind] || x.kind }), h("td", { class: "small muted", text: [x.ver, x.os, x.ip].filter(Boolean).join(" · ") }));
            }))))));
        }
        buildActs(r);
        if (ME.owner) { left.appendChild(progBox); progLoad(); }
        return r;
      });
    }
    // 2.6.3: опыт и достижения (только владелец). Опыт меняется поправкой на сервере, программа её не перебивает
    function progLoad() { return api("prog_get", { login: login }).then(progShow); }
    function progShow(r) {
      progBox.textContent = "";
      if (!r || !r.ok) { progBox.appendChild(errMsg(r)); return; }
      var C = card("Опыт, достижения и запросы к ИИ", "Изменения видны в личном кабинете программы и в рейтинге. Недельный рейтинг считает только опыт, заработанный в программе.");
      var note = h("input", { type: "checkbox" }); note.checked = true;
      var why = h("input", { class: "grow", maxlength: 200, placeholder: "Причина (необязательно, увидит пользователь)" });
      var setInp = h("input", { type: "number", min: 0, max: 1000000, step: 1, style: "width:120px", "aria-label": "Опыт", value: String(r.xp) });
      function xp(data) {
        api("prog_xp", Object.assign({ login: login, notify: note.checked, reason: why.value.trim() }, data)).then(function (y) {
          if (!y.ok) return toast(y.error, true);
          toast("Опыт: " + y.xp + "."); progShow(y);
        });
      }
      C.appendChild(h("p", null, h("b", { text: "Опыт: " + r.xp }), " · звание «" + r.level.name + "» (" + r.level.n + " из " + r.levels.length + ")",
        h("span", { class: "muted small", text: "  из программы " + r.synced + (r.adj ? ", поправка " + (r.adj > 0 ? "+" : "") + r.adj : "") })));
      C.appendChild(h("div", { class: "row", style: "flex-wrap:wrap;gap:8px;margin:8px 0" },
        setInp, btn("Установить", function () { var v = setInp.value.trim(); if (!/^\d{1,7}$/.test(v)) return toast("Опыт: целое число от 0.", true); xp({ set: +v }); }, "btn-sm btn-p"),
        [10, 50, 100, -50].map(function (n) { return btn((n > 0 ? "+" : "−") + Math.abs(n), function () { xp({ add: n }); }, "btn-sm"); }),
        h("select", { class: "btn-sm", "aria-label": "Звание", style: "width:auto", on: { change: function (e) { if (e.target.value !== "") xp({ set: +e.target.value }); } } },
          h("option", { value: "", text: "Сделать званием…" }), r.levels.map(function (l) { return h("option", { value: String(l.from), text: l.n + ". " + l.name + " (" + l.from + ")" }); }))));
      C.appendChild(h("div", { class: "row", style: "gap:8px;margin-bottom:12px" }, why, h("label", { class: "small", style: "display:flex;align-items:center;gap:6px;white-space:nowrap" }, note, "Сообщить в программе")));
      // 2.6.6: дополнительные запросы к ИИ, тратятся после дневного лимита и не сгорают
      var aiInp = h("input", { type: "number", min: 0, max: 100000, step: 1, style: "width:120px", "aria-label": "Дополнительные запросы к ИИ", value: String(r.aiBonus || 0) });
      function aiq(data) {
        api("prog_ai", Object.assign({ login: login, notify: note.checked, reason: why.value.trim() }, data)).then(function (y) {
          if (!y.ok) return toast(y.error, true);
          toast("Дополнительных запросов к ИИ: " + y.aiBonus + "."); progShow(y);
        });
      }
      C.appendChild(h("h3", { text: "Запросы к ИИ", style: "margin:6px 0" }));
      C.appendChild(h("p", { class: "muted small", text: "Дополнительные запросы тратятся, когда у пользователя кончился дневной лимит, и не сгорают. Сейчас: " + (r.aiBonus || 0) + "." }));
      C.appendChild(h("div", { class: "row", style: "flex-wrap:wrap;gap:8px;margin:8px 0 12px" },
        aiInp, btn("Установить", function () { var v = aiInp.value.trim(); if (!/^\d{1,6}$/.test(v)) return toast("Запросы: целое число от 0.", true); aiq({ set: +v }); }, "btn-sm btn-p"),
        [10, 25, 50, 100].map(function (n) { return btn("+" + n, function () { aiq({ add: n }); }, "btn-sm"); }),
        btn("Обнулить", function () { aiq({ set: 0 }); }, "btn-sm")));
      C.appendChild(h("h3", { text: "Достижения", style: "margin:6px 0" }));
      C.appendChild(h("div", { class: "tbl-wrap", style: "box-shadow:none" }, h("table", { class: "tbl" }, h("tbody", null, r.ach.map(function (x) {
        return h("tr", { style: "cursor:default" },
          h("td", { text: x.icon, style: "width:28px;font-size:18px" }),
          h("td", null, h("b", { text: x.name }), x.custom ? pill("особое", "acc") : null, h("div", { class: "muted small", text: x.desc || "" }),
            h("div", { class: "small", style: "margin-top:2px", text: x.at ? "✓ получено " + fmt(x.at).slice(0, 10) : "не получено" })),
          h("td", { style: "text-align:right;width:1%" }, btn(x.at ? "Забрать" : "Выдать", function () {
            api("prog_ach", { login: login, code: x.code, on: !x.at, notify: note.checked }).then(function (y) {
              if (!y.ok) return toast(y.error, true);
              toast(x.at ? "Достижение забрано." : "Достижение выдано."); progShow(y);
            });
          }, "btn-sm" + (x.at ? "" : " btn-p"))));
      })))));
      C.appendChild(h("div", { class: "row", style: "margin-top:10px" }, btn("Новое особое достижение", function () {
        form("Новое достижение для " + login, [
          { k: "i", label: "Значок", max: 8, value: "🏆", hint: "Один эмодзи." },
          { k: "n", label: "Название", req: 1, max: 60, ph: "Лучший сотрудник месяца" },
          { k: "d", label: "За что", max: 160, ph: "Например: за помощь новичкам" }],
          "Создать и выдать", function () { return {}; }, function (c, v) {
            api("prog_ach_new", { login: login, icon: v.i, name: v.n, desc: v.d, notify: note.checked }).then(function (y) {
              if (!y.ok) return toast(y.error, true);
              toast("Достижение «" + v.n + "» выдано."); progShow(y);
            });
          });
      }, "btn-sm", "i-trophy")));
      progBox.appendChild(C);
    }
    function act(label, fields, build, opts) {
      opts = opts || {};
      return btn(label, function () {
        if (!fields) return run(build({}), feed, { echo: true });
        form(label + ": " + login, fields, opts.submit || "Выполнить", build, function (cmd) { run(cmd, feed, { echo: true }); }, opts.danger);
      }, "btn-sm" + (opts.danger ? " btn-d" : ""));
    }
    function buildActs(r) {
      var u = r.user, L = u.login;
      var A = card("Действия", "Команды идут через бота: блокировка, удаление и роли просят подтверждения кнопкой ниже.");
      var acts = h("div", { class: "acts" });
      if (r.touch) A.appendChild(h("p", { class: "msg err", text: r.touch, style: "margin-bottom:12px" }));
      acts.appendChild(h("h3", { text: "Модерация" }));
      acts.appendChild(act("Заметка", [{ k: "t", label: "Текст заметки", type: "textarea", req: 1, max: 500, hint: "Пользователь заметку не видит." }], function (v) { return "/note " + L + " " + word(v.t); }));
      if (!r.touch) {
        acts.appendChild(act("Предупреждение", [{ k: "t", label: "Причина", max: 200, ph: "Например: оскорбления в рапорте" }], function (v) { return "/warn " + L + (v.t ? " " + word(v.t) : ""); }));
        acts.appendChild(act("Снять предупреждение", null, function () { return "/unwarn " + L; }));
        acts.appendChild(act("Теги", [{ k: "t", label: "Теги через пробел", req: 1, max: 120, ph: "новичок проверить" }], function (v) { return "/tag " + L + " " + word(v.t); }));
        if (u.tags && u.tags.length) acts.appendChild(act("Убрать тег", [{ k: "t", label: "Тег", type: "select", options: u.tags.map(function (x) { return [x, "#" + x]; }) }], function (v) { return "/untag " + L + " " + v.t; }));
        acts.appendChild(act("Организация", [{ k: "o", label: "Новая организация", type: "select", options: DEPTS.map(function (d) { return [d, d]; }), value: u.org }], function (v) { return "/setorg " + L + " " + v.o; }));
        if (u.approval !== "ok") acts.appendChild(act("Принять заявку", null, function () { return "/approve " + L; }));
        acts.appendChild(act("Завершить сессии", null, function () { return "/kick " + L; }));
        acts.appendChild(btn(u.beta ? "Снять роль «Бета-тестер»" : "Выдать роль «Бета-тестер»", function () {
          api("beta_set", { login: L, on: !u.beta }).then(function (y) { toast(y.ok ? (u.beta ? "Роль тестера снята." : "Роль тестера выдана.") : y.error, !y.ok); load(); });
        }, "btn-sm"));
        if (u.banned) acts.appendChild(act("Разблокировать", null, function () { return "/unban " + L; }));
        else {
          acts.appendChild(act("Блокировка на срок", [{ k: "d", label: "Срок", type: "select", options: [["30m", "30 минут"], ["2h", "2 часа"], ["12h", "12 часов"], ["1d", "1 день"], ["3d", "3 дня"], ["7d", "7 дней"], ["14d", "14 дней"], ["30d", "30 дней"]], value: "1d" }, { k: "t", label: "Причина", max: 200 }],
            function (v) { return "/tempban " + L + " " + v.d + (v.t ? " " + word(v.t) : ""); }, { danger: 1 }));
          acts.appendChild(act("Заблокировать", [{ k: "t", label: "Причина", max: 200 }], function (v) { return "/ban " + L + (v.t ? " " + word(v.t) : ""); }, { danger: 1 }));
        }
      }
      if (ME.owner) {
        acts.appendChild(h("h3", { text: "Владелец" }));
        acts.appendChild(act("Роль", [{ k: "r", label: "Роль", type: "select", options: Object.keys(RANKS).map(function (k) { return [k, RANKS[k]]; }), value: u.rank },
          { k: "tg", label: "Telegram ID", max: 15, ph: "необязательно", hint: "Нужен, чтобы модератор или руководитель работал в боте. Без него модератор работает только в панели." }],
          function (v) { if (v.tg && !/^\d{3,15}$/.test(v.tg)) return { error: "Telegram ID — только цифры." }; return "/role " + L + " " + v.r + (v.tg ? " " + v.tg : ""); }));
        acts.appendChild(act("Исправить ник", [{ k: "n", label: "Новый ник", req: 1, max: 40, value: u.nick }], function (v) { return "/rename " + L + " " + word(v.n); }));
        acts.appendChild(act("Исправить статик", [{ k: "s", label: "Статик", req: 1, max: 12, value: u.static }], function (v) { return "/setstatic " + L + " " + word(v.s).replace(/\s/g, ""); }));
        if (u.rank === "moderator" || u.rank === "owner") acts.appendChild(btn("Пароль панели", function () { issueKey(L, function () { load(); }); }, "btn-sm"));
        if (u.rank !== "owner") acts.appendChild(act("Удалить аккаунт", null, function () { return "/delete " + L; }, { danger: 1 }));
      }
      A.appendChild(acts);
      actsBox.textContent = "";
      actsBox.appendChild(A);
    }
    return load();
  };

  // Пароль панели: бот отправляет его в Telegram, а если Telegram не привязан — показываем один раз здесь
  function issueKey(login, after) {
    confirmDlg("Новый пароль панели", "Выдать " + login + " новый пароль панели? Старый перестанет работать, открытые панели этого аккаунта закроются.", "Выдать", function () {
      api("staff_key", { login: login }).then(function (r) {
        if (!r.ok) return toast(r.error, true);
        if (r.sent) toast("Пароль отправлен " + login + " в Telegram.");
        else {
          var kb = h("div", { class: "keybox", text: r.key });
          dlg(r.self ? "Ваш новый пароль панели" : "Пароль панели для " + login, [
            h("p", { text: r.self ? "Сохраните его в менеджере паролей. Эта панель остаётся открытой; при следующем входе нужен новый пароль." : "У этого аккаунта нет Telegram, поэтому пароль показан здесь один раз. Передайте его лично и не пересылайте в общих чатах." }),
            kb,
            h("div", { class: "dlg-f" }, btn("Скопировать", function () { try { navigator.clipboard.writeText(r.key); toast("Скопировано."); } catch (e) {} }), btn("Готово", closeDlg, "btn-p"))]);
        }
        if (after) after();
      });
    });
  }

  PAGES.staff = function (el) {
    head(el, "Роли и доступ", ME.owner ? "Модераторы, руководство организаций и пароли панели" : "Кто управляет программой");
    var feed = feedBox();
    if (ME.owner) {
      var c = card("Выдать роль", "Пользователь должен быть зарегистрирован. Бот попросит подтвердить кнопкой.");
      var f = h("form", { class: "row", novalidate: true },
        h("input", { class: "grow", placeholder: "Логин", maxlength: 24, "data-k": "l", spellcheck: "false", "aria-label": "Логин" }),
        h("select", { "data-k": "r", "aria-label": "Роль", style: "width:auto" }, ["moderator", "leader", "user", "owner"].map(function (k) { return h("option", { value: k, text: RANKS[k] }); })),
        h("input", { placeholder: "Telegram ID (необязательно)", maxlength: 15, "data-k": "t", style: "flex:0 1 230px", inputmode: "numeric", "aria-label": "Telegram ID" }),
        h("button", { type: "submit", class: "btn btn-p", text: "Выдать" }));
      f.addEventListener("submit", function (e) {
        e.preventDefault();
        var l = f.querySelector('[data-k="l"]').value.trim(), r = f.querySelector('[data-k="r"]').value, t = f.querySelector('[data-k="t"]').value.trim();
        if (!/^[A-Za-z0-9_.-]{3,24}$/.test(l)) return toast("Введите логин пользователя.", true);
        if (t && !/^\d{3,15}$/.test(t)) return toast("Telegram ID — только цифры.", true);
        run("/role " + l + " " + r + (t ? " " + t : ""), feed, { clear: true });
      });
      c.appendChild(f);
      c.appendChild(h("p", { class: "muted small", style: "margin-top:10px", text: "Руководство видит только свою организацию. Модератору без Telegram ID доступна только эта панель." }));
      c.appendChild(h("div", { style: "margin-top:12px" }, feed));
      el.appendChild(c);
      feed.onDone = function () { load(); };
    }
    var list = h("div", { class: "sec" }, h("div", { class: "load", text: "Загружаю…" }));
    el.appendChild(list);
    function load() {
      return api("staff").then(function (r) {
        list.textContent = "";
        if (!r.ok) return list.appendChild(errMsg(r));
        var cols = ["Аккаунт", "Роль", "Организация", "Telegram", "Был в сети"];
        if (ME.owner) cols.push("Пароль панели", "");
        list.appendChild(h("h2", { text: "Команда", style: "font-size:20px;margin-bottom:12px" }));
        list.appendChild(h("div", { class: "tbl-wrap" }, h("table", { class: "tbl" },
          h("thead", null, h("tr", null, cols.map(function (x) { return h("th", { text: x }); }))),
          h("tbody", null, r.rows.map(function (u) {
            var tr = h("tr", { style: "cursor:default" },
              h("td", null, h("a", { class: "lg", href: "#user/" + encodeURIComponent(u.login), text: u.login }), h("div", { class: "nick", text: u.nick })),
              h("td", null, pill(RANKS[u.rank], u.rank === "leader" ? "" : "acc")), h("td", { text: u.org }),
              h("td", null, u.has_tg ? pill("привязан", "on") : pill("нет", "off")), h("td", { text: ago(u.last_seen) }));
            if (ME.owner) {
              var panelOk = u.rank === "owner" || u.rank === "moderator";
              tr.appendChild(h("td", { class: "small" }, !panelOk ? h("span", { class: "muted", text: "не нужен" }) : u.key_at ? [h("div", { text: "выдан " + fmt(u.key_at).slice(0, 10) }), h("div", { class: "muted", text: "вход: " + (u.key_used ? ago(u.key_used) : "ещё не было") + (u.panels ? " · открыто: " + u.panels : "") })] : h("span", { class: "muted", text: "не выдан" })));
              tr.appendChild(h("td", null, panelOk ? h("div", { class: "row", style: "flex-wrap:nowrap" }, btn(u.key_at ? "Новый" : "Выдать", function () { issueKey(u.login, load); }, "btn-sm"),
                u.key_at && u.login !== ME.login ? btn("Закрыть", function () { confirmDlg("Закрыть вход в панель", "Пароль панели " + u.login + " перестанет работать, открытые панели закроются.", "Закрыть", function () { api("staff_revoke", { login: u.login }).then(function (x) { toast(x.ok ? "Вход в панель закрыт." : x.error, !x.ok); load(); }); }, true); }, "btn-sm btn-d") : null) : null));
            }
            return tr;
          })))));
        if (ME.owner) list.appendChild(h("p", { class: "muted small", style: "margin-top:10px", text: "Свой пароль панели можно получить и в боте: /panel. Закрыть вход себе: /panel off. Модератору бот пришлёт пароль в Telegram, если он привязан." }));
      });
    }
    return load();
  };

  PAGES.queue = function (el) {
    head(el, "Заявки и сбросы", "Новички, которые ждут подтверждения, и запросы на сброс пароля", btn("Обновить", function () { route(true); }, "btn-sm", "i-refresh"));
    var f1 = feedBox(), f2 = feedBox();
    var c1 = card("Заявки новичков"), c2 = card("Сброс пароля", "Подтверждайте, только если уверены, что просит сам владелец аккаунта.");
    if (ME.owner && DASH) {
      var on = DASH.modes.approval && DASH.modes.approval.on;
      c1.appendChild(h("div", { class: "row", style: "margin-bottom:12px" }, pill(on ? "Приём с подтверждением руководства" : "Новички входят сразу", on ? "acc" : "off"),
        btn(on ? "Выключить подтверждение" : "Включить подтверждение", function () { runToast("/approval " + (on ? "off" : "on"), f1).then(function () { refreshCounts().then(function () { route(true); }); }); }, "btn-sm")));
    }
    c1.appendChild(f1); c2.appendChild(f2);
    el.appendChild(h("div", { class: "grid g2" }, c1, c2));
    f1.onDone = f2.onDone = refreshCounts;
    return Promise.all([run("/pending", f1), run("/resets", f2)]);
  };

  PAGES.reports = function (el) {
    head(el, "Рапорты", "Рапорты сотрудников из программы: принять или отклонить можно кнопками");
    var feed = feedBox();
    var org = h("select", { style: "width:auto", "aria-label": "Организация" }, [h("option", { value: "", text: "Организация…" })].concat(DEPTS.map(function (d) { return h("option", { value: d, text: d }); })));
    org.addEventListener("change", function () { if (org.value) run("/reports " + org.value, feed, { clear: true }); });
    var num = h("input", { placeholder: "Номер или логин", maxlength: 24, style: "flex:0 1 200px", "aria-label": "Номер рапорта или логин" });
    var f = h("form", { class: "tools", novalidate: true }, btn("Новые", function () { run("/reports new", feed, { clear: true }); }, "btn-sm"), btn("Все", function () { run("/reports", feed, { clear: true }); }, "btn-sm"), org, num, h("button", { type: "submit", class: "btn btn-sm", text: "Открыть" }));
    f.addEventListener("submit", function (e) { e.preventDefault(); var v = num.value.trim(); if (!v) return; run(/^\d+$/.test(v) ? "/report " + v : "/reports " + v.replace(/\s/g, ""), feed, { clear: true }); });
    el.appendChild(f);
    el.appendChild(feed);
    feed.onDone = refreshCounts;
    return run("/reports new", feed);
  };

  PAGES.rating = function (el) {
    head(el, "Рейтинг", "Рейтинг недели и результаты контрольных тестов руководства");
    var feed = feedBox();
    var org = h("select", { style: "width:auto", "aria-label": "Организация" }, [h("option", { value: "", text: "Все организации" })].concat(DEPTS.map(function (d) { return h("option", { value: d, text: d }); })));
    var kind = h("select", { style: "width:auto", "aria-label": "Что считать" }, [["", "По опыту"], ["tests", "По тестам"], ["det", "По задержаниям"]].map(function (o) { return h("option", { value: o[0], text: o[1] }); }));
    function top() { run(["/top", org.value, kind.value].filter(Boolean).join(" "), feed, { clear: true }); }
    org.addEventListener("change", top); kind.addEventListener("change", top);
    el.appendChild(h("div", { class: "tools" }, org, kind, btn("Контрольные тесты", function () { run("/results", feed, { clear: true }); }, "btn-sm")));
    el.appendChild(feed);
    return run("/top", feed);
  };

  PAGES.news = function (el) {
    if (!ME.owner) return ownerOnly(el);
    head(el, "Рассылки", "Сообщения, которые пользователи увидят в программе при запуске и при сверке с сервером");
    var feed = feedBox();
    var to = h("select", { "aria-label": "Кому" }, [h("option", { value: "", text: "Всем пользователям" })].concat(DEPTS.map(function (d) { return h("option", { value: d, text: "Только " + d }); })));
    var text = h("textarea", { maxlength: 1500, placeholder: "Текст сообщения", rows: 5 });
    var f = h("form", { novalidate: true }, h("label", { class: "fld" }, h("span", { text: "Кому" }), to), h("label", { class: "fld" }, h("span", { text: "Сообщение" }), text, h("span", { class: "hint", text: "До 1500 знаков. Видно 7 дней, убрать можно раньше." })),
      h("button", { type: "submit", class: "btn btn-p", text: "Отправить" }));
    f.addEventListener("submit", function (e) {
      e.preventDefault();
      var t = text.value.replace(/\r/g, "").trim();
      if (!t) return toast("Напишите текст сообщения.", true);
      confirmDlg("Отправить рассылку", (to.value ? "Сотрудники " + to.value : "Все пользователи") + " увидят это сообщение в программе.", "Отправить", function () {
        run((to.value ? "/broadcast_org " + to.value + " " : "/broadcast ") + t, feed, { clear: true }).then(function (r) { if (r.ok) { text.value = ""; loadList(); } });
      });
    });
    var c = card("Новое сообщение");
    c.appendChild(f);
    c.appendChild(h("div", { style: "margin-top:12px" }, feed));
    var list = h("div");
    var c2 = card("Активные сообщения");
    c2.appendChild(list);
    el.appendChild(h("div", { class: "grid g2" }, c, c2));
    function loadList() {
      return api("db_rows", { table: "broadcasts" }).then(function (r) {
        list.textContent = "";
        if (!r.ok) return list.appendChild(errMsg(r));
        var act = r.rows.filter(function (x) { return new Date(x.expires_at).getTime() > Date.now(); });
        if (!act.length) return list.appendChild(h("p", { class: "muted", text: "Активных сообщений нет." }));
        act.forEach(function (x) {
          list.appendChild(h("div", { class: "msg", style: "margin-bottom:10px" },
            h("div", { class: "row", style: "justify-content:space-between;margin-bottom:6px" }, h("div", { class: "pills" }, pill("№" + x.id), pill(x.user_id ? "личное" + (x.title ? ": " + x.title : "") : x.org || "все", x.user_id ? "" : "acc"), pill("до " + fmt(x.expires_at))),
              btn("Убрать", function () { confirmDlg("Убрать сообщение", "Сообщение №" + x.id + " больше не будет показываться в программе.", "Убрать", function () { runToast("/unbroadcast " + x.id, feed).then(loadList); }, true); }, "btn-sm btn-d")),
            h("div", { text: x.text })));
        });
      });
    }
    return loadList();
  };

  PAGES.bugs = function (el) {
    if (!ME.owner) return ownerOnly(el);
    var all = false;
    var list = h("div", { class: "feed" });
    var tg = h("label", { class: "chk" }, h("input", { type: "checkbox", on: { change: function (e) { all = e.target.checked; load(); } } }), "Показывать с ответом");
    head(el, "Ошибки", "Сообщения об ошибках из программы. Ответ пользователь увидит в программе.", tg);
    el.appendChild(list);
    function load() {
      list.textContent = "";
      list.appendChild(h("div", { class: "load", text: "Загружаю…" }));
      return api("bugs", { all: all }).then(function (r) {
        list.textContent = "";
        if (!r.ok) return list.appendChild(errMsg(r));
        if (!r.rows.length) return list.appendChild(h("div", { class: "card empty", text: all ? "Сообщений нет." : "Все сообщения отвечены." }));
        r.rows.forEach(function (b) {
          var ta = h("textarea", { maxlength: 1500, rows: 3, placeholder: "Ответ пользователю" });
          var c = h("div", { class: "card" },
            h("div", { class: "row", style: "justify-content:space-between;margin-bottom:8px" }, h("div", { class: "pills" }, pill("№" + b.id), b.answered ? pill("отвечено", "on") : pill("ждёт ответа", "warn"), b.app_version ? pill(b.app_version) : null),
              h("span", { class: "muted small", text: fmt(b.at) })),
            h("p", { style: "margin-bottom:6px" }, b.login ? h("a", { href: "#user/" + encodeURIComponent(b.login), text: b.login }) : "аккаунт удалён", b.nick ? " · " + b.nick + " · " + b.org : ""),
            h("div", { class: "msg", style: "box-shadow:none;margin-bottom:12px", text: b.text }),
            b.log_len ? h("div", { style: "margin-bottom:12px" }, btn("Журнал программы (" + Math.max(1, Math.round(b.log_len / 1024)) + " КБ)", function () {
              api("bug_log", { id: b.id }).then(function (x) { if (x.ok) download(x.name, x.text, "text/plain;charset=utf-8"); else toast(x.error, true); });
            }, "btn-sm", "i-save")) : null);
          if (b.login) {
            var f = h("form", { novalidate: true }, ta, h("div", { class: "dlg-f" }, h("button", { type: "submit", class: "btn btn-p btn-sm", text: "Ответить" })));
            f.addEventListener("submit", function (e) {
              e.preventDefault();
              var t = ta.value.trim();
              if (!t) return toast("Напишите ответ.", true);
              api("bug_reply", { id: b.id, text: t }).then(function (x) { toast(x.ok ? "Ответ отправлен. Пользователь увидит его в программе." : x.error, !x.ok); if (x.ok) { refreshCounts(); load(); } });
            });
            c.appendChild(f);
          }
          list.appendChild(c);
        });
      });
    }
    return load();
  };

  PAGES.modes = function (el) {
    if (!ME.owner) return ownerOnly(el);
    head(el, "Режимы", "Технические работы, регистрация, приём новичков и уведомления");
    var feed = feedBox();
    var box = h("div", { class: "load", text: "Загружаю…" });
    el.appendChild(box);
    function act(cmd) { return runToast(cmd, feed).then(function () { return refreshCounts().then(function () { route(true); }); }); }
    return refreshCounts().then(function (d) {
      box.remove();
      if (!d.ok) return el.appendChild(errMsg(d));
      var m = d.modes;
      function mode(title, sub, on, onText, offText, body) {
        var c = h("div", { class: "card mode" }, h("div", { class: "hd" }, h("h3", { text: title }), pill(on ? onText : offText, on ? "on" : "off")), sub ? h("p", { class: "muted small", text: sub }) : null);
        add(c, body);
        return c;
      }
      var mt = h("textarea", { maxlength: 300, rows: 2, placeholder: "Текст для пользователей (необязательно)", value: (m.maintenance && m.maintenance.text) || "" });
      var mOn = !!(m.maintenance && m.maintenance.on);
      var lim = h("input", { type: "number", min: 0, max: 10000, value: (m.regs && m.regs.limit) || 0, style: "width:120px", "aria-label": "Лимит регистраций" });
      var regOpen = !(m.regs && m.regs.open === false);
      var sumT = h("input", { type: "time", value: (m.summary && m.summary.time) || "21:00", style: "width:130px", "aria-label": "Время сводки" });
      var ap = h("input", { maxlength: 200, value: (m.appeal && m.appeal.text) || "", placeholder: "По умолчанию: владельцу (Discord) или через «Сообщить об ошибке»" });
      var bw = h("input", { maxlength: 60, placeholder: "Слово", style: "flex:1 1 160px" });
      var bwf = h("form", { class: "row", novalidate: true }, bw, h("button", { type: "submit", class: "btn btn-sm", text: "Добавить" }));
      bwf.addEventListener("submit", function (e) { e.preventDefault(); var w = bw.value.trim(); if (w) act("/blacklist add " + w); });
      var grid = h("div", { class: "grid g2" },
        mode("Технические работы", "Пользователи видят «Идут технические работы», регистрация закрыта. Вы и модераторы работаете как обычно.", mOn, "включены", "выключены",
          [mt, h("div", { class: "row" }, mOn ? btn("Выключить", function () { act("/maintenance off"); }, "btn-p") : btn("Включить", function () { confirmDlg("Технические работы", "Включить режим технических работ? Пользователи не смогут работать в программе.", "Включить", function () { act("/maintenance on " + mt.value.replace(/\s+/g, " ").trim()); }, true); }, "btn-d"),
            mOn ? btn("Обновить текст", function () { act("/maintenance on " + mt.value.replace(/\s+/g, " ").trim()); }) : null)]),
        mode("Регистрация", "Закрытая регистрация не мешает входу уже зарегистрированных.", regOpen, "открыта", "закрыта",
          [h("div", { class: "row" }, btn(regOpen ? "Закрыть регистрацию" : "Открыть регистрацию", function () { act("/regs " + (regOpen ? "off" : "on")); }, regOpen ? "btn-d" : "btn-p")),
            h("div", { class: "row" }, h("span", { text: "Не больше в сутки:" }), lim, btn("Сохранить", function () { var n = parseInt(lim.value, 10) || 0; act("/reglimit " + (n > 0 ? n : "off")); }, "btn-sm"), h("span", { class: "muted small", text: "0 — без лимита" }))]),
        mode("Приём новичков", "Новый аккаунт ждёт, пока руководство его организации нажмёт «Принять».", !!(m.approval && m.approval.on), "с подтверждением", "сразу",
          [h("div", { class: "row" }, btn(m.approval && m.approval.on ? "Выключить подтверждение" : "Включить подтверждение", function () { act("/approval " + (m.approval && m.approval.on ? "off" : "on")); }), h("a", { class: "btn", href: "#queue", text: "Заявки" }))]),
        mode("Ежедневная сводка", "Приходит вам в Telegram в выбранное время (МСК).", !!(m.summary && m.summary.time), "в " + ((m.summary && m.summary.time) || ""), "выключена",
          [h("div", { class: "row" }, sumT, btn("Сохранить", function () { if (sumT.value) act("/summary " + sumT.value); }, "btn-sm"), btn("Выключить", function () { act("/summary off"); }, "btn-sm"), btn("Показать сейчас", function () { run("/summary now", feed, { clear: true }); feed.scrollIntoView({ behavior: "smooth" }); }, "btn-sm"))]),
        mode("Отчёт руководству", "Каждый понедельник в 12:00 МСК руководители с Telegram получают отчёт по своей организации.", !(m.orgreport && m.orgreport.on === false), "включён", "выключен",
          [h("div", { class: "row" }, btn(m.orgreport && m.orgreport.on === false ? "Включить" : "Выключить", function () { act("/orgreport " + (m.orgreport && m.orgreport.on === false ? "on" : "off")); }, "btn-sm"),
            h("select", { style: "width:auto", "aria-label": "Посмотреть отчёт", on: { change: function (e) { if (e.target.value) { run("/orgreport " + e.target.value, feed, { clear: true }); feed.scrollIntoView({ behavior: "smooth" }); } } } }, [h("option", { value: "", text: "Посмотреть отчёт…" })].concat(DEPTS.map(function (x) { return h("option", { value: x.toLowerCase(), text: x }); }))))]),
        mode("Вопросы к ИИ в Telegram", "Каждый вопрос к ИИ-помощнику приходит вам без звука.", !(m.ailog && m.ailog.on === false), "приходят", "не приходят",
          [h("div", { class: "row" }, btn(m.ailog && m.ailog.on === false ? "Включить" : "Выключить", function () { act("/ailog " + (m.ailog && m.ailog.on === false ? "on" : "off")); }, "btn-sm"), btn("Статистика за 7 дней", function () { run("/ailog 7", feed, { clear: true }); feed.scrollIntoView({ behavior: "smooth" }); }, "btn-sm"))]),
        mode("Куда обжаловать предупреждения", "Этот текст пользователь видит в уведомлении о предупреждении.", !!(m.appeal && m.appeal.text), "свой текст", "по умолчанию",
          [ap, h("div", { class: "row" }, btn("Сохранить", function () { var t = ap.value.replace(/\s+/g, " ").trim(); if (t) act("/appeal " + t); }, "btn-sm"), btn("Вернуть как было", function () { act("/appeal reset"); }, "btn-sm"))]),
        mode("Чёрный список слов", "Запрещённые слова в логинах и никах при регистрации и смене ника.", (m.blacklist || []).length > 0, (m.blacklist || []).length + " слов", "пусто",
          [h("div", { class: "pills" }, (m.blacklist || []).map(function (w) { return h("button", { type: "button", class: "pill", title: "Убрать", on: { click: function () { act("/blacklist del " + w); } } }, w + " ×"); })), bwf]),
        mode("Законы", "Законы проверяются на форуме каждый день сами. Здесь можно запустить проверку сразу.", true, "обновляются", "",
          [h("div", { class: "row" }, btn("Проверить сейчас", function () { run("/laws", feed, { clear: true }); feed.scrollIntoView({ behavior: "smooth" }); }, "btn-sm"), btn("История проверок", function () { run("/laws status", feed, { clear: true }); feed.scrollIntoView({ behavior: "smooth" }); }, "btn-sm"))]));
      el.appendChild(grid);
      el.appendChild(h("div", { class: "sec" }, feed));
    });
  };

  // Реклама: баннеры на сайте и на главной в программе. Картинку можно загрузить (сжимается здесь в webp) или дать ссылкой https://
  var AD_PLACE = { both: "сайт и программа", site: "только сайт", app: "только программа" };
  function adPreview(a) {
    var sq = a.style === "square";
    var img = a.image || "";
    return h("div", { class: "adp" + (sq ? " sq" : "") },
      img ? h("div", { class: "adp-img" }, h("img", { src: img, alt: "", loading: "lazy" })) : null,
      h("div", { class: "adp-b" },
        h("div", { class: "row", style: "gap:6px" }, pill(a.tag || "Реклама", "acc"), a.srv ? h("span", { class: "muted small", text: a.srv }) : null),
        h("h3", { text: a.title || "Без названия" }),
        a.body || a.text ? h("p", { class: "small", text: a.body || a.text }) : null,
        h("div", { class: "row", style: "gap:6px;margin-top:8px" },
          a.promo ? pill("Промокод " + a.promo, "warn") : null,
          (a.links || []).map(function (l) { return h("a", { class: "btn btn-sm", href: l.url, target: "_blank", rel: "noopener noreferrer", text: l.label || "Открыть" }); }))));
  }
  // Сжимаем картинку в webp, пока строка не станет меньше ~420 КБ
  function adImage(file, square) {
    return new Promise(function (ok, bad) {
      if (!file || !/^image\//.test(file.type)) return bad("Нужна картинка: PNG, JPG, WEBP или GIF.");
      if (file.size > 15 * 1024 * 1024) return bad("Файл больше 15 МБ.");
      var url = URL.createObjectURL(file), im = new Image();
      im.onload = function () {
        URL.revokeObjectURL(url);
        var max = square ? 640 : 1200, w = im.naturalWidth, hh = im.naturalHeight;
        if (!w || !hh) return bad("Не удалось прочитать картинку.");
        for (var step = 0; step < 6; step++) {
          var k = Math.min(1, max / Math.max(w, hh)), c = document.createElement("canvas");
          c.width = Math.max(1, Math.round(w * k)); c.height = Math.max(1, Math.round(hh * k));
          c.getContext("2d").drawImage(im, 0, 0, c.width, c.height);
          var d = c.toDataURL("image/webp", step < 3 ? 0.86 - step * 0.1 : 0.6);
          if (!/^data:image\/webp/.test(d)) d = c.toDataURL("image/jpeg", 0.82 - step * 0.08);
          if (d.length <= 430000) return ok(d);
          max = Math.round(max * 0.8);
        }
        bad("Картинка не сжимается до 400 КБ, возьмите поменьше.");
      };
      im.onerror = function () { URL.revokeObjectURL(url); bad("Не удалось открыть картинку."); };
      im.src = url;
    });
  }
  function adEdit(a, done) {
    a = a || { style: "wide", place: "both", enabled: true, tag: "Реклама", links: [], sort: 0 };
    var image = a.image || "";
    var err = h("div", { class: "auth-err" });
    function inp(k, v, max, ph, type) { return h("input", { type: type || "text", maxlength: max, placeholder: ph || "", value: v == null ? "" : v, spellcheck: "false", "data-ak": k }); }
    function lab(t, el, hint) { return h("label", { class: "fld" }, h("span", { text: t }), el, hint ? h("span", { class: "hint", text: hint }) : null); }
    var title = inp("title", a.title, 80, "Senko Family");
    var srv = inp("srv", a.srv, 80, "Majestic RP · Los Angeles");
    var text = h("textarea", { maxlength: 400, rows: 3, placeholder: "Пара предложений о партнёре", value: a.body || "" });
    var tag = inp("tag", a.tag || "Реклама", 24);
    var promo = inp("promo", a.promo, 24, "Например, Senko");
    var sort = inp("sort", a.sort || 0, 5, "", "number");
    var style = h("select", { value: a.style }, [["wide", "Широкий: картинка слева"], ["square", "Квадратный: картинка сверху"]].map(function (o) { return h("option", { value: o[0], text: o[1] }); }));
    var place = h("select", { value: a.place }, [["both", "На сайте и в программе"], ["site", "Только на сайте"], ["app", "Только в программе"]].map(function (o) { return h("option", { value: o[0], text: o[1] }); }));
    var on = h("input", { type: "checkbox" }); on.checked = a.enabled !== false;
    var links = [0, 1, 2, 3].map(function (i) { var l = (a.links || [])[i] || {}; return [inp("ll" + i, l.label, 40, i === 0 ? "Discord" : "Подпись"), inp("lu" + i, l.url, 500, "https://…")]; });
    var imgUrl = inp("img", /^data:/.test(image) ? "" : image, 500, "https://… или оставьте пустым и загрузите файл");
    var file = h("input", { type: "file", accept: "image/png,image/jpeg,image/webp,image/gif" });
    var imgInfo = h("span", { class: "hint" });
    var prev = h("div", { class: "adp-wrap" });
    function vals() {
      return { id: a.id || 0, title: title.value.trim(), srv: srv.value.trim(), text: text.value.replace(/\s+/g, " ").trim(), tag: tag.value.trim(), promo: promo.value.trim(),
        sort: parseInt(sort.value, 10) || 0, style: style.value, place: place.value, enabled: on.checked, image: imgUrl.value.trim() || image,
        links: links.map(function (l) { return { label: l[0].value.trim(), url: l[1].value.trim() }; }).filter(function (l) { return l.url; }) };
    }
    function paint() {
      var v = vals();
      imgInfo.textContent = /^data:/.test(v.image) ? "Загружен файл, " + Math.round(v.image.length * 0.75 / 1024) + " КБ." : v.image ? "Картинка по ссылке." : "Без картинки.";
      prev.textContent = ""; prev.appendChild(adPreview({ title: v.title, srv: v.srv, text: v.text, tag: v.tag, promo: v.promo, style: v.style, image: v.image, links: v.links }));
    }
    file.addEventListener("change", function () {
      var f = file.files && file.files[0];
      if (!f) return;
      imgInfo.textContent = "Сжимаю…";
      adImage(f, style.value === "square").then(function (d) { image = d; imgUrl.value = ""; paint(); }, function (m) { err.textContent = m; paint(); });
    });
    var f = h("form", { novalidate: true },
      h("div", { class: "grid g2" }, lab("Название", title), lab("Подпись сверху", srv, "Сервер или вид проекта")),
      lab("Текст", text),
      h("div", { class: "grid g2" }, lab("Вид", style), lab("Где показывать", place)),
      h("div", { class: "grid g2" }, lab("Метка", tag, "Обычно «Реклама»"), lab("Промокод", promo, "Кнопка «Скопировать», можно пусто")),
      h("div", { class: "fld" }, h("span", { text: "Ссылки" }), links.map(function (l) { return h("div", { class: "row", style: "margin-bottom:6px" }, h("div", { style: "flex:0 1 160px" }, l[0]), h("div", { class: "grow" }, l[1])); }),
        h("span", { class: "hint", text: "До 4 кнопок. Discord и Telegram сами получат свой цвет." })),
      h("div", { class: "fld" }, h("span", { text: "Картинка" }), h("div", { class: "row" }, file, image ? btn("Убрать картинку", function () { image = ""; imgUrl.value = ""; paint(); }, "btn-sm") : null), imgUrl, imgInfo),
      h("div", { class: "grid g2" }, lab("Порядок", sort, "Меньше число — выше"), h("label", { class: "chk", style: "margin-top:22px" }, on, "Показывать")),
      h("div", { class: "fld" }, h("span", { text: "Как будет выглядеть" }), prev),
      err,
      h("div", { class: "dlg-f" }, btn("Отмена", closeDlg), h("button", { type: "submit", class: "btn btn-p", text: a.id ? "Сохранить" : "Добавить" })));
    f.addEventListener("input", paint);
    f.addEventListener("change", paint);
    f.addEventListener("submit", function (e) {
      e.preventDefault();
      var v = vals();
      if (!v.title) { err.textContent = "Укажите название."; return; }
      var badUrl = v.links.filter(function (l) { return !/^https:\/\/\S+$/i.test(l.url); })[0];
      if (badUrl) { err.textContent = "Ссылка должна начинаться с https://"; return; }
      if (v.image && !/^data:image\//.test(v.image) && !/^\/img\//.test(v.image) && !/^https:\/\/\S+$/i.test(v.image)) { err.textContent = "Ссылка на картинку должна начинаться с https://"; return; }
      var go = f.querySelector("button[type=submit]");
      go.disabled = true; err.textContent = "";
      api("ads_save", v).then(function (r) {
        go.disabled = false;
        if (!r.ok) { err.textContent = r.error || "Не получилось сохранить."; return; }
        closeDlg(); toast(a.id ? "Баннер сохранён." : "Баннер добавлен."); done();
      });
    });
    dlg(a.id ? "Баннер: " + a.title : "Новый баннер", f, true);
    paint();
  }
  PAGES.ads = function (el) {
    if (!ME.owner) return ownerOnly(el);
    var box = h("div");
    function load() {
      box.textContent = "";
      box.appendChild(h("div", { class: "load", text: "Загружаю…" }));
      return api("ads_list").then(function (r) {
        box.textContent = "";
        if (!r.ok) return box.appendChild(errMsg(r));
        if (!r.rows.length) return box.appendChild(h("div", { class: "card" }, h("p", { text: "Баннеров нет. Блок «Реклама» на сайте и в программе сейчас скрыт." })));
        box.appendChild(h("div", { class: "grid g2" }, r.rows.map(function (a) {
          return h("div", { class: "card ad-card" + (a.enabled ? "" : " off") },
            h("div", { class: "row", style: "justify-content:space-between;margin-bottom:10px" },
              h("div", { class: "row", style: "gap:6px" }, pill(a.enabled ? "показывается" : "выключен", a.enabled ? "on" : "off"), pill(AD_PLACE[a.place] || a.place), pill(a.style === "square" ? "квадратный" : "широкий")),
              h("span", { class: "muted small", text: "порядок " + a.sort })),
            adPreview(a),
            h("p", { class: "muted small", style: "margin-top:10px", text: "Изменён " + ago(a.updated_at) + (a.updated_by ? ", " + a.updated_by : "") }),
            h("div", { class: "row", style: "margin-top:10px" },
              btn(a.enabled ? "Выключить" : "Включить", function () { api("ads_toggle", { id: a.id, enabled: !a.enabled }).then(function (y) { toast(y.ok ? (y.row.enabled ? "Баннер включён." : "Баннер выключен.") : y.error, !y.ok); load(); }); }, "btn-sm" + (a.enabled ? "" : " btn-p")),
              btn("Изменить", function () { adEdit(a, load); }, "btn-sm"),
              btn("Удалить", function () { confirmDlg("Удалить баннер", "Удалить «" + a.title + "» насовсем? Если нужно спрятать на время, лучше выключить.", "Удалить", function () { api("ads_delete", { id: a.id }).then(function (y) { toast(y.ok ? "Баннер удалён." : y.error, !y.ok); load(); }); }, true); }, "btn-sm btn-d")));
        })));
      });
    }
    head(el, "Реклама", "Баннеры на сайте и на главной странице программы. Изменения видны в течение 10 минут.",
      h("div", { class: "row" }, btn("Обновить", load, "btn-sm", "i-refresh"), btn("Добавить баннер", function () { adEdit(null, load); }, "btn-sm btn-p", "i-ad")));
    el.appendChild(box);
    return load();
  };

  // 2.4: бета-тестеры (роль, задания, режимы функций) и идеи пользователей
  var FLAG_MODE = [["all", "всем"], ["beta", "только тестерам"], ["off", "выключено"]];
  function betaTask(t, after) {
    var f = h("form", { novalidate: true }), err = h("div", { class: "auth-err" });
    var ti = h("input", { maxlength: 120, value: t ? t.title : "", placeholder: "Например: проверить мини-окно задержания" });
    var bo = h("textarea", { maxlength: 1500, placeholder: "Что сделать и на что смотреть" });
    bo.value = t ? t.body || "" : "";
    var cl = h("select", null, h("option", { value: "", text: "открыто" }), h("option", { value: "1", text: "закрыто" }));
    cl.value = t && t.closed ? "1" : "";
    f.appendChild(h("label", { class: "fld" }, h("span", { text: "Что проверить" }), ti));
    f.appendChild(h("label", { class: "fld" }, h("span", { text: "Подробности" }), bo, h("span", { class: "hint", text: t ? "" : "Тестеры с Telegram получат уведомление." })));
    if (t) f.appendChild(h("label", { class: "fld" }, h("span", { text: "Состояние" }), cl));
    f.appendChild(err);
    f.appendChild(h("div", { class: "dlg-f" }, btn("Отмена", closeDlg), h("button", { type: "submit", class: "btn btn-p", text: t ? "Сохранить" : "Создать" })));
    f.addEventListener("submit", function (e) {
      e.preventDefault();
      api("beta_task_save", { id: t ? t.id : 0, title: ti.value, body: bo.value, closed: cl.value === "1" }).then(function (y) {
        if (!y.ok) { err.textContent = y.error; return; }
        closeDlg(); toast(t ? "Задание сохранено." : "Задание создано."); after();
      });
    });
    dlg(t ? "Задание: " + t.title : "Новое задание", f, true);
  }
  function betaResults(t) {
    dlg("Результаты: " + t.title, h("div", { class: "load", text: "Загружаю…" }), true);
    api("beta_task", { id: t.id }).then(function (r) {
      if (!r.ok) return dlg("Результаты", errMsg(r));
      dlg("Результаты: " + t.title, r.results.length ? h("div", { class: "tbl-wrap", style: "box-shadow:none" }, h("table", { class: "tbl" }, h("tbody", null, r.results.map(function (x) {
        return h("tr", { style: "cursor:default" }, h("td", null, pill(x.status === "ok" ? "работает" : "есть проблема", x.status === "ok" ? "on" : "bad")),
          h("td", null, h("b", { text: x.login }), h("div", { class: "muted small", text: x.nick })), h("td", { class: "small", text: x.comment || "—", style: "white-space:pre-wrap" }), h("td", { class: "mono small muted", text: fmt(x.at) }));
      })))) : h("p", { class: "muted", text: "Пока никто не отметил результат." }), true);
    });
  }
  PAGES.beta = function (el) {
    var box = h("div");
    function load() {
      box.textContent = "";
      box.appendChild(h("div", { class: "load", text: "Загружаю…" }));
      return api("beta_list").then(function (r) {
        box.textContent = "";
        if (!r.ok) return box.appendChild(errMsg(r));
        var g = h("div", { class: "grid g2" });
        // тестеры
        var U = card("Бета-тестеры", "Видят «Панель тестера» в программе, получают задания и функции в режиме «только тестерам».");
        var gi = h("input", { maxlength: 40, placeholder: "логин", spellcheck: "false" });
        var gf = h("form", { class: "row", novalidate: true }, gi, h("button", { type: "submit", class: "btn btn-sm btn-p", text: "Выдать роль" }));
        gf.addEventListener("submit", function (e) {
          e.preventDefault();
          var L = gi.value.trim(); if (!L) return;
          api("beta_set", { login: L, on: true }).then(function (y) { toast(y.ok ? "Роль тестера выдана: " + L + "." : y.error, !y.ok); if (y.ok) load(); });
        });
        U.appendChild(gf);
        if (!r.users.length) U.appendChild(h("p", { class: "muted", style: "margin-top:12px", text: "Тестеров пока нет. Роль можно выдать здесь, на странице пользователя или командой бота /beta логин on." }));
        else U.appendChild(h("div", { class: "tbl-wrap", style: "box-shadow:none;margin-top:12px" }, h("table", { class: "tbl" }, h("tbody", null, r.users.map(function (u) {
          return h("tr", { on: { click: function (e) { if (e.target.closest("button")) return; location.hash = "#user/" + encodeURIComponent(u.login); } } },
            h("td", null, h("b", { text: u.login }), h("div", { class: "muted small", text: u.nick + " · " + u.org })),
            h("td", { class: "small muted", text: (u.app_version ? "v" + u.app_version + " · " : "") + "отметок: " + u.results }),
            h("td", { class: "small muted", text: u.last_seen ? ago(u.last_seen) : "—" }),
            h("td", null, btn("Снять", function () {
              confirmDlg("Снять роль тестера", "Снять роль «Бета-тестер» с " + u.login + "? «Панель тестера» у него пропадёт.", "Снять", function () {
                api("beta_set", { login: u.login, on: false }).then(function (y) { toast(y.ok ? "Роль снята." : y.error, !y.ok); load(); });
              }, true);
            }, "btn-sm")));
        })))));
        g.appendChild(U);
        // функции
        var F = card("Функции 2.4", r.canFlags ? "«Только тестерам» — функция видна лишь бета-тестерам. Изменения доходят до программы за минуту." : "Режимы меняет владелец.");
        Object.keys(r.defs).forEach(function (k) {
          var cur = r.flags[k], ctl;
          if (r.canFlags) {
            ctl = h("select", { style: "max-width:180px" }, FLAG_MODE.map(function (m) { return h("option", { value: m[0], text: m[1] }); }));
            ctl.value = cur;
            ctl.addEventListener("change", function () { api("flags_set", { key: k, mode: ctl.value }).then(function (y) { toast(y.ok ? "Сохранено." : y.error, !y.ok); if (!y.ok) ctl.value = cur; else cur = ctl.value; }); });
          } else ctl = pill(FLAG_MODE.filter(function (m) { return m[0] === cur; })[0][1], cur === "all" ? "on" : cur === "off" ? "off" : "acc");
          F.appendChild(h("div", { class: "row", style: "justify-content:space-between;padding:8px 0;border-bottom:1px solid var(--line)" }, h("span", { text: r.defs[k] }), ctl));
        });
        g.appendChild(F);
        box.appendChild(g);
        // задания
        var T = card("Задания для тестеров", "Тестеры отмечают в программе: «работает» или «есть проблема» с комментарием.");
        T.style.marginTop = "14px";
        T.appendChild(h("div", { class: "row", style: "margin-bottom:12px" }, btn("Новое задание", function () { betaTask(null, load); }, "btn-sm btn-p")));
        if (!r.tasks.length) T.appendChild(h("p", { class: "muted", text: "Заданий нет." }));
        else T.appendChild(h("div", { class: "tbl-wrap", style: "box-shadow:none" }, h("table", { class: "tbl" }, h("tbody", null, r.tasks.map(function (t) {
          return h("tr", { style: "cursor:default" + (t.closed ? ";opacity:.6" : "") },
            h("td", null, h("b", { text: t.title }), t.body ? h("div", { class: "muted small", text: t.body.length > 140 ? t.body.slice(0, 140) + "…" : t.body }) : null),
            h("td", null, h("div", { class: "pills" }, t.closed ? pill("закрыто", "off") : null, pill("✓ " + t.ok_n, "on"), pill("✗ " + t.bad_n, t.bad_n ? "bad" : ""))),
            h("td", null, h("div", { class: "row", style: "gap:6px;flex-wrap:nowrap" },
              btn("Результаты", function () { betaResults(t); }, "btn-sm"),
              btn("Изменить", function () { betaTask(t, load); }, "btn-sm"),
              btn("Удалить", function () { confirmDlg("Удалить задание", "Удалить «" + t.title + "» вместе с отметками тестеров?", "Удалить", function () { api("beta_task_delete", { id: t.id }).then(function (y) { toast(y.ok ? "Задание удалено." : y.error, !y.ok); load(); }); }, true); }, "btn-sm btn-d"))));
        })))));
        box.appendChild(T);
      });
    }
    head(el, "Тестеры", "Роль «Бета-тестер», задания и функции, которые видят только тестеры", btn("Обновить", load, "btn-sm", "i-refresh"));
    el.appendChild(box);
    return load();
  };
  var IDEAS = { status: "", sort: "top" };
  var IDEA_PILL = { new: "", work: "acc", done: "on", no: "off" };
  function ideaEdit(x, st, after) {
    var s = h("select", null, Object.keys(st).map(function (k) { return h("option", { value: k, text: st[k] }); }));
    s.value = x.status;
    var a = h("textarea", { maxlength: 600, placeholder: "Необязательно. Автор увидит ответ в программе." });
    a.value = x.answer || "";
    var err = h("div", { class: "auth-err" });
    var f = h("form", { novalidate: true }, h("p", { text: x.text, style: "white-space:pre-wrap;margin-bottom:12px" }),
      h("label", { class: "fld" }, h("span", { text: "Статус" }), s), h("label", { class: "fld" }, h("span", { text: "Ответ автору" }), a), err,
      h("div", { class: "dlg-f" }, btn("Отмена", closeDlg), h("button", { type: "submit", class: "btn btn-p", text: "Сохранить" })));
    f.addEventListener("submit", function (e) {
      e.preventDefault();
      api("ideas_set", { id: x.id, status: s.value, answer: a.value }).then(function (y) { if (!y.ok) { err.textContent = y.error; return; } closeDlg(); toast("Сохранено. Автор получит уведомление в программе."); after(); });
    });
    dlg("Идея №" + x.id, f, true);
  }
  PAGES.ideas = function (el) {
    var box = h("div"), bar = h("div", { class: "row", style: "margin-bottom:14px" });
    function load() {
      box.textContent = "";
      box.appendChild(h("div", { class: "load", text: "Загружаю…" }));
      return api("ideas_list", IDEAS).then(function (r) {
        box.textContent = ""; bar.textContent = "";
        if (!r.ok) return box.appendChild(errMsg(r));
        [["", "Все"]].concat(Object.keys(r.statuses).map(function (k) { return [k, r.statuses[k]]; })).forEach(function (o) {
          bar.appendChild(btn(o[1], function () { IDEAS.status = o[0]; load(); }, "btn-sm" + (IDEAS.status === o[0] ? " btn-p" : "")));
        });
        bar.appendChild(btn(IDEAS.sort === "top" ? "Сначала популярные" : "Сначала новые", function () { IDEAS.sort = IDEAS.sort === "top" ? "new" : "top"; load(); }, "btn-sm"));
        if (!r.ideas.length) return box.appendChild(h("div", { class: "card" }, h("p", { text: "Идей нет." })));
        box.appendChild(h("div", { class: "grid g2" }, r.ideas.map(function (x) {
          return h("div", { class: "card" },
            h("div", { class: "row", style: "justify-content:space-between;margin-bottom:8px" }, h("div", { class: "pills" }, pill(r.statuses[x.status] || x.status, IDEA_PILL[x.status]), pill("▲ " + x.votes)), h("span", { class: "muted small", text: ago(x.at) })),
            h("p", { text: x.text, style: "white-space:pre-wrap;word-break:break-word" }),
            x.answer ? h("p", { class: "small", style: "margin-top:8px;padding:8px 10px;border-left:3px solid var(--accent);background:var(--soft)", text: "Ответ: " + x.answer }) : null,
            h("p", { class: "muted small", style: "margin-top:8px", text: x.login ? x.login + " · " + x.nick + " · " + x.org : "автор удалён" }),
            h("div", { class: "row", style: "margin-top:10px" }, btn("Статус и ответ", function () { ideaEdit(x, r.statuses, load); }, "btn-sm btn-p"),
              btn("Удалить", function () { confirmDlg("Удалить идею", "Удалить идею вместе с голосами?", "Удалить", function () { api("ideas_delete", { id: x.id }).then(function (y) { toast(y.ok ? "Идея удалена." : y.error, !y.ok); load(); }); }, true); }, "btn-sm btn-d")));
        })));
      });
    }
    head(el, "Идеи", "Предложения пользователей из программы: голоса, статус и ответ автору", btn("Обновить", load, "btn-sm", "i-refresh"));
    el.appendChild(bar);
    el.appendChild(box);
    return load();
  };

  // База данных: только разрешённые таблицы и поля; каждая правка с прежними значениями попадает в журнал
  var DBS = { table: "profiles", q: "", page: 0 };
  var DB_COLS = {
    profiles: ["login", "nick", "static_id", "org", "rank", "banned", "approval", "last_seen"],
    bot_settings: ["key", "value", "updated_at"],
    broadcasts: ["id", "org", "title", "text", "expires_at"],
    account_notes: ["id", "user_login", "author", "text", "at"],
    account_warns: ["id", "user_login", "author", "reason", "at"],
    bug_reports: ["id", "user_login", "text", "answered", "at"],
    reports: ["id", "org", "author", "title", "status", "created_at"],
    shares: ["code", "kind", "author", "title", "views", "created_at"],
    search_misses: ["q", "n", "sends", "last_at"],
    bot_delayed: ["id", "actor_label", "command", "run_at"],
    achievements: ["user_login", "code", "at"],
    login_log: ["user_login", "at", "kind", "ver", "os", "ip"],
  };
  function cell(v) {
    if (v == null) return "—";
    if (typeof v === "boolean") return v ? "да" : "нет";
    if (Array.isArray(v)) return v.join(", ") || "—";
    if (typeof v === "object") return JSON.stringify(v);
    if (/^\d{4}-\d\d-\d\dT\d\d:\d\d/.test(v)) return fmt(v);
    return String(v);
  }
  PAGES.db = function (el, arg) {
    if (!ME.owner) return ownerOnly(el);
    if (arg && DB_COLS[arg] && arg !== DBS.table) { DBS.table = arg; DBS.q = ""; DBS.page = 0; }
    head(el, "База данных", "Просмотр и правка таблиц. Пароли, сессии и коды восстановления сюда не попадают.", h("a", { class: "btn btn-sm", href: "#audit/db", text: "История правок" }));
    var tabs = h("div", { class: "tabs" }), q = h("input", { type: "search", placeholder: "Поиск в таблице", value: DBS.q, maxlength: 60 });
    var list = h("div", null, h("div", { class: "load", text: "Загружаю…" }));
    el.appendChild(tabs);
    el.appendChild(h("div", { class: "tools" }, h("label", { class: "search" }, ico("i-search"), q)));
    el.appendChild(list);
    var T = {}, tt = 0;
    q.addEventListener("input", function () { clearTimeout(tt); tt = setTimeout(function () { DBS.q = q.value.trim(); DBS.page = 0; rows(); }, 300); });
    function rows() {
      return api("db_rows", DBS).then(function (r) {
        list.textContent = "";
        if (!r.ok) return list.appendChild(errMsg(r));
        if (!r.rows.length) return list.appendChild(h("div", { class: "card empty", text: "Записей нет." }));
        var cols = DB_COLS[DBS.table] || Object.keys(r.rows[0]).slice(0, 6);
        list.appendChild(h("div", { class: "tbl-wrap" }, h("table", { class: "tbl" },
          h("thead", null, h("tr", null, cols.map(function (c) { return h("th", { text: c }); }))),
          h("tbody", null, r.rows.map(function (x) {
            return h("tr", { tabindex: 0, on: { click: function () { edit(x); }, keydown: function (e) { if (e.key === "Enter") edit(x); } } }, cols.map(function (c) { return h("td", { class: "c", text: cell(x[c]), title: cell(x[c]) }); }));
          })))));
        list.appendChild(h("div", { class: "pager" }, btn("← Назад", function () { DBS.page--; rows(); }, "btn-sm"), h("span", { text: "стр. " + (r.page + 1) }), btn("Дальше →", function () { DBS.page++; rows(); }, "btn-sm")));
        var pb = list.querySelectorAll(".pager button");
        pb[0].disabled = r.page === 0; pb[1].disabled = !r.more;
        if (!r.page && !r.more) { pb[0].hidden = pb[1].hidden = true; }
      });
    }
    function edit(x) {
      var t = T[DBS.table];
      var types = (t && t.types) || {};
      var key = t && t.key ? x[t.key] : null;
      var inputs = {};
      var body = [];
      var ro = {};
      Object.keys(x).forEach(function (c) {
        var ty = types[c];
        if (!ty || !key) { ro[c] = x[c]; return; }
        var v = x[c], inp;
        if (Array.isArray(ty)) inp = h("select", null, ty.map(function (o) { return h("option", { value: o, text: o }); }));
        else if (ty === "bool") inp = h("select", null, h("option", { value: "true", text: "да" }), h("option", { value: "false", text: "нет" }));
        else if (ty === "long" || ty === "json") inp = h("textarea", { rows: ty === "json" ? 8 : 4, class: ty === "json" ? "mono" : "" });
        else if (ty === "time") inp = h("input", { type: "datetime-local" });
        else if (ty === "int") inp = h("input", { type: "number", min: 0 });
        else inp = h("input", { maxlength: 500 });
        if (ty === "bool") inp.value = v ? "true" : "false";
        else if (ty === "json") inp.value = JSON.stringify(v, null, 2);
        else if (ty === "tags") inp.value = (v || []).join(" ");
        else if (ty === "time") inp.value = v ? new Date(new Date(v).getTime() - new Date(v).getTimezoneOffset() * 60000).toISOString().slice(0, 16) : "";
        else inp.value = v == null ? "" : v;
        inputs[c] = { el: inp, ty: ty, orig: inp.value };
        body.push(h("label", { class: "fld" }, h("span", null, c, h("em", { text: ty === "tags" ? "через пробел" : ty === "time" ? "ваше время; пусто — нет" : Array.isArray(ty) ? "" : "" })), inp));
      });
      body.push(h("details", null, h("summary", { text: "Остальные поля (только чтение)" }), h("pre", { class: "json", text: JSON.stringify(ro, null, 2) })));
      var err = h("div", { class: "auth-err" });
      body.push(err);
      var foot = h("div", { class: "dlg-f" });
      if (t && t.del && key != null) foot.appendChild(btn("Удалить запись", function () {
        confirmDlg("Удалить запись", "Удалить запись " + key + " из таблицы «" + t.title + "»? Её содержимое сохранится в журнале.", "Удалить", function () {
          api("db_delete", { table: DBS.table, key: String(key) }).then(function (r) { toast(r.ok ? "Запись удалена." : r.error, !r.ok); rows(); });
        }, true);
      }, "btn-d"));
      foot.appendChild(btn(key ? "Отмена" : "Закрыть", closeDlg));
      if (key != null && Object.keys(inputs).length) foot.appendChild(btn("Сохранить", function () {
        var vals = {}, n = 0;
        for (var c in inputs) {
          var i = inputs[c], v = i.el.value;
          if (v === i.orig) continue;
          n++;
          if (i.ty === "bool") vals[c] = v === "true";
          else if (i.ty === "int") vals[c] = parseInt(v, 10);
          else if (i.ty === "tags") vals[c] = v.split(/[\s,]+/).filter(Boolean);
          else if (i.ty === "time") vals[c] = v ? new Date(v).toISOString() : null;
          else vals[c] = v;
        }
        if (!n) return closeDlg();
        api("db_save", { table: DBS.table, key: String(key), values: vals }).then(function (r) {
          if (!r.ok) { err.textContent = r.error; return; }
          closeDlg(); toast("Сохранено. Прежние значения — в журнале, их можно вернуть."); rows();
        });
      }, "btn-p"));
      body.push(foot);
      if (!key) body.unshift(h("p", { class: "muted small", style: "margin-bottom:10px", text: "Эту таблицу можно только смотреть." }));
      dlg((t ? t.title : DBS.table) + (key != null ? " · " + (x.login || key) : ""), body, true);
    }
    return api("db_tables").then(function (r) {
      if (!r.ok) { list.textContent = ""; return list.appendChild(errMsg(r)); }
      r.tables.forEach(function (t) {
        T[t.name] = t;
        tabs.appendChild(h("button", { type: "button", class: "tab" + (t.name === DBS.table ? " on" : ""), on: { click: function () { location.hash = "#db/" + t.name; } } }, t.title, h("small", { text: String(t.rows) })));
      });
      return rows();
    });
  };

  PAGES.backup = function (el) {
    if (!ME.owner) return ownerOnly(el);
    head(el, "Резервная копия", "Профили, заметки, предупреждения, настройки и данные за последние сутки в одном файле");
    var feed = feedBox();
    var c = card("Скачать резервную копию", "Файл зашифрован паролем из секрета BACKUP_KEY. Расшифровка на компьютере: node tools/decrypt-backup.js файл");
    c.appendChild(h("div", { class: "row" }, btn("Сделать копию", function () { run("/backup", feed, { clear: true }); }, "btn-p", "i-save"), h("span", { class: "muted small", text: "Не чаще 6 раз в час. Запись о копии попадает в журнал." })));
    c.appendChild(h("div", { style: "margin-top:14px" }, feed));
    el.appendChild(c);
    var c2 = card("Что ещё сохраняется само", null);
    c2.appendChild(h("p", { class: "muted", text: "Каждая правка в разделе «База данных» записывает прежние значения в журнал, а удалённая запись хранится там целиком. Изменения законов и данных пользователей сохраняются в программе (Настройки → Данные)." }));
    el.appendChild(c2);
  };

  var ACT_RU = { ban: "блокировка", unban: "разблокировка", tempban: "блокировка на срок", tempban_end: "конец блокировки", autoban: "автоблокировка", warn: "предупреждение", unwarn: "снято предупреждение", kick: "завершены сессии", note: "заметка", tag: "тег", untag: "убран тег", role: "роль", rename: "ник", setstatic: "статик", setorg: "организация", delete: "удаление аккаунта", profile_update: "изменение профиля", password_reset: "сброс пароля", reset_approve: "сброс подтверждён", reset_reject: "сброс отклонён", broadcast: "рассылка", maintenance: "техработы", regs: "регистрация", reglimit: "лимит регистраций", blacklist: "чёрный список", appeal: "обжалование", delay: "отложенная команда", backup: "резервная копия", laws: "законы", approve: "заявка принята", reject: "заявка отклонена", approval: "приём новичков", shift_start: "начало смены", shift_end: "конец смены", ctrl_create: "контрольный тест", sync_reset: "сброс синхронизации", report_create: "рапорт", report_delete: "рапорт удалён", report_review: "рапорт проверен", panel_login: "вход в панель", panel_key: "пароль панели", panel_revoke: "закрыт вход в панель", db_edit: "правка базы", db_delete: "удаление из базы", db_revert: "возврат правки", ad_save: "баннер сохранён", ad_toggle: "баннер вкл/выкл", ad_delete: "баннер удалён" };
  PAGES.audit = function (el, arg) {
    if (!ME.owner) return ownerOnly(el);
    var S = { q: arg === "db" ? "db_edit" : "", page: 0 };
    head(el, "Журнал", "Кто, когда и что сделал: бот, программа и панель");
    var q = h("input", { type: "search", placeholder: "Логин или кто сделал", maxlength: 40 });
    var sel = h("select", { style: "width:auto", "aria-label": "Действие" }, [h("option", { value: "", text: "Все действия" })]);
    var list = h("div", { class: "card", style: "padding:0" }, h("div", { class: "load", text: "Загружаю…", style: "padding:20px" }));
    var pager = h("div", { class: "pager" });
    el.appendChild(h("div", { class: "tools" }, h("label", { class: "search" }, ico("i-search"), q), sel));
    el.appendChild(list); el.appendChild(pager);
    var t = 0;
    q.addEventListener("input", function () { clearTimeout(t); t = setTimeout(function () { S.q = q.value.trim(); sel.value = ""; S.page = 0; load(); }, 300); });
    sel.addEventListener("change", function () { S.q = sel.value; q.value = ""; S.page = 0; load(); });
    function load() {
      return api("audit", S).then(function (r) {
        list.textContent = ""; pager.textContent = "";
        if (!r.ok) return list.appendChild(errMsg(r));
        if (sel.options.length === 1) r.actions.forEach(function (a) { sel.appendChild(h("option", { value: a, text: ACT_RU[a] || a })); });
        if (S.q && r.actions.indexOf(S.q) >= 0) sel.value = S.q;
        if (!r.rows.length) return list.appendChild(h("div", { class: "empty", text: "Записей нет." }));
        var al = h("div", { class: "alog" });
        r.rows.forEach(function (x) {
          var d = x.details && Object.keys(x.details).length ? x.details : null;
          al.appendChild(h("div", { class: "aitem" }, h("div", { class: "when", text: fmt(x.at) }),
            h("div", null, h("div", null, h("b", { text: x.actor }), " · ", ACT_RU[x.action] || x.action, x.target ? " · " : "", x.target ? h("span", { class: "mono small", text: x.target }) : null),
              d ? h("details", null, h("summary", { text: "подробности" }), h("pre", { class: "json", text: JSON.stringify(d, null, 2) })) : null,
              x.action === "db_edit" ? btn("Вернуть как было", function () { confirmDlg("Вернуть правку", "Вернуть прежние значения полей для " + x.target + "?", "Вернуть", function () { api("db_revert", { id: x.id }).then(function (y) { toast(y.ok ? "Значения возвращены." : y.error, !y.ok); load(); }); }); }, "btn-sm") : null)));
        });
        list.appendChild(al);
        pager.appendChild(btn("← Новее", function () { S.page--; load(); }, "btn-sm"));
        pager.appendChild(h("span", { text: "стр. " + (r.page + 1) }));
        pager.appendChild(btn("Старее →", function () { S.page++; load(); }, "btn-sm"));
        var pb = pager.querySelectorAll("button");
        pb[0].disabled = r.page === 0; pb[1].disabled = !r.more;
        if (!r.page && !r.more) { pb[0].hidden = pb[1].hidden = true; }
      });
    }
    return load();
  };

  var HIST = [];
  try { HIST = JSON.parse(ss("sa-panel-hist") || "[]"); } catch (e) {}
  PAGES.console = function (el) {
    head(el, "Консоль бота", "Те же команды, что в Telegram. Ответы бота и кнопки появятся здесь.");
    var feed = feedBox();
    var Q = ["/help", "/find ", "/user ", "/online", "/resets", "/pending", "/reports new", "/health", "/jobs"];
    if (ME.owner) Q.push("/stats", "/broadcasts", "/audit");
    var inp = h("input", { placeholder: "/команда", maxlength: 1600, spellcheck: "false", autocomplete: "off", "aria-label": "Команда" });
    el.appendChild(h("div", { class: "quick" }, Q.map(function (c) { return btn(c.trim(), function () { if (/ $/.test(c)) { inp.value = c; inp.focus(); } else go(c); }, "btn-sm"); })));
    el.appendChild(feed);
    var hi = -1;
    function go(t) {
      t = t.trim();
      if (!t) return;
      if (t[0] !== "/") t = "/" + t;
      HIST = [t].concat(HIST.filter(function (x) { return x !== t; })).slice(0, 30);
      ss("sa-panel-hist", JSON.stringify(HIST));
      hi = -1;
      inp.value = "";
      run(t, feed, { echo: true });
    }
    var f = h("form", { class: "console", novalidate: true }, inp, h("button", { type: "submit", class: "btn btn-p", text: "Выполнить" }));
    f.addEventListener("submit", function (e) { e.preventDefault(); go(inp.value); });
    inp.addEventListener("keydown", function (e) {
      if (e.key === "ArrowUp" && HIST.length) { hi = Math.min(HIST.length - 1, hi + 1); inp.value = HIST[hi]; e.preventDefault(); }
      if (e.key === "ArrowDown") { hi = Math.max(-1, hi - 1); inp.value = hi < 0 ? "" : HIST[hi]; e.preventDefault(); }
    });
    el.appendChild(f);
    setTimeout(function () { inp.focus(); }, 30);
    el.appendChild(h("p", { class: "muted small", style: "margin-top:8px", text: "↑ и ↓ — прошлые команды. Отложенные команды (/in) работают, если к аккаунту привязан Telegram: результат придёт туда." }));
  };

  // ───── маршрутизация: #раздел или #раздел/параметр
  var CUR = "";
  function route(force) {
    var hs = location.hash.replace(/^#/, "") || "dash";
    if (hs === CUR && !force) return;
    CUR = hs;
    var i = hs.indexOf("/"), name = i < 0 ? hs : hs.slice(0, i), arg = i < 0 ? "" : hs.slice(i + 1);
    if (!PAGES[name]) { name = "dash"; arg = ""; }
    var navName = name === "user" ? "users" : name;
    document.querySelectorAll(".it").forEach(function (a) { a.classList.toggle("on", a.dataset.p === navName); if (a.dataset.p === navName) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current"); });
    $("shell").classList.remove("menu");
    var el = $("page");
    el.textContent = "";
    var r = PAGES[name](el, arg);
    if (!force) { window.scrollTo(0, 0); el.focus({ preventScroll: true }); }
    return r;
  }
  window.addEventListener("hashchange", function () { if (ME) route(); });

  function start(me) {
    ME = me;
    $("auth").hidden = true;
    $("shell").hidden = false;
    $("me-name").textContent = me.nick || me.login;
    $("me-rank").textContent = me.rankName + " · " + me.login;
    $("me-ava").textContent = (me.nick || me.login).split(/\s+/).map(function (w) { return w[0]; }).join("").slice(0, 2).toUpperCase();
    themeIco();
    buildNav();
    CUR = "";
    route();
    if (location.hash.replace(/^#/, "").split("/")[0] !== "dash") refreshCounts();
  }

  themeIco();
  TOKEN = ss(SKEY);
  if (!TOKEN) showAuth();
  else api("me").then(function (r) { if (r.ok) start(r.me); else if (r.code !== "auth") showAuth(r.error); });
})();
