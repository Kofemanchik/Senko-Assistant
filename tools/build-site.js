#!/usr/bin/env node
/* Сборка страниц сайта из программы: site/privacy.html, site/terms.html, site/404.html.
   Тексты документов берутся из app/auth.html (тот же блок SenkoLegal, что в программе),
   шапка, футер и иконки берутся из site/index.html между метками <!--HEADER-->, <!--FOOTER-->, <!--SPRITE-->.
   Запуск из корня репозитория: node tools/build-site.js (Cloudflare Pages запускает его сам при каждом деплое). */
"use strict";
const fs = require("fs");
const path = require("path");

const ROOT = process.env.SENKO_ROOT || path.join(__dirname, "..");
const SITE = path.join(ROOT, "site");
const index = fs.readFileSync(path.join(SITE, "index.html"), "utf8");
const auth = fs.readFileSync(path.join(ROOT, "app", "auth.html"), "utf8");

function block(name) {
  const a = index.indexOf("<!--" + name + "-->"), b = index.indexOf("<!--/" + name + "-->");
  if (a < 0 || b < 0) throw new Error("в site/index.html нет метки " + name);
  return index.slice(a, b + name.length + 8);
}
function esc(s) { return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }

/* документы: объект DOCS и константы перед ним, как в программе */
function loadDocs() {
  const start = auth.indexOf("var DOCS = ");
  const end = auth.indexOf("\n  };", start);
  if (start < 0 || end < 0) throw new Error("в app/auth.html не найден блок DOCS");
  const consts = {};
  const head = auth.slice(auth.indexOf("SenkoLegal"), start);
  head.replace(/var (\w+) = ("(?:[^"\\]|\\.)*");/g, (m, k, v) => { consts[k] = JSON.parse(v); });
  const fn = new Function(...Object.keys(consts), "return (" + auth.slice(start + 11, end + 4) + ");");
  return { docs: fn(...Object.values(consts)), version: consts.VERSION || "" };
}

const headEnd = index.indexOf("<title>");
const headTop = index.slice(0, headEnd);
const headLinks = index.slice(index.indexOf('<link rel="icon"'), index.indexOf("</head>"));

function page(title, desc, body) {
  return headTop +
    "<title>" + esc(title) + "</title>\n" +
    '<meta name="description" content="' + esc(desc) + '">\n' +
    '<meta name="theme-color" content="#F6F3EE" media="(prefers-color-scheme: light)">\n<meta name="theme-color" content="#0A0A0B" media="(prefers-color-scheme: dark)">\n' +
    headLinks + "</head>\n<body>\n" + block("SPRITE") + '\n<a class="skip" href="#main">К содержимому</a>\n' + block("HEADER") +
    '\n<main id="main">\n' + body + "\n</main>\n\n" + block("FOOTER") +
    '\n<div class="toast" id="toast" role="status" aria-live="polite"></div>\n<script src="/assets/site.js" defer></script>\n</body>\n</html>\n';
}

function docPage(key, d, other, version) {
  const ids = d.sections.map((s, i) => "s" + (i + 1));
  const toc = d.sections.map((s, i) => '<a href="#' + ids[i] + '">' + esc(s[0]) + "</a>").join("\n   ");
  const body = d.sections.map((s, i) => '<h2 id="' + ids[i] + '">' + esc(s[0]) + "</h2>\n" + s[1].map((p) => "<p>" + esc(p) + "</p>").join("\n")).join("\n");
  return page(d.title + " · Senko Assistant", d.title + " программы Senko Assistant.",
    '<div class="wrap">\n<div class="doc-hero">\n <div class="crumbs"><a href="/">Senko Assistant</a> / Документы</div>\n <h1>' + esc(d.title) + '</h1>\n <div class="upd"><span>' + esc(d.updated) + "</span>" + (version ? "<span>версия документов " + esc(version) + "</span>" : "") + '</div>\n</div>\n' +
    '<div class="doc">\n <nav class="toc" aria-label="Разделы документа">\n   <div class="sw"><a class="btn btn-s btn-sm" href="/' + other.file + '">' + esc(other.title) + "</a></div>\n   " + toc + "\n </nav>\n" +
    ' <article class="doc-body">\n' + body + '\n<p class="doc-note">Это тот же текст, что открывается в программе: Настройки → Документы. При обновлении программы документы на сайте обновляются вместе с ней.</p>\n </article>\n</div>\n</div>');
}

const { docs, version } = loadDocs();
const out = {
  "privacy.html": docPage("privacy", docs.privacy, { file: "terms.html", title: docs.terms.title }, version),
  "terms.html": docPage("terms", docs.terms, { file: "privacy.html", title: docs.privacy.title }, version),
  "404.html": page("Страница не найдена · Senko Assistant", "Такой страницы нет.",
    '<div class="wrap nf"><div><b>404</b><h1>Такой страницы нет</h1><p>Возможно, ссылка устарела. Всё нужное есть на главной.</p><a class="btn btn-p" href="/">На главную</a></div></div>'),
};
for (const [f, html] of Object.entries(out)) fs.writeFileSync(path.join(SITE, f), html);
console.log("site: " + Object.keys(out).join(", ") + " · документы " + version);

/* ───── веб-версия помощника: /app/index.html и /app/login.html из программы ─────
   Скрипты страницы получают type="text/x-senko": их запускает site/app/web.js, когда готовы вход, данные и законы. */
function buildApp() {
  const conf = require(path.join(ROOT, "server-config.js"));
  const ver = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).version;
  const APP = path.join(SITE, "app");
  fs.mkdirSync(APP, { recursive: true });
  fs.writeFileSync(path.join(APP, "config.js"), "window.SENKO_WEB=" + JSON.stringify({ api: conf.API_URL, ver, built: new Date().toISOString().slice(0, 10) }) + ";\n");
  const stamp = "?v=" + ver + "-" + Date.now().toString(36);
  const headTags = (title) =>
    '<meta name="robots" content="noindex">\n<link rel="manifest" href="/app/manifest.webmanifest">\n<link rel="icon" href="/favicon.svg" type="image/svg+xml">\n<link rel="apple-touch-icon" href="/apple-touch-icon.png">\n' +
    '<meta name="theme-color" content="#F6F3EE" media="(prefers-color-scheme: light)">\n<meta name="theme-color" content="#0A0A0B" media="(prefers-color-scheme: dark)">\n' +
    '<meta name="apple-mobile-web-app-capable" content="yes">\n<meta name="mobile-web-app-capable" content="yes">\n<meta name="apple-mobile-web-app-title" content="Senko">\n' +
    "<title>" + title + "</title>\n";
  const must = (s, a, what) => { if (s.indexOf(a) < 0) throw new Error("не найдено в " + what + ": " + a.slice(0, 60)); };

  let ix = fs.readFileSync(path.join(ROOT, "app", "index.html"), "utf8");
  const n = (ix.match(/<script>/g) || []).length;
  if (!n || /<script\s[^>]*>/.test(ix)) throw new Error("app/index.html: неожиданный вид тегов <script>");
  ix = ix.replace(/<script>/g, '<script type="text/x-senko">');
  must(ix, "<meta charset=utf8>", "app/index.html");
  ix = ix.replace("<html><head><meta charset=utf8>", '<html lang="ru"><head><meta charset=utf8>\n' + headTags("Senko Assistant") +
    '<script src="/app/config.js' + stamp + '"></script>\n<script src="/app/web-core.js' + stamp + '"></script>\n<script src="/app/web.js' + stamp + '"></script>\n');
  ix = ix.replace("<title>Senko Assistant</title>", "");
  fs.writeFileSync(path.join(APP, "index.html"), ix);

  let au = fs.readFileSync(path.join(ROOT, "app", "auth.html"), "utf8");
  au = au.replace(/<meta http-equiv="Content-Security-Policy"[^>]*>\n?/, "").replace(/<title>[^<]*<\/title>\n?/, "");
  must(au, '<meta charset="utf-8">', "app/auth.html");
  au = au.replace('<meta charset="utf-8">', '<meta charset="utf-8">\n' + headTags("Вход · Senko Assistant") + '<link rel="stylesheet" href="/assets/fonts.css">\n' +
    '<script src="/app/config.js' + stamp + '"></script>\n<script src="/app/web-core.js' + stamp + '"></script>\n<script src="/app/web-auth.js' + stamp + '"></script>\n');
  au = au.split("Ошибка связи с программой.").join("Ошибка связи с сервером.")
    .replace(">Закрыть программу<", ">На главную сайта<")
    .replace(">Выйти без принятия<", ">Не принимать и выйти<")
    .split("Запомнить меня на этом компьютере").join("Запомнить меня на этом устройстве");
  fs.mkdirSync(path.join(APP, "login"), { recursive: true });
  fs.writeFileSync(path.join(APP, "login", "index.html"), au);
  return { scripts: n, ver };
}
const appInfo = buildApp();
console.log("site: app/index.html (" + appInfo.scripts + " скриптов), app/login/ · версия " + appInfo.ver);
