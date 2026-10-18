// Серверный парсер законодательной базы Majestic RP (XenForo).
// Запуск: node scripts/sync-laws.js   (нужны переменные FORUM_LOGIN и FORUM_PASSWORD)
// Результат: update/laws.json — его читает приложение Senko Assistant.
"use strict";
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const cheerio = require("cheerio");

const BASE = "https://forum.majestic-rp.ru";
const START = process.env.FORUM_START || BASE + "/forums/zakonodatel-naya-baza.1017/";
const OUT = path.join(__dirname, "..", "update", "laws.json");
const LOGIN = process.env.FORUM_LOGIN;
const PASS = process.env.FORUM_PASSWORD;
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const DELAY = 800;          // пауза между запросами, мс
const MAX_PAGES = 40;       // страниц списка на раздел
const MAX_POST_PAGES = 15;  // страниц одной темы

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jar = {};

function eatCookies(res) {
  const list = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [];
  for (const c of list) {
    const [kv] = c.split(";");
    const i = kv.indexOf("=");
    if (i < 1) continue;
    const k = kv.slice(0, i).trim(), v = kv.slice(i + 1).trim();
    if (!v || /expires=Thu, 01 Jan 1970/i.test(c)) delete jar[k]; else jar[k] = v;
  }
}
const cookieHeader = () => Object.keys(jar).map((k) => k + "=" + jar[k]).join("; ");

async function http(url, opts = {}, hops = 0) {
  await sleep(DELAY);
  const res = await fetch(url, {
    method: opts.method || "GET",
    redirect: "manual",
    headers: Object.assign({
      "User-Agent": UA, "Accept-Language": "ru-RU,ru;q=0.9", "Accept": "text/html,application/xhtml+xml",
      "Cookie": cookieHeader()
    }, opts.headers || {}),
    body: opts.body
  });
  eatCookies(res);
  if (res.status >= 300 && res.status < 400 && res.headers.get("location") && hops < 6) {
    const next = new URL(res.headers.get("location"), url).toString();
    return http(next, {}, hops + 1);
  }
  const text = await res.text();
  if (res.status === 403 || res.status === 503 || /Just a moment|cf-chl|Attention Required/i.test(text.slice(0, 4000))) {
    throw new Error("Форум отдал защиту от ботов (Cloudflare) или 403. Статус " + res.status + ", " + url);
  }
  if (!res.ok) throw new Error("HTTP " + res.status + " на " + url);
  return { text, url };
}
const page = async (url) => cheerio.load((await http(url)).text);

async function login() {
  if (!LOGIN || !PASS) throw new Error("Не заданы секреты FORUM_LOGIN / FORUM_PASSWORD.");
  let $ = await page(BASE + "/login/");
  const token = $('input[name="_xfToken"]').first().attr("value") || $("html").attr("data-csrf") || "";
  if (!token) throw new Error("Не найден _xfToken на странице входа (вёрстка форума изменилась?).");
  const body = new URLSearchParams({ login: LOGIN, password: PASS, remember: "1", _xfRedirect: BASE + "/", _xfToken: token });
  const r = await http(BASE + "/login/login", {
    method: "POST", body: body.toString(),
    headers: { "Content-Type": "application/x-www-form-urlencoded", "Referer": BASE + "/login/", "Origin": BASE }
  });
  $ = cheerio.load(r.text);
  if (/двухфакторн|two-step|верификац/i.test(r.text) && $('input[name="code"]').length) {
    throw new Error("У служебного аккаунта включена двухфакторная проверка. Отключите её для этого аккаунта.");
  }
  const chk = await page(START);
  if (chk("html").attr("data-logged-in") !== "true") {
    throw new Error("Вход не удался: неверный логин/пароль, капча или аккаунт заблокирован.");
  }
  return chk;
}

const abs = (h) => new URL(h, BASE).toString().split("#")[0];
const threadId = (u) => { const m = /\/threads\/[^/]*?\.?(\d+)\/?/.exec(u); return m ? m[1] : null; };

async function collectForum(url, section, seen, out, $first) {
  if (seen.has(url)) return;
  seen.add(url);
  let $ = $first || await page(url);
  const title = $(".p-title-value").first().text().trim();
  const sec = section || (url === START ? "" : title);
  const subs = [];
  $(".node--forum .node-title a, .node--category .node-title a").each((_, a) => {
    const h = $(a).attr("href"); if (h && /\/forums\//.test(h)) subs.push([abs(h), $(a).text().trim()]);
  });
  let cur = url, n = 0;
  for (;;) {
    $(".structItem--thread").each((_, el) => {
      const a = $(el).find(".structItem-title a").not(".labelLink").last();
      const h = a.attr("href"); if (!h) return;
      const id = threadId(h); if (!id || out.has(id)) return;
      out.set(id, { id, title: a.text().trim(), url: abs(h), section: sec });
    });
    const next = $("a.pageNav-jump--next").first().attr("href");
    if (!next || ++n >= MAX_PAGES) break;
    cur = abs(next); $ = await page(cur);
  }
  for (const [u, t] of subs) await collectForum(u, t, seen, out);
}

function textOf($, el) {
  const w = $(el).clone();
  w.find("script,style,.bbCodeBlock-expandLink,.js-lbImage").remove();
  w.find("br").replaceWith("\n");
  w.find("p,div,li,tr,h1,h2,h3,h4,h5,h6,blockquote").each((_, e) => { $(e).append("\n"); });
  return w.text().replace(/\u00a0/g, " ").split("\n").map((s) => s.replace(/[ \t]+/g, " ").trim())
    .filter((s, i, a) => s || (a[i - 1] && a[i - 1] !== "")).join("\n").trim();
}

async function readThread(t) {
  let url = t.url, parts = [], posted = "", edited = "", author = "", n = 0;
  for (;;) {
    const $ = await page(url);
    $("article.message--post").each((_, el) => {
      const a = $(el).attr("data-author") || "";
      if (!author) {
        author = a;
        posted = $(el).find(".message-attribution-main time").first().attr("datetime") || "";
        edited = $(el).find(".message-lastEdit time").first().attr("datetime") || "";
      }
      if (a !== author) return; // берём только сообщения автора темы
      const b = $(el).find(".message-body .bbWrapper").first();
      if (b.length) parts.push(textOf($, b));
    });
    const next = $("a.pageNav-jump--next").first().attr("href");
    if (!next || ++n >= MAX_POST_PAGES) break;
    url = abs(next);
  }
  const text = parts.join("\n\n").trim();
  if (!text) throw new Error("пустой текст темы " + t.url);
  return Object.assign({}, t, { text, posted, edited });
}

function lineDiff(oldT, newT) {
  const o = new Set(oldT.split("\n").map((s) => s.trim()).filter(Boolean));
  const n = new Set(newT.split("\n").map((s) => s.trim()).filter(Boolean));
  const add = [...n].filter((x) => !o.has(x)), del = [...o].filter((x) => !n.has(x));
  return { add: add.slice(0, 40), del: del.slice(0, 40), addN: add.length, delN: del.length };
}
const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");

async function main() {
  let prev = { laws: [], changes: [] };
  try { prev = JSON.parse(fs.readFileSync(OUT, "utf8")); } catch (e) {}
  const prevMap = new Map((prev.laws || []).map((l) => [l.id, l]));
  const first = !prevMap.size;
  const now = Date.now();

  const $start = await login();
  const list = new Map();
  await collectForum(START, "", new Set(), list, $start);
  console.log("Найдено тем:", list.size);
  if (!list.size || (prevMap.size && list.size < prevMap.size * 0.5)) {
    throw new Error("Подозрительно мало тем (" + list.size + " против " + prevMap.size + "). Файл не обновлён.");
  }

  const laws = [], changes = [];
  let failed = 0;
  for (const t of list.values()) {
    const old = prevMap.get(t.id);
    try {
      const r = await readThread(t);
      const hash = sha(r.text);
      const law = { id: r.id, title: r.title, section: r.section, url: r.url, posted: r.posted, edited: r.edited, text: r.text, hash };
      if (!old) {
        law.changedAt = first ? 0 : now; law.isNew = !first;
        if (!first) changes.push({ type: "new", id: r.id, title: r.title, at: now });
      } else if (old.hash !== hash) {
        law.changedAt = now; law.isNew = false; law.diff = lineDiff(old.text, r.text);
        changes.push({ type: "changed", id: r.id, title: r.title, at: now, addN: law.diff.addN, delN: law.diff.delN });
      } else {
        law.changedAt = old.changedAt || 0; law.isNew = !!old.isNew;
        if (old.diff) law.diff = old.diff;
      }
      laws.push(law);
    } catch (e) {
      failed++; console.error("Не удалось:", t.url, e.message);
      if (old) laws.push(old);
    }
  }
  const alive = new Set(list.keys());
  for (const old of prevMap.values()) {
    if (!alive.has(old.id)) changes.push({ type: "removed", id: old.id, title: old.title, at: now });
  }
  if (!laws.length) throw new Error("Не прочитано ни одной темы.");

  const allChanges = changes.concat(prev.changes || []).slice(0, 60);
  const touched = changes.length > 0;
  const out = {
    updatedAt: touched ? now : (prev.updatedAt || now),
    checkedAt: now,
    laws, changes: allChanges,
    status: { ok: true, failed }
  };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(out));
  console.log("Законов:", laws.length, "· изменений:", changes.length, "· ошибок:", failed);
}

main().catch((e) => { console.error("ОШИБКА:", e.message); process.exit(1); });
