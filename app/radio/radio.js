/* 2.6: рация диспетчера. Распознавание офлайн (Vosk, та же модель, что у голосового ввода), команды выполняет окно памятки (window.SA_radioCmd) */
(function () {
  "use strict";
  var api = window.senkoRadio;
  var $ = function (id) { return document.getElementById(id); };
  var MODEL_URL = "senko-voice://app/model.tar.gz";
  var MAX_MS = 25000; // и для онлайн-распознавания: 25 с WAV 16 кГц укладываются в лимит записи
  // Второй распознаватель слушает только слова команд и числа: так номера статей, паспорта и количества разбираются заметно точнее.
  // Имя он не знает ([unk]), его берём из обычного распознавания.
  var GRAMMAR = ("задержан задержана задержаны задерживаю гражданин гражданка гражданина подозреваемый подозреваемая паспорт паспорта номер статик " +
    "статья статьи статье статью часть части точка и в ходе обыска досмотра найдено найден найдена найдены обнаружено обнаружен изъято при нем ней " +
    "куст куста кустов пакетик пакетика пакетиков пакетики семечко семечка семечек семена семян грамм грамма граммов наркотиков наркотики наркотика " +
    "вызван вызвана вызвали вызываю вызов адвокат адвоката прокурор прокурора руководство руководства медики медиков врач врача допрос допроса видео " +
    "прибыл прибыла приехал приехала на месте не ответил отказался начат начат окончен закончен пауза паузу продолжить продолжаем снять " +
    "время дата какое число сегодня который час московское сколько осталось прошло доклад сводка миранда миранды зачитай права отставить отмена отбой помощь " +
    "мера избрана задержание окончено новое переключи переключись выбери первое второе третье пятое следующее задержание " +
    "имя зовут фамилия ук ак дк пк кодекс кодекса уголовный уголовного административный административного дорожный по калькулятор срок какой итог " +
    "начато начинаю оформляю подтверждаю первая вторая третья " +
    "ноль один одна два две три четыре пять шесть семь восемь девять десять одиннадцать двенадцать тринадцать четырнадцать пятнадцать шестнадцать " +
    "семнадцать восемнадцать девятнадцать двадцать тридцать сорок пятьдесят шестьдесят семьдесят восемьдесят девяносто сто двести триста четыреста " +
    "пятьсот шестьсот семьсот восемьсот девятьсот тысяча тысячи тысяч").split(" ");
  var GJSON = JSON.stringify(GRAMMAR.filter(function (w, i, a) { return a.indexOf(w) === i; }).concat(["[unk]"]));
  var ANCH = /^(гражданин|гражданка|гражданина|гражданку|подозреваемый|подозреваемая|имя|зовут|фамилия)$/;
  var NEXT = /^(паспорт|паспорта|номер|статик|статья|статьи|статье|статью|по|часть|\[unk\])$/;
  // Текст по словарю команд дополняем именем из обычного распознавания (словарь имён не знает).
  // Команды, которые что-то отменяют или закрывают, принимаем, только если их расслышало и обычное распознавание.
  var RISKY = /^(отставить|отмена|отбой|мера|избрана|окончено|переключи|переключись|выбери)$/;
  function nameFrom(F) {
    for (var j = 0; j < F.length; j++) if (/^(граждан|гражд|господин|подозреваем|имя$|зовут$|фамилия$)/.test(F[j])) {
      var nm = [];
      for (var k = j + 1; k < F.length && nm.length < 3; k++) { if (!nm.length && /^(и|а|на|в|с|у|по|это)$/.test(F[k])) continue; if (NEXT.test(F[k]) || /^(задерж|граждан)/.test(F[k])) break; nm.push(F[k]); }
      if (nm.length) return nm.join(" ");
    }
    return "";
  }
  function merge(g, free) {
    if (!g) return "";
    var G = g.split(/\s+/), F = free ? free.split(/\s+/) : [], out = [], named = false;
    if (G.some(function (w) { return RISKY.test(w) && !F.some(function (f) { return f.slice(0, 5) === w.slice(0, 5); }); })) return "";
    var skip = false; // после вставленного имени слова словаря до «паспорт»/«статья» — это то же имя, услышанное неверно
    for (var i = 0; i < G.length; i++) {
      var w = G[i];
      if (w === "[unk]") continue;
      if (skip) { if (NEXT.test(w) || /^(задерж|найден|вызван)/.test(w)) skip = false; else continue; }
      out.push(w);
      if (!named && ANCH.test(w)) { var nm = nameFrom(F); if (nm) { out.push(nm); named = true; skip = true; } }
    }
    return out.join(" ").trim();
  }
  var S = { opts: { voice: true, sfx: true, rate: 100, voiceName: "", pin: false, hide: 20, hotkey: "", mic: "", online: true }, state: "idle", model: null, modelP: null,
            sess: null, data: null, sel: 0, hideT: null, over: false, speaking: false, token: 0 };
  var LCD = ["", "lcd-amber", "lcd-night"];
  function ls(k, d) { try { var v = localStorage.getItem(k); return v == null ? d : v; } catch (e) { return d; } }
  function lset(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
  var vol = +ls("radio-vol", 100), lcd = +ls("radio-lcd", 0) || 0;
  function applyLcd() { document.documentElement.className = LCD[lcd % 3] || ""; }
  applyLcd();
  $("volT").textContent = vol ? "ГР " + vol : "ТИХО";

  /* ───── часы по Москве ───── */
  var DAYS = ["ВС", "ПН", "ВТ", "СР", "ЧТ", "ПТ", "СБ"];
  function msk() { var d = new Date(Date.now() + 3 * 3600000); return { h: d.getUTCHours(), m: d.getUTCMinutes(), s: d.getUTCSeconds(), D: d.getUTCDate(), M: d.getUTCMonth() + 1, Y: d.getUTCFullYear(), w: d.getUTCDay() }; }
  function p2(n) { return (n < 10 ? "0" : "") + n; }
  function tick() {
    var t = msk();
    $("clk").textContent = p2(t.h) + ":" + p2(t.m);
    $("date").textContent = DAYS[t.w] + " " + p2(t.D) + "." + p2(t.M) + "." + String(t.Y).slice(2);
    renderDets();
  }
  setInterval(tick, 1000);

  /* ───── задержания ───── */
  var LIM = 3600000;
  var PN = { adv: "АДВ", pros: "ПРОК", med: "МЕД", int: "ДОПР", gov: "ОГП", call: "ЗВОН" };
  function fmt(ms) { ms = Math.max(0, ms); var s = Math.floor(ms / 1000), m = Math.floor(s / 60); s %= 60; return p2(m) + ":" + p2(s); }
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function renderDets() {
    var box = $("dets"), d = S.data || {}, T = (d.timers || []).slice(0, 12), now = Date.now();
    while (box.firstChild) box.removeChild(box.firstChild);
    if (!T.length) { box.appendChild(el("div", "none", "НЕТ ЗАДЕРЖАНИЙ")); return; }
    var selI = Math.max(0, T.findIndex(function (t) { return t.id === d.sel; }));
    var start = Math.min(Math.max(0, selI - 1), Math.max(0, T.length - 3));
    T.slice(start, start + 3).forEach(function (t) {
      var pz = t.pausedAt ? now - t.pausedAt : 0, el2 = t.decidedAt ? t.decidedAt : now - t.start - (t.pausedTotal || 0) - pz, left = LIM - el2;
      var row = el("div", "det" + (t.id === d.sel ? " sel" : "") + (t.pausedAt ? " pz" : "") + (!t.decidedAt && left < 5 * 60000 ? " low" : ""));
      row.appendChild(el("span", "n", (t.id === d.sel ? "▸" : " ") + (t.nick || "БЕЗ ИМЕНИ")));
      row.appendChild(el("span", "t", t.decidedAt ? "МЕРА" : t.pausedAt ? "⏸" + (PN[t.pk] || "ПАУЗА") + " " + fmt(pz) : fmt(left)));
      row.appendChild(el("span", "s", [t.st ? "ПСП " + t.st : "", t.arts || ""].filter(Boolean).join(" · ") || "—"));
      box.appendChild(row);
    });
  }

  /* ───── сообщение на экране ───── */
  function msg(who, text) { $("msg").firstElementChild.textContent = who + ":"; $("msgT").textContent = text || ""; }
  function led(c) { $("led").className = "led" + (c ? " " + c : ""); }
  /* ───── запись для онлайн-распознавания (WAV 16 кГц моно) ───── */
  function wavB64(chunks, rate) {
    var n = 0; chunks.forEach(function (c) { n += c.length; });
    var ratio = rate / 16000, m = Math.floor(n / ratio), pcm = new Int16Array(m), all = new Float32Array(n), o = 0;
    chunks.forEach(function (c) { all.set(c, o); o += c.length; });
    for (var i = 0; i < m; i++) { // усредняем окно вместо фильтра: для речи этого достаточно
      var a = Math.floor(i * ratio), b = Math.max(a + 1, Math.floor((i + 1) * ratio)), sum = 0;
      for (var j = a; j < b && j < n; j++) sum += all[j];
      var v = Math.max(-1, Math.min(1, sum / (b - a)));
      pcm[i] = v < 0 ? v * 32768 : v * 32767;
    }
    var buf = new ArrayBuffer(44 + pcm.length * 2), dv = new DataView(buf);
    var w = function (off, str) { for (var k = 0; k < str.length; k++) dv.setUint8(off + k, str.charCodeAt(k)); };
    w(0, "RIFF"); dv.setUint32(4, 36 + pcm.length * 2, true); w(8, "WAVE"); w(12, "fmt "); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
    dv.setUint32(24, 16000, true); dv.setUint32(28, 32000, true); dv.setUint16(32, 2, true); dv.setUint16(34, 16, true); w(36, "data"); dv.setUint32(40, pcm.length * 2, true);
    new Int16Array(buf, 44).set(pcm);
    var bytes = new Uint8Array(buf), bin = "";
    for (var q = 0; q < bytes.length; q += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(q, q + 0x8000));
    return { b64: btoa(bin), sec: m / 16000 };
  }
  function online(b64) {
    return Promise.race([api.stt(b64), new Promise(function (r) { setTimeout(function () { r({ ok: false }); }, 12000); })]).catch(function () { return { ok: false }; });
  }
  function setState(st) { S.state = st; api.status(st); $("ptt").classList.toggle("on", st === "listening"); $("pttK").textContent = st === "listening" ? "ГОТОВО" : "ГОВОРИТЬ";
    $("softMid").textContent = st === "listening" ? "ПРД" : st === "loading" ? "ЗАГР" : st === "thinking" ? "ОБРАБ" : "ПРД"; }

  /* ───── звуки рации ───── */
  var AC = null;
  function ac() { if (!AC) AC = new AudioContext(); return AC; }
  function sfx(kind) {
    if (!S.opts.sfx || !vol) return Promise.resolve();
    return new Promise(function (ok) {
      try {
        var a = ac(), t = a.currentTime, g = a.createGain(), v = vol / 100 * 0.35;
        g.connect(a.destination);
        if (kind === "beep") { // «роджер-бип» в конце передачи
          var o = a.createOscillator(); o.type = "square"; o.frequency.setValueAtTime(1250, t); o.frequency.setValueAtTime(950, t + 0.07);
          g.gain.setValueAtTime(v * 0.5, t); g.gain.setValueAtTime(0, t + 0.15); o.connect(g); o.start(t); o.stop(t + 0.16); setTimeout(ok, 170); return;
        }
        var len = kind === "open" ? 0.12 : 0.22, buf = a.createBuffer(1, Math.floor(a.sampleRate * len), a.sampleRate), ch = buf.getChannelData(0);
        for (var i = 0; i < ch.length; i++) ch[i] = (Math.random() * 2 - 1) * (1 - i / ch.length);
        var src = a.createBufferSource(), f = a.createBiquadFilter(); f.type = "bandpass"; f.frequency.value = 1800; f.Q.value = 0.8;
        src.buffer = buf; src.connect(f); f.connect(g); g.gain.setValueAtTime(v, t); src.start(t); setTimeout(ok, len * 1000 + 10);
      } catch (e) { ok(); }
    });
  }

  /* ───── голос диспетчера ───── */
  function pickVoice() {
    var vs = (window.speechSynthesis && speechSynthesis.getVoices()) || [];
    if (S.opts.voiceName) { var v = vs.filter(function (x) { return x.name === S.opts.voiceName; })[0]; if (v) return v; }
    return vs.filter(function (x) { return /^ru/i.test(x.lang); })[0] || null;
  }
  function speak(text) {
    return new Promise(function (ok) {
      if (!S.opts.voice || !vol || !text || !window.speechSynthesis) { ok(); return; }
      try {
        speechSynthesis.cancel();
        var u = new SpeechSynthesisUtterance(text), v = pickVoice();
        if (v) { u.voice = v; u.lang = v.lang; } else u.lang = "ru-RU";
        u.rate = Math.min(2, Math.max(0.5, (+S.opts.rate || 100) / 100)); u.volume = vol / 100; u.pitch = 0.9;
        var done = false, fin = function () { if (!done) { done = true; clearTimeout(to); ok(); } }, to = setTimeout(fin, 15000);
        u.onend = fin; u.onerror = fin; speechSynthesis.speak(u);
      } catch (e) { ok(); }
    });
  }
  async function reply(r) {
    r = r || {};
    var say = String(r.say || "").trim(), show = String(r.show || say || "").trim();
    msg("ДИСП", show || "Повторите, не расслышал.");
    S.speaking = true; led("rx"); $("grill").classList.add("talk");
    await sfx("open"); await speak(say || (show ? "" : "Повторите, не расслышал.")); await sfx("beep");
    $("grill").classList.remove("talk"); led(""); S.speaking = false;
    if (r.close) { api.hide(); return; }
    scheduleHide();
  }

  /* ───── автоскрытие ───── */
  function scheduleHide() {
    clearTimeout(S.hideT);
    if (S.opts.pin || S.over || S.state !== "idle" || S.speaking) return;
    S.hideT = setTimeout(function () { if (!S.over && S.state === "idle" && !S.speaking && !S.opts.pin) api.hide(); }, Math.max(5, +S.opts.hide || 20) * 1000);
  }
  document.addEventListener("mouseenter", function () { S.over = true; clearTimeout(S.hideT); });
  document.addEventListener("mouseleave", function () { S.over = false; scheduleHide(); });

  /* ───── распознавание ───── */
  function loadModel() {
    if (S.model) return Promise.resolve(S.model);
    if (!S.modelP) S.modelP = Vosk.createModel(MODEL_URL).then(function (m) { S.model = m; return m; }).catch(function (e) { S.modelP = null; throw e; });
    return S.modelP;
  }
  async function openMic() {
    var base = { channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: false }; // Vosk точнее на «сыром» звуке
    if (S.opts.mic) { try { return await navigator.mediaDevices.getUserMedia({ audio: Object.assign({ deviceId: { exact: S.opts.mic } }, base) }); } catch (e) {} }
    return navigator.mediaDevices.getUserMedia({ audio: base });
  }
  function cleanup(s) {
    clearTimeout(s.timer);
    try { s.node.onaudioprocess = null; s.node.disconnect(); } catch (e) {}
    try { s.src.disconnect(); } catch (e) {}
    try { s.stream.getTracks().forEach(function (t) { t.stop(); }); } catch (e) {}
    try { s.ctx.close(); } catch (e) {}
    try { s.rec.remove(); } catch (e) {}
    try { if (s.recG) s.recG.remove(); } catch (e) {}
    if (S.sess === s) S.sess = null;
  }
  function bars(rms) { var v = Math.min(1, rms * 9), n = Math.round(v * 4); $("softMid").textContent = "ПРД " + "▮▮▮▮".slice(0, n) + "▯▯▯▯".slice(n); }
  async function start() {
    if (S.state === "listening" || S.state === "loading") return;
    clearTimeout(S.hideT); try { speechSynthesis.cancel(); } catch (e) {}
    var token = ++S.token;
    if (!S.model) { setState("loading"); led("busy"); msg("РАЦИЯ", "Загрузка распознавания…"); }
    var model;
    try { model = await loadModel(); } catch (e) { setState("idle"); led(""); msg("РАЦИЯ", "Нет модели распознавания (voice-model)."); return; }
    if (token !== S.token) return;
    var stream;
    try { stream = await openMic(); } catch (e) { setState("idle"); led(""); msg("РАЦИЯ", "Нет доступа к микрофону."); return; }
    if (token !== S.token) { stream.getTracks().forEach(function (t) { t.stop(); }); return; }
    var actx = new AudioContext(); try { await actx.resume(); } catch (e) {}
    var rec = new model.KaldiRecognizer(actx.sampleRate), recG = null;
    try { recG = new model.KaldiRecognizer(actx.sampleRate, GJSON); } catch (e) { recG = null; }
    var s = { stream: stream, ctx: actx, rec: rec, recG: recG, text: "", partial: "", gtext: "", gpartial: "", done: false, pcm: [], rate: actx.sampleRate };
    S.sess = s;
    if (recG) {
      recG.on("result", function (m) { var t = (m && m.result && m.result.text || "").trim(); if (t) s.gtext = (s.gtext ? s.gtext + " " : "") + t; });
      recG.on("partialresult", function (m) { s.gpartial = (m && m.result && m.result.partial || "").trim(); });
    }
    rec.on("result", function (m) { var t = (m && m.result && m.result.text || "").trim(); if (t) { s.text = (s.text ? s.text + " " : "") + t; msg("Я", s.text); } });
    rec.on("partialresult", function (m) { var p = (m && m.result && m.result.partial || "").trim(); s.partial = p; if (p && !s.done) msg("Я", (s.text ? s.text + " " : "") + p); });
    s.node = actx.createScriptProcessor(4096, 1, 1);
    s.node.onaudioprocess = function (ev) {
      if (s.done) return;
      var d = ev.inputBuffer.getChannelData(0), sum = 0; for (var i = 0; i < d.length; i++) sum += d[i] * d[i];
      bars(Math.sqrt(sum / d.length));
      if (S.opts.online && api.stt) s.pcm.push(new Float32Array(d));
      try { rec.acceptWaveform(ev.inputBuffer); } catch (e) {}
      if (recG) { try { recG.acceptWaveform(ev.inputBuffer); } catch (e) {} }
    };
    s.src = actx.createMediaStreamSource(stream); s.src.connect(s.node); s.node.connect(actx.destination);
    s.timer = setTimeout(function () { stop(); }, MAX_MS);
    setState("listening"); led("tx"); msg("Я", "…"); sfx("open");
  }
  function stop() {
    var s = S.sess;
    if (!s) { if (S.state === "loading") { S.token++; setState("idle"); led(""); } return; }
    if (s.done) return;
    s.done = true;
    // даём распознаванию дослушать хвост фразы
    setTimeout(function () {
      var text = ((s.text ? s.text + " " : "") + (s.partial || "")).trim();
      var gt = ((s.gtext ? s.gtext + " " : "") + (s.gpartial || "")).trim();
      var off = gt ? merge(gt, text) : "";
      var pcm = s.pcm, rate = s.rate; s.pcm = [];
      cleanup(s); setState("thinking"); led("busy");
      if (!S.opts.online || !api.stt || !pcm.length) { send(off || text, text); return; }
      var wav = wavB64(pcm, rate);
      if (wav.sec < 0.4) { send(off || text, text); return; }
      msg("РАЦИЯ", "Распознаю…");
      online(wav.b64).then(function (r) {
        var t = r && r.ok ? String(r.text || "").trim() : "";
        // онлайн-текст главный, офлайн остаётся запасным вариантом разбора
        if (t) send(t, off || text); else send(off || text, text);
      });
    }, 250);
  }
  async function send(text, alt) { // text — главный вариант разбора, alt — запасной (если по главному диспетчер не понял)
    text = String(text || "").trim(); alt = String(alt || "").trim();
    if (!text && alt) { text = alt; alt = ""; }
    if (!text) { setState("idle"); reply({ say: "Повторите, не расслышал.", show: "Повторите, не расслышал." }); return; }
    msg("Я", text);
    var r;
    try { r = await api.text(text, alt !== text ? alt : ""); } catch (e) { r = { say: "Нет связи с программой.", show: "Нет связи с программой." }; }
    setState("idle");
    reply(r);
  }

  /* ───── управление ───── */
  var ptt = $("ptt");
  ptt.addEventListener("pointerdown", function (e) { e.preventDefault(); e.stopPropagation(); try { ptt.setPointerCapture(e.pointerId); } catch (x) {} start(); });
  function pttUp() { if (S.state === "listening" || S.state === "loading") stop(); }
  ptt.addEventListener("pointerup", pttUp); ptt.addEventListener("pointercancel", pttUp);
  document.addEventListener("click", function (e) {
    var b = e.target.closest && e.target.closest("[data-act]"); if (!b) return;
    var a = b.getAttribute("data-act");
    if (a === "ptt-toggle") { if (S.state === "listening") stop(); else start(); return; }
    if (a === "hide") { api.hide(); return; }
    if (a === "det") { api.open("timer"); return; }
    if (a === "menu") { api.open("radio"); return; }
    if (a === "vol") { vol = vol >= 100 ? 70 : vol >= 70 ? 40 : vol >= 40 ? 0 : 100; lset("radio-vol", vol); $("volT").textContent = vol ? "ГР " + vol : "ТИХО"; return; }
    if (a === "lcd") { lcd = (lcd + 1) % 3; lset("radio-lcd", lcd); applyLcd(); return; }
    if (a === "up" || a === "down") {
      var T = (S.data && S.data.timers) || []; if (!T.length) return;
      var i = Math.max(0, T.findIndex(function (t) { return t.id === S.data.sel; })), j = (i + (a === "up" ? -1 : 1) + T.length) % T.length;
      S.data.sel = T[j].id; renderDets(); api.select(T[j].id); return;
    }
  });
  // перетаскивание за корпус
  var body = $("body"), dragging = false;
  body.addEventListener("pointerdown", function (e) {
    if (e.button !== 0 || (e.target.closest && e.target.closest("button,[data-act],.lcdw"))) return;
    dragging = true; body.classList.add("drag"); try { body.setPointerCapture(e.pointerId); } catch (x) {} api.dragStart(); e.preventDefault();
  });
  function endDrag() { if (!dragging) return; dragging = false; body.classList.remove("drag"); api.dragEnd(); }
  body.addEventListener("pointerup", endDrag); body.addEventListener("pointercancel", endDrag); body.addEventListener("lostpointercapture", endDrag);
  body.addEventListener("dblclick", function (e) { if (!(e.target.closest && e.target.closest("button,[data-act]"))) api.resetPos(); });

  api.onState(function (d) { S.data = d || {}; renderDets(); });
  api.onOpts(function (o) { S.opts = Object.assign(S.opts, o || {}); $("tip").textContent = S.opts.hotkey ? "Держите " + S.opts.hotkey + " или PTT" : "Зажмите PTT и говорите"; scheduleHide(); });
  api.onCmd(function (c) {
    if (c === "start") start();
    else if (c === "stop") stop();
    else if (c === "toggle") { if (S.state === "listening") stop(); else start(); }
    else if (c === "shown") scheduleHide();
  });
  api.onSay(function (r) { reply(r); });
  // голоса подгружаются асинхронно
  try { speechSynthesis.getVoices(); speechSynthesis.onvoiceschanged = function () {}; } catch (e) {}
  tick();
  api.ready();
})();
