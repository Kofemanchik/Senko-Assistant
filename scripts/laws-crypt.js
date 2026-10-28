/* Шифрование update/laws.json → update/laws.enc (AES-256-GCM + gzip).
   Ключ берётся из LAWS_KEY (секрет репозитория; тот же ключ задан в Supabase, программе он не нужен). В публичном репозитории лежит только шифртекст.

   Команды:
     (сервер задаётся переменной SERVER: 12 Boston — по умолчанию, 7 Los Angeles, 16 Denver; rekey обрабатывает все серверы сразу)
     node scripts/laws-crypt.js decrypt   — перед парсером: расшифровать прошлую версию в update/laws.json и update/.prev.json
     node scripts/laws-crypt.js encrypt   — разово: зашифровать существующий update/laws.json в update/laws.enc
     node scripts/laws-crypt.js rekey     — смена ключа: расшифровать update/laws.enc ключом LAWS_KEY и зашифровать ключом LAWS_KEY_NEW
                                            (workflow «Rekey laws», см. .github/workflows/rekey-laws.yml)
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
  const SRV = require("./servers.js");
  const cmd = process.argv[2];
  const { enc, plain, prev } = SRV.files(cmd === "rekey" ? SRV.DEFAULT : SRV.current());
  try {
    if (cmd === "decrypt") {
      if (fs.existsSync(enc)) {
        let t;
        try { t = decrypt(fs.readFileSync(enc), process.env.LAWS_KEY); } catch (e) {
          // ключ сменили, а старого нет: с галочкой «reset» начинаем как в первый раз (метки «новое/изменено» обнулятся)
          if (process.env.LAWS_RESET !== "1") throw new Error(e.message + ". Если ключ LAWS_KEY сменён, запустите «Sync laws» вручную с галочкой reset.");
          console.log("::warning::Прошлую версию не расшифровать текущим ключом — начинаем заново (reset).");
          fs.rmSync(enc);
          return;
        }
        fs.writeFileSync(plain, t); fs.writeFileSync(prev, t);
        console.log("Прошлая версия расшифрована.");
      } else if (fs.existsSync(plain)) {
        fs.copyFileSync(plain, prev); // переезд со старого открытого laws.json
        console.log("laws.enc ещё нет — за прошлую версию взят старый laws.json.");
      } else console.log("Прошлой версии нет — первый запуск.");
    } else if (cmd === "encrypt") {
      fs.writeFileSync(enc, encrypt(fs.readFileSync(plain, "utf8").replace(/^\uFEFF/, ""), process.env.LAWS_KEY));
      console.log("Готово:", enc);
    } else if (cmd === "rekey") {
      if (!process.env.LAWS_KEY_NEW) throw new Error("LAWS_KEY_NEW не задан.");
      if (process.env.LAWS_KEY_NEW === process.env.LAWS_KEY) throw new Error("LAWS_KEY_NEW совпадает с LAWS_KEY: ключ уже сменён.");
      let n = 0;
      for (const sv of SRV.SERVERS) {
        const f = SRV.files(sv.id).enc;
        if (!fs.existsSync(f)) continue;
        const t = decrypt(fs.readFileSync(f), process.env.LAWS_KEY);
        const out = encrypt(t, process.env.LAWS_KEY_NEW);
        decrypt(out, process.env.LAWS_KEY_NEW); // проверка
        fs.writeFileSync(f, out);
        n++;
      }
      if (!n) throw new Error("Нет ни одного файла законов (laws*.enc).");
      console.log("Файлов перешифровано: " + n + ". Файлы законов (laws*.enc) перешифрованы новым ключом. Теперь замените секрет LAWS_KEY значением LAWS_KEY_NEW и удалите LAWS_KEY_NEW.");
    } else { console.error("Использование: decrypt | encrypt | rekey"); process.exit(2); }
  } catch (e) { console.error("Ошибка:", e.message); process.exit(1); }
}
