/* Диагностика: структура текста одного кодекса сервера без публикации самих текстов.
   Печатает каждую строку: номер, тип, длина; у заголовков ещё первые 40 символов.
   Запуск: SERVER=7 KIND=uk|ak|dk|pk LAWS_KEY=... node scripts/dump-structure.js   (workflow «Dump law structure») */
"use strict";
const fs = require("fs");
const SRV = require("./servers.js");
const { decrypt } = require("./laws-crypt.js");
const LC = require("./law-core.js");

const kindOf = (t) => { t = String(t || "").toLowerCase(); if (!/кодекс/.test(t)) return ""; return /уголовн/.test(t) ? "uk" : /административн/.test(t) ? "ak" : /дорожн/.test(t) ? "dk" : /процессуальн/.test(t) ? "pk" : ""; };
const WANT = process.env.KIND || "uk";
const d = JSON.parse(decrypt(fs.readFileSync(SRV.files(SRV.current()).enc), process.env.LAWS_KEY));
const head = (s, n) => String(s).replace(/\s+/g, " ").slice(0, n);
const HDR = /^(art|artsec|pt|cpart|sec|chap|part|title)$/;
const out = [];
for (const law of d.laws || []) {
  if (kindOf(law.title) !== WANT) continue;
  const P = LC.parse(law.text), rows = LC.rowsFromParsed(P);
  const hist = {}; P.lines.forEach((x) => { hist[x.t] = (hist[x.t] || 0) + 1; });
  out.push(`## ${WANT} "${head(law.title, 40)}" lines=${P.lines.length} mode=${P.mode} units=${P.units.length} rows=${rows.length} ${JSON.stringify(hist)}`);
  let tail = [];
  const flush = () => { if (tail.length) { out.push("   " + tail.join(" ")); tail = []; } };
  P.lines.forEach((x, i) => {
    if (HDR.test(x.t)) { flush(); out.push(`${i} ${x.t}(${x.raw.length}) ${head(x.raw, 40)}`); }
    else tail.push(`${x.t[0]}${x.raw.length}`);
  });
  flush();
}
console.log(out.join("\n"));
