begin;

-- MAVI · canvas e internet:
--
-- 1. Dois poderes novos: 'canvas' (documentos, apresentações e planilhas
--    no canvas ao lado da conversa, que baixam em Word, PowerPoint, Excel e
--    PDF) e 'web' (busca na internet e leitura de páginas, pela Claude).
--    Vêm desligados, como os outros.
-- 2. As respostas guardam o documento, a apresentação ou a planilha como
--    anexo do tipo 'canvas' (ai_messages.artifacts).
-- 3. Imagens: o OpenRouter também entra em "Quem usa qual modelo ›
--    Geração e edição de imagens" (os modelos de imagem dele respondem pelo
--    chat, com modalities image e text).
-- As funções abaixo são as das migrações 20261212090000 e 20261214090000
-- com essas listas maiores; quem as redefinir depois mantém os valores.

alter table public.ai_powers drop constraint ai_powers_power_check;
alter table public.ai_powers add constraint ai_powers_power_check
 check (power in ('visuals', 'images', 'actions', 'skills', 'canvas', 'web'));
alter table public.ai_tool_calls drop constraint ai_tool_calls_power_check;
alter table public.ai_tool_calls add constraint ai_tool_calls_power_check
 check (power in ('visuals', 'images', 'actions', 'skills', 'canvas', 'web'));

create or replace function public.ai_my_powers(p_company uuid) returns text[]
language sql stable security definer set search_path = '' as $$
 select coalesce(array_agg(p order by p), '{}') from unnest(array['actions', 'canvas', 'images', 'skills', 'visuals', 'web']) p
 where mavi_private.member(p_company) and mavi_private.ai_power_on(p_company, auth.uid(), p)
$$;

create or replace function public.ai_powers_admin(p_company uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$ begin
 if not mavi_private.leader(p_company) then
  raise exception 'Só administradores e gestores configuram os poderes da MAVI.' using errcode = '42501';
 end if;
 return (select coalesce(jsonb_agg(jsonb_build_object('power', p.power,
   'enabled', coalesce(w.enabled, false), 'everyone', coalesce(w.everyone, true),
   'team_ids', to_jsonb(coalesce(w.team_ids, '{}')), 'user_ids', to_jsonb(coalesce(w.user_ids, '{}')),
   'except_ids', to_jsonb(coalesce(w.except_ids, '{}')), 'updated_at', w.updated_at, 'updated_by', w.updated_by)
   order by p.ord), '[]')
  from unnest(array['visuals', 'images', 'actions', 'canvas', 'web', 'skills']) with ordinality p(power, ord)
  left join public.ai_powers w on w.company_id = p_company and w.power = p.power);
end $$;

create or replace function public.ai_set_power(p_company uuid, p_power text, p_enabled boolean, p_everyone boolean,
 p_teams uuid[], p_users uuid[], p_except uuid[]) returns void
language plpgsql security definer set search_path = '' as $$
declare v_teams uuid[]; v_users uuid[]; v_except uuid[]; begin
 if not mavi_private.leader(p_company) then
  raise exception 'Só administradores e gestores configuram os poderes da MAVI.' using errcode = '42501';
 end if;
 if p_power not in ('visuals', 'images', 'actions', 'skills', 'canvas', 'web') then
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

create or replace function public.ai_log_tool_calls(p_company uuid, p_conversation uuid, p_module text, p_calls jsonb)
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
 insert into public.ai_tool_calls(company_id, conversation_id, module, tool, power, ok, duration_ms, cost_usd, error,
  skill_id, skill_version)
 select p_company, v_conversation, left(coalesce(p_module, 'assistant'), 40), left(x.tool, 80),
  case when x.power in ('visuals', 'images', 'actions', 'skills', 'canvas', 'web') then x.power end, coalesce(x.ok, false),
  least(greatest(coalesce(x.ms, 0), 0), 3600000), least(greatest(coalesce(x.cost, 0), 0), 100),
  left(x.error, 300),
  (select k.id from public.ai_skills k where k.company_id = p_company and k.id = x.skill),
  case when exists (select 1 from public.ai_skills k where k.company_id = p_company and k.id = x.skill)
   then x.skill_version end
 from jsonb_to_recordset(coalesce(p_calls, '[]')) as x(tool text, power text, ok boolean, ms integer, cost numeric,
  error text, skill uuid, skill_version integer)
 where coalesce(btrim(x.tool), '') <> '';
end $$;

create or replace function mavi_private.ai_artifacts_ok(c uuid, p jsonb) returns boolean
language sql immutable set search_path = '' as $$
 select jsonb_typeof(coalesce(p, '[]')) = 'array' and jsonb_array_length(coalesce(p, '[]')) <= 12
  and not exists (select 1 from jsonb_array_elements(coalesce(p, '[]')) a
   where jsonb_typeof(a) <> 'object' or coalesce(a->>'id', '') !~ '^[A-Za-z0-9_-]{4,64}$'
    or coalesce(a->>'type', '') not in ('visual', 'image', 'action', 'canvas')
    or (a->>'type' = 'image' and coalesce(a->>'path', '') !~
     ('^ai-images/' || c::text || '/[0-9a-f-]{36}\.(png|webp|jpg)$')))
$$;

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
  if v_kind not in ('openai', 'google', 'xai', 'openrouter', 'custom') then
   raise exception 'As imagens usam a OpenAI, o Google, a xAI, o OpenRouter ou um endereço compatível.' using errcode = '22023';
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

commit;
