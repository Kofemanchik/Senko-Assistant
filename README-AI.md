# ИИ-помощник для Senko Assistant — установка

## Что в архиве

| Файл | Куда положить в репозиторий |
|---|---|
| `ai.js` | корень (рядом с `main.js`) — **новый** |
| `main.js`, `preload.js`, `voice.js`, `voice-preload.js`, `package.json` | корень, заменить |
| `index.html` | `app/index.html`, заменить (и, если используете, `update/index.html`) |
| `auth.html` | `app/auth.html`, заменить (обновлена политика) |
| `app/voice/overlay.js`, `app/voice/overlay.html` | `app/voice/`, заменить |
| `worker/` | новая папка `worker/` в корне (в сборку .exe не попадает) |

## Шаг 1. Бесплатные ключи ИИ (достаточно одного, лучше два)

* **Gemini**: https://aistudio.google.com/apikey → Create API key.
* **Groq**: https://console.groq.com/keys → Create API Key.
* (по желанию) **OpenRouter**: https://openrouter.ai/keys — бесплатные модели.

Если один провайдер упрётся в дневной лимит или вернёт ошибку, прокси сам переключится на следующий.

## Шаг 2. Деплой прокси на Cloudflare (бесплатно, карта не нужна)

Нужен Node.js. В папке `worker/`:

```bash
npx wrangler login
npx wrangler kv namespace create LIMITS     # скопируйте выданный id в wrangler.toml (вместо ВСТАВЬТЕ_ID_ИЗ_КОМАНДЫ)
npx wrangler secret put APP_KEY             # ТО ЖЕ значение, что у секрета LAWS_KEY на GitHub
npx wrangler secret put GEMINI_API_KEY      # ключ из шага 1
npx wrangler secret put GROQ_API_KEY        # ключ из шага 1 (если есть)
npx wrangler deploy
```

Wrangler выведет адрес вида `https://senko-ai.<ваш-аккаунт>.workers.dev`. Проверка: откройте `<адрес>/health` — должен показать `{"ok":true,"providers":["gemini","groq"]}`.

## Шаг 3. Адрес в приложении

Адрес уже вписан в `ai.js` (https://senko-ai.senko-assistant.workers.dev).

## Шаг 4. Сборка

Как обычно: поднять версию в `package.json` (сейчас 1.5.0), поставить тег `vX.Y.Z` — сборка попадёт в GitHub Releases, игроки получат автообновление.

## Настройки

* `DAILY_PER_USER` в `worker/wrangler.toml` — вопросов на игрока в сутки (по умолчанию 15).
* Названия моделей: переменные `GEMINI_MODEL`, `GROQ_MODEL`, `OPENROUTER_MODEL` (в `wrangler.toml`, раздел `[vars]`). Если провайдер переименует или отключит модель, поменяйте здесь и сделайте `npx wrangler deploy`, обновлять приложение не нужно.

## Голосовой оверлей

На панели оверлея есть переключатель режима: **«Поиск»** (как раньше) и **«ИИ»**. В режиме «ИИ» произнесённый вопрос уходит ИИ-помощнику, ответ показывается в оверлее со списком найденных статей. Режим запоминается. Оверлей прячется сам через 10 секунд после ответа (константа `HIDE_AFTER_MS` в `app/voice/overlay.js`).

## Важно знать

* Бесплатные лимиты провайдеров общие на всех игроков и могут меняться; актуальные цифры смотрите в Google AI Studio и в консоли Groq.
* Бесплатные тарифы провайдеров могут использовать запросы для улучшения своих сервисов — это указано в обновлённой Политике конфиденциальности (раздел 4; версия документов теперь `2026-10-19`).
* Ключ `AI_KEY` вшивается в сборку (секрет GitHub) и совпадает с `APP_KEY` на прокси. Это защита от случайных запросов, а не от целенаправленного взлома: ключи ИИ в приложении не хранятся.
