#!/usr/bin/env node
// Расшифровка резервной копии из команды /backup.
// Запуск: node tools/decrypt-backup.js senko-backup-2026-10-20.json
// Пароль (секрет BACKUP_KEY) спросит при запуске или возьмёт из переменной BACKUP_KEY.
// Результат: рядом появится файл *.decrypted.json — храните его в надёжном месте, там личные данные.
"use strict";
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const readline = require("readline");

function ask(q) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(q, (a) => {
      rl.close();
      resolve(a);
    });
  });
}

(async () => {
  const file = process.argv[2];
  if (!file) {
    console.log("Использование: node tools/decrypt-backup.js <файл резервной копии>");
    process.exit(1);
  }
  const box = JSON.parse(fs.readFileSync(file, "utf8"));
  if (box.v !== 1 || !box.salt || !box.iv || !box.data) throw new Error("Это не файл резервной копии Senko.");
  const pass = process.env.BACKUP_KEY || (await ask("Пароль BACKUP_KEY: "));
  const salt = Buffer.from(box.salt, "base64");
  const iv = Buffer.from(box.iv, "base64");
  const raw = Buffer.from(box.data, "base64");
  const key = crypto.pbkdf2Sync(pass, salt, 200000, 32, "sha256");
  const d = crypto.createDecipheriv("aes-256-gcm", key, iv);
  d.setAuthTag(raw.subarray(raw.length - 16));
  let out;
  try {
    out = Buffer.concat([d.update(raw.subarray(0, raw.length - 16)), d.final()]).toString("utf8");
  } catch (e) {
    console.error("Не удалось расшифровать: неверный пароль или файл повреждён.");
    process.exit(2);
  }
  const data = JSON.parse(out);
  const dst = path.join(path.dirname(file), path.basename(file, ".json") + ".decrypted.json");
  fs.writeFileSync(dst, JSON.stringify(data, null, 2));
  console.log(`Готово: ${dst}`);
  console.log(`Создана: ${data.created}. Аккаунтов: ${data.profiles.length}.`);
})().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
