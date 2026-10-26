// ============================================================================
// Senko Assistant · система тикетов поддержки
// ───── Пользователь: кнопка «Задать вопрос» → канал «discord_name-номер тикета»
// ───── Модераторы (роль Support): «Принять обращение» / «Закрыть обращение»
// ───── Бот тегает роль Support при подаче запроса
// ============================================================================

"use strict";

const { ticketWelcomeEmbed } = require("../embeds");

// Счётчик тикетов (в памяти; можно вынести в Supabase)
let ticketCounter = 0;

// Создать тикет-канал
async function createTicket(client, settings, member) {
  const guild = member.guild;
  const supportRoleId = settings.roles.support || "";

  // Номер тикета
  ticketCounter += 1;
  const number = ticketCounter;

  // Название канала: discord_name-номер
  const safeName = (member.user.username || "user").toLowerCase().replace(/[^a-z0-9_-]/g, "").slice(0, 30) || "user";
  const channelName = `${safeName}-${number}`.slice(0, 100);

  // Права: бот видит всё, пользователь пишет, модераторы видят всё
  const overwrites = [
    {
      id: guild.id,
      deny: ["ViewChannel"],
    },
    {
      id: member.id,
      allow: ["ViewChannel", "SendMessages", "ReadMessageHistory"],
    },
  ];

  if (supportRoleId) {
    overwrites.push({
      id: supportRoleId,
      allow: ["ViewChannel", "SendMessages", "ReadMessageHistory"],
    });
  }

  const channel = await guild.channels.create({
    name: channelName,
    type: 0, // GUILD_TEXT
    parent: settings.channels.support || undefined,
    permissionOverwrites: overwrites,
  });

  // Приветственное сообщение
  const welcome = ticketWelcomeEmbed({
    ticketNumber: number,
    user: member.user,
    tagSupport: supportRoleId,
  });

  await channel.send(welcome);

  // Тегаем роль Support (уведомление)
  if (supportRoleId) {
    try {
      await channel.send({
        content: `🔔 Новое обращение от ${member.user}. Роль <@&${supportRoleId}> тегируется для уведомления.`,
      });
    } catch (e) {
      console.warn("Не удалось теговать роль Support:", e.message);
    }
  }

  return { channel, number };
}

// Закрыть тикет (удалить канал)
async function closeTicket(channel) {
  if (channel) await channel.delete().catch((e) => console.warn("Удаление тикета не удалось:", e.message));
}

// Принять обращение — пометить, что модератор взял его
async function acceptTicket(channel, user) {
  await channel.send({
    content: `✅ Обращение взял в работу ${user}. Ожидайте ответа.`,
  });
}

module.exports = {
  createTicket,
  closeTicket,
  acceptTicket,
};