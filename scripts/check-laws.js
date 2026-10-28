/* Проверка собранных законов сервера: считает статьи, звёзды, штрафы и части по УК/АК/ДК/ПК (те же правила разбора, что в программе).
   Запуск: SERVER=7 LAWS_KEY=... node scripts/check-laws.js   (без SERVER — Boston; SERVER=all — все серверы)
   Выводит отчёт в Markdown (в workflow он попадает в сводку запуска). Код выхода всегда 0: это отчёт, а не блокировка публикации.
   Что значит «сомнительно»: у статьи УК нет звёзд или нет штрафа/срока — на форуме такое бывает у статей без наказания,
   но если таких много, скорее всего изменилась вёрстка форума, и тогда нужно сверить сервер вручную. */
"use strict";
const fs = require("fs");
const SRV = require("./servers.js");
const { decrypt } = require("./laws-crypt.js");
const LawCore = require("./law-core.js");

function kindOf(t) {
  t = String(t || "").toLowerCase();
  if (/уголовн/.test(t) && /кодекс/.test(t)) return "uk";
  if (/административн/.test(t) && /кодекс/.test(t)) return "ak";
  if (/дорожн/.test(t) && /кодекс/.test(t)) return "dk";
  if (/процессуальн/.test(t) && /кодекс/.test(t)) return "pk";
  return "";
}
function report(id) {
  const f = SRV.files(id).enc;
  const head = `### ${SRV.nameOf(id)} (${id})`;
  if (!fs.existsSync(f)) return head + "\nЗаконы этого сервера ещё не собирались.\n";
  let d;
  try { d = JSON.parse(decrypt(fs.readFileSync(f), process.env.LAWS_KEY)); } catch (e) { return head + "\nНе удалось расшифровать файл: " + e.message + "\n"; }
  const out = [head, `Законов: ${(d.laws || []).length}, обновлено ${d.updatedAt ? new Date(d.updatedAt).toISOString() : "—"}`, "", "| Кодекс | Статей | Строк (частей) | Без звёзд | Без штрафа/срока | Часть без номера |", "|---|---|---|---|---|---|"];
  const names = { uk: "УК", ak: "АК", dk: "ДК", pk: "ПК" };
  const seen = {};
  for (const L of d.laws || []) {
    const k = kindOf(L.title);
    if (!k || seen[k]) continue;
    seen[k] = 1;
    let P, rows;
    try { P = LawCore.parse(L.text); rows = LawCore.rowsFromParsed(P); } catch (e) { out.push(`| ${names[k]} | ошибка разбора: ${e.message} | | | | |`); continue; }
    const noStars = k === "uk" ? rows.filter((r) => !(r.stars > 0)).length : "—";
    const noFine = k === "uk" || k === "ak" ? rows.filter((r) => !r.hasFine && !(r.m > 0)).length : "—";
    const noPart = rows.filter((r) => r.part === "" || r.part == null).length;
    out.push(`| ${names[k]} | ${P.units.length} | ${rows.length} | ${noStars} | ${noFine} | ${noPart} |`);
    if (P.units.length < 5) out.push(`\n⚠️ ${names[k]}: распознано меньше 5 статей — проверьте вёрстку темы на форуме.`);
  }
  for (const k of Object.keys(names)) if (!seen[k]) out.push(`\n⚠️ ${names[k]}: на форуме сервера не найден (в программе останется справочник Boston).`);
  return out.join("\n") + "\n";
}
const ids = process.env.SERVER === "all" ? SRV.SERVERS.map((s) => s.id) : [SRV.current()];
console.log(ids.map(report).join("\n"));
