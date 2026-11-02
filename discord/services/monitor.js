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
    body: JSON.stringify({ action: "status" }), // 3.7: действия "health" у сервера нет — проверка всегда показывала сбой
  },
  {
    key: "ai",
    name: "ИИ-помощник",
    url: process.env.SENKO_AI_HEALTH_URL || "https://senko-ai.senko-assistant.workers.dev/health",
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
    } else if (resource.key === "ai") {
      const data = await res.json().catch(() => ({}));
      ok = res.ok && data.ok !== false;
      if (!ok) detail = data.error || `HTTP ${res.status}`;
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
// 3.7: ресурс недоступен дольше 5 минут — отдельное сообщение в «Мониторинг» (с упоминанием владельца, если задан DISCORD_OWNER_ID)
const DOWN_ALERT_MS = 5 * 60 * 1000;
const down = {}; // имя ресурса → { since, alerted }
async function downAlerts(client, settings, results) {
  const channel = settings.channels && settings.channels.monitor ? client.channels.cache.get(settings.channels.monitor) : null;
  const who = process.env.DISCORD_OWNER_ID ? `<@${process.env.DISCORD_OWNER_ID}> ` : "";
  for (const r of results) {
    const d = down[r.resource];
    if (r.ok) {
      if (d && d.alerted && channel) await channel.send(`✅ **${r.resource}** снова работает. Был недоступен ${Math.max(1, Math.round((Date.now() - d.since) / 60000))} мин.`).catch(() => null);
      delete down[r.resource];
      continue;
    }
    if (!d) { down[r.resource] = { since: r.at || Date.now(), alerted: false }; continue; }
    if (!d.alerted && Date.now() - d.since >= DOWN_ALERT_MS) {
      d.alerted = true;
      if (channel) await channel.send({ content: `${who}🚨 **${r.resource}** не отвечает уже ${Math.round((Date.now() - d.since) / 60000)} мин.${r.detail ? " Причина: " + String(r.detail).slice(0, 200) : ""}`, allowedMentions: { users: process.env.DISCORD_OWNER_ID ? [process.env.DISCORD_OWNER_ID] : [] } }).catch(() => null);
    }
  }
}

async function runMonitor(client, state) {
  if (!state.settings.monitorEnabled) return;

  try {
    const results = await checkAll();
    lastState = results;

    // Публикуем в канал «Мониторинг»
    await publishMonitor(client, state.settings, results);
    await downAlerts(client, state.settings, results);
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