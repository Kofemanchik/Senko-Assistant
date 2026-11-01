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

// Запись одной настройки бота (discord_*). Сервер принимает её только с секретом SENKO_BOT_KEY (= CRON_SECRET в Supabase).
async function setBotSetting(key, value) {
  if (!config.botKey) return { ok: false, error: "У бота не задан SENKO_BOT_KEY: настройки меняются в панели владельца → Discord-бот." };
  const r = await apiRequest("discord", { op: "settings_set", key, value, bot_key: config.botKey });
  if (r && r.ok) setCache(`bs:${key}`, value);
  return r || { ok: false, error: "Нет ответа сервера." };
}

// Удаление настройки
async function delBotSetting(key) {
  if (!config.botKey) return { ok: false, error: "У бота не задан SENKO_BOT_KEY." };
  cache.delete(`bs:${key}`);
  return apiRequest("discord", { op: "settings_del", key, bot_key: config.botKey });
}

// Публикация события для Discord-каналов (читается панелью/ботом)
// action «discord:news», «discord:changelog», «discord:mode», «discord:rules», …
async function discordEvent(event, payload = {}) {
  return apiRequest("discord", { op: event, ...payload });
}

// Мониторинг: сохранить результат проверки ресурса
async function monitorRecord(resource, ok, latency, detail) {
  if (!config.botKey) return { ok: false };
  return apiRequest("discord", { op: "monitor_record", resource, ok, latency, detail: detail || "", bot_key: config.botKey });
}

// Получить текущие записи мониторинга
async function monitorState() {
  if (!config.botKey) return [];
  const data = await apiRequest("discord", { op: "monitor_state", bot_key: config.botKey });
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
