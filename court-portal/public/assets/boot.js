// Выполняется до отрисовки: тема без мигания и переход с поддомена panel.* в панель.
(function () {
  try { var t = localStorage.getItem('cp-theme'); if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t; } catch (e) {}
  try { if (/^panel\./i.test(location.hostname) && !/^\/panel\//.test(location.pathname)) location.replace('/panel/'); } catch (e) {}
})();
