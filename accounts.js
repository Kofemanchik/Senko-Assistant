// Локальные аккаунты Senko Assistant.
// Пароли хранятся только в виде хэша scrypt (с индивидуальной солью), открытого пароля нигде нет.
//  • База логинов и паролей:  %APPDATA%\Boston\accounts.json
//  • Документ профиля:        Документы\Senko Assistant\Пользователи\user-<логин>.json
//  • Запомненный вход:        %APPDATA%\Boston\session.json
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const ROLES = { off: "Сотрудник", pros: "Прокурор", adv: "Адвокат" };
const DEPTS = ["LSPD", "LSCSD", "FIB", "SANG", "USSS"]; // как в списке «Мой департамент» в памятке
const OTHER = "other";

module.exports = function createAccounts({ dataDir, docsDir }) {
  const dbFile = () => path.join(dataDir(), "accounts.json");
  const sessFile = () => path.join(dataDir(), "session.json");
  const profDir = () => path.join(docsDir(), "Пользователи");
  const profFile = (login) => path.join(profDir(), `user-${login}.json`);

  let current = null; // вошедший пользователь (запись из базы)
  const fails = new Map(); // защита от подбора пароля: логин -> {n, until}

  function readDb() {
    try {
      const j = JSON.parse(fs.readFileSync(dbFile(), "utf8"));
      if (j && Array.isArray(j.users)) return j;
    } catch (e) {}
    return { v: 1, users: [] };
  }
  function writeFileAtomic(file, text) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + ".tmp";
    fs.writeFileSync(tmp, text, "utf8");
    fs.renameSync(tmp, file);
  }
  function writeDb(db) {
    writeFileAtomic(dbFile(), JSON.stringify(db, null, 2));
  }

  const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");
  function hashPass(pass, saltHex) {
    return crypto.scryptSync(pass, Buffer.from(saltHex, "hex"), 64, { N: 16384, r: 8, p: 1 }).toString("hex");
  }
  function samePass(pass, u) {
    const a = Buffer.from(hashPass(pass, u.salt), "hex");
    const b = Buffer.from(u.hash, "hex");
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }

  function writeProfileDoc(u) {
    try {
      const doc = {
        "Программа": "Senko Assistant",
        "Логин": u.login,
        "Ник игрока": u.nick,
        "Статик": u.static,
        "Организация": u.org,
        "Роль": ROLES[u.role] || u.role,
        "Создан": u.created,
        "Принял документы (версия)": u.legalVersion || "",
        "Дата принятия документов": u.legalAt || "",
        "Обновлён": new Date().toISOString()
      };
      writeFileAtomic(profFile(u.login), JSON.stringify(doc, null, 2));
    } catch (e) {
      console.error("profile doc failed:", e);
    }
  }

  const clean = (s, max) => String(s == null ? "" : s).replace(/[\u0000-\u001f]/g, " ").trim().slice(0, max);

  function validate(d) {
    const login = clean(d.login, 24);
    if (!/^[A-Za-z0-9_.-]{3,24}$/.test(login)) return { error: "Логин: 3–24 символа, латиница, цифры, «_», «.» или «-»." };
    const pass = String(d.password == null ? "" : d.password);
    if (pass.length < 6 || pass.length > 100) return { error: "Пароль должен быть не короче 6 символов." };
    const nick = clean(d.nick, 40);
    if (nick.length < 2) return { error: "Укажите ник игрока." };
    const st = clean(d.static, 12);
    if (!/^[0-9A-Za-z-]{1,12}$/.test(st)) return { error: "Статик: до 12 символов, цифры или латиница." };
    if (!ROLES[d.role]) return { error: "Выберите роль." };
    let org = clean(d.org, 60);
    if (d.org === OTHER) org = clean(d.orgOther, 60);
    if (!org) return { error: "Укажите организацию." };
    if (d.org !== OTHER && !DEPTS.includes(org)) return { error: "Выберите организацию из списка." };
    return { login, pass, nick, st, org, role: d.role, dept: DEPTS.includes(org) ? org : "" };
  }

  function pub(u) {
    return {
      login: u.login,
      nick: u.nick,
      static: u.static,
      org: u.org,
      dept: u.dept || "",
      role: u.role,
      roleName: ROLES[u.role] || u.role,
      seeded: !!u.seeded
    };
  }

  function rememberToken(db, u) {
    const token = crypto.randomBytes(32).toString("hex");
    u.tokens = (u.tokens || []).concat(sha(token)).slice(-5);
    writeDb(db);
    writeFileAtomic(sessFile(), JSON.stringify({ login: u.login, token }));
  }

  return {
    ROLES,
    DEPTS,
    hasUsers: () => readDb().users.length > 0,
    current: () => (current ? pub(current) : null),

    register(d) {
      d = d || {};
      if (!d.legal || d.legal.accepted !== true)
        return { ok: false, error: "Для регистрации нужно принять Политику конфиденциальности и Условия пользования." };
      const v = validate(d);
      if (v.error) return { ok: false, error: v.error };
      const db = readDb();
      if (db.users.some((u) => u.login.toLowerCase() === v.login.toLowerCase()))
        return { ok: false, error: "Такой логин уже занят." };
      const salt = crypto.randomBytes(16).toString("hex");
      const u = {
        login: v.login, salt, hash: hashPass(v.pass, salt),
        nick: v.nick, static: v.st, org: v.org, dept: v.dept, role: v.role,
        created: new Date().toISOString(), seeded: false, tokens: [],
        legalVersion: clean(d.legal.version, 20), legalAt: new Date().toISOString()
      };
      db.users.push(u);
      writeDb(db);
      writeProfileDoc(u);
      current = u;
      if (d.remember) rememberToken(db, u);
      return { ok: true, user: pub(u) };
    },

    login(d) {
      const login = clean(d && d.login, 24).toLowerCase();
      const pass = String((d && d.password) || "");
      const f = fails.get(login);
      if (f && f.until > Date.now())
        return { ok: false, error: `Слишком много попыток. Подождите ${Math.ceil((f.until - Date.now()) / 1000)} с.` };
      const db = readDb();
      const u = db.users.find((x) => x.login.toLowerCase() === login);
      if (!u || !pass || !samePass(pass, u)) {
        const n = ((f && f.n) || 0) + 1;
        fails.set(login, { n, until: n >= 5 ? Date.now() + 30000 : 0 });
        if (n >= 5) fails.set(login, { n: 0, until: Date.now() + 30000 });
        return { ok: false, error: "Неверный логин или пароль." };
      }
      fails.delete(login);
      current = u;
      if (!fs.existsSync(profFile(u.login))) writeProfileDoc(u);
      if (d.remember) rememberToken(db, u);
      return { ok: true, user: pub(u) };
    },

    restore() {
      try {
        const s = JSON.parse(fs.readFileSync(sessFile(), "utf8"));
        if (!s || !s.login || !s.token) return null;
        const u = readDb().users.find((x) => x.login === s.login);
        if (!u || !(u.tokens || []).includes(sha(s.token))) return null;
        current = u;
        return pub(u);
      } catch (e) {
        return null;
      }
    },

    logout() {
      try {
        const s = JSON.parse(fs.readFileSync(sessFile(), "utf8"));
        const db = readDb();
        const u = db.users.find((x) => x.login === (s && s.login));
        if (u && s.token) {
          u.tokens = (u.tokens || []).filter((h) => h !== sha(s.token));
          writeDb(db);
        }
      } catch (e) {}
      try { fs.unlinkSync(sessFile()); } catch (e) {}
      current = null;
    },

    markSeeded() {
      if (!current) return;
      const db = readDb();
      const u = db.users.find((x) => x.login === current.login);
      if (u) { u.seeded = true; writeDb(db); current.seeded = true; }
    },

    profileFolder: () => profDir()
  };
};
