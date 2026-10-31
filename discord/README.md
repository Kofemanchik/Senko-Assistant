# Senko Assistant · Discord-бот

Отдельный бот для Discord-сервера Senko. Работает параллельно с Telegram-ботом (в `supabase/functions/senko/index.ts`) и использует ту же базу Supabase (`bot_settings`).

## Что реализовано (v1.0.0-beta)

1. **Канал «Информация»** — `/info` publikuje в канал embed со ссылками (приложение 2).
2. **Канал «Новости»** — `/news <title> <body> <author> <link>` — публикация из панели/бота; авто-события (техработы, регистрация) приходят из панели через `discord:news`.
3. **Канал «Changelog»** — `/changelog <version> <changes>` вручную; после сборки релиза changelog приходит сам: сервер ставит его в очередь, бот раз в минуту публикует (бета-версии не публикуются).
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

## Работа 24/7

Бот должен быть запущен постоянно: без него не публикуется changelog релизов, не работают тикеты, мониторинг и слэш-команды.
Перед первым запуском в Discord Developer Portal → Bot включите **Server Members Intent** и **Message Content Intent**
(без них Discord не пустит бота), скопируйте токен (Reset Token) в `DISCORD_BOT_TOKEN`.

**Хостинг с Docker** (Railway, Render, Koyeb, Fly.io и подобные): новый сервис из репозитория, корневая папка `discord`,
сборка по `Dockerfile`, переменные окружения из `.env.example` (как минимум `DISCORD_BOT_TOKEN`). Если хостинг требует
веб-порт, задайте `PORT` — бот отвечает на `/health` (200, когда подключён к Discord, иначе 503).

**VPS (Linux):**
```bash
git clone https://github.com/Kofemanchik/Senko-Assistant && cd Senko-Assistant/discord
cp .env.example .env   # вписать DISCORD_BOT_TOKEN
docker build -t senko-bot . && docker run -d --name senko-bot --restart unless-stopped --env-file .env senko-bot
```
или без Docker: `npm ci --omit=dev && npm i -g pm2 && pm2 start ecosystem.config.js && pm2 save && pm2 startup`.

**Свой ПК с Windows** (работает, пока ПК включён): `copy .env.example .env`, вписать токен, затем один раз
`powershell -ExecutionPolicy Bypass -File install-autostart.ps1`. Бот стартует при входе в Windows, после сбоя
поднимается сам, лог — `bot.log`.

Обновление бота: `git pull`, затем перезапуск (`docker build … && docker restart`, `pm2 restart senko-bot` или перезагрузка ПК).

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
