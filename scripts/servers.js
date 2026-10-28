/* Серверы Majestic RP и файлы законов каждого из них. Один источник для скриптов GitHub Actions.
   Тот же список лежит в supabase/functions/senko/index.ts (SERVERS), accounts.js, site/app/web*.js, site/panel/panel.js.
   Чтобы добавить сервер: впишите его сюда (id, имя, номер раздела «Законодательная база» на форуме) и в остальные списки,
   затем запустите «Sync laws»: файлы update/laws-<id>.enc и laws-status-<id>.json появятся сами. */
"use strict";
const path = require("path");

const BASE = "https://forum.majestic-rp.ru";
const DEFAULT = 12; // Boston: его файлы называются как раньше (laws.enc, laws-status.json), чтобы старые версии программы продолжали работать
const SERVERS = [
  { id: 12, name: "Boston", forum: 1017 },
  { id: 7, name: "Los Angeles", forum: 693 },
  { id: 16, name: "Denver", forum: 1276 },
];

// номер сервера из переменной окружения SERVER (по умолчанию Boston)
function current(env) {
  const n = parseInt((env || process.env).SERVER, 10);
  if (!n) return DEFAULT;
  if (!SERVERS.some((s) => s.id === n)) throw new Error("Неизвестный сервер: " + n);
  return n;
}
const suffix = (id) => (id === DEFAULT ? "" : "-" + id);
function files(id, dir) {
  dir = dir || path.join(__dirname, "..", "update");
  const s = suffix(id);
  return {
    plain: path.join(dir, "laws" + s + ".json"),
    prev: path.join(dir, ".prev" + s + ".json"),
    enc: path.join(dir, "laws" + s + ".enc"),
    status: path.join(dir, "laws-status" + s + ".json"),
  };
}
const startUrl = (id) => BASE + "/forums/zakonodatel-naya-baza." + SERVERS.find((s) => s.id === id).forum + "/";
const nameOf = (id) => (SERVERS.find((s) => s.id === id) || { name: "сервер " + id }).name;

module.exports = { BASE, DEFAULT, SERVERS, current, suffix, files, startUrl, nameOf };
