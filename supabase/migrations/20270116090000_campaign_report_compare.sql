begin;

-- Campanhas › Relatórios: um segundo período para comparar. Quem cria o
-- relatório escolhe, se quiser, o período de comparação (anterior, ciclo
-- anterior, mês passado ou datas); os números dos dois ficam guardados no
-- relatório, e o link mostra a comparação (o cliente pode trocar os
-- períodos dentro do que foi guardado, se o relatório permitir). O alcance
-- do período de comparação vem do Meta na criação (meta.compare_reach).
alter table public.ad_reports
 add column compare_start date,
 add column compare_end date,
 add constraint ad_reports_compare_check check ((compare_start is null) = (compare_end is null)
  and (compare_end is null or (compare_end >= compare_start and compare_end - compare_start < 400)));

create or replace function mavi_private.ad_report_json(r public.ad_reports, p_view boolean) returns jsonb
language sql stable security definer set search_path = '' as $$
 select jsonb_build_object('id', r.id, 'campaign_id', r.campaign_id, 'title', r.title,
  'period_start', r.period_start, 'period_end', r.period_end,
  'compare_start', r.compare_start, 'compare_end', r.compare_end, 'config', r.config, 'analysis', r.analysis,
  'created_by', r.created_by, 'created_at', r.created_at, 'updated_by', r.updated_by, 'updated_at', r.updated_at,
  'link', case when r.token is null then null else jsonb_build_object('token', r.token, 'expires_at', r.expires_at,
   'expired', r.expires_at is not null and r.expires_at <= now(), 'has_password', r.password_hash is not null) end,
  'can_manage', mavi_private.ad_report_can_manage(r),
  'view', case when p_view then mavi_private.ad_report_view(r) end)
$$;

create or replace function mavi_private.ad_report_view(r public.ad_reports) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare with_m boolean := coalesce((r.config->>'with_m')::boolean, false); factors jsonb; days jsonb;
 cycles jsonb; fallback numeric; begin
 select coalesce(jsonb_object_agg(t.day, t.f), '{}') into factors from (
  select x->>'day' as day, case when sum((x->>'spend')::numeric) > 0
    then sum((x->>'spend')::numeric * (x->>'m')::numeric) / sum((x->>'spend')::numeric)
    else max((x->>'m')::numeric) end as f
  from jsonb_array_elements(coalesce(r.data->'days', '[]')) x group by 1) t;
 select (c->>'multiplier')::numeric into fallback
  from jsonb_array_elements(coalesce(r.data->'cycles', '[]')) c order by c->>'start_date' desc limit 1;
 select coalesce(jsonb_agg(jsonb_build_object('day', t.day, 'spend', round(t.spend, 2), 'impressions', t.impressions,
   'reach', t.reach, 'clicks', t.clicks, 'conversions', t.conversions, 'view_content', t.view_content,
   'add_to_cart', t.add_to_cart, 'initiate_checkout', t.initiate_checkout) order by t.day), '[]') into days
 from (
  select x->>'day' as day,
   sum((x->>'spend')::numeric * case when with_m then (x->>'m')::numeric else 1 end) as spend,
   sum((x->>'impressions')::numeric) as impressions, sum((x->>'reach')::numeric) as reach,
   sum((x->>'clicks')::numeric) as clicks, sum((x->>'conversions')::numeric) as conversions,
   sum((x->>'view_content')::numeric) as view_content, sum((x->>'add_to_cart')::numeric) as add_to_cart,
   sum((x->>'initiate_checkout')::numeric) as initiate_checkout
  from jsonb_array_elements(coalesce(r.data->'days', '[]')) x group by 1) t;
 select coalesce(jsonb_agg(jsonb_build_object('start_date', c->'start_date', 'end_date', c->'end_date',
   'objective', c->'objective', 'destination', c->'destination', 'goal_results', c->'goal_results',
   'budget', round(case when with_m then (c->>'budget')::numeric
    else (c->>'budget')::numeric / nullif((c->>'multiplier')::numeric, 0) end, 2))
   order by c->>'start_date'), '[]') into cycles
 from jsonb_array_elements(coalesce(r.data->'cycles', '[]')) c;
 return jsonb_build_object(
  'platform', r.data->'platform',
  'campaign_name', r.data->'campaign_name',
  'client_name', r.data->'client_name',
  'product_name', r.data->'product_name',
  'captured_at', r.data->'captured_at',
  'currency', coalesce(r.data->'meta'->'currency', '"BRL"'),
  'days', days,
  'cycles', cycles,
  'reach', r.data->'meta'->'reach',
  'compare_reach', r.data->'meta'->'compare_reach',
  'ad_results', coalesce(r.data->'meta'->'ad_results', 'true'),
  'ads', mavi_private.ad_report_items(r.data->'meta'->'ads', factors, fallback, with_m),
  'adsets', mavi_private.ad_report_items(r.data->'meta'->'adsets', factors, fallback, with_m),
  'meta_error', r.data->'meta'->'error');
end $$;

create or replace function public.ad_report_public(p_token text, p_password text default null) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare r public.ad_reports; access text; begin
 if p_token is null or p_token !~ '^[0-9a-f]{64}$' then return null; end if;
 select * into r from public.ad_reports where token = p_token;
 if not found then return null; end if;
 access := mavi_private.ad_report_access(r, p_password);
 if access <> 'ok' then return jsonb_build_object('status', access); end if;
 return jsonb_build_object('status', 'ok',
  'company', (select c.name from public.companies c where c.id = r.company_id),
  'title', r.title, 'period_start', r.period_start, 'period_end', r.period_end,
  'compare_start', r.compare_start, 'compare_end', r.compare_end,
  'expires_at', r.expires_at,
  'config', r.config - 'with_m',
  'analysis', case when coalesce((r.config->'sections'->>'analysis')::boolean, false) then r.analysis else '' end,
  'view', mavi_private.ad_report_public_view(r));
end $$;

-- A da migração 20270113090000, com o período de comparação.
drop function public.create_ad_report(uuid, text, date, date, jsonb, jsonb, text, boolean, timestamptz, text);
create function public.create_ad_report(p_campaign uuid, p_title text, p_start date, p_end date, p_config jsonb,
 p_meta jsonb default '{}', p_analysis text default '', p_link boolean default true,
 p_expires_at timestamptz default null, p_password text default null,
 p_compare_start date default null, p_compare_end date default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare a public.ad_campaigns; r public.ad_reports; v_client text; v_product text; begin
 a := mavi_private.ad_report_campaign(p_campaign);
 if length(btrim(coalesce(p_title, ''))) < 2 then
  raise exception 'Dê um nome ao relatório.' using errcode = '22023';
 end if;
 if p_start is null or p_end is null or p_end < p_start then
  raise exception 'Escolha o período do relatório.' using errcode = '22023';
 end if;
 if p_end - p_start >= 400 then
  raise exception 'O período do relatório pode ter até 400 dias.' using errcode = '22023';
 end if;
 if (p_compare_start is null) <> (p_compare_end is null) or p_compare_end < p_compare_start then
  raise exception 'Escolha o período de comparação.' using errcode = '22023';
 end if;
 if p_compare_end - p_compare_start >= 400 then
  raise exception 'O período de comparação pode ter até 400 dias.' using errcode = '22023';
 end if;
 if p_config is null or jsonb_typeof(p_config) <> 'object' then
  raise exception 'Escolha o que o relatório mostra.' using errcode = '22023';
 end if;
 if p_meta is not null and (jsonb_typeof(p_meta) <> 'object' or octet_length(p_meta::text) > 4000000) then
  raise exception 'Os anúncios do relatório passaram do tamanho aceito.' using errcode = '22023';
 end if;
 if p_link and p_expires_at is not null and p_expires_at <= now() then
  raise exception 'Escolha uma validade no futuro.' using errcode = '22023';
 end if;
 select c.name, p.name into v_client, v_product from public.contracts k
  join public.clients c on c.company_id = k.company_id and c.id = k.client_id
  join public.products p on p.company_id = k.company_id and p.id = k.product_id
  where k.company_id = a.company_id and k.id = a.contract_id;
 insert into public.ad_reports(company_id, campaign_id, title, period_start, period_end, compare_start, compare_end,
  config, analysis, data, token, expires_at, password_hash)
 values (a.company_id, a.id, btrim(p_title), p_start, p_end, p_compare_start, p_compare_end, p_config,
  left(coalesce(p_analysis, ''), 20000),
  jsonb_build_object(
   'platform', a.platform, 'campaign_name', a.name, 'client_name', v_client, 'product_name', v_product,
   'captured_at', now(),
   'days', (select coalesce(jsonb_agg(jsonb_build_object('day', d.day, 'cycle', d.cycle_id, 'm', d.multiplier,
     'spend', d.spend, 'impressions', d.impressions, 'reach', d.reach, 'clicks', d.clicks,
     'conversions', d.conversions, 'view_content', d.view_content, 'add_to_cart', d.add_to_cart,
     'initiate_checkout', d.initiate_checkout) order by d.day), '[]')
    from public.ad_daily_metrics d
    where d.company_id = a.company_id and d.campaign_id = a.id
     and (d.day between p_start and p_end or d.day between p_compare_start and p_compare_end)),
   'cycles', (select coalesce(jsonb_agg(jsonb_build_object('id', y.id, 'start_date', y.start_date,
     'end_date', y.end_date, 'objective', y.objective, 'destination', y.destination,
     'goal_results', y.goal_results, 'budget', y.budget, 'multiplier', y.multiplier) order by y.start_date), '[]')
    from public.ad_cycles y where y.company_id = a.company_id and y.campaign_id = a.id
     and (y.start_date <= p_end and y.end_date >= p_start
      or y.start_date <= p_compare_end and y.end_date >= p_compare_start)),
   'meta', coalesce(p_meta, '{}')),
  case when coalesce(p_link, false) then mavi_private.ad_report_token() end,
  case when coalesce(p_link, false) then p_expires_at end,
  case when coalesce(p_link, false) then mavi_private.ad_report_password(p_password) end)
 returning * into r;
 perform mavi_private.ad_log(a.company_id, a.id, null, 'report_created', jsonb_build_object('report', r.id,
  'title', r.title, 'start', r.period_start, 'end', r.period_end, 'compare_start', r.compare_start,
  'compare_end', r.compare_end, 'link', r.token is not null));
 return mavi_private.ad_report_json(r, true);
end $$;

revoke all on function public.create_ad_report(uuid, text, date, date, jsonb, jsonb, text, boolean, timestamptz, text,
 date, date) from public, anon;
grant execute on function public.create_ad_report(uuid, text, date, date, jsonb, jsonb, text, boolean, timestamptz, text,
 date, date) to authenticated;

commit;
