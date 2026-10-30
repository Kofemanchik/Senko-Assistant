// Проверка каталога служебных сообщений (SVC) в серверной функции: node tools/check-svc.js [путь к index.ts]
// Проверяет число записей, диапазоны категорий, допустимые типы эффектов и пределы времени.
const fs = require("fs");
const path = require("path");

const file = process.argv[2] || path.join(__dirname, "..", "supabase", "functions", "senko", "index.ts");
const src = fs.readFileSync(file, "utf8");
const a = src.indexOf("// SVC:CATALOG:BEGIN");
const b = src.indexOf("// SVC:CATALOG:END");
if (a < 0 || b < 0) { console.error("Маркеры каталога не найдены"); process.exit(1); }
const code = src.slice(a, b);
const api = new Function(code + "\nreturn { SVC_CATS, SVC_LIST, SVC_COUNT, SVC_HARD_FROM, svcItem, svcCatOf };")();

const errs = [];
const bad = (m) => errs.push(m);
const { SVC_CATS, SVC_LIST, SVC_COUNT, SVC_HARD_FROM, svcItem, svcCatOf } = api;

if (SVC_LIST.length !== SVC_COUNT) bad(`в каталоге ${SVC_LIST.length} записей, нужно ${SVC_COUNT}`);

// категории покрывают 1..150 без пропусков и пересечений
const seen = new Array(SVC_COUNT + 1).fill(0);
for (const [k, c] of Object.entries(SVC_CATS)) {
  if (!c[0] || !c[3]) bad(`категория ${k}: нет названия или значка`);
  for (let i = c[1]; i <= c[2]; i++) seen[i]++;
}
for (let i = 1; i <= SVC_COUNT; i++) if (seen[i] !== 1) bad(`номер ${i} входит в ${seen[i]} категорий`);

const SOUNDS = ["quack", "meow", "pop", "tada", "trombone", "siren", "bell", "drum", "cuckoo", "phone", "donkey", "alarm", "laugh", "type", "sad", "boing", "roar", "buzz", "ding", "whistle"];
const CSS = ["flip", "mirror", "rainbow", "invert", "blur", "gray", "sepia", "big", "small", "shake", "glitch", "comic", "dark", "tilt", "pulse"];
const TONES = ["info", "warn", "gold"];
const OPS = {
  toast: (f) => typeof f[1] === "string" && typeof f[2] === "string" && f[3] <= 20000,
  banner: (f) => typeof f[2] === "string" && f[3] <= 20000 && TONES.includes(f[4]),
  rain: (f) => f[2] >= 1 && f[2] <= 60 && f[3] <= 20000,
  float: (f) => f[2] <= 20000 && f[3] >= 24 && f[3] <= 140,
  follow: (f) => f[2] <= 60000,
  css: (f) => CSS.includes(f[1]) && f[2] <= 60000,
  sound: (f) => SOUNDS.includes(f[1]),
  confetti: (f) => f[1] <= 12000,
  plaque: (f) => typeof f[2] === "string" && typeof f[3] === "string" && f[4] <= 20000,
  modal: (f) => typeof f[2] === "string" && typeof f[3] === "string" && typeof f[4] === "string" && f[5] <= 20000,
  fake: (f) => typeof f[2] === "string" && typeof f[3] === "string" && f[4] <= 25000,
  term: (f) => typeof f[1] === "string" && Array.isArray(f[2]) && f[2].length >= 3 && f[2].length <= 12 && f[3] <= 25000,
  clicks: (f) => SOUNDS.includes(f[1]) && f[2] <= 30000,
  badge: (f) => typeof f[2] === "string" && f[3] <= 60000,
  nick: (f) => typeof f[1] === "string" && f[1].length >= 2 && f[1].length <= 60 && f[2] >= 5000 && f[2] <= 120000,
  retext: (f) => Array.isArray(f[1]) && f[1].length >= 1 && f[1].length <= 40 && f[1].every((p) => Array.isArray(p) && typeof p[0] === "string" && typeof p[1] === "string" && p[0].length <= 40 && p[1].length <= 60) && f[2] >= 5000 && f[2] <= 90000,
  mask: (f) => f[1] >= 1000 && f[1] <= 20000,
  dodge: (f) => f[1] >= 3000 && f[1] <= 30000,
  cursor: (f) => ["wait", "not-allowed", "progress", "help", "crosshair"].includes(f[1]) && f[2] <= 30000,
  accent: (f) => /^#[0-9a-f]{6}$/i.test(f[1]) && f[2] <= 40000,
  after: (f) => f[1] >= 1000 && f[1] <= 40000 && f.length >= 3 && f.length <= 8 && f.slice(2).every((g) => Array.isArray(g) && g[0] !== "after" && OPS[g[0]] && OPS[g[0]](g)),
};
const titles = new Set();
SVC_LIST.forEach((it, i) => {
  const id = i + 1;
  const where = `№${id} «${it.title}»`;
  if (!it.title || !it.desc || !it.icon) bad(`${where}: нет названия, описания или значка`);
  if (titles.has(it.title)) bad(`${where}: название повторяется`);
  titles.add(it.title);
  if (!it.fx.length) bad(`${where}: нет эффектов`);
  for (const f of it.fx) {
    if (!OPS[f[0]]) { bad(`${where}: неизвестный эффект ${f[0]}`); continue; }
    if (!OPS[f[0]](f)) bad(`${where}: неверные параметры ${JSON.stringify(f).slice(0, 80)}`);
  }
  // жёсткие и «ненастоящие окна» заканчиваются раскрытием шутки движком, поэтому у них обязательно term или fake
  if (id >= SVC_HARD_FROM && !it.fx.some((f) => f[0] === "term")) bad(`${where}: жёсткий пранк без полноэкранного окна`);
  if (id >= 101 && id < SVC_HARD_FROM && !it.fx.some((f) => f[0] === "fake")) bad(`${where}: функциональный пранк без «ненастоящего окна»`);
  const item = svcItem(id);
  if (!item || item.cat !== svcCatOf(id) || item.hard !== id >= SVC_HARD_FROM) bad(`${where}: svcItem вернул неверные данные`);
  // никаких HTML-тегов в текстах: движок выводит их как текст, но лишнего быть не должно
  if (/[<>]/.test(JSON.stringify(it.fx.map((f) => f.filter((x) => typeof x === "string" || Array.isArray(x)))))) bad(`${where}: в тексте есть «<» или «>»`);
});

// первая и последняя записи каждой категории попадают в нужную категорию
const expect = { 1: "slabyj", 20: "slabyj", 21: "srednij", 40: "srednij", 41: "serioznyj", 60: "serioznyj", 61: "ochered", 70: "ochered", 71: "veselyj", 80: "veselyj", 81: "zvukovoj", 90: "zvukovoj", 91: "glavnyj", 100: "glavnyj", 101: "funkcionalnyj", 120: "funkcionalnyj", 121: "zhostkij", 150: "zhostkij" };
for (const [id, cat] of Object.entries(expect)) if (svcCatOf(+id) !== cat) bad(`номер ${id} должен быть в категории ${cat}`);
if (svcItem(0) || svcItem(151)) bad("svcItem должен возвращать null вне 1–150");

if (errs.length) { console.error("Ошибки каталога:\n- " + errs.join("\n- ")); process.exit(1); }
console.log(`Каталог в порядке: ${SVC_LIST.length} записей, ${Object.keys(SVC_CATS).length} категорий, жёстких с №${SVC_HARD_FROM}: ${SVC_LIST.length - SVC_HARD_FROM + 1}`);
