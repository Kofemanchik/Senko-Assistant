/* Senko Assistant · веб-версия: мост window.senkoAuth для окна входа (то же, что auth-preload.js в программе).
   После входа открывается помощник /app/; сессия хранится в браузере (с «Запомнить меня» — 60 дней). */
(function () {
  "use strict";
  var W = window.SenkoWeb;
  var ROLES = { off: "Сотрудник", pros: "Прокурор", adv: "Адвокат" };
  var DEPTS = ["Government", "LSPD", "LSCSD", "FIB", "SANG"];
  var pending = null; // свежая регистрация или новые документы: вход после подтверждения

  function next() {
    var n = "";
    try { n = new URLSearchParams(location.search).get("next") || ""; } catch (e) {}
    return "/app/" + (/^[?#][\w\-.:=&%#?]*$/.test(n) ? n : "");
  }
  function enter() { location.replace(next()); }
  function clean(s, m) { return String(s == null ? "" : s).replace(/[\u0000-\u001f]/g, " ").trim().slice(0, m); }

  // уже вошли — сразу в помощник
  if (W.session() && !/[?&]out=1/.test(location.search)) { enter(); return; }

  window.senkoAuth = {
    state: function () {
      return Promise.resolve({ lastLogin: W.ls("sa-web-last") || "", depts: DEPTS.slice(), roles: ROLES, gov: "Government", version: W.CFG.ver || "", notice: W.notice() });
    },
    login: function (d) {
      d = d || {};
      var login = clean(d.login, 24), password = String(d.password == null ? "" : d.password);
      if (!login || !password) return Promise.resolve({ ok: false, error: "Введите логин и пароль." });
      return W.call(Object.assign({ action: "login", login: login, password: password, remember: !!d.remember }, W.client())).then(function (r) {
        if (!r.ok) return { ok: false, error: r.error || "Не удалось войти.", code: r.code };
        W.ls("sa-web-last", r.user.login);
        if (r.user.needLegal) { pending = { login: r.user.login, token: r.token, remember: !!d.remember, user: r.user }; return { ok: true, needLegal: true, user: r.user }; }
        W.saveSession(r.user.login, r.token, !!d.remember);
        W.cacheUser(r.user, { sys: r.sys });
        setTimeout(enter, 0);
        return { ok: true, user: r.user };
      });
    },
    register: function (d) {
      d = d || {};
      return W.call(Object.assign({
        action: "register", login: d.login, password: d.password, nick: d.nick, static: d.static,
        org: d.org, orgOther: d.orgOther, role: d.role, discord: d.discord, telegram: d.telegram, phone: d.phone,
        remember: !!d.remember, migrated: false, legal: d.legal
      }, W.client())).then(function (r) {
        if (!r.ok) return { ok: false, error: r.error || "Не удалось зарегистрироваться.", code: r.code };
        W.ls("sa-web-last", r.user.login);
        if (r.pending) return { ok: true, pending: true, message: r.message || "", user: r.user, recoveryCode: r.recoveryCode };
        pending = { login: r.user.login, token: r.token, remember: !!d.remember, user: r.user };
        return { ok: true, user: r.user, recoveryCode: r.recoveryCode };
      });
    },
    acceptLegal: function (version) {
      if (!pending) return Promise.resolve({ ok: false, code: "auth", error: "Нужно войти в аккаунт." });
      return W.call({ action: "accept_legal", token: pending.token, version: String(version || "") }).then(function (r) {
        if (r.ok) pending.user.needLegal = false;
        return r;
      });
    },
    enter: function () {
      if (!pending) return;
      W.saveSession(pending.login, pending.token, pending.remember);
      W.cacheUser(pending.user);
      pending = null;
      enter();
    },
    resetRequest: function (d) { d = d || {}; return W.call({ action: "reset_request", login: clean(d.login, 24), nick: clean(d.nick, 40), static: clean(d.static, 12), recoveryCode: clean(d.recoveryCode, 40) }); },
    resetStatus: function (d) { d = d || {}; return W.call({ action: "reset_status", requestId: String(d.requestId || ""), secret: String(d.secret || "") }); },
    resetComplete: function (d) { d = d || {}; return W.call({ action: "reset_complete", resetToken: String(d.resetToken || ""), password: String(d.password || "") }); },
    copy: function (text) { try { navigator.clipboard.writeText(String(text || "").slice(0, 200)); } catch (e) {} },
    saveCode: function (login, code) {
      var safe = String(login).replace(/[^\w.-]/g, "_").slice(0, 24) || "user";
      var text = "Senko Assistant\r\nЛогин: " + login + "\r\nКод восстановления пароля: " + code + "\r\n\r\nХраните файл в надёжном месте. Код нужен, если вы забудете пароль.\r\n";
      var a = document.createElement("a");
      a.href = URL.createObjectURL(new Blob(["﻿" + text], { type: "text/plain;charset=utf-8" }));
      a.download = "senko-recovery-" + safe + ".txt";
      document.body.appendChild(a); a.click();
      setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
      return Promise.resolve({ ok: true });
    },
    quit: function () { location.href = "/"; }
  };
})();
