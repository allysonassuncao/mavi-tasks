begin;

-- Tarefas · Busca avançada com mais de um item por filtro (02/10/2026):
--
-- Cliente, projeto, responsável, quem criou e status passam a aceitar vários
-- valores (qualquer um deles; entre filtros diferentes, todos valem). As duas
-- buscas ganham as listas no fim (p_clients, p_projects, p_assignees,
-- p_creators, p_statuses), com padrão vazio: quem chama com um valor só
-- (search_tasks, a MAVI da conversa, os links "Ver tarefas") segue igual.
-- O resto é o mesmo da migração 20270303090000_task_search_speed.

drop function public.search_task_rows(uuid, text, text[], uuid, uuid, uuid, uuid, text, date, date, integer, integer,
 boolean);
create function public.search_task_rows(
 p_company uuid,
 p_query text default '',
 p_in text[] default array['title', 'description', 'comments'],
 p_client uuid default null,
 p_project uuid default null,
 p_assignee uuid default null,
 p_creator uuid default null,
 p_status text default null,
 p_from date default null,
 p_to date default null,
 p_limit integer default 2000,
 p_offset integer default 0,
 p_priority boolean default false,
 p_clients uuid[] default null,
 p_projects uuid[] default null,
 p_assignees uuid[] default null,
 p_creators uuid[] default null,
 p_statuses text[] default null)
returns table(task jsonb, match_in text, snippet text, comment_id uuid, rank integer, total bigint)
language sql stable security invoker set search_path = '' as $$
 with q as (
  select mavi_private.fold(trim(coalesce(p_query, ''))) as term),
 pattern as (
  select term, '%' || replace(replace(replace(term, '\', '\\'), '%', '\%'), '_', '\_') || '%' as pat from q),
 base as (
  select t.id, t.created_at from public.tasks t
  left join public.contracts k on k.company_id = t.company_id and k.id = t.contract_id
  where t.company_id = p_company and not t.archived
   and (p_client is null or k.client_id = p_client)
   and (p_project is null or t.project_id = p_project)
   and (p_assignee is null or t.assignee_id = p_assignee)
   and (p_creator is null or t.creator_id = p_creator)
   and (coalesce(p_status, '') = '' or t.status = p_status)
   and (coalesce(cardinality(p_clients), 0) = 0 or k.client_id = any(p_clients))
   and (coalesce(cardinality(p_projects), 0) = 0 or t.project_id = any(p_projects))
   and (coalesce(cardinality(p_assignees), 0) = 0 or t.assignee_id = any(p_assignees))
   and (coalesce(cardinality(p_creators), 0) = 0 or t.creator_id = any(p_creators))
   and (coalesce(cardinality(p_statuses), 0) = 0 or t.status = any(p_statuses))
   and (p_from is null or t.due_date >= p_from)
   and (p_to is null or t.due_date <= p_to)
   and (not coalesce(p_priority, false) or t.priority_weight > 0)),
 hits as (
  select s.task_id, s.source, s.source_id, s.comment_id, s.at, s.folded, b.created_at,
   case when s.source = 'title' then 1
    when s.source = 'description' or (s.source = 'audio' and s.comment_id is null) then 2 else 3 end as rank
  from mavi_private.task_search_texts s join base b on b.id = s.task_id, pattern p
  where p.term <> '' and s.company_id = p_company and s.folded like p.pat),
 best as (
  select distinct on (h.task_id) h.* from hits h
  where (case h.rank when 1 then 'title' when 2 then 'description' else 'comments' end) = any(p_in)
  order by h.task_id, h.rank, h.at desc),
 found as materialized (
  select b.task_id, case b.rank when 1 then 'title' when 2 then 'description' else 'comment' end as match_in,
   b.source, b.source_id, b.comment_id, b.folded, b.rank, b.created_at
  from best b
  union all
  -- No text: the filters alone list the tasks.
  select b.id, 'filters', null, null, null, null, 0, b.created_at from base b, pattern p where p.term = ''),
 -- A página primeiro (só ids e ordem); a tarefa e o trecho só das que voltam.
 page as (
  select f.*, count(*) over () as total,
   row_number() over (order by f.rank, f.created_at desc, f.task_id) as n
  from found f
  order by f.rank, f.created_at desc, f.task_id
  limit least(greatest(coalesce(p_limit, 2000), 1), 2000) offset greatest(coalesce(p_offset, 0), 0))
 select to_jsonb(t) - array['description', 'custom_fields'], f.match_in,
  case when f.match_in = 'filters' then ''
   else mavi_private.search_window(case f.source
    when 'title' then t.title
    when 'description' then mavi_private.rich_plain(t.description)
    when 'comment' then (select mavi_private.rich_plain(c.body) from public.comments c where c.id = f.source_id)
    else (select a.transcript from public.task_audios a where a.id = f.source_id) end, f.folded, p.term) end,
  f.comment_id, f.rank, f.total
 from page f join public.tasks t on t.id = f.task_id, pattern p
 order by f.n
$$;
revoke all on function public.search_task_rows(uuid, text, text[], uuid, uuid, uuid, uuid, text, date, date, integer,
 integer, boolean, uuid[], uuid[], uuid[], uuid[], text[]) from public, anon;
grant execute on function public.search_task_rows(uuid, text, text[], uuid, uuid, uuid, uuid, text, date, date, integer,
 integer, boolean, uuid[], uuid[], uuid[], uuid[], text[]) to authenticated;

drop function public.search_task_rows_mavi(uuid, text[], text, text[], uuid, uuid, uuid, uuid, text, date, date, boolean,
 integer, integer);
create function public.search_task_rows_mavi(
 p_company uuid,
 p_terms text[] default '{}',
 p_embedding text default null,
 p_in text[] default array['title', 'description', 'comments'],
 p_client uuid default null,
 p_project uuid default null,
 p_assignee uuid default null,
 p_creator uuid default null,
 p_status text default null,
 p_from date default null,
 p_to date default null,
 p_priority boolean default false,
 p_limit integer default 2000,
 p_offset integer default 0,
 p_clients uuid[] default null,
 p_projects uuid[] default null,
 p_assignees uuid[] default null,
 p_creators uuid[] default null,
 p_statuses text[] default null)
returns table(task jsonb, match_in text, snippet text, comment_id uuid, rank integer, total bigint)
language sql volatile security invoker set search_path = '' as $$
 with terms as (
  select distinct x.term from (select mavi_private.fold(btrim(t)) as term
   from unnest(coalesce(p_terms, '{}')) t) x
  where length(x.term) >= 2),
 pats as (
  select t.term, '%' || replace(replace(replace(t.term, '\', '\\'), '%', '\%'), '_', '\_') || '%' as pat
  from (select term from terms order by length(term) desc, term limit 12) t),
 arr as (select coalesce(array_agg(pat), '{}') as pats from pats),
 base as (
  select t.id, t.created_at from public.tasks t
  left join public.contracts k on k.company_id = t.company_id and k.id = t.contract_id
  where t.company_id = p_company and not t.archived
   and (p_client is null or k.client_id = p_client)
   and (p_project is null or t.project_id = p_project)
   and (p_assignee is null or t.assignee_id = p_assignee)
   and (p_creator is null or t.creator_id = p_creator)
   and (coalesce(p_status, '') = '' or t.status = p_status)
   and (coalesce(cardinality(p_clients), 0) = 0 or k.client_id = any(p_clients))
   and (coalesce(cardinality(p_projects), 0) = 0 or t.project_id = any(p_projects))
   and (coalesce(cardinality(p_assignees), 0) = 0 or t.assignee_id = any(p_assignees))
   and (coalesce(cardinality(p_creators), 0) = 0 or t.creator_id = any(p_creators))
   and (coalesce(cardinality(p_statuses), 0) = 0 or t.status = any(p_statuses))
   and (p_from is null or t.due_date >= p_from)
   and (p_to is null or t.due_date <= p_to)
   and (not coalesce(p_priority, false) or t.priority_weight > 0)),
 hits as (
  select s.task_id, s.source, s.source_id, s.comment_id, s.at, s.folded, b.created_at,
   case when s.source = 'title' then 1
    when s.source = 'description' or (s.source = 'audio' and s.comment_id is null) then 2 else 3 end as place
  from mavi_private.task_search_texts s join base b on b.id = s.task_id, arr a
  where cardinality(a.pats) > 0 and s.company_id = p_company and s.folded like any(a.pats)),
 best_term as (
  select distinct on (h.task_id) h.* from hits h
  where (case h.place when 1 then 'title' when 2 then 'description' else 'comments' end) = any(p_in)
  order by h.task_id, h.place, h.at desc),
 near as (
  select m.task_id, m.similarity, m.content, b.created_at
  from public.search_task_meaning(p_company, nullif(p_embedding, ''), p_client, p_project, 150) m
  join base b on b.id = m.task_id
  where nullif(p_embedding, '') is not null),
 top as (select max(similarity) as best from near),
 meaning as (
  select n.* from near n, top
  where n.similarity >= greatest(0.3, top.best - 0.1)),
 found as materialized (
  select coalesce(t.task_id, m.task_id) as task_id, coalesce(t.created_at, m.created_at) as created_at,
   case when t.task_id is null then 'meaning'
    when t.place = 1 then 'title' when t.place = 2 then 'description' else 'comment' end as match_in,
   t.source, t.source_id, t.comment_id, t.folded, m.content,
   case when t.task_id is null then 0 when t.place = 1 then 1.0 when t.place = 2 then 0.7 else 0.5 end
    + coalesce(0.8 * m.similarity / nullif((select best from top), 0), 0) as score
  from best_term t full join meaning m on m.task_id = t.task_id
  union all
  -- Sem termos nem vetor: os filtros sozinhos.
  select b.id, b.created_at, 'filters', null, null, null, null, null, 0
  from base b, arr a
  where cardinality(a.pats) = 0 and nullif(p_embedding, '') is null),
 -- A página primeiro (só ids e ordem); a tarefa e o trecho só das que voltam.
 page as (
  select f.*, count(*) over () as total,
   row_number() over (order by f.score desc, f.created_at desc, f.task_id) as n
  from found f
  order by f.score desc, f.created_at desc, f.task_id
  limit least(greatest(coalesce(p_limit, 2000), 1), 2000) offset greatest(coalesce(p_offset, 0), 0))
 select to_jsonb(t) - array['description', 'custom_fields'], f.match_in,
  case
   when f.match_in = 'filters' then ''
   when f.match_in = 'meaning' then
    left(regexp_replace(f.content, '\s+', ' ', 'g'), 160)
     || case when length(regexp_replace(f.content, '\s+', ' ', 'g')) > 160 then '…' else '' end
   else coalesce(mavi_private.search_window(case f.source
     when 'title' then t.title
     when 'description' then mavi_private.rich_plain(t.description)
     when 'comment' then (select mavi_private.rich_plain(c.body) from public.comments c where c.id = f.source_id)
     else (select a.transcript from public.task_audios a where a.id = f.source_id) end, f.folded,
    (select p.term from pats p where f.folded like p.pat order by length(p.term) desc limit 1)), '')
  end,
  f.comment_id, f.n::integer, f.total
 from page f join public.tasks t on t.id = f.task_id
 order by f.n
$$;
revoke all on function public.search_task_rows_mavi(uuid, text[], text, text[], uuid, uuid, uuid, uuid, text, date, date,
 boolean, integer, integer, uuid[], uuid[], uuid[], uuid[], text[]) from public, anon;
grant execute on function public.search_task_rows_mavi(uuid, text[], text, text[], uuid, uuid, uuid, uuid, text, date,
 date, boolean, integer, integer, uuid[], uuid[], uuid[], uuid[], text[]) to authenticated;

notify pgrst, 'reload schema';

commit;
