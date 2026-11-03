/* 3.8.1: страница /go/ — ссылка от коллеги вместо кода: открыть в программе (senko-assistant://) или в веб-версии */
(function () {
  "use strict";
  var RX = { p: /^[A-Z0-9]{6}$/, i: /^SA-[A-Z0-9]{4}-[A-Z0-9]{4}$/, s: /^[A-Za-z0-9]{8}$/, x: /^\d{6}$/, ui: /^[A-Za-z0-9._~-]{3,160}$/ };
  var KIND = {
    p: ["Совместный патруль", "Напарник зовёт вас в экипаж. Задержания и таймеры участников будут видны всему экипажу.", "Код экипажа"],
    i: ["Приглашение в организацию", "Руководство приглашает вас вступить в организацию. Нужно войти в аккаунт Senko Assistant.", "Код приглашения"],
    s: ["Ссылка от коллеги", "Расчёт, набор статей, схема, вопросы для тренажёра, тест для стажёра или сравнение результатов.", "Код"],
    x: ["Перенос данных", "Откройте ссылку на втором компьютере, войдя в тот же аккаунт. Код действует 15 минут и срабатывает один раз.", "Код переноса"],
    ui: ["Вид интерфейса", "Настройки внешнего вида от коллеги. Программа покажет, что изменится, а прежний вид можно вернуть одной кнопкой.", ""]
  };
  function $(s) { return document.querySelector(s); }
  var q = new URLSearchParams(location.search), k = "", v = "";
  ["p", "i", "s", "x", "ui"].some(function (x) { var y = q.get(x); if (y) { k = x; v = y.trim(); return true; } return false; });
  if (k === "p") v = v.toUpperCase();
  if (k === "i") v = v.toUpperCase();
  var ok = k && RX[k].test(v);
  var box = $("#go");
  if (!box) return;
  if (!ok) {
    $("#go-t").textContent = "Ссылка не распознана";
    $("#go-d").textContent = "Похоже, ссылку скопировали не полностью. Попросите коллегу отправить её ещё раз.";
    return;
  }
  var K = KIND[k];
  document.title = K[0] + " · Senko Assistant";
  $("#go-t").textContent = K[0];
  $("#go-d").textContent = K[1];
  var app = $("#go-app"), web = $("#go-web");
  app.href = "senko-assistant://go/?" + k + "=" + encodeURIComponent(v);
  web.href = "/app/?go=" + k + ":" + encodeURIComponent(v);
  app.hidden = false; web.hidden = false;
  if (K[2]) {
    var c = $("#go-code");
    c.hidden = false;
    $("#go-cl").textContent = K[2] + " для ввода вручную:";
    $("#go-cv").textContent = v;
    $("#go-cb").dataset.copy = v;
  }
  if (k === "s" && window.SENKO_WEB && /^https:\/\//.test(window.SENKO_WEB.api || "")) {
    var t = $("#go-txt");
    t.href = window.SENKO_WEB.api + "?s=" + encodeURIComponent(v);
    t.hidden = false;
  }
  // программа не открылась (её нет): через пару секунд подсказываем веб-версию
  function tryApp() {
    var left = false;
    function gone() { left = true; }
    window.addEventListener("blur", gone, { once: true });
    setTimeout(function () { if (!left) $("#go-hint").hidden = false; }, 2200);
  }
  app.addEventListener("click", tryApp);
  // на компьютере сразу открываем программу: браузер спросит «Открыть Senko Assistant?», вопрос «Вступить?» задаст уже программа
  var phone = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent || "");
  if (phone) {
    app.hidden = true;
    web.className = "btn btn-p btn-lg";
  } else {
    setTimeout(function () { tryApp(); location.href = app.href; }, 350);
  }
})();
