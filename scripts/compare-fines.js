/* Временная диагностика: сравнение старого (law-core-prev.js) и нового парсера на законах сервера. Тексты законов не печатаются. */
"use strict";
const fs = require("fs");
const SRV = require("./servers.js");
const { decrypt } = require("./laws-crypt.js");
const N = require("./law-core.js"), O = require("./law-core-prev.js");
const v2 = SRV.current() !== 12; N.configure({ v2 }); O.configure({ v2 });
const kindOf = (t) => { t = String(t || "").toLowerCase(); if (!/кодекс/.test(t)) return ""; return /уголовн/.test(t) ? "uk" : /административн/.test(t) ? "ak" : /дорожн/.test(t) ? "dk" : /процессуальн/.test(t) ? "pk" : ""; };
const d = JSON.parse(decrypt(fs.readFileSync(SRV.files(SRV.current()).enc), process.env.LAWS_KEY));
const out = [];
for (const law of d.laws || []) {
  const k = kindOf(law.title); if (!k || k === "pk") continue;
  const a = O.rowsFromParsed(O.parse(law.text)), b = N.rowsFromParsed(N.parse(law.text));
  const diff = [];
  b.forEach((r, i) => { const o = a[i] || {}; if (o.fmin !== r.fmin || o.fmax !== r.fmax || o.m !== r.m || o.stars !== r.stars || o.hasFine !== r.hasFine) diff.push(`${r.code}${r.part ? " ч." + r.part : ""}: ★${o.stars} ${o.fmin}–${o.fmax} m${o.m} → ★${r.stars} ${r.fmin}–${r.fmax} m${r.m}`); });
  const stars = b.filter((r) => r.stars > 0).length;
  out.push(`## ${k}: строк ${b.length} (было ${a.length}), изменилось ${diff.length}, со звёздами ${stars}`);
  out.push(...diff.slice(0, 12));
}
console.log(out.join("\n"));
