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

const DEPTS = ["LSPD", "LSCSD", "FIB", "SANG", "USSS"];
const GAME_ROLES = { off: "Сотрудник", pros: "Прокурор", adv: "Адвокат" };
const RANKS = { user: "Пользователь", leader: "Руководство", moderator: "Модератор памятки", owner: "Владелец" };
const LEGAL_VERSION = "2026-10-19.2"; // версия Политики и Условий; должна совпадать с VERSION в app/auth.html и app/index.html
const SYNC_KINDS = { thist: 1, dlog: 1, tests: 1, qstat: 1, xp: 1, daily: 1, streak: 1 }; // что синхронизируется между компьютерами
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
    `Роль в игре: ${GAME_ROLES[p.game_role] || p.game_role}`,
    `Дискорд: ${esc(p.discord)}`,
    `Номер в игре: ${esc(p.phone)}`,
  ];
  if (viewer === "owner") {
    L.push(`Телеграм: ${p.telegram ? esc(p.telegram) : "—"}`);
    L.push(`Telegram ID: ${p.tg_id == null ? "—" : p.tg_id}`);
    L.push(`Принял документы: ${p.legal_version || "—"}`);
  }
  L.push(`Регистрация: ${fmtDate(p.created_at)}`);
  L.push(`Был в сети: ${fmtDate(p.last_seen)}`);
  if (p.banned) L.push(`Причина блокировки: ${esc(p.ban_reason) || "—"}`);
  return L.join("\n");
}

// ───────────── Пользователи, сессии ─────────────
const banMsg = (p) => `Аккаунт заблокирован.${p.ban_reason ? " Причина: " + p.ban_reason + "." : ""} Связь: ${CONTACT}`;

function pub(p) {
  return {
    login: p.login,
    nick: p.nick,
    static: p.static_id,
    org: p.org,
    dept: p.dept || "",
    role: p.game_role,
    roleName: GAME_ROLES[p.game_role] || p.game_role,
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
    await sql`update profiles set last_seen = now() where id = ${p.id}`;
  }
  return p;
}

// Проверка сессии + права. Возвращает {p} или {err}
async function who(b, ranks) {
  const p = await sessionUser(b.token);
  if (!p) return { err: fail("Сессия недействительна. Войдите заново.", { code: "auth" }) };
  if (p.banned) {
    await db()`delete from sessions where user_id = ${p.id}`;
    return { err: fail(banMsg(p), { code: "banned" }) };
  }
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
  const nick = clean(b.nick, 40);
  if (nick.length < 2) return { error: "Укажите ник игрока." };
  const st = clean(b.static, 12);
  if (!/^[0-9A-Za-z-]{1,12}$/.test(st)) return { error: "Статик: до 12 символов, цифры или латиница." };
  if (!GAME_ROLES[b.role]) return { error: "Выберите роль." };
  let org = clean(b.org, 60);
  if (b.org === "other") org = clean(b.orgOther, 60);
  if (!org) return { error: "Укажите организацию." };
  if (b.org !== "other" && !DEPTS.includes(org)) return { error: "Выберите организацию из списка." };
  const discord = clean(b.discord, 40).replace(/^@/, "");
  if (!/^[A-Za-z0-9_.#-]{2,40}$/.test(discord)) return { error: "Дискорд: ник пользователя (латиница, цифры, «_», «.»)." };
  let telegram = clean(b.telegram, 60)
    .replace(/^https?:\/\/(t\.me|telegram\.me)\//i, "")
    .replace(/^@/, "");
  if (telegram && !/^[A-Za-z0-9_]{5,32}$/.test(telegram)) return { error: "Телеграм: ник вида @name (5–32 символа) или оставьте поле пустым." };
  if (telegram) telegram = "@" + telegram;
  const phone = String(b.phone == null ? "" : b.phone).replace(/[\s()+-]/g, "");
  if (!/^[0-9]{3,12}$/.test(phone)) return { error: "Номер в игре: только цифры (3–12 знаков)." };
  return { login, pass, nick, st, org, dept: DEPTS.includes(org) ? org : "", role: b.role, discord, telegram, phone };
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
  const code = newRecoveryCode();
  const codeHash = await sha256(normCode(code));
  let p;
  try {
    p = await sql.begin(async (t) => {
      const [row] = await t`
        insert into profiles (login, pass_hash, nick, static_id, org, dept, game_role, discord, telegram, phone, legal_version, legal_at)
        values (${v.login}, extensions.crypt(${v.pass}, extensions.gen_salt('bf', 10)), ${v.nick}, ${v.st}, ${v.org}, ${v.dept},
                ${v.role}, ${v.discord}, ${v.telegram}, ${v.phone}, ${clean(b.legal.version, 20)}, now())
        returning *`;
      await t`insert into recovery_codes (user_id, code_hash) values (${row.id}, ${codeHash})`;
      return row;
    });
  } catch (e) {
    if (e && e.code === "23505") return fail("Такой логин уже занят.");
    throw e;
  }
  const token = await newSession(p.id, !!b.remember);
  maybeCleanup();

  // Уведомление владельцу — сбой Telegram не должен ломать регистрацию
  try {
    if (OWNER_TG) {
      const dup = await sql`select login from profiles where lower(static_id) = lower(${p.static_id}) and id <> ${p.id}`;
      const [{ n }] = await sql`select count(*)::int as n from profiles`;
      let text = `🆕 <b>Новая регистрация</b>${b.migrated ? " (перенос локального аккаунта)" : ""}\n\n${card(p, "owner")}`;
      if (dup.length) text += `\n\n⚠️ Этот статик уже указан у: ${dup.map((d) => esc(d.login)).join(", ")}`;
      text += `\n\nВсего пользователей: ${n}`;
      await send(OWNER_TG, text);
    }
  } catch (e) {
    console.error("notify register", e);
  }
  return { ok: true, token, user: pub(p), recoveryCode: code };
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
  const [p] = await sql`select * from profiles where login_lc = ${lc}`;
  if (!p) {
    await sql`select extensions.crypt(${pass}, ${DUMMY_SALT})`;
    return fail("Неверный логин или пароль.");
  }
  const [{ ok }] = await sql`select extensions.crypt(${pass}, ${p.pass_hash}) = ${p.pass_hash} as ok`;
  if (!ok) return fail("Неверный логин или пароль.");
  if (p.banned) return fail(banMsg(p), { code: "banned" });
  await sql`delete from rate_limits where key = ${"lg:" + lc + ":" + ip}`;
  const token = await newSession(p.id, !!b.remember);
  await sql`update profiles set last_seen = now() where id = ${p.id}`;
  maybeCleanup();
  return { ok: true, token, user: pub(p) };
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

// Сводка по данным пользователей (для владельца)
async function userStats() {
  const rows = await db()`
    select user_id,
           count(*) filter (where kind = 'thist' and not deleted)::int as det,
           count(*) filter (where kind = 'tests' and not deleted)::int as tests,
           round(avg((data->>'p')::numeric) filter (where kind = 'tests' and not deleted))::int as avg_p,
           max((data#>>'{}')::int) filter (where kind = 'xp' and not deleted) as xp
    from sync_items group by user_id`;
  const m = {};
  for (const r of rows) m[r.user_id] = { det: r.det, tests: r.tests, avg_p: r.avg_p, xp: r.xp };
  return m;
}
const statLine = (s) => (s ? `Задержаний: ${s.det} · тестов: ${s.tests}${s.avg_p == null ? "" : " (средний результат " + s.avg_p + "%)"} · XP: ${s.xp == null ? 0 : s.xp}` : "Данных работы пока нет");

// ───────────── API: список сотрудников (состав полей зависит от ранга) ─────────────
async function staffList(b) {
  const { p, err } = await who(b, ["leader", "moderator", "owner"]);
  if (err) return err;
  const rows = await db()`select * from profiles order by created_at`;
  const stats = p.rank === "owner" ? await userStats() : {};
  const list = rows.map((r) => {
    const o = {
      login: r.login,
      nick: r.nick,
      static: r.static_id,
      org: r.org,
      role: r.game_role,
      rank: r.rank,
      created: r.created_at,
      discord: r.discord,
      phone: r.phone,
    };
    if (p.rank === "owner" || p.rank === "moderator") {
      o.banned = r.banned;
      o.ban_reason = r.ban_reason;
      o.last_seen = r.last_seen;
    }
    if (p.rank === "owner") {
      o.telegram = r.telegram;
      o.tg_id = r.tg_id == null ? null : String(r.tg_id);
      o.legal_version = r.legal_version;
      const st = stats[r.id] || {};
      o.det = st.det || 0;
      o.tests = st.tests || 0;
      o.avg_p = st.avg_p == null ? null : st.avg_p;
      o.xp = st.xp == null ? 0 : st.xp;
    }
    return o;
  });
  return { ok: true, viewer: p.rank, list };
}

// ───────────── API: сброс пароля ─────────────
async function resetRequest(b, ip) {
  if (!(await hit(`rr:${ip}`, 8, 3600))) return fail(RATE_MSG, { code: "rate" });
  const lc = clean(b.login, 24).toLowerCase();
  if (!lc || !(await hit(`rl:${lc}`, 5, 3600))) return fail(RATE_MSG, { code: "rate" });
  const sql = db();
  const [p] = await sql`select * from profiles where login_lc = ${lc}`;
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
      return J(err || { ok: true, user: pub(p) });
    }
    case "logout": {
      if (typeof b.token === "string" && /^[0-9a-f]{64}$/.test(b.token))
        await db()`delete from sessions where token_hash = ${await sha256(b.token)}`;
      return J({ ok: true });
    }
    case "staff_list":
      return J(await staffList(b));
    case "accept_legal":
      return J(await acceptLegal(b));
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

// ───────────── Бот ─────────────
async function actorOf(tgId) {
  const id = String(tgId);
  if (OWNER_TG && id === OWNER_TG) return { kind: "owner", tg: id, label: "owner" };
  const [m] = await db()`select * from profiles where tg_id = ${id} and rank = 'moderator' and not banned`;
  if (m) return { kind: "moderator", tg: id, label: "moderator:" + m.login, profile: m };
  return null;
}

const likeEsc = (s) => s.replace(/[\\%_]/g, (c) => "\\" + c);
const HELP_COMMON =
  "/find &lt;текст&gt; — поиск по логину, нику, статику, дискорду\n" +
  "/user &lt;логин&gt; — карточка пользователя\n" +
  "/ban &lt;логин&gt; [причина] — заблокировать\n" +
  "/unban &lt;логин&gt; — разблокировать\n" +
  "/resets — ожидающие запросы на сброс пароля\n";
const HELP_OWNER =
  "/role &lt;логин&gt; &lt;user|leader|moderator|owner&gt; [telegram_id] — выдать роль\n" +
  "/stats — статистика\n" +
  "/audit — последние действия\n";

async function findProfile(login) {
  const [p] = await db()`select * from profiles where login_lc = ${clean(login, 24).toLowerCase()}`;
  return p || null;
}

async function onMessage(m) {
  if (!m.from || !m.chat || m.chat.type !== "private") return;
  const text = String(m.text || "").trim();
  if (!text.startsWith("/")) return;
  const parts = text.split(/\s+/);
  const cmd = parts[0].slice(1).split("@")[0].toLowerCase();
  const args = parts.slice(1);
  const chat = m.chat.id;
  const a = await actorOf(m.from.id);

  if (cmd === "start" || cmd === "id" || cmd === "whoami") {
    return send(
      chat,
      `Senko Assistant.\nВаш Telegram ID: <code>${m.from.id}</code>\n` +
        (a ? `Доступ: ${a.kind === "owner" ? "владелец" : "модератор памятки"}. Команды: /help` : "Команды вам недоступны. Если вы модератор, сообщите этот ID владельцу.")
    );
  }
  if (!a) return send(chat, "Нет доступа.");

  switch (cmd) {
    case "help":
      return send(chat, "<b>Команды</b>\n" + HELP_COMMON + (a.kind === "owner" ? HELP_OWNER : ""));

    case "find": {
      const q = clean(args.join(" "), 40);
      if (q.length < 2) return send(chat, "Использование: /find &lt;текст&gt; (минимум 2 символа)");
      const like = "%" + likeEsc(q) + "%";
      const rows =
        a.kind === "owner"
          ? await db()`select * from profiles where login ilike ${like} or nick ilike ${like} or static_id ilike ${like} or discord ilike ${like} or telegram ilike ${like} order by created_at desc limit 10`
          : await db()`select * from profiles where login ilike ${like} or nick ilike ${like} or static_id ilike ${like} or discord ilike ${like} order by created_at desc limit 10`;
      if (!rows.length) return send(chat, "Ничего не найдено.");
      return send(
        chat,
        rows
          .map((r) => `• <code>${esc(r.login)}</code> — ${esc(r.nick)} · ${esc(r.static_id)} · ${esc(r.org)} · ${RANKS[r.rank]}${r.banned ? " 🚫" : ""}`)
          .join("\n") + "\n\nКарточка: /user &lt;логин&gt;"
      );
    }

    case "user": {
      if (!args[0]) return send(chat, "Использование: /user &lt;логин&gt;");
      const p = await findProfile(args[0]);
      if (!p) return send(chat, "Пользователь не найден.");
      return send(chat, card(p, a.kind) + (a.kind === "owner" ? "\n" + statLine((await userStats())[p.id]) : ""));
    }

    case "role": {
      if (a.kind !== "owner") return send(chat, "Роли выдаёт только владелец.");
      const p = args[0] ? await findProfile(args[0]) : null;
      const rank = String(args[1] || "").toLowerCase();
      const tgArg = args[2];
      if (!p || !RANKS[rank] || (tgArg && !/^\d{3,15}$/.test(tgArg)))
        return send(chat, "Использование: /role &lt;логин&gt; &lt;user|leader|moderator|owner&gt; [telegram_id]\nПользователь должен быть зарегистрирован.");
      if (rank === "moderator" && !tgArg && p.tg_id == null)
        return send(chat, "Для модератора нужен его Telegram ID: /role " + esc(p.login) + " moderator 123456789\nID покажет бот в ответ на /start, пусть модератор напишет боту.");
      const tgNew = rank === "user" ? null : tgArg ? tgArg : p.tg_id == null ? null : String(p.tg_id);
      try {
        await db()`update profiles set rank = ${rank}, tg_id = ${tgNew} where id = ${p.id}`;
      } catch (e) {
        if (e && e.code === "23505") return send(chat, "Этот Telegram ID уже привязан к другому аккаунту.");
        throw e;
      }
      await audit(a.label, "role", p.login, { from: p.rank, to: rank, tg_id: tgNew });
      return send(chat, `✅ ${esc(p.login)}: ${RANKS[p.rank]} → <b>${RANKS[rank]}</b>${tgNew ? `\nTelegram ID: <code>${tgNew}</code>` : ""}\nВ приложении изменение применится при следующем входе или в течение часа.`);
    }

    case "ban": {
      const p = args[0] ? await findProfile(args[0]) : null;
      if (!p) return send(chat, "Использование: /ban &lt;логин&gt; [причина]");
      if (p.rank === "owner") return send(chat, "Владельца заблокировать нельзя.");
      if (a.kind === "moderator" && p.rank === "moderator") return send(chat, "Модераторов блокирует только владелец.");
      const reason = clean(args.slice(1).join(" "), 200);
      await db()`update profiles set banned = true, ban_reason = ${reason}, banned_at = now() where id = ${p.id}`;
      // сессии не удаляем: при первом же запросе пользователь увидит причину блокировки (см. who())
      await db()`update reset_requests set status = 'cancelled' where user_id = ${p.id} and status in ('pending','approved')`;
      await audit(a.label, "ban", p.login, { reason });
      if (a.kind === "moderator" && OWNER_TG) await send(OWNER_TG, `ℹ️ ${esc(a.profile.login)} заблокировал <b>${esc(p.login)}</b>${reason ? ": " + esc(reason) : ""}`);
      return send(chat, `🚫 ${esc(p.login)} заблокирован${reason ? ": " + esc(reason) : ""}. Вход и работа в приложении закрыты сразу.`);
    }

    case "unban": {
      const p = args[0] ? await findProfile(args[0]) : null;
      if (!p) return send(chat, "Использование: /unban &lt;логин&gt;");
      await db()`update profiles set banned = false, ban_reason = '', banned_at = null where id = ${p.id}`;
      await audit(a.label, "unban", p.login, {});
      return send(chat, `✅ ${esc(p.login)} разблокирован.`);
    }

    case "resets": {
      const rows = await db()`
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
      if (a.kind !== "owner") return send(chat, "Статистика доступна только владельцу.");
      const sql = db();
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
      if (a.kind !== "owner") return send(chat, "Журнал доступен только владельцу.");
      const rows = await db()`select * from audit_log order by id desc limit 15`;
      if (!rows.length) return send(chat, "Журнал пуст.");
      return send(chat, rows.map((r) => `${fmtDate(r.at)} · ${esc(r.actor)} · ${esc(r.action)} · ${esc(r.target || "")}`).join("\n"));
    }

    default:
      return send(chat, "Неизвестная команда. /help");
  }
}

async function onCallback(cb) {
  const answer = (text, alert = false) => tg("answerCallbackQuery", { callback_query_id: cb.id, text, show_alert: alert });
  const a = cb.from ? await actorOf(cb.from.id) : null;
  if (!a) return answer("Нет доступа.", true);
  const m = /^rs:(ok|no):([0-9a-f-]{36})$/i.exec(String(cb.data || ""));
  if (!m) return answer("Неизвестное действие.");
  const approve = m[1] === "ok";
  const sql = db();
  let r;
  if (approve) {
    [r] = await sql`update reset_requests set status = 'approved', decided_by = ${a.label}, decided_at = now(),
                    expires_at = now() + make_interval(mins => ${RESET_APPROVED_MIN})
                    where id = ${m[2]} and status = 'pending' and expires_at > now() returning *`;
  } else {
    [r] = await sql`update reset_requests set status = 'rejected', decided_by = ${a.label}, decided_at = now()
                    where id = ${m[2]} and status = 'pending' and expires_at > now() returning *`;
  }
  const chat = cb.message && cb.message.chat ? cb.message.chat.id : null;
  if (cb.message) await tg("editMessageReplyMarkup", { chat_id: chat, message_id: cb.message.message_id, reply_markup: { inline_keyboard: [] } });
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
      { command: "ban", description: "Заблокировать" },
      { command: "unban", description: "Разблокировать" },
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
    return await api(req);
  } catch (e) {
    console.error(e);
    return J(fail("Ошибка сервера. Попробуйте позже."), 500);
  }
});
