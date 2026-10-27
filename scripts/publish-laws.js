/* Запускается после парсера (scripts/sync-laws.js).
   1) сравнивает новую версию с прошлой по статьям и размечает «Новый закон» / «Изменено»;
   2) шифрует результат в update/laws.enc (в публичный репозиторий открытый текст не попадает);
   3) пишет update/laws-status.json — крошечный файл без текстов; он обновляется КАЖДЫЙ запуск,
      поэтому у репозитория всегда есть свежая активность и GitHub не отключает расписание;
   4) удаляет открытый update/laws.json и временные файлы. */
"use strict";
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const core = require("./law-core.js");
const { encrypt, decrypt } = require("./laws-crypt.js");
const SRV = require("./servers.js");

const SERVER = SRV.current();            // SERVER=12|7|16; у Boston файлы называются как раньше
const F = SRV.files(SERVER);
const KEEP_MS = 14 * 864e5; // сколько дней показывать метки «Изменено»/«Новый закон»
const MIN_KEEP_RATIO = 0.6; // если законов стало меньше 60% от прошлых — парсер сломан, не публикуем

const read = (f) => JSON.parse(fs.readFileSync(f, "utf8").replace(/^\uFEFF/, ""));
const sha = (s) => crypto.createHash("sha1").update(s).digest("hex");
const fail = (m) => { console.error("ОШИБКА:", m); process.exit(1); };

function loadPrev() {
  try { if (fs.existsSync(F.prev)) return read(F.prev); } catch (e) {}
  try { if (fs.existsSync(F.enc)) return JSON.parse(decrypt(fs.readFileSync(F.enc), process.env.LAWS_KEY)); } catch (e) { console.warn("Прошлую версию прочитать не удалось:", e.message); }
  return null;
}

const WAS_MAX = 6000; // сколько символов прошлой редакции статьи хранить для «было / стало»
function artEvents(prevLaw, law, now) {
  const pa = core.parse(prevLaw.text);
  const a = core.unitHashes(pa), b = core.unitHashes(core.parse(law.text));
  const was = {}; pa.units.forEach((u) => { was[u.key] = String(u.text || "").slice(0, WAS_MAX); });
  const ev = [];
  Object.keys(b).forEach((n) => { if (!(n in a)) ev.push({ n: n, k: "added", at: now }); else if (a[n] !== b[n]) ev.push({ n: n, k: "changed", at: now, was: was[n] }); });
  Object.keys(a).forEach((n) => { if (!(n in b)) ev.push({ n: n, k: "removed", at: now }); });
  return ev;
}

function main() {
  if (!process.env.LAWS_KEY) fail("LAWS_KEY не задан (секрет репозитория).");
  if (!fs.existsSync(F.plain)) fail("Парсер не создал update/laws.json.");
  let cur; try { cur = read(F.plain); } catch (e) { fail("update/laws.json повреждён: " + e.message); }
  if (!cur || !Array.isArray(cur.laws) || !cur.laws.length) fail("В update/laws.json нет законов.");
  const prev = loadPrev(), now = Date.now();
  const prevById = {}; if (prev && Array.isArray(prev.laws)) prev.laws.forEach((l) => { prevById[l.id] = l; });
  const havePrev = !!(prev && prev.laws && prev.laws.length);

  // если изменился список игнорируемых разделов (servers.js → ignore), падение числа законов ожидаемо
  const ignoreChanged = havePrev && (prev.ignoreKey || "") !== (cur.ignoreKey || "");
  if (havePrev && !ignoreChanged && cur.laws.length < prev.laws.length * MIN_KEEP_RATIO) fail("Законов стало " + cur.laws.length + " вместо " + prev.laws.length + " — похоже на сбой парсера, файл не обновлён.");

  const changes = Array.isArray(cur.changes) ? cur.changes.slice() : [];
  const notify = []; // что изменилось в этот запуск — уходит владельцу и руководству в Telegram
  let nNew = 0, nChanged = 0;
  cur.laws.forEach((l) => {
    const p = prevById[l.id];
    if (!p) { // законов с таким id раньше не было
      if (havePrev) {
        l.isNew = true; l.changedAt = l.changedAt || now; nNew++;
        if (!changes.some((c) => c.id === l.id && c.type === "new")) changes.unshift({ type: "new", id: l.id, title: l.title, at: now });
        notify.push({ type: "new", title: l.title });
      }
      l.arts = [];
      return;
    }
    // метки прошлых запусков, которые ещё не устарели
    let arts = (p.arts || []).filter((x) => x.at > now - KEEP_MS);
    if (p.isNew && p.changedAt && p.changedAt > now - KEEP_MS && l.isNew == null) { l.isNew = true; l.changedAt = p.changedAt; }
    if (p.hash !== l.hash || p.text !== l.text) {
      const ev = artEvents(p, l, now);
      if (ev.length) {
        const touched = {}; ev.forEach((e) => { touched[e.n] = 1; });
        arts = arts.filter((x) => !touched[x.n]).concat(ev);
        nChanged += ev.length;
        const nums = ev.map((e) => e.n).slice(0, 12);
        notify.push({ type: "changed", title: l.title, arts: "ст. " + nums.join(", ") + (ev.length > nums.length ? " и ещё " + (ev.length - nums.length) : "") });
        l.changedAt = now;
        if (l.isNew == null) l.isNew = false;
      }
    }
    l.arts = arts;
    if (l.isNew && l.changedAt && l.changedAt < now - KEEP_MS) l.isNew = false;
  });

  // updatedAt — время последнего реального изменения содержимого (не времени проверки)
  const sigOf = (laws) => sha(JSON.stringify(laws.map((l) => [l.id, l.hash || sha(l.text || ""), l.title, l.section || ""])));
  cur.server = SERVER;
  cur.sig = sigOf(cur.laws);
  cur.updatedAt = havePrev && sigOf(prev.laws) === cur.sig && prev.updatedAt ? prev.updatedAt : now;
  cur.checkedAt = cur.updatedAt;                // настоящее время проверки — в laws-status.json
  cur.changes = changes.filter((c) => c.at > now - 30 * 864e5).slice(0, 60);

  const plain = JSON.stringify(cur);
  const prevPlain = prev ? JSON.stringify(Object.assign({}, prev, { checkedAt: prev.updatedAt })) : "";
  let wrote = false;
  if (!fs.existsSync(F.enc) || sha(plain) !== sha(prevPlain)) { fs.writeFileSync(F.enc, encrypt(plain, process.env.LAWS_KEY)); wrote = true; }

  const st = cur.status || {};
  fs.writeFileSync(F.status, JSON.stringify({
    server: SERVER, checkedAt: now, updatedAt: cur.updatedAt, sig: cur.sig, count: cur.laws.length,
    ok: st.ok !== false, failed: st.failed || 0, error: st.ok === false ? String(st.error || "").slice(0, 300) : ""
  }, null, 1) + "\n");

  [F.plain, F.prev].forEach((f) => { try { fs.unlinkSync(f); } catch (e) {} });
  console.log(`Сервер ${SRV.nameOf(SERVER)} (${SERVER}). Законов: ${cur.laws.length}; новых: ${nNew}; изменённых статей: ${nChanged}; ${wrote ? "laws.enc обновлён" : "laws.enc без изменений"}.`);
  notify.count = cur.laws.length;
  return notify;
}

// Оповещение в Telegram через функцию senko (нужен секрет CRON_SECRET в переменных окружения шага).
// Сбой оповещения не ломает публикацию законов.
async function notifyBot(items) {
  const secret = process.env.CRON_SECRET;
  const manual = process.env.GITHUB_EVENT_NAME === "workflow_dispatch"; // запуск вручную (кнопка или /laws) — сообщаем и «изменений нет»
  if ((!items.length && !manual) || !secret) { if (items.length || manual) console.log("CRON_SECRET не задан — оповещение в Telegram пропущено."); return; }
  const url = process.env.SENKO_API_URL || "https://wcjspwailippjmyffkei.supabase.co/functions/v1/senko";
  try {
    const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json", "x-senko-cron": secret }, body: JSON.stringify({ action: "laws_changed", server: SERVER, items, manual, count: items.count }), signal: AbortSignal.timeout(20000) });
    console.log("Оповещение о законах:", r.status, await r.text());
  } catch (e) {
    console.warn("Оповещение о законах не отправлено:", e.message);
  }
}
notifyBot(main());
