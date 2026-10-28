(function () {
  "use strict";
  var api = window.senkoVoice;
  var $ = function (id) { return document.getElementById(id); };
  var MODEL_URL = "senko-voice://app/model.tar.gz";
  var MAX_LISTEN_MS = 15000;   // запись останавливается сама
  var HIDE_AFTER_MS = 10000;    // оверлей прячется сам после ответа (с 2.3 время задаётся в настройках)
  var MAX_PTT_MS = 30000;      // «нажал и держи»: запись не дольше 30 секунд
  var panel = $("panel"), title = $("title"), said = $("said"), res = $("res"), foot = $("foot");
  var bars = $("bars").children;
  var tools = $("tools"), grip = $("grip"), modeBtn = $("mode"), modeT = $("modeT");

  var S = { state: "idle", modelP: null, model: null, token: 0, sess: null, hideT: null, hideMs: 0, hotkey: "",
            enabled: true, over: false, overRes: false, dragging: false, mode: "search", aiOk: false, mic: "", ptt: false, test: null };

  function setState(st, titleText, saidNode) {
    S.state = st;
    panel.className = "on " + st;
    title.textContent = titleText || "";
    said.textContent = "";
    if (saidNode) said.appendChild(saidNode);
    api.status(st);
  }
  function clearRes() { while (res.firstChild) res.removeChild(res.firstChild); foot.textContent = ""; }
  function hint() { foot.textContent = S.hotkey ? S.hotkey + " — спросить ещё раз" : ""; }
  function bold(label, text) {
    var f = document.createDocumentFragment();
    f.appendChild(document.createTextNode(label));
    var b = document.createElement("b"); b.textContent = text; f.appendChild(b);
    return f;
  }
  // Пока курсор над панелью управления или над ответом, или окно тянут мышкой — оверлей не прячем
  function busy() { return S.over || S.overRes || S.dragging; }
  function scheduleHide(ms) {
    clearTimeout(S.hideT);
    S.hideMs = ms || HIDE_AFTER_MS;
    if (busy()) return;
    S.hideT = setTimeout(hide, S.hideMs);
  }
  function resumeHide() {
    if (S.hideMs && !busy()) { clearTimeout(S.hideT); S.hideT = setTimeout(hide, S.hideMs); }
  }
  function hide() {
    clearTimeout(S.hideT); S.hideMs = 0;
    S.state = "idle"; panel.className = ""; clearRes();
    S.over = false; S.overRes = false; S.dragging = false;
    grip.classList.remove("drag");
    api.hide();
  }
  function showMessage(st, head, details, o) {
    o = o || {};
    clearRes(); setState(st, head);
    if (details) said.textContent = details;
    if (o.noHint) foot.textContent = ""; else hint();
    scheduleHide(o.ms);
  }

  /* ───── панель управления: перетаскивание и режим ───── */
  function applyAlpha(p) {
    p = Math.min(100, Math.max(30, Math.round(+p || 80)));
    document.documentElement.style.setProperty("--a", String(p / 100));
    return p;
  }

  // Мышь ловим только над панелью управления — остальной оверлей по-прежнему пропускает клики
  tools.addEventListener("mouseenter", function () { S.over = true; clearTimeout(S.hideT); api.interactive(true); });
  tools.addEventListener("mouseleave", function () {
    S.over = false;
    if (!S.dragging) { api.interactive(false); resumeHide(); }
  });
  function settle() { // после перетаскивания / ползунка: если курсор уже не над панелью — снова «насквозь»
    if (!tools.matches(":hover")) { S.over = false; api.interactive(false); }
    resumeHide();
  }

  // перетаскивание за «ручку»
  grip.addEventListener("pointerdown", function (e) {
    if (e.button !== 0) return;
    S.dragging = true; clearTimeout(S.hideT);
    grip.classList.add("drag");
    try { grip.setPointerCapture(e.pointerId); } catch (err) {}
    api.dragStart();
    e.preventDefault();
  });
  function endDrag() {
    if (!S.dragging) return;
    S.dragging = false;
    grip.classList.remove("drag");
    api.dragEnd();
    settle();
  }
  grip.addEventListener("pointerup", endDrag);
  grip.addEventListener("pointercancel", endDrag);
  grip.addEventListener("lostpointercapture", endDrag);
  grip.addEventListener("dblclick", function () { api.resetPos(); });

  window.addEventListener("blur", function () { endDrag(); });

  // режим работы: «Поиск» по памятке или вопрос «ИИ»
  function renderMode() {
    var ai = S.mode === "ai" && S.aiOk;
    modeBtn.classList.toggle("ai", ai);
    modeBtn.disabled = !S.aiOk;
    modeT.textContent = ai ? "ИИ" : "Поиск";
    modeBtn.title = !S.aiOk ? "ИИ-помощник не подключён"
      : ai ? "Режим: вопрос ИИ. Нажмите, чтобы искать по памятке" : "Режим: поиск по памятке. Нажмите, чтобы спрашивать ИИ";
  }
  modeBtn.addEventListener("click", function () {
    if (!S.aiOk) return;
    S.mode = S.mode === "ai" ? "search" : "ai";
    renderMode();
    api.setMode(S.mode);
    if (S.state === "answer" || S.state === "error" || S.state === "off" || S.state === "idle") {
      foot.textContent = S.mode === "ai" ? "Режим «ИИ»: ваш вопрос уйдёт ИИ-помощнику" : "Режим «Поиск»: ищу по памятке";
    }
  });

  // 2.3: над ответом мышь тоже ловим — карточки кликабельны (открывают статью в окне памятки)
  res.addEventListener("mouseenter", function () { if (!res.querySelector(".go")) return; S.overRes = true; clearTimeout(S.hideT); api.interactive(true); });
  res.addEventListener("mouseleave", function () {
    if (!S.overRes) return;
    S.overRes = false;
    if (!S.over && !S.dragging) { api.interactive(false); resumeHide(); }
  });
  res.addEventListener("click", function (e) {
    var t = e.target.closest && e.target.closest("[data-target]");
    if (!t) return;
    api.open(t.getAttribute("data-target"));
    S.overRes = false; api.interactive(false);
    hide();
  });

  /* ───── модель ───── */
  function loadModel() {
    if (S.model) return Promise.resolve(S.model);
    if (!S.modelP) {
      S.modelP = Vosk.createModel(MODEL_URL).then(function (m) { S.model = m; return m; })
        .catch(function (e) { S.modelP = null; throw e; });
    }
    return S.modelP;
  }

  /* ───── запись ───── */
  function cleanup(sess) {
    clearTimeout(sess.timer);
    try { sess.node.onaudioprocess = null; sess.node.disconnect(); } catch (e) {}
    try { sess.src.disconnect(); } catch (e) {}
    try { sess.stream.getTracks().forEach(function (t) { t.stop(); }); } catch (e) {} // микрофон выключается сразу
    try { sess.ctx.close(); } catch (e) {}
    try { sess.rec.remove(); } catch (e) {}
    if (S.sess === sess) S.sess = null;
  }

  function level(rms) {
    var v = Math.min(1, rms * 9);
    for (var i = 0; i < bars.length; i++) {
      var k = 0.45 + 0.55 * Math.abs(Math.sin(Date.now() / 140 + i * 1.3));
      bars[i].style.height = Math.max(4, Math.round(v * k * 20)) + "px";
    }
  }

  function finish(sess) {
    if (sess.done) return;
    sess.done = true;
    var text = (sess.ptt ? ((sess.text ? sess.text + " " : "") + (sess.partial || "")) : (sess.text || sess.partial || "")).trim();
    cleanup(sess);
    if (!text) { showMessage("error", "Не расслышал", "Нажмите горячую клавишу и повторите запрос."); return; }
    answer(text);
  }

  async function startListening(ptt) {
    if (S.state === "listening") return;
    stopTest(false);
    clearTimeout(S.hideT); S.hideMs = 0;
    var token = ++S.token;
    S.state = "starting"; // чтобы поздний ответ прежнего поиска не затёр новую запись
    clearRes();
    if (!S.model) setState("loading", "Загрузка распознавания…", document.createTextNode("При первом запуске это занимает несколько секунд"));
    var model;
    try { model = await loadModel(); }
    catch (e) { return showMessage("error", "Не удалось загрузить модель распознавания", "Проверьте, что файл voice-model/model.tar.gz есть в программе."); }
    if (token !== S.token) return;

    var stream;
    try { stream = await openMic(); }
    catch (e) { return showMessage("error", "Нет доступа к микрофону", "Включите доступ к микрофону для классических приложений: Параметры Windows → Конфиденциальность → Микрофон."); }
    if (token !== S.token) { stream.getTracks().forEach(function (t) { t.stop(); }); return; }

    var actx = new AudioContext();
    try { await actx.resume(); } catch (e) {}
    var rec = new model.KaldiRecognizer(actx.sampleRate);
    var sess = { stream: stream, ctx: actx, rec: rec, text: "", partial: "", done: false, timer: null, node: null, src: null, ptt: !!ptt };
    S.sess = sess;

    rec.on("result", function (m) {
      var t = (m && m.result && m.result.text || "").trim();
      if (!t) return;
      if (sess.ptt) { sess.text = (sess.text ? sess.text + " " : "") + t; said.textContent = sess.text; return; } // клавиша зажата — копим фразы
      sess.text = t; finish(sess);
    });
    rec.on("partialresult", function (m) {
      var p = (m && m.result && m.result.partial || "").trim();
      sess.partial = p;
      if (p && !sess.done) said.textContent = (sess.ptt && sess.text ? sess.text + " " : "") + p;
    });

    sess.node = actx.createScriptProcessor(4096, 1, 1);
    sess.node.onaudioprocess = function (ev) {
      if (sess.done) return;
      var d = ev.inputBuffer.getChannelData(0), sum = 0;
      for (var i = 0; i < d.length; i++) sum += d[i] * d[i];
      level(Math.sqrt(sum / d.length));
      try { rec.acceptWaveform(ev.inputBuffer); } catch (e) {}
    };
    sess.src = actx.createMediaStreamSource(stream);
    sess.src.connect(sess.node);
    sess.node.connect(actx.destination); // выход тихий (нули), нужен чтобы узел работал
    sess.timer = setTimeout(function () { finish(sess); }, ptt ? MAX_PTT_MS : MAX_LISTEN_MS);

    setState("listening", S.mode === "ai" && S.aiOk ? "Слушаю… (вопрос ИИ)" : "Слушаю…");
    foot.textContent = ptt ? "Говорите, пока держите " + (S.hotkey || "клавишу") + ". Отпустите — и я " + (S.mode === "ai" && S.aiOk ? "спрошу ИИ" : "начну искать")
      : "Говорите. Пауза — и я " + (S.mode === "ai" && S.aiOk ? "спрошу ИИ" : "начну искать") + (S.hotkey ? " (или " + S.hotkey + ")" : "");
  }

  function stopListening() {
    if (S.sess) finish(S.sess);
  }

  /* ───── ответ ───── */
  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  // Режим «ИИ»: распознанный текст (звук остаётся на компьютере) уходит ИИ-помощнику, ответ показываем в оверлее
  async function askAi(text, cand) {
    var q = text;
    try { // голосом числа часто звучат словами — если numbers.js получил цифры, добавим их, чтобы нашлась нужная статья
      if (cand && typeof cand.query === "string" && /\d/.test(cand.query) && !/\d/.test(text)) q = text + " (" + cand.query + ")";
    } catch (e) {}
    clearRes();
    setState("thinking", "Спрашиваю ИИ…", bold("Вы сказали: ", "«" + text + "»"));
    var r;
    try { r = await api.ask(q); } catch (e) { r = { ok: false, error: "Не удалось связаться с ИИ." }; }
    if (S.state !== "thinking") return; // пока ждали, пользователь начал новую запись
    if (!r || !r.ok) return showMessage("error", (r && r.error) || "ИИ не ответил", "«" + text + "»");

    var ans = String(r.answer || "").replace(/\*\*/g, "").trim() || "Пустой ответ.";
    if (ans.length > 650) ans = ans.slice(0, 650).replace(/\s+\S*$/, "") + "…";
    clearRes();
    setState("answer", "Ответ ИИ", bold("Вы сказали: ", "«" + text + "»"));
    res.appendChild(el("div", "aians", ans));
    var refs = (r.sources || []).map(function (s) {
      var t = s.go ? String(s.go).replace("|", ":") : s.lw ? "law:" + String(s.lw).replace("|", ":") : "";
      return { ref: String(s.ref || "").split(" — ")[0], t: t };
    }).filter(function (x) { return x.ref; }).slice(0, 5);
    if (refs.length) {
      var box = el("div", "srcs", "Статьи:");
      refs.forEach(function (x) { var c = el("span", "chip" + (x.t ? " go" : ""), x.ref); if (x.t) { c.setAttribute("data-target", x.t); c.title = "Открыть в памятке"; } box.appendChild(c); });
      res.appendChild(box);
    }
    hint();
    if (typeof r.left === "number") foot.textContent = (foot.textContent ? foot.textContent + " · " : "") + "ИИ может ошибаться · осталось вопросов: " + r.left;
    else foot.textContent = (foot.textContent ? foot.textContent + " · " : "") + "ИИ может ошибаться";
    scheduleHide();
  }

  async function answer(text) {
    var cand = SenkoNum.candidates(text);
    // 2.3: голосовые команды («добавь в калькулятор 12.8», «запусти таймер», «открой УК 12.8») — до поиска и ИИ
    var c = null;
    try { c = await api.cmd({ text: text, query: cand.query }); } catch (e) { c = null; }
    if (c && c.handled) return showMessage(c.ok ? "answer" : "error", c.text || "Готово", "«" + text + "»", { ms: 5000 });
    if (S.mode === "ai" && S.aiOk) return askAi(text, cand);
    clearRes();
    setState("thinking", "Ищу в памятке…", bold("Вы сказали: ", "«" + text + "»"));
    if (!cand.list.length) return showMessage("error", "Не понял запрос", "«" + text + "»");
    var r;
    try { r = await api.search(cand.list); } catch (e) { r = { ok: false, error: "Ошибка поиска." }; }
    if (S.state !== "thinking") return; // пока искали, пользователь начал новую запись
    if (!r || !r.ok) return showMessage("error", (r && r.error) || "Ошибка поиска", "«" + text + "»");
    if (!r.total) return showMessage("error", "Ничего не найдено", "Запрос: «" + (r.query || text) + "»");

    clearRes();
    setState("answer", "Найдено: " + r.total, bold("Запрос: ", "«" + (r.query || text) + "»" + (r.query && r.query !== cand.query ? " (упрощённый)" : "")));
    if (r.ref) res.appendChild(el("div", "ref", r.ref));
    r.items.forEach(function (it) {
      var card = el("div", "card" + (it.target ? " go" : ""));
      if (it.target) { card.setAttribute("data-target", it.target); card.title = "Открыть в памятке"; }
      var h = el("h4"); if (it.target) h.appendChild(el("span", "open", "открыть ↗")); h.appendChild(el("span", "k", it.kind)); h.appendChild(document.createTextNode("ст. " + it.code + " · " + it.title));
      card.appendChild(h);
      it.parts.forEach(function (p) {
        var row = el("div", "part");
        if (p.pn) row.appendChild(el("span", "pn", p.pn));
        if (p.text) row.appendChild(document.createTextNode(p.text));
        p.chips.forEach(function (c) { row.appendChild(el("span", "chip", c)); });
        card.appendChild(row);
      });
      if (it.more) card.appendChild(el("div", "more", "…и ещё частей: " + it.more));
      res.appendChild(card);
    });
    if (r.total > r.items.length) res.appendChild(el("div", "more", "Ещё статей: " + (r.total - r.items.length) + " — смотрите в окне памятки"));
    hint();
    scheduleHide();
  }

  api.onOpts(function (o) {
    if (typeof o.opacity === "number") applyAlpha(o.opacity);
    if (typeof o.hotkey === "string") S.hotkey = o.hotkey;
    if (typeof o.enabled === "boolean") {
      S.enabled = o.enabled;
      if (!S.enabled) { S.token++; if (S.sess) { S.sess.done = true; cleanup(S.sess); } } // выключили в настройках — запись останавливается
    }
    if (typeof o.hide === "number") HIDE_AFTER_MS = Math.min(60, Math.max(3, o.hide)) * 1000;
    if (typeof o.mic === "string") S.mic = o.mic;
    if (typeof o.ptt === "boolean") S.ptt = o.ptt;
    if (typeof o.aiOk === "boolean") S.aiOk = o.aiOk;
    if (typeof o.mode === "string") S.mode = o.mode === "ai" ? "ai" : "search";
    renderMode();
  });
  api.onCmd(function (c) {
    if (c === "start") startListening(false);
    else if (c === "start-ptt") startListening(true);
    else if (c === "ptt-off") { if (S.sess && S.sess.ptt) { S.sess.ptt = false; if (S.sess.text && !S.sess.done) finish(S.sess); } } // клавишу не держат: обычный режим
    else if (c === "stop") stopListening();
  });

  /* ───── 2.3: микрофон: выбранный в настройках, список и проверка уровня ───── */
  async function openMic() {
    var base = { channelCount: 1, echoCancellation: true, noiseSuppression: true };
    if (S.mic) {
      try { return await navigator.mediaDevices.getUserMedia({ audio: Object.assign({ deviceId: { exact: S.mic } }, base) }); }
      catch (e) { /* микрофон отключили — берём системный */ }
    }
    return navigator.mediaDevices.getUserMedia({ audio: base });
  }
  api.onMicsReq(async function (id) {
    try {
      var st = null;
      try { st = await navigator.mediaDevices.getUserMedia({ audio: true }); } catch (e) {} // без разрешения названия микрофонов пустые
      var list = (await navigator.mediaDevices.enumerateDevices()).filter(function (d) { return d.kind === "audioinput" && d.deviceId && d.deviceId !== "default" && d.deviceId !== "communications"; })
        .map(function (d, i) { return { id: d.deviceId, label: d.label || ("Микрофон " + (i + 1)) }; });
      if (st) st.getTracks().forEach(function (t) { t.stop(); });
      api.micsRes(id, { ok: true, list: list });
    } catch (e) {
      api.micsRes(id, { ok: false, error: "Нет доступа к микрофону. Проверьте Параметры Windows → Конфиденциальность → Микрофон." });
    }
  });
  function stopTest(silent) {
    var t = S.test; if (!t) return;
    S.test = null;
    clearInterval(t.iv); clearTimeout(t.to);
    try { t.src.disconnect(); } catch (e) {}
    try { t.stream.getTracks().forEach(function (x) { x.stop(); }); } catch (e) {}
    try { t.ctx.close(); } catch (e) {}
    if (!silent) api.level({ level: 0, end: true });
  }
  api.onTest(async function (o) {
    stopTest(true);
    if (!o.on) { api.level({ level: 0, end: true }); return; }
    if (typeof o.mic === "string") S.mic = o.mic;
    if (S.state === "listening") { api.level({ error: "Сейчас идёт запись голосом. Попробуйте после ответа." }); return; }
    try {
      var stream = await openMic(), actx = new AudioContext(), src = actx.createMediaStreamSource(stream), an = actx.createAnalyser();
      an.fftSize = 1024; src.connect(an);
      var buf = new Float32Array(an.fftSize);
      var t = { stream: stream, ctx: actx, src: src, iv: null, to: null };
      S.test = t;
      t.iv = setInterval(function () {
        an.getFloatTimeDomainData(buf);
        var sum = 0; for (var i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
        api.level({ level: Math.min(1, Math.sqrt(sum / buf.length) * 6) });
      }, 90);
      t.to = setTimeout(function () { stopTest(false); }, 15000);
    } catch (e) {
      api.level({ error: "Нет доступа к микрофону. Проверьте Параметры Windows → Конфиденциальность → Микрофон." });
    }
  });
  api.ready();
})();
