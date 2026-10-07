begin;

-- MAVI · Radar do cliente: a tarefa sugerida no item (Fase 3).
--
-- Com as regras EM USO (Fase 2), a MAVI olha cada item novo ou reaberto que
-- ainda não tem tarefa e decide: sugerir a tarefa (título, descrição,
-- equipe — e pessoa só quando a regra diz —, prazo em dias úteis,
-- prioridade, a regra e o porquê), sugerir vincular uma tarefa aberta do
-- cliente que já trata do assunto, ou ficar quieta (sem regra que se
-- aplique, ou uma regra de "não abrir"). Só sugere quando uma regra em uso
-- sustenta.
-- * A pessoa cria pelo formulário de tarefa preenchido com a sugestão
--   (sempre revisando) ou recusa com um motivo pronto (não precisa, já
--   existe, equipe/pessoa errada, prazo errado, outro). A recusa vira um
--   registro 'dismissed' que alimenta as regras; a criada guarda que veio da
--   sugestão (from_suggestion, rule_id) e o que mudou — a taxa de acerto da
--   Fase 4.
-- * Ligado à parte (radar_task_settings.suggest, desligado de fábrica), com
--   o custo estimado antes. Ao ligar, ou quando uma regra entra em uso, a
--   MAVI revisa até 50 itens abertos sem tarefa dos últimos 30 dias.
-- * Item fechado com a sugestão em aberto: a sugestão expira. Tarefa criada
--   ou vinculada por outro caminho: a sugestão fica "substituída".

-- ------------------------------------------------------------ configuração
alter table public.radar_task_settings
 add column suggest boolean not null default false,
 add column suggest_by uuid,
 add column suggest_at timestamptz;

-- ------------------------------------------------------------ os registros
alter table public.radar_task_signals drop constraint radar_task_signals_kind_check;
alter table public.radar_task_signals add constraint radar_task_signals_kind_check
 check (kind in ('created', 'linked', 'no_task', 'dismissed'));
alter table public.radar_task_signals
 add column from_suggestion boolean not null default false,
 add column rule_id uuid references public.radar_task_rules(id) on delete set null;

-- ------------------------------------------------------------ as sugestões
create table public.radar_task_suggestions (
 item_id uuid primary key references public.radar_items(id) on delete cascade,
 company_id uuid not null references public.companies(id) on delete cascade,
 -- pending: na fila; open: sugestão à mostra; none: a MAVI não sugere nada;
 -- created: aceita (tarefa criada ou vinculada pela sugestão); replaced:
 -- tarefa por outro caminho; dismissed: recusada; expired: item fechado.
 status text not null default 'pending'
  check (status in ('pending', 'open', 'none', 'created', 'replaced', 'dismissed', 'expired', 'failed')),
 decision text check (decision in ('task', 'link', 'no_task', 'unsure')),
 rule_id uuid references public.radar_task_rules(id) on delete set null,
 title text check (title is null or length(title) <= 240),
 description text check (description is null or length(description) <= 4000),
 team_id uuid,
 assignee_id uuid,
 due_days smallint,
 due_date date,
 priority text check (priority in ('low', 'normal', 'high', 'urgent')),
 why text check (why is null or length(why) <= 600),
 link_task_id uuid references public.tasks(id) on delete set null,
 task_id uuid references public.tasks(id) on delete set null,
 reason text check (reason in ('not_needed', 'exists', 'wrong_person', 'wrong_due', 'other')),
 note text check (note is null or length(note) <= 1000),
 decided_by uuid,
 decided_at timestamptz,
 attempts integer not null default 0,
 claimed_until timestamptz,
 last_error text,
 cost_usd numeric not null default 0,
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now()
);
create index radar_task_suggestions_pending on public.radar_task_suggestions (created_at) where status = 'pending';
create index radar_task_suggestions_company on public.radar_task_suggestions (company_id, status);
alter table public.radar_task_suggestions enable row level security;
revoke all on public.radar_task_suggestions from public, anon, authenticated;

-- O status do item é aberto (não fechado)?
create function mavi_private.radar_item_open(i public.radar_items) returns boolean
language sql stable security definer set search_path = '' as $$
 select coalesce((select mavi_private.radar_status(t.statuses, i.status)->>'kind' from public.radar_topics t
  where t.company_id = i.company_id and t.id = i.topic_id), 'open') <> 'closed'
$$;
revoke all on function mavi_private.radar_item_open(public.radar_items) from public, anon, authenticated;

-- Há regra em uso para o tópico × produto do item?
create function mavi_private.radar_item_has_rules(i public.radar_items) returns boolean
language sql stable security definer set search_path = '' as $$
 select exists (select 1 from public.radar_task_rules r where r.company_id = i.company_id and r.topic_id = i.topic_id
  and r.status = 'active' and (r.all_products or r.product_id is not distinct from i.product_id))
$$;
revoke all on function mavi_private.radar_item_has_rules(public.radar_items) from public, anon, authenticated;

-- Põe o item na fila (ligado, aberto, sem tarefa, com regra em uso). p_again:
-- reabriu, então vale de novo mesmo se já teve sugestão.
create function mavi_private.radar_task_suggest_enqueue(i public.radar_items, p_again boolean default false)
returns boolean
language plpgsql security definer set search_path = '' as $$ begin
 if not exists (select 1 from public.radar_task_settings s where s.company_id = i.company_id and s.suggest)
  or not mavi_private.radar_item_open(i) or not mavi_private.radar_item_has_rules(i)
  or exists (select 1 from public.radar_item_tasks t where t.item_id = i.id) then
  return false;
 end if;
 insert into public.radar_task_suggestions as s (item_id, company_id)
 values (i.id, i.company_id)
 on conflict (item_id) do update set status = 'pending', decision = null, rule_id = null, title = null,
  description = null, team_id = null, assignee_id = null, due_days = null, due_date = null, priority = null,
  why = null, link_task_id = null, task_id = null, reason = null, note = null, decided_by = null, decided_at = null,
  attempts = 0, claimed_until = null, last_error = null, updated_at = now()
 where p_again or s.status in ('failed');
 return found;
end $$;
revoke all on function mavi_private.radar_task_suggest_enqueue(public.radar_items, boolean) from public, anon, authenticated;

-- Os itens abertos, sem tarefa e vistos nos últimos 30 dias de um tópico ×
-- produto (ou de todos com regra em uso), até p_limit, sem sugestão ainda.
create function mavi_private.radar_task_suggest_backlog(c uuid, p_topic uuid, p_product uuid, p_all boolean,
 p_limit integer default 50) returns integer
language plpgsql security definer set search_path = '' as $$
declare i public.radar_items; n integer := 0; begin
 for i in select x.* from public.radar_items x
  where x.company_id = c and (p_topic is null or x.topic_id = p_topic)
   and (p_topic is null or p_all or x.product_id is not distinct from p_product)
   and x.last_seen_at > now() - interval '30 days'
   and not exists (select 1 from public.radar_task_suggestions s where s.item_id = x.id)
   and not exists (select 1 from public.radar_item_tasks t where t.item_id = x.id)
  order by x.last_seen_at desc
 loop
  exit when n >= p_limit;
  if mavi_private.radar_task_suggest_enqueue(i) then n := n + 1; end if;
 end loop;
 return n;
end $$;
revoke all on function mavi_private.radar_task_suggest_backlog(uuid, uuid, uuid, boolean, integer) from public, anon, authenticated;

-- Item novo: na fila. Reaberto: na fila de novo. Fechado com a sugestão em
-- aberto: expira.
create function mavi_private.radar_task_suggest_item() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_open boolean; v_was boolean; begin
 if tg_op = 'INSERT' then
  perform mavi_private.radar_task_suggest_enqueue(new);
  return null;
 end if;
 if new.status is not distinct from old.status then return null; end if;
 v_open := mavi_private.radar_item_open(new);
 v_was := mavi_private.radar_item_open(old);
 if v_open and not v_was then
  perform mavi_private.radar_task_suggest_enqueue(new, true);
 elsif not v_open then
  update public.radar_task_suggestions set status = 'expired', claimed_until = null, updated_at = now()
  where item_id = new.id and status in ('pending', 'open');
 end if;
 return null;
end $$;
revoke all on function mavi_private.radar_task_suggest_item() from public, anon, authenticated;
create trigger radar_items_task_suggest after insert or update of status on public.radar_items
 for each row execute function mavi_private.radar_task_suggest_item();

-- Uma regra entrou em uso: revisa os itens abertos do grupo.
create function mavi_private.radar_task_rule_active() returns trigger
language plpgsql security definer set search_path = '' as $$ begin
 if new.status = 'active' and (tg_op = 'INSERT' or old.status is distinct from 'active') then
  perform mavi_private.radar_task_suggest_backlog(new.company_id, new.topic_id, new.product_id, new.all_products);
 end if;
 return null;
end $$;
revoke all on function mavi_private.radar_task_rule_active() from public, anon, authenticated;
create trigger radar_task_rules_active after insert or update of status on public.radar_task_rules
 for each row execute function mavi_private.radar_task_rule_active();

-- A data do prazo: N dias úteis a partir de hoje, no calendário da empresa.
create function mavi_private.radar_task_due(c uuid, n integer) returns date
language sql stable security definer set search_path = '' as $$
 select mavi_private.next_business_day(c, mavi_private.add_company_business_days(c, mavi_private.company_today(c),
  greatest(coalesce(n, 0), 0)))
$$;
revoke all on function mavi_private.radar_task_due(uuid, integer) from public, anon, authenticated;

-- ------------------------------------------------------------ a tarefa criada
-- A da migração 20270605090000: a tarefa ligada ao item fecha a sugestão em
-- aberto ('replaced'; 'created' quando era a tarefa que ela mandou vincular).
create or replace function mavi_private.radar_task_record(c uuid, p_item uuid, p_task uuid, p_kind text, p_preset jsonb,
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
 if not p_backfill then
  update public.radar_task_suggestions set
   status = case when decision = 'link' and link_task_id = t.id then 'created' else 'replaced' end,
   task_id = t.id, decided_by = coalesce(p_user, decided_by), decided_at = now(), claimed_until = null, updated_at = now()
  where item_id = i.id and status in ('pending', 'open');
  if found then
   perform mavi_private.broadcast(c, jsonb_build_object('kind', 'radar_task_suggestion', 'item', i.id));
  end if;
  -- Vincular a tarefa que a MAVI sugeriu: o registro diz que veio da sugestão.
  update public.radar_task_signals x set from_suggestion = true, rule_id = s.rule_id
  from public.radar_task_suggestions s
  where s.item_id = i.id and s.status = 'created' and s.decision = 'link' and s.link_task_id = t.id
   and x.item_id = i.id and x.task_id = t.id;
 end if;
end $$;

-- A da migração 20270605090000: com "suggestion" no que veio preenchido, a
-- tarefa veio da sugestão da MAVI (a sugestão fica 'created').
create or replace function public.radar_task_created(p_company uuid, p_item uuid, p_task uuid, p_preset jsonb default null)
returns void language plpgsql security definer set search_path = '' as $$
declare p jsonb; v_rule uuid; begin
 perform public.link_radar_task(p_company, p_item, p_task);
 if jsonb_typeof(p_preset) = 'object' and length(p_preset::text) <= 60000 then
  select jsonb_object_agg(key, value) into p from jsonb_each(p_preset)
  where key in ('title', 'description', 'contract', 'due', 'assignee', 'team', 'priority')
   and jsonb_typeof(value) = 'string';
 end if;
 perform mavi_private.radar_task_record(p_company, p_item, p_task, 'created', p, auth.uid());
 if jsonb_typeof(p_preset) = 'object' and coalesce(p_preset->>'suggestion', '') <> '' then
  update public.radar_task_suggestions set status = 'created', updated_at = now()
  where company_id = p_company and item_id = p_item and task_id = p_task and status = 'replaced'
  returning rule_id into v_rule;
  if found then
   update public.radar_task_signals set from_suggestion = true, rule_id = v_rule
   where item_id = p_item and task_id = p_task;
  end if;
 end if;
end $$;

-- ------------------------------------------------------------ o worker
-- Reserva até p_limit itens por 10 minutos, com o material: o item (e as
-- últimas falas), as regras em uso, exemplos do mesmo tópico × produto (o
-- mesmo tema primeiro), as tarefas abertas do cliente, as equipes que o
-- atendem e as pessoas delas.
create function public.ai_radar_task_suggest_claim(p_secret text, p_limit integer default 4) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_out jsonb := '[]'; s public.radar_task_suggestions; i public.radar_items; v_teams uuid[]; begin
 if not mavi_private.ai_secret_ok(p_secret) then raise exception 'Sem permissão' using errcode = '42501'; end if;
 for s in select x.* from public.radar_task_suggestions x
  where x.status = 'pending' and x.attempts < 3 and (x.claimed_until is null or x.claimed_until < now())
   and exists (select 1 from public.radar_task_settings z where z.company_id = x.company_id and z.suggest)
  order by x.created_at limit least(greatest(coalesce(p_limit, 4), 1), 10)
  for update skip locked
 loop
  select * into i from public.radar_items where id = s.item_id;
  -- Sem regra em uso, ganhou tarefa ou fechou enquanto esperava: sai da fila.
  if not mavi_private.radar_item_open(i) or not mavi_private.radar_item_has_rules(i)
   or exists (select 1 from public.radar_item_tasks t where t.item_id = i.id) then
   update public.radar_task_suggestions set status = 'none', decision = 'unsure', updated_at = now()
   where item_id = s.item_id;
   continue;
  end if;
  update public.radar_task_suggestions set claimed_until = now() + interval '10 minutes', attempts = attempts + 1
  where item_id = s.item_id;
  v_teams := mavi_private.personal_radar_client_teams(i.company_id, i.client_id);
  v_out := v_out || jsonb_build_array(jsonb_build_object(
   'company', i.company_id, 'item', i.id,
   'item_data', jsonb_strip_nulls(jsonb_build_object('title', i.title, 'summary', i.summary, 'severity', i.severity,
    'mentions', i.mentions, 'due_date', i.due_date,
    'first_seen', to_char(i.first_seen_at at time zone mavi_private.company_tz(i.company_id), 'DD/MM/YYYY'),
    'last_seen', to_char(i.last_seen_at at time zone mavi_private.company_tz(i.company_id), 'DD/MM/YYYY'),
    'reopened', case when i.reopened_at is not null then true end,
    'theme', (select th.title from public.radar_themes th where th.id = i.theme_id),
    'client', (select c.name from public.clients c where c.id = i.client_id),
    'product', (select p.name from public.products p where p.company_id = i.company_id and p.id = i.product_id),
    'topic', (select t.name from public.radar_topics t where t.company_id = i.company_id and t.id = i.topic_id),
    'quotes', (select coalesce(jsonb_agg(left(m.speaker || ': ' || m.quote, 300) order by m.occurred_at desc), '[]')
     from (select * from public.radar_mentions z where z.item_id = i.id order by z.occurred_at desc limit 5) m))),
   'rules', (select coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object('id', r.id, 'action', r.action,
      'condition', r.condition, 'min_severity', r.min_severity, 'team_id', r.team_id,
      'team', (select tm.name from public.teams tm where tm.company_id = r.company_id and tm.id = r.team_id),
      'team_serves', case when r.team_id is not null then r.team_id = any(v_teams) end,
      'assignee_id', r.assignee_id,
      'assignee', (select m.name from public.memberships m where m.company_id = r.company_id and m.user_id = r.assignee_id),
      'due_days', r.due_days, 'priority', r.priority, 'title_hint', r.title_hint)) order by r.created_at), '[]')
    from public.radar_task_rules r where r.company_id = i.company_id and r.topic_id = i.topic_id and r.status = 'active'
     and (r.all_products or r.product_id is not distinct from i.product_id)),
   'examples', (select coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object('kind', x.kind, 'title', it.title,
      'severity', x.severity, 'same_theme', case when x.theme_id is not null and x.theme_id = i.theme_id then true end,
      'team', (select tm.name from public.teams tm where tm.company_id = i.company_id and tm.id::text = x.final->>'team_id'),
      'due_days', (x.final->>'due_days')::integer, 'priority', x.final->>'priority',
      'task_title', case when x.kind in ('created', 'linked') then x.final->>'title' end,
      'closed_as', x.final->>'label', 'reason', x.final->>'reason'))), '[]')
    from (select z.* from public.radar_task_signals z where z.company_id = i.company_id and z.topic_id = i.topic_id
      and z.product_id is not distinct from i.product_id and z.removed_at is null and z.item_id <> i.id
     order by (z.theme_id is not null and z.theme_id = i.theme_id) desc, z.created_at desc limit 12) x
    join public.radar_items it on it.id = x.item_id),
   'open_tasks', (select coalesce(jsonb_agg(jsonb_build_object('id', t.id, 'title', t.title, 'status', t.status,
      'due', t.due_date) order by t.created_at desc), '[]')
    from (select tk.* from public.tasks tk join public.contracts k on k.company_id = tk.company_id and k.id = tk.contract_id
      where tk.company_id = i.company_id and k.client_id = i.client_id and tk.status <> 'done' and not tk.archived
      order by tk.created_at desc limit 15) t),
   'teams', (select coalesce(jsonb_agg(jsonb_build_object('id', t.id, 'name', t.name) order by t.name), '[]')
    from public.teams t where t.company_id = i.company_id and t.id = any(v_teams)),
   'people', (select coalesce(jsonb_agg(jsonb_build_object('id', m.user_id, 'name', m.name) order by m.name), '[]')
    from public.memberships m where m.company_id = i.company_id and m.active
     and exists (select 1 from public.team_members tm where tm.company_id = i.company_id and tm.user_id = m.user_id
      and tm.team_id = any(v_teams)))));
 end loop;
 return v_out;
end $$;

-- A decisão: p_result = {decision: task | link | no_task | unsure, rule_id,
-- title, description, team_id, assignee_id, due_days, priority, why,
-- link_task_id}. Só fica à mostra o que uma regra em uso sustenta; equipe e
-- pessoa só as que atendem o cliente.
create function public.ai_radar_task_suggest_store(p_secret text, p_item uuid, p_result jsonb, p_usage jsonb default '{}')
returns text
language plpgsql security definer set search_path = '' as $$
declare r jsonb := coalesce(p_result, '{}'); i public.radar_items; v_rule public.radar_task_rules; v_decision text;
 v_teams uuid[]; v_team uuid; v_user uuid; v_link uuid; v_due integer; v_status text; v_cost numeric;
 v_uuid text := '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'; begin
 if not mavi_private.ai_secret_ok(p_secret) then raise exception 'Sem permissão' using errcode = '42501'; end if;
 select * into i from public.radar_items where id = p_item;
 if i.id is null then return null; end if;
 v_cost := least(greatest(coalesce((p_usage->>'cost')::numeric, 0), 0), 100);
 if v_cost > 0 or coalesce((p_usage->>'input')::integer, 0) > 0 then
  insert into public.ai_usage(company_id, user_id, module, kind, model, input_tokens, output_tokens,
   cache_read_tokens, cache_write_tokens, cost_usd, provider_id, provider_name)
  values (i.company_id, null, 'radar', 'task_suggest', left(coalesce(p_usage->>'model', ''), 80),
   coalesce((p_usage->>'input')::integer, 0), coalesce((p_usage->>'output')::integer, 0),
   coalesce((p_usage->>'cache_read')::integer, 0), coalesce((p_usage->>'cache_write')::integer, 0), v_cost,
   case when (p_usage->>'provider_id') ~* v_uuid then (p_usage->>'provider_id')::uuid end,
   left(coalesce(p_usage->>'provider', ''), 120));
 end if;
 select x.* into v_rule from public.radar_task_rules x where coalesce(r->>'rule_id', '') ~* v_uuid
  and x.id = (r->>'rule_id')::uuid and x.company_id = i.company_id and x.topic_id = i.topic_id and x.status = 'active'
  and (x.all_products or x.product_id is not distinct from i.product_id);
 v_decision := case when r->>'decision' in ('task', 'link', 'no_task', 'unsure') then r->>'decision' else 'unsure' end;
 -- Sem regra em uso que sustente, ou a regra diz o contrário: não sugere.
 if v_decision in ('task', 'link') and (v_rule.id is null or v_rule.action <> 'task') then v_decision := 'unsure'; end if;
 if v_decision = 'no_task' and (v_rule.id is null or v_rule.action <> 'no_task') then v_decision := 'unsure'; end if;
 v_link := case when v_decision = 'link' and coalesce(r->>'link_task_id', '') ~* v_uuid then (select t.id from public.tasks t
   join public.contracts k on k.company_id = t.company_id and k.id = t.contract_id
   where t.id = (r->>'link_task_id')::uuid and t.company_id = i.company_id and k.client_id = i.client_id
    and t.status <> 'done' and not t.archived) end;
 if v_decision = 'link' and v_link is null then v_decision := 'unsure'; end if;
 if v_decision = 'task' and length(btrim(coalesce(r->>'title', ''))) < 3 then v_decision := 'unsure'; end if;
 v_teams := mavi_private.personal_radar_client_teams(i.company_id, i.client_id);
 if v_decision = 'task' then
  v_team := case when coalesce(r->>'team_id', '') ~* v_uuid and (r->>'team_id')::uuid = any(v_teams)
   then (r->>'team_id')::uuid end;
  v_user := case when coalesce(r->>'assignee_id', '') ~* v_uuid and exists (select 1 from public.team_members tm
    join public.memberships m on m.company_id = tm.company_id and m.user_id = tm.user_id and m.active
    where tm.company_id = i.company_id and tm.user_id = (r->>'assignee_id')::uuid and tm.team_id = any(v_teams))
   then (r->>'assignee_id')::uuid end;
  v_due := case when r->>'due_days' ~ '^\d{1,2}$' and (r->>'due_days')::integer <= 60 then (r->>'due_days')::integer
   else v_rule.due_days end;
 end if;
 v_status := case when v_decision in ('task', 'link') then 'open' else 'none' end;
 update public.radar_task_suggestions set status = v_status, decision = v_decision,
  rule_id = case when v_decision in ('task', 'link', 'no_task') then v_rule.id end,
  title = case when v_decision = 'task' then left(btrim(r->>'title'), 240) end,
  description = case when v_decision = 'task' then nullif(left(btrim(coalesce(r->>'description', '')), 4000), '') end,
  team_id = v_team, assignee_id = v_user, due_days = v_due,
  due_date = case when v_decision = 'task' and v_due is not null then mavi_private.radar_task_due(i.company_id, v_due) end,
  priority = case when v_decision = 'task' and r->>'priority' in ('low', 'normal', 'high', 'urgent') then r->>'priority'
   when v_decision = 'task' then v_rule.priority end,
  why = nullif(left(btrim(coalesce(r->>'why', '')), 600), ''),
  link_task_id = v_link, claimed_until = null, last_error = null, cost_usd = cost_usd + v_cost, updated_at = now()
 where item_id = p_item and status = 'pending';
 if not found then return null; end if;
 if v_status = 'open' then
  perform mavi_private.broadcast(i.company_id, jsonb_build_object('kind', 'radar_task_suggestion', 'item', i.id));
 end if;
 return v_status;
end $$;

create function public.ai_radar_task_suggest_fail(p_secret text, p_item uuid, p_error text) returns void
language plpgsql security definer set search_path = '' as $$ begin
 if not mavi_private.ai_secret_ok(p_secret) then raise exception 'Sem permissão' using errcode = '42501'; end if;
 update public.radar_task_suggestions set claimed_until = now() + make_interval(mins => attempts * 10),
  last_error = left(p_error, 500), status = case when attempts >= 3 then 'failed' else status end, updated_at = now()
 where item_id = p_item and status = 'pending';
end $$;

-- A da migração 20270606090000: também acorda pelas sugestões na fila.
create or replace function mavi_private.ai_radar_kick() returns void
language plpgsql security definer set search_path = '' as $$
declare cfg mavi_private.ai_config; begin
 begin
  perform mavi_private.radar_tick();
 exception when others then
  raise warning 'radar tick failed: %', sqlerrm;
 end;
 begin
  perform mavi_private.personal_radar_kick();
 exception when others then
  raise warning 'personal radar kick failed: %', sqlerrm;
 end;
 select * into cfg from mavi_private.ai_config where id;
 if not found then return; end if;
 if not exists (select 1 from public.radar_signals x where x.status = 'pending' and mavi_private.radar_due(x))
  and not exists (select 1 from public.radar_items i where i.theme_pending and not i.theme_locked
   and i.theme_attempts < 3 and (i.theme_claimed_until is null or i.theme_claimed_until < now()))
  and not exists (select 1 from public.radar_reports r where r.status in ('pending', 'running') and r.attempts < 3
   and (r.claimed_until is null or r.claimed_until < now()))
  and not exists (select 1 from public.radar_report_schedules s where s.active and s.next_run_at <= now())
  and not exists (select 1 from public.radar_task_learning_queue q where mavi_private.radar_task_rules_due(q))
  and not exists (select 1 from public.radar_task_rules r where r.status = 'checking' and r.check_attempts < 3
   and (r.check_claimed_until is null or r.check_claimed_until < now()))
  and not exists (select 1 from public.radar_task_suggestions s where s.status = 'pending' and s.attempts < 3
   and (s.claimed_until is null or s.claimed_until < now())
   and exists (select 1 from public.radar_task_settings z where z.company_id = s.company_id and z.suggest)) then
  return;
 end if;
 perform net.http_post(url := cfg.url, body := '{"action":"ai-radar"}'::jsonb,
  headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || cfg.secret),
  -- O worker trabalha até 4 min (uma leitura leva até ~90 s).
  timeout_milliseconds := 290000);
end $$;

-- ------------------------------------------------------------ as telas
-- A sugestão do item (quem vê o item no Radar; nada para quem não vê).
create function public.radar_task_suggestion(p_company uuid, p_item uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare i public.radar_items; s public.radar_task_suggestions; begin
 select * into i from public.radar_items where company_id = p_company and id = p_item;
 if i.id is null or not mavi_private.module_client(p_company, 'radar', i.client_id) then return null; end if;
 select * into s from public.radar_task_suggestions where item_id = p_item;
 if s.item_id is null then return null; end if;
 return jsonb_strip_nulls(jsonb_build_object('item_id', s.item_id, 'status', s.status, 'decision', s.decision,
  'rule_id', s.rule_id,
  'rule_condition', (select r.condition from public.radar_task_rules r where r.id = s.rule_id),
  'title', s.title, 'description', s.description, 'team_id', s.team_id,
  'team_name', (select t.name from public.teams t where t.company_id = p_company and t.id = s.team_id),
  'assignee_id', s.assignee_id,
  'assignee_name', (select m.name from public.memberships m where m.company_id = p_company and m.user_id = s.assignee_id),
  'due_days', s.due_days, 'due_date', s.due_date, 'priority', s.priority, 'why', s.why,
  'link_task_id', s.link_task_id,
  'link_task_title', (select t.title from public.tasks t where t.id = s.link_task_id),
  'link_task_status', (select t.status from public.tasks t where t.id = s.link_task_id),
  'reason', s.reason, 'note', s.note,
  'decided_by_name', (select m.name from public.memberships m where m.company_id = p_company and m.user_id = s.decided_by),
  'decided_at', s.decided_at, 'updated_at', s.updated_at));
end $$;

-- Recusar com o motivo (quem edita o item). Vira um registro 'dismissed'
-- para as regras aprenderem.
create function public.radar_task_suggestion_dismiss(p_company uuid, p_item uuid, p_reason text, p_note text default '')
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare i public.radar_items; s public.radar_task_suggestions; begin
 select * into i from public.radar_items where company_id = p_company and id = p_item;
 if i.id is null then raise exception 'Item não encontrado.' using errcode = 'P0002'; end if;
 if not mavi_private.module_client(p_company, 'radar', i.client_id) then
  raise exception 'Sem permissão' using errcode = '42501';
 end if;
 if coalesce(p_reason, '') not in ('not_needed', 'exists', 'wrong_person', 'wrong_due', 'other') then
  raise exception 'Escolha o motivo.' using errcode = '22023';
 end if;
 if length(coalesce(p_note, '')) > 1000 then raise exception 'Escreva em até 1.000 caracteres.' using errcode = '22023'; end if;
 if p_reason = 'other' and length(btrim(coalesce(p_note, ''))) < 3 then
  raise exception 'Conte o motivo.' using errcode = '22023';
 end if;
 update public.radar_task_suggestions set status = 'dismissed', reason = p_reason,
  note = nullif(btrim(coalesce(p_note, '')), ''), decided_by = auth.uid(), decided_at = now(), updated_at = now()
 where item_id = p_item and status = 'open'
 returning * into s;
 if s.item_id is null then raise exception 'Não há sugestão em aberto neste item.' using errcode = 'P0002'; end if;
 insert into public.radar_task_signals(company_id, item_id, client_id, topic_id, product_id, theme_id, severity,
  kind, user_id, final, from_suggestion, rule_id)
 values (p_company, i.id, i.client_id, i.topic_id, i.product_id, i.theme_id, i.severity, 'dismissed', auth.uid(),
  jsonb_strip_nulls(jsonb_build_object('reason', p_reason, 'note', s.note, 'decision', s.decision, 'title', s.title,
   'team_id', s.team_id, 'assignee_id', s.assignee_id, 'due_days', s.due_days, 'priority', s.priority)),
  true, s.rule_id);
 perform mavi_private.broadcast(p_company, jsonb_build_object('kind', 'radar_task_suggestion', 'item', i.id));
 return public.radar_task_suggestion(p_company, p_item);
end $$;

-- Os itens com sugestão em aberto (para o selo na lista), nos clientes de quem vê.
create function public.radar_task_suggestion_items(p_company uuid) returns uuid[]
language plpgsql stable security definer set search_path = '' as $$
declare v_clients uuid[]; begin
 if not mavi_private.member(p_company) then return '{}'; end if;
 if not mavi_private.leader(p_company) and not mavi_private.opt_in_on(p_company, 'radar') then return '{}'; end if;
 v_clients := mavi_private.module_scope(p_company, 'radar');
 return coalesce((select array_agg(s.item_id) from public.radar_task_suggestions s
  join public.radar_items i on i.id = s.item_id
  where s.company_id = p_company and s.status = 'open' and (v_clients is null or i.client_id = any(v_clients))), '{}');
end $$;

-- Ligar ou desligar as sugestões (líderes). Ligar revisa os itens abertos
-- recentes dos grupos com regra em uso (até 100).
create function public.set_radar_task_suggest(p_company uuid, p_on boolean) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare n integer := 0; begin
 if not mavi_private.leader(p_company) then
  raise exception 'Só administradores e gestores ligam as sugestões de tarefas do Radar.' using errcode = '42501';
 end if;
 insert into public.radar_task_settings as s (company_id, suggest, suggest_by, suggest_at, updated_at)
 values (p_company, coalesce(p_on, false), auth.uid(), now(), now())
 on conflict (company_id) do update set suggest = excluded.suggest, suggest_by = excluded.suggest_by,
  suggest_at = excluded.suggest_at, updated_at = now();
 if p_on then n := mavi_private.radar_task_suggest_backlog(p_company, null, null, true, 100); end if;
 return jsonb_build_object('suggest', coalesce(p_on, false), 'queued', n);
end $$;

-- O que custa ligar: os itens que entram na fila agora e o custo médio já
-- medido de cada sugestão (ou o preço do modelo).
create function public.radar_task_suggest_estimate(p_company uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$ begin
 if not mavi_private.leader(p_company) then raise exception 'Sem permissão' using errcode = '42501'; end if;
 return jsonb_build_object(
  'items', (select count(*) from (select 1 from public.radar_items x
    where x.company_id = p_company and x.last_seen_at > now() - interval '30 days'
     and mavi_private.radar_item_open(x) and mavi_private.radar_item_has_rules(x)
     and not exists (select 1 from public.radar_task_suggestions s where s.item_id = x.id)
     and not exists (select 1 from public.radar_item_tasks t where t.item_id = x.id) limit 100) z),
  'per_month', (select count(*) from public.radar_items x where x.company_id = p_company
    and x.created_at > now() - interval '30 days' and mavi_private.radar_item_has_rules(x)),
  'avg_cost', (select avg(u.cost_usd) from public.ai_usage u where u.company_id = p_company and u.module = 'radar'
    and u.kind = 'task_suggest' and u.cost_usd > 0),
  'samples', (select count(*) from public.ai_usage u where u.company_id = p_company and u.module = 'radar'
    and u.kind = 'task_suggest' and u.cost_usd > 0),
  'price', (select m from mavi_private.ai_routes rt join mavi_private.ai_providers p on p.id = rt.provider_id and p.active
    cross join lateral jsonb_array_elements(p.models) m
    where rt.company_id = p_company and m->>'id' = rt.model
     and ((rt.scope_type = 'feature' and rt.feature = 'client_radar_tasks') or rt.scope_type = 'company')
    order by case rt.scope_type when 'feature' then 1 else 2 end limit 1));
end $$;

-- Como as sugestões se saíram, por tópico × produto (líderes): sugeridas,
-- aceitas como vieram (equipe/pessoa, prazo, prioridade e produto iguais),
-- aceitas com mudança, recusadas (por motivo),
-- substituídas e expiradas, e quantas a MAVI deixou quieta.
create function public.radar_task_suggestion_stats(p_company uuid, p_filters jsonb default '{}') returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare f jsonb := coalesce(p_filters, '{}'); v_days integer; v_since timestamptz; begin
 if not mavi_private.leader(p_company) then raise exception 'Sem permissão' using errcode = '42501'; end if;
 v_days := least(730, greatest(30, coalesce(case when f->>'days' ~ '^\d+$' then (f->>'days')::integer end, 180)));
 v_since := now() - make_interval(days => v_days);
 return (with s as (
   select x.*, i.topic_id, i.product_id,
    -- Como veio: mesma equipe/pessoa, prazo, prioridade e produto. O título e
    -- a descrição não contam (o formulário escreve o título com a MAVI ao
    -- salvar, usando o sugerido como dica).
    (select not (g.changed && array['product', 'due', 'assignee', 'team', 'priority'])
     from public.radar_task_signals g where g.item_id = x.item_id
     and g.task_id = x.task_id and g.from_suggestion) as as_is
   from public.radar_task_suggestions x join public.radar_items i on i.id = x.item_id
   where x.company_id = p_company and x.updated_at >= v_since
  )
  select jsonb_build_object(
   'settings', (select jsonb_strip_nulls(jsonb_build_object('suggest', coalesce(z.suggest, false), 'suggest_at', z.suggest_at,
     'suggest_by_name', (select m.name from public.memberships m where m.company_id = p_company and m.user_id = z.suggest_by)))
    from (select 1) one left join public.radar_task_settings z on z.company_id = p_company),
   'pending', (select count(*) from public.radar_task_suggestions q where q.company_id = p_company and q.status = 'pending'),
   'groups', (select coalesce(jsonb_agg(jsonb_build_object('topic_id', g.topic_id, 'topic_name', tp.name,
     'topic_color', tp.color, 'product_id', g.product_id, 'product_name', pr.name,
     'open', g.open, 'accepted', g.accepted, 'as_is', g.as_is, 'dismissed', g.dismissed, 'replaced', g.replaced,
     'expired', g.expired, 'quiet', g.quiet, 'reasons', g.reasons)
     order by g.open + g.accepted + g.dismissed + g.replaced + g.expired desc, tp.name), '[]')
    from (select s.topic_id, s.product_id,
      count(*) filter (where s.status = 'open') as open,
      count(*) filter (where s.status = 'created') as accepted,
      count(*) filter (where s.status = 'created' and s.as_is) as as_is,
      count(*) filter (where s.status = 'dismissed') as dismissed,
      count(*) filter (where s.status = 'replaced') as replaced,
      count(*) filter (where s.status = 'expired') as expired,
      count(*) filter (where s.status = 'none') as quiet,
      (select coalesce(jsonb_object_agg(z.reason, z.n), '{}') from (select y.reason, count(*) as n from s y
        where y.topic_id = s.topic_id and y.product_id is not distinct from s.product_id and y.reason is not null
        group by y.reason) z) as reasons
     from s group by s.topic_id, s.product_id) g
    join public.radar_topics tp on tp.company_id = p_company and tp.id = g.topic_id
    left join public.products pr on pr.company_id = p_company and pr.id = g.product_id)));
end $$;

-- A da migração 20270606090000: com as sugestões recusadas no material
-- (kind 'dismissed', com o motivo).
create or replace function public.ai_radar_task_rules_claim(p_secret text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare l public.radar_task_learning_queue; v_product uuid; begin
 if not mavi_private.ai_secret_ok(p_secret) then raise exception 'Sem permissão' using errcode = '42501'; end if;
 select q.* into l from public.radar_task_learning_queue q
 where mavi_private.radar_task_rules_due(q)
 order by q.dirty_at limit 1 for update skip locked;
 if not found then return null; end if;
 update public.radar_task_learning_queue set claimed_until = now() + interval '10 minutes', attempts = attempts + 1
 where company_id = l.company_id and topic_id = l.topic_id and product_key = l.product_key;
 v_product := nullif(l.product_key, '00000000-0000-0000-0000-000000000000'::uuid);
 return jsonb_build_object(
  'company', l.company_id, 'product_key', l.product_key,
  'topic', (select jsonb_build_object('id', t.id, 'name', t.name, 'description', left(t.description, 600),
    'statuses', (select jsonb_agg(jsonb_build_object('label', s->>'label', 'kind', s->>'kind')) from jsonb_array_elements(t.statuses) s))
   from public.radar_topics t where t.company_id = l.company_id and t.id = l.topic_id),
  'product', (select jsonb_build_object('id', p.id, 'name', p.name) from public.products p
   where p.company_id = l.company_id and p.id = v_product),
  'signals', (select coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
     'id', x.id, 'kind', x.kind, 'at', to_char(x.created_at at time zone mavi_private.company_tz(l.company_id), 'DD/MM/YYYY'),
     'title', i.title, 'summary', left(i.summary, 240), 'severity', x.severity,
     'theme', (select th.title from public.radar_themes th where th.id = x.theme_id),
     'client', (select c.name from public.clients c where c.id = x.client_id),
     'mentions', i.mentions,
     'task_title', case when x.kind in ('created', 'linked') then x.final->>'title' end,
     'team_id', x.final->>'team_id', 'by_team', (x.final->>'by_team')::boolean,
     'assignee_id', x.final->>'assignee_id',
     'due_days', (x.final->>'due_days')::integer, 'priority', x.final->>'priority',
     'changed', case when cardinality(x.changed) > 0 then to_jsonb(x.changed) end,
     'from_item', case when x.preset is not null then true end,
     'from_suggestion', case when x.from_suggestion then true end,
     'preset_title', x.preset->>'title',
     'closed_as', x.final->>'label', 'by_mavi', case when x.kind = 'no_task' and x.user_id is null then true end,
     'reason', x.final->>'reason', 'note', left(x.final->>'note', 200), 'suggested_title', case when x.kind = 'dismissed' then x.final->>'title' end,
     'reopened', case when x.reopened_at is not null then true end)) order by x.created_at desc), '[]')
   from (select * from public.radar_task_signals z where z.company_id = l.company_id and z.topic_id = l.topic_id
     and mavi_private.radar_task_key(z.product_id) = l.product_key and z.removed_at is null
    order by z.created_at desc limit 80) x
   join public.radar_items i on i.id = x.item_id),
  'teams', (select coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object('id', t.id, 'name', t.name,
     'product', case when exists (select 1 from public.product_teams pt where pt.company_id = l.company_id
      and pt.product_id = v_product and pt.team_id = t.id) then true end)) order by t.name), '[]')
   from public.teams t where t.company_id = l.company_id),
  'people', (select coalesce(jsonb_agg(jsonb_build_object('id', m.user_id, 'name', m.name) order by m.name), '[]')
   from public.memberships m where m.company_id = l.company_id and m.active
    and m.user_id::text in (select z.final->>'assignee_id' from public.radar_task_signals z
     where z.company_id = l.company_id and z.topic_id = l.topic_id
      and mavi_private.radar_task_key(z.product_id) = l.product_key and z.removed_at is null)),
  'rules', (select coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object('id', r.id, 'action', r.action,
     'condition', r.condition, 'team_id', r.team_id, 'assignee_id', r.assignee_id, 'due_days', r.due_days,
     'priority', r.priority, 'min_severity', r.min_severity, 'title_hint', r.title_hint, 'status', r.status,
     'origin', r.origin, 'all_products', case when r.all_products then true end)) order by r.created_at), '[]')
   from public.radar_task_rules r where r.company_id = l.company_id and r.topic_id = l.topic_id
    and (r.all_products or mavi_private.radar_task_key(r.product_id) = l.product_key)));
end $$;

-- A da migração 20270605090000: com as sugestões recusadas ('dismissed') e
-- as tarefas que vieram da sugestão nos totais e nos últimos registros.
create or replace function public.radar_task_learning(p_company uuid, p_filters jsonb default '{}') returns jsonb
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
     'dismissed', count(*) filter (where kind = 'dismissed'),
     'from_suggestion', count(*) filter (where kind in ('created', 'linked') and from_suggestion),
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
      'from_suggestion', case when x.from_suggestion then true end,
      'reason', x.final->>'reason', 'note', x.final->>'note',
      'suggested_title', case when x.kind = 'dismissed' then x.final->>'title' end,
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

-- ------------------------------------------------------------ permissões
revoke all on function public.ai_radar_task_suggest_claim(text, integer),
 public.ai_radar_task_suggest_store(text, uuid, jsonb, jsonb), public.ai_radar_task_suggest_fail(text, uuid, text),
 public.radar_task_suggestion(uuid, uuid), public.radar_task_suggestion_dismiss(uuid, uuid, text, text),
 public.radar_task_suggestion_items(uuid), public.set_radar_task_suggest(uuid, boolean),
 public.radar_task_suggest_estimate(uuid), public.radar_task_suggestion_stats(uuid, jsonb) from public, anon;
grant execute on function public.ai_radar_task_suggest_claim(text, integer),
 public.ai_radar_task_suggest_store(text, uuid, jsonb, jsonb), public.ai_radar_task_suggest_fail(text, uuid, text)
 to anon, authenticated;
grant execute on function public.radar_task_suggestion(uuid, uuid), public.radar_task_suggestion_dismiss(uuid, uuid, text, text),
 public.radar_task_suggestion_items(uuid), public.set_radar_task_suggest(uuid, boolean),
 public.radar_task_suggest_estimate(uuid), public.radar_task_suggestion_stats(uuid, jsonb) to authenticated;

commit;
