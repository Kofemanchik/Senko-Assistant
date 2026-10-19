"use strict";
// ИИ-помощник (Senko Assistant). Работает в главном процессе:
//   1) просит окно памятки найти подходящие статьи (window.__senkoAiContext в index.html);
//   2) отправляет вопрос и найденные выдержки на свой прокси (Cloudflare Worker, см. worker/);
//   3) возвращает ответ и список статей-источников.
// Ключей ИИ-провайдеров в приложении НЕТ — они лежат только на прокси.
const { net, ipcMain } = require("electron");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

// ВАЖНО: после деплоя Worker впишите сюда его адрес (или задайте переменную окружения SENKO_AI_URL).
const AI_URL = process.env.SENKO_AI_URL || "https://senko-ai.senko-assistant.workers.dev";
const MIN_GAP_MS = 2500;      // не чаще одного вопроса в 2,5 секунды
const TIMEOUT_MS = 35000;

let ctx = null;               // { getWin, dataDir }
let busy = false;
let lastAt = 0;

const configured = () => !/YOUR-SUBDOMAIN/.test(AI_URL);

// Ключ доступа к прокси (на прокси он задан как APP_KEY). Кладётся в сборку из секрета AI_KEY (см. .github/workflows/build.yml).
function appKey() {
  if (process.env.AI_KEY) return String(process.env.AI_KEY);
  for (const f of [path.join(__dirname, "ai-key.json"), path.join(process.resourcesPath || "", "ai-key.json")]) {
    try { const j = JSON.parse(fs.readFileSync(f, "utf8")); if (j && j.key) return String(j.key); } catch (e) {}
  }
  return "";
}

// Анонимный идентификатор установки (нужен только для дневного лимита вопросов)
function clientId() {
  const f = path.join(ctx.dataDir(), "ai-client.json");
  try { const j = JSON.parse(fs.readFileSync(f, "utf8")); if (j && /^[a-f0-9-]{16,64}$/i.test(j.cid)) return j.cid; } catch (e) {}
  const cid = crypto.randomUUID();
  try { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify({ cid })); } catch (e) {}
  return cid;
}

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

async function ask(question, opts) {
  question = String(question || "").replace(/\s+/g, " ").trim().slice(0, 500);
  if (question.length < 3) return { ok: false, error: "Напишите вопрос подробнее." };
  if (!configured()) return { ok: false, error: "ИИ-помощник ещё не подключён: в ai.js не указан адрес сервиса." };
  const key = appKey();
  if (!key) return { ok: false, error: "В этой сборке нет ключа доступа к ИИ (файл ai-key.json) — установите последнюю версию с GitHub Releases." };
  if (busy) return { ok: false, error: "Предыдущий вопрос ещё обрабатывается." };
  if (Date.now() - lastAt < MIN_GAP_MS) return { ok: false, error: "Подождите пару секунд перед следующим вопросом." };
  busy = true; lastAt = Date.now();
  try {
    const found = await retrieve(question);
    const cid = clientId();
    const ts = String(Date.now());
    const sig = crypto.createHmac("sha256", key).update(cid + "." + ts).digest("hex");
    const res = await net.fetch(AI_URL.replace(/\/+$/, "") + "/ask", {
      method: "POST",
      headers: { "content-type": "application/json", "x-senko-cid": cid, "x-senko-ts": ts, "x-senko-sig": sig },
      body: JSON.stringify({ short: !!(opts && opts.short), q: question, ctx: found.map((f) => ({ ref: String(f.ref || ""), text: String(f.text || "") })) }),
      signal: AbortSignal.timeout(TIMEOUT_MS)
    });
    let j = null;
    try { j = await res.json(); } catch (e) {}
    const sources = found.map((f) => ({ ref: f.ref, go: f.go || "", lw: f.lw || "" }));
    if (!res.ok || !j || !j.ok) return { ok: false, error: (j && j.error) || "ИИ-сервис вернул ошибку (" + res.status + ").", limit: !!(j && j.limit), sources };
    return { ok: true, answer: String(j.answer || ""), left: typeof j.left === "number" ? j.left : null, cached: !!j.cached, sources };
  } catch (e) {
    return { ok: false, error: "Не удалось связаться с ИИ-сервисом. Проверьте подключение к интернету." };
  } finally {
    busy = false;
  }
}

function init(c) {
  ctx = c; // { getWin, dataDir }
  ipcMain.handle("ai:ask", (e, q) => {
    const w = ctx.getWin();
    return w && e.sender === w.webContents ? ask(q) : { ok: false, error: "Недоступно." };
  });
  ipcMain.on("ai:available", (e) => {
    const w = ctx.getWin();
    e.returnValue = !!(w && e.sender === w.webContents && configured());
  });
}

module.exports = { init, ask, configured };
