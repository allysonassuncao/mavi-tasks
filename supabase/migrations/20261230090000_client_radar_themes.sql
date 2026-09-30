begin;

-- MAVI · Radar do cliente (Fase 2): temas por produto, tarefas a partir do
-- item e a fonte "Radar do cliente" nos Dashboards.
--
-- - Temas (radar_themes): o mesmo assunto em clientes diferentes do mesmo
--   produto e tópico ("Atraso na aprovação de criativos — 12 clientes").
--   Todo item novo fica pendente de tema (radar_items.theme_pending); o worker
--   do Radar junta os pendentes de cada tópico e produto e a MAVI (a
--   funcionalidade 'client_radar_themes') põe cada um num tema que já existe
--   ou cria um novo. Gestores renomeiam, juntam temas e movem itens (o item
--   movido por pessoa fica travado: a MAVI não mexe). Tema sem item some. Os
--   números de cada tema são contados na leitura, não guardados.
-- - Tarefas (radar_item_tasks): a tarefa criada a partir de um item fica
--   ligada a ele e aparece no item.
-- - Dashboards: a fonte 'radar' (itens, abertos, fechados, sérios, vencidos,
--   que voltaram, clientes, gravidade média, dias para fechar e
--   ocorrências), com agrupamento por tópico, tema, gravidade e status, e os
--   filtros de tópico, tema, gravidade e situação.

-- ------------------------------------------------------------ funcionalidades
alter table mavi_private.ai_routes drop constraint ai_routes_feature_check;
alter table mavi_private.ai_routes add constraint ai_routes_feature_check
 check ((scope_type = 'feature') = (feature is not null)
  and (feature is null or feature in ('assistant', 'meetings_history', 'meetings_ask',
   'whatsapp_task', 'social_leads_plan', 'social_leads_adjust', 'social_leads_briefing', 'social_leads_colors',
   'task_copilot', 'client_dossier', 'copilot_learning', 'notice_writer', 'notice_animation',
   'client_temperature', 'client_temperature_text', 'task_audio',
   'whatsapp_transcribe', 'task_audio_transcribe', 'image_generation', 'mavi_page', 'web_search', 'canvas_writer',
   'mavi_rerank', 'conversation_summary', 'skill_coach', 'whatsapp_history', 'client_radar', 'client_radar_check',
   'client_radar_themes')));

-- A da migração 20261229090000, com os temas do Radar.
create or replace function public.ai_set_route(p_company uuid, p_type text, p_id uuid, p_provider uuid, p_model text,
 p_feature text default null) returns void
language plpgsql security definer set search_path = '' as $$
declare v_id uuid := case when p_type in ('company', 'feature') then null else p_id end;
 v_feature text := case when p_type = 'feature' then p_feature end; v_kind text; begin
 if not mavi_private.leader(p_company) then
  raise exception 'Só administradores e gestores escolhem qual IA cada um usa.' using errcode = '42501';
 end if;
 if p_type not in ('company', 'user', 'client', 'contract', 'project', 'feature', 'skill') then
  raise exception 'Tipo inválido.' using errcode = '22023';
 end if;
 if p_type not in ('company', 'feature') and p_id is null then
  raise exception 'Escolha para quem vale a regra.' using errcode = '22023';
 end if;
 if p_type = 'feature' and coalesce(v_feature, '') not in ('assistant', 'meetings_history', 'meetings_ask',
  'whatsapp_task', 'social_leads_plan', 'social_leads_adjust', 'social_leads_briefing', 'social_leads_colors',
  'task_copilot', 'client_dossier', 'copilot_learning', 'notice_writer', 'notice_animation',
  'client_temperature', 'client_temperature_text', 'task_audio',
  'whatsapp_transcribe', 'task_audio_transcribe', 'image_generation', 'mavi_page', 'web_search', 'canvas_writer',
  'mavi_rerank', 'conversation_summary', 'skill_coach', 'whatsapp_history', 'client_radar', 'client_radar_check',
  'client_radar_themes') then
  raise exception 'Funcionalidade inválida.' using errcode = '22023';
 end if;
 if p_provider is null then
  delete from mavi_private.ai_routes where company_id = p_company and scope_type = p_type
   and scope_id is not distinct from v_id and feature is not distinct from v_feature;
  return;
 end if;
 select p.kind into v_kind from mavi_private.ai_providers p where p.id = p_provider and p.company_id = p_company
  and exists (select 1 from jsonb_array_elements(p.models) m where m->>'id' = p_model);
 if v_kind is null then
  raise exception 'Escolha um modelo cadastrado no provedor.' using errcode = '22023';
 end if;
 -- Transcrição: o endpoint de transcrição da OpenAI e um modelo que transcreve.
 if mavi_private.ai_transcribe_feature(v_feature) then
  if v_kind not in ('openai', 'groq', 'mistral', 'custom') then
   raise exception 'A transcrição usa a OpenAI, o Groq, a Mistral ou um endereço compatível.' using errcode = '22023';
  end if;
  if not mavi_private.ai_transcribe_model(p_model) then
   raise exception 'Escolha um modelo de transcrição (Whisper, gpt-4o-transcribe, Voxtral…).' using errcode = '22023';
  end if;
 -- Imagens: o endpoint de imagens da OpenAI e um modelo que gera imagens.
 elsif v_feature = 'image_generation' then
  if v_kind not in ('openai', 'google', 'xai', 'openrouter', 'custom') then
   raise exception 'As imagens usam a OpenAI, o Google, a xAI, o OpenRouter ou um endereço compatível.' using errcode = '22023';
  end if;
  if not mavi_private.ai_image_model(p_model) then
   raise exception 'Escolha um modelo de imagem (gpt-image-1, Imagen, grok-2-image…).' using errcode = '22023';
  end if;
 -- Busca na internet: a da Claude (nativa) ou a do OpenRouter (plugin web e modelos online).
 elsif v_feature = 'web_search' then
  if v_kind not in ('anthropic', 'openrouter') then
   raise exception 'A busca na internet usa a Claude (Anthropic) ou o OpenRouter.' using errcode = '22023';
  end if;
  if mavi_private.ai_non_chat_model(p_model) then
   raise exception 'Escolha um modelo de conversa para a busca.' using errcode = '22023';
  end if;
 elsif mavi_private.ai_non_chat_model(p_model) then
  raise exception 'Este modelo só transcreve, gera vetores ou imagens: escolha um modelo de conversa.' using errcode = '22023';
 end if;
 -- O termômetro e a conferência do Radar leem com o Jev pelo OpenRouter; o Jev não conversa.
 if mavi_private.ai_decision_feature(v_feature) and not (v_kind = 'openrouter' and mavi_private.jev_model(p_model)) then
  raise exception 'Esta funcionalidade usa o Jev (TypeSafe) pelo OpenRouter: escolha o modelo do Jev.'
   using errcode = '22023';
 end if;
 if not mavi_private.ai_decision_feature(v_feature) and mavi_private.jev_model(p_model) then
  raise exception 'O Jev só responde a perguntas de decisão: use-o no termômetro ou na conferência do Radar.'
   using errcode = '22023';
 end if;
 if p_type = 'user' and not exists (select 1 from public.memberships where company_id = p_company and user_id = p_id)
  or p_type = 'client' and not exists (select 1 from public.clients where company_id = p_company and id = p_id)
  or p_type = 'contract' and not exists (select 1 from public.contracts where company_id = p_company and id = p_id)
  or p_type = 'project' and not exists (select 1 from public.projects where company_id = p_company and id = p_id)
  or p_type = 'skill' and not exists (select 1 from public.ai_skills where company_id = p_company and id = p_id) then
  raise exception 'Não encontrado na empresa.' using errcode = 'P0002';
 end if;
 insert into mavi_private.ai_routes(company_id, scope_type, scope_id, feature, provider_id, model)
 values (p_company, p_type, v_id, v_feature, p_provider, p_model)
 on conflict on constraint ai_routes_scope_key do update set provider_id = excluded.provider_id,
  model = excluded.model, updated_by = auth.uid(), updated_at = now();
end $$;

-- ------------------------------------------------------------ temas
create table public.radar_themes (
 id uuid primary key default gen_random_uuid(),
 company_id uuid not null,
 topic_id uuid not null,
 -- Nulo: Geral / Agência.
 product_id uuid,
 title text not null check (length(btrim(title)) between 3 and 160),
 summary text not null default '' check (length(summary) <= 1000),
 -- Título ou resumo mudados por pessoa: a MAVI não reescreve.
 person_edited boolean not null default false,
 -- Quem criou (nulo: a MAVI).
 created_by uuid,
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 unique (company_id, id),
 foreign key (company_id, topic_id) references public.radar_topics(company_id, id) on delete cascade,
 foreign key (company_id, product_id) references public.products(company_id, id) on delete set null (product_id)
);
create index radar_themes_scope on public.radar_themes (company_id, topic_id, product_id);
alter table public.radar_themes enable row level security;
revoke all on public.radar_themes from public, anon, authenticated;

alter table public.radar_items
 add column theme_id uuid,
 -- Tema escolhido por pessoa (ou "sem tema" por pessoa): a MAVI não mexe.
 add column theme_locked boolean not null default false,
 -- Esperando a MAVI escolher o tema.
 add column theme_pending boolean not null default true,
 add column theme_attempts integer not null default 0,
 add column theme_claimed_until timestamptz,
 add foreign key (company_id, theme_id) references public.radar_themes(company_id, id) on delete set null (theme_id);
create index radar_items_theme on public.radar_items (theme_id);
create index radar_items_theme_pending on public.radar_items (company_id, topic_id) where theme_pending;

-- O tema que ficou sem item some.
create function mavi_private.radar_theme_cleanup() returns trigger
language plpgsql security definer set search_path = '' as $$ begin
 if old.theme_id is not null and (tg_op = 'DELETE' or old.theme_id is distinct from new.theme_id)
  and not exists (select 1 from public.radar_items i where i.theme_id = old.theme_id) then
  delete from public.radar_themes where id = old.theme_id;
 end if;
 return null;
end $$;
create trigger radar_items_theme_cleanup after update of theme_id or delete on public.radar_items
 for each row execute function mavi_private.radar_theme_cleanup();

-- ------------------------------------------------------------ tarefas
create table public.radar_item_tasks (
 company_id uuid not null,
 item_id uuid not null references public.radar_items(id) on delete cascade,
 task_id uuid not null references public.tasks(id) on delete cascade,
 created_by uuid,
 created_at timestamptz not null default now(),
 primary key (item_id, task_id)
);
create index radar_item_tasks_task on public.radar_item_tasks (task_id);
alter table public.radar_item_tasks enable row level security;
revoke all on public.radar_item_tasks from public, anon, authenticated;

-- Liga a tarefa criada a partir do item (líderes).
create function public.link_radar_task(p_company uuid, p_item uuid, p_task uuid) returns void
language plpgsql security definer set search_path = '' as $$ begin
 if not mavi_private.leader(p_company) then raise exception 'Sem permissão' using errcode = '42501'; end if;
 if not exists (select 1 from public.radar_items where company_id = p_company and id = p_item) then
  raise exception 'Item não encontrado.' using errcode = 'P0002';
 end if;
 if not exists (select 1 from public.tasks where company_id = p_company and id = p_task) then
  raise exception 'Tarefa não encontrada.' using errcode = 'P0002';
 end if;
 insert into public.radar_item_tasks(company_id, item_id, task_id, created_by)
 values (p_company, p_item, p_task, auth.uid()) on conflict do nothing;
end $$;

-- ------------------------------------------------------------ telas
-- O item com o tema.
create or replace function mavi_private.radar_item_json(i public.radar_items) returns jsonb
language sql stable security definer set search_path = '' as $$
 select jsonb_build_object('id', i.id, 'topic_id', i.topic_id, 'client_id', i.client_id,
  'client_name', k.name, 'client_color', k.color, 'product_id', i.product_id, 'product_name', p.name,
  'title', i.title, 'summary', i.summary, 'status', i.status, 'status_at', i.status_at,
  'assignee_id', i.assignee_id, 'assignee_name', m.name, 'severity', i.severity, 'due_date', i.due_date,
  'fields', i.fields, 'speaker_confirmed', i.speaker_confirmed, 'mentions', i.mentions,
  'first_seen_at', i.first_seen_at, 'last_seen_at', i.last_seen_at, 'reopened_at', i.reopened_at,
  'created_at', i.created_at, 'theme_id', i.theme_id, 'theme_title', th.title, 'theme_locked', i.theme_locked,
  'theme_pending', i.theme_pending)
 from public.clients k
 left join public.products p on p.company_id = i.company_id and p.id = i.product_id
 left join public.memberships m on m.company_id = i.company_id and m.user_id = i.assignee_id
 left join public.radar_themes th on th.id = i.theme_id
 where k.id = i.client_id
$$;

-- A lista do módulo: os filtros da migração 20261229090000 e o tema
-- ('none' = sem tema).
create or replace function public.radar_items(p_company uuid, p_filters jsonb) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare f jsonb := coalesce(p_filters, '{}'); v_topic uuid; v_q text; v_limit integer; v_offset integer;
 v_out jsonb; begin
 if not mavi_private.leader(p_company) then raise exception 'Sem permissão' using errcode = '42501'; end if;
 v_topic := case when f->>'topic' ~* '^[0-9a-f-]{36}$' then (f->>'topic')::uuid end;
 v_q := nullif(btrim(coalesce(f->>'q', '')), '');
 v_limit := least(greatest(coalesce((f->>'limit')::integer, 50), 1), 200);
 v_offset := greatest(coalesce((f->>'offset')::integer, 0), 0);
 with base as (
  select i.*, coalesce(mavi_private.radar_status(t.statuses, i.status)->>'kind', '') as kind
  from public.radar_items i
  join public.radar_topics t on t.id = i.topic_id
  where i.company_id = p_company
   and (v_topic is null or i.topic_id = v_topic)
   and (v_q is null or i.search @@ websearch_to_tsquery('portuguese', v_q) or i.title ilike '%' || v_q || '%'
    or exists (select 1 from public.clients k where k.id = i.client_id and k.name ilike '%' || v_q || '%'))
   and (coalesce(f->>'product', '') = '' or (f->>'product' = 'none' and i.product_id is null)
    or (f->>'product' ~* '^[0-9a-f-]{36}$' and i.product_id = (f->>'product')::uuid))
   and (coalesce(f->>'client', '') !~* '^[0-9a-f-]{36}$' or i.client_id = (f->>'client')::uuid)
   and (coalesce(f->>'team', '') !~* '^[0-9a-f-]{36}$' or exists (select 1 from public.client_teams ct
    where ct.company_id = i.company_id and ct.client_id = i.client_id and ct.team_id = (f->>'team')::uuid))
   and (jsonb_typeof(f->'statuses') is distinct from 'array' or jsonb_array_length(f->'statuses') = 0
    or i.status in (select jsonb_array_elements_text(f->'statuses')))
   and (jsonb_typeof(f->'severity') is distinct from 'number' or i.severity >= (f->>'severity')::integer)
   and (coalesce(f->>'assignee', '') = '' or (f->>'assignee' = 'none' and i.assignee_id is null)
    or (f->>'assignee' ~* '^[0-9a-f-]{36}$' and i.assignee_id = (f->>'assignee')::uuid))
   and (coalesce(f->>'theme', '') = '' or (f->>'theme' = 'none' and i.theme_id is null)
    or (f->>'theme' ~* '^[0-9a-f-]{36}$' and i.theme_id = (f->>'theme')::uuid))
   and (jsonb_typeof(f->'days') is distinct from 'number' or (f->>'days')::integer <= 0
    or i.last_seen_at > now() - make_interval(days => (f->>'days')::integer))
 ), page as (
  select b.*, count(*) over () as total from base b
  order by
   case when f->>'sort' = 'mentions' then b.mentions end desc nulls last,
   case when f->>'sort' = 'severity' then b.severity end desc nulls last,
   case when f->>'sort' = 'oldest' then b.first_seen_at end asc,
   case when b.kind = 'closed' then 1 else 0 end,
   b.last_seen_at desc, b.id
  limit v_limit offset v_offset
 )
 select jsonb_build_object('total', coalesce(max(page.total), 0),
  'items', coalesce(jsonb_agg(mavi_private.radar_item_json(i)
   order by case when f->>'sort' = 'mentions' then page.mentions end desc nulls last,
    case when f->>'sort' = 'severity' then page.severity end desc nulls last,
    case when f->>'sort' = 'oldest' then page.first_seen_at end asc,
    case when page.kind = 'closed' then 1 else 0 end,
    page.last_seen_at desc, page.id), '[]'))
 into v_out
 from page join public.radar_items i on i.id = page.id;
 return v_out;
end $$;

-- Um item com as ocorrências, o tema (e os temas para onde pode ir) e as
-- tarefas criadas a partir dele (quem não é líder vê só as que acessa).
create or replace function public.radar_item(p_company uuid, p_item uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare i public.radar_items; t public.radar_topics; v_leader boolean; begin
 select * into i from public.radar_items where company_id = p_company and id = p_item;
 if not found or not mavi_private.dossier_reader(p_company, i.client_id) then
  raise exception 'Item não encontrado.' using errcode = 'P0002';
 end if;
 select * into t from public.radar_topics where id = i.topic_id;
 v_leader := mavi_private.leader(p_company);
 return mavi_private.radar_item_json(i) || jsonb_build_object(
  'topic', mavi_private.radar_topic_json(t),
  'can_edit', v_leader,
  'client_products', coalesce((select jsonb_agg(jsonb_build_object('id', p.id, 'name', p.name) order by p.name)
    from public.products p where p.company_id = p_company and p.id in (select k.product_id from public.contracts k
     where k.company_id = p_company and k.client_id = i.client_id and not k.archived)), '[]'),
  'occurrences', coalesce((select jsonb_agg(jsonb_build_object('id', m.id, 'source_type', m.source_type,
     'source_id', m.source_id, 'group_id', m.group_id, 'message_id', m.message_id, 'at_seconds', m.at_seconds,
     'quote', m.quote, 'speaker', m.speaker, 'role', m.role, 'occurred_at', m.occurred_at, 'title', s.title)
    order by m.occurred_at desc)
   from (select * from public.radar_mentions m where m.item_id = i.id order by m.occurred_at desc limit 100) m
   left join public.radar_signals s on s.id = m.signal_id), '[]'),
  'theme_options', case when v_leader then coalesce((select jsonb_agg(jsonb_build_object('id', th.id, 'title', th.title)
     order by th.title)
    from (select * from public.radar_themes th where th.company_id = p_company and th.topic_id = i.topic_id
      and th.product_id is not distinct from i.product_id order by th.updated_at desc limit 200) th), '[]')
   else '[]'::jsonb end,
  'tasks', coalesce((select jsonb_agg(jsonb_build_object('id', tk.id, 'title', tk.title, 'status', tk.status,
     'due_date', tk.due_date, 'assignee_name', mm.name) order by rt.created_at desc)
    from public.radar_item_tasks rt
    join public.tasks tk on tk.id = rt.task_id and not tk.archived
    left join public.memberships mm on mm.company_id = tk.company_id and mm.user_id = tk.assignee_id
    where rt.item_id = i.id and (v_leader or mavi_private.task_access(p_company, tk.id))), '[]'));
end $$;

-- A da migração 20261229090000; mudar o produto leva o item para a MAVI
-- escolher o tema de novo (os temas são por produto).
create or replace function public.update_radar_item(p_company uuid, p_item uuid, p_patch jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare i public.radar_items; t public.radar_topics; v jsonb := coalesce(p_patch, '{}'); v_prod uuid; begin
 if not mavi_private.leader(p_company) then raise exception 'Sem permissão' using errcode = '42501'; end if;
 select * into i from public.radar_items where company_id = p_company and id = p_item for update;
 if not found then raise exception 'Item não encontrado.' using errcode = 'P0002'; end if;
 select * into t from public.radar_topics where id = i.topic_id;
 if v ? 'status' and mavi_private.radar_status(t.statuses, v->>'status') is null then
  raise exception 'Status inválido.' using errcode = '22023';
 end if;
 if v ? 'assignee_id' and v->>'assignee_id' is not null and not exists (select 1 from public.memberships m
  where m.company_id = p_company and m.user_id::text = v->>'assignee_id' and m.active) then
  raise exception 'Responsável não encontrado.' using errcode = 'P0002';
 end if;
 if v ? 'product_id' and v->>'product_id' is not null then
  v_prod := (v->>'product_id')::uuid;
  if not exists (select 1 from public.contracts k where k.company_id = p_company and k.client_id = i.client_id
   and k.product_id = v_prod and not k.archived) then
   raise exception 'O cliente não contrata este produto.' using errcode = '22023';
  end if;
 end if;
 if v ? 'title' and length(btrim(coalesce(v->>'title', ''))) not between 3 and 200 then
  raise exception 'O título tem de 3 a 200 caracteres.' using errcode = '22023';
 end if;
 if v ? 'severity' and v->>'severity' is not null and (v->>'severity')::integer not between 0 and 3 then
  raise exception 'Gravidade inválida.' using errcode = '22023';
 end if;
 update public.radar_items set
  status = case when v ? 'status' then v->>'status' else status end,
  status_at = case when v ? 'status' and v->>'status' <> status then now() else status_at end,
  status_by = case when v ? 'status' and v->>'status' <> status then auth.uid() else status_by end,
  assignee_id = case when v ? 'assignee_id' then (v->>'assignee_id')::uuid else assignee_id end,
  severity = case when v ? 'severity' then (v->>'severity')::smallint else severity end,
  severity_person = severity_person or v ? 'severity',
  due_date = case when v ? 'due_date' then (v->>'due_date')::date else due_date end,
  product_id = case when v ? 'product_id' then v_prod else product_id end,
  theme_id = case when v ? 'product_id' and v_prod is distinct from product_id then null else theme_id end,
  theme_locked = case when v ? 'product_id' and v_prod is distinct from product_id then false else theme_locked end,
  theme_pending = case when v ? 'product_id' and v_prod is distinct from product_id then true else theme_pending end,
  theme_attempts = case when v ? 'product_id' and v_prod is distinct from product_id then 0 else theme_attempts end,
  title = case when v ? 'title' then btrim(v->>'title') else title end,
  summary = case when v ? 'summary' then left(btrim(coalesce(v->>'summary', '')), 1500) else summary end,
  person_edited = person_edited or v ?| array['title', 'summary', 'product_id'],
  fields = case when jsonb_typeof(v->'fields') = 'object' then (select coalesce(jsonb_object_agg(f->>'key',
     left(v->'fields'->>(f->>'key'), 300)), '{}') from jsonb_array_elements(t.fields) f
     where nullif(btrim(coalesce(v->'fields'->>(f->>'key'), '')), '') is not null) else fields end,
  updated_at = now()
 where id = i.id;
 return public.radar_item(p_company, p_item);
end $$;

-- Os temas de um tópico, com os números contados nos itens: {topic,
-- product ('none' = Geral), q, days (itens vistos nos últimos), open_only,
-- sort (clients, items, mentions, recent), limit, offset}.
create function public.radar_themes(p_company uuid, p_filters jsonb) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare f jsonb := coalesce(p_filters, '{}'); v_topic uuid; v_q text; v_open boolean; v_days integer;
 v_limit integer; v_offset integer; v_out jsonb; begin
 if not mavi_private.leader(p_company) then raise exception 'Sem permissão' using errcode = '42501'; end if;
 v_topic := case when f->>'topic' ~* '^[0-9a-f-]{36}$' then (f->>'topic')::uuid end;
 if v_topic is null then raise exception 'Escolha o tópico.' using errcode = '22023'; end if;
 v_q := nullif(btrim(coalesce(f->>'q', '')), '');
 v_open := coalesce((f->>'open_only')::boolean, true);
 v_days := case when jsonb_typeof(f->'days') = 'number' then (f->>'days')::integer end;
 v_limit := least(greatest(coalesce((f->>'limit')::integer, 50), 1), 200);
 v_offset := greatest(coalesce((f->>'offset')::integer, 0), 0);
 with agg as (
  select th.id, count(*)::integer as items,
   count(*) filter (where coalesce(mavi_private.radar_status(t.statuses, i.status)->>'kind', '') <> 'closed')::integer
    as open_items,
   count(distinct i.client_id)::integer as clients, sum(i.mentions)::integer as mentions,
   max(i.last_seen_at) as last_seen_at, max(i.severity) as max_severity,
   (array_agg(distinct k.name))[1:6] as client_names
  from public.radar_themes th
  join public.radar_topics t on t.id = th.topic_id
  join public.radar_items i on i.theme_id = th.id
  join public.clients k on k.id = i.client_id and not k.archived
  where th.company_id = p_company and th.topic_id = v_topic
   and (coalesce(f->>'product', '') = '' or (f->>'product' = 'none' and th.product_id is null)
    or (f->>'product' ~* '^[0-9a-f-]{36}$' and th.product_id = (f->>'product')::uuid))
   and (v_q is null or th.title ilike '%' || v_q || '%' or th.summary ilike '%' || v_q || '%')
   and (v_days is null or v_days <= 0 or i.last_seen_at > now() - make_interval(days => v_days))
  group by th.id
 ), page as (
  select a.*, count(*) over () as total from agg a
  where not v_open or a.open_items > 0
  order by
   case when coalesce(f->>'sort', 'clients') = 'clients' then a.clients end desc,
   case when coalesce(f->>'sort', 'clients') = 'clients' then a.items end desc,
   case when f->>'sort' = 'items' then a.items end desc,
   case when f->>'sort' = 'mentions' then a.mentions end desc,
   a.last_seen_at desc, a.id
  limit v_limit offset v_offset
 )
 select jsonb_build_object('total', coalesce(max(p.total), 0),
  'themes', coalesce(jsonb_agg(jsonb_build_object('id', th.id, 'topic_id', th.topic_id, 'product_id', th.product_id,
    'product_name', pr.name, 'title', th.title, 'summary', th.summary, 'person_edited', th.person_edited,
    'items', p.items, 'open_items', p.open_items, 'clients', p.clients, 'mentions', p.mentions,
    'last_seen_at', p.last_seen_at, 'max_severity', p.max_severity, 'client_names', to_jsonb(p.client_names))
   order by case when coalesce(f->>'sort', 'clients') = 'clients' then p.clients end desc,
    case when coalesce(f->>'sort', 'clients') = 'clients' then p.items end desc,
    case when f->>'sort' = 'items' then p.items end desc,
    case when f->>'sort' = 'mentions' then p.mentions end desc,
    p.last_seen_at desc, p.id), '[]'),
  'pending', (select count(*) from public.radar_items i where i.company_id = p_company and i.topic_id = v_topic
    and i.theme_pending),
  'without', (select count(*) from public.radar_items i where i.company_id = p_company and i.topic_id = v_topic
    and i.theme_id is null and not i.theme_pending))
 into v_out
 from page p
 join public.radar_themes th on th.id = p.id
 left join public.products pr on pr.company_id = th.company_id and pr.id = th.product_id;
 return v_out;
end $$;

-- Um tema com os itens e os outros temas do mesmo tópico e produto (para
-- juntar e mover).
create function public.radar_theme(p_company uuid, p_theme uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare th public.radar_themes; begin
 if not mavi_private.leader(p_company) then raise exception 'Sem permissão' using errcode = '42501'; end if;
 select * into th from public.radar_themes where company_id = p_company and id = p_theme;
 if not found then raise exception 'Tema não encontrado.' using errcode = 'P0002'; end if;
 return jsonb_build_object('id', th.id, 'topic_id', th.topic_id, 'product_id', th.product_id,
  'product_name', (select name from public.products where id = th.product_id),
  'title', th.title, 'summary', th.summary, 'person_edited', th.person_edited, 'created_at', th.created_at,
  'topic', (select mavi_private.radar_topic_json(t) from public.radar_topics t where t.id = th.topic_id),
  'items', coalesce((select jsonb_agg(mavi_private.radar_item_json(i) order by i.last_seen_at desc)
    from public.radar_items i where i.theme_id = th.id), '[]'),
  'others', coalesce((select jsonb_agg(jsonb_build_object('id', o.id, 'title', o.title) order by o.title)
    from (select * from public.radar_themes o where o.company_id = p_company and o.topic_id = th.topic_id
      and o.product_id is not distinct from th.product_id and o.id <> th.id order by o.updated_at desc limit 200) o), '[]'));
end $$;

create function public.update_radar_theme(p_company uuid, p_theme uuid, p_title text, p_summary text) returns jsonb
language plpgsql security definer set search_path = '' as $$ begin
 if not mavi_private.leader(p_company) then raise exception 'Sem permissão' using errcode = '42501'; end if;
 if length(btrim(coalesce(p_title, ''))) not between 3 and 160 then
  raise exception 'O nome do tema tem de 3 a 160 caracteres.' using errcode = '22023';
 end if;
 update public.radar_themes set title = btrim(p_title), summary = left(btrim(coalesce(p_summary, '')), 1000),
  person_edited = true, updated_at = now()
 where company_id = p_company and id = p_theme;
 if not found then raise exception 'Tema não encontrado.' using errcode = 'P0002'; end if;
 return public.radar_theme(p_company, p_theme);
end $$;

-- Junta temas do mesmo tópico e produto no primeiro (os outros somem).
create function public.merge_radar_themes(p_company uuid, p_target uuid, p_sources uuid[]) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare th public.radar_themes; begin
 if not mavi_private.leader(p_company) then raise exception 'Sem permissão' using errcode = '42501'; end if;
 select * into th from public.radar_themes where company_id = p_company and id = p_target;
 if not found then raise exception 'Tema não encontrado.' using errcode = 'P0002'; end if;
 if exists (select 1 from unnest(coalesce(p_sources, '{}')) s where s <> p_target and not exists (
   select 1 from public.radar_themes o where o.id = s and o.company_id = p_company and o.topic_id = th.topic_id
    and o.product_id is not distinct from th.product_id)) then
  raise exception 'Só dá para juntar temas do mesmo tópico e produto.' using errcode = '22023';
 end if;
 update public.radar_items set theme_id = p_target, updated_at = now()
 where company_id = p_company and theme_id = any(p_sources) and theme_id <> p_target;
 delete from public.radar_themes where company_id = p_company and id = any(p_sources) and id <> p_target;
 update public.radar_themes set updated_at = now() where id = p_target;
 return public.radar_theme(p_company, p_target);
end $$;

-- Move um item: para um tema (p_theme), para um tema novo (p_title), para
-- "sem tema" (os dois nulos) ou de volta para a MAVI escolher (p_auto).
create function public.set_radar_item_theme(p_company uuid, p_item uuid, p_theme uuid, p_title text default null,
 p_auto boolean default false) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare i public.radar_items; v_theme uuid := p_theme; begin
 if not mavi_private.leader(p_company) then raise exception 'Sem permissão' using errcode = '42501'; end if;
 select * into i from public.radar_items where company_id = p_company and id = p_item for update;
 if not found then raise exception 'Item não encontrado.' using errcode = 'P0002'; end if;
 if coalesce(p_auto, false) then
  update public.radar_items set theme_id = null, theme_locked = false, theme_pending = true, theme_attempts = 0,
   theme_claimed_until = null, updated_at = now() where id = i.id;
  return public.radar_item(p_company, p_item);
 end if;
 if nullif(btrim(coalesce(p_title, '')), '') is not null then
  if length(btrim(p_title)) not between 3 and 160 then
   raise exception 'O nome do tema tem de 3 a 160 caracteres.' using errcode = '22023';
  end if;
  insert into public.radar_themes(company_id, topic_id, product_id, title, person_edited, created_by)
  values (p_company, i.topic_id, i.product_id, btrim(p_title), true, auth.uid()) returning id into v_theme;
 elsif v_theme is not null and not exists (select 1 from public.radar_themes th where th.id = v_theme
   and th.company_id = p_company and th.topic_id = i.topic_id and th.product_id is not distinct from i.product_id) then
  raise exception 'O tema precisa ser do mesmo tópico e produto do item.' using errcode = '22023';
 end if;
 update public.radar_items set theme_id = v_theme, theme_locked = true, theme_pending = false,
  theme_claimed_until = null, updated_at = now()
 where id = i.id;
 if v_theme is not null then update public.radar_themes set updated_at = now() where id = v_theme; end if;
 return public.radar_item(p_company, p_item);
end $$;

-- Os temas para os filtros dos Dashboards.
create function public.radar_theme_options(p_company uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$ begin
 if not mavi_private.leader(p_company) then raise exception 'Sem permissão' using errcode = '42501'; end if;
 return jsonb_build_object(
  'topics', coalesce((select jsonb_agg(jsonb_build_object('id', t.id, 'name', t.name) order by t.position, t.name)
    from public.radar_topics t where t.company_id = p_company), '[]'),
  'themes', coalesce((select jsonb_agg(jsonb_build_object('id', th.id, 'title', th.title, 'topic', t.name,
     'product', p.name) order by th.title)
    from (select * from public.radar_themes th where th.company_id = p_company order by th.updated_at desc limit 500) th
    join public.radar_topics t on t.id = th.topic_id
    left join public.products p on p.id = th.product_id), '[]'));
end $$;

-- ------------------------------------------------------------ worker dos temas
-- Reserva os itens sem tema de alguns grupos (tópico + produto), com os temas
-- que o grupo já tem. Cada item tenta até 3 vezes.
create function public.ai_radar_theme_claim(p_secret text, p_limit integer default 3) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare grp record; v_items jsonb; v_out jsonb := '[]'; begin
 if not mavi_private.ai_secret_ok(p_secret) then raise exception 'Sem permissão' using errcode = '42501'; end if;
 for grp in
  select i.company_id, i.topic_id, i.product_id from public.radar_items i
  join public.clients k on k.id = i.client_id and not k.archived
  where i.theme_pending and not i.theme_locked and i.theme_attempts < 3
   and (i.theme_claimed_until is null or i.theme_claimed_until < now())
  group by 1, 2, 3 order by min(i.created_at)
  limit least(greatest(coalesce(p_limit, 3), 1), 10)
 loop
  with picked as (
   select i.id from public.radar_items i
   where i.company_id = grp.company_id and i.topic_id = grp.topic_id and i.product_id is not distinct from grp.product_id
    and i.theme_pending and not i.theme_locked and i.theme_attempts < 3
    and (i.theme_claimed_until is null or i.theme_claimed_until < now())
   order by i.created_at limit 40
   for update skip locked
  ), claimed as (
   update public.radar_items i set theme_claimed_until = now() + interval '10 minutes',
    theme_attempts = i.theme_attempts + 1
   from picked where i.id = picked.id
   returning i.id, i.client_id, i.title, i.summary, i.created_at
  )
  select coalesce(jsonb_agg(jsonb_build_object('id', c.id, 'title', c.title, 'summary', left(c.summary, 300),
    'client', k.name) order by c.created_at), '[]') into v_items
  from claimed c join public.clients k on k.id = c.client_id;
  continue when jsonb_array_length(v_items) = 0;
  v_out := v_out || jsonb_build_object('company_id', grp.company_id, 'topic_id', grp.topic_id,
   'product_id', grp.product_id,
   'topic', (select jsonb_build_object('name', t.name, 'description', t.description) from public.radar_topics t
     where t.id = grp.topic_id),
   'product_name', (select name from public.products where id = grp.product_id),
   'items', v_items,
   'themes', coalesce((select jsonb_agg(jsonb_build_object('id', q.id, 'title', q.title, 'summary', left(q.summary, 240),
      'items', q.n, 'clients', q.c) order by q.n desc)
     from (select th.id, th.title, th.summary, count(i.id) as n, count(distinct i.client_id) as c
       from public.radar_themes th left join public.radar_items i on i.theme_id = th.id
       where th.company_id = grp.company_id and th.topic_id = grp.topic_id
        and th.product_id is not distinct from grp.product_id
       group by th.id order by count(i.id) desc, max(th.updated_at) desc limit 150) q), '[]'));
 end loop;
 return v_out;
end $$;

-- O que a MAVI decidiu num grupo: {company_id, topic_id, product_id, claimed,
-- new: [{ref, title, summary}], assign: [{item_id, theme_id | ref}], update:
-- [{theme_id, summary}], usage}. Item que ela não pôs em tema volta para a
-- fila (até 3 tentativas).
create function public.ai_radar_theme_store(p_secret text, p_result jsonb) returns integer
language plpgsql security definer set search_path = '' as $$
declare r jsonb := coalesce(p_result, '{}'); c uuid; v_topic uuid; v_prod uuid; x jsonb; v_map jsonb := '{}';
 v_theme uuid; v_new uuid[] := '{}'; v_n integer := 0; u jsonb; v_client uuid; begin
 if not mavi_private.ai_secret_ok(p_secret) then raise exception 'Sem permissão' using errcode = '42501'; end if;
 if coalesce(r->>'company_id', '') !~* '^[0-9a-f-]{36}$' or coalesce(r->>'topic_id', '') !~* '^[0-9a-f-]{36}$' then
  return 0;
 end if;
 c := (r->>'company_id')::uuid;
 v_topic := (r->>'topic_id')::uuid;
 v_prod := case when r->>'product_id' ~* '^[0-9a-f-]{36}$' then (r->>'product_id')::uuid end;
 if not exists (select 1 from public.radar_topics where company_id = c and id = v_topic) then return 0; end if;
 -- Temas novos (só os que recebem algum item).
 for x in select * from jsonb_array_elements(case when jsonb_typeof(r->'new') = 'array' then r->'new' else '[]' end) loop
  continue when coalesce(x->>'ref', '') = '' or length(btrim(coalesce(x->>'title', ''))) < 3;
  continue when not exists (select 1 from jsonb_array_elements(case when jsonb_typeof(r->'assign') = 'array'
    then r->'assign' else '[]' end) a where a->>'ref' = x->>'ref');
  insert into public.radar_themes(company_id, topic_id, product_id, title, summary)
  values (c, v_topic, v_prod, left(btrim(x->>'title'), 160), left(btrim(coalesce(x->>'summary', '')), 1000))
  returning id into v_theme;
  v_map := v_map || jsonb_build_object(x->>'ref', v_theme);
  v_new := v_new || v_theme;
 end loop;
 for x in select * from jsonb_array_elements(case when jsonb_typeof(r->'assign') = 'array' then r->'assign' else '[]' end) loop
  continue when coalesce(x->>'item_id', '') !~* '^[0-9a-f-]{36}$';
  v_theme := case when x->>'theme_id' ~* '^[0-9a-f-]{36}$' then (x->>'theme_id')::uuid
   when x->>'ref' is not null and v_map ? (x->>'ref') then (v_map->>(x->>'ref'))::uuid end;
  continue when v_theme is null or not exists (select 1 from public.radar_themes th where th.id = v_theme
   and th.company_id = c and th.topic_id = v_topic and th.product_id is not distinct from v_prod);
  update public.radar_items set theme_id = v_theme, theme_pending = false, theme_claimed_until = null
  where id = (x->>'item_id')::uuid and company_id = c and topic_id = v_topic and product_id is not distinct from v_prod
   and theme_pending and not theme_locked;
  if found then
   v_n := v_n + 1;
   update public.radar_themes set updated_at = now() where id = v_theme;
  end if;
 end loop;
 for x in select * from jsonb_array_elements(case when jsonb_typeof(r->'update') = 'array' then r->'update' else '[]' end) loop
  continue when coalesce(x->>'theme_id', '') !~* '^[0-9a-f-]{36}$' or nullif(btrim(coalesce(x->>'summary', '')), '') is null;
  update public.radar_themes set summary = left(btrim(x->>'summary'), 1000), updated_at = now()
  where id = (x->>'theme_id')::uuid and company_id = c and topic_id = v_topic and not person_edited;
 end loop;
 -- Tema novo que ficou sem item (o item mudou no meio) some.
 delete from public.radar_themes th where th.id = any(v_new)
  and not exists (select 1 from public.radar_items i where i.theme_id = th.id);
 -- O que ela não resolveu volta para a fila.
 update public.radar_items set theme_claimed_until = null
 where company_id = c and theme_pending and id in (select v::uuid from jsonb_array_elements_text(
  case when jsonb_typeof(r->'claimed') = 'array' then r->'claimed' else '[]' end) v where v ~* '^[0-9a-f-]{36}$');
 u := r->'usage';
 if jsonb_typeof(u) = 'object' then
  insert into public.ai_usage(company_id, user_id, module, kind, client_id, model, input_tokens, output_tokens,
   cache_read_tokens, cache_write_tokens, cost_usd, provider_id, provider_name)
  values (c, null, 'radar', 'radar_themes', null, left(coalesce(u->>'model', ''), 80),
   greatest(coalesce((u->>'input')::integer, 0), 0), greatest(coalesce((u->>'output')::integer, 0), 0),
   greatest(coalesce((u->>'cache_read')::integer, 0), 0), greatest(coalesce((u->>'cache_write')::integer, 0), 0),
   least(greatest(coalesce((u->>'cost')::numeric, 0), 0), 20),
   case when u->>'provider_id' ~* '^[0-9a-f-]{36}$' then (u->>'provider_id')::uuid end,
   left(coalesce(u->>'provider', ''), 120));
 end if;
 return v_n;
end $$;

-- pg_cron: acorda o worker quando há leitura para fazer ou item sem tema.
create or replace function mavi_private.ai_radar_kick() returns void
language plpgsql security definer set search_path = '' as $$
declare cfg mavi_private.ai_config; begin
 select * into cfg from mavi_private.ai_config where id;
 if not found then return; end if;
 if not exists (select 1 from public.radar_signals x where x.status = 'pending' and mavi_private.radar_due(x))
  and not exists (select 1 from public.radar_items i where i.theme_pending and not i.theme_locked
   and i.theme_attempts < 3 and (i.theme_claimed_until is null or i.theme_claimed_until < now())) then
  return;
 end if;
 perform net.http_post(url := cfg.url, body := '{"action":"ai-radar"}'::jsonb,
  headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || cfg.secret),
  -- O worker trabalha até 4 min (uma leitura leva até ~90 s).
  timeout_milliseconds := 290000);
end $$;

-- ------------------------------------------------------------ Dashboards
-- A da migração 20261201120000, com a fonte 'radar'.
create or replace function mavi_private.dashboard_sql(c uuid, q jsonb, p_group text, p_interval text,
 p_from date, p_to date, p_filters jsonb, p_limit integer) returns text
language plpgsql stable security definer set search_path = '' as $$
declare
  src text := q->>'source';
  metric text := q->>'metric';
  tz text;
  base text;
  conds text[];
  m text;
  additive boolean := true;
  datef text;
  col text;
  is_ts boolean := true;
  person text;
  late text;
  f jsonb;
  fld text;
  op text;
  vals text[];
  colf text;
  typed text;
  key text;
  label text;
  bucket text;
  other text := '';
  lim integer := least(greatest(coalesce(p_limit, 1000), 1), 1000);
  filters jsonb;
  nodate boolean := false;
  -- Tasks, status history and validations all read the task (t.).
  on_task boolean := src in ('tasks', 'status_history', 'reviews');
  executor constant text := 'coalesce(t.executor_id, t.assignee_id)';
  validator constant text := 'coalesce(p.ended_by, p.user_id)';
  dur constant text := 'extract(epoch from (coalesce(p.ended_at, now()) - p.started_at))';
  delivered_day text;
  rework constant text := 'exists (select 1 from public.task_status_periods x where x.task_id = t.id'
   ' and (x.status in (''rejected'', ''correction'') or x.from_status = ''done''))';
  -- Temperatura (migration 20261110090000): the bands that warn, by index.
  bands jsonb;
  alert_bands integer[];
  ind text;
  -- Radar (migration 20261230090000): the kind of the item's status.
  rkind text;
begin
  select timezone into tz from public.companies where id = c;
  if tz is null then raise exception 'Empresa não encontrada'; end if;
  late := format('((t.status <> ''done'' and t.due_date < (now() at time zone %1$L)::date)'
   ' or (t.delivered_at is not null and (t.delivered_at at time zone %1$L)::date > t.due_date))', tz);
  delivered_day := format('(t.delivered_at at time zone %L)::date', tz);

  if src = 'tasks' then
    base := 'public.tasks t';
    conds := array[format('t.company_id = %L', c), 'not t.archived'];
    person := 't.assignee_id';
    datef := coalesce(q->>'dateField', 'created_at');
    if datef = 'created_at' then col := 't.created_at';
    elsif datef = 'delivered_at' then col := 't.delivered_at';
    elsif datef = 'due_date' then col := 't.due_date'; is_ts := false;
    else raise exception 'Campo de data inválido: %', datef using errcode = '22023';
    end if;
    m := case metric
      when 'count' then 'count(*)'
      when 'estimated_hours' then 'coalesce(sum(t.estimated_minutes), 0) / 60.0'
      when 'late' then format('count(*) filter (where %s)', late)
      when 'lead_time_days' then 'avg(extract(epoch from (t.delivered_at - t.created_at)) / 86400.0)'
      -- Migration 20261104090000: delivery quality.
      when 'on_time_rate' then format('100.0 * count(*) filter (where %s <= t.due_date) / nullif(count(*), 0)', delivered_day)
      when 'on_time_original_rate' then
        format('100.0 * count(*) filter (where %s <= t.original_due_date) / nullif(count(*), 0)', delivered_day)
      when 'delay_days' then format('avg((%1$s - t.due_date)::numeric) filter (where %1$s > t.due_date)', delivered_day)
      when 'rescheduled' then 'count(*) filter (where t.due_date <> t.original_due_date)'
      when 'first_pass_rate' then format('100.0 * count(*) filter (where not %s) / nullif(count(*), 0)', rework)
      when 'rework_per_task' then 'avg((select count(*) from public.task_status_periods x where x.task_id = t.id'
       ' and x.status in (''rejected'', ''correction'') and x.from_status is distinct from x.status))'
      -- Migration 20261201120000: how the suggested due dates did. Among the
      -- delivered tasks that had the suggestion, the share delivered by it
      -- and the MAVI's average miss (days, either way).
      when 'smart_hit_rate' then format('100.0 * count(*) filter (where %s <= t.due_smart_date)'
       ' / nullif(count(*) filter (where t.due_smart_date is not null), 0)', delivered_day)
      when 'rule_hit_rate' then format('100.0 * count(*) filter (where %s <= t.due_rule_date)'
       ' / nullif(count(*) filter (where t.due_rule_date is not null), 0)', delivered_day)
      when 'smart_error_days' then format('avg(abs(%s - t.due_smart_date)::numeric)'
       ' filter (where t.due_smart_date is not null)', delivered_day)
      -- A date set before the rule's minimum (with a reason) and one set
      -- earlier than the MAVI suggested.
      when 'tight_due' then 'count(*) filter (where t.due_tight_reason is not null)'
      when 'shorter_than_smart' then 'count(*) filter (where t.original_due_date < t.due_smart_date)'
    end;
    if metric in ('lead_time_days', 'on_time_rate', 'on_time_original_rate', 'delay_days', 'first_pass_rate',
     'rework_per_task', 'smart_hit_rate', 'rule_hit_rate', 'smart_error_days') then
      additive := false;
      conds := conds || 't.delivered_at is not null'::text;
    end if;
  elsif src = 'hours' then
    base := 'public.time_entries e';
    conds := array[format('e.company_id = %L', c)];
    person := 'e.user_id';
    col := 'e.started_at';
    m := case metric
      when 'hours' then 'coalesce(sum(extract(epoch from (coalesce(e.ended_at, now()) - e.started_at))), 0) / 3600.0'
      when 'entries' then 'count(*)'
      when 'people' then 'count(distinct e.user_id)'
      when 'tasks' then 'count(distinct e.task_id)'
    end;
    if metric in ('people', 'tasks') then additive := false; end if;
  elsif src = 'status_history' then
    -- Migration 20261104090000: each period a task spent in a status with a
    -- responsible. "Vezes" counts entries into the status (a change of hands
    -- inside it is not a new entry); time runs until now while open.
    base := 'public.task_status_periods p join public.tasks t on t.id = p.task_id';
    conds := array[format('p.company_id = %L', c), 'not t.archived'];
    person := 'p.user_id';
    datef := coalesce(q->>'dateField', 'started_at');
    if datef = 'started_at' then col := 'p.started_at';
    elsif datef = 'ended_at' then col := 'p.ended_at';
    else raise exception 'Campo de data inválido: %', datef using errcode = '22023';
    end if;
    m := case metric
      when 'entries' then 'count(*) filter (where p.from_status is distinct from p.status)'
      when 'hours' then format('coalesce(sum(%s), 0) / 3600.0', dur)
      when 'avg_hours' then format('avg(%s) / 3600.0', dur)
      when 'tasks' then 'count(distinct p.task_id)'
      when 'reopens' then 'count(*) filter (where p.from_status = ''done'')'
    end;
    if metric in ('avg_hours', 'tasks') then additive := false; end if;
  elsif src = 'reviews' then
    -- Migration 20261104090000: the validation periods. Approved = left
    -- validation delivered; reproved = sent back to Alteração or Correção.
    -- The person is whoever sent it to validation; the validator, whoever
    -- decided (or held it, while undecided).
    base := 'public.task_status_periods p join public.tasks t on t.id = p.task_id';
    conds := array[format('p.company_id = %L', c), 'not t.archived', 'p.status = ''review'''];
    person := 'p.previous_user_id';
    -- Each metric has its own date: the sending or the decision.
    col := case when metric = 'sent' then 'p.started_at' else 'p.ended_at' end;
    m := case metric
      when 'sent' then 'count(*) filter (where p.from_status is distinct from ''review'')'
      when 'approved' then 'count(*) filter (where p.to_status = ''done'')'
      when 'reproved' then 'count(*) filter (where p.to_status in (''rejected'', ''correction''))'
      when 'approval_rate' then '100.0 * count(*) filter (where p.to_status = ''done'')'
       ' / nullif(count(*) filter (where p.to_status in (''done'', ''rejected'', ''correction'')), 0)'
      when 'reproval_rate' then '100.0 * count(*) filter (where p.to_status in (''rejected'', ''correction''))'
       ' / nullif(count(*) filter (where p.to_status in (''done'', ''rejected'', ''correction'')), 0)'
      when 'avg_hours' then format('avg(%s) / 3600.0', dur)
    end;
    if metric in ('approval_rate', 'reproval_rate', 'avg_hours') then additive := false; end if;
  elsif src = 'notices' then
    -- Mural de avisos (migration 20261107090000): one row per person reached
    -- by a notice (its current round), dated by the delivery. Seen, confirmed
    -- ("Li e entendi", only notices that ask for it) and pending (not seen,
    -- or not confirmed when asked).
    base := 'public.notice_receipts r join public.notices n on n.id = r.notice_id';
    conds := array[format('r.company_id = %L', c)];
    person := 'r.user_id';
    col := 'r.delivered_at';
    m := case metric
      when 'notices' then 'count(distinct r.notice_id)'
      when 'delivered' then 'count(*)'
      when 'seen' then 'count(r.seen_at)'
      when 'pending' then 'count(*) filter (where r.seen_at is null or (n.require_ack and r.acked_at is null))'
      when 'seen_rate' then '100.0 * count(r.seen_at) / nullif(count(*), 0)'
      when 'acked' then 'count(r.acked_at)'
      when 'ack_rate' then '100.0 * count(r.acked_at) / nullif(count(*) filter (where n.require_ack), 0)'
      when 'hours_to_see' then 'avg(extract(epoch from (r.seen_at - r.delivered_at))) / 3600.0'
      when 'hours_to_ack' then 'avg(extract(epoch from (r.acked_at - r.delivered_at))) / 3600.0'
    end;
    if metric in ('notices', 'seen_rate', 'ack_rate', 'hours_to_see', 'hours_to_ack') then additive := false; end if;
  elsif src = 'temperature' then
    -- Termômetro (migration 20261110090000): one row per client and day with
    -- the day's temperature (0–100), each indicator and the alert signals.
    -- Averages over the client-days of the period; counts are distinct
    -- clients.
    select s.bands into bands from public.temperature_settings s where s.company_id = c;
    select coalesce(array_agg((x.n - 1)::integer), '{}') into alert_bands
    from jsonb_array_elements(coalesce(bands, '[]')) with ordinality x(b, n) where coalesce((x.b->>'alert')::boolean, false);
    base := 'public.temperature_days d join public.clients cl on cl.id = d.client_id';
    conds := array[format('d.company_id = %L', c), 'not cl.archived'];
    col := 'd.day';
    is_ts := false;
    ind := q->>'indicator';
    if metric = 'indicator' and coalesce(ind, '') !~ '^[a-z][a-z0-9_]{1,39}$' then
      raise exception 'Escolha o indicador do termômetro.' using errcode = '22023';
    end if;
    m := case metric
      when 'score' then 'avg(d.score)'
      when 'indicator' then format('avg((d.indicators->>%L)::numeric)', ind)
      when 'clients' then 'count(distinct d.client_id) filter (where d.score is not null)'
      when 'alert_clients' then format('count(distinct d.client_id) filter (where d.band = any(%L::integer[]))', alert_bands)
      when 'alert_rate' then format('100.0 * count(distinct d.client_id) filter (where d.band = any(%L::integer[]))'
       ' / nullif(count(distinct d.client_id) filter (where d.score is not null), 0)', alert_bands)
      when 'flag_clients' then 'count(distinct d.client_id) filter (where cardinality(d.flags) > 0)'
    end;
    additive := false;
  elsif src = 'social_leads' then
    -- Social Leads (migration 20261020120000): decisions from the posts'
    -- history, the time until a plan's 8 posts are approved, and the
    -- clients by stage (today's picture: no period).
    if metric in ('approvals', 'rejections', 'approval_rate', 'rejection_rate', 'adjust_per_post') then
      base := 'public.social_leads_post_events e join public.contracts k on k.id = e.contract_id';
      conds := array[format('e.company_id = %L', c), 'e.kind in (''approved'', ''rejected'')'];
      person := 'e.actor_id';
      col := 'e.created_at';
      m := case metric
        when 'approvals' then 'count(*) filter (where e.kind = ''approved'')'
        when 'rejections' then 'count(*) filter (where e.kind = ''rejected'')'
        when 'approval_rate' then '100.0 * count(*) filter (where e.kind = ''approved'') / nullif(count(*), 0)'
        when 'rejection_rate' then '100.0 * count(*) filter (where e.kind = ''rejected'') / nullif(count(*), 0)'
        when 'adjust_per_post' then
          'count(*) filter (where e.kind = ''rejected'')::numeric / nullif(count(distinct (e.plan_id, e.number)), 0)'
      end;
      if metric not in ('approvals', 'rejections') then additive := false; end if;
    elsif metric = 'approval_days' then
      base := '(select p.id, p.company_id, p.contract_id, p.created_at, p.created_by,'
       ' (select max(x.decided_at) from public.social_leads_posts x where x.plan_id = p.id) as approved_at'
       ' from public.social_leads_plans p where (select count(*) from public.social_leads_posts x'
       ' where x.plan_id = p.id and x.decision = ''approved'') = (select count(*) from public.social_leads_posts x'
       ' where x.plan_id = p.id)) a join public.contracts k on k.id = a.contract_id';
      conds := array[format('a.company_id = %L', c)];
      person := 'a.created_by';
      col := 'a.approved_at';
      m := 'avg(extract(epoch from (a.approved_at - a.created_at)) / 86400.0)';
      additive := false;
    elsif metric = 'clients' then
      base := '(select k2.id, k2.company_id, mavi_private.social_leads_stage(k2.company_id, k2.id) as stage,'
       ' (select b.responsible_id from public.social_leads_briefings b where b.company_id = k2.company_id'
       ' and b.contract_id = k2.id) as responsible'
       ' from public.contracts k2 join public.social_leads_settings s on s.company_id = k2.company_id'
       ' and s.product_id = k2.product_id join public.clients cl on cl.id = k2.client_id'
       ' where not k2.archived and not cl.archived) a join public.contracts k on k.id = a.id';
      conds := array[format('a.company_id = %L', c)];
      person := 'a.responsible';
      nodate := true;
      m := 'count(*)';
    end if;
  elsif src = 'radar' then
    -- Radar do cliente (migration 20261230090000): one row per item (a
    -- subject of a client in a topic); "Ocorrências" counts each time it came
    -- up. "Pessoa" is the item's responsible; "Equipe", the teams that serve
    -- the client.
    rkind := 'coalesce(mavi_private.radar_status(rt.statuses, i.status)->>''kind'', '''')';
    if metric = 'mentions' then
      base := 'public.radar_mentions mn join public.radar_items i on i.id = mn.item_id'
       ' join public.radar_topics rt on rt.id = i.topic_id join public.clients cl on cl.id = i.client_id';
      col := 'mn.occurred_at';
    else
      base := 'public.radar_items i join public.radar_topics rt on rt.id = i.topic_id'
       ' join public.clients cl on cl.id = i.client_id';
      datef := coalesce(q->>'dateField', 'created_at');
      if datef = 'created_at' then col := 'i.created_at';
      elsif datef = 'last_seen_at' then col := 'i.last_seen_at';
      elsif datef = 'status_at' then col := 'i.status_at';
      else raise exception 'Campo de data inválido: %', datef using errcode = '22023';
      end if;
    end if;
    conds := array[format('i.company_id = %L', c), 'not cl.archived'];
    person := 'i.assignee_id';
    m := case metric
      when 'items' then 'count(*)'
      when 'open_items' then format('count(*) filter (where %s <> ''closed'')', rkind)
      when 'closed_items' then format('count(*) filter (where %s = ''closed'')', rkind)
      when 'severe' then 'count(*) filter (where i.severity >= 2)'
      when 'overdue' then format('count(*) filter (where i.due_date < (now() at time zone %L)::date and %s <> ''closed'')',
       tz, rkind)
      when 'recurring' then 'count(*) filter (where i.mentions > 1)'
      when 'clients' then 'count(distinct i.client_id)'
      when 'avg_severity' then 'avg(i.severity)'
      when 'days_to_close' then format('avg(extract(epoch from (i.status_at - i.first_seen_at)) / 86400.0)'
       ' filter (where %s = ''closed'')', rkind)
      when 'mentions' then 'count(*)'
    end;
    if metric in ('clients', 'avg_severity', 'days_to_close') then additive := false; end if;
  else
    raise exception 'Fonte de dados inválida: %', src using errcode = '22023';
  end if;
  if m is null then raise exception 'Métrica inválida: %', metric using errcode = '22023'; end if;

  if nodate then
    if p_group = 'time' then
      raise exception 'Clientes por etapa é a situação de hoje: agrupe por etapa, cliente ou sem agrupar.' using errcode = '22023';
    end if;
  elsif is_ts then
    conds := conds || format('%1$s >= (%2$L::timestamp at time zone %4$L) and %1$s < (%3$L::timestamp at time zone %4$L)',
     col, p_from, p_to + 1, tz);
  else
    conds := conds || format('%s between %L and %L', col, p_from, p_to);
  end if;

  -- The query's own filters, then the dashboard's (client, product, team, person).
  filters := coalesce(q->'filters', '[]'::jsonb);
  if jsonb_typeof(filters) <> 'array' then raise exception 'Filtros inválidos' using errcode = '22023'; end if;
  filters := filters || coalesce((
    select jsonb_agg(jsonb_build_object('field', x.field, 'values', p_filters->x.name))
    from (values ('clients','client'), ('products','product'), ('teams','team'), ('people','person')) x(name, field)
    where jsonb_typeof(p_filters->x.name) = 'array' and jsonb_array_length(p_filters->x.name) > 0
  ), '[]'::jsonb);
  if jsonb_array_length(filters) > 20 then raise exception 'Filtros demais' using errcode = '22023'; end if;
  for f in select value from jsonb_array_elements(filters) loop
    fld := f->>'field';
    op := coalesce(f->>'op', 'in');
    if op not in ('in', 'not_in') then raise exception 'Operador inválido: %', op using errcode = '22023'; end if;
    if jsonb_typeof(coalesce(f->'values', '[]'::jsonb)) <> 'array' then
      raise exception 'Valores de filtro inválidos' using errcode = '22023';
    end if;
    select coalesce(array_agg(x), '{}') into vals from jsonb_array_elements_text(coalesce(f->'values', '[]'::jsonb)) x;
    if cardinality(vals) = 0 then continue; end if;
    if cardinality(vals) > 500 then raise exception 'Filtro com valores demais' using errcode = '22023'; end if;
    if src = 'temperature' then
      -- A client's temperature: the client itself, the products it hires,
      -- the teams that serve it and the people in those teams; the project
      -- filter doesn't apply.
      if fld = 'project' then continue; end if;
      if fld = 'band' then
        conds := conds || format(case when op = 'in' then 'd.band = any(%L::integer[])'
          else '(d.band is null or d.band <> all(%L::integer[]))' end,
         (select coalesce(array_agg(v::integer), '{}') from unnest(vals) v where v ~ '^\d{1,2}$'));
        continue;
      end if;
      colf := case fld
        when 'client' then format('select %L::uuid[]', vals)
        when 'product' then format('select k.client_id from public.contracts k where k.company_id = %L'
          ' and not k.archived and k.product_id = any(%L::uuid[])', c, vals)
        when 'team' then format('select ct.client_id from public.client_teams ct where ct.company_id = %L'
          ' and ct.team_id = any(%L::uuid[])', c, vals)
        when 'person' then format('select ct.client_id from public.client_teams ct join public.team_members tm'
          ' on tm.company_id = ct.company_id and tm.team_id = ct.team_id where ct.company_id = %L'
          ' and tm.user_id = any(%L::uuid[])', c, vals)
      end;
      if colf is null then raise exception 'Filtro inválido para esta fonte: %', fld using errcode = '22023'; end if;
      conds := conds || case when fld = 'client'
        then format(case when op = 'in' then 'd.client_id = any(%L::uuid[])' else 'd.client_id <> all(%L::uuid[])' end, vals)
        else format(case when op = 'in' then 'd.client_id in (%s)' else 'd.client_id not in (%s)' end, colf) end;
      continue;
    end if;
    if src = 'radar' then
      -- The item's client, product (none = Geral / Agência), responsible,
      -- topic, theme, severity and kind of status; a team is the clients it
      -- serves. The project filter doesn't apply.
      if fld = 'project' then continue; end if;
      if fld = 'team' then
        conds := conds || format(case when op = 'in' then 'i.client_id in (%s)' else 'i.client_id not in (%s)' end,
         format('select ct.client_id from public.client_teams ct where ct.company_id = %L and ct.team_id = any(%L::uuid[])',
          c, vals));
        continue;
      end if;
      if fld = 'severity' then
        conds := conds || format(case when op = 'in' then 'i.severity = any(%L::integer[])'
          else '(i.severity is null or i.severity <> all(%L::integer[]))' end,
         (select coalesce(array_agg(v::integer), '{}') from unnest(vals) v where v ~ '^[0-3]$'));
        continue;
      end if;
      if fld = 'state' then
        conds := conds || format(case when op = 'in' then '%s = any(%L::text[])' else '%s <> all(%L::text[])' end,
         rkind, vals);
        continue;
      end if;
      if fld = 'product' and 'none' = any(vals) then
        conds := conds || format(case when op = 'in' then '(i.product_id is null or i.product_id = any(%L::uuid[]))'
          else '(i.product_id is not null and i.product_id <> all(%L::uuid[]))' end,
         (select coalesce(array_agg(v), '{}') from unnest(vals) v where v ~* '^[0-9a-f-]{36}$'));
        continue;
      end if;
      colf := case fld when 'client' then 'i.client_id' when 'product' then 'i.product_id'
       when 'person' then 'i.assignee_id' when 'topic' then 'i.topic_id' when 'theme' then 'i.theme_id' end;
      if colf is null then raise exception 'Filtro inválido para esta fonte: %', fld using errcode = '22023'; end if;
      conds := conds || format(case when op = 'in' then '%1$s = any(%2$L::uuid[])' else '(%1$s is null or %1$s <> all(%2$L::uuid[]))' end,
       colf, (select coalesce(array_agg(v), '{}') from unnest(vals) v where v ~* '^[0-9a-f-]{36}$'));
      continue;
    end if;
    if src = 'social_leads' then
      -- A team counts the clients it serves.
      if fld = 'team' then
        conds := conds || format(case when op = 'in' then '%1$s in (%2$s)' else '%1$s not in (%2$s)' end,
         'k.client_id', format('select ct.client_id from public.client_teams ct where ct.company_id = %L and ct.team_id = any(%L::uuid[])',
          c, vals));
        continue;
      end if;
      if fld not in ('client', 'product', 'person') then
        raise exception 'Filtro inválido para esta fonte: %', fld using errcode = '22023';
      end if;
    end if;
    if src = 'notices' then
      -- Avisos não têm cliente, produto nem projeto: esses filtros do
      -- dashboard não se aplicam a eles. A equipe é a de quem recebeu.
      if fld in ('client', 'product', 'project') then continue; end if;
      if fld = 'team' then
        conds := conds || format(case when op = 'in' then '%1$s in (%2$s)' else '%1$s not in (%2$s)' end,
         'r.user_id', format('select tm.user_id from public.team_members tm where tm.company_id = %L and tm.team_id = any(%L::uuid[])',
          c, vals));
        continue;
      end if;
      if fld not in ('person', 'creator', 'level') then
        raise exception 'Filtro inválido para esta fonte: %', fld using errcode = '22023';
      end if;
    end if;
    if fld = 'late' and src = 'tasks' then
      conds := conds || case when (vals[1] = 'true') = (op = 'in') then late else format('not %s', late) end;
      continue;
    end if;
    colf := case
      when fld = 'client' then 'k.client_id'
      when fld = 'product' then 'k.product_id'
      when fld = 'project' then 't.project_id'
      when fld = 'team' then 't.team_id'
      when fld = 'person' then person
      when fld = 'creator' and on_task then 't.creator_id'
      when fld = 'status' and src = 'tasks' then 't.status'
      when fld = 'status' and src = 'status_history' then 'p.status'
      when fld = 'priority' and on_task then 't.priority'
      when fld = 'entry_source' and src = 'hours' then 'e.source'
      when fld = 'executor' and src = 'tasks' then executor
      when fld = 'previous' and src = 'status_history' then 'p.previous_user_id'
      when fld = 'validator' and src = 'reviews' then validator
      when fld = 'creator' and src = 'notices' then 'n.created_by'
      when fld = 'level' and src = 'notices' then 'n.level'
    end;
    if colf is null then raise exception 'Filtro inválido para esta fonte: %', fld using errcode = '22023'; end if;
    typed := format(case when fld in ('status', 'priority', 'entry_source', 'level') then '%L::text[]' else '%L::uuid[]' end, vals);
    conds := conds || format(case when op = 'in' then '%1$s = any(%2$s)' else '(%1$s is null or %1$s <> all(%2$s))' end,
     colf, typed);
  end loop;

  -- Joins only when something reads the task (t.) or its contract (k.):
  -- hours by day or by person never touch tasks.
  key := case
    when src = 'radar' then case p_group
      when 'client' then 'i.client_id' when 'product' then 'i.product_id' when 'person' then 'i.assignee_id'
      when 'team' then 'ctg.team_id' when 'topic' then 'i.topic_id' when 'theme' then 'i.theme_id'
      when 'severity' then 'i.severity' when 'status' then rkind end
    when src = 'temperature' then case p_group
      when 'client' then 'd.client_id' when 'band' then 'd.band'
      when 'team' then 'ctg.team_id' when 'product' then 'kpg.product_id' end
    when src = 'notices' then case p_group
      when 'person' then person when 'team' then 'tm.team_id' when 'creator' then 'n.created_by'
      when 'notice' then 'n.id' when 'level' then 'n.level' end
    when src = 'social_leads' then case p_group
      when 'client' then 'k.client_id' when 'product' then 'k.product_id' when 'person' then person
      when 'stage' then case when metric = 'clients' then 'a.stage' end end
    when p_group = 'client' then 'k.client_id'
    when p_group = 'product' then 'k.product_id'
    when p_group = 'project' then 't.project_id'
    when p_group = 'team' then 't.team_id'
    when p_group = 'person' then person
    when p_group = 'creator' and on_task then 't.creator_id'
    when p_group = 'status' and src = 'tasks' then 't.status'
    when p_group = 'status' and src = 'status_history' then 'p.status'
    when p_group = 'priority' and on_task then 't.priority'
    when p_group = 'executor' and src = 'tasks' then executor
    when p_group = 'previous' and src = 'status_history' then 'p.previous_user_id'
    when p_group = 'validator' and src = 'reviews' then validator
  end;
  if src = 'hours' and (strpos(array_to_string(conds, ' ') || ' ' || coalesce(key, ''), 't.') > 0
   or strpos(array_to_string(conds, ' ') || ' ' || coalesce(key, ''), 'k.') > 0) then
    base := base || ' join public.tasks t on t.id = e.task_id';
  end if;
  if src = 'notices' and p_group = 'team' then
    base := base || ' join public.team_members tm on tm.company_id = r.company_id and tm.user_id = r.user_id';
  end if;
  if src = 'radar' and p_group = 'team' then
    base := base || ' join public.client_teams ctg on ctg.company_id = i.company_id and ctg.client_id = i.client_id';
  end if;
  if src = 'temperature' and p_group = 'team' then
    base := base || ' join public.client_teams ctg on ctg.company_id = d.company_id and ctg.client_id = d.client_id';
  end if;
  if src = 'temperature' and p_group = 'product' then
    base := base || ' join (select distinct x.company_id, x.client_id, x.product_id from public.contracts x'
     ' where not x.archived) kpg on kpg.company_id = d.company_id and kpg.client_id = d.client_id';
  end if;
  if src not in ('social_leads', 'notices', 'temperature', 'radar')
   and strpos(array_to_string(conds, ' ') || ' ' || coalesce(key, ''), 'k.') > 0 then
    base := base || ' join public.contracts k on k.id = t.contract_id';
  end if;

  if p_group = 'none' then
    return format('select jsonb_build_array(jsonb_build_object(''k'', ''total'', ''v'', %s)) from %s where %s',
     m, base, array_to_string(conds, ' and '));
  end if;

  if p_group = 'time' then
    if p_interval not in ('day', 'week', 'month') then
      raise exception 'Intervalo inválido: %', p_interval using errcode = '22023';
    end if;
    bucket := case when is_ts then format('date_trunc(%L, %s at time zone %L)::date', p_interval, col, tz)
      else format('date_trunc(%L, %s::timestamp)::date', p_interval, col) end;
    return format($f$with g as (select %1$s as k, %2$s as v from %3$s where %4$s group by 1),
 b as (select d::date as k from generate_series(date_trunc(%5$L, %6$L::timestamp), %7$L::timestamp, %8$L::interval) d)
 select coalesce(jsonb_agg(jsonb_build_object('k', b.k, 'v', %9$s) order by b.k), '[]') from b left join g on g.k = b.k$f$,
     bucket, m, base, array_to_string(conds, ' and '), p_interval, p_from, p_to, '1 ' || p_interval,
     case when additive then 'coalesce(g.v, 0)' else 'g.v' end);
  end if;

  if key is null then raise exception 'Agrupamento inválido para esta fonte: %', p_group using errcode = '22023'; end if;
  label := case
    when src = 'radar' and p_group = 'product' then
     'coalesce((select x.name from public.products x where x.id = r.k), ''Geral / Agência'')'
    when src = 'radar' and p_group = 'person' then
     format('coalesce((select x.name from public.memberships x where x.company_id = %L and x.user_id = r.k), ''Sem responsável'')', c)
    when src = 'radar' and p_group = 'status' then 'case r.k::text when ''open'' then ''Aberto'''
     ' when ''progress'' then ''Em andamento'' when ''closed'' then ''Fechado'' else r.k::text end'
    when p_group = 'topic' then '(select x.name from public.radar_topics x where x.id = r.k)'
    when p_group = 'theme' then 'coalesce((select x.title from public.radar_themes x where x.id = r.k), ''Sem tema'')'
    when p_group = 'severity' then 'case r.k::text when ''0'' then ''Baixa'' when ''1'' then ''Média'''
     ' when ''2'' then ''Alta'' when ''3'' then ''Crítica'' else ''Sem gravidade'' end'
    when p_group = 'client' then '(select x.name from public.clients x where x.id = r.k)'
    when p_group = 'product' then '(select x.name from public.products x where x.id = r.k)'
    when p_group = 'project' then '(select x.name from public.projects x where x.id = r.k)'
    when p_group = 'team' then '(select x.name from public.teams x where x.id = r.k)'
    when p_group in ('person', 'creator', 'executor', 'previous', 'validator') then
      format('(select x.name from public.memberships x where x.company_id = %L and x.user_id = r.k)', c)
    when p_group = 'notice' then '(select x.title from public.notices x where x.id = r.k)'
    when p_group = 'level' then 'case r.k::text when ''info'' then ''Informativo'' when ''important'' then ''Importante'''
     ' when ''critical'' then ''Crítico'' else r.k::text end'
    when p_group = 'stage' then 'case r.k::text when ''briefing'' then ''Briefing'' when ''plan'' then ''Plano para revisar'''
     ' when ''approval'' then ''Aguardando o cliente'' when ''production'' then ''Aprovado / produção'''
     ' when ''campaign'' then ''Campanha no ar'' else r.k::text end'
    when p_group = 'band' then format('coalesce((%L::jsonb)->(r.k::integer)->>''name'', ''Sem nota'')', coalesce(bands, '[]'))
    else 'r.k::text'
  end;
  -- Sums and counts fold the rest into "Outros"; averages and distinct
  -- counts cannot be added up, so the rest is left out.
  if additive then
    other := format('union all select jsonb_build_object(''k'', ''__other__'', ''l'', ''Outros'', ''v'', sum(r.v)), %s from r where r.n > %s having count(*) > 0',
     lim + 1, lim);
  end if;
  return format($f$with g as (select %1$s as k, %2$s as v from %3$s where %4$s group by 1),
 r as (select k, v, row_number() over (order by v desc nulls last, k) as n from g)
 select coalesce(jsonb_agg(o order by n), '[]') from (
  select jsonb_build_object('k', r.k::text, 'l', %5$s, 'v', r.v) as o, r.n from r where r.n <= %6$s
  %7$s
 ) s$f$, key, m, base, array_to_string(conds, ' and '), label, lim, other);
end $$;
revoke all on function mavi_private.dashboard_sql(uuid, jsonb, text, text, date, date, jsonb, integer) from public, anon, authenticated;

-- A da migração 20261110090000, com os agrupamentos do Radar.
create or replace function mavi_private.dashboard_check(c uuid, p_panels jsonb, p_variables jsonb) returns void
language plpgsql stable security definer set search_path = '' as $$
declare p jsonb; q jsonb; spec jsonb; ids text[] := '{}'; refs text[]; expr text; begin
  if jsonb_typeof(p_panels) <> 'array' or jsonb_array_length(p_panels) > 48 then
    raise exception 'Um dashboard tem até 48 painéis' using errcode = '22023';
  end if;
  if octet_length(p_panels::text) > 300000 then raise exception 'Dashboard grande demais' using errcode = '22023'; end if;
  if jsonb_typeof(coalesce(p_variables, '{}'::jsonb)) <> 'object' then
    raise exception 'Variáveis inválidas' using errcode = '22023';
  end if;
  for p in select value from jsonb_array_elements(p_panels) loop
    if coalesce(p->>'id', '') !~ '^[a-z0-9-]{1,40}$' or p->>'id' = any(ids) then
      raise exception 'Painel com identificador inválido' using errcode = '22023';
    end if;
    ids := ids || (p->>'id');
    if length(coalesce(p->>'title', '')) > 120 then raise exception 'Título de painel longo demais' using errcode = '22023'; end if;
    if jsonb_typeof(p->'x') <> 'number' or jsonb_typeof(p->'y') <> 'number'
     or jsonb_typeof(p->'w') <> 'number' or jsonb_typeof(p->'h') <> 'number'
     or (p->>'x')::int not between 0 and 11 or (p->>'w')::int not between 1 and 12
     or (p->>'x')::int + (p->>'w')::int > 12 or (p->>'y')::int not between 0 and 2000
     or (p->>'h')::int not between 1 and 24 then
      raise exception 'Posição de painel inválida' using errcode = '22023';
    end if;
    spec := p->'spec';
    if coalesce(spec->>'viz', '') not in ('stat', 'line', 'area', 'bar', 'hbar', 'donut', 'table') then
      raise exception 'Visualização inválida' using errcode = '22023';
    end if;
    if coalesce(spec->>'groupBy', 'none') not in
     ('none', 'time', 'client', 'product', 'project', 'team', 'person', 'creator', 'status', 'priority', 'stage',
      'executor', 'previous', 'validator', 'notice', 'level', 'band', 'topic', 'theme', 'severity') then
      raise exception 'Agrupamento inválido' using errcode = '22023';
    end if;
    if coalesce(spec->>'interval', 'auto') not in ('auto', 'day', 'week', 'month') then
      raise exception 'Intervalo inválido' using errcode = '22023';
    end if;
    if jsonb_typeof(spec->'queries') <> 'array' or jsonb_array_length(spec->'queries') not between 1 and 5 then
      raise exception 'Cada painel tem de 1 a 5 consultas' using errcode = '22023';
    end if;
    expr := coalesce(spec->'formula'->>'expr', '');
    if length(expr) > 200 or expr !~ '^[A-E0-9+*/(). -]*$' then
      raise exception 'Fórmula inválida: use A a E, números, + - * / e parênteses' using errcode = '22023';
    end if;
    refs := '{}';
    for q in select value from jsonb_array_elements(spec->'queries') loop
      if coalesce(q->>'ref', '') !~ '^[A-E]$' or q->>'ref' = any(refs) then
        raise exception 'Consulta inválida' using errcode = '22023';
      end if;
      refs := refs || (q->>'ref');
      perform mavi_private.dashboard_sql(c, q, coalesce(spec->>'groupBy', 'none'), 'month',
       current_date, current_date, coalesce(p_variables->'filters', '{}'::jsonb), 10);
    end loop;
  end loop;
end $$;
revoke all on function mavi_private.dashboard_check(uuid, jsonb, jsonb) from public, anon, authenticated;

-- ------------------------------------------------------------ permissões
revoke all on function mavi_private.radar_theme_cleanup(), mavi_private.radar_item_json(public.radar_items)
 from public, anon, authenticated;
revoke all on function public.ai_set_route(uuid, text, uuid, uuid, text, text), public.link_radar_task(uuid, uuid, uuid),
 public.radar_items(uuid, jsonb), public.radar_item(uuid, uuid), public.update_radar_item(uuid, uuid, jsonb),
 public.radar_themes(uuid, jsonb), public.radar_theme(uuid, uuid), public.update_radar_theme(uuid, uuid, text, text),
 public.merge_radar_themes(uuid, uuid, uuid[]), public.set_radar_item_theme(uuid, uuid, uuid, text, boolean),
 public.radar_theme_options(uuid)
 from public, anon;
grant execute on function public.ai_set_route(uuid, text, uuid, uuid, text, text), public.link_radar_task(uuid, uuid, uuid),
 public.radar_items(uuid, jsonb), public.radar_item(uuid, uuid), public.update_radar_item(uuid, uuid, jsonb),
 public.radar_themes(uuid, jsonb), public.radar_theme(uuid, uuid), public.update_radar_theme(uuid, uuid, text, text),
 public.merge_radar_themes(uuid, uuid, uuid[]), public.set_radar_item_theme(uuid, uuid, uuid, text, boolean),
 public.radar_theme_options(uuid)
 to authenticated;
-- O worker chama como anon + segredo.
revoke all on function public.ai_radar_theme_claim(text, integer), public.ai_radar_theme_store(text, jsonb)
 from public, anon, authenticated;
grant execute on function public.ai_radar_theme_claim(text, integer), public.ai_radar_theme_store(text, jsonb)
 to anon, authenticated;
revoke all on function mavi_private.ai_radar_kick() from public, anon, authenticated;

commit;
