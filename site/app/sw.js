/* Senko Assistant · веб-версия: работа без интернета.
   Страницы и файлы сайта берутся из сети, а при её отсутствии — из сохранённой копии.
   Запросы к серверу (вход, синхронизация, законы) сюда не попадают: они идут на другой адрес. */
const CACHE = "senko-app-1";
const SHELL = ["/app/", "/app/login/", "/app/config.js", "/app/web-core.js", "/app/web.js", "/app/web-auth.js", "/assets/fonts.css", "/img/logo-mark.svg", "/favicon.svg"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL).catch(() => {})).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;
  if (!/^\/(app|assets|fonts|img)\//.test(url.pathname) && url.pathname !== "/favicon.svg") return;
  // в копии храним без «?v=…», чтобы новая сборка заменяла старую
  const key = url.pathname === "/app/index.html" ? "/app/" : url.pathname;
  e.respondWith(
    fetch(req).then((res) => {
      if (res && res.ok && res.type === "basic") { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(key, copy)); }
      return res;
    }).catch(() => caches.match(key).then((r) => r || (req.mode === "navigate" ? caches.match("/app/") : Response.error())))
  );
});
self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((ws) => {
    const w = ws.find((x) => new URL(x.url).pathname.startsWith("/app/"));
    return w ? w.focus() : self.clients.openWindow("/app/");
  }));
});
