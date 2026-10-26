// ============================================================================
// Senko Assistant · приветствие нового участника сервера
// ============================================================================

"use strict";

const { infoEmbed } = require("../embeds");

async function onGuildMemberAdd(member) {
  // Можно отправить приветствие в канал «Информация» или отдельный канал welcome
  const channelId = member.guild.settings?.channels?.welcome || "";
  if (!channelId) return;

  const channel = member.guild.channels.cache.get(channelId);
  if (!channel) return;

  await channel.send({
    content: `Добро пожаловать, ${member.user}!`,
    embeds: [infoEmbed()],
  }).catch(() => {});
}

module.exports = { onGuildMemberAdd };
