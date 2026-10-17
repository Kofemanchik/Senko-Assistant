// Использование:  npm run publish-update -- 1.0.1 "Что изменилось"
// Берёт app/index.html, кладёт копию в update/, считает хэш и пишет update/version.json.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const root = path.join(__dirname, "..");
const version = process.argv[2];
const notes = process.argv[3] || "";
if (!/^\d+\.\d+\.\d+$/.test(version || "")) {
  console.error('Укажите версию, например: npm run publish-update -- 1.0.1 "Исправлены статьи"');
  process.exit(1);
}
const src = path.join(root, "app", "index.html");
const dstDir = path.join(root, "update");
fs.mkdirSync(dstDir, { recursive: true });
const buf = fs.readFileSync(src);
fs.writeFileSync(path.join(dstDir, "index.html"), buf);
const sha256 = crypto.createHash("sha256").update(buf).digest("hex");
fs.writeFileSync(
  path.join(dstDir, "version.json"),
  JSON.stringify({ version, file: "index.html", sha256, notes, date: new Date().toISOString() }, null, 2) + "\n"
);
const pkgPath = path.join(root, "package.json");
const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
pkg.version = version;
fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
console.log(`Готово: версия ${version}, sha256 ${sha256.slice(0, 12)}…\nТеперь: git add -A && git commit -m "v${version}" && git push`);
