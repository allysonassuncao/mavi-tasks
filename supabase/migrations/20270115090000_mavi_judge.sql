begin;

-- MAVI · autoavaliação das respostas (Fase 3 do pedido de 30/09/2026):
--
-- 1. Sinais automáticos em cada resposta, sem custo: parou no limite de
--    passos (capped), ferramentas com erro (tool_errors), buscou mas não citou
--    nenhuma fonte (no_sources), anunciou trabalho em vez de entregar
--    ("agora vou puxar…", announce) e, na pergunta seguinte, a pessoa
--    reclamou ("me mande o que pedi", frustration) ou repetiu o pedido
--    (repeated). Um 👎 sem motivo nem comentário também vira sinal
--    (down_unexplained). A resposta com sinal entra em mavi_answer_checks.
-- 2. Juiz seletivo: só as respostas com sinal. O worker (o mesmo
--    agendamento "ai-learning" do Copiloto) lê a pergunta, a resposta, os
--    passos, os trechos das fontes citadas, o dossiê do cliente e o que a
--    pessoa já reclamou antes. O Jev (TypeSafe, funcionalidade
--    'mavi_judge_check'; sem escolha, o do termômetro) responde as perguntas
--    objetivas (entregou tudo? anunciou em vez de fazer? os fatos estão nas
--    fontes? seguiu o formato?) e um modelo (funcionalidade 'mavi_judge')
--    decide e explica o que faltou.
-- 3. Resposta ruim vira uma avaliação da própria MAVI (mavi_feedback com
--    origin 'judge', sem pessoa): entra no aprendizado como as do time e conta
--    como uma evidência. Sozinha, a lição fica aguardando evidência; com mais
--    uma pessoa (ou um líder), entra em uso.
-- 4. Administradores e gestores ligam e desligam a autoavaliação e o limite
--    por dia em Painel da MAVI › Aprendizado da MAVI (padrão: ligada, 40).

create or replace function mavi_private.ai_decision_feature(p_feature text) returns boolean
language sql immutable set search_path = '' as $$
 select coalesce(p_feature, '') in ('client_temperature', 'client_radar_check', 'mavi_judge_check')
$$;

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
   'mavi_judge_check')));

-- A da migração 20270113090000, com a autoavaliação da MAVI.
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
   'mavi_judge_check') then
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
  raise exception 'O Jev só responde a perguntas de decisão: use-o no termômetro, na conferência do Radar ou na autoavaliação da MAVI.'
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

-- ------------------------------------------------------------ as avaliações da MAVI
alter table public.mavi_feedback
 add column origin text not null default 'person' check (origin in ('person', 'judge')),
 -- Os sinais que levaram a MAVI a conferir a resposta.
 add column signals text[] not null default '{}',
 -- As respostas do Jev e a decisão do juiz.
 add column verdict jsonb check (verdict is null or jsonb_typeof(verdict) = 'object');
alter table public.mavi_feedback alter column user_id drop not null;
alter table public.mavi_feedback add constraint mavi_feedback_origin_user
 check ((origin = 'judge') = (user_id is null));
create unique index mavi_feedback_judge on public.mavi_feedback (message_id) where origin = 'judge';

-- A evidência de um aprendizado: a MAVI conta como uma "pessoa" (sozinha,
-- a lição espera; com mais uma pessoa ou um líder, entra em uso).
create or replace function mavi_private.mavi_lesson_evidence(p_id uuid, p_add bigint[]) returns void
language plpgsql security definer set search_path = '' as $$
declare l public.mavi_lessons; v_ids bigint[]; begin
 select * into l from public.mavi_lessons where id = p_id for update;
 select coalesce(array_agg(distinct x order by x desc), '{}') into v_ids
 from unnest(l.evidence || coalesce(p_add, '{}')) x
 where exists (select 1 from public.mavi_feedback f where f.id = x and f.company_id = l.company_id);
 v_ids := v_ids[1:60];
 update public.mavi_lessons c set evidence = v_ids,
  people = (select count(distinct coalesce(f.user_id::text, 'mavi')) from public.mavi_feedback f where f.id = any(v_ids)),
  has_leader = exists (select 1 from public.mavi_feedback f where f.id = any(v_ids) and f.leader),
  ups = (select count(*) from public.mavi_feedback f where f.id = any(v_ids) and f.vote = 'up'),
  downs = (select count(*) from public.mavi_feedback f where f.id = any(v_ids) and f.vote = 'down')
 where c.id = p_id;
 update public.mavi_lessons c set status = case when c.people >= 2 or c.has_leader then 'active' else 'candidate' end
 where c.id = p_id and c.status in ('active', 'candidate') and c.origin = 'mavi';
end $$;

-- ------------------------------------------------------------ configuração
create table mavi_private.mavi_judge_settings (
 company_id uuid primary key references public.companies(id) on delete cascade,
 enabled boolean not null default true,
 daily_limit integer not null default 40 check (daily_limit between 0 and 500),
 updated_by uuid references auth.users(id) on delete set null,
 updated_at timestamptz not null default now()
);
alter table mavi_private.mavi_judge_settings enable row level security;
revoke all on mavi_private.mavi_judge_settings from public, anon, authenticated;

create function mavi_private.mavi_judge_config(c uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
 select jsonb_build_object('enabled', coalesce(s.enabled, true), 'daily_limit', coalesce(s.daily_limit, 40))
 from (select 1) x left join mavi_private.mavi_judge_settings s on s.company_id = c
$$;

create function public.mavi_judge_set(p_company uuid, p_enabled boolean, p_limit integer) returns jsonb
language plpgsql security definer set search_path = '' as $$ begin
 if not mavi_private.leader(p_company) then
  raise exception 'Só administradores e gestores mudam a autoavaliação da MAVI.' using errcode = '42501';
 end if;
 if p_limit is not null and p_limit not between 0 and 500 then
  raise exception 'O limite por dia vai de 0 a 500.' using errcode = '22023';
 end if;
 insert into mavi_private.mavi_judge_settings(company_id, enabled, daily_limit, updated_by)
 values (p_company, coalesce(p_enabled, true), coalesce(p_limit, 40), auth.uid())
 on conflict (company_id) do update set enabled = coalesce(p_enabled, mavi_judge_settings.enabled),
  daily_limit = coalesce(p_limit, mavi_judge_settings.daily_limit), updated_by = auth.uid(), updated_at = now();
 return mavi_private.mavi_judge_config(p_company);
end $$;

-- ------------------------------------------------------------ os sinais
create table public.mavi_answer_checks (
 message_id bigint primary key,
 company_id uuid not null references public.companies(id) on delete cascade,
 conversation_id uuid not null references public.ai_conversations(id) on delete cascade,
 -- Quem perguntou (para o juiz ler o que a pessoa já reclamou antes).
 user_id uuid references auth.users(id) on delete set null,
 signals text[] not null default '{}'
  check (signals <@ array['capped', 'tool_errors', 'no_sources', 'announce', 'frustration', 'repeated',
   'down_unexplained']::text[]),
 status text not null default 'pending' check (status in ('pending', 'done', 'error')),
 attempts smallint not null default 0,
 claimed_until timestamptz,
 verdict jsonb,
 judged_at timestamptz,
 last_error text check (length(last_error) <= 500),
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now()
);
create index mavi_answer_checks_pending on public.mavi_answer_checks (company_id, updated_at) where status = 'pending';
create index mavi_answer_checks_judged on public.mavi_answer_checks (company_id, judged_at desc) where judged_at is not null;
alter table public.mavi_answer_checks enable row level security;
revoke all on public.mavi_answer_checks from public, anon, authenticated;

-- Junta os sinais novos; um sinal que ainda não estava volta a pedir conferência.
create function mavi_private.mavi_signal(p_message bigint, p_signals text[]) returns void
language plpgsql security definer set search_path = '' as $$
declare m public.ai_messages; c public.ai_conversations; v_signals text[]; begin
 select array(select distinct s from unnest(coalesce(p_signals, '{}')) s
  where s in ('capped', 'tool_errors', 'no_sources', 'announce', 'frustration', 'repeated', 'down_unexplained'))
 into v_signals;
 if cardinality(v_signals) = 0 then return; end if;
 select * into m from public.ai_messages where id = p_message and role = 'assistant';
 if m.id is null then return; end if;
 select * into c from public.ai_conversations where id = m.conversation_id;
 insert into public.mavi_answer_checks(message_id, company_id, conversation_id, user_id, signals)
 values (m.id, m.company_id, m.conversation_id, c.owner_id, v_signals)
 on conflict (message_id) do update set
  signals = array(select distinct s from unnest(mavi_answer_checks.signals || excluded.signals) s),
  status = case when excluded.signals <@ mavi_answer_checks.signals then mavi_answer_checks.status else 'pending' end,
  attempts = case when excluded.signals <@ mavi_answer_checks.signals then mavi_answer_checks.attempts else 0 end,
  updated_at = case when excluded.signals <@ mavi_answer_checks.signals then mavi_answer_checks.updated_at else now() end;
end $$;

-- O servidor da MAVI marca a resposta (só na conversa de quem pergunta).
create function public.mavi_answer_signal(p_message bigint, p_signals text[]) returns void
language plpgsql security definer set search_path = '' as $$ begin
 if not exists (select 1 from public.ai_messages m join public.ai_conversations c on c.id = m.conversation_id
  where m.id = p_message and m.role = 'assistant' and c.owner_id = auth.uid() and mavi_private.member(c.company_id)) then
  raise exception 'Resposta não encontrada.' using errcode = 'P0002';
 end if;
 perform mavi_private.mavi_signal(p_message, p_signals);
end $$;

-- O 👎 sem motivo nem comentário: a MAVI confere o que faltou.
create or replace function public.mavi_feedback_vote(p_message bigint, p_vote text, p_reason text default null,
 p_comment text default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare m public.ai_messages; c public.ai_conversations; v_client uuid; v_contract uuid; v_product uuid;
 v_question text; v_steps text; f public.mavi_feedback; begin
 select * into m from public.ai_messages where id = p_message and role = 'assistant';
 if m.id is null then raise exception 'Resposta não encontrada.' using errcode = 'P0002'; end if;
 if not mavi_private.ai_conversation_visible(m.company_id, m.conversation_id) then
  raise exception 'Sem acesso a esta conversa.' using errcode = '42501';
 end if;
 if p_vote is null then
  delete from public.mavi_feedback where user_id = auth.uid() and message_id = p_message;
  return null;
 end if;
 if p_vote not in ('up', 'down') then raise exception 'Voto inválido.' using errcode = '22023'; end if;
 select * into c from public.ai_conversations where id = m.conversation_id;
 v_client := case when c.scope->>'client' ~* '^[0-9a-f-]{36}$' then (c.scope->>'client')::uuid end;
 v_contract := case when c.scope->>'contract' ~* '^[0-9a-f-]{36}$' then (c.scope->>'contract')::uuid end;
 if v_contract is not null then
  select ct.client_id, ct.product_id into v_client, v_product from public.contracts ct
  where ct.company_id = m.company_id and ct.id = v_contract;
 end if;
 select left(u.content, 1000) into v_question from public.ai_messages u
 where u.conversation_id = m.conversation_id and u.role = 'user' and u.id < m.id order by u.id desc limit 1;
 select left(string_agg(coalesce(s->>'label', '') || coalesce(' (' || (s->>'detail') || ')', ''), '; '), 1500)
 into v_steps from jsonb_array_elements(case when jsonb_typeof(m.steps) = 'array' then m.steps else '[]' end) s;
 insert into public.mavi_feedback(company_id, leader, conversation_id, message_id, client_id, contract_id, product_id,
  module, vote, reason, comment, question, answer, steps)
 values (m.company_id, mavi_private.leader(m.company_id), m.conversation_id, m.id, v_client, v_contract, v_product,
  left(coalesce(c.module, 'assistant'), 40), p_vote,
  case when p_vote = 'down' and p_reason in ('incomplete', 'wrong', 'ignored', 'invented', 'format', 'other')
   then p_reason end,
  case when p_vote = 'down' then left(btrim(coalesce(p_comment, '')), 500) else '' end,
  coalesce(v_question, ''), left(coalesce(m.content, ''), 3000), coalesce(v_steps, ''))
 on conflict (user_id, message_id) do update set vote = excluded.vote, reason = excluded.reason,
  comment = excluded.comment, leader = excluded.leader, updated_at = now(), learned_at = null
 returning * into f;
 if f.vote = 'down' and f.reason is null and f.comment = '' then
  perform mavi_private.mavi_signal(m.id, array['down_unexplained']);
 end if;
 return jsonb_build_object('message', f.message_id, 'vote', f.vote, 'reason', f.reason, 'comment', f.comment);
end $$;

-- ------------------------------------------------------------ o juiz (worker)
create function mavi_private.mavi_judge_due() returns table(company_id uuid)
language sql stable security definer set search_path = '' as $$
 select distinct k.company_id from public.mavi_answer_checks k
 where k.status = 'pending' and k.attempts < 3
  and (k.claimed_until is null or k.claimed_until < now())
  -- Um tempo para a pessoa reagir (👎, pergunta seguinte) antes da conferência.
  and k.updated_at <= now() - interval '2 minutes'
  and (mavi_private.mavi_judge_config(k.company_id)->>'enabled')::boolean
  and (select count(*) from public.mavi_answer_checks x where x.company_id = k.company_id
   and x.judged_at > now() - interval '1 day') < (mavi_private.mavi_judge_config(k.company_id)->>'daily_limit')::integer
$$;

-- As respostas a conferir, com o material: a pergunta, a resposta, os passos,
-- os trechos das fontes citadas, o dossiê do cliente e o que a pessoa já
-- reclamou antes (as avaliações dela).
create function public.mavi_judge_claim(p_secret text, p_limit integer default 3) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare k public.mavi_answer_checks; m public.ai_messages; c public.ai_conversations; v_client uuid;
 v_out jsonb := '[]'; begin
 if not mavi_private.ai_secret_ok(p_secret) then raise exception 'Sem permissão' using errcode = '42501'; end if;
 for k in select * from public.mavi_answer_checks x
  where x.company_id in (select d.company_id from mavi_private.mavi_judge_due() d)
   and x.status = 'pending' and x.attempts < 3 and (x.claimed_until is null or x.claimed_until < now())
   and x.updated_at <= now() - interval '2 minutes'
  order by x.updated_at limit least(greatest(coalesce(p_limit, 3), 1), 10) for update skip locked
 loop
  update public.mavi_answer_checks set claimed_until = now() + interval '5 minutes', attempts = attempts + 1
  where message_id = k.message_id;
  select * into m from public.ai_messages where id = k.message_id;
  select * into c from public.ai_conversations where id = k.conversation_id;
  v_client := case when c.scope->>'client' ~* '^[0-9a-f-]{36}$' then (c.scope->>'client')::uuid end;
  if v_client is null and c.scope->>'contract' ~* '^[0-9a-f-]{36}$' then
   select ct.client_id into v_client from public.contracts ct where ct.id = (c.scope->>'contract')::uuid;
  end if;
  v_out := v_out || jsonb_build_array(jsonb_build_object(
   'message', k.message_id, 'company', k.company_id, 'conversation', k.conversation_id, 'signals', to_jsonb(k.signals),
   'question', (select left(u.content, 2000) from public.ai_messages u where u.conversation_id = m.conversation_id
     and u.role = 'user' and u.id < m.id order by u.id desc limit 1),
   'answer', left(coalesce(m.content, ''), 8000),
   'steps', (select left(string_agg(coalesce(s->>'label', '') || coalesce(' (' || (s->>'detail') || ')', ''), '; '), 2000)
     from jsonb_array_elements(case when jsonb_typeof(m.steps) = 'array' then m.steps else '[]' end) s),
   'artifacts', (select coalesce(jsonb_agg(jsonb_build_object('ref', a->>'ref', 'type', a->>'type',
      'title', coalesce(a#>>'{canvas,title}', a->>'title', ''))), '[]')
     from jsonb_array_elements(case when jsonb_typeof(m.artifacts) = 'array' then m.artifacts else '[]' end) a),
   'client', (select k2.name from public.clients k2 where k2.id = v_client),
   'sources', (select coalesce(jsonb_agg(jsonb_build_object('ref', src->>'ref', 'type', src->>'type',
      'title', src->>'title', 'date', src->>'date', 'excerpt', left(ch.content, 1500)) order by i), '[]')
     from jsonb_array_elements(case when jsonb_typeof(m.sources) = 'array' then m.sources else '[]' end)
      with ordinality s(src, i)
     left join lateral (
      select x.content from public.ai_chunks x
      join public.ai_documents d on d.company_id = x.company_id and d.id = x.document_id
      where d.company_id = m.company_id and (
       (src->>'type' = 'whatsapp' and x.source_type = 'whatsapp' and x.meta->>'message' = src->>'id'
        and x.client_id is not distinct from nullif(src->>'client_id', '')::uuid)
       or (src->>'type' <> 'whatsapp' and d.source_id::text = src->>'id' and d.source_type = case src->>'type'
         when 'file' then 'drive_file' when 'case' then 'success_case' else d.source_type end
        and (src->>'type' <> 'social' or d.source_type in ('social_plan', 'social_briefing'))
        and (src->>'type' in ('file', 'case', 'social') or d.source_type = src->>'type')))
      order by case when src ? 'start' and x.meta ? 'start'
        then abs((x.meta->>'start')::numeric - (src->>'start')::numeric)
       when src ? 'page' and x.meta ? 'page' then abs((x.meta->>'page')::numeric - (src->>'page')::numeric)
       else x.ord end
      limit 1) ch on true
     where i <= 10),
   'dossier', (select coalesce(jsonb_agg(jsonb_build_object('kind', di.kind, 'text', di.text)), '[]') from (
     select i.kind, i.text from public.client_dossier_items i
     where i.client_id = v_client and not i.dismissed order by i.pinned desc, i.seen_at desc nulls last limit 15) di),
   'person', (select coalesce(jsonb_agg(jsonb_build_object('vote', f.vote, 'reason', f.reason, 'comment', f.comment,
      'question', left(f.question, 200)) order by f.updated_at desc), '[]') from (
     select * from public.mavi_feedback f where f.company_id = k.company_id and f.user_id = k.user_id
      and (f.comment <> '' or f.reason is not null) order by f.updated_at desc limit 8) f)));
 end loop;
 return v_out;
end $$;

-- O Jev da autoavaliação: o escolhido para ela ou, sem escolha, o do termômetro.
create function public.mavi_judge_jev(p_secret text, p_company uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$ begin
 if not mavi_private.ai_secret_ok(p_secret) then raise exception 'Sem permissão' using errcode = '42501'; end if;
 return coalesce(
  (select jsonb_build_object('provider_id', p.id, 'provider', p.name, 'kind', p.kind, 'base_url', p.base_url,
    'key_cipher', p.key_cipher, 'model', rt.model,
    'price', (select m from jsonb_array_elements(p.models) m where m->>'id' = rt.model limit 1))
   from mavi_private.ai_routes rt join mavi_private.ai_providers p on p.id = rt.provider_id and p.active
   where rt.company_id = p_company and rt.scope_type = 'feature' and rt.feature = 'mavi_judge_check' limit 1),
  mavi_private.temperature_route(p_company));
end $$;

-- A decisão: sempre guarda o veredito; resposta ruim vira avaliação da MAVI.
create function public.mavi_judge_store(p_secret text, p_message bigint, p_verdict jsonb, p_bad boolean,
 p_reason text, p_comment text, p_usage jsonb) returns void
language plpgsql security definer set search_path = '' as $$
declare k public.mavi_answer_checks; m public.ai_messages; c public.ai_conversations; v_client uuid; v_contract uuid;
 v_product uuid; u jsonb; begin
 if not mavi_private.ai_secret_ok(p_secret) then raise exception 'Sem permissão' using errcode = '42501'; end if;
 select * into k from public.mavi_answer_checks where message_id = p_message for update;
 if k.message_id is null then return; end if;
 update public.mavi_answer_checks set status = 'done', verdict = p_verdict, judged_at = now(), claimed_until = null,
  last_error = null, updated_at = now()
 where message_id = p_message;
 if coalesce(p_bad, false) then
  select * into m from public.ai_messages where id = p_message;
  select * into c from public.ai_conversations where id = m.conversation_id;
  v_client := case when c.scope->>'client' ~* '^[0-9a-f-]{36}$' then (c.scope->>'client')::uuid end;
  v_contract := case when c.scope->>'contract' ~* '^[0-9a-f-]{36}$' then (c.scope->>'contract')::uuid end;
  if v_contract is not null then
   select ct.client_id, ct.product_id into v_client, v_product from public.contracts ct where ct.id = v_contract;
  end if;
  insert into public.mavi_feedback(company_id, user_id, leader, origin, conversation_id, message_id, client_id,
   contract_id, product_id, module, vote, reason, comment, question, answer, steps, signals, verdict)
  values (m.company_id, null, false, 'judge', m.conversation_id, m.id, v_client, v_contract, v_product,
   left(coalesce(c.module, 'assistant'), 40), 'down',
   case when p_reason in ('incomplete', 'wrong', 'ignored', 'invented', 'format', 'other') then p_reason else 'other' end,
   left(btrim(coalesce(p_comment, '')), 500),
   coalesce((select left(x.content, 1000) from public.ai_messages x where x.conversation_id = m.conversation_id
    and x.role = 'user' and x.id < m.id order by x.id desc limit 1), ''),
   left(coalesce(m.content, ''), 3000),
   coalesce((select left(string_agg(coalesce(s->>'label', '') || coalesce(' (' || (s->>'detail') || ')', ''), '; '), 1500)
    from jsonb_array_elements(case when jsonb_typeof(m.steps) = 'array' then m.steps else '[]' end) s), ''),
   k.signals, p_verdict)
  on conflict (message_id) where origin = 'judge' do update set reason = excluded.reason, comment = excluded.comment,
   signals = excluded.signals, verdict = excluded.verdict, updated_at = now(), learned_at = null;
 else
  -- Conferida e boa: uma avaliação antiga da MAVI (de sinais anteriores) sai.
  delete from public.mavi_feedback where message_id = p_message and origin = 'judge' and learned_at is null;
 end if;
 for u in select * from jsonb_array_elements(case when jsonb_typeof(p_usage) = 'array' then p_usage else '[]' end) loop
  insert into public.ai_usage(company_id, user_id, module, kind, model, input_tokens, output_tokens,
   cache_read_tokens, cache_write_tokens, cost_usd, provider_id, provider_name)
  values (k.company_id, null, 'mavi', 'judge', left(coalesce(u->>'model', ''), 80),
   greatest(coalesce((u->>'input')::integer, 0), 0), greatest(coalesce((u->>'output')::integer, 0), 0),
   greatest(coalesce((u->>'cache_read')::integer, 0), 0), greatest(coalesce((u->>'cache_write')::integer, 0), 0),
   least(greatest(coalesce((u->>'cost')::numeric, 0), 0), 100),
   case when u->>'provider_id' ~* '^[0-9a-f-]{36}$' then (u->>'provider_id')::uuid end,
   left(coalesce(u->>'provider', ''), 120));
 end loop;
end $$;

create function public.mavi_judge_fail(p_secret text, p_message bigint, p_error text) returns void
language plpgsql security definer set search_path = '' as $$ begin
 if not mavi_private.ai_secret_ok(p_secret) then raise exception 'Sem permissão' using errcode = '42501'; end if;
 update public.mavi_answer_checks set claimed_until = null, last_error = left(coalesce(p_error, ''), 500),
  status = case when attempts >= 3 then 'error' else status end, updated_at = now()
 where message_id = p_message;
end $$;

-- O mesmo agendamento acorda o Copiloto, o aprendizado e a autoavaliação da MAVI.
create or replace function mavi_private.ai_learning_kick() returns void
language plpgsql security definer set search_path = '' as $$
declare cfg mavi_private.ai_config; begin
 select * into cfg from mavi_private.ai_config where id;
 if not found then return; end if;
 if not exists (select 1 from mavi_private.copilot_learning_due())
  and not exists (select 1 from mavi_private.mavi_learning_due())
  and not exists (select 1 from mavi_private.mavi_judge_due()) then return; end if;
 perform net.http_post(url := cfg.url, body := '{"action":"ai-learning"}'::jsonb,
  headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || cfg.secret),
  timeout_milliseconds := 60000);
end $$;

-- ------------------------------------------------------------ o aprendizado lê a origem
create or replace function public.mavi_learning_claim(p_secret text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_company uuid; begin
 if not mavi_private.ai_secret_ok(p_secret) then raise exception 'Sem permissão' using errcode = '42501'; end if;
 select s.company_id into v_company from mavi_private.mavi_learning_state s
 where s.company_id in (select d.company_id from mavi_private.mavi_learning_due() d)
 order by s.dirty_at limit 1 for update skip locked;
 if v_company is null then return null; end if;
 update mavi_private.mavi_learning_state set claimed_at = now(), running_until = now() + interval '4 minutes'
 where company_id = v_company;
 return jsonb_build_object('company', v_company,
  'feedback', (select coalesce(jsonb_agg(jsonb_build_object('id', f.id, 'user', coalesce(f.user_id::text, 'mavi'),
     'origin', f.origin, 'signals', to_jsonb(f.signals), 'leader', f.leader,
     'client_id', f.client_id, 'client', k.name, 'product_id', f.product_id, 'product', p.name, 'module', f.module,
     'vote', f.vote, 'reason', f.reason, 'comment', f.comment, 'question', f.question, 'answer', left(f.answer, 1500),
     'steps', left(f.steps, 800), 'at', f.updated_at) order by f.updated_at), '[]')
   from (select * from public.mavi_feedback x where x.company_id = v_company and x.learned_at is null
    order by x.updated_at limit 100) f
   left join public.clients k on k.company_id = f.company_id and k.id = f.client_id
   left join public.products p on p.company_id = f.company_id and p.id = f.product_id),
  'lessons', (select coalesce(jsonb_agg(jsonb_build_object('id', l.id, 'scope', l.scope, 'client_id', l.client_id,
     'client', k.name, 'product_id', l.product_id, 'product', p.name, 'kind', l.kind, 'text', l.text,
     'status', l.status, 'origin', l.origin, 'people', l.people) order by l.updated_at desc), '[]')
   from public.mavi_lessons l
   left join public.clients k on k.company_id = l.company_id and k.id = l.client_id
   left join public.products p on p.company_id = l.company_id and p.id = l.product_id
   where l.company_id = v_company));
end $$;

-- ------------------------------------------------------------ a aba do Painel
create or replace function public.mavi_learning_report(p_company uuid, p_from date, p_to date, p_vote text default null,
 p_limit integer default 50, p_offset integer default 0) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_from timestamptz := p_from::timestamptz; v_to timestamptz := (p_to + 1)::timestamptz;
 st mavi_private.mavi_learning_state; begin
 if not mavi_private.leader(p_company) then
  raise exception 'Só administradores e gestores veem o aprendizado da MAVI.' using errcode = '42501';
 end if;
 select * into st from mavi_private.mavi_learning_state where company_id = p_company;
 return jsonb_build_object(
  'totals', (select jsonb_build_object('up', count(*) filter (where f.vote = 'up' and f.origin = 'person'),
     'down', count(*) filter (where f.vote = 'down' and f.origin = 'person'), 'people', count(distinct f.user_id),
     'answers', (select count(*) from public.ai_messages m where m.company_id = p_company and m.role = 'assistant'
      and m.created_at >= v_from and m.created_at < v_to))
   from public.mavi_feedback f
   where f.company_id = p_company and f.updated_at >= v_from and f.updated_at < v_to),
  'judge', (select jsonb_build_object('checked', count(*) filter (where k.judged_at is not null),
     'bad', (select count(*) from public.mavi_feedback f where f.company_id = p_company and f.origin = 'judge'
      and f.updated_at >= v_from and f.updated_at < v_to),
     'pending', count(*) filter (where k.status = 'pending'),
     'signals', (select coalesce(jsonb_object_agg(x.s, x.n), '{}') from (
       select s, count(*)::int as n from public.mavi_answer_checks y, unnest(y.signals) s
       where y.company_id = p_company and y.created_at >= v_from and y.created_at < v_to group by s) x))
   || mavi_private.mavi_judge_config(p_company)
   from public.mavi_answer_checks k
   where k.company_id = p_company and k.created_at >= v_from and k.created_at < v_to),
  'reasons', (select coalesce(jsonb_object_agg(r.reason, r.n), '{}') from (
    select f.reason, count(*)::int as n from public.mavi_feedback f
    where f.company_id = p_company and f.vote = 'down' and f.reason is not null and f.origin = 'person'
     and f.updated_at >= v_from and f.updated_at < v_to group by f.reason) r),
  'lessons', (select coalesce(jsonb_agg(mavi_private.mavi_lesson_json(l)
    order by (l.reviewed_at is null and l.status <> 'dismissed') desc,
     case l.status when 'active' then 1 when 'candidate' then 2 when 'paused' then 3 else 4 end, l.updated_at desc), '[]')
   from public.mavi_lessons l where l.company_id = p_company),
  'feedback', (select coalesce(jsonb_agg(jsonb_build_object('id', f.id, 'user_id', f.user_id, 'origin', f.origin,
     'signals', to_jsonb(f.signals), 'client_id', f.client_id,
     'product_id', f.product_id, 'module', f.module, 'vote', f.vote, 'reason', f.reason, 'comment', f.comment,
     'question', f.question, 'answer', left(f.answer, 600), 'at', f.updated_at, 'learned', f.learned_at is not null)
    order by f.updated_at desc), '[]')
   from (select * from public.mavi_feedback f
    where f.company_id = p_company and f.updated_at >= v_from and f.updated_at < v_to
     and (p_vote is null or f.vote = p_vote or (p_vote = 'judge' and f.origin = 'judge'))
     and (p_vote is distinct from 'judge' or f.origin = 'judge')
    order by f.updated_at desc
    limit least(greatest(coalesce(p_limit, 50), 1), 200) offset greatest(coalesce(p_offset, 0), 0)) f),
  'feedback_total', (select count(*)::int from public.mavi_feedback f
    where f.company_id = p_company and f.updated_at >= v_from and f.updated_at < v_to
     and (p_vote is null or f.vote = p_vote or (p_vote = 'judge' and f.origin = 'judge'))
     and (p_vote is distinct from 'judge' or f.origin = 'judge')),
  'pending', (select count(*)::int from public.mavi_feedback f
    where f.company_id = p_company and f.learned_at is null),
  'learned_at', st.built_at);
end $$;

-- ------------------------------------------------------------ permissões
revoke all on function mavi_private.mavi_judge_config(uuid), mavi_private.mavi_signal(bigint, text[]),
 mavi_private.mavi_judge_due() from public, anon, authenticated;
revoke all on function public.mavi_judge_set(uuid, boolean, integer), public.mavi_answer_signal(bigint, text[]),
 public.ai_set_route(uuid, text, uuid, uuid, text, text) from public, anon;
grant execute on function public.mavi_judge_set(uuid, boolean, integer), public.mavi_answer_signal(bigint, text[]),
 public.ai_set_route(uuid, text, uuid, uuid, text, text) to authenticated;
revoke all on function public.mavi_judge_claim(text, integer), public.mavi_judge_jev(text, uuid),
 public.mavi_judge_store(text, bigint, jsonb, boolean, text, text, jsonb), public.mavi_judge_fail(text, bigint, text)
 from public, anon, authenticated;
grant execute on function public.mavi_judge_claim(text, integer), public.mavi_judge_jev(text, uuid),
 public.mavi_judge_store(text, bigint, jsonb, boolean, text, text, jsonb), public.mavi_judge_fail(text, bigint, text)
 to anon, authenticated;

commit;
