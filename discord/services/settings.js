// ============================================================================
// Senko Assistant · настройки Discord-бота из bot_settings (Supabase)
// Читаются при запуске и кэшируются на 2 минуты.
// ============================================================================

"use strict";

const config = require("../config");
const { botSettings } = require("./api");

const SETTING_KEYS = [
  "discord_channel_info",
  "discord_channel_news",
  "discord_channel_laws",
  "discord_channel_assistants",
  "discord_channel_changelog",
  "discord_channel_support",
  "discord_channel_monitor",
  "discord_role_support",
  "discord_info_links",      // JSON: ссылки для канала «Информация»
  "discord_laws_text",       // текст для канала «Законы»
  "discord_assistants_text", // текст для канала «Ассистенты»
  "discord_news_enabled",    // bool: автопубликация новостей из панели
  "discord_changelog_enabled",
  "discord_monitor_enabled",
];

// Загрузка всех настроек бота
async function loadSettings() {
  const data = await botSettings(SETTING_KEYS);

  const settings = {
    channels: {
      info: data.discord_channel_info || config.channels.info || "",
      news: data.discord_channel_news || config.channels.news || "",
      laws: data.discord_channel_laws || config.channels.laws || "",
      assistants: data.discord_channel_assistants || config.channels.assistants || "",
      changelog: data.discord_channel_changelog || config.channels.changelog || "",
      support: data.discord_channel_support || config.channels.support || "",
      monitor: data.discord_channel_monitor || config.channels.monitor || "",
    },
    roles: {
      support: data.discord_role_support || config.roles.support || "",
    },
    infoLinks: parseJson(data.discord_info_links, []),
    lawsText: data.discord_laws_text || "",
    assistantsText: data.discord_assistants_text || "",
    newsEnabled: data.discord_news_enabled !== false,
    changelogEnabled: data.discord_changelog_enabled !== false,
    monitorEnabled: data.discord_monitor_enabled !== false,
  };

  return settings;
}

function parseJson(value, fallback) {
  if (value == null) return fallback;
  if (typeof value === "string") {
    try {
      return JSON.parse(value);
    } catch (e) {
      return fallback;
    }
  }
  return value;
}

// Привести канал к числовому ID (убрать <#id> если передано)
function normalizeChannelId(id) {
  if (!id) return "";
  const m = String(id).match(/<#(\d+)>/);
  return m ? m[1] : String(id);
}

// Привести роль к числовому ID
function normalizeRoleId(id) {
  if (!id) return "";
  const m = String(id).match(/<@&(\d+)>/);
  return m ? m[1] : String(id);
}

module.exports = {
  loadSettings,
  normalizeChannelId,
  normalizeRoleId,
  SETTING_KEYS,
};
