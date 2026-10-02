begin;

-- Tarefas · Busca avançada sem estourar o tempo do banco (02/10/2026):
--
-- A busca com a MAVI (search_task_rows_mavi) caía às vezes por statement
-- timeout. O peso não era a MAVI nem o vetor: a cada busca o banco tirava
-- os acentos e as maiúsculas (mavi_private.fold, um translate) e lia o
-- rich text (rich_plain) de cada descrição e de cada comentário da empresa.
-- Medido com 6 mil tarefas e 18 mil comentários: ~1 s só para dobrar os
-- comentários, contra ~12 ms procurando no texto já dobrado. A busca antiga
-- (search_task_rows) pagava o mesmo, com um termo só; a da MAVI, com vários
-- termos e muitas tarefas encontradas, passava do limite.
--
-- Agora o texto de busca fica pronto em mavi_private.task_search_texts
-- (título, descrição, comentários e transcrições dos áudios, já dobrados),
-- atualizado por gatilho quando a tarefa, o comentário ou o áudio muda. As
-- duas buscas procuram nele e só montam o trecho (snippet) das tarefas que
-- voltam. Resultados, ordem e permissões não mudam: as buscas continuam com
-- a sessão da pessoa e só trazem tarefas que ela vê (o join com tasks, sob
-- RLS); a tabela nova só é lida por elas.

-- ------------------------------------------------------------ o texto pronto
create table mavi_private.task_search_texts (
 -- 'title' e 'description': source_id = a tarefa; 'comment': o comentário;
 -- 'audio': o áudio (da descrição quando comment_id é nulo).
 source text not null check (source in ('title', 'description', 'comment', 'audio')),
 source_id uuid not null,
 company_id uuid not null,
 task_id uuid not null references public.tasks(id) on delete cascade,
 comment_id uuid,
 at timestamptz not null,
 folded text not null,
 primary key (source, source_id));
create index task_search_texts_company on mavi_private.task_search_texts (company_id, task_id);
alter table mavi_private.task_search_texts enable row level security;
create policy task_search_texts_read on mavi_private.task_search_texts for select to authenticated
 using (company_id in (select mavi_private.active_companies()));
grant select on mavi_private.task_search_texts to authenticated;

create function mavi_private.task_search_texts_task() returns trigger
language plpgsql security definer set search_path = '' as $$ begin
 insert into mavi_private.task_search_texts(source, source_id, company_id, task_id, comment_id, at, folded)
 values ('title', new.id, new.company_id, new.id, null, new.created_at, mavi_private.fold(new.title)),
  ('description', new.id, new.company_id, new.id, null, new.created_at,
   mavi_private.fold(mavi_private.rich_plain(new.description)))
 on conflict (source, source_id) do update set folded = excluded.folded, at = excluded.at,
  company_id = excluded.company_id;
 return null;
end $$;
create trigger task_search_texts after insert or update of title, description on public.tasks
 for each row execute function mavi_private.task_search_texts_task();

create function mavi_private.task_search_texts_comment() returns trigger
language plpgsql security definer set search_path = '' as $$ begin
 if tg_op = 'DELETE' then
  delete from mavi_private.task_search_texts where source = 'comment' and source_id = old.id;
  return null;
 end if;
 insert into mavi_private.task_search_texts(source, source_id, company_id, task_id, comment_id, at, folded)
 values ('comment', new.id, new.company_id, new.task_id, new.id, new.created_at,
  mavi_private.fold(mavi_private.rich_plain(new.body)))
 on conflict (source, source_id) do update set folded = excluded.folded, task_id = excluded.task_id,
  at = excluded.at;
 return null;
end $$;
create trigger task_search_texts after insert or update of body or delete on public.comments
 for each row execute function mavi_private.task_search_texts_comment();

create function mavi_private.task_search_texts_audio() returns trigger
language plpgsql security definer set search_path = '' as $$ begin
 if tg_op = 'DELETE' or new.task_id is null or new.transcript is null then
  delete from mavi_private.task_search_texts where source = 'audio'
   and source_id = case when tg_op = 'DELETE' then old.id else new.id end;
  return null;
 end if;
 insert into mavi_private.task_search_texts(source, source_id, company_id, task_id, comment_id, at, folded)
 values ('audio', new.id, new.company_id, new.task_id, new.comment_id, new.created_at,
  mavi_private.fold(new.transcript))
 on conflict (source, source_id) do update set folded = excluded.folded, task_id = excluded.task_id,
  comment_id = excluded.comment_id, at = excluded.at;
 return null;
end $$;
create trigger task_search_texts after insert or update of transcript, task_id, comment_id or delete
 on public.task_audios for each row execute function mavi_private.task_search_texts_audio();

-- O que já existe.
insert into mavi_private.task_search_texts(source, source_id, company_id, task_id, comment_id, at, folded)
select 'title', t.id, t.company_id, t.id, null::uuid, t.created_at, mavi_private.fold(t.title) from public.tasks t
union all
select 'description', t.id, t.company_id, t.id, null, t.created_at,
 mavi_private.fold(mavi_private.rich_plain(t.description)) from public.tasks t
union all
select 'comment', c.id, c.company_id, c.task_id, c.id, c.created_at, mavi_private.fold(mavi_private.rich_plain(c.body))
from public.comments c
union all
select 'audio', a.id, a.company_id, a.task_id, a.comment_id, a.created_at, mavi_private.fold(a.transcript)
from public.task_audios a
where a.task_id is not null and a.transcript is not null and exists(select 1 from public.tasks t where t.id = a.task_id);

-- O trecho em volta do termo (~160 caracteres), como search_snippet, mas
-- achando o termo no texto já dobrado (fold troca letra por letra, então as
-- posições batem): dobrar o texto inteiro a cada tarefa era o que pesava.
create function mavi_private.search_window(p text, p_folded text, p_term text) returns text
language sql immutable parallel safe set search_path = '' as $$
 select case when b.pos = 0 then left(regexp_replace(left(coalesce(p, ''), 400), '\s+', ' ', 'g'), 160)
  else (case when b.pos > 61 then '…' else '' end)
   || btrim(regexp_replace(substr(coalesce(p, ''), greatest(b.pos - 60, 1), 160), '\s+', ' ', 'g'))
   || (case when length(coalesce(p, '')) > greatest(b.pos - 60, 1) + 159 then '…' else '' end) end
 from (select strpos(coalesce(p_folded, ''), coalesce(p_term, '')) as pos) b
$$;
grant execute on function mavi_private.search_window(text, text, text) to authenticated;

-- ------------------------------------------------------------ a busca de sempre
-- A de 20270130090000, procurando no texto pronto. Mesmos resultados e ordem:
-- título (1), descrição e áudios dela (2), comentários e áudios deles (3); o
-- mais recente de cada lugar; tarefas pela relevância e depois as mais novas.
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
 p_offset integer default 0,
 p_priority boolean default false)
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

-- ------------------------------------------------------------ a busca da MAVI
-- A de 20270228090000, procurando os termos no texto pronto.
create or replace function public.search_task_rows_mavi(
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
 p_offset integer default 0)
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

notify pgrst, 'reload schema';

commit;
