// Аккаунты Senko Assistant: хранятся на сервере (Supabase), локально лежит только запомненная сессия.
//  • Сессия (токен, шифруется средствами Windows):  %APPDATA%\Senko Assistant\session.json
//  • Кэш профиля для работы без интернета:            %APPDATA%\Senko Assistant\profile-cache.json
//  • Документ профиля (копия ваших данных):           Документы\Senko Assistant\Пользователи\user-<логин>.json
//  • accounts.json от старых версий читается только один раз, для переноса аккаунта на сервер.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const ROLES = { off: "Сотрудник", pros: "Прокурор", adv: "Адвокат" };
const DEPTS = ["Government", "LSPD", "LSCSD", "FIB", "SANG"]; // должен совпадать с DEPTS в supabase/functions/senko/index.ts
const GOV_ORG = "Government"; // только этой организации доступны роли «Прокурор» и «Адвокат»
const OFFLINE_GRACE_DAYS = 14; // сколько дней можно работать без связи с сервером по запомненному входу
const STAFF_RANKS = ["leader", "moderator", "owner"];

module.exports = function createAccounts({ dataDir, docsDir, fetch: netFetch, safeStorage, config, version }) {
  const sessFile = () => path.join(dataDir(), "session.json");
  const cacheFile = () => path.join(dataDir(), "profile-cache.json");
  const deviceFile = () => path.join(dataDir(), "device.json");
  const legacyFile = () => path.join(dataDir(), "accounts.json");
  const profDir = () => path.join(docsDir(), "Пользователи");
  const profFile = (login) => path.join(profDir(), `user-${String(login).replace(/[^\w.-]/g, "_")}.json`);

  let current = null; // вошедший пользователь
  let token = null; // токен сессии (только в памяти и, если «запомнить», в зашифрованном файле)
  let remember = false;
  let pending = null; // свежая регистрация: сессия сохраняется после подтверждения кода восстановления
  let lastOk = 0; // когда в последний раз сервер подтвердил сессию
  let notice = "";
  let sys = null; // от сервера: режим техработ и сообщения от разработчика
  const takeSys = (r) => { if (r && r.ok && r.sys) sys = r.sys; };

  // ───────────── файлы ─────────────
  function writeFileAtomic(file, text) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + ".tmp";
    fs.writeFileSync(tmp, text, "utf8");
    fs.renameSync(tmp, file);
  }
  const readJson = (file) => {
    try {
      const j = JSON.parse(fs.readFileSync(file, "utf8"));
      return j && typeof j === "object" ? j : null;
    } catch (e) {
      return null;
    }
  };
  const clean = (s, max) => String(s == null ? "" : s).replace(/[\u0000-\u001f]/g, " ").trim().slice(0, max);

  function saveSession(login, tok) {
    const rec = { login };
    if (safeStorage && safeStorage.isEncryptionAvailable()) rec.enc = safeStorage.encryptString(tok).toString("base64");
    else rec.token = tok;
    writeFileAtomic(sessFile(), JSON.stringify(rec));
  }
  function loadSession() {
    const j = readJson(sessFile());
    if (!j || !j.login) return null;
    try {
      const tok = j.enc ? safeStorage.decryptString(Buffer.from(j.enc, "base64")) : j.token;
      if (typeof tok !== "string" || !/^[0-9a-f]{64}$/.test(tok)) return null;
      return { login: String(j.login), token: tok };
    } catch (e) {
      return null; // другой пользователь Windows или повреждённый файл
    }
  }
  const clearSession = () => {
    try { fs.unlinkSync(sessFile()); } catch (e) {}
  };
  function saveCache(u) {
    try { writeFileAtomic(cacheFile(), JSON.stringify({ user: u, at: Date.now() })); } catch (e) {}
  }
  function loadCache(login) {
    const j = readJson(cacheFile());
    if (!j || !j.user || String(j.user.login).toLowerCase() !== String(login).toLowerCase()) return null;
    return j;
  }
  // Случайный ID этой установки: сервер по нему замечает вход руководства с нового устройства
  function deviceId() {
    try {
      const d = readJson(deviceFile()) || {};
      if (typeof d.id === "string" && /^[0-9a-f]{32}$/.test(d.id)) return d.id;
      d.id = crypto.randomBytes(16).toString("hex");
      writeFileAtomic(deviceFile(), JSON.stringify(d));
      return d.id;
    } catch (e) {
      return "";
    }
  }
  // система для журнала входов: «Windows 11», «Windows 10» (без имени компьютера и пользователя)
  function osName() {
    try {
      const os = require("os");
      if (process.platform !== "win32") return process.platform + " " + os.release();
      const build = parseInt(String(os.release()).split(".")[2], 10) || 0;
      return build >= 22000 ? "Windows 11" : "Windows 10";
    } catch (e) { return ""; }
  }
  const client = () => ({ ver: String(version || ""), device: deviceId(), os: osName() });
  function rememberLogin(login) {
    try {
      const d = readJson(deviceFile()) || {};
      d.lastLogin = login;
      writeFileAtomic(deviceFile(), JSON.stringify(d));
    } catch (e) {}
  }
  function isSeeded(login) {
    const d = readJson(deviceFile()) || {};
    return !!(d.seeded && d.seeded[String(login).toLowerCase()]);
  }
  function setSeeded(login) {
    try {
      const d = readJson(deviceFile()) || {};
      d.seeded = d.seeded || {};
      d.seeded[String(login).toLowerCase()] = true;
      writeFileAtomic(deviceFile(), JSON.stringify(d));
    } catch (e) {}
  }

  function writeProfileDoc(u) {
    try {
      writeFileAtomic(
        profFile(u.login),
        JSON.stringify(
          {
            "Программа": "Senko Assistant",
            "Логин": u.login,
            "Ник игрока": u.nick,
            "Статик": u.static,
            "Организация": u.org,
            "Роль в игре": u.roleName,
            "Права в памятке": u.rankName,
            "Дискорд": u.discord,
            "Телеграм": u.telegram || "",
            "Номер в игре": u.phone || "",
            "Обновлён": new Date().toISOString()
          },
          null,
          2
        )
      );
    } catch (e) {
      console.error("profile doc failed:", e);
    }
  }

  // ───────────── запросы к серверу ─────────────
  async function call(body, timeoutMs) {
    let res;
    try {
      res = await netFetch(config.API_URL, {
        method: "POST",
        headers: { "content-type": "application/json", apikey: config.ANON_KEY },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs || 20000)
      });
    } catch (e) {
      return { ok: false, code: "network", error: "Нет связи с сервером. Проверьте подключение к интернету." };
    }
    let j = null;
    try { j = await res.json(); } catch (e) {}
    if (!j || typeof j !== "object") return { ok: false, code: "server", error: "Сервер временно недоступен. Попробуйте позже." };
    return j;
  }
  const isOffline = (r) => r && (r.code === "network" || r.code === "server");

  function pub() {
    return current ? { ...current } : null;
  }
  function setCurrent(u, tok, offline) {
    token = tok;
    current = { ...u, seeded: isSeeded(u.login), offline: !!offline };
    if (!offline) lastOk = Date.now();
  }

  // ───────────── перенос локального аккаунта старой версии ─────────────
  function legacyCheck(login, pass) {
    const db = readJson(legacyFile());
    if (!db || !Array.isArray(db.users)) return null;
    const u = db.users.find((x) => String(x.login).toLowerCase() === String(login).toLowerCase());
    if (!u || !u.salt || !u.hash) return null;
    try {
      const a = crypto.scryptSync(pass, Buffer.from(u.salt, "hex"), 64, { N: 16384, r: 8, p: 1 });
      const b = Buffer.from(u.hash, "hex");
      if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    } catch (e) {
      return null;
    }
    const inList = DEPTS.includes(u.org);
    return {
      seeded: !!u.seeded,
      prefill: {
        login: u.login,
        nick: u.nick || "",
        static: u.static || "",
        org: inList ? u.org : "other",
        orgOther: inList ? "" : u.org || "",
        role: ROLES[u.role] && (u.role === "off" || u.org === GOV_ORG) ? u.role : "off"
      }
    };
  }
  function legacyRemove(login) {
    try {
      const db = readJson(legacyFile());
      if (!db || !Array.isArray(db.users)) return;
      db.users = db.users.filter((x) => String(x.login).toLowerCase() !== String(login).toLowerCase());
      if (db.users.length) writeFileAtomic(legacyFile(), JSON.stringify(db, null, 2));
      else fs.unlinkSync(legacyFile());
    } catch (e) {}
  }

  // ───────────── публичный интерфейс ─────────────
  return {
    ROLES,
    DEPTS,
    GOV_ORG,
    current: () => pub(),
    isStaff: () => !!(current && STAFF_RANKS.includes(current.rank)),
    lastLogin: () => (readJson(deviceFile()) || {}).lastLogin || "",
    takeNotice() {
      const n = notice;
      notice = "";
      return n;
    },
    setNotice(n) {
      notice = String(n || "");
    },

    async login(d) {
      d = d || {};
      const login = clean(d.login, 24);
      const password = String(d.password == null ? "" : d.password);
      if (!login || !password) return { ok: false, error: "Введите логин и пароль." };
      const r = await call({ action: "login", login, password, remember: !!d.remember, ...client() });
      takeSys(r);
      if (r.ok) {
        remember = !!d.remember;
        setCurrent(r.user, r.token);
        rememberLogin(r.user.login);
        writeProfileDoc(current);
        if (r.user.needLegal) {
          // обновились Политика и Условия: сессия сохранится после принятия (см. commit)
          pending = { login: r.user.login, token: r.token };
          return { ok: true, needLegal: true, user: pub() };
        }
        if (remember) { saveSession(r.user.login, r.token); saveCache(r.user); } else clearSession();
        return { ok: true, user: pub() };
      }
      if (!r.code) {
        // Сервер не знает такой пароль, но он мог быть создан в старой, локальной версии
        const lg = legacyCheck(login, password);
        if (lg) return { ok: false, code: "migrate", prefill: lg.prefill, error: "Ваш локальный аккаунт нужно перенести на сервер. Дополните данные." };
      }
      return { ok: false, error: r.error || "Не удалось войти.", code: r.code };
    },

    async register(d) {
      d = d || {};
      const lg = d.migrated ? legacyCheck(clean(d.login, 24), String(d.password || "")) : null;
      const r = await call({
        action: "register",
        login: d.login, password: d.password, nick: d.nick, static: d.static,
        org: d.org, orgOther: d.orgOther, role: d.role,
        discord: d.discord, telegram: d.telegram, phone: d.phone,
        remember: !!d.remember, migrated: !!lg,
        legal: d.legal, ...client()
      });
      if (!r.ok) return { ok: false, error: r.error || "Не удалось зарегистрироваться.", code: r.code };
      takeSys(r);
      if (lg) {
        if (lg.seeded) setSeeded(r.user.login);
        legacyRemove(r.user.login);
      }
      if (r.pending) {
        // Включён приём новичков: аккаунт ждёт подтверждения руководства, входа пока нет
        rememberLogin(r.user.login);
        return { ok: true, pending: true, message: r.message || "", user: { ...r.user }, recoveryCode: r.recoveryCode };
      }
      setCurrent(r.user, r.token);
      remember = !!d.remember;
      pending = { login: r.user.login, token: r.token }; // сохраним сессию после подтверждения кода
      rememberLogin(r.user.login);
      writeProfileDoc(current);
      return { ok: true, user: pub(), recoveryCode: r.recoveryCode };
    },

    // Пользователь подтвердил, что сохранил код восстановления
    commit() {
      if (pending && current && remember) {
        saveSession(pending.login, pending.token);
        saveCache(current);
      }
      pending = null;
    },

    // Запомненный вход при старте программы
    async restore() {
      const s = loadSession();
      if (!s) return null;
      const r = await call({ action: "me", token: s.token, ...client() }, 10000);
      takeSys(r);
      if (r.ok && r.user.needLegal) {
        notice = "Обновились Политика конфиденциальности и Условия пользования. Войдите и примите их.";
        clearSession();
        return null;
      }
      if (r.ok) {
        remember = true;
        setCurrent(r.user, s.token);
        saveCache(r.user);
        return pub();
      }
      if (isOffline(r)) {
        const c = loadCache(s.login);
        if (c && Date.now() - c.at < OFFLINE_GRACE_DAYS * 864e5) {
          remember = true;
          setCurrent(c.user, s.token, true);
          lastOk = c.at;
          return pub();
        }
        notice = "Нет связи с сервером. Для входа нужен интернет.";
        return null;
      }
      if (r.code === "banned") notice = r.error;
      else notice = "Сессия завершена. Войдите заново.";
      clearSession();
      return null;
    },

    // Периодическая проверка: бан, смена ролей, обновление данных профиля
    async verify() {
      if (!current || !token) return { ok: true };
      const before = JSON.stringify(sys);
      const r = await call({ action: "me", token, ...client() }, 12000);
      takeSys(r);
      if (r.ok && r.user.needLegal) return { ok: false, error: "Обновились Политика и Условия. Войдите заново и примите их." };
      if (r.ok) {
        const changed = ["rank", "nick", "org", "role", "discord", "phone", "telegram", "static"].some((k) => r.user[k] !== current[k]) || JSON.stringify(sys) !== before;
        const wasOffline = current.offline;
        setCurrent(r.user, token);
        if (remember) saveCache(r.user);
        return { ok: true, changed: changed || wasOffline };
      }
      if (isOffline(r)) {
        if (current) current.offline = true;
        if (Date.now() - lastOk > OFFLINE_GRACE_DAYS * 864e5)
          return { ok: false, error: "Давно не было связи с сервером. Подключитесь к интернету и войдите заново." };
        return { ok: true, offline: true };
      }
      return { ok: false, error: r.code === "banned" ? r.error : "Сессия завершена. Войдите заново." };
    },

    logout() {
      const t = token;
      current = null;
      token = null;
      pending = null;
      remember = false;
      clearSession();
      if (t) call({ action: "logout", token: t }, 5000).catch(() => {});
    },

    markSeeded() {
      if (!current) return;
      setSeeded(current.login);
      current.seeded = true;
    },

    // Запрос к серверу от имени вошедшего пользователя (токен берётся сразу, до первого await)
    authed(body) {
      if (!token) return Promise.resolve({ ok: false, code: "auth", error: "Нужно войти в аккаунт." });
      return call({ ...body, token });
    },

    async acceptLegal(version) {
      if (!token) return { ok: false, code: "auth", error: "Нужно войти в аккаунт." };
      const r = await call({ action: "accept_legal", token, version: String(version || "") });
      if (r.ok && current) current.needLegal = false;
      return r;
    },

    // Изменение данных из личного кабинета (ник, статик, контакты, организация)
    async updateProfile(d) {
      if (!current || !token) return { ok: false, error: "Нужно войти в аккаунт.", code: "auth" };
      d = d || {};
      const r = await call({
        action: "update_profile", token,
        nick: clean(d.nick, 40), static: clean(d.static, 12), discord: clean(d.discord, 40),
        telegram: clean(d.telegram, 60), phone: clean(d.phone, 20), org: clean(d.org, 60)
      });
      if (r.ok && r.user) {
        setCurrent(r.user, token);
        if (remember) saveCache(r.user);
        writeProfileDoc(current);
      }
      return r;
    },

    sys: () => sys,

    // Сообщение об ошибке из программы — уходит владельцу в Telegram
    bugReport(text, log) {
      if (!current || !token) return Promise.resolve({ ok: false, error: "Нужно войти в аккаунт.", code: "auth" });
      return call({ action: "bug_report", token, text: String(text == null ? "" : text).slice(0, 2000), ver: String(version || ""), log: typeof log === "string" ? log.slice(0, 60000) : "" });
    },

    // Действия этапа 4: прогресс, рейтинг, смены, контрольные тесты
    act(action, data) {
      if (!current || !token) return Promise.resolve({ ok: false, error: "Нужно войти в аккаунт.", code: "auth" });
      return call({ ...client(), ...(data && typeof data === "object" ? data : {}), action, token });
    },

    async staffList() {
      if (!current || !token) return { ok: false, error: "Нужно войти в аккаунт.", code: "auth" };
      return call({ action: "staff_list", token });
    },

    resetRequest: (d) =>
      call({ action: "reset_request", login: clean(d && d.login, 24), nick: clean(d && d.nick, 40), static: clean(d && d.static, 12), recoveryCode: clean(d && d.recoveryCode, 40) }),
    resetStatus: (d) => call({ action: "reset_status", requestId: String((d && d.requestId) || ""), secret: String((d && d.secret) || "") }),
    async resetComplete(d) {
      const r = await call({ action: "reset_complete", resetToken: String((d && d.resetToken) || ""), password: String((d && d.password) || "") });
      if (r.ok) clearSession();
      return r;
    },

    profileFolder: () => profDir()
  };
};
