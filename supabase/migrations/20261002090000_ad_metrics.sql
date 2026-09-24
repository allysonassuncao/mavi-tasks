begin;

-- Campanhas: os números de cada ciclo, como no MASO.
--  * ad_daily_metrics: um registro por ciclo por dia (MASO:
--    maso_acompanhamento_registro_diario), com o M do ciclo naquele dia.
--  * ad_cycle_snapshots: o acumulado do ciclo, do início até o dia anterior,
--    tirado uma vez por dia (MASO: maso_acompanhamento_registro tipo 0). O
--    alcance e a frequência só são corretos no acumulado (não se somam dias).
-- Uma sincronização diária (/api/ads-sync, chamada pelo banco com pg_cron,
-- como as notificações push) lê o Meta e o Google e grava aqui,
-- reprocessando os últimos 7 dias. Os registros antigos do MASO entram pelo
-- script scripts/import-maso-campaigns.mjs (origem 'maso').
-- Leitura: só administradores (o módulo é exclusivo deles).

create table public.ad_daily_metrics (
 id bigint generated always as identity primary key,
 company_id uuid not null,
 campaign_id uuid not null,
 cycle_id uuid not null,
 day date not null,
 -- The cycle's M when the day was recorded (MASO copied it the same way).
 multiplier numeric(6,3) not null check (multiplier > 0 and multiplier <= 100),
 spend numeric(14,2) not null default 0 check (spend >= 0),
 impressions bigint not null default 0 check (impressions >= 0),
 reach bigint not null default 0 check (reach >= 0),
 clicks bigint not null default 0 check (clicks >= 0),
 conversions numeric(14,2) not null default 0 check (conversions >= 0),
 -- Sales funnel (objectives sale and custom).
 view_content numeric(14,2) not null default 0 check (view_content >= 0),
 add_to_cart numeric(14,2) not null default 0 check (add_to_cart >= 0),
 initiate_checkout numeric(14,2) not null default 0 check (initiate_checkout >= 0),
 source text not null check (source in ('meta','google','maso','manual')),
 synced_at timestamptz not null default now(),
 unique (company_id, cycle_id, day),
 foreign key (company_id, campaign_id, cycle_id) references public.ad_cycles(company_id, campaign_id, id)
  on delete cascade
);
create index ad_daily_metrics_campaign on public.ad_daily_metrics(company_id, campaign_id, day);

create table public.ad_cycle_snapshots (
 id bigint generated always as identity primary key,
 company_id uuid not null,
 campaign_id uuid not null,
 cycle_id uuid not null,
 -- The day it was taken; the numbers go up to the day before.
 taken_on date not null,
 period_start date not null,
 period_end date not null,
 spend numeric(14,2) not null default 0 check (spend >= 0),
 impressions bigint not null default 0 check (impressions >= 0),
 reach bigint not null default 0 check (reach >= 0),
 clicks bigint not null default 0 check (clicks >= 0),
 conversions numeric(14,2) not null default 0 check (conversions >= 0),
 view_content numeric(14,2) not null default 0 check (view_content >= 0),
 add_to_cart numeric(14,2) not null default 0 check (add_to_cart >= 0),
 initiate_checkout numeric(14,2) not null default 0 check (initiate_checkout >= 0),
 -- Bom/Ruim against the cycle's goal when it was taken (null: no goal).
 goal_status text check (goal_status in ('good','bad')),
 source text not null check (source in ('meta','google','maso','manual')),
 -- Who took it, as a label (the MASO's robot or analyst on imported rows).
 author_label text not null default '' check (length(author_label) <= 120),
 created_at timestamptz not null default now(),
 check (period_end >= period_start),
 unique (company_id, cycle_id, taken_on),
 foreign key (company_id, campaign_id, cycle_id) references public.ad_cycles(company_id, campaign_id, id)
  on delete cascade
);
create index ad_cycle_snapshots_campaign on public.ad_cycle_snapshots(company_id, campaign_id, taken_on);

-- Each attempt to sync a cycle: when, how it went and why not.
create table public.ad_sync_runs (
 id bigint generated always as identity primary key,
 company_id uuid not null,
 campaign_id uuid not null,
 cycle_id uuid not null,
 trigger text not null check (trigger in ('schedule','manual')),
 status text not null check (status in ('ok','error')),
 message text not null default '' check (length(message) <= 1000),
 days integer not null default 0,
 created_at timestamptz not null default now(),
 foreign key (company_id, campaign_id, cycle_id) references public.ad_cycles(company_id, campaign_id, id)
  on delete cascade
);
create index ad_sync_runs_cycle on public.ad_sync_runs(company_id, cycle_id, created_at desc);

alter table public.ad_daily_metrics enable row level security;
alter table public.ad_cycle_snapshots enable row level security;
alter table public.ad_sync_runs enable row level security;
create policy ad_daily_metrics_read on public.ad_daily_metrics for select to authenticated using (
 company_id in (select mavi_private.admin_companies()));
create policy ad_cycle_snapshots_read on public.ad_cycle_snapshots for select to authenticated using (
 company_id in (select mavi_private.admin_companies()));
create policy ad_sync_runs_read on public.ad_sync_runs for select to authenticated using (
 company_id in (select mavi_private.admin_companies()));
revoke all on public.ad_daily_metrics, public.ad_cycle_snapshots, public.ad_sync_runs from anon, authenticated;
grant select on public.ad_daily_metrics, public.ad_cycle_snapshots, public.ad_sync_runs to authenticated;

-- Where the database calls the sync, and the secret proving it's us (the
-- ADS_SYNC_SECRET set on Vercel). Setup, once:
--   insert into mavi_private.ad_sync_config(url, secret)
--   values ('https://workspace.maso.app.br/api/ads-sync', '<ADS_SYNC_SECRET>');
-- and supabase/operations/schedule-ads-sync.sql for the schedule.
create table mavi_private.ad_sync_config (
 id boolean primary key default true check (id),
 url text not null check (url ~ '^https://'),
 secret text not null check (length(secret) >= 32)
);
alter table mavi_private.ad_sync_config enable row level security;
revoke all on mavi_private.ad_sync_config from public, anon, authenticated;

-- The schedule's secret, or an administrator of the company.
create function mavi_private.ad_sync_allowed(p_secret text, c uuid) returns boolean
language sql stable security definer set search_path = '' as $$
 select (p_secret is not null and exists (select 1 from mavi_private.ad_sync_config where id and secret = p_secret))
  or (c is not null and mavi_private.admin(c))
$$;
revoke all on function mavi_private.ad_sync_allowed(text, uuid) from public, anon, authenticated;

-- What to sync: cycles of Meta and Google campaigns (not archived) with
-- links, running or ended in the last 7 days, not synced today yet — oldest
-- first, a few per call. With a campaign (the "Sincronizar agora" button of
-- an administrator), that campaign's cycles in the window, synced or not.
-- Comes with the links and the encrypted tokens (useless without the
-- server's key).
create function public.ad_sync_targets(p_secret text, p_campaign uuid default null, p_limit integer default 15)
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_company uuid; result jsonb; begin
 if p_campaign is not null then
  select company_id into v_company from public.ad_campaigns where id = p_campaign;
  if v_company is null or not mavi_private.ad_sync_allowed(p_secret, v_company) then
   raise exception 'Sem permissão' using errcode = '42501';
  end if;
 elsif not mavi_private.ad_sync_allowed(p_secret, null) then
  raise exception 'Sem permissão' using errcode = '42501';
 end if;
 select coalesce(jsonb_agg(t order by t.last_run nulls first), '[]') into result from (
  select y.id as cycle_id, y.company_id, a.id as campaign_id, a.platform, y.objective, y.destination,
   y.start_date, y.end_date, y.goal_results, y.budget, y.multiplier,
   mavi_private.company_today(y.company_id) as today,
   (select max(d.day) from public.ad_daily_metrics d where d.company_id = y.company_id and d.cycle_id = y.id
     and d.source in ('meta','google')) as last_day,
   (select max(r.created_at) from public.ad_sync_runs r where r.company_id = y.company_id and r.cycle_id = y.id) as last_run,
   (select jsonb_agg(jsonb_build_object('account_id', k.account_id, 'campaign_id', k.external_campaign_id,
     'manager_id', k.manager_id) order by k.account_id, k.external_campaign_id)
    from public.ad_cycle_links k where k.company_id = y.company_id and k.cycle_id = y.id) as links,
   case when a.platform = 'meta' then (select jsonb_object_agg(m.account_id, jsonb_build_object(
     'token_cipher', m.token_cipher, 'expires_at', m.token_expires_at))
    from mavi_private.ad_meta_accounts m where m.company_id = y.company_id and m.account_id in
     (select k.account_id from public.ad_cycle_links k where k.company_id = y.company_id and k.cycle_id = y.id)) end
    as meta_tokens,
   case when a.platform = 'google' then (select jsonb_build_object('refresh_token_cipher', g.refresh_token_cipher)
    from mavi_private.ad_google_connections g where g.company_id = y.company_id) end as google_token
  from public.ad_cycles y
  join public.ad_campaigns a on a.company_id = y.company_id and a.id = y.campaign_id
  where a.platform in ('meta','google') and not a.archived
   and (p_campaign is null or a.id = p_campaign)
   and exists (select 1 from public.ad_cycle_links k where k.company_id = y.company_id and k.cycle_id = y.id)
   and y.start_date < mavi_private.company_today(y.company_id)
   and y.end_date >= mavi_private.company_today(y.company_id) - 8
   and (p_campaign is not null or not exists (select 1 from public.ad_sync_runs r where r.company_id = y.company_id
     and r.cycle_id = y.id and r.created_at >= (mavi_private.company_today(y.company_id))::timestamp))
  limit greatest(least(coalesce(p_limit, 15), 50), 1)
 ) t;
 return result;
end $$;

-- Stores a cycle's sync: the days read ([{day, spend, impressions, reach,
-- clicks, conversions, view_content, add_to_cart, initiate_checkout}],
-- replacing what the platform said before for those days), the cycle's
-- snapshot of the day, and the run. With an error, only the run.
create function public.ad_sync_store(p_secret text, p_cycle uuid, p_trigger text, p_status text,
 p_message text default '', p_days jsonb default '[]', p_snapshot jsonb default null) returns integer
language plpgsql security definer set search_path = '' as $$
declare y public.ad_cycles; a public.ad_campaigns; d jsonb; n integer := 0; v_source text; s jsonb;
 v_status text; v_net numeric; begin
 select * into y from public.ad_cycles where id = p_cycle;
 if not found or not mavi_private.ad_sync_allowed(p_secret, y.company_id) then
  raise exception 'Sem permissão' using errcode = '42501';
 end if;
 select * into a from public.ad_campaigns where company_id = y.company_id and id = y.campaign_id;
 v_source := a.platform;
 if p_status = 'ok' then
  if jsonb_typeof(coalesce(p_days, '[]')) <> 'array' then raise exception 'Dias inválidos' using errcode = '22023'; end if;
  for d in select * from jsonb_array_elements(coalesce(p_days, '[]')) loop
   continue when (d ->> 'day')::date < y.start_date or (d ->> 'day')::date > y.end_date;
   insert into public.ad_daily_metrics(company_id, campaign_id, cycle_id, day, multiplier, spend, impressions, reach,
    clicks, conversions, view_content, add_to_cart, initiate_checkout, source)
   values (y.company_id, y.campaign_id, y.id, (d ->> 'day')::date, y.multiplier,
    round(greatest(coalesce((d ->> 'spend')::numeric, 0), 0), 2), greatest(coalesce((d ->> 'impressions')::bigint, 0), 0),
    greatest(coalesce((d ->> 'reach')::bigint, 0), 0), greatest(coalesce((d ->> 'clicks')::bigint, 0), 0),
    round(greatest(coalesce((d ->> 'conversions')::numeric, 0), 0), 2),
    round(greatest(coalesce((d ->> 'view_content')::numeric, 0), 0), 2),
    round(greatest(coalesce((d ->> 'add_to_cart')::numeric, 0), 0), 2),
    round(greatest(coalesce((d ->> 'initiate_checkout')::numeric, 0), 0), 2), v_source)
   on conflict (company_id, cycle_id, day) do update set spend = excluded.spend, impressions = excluded.impressions,
    reach = excluded.reach, clicks = excluded.clicks, conversions = excluded.conversions,
    view_content = excluded.view_content, add_to_cart = excluded.add_to_cart,
    initiate_checkout = excluded.initiate_checkout, source = excluded.source, synced_at = now()
   -- A day typed in by hand is kept; the platform's M of the day too.
   where public.ad_daily_metrics.source <> 'manual';
   n := n + 1;
  end loop;
  s := p_snapshot;
  if s is not null and jsonb_typeof(s) = 'object' then
   -- Bom when there are results at or below the goal's cost (net of M).
   v_net := y.budget / y.multiplier;
   v_status := case when y.goal_results <= 0 then null
    when coalesce((s ->> 'conversions')::numeric, 0) > 0
     and coalesce((s ->> 'spend')::numeric, 0) / (s ->> 'conversions')::numeric <= v_net / y.goal_results then 'good'
    else 'bad' end;
   insert into public.ad_cycle_snapshots(company_id, campaign_id, cycle_id, taken_on, period_start, period_end,
    spend, impressions, reach, clicks, conversions, view_content, add_to_cart, initiate_checkout, goal_status,
    source, author_label)
   values (y.company_id, y.campaign_id, y.id, mavi_private.company_today(y.company_id), y.start_date,
    least(greatest((s ->> 'period_end')::date, y.start_date), y.end_date),
    round(greatest(coalesce((s ->> 'spend')::numeric, 0), 0), 2), greatest(coalesce((s ->> 'impressions')::bigint, 0), 0),
    greatest(coalesce((s ->> 'reach')::bigint, 0), 0), greatest(coalesce((s ->> 'clicks')::bigint, 0), 0),
    round(greatest(coalesce((s ->> 'conversions')::numeric, 0), 0), 2),
    round(greatest(coalesce((s ->> 'view_content')::numeric, 0), 0), 2),
    round(greatest(coalesce((s ->> 'add_to_cart')::numeric, 0), 0), 2),
    round(greatest(coalesce((s ->> 'initiate_checkout')::numeric, 0), 0), 2), v_status, v_source,
    case when p_trigger = 'manual' then 'Sincronização manual' else 'Sincronização diária' end)
   on conflict (company_id, cycle_id, taken_on) do update set period_end = excluded.period_end,
    spend = excluded.spend, impressions = excluded.impressions, reach = excluded.reach, clicks = excluded.clicks,
    conversions = excluded.conversions, view_content = excluded.view_content, add_to_cart = excluded.add_to_cart,
    initiate_checkout = excluded.initiate_checkout, goal_status = excluded.goal_status,
    author_label = excluded.author_label, created_at = now()
   where public.ad_cycle_snapshots.source <> 'maso';
  end if;
 end if;
 insert into public.ad_sync_runs(company_id, campaign_id, cycle_id, trigger, status, message, days)
 values (y.company_id, y.campaign_id, y.id, case when p_trigger = 'manual' then 'manual' else 'schedule' end,
  case when p_status = 'ok' then 'ok' else 'error' end, left(coalesce(p_message, ''), 1000), n);
 return n;
end $$;

-- Called by pg_cron (supabase/operations/schedule-ads-sync.sql): asks the
-- server to sync the next cycles.
create function mavi_private.ad_sync_kick() returns void
language plpgsql security definer set search_path = '' as $$
declare cfg mavi_private.ad_sync_config; begin
 select * into cfg from mavi_private.ad_sync_config where id;
 if not found then return; end if;
 perform net.http_post(url := cfg.url, body := '{}'::jsonb,
  headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || cfg.secret),
  timeout_milliseconds := 60000);
end $$;
revoke all on function mavi_private.ad_sync_kick() from public, anon, authenticated;

revoke all on function public.ad_sync_targets(text, uuid, integer),
 public.ad_sync_store(text, uuid, text, text, text, jsonb, jsonb) from public, anon, authenticated;
-- anon: the server calling back for the schedule, with the secret.
grant execute on function public.ad_sync_targets(text, uuid, integer),
 public.ad_sync_store(text, uuid, text, text, text, jsonb, jsonb) to anon, authenticated;

commit;
