// @ts-nocheck
// ============================================================================
// Senko Assistant · серверная функция (Supabase Edge Function «senko»)
// Одна функция делает всё:
//   • POST от приложения        → API (регистрация, вход, сессии, сброс пароля, список сотрудников)
//   • POST от Telegram          → бот (роли, баны, подтверждение сброса пароля)
//   • GET ?setup=<секрет>       → один раз подключает бота (setWebhook)
//   • GET ?s=<код>              → текст расчёта или набора статей по ссылке «Поделиться»
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
const LEGAL_VERSION = "2026-10-21.2"; // версия Политики и Условий; должна совпадать с VERSION в app/auth.html и app/index.html
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
  await sql`delete from login_log where at < now() - interval '90 days'`;
  await sql`update profiles set banned = false, ban_reason = '', banned_at = null, banned_until = null where banned and banned_until is not null and banned_until <= now()`;
}
const maybeCleanup = () => (Math.random() < 0.05 ? cleanup().catch((e) => console.error("cleanup", e)) : null);

// ───────────── Telegram ─────────────
async function tg(method, payload) {
  const pid = String((payload && (payload.chat_id ?? payload.callback_query_id)) ?? "");
  if (pid.startsWith("panel:")) return panelCapture(pid, method, payload); // ответ для панели на сайте, не в Telegram
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
    `Номер в игре: ${esc(p.phone || "—")}`,
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
    beta: !!p.beta,
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
  if (phone && !/^[0-9]{3,12}$/.test(phone)) return { error: "Номер в игре: только цифры (3–12 знаков) или оставьте поле пустым." };
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
  await logIn(p.id, "register", b, ip);
  maybeCleanup();
  const ver = appVer(b);
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
  await postHook(p.org, "join", pend ? "🆕 Заявка в организацию" : "🆕 Новый сотрудник", `**${esc(p.nick)}** (статик ${esc(p.static_id)}) зарегистрировался в Senko Assistant${pend ? " и ждёт подтверждения руководства: /pending в боте или панель руководителя в программе." : "."}`, 0x2e7d4f);
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
// ───────────── Журнал входов (2.2) ─────────────
// Пользователь видит его в кабинете. IP хранится только началом: 85.143.x.x
function ipShort(ip) {
  const v = String(ip || "");
  const m = /^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(v);
  if (m) return `${m[1]}.${m[2]}.x.x`;
  if (v.includes(":")) return v.split(":").slice(0, 2).join(":") + ":…";
  return "";
}
async function logIn(userId, kind, b, ip) {
  try {
    await db()`insert into login_log (user_id, kind, ver, os, ip) values (${userId}, ${kind}, ${clean(b && b.ver, 20)}, ${clean(b && b.os, 40)}, ${ipShort(ip)})`;
  } catch (e) {
    console.error("login_log", e);
  }
}
async function loginsApi(b, ip) {
  const { p, err } = await who(b);
  if (err) return err;
  const sql = db();
  const th = await sha256(b.token);
  if (b.op === "end_others") {
    if (!(await hit(`eo:${p.id}`, 10, 3600))) return fail(RATE_MSG, { code: "rate" });
    const r = await sql`delete from sessions where user_id = ${p.id} and token_hash <> ${th} returning token_hash`;
    await logIn(p.id, "logout_all", b, ip);
    return { ok: true, ended: r.length };
  }
  const list = await sql`select at, kind, ver, os, ip from login_log where user_id = ${p.id} order by at desc limit 30`;
  const [{ n }] = await sql`select count(*)::int as n from sessions where user_id = ${p.id} and expires_at > now() and token_hash <> ${th}`;
  return { ok: true, list: list.map((r) => ({ at: new Date(r.at).getTime(), kind: r.kind, ver: r.ver, os: r.os, ip: r.ip })), others: n };
}
// ───────────── Смена пароля из личного кабинета (2.2) ─────────────
async function changePassword(b, ip) {
  const { p, err } = await who(b);
  if (err) return err;
  if (!(await hit(`cp:${p.id}`, 6, 900))) return fail(RATE_MSG, { code: "rate" });
  const old = String(b.old == null ? "" : b.old);
  const pass = String(b.password == null ? "" : b.password);
  if (!old) return fail("Введите текущий пароль.");
  const pe = passError(pass);
  if (pe) return fail(pe);
  if (old === pass) return fail("Новый пароль совпадает с текущим.");
  const sql = db();
  const [{ ok }] = await sql`select extensions.crypt(${old}, ${p.pass_hash}) = ${p.pass_hash} as ok`;
  if (!ok) {
    await logIn(p.id, "fail", b, ip);
    return fail("Текущий пароль неверный.");
  }
  const th = await sha256(b.token);
  await sql`update profiles set pass_hash = extensions.crypt(${pass}, extensions.gen_salt('bf', 10)) where id = ${p.id}`;
  // остальные входы с этим паролем завершаются, этот компьютер остаётся в аккаунте
  const r = await sql`delete from sessions where user_id = ${p.id} and token_hash <> ${th} returning token_hash`;
  await logIn(p.id, "password", b, ip);
  await audit(p.login, "password_change", p.login, { sessions: r.length });
  if (p.tg_id) await tg("sendMessage", { chat_id: p.tg_id, text: "🔑 Пароль от Senko Assistant изменён. Если это были не вы, срочно напишите владельцу памятки." }).catch(() => null);
  return { ok: true, ended: r.length };
}

// PIN при запуске забыт: программа спрашивает пароль от аккаунта и проверяет его здесь (2.2)
async function verifyPassword(b, ip) {
  const { p, err } = await who(b);
  if (err) return err;
  if (!(await hit(`vp:${p.id}`, 6, 900))) return fail(RATE_MSG, { code: "rate" });
  const [{ ok }] = await db()`select extensions.crypt(${String(b.password == null ? "" : b.password)}, ${p.pass_hash}) = ${p.pass_hash} as ok`;
  if (!ok) {
    await logIn(p.id, "fail", b, ip);
    return fail("Неверный пароль.");
  }
  return { ok: true };
}

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
    await logIn(p.id, "fail", b, ip);
    return fail("Неверный логин или пароль.");
  }
  if (p.banned) return fail(banMsg(p), { code: "banned" });
  if (p.approval && p.approval !== "ok") return fail(approvalMsg(p), { code: p.approval });
  await sql`delete from rate_limits where key = ${"lg:" + lc + ":" + ip} or key = ${"lf:" + lc}`;
  const token = await newSession(p.id, !!b.remember);
  await sql`update profiles set last_seen = now() where id = ${p.id}`;
  await noteClient(p, b);
  await logIn(p.id, "login", b, ip);
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
  const adj = await xpAdjOf(null);
  for (const id of Object.keys(adj)) if (m[id]) m[id].xp = Math.max(0, (m[id].xp || 0) + adj[id]);
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
  const full = p.rank === "owner" || p.rank === "moderator";
  const opened = (r, k) => Array.isArray(r.contacts_open) && r.contacts_open.includes(k);
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
      // руководство видит Discord, только если пользователь открыл его сам; номер и Telegram видят лишь владелец и модераторы
      discord: full || opened(r, "discord") ? r.discord : null,
      phone: full ? r.phone : null,
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
  await logIn(res.p.id, "reset", b, ip);
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
  if (b.action !== "sync" && b.action !== "xfer" && !((b.action === "ai_ask" || b.action === "panel") && raw.length <= 40000) && !(b.action === "panel" && b.op === "ads_save" && raw.length <= 700000) && !(b.action === "bug_report" && raw.length <= 700000) && !(b.action === "stt" && raw.length <= 1200000) && !(b.action === "share" && raw.length <= 40000) && raw.length > 8192) return J(fail("Слишком большой запрос."), 413);
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
      return J({ ok: true, user: pub(p), sys: await sysFor(p), web: { laws: !!LAWS_KEY, ai: !!AI_KEY } });
    }
    case "laws":
      return J(await lawsApi(b));
    case "ai_ask":
      return J(await aiAsk(b));
    case "stt":
      return J(await sttApi(b));
    case "panel":
      return J(await panelApi(b, ip, req.headers.get("user-agent") || ""));
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
    case "share":
      return J(await shareApi(b));
    case "xfer":
      return J(await xferApi(b));
    case "misses":
      return J(await missesApi(b));
    case "contacts":
      return J(await contactsApi(b));
    case "logins":
      return J(await loginsApi(b, ip));
    case "change_password":
      return J(await changePassword(b, ip));
    case "verify_password":
      return J(await verifyPassword(b, ip));
    case "ai_log":
      return J(await aiLog(b));
    case "ai_vote":
      return J(await aiVote(b));
    case "ai_dict":
      return J(await aiDictApi(b));
    case "ai_hist":
      return J(await aiHist(b));
    case "ai_check":
      return J(await aiCheck(b));
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
    case "ads":
      return J(await adsPublic(b));
    case "status":
      return J(await statusApi());
    case "beta":
      return J(await betaApi(b));
    case "hooks":
      return J(await hooksApi(b));
    case "events":
      return J(await eventsApi(b));
    case "ideas":
      return J(await ideasApi(b));
    case "patrol":
      return J(await patrolApi(b));
    default:
      return J(fail("Неизвестное действие."), 400);
  }
}

// ───────────── Этап 10: ссылки «Поделиться», перенос по коду, поиски без результата ─────────────
const SHARE_DAYS = 30; // сколько живёт ссылка на расчёт или набор
const SHARE_KINDS = { calc: "Расчёт", set: "Набор статей", board: "Тактическая доска" };
const SHARE_ID_RE = /^(uk|ak|dk)[0-9a-zа-яё.]{1,12}-[0-9a-zа-яё.]{0,6}$/i;
const XFER_MIN = 15; // сколько действует код переноса
const XFER_BYTES = 900000;
const MISS_ALERT = 5; // после стольких поисков владельцу приходит уведомление
function shortCode(n) {
  const a = new Uint8Array(n);
  crypto.getRandomValues(a);
  return [...a].map((x) => CODE_ALPH[x & 31]).join("");
}
const shareCode = (c) => normCode(c).slice(0, 12);

async function shareApi(b) {
  const { p, err } = await who(b);
  if (err) return err;
  const sql = db();
  const op = String(b.op || "");
  if (op === "create") {
    const kind = String(b.kind || "");
    if (!SHARE_KINDS[kind]) return fail("Неизвестный вид ссылки.");
    const ids = (Array.isArray(b.ids) ? b.ids : []).map((x) => clean(x, 30)).filter((x) => SHARE_ID_RE.test(x)).slice(0, 40);
    // 2.4: доска передаёт рисунок (JSON) вместо статей
    const board = kind === "board" ? String(b.data == null ? "" : b.data) : "";
    if (kind === "board" && (board.length < 10 || board.length > 30000 || !/^\{[\s\S]*\}$/.test(board))) return fail("Доска пустая или слишком большая.");
    if (!ids.length && kind !== "board") return fail("Добавьте статьи, чтобы поделиться.");
    const body = kind === "board" ? board : cleanText(b.text, 3000);
    if (!(await hit(`sh:${p.id}`, 30, 3600))) return fail(RATE_MSG, { code: "rate" });
    let code = "";
    for (let i = 0; i < 5 && !code; i++) {
      const c = shortCode(8);
      const r = await sql`insert into shares (code, kind, user_id, author, title, ids, body)
                          values (${c}, ${kind}, ${p.id}, ${p.nick || p.login}, ${clean(b.title, 80)}, ${sql.json(ids)}, ${body})
                          on conflict (code) do nothing returning code`;
      if (r.length) code = c;
    }
    if (!code) return fail("Не удалось создать ссылку. Попробуйте ещё раз.");
    await sql`delete from shares where created_at < now() - make_interval(days => ${SHARE_DAYS})`;
    return { ok: true, code, url: SELF_URL + "?s=" + code, days: SHARE_DAYS };
  }
  if (op === "get") {
    if (!(await hit(`sg:${p.id}`, 60, 3600))) return fail(RATE_MSG, { code: "rate" });
    const code = shareCode(b.code);
    const [r] = code.length === 8
      ? await sql`select * from shares where code = ${code} and created_at > now() - make_interval(days => ${SHARE_DAYS})`
      : [];
    if (!r) return fail("Ссылка не найдена или устарела: ссылки действуют " + SHARE_DAYS + " дней.");
    await sql`update shares set views = views + 1 where code = ${code}`;
    return { ok: true, share: { code, kind: r.kind, title: r.title, ids: r.ids, author: r.author, at: new Date(r.created_at).getTime(), data: r.kind === "board" ? r.body : undefined } };
  }
  return fail("Неизвестное действие.");
}

// Ссылка, открытая в браузере (или с телефона по QR-коду): простой текст расчёта
async function shareView(req, url) {
  const ip = req.headers.get("cf-connecting-ip") || (req.headers.get("x-forwarded-for") || "").split(",")[0].trim() || "unknown";
  const head = { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" };
  if (!(await hit(`sv:${ip}`, 120, 3600))) return new Response(RATE_MSG, { status: 429, headers: head });
  const code = shareCode(url.searchParams.get("s"));
  const [r] = code.length === 8
    ? await db()`select * from shares where code = ${code} and created_at > now() - make_interval(days => ${SHARE_DAYS})`
    : [];
  if (!r) return new Response("Senko Assistant\n\nСсылка не найдена или устарела: ссылки действуют " + SHARE_DAYS + " дней.", { status: 404, headers: head });
  await db()`update shares set views = views + 1 where code = ${code}`;
  const t = `Senko Assistant · ${SHARE_KINDS[r.kind] || "Ссылка"}${r.title ? ": " + r.title : ""}\nОт: ${r.author} · ${fmtDate(r.created_at)}\n\n${r.kind === "board" ? "Схема на карте зон: откройте её в программе." : r.body || ""}\n\n` +
    `Открыть в программе: скопируйте эту ссылку и вставьте в строку поиска Senko Assistant.\nКод: ${code}`;
  return new Response(t, { status: 200, headers: head });
}

// Перенос всех данных на другой компьютер того же аккаунта: код из 6 цифр, действует 15 минут, срабатывает один раз
async function xferApi(b) {
  const { p, err } = await who(b);
  if (err) return err;
  const sql = db();
  const op = String(b.op || "");
  if (op === "put") {
    if (!(await hit(`xp:${p.id}`, 10, 3600))) return fail(RATE_MSG, { code: "rate" });
    const json = JSON.stringify(b.data === undefined ? null : b.data);
    if (!b.data || typeof b.data !== "object" || Array.isArray(b.data)) return fail("Нет данных для переноса.");
    if (json.length > XFER_BYTES) return fail("Данных слишком много для переноса по коду. Сохраните их в файл (Настройки → Данные).");
    const a = new Uint32Array(1);
    crypto.getRandomValues(a);
    const code = String(100000 + (a[0] % 900000));
    await sql`delete from transfers where expires_at < now()`;
    await sql`insert into transfers (user_id, code, data, expires_at) values (${p.id}, ${code}, ${json}::text::jsonb, now() + make_interval(mins => ${XFER_MIN}))
              on conflict (user_id) do update set code = excluded.code, data = excluded.data, created_at = now(), expires_at = excluded.expires_at`;
    return { ok: true, code, min: XFER_MIN };
  }
  if (op === "get") {
    if (!(await hit(`xg:${p.id}`, 10, 900))) return fail(RATE_MSG, { code: "rate" });
    const code = String(b.code || "").replace(/\D/g, "");
    if (code.length !== 6) return fail("Введите код из 6 цифр.");
    const [r] = await sql`delete from transfers where user_id = ${p.id} and code = ${code} and expires_at > now() returning data, created_at`;
    if (!r) return fail("Код не подошёл или устарел. Получите новый код на другом компьютере, войдя в тот же аккаунт.");
    return { ok: true, data: r.data, at: new Date(r.created_at).getTime() };
  }
  if (op === "cancel") {
    await sql`delete from transfers where user_id = ${p.id}`;
    return { ok: true };
  }
  return fail("Неизвестное действие.");
}

// Поиски без результата: какие слова ищут и не находят (без логина и ника, только текст запроса и счётчик)
async function missesApi(b) {
  const { p, err } = await who(b);
  if (err) return err;
  if (!(await hit(`ms:${p.id}`, 6, 3600))) return { ok: true, accepted: 0 };
  const sql = db();
  let n = 0;
  const alerts = [];
  for (const it of (Array.isArray(b.items) ? b.items : []).slice(0, 30)) {
    const q = clean(it && it.q, 60).toLowerCase();
    const c = Math.min(50, Math.max(1, parseInt(it && it.n, 10) || 1));
    if (q.length < 2) continue;
    const [r] = await sql`insert into search_misses (q, n, sends, first_at, last_at) values (${q}, ${c}, 1, now(), now())
                          on conflict (q) do update set n = search_misses.n + excluded.n, sends = search_misses.sends + 1, last_at = now()
                          returning n`;
    if (r && r.n >= MISS_ALERT && r.n - c < MISS_ALERT) alerts.push(`«${esc(q)}» (${r.n})`);
    n++;
  }
  if (alerts.length) {
    try {
      await quiet(`🔎 Часто ищут и не находят: ${alerts.join(", ")}. Список: /misses`);
    } catch (e) {}
  }
  return { ok: true, accepted: n };
}

// ───────────── 2.2: спецсвязи видны руководству только по желанию пользователя ─────────────
const CONTACT_KEYS = ["discord"]; // руководству можно открыть только Discord
async function contactsApi(b) {
  const { p, err } = await who(b);
  if (err) return err;
  if (b.op === "set") {
    const open = (Array.isArray(b.open) ? b.open : []).map(String).filter((k, i, a) => CONTACT_KEYS.includes(k) && a.indexOf(k) === i);
    await db()`update profiles set contacts_open = ${open} where id = ${p.id}`;
    return { ok: true, open };
  }
  return { ok: true, open: Array.isArray(p.contacts_open) ? p.contacts_open : [] };
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
  const flags = await flagsNow();
  const events = flags.events === "off" ? [] : (await eventsFor(p.org, 14)).slice(0, 5).map((e) => evOut(e, p));
  return {
    flags,
    tester: isTester(p),
    events,
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

// Версия программы; сайт присылает «web …» и версию программы не перезаписывает
function appVer(b) {
  const v = clean(b && b.ver, 20);
  return /^web/i.test(v) ? "" : v;
}
// Версия программы и устройство: версия для /versions, новое устройство у руководства — уведомление владельцу
async function noteClient(p, b) {
  const ver = appVer(b);
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
  // 2.2: журнал программы (версии, состояние, хвост updater.log) приходит владельцу отдельным файлом
  const log = String(b.log == null ? "" : b.log).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ").slice(0, 60000);
  const [r] = await db()`insert into bug_reports (user_id, text, app_version, log) values (${p.id}, ${text}, ${ver}, ${log}) returning id`;
  if (OWNER_TG) {
    await send(OWNER_TG, `🐞 <b>Сообщение об ошибке #${r.id}</b>\nОт: <code>${esc(p.login)}</code> · ${esc(p.nick)} · ${esc(p.org)}\nВерсия: ${esc(ver || "—")}${log ? "\n📎 Журнал во вложении" : ""}\n\n${esc(text)}`, {
      reply_markup: { inline_keyboard: [[{ text: "✉️ Ответить", callback_data: `bg:${r.id}` }]] },
    });
    if (log) await sendFile(OWNER_TG, `bug-${r.id}-log.txt`, log, `📎 Журнал к сообщению #${r.id}`, "text/plain");
    // 2.4: скриншот окна программы (тестеры и все, кто поставил галочку)
    const m = /^data:image\/(jpeg|png);base64,([A-Za-z0-9+/=]{100,})$/.exec(String(b.shot || ""));
    if (m && m[2].length <= 680000) await sendPhoto(OWNER_TG, Uint8Array.from(atob(m[2]), (c) => c.charCodeAt(0)), `bug-${r.id}.${m[1] === "png" ? "png" : "jpg"}`, `📷 Скриншот к сообщению #${r.id}${p.beta ? " · 🧪 тестер" : ""}`);
  }
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
  const ms = await sql`select q, n from search_misses where last_at > now() - interval '1 day' order by n desc limit 5`.catch(() => []);
  const msTxt = ms.length ? "\nЧасто ищут без результата: " + ms.map((r) => `«${esc(r.q)}» (${r.n})`).join(", ") + " (/misses)" : "";
  return `🗓 <b>Сводка за сутки</b>\nРегистраций: ${t.reg}\nАктивных: ${t.active}\nЗаблокировано всего: ${t.banned}\nЗапросов на сброс пароля: ${r.n}${r.pending ? " (ждут: " + r.pending + ")" : ""}\nСообщений об ошибках: ${bg.n}${bg.open ? " (без ответа: " + bg.open + ")" : ""}\nВопросов к ИИ: ${ai.n}${ai.n ? " (👍 " + ai.up + ", 👎 " + ai.down + ")" : ""}${pd.n ? "\nЗаявок ждут подтверждения: " + pd.n + " (/pending)" : ""}${msTxt}\n\nВсего пользователей: ${t.total}`;
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
async function sendFile(chat, name, text, caption, type = "application/json") {
  if (String(chat).startsWith("panel:")) {
    const out = PANEL_OUT.get(String(chat));
    if (out) out.push({ t: "file", name, text, caption: String(caption || ""), type });
    return { ok: true };
  }
  if (!BOT_TOKEN) return null;
  const fd = new FormData();
  fd.append("chat_id", String(chat));
  fd.append("caption", caption);
  fd.append("parse_mode", "HTML");
  fd.append("document", new Blob([text], { type }), name);
  try {
    const r = await fetch(`${TG_API}/bot${BOT_TOKEN}/sendDocument`, { method: "POST", body: fd, signal: AbortSignal.timeout(30000) });
    return await r.json();
  } catch (e) {
    console.error("telegram sendDocument", String(e).split(BOT_TOKEN).join("***"));
    return null;
  }
}

async function sendPhoto(chat, bytes, name, caption) {
  if (!BOT_TOKEN) return null;
  const fd = new FormData();
  fd.append("chat_id", String(chat));
  fd.append("caption", caption);
  fd.append("parse_mode", "HTML");
  fd.append("photo", new Blob([bytes], { type: /png$/.test(name) ? "image/png" : "image/jpeg" }), name);
  try {
    const r = await fetch(`${TG_API}/bot${BOT_TOKEN}/sendPhoto`, { method: "POST", body: fd, signal: AbortSignal.timeout(30000) });
    return await r.json();
  } catch (e) {
    console.error("telegram sendPhoto", String(e).split(BOT_TOKEN).join("***"));
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
// 2.6.3: особые достижения, которые владелец создаёт в панели (bot_settings «achx»: код → значок, название, описание)
const achAll = async () => ({ ...(await getSetting("achx", {})), ...ACH_BY });

// 2.6.3: поправка опыта из панели владельца. Опыт = опыт из программы (синхронизация берёт большее значение) + поправка,
// поэтому опыт можно и уменьшить: программа не «перебьёт» поправку своим числом
let xpAdjReady = null;
function ensureXpAdj() {
  if (!xpAdjReady)
    xpAdjReady = (async () => {
      const sql = db();
      const cols = await sql`select column_name c from information_schema.columns where table_schema = 'public' and table_name = 'profiles' and column_name in ('xp_adj', 'ai_bonus')`;
      const has = new Set(cols.map((r) => r.c));
      if (!has.has("xp_adj")) await sql.unsafe("alter table public.profiles add column if not exists xp_adj integer not null default 0");
      // 2.6.6: дополнительные запросы к ИИ сверх дневного лимита (выдаёт владелец в панели)
      if (!has.has("ai_bonus")) await sql.unsafe("alter table public.profiles add column if not exists ai_bonus integer not null default 0");
    })().catch((e) => {
      xpAdjReady = null;
      throw e;
    });
  return xpAdjReady;
}
// ids = null — все пользователи с поправкой
async function xpAdjOf(ids) {
  try {
    await ensureXpAdj();
    const sql = db();
    const rows = ids
      ? await sql`select id, xp_adj from profiles where xp_adj <> 0 and id = any(${ids}::uuid[])`
      : await sql`select id, xp_adj from profiles where xp_adj <> 0`;
    return Object.fromEntries(rows.map((r) => [r.id, r.xp_adj]));
  } catch (e) {
    console.error("xp_adj", e);
    return {};
  }
}

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
  const ADJ = await xpAdjOf(ids);
  const X = {}, B0 = {}, B1 = {}, AC = {}, AN = {};
  xs.forEach((r) => (X[r.user_id] = r.xp));
  bs.forEach((r) => ((r.week === w.key ? B0 : B1)[r.user_id] = r.base));
  act.forEach((r) => (AC[r.user_id] = r));
  ach.forEach((r) => (AN[r.user_id] = r.n));
  return people.map((p) => {
    const sx = X[p.id] || 0, xp = Math.max(0, sx + (ADJ[p.id] || 0)); // опыт за неделю — только заработанный в программе
    const top = full ? (B1[p.id] != null ? B1[p.id] : sx) : sx;
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
  s.xp = Math.max(0, s.xp + ((await xpAdjOf([p.id]))[p.id] || 0));
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
  const xpAdj = (await xpAdjOf([p.id]))[p.id] || 0;
  xp = Math.max(0, xp + xpAdj);
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
  const AX = await getSetting("achx", {});
  const custom = Object.keys(G).filter((c) => !ACH_BY[c] && AX[c]).map((c) => ({ code: c, icon: AX[c].icon, name: AX[c].name, desc: AX[c].desc, rare: true, at: G[c] }));
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
    xp, xpAdj, level: lvOf(xp), streak, det, det7,
    tests: tests.length,
    avg_p: last.length ? Math.round(last.reduce((s, t) => s + t.p, 0) / last.length) : null,
    weak,
    ach: ACH.map((x) => ({ code: x.code, icon: x.icon, name: x.name, desc: x.desc, rare: !!x.rare, at: G[x.code] || null })).concat(custom),
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
    await postHook(org, "ctrl", "📋 Контрольный тест: " + title, `Вопросов: ${n}, срок: ${days} дн. Пройти можно в программе: сверху появится плашка с кнопкой «Пройти».\nНазначил(а): ${esc(p.nick || p.login)}`, 0x7c3aed);
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
  sup: "Заключение прокурора",
  def: "Жалоба адвоката",
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
  await postHook(r.org, "rep", `📝 Рапорт №${r.id}: ${r.title}`, rpText(r, 1500), 0xc2530e);
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
      // формы прокурора и адвоката только для Government, как и в программе
      if ((kind === "sup" || kind === "def") && p.org !== GOV_ORG) return fail("Эта форма доступна только сотрудникам Government.");
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
  let hooks = [];
  try {
    hooks = (await db()`select org from org_hooks where 'week' = any(events)`).map((h) => h.org);
  } catch (e) {}
  hooks.forEach((o) => (by[o] = by[o] || []));
  let n = 0;
  for (const org of Object.keys(by)) {
    const t = await orgReport(org);
    if (!t) continue;
    if (hooks.includes(org)) {
      const nl = t.indexOf("\n");
      await postHook(org, "week", t.slice(0, nl).replace(/<[^>]+>/g, ""), t.slice(nl + 1), 0xff8a3d);
    }
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
  const refs = (Array.isArray(b.refs) ? b.refs : []).slice(0, 10).map((r) => clean(r, 120)).filter(Boolean); // 2.6.4: до 120 знаков, иначе номер статьи закона обрезался
  const ok = b.ok !== false;
  const ans = String(b.ans == null ? "" : b.ans).slice(0, 4000); // 2.7: ответ ИИ нужен для разбора плохих ответов в панели
  const [r] = await db()`insert into ai_log (user_id, q, refs, ok, ans) values (${p.id}, ${q}, ${refs}, ${ok}, ${ans}) returning id`;
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

// ───────────── 2.7: словарь «бытовое слово → статья», самопроверка ИИ и история вопросов ─────────────
// Словарь ведёт владелец в панели. Программа скачивает его и ставит указанные статьи первыми, если в вопросе есть все слова фразы.
const AI_KIND = { "ук": "uk", "ак": "ak", "дк": "dk", "пк": "pk", uk: "uk", ak: "ak", dk: "dk", pk: "pk" };
const AI_KN = { uk: "УК", ak: "АК", dk: "ДК", pk: "ПК" };
// «УК 10.5, АК ст. 3» → ["uk|10.5", "ak|3"]
function aiRefKeys(v) {
  const out = [];
  String(Array.isArray(v) ? v.join(",") : v == null ? "" : v).toLowerCase().split(/[,;\n]+/).forEach((part) => {
    const m = /(ук|ак|дк|пк|uk|ak|dk|pk)\s*(?:\||ст\.?|статья|статьи)?\s*(\d{1,3}(?:\.\d{1,3}){0,3})/.exec(part.trim());
    if (m) { const k = AI_KIND[m[1]] + "|" + m[2]; if (!out.includes(k)) out.push(k); }
  });
  return out.slice(0, 6);
}
const aiRefLabel = (k) => { const [kind, code] = String(k || "").split("|"); return AI_KN[kind] ? AI_KN[kind] + " " + code : String(k || "").replace(/^law:/, ""); };
let aiDictCache = null;
async function aiDictRows() {
  if (aiDictCache && Date.now() - aiDictCache.at < 60e3) return aiDictCache.rows;
  const rows = await db()`select id, phrase, refs, note, author, created_at from ai_dict order by id`;
  aiDictCache = { at: Date.now(), rows };
  return rows;
}
async function aiDictApi(b) {
  const { err } = await who(b);
  if (err) return err;
  const rows = await aiDictRows();
  return { ok: true, items: rows.map((r) => ({ p: r.phrase, r: r.refs })) };
}
// история: свои вопросы за последние 90 дней (столько хранится журнал)
async function aiHist(b) {
  const { p, err } = await who(b);
  if (err) return err;
  const rows = await db()`select id, q, vote, ok, at from ai_log where user_id = ${p.id} order by at desc limit 150`;
  return { ok: true, rows: rows.map((r) => ({ id: String(r.id), q: r.q, vote: r.vote, ok: r.ok, at: r.at })) };
}
const AI_GOLD_DEFAULT = [
  "убил человека", "оружие без лицензии", "полицейский избил гражданского", "что такое законное требование", "что такое процессуальный час",
  "угнал машину", "сколько можно держать задержанного", "штраф за превышение скорости", "ходил в маске", "не подчинился полицейскому",
  "дал взятку полицейскому", "оскорбил сотрудника полиции", "проехал на красный свет", "похитил человека", "хранение наркотиков",
  "можно ли обыскать без ордера", "напал на сотрудника полиции", "ложный вызов полиции", "сколько ждать адвоката", "залез на охраняемую территорию",
];
async function aiGoldRows() {
  const sql = db();
  let rows = await sql`select * from ai_gold order by id`;
  if (!rows.length && !(await getSetting("aigold_seeded", false))) {
    for (const q of AI_GOLD_DEFAULT) await sql`insert into ai_gold (q) values (${q})`;
    await setSetting("aigold_seeded", true);
    rows = await sql`select * from ai_gold order by id`;
  }
  return rows;
}
const dayUtc = () => new Date().toISOString().slice(0, 10);
// Самопроверка: подбор статей работает в программе, поэтому раз в день его запускает программа владельца или модератора.
// Сервер сравнивает первую статью с прошлым разом (и с закреплённой, если она задана) и пишет владельцу, если что-то поменялось.
async function aiCheck(b) {
  const { p, err } = await who(b, ["owner", "moderator"]);
  if (err) return err;
  const sql = db();
  const st = (await getSetting("aicheck", {})) || {};
  if (b.op === "list") {
    const rows = await aiGoldRows();
    return { ok: true, due: st.day !== dayUtc(), items: rows.map((r) => ({ id: String(r.id), q: r.q })) };
  }
  if (b.op !== "report") return fail("Неизвестное действие.");
  if (st.day === dayUtc() && !b.force) return { ok: true, skipped: true };
  const res = (Array.isArray(b.res) ? b.res : []).slice(0, 60);
  const rows = await aiGoldRows();
  const byId = new Map(rows.map((r) => [String(r.id), r]));
  const changed = [];
  let n = 0;
  for (const x of res) {
    const r = byId.get(String(x && x.id));
    if (!r) continue;
    n++;
    const top = clean(x.top, 160), label = clean(x.ref, 160);
    if ((r.last && r.last !== top) || (r.expect && r.expect !== top)) changed.push({ q: r.q, was: r.last_ref || aiRefLabel(r.last) || "—", now: label || aiRefLabel(top) || "ничего не найдено", expect: r.expect });
    await sql`update ai_gold set prev = last, prev_ref = last_ref, last = ${top}, last_ref = ${label}, checked_at = now() where id = ${r.id}`;
  }
  await setSetting("aicheck", { day: dayUtc(), at: Date.now(), by: p.login, n, changed: changed.length, ver: clean(b.ver, 30) });
  if (changed.length && OWNER_TG)
    await send(OWNER_TG, `🧪 <b>Самопроверка ИИ</b>: первая статья поменялась в ${changed.length} из ${n} вопросов\n` +
      changed.slice(0, 15).map((c) => `• «${esc(c.q)}»: было ${esc(c.was)}, стало ${esc(c.now)}${c.expect && c.expect !== c.now ? ` (закреплена ${esc(aiRefLabel(c.expect))})` : ""}`).join("\n") +
      `\n\nЗапуск: ${esc(p.login)}. Подробности — в панели, раздел «ИИ-помощник».`, { disable_notification: true });
  return { ok: true, n, changed: changed.length };
}
// панель владельца: словарь, плохие ответы, эталонные вопросы
async function panelAi(b, a) {
  const sql = db();
  const op = b.op;
  if (op === "ai_dict_list") return { ok: true, rows: await sql`select * from ai_dict order by id desc` };
  if (op === "ai_dict_save") {
    const phrase = String(b.phrase == null ? "" : b.phrase).replace(/\s+/g, " ").trim().toLowerCase().slice(0, 80);
    const refs = aiRefKeys(b.refs);
    const note = clean(b.note, 200);
    if (phrase.length < 3) return fail("Фраза: от 3 символов, например «угнал тачку».");
    if (!refs.length) return fail("Статьи: например «УК 10.5» или «УК 10.5, АК 3».");
    const id = parseInt(b.id, 10) || 0;
    const [r] = id
      ? await sql`update ai_dict set phrase = ${phrase}, refs = ${refs}, note = ${note}, author = ${a.label} where id = ${id} returning *`
      : await sql`insert into ai_dict (phrase, refs, note, author) values (${phrase}, ${refs}, ${note}, ${a.label}) returning *`;
    if (!r) return fail("Запись не найдена.");
    aiDictCache = null;
    await audit(a.label, "ai_dict", phrase, { refs, id: r.id, edit: !!id });
    return { ok: true, row: r };
  }
  if (op === "ai_dict_delete") {
    const [r] = await sql`delete from ai_dict where id = ${parseInt(b.id, 10) || 0} returning *`;
    if (!r) return fail("Запись не найдена.");
    aiDictCache = null;
    await audit(a.label, "ai_dict", r.phrase, { deleted: true, refs: r.refs });
    return { ok: true };
  }
  if (op === "ai_bad") {
    const days = Math.max(1, Math.min(90, parseInt(b.days, 10) || 30));
    const rows = await sql`select l.id, l.q, l.refs, l.ans, l.ok, l.at, p.login, p.org from ai_log l left join profiles p on p.id = l.user_id
                           where l.vote < 0 and l.at > now() - make_interval(days => ${days}) order by l.at desc limit 100`;
    return { ok: true, rows, days };
  }
  if (op === "ai_gold_list") return { ok: true, rows: await aiGoldRows(), last: (await getSetting("aicheck", {})) || {} };
  if (op === "ai_gold_save") {
    const q = String(b.q == null ? "" : b.q).replace(/\s+/g, " ").trim().slice(0, 300);
    if (q.length < 3) return fail("Вопрос: от 3 символов.");
    const exp = b.expect == null || b.expect === "" ? "" : aiRefKeys(b.expect)[0] || "";
    if (b.expect && !exp) return fail("Ожидаемая статья: например «УК 6.1».");
    const id = parseInt(b.id, 10) || 0;
    const [r] = id
      ? await sql`update ai_gold set q = ${q}, expect = ${exp} where id = ${id} returning *`
      : await sql`insert into ai_gold (q, expect) values (${q}, ${exp}) returning *`;
    if (!r) return fail("Вопрос не найден.");
    await audit(a.label, "ai_gold", q, { expect: exp, edit: !!id });
    return { ok: true, row: r };
  }
  if (op === "ai_gold_delete") {
    const [r] = await sql`delete from ai_gold where id = ${parseInt(b.id, 10) || 0} returning *`;
    if (!r) return fail("Вопрос не найден.");
    await audit(a.label, "ai_gold", r.q, { deleted: true });
    return { ok: true };
  }
  if (op === "ai_gold_pin") {
    // закрепить текущий результат как правильный (у одного вопроса или у всех)
    const id = parseInt(b.id, 10) || 0;
    const rows = id ? await sql`update ai_gold set expect = last where id = ${id} and last <> '' returning id`
      : await sql`update ai_gold set expect = last where last <> '' returning id`;
    await audit(a.label, "ai_gold", id ? String(id) : "все", { pin: true, n: rows.length });
    return { ok: true, n: rows.length };
  }
  if (op === "ai_gold_run") {
    // следующий запуск программы владельца или модератора проверит заново
    const st = (await getSetting("aicheck", {})) || {};
    await setSetting("aicheck", { ...st, day: "" });
    return { ok: true };
  }
  return fail("Неизвестное действие панели.");
}
async function flagFor(p, k) {
  const m = (await flagsNow())[k];
  return m === "all" || (m === "beta" && isTester(p));
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
  "/beta &lt;логин&gt; on|off — роль «Бета-тестер»; /beta list — все тестеры\n" +
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
  "/in &lt;срок&gt; &lt;команда&gt; — выполнить команду позже, например /in 2h unban cop1; /jobs — список\n" +
  "/misses [дней] — что ищут в программе и не находят (по умолчанию за 7 дней); /misses del &lt;запрос&gt;|all — очистить\n" +
  "/panel — пароль для панели на сайте; /panel off — отключить вход в панель\n";
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
  "/ailog [дней|on|off] — вопросы к ИИ-помощнику и оценки ответов\n" +
  "/panel &lt;логин&gt; — пароль панели для модератора; /panel off &lt;логин&gt; — закрыть ему вход\n";
const AUDIT_ACTIONS = [
  "ban", "unban", "tempban", "tempban_end", "autoban", "warn", "unwarn", "kick", "note", "tag", "untag",
  "role", "rename", "setstatic", "setorg", "delete", "profile_update", "password_reset", "reset_approve", "reset_reject",
  "broadcast", "maintenance", "regs", "reglimit", "blacklist", "appeal", "delay", "backup", "laws",
  "approve", "reject", "approval", "shift_start", "shift_end", "ctrl_create", "sync_reset",
  "report_create", "report_delete", "report_review",
  "panel_login", "panel_key", "panel_revoke", "db_edit", "db_delete", "db_revert",
  "ad_save", "ad_toggle", "ad_delete",
  "beta", "beta_task", "flags", "hook", "event", "idea",
  "xp_set", "ach_grant", "ach_revoke", "ach_custom", "ai_bonus", "ai_dict", "ai_gold",
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
  const AA = ach.length ? await achAll() : {};
  if (ach.length) t += `\n🏆 Достижения: ${ach.map((x) => AA[x.code]).filter(Boolean).map((x) => x.icon + " " + x.name).join(", ")}`;
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
  const a = m.panelActor || (await actorOf(m.from.id));
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
  const a = m.panelActor || (await actorOf(m.from.id)); // panelActor — команда из панели на сайте
  const sql = db();

  if (cmd === "start" || cmd === "id" || cmd === "whoami") {
    return send(
      chat,
      `Senko Assistant.\nВаш Telegram ID: <code>${m.from.id}</code>\n` +
        (a ? `Доступ: ${a.kind === "owner" ? "владелец" : a.kind === "leader" ? "руководство " + esc(a.profile.org) : "модератор памятки"}. Команды: /help` : "Команды вам недоступны. Если вы модератор, сообщите этот ID владельцу.") +
        "\n\n📖 Статьи кодексов в любом чате: наберите в строке сообщения имя бота через @ и номер статьи или слова, например <code>12.8</code>, <code>ак 2.1</code> или <code>оружие</code>, и выберите статью из списка."
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

    case "beta": {
      if (args[0] === "list" || !args[0]) {
        const rows = await sql`select login, nick, org from profiles where beta order by login_lc limit 100`;
        return send(chat, rows.length ? `🧪 <b>Бета-тестеры: ${rows.length}</b>\n` + rows.map((r) => `• <code>${esc(r.login)}</code> — ${esc(r.nick)} · ${esc(r.org)}`).join("\n") + "\n\nВыдать: /beta &lt;логин&gt; on, забрать: /beta &lt;логин&gt; off" : "Бета-тестеров пока нет. Выдать роль: /beta &lt;логин&gt; on");
      }
      const p = await target("/beta &lt;логин&gt; on|off");
      if (!p) return;
      const on = !/^(off|нет|0|выкл)/i.test(String(args[1] || "on"));
      await setBeta(a, p, on);
      return send(chat, on ? `🧪 ${esc(p.login)} теперь бета-тестер. В программе появится «Панель тестера» (после перезапуска или в течение 20 минут).` : `${esc(p.login)} больше не бета-тестер.`);
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
      if (rank === "moderator" && !tgArg && p.tg_id == null && !a.panel)
        return send(chat, "Для модератора нужен его Telegram ID: /role " + esc(p.login) + " moderator 123456789\nID покажет бот в ответ на /start, пусть модератор напишет боту.");
      const tgNew = rank === "user" ? null : tgArg ? tgArg : p.tg_id == null ? null : String(p.tg_id);
      return askConfirm(chat, a, "role", { id: p.id, rank, tg: tgNew }, `Выдать <b>${esc(p.login)}</b> роль: ${RANKS[p.rank]} → <b>${RANKS[rank]}</b>?${tgNew ? `\nTelegram ID: <code>${tgNew}</code>` : rank === "moderator" ? "\nБез Telegram ID модератор работает только в панели на сайте." : ""}`);
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

    case "misses": {
      const v = String(args[0] || "").toLowerCase();
      if (v === "del") {
        if (!owner) return ownerOnly();
        const q = clean(args.slice(1).join(" "), 60).toLowerCase();
        if (!q) return send(chat, "Использование: /misses del &lt;запрос&gt; или /misses del all");
        const r = q === "all" ? await sql`delete from search_misses returning 1` : await sql`delete from search_misses where q = ${q} returning 1`;
        return send(chat, r.length ? `✅ Удалено записей: ${r.length}.` : "Такого запроса в списке нет.");
      }
      const days = Math.min(365, Math.max(1, parseInt(v, 10) || 7));
      const rows = await sql`select q, n, sends, last_at from search_misses where last_at > now() - make_interval(days => ${days}) order by n desc, last_at desc limit 30`;
      if (!rows.length) return send(chat, `За ${days} дн. поисков без результата нет.`);
      return send(chat, `🔎 <b>Ищут и не находят</b> (за ${days} дн.)\n` + rows.map((r, i) => `${i + 1}. «${esc(r.q)}» — ${r.n} ${plural(r.n, "раз", "раза", "раз")}${r.sends > 1 ? ", из " + r.sends + " " + plural(r.sends, "программы", "программ", "программ") : ""}`).join("\n") +
        "\n\nЧасто встречающиеся запросы стоит добавить в синонимы поиска.");
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
      if (!/^\d+$/.test(a.tg)) return send(chat, "Отложенные команды работают только у тех, к кому привязан Telegram: результат приходит туда.");
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

    case "panel":
      return panelCmd(chat, a, args);

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
  const a = cb.panelActor || (cb.from ? await actorOf(cb.from.id) : null);
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
    else if (u.inline_query) await onInline(u.inline_query);
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
  try {
    await eventReminders();
  } catch (e) {
    console.error("events", e);
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

// ───────────── 2.4.1: inline-режим бота ─────────────
// В любом чате: «@бот 12.8», «@бот ак 2.1», «@бот оружие» → статья кодекса уходит в чат сообщением.
// Кодексы берутся из app/index.html репозитория (те же массивы UK_RAW, AK_RAW, DK_RAW, PK, что в программе),
// копия держится в памяти функции 30 минут. В BotFather у бота должен быть включён /setinline.
const CODES_URL = Deno.env.get("CODES_URL") || "https://raw.githubusercontent.com/Kofemanchik/Senko-Assistant/main/app/index.html";
const KIND_NAME = { uk: "УК", ak: "АК", dk: "ДК", pk: "ПК" };
const KIND_FULL = { uk: "Уголовный кодекс", ak: "Административный кодекс", dk: "Дорожный кодекс", pk: "Процессуальный кодекс" };
let codesCache = null; // { at, arts: [{ k, code, title, parts: [...] }] }
function codesArr(html, name) {
  const re = new RegExp("\\bvar " + name + " = \\(?\\[");
  const m = re.exec(html);
  if (!m) throw new Error("нет массива " + name);
  const start = m.index + m[0].length - 1;
  // массив заканчивается первой строкой «]» или «]])»: внутри строк скобки экранированы JSON-строками
  let depth = 0, inStr = false, i = start;
  for (; i < html.length; i++) {
    const c = html[i];
    if (inStr) { if (c === "\\") i++; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true;
    else if (c === "[") depth++;
    else if (c === "]" && --depth === 0) break;
  }
  return JSON.parse(html.slice(start, i + 1).replace(/,\s*\]/g, "]"));
}
function codesParse(html) {
  const rows = [];
  for (const l of codesArr(html, "UK_RAW")) { const a = l.split("|"); rows.push({ k: "uk", code: a[0], title: a[1], part: a[2], stars: +a[3] || 0, m: +a[4] || 0, fmin: +a[5] || 0, fmax: +a[6] || 0, rec: a[7] === "1", note: a[8] || "" }); }
  for (const l of codesArr(html, "AK_RAW")) { const a = l.split("|"); rows.push({ k: "ak", code: a[0], title: a[1], part: a[2], fmin: +a[3] || 0, fmax: +a[4] || 0, note: a[5] || "" }); }
  for (const l of codesArr(html, "DK_RAW")) { const a = l.split("|"); rows.push({ k: "dk", code: a[0], title: a[1], part: a[2], fmax: +a[3] || 0, x: a[4] || "", note: a[5] || "" }); }
  for (const a of codesArr(html, "PK")) rows.push({ k: "pk", code: a[0], part: a[1], title: a[2], note: a[3] || "" });
  const map = new Map();
  for (const r of rows) {
    const id = r.k + ":" + r.code;
    if (!map.has(id)) map.set(id, { k: r.k, code: r.code, title: r.title, parts: [] });
    map.get(id).parts.push(r);
  }
  return [...map.values()];
}
async function codesLoad() {
  if (codesCache && Date.now() - codesCache.at < 30 * 60e3) return codesCache.arts;
  try {
    const r = await fetch(CODES_URL + "?t=" + Math.floor(Date.now() / 600e3), { signal: AbortSignal.timeout(20000) });
    if (!r.ok) throw new Error("GitHub вернул " + r.status);
    const arts = codesParse(await r.text());
    if (arts.length < 50) throw new Error("мало статей: " + arts.length);
    codesCache = { at: Date.now(), arts };
  } catch (e) {
    console.error("codes", e);
    if (!codesCache) throw e;
    codesCache.at = Date.now() - 25 * 60e3; // старая копия, повторим через 5 минут
  }
  return codesCache.arts;
}
const money = (n) => "$" + String(Math.round(n || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, " ");
function codesChips(p) {
  const c = [];
  if (p.stars) c.push(p.stars + "★");
  if (p.m) c.push("до " + p.m + " мес.");
  if (p.fmin && p.fmax && p.fmin !== p.fmax) c.push("штраф " + money(p.fmin) + "–" + money(p.fmax));
  else if (p.fmax || p.fmin) c.push("штраф " + money(p.fmax || p.fmin));
  if (p.x) c.push(p.x);
  if (p.rec) c.push("судимость");
  return c;
}
function codesText(a) {
  const head = `<b>${KIND_NAME[a.k]} ст. ${esc(a.code)} · ${esc(a.title)}</b>`;
  const body = a.parts.map((p) => {
    const chips = codesChips(p);
    const pn = p.part ? "ч." + p.part : a.parts.length > 1 ? "ч.1" : "";
    return (pn ? `<b>${pn}</b> ` : "") + esc(p.note) + (chips.length ? `\n<i>${esc(chips.join(" · "))}</i>` : "");
  }).filter((x) => x.trim()).join("\n\n");
  let t = head + (body ? "\n\n" + body : "") + `\n\n<i>${KIND_FULL[a.k]} · Senko Assistant</i>`;
  if (t.length > 4000) t = head + "\n\n" + esc(a.parts.map((p) => (p.part ? "ч." + p.part + " " : "") + p.note).join("\n").slice(0, 3600)) + "…\n\n<i>Полный текст в программе Senko Assistant</i>";
  return t;
}
const INLINE_KIND = { "ук": "uk", "uk": "uk", "ак": "ak", "ak": "ak", "коап": "ak", "дк": "dk", "dk": "dk", "пдд": "dk", "пк": "pk", "pk": "pk", "упк": "pk" };
function codesSearch(arts, q) {
  q = String(q || "").toLowerCase().replace(/ё/g, "е").replace(/[«»"']/g, " ").replace(/\s+/g, " ").trim();
  let kind = "";
  q = q.replace(/(^|\s)(ук|uk|ак|ak|коап|дк|dk|пдд|пк|pk|упк)(?=\s|$|\d)/, (m, sp, k) => { kind = INLINE_KIND[k]; return " "; }).replace(/(^|\s)(ст\.?|статья|статьи)(?=\s|\d|$)/g, " ").replace(/\s+/g, " ").trim();
  const pool = kind ? arts.filter((a) => a.k === kind) : arts;
  const num = /^(\d+(?:\.\d+)*)\.?$/.exec(q);
  if (num) {
    const n = num[1];
    const exact = pool.filter((a) => a.code === n);
    const more = pool.filter((a) => a.code !== n && a.code.startsWith(n + "."));
    return exact.concat(more).sort((x, y) => (x.code === n ? 0 : 1) - (y.code === n ? 0 : 1) || Object.keys(KIND_NAME).indexOf(x.k) - Object.keys(KIND_NAME).indexOf(y.k));
  }
  const words = q.split(" ").filter((w) => w.length >= 2).map((w) => (w.length >= 5 ? w.slice(0, w.length - (w.length >= 7 ? 2 : 1)) : w)); // грубое окончание: «маска» находит «маске»
  if (!words.length) return [];
  const scored = [];
  for (const a of pool) {
    const title = a.title.toLowerCase().replace(/ё/g, "е");
    const all = title + " " + a.parts.map((p) => p.note).join(" ").toLowerCase().replace(/ё/g, "е");
    if (!words.every((w) => all.includes(w))) continue;
    scored.push({ a, s: words.filter((w) => title.includes(w)).length * 10 + (a.k === "uk" ? 2 : a.k === "ak" ? 1 : 0) });
  }
  return scored.sort((x, y) => y.s - x.s).map((x) => x.a);
}
async function onInline(iq) {
  const answer = (results, extra) => tg("answerInlineQuery", { inline_query_id: iq.id, results, cache_time: 300, ...(extra || {}) });
  const q = String(iq.query || "").slice(0, 100);
  if (!(await hit(`inl:${iq.from && iq.from.id}`, 120, 600))) return answer([], { cache_time: 30 });
  if (q.trim().length < 1)
    return answer([], { cache_time: 3600, button: { text: "Напишите номер статьи или слова: 12.8, ак 2.1, оружие", start_parameter: "inline" } });
  let arts;
  try {
    arts = await codesLoad();
  } catch (e) {
    return answer([], { cache_time: 10, button: { text: "Кодексы временно недоступны, попробуйте позже", start_parameter: "inline" } });
  }
  const found = codesSearch(arts, q).slice(0, 20);
  if (!found.length) return answer([], { cache_time: 60, button: { text: "Ничего не нашлось. Попробуйте номер статьи", start_parameter: "inline" } });
  return answer(found.map((a) => {
    const p0 = a.parts[0];
    const chips = codesChips(a.parts.reduce((m, p) => ({ stars: Math.max(m.stars || 0, p.stars || 0), m: Math.max(m.m || 0, p.m || 0), fmin: m.fmin || p.fmin, fmax: Math.max(m.fmax || 0, p.fmax || 0), x: m.x || p.x, rec: m.rec || p.rec }), {}));
    return {
      type: "article",
      id: (a.k + "-" + a.code).slice(0, 64),
      title: `${KIND_NAME[a.k]} ${a.code} · ${a.title}`.slice(0, 120),
      description: ((chips.length ? chips.join(" · ") + ". " : "") + (p0.note || "")).slice(0, 200),
      input_message_content: { message_text: codesText(a), parse_mode: "HTML", link_preview_options: { is_disabled: true } },
    };
  }));
}

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
    allowed_updates: ["message", "callback_query", "inline_query"],
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
      { command: "beta", description: "Бета-тестеры" },
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
      { command: "misses", description: "Поиски без результата" },
      { command: "in", description: "Отложенная команда" },
      { command: "jobs", description: "Отложенные команды" },
      { command: "panel", description: "Пароль для панели на сайте" },
    ],
  });
  return J({ ok: !!(hook && hook.ok), webhook: SELF_URL, telegram: hook });
}

// ───────────── Панель владельца и модератора на сайте (/panel/) ─────────────
// Вход: логин и пароль аккаунта + отдельный пароль панели из 32 знаков (его выдаёт бот: /panel).
// В базе только хэши. Действия панели выполняют те же функции, что и команды бота:
// ответы бота для «чата» panel:… не уходят в Telegram, а возвращаются в браузер (см. tg() и sendFile()).
// Секрет SITE_URL (необязательно): адрес сайта, если он не https://senko-assistant.site (с 2.6.6; старый адрес senko-assistant.pages.dev часть провайдеров режет)
const SITE_URL = String(Deno.env.get("SITE_URL") || "https://senko-assistant.site").replace(/\/+$/, "");
const PANEL_HOURS = 12; // сессия панели живёт не дольше 12 часов
const PANEL_IDLE_MIN = 120; // и закрывается после 2 часов без действий
const PANEL_RANKS = ["owner", "moderator"];
const PANEL_OUT = new Map(); // panel:<id> → ответы бота за один запрос

function panelCapture(pid, method, p) {
  const out = PANEL_OUT.get(pid);
  if (out && method === "sendMessage") {
    const kb = (p.reply_markup && p.reply_markup.inline_keyboard) || [];
    const buttons = kb
      .map((row) => row.filter((x) => x && (x.callback_data || /^https:\/\//.test(x.url || ""))).map((x) => (x.callback_data ? { text: String(x.text), data: String(x.callback_data) } : { text: String(x.text), url: String(x.url) })))
      .filter((r) => r.length);
    out.push({ t: "msg", html: String(p.text || ""), buttons });
  } else if (out && method === "answerCallbackQuery" && p.text) out.push({ t: "toast", text: String(p.text), alert: !!p.show_alert });
  return { ok: true, result: { message_id: 0 } };
}
async function panelRun(fn) {
  const pid = "panel:" + rand(8);
  const out = [];
  PANEL_OUT.set(pid, out);
  try {
    await fn(pid);
  } finally {
    PANEL_OUT.delete(pid);
  }
  return out;
}
function panelActor(p) {
  if (p.rank === "owner") return { kind: "owner", tg: OWNER_TG || "web:" + p.login_lc, label: "owner", profile: p, panel: true };
  if (p.rank === "moderator") return { kind: "moderator", tg: p.tg_id != null ? String(p.tg_id) : "web:" + p.login_lc, label: "moderator:" + p.login, profile: p, panel: true };
  return null;
}
function newPanelKey() {
  const a = new Uint8Array(32);
  crypto.getRandomValues(a);
  return [...a].map((b) => CODE_ALPH[b & 31]).join(""); // 32 знака по 5 бит = 160 бит
}
function browserName(ua) {
  const u = String(ua || "");
  const b = /Edg\//.test(u) ? "Edge" : /OPR\/|Opera/.test(u) ? "Opera" : /YaBrowser/.test(u) ? "Яндекс Браузер" : /Firefox\//.test(u) ? "Firefox" : /Chrome\//.test(u) ? "Chrome" : /Safari\//.test(u) ? "Safari" : "браузер";
  const os = /Windows/.test(u) ? "Windows" : /Android/.test(u) ? "Android" : /iPhone|iPad/.test(u) ? "iOS" : /Mac OS/.test(u) ? "macOS" : /Linux/.test(u) ? "Linux" : "";
  return b + (os ? ", " + os : "");
}

// Новый пароль панели: старый перестаёт работать, открытые панели закрываются
async function panelIssue(p, by) {
  const sql = db();
  const key = newPanelKey();
  await sql`insert into panel_keys (user_id, key_hash, created_by) values (${p.id}, ${await sha256(key)}, ${by})
            on conflict (user_id) do update set key_hash = excluded.key_hash, created_at = now(), created_by = excluded.created_by, last_used_at = null`;
  await sql`delete from panel_sessions where user_id = ${p.id}`;
  await audit(by, "panel_key", p.login, {});
  return key;
}
async function panelRevoke(p, by) {
  const sql = db();
  const r = await sql`delete from panel_keys where user_id = ${p.id} returning user_id`;
  await sql`delete from panel_sessions where user_id = ${p.id}`;
  if (r.length) await audit(by, "panel_revoke", p.login, {});
  return r.length > 0;
}
const panelKeyText = (p, key) =>
  `🛡 <b>Пароль панели для ${esc(p.login)}</b>\n<tg-spoiler><code>${key}</code></tg-spoiler>\n\n` +
  `Вход: ${SITE_URL}/panel/ — логин и пароль аккаунта плюс этот пароль. Старый пароль панели больше не работает.\n` +
  `Никому не пересылайте его. Сохраните в менеджере паролей и удалите это сообщение.`;

// Аккаунт владельца для /panel: привязанный к OWNER_TG_ID или единственный с ролью «Владелец»
async function ownerProfile() {
  const sql = db();
  if (OWNER_TG && /^\d+$/.test(OWNER_TG)) {
    const [p] = await sql`select * from profiles where rank = 'owner' and tg_id = ${OWNER_TG}`;
    if (p) return p;
  }
  const rows = await sql`select * from profiles where rank = 'owner' limit 2`;
  return rows.length === 1 ? rows[0] : null;
}

// /panel — пароль для панели на сайте (владелец и модераторы)
async function panelCmd(chat, a, args) {
  if (a.panel) return send(chat, "Пароли панели выдаются в Telegram (/panel) или в панели: «Роли и доступ».");
  const owner = a.kind === "owner";
  const v = String(args[0] || "").toLowerCase();
  const off = v === "off";
  const login = off ? args[1] : args[0];
  let p;
  if (login) {
    if (!owner) return send(chat, "Пароль панели другим выдаёт только владелец. Свой пароль: /panel");
    p = await findProfile(login);
    if (!p) return send(chat, "Пользователь не найден.");
  } else p = owner ? await ownerProfile() : a.profile;
  if (!p)
    return send(chat, "Не нашёл ваш аккаунт с ролью «Владелец». Привяжите его: /role &lt;ваш логин&gt; owner " + esc(OWNER_TG) + " — или укажите логин: /panel &lt;логин&gt;");
  if (off) {
    const had = await panelRevoke(p, a.label);
    return send(chat, had ? `✅ Вход в панель для <b>${esc(p.login)}</b> закрыт, открытые панели завершены.` : "Пароля панели у этого аккаунта нет.");
  }
  if (!PANEL_RANKS.includes(p.rank)) return send(chat, `Панель доступна владельцу и модераторам. У <b>${esc(p.login)}</b> роль «${RANKS[p.rank]}». Выдать роль: /role`);
  if (!(await hit(`pk:${p.id}`, 6, 3600))) return send(chat, RATE_MSG);
  const key = await panelIssue(p, a.label);
  const to = p.tg_id != null ? String(p.tg_id) : "";
  if (to && to !== String(chat)) {
    const r = await send(to, panelKeyText(p, key));
    if (r && r.ok) return send(chat, `✅ Новый пароль панели отправлен <b>${esc(p.login)}</b> в Telegram.`);
  }
  return send(chat, panelKeyText(p, key) + (p.id !== (a.profile && a.profile.id) && !(owner && p.rank === "owner") ? "\n\nПередайте пароль модератору лично." : ""));
}

// Сессия панели: {p, a} или {err}
async function pwho(b, ownerOnly = false) {
  const t = b.ptoken;
  if (typeof t !== "string" || !/^[0-9a-f]{64}$/.test(t)) return { err: fail("Войдите в панель.", { code: "auth" }) };
  const sql = db();
  const th = await sha256(t);
  const [s] = await sql`select * from panel_sessions where token_hash = ${th} and expires_at > now()`;
  if (!s || Date.now() - new Date(s.last_at).getTime() > PANEL_IDLE_MIN * 60e3) {
    if (s) await sql`delete from panel_sessions where token_hash = ${th}`;
    return { err: fail("Сессия панели закончилась. Войдите заново.", { code: "auth" }) };
  }
  const p = await liftExpiredBan(await profileById(s.user_id));
  if (!p || p.banned || !PANEL_RANKS.includes(p.rank)) {
    await sql`delete from panel_sessions where user_id = ${s.user_id}`;
    return { err: fail("Доступ к панели закрыт.", { code: "auth" }) };
  }
  if (Date.now() - new Date(s.last_at).getTime() > 60e3) await sql`update panel_sessions set last_at = now() where token_hash = ${th}`;
  const a = panelActor(p);
  if (ownerOnly && a.kind !== "owner") return { err: fail("Это доступно только владельцу.", { code: "forbidden" }) };
  return { p, a, th };
}
const panelMe = (p, a) => ({ login: p.login, nick: p.nick, rank: p.rank, rankName: RANKS[p.rank], kind: a.kind, owner: a.kind === "owner", tg: p.tg_id != null || a.kind === "owner" && !!OWNER_TG, idleMin: PANEL_IDLE_MIN });

async function panelLogin(b, ip, ua) {
  const lc = clean(b.login, 24).toLowerCase();
  const pass = String(b.password == null ? "" : b.password);
  const key = normCode(b.key);
  if (!lc || !pass || !key) return fail("Введите логин, пароль аккаунта и пароль панели.");
  if (!(await hit(`pip:${ip}`, 12, 900)) || !(await hit(`pl:${lc}`, 8, 3600))) return fail(RATE_MSG, { code: "rate" });
  const sql = db();
  const p = await liftExpiredBan((await sql`select * from profiles where login_lc = ${lc}`)[0] || null);
  let passOk = false;
  if (p) [{ ok: passOk }] = await sql`select extensions.crypt(${pass}, ${p.pass_hash}) = ${p.pass_hash} as ok`;
  else await sql`select extensions.crypt(${pass}, ${DUMMY_SALT})`;
  const [k] = p ? await sql`select key_hash from panel_keys where user_id = ${p.id}` : [];
  const keyOk = !!k && safeEq(await sha256(key), k.key_hash);
  const where = `IP ${ipShort(ip) || "неизвестен"}, ${browserName(ua)}`;
  if (!p || !passOk || !keyOk || !PANEL_RANKS.includes(p.rank)) {
    if (p) await logIn(p.id, "fail", { ver: "панель", os: browserName(ua) }, ip);
    if (p && PANEL_RANKS.includes(p.rank)) {
      const n = await hitN(`plf:${lc}`, 3600);
      if (n === 3 || n === 8) await send(OWNER_TG, `⚠️ ${n} неудачных попыток входа в панель: <b>${esc(p.login)}</b> (${RANKS[p.rank]})\n${esc(where)}${passOk ? "\nПароль аккаунта был верным, ошибка в пароле панели." : ""}`);
    }
    return fail("Неверный логин, пароль или пароль панели.");
  }
  if (p.banned) return fail(banMsg(p), { code: "banned" });
  await sql`delete from rate_limits where key = ${"pl:" + lc} or key = ${"plf:" + lc}`;
  await sql`delete from panel_sessions where expires_at < now() or last_at < now() - make_interval(mins => ${PANEL_IDLE_MIN})`;
  const token = rand(32);
  await sql`insert into panel_sessions (token_hash, user_id, expires_at, ip, ua)
            values (${await sha256(token)}, ${p.id}, now() + make_interval(hours => ${PANEL_HOURS}), ${ipShort(ip)}, ${clean(browserName(ua), 60)})`;
  await sql`update panel_keys set last_used_at = now() where user_id = ${p.id}`;
  const a = panelActor(p);
  await audit(a.label, "panel_login", p.login, { ip: ipShort(ip), ua: browserName(ua) });
  await logIn(p.id, "login", { ver: "панель", os: browserName(ua) }, ip);
  const msg = `🛡 <b>Вход в панель</b>: ${esc(p.login)} (${RANKS[p.rank]})\n${esc(where)}, ${fmtDate(new Date())}`;
  if (OWNER_TG) await send(OWNER_TG, msg + `\nЕсли это были не вы: /panel off ${esc(p.login)}`);
  if (p.rank === "moderator" && p.tg_id != null) await send(String(p.tg_id), msg + "\nЕсли это были не вы, напишите владельцу и смените пароль: /panel");
  return { ok: true, ptoken: token, me: panelMe(p, a) };
}

// Редактор базы (только владелец): какие таблицы и поля можно менять.
// Роль и Telegram ID меняются только через /role (с подтверждением), пароли и сессии не видны вовсе.
const PANEL_DB = {
  profiles: { title: "Пользователи", key: "id", order: "created_at", search: ["login", "nick", "static_id", "discord"], hide: ["pass_hash", "devices", "login_lc"],
    cols: { nick: "text", static_id: "text", org: DEPTS, dept: "text", game_role: ["off", "pros", "adv"], discord: "text", telegram: "text", phone: "text", tags: "tags", contacts_open: "tags", approval: ["ok", "pending", "rejected"], banned: "bool", ban_reason: "text", banned_until: "time", app_version: "text" } },
  bot_settings: { title: "Настройки бота", key: "key", order: "updated_at", search: ["key"], cols: { value: "json" }, del: true },
  broadcasts: { title: "Сообщения в программе", key: "id", order: "id", search: ["title", "text", "author", "org"], cols: { title: "text", text: "long", org: "text", expires_at: "time" }, del: true },
  account_notes: { title: "Заметки к аккаунтам", key: "id", order: "id", search: ["text", "author"], cols: { text: "long" }, del: true, user: true },
  account_warns: { title: "Предупреждения", key: "id", order: "id", search: ["reason", "author"], cols: { reason: "text" }, del: true, user: true },
  bug_reports: { title: "Сообщения об ошибках", key: "id", order: "id", search: ["text", "app_version"], hide: ["log"], cols: { answered: "bool" }, del: true, user: true },
  reports: { title: "Рапорты", key: "id", order: "id", search: ["title", "author", "login", "org", "body"], cols: { title: "text", status: ["new", "ok", "no"], reviewer: "text", review_note: "text" }, del: true },
  shares: { title: "Ссылки «Поделиться»", key: "code", order: "created_at", search: ["code", "title", "author"], cols: { title: "text" }, del: true },
  search_misses: { title: "Поиски без результата", key: "q", order: "last_at", search: ["q"], cols: { n: "int" }, del: true },
  bot_delayed: { title: "Отложенные команды", key: "id", order: "run_at", search: ["command", "actor_label"], cols: { command: "text", run_at: "time" }, del: true },
  achievements: { title: "Достижения", key: null, order: "at", search: ["code"], cols: {}, user: true },
  login_log: { title: "Журнал входов", key: null, order: "at", search: ["kind", "ver", "os", "ip"], cols: {}, user: true },
};
const pick = (o, keys) => Object.fromEntries(keys.map((k) => [k, o[k]]));
function dbValue(type, v) {
  if (Array.isArray(type)) return type.includes(v) ? { v } : { e: "значение из списка: " + type.join(", ") };
  switch (type) {
    case "text": return { v: clean(v, 500) };
    case "long": return { v: String(v == null ? "" : v).replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, " ").trim().slice(0, 3000) };
    case "bool": return typeof v === "boolean" ? { v } : { e: "да или нет" };
    case "int": return Number.isInteger(v) && v >= 0 && v < 1e9 ? { v } : { e: "целое число" };
    case "tags": return Array.isArray(v) ? { v: [...new Set(v.map(normTag).filter(Boolean))].slice(0, 20) } : { e: "список" };
    case "time": {
      if (v == null || v === "") return { v: null };
      const d = new Date(v);
      return isNaN(d.getTime()) ? { e: "дата и время" } : { v: d };
    }
    case "json": {
      try {
        const j = typeof v === "string" ? JSON.parse(v) : v;
        return JSON.stringify(j).length <= 20000 ? { v: j } : { e: "слишком большое значение" };
      } catch (e) {
        return { e: "некорректный JSON" };
      }
    }
  }
  return { e: "поле нельзя менять" };
}
const dbRow = (t, r) => {
  const o = { ...r };
  for (const h of t.hide || []) delete o[h];
  return o;
};

async function panelDb(b, a) {
  const sql = db();
  const t = Object.hasOwn(PANEL_DB, String(b.table)) ? PANEL_DB[b.table] : null;
  if (b.op === "db_tables") {
    const out = [];
    for (const [name, x] of Object.entries(PANEL_DB)) {
      const [{ n }] = await sql`select count(*)::int n from ${sql(name)}`;
      out.push({ name, title: x.title, rows: n, key: x.key, edit: Object.keys(x.cols), types: x.cols, del: !!x.del });
    }
    return { ok: true, tables: out };
  }
  if (!t) return fail("Нет такой таблицы.");
  if (b.op === "db_rows") {
    const q = clean(b.q, 60);
    const page = Math.max(0, Math.min(1000, parseInt(b.page, 10) || 0));
    const like = "%" + likeEsc(q) + "%";
    const col = (c) => (t.user ? sql`x.${sql(c)}` : sql(c));
    const cond = q ? t.search.map((c) => sql`${col(c)}::text ilike ${like}`).reduce((x, y) => sql`${x} or ${y}`) : sql`true`;
    const rows = t.user
      ? await sql`select x.*, p.login as user_login from ${sql(b.table)} x left join profiles p on p.id = x.user_id where ${cond} order by x.${sql(t.order)} desc nulls last limit 51 offset ${page * 50}`
      : await sql`select * from ${sql(b.table)} where ${cond} order by ${sql(t.order)} desc nulls last limit 51 offset ${page * 50}`;
    return { ok: true, rows: rows.slice(0, 50).map((r) => dbRow(t, r)), more: rows.length > 50, page };
  }
  if (!t.key) return fail("Эту таблицу можно только смотреть.");
  const key = String(b.key == null ? "" : b.key).slice(0, 200);
  if (t.key === "id" && b.table === "profiles" ? !UUID_RE.test(key) : t.key === "id" && !/^\d{1,18}$/.test(key)) return fail("Некорректная запись.");
  const [before] = await sql`select * from ${sql(b.table)} where ${sql(t.key)} = ${key}`;
  if (!before) return fail("Запись не найдена (её могли удалить).");
  if (b.op === "db_save") {
    const vals = b.values && typeof b.values === "object" ? b.values : {};
    const set = {};
    for (const [c, v] of Object.entries(vals)) {
      if (!Object.hasOwn(t.cols, c)) return fail(`Поле «${String(c).slice(0, 40)}» менять нельзя.`);
      const r = dbValue(t.cols[c], v);
      if (r.e) return fail(`Поле «${c}»: ${r.e}.`);
      set[c] = r.v;
    }
    const cols = Object.keys(set).filter((c) => JSON.stringify(set[c]) !== JSON.stringify(before[c] instanceof Date ? before[c].toISOString() : before[c]));
    if (!cols.length) return { ok: true, row: dbRow(t, before), changed: 0 };
    if (b.table === "profiles" && (("nick" in set && !set.nick) || ("static_id" in set && !set.static_id))) return fail("Ник и статик не могут быть пустыми.");
    if (b.table === "profiles" && before.rank === "owner" && cols.includes("banned") && set.banned) return fail("Владельца заблокировать нельзя.");
    for (const c of cols) if (t.cols[c] === "json") set[c] = sql.json(set[c]);
    const [after] = await sql`update ${sql(b.table)} set ${sql(set, cols)} where ${sql(t.key)} = ${key} returning *`;
    await audit(a.label, "db_edit", `${b.table}:${key}`, { table: b.table, key, before: pick(before, cols), after: pick(after, cols), who: before.login || before.user_id || null });
    return { ok: true, row: dbRow(t, after), changed: cols.length };
  }
  if (b.op === "db_delete") {
    if (!t.del) return fail("Из этой таблицы удалять нельзя. Аккаунт удаляется командой /delete.");
    await sql`delete from ${sql(b.table)} where ${sql(t.key)} = ${key}`;
    await audit(a.label, "db_delete", `${b.table}:${key}`, { table: b.table, key, row: dbRow(t, before) });
    return { ok: true };
  }
  return fail("Неизвестное действие.");
}
// Вернуть значения полей, как они были до правки в редакторе базы (по записи журнала)
async function panelRevert(b, a) {
  const sql = db();
  const id = parseInt(b.id, 10);
  const [e] = id ? await sql`select * from audit_log where id = ${id} and action = 'db_edit'` : [];
  if (!e || !e.details || !Object.hasOwn(PANEL_DB, String(e.details.table))) return fail("Это изменение нельзя вернуть.");
  const t = PANEL_DB[e.details.table];
  const back = {};
  for (const [c, v] of Object.entries(e.details.before || {}))
    if (Object.hasOwn(t.cols, c)) back[c] = t.cols[c] === "time" && v ? new Date(v) : t.cols[c] === "json" ? sql.json(v) : v;
  const cols = Object.keys(back);
  if (!cols.length) return fail("Нечего возвращать.");
  const [row] = await sql`update ${sql(e.details.table)} set ${sql(back, cols)} where ${sql(t.key)} = ${e.details.key} returning *`;
  if (!row) return fail("Запись уже удалена.");
  await audit(a.label, "db_revert", e.target, { from: id, values: e.details.before });
  return { ok: true, row: dbRow(t, row) };
}

async function panelDash(a) {
  const sql = db();
  const [u] = await sql`select count(*)::int total,
      count(*) filter (where last_seen > now() - interval '1 hour')::int online,
      count(*) filter (where last_seen > now() - interval '1 day')::int today,
      count(*) filter (where created_at > now() - interval '7 days')::int week,
      count(*) filter (where banned)::int banned,
      count(*) filter (where approval = 'pending')::int pending,
      count(*) filter (where rank = 'moderator')::int mods,
      count(*) filter (where rank = 'leader')::int leaders from profiles`;
  const orgs = await sql`select org, count(*)::int n, count(*) filter (where last_seen > now() - interval '7 days')::int active from profiles group by org order by n desc`;
  const [{ resets }] = await sql`select count(*)::int resets from reset_requests where status = 'pending' and expires_at > now()`;
  const [{ bugs }] = await sql`select count(*)::int bugs from bug_reports where not answered`;
  const [{ reports }] = await sql`select count(*)::int reports from reports where status = 'new'`;
  const [{ notices }] = await sql`select count(*)::int notices from broadcasts where expires_at > now() and user_id is null`;
  const days = await sql`select to_char(date_trunc('day', created_at + interval '3 hours'), 'DD.MM') d, count(*)::int n from profiles
                         where created_at > now() - interval '14 days' group by 1 order by min(created_at)`;
  const modes = {
    maintenance: await getSetting("maintenance", { on: false }),
    regs: await getSetting("regs", { open: true, limit: 0 }),
    approval: await getSetting("approval", { on: false }),
    summary: await getSetting("summary", null),
    orgreport: await getSetting("orgreport", {}),
    ailog: await getSetting("ailog", { on: true }),
    appeal: await getSetting("appeal", null),
    blacklist: await getSetting("blacklist", []),
  };
  return { ok: true, users: u, orgs, resets, bugs, reports, notices, days, modes: a.kind === "owner" ? modes : { maintenance: modes.maintenance, approval: modes.approval, regs: modes.regs } };
}

async function panelUsers(b, a) {
  const sql = db();
  const q = clean(b.q, 40);
  const page = Math.max(0, Math.min(1000, parseInt(b.page, 10) || 0));
  const like = "%" + likeEsc(q.replace(/^#/, "")) + "%";
  const conds = [sql`true`];
  if (q.startsWith("#")) conds.push(sql`${normTag(q)} = any(tags)`);
  else if (q) conds.push(a.kind === "owner"
    ? sql`(login ilike ${like} or nick ilike ${like} or static_id ilike ${like} or discord ilike ${like} or telegram ilike ${like})`
    : sql`(login ilike ${like} or nick ilike ${like} or static_id ilike ${like} or discord ilike ${like})`);
  if (RANKS[b.rank]) conds.push(sql`rank = ${b.rank}`);
  if (DEPTS.includes(b.org)) conds.push(sql`org = ${b.org}`);
  if (b.state === "banned") conds.push(sql`banned`);
  if (b.state === "pending") conds.push(sql`approval <> 'ok'`);
  if (b.state === "online") conds.push(sql`last_seen > now() - interval '1 hour'`);
  const where = conds.reduce((x, y) => sql`${x} and ${y}`);
  const order = b.sort === "seen" ? sql`last_seen desc nulls last` : b.sort === "login" ? sql`login_lc` : sql`created_at desc`;
  const rows = await sql`select id, login, nick, static_id, org, rank, banned, banned_until, approval, tags, app_version, created_at, last_seen, tg_id is not null as has_tg,
                           (select count(*)::int from account_warns w where w.user_id = profiles.id) warns
                         from profiles where ${where} order by ${order} limit 41 offset ${page * 40}`;
  const [{ n }] = await sql`select count(*)::int n from profiles where ${where}`;
  return { ok: true, rows: rows.slice(0, 40), more: rows.length > 40, page, total: n };
}

async function panelUser(b, a) {
  const p = await findProfile(String(b.login || ""));
  if (!p) return fail("Пользователь не найден.");
  const sql = db();
  const owner = a.kind === "owner";
  const [k] = await sql`select created_at, last_used_at from panel_keys where user_id = ${p.id}`;
  const logins = owner ? await sql`select at, kind, ver, os, ip from login_log where user_id = ${p.id} order by at desc limit 10` : [];
  const [{ sessions }] = await sql`select count(*)::int sessions from sessions where user_id = ${p.id} and expires_at > now()`;
  return {
    ok: true,
    html: await fullCard(p, a.kind),
    user: { login: p.login, nick: p.nick, static: p.static_id, org: p.org, rank: p.rank, rankName: RANKS[p.rank], banned: p.banned, approval: p.approval, tags: p.tags || [], hasTg: p.tg_id != null, self: p.id === a.profile.id, beta: !!p.beta },
    touch: canTouch(a, p) || "",
    panelKey: owner && k ? { created: k.created_at, used: k.last_used_at } : null,
    logins,
    sessions,
  };
}

async function panelStaff(a) {
  const sql = db();
  const rows = await sql`select p.login, p.nick, p.org, p.rank, p.tg_id is not null as has_tg, p.last_seen, k.created_at as key_at, k.last_used_at as key_used,
                           (select count(*)::int from panel_sessions s where s.user_id = p.id and s.expires_at > now()) as panels
                         from profiles p left join panel_keys k on k.user_id = p.id
                         where p.rank in ('owner','moderator','leader') order by array_position(array['owner','moderator','leader'], p.rank), p.org, p.login_lc`;
  return { ok: true, rows: rows.map((r) => (a.kind === "owner" ? r : { ...r, key_at: null, key_used: null, panels: null })), site: SITE_URL };
}

async function panelApi(b, ip, ua) {
  const op = String(b.op || "");
  if (op === "login") return panelLogin(b, ip, ua);
  const owners = ["audit", "bugs", "bug_log", "bug_reply", "staff_key", "staff_revoke", "db_tables", "db_rows", "db_save", "db_delete", "db_revert", "ads_list", "ads_save", "ads_toggle", "ads_delete",
    "prog_get", "prog_xp", "prog_ach", "prog_ach_new", "prog_ai",
    "ai_dict_list", "ai_dict_save", "ai_dict_delete", "ai_bad", "ai_gold_list", "ai_gold_save", "ai_gold_delete", "ai_gold_pin", "ai_gold_run"];
  const { p, a, th, err } = await pwho(b, owners.includes(op));
  if (err) return err;
  const sql = db();
  if (!(await hit(`pa:${p.id}`, 300, 600))) return fail(RATE_MSG, { code: "rate" });
  switch (op) {
    case "me":
      return { ok: true, me: panelMe(p, a) };
    case "logout":
      await sql`delete from panel_sessions where ${b.all ? sql`user_id = ${p.id}` : sql`token_hash = ${th}`}`;
      return { ok: true };
    case "dash":
      return panelDash(a);
    case "health":
      return { ok: true, html: await healthText() };
    case "users":
      return panelUsers(b, a);
    case "user":
      return panelUser(b, a);
    case "staff":
      return panelStaff(a);
    case "cmd": {
      const text = String(b.text == null ? "" : b.text).replace(/\r/g, "").trim().slice(0, 1600);
      if (!/^\/[a-z_]{2,20}\b/i.test(text)) return fail("Команда начинается с «/», например /help.");
      const out = await panelRun((pid) => onMessage({ from: { id: a.tg }, chat: { id: pid, type: "private" }, text, panelActor: a }));
      return { ok: true, out };
    }
    case "cb": {
      const data = String(b.data || "").slice(0, 64);
      if (!/^[a-z]{2}:[\w:-]+$/i.test(data)) return fail("Некорректная кнопка.");
      const out = await panelRun((pid) => onCallback({ id: pid, from: { id: a.tg }, data, message: { chat: { id: pid }, message_id: 0 }, panelActor: a }));
      return { ok: true, out };
    }
    case "audit": {
      const q = clean(b.q, 40);
      const page = Math.max(0, Math.min(1000, parseInt(b.page, 10) || 0));
      const like = "%" + likeEsc(q) + "%";
      const rows = q
        ? await sql`select * from audit_log where action = ${q} or target ilike ${like} or actor ilike ${like} order by id desc limit 51 offset ${page * 50}`
        : await sql`select * from audit_log order by id desc limit 51 offset ${page * 50}`;
      return { ok: true, rows: rows.slice(0, 50), more: rows.length > 50, page, actions: AUDIT_ACTIONS };
    }
    case "bugs": {
      const rows = await sql`select b.id, b.user_id, b.text, b.app_version, b.answered, b.at, length(b.log)::int as log_len, p.login, p.nick, p.org
                             from bug_reports b left join profiles p on p.id = b.user_id
                             where ${b.all ? sql`true` : sql`not b.answered`} order by b.id desc limit 50`;
      return { ok: true, rows };
    }
    case "bug_log": {
      const [bug] = await sql`select id, log from bug_reports where id = ${parseInt(b.id, 10) || 0}`;
      return bug ? { ok: true, name: `senko-log-${bug.id}.txt`, text: bug.log || "" } : fail("Сообщение об ошибке не найдено.");
    }
    case "bug_reply": {
      const body = String(b.text == null ? "" : b.text).replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, " ").trim().slice(0, 1500);
      const [bug] = await sql`select * from bug_reports where id = ${parseInt(b.id, 10) || 0}`;
      if (!bug) return fail("Сообщение об ошибке не найдено.");
      if (!body) return fail("Напишите ответ.");
      await sql`insert into broadcasts (user_id, title, author, text, expires_at)
                values (${bug.user_id}, ${"Ответ на ваше сообщение об ошибке №" + bug.id}, ${a.label}, ${body}, now() + interval '30 days')`;
      await sql`update bug_reports set answered = true where id = ${bug.id}`;
      return { ok: true };
    }
    case "staff_key": {
      const t = await findProfile(String(b.login || ""));
      if (!t) return fail("Пользователь не найден.");
      if (!PANEL_RANKS.includes(t.rank)) return fail("Панель доступна только владельцу и модераторам.");
      if (!(await hit(`pk:${t.id}`, 6, 3600))) return fail(RATE_MSG, { code: "rate" });
      const key = await panelIssue(t, a.label);
      if (t.id !== p.id && t.tg_id != null) {
        const r = await send(String(t.tg_id), panelKeyText(t, key));
        if (r && r.ok) return { ok: true, sent: true };
      }
      if (t.id === p.id) await sql`insert into panel_sessions (token_hash, user_id, expires_at, ip, ua) values (${th}, ${p.id}, now() + make_interval(hours => ${PANEL_HOURS}), ${ipShort(ip)}, ${clean(browserName(ua), 60)}) on conflict do nothing`;
      return { ok: true, key, self: t.id === p.id };
    }
    case "staff_revoke": {
      const t = await findProfile(String(b.login || ""));
      if (!t) return fail("Пользователь не найден.");
      if (t.id === p.id) return fail("Свой вход закрывается командой /panel off в боте.");
      return { ok: true, had: await panelRevoke(t, a.label) };
    }
    case "db_tables":
    case "db_rows":
    case "db_save":
    case "db_delete":
      return panelDb(b, a);
    case "db_revert":
      return panelRevert(b, a);
    case "ads_list":
    case "ads_save":
    case "ads_toggle":
    case "ads_delete":
      return panelAds(b, a);
    case "beta_list":
    case "beta_set":
    case "beta_task":
    case "beta_task_save":
    case "beta_task_delete":
    case "flags_set":
      return panelBeta(b, a);
    case "ideas_list":
    case "ideas_set":
    case "ideas_delete":
      return panelIdeas(b, a);
    case "prog_get":
    case "prog_xp":
    case "prog_ach":
    case "prog_ach_new":
    case "prog_ai":
      return panelProgress(b, a);
    case "ai_dict_list":
    case "ai_dict_save":
    case "ai_dict_delete":
    case "ai_bad":
    case "ai_gold_list":
    case "ai_gold_save":
    case "ai_gold_delete":
    case "ai_gold_pin":
    case "ai_gold_run":
      return panelAi(b, a);
  }
  return fail("Неизвестное действие панели.");
}

// ───────────── 2.6.3: опыт и достижения пользователя (владелец в панели) ─────────────
async function progOf(p) {
  const sql = db();
  await ensureXpAdj();
  const [{ sx }] = await sql`select coalesce(max(senko_num(data#>>'{}')), 0)::int sx from sync_items where user_id = ${p.id} and kind = 'xp' and not deleted`;
  const [{ adj, aib }] = await sql`select xp_adj adj, ai_bonus aib from profiles where id = ${p.id}`;
  const got = await sql`select code, at from achievements where user_id = ${p.id}`;
  const G = Object.fromEntries(got.map((r) => [r.code, r.at]));
  const AX = await getSetting("achx", {});
  const list = ACH.map((x) => ({ code: x.code, icon: x.icon, name: x.name, desc: x.desc, custom: false, at: G[x.code] || null }))
    .concat(Object.entries(AX).map(([code, x]) => ({ code, icon: x.icon, name: x.name, desc: x.desc, custom: true, at: G[code] || null })));
  const xp = Math.max(0, sx + adj);
  return { ok: true, login: p.login, nick: p.nick, xp, synced: sx, adj, aiBonus: aib || 0, level: lvOf(xp), levels: LVN.map((n, i) => ({ n: i + 1, name: n, from: LVT[i] })), ach: list };
}
async function achNotice(p, x, by) {
  await db()`insert into broadcasts (user_id, title, author, text, expires_at)
             values (${p.id}, '🏆 Новое достижение', ${by}, ${`${x.icon} ${x.name}${x.desc ? " — " + String(x.desc).toLowerCase() : ""}\nВсе достижения — в личном кабинете.`}, now() + interval '7 days')`;
}
async function panelProgress(b, a) {
  const p = await findProfile(String(b.login || ""));
  if (!p) return fail("Пользователь не найден.");
  const sql = db();
  if (b.op === "prog_get") return progOf(p);
  if (b.op === "prog_xp") {
    // опыт задаётся числом («сделать 500») или прибавкой («+50», «−30»)
    const cur = await progOf(p);
    const want = b.set != null && b.set !== "" ? Math.floor(+b.set) : cur.xp + Math.floor(+b.add || 0);
    if (!Number.isFinite(want) || want < 0 || want > 1000000) return fail("Опыт: целое число от 0 до 1 000 000.");
    if (want === cur.xp) return cur;
    const adj = want - cur.synced;
    await sql`update profiles set xp_adj = ${adj} where id = ${p.id}`;
    await audit(a.label, "xp_set", p.login, { before: cur.xp, after: want, adj });
    if (b.notify) await sql`insert into broadcasts (user_id, title, author, text, expires_at)
                            values (${p.id}, ${want > cur.xp ? "⭐ Начислен опыт" : "Опыт изменён"}, ${a.label},
                                    ${`Опыт: ${cur.xp} → ${want}${b.reason ? "\nПричина: " + clean(b.reason, 200) : ""}`}, now() + interval '7 days')`;
    await checkAch(p).catch((e) => console.error("ach", e));
    return progOf(p);
  }
  if (b.op === "prog_ai") {
    // дополнительные запросы к ИИ: числом («сделать 50») или прибавкой («+20»); тратятся, когда кончился дневной лимит
    const cur = await progOf(p);
    const want = b.set != null && b.set !== "" ? Math.floor(+b.set) : cur.aiBonus + Math.floor(+b.add || 0);
    if (!Number.isFinite(want) || want < 0 || want > 100000) return fail("Запросы к ИИ: целое число от 0 до 100 000.");
    if (want === cur.aiBonus) return cur;
    await sql`update profiles set ai_bonus = ${want} where id = ${p.id}`;
    await audit(a.label, "ai_bonus", p.login, { before: cur.aiBonus, after: want });
    if (b.notify && want > cur.aiBonus) await sql`insert into broadcasts (user_id, title, author, text, expires_at)
                            values (${p.id}, '🤖 Дополнительные запросы к ИИ', ${a.label},
                                    ${`Вам выдано дополнительных запросов к ИИ: ${want - cur.aiBonus}. Всего: ${want}.\nОни тратятся, когда закончится дневной лимит, и не сгорают.${b.reason ? "\nПричина: " + clean(b.reason, 200) : ""}`}, now() + interval '7 days')`;
    return progOf(p);
  }
  if (b.op === "prog_ach") {
    const AA = await achAll();
    const code = String(b.code || "").slice(0, 40);
    const x = AA[code];
    if (!x) return fail("Нет такого достижения.");
    if (b.on) {
      const got = await sql`insert into achievements (user_id, code) values (${p.id}, ${code}) on conflict do nothing returning code`;
      if (got.length) {
        await audit(a.label, "ach_grant", p.login, { code, name: x.name });
        if (b.notify !== false) await achNotice(p, x, a.label);
      }
    } else {
      const del = await sql`delete from achievements where user_id = ${p.id} and code = ${code} returning code`;
      if (del.length) await audit(a.label, "ach_revoke", p.login, { code, name: x.name });
    }
    return progOf(p);
  }
  if (b.op === "prog_ach_new") {
    const name = clean(b.name, 60), desc = clean(b.desc, 160), icon = clean(b.icon, 8) || "🏆";
    if (!name) return fail("Напишите название достижения.");
    const AX = await getSetting("achx", {});
    if (Object.keys(AX).length >= 100) return fail("Особых достижений уже 100. Удалите лишние в редакторе базы (bot_settings, ключ achx).");
    const code = "x" + Date.now().toString(36);
    AX[code] = { icon, name, desc };
    await setSetting("achx", AX);
    await sql`insert into achievements (user_id, code) values (${p.id}, ${code}) on conflict do nothing`;
    await audit(a.label, "ach_custom", p.login, { code, icon, name, desc });
    if (b.notify !== false) await achNotice(p, AX[code], a.label);
    return progOf(p);
  }
  return fail("Неизвестное действие.");
}

// ───────────── Реклама (2.3.0): баннеры на сайте и на главной в программе, правит владелец в панели ─────────────
let adsCache = null; // { at, rows }
// Если базу не обновили через schema.sql, таблица рекламы создаётся здесь при первом обращении (то же, что в schema.sql)
const ADS_DDL = `create table if not exists public.ads (
  id          bigserial primary key,
  title       text not null,
  srv         text not null default '',
  body        text not null default '',
  tag         text not null default 'Реклама',
  style       text not null default 'wide' check (style in ('wide','square')),
  image       text not null default '',
  links       jsonb not null default '[]'::jsonb,
  promo       text not null default '',
  place       text not null default 'both' check (place in ('both','site','app')),
  enabled     boolean not null default true,
  sort        int not null default 0,
  updated_at  timestamptz not null default now(),
  updated_by  text not null default ''
);
insert into public.ads (title, srv, body, style, image, links, promo, sort)
select * from (values
  ('Senko Family', 'Majestic RP · Los Angeles',
   'Семья на сервере Los Angeles. Заходите в Discord и Telegram: знакомство, набор и новости семьи.',
   'wide', '/img/senko-family-820.webp',
   '[{"label":"Discord семьи","url":"https://discord.gg/ZEz5kfG6W8"},{"label":"Telegram семьи","url":"https://t.me/senkofamq"}]'::jsonb, '', 10),
  ('Docossum | Ассистент GTA 5RP', 'Программа-ассистент · GTA 5 RP',
   'Помощник для игроков GTA 5 RP, похожий на наш, только умеет ещё больше. Загляните в Discord и Telegram, а с нашим промокодом будет приятнее.',
   'square', '/img/docossum.webp',
   '[{"label":"Discord","url":"https://discord.gg/Nnv9YjX3px"},{"label":"Telegram","url":"https://t.me/docossum"}]'::jsonb, 'Senko', 20)
) v(title, srv, body, style, image, links, promo, sort)
where not exists (select 1 from public.ads);
alter table public.ads enable row level security;
revoke all on table public.ads from anon, authenticated;
`;
let adsReady = false;
async function adsQ(fn) {
  try {
    return await fn();
  } catch (e) {
    if (adsReady || !/relation .*ads.* does not exist/i.test(String(e && e.message))) throw e;
    adsReady = true;
    await db().unsafe(ADS_DDL);
    return await fn();
  }
}
const AD_HTTPS = /^https:\/\/[^\s"'<>]{4,500}$/i;
function adPub(r) {
  return { id: r.id, title: r.title, srv: r.srv, text: r.body, tag: r.tag, style: r.style, image: r.image, links: Array.isArray(r.links) ? r.links : [], promo: r.promo };
}
async function adsPublic(b) {
  const place = b.place === "site" ? "site" : "app";
  if (!adsCache || Date.now() - adsCache.at > 60 * 1000) {
    try {
      adsCache = { at: Date.now(), rows: await adsQ(() => db()`select * from ads where enabled order by sort, id`) };
    } catch (e) {
      return fail("Реклама сейчас недоступна.", { code: "ads_off" });
    }
  }
  return { ok: true, ads: adsCache.rows.filter((r) => r.place === "both" || r.place === place).map(adPub) };
}
function adClean(b) {
  const t = (v, n) => clean(v, n);
  const title = t(b.title, 80);
  if (!title) return { err: "Укажите название баннера." };
  const image = String(b.image == null ? "" : b.image).trim();
  if (image && !/^\/img\/[\w.-]{1,80}$/.test(image) && !AD_HTTPS.test(image)) {
    if (!/^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(image)) return { err: "Картинка: ссылка https://… или загруженный файл." };
    if (image.length > 600000) return { err: "Картинка слишком большая: нужно до 400 КБ." };
  }
  const links = [];
  for (const l of (Array.isArray(b.links) ? b.links : []).slice(0, 4)) {
    const url = String((l && l.url) || "").trim();
    if (!url) continue;
    if (!AD_HTTPS.test(url)) return { err: "Ссылка должна начинаться с https://: " + url.slice(0, 60) };
    links.push({ label: t(l.label, 40) || "Открыть", url });
  }
  return {
    row: {
      title,
      srv: t(b.srv, 80),
      body: String(b.text == null ? "" : b.text).replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 400),
      tag: t(b.tag, 24) || "Реклама",
      style: b.style === "square" ? "square" : "wide",
      image,
      links,
      promo: t(b.promo, 24),
      place: ["both", "site", "app"].includes(b.place) ? b.place : "both",
      enabled: b.enabled !== false,
      sort: Math.max(-9999, Math.min(9999, parseInt(b.sort, 10) || 0)),
    },
  };
}
async function panelAds(b, a) {
  const sql = db();
  const id = parseInt(b.id, 10) || 0;
  try {
    if (b.op === "ads_list") return { ok: true, rows: await adsQ(() => sql`select * from ads order by sort, id`) };
    if (b.op === "ads_save") {
      const { row, err } = adClean(b);
      if (err) return fail(err);
      let saved;
      if (id) {
        [saved] = await sql`update ads set title = ${row.title}, srv = ${row.srv}, body = ${row.body}, tag = ${row.tag}, style = ${row.style}, image = ${row.image},
                            links = ${sql.json(row.links)}, promo = ${row.promo}, place = ${row.place}, enabled = ${row.enabled}, sort = ${row.sort},
                            updated_at = now(), updated_by = ${a.label} where id = ${id} returning *`;
        if (!saved) return fail("Баннер не найден, обновите список.");
      } else {
        const [{ n }] = await sql`select count(*)::int as n from ads`;
        if (n >= 30) return fail("Баннеров уже 30, удалите лишние.");
        [saved] = await sql`insert into ads (title, srv, body, tag, style, image, links, promo, place, enabled, sort, updated_by)
                            values (${row.title}, ${row.srv}, ${row.body}, ${row.tag}, ${row.style}, ${row.image}, ${sql.json(row.links)}, ${row.promo}, ${row.place}, ${row.enabled}, ${row.sort}, ${a.label}) returning *`;
      }
      adsCache = null;
      await audit(a.label, "ad_save", saved.title, { id: saved.id, created: !id, enabled: saved.enabled, place: saved.place });
      return { ok: true, row: saved };
    }
    if (b.op === "ads_toggle") {
      const [r] = await sql`update ads set enabled = ${!!b.enabled}, updated_at = now(), updated_by = ${a.label} where id = ${id} returning *`;
      if (!r) return fail("Баннер не найден, обновите список.");
      adsCache = null;
      await audit(a.label, "ad_toggle", r.title, { id, enabled: r.enabled });
      return { ok: true, row: r };
    }
    if (b.op === "ads_delete") {
      const [r] = await sql`delete from ads where id = ${id} returning id, title`;
      if (!r) return fail("Баннер не найден, обновите список.");
      adsCache = null;
      await audit(a.label, "ad_delete", r.title, { id });
      return { ok: true };
    }
  } catch (e) {
    console.error("ads", e);
    if (/relation .*ads.* does not exist/i.test(String(e && e.message))) return fail("Таблицы рекламы ещё нет. Откройте раздел заново или запустите «Deploy function» на GitHub.");
    throw e;
  }
  return fail("Неизвестное действие панели.");
}


// ───────────── 2.4: база обновляется сама (у токена GitHub нет прав на базу, schema.sql там не выполняется) ─────────────
// Те же команды лежат в supabase/schema.sql. Выполняются один раз: номер версии хранится в bot_settings.schema_v
const SCHEMA_V = 27;
const SCHEMA_24 = `
alter table public.profiles add column if not exists beta boolean not null default false;
alter table public.shares drop constraint if exists shares_kind_check;
alter table public.shares add constraint shares_kind_check check (kind in ('calc','set','board'));
create table if not exists public.beta_tasks (
  id bigserial primary key, title text not null, body text not null default '', author text not null default '',
  created_at timestamptz not null default now(), closed boolean not null default false);
create table if not exists public.beta_results (
  task_id bigint not null references public.beta_tasks(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  status text not null check (status in ('ok','bad')), comment text not null default '', at timestamptz not null default now(),
  primary key (task_id, user_id));
create table if not exists public.org_hooks (
  org text primary key, url text not null, events text[] not null default '{}', updated_by text not null default '',
  updated_at timestamptz not null default now(), fails int not null default 0, last_error text not null default '');
create table if not exists public.org_events (
  id bigserial primary key, org text not null, title text not null, body text not null default '', place text not null default '',
  starts_at timestamptz not null, author text not null default '', created_at timestamptz not null default now(), reminded boolean not null default false);
create index if not exists org_events_org_idx on public.org_events (org, starts_at);
create table if not exists public.ideas (
  id bigserial primary key, user_id uuid references public.profiles(id) on delete set null, text text not null,
  status text not null default 'new' check (status in ('new','work','done','no')), answer text not null default '',
  created_at timestamptz not null default now(), updated_at timestamptz not null default now());
create table if not exists public.idea_votes (
  idea_id bigint not null references public.ideas(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade, primary key (idea_id, user_id));
create table if not exists public.patrols (
  code text primary key, owner_id uuid references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(), expires_at timestamptz not null);
create table if not exists public.patrol_members (
  code text not null references public.patrols(code) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  joined_at timestamptz not null default now(), seen_at timestamptz not null default now(), primary key (code, user_id));
create table if not exists public.patrol_items (
  id bigserial primary key, code text not null references public.patrols(code) on delete cascade,
  user_id uuid references public.profiles(id) on delete cascade, uid text not null default '',
  data jsonb not null default '{}'::jsonb, updated_at timestamptz not null default now(), deleted boolean not null default false);
create unique index if not exists patrol_items_key on public.patrol_items (code, user_id, uid);
alter table public.beta_tasks enable row level security;
alter table public.beta_results enable row level security;
alter table public.org_hooks enable row level security;
alter table public.org_events enable row level security;
alter table public.ideas enable row level security;
alter table public.idea_votes enable row level security;
alter table public.patrols enable row level security;
alter table public.patrol_members enable row level security;
alter table public.patrol_items enable row level security;
revoke all on table public.beta_tasks, public.beta_results, public.org_hooks, public.org_events, public.ideas, public.idea_votes,
                    public.patrols, public.patrol_members, public.patrol_items from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;
`;
// 2.7: словарь ИИ, эталонные вопросы для самопроверки, ответ ИИ в журнале
const SCHEMA_27 = `
alter table public.ai_log add column if not exists ans text not null default '';
create table if not exists public.ai_dict (
  id bigserial primary key, phrase text not null, refs text[] not null default '{}', note text not null default '',
  author text not null default '', created_at timestamptz not null default now());
create table if not exists public.ai_gold (
  id bigserial primary key, q text not null, expect text not null default '', last text not null default '', last_ref text not null default '',
  prev text not null default '', prev_ref text not null default '', checked_at timestamptz, created_at timestamptz not null default now());
alter table public.ai_dict enable row level security;
alter table public.ai_gold enable row level security;
revoke all on table public.ai_dict, public.ai_gold from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;
`;
let schemaReady = null;
function ensureSchema() {
  if (!schemaReady)
    schemaReady = (async () => {
      try {
        const v = await getSetting("schema_v", 0);
        if (+v >= SCHEMA_V) return;
        // база уже на 2.4: повторно 2.4 не выполняем (иначе вернулись бы удалённые баннеры по умолчанию)
        await db().unsafe(+v >= 24 ? SCHEMA_27 : ADS_DDL + SCHEMA_24 + SCHEMA_27);
        adsReady = true;
        await setSetting("schema_v", SCHEMA_V);
      } catch (e) {
        console.error("schema", e);
        schemaReady = null; // попробуем при следующем запросе
      }
    })();
  return schemaReady;
}

// ───────────── 2.4: функции по флагам (владелец включает в панели: всем, только тестерам или никому) ─────────────
const FLAG_DEFS = {
  patrol: ["Совместный патруль", "beta", "2.4"],
  board: ["Тактическая доска", "all", "2.4"],
  mini: ["Мини-окно задержания", "all", "2.4"],
  tts: ["Озвучка статей", "all", "2.4"],
  mascot: ["Лиса Senko", "all", "2.4"],
  season: ["Сезонное оформление", "all", "2.4"],
  card: ["Карточка сотрудника", "all", "2.4"],
  ideas: ["Идеи и голосование", "all", "2.4"],
  events: ["Мероприятия организаций", "all", "2.4"],
};
// функции выпущенных версий включены у всех и флагов больше не имеют; бета 2.7.0 ещё спрашивает общий флаг ai27
const FLAG_RELEASED = { ai27: "all" };
const FLAG_MODES = ["all", "beta", "off"];
async function flagsNow() {
  const s = (await getSetting("flags", {})) || {};
  const out = {};
  for (const k of Object.keys(FLAG_DEFS)) out[k] = FLAG_MODES.includes(s[k]) ? s[k] : FLAG_DEFS[k][1];
  return { ...FLAG_RELEASED, ...out };
}
const isTester = (p) => !!p && (!!p.beta || p.rank === "owner" || p.rank === "moderator");

// ───────────── 2.4: бета-тестеры ─────────────
async function setBeta(a, p, on) {
  const sql = db();
  await sql`update profiles set beta = ${!!on} where id = ${p.id}`;
  await audit(a.label, "beta", p.login, { on: !!on });
  if (on) {
    await sql`insert into broadcasts (user_id, title, author, text, expires_at)
              values (${p.id}, ${"🧪 Вы бета-тестер"}, ${a.label}, ${"Вам выдана роль «Бета-тестер». В меню программы появилась «Панель тестера»: задания на проверку, экспериментальные функции и ранние версии. Спасибо за помощь!"}, now() + interval '14 days')`;
    if (p.tg_id != null) await send(String(p.tg_id), "🧪 Вам выдана роль <b>«Бета-тестер»</b> в Senko Assistant. В меню программы появилась «Панель тестера». Перезапустите программу, если её не видно.");
  }
}
async function betaApi(b) {
  const { p, err } = await who(b);
  if (err) return err;
  if (!isTester(p)) return fail("Панель тестера доступна только бета-тестерам.", { code: "forbidden" });
  const sql = db();
  const op = String(b.op || "tasks");
  if (op === "tasks") {
    const rows = await sql`select t.id, t.title, t.body, t.author, t.created_at, r.status, r.comment, r.at,
                             (select count(*)::int from beta_results x where x.task_id = t.id) as n
                           from beta_tasks t left join beta_results r on r.task_id = t.id and r.user_id = ${p.id}
                           where not t.closed order by t.id desc limit 50`;
    return { ok: true, tasks: rows.map((r) => ({ id: String(r.id), title: r.title, body: r.body, author: r.author, at: r.created_at, n: r.n, my: r.status ? { status: r.status, comment: r.comment, at: r.at } : null })), flags: await flagsNow() };
  }
  if (op === "result") {
    const id = parseInt(b.id, 10) || 0;
    const status = b.status === "bad" ? "bad" : "ok";
    const comment = cleanText(b.comment, 800);
    if (status === "bad" && comment.length < 5) return fail("Опишите, что не работает.");
    if (!(await hit(`bt:${p.id}`, 60, 3600))) return fail(RATE_MSG, { code: "rate" });
    const [t] = await sql`select * from beta_tasks where id = ${id} and not closed`;
    if (!t) return fail("Задание не найдено или уже закрыто.");
    await sql`insert into beta_results (task_id, user_id, status, comment) values (${id}, ${p.id}, ${status}, ${comment})
              on conflict (task_id, user_id) do update set status = excluded.status, comment = excluded.comment, at = now()`;
    await quiet(`🧪 <b>${esc(p.login)}</b> · задание №${id} «${esc(t.title)}»: ${status === "ok" ? "✅ работает" : "❌ не работает"}${comment ? "\n" + esc(comment) : ""}`);
    return { ok: true };
  }
  return fail("Неизвестное действие.");
}

// ───────────── 2.4: вебхуки Discord для организаций ─────────────
const HOOK_EVENTS = { rep: "Новые рапорты", join: "Новые сотрудники и заявки", ctrl: "Контрольные тесты", event: "Мероприятия и напоминания", week: "Еженедельный отчёт" };
const HOOK_RE = /^https:\/\/(?:ptb\.|canary\.)?discord(?:app)?\.com\/api\/webhooks\/\d{5,25}\/[\w-]{20,120}$/;
const hookMask = (u) => String(u || "").replace(/(\/webhooks\/\d+\/)[\w-]+$/, (m, a) => a + "•••" + String(u).slice(-4));
// Telegram-HTML в Markdown Discord
function htmlToMd(s) {
  return String(s || "")
    .replace(/<\/?b>/g, "**").replace(/<\/?i>/g, "*").replace(/<\/?code>/g, "`")
    .replace(/<a href="([^"]+)">([^<]*)<\/a>/g, "[$2]($1)").replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&amp;/g, "&");
}
async function postHook(org, ev, title, text, color = 0xff8a3d) {
  try {
    const [h] = await db()`select * from org_hooks where org = ${org}`;
    if (!h || !(h.events || []).includes(ev) || h.fails >= 20) return false;
    return await hookSend(h, title, text, color);
  } catch (e) {
    console.error("hook", e);
    return false;
  }
}
async function hookSend(h, title, text, color = 0xff8a3d) {
  let ok = false, er = "";
  try {
    const r = await fetch(h.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "Senko Assistant", allowed_mentions: { parse: [] }, embeds: [{ title: clean(htmlToMd(title), 250), description: htmlToMd(text).slice(0, 3900), color, timestamp: new Date().toISOString(), footer: { text: "Senko Assistant · " + h.org } }] }),
      signal: AbortSignal.timeout(10000),
    });
    ok = r.ok;
    if (!ok) er = r.status === 404 ? "Вебхук удалён в Discord" : "Discord ответил " + r.status;
  } catch (e) {
    er = "Discord не отвечает";
  }
  await db()`update org_hooks set fails = ${ok ? 0 : h.fails + 1}, last_error = ${ok ? "" : er} where org = ${h.org}`;
  return ok ? true : er;
}
async function hooksApi(b) {
  const { p, err } = await who(b, ["leader", "moderator", "owner"]);
  if (err) return err;
  const org = staffOrg(p, b);
  if (!org) return fail("Выберите организацию.");
  const sql = db();
  const op = String(b.op || "get");
  const label = `${p.login} (${RANKS[p.rank]})`;
  const out = async () => {
    const [h] = await sql`select * from org_hooks where org = ${org}`;
    return { ok: true, org, events: HOOK_EVENTS, hook: h ? { url: hookMask(h.url), events: h.events || [], by: h.updated_by, at: h.updated_at, fails: h.fails, error: h.last_error } : null };
  };
  if (op === "get") return out();
  if (!(await hit(`hk:${p.id}`, 30, 3600))) return fail(RATE_MSG, { code: "rate" });
  if (op === "set") {
    const evs = (Array.isArray(b.events) ? b.events : []).map(String).filter((k) => HOOK_EVENTS[k]);
    const url = String(b.url || "").trim();
    const [h] = await sql`select * from org_hooks where org = ${org}`;
    if (url) {
      if (!HOOK_RE.test(url)) return fail("Нужна ссылка вебхука Discord: https://discord.com/api/webhooks/…");
      await sql`insert into org_hooks (org, url, events, updated_by) values (${org}, ${url}, ${evs}::text[], ${label})
                on conflict (org) do update set url = excluded.url, events = excluded.events, updated_by = excluded.updated_by, updated_at = now(), fails = 0, last_error = ''`;
    } else if (h) {
      await sql`update org_hooks set events = ${evs}::text[], updated_by = ${label}, updated_at = now() where org = ${org}`;
    } else return fail("Вставьте ссылку вебхука.");
    await audit(label, "hook", org, { events: evs, url: !!url });
    return out();
  }
  if (op === "test") {
    const [h] = await sql`select * from org_hooks where org = ${org}`;
    if (!h) return fail("Сначала сохраните вебхук.");
    const r = await hookSend(h, "✅ Проверка связи", `Вебхук ${org} подключён к Senko Assistant. Проверил(а): ${p.nick || p.login}.`, 0x2e7d4f);
    return r === true ? { ok: true, msg: "Сообщение отправлено в Discord." } : fail("Не получилось: " + r + ". Проверьте ссылку вебхука.");
  }
  if (op === "del") {
    await sql`delete from org_hooks where org = ${org}`;
    await audit(label, "hook", org, { deleted: true });
    return out();
  }
  return fail("Неизвестное действие.");
}

// ───────────── 2.4: мероприятия организаций ─────────────
const evOut = (e, p) => ({ id: String(e.id), org: e.org, title: e.title, body: e.body, place: e.place, at: e.starts_at, author: e.author, mine: !!p && e.author === (p.nick || p.login) });
async function eventsFor(org, days = 14) {
  return db()`select * from org_events where org = ${org} and starts_at > now() - interval '3 hours' and starts_at < now() + make_interval(days => ${days})
              order by starts_at limit 20`;
}
async function eventsApi(b) {
  const op = String(b.op || "list");
  const staff = op !== "list" || b.org;
  const { p, err } = await who(b, staff ? ["leader", "moderator", "owner"] : undefined);
  if (err) return err;
  const org = staff ? staffOrg(p, b) : p.org;
  if (!org) return fail("Выберите организацию.");
  const sql = db();
  if (op === "list") return { ok: true, org, events: (await eventsFor(org, 60)).map((e) => evOut(e, p)) };
  if (!(await hit(`ev:${p.id}`, 40, 3600))) return fail(RATE_MSG, { code: "rate" });
  if (op === "create") {
    const title = clean(b.title, 80);
    if (title.length < 3) return fail("Напишите название мероприятия.");
    const at = new Date(String(b.at || ""));
    if (isNaN(at.getTime()) || at.getTime() < Date.now() - 60e3) return fail("Укажите дату и время в будущем.");
    if (at.getTime() > Date.now() + 90 * 864e5) return fail("Не дальше чем на 90 дней вперёд.");
    const [{ n }] = await sql`select count(*)::int n from org_events where org = ${org} and starts_at > now()`;
    if (n >= 30) return fail("Запланировано уже 30 мероприятий, удалите лишние.");
    const [e] = await sql`insert into org_events (org, title, body, place, starts_at, author)
                          values (${org}, ${title}, ${cleanText(b.body, 600)}, ${clean(b.place, 80)}, ${at}, ${p.nick || p.login}) returning *`;
    await audit(`${p.login} (${RANKS[p.rank]})`, "event", org, { id: String(e.id), title });
    await postHook(org, "event", "📅 Новое мероприятие: " + title, evText(e), 0x3b82f6);
    return { ok: true, events: (await eventsFor(org, 60)).map((x) => evOut(x, p)) };
  }
  if (op === "del") {
    const id = parseInt(b.id, 10) || 0;
    const [e] = await sql`delete from org_events where id = ${id} and org = ${org} returning *`;
    if (!e) return fail("Мероприятие не найдено.");
    await audit(`${p.login} (${RANKS[p.rank]})`, "event", org, { id: String(id), deleted: true });
    if (e.starts_at > new Date()) await postHook(org, "event", "🚫 Мероприятие отменено: " + e.title, evText(e), 0xb3261e);
    return { ok: true, events: (await eventsFor(org, 60)).map((x) => evOut(x, p)) };
  }
  return fail("Неизвестное действие.");
}
const evWhen = (d) => new Date(d).toLocaleString("ru-RU", { timeZone: "Europe/Moscow", day: "2-digit", month: "long", hour: "2-digit", minute: "2-digit" }) + " МСК";
const evText = (e) => `🕒 ${evWhen(e.starts_at)}${e.place ? "\n📍 " + esc(e.place) : ""}${e.body ? "\n\n" + esc(e.body) : ""}\n\nНазначил(а): ${esc(e.author)}`;
// Напоминание за час до начала: Telegram сотрудникам организации и вебхук
async function eventReminders() {
  const sql = db();
  const due = await sql`update org_events set reminded = true where id in (
                          select id from org_events where not reminded and starts_at > now() and starts_at <= now() + interval '60 minutes' limit 3)
                        returning *`;
  for (const e of due) {
    const text = `⏰ <b>Скоро мероприятие ${esc(e.org)}: ${esc(e.title)}</b>\n${evText(e)}`;
    const rows = await sql`select tg_id from profiles where org = ${e.org} and tg_id is not null and not banned and approval = 'ok' limit 150`;
    for (const r of rows) await send(String(r.tg_id), text, { disable_notification: false });
    await postHook(e.org, "event", "⏰ Через час: " + e.title, evText(e), 0xf59e0b);
  }
  return due.length;
}

// ───────────── 2.4: идеи с голосованием ─────────────
const IDEA_ST = { new: "Новая", work: "В работе", done: "Сделано", no: "Отклонено" };
async function ideasApi(b) {
  const { p, err } = await who(b);
  if (err) return err;
  const sql = db();
  const op = String(b.op || "list");
  if (op === "list") {
    const st = IDEA_ST[b.status] ? String(b.status) : "";
    const rows = await sql`select i.id, i.text, i.status, i.answer, i.created_at, i.user_id = ${p.id} as mine, coalesce(pr.nick, 'Удалённый аккаунт') as nick,
                             (select count(*)::int from idea_votes v where v.idea_id = i.id) as votes,
                             exists (select 1 from idea_votes v where v.idea_id = i.id and v.user_id = ${p.id}) as voted
                           from ideas i left join profiles pr on pr.id = i.user_id
                           where ${st ? sql`i.status = ${st}` : sql`i.status <> 'no' or i.user_id = ${p.id}`}
                           order by ${b.sort === "new" ? sql`i.created_at desc` : sql`votes desc, i.created_at desc`} limit 100`;
    return { ok: true, ideas: rows.map((r) => ({ id: String(r.id), text: r.text, status: r.status, answer: r.answer, at: r.created_at, mine: r.mine, nick: r.nick, votes: r.votes, voted: r.voted })) };
  }
  if (op === "add") {
    const text = cleanText(b.text, 600);
    if (text.length < 15) return fail("Опишите идею подробнее: хотя бы одно предложение.");
    if (!(await hit(`ia:${p.id}`, 3, 86400))) return fail("Можно предложить не больше 3 идей в сутки.", { code: "rate" });
    const bad = await blacklisted(text);
    if (bad) return fail("В тексте есть запрещённое слово.");
    const [r] = await sql`insert into ideas (user_id, text) values (${p.id}, ${text}) returning id`;
    await sql`insert into idea_votes (idea_id, user_id) values (${r.id}, ${p.id}) on conflict do nothing`;
    await quiet(`💡 <b>Новая идея №${r.id}</b> от ${esc(p.login)} (${esc(p.org)})\n${esc(text)}`);
    return { ok: true, id: String(r.id) };
  }
  if (op === "vote") {
    const id = parseInt(b.id, 10) || 0;
    if (!(await hit(`iv:${p.id}`, 200, 3600))) return fail(RATE_MSG, { code: "rate" });
    const [i] = await sql`select id, status from ideas where id = ${id}`;
    if (!i) return fail("Идея не найдена.");
    if (b.on === false) await sql`delete from idea_votes where idea_id = ${id} and user_id = ${p.id}`;
    else await sql`insert into idea_votes (idea_id, user_id) values (${id}, ${p.id}) on conflict do nothing`;
    const [{ n }] = await sql`select count(*)::int n from idea_votes where idea_id = ${id}`;
    return { ok: true, votes: n, voted: b.on !== false };
  }
  if (op === "del") {
    const id = parseInt(b.id, 10) || 0;
    const r = await sql`delete from ideas where id = ${id} and user_id = ${p.id} and status = 'new' returning id`;
    return r.length ? { ok: true } : fail("Удалить можно только свою идею, пока её не взяли в работу.");
  }
  return fail("Неизвестное действие.");
}

// ───────────── 2.4: совместный патруль (экипаж) ─────────────
const PATROL_MAX = 8;
const patrolCode = (s) => String(s || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6);
function patrolItem(d) {
  d = d && typeof d === "object" ? d : {};
  const n = (v, max) => Math.max(0, Math.min(max, Math.round(+v || 0)));
  return {
    nick: clean(d.nick, 40), st: clean(d.st, 12), arts: clean(d.arts, 300), mode: clean(d.mode, 8),
    start: n(d.start, 9e15), pausedTotal: n(d.pausedTotal, 864e5), paused: d.paused && +d.paused.at ? { at: n(d.paused.at, 9e15), k: clean(d.paused.k, 20) } : null,
    decidedAt: n(d.decidedAt, 864e5), result: clean(d.result, 120),
  };
}
async function patrolApi(b) {
  const { p, err } = await who(b);
  if (err) return err;
  if (!(await hit(`pt:${p.id}`, 1500, 3600))) return fail(RATE_MSG, { code: "rate" });
  const sql = db();
  const op = String(b.op || "state");
  const mine = async () => (await sql`select m.code from patrol_members m join patrols t on t.code = m.code where m.user_id = ${p.id} and t.expires_at > now() limit 1`)[0];
  const state = async (code) => {
    await sql`update patrol_members set seen_at = now() where code = ${code} and user_id = ${p.id}`;
    const [t] = await sql`select * from patrols where code = ${code}`;
    const mem = await sql`select m.user_id, m.seen_at, pr.nick, pr.org from patrol_members m join profiles pr on pr.id = m.user_id where m.code = ${code} order by m.joined_at`;
    const items = await sql`select i.uid, i.data, i.updated_at, i.user_id, pr.nick from patrol_items i left join profiles pr on pr.id = i.user_id
                            where i.code = ${code} and not i.deleted and i.updated_at > now() - interval '12 hours' order by i.id`;
    return {
      ok: true, code, expires: t ? t.expires_at : null, now: Date.now(),
      members: mem.map((m) => ({ nick: m.nick, org: m.org, me: m.user_id === p.id, online: Date.now() - new Date(m.seen_at).getTime() < 90e3 })),
      items: items.map((i) => ({ uid: i.uid, by: i.nick || "", mine: i.user_id === p.id, data: i.data, at: i.updated_at })),
    };
  };
  if (op === "state") {
    const m = await mine();
    if (!m) return { ok: true, code: null };
    return state(m.code);
  }
  if (op === "create") {
    const m = await mine();
    if (m) return state(m.code);
    const ABC = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    let code = "";
    for (let i = 0; i < 6 && !code; i++) {
      const c = Array.from(crypto.getRandomValues(new Uint8Array(6))).map((x) => ABC[x % ABC.length]).join("");
      const r = await sql`insert into patrols (code, owner_id, expires_at) values (${c}, ${p.id}, now() + interval '12 hours') on conflict do nothing returning code`;
      if (r.length) code = c;
    }
    if (!code) return fail("Не удалось создать экипаж. Попробуйте ещё раз.");
    await sql`insert into patrol_members (code, user_id) values (${code}, ${p.id})`;
    await sql`delete from patrols where expires_at < now() - interval '1 day'`;
    return state(code);
  }
  if (op === "join") {
    const code = patrolCode(b.code);
    const [t] = code.length === 6 ? await sql`select * from patrols where code = ${code} and expires_at > now()` : [];
    if (!t) return fail("Экипаж с таким кодом не найден или уже закончил смену.");
    const m = await mine();
    if (m && m.code !== code) await sql`delete from patrol_members where code = ${m.code} and user_id = ${p.id}`;
    const [{ n }] = await sql`select count(*)::int n from patrol_members where code = ${code}`;
    if (n >= PATROL_MAX && !(m && m.code === code)) return fail(`В экипаже уже ${PATROL_MAX} человек.`);
    await sql`insert into patrol_members (code, user_id) values (${code}, ${p.id}) on conflict do nothing`;
    return state(code);
  }
  const m = await mine();
  if (!m) return fail("Вы не в экипаже.", { code: "nopatrol" });
  if (op === "leave") {
    await sql`delete from patrol_items where code = ${m.code} and user_id = ${p.id}`;
    await sql`delete from patrol_members where code = ${m.code} and user_id = ${p.id}`;
    const [{ n }] = await sql`select count(*)::int n from patrol_members where code = ${m.code}`;
    if (!n) await sql`delete from patrols where code = ${m.code}`;
    return { ok: true, code: null };
  }
  if (op === "put") {
    const uid = clean(b.uid, 24);
    if (!/^[\w-]{1,24}$/.test(uid)) return fail("Некорректная запись.");
    const [{ n }] = await sql`select count(*)::int n from patrol_items where code = ${m.code} and not deleted`;
    if (n >= 60) return fail("В экипаже уже 60 задержаний.");
    await sql`insert into patrol_items (code, user_id, uid, data) values (${m.code}, ${p.id}, ${uid}, ${sql.json(patrolItem(b.data))})
              on conflict (code, user_id, uid) do update set data = excluded.data, updated_at = now(), deleted = false`;
    return state(m.code);
  }
  if (op === "del") {
    await sql`update patrol_items set deleted = true, updated_at = now() where code = ${m.code} and user_id = ${p.id} and uid = ${clean(b.uid, 24)}`;
    return state(m.code);
  }
  return fail("Неизвестное действие.");
}

// ───────────── 2.4: публичный статус сервисов (страница /status/ на сайте) ─────────────
let statusCache = null;
async function statusApi() {
  if (statusCache && Date.now() - statusCache.at < 60e3) return statusCache.r;
  const S = [];
  let t0 = Date.now();
  try {
    await db()`select 1`;
    S.push({ k: "db", name: "База данных", ok: true, ms: Date.now() - t0 });
  } catch (e) {
    S.push({ k: "db", name: "База данных", ok: false });
  }
  S.push({ k: "api", name: "Сервер (вход, синхронизация, бот)", ok: true });
  t0 = Date.now();
  try {
    const r = await fetch(AI_HEALTH_URL, { signal: AbortSignal.timeout(6000) });
    const j = await r.json().catch(() => ({}));
    S.push({ k: "ai", name: "ИИ-помощник", ok: r.ok && j.ok !== false, ms: Date.now() - t0 });
  } catch (e) {
    S.push({ k: "ai", name: "ИИ-помощник", ok: false });
  }
  let laws = null;
  try {
    const r = await fetch(LAWS_STATUS_URL + "?t=" + Date.now(), { signal: AbortSignal.timeout(6000) });
    const j = await r.json();
    laws = { checkedAt: j.checkedAt || 0, updatedAt: j.updatedAt || 0, count: j.count || 0 };
    S.push({ k: "laws", name: "Обновление законов с форума", ok: !!j.ok && Date.now() - j.checkedAt < 36 * 3600e3 });
  } catch (e) {
    S.push({ k: "laws", name: "Обновление законов с форума", ok: false });
  }
  let tickAt = 0;
  try {
    const tk = await getSetting("tick", null);
    tickAt = tk ? tk.at : 0;
  } catch (e) {}
  S.push({ k: "tick", name: "Уведомления и расписание", ok: Date.now() - tickAt < 10 * 60e3 });
  let m = { on: false };
  try {
    m = (await getSetting("maintenance", { on: false })) || { on: false };
  } catch (e) {}
  const r = { ok: true, at: Date.now(), services: S, laws, maintenance: m.on ? { on: true, text: m.text || "" } : { on: false } };
  statusCache = { at: Date.now(), r };
  return r;
}

// 2.4: панель — бета-тестеры, задания, флаги функций, идеи
async function panelBeta(b, a) {
  const sql = db();
  const op = b.op;
  if (op === "beta_list") {
    const users = await sql`select p.login, p.nick, p.org, p.rank, p.last_seen, p.app_version,
                              (select count(*)::int from beta_results r where r.user_id = p.id) as results
                            from profiles p where p.beta order by p.last_seen desc nulls last limit 200`;
    const tasks = await sql`select t.*, (select count(*)::int from beta_results r where r.task_id = t.id and r.status = 'ok') as ok_n,
                              (select count(*)::int from beta_results r where r.task_id = t.id and r.status = 'bad') as bad_n
                            from beta_tasks t order by t.closed, t.id desc limit 60`;
    return { ok: true, users, tasks, flags: await flagsNow(), defs: Object.fromEntries(Object.entries(FLAG_DEFS).map(([k, v]) => [k, v[0]])), vers: Object.fromEntries(Object.entries(FLAG_DEFS).map(([k, v]) => [k, v[2]])), canFlags: a.kind === "owner" };
  }
  if (op === "beta_set") {
    const t = await findProfile(String(b.login || ""));
    if (!t) return fail("Пользователь не найден.");
    await setBeta(a, t, !!b.on);
    return { ok: true };
  }
  if (op === "beta_task") {
    const id = parseInt(b.id, 10) || 0;
    const rows = await sql`select r.*, p.login, p.nick from beta_results r join profiles p on p.id = r.user_id where r.task_id = ${id} order by r.at desc`;
    return { ok: true, results: rows.map((r) => ({ login: r.login, nick: r.nick, status: r.status, comment: r.comment, at: r.at })) };
  }
  if (op === "beta_task_save") {
    const title = clean(b.title, 120);
    if (title.length < 3) return fail("Напишите, что нужно проверить.");
    const body = cleanText(b.body, 1500);
    const id = parseInt(b.id, 10) || 0;
    let t;
    if (id) [t] = await sql`update beta_tasks set title = ${title}, body = ${body}, closed = ${!!b.closed} where id = ${id} returning *`;
    else [t] = await sql`insert into beta_tasks (title, body, author) values (${title}, ${body}, ${a.label}) returning *`;
    if (!t) return fail("Задание не найдено.");
    await audit(a.label, "beta_task", title, { id: String(t.id), closed: t.closed });
    if (!id) {
      const rows = await sql`select tg_id from profiles where beta and tg_id is not null and not banned limit 100`;
      for (const r of rows) await send(String(r.tg_id), `🧪 <b>Новое задание для тестеров</b>\n${esc(title)}${body ? "\n\n" + esc(body.slice(0, 600)) : ""}\n\nОтметить результат: программа → «Панель тестера».`, { disable_notification: true });
    }
    return { ok: true };
  }
  if (op === "beta_task_delete") {
    const [t] = await sql`delete from beta_tasks where id = ${parseInt(b.id, 10) || 0} returning title`;
    if (!t) return fail("Задание не найдено.");
    await audit(a.label, "beta_task", t.title, { deleted: true });
    return { ok: true };
  }
  if (op === "flags_set") {
    if (a.kind !== "owner") return fail("Это доступно только владельцу.", { code: "forbidden" });
    const k = String(b.key || ""), mode = String(b.mode || "");
    if (!FLAG_DEFS[k] || !FLAG_MODES.includes(mode)) return fail("Неизвестная функция.");
    const s = (await getSetting("flags", {})) || {};
    s[k] = mode;
    await setSetting("flags", s);
    await audit(a.label, "flags", k, { mode });
    return { ok: true, flags: await flagsNow() };
  }
  return fail("Неизвестное действие панели.");
}
async function panelIdeas(b, a) {
  const sql = db();
  if (b.op === "ideas_list") {
    const st = IDEA_ST[b.status] ? String(b.status) : "";
    const rows = await sql`select i.*, p.login, p.nick, p.org, (select count(*)::int from idea_votes v where v.idea_id = i.id) as votes
                           from ideas i left join profiles p on p.id = i.user_id
                           where ${st ? sql`i.status = ${st}` : sql`true`}
                           order by ${b.sort === "new" ? sql`i.created_at desc` : sql`votes desc, i.created_at desc`} limit 200`;
    return { ok: true, ideas: rows.map((r) => ({ id: String(r.id), text: r.text, status: r.status, answer: r.answer, at: r.created_at, login: r.login, nick: r.nick, org: r.org, votes: r.votes })), statuses: IDEA_ST };
  }
  if (b.op === "ideas_set") {
    const id = parseInt(b.id, 10) || 0;
    const status = IDEA_ST[b.status] ? String(b.status) : "";
    if (!status) return fail("Выберите статус.");
    const answer = cleanText(b.answer, 600);
    const [old] = await sql`select * from ideas where id = ${id}`;
    if (!old) return fail("Идея не найдена.");
    const [r] = await sql`update ideas set status = ${status}, answer = ${answer}, updated_at = now() where id = ${id} returning *`;
    await audit(a.label, "idea", "№" + id, { status });
    if (r.user_id && (old.status !== status || old.answer !== answer))
      await sql`insert into broadcasts (user_id, title, author, text, expires_at)
                values (${r.user_id}, ${"💡 Ваша идея: " + IDEA_ST[status].toLowerCase()}, ${a.label},
                        ${`«${r.text.slice(0, 160)}${r.text.length > 160 ? "…" : ""}» — ${IDEA_ST[status].toLowerCase()}.${answer ? " Ответ: " + answer : ""}`}, now() + interval '14 days')`;
    return { ok: true };
  }
  if (b.op === "ideas_delete") {
    const [r] = await sql`delete from ideas where id = ${parseInt(b.id, 10) || 0} returning id`;
    if (!r) return fail("Идея не найдена.");
    await audit(a.label, "idea", "№" + r.id, { deleted: true });
    return { ok: true };
  }
  return fail("Неизвестное действие панели.");
}

// ───────────── Точка входа ─────────────
// ───────────── Законы и ИИ для программы и сайта (ключи только здесь), запросы из браузера ─────────────
// Секреты (Edge Functions → Secrets). С 2.2.1 ключей нет ни в программе, ни на сайте, оба ходят сюда:
//   LAWS_KEY   ключ расшифровки законов, тот же, что секрет LAWS_KEY на GitHub (им шифрует sync-laws)
//   AI_KEY     ключ доступа к ИИ-прокси, тот же, что APP_KEY (или WEB_KEY) у Worker
//   SITE_ORIGINS  необязательно: ещё адреса сайта через запятую (senko-assistant.site, www и pages.dev разрешены всегда)
const LAWS_KEY = Deno.env.get("LAWS_KEY") || "";
const AI_KEY = Deno.env.get("AI_KEY") || "";
const AI_URL = (Deno.env.get("AI_URL") || "https://senko-ai.senko-assistant.workers.dev").replace(/\/+$/, "");
const LAWS_BASE = Deno.env.get("LAWS_BASE") || "https://raw.githubusercontent.com/Kofemanchik/Senko-Assistant/main/update/";
const SITE_ORIGINS = ["https://senko-assistant.site", "https://www.senko-assistant.site", "https://senko-assistant.pages.dev", ...String(Deno.env.get("SITE_ORIGINS") || "").split(",").map((s) => s.trim().replace(/\/+$/, "")).filter(Boolean)];

function corsOrigin(req) {
  const o = String(req.headers.get("origin") || "");
  if (!o) return "";
  if (SITE_ORIGINS.includes(o)) return o;
  if (/^https:\/\/[a-z0-9-]+\.senko-assistant\.pages\.dev$/.test(o)) return o; // предпросмотр веток в Cloudflare Pages
  return "";
}
function withCors(req, res) {
  const o = corsOrigin(req);
  if (!o) return res;
  try {
    res.headers.set("access-control-allow-origin", o);
    res.headers.set("vary", "origin");
  } catch (e) {}
  return res;
}
function preflight(req) {
  const o = corsOrigin(req);
  if (!o) return new Response(null, { status: 403 });
  return new Response(null, {
    status: 204,
    headers: {
      "access-control-allow-origin": o,
      "access-control-allow-methods": "POST, GET, OPTIONS",
      "access-control-allow-headers": "content-type, apikey, authorization, x-client-info",
      "access-control-max-age": "86400",
      vary: "origin",
    },
  });
}

function b64(u8) {
  let s = "";
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  return btoa(s);
}
// Законы для программы и сайта: зашифрованный файл из репозитория расшифровывается здесь, ключ наружу не попадает.
// Отдаём gzip (base64): программа и браузер распаковывают сами. Копия держится в памяти функции.
let lawsCache = null; // { sig, updatedAt, count, gz, at }
let lawsStatusAt = 0;
async function lawsLoad(want) {
  // want: подпись, которую программа уже видит в laws-status.json; если копия старее, сверяемся раньше (не чаще раза в 30 с)
  const fresh = Date.now() - lawsStatusAt < (want && lawsCache && want !== lawsCache.sig ? 30 * 1000 : 5 * 60 * 1000);
  if (lawsCache && fresh) return lawsCache;
  let st = null;
  try {
    const r = await fetch(LAWS_BASE + "laws-status.json?t=" + Date.now(), { signal: AbortSignal.timeout(15000) });
    if (r.ok) st = await r.json();
  } catch (e) {}
  lawsStatusAt = Date.now();
  if (lawsCache && (!st || st.sig === lawsCache.sig)) return lawsCache;
  const r = await fetch(LAWS_BASE + "laws.enc?t=" + Date.now(), { signal: AbortSignal.timeout(60000) });
  if (!r.ok) throw new Error("GitHub вернул " + r.status);
  const buf = new Uint8Array(await r.arrayBuffer());
  if (buf.length < 32 || String.fromCharCode(...buf.subarray(0, 4)) !== "SLW1") throw new Error("неверный формат файла законов");
  const key = await crypto.subtle.importKey("raw", await crypto.subtle.digest("SHA-256", enc.encode(LAWS_KEY)), "AES-GCM", false, ["decrypt"]);
  const data = new Uint8Array(buf.length - 16);
  data.set(buf.subarray(32), 0);
  data.set(buf.subarray(16, 32), buf.length - 32); // WebCrypto ждёт тег в конце
  const gz = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: buf.subarray(4, 16) }, key, data));
  lawsCache = { sig: (st && st.sig) || (await sha256(b64(gz.subarray(0, 4096)))).slice(0, 40), updatedAt: (st && st.updatedAt) || 0, checkedAt: (st && st.checkedAt) || 0, ok: st ? st.ok !== false : true, gz, at: Date.now() };
  return lawsCache;
}
async function lawsApi(b) {
  const { err } = await who(b);
  if (err) return err;
  if (!LAWS_KEY) return fail("Законы с форума на сервере ещё не подключены. Сообщите владельцу.", { code: "laws_off" });
  let L;
  try {
    L = await lawsLoad(b.want ? String(b.want).slice(0, 80) : "");
  } catch (e) {
    console.error("laws", e);
    return fail("Не удалось получить законы. Попробуйте позже.", { code: "server" });
  }
  const meta = { sig: L.sig, updatedAt: L.updatedAt, checkedAt: L.checkedAt, srcOk: L.ok };
  if (b.sig && String(b.sig) === L.sig) return { ok: true, same: true, ...meta };
  if (b.plain) {
    const text = await new Response(new Blob([L.gz]).stream().pipeThrough(new DecompressionStream("gzip"))).text();
    return { ok: true, ...meta, data: JSON.parse(text) };
  }
  return { ok: true, ...meta, gz: b64(L.gz) };
}

// ИИ для программы и сайта: запрос подписывается здесь (ключ AI_KEY), лимит считается по аккаунту
async function hmacHex(secret, msg) {
  const k = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", k, enc.encode(msg)));
}
async function aiAsk(b) {
  const { p, err } = await who(b);
  if (err) return err;
  if (!AI_KEY) return fail("ИИ-помощник на сервере ещё не подключён. Сообщите владельцу.", { code: "ai_off" });
  let bonus = 0;
  try {
    await ensureXpAdj();
    const [r] = await db()`select ai_bonus from profiles where id = ${p.id}`;
    bonus = (r && r.ai_bonus) || 0;
  } catch (e) {
    console.error("ai_bonus", e);
  }
  if (!(await hit(`aiweb:${p.id}`, 60, 86400)) && bonus <= 0) return fail("Дневной лимит вопросов к ИИ исчерпан. Он обновится завтра.", { limit: true });
  const q = String(b.q == null ? "" : b.q).replace(/\s+/g, " ").trim().slice(0, 500);
  if (q.length < 3) return fail("Напишите вопрос подробнее.");
  const ctx = (Array.isArray(b.ctx) ? b.ctx : []).slice(0, 10).map((c) => ({ ref: clean(c && c.ref, 80), text: String((c && c.text) || "").slice(0, 2000) })).filter((c) => c.ref && c.text);
  const refs = ctx.map((c) => c.ref);
  const cid = (await sha256("web:" + p.id)).slice(0, 32);
  const ts = String(Date.now());
  // 2.7: встречный вопрос, если не хватает деталей (только в окне ИИ, не в голосовом помощнике)
  const clar = !b.short;
  let j = null, status = 0;
  try {
    const r = await fetch(AI_URL + "/ask", {
      method: "POST",
      headers: {
        "content-type": "application/json", "x-senko-cid": cid, "x-senko-ts": ts, "x-senko-sig": await hmacHex(AI_KEY, cid + "." + ts),
        ...(bonus > 0 ? { "x-senko-bsig": await hmacHex(AI_KEY, cid + "." + ts + ".b") } : {}),
      },
      body: JSON.stringify({ short: !!b.short, clar: clar, q, ctx }),
      signal: AbortSignal.timeout(35000),
    });
    status = r.status;
    try { j = await r.json(); } catch (e) {}
  } catch (e) {
    return fail("Не удалось связаться с ИИ-сервисом. Попробуйте позже.");
  }
  const logged = !(j && j.limit) ? await aiLog({ token: b.token, q, refs, ok: !!(j && j.ok), ans: j && j.ok ? j.answer : "" }).catch(() => null) : null;
  const logId = logged && logged.ok ? logged.id : "";
  if (!j || !j.ok) return fail((j && j.error) || "ИИ-сервис вернул ошибку (" + status + ").", { limit: !!(j && j.limit) });
  if (j.bonus && bonus > 0) {
    try {
      const [u] = await db()`update profiles set ai_bonus = greatest(ai_bonus - 1, 0) where id = ${p.id} returning ai_bonus`;
      bonus = u ? u.ai_bonus : bonus - 1;
    } catch (e) {
      console.error("ai_bonus spend", e);
    }
  }
  return { ok: true, answer: String(j.answer || ""), left: typeof j.left === "number" ? j.left : null, bonus, cached: !!j.cached, logId };
}

// 2.6.1: распознавание речи для рации. Запись идёт в ИИ-прокси (Whisper), обратно приходит только текст; здесь ничего не сохраняется
async function sttApi(b) {
  const { p, err } = await who(b);
  if (err) return err;
  if (!AI_KEY) return fail("Распознавание на сервере ещё не подключено.", { code: "ai_off" });
  const audio = typeof b.audio === "string" ? b.audio : "";
  if (audio.length < 2000 || audio.length > 1100000) return fail("Неверная запись.");
  if (!(await hit(`stt:${p.id}`, 500, 86400))) return fail("Дневной лимит распознавания исчерпан.", { limit: true });
  const prompt = String(b.prompt == null ? "" : b.prompt).replace(/\s+/g, " ").slice(0, 600);
  const cid = (await sha256("web:" + p.id)).slice(0, 32);
  const ts = String(Date.now());
  try {
    const r = await fetch(AI_URL + "/stt", {
      method: "POST",
      headers: { "content-type": "application/json", "x-senko-cid": cid, "x-senko-ts": ts, "x-senko-sig": await hmacHex(AI_KEY, cid + "." + ts) },
      body: JSON.stringify({ audio, prompt }),
      signal: AbortSignal.timeout(20000),
    });
    let j = null;
    try { j = await r.json(); } catch (e) {}
    if (!j || !j.ok) return fail((j && j.error) || "Распознавание вернуло ошибку (" + r.status + ").", { limit: !!(j && j.limit) });
    return { ok: true, text: String(j.text || "").slice(0, 600) };
  } catch (e) {
    return fail("Не удалось связаться с распознаванием.");
  }
}

Deno.serve(async (req) => withCors(req, await handle(req)));

async function handle(req) {
  try {
    if (req.method === "OPTIONS") return preflight(req);
    await ensureSchema();
    if (req.method === "GET") {
      const url = new URL(req.url);
      if (url.searchParams.has("setup")) return await setup(url);
      if (url.searchParams.has("s")) return await shareView(req, url);
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
}
