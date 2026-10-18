/* Вставляет scripts/law-core.js внутрь app/index.html между маркерами LAWCORE:BEGIN / LAWCORE:END.
   Запускайте после любой правки law-core.js:  node tools/inline-law-core.js [путь/к/index.html] */
"use strict";
const fs = require("fs");
const path = require("path");
const target = process.argv[2] || path.join(__dirname, "..", "app", "index.html");
const core = fs.readFileSync(path.join(__dirname, "..", "scripts", "law-core.js"), "utf8");
let html = fs.readFileSync(target, "utf8");
const a = html.indexOf("/* LAWCORE:BEGIN */"), b = html.indexOf("/* LAWCORE:END */");
if (a < 0 || b < 0) { console.error("В файле нет маркеров LAWCORE:BEGIN/END."); process.exit(1); }
html = html.slice(0, a) + "/* LAWCORE:BEGIN */\n" + core.replace(/<\/script/gi, "<\\/script") + "\n" + html.slice(b);
fs.writeFileSync(target, html);
console.log("law-core.js вставлен в", target);
