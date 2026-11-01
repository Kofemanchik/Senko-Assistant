/* Senko Assistant · публичный справочник (3.5): /laws/, статьи /uk/12.8/, /calc/, /changes/, /search/, /report/.
   Законы любого сервера приходят с сервера (action pub_laws, тот же файл с форума, что у программы) и разбираются
   scripts/law-core.js — тем же кодом, что в программе. Boston без связи берётся из таблиц, встроенных в сайт (/assets/codes-12.json). */
(function () {
  "use strict";
  var CFG = window.SENKO_WEB || {};
  var API = CFG.api || "";
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };
  var KN = { uk: "УК", ak: "АК", dk: "ДК", pk: "ПК" };
  var SRV = { 12: "Boston", 7: "Los Angeles", 16: "Denver" };
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }
  function money(n) { return "$" + String(n).replace(/\B(?=(\d{3})+(?!\d))/g, " "); }
  function ls(k, v) { try { if (v === undefined) return localStorage.getItem(k); localStorage.setItem(k, v); } catch (e) {} return null; }
  function call(body) {
    if (!API || !window.fetch) return Promise.resolve({ ok: false, error: "Нет связи с сервером." });
    return fetch(API, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
      .then(function (r) { return r.json(); }).catch(function () { return { ok: false, error: "Нет связи с сервером." }; });
  }

  /* ───── сервер ───── */
  function server() {
    var q = parseInt(new URLSearchParams(location.search).get("s"), 10);
    if (SRV[q]) return q;
    var v = parseInt(ls("site-srv"), 10);
    return SRV[v] ? v : 12;
  }
  var onSrv = [];
  function initSrv() {
    $$("[data-srv]").forEach(function (sel) {
      sel.value = String(server());
      sel.addEventListener("change", function () {
        var v = parseInt(sel.value, 10); ls("site-srv", String(v));
        var u = new URL(location.href); if (v === 12) u.searchParams.delete("s"); else u.searchParams.set("s", v);
        history.replaceState(null, "", u.toString());
        onSrv.forEach(function (f) { f(v); });
      });
    });
  }
  function status(t) { $$("[data-st]").forEach(function (e) { e.textContent = t || ""; }); }

  /* ───── законы ───── */
  var cache = {};
  var kindOf = function (t) { t = String(t || "").toLowerCase(); if (!/кодекс/.test(t)) return ""; return /уголовн/.test(t) ? "uk" : /административн/.test(t) ? "ak" : /дорожн/.test(t) ? "dk" : /процессуальн/.test(t) ? "pk" : ""; };
  var pn = function (p) { return p === "" || p == null ? "1" : String(p); };
  function gunzip(b64) {
    var bin = atob(b64), u = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
    return new Response(new Blob([u]).stream().pipeThrough(new DecompressionStream("gzip"))).text();
  }
  function staticBoston() {
    return fetch("/assets/codes-12.json").then(function (r) { return r.json(); }).then(function (j) { return j.rows || []; }).catch(function () { return []; });
  }
  /* как в программе (applyRow/newRow): законы сервера дополняют и уточняют встроенные таблицы Boston, у остальных серверов — только свои */
  function merge(base, laws, v2) {
    var LC = window.LawCore; if (!LC) return base;
    LC.configure({ v2: v2 });
    var rows = base.map(function (r) { return Object.assign({}, r); }), by = {};
    rows.forEach(function (r) { by[r.k + "|" + r.code + "|" + pn(r.part)] = r; });
    (laws || []).forEach(function (L) {
      var k = kindOf(L.title); if (!k) return;
      var got;
      try { got = LC.rowsFromParsed(LC.parse(L.text)); } catch (e) { return; }
      got.forEach(function (f) {
        var key = k + "|" + f.code + "|" + pn(f.part), r = by[key];
        if (r) {
          if (k === "uk") { if (f.stars > 0) r.stars = f.stars; if (f.hasFine || f.m > 0) { r.m = f.m; r.fmin = f.fmin; r.fmax = f.fmax; r.rec = f.rec; } }
          else if (k === "ak") { if (f.hasFine) { r.fmin = f.fmin; r.fmax = f.fmax; } }
          else if (k === "dk") { if (f.hasFine) { r.fmin = 0; r.fmax = f.fmax; } }
          else { var t = ((f.text || "") + (f.note ? " " + f.note : "")).trim(); if (t) r.note = t; }
          if (f.pun) r.pun = f.pun;
        } else {
          var title = String(f.title || "").replace(/[.\s]+$/, "") || ("Статья " + f.code);
          r = { k: k, code: f.code, part: f.part, title: title, stars: k === "uk" ? f.stars : 0, m: k === "uk" ? f.m : 0, fmin: f.hasFine ? f.fmin : 0, fmax: f.hasFine ? f.fmax : 0, rec: k === "uk" ? f.rec : false,
            note: ((f.text || "") + (f.note ? " " + f.note : "")).trim(), pun: f.pun || "" };
          rows.push(r); by[key] = r;
        }
      });
    });
    return rows;
  }
  function load(s) {
    if (cache[s]) return cache[s];
    cache[s] = (s === 12 ? staticBoston() : Promise.resolve([])).then(function (base) {
      if (typeof DecompressionStream !== "function" || !window.LawCore) return { rows: base, live: false };
      return call({ action: "pub_laws", server: s }).then(function (r) {
        if (!r || !r.ok || !r.gz) return { rows: base, live: false, error: r && r.error };
        return gunzip(r.gz).then(function (txt) {
          var d = JSON.parse(txt);
          return { rows: merge(base, d.laws || [], s !== 12), live: true, at: r.updatedAt };
        });
      }).catch(function () { return { rows: base, live: false }; });
    }).then(function (x) {
      x.rows = x.rows.filter(function (r) { return r && r.code; });
      x.rows.forEach(function (r) { r.id = r.k + "|" + r.code + "|" + pn(r.part); });
      return x;
    });
    return cache[s];
  }
  function loadNote(x, s) {
    var t = x.live ? "Законы " + SRV[s] + " с форума" + (x.at ? " на " + new Date(x.at).toLocaleDateString("ru-RU") : "") : (s === 12 ? "Законы Boston из программы" : "");
    if (!x.live && x.error) t += (t ? ". " : "") + x.error;
    if (!x.rows.length) t = x.error || "Законы этого сервера пока не загружены.";
    status(t);
  }

  /* ───── поиск с опечатками: «неприкосновность» находит «неприкосновенность» ───── */
  function norm(s) { return String(s || "").toLowerCase().replace(/ё/g, "е").replace(/[^0-9a-zа-я.\s]/g, " ").replace(/\s+/g, " ").trim(); }
  function dist(a, b, max) {
    if (Math.abs(a.length - b.length) > max) return max + 1;
    var d = [], i, j;
    for (i = 0; i <= a.length; i++) { d[i] = [i]; }
    for (j = 0; j <= b.length; j++) d[0][j] = j;
    for (i = 1; i <= a.length; i++) {
      var best = max + 1;
      for (j = 1; j <= b.length; j++) {
        var c = a[i - 1] === b[j - 1] ? 0 : 1;
        d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + c);
        if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
        if (d[i][j] < best) best = d[i][j];
      }
      if (best > max) return max + 1;
    }
    return d[a.length][b.length];
  }
  function wordHit(w, words) {
    var max = w.length >= 9 ? 2 : w.length >= 5 ? 1 : 0;
    for (var i = 0; i < words.length; i++) {
      var x = words[i];
      if (x.indexOf(w) === 0) return 2;
      if (max && x.length >= w.length - max) {
        var head = x.slice(0, w.length + max);
        if (dist(w, x.slice(0, w.length), max) <= max || dist(w, head, max) <= max || dist(w, x, max) <= max) return 1;
      }
    }
    return 0;
  }
  function hayOf(r) { if (!r._h) { r._h = norm(r.title + " " + (r.note || "") + " " + (r.pun || "")); r._w = r._h.split(" "); } return r; }
  function search(rows, q, kinds) {
    q = norm(q);
    var list = rows.filter(function (r) { return !kinds || kinds.indexOf(r.k) >= 0; });
    if (!q) return list;
    var num = /^\d+(?:\.\d+)*\.?$/.test(q) ? q.replace(/\.$/, "") : "";
    if (num) return list.filter(function (r) { return r.code === num || r.code.indexOf(num + ".") === 0; }).concat(list.filter(function (r) { return r.code !== num && r.code.indexOf(num + ".") !== 0 && r.code.indexOf(num) === 0; }));
    var ws = q.split(" ").filter(function (w) { return w.length >= 2; });
    var scored = [];
    list.forEach(function (r) {
      hayOf(r);
      var sc = 0, tw = norm(r.title).split(" ");
      for (var i = 0; i < ws.length; i++) { var h = wordHit(ws[i], r._w); if (!h) return; sc += h + (wordHit(ws[i], tw) ? 2 : 0); }
      scored.push([sc, r]);
    });
    return scored.sort(function (a, b) { return b[0] - a[0]; }).map(function (x) { return x[1]; });
  }

  /* ───── отображение ───── */
  function chips(r) {
    var c = [];
    if (r.k === "uk") { if (r.stars) c.push("★".repeat(r.stars)); if (r.m) c.push("до " + r.m + " мес."); if (r.rec) c.push("судимость"); }
    if (r.k === "dk" && r.x) c.push(r.x);
    if (r.fmax) c.push(r.fmin && r.fmin !== r.fmax ? "штраф " + money(r.fmin) + "–" + money(r.fmax) : (r.fmin ? "штраф " + money(r.fmin) : "штраф до " + money(r.fmax)));
    return c;
  }
  var chipsHtml = function (r) { var c = chips(r); return c.length ? '<div class="cx-chips">' + c.map(function (x) { return "<span>" + esc(x) + "</span>"; }).join("") + "</div>" : ""; };
  var slug = function (code) { return String(code).replace(/[^0-9A-Za-zА-Яа-я.\-]/g, "-"); };
  var artUrl = function (r, s) { return "/" + r.k + "/" + slug(r.code) + "/" + (s && s !== 12 ? "?s=" + s : ""); };
  function groups(rows) {
    var g = [], by = {};
    rows.forEach(function (r) { var id = r.k + "|" + r.code; if (!by[id]) { by[id] = { k: r.k, code: r.code, title: r.title, parts: [] }; g.push(by[id]); } by[id].parts.push(r); });
    return g;
  }
  function artItem(a, s) {
    var sum = a.parts.map(function (p) { return chips(p).join(", "); }).filter(Boolean);
    return '<a class="cx-item" href="' + artUrl(a, s) + '"><b>' + KN[a.k] + " " + esc(a.code) + "</b><span>" + esc(a.title) + "</span>" +
      (sum.length ? "<small>" + esc(sum.slice(0, 2).join("; ") + (sum.length > 2 ? "; …" : "")) + "</small>" : "") + "</a>";
  }

  /* /laws/ */
  function pageLaws(box) {
    var k = new URLSearchParams(location.search).get("k"); if (!KN[k]) k = "uk";
    var qi = $("[data-q]"), tabs = $$(".cx-tabs .tab"), data = null, s = server();
    tabs.forEach(function (t) { t.setAttribute("aria-selected", t.dataset.k === k ? "true" : "false"); t.addEventListener("click", function () { k = t.dataset.k; tabs.forEach(function (x) { x.setAttribute("aria-selected", x === t ? "true" : "false"); }); draw(); }); });
    function draw() {
      if (!data) return;
      var q = qi.value, res = search(data.rows, q, q && /\S/.test(q) ? null : [k]);
      var g = groups(res);
      box.innerHTML = g.length ? g.slice(0, 300).map(function (a) { return artItem(a, s); }).join("") + (g.length > 300 ? '<p class="cx-load">Показаны первые 300. Уточните запрос.</p>' : "") : '<p class="cx-load">Ничего не нашлось.</p>';
    }
    function go(v) { s = v; box.innerHTML = '<p class="cx-load">Загружаю кодексы ' + SRV[s] + "…</p>"; load(s).then(function (x) { data = x; loadNote(x, s); draw(); }); }
    var t = 0; qi.addEventListener("input", function () { clearTimeout(t); t = setTimeout(draw, 120); });
    var q0 = new URLSearchParams(location.search).get("q"); if (q0) qi.value = q0;
    onSrv.push(go); go(s);
  }

  /* /uk/12.8/ */
  function pageArt(el) {
    var k = el.dataset.k, code = el.dataset.code, body = $("[data-body]", el), s = server();
    function go(v) {
      s = v;
      if (s === 12) status("Законы Boston");
      load(s).then(function (x) {
        loadNote(x, s);
        var parts = x.rows.filter(function (r) { return r.k === k && r.code === code; });
        if (!parts.length) { if (s !== 12) body.innerHTML = '<p class="cx-load">На сервере ' + SRV[s] + " статьи " + KN[k] + " " + esc(code) + ' нет. <a href="/laws/?k=' + k + "&s=" + s + '">Все статьи сервера</a></p>'; return; }
        body.innerHTML = parts.map(function (p) {
          var nm = p.part && p.part !== "1" ? "Часть " + p.part : (parts.length > 1 ? "Часть 1" : "");
          return '<section class="cx-part">' + (nm ? "<h2>" + esc(nm) + "</h2>" : "") + chipsHtml(p) + (p.note ? "<p>" + esc(p.note) + "</p>" : "") + (p.pun ? '<p class="cx-pun">' + esc(p.pun) + "</p>" : "") + "</section>";
        }).join("");
        var h = $("h1"); if (h && parts[0].title) h.textContent = KN[k] + " " + code + " · " + parts[0].title;
      });
    }
    onSrv.push(go); go(s);
    var add = $("[data-addcalc]"); if (add) add.addEventListener("click", function () {
      load(s).then(function (x) {
        var c = calcState(); x.rows.filter(function (r) { return r.k === k && r.code === code; }).slice(0, 1).forEach(function (r) { if (c.ids.indexOf(r.id) < 0) c.ids.push(r.id); });
        c.s = s; ls("site-calc", JSON.stringify(c)); location.href = "/calc/" + (s !== 12 ? "?s=" + s : "");
      });
    });
    var cp = $("[data-copylink]"); if (cp) cp.addEventListener("click", function () {
      var u = location.origin + location.pathname + (s !== 12 ? "?s=" + s : "");
      (navigator.clipboard ? navigator.clipboard.writeText(u) : Promise.reject()).then(function () { cp.textContent = "Ссылка скопирована"; }, function () { prompt("Ссылка на статью", u); });
    });
  }

  /* /calc/ */
  function calcState() { var c = null; try { c = JSON.parse(ls("site-calc") || "null"); } catch (e) {} return c && Array.isArray(c.ids) ? c : { s: server(), ids: [] }; }
  function finalTerm(items) {
    var uk = items.filter(function (r) { return r.k === "uk" && r.m; });
    if (!uk.length) return { m: 0, top: null, cut: false };
    var maxS = Math.max.apply(null, uk.map(function (r) { return r.stars || 0; }));
    var top = uk.filter(function (r) { return (r.stars || 0) === maxS; }).sort(function (a, b) { return b.m - a.m; })[0];
    return { m: Math.min(50, top.m), top: top, cut: top.m > 50 };
  }
  function pageCalc(sumBox) {
    var qi = $("[data-cq]"), sug = $("[data-sug]"), data = null, s = server(), st = calcState();
    if (st.s !== s) st = { s: s, ids: [] };
    function save() { st.s = s; ls("site-calc", JSON.stringify(st)); }
    function draw() {
      if (!data) return;
      var by = {}; data.rows.forEach(function (r) { by[r.id] = r; });
      var items = st.ids.map(function (i) { return by[i]; }).filter(function (r) { return r && r.k !== "pk"; });
      if (!items.length) { sumBox.innerHTML = '<p class="cx-load">Добавьте статьи, чтобы посчитать наказание.</p>'; return; }
      var ft = finalTerm(items), maxS = Math.max.apply(null, items.map(function (r) { return r.k === "uk" ? r.stars || 0 : 0; }).concat([0]));
      var adm = items.filter(function (r) { return r.k !== "uk"; }).reduce(function (a, r) { return a + (r.fmax || 0); }, 0);
      var ukF = items.filter(function (r) { return r.k === "uk" && r.fmax; });
      var h = '<ul class="cx-basket">' + items.map(function (r) {
        return "<li><span><b>" + KN[r.k] + " " + esc(r.code) + (r.part && r.part !== "1" ? " ч." + esc(r.part) : "") + "</b> " + esc(r.title) + "</span>" + chipsHtml(r) + '<button type="button" class="icon-btn" data-del="' + esc(r.id) + '" aria-label="Убрать">×</button></li>';
      }).join("") + "</ul>";
      h += '<div class="cx-total">';
      if (maxS) h += "<p>Розыск: <b>" + "★".repeat(maxS) + "</b> (" + maxS + " из 5)</p>";
      if (ft.m) h += "<p>Срок: <b>до " + ft.m + " мес.</b> по статье с наибольшим розыском (" + KN.uk + " " + esc(ft.top.code) + (ft.top.part && ft.top.part !== "1" ? " ч." + esc(ft.top.part) : "") + ")" + (ft.cut ? ", не больше 50 мес." : "") + "</p>";
      if (ukF.length) h += "<p>Штраф по УК (если назначен вместо срока): " + ukF.map(function (r) { return esc(r.code) + ": " + (r.fmin && r.fmin !== r.fmax ? money(r.fmin) + "–" + money(r.fmax) : money(r.fmax)); }).join("; ") + "</p>";
      if (adm) h += "<p>Административные штрафы (АК, ДК): <b>до " + money(adm) + "</b></p>";
      if (items.some(function (r) { return r.rec; })) h += "<p>Есть статьи с судимостью.</p>";
      h += '</div><button type="button" class="btn btn-s btn-sm" data-clear>Очистить</button>';
      sumBox.innerHTML = h;
    }
    sumBox.addEventListener("click", function (e) {
      var d = e.target.closest("[data-del]"); if (d) { st.ids = st.ids.filter(function (i) { return i !== d.dataset.del; }); save(); draw(); }
      if (e.target.closest("[data-clear]")) { st.ids = []; save(); draw(); }
    });
    function suggest() {
      if (!data) return;
      var q = qi.value; if (!q.trim()) { sug.innerHTML = ""; return; }
      var res = search(data.rows, q).filter(function (r) { return r.k !== "pk"; }).slice(0, 12);
      sug.innerHTML = res.map(function (r) { return '<button type="button" data-add="' + esc(r.id) + '"><b>' + KN[r.k] + " " + esc(r.code) + (r.part && r.part !== "1" ? " ч." + esc(r.part) : "") + "</b> " + esc(r.title) + "<small>" + esc(chips(r).join(", ")) + "</small></button>"; }).join("") || '<p class="cx-load">Ничего не нашлось.</p>';
    }
    sug.addEventListener("click", function (e) { var b = e.target.closest("[data-add]"); if (!b) return; if (st.ids.indexOf(b.dataset.add) < 0) st.ids.push(b.dataset.add); save(); qi.value = ""; sug.innerHTML = ""; draw(); qi.focus(); });
    var t = 0; qi.addEventListener("input", function () { clearTimeout(t); t = setTimeout(suggest, 120); });
    function go(v) { if (v !== s) st = { s: v, ids: [] }; s = v; save(); sumBox.innerHTML = '<p class="cx-load">Загружаю кодексы ' + SRV[s] + "…</p>"; load(s).then(function (x) { data = x; loadNote(x, s); draw(); }); }
    onSrv.push(go); go(s);
  }

  /* /changes/ */
  function pageChanges(box) {
    var sel = $("[data-chs]"), s0 = parseInt(new URLSearchParams(location.search).get("s"), 10);
    if (SRV[s0]) sel.value = String(s0);
    function go() {
      box.innerHTML = '<p class="cx-load">Загружаю…</p>';
      call({ action: "pub_changes", server: parseInt(sel.value, 10) || 0 }).then(function (r) {
        if (!r.ok) { box.innerHTML = '<p class="cx-load">' + esc(r.error || "Не удалось загрузить.") + "</p>"; return; }
        if (!r.items.length) { box.innerHTML = '<p class="cx-load">Изменений пока не записано. Лента ведётся с 3.5: новые правки появятся после ближайшей сверки с форумом.</p>'; return; }
        box.innerHTML = r.items.map(function (it) {
          return '<div class="cx-item cx-ch"><b>' + (it.type === "new" ? "Новый закон" : "Изменён") + "</b><span>" + esc(it.title) + (it.arts ? " — " + esc(it.arts) : "") + "</span><small>" + esc(it.name) + " · " + new Date(it.at).toLocaleString("ru-RU", { dateStyle: "long", timeStyle: "short" }) + "</small></div>";
        }).join("");
      });
    }
    sel.addEventListener("change", function () { var u = new URL(location.href); if (sel.value === "0") u.searchParams.delete("s"); else u.searchParams.set("s", sel.value); history.replaceState(null, "", u.toString()); go(); });
    go();
  }

  /* /search/ */
  function pageSearch(box) {
    var qi = $("[data-sq]"), idx = [], data = null, s = server();
    fetch("/assets/site-index.json").then(function (r) { return r.json(); }).then(function (j) { idx = j; draw(); }).catch(function () {});
    function draw() {
      var q = qi.value.trim();
      if (!q) { box.innerHTML = '<p class="cx-load">Введите номер статьи, слово или вопрос.</p>'; return; }
      var pages = search(idx.map(function (p) { return { k: "site", code: p.u, title: p.t, note: p.h, u: p.u }; }), q).slice(0, 8);
      var g = data ? groups(search(data.rows, q)).slice(0, 40) : [];
      box.innerHTML = (pages.length ? "<h2>Страницы сайта</h2>" + pages.map(function (p) { return '<a class="cx-item" href="' + esc(p.u) + '"><b>' + esc(p.title) + "</b></a>"; }).join("") : "") +
        (g.length ? "<h2>Статьи · " + SRV[s] + "</h2>" + g.map(function (a) { return artItem(a, s); }).join("") : "") +
        (!pages.length && !g.length ? '<p class="cx-load">' + (data ? "Ничего не нашлось." : "Ищу…") + "</p>" : "");
    }
    var q0 = new URLSearchParams(location.search).get("q"); if (q0) qi.value = q0;
    var t = 0; qi.addEventListener("input", function () { clearTimeout(t); t = setTimeout(function () { var u = new URL(location.href); if (qi.value.trim()) u.searchParams.set("q", qi.value.trim()); else u.searchParams.delete("q"); history.replaceState(null, "", u.toString()); draw(); }, 150); });
    function go(v) { s = v; data = null; draw(); load(s).then(function (x) { data = x; loadNote(x, s); draw(); }); }
    onSrv.push(go); go(s); qi.focus();
  }

  /* /rating/ */
  function pageRating(box) {
    function go(s) {
      box.innerHTML = '<p class="cx-load">Загружаю…</p>';
      call({ action: "pub_board", server: s }).then(function (r) {
        if (!r.ok) { box.innerHTML = '<p class="cx-load">' + esc(r.error || "Не удалось загрузить.") + "</p>"; return; }
        status("Неделя с " + new Date(r.from).toLocaleDateString("ru-RU", { timeZone: "Europe/Moscow" }));
        if (!r.list.length) { box.innerHTML = '<p class="cx-load">На ' + esc(r.name) + " пока никого: в рейтинг попадают только те, кто включил галочку в кабинете программы и набрал опыт на этой неделе.</p>"; return; }
        box.innerHTML = '<div class="cx-rt"><table><thead><tr><th>#</th><th>Ник</th><th>Ведомство</th><th>Опыт за неделю</th><th>Задержаний</th><th>Звание</th></tr></thead><tbody>' +
          r.list.map(function (x) { return "<tr><td>" + x.n + "</td><td><b>" + esc(x.nick) + "</b></td><td>" + esc(x.org) + "</td><td>" + x.wxp + "</td><td>" + x.det + "</td><td>" + esc(x.lvl) + "</td></tr>"; }).join("") + "</tbody></table></div>";
      });
    }
    onSrv.push(go); go(server());
  }

  /* /report/ */
  function pageBug(f) {
    var st = $("[data-bugst]"), btn = $("button[type=submit]", f);
    f.addEventListener("submit", function (e) {
      e.preventDefault();
      var text = f.text.value.trim();
      if (text.length < 10) { st.textContent = "Опишите проблему подробнее (хотя бы 10 символов)."; f.text.focus(); return; }
      btn.disabled = true; st.textContent = "Отправляю…";
      call({ action: "pub_bug", text: text, contact: f.contact.value.trim(), hp: f.hp.value, page: document.referrer.slice(0, 200), ua: navigator.userAgent.slice(0, 200) }).then(function (r) {
        btn.disabled = false;
        if (r.ok) { f.reset(); st.textContent = "Спасибо! Сообщение №" + r.id + " отправлено."; } else st.textContent = r.error || "Не получилось отправить.";
      });
    });
  }

  function start() {
    initSrv();
    var el;
    if ((el = $("[data-list]"))) pageLaws(el);
    if ((el = $("[data-art]"))) pageArt(el);
    if ((el = $("[data-sum]"))) pageCalc(el);
    if ((el = $("[data-changes]"))) pageChanges(el);
    if ((el = $("[data-sres]"))) pageSearch(el);
    if ((el = $("[data-bug]"))) pageBug(el);
    if ((el = $("[data-rating]"))) pageRating(el);
  }
  window.SenkoCodes = { search: search, dist: dist, norm: norm, load: load, merge: merge };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start); else start();
})();
