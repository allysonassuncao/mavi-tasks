begin;

-- MAVI · Radar do cliente: a MAVI abre a tarefa sozinha (Fase 4).
--
-- Um administrador ou gestor libera a autonomia por tópico × produto. Ela só
-- age enquanto o acerto das sugestões (aceitas como vieram ÷ decididas, nos
-- últimos N dias, com um mínimo de decididas) estiver no limite da empresa;
-- abaixo, a MAVI volta a só sugerir. Com a autonomia valendo, a sugestão de
-- tarefa vira tarefa na hora:
-- * criada pela MAVI (o membro da empresa com o e-mail mcc@makevendas.com.br,
--   ou o escolhido em radar_task_settings.mavi_user_id), ligada ao item, com
--   a descrição da sugestão, as falas e o link do item; vai para a pessoa da
--   regra ou para quem tem menos tarefas na equipe (team_assignee), com o
--   prazo sugerido (ou a regra de prazo) e os campos dos modelos;
-- * aviso no sino ao responsável do item (ou a quem liberou a autonomia);
-- * desfazer em até 24 h, com motivo: a tarefa é arquivada, sai do item e
--   conta como erro (registro 'dismissed'), baixando o acerto;
-- * teto de tarefas automáticas por cliente por dia.
-- Sem a MAVI na empresa, sem equipe, com campo obrigatório no modelo ou no
-- teto, a sugestão fica para uma pessoa (status 'open', com o motivo).

-- ------------------------------------------------------------ configuração
alter table public.radar_task_settings
 add column mavi_user_id uuid,
 add column autonomy_rate smallint not null default 90 check (autonomy_rate between 50 and 100),
 add column autonomy_min smallint not null default 10 check (autonomy_min between 3 and 200),
 add column autonomy_days smallint not null default 30 check (autonomy_days between 7 and 180),
 add column autonomy_cap smallint not null default 3 check (autonomy_cap between 1 and 50);

-- A MAVI de cada empresa: o membro com o e-mail da MAVI.
insert into public.radar_task_settings(company_id, mavi_user_id)
select m.company_id, m.user_id from public.memberships m
where lower(m.email) = 'mcc@makevendas.com.br'
on conflict (company_id) do update set mavi_user_id = excluded.mavi_user_id;

create function mavi_private.radar_mavi_user(c uuid) returns uuid
language sql stable security definer set search_path = '' as $$
 select m.user_id from public.memberships m
 where m.company_id = c and m.active and m.user_id = coalesce(
  (select s.mavi_user_id from public.radar_task_settings s where s.company_id = c),
  (select x.user_id from public.memberships x where x.company_id = c and lower(x.email) = 'mcc@makevendas.com.br' limit 1))
$$;
revoke all on function mavi_private.radar_mavi_user(uuid) from public, anon, authenticated;

-- Autonomia liberada por tópico × produto.
create table public.radar_task_autonomy (
 company_id uuid not null references public.companies(id) on delete cascade,
 topic_id uuid not null,
 product_key uuid not null,
 enabled boolean not null default false,
 enabled_by uuid,
 enabled_at timestamptz,
 updated_at timestamptz not null default now(),
 primary key (company_id, topic_id, product_key),
 foreign key (company_id, topic_id) references public.radar_topics(company_id, id) on delete cascade
);
alter table public.radar_task_autonomy enable row level security;
revoke all on public.radar_task_autonomy from public, anon, authenticated;

-- ------------------------------------------------------------ as sugestões
alter table public.radar_task_suggestions drop constraint radar_task_suggestions_status_check;
alter table public.radar_task_suggestions add constraint radar_task_suggestions_status_check
 check (status in ('pending', 'open', 'none', 'created', 'replaced', 'dismissed', 'expired', 'failed', 'auto', 'undone'));
alter table public.radar_task_suggestions add column auto_note text;
create index radar_task_suggestions_auto on public.radar_task_suggestions (company_id, decided_at) where status in ('auto', 'undone');

alter table public.radar_task_signals drop constraint radar_task_signals_removed_reason_check;
alter table public.radar_task_signals add constraint radar_task_signals_removed_reason_check
 check (removed_reason in ('unlinked', 'task_later', 'undone'));

-- O aviso no sino (sem tarefa: título + link do item).
do $$ declare v text[]; w text[]; begin
 select coalesce(array_agg(distinct m[1]), '{}') into v from pg_constraint k,
  regexp_matches(pg_get_constraintdef(k.oid), '''([a-z_]+)''', 'g') m
 where k.conname = 'notifications_kind_check' and k.conrelid = 'public.notifications'::regclass;
 select coalesce(array_agg(distinct m[1]), '{}') into w from pg_constraint k,
  regexp_matches(pg_get_constraintdef(k.oid), '''([a-z_]+)''', 'g') m
 where k.conname = 'notifications_target_check' and k.conrelid = 'public.notifications'::regclass;
 v := array(select distinct x from unnest(v || array['radar_task_auto']) x order by x);
 w := array(select distinct x from unnest(w || array['radar_task_auto', 'notice']) x order by x);
 alter table public.notifications drop constraint notifications_kind_check;
 execute format('alter table public.notifications add constraint notifications_kind_check check (kind in (%s))',
  (select string_agg(quote_literal(x), ',') from unnest(v) x));
 alter table public.notifications drop constraint notifications_target_check;
 execute format('alter table public.notifications add constraint notifications_target_check check ('
  '((kind in (%s)) = (task_id is null)) '
  'and (task_id is not null or (title is not null and link is not null)) '
  'and ((kind = ''notice'') = (notice_id is not null)))', (select string_agg(quote_literal(x), ',') from unnest(w) x));
end $$;

-- ------------------------------------------------------------ o acerto
-- Nos últimos N dias, num tópico × produto: decididas (aceitas, recusadas,
-- substituídas, expiradas, criadas sozinhas há mais de 24 h e desfeitas) e
-- acertos (aceitas como vieram — equipe/pessoa, prazo, prioridade e produto —
-- e as criadas sozinhas que ninguém desfez em 24 h).
create function mavi_private.radar_task_hit(c uuid, p_topic uuid, p_product_key uuid, p_days integer)
returns table (decided integer, hits integer, rate integer)
language sql stable security definer set search_path = '' as $$
 with s as (
  select x.status, x.decided_at,
   (x.status = 'created' and exists (select 1 from public.radar_task_signals g where g.item_id = x.item_id
     and g.task_id = x.task_id and g.from_suggestion
     and not (g.changed && array['product', 'due', 'assignee', 'team', 'priority']))) as as_is
  from public.radar_task_suggestions x join public.radar_items i on i.id = x.item_id
  where x.company_id = c and i.topic_id = p_topic and mavi_private.radar_task_key(i.product_id) = p_product_key
   and x.updated_at >= now() - make_interval(days => p_days)
   and (x.status in ('created', 'dismissed', 'replaced', 'expired', 'undone')
    or (x.status = 'auto' and x.decided_at < now() - interval '24 hours'))
 )
 select count(*)::integer,
  (count(*) filter (where as_is or status = 'auto'))::integer,
  case when count(*) > 0 then round(100.0 * count(*) filter (where as_is or status = 'auto') / count(*))::integer end
 from s
$$;
revoke all on function mavi_private.radar_task_hit(uuid, uuid, uuid, integer) from public, anon, authenticated;

-- A autonomia vale agora para o item? (liberada, com a MAVI na empresa e o
-- acerto no limite.) Devolve nulo quando vale; senão, o motivo.
create function mavi_private.radar_task_autonomy_block(i public.radar_items) returns text
language plpgsql stable security definer set search_path = '' as $$
declare s public.radar_task_settings; h record; v_today date; v_count integer; begin
 if not exists (select 1 from public.radar_task_autonomy a where a.company_id = i.company_id and a.topic_id = i.topic_id
   and a.product_key = mavi_private.radar_task_key(i.product_id) and a.enabled) then
  return 'off';
 end if;
 select * into s from public.radar_task_settings where company_id = i.company_id;
 if mavi_private.radar_mavi_user(i.company_id) is null then
  return 'A MAVI não é membro ativo da empresa (e-mail mcc@makevendas.com.br).';
 end if;
 select * into h from mavi_private.radar_task_hit(i.company_id, i.topic_id, mavi_private.radar_task_key(i.product_id),
  s.autonomy_days);
 if h.decided < s.autonomy_min then
  return format('Poucas sugestões decididas nos últimos %s dias (%s de %s).', s.autonomy_days, h.decided, s.autonomy_min);
 end if;
 if h.rate < s.autonomy_rate then
  return format('Acerto de %s%%, abaixo do limite de %s%%.', h.rate, s.autonomy_rate);
 end if;
 v_today := mavi_private.company_today(i.company_id);
 select count(*) into v_count from public.radar_task_suggestions x join public.radar_items y on y.id = x.item_id
 where x.company_id = i.company_id and y.client_id = i.client_id and x.status in ('auto', 'undone')
  and (x.decided_at at time zone mavi_private.company_tz(i.company_id))::date = v_today;
 if v_count >= s.autonomy_cap then
  return format('Teto de %s tarefa(s) automática(s) por cliente hoje.', s.autonomy_cap);
 end if;
 return null;
end $$;
revoke all on function mavi_private.radar_task_autonomy_block(public.radar_items) from public, anon, authenticated;

-- A descrição da tarefa criada sozinha (o formato do editor): a sugestão, o
-- resumo do item, as últimas falas e o link do item.
create function mavi_private.radar_task_auto_description(i public.radar_items, s public.radar_task_suggestions)
returns text
language sql stable security definer set search_path = '' as $$
 with p as (
  select n, jsonb_build_object('type', 'paragraph', 'content', jsonb_build_array(jsonb_build_object('type', 'text', 'text', l))) as b
  from unnest(string_to_array(coalesce(s.description, ''), E'\n')) with ordinality as u(l, n) where btrim(l) <> ''
 )
 select 'mavi:richtext:v1:' || jsonb_build_object('type', 'doc', 'content',
  coalesce((select jsonb_agg(b order by n) from p), '[]'::jsonb)
  || case when btrim(i.summary) <> '' then jsonb_build_array(jsonb_build_object('type', 'paragraph', 'content',
    jsonb_build_array(jsonb_build_object('type', 'text', 'text', i.summary)))) else '[]'::jsonb end
  || coalesce((select jsonb_build_array(
     jsonb_build_object('type', 'paragraph', 'content', jsonb_build_array(jsonb_build_object('type', 'text',
      'text', 'Onde apareceu', 'marks', jsonb_build_array(jsonb_build_object('type', 'bold'))))),
     jsonb_build_object('type', 'bulletList', 'content', jsonb_agg(jsonb_build_object('type', 'listItem', 'content',
      jsonb_build_array(jsonb_build_object('type', 'paragraph', 'content', jsonb_build_array(
       jsonb_build_object('type', 'text', 'text',
        to_char(m.occurred_at at time zone mavi_private.company_tz(i.company_id), 'DD/MM/YYYY') || ' · '),
       jsonb_build_object('type', 'text', 'text', coalesce(nullif(m.speaker, ''), 'Sem nome') || ': ',
        'marks', jsonb_build_array(jsonb_build_object('type', 'bold'))),
       jsonb_build_object('type', 'text', 'text', '“' || m.quote || '”'))))) order by m.occurred_at desc)))
    from (select * from public.radar_mentions z where z.item_id = i.id order by z.occurred_at desc limit 5) m
    having count(*) > 0), '[]'::jsonb)
  || jsonb_build_array(jsonb_build_object('type', 'paragraph', 'content', jsonb_build_array(
    jsonb_build_object('type', 'text', 'text', 'Criada pela MAVI a partir do Radar do cliente: ',
     'marks', jsonb_build_array(jsonb_build_object('type', 'bold'))),
    jsonb_build_object('type', 'text', 'text', 'abrir o item',
     'marks', jsonb_build_array(jsonb_build_object('type', 'link', 'attrs', jsonb_build_object('href', '/radar?item=' || i.id))))))))::text
$$;
revoke all on function mavi_private.radar_task_auto_description(public.radar_items, public.radar_task_suggestions)
 from public, anon, authenticated;

-- Cria a tarefa da sugestão em nome da MAVI (como a cópia da repetição: sem
-- pessoa logada). Devolve a tarefa; erro sobe para quem chamou.
create function mavi_private.radar_task_auto_create(i public.radar_items, s public.radar_task_suggestions) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_mavi uuid := mavi_private.radar_mavi_user(i.company_id); v_contract uuid; v_assignee uuid; v_custom jsonb;
 ch record; v_today date := mavi_private.company_today(i.company_id); v_task uuid; begin
 select k.id into v_contract from public.contracts k
 where k.company_id = i.company_id and k.client_id = i.client_id and not k.archived
  and k.product_id is not distinct from i.product_id
 order by k.created_at limit 1;
 if v_contract is null then raise exception 'O cliente não tem o produto do item ativo.'; end if;
 if s.assignee_id is not null and exists (select 1 from public.memberships m where m.company_id = i.company_id
   and m.user_id = s.assignee_id and m.active) then
  v_assignee := s.assignee_id;
  v_custom := mavi_private.fill_custom_fields(mavi_private.template_fields_for(i.company_id, v_contract, v_assignee), '{}');
 elsif s.team_id is not null then
  perform 1 from public.teams where company_id = i.company_id and id = s.team_id for update;
  v_assignee := mavi_private.team_assignee(i.company_id, s.team_id);
  if v_assignee is null then raise exception 'A equipe não tem ninguém ativo para receber a tarefa.'; end if;
  v_custom := mavi_private.fill_custom_fields(mavi_private.team_template_fields(i.company_id, v_contract, s.team_id), '{}');
 else
  raise exception 'A sugestão não tem equipe nem pessoa.';
 end if;
 select * into ch from mavi_private.choose_due(i.company_id, v_contract, null, s.team_id, v_assignee, v_today, false,
  s.due_date, s.due_date is not null, null, false);
 insert into public.tasks(company_id, contract_id, title, assignee_id, creator_id, due_date, original_due_date,
  team_id, description, priority, custom_fields, due_manual, due_rule_id)
 values (i.company_id, v_contract, s.title, v_assignee, v_mavi, ch.due, ch.due, s.team_id,
  mavi_private.radar_task_auto_description(i, s), coalesce(s.priority, 'normal'), v_custom, ch.manual, ch.rule_id)
 returning id into v_task;
 insert into public.task_events(company_id, task_id, actor_id, action, detail)
 values (i.company_id, v_task, v_mavi, 'created', jsonb_build_object('radar_item', i.id, 'auto', true,
  'rule', s.rule_id));
 insert into public.radar_item_tasks(company_id, item_id, task_id, created_by)
 values (i.company_id, i.id, v_task, v_mavi) on conflict do nothing;
 return v_task;
end $$;
revoke all on function mavi_private.radar_task_auto_create(public.radar_items, public.radar_task_suggestions)
 from public, anon, authenticated;

-- Liga a tarefa criada sozinha: registro (da MAVI, pela sugestão), aviso no
-- sino ao responsável do item (ou a quem liberou a autonomia).
create function mavi_private.radar_task_auto_done(i public.radar_items, s public.radar_task_suggestions, p_task uuid)
returns void
language plpgsql security definer set search_path = '' as $$
declare v_mavi uuid := mavi_private.radar_mavi_user(i.company_id); v_to uuid; t public.tasks; begin
 select * into t from public.tasks where id = p_task;
 perform mavi_private.radar_task_record(i.company_id, i.id, p_task, 'created',
  jsonb_strip_nulls(jsonb_build_object('title', s.title, 'due', s.due_date::text, 'team', s.team_id::text,
   'assignee', s.assignee_id::text, 'priority', coalesce(s.priority, 'normal'))), v_mavi);
 update public.radar_task_signals set from_suggestion = true, rule_id = s.rule_id
 where item_id = i.id and task_id = p_task;
 v_to := coalesce(
  (select m.user_id from public.memberships m where m.company_id = i.company_id and m.user_id = i.assignee_id and m.active),
  (select a.enabled_by from public.radar_task_autonomy a join public.memberships m on m.company_id = a.company_id
    and m.user_id = a.enabled_by and m.active
   where a.company_id = i.company_id and a.topic_id = i.topic_id and a.product_key = mavi_private.radar_task_key(i.product_id)));
 if v_to is not null and v_to is distinct from v_mavi then
  insert into public.notifications(company_id, user_id, actor_id, task_id, kind, title, body, link)
  values (i.company_id, v_to, v_mavi, null, 'radar_task_auto',
   left('A MAVI criou uma tarefa pelo Radar: ' || t.title, 300),
   left(concat_ws(' · ', (select c.name from public.clients c where c.id = i.client_id),
    'para ' || (select m.name from public.memberships m where m.company_id = i.company_id and m.user_id = t.assignee_id),
    'prazo ' || to_char(t.due_date, 'DD/MM'), 'dá para desfazer em 24 h'), 300),
   '/radar?item=' || i.id);
 end if;
end $$;
revoke all on function mavi_private.radar_task_auto_done(public.radar_items, public.radar_task_suggestions, uuid)
 from public, anon, authenticated;

-- ------------------------------------------------------------ o worker
-- A da migração 20270608090000: com a autonomia valendo, a sugestão de
-- tarefa vira tarefa na hora ('auto').
create or replace function public.ai_radar_task_suggest_store(p_secret text, p_item uuid, p_result jsonb, p_usage jsonb default '{}')
returns text
language plpgsql security definer set search_path = '' as $$
declare r jsonb := coalesce(p_result, '{}'); i public.radar_items; v_rule public.radar_task_rules; v_decision text;
 v_teams uuid[]; v_team uuid; v_user uuid; v_link uuid; v_due integer; v_status text; v_cost numeric;
 s public.radar_task_suggestions; v_block text; v_task uuid;
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
 -- A autonomia (Fase 4): a sugestão de tarefa vira tarefa na hora. Sem
 -- condição, ou se a criação falhar, fica para uma pessoa com o motivo.
 if v_status = 'open' and v_decision = 'task' then
  v_block := mavi_private.radar_task_autonomy_block(i);
  if v_block is null then
   select * into s from public.radar_task_suggestions where item_id = p_item;
   begin
    v_task := mavi_private.radar_task_auto_create(i, s);
    update public.radar_task_suggestions set status = 'auto', task_id = v_task,
     decided_by = mavi_private.radar_mavi_user(i.company_id), decided_at = now(), auto_note = null, updated_at = now()
    where item_id = p_item returning * into s;
    perform mavi_private.radar_task_auto_done(i, s, v_task);
    v_status := 'auto';
   exception when others then
    update public.radar_task_suggestions set auto_note = left('A MAVI não criou sozinha: ' || sqlerrm, 500)
    where item_id = p_item;
   end;
  elsif v_block <> 'off' then
   update public.radar_task_suggestions set auto_note = left(v_block, 500) where item_id = p_item;
  end if;
 end if;
 if v_status in ('open', 'auto') then
  perform mavi_private.broadcast(i.company_id, jsonb_build_object('kind', 'radar_task_suggestion', 'item', i.id));
 end if;
 return v_status;
end $$;

-- ------------------------------------------------------------ desfazer
-- Até 24 h depois, quem edita o item ou o responsável pela tarefa desfaz a
-- tarefa criada sozinha, com o motivo: arquiva a tarefa, tira do item e
-- conta como erro (registro 'dismissed', o acerto cai).
create function public.radar_task_auto_undo(p_company uuid, p_item uuid, p_reason text, p_note text default '')
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare i public.radar_items; s public.radar_task_suggestions; t public.tasks; v_me uuid := auth.uid(); begin
 select * into i from public.radar_items where company_id = p_company and id = p_item;
 if i.id is null then raise exception 'Item não encontrado.' using errcode = 'P0002'; end if;
 select * into s from public.radar_task_suggestions where item_id = p_item for update;
 if s.item_id is null or s.status <> 'auto' then
  raise exception 'Não há tarefa criada pela MAVI para desfazer neste item.' using errcode = 'P0002';
 end if;
 select * into t from public.tasks where company_id = p_company and id = s.task_id;
 if not (mavi_private.module_client(p_company, 'radar', i.client_id)
   or (t.id is not null and t.assignee_id = v_me and mavi_private.member(p_company))) then
  raise exception 'Sem permissão' using errcode = '42501';
 end if;
 if s.decided_at < now() - interval '24 hours' then
  raise exception 'O prazo de 24 horas para desfazer acabou.' using errcode = '22023';
 end if;
 if coalesce(p_reason, '') not in ('not_needed', 'exists', 'wrong_person', 'wrong_due', 'other') then
  raise exception 'Escolha o motivo.' using errcode = '22023';
 end if;
 if length(coalesce(p_note, '')) > 1000 then raise exception 'Escreva em até 1.000 caracteres.' using errcode = '22023'; end if;
 if p_reason = 'other' and length(btrim(coalesce(p_note, ''))) < 3 then
  raise exception 'Conte o motivo.' using errcode = '22023';
 end if;
 if t.id is not null then
  update public.tasks set archived = true, version = version + 1 where id = t.id;
  insert into public.task_events(company_id, task_id, actor_id, action, detail)
  values (p_company, t.id, v_me, 'radar_auto_undone', jsonb_build_object('radar_item', i.id, 'reason', p_reason));
  delete from public.radar_item_tasks where company_id = p_company and item_id = i.id and task_id = t.id;
  update public.radar_task_signals set removed_at = now(), removed_reason = 'undone'
  where company_id = p_company and item_id = i.id and task_id = t.id and removed_at is null;
 end if;
 update public.radar_task_suggestions set status = 'undone', reason = p_reason,
  note = nullif(btrim(coalesce(p_note, '')), ''), updated_at = now()
 where item_id = p_item returning * into s;
 insert into public.radar_task_signals(company_id, item_id, client_id, topic_id, product_id, theme_id, severity,
  kind, user_id, final, from_suggestion, rule_id)
 values (p_company, i.id, i.client_id, i.topic_id, i.product_id, i.theme_id, i.severity, 'dismissed', v_me,
  jsonb_strip_nulls(jsonb_build_object('reason', p_reason, 'note', s.note, 'decision', s.decision, 'title', s.title,
   'team_id', s.team_id, 'assignee_id', s.assignee_id, 'due_days', s.due_days, 'priority', s.priority, 'auto', true)),
  true, s.rule_id);
 perform mavi_private.broadcast(p_company, jsonb_build_object('kind', 'radar_task_suggestion', 'item', i.id));
 return coalesce(public.radar_task_suggestion(p_company, p_item), jsonb_build_object('item_id', p_item, 'status', 'undone'));
end $$;

-- ------------------------------------------------------------ as telas
-- A da migração 20270608090000: com a tarefa criada sozinha (e até quando dá
-- para desfazer) e o porquê de a MAVI não ter criado sozinha.
create or replace function public.radar_task_suggestion(p_company uuid, p_item uuid) returns jsonb
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
  'task_id', case when s.status in ('auto', 'undone') then s.task_id end,
  'task_title', case when s.status in ('auto', 'undone') then (select t.title from public.tasks t where t.id = s.task_id) end,
  'task_assignee_name', case when s.status = 'auto' then (select m.name from public.tasks t join public.memberships m
    on m.company_id = t.company_id and m.user_id = t.assignee_id where t.id = s.task_id) end,
  'undo_until', case when s.status = 'auto' and s.decided_at > now() - interval '24 hours'
   then s.decided_at + interval '24 hours' end,
  'auto_note', case when s.status = 'open' then s.auto_note end,
  'reason', s.reason, 'note', s.note,
  'decided_by_name', (select m.name from public.memberships m where m.company_id = p_company and m.user_id = s.decided_by),
  'decided_at', s.decided_at, 'updated_at', s.updated_at));
end $$;

-- A origem da tarefa no Radar (a tarefa aberta por quem a vê): o item, se a
-- MAVI criou sozinha e até quando quem pode desfaz.
create function public.radar_task_origin(p_company uuid, p_task uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_me uuid := auth.uid(); t public.tasks; i public.radar_items; s public.radar_task_suggestions; begin
 select * into t from public.tasks where company_id = p_company and id = p_task;
 if t.id is null or not (mavi_private.leader(p_company) or mavi_private.task_access(p_company, p_task)) then return null; end if;
 select it.* into i from public.radar_item_tasks l join public.radar_items it on it.id = l.item_id
 where l.company_id = p_company and l.task_id = p_task order by l.created_at limit 1;
 select * into s from public.radar_task_suggestions x where x.company_id = p_company and x.task_id = p_task
  and x.status in ('auto', 'undone');
 if i.id is null and s.item_id is null then return null; end if;
 if i.id is null then select * into i from public.radar_items where id = s.item_id; end if;
 return jsonb_strip_nulls(jsonb_build_object('item_id', i.id, 'item_title', i.title,
  'topic_name', (select tp.name from public.radar_topics tp where tp.company_id = p_company and tp.id = i.topic_id),
  'auto', case when s.item_id is not null then true end, 'status', s.status,
  'rule_condition', (select r.condition from public.radar_task_rules r where r.id = s.rule_id),
  'undo_until', case when s.status = 'auto' and s.decided_at > now() - interval '24 hours'
   then s.decided_at + interval '24 hours' end,
  'can_undo', case when s.status = 'auto' and s.decided_at > now() - interval '24 hours'
   and (mavi_private.module_client(p_company, 'radar', i.client_id) or t.assignee_id = v_me) then true end));
end $$;

-- A da migração 20270608090000: com as criadas sozinhas, as desfeitas, a
-- autonomia de cada grupo (liberada, acerto na janela e o que falta) e a
-- configuração da empresa.
create or replace function public.radar_task_suggestion_stats(p_company uuid, p_filters jsonb default '{}') returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare f jsonb := coalesce(p_filters, '{}'); v_days integer; v_since timestamptz; z public.radar_task_settings; begin
 if not mavi_private.leader(p_company) then raise exception 'Sem permissão' using errcode = '42501'; end if;
 v_days := least(730, greatest(30, coalesce(case when f->>'days' ~ '^\d+$' then (f->>'days')::integer end, 180)));
 v_since := now() - make_interval(days => v_days);
 select * into z from public.radar_task_settings where company_id = p_company;
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
  ), keys as (
   select distinct s.topic_id, s.product_id from s
   union
   select a.topic_id, nullif(a.product_key, '00000000-0000-0000-0000-000000000000'::uuid) from public.radar_task_autonomy a
   where a.company_id = p_company and a.enabled
  ), g as (
   select k.topic_id, k.product_id,
    count(s.item_id) filter (where s.status = 'open') as open,
    count(s.item_id) filter (where s.status = 'created') as accepted,
    count(s.item_id) filter (where s.status = 'created' and s.as_is) as as_is,
    count(s.item_id) filter (where s.status = 'dismissed') as dismissed,
    count(s.item_id) filter (where s.status = 'replaced') as replaced,
    count(s.item_id) filter (where s.status = 'expired') as expired,
    count(s.item_id) filter (where s.status = 'none') as quiet,
    count(s.item_id) filter (where s.status = 'auto') as auto,
    count(s.item_id) filter (where s.status = 'undone') as undone,
    (select coalesce(jsonb_object_agg(q.reason, q.n), '{}') from (select y.reason, count(*) as n from s y
      where y.topic_id = k.topic_id and y.product_id is not distinct from k.product_id and y.reason is not null
      group by y.reason) q) as reasons
   from keys k left join s on s.topic_id = k.topic_id and s.product_id is not distinct from k.product_id
   group by k.topic_id, k.product_id
  )
  select jsonb_build_object(
   'settings', jsonb_strip_nulls(jsonb_build_object('suggest', coalesce(z.suggest, false), 'suggest_at', z.suggest_at,
     'suggest_by_name', (select m.name from public.memberships m where m.company_id = p_company and m.user_id = z.suggest_by),
     'autonomy_rate', coalesce(z.autonomy_rate, 90), 'autonomy_min', coalesce(z.autonomy_min, 10),
     'autonomy_days', coalesce(z.autonomy_days, 30), 'autonomy_cap', coalesce(z.autonomy_cap, 3),
     'mavi_name', (select m.name from public.memberships m where m.company_id = p_company
       and m.user_id = mavi_private.radar_mavi_user(p_company)))),
   'pending', (select count(*) from public.radar_task_suggestions q where q.company_id = p_company and q.status = 'pending'),
   'groups', (select coalesce(jsonb_agg(jsonb_build_object('topic_id', g.topic_id, 'topic_name', tp.name,
     'topic_color', tp.color, 'product_id', g.product_id, 'product_name', pr.name,
     'open', g.open, 'accepted', g.accepted, 'as_is', g.as_is, 'dismissed', g.dismissed, 'replaced', g.replaced,
     'expired', g.expired, 'quiet', g.quiet, 'auto', g.auto, 'undone', g.undone, 'reasons', g.reasons,
     'autonomy', (select jsonb_strip_nulls(jsonb_build_object(
        'enabled', coalesce(a.enabled, false), 'enabled_at', a.enabled_at,
        'enabled_by_name', (select m.name from public.memberships m where m.company_id = p_company and m.user_id = a.enabled_by),
        'decided', h.decided, 'hits', h.hits, 'rate', h.rate,
        'active', coalesce(a.enabled, false) and mavi_private.radar_mavi_user(p_company) is not null
         and h.decided >= coalesce(z.autonomy_min, 10) and coalesce(h.rate, 0) >= coalesce(z.autonomy_rate, 90)))
       from mavi_private.radar_task_hit(p_company, g.topic_id, mavi_private.radar_task_key(g.product_id),
         coalesce(z.autonomy_days, 30)) h
       left join public.radar_task_autonomy a on a.company_id = p_company and a.topic_id = g.topic_id
        and a.product_key = mavi_private.radar_task_key(g.product_id)))
     order by g.open + g.accepted + g.dismissed + g.replaced + g.expired + g.auto desc, tp.name), '[]')
    from g
    join public.radar_topics tp on tp.company_id = p_company and tp.id = g.topic_id
    left join public.products pr on pr.company_id = p_company and pr.id = g.product_id)));
end $$;

-- Liberar ou não a autonomia num tópico × produto (líderes). p_product nulo:
-- Geral / Agência.
create function public.set_radar_task_autonomy(p_company uuid, p_topic uuid, p_product uuid, p_on boolean) returns jsonb
language plpgsql security definer set search_path = '' as $$ begin
 if not mavi_private.leader(p_company) then
  raise exception 'Só administradores e gestores liberam a MAVI para criar tarefas sozinha.' using errcode = '42501';
 end if;
 if not exists (select 1 from public.radar_topics where company_id = p_company and id = p_topic) then
  raise exception 'Tópico não encontrado.' using errcode = 'P0002';
 end if;
 insert into public.radar_task_autonomy as a (company_id, topic_id, product_key, enabled, enabled_by, enabled_at, updated_at)
 values (p_company, p_topic, mavi_private.radar_task_key(p_product), coalesce(p_on, false), auth.uid(), now(), now())
 on conflict (company_id, topic_id, product_key) do update set enabled = excluded.enabled,
  enabled_by = excluded.enabled_by, enabled_at = excluded.enabled_at, updated_at = now();
 return jsonb_build_object('enabled', coalesce(p_on, false));
end $$;

-- O limite de acerto, o mínimo de decididas, a janela e o teto por cliente
-- por dia (líderes).
create function public.save_radar_task_autonomy_settings(p_company uuid, p_rate integer, p_min integer, p_days integer,
 p_cap integer) returns jsonb
language plpgsql security definer set search_path = '' as $$ begin
 if not mavi_private.leader(p_company) then
  raise exception 'Só administradores e gestores mudam os limites da autonomia.' using errcode = '42501';
 end if;
 if p_rate not between 50 and 100 then raise exception 'O acerto mínimo vai de 50%% a 100%%.' using errcode = '22023'; end if;
 if p_min not between 3 and 200 then raise exception 'O mínimo de sugestões vai de 3 a 200.' using errcode = '22023'; end if;
 if p_days not between 7 and 180 then raise exception 'A janela vai de 7 a 180 dias.' using errcode = '22023'; end if;
 if p_cap not between 1 and 50 then raise exception 'O teto vai de 1 a 50 tarefas por cliente por dia.' using errcode = '22023'; end if;
 insert into public.radar_task_settings as s (company_id, autonomy_rate, autonomy_min, autonomy_days, autonomy_cap, updated_at)
 values (p_company, p_rate, p_min, p_days, p_cap, now())
 on conflict (company_id) do update set autonomy_rate = excluded.autonomy_rate, autonomy_min = excluded.autonomy_min,
  autonomy_days = excluded.autonomy_days, autonomy_cap = excluded.autonomy_cap, updated_at = now();
 return jsonb_build_object('autonomy_rate', p_rate, 'autonomy_min', p_min, 'autonomy_days', p_days, 'autonomy_cap', p_cap);
end $$;

-- ------------------------------------------------------------ permissões
revoke all on function public.radar_task_auto_undo(uuid, uuid, text, text), public.radar_task_origin(uuid, uuid),
 public.set_radar_task_autonomy(uuid, uuid, uuid, boolean),
 public.save_radar_task_autonomy_settings(uuid, integer, integer, integer, integer) from public, anon;
grant execute on function public.radar_task_auto_undo(uuid, uuid, text, text), public.radar_task_origin(uuid, uuid),
 public.set_radar_task_autonomy(uuid, uuid, uuid, boolean),
 public.save_radar_task_autonomy_settings(uuid, integer, integer, integer, integer) to authenticated;

commit;
