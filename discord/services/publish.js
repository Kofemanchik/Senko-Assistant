// ============================================================================
// Senko Assistant · публикация сообщений в Discord-каналы
// Использует настройки channels из bot_settings (Supabase).
// ============================================================================

"use strict";

const { infoEmbed, lawsEmbed, assistantsEmbed, newsEmbed, changelogEmbed, monitorEmbed, modeEmbed } = require("../embeds");

// Очистить старое сообщение в канале (удалить все, если не задан message_id)
async function clearChannel(channel) {
  try {
    const messages = await channel.messages.fetch({ limit: 100 });
    const deletable = messages.filter((m) => m.author.id === channel.client.user.id);
    if (deletable.size) await channel.bulkDelete(deletable, true);
  } catch (e) {
    console.warn("Очистка канала не удалась:", e.message);
  }
}

// Найти канал по ID из настроек
function getChannel(client, channelId) {
  if (!channelId) return null;
  return client.channels.cache.get(channelId) || null;
}

// ───── Канал «Информация» ─────
async function publishInfo(client, settings) {
  const channel = getChannel(client, settings.channels.info);
  if (!channel) return { ok: false, error: "Канал «Информация» не настроен." };

  const embed = infoEmbed(settings.infoLinks || []);
  await channel.send({ embeds: [embed] });
  return { ok: true };
}

// ───── Канал «Законы» ─────
async function publishLaws(client, settings) {
  const channel = getChannel(client, settings.channels.laws);
  if (!channel) return { ok: false, error: "Канал «Законы» не настроен." };

  const embed = lawsEmbed(settings.lawsText || "");
  await channel.send({ embeds: [embed] });
  return { ok: true };
}

// ───── Канал «Ассистенты» ─────
async function publishAssistants(client, settings) {
  const channel = getChannel(client, settings.channels.assistants);
  if (!channel) return { ok: false, error: "Канал «Ассистенты» не настроен." };

  const embed = assistantsEmbed(settings.assistantsText || "");
  await channel.send({ embeds: [embed] });
  return { ok: true };
}

// ───── Канал «Новости» ─────
async function publishNews(client, settings, news) {
  if (!settings.newsEnabled) return { ok: false, error: "Автопубликация новостей отключена." };
  const channel = getChannel(client, settings.channels.news);
  if (!channel) return { ok: false, error: "Канал «Новости» не настроен." };

  const embed = newsEmbed(news);
  await channel.send({ embeds: [embed] });
  return { ok: true };
}

// ───── Канал «Changelog» ─────
async function publishChangelog(client, settings, changelog) {
  if (!settings.changelogEnabled) return { ok: false, error: "Changelog отключён." };
  const channel = getChannel(client, settings.channels.changelog);
  if (!channel) return { ok: false, error: "Канал «Changelog» не настроен." };

  const embed = changelogEmbed(changelog);
  await channel.send({ embeds: [embed] });
  return { ok: true };
}

// ───── Канал «Мониторинг» ─────
async function publishMonitor(client, settings, resources) {
  if (!settings.monitorEnabled) return { ok: false, error: "Мониторинг отключён." };
  const channel = getChannel(client, settings.channels.monitor);
  if (!channel) return { ok: false, error: "Канал «Мониторинг» не настроен." };

  const embed = monitorEmbed(resources);
  await channel.send({ embeds: [embed] });
  return { ok: true };
}

// ───── Режимы (техработы, регистрация) ─────
async function publishMode(client, settings, mode) {
  const channel = getChannel(client, settings.channels.news);
  if (!channel) return { ok: false, error: "Канал «Новости» не настроен." };

  const embed = modeEmbed(mode);
  await channel.send({ embeds: [embed] });
  return { ok: true };
}

module.exports = {
  publishInfo,
  publishLaws,
  publishAssistants,
  publishNews,
  publishChangelog,
  publishMonitor,
  publishMode,
  getChannel,
};