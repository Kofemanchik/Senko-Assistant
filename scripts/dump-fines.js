/* Диагностика штрафов: как записаны суммы в кодексах сервера и что из них понял парсер.
   Печатает только короткие куски вокруг сумм (до 24 символов) и коды необычных символов, сами тексты законов не публикуются.
   Запуск: SERVER=7 LAWS_KEY=... node scripts/dump-fines.js   (workflow «Dump law structure», шаг «Штрафы») */
"use strict";
const fs = require("fs");
const SRV = require("./servers.js");
const { decrypt } = require("./laws-crypt.js");
const LC = require("./law-core.js");
const kindOf = (t) => { t = String(t || "").toLowerCase(); if (!/кодекс/.test(t)) return ""; return /уголовн/.test(t) ? "uk" : /административн/.test(t) ? "ak" : /дорожн/.test(t) ? "dk" : /процессуальн/.test(t) ? "pk" : ""; };
const d = JSON.parse(decrypt(fs.readFileSync(SRV.files(SRV.current()).enc), process.env.LAWS_KEY));
const odd = (s) => [...s].filter((c) => !/[0-9A-Za-zА-Яа-яЁё$.,: ]/.test(c)).map((c) => "U+" + c.codePointAt(0).toString(16).toUpperCase().padStart(4, "0")).join(" ");
const out = [];
for (const law of d.laws || []) {
  const k = kindOf(law.title);
  if (!k || k === "pk") continue;
  const rows = LC.rowsFromParsed(LC.parse(law.text));
  const fined = rows.filter((r) => r.hasFine);
  const low = fined.filter((r) => r.fmax > 0 && r.fmax < 1000);
  out.push(`## ${k}: строк ${rows.length}, со штрафом ${fined.length}, из них сумма меньше $1000: ${low.length}`);
  const show = low.length ? low.slice(0, 25) : fined.slice(0, 8);
  for (const r of show) {
    const src = r.pun || r.title || "";
    const i = src.search(/\$|штраф/i);
    const frag = i < 0 ? "" : src.slice(Math.max(0, i - 4), i + 20).replace(/\s/g, (c) => (c === " " ? " " : "·"));
    out.push(`${r.code}${r.part ? " ч." + r.part : ""}: ${r.fmin}–${r.fmax} «${frag}» ${odd(frag)}`);
  }
}
console.log(out.join("\n"));
