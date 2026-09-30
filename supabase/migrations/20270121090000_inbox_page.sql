-- Caixa de entrada: página própria (/caixa-de-entrada) com filtros, e o painel
-- do topo em páginas de 10 ("Carregar mais"), em vez dos 30 de uma vez.
--  - my_inbox: uma página de avisos da pessoa, do mais novo para o mais
--    antigo, continuando depois do último já mostrado (created_at, id), com os
--    filtros resolvidos aqui: não lidas, tipos, quem enviou (ou os
--    automáticos), clientes, período e busca por texto;
--  - my_inbox_unread: quantas faltam ler, no total (o número no ícone e na aba
--    do navegador não depende mais de quantos avisos foram carregados);
--  - notifications.client_id: o cliente dos avisos que não são de uma tarefa
--    (Termômetro, Financeiro › Mídia, Social Leads, Cases, Radar), tirado do
--    link na criação. Os de tarefa usam o cliente atual da tarefa (pelo
--    produto contratado dela).

alter table public.notifications add column client_id uuid;

-- O cliente pelo link do aviso, quando o link aponta para algo de um cliente.
create or replace function mavi_private.notification_client(p_company uuid, p_link text) returns uuid
language sql stable set search_path = '' as $$
 with ids as (
  select
   substring(p_link from 'termometro=([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})')::uuid as client,
   substring(p_link from 'contrato=([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})')::uuid as contract,
   substring(p_link from 'caso=([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})')::uuid as success_case,
   substring(p_link from '^/radar\?item=([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})')::uuid as radar_item)
 select coalesce(
  (select c.id from public.clients c, ids where c.company_id = p_company and c.id = ids.client),
  (select k.client_id from public.contracts k, ids where k.company_id = p_company and k.id = ids.contract),
  (select s.client_id from public.success_cases s, ids where s.company_id = p_company and s.id = ids.success_case),
  (select i.client_id from public.radar_items i, ids where i.company_id = p_company and i.id = ids.radar_item))
$$;
revoke all on function mavi_private.notification_client(uuid, text) from public, anon, authenticated;

create or replace function mavi_private.notification_set_client() returns trigger
language plpgsql set search_path = '' as $$
begin
 new.client_id := mavi_private.notification_client(new.company_id, new.link);
 return new;
end $$;
revoke all on function mavi_private.notification_set_client() from public, anon, authenticated;
create trigger notification_set_client before insert on public.notifications
 for each row when (new.task_id is null and new.client_id is null and new.link is not null)
 execute function mavi_private.notification_set_client();

update public.notifications n set client_id = mavi_private.notification_client(n.company_id, n.link)
where n.task_id is null and n.client_id is null and n.link ~ '(termometro|contrato|caso|item)=';

-- O que falta ler, contado sem varrer os lidos.
create index notifications_unread on public.notifications(company_id, user_id)
 where read_at is null;

create or replace function public.my_inbox(
 p_company uuid,
 p_limit integer default 10,
 p_before timestamptz default null,
 p_before_id uuid default null,
 p_unread boolean default false,
 p_kinds text[] default null,
 p_actors uuid[] default null,
 p_system boolean default false,
 p_clients uuid[] default null,
 p_from timestamptz default null,
 p_to timestamptz default null,
 p_search text default null)
returns table(id uuid, kind text, task_id uuid, task_title text, actor_id uuid, actor_name text,
 excerpt text, read_at timestamptz, created_at timestamptz, link text, headline text, client_id uuid)
language sql stable security definer set search_path = '' as $$
 with q as (
  select nullif(mavi_private.fold(btrim(coalesce(p_search, ''))), '') as term,
   coalesce(cardinality(p_actors), 0) > 0 or coalesce(p_system, false) as by_actor)
 select n.id, n.kind, n.task_id, x.title, n.actor_id, m.name, x.excerpt,
  n.read_at, n.created_at, n.link, case when n.task_id is not null then n.title end,
  coalesce(k.client_id, n.client_id)
 from q, public.notifications n
 left join public.tasks t on t.company_id = n.company_id and t.id = n.task_id
 left join public.contracts k on k.company_id = t.company_id and k.id = t.contract_id
 left join public.memberships m on m.company_id = n.company_id and m.user_id = n.actor_id
 left join public.comments c on c.id = n.comment_id
 cross join lateral (select coalesce(t.title, n.title) as title,
  coalesce(nullif(left(regexp_replace(mavi_private.rich_plain(c.body), '\s+', ' ', 'g'), 160), ''), n.body) as excerpt) x
 where n.company_id = p_company and n.user_id = auth.uid() and mavi_private.member(p_company)
  and (n.task_id is null or t.id is not null)
  and (p_before is null or n.created_at < p_before
   or (n.created_at = p_before and p_before_id is not null and n.id < p_before_id))
  and (not coalesce(p_unread, false) or n.read_at is null)
  and (coalesce(cardinality(p_kinds), 0) = 0 or n.kind = any(p_kinds))
  and (not q.by_actor or n.actor_id = any(coalesce(p_actors, '{}'))
   or (coalesce(p_system, false) and n.actor_id is null))
  and (coalesce(cardinality(p_clients), 0) = 0 or coalesce(k.client_id, n.client_id) = any(p_clients))
  and (p_from is null or n.created_at >= p_from)
  and (p_to is null or n.created_at < p_to)
  and (q.term is null or mavi_private.fold(concat_ws(' ', x.title, m.name, x.excerpt, n.title))
   like '%' || replace(replace(replace(q.term, '\', '\\'), '%', '\%'), '_', '\_') || '%')
 order by n.created_at desc, n.id desc
 limit least(greatest(coalesce(p_limit, 10), 1), 100)
$$;
revoke all on function public.my_inbox(uuid, integer, timestamptz, uuid, boolean, text[], uuid[], boolean, uuid[],
 timestamptz, timestamptz, text) from public, anon;
grant execute on function public.my_inbox(uuid, integer, timestamptz, uuid, boolean, text[], uuid[], boolean, uuid[],
 timestamptz, timestamptz, text) to authenticated;

create or replace function public.my_inbox_unread(p_company uuid) returns integer
language sql stable security definer set search_path = '' as $$
 select count(*)::integer
 from public.notifications n
 where n.company_id = p_company and n.user_id = auth.uid() and n.read_at is null
  and mavi_private.member(p_company)
  and (n.task_id is null or exists (select 1 from public.tasks t
   where t.company_id = n.company_id and t.id = n.task_id))
$$;
revoke all on function public.my_inbox_unread(uuid) from public, anon;
grant execute on function public.my_inbox_unread(uuid) to authenticated;
