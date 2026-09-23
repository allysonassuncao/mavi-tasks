begin;

-- Advanced task search: title, description and comments (rich text read as
-- plain text), ignoring case and accents, with filters. Runs as the caller
-- (security invoker), so it only ever sees the tasks and comments the
-- person may read.

-- Lowercase without accents, one character for one (snippet offsets match).
create or replace function mavi_private.fold(p text) returns text
language sql immutable parallel safe set search_path = '' as $$
 select translate(lower(coalesce(p, '')),
  'áàâãäåéèêëíìîïóòôõöúùûüçñý',
  'aaaaaaeeeeiiiiooooouuuucny')
$$;

-- The text of a stored description or comment (rich text or legacy plain).
create or replace function mavi_private.rich_plain(p text) returns text
language plpgsql immutable parallel safe set search_path = '' as $$
declare prefix constant text := 'mavi:richtext:v1:'; doc jsonb; begin
 if p is null or left(p, length(prefix)) <> prefix then return coalesce(p, ''); end if;
 begin
  doc := substr(p, length(prefix) + 1)::jsonb;
 exception when others then return p;
 end;
 return coalesce((select string_agg(v #>> '{}', ' ') from jsonb_path_query(doc, 'strict $.**.text') as v), '');
end $$;

-- Up to ~160 characters around the first match.
create or replace function mavi_private.search_snippet(p text, p_term text) returns text
language sql immutable parallel safe set search_path = '' as $$
 select case when pos = 0 then left(txt, 160)
  else (case when pos > 61 then '…' else '' end)
   || substr(txt, greatest(pos - 60, 1), 160)
   || (case when length(txt) > greatest(pos - 60, 1) + 159 then '…' else '' end) end
 from (select regexp_replace(coalesce(p, ''), '\s+', ' ', 'g') as txt) a,
 lateral (select strpos(mavi_private.fold(a.txt), p_term) as pos) b
$$;

grant execute on function mavi_private.fold(text) to authenticated;
grant execute on function mavi_private.rich_plain(text) to authenticated;
grant execute on function mavi_private.search_snippet(text, text) to authenticated;

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
  select b.id, 'comment', mavi_private.rich_plain(c.body), c.id, 3, c.created_at
  from base b join public.comments c on c.company_id = b.company_id and c.task_id = b.id, pattern p
  where p.term <> '' and 'comments' = any(p_in)
   and mavi_private.fold(mavi_private.rich_plain(c.body)) like p.pat),
 best as (
  select distinct on (h.task_id) h.* from hits h order by h.task_id, h.rank, h.at desc)
 select b.task_id, t.title, t.status, t.due_date, t.contract_id, t.project_id,
  t.assignee_id, t.creator_id, t.created_at, b.match_in,
  case when b.match_in = 'filters' then '' else mavi_private.search_snippet(b.txt, p.term) end,
  b.comment_id, count(*) over ()
 from best b join public.tasks t on t.id = b.task_id, pattern p
 order by b.rank, t.created_at desc, t.id
 limit least(greatest(coalesce(p_limit, 30), 1), 100) offset greatest(coalesce(p_offset, 0), 0)
$$;
revoke all on function public.search_tasks(uuid, text, text[], uuid, uuid, uuid, uuid, text, date, date, integer, integer) from public, anon;
grant execute on function public.search_tasks(uuid, text, text[], uuid, uuid, uuid, uuid, text, date, date, integer, integer) to authenticated;

commit;
