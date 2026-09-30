begin;

-- Campanhas › Relatórios do Google Ads: o mesmo relatório do Meta, com o
-- que /api/ads lê do Google na criação (anúncios com títulos, descrições e
-- imagem, grupos de anúncios, palavras-chave e termos de pesquisa), pela
-- mesma regra de resultado do ciclo (as conversões escolhidas ou as da
-- categoria do objetivo). Para isso as fontes passam a trazer a MCC de
-- cada vínculo e as conversões de cada ciclo, e o relatório guarda
-- palavras-chave e termos (com ou sem M, como os anúncios; no link, só
-- quando a seção está ligada).

-- A da migração 20270113090000, com a MCC e as conversões do ciclo.
create or replace function public.ad_report_sources(p_campaign uuid, p_start date, p_end date) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare a public.ad_campaigns; begin
 a := mavi_private.ad_report_campaign(p_campaign);
 return jsonb_build_object('platform', a.platform,
  'cycles', (select coalesce(jsonb_agg(jsonb_build_object('id', y.id, 'start_date', y.start_date,
    'end_date', y.end_date, 'objective', y.objective, 'destination', y.destination,
    'conversion_actions', to_jsonb(y.conversion_actions)) order by y.start_date), '[]')
   from public.ad_cycles y where y.company_id = a.company_id and y.campaign_id = a.id
    and y.start_date <= p_end and y.end_date >= p_start),
  'links', (select coalesce(jsonb_agg(distinct jsonb_build_object('account_id', l.account_id,
    'campaign_id', l.external_campaign_id, 'manager_id', l.manager_id)), '[]')
   from public.ad_cycle_links l join public.ad_cycles y on y.company_id = l.company_id and y.id = l.cycle_id
   where y.company_id = a.company_id and y.campaign_id = a.id and y.start_date <= p_end and y.end_date >= p_start));
end $$;

-- A da migração 20270116090000, com palavras-chave e termos de pesquisa.
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
  'keywords', mavi_private.ad_report_items(r.data->'meta'->'keywords', factors, fallback, with_m),
  'search_terms', mavi_private.ad_report_items(r.data->'meta'->'search_terms', factors, fallback, with_m),
  'meta_error', r.data->'meta'->'error');
end $$;

-- A da migração 20270113090000, com palavras-chave e termos de pesquisa.
create or replace function mavi_private.ad_report_public_view(r public.ad_reports) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v jsonb := mavi_private.ad_report_view(r); s jsonb := coalesce(r.config->'sections', '{}'); begin
 if not coalesce((s->>'ads')::boolean, false) then v := v - 'ads'; end if;
 if not coalesce((s->>'adsets')::boolean, false) then v := v - 'adsets'; end if;
 if not coalesce((s->>'keywords')::boolean, false) then v := v - 'keywords'; end if;
 if not coalesce((s->>'search_terms')::boolean, false) then v := v - 'search_terms'; end if;
 if not coalesce((s->>'goal')::boolean, false) then
  v := jsonb_set(v, '{cycles}', (select coalesce(jsonb_agg(c - 'budget' - 'goal_results'), '[]')
   from jsonb_array_elements(v->'cycles') c));
 end if;
 return v - 'meta_error';
end $$;

commit;
