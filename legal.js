/* ===== Senko Assistant: Политика конфиденциальности и Условия пользования =====
   Один и тот же файл подключается и в index.html (настройки), и в app/auth.html (регистрация).
   API:
     SenkoLegal.VERSION                    — версия документов (меняйте при правке текстов)
     SenkoLegal.open("privacy"|"terms")    — открыть мини-окно с документом
     SenkoLegal.consentHtml(id)            — HTML строки «галочка + кликабельные ссылки»
     SenkoLegal.bind(root)                 — подключить обработчики; возвращает {checked(), onChange(fn), shake()}
*/
(function () {
  "use strict";
  if (window.SenkoLegal) return;

  var VERSION = "2026-10-18";
  var CONTACT = "Discord: hanamis1";

  var DOCS = {
    privacy: {
      title: "Политика конфиденциальности",
      updated: "18 октября 2026",
      sections: [
        ["1. Общие положения",
          ["Senko Assistant (далее — «Программа») — справочное приложение-памятка по законодательству игрового проекта Majestic RP Boston. Эта Политика объясняет, какие данные Программа хранит и как с ними обращается.",
           "Программа создана игроками и не является официальным продуктом Majestic RP или администрации проекта."]],
        ["2. Какие данные хранятся",
          ["При регистрации и использовании Программа хранит: логин, игровой ник, статик, организацию, роль, пароль для входа и аватар (если вы его загрузили). Пароль хранится только в виде хэша, открытого пароля в программе нет. Если вы выбрали «Запомнить меня», на компьютере сохраняется токен автоматического входа.",
           "Также сохраняются данные вашей работы: настройки интерфейса, история задержаний и расчётов из калькулятора, результаты тестов из раздела «Обучение», позиция прокрутки, избранное и пометки."]],
        ["3. Где хранятся данные",
          ["Все перечисленные данные хранятся только на вашем компьютере: в локальном хранилище приложения, в папке данных программы (аккаунты и резервная копия настроек) и в папке «Документы\Senko Assistant\Пользователи» (файл профиля). Программа не отправляет их на серверы разработчика и не передаёт третьим лицам.",
           "Если вы удалите данные приложения или переустановите систему без переноса папки данных, информация будет утрачена. Резервную копию можно сохранить, скопировав папку данных программы."]],
        ["4. Сетевые обращения",
          ["Программа обращается к интернету только для проверки и загрузки обновлений (через GitHub) и, если вы включите соответствующие функции, для получения актуальных текстов законодательства с форума проекта. В этих запросах не передаются ваши логин, пароль, ник и иные личные данные.",
           "Голосовой ввод работает с помощью модели распознавания речи, встроенной в Программу. Аудио с микрофона обрабатывается на вашем устройстве и никуда не отправляется и не записывается."]],
        ["5. Аналитика, реклама, cookie",
          ["Программа не содержит рекламы, счётчиков, аналитики и средств отслеживания. Данные не продаются и не используются для профилирования."]],
        ["6. Ваши права",
          ["Вы можете в любой момент изменить или удалить свои данные: очистить историю в личном кабинете, выйти из аккаунта, удалить приложение и его папку данных. После удаления папки данных восстановить информацию невозможно.",
           "Храните пароль в секрете. Не используйте в Программе пароль, который вы применяете на других сайтах и сервисах."]],
        ["7. Изменения Политики",
          ["Текст Политики может обновляться вместе с версиями Программы. Актуальная редакция всегда доступна в Программе: Настройки → Документы."]],
        ["8. Контакты",
          ["Вопросы и предложения по обработке данных: " + CONTACT + "."]]
      ]
    },
    terms: {
      title: "Условия пользования",
      updated: "18 октября 2026",
      sections: [
        ["1. Принятие условий",
          ["Регистрируясь в Senko Assistant и используя Программу, вы подтверждаете, что прочитали эти Условия и Политику конфиденциальности и согласны с ними. Если вы не согласны, не используйте Программу."]],
        ["2. Назначение Программы",
          ["Программа — бесплатный справочный инструмент: памятка по законодательству проекта Majestic RP Boston, калькулятор сроков и штрафов, помощники для сотрудников. Она предназначена только для игровых целей внутри проекта."]],
        ["3. Неофициальный характер и точность данных",
          ["Программа не связана с Majestic RP и не является официальным источником. Тексты законов приведены для удобства и могут отставать от актуальной редакции или содержать ошибки.",
           "При расхождении приоритет всегда имеет официальный текст на форуме проекта. Разработчик не несёт ответственности за последствия решений, принятых только на основании данных Программы, включая игровые наказания, жалобы и иски."]],
        ["4. Правила использования",
          ["Запрещается: взламывать или модифицировать Программу с целью обхода ограничений; распространять изменённые копии под видом оригинала; использовать Программу для нарушения правил проекта или причинения вреда другим игрокам; выдавать себя за другого человека при регистрации.",
           "Вы отвечаете за достоверность данных, которые указываете, и за сохранность своего пароля."]],
        ["5. Права на программу",
          ["Программа и её оформление принадлежат её автору. Материалы и названия, принадлежащие проекту Majestic RP и его правообладателям, используются исключительно в информационных целях и остаются собственностью их владельцев.",
           "Бесплатное использование не означает передачи прав на исходный код. Копирование и перепродажа Программы без согласия автора запрещены."]],
        ["6. Отсутствие гарантий",
          ["Программа предоставляется «как есть», без каких-либо гарантий бесперебойной работы. Автор вправе изменять, приостанавливать или прекращать развитие Программы, а также выпускать обновления, в том числе принудительные."]],
        ["7. Ограничение ответственности",
          ["В пределах, допустимых законом, автор не отвечает за потерю данных, сбои в работе, а также за любые убытки или игровые последствия, возникшие из-за использования или невозможности использования Программы."]],
        ["8. Изменение Условий и контакты",
          ["Условия могут изменяться. Актуальная редакция всегда доступна в Программе: Настройки → Документы. Продолжая пользоваться Программой после обновления, вы принимаете новую редакцию.",
           "Связь с автором: " + CONTACT + "."]]
      ]
    }
  };

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  /* ---------- стили ---------- */
  var css =
    ".sl-ov{position:fixed;inset:0;z-index:2147483000;display:flex;align-items:center;justify-content:center;padding:16px;background:rgba(5,10,18,.6)}" +
    ".sl-ov[hidden]{display:none}" +
    ".sl-box{display:flex;flex-direction:column;width:min(640px,100%);max-height:min(82vh,720px);background:var(--surface,#fff);color:var(--ink,#172230);border:1px solid var(--line,#D3D9E0);border-radius:10px;box-shadow:0 16px 48px rgba(0,0,0,.4);font:14px/1.55 var(--f-body,system-ui,-apple-system,'Segoe UI',Roboto,sans-serif);outline:none}" +
    ".sl-head{display:flex;align-items:center;gap:8px;padding:12px 14px;border-bottom:1px solid var(--line,#D3D9E0)}" +
    ".sl-tabs{display:flex;gap:6px;flex:1;min-width:0;flex-wrap:wrap}" +
    ".sl-tab,.sl-x,.sl-ok{font:inherit;color:inherit;cursor:pointer;border:1px solid var(--line,#D3D9E0);background:var(--surface,#fff);border-radius:6px;padding:6px 12px}" +
    ".sl-tab{font-weight:600;font-size:13px}" +
    ".sl-tab[aria-selected=true]{background:var(--accent,#1D4E89);color:var(--accent-ink,#fff);border-color:var(--accent,#1D4E89)}" +
    ".sl-x{padding:6px 10px;line-height:1}" +
    ".sl-body{overflow:auto;padding:14px 18px 6px;flex:1;-webkit-overflow-scrolling:touch}" +
    ".sl-body h2{margin:0 0 2px;font-size:18px}" +
    ".sl-body .sl-upd{margin:0 0 12px;color:var(--muted,#5B6877);font-size:12px}" +
    ".sl-body h3{margin:16px 0 4px;font-size:14px}" +
    ".sl-body p{margin:0 0 8px}" +
    ".sl-foot{display:flex;justify-content:flex-end;padding:10px 14px;border-top:1px solid var(--line,#D3D9E0)}" +
    ".sl-ok{background:var(--accent,#1D4E89);color:var(--accent-ink,#fff);border-color:var(--accent,#1D4E89);font-weight:600}" +
    ".sl-tab:focus-visible,.sl-x:focus-visible,.sl-ok:focus-visible,.sl-link:focus-visible{outline:2px solid var(--accent,#1D4E89);outline-offset:2px}" +
    ".sl-consent{color:var(--ink,#172230);display:flex;align-items:flex-start;gap:9px;margin:10px 0;font-size:13px;line-height:1.45;cursor:pointer}" +
    ".sl-consent input{padding:0;margin:2px 0 0;width:17px;height:17px;flex:0 0 auto;accent-color:var(--accent,#1D4E89);cursor:pointer}" +
    ".sl-link{all:unset;color:var(--accent,#1D4E89);text-decoration:underline;cursor:pointer}" +
    ".sl-consent.sl-err{outline:2px solid #B3261E;outline-offset:3px;border-radius:4px}" +
    "@keyframes slShake{0%,100%{transform:none}25%{transform:translateX(-5px)}75%{transform:translateX(5px)}}" +
    ".sl-consent.sl-err{animation:slShake .3s}" +
    "@media (prefers-reduced-motion:reduce){.sl-consent.sl-err{animation:none}}";

  function ensureCss() {
    if (document.getElementById("sl-style")) return;
    var st = document.createElement("style");
    st.id = "sl-style";
    st.textContent = css;
    (document.head || document.documentElement).appendChild(st);
  }

  /* ---------- модальное окно ---------- */
  var ov = null, cur = "privacy", lastFocus = null, tabsEl, bodyEl;

  function renderDoc() {
    var d = DOCS[cur];
    var h = '<h2>' + esc(d.title) + '</h2><p class="sl-upd">Редакция от ' + esc(d.updated) + '</p>';
    d.sections.forEach(function (s) {
      h += "<h3>" + esc(s[0]) + "</h3>";
      s[1].forEach(function (p) { h += "<p>" + esc(p) + "</p>"; });
    });
    bodyEl.innerHTML = h;
    bodyEl.scrollTop = 0;
    Array.prototype.forEach.call(tabsEl.children, function (b) {
      b.setAttribute("aria-selected", b.getAttribute("data-doc") === cur ? "true" : "false");
    });
  }

  function build() {
    ensureCss();
    ov = document.createElement("div");
    ov.className = "sl-ov";
    ov.hidden = true;
    ov.innerHTML =
      '<div class="sl-box" role="dialog" aria-modal="true" aria-label="Юридические документы" tabindex="-1">' +
      '<div class="sl-head"><div class="sl-tabs" role="tablist">' +
      '<button type="button" class="sl-tab" role="tab" data-doc="privacy">Конфиденциальность</button>' +
      '<button type="button" class="sl-tab" role="tab" data-doc="terms">Условия пользования</button>' +
      '</div><button type="button" class="sl-x" aria-label="Закрыть">✕</button></div>' +
      '<div class="sl-body"></div>' +
      '<div class="sl-foot"><button type="button" class="sl-ok">Закрыть</button></div></div>';
    document.body.appendChild(ov);
    tabsEl = ov.querySelector(".sl-tabs");
    bodyEl = ov.querySelector(".sl-body");
    ov.addEventListener("click", function (e) {
      if (e.target === ov) return close();
      var b = e.target.closest ? e.target.closest("button") : null;
      if (!b) return;
      if (b.classList.contains("sl-x") || b.classList.contains("sl-ok")) return close();
      var d = b.getAttribute("data-doc");
      if (d && DOCS[d]) { cur = d; renderDoc(); }
    });
    ov.addEventListener("keydown", function (e) {
      if (e.key === "Escape") { e.stopPropagation(); e.preventDefault(); close(); return; }
      if (e.key === "Tab") { // простая ловушка фокуса внутри окна
        var f = ov.querySelectorAll("button");
        if (!f.length) return;
        var first = f[0], last = f[f.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    }, true);
  }

  function open(kind) {
    if (!DOCS[kind]) kind = "privacy";
    if (!ov) build();
    cur = kind;
    lastFocus = document.activeElement;
    renderDoc();
    ov.hidden = false;
    var box = ov.querySelector(".sl-box");
    if (box) box.focus();
  }

  function close() {
    if (!ov) return;
    ov.hidden = true;
    try { if (lastFocus && lastFocus.focus) lastFocus.focus(); } catch (e) {}
  }

  /* ---------- галочка согласия для регистрации ---------- */
  function consentHtml(id) {
    id = id || "slAgree";
    return '<label class="sl-consent" data-sl-consent>' +
      '<input type="checkbox" id="' + esc(id) + '" data-sl-check>' +
      '<span>Я ознакомился и согласен с ' +
      '<button type="button" class="sl-link" data-legal="privacy">Политикой конфиденциальности</button> и ' +
      '<button type="button" class="sl-link" data-legal="terms">Условиями пользования</button></span></label>';
  }

  // Делегирование: любая кнопка с data-legal открывает окно (работает и после перерисовки интерфейса).
  document.addEventListener("click", function (e) {
    var b = e.target && e.target.closest ? e.target.closest("[data-legal]") : null;
    if (!b) return;
    e.preventDefault();
    e.stopPropagation();
    open(b.getAttribute("data-legal"));
  }, true);

  function bind(root) {
    ensureCss();
    root = root || document;
    var cb = root.querySelector("[data-sl-check]");
    var wrap = root.querySelector("[data-sl-consent]");
    var subs = [];
    if (cb) cb.addEventListener("change", function () {
      if (wrap) wrap.classList.remove("sl-err");
      subs.forEach(function (f) { try { f(cb.checked); } catch (e) {} });
    });
    return {
      checked: function () { return !!(cb && cb.checked); },
      onChange: function (f) { if (typeof f === "function") subs.push(f); },
      shake: function () {
        if (!wrap) return;
        wrap.classList.remove("sl-err");
        void wrap.offsetWidth;
        wrap.classList.add("sl-err");
        if (cb) cb.focus();
      },
      version: VERSION
    };
  }

  window.SenkoLegal = { VERSION: VERSION, open: open, close: close, consentHtml: consentHtml, bind: bind, docs: DOCS };
})();
