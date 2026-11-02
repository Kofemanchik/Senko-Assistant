/* Senko Assistant · веб-версия: мост window.senkoAuth для окна входа (то же, что auth-preload.js в программе).
   После входа открывается помощник /app/; сессия хранится в браузере (с «Запомнить меня» — 60 дней). */
(function () {
  "use strict";
  var W = window.SenkoWeb;
  var ROLES = { off: "Сотрудник", pros: "Прокурор", adv: "Адвокат" };
  var DEPTS = ["Government", "LSPD", "LSCSD", "FIB", "SANG"];
  var SERVERS = [{ id: 12, name: "Boston" }, { id: 7, name: "Los Angeles" }, { id: 16, name: "Denver" }]; // как SERVERS в серверной функции
  var dcRun = 0; // 3.5.3: номер текущей попытки входа через Discord
  var pending = null; // свежая регистрация или новые документы: вход после подтверждения

  function next() {
    var n = "";
    try { n = new URLSearchParams(location.search).get("next") || ""; } catch (e) {}
    return "/app/" + (/^[?#][\w\-.:=&%#?]*$/.test(n) ? n : "");
  }
  function enter() { location.replace(next()); }
  function clean(s, m) { return String(s == null ? "" : s).replace(/[\u0000-\u001f]/g, " ").trim().slice(0, m); }

  // 3.8: вход по QR-коду из программы (одноразовый код в адресе)
  var qr = "";
  try { qr = new URLSearchParams(location.search).get("qr") || ""; } catch (e) {}
  if (/^[0-9a-f]{32}$/.test(qr)) {
    history.replaceState(null, "", location.pathname);
    W.call(Object.assign({ action: "qr_login", op: "redeem", code: qr }, W.client())).then(function (r) {
      if (r && r.ok) {
        W.ls("sa-web-last", r.user.login);
        W.saveSession(r.user.login, r.token, true);
        W.cacheUser(r.user, { sys: r.sys });
        location.replace("/app/");
      } else {
        var n = document.getElementById("lErr");
        if (n) { n.textContent = (r && r.error) || "Не удалось войти по QR-коду."; n.hidden = false; }
      }
    });
  } else
  // уже вошли — сразу в помощник
  if (W.session() && !/[?&]out=1/.test(location.search)) { enter(); return; }

  window.senkoAuth = {
    state: function () {
      return Promise.resolve({ lastLogin: W.ls("sa-web-last") || "", depts: DEPTS.slice(), servers: SERVERS.slice(), defaultServer: 12, roles: ROLES, gov: "Government", version: W.CFG.stable || W.CFG.ver || "", notice: W.notice() });
    },
    login: function (d) {
      d = d || {};
      var login = clean(d.login, 24), password = String(d.password == null ? "" : d.password);
      if (!login || !password) return Promise.resolve({ ok: false, error: "Введите логин и пароль." });
      return W.call(Object.assign({ action: "login", login: login, password: password, remember: !!d.remember, otp: clean(d.otp, 20) }, W.client())).then(function (r) {
        if (!r.ok) return { ok: false, error: r.error || "Не удалось войти.", code: r.code, bad: !!r.bad };
        W.ls("sa-web-last", r.user.login);
        if (r.user.needLegal) { pending = { login: r.user.login, token: r.token, remember: !!d.remember, user: r.user }; return { ok: true, needLegal: true, user: r.user }; }
        W.saveSession(r.user.login, r.token, !!d.remember);
        W.cacheUser(r.user, { sys: r.sys });
        setTimeout(enter, 0);
        return { ok: true, user: r.user };
      });
    },
    /* 3.5.3: вход через Discord. Окно Discord открывается сразу по нажатию (иначе браузер заблокирует его),
       адрес подставляется, когда сервер его выдал; результат ждём у сервера, опрашивая раз в 2 секунды. */
    discord: function (d) {
      d = d || {};
      var run = ++dcRun, win = null;
      // 3.7: продолжение входа после ввода кода (resume — тот же запрос входа, Discord второй раз не открываем)
      var rs = d.resume && d.resume.state && d.resume.pk ? d.resume : null;
      if (!rs) try { win = window.open("about:blank", "senko-discord", "width=520,height=760"); } catch (e) {}
      return (rs ? Promise.resolve(Object.assign({ ok: true, ttl: 600 }, rs)) : W.call({ action: "dc_auth_start", purpose: "login" })).then(function (st) {
        if (!st.ok) { try { win && win.close(); } catch (e) {} return { ok: false, error: st.error || "Не удалось начать вход через Discord.", code: st.code }; }
        if (rs) {} else if (win && !win.closed) win.location.href = st.url;
        else return { ok: false, error: "Браузер заблокировал окно Discord. Разрешите всплывающие окна для этого сайта и нажмите ещё раз." };
        var until = Date.now() + Math.min(600, +st.ttl || 600) * 1000;
        return new Promise(function (done) {
          (function tick() {
            if (run !== dcRun) return done({ ok: false, cancelled: true, error: "Вход через Discord отменён." });
            if (Date.now() > until) return done({ ok: false, error: "Время на вход вышло. Нажмите «Войти через Discord» ещё раз." });
            W.call(Object.assign({ action: "dc_auth_poll", state: st.state, pk: st.pk, remember: !!d.remember, otp: clean(d.otp, 20) }, W.client())).then(function (r) {
              if (run !== dcRun) return done({ ok: false, cancelled: true, error: "Вход через Discord отменён." });
              if ((r.ok && r.pending) || (!r.ok && (r.code === "network" || r.offline))) return setTimeout(tick, 2000);
              try { if (win && !win.closed) win.close(); } catch (e) {}
              if (!r.ok && r.code === "otp") return done({ ok: false, code: "otp", bad: !!r.bad, error: r.error, resume: { state: st.state, pk: st.pk } });
              if (!r.ok) return done({ ok: false, error: r.error || "Не удалось войти через Discord.", code: r.code });
              W.ls("sa-web-last", r.user.login);
              if (r.user.needLegal) { pending = { login: r.user.login, token: r.token, remember: !!d.remember, user: r.user }; return done({ ok: true, needLegal: true, user: r.user }); }
              W.saveSession(r.user.login, r.token, !!d.remember);
              W.cacheUser(r.user, { sys: r.sys });
              setTimeout(enter, 0);
              done({ ok: true, user: r.user });
            }, function () { setTimeout(tick, 2000); });
          })();
        });
      });
    },
    discordCancel: function () { dcRun++; },
    register: function (d) {
      d = d || {};
      return W.call(Object.assign({
        action: "register", login: d.login, password: d.password, nick: d.nick, static: d.static,
        server: clean(d.server, 4), org: d.org, orgOther: d.orgOther, role: d.role, discord: d.discord, telegram: d.telegram, phone: d.phone,
        remember: !!d.remember, migrated: false, invite: clean(d.invite, 20), legal: d.legal
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
