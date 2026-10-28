/* Senko Assistant · сайт: тема, меню, галерея, копирование, актуальная версия для скачивания */
(function () {
  "use strict";
  var REPO = "Kofemanchik/Senko-Assistant";
  var root = document.documentElement;
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };
  function store(k, v) { try { if (v === undefined) return localStorage.getItem(k); if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch (e) { return null; } }

  /* тема: как в системе → светлая → чёрная */
  var MODES = ["auto", "light", "dark"], NAMES = { auto: "как в системе", light: "светлая", dark: "чёрная" }, ICONS = { auto: "#i-auto", light: "#i-sun", dark: "#i-moon" };
  var mq = window.matchMedia ? window.matchMedia("(prefers-color-scheme: dark)") : null;
  function mode() { var t = store("site-theme"); return t === "light" || t === "dark" ? t : "auto"; }
  function dark() { var m = mode(); return m === "dark" || (m === "auto" && mq && mq.matches); }
  function paintShots() { var d = dark(); $$("img[data-light]").forEach(function (i) { var s = d ? i.dataset.dark : i.dataset.light; if (s && i.getAttribute("src") !== s) i.setAttribute("src", s); }); }
  function applyTheme() {
    var m = mode();
    if (m === "auto") delete root.dataset.theme; else root.dataset.theme = m;
    var b = $("#themeBtn");
    if (b) { b.title = b.ariaLabel = "Тема: " + NAMES[m]; b.setAttribute("aria-label", "Тема: " + NAMES[m]); var u = $("use", b); if (u) u.setAttribute("href", ICONS[m]); }
    paintShots();
  }
  var tb = $("#themeBtn");
  if (tb) tb.addEventListener("click", function () { var m = MODES[(MODES.indexOf(mode()) + 1) % 3]; store("site-theme", m === "auto" ? null : m); applyTheme(); toast("Тема: " + NAMES[m]); });
  if (mq && mq.addEventListener) mq.addEventListener("change", applyTheme);
  applyTheme();

  /* шапка и меню на телефоне */
  var top = $("#top"), nav = $("#nav"), burger = $("#burger");
  function onScroll() { if (top) top.classList.toggle("scrolled", window.scrollY > 8); }
  window.addEventListener("scroll", onScroll, { passive: true }); onScroll();
  function closeNav() { if (!nav) return; nav.classList.remove("open"); if (burger) burger.setAttribute("aria-expanded", "false"); }
  if (burger) burger.addEventListener("click", function () { var o = nav.classList.toggle("open"); burger.setAttribute("aria-expanded", o ? "true" : "false"); });
  if (nav) nav.addEventListener("click", function (e) { if (e.target.closest("a")) closeNav(); });
  document.addEventListener("keydown", function (e) { if (e.key === "Escape") closeNav(); });

  /* всплывашка и копирование */
  var tt;
  function toast(t) { var el = $("#toast"); if (!el) return; el.textContent = t; el.classList.add("on"); clearTimeout(tt); tt = setTimeout(function () { el.classList.remove("on"); }, 1800); }
  function copy(text) {
    if (navigator.clipboard && window.isSecureContext) return navigator.clipboard.writeText(text);
    return new Promise(function (ok, no) { var ta = document.createElement("textarea"); ta.value = text; ta.style.position = "fixed"; ta.style.opacity = "0"; document.body.appendChild(ta); ta.select(); try { document.execCommand("copy") ? ok() : no(); } catch (e) { no(e); } ta.remove(); });
  }
  document.addEventListener("click", function (e) {
    var b = e.target.closest("[data-copy]"); if (!b) return;
    e.preventDefault();
    var v = b.dataset.copy;
    copy(v).then(function () { toast("Скопировано: " + v); b.classList.add("ok"); setTimeout(function () { b.classList.remove("ok"); }, 1200); }, function () { toast(v); });
  });

  /* галерея */
  var gi = $("#galImg"), gc = $("#galCap"), tabs = $$(".tabs .tab");
  function pick(t) {
    tabs.forEach(function (x) { x.setAttribute("aria-selected", x === t ? "true" : "false"); x.tabIndex = x === t ? 0 : -1; });
    var n = t.dataset.shot; gi.dataset.light = "/img/" + n + "-light-1440.webp"; gi.dataset.dark = "/img/" + n + "-dark-1440.webp";
    gi.alt = t.textContent + ": экран программы"; gi.style.opacity = ".35";
    gi.onload = function () { gi.style.opacity = "1"; }; paintShots(); if (gi.complete) gi.style.opacity = "1";
    if (gc) gc.textContent = t.dataset.cap || "";
  }
  tabs.forEach(function (t, i) {
    t.addEventListener("click", function () { pick(t); });
    t.addEventListener("keydown", function (e) { var d = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0; if (!d) return; var n = tabs[(i + d + tabs.length) % tabs.length]; n.focus(); pick(n); });
  });
  /* заранее подгружаем остальные экраны, когда страница уже открылась */
  window.addEventListener("load", function () { setTimeout(function () { var d = dark() ? "dark" : "light"; tabs.forEach(function (t) { var im = new Image(); im.src = "/img/" + t.dataset.shot + "-" + d + "-1440.webp"; }); }, 1500); });

  /* появление при прокрутке */
  var rv = $$(".rv");
  if ("IntersectionObserver" in window) {
    var io = new IntersectionObserver(function (es) { es.forEach(function (e) { if (e.isIntersecting) { e.target.classList.add("in"); io.unobserve(e.target); } }); }, { rootMargin: "0px 0px -8% 0px" });
    rv.forEach(function (el) { io.observe(el); });
  } else rv.forEach(function (el) { el.classList.add("in"); });

  /* реклама: список баннеров приходит с сервера (владелец правит его в панели); без ответа остаются баннеры из страницы */
  function safeUrl(u) { u = String(u || ""); return /^https:\/\/[^\s"'<>]+$/i.test(u) ? u : ""; }
  function safeImg(u) { u = String(u || ""); if (/^data:image\/(png|jpe?g|webp|gif);base64,[a-z0-9+\/=]+$/i.test(u) || /^\/img\/[\w.-]+$/.test(u)) return u; return safeUrl(u); }
  function adHtml(a) {
    var sq = a.style === "square", img = safeImg(a.image), k = sq ? "ad2" : "ad";
    var links = (a.links || []).map(function (l) {
      var u = safeUrl(l && l.url); if (!u) return "";
      var dc = /discord\.(gg|com)/i.test(u), tg = /t\.me\//i.test(u);
      return '<a class="btn ' + (dc ? "btn-ad" : tg ? "btn-tg" : "btn-s") + (sq ? " btn-sm" : "") + '" href="' + esc(u) + '" target="_blank" rel="noopener sponsored">' +
        (dc || tg ? '<svg class="ico"' + (sq ? ' style="width:18px;height:18px"' : "") + '><use href="#i-' + (dc ? "dc" : "tg") + '"/></svg>' : "") + esc((l && l.label) || "Открыть") + "</a>";
    }).join("");
    if (a.promo) links = '<button class="promo" type="button" data-copy="' + esc(a.promo) + '" title="Скопировать промокод"><span>Промокод</span><b>' + esc(a.promo) + '</b><svg class="ico"><use href="#i-copy"/></svg></button>' + links;
    return '<div class="' + k + ' rv in">' + (img ? '<div class="' + k + '-img"><img src="' + esc(img) + '" alt="" loading="lazy"></div>' : "") +
      '<div class="' + k + '-body"><span class="ad-tag' + (sq ? " ad2-tag" : "") + '">' + esc(a.tag || "Реклама") + "</span>" +
      (a.srv ? '<span class="' + k + '-srv">' + esc(a.srv) + "</span>" : "") + "<h3>" + esc(a.title || "") + "</h3>" + (a.text ? "<p>" + esc(a.text) + "</p>" : "") +
      (links ? '<div class="ad2-row">' + links + "</div>" : "") + "</div></div>";
  }
  var adSec = $("#ad"), CFG = window.SENKO_WEB || {};
  if (adSec && CFG.api && window.fetch) {
    fetch(CFG.api, { method: "POST", body: JSON.stringify({ action: "ads", place: "site" }) })
      .then(function (r) { return r.json(); })
      .then(function (r) {
        if (!r || !r.ok || !Array.isArray(r.ads)) return;
        var L = r.ads.filter(function (a) { return a && a.title; });
        if (!L.length) { adSec.hidden = true; $$('a[href="#ad"]').forEach(function (a) { a.hidden = true; }); return; }
        $(".wrap", adSec).innerHTML = L.slice(0, 6).map(adHtml).join("");
        $$("img", adSec).forEach(function (im) { im.addEventListener("error", function () { im.parentNode.remove(); }); });
      })
      .catch(function () {});
  }

  /* актуальная версия: GitHub отдаёт последний релиз, кнопка сразу качает .exe */
  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }
  function inline(s) { return esc(s).replace(/\*\*(.+?)\*\*/g, "<b>$1</b>").replace(/`([^`]+)`/g, "<code>$1</code>"); }
  function md(txt) {
    var out = [], list = false;
    String(txt || "").replace(/\r/g, "").split("\n").forEach(function (l) {
      var m;
      if ((m = /^\s*[-*]\s+(.*)$/.exec(l))) { if (!list) { out.push("<ul>"); list = true; } out.push("<li>" + inline(m[1]) + "</li>"); return; }
      if (list) { out.push("</ul>"); list = false; }
      if ((m = /^#{1,4}\s+(.*)$/.exec(l))) { if (!out.length && /^Что нового/i.test(m[1])) return; out.push("<h4>" + inline(m[1]) + "</h4>"); }
      else if (l.trim()) out.push("<p>" + inline(l) + "</p>");
    });
    if (list) out.push("</ul>");
    return out.join("");
  }
  function mb(n) { return (n / 1048576).toFixed(n > 104857600 ? 0 : 1).replace(".", ",") + " МБ"; }
  function show(r) {
    var exe = (r.assets || []).filter(function (a) { return /\.exe$/i.test(a.name); })[0];
    var ver = String(r.tag_name || "").replace(/^v/i, "");
    if (ver) $$("[data-ver]").forEach(function (e) { e.textContent = ver; });
    if (exe) {
      $$("a[data-dl]").forEach(function (a) { a.href = exe.browser_download_url; a.setAttribute("download", ""); });
      $$("[data-size]").forEach(function (e) { e.textContent = mb(exe.size); });
      var st = $("[data-size-tag]"); if (st) st.textContent = ".exe · " + mb(exe.size);
    }
    var when = r.published_at ? new Date(r.published_at) : null;
    if (when) {
      var ds = when.toLocaleDateString("ru-RU", { day: "numeric", month: "long", year: "numeric" });
      var dt = $("[data-date-tag]"); if (dt) { dt.textContent = ds; dt.hidden = false; }
      var nw = $("#newsWhen"); if (nw) nw.textContent = "Версия " + ver + " · " + ds;
    }
    if (r.body && $("#notes")) $("#notes").innerHTML = md(r.body);
  }
  if ($("[data-dl]")) {
    var cached = null;
    try { cached = JSON.parse(sessionStorage.getItem("sa-rel") || "null"); } catch (e) {}
    if (cached && Date.now() - cached.at < 6e5) show(cached.r);
    else if (window.fetch) fetch("https://api.github.com/repos/" + REPO + "/releases/latest", { headers: { Accept: "application/vnd.github+json" } })
      .then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); })
      .then(function (r) { var keep = { tag_name: r.tag_name, published_at: r.published_at, body: r.body, assets: (r.assets || []).map(function (a) { return { name: a.name, size: a.size, browser_download_url: a.browser_download_url }; }) }; try { sessionStorage.setItem("sa-rel", JSON.stringify({ at: Date.now(), r: keep })); } catch (e) {} show(keep); })
      .catch(function () { /* без ответа GitHub кнопки ведут на страницу последнего релиза */ $$("a[data-dl]").forEach(function (a) { if (a.getAttribute("href").charAt(0) === "#") return; a.href = "https://github.com/" + REPO + "/releases/latest"; }); });
  }
})();
