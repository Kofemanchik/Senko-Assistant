-- ============================================================================
-- Судебный портал (court-portal): схема Supabase, версия 2.
-- Все объекты с префиксом cp_, с остальным проектом ничего не пересекается.
-- Рекомендуется отдельный проект Supabase. Запускать целиком в SQL Editor,
-- скрипт можно выполнять повторно. Рассчитан на чистую базу.
-- ============================================================================

create extension if not exists pg_net;

do $$ begin
  if exists (select 1 from information_schema.tables where table_schema = 'public' and table_name = 'cp_claims')
     and not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'cp_claims' and column_name = 'stage') then
    raise exception 'Найдена схема версии 1. Эта версия рассчитана на чистую базу: удалите таблицы cp_* (или создайте новый проект Supabase) и запустите скрипт заново.';
  end if;
end $$;

-- ================================================================== таблицы ==
-- Роли: admin — всё; chair — председатель суда (судья + назначает судей и прокуроров); judge — судья;
-- clerk — секретарь суда; prosecutor / prosecutor_head — прокурор / ГП и ЗГП; iid / iid_head — сотрудник IID / AD;
-- user — обычный пользователь сайта; pending — сотрудник, которому ещё не выдан доступ.
create table if not exists public.cp_profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null default '',
  login text not null default '',
  nick text not null default '',
  discord text not null default '',
  avatar text not null default '',
  server text not null default '',                  -- сервер сотрудника (SF, ORL); пусто — все серверы
  role text not null default 'pending' check (role in ('admin','chair','judge','clerk','prosecutor','prosecutor_head','iid','iid_head','user','pending')),
  consent_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists public.cp_settings (
  key text primary key,
  value jsonb not null default 'null'::jsonb,
  public boolean not null default false,
  updated_at timestamptz not null default now()
);

create table if not exists public.cp_laws (
  id bigserial primary key,
  code text not null,               -- кодекс: УК, АК, ДК, ПК …
  article text not null,            -- номер статьи
  title text not null default '',
  body text not null default '',
  sort int not null default 0,
  server text not null default '',                  -- сервер, к которому относится закон; пусто — для обоих
  updated_at timestamptz not null default now(),
  unique (server, code, article)
);
create index if not exists cp_laws_code_idx on public.cp_laws (code, sort);

-- счётчики номеров (иски по судам, дела по ведомствам)
create table if not exists public.cp_counters (
  key text primary key,
  n bigint not null default 0
);

-- персонажи пользователя: по статику сайт находит его иски
create table if not exists public.cp_characters (
  id bigserial primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null check (length(trim(name)) between 2 and 60),
  static text not null check (static ~ '^[0-9]{1,9}$'),
  server text not null check (server <> ''),
  created_at timestamptz not null default now(),
  unique (user_id, server, static)
);

-- ---------------------------------------------------------------- иски ----
create table if not exists public.cp_claims (
  id bigserial primary key,
  no text not null default '',                       -- номер иска, например DC-12
  track text not null unique,                        -- секретный код для отслеживания и правки ссылки
  court text not null default '',                    -- код суда: DC, CA, SC
  court_name text not null default '',
  server text not null default '',
  filer text not null default 'citizen' check (filer in ('citizen','lawyer')),
  category text not null default '',
  title text not null default '',
  plaintiff text not null default '',
  plaintiff_static text not null default '',
  lawyer text not null default '',
  license text not null default '',
  defendants jsonb not null default '[]'::jsonb,     -- [{name,static,org}]
  defendant_statics text[] not null default '{}',
  related_no text not null default '',               -- номер иска первой инстанции (для апелляции)
  circumstances text not null default '',
  requests jsonb not null default '[]'::jsonb,       -- ["…","…"]
  attachments jsonb not null default '[]'::jsonb,    -- [{name,url}]
  fee text not null default '',
  contacts text not null default '',
  text text not null default '',                     -- читаемый текст иска
  bb text not null default '',                       -- BB-код для форума
  forum_url text not null default '',                -- ссылка на тему, которую заявитель создал на форуме
  user_id uuid references auth.users(id) on delete set null,
  stage text not null default 'new' check (stage in ('new','processing','prosecutor','hearing_set','hearing_held','decision','closed')),
  outcome text not null default '' check (outcome in ('','granted','partly','denied','returned','withdrawn','other')),
  judge_id uuid references public.cp_profiles(id) on delete set null,
  prosecutor_id uuid references public.cp_profiles(id) on delete set null,
  public_note text not null default '',              -- ответ заявителю
  decided_by text not null default '',
  created_at timestamptz not null default now(),
  stage_at timestamptz not null default now(),
  decided_at timestamptz,
  closed_at timestamptz
);
create unique index if not exists cp_claims_no_idx on public.cp_claims (no) where no <> '';
create index if not exists cp_claims_stage_idx on public.cp_claims (stage, created_at desc);
create index if not exists cp_claims_judge_idx on public.cp_claims (judge_id);
create index if not exists cp_claims_pros_idx on public.cp_claims (prosecutor_id);
create index if not exists cp_claims_plstat_idx on public.cp_claims (plaintiff_static);
create index if not exists cp_claims_defstat_idx on public.cp_claims using gin (defendant_statics);

-- материалы сторон к иску: ходатайства, доказательства, отзывы
create table if not exists public.cp_materials (
  id bigserial primary key,
  claim_id bigint not null references public.cp_claims(id) on delete cascade,
  user_id uuid references auth.users(id) on delete set null,
  kind text not null check (kind in ('motion','evidence','response')),
  body text not null,
  links jsonb not null default '[]'::jsonb,
  status text not null default 'pending' check (status in ('pending','accepted','rejected')),
  reason text not null default '',
  decided_by text not null default '',
  created_at timestamptz not null default now()
);
create index if not exists cp_materials_claim_idx on public.cp_materials (claim_id);

-- заметки судей по иску (стороны и не-судьи их не видят)
create table if not exists public.cp_claim_notes (
  id bigserial primary key,
  claim_id bigint not null references public.cp_claims(id) on delete cascade,
  author_id uuid references public.cp_profiles(id) on delete set null,
  author text not null default '',
  body text not null,
  created_at timestamptz not null default now()
);
create index if not exists cp_claim_notes_idx on public.cp_claim_notes (claim_id);

-- запросы суда к прокуратуре на назначение (или замену) прокурора по иску
create table if not exists public.cp_pros_requests (
  id bigserial primary key,
  claim_id bigint not null references public.cp_claims(id) on delete cascade,
  kind text not null default 'assign' check (kind in ('assign','replace')),
  note text not null default '',
  status text not null default 'pending' check (status in ('pending','assigned','declined','withdrawn')),
  reason text not null default '',                   -- причина отказа (её видит суд)
  prosecutor_id uuid references public.cp_profiles(id) on delete set null,
  requested_by uuid references public.cp_profiles(id) on delete set null,
  requested_name text not null default '',
  handled_by text not null default '',
  created_at timestamptz not null default now(),
  handled_at timestamptz,
  done_at timestamptz                                -- прокурор завершил участие
);
create index if not exists cp_pros_requests_idx on public.cp_pros_requests (status, created_at desc);
create index if not exists cp_pros_requests_claim_idx on public.cp_pros_requests (claim_id);

-- ---------------------------------------------------------------- дела ----
-- Дело ведёт одно из трёх ведомств (holder): IID → прокуратура → суд. org — где дело создано.
-- flow: draft (пишется) → review (на проверке) → approved (утверждено) → transferred (передано дальше);
-- returned — возвращено на доработку, rejected — отклонено. Для дел суда flow всегда approved.
create table if not exists public.cp_cases (
  id bigserial primary key,
  no text not null default '',
  title text not null,
  kind text not null default 'civil' check (kind in ('civil','criminal','admin','other')),
  status text not null default 'open' check (status in ('open','hearing','decision','closed')),
  server text not null default '',
  org text not null default 'court' check (org in ('court','iid','prosecutor')),
  holder text not null default 'court' check (holder in ('court','iid','prosecutor')),
  from_holder text not null default '',
  flow text not null default 'approved' check (flow in ('draft','review','returned','approved','transferred','rejected')),
  accused text not null default '',
  parties jsonb not null default '[]'::jsonb,        -- [{role,name}]
  articles text not null default '',
  materials jsonb not null default '[]'::jsonb,      -- [{name,url}]
  progress text not null default '',                 -- ход дела
  return_reason text not null default '',
  approved_by text not null default '',
  judge_id uuid references public.cp_profiles(id) on delete set null,
  claim_id bigint references public.cp_claims(id) on delete set null,
  notes text not null default '',
  created_by uuid references public.cp_profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  closed_at timestamptz
);
create index if not exists cp_cases_status_idx on public.cp_cases (holder, flow, updated_at desc);

-- записи о движении дела (кто, что и кому передал или вернул)
create table if not exists public.cp_case_log (
  id bigserial primary key,
  case_id bigint not null references public.cp_cases(id) on delete cascade,
  at timestamptz not null default now(),
  who_id uuid,
  who text not null default '',
  action text not null,
  note text not null default '',
  from_holder text not null default '',
  to_holder text not null default ''
);
create index if not exists cp_case_log_idx on public.cp_case_log (case_id, at);

create table if not exists public.cp_hearings (
  id bigserial primary key,
  case_id bigint references public.cp_cases(id) on delete cascade,
  claim_id bigint references public.cp_claims(id) on delete cascade,
  at timestamptz not null,
  place text not null default '',
  note text not null default '',
  created_at timestamptz not null default now(),
  check (case_id is not null or claim_id is not null)
);
create index if not exists cp_hearings_case_idx on public.cp_hearings (case_id, at);
create index if not exists cp_hearings_claim_idx on public.cp_hearings (claim_id, at);

create table if not exists public.cp_decisions (
  id bigserial primary key,
  case_id bigint references public.cp_cases(id) on delete set null,
  claim_id bigint references public.cp_claims(id) on delete set null,
  server text not null default '',
  no text not null default '',
  title text not null,
  dt date not null default current_date,
  verdict text not null default '',
  person text not null default '',
  text text not null,
  public boolean not null default false,
  anon boolean not null default true,
  author text not null default '',
  created_at timestamptz not null default now()
);
create index if not exists cp_decisions_dt_idx on public.cp_decisions (dt desc);

create table if not exists public.cp_applications (
  id bigserial primary key,
  nickname text not null,
  discord text not null,
  position text not null,
  server text not null default '',
  answers jsonb not null default '[]'::jsonb,      -- [{q,a}]
  status text not null default 'new' check (status in ('new','review','accepted','rejected')),
  note text not null default '',
  decided_by text not null default '',
  created_at timestamptz not null default now(),
  decided_at timestamptz
);
create index if not exists cp_applications_status_idx on public.cp_applications (status, created_at desc);

create table if not exists public.cp_webhooks (
  event text primary key check (event in ('application','application_result','claim','assign','hearing','case','decision','pros_request','pros_assign','transfer')),
  url text not null check (url ~ '^https://(discord|discordapp)\.com/api/webhooks/[0-9]+/[A-Za-z0-9_-]+$'),
  enabled boolean not null default true,
  updated_at timestamptz not null default now()
);

create table if not exists public.cp_audit (
  id bigserial primary key,
  at timestamptz not null default now(),
  user_id uuid,
  who text not null default '',
  action text not null,
  tbl text not null,
  target text not null default '',
  keys jsonb not null default '[]'::jsonb          -- какие поля менялись (значения не пишем)
);
create index if not exists cp_audit_at_idx on public.cp_audit (at desc);

create table if not exists public.cp_rate (id bigserial primary key, k text not null, at timestamptz not null default now());
create index if not exists cp_rate_k_idx on public.cp_rate (k, at);

-- ================================================================ настройки ==
insert into public.cp_settings (key, value, public) values
  ('site', '{"name":"Судебный портал","tagline":"Помощь в подаче исков и обращений в суд","footer":"Неофициальный ресурс. Не связан с администрацией проекта."}'::jsonb, true),
  ('app_open', 'true'::jsonb, true),
  ('app_positions', '["Судья Окружного суда","Судья Апелляционного суда","Секретарь суда","Адвокат","Прокурор"]'::jsonb, true),
  ('app_questions', '["Сколько вам лет (OOC)?","Сколько вы играете на проекте?","Был ли опыт работы в судебной системе? Опишите.","Почему вы хотите работать в суде?","Сколько времени в день готовы уделять работе?"]'::jsonb, true),
  ('servers', '[{"code":"SF","name":"San Francisco"},{"code":"ORL","name":"Orlando"}]'::jsonb, true),
  ('courts', '[{"code":"SFDC","server":"SF","name":"Окружной суд","forum":""},{"code":"SFCA","server":"SF","name":"Апелляционный суд","forum":""},{"code":"SFSC","server":"SF","name":"Верховный суд","forum":""},{"code":"ORDC","server":"ORL","name":"Окружной суд","forum":""},{"code":"ORCA","server":"ORL","name":"Апелляционный суд","forum":""},{"code":"ORSC","server":"ORL","name":"Верховный суд","forum":""}]'::jsonb, true),
  ('claim_cats', '["Гражданский спор","Административный иск","Жалоба на действия сотрудника","Обжалование решения","Иное"]'::jsonb, true),
  ('fees', '["Госпошлина оплачена","Прошу освободить от госпошлины","Прошу отсрочить уплату госпошлины"]'::jsonb, true),
  ('deadlines', '{"start_h":48,"pros_h":72,"decide_d":10}'::jsonb, true),
  ('policy', '"Сайт хранит логин, имя, статики персонажей и тексты поданных вами исков. Данные нужны только для работы суда и не передаются третьим лицам. Вы можете запросить удаление аккаунта у администрации."'::jsonb, true)
on conflict (key) do nothing;

-- ============================================================= роли и права ==
create or replace function public.cp_role() returns text
language sql stable security definer set search_path = public as $$
  select role from public.cp_profiles where id = auth.uid()
$$;
create or replace function public.cp_is_court() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select role in ('admin','chair','judge','clerk') from public.cp_profiles where id = auth.uid()), false)
$$;
create or replace function public.cp_is_judge() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select role in ('admin','chair','judge') from public.cp_profiles where id = auth.uid()), false)
$$;
create or replace function public.cp_is_lead() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select role in ('admin','chair') from public.cp_profiles where id = auth.uid()), false)
$$;
create or replace function public.cp_is_staff() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select role in ('admin','chair','judge','clerk','prosecutor','prosecutor_head','iid','iid_head') from public.cp_profiles where id = auth.uid()), false)
$$;
create or replace function public.cp_my_statics(srv text) returns text[]
language sql stable security definer set search_path = public as $$
  select coalesce(array_agg(static), '{}'::text[]) from public.cp_characters where user_id = auth.uid() and server = srv
$$;
-- доступ к данным сервера: admin и сотрудники без привязки видят всё, остальные — только свой сервер
create or replace function public.cp_srv_ok(s text) returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select role = 'admin' or server = '' or server = coalesce(s, '') from public.cp_profiles where id = auth.uid()), false)
$$;
create or replace function public.cp_claim_server(cid bigint) returns text
language sql stable security definer set search_path = public as $$ select server from public.cp_claims where id = cid $$;
create or replace function public.cp_case_server(cid bigint) returns text
language sql stable security definer set search_path = public as $$ select server from public.cp_cases where id = cid $$;

-- регистрация: пользователи сайта получают роль user; сотрудники (kind=staff в панели) — pending,
-- а самый первый сотрудник становится администратором
create or replace function public.cp_on_signup() returns trigger
language plpgsql security definer set search_path = public as $$
declare first_user boolean; n text; lg text; r text;
begin
  lg := lower(left(coalesce(nullif(trim(new.raw_user_meta_data->>'login'), ''), split_part(coalesce(new.email, ''), '@', 1)), 40));
  n := left(coalesce(nullif(trim(new.raw_user_meta_data->>'nick'), ''), lg), 40);
  if coalesce(new.raw_user_meta_data->>'kind', 'user') = 'staff' then
    select not exists (select 1 from public.cp_profiles where role = 'admin') into first_user;
    r := case when first_user then 'admin' else 'pending' end;
  else
    r := 'user';
  end if;
  insert into public.cp_profiles (id, email, login, nick, role, consent_at)
  values (new.id, coalesce(new.email, ''), lg, n, r, case when new.raw_user_meta_data->>'consent' = 'true' then now() end)
  on conflict (id) do nothing;
  return new;
end $$;
drop trigger if exists cp_on_signup on auth.users;
create trigger cp_on_signup after insert on auth.users for each row execute function public.cp_on_signup();

-- нельзя убрать или удалить последнего администратора
create or replace function public.cp_keep_admin() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if old.role = 'admin' and (tg_op = 'DELETE' or new.role <> 'admin')
     and not exists (select 1 from public.cp_profiles where role = 'admin' and id <> old.id) then
    raise exception 'last_admin';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end $$;
drop trigger if exists cp_keep_admin on public.cp_profiles;
create trigger cp_keep_admin before update or delete on public.cp_profiles for each row execute function public.cp_keep_admin();

-- человек может править свой профиль (имя, аватар, Discord), но не роль, почту и логин
create or replace function public.cp_protect_profile() returns trigger
language plpgsql as $$
begin
  if auth.uid() is not null and coalesce(public.cp_role(), '') <> 'admin' then
    new.role := old.role; new.server := old.server; new.email := old.email; new.login := old.login; new.consent_at := old.consent_at;
  end if;
  return new;
end $$;
drop trigger if exists cp_protect_profile on public.cp_profiles;
create trigger cp_protect_profile before update on public.cp_profiles for each row execute function public.cp_protect_profile();

-- не больше трёх персонажей
create or replace function public.cp_char_limit() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if (select count(*) from public.cp_characters where user_id = new.user_id and server = new.server) >= 3 then raise exception 'char_limit'; end if;
  return new;
end $$;
drop trigger if exists cp_char_limit on public.cp_characters;
create trigger cp_char_limit before insert on public.cp_characters for each row execute function public.cp_char_limit();

-- ============================================================ служебные функции ==
create or replace function public.cp_next(k text) returns bigint
language plpgsql security definer set search_path = public as $$
declare v bigint;
begin
  insert into public.cp_counters (key, n) values (k, 1)
  on conflict (key) do update set n = public.cp_counters.n + 1
  returning n into v;
  return v;
end $$;
revoke all on function public.cp_next(text) from public, anon, authenticated;

create or replace function public.cp_url_ok(u text) returns boolean
language sql immutable as $$
  select coalesce(length(u) between 10 and 500 and u ~ '^https?://[^[:space:]]+$' and strpos(u, '[') = 0 and strpos(u, ']') = 0, false)
$$;

create or replace function public.cp_rate_check(kind text, lim int, win interval) returns void
language plpgsql security definer set search_path = public as $$
declare h json; ip text; key text;
begin
  begin h := current_setting('request.headers', true)::json; exception when others then h := null; end;
  ip := coalesce(h->>'cf-connecting-ip', trim(split_part(coalesce(h->>'x-forwarded-for', ''), ',', -1)), 'x');
  if ip = '' then ip := 'x'; end if;
  key := kind || ':' || ip;
  delete from public.cp_rate where at < now() - interval '1 day';
  if (select count(*) from public.cp_rate where k = key and at > now() - win) >= lim then
    raise exception 'rate_limited';
  end if;
  insert into public.cp_rate (k) values (key);
end $$;
revoke all on function public.cp_rate_check(text, int, interval) from public, anon, authenticated;

create or replace function public.cp_touch() returns trigger language plpgsql as $$
begin new.updated_at := now(); return new; end $$;
do $$
declare t text;
begin
  foreach t in array array['cp_cases','cp_laws','cp_settings','cp_webhooks'] loop
    execute format('drop trigger if exists cp_touch on public.%I', t);
    execute format('create trigger cp_touch before update on public.%I for each row execute function public.cp_touch()', t);
  end loop;
end $$;

-- этапы иска: время смены, дата решения и закрытия
create or replace function public.cp_claim_before() returns trigger
language plpgsql as $$
begin
  new.server := old.server;
  if new.stage is distinct from old.stage then
    new.stage_at := now();
    if new.stage in ('decision','closed') and new.decided_at is null then new.decided_at := now(); end if;
    if new.stage = 'closed' and new.closed_at is null then new.closed_at := now(); end if;
    if new.stage <> 'closed' then new.closed_at := null; end if;
  end if;
  return new;
end $$;
drop trigger if exists cp_claim_before on public.cp_claims;
create trigger cp_claim_before before update on public.cp_claims for each row execute function public.cp_claim_before();

-- журнал: кто что менял (значения полей не пишем)
create or replace function public.cp_audit_trg() returns trigger
language plpgsql security definer set search_path = public as $$
declare r jsonb; o jsonb; k jsonb; who_ text;
begin
  r := to_jsonb(case when tg_op = 'DELETE' then old else new end);
  if tg_op = 'UPDATE' then
    o := to_jsonb(old);
    select coalesce(jsonb_agg(e.key), '[]'::jsonb) into k from jsonb_each(r) e where o -> e.key is distinct from e.value;
    if k = '[]'::jsonb then return new; end if;
  else
    k := '[]'::jsonb;
  end if;
  select nick into who_ from public.cp_profiles where id = auth.uid();
  insert into public.cp_audit (user_id, who, action, tbl, target, keys)
  values (auth.uid(), coalesce(who_, ''), lower(tg_op), tg_table_name, coalesce(r->>'id', r->>'event', r->>'key', ''), k);
  return case when tg_op = 'DELETE' then old else new end;
end $$;

do $$
declare t text;
begin
  foreach t in array array['cp_cases','cp_decisions','cp_applications','cp_claims','cp_laws','cp_profiles','cp_webhooks','cp_settings','cp_materials','cp_claim_notes','cp_pros_requests'] loop
    execute format('drop trigger if exists cp_audit on public.%I', t);
    execute format('create trigger cp_audit after insert or update or delete on public.%I for each row execute function public.cp_audit_trg()', t);
  end loop;
end $$;

-- ====================================================== Discord-уведомления ==
-- Адреса вебхуков хранятся только в cp_webhooks (читает лишь admin). Отправка идёт прямо из базы через pg_net,
-- поэтому адреса не попадают в браузер, а содержимое сообщения берётся из записи, а не от посетителя.
create or replace function public.cp_notify(ev text, embed jsonb) returns void
language plpgsql security definer set search_path = public as $$
declare w_url text;
begin
  select url into w_url from public.cp_webhooks where event = ev and enabled;
  if w_url is null then return; end if;
  perform net.http_post(
    url := w_url,
    body := jsonb_build_object('username', 'Судебный портал', 'allowed_mentions', jsonb_build_object('parse', '[]'::jsonb), 'embeds', jsonb_build_array(embed)),
    headers := '{"Content-Type":"application/json"}'::jsonb
  );
exception when others then
  null; -- уведомление никогда не должно ломать запись данных
end $$;
revoke all on function public.cp_notify(text, jsonb) from public, anon, authenticated;

create or replace function public.cp_f(n text, v text) returns jsonb language sql immutable as $$
  select jsonb_build_object('name', left(n, 256), 'value', left(coalesce(nullif(trim(v), ''), '—'), 1000), 'inline', false)
$$;

create or replace function public.cp_trg_application() returns trigger
language plpgsql security definer set search_path = public as $$
declare f jsonb; a jsonb;
begin
  if tg_op = 'INSERT' then
    f := jsonb_build_array(public.cp_f('Ник', new.nickname), public.cp_f('Discord', new.discord), public.cp_f('Должность', new.position));
    for a in select * from jsonb_array_elements(new.answers) loop
      f := f || public.cp_f(a->>'q', a->>'a');
    end loop;
    f := (select coalesce(jsonb_agg(e), '[]'::jsonb) from (select e from jsonb_array_elements(f) e limit 25) s);
    perform public.cp_notify('application', jsonb_build_object('title', 'Новая заявка № ' || new.id, 'color', 5793266, 'fields', f, 'timestamp', now()));
  elsif tg_op = 'UPDATE' and new.status in ('accepted','rejected') and old.status is distinct from new.status then
    perform public.cp_notify('application_result', jsonb_build_object(
      'title', 'Заявка № ' || new.id || ': ' || case when new.status = 'accepted' then 'принята' else 'отклонена' end,
      'color', case when new.status = 'accepted' then 5763719 else 15548997 end,
      'fields', jsonb_build_array(public.cp_f('Ник', new.nickname), public.cp_f('Должность', new.position), public.cp_f('Решил', new.decided_by), public.cp_f('Комментарий', new.note)),
      'timestamp', now()));
  end if;
  return new;
end $$;
drop trigger if exists cp_notify_application on public.cp_applications;
create trigger cp_notify_application after insert or update on public.cp_applications for each row execute function public.cp_trg_application();

-- иск: новый — событие claim; назначен судья — событие assign
create or replace function public.cp_trg_claim() returns trigger
language plpgsql security definer set search_path = public as $$
declare jn text;
begin
  if tg_op = 'INSERT' then
    perform public.cp_notify('claim', jsonb_build_object('title', 'Новый иск ' || new.no, 'color', 15105570,
      'description', left(new.title, 500),
      'fields', jsonb_build_array(public.cp_f('Суд', new.court_name), public.cp_f('Категория', new.category), public.cp_f('Истец', new.plaintiff), public.cp_f('Контакты', new.contacts)),
      'timestamp', now()));
  elsif new.judge_id is distinct from old.judge_id and new.judge_id is not null then
    select nick into jn from public.cp_profiles where id = new.judge_id;
    perform public.cp_notify('assign', jsonb_build_object('title', 'Назначен судья по иску ' || new.no, 'color', 3447003,
      'description', left(new.title, 500),
      'fields', jsonb_build_array(public.cp_f('Суд', new.court_name), public.cp_f('Судья', jn)),
      'timestamp', now()));
  end if;
  return new;
end $$;
drop trigger if exists cp_notify_claim on public.cp_claims;
create trigger cp_notify_claim after insert or update on public.cp_claims for each row execute function public.cp_trg_claim();

-- дело суда открыто (для дел IID и прокуратуры сообщение уходит при передаче, см. cp_case_action)
create or replace function public.cp_trg_case() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.holder = 'court' then
    perform public.cp_notify('case', jsonb_build_object('title', 'Открыто дело ' || coalesce(nullif(new.no, ''), '№ ' || new.id), 'color', 3447003,
      'fields', jsonb_build_array(public.cp_f('Название', new.title), public.cp_f('Тип', new.kind), public.cp_f('Статьи', new.articles)),
      'timestamp', now()));
  end if;
  return new;
end $$;
drop trigger if exists cp_notify_case on public.cp_cases;
create trigger cp_notify_case after insert on public.cp_cases for each row execute function public.cp_trg_case();

create or replace function public.cp_trg_decision() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.public and (tg_op = 'INSERT' or not old.public) then
    perform public.cp_notify('decision', jsonb_build_object('title', 'Опубликовано решение ' || coalesce(nullif(new.no, ''), '№ ' || new.id), 'color', 10181046,
      'description', left(new.title, 500),
      'fields', jsonb_build_array(public.cp_f('Дата', new.dt::text), public.cp_f('Вердикт', new.verdict)),
      'timestamp', now()));
  end if;
  return new;
end $$;
drop trigger if exists cp_notify_decision on public.cp_decisions;
create trigger cp_notify_decision after insert or update on public.cp_decisions for each row execute function public.cp_trg_decision();

-- заседание назначено; время в Discord показывается по часовому поясу читателя
create or replace function public.cp_trg_hearing() returns trigger
language plpgsql security definer set search_path = public as $$
declare lbl text; ttl text;
begin
  if new.claim_id is not null then
    select 'иск ' || no, title into lbl, ttl from public.cp_claims where id = new.claim_id;
  else
    select 'дело ' || coalesce(nullif(no, ''), '№ ' || id), title into lbl, ttl from public.cp_cases where id = new.case_id;
  end if;
  perform public.cp_notify('hearing', jsonb_build_object('title', 'Назначено заседание: ' || coalesce(lbl, ''), 'color', 15844367,
    'description', left(coalesce(ttl, ''), 500),
    'fields', jsonb_build_array(public.cp_f('Когда', '<t:' || extract(epoch from new.at)::bigint || ':F>'), public.cp_f('Место', new.place), public.cp_f('Пометка', new.note)),
    'timestamp', now()));
  return new;
end $$;
drop trigger if exists cp_notify_hearing on public.cp_hearings;
create trigger cp_notify_hearing after insert on public.cp_hearings for each row execute function public.cp_trg_hearing();

-- запросы к прокуратуре: суд просит (pros_request), ГП назначает (pros_assign) — иск получает прокурора и этап «прокурорская проверка»
create or replace function public.cp_trg_pros_request() returns trigger
language plpgsql security definer set search_path = public as $$
declare cl public.cp_claims; pn text;
begin
  select * into cl from public.cp_claims where id = new.claim_id;
  if tg_op = 'INSERT' then
    perform public.cp_notify('pros_request', jsonb_build_object('title', case when new.kind = 'replace' then 'Суд просит заменить прокурора: ' else 'Суд просит назначить прокурора: ' end || cl.no, 'color', 15105570,
      'description', left(cl.title, 500),
      'fields', jsonb_build_array(public.cp_f('Суд', cl.court_name), public.cp_f('Запросил', new.requested_name), public.cp_f('Пометка', new.note)),
      'timestamp', now()));
  elsif new.status = 'assigned' and old.status is distinct from 'assigned' and new.prosecutor_id is not null then
    update public.cp_claims set prosecutor_id = new.prosecutor_id,
      stage = case when stage in ('new','processing') then 'prosecutor' else stage end
    where id = new.claim_id;
    select nick into pn from public.cp_profiles where id = new.prosecutor_id;
    perform public.cp_notify('pros_assign', jsonb_build_object('title', 'Назначен прокурор по иску ' || cl.no, 'color', 5763719,
      'description', left(cl.title, 500),
      'fields', jsonb_build_array(public.cp_f('Суд', cl.court_name), public.cp_f('Прокурор', pn), public.cp_f('Назначил', new.handled_by)),
      'timestamp', now()));
  end if;
  return new;
end $$;
drop trigger if exists cp_notify_pros on public.cp_pros_requests;
create trigger cp_notify_pros after insert or update on public.cp_pros_requests for each row execute function public.cp_trg_pros_request();

-- проверка вебхука из панели (только admin)
create or replace function public.cp_test_webhook(ev text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if public.cp_role() is distinct from 'admin' then raise exception 'forbidden'; end if;
  perform public.cp_notify(ev, jsonb_build_object('title', 'Проверка вебхука', 'color', 5793266,
    'description', 'Если вы видите это сообщение, вебхук «' || ev || '» настроен верно.', 'timestamp', now()));
end $$;

-- сервер дел и решений берётся из профиля автора; менять его после создания может только admin
create or replace function public.cp_set_server() returns trigger
language plpgsql security definer set search_path = public as $$
declare ps text;
begin
  if auth.uid() is null then return new; end if;
  select server into ps from public.cp_profiles where id = auth.uid();
  if coalesce(public.cp_role(), '') <> 'admin' then
    if tg_op = 'UPDATE' then new.server := old.server;
    elsif coalesce(ps, '') <> '' then new.server := ps; end if;
  end if;
  return new;
end $$;
drop trigger if exists cp_set_server on public.cp_cases;
create trigger cp_set_server before insert or update on public.cp_cases for each row execute function public.cp_set_server();
drop trigger if exists cp_set_server on public.cp_decisions;
create trigger cp_set_server before insert or update on public.cp_decisions for each row execute function public.cp_set_server();

-- ================================================ дела: защита и передача ==
-- Поля движения дела (flow, holder, org …) меняются только через cp_case_action, чтобы нельзя было
-- «утвердить» своё дело или передать его в обход проверяющего.
create or replace function public.cp_case_guard() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is not null and coalesce(public.cp_role(), '') <> 'admin' and coalesce(current_setting('cp.rpc', true), '') <> '1' then
    if tg_op = 'INSERT' then
      if new.org <> 'court' and (new.flow <> 'draft' or new.holder <> new.org or new.from_holder <> '') then raise exception 'forbidden'; end if;
      if new.org = 'court' and (new.holder <> 'court' or new.flow <> 'approved') then raise exception 'forbidden'; end if;
      new.created_by := auth.uid();
    elsif new.flow is distinct from old.flow or new.holder is distinct from old.holder or new.org is distinct from old.org
       or new.from_holder is distinct from old.from_holder or new.created_by is distinct from old.created_by
       or new.approved_by is distinct from old.approved_by or new.return_reason is distinct from old.return_reason then
      raise exception 'forbidden';
    end if;
  end if;
  if tg_op = 'INSERT' and new.org <> 'court' and coalesce(new.no, '') = '' then
    new.no := (case new.org when 'iid' then 'ID' else 'PR' end) || '-' || public.cp_next('case:' || new.org);
  end if;
  return new;
end $$;
drop trigger if exists cp_case_guard on public.cp_cases;
create trigger cp_case_guard before insert or update on public.cp_cases for each row execute function public.cp_case_guard();

-- act: submit (на проверку) · approve · send_back (вернуть автору на доработку) · reject · unapprove (снять утверждение) ·
-- transfer (IID → прокуратура → суд) · return (принявшее ведомство возвращает тому, кто передал)
create or replace function public.cp_case_action(cid bigint, act text, note text default '') returns void
language plpgsql security definer set search_path = public as $$
declare c public.cp_cases; r text := public.cp_role(); me_ text; head boolean; own boolean; nxt text; lbl text;
begin
  if auth.uid() is null or r is null then raise exception 'forbidden'; end if;
  select * into c from public.cp_cases where id = cid for update;
  if c.id is null then raise exception 'not_found'; end if;
  select nick into me_ from public.cp_profiles where id = auth.uid();
  note := left(coalesce(trim(note), ''), 1000);
  head := r = 'admin' or (c.holder = 'iid' and r = 'iid_head') or (c.holder = 'prosecutor' and r = 'prosecutor_head');
  own := head or (c.created_by = auth.uid() and ((c.holder = 'iid' and r in ('iid','iid_head')) or (c.holder = 'prosecutor' and r in ('prosecutor','prosecutor_head'))));
  perform set_config('cp.rpc', '1', true);

  if act = 'submit' then
    if c.holder = 'court' or not own or c.flow not in ('draft','returned') then raise exception 'forbidden'; end if;
    update public.cp_cases set flow = 'review', return_reason = '' where id = cid;
  elsif act = 'approve' then
    if not head or c.flow <> 'review' then raise exception 'forbidden'; end if;
    update public.cp_cases set flow = 'approved', approved_by = me_, return_reason = '' where id = cid;
  elsif act = 'send_back' then
    if not head or c.flow <> 'review' then raise exception 'forbidden'; end if;
    update public.cp_cases set flow = 'returned', return_reason = note where id = cid;
  elsif act = 'reject' then
    if not head or c.flow <> 'review' then raise exception 'forbidden'; end if;
    update public.cp_cases set flow = 'rejected', return_reason = note where id = cid;
  elsif act = 'unapprove' then
    if not own or c.flow <> 'approved' then raise exception 'forbidden'; end if;
    update public.cp_cases set flow = 'draft', approved_by = '' where id = cid;
  elsif act = 'transfer' then
    nxt := case c.holder when 'iid' then 'prosecutor' when 'prosecutor' then 'court' else null end;
    if nxt is null then raise exception 'bad_target'; end if;
    if not own or c.flow not in ('approved','transferred') or (c.flow = 'transferred' and not head) then raise exception 'forbidden'; end if;
    update public.cp_cases set from_holder = c.holder, holder = nxt, flow = 'transferred', return_reason = '',
      status = case when nxt = 'court' then 'open' else status end where id = cid;
    lbl := coalesce(nullif(c.no, ''), '№ ' || c.id);
    perform public.cp_notify('transfer', jsonb_build_object('title', 'Дело ' || lbl || ' передано: ' || c.holder || ' → ' || nxt, 'color', 3447003,
      'fields', jsonb_build_array(public.cp_f('Название', c.title), public.cp_f('Обвиняемый', c.accused), public.cp_f('Статьи', c.articles), public.cp_f('Передал', me_)),
      'timestamp', now()));
  elsif act = 'return' then
    if c.flow <> 'transferred' or c.from_holder = '' then raise exception 'forbidden'; end if;
    if not ((c.holder = 'court' and r in ('admin','chair','judge')) or (c.holder = 'prosecutor' and r in ('admin','prosecutor','prosecutor_head'))) then raise exception 'forbidden'; end if;
    update public.cp_cases set holder = c.from_holder, from_holder = '', flow = 'returned', return_reason = note where id = cid;
  else
    raise exception 'bad_action';
  end if;

  insert into public.cp_case_log (case_id, who_id, who, action, note, from_holder, to_holder)
  select cid, auth.uid(), coalesce(me_, ''), act, note, c.holder, n.holder from public.cp_cases n where n.id = cid;
  perform set_config('cp.rpc', '0', true);
end $$;

-- ================================================== публичные функции (RPC) ==
create or replace function public.cp_submit_application(p jsonb) returns bigint
language plpgsql security definer set search_path = public as $$
declare nick text; dc text; pos text; ans jsonb := '[]'::jsonb; e jsonb; new_id bigint; positions jsonb; srv text; srvs jsonb;
begin
  if coalesce((select value from public.cp_settings where key = 'app_open'), 'false'::jsonb) <> 'true'::jsonb then raise exception 'closed'; end if;
  perform public.cp_rate_check('app', 3, interval '1 hour');
  nick := trim(coalesce(p->>'nickname', '')); dc := trim(coalesce(p->>'discord', '')); pos := trim(coalesce(p->>'position', ''));
  select value into positions from public.cp_settings where key = 'app_positions';
  srv := upper(trim(coalesce(p->>'server', '')));
  select value into srvs from public.cp_settings where key = 'servers';
  if not exists (select 1 from jsonb_array_elements(coalesce(srvs, '[]'::jsonb)) x where upper(x->>'code') = srv) then raise exception 'bad_server'; end if;
  if length(nick) < 2 or length(nick) > 60 then raise exception 'bad_nickname'; end if;
  if length(dc) < 2 or length(dc) > 60 then raise exception 'bad_discord'; end if;
  if positions is not null and not (positions ? pos) then raise exception 'bad_position'; end if;
  if jsonb_typeof(p->'answers') = 'array' then
    for e in select * from jsonb_array_elements(p->'answers') limit 20 loop
      ans := ans || jsonb_build_array(jsonb_build_object('q', left(coalesce(e->>'q', ''), 300), 'a', left(coalesce(e->>'a', ''), 4000)));
    end loop;
  end if;
  insert into public.cp_applications (nickname, discord, position, server, answers) values (nick, dc, pos, srv, ans) returning id into new_id;
  return new_id;
end $$;

-- подача иска (можно без аккаунта). Номер ставит сервер: префикс суда и сквозной счётчик по суду
create or replace function public.cp_file_claim(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare cfg jsonb; crt jsonb; code text; filer text; ttl text; cat text; pl text; pls text; lw text; lic text; rel text; circ text; fee_ text; ct text;
  txt text; bb_ text; defs jsonb := '[]'::jsonb; stat text[] := '{}'; reqs jsonb := '[]'::jsonb; atts jsonb := '[]'::jsonb;
  e jsonb; s text; nm text; n bigint; no_ text; tr text; nid bigint;
begin
  perform public.cp_rate_check('claim', 5, interval '1 hour');
  code := upper(trim(coalesce(p->>'court', '')));
  select value into cfg from public.cp_settings where key = 'courts';
  select x into crt from jsonb_array_elements(coalesce(cfg, '[]'::jsonb)) x where upper(x->>'code') = code limit 1;
  if crt is null then raise exception 'bad_court'; end if;
  filer := coalesce(p->>'filer', '');
  if filer not in ('citizen','lawyer') then raise exception 'bad_filer'; end if;
  ttl := trim(coalesce(p->>'title', ''));
  if length(ttl) < 3 or length(ttl) > 200 then raise exception 'bad_title'; end if;
  cat := left(trim(coalesce(p->>'category', '')), 80);
  pl := trim(coalesce(p->>'plaintiff', '')); pls := trim(coalesce(p->>'plaintiff_static', ''));
  if length(pl) < 2 or length(pl) > 120 then raise exception 'bad_plaintiff'; end if;
  if pls !~ '^[0-9]{1,9}$' then raise exception 'bad_static'; end if;
  lw := left(trim(coalesce(p->>'lawyer', '')), 120); lic := left(trim(coalesce(p->>'license', '')), 30);
  if filer = 'lawyer' and (length(lw) < 2 or length(lic) < 1) then raise exception 'bad_lawyer'; end if;
  if filer = 'citizen' then lw := ''; lic := ''; end if;
  rel := left(trim(coalesce(p->>'related_no', '')), 30);
  circ := trim(coalesce(p->>'circumstances', ''));
  if length(circ) < 30 or length(circ) > 8000 then raise exception 'bad_text'; end if;
  ct := trim(coalesce(p->>'contacts', ''));
  if length(ct) < 2 or length(ct) > 120 then raise exception 'bad_contacts'; end if;
  fee_ := left(trim(coalesce(p->>'fee', '')), 120);

  if jsonb_typeof(p->'defendants') <> 'array' then raise exception 'bad_defendants'; end if;
  for e in select * from jsonb_array_elements(p->'defendants') limit 10 loop
    nm := trim(coalesce(e->>'name', '')); s := trim(coalesce(e->>'static', ''));
    if nm = '' and s = '' then continue; end if;
    if length(nm) < 2 or length(nm) > 120 then raise exception 'bad_defendants'; end if;
    if s !~ '^[0-9]{0,9}$' then raise exception 'bad_static'; end if;
    defs := defs || jsonb_build_array(jsonb_build_object('name', nm, 'static', s, 'org', left(trim(coalesce(e->>'org', '')), 120)));
    if s <> '' then stat := stat || s; end if;
  end loop;
  if jsonb_array_length(defs) = 0 then raise exception 'bad_defendants'; end if;

  if jsonb_typeof(p->'requests') <> 'array' then raise exception 'bad_requests'; end if;
  for e in select * from jsonb_array_elements(p->'requests') limit 15 loop
    s := trim(coalesce(e #>> '{}', ''));
    if s = '' then continue; end if;
    if length(s) > 1000 then raise exception 'bad_requests'; end if;
    reqs := reqs || to_jsonb(s);
  end loop;
  if jsonb_array_length(reqs) = 0 then raise exception 'bad_requests'; end if;

  if jsonb_typeof(p->'attachments') = 'array' then
    for e in select * from jsonb_array_elements(p->'attachments') limit 20 loop
      s := trim(coalesce(e->>'url', '')); nm := trim(coalesce(e->>'name', ''));
      if s = '' and nm = '' then continue; end if;
      if not public.cp_url_ok(s) then raise exception 'bad_url'; end if;
      atts := atts || jsonb_build_array(jsonb_build_object('name', left(coalesce(nullif(nm, ''), 'Материал'), 120), 'url', s));
    end loop;
  end if;

  bb_ := coalesce(p->>'bb', ''); txt := coalesce(p->>'text', '');
  if length(bb_) < 50 or length(bb_) > 30000 or length(txt) < 50 or length(txt) > 30000 then raise exception 'bad_text'; end if;

  n := public.cp_next('claim:' || code);
  no_ := code || '-' || n;
  tr := upper(substr(md5(random()::text || clock_timestamp()::text), 1, 8));
  insert into public.cp_claims (no, track, court, court_name, server, filer, category, title, plaintiff, plaintiff_static, lawyer, license, defendants, defendant_statics,
    related_no, circumstances, requests, attachments, fee, contacts, text, bb, user_id)
  values (no_, tr, code, coalesce(crt->>'name', code), coalesce(crt->>'server', ''), filer, cat, ttl, pl, pls, lw, lic, defs, stat,
    rel, circ, reqs, atts, fee_, ct, replace(txt, '{{NO}}', no_), replace(bb_, '{{NO}}', no_), auth.uid())
  returning id into nid;
  return jsonb_build_object('no', no_, 'track', tr);
end $$;

-- статус по коду (полный) или по номеру иска (без ответа суда и ссылки)
create or replace function public.cp_claim_lookup(code text) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'no', c.no, 'court', c.court_name, 'server', c.server, 'title', c.title, 'stage', c.stage, 'outcome', c.outcome,
    'created_at', c.created_at, 'decided_at', c.decided_at,
    'judge', (select nick from public.cp_profiles where id = c.judge_id),
    'hearing', (select jsonb_build_object('at', h.at, 'place', h.place) from public.cp_hearings h
                where h.claim_id = c.id and h.at >= now() - interval '2 hours' order by h.at limit 1),
    'own', c.track = upper(trim(code)),
    'note', case when c.track = upper(trim(code)) then c.public_note else '' end,
    'forum_url', case when c.track = upper(trim(code)) then c.forum_url else '' end)
  from public.cp_claims c
  where c.track = upper(trim(code)) or c.no = upper(trim(code))
  limit 1
$$;

-- заявитель прикрепляет ссылку на тему, которую создал на форуме
create or replace function public.cp_claim_set_link(code text, url text) returns boolean
language plpgsql security definer set search_path = public as $$
declare k text := upper(trim(code)); u text := trim(coalesce(url, ''));
begin
  perform public.cp_rate_check('link', 20, interval '1 hour');
  if u <> '' and not public.cp_url_ok(u) then raise exception 'bad_url'; end if;
  update public.cp_claims set forum_url = u where track = k or (no = k and user_id is not null and user_id = auth.uid());
  return found;
end $$;

-- «Мои иски»: где пользователь автор или его персонаж (по статику) истец либо ответчик
create or replace function public.cp_my_claims() returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(r order by r->>'created_at' desc), '[]'::jsonb) from (
    select jsonb_build_object(
      'id', c.id, 'no', c.no, 'court', c.court_name, 'server', c.server, 'title', c.title, 'stage', c.stage, 'outcome', c.outcome,
      'note', c.public_note, 'created_at', c.created_at, 'forum_url', c.forum_url,
      'role', case when c.user_id = auth.uid() then 'author' when c.plaintiff_static = any (public.cp_my_statics(c.server)) then 'plaintiff' else 'defendant' end,
      'track', case when c.user_id = auth.uid() then c.track end,
      'bb', case when c.user_id = auth.uid() then c.bb end,
      'judge', (select nick from public.cp_profiles where id = c.judge_id),
      'hearing', (select jsonb_build_object('at', h.at, 'place', h.place) from public.cp_hearings h
                  where h.claim_id = c.id and h.at >= now() - interval '2 hours' order by h.at limit 1),
      'materials', (select coalesce(jsonb_agg(jsonb_build_object('id', m.id, 'kind', m.kind, 'status', m.status, 'reason', m.reason, 'at', m.created_at) order by m.id), '[]'::jsonb)
                    from public.cp_materials m where m.claim_id = c.id and m.user_id = auth.uid())
    ) as r
    from public.cp_claims c
    where auth.uid() is not null
      and (c.user_id = auth.uid()
           or (c.plaintiff_static <> '' and c.plaintiff_static = any (public.cp_my_statics(c.server)))
           or c.defendant_statics && public.cp_my_statics(c.server))
    limit 100
  ) s
$$;

-- материал к иску: ходатайство, доказательства или отзыв ответчика
create or replace function public.cp_send_material(code text, kind text, body text, links jsonb default '[]'::jsonb) returns bigint
language plpgsql security definer set search_path = public as $$
declare cid bigint; uid uuid := auth.uid(); k text := upper(trim(code)); li jsonb := '[]'::jsonb; e jsonb; u text; b text := trim(coalesce(body, '')); nid bigint;
begin
  perform public.cp_rate_check('mat', 10, interval '1 hour');
  select c.id into cid from public.cp_claims c
  where c.track = k or (uid is not null and c.no = k and (c.user_id = uid
        or (c.plaintiff_static <> '' and c.plaintiff_static = any (public.cp_my_statics(c.server)))
        or c.defendant_statics && public.cp_my_statics(c.server)))
  limit 1;
  if cid is null then raise exception 'not_found'; end if;
  if kind not in ('motion','evidence','response') then raise exception 'bad_material'; end if;
  if length(b) < 5 or length(b) > 4000 then raise exception 'bad_material'; end if;
  if jsonb_typeof(links) = 'array' then
    for e in select * from jsonb_array_elements(links) limit 10 loop
      u := trim(coalesce(e #>> '{}', ''));
      if u = '' then continue; end if;
      if not public.cp_url_ok(u) then raise exception 'bad_url'; end if;
      li := li || to_jsonb(u);
    end loop;
  end if;
  insert into public.cp_materials (claim_id, user_id, kind, body, links) values (cid, uid, kind, b, li) returning id into nid;
  return nid;
end $$;

grant execute on function public.cp_submit_application(jsonb), public.cp_file_claim(jsonb), public.cp_claim_lookup(text),
  public.cp_claim_set_link(text, text), public.cp_send_material(text, text, text, jsonb) to anon, authenticated;
revoke execute on function public.cp_my_claims(), public.cp_test_webhook(text), public.cp_case_action(bigint, text, text) from public, anon;
grant execute on function public.cp_my_claims() to authenticated;
grant execute on function public.cp_test_webhook(text) to authenticated;
grant execute on function public.cp_case_action(bigint, text, text) to authenticated;

-- публичные решения: без поля person, если решение анонимное
create or replace view public.cp_decisions_public as
  select id, no, title, dt, verdict, case when anon then '' else person end as person, text, server
  from public.cp_decisions where public;
grant select on public.cp_decisions_public to anon, authenticated;

-- публичное расписание заседаний по искам (без названий и сторон)
create or replace view public.cp_hearings_public as
  select h.id, h.at, h.place, c.no, c.court_name as court, c.server
  from public.cp_hearings h join public.cp_claims c on c.id = h.claim_id
  where h.at >= now() - interval '2 days';
grant select on public.cp_hearings_public to anon, authenticated;

-- =========================================================== права доступа ==
alter table public.cp_profiles enable row level security;
alter table public.cp_settings enable row level security;
alter table public.cp_laws enable row level security;
alter table public.cp_counters enable row level security;
alter table public.cp_characters enable row level security;
alter table public.cp_claims enable row level security;
alter table public.cp_materials enable row level security;
alter table public.cp_claim_notes enable row level security;
alter table public.cp_pros_requests enable row level security;
alter table public.cp_cases enable row level security;
alter table public.cp_case_log enable row level security;
alter table public.cp_hearings enable row level security;
alter table public.cp_decisions enable row level security;
alter table public.cp_applications enable row level security;
alter table public.cp_webhooks enable row level security;
alter table public.cp_audit enable row level security;
alter table public.cp_rate enable row level security;

revoke all on public.cp_profiles, public.cp_counters, public.cp_characters, public.cp_claims, public.cp_materials, public.cp_claim_notes,
  public.cp_pros_requests, public.cp_cases, public.cp_case_log, public.cp_hearings, public.cp_decisions, public.cp_applications,
  public.cp_webhooks, public.cp_audit, public.cp_rate from anon;

do $$
declare t text;
begin
  for t in select policyname || '|' || tablename from pg_policies where schemaname = 'public' and tablename like 'cp\_%' loop
    execute format('drop policy %I on public.%I', split_part(t, '|', 1), split_part(t, '|', 2));
  end loop;
end $$;

-- профили: свой + все сотрудники видят сотрудников (нужно для назначений); admin видит всех
create policy cp_profiles_sel on public.cp_profiles for select to authenticated
  using (id = auth.uid() or public.cp_role() = 'admin' or (public.cp_is_staff() and role not in ('user','pending')));
create policy cp_profiles_upd on public.cp_profiles for update to authenticated
  using (id = auth.uid() or public.cp_role() = 'admin') with check (id = auth.uid() or public.cp_role() = 'admin');
create policy cp_profiles_del on public.cp_profiles for delete to authenticated using (public.cp_role() = 'admin');

-- настройки: публичные видят все, остальные сотрудники; запись — admin
create policy cp_settings_sel on public.cp_settings for select to anon, authenticated using (public or public.cp_is_staff());
create policy cp_settings_ins on public.cp_settings for insert to authenticated with check (public.cp_role() = 'admin');
create policy cp_settings_upd on public.cp_settings for update to authenticated using (public.cp_role() = 'admin') with check (public.cp_role() = 'admin');
create policy cp_settings_del on public.cp_settings for delete to authenticated using (public.cp_role() = 'admin');

-- законы: читают все, правят admin, председатель и судьи
create policy cp_laws_sel on public.cp_laws for select to anon, authenticated using (true);
create policy cp_laws_ins on public.cp_laws for insert to authenticated with check (public.cp_is_judge());
create policy cp_laws_upd on public.cp_laws for update to authenticated using (public.cp_is_judge()) with check (public.cp_is_judge());
create policy cp_laws_del on public.cp_laws for delete to authenticated using (public.cp_is_judge());

-- персонажи: свои
create policy cp_characters_all on public.cp_characters for all to authenticated
  using (user_id = auth.uid() or public.cp_role() = 'admin') with check (user_id = auth.uid());

-- иски: суд видит все; прокурор — только назначенные; ГП и ЗГП — те, по которым есть запрос суда.
-- Создаёт иски только функция cp_file_claim. Править: председатель/admin любой, судья — свободный или свой.
create policy cp_claims_sel on public.cp_claims for select to authenticated using (
  (public.cp_is_court() and public.cp_srv_ok(server)) or prosecutor_id = auth.uid()
  or (public.cp_role() = 'prosecutor_head' and public.cp_srv_ok(server) and exists (select 1 from public.cp_pros_requests r where r.claim_id = cp_claims.id)));
create policy cp_claims_upd on public.cp_claims for update to authenticated
  using (public.cp_srv_ok(server) and (public.cp_is_lead() or (public.cp_role() = 'judge' and (judge_id = auth.uid() or judge_id is null))))
  with check (public.cp_srv_ok(server) and (public.cp_is_lead() or (public.cp_role() = 'judge' and (judge_id = auth.uid() or judge_id is null))));
create policy cp_claims_del on public.cp_claims for delete to authenticated using (public.cp_role() = 'admin');

create policy cp_materials_sel on public.cp_materials for select to authenticated using (public.cp_is_court() and public.cp_srv_ok(public.cp_claim_server(claim_id)));
create policy cp_materials_upd on public.cp_materials for update to authenticated using (public.cp_is_judge() and public.cp_srv_ok(public.cp_claim_server(claim_id))) with check (public.cp_is_judge() and public.cp_srv_ok(public.cp_claim_server(claim_id)));
create policy cp_materials_del on public.cp_materials for delete to authenticated using (public.cp_role() = 'admin');

create policy cp_claim_notes_all on public.cp_claim_notes for all to authenticated using (public.cp_is_judge() and public.cp_srv_ok(public.cp_claim_server(claim_id))) with check (public.cp_is_judge() and public.cp_srv_ok(public.cp_claim_server(claim_id)));

-- запросы к прокуратуре: суд создаёт, ГП и ЗГП разбирают, прокурор видит свои и завершает участие
create policy cp_pros_sel on public.cp_pros_requests for select to authenticated using (
  ((public.cp_is_court() or public.cp_role() = 'prosecutor_head') and public.cp_srv_ok(public.cp_claim_server(claim_id))) or (public.cp_role() = 'prosecutor' and prosecutor_id = auth.uid()));
create policy cp_pros_ins on public.cp_pros_requests for insert to authenticated with check (public.cp_is_judge() and public.cp_srv_ok(public.cp_claim_server(claim_id)));
create policy cp_pros_upd on public.cp_pros_requests for update to authenticated
  using (public.cp_is_judge() or public.cp_role() = 'prosecutor_head' or prosecutor_id = auth.uid())
  with check (public.cp_is_judge() or public.cp_role() = 'prosecutor_head' or prosecutor_id = auth.uid());
create policy cp_pros_del on public.cp_pros_requests for delete to authenticated using (public.cp_role() = 'admin');

-- дела: каждое ведомство видит дела, которые у него, и те, что оно завело; движение — только через cp_case_action
create policy cp_cases_sel on public.cp_cases for select to authenticated using (
  public.cp_role() = 'admin' or (public.cp_srv_ok(server) and (
    (public.cp_is_court() and holder = 'court')
    or (public.cp_role() in ('iid','iid_head') and (holder = 'iid' or org = 'iid'))
    or (public.cp_role() in ('prosecutor','prosecutor_head') and (holder = 'prosecutor' or org = 'prosecutor')))));
create policy cp_cases_ins on public.cp_cases for insert to authenticated with check (
  public.cp_role() = 'admin' or (public.cp_srv_ok(server) and (
    (public.cp_is_court() and org = 'court')
    or (public.cp_role() in ('iid','iid_head') and org = 'iid' and holder = 'iid')
    or (public.cp_role() in ('prosecutor','prosecutor_head') and org = 'prosecutor' and holder = 'prosecutor'))));
create policy cp_cases_upd on public.cp_cases for update to authenticated using (
  public.cp_role() = 'admin' or (public.cp_srv_ok(server) and (
  (public.cp_is_court() and holder = 'court')
  or (public.cp_role() in ('iid','iid_head') and holder = 'iid' and flow in ('draft','returned') and (created_by = auth.uid() or public.cp_role() = 'iid_head'))
  or (public.cp_role() in ('prosecutor','prosecutor_head') and holder = 'prosecutor' and flow in ('draft','returned') and (created_by = auth.uid() or public.cp_role() = 'prosecutor_head')))))
  with check (true);
create policy cp_cases_del on public.cp_cases for delete to authenticated using (public.cp_role() = 'admin');

create policy cp_case_log_sel on public.cp_case_log for select to authenticated
  using (exists (select 1 from public.cp_cases c where c.id = cp_case_log.case_id));

-- заседания: суд; назначенный прокурор видит заседания своего иска
create policy cp_hearings_sel on public.cp_hearings for select to authenticated using (
  (public.cp_is_court() and public.cp_srv_ok(coalesce(public.cp_claim_server(claim_id), public.cp_case_server(case_id))))
  or exists (select 1 from public.cp_claims c where c.id = cp_hearings.claim_id and c.prosecutor_id = auth.uid()));
create policy cp_hearings_ins on public.cp_hearings for insert to authenticated with check (public.cp_is_court() and public.cp_srv_ok(coalesce(public.cp_claim_server(claim_id), public.cp_case_server(case_id))));
create policy cp_hearings_upd on public.cp_hearings for update to authenticated using (public.cp_is_court() and public.cp_srv_ok(coalesce(public.cp_claim_server(claim_id), public.cp_case_server(case_id)))) with check (public.cp_is_court());
create policy cp_hearings_del on public.cp_hearings for delete to authenticated using (public.cp_is_court() and public.cp_srv_ok(coalesce(public.cp_claim_server(claim_id), public.cp_case_server(case_id))));

-- решения и заявки на работу
create policy cp_decisions_sel on public.cp_decisions for select to authenticated using (public.cp_is_court() and public.cp_srv_ok(server));
create policy cp_decisions_ins on public.cp_decisions for insert to authenticated with check (public.cp_is_judge());
create policy cp_decisions_upd on public.cp_decisions for update to authenticated using (public.cp_is_judge() and public.cp_srv_ok(server)) with check (public.cp_is_judge());
create policy cp_decisions_del on public.cp_decisions for delete to authenticated using (public.cp_role() = 'admin');

create policy cp_apps_sel on public.cp_applications for select to authenticated using (public.cp_is_judge() and public.cp_srv_ok(server));
create policy cp_apps_upd on public.cp_applications for update to authenticated using (public.cp_is_judge() and public.cp_srv_ok(server)) with check (public.cp_is_judge());
create policy cp_apps_del on public.cp_applications for delete to authenticated using (public.cp_role() = 'admin');

-- вебхуки и журнал: только admin
create policy cp_webhooks_all on public.cp_webhooks for all to authenticated using (public.cp_role() = 'admin') with check (public.cp_role() = 'admin');
create policy cp_audit_sel on public.cp_audit for select to authenticated using (public.cp_role() = 'admin');
