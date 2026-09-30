begin;

-- MAVI · Radar do cliente na conversa com a MAVI (bolinha e módulo MAVI).
--
-- radar_ai entrega à ferramenta client_radar (e ao contexto das conversas
-- dentro de um cliente) o que o Radar anotou, em formato compacto:
-- - com cliente: os itens dele (problemas, promessas e os outros tópicos),
--   com a fala mais recente de cada um (para citar a reunião no momento ou a
--   mensagem do grupo), os números por tópico e os temas em que ele aparece;
-- - sem cliente: a carteira que a pessoa vê — os números por tópico, os
--   temas com mais clientes, os itens sérios e as promessas vencidas e, para
--   líderes, o último relatório do Radar pronto.
-- A regra de acesso é a do Drive: com cliente, quem vê o cliente; sem
-- cliente, líderes veem todos e os demais só os clientes das suas equipes.

create function public.radar_ai(p_company uuid, p_client uuid default null, p_topic text default null,
 p_status text default 'open', p_query text default null, p_limit integer default 20) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_leader boolean; v_limit integer := least(greatest(coalesce(p_limit, 20), 1), 50);
 v_status text := coalesce(nullif(p_status, ''), 'open'); v_q text := nullif(btrim(coalesce(p_query, '')), '');
 v_topic text := nullif(btrim(coalesce(p_topic, '')), ''); v_tz text; v_today date; v_out jsonb; begin
 if not mavi_private.member(p_company) then raise exception 'Sem acesso' using errcode = '42501'; end if;
 if p_client is not null and not mavi_private.dossier_reader(p_company, p_client) then
  raise exception 'Sem acesso a este cliente.' using errcode = '42501';
 end if;
 if v_status not in ('open', 'closed', 'all') then v_status := 'open'; end if;
 v_leader := mavi_private.leader(p_company);
 select coalesce(timezone, 'America/Sao_Paulo') into v_tz from public.companies where id = p_company;
 v_today := (now() at time zone v_tz)::date;
 with it as materialized (
  select i.*, t.name as topic_name, t.key as topic_key, t.has_due, t.severity_levels,
   coalesce(mavi_private.radar_status(t.statuses, i.status)->>'kind', '') as kind,
   coalesce(mavi_private.radar_status(t.statuses, i.status)->>'label', i.status) as status_label,
   k.name as client_name, coalesce(p.name, 'Geral / Agência') as product_name, th.title as theme_title,
   m.name as assignee_name
  from public.radar_items i
  join public.radar_topics t on t.id = i.topic_id
  join public.clients k on k.id = i.client_id and not k.archived
  left join public.products p on p.id = i.product_id
  left join public.radar_themes th on th.id = i.theme_id
  left join public.memberships m on m.company_id = i.company_id and m.user_id = i.assignee_id
  where i.company_id = p_company
   and (p_client is null or i.client_id = p_client)
   and (p_client is not null or v_leader or mavi_private.drive_can_read(p_company, i.client_id))
   and (v_topic is null or t.key = v_topic or t.id::text = v_topic or t.name ilike '%' || v_topic || '%')
 ), sel as (
  select * from it
  where (v_status = 'all' or (v_status = 'open' and it.kind <> 'closed') or (v_status = 'closed' and it.kind = 'closed'))
   and (v_q is null or it.search @@ websearch_to_tsquery('portuguese', v_q) or it.title ilike '%' || v_q || '%'
    or it.summary ilike '%' || v_q || '%' or it.client_name ilike '%' || v_q || '%')
  order by case when it.kind = 'closed' then 1 else 0 end, it.severity desc nulls last, it.last_seen_at desc
  limit v_limit
 )
 select jsonb_build_object(
  'scope', case when p_client is null then 'portfolio' else 'client' end,
  'leader', v_leader,
  'today', v_today,
  'started_at', (select started_at from public.radar_settings where company_id = p_company),
  'topics', coalesce((select jsonb_agg(jsonb_build_object('key', q.topic_key, 'name', q.topic_name, 'has_due', q.has_due,
     'open', q.open, 'severe', q.severe, 'overdue', q.overdue, 'new_30d', q.new_30d, 'closed_30d', q.closed_30d,
     'clients', q.clients) order by q.topic_name)
    from (select it.topic_key, min(it.topic_name) as topic_name, bool_or(it.has_due) as has_due,
      count(*) filter (where it.kind <> 'closed') as open,
      count(*) filter (where it.kind <> 'closed' and it.severity >= 2) as severe,
      count(*) filter (where it.has_due and it.kind <> 'closed' and it.due_date < v_today) as overdue,
      count(*) filter (where it.created_at > now() - interval '30 days') as new_30d,
      count(*) filter (where it.kind = 'closed' and it.status_at > now() - interval '30 days') as closed_30d,
      count(distinct it.client_id) filter (where it.kind <> 'closed') as clients
     from it group by it.topic_key) q), '[]'),
  'items', coalesce((select jsonb_agg(jsonb_build_object('id', s.id, 'topic', s.topic_name, 'client_id', s.client_id,
     'client', s.client_name, 'product', s.product_name, 'title', s.title, 'summary', left(s.summary, 400),
     'status', s.status_label, 'closed', s.kind = 'closed',
     'severity', case when s.severity is not null then split_part(s.severity_levels->>(s.severity::integer), ':', 1) end,
     'due_date', s.due_date, 'overdue', s.has_due and s.kind <> 'closed' and s.due_date < v_today,
     'mentions', s.mentions, 'first_seen', s.first_seen_at, 'last_seen', s.last_seen_at, 'theme', s.theme_title,
     'assignee', s.assignee_name,
     'quote', (select jsonb_build_object('text', mm.quote, 'speaker', mm.speaker, 'role', mm.role,
        'source_type', mm.source_type, 'source_id', mm.source_id, 'group_id', mm.group_id, 'message_id', mm.message_id,
        'at_seconds', mm.at_seconds, 'occurred_at', mm.occurred_at,
        'title', (select g.title from public.radar_signals g where g.id = mm.signal_id))
       from public.radar_mentions mm where mm.item_id = s.id order by mm.occurred_at desc limit 1))
    order by case when s.kind = 'closed' then 1 else 0 end, s.severity desc nulls last, s.last_seen_at desc)
    from sel s), '[]'),
  'total', (select count(*) from it
    where (v_status = 'all' or (v_status = 'open' and it.kind <> 'closed') or (v_status = 'closed' and it.kind = 'closed'))),
  'themes', coalesce((select jsonb_agg(jsonb_build_object('title', q.title, 'topic', q.topic_name, 'product', q.product_name,
     'clients', q.clients, 'open', q.open, 'client_names', to_jsonb(q.names)) order by q.clients desc, q.open desc)
    from (select th.title, min(it.topic_name) as topic_name, min(it.product_name) as product_name,
      count(distinct it.client_id) as clients, count(*) filter (where it.kind <> 'closed') as open,
      (array_agg(distinct it.client_name))[1:6] as names
     from it join public.radar_themes th on th.id = it.theme_id
     group by th.id, th.title
     having count(*) filter (where it.kind <> 'closed') > 0
     order by count(distinct it.client_id) desc, count(*) filter (where it.kind <> 'closed') desc
     limit case when p_client is null then 12 else 6 end) q), '[]'),
  'report', case when p_client is null and v_leader then (select jsonb_build_object('title', r.title,
     'period_from', r.period_from, 'period_to', r.period_to, 'finished_at', r.finished_at,
     'headline', r.content->>'headline', 'summary', r.content->>'summary', 'actions', r.content->'actions')
    from public.radar_reports r where r.company_id = p_company and r.status = 'done'
    order by r.finished_at desc limit 1) end)
 into v_out;
 return v_out;
end $$;

revoke all on function public.radar_ai(uuid, uuid, text, text, text, integer) from public, anon;
grant execute on function public.radar_ai(uuid, uuid, text, text, text, integer) to authenticated;

commit;
