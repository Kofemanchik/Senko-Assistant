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
const GAME_ROLES = { off: "Сотрудник", pros: "Прокурор", adv: "Адвокат", judge: "Судья" };
// Роль в игре с учётом организации: вне Government всегда «Сотрудник»
const gameRole = (p) => (p.org === GOV_ORG ? p.game_role : "off");
// 2.9: серверы Majestic RP. Номер — номер сервера в игре; форум нужен для сбора законов (scripts/servers.js хранит тот же список)
const SERVERS = { 12: { name: "Boston" }, 7: { name: "Los Angeles" }, 16: { name: "Denver" } };
const DEFAULT_SERVER = 12; // у всех, кто зарегистрировался до 2.9, и у старых программ без выбора сервера
const srvName = (n) => (SERVERS[n] ? `${SERVERS[n].name} (${n})` : `сервер ${n}`);
const parseServer = (v) => {
  const n = parseInt(v, 10);
  return SERVERS[n] ? n : 0;
};
const RANKS = { user: "Пользователь", leader: "Руководство", moderator: "Модератор памятки", owner: "Владелец" };
const LEGAL_VERSION = "2026-11-04"; // версия Политики и Условий; должна совпадать с VERSION в app/auth.html и app/index.html
const SYNC_KINDS = { thist: 1, dlog: 1, tests: 1, qstat: 1, xp: 1, daily: 1, streak: 1, favs: 1, notes: 1, labels: 1, folders: 1, favorder: 1 }; // что синхронизируется между компьютерами
const SYNC_MAX_ITEMS = 300; // элементов за один запрос
const SYNC_ITEM_BYTES = 65536; // размер одного элемента
const SYNC_USER_ROWS = 5000; // элементов на пользователя
const SESSION_DAYS = 60;
const SESSION_SHORT_HOURS = 24;
const SESSION_IDLE_DAYS = 30; // 3.7: вход, которым не пользовались 30 дней, завершается сам
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
    await db()`insert into audit_log (actor, action, target, details, server)
               values (${actor}, ${action}, ${target || null}, ${db().json(details || {})},
                       (select server from profiles where login_lc = lower(${target || ""}) limit 1))`;
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

// модераторы, которым нужны уведомления по серверу: их сервер или «все серверы»
async function moderatorChats(server = 0) {
  const rows = await db()`select tg_id from profiles where rank = 'moderator' and tg_id is not null and not banned and (${server}::int = 0 or staff_server = 0 or staff_server = ${server})`;
  return rows.map((r) => String(r.tg_id));
}

// Карточка пользователя; состав полей зависит от того, кто смотрит
function card(p, viewer) {
  const L = [
    `👤 <b>${esc(p.login)}</b> — ${RANKS[p.rank] || p.rank}${p.banned ? " 🚫 ЗАБЛОКИРОВАН" : ""}`,
    `Ник: ${esc(p.nick)}`,
    `Статик: <code>${esc(p.static_id)}</code>`,
    `Сервер: ${esc(srvName(p.server || DEFAULT_SERVER))}`,
    `Организация: ${esc(p.org)}${p.post ? " · " + esc(p.post) : ""}`,
    `Роль в игре: ${GAME_ROLES[gameRole(p)] || gameRole(p)}`,
    `Дискорд: ${esc(p.discord)}`,
    `Номер в игре: ${esc(p.phone || "—")}`,
  ];
  if (viewer === "owner") {
    L.push(`Телеграм: ${p.telegram ? esc(p.telegram) : "—"}`);
    L.push(`Telegram ID: ${p.tg_id == null ? "—" : p.tg_id}`);
    L.push(`Принял документы: ${p.legal_version || "—"}`);
  }
  if (p.bio) L.push(`О себе: ${esc(p.bio)}`);
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
    server: p.server || DEFAULT_SERVER,
    serverName: (SERVERS[p.server || DEFAULT_SERVER] || { name: "" }).name,
    staffServer: p.staff_server || 0,
    role: gameRole(p),
    roleName: GAME_ROLES[gameRole(p)] || gameRole(p),
    rank: p.rank,
    rankName: RANKS[p.rank] || p.rank,
    discord: p.discord,
    telegram: p.telegram,
    phone: p.phone,
    needLegal: p.legal_version !== LEGAL_VERSION,
    beta: !!p.beta,
    post: p.post || "",
    bio: p.bio || "",
    hideDiscord: !!p.hide_discord,
    dcLinked: !!p.discord_uid,
    totp: !!p.totp_on,
    dcName: p.discord_uname || "",
    judgePos: p.judge_pos || "",
    pvs: !!p.pvs,
  };
}

async function newSession(userId, remember, b, ip) {
  const token = rand(32);
  const hours = remember ? SESSION_DAYS * 24 : SESSION_SHORT_HOURS;
  // 3.7: у входа запоминаем устройство — список «Мои устройства» в кабинете и выход с одного из них
  await db()`insert into sessions (token_hash, user_id, expires_at, remember, ver, os, ip)
             values (${await sha256(token)}, ${userId}, now() + make_interval(hours => ${hours}), ${!!remember},
                     ${clean(b && b.ver, 30)}, ${clean(b && b.os, 40)}, ${ipShort(ip)})`;
  return token;
}

async function sessionUser(token) {
  if (typeof token !== "string" || !/^[0-9a-f]{64}$/.test(token)) return null;
  const sql = db();
  const th = await sha256(token);
  const [p] = await sql`
    select p.*, s.remember as s_remember, s.last_used as s_last_used
    from sessions s join profiles p on p.id = s.user_id
    where s.token_hash = ${th} and s.expires_at > now()
      and coalesce(s.last_used, s.created_at) > now() - make_interval(days => ${SESSION_IDLE_DAYS})`;
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
  // старые версии программы сервер не присылают — это Boston; неизвестный номер не принимаем
  const server = b.server == null || b.server === "" ? DEFAULT_SERVER : parseServer(b.server);
  if (!server) return { error: "Выберите сервер из списка." };
  return { login, pass, ...f, org, dept: DEPTS.includes(org) ? org : "", role: b.role, server };
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
  // 3.8: код-приглашение от руководства: организация и сервер берутся из приглашения, подтверждение не нужно
  let inv = null;
  if (b.invite && String(b.invite).trim()) {
    inv = await inviteFind(b.invite);
    if (!inv) return fail("Код приглашения не подходит: он неверный, истёк или уже использован. Уточните код у руководства или очистите поле.", { code: "invite" });
    b = { ...b, org: inv.org, server: inv.server, role: b.role !== "off" && inv.org !== GOV_ORG ? "off" : b.role };
  }
  const v = validate(b);
  if (v.error) return fail(v.error);
  if (!(await serverOpen(v.server, null))) return fail(`Сервер ${srvName(v.server)} пока доступен только бета-тестерам. Выберите Boston (12): сервер можно будет сменить в личном кабинете, когда он откроется.`, { code: "server_closed" });
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
  const pend = (v.role === "judge") || (!inv && !!(await getSetting("approval", { on: false })).on); // приём новичков: аккаунт ждёт подтверждения руководства (по приглашению — сразу)
  let p;
  try {
    p = await sql.begin(async (t) => {
      const [row] = await t`
        insert into profiles (login, pass_hash, nick, static_id, org, dept, game_role, discord, telegram, phone, legal_version, legal_at, approval, server)
        values (${v.login}, extensions.crypt(${v.pass}, extensions.gen_salt('bf', 10)), ${v.nick}, ${v.st}, ${v.org}, ${v.dept},
                ${v.role}, ${v.discord}, ${v.telegram}, ${v.phone}, ${clean(b.legal.version, 20)}, now(), ${pend ? "pending" : "ok"}, ${v.server})
        returning *`;
      await t`insert into recovery_codes (user_id, code_hash) values (${row.id}, ${codeHash})`;
      return row;
    });
  } catch (e) {
    if (e && e.code === "23505") return fail("Такой логин уже занят.");
    throw e;
  }
  const token = pend ? null : await newSession(p.id, !!b.remember, b, ip);
  await logIn(p.id, "register", b, ip);
  if (inv) await inviteUse(inv, p);
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
  await postHook(p.org, sv(p), "join", pend ? "🆕 Заявка в организацию" : "🆕 Новый сотрудник", `**${esc(p.nick)}** (статик ${esc(p.static_id)}) зарегистрировался в Senko Assistant${pend ? " и ждёт подтверждения руководства: /pending в боте или панель руководителя в программе." : "."}`, 0x2e7d4f);
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
  if (b.op === "end_one") {
    const id = String(b.id || "");
    if (!/^[0-9a-f]{16}$/.test(id)) return fail("Устройство не найдено.");
    if (th.startsWith(id)) return fail("Это устройство — текущее. Чтобы выйти с него, нажмите «Выйти».");
    if (!(await hit(`eo:${p.id}`, 30, 3600))) return fail(RATE_MSG, { code: "rate" });
    const r = await sql`delete from sessions where user_id = ${p.id} and left(token_hash, 16) = ${id} returning os, ver`;
    if (!r.length) return fail("Этот вход уже завершён.");
    await logIn(p.id, "device_end", { ver: r[0].ver, os: r[0].os }, ip);
    return { ok: true, ended: r.length };
  }
  const list = await sql`select at, kind, ver, os, ip from login_log where user_id = ${p.id} order by at desc limit 30`;
  const devs = await sql`select token_hash, created_at, last_used, ver, os, ip, remember from sessions
                         where user_id = ${p.id} and expires_at > now() and coalesce(last_used, created_at) > now() - make_interval(days => ${SESSION_IDLE_DAYS})
                         order by coalesce(last_used, created_at) desc limit 30`;
  const others = devs.filter((d) => d.token_hash !== th).length;
  return {
    ok: true,
    list: list.map((r) => ({ at: new Date(r.at).getTime(), kind: r.kind, ver: r.ver, os: r.os, ip: r.ip })),
    others,
    devices: devs.map((d) => ({ id: d.token_hash.slice(0, 16), cur: d.token_hash === th, at: new Date(d.created_at).getTime(), last: new Date(d.last_used || d.created_at).getTime(), ver: d.ver || "", os: d.os || "", ip: d.ip || "", remember: !!d.remember })),
    idleDays: SESSION_IDLE_DAYS,
    totp: !!p.totp_on,
  };
}
// ───────────── 3.7: вход с кодом из приложения (TOTP, RFC 6238) ─────────────
// Секрет — 20 случайных байт в base32; коды из Google Authenticator, Яндекс Ключа, Aegis и т. п. Код живёт 30 с, принимаем соседние шаги (±30 с).
// Один и тот же код дважды не принимается (totp_last). Резервные коды — 8 штук по 8 символов, каждый срабатывает один раз.
const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
function b32enc(bytes) {
  let bits = 0, val = 0, out = "";
  for (const x of bytes) {
    val = (val << 8) | x; bits += 8;
    while (bits >= 5) { out += B32[(val >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(val << (5 - bits)) & 31];
  return out;
}
function b32dec(s) {
  const out = [];
  let bits = 0, val = 0;
  for (const ch of String(s).toUpperCase().replace(/[^A-Z2-7]/g, "")) {
    val = (val << 5) | B32.indexOf(ch); bits += 5;
    if (bits >= 8) { out.push((val >>> (bits - 8)) & 255); bits -= 8; }
  }
  return new Uint8Array(out);
}
async function totpCode(secret, step) {
  const key = await crypto.subtle.importKey("raw", b32dec(secret), { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
  const msg = new Uint8Array(8);
  let c = step;
  for (let i = 7; i >= 0; i--) { msg[i] = c & 255; c = Math.floor(c / 256); }
  const h = new Uint8Array(await crypto.subtle.sign("HMAC", key, msg));
  const o = h[19] & 15;
  const n = (((h[o] & 127) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3]) % 1e6;
  return String(n).padStart(6, "0");
}
// Возвращает шаг времени принятого кода или 0
async function totpMatch(secret, code, last) {
  code = String(code == null ? "" : code).replace(/\D/g, "");
  if (!secret || code.length !== 6) return 0;
  const t = Math.floor(Date.now() / 30000);
  for (const d of [0, -1, 1]) if (t + d > (+last || 0) && safeEq(await totpCode(secret, t + d), code)) return t + d;
  return 0;
}
const backupNorm = (c) => String(c == null ? "" : c).toLowerCase().replace(/[^a-z0-9]/g, "");
// Проверка кода пользователя (из приложения или резервного). Удачный код сразу «тратится».
async function otpCheck(p, code) {
  const sql = db();
  const step = await totpMatch(p.totp_secret, code, p.totp_last);
  if (step) {
    const r = await sql`update profiles set totp_last = ${step} where id = ${p.id} and totp_last < ${step} returning id`;
    return r.length ? "app" : "";
  }
  const bc = backupNorm(code);
  if (bc.length !== 8) return "";
  const h = await sha256("bk:" + bc);
  const r = await sql`update profiles set totp_backup = array_remove(totp_backup, ${h}) where id = ${p.id} and ${h} = any(totp_backup) returning cardinality(totp_backup) as left`;
  if (!r.length) return "";
  if (r[0].left <= 2) await secNotice(p, "🔑 Заканчиваются резервные коды", `Осталось резервных кодов: ${r[0].left}. Создайте новые в личном кабинете (Безопасность → Вход с кодом).`);
  return "backup";
}
// Шлюз при входе: включена защита — нужен верный код (b.otp). Возвращает ошибку или null.
async function otpGate(p, b, ip, where) {
  if (!p.totp_on || !p.totp_secret) return null;
  const code = String(b.otp == null ? "" : b.otp).trim();
  // недописанный код попыткой не считается
  if (code.replace(/\D/g, "").length !== 6 && backupNorm(code).length !== 8) return fail("Введите код из приложения-аутентификатора (или резервный код). Если поля для кода нет, обновите программу.", { code: "otp" });
  if (!(await hit(`otp:${p.id}`, 8, 900))) return fail(RATE_MSG, { code: "rate" });
  const kind = await otpCheck(p, code);
  if (!kind) {
    await logIn(p.id, "otp_fail", { ver: where || (b && b.ver), os: b && b.os }, ip);
    return fail("Неверный код. Проверьте время на телефоне и введите новый код.", { code: "otp", bad: true });
  }
  if (kind === "backup") await logIn(p.id, "otp_backup", { ver: where || (b && b.ver), os: b && b.os }, ip);
  return null;
}
// Сообщение пользователю в программе (раздел уведомлений), живёт 7 дней
async function secNotice(p, title, text) {
  try {
    await db()`insert into broadcasts (user_id, title, author, text, expires_at) values (${p.id}, ${title}, 'system', ${text}, now() + interval '7 days')`;
  } catch (e) {
    console.error("secNotice", e);
  }
}
// 3.7: после удачного входа — предупреждение, если с прошлого входа были 5+ неудачных попыток
async function secAfterLogin(p, b, ip) {
  try {
    const sql = db();
    const [r] = await sql`select count(*)::int as n, max(at) as last from login_log
                          where user_id = ${p.id} and kind in ('fail', 'otp_fail')
                            and at > coalesce((select max(at) from login_log where user_id = ${p.id} and kind = 'login'), now() - interval '30 days')`;
    if (r && r.n >= 5)
      await secNotice(p, "⚠️ Были неудачные попытки входа",
        `С прошлого входа в ваш аккаунт пытались войти с неверным паролем или кодом: ${r.n} раз(а), последняя попытка ${fmtDate(new Date(r.last))}.\nЕсли это были не вы, смените пароль и включите вход с кодом (Личный кабинет → Безопасность).`);
  } catch (e) {
    console.error("secAfterLogin", e);
  }
}
async function totpApi(b, ip) {
  const { p, err } = await who(b);
  if (err) return err;
  const sql = db();
  const op = String(b.op || "status");
  const left = (p.totp_backup || []).length;
  if (op === "status") return { ok: true, on: !!p.totp_on, backupLeft: left };
  if (!(await hit(`tp:${p.id}`, 20, 900))) return fail(RATE_MSG, { code: "rate" });
  const newCodes = async () => {
    const codes = [], hashes = [];
    for (let i = 0; i < 8; i++) {
      const c = rand(4);
      codes.push(c.slice(0, 4) + "-" + c.slice(4));
      hashes.push(await sha256("bk:" + c));
    }
    return { codes, hashes };
  };
  if (op === "setup") {
    if (p.totp_on) return fail("Вход с кодом уже включён.");
    const secret = b32enc(crypto.getRandomValues(new Uint8Array(20)));
    await sql`update profiles set totp_pending = ${secret} where id = ${p.id}`;
    const label = encodeURIComponent("Senko Assistant:" + p.login);
    const uri = `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent("Senko Assistant")}&algorithm=SHA1&digits=6&period=30`;
    return { ok: true, secret: secret.replace(/(.{4})/g, "$1 ").trim(), uri };
  }
  if (op === "enable") {
    if (p.totp_on) return fail("Вход с кодом уже включён.");
    if (!p.totp_pending) return fail("Начните заново: нажмите «Включить вход с кодом».");
    const step = await totpMatch(p.totp_pending, b.code, 0);
    if (!step) return fail("Код не подошёл. Проверьте, что время на телефоне точное, и введите новый код.");
    const { codes, hashes } = await newCodes();
    await sql`update profiles set totp_secret = totp_pending, totp_pending = null, totp_on = true, totp_last = ${step}, totp_backup = ${hashes} where id = ${p.id}`;
    await logIn(p.id, "totp_on", b, ip);
    await audit(p.login, "totp_on", p.login, {});
    if (p.tg_id) await tg("sendMessage", { chat_id: p.tg_id, text: "🔐 В Senko Assistant включён вход с кодом из приложения." }).catch(() => null);
    return { ok: true, on: true, codes, backupLeft: codes.length };
  }
  if (!p.totp_on) return fail("Вход с кодом выключен.");
  // выключение и новые резервные коды — только с паролем и кодом
  const pass = String(b.password == null ? "" : b.password);
  const [{ ok }] = await sql`select extensions.crypt(${pass}, ${p.pass_hash}) = ${p.pass_hash} as ok`;
  if (!pass || !ok) {
    await logIn(p.id, "fail", b, ip);
    return fail("Неверный пароль.");
  }
  if (!(await otpCheck(p, b.code))) {
    await logIn(p.id, "otp_fail", b, ip);
    return fail("Неверный код из приложения.");
  }
  if (op === "disable") {
    await sql`update profiles set totp_on = false, totp_secret = null, totp_pending = null, totp_backup = '{}' where id = ${p.id}`;
    await logIn(p.id, "totp_off", b, ip);
    await audit(p.login, "totp_off", p.login, {});
    await secNotice(p, "🔓 Вход с кодом выключен", "Для входа снова нужен только пароль. Если это сделали не вы, срочно смените пароль.");
    if (p.tg_id) await tg("sendMessage", { chat_id: p.tg_id, text: "🔓 В Senko Assistant выключен вход с кодом. Если это были не вы, смените пароль." }).catch(() => null);
    return { ok: true, on: false };
  }
  if (op === "backup") {
    const { codes, hashes } = await newCodes();
    await sql`update profiles set totp_backup = ${hashes} where id = ${p.id}`;
    await logIn(p.id, "totp_codes", b, ip);
    return { ok: true, on: true, codes, backupLeft: codes.length };
  }
  return fail("Неизвестное действие.");
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
  const oe = await otpGate(p, b, ip);
  if (oe) return oe;
  await sql`delete from rate_limits where key = ${"lg:" + lc + ":" + ip} or key = ${"lf:" + lc}`;
  const token = await newSession(p.id, !!b.remember, b, ip);
  await sql`update profiles set last_seen = now() where id = ${p.id}`;
  await secAfterLogin(p, b, ip);
  await noteClient(p, b, ip);
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
  ["server", "server", "Сервер"],
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
  // сервер: не указан — остаётся прежним (старые версии программы его не присылают)
  v.server = b.server == null || b.server === "" ? p.server || DEFAULT_SERVER : parseServer(b.server);
  if (!v.server) return fail("Выберите сервер из списка.");
  if (!(await serverOpen(v.server, p))) return fail(`Сервер ${srvName(v.server)} пока доступен только бета-тестерам.`, { code: "server_closed" });
  const shown = (k, x) => (k === "server" ? srvName(+x || DEFAULT_SERVER) : String(x == null ? "" : x));
  const changes = PROFILE_FIELDS.filter(([k, col]) => String(p[col] || (k === "server" ? DEFAULT_SERVER : "")) !== String(v[k])).map(([k, col, label]) => ({ label, from: shown(k, p[col]), to: shown(k, v[k]) }));
  if (!changes.length) return { ok: true, user: pub(p), changed: 0 };
  const sql = db();
  const orgChanged = v.org !== p.org;
  const srvChanged = v.server !== (p.server || DEFAULT_SERVER);
  // при смене сервера руководство снимается (у каждого сервера своё руководство), профили коллег закрываются на 24 часа, как при смене организации
  const demote = srvChanged && p.rank === "leader";
  const [np] = await sql`update profiles set nick = ${v.nick}, static_id = ${v.st}, discord = ${v.discord}, telegram = ${v.telegram}, phone = ${v.phone},
                           org = ${v.org}, dept = ${orgChanged ? v.org : p.dept}, server = ${v.server},
                           rank = ${demote ? "user" : p.rank},
                           judge_pos = ${orgChanged || srvChanged ? "" : p.judge_pos || ""}, pvs = ${orgChanged || srvChanged ? false : !!p.pvs},
                           game_role = ${(orgChanged || srvChanged) && p.game_role === "judge" ? "off" : p.game_role},
                           org_at = ${orgChanged || srvChanged ? new Date() : p.org_at || null}
                         where id = ${p.id} returning *`;
  await audit(p.login, "profile_update", p.login, { changes });
  // Уведомление владельцу о каждой смене — сбой Telegram не должен ломать сохранение
  try {
    if (OWNER_TG) {
      let text = `✏️ <b>Изменение данных</b>: <code>${esc(p.login)}</code> · ${esc(p.org)}\n\n` +
        changes.map((c) => `${c.label}: ${esc(c.from) || "—"} → <b>${esc(c.to) || "—"}</b>`).join("\n");
      if (demote) text += `\n\n🔄 Сервер сменился, роль «Руководство» снята: ${esc(p.login)}. Выдать заново для нового сервера: /role ${esc(p.login)} leader`;
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
  const srv = staffSrvOpt(p, b); // руководство и ограниченный модератор видят только свой сервер; владелец — выбранный или все
  const rows = await db()`select * from profiles where ${scope ? db()`org = ${scope}` : db()`true`} and ${srv ? db()`server = ${srv}` : db()`true`} order by created_at`;
  const stats = await userStats();
  const wk = Object.fromEntries((await weekStats(scope, undefined, false, srv)).map((x) => [x.id, x]));
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
      server: r.server || DEFAULT_SERVER,
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
  return { ok: true, viewer: p.rank, scope, server: srv || 0, servers: srv ? [srv] : Object.keys(SERVERS).map(Number), orgs: scope ? [scope] : DEPTS, list };
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
  if (b.action !== "sync" && b.action !== "xfer" && !(b.action === "panel" && raw.length <= 40000) && !(b.action === "ai_ask" && raw.length <= 80000) && !(b.action === "panel" && b.op === "ads_save" && raw.length <= 700000) && !(b.action === "bug_report" && raw.length <= 700000) && !(b.action === "stt" && raw.length <= 1200000) && !(b.action === "share" && raw.length <= 40000) && !(b.action === "colleagues" && raw.length <= 40000) && !(b.action === "handoff" && raw.length <= 70000) && raw.length > 8192) return J(fail("Слишком большой запрос."), 413);
  const ip = req.headers.get("cf-connecting-ip") || (req.headers.get("x-forwarded-for") || "").split(",")[0].trim() || "unknown";
  switch (b.action) {
    case "register":
      return J(await register(b, ip));
    case "login":
      return J(await login(b, ip));
    case "me": {
      const { p, err } = await who(b);
      if (err) return J(err);
      await noteClient(p, b, ip);
      return J({ ok: true, user: pub(p), sys: await sysFor(p), web: { laws: !!LAWS_KEY, ai: !!AI_KEY } });
    }
    case "laws":
      return J(await lawsApi(b));
    // 3.5: публичный сайт (без входа): справочник кодексов, калькулятор, лента изменений законов, цифры проекта, сообщение об ошибке
    case "pub_laws":
      return J(await pubLaws(b, ip));
    case "pub_court":
      return J(await pubCourt(b, ip));
    case "pub_court_ai":
      return J(await pubCourtAi(b, ip));
    case "pub_changes":
      return J(await pubChanges(b, ip));
    case "pub_stats":
      return J(await pubStats(ip));
    case "pub_bug":
      return J(await pubBug(b, ip));
    // 3.5.3: вход через Discord (OAuth2): программа, веб-версия, панель; привязка Discord к аккаунту в кабинете
    case "dc_auth_start":
      return J(await dcAuthStart(b, ip));
    case "dc_auth_cb":
      return J(await dcAuthCallback(b, ip));
    case "dc_auth_poll":
      return J(await dcAuthPoll(b, ip, req.headers.get("user-agent") || ""));
    case "dc_unlink":
      return J(await dcUnlink(b));
    case "srv_cfg":
      return J(await srvCfgApi(b));
    case "pub_board":
      return J(await pubBoard(b, ip));
    case "pub_board_opt":
      return J(await pubBoardOpt(b));
    case "ai_ask":
      return J(await aiAsk(b));
    case "ai_plan":
      return J(await aiPlan(b));
    case "stt":
      return J(await sttApi(b));
    case "panel":
      return J(await panelApi(b, ip, req.headers.get("user-agent") || ""));
    case "bug_report":
      return J(await bugReport(b));
    case "my_stats":
      return J(await myStats(b));
    case "month":
      return J(await monthApi(b));
    case "dl":
      return J(await dlHit(ip));
    case "week_board":
      return J(await weekBoardApi(b));
    case "shift":
      return J(await shiftApi(b));
    case "ctrl":
      return J(await ctrlApi(b));
    case "reports":
      return J(await reportsApi(b));
    case "vac":
      return J(await vacApi(b));
    case "court":
      return J(await courtApi(b));
    case "tabel":
      return J(await tabelApi(b));
    case "share":
      return J(await shareApi(b));
    case "xfer":
      return J(await xferApi(b));
    case "misses":
      return J(await missesApi(b));
    case "contacts":
      return J(await contactsApi(b));
    case "org_join":
      return J(await orgJoinApi(b));
    case "org_join_admin":
      return J(await orgJoinAdmin(b));
    case "totp":
      return J(await totpApi(b, ip));
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
    case "glossary":
      return J(await glossApi(b));
    case "qr_login":
      return J(await qrLoginApi(b, ip));
    case "ai_hist":
      return J(await aiHist(b));
    case "ai_check":
      return J(await aiCheck(b));
    case "colleagues":
      return J(await colleaguesApi(b));
    case "handoff":
      return J(await handoffApi(b));
    case "sync_reset":
      return J(await syncReset(b));
    case "logout": {
      if (typeof b.token === "string" && /^[0-9a-f]{64}$/.test(b.token))
        await db()`delete from sessions where token_hash = ${await sha256(b.token)}`;
      return J({ ok: true });
    }
    case "staff_list":
      return J(await staffList(b));
    // 3.5: журнал действий руководства и отчёт организации за неделю (панель руководителя в программе)
    case "lead_log":
      return J(await leadLog(b));
    // 3.6: объявления руководства из программы и отметка «прочитал»
    case "org_news":
      return J(await orgNews(b));
    case "notice_read":
      return J(await noticeRead(b));
    case "org_week":
      return J(await orgWeek(b));
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
    case "discord":
      return J(await discordApi(b));
    case "svc":
      return J(await svcApi(b));
    default:
      return J(fail("Неизвестное действие."), 400);
  }
}

// ───────────── Этап 10: ссылки «Поделиться», перенос по коду, поиски без результата ─────────────
const SHARE_DAYS = 30; // сколько живёт ссылка на расчёт или набор
const SHARE_KINDS = { calc: "Расчёт", set: "Набор статей", board: "Тактическая доска", myq: "Вопросы для тренажёра", ttest: "Тест для стажёра", cmp: "Результаты тренажёра" };
// 3.8: виды ссылок, которые несут свои данные (JSON) вместо списка статей
const SHARE_DATA = { board: 1, myq: 1, ttest: 1, cmp: 1 };
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
    // 2.4: доска передаёт рисунок (JSON) вместо статей; 3.8: так же вопросы, тест для стажёра и результаты тренажёра
    const isData = !!SHARE_DATA[kind];
    const board = isData ? String(b.data == null ? "" : b.data) : "";
    if (isData) {
      let ok = board.length >= 10 && board.length <= 30000;
      try { ok = ok && typeof JSON.parse(board) === "object"; } catch (e) { ok = false; }
      if (!ok) return fail(kind === "board" ? "Доска пустая или слишком большая." : "Данные пустые или слишком большие.");
      if (kind !== "board" && kind !== "cmp" && (await blacklisted(board))) return fail("В тексте есть недопустимое слово.");
    }
    if (!ids.length && !isData) return fail("Добавьте статьи, чтобы поделиться.");
    const body = isData ? board : cleanText(b.text, 3000);
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
    return { ok: true, share: { code, kind: r.kind, title: r.title, ids: r.ids, author: r.author, at: new Date(r.created_at).getTime(), data: SHARE_DATA[r.kind] ? r.body : undefined } };
  }
  // 3.8 (п. 72): стажёр прошёл тест старшего — результат видит только автор теста
  if (op === "result") {
    if (!(await hit(`sr:${p.id}`, 30, 3600))) return fail(RATE_MSG, { code: "rate" });
    const code = shareCode(b.code);
    const [r] = code.length === 8 ? await sql`select code, kind from shares where code = ${code} and created_at > now() - make_interval(days => ${SHARE_DAYS})` : [];
    if (!r || r.kind !== "ttest") return fail("Тест не найден или устарел.");
    const n = Math.max(1, Math.min(100, parseInt(b.n, 10) || 0)), sc = Math.max(0, Math.min(n, parseInt(b.s, 10) || 0));
    const wrong = (Array.isArray(b.wrong) ? b.wrong : []).slice(0, 100).map((w) => cleanText(w, 200));
    await sql`insert into share_results (code, user_id, nick, login, s, n, wrong) values (${code}, ${p.id}, ${p.nick || p.login}, ${p.login}, ${sc}, ${n}, ${JSON.stringify(wrong)}::jsonb)
              on conflict (code, user_id) do update set s = excluded.s, n = excluded.n, wrong = excluded.wrong, at = now()`;
    return { ok: true };
  }
  if (op === "results") {
    const code = shareCode(b.code);
    const [r] = code.length === 8 ? await sql`select user_id, title from shares where code = ${code}` : [];
    if (!r) return fail("Тест не найден или устарел.");
    if (r.user_id !== p.id) return fail("Результаты видит только автор теста.");
    const rows = await sql`select nick, login, s, n, wrong, at from share_results where code = ${code} order by at desc limit 100`;
    return { ok: true, title: r.title, rows: rows.map((x) => ({ nick: x.nick, login: x.login, s: x.s, n: x.n, wrong: x.wrong || [], at: new Date(x.at).getTime() })) };
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
  const t = `Senko Assistant · ${SHARE_KINDS[r.kind] || "Ссылка"}${r.title ? ": " + r.title : ""}\nОт: ${r.author} · ${fmtDate(r.created_at)}\n\n${r.kind === "board" ? "Схема на карте зон: откройте её в программе." : SHARE_DATA[r.kind] ? "Откройте в программе: Обучение → Тренажёр → «Ввести код»." : r.body || ""}\n\n` +
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
// Boston хранится как раньше (laws-status.json), остальные серверы — с номером (laws-status-7.json): scripts/servers.js
const lawsSfx = (n) => (n === DEFAULT_SERVER ? "" : "-" + n);
const lawsStatusUrl = (n) => (n === DEFAULT_SERVER ? LAWS_STATUS_URL : LAWS_STATUS_URL.replace(/laws-status\.json$/, "laws-status" + lawsSfx(n) + ".json"));
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
                          where expires_at > now() and ((org is null and user_id is null and (server is null or server = ${sv(p)})) or (org = ${p.org} and (server is null or server = ${sv(p)})) or user_id = ${p.id})
                          order by created_at desc limit 5`;
  const ctrl = await db()`select t.id, t.title, t.topics, t.n, t.due_at from control_tests t
                          where t.org = ${p.org} and t.server = ${sv(p)} and not t.closed and t.due_at > now() and t.author_id is distinct from ${p.id}
                            and not exists (select 1 from control_results r where r.test_id = t.id and r.user_id = ${p.id})
                          order by t.due_at limit 5`;
  const flags = await flagsNow();
  const events = flags.events === "off" ? [] : (await eventsFor(p.org, 14, sv(p))).slice(0, 5).map((e) => evOut(e, p));
  return {
    flags,
    tester: isTester(p),
    svc: flags.svc32 === "all" || (flags.svc32 === "beta" && isTester(p)),
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
async function noteClient(p, b, ip) {
  const ver = appVer(b);
  const dev = clean(b.device, 40);
  const sql = db();
  if (ver && ver !== p.app_version) await sql`update profiles set app_version = ${ver} where id = ${p.id}`;
  if (!dev) return;
  const h = (await sha256("dev:" + dev)).slice(0, 16);
  const known = p.devices || [];
  if (known.includes(h)) return;
  await sql`update profiles set devices = (array_append(devices, ${h}))[greatest(1, cardinality(devices) - 8):] where id = ${p.id}`;
  if (!known.length) return;
  // 3.7: о новом устройстве узнаёт и сам пользователь — сообщением в программе
  const where = [clean(b.os, 40), clean(b.ver, 30), ipShort(ip) ? "IP " + ipShort(ip) : ""].filter(Boolean).join(", ");
  await secNotice(p, "🔐 Вход с нового устройства",
    `В ваш аккаунт вошли с нового устройства${where ? ": " + where : ""}, ${fmtDate(new Date())}.\nЕсли это были не вы, завершите этот вход в личном кабинете (Безопасность → Мои устройства), смените пароль и включите вход с кодом.`);
  await logIn(p.id, "new_device", b, ip);
  if (["leader", "moderator", "owner"].includes(p.rank)) await quiet(`🔐 Вход с нового устройства: <b>${esc(p.login)}</b> (${RANKS[p.rank]}, ${esc(p.org)})`);
}

// ───────────── API: сообщение об ошибке из программы ─────────────
async function bugReport(b) {
  const { p, err } = await who(b);
  if (err) return err;
  if (!(await hit(`bug:${p.id}`, 5, 86400))) return fail("Можно отправить не больше 5 сообщений в сутки.", { code: "rate" });
  const text = String(b.text == null ? "" : b.text).replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, " ").trim().slice(0, 2000);
  if (text.length < 10) return fail("Опишите проблему подробнее (хотя бы 10 символов).");
  // 3.7: одинаковое сообщение повторно за сутки не принимаем
  const [dup] = await db()`select id from bug_reports where user_id = ${p.id} and text = ${text} and at > now() - interval '1 day' limit 1`;
  if (dup) return fail(`Такое сообщение уже отправлено (№${dup.id}). Ответ придёт в программу.`, { code: "dup" });
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
  for (const id of Object.keys(SERVERS).map(Number)) {
    try {
      const r = await fetch(lawsStatusUrl(id) + "?t=" + Date.now(), { signal: AbortSignal.timeout(6000) });
      if (r.status === 404 && id !== DEFAULT_SERVER) {
        L.push(`⚠️ Законы ${esc(srvName(id))}: ещё не собирались (запустите /laws)`);
        continue;
      }
      const j = await r.json();
      const age = Math.round((Date.now() - j.checkedAt) / 3600e3);
      L.push(`${j.ok && age < 36 ? "✅" : "⚠️"} Законы ${esc(srvName(id))}: проверка ${fmtDate(j.checkedAt)} (${age} ч. назад), последнее изменение ${fmtDate(j.updatedAt)}, законов: ${j.count}${j.failed ? ", не прочитано тем: " + j.failed : ""}${j.error ? "\nОшибка: " + esc(j.error) : ""}`);
    } catch (e) {
      L.push(`⚠️ Законы ${esc(srvName(id))}: не удалось прочитать статус`);
    }
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
// 3.8 (п. 58): копию проверяем так же, как её прочтёт владелец: расшифровываем тем же ключом и разбираем JSON
async function backupDecrypt(j) {
  const ub = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
  const base = await crypto.subtle.importKey("raw", enc.encode(BACKUP_KEY), "PBKDF2", false, ["deriveKey"]);
  const key = await crypto.subtle.deriveKey({ name: "PBKDF2", salt: ub(j.salt), iterations: 200000, hash: "SHA-256" }, base, { name: "AES-GCM", length: 256 }, false, ["decrypt"]);
  return JSON.parse(new TextDecoder().decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv: ub(j.iv) }, key, ub(j.data))));
}
// Раз в неделю (понедельник, после 05:00 МСК): свежая резервная копия владельцу в Telegram и проверка, что она читается
async function weeklyBackupCheck() {
  if (!OWNER_TG) return;
  const wk = mskWeek();
  if (wk.key !== mskDay() || mskHM() < "05:00") return;
  const s = (await getSetting("bkcheck", {})) || {};
  if (s.last === wk.key) return;
  await setSetting("bkcheck", { last: wk.key });
  if (!BACKUP_KEY) {
    await send(OWNER_TG, "⚠️ Еженедельная резервная копия не сделана: не задан секрет BACKUP_KEY (Supabase → Edge Functions → Secrets).");
    return;
  }
  try {
    const f = await backupFile();
    const data = await backupDecrypt(JSON.parse(f.json));
    const ok = data && Array.isArray(data.profiles) && data.profiles.length === f.counts.profiles && data.profiles.length > 0;
    await audit("система", "backup", null, { ...f.counts, weekly: true, ok });
    if (!ok) {
      await send(OWNER_TG, "❌ Еженедельная проверка: резервная копия после расшифровки не совпала с базой. Сделайте копию вручную: /backup");
      return;
    }
    const r = await sendFile(OWNER_TG, `senko-backup-${mskDay()}.json`, f.json,
      `🔒 Еженедельная резервная копия проверена: расшифровывается и читается. Аккаунтов: ${f.counts.profiles}.\nХраните файл отдельно от компьютера. Расшифровка: node tools/decrypt-backup.js`);
    if (!r || !r.ok) await send(OWNER_TG, "⚠️ Резервная копия проверена, но файл не отправился в Telegram. Сделайте копию вручную: /backup");
  } catch (e) {
    console.error("weekly backup", e);
    await send(OWNER_TG, `❌ Еженедельная проверка резервной копии не прошла: ${esc(String((e && e.message) || e).slice(0, 300))}`);
  }
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
  { code: "judge5", icon: "⚖", name: "Беспристрастный", desc: "Пять верных решений подряд в тренажёре судьи", rare: true, test: () => false },
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
async function weekStats(org, w = mskWeek(), full = false, server = null) {
  const sql = db();
  const people = await sql`select id, login, nick, org, server, rank, last_seen, created_at from profiles
                           where ${org ? sql`org = ${org}` : sql`true`} and ${server ? sql`server = ${server}` : sql`true`} and not banned and approval = 'ok'`;
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
  const board = (await weekStats(p.org, w, false, sv(p))).sort(byWxp);
  const place = board.findIndex((x) => x.id === p.id);
  const ctrl = await sql`select t.id, t.title, t.n, t.due_at, r.p, r.at from control_tests t
                         left join control_results r on r.test_id = t.id and r.user_id = ${p.id}
                         where t.org = ${p.org} and t.server = ${sv(p)} and (r.p is not null or (not t.closed and t.due_at > now()))
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
// Сервер, с которым работает руководство: руководитель — свой, модератор с ограничением — его сервер, владелец и модератор «на все серверы» — выбранный (null — все серверы)
const staffSrvOpt = (p, b) => (p.rank === "leader" ? sv(p) : modServer(p) || parseServer(b.server) || null);
// то же, но когда действие требует конкретного сервера (создание смены, теста, мероприятия): без выбора — Boston
const staffSrv = (p, b) => staffSrvOpt(p, b) || DEFAULT_SERVER;

async function weekBoardApi(b) {
  const { p, err } = await who(b, ["leader", "moderator", "owner"]);
  if (err) return err;
  const org = staffOrg(p, b);
  const srv = staffSrvOpt(p, b);
  const w = mskWeek();
  const list = (await weekStats(org, w, false, srv)).sort(byWxp);
  return {
    ok: true, org, server: srv || 0, from: w.start,
    list: list.map((x, i) => ({ n: i + 1, login: x.login, nick: x.nick, org: x.org, lvl: x.lvl.name, xp: x.xp, wxp: x.wxp, det: x.det, tests: x.tests, avg_p: x.avg_p, ach: x.ach })),
  };
}

// ───────────── API: журнал смены ─────────────
async function shiftSummary(org, from, to, server = DEFAULT_SERVER) {
  const sql = db();
  const people = await sql`select id, login, nick, last_seen from profiles where org = ${org} and server = ${server} and not banned and approval = 'ok'`;
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
  const s = await shiftSummary(cur.org, tsOf(cur.started_at), Date.now(), cur.server || DEFAULT_SERVER);
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
  const srv = staffSrv(p, b);
  const sql = db();
  const op = String(b.op || "");
  let msg = "";
  if (op === "start") {
    const [cur] = await sql`select * from shifts where org = ${org} and server = ${srv} and ended_at is null`;
    if (cur) return fail(`Смена уже идёт с ${fmtDate(cur.started_at)}, её начал ${cur.leader}.`);
    await sql`insert into shifts (org, server, leader_id, leader) values (${org}, ${srv}, ${p.id}, ${p.nick || p.login})`;
    await audit(p.login, "shift_start", org, {});
    msg = "Смена начата.";
  } else if (op === "end") {
    const [cur] = await sql`select * from shifts where org = ${org} and server = ${srv} and ended_at is null`;
    if (!cur) return fail("Смена не начата.");
    await endShift(cur, p);
    await audit(p.login, "shift_end", org, {});
    msg = p.tg_id != null ? "Смена завершена. Сводка отправлена вам в Telegram." : "Смена завершена.";
  }
  const [act] = await sql`select * from shifts where org = ${org} and server = ${srv} and ended_at is null`;
  const hist = await sql`select * from shifts where org = ${org} and server = ${srv} and ended_at is not null order by started_at desc limit 10`;
  return { ok: true, org, server: srv, msg, active: act ? shiftOut(act) : null, history: hist.map(shiftOut) };
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
    if (!t || t.org !== p.org || (t.server || DEFAULT_SERVER) !== sv(p)) return fail("Тест не найден.");
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
  const srvO = staffSrvOpt(p, b);
  const srv = srvO || DEFAULT_SERVER;
  if (op === "create") {
    if (!org) return fail("Выберите организацию.");
    const topics = (Array.isArray(b.topics) ? b.topics : []).map(String).filter((k) => TOPICS[k]);
    if (!topics.length) return fail("Выберите хотя бы одну тему.");
    const n = Math.min(20, Math.max(5, Math.floor(+b.n) || 10));
    const days = Math.min(14, Math.max(1, Math.floor(+b.days) || 3));
    const title = clean(b.title, 80) || "Контрольный тест";
    const [{ k }] = await sql`select count(*)::int k from control_tests where org = ${org} and server = ${srv} and not closed and due_at > now()`;
    if (k >= 5) return fail("Активных тестов уже 5. Закройте один из них.");
    if (!(await hit(`ct:${p.id}`, 20, 86400))) return fail(RATE_MSG, { code: "rate" });
    const [t] = await sql`insert into control_tests (org, server, author_id, author, title, topics, n, due_at)
                          values (${org}, ${srv}, ${p.id}, ${p.nick || p.login}, ${title}, ${topics}, ${n}, now() + make_interval(days => ${days})) returning id`;
    await audit(p.login, "ctrl_create", org, { id: t.id, title, topics, n, days });
    await postHook(org, srv, "ctrl", "📋 Контрольный тест: " + title, `Вопросов: ${n}, срок: ${days} дн. Пройти можно в программе: сверху появится плашка с кнопкой «Пройти».\nНазначил(а): ${esc(p.nick || p.login)}`, 0x7c3aed);
  } else if (op === "close") {
    const id = parseInt(b.id, 10);
    const r = id ? await sql`update control_tests set closed = true where id = ${id} and (${org}::text is null or org = ${org}) and (${srvO}::int is null or server = ${srvO}) returning id` : [];
    if (!r.length) return fail("Тест не найден.");
  }
  const tests = await sql`select * from control_tests where (${org}::text is null or org = ${org}) and (${srvO}::int is null or server = ${srvO}) order by created_at desc limit 10`;
  const out = [];
  for (const t of tests) out.push(await ctrlDetails(t));
  return { ok: true, org, server: srvO || 0, topics: TOPICS, tests: out };
}
async function ctrlDetails(t) {
  const sql = db();
  const res = await sql`select r.p, r.s, r.n, r.at, p.nick, p.login from control_results r join profiles p on p.id = r.user_id
                        where r.test_id = ${t.id} order by r.p desc, r.at`;
  const done = new Set(res.map((r) => r.login));
  // автор теста его не проходит
  const all = await sql`select login, nick from profiles where org = ${t.org} and server = ${t.server || DEFAULT_SERVER} and not banned and approval = 'ok' and created_at < ${t.due_at}
                          and id is distinct from ${t.author_id} order by nick`;
  const miss = all.filter((x) => !done.has(x.login));
  return {
    id: String(t.id), org: t.org, server: t.server || DEFAULT_SERVER, title: t.title, topics: t.topics, n: t.n, due: t.due_at, by: t.author, created: t.created_at,
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
const RP_STATUS = { new: "на рассмотрении", ok: "принят", no: "отклонён", rev: "на доработке" };
const RP_ICON = { new: "⏳", ok: "✅", no: "❌", rev: "↩️" };
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
  no: r.org_no ? String(r.org_no).padStart(4, "0") : "", resubmits: r.resubmits || 0, // 4.2: номер по организации, повторные отправки
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
  const leaders = await sql`select tg_id from profiles where rank = 'leader' and org = ${r.org} and server = ${r.server || DEFAULT_SERVER} and tg_id is not null and not banned`;
  for (const l of leaders) if ((await getSetting("rpn:" + l.tg_id, { on: true })).on) chats.add(String(l.tg_id));
  const staff = (await moderatorChats(r.server || DEFAULT_SERVER)).concat(OWNER_TG ? [OWNER_TG] : []);
  for (const c of staff) if ((await getSetting("rpn:" + c, { on: false })).on) chats.add(c);
  for (const c of chats) await send(c, rpText(r, 1500) + (r.body.length > 1500 ? `\n\nПолностью: /report ${r.id}` : ""), { disable_notification: true, ...rpButtons(r) });
  await postHook(r.org, r.server || DEFAULT_SERVER, "rep", `📝 Рапорт №${r.id}: ${r.title}`, rpText(r, 1500), 0xc2530e);
}
// Решение по рапорту. who: { label, name, org (null — любая организация) }
async function rpReview(by, id, ok, note, rev = false) {
  const sql = db();
  const [r0] = id ? await sql`select * from reports where id = ${id}` : [];
  if (!r0 || (by.org && r0.org !== by.org) || (by.server && (r0.server || DEFAULT_SERVER) !== by.server)) return { err: "Рапорт не найден." };
  const stNew = rev ? "rev" : ok ? "ok" : "no";
  if (rev && !note) return { err: "Напишите, что исправить: комментарий обязателен при возврате на доработку." };
  const [r] = await sql`update reports set status = ${stNew}, reviewer = ${by.name}, review_note = ${note || ""}, reviewed_at = now()
                        where id = ${r0.id} returning *`;
  await audit(by.label, "report_review", r.login, { id: String(r.id), org: r.org, status: r.status });
  if (r.user_id && r0.status !== r.status)
    await sql`insert into broadcasts (user_id, title, author, text, expires_at)
              values (${r.user_id}, ${`${RP_ICON[r.status]} Рапорт №${r.org_no ? String(r.org_no).padStart(4, "0") : r.id} ${RP_STATUS[r.status]}`}, ${by.label},
                      ${`${r.title} от ${new Date(r.created_at).toLocaleDateString("ru-RU", { timeZone: "Europe/Moscow" })}: ${RP_STATUS[r.status]} (${by.name}).${note ? " Комментарий: " + note : ""}${r.status === "rev" ? " Откройте «Мои рапорты», исправьте и отправьте снова." : ""}`},
                      now() + interval '7 days')`;
  return { r };
}
// ───────────── 4.2: бланки организации (158), отпуска (26), табель смен (24) ─────────────
const RPF_TYPES = ["text", "area", "select"];
const RPF_IDS = "abcdefghijkl".split("").map((c) => "xf_" + c);
function rpfClean(list) {
  const out = [];
  for (const f of (Array.isArray(list) ? list : []).slice(0, 12)) {
    const l = clean(f && f.l, 60);
    if (!l) continue;
    const t = RPF_TYPES.includes(f.t) ? f.t : "text";
    const o = t === "select" ? (Array.isArray(f.o) ? f.o : []).map((x) => clean(x, 40)).filter(Boolean).slice(0, 10) : [];
    if (t === "select" && o.length < 2) continue;
    const kinds = (Array.isArray(f.kinds) ? f.kinds : []).filter((k) => RP_KINDS[k]).slice(0, 8);
    out.push({ id: RPF_IDS[out.length], l, t, o, req: !!f.req, kinds });
  }
  return out;
}
const mskDate = (d) => mskDay(new Date(d));
// 4.2.1: отпуска — заявка сотрудника → решение руководства → в календаре ведомства (ник на датах, дата красная)
const VAC_ST = { wait: "на рассмотрении", ok: "одобрен", no: "отклонён" };
const vacWhen = (kind, s, e) => {
  const o = { timeZone: "Europe/Moscow" };
  if (kind === "ic") return `${new Date(s).toLocaleDateString("ru-RU", o)} с ${new Date(s).toLocaleTimeString("ru-RU", { ...o, hour: "2-digit", minute: "2-digit" })} до ${new Date(e).toLocaleTimeString("ru-RU", { ...o, hour: "2-digit", minute: "2-digit" })}`;
  return `с ${new Date(s).toLocaleDateString("ru-RU", o)} по ${new Date(e - 1).toLocaleDateString("ru-RU", o)}`;
};
async function vacApi(b) {
  const { p, err } = await who(b);
  if (err) return err;
  const sql = db();
  const op = String(b.op || "mine");
  const srv = sv(p);
  const staff = ["leader", "moderator", "owner"].includes(p.rank);
  const out = (r, full = true) => ({ id: String(r.id), kind: r.kind, start: r.start_at, end: r.end_at, nick: r.nick || "", org: r.org, status: r.status || "ok",
    mine: r.user_id === p.id, ...(full ? { note: r.note || "", answer: r.answer || "", by: r.decided_by || "", created: r.created_at } : {}) });
  const mine = async () => (await sql`select v.*, pr.nick from vacations v join profiles pr on pr.id = v.user_id where v.user_id = ${p.id} and v.end_at > now() - interval '30 days' order by v.start_at desc limit 40`).map((r) => out(r));
  if (op === "add") {
    if (!p.org) return fail("Отпуск оформляется в ведомстве: сначала вступите в организацию.");
    if (!(await hit(`vac:${p.id}`, 20, 3600))) return fail(RATE_MSG, { code: "rate" });
    const kind = b.kind === "ooc" ? "ooc" : "ic";
    const s = Date.parse(b.start), e = Date.parse(b.end);
    if (!s || !e || e <= s) return fail("Проверьте начало и конец отпуска.");
    if (e < Date.now()) return fail("Эти даты уже прошли.");
    if (s > Date.now() + 61 * 864e5) return fail("Отпуск можно запросить не дальше чем на 2 месяца вперёд.");
    if (kind === "ic") {
      if (e - s > 12 * 3600e3) return fail("IC-отпуск — не больше 12 часов подряд.");
      if (mskDate(s) !== mskDate(e - 1)) return fail("IC-отпуск — в пределах одного дня (по Москве).");
    } else if (e - s > 12 * 864e5 + 3600e3) return fail("OOC-отпуск — не больше 12 дней подряд.");
    const [{ n }] = await sql`select count(*)::int n from vacations where user_id = ${p.id} and end_at > now() and status <> 'no'`;
    if (n >= 10) return fail("У вас уже 10 будущих отпусков и заявок. Отмените лишние.");
    const [{ x }] = await sql`select count(*)::int x from vacations where user_id = ${p.id} and status <> 'no' and start_at < ${new Date(e)} and end_at > ${new Date(s)}`;
    if (x) return fail("На эти даты у вас уже есть отпуск или заявка.");
    const note = clean(b.note, 120);
    const [r] = await sql`insert into vacations (user_id, org, server, kind, start_at, end_at, note, status) values (${p.id}, ${p.org}, ${srv}, ${kind}, ${new Date(s)}, ${new Date(e)}, ${note}, 'wait') returning id`;
    // руководству ведомства — уведомление в программе
    try {
      const leads = await sql`select id from profiles where org = ${p.org} and server = ${srv} and rank = 'leader' and not banned limit 20`;
      for (const l of leads)
        await sql`insert into broadcasts (user_id, title, author, text, expires_at) values (${l.id}, ${"🗓 Заявка на отпуск"}, ${"Отпуска"},
                  ${`${p.nick || p.login} просит ${kind === "ic" ? "IC" : "OOC"}-отпуск ${vacWhen(kind, s, e)}${note ? ". Причина: " + note : ""}. Решение — в разделе «Отпуска».`}, now() + interval '3 days')`;
    } catch (e2) {}
    try { await postHook(p.org, srv, "join", "🗓 Заявка на отпуск: " + (p.nick || p.login), `${kind === "ic" ? "IC" : "OOC"} ${vacWhen(kind, s, e)}${note ? "\n" + note : ""}\nЗаявка #${r.id} ждёт решения руководства.`); } catch (e2) {}
    return { ok: true, list: await mine() };
  }
  if (op === "del") {
    const [r] = await sql`delete from vacations where id = ${parseInt(b.id, 10) || 0} and user_id = ${p.id} and (status = 'wait' or end_at > now()) returning *`;
    if (r && r.status === "ok") try { await postHook(r.org, r.server, "join", "🗓 Отпуск отменён: " + (p.nick || p.login), `${r.kind === "ic" ? "IC" : "OOC"} ${vacWhen(r.kind, tsOf(r.start_at), tsOf(r.end_at))}`); } catch (e2) {}
    return { ok: true, list: await mine() };
  }
  if (op === "cal") {
    // календарь ведомства на месяц: одобренные отпуска всех + свои заявки; руководство видит и заявки сотрудников
    const org = staff && p.rank !== "leader" ? staffOrg(p, b) || p.org : p.org;
    const s2 = staff ? staffSrvOpt(p, b) || srv : srv;
    if (!org) return fail("Календарь отпусков — для сотрудников ведомства. Вступите в организацию.");
    const m = /^(\d{4})-(\d{2})$/.exec(String(b.month || "")) ? String(b.month) : mskDay(new Date()).slice(0, 7);
    const from = Date.parse(m + "-01T00:00:00+03:00") - 7 * 864e5, to = from + 52 * 864e5;
    const rows = await sql`select v.*, pr.nick from vacations v join profiles pr on pr.id = v.user_id
                           where v.org = ${org} and v.server = ${s2} and v.start_at < ${new Date(to)} and v.end_at > ${new Date(from)}
                             and (v.status = 'ok' or v.user_id = ${p.id} or (${staff} and v.status = 'wait')) order by v.start_at limit 500`;
    const can = staff && (p.rank !== "leader" || p.org === org);
    return { ok: true, org, month: m, staff: can, list: rows.map((r) => out(r, can || r.user_id === p.id)) };
  }
  if (op === "org" || op === "review") {
    if (!staff) return fail("Решение по отпускам принимает руководство.");
    const org = staffOrg(p, b), s2 = staffSrvOpt(p, b) || srv;
    if (!org) return fail("Выберите организацию.");
    if (op === "review") {
      const ok = !!b.ok, ans = clean(b.note, 200);
      const [own] = await sql`select user_id from vacations where id = ${parseInt(b.id, 10) || 0}`;
      if (own && own.user_id === p.id && p.rank === "leader") return fail("Свою заявку руководитель не одобряет сам: это сделает другой руководитель, модератор или владелец.");
      const [r] = await sql`update vacations set status = ${ok ? "ok" : "no"}, answer = ${ans}, decided_by = ${p.nick || p.login}, decided_at = now()
                            where id = ${parseInt(b.id, 10) || 0} and org = ${org} and server = ${s2} returning *`;
      if (!r) return fail("Заявка не найдена: возможно, сотрудник её отменил.");
      await audit(p.login, "vac_review", "", { id: String(r.id), org, status: r.status });
      const [u] = await sql`select nick, login from profiles where id = ${r.user_id}`;
      const when = vacWhen(r.kind, tsOf(r.start_at), tsOf(r.end_at));
      await sql`insert into broadcasts (user_id, title, author, text, expires_at) values (${r.user_id}, ${ok ? "✅ Отпуск одобрен" : "❌ Отпуск не одобрен"}, ${p.nick || p.login},
                ${`${r.kind === "ic" ? "IC" : "OOC"}-отпуск ${when}: ${VAC_ST[r.status]} (${p.nick || p.login}).${ans ? " Комментарий: " + ans : ""}${ok ? " Ваш ник появился в календаре отпусков ведомства." : ""}`}, now() + interval '7 days')`;
      if (ok) try { await postHook(org, s2, "join", "🌴 Отпуск одобрен: " + ((u && (u.nick || u.login)) || ""), `${r.kind === "ic" ? "IC" : "OOC"} ${when}\nОдобрил: ${p.nick || p.login}${ans ? "\n" + ans : ""}`, 0x2e7d32); } catch (e2) {}
    }
    const rows = await sql`select v.*, pr.nick from vacations v join profiles pr on pr.id = v.user_id where v.org = ${org} and v.server = ${s2}
                           and (v.status = 'wait' and v.end_at > now() or v.end_at > now() - interval '7 days') order by (v.status = 'wait') desc, v.start_at limit 200`;
    return { ok: true, org, list: rows.map((r) => out(r)) };
  }
  if (op !== "mine") return fail("Неизвестное действие.");
  return { ok: true, list: await mine() };
}
// табель: сотрудник × день. Часы — длительность смен ведомства, во время которых сотрудник был в сети (по сводке смены)
async function tabelApi(b) {
  const { p, err } = await who(b, ["leader", "moderator", "owner"]);
  if (err) return err;
  const org = staffOrg(p, b);
  if (!org) return fail("Выберите организацию.");
  const srv = staffSrvOpt(p, b) || sv(p);
  const days = Math.min(31, Math.max(1, parseInt(b.days, 10) || 7));
  const from0 = /^\d{4}-\d{2}-\d{2}$/.test(String(b.from || "")) ? String(b.from) : mskDay(new Date(Date.now() - (days - 1) * 864e5));
  const start = Date.parse(from0 + "T00:00:00+03:00"), end = start + days * 864e5;
  const sql = db();
  const people = await sql`select id, login, nick, post from profiles where org = ${org} and server = ${srv} and not banned and approval = 'ok' order by lower(nick) limit 300`;
  const shifts = await sql`select started_at, ended_at, summary from shifts where org = ${org} and server = ${srv} and started_at < ${new Date(end)} and coalesce(ended_at, now()) > ${new Date(start)}`;
  const vac = await sql`select user_id, kind, start_at, end_at from vacations where status = 'ok' and org = ${org} and server = ${srv} and start_at < ${new Date(end)} and end_at > ${new Date(start)}`;
  const D = Array.from({ length: days }, (_, i) => mskDay(new Date(start + i * 864e5 + 3 * 3600e3)));
  const H = {}, V = {};
  for (const sh of shifts) {
    const s = Math.max(tsOf(sh.started_at), start), e = Math.min(tsOf(sh.ended_at) || Date.now(), end);
    if (e <= s) continue;
    const day = mskDate(s), hrs = (e - s) / 3600e3;
    for (const x of ((sh.summary && sh.summary.online) || [])) {
      const k = String(x.login || "").toLowerCase();
      if (!k) continue;
      H[k] = H[k] || {};
      H[k][day] = (H[k][day] || 0) + hrs;
    }
  }
  const byId = Object.fromEntries(people.map((x) => [x.id, x]));
  for (const v of vac) {
    const x = byId[v.user_id];
    if (!x) continue;
    for (let t = Math.max(tsOf(v.start_at), start); t < Math.min(tsOf(v.end_at), end); t += 864e5) {
      const k = x.login.toLowerCase();
      V[k] = V[k] || {};
      V[k][mskDate(t)] = v.kind;
    }
    const k = x.login.toLowerCase(), last = mskDate(Math.min(tsOf(v.end_at), end) - 1);
    if (last >= D[0] && last <= D[D.length - 1]) { V[k] = V[k] || {}; V[k][last] = v.kind; }
  }
  const rows = people.map((x) => {
    const k = x.login.toLowerCase(), h = D.map((d) => Math.round(((H[k] || {})[d] || 0) * 10) / 10), v = D.map((d) => (V[k] || {})[d] || "");
    return { nick: x.nick, post: x.post || "", h, v, total: Math.round(h.reduce((s, n) => s + n, 0) * 10) / 10, days: h.filter((n) => n > 0).length };
  });
  const res = { ok: true, org, server: srvName(srv), days: D, rows, total: Math.round(rows.reduce((s, r) => s + r.total, 0) * 10) / 10 };
  if (b.op === "send") {
    if (!(await hit(`tab:${p.id}`, 10, 3600))) return fail(RATE_MSG, { code: "rate" });
    const [h] = await sql`select * from org_hooks where org = ${org} and server = ${srv}`;
    if (!h) return fail("У организации не подключён Discord-вебхук. Его подключает руководство в панели руководителя.");
    const top = rows.filter((r) => r.total > 0).sort((a, c) => c.total - a.total);
    const txt = `Период: ${D[0]} — ${D[D.length - 1]}\nВсего часов по сменам: **${res.total}**, сотрудников со сменами: **${top.length}** из ${rows.length}\n\n` +
      (top.length ? top.slice(0, 40).map((r, i) => `${i + 1}. ${r.nick} — ${r.total} ч, дней: ${r.days}`).join("\n") : "Смен за период нет.") +
      (rows.some((r) => r.v.some(Boolean)) ? "\n\nВ отпуске: " + rows.filter((r) => r.v.some(Boolean)).map((r) => r.nick).join(", ") : "");
    const ok = await hookSend(h, `📋 Табель смен ${org}`, txt, 0x2e7d4f);
    if (!ok) return fail("Discord не принял табель. Проверьте вебхук в панели руководителя.");
    await audit(p.login, "tabel_send", org, { from: D[0], days });
    return { ...res, sent: true };
  }
  return res;
}

async function reportsApi(b) {
  const op = String(b.op || "mine");
  const sql = db();
  if (op === "create" || op === "mine" || op === "del" || op === "resubmit" || op === "form_get") {
    const { p, err } = await who(b);
    if (err) return err;
    // 4.2: бланк организации — дополнительные поля, которые задало руководство
    if (op === "form_get") return { ok: true, org: p.org, fields: ((await getSetting(`rpf:${p.org}:${sv(p)}`, null)) || { fields: [] }).fields || [] };
    // 4.2: исправленный рапорт после возврата на доработку
    if (op === "resubmit") {
      const id = parseInt(b.id, 10) || 0;
      const body = cleanText(b.body, 5000);
      if (body.length < 20) return fail("Рапорт слишком короткий: заполните поля.");
      if (!(await hit(`rp:${p.id}`, 15, 3600))) return fail(RATE_MSG, { code: "rate" });
      const [r] = await sql`update reports set status = 'new', body = ${body}, fields = ${sql.json(rpFields(b.fields))}, title = ${clean(b.title, 120) || "Рапорт"},
                            resubmits = resubmits + 1, reviewed_at = null where id = ${id} and user_id = ${p.id} and status = 'rev' returning *`;
      if (!r) return fail("Исправить можно только свой рапорт, который вернули на доработку.");
      await audit(p.login, "report_resubmit", r.org, { id: String(r.id) });
      try { await rpNotify(r); } catch (e) { console.error("report notify", e); }
      const rows0 = await sql`select * from reports where user_id = ${p.id} order by created_at desc limit 200`;
      return { ok: true, report: rpOut(r), list: rows0.map((x) => rpOut(x)) };
    }
    if (op === "create") {
      const kind = String(b.kind || "");
      if (!RP_KINDS[kind]) return fail("Неизвестный вид рапорта.");
      // формы прокурора и адвоката только для Government, как и в программе
      if ((kind === "sup" || kind === "def") && p.org !== GOV_ORG) return fail("Эта форма доступна только сотрудникам Government.");
      const body = cleanText(b.body, 5000);
      if (body.length < 20) return fail("Рапорт слишком короткий: заполните поля.");
      if (!(await hit(`rp:${p.id}`, 15, 3600))) return fail(RATE_MSG, { code: "rate" });
      const title = clean(b.title, 120) || RP_KINDS[kind];
      const [r] = await sql`insert into reports (user_id, org, server, author, login, static_id, dept, kind, title, fields, body, org_no)
                            values (${p.id}, ${p.org}, ${sv(p)}, ${p.nick || p.login}, ${p.login}, ${p.static_id}, ${p.dept || ""}, ${kind}, ${title},
                                    ${sql.json(rpFields(b.fields))}, ${body},
                                    (select coalesce(max(org_no), 0) + 1 from reports where org = ${p.org} and server = ${sv(p)})) returning *`;
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
      const r = id ? await sql`delete from reports where id = ${id} and user_id = ${p.id} and status in ('new', 'rev') returning id` : [];
      if (!r.length) return fail("Удалить можно только свой рапорт, пока его не рассмотрели.");
      await audit(p.login, "report_delete", p.org, { id: String(id) });
    }
    const rows = await sql`select * from reports where user_id = ${p.id} order by created_at desc limit 200`;
    return { ok: true, list: rows.map((r) => rpOut(r)) };
  }
  const { p, err } = await who(b, ["leader", "moderator", "owner"]);
  if (err) return err;
  const org = staffOrg(p, b);
  if (op === "form_save") {
    if (!org) return fail("Выберите организацию.");
    const srvF = staffSrv(p, b);
    const fields = rpfClean(b.fields);
    await setSetting(`rpf:${org}:${srvF}`, { fields, by: p.nick || p.login, at: Date.now() });
    await audit(p.login, "report_form", org, { n: fields.length });
    return { ok: true, org, fields };
  }
  if (op === "form_staff") {
    if (!org) return fail("Выберите организацию.");
    return { ok: true, org, fields: ((await getSetting(`rpf:${org}:${staffSrv(p, b)}`, null)) || { fields: [] }).fields || [] };
  }
  if (op === "review") {
    const x = await rpReview({ label: p.login, name: p.nick || p.login, org: p.rank === "leader" ? p.org : null, server: staffSrvOpt(p, b) || 0 }, parseInt(b.id, 10), !!b.ok, clean(b.note, 300), !!b.rev);
    if (x.err) return fail(x.err);
  } else if (op !== "list") return fail("Неизвестное действие.");
  const st = RP_STATUS[b.status] ? String(b.status) : null;
  const kind = RP_KINDS[b.kind] ? String(b.kind) : null;
  const q = clean(b.q, 40).toLowerCase();
  const like = q ? "%" + likeEsc(q) + "%" : null;
  const rows = await sql`
    select * from reports
    where (${org}::text is null or org = ${org}) and (${staffSrvOpt(p, b)}::int is null or server = ${staffSrvOpt(p, b)}) and (${st}::text is null or status = ${st}) and (${kind}::text is null or kind = ${kind})
      and (${like}::text is null or lower(author) like ${like} or lower(login) like ${like} or lower(title) like ${like} or static_id like ${like} or id::text = ${q})
    order by created_at desc limit 100`;
  const [{ n }] = await sql`select count(*)::int n from reports where status = 'new' and (${org}::text is null or org = ${org}) and (${staffSrvOpt(p, b)}::int is null or server = ${staffSrvOpt(p, b)})`;
  // 4.2: статистика проверки за 30 дней (166)
  const [s30] = await sql`select count(*)::int n, count(*) filter (where status = 'no')::int no, count(*) filter (where status = 'rev')::int rev,
      round(avg(extract(epoch from (reviewed_at - created_at)) / 60) filter (where reviewed_at is not null))::int avg_min,
      round(extract(epoch from (now() - min(created_at) filter (where status = 'new'))) / 3600)::int oldest_h
    from reports where created_at > now() - interval '30 days' and (${org}::text is null or org = ${org}) and (${staffSrvOpt(p, b)}::int is null or server = ${staffSrvOpt(p, b)})`;
  return { ok: true, org, kinds: RP_KINDS, newN: n, stats: { wait: n, n30: s30.n, no: s30.no, rev: s30.rev, avgMin: s30.avg_min, oldestH: s30.oldest_h }, list: rows.map((r) => rpOut(r)) };
}

// ───────────── Приём новичков ─────────────
const approvalMsg = (p) =>
  p.approval === "rejected"
    ? `Руководство организации ${p.org} отклонило заявку. Связь: ${CONTACT}`
    : `Ваша заявка ждёт подтверждения руководства организации ${p.org}. Попробуйте войти позже.`;
async function askApproval(p) {
  const sql = db();
  if (p.game_role === "judge") {
    // 4.3: заявку судьи рассматривает Председатель Верховного суда (в программе: «Суд» → «Судьи»)
    const pv = await sql`select id, tg_id from profiles where pvs and server = ${sv(p)} and not banned`;
    for (const x of pv) {
      await sql`insert into broadcasts (user_id, title, author, text, expires_at) values (${x.id}, ${"⚖ Заявка судьи"}, ${"Регистрация"},
                ${`${p.nick} (статик ${p.static_id}) зарегистрировался как судья и ждёт одобрения. Откройте «Суд» → «Судьи» и выберите должность.`}, now() + interval '7 days')`;
      if (x.tg_id) await send(String(x.tg_id), `⚖ <b>Заявка судьи · ${esc(srvName(sv(p)))}</b>\n\n${esc(p.nick)} (статик ${esc(p.static_id)}) ждёт одобрения. Решение — в программе: «Суд» → «Судьи».`);
    }
    if (!pv.length && OWNER_TG) await send(OWNER_TG, `⚖ Заявка судьи <b>${esc(p.nick)}</b> (${esc(srvName(sv(p)))}): Председатель Верховного суда не назначен. Назначьте его в программе: «Суд» → «Судьи».`);
    return pv.length;
  }
  const leaders = await sql`select tg_id from profiles where org = ${p.org} and server = ${sv(p)} and rank = 'leader' and tg_id is not null and not banned`;
  const kb = { inline_keyboard: [[{ text: "✅ Принять", callback_data: `ap:ok:${p.id}` }, { text: "❌ Отклонить", callback_data: `ap:no:${p.id}` }]] };
  const text = `🆕 <b>Заявка в ${esc(p.org)} · ${esc(srvName(sv(p)))}</b>\n\n${card(p, "leader")}\n\nПринять сотрудника в программу?`;
  const chats = new Set(leaders.map((l) => String(l.tg_id)));
  if (!chats.size && OWNER_TG) chats.add(OWNER_TG); // у руководства нет Telegram — решает владелец
  for (const c of chats) await send(c, text, { reply_markup: kb });
  return chats.size;
}
async function decideApproval(a, id, ok) {
  const sql = db();
  const [p0] = await sql`select * from profiles where id = ${id}`;
  if (!p0) return { err: "Аккаунт не найден." };
  if (a.kind === "leader" && (a.profile.org !== p0.org || sv(a.profile) !== sv(p0))) return { err: "Это заявка другой организации." };
  if (p0.game_role === "judge" && a.kind === "leader") return { err: "Заявку судьи рассматривает Председатель Верховного суда в программе («Суд» → «Судьи»)." };
  { const sc = scopeServer(a); if (sc && sv(p0) !== sc) return { err: "Это заявка с другого сервера." }; }
  const [r] = await sql`update profiles set approval = ${ok ? "ok" : "rejected"} where id = ${id} and approval = 'pending' returning *`;
  if (!r) return { err: `Заявка уже рассмотрена: ${p0.approval === "ok" ? "принята" : p0.approval === "rejected" ? "отклонена" : "нет заявки"}.` };
  await audit(a.label, ok ? "approve" : "reject", r.login, { org: r.org });
  if (ok)
    await sql`insert into broadcasts (user_id, title, author, text, expires_at)
              values (${r.id}, ${"✅ Заявка принята"}, ${a.label}, ${`Добро пожаловать в ${r.org}! Руководство подтвердило ваш аккаунт.`}, now() + interval '7 days')`;
  if (a.kind !== "owner") await quiet(`${ok ? "✅" : "❌"} ${esc(a.profile.login)} ${ok ? "принял" : "отклонил"} заявку <b>${esc(r.login)}</b> в ${esc(r.org)}`);
  return { text: `${ok ? "✅ Принят" : "❌ Отклонён"}: <b>${esc(r.login)}</b> (${esc(r.nick)}) в ${esc(r.org)}${ok ? "" : ".\nЕсли передумаете: /approve " + esc(r.login)}` };
}

// ───────────── 3.8: вступление в организацию — код-приглашение (27) и анкета (105) ─────────────
// Приглашение создаёт руководство: код действует N дней и M использований. С кодом новичок регистрируется сразу в организацию
// (без ручного одобрения), а уже зарегистрированный — переходит в неё из личного кабинета.
// Анкета: руководство задаёт вопросы, желающие отвечают в программе, заявки приходят в панель руководителя.
const INV_ABC = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const invNorm = (c) => String(c == null ? "" : c).toUpperCase().replace(/^SA-?/, "").replace(/[^A-Z0-9]/g, "");
async function inviteFind(code) {
  const n = invNorm(code);
  if (n.length !== 8) return null;
  const [r] = await db()`select * from org_invites where code_hash = ${await sha256("inv:" + n)} and not revoked and expires_at > now() and uses < max_uses`;
  return r || null;
}
async function inviteUse(inv, p) {
  await db()`update org_invites set uses = uses + 1 where code_hash = ${inv.code_hash}`;
  await audit(p.login, "invite_use", p.login, { org: inv.org, by: inv.created_by_label || "" });
  try {
    await postHook(inv.org, inv.server, "join", "🆕 Новый сотрудник по приглашению", `**${esc(p.nick)}** (статик ${esc(p.static_id)}) вступил по коду-приглашению.`);
  } catch (e) {}
}
async function orgJoinApi(b) {
  const { p, err } = await who(b);
  if (err) return err;
  const sql = db();
  const op = String(b.op || "forms");
  const srv = sv(p);
  if (op === "code") {
    if (!(await hit(`oj:${p.id}`, 10, 3600))) return fail(RATE_MSG, { code: "rate" });
    const inv = await inviteFind(b.code);
    if (!inv) return fail("Код приглашения не подходит: он неверный, истёк или уже использован.");
    if (inv.org === p.org && inv.server === srv) return fail(`Вы уже в ${inv.org}.`);
    const dept = DEPTS.includes(inv.org) ? inv.org : "";
    const role = p.game_role !== "off" && inv.org !== GOV_ORG ? "off" : p.game_role;
    const [np] = await sql`update profiles set org = ${inv.org}, dept = ${dept}, server = ${inv.server}, game_role = ${role === "judge" ? "off" : role}, judge_pos = '', pvs = false, rank = case when rank = 'leader' then 'user' else rank end where id = ${p.id} returning *`;
    await inviteUse(inv, np);
    await audit(p.login, "org_join", p.login, { from: p.org, to: inv.org, via: "invite" });
    return { ok: true, user: pub(np), msg: `Вы вступили в ${inv.org} (${srvName(inv.server)}).` };
  }
  // 3.8.1: ссылка-приглашение — куда и от кого, до вступления
  if (op === "peek") {
    if (!(await hit(`ojp:${p.id}`, 30, 3600))) return fail(RATE_MSG, { code: "rate" });
    const inv = await inviteFind(b.code);
    if (!inv) return fail("Приглашение не подходит: оно неверное, истекло или уже использовано.");
    const [by] = inv.created_by ? await sql`select nick, static_id from profiles where id = ${inv.created_by}` : [];
    return { ok: true, org: inv.org, server: srvName(inv.server), nick: by ? by.nick : "", static: by ? by.static_id : "", label: inv.created_by_label || "", already: inv.org === p.org && inv.server === srv };
  }
  if (op === "forms") {
    const forms = await sql`select org, questions from org_forms where server = ${srv} and open and org <> ${p.org} order by org`;
    const mine = await sql`select id, org, status, note, created_at, decided_at from org_apps where user_id = ${p.id} order by id desc limit 10`;
    return { ok: true, forms: forms.map((f) => ({ org: f.org, questions: f.questions || [] })), mine: mine.map((a) => ({ id: String(a.id), org: a.org, status: a.status, note: a.note || "", at: a.created_at, decided: a.decided_at })) };
  }
  if (op === "apply") {
    if (!(await hit(`oa:${p.id}`, 5, 86400))) return fail("Можно отправить не больше 5 заявок в сутки.", { code: "rate" });
    const org = clean(b.org, 60);
    const [f] = await sql`select questions from org_forms where org = ${org} and server = ${srv} and open`;
    if (!f) return fail("Эта организация сейчас не принимает заявки.");
    if (org === p.org) return fail(`Вы уже в ${org}.`);
    const [dup] = await sql`select id from org_apps where user_id = ${p.id} and org = ${org} and status = 'new'`;
    if (dup) return fail("Ваша заявка в эту организацию уже на рассмотрении.");
    const qs = f.questions || [];
    const ans = (Array.isArray(b.answers) ? b.answers : []).slice(0, qs.length).map((a) => cleanText(a, 600));
    for (let i = 0; i < qs.length; i++) if (!ans[i] || ans[i].length < 2) return fail(`Ответьте на вопрос ${i + 1}: «${qs[i]}».`);
    const bad = await blacklisted(...ans);
    if (bad) return fail("В ответах есть недопустимое слово.");
    const [r] = await sql`insert into org_apps (user_id, org, server, answers) values (${p.id}, ${org}, ${srv}, ${JSON.stringify(qs.map((q, i) => ({ q, a: ans[i] })))}::jsonb) returning id`;
    const leaders = await sql`select tg_id from profiles where org = ${org} and server = ${srv} and rank = 'leader' and tg_id is not null and not banned`;
    for (const l of leaders) await send(String(l.tg_id), `📝 <b>Заявка на вступление в ${esc(org)}</b> №${r.id}\nОт: ${esc(p.nick)} (${esc(p.login)}, сейчас ${esc(p.org)})\nРассмотреть: панель руководителя в программе → «Вступление».`).catch(() => null);
    try { await postHook(org, srv, "join", "📝 Заявка на вступление", `**${esc(p.nick)}** заполнил(а) анкету. Рассмотреть — в панели руководителя.`); } catch (e) {}
    return { ok: true, id: String(r.id), msg: `Заявка в ${org} отправлена. Ответ придёт сообщением в программе.` };
  }
  return fail("Неизвестное действие.");
}
async function orgJoinAdmin(b) {
  const { p, err } = await who(b, ["leader", "moderator", "owner"]);
  if (err) return err;
  const org = staffOrg(p, b);
  if (!org) return fail("Выберите организацию.");
  const srv = staffSrv(p, b);
  const sql = db();
  const op = String(b.op || "list");
  const label = `${p.nick || p.login} (${RANKS[p.rank]})`;
  let msg = "", code = "";
  if (op === "inv_create") {
    if (!(await hit(`ic:${p.id}`, 20, 3600))) return fail(RATE_MSG, { code: "rate" });
    const days = Math.min(30, Math.max(1, parseInt(b.days, 10) || 7)), uses = Math.min(50, Math.max(1, parseInt(b.uses, 10) || 1));
    const n = Array.from(crypto.getRandomValues(new Uint8Array(8))).map((x) => INV_ABC[x % INV_ABC.length]).join("");
    await sql`insert into org_invites (code_hash, code_tail, org, server, created_by, created_by_label, expires_at, max_uses)
              values (${await sha256("inv:" + n)}, ${n.slice(-4)}, ${org}, ${srv}, ${p.id}, ${label}, now() + make_interval(days => ${days}), ${uses})`;
    code = "SA-" + n.slice(0, 4) + "-" + n.slice(4);
    await audit(p.login, "invite_create", org, { days, uses });
    msg = `Код создан: ${code}. Скопируйте его сейчас — потом он не покажется.`;
  } else if (op === "inv_revoke") {
    const r = await sql`update org_invites set revoked = true where code_tail = ${clean(b.tail, 4)} and org = ${org} and server = ${srv} and not revoked returning code_tail`;
    if (!r.length) return fail("Приглашение не найдено.");
    await audit(p.login, "invite_revoke", org, { tail: r[0].code_tail });
    msg = "Приглашение отозвано.";
  } else if (op === "form_save") {
    const qs = (Array.isArray(b.questions) ? b.questions : String(b.questions || "").split("\n")).map((q) => clean(q, 200)).filter(Boolean).slice(0, 10);
    const open = !!b.open;
    if (open && !qs.length) return fail("Добавьте хотя бы один вопрос анкеты.");
    const bad = await blacklisted(...qs);
    if (bad) return fail("В вопросах есть недопустимое слово.");
    await sql`insert into org_forms (org, server, questions, open, updated_by) values (${org}, ${srv}, ${JSON.stringify(qs)}::jsonb, ${open}, ${label})
              on conflict (org, server) do update set questions = excluded.questions, open = excluded.open, updated_by = excluded.updated_by, updated_at = now()`;
    await audit(p.login, "form_save", org, { n: qs.length, open });
    msg = open ? "Анкета сохранена и открыта: желающие видят её в программе." : "Анкета сохранена. Приём заявок закрыт.";
  } else if (op === "app_decide") {
    const id = parseInt(b.id, 10) || 0, ok = !!b.ok, note = clean(b.note, 300);
    const [a] = await sql`update org_apps set status = ${ok ? "ok" : "no"}, decided_at = now(), decided_by = ${label}, note = ${note} where id = ${id} and org = ${org} and server = ${srv} and status = 'new' returning *`;
    if (!a) return fail("Заявка не найдена или уже рассмотрена.");
    const [u] = await sql`select * from profiles where id = ${a.user_id}`;
    if (u && ok) {
      const role = u.game_role !== "off" && org !== GOV_ORG ? "off" : u.game_role;
      await sql`update profiles set org = ${org}, dept = ${DEPTS.includes(org) ? org : ""}, game_role = ${role === "judge" ? "off" : role}, judge_pos = '', pvs = false, rank = case when rank = 'leader' then 'user' else rank end where id = ${u.id} and server = ${srv}`;
    }
    if (u) await sql`insert into broadcasts (user_id, title, author, text, expires_at)
                     values (${u.id}, ${ok ? "✅ Заявка принята" : "❌ Заявка отклонена"}, ${label}, ${ok ? `Вас приняли в ${org}! Организация в программе уже изменена.` + (note ? "\nКомментарий: " + note : "") : `Руководство ${org} отклонило заявку.` + (note ? "\nПричина: " + note : "")}, now() + interval '7 days')`;
    await audit(p.login, ok ? "app_ok" : "app_no", u ? u.login : String(a.user_id), { org, note });
    msg = ok ? "Заявка принята: сотрудник переведён в организацию." : "Заявка отклонена.";
  } else if (op !== "list") return fail("Неизвестное действие.");
  const invs = await sql`select code_tail, created_by_label, created_at, expires_at, uses, max_uses from org_invites
                         where org = ${org} and server = ${srv} and not revoked and expires_at > now() and uses < max_uses order by created_at desc limit 20`;
  const [form] = await sql`select questions, open, updated_by, updated_at from org_forms where org = ${org} and server = ${srv}`;
  const apps = await sql`select a.id, a.answers, a.status, a.note, a.created_at, a.decided_by, p.login, p.nick, p.static_id, p.org as cur_org
                         from org_apps a left join profiles p on p.id = a.user_id
                         where a.org = ${org} and a.server = ${srv} and (a.status = 'new' or a.decided_at > now() - interval '14 days') order by (a.status = 'new') desc, a.id desc limit 40`;
  return {
    ok: true, org, server: srv, msg, code,
    invites: invs.map((i) => ({ tail: i.code_tail, by: i.created_by_label, at: i.created_at, until: i.expires_at, uses: i.uses, max: i.max_uses })),
    form: { questions: (form && form.questions) || [], open: !!(form && form.open), by: form ? form.updated_by : "", at: form ? form.updated_at : null },
    apps: apps.map((a) => ({ id: String(a.id), answers: a.answers || [], status: a.status, note: a.note || "", at: a.created_at, by: a.decided_by || "", login: a.login || "—", nick: a.nick || "Удалённый аккаунт", static: a.static_id || "", cur: a.cur_org || "" })),
  };
}

// ───────────── 3.6: объявления руководства и отметка «прочитал» ─────────────
// Объявление — это рассылка broadcasts с org (то же, что /broadcast_org в боте): сотрудники видят её вверху программы.
// Программа отмечает объявление прочитанным, когда показала его сотруднику (notice_reads).
async function noticeRead(b) {
  const { p, err } = await who(b);
  if (err) return err;
  const ids = (Array.isArray(b.ids) ? b.ids : [b.id]).map((x) => parseInt(x, 10)).filter((x) => x > 0).slice(0, 10);
  if (!ids.length) return { ok: true };
  if (!(await hit(`nr:${p.id}`, 120, 3600))) return { ok: true };
  await db()`insert into notice_reads (broadcast_id, user_id)
             select id, ${p.id} from broadcasts where id = any(${ids}::bigint[]) and org = ${p.org} and (server is null or server = ${sv(p)})
             on conflict do nothing`;
  return { ok: true };
}
async function orgNews(b) {
  const { p, err } = await who(b, ["leader", "moderator", "owner"]);
  if (err) return err;
  const org = staffOrg(p, b);
  if (!org) return fail("Выберите организацию.");
  const srv = staffSrv(p, b);
  const sql = db();
  const op = String(b.op || "list");
  const label = `${p.nick || p.login} (${RANKS[p.rank]})`;
  if (op === "create") {
    if (!(await hit(`on:${p.id}`, 20, 3600))) return fail(RATE_MSG, { code: "rate" });
    const title = clean(b.title, 80), text = String(b.text == null ? "" : b.text).replace(/\r/g, "").replace(/[\u0000-\u0009\u000b-\u001f]/g, " ").trim().slice(0, 1500);
    if (text.length < 3) return fail("Напишите текст объявления.");
    const bad = await blacklisted(title, text);
    if (bad) return fail("В объявлении есть недопустимое слово. Уберите его.");
    const days = Math.min(30, Math.max(1, parseInt(b.days, 10) || NOTICE_DAYS));
    const [r] = await sql`insert into broadcasts (org, server, author, title, text, expires_at)
                          values (${org}, ${srv}, ${label}, ${title || "Объявление " + org}, ${text}, now() + make_interval(days => ${days})) returning id`;
    await audit(p.login, "broadcast", org, { id: r.id, text: text.slice(0, 200), via: "program" });
    if (p.rank === "leader") await quiet(`📣 ${esc(p.login)} сделал объявление для ${org} (${srvName(srv)}):\n${esc(text.slice(0, 500))}`);
  } else if (op === "delete") {
    const id = parseInt(b.id, 10) || 0;
    const [r] = await sql`update broadcasts set expires_at = now() where id = ${id} and org = ${org} and (server is null or server = ${srv}) and expires_at > now() returning id`;
    if (!r) return fail("Объявление не найдено или уже снято.");
    await audit(p.login, "broadcast_off", org, { id });
  } else if (op !== "list") return fail("Неизвестное действие.");
  const people = await sql`select id, login, nick from profiles where org = ${org} and server = ${srv} and not banned and approval = 'ok' order by lower(nick)`;
  const rows = await sql`select id, title, text, author, created_at, expires_at from broadcasts
                         where org = ${org} and (server is null or server = ${srv}) and created_at > now() - interval '60 days' order by id desc limit 20`;
  const ids = rows.map((r) => r.id);
  const reads = ids.length ? await sql`select broadcast_id, user_id, at from notice_reads where broadcast_id = any(${ids}::bigint[])` : [];
  const R = {};
  reads.forEach((x) => ((R[x.broadcast_id] = R[x.broadcast_id] || {})[x.user_id] = x.at));
  return {
    ok: true, org, server: srv, total: people.length,
    items: rows.map((r) => {
      const got = R[r.id] || {};
      return {
        id: String(r.id), title: r.title, text: r.text, author: r.author, at: r.created_at, until: r.expires_at, active: new Date(r.expires_at).getTime() > Date.now(),
        read: people.filter((x) => got[x.id]).map((x) => ({ nick: x.nick || x.login, at: got[x.id] })),
        unread: people.filter((x) => !got[x.id]).map((x) => x.nick || x.login),
      };
    }),
  };
}

// ───────────── 3.5: журнал действий руководства ─────────────
// Кто кого принял или отклонил, перевёл, кто рассмотрел или удалил рапорт, открыл смену, назначил тест, поменял вебхук.
// Видно руководству организации (только своей), модераторам и владельцу.
const LEAD_ACTIONS = { approve: "Принял(а) в организацию", reject: "Отклонил(а) заявку", setorg: "Перевёл(а) в другую организацию", role: "Сменил(а) роль",
  report_review: "Рассмотрел(а) рапорт", report_delete: "Удалил(а) рапорт", shift_start: "Начал(а) смену", shift_end: "Закончил(а) смену",
  ctrl_create: "Назначил(а) контрольный тест", hook: "Изменил(а) вебхук Discord" };
async function leadLog(b) {
  const { p, err } = await who(b, ["leader", "moderator", "owner"]);
  if (err) return err;
  const org = staffOrg(p, b);
  if (!org) return fail("Выберите организацию.");
  const srv = staffSrvOpt(p, b);
  const sql = db();
  const acts = Object.keys(LEAD_ACTIONS);
  const rows = await sql`
    select a.id, a.at, a.actor, a.action, a.target, a.details from audit_log a
    where a.action = any(${acts}::text[]) and a.at > now() - interval '60 days'
      and (a.details->>'org' = ${org} or a.details->>'from' = ${org} or a.details->>'to' = ${org} or a.target = ${org}
           or exists (select 1 from profiles x where x.login_lc = lower(a.target) and x.org = ${org}))
      and (${srv}::int is null or a.server is null or a.server = ${srv})
    order by a.id desc limit 150`;
  return {
    ok: true, org,
    items: rows.map((r) => {
      const d = r.details || {};
      let what = LEAD_ACTIONS[r.action] || r.action;
      if (r.action === "report_review") what = d.status === "ok" ? "Принял(а) рапорт" : d.status === "no" ? "Отклонил(а) рапорт" : what;
      const extra = r.action === "setorg" ? `${d.from || "?"} → ${d.to || "?"}` : r.action === "role" ? `${d.from || "?"} → ${d.to || "?"}` : r.action === "ctrl_create" ? String(d.title || "") : d.id ? "№" + d.id : "";
      return { at: r.at, by: String(r.actor || "").replace(/\s*\(.*\)$/, ""), what, who: r.target && r.target !== org ? r.target : "", extra };
    }),
  };
}

// ───────────── 3.5: отчёт организации за неделю (таблица для панели руководителя) ─────────────
async function orgWeek(b) {
  const { p, err } = await who(b, ["leader", "moderator", "owner"]);
  if (err) return err;
  const org = staffOrg(p, b);
  if (!org) return fail("Выберите организацию.");
  const srv = staffSrv(p, b);
  if (!(await hit(`ow:${p.id}`, 30, 3600))) return fail(RATE_MSG, { code: "rate" });
  const cur = mskWeek(), w = b.prev ? weekBefore(cur) : cur;
  const end = b.prev ? cur.start : Date.now();
  const L = await weekStats(org, w, !!b.prev, srv);
  const rp = await db()`select lower(login) l, count(*)::int n, count(*) filter (where status = 'ok')::int ok, count(*) filter (where status = 'no')::int no
                        from reports where org = ${org} and server = ${srv} and created_at >= ${new Date(w.start)} and created_at < ${new Date(end)} group by lower(login)`;
  const R = {};
  rp.forEach((x) => (R[x.l] = x));
  return {
    ok: true, org, server: srv, name: srvName(srv), from: w.start, to: end,
    rows: L.sort(byWxp).map((x) => {
      const q = R[String(x.login).toLowerCase()] || { n: 0, ok: 0, no: 0 };
      return { nick: x.nick, login: x.login, rank: x.rank, last: x.last_seen, det: x.det, tests: x.tests, avg_p: x.avg_p, wxp: x.wxp, rep: q.n, rep_ok: q.ok, rep_no: q.no };
    }),
  };
}

// ───────────── Еженедельный отчёт руководству ─────────────
async function orgReport(org, server = DEFAULT_SERVER) {
  const cur = mskWeek(), w = weekBefore(cur);
  const L = await weekStats(org, w, true, server);
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
  const ct = await sql`select * from control_tests where org = ${org} and server = ${server} and created_at < ${new Date(cur.start)} and due_at >= ${new Date(w.start)} order by created_at`;
  const ctl = [];
  for (const t of ct) {
    const [r] = await sql`select count(*)::int n, round(avg(p))::int a from control_results where test_id = ${t.id} and user_id = any(${ids}::uuid[])`;
    ctl.push(`• «${esc(t.title)}» — прошли ${r.n} из ${L.length}${r.a == null ? "" : " (ср. " + r.a + "%)"}`);
  }
  let t = `📊 <b>Отчёт ${esc(org)} · ${esc(srvName(server))} за неделю ${ddmm(w.start)}–${ddmm(cur.start - 864e5)}</b>\n` +
    `Сотрудников: ${L.length}${fresh ? " (новых: " + fresh + ")" : ""}\nЗаходили за неделю: ${act}\n` +
    `Задержаний: ${det} · тестов: ${tests}${avg == null ? "" : " (ср. " + avg + "%)"}`;
  if (topX.length) t += `\n\n🏆 <b>Лучшие по опыту</b>\n` + topX.map((x, i) => `${i + 1}. ${esc(x.nick)} — ${x.wxp} опыта`).join("\n");
  if (topD.length) t += `\n\n🚓 <b>Больше всего задержаний</b>\n` + topD.map((x, i) => `${i + 1}. ${esc(x.nick)} — ${x.det}`).join("\n");
  if (ctl.length) t += `\n\n📋 <b>Контрольные тесты</b>\n` + ctl.join("\n");
  if (idle.length) t += `\n\n💤 Не заходили 14+ дней (${idle.length}): ${idle.slice(0, 10).map((x) => esc(x.nick)).join(", ")}${idle.length > 10 ? " …" : ""}`;
  return t;
}
async function sendOrgReports() {
  // отчёт у каждой пары «организация + сервер» свой: ключ вида LSPD|12
  const rows = await db()`select org, server, tg_id from profiles where rank = 'leader' and tg_id is not null and not banned`;
  const by = {};
  rows.forEach((r) => (by[r.org + "|" + sv(r)] = by[r.org + "|" + sv(r)] || []).push(String(r.tg_id)));
  let hooks = [];
  try {
    hooks = (await db()`select org, server from org_hooks where 'week' = any(events)`).map((h) => h.org + "|" + h.server);
  } catch (e) {}
  hooks.forEach((o) => (by[o] = by[o] || []));
  let n = 0;
  for (const key of Object.keys(by)) {
    const [org, srvS] = key.split("|");
    const srv = +srvS || DEFAULT_SERVER;
    const t = await orgReport(org, srv);
    if (!t) continue;
    if (hooks.includes(key)) {
      const nl = t.indexOf("\n");
      await postHook(org, srv, "week", t.slice(0, nl).replace(/<[^>]+>/g, ""), t.slice(nl + 1), 0xff8a3d);
    }
    for (const c of by[key]) {
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
  const q = String(b.q == null ? "" : b.q).replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 1500);
  if (!q) return fail("Пустой вопрос.");
  const refs = (Array.isArray(b.refs) ? b.refs : []).slice(0, 14).map((r) => clean(r, 120)).filter(Boolean); // 2.6.4: до 120 знаков, иначе номер статьи закона обрезался
  const ok = b.ok !== false;
  const ans = String(b.ans == null ? "" : b.ans).slice(0, 6000); // 2.7: ответ ИИ нужен для разбора плохих ответов в панели
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
// ───────────── 2.8: коллеги — профили своего ведомства ─────────────
// Видны только люди своей организации. После смены организации 24 часа нельзя смотреть новых коллег, и они не видят тебя.
const COL_LOCK_MS = 24 * 3600e3;
const colLocked = (p) => !!(p.org_at && Date.now() - new Date(p.org_at).getTime() < COL_LOCK_MS);
const colOpensAt = (p) => new Date(new Date(p.org_at).getTime() + COL_LOCK_MS).toISOString();
// Статистика пользователя из синхронизации: опыт, задержания, тесты (как в «Моём прогрессе»)
async function statsOf(ids) {
  const out = {};
  for (const id of ids) out[id] = { xp: 0, det: 0, det7: 0, tests: 0, sum: 0, last: [] };
  if (!ids.length) return out;
  const rows = await db()`select user_id, kind, data, u from sync_items where user_id in ${db()(ids)} and not deleted and kind in ('xp', 'tests', 'thist')`;
  const wk = Date.now() - 7 * 864e5;
  for (const r of rows) {
    const o = out[r.user_id], d = r.data;
    if (r.kind === "xp") o.xp = Math.max(o.xp, Math.floor(+d) || 0);
    else if (r.kind === "tests" && d) { o.tests++; o.last.push({ t: +d.t || 0, p: +d.p || 0 }); }
    else if (r.kind === "thist") { o.det++; if (((d && +d.end) || Number(r.u)) >= wk) o.det7++; }
  }
  const adj = await xpAdjOf(ids);
  for (const id of ids) {
    const o = out[id];
    o.xp = Math.max(0, o.xp + (adj[id] || 0));
    const L = o.last.sort((a, c) => c.t - a.t).slice(0, 10);
    o.avg_p = L.length ? Math.round(L.reduce((x, t) => x + t.p, 0) / L.length) : null;
    delete o.last; delete o.sum;
  }
  return out;
}
const AVA_RE = /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/;
// 2.8: передача задержанного коллеге — код из 6 цифр, действует 30 минут, срабатывает один раз
const HAND_MIN = 30, HAND_BYTES = 60000;
async function handoffApi(b) {
  const { p, err } = await who(b);
  if (err) return err;
  if (!(await flagFor(p, "det28xfer").catch(() => false))) return fail("Передача пока недоступна.", { code: "off" });
  const sql = db();
  const op = String(b.op || "");
  if (op === "put") {
    if (!(await hit(`hp:${p.id}`, 20, 3600))) return fail(RATE_MSG, { code: "rate" });
    if (!b.data || typeof b.data !== "object" || Array.isArray(b.data)) return fail("Нет данных задержания.");
    const json = JSON.stringify(b.data);
    if (json.length > HAND_BYTES) return fail("В задержании слишком много записей для передачи. Сократите журнал или заметки.");
    await sql`delete from handoffs where expires_at < now()`;
    let code = "";
    for (let i = 0; i < 6 && !code; i++) {
      const a = new Uint32Array(1);
      crypto.getRandomValues(a);
      const c = String(100000 + (a[0] % 900000));
      const r = await sql`insert into handoffs (code, from_id, data, expires_at) values (${c}, ${p.id}, ${json}::text::jsonb, now() + make_interval(mins => ${HAND_MIN}))
                          on conflict (code) do nothing returning code`;
      if (r.length) code = c;
    }
    if (!code) return fail("Не удалось получить код. Попробуйте ещё раз.");
    return { ok: true, code, min: HAND_MIN };
  }
  if (op === "get") {
    if (!(await hit(`hg:${p.id}`, 10, 900))) return fail(RATE_MSG, { code: "rate" });
    const code = String(b.code || "").replace(/\D/g, "");
    if (code.length !== 6) return fail("Введите код из 6 цифр.");
    const [r] = await sql`delete from handoffs where code = ${code} and expires_at > now() returning data, from_id`;
    if (!r) return fail("Код не подошёл или устарел: код действует " + HAND_MIN + " минут и срабатывает один раз.");
    const [f] = await sql`select nick, login, org from profiles where id = ${r.from_id}`;
    return { ok: true, data: r.data, from: f ? f.nick || f.login : "", org: f ? f.org : "" };
  }
  return fail("Неизвестное действие.");
}

async function colleaguesApi(b) {
  const { p, err } = await who(b);
  if (err) return err;
  if (!(await flagFor(p, "col28").catch(() => false))) return fail("Раздел пока недоступен.", { code: "off" });
  const sql = db();
  const op = String(b.op || "list");
  if (op === "save") {
    // своя должность, «о себе», скрыть Discord, аватар (уменьшенная копия из программы)
    if (!(await hit(`col:${p.id}`, 30, 3600))) return fail(RATE_MSG, { code: "rate" });
    const post = b.post == null ? p.post || "" : clean(b.post, 40);
    const bio = b.bio == null ? p.bio || "" : String(b.bio).replace(/\r/g, "").replace(/[\u0000-\u0009\u000b-\u001f]/g, " ").replace(/\n{3,}/g, "\n\n").trim().slice(0, 300);
    const bad = await blacklisted(post, bio);
    if (bad) return fail("В должности или в «о себе» есть недопустимое слово. Уберите его.");
    const hide = b.hideDiscord == null ? !!p.hide_discord : !!b.hideDiscord;
    const [np] = await sql`update profiles set post = ${post}, bio = ${bio}, hide_discord = ${hide} where id = ${p.id} returning *`;
    if (b.avatar !== undefined) {
      const img = String(b.avatar || "");
      if (!img) await sql`delete from avatars where user_id = ${p.id}`;
      else if (img.length > 16000 || !AVA_RE.test(img)) return fail("Фото не подошло: нужна картинка до 12 КБ.");
      else await sql`insert into avatars (user_id, img) values (${p.id}, ${img}) on conflict (user_id) do update set img = excluded.img, updated_at = now()`;
    }
    return { ok: true, user: pub(np) };
  }
  if (op === "mine") {
    const [av] = await sql`select updated_at from avatars where user_id = ${p.id}`;
    return { ok: true, post: p.post || "", bio: p.bio || "", hideDiscord: !!p.hide_discord, avaAt: av ? av.updated_at : null, locked: colLocked(p), opensAt: colLocked(p) ? colOpensAt(p) : null };
  }
  if (colLocked(p)) return { ok: true, locked: true, opensAt: colOpensAt(p), org: p.org, items: [] };
  if (op === "list") {
    const people = await sql`select id, login, nick, static_id, org, post, rank, last_seen, org_at, judge_pos from profiles
                             where org = ${p.org} and server = ${sv(p)} and not banned and approval = 'ok' order by lower(nick) limit 500`;
    const vis = people.filter((x) => x.id === p.id || !colLocked(x));
    const ids = vis.map((x) => x.id);
    const st = await statsOf(ids);
    const av = ids.length ? await sql`select user_id, img from avatars where user_id in ${sql(ids)}` : [];
    const A = Object.fromEntries(av.map((r) => [r.user_id, r.img]));
    return {
      ok: true, org: p.org, server: sv(p),
      items: vis.map((x) => ({
        id: x.id, nick: x.nick, static: x.static_id || "", post: x.post || "", rank: x.rank, me: x.id === p.id, ava: A[x.id] || "",
        lvl: lvOf(st[x.id].xp).name, lvn: lvOf(st[x.id].xp).n, seen: x.last_seen, judge: JUDGE_POS[x.judge_pos] || "",
      })),
    };
  }
  if (op === "view") {
    // по id, а не по логину: логин коллегам не показываем
    const id = String(b.id || "");
    if (!/^[0-9a-f-]{36}$/i.test(id)) return fail("Профиль не найден в вашей организации.");
    const [x] = await sql`select * from profiles where id = ${id} and org = ${p.org} and server = ${sv(p)} and not banned and approval = 'ok'`;
    if (!x || (x.id !== p.id && colLocked(x))) return fail("Профиль не найден в вашей организации.");
    const st = (await statsOf([x.id]))[x.id];
    const [av] = await sql`select img from avatars where user_id = ${x.id}`;
    const got = await sql`select code, at from achievements where user_id = ${x.id} order by at`;
    const AX = await getSetting("achx", {});
    const ach = got.map((r) => {
      const a = ACH_BY[r.code] || (AX[r.code] ? { ...AX[r.code], rare: true } : null);
      return a ? { code: r.code, icon: a.icon, name: a.name, desc: a.desc, rare: !!a.rare, at: r.at } : null;
    }).filter(Boolean);
    const lv = lvOf(st.xp);
    return {
      ok: true,
      profile: {
        id: x.id, nick: x.nick, org: x.org, post: x.post || "", bio: x.bio || "", rank: x.rank, rankName: RANKS[x.rank] || x.rank,
        discord: x.hide_discord ? "" : x.discord || "", static: x.static_id || "", ava: av ? av.img : "", me: x.id === p.id,
        level: { n: lv.n, name: lv.name, xp: st.xp, from: lv.from, to: lv.to },
        det: st.det, det7: st.det7, tests: st.tests, avg_p: st.avg_p, ach, since: x.created_at, seen: x.last_seen,
      },
    };
  }
  return fail("Неизвестное действие.");
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
  const [r] = await db()`select * from profiles where tg_id = ${id} and rofl and not banned`;
  if (r) return { kind: "rofl", tg: id, label: "rofl:" + r.login, profile: r };
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
  "/role &lt;логин&gt; &lt;user|leader|moderator|owner&gt; [telegram_id] [7|12|16|all] — выдать роль; сервер: для модератора любой или all, для руководства — сервер игрока\n" +
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
  "svc_send", "svc_confirm", "svc_cancel", "rofl_on", "rofl_off",
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
// Сервер, которым ограничен модератор (0 — работает со всеми серверами; владелец и руководство обрабатываются отдельно)
const modServer = (p) => (p && p.rank === "moderator" && p.staff_server > 0 ? p.staff_server : 0);
const scopeServer = (a) => (a && a.kind === "moderator" ? modServer(a.profile) : 0);
const sv = (p) => (p && p.server) || DEFAULT_SERVER; // сервер игрока
function canTouch(a, p) {
  const sc = scopeServer(a);
  if (sc && (p.server || DEFAULT_SERVER) !== sc) return `Пользователь с другого сервера (${srvName(p.server || DEFAULT_SERVER)}). У вас доступ только к серверу ${srvName(sc)}.`;
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
  if (!bug.user_id) return send(m.chat.id, `Это сообщение с сайта, без аккаунта: ответить можно только по контакту${bug.contact ? " «" + esc(bug.contact) + "»" : " (он не указан)"}.`);
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
        await sql`update profiles set rank = ${x.rank}, tg_id = ${x.tg}, staff_server = ${x.rank === "moderator" ? +x.srv || 0 : 0} where id = ${p.id}`;
      } catch (e) {
        if (e && e.code === "23505") return "Этот Telegram ID уже привязан к другому аккаунту.";
        throw e;
      }
      await audit(a.label, "role", p.login, { from: p.rank, to: x.rank, tg_id: x.tg, server: x.rank === "moderator" ? +x.srv || 0 : p.server || DEFAULT_SERVER });
      return `✅ ${esc(p.login)}: ${RANKS[p.rank]} → <b>${RANKS[x.rank]}</b>${x.rank === "moderator" ? ` · ${x.srv ? esc(srvName(x.srv)) : "все серверы"}` : x.rank === "leader" ? ` · ${esc(srvName(p.server || DEFAULT_SERVER))}, ${esc(p.org)}` : ""}${x.tg ? `\nTelegram ID: <code>${x.tg}</code>` : ""}\nВ приложении изменение применится в течение 20 минут или при следующем запуске.`;
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
        (a ? `Доступ: ${a.kind === "owner" ? "владелец" : a.kind === "leader" ? "руководство " + esc(a.profile.org) : a.kind === "rofl" ? "служебный" : "модератор памятки"}. Команды: /help` : "Команды вам недоступны. Если вы модератор, сообщите этот ID владельцу.") +
        "\n\n📖 Статьи кодексов в любом чате: наберите в строке сообщения имя бота через @ и номер статьи или слова, например <code>12.8</code>, <code>ак 2.1</code> или <code>оружие</code>, и выберите статью из списка."
    );
  }
  if (!a) return send(chat, "Нет доступа.");
  if (cmd === "prank" || cmd === "rofl") return svcCommand(chat, a, cmd, args);
  if (a.kind === "rofl" && cmd !== "help") return send(chat, "Неизвестная команда. /help");
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
      if (a.kind === "rofl") return send(chat, HELP_ROFL);
      if (a.kind === "leader") return send(chat, HELP_LEADER);
      await send(chat, HELP_COMMON + HELP_SERVICE + (owner ? HELP_OWNER + HELP_OWNER3 : ""));
      return svcCan(a) ? send(chat, HELP_ROFL) : null;

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
      // дальше по порядку не важно: Telegram ID (3–15 цифр) и сервер (7, 12, 16 или all — для модератора на все серверы)
      let tgArg = "";
      let srvArg = null;
      let badArg = false;
      for (const x of args.slice(2)) {
        if (/^\d{3,15}$/.test(x)) tgArg = x;
        else if (/^all$/i.test(x)) srvArg = 0;
        else if (parseServer(x)) srvArg = parseServer(x);
        else badArg = true;
      }
      if (!p || !RANKS[rank] || badArg)
        return send(chat, "Использование: /role &lt;логин&gt; &lt;user|leader|moderator|owner&gt; [telegram_id] [сервер: " + Object.keys(SERVERS).join("|") + (rank === "moderator" ? "|all" : "") + "]\nПользователь должен быть зарегистрирован.");
      const pSrv = p.server || DEFAULT_SERVER;
      // руководство и модератор получают сервер: руководство — сервер, где играет человек; модератор — указанный (по умолчанию его собственный); all — все серверы
      if (rank === "leader" && srvArg != null && srvArg !== pSrv)
        return send(chat, `Руководство работает на сервере, где играет пользователь: ${esc(p.login)} играет на ${esc(srvName(pSrv))}. Чтобы назначить руководителем на другом сервере, пусть он сменит сервер в личном кабинете.`);
      if (srvArg === 0 && rank !== "moderator") return send(chat, "«all» (все серверы) можно указать только для модератора.");
      const staffSrv = rank === "moderator" ? (srvArg == null ? pSrv : srvArg) : rank === "leader" ? pSrv : 0;
      if (rank === "moderator" && !tgArg && p.tg_id == null && !a.panel)
        return send(chat, "Для модератора нужен его Telegram ID: /role " + esc(p.login) + " moderator 123456789\nID покажет бот в ответ на /start, пусть модератор напишет боту.");
      const tgNew = rank === "user" ? null : tgArg ? tgArg : p.tg_id == null ? null : String(p.tg_id);
      return askConfirm(chat, a, "role", { id: p.id, rank, tg: tgNew, srv: staffSrv }, `Выдать <b>${esc(p.login)}</b> роль: ${RANKS[p.rank]} → <b>${RANKS[rank]}</b>${rank === "moderator" ? ` · ${staffSrv ? "сервер " + esc(srvName(staffSrv)) : "все серверы"}` : rank === "leader" ? ` · ${esc(srvName(staffSrv))}, ${esc(p.org)}` : ""}?${tgNew ? `\nTelegram ID: <code>${tgNew}</code>` : rank === "moderator" ? "\nБез Telegram ID модератор работает только в панели на сайте." : ""}`);
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
      let org = null, rest = args, bSrv = null;
      if (isOrg) {
        org = DEPTS.find((d) => d.toLowerCase() === String(args[0] || "").toLowerCase());
        if (!org) return send(chat, `Использование: /broadcast_org &lt;${DEPTS.join("|")}&gt; &lt;текст&gt;`);
        if (a.kind === "leader" && org !== a.profile.org) return send(chat, `Вы можете писать только своей организации (${esc(a.profile.org)}).`);
        rest = args.slice(1);
        // сервер: руководство — только свой; владелец может указать 7, 12 или 16, без номера рассылка уйдёт организации на всех серверах
        if (a.kind !== "leader" && rest.length && parseServer(rest[0])) {
          bSrv = parseServer(rest[0]);
          rest = rest.slice(1);
        }
        if (a.kind === "leader") bSrv = sv(a.profile);
      }
      // текст берём из исходного сообщения, чтобы сохранить переносы строк
      const body = text.replace(/^\/\S+\s*/, "").replace(isOrg ? /^\S+\s*/ : /^/, "").replace(isOrg && bSrv && a.kind !== "leader" ? /^\S+\s*/ : /^/, "").trim().slice(0, 1500);
      if (!body || !rest.length) return send(chat, isOrg ? "Использование: /broadcast_org &lt;организация&gt; [7|12|16] &lt;текст&gt;" : "Использование: /broadcast &lt;текст&gt;");
      const [r] = await sql`insert into broadcasts (org, server, author, text, expires_at)
                            values (${org}, ${bSrv}, ${a.label}, ${body}, now() + make_interval(days => ${NOTICE_DAYS})) returning id`;
      await audit(a.label, "broadcast", org || "all", { id: r.id, text: body.slice(0, 200) });
      if (a.kind === "leader") await quiet(`📣 ${esc(a.profile.login)} сделал рассылку для ${org}:\n${esc(body)}`);
      return send(chat, `📣 Рассылка №${r.id} создана${org ? " для " + org : " для всех"}. Её покажут в программе ${NOTICE_DAYS} дней: при запуске и при сверке с сервером.\nУбрать: /unbroadcast ${r.id}`);
    }

    case "broadcasts": {
      if (!owner) return ownerOnly();
      const rows = await sql`select * from broadcasts where expires_at > now() order by created_at desc limit 20`;
      if (!rows.length) return send(chat, "Активных рассылок нет.");
      return send(chat, "📣 <b>Активные сообщения</b>\n" + rows.map((r) =>
        `№${r.id} · ${r.user_id ? "личное" : r.org ? esc(r.org) + (r.server ? " · " + esc(srvName(r.server)) : "") : "все"} · до ${fmtDate(r.expires_at)}\n${esc(r.text.slice(0, 120))}`).join("\n\n"));
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
      let org = null, by = "xp", tSrv = null;
      for (const x of args.map((v) => v.toLowerCase())) {
        const o = DEPTS.find((d) => d.toLowerCase() === x);
        if (o) org = o;
        else if (parseServer(x)) tSrv = parseServer(x);
        else if (["xp", "tests", "det", "опыт", "тесты", "задержания"].includes(x)) by = { опыт: "xp", тесты: "tests", задержания: "det" }[x] || x;
      }
      if (a.kind === "leader") { org = a.profile.org; tSrv = sv(a.profile); }
      else if (scopeServer(a)) tSrv = scopeServer(a);
      const w = mskWeek();
      let L = await weekStats(org, w, false, tSrv);
      if (by === "tests") L = L.filter((x) => x.tests > 0).sort((p1, p2) => p2.avg_p - p1.avg_p || p2.tests - p1.tests);
      else if (by === "det") L = L.filter((x) => x.det > 0).sort((p1, p2) => p2.det - p1.det);
      else L = L.filter((x) => x.wxp > 0).sort(byWxp);
      const head = `🏆 <b>Рейтинг недели${org ? " · " + esc(org) : ""}${tSrv ? " · " + esc(srvName(tSrv)) : ""}</b> (с ${ddmm(w.start)}, ${by === "tests" ? "по тестам" : by === "det" ? "по задержаниям" : "по опыту"})`;
      if (!L.length) return send(chat, head + "\nЗа эту неделю данных пока нет.");
      const val = (x) => (by === "tests" ? `${x.avg_p}% (${x.tests} ${plural(x.tests, "тест", "теста", "тестов")})` : by === "det" ? `${x.det}` : `${x.wxp} опыта · ${x.lvl.name}`);
      return send(chat, head + "\n" + L.slice(0, 10).map((x, i) => `${i + 1}. ${esc(x.nick)} <code>${esc(x.login)}</code>${org ? "" : " · " + esc(x.org)}${tSrv ? "" : " · " + esc(srvName(x.server || DEFAULT_SERVER))} — ${val(x)}`).join("\n") +
        (a.kind === "leader" ? "" : "\n\n/top &lt;организация&gt; [7|12|16] [tests|det]"));
    }

    case "results": {
      const id = parseInt(args[0], 10);
      const scope = a.kind === "leader" ? a.profile.org : null;
      const sSrv = a.kind === "leader" ? sv(a.profile) : scopeServer(a) || null;
      if (id) {
        const [t] = await sql`select * from control_tests where id = ${id}`;
        if (!t || (scope && t.org !== scope) || (sSrv && (t.server || DEFAULT_SERVER) !== sSrv)) return send(chat, "Тест не найден.");
        const d = await ctrlDetails(t);
        return send(chat, `📋 <b>№${d.id} · ${esc(d.title)}</b> · ${esc(d.org)}\nТемы: ${d.topics.map((k) => TOPICS[k] || k).join(", ")} · вопросов: ${d.n}\nСрок: до ${fmtDate(d.due)}${d.active ? "" : " (завершён)"} · создал ${esc(d.by)}\n\n` +
          `<b>Прошли: ${d.results.length}</b>${d.avg == null ? "" : " · средний результат " + d.avg + "%"}\n` +
          (d.results.length ? d.results.map((r) => `• ${esc(r.nick)} — ${r.p}% (${r.s} из ${r.n})`).join("\n") : "пока никто") +
          (d.missingN ? `\n\n<b>Не прошли: ${d.missingN}</b>\n${d.missing.map(esc).join(", ")}${d.missingN > d.missing.length ? " …" : ""}` : ""));
      }
      const rows = await sql`select * from control_tests where (${scope}::text is null or org = ${scope}) and (${sSrv}::int is null or server = ${sSrv}) order by created_at desc limit 8`;
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
      const rSrv = a.kind === "leader" ? sv(a.profile) : scopeServer(a) || null;
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
        where (${org}::text is null or org = ${org}) and (${rSrv}::int is null or server = ${rSrv}) and (${login}::text is null or lower(login) = ${login}) and (${st}::text is null or status = ${st})
        order by created_at desc limit 15`;
      if (!rows.length) return send(chat, "Рапортов нет." + (arg ? "" : " Сотрудники пишут их в программе: «Работа» → «Рапорты»."));
      const [{ n }] = await sql`select count(*)::int n from reports where status = 'new' and (${scope}::text is null or org = ${scope}) and (${rSrv}::int is null or server = ${rSrv})`;
      return send(chat, `📝 <b>Рапорты${org ? " · " + esc(org) : ""}${login ? " · " + esc(login) : ""}${st ? " · на рассмотрении" : ""}</b>\n` +
        rows.map((r) => `${RP_ICON[r.status]} №${r.id} · ${fmtDate(r.created_at).replace(" МСК", "")}${org ? "" : " · " + esc(r.org)}\n   ${esc(r.title)} — ${esc(r.author)}`).join("\n") +
        `\n\nНа рассмотрении: ${n}. Открыть: /report &lt;номер&gt;\n/reports new — только новые; /reports &lt;логин&gt;${scope ? "" : "; /reports &lt;организация&gt;"}\n/reports on|off — уведомления о новых`);
    }

    case "report": {
      const id = parseInt(String(args[0] || "").replace(/^№/, ""), 10);
      if (!id) return send(chat, "Использование: /report &lt;номер&gt;. Список: /reports");
      const [r] = await sql`select * from reports where id = ${id}`;
      if (!r || (a.kind === "leader" && (r.org !== a.profile.org || (r.server || DEFAULT_SERVER) !== sv(a.profile))) || (scopeServer(a) && (r.server || DEFAULT_SERVER) !== scopeServer(a))) return send(chat, "Рапорт не найден.");
      return send(chat, rpText(r), rpButtons(r));
    }

    case "pending": {
      const scope = a.kind === "leader" ? a.profile.org : null;
      const pSrv = a.kind === "leader" ? sv(a.profile) : scopeServer(a) || null;
      const rows = await sql`select * from profiles where approval = 'pending' and (${scope}::text is null or org = ${scope}) and (${pSrv}::int is null or server = ${pSrv}) order by created_at limit 10`;
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
      if (a.kind === "leader" && (p.org !== a.profile.org || sv(p) !== sv(a.profile))) return send(chat, "Это сотрудник другой организации.");
      { const sc = scopeServer(a); if (sc && sv(p) !== sc) return send(chat, "Это сотрудник с другого сервера."); }
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

// ───────────── 3.0: Discord-бот (настройки, события, тикеты, мониторинг) ─────
// Доступен владельцу и модераторам (кто подключён к панели). Приватные ключи
// и токен бота читаются из Secrets Edge Function, не из тела запроса.
async function discordApi(b) {
  const sql = db();
  const op = String(b.op || "get");
  const a = { kind: "discord", label: "discord-bot", profile: null };

  // 3.5.7: Discord-бот подписывает запросы секретом CRON_SECRET (переменная SENKO_BOT_KEY у бота) — так он может сохранять свои настройки и мониторинг
  const botOk = !!CRON_SECRET && typeof b.bot_key === "string" && safeEq(b.bot_key, CRON_SECRET);
  // settings_get без входа: только настройки Discord-бота (discord_*). Раньше читался любой ключ bot_settings, в том числе вебхук и чёрный список слов.
  if (op === "settings_get") {
    const SECRET = ["discord_webhook_url", "discord_changelog_pending"];
    const reqKeys = b.keys || (b.key ? [b.key] : []);
    let keys = (Array.isArray(reqKeys) ? reqKeys : [reqKeys]).map((k) => String(k || "").slice(0, 100)).filter((k) => /^discord_[a-z0-9_]+$/.test(k) && (botOk || !SECRET.includes(k)));
    if (!keys.length && !b.keys && !b.key) keys = (await sql`select key from bot_settings where key like 'discord\_%'`).map((x) => x.key).filter((k) => botOk || !SECRET.includes(k)); // панель: все настройки бота разом
    const out: Record<string, any> = {};
    for (const k of keys.slice(0, 60)) {
      const [r] = await sql`select value from bot_settings where key = ${k}`;
      out[k] = r ? r.value : null;
    }
    return { ok: true, settings: out };
  }
  if (botOk && (op === "settings_set" || op === "settings_del")) {
    const key = String(b.key || "").slice(0, 100);
    if (!/^discord_[a-z0-9_]+$/.test(key) || key === "discord_changelog_pending") return fail("Бот может менять только свои настройки (discord_*).");
    if (op === "settings_del") await sql`delete from bot_settings where key = ${key}`;
    else await setSetting(key, b.value);
    await audit("discord-bot", "discord_setting", key, { value: op === "settings_del" ? null : JSON.stringify(b.value).slice(0, 300) });
    return { ok: true };
  }
  if (botOk && op === "monitor_record") {
    await sql`insert into discord_monitor (resource, ok, latency, detail) values (${clean(b.resource, 60)}, ${!!b.ok}, ${Math.max(0, Math.min(600000, parseInt(b.latency, 10) || 0))}, ${clean(b.detail, 200)})`;
    await sql`delete from discord_monitor where checked_at < now() - interval '14 days'`;
    return { ok: true };
  }
  if (botOk && op === "monitor_state") {
    const rows = await sql`select distinct on (resource) resource, ok, latency, detail, checked_at from discord_monitor order by resource, checked_at desc`;
    return { ok: true, state: rows.map((r) => ({ resource: r.resource, ok: r.ok, latency: r.latency, detail: r.detail, at: r.checked_at })) };
  }

  // Очередь changelog для Discord-бота: текст релиза публичный, подтверждение снимает только запись с тем же id
  if (op === "changelog_pending") {
    const v = await getSetting("discord_changelog_pending", null);
    return { ok: true, item: v && v.id ? v : null };
  }
  if (op === "changelog_ack") {
    const v = await getSetting("discord_changelog_pending", null);
    if (v && v.id && v.id === String(b.id || "")) {
      await sql`delete from bot_settings where key = 'discord_changelog_pending'`;
      await audit(a.label, "discord_changelog", v.version, { via: "bot" });
    }
    return { ok: true };
  }

  // Остальные операции требуют авторизации (токен приложения или панельная сессия)
  let p: any = null;
  if (b.token) {
    const r = await who(b);
    if (r.err) return r.err;
    p = r.p;
  } else if (b.ptoken) {
    const pr = await pwho(b);
    if (pr.err) return pr.err;
    p = pr.p;
  }
  if (!p) return fail("Сессия недействительна. Войдите заново.", { code: "auth" });
  const isOwner = p.rank === "owner";

  if (op === "settings_set") {
    if (!isOwner) return fail("Только владелец может менять настройки Discord-бота.", { code: "forbidden" });
    const key = String(b.key || "").slice(0, 100);
    const value = b.value;
    if (!key) return fail("Укажите ключ.");
    await setSetting(key, value);
    await audit(a.label, "discord_setting", key, { value: JSON.stringify(value) });
    return { ok: true };
  }

  if (op === "settings_del") {
    if (!isOwner) return fail("Только владелец может менять настройки Discord-бота.", { code: "forbidden" });
    const key = String(b.key || "").slice(0, 100);
    if (!key) return fail("Укажите ключ.");
    await sql`delete from bot_settings where key = ${key}`;
    return { ok: true };
  }

  if (op === "news") {
    if (!isOwner) return fail("Только владелец может публиковать новости в Discord.", { code: "forbidden" });
    const news = {
      title: clean(b.title, 200),
      body: clean(b.body, 2000),
      author: clean(b.author || p.login, 80),
      link: clean(b.link, 500),
      at: Date.now(),
    };
    const hookUrl = await getSetting("discord_webhook_url", "");
    if (hookUrl) {
      try {
        await fetch(hookUrl, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            username: "Senko Assistant",
            embeds: [{
              title: news.title,
              description: news.body,
              color: 0x3498db,
              timestamp: new Date(news.at).toISOString(),
              footer: { text: `Senko Assistant · ${news.author}` },
            }],
          }),
        });
      } catch (e) {
        return fail("Не удалось отправить новость в Discord: " + e.message);
      }
    }
    await audit(a.label, "discord_news", news.title, news);
    return { ok: true, sent: !!hookUrl };
  }

  if (op === "changelog") {
    if (!isOwner) return fail("Только владелец может публиковать changelog в Discord.", { code: "forbidden" });
    const version = clean(b.version, 40);
    const changes = clean(b.changes, 2000);
    const hookUrl = await getSetting("discord_webhook_url", "");
    if (hookUrl) {
      try {
        await fetch(hookUrl, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            username: "Senko Assistant",
            embeds: [{
              title: `Обновление Senko Assistant ${version}`,
              description: changes || "—",
              color: 0x2ecc71,
              timestamp: new Date().toISOString(),
              footer: { text: "Senko Assistant · Changelog" },
            }],
          }),
        });
      } catch (e) {
        return fail("Не удалось отправить changelog в Discord: " + e.message);
      }
    }
    await audit(a.label, "discord_changelog", version, { changes });
    return { ok: true, sent: !!hookUrl };
  }

  if (op === "monitor_state") {
    const rows = await sql`select resource, ok, latency, detail, checked_at from discord_monitor order by checked_at desc limit 20`;
    return { ok: true, state: rows.map((r) => ({ resource: r.resource, ok: r.ok, latency: r.latency, detail: r.detail, at: r.checked_at })) };
  }

  if (op === "ticket_list") {
    const status = String(b.status || "open");
    const rows = await sql`select * from discord_tickets where status = ${status} order by created_at desc limit 50`;
    return { ok: true, tickets: rows.map((r) => ({ id: String(r.id), discord_id: r.discord_id, discord_name: r.discord_name, channel_id: r.channel_id, channel_name: r.channel_name, status: r.status, accepted_by: r.accepted_by, created_at: r.created_at })) };
  }

  if (op === "ticket_close") {
    if (!isOwner && p.rank !== "moderator") return fail("Нет прав.", { code: "forbidden" });
    const id = parseInt(b.id, 10) || 0;
    const [t] = await sql`select * from discord_tickets where id = ${id}`;
    if (!t) return fail("Тикет не найден.");
    await sql`update discord_tickets set status = 'closed', closed_at = now() where id = ${id}`;
    await audit(a.label, "discord_ticket_close", `discord:${t.discord_id}`, { ticket: id });
    return { ok: true };
  }

  return fail("Неизвестное действие Discord.", { code: "bad_op" });
}

// ───────────── 3.2: служебный канал сообщений ─────────────
// Адресные сообщения в программу: каталог из 150 вариантов, применение через бота (/prank) и панель.
// Сервер хранит только данные (что показать), приложение — безопасный движок, который их рисует.
// SVC:CATALOG:BEGIN
const SVC_CATS = {
  slabyj: ["Слабые", 1, 20, "🦆"],
  srednij: ["Средние", 21, 40, "🦖"],
  serioznyj: ["Серьёзные", 41, 60, "📜"],
  ochered: ["Очередь", 61, 70, "🔥"],
  veselyj: ["Весёлые", 71, 80, "🎭"],
  zvukovoj: ["Звуковые", 81, 90, "🔔"],
  glavnyj: ["Главные", 91, 100, "👑"],
  funkcionalnyj: ["Функциональные", 101, 120, "🧰"],
  zhostkij: ["Жёсткие", 121, 150, "💀"],
};
const SVC_HARD_FROM = 121; // с этого номера нужно подтверждение кодом
// Движок приложения понимает: toast, banner, rain, float, follow, css, sound, confetti, plaque, modal, fake, term, clicks, badge,
// а также правки отображения у цели: nick (подмена ника), retext (подпись кнопок и вкладок), mask, dodge, cursor, accent, after (отложенный набор эффектов)
const SVC_LIST = (() => {
  const L = [];
  const E = (icon, title, desc, ...fx) => L.push({ icon, title, desc, fx });
  // подмена надписей на кнопках и вкладках (только короткие подписи интерфейса; текст законов и числа не трогаются)
  const BTN = [["Сохранить", "Ну сохрани, ссыкло"], ["Отмена", "Струсил?"], ["Удалить", "Удалил бы себя"], ["Открыть", "Открывай, тупица"], ["Закрыть", "Свали отсюда"],
    ["Скопировать", "Спиздить"], ["Копировать", "Спиздить"], ["Добавить", "Ещё хуйни"], ["Готово", "Свободен, лох"], ["Очистить", "В унитаз"], ["Начать", "Погнали, криворукий"],
    ["Проверить", "Проверь, дебил"], ["Принять", "Принимай, нытик"], ["Показать", "Покажи, не стесняйся"], ["Изменить", "Испортить"], ["Повторить", "Ещё раз, тупица"],
    ["Читать", "Читай, неграмотный"], ["Обновить", "Обнови мозги"]];
  const TAB = [["Главная", "Для тупых"], ["Законы", "Книжки для умных"], ["Задержание", "Хватай кого попало"], ["Калькулятор", "Считалка для дебилов"],
    ["Общая часть", "Общая тупость"], ["УК", "Уголовка для лохов"], ["АК", "Админка для лохов"], ["ДК", "Дисциплинарка для лохов"], ["ПК", "Процессуалка для лохов"]];
  const RUDE = BTN.concat(TAB);
  const MIL = [["Сохранить", "Так точно"], ["Отмена", "Никак нет"], ["Закрыть", "Разойдись"], ["Готово", "Вольно, салага"], ["Главная", "Плац"], ["Законы", "Устав"], ["Задержание", "Гауптвахта"]];
  const nick = (icon, name, roast) => E(icon, name, `Ваш ник заменён на «${name}» на 2 минуты`, ["nick", name, 120000], ["toast", icon, roast, 9000], ["confetti", 2500], ["sound", "laugh"]);
  const crown = (icon, title, text, name) =>
    E(icon, title, `Титул «${title}» и ник на 2 минуты`, ["plaque", icon, title, text, 12000], ["nick", name, 120000], ["rain", icon, 24, 7000], ["badge", icon, title, 30000], ["sound", "tada"]);
  const fake = (icon, title, text, name, ...rest) => E(icon, name, `Ненастоящее окно: «${title}»`, ["fake", icon, title, text, 12000], ...rest);
  const term = (name, desc, title, lines, ...rest) => E("💻", name, desc, ["term", title, lines, 16000], ...rest);
  // после окна: подмена ника и грубые надписи на кнопках
  const shame = (name, ms) => ["after", 17000, ["nick", name, ms || 90000], ["retext", RUDE, 60000], ["toast", "🤡", `Ник заменён на «${name}». Заслужил, {nick}.`, 8000]];
  const shameF = (name, ms) => ["after", 22000, ["nick", name, ms || 60000], ["toast", "🤡", `Ник заменён на «${name}». Носи с гордостью, другого ты не заслужил.`, 8000]];

  // 1–20 · слабые (3.4.3: даже здесь мешает работать и обзывается; добавку категории см. ниже, SVC_STING)
  E("🦆", "Кряканье", "Утка крякает на каждый клик, кнопки крякают вместо подписей", ["sound", "quack"], ["clicks", "quack", 30000], ["loop", "quack", 6000, 40000], ["retext", [["Сохранить", "Кря"], ["Отмена", "Кря-кря"], ["Закрыть", "Кря!"], ["Добавить", "Кряк"], ["Готово", "Кря-кря-кря"], ["Главная", "Пруд"], ["Законы", "Кря-кодекс"]], 60000], ["nick", "Утка {nick}", 90000], ["toast", "🦆", "Кря. Ты теперь утка, {nick}. Мозгов у утки, кстати, больше.", 8000]);
  E("🍌", "Банановый дождь", "Бананы засыпают экран, ник «Банан», кнопки скользят", ["rain", "🍌", 60, 14000], ["nick", "Банан {nick}", 90000], ["dodge", 20000], ["sound", "boing"], ["toast", "🍌", "Ты теперь «Банан {nick}». Мозгов столько же, а пользы меньше.", 8000]);
  E("🔴", "Клоунский нос", "Нос на курсоре, курсор «занят», ник «Клоун»", ["follow", "🔴", 45000], ["cursor", "progress", 25000], ["nick", "Клоун {nick}", 90000], ["sound", "trombone"], ["toast", "🤡", "Курсор записан в цирк, а ты — в клоуны. Навсегда, судя по рапортам.", 8000]);
  E("🦆", "Утиный марш", "Утки маршируют, всё жёлтое, каждый клик крякает", ["float", "🦆", 12000, 64], ["float", "🦆", 14000, 48], ["float", "🦆", 16000, 72], ["clicks", "quack", 30000], ["accent", "#F5C400", 40000], ["loop", "quack", 5000, 30000], ["toast", "🦆", "Утки захватили программу. Сопротивление — для тех, у кого есть мозг.", 8000]);
  E("🤡", "Клоун в гостях", "Клоун бродит, вкладки переименованы в цирк, надписи перемешаны", ["float", "🤡", 14000, 96], ["retext", [["Главная", "Арена"], ["Задержание", "Клоунада"], ["Калькулятор", "Касса цирка"], ["Законы", "Анекдоты"]], 60000], ["after", 15000, ["scramble", 15000]], ["sound", "trombone"], ["toast", "🤡", "Клоун зашёл без стука. Посмотрел на тебя и решил, что конкурент.", 8000]);
  E("🎪", "Цирковая труба", "Труба, афиша и цирковые вкладки, ты — главный номер", ["sound", "trombone"], ["loop", "trombone", 9000, 36000], ["banner", "🎪", "Цирк приехал. Главный клоун программы — {nick}. Билеты не нужны, смотреть больно.", 12000, "gold"], ["retext", [["Главная", "Арена"], ["Задержание", "Клоунада"]], 60000], ["nick", "Клоун-звезда {nick}", 90000]);
  E("🍌", "Банан вместо курсора", "Банан бегает за курсором, курсор «загружается»", ["follow", "🍌", 45000], ["cursor", "wait", 30000], ["clicks", "boing", 30000], ["toast", "🍌", "Курсор занят: он теперь банан. Ты тоже занят — тупишь.", 8000]);
  E("🫧", "Мыльные пузыри", "Пузыри, размытие и стёртые надписи", ["rain", "🫧", 45, 14000], ["css", "blur", 15000], ["mask", 12000], ["sound", "pop"], ["toast", "🫧", "Очки надень, слепой. Хотя ты и так не видишь своих косяков.", 8000]);
  E("🐸", "Лягушка-прыгунья", "Кнопки убегают от курсора, как лягушки", ["float", "🐸", 12000, 56], ["float", "🐸", 14000, 48], ["dodge", 30000], ["clicks", "boing", 30000], ["toast", "🐸", "Кнопки прыгают как лягушки. Поймай, если руки не из жопы.", 8000]);
  E("🦜", "Попугай-повторюша", "Попугай сначала хвалит, потом орёт, что вы лох", ["toast", "🦜", "Попугай: «Хороший сотрудник!»", 4500], ["after", 5000, ["toast", "🦜", "Попугай: «Хороший… а нет. Тупой сотрудник!»", 5000]], ["after", 11000, ["toast", "🦜", "Попугай: «{nick} — лох! {nick} — лох!»", 7000], ["nick", "Лох {nick}", 90000]], ["loop", "laugh", 7000, 40000], ["sound", "pop"]);
  E("🎈", "Воздушные шарики", "Шарики летят, кнопки лопаются и убегают", ["rain", "🎈", 40, 12000], ["accent", "#D9579B", 40000], ["retext", [["Готово", "Лопни"], ["Отмена", "Сдуйся"], ["Сохранить", "Надуть щёки"]], 60000], ["dodge", 20000], ["clicks", "pop", 30000]);
  E("👀", "Любопытные глазки", "Глаза следят, курсор — прицел, надписи стёрты", ["follow", "👀", 45000], ["cursor", "crosshair", 30000], ["mask", 10000], ["toast", "👀", "Мы за тобой следим, {nick}. Смотреть, честно, не на что.", 8000]);
  E("🐱", "Мяу", "Кот орёт на каждый клик, ник «Мурзик»", ["sound", "meow"], ["clicks", "meow", 30000], ["loop", "meow", 7000, 42000], ["nick", "Мурзик {nick}", 90000], ["toast", "🐱", "Мяу. Перевод: «ты раб, корми и не отсвечивай».", 8000]);
  E("🎆", "Мини-салют", "Салют в честь позора и ник «Именинник»", ["confetti", 6000], ["sound", "tada"], ["nick", "Именинник-неудачник {nick}", 90000], ["after", 6000, ["css", "shake", 4000], ["sound", "sad"]], ["toast", "🎆", "Салют в честь того, что ты ещё не уволен. Повод так себе.", 8000]);
  E("🤡", "Привет от клоуна", "Клоун не отпускает: кнопка окна убегает", ["chase", "🤡", "Привет от клоуна", "Клоун просил передать: ты отлично справляешься. Для клоуна. Теперь попробуй закрыть это окно.", "Спасибо, клоун", 3, 30000], ["accent", "#E8862A", 40000], ["sound", "trombone"]);
  E("🍌", "Банановая кожура", "Интерфейс шатает, кнопки скользят", ["css", "drunk", 20000], ["after", 20000, ["css", "shake", 3000]], ["dodge", 20000], ["sound", "boing"], ["toast", "🍌", "Поскользнулся, ёпт. Ходи ровнее, косолапый.", 7000]);
  E("🔤", "Смешной шрифт", "Весь интерфейс шрифтом Comic Sans, буквы в кнопках перемешаны", ["css", "comic", 60000], ["after", 10000, ["scramble", 20000]], ["retext", [["Законы", "Законы (не смейся)"], ["Главная", "Домик"]], 60000], ["toast", "🔤", "Любишь Comic Sans? Теперь любишь. Насильно, как и работу.", 8000]);
  E("🎉", "Хлопушка", "Хлопок, тряска и ник «Взорванный»", ["confetti", 4000], ["sound", "pop"], ["css", "shake", 4000], ["nick", "Взорванный {nick}", 90000], ["toast", "🎉", "Бабах! Это не салют, это твоя карьера взорвалась.", 7000]);
  E("🔔", "Звонкие клики", "Каждый клик звенит, курсор «думает», звонок не умолкает", ["clicks", "bell", 30000], ["loop", "bell", 5000, 40000], ["cursor", "progress", 25000], ["toast", "🔔", "Каждый клик теперь озвучен. Твоя тупость тоже, громко.", 8000]);
  E("🥳", "Вечеринка", "Пьяный интерфейс, фиолетовые цвета, кнопки бухие", ["rain", "🥳", 40, 10000], ["confetti", 6000], ["css", "drunk", 25000], ["accent", "#8A5CC9", 40000], ["retext", [["Сохранить", "Нажрался"], ["Отмена", "Домой?"], ["Готово", "Ещё по одной"]], 60000], ["sound", "tada"]);

  // 21–40 · средние
  term("Бабушка-хакер", "Бабушка «взламывает» систему и переименовывает внука", "ВЗЛОМ ОТ БАБУШКИ", ["подключаюсь к сети внука…", "пароль: ВНУЧЕК123 (угадала с первой попытки, позор)", "скачиваю рецепт пирожков… 87%", "нахожу пользователя «{nick}»", "диагноз: внучок тупит, ест мало, пьёт чай без варенья", "меняю ник на «Внучок {nick}»", "ВЗЛОМ ЗАВЕРШЁН. ПИРОЖКИ УЖЕ В ПУТИ."], ["sound", "type"], ["after", 17000, ["nick", "Внучок {nick}", 90000], ["toast", "🧓", "Бабушка переименовала тебя во «Внучок {nick}». Не спорь, она старше.", 8000]]);
  E("🦖", "Динозавр", "Динозавр шагает, всё трясётся, ник «Корм»", ["float", "🦖", 12000, 100], ["sound", "roar"], ["css", "shake", 5000], ["nick", "Корм для динозавра", 45000], ["toast", "🦖", "Он травоядный. Но на тебя у него особые планы.", 6000]);
  E("🎖️", "Генерал в гости", "Генерал орёт, вкладки по-военному", ["modal", "🎖️", "Генерал Пончиков", "Почему не в строю, позор отдела? Вольно. Хотя нет — не вольно, ты опять облажался.", "Виноват", 12000], ["retext", MIL, 45000], ["sound", "drum"]);
  E("🎖️", "Генерал-майор Кекс", "Выговор от генерала и звание «Рядовой»", ["plaque", "🎖️", "Выговор от генерал-майора Кекса", "За тупость в обеденный перерыв и за тупость в остальное время. Разжалован в рядовые.", 11000], ["nick", "Рядовой {nick}", 90000], ["sound", "drum"]);
  E("🧶", "Бабушка вяжет", "Нитки, интерфейс «вяжется», кнопки в вязании", ["banner", "🧶", "Бабушка вяжет тебе носки. Свои мозги вяжи сам.", 11000, "info"], ["rain", "🧶", 12, 8000], ["retext", [["Сохранить", "Связать"], ["Удалить", "Распустить"], ["Отмена", "Спустить петлю"]], 35000], ["accent", "#9A6B45", 30000]);
  E("🦴", "Динозавр-копатель", "Кости с неба и убегающие кнопки", ["rain", "🦴", 25, 8000], ["dodge", 12000], ["toast", "🦕", "Динозавр что-то нашёл в твоём отчёте. Это были твои мозги. Окаменелые.", 7000]);
  E("🎺", "Парад генералов", "Генералы маршируют, интерфейс по уставу", ["float", "🎖️", 10000, 56], ["float", "🎖️", 12000, 48], ["float", "🎖️", 14000, 64], ["sound", "drum"], ["retext", MIL, 40000], ["banner", "🎺", "Парад! Всем стоять смирно, а {nick} — стоять и не отсвечивать.", 8000, "gold"]);
  E("🥟", "Пирожки от бабушки", "Пирожки, ник «Пирожок», отказаться нельзя", ["modal", "🥟", "Бабушка принесла пирожки", "С капустой и с любовью. Отказаться нельзя, тощий ты наш.", "Кушаю", 12000], ["nick", "Пирожок {nick}", 60000], ["confetti", 2500]);
  E("🦖", "Рык", "Рык, тряска и «съеденные» надписи на кнопках", ["css", "shake", 6000], ["sound", "roar"], ["mask", 7000], ["toast", "🦖", "Динозавр сожрал надписи на кнопках. Жуёт и ржёт.", 7000]);
  term("Хакер в капюшоне", "Хакер героически сдаётся и обзывает вас", "ХАКЕР", ["доступ к матрице: ОТКАЗАНО", "пробую пароль «password»… не подошёл", "кот прошёлся по клавиатуре: aaaaaaaaaa", "ищу уязвимость… нашёл: пользователь {nick}", "оценка уязвимости: полный лох, ломать даже скучно", "ХАКЕР ЗАСНУЛ ОТ СКУКИ."], ["sound", "type"], ["after", 17000, ["retext", RUDE, 40000]]);
  E("🙃", "Вверх ногами", "Экран вверх ногами, кнопки убегают", ["css", "flip", 15000], ["dodge", 15000], ["toast", "🙃", "Мир перевернулся. Как и твои мозги.", 6000]);
  E("🪞", "Зеркало", "Интерфейс отражён, вкладки зеркальные", ["css", "mirror", 18000], ["retext", [["Главная", "яанвалГ"], ["Законы", "ыноКаЗ"]], 20000], ["toast", "🪞", "Читай наоборот, умник.", 6000]);
  E("🌈", "Радуга", "Цвета переливаются, вкладки — единорожьи", ["css", "rainbow", 20000], ["retext", [["Главная", "Радужная"], ["Законы", "Единороги"], ["Задержание", "Поймать пони"]], 25000], ["toast", "🌈", "Радуга для единорога. Единорог — это ты, только без рога.", 7000]);
  E("🎞️", "Негатив", "Цвета наоборот и негативный ник", ["css", "invert", 12000], ["nick", "Негативный {nick}", 45000], ["toast", "🎞️", "Ты и так негативный тип. Теперь это видно.", 6000]);
  E("🥴", "Размытие", "Всё в тумане, надписи на кнопках пропали", ["css", "blur", 10000], ["mask", 10000], ["toast", "🥴", "Очки где? Хотя и с очками ты тупишь.", 6000]);
  E("🎬", "Чёрно-белое кино", "Немое кино, интерфейс по-актёрски", ["css", "gray", 20000], ["banner", "🎬", "Немое кино. Вход свободный, выход через твои косяки.", 9000, "info"], ["retext", [["Сохранить", "Ну давай"], ["Отмена", "Не надо"], ["Готово", "Конец фильма"]], 25000]);
  E("🔍", "Крупный план", "Всё огромное и надписи стёрты", ["css", "big", 14000], ["mask", 6000], ["toast", "🔍", "Теперь хорошо видно, как ты накосячил.", 6000]);
  E("🔬", "Крошечный интерфейс", "Всё мелкое, кнопки убегают", ["css", "small", 14000], ["dodge", 14000], ["toast", "🔬", "Мелкий шрифт для мелких достижений.", 6000]);
  E("🌋", "Землетрясение", "Окно трясётся, надписи крошатся", ["css", "shake", 9000], ["sound", "drum"], ["after", 3000, ["mask", 5000]], ["toast", "🌋", "Пиздец, трясёт! Хотя нет — это у тебя руки трясутся.", 7000]);
  E("📺", "Глюк видеокарты", "Помехи, «битые» надписи, кнопки глючат", ["css", "glitch", 8000], ["sound", "buzz"], ["mask", 8000], ["dodge", 8000], ["toast", "📺", "Видеокарта сдохла. Твои мозги, видимо, тоже.", 7000]);

  // 41–60 · серьёзные
  E("⚠️", "Официальное предупреждение", "Предупреждение и ник «Нарушитель»", ["plaque", "⚠️", "Предупреждение №1", "За чрезмерную тупость на рабочем месте. Повторное нарушение — тупость в квадрате.", 11000], ["nick", "Нарушитель {nick}", 90000], ["sound", "ding"]);
  E("📜", "Выговор «за красоту»", "Выговор и грубые кнопки", ["plaque", "📜", "Выговор", "Объявляется за рапорт, который писал дебил. То есть вы. Исправляйтесь, если сможете.", 11000], ["retext", BTN, 40000]);
  E("🥇", "Медаль «За отвагу в калькуляторе»", "Медаль идиоту, который жмёт «=» не глядя", ["plaque", "🥇", "Медаль «За отвагу в калькуляторе»", "Вы нажали «=» не проверив. Идиот, но смелый. Медаль выдаётся без ленточки: ленточку вы потеряете.", 11000], ["nick", "Герой калькулятора {nick}", 60000], ["sound", "tada"]);
  E("🏅", "Медаль «Самый внимательный»", "Медаль зануде, который ничего не видит", ["plaque", "🏅", "Медаль «Самый внимательный»", "За то, что вы заметили это окошко. Остальное вы, как обычно, пропустили.", 11000], ["nick", "Зоркий {nick}", 60000], ["sound", "tada"]);
  E("🪧", "Табличка «Не кормить»", "Табличка на экране и на нике", ["plaque", "🪧", "НЕ КОРМИТЬ", "Сотрудник и так толстый от безделья. Просьба не отвлекать от пустого сидения.", 11000], ["nick", "Не кормить: {nick}", 90000]);
  E("🏆", "Сотрудник месяца", "Кубок, ник и конфетти за «заслуги»", ["plaque", "🏆", "Сотрудник месяца", "По результатам тайного голосования вы заняли последнее место. Но месяц ваш: в позоре вам нет равных.", 11000], ["nick", "Сотрудник месяца {nick}", 120000], ["sound", "tada"], ["confetti", 3000]);
  E("🧠", "Табличка «Осторожно: тупой»", "Табличка-предупреждение и ник", ["plaque", "🧠", "Осторожно: тупой", "Не подходить с умными вопросами. Можно с глупыми: на них ответит.", 11000], ["nick", "Осторожно, {nick}", 90000]);
  E("🏛️", "Благодарность от Правительства", "Торжественная ирония", ["plaque", "🏛️", "Благодарность", "Правительство выражает вам благодарность за то, что вы всё ещё здесь. Остальные давно ушли.", 11000], ["retext", [["Главная", "Приёмная"], ["Законы", "Указы"]], 40000], ["sound", "ding"]);
  E("☕", "Перерыв по уставу", "Устав требует чаю, кнопки «на перерыве»", ["plaque", "☕", "Перерыв по уставу", "Статья 0.0: каждый сотрудник обязан выпить чаю. Вы свою работу сегодня уже выпили.", 11000], ["retext", [["Сохранить", "Попозже"], ["Начать", "Сначала чай"], ["Готово", "Не мешай"]], 40000]);
  E("📋", "Протокол об опоздании", "Вас запротоколировали за тупость", ["modal", "📋", "Протокол об опоздании", "Вы опоздали на 5 минут и на 5 лет в развитии. Протокол приобщён к делу о вашей тупости.", "Согласен", 12000], ["nick", "Опоздавший {nick}", 60000]);
  E("📜", "Грамота лучшему из лучших", "Грамота «лучшему» неудачнику", ["plaque", "📜", "Грамота", "Награждается лучший из худших. Имя указано мелким шрифтом, потому что стыдно.", 11000], ["nick", "Лучший из худших", 90000], ["sound", "tada"]);
  E("😊", "Предписание улыбнуться", "Улыбайся, пока кнопки злые", ["banner", "😊", "Предписание: улыбаться 10 секунд. Не будешь — улыбнём силой, дебил.", 11000, "warn"], ["retext", [["Отмена", "Улыбнись"], ["Закрыть", "Улыбнись"]], 30000], ["sound", "ding"]);
  E("📨", "Повестка в «кабинет позора»", "Вызов в кабинет позора", ["modal", "📨", "Повестка", "Вам надлежит явиться в «Кабинет позора» и принять порцию позора. Неявка карается удвоенным позором.", "Иду, ссусь", 12000], ["nick", "Подозреваемый {nick}", 90000]);
  E("🪧", "Табличка «Занят: делаю вид»", "Занят имитацией работы", ["plaque", "🪧", "ЗАНЯТ: ДЕЛАЮ ВИД", "Не мешать. Процесс имитации идёт полным ходом уже 8 лет.", 11000], ["nick", "{nick} (делает вид)", 90000]);
  E("🥈", "Медаль «За терпение»", "Медаль нам, что терпим вас", ["plaque", "🥈", "Медаль «За терпение»", "Выдана коллективу за то, что он терпит {nick}. Лично {nick} медаль не положена.", 11000], ["nick", "Терпила {nick}", 90000], ["sound", "ding"]);
  E("📝", "Служебная записка", "Записка «вас заметили» и ник", ["modal", "📝", "Служебная записка", "Вас заметили. Плохое заметили. Всё плохое. Подробности по почте, которую вы не читаете.", "Принято", 12000], ["nick", "Замеченный {nick}", 60000]);
  E("📑", "Рапорт о плохом настроении", "Рапорт о вашем уровне тупости", ["modal", "📑", "Рапорт о тупости", "Тупость зафиксирована. Статья нарушения: 0.0. Наказание: быть собой ещё один день.", "Подписать", 12000], ["retext", BTN, 35000]);
  E("💸", "Штраф за тупость", "Штраф и ник «Должник»", ["plaque", "💸", "Штраф за тупость", "Начислено: 0 ₽ и 1 унижение. Платить нечем — вы даже на штраф не заработали.", 11000], ["nick", "Должник {nick}", 90000], ["sound", "ding"]);
  E("🦊", "Знак «Осторожно, лиса»", "Лиса кусает за косяки", ["plaque", "🦊", "Осторожно, лиса", "Лиса кусает тех, кто тупит. Вы — следующий. Берегите руки.", 11000], ["accent", "#E8862A", 30000], ["cursor", "crosshair", 15000]);
  E("🦊", "«Здесь был Senko»", "Автограф лисы и надпись на вкладке", ["plaque", "🦊", "Здесь был Senko", "Автограф оставлен. А ты оставил после себя только позор. Не стирать.", 11000], ["retext", [["Главная", "Тут был Senko"]], 60000], ["sound", "ding"]);

  // 61–70 · очередь
  E("🔥", "Фаер", "Огонь, красный интерфейс, ник «Горит»", ["rain", "🔥", 30, 7000], ["banner", "🔥", "Фаер зажжён! {nick} горит от стыда, тушить никто не будет.", 8000, "warn"], ["accent", "#D64545", 30000], ["nick", "Горящий {nick}", 60000], ["sound", "whistle"]);
  E("🛰️", "Спутник", "Спутник сканирует, курсор — прицел", ["float", "🛰️", 12000, 72], ["cursor", "crosshair", 15000], ["toast", "🛰️", "Спутник засёк {nick}. Диагноз по снимку: тупит.", 7000]);
  E("🃏", "Джокер", "Джокер издевается, ник «Джокер»", ["modal", "🃏", "Джокер", "«Почему так серьёзно?» — спросил Джокер. — «Потому что ты ничтожество», — ответили мы.", "Не знаю", 12000], ["nick", "Джокер {nick}", 60000], ["sound", "laugh"]);
  E("🎆", "Фейерверк", "Салют на весь экран и позорный ник", ["confetti", 6000], ["rain", "🎆", 20, 6000], ["nick", "Праздничный дурак {nick}", 45000], ["sound", "tada"]);
  E("📡", "Спутник-наблюдатель", "Спутник «видит» вас и пишет кнопкам", ["banner", "🛰️", "Спутник вас видит. Помашите ручкой, раз ничего больше не умеете.", 9000, "info"], ["float", "🛰️", 9000, 64], ["retext", [["Сохранить", "Помахать"], ["Закрыть", "Скрыться"]], 30000]);
  E("🃏", "Карточная вьюга", "Карты летят, кнопки убегают", ["rain", "🃏", 30, 8000], ["dodge", 12000], ["sound", "pop"], ["toast", "🃏", "Крапленые карты в твою честь. Шулер, но тупой.", 7000]);
  E("🔥", "Огненный курсор", "Курсор горит, интерфейс красный", ["follow", "🔥", 20000], ["accent", "#D64545", 20000], ["toast", "🔥", "Курсор тлеет. Как и твоя карьера.", 6000]);
  E("☄️", "Комета", "Комета и тряска", ["float", "☄️", 8000, 72], ["css", "shake", 4000], ["sound", "whistle"], ["toast", "☄️", "Комета летит на тебя. Динозавры тоже думали, что всё в порядке.", 7000]);
  E("🂡", "Туз в рукаве", "Туз нашёлся, а ник — «Шулер»", ["plaque", "🃏", "Туз в рукаве", "У вас нашёлся туз в рукаве. Откуда он там — не знаем, но вы сразу виновны.", 11000], ["nick", "Шулер {nick}", 90000], ["sound", "ding"]);
  E("🚀", "Ракета", "Ракета и интерфейс «взлетает»", ["float", "🚀", 7000, 72], ["sound", "siren"], ["css", "shake", 3500], ["nick", "Космонавт {nick}", 60000], ["toast", "🚀", "Поехали! А вы остаётесь здесь, тупить дальше.", 6000]);

  // 71–80 · весёлые ники (ник в программе реально подменяется на 2 минуты)
  nick("🍌", "Пушистый Банан", "Теперь тебя зовут «Пушистый Банан». Пушистый — это единственное, что в тебе есть.");
  nick("🦝", "Сонный Енот", "Ты — «Сонный Енот». Спишь на работе, воруешь из мусорки. Всё честно.");
  nick("🍩", "Капитан Пончик", "«Капитан Пончик». Дырка в голове — родная.");
  nick("🐷", "Мистер Хрюн", "«Мистер Хрюн». Хрю. Это не оскорбление, это констатация.");
  nick("🍪", "Леди Печенька", "«Леди Печенька». Хрустишь под давлением, как и положено.");
  nick("🥿", "Тапок-Воин", "«Тапок-Воин». Пахнешь так же. Шучу. Нет, не шучу.");
  nick("🧁", "Дядя Кекс", "«Дядя Кекс». Мягкий, сладкий и бесполезный.");
  nick("🧇", "Вафельный Рыцарь", "«Вафельный Рыцарь». Доспехи из теста, смелость — тоже.");
  nick("🥒", "Сэр Огурчик", "«Сэр Огурчик». Зелёный, мелкий, солёный. И в банке.");
  nick("🍜", "Принцесса Лапша", "«Принцесса Лапша». Вешать тебе лапшу на уши — одно удовольствие.");

  // 81–90 · звуковые
  E("🚨", "Сирена", "Сирена, красные мигания, «учебная тревога»", ["sound", "siren"], ["banner", "🚨", "Тревога! Это не учения. {nick} уже обосрался.", 8000, "warn"], ["accent", "#D64545", 15000], ["css", "pulse", 8000]);
  E("🕰️", "Кукушка", "Кукушка и «время тупить»", ["sound", "cuckoo"], ["toast", "🕰️", "Ку-ку! Время вышло. Мозги — тоже.", 6000], ["retext", [["Главная", "Ку-ку"]], 25000]);
  E("🔔", "Дверной звонок", "Дзынь, к тебе пришли твои косяки", ["sound", "bell"], ["modal", "🔔", "Дзынь!", "К вам пришли. Это ваши косяки. Все сразу, открывайте.", "Впустить", 12000], ["nick", "Должник {nick}", 45000]);
  E("📞", "Телефон", "Звонят из «отдела тупых»", ["sound", "phone"], ["toast", "📞", "Вам звонят из отдела тупых. Говорят, вы их начальник.", 7000], ["retext", [["Закрыть", "Бросить трубку"], ["Принять", "Взять трубку"]], 25000]);
  E("🫏", "Ослик", "Иа! — и ник «Ослик»", ["sound", "donkey"], ["nick", "Ослик {nick}", 45000], ["toast", "🫏", "Иа! Перевод: «ты осёл».", 6000]);
  E("🦆", "Оркестр кряков", "Кряки на клики и дождь из уток", ["sound", "quack"], ["clicks", "quack", 25000], ["rain", "🦆", 16, 8000], ["retext", [["Сохранить", "Кря"], ["Закрыть", "Кряк"]], 30000]);
  E("🥁", "Барабанная дробь", "Дробь и ничего, как ваши результаты", ["sound", "drum"], ["banner", "🥁", "Барабанная дробь… и ничего. Совсем ничего. Как ваши результаты.", 7000, "info"], ["css", "shake", 3000], ["retext", [["Готово", "И что?"], ["Сохранить", "Ничего"], ["Закрыть", "Скучно"]], 30000]);
  E("🎺", "Грустная труба", "Печальная музыка для неудачника", ["sound", "sad"], ["toast", "🎺", "Печальная труба играет специально для {nick}. Жалко его, но не сильно.", 7000], ["css", "gray", 15000], ["nick", "Грустный {nick}", 45000]);
  E("🎭", "Смех за кадром", "Смех на каждый клик — над вами", ["sound", "laugh"], ["clicks", "laugh", 25000], ["toast", "🎭", "Смех за кадром включён. Смеются над тобой, не стесняйся.", 7000], ["retext", [["Готово", "Ха-ха"], ["Сохранить", "Ха-ха-ха"]], 30000]);
  E("⌨️", "Печатная машинка", "Клавиши стучат, кнопки по-древнему", ["sound", "type"], ["clicks", "type", 25000], ["toast", "⌨️", "Клац-клац. Это не вы печатаете. Вы так не умеете.", 7000], ["retext", [["Сохранить", "Записать"], ["Отмена", "Зачеркнуть"]], 30000]);

  // 91–100 · главные
  crown("👑", "Король Приколов", "Корона картонная, трон шатается, подданных нет. Но ты король. Король лохов.", "Король Приколов {nick}");
  crown("🏯", "Император Веселья", "Империя — одна комната. Армия — ноль. Налог — одно унижение в день. Платить вам.", "Император Веселья {nick}");
  crown("🎩", "Герцог Хохота", "Герцогство Хохота переходит под ваше управление. Хохот — над вами.", "Герцог Хохота {nick}");
  crown("🦇", "Граф Смехула", "Граф принимает только тех, кто лох. Вы подходите идеально.", "Граф Смехула {nick}");
  crown("🕌", "Султан Шуток", "Султан вручает вам ключ от сундука с приколами. Сундук пуст. Как и ваша голова.", "Султан Шуток {nick}");
  crown("🏛️", "Президент Розыгрышей", "Вы избраны единогласно. Голосовали только вы, и то с третьего раза.", "Президент Розыгрышей {nick}");
  crown("🧙", "Архимаг Приколов", "Посох вручён. Заклинание «Смешно» не работает. Ни разу. Ни на ком.", "Архимаг Приколов {nick}");
  E("🎪", "Верховный Клоун", "Титул «Верховный Клоун» и клоунские надписи", ["plaque", "🎪", "Верховный Клоун", "Присвоено звание. Нос выдаётся отдельно, потому что он у вас уже красный от стыда.", 12000], ["nick", "Верховный Клоун {nick}", 120000], ["retext", [["Главная", "Арена"], ["Задержание", "Клоунада"], ["Калькулятор", "Касса цирка"]], 60000], ["follow", "🔴", 20000], ["sound", "trombone"]);
  crown("🍌", "Властелин Бананов", "Все бананы мира теперь формально ваши. Сожрать их надо самому. Всех.", "Властелин Бананов {nick}");
  E("🌟", "Легенда Веселья", "Всё сразу: титул, салют, ник и грубые кнопки", ["plaque", "🌟", "Легенда Веселья", "О вас сложат анекдоты. Некоторые уже сложили. Не очень хорошие.", 14000], ["nick", "Легенда {nick}", 120000], ["retext", RUDE, 60000], ["rain", "🌟", 30, 9000], ["confetti", 8000], ["badge", "🌟", "Легенда Веселья", 40000], ["sound", "tada"]);

  // 101–120 · функциональные (ненастоящие окна, в конце окно «Попался»)
  fake("🚫", "Аккаунт заблокирован", "Аккаунт заблокирован навсегда. Причина: ты тупой как пробка. Обжалованию не подлежит, апелляцию писать некому.", "Фальшивый бан", shameF("Забаненный {nick}"));
  fake("🔇", "Вам выдан мут", "Писать нельзя 5 минут. Причина: ты нёс такую хрень, что у нас уши отвалились.", "Фальшивый мут", shameF("Немой {nick}"));
  fake("🤖", "ИИ-помощник отключён", "Нейросеть отключена. Причина: она устала отвечать на твои тупые вопросы и ушла в запой.", "Отключение ИИ (симуляция)", ["after", 22000, ["retext", [["Показать", "Сам думай"], ["Проверить", "Сам проверяй"], ["Сохранить", "Сам сохраняй"], ["Закрыть", "Сам закрывай"]], 40000]]);
  fake("🔐", "Сессия завершена", "Вы вышли из аккаунта по требованию администратора. Администратору надоело на тебя смотреть.", "Сессия завершена", ["after", 22000, ["retext", RUDE, 45000]]);
  fake("🛠️", "Идут технические работы", "Идут технические работы. Чиним то, что ты сломал своими кривыми руками. Подожди часок, тупица.", "Технические работы", ["after", 22000, ["dodge", 20000]]);
  fake("⬇️", "Установка обновления: 99%", "Осталось совсем немного. Последний процент устанавливается вечность, как твой мозг.", "Вечное обновление", ["after", 22000, ["cursor", "progress", 25000]]);
  fake("🧮", "Лимит ИИ исчерпан", "Вы задали слишком много тупых вопросов. Лимит тупости на сегодня исчерпан. Заходите завтра, умнее не станете.", "Лимит ИИ исчерпан", ["after", 22000, ["mask", 8000]]);
  fake("📡", "Сервер недоступен", "Сервер ушёл от тебя нахрен. Вернётся примерно никогда.", "Сервер недоступен", ["after", 22000, ["css", "glitch", 8000], ["sound", "buzz"]]);
  fake("🔑", "Нужна повторная авторизация", "Мы забыли, кто ты. Да и не хотим вспоминать. Представься заново, ничтожество.", "Повторная авторизация", shameF("Неизвестный {nick}"));
  fake("🚧", "Доступ ограничен", "Доступ ограничен модератором, которому ты не нравишься. Лично. Очень.", "Доступ ограничен", ["after", 22000, ["retext", BTN, 40000]]);
  fake("🔁", "Синхронизация сломалась", "Данные отправились гулять. Мы ищем их по району. Если найдём — не отдадим, они лучше тебя.", "Синхронизация сломалась", ["after", 22000, ["css", "glitch", 6000]]);
  fake("📦", "Обязательное обновление", "Вышла новая версия. Старая обиделась на тебя и просит не уходить. Ты ей не нужен.", "Обязательное обновление", ["after", 22000, ["accent", "#D64545", 25000]]);
  fake("📉", "Рапорт отклонён", "Рапорт отклонён: так плохо написан, что мы подозреваем лобовое отсутствие мозгов.", "Рапорт отклонён", shameF("Двоечник {nick}"));
  fake("📈", "Вы повышены", "Вы повышены до должности «Старший по чайнику». Ты же ни на что больше не годишься.", "Повышение", shameF("Старший по чайнику {nick}"));
  fake("📉", "Вы разжалованы", "Вы разжалованы до звания «Младший подносчик печенья». Печенье свёл, чтоб не стырил.", "Разжалование", shameF("Подносчик печенья {nick}"));
  fake("🫖", "Ошибка 418", "Я чайник. Заваривать кофе для тебя отказываюсь, а в рожу — с удовольствием.", "Ошибка 418", ["after", 22000, ["retext", BTN, 30000]]);
  fake("🦊", "Проверка: вы лиса?", "Докажите, что вы лиса. Нажмите на все фотографии, где есть хвост. Не получилось? Тупица, значит ты не лиса.", "Капча «вы лиса?»", ["after", 22000, ["dodge", 20000], ["accent", "#E8862A", 25000]]);
  fake("💳", "Подписка закончилась", "Подписка на хорошее настроение закончилась. Продлить нечем: с твоим ебалом плохое настроение бесплатно.", "Подписка закончилась", ["after", 22000, ["css", "gray", 20000]]);
  fake("🧪", "Бета-доступ отозван", "Бета-доступ отозван. Причина: ты — худший бета-тестер за всю историю. Даже баги от тебя убегают.", "Бета-доступ отозван", shameF("Бывший бета-тестер {nick}"));
  fake("👁️", "Режим просмотра", "Вам разрешено только смотреть. Трогать нельзя. Даже глазами. Руки у тебя кривые — а глаза, видимо, ещё кривее.", "Режим просмотра", ["after", 22000, ["dodge", 25000]]);

  // 121–150 · жёсткие (всё ненастоящее: вымышленные данные, без реальных сведений; нужен код подтверждения)
  term("Досье «классика»", "Вымышленное досье, потом ник «Лох»", "ДОСЬЕ", ["досье на пользователя: {nick}", "настоящее имя: Пончик Иванович Тестов", "адрес: ул. Несуществующая, д. 404, кв. 0", "IP: 000.000.000.000 (мы не знаем, но догадываемся — лох)", "любимый цвет: бежевый, как твоя личность", "диагноз: хроническая тупость", "ДОСЬЕ ПЕРЕДАНО ВСЕМУ ОТДЕЛУ."], ["sound", "type"], shame("Лох {nick}"));
  term("Досье с котом", "Досье на кота и ник «Раб кота»", "ДОСЬЕ", ["объект: {nick}", "кот: рыжий, подозрительный, умнее тебя", "клички кота: Босс, Мурзик, Налоговая", "спит на клавиатуре: 14 часов в сутки, работает лучше тебя", "ВЫВОД: кот главнее, а ты — раб кота."], ["sound", "meow"], shame("Раб кота {nick}"));
  term("Досье коллеги-лисы", "Лиса собрала досье и обзывается", "ДОСЬЕ ОТ ЛИСЫ", ["объект: {nick}", "замечен: пьёт чай в рабочее время (пока ты работаешь)", "замечен: улыбается без причины, как дебил", "замечен: путает кнопки и косячит в каждом рапорте", "ДОСЬЕ ЗАКРЫТО. ПРИЧИНА: СКУЧНО, ТЫ СЛИШКОМ ПРЕДСКАЗУЕМЫЙ ИДИОТ."], ["sound", "type"], shame("Идиот {nick}"));
  term("Досье «пароль 123456»", "Разбор паролей и ник «Хакнутый»", "ДОСЬЕ", ["объект: {nick}", "пароль от всего: qwerty123", "подсказка к паролю: «очень сложный»", "двухфакторка: бабушка звонит и диктует код", "ВЫВОД: тебя взломает даже холодильник."], ["sound", "type"], shame("Хакнутый {nick}"));
  term("Досье на сериалы", "Список сериалов и ник «Сонная муха»", "ДОСЬЕ", ["объект: {nick}", "любимый сериал: «Ещё одну серию и спать»", "просмотрено за ночь: 14 серий", "сон: не обнаружен, мозг: не обнаружен", "ВЫВОД: на работе ты спишь, дома ты спишь, везде спишь."], ["sound", "type"], shame("Сонная муха {nick}"));
  term("Досье «пирожки»", "Украденные пирожки и ник «Жрун»", "ДОСЬЕ", ["объект: {nick}", "любимая начинка: капуста (и мясо, и всё подряд)", "украдено пирожков за месяц: 7", "доказательства: крошки на клавиатуре и жирные пятна на совести", "ВЫВОД: жрун."], ["sound", "type"], shame("Жрун {nick}"));
  term("Рейд LSPD", "Игровая полиция «врывается», потом ник «Задержанный»", "LSPD · ОПЕРАЦИЯ «ПИРОЖОК»", ["группа захвата в здании", "выбиваем дверь… дверь открыта, бедолага даже не запёрся", "внутри обнаружено: {nick}, чай, печенье, кот", "подозреваемый оказал сопротивление: предложил чай и заплакал", "ОПЕРАЦИЯ ЗАВЕРШЕНА. ПЕЧЕНЬЕ КОНФИСКОВАНО, {nick} ЗАПИСАН В ЛОХИ."], ["sound", "siren"], shame("Задержанный {nick}"));
  term("Сирены под окном", "Сирены, мигалки и красный интерфейс", "LSPD · ПАТРУЛЬ", ["сирены включены", "мигалки включены", "звук «вжжж» включён", "цель: проверить, кто тут тупит — найден {nick}", "ПАТРУЛЬ ЗАВЕРШЁН. ВСЕ ПЬЮТ ЧАЙ, ТОЛЬКО ТЫ ПОЗОРИШЬСЯ."], ["sound", "siren"], ["after", 17000, ["accent", "#D64545", 40000], ["css", "pulse", 10000], ["nick", "Нарушитель {nick}", 90000]]);
  term("Ордер на смех", "Шуточный ордер и ник «Подозреваемый»", "ОРДЕР № 0000", ["ордер на смех выдан", "основание: подозрение в тупости и хорошем настроении", "срок исполнения: немедленно", "обыск: карманы, печеньки, остатки мозга", "ОРДЕР ВЫПОЛНЕН. МОЗГИ НЕ НАЙДЕНЫ."], ["sound", "ding"], shame("Подозреваемый {nick}"));
  term("Допрос «где пирожки»", "Допрос по делу пирожков", "ДОПРОС", ["следователь: где пирожки, урод?", "подозреваемый: какие пирожки?", "следователь: те, что у тебя во рту", "подозреваемый: это не пирожки, это зубы", "ДЕЛО ЗАКРЫТО: ПИРОЖКИ СЪЕДЕНЫ, ПОДОЗРЕВАЕМЫЙ — ДЕБИЛ."], ["sound", "type"], shame("Обвиняемый {nick}"));
  term("Облава на печеньки", "Операция «Печенька» и ник «Печенюшка»", "ОПЕРАЦИЯ «ПЕЧЕНЬКА»", ["оцеплен район кухни", "цель: пачка печенья без охраны (охрана — {nick})", "охрана заснула, захват произведён", "печенье арестовано без права на крошки", "ЗАСНУВШАЯ ОХРАНА УВОЛЕНА ПО СТАТЬЕ «КРИВЫЕ РУКИ»."], ["sound", "siren"], shame("Печенюшка {nick}"));
  term("Полицейский вертолёт", "Вертолёт над экраном и ник «Мишень»", "ВЕРТОЛЁТ LSPD", ["вертолёт на позиции", "прожектор включён", "объект замечен: {nick} сидит и тупит", "ДЕЙСТВИЕ: ржать в громкоговоритель", "ВЕРТОЛЁТ УЛЕТЕЛ ПИТЬ ЧАЙ. ТЫ ОСТАЛСЯ ЛОХОМ."], ["sound", "whistle"], shame("Мишень {nick}"));
  term("Арест «руки за голову»", "Игровой арест и ник «Арестант»", "АРЕСТ", ["задержан: {nick}", "статья: 0.0 «Тупость в особо крупных размерах»", "руки за голову: выполнено (дрожат, ссыкло)", "зачитаны права: «имеете право молчать, потому что говорить вы не умеете»", "ЗАДЕРЖАНИЕ НЕ ОФОРМЛЕНО: СЛИШКОМ СМЕШНО."], ["sound", "siren"], shame("Арестант {nick}"));
  term("Карточка арестанта", "Шуточная карточка и ник «Любимчик камеры»", "КАРТОЧКА", ["имя: {nick}", "статья: слишком обаятельный лох", "срок: один пирожок и один позор", "характеристика: тупой, но душевный", "СТАТУС: ЛЮБИМЧИК КАМЕРЫ."], ["sound", "type"], shame("Любимчик камеры"));
  term("Камера №404", "Камера не найдена, ник «Бомж»", "КАМЕРА", ["ведём вас в камеру №404", "камера №404: не найдена", "перенаправление: камера №405", "камера №405: тоже не найдена, как и твои мозги", "ВЫ СВОБОДНЫ: КАМЕР НЕТ. ИДИ ДОМОЙ, БОМЖ."], ["sound", "buzz"], shame("Бездомный {nick}"));
  term("Залог: три банана", "Суд берёт залог бананами", "СУД", ["залог назначен: 3 банана", "банан №1: принят", "банан №2: принят", "банан №3: съеден судьёй, потому что ты слишком медленно доставал", "ЗАЛОГ ВНЕСЁН. СУДЬЯ ДОВОЛЕН. {nick} — ОБЕЗЬЯНА."], ["sound", "drum"], shame("Обезьяна {nick}"));
  term("Суд над печеньем", "Суд над печеньем и ваш приговор", "СУД", ["слушается дело: Печенье против {nick}", "обвинение: печенье исчезает слишком быстро", "защита: печенье очень вкусное, а {nick} жрёт без стыда", "приговор: ещё одно печенье, а {nick} — позор", "ЗАСЕДАНИЕ ЗАКРЫТО."], ["sound", "drum"], shame("Осуждённый {nick}"));
  term("Помилование", "Помилование с издёвкой", "ПОМИЛОВАНИЕ", ["рассматривается ходатайство", "обстоятельства: ну ты и дебил, жалко тебя", "решение: помиловать", "выдано: печенье и рукопожатие", "ПОМИЛОВАН. ИДИ, ПОКА НЕ ПЕРЕДУМАЛИ."], ["sound", "tada"], shame("Помилованный {nick}"));
  term("Утечка базы", "Шуточная «утечка» и ник «Слив»", "УТЕЧКА", ["обнаружена утечка базы", "утекло: список любимых смайликов", "утекло: история «ещё одну серию»", "утекло: твои рапорты, их читали и ржали", "УТЕЧКА ЗАКРЫТА. ПОЗОР ОСТАЛСЯ."], ["sound", "buzz"], shame("Слив {nick}"));
  term("Переписка с котом", "Утекла переписка с котом", "УТЕЧКА", ["утекла переписка с котом", "кот: мяу", "вы: мяу", "кот: ты что, дебил?", "ПЕРЕПИСКА ЗАСЕКРЕЧЕНА ПО ПРОСЬБЕ КОТА. КОТ СТЕСНЯЕТСЯ."], ["sound", "meow"], shame("Собеседник кота"));
  term("История запросов", "Утекла история запросов", "УТЕЧКА", ["утекла история поиска", "«как пользоваться калькулятором»", "«как понять, что я уже пил чай»", "«что такое пирожок и можно ли его есть»", "ИСТОРИЯ ОЧИЩЕНА. ЗАПРОСЫ ЧИТАЛИ ВСЕМ ОТДЕЛОМ И РЖАЛИ."], ["sound", "type"], shame("Тупой запрос {nick}"));
  term("Рецепт борща", "Утёк секретный рецепт", "УТЕЧКА", ["утёк секретный рецепт борща", "ингредиент 1: любовь", "ингредиент 2: ещё любовь", "ингредиент 3: капуста (и ты, но ты — мимо)", "РЕЦЕПТ ЗАСЕКРЕЧЕН: ВСЕ ЕГО ЗНАЮТ, А ТЫ СГОРЕЛ."], ["sound", "ding"], shame("Борщ {nick}"));
  term("Планы на отпуск", "Утекли планы на отпуск", "УТЕЧКА", ["утекли планы на отпуск", "день 1: лежать", "день 2: лежать", "день 3: лежать ещё", "ВЫВОД: ты и на работе лежишь, и в отпуске лежишь."], ["sound", "ding"], shame("Лежебока {nick}"));
  term("Пароли «Qwerty»", "Утёк «пароль» от всего", "УТЕЧКА", ["утёк «пароль» от всего", "пароль: Qwerty", "пароль: Qwerty2", "пароль: Qwerty3 (усилили, какой ты гений)", "ВЫВОД: ВСЁ ЕЩЁ ПОЗОР."], ["sound", "buzz"], shame("Qwerty {nick}"));
  term("Форматирование диска C:", "Ненастоящее форматирование и «битые» надписи", "ФОРМАТИРОВАНИЕ C:", ["форматирую диск C:", "удаляю обои… удалено", "удаляю тоску… удалено", "удаляю лишние папки «Новая папка (7)»… удалено", "удаляю твои мозги… не найдены, удалять нечего", "ГОТОВО. СТРАДАЙ."], ["sound", "buzz"], ["after", 17000, ["mask", 12000], ["css", "glitch", 8000], ["nick", "Диск C: {nick}", 90000]]);
  term("Стирание кэша котиков", "Ненастоящая очистка", "ОЧИСТКА", ["стираю кэш котиков…", "котик 1: стёрт (вернулся)", "котик 2: стёрт (вернулся)", "котик 3: не стёрт (спит и смотрит на тебя, как на дебила)", "КОТИКИ НЕ СТЁРТЫ. КОТИКИ ТЕБЯ ПРЕЗИРАЮТ."], ["sound", "meow"], shame("Презираемый котами"));
  term("rm -rf /пирожки", "Шуточная команда и злой ник", "ТЕРМИНАЛ", ["rm -rf /пирожки", "ошибка: пирожки не удаляются", "ошибка: пирожки вкуснее тебя", "sudo rm -rf /{nick}", "ОШИБКА: {nick} НЕ УДАЛЯЕТСЯ, ПОТОМУ ЧТО ЕГО ЖАЛКО."], ["sound", "type"], shame("Пирожок-лох"));
  term("Очистка корзины с мемами", "Корзина с мемами", "КОРЗИНА", ["очищаю корзину с мемами…", "мем 1: сохранён по ошибке", "мем 2: слишком смешной, оставлен", "мем 3: ты, удалён", "КОРЗИНА ПОЛНА ХОРОШЕГО НАСТРОЕНИЯ, А ТЫ — МУСОРА."], ["sound", "ding"], shame("Мем {nick}"));
  term("Удаление System32", "Шуточное «удаление» и «глюки»", "ТЕРМИНАЛ", ["удаляю System32…", "System32: «пожалуйста, не надо»", "System32: «я вам ещё пригожусь»", "System32: «а ты, {nick}, нет»", "ПОКА, {nick}."], ["sound", "buzz"], ["after", 17000, ["mask", 10000], ["css", "shake", 6000], ["nick", "System32 {nick}", 90000], ["retext", RUDE, 40000]]);
  term("Сброс «счастья»", "Сброс до заводских: счастье", "СБРОС", ["сброс настроек счастья…", "радость: 0%", "смех: 0%", "тупость: 100% (заводская настройка)", "СБРОС ВЫПОЛНЕН. С ТОБОЙ ВСЁ ЯСНО."], ["sound", "tada"], shame("Сброшенный {nick}", 120000));
  // Добавка каждой категории: обидные уведомления по кругу, половина нажатий «не доходит», грубые подписи кнопок,
  // сирена, окно с убегающей кнопкой, пьяный интерфейс, пропадающий курсор.
  const R1 = ["{nick}, ты даже утку не переиграешь по интеллекту.", "Каждый твой клик позорит весь отдел.", "Работаешь как Wi-Fi в подвале: вроде есть, а толку ноль.", "{nick}, тебя взяли на работу по ошибке. Ошибку пока не нашли.",
    "Не спеши, {nick}. Тупить надо с расстановкой.", "Если бы лень была статьёй, ты сидел бы пожизненно.", "Кнопки от тебя устали, {nick}.", "Тебя даже калькулятор считает за ноль."];
  const R2 = ["{nick}, ты как баг: все про тебя знают, никто не хочет чинить.", "Руки из жопы — не диагноз, {nick}, это твой стиль работы.", "Мозг у тебя в режиме энергосбережения с рождения.", "Тебя терпят только потому, что увольнять лень.",
    "{nick}, твои рапорты читают вслух на корпоративах. Для смеха.", "Ещё один клик — и программа подаст на тебя в суд.", "Ты не тормоз, {nick}. Тормоз хотя бы иногда срабатывает.", "Даже ИИ отказался тебе помогать. Сказал: бесполезно."];
  const R3 = ["{nick}, ты живое доказательство, что эволюция иногда сдаёт назад.", "Если бы тупость светилась, ты освещал бы весь Лос-Сантос.", "Ты настолько бесполезен, что даже реклама тебя пропускает.", "{nick}, ты единственный, кто проиграл калькулятору.",
    "Отдел скинулся тебе на мозги. Не хватило.", "Ты как понедельник: тебя никто не ждёт, а ты всё равно приходишь.", "Хуже тебя работает только принтер. И то не всегда.", "Здесь даже кнопки умнее тебя: у них хотя бы есть подписи.",
    "{nick}, сделай одолжение: подумай. Хотя бы раз, ради эксперимента.", "Ты не косячишь, {nick}. Ты и есть косяк."];
  const R4 = ["{nick}, ты ошибка, которую забыли исправить перед релизом.", "Тебя бы уволили, но никто не помнит, зачем тебя брали.", "Ты не сотрудник, ты штатная единица позора.", "Каждый раз, когда ты открываешь программу, сервер плачет.",
    "{nick}, этот текст ты читаешь по слогам, да?", "Мы проверили: твой мозг можно отключить без потери функциональности.", "Ты причина, по которой в инструкциях пишут очевидное.", "Не закрывай окно, {nick}. Хоть что-то в жизни доведи до конца.",
    "Твой IQ меньше пинга. А пинг у тебя тоже говно.", "Тебя даже бот в Telegram занёс в чёрный список.", "Все уже поняли, что ты лох, {nick}. Остался только ты.", "Ты — причина, по которой в программе есть кнопка «Отмена»."];
  const chase = (runs, ms) => ["chase", "🚪", "Хочешь закрыть?", "Сначала поймай кнопку, {nick}. Руки у тебя вроде есть. Вроде.", "Закрыть", runs, ms];
  // 3.4.3-beta.2: лёгких больше нет, все категории получают максимальную добавку (отличаются только темой)
  const MAX = (nag) => [["nag", "☠️", nag.slice(0, 16), 6000, 110000], ["lag", 0.5, 100000], ["retext", RUDE, 120000], ["loop", "alarm", 7000, 70000],
    ["after", 20000, chase(7, 50000), ["css", "drunk", 40000], ["scramble", 30000], ["dodge", 30000], ["cursor", "none", 8000]]];
  const SVC_STING = [
    [1, 40, "Лошара {nick}", ...MAX(R3.concat(R2))],
    [41, 120, "Позорище {nick}", ...MAX(R3.concat(R4))],
    [121, 150, "Позор отдела {nick}", ...MAX(R4)],
  ];

  L.forEach((it, i) => {
    const s = SVC_STING.find((x) => i + 1 >= x[0] && i + 1 <= x[1]);
    if (!s) return;
    const has = (op) => JSON.stringify(it.fx).includes(`["${op}"`);
    const add = s.slice(3);
    if (!has("nick")) add.push(["nick", s[2], 90000]);
    it.fx = it.fx.concat(add);
  });
  return L;
})();
const SVC_COUNT = 150;
const svcCatOf = (id) => {
  for (const k of Object.keys(SVC_CATS)) if (id >= SVC_CATS[k][1] && id <= SVC_CATS[k][2]) return k;
  return "";
};
const svcItem = (id) => (id >= 1 && id <= SVC_LIST.length ? { id, cat: svcCatOf(id), hard: id >= SVC_HARD_FROM, ...SVC_LIST[id - 1] } : null);
// SVC:CATALOG:END

// Доступ: владелец и пользователи с ролью «Рофл менеджмент» (профиль profiles.rofl, выдаёт только владелец)
const svcCan = (a) => !!a && (a.kind === "owner" || !!(a.profile && a.profile.rofl && !a.profile.banned));
// Открыт ли канал для пользователя: режим функции svc32 («beta» — только бета-тестерам, «all» — всем)
async function svcOpen(p) {
  const m = (await flagsNow()).svc32;
  return m === "all" || (m === "beta" && isTester(p));
}
const SVC_CODE_MIN = 5; // сколько минут действует код жёсткого сообщения
const SVC_QUEUE_MAX = 5; // сколько сообщений может ждать показа у одного пользователя
const SVC_FRESH_H = 6; // сообщение, которое пользователь не забрал за 6 часов, не показывается

// Показать оператору, когда пользователь был в сети и дойдёт ли до него сообщение
async function svcReach(t) {
  const open = await svcOpen(t);
  const ago = t.last_seen ? Math.round((Date.now() - new Date(t.last_seen).getTime()) / 60e3) : null;
  const seen = ago == null ? "в сети не был" : ago < 3 ? "сейчас в сети" : ago < 90 ? `был в сети ${ago} мин назад` : `был в сети давно (${Math.round(ago / 60)} ч назад)`;
  return { open, seen, online: ago != null && ago < 3 };
}

// Поставить сообщение в очередь. Жёсткие (№121+) ждут подтверждения кодом.
async function svcApply(a, target, id) {
  const it = svcItem(id);
  if (!it) return fail(`Номер должен быть от 1 до ${SVC_COUNT}.`);
  if (!target) return fail("Пользователь не найден.");
  if (target.banned) return fail("Пользователь заблокирован: сообщение до него не дойдёт.");
  if (target.rank === "owner" && a.kind !== "owner") return fail("Владельцу такое отправлять нельзя.");
  if (!(await hit(`svc:a:${a.label}`, 40, 600))) return fail(RATE_MSG);
  const sql = db();
  // чистим то, что никто не забрал или что не подтвердили
  await sql`delete from pranks where shown_at is null and applied_at < now() - interval '1 day'`;
  await sql`delete from pranks where not confirmed and confirm_expires < now() - interval '1 hour'`;
  const [dup] = await sql`select 1 as x from pranks where user_id = ${target.id} and prank_id = ${id} and shown_at is null and (confirmed or confirm_expires > now()) limit 1`;
  if (dup) return fail("Это сообщение уже ждёт показа у пользователя. Отменить: /prank cancel <логин> [номер].");
  const [q] = await sql`select count(*)::int as n from pranks where user_id = ${target.id} and shown_at is null and confirmed`;
  if (q.n >= SVC_QUEUE_MAX) return fail(`У пользователя уже ждут показа ${SVC_QUEUE_MAX} сообщений. Подождите, пока он их увидит.`);
  let code = "";
  let exp = null;
  if (it.hard) {
    const r = new Uint8Array(6);
    crypto.getRandomValues(r);
    code = [...r].map((x) => CODE_ALPH[x & 31]).join("");
    exp = new Date(Date.now() + SVC_CODE_MIN * 60e3);
  }
  await sql`insert into pranks (user_id, prank_id, applied_by, target_login, confirmed, confirmed_at, confirm_code, confirm_expires)
            values (${target.id}, ${id}, ${a.label}, ${target.login}, ${!it.hard}, ${it.hard ? null : new Date()}, ${code}, ${exp})`;
  await audit(a.label, "svc_send", target.login, { n: id, hard: it.hard });
  return { ok: true, id, title: it.title, icon: it.icon, cat: it.cat, hard: it.hard, code, minutes: SVC_CODE_MIN, user: target.login, reach: await svcReach(target) };
}

// Подтвердить жёсткое сообщение кодом: подтверждает тот же, кто его создал
async function svcConfirm(a, raw) {
  const code = normCode(String(raw == null ? "" : raw).replace(/^\s*(код|code)\s*[:=]?\s*/i, "")).slice(0, 6);
  if (code.length !== 6) return fail("Код состоит из 6 символов. Пример: /prank confirm код:AB12CD");
  if (!(await hit(`svc:c:${a.label}`, 12, 600))) return fail(RATE_MSG);
  const sql = db();
  const [r] = await sql`update pranks set confirmed = true, confirmed_at = now(), confirm_code = ''
                        where id = (select id from pranks where confirm_code = ${code} and applied_by = ${a.label} and not confirmed and confirm_expires > now() order by id desc limit 1)
                        returning id, prank_id, target_login, user_id`;
  if (!r) return fail(`Код не найден, уже использован или истёк (он действует ${SVC_CODE_MIN} минут). Выдайте жёсткое сообщение заново.`);
  const it = svcItem(r.prank_id);
  const [t] = await sql`select * from profiles where id = ${r.user_id}`;
  await audit(a.label, "svc_confirm", r.target_login, { n: r.prank_id });
  return { ok: true, id: r.prank_id, title: it ? it.title : "", user: r.target_login, reach: t ? await svcReach(t) : null };
}

// Отменить то, что пользователь ещё не получил
async function svcCancel(a, target, id, rowId) {
  const sql = db();
  const mine = a.kind === "owner" ? sql`true` : sql`applied_by = ${a.label}`;
  const rows = rowId
    ? await sql`delete from pranks where id = ${rowId} and shown_at is null and ${mine} returning prank_id, target_login`
    : id
      ? await sql`delete from pranks where user_id = ${target.id} and prank_id = ${id} and shown_at is null and ${mine} returning prank_id, target_login`
      : await sql`delete from pranks where user_id = ${target.id} and shown_at is null and ${mine} returning prank_id, target_login`;
  if (rows.length) await audit(a.label, "svc_cancel", rows[0].target_login, { n: rows.map((r) => r.prank_id) });
  return { ok: true, removed: rows.length };
}

// Последние отправки: владелец видит все, остальные только свои
async function svcRecent(a, target) {
  const sql = db();
  const rows = await sql`select p.id, p.prank_id, p.applied_by, p.applied_at, p.confirmed, p.shown_at, p.confirm_expires, p.target_login, x.nick
                         from pranks p left join profiles x on x.id = p.user_id
                         where ${a.kind === "owner" ? sql`true` : sql`p.applied_by = ${a.label}`} and ${target ? sql`p.user_id = ${target.id}` : sql`true`}
                         order by p.id desc limit 20`;
  return rows.map((r) => {
    const it = svcItem(r.prank_id);
    const state = r.shown_at ? "shown" : r.confirmed ? "queued" : r.confirm_expires && new Date(r.confirm_expires).getTime() > Date.now() ? "await" : "expired";
    return { id: String(r.id), n: r.prank_id, title: it ? it.title : "№" + r.prank_id, icon: it ? it.icon : "", hard: r.prank_id >= SVC_HARD_FROM, user: r.target_login, nick: r.nick || "", by: r.applied_by, at: r.applied_at, shown: r.shown_at, state };
  });
}
const SVC_STATE = { shown: "показано", queued: "ждёт показа", await: "ждёт код", expired: "код истёк" };

// Опрос из программы: забрать сообщения, которые пора показать (раз в минуту, только когда канал открыт)
async function svcApi(b) {
  const { p, err } = await who(b);
  if (err) return err;
  if (!(await svcOpen(p))) return { ok: true, items: [] };
  if (!(await hit(`svc:p:${p.id}`, 90, 600))) return { ok: true, items: [] };
  const sql = db();
  const rows = await sql`update pranks set shown_at = now()
                         where id in (select id from pranks where user_id = ${p.id} and confirmed and shown_at is null and applied_at > now() - make_interval(hours => ${SVC_FRESH_H}) order by id limit 2)
                         returning id, prank_id`;
  const items = rows
    .map((r) => {
      const it = svcItem(r.prank_id);
      return it ? { id: String(r.id), n: it.id, title: it.title, cat: it.cat, hard: it.hard, fx: it.fx, nick: p.nick || p.login } : null;
    })
    .filter(Boolean);
  return { ok: true, items };
}

const svcName = (it) => `${it.icon} №${it.id} «${esc(it.title)}»`;
const svcReachText = (r) => (r ? `${r.seen}${r.open ? (r.online ? ": сообщение придёт в течение минуты." : ". Сообщение придёт, когда он откроет программу (за 6 часов).") : ". ⚠️ Канал для него пока закрыт (нужен доступ к бете), сообщение ждёт."}` : "");
const HELP_ROFL =
  "<b>Роль «Рофл менеджмент»</b>\n" +
  "/prank list — категории; /prank list &lt;категория&gt; — номера и названия\n" +
  "/prank &lt;логин&gt; &lt;номер 1–150&gt; — отправить\n" +
  "/prank confirm код:XXXXXX — подтвердить жёсткое (№121–150), код живёт " + SVC_CODE_MIN + " минут\n" +
  "/prank cancel &lt;логин&gt; [номер] — отменить то, что ещё не показано\n" +
  "/prank status [логин] — последние отправки\n" +
  "/rofl &lt;логин&gt; on|off [telegram_id] — выдать или забрать роль (владелец); /rofl list\n";

// Команды /prank и /rofl. Тем, у кого нет роли, бот отвечает как на неизвестную команду.
async function svcCommand(chat, a, cmd, args) {
  const unknown = () => send(chat, "Неизвестная команда. /help");
  const sql = db();
  if (cmd === "rofl") {
    if (a.kind !== "owner") return unknown();
    if (!args[0] || args[0].toLowerCase() === "list") {
      const rows = await sql`select login, nick, org, tg_id is not null as tg from profiles where rofl order by login_lc limit 100`;
      return send(chat, rows.length ? `<b>Роль «Рофл менеджмент»: ${rows.length}</b>\n` + rows.map((r) => `• <code>${esc(r.login)}</code> — ${esc(r.nick)} · ${esc(r.org)}${r.tg ? " · Telegram привязан" : ""}`).join("\n") : "Роль пока ни у кого не выдана. Выдать: /rofl &lt;логин&gt; on");
    }
    const p = await findProfile(args[0]);
    if (!p) return send(chat, "Пользователь не найден.");
    const on = !/^(off|нет|0|выкл)/i.test(String(args[1] || "on"));
    const tg = args.slice(1).find((x) => /^\d{3,15}$/.test(x));
    if (on && tg) {
      const [other] = await sql`select login from profiles where tg_id = ${tg} and id <> ${p.id}`;
      if (other) return send(chat, `Этот Telegram ID уже привязан к аккаунту ${esc(other.login)}.`);
      await sql`update profiles set rofl = true, tg_id = ${tg} where id = ${p.id}`;
    } else await sql`update profiles set rofl = ${on} where id = ${p.id}`;
    await audit(a.label, on ? "rofl_on" : "rofl_off", p.login, {});
    const hasTg = on && (tg || p.tg_id != null || PANEL_RANKS.includes(p.rank));
    return send(chat, on ? `✅ ${esc(p.login)}: роль «Рофл менеджмент» выдана.${hasTg ? "" : "\nЧтобы пользоваться ботом, нужен его Telegram ID: /rofl " + esc(p.login) + " on 123456789 (ID покажет бот в ответ на /start)."}` : `✅ ${esc(p.login)}: роль «Рофл менеджмент» снята.`);
  }

  if (!svcCan(a)) return unknown();
  const sub = String(args[0] || "").toLowerCase();

  if (!sub || sub === "help") return send(chat, HELP_ROFL);

  if (sub === "list" || sub === "cats") {
    const q = String(args[1] || "").toLowerCase();
    if (!q) {
      return send(chat, "<b>Каталог: " + SVC_COUNT + " вариантов</b>\n" + Object.entries(SVC_CATS).map(([k, c]) => `${c[3]} <code>${k}</code> — ${c[0]} (№${c[1]}–${c[2]})${c[1] >= SVC_HARD_FROM ? " 🔐 нужен код" : ""}`).join("\n") + "\n\nНомера категории: /prank list &lt;категория&gt;, например /prank list zhostkij");
    }
    const key = Object.keys(SVC_CATS).find((k) => k === q || SVC_CATS[k][0].toLowerCase().startsWith(q));
    if (!key) return send(chat, "Такой категории нет. Список: /prank list");
    const c = SVC_CATS[key];
    const lines = [];
    for (let i = c[1]; i <= c[2]; i++) lines.push(`${i}. ${SVC_LIST[i - 1].icon} ${esc(SVC_LIST[i - 1].title)}`);
    return send(chat, `${c[3]} <b>${c[0]}</b> (<code>${key}</code>)${c[1] >= SVC_HARD_FROM ? "\n🔐 Нужен код подтверждения: /prank confirm код:XXXXXX" : ""}\n` + lines.join("\n"));
  }

  if (sub === "confirm") {
    const r = await svcConfirm(a, args.slice(1).join(" "));
    if (!r.ok) return send(chat, "❌ " + esc(r.error));
    return send(chat, `✅ Подтверждено: №${r.id} «${esc(r.title)}» → <b>${esc(r.user)}</b>.\n${svcReachText(r.reach)}`);
  }

  if (sub === "cancel") {
    const t = args[1] ? await findProfile(args[1]) : null;
    if (!t) return send(chat, args[1] ? "Пользователь не найден." : "Использование: /prank cancel &lt;логин&gt; [номер]");
    const n = args[2] ? parseInt(args[2], 10) || 0 : 0;
    const r = await svcCancel(a, t, n, 0);
    return send(chat, r.removed ? `✅ Отменено: ${r.removed} (${esc(t.login)}). То, что уже показано, вернуть нельзя.` : "Нечего отменять: всё уже показано или не вами отправлено.");
  }

  if (sub === "status") {
    const t = args[1] ? await findProfile(args[1]) : null;
    if (args[1] && !t) return send(chat, "Пользователь не найден.");
    const rows = await svcRecent(a, t);
    return send(chat, rows.length ? "<b>Последние отправки</b>\n" + rows.map((r) => `${r.icon} №${r.n} «${esc(r.title)}» → <code>${esc(r.user)}</code> · ${SVC_STATE[r.state]}${a.kind === "owner" ? " · " + esc(r.by) : ""}`).join("\n") : "Отправок пока нет.");
  }

  // /prank <логин> <номер>  или  /prank <номер> <логин>
  const num = args.find((x) => /^\d{1,3}$/.test(x));
  const loginArg = args.find((x) => x !== num);
  if (!num || !loginArg) return send(chat, HELP_ROFL);
  const t = await findProfile(loginArg);
  const r = await svcApply(a, t, parseInt(num, 10));
  if (!r.ok) return send(chat, "❌ " + esc(r.error));
  if (r.hard)
    return send(chat, `🔐 <b>Жёсткое: №${r.id} «${esc(r.title)}» → ${esc(r.user)}</b>\nНа экране пользователя появится ненастоящее полноэкранное окно; в конце программа сама объяснит, что это шутка.\n\nКод подтверждения: <code>${r.code}</code>\nВведите в течение ${r.minutes} минут:\n<code>/prank confirm код:${r.code}</code>`);
  return send(chat, `✅ Отправлено: ${svcName({ id: r.id, icon: r.icon, title: r.title })} → <b>${esc(r.user)}</b>\n${svcReachText(r.reach)}`);
}

// Операции панели (сайт): каталог, отправка, код, отмена
async function panelSvc(b, p, a, op) {
  if (!svcCan(a)) return fail("Недостаточно прав.", { code: "forbidden" });
  if (op === "svc_cat") {
    const flag = (await flagsNow()).svc32;
    return {
      ok: true,
      flag,
      hardFrom: SVC_HARD_FROM,
      minutes: SVC_CODE_MIN,
      cats: Object.entries(SVC_CATS).map(([key, c]) => ({ key, name: c[0], from: c[1], to: c[2], icon: c[3] })),
      items: SVC_LIST.map((it, i) => ({ id: i + 1, cat: svcCatOf(i + 1), icon: it.icon, title: it.title, desc: it.desc, hard: i + 1 >= SVC_HARD_FROM })),
      recent: await svcRecent(a, null),
    };
  }
  if (op === "svc_list") return { ok: true, recent: await svcRecent(a, null) };
  if (op === "svc_apply") {
    const t = await findProfile(String(b.login || ""));
    return svcApply(a, t, parseInt(b.n, 10) || 0);
  }
  if (op === "svc_confirm") return svcConfirm(a, b.code);
  if (op === "svc_cancel") {
    const r = await svcCancel(a, null, 0, parseInt(b.id, 10) || 0);
    return r.removed ? { ok: true } : fail("Уже показано или не найдено.");
  }
  return fail("Неизвестное действие.", { code: "bad_op" });
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
  try {
    await watchServices();
  } catch (e) {
    console.error("watch", e);
  }
  try {
    await weeklyBackupCheck();
  } catch (e) {
    console.error("bkcheck", e);
  }
  if (Math.random() < 0.05) await cleanup();
  return { ok: true, jobs: jobs.length };
}

// 3.7: наблюдение за сервисами. Сервис не отвечает дольше 5 минут — владельцу сообщение в Telegram, при восстановлении — ещё одно.
// Если упал сам сервер (функция), об этом сообщает Discord-бот (канал «Мониторинг»).
const WATCH_DOWN_MS = 5 * 60e3;
async function watchServices() {
  if (!OWNER_TG) return;
  const checks = [
    ["ai", "ИИ-помощник", async () => { const r = await fetch(AI_HEALTH_URL, { signal: AbortSignal.timeout(8000) }); const j = await r.json().catch(() => ({})); return r.ok && j.ok !== false; }],
    ["site", "Сайт", async () => (await fetch(SITE_URL + "/status.html", { signal: AbortSignal.timeout(8000) })).status < 500],
    ["db", "База данных", async () => { await db()`select 1`; return true; }],
  ];
  const W = (await getSetting("watch", {})) || {};
  const now = Date.now();
  let changed = false;
  for (const [k, name, fn] of checks) {
    let ok = false;
    try { ok = await fn(); } catch (e) { ok = false; }
    const w = W[k] || {};
    if (ok) {
      if (w.alerted) await send(OWNER_TG, `✅ <b>${name}</b> снова работает. Был недоступен ${Math.max(1, Math.round((now - w.since) / 60e3))} мин.`);
      if (w.since) { W[k] = {}; changed = true; }
    } else {
      if (!w.since) { W[k] = { since: now }; changed = true; }
      else if (!w.alerted && now - w.since >= WATCH_DOWN_MS) {
        await send(OWNER_TG, `🚨 <b>${name}</b> не отвечает уже ${Math.round((now - w.since) / 60e3)} мин. Состояние: ${SITE_URL}/status.html`);
        W[k] = { ...w, alerted: true }; changed = true;
      }
    }
  }
  if (changed) await setSetting("watch", W);
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
  const srv = parseServer(b.server) || DEFAULT_SERVER;
  const items = Array.isArray(b.items) ? b.items.slice(0, 25) : [];
  if (!items.length) {
    // ручной запуск без изменений — сообщаем только владельцу
    if (b.manual && OWNER_TG) await send(OWNER_TG, `⚖️ ${esc(srvName(srv))}: проверка законов завершена, изменений нет.${Number(b.count) ? " Законов: " + Number(b.count) + "." : ""}`);
    return { ok: true, sent: b.manual ? 1 : 0 };
  }
  try {
    for (const it of items) await db()`insert into law_changes (server, kind, title, arts) values (${srv}, ${it.type === "new" ? "new" : "changed"}, ${clean(it.title, 150)}, ${clean(it.arts, 200)})`;
  } catch (e) { console.error("law_changes", e); }
  const lines = items.map((it) =>
    `• ${it.type === "new" ? "🆕 Новый закон" : "✏️ Изменён"}: <b>${esc(clean(it.title, 150))}</b>${it.arts ? " — " + esc(clean(it.arts, 200)) : ""}`);
  const more = Array.isArray(b.items) && b.items.length > items.length ? `\n…и ещё ${b.items.length - items.length}` : "";
  const text = `⚖️ <b>Обновление законов · ${esc(srvName(srv))}</b>\n${lines.join("\n")}${more}\n\nИзменения уже в программе, раздел «Законы».`;
  const chats = new Set();
  if (OWNER_TG) chats.add(OWNER_TG);
  const rows = await db()`select tg_id from profiles where rank = 'leader' and server = ${srv} and tg_id is not null and not banned`;
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
  if (b && b.action === "dc_changelog") return J(await dcChangelogQueue(b));
  if (b && b.action === "laws_failed") {
    const run = /^\d{1,20}$/.test(String(b.run || "")) ? String(b.run) : "";
    if (OWNER_TG)
      await send(OWNER_TG, `❌ <b>Обновление законов не удалось${parseServer(b.server) ? " · " + esc(srvName(parseServer(b.server))) : ""}</b>${b.manual ? " (ручной запуск)" : ""}. В программе остались прошлые версии.${run ? `\n<a href="https://github.com/${GH_REPO}/actions/runs/${run}">Лог на GitHub</a>` : ""}`);
    return J({ ok: true });
  }
  return J(await tick());
}

// 3.4.4: changelog из сборки релиза. Бета-версии в публичный канал не идут (их функции видны только тестерам).
// Если задан вебхук discord_webhook_url — отправляем сразу; иначе кладём в очередь, Discord-бот забирает её раз в минуту.
function dcChanges(notes) {
  return String(notes || "").split("\n").map((l) => l.trim()).filter((l) => /^[-*•]\s/.test(l))
    .map((l) => l.replace(/^[-*•]\s+/, "").replace(/\*\*(.+?)\*\*/g, "$1")).slice(0, 25);
}
async function dcChangelogQueue(b) {
  const version = clean(b.version, 40);
  if (!/^\d+\.\d+\.\d+/.test(version)) return fail("Нет версии.");
  if (b.prerelease || version.includes("-")) return { ok: true, skipped: "beta" };
  const changes = dcChanges(b.notes);
  const item = { id: crypto.randomUUID(), version, changes, link: `https://github.com/${GH_REPO}/releases/tag/v${version}`, at: new Date().toISOString() };
  const hookUrl = await getSetting("discord_webhook_url", "");
  if (hookUrl) {
    try {
      const r = await fetch(hookUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username: "Senko Assistant", embeds: [{ title: `📦 Обновление Senko Assistant ${version}`, description: changes.map((c) => "• " + c).join("\n").slice(0, 4000) || "—", url: item.link, color: 0x2ecc71, timestamp: item.at, footer: { text: "Senko Assistant · Changelog" } }] }),
      });
      if (r.ok) {
        await audit("release", "discord_changelog", version, { via: "webhook" });
        return { ok: true, sent: "webhook" };
      }
    } catch (e) {}
  }
  await setSetting("discord_changelog_pending", item);
  await audit("release", "discord_changelog", version, { via: "queue" });
  return { ok: true, sent: "queue" };
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
const panelMe = (p, a) => ({ login: p.login, nick: p.nick, rank: p.rank, rankName: RANKS[p.rank], kind: a.kind, owner: a.kind === "owner", rofl: svcCan(a), tg: p.tg_id != null || a.kind === "owner" && !!OWNER_TG, idleMin: PANEL_IDLE_MIN, staffServer: scopeServer(a) });

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
  const oe = await otpGate(p, b, ip, "панель");
  if (oe) return oe;
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
  profiles: { title: "Пользователи", key: "id", order: "created_at", search: ["login", "nick", "static_id", "discord"], hide: ["pass_hash", "devices", "login_lc", "totp_secret", "totp_pending", "totp_backup", "totp_last"],
    cols: { nick: "text", static_id: "text", org: DEPTS, dept: "text", game_role: ["off", "pros", "adv", "judge"], judge_pos: ["", "district", "appeal", "supreme", "assistant", "secretary"], pvs: "bool", discord: "text", telegram: "text", phone: "text", tags: "tags", contacts_open: "tags", approval: ["ok", "pending", "rejected"], banned: "bool", totp_on: "bool", ban_reason: "text", banned_until: "time", app_version: "text" } },
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

async function panelDash(a, b = {}) {
  const sql = db();
  const srv = scopeServer(a) || parseServer(b.server);
  const sf = srv ? sql`where server = ${srv}` : sql``;
  const byServer = await sql`select server, count(*)::int n, count(*) filter (where last_seen > now() - interval '7 days')::int active from profiles group by server order by server`;
  const [u] = await sql`select count(*)::int total,
      count(*) filter (where last_seen > now() - interval '1 hour')::int online,
      count(*) filter (where last_seen > now() - interval '1 day')::int today,
      count(*) filter (where created_at > now() - interval '7 days')::int week,
      count(*) filter (where banned)::int banned,
      count(*) filter (where approval = 'pending')::int pending,
      count(*) filter (where rank = 'moderator')::int mods,
      count(*) filter (where rank = 'leader')::int leaders from profiles ${sf}`;
  const orgs = await sql`select org, count(*)::int n, count(*) filter (where last_seen > now() - interval '7 days')::int active from profiles ${sf} group by org order by n desc`;
  const [{ resets }] = await sql`select count(*)::int resets from reset_requests where status = 'pending' and expires_at > now()`;
  const [{ bugs }] = await sql`select count(*)::int bugs from bug_reports where not answered`;
  const [{ reports }] = await sql`select count(*)::int reports from reports where status = 'new'`;
  const [{ notices }] = await sql`select count(*)::int notices from broadcasts where expires_at > now() and user_id is null`;
  const days = await sql`select to_char(date_trunc('day', created_at + interval '3 hours'), 'DD.MM') d, count(*)::int n from profiles
                         where created_at > now() - interval '14 days' ${srv ? sql`and server = ${srv}` : sql``} group by 1 order by min(created_at)`;
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
  return { ok: true, users: u, orgs, resets, bugs, reports, notices, days, server: srv, servers: byServer.map((r) => ({ id: r.server, name: (SERVERS[r.server] || { name: "сервер " + r.server }).name, n: r.n, active: r.active })), modes: a.kind === "owner" ? modes : { maintenance: modes.maintenance, approval: modes.approval, regs: modes.regs } };
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
  // сервер: модератор с ограничением видит только свой сервер, остальные могут отфильтровать по серверу
  const srv = scopeServer(a) || parseServer(b.server);
  if (srv) conds.push(sql`server = ${srv}`);
  if (b.beta === true || b.beta === "1") conds.push(sql`beta`);
  if (b.state === "banned") conds.push(sql`banned`);
  if (b.state === "pending") conds.push(sql`approval <> 'ok'`);
  if (b.state === "online") conds.push(sql`last_seen > now() - interval '1 hour'`);
  const where = conds.reduce((x, y) => sql`${x} and ${y}`);
  const order = b.sort === "seen" ? sql`last_seen desc nulls last` : b.sort === "login" ? sql`login_lc` : sql`created_at desc`;
  const rows = await sql`select id, login, nick, static_id, org, server, staff_server, beta, rank, banned, banned_until, approval, tags, app_version, created_at, last_seen, tg_id is not null as has_tg,
                           (select count(*)::int from account_warns w where w.user_id = profiles.id) warns
                         from profiles where ${where} order by ${order} limit 41 offset ${page * 40}`;
  const [{ n }] = await sql`select count(*)::int n from profiles where ${where}`;
  return { ok: true, rows: rows.slice(0, 40), more: rows.length > 40, page, total: n };
}

async function panelUser(b, a) {
  const p = await findProfile(String(b.login || ""));
  if (!p) return fail("Пользователь не найден.");
  const sc = scopeServer(a);
  if (sc && (p.server || DEFAULT_SERVER) !== sc) return fail("Пользователь с другого сервера.");
  const sql = db();
  const owner = a.kind === "owner";
  const [k] = await sql`select created_at, last_used_at from panel_keys where user_id = ${p.id}`;
  const logins = owner ? await sql`select at, kind, ver, os, ip from login_log where user_id = ${p.id} order by at desc limit 10` : [];
  const [{ sessions }] = await sql`select count(*)::int sessions from sessions where user_id = ${p.id} and expires_at > now()`;
  return {
    ok: true,
    html: await fullCard(p, a.kind),
    user: { login: p.login, nick: p.nick, static: p.static_id, org: p.org, server: p.server || DEFAULT_SERVER, serverName: srvName(p.server || DEFAULT_SERVER), staffServer: p.staff_server || 0, rank: p.rank, rankName: RANKS[p.rank], banned: p.banned, approval: p.approval, tags: p.tags || [], hasTg: p.tg_id != null, self: p.id === a.profile.id, beta: !!p.beta },
    touch: canTouch(a, p) || "",
    panelKey: owner && k ? { created: k.created_at, used: k.last_used_at } : null,
    logins,
    sessions,
  };
}

async function panelStaff(a) {
  const sql = db();
  const rows = await sql`select p.login, p.nick, p.org, p.server, p.staff_server, p.rank, p.tg_id is not null as has_tg, p.last_seen, k.created_at as key_at, k.last_used_at as key_used,
                           (select count(*)::int from panel_sessions s where s.user_id = p.id and s.expires_at > now()) as panels
                         from profiles p left join panel_keys k on k.user_id = p.id
                         where p.rank in ('owner','moderator','leader') ${scopeServer(a) ? sql`and (p.server = ${scopeServer(a)} or p.rank = 'owner')` : sql``}
                         order by array_position(array['owner','moderator','leader'], p.rank), p.server, p.org, p.login_lc`;
  return { ok: true, rows: rows.map((r) => (a.kind === "owner" ? r : { ...r, key_at: null, key_used: null, panels: null })), site: SITE_URL };
}

const SEC_KINDS = ["fail", "otp_fail", "otp_backup", "new_device", "device_end", "logout_all", "password", "totp_on", "totp_off", "totp_codes"];
async function panelApi(b, ip, ua) {
  const op = String(b.op || "");
  if (op === "login") return panelLogin(b, ip, ua);
  const owners = ["audit", "security", "gloss_get", "gloss_save", "bugs", "bug_log", "bug_reply", "staff_key", "staff_revoke", "db_tables", "db_rows", "db_save", "db_delete", "db_revert", "ads_list", "ads_save", "ads_toggle", "ads_delete",
    "prog_get", "prog_xp", "prog_ach", "prog_ach_new", "prog_ai",
    "ai_dict_list", "ai_dict_save", "ai_dict_delete", "ai_bad", "ai_gold_list", "ai_gold_save", "ai_gold_delete", "ai_gold_pin", "ai_gold_run", "srvcfg_get", "srvcfg_set", "month_sum", "org_cmp"];
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
      return panelDash(a, b);
    case "month_sum":
      return panelMonth(b, a);
    case "org_cmp":
      return panelOrgCmp(b, a);
    case "health":
      return { ok: true, html: await healthText() };
    case "users":
      return panelUsers(b, a);
    case "user":
      return panelUser(b, a);
    case "staff":
      return panelStaff(a);
    case "svc_cat":
    case "svc_list":
    case "svc_apply":
    case "svc_confirm":
    case "svc_cancel":
      return panelSvc(b, p, a, op);
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
      const srv = parseServer(b.server);
      const sf = srv ? sql`server = ${srv}` : sql`true`;
      const rows = q
        ? await sql`select * from audit_log where (action = ${q} or target ilike ${like} or actor ilike ${like}) and ${sf} order by id desc limit 51 offset ${page * 50}`
        : await sql`select * from audit_log where ${sf} order by id desc limit 51 offset ${page * 50}`;
      return { ok: true, rows: rows.slice(0, 50), more: rows.length > 50, page, actions: AUDIT_ACTIONS, servers: Object.keys(SERVERS).map((k) => ({ id: +k, name: SERVERS[k].name })) };
    }
    // 3.8: глоссарий терминов
    case "gloss_get":
      return { ok: true, items: await glossRows(), custom: (await getSetting("glossary", null)) != null };
    case "gloss_save": {
      const items = glossClean(b.items);
      await setSetting("glossary", items);
      glossCache = null;
      await audit(a.label, "glossary", null, { n: items.length });
      return { ok: true, items };
    }
    // 3.7: журнал безопасности — неудачные входы, новые устройства, смена пароля, вход с кодом
    case "security": {
      const kinds = SEC_KINDS.includes(b.kind) ? [b.kind] : SEC_KINDS;
      const days = Math.max(1, Math.min(90, parseInt(b.days, 10) || 14));
      const q = clean(b.q, 24).toLowerCase();
      const rows = await sql`select l.at, l.kind, l.ver, l.os, l.ip, p.login, p.nick, p.rank, p.org
                             from login_log l join profiles p on p.id = l.user_id
                             where l.kind = any(${kinds}) and l.at > now() - make_interval(days => ${days}) ${q ? sql`and p.login_lc like ${likeEsc(q) + "%"}` : sql``}
                             order by l.at desc limit 300`;
      const top = await sql`select p.login, p.rank, count(*)::int as n, max(l.at) as last from login_log l join profiles p on p.id = l.user_id
                            where l.kind in ('fail', 'otp_fail') and l.at > now() - interval '1 day' group by p.login, p.rank having count(*) >= 3 order by n desc limit 15`;
      const [st] = await sql`select count(*) filter (where totp_on)::int as totp, count(*)::int as users,
                               count(*) filter (where totp_on and rank in ('owner', 'moderator', 'leader'))::int as staff_totp,
                               count(*) filter (where rank in ('owner', 'moderator', 'leader'))::int as staff from profiles`;
      return { ok: true, rows, top, stats: st, kinds: SEC_KINDS, days };
    }
    case "bugs": {
      const rows = await sql`select b.id, b.user_id, b.text, b.app_version, b.answered, b.at, length(b.log)::int as log_len, b.source, b.contact, p.login, p.nick, p.org
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
      if (!bug.user_id) return fail(`Это сообщение с сайта, без аккаунта: ответить можно только по контакту${bug.contact ? " «" + bug.contact + "»" : " (он не указан)"}.`);
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
    case "srvcfg_get":
    case "srvcfg_set":
      return panelSrvCfg(b, a);
    case "ads_list":
    case "ads_save":
    case "ads_toggle":
    case "ads_delete":
      return panelAds(b, a);
    case "col_clear": {
      // 2.8: модерация профиля для коллег — убрать должность, «о себе» и фото
      const t = await findProfile(String(b.login || ""));
      if (!t) return fail("Пользователь не найден.");
      const no = canTouch(a, t);
      if (no) return fail(no);
      await db()`update profiles set post = '', bio = '' where id = ${t.id}`;
      await db()`delete from avatars where user_id = ${t.id}`;
      await audit(a.label, "col_clear", t.login, { post: t.post || "", bio: t.bio || "" });
      return { ok: true };
    }
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
const SCHEMA_V = 48;
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
// 2.8: должность и «о себе» в профиле, время смены организации, аватары для профилей коллег
const SCHEMA_28 = `
alter table public.profiles add column if not exists post text not null default '';
alter table public.profiles add column if not exists bio text not null default '';
alter table public.profiles add column if not exists hide_discord boolean not null default false;
alter table public.profiles add column if not exists org_at timestamptz;
create table if not exists public.avatars (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  img text not null, updated_at timestamptz not null default now());
alter table public.avatars enable row level security;
revoke all on table public.avatars from anon, authenticated;
create table if not exists public.handoffs (
  code text primary key, from_id uuid not null references public.profiles(id) on delete cascade,
  data jsonb not null, created_at timestamptz not null default now(), expires_at timestamptz not null);
alter table public.handoffs enable row level security;
revoke all on table public.handoffs from anon, authenticated;
`;
// 2.9: мультисерверность. server — сервер игрока (у всех прежних Boston, 12); staff_server — сервер модератора (0 — все серверы)
const SCHEMA_29 = `
alter table public.profiles add column if not exists server integer not null default 12;
alter table public.profiles add column if not exists staff_server integer not null default 0;
create index if not exists profiles_server_idx on public.profiles (server, org);
alter table public.audit_log add column if not exists server integer;
update public.audit_log a set server = p.server from public.profiles p where a.server is null and a.target is not null and p.login_lc = lower(a.target);
create index if not exists audit_log_server_idx on public.audit_log (server, id desc);
alter table public.shifts add column if not exists server integer not null default 12;
alter table public.control_tests add column if not exists server integer not null default 12;
alter table public.reports add column if not exists server integer not null default 12;
alter table public.org_events add column if not exists server integer not null default 12;
alter table public.broadcasts add column if not exists server integer;
update public.broadcasts set server = 12 where org is not null and server is null;
do $$ begin
  if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'org_hooks' and column_name = 'server') then
    alter table public.org_hooks add column server integer not null default 12;
    alter table public.org_hooks drop constraint if exists org_hooks_pkey;
    alter table public.org_hooks add primary key (org, server);
  end if;
end $$;
`;
const SCHEMA_30 = `
create table if not exists public.discord_tickets (
  id           bigserial primary key,
  user_id      uuid references public.profiles(id) on delete cascade,
  discord_id   text not null,
  discord_name text not null,
  channel_id   text not null,
  channel_name text not null,
  message_id   text not null default '',
  status       text not null default 'open' check (status in ('open','accepted','closed')),
  accepted_by  text not null default '',
  created_at   timestamptz not null default now(),
  closed_at    timestamptz
);
create index if not exists discord_tickets_user_idx on public.discord_tickets (user_id);
create index if not exists discord_tickets_status_idx on public.discord_tickets (status);
create index if not exists discord_tickets_channel_idx on public.discord_tickets (channel_id);

create table if not exists public.discord_monitor (
  id       bigserial primary key,
  resource text not null,
  ok       boolean not null default true,
  latency  integer not null default 0,
  detail   text not null default '',
  checked_at timestamptz not null default now()
);
create index if not exists discord_monitor_resource_idx on public.discord_monitor (resource, checked_at desc);

alter table public.discord_tickets enable row level security;
alter table public.discord_monitor enable row level security;
revoke all on table public.discord_tickets, public.discord_monitor from anon, authenticated;
`;
// 3.5: сообщения об ошибках с сайта (без аккаунта) и лента изменений законов для сайта
const SCHEMA_35 = `
alter table public.bug_reports alter column user_id drop not null;
alter table public.bug_reports add column if not exists source text not null default 'app';
alter table public.bug_reports add column if not exists contact text not null default '';
create table if not exists public.law_changes (
  id bigint generated always as identity primary key, server integer not null, kind text not null default 'changed',
  title text not null default '', arts text not null default '', at timestamptz not null default now());
create index if not exists law_changes_server_idx on public.law_changes (server, id desc);
alter table public.law_changes enable row level security;
revoke all on table public.law_changes from anon, authenticated;
alter table public.profiles add column if not exists pub_board boolean not null default false;
alter table public.profiles add column if not exists discord_uid text;
alter table public.profiles add column if not exists discord_uname text not null default '';
create unique index if not exists profiles_discord_uid_idx on public.profiles (discord_uid) where discord_uid is not null;
create table if not exists public.dc_auth (
  state text primary key, pk_hash text not null, purpose text not null, user_id uuid references public.profiles(id) on delete cascade,
  done boolean not null default false, error text, discord_id text, discord_name text,
  created_at timestamptz not null default now(), expires_at timestamptz not null);
alter table public.dc_auth enable row level security;
revoke all on table public.dc_auth from anon, authenticated;
`;
// 3.5.6: один раз при переходе на схему 37 — новые функции открываются всем, сохранённые режимы «beta» становятся «all» («off» остаётся)
// 3.6: кто прочитал объявление руководства
const SCHEMA_38 = `
create table if not exists public.notice_reads (
  broadcast_id bigint not null references public.broadcasts(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  at timestamptz not null default now(),
  primary key (broadcast_id, user_id));
alter table public.notice_reads enable row level security;
revoke all on table public.notice_reads from anon, authenticated;
`;
// 3.7: вход с кодом (TOTP) и устройство у каждого входа
const SCHEMA_39 = `
alter table public.profiles add column if not exists totp_secret text;
alter table public.profiles add column if not exists totp_pending text;
alter table public.profiles add column if not exists totp_on boolean not null default false;
alter table public.profiles add column if not exists totp_last bigint not null default 0;
alter table public.profiles add column if not exists totp_backup text[] not null default '{}';
alter table public.sessions add column if not exists ver text;
alter table public.sessions add column if not exists os text;
alter table public.sessions add column if not exists ip text;
create index if not exists login_log_user_kind_idx on public.login_log (user_id, kind, at desc);
`;
// 3.8: вступление в организацию — приглашения, анкеты, заявки
const SCHEMA_40 = `
create table if not exists public.org_invites (
  code_hash text primary key, code_tail text not null, org text not null, server int not null,
  created_by uuid references public.profiles(id) on delete set null, created_by_label text not null default '',
  created_at timestamptz not null default now(), expires_at timestamptz not null, uses int not null default 0, max_uses int not null default 1, revoked boolean not null default false);
create index if not exists org_invites_org_idx on public.org_invites (org, server);
create table if not exists public.org_forms (
  org text not null, server int not null, questions jsonb not null default '[]', open boolean not null default false,
  updated_by text not null default '', updated_at timestamptz not null default now(), primary key (org, server));
create table if not exists public.org_apps (
  id bigint generated always as identity primary key, user_id uuid not null references public.profiles(id) on delete cascade,
  org text not null, server int not null, answers jsonb not null default '[]', status text not null default 'new',
  note text not null default '', created_at timestamptz not null default now(), decided_at timestamptz, decided_by text);
create index if not exists org_apps_org_idx on public.org_apps (org, server, status);
alter table public.org_invites enable row level security;
alter table public.org_forms enable row level security;
alter table public.org_apps enable row level security;
revoke all on table public.org_invites, public.org_forms, public.org_apps from anon, authenticated;
`;
// 3.8: результаты тестов для стажёров (видит автор теста)
const SCHEMA_41 = `
create table if not exists public.share_results (
  code text not null, user_id uuid not null references public.profiles(id) on delete cascade,
  nick text not null default '', login text not null default '', s int not null default 0, n int not null default 0,
  wrong jsonb not null default '[]', at timestamptz not null default now(), primary key (code, user_id));
alter table public.share_results enable row level security;
revoke all on table public.share_results from anon, authenticated;
`;
// 3.8: одноразовые коды входа в веб-версию по QR
const SCHEMA_45 = `
alter table public.court_cases add column if not exists stage text not null default 'filed';
alter table public.court_cases add column if not exists mat jsonb not null default '{}';
alter table public.court_cases add column if not exists notes_side jsonb not null default '{}';
alter table public.court_cases add column if not exists log jsonb not null default '[]';
alter table public.court_cases add column if not exists recusals jsonb not null default '[]';
alter table public.court_cases add column if not exists merged_into bigint;
alter table public.court_cases add column if not exists appeal_of bigint;
alter table public.court_cases add column if not exists level text not null default '';
alter table public.court_cases add column if not exists closed_at timestamptz;
alter table public.court_decisions add column if not exists no integer not null default 0;
alter table public.court_decisions add column if not exists case_id bigint;
alter table public.court_decisions add column if not exists person text not null default '';
alter table public.court_decisions add column if not exists verdict text not null default '';
alter table public.court_decisions add column if not exists term integer not null default 0;
alter table public.court_decisions add column if not exists fine integer not null default 0;
alter table public.court_decisions add column if not exists probation_until timestamptz;
alter table public.court_decisions add column if not exists appeal_until timestamptz;
alter table public.court_decisions add column if not exists exec_status text not null default 'done';
alter table public.court_decisions add column if not exists exec_at timestamptz;
alter table public.court_decisions add column if not exists amnesty text not null default '';
alter table public.court_decisions add column if not exists outcome text not null default '';
alter table public.court_decisions add column if not exists public boolean not null default false;
alter table public.court_decisions add column if not exists anon boolean not null default true;
alter table public.warrants add column if not exists no integer not null default 0;
alter table public.warrants add column if not exists uses jsonb not null default '[]';
alter table public.warrants drop constraint if exists warrants_status_check;
alter table public.warrants add constraint warrants_status_check check (status in ('req','ok','no','rev'));
alter table public.reports add column if not exists pros_mark text not null default '';
alter table public.reports add column if not exists pros_note text not null default '';
alter table public.reports add column if not exists pros_by text not null default '';
alter table public.profiles add column if not exists adv_on boolean not null default false;
alter table public.profiles add column if not exists adv_spec text not null default '';
alter table public.profiles add column if not exists adv_busy boolean not null default false;
alter table public.profiles add column if not exists adv_lic text not null default '';
alter table public.profiles add column if not exists adv_last timestamptz;
alter table public.profiles add column if not exists judge_exam jsonb;
create table if not exists public.adv_calls (
  id bigserial primary key, server integer not null default 12, caller_id uuid references public.profiles(id) on delete set null, caller text not null default '',
  suspect text not null, place text not null default '', note text not null default '', status text not null default 'open' check (status in ('open','taken','closed')),
  taker_id uuid references public.profiles(id) on delete set null, taker text not null default '', created_at timestamptz not null default now(), taken_at timestamptz);
create index if not exists adv_calls_srv on public.adv_calls (server, created_at desc);
alter table public.adv_calls enable row level security;
revoke all on table public.adv_calls from anon, authenticated;
`;
const SCHEMA_44 = `
alter table public.court_cases add column if not exists panel jsonb not null default '[]';
alter table public.court_decisions add column if not exists panel text not null default '';
create table if not exists public.court_sessions (
  code text primary key, server integer not null default 12, owner_id uuid references public.profiles(id) on delete set null, case_id bigint references public.court_cases(id) on delete set null,
  case_no text not null default '', title text not null default '', state jsonb not null default '{}', created_at timestamptz not null default now(), expires_at timestamptz not null);
create table if not exists public.court_session_members (
  code text not null references public.court_sessions(code) on delete cascade, user_id uuid not null references public.profiles(id) on delete cascade,
  role text not null default 'part', sig text not null default '', joined_at timestamptz not null default now(), seen_at timestamptz not null default now(), primary key (code, user_id));
create index if not exists court_session_members_user on public.court_session_members (user_id);
alter table public.court_sessions enable row level security;
alter table public.court_session_members enable row level security;
revoke all on table public.court_sessions, public.court_session_members from anon, authenticated;
`;
const SCHEMA_43 = `
alter table public.profiles add column if not exists judge_pos text not null default '';
alter table public.profiles add column if not exists pvs boolean not null default false;
alter table public.profiles drop constraint if exists profiles_game_role_check;
alter table public.profiles add constraint profiles_game_role_check check (game_role in ('off','pros','adv','judge'));
create table if not exists public.court_cases (
  id bigserial primary key, server integer not null default 12, no integer not null default 0, title text not null, kind text not null default 'crim',
  status text not null default 'open' check (status in ('open','closed')), parties jsonb not null default '[]', arts text not null default '',
  evidence jsonb not null default '[]', hearings jsonb not null default '[]', notes text not null default '', judge text not null default '', judge_login text not null default '',
  draw jsonb, author_id uuid references public.profiles(id) on delete set null, author text not null default '', author_login text not null default '',
  created_at timestamptz not null default now(), updated_at timestamptz not null default now());
create index if not exists court_cases_srv on public.court_cases (server, status, updated_at desc);
create table if not exists public.court_decisions (
  id bigserial primary key, server integer not null default 12, title text not null, case_no text not null default '', dt date not null default current_date,
  arts text not null default '', tags text not null default '', text text not null, author text not null default '', created_at timestamptz not null default now());
create index if not exists court_decisions_srv on public.court_decisions (server, dt desc);
create table if not exists public.warrants (
  id bigserial primary key, server integer not null default 12, kind text not null, target text not null, reason text not null, case_no text not null default '',
  status text not null default 'req' check (status in ('req','ok','no')), valid_until timestamptz, issued_by text not null default '', answer text not null default '',
  author_id uuid references public.profiles(id) on delete set null, author text not null default '', org text not null default '',
  created_at timestamptz not null default now(), decided_at timestamptz);
create index if not exists warrants_srv on public.warrants (server, created_at desc);
alter table public.court_cases enable row level security;
alter table public.court_decisions enable row level security;
alter table public.warrants enable row level security;
revoke all on table public.court_cases, public.court_decisions, public.warrants from anon, authenticated;
`;
const SCHEMA_42 = `
create table if not exists public.qr_logins (
  code_hash text primary key, user_id uuid not null references public.profiles(id) on delete cascade, expires_at timestamptz not null);
alter table public.qr_logins enable row level security;
revoke all on table public.qr_logins from anon, authenticated;
create table if not exists public.survey_answers (
  user_id uuid not null references public.profiles(id) on delete cascade, survey text not null, answers jsonb not null, at timestamptz not null default now(),
  primary key (user_id, survey));
alter table public.survey_answers enable row level security;
revoke all on table public.survey_answers from anon, authenticated;
create table if not exists public.plan_votes (
  user_id uuid not null references public.profiles(id) on delete cascade, item text not null, at timestamptz not null default now(),
  primary key (user_id, item));
alter table public.plan_votes enable row level security;
revoke all on table public.plan_votes from anon, authenticated;
create table if not exists public.day_counts (day date not null, k text not null, n integer not null default 0, primary key (day, k));
alter table public.day_counts enable row level security;
revoke all on table public.day_counts from anon, authenticated;
alter table public.reports add column if not exists org_no integer;
alter table public.reports add column if not exists resubmits integer not null default 0;
alter table public.reports drop constraint if exists reports_status_check;
alter table public.reports add constraint reports_status_check check (status in ('new','ok','no','rev'));
create table if not exists public.vacations (
  id bigserial primary key, user_id uuid not null references public.profiles(id) on delete cascade, org text not null, server integer not null default 12,
  kind text not null check (kind in ('ic','ooc')), start_at timestamptz not null, end_at timestamptz not null, note text not null default '', created_at timestamptz not null default now());
create index if not exists vacations_org on public.vacations (org, server, end_at);
alter table public.vacations add column if not exists status text not null default 'ok';
alter table public.vacations alter column status set default 'wait';
alter table public.vacations add column if not exists answer text not null default '';
alter table public.vacations add column if not exists decided_by text not null default '';
alter table public.vacations add column if not exists decided_at timestamptz;
alter table public.vacations drop constraint if exists vacations_status_check;
alter table public.vacations add constraint vacations_status_check check (status in ('wait','ok','no'));
create index if not exists vacations_user on public.vacations (user_id, end_at);
alter table public.vacations enable row level security;
revoke all on table public.vacations from anon, authenticated;
`;
const SCHEMA_37_ONCE = `
update public.bot_settings set value = (select coalesce(jsonb_object_agg(k, case when v = '"beta"'::jsonb then '"all"'::jsonb else v end), '{}'::jsonb) from jsonb_each(value) e(k, v))
  where key = 'flags' and jsonb_typeof(value) = 'object';
`;
let schemaReady = null;
function ensureSchema() {
  if (!schemaReady)
    schemaReady = (async () => {
      try {
        const v = await getSetting("schema_v", 0);
        if (+v >= SCHEMA_V) return;
        // база уже на 2.4: повторно 2.4 не выполняем (иначе вернулись бы удалённые баннеры по умолчанию)
        // 3.5: SCHEMA_30 и SCHEMA_35 повторяемы (create/alter … if not exists), их добавляем всем, кто ниже 35
        await db().unsafe((+v >= 30 ? SCHEMA_35 : (+v >= 29 ? SCHEMA_29 : +v >= 28 ? SCHEMA_28 + SCHEMA_29 : +v >= 27 ? SCHEMA_27 + SCHEMA_28 + SCHEMA_29 : +v >= 24 ? SCHEMA_27 + SCHEMA_28 + SCHEMA_29 : ADS_DDL + SCHEMA_24 + SCHEMA_27 + SCHEMA_28 + SCHEMA_29) + SCHEMA_30 + SCHEMA_35) + (+v < 37 ? SCHEMA_37_ONCE : "") + SCHEMA_38 + SCHEMA_39 + SCHEMA_40 + SCHEMA_41 + SCHEMA_42 + SCHEMA_43 + SCHEMA_44 + SCHEMA_45);
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
// [название в панели, режим по умолчанию, версия]. В панели сверху функции последней версии, остальные — в «Прошлых версиях»
const FLAG_DEFS = {
  board: ["Тактическая доска", "all", "2.4"],
  mini: ["Мини-окно задержания", "all", "2.4"],
  tts: ["Озвучка статей", "all", "2.4"],
  mascot: ["Лиса Senko", "all", "2.4"],
  season: ["Сезонное оформление", "all", "2.4"],
  card: ["Карточка сотрудника", "all", "2.4"],
  ideas: ["Идеи и голосование", "all", "2.4"],
  events: ["Мероприятия организаций", "all", "2.4"],
  svc32: ["Быстрая доставка служебных сообщений", "all", "3.2"],
  pub35: ["Публичный справочник, калькулятор и форма ошибки на сайте", "all", "3.5"],
};
// функции выпущенных версий включены у всех и флагов больше не имеют; бета 2.7.0 ещё спрашивает общий флаг ai27
const FLAG_RELEASED = { ai27: "all", srv29: "all",
  // 3.5.6: бывшие бета-функции 2.4–3.5 выпущены для всех и больше не переключаются
  patrol: "all", col28: "all", det28mk: "all", det28wait: "all", det28rp: "all", det28shift: "all", det28grp: "all", det28jur: "all", det28note: "all", det28sz: "all", det28wit: "all", det28chron: "all", det28xfer: "all", det28imm: "all", pad28: "all", pad28mini: "all", pad28tpl: "all", web35: "all", typo35: "all", lead35: "all", rate35: "all" }; // srv29 (выбор сервера) выпущен для всех
const FLAG_MODES = ["all", "beta", "off"];
async function flagsNow() {
  const s = (await getSetting("flags", {})) || {};
  const out = {};
  for (const k of Object.keys(FLAG_DEFS)) out[k] = FLAG_MODES.includes(s[k]) ? s[k] : FLAG_DEFS[k][1];
  return { ...FLAG_RELEASED, ...out };
}
// Пилот 2.9: Boston доступен всем, остальные серверы — по флагу srv29 (beta: только тестерам, all: всем, off: никому, кроме уже сидящих там)
async function serverOpen(srv, p) {
  if (srv === DEFAULT_SERVER || (p && sv(p) === srv)) return true;
  const m = (await flagsNow()).srv29;
  return m === "all" || (m === "beta" && isTester(p));
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
const HOOK_EVENTS = { court: "Суд: дела, заседания, ордера, решения (для Government)", rep: "Новые рапорты", join: "Новые сотрудники и заявки", ctrl: "Контрольные тесты", event: "Мероприятия и напоминания", week: "Еженедельный отчёт" };
const HOOK_RE = /^https:\/\/(?:ptb\.|canary\.)?discord(?:app)?\.com\/api\/webhooks\/\d{5,25}\/[\w-]{20,120}$/;
const hookMask = (u) => String(u || "").replace(/(\/webhooks\/\d+\/)[\w-]+$/, (m, a) => a + "•••" + String(u).slice(-4));
// Telegram-HTML в Markdown Discord
function htmlToMd(s) {
  return String(s || "")
    .replace(/<\/?b>/g, "**").replace(/<\/?i>/g, "*").replace(/<\/?code>/g, "`")
    .replace(/<a href="([^"]+)">([^<]*)<\/a>/g, "[$2]($1)").replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&amp;/g, "&");
}
async function postHook(org, server, ev, title, text, color = 0xff8a3d) {
  try {
    const [h] = await db()`select * from org_hooks where org = ${org} and server = ${server || DEFAULT_SERVER}`;
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
  await db()`update org_hooks set fails = ${ok ? 0 : h.fails + 1}, last_error = ${ok ? "" : er} where org = ${h.org} and server = ${h.server}`;
  return ok ? true : er;
}
async function hooksApi(b) {
  const { p, err } = await who(b, ["leader", "moderator", "owner"]);
  if (err) return err;
  const org = staffOrg(p, b);
  if (!org) return fail("Выберите организацию.");
  const srv = staffSrv(p, b);
  const sql = db();
  const op = String(b.op || "get");
  const label = `${p.login} (${RANKS[p.rank]})`;
  const out = async () => {
    const [h] = await sql`select * from org_hooks where org = ${org} and server = ${srv}`;
    return { ok: true, org, server: srv, events: HOOK_EVENTS, hook: h ? { url: hookMask(h.url), events: h.events || [], by: h.updated_by, at: h.updated_at, fails: h.fails, error: h.last_error } : null };
  };
  if (op === "get") return out();
  if (!(await hit(`hk:${p.id}`, 30, 3600))) return fail(RATE_MSG, { code: "rate" });
  if (op === "set") {
    const evs = (Array.isArray(b.events) ? b.events : []).map(String).filter((k) => HOOK_EVENTS[k]);
    const url = String(b.url || "").trim();
    const [h] = await sql`select * from org_hooks where org = ${org} and server = ${srv}`;
    if (url) {
      if (!HOOK_RE.test(url)) return fail("Нужна ссылка вебхука Discord: https://discord.com/api/webhooks/…");
      await sql`insert into org_hooks (org, server, url, events, updated_by) values (${org}, ${srv}, ${url}, ${evs}::text[], ${label})
                on conflict (org, server) do update set url = excluded.url, events = excluded.events, updated_by = excluded.updated_by, updated_at = now(), fails = 0, last_error = ''`;
    } else if (h) {
      await sql`update org_hooks set events = ${evs}::text[], updated_by = ${label}, updated_at = now() where org = ${org} and server = ${srv}`;
    } else return fail("Вставьте ссылку вебхука.");
    await audit(label, "hook", org, { events: evs, url: !!url });
    return out();
  }
  if (op === "test") {
    const [h] = await sql`select * from org_hooks where org = ${org} and server = ${srv}`;
    if (!h) return fail("Сначала сохраните вебхук.");
    const r = await hookSend(h, "✅ Проверка связи", `Вебхук ${org} подключён к Senko Assistant. Проверил(а): ${p.nick || p.login}.`, 0x2e7d4f);
    return r === true ? { ok: true, msg: "Сообщение отправлено в Discord." } : fail("Не получилось: " + r + ". Проверьте ссылку вебхука.");
  }
  if (op === "del") {
    await sql`delete from org_hooks where org = ${org} and server = ${srv}`;
    await audit(label, "hook", org, { deleted: true });
    return out();
  }
  return fail("Неизвестное действие.");
}

// ───────────── 2.4: мероприятия организаций ─────────────
const evOut = (e, p) => ({ id: String(e.id), org: e.org, title: e.title, body: e.body, place: e.place, at: e.starts_at, author: e.author, mine: !!p && e.author === (p.nick || p.login) });
async function eventsFor(org, days = 14, server = DEFAULT_SERVER) {
  return db()`select * from org_events where org = ${org} and server = ${server} and starts_at > now() - interval '3 hours' and starts_at < now() + make_interval(days => ${days})
              order by starts_at limit 20`;
}
async function eventsApi(b) {
  const op = String(b.op || "list");
  const staff = op !== "list" || b.org;
  const { p, err } = await who(b, staff ? ["leader", "moderator", "owner"] : undefined);
  if (err) return err;
  const org = staff ? staffOrg(p, b) : p.org;
  if (!org) return fail("Выберите организацию.");
  const srv = staff ? staffSrv(p, b) : sv(p);
  const sql = db();
  if (op === "list") return { ok: true, org, server: srv, events: (await eventsFor(org, 60, srv)).map((e) => evOut(e, p)) };
  if (!(await hit(`ev:${p.id}`, 40, 3600))) return fail(RATE_MSG, { code: "rate" });
  if (op === "create") {
    const title = clean(b.title, 80);
    if (title.length < 3) return fail("Напишите название мероприятия.");
    const at = new Date(String(b.at || ""));
    if (isNaN(at.getTime()) || at.getTime() < Date.now() - 60e3) return fail("Укажите дату и время в будущем.");
    if (at.getTime() > Date.now() + 90 * 864e5) return fail("Не дальше чем на 90 дней вперёд.");
    const [{ n }] = await sql`select count(*)::int n from org_events where org = ${org} and server = ${srv} and starts_at > now()`;
    if (n >= 30) return fail("Запланировано уже 30 мероприятий, удалите лишние.");
    const [e] = await sql`insert into org_events (org, server, title, body, place, starts_at, author)
                          values (${org}, ${srv}, ${title}, ${cleanText(b.body, 600)}, ${clean(b.place, 80)}, ${at}, ${p.nick || p.login}) returning *`;
    await audit(`${p.login} (${RANKS[p.rank]})`, "event", org, { id: String(e.id), title });
    await postHook(org, srv, "event", "📅 Новое мероприятие: " + title, evText(e), 0x3b82f6);
    return { ok: true, events: (await eventsFor(org, 60, srv)).map((x) => evOut(x, p)) };
  }
  if (op === "del") {
    const id = parseInt(b.id, 10) || 0;
    const [e] = await sql`delete from org_events where id = ${id} and org = ${org} and server = ${srv} returning *`;
    if (!e) return fail("Мероприятие не найдено.");
    await audit(`${p.login} (${RANKS[p.rank]})`, "event", org, { id: String(id), deleted: true });
    if (e.starts_at > new Date()) await postHook(org, srv, "event", "🚫 Мероприятие отменено: " + e.title, evText(e), 0xb3261e);
    return { ok: true, events: (await eventsFor(org, 60, srv)).map((x) => evOut(x, p)) };
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
    const rows = await sql`select tg_id from profiles where org = ${e.org} and server = ${e.server || DEFAULT_SERVER} and tg_id is not null and not banned and approval = 'ok' limit 150`;
    for (const r of rows) await send(String(r.tg_id), text, { disable_notification: false });
    await postHook(e.org, e.server || DEFAULT_SERVER, "event", "⏰ Через час: " + e.title, evText(e), 0xf59e0b);
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
    const [dup] = await sql`select id from ideas where lower(text) = lower(${text}) limit 1`;
    if (dup) return fail(`Такая идея уже есть (№${dup.id}). Проголосуйте за неё.`, { code: "dup" });
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
// ───────────── 3.8.3: итоги месяца, рекорды, опрос, план на месяц, счётчик скачиваний ─────────────
const MON_N = ["январь", "февраль", "март", "апрель", "май", "июнь", "июль", "август", "сентябрь", "октябрь", "ноябрь", "декабрь"];
const MON_G = ["января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября", "октября", "ноября", "декабря"];
// месяц по Москве: "2026-10" или пусто — прошлый месяц
function monthOf(m) {
  let y, mo;
  const mm = /^(\d{4})-(\d{2})$/.exec(String(m || ""));
  if (mm) { y = +mm[1]; mo = +mm[2]; } else {
    const d = new Date(Date.now() + 3 * 3600e3);
    y = d.getUTCFullYear(); mo = d.getUTCMonth();
    if (mo === 0) { y--; mo = 12; }
  }
  if (!(mo >= 1 && mo <= 12 && y >= 2025 && y <= 2100)) return null;
  const start = Date.UTC(y, mo - 1, 1) - 3 * 3600e3, end = Date.UTC(y, mo, 1) - 3 * 3600e3;
  if (start > Date.now()) return null;
  return { key: `${y}-${String(mo).padStart(2, "0")}`, y, mo, start, end, name: MON_N[mo - 1], gen: MON_G[mo - 1] };
}
// опыт, заработанный за месяц: по отметкам начала недель (xp_week) — от недели, в которую попало 1-е число, до недели после конца месяца
async function monthXp(people, M) {
  const ids = people.map((p) => p.id);
  if (!ids.length) return {};
  const sql = db();
  const k0 = mskDay(new Date(M.start + 3 * 3600e3)), k1 = mskDay(new Date(M.end + 3 * 3600e3));
  const bs = await sql`select user_id, week, base from xp_week where user_id = any(${ids}::uuid[]) order by week`;
  const xs = await sql`select user_id, coalesce(max(senko_num(data#>>'{}')), 0)::int xp from sync_items where kind = 'xp' and not deleted and user_id = any(${ids}::uuid[]) group by user_id`;
  const X = {}, B = {}, out = {};
  xs.forEach((r) => (X[r.user_id] = r.xp));
  bs.forEach((r) => (B[r.user_id] = B[r.user_id] || []).push(r));
  for (const p of people) {
    const L = B[p.id] || [];
    let b0 = null, b1 = null;
    for (const r of L) { if (r.week <= k0) b0 = r.base; if (r.week >= k1 && b1 == null) b1 = r.base; }
    if (b0 == null) {
      const f = L.find((r) => r.week > k0 && r.week < k1);
      b0 = f ? f.base : (tsOf(p.created_at) >= M.start && tsOf(p.created_at) < M.end ? 0 : null);
    }
    const now = X[p.id] || 0;
    out[p.id] = b0 == null ? 0 : Math.max(0, (b1 == null ? now : b1) - b0);
  }
  return out;
}
// задержания, тесты и средний балл за месяц
async function monthAct(ids, M) {
  if (!ids.length) return {};
  const rows = await db()`
    select user_id,
           count(*) filter (where kind = 'thist' and coalesce(senko_num(data->>'end'), u) >= ${M.start} and coalesce(senko_num(data->>'end'), u) < ${M.end})::int det,
           count(*) filter (where kind = 'tests' and senko_num(data->>'t') >= ${M.start} and senko_num(data->>'t') < ${M.end})::int tests,
           round(avg(senko_num(data->>'p')) filter (where kind = 'tests' and senko_num(data->>'t') >= ${M.start} and senko_num(data->>'t') < ${M.end}))::int avg_p
    from sync_items where not deleted and kind in ('thist', 'tests') and user_id = any(${ids}::uuid[]) group by user_id`;
  const o = {};
  rows.forEach((r) => (o[r.user_id] = r));
  return o;
}
// смены ведомства за месяц и сколько раз каждый был в сети во время смены
async function monthShifts(M, org = null, server = null) {
  const sql = db();
  const rows = await sql`select org, server, summary from shifts where started_at >= to_timestamp(${M.start / 1000}) and started_at < to_timestamp(${M.end / 1000})
                          ${org ? sql`and org = ${org}` : sql``} ${server ? sql`and server = ${server}` : sql``}`;
  const by = {};
  rows.forEach((r) => ((r.summary && Array.isArray(r.summary.online)) ? r.summary.online : []).forEach((x) => { if (x && x.login) by[String(x.login).toLowerCase()] = (by[String(x.login).toLowerCase()] || 0) + 1; }));
  return { n: rows.length, by, rows };
}
const artKey = (s) => String(s || "").trim().replace(/\s+ч\.\s*\S+/, "");
async function monthMe(p, M) {
  const sql = db();
  const [a] = Object.values(await monthAct([p.id], M));
  const xp = (await monthXp([p], M))[p.id] || 0;
  const sh = await monthShifts(M, p.org, sv(p));
  const arts = await sql`select data->>'arts' a from sync_items where user_id = ${p.id} and kind = 'thist' and not deleted
                         and coalesce(senko_num(data->>'end'), u) >= ${M.start} and coalesce(senko_num(data->>'end'), u) < ${M.end}`;
  const C = {};
  arts.forEach((r) => String(r.a || "").split(/,\s*/).map(artKey).filter(Boolean).forEach((k) => (C[k] = (C[k] || 0) + 1)));
  const fav = Object.keys(C).sort((x, y) => C[y] - C[x])[0] || "";
  const got = await sql`select code, at from achievements where user_id = ${p.id} and at >= to_timestamp(${M.start / 1000}) and at < to_timestamp(${M.end / 1000}) order by at`;
  const AX = await getSetting("achx", {});
  const ach = got.map((r) => { const d = ACH_BY[r.code] || AX[r.code]; return d ? { code: r.code, icon: d.icon, name: d.name, desc: d.desc || "", at: r.at } : null; }).filter(Boolean);
  const [bt] = await sql`select 1 from beta_results where user_id = ${p.id} and at >= to_timestamp(${M.start / 1000}) and at < to_timestamp(${M.end / 1000}) limit 1`;
  const [bl] = bt ? [bt] : await sql`select 1 from login_log where user_id = ${p.id} and ver ilike '%beta%' and at >= to_timestamp(${M.start / 1000}) and at < to_timestamp(${M.end / 1000}) limit 1`;
  const [ai] = await sql`select count(*)::int n from ai_log where user_id = ${p.id} and at >= to_timestamp(${M.start / 1000}) and at < to_timestamp(${M.end / 1000})`;
  return {
    ok: true, month: M.key, name: M.name, gen: M.gen, nick: p.nick, org: p.org, server: srvName(sv(p)),
    det: a ? a.det : 0, tests: a ? a.tests : 0, avg_p: a ? a.avg_p : null, xp, shifts: sh.by[String(p.login).toLowerCase()] || 0,
    fav, favN: fav ? C[fav] : 0, ai: ai ? ai.n : 0, ach, tester: !!(bt || bl),
  };
}
async function monthOrg(p, b, M) {
  const org = staffOrg(p, b);
  if (!org) return fail("Выберите организацию.");
  const srv = staffSrvOpt(p, b);
  const sql = db();
  const people = await sql`select id, login, nick, created_at, last_seen from profiles where org = ${org} and ${srv ? sql`server = ${srv}` : sql`true`} and not banned and approval = 'ok'`;
  const ids = people.map((x) => x.id);
  const A = await monthAct(ids, M), X = await monthXp(people, M), sh = await monthShifts(M, org, srv);
  const L = people.map((x) => ({ nick: x.nick, det: (A[x.id] || {}).det || 0, tests: (A[x.id] || {}).tests || 0, avg_p: (A[x.id] || {}).avg_p, xp: X[x.id] || 0, shifts: sh.by[String(x.login).toLowerCase()] || 0 }));
  const active = L.filter((x) => x.det || x.tests || x.xp || x.shifts).length;
  const top = (k, f) => L.filter(f || ((x) => x[k] > 0)).sort((a, c) => c[k] - a[k]).slice(0, 5).map((x) => ({ nick: x.nick, v: x[k] }));
  return {
    ok: true, month: M.key, name: M.name, gen: M.gen, org, server: srv ? srvName(srv) : "все серверы",
    people: people.length, active, fresh: people.filter((x) => tsOf(x.created_at) >= M.start && tsOf(x.created_at) < M.end).length,
    shifts: sh.n, det: L.reduce((s, x) => s + x.det, 0), tests: L.reduce((s, x) => s + x.tests, 0), xp: L.reduce((s, x) => s + x.xp, 0),
    topDet: top("det"), topXp: top("xp"), topShifts: top("shifts"), topTests: top("avg_p", (x) => x.tests >= 3 && x.avg_p != null),
  };
}
// рекорды месяца по проекту — только те, кто включил «Рейтинг недели на сайте» (profiles.pub_board)
async function monthRecords(M) {
  const cache = await getSetting("records_" + M.key, null);
  if (cache && cache.at > Date.now() - 3600e3 && Array.isArray(cache.list)) return cache.list;
  const sql = db();
  const people = await sql`select id, login, nick, org, server, created_at from profiles where pub_board and not banned and approval = 'ok'`;
  const ids = people.map((x) => x.id);
  const A = await monthAct(ids, M), X = await monthXp(people, M), sh = await monthShifts(M);
  const st = ids.length ? await sql`select user_id, max(senko_num(data->>'n'))::int n from sync_items where kind = 'streak' and not deleted and user_id = any(${ids}::uuid[]) group by user_id` : [];
  const S = {};
  st.forEach((r) => (S[r.user_id] = r.n || 0));
  const val = {
    det: (x) => (A[x.id] || {}).det || 0, xp: (x) => X[x.id] || 0, shifts: (x) => sh.by[String(x.login).toLowerCase()] || 0,
    tests: (x) => (A[x.id] || {}).tests || 0, streak: (x) => S[x.id] || 0,
  };
  const T = [["det", "🚓", "Больше всего задержаний"], ["shifts", "🕐", "Больше всего смен"], ["xp", "⭐", "Больше всего опыта"], ["tests", "🎓", "Больше всего тестов"], ["streak", "🔥", "Самая длинная серия дней"]];
  const list = T.map(([k, icon, title]) => {
    const best = people.map((x) => ({ x, v: val[k](x) })).filter((r) => r.v > 0).sort((a, c) => c.v - a.v)[0];
    return best ? { k, icon, title, nick: best.x.nick, org: best.x.org, server: srvName(best.x.server || DEFAULT_SERVER), v: best.v } : null;
  }).filter(Boolean);
  await setSetting("records_" + M.key, { at: Date.now(), list });
  return list;
}
// опрос «что улучшить»: 3 вопроса, один ответ на человека
const SURVEY = {
  id: "2026-11",
  qs: [
    { t: "Что улучшить в первую очередь?", o: ["Поиск статей", "Калькулятор и наказания", "Задержание и чек-лист", "Рапорты и документы", "ИИ-помощник", "Тренажёр и обучение", "Скорость и стабильность", "Оформление"] },
    { t: "Как вам программа в целом?", o: ["1 — плохо", "2", "3", "4", "5 — отлично"] },
    { t: "Чего не хватает? Напишите своими словами (необязательно)", free: true },
  ],
};
// план на месяц: темы ближайших выпусков, за них голосуют «Жду»
const PLAN_NEXT = [
  ["n05", "05.11", "Рация и голос"], ["n06", "06.11", "Калькулятор и наказания"], ["n07", "07.11", "Рапорты и документы"], ["n08", "08.11", "Суд, адвокаты и прокуроры"],
  ["n09", "09.11", "Карта и выезды"], ["n10", "10.11", "Профиль и мотивация"], ["n12", "12.11", "Доступность и оформление"], ["n13", "13.11", "Скорость и офлайн"],
  ["n15", "15.11", "Discord-бот"], ["n16", "16.11", "Наставники и стажёры"], ["n17", "17.11", "Ориентировки и розыск"], ["n18", "18.11", "ИИ-помощник: точность"],
  ["n19", "19.11", "Дорога и транспорт"], ["n20", "20.11", "Работа между ведомствами"], ["n23", "23.11", "Главная под себя"], ["n26", "26.11", "Работа поверх игры"],
  ["n29", "29.11", "Веб-версия на телефоне"],
];
async function planList(uid) {
  const sql = db();
  const cnt = await sql`select item, count(*)::int n from plan_votes group by item`;
  const mine = uid ? await sql`select item from plan_votes where user_id = ${uid}` : [];
  const N = {}, Mi = {};
  cnt.forEach((r) => (N[r.item] = r.n));
  mine.forEach((r) => (Mi[r.item] = true));
  return PLAN_NEXT.map(([id, d, t]) => ({ id, d, t, n: N[id] || 0, mine: !!Mi[id] }));
}
async function monthApi(b) {
  const { p, err } = await who(b);
  if (err) return err;
  if (!(await hit(`mo:${p.id}`, 120, 3600))) return fail(RATE_MSG, { code: "rate" });
  const sql = db();
  const op = String(b.op || "me");
  if (op === "survey_get") {
    const [r] = await sql`select 1 from survey_answers where user_id = ${p.id} and survey = ${SURVEY.id}`;
    return { ok: true, survey: SURVEY, answered: !!r };
  }
  if (op === "survey_send") {
    const a = Array.isArray(b.a) ? b.a : [];
    const q1 = parseInt(a[0], 10), q2 = parseInt(a[1], 10), q3 = clean(a[2], 600);
    if (!(q1 >= 0 && q1 < SURVEY.qs[0].o.length) || !(q2 >= 0 && q2 < 5)) return fail("Ответьте на первые два вопроса.");
    await sql`insert into survey_answers (user_id, survey, answers) values (${p.id}, ${SURVEY.id}, ${sql.json([q1, q2, q3])})
              on conflict (user_id, survey) do update set answers = excluded.answers, at = now()`;
    return { ok: true };
  }
  if (op === "plan") return { ok: true, items: await planList(p.id) };
  if (op === "plan_vote") {
    const id = String(b.id || "");
    if (!PLAN_NEXT.some((x) => x[0] === id)) return fail("Нет такого пункта.");
    if (b.on) await sql`insert into plan_votes (user_id, item) values (${p.id}, ${id}) on conflict do nothing`;
    else await sql`delete from plan_votes where user_id = ${p.id} and item = ${id}`;
    return { ok: true, items: await planList(p.id) };
  }
  const M = monthOf(b.month);
  if (!M) return fail("Неверный месяц.");
  if (op === "me") return monthMe(p, M);
  if (op === "records") return { ok: true, month: M.key, name: M.name, gen: M.gen, list: await monthRecords(M) };
  if (op === "org") {
    if (!["leader", "moderator", "owner"].includes(p.rank)) return fail("Итоги организации видит руководство.");
    return monthOrg(p, b, M);
  }
  return fail("Неизвестное действие.");
}
// скачивания с сайта по дням: кнопка «Скачать» шлёт отметку (без данных о человеке)
async function dlHit(ip) {
  if (!(await hit(`dl:${ip}`, 10, 3600))) return { ok: true };
  await db()`insert into day_counts (day, k, n) values (${mskDay()}::date, 'dl', 1) on conflict (day, k) do update set n = day_counts.n + 1`;
  return { ok: true };
}
// панель владельца: сводка месяца (64) и сравнение организаций (29)
async function ghDownloads() {
  const c = await getSetting("gh_dl", null);
  if (c && c.at > Date.now() - 3600e3) return c.list;
  let list = [];
  try {
    const r = await fetch("https://api.github.com/repos/Kofemanchik/Senko-Assistant/releases?per_page=30", { headers: { "user-agent": "senko-assistant", accept: "application/vnd.github+json" } });
    if (r.ok) list = (await r.json()).map((x) => ({ tag: x.tag_name, at: x.published_at, n: (x.assets || []).filter((a) => /\.exe$/i.test(a.name)).reduce((s, a) => s + (a.download_count || 0), 0) }));
  } catch (e) {}
  if (list.length) await setSetting("gh_dl", { at: Date.now(), list });
  return list.length ? list : (c ? c.list : []);
}
async function panelMonth(b, a) {
  const M = monthOf(b.month);
  if (!M) return fail("Неверный месяц.");
  const sql = db();
  const srv = scopeServer(a) || parseServer(b.server);
  const s0 = new Date(M.start), s1 = new Date(M.end);
  const fresh = await sql`select to_char(created_at + interval '3 hours', 'DD.MM') d, count(*)::int n from profiles where created_at >= ${s0} and created_at < ${s1}
                          ${srv ? sql`and server = ${srv}` : sql``} group by 1 order by 1`;
  const act = await sql`select d, count(distinct user_id)::int n from (
      select to_char(at + interval '3 hours', 'DD.MM') d, user_id from login_log where at >= ${s0} and at < ${s1}
      union all select to_char(at + interval '3 hours', 'DD.MM') d, user_id from ai_log where at >= ${s0} and at < ${s1} and user_id is not null
      union all select to_char(to_timestamp(u / 1000) + interval '3 hours', 'DD.MM') d, user_id from sync_items where u >= ${M.start} and u < ${M.end}
    ) z ${srv ? sql`where user_id in (select id from profiles where server = ${srv})` : sql``} group by d order by d`;
  const [act7] = await sql`select count(distinct user_id)::int n from (
      select user_id from login_log where at >= ${new Date(M.end - 7 * 864e5)} and at < ${s1}
      union all select user_id from sync_items where u >= ${M.end - 7 * 864e5} and u < ${M.end}) z`;
  const [actM] = await sql`select count(distinct user_id)::int n from (
      select user_id from login_log where at >= ${s0} and at < ${s1}
      union all select user_id from sync_items where u >= ${M.start} and u < ${M.end}) z`;
  const ai = await sql`select to_char(at + interval '3 hours', 'DD.MM') d, count(*)::int n from ai_log where at >= ${s0} and at < ${s1}
                       ${srv ? sql`and user_id in (select id from profiles where server = ${srv})` : sql``} group by 1 order by 1`;
  const dl = await sql`select to_char(day, 'DD.MM') d, n from day_counts where k = 'dl' and day >= ${mskDay(new Date(M.start + 3 * 3600e3))}::date and day < ${mskDay(new Date(M.end + 3 * 3600e3))}::date order by day`;
  const sv0 = await sql`select answers from survey_answers where survey = ${SURVEY.id}`;
  const q1 = SURVEY.qs[0].o.map(() => 0), q2 = [0, 0, 0, 0, 0], free = [];
  sv0.forEach((r) => { const x = r.answers || []; if (q1[x[0]] != null) q1[x[0]]++; if (q2[x[1]] != null) q2[x[1]]++; if (x[2]) free.push(String(x[2]).slice(0, 300)); });
  const gh = (await ghDownloads()).filter((x) => { const t = tsOf(x.at); return t >= M.start && t < M.end; });
  return {
    ok: true, month: M.key, name: M.name, gen: M.gen, server: srv ? srvName(srv) : "все серверы",
    fresh, act, ai, dl, act7: act7.n, actM: actM.n, gh,
    survey: { n: sv0.length, qs: SURVEY.qs.map((q) => q.t), q1: SURVEY.qs[0].o.map((t, i) => ({ t, n: q1[i] })), q2, free: free.slice(-40).reverse() },
    plan: (await planList(null)).sort((x, y) => y.n - x.n),
  };
}
async function panelOrgCmp(b, a) {
  const sql = db();
  const srv = scopeServer(a) || parseServer(b.server);
  const now = Date.now();
  const W = { start: now - 7 * 864e5, end: now + 864e5 }, Mo = { start: now - 30 * 864e5, end: now + 864e5 };
  const people = await sql`select id, login, org, last_seen from profiles where not banned and approval = 'ok' ${srv ? sql`and server = ${srv}` : sql``}`;
  const ids = people.map((x) => x.id);
  const AW = await monthAct(ids, W), AM = await monthAct(ids, Mo);
  const shW = await sql`select org, count(*)::int n from shifts where started_at > now() - interval '7 days' ${srv ? sql`and server = ${srv}` : sql``} group by org`;
  const shM = await sql`select org, count(*)::int n from shifts where started_at > now() - interval '30 days' ${srv ? sql`and server = ${srv}` : sql``} group by org`;
  const SW = {}, SM = {};
  shW.forEach((r) => (SW[r.org] = r.n));
  shM.forEach((r) => (SM[r.org] = r.n));
  const rows = DEPTS.map((org) => {
    const P = people.filter((x) => x.org === org);
    const sum = (A, k) => P.reduce((s, x) => s + ((A[x.id] || {})[k] || 0), 0);
    const seen = (ms) => P.filter((x) => tsOf(x.last_seen) > now - ms).length;
    const tw = sum(AW, "tests"), tm = sum(AM, "tests");
    const avg = (A) => { const L = P.map((x) => A[x.id]).filter((r) => r && r.tests && r.avg_p != null); return L.length ? Math.round(L.reduce((s, r) => s + r.avg_p, 0) / L.length) : null; };
    return { org, people: P.length, act7: seen(7 * 864e5), act30: seen(30 * 864e5), shW: SW[org] || 0, shM: SM[org] || 0, detW: sum(AW, "det"), detM: sum(AM, "det"), testsW: tw, testsM: tm, avgW: avg(AW), avgM: avg(AM) };
  });
  return { ok: true, server: srv ? srvName(srv) : "все серверы", rows };
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
  // 3.8.1: ссылка на экипаж — кто зовёт и сколько людей, до вступления
  if (op === "peek") {
    if (!(await hit(`ptp:${p.id}`, 60, 3600))) return fail(RATE_MSG, { code: "rate" });
    const code = patrolCode(b.code);
    const [t] = code.length === 6 ? await sql`select t.code, pr.nick, pr.static_id, pr.org from patrols t left join profiles pr on pr.id = t.owner_id where t.code = ${code} and t.expires_at > now()` : [];
    if (!t) return fail("Экипаж с таким кодом не найден или уже закончил смену.");
    const [{ n }] = await sql`select count(*)::int n from patrol_members where code = ${code}`;
    const [me] = await sql`select 1 from patrol_members where code = ${code} and user_id = ${p.id}`;
    return { ok: true, code, nick: t.nick || "", static: t.static_id || "", org: t.org || "", members: n, max: PATROL_MAX, already: !!me };
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
  const lawsBy = {};
  for (const id of Object.keys(SERVERS).map(Number)) {
    const nm = id === DEFAULT_SERVER ? "Обновление законов с форума" : `Законы: ${SERVERS[id].name}`;
    try {
      const r = await fetch(lawsStatusUrl(id) + "?t=" + Date.now(), { signal: AbortSignal.timeout(6000) });
      if (r.status === 404 && id !== DEFAULT_SERVER) continue; // сервер ещё не подключён к сбору законов
      const j = await r.json();
      const one = { checkedAt: j.checkedAt || 0, updatedAt: j.updatedAt || 0, count: j.count || 0 };
      lawsBy[id] = one;
      if (id === DEFAULT_SERVER) laws = one; // поле laws оставлено для старых версий программы и сайта
      S.push({ k: id === DEFAULT_SERVER ? "laws" : "laws" + id, name: nm, ok: !!j.ok && Date.now() - j.checkedAt < 36 * 3600e3 });
    } catch (e) {
      S.push({ k: id === DEFAULT_SERVER ? "laws" : "laws" + id, name: nm, ok: false });
    }
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
  const r = { ok: true, at: Date.now(), services: S, laws, lawsBy, maintenance: m.on ? { on: true, text: m.text || "" } : { on: false } };
  statusCache = { at: Date.now(), r };
  return r;
}

// 2.4: панель — бета-тестеры, задания, флаги функций, идеи
async function panelBeta(b, a) {
  const sql = db();
  const op = b.op;
  if (op === "beta_list") {
    const users = await sql`select p.login, p.nick, p.org, p.server, p.rank, p.last_seen, p.app_version,
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
const lawsCaches = new Map(); // номер сервера → { sig, updatedAt, count, gz, at, checkedAt, ok }
const lawsStatusAt = new Map();
async function lawsDecrypt(buf) {
  if (buf.length < 32 || String.fromCharCode(...buf.subarray(0, 4)) !== "SLW1") throw new Error("неверный формат файла законов");
  const key = await crypto.subtle.importKey("raw", await crypto.subtle.digest("SHA-256", enc.encode(LAWS_KEY)), "AES-GCM", false, ["decrypt"]);
  const data = new Uint8Array(buf.length - 16);
  data.set(buf.subarray(32), 0);
  data.set(buf.subarray(16, 32), buf.length - 32); // WebCrypto ждёт тег в конце
  return new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: buf.subarray(4, 16) }, key, data));
}
async function lawsLoad(server, want) {
  // want: подпись, которую программа уже видит в laws-status.json; если копия старее, сверяемся раньше (не чаще раза в 30 с)
  const cache = lawsCaches.get(server) || null;
  const fresh = Date.now() - (lawsStatusAt.get(server) || 0) < (want && cache && want !== cache.sig ? 30 * 1000 : 5 * 60 * 1000);
  if (cache && fresh) return cache;
  let st = null;
  try {
    const r = await fetch(LAWS_BASE + "laws-status" + lawsSfx(server) + ".json?t=" + Date.now(), { signal: AbortSignal.timeout(15000) });
    if (r.ok) st = await r.json();
  } catch (e) {}
  lawsStatusAt.set(server, Date.now());
  if (cache && (!st || st.sig === cache.sig)) return cache;
  const r = await fetch(LAWS_BASE + "laws" + lawsSfx(server) + ".enc?t=" + Date.now(), { signal: AbortSignal.timeout(60000) });
  if (r.status === 404) {
    const e = new Error("законы сервера " + server + " ещё не собраны");
    e.none = true;
    throw e;
  }
  if (!r.ok) throw new Error("GitHub вернул " + r.status);
  const buf = new Uint8Array(await r.arrayBuffer());
  const gz = await lawsDecrypt(buf);
  const c = { sig: (st && st.sig) || (await sha256(b64(gz.subarray(0, 4096)))).slice(0, 40), updatedAt: (st && st.updatedAt) || 0, checkedAt: (st && st.checkedAt) || 0, ok: st ? st.ok !== false : true, gz, at: Date.now() };
  lawsCaches.set(server, c);
  return c;
}
// Сервер берётся из профиля игрока (b.server игнорируется: законы чужого сервера не выдаём)
async function lawsApi(b) {
  const { p, err } = await who(b);
  if (err) return err;
  if (!LAWS_KEY) return fail("Законы с форума на сервере ещё не подключены. Сообщите владельцу.", { code: "laws_off" });
  const server = sv(p);
  let L;
  try {
    L = await lawsLoad(server, b.want ? String(b.want).slice(0, 80) : "");
  } catch (e) {
    if (e && e.none) return fail(`Законы сервера ${srvName(server)} ещё не собраны с форума. Пока показаны законы Boston.`, { code: "laws_none", server });
    console.error("laws", e);
    return fail("Не удалось получить законы. Попробуйте позже.", { code: "server" });
  }
  const meta = { server, sig: L.sig, updatedAt: L.updatedAt, checkedAt: L.checkedAt, srcOk: L.ok };
  if (b.sig && String(b.sig) === L.sig) return { ok: true, same: true, ...meta };
  if (b.plain) {
    const text = await new Response(new Blob([L.gz]).stream().pipeThrough(new DecompressionStream("gzip"))).text();
    return { ok: true, ...meta, data: JSON.parse(text) };
  }
  return { ok: true, ...meta, gz: b64(L.gz) };
}

// ───────────── 4.3: суд, адвокаты и прокуроры ─────────────
// Дела (167), решения суда (170), ордера (172), заседания (173), жребий судьи (227), судьи и Председатель Верховного суда,
// закон на любую дату (97, по истории файлов законов в репозитории).
const JUDGE_POS = { district: "Окружной судья", appeal: "Апелляционный судья", supreme: "Верховный судья", assistant: "Помощник судьи", secretary: "Секретарь суда" };
const JUDGE_SEAT = ["district", "appeal", "supreme"]; // кто может вести дело и выдавать ордера
const CASE_KIND = { crim: "Уголовное", admin: "Административное", civil: "Гражданское" };
const WAR_KIND = { search: "Ордер на обыск", arrest: "Ордер на арест", wiretap: "Ордер на прослушивание", seize: "Ордер на выемку" };
const isStaff = (p) => ["moderator", "owner"].includes(p.rank);
const isGov = (p) => p.org === GOV_ORG || isStaff(p);
const isJudge = (p) => JUDGE_SEAT.includes(p.judge_pos || "");
const govLead = (p) => (p.rank === "leader" && p.org === GOV_ORG) || isStaff(p);
const cleanArr = (a, n, f) => (Array.isArray(a) ? a : []).slice(0, n).map(f).filter(Boolean);
function caseOut(r, v) {
  const ns = r.notes_side || {}, role = v ? v.game_role || "off" : "", all = !!v && (isJudge(v) || govLead(v) || !!v.pvs);
  return {
    stage: r.stage || "filed", stageName: CASE_STAGE[r.stage || "filed"] || r.stage, mat: matClean(r.mat), log: (r.log || []).slice(-80), recusals: r.recusals || [], level: r.level || "",
    appealOf: r.appeal_of ? String(r.appeal_of) : "", mergedInto: r.merged_into ? String(r.merged_into) : "", closedAt: r.closed_at,
    notesPros: all || role === "pros" ? ns.pros || "" : null, notesDef: all || role === "adv" ? ns.def || "" : null,
    id: String(r.id), no: String(r.no || r.id).padStart(4, "0"), title: r.title, kind: r.kind, kindName: CASE_KIND[r.kind] || r.kind, status: r.status,
    parties: r.parties || [], arts: r.arts || "", evidence: r.evidence || [], hearings: r.hearings || [], notes: r.notes || "",
    judge: r.judge || "", judgeLogin: r.judge_login || "", draw: r.draw || null, panel: r.panel || [], author: r.author || "", authorLogin: r.author_login || "",
    created: r.created_at, updated: r.updated_at,
  };
}
const warOut = (r) => ({ id: String(r.id), no: r.no ? String(r.no).padStart(4, "0") : "", uses: r.uses || [], kind: r.kind, kindName: WAR_KIND[r.kind] || r.kind, target: r.target, reason: r.reason, caseNo: r.case_no || "", status: r.status,
  until: r.valid_until, by: r.issued_by || "", author: r.author || "", org: r.org || "", answer: r.answer || "", created: r.created_at,
  active: r.status === "ok" && (!r.valid_until || tsOf(r.valid_until) > Date.now()), revoked: r.status === "rev" });
async function courtApi(b) {
  const { p, err } = await who(b);
  if (err) return err;
  const sql = db();
  const op = String(b.op || "me");
  const srv = isStaff(p) ? parseServer(b.server) || sv(p) : sv(p);
  const me = { judgePos: p.judge_pos || "", judgeName: JUDGE_POS[p.judge_pos] || "", pvs: !!p.pvs, gov: isGov(p), lead: govLead(p), judge: isJudge(p), gameRole: p.game_role || "off" };
  if (op === "me") return { ok: true, ...me, positions: JUDGE_POS, kinds: CASE_KIND, warKinds: WAR_KIND, sesRoles: SES_ROLE };
  if (op.startsWith("ses_")) return await sesApi(p, b, op, srv);
  if (op.startsWith("adv_") || op === "war_check") { const r = await advApi(p, b, op, srv); if (r) return r; }
  // ── ордера: список видят все сотрудники сервера (полиции важно знать, какие ордера действуют) ──
  if (op === "war_list") {
    const rows = await sql`select * from warrants where server = ${srv} and (status not in ('no', 'rev') or created_at > now() - interval '3 days')
                             and (valid_until is null or valid_until > now() - interval '7 days') order by (status = 'req') desc, created_at desc limit 200`;
    return { ok: true, ...me, list: rows.map(warOut) };
  }
  if (op === "war_req") {
    if (!(await hit(`war:${p.id}`, 20, 3600))) return fail(RATE_MSG, { code: "rate" });
    const kind = WAR_KIND[b.kind] ? b.kind : "search", target = clean(b.target, 120), reason = clean(b.reason, 1200);
    if (!target || reason.length < 10) return fail("Укажите, на кого или что нужен ордер, и основание (не короче 10 знаков).");
    const [r] = await sql`insert into warrants (server, no, kind, target, reason, case_no, status, author_id, author, org)
                          values (${srv}, (select coalesce(max(no), 0) + 1 from warrants where server = ${srv}), ${kind}, ${target}, ${reason}, ${clean(b.caseNo, 20)}, 'req', ${p.id}, ${p.nick || p.login}, ${p.org || ""}) returning *`;
    try {
      const js = await sql`select id from profiles where server = ${srv} and judge_pos = any(${JUDGE_SEAT}) and not banned and approval = 'ok' limit 30`;
      for (const j of js) await sql`insert into broadcasts (user_id, title, author, text, expires_at) values (${j.id}, ${"📜 Запрос ордера"}, ${p.nick || p.login},
                ${`${WAR_KIND[kind]}: ${target}. Основание: ${reason.slice(0, 300)}. Решение — в разделе «Суд» → «Ордера».`}, now() + interval '2 days')`;
    } catch (e) {}
    return { ok: true, ...me, item: warOut(r) };
  }
  if (op === "war_decide") {
    if (!isJudge(p) && !govLead(p)) return fail("Ордер выдаёт судья (окружной, апелляционный или верховный).");
    const ok = !!b.ok, hours = Math.min(168, Math.max(1, parseInt(b.hours, 10) || 24));
    const [r] = await sql`update warrants set status = ${ok ? "ok" : "no"}, issued_by = ${(JUDGE_POS[p.judge_pos] ? JUDGE_POS[p.judge_pos] + " " : "") + (p.nick || p.login)},
                            valid_until = ${ok ? new Date(Date.now() + hours * 3600e3) : null}, answer = ${clean(b.note, 300)}, decided_at = now()
                          where id = ${parseInt(b.id, 10) || 0} and server = ${srv} and status = 'req' returning *`;
    if (!r) return fail("Запрос не найден или уже рассмотрен.");
    await audit(p.login, "warrant", "", { id: String(r.id), ok });
    if (ok) courtHook(srv, "📜 Выдан ордер №" + String(r.no || r.id).padStart(4, "0"), `${WAR_KIND[r.kind]}: ${r.target}\nВыдал: ${r.issued_by}\nДействует до ${new Date(tsOf(r.valid_until)).toLocaleString("ru-RU", { timeZone: "Europe/Moscow" })} (МСК)`);
    if (r.author_id) await sql`insert into broadcasts (user_id, title, author, text, expires_at) values (${r.author_id}, ${ok ? "📜 Ордер выдан" : "📜 В ордере отказано"}, ${p.nick || p.login},
              ${`${WAR_KIND[r.kind]}: ${r.target}. ${ok ? "Действует до " + new Date(tsOf(r.valid_until)).toLocaleString("ru-RU", { timeZone: "Europe/Moscow" }) + " (МСК)." : "Отказано."}${r.answer ? " Комментарий: " + r.answer : ""}`}, now() + interval '3 days')`;
    return { ok: true, ...me, item: warOut(r) };
  }
  if (op === "war_del") {
    const [r] = await sql`delete from warrants where id = ${parseInt(b.id, 10) || 0} and server = ${srv} and (author_id = ${p.id} and status = 'req' or ${govLead(p)}) returning id`;
    return r ? { ok: true } : fail("Удалить можно свой запрос, пока его не рассмотрели.");
  }
  // ── 228: тренажёр судьи — серия верных решений; за 5 подряд достижение «Беспристрастный» ──
  if (op === "trainer") {
    if (!(await hit(`jtr:${p.id}`, 120, 3600))) return fail(RATE_MSG, { code: "rate" });
    const key = `jtr:${p.id}`, cur = await getSetting(key, { n: 0, best: 0, total: 0, ok: 0 });
    const n = b.ok ? cur.n + 1 : 0;
    const st = { n, best: Math.max(cur.best || 0, n), total: (cur.total || 0) + 1, ok: (cur.ok || 0) + (b.ok ? 1 : 0) };
    await setSetting(key, st);
    let ach = null;
    if (n >= 5) {
      const got = await sql`insert into achievements (user_id, code) values (${p.id}, 'judge5') on conflict do nothing returning code`;
      if (got.length) { ach = ACH_BY.judge5; try { await achNotice(p, ach, "Тренажёр судьи"); } catch (e) {} }
    }
    return { ok: true, ...st, ach: ach ? { icon: ach.icon, name: ach.name } : null };
  }
  // ── 97: закон на дату — берём файл законов из истории репозитория ──
  if (op === "law_at") return await lawAt(p, b);
  if (!isGov(p)) return fail("Раздел «Суд» — для сотрудников Government.");
  { const r2 = await court2(p, b, op, srv, me); if (r2) return r2; }
  // ── дела ──
  const canEdit = (r) => r.author_id === p.id || r.judge_login === p.login || govLead(p) || p.pvs;
  if (op === "case_list") {
    const q = clean(b.q, 60).toLowerCase();
    const rows = await sql`select * from court_cases where server = ${srv} and (${b.status || ""} = '' or status = ${b.status || ""}) and (${b.stage || ""} = '' or stage = ${b.stage || ""})
                           and (${q} = '' or lower(title || ' ' || arts || ' ' || parties::text || ' ' || coalesce(judge, '')) like ${"%" + q + "%"}) order by status, updated_at desc limit 200`;
    return { ok: true, ...me, list: rows.map(caseOut) };
  }
  if (op === "case_get") {
    const [r] = await sql`select * from court_cases where id = ${parseInt(b.id, 10) || 0} and server = ${srv}`;
    return r ? { ok: true, ...me, item: caseOut(r, p), canEdit: canEdit(r) } : fail("Дело не найдено.");
  }
  if (op === "case_save") {
    if (!(await hit(`case:${p.id}`, 60, 3600))) return fail(RATE_MSG, { code: "rate" });
    const title = clean(b.title, 120);
    if (title.length < 3) return fail("Назовите дело: например, «Государство против John Doe».");
    const kind = CASE_KIND[b.kind] ? b.kind : "crim", status = b.status === "closed" ? "closed" : "open";
    const parties = cleanArr(b.parties, 12, (x) => (x && clean(x.name, 80) ? { role: clean(x.role, 30) || "Сторона", name: clean(x.name, 80), note: clean(x.note, 120) } : null));
    const evidence = cleanArr(b.evidence, 30, (x) => (x && clean(x.t, 200) ? { t: clean(x.t, 200), url: /^https?:\/\//.test(String(x.url || "")) ? clean(x.url, 300) : "", adm: ADM[x.adm] != null ? x.adm : "", admWhy: clean(x.admWhy, 200) } : null));
    const stage = CASE_STAGE[b.stage] ? b.stage : "filed";
    const hearings = cleanArr(b.hearings, 20, (x) => (x && Date.parse(x.at) ? { id: clean(x.id, 12) || Math.random().toString(36).slice(2, 8), at: new Date(Date.parse(x.at)).toISOString(), place: clean(x.place, 80), note: clean(x.note, 160) } : null))
      .sort((a, c) => Date.parse(a.at) - Date.parse(c.at));
    const arts = clean(b.arts, 300), notes = String(b.notes == null ? "" : b.notes).slice(0, 4000);
    if (b.id) {
      const [r0] = await sql`select * from court_cases where id = ${parseInt(b.id, 10) || 0} and server = ${srv}`;
      if (!r0) return fail("Дело не найдено.");
      if (!canEdit(r0)) return fail("Менять дело могут автор, судья по делу и руководство Government.");
      const [r] = await sql`update court_cases set title = ${title}, kind = ${kind}, status = ${status}, stage = ${stage}, parties = ${sql.json(parties)}, arts = ${arts},
                            evidence = ${sql.json(evidence)}, hearings = ${sql.json(hearings)}, notes = ${notes}, updated_at = now(),
                            closed_at = ${status === "closed" ? r0.closed_at || new Date() : null} where id = ${r0.id} returning *`;
      const by = p.nick || p.login, no4 = String(r.no).padStart(4, "0");
      if ((r0.stage || "filed") !== stage) await caseLog(r.id, "Этап: " + CASE_STAGE[stage], by);
      if (r0.status !== status) await caseLog(r.id, status === "closed" ? "Дело закрыто" : "Дело открыто снова", by);
      for (const x of evidence) { const o = (r0.evidence || []).find((y) => y.t === x.t); if (x.adm && (!o || o.adm !== x.adm)) await caseLog(r.id, `Доказательство «${x.t.slice(0, 60)}»: ${ADM[x.adm]}`, by); }
      const newH = hearings.filter((x) => !(r0.hearings || []).some((y) => y.at === x.at));
      for (const x of newH) { await caseLog(r.id, "Назначено заседание: " + new Date(Date.parse(x.at)).toLocaleString("ru-RU", { timeZone: "Europe/Moscow" }), by); courtHook(srv, "📅 Заседание по делу №" + no4, `${r.title}\n${new Date(Date.parse(x.at)).toLocaleString("ru-RU", { timeZone: "Europe/Moscow" })} (МСК)${x.place ? " · " + x.place : ""}`); }
      // 42: при закрытии дела действующие ордера по нему отзываются
      if (status === "closed" && r0.status !== "closed") {
        const rv = await sql`update warrants set status = 'rev', answer = ${"отозван: дело №" + no4 + " закрыто"} where server = ${srv} and case_no = ${no4} and status in ('ok', 'req') returning id`;
        if (rv.length) await caseLog(r.id, "Отозвано ордеров: " + rv.length, by);
      }
      return { ok: true, ...me, item: caseOut(r, p), canEdit: true };
    }
    const [r] = await sql`insert into court_cases (server, no, title, kind, status, stage, parties, arts, evidence, hearings, notes, author_id, author, author_login, mat)
                          values (${srv}, (select coalesce(max(no), 0) + 1 from court_cases where server = ${srv}), ${title}, ${kind}, 'open', ${stage}, ${sql.json(parties)}, ${arts},
                                  ${sql.json(evidence)}, ${sql.json(hearings)}, ${notes}, ${p.id}, ${p.nick || p.login}, ${p.login}, ${sql.json(matClean(b.mat))}) returning *`;
    await caseLog(r.id, "Дело заведено" + (b.fromReport ? " по рапорту №" + clean(b.fromReport, 20) : ""), p.nick || p.login);
    courtHook(srv, "📁 Новое дело №" + String(r.no).padStart(4, "0"), `${r.title}${r.arts ? "\nСтатьи: " + r.arts : ""}\nЗавёл: ${p.nick || p.login}`);
    return { ok: true, ...me, item: caseOut(r, p), canEdit: true };
  }
  if (op === "case_del") {
    const [r] = await sql`delete from court_cases where id = ${parseInt(b.id, 10) || 0} and server = ${srv} and (author_id = ${p.id} or ${govLead(p)} or ${!!p.pvs}) returning id`;
    return r ? { ok: true } : fail("Удалить дело могут автор и руководство Government.");
  }
  // ── 227: жребий — судья выбирается на сервере случайно среди судей на смене; результат сохраняется в деле ──
  if (op === "draw") {
    const [r0] = await sql`select * from court_cases where id = ${parseInt(b.id, 10) || 0} and server = ${srv}`;
    if (!r0) return fail("Дело не найдено.");
    if (r0.draw && !(govLead(p) || p.pvs)) return fail("Судья по делу уже выбран жребием. Повторный жребий может провести только руководство или ПВС.");
    if (!(await hit(`draw:${r0.id}`, 5, 3600))) return fail(RATE_MSG, { code: "rate" });
    const ex = (r0.recusals || []).filter((y) => y.status === "ok").map((y) => y.login);
    const d = await drawJudge(p, r0, srv, ex);
    if (d.err) return fail(d.err);
    return { ok: true, ...me, item: caseOut(d.r, p), canEdit: true };
  }
  // ── 173: ближайшие заседания ──
  if (op === "hearings") {
    const rows = await sql`select id, no, title, judge, panel, hearings from court_cases where server = ${srv} and status = 'open' and jsonb_array_length(hearings) > 0 limit 300`;
    const now = Date.now(), until = now + Math.min(31, Math.max(1, parseInt(b.days, 10) || 14)) * 864e5, out = [];
    for (const r of rows) for (const h of r.hearings || []) {
      const t = Date.parse(h.at);
      if (t > now - 3 * 3600e3 && t < until) out.push({ case: String(r.id), no: String(r.no || r.id).padStart(4, "0"), title: r.title, judge: r.judge || "", panel: (r.panel || []).filter((x) => x.role !== "secretary").map((x) => x.nick), at: h.at, place: h.place || "", note: h.note || "" });
    }
    out.sort((a, c) => Date.parse(a.at) - Date.parse(c.at));
    return { ok: true, ...me, list: out.slice(0, 50) };
  }
  // ── 170: решения суда ──
  if (op === "dec_list") {
    const q = clean(b.q, 80).toLowerCase().replace(/ё/g, "е");
    const rows = await sql`select * from court_decisions where server = ${srv} and (${q} = '' or replace(lower(title || ' ' || case_no || ' ' || arts || ' ' || tags || ' ' || text), 'ё', 'е') like ${"%" + q + "%"})
                           order by dt desc, id desc limit 100`;
    return { ok: true, ...me, canAdd: govLead(p) || !!p.pvs || isJudge(p), list: rows.map(decOut) };
  }
  if (op === "dec_save" || op === "dec_del") {
    if (!(govLead(p) || p.pvs || isJudge(p))) return fail("Справочник решений пополняет руководство Government и судьи.");
    if (op === "dec_del") {
      await sql`delete from court_decisions where id = ${parseInt(b.id, 10) || 0} and server = ${srv}`;
      return { ok: true };
    }
    const title = clean(b.title, 150), text = String(b.text == null ? "" : b.text).trim().slice(0, 6000);
    if (title.length < 3 || text.length < 20) return fail("Нужны название решения и его текст (не короче 20 знаков).");
    const dt = /^\d{4}-\d{2}-\d{2}$/.test(String(b.dt || "")) ? b.dt : mskDay();
    const panel = clean(b.panel, 400), person = clean(b.person, 80), verdict = ["guilty", "acquit", "other"].includes(b.verdict) ? b.verdict : "";
    const term = Math.max(0, parseInt(b.term, 10) || 0), fine = Math.max(0, parseInt(b.fine, 10) || 0);
    const probU = +b.probMonths > 0 ? new Date(Date.now() + Math.min(60, +b.probMonths) * 30 * 864e5) : null;
    const appU = +b.appealDays > 0 ? new Date(Date.now() + Math.min(60, +b.appealDays) * 864e5) : null;
    const caseNo = clean(b.caseNo, 20);
    const [cs] = caseNo ? await sql`select id, no, title from court_cases where server = ${srv} and no = ${parseInt(caseNo, 10) || 0}` : [];
    let r;
    if (b.id) [r] = await sql`update court_decisions set title = ${title}, case_no = ${caseNo}, dt = ${dt}, arts = ${clean(b.arts, 200)}, tags = ${clean(b.tags, 120)}, text = ${text}, panel = ${panel},
                        person = ${person}, verdict = ${verdict}, term = ${term}, fine = ${fine} where id = ${parseInt(b.id, 10) || 0} and server = ${srv} returning *`;
    else {
      [r] = await sql`insert into court_decisions (server, no, title, case_no, case_id, dt, arts, tags, text, author, panel, person, verdict, term, fine, probation_until, appeal_until, exec_status)
                     values (${srv}, (select coalesce(max(no), 0) + 1 from court_decisions where server = ${srv}), ${title}, ${caseNo}, ${cs ? cs.id : null}, ${dt}, ${clean(b.arts, 200)}, ${clean(b.tags, 120)}, ${text},
                             ${p.nick || p.login}, ${panel}, ${person}, ${verdict}, ${term}, ${fine}, ${probU}, ${appU}, ${verdict === "guilty" ? "pending" : "done"}) returning *`;
      if (cs) { await sql`update court_cases set stage = 'heard', updated_at = now() where id = ${cs.id}`; await caseLog(cs.id, "Вынесено решение №" + String(r.no).padStart(4, "0"), p.nick || p.login); }
      courtHook(srv, "⚖ Решение №" + String(r.no).padStart(4, "0"), `${title}${caseNo ? "\nДело №" + caseNo : ""}${panel ? "\nСостав суда: " + panel : ""}`);
    }
    return { ok: true, item: r ? decOut(r) : null };
  }
  // ── судьи: Председатель Верховного суда одобряет заявки и назначает должности ──
  if (op === "judges" || op === "judge_set" || op === "pvs_set") {
    const canJ = !!p.pvs || isStaff(p);
    if (op === "pvs_set") {
      if (!govLead(p)) return fail("Назначает Председателя Верховного суда руководство Government или владелец.");
      const login = clean(b.login, 40).toLowerCase();
      const [u] = await sql`update profiles set pvs = ${!!b.on} where (lower(login) = ${login} or lower(nick) = ${login}) and org = ${GOV_ORG} and server = ${srv} returning id, login, nick`;
      if (!u) return fail("Сотрудник Government с таким логином или ником не найден на этом сервере.");
      await audit(p.login, "pvs_set", u.login, { on: !!b.on });
      if (b.on) await sql`insert into broadcasts (user_id, title, author, text, expires_at) values (${u.id}, ${"⚖ Вы — Председатель Верховного суда"}, ${p.nick || p.login},
                 ${"Вам открыт раздел «Суд» → «Судьи»: одобрение заявок судей и назначение должностей."}, now() + interval '7 days')`;
    }
    if (!canJ && !govLead(p)) return fail("Список судей ведёт Председатель Верховного суда.");
    if (op === "judge_set") {
      if (!canJ) return fail("Заявки судей одобряет Председатель Верховного суда.");
      const pos = JUDGE_POS[b.pos] ? b.pos : "";
      const [u0] = await sql`select * from profiles where id = ${b.id} and server = ${srv} and org = ${GOV_ORG}`;
      if (!u0) return fail("Сотрудник не найден.");
      if (b.reject) {
        await sql`update profiles set approval = case when approval = 'pending' then 'rejected' else approval end, judge_pos = '', game_role = 'off' where id = ${u0.id}`;
      } else {
        if (!pos) return fail("Выберите должность.");
        await sql`update profiles set judge_pos = ${pos}, approval = 'ok', game_role = 'judge' where id = ${u0.id}`;
        await sql`insert into broadcasts (user_id, title, author, text, expires_at) values (${u0.id}, ${"⚖ Должность: " + JUDGE_POS[pos]}, ${p.nick || p.login},
                  ${`Председатель Верховного суда ${u0.approval === "pending" ? "одобрил вашу заявку и " : ""}назначил вас: ${JUDGE_POS[pos]}. В программе доступна роль «Судья».`}, now() + interval '7 days')`;
      }
      await audit(p.login, "judge_set", u0.login, { pos, reject: !!b.reject });
    }
    const rows = await sql`select id, login, nick, static_id, judge_pos, approval, pvs, last_seen, created_at, game_role, judge_exam from profiles
                           where server = ${srv} and org = ${GOV_ORG} and not banned and (judge_pos <> '' or pvs or game_role = 'judge') order by approval desc, lower(nick) limit 200`;
    return { ok: true, ...me, canJ, list: rows.map((r) => ({ id: r.id, login: r.login, nick: r.nick, static: r.static_id, pos: r.judge_pos, posName: JUDGE_POS[r.judge_pos] || "",
      pending: r.approval === "pending", rejected: r.approval === "rejected", pvs: !!r.pvs, seen: r.last_seen, created: r.created_at, exam: r.judge_exam || null })) };
  }
  return fail("Неизвестное действие.");
}
// ───────────── 4.3.5: судебная власть — материалы дела, этапы, отводы, апелляция, реестр решений, адвокаты, надзор ─────────────
const CASE_STAGE = { filed: "Подано", accepted: "Принято к производству", scheduled: "Назначено", heard: "Рассмотрено", appealed: "Обжаловано", executed: "Исполнено", suspended: "Приостановлено" };
const ARG_MARK = { "": "без оценки", ok: "обоснован", part: "частично обоснован", no: "необоснован" };
const MOT_DEC = { wait: "ожидает решения", ok: "удовлетворено", part: "удовлетворено частично", no: "отклонено", later: "отложено" };
const ADM = { "": "не оценено", ok: "допустимо", no: "недопустимо" };
const AI_MODES = ["court", "judge", "summary", "check", "vcheck", "motive", "appeal", "questions", "rpcheck", "wcheck", "spar", "citizen"];
function matClean(m) {
  m = m && typeof m === "object" ? m : {};
  const id = (x) => (/^[\w-]{1,16}$/.test(String(x || "")) ? String(x) : Math.random().toString(36).slice(2, 9));
  return {
    args: cleanArr(m.args, 60, (x) => (x && clean(x.t, 600) ? { id: id(x.id), side: clean(x.side, 40) || "Сторона", who: clean(x.who, 60), t: clean(x.t, 600), mark: ARG_MARK[x.mark] != null ? x.mark : "", note: clean(x.note, 300) } : null)),
    persons: cleanArr(m.persons, 40, (x) => (x && clean(x.name, 80) ? { id: id(x.id), role: clean(x.role, 40) || "Участник", name: clean(x.name, 80), info: clean(x.info, 160), present: x.present === true ? true : x.present === false ? false : null, warns: Math.min(9, +x.warns || 0), removed: !!x.removed } : null)),
    motions: cleanArr(m.motions, 60, (x) => (x && clean(x.t, 600) ? { id: id(x.id), who: clean(x.who, 60), t: clean(x.t, 600), dec: MOT_DEC[x.dec] ? x.dec : "wait", why: clean(x.why, 400), at: +x.at || Date.now() } : null)),
  };
}
async function caseLog(id, text, by) {
  try { await db()`update court_cases set log = (coalesce(log, '[]'::jsonb) || ${db().json([{ at: Date.now(), t: clean(text, 200), by: by || "" }])}) where id = ${id}`; } catch (e) { console.error("case log", e); }
}
// жребий: только судьи нужного уровня на смене, без заявленных отводов; из них — наименее загруженные
async function drawJudge(p, r0, srv, exclude) {
  const sql = db();
  const lvl = r0.level === "appeal" ? ["appeal", "supreme"] : r0.level === "cassation" ? ["supreme"] : JUDGE_SEAT;
  let L = await sql`select login, nick, judge_pos from profiles where server = ${srv} and judge_pos = any(${lvl}) and not banned and approval = 'ok'
                    and last_seen > now() - interval '20 minutes' order by lower(nick) limit 40`;
  L = L.filter((x) => !(exclude || []).includes(x.login));
  if (!L.length) return { err: "Сейчас на смене нет подходящих судей (" + (r0.level === "cassation" ? "верховных" : r0.level === "appeal" ? "апелляционных и верховных" : "окружных, апелляционных, верховных") + "), не заявленных к отводу." };
  const loads = await sql`select judge_login, count(*)::int n from court_cases where server = ${srv} and status = 'open' and judge_login = any(${L.map((x) => x.login)}) group by judge_login`;
  const LD = Object.fromEntries(loads.map((x) => [x.judge_login, x.n]));
  const min = Math.min(...L.map((x) => LD[x.login] || 0));
  const pool = L.filter((x) => (LD[x.login] || 0) === min);
  const rnd = new Uint32Array(1);
  crypto.getRandomValues(rnd);
  const pick = pool[rnd[0] % pool.length];
  const cands = L.map((x) => (x.nick || x.login) + " · " + JUDGE_POS[x.judge_pos] + " · дел в работе: " + (LD[x.login] || 0));
  const draw = { at: new Date().toISOString(), by: p.nick || p.login, cands, pick: L.indexOf(pick), judge: pick.nick || pick.login, prev: r0.draw ? r0.judge : "", pool: pool.length, rule: "среди наименее загруженных" };
  const [r] = await sql`update court_cases set judge = ${pick.nick || pick.login}, judge_login = ${pick.login}, draw = ${sql.json(draw)}, updated_at = now() where id = ${r0.id} returning *`;
  await caseLog(r.id, "Жребий: судья " + draw.judge + " (кандидатов " + L.length + ")", p.nick || p.login);
  await audit(p.login, "court_draw", pick.login, { id: String(r.id), n: L.length });
  try {
    const [u] = await sql`select id from profiles where login = ${pick.login}`;
    if (u) await sql`insert into broadcasts (user_id, title, author, text, expires_at) values (${u.id}, ${"⚖ Вам распределено дело"}, ${"Жребий"},
              ${`Дело №${String(r.no).padStart(4, "0")} «${r.title}» — жребий выбрал вас среди ${L.length} судей на смене.`}, now() + interval '3 days')`;
  } catch (e) {}
  return { r };
}
const courtHook = (srv, title, text) => postHook(GOV_ORG, srv, "court", title, text, 0x7b1e2b).catch(() => false);
const initials = (s) => String(s || "").split(/\s+/).filter(Boolean).map((w) => w[0].toUpperCase() + ".").join(" ");
function decOut(r) {
  return { id: String(r.id), no: r.no ? String(r.no).padStart(4, "0") : "", title: r.title, caseNo: r.case_no, caseId: r.case_id ? String(r.case_id) : "", dt: r.dt, arts: r.arts, tags: r.tags, text: r.text,
    author: r.author, panel: r.panel || "", person: r.person || "", verdict: r.verdict || "", term: r.term || 0, fine: r.fine || 0, probUntil: r.probation_until, appealUntil: r.appeal_until,
    exec: r.exec_status || "pending", execAt: r.exec_at, amnesty: r.amnesty || "", outcome: r.outcome || "", pub: !!r.public, anon: r.anon !== false };
}
async function court2(p, b, op, srv, me) {
  const sql = db();
  const canJ = isJudge(p) || govLead(p) || !!p.pvs;
  // ── материалы дела: доводы сторон, лица, ходатайства — с оценкой и решением судьи ──
  if (op === "case_mat") {
    const [r0] = await sql`select * from court_cases where id = ${parseInt(b.id, 10) || 0} and server = ${srv}`;
    if (!r0) return fail("Дело не найдено.");
    const mat = matClean(b.mat), old = matClean(r0.mat);
    // оценки и решения ставит только судья/руководство; стороны могут добавлять свои доводы и ходатайства
    if (!canJ && !(r0.author_id === p.id)) {
      const O = Object.fromEntries(old.args.concat(old.motions).map((x) => [x.id, x]));
      for (const x of mat.args) if (O[x.id]) { x.mark = O[x.id].mark; x.note = O[x.id].note; } else { x.mark = ""; x.note = ""; }
      for (const x of mat.motions) if (O[x.id]) { x.dec = O[x.id].dec; x.why = O[x.id].why; } else { x.dec = "wait"; x.why = ""; }
    }
    for (const x of mat.motions) { const o = old.motions.find((y) => y.id === x.id); if (o && o.dec !== x.dec && x.dec !== "wait") await caseLog(r0.id, `Ходатайство (${x.who || "сторона"}): ${MOT_DEC[x.dec]}`, p.nick || p.login); }
    const [r] = await sql`update court_cases set mat = ${sql.json(mat)}, updated_at = now() where id = ${r0.id} returning *`;
    return { ok: true, ...me, item: caseOut(r, p), canEdit: true };
  }
  if (op === "case_note") {
    const side = b.side === "def" ? "def" : "pros";
    const role = p.game_role || "off";
    if (!(canJ || (side === "pros" && role === "pros") || (side === "def" && role === "adv"))) return fail("Эти заметки ведёт своя сторона (" + (side === "pros" ? "обвинение" : "защита") + ").");
    const [r0] = await sql`select * from court_cases where id = ${parseInt(b.id, 10) || 0} and server = ${srv}`;
    if (!r0) return fail("Дело не найдено.");
    const ns = { ...(r0.notes_side || {}), [side]: String(b.text == null ? "" : b.text).slice(0, 4000) };
    const [r] = await sql`update court_cases set notes_side = ${sql.json(ns)} where id = ${r0.id} returning *`;
    return { ok: true, ...me, item: caseOut(r, p) };
  }
  if (op === "case_related") {
    const [r0] = await sql`select * from court_cases where id = ${parseInt(b.id, 10) || 0} and server = ${srv}`;
    if (!r0) return fail("Дело не найдено.");
    const names = (r0.parties || []).filter((x) => !/обвинение|защита|прокурор|адвокат|представ/i.test(x.role)).map((x) => String(x.name || "").toLowerCase()).filter((x) => x.length > 3);
    const arts = String(r0.arts || "").match(/\d+(?:\.\d+)*/g) || [];
    const rows = await sql`select * from court_cases where server = ${srv} and id <> ${r0.id} order by created_at desc limit 400`;
    const out = [];
    for (const r of rows) {
      const why = [];
      const pn = (r.parties || []).map((x) => String(x.name || "").toLowerCase());
      const same = names.filter((n) => pn.includes(n));
      if (same.length) why.push("тот же участник: " + same.join(", "));
      const ra = String(r.arts || "").match(/\d+(?:\.\d+)*/g) || [];
      const sa = arts.filter((a) => ra.includes(a));
      if (sa.length) why.push("та же статья: " + sa.join(", "));
      if (why.length) out.push({ id: String(r.id), no: String(r.no).padStart(4, "0"), title: r.title, status: r.status, why: why.join("; "), repeat: same.length > 0 });
      if (out.length >= 20) break;
    }
    const hist = names.length ? await sql`select * from court_decisions where server = ${srv} and verdict = 'guilty' and lower(person) = any(${names}) order by dt desc limit 20` : [];
    return { ok: true, list: out, decisions: hist.map(decOut) };
  }
  if (op === "case_merge") {
    if (!canJ) return fail("Объединяет дела судья или руководство.");
    const [a] = await sql`select * from court_cases where id = ${parseInt(b.id, 10) || 0} and server = ${srv}`;
    const [t] = await sql`select * from court_cases where server = ${srv} and (id = ${parseInt(b.into, 10) || 0} or no = ${parseInt(b.intoNo, 10) || 0}) and id <> ${a ? a.id : 0} limit 1`;
    if (!a || !t) return fail("Не найдено одно из дел.");
    const mA = matClean(a.mat), mT = matClean(t.mat);
    const mat = matClean({ args: mT.args.concat(mA.args), persons: mT.persons.concat(mA.persons.filter((x) => !mT.persons.some((y) => y.name === x.name))), motions: mT.motions.concat(mA.motions) });
    const parties = (t.parties || []).concat((a.parties || []).filter((x) => !(t.parties || []).some((y) => y.name === x.name))).slice(0, 12);
    const arts = [t.arts, a.arts].filter(Boolean).join(", ").slice(0, 300);
    const [r] = await sql`update court_cases set parties = ${sql.json(parties)}, arts = ${arts}, evidence = ${sql.json((t.evidence || []).concat(a.evidence || []).slice(0, 30))},
                          hearings = ${sql.json((t.hearings || []).concat(a.hearings || []).slice(0, 20))}, mat = ${sql.json(mat)}, updated_at = now() where id = ${t.id} returning *`;
    await sql`update court_cases set status = 'closed', merged_into = ${t.id}, closed_at = now(), updated_at = now() where id = ${a.id}`;
    await caseLog(t.id, `Присоединено дело №${String(a.no).padStart(4, "0")}`, p.nick || p.login);
    await caseLog(a.id, `Объединено с делом №${String(t.no).padStart(4, "0")}`, p.nick || p.login);
    return { ok: true, ...me, item: caseOut(r, p), canEdit: true };
  }
  // ── отвод судьи (10) ──
  if (op === "recuse") {
    const [r0] = await sql`select * from court_cases where id = ${parseInt(b.id, 10) || 0} and server = ${srv}`;
    if (!r0 || !r0.judge_login) return fail("У дела нет назначенного судьи.");
    const reason = clean(b.reason, 400);
    if (reason.length < 10) return fail("Опишите основание отвода (не короче 10 знаков).");
    const L = Array.isArray(r0.recusals) ? r0.recusals : [];
    L.push({ at: Date.now(), by: p.nick || p.login, judge: r0.judge, login: r0.judge_login, reason, status: "wait" });
    const [r] = await sql`update court_cases set recusals = ${sql.json(L)} where id = ${r0.id} returning *`;
    await caseLog(r0.id, `Заявлен отвод судье ${r0.judge}`, p.nick || p.login);
    return { ok: true, ...me, item: caseOut(r, p) };
  }
  if (op === "recuse_decide") {
    if (!(govLead(p) || p.pvs)) return fail("Отвод рассматривает руководство Government или Председатель Верховного суда.");
    const [r0] = await sql`select * from court_cases where id = ${parseInt(b.id, 10) || 0} and server = ${srv}`;
    if (!r0) return fail("Дело не найдено.");
    const L = Array.isArray(r0.recusals) ? r0.recusals : [], x = L[+b.idx];
    if (!x || x.status !== "wait") return fail("Отвод не найден или уже рассмотрен.");
    x.status = b.ok ? "ok" : "no"; x.dby = p.nick || p.login;
    await sql`update court_cases set recusals = ${sql.json(L)} where id = ${r0.id}`;
    await caseLog(r0.id, `Отвод судье ${x.judge}: ${b.ok ? "удовлетворён" : "отклонён"}`, p.nick || p.login);
    if (b.ok) {
      const ex = L.filter((y) => y.status === "ok").map((y) => y.login);
      const d = await drawJudge(p, { ...r0, recusals: L }, srv, ex);
      if (d.err) { await sql`update court_cases set judge = '', judge_login = '' where id = ${r0.id}`; return fail("Отвод удовлетворён, но новый жребий не провести: " + d.err); }
      return { ok: true, ...me, item: caseOut(d.r, p), canEdit: true, redraw: true };
    }
    const [r] = await sql`select * from court_cases where id = ${r0.id}`;
    return { ok: true, ...me, item: caseOut(r, p), canEdit: true };
  }
  // ── апелляция и кассация (29, 32) ──
  if (op === "case_appeal") {
    const [r0] = await sql`select * from court_cases where id = ${parseInt(b.id, 10) || 0} and server = ${srv}`;
    if (!r0) return fail("Дело не найдено.");
    const level = b.level === "cassation" ? "cassation" : "appeal";
    const title = (level === "appeal" ? "Апелляция" : "Кассация") + " по делу №" + String(r0.no).padStart(4, "0") + " · " + r0.title;
    const parties = (r0.parties || []).concat([{ role: "Заявитель", name: clean(b.by, 80) || p.nick || p.login, note: level === "appeal" ? "апелляционная жалоба" : "кассационная жалоба" }]).slice(0, 12);
    const [r] = await sql`insert into court_cases (server, no, title, kind, status, stage, parties, arts, evidence, notes, author_id, author, author_login, appeal_of, level)
                          values (${srv}, (select coalesce(max(no), 0) + 1 from court_cases where server = ${srv}), ${title.slice(0, 120)}, ${r0.kind}, 'open', 'filed', ${sql.json(parties)}, ${r0.arts},
                                  ${sql.json(r0.evidence || [])}, ${clean(b.reason, 2000)}, ${p.id}, ${p.nick || p.login}, ${p.login}, ${r0.id}, ${level}) returning *`;
    await sql`update court_cases set stage = 'appealed', updated_at = now() where id = ${r0.id}`;
    await caseLog(r0.id, (level === "appeal" ? "Подана апелляция" : "Подана кассация") + ": дело №" + String(r.no).padStart(4, "0"), p.nick || p.login);
    await caseLog(r.id, "Создано по жалобе на дело №" + String(r0.no).padStart(4, "0"), p.nick || p.login);
    courtHook(srv, "📨 " + (level === "appeal" ? "Апелляция" : "Кассация"), `Дело №${String(r.no).padStart(4, "0")}: ${r.title}`);
    return { ok: true, ...me, item: caseOut(r, p), canEdit: true };
  }
  // ── реестр решений: исполнение, испытательный срок, амнистия, итог обжалования, публикация ──
  if (["dec_exec", "dec_amnesty", "dec_outcome", "dec_public"].includes(op)) {
    if (!canJ) return fail("Это меняет судья или руководство.");
    const id = parseInt(b.id, 10) || 0;
    let r;
    if (op === "dec_exec") [r] = await sql`update court_decisions set exec_status = ${b.done ? "done" : "pending"}, exec_at = ${b.done ? new Date() : null} where id = ${id} and server = ${srv} returning *`;
    if (op === "dec_amnesty") { if (!(govLead(p) || p.pvs)) return fail("Амнистию отмечает руководство Government или ПВС."); [r] = await sql`update court_decisions set amnesty = ${clean(b.text, 300)} where id = ${id} and server = ${srv} returning *`; }
    if (op === "dec_outcome") [r] = await sql`update court_decisions set outcome = ${["", "upheld", "changed", "overturned"].includes(b.outcome) ? b.outcome : ""} where id = ${id} and server = ${srv} returning *`;
    if (op === "dec_public") [r] = await sql`update court_decisions set public = ${!!b.on}, anon = ${b.anon !== false} where id = ${id} and server = ${srv} returning *`;
    if (!r) return fail("Решение не найдено.");
    if (op === "dec_exec" && r.case_id && b.done) { await sql`update court_cases set stage = 'executed' where id = ${r.case_id}`; await caseLog(r.case_id, "Решение исполнено", p.nick || p.login); }
    return { ok: true, item: decOut(r) };
  }
  if (op === "person_hist") {
    const n = clean(b.name, 80).toLowerCase();
    if (n.length < 3) return { ok: true, list: [] };
    const rows = await sql`select * from court_decisions where server = ${srv} and lower(person) = ${n} order by dt desc limit 30`;
    return { ok: true, list: rows.map(decOut) };
  }
  if (op === "dec_due") {
    const rows = await sql`select * from court_decisions where server = ${srv} and (exec_status = 'pending' and verdict = 'guilty' or probation_until > now() or appeal_until > now()) order by dt desc limit 100`;
    return { ok: true, list: rows.map(decOut) };
  }
  if (op === "pub_set") {
    if (!govLead(p)) return fail("Публичный реестр включает руководство Government.");
    await setSetting(`court_pub:${srv}`, { on: !!b.on, by: p.login, at: Date.now() });
    return { ok: true, on: !!b.on };
  }
  if (op === "pub_get") return { ok: true, on: !!(await getSetting(`court_pub:${srv}`, { on: false })).on };
  // ── ордера: номер, проверка по номеру, использование ──
  if (op === "war_use") {
    const [r] = await sql`update warrants set uses = coalesce(uses, '[]'::jsonb) || ${sql.json([{ at: Date.now(), by: p.nick || p.login, t: clean(b.note, 200) }])}
                          where id = ${parseInt(b.id, 10) || 0} and server = ${srv} and status = 'ok' returning *`;
    return r ? { ok: true, item: warOut(r) } : fail("Ордер не найден или не действует.");
  }
  // ── 45, 47: статистика судей и отчёт за месяц ──
  if (op === "judge_stats") {
    if (!(govLead(p) || p.pvs)) return fail("Статистику судей видят Председатель Верховного суда и руководство.");
    const js = await sql`select login, nick, judge_pos, judge_exam from profiles where server = ${srv} and judge_pos = any(${JUDGE_SEAT}) and not banned order by lower(nick)`;
    const cs = await sql`select id, judge_login, panel, status, created_at, closed_at, appeal_of from court_cases where server = ${srv}`;
    const decs = await sql`select case_id, outcome from court_decisions where server = ${srv} and case_id is not null`;
    const DO = {}; for (const d of decs) DO[d.case_id] = d.outcome;
    const byId = Object.fromEntries(cs.map((c) => [c.id, c]));
    return { ok: true, list: js.map((j) => {
      const mine = cs.filter((c) => c.judge_login === j.login || (c.panel || []).some((x) => x.nick === j.nick && x.role !== "secretary"));
      const closed = mine.filter((c) => c.status === "closed" && c.closed_at);
      const avg = closed.length ? closed.reduce((s, c) => s + (tsOf(c.closed_at) - tsOf(c.created_at)), 0) / closed.length / 864e5 : null;
      const appealed = cs.filter((c) => c.appeal_of && byId[c.appeal_of] && mine.includes(byId[c.appeal_of]));
      const over = appealed.filter((c) => ["overturned", "changed"].includes(DO[c.id] || "")).length;
      return { nick: j.nick, pos: JUDGE_POS[j.judge_pos], open: mine.filter((c) => c.status === "open").length, closed: closed.length, avgDays: avg == null ? null : Math.round(avg * 10) / 10,
        appealed: appealed.length, overturned: over, exam: j.judge_exam || null };
    }) };
  }
  if (op === "court_month") {
    const m = /^\d{4}-\d{2}$/.test(String(b.month || "")) ? String(b.month) : mskDay(new Date()).slice(0, 7);
    const a = new Date(Date.parse(m + "-01T00:00:00+03:00")), z = new Date(Date.parse(addMonthStr(m) + "-01T00:00:00+03:00"));
    const [c] = await sql`select count(*) filter (where created_at >= ${a} and created_at < ${z})::int opened, count(*) filter (where closed_at >= ${a} and closed_at < ${z})::int closed,
                                 count(*) filter (where level <> '' and created_at >= ${a} and created_at < ${z})::int appeals from court_cases where server = ${srv}`;
    const [w] = await sql`select count(*) filter (where status = 'ok')::int issued, count(*) filter (where status = 'no')::int denied from warrants where server = ${srv} and created_at >= ${a} and created_at < ${z}`;
    const [d] = await sql`select count(*) filter (where verdict = 'guilty')::int guilty, count(*) filter (where verdict = 'acquit')::int acquit, count(*)::int total from court_decisions where server = ${srv} and dt >= ${m + "-01"} and dt < ${addMonthStr(m) + "-01"}`;
    const top = await sql`select author, count(*)::int n from court_decisions where server = ${srv} and dt >= ${m + "-01"} and dt < ${addMonthStr(m) + "-01"} group by author order by n desc limit 3`;
    return { ok: true, month: m, server: srvName(srv), cases: c, warrants: w, decisions: d, top };
  }
  // ── 43: экзамен на судью ──
  if (op === "exam_save") {
    const score = Math.max(0, Math.min(100, parseInt(b.score, 10) || 0));
    await sql`update profiles set judge_exam = ${sql.json({ score, total: parseInt(b.total, 10) || 0, at: Date.now() })} where id = ${p.id}`;
    return { ok: true, score };
  }
  // ── 33, 34: адвокаты — реестр, дежурный, вызов из задержания ──
  if (op === "adv_set") {
    if (p.org !== GOV_ORG) return fail("В реестр адвокатов вносятся сотрудники Government.");
    await sql`update profiles set adv_on = ${!!b.on}, adv_spec = ${clean(b.spec, 120)}, adv_busy = ${!!b.busy}, adv_lic = ${clean(b.lic, 40)} where id = ${p.id}`;
    return { ok: true };
  }
  // ── 37, 39: прокурорский надзор за рапортами ──
  if (op === "rp_list") {
    if (!isGov(p)) return fail("Надзор ведёт прокуратура (Government).");
    const days = Math.min(30, Math.max(1, parseInt(b.days, 10) || 7));
    const rows = await sql`select id, org_no, org, author, login, kind, title, body, fields, status, created_at, pros_mark, pros_note, pros_by from reports
                           where coalesce(server, ${DEFAULT_SERVER}) = ${srv} and created_at > now() - make_interval(days => ${days}) and (${b.org || ""} = '' or org = ${b.org || ""})
                             and (${b.mark || ""} = '' or pros_mark = ${b.mark === "none" ? "" : b.mark || ""}) order by created_at desc limit 150`;
    return { ok: true, list: rows.map((r) => ({ id: String(r.id), no: r.org_no ? String(r.org_no).padStart(4, "0") : String(r.id), org: r.org, author: r.author, kind: r.kind, title: r.title, body: r.body, fields: r.fields || {},
      status: r.status, created: r.created_at, mark: r.pros_mark || "", note: r.pros_note || "", by: r.pros_by || "" })) };
  }
  if (op === "rp_mark") {
    if (!isGov(p)) return fail("Надзор ведёт прокуратура (Government).");
    const mark = ["", "ok", "viol"].includes(b.mark) ? b.mark : "";
    const [r] = await sql`update reports set pros_mark = ${mark}, pros_note = ${clean(b.note, 600)}, pros_by = ${mark ? p.nick || p.login : ""} where id = ${parseInt(b.id, 10) || 0} and coalesce(server, ${DEFAULT_SERVER}) = ${srv} returning user_id, title, org`;
    if (!r) return fail("Рапорт не найден.");
    if (mark === "viol" && r.user_id) await sql`insert into broadcasts (user_id, title, author, text, expires_at) values (${r.user_id}, ${"⚖ Прокурорская проверка"}, ${p.nick || p.login},
              ${`В рапорте «${r.title}» прокуратура нашла нарушения: ${clean(b.note, 600) || "см. рапорт"}.`}, now() + interval '7 days')`;
    return { ok: true };
  }
  return null;
}
const addMonthStr = (m) => { const y = +m.slice(0, 4), mo = +m.slice(5, 7); return mo === 12 ? `${y + 1}-01` : `${y}-${String(mo + 1).padStart(2, "0")}`; };
// адвокаты и вызов — доступны всем сотрудникам сервера (полиция зовёт адвоката к задержанному)
async function advApi(p, b, op, srv) {
  const sql = db();
  if (op === "adv_list") {
    const rows = await sql`select id, nick, static_id, adv_spec, adv_busy, adv_lic, adv_last, last_seen from profiles where server = ${srv} and adv_on and not banned and approval = 'ok' order by adv_busy, adv_last nulls first, lower(nick) limit 100`;
    const calls = await sql`select * from adv_calls where server = ${srv} and created_at > now() - interval '12 hours' order by created_at desc limit 40`;
    const free = rows.filter((r) => !r.adv_busy && r.last_seen && Date.now() - tsOf(r.last_seen) < 20 * 60e3);
    return { ok: true, duty: free[0] ? free[0].nick : "", me: { on: !!p.adv_on, spec: p.adv_spec || "", busy: !!p.adv_busy, lic: p.adv_lic || "" }, canBe: p.org === GOV_ORG,
      list: rows.map((r) => ({ nick: r.nick, static: r.static_id || "", spec: r.adv_spec || "", busy: !!r.adv_busy, lic: r.adv_lic || "", online: !!r.last_seen && Date.now() - tsOf(r.last_seen) < 20 * 60e3, me: r.id === p.id })),
      calls: calls.map((c) => ({ id: String(c.id), caller: c.caller, suspect: c.suspect, place: c.place, note: c.note, status: c.status, taker: c.taker, created: c.created_at, mine: c.caller_id === p.id, took: c.taker_id === p.id })) };
  }
  if (op === "adv_call") {
    if (!(await hit(`advc:${p.id}`, 10, 3600))) return fail(RATE_MSG, { code: "rate" });
    const suspect = clean(b.suspect, 80);
    if (!suspect) return fail("Укажите, кому нужен адвокат.");
    const [c] = await sql`insert into adv_calls (server, caller_id, caller, suspect, place, note) values (${srv}, ${p.id}, ${(p.nick || p.login) + (p.org ? " (" + p.org + ")" : "")}, ${suspect}, ${clean(b.place, 120)}, ${clean(b.note, 300)}) returning *`;
    const L = await sql`select id from profiles where server = ${srv} and adv_on and not adv_busy and not banned and last_seen > now() - interval '20 minutes' order by adv_last nulls first limit 10`;
    for (const a of L) await sql`insert into broadcasts (user_id, title, author, text, expires_at) values (${a.id}, ${"🛡 Нужен адвокат"}, ${p.nick || p.login},
              ${`${suspect}${b.place ? " · " + clean(b.place, 120) : ""}. Принять вызов — «Суд» → «Адвокаты».`}, now() + interval '6 hours')`;
    return { ok: true, sent: L.length, id: String(c.id) };
  }
  if (op === "adv_take") {
    if (!p.adv_on) return fail("Сначала включите себя в реестр адвокатов.");
    const [c] = await sql`update adv_calls set status = 'taken', taker_id = ${p.id}, taker = ${p.nick || p.login}, taken_at = now() where id = ${parseInt(b.id, 10) || 0} and server = ${srv} and status = 'open' returning *`;
    if (!c) return fail("Вызов уже принят другим адвокатом или закрыт.");
    await sql`update profiles set adv_last = now(), adv_busy = true where id = ${p.id}`;
    if (c.caller_id) await sql`insert into broadcasts (user_id, title, author, text, expires_at) values (${c.caller_id}, ${"🛡 Адвокат едет"}, ${p.nick || p.login},
              ${`Вызов для ${c.suspect} принял адвокат ${p.nick || p.login}.`}, now() + interval '6 hours')`;
    return { ok: true };
  }
  if (op === "adv_close") {
    await sql`update adv_calls set status = 'closed' where id = ${parseInt(b.id, 10) || 0} and server = ${srv} and (caller_id = ${p.id} or taker_id = ${p.id})`;
    if (b.free) await sql`update profiles set adv_busy = false where id = ${p.id}`;
    return { ok: true };
  }
  if (op === "war_check") {
    const no = parseInt(String(b.no || "").replace(/\D/g, ""), 10) || 0;
    const [r] = await sql`select * from warrants where server = ${srv} and no = ${no}`;
    if (!r) return fail("Ордер с таким номером не найден на этом сервере.");
    return { ok: true, item: warOut(r) };
  }
  return null;
}
// публичный реестр решений и консультант для граждан на сайте (48, 50)
async function pubCourt(b, ip) {
  if (!(await hit(`pc:${ip}`, 60, 3600))) return fail(RATE_MSG, { code: "rate" });
  const srv = parseServer(b.server) || DEFAULT_SERVER;
  if (!(await getSetting(`court_pub:${srv}`, { on: false })).on) return { ok: true, off: true, list: [] };
  const q = clean(b.q, 80).toLowerCase().replace(/ё/g, "е");
  const rows = await sql_pub(srv, q);
  return { ok: true, list: rows.map((r) => {
    const d = decOut(r);
    if (d.anon && d.person) { const re = new RegExp(d.person.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"); d.title = d.title.replace(re, initials(d.person)); d.text = d.text.replace(re, initials(d.person)); d.person = initials(d.person); }
    return { no: d.no, title: d.title, caseNo: d.caseNo, dt: d.dt, arts: d.arts, tags: d.tags, text: d.text, panel: d.panel, verdict: d.verdict, outcome: d.outcome };
  }) };
}
async function sql_pub(srv, q) {
  return await db()`select * from court_decisions where server = ${srv} and public and (${q} = '' or replace(lower(title || ' ' || arts || ' ' || tags || ' ' || text), 'ё', 'е') like ${"%" + q + "%"}) order by dt desc limit 60`;
}
async function pubCourtAi(b, ip) {
  if ((await flagsNow()).courtai === "off") return fail("Консультант временно выключен.");
  if (!AI_KEY) return fail("Консультант ещё не подключён.");
  if (!(await hit(`pca:${ip}`, 5, 86400))) return fail("Лимит консультаций на сегодня исчерпан (5 вопросов в день). Задайте вопрос в программе после входа.", { limit: true });
  const q = String(b.q == null ? "" : b.q).replace(/\s+/g, " ").trim().slice(0, 800);
  if (q.length < 10) return fail("Опишите ситуацию подробнее.");
  const cid = (await sha256("pub:" + ip)).slice(0, 32), ts = String(Date.now());
  try {
    const r = await fetch(AI_URL + "/ask", { method: "POST", headers: { "content-type": "application/json", "x-senko-cid": cid, "x-senko-ts": ts, "x-senko-sig": await hmacHex(AI_KEY, cid + "." + ts) },
      body: JSON.stringify({ q, ctx: [], hist: [], srv: parseServer(b.server) || DEFAULT_SERVER, mode: "citizen" }), signal: AbortSignal.timeout(35000) });
    const j = await r.json().catch(() => null);
    if (!j || !j.ok) return fail((j && j.error) || "Консультант не ответил.");
    return { ok: true, answer: j.answer };
  } catch (e) {
    return fail("Не удалось связаться с консультантом.");
  }
}

// ── 4.3.1: совместное заседание — как экипаж у задержаний: ссылка-приглашение, роли, общий пульт и протокол ──
const SES_ROLE = { presiding: "Председательствующий", rapporteur: "Судья-докладчик", member: "Судья коллегии", secretary: "Секретарь судебного заседания",
  pros: "Государственный обвинитель", def: "Защитник", plaintiff: "Истец / представитель", defendant: "Подсудимый / ответчик", witness: "Свидетель", part: "Участник" };
const SES_PANEL = ["presiding", "rapporteur", "member"];
const SES_MAX = 15;
const sesCode = (c) => String(c == null ? "" : c).toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6);
function sesPult(x) {
  x = x && typeof x === "object" ? x : {};
  return { start: +x.start || 0, acc: +x.acc || 0, run: !!x.run, lim: Math.min(1800, Math.max(15, +x.lim || 120)), cur: x.cur ? clean(x.cur, 80) : null, curAt: +x.curAt || 0,
    q: (Array.isArray(x.q) ? x.q : []).slice(0, 30).map((s) => clean(s, 80)).filter(Boolean), chk: x.chk && typeof x.chk === "object" ? Object.fromEntries(Object.entries(x.chk).slice(0, 40).map(([k, v]) => [String(k).slice(0, 3), !!v])) : {},
    list: (Array.isArray(x.list) ? x.list : []).slice(0, 30).map((s) => clean(s, 120)).filter(Boolean), recess: Math.max(0, +x.recess || 0) };
}
async function sesApi(p, b, op, srv) {
  const sql = db();
  if (!(await hit(`ses:${p.id}`, 2500, 3600))) return fail(RATE_MSG, { code: "rate" });
  const mine = async () => (await sql`select m.code from court_session_members m join court_sessions s on s.code = m.code where m.user_id = ${p.id} and s.expires_at > now() limit 1`)[0];
  const isGovU = (u) => u.org === GOV_ORG || ["moderator", "owner"].includes(u.rank);
  const view = async (code) => {
    await sql`update court_session_members set seen_at = now() where code = ${code} and user_id = ${p.id}`;
    const [s] = await sql`select * from court_sessions where code = ${code}`;
    if (!s) return { ok: true, ses: null };
    const mem = await sql`select m.user_id, m.role, m.seen_at, m.sig, pr.nick, pr.org, pr.judge_pos, pr.static_id from court_session_members m join profiles pr on pr.id = m.user_id where m.code = ${code} order by m.joined_at`;
    const meM = mem.find((m) => m.user_id === p.id);
    const st = s.state || {};
    return { ok: true, ses: {
      code, title: s.title, caseId: s.case_id ? String(s.case_id) : "", caseNo: s.case_no, court: st.court || "", expires: s.expires_at, owner: s.owner_id === p.id,
      myRole: meM ? meM.role : "", canRun: !!meM && ["presiding", "secretary"].includes(meM.role), canRole: !!meM && meM.role === "presiding",
      members: mem.map((m) => ({ id: m.user_id, nick: m.nick, org: m.org, static: m.static_id || "", role: m.role, roleName: SES_ROLE[m.role] || m.role, judgeName: JUDGE_POS[m.judge_pos] || "",
        me: m.user_id === p.id, online: Date.now() - new Date(m.seen_at).getTime() < 60e3, sig: m.sig || "", gov: m.org === GOV_ORG })),
      pult: sesPult(st.pult), proto: Array.isArray(st.proto) ? st.proto : [], ver: +st.ver || 0, roles: SES_ROLE, panel: SES_PANEL,
      warns: st.warns || {}, vote: st.vote ? (() => { const v = st.vote, vs = Object.values(v.votes || {}), cnt = { for: vs.filter((x) => x === "for").length, against: vs.filter((x) => x === "against").length, abstain: vs.filter((x) => x === "abstain").length };
        return { q: v.q, open: !!v.open, n: vs.length, total: mem.filter((m) => SES_PANEL.includes(m.role)).length, mine: meM ? (v.votes || {})[meM.user_id] || "" : "", res: v.open ? null : cnt, at: v.at }; })() : null } };
  };
  if (op === "ses_state") { const m = await mine(); return m ? view(m.code) : { ok: true, ses: null, roles: SES_ROLE }; }
  if (op === "ses_peek") {
    const code = sesCode(b.code);
    const [s] = code.length === 6 ? await sql`select s.code, s.title, s.case_no, pr.nick, pr.static_id from court_sessions s left join court_session_members m on m.code = s.code and m.role = 'presiding'
                                               left join profiles pr on pr.id = m.user_id where s.code = ${code} and s.expires_at > now() limit 1` : [];
    if (!s) return fail("Заседание не найдено или уже закрыто.");
    const [{ n }] = await sql`select count(*)::int n from court_session_members where code = ${code}`;
    const [me] = await sql`select 1 from court_session_members where code = ${code} and user_id = ${p.id}`;
    return { ok: true, code, title: s.title, caseNo: s.case_no, nick: s.nick || "", static: s.static_id || "", members: n, max: SES_MAX, already: !!me };
  }
  if (op === "ses_create") {
    if (!isGovU(p)) return fail("Открыть заседание может сотрудник Government.");
    const m = await mine();
    if (m) return view(m.code);
    let c0 = null;
    if (b.caseId) [c0] = await sql`select id, no, title from court_cases where id = ${parseInt(b.caseId, 10) || 0} and server = ${srv}`;
    const ABC = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    let code = "";
    for (let i = 0; i < 6 && !code; i++) {
      const c = Array.from(crypto.getRandomValues(new Uint8Array(6))).map((x) => ABC[x % ABC.length]).join("");
      const r = await sql`insert into court_sessions (code, server, owner_id, case_id, case_no, title, state, expires_at)
                          values (${c}, ${srv}, ${p.id}, ${c0 ? c0.id : null}, ${c0 ? String(c0.no || c0.id).padStart(4, "0") : clean(b.caseNo, 20)}, ${c0 ? c0.title : clean(b.title, 120) || "Судебное заседание"},
                                  ${sql.json({ court: clean(b.court, 80), pult: sesPult({}), proto: [], ver: 1 })}, now() + interval '12 hours') on conflict do nothing returning code`;
      if (r.length) code = c;
    }
    if (!code) return fail("Не удалось открыть заседание. Попробуйте ещё раз.");
    await sql`insert into court_session_members (code, user_id, role, sig) values (${code}, ${p.id}, 'presiding', ${sesSig(b.sig)})`;
    await sql`delete from court_sessions where expires_at < now() - interval '1 day'`;
    return view(code);
  }
  if (op === "ses_join") {
    const code = sesCode(b.code);
    const [s] = code.length === 6 ? await sql`select * from court_sessions where code = ${code} and expires_at > now()` : [];
    if (!s) return fail("Заседание не найдено или уже закрыто.");
    if (s.server !== srv && !["moderator", "owner"].includes(p.rank)) return fail("Это заседание другого сервера.");
    const m = await mine();
    if (m && m.code !== code) await sql`delete from court_session_members where code = ${m.code} and user_id = ${p.id}`;
    const [{ n }] = await sql`select count(*)::int n from court_session_members where code = ${code}`;
    if (n >= SES_MAX && !(m && m.code === code)) return fail(`В заседании уже ${SES_MAX} участников.`);
    await sql`insert into court_session_members (code, user_id, role, sig) values (${code}, ${p.id}, 'part', ${sesSig(b.sig)}) on conflict (code, user_id) do update set sig = case when excluded.sig <> '' then excluded.sig else court_session_members.sig end`;
    return view(code);
  }
  const m = await mine();
  if (!m) return fail("Вы не участвуете в заседании.", { code: "noses" });
  const [me] = await sql`select role from court_session_members where code = ${m.code} and user_id = ${p.id}`;
  const role = me ? me.role : "";
  const bump = async (fn) => {
    const [s] = await sql`select state from court_sessions where code = ${m.code} for update`;
    const st = (s && s.state) || {};
    fn(st);
    st.ver = (+st.ver || 0) + 1;
    await sql`update court_sessions set state = ${sql.json(st)} where code = ${m.code}`;
  };
  if (op === "ses_leave") {
    await sql`delete from court_session_members where code = ${m.code} and user_id = ${p.id}`;
    const rest = await sql`select user_id, role from court_session_members where code = ${m.code} order by joined_at`;
    if (!rest.length) await sql`delete from court_sessions where code = ${m.code}`;
    else if (role === "presiding" && !rest.some((r) => r.role === "presiding")) {
      const nx = rest.find((r) => SES_PANEL.includes(r.role)) || rest[0];
      await sql`update court_session_members set role = 'presiding' where code = ${m.code} and user_id = ${nx.user_id}`;
    }
    return { ok: true, ses: null };
  }
  if (op === "ses_sig") {
    await sql`update court_session_members set sig = ${sesSig(b.sig)} where code = ${m.code} and user_id = ${p.id}`;
    return view(m.code);
  }
  if (op === "ses_role") {
    if (role !== "presiding") return fail("Роли распределяет председательствующий.");
    const r = SES_ROLE[b.role] ? b.role : "part";
    const [u] = await sql`select m.user_id, pr.org, pr.rank from court_session_members m join profiles pr on pr.id = m.user_id where m.code = ${m.code} and m.user_id = ${b.id}`;
    if (!u) return fail("Участник не найден.");
    if ((SES_PANEL.includes(r) || r === "secretary") && !isGovU(u)) return fail("Роли судей и секретаря — только для сотрудников Government.");
    if (r === "presiding") await sql`update court_session_members set role = 'member' where code = ${m.code} and role = 'presiding'`; // председательствующий один
    await sql`update court_session_members set role = ${r} where code = ${m.code} and user_id = ${u.user_id}`;
    return view(m.code);
  }
  if (op === "ses_info") {
    if (role !== "presiding") return fail("Данные заседания меняет председательствующий.");
    await sql`update court_sessions set title = ${clean(b.title, 120) || "Судебное заседание"}, case_no = ${clean(b.caseNo, 20)} where code = ${m.code}`;
    await bump((st) => { st.court = clean(b.court, 80); });
    return view(m.code);
  }
  if (op === "ses_pult") {
    if (!["presiding", "secretary"].includes(role)) return fail("Пультом управляют председательствующий и секретарь.");
    await bump((st) => { st.pult = sesPult(b.pult); });
    return view(m.code);
  }
  if (op === "ses_proto") {
    if (!(SES_PANEL.includes(role) || role === "secretary")) return fail("Протокол ведут судьи и секретарь.");
    await bump((st) => {
      const L = Array.isArray(st.proto) ? st.proto : [];
      if (b.del != null) { const i = L.findIndex((x) => x.id === String(b.del)); if (i >= 0) L.splice(i, 1); }
      else if (b.k && b.t) {
        if (L.length >= 300) L.shift();
        L.push({ id: Date.now().toString(36) + Math.random().toString(36).slice(2, 5), at: Date.now(), k: ["speech", "motion", "decision", "note"].includes(b.k) ? b.k : "note", t: clean(b.t, 600), by: p.nick || p.login });
      }
      if (b.clear) L.length = 0;
      st.proto = L;
    });
    return view(m.code);
  }
  // 13: тайное голосование коллегии — видно только, сколько проголосовало; итог — после закрытия голосования
  if (op === "ses_vote_start" || op === "ses_vote_end") {
    if (role !== "presiding") return fail("Голосование открывает и закрывает председательствующий.");
    if (op === "ses_vote_start") { const q = clean(b.q, 200); if (q.length < 3) return fail("Сформулируйте вопрос для голосования."); await bump((st) => { st.vote = { q, open: true, votes: {}, at: Date.now() }; }); }
    else await bump((st) => {
      if (!st.vote) return;
      st.vote.open = false;
      const vs = Object.values(st.vote.votes || {});
      const L = Array.isArray(st.proto) ? st.proto : [];
      L.push({ id: Date.now().toString(36), at: Date.now(), k: "decision", t: `Голосование коллегии «${st.vote.q}»: за — ${vs.filter((x) => x === "for").length}, против — ${vs.filter((x) => x === "against").length}, воздержались — ${vs.filter((x) => x === "abstain").length}`, by: p.nick || p.login });
      st.proto = L;
    });
    return view(m.code);
  }
  if (op === "ses_vote") {
    if (!SES_PANEL.includes(role)) return fail("Голосуют судьи коллегии.");
    const v = ["for", "against", "abstain"].includes(b.v) ? b.v : "";
    await bump((st) => { if (st.vote && st.vote.open && v) { st.vote.votes = st.vote.votes || {}; st.vote.votes[p.id] = v; } });
    return view(m.code);
  }
  // 14: ходатайство от участника — попадает в материалы дела и протокол, решение принимает суд
  if (op === "ses_motion") {
    const t = clean(b.t, 600);
    if (t.length < 5) return fail("Опишите ходатайство.");
    const [s] = await sql`select case_id from court_sessions where code = ${m.code}`;
    const who = (p.nick || p.login) + " (" + (SES_ROLE[role] || "участник").toLowerCase() + ")";
    if (s && s.case_id) {
      const [c] = await sql`select mat from court_cases where id = ${s.case_id}`;
      const mat = matClean(c && c.mat);
      mat.motions.push({ id: Math.random().toString(36).slice(2, 9), who, t, dec: "wait", why: "", at: Date.now() });
      await sql`update court_cases set mat = ${sql.json(matClean(mat))}, updated_at = now() where id = ${s.case_id}`;
    }
    await bump((st) => { const L = Array.isArray(st.proto) ? st.proto : []; L.push({ id: Date.now().toString(36) + "m", at: Date.now(), k: "motion", t: who + ": " + t, by: p.nick || p.login }); st.proto = L; });
    return view(m.code);
  }
  // 20: замечание и удаление из зала
  if (op === "ses_warn") {
    if (role !== "presiding") return fail("Порядок в зале поддерживает председательствующий.");
    const [u] = await sql`select m.user_id, pr.nick from court_session_members m join profiles pr on pr.id = m.user_id where m.code = ${m.code} and m.user_id = ${b.id}`;
    if (!u) return fail("Участник не найден.");
    const rm = b.kind === "remove";
    await bump((st) => {
      st.warns = st.warns || {};
      st.warns[u.user_id] = rm ? 99 : (st.warns[u.user_id] || 0) + 1;
      const L = Array.isArray(st.proto) ? st.proto : [];
      L.push({ id: Date.now().toString(36) + "w", at: Date.now(), k: "note", t: rm ? `${u.nick} удалён из зала судебного заседания` : `${u.nick}: замечание за нарушение порядка (${st.warns[u.user_id]}-е)`, by: p.nick || p.login });
      st.proto = L;
    });
    if (rm) await sql`update court_session_members set role = 'part' where code = ${m.code} and user_id = ${u.user_id}`;
    return view(m.code);
  }
  if (op === "ses_close") {
    if (role !== "presiding") return fail("Закрыть заседание может председательствующий.");
    const [s] = await sql`select * from court_sessions where code = ${m.code}`;
    const mem = await sql`select m.role, pr.nick, pr.judge_pos from court_session_members m join profiles pr on pr.id = m.user_id where m.code = ${m.code}`;
    const panel = mem.filter((x) => SES_PANEL.includes(x.role) || x.role === "secretary").map((x) => ({ nick: x.nick, role: x.role, roleName: SES_ROLE[x.role], pos: JUDGE_POS[x.judge_pos] || "" }));
    if (s && s.case_id && panel.length)
      await sql`update court_cases set panel = ${sql.json(panel)}, judge = ${(panel.find((x) => x.role === "presiding") || panel[0]).nick}, updated_at = now() where id = ${s.case_id}`;
    await sql`delete from court_sessions where code = ${m.code}`;
    return { ok: true, ses: null, panel };
  }
  return fail("Неизвестное действие.");
}
const sesSig = (s) => (/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(String(s || "")) && String(s).length < 90000 ? String(s) : "");

// 97: закон на дату — ближайшая к дате версия файла законов из истории репозитория
const lawAtCache = new Map();
async function lawAt(p, b) {
  if (!LAWS_KEY) return fail("Законы на сервере ещё не подключены.");
  if (!(await hit(`lawat:${p.id}`, 30, 3600))) return fail(RATE_MSG, { code: "rate" });
  const server = sv(p), day = /^\d{4}-\d{2}-\d{2}$/.test(String(b.date || "")) ? String(b.date) : "";
  if (!day) return fail("Выберите дату.");
  const until = new Date(Date.parse(day + "T23:59:59+03:00")).toISOString();
  const path = "update/laws" + lawsSfx(server) + ".enc";
  let sha = "", at = "";
  try {
    const r = await fetch(`https://api.github.com/repos/${GH_REPO}/commits?path=${encodeURIComponent(path)}&until=${until}&per_page=1`,
      { headers: { accept: "application/vnd.github+json", "user-agent": "senko-bot", ...(GH_LAWS_TOKEN ? { authorization: `Bearer ${GH_LAWS_TOKEN}` } : {}) }, signal: AbortSignal.timeout(15000) });
    const j = await r.json();
    if (Array.isArray(j) && j[0]) { sha = j[0].sha; at = j[0].commit && j[0].commit.committer && j[0].commit.committer.date; }
  } catch (e) { console.error("law_at commits", e); }
  if (!sha) return fail("На эту дату сохранённой версии законов нет: история начинается с первого автообновления законов.");
  let data = lawAtCache.get(server + ":" + sha);
  if (!data) {
    const r = await fetch(`https://raw.githubusercontent.com/${GH_REPO}/${sha}/${path}`, { signal: AbortSignal.timeout(60000) });
    if (!r.ok) return fail("Не удалось получить версию законов (" + r.status + ").");
    const gz = await lawsDecrypt(new Uint8Array(await r.arrayBuffer()));
    data = JSON.parse(await new Response(new Blob([gz]).stream().pipeThrough(new DecompressionStream("gzip"))).text());
    if (lawAtCache.size > 6) lawAtCache.clear();
    lawAtCache.set(server + ":" + sha, data);
  }
  const laws = Array.isArray(data.laws) ? data.laws : Array.isArray(data) ? data : [];
  const id = String(b.id || ""), title = String(b.title || "").toLowerCase();
  const l = laws.find((x) => String(x.id) === id) || laws.find((x) => String(x.title || "").toLowerCase() === title);
  if (!l) return fail("В версии законов на эту дату такого закона ещё не было.", { at });
  return { ok: true, at, law: { id: l.id, title: l.title, text: l.text, edited: l.edited || "", posted: l.posted || "" } };
}

// ───────────── 3.5: публичный сайт ─────────────
// Законы с форума Majestic публичные; сайт показывает их без входа. Выключается флагом pub35 («off»).
async function pubOpen() {
  return (await flagsNow()).pub35 !== "off";
}
async function pubLaws(b, ip) {
  if (!(await pubOpen())) return fail("Справочник на сайте сейчас выключен.", { code: "off" });
  if (!LAWS_KEY) return fail("Законы на сервере ещё не подключены.", { code: "laws_off" });
  if (!(await hit(`pl:${ip}`, 60, 3600))) return fail(RATE_MSG, { code: "rate" });
  const server = parseServer(b.server) || DEFAULT_SERVER;
  let L;
  try {
    L = await lawsLoad(server, "");
  } catch (e) {
    if (e && e.none) return fail(`Законы сервера ${srvName(server)} ещё не собраны с форума.`, { code: "laws_none", server });
    console.error("pub_laws", e);
    return fail("Не удалось получить законы. Попробуйте позже.", { code: "server" });
  }
  const meta = { server, name: srvName(server), sig: L.sig, updatedAt: L.updatedAt, checkedAt: L.checkedAt };
  if (b.sig && String(b.sig) === L.sig) return { ok: true, same: true, ...meta };
  return { ok: true, ...meta, gz: b64(L.gz) };
}
// Лента изменений законов: пишется в lawsChanged после каждой синхронизации с форумом
async function pubChanges(b, ip) {
  if (!(await pubOpen())) return fail("Лента изменений на сайте сейчас выключена.", { code: "off" });
  if (!(await hit(`pc:${ip}`, 120, 3600))) return fail(RATE_MSG, { code: "rate" });
  const server = parseServer(b.server) || 0;
  const sql = db();
  const rows = await sql`select server, kind, title, arts, at from law_changes
                         where ${server ? sql`server = ${server}` : sql`true`} order by id desc limit 100`;
  return { ok: true, items: rows.map((r) => ({ server: r.server, name: srvName(r.server), type: r.kind, title: r.title, arts: r.arts, at: r.at })) };
}
// Цифры проекта на главной: считаются не чаще раза в сутки
async function pubStats(ip) {
  if (!(await hit(`ps:${ip}`, 60, 3600))) return fail(RATE_MSG, { code: "rate" });
  const c = await getSetting("pub_stats", null);
  if (c && c.at && Date.now() - c.at < 24 * 3600e3) return { ok: true, ...c };
  const sql = db();
  const [u] = await sql`select count(*)::int n, count(distinct (org, server))::int orgs from profiles where not banned`;
  const [a] = await sql`select count(*)::int n from ai_log where ok`;
  const out = { users: u.n, orgs: u.orgs, servers: Object.keys(SERVERS).length, ai: a.n, at: Date.now() };
  await setSetting("pub_stats", out);
  return { ok: true, ...out };
}
// ───────────── 3.5.3: вход через Discord ─────────────
// Discord только подтверждает личность: войти можно в аккаунт, к которому этот Discord привязан в кабинете (регистрации через Discord нет).
// Поток один для программы, веб-версии и панели: dc_auth_start → браузер → Discord → сайт /auth/discord/ (dc_auth_cb) → клиент опрашивает dc_auth_poll.
// В панель по-прежнему нужен пароль панели: Discord заменяет только логин и пароль аккаунта.
// Нужны секрет DISCORD_CLIENT_SECRET и адрес возврата https://senko-assistant.site/auth/discord/ в Discord Developer Portal → OAuth2 → Redirects.
const DC_CLIENT_ID = Deno.env.get("DISCORD_CLIENT_ID") || "1564239530981204018";
const DC_CLIENT_SECRET = Deno.env.get("DISCORD_CLIENT_SECRET") || "";
const DC_REDIRECT = Deno.env.get("DISCORD_REDIRECT_URI") || SITE_URL + "/auth/discord/";
const DC_PURPOSES = ["login", "panel", "link"];
async function dcAuthStart(b, ip) {
  if (!DC_CLIENT_SECRET) return fail("Вход через Discord пока не настроен. Войдите по логину и паролю.", { code: "dc_off" });
  const purpose = DC_PURPOSES.includes(b.purpose) ? b.purpose : "login";
  if (!(await hit(`dcs:${ip}`, 20, 600))) return fail(RATE_MSG, { code: "rate" });
  let uid = null;
  if (purpose === "link") {
    const { p, err } = await who(b);
    if (err) return err;
    uid = p.id;
  }
  const state = rand(24), pk = rand(24);
  const sql = db();
  await sql`delete from dc_auth where expires_at < now() - interval '1 hour'`;
  await sql`insert into dc_auth (state, pk_hash, purpose, user_id, expires_at) values (${state}, ${await sha256(pk)}, ${purpose}, ${uid}, now() + interval '10 minutes')`;
  const url = "https://discord.com/oauth2/authorize?" + new URLSearchParams({ client_id: DC_CLIENT_ID, response_type: "code", scope: "identify", redirect_uri: DC_REDIRECT, state, prompt: "none" }).toString(); // prompt=none: кто уже разрешал вход, не видит окно подтверждения повторно
  return { ok: true, url, state, pk, ttl: 600 };
}
// Страница сайта /auth/discord/ передаёт сюда код и state, которые вернул Discord
async function dcAuthCallback(b, ip) {
  if (!DC_CLIENT_SECRET) return fail("Вход через Discord пока не настроен.");
  if (!(await hit(`dcc:${ip}`, 30, 600))) return fail(RATE_MSG, { code: "rate" });
  const state = String(b.state || ""), code = String(b.code || "");
  if (!/^[0-9a-f]{48}$/.test(state)) return fail("Ссылка входа устарела. Начните вход заново.");
  const sql = db();
  const [row] = await sql`select * from dc_auth where state = ${state} and expires_at > now()`;
  if (!row) return fail("Ссылка входа устарела. Начните вход заново.");
  if (row.done) return { ok: true, purpose: row.purpose, msg: "Готово. Вернитесь в программу." };
  if (b.error || !code) {
    await sql`update dc_auth set done = true, error = ${"Вход через Discord отменён."} where state = ${state}`;
    return fail("Вход отменён. Можно закрыть эту вкладку.");
  }
  let me = null;
  try {
    const tr = await fetch("https://discord.com/api/oauth2/token", {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: DC_CLIENT_ID, client_secret: DC_CLIENT_SECRET, grant_type: "authorization_code", code, redirect_uri: DC_REDIRECT }),
      signal: AbortSignal.timeout(15000),
    });
    const tj = await tr.json().catch(() => ({}));
    if (!tr.ok || !tj.access_token) throw new Error("token " + tr.status + " " + (tj.error || ""));
    const ur = await fetch("https://discord.com/api/users/@me", { headers: { authorization: "Bearer " + tj.access_token }, signal: AbortSignal.timeout(15000) });
    me = await ur.json().catch(() => null);
    if (!ur.ok || !me || !/^\d{5,25}$/.test(String(me.id || ""))) throw new Error("me " + ur.status);
  } catch (e) {
    console.error("dc_auth", e);
    await sql`update dc_auth set done = true, error = ${"Discord не подтвердил вход. Попробуйте ещё раз."} where state = ${state}`;
    return fail("Discord не подтвердил вход. Попробуйте ещё раз.");
  }
  const did = String(me.id), dname = clean(me.global_name || me.username || "", 40);
  if (row.purpose === "link") {
    const [other] = await sql`select login from profiles where discord_uid = ${did} and id <> ${row.user_id}`;
    if (other) {
      await sql`update dc_auth set done = true, error = ${"Этот Discord уже привязан к другому аккаунту Senko. Сначала отвяжите его там."} where state = ${state}`;
      return fail("Этот Discord уже привязан к другому аккаунту Senko. Сначала отвяжите его там.");
    }
    const [p] = await sql`update profiles set discord_uid = ${did}, discord_uname = ${dname} where id = ${row.user_id} returning login`;
    await sql`update dc_auth set done = true, discord_id = ${did}, discord_name = ${dname} where state = ${state}`;
    if (p) await audit(p.login, "dc_link", p.login, { discord: dname });
    return { ok: true, purpose: "link", msg: `Discord «${dname}» привязан. Теперь можно входить через Discord. Вернитесь в программу.` };
  }
  await sql`update dc_auth set done = true, discord_id = ${did}, discord_name = ${dname} where state = ${state}`;
  return { ok: true, purpose: row.purpose, msg: "Вход подтверждён. Вернитесь в " + (row.purpose === "panel" ? "панель" : "программу") + "." };
}
// Клиент, начавший вход, ждёт результат (pk знает только он: по одной ссылке из браузера сессию не получить)
async function dcAuthPoll(b, ip, ua) {
  const state = String(b.state || ""), pk = String(b.pk || "");
  if (!/^[0-9a-f]{48}$/.test(state) || !/^[0-9a-f]{48}$/.test(pk)) return fail("Неверный запрос.");
  if (!(await hit(`dcp:${state}`, 400, 900))) return fail(RATE_MSG, { code: "rate" });
  const sql = db();
  const [row] = await sql`select * from dc_auth where state = ${state}`;
  if (!row || !safeEq(await sha256(pk), row.pk_hash)) return fail("Вход не найден. Начните заново.", { code: "dc_gone" });
  if (!row.done) return new Date(row.expires_at).getTime() < Date.now() ? fail("Время на вход вышло. Начните заново.", { code: "dc_gone" }) : { ok: true, pending: true };
  // 3.7: при двухфакторной защите вход через Discord тоже просит код; запрос не удаляем, пока код не введён
  if (!row.error && row.purpose !== "link" && row.discord_id) {
    const pz = (await sql`select * from profiles where discord_uid = ${row.discord_id}`)[0];
    if (pz && pz.totp_on && !pz.banned) {
      const oe = await otpGate(pz, b, ip);
      if (oe) return oe;
    }
  }
  await sql`delete from dc_auth where state = ${state}`;
  if (row.error) return fail(row.error, { code: "dc_err" });
  if (row.purpose === "link") {
    const p = await profileById(row.user_id);
    return { ok: true, linked: true, user: p ? pub(p) : null };
  }
  const p0 = (await sql`select * from profiles where discord_uid = ${row.discord_id}`)[0] || null;
  const p = await liftExpiredBan(p0);
  if (!p) return fail(`Discord «${row.discord_name || row.discord_id}» не привязан ни к одному аккаунту. Войдите по логину и паролю и привяжите Discord в личном кабинете (раздел «Безопасность»).`, { code: "dc_unknown" });
  if (row.purpose === "panel") {
    const key = normCode(b.key);
    const [k] = await sql`select key_hash from panel_keys where user_id = ${p.id}`;
    if (!PANEL_RANKS.includes(p.rank) || !key || !k || !safeEq(await sha256(key), k.key_hash)) {
      await logIn(p.id, "fail", { ver: "панель · Discord", os: browserName(ua) }, ip);
      return fail("Неверный пароль панели или нет доступа к панели.");
    }
    if (p.banned) return fail(banMsg(p), { code: "banned" });
    await sql`delete from panel_sessions where expires_at < now() or last_at < now() - make_interval(mins => ${PANEL_IDLE_MIN})`;
    const token = rand(32);
    await sql`insert into panel_sessions (token_hash, user_id, expires_at, ip, ua)
              values (${await sha256(token)}, ${p.id}, now() + make_interval(hours => ${PANEL_HOURS}), ${ipShort(ip)}, ${clean(browserName(ua), 60)})`;
    await sql`update panel_keys set last_used_at = now() where user_id = ${p.id}`;
    const a = panelActor(p);
    await audit(a.label, "panel_login", p.login, { ip: ipShort(ip), ua: browserName(ua), via: "discord" });
    await logIn(p.id, "login", { ver: "панель · Discord", os: browserName(ua) }, ip);
    const where = `IP ${ipShort(ip) || "неизвестен"}, ${browserName(ua)}`;
    const msg = `🛡 <b>Вход в панель через Discord</b>: ${esc(p.login)} (${RANKS[p.rank]})\n${esc(where)}, ${fmtDate(new Date())}`;
    if (OWNER_TG) await send(OWNER_TG, msg + `\nЕсли это были не вы: /panel off ${esc(p.login)}`);
    if (p.rank === "moderator" && p.tg_id != null) await send(String(p.tg_id), msg + "\nЕсли это были не вы, напишите владельцу и смените пароль: /panel");
    return { ok: true, ptoken: token, me: panelMe(p, a) };
  }
  if (p.banned) return fail(banMsg(p), { code: "banned" });
  if (p.approval && p.approval !== "ok") return fail(approvalMsg(p), { code: p.approval });
  const token = await newSession(p.id, !!b.remember, b, ip);
  await sql`update profiles set last_seen = now() where id = ${p.id}`;
  await secAfterLogin(p, b, ip);
  await noteClient(p, b, ip);
  await logIn(p.id, "login", { ...b, ver: String(b.ver || "") + " · Discord" }, ip);
  maybeCleanup();
  return { ok: true, token, user: pub(p), sys: await sysFor(p) };
}
async function dcUnlink(b) {
  const { p, err } = await who(b);
  if (err) return err;
  if (!p.discord_uid) return { ok: true, user: pub(p) };
  const [np] = await db()`update profiles set discord_uid = null, discord_uname = '' where id = ${p.id} returning *`;
  await audit(p.login, "dc_unlink", p.login, {});
  return { ok: true, user: pub(np) };
}

// ───────────── 3.5.7: подсказки под сервер (программа запрашивала srv_cfg с 2.9, на сервере его не было) ─────────────
// Текст Миранды и замена номеров статей в подсказках, написанных по законам Boston; «проверено» убирает предупреждение в программе.
const SRVCFG_REF = /^\d{1,3}(?:\.\d{1,3}){0,3}$/;
function srvCfgClean(c) {
  c = c && typeof c === "object" ? c : {};
  const refs = {};
  if (c.refs && typeof c.refs === "object") for (const [k, v] of Object.entries(c.refs).slice(0, 300)) if (SRVCFG_REF.test(String(k)) && SRVCFG_REF.test(String(v))) refs[String(k)] = String(v);
  return { miranda: String(c.miranda || "").replace(/\r/g, "").trim().slice(0, 1500), refs, verified: !!c.verified };
}
async function srvCfgApi(b) {
  const { p, err } = await who(b);
  if (err) return err;
  const server = sv(p);
  return { ok: true, server, cfg: srvCfgClean(await getSetting("srv_cfg_" + server, {})) };
}
async function panelSrvCfg(b, a) {
  if (b.op === "srvcfg_get") {
    const out = {};
    for (const id of Object.keys(SERVERS)) out[id] = { name: SERVERS[id].name, cfg: srvCfgClean(await getSetting("srv_cfg_" + id, {})) };
    return { ok: true, servers: out };
  }
  const server = parseServer(b.server);
  if (!server) return fail("Неизвестный сервер.");
  const cfg = srvCfgClean(b.cfg);
  await setSetting("srv_cfg_" + server, cfg);
  await audit(a.label, "srv_cfg", srvName(server), { refs: Object.keys(cfg.refs).length, miranda: !!cfg.miranda, verified: cfg.verified });
  return { ok: true, server, cfg };
}

// Рейтинг недели на сайте: только те, кто сам включил галочку в кабинете (profiles.pub_board)
async function pubBoardOpt(b) {
  const { p, err } = await who(b);
  if (err) return err;
  if (b.on == null) return { ok: true, on: !!p.pub_board };
  if (!(await hit(`pbo:${p.id}`, 20, 3600))) return fail(RATE_MSG, { code: "rate" });
  const [np] = await db()`update profiles set pub_board = ${!!b.on} where id = ${p.id} returning pub_board`;
  await audit(p.login, "pub_board", p.login, { on: !!np.pub_board });
  return { ok: true, on: !!np.pub_board };
}
async function pubBoard(b, ip) {
  if (!(await pubOpen())) return fail("Рейтинг на сайте сейчас выключен.", { code: "off" });
  if ((await flagsNow()).rate35 === "off") return fail("Рейтинг на сайте сейчас выключен.", { code: "off" });
  if (!(await hit(`pbd:${ip}`, 60, 3600))) return fail(RATE_MSG, { code: "rate" });
  const server = parseServer(b.server) || DEFAULT_SERVER;
  const key = "pub_board_" + server;
  const c = await getSetting(key, null);
  if (c && c.at && Date.now() - c.at < 10 * 60e3) return { ok: true, ...c };
  const w = mskWeek();
  const all = await weekStats(null, w, false, server);
  const [{ ids }] = await db()`select coalesce(array_agg(id), '{}') ids from profiles where pub_board and server = ${server}`;
  const okIds = new Set((ids || []).map(String));
  const list = all.filter((x) => okIds.has(String(x.id)) && (x.wxp > 0 || x.det > 0)).sort(byWxp).slice(0, 30)
    .map((x, i) => ({ n: i + 1, nick: x.nick, org: x.org, wxp: x.wxp, det: x.det, tests: x.tests, lvl: x.lvl.name }));
  const out = { server, name: srvName(server), from: w.start, list, at: Date.now() };
  await setSetting(key, out);
  return { ok: true, ...out };
}
// Сообщение об ошибке с сайта (без входа): владельцу в Telegram и в панель, как из программы
async function pubBug(b, ip) {
  if (!(await pubOpen())) return fail("Форма сейчас выключена. Напишите в программе: меню → «Сообщить об ошибке».", { code: "off" });
  if (String(b.hp || "")) return { ok: true, id: "0" }; // скрытое поле: заполняют только боты
  if (!(await hit(`pb:${ip}`, 3, 86400))) return fail("С этого адреса можно отправить не больше 3 сообщений в сутки.", { code: "rate" });
  if (!(await hit("pb:all", 60, 3600))) return fail(RATE_MSG, { code: "rate" });
  const text = String(b.text == null ? "" : b.text).replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, " ").trim().slice(0, 2000);
  if (text.length < 10) return fail("Опишите проблему подробнее (хотя бы 10 символов).");
  const contact = clean(b.contact, 120);
  const page = clean(b.page, 200);
  const ua = clean(b.ua, 200);
  const [r] = await db()`insert into bug_reports (user_id, text, app_version, source, contact) values (null, ${text}, ${"сайт"}, ${"site"}, ${contact}) returning id`;
  if (OWNER_TG) {
    await send(OWNER_TG, `🐞 <b>Сообщение об ошибке #${r.id}</b> · с сайта\nКонтакт: ${esc(contact || "не указан")}${page ? "\nСтраница: " + esc(page) : ""}${ua ? "\nБраузер: " + esc(ua) : ""}\n\n${esc(text)}`);
  }
  return { ok: true, id: String(r.id) };
}

// ИИ для программы и сайта: запрос подписывается здесь (ключ AI_KEY), лимит считается по аккаунту
async function hmacHex(secret, msg) {
  const k = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", k, enc.encode(msg)));
}
// ───────────── 3.8 (п. 35): вход в веб-версию по QR-коду из программы ─────────────
// Программа (уже вошедшая) создаёт одноразовый код на 3 минуты; телефон открывает ссылку с кодом и получает свою сессию.
// Код хранится только хэшем, срабатывает один раз; о входе пользователь получает сообщение в программе.
async function qrLoginApi(b, ip) {
  const op = String(b.op || "");
  const sql = db();
  if (op === "create") {
    const { p, err } = await who(b);
    if (err) return err;
    if (!(await hit(`qrc:${p.id}`, 10, 3600))) return fail(RATE_MSG, { code: "rate" });
    const code = rand(16);
    await sql`delete from qr_logins where expires_at < now()`;
    await sql`insert into qr_logins (code_hash, user_id, expires_at) values (${await sha256("qr:" + code)}, ${p.id}, now() + interval '3 minutes')`;
    return { ok: true, url: SITE_URL + "/app/login/?qr=" + code, ttl: 180 };
  }
  if (op === "redeem") {
    if (!(await hit(`qrr:${ip}`, 20, 600))) return fail(RATE_MSG, { code: "rate" });
    const code = String(b.code || "");
    if (!/^[0-9a-f]{32}$/.test(code)) return fail("Код входа неверный. Покажите QR-код в программе ещё раз.");
    const [r] = await sql`delete from qr_logins where code_hash = ${await sha256("qr:" + code)} and expires_at > now() returning user_id`;
    if (!r) return fail("Код входа устарел или уже использован. Покажите QR-код в программе ещё раз.", { code: "qr_gone" });
    const p = await liftExpiredBan(await profileById(r.user_id));
    if (!p) return fail("Аккаунт не найден.");
    if (p.banned) return fail(banMsg(p), { code: "banned" });
    if (p.approval && p.approval !== "ok") return fail(approvalMsg(p), { code: p.approval });
    const token = await newSession(p.id, true, { ...b, ver: String(b.ver || "web") + " · QR" }, ip);
    await logIn(p.id, "login", { ...b, ver: String(b.ver || "web") + " · QR" }, ip);
    await secNotice(p, "📱 Вход в веб-версию по QR-коду", `Веб-версия открыта по QR-коду из программы${b.os ? " (" + clean(b.os, 40) + ")" : ""}, ${fmtDate(new Date())}. Если это были не вы, завершите этот вход в личном кабинете (Безопасность → Мои устройства).`);
    return { ok: true, token, user: pub(p), sys: await sysFor(p) };
  }
  return fail("Неизвестное действие.");
}

// ───────────── 3.8 (п. 15): глоссарий терминов ─────────────
// Хранится в bot_settings.glossary: [{t: термин, d: объяснение, refs: «ПК ст. 17, УК ст. 12.8»}]. Владелец правит его в панели,
// программа и веб-версия получают через действие glossary, ИИ видит термины, которые встречаются в вопросе.
const GLOSS_DEFAULT = [
  { t: "Задержание", d: "Кратковременное ограничение свободы подозреваемого до решения по делу: арест, наказание или освобождение. Порядок задержания расписан в Процессуальном кодексе вашего сервера.", refs: "" },
  { t: "Процессуальный час", d: "Срок, в течение которого после задержания нужно принять решение. Пока он не истёк, проводят проверку, допрос и вызовы; на время некоторых действий (ожидание адвоката, прокурора) отсчёт может приостанавливаться.", refs: "" },
  { t: "Законное требование", d: "Требование сотрудника при исполнении, основанное на законе: остановиться, предъявить документы, снять маску и т. п. Невыполнение законного требования само по себе может быть правонарушением.", refs: "" },
  { t: "Правило Миранды", d: "Разъяснение задержанному его прав: молчать, иметь адвоката, совершить звонок. Показания, полученные до разъяснения прав, обычно признаются недопустимыми.", refs: "" },
  { t: "Юрисдикция", d: "Какие ведомства вправе работать по статье: региональная (R), регионально-федеральная (F/R), федеральная (F), военная (M), финансовая (E). Статьи вне своей юрисдикции передают профильному ведомству.", refs: "" },
  { t: "Неприкосновенность", d: "Особый порядок задержания и привлечения к ответственности для отдельных должностных лиц (судьи, руководители органов власти и др.). Список и порядок — в законах сервера.", refs: "" },
  { t: "Розыск", d: "Уровень розыска (звёзды) по статье УК. От него зависят срок в КПЗ и сумма залога.", refs: "" },
  { t: "Залог", d: "Сумма, за которую задержанного можно освободить до решения по делу, если закон это допускает. Обычно считается от уровня розыска.", refs: "" },
  { t: "Недопустимые доказательства", d: "Сведения и предметы, полученные с нарушением закона. Они не могут быть основанием обвинения.", refs: "" },
  { t: "Ордер", d: "Документ, разрешающий задержание, обыск или арест конкретного лица. Задержание по ордеру проводится по своему порядку.", refs: "" },
];
const glossClean = (L) => (Array.isArray(L) ? L : []).slice(0, 300).map((x) => ({ t: clean(x && x.t, 60), d: String((x && x.d) || "").replace(/\s+/g, " ").trim().slice(0, 700), refs: clean(x && x.refs, 120) })).filter((x) => x.t && x.d);
let glossCache = null;
async function glossRows() {
  if (glossCache && Date.now() - glossCache.at < 60e3) return glossCache.rows;
  const v = await getSetting("glossary", null);
  const rows = v == null ? GLOSS_DEFAULT : glossClean(v);
  glossCache = { at: Date.now(), rows };
  return rows;
}
async function glossApi(b) {
  const { err } = await who(b);
  if (err) return err;
  return { ok: true, items: await glossRows() };
}

// 3.9: шаг 1 ИИ — перевод сообщения на язык законов для поиска статей (быстрая бесплатная модель в ИИ-прокси)
async function aiPlan(b) {
  const { p, err } = await who(b);
  if (err) return err;
  if (!AI_KEY) return fail("ИИ не подключён.", { code: "ai_off" });
  if (!(await hit(`aiplan:${p.id}`, 200, 86400))) return { ok: false, topic: "law", terms: [] };
  const q = String(b.q == null ? "" : b.q).replace(/\s+/g, " ").trim().slice(0, 1500);
  if (q.length < 3) return fail("Пусто.");
  const prev = String(b.prev == null ? "" : b.prev).replace(/\s+/g, " ").trim().slice(0, 500);
  const cid = (await sha256("web:" + p.id)).slice(0, 32);
  const ts = String(Date.now());
  try {
    const r = await fetch(AI_URL + "/plan", {
      method: "POST",
      headers: { "content-type": "application/json", "x-senko-cid": cid, "x-senko-ts": ts, "x-senko-sig": await hmacHex(AI_KEY, cid + "." + ts) },
      body: JSON.stringify({ q, prev }),
      signal: AbortSignal.timeout(9000),
    });
    const j = await r.json().catch(() => null);
    if (!j || !j.ok) return { ok: false, topic: "law", terms: [] };
    return { ok: true, topic: String(j.topic || "law"), terms: (Array.isArray(j.terms) ? j.terms : []).map((x) => clean(x, 80)).filter(Boolean).slice(0, 6) };
  } catch (e) {
    return { ok: false, topic: "law", terms: [] };
  }
}
// 3.9: «Данные проекта» для ИИ — только то, что человек и так видит: владелец, модераторы, руководство ведомств своего сервера
// (ник и должность), сотрудники своего ведомства (ник, должность, звание), сколько людей в ведомствах. Без статиков и контактов.
const PEOPLE_RE = /руковод|лидер|начальник|модератор|админ|владел|создател|разработчик|коллег|сослуживц|состав (ведомств|организац|отдел|lspd|lscsd|fib|sang|government)|сколько (человек|людей|сотрудник)|кто (сейчас |у нас |в |из )?(глава|шериф|директор|начальник|губернатор|прокурор|руковод)/i;
async function aiPeople(p) {
  const sql = db();
  const srv = sv(p);
  const L = ["Владелец и разработчик программы Senko Assistant — Hanami Senko (связь: Discord hanamis1)."];
  const mods = await sql`select nick, staff_server from profiles where rank = 'moderator' and not banned order by lower(nick) limit 40`;
  const modsHere = mods.filter((m) => !m.staff_server || m.staff_server === srv);
  L.push("Модераторы программы (" + srvName(srv) + "): " + (modsHere.length ? modsHere.map((m) => m.nick).join(", ") : "не назначены") + ".");
  const leaders = await sql`select nick, org, post from profiles where rank = 'leader' and server = ${srv} and not banned and approval = 'ok' order by org, lower(nick) limit 80`;
  const byOrg = {};
  leaders.forEach((x) => (byOrg[x.org] = byOrg[x.org] || []).push(x.nick + (x.post ? " (" + x.post + ")" : "")));
  const cnt = await sql`select org, count(*)::int n from profiles where server = ${srv} and not banned and approval = 'ok' group by org`;
  const C = Object.fromEntries(cnt.map((r) => [r.org, r.n]));
  L.push("Руководство ведомств на сервере " + srvName(srv) + " (роль «Руководство» в программе):");
  DEPTS.forEach((d) => L.push("• " + d + ": " + (byOrg[d] ? byOrg[d].join(", ") : "в программе не назначено") + "; аккаунтов в программе: " + (C[d] || 0) + "."));
  if (!colLocked(p)) {
    const people = await sql`select id, nick, post, rank, org_at, created_at from profiles where org = ${p.org} and server = ${srv} and not banned and approval = 'ok' order by lower(nick) limit 120`;
    const vis = people.filter((x) => x.id === p.id || !colLocked(x));
    const st = await statsOf(vis.map((x) => x.id));
    L.push("Сотрудники ведомства пользователя (" + p.org + "), ник — должность — звание в программе:");
    vis.forEach((x) => L.push("• " + x.nick + (x.post ? " — " + x.post : "") + " — " + lvOf((st[x.id] || { xp: 0 }).xp).name + (x.rank === "leader" ? " — руководство" : x.rank === "moderator" ? " — модератор" : "")));
  }
  L.push("Программные роли: пользователь, руководство (видит сотрудников своего ведомства), модератор программы, владелец. Роли руководства и модератора выдаёт только владелец.");
  return L.join("\n").slice(0, 6000);
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
  // 3.9: длинные описания ситуаций (до 1500 знаков), до 14 статей и история диалога
  const q = String(b.q == null ? "" : b.q).replace(/\s+/g, " ").trim().slice(0, 1500);
  if (q.length < 3) return fail("Напишите вопрос подробнее.");
  const hist = (Array.isArray(b.hist) ? b.hist : []).slice(-6).map((t) => ({ q: String((t && t.q) || "").replace(/\s+/g, " ").trim().slice(0, 1500), a: String((t && t.a) || "").trim().slice(0, 2500) })).filter((t) => t.q && t.a);
  const ctx = (Array.isArray(b.ctx) ? b.ctx : []).slice(0, 14).map((c) => ({ ref: clean(c && c.ref, 80), text: String((c && c.text) || "").slice(0, 2000) })).filter((c) => c.ref && c.text);
  // 3.8: термины глоссария, которые встречаются в вопросе, ИИ получает как пояснение (не больше трёх)
  try {
    const ql = q.toLowerCase().replace(/ё/g, "е");
    for (const g of (await glossRows()).filter((g) => ql.includes(g.t.toLowerCase().replace(/ё/g, "е").slice(0, Math.max(4, g.t.length - 2)))).slice(0, 3))
      ctx.push({ ref: "Глоссарий: " + g.t, text: g.d + (g.refs ? " (" + g.refs + ")" : "") });
  } catch (e) {}
  // 3.9: вопрос о людях и организациях — добавляем «Данные проекта»
  try {
    if (b.topic === "people" || PEOPLE_RE.test(q + " " + hist.map((t) => t.q).slice(-1).join(" "))) ctx.unshift({ ref: "Данные проекта", text: await aiPeople(p) });
  } catch (e) {
    console.error("aiPeople", e);
  }
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
      body: JSON.stringify({ short: !!b.short, clar: clar && !b.mode, q, ctx, hist, srv: sv(p), mode: AI_MODES.includes(b.mode) ? b.mode : "" }),
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
