/* Тема панели: та же настройка, что на сайте (светлая, тёмная или как в системе) */
try { var t = localStorage.getItem("site-theme"); if (t === "light" || t === "dark") document.documentElement.dataset.theme = t; } catch (e) {}
