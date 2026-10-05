begin;

-- Campanhas › Relatórios do Meta: a seção "Público dos conjuntos" (o
-- público configurado de cada conjunto que veiculou no período: locais,
-- idade, gênero, interesses, comportamentos, públicos personalizados,
-- Advantage+, posicionamentos e o tamanho estimado). /api/ads lê do Meta na
-- criação e guarda em meta.audiences (a foto do dia, como os anúncios); o
-- link só recebe quando a seção está ligada. Não tem valores: o M não se
-- aplica.

-- A da migração 20270120090000, com o público dos conjuntos.
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
  'audiences', r.data->'meta'->'audiences',
  'meta_error', r.data->'meta'->'error');
end $$;

-- A da migração 20270120090000, com o público dos conjuntos.
create or replace function mavi_private.ad_report_public_view(r public.ad_reports) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v jsonb := mavi_private.ad_report_view(r); s jsonb := coalesce(r.config->'sections', '{}'); begin
 if not coalesce((s->>'ads')::boolean, false) then v := v - 'ads'; end if;
 if not coalesce((s->>'adsets')::boolean, false) then v := v - 'adsets'; end if;
 if not coalesce((s->>'keywords')::boolean, false) then v := v - 'keywords'; end if;
 if not coalesce((s->>'search_terms')::boolean, false) then v := v - 'search_terms'; end if;
 if not coalesce((s->>'audience')::boolean, false) then v := v - 'audiences'; end if;
 if not coalesce((s->>'goal')::boolean, false) then
  v := jsonb_set(v, '{cycles}', (select coalesce(jsonb_agg(c - 'budget' - 'goal_results'), '[]')
   from jsonb_array_elements(v->'cycles') c));
 end if;
 return v - 'meta_error';
end $$;

commit;
