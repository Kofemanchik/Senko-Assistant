// Записывает дату сборки в build-info.json — её показывает окно «О программе».
// Запускается автоматически командой `npm run dist`.
const fs = require("fs");
const path = require("path");
const pkg = require("../package.json");
const file = path.join(__dirname, "..", "build-info.json");
fs.writeFileSync(file, JSON.stringify({ version: pkg.version, date: new Date().toISOString() }, null, 2) + "\n");
console.log("build-info.json:", pkg.version);
