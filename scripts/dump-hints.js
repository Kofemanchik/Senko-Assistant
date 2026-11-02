/* Диагностика подсказок сервера: номера и названия статей ПК и УК, текст Миранды и начало ключевых статей ПК.
   Нужна, чтобы сопоставить номера статей в подсказках (написаны по Boston) с законами другого сервера.
   Запуск: SERVER=7 LAWS_KEY=... node scripts/dump-hints.js   (workflow «Dump law structure») */
"use strict";
const fs = require("fs");
const SRV = require("./servers.js");
const { decrypt } = require("./laws-crypt.js");
const LC = require("./law-core.js");

const sn = SRV.current();
LC.configure({ v2: sn !== SRV.DEFAULT });
const kindOf = (t) => { t = String(t || "").toLowerCase(); if (!/кодекс/.test(t)) return ""; return /уголовн/.test(t) ? "uk" : /административн/.test(t) ? "ak" : /дорожн/.test(t) ? "dk" : /процессуальн/.test(t) ? "pk" : ""; };
const d = JSON.parse(decrypt(fs.readFileSync(SRV.files(sn).enc), process.env.LAWS_KEY));
const sq = (s, n) => String(s || "").replace(/\s+/g, " ").trim().slice(0, n);
const out = [];
const KEY = (process.env.KEYS || "12,16,17,19,20,27,29,57").split(",");
for (const law of d.laws || []) {
  const k = kindOf(law.title);
  if (k !== "pk" && k !== "uk") continue;
  const rows = LC.rowsFromParsed(LC.parse(law.text));
  const seen = {};
  out.push(`## ${k} ${sq(law.title, 60)}`);
  rows.forEach((r) => { if (!seen[r.code]) { seen[r.code] = 1; out.push(`${k} ${r.code}: ${sq(r.title, 70)}`); } });
  if (k === "pk") rows.forEach((r) => { if (KEY.includes(String(r.code))) out.push(`  > ${r.code} ч.${r.part || "-"}: ${sq(r.text, 160)}`); });
}
const mre = /Вы имеете право хранить молчание[\s\S]{40,900}?(?:Вам\s+ясны\s+(?:ли\s+)?ваши\s+права\s*[?.]?|ясны\s+ли\s+вам\s+(?:ваши\s+)?права\s*[?.]?)/i;
let mir = "";
for (const law of d.laws || []) { const m = mre.exec(String(law.text || "")); if (m) { mir = sq(m[0], 900) + "  [" + sq(law.title, 50) + "]"; break; } }
out.push("MIRANDA: " + (mir || "не найдена"));
console.log(out.join("\n"));
