/* Нормализация голосового запроса: числа словами → цифры, «точка» → ".", буквы пунктов, лишние слова долой */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.SenkoNum = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";
  var UNITS = { "ноль": 0, "нуль": 0, "один": 1, "одна": 1, "одно": 1, "одну": 1, "два": 2, "две": 2, "три": 3, "четыре": 4, "пять": 5, "шесть": 6, "семь": 7, "восемь": 8, "девять": 9 };
  var TEENS = { "десять": 10, "одиннадцать": 11, "двенадцать": 12, "тринадцать": 13, "четырнадцать": 14, "пятнадцать": 15, "шестнадцать": 16, "семнадцать": 17, "восемнадцать": 18, "девятнадцать": 19 };
  var TENS = { "двадцать": 20, "тридцать": 30, "сорок": 40, "пятьдесят": 50, "шестьдесят": 60, "семьдесят": 70, "восемьдесят": 80, "девяносто": 90 };
  var HUND = { "сто": 100, "двести": 200, "триста": 300, "четыреста": 400, "пятьсот": 500, "шестьсот": 600, "семьсот": 700, "восемьсот": 800, "девятьсот": 900 };
  var LETTERS = { "а": "а", "б": "б", "бэ": "б", "бе": "б", "в": "в", "вэ": "в", "ве": "в", "г": "г", "гэ": "г", "д": "д", "дэ": "д", "е": "е" };
  var DOTS = { "точка": 1, "запятая": 1, "дробь": 1 };
  var MARK = { "пункт": 1, "подпункт": 1, "буква": 1, "пэ": 1 };
  var PART = { "часть": 1, "ч": 1 };
  var STOP = {};
  ("статья статью статьи статье ст по за на в во и или а к с у о об что это такое какая какой какое какие какую где найди найти покажи скажи " +
   "мне про сколько дают дадут будет если нужно можно ли там есть штраф штрафа наказание наказания ответственность срок сколько").split(" ").forEach(function (w) { STOP[w] = 1; });

  function classify(w) {
    if (/^\d+$/.test(w)) return { v: +w, c: "D" };
    if (UNITS.hasOwnProperty(w)) return { v: UNITS[w], c: "U" };
    if (TEENS.hasOwnProperty(w)) return { v: TEENS[w], c: "E" };
    if (TENS.hasOwnProperty(w)) return { v: TENS[w], c: "T" };
    if (HUND.hasOwnProperty(w)) return { v: HUND[w], c: "H" };
    return null;
  }
  function canExtend(prev, next) {
    return (prev === "H" && (next === "T" || next === "E" || next === "U")) || (prev === "T" && next === "U");
  }

  function tokenize(text) {
    return String(text || "").toLowerCase().replace(/ё/g, "е").split(/[^a-zа-я0-9]+/).filter(Boolean);
  }

  /* слова → токены {t:"num"|"dot"|"word"|"mark"|"part", s} */
  function lex(words) {
    var out = [], i = 0;
    while (i < words.length) {
      var w = words[i], k = classify(w);
      if (k) {
        var val = k.v, last = k.c; i++;
        while (i < words.length) {
          var k2 = classify(words[i]);
          if (!k2 || !canExtend(last, k2.c)) break;
          val += k2.v; last = k2.c; i++;
        }
        out.push({ t: "num", s: String(val) });
        continue;
      }
      if (DOTS[w]) out.push({ t: "dot" });
      else if (MARK[w]) out.push({ t: "mark" });
      else if (PART[w]) out.push({ t: "part" });
      else out.push({ t: "word", s: w });
      i++;
    }
    return out;
  }

  function normalize(text) {
    var tk = lex(tokenize(text)), parts = [], hasRef = false, i = 0;
    while (i < tk.length) {
      var t = tk[i];
      if (t.t === "part") { // «часть N» не поддерживается в строке поиска — пропускаем
        i++; if (tk[i] && tk[i].t === "num") i++;
        continue;
      }
      if (t.t === "num") {
        var ref = t.s; i++;
        for (;;) {
          if (tk[i] && tk[i].t === "dot" && tk[i + 1] && tk[i + 1].t === "num") { ref += "." + tk[i + 1].s; i += 2; }
          else if (tk[i] && tk[i].t === "num") { ref += "." + tk[i].s; i++; }
          else break;
        }
        var j = i; while (tk[j] && (tk[j].t === "mark" || tk[j].t === "dot")) j++;
        if (tk[j] && tk[j].t === "word" && LETTERS.hasOwnProperty(tk[j].s)) { ref += "." + LETTERS[tk[j].s]; i = j + 1; }
        parts.push(ref); hasRef = true;
        continue;
      }
      if (t.t === "word" && !STOP[t.s]) parts.push(t.s);
      i++;
    }
    return { query: parts.join(" ").trim(), hasRef: hasRef, words: parts };
  }

  /* Варианты запроса: полный, затем (если слов несколько) самые длинные отдельные слова */
  function candidates(text) {
    var n = normalize(text), list = [];
    if (n.query) list.push(n.query);
    if (!n.hasRef && n.words.length > 1) {
      n.words.slice().sort(function (a, b) { return b.length - a.length; }).slice(0, 3).forEach(function (w) {
        if (w.length >= 4 && list.indexOf(w) < 0) list.push(w);
      });
    }
    return { query: n.query, hasRef: n.hasRef, list: list };
  }

  return { normalize: normalize, candidates: candidates };
});
