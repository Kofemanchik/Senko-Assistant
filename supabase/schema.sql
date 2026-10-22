-- ============================================================================
-- Senko Assistant · база данных, этап 1 (аккаунты, роли, сессии, сброс пароля)
-- Выполняется один раз: Supabase → SQL Editor → New query → вставить → Run.
-- Скрипт можно запускать повторно: уже созданное он не ломает.
-- ============================================================================
-- Все обращения к данным идут через серверную функцию «senko» (Edge Function).
-- Таблицы закрыты для публичного API: RLS включён, политик нет, права у anon и
-- authenticated отозваны. Даже зная публичный ключ из приложения, прочитать или
-- изменить таблицы напрямую нельзя.
-- ============================================================================

create extension if not exists pgcrypto with schema extensions;

-- Профили пользователей ------------------------------------------------------
create table if not exists public.profiles (
  id             uuid primary key default gen_random_uuid(),
  login          text not null,
  login_lc       text generated always as (lower(login)) stored,
  pass_hash      text not null,                        -- bcrypt, открытого пароля нет нигде
  nick           text not null,
  static_id      text not null,
  org            text not null,
  dept           text not null default '',
  game_role      text not null check (game_role in ('off','pros','adv')),
  discord        text not null,
  telegram       text not null default '',
  phone          text not null,                        -- номер телефона в игре
  rank           text not null default 'user' check (rank in ('user','leader','moderator','owner')),
  tg_id          bigint,                               -- Telegram ID сотрудника (для модераторов)
  banned         boolean not null default false,
  ban_reason     text not null default '',
  banned_at      timestamptz,
  legal_version  text not null default '',
  legal_at       timestamptz,
  created_at     timestamptz not null default now(),
  last_seen      timestamptz
);
create unique index if not exists profiles_login_lc_key on public.profiles (login_lc);
create index        if not exists profiles_static_idx   on public.profiles (lower(static_id));
create unique index if not exists profiles_tg_id_key    on public.profiles (tg_id) where tg_id is not null;

-- Сессии (в базе только хэш токена) ------------------------------------------
create table if not exists public.sessions (
  token_hash  text primary key,
  user_id     uuid not null references public.profiles(id) on delete cascade,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null,
  last_used   timestamptz,
  remember    boolean not null default false
);
create index if not exists sessions_user_idx on public.sessions (user_id);

-- Код восстановления (в базе только хэш) -------------------------------------
create table if not exists public.recovery_codes (
  user_id     uuid primary key references public.profiles(id) on delete cascade,
  code_hash   text not null,
  created_at  timestamptz not null default now()
);

-- Запросы на сброс пароля ----------------------------------------------------
create table if not exists public.reset_requests (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references public.profiles(id) on delete cascade,
  secret_hash    text,                                 -- «пароль» для опроса статуса запроса
  status         text not null default 'pending'
                 check (status in ('pending','approved','rejected','done','expired','cancelled')),
  via            text not null default 'bot' check (via in ('bot','code')),
  token_hash     text,                                 -- одноразовый токен установки нового пароля
  token_expires  timestamptz,
  decided_by     text,
  decided_at     timestamptz,
  created_at     timestamptz not null default now(),
  expires_at     timestamptz not null
);
create index if not exists reset_requests_user_idx  on public.reset_requests (user_id);
create index if not exists reset_requests_token_idx on public.reset_requests (token_hash);

-- Журнал действий (роли, баны, сбросы) ---------------------------------------
create table if not exists public.audit_log (
  id      bigint generated always as identity primary key,
  at      timestamptz not null default now(),
  actor   text not null,
  action  text not null,
  target  text,
  details jsonb
);

-- Ограничение частоты запросов -----------------------------------------------
create table if not exists public.rate_limits (
  key    text primary key,
  n      integer not null,
  since  timestamptz not null default now()
);

-- Синхронизация данных работы между компьютерами (этап 2) -------------------
-- kind: thist (история задержаний), dlog (журнал статей), tests (результаты тестов),
--       qstat / xp / daily / streak (статистика тренажёра). Удаление хранится как del-запись.
create sequence if not exists public.sync_seq;
create table if not exists public.sync_items (
  user_id   uuid not null references public.profiles(id) on delete cascade,
  kind      text not null,
  item_id   text not null,
  data      jsonb,
  u         bigint not null,                -- время последней правки (мс), по нему решаются конфликты
  deleted   boolean not null default false,
  device    text not null default '',
  seq       bigint not null,
  primary key (user_id, kind, item_id)
);
create index if not exists sync_items_seq_idx on public.sync_items (user_id, seq);

-- Этап 2: модерация через бота -----------------------------------------------
alter table public.profiles add column if not exists banned_until timestamptz;           -- временная блокировка: снимается сама
alter table public.profiles add column if not exists tags text[] not null default '{}';   -- теги аккаунта (/tag)

-- Внутренние заметки к аккаунту (/note), пользователь их не видит
create table if not exists public.account_notes (
  id       bigint generated always as identity primary key,
  user_id  uuid not null references public.profiles(id) on delete cascade,
  author   text not null,
  text     text not null,
  at       timestamptz not null default now()
);
create index if not exists account_notes_user_idx on public.account_notes (user_id);

-- Предупреждения (/warn); после лимита аккаунт блокируется автоматически
create table if not exists public.account_warns (
  id       bigint generated always as identity primary key,
  user_id  uuid not null references public.profiles(id) on delete cascade,
  author   text not null,
  reason   text not null default '',
  at       timestamptz not null default now()
);
create index if not exists account_warns_user_idx on public.account_warns (user_id);

-- Действия бота, ждущие подтверждения кнопкой (/ban, /delete, /role, /tempban)
create table if not exists public.bot_pending (
  id          uuid primary key default gen_random_uuid(),
  actor_tg    text not null,
  action      text not null,
  payload     jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null
);

-- Этап 3: уведомления, рассылки, сервис ------------------------------------
alter table public.profiles add column if not exists app_version text not null default '';  -- версия программы (/versions)
alter table public.profiles add column if not exists devices text[] not null default '{}';  -- хэши устройств руководства (вход с нового устройства)

-- Настройки бота: техработы, сводка, регистрация, чёрный список слов
create table if not exists public.bot_settings (
  key         text primary key,
  value       jsonb not null,
  updated_at  timestamptz not null default now()
);

-- Сообщения в программе: всем (org и user_id пустые), организации или одному пользователю
create table if not exists public.broadcasts (
  id          bigint generated always as identity primary key,
  org         text,
  user_id     uuid references public.profiles(id) on delete cascade,
  title       text not null default '',
  author      text not null,
  text        text not null,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null
);
create index if not exists broadcasts_exp_idx on public.broadcasts (expires_at);

-- Сообщения об ошибках из программы
create table if not exists public.bug_reports (
  id           bigint generated always as identity primary key,
  user_id      uuid not null references public.profiles(id) on delete cascade,
  text         text not null,
  app_version  text not null default '',
  answered     boolean not null default false,
  at           timestamptz not null default now()
);

-- Отложенные команды бота (/in 2h unban логин)
create table if not exists public.bot_delayed (
  id           bigint generated always as identity primary key,
  actor_tg     text not null,
  actor_label  text not null,
  command      text not null,
  run_at       timestamptz not null,
  created_at   timestamptz not null default now()
);
create index if not exists bot_delayed_run_idx on public.bot_delayed (run_at);

-- Этап 4: достижения, рейтинг, функции руководства ------------------------------
-- Безопасное чтение чисел из данных синхронизации: мусор вместо числа даёт null, а не ошибку запроса
create or replace function public.senko_num(t text) returns numeric language sql immutable as
$$ select case when t ~ '^-?[0-9]{1,15}(\.[0-9]{1,6})?$' then t::numeric end $$;
revoke all on function public.senko_num(text) from anon, authenticated;
-- Приём новичков: ok — работает, pending — ждёт подтверждения руководства, rejected — отклонён
alter table public.profiles add column if not exists approval text not null default 'ok';
-- 2.2: какие спецсвязи (discord, telegram, phone) пользователь открыл руководству своей организации
alter table public.profiles add column if not exists contacts_open text[] not null default '{}';
-- 2.2: журнал программы, приложенный к сообщению об ошибке
alter table public.bug_reports add column if not exists log text not null default '';

-- Опыт на начало недели (неделя с понедельника по МСК): опыт за неделю = текущий опыт − base
create table if not exists public.xp_week (
  user_id  uuid not null references public.profiles(id) on delete cascade,
  week     text not null,                 -- дата понедельника, например 2026-10-19
  base     integer not null,
  primary key (user_id, week)
);

-- Полученные достижения
create table if not exists public.achievements (
  user_id  uuid not null references public.profiles(id) on delete cascade,
  code     text not null,
  at       timestamptz not null default now(),
  primary key (user_id, code)
);

-- Журнал смен руководства
create table if not exists public.shifts (
  id           bigint generated always as identity primary key,
  org          text not null,
  leader_id    uuid references public.profiles(id) on delete set null,
  leader       text not null default '',
  started_at   timestamptz not null default now(),
  ended_at     timestamptz,
  summary      jsonb
);
create index if not exists shifts_org_idx on public.shifts (org, started_at desc);

-- Контрольные тесты от руководства и их результаты
create table if not exists public.control_tests (
  id          bigint generated always as identity primary key,
  org         text not null,
  author_id   uuid references public.profiles(id) on delete set null,
  author      text not null default '',
  title       text not null,
  topics      text[] not null,
  n           integer not null,
  due_at      timestamptz not null,
  created_at  timestamptz not null default now(),
  closed      boolean not null default false
);
create table if not exists public.control_results (
  test_id  bigint not null references public.control_tests(id) on delete cascade,
  user_id  uuid not null references public.profiles(id) on delete cascade,
  s        integer not null,
  n        integer not null,
  p        integer not null,
  at       timestamptz not null default now(),
  primary key (test_id, user_id)
);

-- Вопросы к ИИ-помощнику и оценки ответов
create table if not exists public.ai_log (
  id       bigint generated always as identity primary key,
  user_id  uuid references public.profiles(id) on delete cascade,
  q        text not null,
  refs     text[] not null default '{}',
  ok       boolean not null default true,
  vote     smallint not null default 0,      -- 1 👍, -1 👎, 0 без оценки
  at       timestamptz not null default now()
);
create index if not exists ai_log_at_idx on public.ai_log (at desc);

-- Рапорты сотрудников (обновление 5)
create table if not exists public.reports (
  id           bigint generated always as identity primary key,
  user_id      uuid references public.profiles(id) on delete cascade,
  org          text not null,
  author       text not null default '',    -- ник, статик и отдел на момент подачи
  login        text not null default '',
  static_id    text not null default '',
  dept         text not null default '',
  kind         text not null,               -- arrest, force, incident, service
  title        text not null,
  fields       jsonb not null default '{}',
  body         text not null,               -- готовый текст рапорта
  status       text not null default 'new' check (status in ('new','ok','no')),
  reviewer     text not null default '',
  review_note  text not null default '',
  reviewed_at  timestamptz,
  created_at   timestamptz not null default now()
);
create index if not exists reports_org_idx  on public.reports (org, created_at desc);
create index if not exists reports_user_idx on public.reports (user_id, created_at desc);

-- Ссылки «Поделиться» на расчёт или набор статей (обновление 2.6): живут 30 дней
create table if not exists public.shares (
  code       text primary key,                -- 8 знаков, например K7M2QX9A
  kind       text not null check (kind in ('calc','set')),
  user_id    uuid references public.profiles(id) on delete cascade,
  author     text not null default '',
  title      text not null default '',
  ids        jsonb not null default '[]',     -- статьи: uk12.8-, ak2.1- ...
  body       text not null default '',        -- текст, который видно по ссылке в браузере
  views      int not null default 0,
  created_at timestamptz not null default now()
);
create index if not exists shares_created_idx on public.shares (created_at);

-- Перенос данных на другой компьютер по коду из 6 цифр (обновление 2.6): один код на аккаунт, 15 минут
create table if not exists public.transfers (
  user_id    uuid primary key references public.profiles(id) on delete cascade,
  code       text not null,
  data       jsonb not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);

-- Поиски без результата (обновление 2.6): только текст запроса и счётчики, без логина
create table if not exists public.search_misses (
  q        text primary key,
  n        int not null default 0,              -- сколько раз искали
  sends    int not null default 0,              -- сколько раз приходило из программ
  first_at timestamptz not null default now(),
  last_at  timestamptz not null default now()
);
create index if not exists search_misses_last_idx on public.search_misses (last_at desc);

-- Журнал входов (2.2): пользователь видит его в личном кабинете; хранится 90 дней
create table if not exists public.login_log (
  id      bigserial primary key,
  user_id uuid not null references public.profiles(id) on delete cascade,
  at      timestamptz not null default now(),
  kind    text not null default 'login',   -- login | fail | password | reset | logout_all
  ver     text not null default '',        -- версия программы
  os      text not null default '',        -- система: Windows 10 / Windows 11 и т. п.
  ip      text not null default ''         -- только начало адреса: 85.143.x.x
);
create index if not exists login_log_user_idx on public.login_log (user_id, at desc);

-- Панель владельца и модератора на сайте (сайт, этап 3) ----------------------
-- Пароль панели (32 знака) выдаёт бот командой /panel; в базе только хэш
create table if not exists public.panel_keys (
  user_id      uuid primary key references public.profiles(id) on delete cascade,
  key_hash     text not null,
  created_at   timestamptz not null default now(),
  created_by   text not null default '',
  last_used_at timestamptz
);
-- Открытые панели: не дольше 12 часов, закрываются после 2 часов без действий
create table if not exists public.panel_sessions (
  token_hash  text primary key,
  user_id     uuid not null references public.profiles(id) on delete cascade,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null,
  last_at     timestamptz not null default now(),
  ip          text not null default '',
  ua          text not null default ''
);
create index if not exists panel_sessions_user_idx on public.panel_sessions (user_id);

-- Рекламные баннеры (2.3.0): показываются на сайте и на главной в программе, правит владелец в панели
create table if not exists public.ads (
  id          bigserial primary key,
  title       text not null,
  srv         text not null default '',
  body        text not null default '',
  tag         text not null default 'Реклама',
  style       text not null default 'wide' check (style in ('wide','square')),
  image       text not null default '',
  links       jsonb not null default '[]'::jsonb,
  promo       text not null default '',
  place       text not null default 'both' check (place in ('both','site','app')),
  enabled     boolean not null default true,
  sort        int not null default 0,
  updated_at  timestamptz not null default now(),
  updated_by  text not null default ''
);
insert into public.ads (title, srv, body, style, image, links, promo, sort)
select * from (values
  ('Senko Family', 'Majestic RP · Los Angeles',
   'Семья на сервере Los Angeles. Заходите в Discord и Telegram: знакомство, набор и новости семьи.',
   'wide', '/img/senko-family-820.webp',
   '[{"label":"Discord семьи","url":"https://discord.gg/ZEz5kfG6W8"},{"label":"Telegram семьи","url":"https://t.me/senkofamq"}]'::jsonb, '', 10),
  ('Docossum | Ассистент GTA 5RP', 'Программа-ассистент · GTA 5 RP',
   'Помощник для игроков GTA 5 RP, похожий на наш, только умеет ещё больше. Загляните в Discord и Telegram, а с нашим промокодом будет приятнее.',
   'square', '/img/docossum.webp',
   '[{"label":"Discord","url":"https://discord.gg/Nnv9YjX3px"},{"label":"Telegram","url":"https://t.me/docossum"}]'::jsonb, 'Senko', 20)
) v(title, srv, body, style, image, links, promo, sort)
where not exists (select 1 from public.ads);

-- Закрываем таблицы от публичного API ----------------------------------------
alter table public.profiles       enable row level security;
alter table public.sessions       enable row level security;
alter table public.recovery_codes enable row level security;
alter table public.reset_requests enable row level security;
alter table public.audit_log      enable row level security;
alter table public.rate_limits    enable row level security;
alter table public.sync_items     enable row level security;
alter table public.account_notes  enable row level security;
alter table public.account_warns  enable row level security;
alter table public.bot_pending    enable row level security;
alter table public.bot_settings   enable row level security;
alter table public.broadcasts     enable row level security;
alter table public.bug_reports    enable row level security;
alter table public.bot_delayed    enable row level security;
alter table public.xp_week        enable row level security;
alter table public.achievements   enable row level security;
alter table public.shifts         enable row level security;
alter table public.control_tests  enable row level security;
alter table public.control_results enable row level security;
alter table public.ai_log         enable row level security;
alter table public.reports        enable row level security;
alter table public.shares         enable row level security;
alter table public.transfers      enable row level security;
alter table public.search_misses  enable row level security;
alter table public.login_log      enable row level security;
alter table public.panel_keys     enable row level security;
alter table public.panel_sessions enable row level security;
alter table public.ads            enable row level security;

revoke all on table public.profiles, public.sessions, public.recovery_codes,
                    public.reset_requests, public.audit_log, public.rate_limits, public.sync_items,
                    public.account_notes, public.account_warns, public.bot_pending,
                    public.bot_settings, public.broadcasts, public.bug_reports, public.bot_delayed,
                    public.xp_week, public.achievements, public.shifts, public.control_tests,
                    public.control_results, public.ai_log, public.reports,
                    public.shares, public.transfers, public.search_misses, public.login_log,
                    public.panel_keys, public.panel_sessions, public.ads
  from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;

-- Лёгкая функция для ежедневного «пинга» (чтобы бесплатный проект не засыпал) -
create or replace function public.ping() returns text
language sql stable as $$ select 'ok'::text $$;
grant execute on function public.ping() to anon, authenticated;

-- 2.4: бета-тестеры, задания, вебхуки Discord, мероприятия, идеи, экипажи, доска в ссылках.
-- Функция создаёт всё это сама при первом запросе (bot_settings.schema_v = 24), здесь то же самое для ручной установки.
alter table public.profiles add column if not exists beta boolean not null default false;
alter table public.shares drop constraint if exists shares_kind_check;
alter table public.shares add constraint shares_kind_check check (kind in ('calc','set','board'));
create table if not exists public.beta_tasks (
  id bigserial primary key, title text not null, body text not null default '', author text not null default '',
  created_at timestamptz not null default now(), closed boolean not null default false);
create table if not exists public.beta_results (
  task_id bigint not null references public.beta_tasks(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  status text not null check (status in ('ok','bad')), comment text not null default '', at timestamptz not null default now(),
  primary key (task_id, user_id));
create table if not exists public.org_hooks (
  org text primary key, url text not null, events text[] not null default '{}', updated_by text not null default '',
  updated_at timestamptz not null default now(), fails int not null default 0, last_error text not null default '');
create table if not exists public.org_events (
  id bigserial primary key, org text not null, title text not null, body text not null default '', place text not null default '',
  starts_at timestamptz not null, author text not null default '', created_at timestamptz not null default now(), reminded boolean not null default false);
create index if not exists org_events_org_idx on public.org_events (org, starts_at);
create table if not exists public.ideas (
  id bigserial primary key, user_id uuid references public.profiles(id) on delete set null, text text not null,
  status text not null default 'new' check (status in ('new','work','done','no')), answer text not null default '',
  created_at timestamptz not null default now(), updated_at timestamptz not null default now());
create table if not exists public.idea_votes (
  idea_id bigint not null references public.ideas(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade, primary key (idea_id, user_id));
create table if not exists public.patrols (
  code text primary key, owner_id uuid references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(), expires_at timestamptz not null);
create table if not exists public.patrol_members (
  code text not null references public.patrols(code) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  joined_at timestamptz not null default now(), seen_at timestamptz not null default now(), primary key (code, user_id));
create table if not exists public.patrol_items (
  id bigserial primary key, code text not null references public.patrols(code) on delete cascade,
  user_id uuid references public.profiles(id) on delete cascade, uid text not null default '',
  data jsonb not null default '{}'::jsonb, updated_at timestamptz not null default now(), deleted boolean not null default false);
create unique index if not exists patrol_items_key on public.patrol_items (code, user_id, uid);
alter table public.beta_tasks enable row level security;
alter table public.beta_results enable row level security;
alter table public.org_hooks enable row level security;
alter table public.org_events enable row level security;
alter table public.ideas enable row level security;
alter table public.idea_votes enable row level security;
alter table public.patrols enable row level security;
alter table public.patrol_members enable row level security;
alter table public.patrol_items enable row level security;
revoke all on table public.beta_tasks, public.beta_results, public.org_hooks, public.org_events, public.ideas, public.idea_votes,
                    public.patrols, public.patrol_members, public.patrol_items from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;

-- 2.6.3: поправка опыта из панели владельца (функция создаёт столбец сама, если schema.sql не запускали)
alter table public.profiles add column if not exists xp_adj integer not null default 0;
-- 2.6.6: дополнительные запросы к ИИ сверх дневного лимита (выдаёт владелец в панели)
alter table public.profiles add column if not exists ai_bonus integer not null default 0;

-- 2.7: словарь ИИ «бытовое слово → статья», эталонные вопросы для самопроверки, ответ ИИ в журнале
-- (сервер выполняет это сам при первом запросе, см. SCHEMA_27 в functions/senko/index.ts)
alter table public.ai_log add column if not exists ans text not null default '';
create table if not exists public.ai_dict (
  id bigserial primary key, phrase text not null, refs text[] not null default '{}', note text not null default '',
  author text not null default '', created_at timestamptz not null default now());
create table if not exists public.ai_gold (
  id bigserial primary key, q text not null, expect text not null default '', last text not null default '', last_ref text not null default '',
  prev text not null default '', prev_ref text not null default '', checked_at timestamptz, created_at timestamptz not null default now());
alter table public.ai_dict enable row level security;
alter table public.ai_gold enable row level security;
revoke all on table public.ai_dict, public.ai_gold from anon, authenticated;
