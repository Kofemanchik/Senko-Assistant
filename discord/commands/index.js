// ============================================================================
// Senko Assistant · слэш-команды Discord-бота
// ============================================================================

"use strict";

const { loadSettings } = require("../services/settings");
const { publishInfo, publishLaws, publishAssistants, publishNews, publishChangelog, publishMonitor } = require("../services/publish");
const { createTicket } = require("../services/tickets");
const { monitorRecord } = require("./../services/api");

// ───── /settings — настройка каналов и ролей (только владелец) ─────
async function settings(interaction, state) {
  const member = interaction.member;
  const isOwner = member.permissions.has("Administrator") || member.roles.cache.some((r) => r.name.toLowerCase() === "owner");
  if (!isOwner) {
    await interaction.reply({ content: "Только владелец может настраивать бота.", ephemeral: true });
    return;
  }

  const sub = interaction.options.getSubcommand();
  const value = interaction.options.getString("value", true);

  const { setBotSetting } = require("../services/api");
  const { normalizeChannelId, normalizeRoleId } = require("../services/settings");

  let key = "";
  if (sub === "channel") {
    const type = interaction.options.getString("type", true);
    key = `discord_channel_${type}`;
    value = normalizeChannelId(value);
  } else if (sub === "role") {
    key = "discord_role_support";
    value = normalizeRoleId(value);
  }

  await setBotSetting(key, value);
  await interaction.reply({ content: `✅ Настройка \`${key}\` сохранена: \`${value}\``, ephemeral: true });
}

// ───── /info — опубликовать embed в канал «Информация» ─────
async function info(interaction, state) {
  await interaction.deferReply({ ephemeral: true });
  const settings = await loadSettings();
  const result = await publishInfo(interaction.client, settings);
  await interaction.editReply({
    content: result.ok ? "✅ Embed опубликован в канал «Информация»." : `❌ ${result.error}`,
  });
}

// ───── /news — опубликовать новость ─────
async function news(interaction, state) {
  const member = interaction.member;
  const canPublish = member.permissions.has("ManageMessages") || member.roles.cache.some((r) => r.name.toLowerCase() === "leader" || r.name.toLowerCase() === "owner");
  if (!canPublish) {
    await interaction.reply({ content: "Нет прав для публикации новостей.", ephemeral: true });
    return;
  }

  const title = interaction.options.getString("title", true);
  const body = interaction.options.getString("body", false) || "";
  const author = interaction.options.getString("author", false) || interaction.user.tag;
  const link = interaction.options.getString("link", false) || null;

  await interaction.deferReply({ ephemeral: true });
  const settings = await loadSettings();
  const result = await publishNews(interaction.client, settings, { title, body, author, link });
  await interaction.editReply({
    content: result.ok ? "✅ Новость опубликована." : `❌ ${result.error}`,
  });
}

// ───── /changelog — опубликовать changelog ─────
async function changelog(interaction, state) {
  const version = interaction.options.getString("version", true);
  const changes = interaction.options.getString("changes", false) || "";
  const link = interaction.options.getString("link", false) || null;

  await interaction.deferReply({ ephemeral: true });
  const settings = await loadSettings();
  const result = await publishChangelog(interaction.client, settings, {
    version,
    changes: changes.split("\n").map((c) => c.trim()).filter(Boolean),
    link,
  });
  await interaction.editReply({
    content: result.ok ? "✅ Changelog опубликован." : `❌ ${result.error}`,
  });
}

// ───── /laws — опубликовать текст законов ─────
async function laws(interaction, state) {
  const text = interaction.options.getString("text", false) || "";
  await interaction.deferReply({ ephemeral: true });
  const settings = await loadSettings();
  const result = await publishLaws(interaction.client, settings);
  await interaction.editReply({
    content: result.ok ? "✅ Текст законов опубликован." : `❌ ${result.error}`,
  });
}

// ───── /assistants — опубликовать текст ассистентов ─────
async function assistants(interaction, state) {
  await interaction.deferReply({ ephemeral: true });
  const settings = await loadSettings();
  const result = await publishAssistants(interaction.client, settings);
  await interaction.editReply({
    content: result.ok ? "✅ Текст ассистентов опубликован." : `❌ ${result.error}`,
  });
}

// ───── /support — создать тикет поддержки ─────
async function support(interaction, state) {
  const question = interaction.options.getString("question", true);

  await interaction.deferReply({ ephemeral: true });
  const settings = await loadSettings();
  const result = await createTicket(interaction.client, settings, interaction.member);

  // Добавим вопрос в тикет-канал
  await result.channel.send({
    content: `📝 **Вопрос:** ${question}`,
  });

  await interaction.editReply({
    content: `✅ Тикет №${result.number} создан: ${result.channel}.`,
  });
}

// ───── /status — мониторинг ─────
async function status(interaction, state) {
  await interaction.deferReply({ ephemeral: true });
  const { getLastState } = require("../services/monitor");
  const settings = await loadSettings();
  const result = await publishMonitor(interaction.client, settings, getLastState() || []);
  await interaction.editReply({
    content: result.ok ? "✅ Статус опубликован." : `❌ ${result.error}`,
  });
}

// ───── /rules — обновить правила (из панели) ─────
async function rules(interaction, state) {
  const text = interaction.options.getString("text", true);
  await interaction.deferReply({ ephemeral: true });

  const { setBotSetting } = require("../services/api");
  await setBotSetting("discord_laws_text", text);

  const settings = await loadSettings();
  const result = await publishLaws(interaction.client, settings);
  await interaction.editReply({
    content: result.ok ? "✅ Правила обновлены." : `❌ ${result.error}`,
  });
}

module.exports = {
  settings,
  info,
  news,
  changelog,
  laws,
  assistants,
  support,
  status,
  rules,
};