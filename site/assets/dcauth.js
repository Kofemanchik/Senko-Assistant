/* 3.5.3: страница возврата из Discord. Discord присылает сюда ?code=…&state=…; сервер обменивает код и отмечает вход,
   а программа, веб-версия или панель, начавшие вход, получают результат сами (они опрашивают сервер). */
(function () {
  "use strict";
  var box = document.querySelector("[data-dcauth]");
  if (!box) return;
  var q = new URLSearchParams(location.search), CFG = window.SENKO_WEB || {};
  function show(ok, text) {
    box.innerHTML = "";
    var b = document.createElement("p"); b.style.fontWeight = "600"; b.style.fontSize = "17px";
    b.textContent = (ok ? "✅ " : "⚠️ ") + text; box.appendChild(b);
  }
  // код и state не оставляем в адресной строке и истории
  try { history.replaceState(null, "", location.pathname); } catch (e) {}
  var state = q.get("state") || "", code = q.get("code") || "", err = q.get("error") || "";
  if (!state) { show(false, "Ссылка неполная. Начните вход заново в программе."); return; }
  if (!CFG.api || !window.fetch) { show(false, "Браузер не поддерживается. Начните вход заново."); return; }
  fetch(CFG.api, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "dc_auth_cb", state: state, code: code, error: err }) })
    .then(function (r) { return r.json(); })
    .then(function (r) { show(!!(r && r.ok), (r && (r.msg || r.error)) || "Не удалось подтвердить вход."); })
    .catch(function () { show(false, "Нет связи с сервером. Попробуйте ещё раз."); });
})();
