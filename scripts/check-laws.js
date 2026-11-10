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
  LawCore.configure({ v2: id !== SRV.DEFAULT });
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
// 4.6: машинный отчёт для панели владельца («Проверка законов»): update/laws-check[-N].json, не шифруется и не содержит текста законов
function jsonReport(id) {
  const f = SRV.files(id).enc;
  const out = { server: id, name: SRV.nameOf(id), at: Date.now(), laws: 0, codes: [], flagged: [], warns: [] };
  if (!fs.existsSync(f)) { out.warns.push("Законы этого сервера ещё не собирались."); return out; }
  let d;
  try { d = JSON.parse(decrypt(fs.readFileSync(f), process.env.LAWS_KEY)); } catch (e) { out.warns.push("Не удалось расшифровать файл законов."); return out; }
  LawCore.configure({ v2: id !== SRV.DEFAULT });
  out.laws = (d.laws || []).length;
  const names = { uk: "УК", ak: "АК", dk: "ДК", pk: "ПК" };
  const seen = {};
  for (const L of d.laws || []) {
    const k = kindOf(L.title);
    if (!k || seen[k]) continue;
    seen[k] = 1;
    let P, rows;
    try { P = LawCore.parse(L.text); rows = LawCore.rowsFromParsed(P); } catch (e) { out.warns.push(names[k] + ": ошибка разбора (" + String(e.message).slice(0, 80) + ")"); continue; }
    let noStars = 0, noFine = 0, noPart = 0;
    for (const r of rows) {
      const bad = [];
      if (k === "uk" && !(r.stars > 0)) { noStars++; bad.push("нет звёзд"); }
      if ((k === "uk" || k === "ak") && !r.hasFine && !(r.m > 0)) { noFine++; bad.push("нет штрафа и срока"); }
      if (r.part === "" || r.part == null) { noPart++; if (!bad.length) bad.push("не распознана часть"); }
      if (bad.length && out.flagged.length < 80) out.flagged.push({ kind: names[k], art: String(r.code), part: r.part || "", title: String(r.title || "").slice(0, 60), issue: bad.join(", ") });
    }
    out.codes.push({ name: names[k], articles: P.units.length, rows: rows.length, noStars: k === "uk" ? noStars : 0, noFine: k === "uk" || k === "ak" ? noFine : 0, noPart });
    if (P.units.length < 5) out.warns.push(names[k] + ": распознано меньше 5 статей, проверьте вёрстку темы на форуме.");
  }
  for (const k of Object.keys(names)) if (!seen[k]) out.warns.push(names[k] + ": на форуме сервера не найден.");
  return out;
}
const ids = process.env.SERVER === "all" ? SRV.SERVERS.map((s) => s.id) : [SRV.current()];
console.log(ids.map(report).join("\n"));
if (process.env.JSON_OUT === "1") {
  const path = require("path");
  for (const id of ids) {
    const sfx = id === SRV.DEFAULT ? "" : "-" + id;
    fs.writeFileSync(path.join(__dirname, "..", "update", "laws-check" + sfx + ".json"), JSON.stringify(jsonReport(id), null, 1) + "\n");
  }
}
