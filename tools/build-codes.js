/* 3.5: публичная часть сайта, собирается вместе с tools/build-site.js (Cloudflare Pages запускает его при каждом деплое).
   Страницы: /laws/ (справочник кодексов), /uk/12.8/ и т.п. (статья с превью для Discord и поисковиков), /calc/ (калькулятор без входа),
   /changes/ (лента изменений законов), /search/ (поиск по сайту), /report/ (сообщение об ошибке), /faq.html, /orgs.html, sitemap.xml.
   Статичные страницы статей строятся из таблиц Boston, встроенных в app/index.html (UK_RAW, AK_RAW, DK_RAW, PK).
   Живые данные любого сервера страница берёт у сервера (action pub_laws) и разбирает тем же scripts/law-core.js, что и программа. */
"use strict";
const fs = require("fs");
const path = require("path");

const SITE_URL = "https://senko-assistant.site";
const KN = { uk: "УК", ak: "АК", dk: "ДК", pk: "ПК" };
const KF = { uk: "Уголовный кодекс", ak: "Административный кодекс", dk: "Дорожный кодекс", pk: "Процессуальный кодекс" };

/* массивы кодексов из app/index.html: тот же разбор, что у бота в серверной функции (codesArr) */
function codesArr(html, name) {
  const m = new RegExp("\\bvar " + name + " = \\(?\\[").exec(html);
  if (!m) throw new Error("в app/index.html нет массива " + name);
  const start = m.index + m[0].length - 1;
  let depth = 0, inStr = false, i = start;
  for (; i < html.length; i++) {
    const c = html[i];
    if (inStr) { if (c === "\\") i++; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true;
    else if (c === "[") depth++;
    else if (c === "]" && --depth === 0) break;
  }
  return JSON.parse(html.slice(start, i + 1).replace(/,\s*\]/g, "]"));
}
function bostonRows(html) {
  const rows = [];
  for (const l of codesArr(html, "UK_RAW")) { const a = l.split("|"); rows.push({ k: "uk", code: a[0], title: a[1], part: a[2], stars: +a[3] || 0, m: +a[4] || 0, fmin: +a[5] || 0, fmax: +a[6] || 0, rec: a[7] === "1", note: a[8] || "" }); }
  for (const l of codesArr(html, "AK_RAW")) { const a = l.split("|"); rows.push({ k: "ak", code: a[0], title: a[1], part: a[2], fmin: +a[3] || 0, fmax: +a[4] || 0, note: a[5] || "" }); }
  for (const l of codesArr(html, "DK_RAW")) { const a = l.split("|"); rows.push({ k: "dk", code: a[0], title: a[1], part: a[2], fmax: +a[3] || 0, x: a[4] || "", note: a[5] || "" }); }
  for (const a of codesArr(html, "PK")) rows.push({ k: "pk", code: String(a[0]), part: String(a[1] || ""), title: a[2], note: a[3] || "" });
  return rows;
}

const money = (n) => "$" + String(n).replace(/\B(?=(\d{3})+(?!\d))/g, " ");
function chips(r) {
  const c = [];
  if (r.k === "uk") {
    if (r.stars) c.push("★".repeat(r.stars));
    if (r.m) c.push("до " + r.m + " мес.");
    if (r.rec) c.push("судимость");
  }
  if (r.k === "dk" && r.x) c.push(r.x);
  if (r.fmax) c.push(r.fmin && r.fmin !== r.fmax ? "штраф " + money(r.fmin) + "–" + money(r.fmax) : (r.fmin ? "штраф " + money(r.fmin) : "штраф до " + money(r.fmax)));
  return c;
}
const slugCode = (code) => String(code).replace(/[^0-9A-Za-zА-Яа-я.\-]/g, "-");

module.exports = function buildCodes(ctx) {
  const { page, esc, ROOT, SITE, out, GUIDE } = ctx;
  const html = fs.readFileSync(path.join(ROOT, "app", "index.html"), "utf8");
  const rows = bostonRows(html);
  const ASSETS = path.join(SITE, "assets");
  fs.copyFileSync(path.join(ROOT, "scripts", "law-core.js"), path.join(ASSETS, "law-core.js"));
  fs.writeFileSync(path.join(ASSETS, "codes-12.json"), JSON.stringify({ server: 12, rows }));

  const extra = (o) =>
    '<link rel="canonical" href="' + SITE_URL + o.url + '">\n' +
    '<meta property="og:type" content="website">\n<meta property="og:site_name" content="Senko Assistant">\n' +
    '<meta property="og:title" content="' + esc(o.title) + '">\n<meta property="og:description" content="' + esc(o.desc) + '">\n' +
    '<meta property="og:url" content="' + SITE_URL + o.url + '">\n<meta property="og:image" content="' + SITE_URL + '/img/og.png">\n<meta name="twitter:card" content="summary">\n' +
    '<meta name="theme-color" content="#C2530E">\n';
  const crumbs = (items) => '<div class="crumbs"><a href="/">Senko Assistant</a>' + items.map((x) => " / " + (x[1] ? '<a href="' + x[1] + '">' + esc(x[0]) + "</a>" : esc(x[0]))).join("") + "</div>";
  const srvBar = '<div class="cx-srv" data-srvbar><label>Сервер <select data-srv aria-label="Сервер"><option value="12">Boston</option><option value="7">Los Angeles</option><option value="16">Denver</option></select></label><span class="cx-st" data-st></span></div>';
  const SCR = ["/app/config.js", "/assets/law-core.js", "/assets/codes.js"];
  const pages = []; // для sitemap

  /* ───── статьи ───── */
  const arts = new Map();
  for (const r of rows) {
    const id = r.k + "|" + r.code;
    if (!arts.has(id)) arts.set(id, { k: r.k, code: r.code, title: r.title, parts: [] });
    arts.get(id).parts.push(r);
  }
  for (const a of arts.values()) {
    const url = "/" + a.k + "/" + slugCode(a.code) + "/";
    const head = KN[a.k] + " " + a.code;
    const p0 = a.parts[0];
    const sum = a.parts.map((p) => chips(p).join(", ")).filter(Boolean);
    const desc = (a.k === "pk" ? String(p0.note || p0.title).slice(0, 180) : (sum.length ? "Наказание: " + sum.slice(0, 3).join("; ") + (sum.length > 3 ? "; …" : "") : a.title)) + " · Majestic RP, Boston";
    const partsHtml = a.parts.map((p) => {
      const pn = p.part && p.part !== "1" ? "Часть " + p.part : (a.parts.length > 1 ? "Часть 1" : "");
      const ch = chips(p).map((x) => "<span>" + esc(x) + "</span>").join("");
      return '<section class="cx-part">' + (pn ? "<h2>" + esc(pn) + (p.title && p.title !== a.title ? " · " + esc(p.title) : "") + "</h2>" : "") +
        (ch ? '<div class="cx-chips">' + ch + "</div>" : "") + (p.note ? "<p>" + esc(p.note) + "</p>" : "") + "</section>";
    }).join("\n");
    const body = '<div class="wrap cx" data-art data-k="' + a.k + '" data-code="' + esc(a.code) + '">\n<div class="doc-hero">\n ' +
      crumbs([["Справочник", "/laws/"], [KF[a.k], "/laws/?k=" + a.k], ["Статья " + a.code]]) + "\n <h1>" + esc(head) + " · " + esc(a.title) + "</h1>\n " + srvBar + "\n</div>\n" +
      '<div class="cx-body" data-body>\n' + partsHtml + "\n</div>\n" +
      '<div class="cx-act"><button class="btn btn-p btn-sm" type="button" data-addcalc>В калькулятор</button><button class="btn btn-s btn-sm" type="button" data-copylink>Скопировать ссылку</button><a class="btn btn-s btn-sm" href="/laws/?k=' + a.k + '">Все статьи ' + KN[a.k] + "</a></div>\n" +
      '<p class="doc-note">Текст и наказания — из законодательной базы форума Majestic RP. По умолчанию показан Boston; выберите свой сервер выше. В программе Senko Assistant статьи обновляются каждый день.</p>\n</div>';
    out[url.slice(1) + "index.html"] = page(head + " · " + a.title + " · Senko Assistant", desc, body, SCR, extra({ url, title: head + " — " + a.title, desc }));
    pages.push(url);
  }

  /* ───── справочник, калькулятор, лента, поиск, ошибка ───── */
  const simple = (file, url, title, desc, crumb, inner, scr) => {
    out[file] = page(title + " · Senko Assistant", desc,
      '<div class="wrap cx">\n<div class="doc-hero">\n ' + crumbs([[crumb]]) + "\n <h1>" + esc(title) + "</h1>\n</div>\n" + inner + "\n</div>", scr || SCR, extra({ url, title: title + " · Senko Assistant", desc }));
    pages.push(url);
  };
  simple("laws/index.html", "/laws/", "Справочник кодексов", "УК, АК, ДК и ПК штата Сан-Андреас для серверов Majestic RP Boston, Los Angeles и Denver: поиск по номеру статьи и словам, наказания и штрафы.", "Справочник",
    srvBar + '\n<div class="cx-tools"><div class="tabs cx-tabs" role="tablist"><button class="tab" data-k="uk" aria-selected="true">УК</button><button class="tab" data-k="ak">АК</button><button class="tab" data-k="dk">ДК</button><button class="tab" data-k="pk">ПК</button></div>' +
    '<input type="search" class="cx-q" data-q placeholder="Номер или слова: 12.8, угон, оружие…" aria-label="Поиск по кодексам" autocomplete="off"></div>\n<div class="cx-list" data-list aria-live="polite"><p class="cx-load">Загружаю кодексы…</p></div>\n' +
    '<noscript><p>Без JavaScript список не показывается. Статьи Boston: ' + [...arts.values()].filter((a) => a.k === "uk").slice(0, 40).map((a) => '<a href="/uk/' + slugCode(a.code) + '/">' + esc(a.code) + "</a>").join(", ") + "…</p></noscript>");
  simple("calc/index.html", "/calc/", "Калькулятор наказаний", "Посчитать срок и штраф по статьям УК, АК и ДК Majestic RP без регистрации.", "Калькулятор",
    srvBar + '\n<div class="cx-calc"><div><input type="search" class="cx-q" data-cq placeholder="Добавить статью: 12.8, кража…" aria-label="Добавить статью" autocomplete="off"><div class="cx-sug" data-sug></div></div>' +
    '<div class="cx-sum" data-sum aria-live="polite"><p class="cx-load">Добавьте статьи, чтобы посчитать наказание.</p></div></div>\n' +
    '<p class="doc-note">Как в программе: сроки не складываются, берётся статья УК с наибольшим розыском (из равных — с большим сроком), итог не больше 50 месяцев. Штрафы АК и ДК складываются. Решение принимает сотрудник по законам своего сервера.</p>');
  simple("changes/index.html", "/changes/", "Изменения законов", "Лента изменений законодательной базы Majestic RP: новые и изменённые законы по серверам с датами.", "Изменения законов",
    '<div class="cx-srv"><label>Сервер <select data-chs aria-label="Сервер"><option value="0">Все серверы</option><option value="12">Boston</option><option value="7">Los Angeles</option><option value="16">Denver</option></select></label></div>\n<div class="cx-list" data-changes aria-live="polite"><p class="cx-load">Загружаю…</p></div>\n' +
    '<p class="doc-note">Сервер сверяет законы с форумом каждый день. Ссылку на эту страницу можно дать в форумной теме: <code>' + SITE_URL + '/changes/</code>, для одного сервера — <code>' + SITE_URL + '/changes/?s=16</code>.</p>');
  simple("search/index.html", "/search/", "Поиск по сайту", "Поиск по статьям кодексов, руководству и страницам сайта Senko Assistant.", "Поиск",
    srvBar + '\n<div class="cx-tools"><input type="search" class="cx-q" data-sq placeholder="Статья, слово или вопрос…" aria-label="Поиск по сайту" autocomplete="off"></div>\n<div class="cx-list" data-sres aria-live="polite"></div>');
  simple("rating/index.html", "/rating/", "Рейтинг недели", "Лучшие сотрудники недели по опыту в Senko Assistant на серверах Majestic RP. В таблице только те, кто сам согласился в настройках.", "Рейтинг недели",
    srvBar + '\n<div class="cx-list" data-rating aria-live="polite"><p class="cx-load">Загружаю…</p></div>\n' +
    '<p class="doc-note">Неделя считается с понедельника по московскому времени. В таблице только те, кто включил в программе: кабинет → «Рейтинг недели на сайте». Данные обновляются раз в 10 минут.</p>');
  simple("report/index.html", "/report/", "Сообщить об ошибке", "Сообщить об ошибке в программе, веб-версии или на сайте Senko Assistant без входа в аккаунт.", "Сообщить об ошибке",
    '<form class="cx-form" data-bug novalidate>\n<label>Что случилось<textarea name="text" rows="6" maxlength="2000" required placeholder="Что вы делали, что ожидали увидеть и что произошло. Номер статьи, сервер, версия программы — всё поможет."></textarea></label>\n' +
    '<label>Как с вами связаться (необязательно)<input name="contact" maxlength="120" placeholder="Telegram, Discord или ник в игре"></label>\n' +
    '<label class="cx-hp" aria-hidden="true">Не заполняйте<input name="hp" tabindex="-1" autocomplete="off"></label>\n' +
    '<button class="btn btn-p" type="submit">Отправить</button> <span class="cx-st" data-bugst role="status"></span>\n</form>\n' +
    '<p class="doc-note">Сообщение получит владелец программы. Если вы вошли в программу, удобнее писать из неё: меню → «Сообщить об ошибке», туда же придёт ответ.</p>');

  /* ───── 3.5.3: возврат из Discord после входа (программа, веб-версия, панель ждут результат у сервера) ───── */
  out["auth/discord/index.html"] = page("Вход через Discord · Senko Assistant", "Подтверждение входа через Discord.",
    '<div class="wrap cx">\n<div class="doc-hero">\n ' + crumbs([["Вход через Discord"]]) + '\n <h1>Вход через Discord</h1>\n</div>\n' +
    '<div class="cx-part cx-dc" data-dcauth aria-live="polite"><p>Проверяю вход…</p></div>\n' +
    '<p class="doc-note">Эту вкладку можно закрыть: программа, веб-версия или панель продолжат вход сами.</p>\n</div>',
    ["/app/config.js", "/assets/dcauth.js"], '<meta name="robots" content="noindex">\n<meta name="referrer" content="no-referrer">\n');

  /* ───── частые вопросы и страница для руководства ───── */
  const FAQ = [
    ["Как установить программу?", "Нажмите «Скачать» на главной странице и запустите установщик. Если Windows показывает «Система Windows защитила ваш компьютер», нажмите «Подробнее» → «Выполнить в любом случае»: у установщика нет платной подписи. Дальше программа обновляется сама."],
    ["Как войти?", "При первом запуске зарегистрируйтесь: логин, пароль, ник, статик, ведомство и сервер. Если включено подтверждение новичков, аккаунт заработает после проверки модератором. Тот же логин подходит для веб-версии на сайте."],
    ["Забыл пароль. Что делать?", "На экране входа нажмите «Забыли пароль?»: восстановление по коду восстановления или по запросу модератору."],
    ["Почему не работает ИИ-помощник?", "У ИИ есть дневной лимит вопросов на аккаунт; когда он кончился, помощник отвечает со следующего дня. Если ИИ не отвечает совсем, проверьте страницу «Состояние сервисов»: иногда бесплатные провайдеры недоступны, программа сама переключается на запасной."],
    ["Где взять бету?", "Бета-версии получают бета-тестеры: роль выдаёт владелец или модератор. Тестеру программа предлагает бету сама, в «Панели тестера» видны задания и экспериментальные функции."],
    ["Мой сервер не Boston. Подойдёт?", "Да. Программа работает на Boston, Los Angeles и Denver: сервер выбирается при регистрации или в личном кабинете, законы подгружаются с форума вашего сервера."],
    ["Есть ли версия для телефона?", "Да, веб-версия открывается в браузере телефона, её можно добавить на главный экран как приложение. Окно поверх игры и горячие клавиши есть только в программе для Windows."],
    ["Это бесплатно и официально?", "Программа бесплатная. Она сделана игроками и не связана с Majestic RP, Rockstar Games и Take-Two."],
    ["Нашёл ошибку. Куда писать?", "В программе: меню → «Сообщить об ошибке». Без программы — форма на странице «Сообщить об ошибке» на сайте."],
  ];
  out["faq.html"] = page("Частые вопросы · Senko Assistant", "Ответы на частые вопросы о Senko Assistant: установка, вход, ИИ-помощник, бета-версии, серверы и телефон.",
    '<div class="wrap">\n<div class="doc-hero">\n ' + crumbs([["Частые вопросы"]]) + "\n <h1>Частые вопросы</h1>\n</div>\n<div class=\"faq cx-faq\">\n" +
    FAQ.map((q) => "<details><summary>" + esc(q[0]) + "</summary><p>" + esc(q[1]) + "</p></details>").join("\n") +
    '\n</div>\n<p class="doc-note">Не нашли ответ? Посмотрите <a href="/guide.html">руководство</a> или <a href="/report/">напишите нам</a>.</p>\n</div>', null,
    extra({ url: "/faq.html", title: "Частые вопросы · Senko Assistant", desc: "Установка, вход, ИИ-помощник, бета-версии, серверы и телефон." }));
  pages.push("/faq.html");
  const ORGS = [
    ["Табель и итоги недели", "Руководство видит по каждому сотруднику ведомства итоги недели: задержания, пройденные тесты, опыт и достижения. Журнал смены и отчёт о смене собираются сами из задержаний."],
    ["Тесты и обучение", "В программе есть тренажёр по кодексам и РП-ситуации с разбором. Руководство проводит контрольные тесты и видит их результаты по своим сотрудникам."],
    ["Рапорты", "Рапорты пишутся по шаблону и сразу попадают к руководству ведомства: их можно принять или отклонить с комментарием, найти по автору, статику или номеру."],
    ["Объявления и мероприятия", "Руководство публикует объявления и мероприятия ведомства, они появляются на главной программы у всех сотрудников, а за час до начала программа напоминает о мероприятии."],
    ["Уведомления в Discord", "Вебхук ведомства присылает в ваш Discord новые рапорты, новых сотрудников и заявки, контрольные тесты, мероприятия и еженедельный отчёт."],
    ["Приём сотрудников", "Новые сотрудники ведомства ждут подтверждения руководства, доступ лидера выдаётся по серверу."],
  ];
  out["orgs.html"] = page("Для руководства ведомств · Senko Assistant", "Что Senko Assistant даёт руководству LSPD, LSCSD, FIB, SANG и Government: табель, тесты, рапорты, объявления и уведомления в Discord.",
    '<div class="wrap">\n<div class="doc-hero">\n ' + crumbs([["Для руководства"]]) + "\n <h1>Для руководства ведомств</h1>\n</div>\n<div class=\"cx-orgs\">\n" +
    ORGS.map((x) => '<section class="card"><h2>' + esc(x[0]) + "</h2><p>" + esc(x[1]) + "</p></section>").join("\n") +
    '\n</div>\n<figure class="cx-shot"><img src="/img/home-light-1440.webp" alt="Главная программы: объявления, мероприятия и сводка" loading="lazy" width="1440" height="900"></figure>\n' +
    '<p class="doc-note">Доступ лидера выдаёт владелец или модератор. Напишите в Telegram <a href="https://t.me/hanamochka">@hanamochka</a>, укажите ведомство и сервер.</p>\n</div>', null,
    extra({ url: "/orgs.html", title: "Для руководства ведомств · Senko Assistant", desc: "Табель, тесты, рапорты, объявления и уведомления в Discord для руководства ведомств." }));
  pages.push("/orgs.html");

  /* ───── указатель для поиска по сайту ───── */
  const idx = [
    ["Скачать программу", "/#download", "установка windows скачать установщик"],
    ["Веб-версия", "/app/", "браузер телефон веб"],
    ["Справочник кодексов", "/laws/", "ук ак дк пк кодекс статьи"],
    ["Калькулятор наказаний", "/calc/", "срок штраф посчитать калькулятор"],
    ["Изменения законов", "/changes/", "новые законы изменения форум"],
    ["Рейтинг недели", "/rating/", "рейтинг лучшие топ неделя опыт"],
    ["Частые вопросы", "/faq.html", "вопросы помощь"],
    ["Для руководства ведомств", "/orgs.html", "лидер руководство табель рапорты тесты"],
    ["Состояние сервисов", "/status.html", "не работает сервер ии статус"],
    ["Сообщить об ошибке", "/report/", "ошибка баг проблема"],
    ["Политика конфиденциальности", "/privacy.html", "данные конфиденциальность"],
    ["Условия пользования", "/terms.html", "условия правила"],
  ].map((x) => ({ t: x[0], u: x[1], h: x[2] }));
  (GUIDE || []).forEach((g, i) => idx.push({ t: "Руководство: " + g[0], u: "/guide.html#g" + (i + 1), h: g[1].join(" ").slice(0, 600) }));
  FAQ.forEach((q) => idx.push({ t: "Вопрос: " + q[0], u: "/faq.html", h: q[1] }));
  fs.writeFileSync(path.join(ASSETS, "site-index.json"), JSON.stringify(idx));

  /* ───── sitemap ───── */
  const all = ["/", "/guide.html", "/status.html", "/privacy.html", "/terms.html"].concat(pages);
  fs.writeFileSync(path.join(SITE, "sitemap.xml"), '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
    all.map((u) => " <url><loc>" + SITE_URL + u + "</loc></url>").join("\n") + "\n</urlset>\n");
  return { articles: arts.size, pages: pages.length };
};
