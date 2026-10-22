/* 2.4: страница «Состояние сервисов»: спрашивает сервер (action "status") раз в минуту */
(function () {
  "use strict";
  var CFG = window.SENKO_WEB || {}, $ = function (id) { return document.getElementById(id); };
  if (!$("st")) return;
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }
  function when(t) {
    if (!t) return "нет данных";
    var d = new Date(t), m = Math.round((Date.now() - t) / 60000);
    if (m < 1) return "только что";
    if (m < 60) return m + " мин назад";
    if (m < 24 * 60) return Math.round(m / 60) + " ч назад";
    return d.toLocaleDateString("ru-RU", { day: "numeric", month: "long" });
  }
  function paint(r) {
    var sum = $("st-sum"), list = $("st-list"), laws = $("st-laws");
    if (!r || !r.ok) {
      sum.className = "st-sum bad";
      sum.innerHTML = "<i></i><b>Сервер не отвечает</b>";
      list.innerHTML = '<div class="st-row bad"><i></i><b>Сервер (вход, синхронизация, бот)</b><span>нет ответа</span></div>';
      laws.hidden = true;
      $("st-at").textContent = "проверено " + new Date().toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
      return;
    }
    var bad = r.services.filter(function (s) { return !s.ok; });
    sum.className = "st-sum " + (r.maintenance && r.maintenance.on ? "warn" : bad.length ? (bad.length > 1 ? "bad" : "warn") : "ok");
    sum.innerHTML = "<i></i><b>" + (r.maintenance && r.maintenance.on ? "Идут технические работы" : bad.length ? (bad.length === 1 ? "Есть сбой: " + esc(bad[0].name.toLowerCase()) : "Есть сбои в нескольких сервисах") : "Все сервисы работают") + "</b>";
    list.innerHTML = r.services.map(function (s) {
      return '<div class="st-row ' + (s.ok ? "ok" : "bad") + '"><i></i><b>' + esc(s.name) + "</b><span>" + (s.ok ? (s.ms != null ? s.ms + " мс" : "работает") : "сбой") + "</span></div>";
    }).join("") + (r.maintenance && r.maintenance.on && r.maintenance.text ? '<div class="st-row"><div class="st-mt">' + esc(r.maintenance.text) + "</div></div>" : "");
    if (r.laws) { laws.hidden = false; laws.textContent = "Законы проверены на форуме " + when(r.laws.checkedAt) + ", последнее изменение " + when(r.laws.updatedAt) + (r.laws.count ? ", статей в базе: " + r.laws.count : "") + "."; }
    $("st-at").textContent = "проверено " + new Date(r.at || Date.now()).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
  }
  function load() {
    if (!CFG.api || !window.fetch) return paint(null);
    fetch(CFG.api, { method: "POST", body: JSON.stringify({ action: "status" }) })
      .then(function (r) { return r.json(); }).then(paint).catch(function () { paint(null); });
  }
  load();
  setInterval(load, 60000);
})();
