// ============================================================================
// Senko Assistant · обработка всех взаимодействий (слэш-команды и кнопки)
// ============================================================================

"use strict";

const { Events } = require("discord.js");
const commands = require("../commands");

async function handleInteraction(interaction, state) {
  if (interaction.isChatInputCommand()) {
    await handleSlashCommand(interaction, state);
    return;
  }

  if (interaction.isButton()) {
    await handleButton(interaction, state);
    return;
  }

  if (interaction.isStringSelectMenu()) {
    await handleSelectMenu(interaction, state);
    return;
  }
}

async function handleSlashCommand(interaction, state) {
  const name = interaction.commandName;
  const handler = commands[name];

  if (!handler) {
    await interaction.reply({
      content: "Неизвестная команда.",
      ephemeral: true,
    });
    return;
  }

  try {
    await handler(interaction, state);
  } catch (e) {
    console.error(`Ошибка в команде /${name}:`, e);
    const content = "Произошла ошибка при выполнении команды.";
    if (interaction.replied || interaction.deferred) {
      await interaction.followUp({ content, ephemeral: true }).catch(() => {});
    } else {
      await interaction.reply({ content, ephemeral: true }).catch(() => {});
    }
  }
}

async function handleButton(interaction, state) {
  const { customId } = interaction;

  // Тикеты: «Принять обращение» / «Закрыть обращение»
  if (customId.startsWith("ticket:accept:")) {
    const ticketNumber = customId.split(":")[2];
    const roleId = state.settings.roles.support || "";

    const member = interaction.guild.members.cache.get(interaction.user.id);
    const hasSupport = roleId ? member.roles.cache.has(roleId) : false;
    if (!hasSupport) {
      await interaction.reply({
        content: "Только сотрудники поддержки могут принять обращение.",
        ephemeral: true,
      });
      return;
    }

    await interaction.update({
      content: `✅ Обращение №${ticketNumber} взято в работу ${interaction.user}.`,
      components: [],
    });
    return;
  }

  if (customId.startsWith("ticket:close:")) {
    const ticketNumber = customId.split(":")[2];
    const roleId = state.settings.roles.support || "";

    const member = interaction.guild.members.cache.get(interaction.user.id);
    const hasSupport = roleId ? member.roles.cache.has(roleId) : false;
    if (!hasSupport) {
      await interaction.reply({
        content: "Только сотрудники поддержки могут закрыть обращение.",
        ephemeral: true,
      });
      return;
    }

    await interaction.reply({
      content: `🔒 Обращение №${ticketNumber} закрыто ${interaction.user}.`,
      ephemeral: true,
    });

    // Закрываем канал тикета через некоторое время
    setTimeout(() => {
      interaction.channel.delete().catch(() => {});
    }, 10000);
    return;
  }

  await interaction.reply({ content: "Неизвестное действие.", ephemeral: true }).catch(() => {});
}

async function handleSelectMenu(interaction, state) {
  await interaction.reply({ content: "Меню пока не настроено.", ephemeral: true }).catch(() => {});
}

module.exports = { handleInteraction };
