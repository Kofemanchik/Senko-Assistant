// Текст GitHub-релиза из списка «Что нового» (NEWS в app/index.html) для версии из package.json.
// Запускается в workflow «Build installer»: node tools/release-notes.js > release-notes.md
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const version = process.argv[2] || require(path.join(root, "package.json")).version;
const html = fs.readFileSync(path.join(root, "app", "index.html"), "utf8");

const start = html.indexOf("var NEWS=[");
if (start < 0) { console.log(`Senko Assistant ${version}`); process.exit(0); }
const end = html.indexOf("\n];", start);
let news = [];
try { news = new Function("return " + html.slice(start + "var NEWS=".length, end + 3).replace(/;$/, ""))(); } catch (e) { news = []; }

const entry = news.find((n) => n && n.v === version);
const out = [];
if (!entry) {
  out.push(`Senko Assistant ${version}`);
} else {
  out.push(`## Что нового в ${version}`);
  out.push("");
  for (const [icon, title, text] of entry.items) out.push(`- ${icon} **${title}.** ${text}`);
}
out.push("");
out.push("Установите `Senko-Assistant-Setup-" + version + ".exe` или дождитесь обновления в программе.");
process.stdout.write(out.join("\n") + "\n");
