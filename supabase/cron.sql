-- ============================================================================
-- Senko Assistant · расписание (этап 3)
-- Раз в минуту база вызывает функцию senko: отложенные команды (/in), ежедневная сводка (/summary).
-- Перед запуском:
--   1) Edge Functions → Secrets: добавьте CRON_SECRET — длинная случайная строка (латиница и цифры).
--   2) Ниже замените ВСТАВЬТЕ_CRON_SECRET на то же значение.
-- Затем SQL Editor → New query → вставить → Run. Повторный запуск безопасен: задание пересоздаётся.
-- ============================================================================
create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.unschedule('senko-tick') where exists (select 1 from cron.job where jobname = 'senko-tick');

select cron.schedule(
  'senko-tick',
  '* * * * *',
  $$
  select net.http_post(
    url     := 'https://wcjspwailippjmyffkei.supabase.co/functions/v1/senko',
    headers := jsonb_build_object('content-type', 'application/json', 'x-senko-cron', 'ВСТАВЬТЕ_CRON_SECRET'),
    body    := '{"action":"tick"}'::jsonb
  );
  $$
);

-- Проверка: select * from cron.job_run_details order by start_time desc limit 5;
-- Выключить: select cron.unschedule('senko-tick');
