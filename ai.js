"use strict";
// ИИ-помощник (Senko Assistant). Работает в главном процессе:
//   1) просит окно памятки найти подходящие статьи (window.__senkoAiContext в index.html);
//   2) отправляет вопрос и найденные выдержки на сервер Senko (действие "ai_ask"),
//      сервер подписывает запрос к своему ИИ-прокси (Cloudflare Worker, см. worker/) и сохраняет вопрос в журнал;
//   3) возвращает ответ и список статей-источников.
// Ключей в приложении НЕТ (с 2.2.1): ни ключей ИИ-провайдеров, ни ключа доступа к прокси. Нужен вход в аккаунт.
const { ipcMain } = require("electron");

const MIN_GAP_MS = 2500;      // не чаще одного вопроса в 2,5 секунды
const TIMEOUT_MS = 45000;

let ctx = null;               // { getWin, ask, vote }
let busy = false;
let lastAt = 0;
const logged = new Map();     // номер ответа в окне → номер записи журнала на сервере
let fseq = 0;

const configured = () => true;

async function retrieve(question) {
  const w = ctx.getWin();
  if (!w || w.isDestroyed()) return [];
  try {
    const r = await w.webContents.executeJavaScript(
      `(typeof window.__senkoAiContext==="function")?window.__senkoAiContext(${JSON.stringify(question)}):[]`, false);
    return Array.isArray(r) ? r.slice(0, 10) : [];
  } catch (e) {
    return [];
  }
}

async function local(question) {
  const w = ctx.getWin();
  if (!w || w.isDestroyed()) return null;
  try {
    const r = await w.webContents.executeJavaScript(
      `(typeof window.__senkoAiLocal==="function")?window.__senkoAiLocal(${JSON.stringify(question)}):null`, false);
    if (!r || typeof r.answer !== "string" || !r.answer) return null;
    const sources = (Array.isArray(r.sources) ? r.sources : []).slice(0, 10).map((s) => ({ ref: String((s && s.ref) || ""), go: String((s && s.go) || ""), lw: String((s && s.lw) || "") }));
    return { answer: r.answer.slice(0, 4000), sources };
  } catch (e) {
    return null;
  }
}

// Номер записи журнала (его возвращает сервер) нужен только для оценки 👍/👎
function track(logId) {
  if (!logId) return "";
  const fid = String(++fseq);
  logged.set(fid, logId);
  if (logged.size > 50) logged.delete(logged.keys().next().value);
  return fid;
}
async function vote(fid, v) {
  v = v === 1 || v === -1 ? v : 0;
  const id = logged.get(String(fid));
  if (!v || !id || typeof ctx.vote !== "function") return { ok: false, error: "Оценка недоступна." };
  const r = await ctx.vote(id, v);
  return r && r.ok ? { ok: true } : { ok: false, error: (r && r.error) || "Не удалось сохранить оценку." };
}

// Вопросы о создателе (Hanami Senko, Ханами, Kofemanchik и т. п.) не уходят в ИИ: на них свой ответ.
// Проверка идёт в приложении, поэтому работает и в окне ИИ, и в голосовом помощнике, без сервера и без лимита.
const CREATOR_ANSWERS = [
  "Прости, о своём создателе я говорить не могу. 🦊 Давай лучше вернёмся к законам Majestic RP.",
  "Это тайна, которую я хранить обязана: о своём создателе не рассказываю. Спроси меня лучше про статьи или штрафы.",
  "О моём создателе ничего не скажу, даже не уговаривай. 🦊 Чем помочь по законам?"
];
// латинские буквы, похожие на русские, приводим к русским (xaнaми → ханами)
const LOOKALIKE = { a: "а", c: "с", e: "е", o: "о", p: "р", x: "х", y: "у", k: "к", m: "м", t: "т", b: "в", h: "н" };
const CREATOR_RE = [
  /hanami|hanamy|hanamii|ханам[иіыуоа]|ханамк|ханамоч|ханамуш|ханамчик/,
  /kofemanchik|kofemanch|кофеманчик/,
  /(твой|твоего|твоему|твоим|твоем|твоя|твоей|программы|приложения|памятки|сенко|senko)\s+(создател|разработчик|автор|владел|хозя)/,
  /(создател|разработчик|автор|владел|хозя)\S*\s+(программ|приложени|памятк|сенко|senko|бота|тебя)/
];
// «кто тебя создал», «кто сделал сенко»: в одном предложении «кто/чей» + «создал/сделал…» + «тебя/программу…»
const WHO_MADE = [/(^|[^а-я])(кто|чей|чья|чье)([^а-я]|$)/, /созда|сдела|написа|разработа|придума/, /тебя|тебе|эт\S* (программ|приложени)|памятк|сенко|senko|бота|ассистент/];
function aboutCreator(question) {
  const low = String(question || "").toLowerCase().replace(/ё/g, "е");
  const mixed = low.replace(/[a-z]/g, (ch) => LOOKALIKE[ch] || ch);
  // «х а н а м и», «х.а.н.а.м.и» — склеиваем, если слово разбито на отдельные буквы
  const glued = /(?:^|[^a-zа-я])[a-zа-я](?:[\s.\-_*]+[a-zа-я]){3,}/.test(low) ? low.replace(/[\s.\-_*]+/g, "") : "";
  if ([low, mixed, glued, glued.replace(/[a-z]/g, (ch) => LOOKALIKE[ch] || ch)].some((t) => t && CREATOR_RE.some((re) => re.test(t)))) return true;
  return low.split(/[.!?\n]+/).some((part) => WHO_MADE.every((re) => re.test(part)));
}
let creatorTurn = 0;

async function ask(question, opts) {
  question = String(question || "").replace(/\s+/g, " ").trim().slice(0, 500);
  if (question.length < 3) return { ok: false, error: "Напишите вопрос подробнее." };
  if (aboutCreator(question)) {
    return { ok: true, answer: CREATOR_ANSWERS[creatorTurn++ % CREATOR_ANSWERS.length], left: null, cached: false, sources: [], fid: "" };
  }
  // 2.3: номер статьи без кодекса («17.1») и «какие законы знаешь» — ответ из памятки, без ИИ и без лимита
  const loc = await local(question);
  if (loc) return { ok: true, answer: loc.answer, left: null, cached: false, local: true, sources: loc.sources, fid: "" };
  if (busy) return { ok: false, error: "Предыдущий вопрос ещё обрабатывается." };
  if (Date.now() - lastAt < MIN_GAP_MS) return { ok: false, error: "Подождите пару секунд перед следующим вопросом." };
  busy = true; lastAt = Date.now();
  try {
    const found = await retrieve(question);
    const sources = found.map((f) => ({ ref: f.ref, go: f.go || "", lw: f.lw || "" }));
    const j = await ctx.ask({ short: !!(opts && opts.short), q: question, ctx: found.map((f) => ({ ref: String(f.ref || ""), text: String(f.text || "") })) }, TIMEOUT_MS);
    if (!j || !j.ok) {
      const error = j && j.code === "auth" ? "Войдите в аккаунт, чтобы задавать вопросы ИИ." : (j && j.error) || "ИИ-сервис не ответил. Попробуйте позже.";
      return { ok: false, error, limit: !!(j && j.limit), sources };
    }
    return { ok: true, answer: String(j.answer || ""), left: typeof j.left === "number" ? j.left : null, bonus: typeof j.bonus === "number" ? j.bonus : null, cached: !!j.cached, sources, fid: track(j.logId) };
  } catch (e) {
    return { ok: false, error: "Не удалось связаться с ИИ-сервисом. Проверьте подключение к интернету." };
  } finally {
    busy = false;
  }
}

function init(c) {
  ctx = c; // { getWin, ask, vote }
  ipcMain.handle("ai:ask", (e, q) => {
    const w = ctx.getWin();
    return w && e.sender === w.webContents ? ask(q) : { ok: false, error: "Недоступно." };
  });
  ipcMain.handle("ai:vote", (e, fid, v) => {
    const w = ctx.getWin();
    return w && e.sender === w.webContents ? vote(fid, v) : { ok: false, error: "Недоступно." };
  });
  ipcMain.on("ai:available", (e) => {
    const w = ctx.getWin();
    e.returnValue = !!(w && e.sender === w.webContents && configured());
  });
}

module.exports = { init, ask, configured, aboutCreator };
