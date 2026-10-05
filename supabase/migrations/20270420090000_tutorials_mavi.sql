begin;

-- Tutoriais, Fase 2: a MAVI conhece os tutoriais (pedido de 05/10/2026).
--
-- - Cérebro da MAVI: cada tutorial publicado vira um documento
--   (source_type 'tutorial'), um trecho por seção (os títulos de nível 2 e 3),
--   com a âncora da seção no meta. As âncoras seguem a mesma regra da tela
--   (headingAnchors/slugify em src/rich-text.ts). O acesso é 'tutorial': o
--   ai_search geral não devolve esses trechos; quem busca é
--   public.search_tutorials, que respeita o público de cada tutorial.
-- - Vídeos: os enviados são transcritos em segundo plano (worker
--   "tutorial-transcribe" de /api/ai, acordado por pg_net ao confirmar o
--   envio). Quem transcreve é a funcionalidade 'tutorial_transcribe' em
--   Quem usa qual modelo: os provedores com o endpoint da OpenAI (até 25 MB)
--   ou os que transcrevem pelo link do vídeo, sem esse limite (Deepgram,
--   AssemblyAI, novos na biblioteca). Sem regra, a OpenAI do servidor (até
--   25 MB). Quem edita corrige ou escreve a transcrição; nos vídeos de
--   YouTube, Loom e Vimeo ela vai no próprio texto (attrs.transcript).
-- - Busca da página: termos sem acento + significado (vetor), com resposta
--   curta da MAVI ('tutorial_search' em Quem usa qual modelo).
-- - Dúvidas sem tutorial: a busca sem resultado e a MAVI (quando não acha
--   tutorial para uma dúvida de uso) registram a pergunta; administradores e
--   gestores veem, criam o tutorial ou dispensam.

-- ------------------------------------------------------------ provedores que transcrevem pelo link
alter table mavi_private.ai_providers drop constraint if exists ai_providers_kind_check;
alter table mavi_private.ai_providers add constraint ai_providers_kind_check
 check (kind in ('anthropic', 'openai', 'google', 'openrouter', 'groq', 'deepseek', 'mistral', 'xai', 'custom',
  'deepgram', 'assemblyai'));

-- A da migração 20261025090000, com Deepgram e AssemblyAI.
create or replace function public.ai_save_provider(p_company uuid, p_id uuid, p_name text, p_kind text, p_base_url text,
 p_models jsonb, p_key_cipher text, p_key_hint text, p_active boolean) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_id uuid; v_models jsonb; begin
 if not mavi_private.admin(p_company) then
  raise exception 'Só administradores configuram os provedores de IA.' using errcode = '42501';
 end if;
 if p_kind not in ('anthropic', 'openai', 'google', 'openrouter', 'groq', 'deepseek', 'mistral', 'xai', 'custom',
  'deepgram', 'assemblyai') then
  raise exception 'Provedor inválido.' using errcode = '22023';
 end if;
 if p_kind = 'custom' and coalesce(p_base_url, '') = '' then
  raise exception 'Informe o endereço da API.' using errcode = '22023';
 end if;
 if p_key_cipher is not null and p_key_cipher !~ '^v1:' then raise exception 'Chave inválida.' using errcode = '22023'; end if;
 if length(btrim(coalesce(p_name, ''))) not between 1 and 80 then
  raise exception 'Dê um nome de até 80 caracteres ao provedor.' using errcode = '22023';
 end if;
 v_models := mavi_private.ai_clean_models(p_models);
 if p_id is null then
  if p_key_cipher is null then raise exception 'Informe a API Key.' using errcode = '22023'; end if;
  insert into mavi_private.ai_providers(company_id, name, kind, base_url, key_cipher, key_hint, models, active)
  values (p_company, btrim(p_name), p_kind, nullif(p_base_url, ''), p_key_cipher, left(coalesce(p_key_hint, ''), 8),
   v_models, coalesce(p_active, true))
  returning id into v_id;
 else
  update mavi_private.ai_providers set name = btrim(p_name), kind = p_kind, base_url = nullif(p_base_url, ''),
   key_cipher = coalesce(p_key_cipher, key_cipher),
   key_hint = case when p_key_cipher is null then key_hint else left(coalesce(p_key_hint, ''), 8) end,
   models = v_models, active = coalesce(p_active, active), updated_by = auth.uid(), updated_at = now()
  where id = p_id and company_id = p_company returning id into v_id;
  if v_id is null then raise exception 'Provedor não encontrado.' using errcode = 'P0002'; end if;
  -- Regras de modelos que saíram da lista deixam de valer.
  delete from mavi_private.ai_routes r where r.provider_id = v_id
   and not exists (select 1 from jsonb_array_elements(v_models) m where m->>'id' = r.model);
 end if;
 return v_id;
exception when unique_violation then
 raise exception 'Já existe um provedor com esse nome.' using errcode = '23505';
end $$;

-- ------------------------------------------------------------ Quem usa qual modelo
-- A da migração 20270328090000, com a transcrição dos vídeos dos tutoriais.
create or replace function mavi_private.ai_transcribe_feature(p_feature text) returns boolean
language sql immutable set search_path = '' as $$
 select coalesce(p_feature, '') in ('whatsapp_transcribe', 'task_audio_transcribe', 'campaign_creative_transcribe',
  'tutorial_transcribe')
$$;

-- A da migração 20270403170000, com os tutoriais.
alter table mavi_private.ai_routes drop constraint ai_routes_feature_check;
alter table mavi_private.ai_routes add constraint ai_routes_feature_check
 check ((scope_type = 'feature') = (feature is not null)
  and (feature is null or feature in ('assistant', 'meetings_history', 'meetings_ask',
   'whatsapp_task', 'social_leads_plan', 'social_leads_adjust', 'social_leads_briefing', 'social_leads_colors',
   'task_copilot', 'client_dossier', 'copilot_learning', 'notice_writer', 'notice_animation',
   'client_temperature', 'client_temperature_text', 'task_audio',
   'whatsapp_transcribe', 'task_audio_transcribe', 'image_generation', 'mavi_page', 'web_search', 'canvas_writer',
   'mavi_rerank', 'conversation_summary', 'skill_coach', 'whatsapp_history', 'client_radar', 'client_radar_check',
   'client_radar_themes', 'client_radar_report', 'mavi_learning', 'campaign_report', 'mavi_judge',
   'mavi_judge_check', 'task_title', 'dashboard_builder', 'campaign_alerts', 'task_search',
   'personal_radar', 'personal_assistant', 'personal_radar_check', 'social_media_schedule',
   'campaign_insights', 'campaign_insights_check', 'campaign_creative_image', 'campaign_creative_transcribe',
   'campaign_daily', 'tutorial_search', 'tutorial_transcribe')));

-- A da migração 20270403170000, com os tutoriais e os provedores que só transcrevem.
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
  'client_radar_themes', 'client_radar_report', 'mavi_learning', 'campaign_report', 'mavi_judge',
  'mavi_judge_check', 'task_title', 'dashboard_builder', 'campaign_alerts', 'task_search',
  'personal_radar', 'personal_assistant', 'personal_radar_check', 'social_media_schedule',
  'campaign_insights', 'campaign_insights_check', 'campaign_creative_image', 'campaign_creative_transcribe',
  'campaign_daily', 'tutorial_search', 'tutorial_transcribe') then
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
 -- Deepgram e AssemblyAI só transcrevem, e pelo link do arquivo: por enquanto, os vídeos dos tutoriais.
 if v_kind in ('deepgram', 'assemblyai') and coalesce(v_feature, '') <> 'tutorial_transcribe' then
  raise exception 'Este provedor só transcreve os vídeos dos tutoriais (Tutoriais: transcrição dos vídeos).'
   using errcode = '22023';
 end if;
 -- Transcrição: o endpoint de transcrição da OpenAI e um modelo que transcreve.
 if mavi_private.ai_transcribe_feature(v_feature) then
  if v_kind not in ('openai', 'groq', 'mistral', 'custom', 'deepgram', 'assemblyai') then
   raise exception 'A transcrição usa a OpenAI, o Groq, a Mistral ou um endereço compatível (nos tutoriais, também Deepgram e AssemblyAI).'
    using errcode = '22023';
  end if;
  if v_kind not in ('deepgram', 'assemblyai') and not mavi_private.ai_transcribe_model(p_model) then
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
 -- O termômetro e as conferências leem com o Jev pelo OpenRouter; o Jev não conversa.
 if mavi_private.ai_decision_feature(v_feature) and not (v_kind = 'openrouter' and mavi_private.jev_model(p_model)) then
  raise exception 'Esta funcionalidade usa o Jev (TypeSafe) pelo OpenRouter: escolha o modelo do Jev.'
   using errcode = '22023';
 end if;
 if not mavi_private.ai_decision_feature(v_feature) and mavi_private.jev_model(p_model) then
  raise exception 'O Jev só responde a perguntas de decisão: use-o no termômetro, nas conferências (Radar, insights das campanhas) ou na autoavaliação da MAVI.'
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
revoke all on function public.ai_set_route(uuid, text, uuid, uuid, text, text) from public, anon;
grant execute on function public.ai_set_route(uuid, text, uuid, uuid, text, text) to authenticated;

-- ------------------------------------------------------------ transcrição dos vídeos
alter table public.tutorial_media
 add column duration_seconds integer check (duration_seconds is null or duration_seconds between 0 and 86400),
 add column transcript text check (length(transcript) <= 400000),
 -- pending: na fila; working: com o worker (job: o pedido no provedor que
 -- ainda processa); ready; failed (erro); skipped (grande demais para o
 -- provedor escolhido: quem edita escreve).
 add column transcript_status text not null default 'pending'
  check (transcript_status in ('pending', 'working', 'ready', 'failed', 'skipped')),
 add column transcript_source text check (transcript_source in ('auto', 'manual')),
 add column transcript_error text check (length(transcript_error) <= 500),
 add column transcript_job text check (length(transcript_job) <= 200),
 add column transcript_rounds integer not null default 0,
 add column transcript_claimed_at timestamptz,
 add column transcribed_at timestamptz;
create index tutorial_media_transcribe on public.tutorial_media(transcript_status, transcript_claimed_at)
 where status = 'ready' and transcript_status in ('pending', 'working');

-- Acorda o worker (sem fila nem consulta periódica: só quando há o que fazer).
create function mavi_private.tutorial_transcribe_kick() returns void
language plpgsql security definer set search_path = '' as $$
declare cfg record; begin
 select url, secret into cfg from mavi_private.ai_config limit 1;
 if cfg.url is null or cfg.secret is null then return; end if;
 perform net.http_post(url := cfg.url, body := '{"action":"tutorial-transcribe"}'::jsonb,
  headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || cfg.secret),
  timeout_milliseconds := 5000);
exception when others then
 raise warning 'tutorial transcribe kick failed: %', sqlerrm;
end $$;
revoke all on function mavi_private.tutorial_transcribe_kick() from public, anon, authenticated;

-- A da migração 20270415090000, com a duração (o custo da transcrição).
drop function public.confirm_tutorial_media(uuid);
create function public.confirm_tutorial_media(p_media uuid, p_duration integer default null) returns void
language plpgsql security definer set search_path = '' as $$ begin
 update public.tutorial_media set status = 'ready', transcript_status = 'pending',
  duration_seconds = case when p_duration between 0 and 86400 then p_duration end
 where id = p_media and created_by = auth.uid() and status = 'uploading';
 if not found then raise exception 'Vídeo não encontrado' using errcode = '42501'; end if;
 perform mavi_private.tutorial_transcribe_kick();
end $$;

-- Os vídeos que já estavam no ar entram na fila.
update public.tutorial_media set transcript_status = 'pending' where status = 'ready';

create function mavi_private.tutorial_media_editable(p_media uuid) returns public.tutorial_media
language plpgsql stable security definer set search_path = '' as $$
declare m public.tutorial_media; t public.tutorials; begin
 select * into m from public.tutorial_media where id = p_media;
 if not found then raise exception 'Vídeo não encontrado' using errcode = 'P0002'; end if;
 select * into t from public.tutorials where company_id = m.company_id and id = m.tutorial_id;
 if not mavi_private.tutorial_can_edit(t) then raise exception 'Sem permissão' using errcode = '42501'; end if;
 return m;
end $$;
revoke all on function mavi_private.tutorial_media_editable(uuid) from public, anon, authenticated;

-- Quem edita escreve ou corrige a transcrição (vazia: volta para a fila).
create function public.set_tutorial_media_transcript(p_media uuid, p_text text) returns void
language plpgsql security definer set search_path = '' as $$
declare m public.tutorial_media := mavi_private.tutorial_media_editable(p_media); v text; begin
 v := btrim(coalesce(p_text, ''));
 if length(v) > 400000 then raise exception 'A transcrição pode ter até 400 mil caracteres.' using errcode = '22023'; end if;
 if v = '' then
  update public.tutorial_media set transcript = null, transcript_source = null, transcript_status = 'pending',
   transcript_error = null, transcript_job = null, transcript_rounds = 0, transcript_claimed_at = null
  where id = m.id;
  perform mavi_private.tutorial_transcribe_kick();
  return;
 end if;
 update public.tutorial_media set transcript = v, transcript_source = 'manual', transcript_status = 'ready',
  transcript_error = null, transcript_job = null, transcribed_at = now()
 where id = m.id;
end $$;

-- Transcrever de novo (depois de trocar o provedor, por exemplo).
create function public.retry_tutorial_media_transcript(p_media uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare m public.tutorial_media := mavi_private.tutorial_media_editable(p_media); begin
 if m.status <> 'ready' then raise exception 'O vídeo ainda está sendo enviado.' using errcode = '22023'; end if;
 if m.transcript_status = 'working' and m.transcript_claimed_at > now() - interval '10 minutes' then
  raise exception 'A transcrição já está em andamento.' using errcode = '22023';
 end if;
 update public.tutorial_media set transcript_status = 'pending', transcript_error = null, transcript_job = null,
  transcript_rounds = 0, transcript_claimed_at = null
 where id = m.id;
 perform mavi_private.tutorial_transcribe_kick();
end $$;

-- O worker pega até p_limit vídeos (os que esperam e os que ficaram parados).
create function public.tutorial_transcribe_claim(p_secret text, p_limit integer default 3)
returns table(id uuid, company_id uuid, tutorial_id uuid, path text, name text, content_type text, size_bytes bigint,
 duration_seconds integer, job text, created_by uuid)
language plpgsql security definer set search_path = '' as $$ begin
 if not mavi_private.ai_secret_ok(p_secret) then raise exception 'Sem permissão' using errcode = '42501'; end if;
 return query
 with picked as (
  select m.id from public.tutorial_media m
  where m.status = 'ready' and (m.transcript_status = 'pending'
   or (m.transcript_status = 'working' and m.transcript_claimed_at < now() - interval '10 minutes'))
  order by m.created_at
  limit least(greatest(coalesce(p_limit, 3), 1), 10)
  for update skip locked)
 update public.tutorial_media m set transcript_status = 'working', transcript_claimed_at = now(),
  transcript_rounds = m.transcript_rounds + 1
 from picked where m.id = picked.id
 returning m.id, m.company_id, m.tutorial_id, m.path, m.name, m.content_type, m.size_bytes, m.duration_seconds,
  m.transcript_job, m.created_by;
end $$;

-- O resultado do worker. p_job sem texto: o provedor ainda processa (o
-- vídeo volta para a fila e o worker é acordado de novo). p_skipped: grande
-- demais para o provedor. O custo vai para o consumo da MAVI.
create function public.tutorial_transcribe_save(p_secret text, p_media uuid, p_transcript text, p_error text,
 p_skipped boolean default false, p_job text default null, p_model text default null, p_cost numeric default 0,
 p_provider uuid default null, p_duration integer default null) returns void
language plpgsql security definer set search_path = '' as $$
declare m public.tutorial_media; begin
 if not mavi_private.ai_secret_ok(p_secret) then raise exception 'Sem permissão' using errcode = '42501'; end if;
 select * into m from public.tutorial_media where id = p_media for update;
 if not found then return; end if;
 -- Quem edita escreveu a transcrição enquanto o worker trabalhava: vale a dela.
 if m.transcript_source = 'manual' and m.transcript_status = 'ready' then return; end if;
 if nullif(btrim(coalesce(p_transcript, '')), '') is not null then
  update public.tutorial_media set transcript = left(btrim(p_transcript), 400000), transcript_source = 'auto',
   transcript_status = 'ready', transcript_error = null, transcript_job = null, transcribed_at = now(),
   duration_seconds = coalesce(case when p_duration between 0 and 86400 then p_duration end, duration_seconds)
  where id = m.id;
 elsif p_job is not null and m.transcript_rounds < 30 then
  update public.tutorial_media set transcript_status = 'pending', transcript_job = left(p_job, 200),
   transcript_claimed_at = null
  where id = m.id;
 else
  update public.tutorial_media set transcript_status = case when p_skipped then 'skipped' else 'failed' end,
   transcript_error = left(coalesce(nullif(btrim(p_error), ''),
    case when p_job is not null then 'O provedor demorou demais para transcrever.' else 'Não foi possível transcrever.' end), 500),
   transcript_job = null
  where id = m.id;
 end if;
 if coalesce(p_cost, 0) > 0 and p_cost <= 100 then
  insert into public.ai_usage(company_id, user_id, module, kind, model, cost_usd, provider_id, provider_name)
  values (m.company_id, m.created_by, 'tutorials', 'tutorial_transcribe', left(coalesce(p_model, ''), 80), p_cost,
   p_provider, coalesce((select p.name from mavi_private.ai_providers p where p.id = p_provider), ''));
 end if;
 if exists (select 1 from public.tutorial_media x where x.status = 'ready' and x.transcript_status = 'pending') then
  perform mavi_private.tutorial_transcribe_kick();
 end if;
end $$;

-- ------------------------------------------------------------ cérebro da MAVI
alter table public.ai_documents drop constraint ai_documents_source_type_check;
alter table public.ai_documents add constraint ai_documents_source_type_check
 check (source_type in ('meeting', 'task', 'drive_file', 'social_plan', 'social_briefing', 'campaign', 'success_case',
  'whatsapp', 'ai_attachment', 'client_note', 'agent_prompt', 'tutorial'));
alter table public.ai_documents drop constraint ai_documents_access_check;
alter table public.ai_documents add constraint ai_documents_access_check
 check (access in ('client', 'task', 'contract', 'leader', 'private', 'tutorial'));

-- O nome de cada módulo (o mesmo de TUTORIAL_MODULES em src/tutorials.ts).
create function mavi_private.tutorial_module_label(p text) returns text
language sql immutable set search_path = '' as $$
 select case p
  when 'overview' then 'Visão geral' when 'notices' then 'Mural de avisos' when 'tasks' then 'Tarefas'
  when 'agenda' then 'Agenda' when 'campaigns' then 'Campanhas' when 'financeMedia' then 'Financeiro › Mídia'
  when 'onboarding' then 'Planejamento › Social Leads' when 'socialMedia' then 'Planejamento › Social Media'
  when 'cases' then 'Cases de Sucesso' when 'temperature' then 'Termômetro dos clientes'
  when 'radar' then 'Radar do cliente' when 'personalRadar' then 'Radar pessoal'
  when 'agents' then 'Agente Conversacional' when 'drive' then 'Drive' when 'reports' then 'Relatórios'
  when 'dashboards' then 'Dashboards' when 'clients' then 'Clientes' when 'products' then 'Produtos'
  when 'projects' then 'Projetos' when 'hours' then 'Controle de horas' when 'storage' then 'Armazenamento'
  when 'aiUsage' then 'Painel da MAVI' when 'assistant' then 'MAVI' when 'inbox' then 'Caixa de entrada'
  when 'profile' then 'Meu perfil' when 'settings' then 'Equipe e configurações' else p end
$$;

-- A âncora de um título (a mesma de slugify em src/rich-text.ts).
create function mavi_private.tutorial_slug(p text) returns text
language sql immutable set search_path = '' as $$
 select coalesce(nullif(left(regexp_replace(regexp_replace(mavi_private.fold(p), '[^a-z0-9]+', '-', 'g'),
  '^-+|-+$', '', 'g'), 60), ''), 'secao')
$$;

-- O texto de um bloco do texto rico: cada parágrafo/título numa linha, os
-- pedaços de um mesmo parágrafo colados (negrito no meio da palavra).
create function mavi_private.tutorial_block_text(p_node jsonb) returns text
language sql immutable set search_path = '' as $$
 select coalesce(string_agg(t.line, E'\n' order by t.n), '')
 from (
  select b.n, (select string_agg(coalesce(x.node->>'text', '@' || coalesce(x.node->'attrs'->>'label', '')), '' order by x.k)
    from jsonb_array_elements(coalesce(b.node->'content', '[]')) with ordinality as x(node, k)
    where x.node->>'type' in ('text', 'mention')) as line
  from jsonb_path_query(p_node, 'strict $.** ? (@.type == "paragraph" || @.type == "heading")')
   with ordinality as b(node, n)) t
 where nullif(btrim(t.line), '') is not null
$$;

create function mavi_private.tutorial_index(p_tutorial uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare r public.tutorials; v_doc jsonb; node jsonb; v_header text; v_title text; v_anchor text; v_label text;
 v_text text; v_buf text := ''; v_counts jsonb := '{}'; v_n integer; v_pieces jsonb := '[]'; piece text;
 v_media public.tutorial_media; v_sections jsonb := '[]'; s jsonb; begin
 select * into r from public.tutorials where id = p_tutorial;
 if not found or r.status <> 'published' then perform mavi_private.ai_forget('tutorial', p_tutorial); return; end if;
 if left(r.body, 17) = 'mavi:richtext:v1:' then
  begin
   v_doc := substr(r.body, 18)::jsonb;
  exception when others then v_doc := null;
  end;
 end if;
 v_header := concat_ws(' · ', format('[Tutorial] "%s"', r.title),
  case when r.category <> '' then 'categoria ' || r.category end,
  case when cardinality(r.modules) > 0 then 'módulos ' ||
   (select string_agg(mavi_private.tutorial_module_label(m), ', ') from unnest(r.modules) m) end,
  case when cardinality(r.tags) > 0 then 'tags ' || array_to_string(r.tags, ', ') end,
  'atualizado em ' || to_char(r.published_at at time zone 'America/Sao_Paulo', 'DD/MM/YYYY'));
 -- A introdução (resumo + o que vem antes do primeiro título) é a seção sem âncora.
 v_buf := r.summary;
 v_title := '';
 v_anchor := '';
 if v_doc is null then
  v_buf := concat_ws(E'\n\n', nullif(v_buf, ''), mavi_private.rich_plain(r.body));
 else
  for node in select value from jsonb_array_elements(coalesce(v_doc->'content', '[]')) loop
   if node->>'type' = 'heading' then
    v_label := regexp_replace(coalesce((select string_agg(x->>'text', '' order by k)
     from jsonb_array_elements(coalesce(node->'content', '[]')) with ordinality as e(x, k)
     where x->>'type' = 'text'), ''), '^\s+|\s+$', '', 'g');
    if v_label <> '' then
     v_sections := v_sections || jsonb_build_array(jsonb_build_object('anchor', v_anchor, 'title', v_title, 'text', v_buf));
     v_text := mavi_private.tutorial_slug(v_label);
     v_n := coalesce((v_counts->>v_text)::integer, 0) + 1;
     v_counts := v_counts || jsonb_build_object(v_text, v_n);
     v_anchor := case when v_n > 1 then v_text || '-' || v_n else v_text end;
     v_title := v_label;
     v_buf := '';
     continue;
    end if;
   end if;
   if node->>'type' = 'tutorialVideo' then
    v_text := '[Vídeo' || coalesce(': ' || nullif(node->'attrs'->>'label', ''), '') || ']';
    if coalesce(node->'attrs'->>'mediaId', '') <> '' then
     v_media := null;
     select * into v_media from public.tutorial_media
     where company_id = r.company_id and tutorial_id = r.id and id::text = node->'attrs'->>'mediaId';
     if v_media.transcript_status = 'ready' and coalesce(v_media.transcript, '') <> '' then
      v_text := v_text || E'\nTranscrição do vídeo: ' || v_media.transcript;
     end if;
    elsif coalesce(node->'attrs'->>'transcript', '') <> '' then
     v_text := v_text || E'\nTranscrição do vídeo: ' || (node->'attrs'->>'transcript');
    end if;
   else
    v_text := mavi_private.tutorial_block_text(node);
   end if;
   if coalesce(v_text, '') <> '' then v_buf := concat_ws(E'\n', nullif(v_buf, ''), v_text); end if;
  end loop;
 end if;
 v_sections := v_sections || jsonb_build_array(jsonb_build_object('anchor', v_anchor, 'title', v_title, 'text', v_buf));
 for s in select value from jsonb_array_elements(v_sections) loop
  continue when coalesce(btrim(s->>'text'), '') = '' and coalesce(s->>'title', '') = '';
  for piece in select mavi_private.ai_split(concat_ws(E'\n',
    case when s->>'title' <> '' then 'Seção: ' || (s->>'title') end, nullif(s->>'text', ''))) loop
   v_pieces := v_pieces || jsonb_build_array(jsonb_build_object('text', piece, 'meta',
    jsonb_build_object('kind', 'tutorial', 'anchor', s->>'anchor', 'section', s->>'title')));
  end loop;
 end loop;
 if jsonb_array_length(v_pieces) = 0 then
  v_pieces := jsonb_build_array(jsonb_build_object('text', r.title, 'meta',
   jsonb_build_object('kind', 'tutorial', 'anchor', '', 'section', '')));
 end if;
 perform mavi_private.ai_save_document(r.company_id, 'tutorial', r.id, 'tutorial', null, null, null, null,
  r.title, r.published_at, v_header, v_pieces);
end $$;

create function mavi_private.tutorial_index_trigger() returns trigger
language plpgsql security definer set search_path = '' as $$ begin
 if tg_table_name = 'tutorials' then
  if tg_op = 'DELETE' then perform mavi_private.ai_forget('tutorial', old.id); return null; end if;
  perform mavi_private.tutorial_index(new.id);
 else
  if tg_op = 'DELETE' then return null; end if;
  perform mavi_private.tutorial_index(new.tutorial_id);
 end if;
 return null;
end $$;
revoke all on function mavi_private.tutorial_module_label(text), mavi_private.tutorial_slug(text),
 mavi_private.tutorial_block_text(jsonb), mavi_private.tutorial_index(uuid), mavi_private.tutorial_index_trigger()
 from public, anon, authenticated;
create trigger tutorial_index after insert or delete or update of title, summary, body, modules, category, tags,
 status, published_at on public.tutorials
 for each row execute function mavi_private.tutorial_index_trigger();
create trigger tutorial_media_index after update of transcript, transcript_status on public.tutorial_media
 for each row when (old.transcript is distinct from new.transcript or old.transcript_status is distinct from new.transcript_status)
 execute function mavi_private.tutorial_index_trigger();
-- O editor vê o andamento da transcrição ao vivo.
create trigger broadcast_tutorial_media after update of transcript, transcript_status on public.tutorial_media
 for each row when (old.transcript is distinct from new.transcript or old.transcript_status is distinct from new.transcript_status)
 execute function mavi_private.broadcast_tutorial();

-- Os tutoriais já publicados entram no cérebro.
select mavi_private.tutorial_index(t.id) from public.tutorials t where t.status = 'published';

-- ------------------------------------------------------------ busca
-- As seções que respondem à pergunta, entre os tutoriais publicados que a
-- pessoa vê: palavras sem acento (todas as palavras de 3 letras ou mais,
-- contadas) + significado (vetor), fundidos por posição. p_module: só os
-- tutoriais do módulo (p_strict) ou os dele primeiro (a tela da pessoa).
create function public.search_tutorials(p_company uuid, p_query text, p_embedding text default null,
 p_module text default null, p_strict boolean default false, p_category text default null, p_tags text[] default null,
 p_limit integer default 20)
returns table(chunk_id bigint, tutorial_id uuid, title text, summary text, modules text[], category text,
 anchor text, section text, content text, score double precision, similarity double precision, words integer)
language plpgsql stable security definer set search_path = '' as $$
declare v_words text[]; v_vec extensions.halfvec(1536); v_tags text[]; v_cat text; begin
 if not mavi_private.member(p_company) then raise exception 'Sem acesso ao espaço' using errcode = '42501'; end if;
 v_words := array(select distinct w from unnest(regexp_split_to_array(
   mavi_private.fold(left(coalesce(p_query, ''), 300)), '[^a-z0-9]+')) w
  where length(w) >= 3 and w not in ('que', 'como', 'para', 'com', 'uma', 'por', 'dos', 'das', 'nos', 'nas', 'mais',
   'onde', 'qual', 'quais', 'quando', 'faco', 'fazer', 'sobre', 'tem', 'ter', 'meu', 'minha', 'seu', 'sua', 'isso',
   'esse', 'essa', 'este', 'esta', 'pra', 'pelo', 'pela', 'nao', 'sim', 'ser', 'sao', 'estou', 'posso', 'consigo'));
 begin
  v_vec := nullif(p_embedding, '')::extensions.halfvec(1536);
 exception when others then v_vec := null;
 end;
 v_tags := case when cardinality(p_tags) > 0 then array(select mavi_private.fold(x) from unnest(p_tags) x) end;
 v_cat := nullif(mavi_private.fold(btrim(coalesce(p_category, ''))), '');
 if cardinality(v_words) = 0 and v_vec is null then return; end if;
 return query
 with hits as (
  select c.id as chunk, t.id as tut,
   case when v_vec is not null and c.embedding is not null then 1 - (c.embedding operator(extensions.<=>) v_vec) end as sim,
   (select count(*)::integer from unnest(v_words) w where strpos(mavi_private.fold(c.content), w) > 0) as hits
  from public.ai_chunks c
  join public.ai_documents d on d.id = c.document_id
  join public.tutorials t on t.company_id = d.company_id and t.id = d.source_id
  where c.company_id = p_company and c.source_type = 'tutorial' and d.source_type = 'tutorial'
   and t.status = 'published' and mavi_private.tutorial_can_see(t)
   and (not coalesce(p_strict, false) or p_module is null or p_module = '' or p_module = any(t.modules))
   and (v_cat is null or mavi_private.fold(t.category) = v_cat)
   and (v_tags is null or exists (select 1 from unnest(t.tags) g where mavi_private.fold(g) = any(v_tags)))),
 best as (select max(h.sim) as top from hits h),
 ranked as (
  select h.*,
   case when h.hits > 0 then rank() over (order by h.hits desc, h.sim desc nulls last) end as text_rank,
   case when h.sim is not null and h.sim >= greatest(0.3, b.top - 0.15)
    then rank() over (order by h.sim desc nulls last) end as vec_rank
  from hits h cross join best b)
 select r.chunk, r.tut, t.title, t.summary, t.modules, t.category,
  coalesce(c.meta->>'anchor', ''), coalesce(c.meta->>'section', ''),
  regexp_replace(c.content, '^[^\n]*\n', ''),
  (coalesce(1.0 / (60 + r.text_rank), 0) + coalesce(1.0 / (60 + r.vec_rank), 0)
   -- Todas as palavras no trecho e o módulo da tela pesam a favor.
   + case when cardinality(v_words) > 1 and r.hits = cardinality(v_words) then 0.004 else 0 end
   + case when not coalesce(p_strict, false) and p_module is not null and p_module = any(t.modules) then 0.006 else 0 end
  )::double precision,
  r.sim, r.hits
 from ranked r
 join public.ai_chunks c on c.id = r.chunk
 join public.tutorials t on t.id = r.tut
 where r.text_rank is not null or r.vec_rank is not null
 order by 10 desc, r.chunk
 limit least(greatest(coalesce(p_limit, 20), 1), 40);
end $$;

-- ------------------------------------------------------------ dúvidas sem tutorial
create table public.tutorial_gaps (
 id uuid primary key default gen_random_uuid(),
 company_id uuid not null references public.companies(id),
 question text not null check (length(question) between 3 and 300),
 -- A pergunta sem acento, pontuação e espaços repetidos: a mesma dúvida soma.
 key text not null,
 source text not null check (source in ('search', 'mavi')),
 module text check (module ~ '^[a-zA-Z]{2,40}$'),
 asks integer not null default 1,
 askers uuid[] not null default '{}',
 status text not null default 'open' check (status in ('open', 'resolved', 'dismissed')),
 tutorial_id uuid,
 first_asked_at timestamptz not null default now(),
 last_asked_at timestamptz not null default now(),
 handled_by uuid,
 handled_at timestamptz,
 unique (company_id, key),
 foreign key (company_id, tutorial_id) references public.tutorials(company_id, id) on delete set null (tutorial_id)
);
create index tutorial_gaps_open on public.tutorial_gaps(company_id, status, last_asked_at desc);
alter table public.tutorial_gaps enable row level security;
revoke all on public.tutorial_gaps from public, anon, authenticated;

-- Registra (ou soma) uma dúvida sem tutorial. Uma resolvida que volta a ser
-- perguntada reabre (o tutorial não bastou); uma dispensada continua.
create function public.log_tutorial_gap(p_company uuid, p_question text, p_source text, p_module text default null)
returns void
language plpgsql security definer set search_path = '' as $$
declare v_q text; v_key text; begin
 if not mavi_private.member(p_company) then raise exception 'Sem acesso ao espaço' using errcode = '42501'; end if;
 v_q := left(regexp_replace(btrim(coalesce(p_question, '')), '\s+', ' ', 'g'), 300);
 if length(v_q) < 3 then return; end if;
 v_key := btrim(regexp_replace(mavi_private.fold(v_q), '[^a-z0-9]+', ' ', 'g'));
 if v_key = '' then return; end if;
 insert into public.tutorial_gaps(company_id, question, key, source, module, askers)
 values (p_company, v_q, v_key, case when p_source = 'mavi' then 'mavi' else 'search' end,
  case when p_module ~ '^[a-zA-Z]{2,40}$' then p_module end, array[auth.uid()])
 on conflict (company_id, key) do update set asks = tutorial_gaps.asks + 1, last_asked_at = now(),
  askers = case when auth.uid() = any(tutorial_gaps.askers) or cardinality(tutorial_gaps.askers) >= 50
   then tutorial_gaps.askers else tutorial_gaps.askers || auth.uid() end,
  module = coalesce(tutorial_gaps.module, excluded.module),
  status = case when tutorial_gaps.status = 'resolved' then 'open' else tutorial_gaps.status end;
end $$;

create function public.tutorial_gaps_list(p_company uuid, p_status text default 'open', p_limit integer default 100)
returns table(id uuid, question text, source text, module text, asks integer, people integer, asker_names text[],
 status text, tutorial_id uuid, tutorial_title text, first_asked_at timestamptz, last_asked_at timestamptz,
 handled_by_name text, handled_at timestamptz)
language plpgsql stable security definer set search_path = '' as $$ begin
 if not mavi_private.leader(p_company) then return; end if;
 return query
 select g.id, g.question, g.source, g.module, g.asks, cardinality(g.askers),
  array(select mavi_private.member_name(p_company, a) from unnest(g.askers[1:5]) a),
  g.status, g.tutorial_id, t.title, g.first_asked_at, g.last_asked_at,
  case when g.handled_by is not null then mavi_private.member_name(p_company, g.handled_by) end, g.handled_at
 from public.tutorial_gaps g
 left join public.tutorials t on t.company_id = g.company_id and t.id = g.tutorial_id
 where g.company_id = p_company and (coalesce(p_status, 'open') = 'all' or g.status = coalesce(p_status, 'open'))
 order by g.last_asked_at desc
 limit least(greatest(coalesce(p_limit, 100), 1), 300);
end $$;

create function public.tutorial_gap_count(p_company uuid) returns integer
language sql stable security definer set search_path = '' as $$
 select case when mavi_private.leader(p_company) then
  (select count(*)::integer from public.tutorial_gaps where company_id = p_company and status = 'open') else 0 end
$$;

-- Resolver (com o tutorial que responde), dispensar ou reabrir.
create function public.set_tutorial_gap(p_gap uuid, p_status text, p_tutorial uuid default null) returns void
language plpgsql security definer set search_path = '' as $$
declare g public.tutorial_gaps; begin
 select * into g from public.tutorial_gaps where id = p_gap for update;
 if not found or not mavi_private.leader(g.company_id) then raise exception 'Sem permissão' using errcode = '42501'; end if;
 if p_status not in ('open', 'resolved', 'dismissed') then raise exception 'Situação inválida' using errcode = '22023'; end if;
 if p_tutorial is not null and not exists (select 1 from public.tutorials t where t.company_id = g.company_id and t.id = p_tutorial) then
  raise exception 'Tutorial não encontrado' using errcode = 'P0002';
 end if;
 update public.tutorial_gaps set status = p_status,
  tutorial_id = case when p_status = 'resolved' then coalesce(p_tutorial, tutorial_id) end,
  handled_by = case when p_status = 'open' then null else auth.uid() end,
  handled_at = case when p_status = 'open' then null else now() end
 where id = g.id;
end $$;

create function mavi_private.broadcast_tutorial_gap() returns trigger
language plpgsql security definer set search_path = '' as $$ begin
 perform mavi_private.broadcast(coalesce(new.company_id, old.company_id), jsonb_build_object('kind', 'tutorials',
  'gaps', true));
 return null;
end $$;
revoke all on function mavi_private.broadcast_tutorial_gap() from public, anon, authenticated;
create trigger broadcast_tutorial_gap after insert or update of status, asks or delete on public.tutorial_gaps
 for each row execute function mavi_private.broadcast_tutorial_gap();

-- ------------------------------------------------------------ o que a tela lê
-- A da migração 20270415090000, com a transcrição de cada vídeo.
create or replace function public.tutorial_detail(p_tutorial uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare t public.tutorials; d public.tutorial_drafts; v_edit boolean; begin
 select * into t from public.tutorials where id = p_tutorial;
 if not found or not mavi_private.tutorial_can_see(t) then return null; end if;
 v_edit := mavi_private.tutorial_can_edit(t);
 if v_edit then select * into d from public.tutorial_drafts where tutorial_id = t.id; end if;
 return jsonb_build_object(
  'id', t.id, 'company_id', t.company_id, 'title', t.title, 'summary', t.summary, 'body', t.body,
  'modules', to_jsonb(t.modules), 'category', t.category, 'tags', to_jsonb(t.tags), 'status', t.status,
  'version', t.version, 'revision', t.revision,
  'audience', case when v_edit then jsonb_build_object('aud_all', t.aud_all, 'aud_roles', to_jsonb(t.aud_roles),
   'aud_teams', to_jsonb(t.aud_teams), 'aud_users', to_jsonb(t.aud_users), 'aud_exclude', to_jsonb(t.aud_exclude)) end,
  'created_by', t.created_by, 'author_name', mavi_private.member_name(t.company_id, t.created_by),
  'updated_by_name', mavi_private.member_name(t.company_id, t.updated_by),
  'created_at', t.created_at, 'updated_at', t.updated_at, 'published_at', t.published_at,
  'media', coalesce((select jsonb_agg(jsonb_build_object('id', m.id, 'name', m.name, 'content_type', m.content_type,
    'size_bytes', m.size_bytes, 'duration_seconds', m.duration_seconds, 'transcript', m.transcript,
    'transcript_status', m.transcript_status, 'transcript_source', m.transcript_source,
    'transcript_error', case when v_edit then m.transcript_error end) order by m.created_at)
   from public.tutorial_media m where m.company_id = t.company_id and m.tutorial_id = t.id and m.status = 'ready'), '[]'),
  'draft', case when d.tutorial_id is not null then jsonb_build_object('content', d.content, 'saved_at', d.saved_at,
   'saved_by_name', mavi_private.member_name(t.company_id, d.saved_by)) end,
  'can_edit', v_edit);
end $$;

-- ------------------------------------------------------------ permissões
revoke all on function public.confirm_tutorial_media(uuid, integer), public.set_tutorial_media_transcript(uuid, text),
 public.retry_tutorial_media_transcript(uuid), public.tutorial_transcribe_claim(text, integer),
 public.tutorial_transcribe_save(text, uuid, text, text, boolean, text, text, numeric, uuid, integer),
 public.search_tutorials(uuid, text, text, text, boolean, text, text[], integer),
 public.log_tutorial_gap(uuid, text, text, text), public.tutorial_gaps_list(uuid, text, integer),
 public.tutorial_gap_count(uuid), public.set_tutorial_gap(uuid, text, uuid)
 from public, anon, authenticated;
grant execute on function public.confirm_tutorial_media(uuid, integer), public.set_tutorial_media_transcript(uuid, text),
 public.retry_tutorial_media_transcript(uuid),
 public.search_tutorials(uuid, text, text, text, boolean, text, text[], integer),
 public.log_tutorial_gap(uuid, text, text, text), public.tutorial_gaps_list(uuid, text, integer),
 public.tutorial_gap_count(uuid), public.set_tutorial_gap(uuid, text, uuid) to authenticated;
-- anon: o worker, com o segredo.
grant execute on function public.tutorial_transcribe_claim(text, integer),
 public.tutorial_transcribe_save(text, uuid, text, text, boolean, text, text, numeric, uuid, integer)
 to anon, authenticated;

notify pgrst, 'reload schema';

commit;
