/* Шифрование update/laws.json → update/laws.enc (AES-256-GCM + gzip).
   Ключ берётся из LAWS_KEY (секрет репозитория и сборки приложения). В публичном репозитории лежит только шифртекст.

   Команды:
     node scripts/laws-crypt.js decrypt   — перед парсером: расшифровать прошлую версию в update/laws.json и update/.prev.json
     node scripts/laws-crypt.js encrypt   — разово: зашифровать существующий update/laws.json в update/laws.enc
*/
"use strict";
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const crypto = require("crypto");

const MAGIC = Buffer.from("SLW1");

function keyFrom(secret) {
  if (!secret || String(secret).length < 16) throw new Error("LAWS_KEY не задан или короче 16 символов.");
  return crypto.createHash("sha256").update(String(secret), "utf8").digest();
}
function encrypt(plain, secret) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", keyFrom(secret), iv);
  const body = Buffer.concat([c.update(zlib.gzipSync(Buffer.from(plain, "utf8"), { level: 9 })), c.final()]);
  return Buffer.concat([MAGIC, iv, c.getAuthTag(), body]);
}
function decrypt(buf, secret) {
  if (buf.length < 4 + 12 + 16 || !buf.subarray(0, 4).equals(MAGIC)) throw new Error("Неверный формат файла законов.");
  const d = crypto.createDecipheriv("aes-256-gcm", keyFrom(secret), buf.subarray(4, 16));
  d.setAuthTag(buf.subarray(16, 32));
  return zlib.gunzipSync(Buffer.concat([d.update(buf.subarray(32)), d.final()])).toString("utf8");
}
module.exports = { encrypt, decrypt };

if (require.main === module) {
  const dir = path.join(__dirname, "..", "update");
  const enc = path.join(dir, "laws.enc"), plain = path.join(dir, "laws.json"), prev = path.join(dir, ".prev.json");
  const cmd = process.argv[2];
  try {
    if (cmd === "decrypt") {
      if (fs.existsSync(enc)) {
        const t = decrypt(fs.readFileSync(enc), process.env.LAWS_KEY);
        fs.writeFileSync(plain, t); fs.writeFileSync(prev, t);
        console.log("Прошлая версия расшифрована.");
      } else if (fs.existsSync(plain)) {
        fs.copyFileSync(plain, prev); // переезд со старого открытого laws.json
        console.log("laws.enc ещё нет — за прошлую версию взят старый laws.json.");
      } else console.log("Прошлой версии нет — первый запуск.");
    } else if (cmd === "encrypt") {
      fs.writeFileSync(enc, encrypt(fs.readFileSync(plain, "utf8").replace(/^\uFEFF/, ""), process.env.LAWS_KEY));
      console.log("Готово:", enc);
    } else { console.error("Использование: decrypt | encrypt"); process.exit(2); }
  } catch (e) { console.error("Ошибка:", e.message); process.exit(1); }
}
