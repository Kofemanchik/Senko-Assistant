/* Запускается, если парсер или публикация упали. Обновляет ТОЛЬКО update/laws-status.json (без текстов законов):
   - в репозитории появляется свежий коммит, поэтому GitHub не отключает расписание по «неактивности»;
   - приложение видит ok:false и показывает предупреждение, а не молча показывает старые законы. */
"use strict";
const fs = require("fs");
const path = require("path");
const f = path.join(__dirname, "..", "update", "laws-status.json");
let old = {};
try { old = JSON.parse(fs.readFileSync(f, "utf8")); } catch (e) {}
fs.mkdirSync(path.dirname(f), { recursive: true });
fs.writeFileSync(f, JSON.stringify(Object.assign({}, old, {
  checkedAt: Date.now(), ok: false, error: String(process.argv[2] || "парсер завершился с ошибкой").slice(0, 300)
}), null, 1) + "\n");
console.log("laws-status.json помечен как неуспешный.");
