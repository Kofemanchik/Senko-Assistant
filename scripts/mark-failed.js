/* Запускается, если парсер или публикация упали. Обновляет ТОЛЬКО update/laws-status.json (без текстов законов):
   - в репозитории появляется свежий коммит, поэтому GitHub не отключает расписание по «неактивности»;
   - приложение видит ok:false и показывает предупреждение, а не молча показывает старые законы. */
"use strict";
const fs = require("fs");
const path = require("path");
const SRV = require("./servers.js");
// SERVER=<номер> — пометить один сервер; SERVER=all (или не задан при запуске из общего шага сбоя) — все серверы
const ids = process.env.SERVER === "all" || !process.env.SERVER ? SRV.SERVERS.map((s) => s.id) : [SRV.current()];
for (const id of ids) {
  const f = SRV.files(id).status;
  let old = {};
  try { old = JSON.parse(fs.readFileSync(f, "utf8")); } catch (e) {}
  if (!old.sig && id !== SRV.DEFAULT) continue; // сервер ещё ни разу не публиковался: помечать нечего
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify(Object.assign({}, old, {
    checkedAt: Date.now(), ok: false, error: String(process.argv[2] || "парсер завершился с ошибкой").slice(0, 300)
  }), null, 1) + "\n");
  console.log(path.basename(f) + " помечен как неуспешный.");
}
