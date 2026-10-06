-- Termômetro › Linha do tempo: do primeiro contato até hoje, os dias em que a
-- temperatura do cliente mexeu — as leituras do dia (reuniões e dias de
-- grupo), as que saíram da janela, a nota antes e depois, as viradas de faixa
-- e os sinais de alerta que apareceram ou sumiram.
--
-- O efeito é do dia: a nota do dia menos a do dia anterior (temperature_days).
-- Como a nota só muda quando uma leitura entra, sai da janela ou fica antiga
-- demais para sustentar um indicador, a soma dos efeitos fecha com a nota de
-- hoje.

create function public.client_temperature_timeline(p_company uuid, p_client uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare s public.temperature_settings; begin
 if not mavi_private.dossier_reader(p_company, p_client) then
  raise exception 'Sem acesso a este cliente.' using errcode = '42501';
 end if;
 select * into s from public.temperature_settings where company_id = p_company;
 return jsonb_build_object(
  'today', mavi_private.company_today(p_company),
  'window_days', s.window_days,
  'events', coalesce((
   with d as (
    select t.day, t.score, t.band, t.indicators, t.flags,
     lag(t.day) over w as prev_day, lag(t.score) over w as prev_score, lag(t.band) over w as prev_band,
     lag(t.indicators) over w as prev_indicators, lag(t.flags) over w as prev_flags
    from public.temperature_days t
    where t.company_id = p_company and t.client_id = p_client
    window w as (order by t.day)
   ),
   -- As leituras que contam (as mesmas de temperature_series), por dia.
   sig as (
    select g.day, jsonb_agg(jsonb_build_object('id', g.id, 'type', g.source_type, 'source_id', g.source_id,
      'group_id', g.group_id, 'message_id', g.message_id, 'title', g.title, 'date', g.occurred_at, 'day', g.day,
      'reason', g.reason->>'key', 'excerpt', left(g.excerpt, 280), 'group', wg.title,
      'corrected', g.overrides <> '{}',
      'flags', coalesce((select jsonb_agg(f.key order by f.key) from jsonb_each_text(g.flags) f
        where f.value ~ '^[0-9.]+$' and f.value::numeric >= s.flag_threshold), '[]'))
     order by g.occurred_at) as items
    from public.temperature_signals g
    left join public.whatsapp_groups wg on wg.company_id = g.company_id and wg.id = g.group_id
    where g.company_id = p_company and g.client_id = p_client and g.status <> 'skipped' and g.answers <> '{}'
    group by g.day
   )
   select jsonb_agg(jsonb_build_object('day', d.day, 'score', d.score, 'band', d.band,
     'prev', d.prev_score, 'prev_band', d.prev_band, 'first', d.prev_day is null,
     'indicators', d.indicators, 'prev_indicators', d.prev_indicators,
     'flags_added', coalesce((select jsonb_agg(f) from unnest(d.flags) f
       where not (f = any(coalesce(d.prev_flags, '{}')))), '[]'),
     'flags_removed', coalesce((select jsonb_agg(f) from unnest(coalesce(d.prev_flags, '{}')) f
       where not (f = any(d.flags))), '[]'),
     'signals', coalesce(sg.items, '[]'),
     -- Uma leitura conta por window_days dias: no dia seguinte, sai da conta.
     'expired', coalesce(ex.items, '[]'))
    order by d.day)
   from d
   left join sig sg on sg.day = d.day
   left join sig ex on ex.day = d.day - s.window_days
   where d.prev_day is null or sg.day is not null or ex.day is not null
    or d.score is distinct from d.prev_score or d.flags is distinct from d.prev_flags), '[]'));
end $$;

revoke all on function public.client_temperature_timeline(uuid, uuid) from public, anon;
grant execute on function public.client_temperature_timeline(uuid, uuid) to authenticated;
