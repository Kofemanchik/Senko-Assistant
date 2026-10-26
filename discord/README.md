# Senko Assistant · Discord-бот

Отдельный бот для Discord-сервера Senko. Работает параллельно с Telegram-ботом (в `supabase/functions/senko/index.ts`) и использует ту же базу Supabase (`bot_settings`).

## Что реализовано (v1.0.0-beta)

1. **Канал «Информация»** — `/info` publikuje в канал embed со ссылками (приложение 2).
2. **Канал «Новости»** — `/news <title> <body> <author> <link>` — публикация из панели/бота; авто-события (техработы, регистрация) приходят из панели через `discord:news`.
3. **Канал «Changelog»** — `/changelog <version> <changes>` — обновление бота с версией.
4. **Канал «Законы»** — `/laws` / `/rules <text>` — текст законов с ресурсами.
5. **Канал «Ассистенты»** — `/assistants` — текст ассистентов.
6. **Поддержка** — `/support <question>` создаёт канал тикета `discord_name-номер`, тегает роль `Support`, кнопки «Принять обращение» / «Закрыть обращение».
7. **Мониторинг** — `/status` проверяет Supabase, GitHub, сайт и публикует embed в канал «Мониторинг» каждые 5 минут.
8. **Настройки** — `/settings channel <тип> <id>` и `/settings role <id>` — привязка каналов и роли Support (только владелец).

## Установка

```bash
cd discord
cp .env.example .env
# Укажите DISCORD_BOT_TOKEN (или настройте его в Supabase Secrets)
npm install
node deploy-commands.js   # зарегистрировать слэш-команды в Discord
node bot.js               # запустить бота
```

## Переменные окружения

| Переменная | Описание |
|---|---|
| `DISCORD_BOT_TOKEN` | Токен из Discord Developer Portal |
| `SUPABASE_API_URL` | Адрес Edge Function «senko» |
| `SUPABASE_ANON_KEY` | Публичный ключ Supabase |
| `DISCORD_CHANNEL_INFO` | ID канала «Информация» |
| `DISCORD_CHANNEL_NEWS` | ID канала «Новости» |
| `DISCORD_CHANNEL_LAWS` | ID канала «Законы» |
| `DISCORD_CHANNEL_ASSISTANTS` | ID канала «Ассистенты» |
| `DISCORD_CHANNEL_CHANGELOG` | ID канала «Changelog» |
| `DISCORD_CHANNEL_SUPPORT` | ID канала «Поддержка» |
| `DISCORD_CHANNEL_MONITOR` | ID канала «Мониторинг» |
| `DISCORD_ROLE_SUPPORT` | ID роли «Support» |

Также настройки можно задать через слэш-команду `/settings` (только владелец).

## Структура

```
discord/
├── bot.js               # точка входа
├── config.js            # Application ID, Public Key, токен, Supabase
├── package.json
├── .env.example         # шаблон переменных окружения
├── deploy-commands.js   # регистрация слэш-команд
├── README.md
├── embeds.js            # готовые embed'ы (информация, законы, ассистенты, новости, changelog, мониторинг, тикеты)
├── services/
│   ├── api.js           # запросы к Supabase Edge Function
│   ├── settings.js      # настройки из bot_settings
│   ├── publish.js       # публикация в Discord-каналы
│   ├── tickets.js       # тикеты поддержки
│   └── monitor.js       # мониторинг ресурсов
├── events/
│   ├── ready.js
│   ├── interactionCreate.js   # слэш-команды и кнопки
│   └── guildMemberAdd.js
└── commands/
    ├── index.js         # обработчики слэш-команд
    └── register.js      # регистрация команд в Discord
```

## Integration с Supabase

В `supabase/functions/senko/index.ts` добавлен `discordApi` с операциями:
- `settings_get` / `settings_set` / `settings_del` — настройки бота
- `news` / `changelog` — публикация через вебхук Discord
- `monitor_state` — состояние мониторинга
- `ticket_list` / `ticket_close` — тикеты поддержки

Таблицы `discord_tickets` и `discord_monitor` добавлены в `supabase/schema.sql` и применяются через `SCHEMA_30`.

## Что дальше (v1.1+)

- Привязка аккаунта Discord → аккаунт в программе (роли).
- Баг-репорты из Discord.
- Задания тестеров.
- Авто-публикация changelog из GitHub Actions при выпуске новой версии.
