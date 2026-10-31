// ============================================================================
// Senko Assistant · работа с Supabase Edge Function «senko» из Discord-бота
// Используется тот же адрес, что и у приложения/панели: SUPABASE_API_URL.
// ============================================================================

"use strict";

const fetch = require("node-fetch");
const config = require("../config");

const DEFAULT_TTL = 2 * 60 * 1000;

const cache = new Map(); // key → { value, expiresAt }

function ttl(key) {
  const c = cache.get(key);
  return c && c.expiresAt > Date.now() ? c.value : null;
}

function setCache(key, value, ttlMs = DEFAULT_TTL) {
  cache.set(key, { value, expiresAt: Date.now() + ttlMs });
}

// Отправка запроса в Edge Function. action — «bot_settings», «discord:…», и т.п.
async function apiRequest(action, payload = {}, opts = {}) {
  const body = JSON.stringify({ action, ...payload });
  const res = await fetch(config.apiUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json; charset=utf-8",
      apikey: config.anonKey,
      Authorization: `Bearer ${config.anonKey}`,
    },
    body,
    signal: AbortSignal.timeout(opts.timeout || 15000),
  });

  if (!res.ok) {
    throw new Error(`Supabase вернул ${res.status} ${res.statusText}`);
  }

  const data = await res.json().catch(() => ({}));
  return data;
}

// Чтение настроек бота из таблицы bot_settings (кэшируется).
// Сервер отдаёт их через action «discord», op «settings_get» (действия «bot_settings» на сервере нет).
async function botSettings(keys, ttlMs = config.settingsCacheTtl) {
  const out = {};
  const need = [];
  for (const key of keys) {
    const cached = ttl(`bs:${key}`);
    if (cached !== null) out[key] = cached;
    else need.push(key);
  }
  if (need.length) {
    const data = await apiRequest("discord", { op: "settings_get", keys: need });
    const got = (data && data.ok && data.settings) || {};
    for (const key of need) {
      const value = got[key] === undefined ? null : got[key];
      if (value !== null) setCache(`bs:${key}`, value, ttlMs);
      out[key] = value;
    }
  }
  return out;
}

// Очередь changelog: сервер кладёт туда текст релиза после сборки, бот публикует и подтверждает
async function changelogPending() {
  const data = await apiRequest("discord", { op: "changelog_pending" });
  return data && data.ok ? data.item || null : null;
}
async function changelogAck(id) {
  return apiRequest("discord", { op: "changelog_ack", id });
}

// Запись одной настройки (вызывается из панели/бота)
async function setBotSetting(key, value) {
  return apiRequest("bot_settings", { op: "set", key, value });
}

// Удаление настройки
async function delBotSetting(key) {
  return apiRequest("bot_settings", { op: "del", key });
}

// Публикация события для Discord-каналов (читается панелью/ботом)
// action «discord:news», «discord:changelog», «discord:mode», «discord:rules», …
async function discordEvent(event, payload = {}) {
  return apiRequest("discord", { op: event, ...payload });
}

// Мониторинг: сохранить результат проверки ресурса
async function monitorRecord(resource, ok, latency, detail) {
  return apiRequest("discord:monitor", {
    op: "record",
    resource,
    ok,
    latency,
    detail: detail || null,
  });
}

// Получить текущие записи мониторинга
async function monitorState() {
  const data = await apiRequest("discord:monitor", { op: "state" });
  return data && data.ok ? data.state || [] : [];
}

module.exports = {
  apiRequest,
  botSettings,
  setBotSetting,
  delBotSetting,
  discordEvent,
  changelogPending,
  changelogAck,
  monitorRecord,
  monitorState,
  cache,
};
