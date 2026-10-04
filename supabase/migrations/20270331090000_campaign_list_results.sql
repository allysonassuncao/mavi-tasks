begin;

-- Campanhas › lista: os resultados e o custo por resultado de cada campanha
-- (pedido de 04/10/2026) — hoje ao vivo, ontem e o ciclo — sem deixar a
-- lista mais lenta:
--  - ontem e o ciclo vêm do que a sincronização da manhã já grava
--    (ad_daily_metrics e o último acumulado de ad_cycle_snapshots, a mesma
--    conta do cabeçalho da campanha);
--  - hoje vem de ad_today_metrics, preenchida em segundo plano por um leitor
--    agendado (POST /api/ads-sync com {"today": true}): uma leitura por conta
--    de anúncios (todas as campanhas da conta numa chamada), o Meta a cada
--    hora e o Google a cada duas, das 7h ao fim do dia (hora da empresa).
--    A lista só lê o banco; ao gravar, as telas abertas recarregam (Realtime).
--  - Contas pausadas pela cota (mavi_private.ad_api_cooldowns, as mesmas dos
--    Insights da MAVI) ficam de fora até liberar; um erro de limite pausa.
--
-- O agendamento: supabase/operations/schedule-ads-today.sql.

-- ------------------------------------------------------------ hoje
-- A última leitura de hoje de cada campanha (uma linha por campanha). day
-- nulo: ainda não houve leitura boa (só a tentativa, com o erro).
create table public.ad_today_metrics (
 company_id uuid not null,
 campaign_id uuid not null,
 cycle_id uuid not null,
 day date,
 multiplier numeric(6,3) not null default 1 check (multiplier > 0 and multiplier <= 100),
 spend numeric(14,2) not null default 0 check (spend >= 0),
 conversions numeric(14,2) not null default 0 check (conversions >= 0),
 clicks bigint not null default 0 check (clicks >= 0),
 impressions bigint not null default 0 check (impressions >= 0),
 read_at timestamptz,
 tried_at timestamptz not null default now(),
 error text check (length(error) <= 500),
 primary key (company_id, campaign_id),
 foreign key (company_id, campaign_id, cycle_id) references public.ad_cycles(company_id, campaign_id, id)
  on delete cascade
);
alter table public.ad_today_metrics enable row level security;
revoke all on public.ad_today_metrics from public, anon, authenticated;

-- Os ciclos que o leitor deve ler agora: o ciclo atual (que cobre hoje) das
-- campanhas ativas do Meta e do Google com vínculos, a partir das 7h, quando
-- a última tentativa passou do intervalo da plataforma e nenhuma conta do
-- ciclo está pausada pela cota.
create function mavi_private.ad_today_due() returns table(cycle_id uuid, tried_at timestamptz)
language sql stable security definer set search_path = '' as $$
 select y.id, x.tried_at
 from public.ad_campaigns a
 join public.ad_cycles y on y.company_id = a.company_id and y.id = a.current_cycle_id
 left join public.ad_today_metrics x on x.company_id = a.company_id and x.campaign_id = a.id
 where a.status = 'active' and not a.archived and a.platform in ('meta', 'google')
  and y.start_date <= mavi_private.company_today(a.company_id)
  and y.end_date >= mavi_private.company_today(a.company_id)
  and extract(hour from now() at time zone mavi_private.company_tz(a.company_id)) >= 7
  and exists (select 1 from public.ad_cycle_links k where k.company_id = y.company_id and k.cycle_id = y.id)
  -- Lida (ou tentada, com erro) há pouco: espera o intervalo.
  and (x.tried_at is null
   or x.tried_at < now() - case a.platform when 'google' then interval '115 minutes' else interval '55 minutes' end)
  and mavi_private.campaign_insight_paused(a.platform, array(select k.account_id from public.ad_cycle_links k
   where k.company_id = y.company_id and k.cycle_id = y.id)) is null
$$;
revoke all on function mavi_private.ad_today_due() from public, anon, authenticated;

-- O que ler (com o segredo do agendamento): como ad_sync_targets, só o dia de
-- hoje, os mais antigos primeiro. O servidor junta os ciclos por conta.
create function public.ad_today_targets(p_secret text, p_limit integer default 300) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare result jsonb; begin
 if not mavi_private.ad_sync_allowed(p_secret, null) then
  raise exception 'Sem permissão' using errcode = '42501';
 end if;
 select coalesce(jsonb_agg(t order by t.tried_at nulls first), '[]') into result from (
  select d.tried_at, y.id as cycle_id, y.company_id, a.id as campaign_id, a.platform, y.objective, y.destination,
   y.start_date, y.end_date, y.multiplier, y.landing_pages, y.conversion_actions, y.meta_conversions,
   mavi_private.company_today(y.company_id) as today,
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
  from mavi_private.ad_today_due() d
  join public.ad_cycles y on y.id = d.cycle_id
  join public.ad_campaigns a on a.company_id = y.company_id and a.id = y.campaign_id
  order by d.tried_at nulls first, y.id
  limit greatest(least(coalesce(p_limit, 300), 1000), 1)
 ) t;
 return result;
end $$;

-- Grava a leitura: os números de cada ciclo lido ({cycle_id, day, spend,
-- conversions, clicks, impressions}; os cadastros das páginas da Make do dia
-- entram aqui, dos que a Make já enviou), as tentativas que falharam
-- ({cycle_id, error}) e as contas que a cota pausou ({platform, account,
-- until, reason}). As telas abertas recarregam.
create function public.ad_today_store(p_secret text, p_rows jsonb default '[]', p_errors jsonb default '[]',
 p_cooldowns jsonb default '[]') returns integer
language plpgsql security definer set search_path = '' as $$
declare r jsonb; y public.ad_cycles; v_day date; v_make numeric; n integer := 0; v_companies uuid[] := '{}'; c uuid; begin
 if not mavi_private.ad_sync_allowed(p_secret, null) then
  raise exception 'Sem permissão' using errcode = '42501';
 end if;
 for r in select * from jsonb_array_elements(case jsonb_typeof(p_rows) when 'array' then p_rows else '[]' end) loop
  select * into y from public.ad_cycles where id = (r->>'cycle_id')::uuid;
  continue when not found;
  v_day := coalesce((r->>'day')::date, mavi_private.company_today(y.company_id));
  -- A página de captura da Make: os cadastros do dia (cada pessoa uma vez).
  v_make := case when y.destination = 'make_landing_page' and y.objective not in ('traffic', 'engagement')
   then (select count(distinct (l.squeeze, l.lead)) from mavi_private.make_capture_leads l
    where l.squeeze = any(y.landing_pages) and l.day = v_day) else 0 end;
  insert into public.ad_today_metrics as x(company_id, campaign_id, cycle_id, day, multiplier, spend, conversions,
   clicks, impressions, read_at, tried_at, error)
  values (y.company_id, y.campaign_id, y.id, v_day, y.multiplier,
   round(greatest(coalesce((r->>'spend')::numeric, 0), 0), 2),
   round(greatest(coalesce((r->>'conversions')::numeric, 0), 0) + v_make, 2),
   greatest(coalesce((r->>'clicks')::numeric, 0), 0)::bigint,
   greatest(coalesce((r->>'impressions')::numeric, 0), 0)::bigint, now(), now(), null)
  on conflict (company_id, campaign_id) do update set cycle_id = excluded.cycle_id, day = excluded.day,
   multiplier = excluded.multiplier, spend = excluded.spend, conversions = excluded.conversions,
   clicks = excluded.clicks, impressions = excluded.impressions, read_at = excluded.read_at,
   tried_at = excluded.tried_at, error = null;
  n := n + 1;
  if not y.company_id = any(v_companies) then v_companies := v_companies || y.company_id; end if;
 end loop;
 for r in select * from jsonb_array_elements(case jsonb_typeof(p_errors) when 'array' then p_errors else '[]' end) loop
  select * into y from public.ad_cycles where id = (r->>'cycle_id')::uuid;
  continue when not found;
  -- A última leitura boa continua na lista; só a tentativa e o erro mudam.
  insert into public.ad_today_metrics as x(company_id, campaign_id, cycle_id, multiplier, tried_at, error)
  values (y.company_id, y.campaign_id, y.id, y.multiplier, now(), left(coalesce(r->>'error', 'Erro na leitura.'), 500))
  on conflict (company_id, campaign_id) do update set tried_at = excluded.tried_at, error = excluded.error;
 end loop;
 for r in select * from jsonb_array_elements(case jsonb_typeof(p_cooldowns) when 'array' then p_cooldowns else '[]' end) loop
  continue when coalesce(r->>'platform', '') not in ('meta', 'google') or coalesce(r->>'account', '') = ''
   or (r->>'until') is null;
  insert into mavi_private.ad_api_cooldowns as k(platform, account_id, until, reason, updated_at)
  values (r->>'platform', left(r->>'account', 60), least((r->>'until')::timestamptz, now() + interval '1 day'),
   left(coalesce(r->>'reason', ''), 300), now())
  on conflict (platform, account_id) do update set until = greatest(k.until, excluded.until),
   reason = excluded.reason, updated_at = now();
 end loop;
 foreach c in array v_companies loop
  perform mavi_private.broadcast(c, jsonb_build_object('kind', 'campaign_today'));
 end loop;
 return n;
end $$;

revoke all on function public.ad_today_targets(text, integer), public.ad_today_store(text, jsonb, jsonb, jsonb)
 from public, anon, authenticated;
-- anon: o servidor chamando de volta para o agendamento, com o segredo.
grant execute on function public.ad_today_targets(text, integer), public.ad_today_store(text, jsonb, jsonb, jsonb)
 to anon, authenticated;

-- Chamado pelo pg_cron: acorda o leitor só quando há o que ler.
create function mavi_private.ad_today_kick() returns void
language plpgsql security definer set search_path = '' as $$
declare cfg mavi_private.ad_sync_config; begin
 select * into cfg from mavi_private.ad_sync_config where id;
 if not found then return; end if;
 if not exists (select 1 from mavi_private.ad_today_due()) then return; end if;
 perform net.http_post(url := cfg.url, body := '{"today": true}'::jsonb,
  headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || cfg.secret),
  timeout_milliseconds := 60000);
end $$;
revoke all on function mavi_private.ad_today_kick() from public, anon, authenticated;

-- ------------------------------------------------------------ lista
-- A da migração 20270301090000_campaign_shared_day, com os resultados (hoje,
-- ontem e o ciclo) de cada campanha da página.
create or replace function public.ad_campaign_page(p_company uuid, p_scope text default 'active', p_search text default '',
 p_platform text default '', p_attention boolean default false, p_limit integer default 25, p_offset integer default 0)
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare t date; term text := mavi_private.fold(trim(coalesce(p_search, ''))); result jsonb; v_clients uuid[]; begin
 perform mavi_private.ad_require_reader(p_company);
 v_clients := case when mavi_private.leader(p_company) then null else mavi_private.served_clients(p_company) end;
 t := mavi_private.company_today(p_company);
 with scoped as (
  select a.*, cl.name as client_name, p.name as product_name,
   a.status = 'inactive' and a.legacy_id is null and a.created_at > now() - interval '60 days'
    and not exists (select 1 from public.ad_campaign_events e
     where e.company_id = a.company_id and e.campaign_id = a.id and e.action = 'status') as waiting
  from public.ad_campaigns a
  join public.contracts k on k.company_id = a.company_id and k.id = a.contract_id
  join public.clients cl on cl.company_id = k.company_id and cl.id = k.client_id
  join public.products p on p.company_id = k.company_id and p.id = k.product_id
  where a.company_id = p_company and not a.archived
   and (v_clients is null or k.client_id = any(v_clients))
 ), statused as (
  select s.* from scoped s
  where case coalesce(p_scope, 'active')
    when 'pending' then s.waiting
    when 'inactive' then s.status = 'inactive'
    when 'all' then true
    else s.status = 'active' end
 ), alerts as (
  -- Only what the alert needs, for every campaign of the scope (the counts
  -- and the "atenção" filter); the cycles' data only for the page below.
  select s.*, cur.end_date as current_end,
   -- Uma inativa (fora as novas aguardando ativação) não tem alerta de ciclo.
   case when s.status = 'inactive' and not s.waiting then 'none'
    when not exists (select 1 from public.ad_cycles y
     where y.company_id = s.company_id and y.campaign_id = s.id) then 'no_cycle'
    when cur.end_date is null then 'no_current'
    when t > cur.end_date then 'ended'
    when t = cur.end_date then 'ends_today'
    when cur.end_date - t + 1 <= 10 and not exists (select 1 from public.ad_cycles y
     where y.company_id = s.company_id and y.campaign_id = s.id and y.id <> s.current_cycle_id
      and y.start_date >= cur.end_date and y.start_date > cur.start_date) then 'ending'
    else 'none' end as alert_kind
  from statused s
  left join public.ad_cycles cur on cur.company_id = s.company_id and cur.id = s.current_cycle_id
 ), filtered as (
  select a.* from alerts a
  where (term = '' or strpos(mavi_private.fold(a.name || ' ' || a.client_name), term) > 0)
   and (coalesce(p_platform, '') = '' or a.platform = p_platform)
   and (not coalesce(p_attention, false) or a.alert_kind <> 'none')
 ), sliced as (
  select f.* from filtered f
  order by (f.status <> 'active'), mavi_private.fold(f.client_name), mavi_private.fold(f.name), f.id
  limit greatest(least(coalesce(p_limit, 25), 100), 1) offset greatest(coalesce(p_offset, 0), 0)
 ), page as (
  select f.*,
   (select to_jsonb(y) from public.ad_cycles y where y.company_id = f.company_id and y.id = f.current_cycle_id) as current,
   (select to_jsonb(y) from public.ad_cycles y where y.company_id = f.company_id and y.campaign_id = f.id
     and f.current_end is not null and y.id <> f.current_cycle_id and y.start_date >= f.current_end
     and y.start_date > cur.start_date
     order by y.start_date limit 1) as next,
   (select to_jsonb(y) from public.ad_cycles y where y.company_id = f.company_id and y.campaign_id = f.id
     and y.start_date <= t and y.end_date >= t order by y.start_date desc limit 1) as covering,
   (select to_jsonb(y) from public.ad_cycles y where y.company_id = f.company_id and y.campaign_id = f.id
     and y.start_date > t order by y.start_date limit 1) as future,
   (select to_jsonb(y) from public.ad_cycles y where y.company_id = f.company_id and y.campaign_id = f.id
     order by y.start_date desc limit 1) as last,
   case when f.current_cycle_id is null then null
    when dm.days > 0 then jsonb_build_object('net', dm.net, 'gross', dm.gross)
    else jsonb_build_object('net', coalesce(sn.spend, 0), 'gross', coalesce(sn.spend * cur.multiplier, 0)) end as spent,
   -- Os resultados: o ciclo (o último acumulado, senão a soma dos dias — a
   -- conta do cabeçalho da campanha), ontem (o dia sincronizado, de qualquer
   -- ciclo da campanha) e hoje (a última leitura do leitor em 2º plano).
   jsonb_build_object(
    'cycle', case when f.current_cycle_id is null or (sn.spend is null and dm.days = 0) then null
     when sn.spend is not null then jsonb_build_object('spend', sn.spend, 'conversions', sn.conversions)
     else jsonb_build_object('spend', dm.net, 'conversions', dm.conversions) end,
    'yesterday', (select jsonb_build_object('spend', d.spend, 'conversions', d.conversions, 'multiplier', d.multiplier)
     from public.ad_daily_metrics d where d.company_id = f.company_id and d.campaign_id = f.id and d.day = t - 1
     order by (d.cycle_id = f.current_cycle_id) desc limit 1),
    'today', (select jsonb_build_object('spend', x.spend, 'conversions', x.conversions, 'multiplier', x.multiplier,
      'read_at', x.read_at)
     from public.ad_today_metrics x where x.company_id = f.company_id and x.campaign_id = f.id and x.day = t)
   ) as results
  from sliced f
  left join public.ad_cycles cur on cur.company_id = f.company_id and cur.id = f.current_cycle_id
  left join lateral (select count(*) as days, coalesce(sum(d.spend), 0) as net,
    coalesce(sum(d.spend * d.multiplier), 0) as gross, coalesce(sum(d.conversions), 0) as conversions
   from public.ad_daily_metrics d
   where d.company_id = f.company_id and d.cycle_id = f.current_cycle_id) dm on true
  left join lateral (select s.spend, s.conversions from public.ad_cycle_snapshots s
   where s.company_id = f.company_id and s.cycle_id = f.current_cycle_id
   order by s.taken_on desc limit 1) sn on true
 )
 select jsonb_build_object(
  'total', (select count(*) from filtered),
  'all', (select count(*) from alerts),
  'attention', (select count(*) from alerts where alert_kind <> 'none'),
  'rows', coalesce((select jsonb_agg(jsonb_build_object(
    'campaign', jsonb_build_object('id', p.id, 'company_id', p.company_id, 'contract_id', p.contract_id,
     'name', p.name, 'platform', p.platform, 'status', p.status, 'current_cycle_id', p.current_cycle_id,
     'briefing_url', p.briefing_url, 'media_plan_url', p.media_plan_url, 'notes', p.notes,
     'archived', p.archived, 'created_by', p.created_by, 'created_at', p.created_at,
     'updated_at', p.updated_at, 'version', p.version),
    'client_name', p.client_name,
    'product_name', p.product_name,
    'current', p.current,
    'alert', jsonb_build_object('kind', p.alert_kind,
     'days', case p.alert_kind when 'ended' then t - p.current_end
      when 'ending' then p.current_end - t + 1 end,
     'next', case p.alert_kind when 'ended' then coalesce(p.covering, p.next)
      when 'no_current' then coalesce(p.covering, p.future, p.last)
      when 'ends_today' then p.next when 'ending' then p.next end),
    'waiting', p.waiting,
    'spent', p.spent,
    'results', p.results)
   order by (p.status <> 'active'), mavi_private.fold(p.client_name), mavi_private.fold(p.name), p.id) from page p), '[]')
 ) into result;
 -- New campaigns waiting for their first activation (a separate count).
 if coalesce(p_scope, 'active') <> 'pending' then
  result := result || jsonb_build_object('pending', (select count(*) from public.ad_campaigns a
   join public.contracts k on k.company_id = a.company_id and k.id = a.contract_id
   where a.company_id = p_company and not a.archived and a.status = 'inactive' and a.legacy_id is null
    and (v_clients is null or k.client_id = any(v_clients))
    and a.created_at > now() - interval '60 days'
    and not exists (select 1 from public.ad_campaign_events e
     where e.company_id = a.company_id and e.campaign_id = a.id and e.action = 'status')));
 end if;
 return result;
end $$;

commit;
