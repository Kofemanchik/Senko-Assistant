/* Диагностика: структура текстов законов сервера (SERVER=7|16|12) без публикации самих текстов.
   Для каждого кодекса печатает, как парсер классифицирует строки: типы, длины и только начало заголовков.
   Запуск: SERVER=7 LAWS_KEY=... node scripts/dump-structure.js   (workflow «Dump law structure») */
"use strict";
const fs = require("fs");
const SRV = require("./servers.js");
const { decrypt } = require("./laws-crypt.js");
const LC = require("./law-core.js");

const ONLY = process.env.KIND || "";
const AROUND = { uk: [/^(?:Статья\s+)?1\.3\b/, /^(?:Статья\s+)?15\.[56]\b/, /^(?:Статья\s+)?5\.4\b/], ak: [/^Статья\s+2\.1\b/], dk: [/^(?:Статья\s+)?1\b/, /^(?:Статья\s+)?66\b/], pk: [/^(?:Статья\s+)?2\.1\b/] };
const kindOf = (t) => { t = String(t || "").toLowerCase(); return /уголовн/.test(t) ? "uk" : /административн/.test(t) ? "ak" : /дорожн/.test(t) ? "dk" : /процессуальн/.test(t) ? "pk" : ""; };
const id = SRV.current();
const d = JSON.parse(decrypt(fs.readFileSync(SRV.files(id).enc), process.env.LAWS_KEY));
const out = [];
const head = (s, n) => String(s).replace(/\s+/g, " ").slice(0, n);
for (const law of d.laws || []) {
  const k = kindOf(law.title);
  if (!k || !/кодекс/i.test(law.title)) { out.push(`# прочее: "${head(law.title, 40)}" len=${law.text.length}`); continue; }
  if (ONLY && k !== ONLY) continue;
  const P = LC.parse(law.text), rows = LC.rowsFromParsed(P);
  const hist = {}; P.lines.forEach((x) => { hist[x.t] = (hist[x.t] || 0) + 1; });
  const rx = (r) => P.lines.filter((x) => r.test(x.raw)).length;
  out.push(`## ${k} "${head(law.title, 50)}" textLen=${law.text.length} lines=${P.lines.length} mode=${P.mode} units=${P.units.length} rows=${rows.length}`);
  out.push("types: " + JSON.stringify(hist));
  out.push("форматы: 'N — Название'=" + rx(/^\d+(?:\.\d+)*(?:\s+ч\.\d+)?\s+[—–-]\s+\S/) + " 'Статья N'=" + rx(/^Статья\s+\d/i) + " 'Источник статьи'=" + rx(/^Источник статьи/) + " 'Звёзды'=" + rx(/^Звёзды/i) + " 'Наказание'=" + rx(/^Наказание/i) + " '★'=" + rx(/★/) + " 'ч.N'=" + rx(/^ч\.\s*\d/i) + " 'Глава'=" + rx(/^Глава/i) + " 'Раздел'=" + rx(/^Раздел/i));
  out.push("первые строки:");
  P.lines.slice(0, 14).forEach((x, i) => out.push(`  ${i}:${x.t}(${x.raw.length}) ${head(x.raw, 56)}`));
  (AROUND[k] || []).forEach((re) => {
    const at = P.lines.findIndex((x) => re.test(x.raw));
    out.push(`вокруг ${re.source}: ${at < 0 ? "не найдено" : "строка " + at}`);
    if (at >= 0) P.lines.slice(Math.max(0, at - 2), at + 9).forEach((x, i) => out.push(`  ${Math.max(0, at - 2) + i}:${x.t}(${x.raw.length}) ${head(x.raw, 56)}`));
  });
  out.push("единицы (код|длина названия|строк):");
  out.push("  " + P.units.map((u) => `${u.n}|${(u.title || "").length}|${u.parts.length}`).join(" "));
  out.push("строки таблицы (код/часть:текст/наказание/звёзды):");
  out.push("  " + rows.map((r) => `${r.code}/${r.part || "-"}:${(r.text || "").length}/${(r.pun || "").length}/${r.stars}`).join(" "));
}
console.log(out.join("\n"));
