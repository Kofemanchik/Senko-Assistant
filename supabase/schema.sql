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

revoke all on table public.profiles, public.sessions, public.recovery_codes,
                    public.reset_requests, public.audit_log, public.rate_limits, public.sync_items,
                    public.account_notes, public.account_warns, public.bot_pending,
                    public.bot_settings, public.broadcasts, public.bug_reports, public.bot_delayed
  from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;

-- Лёгкая функция для ежедневного «пинга» (чтобы бесплатный проект не засыпал) -
create or replace function public.ping() returns text
language sql stable as $$ select 'ok'::text $$;
grant execute on function public.ping() to anon, authenticated;
