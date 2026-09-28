begin;

-- Campanhas: o histórico diário completo. A aba MASO da Linha do tempo mostra
-- um acumulado do ciclo por dia (como o cron do MASO gravava), mas a
-- sincronização só gravava o do dia em que rodava: um dia sem sincronizar
-- (o MAVI parado, a conexão vencida, o import do MASO terminando antes) ficava
-- sem registro, e a conferência "LIVE" do Dia a dia sumia nesses dias. Agora
-- a sincronização recebe os dias que já têm acumulado e grava os que faltam
-- (lidos da plataforma até o dia anterior de cada um), sem tocar nos que
-- existem.

-- Bom when there are results at or below the goal's cost (net of M).
create function mavi_private.ad_goal_status(y public.ad_cycles, s jsonb) returns text
language sql immutable set search_path = '' as $$
 select case when y.goal_results <= 0 then null
  when coalesce((s ->> 'conversions')::numeric, 0) > 0
   and coalesce((s ->> 'spend')::numeric, 0) / (s ->> 'conversions')::numeric
    <= (y.budget / y.multiplier) / y.goal_results then 'good'
  else 'bad' end
$$;
revoke all on function mavi_private.ad_goal_status(public.ad_cycles, jsonb) from public, anon, authenticated;

create or replace function public.ad_sync_targets(p_secret text, p_campaign uuid default null, p_limit integer default 15)
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
   y.start_date, y.end_date, y.goal_results, y.budget, y.multiplier, y.landing_pages, y.conversion_actions,
   mavi_private.company_today(y.company_id) as today,
   (select max(d.day) from public.ad_daily_metrics d where d.company_id = y.company_id and d.cycle_id = y.id
     and d.source in ('meta','google')) as last_day,
   (select max(r.created_at) from public.ad_sync_runs r where r.company_id = y.company_id and r.cycle_id = y.id) as last_run,
   -- The days that already have the cycle's cumulative (the sync fills the rest).
   (select coalesce(jsonb_agg(s.taken_on order by s.taken_on), '[]') from public.ad_cycle_snapshots s
    where s.company_id = y.company_id and s.cycle_id = y.id) as snapshot_days,
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

drop function public.ad_sync_store(text, uuid, text, text, text, jsonb, jsonb);
create function public.ad_sync_store(p_secret text, p_cycle uuid, p_trigger text, p_status text,
 p_message text default '', p_days jsonb default '[]', p_snapshot jsonb default null, p_backfill jsonb default '[]')
 returns integer
language plpgsql security definer set search_path = '' as $$
declare y public.ad_cycles; a public.ad_campaigns; d jsonb; n integer := 0; v_source text; s jsonb;
 v_status text; begin
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
   v_status := mavi_private.ad_goal_status(y, s);
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
   -- Imported from the MASO or edited by hand: kept.
   where public.ad_cycle_snapshots.source not in ('maso','manual');
  end if;
  -- The days without a cumulative before today (the sync didn't run, or the
  -- MASO's cron missed them): each as if taken that day, the numbers up to
  -- the day before. What is there already is kept.
  if jsonb_typeof(coalesce(p_backfill, '[]')) <> 'array' then
   raise exception 'Acumulados inválidos' using errcode = '22023';
  end if;
  for s in select * from jsonb_array_elements(coalesce(p_backfill, '[]')) loop
   continue when jsonb_typeof(s) <> 'object' or (s ->> 'period_end') is null
    or (s ->> 'period_end')::date < y.start_date or (s ->> 'period_end')::date > y.end_date
    or (s ->> 'period_end')::date + 1 >= mavi_private.company_today(y.company_id);
   insert into public.ad_cycle_snapshots(company_id, campaign_id, cycle_id, taken_on, period_start, period_end,
    spend, impressions, reach, clicks, conversions, view_content, add_to_cart, initiate_checkout, goal_status,
    source, author_label)
   values (y.company_id, y.campaign_id, y.id, (s ->> 'period_end')::date + 1, y.start_date, (s ->> 'period_end')::date,
    round(greatest(coalesce((s ->> 'spend')::numeric, 0), 0), 2), greatest(coalesce((s ->> 'impressions')::bigint, 0), 0),
    greatest(coalesce((s ->> 'reach')::bigint, 0), 0), greatest(coalesce((s ->> 'clicks')::bigint, 0), 0),
    round(greatest(coalesce((s ->> 'conversions')::numeric, 0), 0), 2),
    round(greatest(coalesce((s ->> 'view_content')::numeric, 0), 0), 2),
    round(greatest(coalesce((s ->> 'add_to_cart')::numeric, 0), 0), 2),
    round(greatest(coalesce((s ->> 'initiate_checkout')::numeric, 0), 0), 2), mavi_private.ad_goal_status(y, s),
    v_source, 'Sincronização retroativa')
   on conflict (company_id, cycle_id, taken_on) do nothing;
  end loop;
 end if;
 insert into public.ad_sync_runs(company_id, campaign_id, cycle_id, trigger, status, message, days)
 values (y.company_id, y.campaign_id, y.id, case when p_trigger = 'manual' then 'manual' else 'schedule' end,
  case when p_status = 'ok' then 'ok' else 'error' end, left(coalesce(p_message, ''), 1000), n);
 return n;
end $$;

revoke all on function public.ad_sync_store(text, uuid, text, text, text, jsonb, jsonb, jsonb)
 from public, anon, authenticated;
-- anon: the server calling back for the schedule, with the secret.
grant execute on function public.ad_sync_store(text, uuid, text, text, text, jsonb, jsonb, jsonb)
 to anon, authenticated;

commit;
