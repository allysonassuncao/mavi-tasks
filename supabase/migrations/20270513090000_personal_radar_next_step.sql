begin;

-- MAVI · Radar pessoal: o "próximo passo" de cada situação.
--
-- * Boa resposta: a pessoa marca a resposta da MAVI como boa (sem precisar
--   copiar), com motivos opcionais (tom certo, dados certos, objetiva,
--   resolveu). Vira um retorno 'liked': exemplo com mais peso para o tom e para
--   as respostas do produto, e material das lições.
-- * Tarefa sugerida: ao escrever a resposta, a MAVI decide se a situação pede
--   trabalho operacional que a resposta não resolve e, só então, sugere a
--   tarefa (título, descrição, produto, pessoa ou equipe que atende o cliente,
--   prazo, prioridade e o porquê). A pessoa cria pelo formulário de tarefa
--   (sempre revisando) ou diz que não precisa; os dois viram retorno
--   ('task_created' com o que ela mudou, 'task_dismissed') e as lições ganham
--   o tipo 'task' ("quando sugerir tarefa"), por pessoa, equipe, cliente e
--   produto, como as outras.

-- ------------------------------------------------------------ retornos e lições
alter table public.personal_radar_feedback drop constraint personal_radar_feedback_action_check;
alter table public.personal_radar_feedback add constraint personal_radar_feedback_action_check
 check (action in ('not_mine', 'not_situation', 'already_resolved', 'other', 'resolved',
  'reopened', 'approved', 'edited', 'rejected', 'training', 'merged', 'liked', 'task_created', 'task_dismissed'));

alter table public.personal_radar_lessons drop constraint personal_radar_lessons_kind_check;
alter table public.personal_radar_lessons add constraint personal_radar_lessons_kind_check
 check (kind in ('detection', 'reply', 'task'));

alter table public.personal_radar_replies
 add column liked_at timestamptz,
 add column liked_tags text[] not null default '{}',
 -- {title, description, assignee_id?, team_id?, contract_id?, due?, priority?, why}.
 add column task_suggestion jsonb check (task_suggestion is null or jsonb_typeof(task_suggestion) = 'object'),
 add column task_outcome text check (task_outcome in ('created', 'dismissed')),
 add column task_id uuid;

-- ------------------------------------------------------------ quem atende o cliente
-- As equipes que atendem o cliente (as do cliente e as dos produtos ativos)
-- e as pessoas delas: o alcance da tarefa sugerida.
create function mavi_private.personal_radar_client_teams(c uuid, p_client uuid) returns uuid[]
language sql stable security definer set search_path = '' as $$
 select coalesce(array_agg(distinct x.team_id), '{}') from (
  select ct.team_id from public.client_teams ct where ct.company_id = c and ct.client_id = p_client
  union
  select ct.team_id from public.contract_teams ct
  join public.contracts k on k.company_id = ct.company_id and k.id = ct.contract_id
  where k.company_id = c and k.client_id = p_client and not k.archived) x
$$;
revoke all on function mavi_private.personal_radar_client_teams(uuid, uuid) from public, anon, authenticated;

-- O que a MAVI precisa para sugerir uma tarefa de um item: as equipes e as
-- pessoas que atendem o cliente (com o que é com cada uma), os produtos
-- ativos e as tarefas abertas do cliente (para não repetir).
create function public.personal_radar_task_context(p_company uuid, p_item uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_me uuid := auth.uid(); i public.personal_radar_items; v_teams uuid[]; begin
 if not exists (select 1 from public.personal_radar_owners where company_id = p_company and item_id = p_item and user_id = v_me)
  or not mavi_private.member(p_company) then
  raise exception 'Item não encontrado' using errcode = 'P0002';
 end if;
 select * into i from public.personal_radar_items where id = p_item;
 v_teams := mavi_private.personal_radar_client_teams(p_company, i.client_id);
 return jsonb_build_object(
  'teams', (select coalesce(jsonb_agg(jsonb_build_object('id', t.id, 'name', t.name,
    'members', (select coalesce(jsonb_agg(m.name order by m.name), '[]') from public.team_members tm
     join public.memberships m on m.company_id = tm.company_id and m.user_id = tm.user_id and m.active
     where tm.company_id = p_company and tm.team_id = t.id)) order by t.name), '[]')
   from public.teams t where t.company_id = p_company and t.id = any(v_teams)),
  'people', (select coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object('id', m.user_id, 'name', m.name,
    'teams', (select jsonb_agg(t.name order by t.name) from public.team_members x join public.teams t
     on t.company_id = x.company_id and t.id = x.team_id where x.company_id = p_company and x.user_id = m.user_id
      and x.team_id = any(v_teams)),
    'about', nullif((select p.about from public.personal_radar_people p where p.company_id = p_company
     and p.user_id = m.user_id), ''), 'me', case when m.user_id = v_me then true end)) order by m.name), '[]')
   from public.memberships m where m.company_id = p_company and m.active
    and exists (select 1 from public.team_members tm where tm.company_id = p_company and tm.user_id = m.user_id
     and tm.team_id = any(v_teams))),
  'contracts', (select coalesce(jsonb_agg(jsonb_build_object('id', k.id, 'product', pr.name,
    'product_id', pr.id) order by pr.name), '[]')
   from public.contracts k join public.products pr on pr.company_id = k.company_id and pr.id = k.product_id
   where k.company_id = p_company and k.client_id = i.client_id and not k.archived),
  'product_id', i.product_id,
  'open_tasks', (select coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object('title', t.title, 'status', t.status,
    'assignee', (select m.name from public.memberships m where m.company_id = t.company_id and m.user_id = t.assignee_id),
    'due', t.due_date)) order by t.created_at desc), '[]')
   from (select t.* from public.tasks t join public.contracts k on k.company_id = t.company_id and k.id = t.contract_id
    where t.company_id = p_company and k.client_id = i.client_id and not t.archived and t.status <> 'done'
    order by t.created_at desc limit 25) t));
end $$;

-- A tarefa sugerida, conferida: pessoa e equipe só entre quem atende o
-- cliente, produto só entre os contratados; sem título, nada.
create function mavi_private.personal_radar_task_clean(c uuid, p_client uuid, p jsonb) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_teams uuid[] := mavi_private.personal_radar_client_teams(c, p_client); v_user uuid; v_team uuid;
 v_contract uuid; v_due date; begin
 if jsonb_typeof(p) is distinct from 'object' or length(btrim(coalesce(p->>'title', ''))) < 3 then return null; end if;
 v_user := case when (p->>'assignee_id') ~* '^[0-9a-f-]{36}$' then (p->>'assignee_id')::uuid end;
 if v_user is not null and not exists (select 1 from public.team_members tm join public.memberships m
   on m.company_id = tm.company_id and m.user_id = tm.user_id and m.active
   where tm.company_id = c and tm.user_id = v_user and tm.team_id = any(v_teams)) then v_user := null; end if;
 v_team := case when (p->>'team_id') ~* '^[0-9a-f-]{36}$' and (p->>'team_id')::uuid = any(v_teams)
  then (p->>'team_id')::uuid end;
 v_contract := case when (p->>'contract_id') ~* '^[0-9a-f-]{36}$' then (p->>'contract_id')::uuid end;
 if v_contract is not null and not exists (select 1 from public.contracts k where k.company_id = c and k.id = v_contract
  and k.client_id = p_client and not k.archived) then v_contract := null; end if;
 v_due := case when coalesce(p->>'due', '') ~ '^\d{4}-\d{2}-\d{2}$' then (p->>'due')::date end;
 return jsonb_strip_nulls(jsonb_build_object('title', left(btrim(p->>'title'), 200),
  'description', nullif(left(btrim(coalesce(p->>'description', '')), 4000), ''),
  'assignee_id', v_user, 'team_id', case when v_user is null then v_team end, 'contract_id', v_contract,
  'due', case when v_due >= current_date then v_due end,
  'priority', case when p->>'priority' in ('low', 'normal', 'high', 'urgent') then p->>'priority' end,
  'why', nullif(left(btrim(coalesce(p->>'why', '')), 300), '')));
exception when others then return null;
end $$;
revoke all on function mavi_private.personal_radar_task_clean(uuid, uuid, jsonb) from public, anon, authenticated;

-- A da migração 20270306090000, com a tarefa sugerida (e sem o "boa" e a
-- tarefa da versão anterior).
create or replace function public.personal_radar_draft_store(p_company uuid, p_item uuid, p_draft jsonb, p_usage jsonb default '{}')
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_me uuid := auth.uid(); i public.personal_radar_items; v_cost numeric; v_conf text; begin
 if not mavi_private.personal_radar_can_draft(p_company, p_item) then
  raise exception 'Item não encontrado' using errcode = 'P0002';
 end if;
 select * into i from public.personal_radar_items where id = p_item;
 if coalesce(btrim(p_draft->>'reply'), '') = '' then raise exception 'A resposta veio vazia.' using errcode = '22023'; end if;
 v_conf := case when p_draft->>'confidence' in ('high', 'medium', 'low') then p_draft->>'confidence' end;
 v_cost := least(greatest(coalesce((p_usage->>'cost')::numeric, 0), 0), 100);
 update public.personal_radar_replies set status = 'done', reply = left(p_draft->>'reply', 6000),
  evidence = case when jsonb_typeof(p_draft->'evidence') = 'array' then (select coalesce(jsonb_agg(e), '[]')
   from (select e from jsonb_array_elements(p_draft->'evidence') e where jsonb_typeof(e) = 'object' limit 12) s) else '[]' end,
  actions = case when jsonb_typeof(p_draft->'actions') = 'array' then (select coalesce(jsonb_agg(e), '[]')
   from (select e from jsonb_array_elements(p_draft->'actions') e where jsonb_typeof(e) = 'object'
    and e->>'kind' in ('recording', 'file', 'report') limit 6) s) else '[]' end,
  checks = case when jsonb_typeof(p_draft->'checks') = 'array' then (select coalesce(jsonb_agg(left(e, 300)), '[]')
   from (select e from jsonb_array_elements_text(p_draft->'checks') e limit 6) s) else '[]' end,
  confidence = v_conf, model = left(coalesce(p_draft->>'model', p_usage->>'model', ''), 80),
  cost_usd = cost_usd + v_cost, version = version + 1, claimed_until = null, error = null,
  based_on_at = i.last_at, approved_at = null, approved_text = null, updated_at = now(),
  liked_at = null, liked_tags = '{}',
  -- A tarefa já criada ou dispensada continua decidida; senão, vale a nova sugestão.
  task_suggestion = case when task_outcome is not null then task_suggestion
   else mavi_private.personal_radar_task_clean(p_company, i.client_id, p_draft->'task') end
 where item_id = p_item and user_id = v_me;
 if not found then raise exception 'A resposta não estava reservada.' using errcode = 'P0002'; end if;
 insert into public.ai_usage(company_id, user_id, module, kind, client_id, model, input_tokens, output_tokens,
  cache_read_tokens, cache_write_tokens, embedding_tokens, cost_usd, provider_id, provider_name)
 values (p_company, v_me, 'personal_radar', 'reply', i.client_id, left(coalesce(p_usage->>'model', ''), 80),
  coalesce((p_usage->>'input')::integer, 0), coalesce((p_usage->>'output')::integer, 0),
  coalesce((p_usage->>'cache_read')::integer, 0), coalesce((p_usage->>'cache_write')::integer, 0),
  coalesce((p_usage->>'embedding')::integer, 0), v_cost,
  case when (p_usage->>'provider_id') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
   then (p_usage->>'provider_id')::uuid end,
  left(coalesce(p_usage->>'provider', ''), 120));
 perform mavi_private.broadcast(p_company, jsonb_build_object('kind', 'personal_radar', 'people', jsonb_build_array(v_me)));
 return mavi_private.personal_radar_item_json(i, v_me);
end $$;

-- A da migração 20270512090000, com o "boa" e a tarefa sugerida na resposta.
create or replace function mavi_private.personal_radar_item_json(i public.personal_radar_items, p_user uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
 select jsonb_strip_nulls(jsonb_build_object('id', i.id, 'kind', i.kind, 'title', i.title, 'summary', i.summary,
  'urgency', i.urgency, 'status', i.status, 'asks', i.asks, 'first_at', i.first_at, 'last_at', i.last_at,
  'resolved_at', i.resolved_at, 'resolved_how', i.resolved_how, 'resolved_by_name', i.resolved_by_name,
  'reopened_at', i.reopened_at,
  'client', jsonb_build_object('id', i.client_id, 'name', (select k.name from public.clients k where k.id = i.client_id)),
  'group', jsonb_build_object('id', i.group_id, 'title', (select w.title from public.whatsapp_groups w where w.id = i.group_id)),
  'reason', o.reason, 'why', o.why, 'state', o.state, 'dismissed_reason', o.dismissed_reason,
  'others', (select jsonb_agg(m.name order by m.name) from public.personal_radar_owners x
   join public.memberships m on m.company_id = x.company_id and m.user_id = x.user_id
   where x.item_id = i.id and x.user_id <> p_user and x.state = 'open'),
  'mentions', (select jsonb_agg(jsonb_build_object('message_id', q.message_id, 'role', q.role, 'speaker', q.speaker,
    'quote', q.quote, 'at', q.at) order by q.at) from (select * from public.personal_radar_mentions pm
    where pm.item_id = i.id order by pm.at desc limit 4) q),
  'mention_count', (select count(*) from public.personal_radar_mentions pm where pm.item_id = i.id),
  'task', (select jsonb_build_object('id', t.id, 'title', t.title, 'status', t.status) from public.tasks t
   where t.id = i.task_id and not t.archived and (mavi_private.leader(i.company_id) or mavi_private.task_access(i.company_id, t.id))),
  'radar', (select jsonb_build_object('id', r.id, 'title', r.title) from public.radar_items r where r.id = i.radar_item_id),
  'reply', (select jsonb_strip_nulls(jsonb_build_object('status', case when r.status = 'running' and r.claimed_until < now()
     then 'failed' else r.status end,
    'text', nullif(r.reply, ''), 'evidence', r.evidence, 'actions', r.actions, 'checks', r.checks,
    'confidence', r.confidence, 'model', nullif(r.model, ''), 'version', r.version, 'error', r.error,
    'updated_at', r.updated_at, 'approved_at', r.approved_at, 'approved_text', r.approved_text,
    'stale', r.status = 'done' and r.approved_at is null and r.based_on_at < i.last_at,
    'guidance', nullif(r.guidance, ''),
    'liked_at', r.liked_at, 'liked_tags', case when cardinality(r.liked_tags) > 0 then to_jsonb(r.liked_tags) end,
    'task', case when r.task_suggestion is not null then r.task_suggestion || jsonb_strip_nulls(jsonb_build_object(
     'outcome', r.task_outcome, 'task_id', r.task_id,
     'assignee_name', (select m.name from public.memberships m where m.company_id = r.company_id
      and m.user_id::text = r.task_suggestion->>'assignee_id'),
     'team_name', (select t.name from public.teams t where t.company_id = r.company_id and t.id::text = r.task_suggestion->>'team_id'),
     'product_name', (select pr.name from public.contracts k join public.products pr on pr.company_id = k.company_id
      and pr.id = k.product_id where k.company_id = r.company_id and k.id::text = r.task_suggestion->>'contract_id'))) end))
   from public.personal_radar_replies r where r.item_id = i.id and r.user_id = p_user),
  'product', (select jsonb_build_object('id', pr.id, 'name', pr.name) from public.products pr where pr.id = i.product_id),
  'product_person', case when i.product_person then true end,
  'products', (select jsonb_agg(distinct jsonb_build_object('id', pr.id, 'name', pr.name)) from public.contracts k
   join public.products pr on pr.company_id = k.company_id and pr.id = k.product_id
   where k.company_id = i.company_id and k.client_id = i.client_id and not k.archived),
  'agent_check', i.agent_check))
 from public.personal_radar_owners o where o.item_id = i.id and o.user_id = p_user
$$;
revoke all on function mavi_private.personal_radar_item_json(public.personal_radar_items, uuid) from public, anon, authenticated;

-- ------------------------------------------------------------ boa resposta
-- Marca (ou desmarca) a resposta como boa; p_tags: tone | data | concise |
-- solved. O retorno é um por versão da resposta (marcar de novo só troca os
-- motivos, enquanto a MAVI ainda não aprendeu com ele).
create function public.personal_radar_reply_like(p_company uuid, p_item uuid, p_liked boolean, p_tags text[] default '{}')
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_me uuid := auth.uid(); i public.personal_radar_items; r public.personal_radar_replies;
 v_tags text[] := (select coalesce(array_agg(distinct t), '{}') from unnest(coalesce(p_tags, '{}')) t
  where t in ('tone', 'data', 'concise', 'solved')); v_fb uuid; begin
 if not exists (select 1 from public.personal_radar_owners where company_id = p_company and item_id = p_item and user_id = v_me)
  or not mavi_private.member(p_company) then
  raise exception 'Item não encontrado' using errcode = 'P0002';
 end if;
 select * into i from public.personal_radar_items where id = p_item;
 select * into r from public.personal_radar_replies where item_id = p_item and user_id = v_me for update;
 if r.item_id is null or r.reply = '' then raise exception 'A MAVI ainda não escreveu esta resposta.' using errcode = 'P0002'; end if;
 select f.id into v_fb from public.personal_radar_feedback f
 where f.company_id = p_company and f.item_id = p_item and f.user_id = v_me and f.action = 'liked'
  and (f.snapshot->>'version')::integer = r.version
 order by f.created_at desc limit 1;
 if p_liked then
  update public.personal_radar_replies set liked_at = coalesce(liked_at, now()), liked_tags = v_tags, updated_at = now()
  where item_id = p_item and user_id = v_me;
  if v_fb is null then
   insert into public.personal_radar_feedback(company_id, item_id, user_id, action, note, snapshot)
   values (p_company, p_item, v_me, 'liked', '', jsonb_strip_nulls(jsonb_build_object('kind', i.kind, 'title', i.title,
    'summary', i.summary, 'client', (select name from public.clients where id = i.client_id),
    'draft', r.reply, 'final', coalesce(r.approved_text, r.reply), 'version', r.version, 'model', nullif(r.model, ''),
    'tags', to_jsonb(v_tags))));
  else
   update public.personal_radar_feedback set snapshot = snapshot || jsonb_build_object('tags', to_jsonb(v_tags))
   where id = v_fb and learned_at is null;
  end if;
 else
  update public.personal_radar_replies set liked_at = null, liked_tags = '{}', updated_at = now()
  where item_id = p_item and user_id = v_me;
  -- Desmarcou antes de a MAVI aprender: o retorno some.
  delete from public.personal_radar_feedback where id = v_fb and learned_at is null;
 end if;
 return mavi_private.personal_radar_item_json(i, v_me);
end $$;

-- ------------------------------------------------------------ a tarefa sugerida
-- p_outcome: created (p_task: a tarefa criada pelo formulário; o item fica
-- ligado a ela) ou dismissed ("não precisa", com o motivo opcional).
create function public.personal_radar_task_outcome(p_company uuid, p_item uuid, p_outcome text, p_task uuid default null,
 p_note text default '') returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_me uuid := auth.uid(); i public.personal_radar_items; r public.personal_radar_replies; t public.tasks;
 s jsonb; v_changed text[] := '{}'; begin
 if not exists (select 1 from public.personal_radar_owners where company_id = p_company and item_id = p_item and user_id = v_me)
  or not mavi_private.member(p_company) then
  raise exception 'Item não encontrado' using errcode = 'P0002';
 end if;
 if coalesce(p_outcome, '') not in ('created', 'dismissed') then raise exception 'Ação inválida' using errcode = '22023'; end if;
 if length(coalesce(p_note, '')) > 1000 then raise exception 'Escreva em até 1.000 caracteres.' using errcode = '22023'; end if;
 select * into i from public.personal_radar_items where id = p_item for update;
 select * into r from public.personal_radar_replies where item_id = p_item and user_id = v_me for update;
 s := r.task_suggestion;
 if p_outcome = 'created' then
  select * into t from public.tasks where company_id = p_company and id = p_task
   and (creator_id = v_me or mavi_private.task_access(p_company, id));
  if t.id is null then raise exception 'Tarefa não encontrada' using errcode = 'P0002'; end if;
  if s is not null then
   v_changed := array_remove(array[
    case when lower(btrim(t.title)) <> lower(coalesce(s->>'title', '')) then 'title' end,
    case when s ? 'assignee_id' and t.assignee_id::text is distinct from s->>'assignee_id' then 'assignee' end,
    case when s ? 'team_id' and t.team_id::text is distinct from s->>'team_id' then 'team' end,
    case when s ? 'contract_id' and t.contract_id::text is distinct from s->>'contract_id' then 'product' end,
    case when s ? 'due' and t.due_date::text is distinct from s->>'due' then 'due' end], null);
  end if;
  if r.item_id is not null then
   update public.personal_radar_replies set task_outcome = 'created', task_id = t.id, updated_at = now()
   where item_id = p_item and user_id = v_me;
  end if;
  update public.personal_radar_items set task_id = coalesce(task_id, t.id), updated_at = now() where id = p_item;
 else
  if r.item_id is null or s is null then raise exception 'Não há tarefa sugerida.' using errcode = 'P0002'; end if;
  update public.personal_radar_replies set task_outcome = 'dismissed', updated_at = now()
  where item_id = p_item and user_id = v_me;
 end if;
 -- O aprendizado: o que a MAVI sugeriu (draft) e o que virou (final).
 insert into public.personal_radar_feedback(company_id, item_id, user_id, action, note, snapshot)
 values (p_company, p_item, v_me, case when p_outcome = 'created' then 'task_created' else 'task_dismissed' end,
  coalesce(btrim(p_note), ''),
  jsonb_strip_nulls(jsonb_build_object('kind', i.kind, 'title', i.title, 'summary', i.summary,
   'client', (select name from public.clients where id = i.client_id),
   'draft', case when s is not null then concat_ws(' · ', 'Tarefa sugerida: ' || (s->>'title'),
     'para ' || coalesce((select m.name from public.memberships m where m.company_id = p_company and m.user_id::text = s->>'assignee_id'),
      (select 'a equipe ' || tm.name from public.teams tm where tm.company_id = p_company and tm.id::text = s->>'team_id')),
     'motivo: ' || (s->>'why')) end,
   'final', case when p_outcome = 'created' then concat_ws(' · ', 'Tarefa criada: ' || t.title,
     'com ' || (select m.name from public.memberships m where m.company_id = p_company and m.user_id = t.assignee_id),
     case when cardinality(v_changed) > 0 then 'mudou: ' || array_to_string(v_changed, ', ')
      when s is not null then 'como sugerida' else 'sem sugestão da MAVI' end) end,
   'suggested', case when s is not null then true end)));
 perform mavi_private.broadcast(p_company, jsonb_build_object('kind', 'personal_radar', 'people', jsonb_build_array(v_me)));
 select * into i from public.personal_radar_items where id = p_item;
 return mavi_private.personal_radar_item_json(i, v_me);
end $$;

-- ------------------------------------------------------------ o aprendizado
-- As lições em uso (a da migração 20270512090000, com o tipo de cada uma).
create or replace function mavi_private.personal_radar_lessons_for(c uuid, u uuid, p_client uuid, p_kind text, p_product uuid)
returns jsonb
language sql stable security definer set search_path = '' as $$
 select coalesce(jsonb_agg(jsonb_build_object('scope', l.scope, 'kind', l.kind, 'text', l.text) order by l.o, l.updated_at desc), '[]')
 from (select l.*, case l.scope when 'person' then 0 when 'client' then 1 when 'product' then 2 else 3 end as o
  from public.personal_radar_lessons l
  where l.company_id = c and l.kind = any(string_to_array(p_kind, ',')) and l.status = 'active'
   and ((l.scope = 'person' and l.user_id = u)
    or (l.scope = 'team' and l.team_id in (select tm.team_id from public.team_members tm where tm.company_id = c and tm.user_id = u))
    or (l.scope = 'client' and p_client is not null and l.client_id = p_client)
    or (l.scope = 'product' and (l.product_id = p_product or (p_product is null and p_client is not null
     and l.product_id in (select k.product_id from public.contracts k where k.company_id = c and k.client_id = p_client
      and not k.archived)))))
  order by o, l.updated_at desc
  limit 40) l
$$;

-- Para a resposta: as de resposta e as de tarefa.
create or replace function public.personal_radar_reply_lessons(p_company uuid, p_client uuid, p_product uuid default null) returns jsonb
language plpgsql stable security definer set search_path = '' as $$ begin
 if not mavi_private.member(p_company) then raise exception 'Sem permissão' using errcode = '42501'; end if;
 return mavi_private.personal_radar_lessons_for(p_company, auth.uid(), p_client, 'reply,task', p_product);
end $$;

-- A da migração 20270307090000, aceitando o tipo 'task'.
create or replace function public.ai_personal_radar_learning_store(p_secret text, p_company uuid, p_user uuid, p_ops jsonb,
 p_learned uuid[], p_usage jsonb default '{}') returns integer
language plpgsql security definer set search_path = '' as $$
declare o jsonb; n integer := 0; v_text text; v_kind text; v_id uuid; v_fb uuid[]; v_cost numeric; begin
 if not mavi_private.ai_secret_ok(p_secret) then raise exception 'Sem permissão' using errcode = '42501'; end if;
 for o in select * from jsonb_array_elements(case when jsonb_typeof(p_ops) = 'array' then p_ops else '[]' end) loop
  v_text := left(btrim(coalesce(o->>'text', '')), 400);
  v_kind := case when o->>'kind' in ('detection', 'reply', 'task') then o->>'kind' end;
  v_id := case when coalesce(o->>'id', '') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then (o->>'id')::uuid end;
  select coalesce(array_agg(f.id), '{}') into v_fb from public.personal_radar_feedback f
  where f.company_id = p_company and f.user_id = p_user
   and f.id::text in (select jsonb_array_elements_text(case when jsonb_typeof(o->'feedback') = 'array' then o->'feedback' else '[]' end));
  if o->>'op' = 'add' and v_kind is not null and length(v_text) >= 5
   and not exists (select 1 from public.personal_radar_lessons x where x.company_id = p_company and x.scope = 'person'
    and x.user_id = p_user and lower(x.text) = lower(v_text)) then
   insert into public.personal_radar_lessons(company_id, scope, user_id, kind, text, origin, feedback)
   values (p_company, 'person', p_user, v_kind, v_text, 'mavi', v_fb);
   n := n + 1;
  elsif o->>'op' = 'update' and v_id is not null and length(v_text) >= 5 then
   update public.personal_radar_lessons set text = v_text, kind = coalesce(v_kind, kind),
    feedback = (select array(select distinct unnest(feedback || v_fb))), updated_at = now()
   where id = v_id and company_id = p_company and scope = 'person' and user_id = p_user
    and origin = 'mavi' and status = 'active';
   n := n + case when found then 1 else 0 end;
  elsif o->>'op' = 'retire' and v_id is not null then
   delete from public.personal_radar_lessons where id = v_id and company_id = p_company and scope = 'person'
    and user_id = p_user and origin = 'mavi' and status = 'active'
    and not exists (select 1 from public.personal_radar_lessons y where y.source_lesson = v_id);
   n := n + case when found then 1 else 0 end;
  end if;
 end loop;
 update public.personal_radar_feedback set learned_at = now()
 where company_id = p_company and user_id = p_user and id = any(coalesce(p_learned, '{}'));
 update public.personal_radar_learning set learned_at = now(), claimed_until = null, attempts = 0, last_error = null
 where company_id = p_company and user_id = p_user;
 v_cost := least(greatest(coalesce((p_usage->>'cost')::numeric, 0), 0), 100);
 if v_cost > 0 or coalesce((p_usage->>'input')::integer, 0) > 0 then
  insert into public.ai_usage(company_id, user_id, module, kind, model, input_tokens, output_tokens,
   cache_read_tokens, cache_write_tokens, cost_usd, provider_id, provider_name)
  values (p_company, p_user, 'personal_radar', 'learning', left(coalesce(p_usage->>'model', ''), 80),
   coalesce((p_usage->>'input')::integer, 0), coalesce((p_usage->>'output')::integer, 0),
   coalesce((p_usage->>'cache_read')::integer, 0), coalesce((p_usage->>'cache_write')::integer, 0), v_cost,
   case when (p_usage->>'provider_id') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    then (p_usage->>'provider_id')::uuid end,
   left(coalesce(p_usage->>'provider', ''), 120));
 end if;
 if n > 0 then
  perform mavi_private.broadcast(p_company, jsonb_build_object('kind', 'personal_radar', 'people', jsonb_build_array(p_user),
   'lessons', true));
 end if;
 return n;
end $$;

-- A da migração 20270307090000, aceitando o tipo 'task'.
create or replace function public.save_personal_radar_lesson(p_company uuid, p_id uuid, p_kind text, p_text text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_me uuid := auth.uid(); l public.personal_radar_lessons; v_text text := btrim(coalesce(p_text, '')); begin
 if not mavi_private.member(p_company) then raise exception 'Sem permissão' using errcode = '42501'; end if;
 if length(v_text) not between 5 and 400 then
  raise exception 'Escreva a lição com 5 a 400 caracteres.' using errcode = '22023';
 end if;
 if coalesce(p_kind, '') not in ('detection', 'reply', 'task') then raise exception 'Tipo inválido' using errcode = '22023'; end if;
 if p_id is null then
  if not mavi_private.personal_radar_allowed(p_company, v_me) then
   raise exception 'O Radar pessoal ainda não foi liberado para você.' using errcode = '42501';
  end if;
  insert into public.personal_radar_lessons(company_id, scope, user_id, kind, text, origin, created_by, updated_by)
  values (p_company, 'person', v_me, p_kind, v_text, 'person', v_me, v_me) returning * into l;
 else
  select * into l from public.personal_radar_lessons where id = p_id and company_id = p_company for update;
  if not found or (l.scope = 'person' and l.user_id <> v_me) or (l.scope <> 'person' and not mavi_private.leader(p_company)) then
   raise exception 'Lição não encontrada' using errcode = 'P0002';
  end if;
  update public.personal_radar_lessons set text = v_text, kind = p_kind,
   origin = case when scope = 'person' then 'person' else 'leader' end,
   status = case when scope <> 'person' and status in ('active', 'refused') then 'checking' else status end,
   check_attempts = case when scope <> 'person' then 0 else check_attempts end,
   updated_by = v_me, updated_at = now()
  where id = p_id returning * into l;
 end if;
 return mavi_private.personal_radar_lesson_json(l);
end $$;

-- A da migração 20270512090000, aceitando o tipo 'task'.
create or replace function public.save_personal_radar_product_lesson(p_company uuid, p_id uuid, p_product uuid, p_kind text,
 p_text text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_me uuid := auth.uid(); l public.personal_radar_lessons; v_text text := btrim(coalesce(p_text, '')); begin
 if not mavi_private.leader(p_company) then
  raise exception 'Só administradores e gestores mexem nas lições do produto.' using errcode = '42501';
 end if;
 if length(v_text) not between 5 and 400 then
  raise exception 'Escreva a lição com 5 a 400 caracteres.' using errcode = '22023';
 end if;
 if coalesce(p_kind, '') not in ('detection', 'reply', 'task') then raise exception 'Tipo inválido' using errcode = '22023'; end if;
 if p_id is null then
  if not exists (select 1 from public.products where company_id = p_company and id = p_product) then
   raise exception 'Produto não encontrado' using errcode = 'P0002';
  end if;
  insert into public.personal_radar_lessons(company_id, scope, product_id, kind, text, status, origin, created_by, updated_by)
  values (p_company, 'product', p_product, p_kind, v_text, 'active', 'leader', v_me, v_me) returning * into l;
 else
  update public.personal_radar_lessons set text = v_text, kind = p_kind, updated_by = v_me, updated_at = now(),
   origin = case when status = 'suggested' then origin else 'leader' end
  where id = p_id and company_id = p_company and scope = 'product' returning * into l;
  if l.id is null then raise exception 'Lição não encontrada' using errcode = 'P0002'; end if;
 end if;
 return mavi_private.personal_radar_lesson_json(l);
end $$;

-- A da migração 20270512090000, aceitando o tipo 'task'.
create or replace function public.ai_personal_radar_product_store(p_secret text, p_company uuid, p_product uuid, p_ops jsonb,
 p_usage jsonb default '{}') returns integer
language plpgsql security definer set search_path = '' as $$
declare o jsonb; n integer := 0; v_text text; v_kind text; v_id uuid; v_fb uuid[]; v_cost numeric; begin
 if not mavi_private.ai_secret_ok(p_secret) then raise exception 'Sem permissão' using errcode = '42501'; end if;
 for o in select * from jsonb_array_elements(case when jsonb_typeof(p_ops) = 'array' then p_ops else '[]' end) loop
  v_text := left(btrim(coalesce(o->>'text', '')), 400);
  v_kind := case when o->>'kind' in ('detection', 'reply', 'task') then o->>'kind' end;
  v_id := case when coalesce(o->>'id', '') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then (o->>'id')::uuid end;
  select coalesce(array_agg(f.id), '{}') into v_fb from public.personal_radar_feedback f
  where f.company_id = p_company
   and f.id::text in (select jsonb_array_elements_text(case when jsonb_typeof(o->'feedback') = 'array' then o->'feedback' else '[]' end));
  continue when length(v_text) < 5 or exists (select 1 from public.personal_radar_lessons x where x.company_id = p_company
   and x.scope = 'product' and x.product_id = p_product and lower(x.text) = lower(v_text));
  if o->>'op' = 'add' and v_kind is not null then
   insert into public.personal_radar_lessons(company_id, scope, product_id, kind, text, status, origin, feedback)
   values (p_company, 'product', p_product, v_kind, v_text, 'checking', 'mavi', v_fb);
   n := n + 1;
  elsif o->>'op' = 'update' and v_id is not null then
   update public.personal_radar_lessons set text = v_text, kind = coalesce(v_kind, kind), status = 'checking',
    check_attempts = 0, check_note = null, feedback = (select array(select distinct unnest(feedback || v_fb))), updated_at = now()
   where id = v_id and company_id = p_company and scope = 'product' and product_id = p_product
    and origin = 'mavi' and status in ('suggested', 'checking');
   n := n + case when found then 1 else 0 end;
  end if;
 end loop;
 update public.personal_radar_product_learning set learned_at = now(), claimed_until = null, attempts = 0, last_error = null
 where company_id = p_company and product_id = p_product;
 v_cost := least(greatest(coalesce((p_usage->>'cost')::numeric, 0), 0), 100);
 if v_cost > 0 or coalesce((p_usage->>'input')::integer, 0) > 0 then
  insert into public.ai_usage(company_id, user_id, module, kind, model, input_tokens, output_tokens,
   cache_read_tokens, cache_write_tokens, cost_usd, provider_id, provider_name)
  values (p_company, null, 'personal_radar', 'product_learning', left(coalesce(p_usage->>'model', ''), 80),
   coalesce((p_usage->>'input')::integer, 0), coalesce((p_usage->>'output')::integer, 0),
   coalesce((p_usage->>'cache_read')::integer, 0), coalesce((p_usage->>'cache_write')::integer, 0), v_cost,
   case when (p_usage->>'provider_id') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    then (p_usage->>'provider_id')::uuid end,
   left(coalesce(p_usage->>'provider', ''), 120));
 end if;
 return n;
end $$;

-- Os retornos que contam para o aprendizado por produto, com o "boa" e a
-- tarefa (as da migração 20270512090000).
create or replace function mavi_private.personal_radar_product_dirty() returns trigger
language plpgsql security definer set search_path = '' as $$ begin
 insert into public.personal_radar_product_learning as q (company_id, product_id, dirty_at)
 select distinct n.company_id, it.product_id, now() from new_rows n
 join public.personal_radar_items it on it.id = n.item_id
 where it.product_id is not null
  and n.action in ('approved', 'edited', 'rejected', 'training', 'liked', 'task_created', 'task_dismissed')
 on conflict (company_id, product_id) do update set dirty_at = now();
 return null;
end $$;

create or replace function mavi_private.personal_radar_product_due(q public.personal_radar_product_learning) returns boolean
language sql stable security definer set search_path = '' as $$
 select (q.claimed_until is null or q.claimed_until < now()) and q.attempts < 5
  and (q.learned_at is null or q.dirty_at > q.learned_at)
  and (select count(*) >= 5 or (count(*) >= 2 and min(f.created_at) < now() - interval '6 hours')
   from public.personal_radar_feedback f join public.personal_radar_items it on it.id = f.item_id
   where f.company_id = q.company_id and it.product_id = q.product_id
    and f.action in ('approved', 'edited', 'rejected', 'training', 'liked', 'task_created', 'task_dismissed')
    and (q.learned_at is null or f.created_at > q.learned_at))
$$;

create or replace function public.ai_personal_radar_product_claim(p_secret text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare l public.personal_radar_product_learning; begin
 if not mavi_private.ai_secret_ok(p_secret) then raise exception 'Sem permissão' using errcode = '42501'; end if;
 select q.* into l from public.personal_radar_product_learning q
 where mavi_private.personal_radar_product_due(q)
 order by q.dirty_at limit 1 for update skip locked;
 if not found then return null; end if;
 update public.personal_radar_product_learning set claimed_until = now() + interval '10 minutes', attempts = attempts + 1
 where company_id = l.company_id and product_id = l.product_id;
 return jsonb_build_object('company', l.company_id, 'product', l.product_id,
  'product_name', (select p.name from public.products p where p.id = l.product_id),
  'clients', (select count(distinct k.client_id) from public.contracts k where k.company_id = l.company_id
   and k.product_id = l.product_id and not k.archived),
  'feedback', (select coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object('id', f.id, 'action', f.action,
    'note', nullif(f.note, ''), 'kind', it.kind, 'title', it.title, 'summary', left(it.summary, 300),
    'reason', f.snapshot->>'reason', 'draft', left(f.snapshot->>'draft', 800), 'final', left(f.snapshot->>'final', 800),
    'tags', f.snapshot->'tags',
    'at', to_char(f.created_at at time zone 'America/Sao_Paulo', 'DD/MM HH24:MI'))) order by f.created_at), '[]')
   from (select z.* from public.personal_radar_feedback z join public.personal_radar_items y on y.id = z.item_id
    where z.company_id = l.company_id and y.product_id = l.product_id
     and z.action in ('approved', 'edited', 'rejected', 'training', 'liked', 'task_created', 'task_dismissed')
     and (l.learned_at is null or z.created_at > l.learned_at)
    order by z.created_at desc limit 40) f
   join public.personal_radar_items it on it.id = f.item_id),
  'lessons', (select coalesce(jsonb_agg(jsonb_build_object('id', x.id, 'kind', x.kind, 'text', x.text,
    'status', x.status, 'origin', x.origin) order by x.created_at), '[]')
   from public.personal_radar_lessons x where x.company_id = l.company_id and x.scope = 'product'
    and x.product_id = l.product_id));
end $$;

-- Os retornos da pessoa para o aprendizado, com os motivos do "boa" (a da
-- migração 20270307090000).
create or replace function public.ai_personal_radar_learning_claim(p_secret text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare l public.personal_radar_learning; begin
 if not mavi_private.ai_secret_ok(p_secret) then raise exception 'Sem permissão' using errcode = '42501'; end if;
 select q.* into l from public.personal_radar_learning q
 where (q.claimed_until is null or q.claimed_until < now()) and q.attempts < 5
  and (q.learned_at is null or q.dirty_at > q.learned_at)
  and exists (select 1 from public.personal_radar_feedback f where f.company_id = q.company_id and f.user_id = q.user_id
   and f.learned_at is null)
  and ((select count(*) from public.personal_radar_feedback f where f.company_id = q.company_id and f.user_id = q.user_id
    and f.learned_at is null) >= 3
   or (select min(f.created_at) from public.personal_radar_feedback f where f.company_id = q.company_id and f.user_id = q.user_id
    and f.learned_at is null) < now() - interval '30 minutes')
 order by q.dirty_at
 limit 1
 for update skip locked;
 if not found then return null; end if;
 update public.personal_radar_learning set claimed_until = now() + interval '10 minutes', attempts = attempts + 1
 where company_id = l.company_id and user_id = l.user_id;
 return jsonb_build_object('company', l.company_id, 'user', l.user_id,
  'person', (select jsonb_build_object('name', m.name, 'about', coalesce(p.about, ''),
    'teams', (select coalesce(jsonb_agg(distinct t.name), '[]') from public.team_members tm
     join public.teams t on t.company_id = tm.company_id and t.id = tm.team_id
     where tm.company_id = l.company_id and tm.user_id = l.user_id))
   from public.memberships m left join public.personal_radar_people p on p.company_id = m.company_id and p.user_id = m.user_id
   where m.company_id = l.company_id and m.user_id = l.user_id),
  'feedback', (select coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object('id', f.id, 'action', f.action,
    'note', nullif(f.note, ''), 'kind', f.snapshot->>'kind', 'title', f.snapshot->>'title',
    'summary', left(f.snapshot->>'summary', 300), 'client', f.snapshot->>'client', 'reason', f.snapshot->>'reason',
    'why', f.snapshot->>'why', 'draft', left(f.snapshot->>'draft', 800), 'final', left(f.snapshot->>'final', 800),
    'tags', f.snapshot->'tags',
    'at', to_char(f.created_at at time zone 'America/Sao_Paulo', 'DD/MM HH24:MI'))) order by f.created_at), '[]')
   from (select * from public.personal_radar_feedback z where z.company_id = l.company_id and z.user_id = l.user_id
    and z.learned_at is null order by z.created_at limit 40) f),
  'lessons', (select coalesce(jsonb_agg(jsonb_build_object('id', x.id, 'kind', x.kind, 'text', x.text,
    'status', x.status, 'origin', x.origin) order by x.created_at), '[]')
   from public.personal_radar_lessons x where x.company_id = l.company_id and x.scope = 'person' and x.user_id = l.user_id));
end $$;

-- Os exemplos da resposta (a da migração 20270512090000): as marcadas como
-- boas valem mais que as só copiadas.
create or replace function public.personal_radar_reply_examples(p_company uuid, p_item uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_me uuid := auth.uid(); i public.personal_radar_items; begin
 if not exists (select 1 from public.personal_radar_owners where company_id = p_company and item_id = p_item and user_id = v_me)
  or not mavi_private.member(p_company) then
  raise exception 'Item não encontrado' using errcode = 'P0002';
 end if;
 select * into i from public.personal_radar_items where id = p_item;
 return jsonb_build_object(
  'product', (select pr.name from public.products pr where pr.id = i.product_id),
  'product_id', i.product_id,
  'mine', (select coalesce(jsonb_agg(x.final order by x.score desc, x.created_at desc), '[]') from (
   select * from (
   select distinct on (coalesce(f.item_id, f.id)) left(f.snapshot->>'final', 1200) as final, f.created_at,
    (case when f.action = 'liked' then 3 else 0 end)
     + (case when it.kind = i.kind then 2 else 0 end) + (case when it.client_id = i.client_id then 2 else 0 end)
     + (case when i.product_id is not null and it.product_id = i.product_id then 2 else 0 end) as score
   from public.personal_radar_feedback f
   left join public.personal_radar_items it on it.id = f.item_id
   where f.company_id = p_company and f.user_id = v_me and f.action in ('approved', 'edited', 'liked')
    and coalesce(f.snapshot->>'final', '') <> '' and f.item_id is distinct from i.id
    and f.created_at > now() - interval '180 days'
   order by coalesce(f.item_id, f.id), (f.action = 'liked') desc, f.created_at desc) d
   order by d.score desc, d.created_at desc limit 4) x),
  'team', case when i.product_id is null then '[]' else (select coalesce(jsonb_agg(x.final order by x.score desc, x.created_at desc), '[]') from (
   select left(f.snapshot->>'final', 1200) as final, f.created_at,
    (case when f.action = 'liked' then 2 else 0 end) + (case when it.kind = i.kind then 1 else 0 end) as score
   from public.personal_radar_feedback f
   join public.personal_radar_items it on it.id = f.item_id
   where f.company_id = p_company and f.user_id <> v_me and f.action in ('approved', 'edited', 'liked')
    and it.product_id = i.product_id and it.id <> i.id and coalesce(f.snapshot->>'final', '') <> ''
    and f.created_at > now() - interval '120 days'
   order by score desc, f.created_at desc limit 3) x) end);
end $$;

revoke all on function public.personal_radar_task_context(uuid, uuid), public.personal_radar_reply_like(uuid, uuid, boolean, text[]),
 public.personal_radar_task_outcome(uuid, uuid, text, uuid, text) from public, anon;
grant execute on function public.personal_radar_task_context(uuid, uuid), public.personal_radar_reply_like(uuid, uuid, boolean, text[]),
 public.personal_radar_task_outcome(uuid, uuid, text, uuid, text) to authenticated;

commit;
