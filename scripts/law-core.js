/* Общий разбор текстов законов с форума. Один исходник для CI (Node) и для приложения (браузер).
   В приложение код вставляется между маркерами LAWCORE:BEGIN/END командой `node tools/inline-law-core.js`. */
(function (root) {
  "use strict";

  var cfg = { v2: false };
  function configure(o) { if (o && o.v2 != null) cfg.v2 = !!o.v2; return { v2: cfg.v2 }; }

  var ROMAN = "[IVXLCМІХ]+";
  var NB = "(?![A-Za-z\\u0400-\\u04FF0-9])"; // «граница слова» для кириллицы (\\b в JS работает только с латиницей) // латиница, кириллица М/І/Х — на форуме встречается «І» кириллицей

  function clean(s) {
    return String(s == null ? "" : s).replace(/[\u200b\u200c\u200d\ufeff]/g, "").replace(/\u00a0/g, " ").replace(/\s+$/g, "").replace(/^\s+/g, "");
  }

  /* Тип строки: part — «Общая часть/Часть I/Преамбула», sec — Раздел, chap — Глава, art — Статья,
     pt — пункт «1.», «1.1», cpart — «ч. 1.», sub — «а)», «1)», pun — наказание, note — примечание. */
  function classify(line) {
    var m;
    if (new RegExp("^(?:Общая часть|Особенная часть|Преамбула|Общее положение|Общие положения\\.?$|Приложение|Часть\\s+(?:\\d+|[IVXІ]+))" + NB, "i").test(line)) return { t: "part" };
    if (new RegExp("^Раздел\\s+" + ROMAN + NB, "i").test(line)) return { t: "sec" };
    if (new RegExp("^Глава\\s+(?:\\d+|[IVXLCМІХ]+)" + NB, "i").test(line)) return { t: "chap" };
    m = /^Статья\s+(\d+(?:\.\d+)*)\s*[.:]?\s*(?:\(([^)]{1,12})\))?\s*(.*)$/i.exec(line);
    if (m) return { t: "art", n: m[1], jur: m[2] || "", title: m[3] || "" };
    m = /^Раздел\s+(\d+(?:\.\d+)*)\s*[.:]?\s*(.*)$/i.exec(line); // Конституция: «Раздел 1. …» — это статья
    if (m) return { t: "artsec", n: m[1], title: m[2] || "" };
    if (new RegExp("^Наказание" + NB, "i").test(line)) return { t: "pun" };
    if (new RegExp("^(?:Примечани[ея]|Пояснение|Исключени[ея])" + NB, "i").test(line)) return { t: "note" };
    m = /^ч\.\s*(\d+(?:\.\d+)?)\s*[.:]?\s*(.*)$/i.exec(line);
    if (m) return { t: "cpart", n: m[1], body: m[2] };
    m = /^(\d+(?:\.\d+)*)\s*[.)]?\s+(?=\S)/.exec(line);
    if (m) return { t: "pt", n: m[1], body: line.slice(m[0].length) };
    if (/^(?:[а-яёa-z]|\d{1,2})\)\s/i.test(line)) return { t: "sub" };
    return { t: "text" };
  }

  /* Разбор: строки с типами, список «единиц» (статьи) и оглавление.
     Для Boston (сервер 12) остаётся прежний разбор. Для остальных серверов включается v2 (configure({v2:true})):
     там статьи могут называться «15.6 Халатность.» без слова «Статья», юрисдикция стоит в частях, а нумерация в ПК идёт заново в каждой главе. */
  function parseV1(text) {
    var raw = String(text || "").split("\n"), lines = [], i, c, l, first = true;
    for (i = 0; i < raw.length; i++) {
      l = clean(raw[i]);
      if (!l) continue;
      c = classify(l);
      if (first) { c = { t: "title" }; first = false; }
      c.raw = l;
      lines.push(c);
    }
    var hasArt = lines.some(function (x) { return x.t === "art"; });
    var hasArtSec = !hasArt && lines.some(function (x) { return x.t === "artsec"; });
    var units = [], toc = [], cur = null, seen = {}, chap = "", sec = "", secBare = false;
    lines.forEach(function (x, idx) {
      var isUnit = hasArt ? x.t === "art" : (hasArtSec ? x.t === "artsec" : (!hasArt && !hasArtSec && x.t === "pt" && /\./.test(x.n)));
      if (x.t === "sec" || x.t === "chap" || x.t === "part") {
        if (x.t === "chap") chap = x.raw; if (x.t === "sec") sec = x.raw;
        toc.push({ t: x.t, text: x.raw, line: idx });
        cur = null;
      }
      if (isUnit) {
        var key = x.n, k = 2; while (seen[key]) key = x.n + "#" + (k++);
        seen[key] = 1;
        cur = { key: key, n: x.n, title: x.title || "", jur: x.jur || "", line: idx, chap: chap, sec: sec, parts: [] };
        if (x.t === "pt") cur.title = x.body.slice(0, 80);
        units.push(cur);
        x.unit = key;
      }
      if (cur) cur.parts.push(idx);
    });
    units.forEach(function (u) {
      var last = u.parts.length ? u.parts[u.parts.length - 1] : u.line;
      u.end = last;
      u.text = lines.slice(u.line, last + 1).map(function (x) { return x.raw; }).join("\n");
    });
    return { lines: lines, units: units, toc: toc, mode: hasArt ? "art" : (hasArtSec ? "sec" : "pt") };
  }


  /* ───── v2: законы серверов кроме Boston ───── */
  var IMG_RE = /[A-Za-z][A-Za-z0-9_-]{3,}\.(?:png|jpe?g|gif|webp|bmp)\b/g; // подписи картинок с форума («eADEZkd.png»), в т.ч. приклеенные к тексту
  var JUR_ANY = "R\\/F|F\\/R|R|F|M|E";
  var STAR_RE = /Приоритет\s+розыска\s*:?\s*(★+)(?:\s*[–—-]\s*(★+))?/i;
  var ROM = { I: 1, V: 5, X: 10, L: 50, C: 100 };

  function chapNum(line) {
    var m = /^Глава\s+(\d+|[IVXLCМІХ]+)/i.exec(line); if (!m) return null;
    if (/^\d+$/.test(m[1])) return parseInt(m[1], 10);
    var s = m[1].replace(/М/g, "M").replace(/І/g, "I").replace(/Х/g, "X").toUpperCase(), n = 0, i, v, w;
    for (i = 0; i < s.length; i++) { v = ROM[s.charAt(i)] || 0; w = ROM[s.charAt(i + 1)] || 0; n += v < w ? -v : v; }
    return n || null;
  }
  function chapName(line) { return line.replace(/^Глава\s+(?:\d+|[IVXLCМІХ]+)\s*[.:·-]?\s*/i, "").replace(/[.\s]+$/, "").trim(); }
  function normJ(j) { return j === "R/F" ? "F/R" : j; }

  /* Короткое название статьи из первой фразы («Мелкое хулиганство, то есть нарушение…» → «Мелкое хулиганство») */
  function shortTitle(s) {
    s = String(s || "").replace(/\s+/g, " ").trim().replace(/[.:\s]+$/, "");
    var cuts = [/,\s+(?:то есть|а также|а равно)(?![А-Яа-яЁё])/i, /\s[-–—]\s/, /:\s/, /\.\s+[А-ЯЁA-Z]/], best = s.length, k, m, t, w, sp;
    for (k = 0; k < cuts.length; k++) { m = cuts[k].exec(s); if (m && m.index >= 8 && m.index < best) best = m.index; }
    t = s.slice(0, best).trim();
    if (t.length > 90) {
      /* длинная фраза: режем по запятой или по слову, чтобы заголовок не обрывался на предлоге */
      w = t.slice(0, 88); sp = w.lastIndexOf(",");
      if (sp < 45) sp = w.lastIndexOf(" ");
      w = (sp > 40 ? w.slice(0, sp) : w).replace(/[,;:\s]+$/, "");
      w = w.replace(/(?:^|\s)(?:за|на|в|во|и|или|а|по|с|со|от|до|из|к|о|об|что|если|как|при|для|не|же|то)$/i, "").replace(/[,;:\s]+$/, "");
      t = w + "…";
    }
    return t;
  }

  /* Заголовок статьи без слова «Статья»: «17.11 (R/F) Побег.» или «15.7 Название. (F) Текст…» */
  function splitHeader(body) {
    var m = new RegExp("^\\(\\s*(" + JUR_ANY + ")\\s*\\)\\s*(.*)$").exec(body);
    if (m) return { jur: normJ(m[1]), title: m[2], head: "" };
    m = new RegExp("^(.{3,200}?)[.:]?\\s*\\(\\s*(" + JUR_ANY + ")\\s*\\)\\s*(.*)$").exec(body);
    if (m) return { jur: normJ(m[2]), title: m[1], head: m[3] };
    return { jur: "", title: body, head: "" };
  }

  function parseV2(text) {
    var raw = String(text == null ? "" : text).split("\n"), lines = [], i, l, c, first = true, chapNo = null, m, sh, inNumNote = false;
    for (i = 0; i < raw.length; i++) {
      l = clean(String(raw[i]).replace(IMG_RE, "")); // подпись картинки убираем до разбора
      if (!l) continue;
      c = classify(l);
      if (first) { c = { t: "title" }; first = false; }
      else if (c.t === "chap") chapNo = chapNum(l);
      else if (c.t === "text") {
        m = /^Пункт\s+(\d+(?:\.\d+)*)\s*[.:)]?\s*(.*)$/i.exec(l);
        if (m && !inNumNote) c = { t: "cpart", n: m[1], body: m[2] };
      } else if (c.t === "pt" && /\./.test(c.n) && (chapNo == null || c.n.split(".")[0] === String(chapNo) || new RegExp("^\\(\\s*(?:" + JUR_ANY + ")\\s*\\)").test(c.body))) {
        sh = splitHeader(c.body);
        c = { t: "art", n: c.n, jur: sh.jur, title: sh.title, head: sh.head, bare: true };
      }
      /* «Часть 1. Текст» внутри статьи (УК, глава 1: «Статья 1.3. …» → «Часть 1. …») — это часть статьи, а не раздел кодекса */
      if (c.t === "part" && (m = /^Часть\s+(\d+(?:\.\d+)?)\s*[.:)]?\s*(.*)$/i.exec(l))) c = { t: "cpart", n: m[1], body: m[2] };
      /* «Примечание №4: … Пункт 1. … Пункт 2. …» — такие пункты принадлежат примечанию, а не становятся частями статьи */
      if (c.t === "note") { if (/^Примечани[ея]/i.test(l)) inNumNote = /^Примечани[ея]\s*№\s*\d+/i.test(l); }
      else if (c.t === "art" || c.t === "chap" || c.t === "sec" || c.t === "part" || c.t === "artsec") inNumNote = false;
      c.raw = l;
      c.chapNo = chapNo;
      lines.push(c);
    }
    var hasArt = lines.some(function (x) { return x.t === "art"; });
    var hasArtSec = !hasArt && lines.some(function (x) { return x.t === "artsec"; });
    var units = [], toc = [], chaps = [], cur = null, chap = "", sec = "", chapN = null;
    lines.forEach(function (x, idx) {
      var isUnit = hasArt ? x.t === "art" : (hasArtSec ? x.t === "artsec" : (x.t === "pt" && /\./.test(x.n)));
      if (x.t === "sec" || x.t === "chap" || x.t === "part") {
        if (x.t === "chap") { chap = x.raw; chapN = x.chapNo; chaps.push({ no: chapN, name: chapName(x.raw), line: idx }); }
        if (x.t === "sec") sec = x.raw;
        toc.push({ t: x.t, text: x.raw, line: idx });
        cur = null;
      }
      if (isUnit) {
        var title = String(x.title || "").replace(/^[-–—:\s]+/, ""), head = x.head || ""; // «Статья 2.6 - Название» → «Название»
        if (x.t === "pt") title = x.body.slice(0, 80);
        var st = shortTitle(title);
        if (st !== title.replace(/[.\s]+$/, "")) { head = (head ? title + " " + head : title); title = st; } // длинная фраза: коротко в заголовок, полностью в текст
        else if (!head && x.bare && title.length > 40) head = title; // «18.2 (F) Умышленные уничтожение…»: сама фраза и есть текст статьи
        cur = { n: x.n, on: x.n, full: String(x.title || "").replace(/^[-–—:\s]+/, "").trim(), title: title.replace(/[.\s]+$/, ""), head: head.trim(), jur: x.jur || "", line: idx, chap: chap, chapNo: chapN, sec: sec, parts: [] };
        units.push(cur);
        x.unitRef = cur;
      }
      if (!isUnit && !cur && (x.t === "text" || x.t === "pt" || x.t === "cpart" || x.t === "sub" || x.t === "pun" || x.t === "note")) {
        /* текст до первой статьи (вводные положения кодекса, определения в начале главы, глава «Терминология») тоже показываем отдельной записью */
        var nm = chapN != null ? (chaps.length ? chaps[chaps.length - 1].name : "") : "Вводные положения";
        cur = { n: "~", on: "~", implicit: true, full: "", title: nm || "Вводные положения", head: "", jur: "", line: idx - 1, chap: chap, chapNo: chapN == null ? 0 : chapN, sec: sec, parts: [] };
        units.push(cur);
        x.unitRef = cur;
      }
      if (cur) cur.parts.push(idx);
    });
    /* В ПК нумерация статей идёт заново в каждой главе: делаем номера уникальными по схеме «глава.статья» (глава III, ст. 4 → 3.4) */
    var byN = {}, restart = false;
    units.forEach(function (u) { if (u.implicit) return; var a = byN[u.on] || (byN[u.on] = []); if (a.length && a[0].chapNo !== u.chapNo) restart = true; a.push(u); });
    if (restart) units.forEach(function (u) { if (!u.implicit && u.chapNo != null) u.n = u.chapNo + "." + u.on; });
    var introN = 0, lastN = 0;
    units.forEach(function (u) {
      if (!u.implicit) { var iv = parseInt(u.n, 10); if (isFinite(iv)) lastN = iv; return; }
      if (u.chapNo === 0) { u.n = "0." + (++introN); return; }
      if (restart) { u.n = u.chapNo + ".0"; return; }
      var f = null; units.forEach(function (v) { if (!f && !v.implicit && v.chapNo === u.chapNo) f = v; });
      u.n = (f ? parseInt(f.on, 10) : lastN + 1) + ".0";
    });
    var seen = {};
    units.forEach(function (u) {
      var key = u.n, k = 2; while (seen[key]) key = u.n + "#" + (k++);
      seen[key] = 1; u.key = key;
      var last = u.parts.length ? u.parts[u.parts.length - 1] : u.line;
      u.end = last;
      u.text = lines.slice(u.line, last + 1).map(function (x) { return x.raw; }).join("\n");
    });
    lines.forEach(function (x) { if (x.unitRef) { x.unit = x.unitRef.key; delete x.unitRef; } });
    return { lines: lines, units: units, toc: toc, chaps: chaps, restart: restart, mode: hasArt ? "art" : (hasArtSec ? "sec" : "pt"), v2: true };
  }

  function parse(text, o) {
    var v2 = o && o.v2 != null ? !!o.v2 : cfg.v2;
    return v2 ? parseV2(text) : parseV1(text);
  }

  /* Строки таблицы из разбора v2: часть = строка. Текст статьи сохраняется целиком (с примечаниями), а звёзды, юрисдикция и наказание выносятся в отдельные поля */
  function rowsV2(parsed) {
    var rows = [], L = parsed.lines;
    function unitHasBody(u) {
      if (u.head) return true;
      for (var q = u.line + 1; q <= u.end; q++) { var y = L[q]; if (y && String(y.raw || "").replace(/^\s*(?:ч\.\s*)?\d+(?:\.\d+)*\s*[.)]?\s*$/i, "").trim()) return true; }
      return false;
    }
    var withBody = {};
    parsed.units.forEach(function (u) { if (unitHasBody(u)) withBody[u.n] = true; });
    function withBodyOnly() { return false; }

    function assemble(items, puns, artJur, canJur) {
      var stars = 0, jur = "", texts = [], pts = [], firstDone = false;
      items.forEach(function (it) {
        var s = String(it.s || ""), mm;
        mm = STAR_RE.exec(s);
        if (mm) { stars = Math.max(stars, (mm[2] || mm[1]).length); s = s.replace(STAR_RE, " ").replace(/\s{2,}/g, " ").trim(); }
        s = s.trim();
        if (!s) return;
        if (!firstDone) {
          firstDone = true;
          mm = new RegExp("^\\(\\s*(" + JUR_ANY + ")\\s*\\)\\s*").exec(s);
          if (mm) { jur = normJ(mm[1]); s = s.slice(mm[0].length).trim(); }
        }
        mm = /^([а-яёa-z]|\d{1,2})\)\s+(.*)$/i.exec(s);
        if (mm && it.k === "b") pts.push([mm[1].toLowerCase(), mm[2]]);
        if (s) texts.push(s);
      });
      return { stars: stars, jur: jur || artJur || "", texts: texts, pts: pts, puns: puns };
    }

    parsed.units.forEach(function (u) {
      if (!unitHasBody(u) && (!u.title || withBody[u.n])) return;
      var parts = [], cur = null, pre = { items: [], puns: [] }, p, x;
      if (u.head) pre.items.push({ k: "b", s: u.head });
      for (p = u.line + 1; p <= u.end; p++) {
        x = L[p];
        if (x.t === "pt" && cur && cur.isC) { cur.items.push({ k: "b", s: x.raw }); } // «1. … 2. …» после «ч. 3»: пояснения к статье, а не новые части
        else if (x.t === "pt" || x.t === "cpart") { cur = { isC: x.t === "cpart",  n: x.n, lead: x.raw, items: [], puns: [], hadBody: !!x.body }; if (x.body) cur.items.push({ k: "b", s: x.body }); parts.push(cur); }
        else {
          var tg = cur || pre;
          if (x.t === "pun") tg.puns.push(x.raw);
          else if (x.t === "note") tg.items.push({ k: "n", s: x.raw });
          else tg.items.push({ k: "b", s: x.raw });
        }
      }
      var list = [];
      if (parts.length && pre.puns.length && !parts.some(function (q) { return q.puns.length; })) {
        /* «Наказание» стоит до списка частей: оно общее на всю статью, части только перечисляют признаки (АК 2.1) */
        var all = { n: "", items: pre.items.slice(), puns: pre.puns };
        parts.forEach(function (q) { all.items.push({ k: "b", s: q.lead }); q.items.forEach(function (it, ix) { if (ix === 0 && q.hadBody) return; all.items.push(it); }); }); // «ч. 1 Текст» уже в lead, второй раз тот же текст не нужен
        list = [all];
      } else if (!parts.length) {
        list = [{ n: "", items: pre.items, puns: pre.puns }];
      } else {
        var hasPre = pre.items.some(function (it) { return String(it.s || "").trim(); });
        if (hasPre || pre.puns.length) list.push({ n: "0", items: pre.items, puns: pre.puns }); // вводная часть статьи до первого пункта
        parts.forEach(function (q) { list.push(q); });
      }
      var single = list.length === 1;
      list.forEach(function (pt, i) {
        var a = assemble(pt.items, pt.puns, u.jur);
        var puns = a.puns.map(function (z) { return z.replace(/\s+/g, " ").trim(); });
        if (!a.texts.length && u.full && u.full.length >= 25 && !withBodyOnly(u)) a.texts.push(u.full); // у статьи нет текста кроме заголовка: сама фраза и есть текст
        var body = a.texts.join("\n");
        var pun1 = puns[0] || "";
        var pp = parsePun(pun1 || (/штраф/i.test(u.title) ? u.title : ""));
        if (!pun1 && /штраф\s*(?:до|от|в размере)?\s*\$?\s*\d/i.test(body)) pp = parsePun(body);
        var punText = puns.join(" ");
        rows.push({
          code: u.n, key: u.key, part: single ? "" : (pt.n === "0" ? "0" : (pt.n || String(i + 1))), title: u.title, jur: a.jur,
          stars: a.stars, m: pp.m, fmin: pp.fmin, fmax: pp.fmax, rec: pp.rec, hasFine: pp.hasFine,
          text: body, pun: punText, note: "", pts: a.pts, chap: u.chap, chapNo: u.chapNo
        });
      });
    });
    return rows;
  }

  /* Названия глав для таблиц: {номерГлавы: название} и диапазоны номеров статей для ДК/ПК: [[от, до, название], …] */
  function chapterInfo(parsed) {
    var names = {}, ranges = [], by = {};
    names[0] = "Вводные положения";
    (parsed.chaps || []).forEach(function (c) { if (c.no != null) names[c.no] = c.name; });
    parsed.units.forEach(function (u) {
      var n = parseInt(u.n, 10); if (!isFinite(n) || u.chapNo == null) return;
      var r = by[u.chapNo]; if (!r) { r = by[u.chapNo] = [n, n]; }
      if (n < r[0]) r[0] = n; if (n > r[1]) r[1] = n;
    });
    Object.keys(by).map(Number).sort(function (a, b) { return a - b; }).forEach(function (k) { ranges.push([by[k][0], by[k][1], names[k] || ("Глава " + k)]); });
    return { names: names, ranges: ranges };
  }

  function hash(str) { // быстрый стабильный хэш (FNV-1a 32 бит, два прохода → 53 бита), без зависимостей
    var h1 = 0x811c9dc5, h2 = 0x01000193 ^ str.length, i, c;
    for (i = 0; i < str.length; i++) {
      c = str.charCodeAt(i);
      h1 ^= c; h1 = Math.imul(h1, 16777619) >>> 0;
      h2 ^= c + i; h2 = Math.imul(h2, 2246822519) >>> 0;
    }
    return h1.toString(36) + h2.toString(36);
  }
  function normText(s) { return clean(s).replace(/\s+/g, " ").toLowerCase().replace(/ё/g, "е"); }
  function unitHashes(parsed) {
    var out = {};
    parsed.units.forEach(function (u) { out[u.key] = hash(normText(u.text)); });
    return out;
  }

  /* ───── Наказания (УК, АК, ДК) ───── */
  /* Категории штрафов (Denver: «ч. 5 Устанавливаются следующие категории штрафов: 1) первая категория — от 10.000 до 20.000$; …»),
     в статьях тогда «либо штраф третьей категории». Ищем определение в тексте кодекса и подставляем суммы. */
  var ORD = [["перв", 1], ["втор", 2], ["трет", 3], ["четв", 4], ["пят", 5], ["шест", 6], ["седьм", 7], ["восьм", 8], ["девят", 9], ["десят", 10]];
  var ORD_RE = "(перв|втор|трет|четв[её]рт|пят|шест|седьм|восьм|девят|десят)[а-яё]*";
  function ordNo(w) { w = String(w).toLowerCase(); for (var i = 0; i < ORD.length; i++) if (w.indexOf(ORD[i][0]) === 0) return ORD[i][1]; return 0; }
  var fineCats = null; // {номер: [от, до]} для разбираемого кодекса
  function findFineCats(text) {
    var t = String(text || "").replace(/\s+/g, " "), out = {}, n = 0, m;
    var re = new RegExp(ORD_RE + "\\s+(?:категори[яи]|групп[аы])\\s*[—–-]\\s*(?:от\\s*)?\\$?\\s*(\\d[\\d.,\\s]*\\d|\\d)\\s*\\$?\\s*(?:до\\s*\\$?\\s*(\\d[\\d.,\\s]*\\d|\\d))?", "gi");
    while ((m = re.exec(t))) {
      var k = ordNo(m[1]), a = money(m[2]), b = m[3] ? money(m[3]) : a;
      if (k && a >= 100 && !out[k]) { out[k] = [Math.min(a, b), Math.max(a, b)]; n++; }
    }
    return n >= 2 ? out : null;
  }
  function money(tok) {
    var t = String(tok).replace(/\s/g, "");
    if (/^\d{1,3}([.,]\d{3})+$/.test(t)) return parseInt(t.replace(/[.,]/g, ""), 10);
    var n = parseFloat(t.replace(",", "."));
    return isFinite(n) ? Math.round(n) : 0;
  }
  function hasWord(s, w) { return new RegExp("(?:^|[^А-Яа-яЁёA-Za-z])" + w + "(?![А-Яа-яЁёA-Za-z])", "i").test(s); }
  function parsePun(s) {
    var r = { fmin: 0, fmax: 0, m: 0, rec: false, hasFine: false };
    if (!s) return r;
    var seg = s.replace(/^наказание[^:]*:?\s*/i, "");
    var cut = seg.search(/\s(?:либо|или)\s+(?:до\s+|от\s+)?\d+\s*мес|\s(?:либо|или)\s+лишени/i);
    var fp = cut > -1 ? seg.slice(0, cut) : seg;
    var NUM = "(\\d[\\d.,\\s]*\\d|\\d)";
    var rr = new RegExp("(?:^|[^А-Яа-яЁё])от\\s*\\$?\\s*" + NUM + "\\s*\\$?\\s*до\\s*\\$?\\s*" + NUM + "\\s*\\$?(?!\\d|[.,]\\d|\\s*(?:\\d|мес|лет|год))", "i");
    var m = rr.exec(fp);
    if (m && /\$|штраф/i.test(fp) && !/^\s*(?:мес|лет|год)/i.test(fp.slice(m.index + m[0].length))) {
      var a = money(m[1]), b = money(m[2]);
      r.hasFine = true; r.fmin = Math.min(a, b); r.fmax = Math.max(a, b);
    } else {
      var AMT = "\\d{1,3}(?:[ \\u00a0]\\d{3})+(?:[.,]\\d{3})*|\\d[\\d.,]*\\d|\\d"; // «$35 000», «$25,000», «20.000$»
      var re = new RegExp("\\$\\s*(" + AMT + ")|(" + AMT + ")\\s*\\$", "g"), nums = [];
      while ((m = re.exec(fp))) nums.push(money(m[1] || m[2]));
      if (nums.length) {
        r.hasFine = true;
        if (nums.length >= 2 && !hasWord(fp, "до")) { r.fmin = Math.min(nums[0], nums[1]); r.fmax = Math.max(nums[0], nums[1]); }
        else if (hasWord(fp, "до")) { r.fmin = 0; r.fmax = nums[nums.length > 1 ? 1 : 0]; }
        else if (hasWord(fp, "от") && nums.length === 1) { r.fmin = nums[0]; r.fmax = nums[0]; }
        else { r.fmin = nums[0]; r.fmax = nums[0]; }
      }
    }
    if (!r.hasFine && fineCats) {
      var cm = new RegExp(ORD_RE + "\\s+(?:категори|групп)", "i").exec(fp);
      var ck = cm ? ordNo(cm[1]) : 0;
      if (ck && fineCats[ck]) { r.hasFine = true; r.fmin = fineCats[ck][0]; r.fmax = fineCats[ck][1]; }
    }
    var all = s.match(/\d+(?=(?:-\s*[а-яё]{1,3})?\s*мес)/gi) || [];
    var months = all.map(Number);
    var yr = /(\d+)\s*(?:лет|года|год|годам)(?![а-яё])(?:\s*(?:и\s*)?(\d+)\s*мес)?/gi, ym;
    while (cfg.v2 && (ym = yr.exec(s))) months.push(parseInt(ym[1], 10) * 10 + (ym[2] ? parseInt(ym[2], 10) : 0)); // сроки в годах: на проекте 1 год = 10 минут (10 месяцев = 10 минут), поэтому ×10, а не ×12
    if (months.length) r.m = Math.max.apply(null, months);
    r.rec = /судимост/i.test(s);
    return r;
  }
  function starsOf(s) {
    var m = /^\s*(★+)\s*(?:[–—-]\s*(★+))?/.exec(s || "");
    return m ? (m[2] ? m[2].length : m[1].length) : 0;
  }

  /* Статьи кодекса → строки (часть = отдельная строка), как в приложении: code, part, title, jur, stars, m, fmin, fmax, rec, note, pun */
  function rowsFromParsed(parsed) {
    fineCats = parsed && parsed.lines ? findFineCats(parsed.lines.map(function (x) { return x.raw; }).join(" ")) : null;
    try { return rowsAny(parsed); } finally { fineCats = null; }
  }
  function rowsAny(parsed) {
    if (parsed && parsed.v2) return rowsV2(parsed);
    var rows = [], L = parsed.lines;
    /* Пустые статьи: заголовок без текста, наказания и примечаний (строка оглавления, «висящий» заголовок и т.п.).
       Их нельзя превращать в строки: они занимают место настоящей статьи с тем же номером и показываются пустыми. */
    function unitHasBody(u) {
      for (var q = u.line + 1; q <= u.end; q++) { var y = L[q]; if (y && String(y.raw || "").replace(/^\s*(?:ч\.\s*)?\d+(?:\.\d+)*\s*[.)]?\s*$/i, "").trim()) return true; }
      return false;
    }
    var withBody = {};
    parsed.units.forEach(function (u) { if (unitHasBody(u)) withBody[u.n] = true; });
    parsed.units.forEach(function (u) {
      if (!unitHasBody(u) && (!u.title || withBody[u.n])) return;
      var parts = [], curp = null, pre = [], prePun = [], preNote = [], p, x;
      for (p = u.line + 1; p <= u.end; p++) {
        x = L[p];
        if (x.t === "pt" || x.t === "cpart") { curp = { n: x.n, body: [x.body], pun: [], note: [] }; parts.push(curp); }
        else if (x.t === "pun") { (curp ? curp.pun : prePun).push(x.raw); }
        else if (x.t === "note") { (curp ? curp.note : preNote).push(x.raw); }
        else if (curp) curp.body.push(x.raw);
        else pre.push(x.raw);
      }
      /* «Наказание» стоит до списка пунктов — это наказание всей статьи, пункты только перечисляют признаки */
      if (prePun.length && parts.length && !parts.some(function (q) { return q.pun.length; })) {
        var all = pre.slice(); parts.forEach(function (q) { all.push(q.n + ". " + q.body.join(" ")); });
        parts = [{ n: "", body: all, pun: prePun, note: preNote }];
      } else if (!parts.length) {
        parts = [{ n: "", body: pre, pun: prePun, note: preNote }];
      } else {
        if (pre.length) parts[0].body = pre.concat(parts[0].body);
        if (prePun.length) parts[0].pun = prePun.concat(parts[0].pun);
        if (preNote.length) parts[0].note = preNote.concat(parts[0].note);
      }
      var single = parts.length === 1;
      parts.forEach(function (pt, i) {
        var body = pt.body.join(" ").replace(/\s+/g, " ").trim();
        var st = starsOf(body); body = body.replace(/^\s*★+(?:\s*[–—-]\s*★+)?\s*/, "");
        var pun = pt.pun.join(" "), pun1 = pt.pun[0] || "";
        var pp = parsePun(pun1 || (/штраф/i.test(u.title) ? u.title : ""));
        if (!pun1 && /штраф\s*(?:до|от|в размере)?\s*\$?\s*\d/i.test(body)) pp = parsePun(body);
        rows.push({
          code: u.n, key: u.key, part: single ? "" : (pt.n || String(i + 1)), title: u.title, jur: u.jur,
          stars: st, m: pp.m, fmin: pp.fmin, fmax: pp.fmax, rec: pp.rec, hasFine: pp.hasFine,
          text: body, pun: pun, note: pt.note.join(" ")
        });
      });
    });
    return rows;
  }

  var api = { configure: configure, chapterInfo: chapterInfo, clean: clean, classify: classify, parse: parse, hash: hash, normText: normText, unitHashes: unitHashes, parsePun: parsePun, rowsFromParsed: rowsFromParsed };
  if (typeof module !== "undefined" && module.exports) module.exports = api; else root.LawCore = api;
})(typeof window !== "undefined" ? window : this);
