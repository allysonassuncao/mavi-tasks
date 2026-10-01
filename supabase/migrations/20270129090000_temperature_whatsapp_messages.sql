begin;

-- Termômetro do cliente · o WhatsApp nas "Leituras recentes".
--
-- - client_temperature: as leituras vêm por fonte (até p_signals de reuniões
--   e até p_signals de dias de grupo), para uma fonte não esconder a outra;
--   cada uma traz o nome do grupo e quantas mensagens do cliente o Jev leu;
--   'sources' conta, por fonte, as leituras lidas, na fila, com erro e os
--   dias sem fala do cliente (e quantos grupos estão ligados ao cliente).
-- - temperature_signal_messages: as mensagens do cliente num dia de grupo —
--   as mesmas que o Jev leu como [cliente] (sem as do time e sem reações).
--   Quem vê é quem vê o termômetro do cliente.

create or replace function public.client_temperature(p_company uuid, p_client uuid, p_days integer default 180,
 p_signals integer default 40) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare st mavi_private.temperature_state; s public.temperature_settings; v_tz text; v_today date; begin
 if not mavi_private.dossier_reader(p_company, p_client) then
  raise exception 'Sem acesso a este cliente.' using errcode = '42501';
 end if;
 perform mavi_private.temperature_seed(p_company);
 select * into s from public.temperature_settings where company_id = p_company;
 select timezone into v_tz from public.companies where id = p_company;
 v_today := (now() at time zone coalesce(v_tz, 'America/Sao_Paulo'))::date;
 select * into st from mavi_private.temperature_state where client_id = p_client;
 -- Primeira vez (ou o dia virou sem recálculo): calcula agora.
 if exists (select 1 from public.temperature_signals where client_id = p_client and answers <> '{}')
  and (st.client_id is null or st.current is null or (st.current->>'day')::date < v_today) then
  perform mavi_private.temperature_mark(p_company, p_client, coalesce(st.refresh_from, v_today));
  perform mavi_private.temperature_refresh_client(p_client);
  select * into st from mavi_private.temperature_state where client_id = p_client;
 end if;
 return jsonb_build_object(
  'settings', mavi_private.temperature_settings_json(p_company),
  'indicators', coalesce((select jsonb_agg(jsonb_build_object('key', i.key, 'kind', i.kind, 'name', i.name,
     'description', i.description, 'levels', i.levels, 'weight', round(i.weight, 2), 'alert', i.alert,
     'product_id', i.product_id) order by i.position, i.name)
    from mavi_private.temperature_client_indicators(p_company, p_client) i), '[]'),
  'current', st.current,
  'summary', case when st.summary is not null then jsonb_build_object('text', st.summary, 'at', st.summary_at,
    'score', st.summary_score) end,
  'refreshed_at', st.refreshed_at,
  'history', case when coalesce(p_days, 0) > 0 then coalesce((select jsonb_agg(jsonb_build_object('day', d.day,
     'score', d.score, 'band', d.band, 'flags', d.flags) order by d.day)
    from public.temperature_days d where d.client_id = p_client
     and d.day > v_today - least(greatest(p_days, 1), 730)), '[]') end,
  'signals', coalesce((select jsonb_agg(jsonb_build_object('id', g.id, 'type', g.source_type, 'source_id', g.source_id,
     'group_id', g.group_id, 'message_id', g.message_id, 'title', g.title, 'date', g.occurred_at, 'day', g.day,
     'status', g.status, 'answers', g.answers, 'flags', g.flags, 'reason', g.reason->>'key', 'excerpt', g.excerpt,
     'client_lines', g.client_lines, 'group', wg.title)
    order by g.occurred_at desc)
   from (select x.* from (select y.*, row_number() over (partition by y.source_type order by y.occurred_at desc) as n
      from public.temperature_signals y where y.client_id = p_client and y.status <> 'skipped') x
     where x.n <= least(greatest(coalesce(p_signals, 40), 0), 100)) g
   left join public.whatsapp_groups wg on wg.company_id = g.company_id and wg.id = g.group_id), '[]'),
  'sources', (select jsonb_build_object(
    'meeting', jsonb_build_object('read', count(*) filter (where g.source_type = 'meeting' and g.status = 'done'),
     'pending', count(*) filter (where g.source_type = 'meeting' and g.status = 'pending'),
     'failed', count(*) filter (where g.source_type = 'meeting' and g.status = 'failed'),
     'skipped', count(*) filter (where g.source_type = 'meeting' and g.status = 'skipped')),
    'whatsapp', jsonb_build_object('read', count(*) filter (where g.source_type = 'whatsapp' and g.status = 'done'),
     'pending', count(*) filter (where g.source_type = 'whatsapp' and g.status = 'pending'),
     'failed', count(*) filter (where g.source_type = 'whatsapp' and g.status = 'failed'),
     'skipped', count(*) filter (where g.source_type = 'whatsapp' and g.status = 'skipped'),
     'groups', (select count(*) from public.whatsapp_groups w
       where w.company_id = p_company and w.client_id = p_client and not w.ignored)))
   from public.temperature_signals g where g.client_id = p_client),
  'pending', (select count(*) from public.temperature_signals g where g.client_id = p_client and g.status = 'pending'),
  'failed', (select count(*) from public.temperature_signals g where g.client_id = p_client and g.status = 'failed'),
  'jev', mavi_private.temperature_route(p_company) is not null,
  'can_configure', mavi_private.leader(p_company));
end $$;

-- As mensagens do cliente num dia de grupo (a leitura do WhatsApp aberta).
create function public.temperature_signal_messages(p_company uuid, p_signal uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare g public.temperature_signals; v_keys text[]; v_from timestamptz; v_to timestamptz; begin
 select * into g from public.temperature_signals x
 where x.id = p_signal and x.company_id = p_company and x.source_type = 'whatsapp';
 if not found or not mavi_private.dossier_reader(p_company, g.client_id) then
  raise exception 'Sem acesso a esta leitura.' using errcode = '42501';
 end if;
 v_keys := mavi_private.team_phone_keys(p_company);
 v_from := g.day::timestamp at time zone 'America/Sao_Paulo';
 v_to := (g.day + 1)::timestamp at time zone 'America/Sao_Paulo';
 return jsonb_build_object('group_id', g.group_id, 'day', g.day, 'messages', coalesce((
  select jsonb_agg(jsonb_build_object('id', m.id, 'at', m.sent_at, 'who', m.who, 'kind', m.kind,
    'text', left(m.line, 2000), 'edited', m.edited) order by m.sent_at, m.id)
  from (select w.id, w.sent_at, w.kind, w.edited, mavi_private.whatsapp_line(w) as line,
    mavi_private.whatsapp_sender(w) as who
   from public.whatsapp_messages w
   where w.company_id = p_company and w.group_id = g.group_id and w.sent_at >= v_from and w.sent_at < v_to
    and w.kind not in ('reaction', 'album')
    and not (w.from_me or mavi_private.phone_key(w.sender_phone) = any(v_keys))
    and coalesce(mavi_private.whatsapp_line(w), '') <> ''
   order by w.sent_at, w.id
   limit 300) m), '[]'));
end $$;
revoke all on function public.temperature_signal_messages(uuid, uuid) from public, anon;
grant execute on function public.temperature_signal_messages(uuid, uuid) to authenticated;

commit;
