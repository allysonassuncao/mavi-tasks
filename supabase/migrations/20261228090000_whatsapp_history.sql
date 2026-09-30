begin;

-- Whatsapp › Perguntar ao histórico.
--
-- Como nas Gravações da MAVI, a pasta Whatsapp do cliente ganha uma conversa
-- com a MAVI sobre todas as mensagens dos grupos dele (o que já está na busca,
-- tipo 'whatsapp'). "Quem usa qual modelo" ganha a funcionalidade
-- 'whatsapp_history', que é de conversa (vale a regra por pessoa, cliente,
-- produto e projeto) e tem esforço para escolher. Sem regra, usa o padrão da
-- empresa. O custo entra em ai_usage no módulo 'whatsapp'.
-- ai_set_route é a da migração 20261227090000, ai_resolve_route a da
-- 20261217090000 e ai_set_effort a da 20261223090000, com a funcionalidade nova.

alter table mavi_private.ai_routes drop constraint ai_routes_feature_check;
alter table mavi_private.ai_routes add constraint ai_routes_feature_check
 check ((scope_type = 'feature') = (feature is not null)
  and (feature is null or feature in ('assistant', 'meetings_history', 'meetings_ask',
   'whatsapp_task', 'social_leads_plan', 'social_leads_adjust', 'social_leads_briefing', 'social_leads_colors',
   'task_copilot', 'client_dossier', 'copilot_learning', 'notice_writer', 'notice_animation',
   'client_temperature', 'client_temperature_text', 'task_audio',
   'whatsapp_transcribe', 'task_audio_transcribe', 'image_generation', 'mavi_page', 'web_search', 'canvas_writer',
   'mavi_rerank', 'conversation_summary', 'skill_coach', 'whatsapp_history')));

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
  'mavi_rerank', 'conversation_summary', 'skill_coach', 'whatsapp_history') then
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
  or p_type = 'project' and not exists (select 1 from public.projects where company_id = p_company and id = p_id)
  or p_type = 'skill' and not exists (select 1 from public.ai_skills where company_id = p_company and id = p_id) then
  raise exception 'Não encontrado na empresa.' using errcode = 'P0002';
 end if;
 insert into mavi_private.ai_routes(company_id, scope_type, scope_id, feature, provider_id, model)
 values (p_company, p_type, v_id, v_feature, p_provider, p_model)
 on conflict on constraint ai_routes_scope_key do update set provider_id = excluded.provider_id,
  model = excluded.model, updated_by = auth.uid(), updated_at = now();
end $$;

create or replace function public.ai_resolve_route(p_company uuid, p_client uuid, p_contract uuid, p_project uuid,
 p_feature text default null) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_contract uuid := p_contract; v_client uuid := p_client; v_feature text := coalesce(p_feature, 'assistant');
 v_talk boolean; v_own boolean; r record; begin
 if not mavi_private.member(p_company) then raise exception 'Sem acesso ao espaço' using errcode = '42501'; end if;
 v_talk := v_feature in ('assistant', 'mavi_page', 'meetings_history', 'meetings_ask', 'whatsapp_history');
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
   or (rt.scope_type = 'feature' and (rt.feature = v_feature
    -- O módulo MAVI sem regra própria segue a da bolinha.
    or (v_feature = 'mavi_page' and rt.feature = 'assistant')))
   or (rt.scope_type = 'company' and not v_own))
 order by case rt.scope_type when 'project' then 1 when 'contract' then 2 when 'client' then 3
  when 'user' then 4 when 'feature' then 5 else 6 end,
  case when rt.feature = v_feature then 0 else 1 end
 limit 1;
 if not found then return null; end if;
 return jsonb_build_object('scope', r.scope_type, 'provider_id', r.id, 'provider', r.name, 'kind', r.kind,
  'base_url', r.base_url, 'key_cipher', r.key_cipher, 'model', r.model,
  'price', (select m from jsonb_array_elements(r.models) m where m->>'id' = r.model limit 1));
end $$;

create or replace function public.ai_set_effort(p_company uuid, p_key text, p_effort text) returns void
language plpgsql security definer set search_path = '' as $$
declare v_skill uuid; begin
 if not mavi_private.leader(p_company) then
  raise exception 'Só administradores e gestores escolhem o esforço da MAVI.' using errcode = '42501';
 end if;
 if p_key ~ '^skill:[0-9a-f-]{36}$' then
  v_skill := substr(p_key, 7)::uuid;
  if not exists (select 1 from public.ai_skills where company_id = p_company and id = v_skill) then
   raise exception 'Skill não encontrada.' using errcode = 'P0002';
  end if;
 elsif coalesce(p_key, '') not in ('assistant', 'mavi_page', 'meetings_history', 'whatsapp_history', 'canvas_writer',
  'web_search') then
  raise exception 'Esta funcionalidade não tem esforço para escolher.' using errcode = '22023';
 end if;
 if p_effort is null then
  delete from mavi_private.ai_efforts where company_id = p_company and key = p_key;
  return;
 end if;
 if p_effort not in ('low', 'medium', 'high', 'xhigh', 'max') then
  raise exception 'Esforço inválido.' using errcode = '22023';
 end if;
 insert into mavi_private.ai_efforts(company_id, key, effort) values (p_company, p_key, p_effort)
 on conflict (company_id, key) do update set effort = excluded.effort, updated_by = auth.uid(), updated_at = now();
end $$;

commit;
