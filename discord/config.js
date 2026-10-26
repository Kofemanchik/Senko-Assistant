// ============================================================================
// Senko Assistant · конфигурация Discord-бота
// Application ID и Public Key — не секретные, берутся из Discord Developer Portal.
// Токен бота — только в переменной окружения DISCORD_BOT_TOKEN (не коммитить!).
// ============================================================================

"use strict";

require("dotenv").config();

module.exports = {
  // Discord
  applicationId: "1564239530981204018",
  publicKey: "79e4b336ef252e666d0e5a5c3abfc75c4c61f7a76ebb71b4d257bb5183578bec",
  token: process.env.DISCORD_BOT_TOKEN || "",

  // Supabase (Edge Function «senko» — тот же адрес, что и у приложения/панели)
  apiUrl: process.env.SUPABASE_API_URL || "https://wcjspwailippjmyffkei.supabase.co/functions/v1/senko",
  anonKey: process.env.SUPABASE_ANON_KEY || "sb_publishable_hsdKNj25gEIXqIxK7Hhr5A_-VberrUG",

  // Серверы Majestic RP (номер → название) — тот же список, что в scripts/servers.js
  servers: { 12: "Boston", 7: "Los Angeles", 16: "Denver" },
  defaultServer: 12,

  // Каналы Discord (заполняются владельцем через /settings в боте или панели)
  // id канала → 목적. Берутся из bot_settings, здесь значения по умолчанию.
  channels: {
    info: process.env.DISCORD_CHANNEL_INFO || "",        // «Информация» — embed со ссылками
    news: process.env.DISCORD_CHANNEL_NEWS || "",         // «Новости» — публикации из панели
    laws: process.env.DISCORD_CHANNEL_LAWS || "",         // «Законы» — текст законов
    assistants: process.env.DISCORD_CHANNEL_ASSISTANTS || "", // «Ассистенты» — текст ассистентов
    changelog: process.env.DISCORD_CHANNEL_CHANGELOG || "",   // «Changelog» — обновления бота
    support: process.env.DISCORD_CHANNEL_SUPPORT || "",   // «Поддержка» — тикеты создаются здесь
    monitor: process.env.DISCORD_CHANNEL_MONITOR || "",   // «Мониторинг» — статус ресурсов
  },

  // Роли
  roles: {
    support: process.env.DISCORD_ROLE_SUPPORT || "",   // роль «Support» — тегается при тикетах
  },

  // Интервалы (мс)
  monitorInterval: 5 * 60 * 1000,   // проверка ресурсов каждые 5 минут
  settingsCacheTtl: 2 * 60 * 1000,  // кэш настроек из Supabase — 2 минуты
};
