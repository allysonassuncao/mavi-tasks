begin;

-- Painel da MAVI › Quem usa qual modelo:
--
-- 1. Gestores também editam as regras (quem usa qual provedor e modelo, e os
--    modelos das animações do Mural). A biblioteca de provedores e as API
--    Keys continuam só com os administradores: gestores leem a lista (sem as
--    chaves) para escolher entre o que já está cadastrado.
-- 2. A transcrição de áudio vira duas funcionalidades da lista:
--    'whatsapp_transcribe' (áudios do Whatsapp) e 'task_audio_transcribe'
--    (áudios das tarefas). Só servem provedores que falam o endpoint de
--    transcrição da OpenAI (OpenAI, Groq, Mistral ou endereço próprio) e
--    modelos de transcrição (Whisper, *-transcribe, Voxtral). Elas não
--    herdam o padrão da empresa, que é um modelo de conversa: sem regra da
--    funcionalidade, vale o padrão do servidor (OPENAI_API_KEY).
--    Os modelos de transcrição (e de vetores) também não servem para as
--    funcionalidades de conversa.
-- Os vetores da MAVI (busca e RAG) aparecem no painel só para leitura:
-- trocar o modelo invalidaria o índice inteiro.

-- ------------------------------------------------------------ tipos de modelo
create function mavi_private.ai_transcribe_feature(p_feature text) returns boolean
language sql immutable set search_path = '' as $$
 select coalesce(p_feature, '') in ('whatsapp_transcribe', 'task_audio_transcribe')
$$;
create function mavi_private.ai_transcribe_model(p_model text) returns boolean
language sql immutable set search_path = '' as $$
 select coalesce(p_model, '') ~* '(whisper|transcri|voxtral)'
$$;
-- Vetores ou transcrição: não conversam.
create function mavi_private.ai_non_chat_model(p_model text) returns boolean
language sql immutable set search_path = '' as $$
 select mavi_private.ai_transcribe_model(p_model) or coalesce(p_model, '') ~* 'embed'
$$;
revoke all on function mavi_private.ai_transcribe_feature(text), mavi_private.ai_transcribe_model(text),
 mavi_private.ai_non_chat_model(text) from public, anon, authenticated;

alter table mavi_private.ai_routes drop constraint ai_routes_feature_check;
alter table mavi_private.ai_routes add constraint ai_routes_feature_check
 check ((scope_type = 'feature') = (feature is not null)
  and (feature is null or feature in ('assistant', 'meetings_history', 'meetings_ask', 'whatsapp_task',
   'social_leads_plan', 'social_leads_adjust', 'social_leads_briefing', 'social_leads_colors',
   'task_copilot', 'client_dossier', 'copilot_learning', 'notice_writer', 'notice_animation',
   'client_temperature', 'client_temperature_text', 'task_audio',
   'whatsapp_transcribe', 'task_audio_transcribe')));

-- ------------------------------------------------------------ biblioteca
-- Gestores leem a lista para escolher nas regras (a chave nunca sai daqui:
-- só a dica dos últimos caracteres, como para os administradores).
create or replace function public.ai_provider_list(p_company uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$ begin
 if not mavi_private.leader(p_company) then
  raise exception 'Só administradores e gestores veem os provedores da MAVI.' using errcode = '42501';
 end if;
 return jsonb_build_object(
  'providers', (select coalesce(jsonb_agg(jsonb_build_object('id', p.id, 'name', p.name, 'kind', p.kind,
     'base_url', p.base_url, 'key_hint', p.key_hint, 'models', p.models, 'active', p.active,
     'updated_at', p.updated_at, 'routes', (select count(*) from mavi_private.ai_routes r where r.provider_id = p.id))
    order by p.name), '[]') from mavi_private.ai_providers p where p.company_id = p_company),
  'routes', (select coalesce(jsonb_agg(jsonb_build_object('id', r.id, 'type', r.scope_type, 'scope_id', r.scope_id,
     'feature', r.feature, 'provider_id', r.provider_id, 'model', r.model, 'updated_at', r.updated_at)
    order by r.scope_type, r.updated_at), '[]') from mavi_private.ai_routes r where r.company_id = p_company));
end $$;

-- ------------------------------------------------------------ regras
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
  'whatsapp_transcribe', 'task_audio_transcribe') then
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
 elsif mavi_private.ai_non_chat_model(p_model) then
  raise exception 'Este modelo só transcreve ou gera vetores: escolha um modelo de conversa.' using errcode = '22023';
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

-- Qual IA responde (como antes); a transcrição só pela regra dela.
create or replace function public.ai_resolve_route(p_company uuid, p_client uuid, p_contract uuid, p_project uuid,
 p_feature text default null) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_contract uuid := p_contract; v_client uuid := p_client; v_feature text := coalesce(p_feature, 'assistant');
 v_talk boolean; v_own boolean; r record; begin
 if not mavi_private.member(p_company) then raise exception 'Sem acesso ao espaço' using errcode = '42501'; end if;
 v_talk := v_feature in ('assistant', 'meetings_history', 'meetings_ask');
 v_own := mavi_private.ai_transcribe_feature(v_feature);
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

create or replace function public.ai_worker_route(p_secret text, p_company uuid, p_feature text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare r record; begin
 if not mavi_private.ai_secret_ok(p_secret) then raise exception 'Sem permissão' using errcode = '42501'; end if;
 select rt.scope_type, rt.model, p.id, p.name, p.kind, p.base_url, p.key_cipher, p.models into r
 from mavi_private.ai_routes rt join mavi_private.ai_providers p on p.id = rt.provider_id and p.active
 where rt.company_id = p_company and ((rt.scope_type = 'feature' and rt.feature = p_feature)
  or (rt.scope_type = 'company' and not mavi_private.ai_transcribe_feature(p_feature)))
 order by case rt.scope_type when 'feature' then 1 else 2 end
 limit 1;
 if not found then return null; end if;
 return jsonb_build_object('scope', r.scope_type, 'provider_id', r.id, 'provider', r.name, 'kind', r.kind,
  'base_url', r.base_url, 'key_cipher', r.key_cipher, 'model', r.model,
  'price', (select m from jsonb_array_elements(r.models) m where m->>'id' = r.model limit 1));
end $$;

-- A coleta do Whatsapp (segredo do worker, sem pessoa logada) pergunta quem
-- transcreve os áudios da empresa dela. Nulo: o padrão do servidor.
create function public.whatsapp_transcribe_route(p_secret text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare c uuid := mavi_private.whatsapp_company(p_secret); r record; begin
 if c is null then raise exception 'Não autorizado' using errcode = '42501'; end if;
 select rt.model, p.id, p.name, p.kind, p.base_url, p.key_cipher, p.models into r
 from mavi_private.ai_routes rt join mavi_private.ai_providers p on p.id = rt.provider_id and p.active
 where rt.company_id = c and rt.scope_type = 'feature' and rt.feature = 'whatsapp_transcribe'
 limit 1;
 if not found then return null; end if;
 return jsonb_build_object('scope', 'feature', 'provider_id', r.id, 'provider', r.name, 'kind', r.kind,
  'base_url', r.base_url, 'key_cipher', r.key_cipher, 'model', r.model,
  'price', (select m from jsonb_array_elements(r.models) m where m->>'id' = r.model limit 1));
end $$;
revoke all on function public.whatsapp_transcribe_route(text) from public;
grant execute on function public.whatsapp_transcribe_route(text) to anon, authenticated;

-- ------------------------------------------------------------ animações do Mural
create or replace function public.notice_animation_admin(p_company uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$ begin
 if not mavi_private.leader(p_company) then raise exception 'Sem permissão' using errcode = '42501'; end if;
 return jsonb_build_object(
  'knowledge', coalesce((select knowledge from public.notice_animation_settings where company_id = p_company), true),
  'models', coalesce((select jsonb_agg(jsonb_build_object('provider_id', m.provider_id, 'model', m.model,
    'user_ids', to_jsonb(m.user_ids), 'team_ids', to_jsonb(m.team_ids)) order by m.position)
   from public.notice_animation_models m where m.company_id = p_company), '[]'));
end $$;

create or replace function public.set_notice_animation_admin(p_company uuid, p_knowledge boolean, p_models jsonb) returns void
language plpgsql security definer set search_path = '' as $$
declare x jsonb; i integer := 0; v_provider uuid; v_model text; begin
 if not mavi_private.leader(p_company) then
  raise exception 'Só administradores e gestores escolhem os modelos das animações.' using errcode = '42501';
 end if;
 if jsonb_typeof(coalesce(p_models, '[]')) <> 'array' or jsonb_array_length(coalesce(p_models, '[]')) > 20 then
  raise exception 'Lista de modelos inválida' using errcode = '22023';
 end if;
 insert into public.notice_animation_settings(company_id, knowledge, updated_by)
 values (p_company, coalesce(p_knowledge, true), auth.uid())
 on conflict (company_id) do update set knowledge = excluded.knowledge, updated_at = now(), updated_by = auth.uid();
 delete from public.notice_animation_models where company_id = p_company;
 for x in select * from jsonb_array_elements(coalesce(p_models, '[]')) loop
  v_provider := nullif(x->>'provider_id', '')::uuid;
  v_model := x->>'model';
  if not exists (select 1 from mavi_private.ai_providers p where p.id = v_provider and p.company_id = p_company
    and exists (select 1 from jsonb_array_elements(p.models) m where m->>'id' = v_model)) then
   raise exception 'Escolha um modelo cadastrado no provedor.' using errcode = '22023';
  end if;
  insert into public.notice_animation_models(company_id, provider_id, model, user_ids, team_ids, position)
  values (p_company, v_provider, v_model,
   coalesce((select array_agg(distinct u::uuid) from jsonb_array_elements_text(coalesce(x->'user_ids', '[]')) u
    where exists (select 1 from public.memberships mm where mm.company_id = p_company and mm.user_id = u::uuid)), '{}'),
   coalesce((select array_agg(distinct t::uuid) from jsonb_array_elements_text(coalesce(x->'team_ids', '[]')) t
    where exists (select 1 from public.teams tt where tt.company_id = p_company and tt.id = t::uuid)), '{}'),
   i)
  on conflict (company_id, provider_id, model) do nothing;
  i := i + 1;
 end loop;
end $$;

commit;
