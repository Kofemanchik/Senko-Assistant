/* Диагностика: структура текстов законов сервера (SERVER=7|16|12) без публикации самих текстов.
   Для каждого кодекса печатает, как парсер классифицирует строки: типы, длины и только начало заголовков.
   Запуск: SERVER=7 LAWS_KEY=... node scripts/dump-structure.js   (workflow «Dump law structure») */
"use strict";
const fs = require("fs");
const SRV = require("./servers.js");
const { decrypt } = require("./laws-crypt.js");
const LC = require("./law-core.js");

const kindOf = (t) => { t = String(t || "").toLowerCase(); return /уголовн/.test(t) ? "uk" : /административн/.test(t) ? "ak" : /дорожн/.test(t) ? "dk" : /процессуальн/.test(t) ? "pk" : ""; };
const id = SRV.current();
const d = JSON.parse(decrypt(fs.readFileSync(SRV.files(id).enc), process.env.LAWS_KEY));
const out = [];
const head = (s, n) => String(s).replace(/\s+/g, " ").slice(0, n);
for (const law of d.laws || []) {
  const k = kindOf(law.title);
  if (!k || !/кодекс/i.test(law.title)) { out.push(`# прочее: "${head(law.title, 40)}" len=${law.text.length}`); continue; }
  const P = LC.parse(law.text), rows = LC.rowsFromParsed(P);
  const hist = {}; P.lines.forEach((x) => { hist[x.t] = (hist[x.t] || 0) + 1; });
  const rx = (r) => P.lines.filter((x) => r.test(x.raw)).length;
  out.push(`## ${k} "${head(law.title, 50)}" textLen=${law.text.length} lines=${P.lines.length} mode=${P.mode} units=${P.units.length} rows=${rows.length}`);
  out.push("types: " + JSON.stringify(hist));
  out.push("форматы: 'N — Название'=" + rx(/^\d+(?:\.\d+)*(?:\s+ч\.\d+)?\s+[—–-]\s+\S/) + " 'Статья N'=" + rx(/^Статья\s+\d/i) + " 'Источник статьи'=" + rx(/^Источник статьи/) + " 'Звёзды'=" + rx(/^Звёзды/i) + " 'Наказание'=" + rx(/^Наказание/i) + " '★'=" + rx(/★/) + " 'ч.N'=" + rx(/^ч\.\s*\d/i) + " 'Глава'=" + rx(/^Глава/i) + " 'Раздел'=" + rx(/^Раздел/i));
  out.push("первые строки:");
  P.lines.slice(0, 16).forEach((x, i) => out.push(`  ${i}:${x.t}(${x.raw.length}) ${head(x.raw, 60)}`));
  out.push("образец середины (тип, длина, начало заголовков):");
  const mid = Math.floor(P.lines.length / 3);
  P.lines.slice(mid, mid + 30).forEach((x, i) => out.push(`  ${mid + i}:${x.t}(${x.raw.length}) ${/^(art|artsec|pt|cpart|sec|chap|part)$/.test(x.t) ? head(x.raw, 48) : head(x.raw, 14)}`));
  out.push("единицы (код|название|строк в единице|частей):");
  out.push("  " + P.units.slice(0, 140).map((u) => `${u.n}|${head(u.title, 22)}|${u.parts.length}`).join("  ;  "));
  out.push("строки таблицы (код ч длина_текста длина_наказания звёзды):");
  out.push("  " + rows.slice(0, 160).map((r) => `${r.code}/${r.part || "-"}:${(r.text || "").length}/${(r.pun || "").length}/${r.stars}`).join(" "));
}
console.log(out.join("\n"));
