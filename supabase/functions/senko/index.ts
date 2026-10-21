// @ts-nocheck
// ============================================================================
// Senko Assistant · серверная функция (Supabase Edge Function «senko»)
// Одна функция делает всё:
//   • POST от приложения        → API (регистрация, вход, сессии, сброс пароля, список сотрудников)
//   • POST от Telegram          → бот (роли, баны, подтверждение сброса пароля)
//   • GET ?setup=<секрет>       → один раз подключает бота (setWebhook)
//
// Секреты (Edge Functions → Secrets), значения вводите только там и никому не присылайте:
//   TELEGRAM_BOT_TOKEN   токен бота от @BotFather
//   OWNER_TG_ID          числовой Telegram ID владельца
//   TG_WEBHOOK_SECRET    любая длинная случайная строка (латиница, цифры, _ и -)
// Остальное (SUPABASE_URL, SUPABASE_DB_URL) Supabase подставляет сам.
// ============================================================================
import postgres from "npm:postgres@3.4.5";

const DB_URL = Deno.env.get("DB_URL") || Deno.env.get("SUPABASE_DB_URL") || "";
const BOT_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN") || "";
const OWNER_TG = String(Deno.env.get("OWNER_TG_ID") || "").trim();
const WEBHOOK_SECRET = Deno.env.get("TG_WEBHOOK_SECRET") || "";
const TG_API = Deno.env.get("TG_API_BASE") || "https://api.telegram.org";
const SELF_URL = Deno.env.get("SELF_URL") || (Deno.env.get("SUPABASE_URL") || "") + "/functions/v1/senko";
const CONTACT = "Discord: hanamis1";

const DEPTS = ["Government", "LSPD", "LSCSD", "FIB", "SANG"]; // должен совпадать с DEPTS в accounts.js
const GOV_ORG = "Government"; // только этой организации доступны роли «Прокурор» и «Адвокат»
const GAME_ROLES = { off: "Сотрудник", pros: "Прокурор", adv: "Адвокат" };
// Роль в игре с учётом организации: вне Government всегда «Сотрудник»
const gameRole = (p) => (p.org === GOV_ORG ? p.game_role : "off");
const RANKS = { user: "Пользователь", leader: "Руководство", moderator: "Модератор памятки", owner: "Владелец" };
const LEGAL_VERSION = "2026-10-21.1"; // версия Политики и Условий; должна совпадать с VERSION в app/auth.html и app/index.html
const SYNC_KINDS = { thist: 1, dlog: 1, tests: 1, qstat: 1, xp: 1, daily: 1, streak: 1, favs: 1, notes: 1, labels: 1, folders: 1, favorder: 1 }; // что синхронизируется между компьютерами
const SYNC_MAX_ITEMS = 300; // элементов за один запрос
const SYNC_ITEM_BYTES = 65536; // размер одного элемента
const SYNC_USER_ROWS = 5000; // элементов на пользователя
const SESSION_DAYS = 60;
const SESSION_SHORT_HOURS = 24;
const RESET_TTL_MIN = 30; // сколько ждём подтверждения сброса
const RESET_APPROVED_MIN = 15; // сколько после подтверждения можно задать новый пароль

let _sql = null;
function db() {
  if (!_sql) {
    if (!DB_URL) throw new Error("Не задана строка подключения к базе (SUPABASE_DB_URL).");
    _sql = postgres(DB_URL, {
      max: 3,
      prepare: false,
      idle_timeout: 20,
      connect_timeout: 15,
      ssl: Deno.env.get("DB_SSL") === "off" ? false : "prefer",
      onnotice: () => {},
    });
  }
  return _sql;
}

// ───────────── утилиты ─────────────
const enc = new TextEncoder();
const hex = (a) => [...new Uint8Array(a)].map((b) => b.toString(16).padStart(2, "0")).join("");
async function sha256(s) {
  return hex(await crypto.subtle.digest("SHA-256", enc.encode(String(s))));
}
function rand(n = 32) {
  const a = new Uint8Array(n);
  crypto.getRandomValues(a);
  return hex(a);
}
const CODE_ALPH = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // 32 знака, без похожих O/0, I/1
function newRecoveryCode() {
  const a = new Uint8Array(16);
  crypto.getRandomValues(a);
  const s = [...a].map((b) => CODE_ALPH[b & 31]).join("");
  return s.match(/.{4}/g).join("-"); // 16 знаков по 5 бит = 80 бит
}
const normCode = (c) => String(c == null ? "" : c).toUpperCase().replace(/[^A-Z0-9]/g, "");
const clean = (s, max) => String(s == null ? "" : s).replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
const norm = (s) => clean(s, 80).toLowerCase();
const esc = (s) => String(s == null ? "" : s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
const J = (o, status = 200) =>
  new Response(JSON.stringify(o), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
const fail = (error, extra = {}) => ({ ok: false, error, ...extra });
const RATE_MSG = "Слишком много попыток. Подождите несколько минут и повторите.";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const fmtDate = (d) =>
  d ? new Date(d).toLocaleString("ru-RU", { timeZone: "Europe/Moscow", dateStyle: "short", timeStyle: "short" }) + " МСК" : "—";
function safeEq(a, b) {
  a = String(a);
  b = String(b);
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

// Ограничение частоты: true — можно, false — лимит исчерпан
async function hit(key, max, windowSec) {
  const sql = db();
  const [r] = await sql`
    insert into rate_limits (key, n, since) values (${key}, 1, now())
    on conflict (key) do update set
      n     = case when rate_limits.since < now() - make_interval(secs => ${windowSec}) then 1 else rate_limits.n + 1 end,
      since = case when rate_limits.since < now() - make_interval(secs => ${windowSec}) then now() else rate_limits.since end
    returning n`;
  return r.n <= max;
}

async function audit(actor, action, target, details) {
  try {
    await db()`insert into audit_log (actor, action, target, details) values (${actor}, ${action}, ${target || null}, ${db().json(details || {})})`;
  } catch (e) {
    console.error("audit", e);
  }
}

async function cleanup() {
  const sql = db();
  await sql`delete from sessions where expires_at < now()`;
  await sql`delete from rate_limits where since < now() - interval '1 day'`;
  await sql`delete from sync_items where deleted and to_timestamp(u / 1000.0) < now() - interval '60 days'`;
  await sql`update reset_requests set status = 'expired' where status in ('pending','approved') and expires_at < now()`;
  await sql`delete from reset_requests where created_at < now() - interval '7 days'`;
  await sql`delete from bot_pending where expires_at < now()`;
  await sql`delete from ai_log where at < now() - interval '90 days'`;
  await sql`update profiles set banned = false, ban_reason = '', banned_at = null, banned_until = null where banned and banned_until is not null and banned_until <= now()`;
}
const maybeCleanup = () => (Math.random() < 0.05 ? cleanup().catch((e) => console.error("cleanup", e)) : null);

// ───────────── Telegram ─────────────
async function tg(method, payload) {
  if (!BOT_TOKEN) return null;
  try {
    const r = await fetch(`${TG_API}/bot${BOT_TOKEN}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(8000),
    });
    return await r.json();
  } catch (e) {
    console.error("telegram", method, String(e).split(BOT_TOKEN).join("***"));
    return null;
  }
}
const send = (chat, text, extra = {}) =>
  tg("sendMessage", { chat_id: chat, text, parse_mode: "HTML", disable_web_page_preview: true, ...extra });

async function moderatorChats() {
  const rows = await db()`select tg_id from profiles where rank = 'moderator' and tg_id is not null and not banned`;
  return rows.map((r) => String(r.tg_id));
}

// Карточка пользователя; состав полей зависит от того, кто смотрит
function card(p, viewer) {
  const L = [
    `👤 <b>${esc(p.login)}</b> — ${RANKS[p.rank] || p.rank}${p.banned ? " 🚫 ЗАБЛОКИРОВАН" : ""}`,
    `Ник: ${esc(p.nick)}`,
    `Статик: <code>${esc(p.static_id)}</code>`,
    `Организация: ${esc(p.org)}`,
    `Роль в игре: ${GAME_ROLES[gameRole(p)] || gameRole(p)}`,
    `Дискорд: ${esc(p.discord)}`,
    `Номер в игре: ${esc(p.phone)}`,
  ];
  if (viewer === "owner") {
    L.push(`Телеграм: ${p.telegram ? esc(p.telegram) : "—"}`);
    L.push(`Telegram ID: ${p.tg_id == null ? "—" : p.tg_id}`);
    L.push(`Принял документы: ${p.legal_version || "—"}`);
  }
  if (p.approval && p.approval !== "ok") L.push(p.approval === "pending" ? "⏳ Заявка ждёт подтверждения руководства" : "❌ Заявка отклонена руководством");
  L.push(`Регистрация: ${fmtDate(p.created_at)}`);
  L.push(`Был в сети: ${fmtDate(p.last_seen)}`);
  if (p.banned) L.push(`Причина блокировки: ${esc(p.ban_reason) || "—"}${p.banned_until ? " (до " + fmtDate(p.banned_until) + ")" : ""}`);
  return L.join("\n");
}

// ───────────── Пользователи, сессии ─────────────
const banMsg = (p) =>
  `Аккаунт заблокирован${p.banned_until ? " до " + fmtDate(p.banned_until) : ""}.${p.ban_reason ? " Причина: " + p.ban_reason + "." : ""} Связь: ${CONTACT}`;

// Временная блокировка истекла — снимаем её при первом же обращении пользователя
async function liftExpiredBan(p) {
  if (!p || !p.banned || !p.banned_until || new Date(p.banned_until).getTime() > Date.now()) return p;
  await db()`update profiles set banned = false, ban_reason = '', banned_at = null, banned_until = null where id = ${p.id}`;
  await audit("system", "tempban_end", p.login, {});
  return { ...p, banned: false, ban_reason: "", banned_at: null, banned_until: null };
}

function pub(p) {
  return {
    login: p.login,
    nick: p.nick,
    static: p.static_id,
    org: p.org,
    dept: p.dept || "",
    role: gameRole(p),
    roleName: GAME_ROLES[gameRole(p)] || gameRole(p),
    rank: p.rank,
    rankName: RANKS[p.rank] || p.rank,
    discord: p.discord,
    telegram: p.telegram,
    phone: p.phone,
    needLegal: p.legal_version !== LEGAL_VERSION,
  };
}

async function newSession(userId, remember) {
  const token = rand(32);
  const hours = remember ? SESSION_DAYS * 24 : SESSION_SHORT_HOURS;
  await db()`insert into sessions (token_hash, user_id, expires_at, remember)
             values (${await sha256(token)}, ${userId}, now() + make_interval(hours => ${hours}), ${!!remember})`;
  return token;
}

async function sessionUser(token) {
  if (typeof token !== "string" || !/^[0-9a-f]{64}$/.test(token)) return null;
  const sql = db();
  const th = await sha256(token);
  const [p] = await sql`
    select p.*, s.remember as s_remember, s.last_used as s_last_used
    from sessions s join profiles p on p.id = s.user_id
    where s.token_hash = ${th} and s.expires_at > now()`;
  if (!p) return null;
  if (!p.s_last_used || Date.now() - new Date(p.s_last_used).getTime() > 3600e3) {
    const hours = p.s_remember ? SESSION_DAYS * 24 : SESSION_SHORT_HOURS;
    await sql`update sessions set last_used = now(), expires_at = now() + make_interval(hours => ${hours}) where token_hash = ${th}`;
  }
  // «был в сети» обновляем не реже раза в 10 минут — по нему работают /online и панель руководителя
  if (!p.last_seen || Date.now() - new Date(p.last_seen).getTime() > 600e3) await sql`update profiles set last_seen = now() where id = ${p.id}`;
  return liftExpiredBan(p);
}

// Проверка сессии + права. Возвращает {p} или {err}
async function who(b, ranks) {
  const p = await sessionUser(b.token);
  if (!p) return { err: fail("Сессия недействительна. Войдите заново.", { code: "auth" }) };
  if (p.banned) {
    await db()`delete from sessions where user_id = ${p.id}`;
    return { err: fail(banMsg(p), { code: "banned" }) };
  }
  // заявка не подтверждена: для программы это как блокировка (выход с сообщением)
  if (p.approval && p.approval !== "ok") return { err: fail(approvalMsg(p), { code: "banned" }) };
  if (ranks && !ranks.includes(p.rank)) return { err: fail("Недостаточно прав.", { code: "forbidden" }) };
  return { p };
}

// ───────────── Проверка данных регистрации ─────────────
function validate(b) {
  const login = clean(b.login, 24);
  if (!/^[A-Za-z0-9_.-]{3,24}$/.test(login)) return { error: "Логин: 3–24 символа, латиница, цифры, «_», «.» или «-»." };
  const pass = String(b.password == null ? "" : b.password);
  const pe = passError(pass);
  if (pe) return { error: pe };
  const f = checkFields(b);
  if (f.error) return f;
  if (!GAME_ROLES[b.role]) return { error: "Выберите роль." };
  let org = clean(b.org, 60);
  if (b.org === "other") org = clean(b.orgOther, 60);
  if (!org) return { error: "Укажите организацию." };
  if (b.org !== "other" && !DEPTS.includes(org)) return { error: "Выберите организацию из списка." };
  if (b.role !== "off" && org !== GOV_ORG) return { error: "Роли «Прокурор» и «Адвокат» доступны только сотрудникам Government." };
  return { login, pass, ...f, org, dept: DEPTS.includes(org) ? org : "", role: b.role };
}
// Поля профиля, которые пользователь может указать при регистрации и потом поменять в личном кабинете
function checkFields(b) {
  const nick = clean(b.nick, 40);
  if (nick.length < 2) return { error: "Укажите ник игрока." };
  const st = clean(b.static, 12);
  if (!/^[0-9A-Za-z-]{1,12}$/.test(st)) return { error: "Статик: до 12 символов, цифры или латиница." };
  const discord = clean(b.discord, 40).replace(/^@/, "");
  if (!/^[A-Za-z0-9_.#-]{2,40}$/.test(discord)) return { error: "Дискорд: ник пользователя (латиница, цифры, «_», «.»)." };
  let telegram = clean(b.telegram, 60)
    .replace(/^https?:\/\/(t\.me|telegram\.me)\//i, "")
    .replace(/^@/, "");
  if (telegram && !/^[A-Za-z0-9_]{5,32}$/.test(telegram)) return { error: "Телеграм: ник вида @name (5–32 символа) или оставьте поле пустым." };
  if (telegram) telegram = "@" + telegram;
  const phone = String(b.phone == null ? "" : b.phone).replace(/[\s()+-]/g, "");
  if (!/^[0-9]{3,12}$/.test(phone)) return { error: "Номер в игре: только цифры (3–12 знаков)." };
  return { nick, st, discord, telegram, phone };
}
function passError(pass) {
  if (pass.length < 6) return "Пароль должен быть не короче 6 символов.";
  if (enc.encode(pass).length > 72) return "Пароль слишком длинный (не более 72 байт).";
  return "";
}

// ───────────── API: регистрация ─────────────
async function register(b, ip) {
  if (!b.legal || b.legal.accepted !== true)
    return fail("Для регистрации нужно принять Политику конфиденциальности и Условия пользования.");
  if (clean(b.legal.version, 20) !== LEGAL_VERSION)
    return fail("Условия обновились. Обновите программу до последней версии и повторите регистрацию.", { code: "update" });
  if (!(await hit(`reg:${ip}`, 8, 3600))) return fail(RATE_MSG, { code: "rate" });
  const v = validate(b);
  if (v.error) return fail(v.error);
  const sql = db();
  const mt = await getSetting("maintenance", { on: false });
  if (mt && mt.on) return fail("Идут технические работы, регистрация временно недоступна. Попробуйте позже.", { code: "maintenance" });
  const regs = await getSetting("regs", { open: true, limit: 0 });
  if (regs.open === false) return fail("Регистрация временно закрыта. Попробуйте позже.", { code: "closed" });
  if (regs.limit) {
    const [{ n }] = await sql`select count(*)::int n from profiles where created_at > now() - interval '1 day'`;
    if (n >= regs.limit) {
      if (regs.alerted !== mskDay()) {
        await setSetting("regs", { ...regs, alerted: mskDay() });
        await quiet(`⛔ Достигнут лимит регистраций: ${regs.limit} за сутки. Новые регистрации отклоняются. Изменить: /reglimit`);
      }
      return fail("Сегодня зарегистрировалось слишком много аккаунтов. Попробуйте завтра.", { code: "closed" });
    }
  }
  const bad = await blacklisted(v.login, v.nick);
  if (bad) return fail("Логин или ник содержит недопустимое слово. Выберите другой.");
  const code = newRecoveryCode();
  const codeHash = await sha256(normCode(code));
  const pend = !!(await getSetting("approval", { on: false })).on; // приём новичков: аккаунт ждёт подтверждения руководства
  let p;
  try {
    p = await sql.begin(async (t) => {
      const [row] = await t`
        insert into profiles (login, pass_hash, nick, static_id, org, dept, game_role, discord, telegram, phone, legal_version, legal_at, approval)
        values (${v.login}, extensions.crypt(${v.pass}, extensions.gen_salt('bf', 10)), ${v.nick}, ${v.st}, ${v.org}, ${v.dept},
                ${v.role}, ${v.discord}, ${v.telegram}, ${v.phone}, ${clean(b.legal.version, 20)}, now(), ${pend ? "pending" : "ok"})
        returning *`;
      await t`insert into recovery_codes (user_id, code_hash) values (${row.id}, ${codeHash})`;
      return row;
    });
  } catch (e) {
    if (e && e.code === "23505") return fail("Такой логин уже занят.");
    throw e;
  }
  const token = pend ? null : await newSession(p.id, !!b.remember);
  maybeCleanup();
  const ver = clean(b.ver, 20);
  if (ver) await sql`update profiles set app_version = ${ver} where id = ${p.id}`;

  // Уведомление владельцу — сбой Telegram не должен ломать регистрацию
  try {
    if (OWNER_TG) {
      const dup = await sql`select login from profiles where lower(static_id) = lower(${p.static_id}) and id <> ${p.id}`;
      const [{ n }] = await sql`select count(*)::int as n from profiles`;
      let text = `🆕 <b>Новая регистрация</b>${b.migrated ? " (перенос локального аккаунта)" : ""}${pend ? " · ждёт подтверждения руководства" : ""}\n\n${card(p, "owner")}`;
      if (dup.length) text += `\n\n⚠️ Этот статик уже указан у: ${dup.map((d) => esc(d.login)).join(", ")}`;
      text += `\n\nВсего пользователей: ${n}`;
      await send(OWNER_TG, text);
      if (MILESTONES.includes(n)) await send(OWNER_TG, `🎉 Поздравляю! Зарегистрировался ${n}-й пользователь Senko Assistant: <b>${esc(p.login)}</b>.`);
    }
  } catch (e) {
    console.error("notify register", e);
  }
  if (pend) {
    try {
      await askApproval(p);
    } catch (e) {
      console.error("ask approval", e);
    }
    return { ok: true, pending: true, message: approvalMsg(p), user: pub(p), recoveryCode: code };
  }
  return { ok: true, token, user: pub(p), recoveryCode: code, sys: await sysFor(p) };
}

// ───────────── API: вход ─────────────
const DUMMY_SALT = "$2a$10$abcdefghijklmnopqrstuv"; // чтобы время ответа не выдавало, существует ли логин
async function login(b, ip) {
  const lc = clean(b.login, 24).toLowerCase();
  const pass = String(b.password == null ? "" : b.password);
  if (!lc || !pass) return fail("Введите логин и пароль.");
  if (
    !(await hit(`ip:${ip}`, 40, 900)) ||
    !(await hit(`lg:${lc}:${ip}`, 6, 900)) ||
    !(await hit(`la:${lc}`, 60, 3600))
  )
    return fail(RATE_MSG, { code: "rate" });
  const sql = db();
  const [p0] = await sql`select * from profiles where login_lc = ${lc}`;
  const p = await liftExpiredBan(p0);
  if (!p) {
    await sql`select extensions.crypt(${pass}, ${DUMMY_SALT})`;
    return fail("Неверный логин или пароль.");
  }
  const [{ ok }] = await sql`select extensions.crypt(${pass}, ${p.pass_hash}) = ${p.pass_hash} as ok`;
  if (!ok) {
    // много неудачных попыток подряд — тихое уведомление владельцу (один раз на серию)
    const n = await hitN(`lf:${lc}`, 900);
    if (n === FAIL_ALERT) await quiet(`⚠️ ${n} неудачных попыток входа в <b>${esc(p.login)}</b> (${RANKS[p.rank]}) за 15 минут.`);
    return fail("Неверный логин или пароль.");
  }
  if (p.banned) return fail(banMsg(p), { code: "banned" });
  if (p.approval && p.approval !== "ok") return fail(approvalMsg(p), { code: p.approval });
  await sql`delete from rate_limits where key = ${"lg:" + lc + ":" + ip} or key = ${"lf:" + lc}`;
  const token = await newSession(p.id, !!b.remember);
  await sql`update profiles set last_seen = now() where id = ${p.id}`;
  await noteClient(p, b);
  maybeCleanup();
  return { ok: true, token, user: pub(p), sys: await sysFor(p) };
}

// ───────────── API: изменение данных из личного кабинета ─────────────
const PROFILE_FIELDS = [
  ["nick", "nick", "Ник"],
  ["st", "static_id", "Статик"],
  ["discord", "discord", "Дискорд"],
  ["telegram", "telegram", "Телеграм"],
  ["phone", "phone", "Номер в игре"],
  ["org", "org", "Организация"],
];
async function updateProfile(b) {
  const { p, err } = await who(b);
  if (err) return err;
  if (!(await hit(`up:${p.id}`, 10, 3600))) return fail(RATE_MSG, { code: "rate" });
  const v = checkFields(b);
  if (v.error) return fail(v.error);
  if (v.nick !== p.nick && (await blacklisted(v.nick))) return fail("Ник содержит недопустимое слово. Выберите другой.");
  // организацию можно выбрать только из списка; не указана — остаётся прежней
  v.org = b.org == null || b.org === "" ? p.org : DEPTS.find((d) => d === b.org);
  if (!v.org) return fail("Выберите организацию из списка.");
  const changes = PROFILE_FIELDS.filter(([k, col]) => String(p[col] || "") !== v[k]).map(([k, col, label]) => ({ label, from: String(p[col] || ""), to: v[k] }));
  if (!changes.length) return { ok: true, user: pub(p), changed: 0 };
  const sql = db();
  const orgChanged = v.org !== p.org;
  const [np] = await sql`update profiles set nick = ${v.nick}, static_id = ${v.st}, discord = ${v.discord}, telegram = ${v.telegram}, phone = ${v.phone},
                           org = ${v.org}, dept = ${orgChanged ? v.org : p.dept}
                         where id = ${p.id} returning *`;
  await audit(p.login, "profile_update", p.login, { changes });
  // Уведомление владельцу о каждой смене — сбой Telegram не должен ломать сохранение
  try {
    if (OWNER_TG) {
      let text = `✏️ <b>Изменение данных</b>: <code>${esc(p.login)}</code> · ${esc(p.org)}\n\n` +
        changes.map((c) => `${c.label}: ${esc(c.from) || "—"} → <b>${esc(c.to) || "—"}</b>`).join("\n");
      if (orgChanged && (v.org === GOV_ORG || p.org === GOV_ORG))
        text += `\n\n⚖️ Режимы «Прокурор» и «Адвокат» ${v.org === GOV_ORG ? "открылись" : "закрылись"}. Вернуть организацию: /setorg ${esc(p.login)} ${esc(p.org)}`;
      if (changes.some((c) => c.label === "Статик")) {
        const dup = await sql`select login from profiles where lower(static_id) = lower(${np.static_id}) and id <> ${np.id}`;
        if (dup.length) text += `\n\n⚠️ Этот статик уже указан у: ${dup.map((d) => esc(d.login)).join(", ")}`;
      }
      await send(OWNER_TG, text);
    }
  } catch (e) {
    console.error("notify profile", e);
  }
  return { ok: true, user: pub(np), changed: changes.length };
}

// ───────────── API: принятие новой редакции документов ─────────────
async function acceptLegal(b) {
  const { p, err } = await who(b);
  if (err) return err;
  if (clean(b.version, 20) !== LEGAL_VERSION) return fail("Устаревшая версия программы. Обновите программу.", { code: "update" });
  await db()`update profiles set legal_version = ${LEGAL_VERSION}, legal_at = now() where id = ${p.id}`;
  return { ok: true };
}

// ───────────── API: синхронизация данных между компьютерами ─────────────
// Элементы (задержания, результаты тестов, статистика) хранятся по ключу (вид, id).
// Конфликты решает «последняя правка» (поле u); удаление — это запись с del = true.
async function syncApi(b) {
  const { p, err } = await who(b);
  if (err) return err;
  if (!(await hit(`sy:${p.id}`, 240, 3600))) return fail(RATE_MSG, { code: "rate" });
  const device = clean(b.device, 40) || "?";
  const items = Array.isArray(b.items) ? b.items : [];
  if (items.length > SYNC_MAX_ITEMS) return fail("Слишком много данных за один запрос.");
  const sql = db();
  if (items.length) {
    const [{ n }] = await sql`select count(*)::int as n from sync_items where user_id = ${p.id}`;
    if (n >= SYNC_USER_ROWS) return fail("Достигнут предел объёма данных. Обратитесь к владельцу.");
  }
  // опыт на начало недели — до того, как новый опыт запишется (для рейтинга недели)
  const xpIt = items.find((it) => it && it.kind === "xp" && !it.del);
  if (xpIt) {
    const w = mskWeek();
    await sql`insert into xp_week (user_id, week, base)
              values (${p.id}, ${w.key}, coalesce((select max(senko_num(data#>>'{}'))::int from sync_items where user_id = ${p.id} and kind = 'xp' and not deleted),
                                                  ${Math.max(0, Math.floor(+xpIt.data) || 0)}))
              on conflict do nothing`;
  }
  let accepted = 0;
  for (const it of items) {
    if (!it || typeof it !== "object") continue;
    const kind = String(it.kind);
    const id = clean(it.id, 40);
    const u = Number(it.u);
    if (!SYNC_KINDS[kind] || !id || !Number.isFinite(u)) continue;
    if (it.del) {
      await sql`insert into sync_items (user_id, kind, item_id, data, u, deleted, device, seq)
                values (${p.id}, ${kind}, ${id}, null, ${u}, true, ${device}, nextval('sync_seq'))
                on conflict (user_id, kind, item_id) do update
                  set data = null, u = excluded.u, deleted = true, device = excluded.device, seq = excluded.seq
                  where sync_items.u <= excluded.u`;
      accepted++;
      continue;
    }
    const json = JSON.stringify(it.data);
    if (json === undefined || json.length > SYNC_ITEM_BYTES) continue;
    await sql`insert into sync_items (user_id, kind, item_id, data, u, deleted, device, seq)
              values (${p.id}, ${kind}, ${id}, ${json}::text::jsonb, ${u}, false, ${device}, nextval('sync_seq'))
              on conflict (user_id, kind, item_id) do update
                set data = excluded.data, u = excluded.u, deleted = false, device = excluded.device, seq = excluded.seq
                where sync_items.u <= excluded.u`;
    accepted++;
  }
  if (accepted && items.some((it) => it && ["thist", "tests", "xp", "streak"].includes(String(it.kind))) && (await hit(`ach:${p.id}`, 1, 60)))
    await checkAch(p).catch((e) => console.error("ach", e));
  const out = { ok: true, accepted };
  if (b.pull) {
    const since = Number.isFinite(+b.since) ? Math.max(0, Math.floor(+b.since)) : 0;
    const [{ m }] = await sql`select coalesce(max(seq), 0)::bigint as m from sync_items where user_id = ${p.id}`;
    const rows = await sql`select kind, item_id, data, u, deleted, seq from sync_items
                           where user_id = ${p.id} and seq > ${since} and seq <= ${m} and device <> ${device}
                           order by seq limit 501`;
    const more = rows.length > 500;
    if (more) rows.pop();
    out.items = rows.map((r) => ({ kind: r.kind, id: r.item_id, data: r.deleted ? null : r.data, u: Number(r.u), del: !!r.deleted }));
    out.cursor = more ? Number(rows[rows.length - 1].seq) : Number(m);
    out.more = more;
  }
  return out;
}

// «Сбросить все данные» в программе: данные работы и избранное удаляются на всех компьютерах пользователя.
// Записи помечаются удалёнными (а не стираются), чтобы другие компьютеры тоже убрали их у себя. Достижения остаются.
const SYNC_RESET_KINDS = ["thist", "dlog", "tests", "favs", "notes", "labels", "folders", "favorder"];
async function syncReset(b) {
  const { p, err } = await who(b);
  if (err) return err;
  if (!(await hit(`sreset:${p.id}`, 3, 3600))) return fail(RATE_MSG, { code: "rate" });
  const sql = db();
  // опыт, серия, мини-тест дня и статистика тренажёра остаются: это прогресс (уровень, рейтинг, достижения)
  const r = await sql`update sync_items set data = null, deleted = true, u = ${Date.now()}, device = 'reset', seq = nextval('sync_seq')
                      where user_id = ${p.id} and not deleted and kind = any(${SYNC_RESET_KINDS}::text[]) returning 1`;
  await audit(p.login, "sync_reset", p.login, { items: r.length });
  return { ok: true, items: r.length };
}

// Сводка по данным пользователей (для владельца)
async function userStats() {
  const rows = await db()`
    select user_id,
           count(*) filter (where kind = 'thist' and not deleted)::int as det,
           count(*) filter (where kind = 'thist' and not deleted and u > (extract(epoch from now() - interval '7 days') * 1000))::int as det7,
           count(*) filter (where kind = 'tests' and not deleted)::int as tests,
           round(avg(senko_num(data->>'p')) filter (where kind = 'tests' and not deleted))::int as avg_p,
           max(senko_num(data#>>'{}')) filter (where kind = 'xp' and not deleted)::int as xp
    from sync_items group by user_id`;
  const m = {};
  for (const r of rows) m[r.user_id] = { det: r.det, det7: r.det7, tests: r.tests, avg_p: r.avg_p, xp: r.xp };
  return m;
}
const statLine = (s) => (s ? `Задержаний: ${s.det} · тестов: ${s.tests}${s.avg_p == null ? "" : " (средний результат " + s.avg_p + "%)"} · XP: ${s.xp == null ? 0 : s.xp}` : "Данных работы пока нет");

// ───────────── API: список сотрудников (состав полей зависит от ранга) ─────────────
async function staffList(b) {
  const { p, err } = await who(b, ["leader", "moderator", "owner"]);
  if (err) return err;
  // Руководство видит только свою организацию, модераторы и владелец — все
  const scope = p.rank === "leader" ? p.org : null;
  const rows = scope
    ? await db()`select * from profiles where org = ${scope} order by created_at`
    : await db()`select * from profiles order by created_at`;
  const stats = await userStats();
  const wk = Object.fromEntries((await weekStats(scope)).map((x) => [x.id, x]));
  const list = rows.map((r) => {
    const st = stats[r.id] || {};
    const w = wk[r.id] || {};
    const o = {
      login: r.login,
      nick: r.nick,
      static: r.static_id,
      org: r.org,
      role: gameRole(r),
      rank: r.rank,
      created: r.created_at,
      discord: r.discord,
      phone: r.phone,
      last_seen: r.last_seen,
      // показатели работы видны всем, у кого есть доступ к панели
      det: st.det || 0,
      det7: st.det7 || 0,
      tests: st.tests || 0,
      avg_p: st.avg_p == null ? null : st.avg_p,
      xp: st.xp == null ? 0 : st.xp,
      wxp: w.wxp || 0,
      ach: w.ach || 0,
      approval: r.approval,
    };
    if (p.rank === "owner" || p.rank === "moderator") {
      o.banned = r.banned;
      o.ban_reason = r.ban_reason;
    }
    if (p.rank === "owner") {
      o.telegram = r.telegram;
      o.tg_id = r.tg_id == null ? null : String(r.tg_id);
      o.legal_version = r.legal_version;
    }
    return o;
  });
  return { ok: true, viewer: p.rank, scope, orgs: scope ? [scope] : DEPTS, list };
}

// ───────────── API: сброс пароля ─────────────
async function resetRequest(b, ip) {
  if (!(await hit(`rr:${ip}`, 8, 3600))) return fail(RATE_MSG, { code: "rate" });
  const lc = clean(b.login, 24).toLowerCase();
  if (!lc || !(await hit(`rl:${lc}`, 5, 3600))) return fail(RATE_MSG, { code: "rate" });
  const sql = db();
  const [p0] = await sql`select * from profiles where login_lc = ${lc}`;
  const p = await liftExpiredBan(p0);
  if (!p || norm(p.nick) !== norm(b.nick) || norm(p.static_id) !== norm(b.static))
    return fail("Данные не совпали. Проверьте логин, ник и статик.");
  if (p.banned) return fail(banMsg(p), { code: "banned" });

  const code = normCode(b.recoveryCode);
  if (code) {
    // Быстрый путь: верный код восстановления — подтверждение модератора не нужно
    if (!(await hit(`rc:${p.id}`, 5, 3600))) return fail(RATE_MSG, { code: "rate" });
    const [rc] = await sql`select code_hash from recovery_codes where user_id = ${p.id}`;
    if (!rc || !safeEq(rc.code_hash, await sha256(code))) return fail("Код восстановления неверный.");
    const token = rand(32);
    await sql.begin(async (t) => {
      await t`update reset_requests set status = 'cancelled' where user_id = ${p.id} and status in ('pending','approved')`;
      await t`insert into reset_requests (user_id, status, via, token_hash, token_expires, decided_by, decided_at, expires_at)
              values (${p.id}, 'approved', 'code', ${await sha256(token)}, now() + make_interval(mins => ${RESET_APPROVED_MIN}),
                      'recovery-code', now(), now() + make_interval(mins => ${RESET_APPROVED_MIN}))`;
    });
    return { ok: true, mode: "code", resetToken: token };
  }

  // Основной путь: запрос уходит владельцу и модераторам в Telegram
  const secret = rand(16);
  const id = await sql.begin(async (t) => {
    await t`update reset_requests set status = 'cancelled' where user_id = ${p.id} and status in ('pending','approved')`;
    const [r] = await t`insert into reset_requests (user_id, secret_hash, status, via, expires_at)
                        values (${p.id}, ${await sha256(secret)}, 'pending', 'bot', now() + make_interval(mins => ${RESET_TTL_MIN}))
                        returning id`;
    return r.id;
  });
  maybeCleanup();
  try {
    const buttons = {
      reply_markup: {
        inline_keyboard: [[
          { text: "✅ Подтвердить", callback_data: `rs:ok:${id}` },
          { text: "❌ Отклонить", callback_data: `rs:no:${id}` },
        ]],
      },
    };
    const body = (viewer) =>
      `🔑 <b>Запрос на сброс пароля</b>\n\n${card(p, viewer)}\n\nНик и статик из запроса совпали с профилем. ` +
      `Подтверждайте, только если уверены, что это сам игрок (например, по Discord). Запрос действует ${RESET_TTL_MIN} мин.`;
    if (OWNER_TG) await send(OWNER_TG, body("owner"), buttons);
    for (const chat of await moderatorChats()) if (chat !== OWNER_TG) await send(chat, body("moderator"), buttons);
  } catch (e) {
    console.error("notify reset", e);
  }
  return { ok: true, mode: "pending", requestId: id, secret, ttlMin: RESET_TTL_MIN };
}

async function resetStatus(b, ip) {
  if (!(await hit(`rs:${ip}`, 600, 3600))) return fail(RATE_MSG, { code: "rate" });
  if (!UUID_RE.test(String(b.requestId || ""))) return fail("Запрос не найден.", { code: "gone" });
  const sql = db();
  const sh = await sha256(String(b.secret || ""));
  const [r] = await sql`select * from reset_requests where id = ${b.requestId} and secret_hash = ${sh}`;
  if (!r) return fail("Запрос не найден.", { code: "gone" });
  const expired = new Date(r.expires_at).getTime() < Date.now();
  if (r.status === "pending") {
    if (expired) {
      await sql`update reset_requests set status = 'expired' where id = ${r.id}`;
      return { ok: true, status: "expired" };
    }
    return { ok: true, status: "pending" };
  }
  if (r.status === "approved" && !expired) {
    const token = rand(32); // выдаём свежий токен при каждом опросе, пока пароль не задан
    await sql`update reset_requests set token_hash = ${await sha256(token)},
              token_expires = now() + make_interval(mins => ${RESET_APPROVED_MIN}) where id = ${r.id}`;
    return { ok: true, status: "approved", resetToken: token };
  }
  if (r.status === "rejected") return { ok: true, status: "rejected" };
  if (r.status === "done") return { ok: true, status: "done" };
  return { ok: true, status: "expired" };
}

async function resetComplete(b, ip) {
  if (!(await hit(`rf:${ip}`, 20, 3600))) return fail(RATE_MSG, { code: "rate" });
  const pass = String(b.password == null ? "" : b.password);
  const pe = passError(pass);
  if (pe) return fail(pe);
  const token = String(b.resetToken || "");
  if (!/^[0-9a-f]{64}$/.test(token)) return fail("Сброс недействителен или устарел. Запросите его заново.", { code: "gone" });
  const th = await sha256(token);
  const sql = db();
  let newCode = null;
  const res = await sql.begin(async (t) => {
    const [r] = await t`select * from reset_requests where token_hash = ${th} and status = 'approved' and token_expires > now() for update`;
    if (!r) return null;
    const [p] = await t`select * from profiles where id = ${r.user_id}`;
    if (!p || p.banned) return null;
    await t`update profiles set pass_hash = extensions.crypt(${pass}, extensions.gen_salt('bf', 10)) where id = ${p.id}`;
    await t`delete from sessions where user_id = ${p.id}`;
    await t`update reset_requests set status = 'done', token_hash = null where id = ${r.id}`;
    if (r.via === "code") {
      newCode = newRecoveryCode(); // использованный код сгорает, выдаём новый
      await t`insert into recovery_codes (user_id, code_hash) values (${p.id}, ${await sha256(normCode(newCode))})
              on conflict (user_id) do update set code_hash = excluded.code_hash, created_at = now()`;
    }
    return { p, r };
  });
  if (!res) return fail("Сброс недействителен или устарел. Запросите его заново.", { code: "gone" });
  await audit(res.r.decided_by || "?", "password_reset", res.p.login, { via: res.r.via });
  try {
    if (OWNER_TG)
      await send(OWNER_TG, `🔑 Пароль сброшен: <b>${esc(res.p.login)}</b> (${res.r.via === "code" ? "по коду восстановления" : "подтвердил: " + esc(res.r.decided_by)}).`);
  } catch (e) {}
  return { ok: true, recoveryCode: newCode };
}

// ───────────── Диспетчер API ─────────────
async function api(req) {
  const raw = await req.text();
  if (raw.length > 1000000) return J(fail("Слишком большой запрос."), 413);
  let b;
  try {
    b = JSON.parse(raw);
  } catch (e) {
    return J(fail("Некорректный запрос."), 400);
  }
  if (!b || typeof b !== "object") return J(fail("Некорректный запрос."), 400);
  if (b.action !== "sync" && raw.length > 8192) return J(fail("Слишком большой запрос."), 413);
  const ip = req.headers.get("cf-connecting-ip") || (req.headers.get("x-forwarded-for") || "").split(",")[0].trim() || "unknown";
  switch (b.action) {
    case "register":
      return J(await register(b, ip));
    case "login":
      return J(await login(b, ip));
    case "me": {
      const { p, err } = await who(b);
      if (err) return J(err);
      await noteClient(p, b);
      return J({ ok: true, user: pub(p), sys: await sysFor(p) });
    }
    case "bug_report":
      return J(await bugReport(b));
    case "my_stats":
      return J(await myStats(b));
    case "week_board":
      return J(await weekBoardApi(b));
    case "shift":
      return J(await shiftApi(b));
    case "ctrl":
      return J(await ctrlApi(b));
    case "reports":
      return J(await reportsApi(b));
    case "ai_log":
      return J(await aiLog(b));
    case "ai_vote":
      return J(await aiVote(b));
    case "sync_reset":
      return J(await syncReset(b));
    case "logout": {
      if (typeof b.token === "string" && /^[0-9a-f]{64}$/.test(b.token))
        await db()`delete from sessions where token_hash = ${await sha256(b.token)}`;
      return J({ ok: true });
    }
    case "staff_list":
      return J(await staffList(b));
    case "accept_legal":
      return J(await acceptLegal(b));
    case "update_profile":
      return J(await updateProfile(b));
    case "sync":
      return J(await syncApi(b));
    case "reset_request":
      return J(await resetRequest(b, ip));
    case "reset_status":
      return J(await resetStatus(b, ip));
    case "reset_complete":
      return J(await resetComplete(b, ip));
    default:
      return J(fail("Неизвестное действие."), 400);
  }
}

// ───────────── Этап 3: настройки, сообщения в программе, сервис ─────────────
const CRON_SECRET = Deno.env.get("CRON_SECRET") || ""; // общий секрет для расписания (pg_cron) и оповещений о законах
const BACKUP_KEY = Deno.env.get("BACKUP_KEY") || ""; // пароль шифрования резервных копий (/backup)
const AI_HEALTH_URL = Deno.env.get("AI_HEALTH_URL") || "https://senko-ai.senko-assistant.workers.dev/health";
const GH_LAWS_TOKEN = Deno.env.get("GH_LAWS_TOKEN") || ""; // токен GitHub (Actions: Read and write) для /laws
const GH_REPO = Deno.env.get("GH_REPO") || "Kofemanchik/Senko-Assistant";
const LAWS_WORKFLOW = "sync-laws.yml";
const LAWS_STATUS_URL = Deno.env.get("LAWS_STATUS_URL") || "https://raw.githubusercontent.com/Kofemanchik/Senko-Assistant/main/update/laws-status.json";
const NOTICE_DAYS = 7; // сколько дней рассылка видна в программе
const MILESTONES = [100, 250, 500, 1000, 2000, 5000, 10000];
const FAIL_ALERT = 5; // неудачных входов за 15 минут, после которых владелец получает уведомление

async function getSetting(key, def) {
  const [r] = await db()`select value from bot_settings where key = ${key}`;
  return r ? r.value : def;
}
async function setSetting(key, value) {
  await db()`insert into bot_settings (key, value, updated_at) values (${key}, ${db().json(value)}, now())
             on conflict (key) do update set value = excluded.value, updated_at = now()`;
}
// Есть ли в строках слово из чёрного списка (/blacklist); возвращает найденное слово
async function blacklisted(...strs) {
  const list = await getSetting("blacklist", []);
  if (!list.length) return "";
  const hay = strs.map((x) => String(x || "").toLowerCase().replace(/[\s._-]/g, "")).join(" ");
  return list.find((w) => hay.includes(w.replace(/[_-]/g, ""))) || "";
}
// Тихое уведомление владельцу (без звука)
const quiet = (text) => (OWNER_TG ? send(OWNER_TG, text, { disable_notification: true }) : null);
const mskDay = (d = new Date()) => new Date(d.getTime() + 3 * 3600e3).toISOString().slice(0, 10);
const mskHM = (d = new Date()) => new Date(d.getTime() + 3 * 3600e3).toISOString().slice(11, 16);

// Сколько раз сработал счётчик за окно (как hit(), но возвращает число)
async function hitN(key, windowSec) {
  const [r] = await db()`
    insert into rate_limits (key, n, since) values (${key}, 1, now())
    on conflict (key) do update set
      n     = case when rate_limits.since < now() - make_interval(secs => ${windowSec}) then 1 else rate_limits.n + 1 end,
      since = case when rate_limits.since < now() - make_interval(secs => ${windowSec}) then now() else rate_limits.since end
    returning n`;
  return r.n;
}

// Что программа показывает пользователю: техработы и сообщения от разработчика
async function sysFor(p) {
  const m = await getSetting("maintenance", { on: false, text: "" });
  const rows = await db()`select id, org, user_id, title, text, created_at from broadcasts
                          where expires_at > now() and ((org is null and user_id is null) or org = ${p.org} or user_id = ${p.id})
                          order by created_at desc limit 5`;
  const ctrl = await db()`select t.id, t.title, t.topics, t.n, t.due_at from control_tests t
                          where t.org = ${p.org} and not t.closed and t.due_at > now() and t.author_id is distinct from ${p.id}
                            and not exists (select 1 from control_results r where r.test_id = t.id and r.user_id = ${p.id})
                          order by t.due_at limit 5`;
  return {
    controls: ctrl.map((t) => ({ id: String(t.id), title: t.title, topics: t.topics, n: t.n, due: t.due_at })),
    maintenance: m && m.on ? { on: true, text: m.text || "", exempt: p.rank === "owner" || p.rank === "moderator" } : { on: false },
    notices: rows.map((r) => ({
      id: String(r.id),
      title: r.title || (r.user_id ? "Ответ разработчика" : r.org ? `Сообщение для ${r.org}` : "Сообщение от разработчика"),
      text: r.text,
      at: r.created_at,
    })),
  };
}

// Версия программы и устройство: версия для /versions, новое устройство у руководства — уведомление владельцу
async function noteClient(p, b) {
  const ver = clean(b.ver, 20);
  const dev = clean(b.device, 40);
  const sql = db();
  if (ver && ver !== p.app_version) await sql`update profiles set app_version = ${ver} where id = ${p.id}`;
  if (!dev || !["leader", "moderator", "owner"].includes(p.rank)) return;
  const h = (await sha256("dev:" + dev)).slice(0, 16);
  const known = p.devices || [];
  if (known.includes(h)) return;
  await sql`update profiles set devices = (array_append(devices, ${h}))[greatest(1, cardinality(devices) - 8):] where id = ${p.id}`;
  if (known.length) await quiet(`🔐 Вход с нового устройства: <b>${esc(p.login)}</b> (${RANKS[p.rank]}, ${esc(p.org)})`);
}

// ───────────── API: сообщение об ошибке из программы ─────────────
async function bugReport(b) {
  const { p, err } = await who(b);
  if (err) return err;
  if (!(await hit(`bug:${p.id}`, 5, 86400))) return fail("Можно отправить не больше 5 сообщений в сутки.", { code: "rate" });
  const text = String(b.text == null ? "" : b.text).replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, " ").trim().slice(0, 2000);
  if (text.length < 10) return fail("Опишите проблему подробнее (хотя бы 10 символов).");
  const ver = clean(b.ver, 20);
  const [r] = await db()`insert into bug_reports (user_id, text, app_version) values (${p.id}, ${text}, ${ver}) returning id`;
  if (OWNER_TG)
    await send(OWNER_TG, `🐞 <b>Сообщение об ошибке #${r.id}</b>\nОт: <code>${esc(p.login)}</code> · ${esc(p.nick)} · ${esc(p.org)}\nВерсия: ${esc(ver || "—")}\n\n${esc(text)}`, {
      reply_markup: { inline_keyboard: [[{ text: "✉️ Ответить", callback_data: `bg:${r.id}` }]] },
    });
  return { ok: true, id: String(r.id) };
}

// ───────────── Сервис: /health, /versions, /backup, сводка ─────────────
async function healthText() {
  const L = ["🩺 <b>Статус сервисов</b>"];
  const t0 = Date.now();
  try {
    await db()`select 1`;
    L.push(`✅ База: отвечает (${Date.now() - t0} мс)`);
  } catch (e) {
    L.push(`❌ База: ${esc(String(e && e.message || e)).slice(0, 120)}`);
  }
  L.push("✅ Функция senko: работает");
  try {
    const t1 = Date.now();
    const r = await fetch(AI_HEALTH_URL, { signal: AbortSignal.timeout(6000) });
    const j = await r.json().catch(() => ({}));
    L.push(r.ok && j.ok !== false ? `✅ ИИ-прокси: отвечает (${Date.now() - t1} мс)${j.providers ? ", провайдеры: " + esc(j.providers.join(", ")) : ""}` : `⚠️ ИИ-прокси: статус ${r.status}`);
  } catch (e) {
    L.push("❌ ИИ-прокси: не отвечает");
  }
  try {
    const r = await fetch(LAWS_STATUS_URL + "?t=" + Date.now(), { signal: AbortSignal.timeout(6000) });
    const j = await r.json();
    const age = Math.round((Date.now() - j.checkedAt) / 3600e3);
    L.push(`${j.ok && age < 36 ? "✅" : "⚠️"} Законы: проверка ${fmtDate(j.checkedAt)} (${age} ч. назад), последнее изменение ${fmtDate(j.updatedAt)}, законов: ${j.count}${j.failed ? ", не прочитано тем: " + j.failed : ""}${j.error ? "\nОшибка: " + esc(j.error) : ""}`);
  } catch (e) {
    L.push("⚠️ Законы: не удалось прочитать laws-status.json");
  }
  const tick = await getSetting("tick", null);
  L.push(tick && Date.now() - tick.at < 5 * 60e3 ? `✅ Расписание: последний запуск ${fmtDate(tick.at)}` : `⚠️ Расписание: ${tick ? "последний запуск " + fmtDate(tick.at) : "ни разу не запускалось"} (см. cron.sql)`);
  const m = await getSetting("maintenance", { on: false });
  if (m && m.on) L.push("🛠 Включён режим технических работ");
  return L.join("\n");
}

async function versionsText() {
  const rows = await db()`select coalesce(nullif(app_version, ''), 'неизвестно') v, count(*)::int n,
                                 count(*) filter (where last_seen > now() - interval '7 days')::int active
                          from profiles where not banned group by 1 order by n desc`;
  if (!rows.length) return "Пользователей пока нет.";
  return "📦 <b>Версии программы</b>\n" + rows.map((r) => `${esc(r.v)}: ${r.n} (активны за 7 дн.: ${r.active})`).join("\n") +
    "\n\n«неизвестно» — программы, выпущенные до этого обновления: они не сообщают номер версии.";
}

async function summaryText() {
  const sql = db();
  const [t] = await sql`select count(*) filter (where created_at > now() - interval '1 day')::int reg,
                               count(*) filter (where last_seen > now() - interval '1 day')::int active,
                               count(*) filter (where banned)::int banned,
                               count(*)::int total from profiles`;
  const [r] = await sql`select count(*)::int n, count(*) filter (where status = 'pending' and expires_at > now())::int pending
                        from reset_requests where created_at > now() - interval '1 day'`;
  const [bg] = await sql`select count(*)::int n, count(*) filter (where not answered)::int open from bug_reports where at > now() - interval '1 day'`;
  const [ai] = await sql`select count(*)::int n, count(*) filter (where vote > 0)::int up, count(*) filter (where vote < 0)::int down from ai_log where at > now() - interval '1 day'`;
  const [pd] = await sql`select count(*)::int n from profiles where approval = 'pending'`;
  return `🗓 <b>Сводка за сутки</b>\nРегистраций: ${t.reg}\nАктивных: ${t.active}\nЗаблокировано всего: ${t.banned}\nЗапросов на сброс пароля: ${r.n}${r.pending ? " (ждут: " + r.pending + ")" : ""}\nСообщений об ошибках: ${bg.n}${bg.open ? " (без ответа: " + bg.open + ")" : ""}\nВопросов к ИИ: ${ai.n}${ai.n ? " (👍 " + ai.up + ", 👎 " + ai.down + ")" : ""}${pd.n ? "\nЗаявок ждут подтверждения: " + pd.n + " (/pending)" : ""}\n\nВсего пользователей: ${t.total}`;
}

// Зашифрованная резервная копия (AES-256-GCM, ключ из BACKUP_KEY через PBKDF2). Расшифровка: node tools/decrypt-backup.js
async function backupFile() {
  const sql = db();
  const data = {
    created: new Date().toISOString(),
    profiles: await sql`select * from profiles order by created_at`,
    account_notes: await sql`select * from account_notes`,
    account_warns: await sql`select * from account_warns`,
    broadcasts: await sql`select * from broadcasts where expires_at > now()`,
    bot_settings: await sql`select * from bot_settings`,
    audit_log_24h: await sql`select * from audit_log where at > now() - interval '1 day' order by id`,
    sync_items_24h: await sql`select * from sync_items where to_timestamp(u / 1000.0) > now() - interval '1 day'`,
    reports_30d: await sql`select * from reports where created_at > now() - interval '30 days' order by id`,
  };
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const base = await crypto.subtle.importKey("raw", enc.encode(BACKUP_KEY), "PBKDF2", false, ["deriveKey"]);
  const key = await crypto.subtle.deriveKey({ name: "PBKDF2", salt, iterations: 200000, hash: "SHA-256" }, base, { name: "AES-GCM", length: 256 }, false, ["encrypt"]);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, enc.encode(JSON.stringify(data))));
  const b64 = (u) => btoa(Array.from(u, (c) => String.fromCharCode(c)).join(""));
  return { counts: { profiles: data.profiles.length, sync: data.sync_items_24h.length }, json: JSON.stringify({ v: 1, alg: "AES-256-GCM/PBKDF2-SHA256-200000", salt: b64(salt), iv: b64(iv), data: b64(ct) }) };
}
async function sendFile(chat, name, text, caption) {
  if (!BOT_TOKEN) return null;
  const fd = new FormData();
  fd.append("chat_id", String(chat));
  fd.append("caption", caption);
  fd.append("parse_mode", "HTML");
  fd.append("document", new Blob([text], { type: "application/json" }), name);
  try {
    const r = await fetch(`${TG_API}/bot${BOT_TOKEN}/sendDocument`, { method: "POST", body: fd, signal: AbortSignal.timeout(30000) });
    return await r.json();
  } catch (e) {
    console.error("telegram sendDocument", String(e).split(BOT_TOKEN).join("***"));
    return null;
  }
}

// ───────────── Бот ─────────────
// ───────────── Этап 4: рейтинг недели, достижения, смены, контрольные тесты, приём новичков, ИИ ─────────────
// Уровни и темы — те же, что в тренажёре программы (app/index.html: LVN/LVT, TOP)
const LVN = ["Стажёр", "Помощник", "Специалист", "Знаток", "Старший", "Мастер", "Наставник", "Легенда"];
const LVT = [0, 100, 250, 450, 700, 1000, 1400, 1900];
function lvOf(xp) {
  let i = 0;
  while (i < LVT.length - 1 && xp >= LVT[i + 1]) i++;
  return { n: i + 1, name: LVN[i], from: LVT[i], to: i < LVT.length - 1 ? LVT[i + 1] : LVT[i] };
}
const TOPICS = {
  time: "Сроки", adv: "Адвокат и звонок", ogp: "ОГП и госслужащие", proc: "Процедура и права",
  force: "Сила и оружие", bail: "Залог", dk: "Дорожный кодекс", uk: "УК: розыск и сроки",
};
// Достижения. rare — о них владельцу приходит тихое сообщение
const ACH = [
  { code: "test1", icon: "📝", name: "Первый тест", desc: "Пройти любой тест в тренажёре", test: (s) => s.tests >= 1 },
  { code: "perfect", icon: "💯", name: "Тест без ошибок", desc: "Пройти тест на 100%", test: (s) => s.perfect >= 1 },
  { code: "perfect10", icon: "🎯", name: "Снайпер", desc: "10 тестов без ошибок", rare: true, test: (s) => s.perfect >= 10 },
  { code: "exam", icon: "🎓", name: "Аттестация", desc: "Сдать аттестацию на 80% и выше", test: (s) => s.exam >= 1 },
  { code: "ctrl100", icon: "✅", name: "Отличник", desc: "Контрольный тест руководства на 100%", test: (s) => s.ctrl100 >= 1 },
  { code: "det10", icon: "🚓", name: "10 задержаний", desc: "Провести 10 задержаний с таймером", test: (s) => s.det >= 10 },
  { code: "det50", icon: "🚔", name: "50 задержаний", desc: "Провести 50 задержаний с таймером", test: (s) => s.det >= 50 },
  { code: "det100", icon: "🏅", name: "100 задержаний", desc: "Провести 100 задержаний с таймером", rare: true, test: (s) => s.det >= 100 },
  { code: "streak7", icon: "🔥", name: "7 дней подряд", desc: "Проходить мини-тест дня 7 дней подряд", test: (s) => s.streak >= 7 },
  { code: "streak30", icon: "☄️", name: "30 дней подряд", desc: "Проходить мини-тест дня 30 дней подряд", rare: true, test: (s) => s.streak >= 30 },
  { code: "lvl5", icon: "⭐", name: "Звание «Старший»", desc: "Набрать 700 опыта", test: (s) => s.xp >= 700 },
  { code: "lvl8", icon: "👑", name: "Звание «Легенда»", desc: "Набрать 1900 опыта", rare: true, test: (s) => s.xp >= 1900 },
];
const ACH_BY = Object.fromEntries(ACH.map((x) => [x.code, x]));

// Неделя с понедельника 00:00 по МСК: key — дата понедельника, start — его начало в мс
function mskWeek(d = new Date()) {
  const m = new Date(d.getTime() + 3 * 3600e3);
  const dow = (m.getUTCDay() + 6) % 7;
  const mon = Date.UTC(m.getUTCFullYear(), m.getUTCMonth(), m.getUTCDate() - dow);
  return { key: new Date(mon).toISOString().slice(0, 10), start: mon - 3 * 3600e3 };
}
const weekAfter = (w) => mskWeek(new Date(w.start + 8 * 864e5));
const weekBefore = (w) => mskWeek(new Date(w.start - 864e5));
const ddmm = (ms) => new Date(ms + 3 * 3600e3).toISOString().slice(5, 10).split("-").reverse().join(".");
const tsOf = (d) => (d ? new Date(d).getTime() : 0);
const plural = (n, one, few, many) => (n % 10 === 1 && n % 100 !== 11 ? one : [2, 3, 4].includes(n % 10) && ![12, 13, 14].includes(n % 100) ? few : many);

// Опыт на начало недели: снимок для всех, у кого есть опыт (раз в неделю из расписания)
async function snapshotWeek() {
  const w = mskWeek();
  const s = await getSetting("xpweek", null);
  if (s && s.key === w.key) return;
  await db()`insert into xp_week (user_id, week, base)
             select user_id, ${w.key}, coalesce(max(senko_num(data#>>'{}')), 0)::int from sync_items
             where kind = 'xp' and not deleted group by user_id
             on conflict do nothing`;
  await db()`delete from xp_week where week < ${weekBefore(weekBefore(weekBefore(w))).key}`;
  await setSetting("xpweek", { key: w.key });
}

// Показатели сотрудников за неделю w. full=true — неделя целиком (для отчёта), иначе текущая неделя до сейчас
async function weekStats(org, w = mskWeek(), full = false) {
  const sql = db();
  const people = org
    ? await sql`select id, login, nick, org, rank, last_seen, created_at from profiles where org = ${org} and not banned and approval = 'ok'`
    : await sql`select id, login, nick, org, rank, last_seen, created_at from profiles where not banned and approval = 'ok'`;
  if (!people.length) return [];
  const ids = people.map((p) => p.id);
  const next = weekAfter(w);
  const end = full ? next.start : Date.now() + 864e5;
  const xs = await sql`select user_id, coalesce(max(senko_num(data#>>'{}')), 0)::int xp from sync_items
                       where kind = 'xp' and not deleted and user_id = any(${ids}::uuid[]) group by user_id`;
  const bs = await sql`select user_id, week, base from xp_week where user_id = any(${ids}::uuid[]) and week in (${w.key}, ${next.key})`;
  const act = await sql`
    select user_id,
           count(*) filter (where kind = 'thist' and coalesce(senko_num(data->>'end'), u) >= ${w.start} and coalesce(senko_num(data->>'end'), u) < ${end})::int det,
           count(*) filter (where kind = 'tests' and senko_num(data->>'t') >= ${w.start} and senko_num(data->>'t') < ${end})::int tests,
           round(avg(senko_num(data->>'p')) filter (where kind = 'tests' and senko_num(data->>'t') >= ${w.start} and senko_num(data->>'t') < ${end}))::int avg_p
    from sync_items where not deleted and kind in ('thist', 'tests') and user_id = any(${ids}::uuid[]) group by user_id`;
  const ach = await sql`select user_id, count(*)::int n from achievements where user_id = any(${ids}::uuid[]) group by user_id`;
  const X = {}, B0 = {}, B1 = {}, AC = {}, AN = {};
  xs.forEach((r) => (X[r.user_id] = r.xp));
  bs.forEach((r) => ((r.week === w.key ? B0 : B1)[r.user_id] = r.base));
  act.forEach((r) => (AC[r.user_id] = r));
  ach.forEach((r) => (AN[r.user_id] = r.n));
  return people.map((p) => {
    const xp = X[p.id] || 0;
    const top = full ? (B1[p.id] != null ? B1[p.id] : xp) : xp;
    const base = B0[p.id] != null ? B0[p.id] : top;
    const a = AC[p.id] || {};
    return { ...p, xp, wxp: Math.max(0, top - base), det: a.det || 0, tests: a.tests || 0, avg_p: a.avg_p == null ? null : a.avg_p, ach: AN[p.id] || 0, lvl: lvOf(xp) };
  });
}
const byWxp = (a, b) => b.wxp - a.wxp || b.xp - a.xp || String(a.nick).localeCompare(String(b.nick));

// Проверка достижений после синхронизации (и после контрольного теста)
async function checkAch(p) {
  const sql = db();
  const [s] = await sql`
    select count(*) filter (where kind = 'thist')::int det,
           count(*) filter (where kind = 'tests')::int tests,
           count(*) filter (where kind = 'tests' and senko_num(data->>'p') >= 100)::int perfect,
           count(*) filter (where kind = 'tests' and data->>'m' = 'exam' and senko_num(data->>'p') >= 80)::int exam,
           coalesce(max(senko_num(data->>'n')) filter (where kind = 'streak'), 0)::int streak,
           coalesce(max(senko_num(data#>>'{}')) filter (where kind = 'xp'), 0)::int xp
    from sync_items where user_id = ${p.id} and not deleted`;
  const [c] = await sql`select count(*) filter (where p >= 100)::int ctrl100 from control_results where user_id = ${p.id}`;
  const earned = ACH.filter((x) => x.test({ ...s, ...c })).map((x) => x.code);
  if (!earned.length) return [];
  const got = (await sql`insert into achievements (user_id, code) select ${p.id}, unnest(${earned}::text[])
                         on conflict do nothing returning code`).map((r) => ACH_BY[r.code]).filter(Boolean);
  if (!got.length) return [];
  await sql`insert into broadcasts (user_id, title, author, text, expires_at)
            values (${p.id}, ${got.length > 1 ? "🏆 Новые достижения" : "🏆 Новое достижение"}, 'system',
                    ${got.map((x) => `${x.icon} ${x.name} — ${x.desc.toLowerCase()}`).join("\n") + "\nВсе достижения — в личном кабинете."},
                    now() + interval '7 days')`;
  const rare = got.filter((x) => x.rare);
  if (rare.length) await quiet(`🏆 <b>${esc(p.login)}</b> (${esc(p.nick)}, ${esc(p.org)}) получил редкое достижение: ${rare.map((x) => x.icon + " " + x.name).join(", ")}`);
  return got;
}

// ───────────── API: личная статистика и рейтинг недели ─────────────
async function myStats(b) {
  const { p, err } = await who(b);
  if (err) return err;
  const sql = db();
  const rows = await sql`select kind, data, u from sync_items where user_id = ${p.id} and not deleted and kind in ('xp', 'streak', 'qstat', 'tests', 'thist')`;
  let xp = 0, streak = 0, tp = {}, det = 0, det7 = 0;
  const tests = [];
  const wk = Date.now() - 7 * 864e5;
  const day = mskDay(), yday = mskDay(new Date(Date.now() - 864e5));
  for (const r of rows) {
    const d = r.data;
    if (r.kind === "xp") xp = Math.max(xp, Math.floor(+d) || 0);
    else if (r.kind === "streak" && d && (d.last === day || d.last === yday)) streak = Math.max(streak, Math.floor(+d.n) || 0);
    else if (r.kind === "qstat" && d && d.tp && typeof d.tp === "object") tp = d.tp;
    else if (r.kind === "tests" && d) tests.push({ t: +d.t || 0, p: +d.p || 0 });
    else if (r.kind === "thist") {
      det++;
      if (((d && +d.end) || Number(r.u)) >= wk) det7++;
    }
  }
  tests.sort((a, c) => c.t - a.t);
  const last = tests.slice(0, 10);
  const weak = Object.keys(TOPICS)
    .map((k) => ({ tp: k, name: TOPICS[k], a: Math.floor(+(tp[k] && tp[k].a)) || 0, w: Math.floor(+(tp[k] && tp[k].w)) || 0 }))
    .filter((x) => x.a >= 5 && x.w / x.a >= 0.2)
    .map((x) => ({ ...x, pct: Math.round((x.w / x.a) * 100) }))
    .sort((a, c) => c.pct - a.pct)
    .slice(0, 3);
  const got = await sql`select code, at from achievements where user_id = ${p.id}`;
  const G = Object.fromEntries(got.map((r) => [r.code, r.at]));
  const w = mskWeek();
  const board = (await weekStats(p.org, w)).sort(byWxp);
  const place = board.findIndex((x) => x.id === p.id);
  const ctrl = await sql`select t.id, t.title, t.n, t.due_at, r.p, r.at from control_tests t
                         left join control_results r on r.test_id = t.id and r.user_id = ${p.id}
                         where t.org = ${p.org} and (r.p is not null or (not t.closed and t.due_at > now()))
                         order by t.created_at desc limit 10`;
  return {
    ok: true,
    org: p.org,
    xp, level: lvOf(xp), streak, det, det7,
    tests: tests.length,
    avg_p: last.length ? Math.round(last.reduce((s, t) => s + t.p, 0) / last.length) : null,
    weak,
    ach: ACH.map((x) => ({ code: x.code, icon: x.icon, name: x.name, desc: x.desc, rare: !!x.rare, at: G[x.code] || null })),
    week: { from: w.start, wxp: place >= 0 ? board[place].wxp : 0, place: place >= 0 ? place + 1 : null, of: board.length },
    top: board.slice(0, 10).map((x, i) => ({ n: i + 1, nick: x.nick, lvl: x.lvl.name, wxp: x.wxp, me: x.id === p.id })),
    controls: ctrl.map((r) => ({ id: String(r.id), title: r.title, n: r.n, due: r.due_at, p: r.p, at: r.at })),
  };
}

// Организация, с которой работает руководство: руководитель — только своя, модераторы и владелец — выбранная
const staffOrg = (p, b) => (p.rank === "leader" ? p.org : DEPTS.find((d) => d === String(b.org || "")) || null);

async function weekBoardApi(b) {
  const { p, err } = await who(b, ["leader", "moderator", "owner"]);
  if (err) return err;
  const org = staffOrg(p, b);
  const w = mskWeek();
  const list = (await weekStats(org, w)).sort(byWxp);
  return {
    ok: true, org, from: w.start,
    list: list.map((x, i) => ({ n: i + 1, login: x.login, nick: x.nick, org: x.org, lvl: x.lvl.name, xp: x.xp, wxp: x.wxp, det: x.det, tests: x.tests, avg_p: x.avg_p, ach: x.ach })),
  };
}

// ───────────── API: журнал смены ─────────────
async function shiftSummary(org, from, to) {
  const sql = db();
  const people = await sql`select id, login, nick, last_seen from profiles where org = ${org} and not banned and approval = 'ok'`;
  if (!people.length) return { total: 0, online: [], det: 0, tests: 0 };
  const ids = people.map((x) => x.id);
  const act = await sql`
    select user_id,
           count(*) filter (where kind = 'thist' and coalesce(senko_num(data->>'end'), u) between ${from} and ${to})::int det,
           count(*) filter (where kind = 'tests' and senko_num(data->>'t') between ${from} and ${to})::int tests
    from sync_items where not deleted and kind in ('thist', 'tests') and user_id = any(${ids}::uuid[]) group by user_id`;
  const A = Object.fromEntries(act.map((r) => [r.user_id, r]));
  const online = people
    .filter((x) => tsOf(x.last_seen) >= from || (A[x.id] && (A[x.id].det || A[x.id].tests)))
    .map((x) => ({ nick: x.nick, login: x.login, det: (A[x.id] && A[x.id].det) || 0 }))
    .sort((a, c) => c.det - a.det || String(a.nick).localeCompare(String(c.nick)));
  return {
    total: people.length,
    online: online.slice(0, 60),
    det: act.reduce((s, r) => s + r.det, 0),
    tests: act.reduce((s, r) => s + r.tests, 0),
  };
}
function shiftText(r, auto) {
  const s = r.summary || { total: 0, online: [], det: 0, tests: 0 };
  const from = tsOf(r.started_at), to = tsOf(r.ended_at) || Date.now();
  const mins = Math.max(1, Math.round((to - from) / 60e3));
  const dur = mins >= 60 ? `${Math.floor(mins / 60)} ч ${mins % 60} мин` : `${mins} мин`;
  const top = s.online.filter((x) => x.det > 0).slice(0, 5);
  return `🕐 <b>Смена ${esc(r.org)} завершена</b>${auto ? " (автоматически через 12 часов)" : ""}\n` +
    `${fmtDate(r.started_at)} — ${fmtDate(r.ended_at || new Date())} (${dur}), начал: ${esc(r.leader)}\n\n` +
    `Были в сети: ${s.online.length} из ${s.total}${s.online.length ? "\n" + s.online.slice(0, 30).map((x) => esc(x.nick)).join(", ") + (s.online.length > 30 ? " …" : "") : ""}\n` +
    `Задержаний за смену: ${s.det}${top.length ? "\n" + top.map((x) => `• ${esc(x.nick)} — ${x.det}`).join("\n") : ""}\n` +
    `Тестов пройдено: ${s.tests}`;
}
async function endShift(cur, by, auto = false) {
  const sql = db();
  const s = await shiftSummary(cur.org, tsOf(cur.started_at), Date.now());
  const [r] = await sql`update shifts set ended_at = now(), summary = ${sql.json(s)} where id = ${cur.id} and ended_at is null returning *`;
  if (!r) return null;
  const chats = new Set();
  if (r.leader_id) {
    const [l] = await sql`select tg_id from profiles where id = ${r.leader_id}`;
    if (l && l.tg_id != null) chats.add(String(l.tg_id));
  }
  if (by && by.tg_id != null) chats.add(String(by.tg_id));
  const text = shiftText(r, auto);
  for (const c of chats) await send(c, text);
  return r;
}
const shiftOut = (r) => ({ id: String(r.id), by: r.leader, start: r.started_at, end: r.ended_at, summary: r.summary || null });
async function shiftApi(b) {
  const { p, err } = await who(b, ["leader", "moderator", "owner"]);
  if (err) return err;
  const org = staffOrg(p, b);
  if (!org) return fail("Выберите организацию.");
  const sql = db();
  const op = String(b.op || "");
  let msg = "";
  if (op === "start") {
    const [cur] = await sql`select * from shifts where org = ${org} and ended_at is null`;
    if (cur) return fail(`Смена уже идёт с ${fmtDate(cur.started_at)}, её начал ${cur.leader}.`);
    await sql`insert into shifts (org, leader_id, leader) values (${org}, ${p.id}, ${p.nick || p.login})`;
    await audit(p.login, "shift_start", org, {});
    msg = "Смена начата.";
  } else if (op === "end") {
    const [cur] = await sql`select * from shifts where org = ${org} and ended_at is null`;
    if (!cur) return fail("Смена не начата.");
    await endShift(cur, p);
    await audit(p.login, "shift_end", org, {});
    msg = p.tg_id != null ? "Смена завершена. Сводка отправлена вам в Telegram." : "Смена завершена.";
  }
  const [act] = await sql`select * from shifts where org = ${org} and ended_at is null`;
  const hist = await sql`select * from shifts where org = ${org} and ended_at is not null order by started_at desc limit 10`;
  return { ok: true, org, msg, active: act ? shiftOut(act) : null, history: hist.map(shiftOut) };
}

// ───────────── API: контрольные тесты ─────────────
async function ctrlApi(b) {
  const op = String(b.op || "list");
  const sql = db();
  if (op === "submit") {
    const { p, err } = await who(b);
    if (err) return err;
    const id = parseInt(b.id, 10);
    const [t] = id ? await sql`select * from control_tests where id = ${id}` : [];
    if (!t || t.org !== p.org) return fail("Тест не найден.");
    if (t.closed || tsOf(t.due_at) < Date.now() - 10 * 60e3) return fail("Срок теста истёк.");
    const n = Math.floor(+b.n), s = Math.floor(+b.s);
    if (!(n > 0 && n <= 50 && s >= 0 && s <= n)) return fail("Некорректный результат.");
    const pc = Math.round((s / n) * 100);
    const r = await sql`insert into control_results (test_id, user_id, s, n, p) values (${t.id}, ${p.id}, ${s}, ${n}, ${pc})
                        on conflict do nothing returning p`;
    if (!r.length) return fail("Вы уже прошли этот тест.");
    await checkAch(p);
    return { ok: true, p: pc };
  }
  const { p, err } = await who(b, ["leader", "moderator", "owner"]);
  if (err) return err;
  const org = staffOrg(p, b);
  if (op === "create") {
    if (!org) return fail("Выберите организацию.");
    const topics = (Array.isArray(b.topics) ? b.topics : []).map(String).filter((k) => TOPICS[k]);
    if (!topics.length) return fail("Выберите хотя бы одну тему.");
    const n = Math.min(20, Math.max(5, Math.floor(+b.n) || 10));
    const days = Math.min(14, Math.max(1, Math.floor(+b.days) || 3));
    const title = clean(b.title, 80) || "Контрольный тест";
    const [{ k }] = await sql`select count(*)::int k from control_tests where org = ${org} and not closed and due_at > now()`;
    if (k >= 5) return fail("Активных тестов уже 5. Закройте один из них.");
    if (!(await hit(`ct:${p.id}`, 20, 86400))) return fail(RATE_MSG, { code: "rate" });
    const [t] = await sql`insert into control_tests (org, author_id, author, title, topics, n, due_at)
                          values (${org}, ${p.id}, ${p.nick || p.login}, ${title}, ${topics}, ${n}, now() + make_interval(days => ${days})) returning id`;
    await audit(p.login, "ctrl_create", org, { id: t.id, title, topics, n, days });
  } else if (op === "close") {
    const id = parseInt(b.id, 10);
    const r = id ? await sql`update control_tests set closed = true where id = ${id} and (${org}::text is null or org = ${org}) returning id` : [];
    if (!r.length) return fail("Тест не найден.");
  }
  const tests = org
    ? await sql`select * from control_tests where org = ${org} order by created_at desc limit 10`
    : await sql`select * from control_tests order by created_at desc limit 10`;
  const out = [];
  for (const t of tests) out.push(await ctrlDetails(t));
  return { ok: true, org, topics: TOPICS, tests: out };
}
async function ctrlDetails(t) {
  const sql = db();
  const res = await sql`select r.p, r.s, r.n, r.at, p.nick, p.login from control_results r join profiles p on p.id = r.user_id
                        where r.test_id = ${t.id} order by r.p desc, r.at`;
  const done = new Set(res.map((r) => r.login));
  // автор теста его не проходит
  const all = await sql`select login, nick from profiles where org = ${t.org} and not banned and approval = 'ok' and created_at < ${t.due_at}
                          and id is distinct from ${t.author_id} order by nick`;
  const miss = all.filter((x) => !done.has(x.login));
  return {
    id: String(t.id), org: t.org, title: t.title, topics: t.topics, n: t.n, due: t.due_at, by: t.author, created: t.created_at,
    active: !t.closed && tsOf(t.due_at) > Date.now(),
    avg: res.length ? Math.round(res.reduce((s, r) => s + r.p, 0) / res.length) : null,
    results: res.map((r) => ({ nick: r.nick, login: r.login, p: r.p, s: r.s, n: r.n, at: r.at })),
    missing: miss.slice(0, 50).map((x) => x.nick), missingN: miss.length,
  };
}

// ───────────── Рапорты ─────────────
const RP_KINDS = {
  arrest: "Рапорт о задержании",
  force: "Рапорт о применении силы",
  incident: "Рапорт о происшествии",
  service: "Служебный рапорт",
};
const RP_STATUS = { new: "на рассмотрении", ok: "принят", no: "отклонён" };
const RP_ICON = { new: "⏳", ok: "✅", no: "❌" };
// Многострочный текст: управляющие символы убираются, переносы строк остаются
const cleanText = (s, max) =>
  String(s == null ? "" : s).replace(/\r\n?/g, "\n").replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, " ")
    .split("\n").map((l) => l.replace(/\s+/g, " ").trim()).join("\n").replace(/\n{3,}/g, "\n\n").trim().slice(0, max);
function rpFields(f) {
  const out = {};
  if (!f || typeof f !== "object" || Array.isArray(f)) return out;
  for (const k of Object.keys(f).slice(0, 30)) {
    if (!/^[a-z_]{1,20}$/.test(k)) continue;
    const v = f[k];
    if (Array.isArray(v)) out[k] = v.slice(0, 20).map((x) => clean(x, 120)).filter(Boolean);
    else if (v != null && v !== "") out[k] = cleanText(v, 2000);
  }
  return out;
}
const rpOut = (r, full = true) => ({
  id: String(r.id), org: r.org, kind: r.kind, title: r.title, author: r.author, login: r.login, static: r.static_id, dept: r.dept,
  status: r.status, reviewer: r.reviewer || "", note: r.review_note || "", reviewed: r.reviewed_at, created: r.created_at,
  ...(full ? { fields: r.fields || {}, body: r.body } : {}),
});
// Текст рапорта для Telegram
function rpText(r, max = 3500) {
  const body = r.body.length > max ? r.body.slice(0, max) + " …" : r.body;
  return `📝 <b>${esc(r.title)} №${r.id}</b> · ${esc(r.org)}\n` +
    `От: ${esc(r.author)} <code>${esc(r.login)}</code>, статик ${esc(r.static_id)}${r.dept ? ", " + esc(r.dept) : ""}\n` +
    `${fmtDate(r.created_at)} · ${RP_ICON[r.status]} ${RP_STATUS[r.status]}${r.reviewer ? " (" + esc(r.reviewer) + ")" : ""}` +
    `${r.review_note ? "\nКомментарий: " + esc(r.review_note) : ""}\n\n${esc(body)}`;
}
const rpButtons = (r) =>
  r.status === "new" ? { reply_markup: { inline_keyboard: [[{ text: "✅ Принять", callback_data: `rp:ok:${r.id}` }, { text: "❌ Отклонить", callback_data: `rp:no:${r.id}` }]] } } : {};
// Новый рапорт: руководству организации (уведомления можно выключить: /reports off), модераторам и владельцу — если включили /reports on
async function rpNotify(r) {
  const sql = db();
  const chats = new Set();
  const leaders = await sql`select tg_id from profiles where rank = 'leader' and org = ${r.org} and tg_id is not null and not banned`;
  for (const l of leaders) if ((await getSetting("rpn:" + l.tg_id, { on: true })).on) chats.add(String(l.tg_id));
  const staff = (await moderatorChats()).concat(OWNER_TG ? [OWNER_TG] : []);
  for (const c of staff) if ((await getSetting("rpn:" + c, { on: false })).on) chats.add(c);
  for (const c of chats) await send(c, rpText(r, 1500) + (r.body.length > 1500 ? `\n\nПолностью: /report ${r.id}` : ""), { disable_notification: true, ...rpButtons(r) });
}
// Решение по рапорту. who: { label, name, org (null — любая организация) }
async function rpReview(by, id, ok, note) {
  const sql = db();
  const [r0] = id ? await sql`select * from reports where id = ${id}` : [];
  if (!r0 || (by.org && r0.org !== by.org)) return { err: "Рапорт не найден." };
  const [r] = await sql`update reports set status = ${ok ? "ok" : "no"}, reviewer = ${by.name}, review_note = ${note || ""}, reviewed_at = now()
                        where id = ${r0.id} returning *`;
  await audit(by.label, "report_review", r.login, { id: String(r.id), org: r.org, status: r.status });
  if (r.user_id && r0.status !== r.status)
    await sql`insert into broadcasts (user_id, title, author, text, expires_at)
              values (${r.user_id}, ${`${ok ? "✅" : "❌"} Рапорт №${r.id} ${ok ? "принят" : "отклонён"}`}, ${by.label},
                      ${`${r.title} от ${new Date(r.created_at).toLocaleDateString("ru-RU", { timeZone: "Europe/Moscow" })}: ${ok ? "принят" : "отклонён"} (${by.name}).${note ? " Комментарий: " + note.replace(/[.!?]?$/, (m) => m || ".") : ""} Рапорт есть в личном кабинете, раздел «Мои рапорты».`},
                      now() + interval '7 days')`;
  return { r };
}
async function reportsApi(b) {
  const op = String(b.op || "mine");
  const sql = db();
  if (op === "create" || op === "mine" || op === "del") {
    const { p, err } = await who(b);
    if (err) return err;
    if (op === "create") {
      const kind = String(b.kind || "");
      if (!RP_KINDS[kind]) return fail("Неизвестный вид рапорта.");
      const body = cleanText(b.body, 5000);
      if (body.length < 20) return fail("Рапорт слишком короткий: заполните поля.");
      if (!(await hit(`rp:${p.id}`, 15, 3600))) return fail(RATE_MSG, { code: "rate" });
      const title = clean(b.title, 120) || RP_KINDS[kind];
      const [r] = await sql`insert into reports (user_id, org, author, login, static_id, dept, kind, title, fields, body)
                            values (${p.id}, ${p.org}, ${p.nick || p.login}, ${p.login}, ${p.static_id}, ${p.dept || ""}, ${kind}, ${title},
                                    ${sql.json(rpFields(b.fields))}, ${body}) returning *`;
      await audit(p.login, "report_create", r.org, { id: String(r.id), kind });
      try {
        await rpNotify(r);
      } catch (e) {
        console.error("report notify", e);
      }
      return { ok: true, report: rpOut(r) };
    }
    if (op === "del") {
      const id = parseInt(b.id, 10);
      const r = id ? await sql`delete from reports where id = ${id} and user_id = ${p.id} and status = 'new' returning id` : [];
      if (!r.length) return fail("Удалить можно только свой рапорт, пока его не рассмотрели.");
      await audit(p.login, "report_delete", p.org, { id: String(id) });
    }
    const rows = await sql`select * from reports where user_id = ${p.id} order by created_at desc limit 50`;
    return { ok: true, list: rows.map((r) => rpOut(r)) };
  }
  const { p, err } = await who(b, ["leader", "moderator", "owner"]);
  if (err) return err;
  const org = staffOrg(p, b);
  if (op === "review") {
    const x = await rpReview({ label: p.login, name: p.nick || p.login, org: p.rank === "leader" ? p.org : null }, parseInt(b.id, 10), !!b.ok, clean(b.note, 300));
    if (x.err) return fail(x.err);
  } else if (op !== "list") return fail("Неизвестное действие.");
  const st = RP_STATUS[b.status] ? String(b.status) : null;
  const kind = RP_KINDS[b.kind] ? String(b.kind) : null;
  const q = clean(b.q, 40).toLowerCase();
  const like = q ? "%" + likeEsc(q) + "%" : null;
  const rows = await sql`
    select * from reports
    where (${org}::text is null or org = ${org}) and (${st}::text is null or status = ${st}) and (${kind}::text is null or kind = ${kind})
      and (${like}::text is null or lower(author) like ${like} or lower(login) like ${like} or lower(title) like ${like} or static_id like ${like} or id::text = ${q})
    order by created_at desc limit 100`;
  const [{ n }] = await sql`select count(*)::int n from reports where status = 'new' and (${org}::text is null or org = ${org})`;
  return { ok: true, org, kinds: RP_KINDS, newN: n, list: rows.map((r) => rpOut(r)) };
}

// ───────────── Приём новичков ─────────────
const approvalMsg = (p) =>
  p.approval === "rejected"
    ? `Руководство организации ${p.org} отклонило заявку. Связь: ${CONTACT}`
    : `Ваша заявка ждёт подтверждения руководства организации ${p.org}. Попробуйте войти позже.`;
async function askApproval(p) {
  const sql = db();
  const leaders = await sql`select tg_id from profiles where org = ${p.org} and rank = 'leader' and tg_id is not null and not banned`;
  const kb = { inline_keyboard: [[{ text: "✅ Принять", callback_data: `ap:ok:${p.id}` }, { text: "❌ Отклонить", callback_data: `ap:no:${p.id}` }]] };
  const text = `🆕 <b>Заявка в ${esc(p.org)}</b>\n\n${card(p, "leader")}\n\nПринять сотрудника в программу?`;
  const chats = new Set(leaders.map((l) => String(l.tg_id)));
  if (!chats.size && OWNER_TG) chats.add(OWNER_TG); // у руководства нет Telegram — решает владелец
  for (const c of chats) await send(c, text, { reply_markup: kb });
  return chats.size;
}
async function decideApproval(a, id, ok) {
  const sql = db();
  const [p0] = await sql`select * from profiles where id = ${id}`;
  if (!p0) return { err: "Аккаунт не найден." };
  if (a.kind === "leader" && a.profile.org !== p0.org) return { err: "Это заявка другой организации." };
  const [r] = await sql`update profiles set approval = ${ok ? "ok" : "rejected"} where id = ${id} and approval = 'pending' returning *`;
  if (!r) return { err: `Заявка уже рассмотрена: ${p0.approval === "ok" ? "принята" : p0.approval === "rejected" ? "отклонена" : "нет заявки"}.` };
  await audit(a.label, ok ? "approve" : "reject", r.login, { org: r.org });
  if (ok)
    await sql`insert into broadcasts (user_id, title, author, text, expires_at)
              values (${r.id}, ${"✅ Заявка принята"}, ${a.label}, ${`Добро пожаловать в ${r.org}! Руководство подтвердило ваш аккаунт.`}, now() + interval '7 days')`;
  if (a.kind !== "owner") await quiet(`${ok ? "✅" : "❌"} ${esc(a.profile.login)} ${ok ? "принял" : "отклонил"} заявку <b>${esc(r.login)}</b> в ${esc(r.org)}`);
  return { text: `${ok ? "✅ Принят" : "❌ Отклонён"}: <b>${esc(r.login)}</b> (${esc(r.nick)}) в ${esc(r.org)}${ok ? "" : ".\nЕсли передумаете: /approve " + esc(r.login)}` };
}

// ───────────── Еженедельный отчёт руководству ─────────────
async function orgReport(org) {
  const cur = mskWeek(), w = weekBefore(cur);
  const L = await weekStats(org, w, true);
  if (!L.length) return null;
  const sql = db();
  const ids = L.map((x) => x.id);
  const fresh = L.filter((x) => tsOf(x.created_at) >= w.start && tsOf(x.created_at) < cur.start).length;
  const act = L.filter((x) => tsOf(x.last_seen) >= w.start).length;
  const det = L.reduce((s, x) => s + x.det, 0), tests = L.reduce((s, x) => s + x.tests, 0);
  const tp = L.filter((x) => x.avg_p != null);
  const avg = tp.length ? Math.round(tp.reduce((s, x) => s + x.avg_p, 0) / tp.length) : null;
  const topX = [...L].sort(byWxp).filter((x) => x.wxp > 0).slice(0, 3);
  const topD = [...L].sort((a, c) => c.det - a.det).filter((x) => x.det > 0).slice(0, 3);
  const idle = L.filter((x) => Date.now() - tsOf(x.last_seen) >= 14 * 864e5);
  const ct = await sql`select * from control_tests where org = ${org} and created_at < ${new Date(cur.start)} and due_at >= ${new Date(w.start)} order by created_at`;
  const ctl = [];
  for (const t of ct) {
    const [r] = await sql`select count(*)::int n, round(avg(p))::int a from control_results where test_id = ${t.id} and user_id = any(${ids}::uuid[])`;
    ctl.push(`• «${esc(t.title)}» — прошли ${r.n} из ${L.length}${r.a == null ? "" : " (ср. " + r.a + "%)"}`);
  }
  let t = `📊 <b>Отчёт ${esc(org)} за неделю ${ddmm(w.start)}–${ddmm(cur.start - 864e5)}</b>\n` +
    `Сотрудников: ${L.length}${fresh ? " (новых: " + fresh + ")" : ""}\nЗаходили за неделю: ${act}\n` +
    `Задержаний: ${det} · тестов: ${tests}${avg == null ? "" : " (ср. " + avg + "%)"}`;
  if (topX.length) t += `\n\n🏆 <b>Лучшие по опыту</b>\n` + topX.map((x, i) => `${i + 1}. ${esc(x.nick)} — ${x.wxp} опыта`).join("\n");
  if (topD.length) t += `\n\n🚓 <b>Больше всего задержаний</b>\n` + topD.map((x, i) => `${i + 1}. ${esc(x.nick)} — ${x.det}`).join("\n");
  if (ctl.length) t += `\n\n📋 <b>Контрольные тесты</b>\n` + ctl.join("\n");
  if (idle.length) t += `\n\n💤 Не заходили 14+ дней (${idle.length}): ${idle.slice(0, 10).map((x) => esc(x.nick)).join(", ")}${idle.length > 10 ? " …" : ""}`;
  return t;
}
async function sendOrgReports() {
  const rows = await db()`select org, tg_id from profiles where rank = 'leader' and tg_id is not null and not banned`;
  const by = {};
  rows.forEach((r) => (by[r.org] = by[r.org] || []).push(String(r.tg_id)));
  let n = 0;
  for (const org of Object.keys(by)) {
    const t = await orgReport(org);
    if (!t) continue;
    for (const c of by[org]) {
      await send(c, t);
      n++;
    }
  }
  return n;
}

// ───────────── ИИ-помощник: лог вопросов и оценки ответов ─────────────
async function aiChat() {
  const s = await getSetting("ailog", { on: true });
  return s && s.on === false ? null : (s && s.chat) || OWNER_TG || null;
}
async function aiLog(b) {
  const { p, err } = await who(b);
  if (err) return err;
  if (!(await hit(`ai:${p.id}`, 80, 3600))) return fail(RATE_MSG, { code: "rate" });
  const q = String(b.q == null ? "" : b.q).replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 500);
  if (!q) return fail("Пустой вопрос.");
  const refs = (Array.isArray(b.refs) ? b.refs : []).slice(0, 10).map((r) => clean(r, 60)).filter(Boolean);
  const ok = b.ok !== false;
  const [r] = await db()`insert into ai_log (user_id, q, refs, ok) values (${p.id}, ${q}, ${refs}, ${ok}) returning id`;
  const chat = await aiChat();
  if (chat)
    await send(chat, `🤖 <b>${esc(p.login)}</b> · ${esc(p.org)}${ok ? "" : " · ⚠️ ИИ не ответил"} · №${r.id}\n${esc(q)}${refs.length ? "\n<i>Статьи: " + esc(refs.join(", ")) + "</i>" : ""}`, { disable_notification: true });
  return { ok: true, id: String(r.id) };
}
async function aiVote(b) {
  const { p, err } = await who(b);
  if (err) return err;
  const id = parseInt(b.id, 10);
  const v = b.vote === 1 || b.vote === "1" ? 1 : b.vote === -1 || b.vote === "-1" ? -1 : 0;
  if (!id || !v) return fail("Некорректная оценка.");
  const [r] = await db()`update ai_log set vote = ${v} where id = ${id} and user_id = ${p.id} and vote <> ${v} returning *`;
  if (r && v < 0) {
    const chat = await aiChat();
    if (chat) await send(chat, `👎 <b>Ответ ИИ не помог</b> · №${r.id} · ${esc(p.login)}\n${esc(r.q)}${r.refs.length ? "\n<i>Статьи: " + esc(r.refs.join(", ")) + "</i>" : ""}`, { disable_notification: true });
  }
  return { ok: true };
}
async function aiStatsText(days = 7) {
  const sql = db();
  const [s] = await sql`select count(*)::int n, count(*) filter (where vote > 0)::int up, count(*) filter (where vote < 0)::int down,
                               count(*) filter (where not ok)::int bad, count(distinct user_id)::int users
                        from ai_log where at > now() - make_interval(days => ${days})`;
  const refs = await sql`select r, count(*)::int n from ai_log, unnest(refs) r where vote < 0 and at > now() - make_interval(days => ${days})
                         group by r order by n desc limit 5`;
  const last = await sql`select l.*, p.login from ai_log l left join profiles p on p.id = l.user_id order by l.at desc limit 10`;
  return `🤖 <b>ИИ-помощник за ${days} дн.</b>\nВопросов: ${s.n} от ${s.users} чел. · 👍 ${s.up} · 👎 ${s.down}${s.bad ? " · без ответа: " + s.bad : ""}` +
    (refs.length ? `\n\n<b>Где ИИ чаще ошибается</b> (статьи в ответах с 👎)\n` + refs.map((r) => `• ${esc(r.r)} — ${r.n}`).join("\n") : "") +
    (last.length ? `\n\n<b>Последние вопросы</b>\n` + last.map((l) => `${l.vote > 0 ? "👍" : l.vote < 0 ? "👎" : "•"} ${esc(l.login || "?")}: ${esc(l.q.slice(0, 120))}`).join("\n") : "");
}

async function actorOf(tgId) {
  const id = String(tgId);
  if (OWNER_TG && id === OWNER_TG) return { kind: "owner", tg: id, label: "owner" };
  const [m] = await db()`select * from profiles where tg_id = ${id} and rank = 'moderator' and not banned`;
  if (m) return { kind: "moderator", tg: id, label: "moderator:" + m.login, profile: m };
  const [l] = await db()`select * from profiles where tg_id = ${id} and rank = 'leader' and not banned`;
  if (l) return { kind: "leader", tg: id, label: "leader:" + l.login, profile: l };
  return null;
}

const likeEsc = (s) => s.replace(/[\\%_]/g, (c) => "\\" + c);
const WARN_LIMIT = 3; // после стольких предупреждений аккаунт блокируется автоматически
const CONFIRM_MIN = 10; // сколько живёт кнопка «Подтвердить»
const warnWord = (n) => (n % 10 === 1 && n % 100 !== 11 ? "предупреждение" : [2, 3, 4].includes(n % 10) && ![12, 13, 14].includes(n % 100) ? "предупреждения" : "предупреждений");
// Личное сообщение в программе о предупреждении: кто выдал, причина, счёт, куда обжаловать
const issuerName = (a) => (a.kind === "owner" ? "владелец Senko Assistant" : `модератор ${a.profile.nick || a.profile.login}`);
async function appealText() {
  const s = await getSetting("appeal", null);
  return (s && s.text) || `владельцу Senko Assistant (${CONTACT}) или через «Сообщить об ошибке» в настройках программы`;
}
async function notifyWarn(a, p, n, reason, banned) {
  const lines = [
    `Причина: ${reason || "не указана"}`,
    `Выдал: ${issuerName(a)}`,
    `Предупреждений: ${n} из ${WARN_LIMIT}`,
    banned
      ? `Набрано ${WARN_LIMIT} ${warnWord(WARN_LIMIT)}, поэтому аккаунт заблокирован автоматически.`
      : `При ${WARN_LIMIT} предупреждениях аккаунт блокируется автоматически.${WARN_LIMIT - n === 1 ? " Следующее предупреждение приведёт к блокировке." : ""}`,
    `Обжаловать: ${await appealText()}`,
  ];
  await warnNotice(p, `⚠️ Предупреждение ${n} из ${WARN_LIMIT}`, a, lines.join("\n"));
}
// В программе висит только последнее сообщение о предупреждениях: прошлые убираем
async function warnNotice(p, title, a, text) {
  const sql = db();
  await sql`update broadcasts set expires_at = now() where user_id = ${p.id} and expires_at > now()
            and (title like '⚠️ Предупреждение%' or title = '✅ Предупреждение снято')`;
  await sql`insert into broadcasts (user_id, title, author, text, expires_at)
            values (${p.id}, ${title}, ${a.label}, ${text}, now() + interval '30 days')`;
}
const HELP_COMMON =
  "<b>Поиск</b>\n" +
  "/find &lt;текст&gt; — поиск по логину, нику, статику, дискорду; /find #тег — по тегу\n" +
  "/user &lt;логин&gt; — карточка пользователя\n" +
  "/online — кто был в сети за последний час\n" +
  "/dups — похожие аккаунты (Discord, номер, статик, ник)\n" +
  "\n<b>Модерация</b>\n" +
  "/note &lt;логин&gt; &lt;текст&gt; — внутренняя заметка\n" +
  "/warn &lt;логин&gt; [причина] — предупреждение (" + WARN_LIMIT + " = блокировка)\n" +
  "/unwarn &lt;логин&gt; — снять последнее предупреждение\n" +
  "/tempban &lt;логин&gt; &lt;срок: 30m, 12h, 7d&gt; [причина] — блокировка на срок\n" +
  "/ban &lt;логин&gt; [причина] — заблокировать\n" +
  "/unban &lt;логин&gt; — разблокировать\n" +
  "/kick &lt;логин&gt; — завершить все сессии без блокировки\n" +
  "/tag &lt;логин&gt; &lt;тег&gt; [тег…] — добавить теги; /untag &lt;логин&gt; &lt;тег&gt; — убрать\n" +
  "/setorg &lt;логин&gt; &lt;организация&gt; — сменить организацию (" + DEPTS.join(", ") + ")\n" +
  "/resets — ожидающие запросы на сброс пароля\n" +
  "\n<b>Рейтинг и руководство</b>\n" +
  "/top [организация] [tests|det] — рейтинг недели\n" +
  "/results [номер] — контрольные тесты руководства\n" +
  "/pending — заявки новичков; /approve &lt;логин&gt; — принять\n" +
  "/reports [организация|логин|new] — рапорты сотрудников; /report &lt;номер&gt; — открыть\n" +
  "/reports on|off — присылать новые рапорты сюда\n";
const HELP_OWNER =
  "\n<b>Только владелец</b>\n" +
  "/role &lt;логин&gt; &lt;user|leader|moderator|owner&gt; [telegram_id] — выдать роль\n" +
  "/rename &lt;логин&gt; &lt;новый ник&gt; — исправить ник\n" +
  "/setstatic &lt;логин&gt; &lt;статик&gt; — исправить статик\n" +
  "/delete &lt;логин&gt; — удалить аккаунт и все данные\n" +
  "/inactive [дней] — кто давно не заходил (по умолчанию 30)\n" +
  "/stats — статистика\n" +
  "/audit [логин|действие] — журнал действий, например /audit ban\n";
const HELP_LEADER =
  "<b>Команды руководства</b>\n" +
  "/broadcast_org &lt;организация&gt; &lt;текст&gt; — сообщение сотрудникам вашей организации в программе\n" +
  "/top [tests|det] — рейтинг недели вашей организации\n" +
  "/results [номер] — результаты контрольных тестов\n" +
  "/pending — заявки новичков (если владелец включил приём); /approve &lt;логин&gt; — принять\n" +
  "/reports [логин|new] — рапорты сотрудников; /report &lt;номер&gt; — открыть, принять или отклонить\n" +
  "/reports on|off — уведомления о новых рапортах (по умолчанию включены)\n" +
  "\nСмены, контрольные тесты и рапорты — в программе: панель руководителя. Сводка смены и отчёт по понедельникам приходят сюда.\n";
const HELP_SERVICE =
  "\n<b>Сервис</b>\n" +
  "/health — статус базы, функции, ИИ и законов\n" +
  "/in &lt;срок&gt; &lt;команда&gt; — выполнить команду позже, например /in 2h unban cop1; /jobs — список\n";
const HELP_OWNER3 =
  "\n<b>Рассылки и режимы (владелец)</b>\n" +
  "/broadcast &lt;текст&gt; — сообщение всем в программе; /broadcast_org &lt;орг&gt; &lt;текст&gt;\n" +
  "/broadcasts — активные сообщения; /unbroadcast &lt;номер&gt; — убрать\n" +
  "/maintenance on [текст] | off — режим технических работ\n" +
  "/summary 21:00 | off | now — ежедневная сводка\n" +
  "/regs on|off — регистрация; /reglimit &lt;N&gt;|off — не больше N в сутки\n" +
  "/blacklist [add|del слово] — запрещённые слова в логинах и никах\n" +
  "/appeal &lt;текст&gt; — куда обжаловать предупреждения (видно пользователю)\n" +
  "/versions — версии программы у пользователей\n" +
  "/laws — проверить законы сейчас; /laws status — последние проверки\n" +
  "/backup — зашифрованная резервная копия\n" +
  "/approval on|off — приём новичков с подтверждением руководства\n" +
  "/orgreport [организация|on|off] — еженедельный отчёт руководству\n" +
  "/ailog [дней|on|off] — вопросы к ИИ-помощнику и оценки ответов\n";
const AUDIT_ACTIONS = [
  "ban", "unban", "tempban", "tempban_end", "autoban", "warn", "unwarn", "kick", "note", "tag", "untag",
  "role", "rename", "setstatic", "setorg", "delete", "profile_update", "password_reset", "reset_approve", "reset_reject",
  "broadcast", "maintenance", "regs", "reglimit", "blacklist", "appeal", "delay", "backup", "laws",
  "approve", "reject", "approval", "shift_start", "shift_end", "ctrl_create", "sync_reset",
  "report_create", "report_delete", "report_review",
];

async function findProfile(login) {
  const [p] = await db()`select * from profiles where login_lc = ${clean(login, 24).toLowerCase()}`;
  return p || null;
}
async function profileById(id) {
  const [p] = await db()`select * from profiles where id = ${id}`;
  return p || null;
}

// Срок вида 30m / 12h / 7d / 2w → миллисекунды
function parseDur(s) {
  const m = /^(\d{1,4})\s*([mhdw])$/i.exec(String(s || "").trim());
  if (!m) return 0;
  const n = +m[1];
  const ms = { m: 60e3, h: 3600e3, d: 864e5, w: 7 * 864e5 }[m[2].toLowerCase()] * n;
  return n > 0 && ms <= 365 * 864e5 ? ms : 0;
}
const durText = (ms) =>
  ms % 864e5 === 0 ? `${ms / 864e5} дн.` : ms % 3600e3 === 0 ? `${ms / 3600e3} ч.` : `${Math.round(ms / 60e3)} мин.`;
const normTag = (t) => String(t || "").replace(/^#/, "").toLowerCase().replace(/[^0-9a-zа-яё_-]/gi, "").slice(0, 24);

// Кого может трогать модератор: не владельца и не других модераторов
function canTouch(a, p) {
  if (p.rank === "owner") return "Действие с владельцем невозможно.";
  if (a.kind === "moderator" && p.rank === "moderator") return "С модераторами работает только владелец.";
  return "";
}
async function tellOwner(a, text) {
  if (a.kind === "moderator" && OWNER_TG) await send(OWNER_TG, `ℹ️ ${esc(a.profile.login)} ${text}`, { disable_notification: true });
}

// Полная карточка для бота: заметки, предупреждения, теги
async function fullCard(p, viewer) {
  const sql = db();
  let t = card(p, viewer);
  if (p.tags && p.tags.length) t += `\nТеги: ${p.tags.map((x) => "#" + esc(x)).join(" ")}`;
  const warns = await sql`select * from account_warns where user_id = ${p.id} order by at desc limit 5`;
  const [{ n }] = await sql`select count(*)::int n from account_warns where user_id = ${p.id}`;
  if (n) t += `\n\n⚠️ <b>Предупреждения: ${n} из ${WARN_LIMIT}</b>\n` + warns.map((w) => `• ${fmtDate(w.at)} · ${esc(w.author)}${w.reason ? ": " + esc(w.reason) : ""}`).join("\n");
  const notes = await sql`select * from account_notes where user_id = ${p.id} order by at desc limit 5`;
  if (notes.length) t += `\n\n📝 <b>Заметки</b>\n` + notes.map((x) => `• ${fmtDate(x.at)} · ${esc(x.author)}: ${esc(x.text)}`).join("\n");
  if (viewer === "owner") t += "\n" + statLine((await userStats())[p.id]);
  const ach = await sql`select code from achievements where user_id = ${p.id} order by at`;
  if (ach.length) t += `\n🏆 Достижения: ${ach.map((x) => ACH_BY[x.code]).filter(Boolean).map((x) => x.icon + " " + x.name).join(", ")}`;
  return t;
}

// ───────────── Действия с подтверждением кнопкой ─────────────
async function askConfirm(chat, a, action, payload, text) {
  const [r] = await db()`insert into bot_pending (actor_tg, action, payload, expires_at)
                         values (${a.tg}, ${action}, ${db().json(payload)}, now() + make_interval(mins => ${CONFIRM_MIN})) returning id`;
  return send(chat, `${text}\n\n<i>Кнопка действует ${CONFIRM_MIN} минут.</i>`, {
    reply_markup: { inline_keyboard: [[{ text: "✅ Подтвердить", callback_data: `cf:ok:${r.id}` }, { text: "✖️ Отмена", callback_data: `cf:no:${r.id}` }]] },
  });
}

async function doBan(a, p, reason, ms) {
  const sql = db();
  const until = ms ? new Date(Date.now() + ms) : null;
  await sql`update profiles set banned = true, ban_reason = ${reason}, banned_at = now(), banned_until = ${until} where id = ${p.id}`;
  // сессии не удаляем: при первом же запросе пользователь увидит причину блокировки (см. who())
  await sql`update reset_requests set status = 'cancelled' where user_id = ${p.id} and status in ('pending','approved')`;
  await audit(a.label, ms ? "tempban" : "ban", p.login, ms ? { reason, until } : { reason });
  const what = ms ? `заблокирован на ${durText(ms)} (до ${fmtDate(until)})` : "заблокирован";
  await tellOwner(a, `${ms ? "временно " : ""}заблокировал <b>${esc(p.login)}</b>${ms ? " на " + durText(ms) : ""}${reason ? ": " + esc(reason) : ""}`);
  return `🚫 ${esc(p.login)} ${what}${reason ? ": " + esc(reason) : ""}. Вход и работа в приложении закрыты сразу.`;
}

async function scheduleJob(a, x) {
  const [r] = await db()`insert into bot_delayed (actor_tg, actor_label, command, run_at)
                         values (${a.tg}, ${a.label}, ${x.command}, now() + make_interval(secs => ${Math.round(x.ms / 1000)})) returning id, run_at`;
  await audit(a.label, "delay", null, { command: x.command, at: r.run_at });
  return `⏰ Команда №${r.id} <code>${esc(x.command)}</code> выполнится ${fmtDate(r.run_at)}.\nСписок: /jobs · отменить: /jobs cancel ${r.id}`;
}

// Обычный текст (не команда): ответ владельца на сообщение об ошибке
async function onText(m, text) {
  const a = await actorOf(m.from.id);
  if (!a || a.kind !== "owner") return;
  const [pd] = await db()`delete from bot_pending where actor_tg = ${a.tg} and action = 'bugreply' and expires_at > now() returning *`;
  if (!pd) return send(m.chat.id, "Чтобы ответить на сообщение об ошибке, нажмите «Ответить» под ним. Команды: /help");
  const sql = db();
  const [bug] = await sql`select * from bug_reports where id = ${pd.payload.bug}`;
  if (!bug) return send(m.chat.id, "Сообщение об ошибке не найдено (аккаунт мог быть удалён).");
  const body = text.slice(0, 1500);
  await sql`insert into broadcasts (user_id, title, author, text, expires_at)
            values (${bug.user_id}, ${"Ответ на ваше сообщение об ошибке №" + bug.id}, ${a.label}, ${body}, now() + interval '30 days')`;
  await sql`update bug_reports set answered = true where id = ${bug.id}`;
  return send(m.chat.id, `✅ Ответ на №${bug.id} отправлен. Пользователь увидит его в программе.`);
}

async function runConfirmed(a, action, x) {
  if (action === "delay") return scheduleJob(a, x);
  const p = await profileById(x.id);
  if (!p) return "Пользователь уже удалён.";
  const deny = action !== "role" ? canTouch(a, p) : "";
  if (deny) return deny;
  const sql = db();
  switch (action) {
    case "ban":
      return doBan(a, p, x.reason || "", 0);
    case "tempban":
      return doBan(a, p, x.reason || "", x.ms);
    case "delete": {
      if (a.kind !== "owner") return "Удалять аккаунты может только владелец.";
      await sql`delete from profiles where id = ${p.id}`; // сессии, данные синхронизации, заметки и прочее удаляются каскадом
      await audit(a.label, "delete", p.login, { nick: p.nick, static: p.static_id, org: p.org });
      return `🗑 Аккаунт <b>${esc(p.login)}</b> и все его данные удалены.`;
    }
    case "role": {
      if (a.kind !== "owner") return "Роли выдаёт только владелец.";
      try {
        await sql`update profiles set rank = ${x.rank}, tg_id = ${x.tg} where id = ${p.id}`;
      } catch (e) {
        if (e && e.code === "23505") return "Этот Telegram ID уже привязан к другому аккаунту.";
        throw e;
      }
      await audit(a.label, "role", p.login, { from: p.rank, to: x.rank, tg_id: x.tg });
      return `✅ ${esc(p.login)}: ${RANKS[p.rank]} → <b>${RANKS[x.rank]}</b>${x.tg ? `\nTelegram ID: <code>${x.tg}</code>` : ""}\nВ приложении изменение применится в течение 20 минут или при следующем запуске.`;
    }
  }
  return "Неизвестное действие.";
}

async function onMessage(m, opts = {}) {
  if (!m.from || !m.chat) return;
  if (m.chat.type !== "private") {
    // в группе бот понимает только /ailog here от владельца: лог вопросов ИИ будет приходить в эту группу
    if (/^\/ailog(@\S+)?\s+here\b/i.test(String(m.text || "")) && OWNER_TG && String(m.from.id) === OWNER_TG) {
      await setSetting("ailog", { on: true, chat: String(m.chat.id) });
      await send(m.chat.id, "✅ Вопросы к ИИ-помощнику будут приходить в этот чат. Вернуть в личные сообщения: /ailog me (в личке с ботом).");
    }
    return;
  }
  const text = String(m.text || "").trim();
  if (!text) return;
  if (!text.startsWith("/")) return onText(m, text);
  const parts = text.split(/\s+/);
  const cmd = parts[0].slice(1).split("@")[0].toLowerCase();
  const args = parts.slice(1);
  const chat = m.chat.id;
  const a = await actorOf(m.from.id);
  const sql = db();

  if (cmd === "start" || cmd === "id" || cmd === "whoami") {
    return send(
      chat,
      `Senko Assistant.\nВаш Telegram ID: <code>${m.from.id}</code>\n` +
        (a ? `Доступ: ${a.kind === "owner" ? "владелец" : a.kind === "leader" ? "руководство " + esc(a.profile.org) : "модератор памятки"}. Команды: /help` : "Команды вам недоступны. Если вы модератор, сообщите этот ID владельцу.")
    );
  }
  if (!a) return send(chat, "Нет доступа.");
  if (a.kind === "leader" && !["help", "broadcast_org", "top", "results", "pending", "approve", "reports", "report"].includes(cmd)) return send(chat, "Эта команда руководству недоступна. Список: /help");
  const owner = a.kind === "owner";
  const ownerOnly = () => send(chat, "Эта команда доступна только владельцу.");
  // цель команды: первый аргумент — логин
  const target = async (usage) => {
    const p = args[0] ? await findProfile(args[0]) : null;
    if (!p) {
      await send(chat, args[0] ? "Пользователь не найден." : "Использование: " + usage);
      return null;
    }
    return p;
  };

  switch (cmd) {
    case "help":
      if (a.kind === "leader") return send(chat, HELP_LEADER);
      return send(chat, HELP_COMMON + HELP_SERVICE + (owner ? HELP_OWNER + HELP_OWNER3 : ""));

    case "find": {
      const q = clean(args.join(" "), 40);
      if (q.startsWith("#")) {
        const tag = normTag(q);
        if (!tag) return send(chat, "Использование: /find #тег");
        const rows = await sql`select * from profiles where ${tag} = any(tags) order by created_at desc limit 30`;
        if (!rows.length) return send(chat, `С тегом #${esc(tag)} никого нет.`);
        return send(chat, `<b>#${esc(tag)}</b> (${rows.length})\n` + rows.map((r) => `• <code>${esc(r.login)}</code> — ${esc(r.nick)} · ${esc(r.org)}${r.banned ? " 🚫" : ""}`).join("\n"));
      }
      if (q.length < 2) return send(chat, "Использование: /find &lt;текст&gt; (минимум 2 символа) или /find #тег");
      const like = "%" + likeEsc(q) + "%";
      const rows = owner
        ? await sql`select * from profiles where login ilike ${like} or nick ilike ${like} or static_id ilike ${like} or discord ilike ${like} or telegram ilike ${like} order by created_at desc limit 10`
        : await sql`select * from profiles where login ilike ${like} or nick ilike ${like} or static_id ilike ${like} or discord ilike ${like} order by created_at desc limit 10`;
      if (!rows.length) return send(chat, "Ничего не найдено.");
      return send(
        chat,
        rows
          .map((r) => `• <code>${esc(r.login)}</code> — ${esc(r.nick)} · ${esc(r.static_id)} · ${esc(r.org)} · ${RANKS[r.rank]}${r.banned ? " 🚫" : ""}`)
          .join("\n") + "\n\nКарточка: /user &lt;логин&gt;"
      );
    }

    case "user": {
      const p = await target("/user &lt;логин&gt;");
      if (!p) return;
      return send(chat, await fullCard(p, a.kind));
    }

    case "note": {
      const p = await target("/note &lt;логин&gt; &lt;текст&gt;");
      if (!p) return;
      const t = clean(args.slice(1).join(" "), 500);
      if (!t) return send(chat, "Использование: /note &lt;логин&gt; &lt;текст&gt;");
      await sql`insert into account_notes (user_id, author, text) values (${p.id}, ${a.label}, ${t})`;
      await audit(a.label, "note", p.login, { text: t });
      return send(chat, `📝 Заметка к <b>${esc(p.login)}</b> сохранена. Пользователь её не видит, смотрите в /user ${esc(p.login)}.`);
    }

    case "warn": {
      const p = await target("/warn &lt;логин&gt; [причина]");
      if (!p) return;
      const deny = canTouch(a, p);
      if (deny) return send(chat, deny);
      const reason = clean(args.slice(1).join(" "), 200);
      await sql`insert into account_warns (user_id, author, reason) values (${p.id}, ${a.label}, ${reason})`;
      const [{ n }] = await sql`select count(*)::int n from account_warns where user_id = ${p.id}`;
      await audit(a.label, "warn", p.login, { reason, n });
      await tellOwner(a, `выдал предупреждение <b>${esc(p.login)}</b> (${n}/${WARN_LIMIT})${reason ? ": " + esc(reason) : ""}`);
      let out = `⚠️ ${esc(p.login)}: предупреждение ${n} из ${WARN_LIMIT}${reason ? " — " + esc(reason) : ""}.`;
      if (n >= WARN_LIMIT && !p.banned) {
        const why = `Автоблокировка: ${n} ${warnWord(n)}, последнее выдал ${issuerName(a)}${reason ? " (" + reason + ")" : ""}`;
        await sql`update profiles set banned = true, ban_reason = ${why}, banned_at = now(), banned_until = null where id = ${p.id}`;
        await audit("system", "autoban", p.login, { warns: n });
        out += `\n🚫 Достигнут лимит, аккаунт заблокирован автоматически. Снять: /unban ${esc(p.login)}`;
        if (OWNER_TG && !owner) await send(OWNER_TG, `🚫 Автоблокировка <b>${esc(p.login)}</b>: ${n} ${warnWord(n)}.`);
      }
      await notifyWarn(a, p, n, reason, n >= WARN_LIMIT);
      out += n >= WARN_LIMIT ? "\n📩 Пользователь увидит экран блокировки с причиной." : "\n📩 Пользователь увидит уведомление в программе.";
      return send(chat, out);
    }

    case "unwarn": {
      const p = await target("/unwarn &lt;логин&gt;");
      if (!p) return;
      const deny = canTouch(a, p);
      if (deny) return send(chat, deny);
      const [w] = await sql`delete from account_warns where id = (select id from account_warns where user_id = ${p.id} order by at desc limit 1) returning *`;
      if (!w) return send(chat, "Предупреждений нет.");
      const [{ n }] = await sql`select count(*)::int n from account_warns where user_id = ${p.id}`;
      await audit(a.label, "unwarn", p.login, { reason: w.reason, left: n });
      await warnNotice(p, "✅ Предупреждение снято", a,
        `Снято предупреждение${w.reason ? " «" + w.reason + "»" : ""}. Снял: ${issuerName(a)}.\nОсталось предупреждений: ${n} из ${WARN_LIMIT}.`);
      return send(chat, `✅ ${esc(p.login)}: последнее предупреждение снято, осталось ${n} из ${WARN_LIMIT}.${p.banned && n < WARN_LIMIT ? "\nАккаунт всё ещё заблокирован, если нужно: /unban " + esc(p.login) : ""}`);
    }

    case "tempban": {
      const p = await target("/tempban &lt;логин&gt; &lt;30m|12h|7d|2w&gt; [причина]");
      if (!p) return;
      const deny = canTouch(a, p);
      if (deny) return send(chat, deny);
      const ms = parseDur(args[1]);
      if (!ms) return send(chat, "Срок: число и буква — m (минуты), h (часы), d (дни), w (недели). Например: /tempban " + esc(p.login) + " 7d флуд");
      const reason = clean(args.slice(2).join(" "), 200);
      if (opts.confirmed) return send(chat, await runConfirmed(a, "tempban", { id: p.id, ms, reason }));
      return askConfirm(chat, a, "tempban", { id: p.id, ms, reason }, `Заблокировать <b>${esc(p.login)}</b> (${esc(p.nick)}, ${esc(p.org)}) на ${durText(ms)}?${reason ? "\nПричина: " + esc(reason) : ""}`);
    }

    case "ban": {
      const p = await target("/ban &lt;логин&gt; [причина]");
      if (!p) return;
      const deny = canTouch(a, p);
      if (deny) return send(chat, deny);
      const reason = clean(args.slice(1).join(" "), 200);
      if (opts.confirmed) return send(chat, await runConfirmed(a, "ban", { id: p.id, reason }));
      return askConfirm(chat, a, "ban", { id: p.id, reason }, `Заблокировать <b>${esc(p.login)}</b> (${esc(p.nick)}, ${esc(p.org)}) бессрочно?${reason ? "\nПричина: " + esc(reason) : ""}`);
    }

    case "unban": {
      const p = await target("/unban &lt;логин&gt;");
      if (!p) return;
      await sql`update profiles set banned = false, ban_reason = '', banned_at = null, banned_until = null where id = ${p.id}`;
      await audit(a.label, "unban", p.login, {});
      await tellOwner(a, `разблокировал <b>${esc(p.login)}</b>`);
      return send(chat, `✅ ${esc(p.login)} разблокирован.`);
    }

    case "kick": {
      const p = await target("/kick &lt;логин&gt;");
      if (!p) return;
      const deny = canTouch(a, p);
      if (deny) return send(chat, deny);
      const r = await sql`delete from sessions where user_id = ${p.id} returning token_hash`;
      await audit(a.label, "kick", p.login, { sessions: r.length });
      await tellOwner(a, `завершил сессии <b>${esc(p.login)}</b>`);
      return send(chat, `👋 ${esc(p.login)}: завершено сессий: ${r.length}. Аккаунт не заблокирован, войти можно заново по паролю.`);
    }

    case "tag":
    case "untag": {
      const p = await target(`/${cmd} &lt;логин&gt; &lt;тег&gt;`);
      if (!p) return;
      const tags = args.slice(1).map(normTag).filter(Boolean);
      if (!tags.length) return send(chat, `Использование: /${cmd} &lt;логин&gt; &lt;тег&gt;${cmd === "tag" ? " [тег…]" : ""}`);
      const cur = new Set(p.tags || []);
      tags.forEach((t) => (cmd === "tag" ? cur.add(t) : cur.delete(t)));
      const next = [...cur].slice(0, 20);
      await sql`update profiles set tags = ${next}::text[] where id = ${p.id}`;
      await audit(a.label, cmd, p.login, { tags });
      return send(chat, `🏷 ${esc(p.login)}: ${next.length ? next.map((t) => "#" + esc(t)).join(" ") : "тегов нет"}`);
    }

    case "online": {
      const rows = await sql`select login, nick, org, rank, last_seen from profiles where last_seen > now() - interval '1 hour' and not banned order by last_seen desc limit 50`;
      if (!rows.length) return send(chat, "За последний час в сети никого не было.");
      return send(chat, `🟢 <b>В сети за час: ${rows.length}</b>\n` + rows.map((r) => `• <code>${esc(r.login)}</code> — ${esc(r.nick)} · ${esc(r.org)} · ${fmtDate(r.last_seen)}`).join("\n"));
    }

    case "inactive": {
      if (!owner) return ownerOnly();
      const days = Math.min(365, Math.max(1, parseInt(args[0], 10) || 30));
      const [{ n }] = await sql`select count(*)::int n from profiles where not banned and (last_seen is null or last_seen < now() - make_interval(days => ${days}))`;
      const rows = await sql`select login, nick, org, last_seen from profiles where not banned and (last_seen is null or last_seen < now() - make_interval(days => ${days}))
                             order by last_seen nulls first limit 40`;
      if (!n) return send(chat, `Все заходили за последние ${days} дн.`);
      return send(chat, `💤 <b>Не заходили ${days}+ дн.: ${n}</b>${n > rows.length ? " (показаны первые " + rows.length + ")" : ""}\n` + rows.map((r) => `• <code>${esc(r.login)}</code> — ${esc(r.nick)} · ${esc(r.org)} · ${r.last_seen ? fmtDate(r.last_seen) : "ни разу"}`).join("\n"));
    }

    case "dups": {
      const groups = async (label, expr) => {
        const rows = await sql`select k, array_agg(login order by created_at) logins from (
                                 select ${sql.unsafe(expr)} as k, login, created_at from profiles) t
                               where k <> '' group by k having count(*) > 1 order by count(*) desc limit 10`;
        return rows.length ? `<b>${label}</b>\n` + rows.map((r) => `• ${esc(r.k)}: ${r.logins.map((l) => "<code>" + esc(l) + "</code>").join(", ")}`).join("\n") : "";
      };
      const out = [
        await groups("Одинаковый Discord", "lower(discord)"),
        await groups("Одинаковый номер", "phone"),
        await groups("Одинаковый статик", "lower(static_id)"),
        await groups("Похожие ники", "regexp_replace(lower(nick), '[^a-zа-яё0-9]', '', 'g')"),
      ].filter(Boolean);
      return send(chat, out.length ? "👥 <b>Похожие аккаунты</b>\n\n" + out.join("\n\n") : "Похожих аккаунтов не найдено.");
    }

    case "setorg": {
      const p = args[0] ? await findProfile(args[0]) : null;
      const org = DEPTS.find((d) => d.toLowerCase() === String(args[1] || "").toLowerCase());
      if (!p || !org) return send(chat, `Использование: /setorg &lt;логин&gt; &lt;${DEPTS.join("|")}&gt;`);
      if (p.org === org) return send(chat, `У ${esc(p.login)} уже указана организация ${org}.`);
      if (a.kind === "moderator" && (p.rank === "owner" || p.rank === "moderator"))
        return send(chat, "Организацию модераторов и владельца меняет только владелец.");
      await sql`update profiles set org = ${org}, dept = ${org} where id = ${p.id}`;
      await audit(a.label, "setorg", p.login, { from: p.org, to: org });
      await tellOwner(a, `сменил организацию <b>${esc(p.login)}</b>: ${esc(p.org)} → ${org}`);
      const gov = org === GOV_ORG ? "\nРежимы «Прокурор» и «Адвокат» откроются в программе." : p.org === GOV_ORG ? "\nРежимы «Прокурор» и «Адвокат» в программе закроются." : "";
      return send(chat, `✅ ${esc(p.login)}: ${esc(p.org)} → <b>${org}</b>${gov}\nПрограмма покажет окно о перезапуске, когда сверится с сервером.`);
    }

    case "rename":
    case "setstatic": {
      if (!owner) return ownerOnly();
      const p = await target(`/${cmd} &lt;логин&gt; &lt;${cmd === "rename" ? "новый ник" : "статик"}&gt;`);
      if (!p) return;
      const val = cmd === "rename" ? clean(args.slice(1).join(" "), 40) : clean(args[1], 12);
      if (cmd === "rename" && val.length < 2) return send(chat, "Ник: от 2 до 40 символов.");
      if (cmd === "setstatic" && !/^[0-9A-Za-z-]{1,12}$/.test(val)) return send(chat, "Статик: до 12 символов, цифры или латиница.");
      const old = cmd === "rename" ? p.nick : p.static_id;
      if (cmd === "rename") await sql`update profiles set nick = ${val} where id = ${p.id}`;
      else await sql`update profiles set static_id = ${val} where id = ${p.id}`;
      await audit(a.label, cmd, p.login, { from: old, to: val });
      let out = `✅ ${esc(p.login)}: ${cmd === "rename" ? "ник" : "статик"} ${esc(old)} → <b>${esc(val)}</b>`;
      if (cmd === "setstatic") {
        const dup = await sql`select login from profiles where lower(static_id) = lower(${val}) and id <> ${p.id}`;
        if (dup.length) out += `\n⚠️ Этот статик уже указан у: ${dup.map((d) => esc(d.login)).join(", ")}`;
      }
      return send(chat, out);
    }

    case "role": {
      if (!owner) return send(chat, "Роли выдаёт только владелец.");
      const p = args[0] ? await findProfile(args[0]) : null;
      const rank = String(args[1] || "").toLowerCase();
      const tgArg = args[2];
      if (!p || !RANKS[rank] || (tgArg && !/^\d{3,15}$/.test(tgArg)))
        return send(chat, "Использование: /role &lt;логин&gt; &lt;user|leader|moderator|owner&gt; [telegram_id]\nПользователь должен быть зарегистрирован.");
      if (rank === "moderator" && !tgArg && p.tg_id == null)
        return send(chat, "Для модератора нужен его Telegram ID: /role " + esc(p.login) + " moderator 123456789\nID покажет бот в ответ на /start, пусть модератор напишет боту.");
      const tgNew = rank === "user" ? null : tgArg ? tgArg : p.tg_id == null ? null : String(p.tg_id);
      return askConfirm(chat, a, "role", { id: p.id, rank, tg: tgNew }, `Выдать <b>${esc(p.login)}</b> роль: ${RANKS[p.rank]} → <b>${RANKS[rank]}</b>?${tgNew ? `\nTelegram ID: <code>${tgNew}</code>` : ""}`);
    }

    case "delete": {
      if (!owner) return ownerOnly();
      const p = await target("/delete &lt;логин&gt;");
      if (!p) return;
      if (p.rank === "owner") return send(chat, "Аккаунт владельца удалить нельзя.");
      return askConfirm(chat, a, "delete", { id: p.id },
        `🗑 <b>Удалить аккаунт ${esc(p.login)}</b> (${esc(p.nick)}, ${esc(p.org)})?\nУдалятся профиль, сессии, синхронизированные данные, заметки и предупреждения. Отменить это нельзя.`);
    }

    case "resets": {
      const rows = await sql`
        select r.id, p.* from reset_requests r join profiles p on p.id = r.user_id
        where r.status = 'pending' and r.expires_at > now() order by r.created_at limit 10`;
      if (!rows.length) return send(chat, "Ожидающих запросов нет.");
      for (const r of rows)
        await send(chat, `🔑 <b>Запрос на сброс пароля</b>\n\n${card(r, a.kind)}`, {
          reply_markup: { inline_keyboard: [[{ text: "✅ Подтвердить", callback_data: `rs:ok:${r.id}` }, { text: "❌ Отклонить", callback_data: `rs:no:${r.id}` }]] },
        });
      return;
    }

    case "stats": {
      if (!owner) return send(chat, "Статистика доступна только владельцу.");
      const [t] = await sql`select count(*)::int total, count(*) filter (where banned)::int banned,
                            count(*) filter (where created_at > now() - interval '7 days')::int week,
                            count(*) filter (where last_seen > now() - interval '1 day')::int active from profiles`;
      const byRank = await sql`select rank, count(*)::int n from profiles group by rank order by n desc`;
      const byOrg = await sql`select org, count(*)::int n from profiles group by org order by n desc limit 8`;
      const [w] = await sql`select count(*) filter (where kind = 'thist' and not deleted)::int det,
                            count(*) filter (where kind = 'tests' and not deleted)::int tests from sync_items`;
      return send(
        chat,
        `📊 <b>Статистика</b>\nВсего: ${t.total} · за 7 дней: +${t.week} · активны за сутки: ${t.active} · заблокировано: ${t.banned}\n\n` +
          byRank.map((r) => `${RANKS[r.rank]}: ${r.n}`).join("\n") +
          "\n\n" + byOrg.map((r) => `${esc(r.org)}: ${r.n}`).join("\n") +
          `\n\nВсего задержаний в базе: ${w.det} · тестов: ${w.tests}`
      );
    }

    case "audit": {
      if (!owner) return send(chat, "Журнал доступен только владельцу.");
      const f = String(args[0] || "").toLowerCase();
      let rows, title = "";
      if (!f) rows = await sql`select * from audit_log order by id desc limit 15`;
      else if (AUDIT_ACTIONS.includes(f)) {
        rows = await sql`select * from audit_log where action = ${f} order by id desc limit 20`;
        title = `действие «${esc(f)}»`;
      } else {
        const lc = clean(f, 24);
        rows = await sql`select * from audit_log where lower(target) = ${lc} or lower(actor) = ${lc} or lower(actor) like ${"%:" + likeEsc(lc)} order by id desc limit 20`;
        title = `логин ${esc(lc)}`;
      }
      if (!rows.length) return send(chat, title ? `По фильтру «${title}» записей нет.` : "Журнал пуст.");
      const detail = (r) => {
        const d = r.details || {};
        const bits = [d.reason, d.text, d.from != null && d.to != null ? `${d.from} → ${d.to}` : ""].filter(Boolean);
        return bits.length ? " · " + esc(bits.join(" · ")).slice(0, 120) : "";
      };
      return send(chat, (title ? `🔎 <b>Журнал: ${title}</b>\n` : "") + rows.map((r) => `${fmtDate(r.at)} · ${esc(r.actor)} · ${esc(r.action)} · ${esc(r.target || "")}${detail(r)}`).join("\n"));
    }

    case "broadcast":
    case "broadcast_org": {
      const isOrg = cmd === "broadcast_org";
      if (!owner && !(isOrg && a.kind === "leader")) return send(chat, isOrg ? "Рассылка по организации доступна владельцу и руководству." : "Эта команда доступна только владельцу.");
      let org = null, rest = args;
      if (isOrg) {
        org = DEPTS.find((d) => d.toLowerCase() === String(args[0] || "").toLowerCase());
        if (!org) return send(chat, `Использование: /broadcast_org &lt;${DEPTS.join("|")}&gt; &lt;текст&gt;`);
        if (a.kind === "leader" && org !== a.profile.org) return send(chat, `Вы можете писать только своей организации (${esc(a.profile.org)}).`);
        rest = args.slice(1);
      }
      // текст берём из исходного сообщения, чтобы сохранить переносы строк
      const body = text.replace(/^\/\S+\s*/, "").replace(isOrg ? /^\S+\s*/ : /^/, "").trim().slice(0, 1500);
      if (!body || !rest.length) return send(chat, isOrg ? "Использование: /broadcast_org &lt;организация&gt; &lt;текст&gt;" : "Использование: /broadcast &lt;текст&gt;");
      const [r] = await sql`insert into broadcasts (org, author, text, expires_at)
                            values (${org}, ${a.label}, ${body}, now() + make_interval(days => ${NOTICE_DAYS})) returning id`;
      await audit(a.label, "broadcast", org || "all", { id: r.id, text: body.slice(0, 200) });
      if (a.kind === "leader") await quiet(`📣 ${esc(a.profile.login)} сделал рассылку для ${org}:\n${esc(body)}`);
      return send(chat, `📣 Рассылка №${r.id} создана${org ? " для " + org : " для всех"}. Её покажут в программе ${NOTICE_DAYS} дней: при запуске и при сверке с сервером.\nУбрать: /unbroadcast ${r.id}`);
    }

    case "broadcasts": {
      if (!owner) return ownerOnly();
      const rows = await sql`select * from broadcasts where expires_at > now() order by created_at desc limit 20`;
      if (!rows.length) return send(chat, "Активных рассылок нет.");
      return send(chat, "📣 <b>Активные сообщения</b>\n" + rows.map((r) =>
        `№${r.id} · ${r.user_id ? "личное" : r.org ? esc(r.org) : "все"} · до ${fmtDate(r.expires_at)}\n${esc(r.text.slice(0, 120))}`).join("\n\n"));
    }

    case "unbroadcast": {
      if (!owner) return ownerOnly();
      const id = parseInt(args[0], 10);
      if (!id) return send(chat, "Использование: /unbroadcast &lt;номер&gt; (номера: /broadcasts)");
      const r = await sql`update broadcasts set expires_at = now() where id = ${id} and expires_at > now() returning id`;
      return send(chat, r.length ? `✅ Рассылка №${id} убрана.` : "Такой активной рассылки нет.");
    }

    case "maintenance": {
      if (!owner) return ownerOnly();
      const v = String(args[0] || "").toLowerCase();
      if (v !== "on" && v !== "off") {
        const m = await getSetting("maintenance", { on: false });
        return send(chat, `Режим техработ: ${m.on ? "включён" : "выключен"}.\nИспользование: /maintenance on [текст] или /maintenance off`);
      }
      const t = v === "on" ? clean(text.replace(/^\/\S+\s+\S+\s*/, ""), 300) : "";
      await setSetting("maintenance", { on: v === "on", text: t, at: Date.now() });
      await audit(a.label, "maintenance", v, { text: t });
      return send(chat, v === "on"
        ? `🛠 Режим техработ включён. Пользователи увидят «Идут технические работы»${t ? ": " + esc(t) : ""}. Регистрация закрыта. Вы и модераторы работаете как обычно.`
        : "✅ Режим техработ выключен.");
    }

    case "summary": {
      if (!owner) return ownerOnly();
      const v = String(args[0] || "").toLowerCase();
      if (v === "now") return send(chat, await summaryText());
      if (v === "off") {
        await setSetting("summary", { time: "" });
        return send(chat, "Ежедневная сводка выключена.");
      }
      const mm = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(v);
      if (!mm) {
        const s = await getSetting("summary", null);
        return send(chat, `Сводка: ${s && s.time ? "каждый день в " + s.time + " МСК" : "выключена"}.\nИспользование: /summary 21:00, /summary off, /summary now`);
      }
      const time = mm[1].padStart(2, "0") + ":" + mm[2];
      await setSetting("summary", { time, last: mskHM() >= time ? mskDay() : "" });
      return send(chat, `🗓 Сводка будет приходить каждый день в ${time} МСК.`);
    }

    case "regs": {
      if (!owner) return ownerOnly();
      const v = String(args[0] || "").toLowerCase();
      const cur = await getSetting("regs", { open: true, limit: 0 });
      if (v !== "on" && v !== "off") return send(chat, `Регистрация: ${cur.open === false ? "закрыта" : "открыта"}${cur.limit ? ", лимит " + cur.limit + " в сутки" : ""}.\nИспользование: /regs on|off, /reglimit &lt;число&gt;|off`);
      await setSetting("regs", { ...cur, open: v === "on" });
      await audit(a.label, "regs", v, {});
      return send(chat, v === "on" ? "✅ Регистрация открыта." : "⛔ Регистрация закрыта. Вход для зарегистрированных работает.");
    }

    case "reglimit": {
      if (!owner) return ownerOnly();
      const v = String(args[0] || "").toLowerCase();
      const n = v === "off" ? 0 : parseInt(v, 10);
      if (!(n >= 0) || isNaN(n)) return send(chat, "Использование: /reglimit &lt;число в сутки&gt; или /reglimit off");
      const cur = await getSetting("regs", { open: true, limit: 0 });
      await setSetting("regs", { ...cur, limit: n });
      await audit(a.label, "reglimit", String(n), {});
      return send(chat, n ? `✅ Лимит регистраций: ${n} за 24 часа.` : "✅ Лимит регистраций снят.");
    }

    case "blacklist": {
      if (!owner) return ownerOnly();
      const op = String(args[0] || "").toLowerCase();
      const list = await getSetting("blacklist", []);
      if (op === "add" || op === "del") {
        const words = args.slice(1).map((w) => w.toLowerCase().replace(/[^0-9a-zа-яё_-]/gi, "")).filter((w) => w.length >= 2);
        if (!words.length) return send(chat, `Использование: /blacklist ${op} &lt;слово&gt; [слово…]`);
        const set = new Set(list);
        words.forEach((w) => (op === "add" ? set.add(w) : set.delete(w)));
        const next = [...set].sort().slice(0, 300);
        await setSetting("blacklist", next);
        await audit(a.label, "blacklist", op, { words });
        return send(chat, `✅ Слов в чёрном списке: ${next.length}.`);
      }
      return send(chat, `🚫 <b>Чёрный список слов</b> (логин и ник при регистрации и смене ника)\n${list.length ? list.map(esc).join(", ") : "пусто"}\n\n/blacklist add &lt;слово&gt; · /blacklist del &lt;слово&gt;`);
    }

    case "appeal": {
      if (!owner) return ownerOnly();
      const t = clean(text.replace(/^\/\S+\s*/, ""), 200);
      if (!t) return send(chat, `Куда обжаловать предупреждения сейчас: ${esc(await appealText())}\n\nИзменить: /appeal &lt;текст&gt;, например /appeal в Discord hanamis1 · /appeal reset — вернуть как было`);
      await setSetting("appeal", { text: t.toLowerCase() === "reset" ? "" : t });
      await audit(a.label, "appeal", null, { text: t });
      return send(chat, `✅ Теперь в предупреждениях будет написано: «Обжаловать: ${esc(await appealText())}».`);
    }

    case "in": {
      if (opts.confirmed) return send(chat, "Отложенная команда не может создавать новые.");
      const ms = parseDur(args[0]);
      const command = text.replace(/^\/\S+\s+\S+\s*/, "").trim();
      const sub = (command.match(/^\/?(\S+)/) || [])[1];
      const subCmd = sub ? sub.toLowerCase().split("@")[0] : "";
      if (!ms || ms > 30 * 864e5 || !subCmd) return send(chat, "Использование: /in &lt;срок: 30m, 2h, 1d&gt; &lt;команда&gt;\nНапример: /in 2h unban cop1 (не больше 30 дней).");
      if (["in", "delete", "role", "backup", "jobs"].includes(subCmd)) return send(chat, `Команду /${esc(subCmd)} отложить нельзя.`);
      const full = "/" + command.replace(/^\//, "");
      const payload = { command: full, ms };
      if (["ban", "tempban"].includes(subCmd))
        return askConfirm(chat, a, "delay", payload, `Через ${durText(ms)} выполнить <code>${esc(full)}</code>?\nПодтверждать ещё раз в момент выполнения не придётся.`);
      return send(chat, await scheduleJob(a, payload));
    }

    case "jobs": {
      if (String(args[0] || "").toLowerCase() === "cancel") {
        const id = parseInt(args[1], 10);
        const r = id ? await sql`delete from bot_delayed where id = ${id} and (actor_tg = ${a.tg} or ${owner}) returning id` : [];
        return send(chat, r.length ? `✅ Отложенная команда №${id} отменена.` : "Такой отложенной команды нет.");
      }
      const rows = owner
        ? await sql`select * from bot_delayed order by run_at limit 20`
        : await sql`select * from bot_delayed where actor_tg = ${a.tg} order by run_at limit 20`;
      if (!rows.length) return send(chat, "Отложенных команд нет.");
      return send(chat, "⏰ <b>Отложенные команды</b>\n" + rows.map((r) => `№${r.id} · ${fmtDate(r.run_at)} · ${esc(r.actor_label)}\n<code>${esc(r.command)}</code>`).join("\n") + "\n\nОтменить: /jobs cancel &lt;номер&gt;");
    }

    case "backup": {
      if (!owner) return ownerOnly();
      if (!BACKUP_KEY) return send(chat, "Не задан секрет BACKUP_KEY (пароль резервных копий). Добавьте его в Supabase → Edge Functions → Secrets.");
      if (!(await hit("backup", 6, 3600))) return send(chat, RATE_MSG);
      await send(chat, "⏳ Собираю резервную копию…");
      const f = await backupFile();
      await audit(a.label, "backup", null, f.counts);
      const r = await sendFile(chat, `senko-backup-${mskDay()}.json`, f.json,
        `🔒 Резервная копия. Аккаунтов: ${f.counts.profiles}, записей синхронизации за сутки: ${f.counts.sync}.\nРасшифровка: node tools/decrypt-backup.js файл (нужен пароль BACKUP_KEY).`);
      if (!r || !r.ok) return send(chat, "Не удалось отправить файл: " + esc((r && r.description) || "ошибка Telegram"));
      return;
    }

    case "laws":
      if (!owner) return ownerOnly();
      return lawsCmd(chat, String(args[0] || "").toLowerCase());

    case "top": {
      // /top [организация] [xp|tests|det]; руководство видит только свою организацию
      let org = null, by = "xp";
      for (const x of args.map((v) => v.toLowerCase())) {
        const o = DEPTS.find((d) => d.toLowerCase() === x);
        if (o) org = o;
        else if (["xp", "tests", "det", "опыт", "тесты", "задержания"].includes(x)) by = { опыт: "xp", тесты: "tests", задержания: "det" }[x] || x;
      }
      if (a.kind === "leader") org = a.profile.org;
      const w = mskWeek();
      let L = await weekStats(org, w);
      if (by === "tests") L = L.filter((x) => x.tests > 0).sort((p1, p2) => p2.avg_p - p1.avg_p || p2.tests - p1.tests);
      else if (by === "det") L = L.filter((x) => x.det > 0).sort((p1, p2) => p2.det - p1.det);
      else L = L.filter((x) => x.wxp > 0).sort(byWxp);
      const head = `🏆 <b>Рейтинг недели${org ? " · " + esc(org) : ""}</b> (с ${ddmm(w.start)}, ${by === "tests" ? "по тестам" : by === "det" ? "по задержаниям" : "по опыту"})`;
      if (!L.length) return send(chat, head + "\nЗа эту неделю данных пока нет.");
      const val = (x) => (by === "tests" ? `${x.avg_p}% (${x.tests} ${plural(x.tests, "тест", "теста", "тестов")})` : by === "det" ? `${x.det}` : `${x.wxp} опыта · ${x.lvl.name}`);
      return send(chat, head + "\n" + L.slice(0, 10).map((x, i) => `${i + 1}. ${esc(x.nick)} <code>${esc(x.login)}</code>${org ? "" : " · " + esc(x.org)} — ${val(x)}`).join("\n") +
        (a.kind === "leader" ? "" : "\n\n/top &lt;организация&gt; [tests|det]"));
    }

    case "results": {
      const id = parseInt(args[0], 10);
      const scope = a.kind === "leader" ? a.profile.org : null;
      if (id) {
        const [t] = await sql`select * from control_tests where id = ${id}`;
        if (!t || (scope && t.org !== scope)) return send(chat, "Тест не найден.");
        const d = await ctrlDetails(t);
        return send(chat, `📋 <b>№${d.id} · ${esc(d.title)}</b> · ${esc(d.org)}\nТемы: ${d.topics.map((k) => TOPICS[k] || k).join(", ")} · вопросов: ${d.n}\nСрок: до ${fmtDate(d.due)}${d.active ? "" : " (завершён)"} · создал ${esc(d.by)}\n\n` +
          `<b>Прошли: ${d.results.length}</b>${d.avg == null ? "" : " · средний результат " + d.avg + "%"}\n` +
          (d.results.length ? d.results.map((r) => `• ${esc(r.nick)} — ${r.p}% (${r.s} из ${r.n})`).join("\n") : "пока никто") +
          (d.missingN ? `\n\n<b>Не прошли: ${d.missingN}</b>\n${d.missing.map(esc).join(", ")}${d.missingN > d.missing.length ? " …" : ""}` : ""));
      }
      const rows = scope
        ? await sql`select * from control_tests where org = ${scope} order by created_at desc limit 8`
        : await sql`select * from control_tests order by created_at desc limit 8`;
      if (!rows.length) return send(chat, "Контрольных тестов ещё не было. Создать тест можно в программе: панель руководителя → «Контрольные тесты».");
      const L = [];
      for (const t of rows) {
        const d = await ctrlDetails(t);
        L.push(`№${d.id} · ${esc(d.org)} · «${esc(d.title)}» · ${d.active ? "до " + fmtDate(d.due) : "завершён"}\n   прошли ${d.results.length} из ${d.results.length + d.missingN}${d.avg == null ? "" : ", ср. " + d.avg + "%"}`);
      }
      return send(chat, "📋 <b>Контрольные тесты</b>\n" + L.join("\n") + "\n\nПодробно: /results &lt;номер&gt;");
    }

    case "reports": {
      const scope = a.kind === "leader" ? a.profile.org : null;
      const arg = String(args[0] || "");
      if (/^(on|off)$/i.test(arg)) {
        const on = arg.toLowerCase() === "on";
        await setSetting("rpn:" + a.tg, { on });
        return send(chat, on ? `🔔 Новые рапорты${scope ? " " + esc(scope) : " всех организаций"} будут приходить сюда. Выключить: /reports off` : "🔕 Уведомления о новых рапортах выключены. Включить: /reports on");
      }
      let org = scope, login = null, st = null;
      if (arg.toLowerCase() === "new") st = "new";
      else if (arg) {
        const d = DEPTS.find((x) => x.toLowerCase() === arg.toLowerCase());
        if (d && !scope) org = d;
        else if (!d) login = arg.toLowerCase();
      }
      const rows = await sql`select * from reports
        where (${org}::text is null or org = ${org}) and (${login}::text is null or lower(login) = ${login}) and (${st}::text is null or status = ${st})
        order by created_at desc limit 15`;
      if (!rows.length) return send(chat, "Рапортов нет." + (arg ? "" : " Сотрудники пишут их в программе: «Работа» → «Рапорты»."));
      const [{ n }] = await sql`select count(*)::int n from reports where status = 'new' and (${scope}::text is null or org = ${scope})`;
      return send(chat, `📝 <b>Рапорты${org ? " · " + esc(org) : ""}${login ? " · " + esc(login) : ""}${st ? " · на рассмотрении" : ""}</b>\n` +
        rows.map((r) => `${RP_ICON[r.status]} №${r.id} · ${fmtDate(r.created_at).replace(" МСК", "")}${org ? "" : " · " + esc(r.org)}\n   ${esc(r.title)} — ${esc(r.author)}`).join("\n") +
        `\n\nНа рассмотрении: ${n}. Открыть: /report &lt;номер&gt;\n/reports new — только новые; /reports &lt;логин&gt;${scope ? "" : "; /reports &lt;организация&gt;"}\n/reports on|off — уведомления о новых`);
    }

    case "report": {
      const id = parseInt(String(args[0] || "").replace(/^№/, ""), 10);
      if (!id) return send(chat, "Использование: /report &lt;номер&gt;. Список: /reports");
      const [r] = await sql`select * from reports where id = ${id}`;
      if (!r || (a.kind === "leader" && r.org !== a.profile.org)) return send(chat, "Рапорт не найден.");
      return send(chat, rpText(r), rpButtons(r));
    }

    case "pending": {
      const scope = a.kind === "leader" ? a.profile.org : null;
      const rows = scope
        ? await sql`select * from profiles where approval = 'pending' and org = ${scope} order by created_at limit 10`
        : await sql`select * from profiles where approval = 'pending' order by created_at limit 10`;
      const st = await getSetting("approval", { on: false });
      if (!rows.length) return send(chat, `Заявок нет. Приём новичков ${st.on ? "включён" : "выключен"}${owner ? " (/approval on|off)" : ""}.`);
      for (const p of rows)
        await send(chat, `🆕 <b>Заявка в ${esc(p.org)}</b> от ${fmtDate(p.created_at)}\n\n${card(p, a.kind === "owner" ? "owner" : "leader")}`, {
          reply_markup: { inline_keyboard: [[{ text: "✅ Принять", callback_data: `ap:ok:${p.id}` }, { text: "❌ Отклонить", callback_data: `ap:no:${p.id}` }]] },
        });
      return;
    }

    case "approve": {
      const p = await target("/approve &lt;логин&gt; — принять отклонённую или ожидающую заявку");
      if (!p) return;
      if (a.kind === "leader" && p.org !== a.profile.org) return send(chat, "Это сотрудник другой организации.");
      if (p.approval === "ok") return send(chat, "Аккаунт уже подтверждён.");
      await sql`update profiles set approval = 'pending' where id = ${p.id}`;
      const r = await decideApproval(a, p.id, true);
      return send(chat, r.err || r.text);
    }

    case "approval": {
      if (!owner) return ownerOnly();
      const v = String(args[0] || "").toLowerCase();
      if (v !== "on" && v !== "off") {
        const st = await getSetting("approval", { on: false });
        return send(chat, `Приём новичков: ${st.on ? "включён" : "выключен"}.\nКогда включён, новый аккаунт ждёт, пока руководство его организации нажмёт «Принять» в боте (если у руководства нет Telegram — решаете вы).\n/approval on · /approval off · заявки: /pending`);
      }
      await setSetting("approval", { on: v === "on" });
      await audit(a.label, "approval", v, {});
      if (v === "off") {
        const r = await sql`update profiles set approval = 'ok' where approval = 'pending' returning login`;
        return send(chat, `✅ Приём новичков выключен.${r.length ? " Ожидавшие заявки приняты автоматически: " + r.map((x) => esc(x.login)).join(", ") + "." : ""}`);
      }
      return send(chat, "✅ Приём новичков включён. Новые аккаунты будут ждать подтверждения руководства своей организации.\nВажно: заявки корректно показываются только в программе 1.9 и новее (/versions).");
    }

    case "orgreport": {
      if (!owner) return ownerOnly();
      const v = String(args[0] || "").toLowerCase();
      if (v === "on" || v === "off") {
        const cur = await getSetting("orgreport", {});
        await setSetting("orgreport", { ...cur, on: v === "on" });
        return send(chat, v === "on" ? "✅ Еженедельный отчёт руководству включён: понедельник, 12:00 МСК." : "Еженедельный отчёт руководству выключен.");
      }
      const org = DEPTS.find((d) => d.toLowerCase() === v);
      if (!org) {
        const cur = await getSetting("orgreport", {});
        return send(chat, `Еженедельный отчёт руководителям с Telegram: ${cur.on === false ? "выключен" : "включён (понедельник, 12:00 МСК)"}.\nПосмотреть отчёт сейчас: /orgreport &lt;${DEPTS.join("|")}&gt;\n/orgreport on|off`);
      }
      return send(chat, (await orgReport(org)) || "В организации нет сотрудников.");
    }

    case "ailog": {
      if (!owner) return ownerOnly();
      const v = String(args[0] || "").toLowerCase();
      if (v === "on" || v === "off" || v === "me") {
        const cur = await getSetting("ailog", { on: true });
        await setSetting("ailog", v === "me" ? { on: true } : { ...cur, on: v === "on" });
        return send(chat, v === "off" ? "Лог вопросов ИИ в Telegram выключен (вопросы по-прежнему видны в /ailog)." : "✅ Вопросы к ИИ будут приходить сюда, без звука.");
      }
      const days = Math.min(90, Math.max(1, parseInt(v, 10) || 7));
      return send(chat, (await aiStatsText(days)) + "\n\n/ailog 30 — за 30 дней · /ailog off|on · в группу: добавьте бота в группу и напишите там /ailog here");
    }

    case "health":
      return send(chat, await healthText());

    case "versions":
      return send(chat, await versionsText());

    case "cancel": {
      const r = await sql`delete from bot_pending where actor_tg = ${a.tg} and action = 'bugreply' returning id`;
      return send(chat, r.length ? "Ответ отменён." : "Нечего отменять.");
    }

    default:
      return send(chat, "Неизвестная команда. /help");
  }
}

async function onCallback(cb) {
  const answer = (text, alert = false) => tg("answerCallbackQuery", { callback_query_id: cb.id, text, show_alert: alert });
  const a = cb.from ? await actorOf(cb.from.id) : null;
  if (!a) return answer("Нет доступа.", true);
  const data = String(cb.data || "");
  const chat = cb.message && cb.message.chat ? cb.message.chat.id : null;
  const sql = db();
  const clearButtons = () =>
    cb.message ? tg("editMessageReplyMarkup", { chat_id: chat, message_id: cb.message.message_id, reply_markup: { inline_keyboard: [] } }) : null;

  // Подтверждение опасных команд
  const c = /^cf:(ok|no):([0-9a-f-]{36})$/i.exec(data);
  if (c) {
    await clearButtons();
    // запись берётся и удаляется одним запросом: повторное нажатие ничего не сделает
    const [pd] = await sql`delete from bot_pending where id = ${c[2]} and actor_tg = ${a.tg} returning *`;
    if (!pd || new Date(pd.expires_at).getTime() < Date.now()) return answer("Кнопка устарела. Повторите команду.", true);
    if (c[1] === "no") {
      await answer("Отменено");
      if (chat) await send(chat, "✖️ Действие отменено.");
      return;
    }
    await answer("Выполняю");
    const out = await runConfirmed(a, pd.action, pd.payload || {});
    if (chat) await send(chat, out);
    return;
  }

  // «Ответить» под сообщением об ошибке
  const bg = /^bg:(\d+)$/.exec(data);
  if (bg) {
    if (a.kind !== "owner") return answer("Отвечать может только владелец.", true);
    await sql`delete from bot_pending where actor_tg = ${a.tg} and action = 'bugreply'`;
    await sql`insert into bot_pending (actor_tg, action, payload, expires_at)
              values (${a.tg}, 'bugreply', ${sql.json({ bug: +bg[1] })}, now() + interval '15 minutes')`;
    await answer("Жду ответ");
    if (chat) await send(chat, `✍️ Напишите ответ на сообщение №${bg[1]} одним сообщением (в течение 15 минут). Отмена: /cancel`);
    return;
  }

  // Рапорт: «Принять» / «Отклонить»
  const rp = /^rp:(ok|no):(\d+)$/.exec(data);
  if (rp) {
    const name = a.kind === "owner" ? "владелец" : a.profile.nick || a.profile.login;
    const x = await rpReview({ label: a.label, name, org: a.kind === "leader" ? a.profile.org : null }, +rp[2], rp[1] === "ok", "");
    if (x.err) return answer(x.err, true);
    await clearButtons();
    await answer(rp[1] === "ok" ? "Принят" : "Отклонён");
    if (chat) await send(chat, `${rp[1] === "ok" ? "✅ Принят" : "❌ Отклонён"} рапорт №${x.r.id} (${esc(x.r.author)}). Автор увидит решение в программе.`);
    return;
  }

  // Приём новичков: «Принять» / «Отклонить»
  const ap = /^ap:(ok|no):([0-9a-f-]{36})$/i.exec(data);
  if (ap) {
    const r = await decideApproval(a, ap[2], ap[1] === "ok");
    if (r.err && /другой организации/.test(r.err)) return answer(r.err, true);
    await clearButtons();
    if (r.err) return answer(r.err, true);
    await answer(ap[1] === "ok" ? "Принят" : "Отклонён");
    if (chat) await send(chat, r.text);
    return;
  }

  const m = /^rs:(ok|no):([0-9a-f-]{36})$/i.exec(data);
  if (!m) return answer("Неизвестное действие.");
  if (a.kind === "leader") return answer("Нет доступа.", true);
  const approve = m[1] === "ok";
  let r;
  if (approve) {
    [r] = await sql`update reset_requests set status = 'approved', decided_by = ${a.label}, decided_at = now(),
                    expires_at = now() + make_interval(mins => ${RESET_APPROVED_MIN})
                    where id = ${m[2]} and status = 'pending' and expires_at > now() returning *`;
  } else {
    [r] = await sql`update reset_requests set status = 'rejected', decided_by = ${a.label}, decided_at = now()
                    where id = ${m[2]} and status = 'pending' and expires_at > now() returning *`;
  }
  await clearButtons();
  if (!r) return answer("Запрос уже обработан или истёк.", true);
  const [p] = await sql`select login from profiles where id = ${r.user_id}`;
  const login = p ? p.login : "?";
  await audit(a.label, approve ? "reset_approve" : "reset_reject", login, {});
  await answer(approve ? "Подтверждено" : "Отклонено");
  if (chat) await send(chat, `${approve ? "✅ Сброс пароля подтверждён" : "❌ Сброс пароля отклонён"}: <b>${esc(login)}</b>`);
  if (a.kind === "moderator" && OWNER_TG)
    await send(OWNER_TG, `ℹ️ ${esc(a.profile.login)} ${approve ? "подтвердил" : "отклонил"} сброс пароля: <b>${esc(login)}</b>`);
}

async function bot(req) {
  const got = req.headers.get("x-telegram-bot-api-secret-token") || "";
  if (!WEBHOOK_SECRET || !safeEq(got, WEBHOOK_SECRET)) return new Response("forbidden", { status: 403 });
  let u;
  try {
    u = await req.json();
  } catch (e) {
    return new Response("bad", { status: 400 });
  }
  try {
    if (u.message) await onMessage(u.message);
    else if (u.callback_query) await onCallback(u.callback_query);
  } catch (e) {
    console.error("bot", e);
  }
  return new Response("ok"); // всегда 200, иначе Telegram будет повторять обновление
}

// ───────────── Расписание (pg_cron раз в минуту) и оповещения о законах ─────────────
async function tick() {
  const sql = db();
  await setSetting("tick", { at: Date.now() });
  // отложенные команды (/in): забираем и удаляем одним запросом, чтобы не выполнить дважды
  const jobs = await sql`delete from bot_delayed where id in (
                           select id from bot_delayed where run_at <= now() order by run_at limit 10 for update skip locked)
                         returning *`;
  for (const j of jobs) {
    try {
      await send(j.actor_tg, `⏰ Выполняю отложенную команду №${j.id}: <code>${esc(j.command)}</code>`);
      await onMessage({ from: { id: Number(j.actor_tg) }, chat: { id: Number(j.actor_tg), type: "private" }, text: j.command }, { confirmed: true });
    } catch (e) {
      console.error("job", e);
    }
  }
  // ежедневная сводка в заданное время (МСК)
  const s = await getSetting("summary", null);
  if (s && s.time && s.last !== mskDay() && mskHM() >= s.time) {
    await setSetting("summary", { ...s, last: mskDay() });
    if (OWNER_TG) await send(OWNER_TG, await summaryText());
  }
  // опыт на начало недели, автозакрытие смен, еженедельный отчёт руководству (понедельник, 12:00 МСК)
  await snapshotWeek();
  const old = await sql`select * from shifts where ended_at is null and started_at < now() - interval '12 hours' limit 5`;
  for (const sh of old) await endShift(sh, null, true);
  const wk = mskWeek(), rep = await getSetting("orgreport", {});
  if (rep.on !== false && wk.key === mskDay() && mskHM() >= "12:00" && rep.last !== wk.key) {
    await setSetting("orgreport", { ...rep, last: wk.key });
    await sendOrgReports();
  }
  if (Math.random() < 0.05) await cleanup();
  return { ok: true, jobs: jobs.length };
}

// ───────────── /laws: ручной запуск проверки законов на GitHub ─────────────
async function gh(path, opts = {}) {
  const r = await fetch(`https://api.github.com/repos/${GH_REPO}${path}`, {
    method: opts.method || "GET",
    headers: {
      authorization: `Bearer ${GH_LAWS_TOKEN}`,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "user-agent": "senko-bot",
      ...(opts.body ? { "content-type": "application/json" } : {}),
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
    signal: AbortSignal.timeout(15000),
  });
  const text = await r.text();
  let j = null;
  try {
    j = text ? JSON.parse(text) : null;
  } catch (e) {}
  return { status: r.status, ok: r.ok, j };
}
const RUN_STATE = { queued: "в очереди", in_progress: "идёт", waiting: "ждёт", pending: "ждёт", requested: "в очереди" };
const RUN_END = { success: "✅ успешно", failure: "❌ ошибка", cancelled: "✖️ отменена", timed_out: "⌛ превышено время" };
const runLine = (r) =>
  `${r.status === "completed" ? RUN_END[r.conclusion] || r.conclusion : "⏳ " + (RUN_STATE[r.status] || r.status)} · ${fmtDate(r.created_at)} · ${r.event === "schedule" ? "по расписанию" : "вручную"}`;
const ghError = (r) =>
  r.status === 401 ? "GitHub не принял токен GH_LAWS_TOKEN: он неверный или истёк." :
  r.status === 403 || r.status === 404 ? "У токена GH_LAWS_TOKEN нет доступа: нужен доступ к репозиторию " + GH_REPO + " с правом Actions: Read and write." :
  "GitHub ответил ошибкой " + r.status + ".";

async function lawsCmd(chat, arg) {
  if (!GH_LAWS_TOKEN) return send(chat, "Не задан секрет GH_LAWS_TOKEN (токен GitHub). Добавьте его в Supabase → Edge Functions → Secrets.");
  const runs = await gh(`/actions/workflows/${LAWS_WORKFLOW}/runs?per_page=3`);
  if (!runs.ok) return send(chat, ghError(runs));
  const list = (runs.j && runs.j.workflow_runs) || [];
  const link = `https://github.com/${GH_REPO}/actions/workflows/${LAWS_WORKFLOW}`;
  if (arg === "status") {
    if (!list.length) return send(chat, "Проверок законов ещё не было.");
    return send(chat, "⚖️ <b>Последние проверки законов</b>\n" + list.map(runLine).join("\n") + `\n\n<a href="${link}">Открыть на GitHub</a>`);
  }
  if (list[0] && list[0].status !== "completed")
    return send(chat, `⏳ Проверка уже идёт (запущена ${fmtDate(list[0].created_at)}). Статус: /laws status`);
  if (!(await hit("laws", 4, 3600))) return send(chat, "Можно запускать не больше 4 раз в час.");
  const r = await gh(`/actions/workflows/${LAWS_WORKFLOW}/dispatches`, { method: "POST", body: { ref: "main" } });
  if (r.status !== 204) return send(chat, ghError(r));
  return send(chat, "🔄 Проверка законов запущена. Обычно занимает 3–10 минут. Когда закончится, я напишу, что изменилось (или что изменений нет).\nСтатус: /laws status");
}

// Вызов из GitHub Actions после обновления законов (scripts/publish-laws.js)
async function lawsChanged(b) {
  const items = Array.isArray(b.items) ? b.items.slice(0, 25) : [];
  if (!items.length) {
    // ручной запуск без изменений — сообщаем только владельцу
    if (b.manual && OWNER_TG) await send(OWNER_TG, `⚖️ Проверка законов завершена: изменений нет.${Number(b.count) ? " Законов: " + Number(b.count) + "." : ""}`);
    return { ok: true, sent: b.manual ? 1 : 0 };
  }
  const lines = items.map((it) =>
    `• ${it.type === "new" ? "🆕 Новый закон" : "✏️ Изменён"}: <b>${esc(clean(it.title, 150))}</b>${it.arts ? " — " + esc(clean(it.arts, 200)) : ""}`);
  const more = Array.isArray(b.items) && b.items.length > items.length ? `\n…и ещё ${b.items.length - items.length}` : "";
  const text = `⚖️ <b>Обновление законов</b>\n${lines.join("\n")}${more}\n\nИзменения уже в программе, раздел «Законы».`;
  const chats = new Set();
  if (OWNER_TG) chats.add(OWNER_TG);
  const rows = await db()`select tg_id from profiles where rank = 'leader' and tg_id is not null and not banned`;
  rows.forEach((r) => chats.add(String(r.tg_id)));
  for (const c of chats) await send(c, text);
  return { ok: true, sent: chats.size };
}

async function cron(req) {
  const got = req.headers.get("x-senko-cron") || "";
  if (!CRON_SECRET || !safeEq(got, CRON_SECRET)) return J(fail("forbidden"), 403);
  let b = {};
  try {
    b = await req.json();
  } catch (e) {}
  if (b && b.action === "laws_changed") return J(await lawsChanged(b));
  if (b && b.action === "laws_failed") {
    const run = /^\d{1,20}$/.test(String(b.run || "")) ? String(b.run) : "";
    if (OWNER_TG)
      await send(OWNER_TG, `❌ <b>Обновление законов не удалось</b>${b.manual ? " (ручной запуск)" : ""}. В программе остались прошлые версии.${run ? `\n<a href="https://github.com/${GH_REPO}/actions/runs/${run}">Лог на GitHub</a>` : ""}`);
    return J({ ok: true });
  }
  return J(await tick());
}

// Подключение бота: открыть в браузере  <адрес функции>?setup=<TG_WEBHOOK_SECRET>
async function setup(url) {
  if (!WEBHOOK_SECRET || !safeEq(url.searchParams.get("setup") || "", WEBHOOK_SECRET)) return J(fail("forbidden"), 403);
  if (!BOT_TOKEN) return J(fail("Не задан секрет TELEGRAM_BOT_TOKEN."), 500);
  const hook = await tg("setWebhook", {
    url: SELF_URL,
    secret_token: WEBHOOK_SECRET,
    allowed_updates: ["message", "callback_query"],
    drop_pending_updates: true,
  });
  await tg("setMyCommands", {
    commands: [
      { command: "start", description: "Показать мой Telegram ID" },
      { command: "help", description: "Список команд" },
      { command: "find", description: "Поиск пользователя" },
      { command: "user", description: "Карточка пользователя" },
      { command: "resets", description: "Запросы на сброс пароля" },
      { command: "online", description: "Кто в сети за час" },
      { command: "note", description: "Заметка к аккаунту" },
      { command: "warn", description: "Предупреждение" },
      { command: "tempban", description: "Блокировка на срок" },
      { command: "ban", description: "Заблокировать" },
      { command: "unban", description: "Разблокировать" },
      { command: "kick", description: "Завершить сессии" },
      { command: "tag", description: "Теги аккаунта" },
      { command: "dups", description: "Похожие аккаунты" },
      { command: "setorg", description: "Сменить организацию" },
      { command: "health", description: "Статус сервисов" },
      { command: "laws", description: "Проверить законы сейчас" },
      { command: "top", description: "Рейтинг недели" },
      { command: "results", description: "Контрольные тесты" },
      { command: "pending", description: "Заявки новичков" },
      { command: "reports", description: "Рапорты сотрудников" },
      { command: "report", description: "Открыть рапорт по номеру" },
      { command: "ailog", description: "Вопросы к ИИ" },
      { command: "in", description: "Отложенная команда" },
      { command: "jobs", description: "Отложенные команды" },
    ],
  });
  return J({ ok: !!(hook && hook.ok), webhook: SELF_URL, telegram: hook });
}

// ───────────── Точка входа ─────────────
Deno.serve(async (req) => {
  try {
    if (req.method === "GET") {
      const url = new URL(req.url);
      if (url.searchParams.has("setup")) return await setup(url);
      return J({ ok: true, service: "senko" });
    }
    if (req.method !== "POST") return J(fail("Метод не поддерживается."), 405);
    if (req.headers.get("x-telegram-bot-api-secret-token")) return await bot(req);
    if (req.headers.get("x-senko-cron")) return await cron(req);
    return await api(req);
  } catch (e) {
    console.error(e);
    return J(fail("Ошибка сервера. Попробуйте позже."), 500);
  }
});
