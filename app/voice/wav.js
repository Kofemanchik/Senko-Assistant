/* 3.9: запись для онлайн-распознавания (Whisper): общий код голосового окна и рации.
   Перед отправкой звук чистится: срезается низкий гул (фильтр ~100 Гц), по краям убирается тишина,
   громкость выравнивается. Всё считается на компьютере, наружу уходит только готовая короткая запись. */
(function (global) {
  "use strict";
  function concat(chunks) {
    var n = 0; chunks.forEach(function (c) { n += c.length; });
    var all = new Float32Array(n), o = 0;
    chunks.forEach(function (c) { all.set(c, o); o += c.length; });
    return all;
  }
  // понижение частоты до 16 кГц: среднее по окну (для речи достаточно)
  function down(all, rate) {
    var ratio = rate / 16000, m = Math.floor(all.length / ratio), out = new Float32Array(m);
    for (var i = 0; i < m; i++) {
      var a = Math.floor(i * ratio), b = Math.max(a + 1, Math.floor((i + 1) * ratio)), sum = 0, k = 0;
      for (var j = a; j < b && j < all.length; j++) { sum += all[j]; k++; }
      out[i] = k ? sum / k : 0;
    }
    return out;
  }
  // фильтр верхних частот первого порядка: убирает гул и «бубнение» ниже ~100 Гц
  function highpass(x, cut) {
    var rc = 1 / (2 * Math.PI * cut), dt = 1 / 16000, a = rc / (rc + dt), y = new Float32Array(x.length), py = 0, px = 0;
    for (var i = 0; i < x.length; i++) { py = a * (py + x[i] - px); px = x[i]; y[i] = py; }
    return y;
  }
  // обрезка тишины: окна по 20 мс, порог от уровня шума (тихих 10% окон); по краям оставляем 0,25 с
  function trim(x) {
    var W = 320, n = Math.floor(x.length / W);
    if (n < 5) return x;
    var e = [];
    for (var i = 0; i < n; i++) { var s = 0; for (var j = i * W; j < (i + 1) * W; j++) s += x[j] * x[j]; e.push(Math.sqrt(s / W)); }
    var sorted = e.slice().sort(function (a, b) { return a - b; }), noise = sorted[Math.floor(n * 0.1)] || 0, peak = sorted[n - 1] || 0;
    var thr = Math.max(noise * 3, peak * 0.08, 0.004);
    var first = e.findIndex(function (v) { return v > thr; });
    if (first < 0) return x;
    var last = n - 1; while (last > first && e[last] <= thr) last--;
    var pad = Math.round(250 / 20);
    var a = Math.max(0, (first - pad) * W), b = Math.min(x.length, (last + 1 + pad) * W);
    return x.subarray(a, b);
  }
  function normalize(x) {
    var peak = 0; for (var i = 0; i < x.length; i++) { var v = Math.abs(x[i]); if (v > peak) peak = v; }
    if (peak < 0.003) return x;
    var g = Math.min(8, 0.9 / peak), y = new Float32Array(x.length);
    for (var k = 0; k < x.length; k++) y[k] = x[k] * g;
    return y;
  }
  function toWav(x) {
    var pcm = new Int16Array(x.length);
    for (var i = 0; i < x.length; i++) { var v = Math.max(-1, Math.min(1, x[i])); pcm[i] = v < 0 ? v * 32768 : v * 32767; }
    var buf = new ArrayBuffer(44 + pcm.length * 2), dv = new DataView(buf);
    var w = function (off, str) { for (var k = 0; k < str.length; k++) dv.setUint8(off + k, str.charCodeAt(k)); };
    w(0, "RIFF"); dv.setUint32(4, 36 + pcm.length * 2, true); w(8, "WAVE"); w(12, "fmt "); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
    dv.setUint32(24, 16000, true); dv.setUint32(28, 32000, true); dv.setUint16(32, 2, true); dv.setUint16(34, 16, true); w(36, "data"); dv.setUint32(40, pcm.length * 2, true);
    new Int16Array(buf, 44).set(pcm);
    var bytes = new Uint8Array(buf), bin = "";
    for (var q = 0; q < bytes.length; q += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(q, q + 0x8000));
    return btoa(bin);
  }
  // chunks — кусочки Float32Array с микрофона, rate — частота AudioContext. clean: false — без обработки (как раньше)
  function encode(chunks, rate, opts) {
    var x = down(concat(chunks || []), rate || 48000);
    if (!opts || opts.clean !== false) x = normalize(trim(highpass(x, 100)));
    return { b64: toWav(x), sec: x.length / 16000 };
  }
  // «двенадцать точка восемь» и «12,8» → «12.8»: Whisper обычно пишет цифрами, но запятую ставит по-русски
  function fixNums(t) {
    return String(t || "").replace(/(\d+)\s*,\s*(\d+)/g, "$1.$2").replace(/(\d+)\s+точка\s+(\d+)/gi, "$1.$2");
  }
  global.SenkoWav = { encode: encode, fixNums: fixNums, _trim: trim, _highpass: highpass };
})(typeof window !== "undefined" ? window : globalThis);
