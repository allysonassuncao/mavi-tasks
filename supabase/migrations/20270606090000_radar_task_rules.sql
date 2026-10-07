begin;

-- MAVI · Radar do cliente: as regras das tarefas (Fase 2).
--
-- Com os registros da Fase 1 (radar_task_signals: tarefas criadas e
-- vinculadas, itens fechados sem tarefa), a MAVI propõe regras por tópico ×
-- produto: QUANDO um item pede tarefa (ou quando NÃO pede), para qual equipe
-- (pessoa só quando o padrão aponta forte), com que prazo em dias úteis,
-- prioridade, gravidade mínima e uma dica de título. O Jev confere cada
-- proposta (os registros sustentam? é clara e não contradiz as em uso?) e
-- só vale depois que um administrador ou gestor aprova. Líderes também
-- escrevem regras (valem na hora), editam, pausam e recusam.
-- * O aprendizado começa desligado (radar_task_settings.learning): quem liga
--   vê antes o custo estimado do histórico (radar_task_rules_estimate).
-- * Fila por tópico × produto (radar_task_learning_queue): uma rodada quando
--   há 5 registros novos ou 1 parado há 24 h, com pelo menos 3 no grupo.
-- * Modelo: a funcionalidade nova 'client_radar_tasks' em Quem usa qual
--   modelo; o Jev é o do Radar do cliente.
-- * O worker é o do Radar (ai-radar), acordado também por esta fila.
-- As regras aprovadas são usadas na Fase 3 (a sugestão no item).

-- ------------------------------------------------------------ funcionalidade
do $$ declare v text[]; begin
 v := array(select distinct x from unnest(mavi_private.ai_route_features() || array['client_radar_tasks']) x order by x);
 alter table mavi_private.ai_routes drop constraint ai_routes_feature_check;
 execute format('alter table mavi_private.ai_routes add constraint ai_routes_feature_check check ('
  '(scope_type = ''feature'') = (feature is not null) and (feature is null or feature in (%s)))',
  (select string_agg(quote_literal(x), ',') from unnest(v) x));
end $$;

-- ------------------------------------------------------------ configuração
create table public.radar_task_settings (
 company_id uuid primary key references public.companies(id) on delete cascade,
 learning boolean not null default false,
 learning_by uuid,
 learning_at timestamptz,
 updated_at timestamptz not null default now()
);
alter table public.radar_task_settings enable row level security;
revoke all on public.radar_task_settings from public, anon, authenticated;

-- ------------------------------------------------------------ as regras
create table public.radar_task_rules (
 id uuid primary key default gen_random_uuid(),
 company_id uuid not null references public.companies(id) on delete cascade,
 topic_id uuid not null,
 -- Nulo: Geral / Agência; com all_products, vale em qualquer produto.
 product_id uuid,
 all_products boolean not null default false,
 action text not null check (action in ('task', 'no_task')),
 condition text not null check (length(btrim(condition)) between 5 and 400),
 min_severity smallint check (min_severity between 0 and 3),
 team_id uuid,
 assignee_id uuid,
 -- Dias úteis a partir da criação.
 due_days smallint check (due_days between 0 and 60),
 priority text check (priority in ('low', 'normal', 'high', 'urgent')),
 title_hint text check (title_hint is null or length(title_hint) <= 200),
 why text not null default '' check (length(why) <= 600),
 -- Os registros que sustentam a regra (os citados pela MAVI).
 signals uuid[] not null default '{}',
 -- A regra em uso que esta substitui (pausada quando esta é aprovada).
 replaces uuid references public.radar_task_rules(id) on delete set null,
 status text not null check (status in ('checking', 'suggested', 'active', 'paused', 'refused', 'dismissed')),
 origin text not null check (origin in ('mavi', 'leader')),
 check_note text,
 check_attempts integer not null default 0,
 check_claimed_until timestamptz,
 checked_at timestamptz,
 created_by uuid,
 updated_by uuid,
 approved_by uuid,
 approved_at timestamptz,
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 foreign key (company_id, topic_id) references public.radar_topics(company_id, id) on delete cascade,
 foreign key (company_id, product_id) references public.products(company_id, id) on delete cascade,
 foreign key (company_id, team_id) references public.teams(company_id, id) on delete set null (team_id),
 foreign key (company_id, assignee_id) references public.memberships(company_id, user_id) on delete set null (assignee_id),
 check (action = 'task' or (team_id is null and assignee_id is null and due_days is null and priority is null
  and title_hint is null)),
 check (not all_products or product_id is null)
);
create index radar_task_rules_group on public.radar_task_rules (company_id, topic_id, product_id, status);
create index radar_task_rules_checking on public.radar_task_rules (updated_at) where status = 'checking';
alter table public.radar_task_rules enable row level security;
revoke all on public.radar_task_rules from public, anon, authenticated;

-- ------------------------------------------------------------ a fila
create table public.radar_task_learning_queue (
 company_id uuid not null references public.companies(id) on delete cascade,
 topic_id uuid not null,
 -- O produto, ou zeros para Geral / Agência.
 product_key uuid not null,
 dirty_at timestamptz not null default now(),
 claimed_until timestamptz,
 attempts integer not null default 0,
 last_error text,
 learned_at timestamptz,
 primary key (company_id, topic_id, product_key),
 foreign key (company_id, topic_id) references public.radar_topics(company_id, id) on delete cascade
);
alter table public.radar_task_learning_queue enable row level security;
revoke all on public.radar_task_learning_queue from public, anon, authenticated;

create function mavi_private.radar_task_key(p uuid) returns uuid
language sql immutable set search_path = '' as $$
 select coalesce(p, '00000000-0000-0000-0000-000000000000'::uuid)
$$;
revoke all on function mavi_private.radar_task_key(uuid) from public, anon, authenticated;

create function mavi_private.radar_task_dirty() returns trigger
language plpgsql security definer set search_path = '' as $$ begin
 insert into public.radar_task_learning_queue as q (company_id, topic_id, product_key)
 values (new.company_id, new.topic_id, mavi_private.radar_task_key(new.product_id))
 on conflict (company_id, topic_id, product_key) do update set dirty_at = now();
 return null;
end $$;
revoke all on function mavi_private.radar_task_dirty() from public, anon, authenticated;
create trigger radar_task_signals_dirty after insert or update on public.radar_task_signals
 for each row execute function mavi_private.radar_task_dirty();

insert into public.radar_task_learning_queue(company_id, topic_id, product_key)
select distinct s.company_id, s.topic_id, mavi_private.radar_task_key(s.product_id)
from public.radar_task_signals s
on conflict do nothing;

-- Um grupo pede rodada: aprendizado ligado, 3+ registros no grupo e, desde a
-- última rodada, 5 mudanças ou 1 parada há 24 horas.
create function mavi_private.radar_task_rules_due(q public.radar_task_learning_queue) returns boolean
language sql stable security definer set search_path = '' as $$
 select (q.claimed_until is null or q.claimed_until < now()) and q.attempts < 5
  and (q.learned_at is null or q.dirty_at > q.learned_at)
  and exists (select 1 from public.radar_task_settings s where s.company_id = q.company_id and s.learning)
  and (select count(*) >= 3 from public.radar_task_signals x where x.company_id = q.company_id
   and x.topic_id = q.topic_id and mavi_private.radar_task_key(x.product_id) = q.product_key and x.removed_at is null)
  and (q.learned_at is null or (
   select count(*) >= 5 or (count(*) >= 1 and min(z.at) < now() - interval '24 hours')
   from (select greatest(x.created_at, coalesce(x.removed_at, x.created_at), coalesce(x.reopened_at, x.created_at)) as at
    from public.radar_task_signals x where x.company_id = q.company_id and x.topic_id = q.topic_id
     and mavi_private.radar_task_key(x.product_id) = q.product_key) z
   where z.at > q.learned_at))
$$;
revoke all on function mavi_private.radar_task_rules_due(public.radar_task_learning_queue) from public, anon, authenticated;

-- ------------------------------------------------------------ o que a tela mostra
create function mavi_private.radar_task_rule_json(r public.radar_task_rules) returns jsonb
language sql stable security definer set search_path = '' as $$
 select jsonb_strip_nulls(jsonb_build_object(
  'id', r.id, 'topic_id', r.topic_id,
  'topic_name', (select name from public.radar_topics where company_id = r.company_id and id = r.topic_id),
  'topic_color', (select color from public.radar_topics where company_id = r.company_id and id = r.topic_id),
  'product_id', r.product_id, 'all_products', r.all_products,
  'product_name', (select name from public.products where company_id = r.company_id and id = r.product_id),
  'action', r.action, 'condition', r.condition, 'min_severity', r.min_severity,
  'team_id', r.team_id, 'team_name', (select name from public.teams where company_id = r.company_id and id = r.team_id),
  'assignee_id', r.assignee_id,
  'assignee_name', (select name from public.memberships where company_id = r.company_id and user_id = r.assignee_id),
  'due_days', r.due_days, 'priority', r.priority, 'title_hint', r.title_hint, 'why', nullif(r.why, ''),
  'support', cardinality(r.signals), 'status', r.status, 'origin', r.origin, 'check_note', r.check_note,
  'replaces', r.replaces,
  'replaces_condition', (select o.condition from public.radar_task_rules o where o.id = r.replaces),
  'approved_by_name', (select name from public.memberships where company_id = r.company_id and user_id = r.approved_by),
  'approved_at', r.approved_at,
  'updated_by_name', (select name from public.memberships where company_id = r.company_id and user_id = r.updated_by),
  'created_at', r.created_at, 'updated_at', r.updated_at))
$$;
revoke all on function mavi_private.radar_task_rule_json(public.radar_task_rules) from public, anon, authenticated;

-- ------------------------------------------------------------ o worker
-- Um grupo para aprender, reservado por 10 minutos: o tópico, o produto, os
-- registros (até 80, os mais recentes, sem os desfeitos), as equipes da
-- empresa (as do produto marcadas), as pessoas que receberam e as regras do
-- grupo (todas, para não repetir).
create function public.ai_radar_task_rules_claim(p_secret text) returns jsonb
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
     'task_title', case when x.kind <> 'no_task' then x.final->>'title' end,
     'team_id', x.final->>'team_id', 'by_team', (x.final->>'by_team')::boolean,
     'assignee_id', x.final->>'assignee_id',
     'due_days', (x.final->>'due_days')::integer, 'priority', x.final->>'priority',
     'changed', case when cardinality(x.changed) > 0 then to_jsonb(x.changed) end,
     'from_item', case when x.preset is not null then true end,
     'preset_title', x.preset->>'title',
     'closed_as', x.final->>'label', 'by_mavi', case when x.kind = 'no_task' and x.user_id is null then true end,
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

-- As propostas: p_ops = [{op: add | update | retire, id?, action, condition,
-- team_id?, assignee_id?, due_days?, priority?, min_severity?, title_hint?,
-- why, signals: [ids], replaces?}]. add: nova, para o Jev conferir; update:
-- só uma sugestão da MAVI ainda não aprovada; retire: tira uma sugestão da
-- MAVI ainda não aprovada. Nada repete uma regra do grupo (nem recusada).
create function public.ai_radar_task_rules_store(p_secret text, p_company uuid, p_topic uuid, p_product_key uuid,
 p_ops jsonb, p_usage jsonb default '{}') returns integer
language plpgsql security definer set search_path = '' as $$
declare o jsonb; n integer := 0; v_product uuid := nullif(p_product_key, '00000000-0000-0000-0000-000000000000'::uuid);
 v_cond text; v_action text; v_id uuid; v_team uuid; v_user uuid; v_signals uuid[]; v_replaces uuid; v_cost numeric;
 v_uuid text := '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'; begin
 if not mavi_private.ai_secret_ok(p_secret) then raise exception 'Sem permissão' using errcode = '42501'; end if;
 for o in select * from jsonb_array_elements(case when jsonb_typeof(p_ops) = 'array' then p_ops else '[]' end) limit 8 loop
  v_id := case when coalesce(o->>'id', '') ~* v_uuid then (o->>'id')::uuid end;
  if o->>'op' = 'retire' then
   update public.radar_task_rules set status = 'dismissed', check_claimed_until = null, updated_at = now(),
    check_note = left('A MAVI retirou: ' || coalesce(nullif(btrim(o->>'why'), ''), 'os registros novos não sustentam mais.'), 500)
   where id = v_id and company_id = p_company and topic_id = p_topic and origin = 'mavi'
    and status in ('checking', 'suggested');
   n := n + case when found then 1 else 0 end;
   continue;
  end if;
  v_cond := left(btrim(coalesce(o->>'condition', '')), 400);
  v_action := case when o->>'action' in ('task', 'no_task') then o->>'action' end;
  continue when length(v_cond) < 5 or v_action is null;
  continue when exists (select 1 from public.radar_task_rules x where x.company_id = p_company and x.topic_id = p_topic
   and mavi_private.radar_task_key(x.product_id) = p_product_key and lower(x.condition) = lower(v_cond)
   and x.id is distinct from v_id);
  v_team := case when v_action = 'task' and coalesce(o->>'team_id', '') ~* v_uuid
   and exists (select 1 from public.teams t where t.company_id = p_company and t.id = (o->>'team_id')::uuid)
   then (o->>'team_id')::uuid end;
  v_user := case when v_action = 'task' and coalesce(o->>'assignee_id', '') ~* v_uuid
   and exists (select 1 from public.memberships m where m.company_id = p_company and m.user_id = (o->>'assignee_id')::uuid
    and m.active) then (o->>'assignee_id')::uuid end;
  select coalesce(array_agg(x.id), '{}') into v_signals from public.radar_task_signals x
  where x.company_id = p_company and x.topic_id = p_topic and mavi_private.radar_task_key(x.product_id) = p_product_key
   and x.id::text in (select jsonb_array_elements_text(case when jsonb_typeof(o->'signals') = 'array' then o->'signals' else '[]' end));
  v_replaces := (select r.id from public.radar_task_rules r where coalesce(o->>'replaces', '') ~* v_uuid
   and r.id = (o->>'replaces')::uuid and r.company_id = p_company and r.topic_id = p_topic and r.status = 'active');
  if o->>'op' = 'add' then
   insert into public.radar_task_rules(company_id, topic_id, product_id, action, condition, min_severity, team_id,
    assignee_id, due_days, priority, title_hint, why, signals, replaces, status, origin)
   values (p_company, p_topic, v_product, v_action, v_cond,
    case when o->>'min_severity' ~ '^[0-3]$' then (o->>'min_severity')::smallint end, v_team, v_user,
    case when v_action = 'task' and o->>'due_days' ~ '^\d{1,2}$' and (o->>'due_days')::integer <= 60
     then (o->>'due_days')::smallint end,
    case when v_action = 'task' and o->>'priority' in ('low', 'normal', 'high', 'urgent') then o->>'priority' end,
    case when v_action = 'task' then nullif(left(btrim(coalesce(o->>'title_hint', '')), 200), '') end,
    left(btrim(coalesce(o->>'why', '')), 600), v_signals, v_replaces, 'checking', 'mavi');
   n := n + 1;
  elsif o->>'op' = 'update' and v_id is not null then
   update public.radar_task_rules set action = v_action, condition = v_cond,
    min_severity = case when o->>'min_severity' ~ '^[0-3]$' then (o->>'min_severity')::smallint end,
    team_id = v_team, assignee_id = v_user,
    due_days = case when v_action = 'task' and o->>'due_days' ~ '^\d{1,2}$' and (o->>'due_days')::integer <= 60
     then (o->>'due_days')::smallint end,
    priority = case when v_action = 'task' and o->>'priority' in ('low', 'normal', 'high', 'urgent') then o->>'priority' end,
    title_hint = case when v_action = 'task' then nullif(left(btrim(coalesce(o->>'title_hint', '')), 200), '') end,
    why = left(btrim(coalesce(o->>'why', '')), 600),
    signals = (select array(select distinct unnest(signals || v_signals))), replaces = coalesce(v_replaces, replaces),
    status = 'checking', check_attempts = 0, check_note = null, check_claimed_until = null, updated_at = now()
   where id = v_id and company_id = p_company and topic_id = p_topic and origin = 'mavi'
    and status in ('checking', 'suggested');
   n := n + case when found then 1 else 0 end;
  end if;
 end loop;
 update public.radar_task_learning_queue set learned_at = now(), claimed_until = null, attempts = 0, last_error = null
 where company_id = p_company and topic_id = p_topic and product_key = p_product_key;
 v_cost := least(greatest(coalesce((p_usage->>'cost')::numeric, 0), 0), 100);
 if v_cost > 0 or coalesce((p_usage->>'input')::integer, 0) > 0 then
  insert into public.ai_usage(company_id, user_id, module, kind, model, input_tokens, output_tokens,
   cache_read_tokens, cache_write_tokens, cost_usd, provider_id, provider_name)
  values (p_company, null, 'radar', 'task_rules', left(coalesce(p_usage->>'model', ''), 80),
   coalesce((p_usage->>'input')::integer, 0), coalesce((p_usage->>'output')::integer, 0),
   coalesce((p_usage->>'cache_read')::integer, 0), coalesce((p_usage->>'cache_write')::integer, 0), v_cost,
   case when (p_usage->>'provider_id') ~* v_uuid then (p_usage->>'provider_id')::uuid end,
   left(coalesce(p_usage->>'provider', ''), 120));
 end if;
 if n > 0 then perform mavi_private.broadcast(p_company, jsonb_build_object('kind', 'radar_task_rules')); end if;
 return n;
end $$;

create function public.ai_radar_task_rules_fail(p_secret text, p_company uuid, p_topic uuid, p_product_key uuid,
 p_error text) returns void
language plpgsql security definer set search_path = '' as $$ begin
 if not mavi_private.ai_secret_ok(p_secret) then raise exception 'Sem permissão' using errcode = '42501'; end if;
 update public.radar_task_learning_queue set claimed_until = now() + make_interval(mins => attempts * 10),
  last_error = left(p_error, 500)
 where company_id = p_company and topic_id = p_topic and product_key = p_product_key;
end $$;

-- Uma proposta para o Jev, reservada por 5 minutos: a regra, os registros
-- citados e as regras em uso do grupo.
create function public.ai_radar_task_rule_check_claim(p_secret text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare r public.radar_task_rules; begin
 if not mavi_private.ai_secret_ok(p_secret) then raise exception 'Sem permissão' using errcode = '42501'; end if;
 select x.* into r from public.radar_task_rules x
 where x.status = 'checking' and x.check_attempts < 3 and (x.check_claimed_until is null or x.check_claimed_until < now())
 order by x.updated_at limit 1 for update skip locked;
 if not found then return null; end if;
 update public.radar_task_rules set check_claimed_until = now() + interval '5 minutes', check_attempts = check_attempts + 1
 where id = r.id;
 return jsonb_build_object('id', r.id, 'company', r.company_id, 'rule', mavi_private.radar_task_rule_json(r),
  'signals', (select coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object('kind', x.kind, 'title', i.title,
     'severity', x.severity, 'team', (select t.name from public.teams t where t.company_id = r.company_id
      and t.id::text = x.final->>'team_id'),
     'due_days', (x.final->>'due_days')::integer, 'priority', x.final->>'priority', 'closed_as', x.final->>'label'))), '[]')
   from public.radar_task_signals x join public.radar_items i on i.id = x.item_id where x.id = any(r.signals)),
  'group', (select jsonb_build_object('task', count(*) filter (where x.kind in ('created', 'linked')),
     'no_task', count(*) filter (where x.kind = 'no_task'))
   from public.radar_task_signals x where x.company_id = r.company_id and x.topic_id = r.topic_id
    and (r.all_products or mavi_private.radar_task_key(x.product_id) = mavi_private.radar_task_key(r.product_id))
    and x.removed_at is null),
  'active', (select coalesce(jsonb_agg(o.condition || ' → ' || case o.action when 'task' then 'abrir tarefa' else 'não abrir' end), '[]')
   from public.radar_task_rules o where o.company_id = r.company_id and o.topic_id = r.topic_id and o.status = 'active'
    and o.id is distinct from r.replaces
    and (o.all_products or r.all_products or mavi_private.radar_task_key(o.product_id) = mavi_private.radar_task_key(r.product_id))),
  'jev', mavi_private.radar_jev_route(r.company_id));
end $$;

-- O Jev aprovou: a sugestão espera um líder ('suggested'); recusou: 'refused'.
create function public.ai_radar_task_rule_check_store(p_secret text, p_rule uuid, p_ok boolean, p_note text default null,
 p_usage jsonb default '{}') returns void
language plpgsql security definer set search_path = '' as $$
declare r public.radar_task_rules; v_cost numeric; begin
 if not mavi_private.ai_secret_ok(p_secret) then raise exception 'Sem permissão' using errcode = '42501'; end if;
 update public.radar_task_rules set status = case when p_ok then 'suggested' else 'refused' end,
  check_note = left(p_note, 500), checked_at = now(), check_claimed_until = null, updated_at = now()
 where id = p_rule and status = 'checking'
 returning * into r;
 if r.id is null then return; end if;
 v_cost := least(greatest(coalesce((p_usage->>'cost')::numeric, 0), 0), 100);
 if v_cost > 0 then
  insert into public.ai_usage(company_id, user_id, module, kind, model, input_tokens, cost_usd, provider_id, provider_name)
  values (r.company_id, null, 'radar', 'task_rule_check', left(coalesce(p_usage->>'model', ''), 80),
   coalesce((p_usage->>'input')::integer, 0), v_cost,
   case when (p_usage->>'provider_id') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    then (p_usage->>'provider_id')::uuid end,
   left(coalesce(p_usage->>'provider', ''), 120));
 end if;
 perform mavi_private.broadcast(r.company_id, jsonb_build_object('kind', 'radar_task_rules'));
end $$;

-- A da migração 20270304090000: também acorda pelas regras das tarefas.
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
   and (r.check_claimed_until is null or r.check_claimed_until < now())) then
  return;
 end if;
 perform net.http_post(url := cfg.url, body := '{"action":"ai-radar"}'::jsonb,
  headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || cfg.secret),
  -- O worker trabalha até 4 min (uma leitura leva até ~90 s).
  timeout_milliseconds := 290000);
end $$;

-- ------------------------------------------------------------ a tela (líderes)
-- As regras (sugestões primeiro), a configuração, os tópicos e a fila.
create function public.radar_task_rules(p_company uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$ begin
 if not mavi_private.leader(p_company) then raise exception 'Sem permissão' using errcode = '42501'; end if;
 return jsonb_build_object(
  'settings', (select jsonb_strip_nulls(jsonb_build_object('learning', coalesce(s.learning, false),
    'learning_at', s.learning_at,
    'learning_by_name', (select name from public.memberships where company_id = p_company and user_id = s.learning_by)))
   from (select 1) one left join public.radar_task_settings s on s.company_id = p_company),
  'topics', (select coalesce(jsonb_agg(jsonb_build_object('id', t.id, 'name', t.name, 'color', t.color)
    order by t.position, t.created_at), '[]') from public.radar_topics t where t.company_id = p_company and t.active),
  'rules', (select coalesce(jsonb_agg(mavi_private.radar_task_rule_json(r)
    order by r.status = 'suggested' desc, r.status = 'checking' desc, r.status = 'active' desc, r.updated_at desc), '[]')
   from public.radar_task_rules r where r.company_id = p_company),
  'queue', (select jsonb_build_object(
    'due', count(*) filter (where mavi_private.radar_task_rules_due(q)),
    'learned_at', max(q.learned_at),
    'error', (select z.last_error from public.radar_task_learning_queue z where z.company_id = p_company
     and z.last_error is not null order by z.dirty_at desc limit 1))
   from public.radar_task_learning_queue q where q.company_id = p_company));
end $$;

-- O que custa a primeira rodada (o histórico): os grupos com 3+ registros,
-- os caracteres do material, o preço do modelo e o custo médio já medido.
create function public.radar_task_rules_estimate(p_company uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$ begin
 if not mavi_private.leader(p_company) then raise exception 'Sem permissão' using errcode = '42501'; end if;
 return (with g as (
   select x.topic_id, mavi_private.radar_task_key(x.product_id) as k, count(*) as n,
    sum(length(i.title) + least(length(i.summary), 240) + 220) as chars
   from public.radar_task_signals x join public.radar_items i on i.id = x.item_id
   where x.company_id = p_company and x.removed_at is null
   group by 1, 2 having count(*) >= 3)
  select jsonb_build_object('groups', (select count(*) from g), 'signals', coalesce((select sum(least(n, 80)) from g), 0),
   'chars', coalesce((select sum(chars * least(n, 80)::numeric / n) from g), 0),
   'avg_cost', (select avg(u.cost_usd) from public.ai_usage u where u.company_id = p_company and u.module = 'radar'
     and u.kind = 'task_rules' and u.cost_usd > 0),
   'samples', (select count(*) from public.ai_usage u where u.company_id = p_company and u.module = 'radar'
     and u.kind = 'task_rules' and u.cost_usd > 0),
   'price', (select m from mavi_private.ai_routes rt join mavi_private.ai_providers p on p.id = rt.provider_id and p.active
     cross join lateral jsonb_array_elements(p.models) m
     where rt.company_id = p_company and m->>'id' = rt.model
      and ((rt.scope_type = 'feature' and rt.feature = 'client_radar_tasks') or rt.scope_type = 'company')
     order by case rt.scope_type when 'feature' then 1 else 2 end limit 1)));
end $$;

-- Ligar ou desligar o aprendizado (líderes).
create function public.set_radar_task_learning(p_company uuid, p_on boolean) returns jsonb
language plpgsql security definer set search_path = '' as $$ begin
 if not mavi_private.leader(p_company) then
  raise exception 'Só administradores e gestores ligam o aprendizado das tarefas do Radar.' using errcode = '42501';
 end if;
 insert into public.radar_task_settings as s (company_id, learning, learning_by, learning_at, updated_at)
 values (p_company, coalesce(p_on, false), auth.uid(), now(), now())
 on conflict (company_id) do update set learning = excluded.learning, learning_by = excluded.learning_by,
  learning_at = excluded.learning_at, updated_at = now();
 return (public.radar_task_rules(p_company))->'settings';
end $$;

-- Escrever ou editar uma regra (líderes). Nova: vale na hora. Editar uma
-- sugestão não a aprova (aprovar é pôr em uso).
-- p_rule: {topic_id, product_id?, all_products?, action, condition, min_severity?,
-- team_id?, assignee_id?, due_days?, priority?, title_hint?}.
create function public.save_radar_task_rule(p_company uuid, p_id uuid, p_rule jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_me uuid := auth.uid(); r public.radar_task_rules; f jsonb := coalesce(p_rule, '{}'); v_action text;
 v_cond text; v_topic uuid; v_product uuid; v_all boolean; v_team uuid; v_user uuid; v_due integer; v_sev integer;
 v_prio text; v_hint text; v_uuid text := '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'; begin
 if not mavi_private.leader(p_company) then
  raise exception 'Só administradores e gestores mexem nas regras das tarefas do Radar.' using errcode = '42501';
 end if;
 v_action := f->>'action';
 if coalesce(v_action, '') not in ('task', 'no_task') then raise exception 'Escolha a ação.' using errcode = '22023'; end if;
 v_cond := btrim(coalesce(f->>'condition', ''));
 if length(v_cond) not between 5 and 400 then
  raise exception 'Escreva quando a regra vale com 5 a 400 caracteres.' using errcode = '22023';
 end if;
 v_topic := case when coalesce(f->>'topic_id', '') ~* v_uuid then (f->>'topic_id')::uuid end;
 if not exists (select 1 from public.radar_topics where company_id = p_company and id = v_topic) then
  raise exception 'Escolha o tópico.' using errcode = '22023';
 end if;
 v_all := coalesce((f->>'all_products')::boolean, false);
 v_product := case when not v_all and coalesce(f->>'product_id', '') ~* v_uuid then (f->>'product_id')::uuid end;
 if v_product is not null and not exists (select 1 from public.products where company_id = p_company and id = v_product) then
  raise exception 'Produto não encontrado.' using errcode = 'P0002';
 end if;
 v_team := case when v_action = 'task' and coalesce(f->>'team_id', '') ~* v_uuid then (f->>'team_id')::uuid end;
 if v_team is not null and not exists (select 1 from public.teams where company_id = p_company and id = v_team) then
  raise exception 'Equipe não encontrada.' using errcode = 'P0002';
 end if;
 v_user := case when v_action = 'task' and coalesce(f->>'assignee_id', '') ~* v_uuid then (f->>'assignee_id')::uuid end;
 if v_user is not null and not exists (select 1 from public.memberships where company_id = p_company and user_id = v_user
   and active) then
  raise exception 'Pessoa não encontrada.' using errcode = 'P0002';
 end if;
 v_due := case when v_action = 'task' and f->>'due_days' ~ '^\d{1,2}$' then (f->>'due_days')::integer end;
 if v_due > 60 then raise exception 'O prazo vai até 60 dias úteis.' using errcode = '22023'; end if;
 v_sev := case when f->>'min_severity' ~ '^[0-3]$' then (f->>'min_severity')::integer end;
 v_prio := case when v_action = 'task' and f->>'priority' in ('low', 'normal', 'high', 'urgent') then f->>'priority' end;
 v_hint := case when v_action = 'task' then nullif(left(btrim(coalesce(f->>'title_hint', '')), 200), '') end;
 if p_id is null then
  insert into public.radar_task_rules(company_id, topic_id, product_id, all_products, action, condition, min_severity,
   team_id, assignee_id, due_days, priority, title_hint, status, origin, created_by, updated_by, approved_by, approved_at)
  values (p_company, v_topic, v_product, v_all, v_action, v_cond, v_sev, v_team, v_user, v_due, v_prio, v_hint,
   'active', 'leader', v_me, v_me, v_me, now())
  returning * into r;
 else
  update public.radar_task_rules set topic_id = v_topic, product_id = v_product, all_products = v_all, action = v_action,
   condition = v_cond, min_severity = v_sev, team_id = v_team, assignee_id = v_user, due_days = v_due, priority = v_prio,
   title_hint = v_hint, updated_by = v_me, updated_at = now(),
   status = case when status in ('checking', 'refused') then 'suggested' else status end,
   check_claimed_until = null,
   origin = case when status in ('checking', 'suggested', 'refused') then origin else 'leader' end
  where id = p_id and company_id = p_company returning * into r;
  if r.id is null then raise exception 'Regra não encontrada' using errcode = 'P0002'; end if;
 end if;
 return mavi_private.radar_task_rule_json(r);
end $$;

-- Aprovar (active), pausar ou recusar/excluir (dismissed): líderes. Aprovar
-- uma substituta pausa a regra que ela substitui.
create function public.set_radar_task_rule(p_company uuid, p_id uuid, p_status text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_me uuid := auth.uid(); r public.radar_task_rules; v_was text; begin
 if not mavi_private.leader(p_company) then
  raise exception 'Só administradores e gestores mexem nas regras das tarefas do Radar.' using errcode = '42501';
 end if;
 if coalesce(p_status, '') not in ('active', 'paused', 'dismissed') then
  raise exception 'Situação inválida' using errcode = '22023';
 end if;
 select status into v_was from public.radar_task_rules where id = p_id and company_id = p_company for update;
 if v_was is null then raise exception 'Regra não encontrada' using errcode = 'P0002'; end if;
 update public.radar_task_rules set status = p_status, check_claimed_until = null,
  approved_by = case when p_status = 'active' and v_was <> 'paused' then v_me else approved_by end,
  approved_at = case when p_status = 'active' and v_was <> 'paused' then now() else approved_at end,
  updated_by = v_me, updated_at = now()
 where id = p_id returning * into r;
 if p_status = 'active' and r.replaces is not null then
  update public.radar_task_rules set status = 'paused', updated_by = v_me, updated_at = now(),
   check_note = 'Substituída por uma regra nova.'
  where id = r.replaces and company_id = p_company and status = 'active';
 end if;
 return mavi_private.radar_task_rule_json(r);
end $$;

-- ------------------------------------------------------------ permissões
revoke all on function public.ai_radar_task_rules_claim(text),
 public.ai_radar_task_rules_store(text, uuid, uuid, uuid, jsonb, jsonb),
 public.ai_radar_task_rules_fail(text, uuid, uuid, uuid, text), public.ai_radar_task_rule_check_claim(text),
 public.ai_radar_task_rule_check_store(text, uuid, boolean, text, jsonb),
 public.radar_task_rules(uuid), public.radar_task_rules_estimate(uuid), public.set_radar_task_learning(uuid, boolean),
 public.save_radar_task_rule(uuid, uuid, jsonb), public.set_radar_task_rule(uuid, uuid, text) from public, anon;
grant execute on function public.ai_radar_task_rules_claim(text),
 public.ai_radar_task_rules_store(text, uuid, uuid, uuid, jsonb, jsonb),
 public.ai_radar_task_rules_fail(text, uuid, uuid, uuid, text), public.ai_radar_task_rule_check_claim(text),
 public.ai_radar_task_rule_check_store(text, uuid, boolean, text, jsonb) to anon, authenticated;
grant execute on function public.radar_task_rules(uuid), public.radar_task_rules_estimate(uuid),
 public.set_radar_task_learning(uuid, boolean), public.save_radar_task_rule(uuid, uuid, jsonb),
 public.set_radar_task_rule(uuid, uuid, text) to authenticated;

commit;
