begin;

-- MAVI · Poderes (Fases 0 e 1 da orquestradora):
--
-- 1. Poderes: visualizações ('visuals': gráficos, tabelas, indicadores e
--    linha do tempo desenhados pelo app), imagens ('images': gerar e editar
--    pelo provedor escolhido em "Quem usa qual modelo") e ações
--    ('actions': a MAVI propõe criar uma tarefa ou comentar numa, e só a
--    pessoa confirma). Vêm desligados; administradores e gestores ligam na
--    empresa e dizem quem pode usar (todos, ou equipes e pessoas, com
--    exceções). Quem tem a MAVI desligada nos módulos não tem nenhum poder.
-- 2. Registro de cada chamada de ferramenta da MAVI (qual, quem, quanto
--    tempo, se falhou, quanto custou), guardado por um ano e somado no
--    Consumo (by_tool).
-- 3. As respostas guardam o que a MAVI mostrou além do texto
--    (ai_messages.artifacts): a visualização, a imagem (caminho no GCS) ou a
--    ação proposta, com o que a pessoa decidiu.
-- 4. Nova funcionalidade em "Quem usa qual modelo": 'image_generation'. Só
--    provedores com o endpoint de imagens da OpenAI (OpenAI, Google, xAI ou
--    endereço próprio) e modelos de imagem; não herda o padrão da empresa
--    (um modelo de conversa): sem regra, vale o do servidor (OPENAI_API_KEY).

-- ------------------------------------------------------------ poderes
create table public.ai_powers (
 company_id uuid not null references public.companies(id),
 power text not null check (power in ('visuals', 'images', 'actions')),
 enabled boolean not null default false,
 everyone boolean not null default true,
 team_ids uuid[] not null default '{}',
 user_ids uuid[] not null default '{}',
 except_ids uuid[] not null default '{}',
 updated_by uuid default auth.uid(),
 updated_at timestamptz not null default now(),
 primary key (company_id, power)
);
alter table public.ai_powers enable row level security;
revoke all on public.ai_powers from public, anon, authenticated;

create function mavi_private.ai_power_on(c uuid, u uuid, p_power text) returns boolean
language sql stable security definer set search_path = '' as $$
 select exists (select 1 from public.ai_powers w
  join public.memberships m on m.company_id = w.company_id and m.user_id = u and m.active
  where w.company_id = c and w.power = p_power and w.enabled
   and not ('assistant' = any(m.hidden_pages))
   and not (u = any(w.except_ids))
   and (w.everyone or u = any(w.user_ids) or exists (select 1 from public.team_members tm
    where tm.company_id = c and tm.user_id = u and tm.team_id = any(w.team_ids))))
$$;
revoke all on function mavi_private.ai_power_on(uuid, uuid, text) from public, anon, authenticated;

-- Os poderes de quem está logado (o servidor da MAVI pergunta antes de cada resposta).
create function public.ai_my_powers(p_company uuid) returns text[]
language sql stable security definer set search_path = '' as $$
 select coalesce(array_agg(p order by p), '{}') from unnest(array['actions', 'images', 'visuals']) p
 where mavi_private.member(p_company) and mavi_private.ai_power_on(p_company, auth.uid(), p)
$$;

create function public.ai_powers_admin(p_company uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$ begin
 if not mavi_private.leader(p_company) then
  raise exception 'Só administradores e gestores configuram os poderes da MAVI.' using errcode = '42501';
 end if;
 return (select coalesce(jsonb_agg(jsonb_build_object('power', p.power,
   'enabled', coalesce(w.enabled, false), 'everyone', coalesce(w.everyone, true),
   'team_ids', to_jsonb(coalesce(w.team_ids, '{}')), 'user_ids', to_jsonb(coalesce(w.user_ids, '{}')),
   'except_ids', to_jsonb(coalesce(w.except_ids, '{}')), 'updated_at', w.updated_at, 'updated_by', w.updated_by)
   order by p.ord), '[]')
  from unnest(array['visuals', 'images', 'actions']) with ordinality p(power, ord)
  left join public.ai_powers w on w.company_id = p_company and w.power = p.power);
end $$;

create function public.ai_set_power(p_company uuid, p_power text, p_enabled boolean, p_everyone boolean,
 p_teams uuid[], p_users uuid[], p_except uuid[]) returns void
language plpgsql security definer set search_path = '' as $$
declare v_teams uuid[]; v_users uuid[]; v_except uuid[]; begin
 if not mavi_private.leader(p_company) then
  raise exception 'Só administradores e gestores configuram os poderes da MAVI.' using errcode = '42501';
 end if;
 if p_power not in ('visuals', 'images', 'actions') then
  raise exception 'Poder inválido.' using errcode = '22023';
 end if;
 select coalesce(array_agg(distinct t), '{}') into v_teams from unnest(coalesce(p_teams, '{}')) t
 where exists (select 1 from public.teams x where x.company_id = p_company and x.id = t);
 select coalesce(array_agg(distinct u), '{}') into v_users from unnest(coalesce(p_users, '{}')) u
 where exists (select 1 from public.memberships x where x.company_id = p_company and x.user_id = u);
 select coalesce(array_agg(distinct u), '{}') into v_except from unnest(coalesce(p_except, '{}')) u
 where exists (select 1 from public.memberships x where x.company_id = p_company and x.user_id = u);
 if coalesce(p_enabled, false) and not coalesce(p_everyone, true)
  and cardinality(v_teams) = 0 and cardinality(v_users) = 0 then
  raise exception 'Escolha pelo menos uma equipe ou pessoa (ou libere para todos).' using errcode = '22023';
 end if;
 insert into public.ai_powers(company_id, power, enabled, everyone, team_ids, user_ids, except_ids, updated_by)
 values (p_company, p_power, coalesce(p_enabled, false), coalesce(p_everyone, true), v_teams, v_users, v_except,
  auth.uid())
 on conflict (company_id, power) do update set enabled = excluded.enabled, everyone = excluded.everyone,
  team_ids = excluded.team_ids, user_ids = excluded.user_ids, except_ids = excluded.except_ids,
  updated_by = auth.uid(), updated_at = now();
end $$;

revoke all on function public.ai_my_powers(uuid), public.ai_powers_admin(uuid),
 public.ai_set_power(uuid, text, boolean, boolean, uuid[], uuid[], uuid[]) from public, anon;
grant execute on function public.ai_my_powers(uuid), public.ai_powers_admin(uuid),
 public.ai_set_power(uuid, text, boolean, boolean, uuid[], uuid[], uuid[]) to authenticated;

-- ------------------------------------------------------------ chamadas de ferramentas
create table public.ai_tool_calls (
 id bigint generated always as identity primary key,
 company_id uuid not null references public.companies(id),
 user_id uuid not null default auth.uid(),
 conversation_id uuid,
 module text not null default 'assistant' check (length(module) <= 40),
 tool text not null check (length(tool) between 1 and 80),
 power text check (power in ('visuals', 'images', 'actions')),
 ok boolean not null,
 duration_ms integer not null default 0 check (duration_ms >= 0),
 cost_usd numeric(12, 6) not null default 0 check (cost_usd >= 0),
 error text check (length(error) <= 300),
 created_at timestamptz not null default now()
);
create index ai_tool_calls_company on public.ai_tool_calls(company_id, created_at desc);
alter table public.ai_tool_calls enable row level security;
revoke all on public.ai_tool_calls from public, anon, authenticated;

-- Grava as chamadas de uma resposta (o servidor da MAVI, com o token de quem perguntou).
create function public.ai_log_tool_calls(p_company uuid, p_conversation uuid, p_module text, p_calls jsonb)
returns void
language plpgsql security definer set search_path = '' as $$
declare v_conversation uuid := p_conversation; begin
 if not mavi_private.member(p_company) then raise exception 'Sem permissão.' using errcode = '42501'; end if;
 if jsonb_typeof(coalesce(p_calls, '[]')) <> 'array' or jsonb_array_length(coalesce(p_calls, '[]')) > 60 then
  raise exception 'Lista de chamadas inválida.' using errcode = '22023';
 end if;
 if v_conversation is not null and not exists (select 1 from public.ai_conversations v
  where v.company_id = p_company and v.id = v_conversation and v.owner_id = auth.uid()) then
  v_conversation := null;
 end if;
 insert into public.ai_tool_calls(company_id, conversation_id, module, tool, power, ok, duration_ms, cost_usd, error)
 select p_company, v_conversation, left(coalesce(p_module, 'assistant'), 40), left(x.tool, 80),
  case when x.power in ('visuals', 'images', 'actions') then x.power end, coalesce(x.ok, false),
  least(greatest(coalesce(x.ms, 0), 0), 3600000), least(greatest(coalesce(x.cost, 0), 0), 100),
  left(x.error, 300)
 from jsonb_to_recordset(coalesce(p_calls, '[]')) as x(tool text, power text, ok boolean, ms integer, cost numeric,
  error text)
 where coalesce(btrim(x.tool), '') <> '';
end $$;
revoke all on function public.ai_log_tool_calls(uuid, uuid, text, jsonb) from public, anon;
grant execute on function public.ai_log_tool_calls(uuid, uuid, text, jsonb) to authenticated;

-- Guardadas por um ano.
do $$ begin
 if exists (select 1 from pg_available_extensions where name = 'pg_cron') then
  create extension if not exists pg_cron;
  perform cron.schedule('mavi-ai-tool-calls-retention', '50 3 * * *',
   $job$delete from public.ai_tool_calls where created_at < now() - interval '1 year'$job$);
 else
  raise notice 'pg_cron unavailable: retention must be scheduled on the hosted database';
 end if;
end $$;

-- ------------------------------------------------------------ o que a MAVI mostrou
alter table public.ai_messages add column artifacts jsonb not null default '[]'
 check (jsonb_typeof(artifacts) = 'array' and jsonb_array_length(artifacts) <= 12
  and pg_column_size(artifacts) <= 1048576);

-- Cada item: id, tipo (visual, image, action); uma imagem só aponta para as
-- imagens da própria empresa.
create function mavi_private.ai_artifacts_ok(c uuid, p jsonb) returns boolean
language sql immutable set search_path = '' as $$
 select jsonb_typeof(coalesce(p, '[]')) = 'array' and jsonb_array_length(coalesce(p, '[]')) <= 12
  and not exists (select 1 from jsonb_array_elements(coalesce(p, '[]')) a
   where jsonb_typeof(a) <> 'object' or coalesce(a->>'id', '') !~ '^[A-Za-z0-9_-]{4,64}$'
    or coalesce(a->>'type', '') not in ('visual', 'image', 'action')
    or (a->>'type' = 'image' and coalesce(a->>'path', '') !~
     ('^ai-images/' || c::text || '/[0-9a-f-]{36}\.(png|webp|jpg)$')))
$$;
revoke all on function mavi_private.ai_artifacts_ok(uuid, jsonb) from public, anon, authenticated;

drop function public.ai_save_turn(uuid, uuid, jsonb, text, text, text, jsonb, jsonb);
create function public.ai_save_turn(p_company uuid, p_conversation uuid, p_scope jsonb, p_module text,
 p_question text, p_answer text, p_sources jsonb, p_steps jsonb, p_artifacts jsonb default '[]') returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_id uuid := p_conversation; v_owner uuid; begin
 if not mavi_private.member(p_company) then raise exception 'Sem acesso ao espaço' using errcode = '42501'; end if;
 if not mavi_private.ai_artifacts_ok(p_company, p_artifacts) then
  raise exception 'Anexos da resposta inválidos.' using errcode = '22023';
 end if;
 if v_id is null then
  insert into public.ai_conversations(company_id, title, scope, module)
  values (p_company, left(coalesce(nullif(btrim(regexp_replace(p_question, '\s+', ' ', 'g')), ''), 'Nova conversa'), 80),
   coalesce(p_scope, '{}'), left(coalesce(p_module, 'assistant'), 40))
  returning id into v_id;
 else
  select owner_id into v_owner from public.ai_conversations where company_id = p_company and id = v_id;
  if v_owner is null then raise exception 'Conversa não encontrada.' using errcode = 'P0002'; end if;
  if v_owner <> auth.uid() then
   raise exception 'Só quem começou a conversa continua nela.' using errcode = '42501';
  end if;
  update public.ai_conversations set updated_at = now() where id = v_id;
 end if;
 insert into public.ai_messages(company_id, conversation_id, role, content) values (p_company, v_id, 'user', left(p_question, 40000));
 insert into public.ai_messages(company_id, conversation_id, role, content, sources, steps, artifacts)
 values (p_company, v_id, 'assistant', left(p_answer, 40000), coalesce(p_sources, '[]'), coalesce(p_steps, '[]'),
  coalesce(p_artifacts, '[]'));
 return v_id;
end $$;
revoke all on function public.ai_save_turn(uuid, uuid, jsonb, text, text, text, jsonb, jsonb, jsonb) from public, anon;
grant execute on function public.ai_save_turn(uuid, uuid, jsonb, text, text, text, jsonb, jsonb, jsonb) to authenticated;

-- A decisão da pessoa sobre uma ação proposta (uma vez só; só quem começou a conversa).
create function public.ai_set_action_state(p_conversation uuid, p_artifact text, p_state text, p_result jsonb)
returns void
language plpgsql security definer set search_path = '' as $$
declare v_company uuid; v_message bigint; begin
 if p_state not in ('confirmed', 'cancelled', 'failed') then
  raise exception 'Situação inválida.' using errcode = '22023';
 end if;
 select company_id into v_company from public.ai_conversations
 where id = p_conversation and owner_id = auth.uid();
 if v_company is null or not mavi_private.member(v_company) then
  raise exception 'Só quem começou a conversa decide as ações dela.' using errcode = '42501';
 end if;
 select m.id into v_message from public.ai_messages m
 where m.company_id = v_company and m.conversation_id = p_conversation
  and m.artifacts @> jsonb_build_array(jsonb_build_object('id', p_artifact, 'type', 'action', 'state', 'pending'))
 order by m.id desc limit 1;
 if v_message is null then raise exception 'Esta ação já foi decidida.' using errcode = 'P0002'; end if;
 update public.ai_messages m set artifacts = (
  select jsonb_agg(case when a->>'id' = p_artifact
    then a || jsonb_build_object('state', p_state, 'result', coalesce(p_result, '{}'),
     'decided_at', now(), 'decided_by', auth.uid())
    else a end order by ord)
  from jsonb_array_elements(m.artifacts) with ordinality t(a, ord))
 where m.id = v_message;
end $$;
revoke all on function public.ai_set_action_state(uuid, text, text, jsonb) from public, anon;
grant execute on function public.ai_set_action_state(uuid, text, text, jsonb) to authenticated;

-- ------------------------------------------------------------ consumo por ferramenta
create or replace function public.ai_usage_report(p_company uuid, p_from date, p_to date) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_from timestamptz; v_to timestamptz; v_start timestamptz := mavi_private.ai_month_start(); begin
 if not mavi_private.leader(p_company) then raise exception 'Sem permissão.' using errcode = '42501'; end if;
 v_from := p_from::timestamp at time zone 'America/Sao_Paulo';
 v_to := (p_to + 1)::timestamp at time zone 'America/Sao_Paulo';
 return (with u as (
   select * from public.ai_usage where company_id = p_company and created_at >= v_from and created_at < v_to)
  select jsonb_build_object(
   'total', (select jsonb_build_object('cost', coalesce(sum(cost_usd), 0),
     'asks', count(*) filter (where kind = 'ask'),
     'index_cost', coalesce(sum(cost_usd) filter (where kind = 'index'), 0),
     'input_tokens', coalesce(sum(input_tokens), 0), 'output_tokens', coalesce(sum(output_tokens), 0),
     'embedding_tokens', coalesce(sum(embedding_tokens), 0)) from u),
   'by_user', (select coalesce(jsonb_agg(x order by x.cost desc), '[]') from (
     select user_id as id, sum(cost_usd) as cost, count(*) filter (where kind = 'ask') as asks
     from u where user_id is not null group by user_id) x),
   'by_client', (select coalesce(jsonb_agg(x order by x.cost desc), '[]') from (
     select client_id as id, sum(cost_usd) as cost, count(*) filter (where kind = 'ask') as asks
     from u where client_id is not null group by client_id) x),
   'by_contract', (select coalesce(jsonb_agg(x order by x.cost desc), '[]') from (
     select contract_id as id, sum(cost_usd) as cost, count(*) filter (where kind = 'ask') as asks
     from u where contract_id is not null group by contract_id) x),
   'by_project', (select coalesce(jsonb_agg(x order by x.cost desc), '[]') from (
     select project_id as id, sum(cost_usd) as cost, count(*) filter (where kind = 'ask') as asks
     from u where project_id is not null group by project_id) x),
   'by_module', (select coalesce(jsonb_agg(x order by x.cost desc), '[]') from (
     select module as id, sum(cost_usd) as cost, count(*) filter (where kind = 'ask') as asks
     from u group by module) x),
   'by_model', (select coalesce(jsonb_agg(x order by x.cost desc), '[]') from (
     select provider_name || '|' || model as id, provider_name as provider, model, sum(cost_usd) as cost,
      count(*) filter (where kind = 'ask') as asks,
      sum(input_tokens + cache_read_tokens + cache_write_tokens) as input_tokens, sum(output_tokens) as output_tokens
     from u group by provider_name, model) x),
   'by_tool', (select coalesce(jsonb_agg(x order by x.calls desc), '[]') from (
     select tool as id, count(*) as calls, count(*) filter (where not ok) as errors,
      round(avg(duration_ms))::integer as avg_ms, sum(cost_usd) as cost, count(distinct user_id) as people
     from public.ai_tool_calls where company_id = p_company and created_at >= v_from and created_at < v_to
     group by tool) x),
   'by_day', (select coalesce(jsonb_agg(x order by x.day), '[]') from (
     select to_char(created_at at time zone 'America/Sao_Paulo', 'YYYY-MM-DD') as day, sum(cost_usd) as cost,
      count(*) filter (where kind = 'ask') as asks
     from u group by 1) x),
   'limits', (select coalesce(jsonb_agg(jsonb_build_object('type', l.scope_type, 'id', l.scope_id,
      'monthly_usd', l.monthly_usd, 'month_spent', (
       select coalesce(sum(a.cost_usd), 0) from public.ai_usage a
       where a.company_id = p_company and a.created_at >= v_start and case l.scope_type
        when 'company' then true when 'user' then a.user_id = l.scope_id when 'client' then a.client_id = l.scope_id
        when 'contract' then a.contract_id = l.scope_id else a.project_id = l.scope_id end))
      order by l.scope_type), '[]') from public.ai_limits l where l.company_id = p_company)));
end $$;

-- ------------------------------------------------------------ modelo de imagem
create function mavi_private.ai_image_model(p_model text) returns boolean
language sql immutable set search_path = '' as $$
 select coalesce(p_model, '') ~* '(image|dall-e|imagen|flux)'
$$;
-- Vetores, transcrição ou imagem: não conversam.
create or replace function mavi_private.ai_non_chat_model(p_model text) returns boolean
language sql immutable set search_path = '' as $$
 select mavi_private.ai_transcribe_model(p_model) or coalesce(p_model, '') ~* 'embed'
  or mavi_private.ai_image_model(p_model)
$$;
-- Funcionalidades que não herdam o padrão da empresa (um modelo de conversa).
create function mavi_private.ai_own_model_feature(p_feature text) returns boolean
language sql immutable set search_path = '' as $$
 select mavi_private.ai_transcribe_feature(p_feature) or coalesce(p_feature, '') = 'image_generation'
$$;
revoke all on function mavi_private.ai_image_model(text), mavi_private.ai_non_chat_model(text),
 mavi_private.ai_own_model_feature(text) from public, anon, authenticated;

alter table mavi_private.ai_routes drop constraint ai_routes_feature_check;
alter table mavi_private.ai_routes add constraint ai_routes_feature_check
 check ((scope_type = 'feature') = (feature is not null)
  and (feature is null or feature in ('assistant', 'meetings_history', 'meetings_ask', 'whatsapp_task',
   'social_leads_plan', 'social_leads_adjust', 'social_leads_briefing', 'social_leads_colors',
   'task_copilot', 'client_dossier', 'copilot_learning', 'notice_writer', 'notice_animation',
   'client_temperature', 'client_temperature_text', 'task_audio',
   'whatsapp_transcribe', 'task_audio_transcribe', 'image_generation')));

create or replace function public.ai_set_route(p_company uuid, p_type text, p_id uuid, p_provider uuid, p_model text,
 p_feature text default null) returns void
language plpgsql security definer set search_path = '' as $$
declare v_id uuid := case when p_type in ('company', 'feature') then null else p_id end;
 v_feature text := case when p_type = 'feature' then p_feature end; v_kind text; begin
 if not mavi_private.leader(p_company) then
  raise exception 'Só administradores e gestores escolhem qual IA cada um usa.' using errcode = '42501';
 end if;
 if p_type not in ('company', 'user', 'client', 'contract', 'project', 'feature') then
  raise exception 'Tipo inválido.' using errcode = '22023';
 end if;
 if p_type not in ('company', 'feature') and p_id is null then
  raise exception 'Escolha para quem vale a regra.' using errcode = '22023';
 end if;
 if p_type = 'feature' and coalesce(v_feature, '') not in ('assistant', 'meetings_history', 'meetings_ask',
  'whatsapp_task', 'social_leads_plan', 'social_leads_adjust', 'social_leads_briefing', 'social_leads_colors',
  'task_copilot', 'client_dossier', 'copilot_learning', 'notice_writer', 'notice_animation',
  'client_temperature', 'client_temperature_text', 'task_audio',
  'whatsapp_transcribe', 'task_audio_transcribe', 'image_generation') then
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
  if v_kind not in ('openai', 'google', 'xai', 'custom') then
   raise exception 'As imagens usam a OpenAI, o Google, a xAI ou um endereço compatível.' using errcode = '22023';
  end if;
  if not mavi_private.ai_image_model(p_model) then
   raise exception 'Escolha um modelo de imagem (gpt-image-1, Imagen, grok-2-image…).' using errcode = '22023';
  end if;
 elsif mavi_private.ai_non_chat_model(p_model) then
  raise exception 'Este modelo só transcreve, gera vetores ou imagens: escolha um modelo de conversa.' using errcode = '22023';
 end if;
 -- O termômetro lê com o Jev pelo OpenRouter; o Jev não conversa.
 if v_feature = 'client_temperature' and not (v_kind = 'openrouter' and mavi_private.jev_model(p_model)) then
  raise exception 'O termômetro usa o Jev (TypeSafe) pelo OpenRouter: escolha o modelo do Jev.' using errcode = '22023';
 end if;
 if coalesce(v_feature, '') <> 'client_temperature' and mavi_private.jev_model(p_model) then
  raise exception 'O Jev só responde a perguntas de decisão: use-o no termômetro do cliente.' using errcode = '22023';
 end if;
 if p_type = 'user' and not exists (select 1 from public.memberships where company_id = p_company and user_id = p_id)
  or p_type = 'client' and not exists (select 1 from public.clients where company_id = p_company and id = p_id)
  or p_type = 'contract' and not exists (select 1 from public.contracts where company_id = p_company and id = p_id)
  or p_type = 'project' and not exists (select 1 from public.projects where company_id = p_company and id = p_id) then
  raise exception 'Não encontrado na empresa.' using errcode = 'P0002';
 end if;
 insert into mavi_private.ai_routes(company_id, scope_type, scope_id, feature, provider_id, model)
 values (p_company, p_type, v_id, v_feature, p_provider, p_model)
 on conflict on constraint ai_routes_scope_key do update set provider_id = excluded.provider_id,
  model = excluded.model, updated_by = auth.uid(), updated_at = now();
end $$;

-- Qual IA responde (como antes); transcrição e imagens só pela regra delas.
create or replace function public.ai_resolve_route(p_company uuid, p_client uuid, p_contract uuid, p_project uuid,
 p_feature text default null) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_contract uuid := p_contract; v_client uuid := p_client; v_feature text := coalesce(p_feature, 'assistant');
 v_talk boolean; v_own boolean; r record; begin
 if not mavi_private.member(p_company) then raise exception 'Sem acesso ao espaço' using errcode = '42501'; end if;
 v_talk := v_feature in ('assistant', 'meetings_history', 'meetings_ask');
 v_own := mavi_private.ai_own_model_feature(v_feature);
 if p_project is not null then
  select coalesce(pr.contract_id, v_contract) into v_contract from public.projects pr
  where pr.id = p_project and pr.company_id = p_company;
 end if;
 if v_contract is not null then
  select coalesce(k.client_id, v_client) into v_client from public.contracts k
  where k.id = v_contract and k.company_id = p_company;
 end if;
 -- Só vale o contexto de clientes que a pessoa acessa.
 if v_client is not null and not mavi_private.drive_can_read(p_company, v_client) then
  v_client := null; v_contract := null;
 end if;
 select rt.scope_type, rt.model, p.id, p.name, p.kind, p.base_url, p.key_cipher, p.models into r
 from mavi_private.ai_routes rt join mavi_private.ai_providers p on p.id = rt.provider_id and p.active
 where rt.company_id = p_company and (
   (v_talk and (
    (rt.scope_type = 'project' and rt.scope_id = p_project and v_contract is not distinct from
      (select pr.contract_id from public.projects pr where pr.id = p_project))
    or (rt.scope_type = 'contract' and rt.scope_id = v_contract)
    or (rt.scope_type = 'client' and rt.scope_id = v_client)
    or (rt.scope_type = 'user' and rt.scope_id = auth.uid())))
   or (rt.scope_type = 'feature' and rt.feature = v_feature)
   or (rt.scope_type = 'company' and not v_own))
 order by case rt.scope_type when 'project' then 1 when 'contract' then 2 when 'client' then 3
  when 'user' then 4 when 'feature' then 5 else 6 end
 limit 1;
 if not found then return null; end if;
 return jsonb_build_object('scope', r.scope_type, 'provider_id', r.id, 'provider', r.name, 'kind', r.kind,
  'base_url', r.base_url, 'key_cipher', r.key_cipher, 'model', r.model,
  'price', (select m from jsonb_array_elements(r.models) m where m->>'id' = r.model limit 1));
end $$;

commit;
