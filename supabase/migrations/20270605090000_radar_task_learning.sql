begin;

-- MAVI · Radar do cliente: aprender com as tarefas (Fase 1, a captura).
--
-- A MAVI vai aprender quando um item do Radar pede tarefa, para quem e com
-- que prazo, para depois sugerir (e, liberada, criar sozinha). Esta fase só
-- guarda o material, sem LLM:
-- * created: a tarefa criada pelo "Criar tarefa" do item, com o que veio
--   preenchido no formulário (preset) e o que a pessoa mudou (changed);
-- * linked: uma tarefa que já existia vinculada ao item ("pede tarefa");
-- * no_task: o item fechado (Resolvido/Descartado…) sem nenhuma tarefa
--   ("quando NÃO abrir"); se depois ganhar tarefa, o registro sai
--   (removed_reason 'task_later'); se o item reabrir, fica marcado
--   (reopened_at: talvez precisasse de tarefa).
-- Desvincular tira o registro da tarefa (removed_reason 'unlinked').
-- O que já existe entra de uma vez (backfill), sem custo.
-- A leitura (radar_task_learning) é a aba "Tarefas do Radar" do Painel da
-- MAVI, só para administradores e gestores.

-- ------------------------------------------------------------ os registros
create table public.radar_task_signals (
 id uuid primary key default gen_random_uuid(),
 company_id uuid not null references public.companies(id) on delete cascade,
 item_id uuid not null references public.radar_items(id) on delete cascade,
 client_id uuid not null,
 topic_id uuid not null,
 -- Nulo: Geral / Agência.
 product_id uuid,
 theme_id uuid,
 severity smallint,
 kind text not null check (kind in ('created', 'linked', 'no_task')),
 task_id uuid references public.tasks(id) on delete set null,
 -- Quem criou/vinculou/fechou (nulo: a MAVI).
 user_id uuid,
 -- O que veio preenchido no formulário (só 'created' pelo item).
 preset jsonb check (preset is null or jsonb_typeof(preset) = 'object'),
 -- A tarefa como foi salva ({title, contract_id, product_id, assignee_id,
 -- team_id, team_ids, due, due_days, priority}) ou o fechamento do item
 -- ({status, label, resolved}).
 final jsonb not null default '{}' check (jsonb_typeof(final) = 'object'),
 changed text[] not null default '{}',
 backfill boolean not null default false,
 removed_at timestamptz,
 removed_reason text check (removed_reason in ('unlinked', 'task_later')),
 reopened_at timestamptz,
 created_at timestamptz not null default now()
);
create unique index radar_task_signals_task on public.radar_task_signals (item_id, task_id) where task_id is not null;
create index radar_task_signals_company on public.radar_task_signals (company_id, created_at desc);
create index radar_task_signals_group on public.radar_task_signals (company_id, topic_id, product_id);
alter table public.radar_task_signals enable row level security;
revoke all on public.radar_task_signals from public, anon, authenticated;

-- ------------------------------------------------------------ a tarefa salva
-- A equipe: a da tarefa ou, mandada a uma pessoa, a equipe dela que atende o
-- cliente (quando é uma só); team_ids guarda todas as que atendem.
create function mavi_private.radar_task_final(c uuid, t public.tasks, p_client uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_teams uuid[]; begin
 select coalesce(array_agg(tm.team_id order by tm.team_id), '{}') into v_teams from public.team_members tm
 where tm.company_id = c and tm.user_id = t.assignee_id
  and tm.team_id = any(mavi_private.personal_radar_client_teams(c, p_client));
 return jsonb_strip_nulls(jsonb_build_object(
  'title', t.title,
  'contract_id', t.contract_id,
  'product_id', (select k.product_id from public.contracts k where k.company_id = c and k.id = t.contract_id),
  'assignee_id', t.assignee_id,
  'team_id', coalesce(t.team_id, case when cardinality(v_teams) = 1 then v_teams[1] end),
  'by_team', t.team_id is not null,
  'team_ids', case when cardinality(v_teams) > 0 then to_jsonb(v_teams) end,
  'due', t.due_date,
  'due_days', mavi_private.business_days_between(c,
    (t.created_at at time zone mavi_private.company_tz(c))::date, t.due_date),
  'priority', t.priority,
  'subtask', case when t.parent_id is not null then true end));
end $$;
revoke all on function mavi_private.radar_task_final(uuid, public.tasks, uuid) from public, anon, authenticated;

-- O texto de uma descrição (as "text" do documento), para comparar sem a forma.
create function mavi_private.radar_task_text(p text) returns text
language sql immutable set search_path = '' as $$
 select lower(regexp_replace(case when left(btrim(coalesce(p, '')), 1) = '{'
   then coalesce((select string_agg(m[1], ' ')
    from regexp_matches(p, '"text"\s*:\s*"((?:[^"\\]|\\.)*)"', 'g') m), '')
   else coalesce(p, '') end,
  '[^[:alnum:]]+', '', 'g'))
$$;
revoke all on function mavi_private.radar_task_text(text) from public, anon, authenticated;

-- Grava (ou atualiza) o registro da tarefa do item. Com o preset, guarda o
-- que veio preenchido e o que mudou. Tira o "fechado sem tarefa" do item.
create function mavi_private.radar_task_record(c uuid, p_item uuid, p_task uuid, p_kind text, p_preset jsonb,
 p_user uuid, p_backfill boolean default false, p_at timestamptz default now()) returns void
language plpgsql security definer set search_path = '' as $$
declare i public.radar_items; t public.tasks; v_changed text[] := '{}'; p jsonb; begin
 select * into i from public.radar_items where company_id = c and id = p_item;
 select * into t from public.tasks where company_id = c and id = p_task;
 if i.id is null or t.id is null then return; end if;
 p := case when jsonb_typeof(p_preset) = 'object' then p_preset end;
 if p is not null then
  v_changed := array_remove(array[
   case when p ? 'title' and lower(btrim(t.title)) <> lower(btrim(p->>'title')) then 'title' end,
   case when p ? 'description' and mavi_private.radar_task_text(t.description)
     <> mavi_private.radar_task_text(p->>'description') then 'description' end,
   case when p ? 'contract' and t.contract_id::text is distinct from p->>'contract' then 'product' end,
   case when p ? 'due' and t.due_date::text is distinct from p->>'due' then 'due' end,
   case when p ? 'assignee' and t.assignee_id::text is distinct from p->>'assignee' then 'assignee' end,
   case when p ? 'team' and t.team_id::text is distinct from p->>'team' then 'team' end,
   case when t.priority <> coalesce(p->>'priority', 'normal') then 'priority' end], null);
 end if;
 insert into public.radar_task_signals as x (company_id, item_id, client_id, topic_id, product_id, theme_id, severity,
  kind, task_id, user_id, preset, final, changed, backfill, created_at)
 values (c, i.id, i.client_id, i.topic_id, i.product_id, i.theme_id, i.severity, p_kind, t.id, p_user, p,
  mavi_private.radar_task_final(c, t, i.client_id), v_changed, p_backfill, p_at)
 on conflict (item_id, task_id) where task_id is not null do update set
  kind = case when excluded.kind = 'created' then 'created' else x.kind end,
  preset = coalesce(excluded.preset, x.preset),
  changed = case when excluded.preset is not null then excluded.changed else x.changed end,
  final = excluded.final,
  user_id = coalesce(x.user_id, excluded.user_id),
  removed_at = null, removed_reason = null;
 update public.radar_task_signals set removed_at = now(), removed_reason = 'task_later'
 where company_id = c and item_id = i.id and kind = 'no_task' and removed_at is null;
end $$;
revoke all on function mavi_private.radar_task_record(uuid, uuid, uuid, text, jsonb, uuid, boolean, timestamptz)
 from public, anon, authenticated;

-- ------------------------------------------------------------ criar e vincular
-- A de 20270107090000, que agora também guarda o registro: tarefa recém-criada
-- por quem vincula conta como 'created'; as demais, 'linked'.
create or replace function public.link_radar_task(p_company uuid, p_item uuid, p_task uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare v_new integer; t public.tasks; begin
 if not mavi_private.module_client(p_company, 'radar',
   (select client_id from public.radar_items where company_id = p_company and id = p_item)) then
  raise exception 'Sem permissão' using errcode = '42501';
 end if;
 if not exists (select 1 from public.radar_items where company_id = p_company and id = p_item) then
  raise exception 'Item não encontrado.' using errcode = 'P0002';
 end if;
 select * into t from public.tasks where company_id = p_company and id = p_task;
 if t.id is null then
  raise exception 'Tarefa não encontrada.' using errcode = 'P0002';
 end if;
 if not mavi_private.leader(p_company) and not mavi_private.task_access(p_company, p_task) then
  raise exception 'Tarefa não encontrada.' using errcode = 'P0002';
 end if;
 insert into public.radar_item_tasks(company_id, item_id, task_id, created_by)
 values (p_company, p_item, p_task, auth.uid()) on conflict do nothing;
 get diagnostics v_new = row_count;
 if v_new > 0 or not exists (select 1 from public.radar_task_signals where item_id = p_item and task_id = p_task
   and removed_at is null) then
  perform mavi_private.radar_task_record(p_company, p_item, p_task,
   case when t.creator_id = auth.uid() and t.created_at > now() - interval '30 minutes' then 'created' else 'linked' end,
   null, auth.uid());
 end if;
end $$;

-- "Criar tarefa" no item: liga a tarefa e guarda o que veio preenchido no
-- formulário (title, description, contract, due, assignee, team, priority).
create function public.radar_task_created(p_company uuid, p_item uuid, p_task uuid, p_preset jsonb default null)
returns void language plpgsql security definer set search_path = '' as $$
declare p jsonb; begin
 perform public.link_radar_task(p_company, p_item, p_task);
 if jsonb_typeof(p_preset) = 'object' and length(p_preset::text) <= 60000 then
  select jsonb_object_agg(key, value) into p from jsonb_each(p_preset)
  where key in ('title', 'description', 'contract', 'due', 'assignee', 'team', 'priority')
   and jsonb_typeof(value) = 'string';
 end if;
 perform mavi_private.radar_task_record(p_company, p_item, p_task, 'created', p, auth.uid());
end $$;

-- A de 20270321090000, que agora também tira o registro da tarefa.
create or replace function public.unlink_radar_task(p_company uuid, p_item uuid, p_task uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare v_client uuid; begin
 select client_id into v_client from public.radar_items where company_id = p_company and id = p_item;
 if not found then raise exception 'Item não encontrado.' using errcode = 'P0002'; end if;
 if not mavi_private.module_client(p_company, 'radar', v_client) then
  raise exception 'Sem permissão' using errcode = '42501';
 end if;
 delete from public.radar_item_tasks where company_id = p_company and item_id = p_item and task_id = p_task;
 update public.radar_task_signals set removed_at = now(), removed_reason = 'unlinked'
 where company_id = p_company and item_id = p_item and task_id = p_task and removed_at is null;
end $$;

-- ------------------------------------------------------------ fechado sem tarefa
create function mavi_private.radar_task_closed() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_statuses jsonb; s jsonb; o jsonb; begin
 if new.status is not distinct from old.status then return null; end if;
 select statuses into v_statuses from public.radar_topics where company_id = new.company_id and id = new.topic_id;
 s := mavi_private.radar_status(v_statuses, new.status);
 o := mavi_private.radar_status(v_statuses, old.status);
 if s->>'kind' = 'closed' and coalesce(o->>'kind', '') <> 'closed' then
  if not exists (select 1 from public.radar_item_tasks where item_id = new.id) then
   insert into public.radar_task_signals(company_id, item_id, client_id, topic_id, product_id, theme_id, severity,
    kind, user_id, final)
   values (new.company_id, new.id, new.client_id, new.topic_id, new.product_id, new.theme_id, new.severity,
    'no_task', new.status_by, jsonb_build_object('status', new.status, 'label', s->>'label',
     'resolved', coalesce((s->>'reopen')::boolean, false),
     'open_days', greatest(0, (now()::date - new.first_seen_at::date))));
  end if;
 elsif o->>'kind' = 'closed' and coalesce(s->>'kind', '') <> 'closed' then
  update public.radar_task_signals set reopened_at = now()
  where company_id = new.company_id and item_id = new.id and kind = 'no_task' and removed_at is null
   and reopened_at is null;
 end if;
 return null;
end $$;
revoke all on function mavi_private.radar_task_closed() from public, anon, authenticated;
create trigger radar_items_task_closed after update of status on public.radar_items
 for each row execute function mavi_private.radar_task_closed();

-- ------------------------------------------------------------ o que já existe
do $$ declare l record; begin
 for l in select it.company_id, it.item_id, it.task_id, it.created_by, it.created_at, t.created_at as task_at,
   t.creator_id
  from public.radar_item_tasks it join public.tasks t on t.company_id = it.company_id and t.id = it.task_id
 loop
  perform mavi_private.radar_task_record(l.company_id, l.item_id, l.task_id,
   case when abs(extract(epoch from l.created_at - l.task_at)) < 1800 then 'created' else 'linked' end,
   null, l.created_by, true, l.created_at);
 end loop;
end $$;
insert into public.radar_task_signals(company_id, item_id, client_id, topic_id, product_id, theme_id, severity,
 kind, user_id, final, backfill, created_at)
select i.company_id, i.id, i.client_id, i.topic_id, i.product_id, i.theme_id, i.severity, 'no_task', i.status_by,
 jsonb_build_object('status', i.status, 'label', s->>'label', 'resolved', coalesce((s->>'reopen')::boolean, false),
  'open_days', greatest(0, i.status_at::date - i.first_seen_at::date)),
 true, i.status_at
from public.radar_items i
join public.radar_topics tp on tp.company_id = i.company_id and tp.id = i.topic_id
cross join lateral (select mavi_private.radar_status(tp.statuses, i.status) as s) x
where s->>'kind' = 'closed'
 and not exists (select 1 from public.radar_item_tasks it where it.item_id = i.id);

-- ------------------------------------------------------------ a leitura
-- Para o Painel da MAVI (administradores e gestores): por tópico × produto,
-- quantos itens viraram tarefa e quantos fecharam sem, para quais equipes e
-- pessoas, o prazo típico (dias úteis), a prioridade e o que as pessoas
-- mudam no que veio preenchido; mais os últimos registros.
-- p_filters: {days (30–730, padrão 180), topic, product ('general' = Geral)}.
create function public.radar_task_learning(p_company uuid, p_filters jsonb default '{}') returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare f jsonb := coalesce(p_filters, '{}'); v_days integer; v_topic uuid; v_product uuid; v_general boolean;
 v_since timestamptz; begin
 if not mavi_private.leader(p_company) then raise exception 'Sem permissão' using errcode = '42501'; end if;
 v_days := least(730, greatest(30, coalesce(case when f->>'days' ~ '^\d+$' then (f->>'days')::integer end, 180)));
 v_topic := case when f->>'topic' ~* '^[0-9a-f-]{36}$' then (f->>'topic')::uuid end;
 v_general := coalesce(f->>'product' = 'general', false);
 v_product := case when f->>'product' ~* '^[0-9a-f-]{36}$' then (f->>'product')::uuid end;
 v_since := now() - make_interval(days => v_days);
 return (
  with s as (
   select x.* from public.radar_task_signals x
   where x.company_id = p_company and x.created_at >= v_since
    and (v_topic is null or x.topic_id = v_topic)
    and (not v_general or x.product_id is null)
    and (v_product is null or x.product_id = v_product)
  ), live as (select * from s where removed_at is null),
  g as (
   select l.topic_id, l.product_id,
    count(*) filter (where l.kind = 'created') as created,
    count(*) filter (where l.kind = 'linked') as linked,
    count(distinct l.item_id) filter (where l.kind in ('created', 'linked')) as items_task,
    count(*) filter (where l.kind = 'no_task') as no_task,
    count(*) filter (where l.kind = 'no_task' and l.user_id is null) as no_task_mavi,
    count(*) filter (where l.kind = 'no_task' and l.reopened_at is not null) as no_task_reopened,
    count(*) filter (where l.kind = 'created' and l.preset is not null) as with_preset,
    count(*) filter (where l.kind = 'created' and l.preset is not null and cardinality(l.changed) = 0) as as_preset,
    percentile_disc(0.5) within group (order by (l.final->>'due_days')::integer)
     filter (where l.kind in ('created', 'linked') and l.final ? 'due_days') as due_days
   from live l group by l.topic_id, l.product_id
  )
  select jsonb_build_object(
   'since', v_since, 'days', v_days,
   'totals', (select jsonb_build_object(
     'created', count(*) filter (where kind = 'created'),
     'linked', count(*) filter (where kind = 'linked'),
     'no_task', count(*) filter (where kind = 'no_task'),
     'with_preset', count(*) filter (where kind = 'created' and preset is not null),
     'as_preset', count(*) filter (where kind = 'created' and preset is not null and cardinality(changed) = 0))
    from live),
   'groups', (select coalesce(jsonb_agg(jsonb_build_object(
     'topic_id', g.topic_id, 'topic_name', tp.name, 'topic_color', tp.color,
     'product_id', g.product_id, 'product_name', pr.name,
     'created', g.created, 'linked', g.linked, 'items_task', g.items_task, 'no_task', g.no_task,
     'no_task_mavi', g.no_task_mavi, 'no_task_reopened', g.no_task_reopened,
     'with_preset', g.with_preset, 'as_preset', g.as_preset, 'due_days', g.due_days,
     'teams', (select coalesce(jsonb_agg(jsonb_build_object('id', z.team_id, 'name', tm.name, 'n', z.n)
        order by z.n desc, tm.name), '[]')
       from (select (l.final->>'team_id')::uuid as team_id, count(*) as n from live l
        where l.topic_id = g.topic_id and l.product_id is not distinct from g.product_id
         and l.kind in ('created', 'linked') and l.final ? 'team_id' group by 1 order by 2 desc limit 4) z
       join public.teams tm on tm.company_id = p_company and tm.id = z.team_id),
     'people', (select coalesce(jsonb_agg(jsonb_build_object('id', z.user_id, 'name', m.name, 'n', z.n)
        order by z.n desc, m.name), '[]')
       from (select (l.final->>'assignee_id')::uuid as user_id, count(*) as n from live l
        where l.topic_id = g.topic_id and l.product_id is not distinct from g.product_id
         and l.kind in ('created', 'linked') and l.final ? 'assignee_id' group by 1 order by 2 desc limit 4) z
       join public.memberships m on m.company_id = p_company and m.user_id = z.user_id),
     'priorities', (select coalesce(jsonb_object_agg(z.p, z.n), '{}')
       from (select l.final->>'priority' as p, count(*) as n from live l
        where l.topic_id = g.topic_id and l.product_id is not distinct from g.product_id
         and l.kind in ('created', 'linked') and l.final ? 'priority' group by 1) z),
     'changed', (select coalesce(jsonb_object_agg(z.c, z.n), '{}')
       from (select c, count(*) as n from live l cross join unnest(l.changed) c
        where l.topic_id = g.topic_id and l.product_id is not distinct from g.product_id
         and l.kind = 'created' group by c) z),
     'severity', (select coalesce(jsonb_agg(jsonb_build_object('severity', z.severity, 'task', z.task, 'no_task', z.no_task)
        order by z.severity nulls first), '[]')
       from (select l.severity, count(*) filter (where l.kind in ('created', 'linked')) as task,
         count(*) filter (where l.kind = 'no_task') as no_task from live l
        where l.topic_id = g.topic_id and l.product_id is not distinct from g.product_id group by l.severity) z))
    order by g.items_task + g.no_task desc, tp.name, pr.name nulls first), '[]')
    from g join public.radar_topics tp on tp.company_id = p_company and tp.id = g.topic_id
    left join public.products pr on pr.company_id = p_company and pr.id = g.product_id),
   'recent', (select coalesce(jsonb_agg(r.j order by r.at desc), '[]') from (
     select x.created_at as at, jsonb_strip_nulls(jsonb_build_object(
      'id', x.id, 'kind', x.kind, 'created_at', x.created_at, 'item_id', x.item_id, 'item_title', i.title,
      'client_name', cl.name, 'topic_name', tp.name, 'topic_color', tp.color, 'product_name', pr.name,
      'severity', x.severity, 'user_name', um.name, 'task_id', x.task_id, 'task_title', t.title,
      'task_status', t.status, 'changed', case when cardinality(x.changed) > 0 then to_jsonb(x.changed) end,
      'suggested', case when x.preset is not null then true end,
      'team_name', (select tm.name from public.teams tm where tm.company_id = p_company and tm.id::text = x.final->>'team_id'),
      'by_team', (x.final->>'by_team')::boolean,
      'assignee_name', (select m.name from public.memberships m where m.company_id = p_company
        and m.user_id::text = x.final->>'assignee_id'),
      'due_days', (x.final->>'due_days')::integer, 'priority', x.final->>'priority',
      'status_label', x.final->>'label', 'backfill', case when x.backfill then true end,
      'removed_reason', x.removed_reason, 'reopened', case when x.reopened_at is not null then true end)) as j
     from s x
     join public.radar_items i on i.id = x.item_id
     join public.clients cl on cl.company_id = p_company and cl.id = x.client_id
     join public.radar_topics tp on tp.company_id = p_company and tp.id = x.topic_id
     left join public.products pr on pr.company_id = p_company and pr.id = x.product_id
     left join public.memberships um on um.company_id = p_company and um.user_id = x.user_id
     left join public.tasks t on t.company_id = p_company and t.id = x.task_id
     order by x.created_at desc limit 60) r)));
end $$;

revoke all on function public.radar_task_created(uuid, uuid, uuid, jsonb), public.radar_task_learning(uuid, jsonb)
 from public, anon;
grant execute on function public.radar_task_created(uuid, uuid, uuid, jsonb), public.radar_task_learning(uuid, jsonb)
 to authenticated;

commit;
