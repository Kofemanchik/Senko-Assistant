// ============================================================================
// Senko Assistant · регистрация глобальных слэш-команд Discord
// Использует @discordjs/rest и Application ID.
// ============================================================================

"use strict";

const { REST, Routes } = require("discord.js");
const config = require("../config");

const COMMANDS = [
  {
    name: "settings",
    description: "Настройка каналов и ролей бота (только владелец)",
    default_member_permissions: "8",
    options: [
      {
        name: "channel",
        description: "Указать ID канала",
        type: 1,
        required: true,
        options: [
          {
            name: "type",
            description: "Какой канал",
            type: 3,
            required: true,
            choices: [
              { name: "Информация", value: "info" },
              { name: "Новости", value: "news" },
              { name: "Законы", value: "laws" },
              { name: "Ассистенты", value: "assistants" },
              { name: "Changelog", value: "changelog" },
              { name: "Поддержка", value: "support" },
              { name: "Мониторинг", value: "monitor" },
            ],
          },
          {
            name: "value",
            description: "ID канала (или <#id>)",
            type: 3,
            required: true,
          },
        ],
      },
      {
        name: "role",
        description: "Указать ID роли Support",
        type: 1,
        required: true,
        options: [
          {
            name: "value",
            description: "ID роли (или <@&id>)",
            type: 3,
            required: true,
          },
        ],
      },
    ],
  },
  {
    name: "info",
    description: "О/embed со ссылками в канале «Информация»",
    default_member_permissions: "8",
  },
  {
    name: "news",
    description: "О/embed новость в канале «Новости»",
    default_member_permissions: "8",
    options: [
      { name: "title", description: "Заголовок новости", type: 3, required: true },
      { name: "body", description: "Текст новости", type: 3, required: false },
      { name: "author", description: "Автор", type: 3, required: false },
      { name: "link", description: "Ссылка", type: 3, required: false },
    ],
  },
  {
    name: "changelog",
    description: "О/embed changelog в канале «Changelog»",
    default_member_permissions: "8",
    options: [
      { name: "version", description: "Номер версии, например 2.9.0", type: 3, required: true },
      { name: "changes", description: "Список изменений по строкам", type: 3, required: false },
      { name: "link", description: "Ссылка на подробности", type: 3, required: false },
    ],
  },
  {
    name: "laws",
    description: "О/embed текст законов в канале «Законы»",
    default_member_permissions: "8",
  },
  {
    name: "assistants",
    description: "О/embed текст ассистентов в канале «Ассистенты»",
    default_member_permissions: "8",
  },
  {
    name: "support",
    description: "Создать тикет поддержки",
    default_member_permissions: "0",
    options: [
      { name: "question", description: "Опишите ваш вопрос", type: 3, required: true },
    ],
  },
  {
    name: "status",
    description: "О/embed мониторинга ресурсов",
    default_member_permissions: "8",
  },
  {
    name: "rules",
    description: "Обновить текст правил (только владелец)",
    default_member_permissions: "8",
    options: [
      { name: "text", description: "Текст правил", type: 3, required: true },
    ],
  },
];

async function registerCommands(client) {
  const rest = new REST({ version: "10" }).setToken(config.token);

  try {
    console.log("Регистрация глобальных слэш-команд…");
    const data = await rest.put(Routes.applicationCommands(config.applicationId), { body: COMMANDS });
    console.log(`✅ Зарегистрировано ${data.length} команд.`);
  } catch (e) {
    console.error("Ошибка при регистрации команд:", e);
  }
}

module.exports = { registerCommands };