// ============================================================================
// Senko Assistant · автопубликация changelog
// После сборки релиза сервер кладёт его текст в очередь (bot_settings.discord_changelog_pending).
// Бот раз в минуту проверяет очередь, публикует embed в канал «Changelog» и подтверждает публикацию.
// ============================================================================

"use strict";

const { changelogPending, changelogAck } = require("./api");
const { loadSettings } = require("./settings");
const { publishChangelog } = require("./publish");

const EVERY_MS = 60 * 1000;
let busy = false;

async function checkOnce(client, state) {
  if (busy || !client.isReady()) return;
  busy = true;
  try {
    const item = await changelogPending();
    if (!item) return;
    const settings = await loadSettings();
    state.settings = settings;
    const r = await publishChangelog(client, settings, { version: item.version, changes: item.changes, link: item.link, at: item.at });
    if (r.ok) {
      await changelogAck(item.id);
      console.log(`Changelog ${item.version} опубликован в Discord.`);
    } else {
      console.warn(`Changelog ${item.version} не опубликован: ${r.error}`);
    }
  } catch (e) {
    console.warn("Проверка очереди changelog не удалась:", e.message);
  } finally {
    busy = false;
  }
}

function startChangelog(client, state) {
  setTimeout(() => checkOnce(client, state), 15000);
  setInterval(() => checkOnce(client, state), EVERY_MS);
}

module.exports = { startChangelog };
