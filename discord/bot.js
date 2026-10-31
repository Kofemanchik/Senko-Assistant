// ============================================================================
// Senko Assistant · Discord-бот (вторая версия)
// Точка входа: создаёт клиент, регистрирует события и слэш-команды.
// ============================================================================

"use strict";

const { Client, GatewayIntentBits, Partials, Events } = require("discord.js");
const config = require("./config");
const { registerCommands } = require("./commands/register");
const { handleInteraction } = require("./events/interactionCreate");
const { onReady } = require("./events/ready");
const { loadSettings } = require("./services/settings");
const { startMonitor } = require("./services/monitor");
const { startChangelog } = require("./services/changelog");

// Состояние бота
const state = {
  client: null,
  settings: {},      // кэш bot_settings из Supabase
  settingsLoaded: false,
};

async function main() {
  if (!config.token) {
    console.error("ОШИБКА: не задан DISCORD_BOT_TOKEN (переменная окружения).");
    process.exit(1);
  }

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMembers,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.GuildMessageReactions,
    ],
    partials: [Partials.Message, Partials.Channel, Partials.Reaction],
  });

  state.client = client;

  // Загрузка настроек из Supabase перед запуском
  try {
    state.settings = await loadSettings();
    state.settingsLoaded = true;
    console.log("Настройки загружены:", Object.keys(state.settings).join(", "));
  } catch (e) {
    console.warn("Не удалось загрузить настройки из Supabase:", e.message);
    console.warn("Бот запустится с настройками по умолчанию.");
  }

  // События
  client.on(Events.ClientReady, () => onReady(client, state));
  client.on(Events.InteractionCreate, (interaction) =>
    handleInteraction(interaction, state)
  );
  client.on(Events.GuildMemberAdd, require("./events/guildMemberAdd").onGuildMemberAdd);

  // Регистрация слэш-команд
  await registerCommands(client);

  // Вход
  await client.login(config.token);
  console.log("Discord-бот запускается…");

  // Мониторинг ресурсов (запускаем после входа)
  startMonitor(client, state);
  // Changelog релизов: сервер ставит в очередь, бот публикует
  startChangelog(client, state);
}

// Проверка живости для хостингов (Render, Koyeb, Railway и т.п.): если задан PORT, отвечаем на HTTP.
// GET / или /health → 200, когда бот подключён к Discord, иначе 503 (хостинг перезапустит контейнер).
if (process.env.PORT) {
  require("http")
    .createServer((req, res) => {
      const ready = !!(state.client && state.client.isReady());
      res.writeHead(ready ? 200 : 503, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: ready, bot: ready ? state.client.user.tag : null, uptime: Math.round(process.uptime()) }));
    })
    .listen(+process.env.PORT, () => console.log(`Проверка живости: порт ${process.env.PORT}`));
}

main().catch((e) => {
  console.error("Фатальная ошибка при запуске:", e);
  process.exit(1);
});

process.on("unhandledRejection", (e) => {
  console.error("Необработанное отклонение:", e);
});
// Неизвестная ошибка — выходим, менеджер процессов (Docker, pm2, автозапуск Windows) поднимет бота заново
process.on("uncaughtException", (e) => {
  console.error("Необработанная ошибка, перезапуск:", e);
  process.exit(1);
});

module.exports = { state };
