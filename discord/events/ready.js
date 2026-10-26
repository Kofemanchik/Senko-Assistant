// ============================================================================
// Senko Assistant · событие ready — бот готов к работе
// ============================================================================

"use strict";

function onReady(client, state) {
  console.log(`✅ Discord-бот вошёл как ${client.user.tag} (${client.user.id})`);
  console.log(`Серверов: ${client.guilds.cache.size}`);

  // Установим активность
  client.user.setActivity("Senko Assistant", { type: 3 }); // watching
}

module.exports = { onReady };
