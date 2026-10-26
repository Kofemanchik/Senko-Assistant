// ============================================================================
// Senko Assistant · мониторинг ресурсов Senko
// Проверяет: Supabase API, GitHub (законы), сайт, ИИ-помощник.
// Результаты публикуются в канале «Мониторинг».
// ============================================================================

"use strict";

const fetch = require("node-fetch");
const config = require("../config");
const { publishMonitor } = require("./publish");
const { monitorRecord, monitorState } = require("./api");

// Список ресурсов для проверки
const RESOURCES = [
  {
    key: "supabase",
    name: "Supabase API",
    url: config.apiUrl,
    method: "POST",
    body: JSON.stringify({ action: "health" }),
  },
  {
    key: "github_laws",
    name: "GitHub законы",
    url: "https://api.github.com/repos/Kofemanchik/Senko-Assistant/contents/update/laws-status.json",
  },
  {
    key: "site",
    name: "Сайт Senko",
    url: "https://senko-assistant.site",
  },
];

// Проверить один ресурс
async function checkResource(resource) {
  const start = Date.now();
  try {
    const res = await fetch(resource.url, {
      method: resource.method || "GET",
      headers: {
        "content-type": "application/json",
        ...(resource.method === "POST" ? { Authorization: `Bearer ${config.anonKey}`, apikey: config.anonKey } : {}),
      },
      body: resource.body || undefined,
      signal: AbortSignal.timeout(10000),
    });

    const latency = Date.now() - start;
    let ok = res.ok;
    let detail = null;

    if (resource.method === "POST") {
      const data = await res.json().catch(() => ({}));
      ok = !!(data && data.ok !== false);
      if (!ok) detail = data.error || `HTTP ${res.status}`;
    } else if (resource.key === "github_laws") {
      const data = await res.json().catch(() => ({}));
      ok = !!(data && data.name);
      if (!ok) detail = "Файл laws-status.json не найден";
    } else if (resource.key === "site") {
      ok = res.status < 500;
      if (!ok) detail = `HTTP ${res.status}`;
    }

    return {
      resource: resource.name,
      ok,
      latency,
      detail,
      at: Date.now(),
    };
  } catch (e) {
    return {
      resource: resource.name,
      ok: false,
      latency: Date.now() - start,
      detail: e.message || "Сеть",
      at: Date.now(),
    };
  }
}

// Проверить все ресурсы
async function checkAll() {
  const results = await Promise.all(RESOURCES.map(checkResource));

  // Сохранить в Supabase
  for (const r of results) {
    try {
      await monitorRecord(r.resource, r.ok, r.latency, r.detail);
    } catch (e) {
      console.warn("Мониторинг: не удалось сохранить:", e.message);
    }
  }

  return results;
}

// Основной цикл мониторинга
let monitorTimer = null;
let lastState = [];

async function runMonitor(client, state) {
  if (!state.settings.monitorEnabled) return;

  try {
    const results = await checkAll();
    lastState = results;

    // Публикуем в канал «Мониторинг»
    await publishMonitor(client, state.settings, results);
  } catch (e) {
    console.error("Мониторинг: ошибка:", e.message);
  }
}

// Запуск цикла
function startMonitor(client, state) {
  if (!state.settings.monitorEnabled) {
    console.log("Мониторинг отключён в настройках.");
    return;
  }

  // Первый запуск через 5 секунд после старта
  setTimeout(() => runMonitor(client, state), 5000);
  monitorTimer = setInterval(() => runMonitor(client, state), config.monitorInterval);
}

// Ручной запуск мониторинга (по команде)
async function runManual(client, state) {
  return runMonitor(client, state);
}

// Получить последнее состояние
function getLastState() {
  return lastState;
}

module.exports = {
  startMonitor,
  runManual,
  getLastState,
  checkAll,
};