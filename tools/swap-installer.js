// Подменяет обычный установщик электрона на свой (с баннером) так, чтобы автообновление принимало его:
// имя файла остаётся Senko-Assistant-Setup-<версия>.exe, в latest.yml/beta.yml пересчитываются sha512 и size, blockmap удаляется.
// Запуск: node tools/swap-installer.js <свой.exe> <dist>
const fs = require("fs"), path = require("path"), crypto = require("crypto");
const [custom, dist] = process.argv.slice(2);
if (!custom || !dist) { console.error("нужно: <свой.exe> <папка dist>"); process.exit(2); }
const setup = fs.readdirSync(dist).find(f => /^Senko-Assistant-Setup-.*\.exe$/.test(f));
if (!setup) { console.error("в " + dist + " нет Senko-Assistant-Setup-*.exe"); process.exit(1); }
const buf = fs.readFileSync(custom);
const sha = crypto.createHash("sha512").update(buf).digest("base64");
fs.writeFileSync(path.join(dist, setup), buf);
for (const f of fs.readdirSync(dist)) {
  if (/\.blockmap$/.test(f)) fs.unlinkSync(path.join(dist, f));
  if (!/\.yml$/.test(f) || f === "builder-debug.yml") continue;
  let y = fs.readFileSync(path.join(dist, f), "utf8");
  if (!y.includes(setup)) continue;
  y = y.replace(/^(\s*(?:- )?sha512:).*$/gm, "$1 " + sha).replace(/^(\s*size:).*$/gm, "$1 " + buf.length).replace(/^\s*blockMapSize:.*\n/gm, "");
  fs.writeFileSync(path.join(dist, f), y);
  console.log("обновлён " + f);
}
console.log(setup + ": " + buf.length + " байт, sha512 " + sha.slice(0, 16) + "…");
