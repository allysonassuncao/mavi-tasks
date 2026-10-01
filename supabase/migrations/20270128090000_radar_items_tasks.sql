begin;

-- Radar do cliente › Itens: cada item da lista vem com as tarefas criadas a
-- partir dele (título e status), para a coluna "Tarefas" da tabela. As mesmas
-- regras do painel do item (radar_item, 20270107090000): só tarefas não
-- arquivadas e, para quem não é líder, só as que a pessoa já enxerga
-- (task_access). O resto é a função de 20270105090000 sem mudanças.
create or replace function public.radar_items(p_company uuid, p_filters jsonb) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare f jsonb := coalesce(p_filters, '{}'); v_topic uuid; v_q text; v_limit integer; v_offset integer;
 v_out jsonb; v_clients uuid[]; v_leader boolean; begin
 v_leader := mavi_private.leader(p_company);
 if v_leader then v_clients := null;
 elsif mavi_private.opt_in_on(p_company, 'radar') then v_clients := mavi_private.served_clients(p_company);
 else raise exception 'Sem permissão' using errcode = '42501'; end if;
 v_topic := case when f->>'topic' ~* '^[0-9a-f-]{36}$' then (f->>'topic')::uuid end;
 v_q := nullif(btrim(coalesce(f->>'q', '')), '');
 v_limit := least(greatest(coalesce((f->>'limit')::integer, 50), 1), 200);
 v_offset := greatest(coalesce((f->>'offset')::integer, 0), 0);
 with base as (
  select i.*, coalesce(mavi_private.radar_status(t.statuses, i.status)->>'kind', '') as kind
  from public.radar_items i
  join public.radar_topics t on t.id = i.topic_id
  where i.company_id = p_company
   and (v_clients is null or i.client_id = any(v_clients))
   and (v_topic is null or i.topic_id = v_topic)
   and (v_q is null or i.search @@ websearch_to_tsquery('portuguese', v_q) or i.title ilike '%' || v_q || '%'
    or exists (select 1 from public.clients k where k.id = i.client_id and k.name ilike '%' || v_q || '%'))
   and (coalesce(f->>'product', '') = '' or (f->>'product' = 'none' and i.product_id is null)
    or (f->>'product' ~* '^[0-9a-f-]{36}$' and i.product_id = (f->>'product')::uuid))
   and (coalesce(f->>'client', '') !~* '^[0-9a-f-]{36}$' or i.client_id = (f->>'client')::uuid)
   and (coalesce(f->>'team', '') !~* '^[0-9a-f-]{36}$' or exists (select 1 from public.client_teams ct
    where ct.company_id = i.company_id and ct.client_id = i.client_id and ct.team_id = (f->>'team')::uuid))
   and (jsonb_typeof(f->'statuses') is distinct from 'array' or jsonb_array_length(f->'statuses') = 0
    or i.status in (select jsonb_array_elements_text(f->'statuses')))
   and (jsonb_typeof(f->'severity') is distinct from 'number' or i.severity >= (f->>'severity')::integer)
   and (coalesce(f->>'assignee', '') = '' or (f->>'assignee' = 'none' and i.assignee_id is null)
    or (f->>'assignee' ~* '^[0-9a-f-]{36}$' and i.assignee_id = (f->>'assignee')::uuid))
   and (coalesce(f->>'theme', '') = '' or (f->>'theme' = 'none' and i.theme_id is null)
    or (f->>'theme' ~* '^[0-9a-f-]{36}$' and i.theme_id = (f->>'theme')::uuid))
   and (jsonb_typeof(f->'days') is distinct from 'number' or (f->>'days')::integer <= 0
    or i.last_seen_at > now() - make_interval(days => (f->>'days')::integer))
 ), page as (
  select b.*, count(*) over () as total from base b
  order by
   case when f->>'sort' = 'mentions' then b.mentions end desc nulls last,
   case when f->>'sort' = 'severity' then b.severity end desc nulls last,
   case when f->>'sort' = 'oldest' then b.first_seen_at end asc,
   case when b.kind = 'closed' then 1 else 0 end,
   b.last_seen_at desc, b.id
  limit v_limit offset v_offset
 )
 select jsonb_build_object('total', coalesce(max(page.total), 0),
  'items', coalesce(jsonb_agg(mavi_private.radar_item_json(i) || jsonb_build_object('tasks',
    coalesce((select jsonb_agg(jsonb_build_object('id', tk.id, 'title', tk.title, 'status', tk.status,
       'due_date', tk.due_date, 'assignee_name', mm.name) order by rt.created_at desc)
      from public.radar_item_tasks rt
      join public.tasks tk on tk.id = rt.task_id and not tk.archived
      left join public.memberships mm on mm.company_id = tk.company_id and mm.user_id = tk.assignee_id
      where rt.item_id = i.id and (v_leader or mavi_private.task_access(p_company, tk.id))), '[]'))
   order by case when f->>'sort' = 'mentions' then page.mentions end desc nulls last,
    case when f->>'sort' = 'severity' then page.severity end desc nulls last,
    case when f->>'sort' = 'oldest' then page.first_seen_at end asc,
    case when page.kind = 'closed' then 1 else 0 end,
    page.last_seen_at desc, page.id), '[]'))
 into v_out
 from page join public.radar_items i on i.id = page.id;
 return v_out;
end $$;

commit;
