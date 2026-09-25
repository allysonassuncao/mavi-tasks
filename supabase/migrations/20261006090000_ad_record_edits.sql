begin;

-- Campanhas: editar os registros da Linha do tempo, como no MASO ("Editar
-- registro" na sub-aba MASO e "Editar" na sub-aba Dia a dia).
--  * Um dia editado passa a ser 'manual': a sincronização não o sobrescreve
--    (já era assim para dias digitados). O M do dia também se edita.
--  * Um acumulado (registro da sub-aba MASO) editado também vira 'manual', e
--    a sincronização passa a preservá-lo, como os importados do MASO. O
--    status Bom/Ruim é escolhido ou recalculado pela meta do ciclo.
--  * Cada edição entra no histórico da campanha (ad_campaign_events:
--    'daily_edited' e 'snapshot_edited', com o que mudou), e aparece na
--    própria Linha do tempo.
-- Só administradores, como o resto do módulo.

-- A number from the edit's values: the current one when absent; null when
-- it isn't a number (the caller says which field).
create function mavi_private.ad_edit_number(v jsonb, f text, current numeric) returns numeric
language sql immutable set search_path = '' as $$
 select case when not (v ? f) or v -> f = 'null'::jsonb then current
  when jsonb_typeof(v -> f) = 'number' then (v ->> f)::numeric end
$$;
revoke all on function mavi_private.ad_edit_number(jsonb, text, numeric) from public, anon, authenticated;

-- The metrics every record has, checked: numbers, not negative, below a
-- trillion, and impressions, reach and clicks whole.
create function mavi_private.ad_edit_metrics(v jsonb, cur jsonb) returns jsonb
language plpgsql immutable set search_path = '' as $$
declare f text; x numeric; result jsonb := '{}'; labels jsonb := jsonb_build_object('spend', 'Investimento',
 'impressions', 'Impressões', 'reach', 'Alcance', 'clicks', 'Cliques', 'conversions', 'Conversões',
 'view_content', 'Visualização de produto', 'add_to_cart', 'Adição ao carrinho',
 'initiate_checkout', 'Finalização de compra'); begin
 for f in select jsonb_object_keys(labels) loop
  x := mavi_private.ad_edit_number(v, f, (cur ->> f)::numeric);
  if x is null then raise exception 'Informe um número em %', labels ->> f using errcode = '22023'; end if;
  if x < 0 then raise exception '% não pode ser negativo', labels ->> f using errcode = '22023'; end if;
  if x >= 1e12 then raise exception '% está grande demais', labels ->> f using errcode = '22023'; end if;
  if f in ('impressions','reach','clicks') and x <> trunc(x) then
   raise exception '% é um número inteiro', labels ->> f using errcode = '22023';
  end if;
  result := result || jsonb_build_object(f, case when f in ('impressions','reach','clicks') then x else round(x, 2) end);
 end loop;
 return result;
end $$;
revoke all on function mavi_private.ad_edit_metrics(jsonb, jsonb) from public, anon, authenticated;

-- A day of the "Dia a dia": its metrics and its M.
create function public.update_ad_daily_metric(p_cycle uuid, p_day date, p_values jsonb) returns void
language plpgsql security definer set search_path = '' as $$
declare r public.ad_daily_metrics; m jsonb; v_m numeric; changes jsonb; begin
 select * into r from public.ad_daily_metrics where cycle_id = p_cycle and day = p_day;
 if not found or not mavi_private.ad_can_write(r.company_id) then
  raise exception 'Sem permissão' using errcode = '42501';
 end if;
 if jsonb_typeof(coalesce(p_values, 'null')) <> 'object' then
  raise exception 'Valores inválidos' using errcode = '22023';
 end if;
 m := mavi_private.ad_edit_metrics(p_values, to_jsonb(r));
 v_m := mavi_private.ad_edit_number(p_values, 'multiplier', r.multiplier);
 if v_m is null or v_m <= 0 or v_m > 100 then
  raise exception 'O M deve ser maior que 0 e no máximo 100' using errcode = '22023';
 end if;
 changes := mavi_private.ad_changes(to_jsonb(r), m || jsonb_build_object('multiplier', round(v_m, 3)),
  array['multiplier','spend','impressions','reach','clicks','conversions','view_content','add_to_cart',
   'initiate_checkout']);
 if changes = '{}' then return; end if;
 update public.ad_daily_metrics set multiplier = round(v_m, 3), spend = (m ->> 'spend')::numeric,
  impressions = (m ->> 'impressions')::bigint, reach = (m ->> 'reach')::bigint, clicks = (m ->> 'clicks')::bigint,
  conversions = (m ->> 'conversions')::numeric, view_content = (m ->> 'view_content')::numeric,
  add_to_cart = (m ->> 'add_to_cart')::numeric, initiate_checkout = (m ->> 'initiate_checkout')::numeric,
  source = 'manual', synced_at = now()
 where id = r.id;
 perform mavi_private.ad_log(r.company_id, r.campaign_id, r.cycle_id, 'daily_edited',
  jsonb_build_object('day', r.day, 'changes', changes));
end $$;

-- A snapshot of the "MASO" sub-tab: the end of its period, its metrics and
-- Bom/Ruim ('good', 'bad', or 'auto': by the cycle's goal, as the sync does).
create function public.update_ad_cycle_snapshot(p_id bigint, p_values jsonb) returns void
language plpgsql security definer set search_path = '' as $$
declare s public.ad_cycle_snapshots; y public.ad_cycles; m jsonb; v_end date; v_status text; changes jsonb; begin
 select * into s from public.ad_cycle_snapshots where id = p_id;
 if not found or not mavi_private.ad_can_write(s.company_id) then
  raise exception 'Sem permissão' using errcode = '42501';
 end if;
 if jsonb_typeof(coalesce(p_values, 'null')) <> 'object' then
  raise exception 'Valores inválidos' using errcode = '22023';
 end if;
 select * into y from public.ad_cycles where company_id = s.company_id and id = s.cycle_id;
 m := mavi_private.ad_edit_metrics(p_values, to_jsonb(s));
 begin
  v_end := coalesce(nullif(p_values ->> 'period_end', '')::date, s.period_end);
 exception when others then
  raise exception 'Data final inválida' using errcode = '22023';
 end;
 if v_end < s.period_start or v_end > greatest(y.end_date, s.period_end) then
  raise exception 'A data final vai de % a %', to_char(s.period_start, 'DD/MM/YYYY'),
   to_char(greatest(y.end_date, s.period_end), 'DD/MM/YYYY') using errcode = '22023';
 end if;
 v_status := case when not (p_values ? 'goal_status') then s.goal_status
  when p_values ->> 'goal_status' in ('good','bad') then p_values ->> 'goal_status'
  when p_values ->> 'goal_status' = 'auto' then
   case when y.goal_results <= 0 then null
    when (m ->> 'conversions')::numeric > 0
     and (m ->> 'spend')::numeric / (m ->> 'conversions')::numeric <= (y.budget / y.multiplier) / y.goal_results
     then 'good' else 'bad' end
  when p_values -> 'goal_status' = 'null'::jsonb then null
  else 'invalid' end;
 if v_status = 'invalid' then raise exception 'Status inválido' using errcode = '22023'; end if;
 changes := mavi_private.ad_changes(to_jsonb(s), m || jsonb_build_object('period_end', v_end, 'goal_status', v_status),
  array['period_end','spend','impressions','reach','clicks','conversions','view_content','add_to_cart',
   'initiate_checkout','goal_status']);
 if changes = '{}' then return; end if;
 update public.ad_cycle_snapshots set period_end = v_end, spend = (m ->> 'spend')::numeric,
  impressions = (m ->> 'impressions')::bigint, reach = (m ->> 'reach')::bigint, clicks = (m ->> 'clicks')::bigint,
  conversions = (m ->> 'conversions')::numeric, view_content = (m ->> 'view_content')::numeric,
  add_to_cart = (m ->> 'add_to_cart')::numeric, initiate_checkout = (m ->> 'initiate_checkout')::numeric,
  goal_status = v_status, source = 'manual'
 where id = s.id;
 perform mavi_private.ad_log(s.company_id, s.campaign_id, s.cycle_id, 'snapshot_edited',
  jsonb_build_object('taken_on', s.taken_on, 'changes', changes));
end $$;

revoke all on function public.update_ad_daily_metric(uuid, date, jsonb), public.update_ad_cycle_snapshot(bigint, jsonb)
 from public, anon, authenticated;
grant execute on function public.update_ad_daily_metric(uuid, date, jsonb), public.update_ad_cycle_snapshot(bigint, jsonb)
 to authenticated;

-- The sync now keeps a snapshot edited by hand (as it kept the MASO's).
create or replace function public.ad_sync_store(p_secret text, p_cycle uuid, p_trigger text, p_status text,
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
   -- Imported from the MASO or edited by hand: kept.
   where public.ad_cycle_snapshots.source not in ('maso','manual');
  end if;
 end if;
 insert into public.ad_sync_runs(company_id, campaign_id, cycle_id, trigger, status, message, days)
 values (y.company_id, y.campaign_id, y.id, case when p_trigger = 'manual' then 'manual' else 'schedule' end,
  case when p_status = 'ok' then 'ok' else 'error' end, left(coalesce(p_message, ''), 1000), n);
 return n;
end $$;

commit;
