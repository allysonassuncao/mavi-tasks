begin;

-- Social Leads: o histórico de cada post (linha do tempo). Tudo o que muda
-- num post vira um acontecimento: criado, aprovado, ajuste pedido (pela
-- equipe ou pelo cliente no link, com a observação), reaberto, conteúdo
-- editado (o que era e o que ficou, e o motivo: edição, ajuste pela IA,
-- regeneração, restauração), artes enviadas, tarefa de arte criada, e os
-- comentários da equipe. Os acontecimentos são gravados por um gatilho nos
-- posts, então nenhum caminho de gravação fica de fora.

create table if not exists public.social_leads_post_events (
 id uuid primary key default gen_random_uuid(),
 seq bigint generated always as identity,
 company_id uuid not null,
 contract_id uuid not null,
 plan_id uuid not null,
 number integer not null check (number between 1 and 8),
 kind text not null check (kind in ('created', 'approved', 'rejected', 'reopened', 'edited', 'arts', 'task', 'comment')),
 via text not null check (via in ('team', 'link', 'ai')),
 actor_id uuid,
 -- O nome de quem fez, como era na hora (no link, o nome do cliente).
 actor_name text not null default '',
 note text not null default '' check (length(note) <= 2000),
 detail jsonb not null default '{}',
 created_at timestamptz not null default now(),
 foreign key (company_id, plan_id) references public.social_leads_plans(company_id, id) on delete cascade
);
create index if not exists social_leads_post_events_post
 on public.social_leads_post_events(plan_id, number, created_at, seq);

alter table public.social_leads_post_events enable row level security;
drop policy if exists social_leads_post_events_read on public.social_leads_post_events;
create policy social_leads_post_events_read on public.social_leads_post_events for select to authenticated
 using (company_id in (select mavi_private.active_companies()) and mavi_private.contract_read(company_id, contract_id));
grant select on public.social_leads_post_events to authenticated;

-- Nome de uma pessoa na empresa ('' quando não há).
create or replace function mavi_private.social_leads_person(c uuid, u uuid) returns text
language sql stable security definer set search_path = '' as $$
 select coalesce((select name from public.memberships where company_id = c and user_id = u), '')
$$;
-- Nome do cliente, como no link.
create or replace function mavi_private.social_leads_client_name(c uuid, k uuid) returns text
language sql stable security definer set search_path = '' as $$
 select coalesce(nullif(b.fields->>'clientName', ''), cl.name, 'Cliente')
 from public.contracts kk join public.clients cl on cl.company_id = kk.company_id and cl.id = kk.client_id
 left join public.social_leads_briefings b on b.company_id = kk.company_id and b.contract_id = kk.id
 where kk.company_id = c and kk.id = k
$$;
revoke all on function mavi_private.social_leads_person(uuid, uuid) from public, anon, authenticated;
revoke all on function mavi_private.social_leads_client_name(uuid, uuid) from public, anon, authenticated;

create or replace function mavi_private.social_leads_log_post() returns trigger
language plpgsql security definer set search_path = '' as $$
declare p public.social_leads_plans; me uuid := auth.uid(); me_name text; reason text; before jsonb := '{}';
 after jsonb := '{}'; col text; via text; t public.tasks; added jsonb; removed jsonb; was_ad boolean; prev jsonb; begin
 -- A gravação dos posts tira o anúncio de todos antes e põe de volta: essa
 -- primeira troca não conta; o post lembra que era o anúncio (nesta transação).
 if tg_op = 'UPDATE' and old.is_ad and not new.is_ad
  and to_jsonb(old) - 'is_ad' - 'updated_at' = to_jsonb(new) - 'is_ad' - 'updated_at' then
  perform set_config('mavi.sl_ad', new.plan_id::text || ':' || new.number, true);
  return null;
 end if;
 select * into p from public.social_leads_plans where id = new.plan_id;
 me_name := mavi_private.social_leads_person(new.company_id, me);
 -- O motivo da gravação do plano nesta mesma transação (a versão guardada antes).
 select r.reason into reason from public.social_leads_revisions r
 where r.plan_id = new.plan_id and r.created_at = now() order by r.number desc limit 1;
 via := case when p.source = 'ai' then 'ai' else 'team' end;

 if tg_op = 'INSERT' then
  insert into public.social_leads_post_events(company_id, contract_id, plan_id, number, kind, via, actor_id, actor_name, detail)
  values (new.company_id, new.contract_id, new.plan_id, new.number, 'created', via, me, me_name,
   jsonb_build_object('source', p.source));
  if new.decision <> 'pending' then
   insert into public.social_leads_post_events(company_id, contract_id, plan_id, number, kind, via, actor_id, actor_name, note)
   values (new.company_id, new.contract_id, new.plan_id, new.number, new.decision, 'team', new.decided_by,
    mavi_private.social_leads_person(new.company_id, new.decided_by), new.note);
  end if;
  return null;
 end if;

 -- Conteúdo: o que era e o que ficou, só dos campos que mudaram.
 was_ad := current_setting('mavi.sl_ad', true) = new.plan_id::text || ':' || new.number;
 prev := to_jsonb(old) || case when was_ad then '{"is_ad": true}'::jsonb else '{}'::jsonb end;
 if was_ad then perform set_config('mavi.sl_ad', '', true); end if;
 foreach col in array array['pillar', 'hook', 'copy_direction', 'visual_direction', 'format', 'cta', 'is_ad'] loop
  if prev->col is distinct from to_jsonb(new)->col then
   before := before || jsonb_build_object(col, prev->col);
   after := after || jsonb_build_object(col, to_jsonb(new)->col);
  end if;
 end loop;
 if before <> '{}' then
  insert into public.social_leads_post_events(company_id, contract_id, plan_id, number, kind, via, actor_id, actor_name, detail)
  values (new.company_id, new.contract_id, new.plan_id, new.number, 'edited',
   case when reason = 'ajuste pedido à IA' or reason = 'regeneração do mês' then 'ai' else 'team' end, me, me_name,
   jsonb_strip_nulls(jsonb_build_object('before', before, 'after', after, 'reason', reason,
    'summary', case when reason = 'ajuste pedido à IA' then nullif(p.summary, '') end,
    -- A aprovação valia para o texto anterior: o post voltou a pendente.
    'reset', case when old.decision <> 'pending' and new.decision = 'pending' then true end)));
 end if;

 -- Decisão (uma nova, ou a mesma de novo com outra observação).
 if (new.decision is distinct from old.decision or new.decided_at is distinct from old.decided_at)
  and not (before <> '{}' and new.decision = 'pending') then
  if new.decision = 'pending' then
   insert into public.social_leads_post_events(company_id, contract_id, plan_id, number, kind, via, actor_id, actor_name, detail)
   values (new.company_id, new.contract_id, new.plan_id, new.number, 'reopened', 'team', me, me_name,
    jsonb_strip_nulls(jsonb_build_object('reason', reason)));
  elsif new.decided_via = 'link' then
   insert into public.social_leads_post_events(company_id, contract_id, plan_id, number, kind, via, actor_name, note)
   values (new.company_id, new.contract_id, new.plan_id, new.number, new.decision, 'link',
    mavi_private.social_leads_client_name(new.company_id, new.contract_id), new.note);
  else
   insert into public.social_leads_post_events(company_id, contract_id, plan_id, number, kind, via, actor_id, actor_name, note, detail)
   values (new.company_id, new.contract_id, new.plan_id, new.number, new.decision, 'team', coalesce(new.decided_by, me),
    mavi_private.social_leads_person(new.company_id, coalesce(new.decided_by, me)), new.note,
    jsonb_strip_nulls(jsonb_build_object('reason', reason)));
  end if;
 end if;

 -- Artes: as que entraram e as que saíram.
 if new.arts is distinct from old.arts then
  select coalesce(jsonb_agg(jsonb_build_object('id', a->>'id', 'name', a->>'name', 'type', a->>'type')), '[]') into added
  from jsonb_array_elements(coalesce(new.arts, '[]')) a
  where not exists (select 1 from jsonb_array_elements(coalesce(old.arts, '[]')) o where o->>'id' = a->>'id');
  select coalesce(jsonb_agg(a->>'name'), '[]') into removed
  from jsonb_array_elements(coalesce(old.arts, '[]')) a
  where not exists (select 1 from jsonb_array_elements(coalesce(new.arts, '[]')) o where o->>'id' = a->>'id');
  if added <> '[]' or removed <> '[]' then
   insert into public.social_leads_post_events(company_id, contract_id, plan_id, number, kind, via, actor_id, actor_name, detail)
   values (new.company_id, new.contract_id, new.plan_id, new.number, 'arts', 'team', me, me_name,
    jsonb_build_object('added', added, 'removed', removed));
  end if;
 end if;

 -- Tarefa de arte criada ("Liberar produção").
 if new.task_id is not null and old.task_id is distinct from new.task_id then
  select * into t from public.tasks where id = new.task_id;
  insert into public.social_leads_post_events(company_id, contract_id, plan_id, number, kind, via, actor_id, actor_name, detail)
  values (new.company_id, new.contract_id, new.plan_id, new.number, 'task', 'team', me, me_name,
   jsonb_strip_nulls(jsonb_build_object('task', new.task_id,
    'assignee', nullif(mavi_private.social_leads_person(new.company_id, t.assignee_id), ''),
    'team', (select name from public.teams where company_id = new.company_id and id = t.team_id),
    'due', t.due_date)));
 end if;
 return null;
end $$;
revoke all on function mavi_private.social_leads_log_post() from public, anon, authenticated;

drop trigger if exists social_leads_log_post on public.social_leads_posts;
create trigger social_leads_log_post after insert or update on public.social_leads_posts
 for each row execute function mavi_private.social_leads_log_post();

-- Um comentário da equipe no post (quem vê o cliente pode comentar).
create or replace function public.social_leads_comment(p_plan uuid, p_number integer, p_note text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare p public.social_leads_plans; e uuid; begin
 select * into p from public.social_leads_plans where id = p_plan;
 if not found or not mavi_private.member(p.company_id) or not mavi_private.contract_read(p.company_id, p.contract_id) then
  raise exception 'Plano não encontrado.' using errcode = 'P0002';
 end if;
 if length(trim(coalesce(p_note, ''))) = 0 then raise exception 'Escreva o comentário.' using errcode = '22023'; end if;
 if length(p_note) > 2000 then raise exception 'O comentário passou de 2.000 caracteres.' using errcode = '22023'; end if;
 if not exists (select 1 from public.social_leads_posts where plan_id = p.id and number = p_number) then
  raise exception 'Post não encontrado.' using errcode = 'P0002';
 end if;
 insert into public.social_leads_post_events(company_id, contract_id, plan_id, number, kind, via, actor_id, actor_name, note)
 values (p.company_id, p.contract_id, p.id, p_number, 'comment', 'team', auth.uid(),
  mavi_private.social_leads_person(p.company_id, auth.uid()), trim(p_note))
 returning id into e;
 perform mavi_private.broadcast(p.company_id, jsonb_build_object(
  'kind', 'social_leads', 'contract', p.contract_id, 'table', 'social_leads_post_events'));
 return e;
end $$;
revoke all on function public.social_leads_comment(uuid, integer, text) from public, anon;
grant execute on function public.social_leads_comment(uuid, integer, text) to authenticated;

-- O que já aconteceu nos posts existentes (uma vez: só onde ainda não há histórico).
insert into public.social_leads_post_events(company_id, contract_id, plan_id, number, kind, via, actor_id, actor_name, detail, created_at)
select x.company_id, x.contract_id, x.plan_id, x.number, 'created', case when p.source = 'ai' then 'ai' else 'team' end,
 p.created_by, mavi_private.social_leads_person(p.company_id, p.created_by), jsonb_build_object('source', p.source), p.created_at
from public.social_leads_posts x join public.social_leads_plans p on p.id = x.plan_id
where not exists (select 1 from public.social_leads_post_events e where e.plan_id = x.plan_id and e.number = x.number)
order by p.created_at, x.number;

insert into public.social_leads_post_events(company_id, contract_id, plan_id, number, kind, via, actor_id, actor_name, note, created_at)
select x.company_id, x.contract_id, x.plan_id, x.number, x.decision, coalesce(x.decided_via, 'team'),
 case when x.decided_via = 'link' then null else x.decided_by end,
 case when x.decided_via = 'link' then mavi_private.social_leads_client_name(x.company_id, x.contract_id)
  else mavi_private.social_leads_person(x.company_id, x.decided_by) end,
 x.note, x.decided_at
from public.social_leads_posts x
where x.decision <> 'pending' and x.decided_at is not null
 and not exists (select 1 from public.social_leads_post_events e
  where e.plan_id = x.plan_id and e.number = x.number and e.kind in ('approved', 'rejected'))
order by x.decided_at;

insert into public.social_leads_post_events(company_id, contract_id, plan_id, number, kind, via, actor_id, actor_name, detail, created_at)
select x.company_id, x.contract_id, x.plan_id, x.number, 'task', 'team', t.creator_id,
 mavi_private.social_leads_person(x.company_id, t.creator_id),
 jsonb_strip_nulls(jsonb_build_object('task', t.id,
  'assignee', nullif(mavi_private.social_leads_person(x.company_id, t.assignee_id), ''),
  'team', (select name from public.teams where company_id = x.company_id and id = t.team_id), 'due', t.due_date)),
 t.created_at
from public.social_leads_posts x join public.tasks t on t.id = x.task_id
where not exists (select 1 from public.social_leads_post_events e where e.plan_id = x.plan_id and e.number = x.number and e.kind = 'task')
order by t.created_at;

insert into public.social_leads_post_events(company_id, contract_id, plan_id, number, kind, via, actor_name, detail, created_at)
select x.company_id, x.contract_id, x.plan_id, x.number, 'arts', 'team', '',
 jsonb_build_object('added', (select jsonb_agg(jsonb_build_object('id', a->>'id', 'name', a->>'name', 'type', a->>'type'))
  from jsonb_array_elements(x.arts) a), 'removed', '[]'::jsonb), x.updated_at
from public.social_leads_posts x
where jsonb_array_length(coalesce(x.arts, '[]')) > 0
 and not exists (select 1 from public.social_leads_post_events e where e.plan_id = x.plan_id and e.number = x.number and e.kind = 'arts');

notify pgrst, 'reload schema';

commit;
