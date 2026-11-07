/* 4.3.5: публичная страница суда — реестр решений (только опубликованные судом) и консультант для граждан */
(function () {
  "use strict";
  var CFG = window.SENKO_WEB || {}, API = CFG.api || "";
  function $(s) { return document.querySelector(s); }
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
  function call(body) {
    if (!API || !window.fetch) return Promise.resolve({ ok: false, error: "Нет связи с сервером." });
    return fetch(API, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
      .then(function (r) { return r.json(); }).catch(function () { return { ok: false, error: "Нет связи с сервером." }; });
  }
  var sel = $("[data-cts]"), q = $("[data-ctq]"), box = $("[data-court]"), t = 0;
  if (!box) return;
  try { var s0 = new URLSearchParams(location.search).get("s"); if (s0 && sel.querySelector('option[value="' + s0 + '"]')) sel.value = s0; } catch (e) {}
  var V = { guilty: "обвинительное", acquit: "оправдательное", other: "иное" }, O = { upheld: "оставлено в силе", changed: "изменено", overturned: "отменено" };
  function load() {
    box.innerHTML = '<p class="cx-load">Загружаю…</p>';
    call({ action: "pub_court", server: parseInt(sel.value, 10) || 12, q: q.value || "" }).then(function (r) {
      if (!r || !r.ok) { box.innerHTML = '<p class="cx-load">' + esc((r && r.error) || "Не удалось загрузить.") + "</p>"; return; }
      if (r.off) { box.innerHTML = '<p class="cx-load">Судебная власть этого сервера пока не публикует решения на сайте.</p>'; return; }
      if (!r.list.length) { box.innerHTML = '<p class="cx-load">' + (q.value ? "Ничего не найдено." : "Опубликованных решений пока нет.") + "</p>"; return; }
      box.innerHTML = r.list.map(function (d) {
        return '<details class="ct-dec"><summary><b>' + (d.no ? "№ " + esc(d.no) + " · " : "") + esc(d.title) + "</b><br><small>" + esc(d.dt) + (d.caseNo ? " · дело № " + esc(d.caseNo) : "") + (d.arts ? " · " + esc(d.arts) : "") +
          (d.verdict ? " · " + esc(V[d.verdict] || "") : "") + (d.outcome ? " · " + esc(O[d.outcome] || "") : "") + (d.panel ? " · ⚖ " + esc(d.panel) : "") + "</small></summary><p style=\"white-space:pre-wrap\">" + esc(d.text) + "</p></details>";
      }).join("");
    });
  }
  sel.addEventListener("change", load);
  q.addEventListener("input", function () { clearTimeout(t); t = setTimeout(load, 400); });
  load();
  var ta = $("[data-cta]"), bt = $("[data-ctb]"), out = $("[data-ctr]");
  if (bt) bt.addEventListener("click", function () {
    var v = (ta.value || "").trim();
    if (v.length < 10) { out.innerHTML = "<p>Опишите ситуацию подробнее.</p>"; return; }
    bt.disabled = true; out.innerHTML = "<p>Консультант думает…</p>";
    call({ action: "pub_court_ai", server: parseInt(sel.value, 10) || 12, q: v }).then(function (r) {
      bt.disabled = false;
      out.innerHTML = r && r.ok ? '<div class="ct-dec ct-ans">' + esc(r.answer) + "</div>" : "<p>" + esc((r && r.error) || "Консультант не ответил.") + "</p>";
    });
  });
})();
