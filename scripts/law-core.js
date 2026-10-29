/* Общий разбор текстов законов с форума. Один исходник для CI (Node) и для приложения (браузер).
   В приложение код вставляется между маркерами LAWCORE:BEGIN/END командой `node tools/inline-law-core.js`. */
(function (root) {
  "use strict";

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

  /* Разбор: строки с типами, список «единиц» (статьи) и оглавление */
  function parse(text) {
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
    var rr = new RegExp("(?:^|[^А-Яа-яЁё])от\\s*\\$?\\s*" + NUM + "\\s*\\$?\\s*до\\s*\\$?\\s*" + NUM + "\\s*\\$?(?!\\s*мес)", "i");
    var m = rr.exec(fp);
    if (m && /\$|штраф/i.test(fp) && !/^\s*мес/i.test(fp.slice(m.index + m[0].length))) {
      var a = money(m[1]), b = money(m[2]);
      r.hasFine = true; r.fmin = Math.min(a, b); r.fmax = Math.max(a, b);
    } else {
      var re = /\$\s*(\d[\d.,]*\d|\d)|(\d[\d.,]*\d|\d)\s*\$/g, nums = [];
      while ((m = re.exec(fp))) nums.push(money(m[1] || m[2]));
      if (nums.length) {
        r.hasFine = true;
        if (nums.length >= 2 && !hasWord(fp, "до")) { r.fmin = Math.min(nums[0], nums[1]); r.fmax = Math.max(nums[0], nums[1]); }
        else if (hasWord(fp, "до")) { r.fmin = 0; r.fmax = nums[nums.length > 1 ? 1 : 0]; }
        else if (hasWord(fp, "от") && nums.length === 1) { r.fmin = nums[0]; r.fmax = nums[0]; }
        else { r.fmin = nums[0]; r.fmax = nums[0]; }
      }
    }
    var mm = /(\d+)\s*мес/i.exec(s); if (mm) { var all = s.match(/\d+(?=\s*мес)/g) || []; r.m = Math.max.apply(null, all.map(Number)); }
    r.rec = /судимост/i.test(s);
    return r;
  }
  function starsOf(s) {
    var m = /^\s*(★+)\s*(?:[–—-]\s*(★+))?/.exec(s || "");
    return m ? (m[2] ? m[2].length : m[1].length) : 0;
  }

  /* Статьи кодекса → строки (часть = отдельная строка), как в приложении: code, part, title, jur, stars, m, fmin, fmax, rec, note, pun */
  function rowsFromParsed(parsed) {
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

  var api = { clean: clean, classify: classify, parse: parse, hash: hash, normText: normText, unitHashes: unitHashes, parsePun: parsePun, rowsFromParsed: rowsFromParsed };
  if (typeof module !== "undefined" && module.exports) module.exports = api; else root.LawCore = api;
})(typeof window !== "undefined" ? window : this);
