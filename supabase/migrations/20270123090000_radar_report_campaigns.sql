begin;

-- MAVI · Radar do cliente: o relatório cruza o que foi dito com as Campanhas.
--
-- - Para os clientes do relatório (os que têm itens em aberto ou com
--   movimento no período, até 25, os com mais itens em aberto primeiro), o
--   banco junta os itens do Radar de cada um e as campanhas com ciclo no
--   período: o ciclo (meta, verba, gasto, resultados, custo por resultado ×
--   meta, ritmo esperado), o período do relatório e o período anterior do
--   mesmo tamanho. Dinheiro como o cliente contratou (com M).
-- - A MAVI usa isso para ligar cada problema aos números ("reclama de poucos
--   leads e a campanha está 40% abaixo da meta") e sugerir a solução.
-- - Campanhas só entram para quem vê Campanhas: líderes, ou colaborador com o
--   módulo ligado (e aí só nos clientes das equipes dele, como o resto).

create function mavi_private.radar_report_campaigns(c uuid, p_from date, p_to date, p_filters jsonb,
 p_scope uuid[] default null) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare f jsonb := mavi_private.radar_report_filters(c, p_filters); v_tz text; v_start timestamptz; v_end timestamptz;
 v_len integer := p_to - p_from + 1; v_topics uuid[]; v_products uuid[]; v_none boolean; v_teams uuid[];
 v_clients uuid[]; v_out jsonb; begin
 select timezone into v_tz from public.companies where id = c;
 v_tz := coalesce(v_tz, 'America/Sao_Paulo');
 v_start := p_from::timestamp at time zone v_tz;
 v_end := (p_to + 1)::timestamp at time zone v_tz;
 v_topics := array(select x::uuid from jsonb_array_elements_text(f->'topics') x);
 v_products := array(select x::uuid from jsonb_array_elements_text(f->'products') x where x <> 'none');
 v_none := f->'products' ? 'none';
 v_teams := array(select x::uuid from jsonb_array_elements_text(f->'teams') x);
 v_clients := array(select x::uuid from jsonb_array_elements_text(f->'clients') x);
 with it as materialized (
  select i.client_id, k.name as client_name, t.name as topic_name, coalesce(p.name, 'Geral / Agência') as product_name,
   i.title, i.severity, i.last_seen_at,
   coalesce(mavi_private.radar_status(t.statuses, i.status)->>'kind', '') <> 'closed' as open,
   coalesce(mavi_private.radar_status(t.statuses, i.status)->>'label', i.status) as status_label,
   (i.created_at >= v_start and i.created_at < v_end) or exists (select 1 from public.radar_mentions m
    where m.item_id = i.id and m.occurred_at >= v_start and m.occurred_at < v_end) as active
  from public.radar_items i
  join public.radar_topics t on t.id = i.topic_id
  join public.clients k on k.id = i.client_id and not k.archived
  left join public.products p on p.id = i.product_id
  where i.company_id = c
   and (cardinality(v_topics) = 0 or i.topic_id = any(v_topics))
   and ((cardinality(v_products) = 0 and not v_none) or i.product_id = any(v_products) or (v_none and i.product_id is null))
   and (cardinality(v_teams) = 0 or exists (select 1 from public.client_teams ct where ct.company_id = c
    and ct.client_id = i.client_id and ct.team_id = any(v_teams)))
   and (cardinality(v_clients) = 0 or i.client_id = any(v_clients))
   and (p_scope is null or i.client_id = any(p_scope))
 ), x as materialized (
  select * from it where it.open or it.active
 ), cl as materialized (
  select x.client_id, min(x.client_name) as client_name, count(*) filter (where x.open) as open,
   count(*) filter (where x.open and x.severity >= 2) as severe, count(*) as items
  from x group by x.client_id
  order by 3 desc, 4 desc, 5 desc, 2
  limit 25
 ), cp as materialized (
  -- Cada campanha do cliente com o ciclo mais recente dentro do período.
  select cl.client_id, a.id, a.name, a.platform, a.status, coalesce(pr.name, 'Geral / Agência') as product_name,
   y.id as cycle_id, y.start_date, y.end_date, y.objective, y.goal_results, y.budget, y.multiplier
  from cl
  join public.contracts k on k.company_id = c and k.client_id = cl.client_id
  join public.ad_campaigns a on a.company_id = c and a.contract_id = k.id and not a.archived
  left join public.products pr on pr.company_id = c and pr.id = k.product_id
  join lateral (select * from public.ad_cycles y where y.company_id = c and y.campaign_id = a.id
    and y.start_date <= p_to and y.end_date >= p_from order by y.start_date desc limit 1) y on true
  where cardinality(v_products) = 0 or k.product_id = any(v_products)
 ), cm as materialized (
  select cp.*, pm.spend as p_spend, pm.results as p_results, pm.impressions as p_impressions, pm.clicks as p_clicks,
   pv.spend as v_spend, pv.results as v_results,
   coalesce(yd.spend, ys.spend) as y_spend, coalesce(ys.results, yd.results) as y_results,
   cp.end_date - cp.start_date + 1 as days,
   greatest(least(p_to, cp.end_date) - cp.start_date + 1, 0) as elapsed
  from cp
  left join lateral (select sum(d.spend * d.multiplier) as spend, sum(d.conversions) as results,
    sum(d.impressions) as impressions, sum(d.clicks) as clicks
   from public.ad_daily_metrics d where d.company_id = c and d.campaign_id = cp.id
    and d.day between p_from and p_to) pm on true
  left join lateral (select sum(d.spend * d.multiplier) as spend, sum(d.conversions) as results
   from public.ad_daily_metrics d where d.company_id = c and d.campaign_id = cp.id
    and d.day between p_from - v_len and p_from - 1) pv on true
  -- O ciclo até o fim do período: gasto pelos dias; resultados pela última
  -- foto do ciclo (como na tela da campanha), senão pelos dias.
  left join lateral (select sum(d.spend * d.multiplier) as spend, sum(d.conversions) as results
   from public.ad_daily_metrics d where d.company_id = c and d.cycle_id = cp.cycle_id and d.day <= p_to) yd on true
  left join lateral (select s.spend * cp.multiplier as spend, s.conversions as results
   from public.ad_cycle_snapshots s where s.company_id = c and s.cycle_id = cp.cycle_id and s.period_end <= p_to
   order by s.taken_on desc limit 1) ys on true
 )
 select jsonb_build_object(
  'money', 'com M',
  'clients', coalesce((select jsonb_agg(jsonb_build_object('client', cl.client_name, 'open', cl.open,
     'severe', cl.severe,
     'items', (select coalesce(jsonb_agg(jsonb_build_object('topic', q.topic_name, 'product', q.product_name,
        'title', q.title, 'severity', q.severity, 'status', q.status_label, 'open', q.open)
       order by q.open desc, q.severity desc nulls last, q.last_seen_at desc), '[]')
      from (select * from x where x.client_id = cl.client_id
       order by x.open desc, x.severity desc nulls last, x.last_seen_at desc limit 6) q),
     'campaigns', (select jsonb_agg(jsonb_build_object('name', m.name, 'platform', m.platform,
        'product', m.product_name, 'status', m.status, 'objective', m.objective,
        'cycle', jsonb_build_object('start', m.start_date, 'end', m.end_date, 'days', m.days,
         'elapsed', m.elapsed, 'goal', m.goal_results, 'budget', round(m.budget, 2),
         'spent', round(coalesce(m.y_spend, 0), 2), 'results', coalesce(m.y_results, 0),
         'cost', case when m.y_results > 0 then round(m.y_spend / m.y_results, 2) end,
         'goal_cost', case when m.goal_results > 0 then round(m.budget / m.goal_results, 2) end,
         'expected', round(m.budget * m.elapsed / m.days, 2),
         'status', case when m.goal_results <= 0 or (m.y_spend is null and m.y_results is null) then null
          when m.y_results > 0 and m.y_spend / m.y_results <= m.budget / m.goal_results then 'good' else 'bad' end),
        'period', jsonb_build_object('spend', round(coalesce(m.p_spend, 0), 2), 'results', coalesce(m.p_results, 0),
         'impressions', coalesce(m.p_impressions, 0), 'clicks', coalesce(m.p_clicks, 0),
         'cost', case when m.p_results > 0 then round(m.p_spend / m.p_results, 2) end),
        'previous', jsonb_build_object('spend', round(coalesce(m.v_spend, 0), 2), 'results', coalesce(m.v_results, 0),
         'cost', case when m.v_results > 0 then round(m.v_spend / m.v_results, 2) end))
       order by m.status, m.p_spend desc nulls last, m.name)
      from (select * from cm where cm.client_id = cl.client_id
       order by cm.status, cm.p_spend desc nulls last, cm.name limit 6) m))
    order by cl.open desc, cl.severe desc, cl.client_name)
   from cl where exists (select 1 from cm where cm.client_id = cl.client_id)), '[]'),
  'without', coalesce((select jsonb_agg(cl.client_name order by cl.client_name) from cl
   where not exists (select 1 from cm where cm.client_id = cl.client_id)), '[]'))
 into v_out;
 return v_out;
end $$;
revoke all on function mavi_private.radar_report_campaigns(uuid, date, date, jsonb, uuid[]) from public, anon, authenticated;

-- O worker pega o relatório: os números do Radar e, para quem vê Campanhas,
-- as campanhas dos mesmos clientes.
create or replace function public.ai_radar_report_claim(p_secret text, p_limit integer default 2) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare s public.radar_report_schedules; v_tz text; v_to date; r public.radar_reports; v_scope uuid[];
 v_out jsonb := '[]'; begin
 if not mavi_private.ai_secret_ok(p_secret) then raise exception 'Sem permissão' using errcode = '42501'; end if;
 for s in select * from public.radar_report_schedules x where x.active and x.next_run_at <= now()
  order by x.next_run_at limit 20 for update skip locked loop
  select timezone into v_tz from public.companies where id = s.company_id;
  v_tz := coalesce(v_tz, 'America/Sao_Paulo');
  if not (mavi_private.leader_of(s.company_id, s.user_id) or mavi_private.opt_in_for(s.company_id, s.user_id, 'radar')) then
   update public.radar_report_schedules set active = false, next_run_at = null, updated_at = now() where id = s.id;
   continue;
  end if;
  v_to := (now() at time zone v_tz)::date - 1;
  insert into public.radar_reports(company_id, requested_by, schedule_id, title, period_from, period_to, filters)
  values (s.company_id, s.user_id, s.id, left(format('%s · %s a %s', s.name, to_char(v_to - s.period_days + 1, 'DD/MM'),
    to_char(v_to, 'DD/MM/YYYY')), 200), v_to - s.period_days + 1, v_to, s.filters);
  update public.radar_report_schedules set last_run_at = now(),
   next_run_at = mavi_private.radar_schedule_next(s.frequency, s.weekday, s.month_day, s.hour, v_tz, now())
  where id = s.id;
 end loop;
 for r in
  with due as (
   select x.id from public.radar_reports x
   where x.status in ('pending', 'running') and x.attempts < 3
    and (x.claimed_until is null or x.claimed_until < now())
   order by x.created_at limit least(greatest(coalesce(p_limit, 2), 1), 5)
   for update skip locked
  )
  update public.radar_reports x set status = 'running', attempts = x.attempts + 1,
   claimed_until = now() + interval '10 minutes'
  from due where x.id = due.id
  returning x.*
 loop
  v_scope := case when r.requested_by is null or mavi_private.leader_of(r.company_id, r.requested_by)
   then null else mavi_private.served_clients_of(r.company_id, r.requested_by) end;
  update public.radar_reports set material = mavi_private.radar_report_material(r.company_id, r.period_from,
   r.period_to, r.filters, v_scope)
   || case when v_scope is null or mavi_private.opt_in_for(r.company_id, r.requested_by, 'campaigns')
    then jsonb_build_object('campaigns', mavi_private.radar_report_campaigns(r.company_id, r.period_from,
     r.period_to, r.filters, v_scope))
    else '{}'::jsonb end
  where id = r.id
  returning * into r;
  perform mavi_private.broadcast(r.company_id, jsonb_build_object('kind', 'radar', 'report', r.id, 'status', r.status));
  v_out := v_out || jsonb_build_object('id', r.id, 'company_id', r.company_id, 'title', r.title,
   'period_from', r.period_from, 'period_to', r.period_to, 'material', r.material);
 end loop;
 return v_out;
end $$;

commit;
