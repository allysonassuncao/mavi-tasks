-- Busca avançada com a mesma tabela da lista de Tarefas (agrupamento,
-- ordenação, resumo dos grupos, seleção em massa): search_task_rows devolve
-- as tarefas encontradas inteiras (menos descrição e campos do template),
-- até 2000 de uma vez, com onde bateu e o trecho. search_tasks (páginas de
-- até 100, usada pela MAVI e pelos testes) passa a ler dela, sem mudar nada.

create or replace function public.search_task_rows(
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
 p_offset integer default 0)
returns table(task jsonb, match_in text, snippet text, comment_id uuid, rank integer, total bigint)
language sql stable security invoker set search_path = '' as $$
 with q as (
  select mavi_private.fold(trim(coalesce(p_query, ''))) as term),
 pattern as (
  select term, '%' || replace(replace(replace(term, '\', '\\'), '%', '\%'), '_', '\_') || '%' as pat from q),
 base as (
  select t.* from public.tasks t
  left join public.contracts k on k.company_id = t.company_id and k.id = t.contract_id
  where t.company_id = p_company and not t.archived
   and (p_client is null or k.client_id = p_client)
   and (p_project is null or t.project_id = p_project)
   and (p_assignee is null or t.assignee_id = p_assignee)
   and (p_creator is null or t.creator_id = p_creator)
   and (coalesce(p_status, '') = '' or t.status = p_status)
   and (p_from is null or t.due_date >= p_from)
   and (p_to is null or t.due_date <= p_to)),
 hits as (
  -- No text: the filters alone list the tasks.
  select b.id as task_id, 'filters'::text as match_in, ''::text as txt, null::uuid as comment_id, 0 as rank, b.created_at as at
  from base b, pattern p where p.term = ''
  union all
  select b.id, 'title', b.title, null, 1, b.created_at
  from base b, pattern p
  where p.term <> '' and 'title' = any(p_in) and mavi_private.fold(b.title) like p.pat
  union all
  select b.id, 'description', mavi_private.rich_plain(b.description), null, 2, b.created_at
  from base b, pattern p
  where p.term <> '' and 'description' = any(p_in)
   and mavi_private.fold(mavi_private.rich_plain(b.description)) like p.pat
  union all
  select b.id, 'description', a.transcript, null, 2, a.created_at
  from base b join public.task_audios a on a.company_id = b.company_id and a.task_id = b.id and a.comment_id is null,
   pattern p
  where p.term <> '' and 'description' = any(p_in) and a.transcript is not null
   and mavi_private.fold(a.transcript) like p.pat
  union all
  select b.id, 'comment', mavi_private.rich_plain(c.body), c.id, 3, c.created_at
  from base b join public.comments c on c.company_id = b.company_id and c.task_id = b.id, pattern p
  where p.term <> '' and 'comments' = any(p_in)
   and mavi_private.fold(mavi_private.rich_plain(c.body)) like p.pat
  union all
  select b.id, 'comment', a.transcript, a.comment_id, 3, a.created_at
  from base b join public.task_audios a on a.company_id = b.company_id and a.task_id = b.id and a.comment_id is not null,
   pattern p
  where p.term <> '' and 'comments' = any(p_in) and a.transcript is not null
   and mavi_private.fold(a.transcript) like p.pat),
 best as (
  select distinct on (h.task_id) h.* from hits h order by h.task_id, h.rank, h.at desc)
 select to_jsonb(t) - array['description', 'custom_fields'], b.match_in,
  case when b.match_in = 'filters' then '' else mavi_private.search_snippet(b.txt, p.term) end,
  b.comment_id, b.rank, count(*) over ()
 from best b join public.tasks t on t.id = b.task_id, pattern p
 order by b.rank, t.created_at desc, t.id
 limit least(greatest(coalesce(p_limit, 2000), 1), 2000) offset greatest(coalesce(p_offset, 0), 0)
$$;
revoke all on function public.search_task_rows(uuid, text, text[], uuid, uuid, uuid, uuid, text, date, date, integer, integer) from public, anon;
grant execute on function public.search_task_rows(uuid, text, text[], uuid, uuid, uuid, uuid, text, date, date, integer, integer) to authenticated;

create or replace function public.search_tasks(
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
 p_limit integer default 30,
 p_offset integer default 0)
returns table(
 task_id uuid, title text, status text, due_date date, contract_id uuid,
 project_id uuid, assignee_id uuid, creator_id uuid, created_at timestamptz,
 match_in text, snippet text, comment_id uuid, total bigint)
language sql stable security invoker set search_path = '' as $$
 select (r.task->>'id')::uuid, r.task->>'title', r.task->>'status',
  (r.task->>'due_date')::date, (r.task->>'contract_id')::uuid,
  (r.task->>'project_id')::uuid, (r.task->>'assignee_id')::uuid,
  (r.task->>'creator_id')::uuid, (r.task->>'created_at')::timestamptz,
  r.match_in, r.snippet, r.comment_id, r.total
 from public.search_task_rows(p_company, p_query, p_in, p_client, p_project,
  p_assignee, p_creator, p_status, p_from, p_to,
  least(greatest(coalesce(p_limit, 30), 1), 100), p_offset) r
 order by r.rank, (r.task->>'created_at')::timestamptz desc, (r.task->>'id')::uuid
$$;
