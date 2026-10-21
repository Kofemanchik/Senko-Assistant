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
