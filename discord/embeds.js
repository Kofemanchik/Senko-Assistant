// ============================================================================
// Senko Assistant · готовые embed'ы для Discord-каналов
// Тексты и ссылки берутся из настроек бота (bot_settings в Supabase).
// ============================================================================

"use strict";

const { EmbedBuilder } = require("discord.js");
const config = require("./config");

// Канал «Информация» — embed со ссылками (приложение 2)
function infoEmbed(links = []) {
  const embed = new EmbedBuilder()
    .setColor(0x2ecc71)
    .setTitle("📋 Информация о проекте Senko Assistant")
    .setDescription(
      "Все важные ссылки и ресурсы проекта в одном месте. " +
      "Выберите нужное ниже, чтобы быстро перейти."
    )
    .setTimestamp()
    .setFooter({ text: "Senko Assistant · Официальный Discord-бот" });

  if (links && links.length) {
    const lines = links
      .map((l) => {
        const label = l.label || l.name || "Ссылка";
        const url = l.url || l.link || "";
        return url ? `• [${label}](${url})` : `• ${label}`;
      })
      .join("\n");
    embed.addFields({ name: "🔗 Полезные ссылки", value: lines || "Ссылки не добавлены." });
  } else {
    embed.addFields({
      name: "🔗 Полезные ссылки",
      value: "Ссылки ещё не настроены. Владелец может добавить их в панели на сайте.",
    });
  }

  return embed;
}

// Канал «Законы» — текст с ресурсами (приложение 2)
function lawsEmbed(text = "") {
  const embed = new EmbedBuilder()
    .setColor(0xf39c12)
    .setTitle("⚖️ Законы штата")
    .setDescription(
      text ||
      "Текст законов пока не добавлен. Владелец может настроить его в панели на сайте."
    )
    .setTimestamp()
    .setFooter({ text: "Senko Assistant · Актуальная редакция законов" });

  return embed;
}

// Канал «Ассистенты» — текст с ресурсами (приложение 3)
function assistantsEmbed(text = "") {
  const embed = new EmbedBuilder()
    .setColor(0x9b59b6)
    .setTitle("🤖 Ассистенты Senko")
    .setDescription(
      text ||
      "Информация об ассистентах пока не добавлена. Владелец может настроить её в панели на сайте."
    )
    .setTimestamp()
    .setFooter({ text: "Senko Assistant · Ассистенты проекта" });

  return embed;
}

// Канал «Новости» — публикация новости из панели
function newsEmbed({ title, body, author, at, link, image } = {}) {
  const embed = new EmbedBuilder()
    .setColor(0x3498db)
    .setTitle(title || "Новость")
    .setDescription(body || "")
    .setTimestamp(at ? new Date(at) : undefined)
    .setFooter({ text: "Senko Assistant · Новости проекта" });

  if (author) embed.addFields({ name: "Автор", value: author, inline: true });
  if (link) embed.addFields({ name: "Ссылка", value: link, inline: true });
  if (image) embed.setImage(image);

  return embed;
}

// Канал «Changelog» — обновление бота
function changelogEmbed({ version, changes, at, link } = {}) {
  const lines = (Array.isArray(changes) ? changes : [])
    .map((c) => `• ${c}`)
    .join("\n") || "Изменений нет.";

  const embed = new EmbedBuilder()
    .setColor(0x2ecc71)
    .setTitle(`📦 Обновление Senko Assistant ${version || ""}`.trim())
    .setDescription(lines)
    .setTimestamp(at ? new Date(at) : undefined)
    .setFooter({ text: "Senko Assistant · Changelog" });

  if (link) embed.addFields({ name: "Подробнее", value: link, inline: true });

  return embed;
}

// Канал «Мониторинг» — статус ресурсов
function monitorEmbed(resources = []) {
  const embed = new EmbedBuilder()
    .setColor(0x2ecc71)
    .setTitle("🖥️ Мониторинг ресурсов Senko")
    .setDescription("Состояние сервисов проекта в реальном времени.")
    .setTimestamp()
    .setFooter({ text: "Senko Assistant · Мониторинг" });

  if (!resources.length) {
    embed.addFields({
      name: "Нет данных",
      value: "Мониторинг ещё не проводил проверок. Подождите первую проверку.",
    });
    return embed;
  }

  const lines = resources.map((r) => {
    const ok = r.ok === true ? "✅" : r.ok === false ? "❌" : "⚠️";
    const name = r.resource || "Ресурс";
    const latency = r.latency != null ? ` · ${r.latency} мс` : "";
    const detail = r.detail ? ` — ${String(r.detail).slice(0, 80)}` : "";
    return `${ok} ${name}${latency}${detail}`;
  });

  embed.addFields({ name: "Статус", value: lines.join("\n") });

  const allOk = resources.every((r) => r.ok === true);
  const anyBad = resources.some((r) => r.ok === false);
  if (anyBad) {
    embed.setColor(0xe74c3c);
    embed.setFooter({ text: "Senko Assistant · Мониторинг — есть проблемы" });
  } else if (!allOk) {
    embed.setColor(0xf39c12);
  }

  return embed;
}

// Тикет поддержки — приветственное сообщение в канале тикета
function ticketWelcomeEmbed({ ticketNumber, user, tagSupport }) {
  const embed = new EmbedBuilder()
    .setColor(0x3498db)
    .setTitle(`🎫 Тикет поддержки №${ticketNumber}`)
    .setDescription(
      `Приветствуем, ${user}! Опишите ваш вопрос максимально подробно, ` +
      "и наша команда поддержки отведит как можно скорее."
    )
    .addFields({ name: "Статус", value: "Открыт", inline: true })
    .setTimestamp()
    .setFooter({ text: "Senko Assistant · Поддержка" });

  const content = tagSupport ? `<@&${tagSupport}>` : "";
  return { content, embeds: [embed] };
}

// Уведомление о режиме техработ / регистрации
function modeEmbed({ type, on, text, at }) {
  const titles = {
    maintenance: on ? "🔧 Технические работы" : "✅ Технические работы завершены",
    regs: on ? "📝 Регистрация закрыта" : "📝 Регистрация открыта",
  };
  const colors = { maintenance: on ? 0xe74c3c : 0x2ecc71, regs: on ? 0xe74c3c : 0x2ecc71 };

  const embed = new EmbedBuilder()
    .setColor(colors[type] || 0x3498db)
    .setTitle(titles[type] || "Режим работы")
    .setDescription(text || "")
    .setTimestamp(at ? new Date(at) : undefined)
    .setFooter({ text: "Senko Assistant · Режимы работы" });

  return embed;
}

module.exports = {
  infoEmbed,
  lawsEmbed,
  assistantsEmbed,
  newsEmbed,
  changelogEmbed,
  monitorEmbed,
  ticketWelcomeEmbed,
  modeEmbed,
};
