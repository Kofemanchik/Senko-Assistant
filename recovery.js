// ============================================================================
// Senko Assistant · 3.8: надёжность запуска
//  · автооткат (п. 56): если новая версия дважды подряд не запустилась нормально, программа предлагает
//    скачать предыдущую и больше не ставит эту версию автообновлением;
//  · отчёт о сбое (п. 57): при вылете окна или ошибке основного процесса программа запоминает причину
//    и с разрешения пользователя отправляет отчёт с журналом (то же, что «Сообщить об ошибке»).
// Состояние — в %APPDATA%\Senko Assistant\launch-state.json и crash.json.
// ============================================================================
"use strict";

module.exports = function createRecovery({ app, fs, path, shell, box, log, report, loggedIn, version }) {
  const dir = () => app.getPath("userData");
  const stFile = () => path.join(dir(), "launch-state.json");
  const crFile = () => path.join(dir(), "crash.json");
  const read = (f) => { try { return JSON.parse(fs.readFileSync(f, "utf8")) || {}; } catch (e) { return {}; } };
  const write = (f, v) => { try { fs.writeFileSync(f, JSON.stringify(v)); } catch (e) {} };
  const OK_AFTER_MS = 15000; // окно проработало 15 секунд без вылета — запуск удачный
  let st = {}, loaded = false, okTimer = null;

  // Начало запуска: незавершённый прошлый запуск этой же версии считается неудачным
  function begin() {
    st = read(stFile());
    if (st.ver !== version) {
      st.prevGood = st.okVer && st.okVer !== version ? st.okVer : st.prevGood || "";
      st.ver = version; st.fails = 0;
    } else if (st.pending) st.fails = (st.fails || 0) + 1;
    st.pending = true; st.at = Date.now();
    write(stFile(), st);
    return st;
  }
  function markOk() {
    if (!st.pending) return;
    st.pending = false; st.fails = 0; st.okVer = version;
    write(stFile(), st);
  }
  // Окно (вход или основное) загрузилось: через 15 секунд без вылета запуск удачный
  function watch(w, kind) {
    if (!w || !w.webContents) return;
    w.webContents.on("did-finish-load", () => {
      loaded = true;
      clearTimeout(okTimer);
      okTimer = setTimeout(markOk, OK_AFTER_MS);
    });
    w.webContents.on("render-process-gone", (_e, d) => {
      if (!d || d.reason === "clean-exit") return;
      clearTimeout(okTimer);
      crash({ kind: "renderer", where: kind, reason: d.reason, code: d.exitCode });
      log("error", `окно ${kind} аварийно закрылось: ${d.reason} (${d.exitCode})`);
      // окно перезагружаем; отчёт предлагаем сразу
      setTimeout(() => { try { if (!w.isDestroyed()) w.reload(); } catch (e) {} }, 500);
      setTimeout(offerReport, 2500);
    });
  }
  function quitting() { if (loaded) markOk(); }

  // Сбой основного процесса: только запоминаем (поведение Electron по умолчанию не меняем)
  process.on("uncaughtExceptionMonitor", (err) => {
    crash({ kind: "main", reason: String((err && err.message) || err).slice(0, 300), stack: String((err && err.stack) || "").slice(0, 4000) });
  });
  function crash(c) {
    const cur = read(crFile());
    const list = Array.isArray(cur.list) ? cur.list : [];
    list.unshift({ ...c, at: Date.now(), ver: version });
    write(crFile(), { list: list.slice(0, 5), sent: false });
  }

  let asking = false;
  async function offerReport() {
    const cr = read(crFile());
    if (asking || !Array.isArray(cr.list) || !cr.list.length || cr.sent || cr.declined) return;
    if (!loggedIn()) return; // отправить можно только из аккаунта: спросим после входа
    asking = true;
    try {
      const c = cr.list[0];
      const what = c.kind === "renderer" ? "Окно программы аварийно закрылось" : "В программе произошла ошибка";
      const r = await box({
        type: "warning",
        title: "Сбой программы",
        message: `${what} (версия ${c.ver}).`,
        detail: "Отправить разработчику отчёт? В нём причина сбоя, версия, система и журнал обновлений. Ваши заметки, пароли и данные аккаунта в отчёт не попадают.",
        buttons: ["Отправить отчёт", "Не отправлять"],
        defaultId: 0,
        cancelId: 1,
        noLink: true,
      });
      if (r.response !== 0) { write(crFile(), { ...cr, declined: true }); return; }
      const text = `Автоотчёт о сбое: ${what.toLowerCase()} · ${c.reason || "без причины"} · версия ${c.ver}`;
      const logTxt = cr.list.map((x) => `${new Date(x.at).toISOString()} ${x.kind}${x.where ? "/" + x.where : ""} ${x.reason || ""} ${x.code != null ? "code " + x.code : ""}\n${x.stack || ""}`).join("\n");
      const res = await report(text, logTxt);
      if (res && res.ok) write(crFile(), { ...cr, sent: true });
      await box({ type: res && res.ok ? "info" : "warning", title: "Отчёт о сбое", message: res && res.ok ? "Отчёт отправлен. Спасибо!" : "Не удалось отправить отчёт: " + ((res && res.error) || "нет связи"), buttons: ["OK"] });
    } catch (e) {
      log("error", "отчёт о сбое:", e);
    } finally { asking = false; }
  }

  // После двух неудачных запусков новой версии — предложить предыдущую
  async function checkRollback() {
    if (!st.fails || st.fails < 2 || !st.prevGood || st.prevGood === version || st.asked === version) return;
    st.asked = version; write(stFile(), st);
    const r = await box({
      type: "warning",
      title: "Проблема после обновления",
      message: `Версия ${version} дважды подряд не запустилась нормально.`,
      detail: `Можно скачать предыдущую версию (${st.prevGood}), которая работала на этом компьютере. Эту версию программа больше не будет ставить сама — дождётся следующего исправления. Заметки и настройки сохранятся.`,
      buttons: [`Скачать версию ${st.prevGood}`, "Сообщить об ошибке", "Продолжить"],
      defaultId: 0,
      cancelId: 2,
      noLink: true,
    });
    if (r.response === 0) {
      st.blocked = version; write(stFile(), st);
      shell.openExternal(`https://github.com/Kofemanchik/Senko-Assistant/releases/tag/v${st.prevGood}`);
    } else if (r.response === 1) {
      crash({ kind: "start", reason: `версия ${version} дважды не запустилась` });
      offerReport();
    }
  }
  // Версия, которую автообновление ставить не должно
  const blocked = () => read(stFile()).blocked || "";

  return { begin, watch, quitting, offerReport, checkRollback, blocked };
};
