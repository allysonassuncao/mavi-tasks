begin;

-- MAVI · avaliação das respostas e aprendizado (Fase 2 do pedido de 30/09/2026):
--
-- 1. Cada resposta da MAVI (módulo MAVI e bolinha) ganha 👍/👎. O 👎 pede o
--    motivo (não terminou o pedido, informação errada, não seguiu o que pedi,
--    inventou ou sem fonte, formato ruim, outro) e um comentário opcional.
--    Avalia quem vê a conversa (a dona e com quem ela compartilhou). O voto
--    guarda a pergunta, um trecho da resposta e os passos, para o
--    aprendizado e para a revisão dos líderes.
-- 2. Igual ao Copiloto das tarefas (migração 20261103090000): o worker
--    (/api/ai, ação "ai-learning", funcionalidade 'mavi_learning') lê os
--    votos novos de cada empresa e propõe aprendizados da empresa, de um
--    produto ou de um cliente. O aprendizado entra em uso com feedback de 2
--    pessoas ou de um líder; líderes conferem, corrigem, pausam e excluem em
--    Painel da MAVI › Aprendizado da MAVI, e o que eles excluem a MAVI não
--    recria. O mesmo agendamento do Copiloto acorda os dois aprendizados.
-- 3. Em cada pergunta, a MAVI recebe os aprendizados em uso (os do cliente
--    e do produto da conversa primeiro) e as respostas recusadas há pouco
--    no mesmo cliente (ou as da própria pessoa), antes do worker aprender.

-- ------------------------------------------------------------ funcionalidade
alter table mavi_private.ai_routes drop constraint ai_routes_feature_check;
alter table mavi_private.ai_routes add constraint ai_routes_feature_check
 check ((scope_type = 'feature') = (feature is not null)
  and (feature is null or feature in ('assistant', 'meetings_history', 'meetings_ask',
   'whatsapp_task', 'social_leads_plan', 'social_leads_adjust', 'social_leads_briefing', 'social_leads_colors',
   'task_copilot', 'client_dossier', 'copilot_learning', 'notice_writer', 'notice_animation',
   'client_temperature', 'client_temperature_text', 'task_audio',
   'whatsapp_transcribe', 'task_audio_transcribe', 'image_generation', 'mavi_page', 'web_search', 'canvas_writer',
   'mavi_rerank', 'conversation_summary', 'skill_coach', 'whatsapp_history', 'client_radar', 'client_radar_check',
   'client_radar_themes', 'client_radar_report', 'mavi_learning')));

-- A da migração 20261231090000, com o aprendizado da MAVI.
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
  'client_radar_themes', 'client_radar_report', 'mavi_learning') then
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

-- ------------------------------------------------------------ avaliações
create table public.mavi_feedback (
 id bigint generated always as identity primary key,
 company_id uuid not null references public.companies(id) on delete cascade,
 user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
 -- Quem avaliou era administrador ou gestor na hora (vale como evidência forte).
 leader boolean not null default false,
 conversation_id uuid not null references public.ai_conversations(id) on delete cascade,
 message_id bigint not null,
 client_id uuid,
 contract_id uuid,
 product_id uuid,
 module text not null default 'assistant' check (length(module) <= 40),
 vote text not null check (vote in ('up', 'down')),
 -- Só no 👎: incomplete (não terminou o pedido), wrong (informação errada),
 -- ignored (não seguiu o que pedi), invented (inventou ou sem fonte),
 -- format (formato ruim), other.
 reason text check (reason in ('incomplete', 'wrong', 'ignored', 'invented', 'format', 'other')),
 comment text not null default '' check (length(comment) <= 500),
 -- O que foi avaliado (para aprender e revisar): a pergunta, um trecho da
 -- resposta e os passos que a MAVI fez.
 question text not null default '' check (length(question) <= 1000),
 answer text not null default '' check (length(answer) <= 3000),
 steps text not null default '' check (length(steps) <= 1500),
 learned_at timestamptz,
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 unique (user_id, message_id)
);
create index mavi_feedback_company on public.mavi_feedback (company_id, updated_at desc);
create index mavi_feedback_pending on public.mavi_feedback (company_id, updated_at) where learned_at is null;
create index mavi_feedback_client on public.mavi_feedback (client_id, updated_at desc) where vote = 'down';
create index mavi_feedback_conversation on public.mavi_feedback (conversation_id);
alter table public.mavi_feedback enable row level security;
revoke all on public.mavi_feedback from public, anon, authenticated;

-- ------------------------------------------------------------ aprendizados
create table public.mavi_lessons (
 id uuid primary key default gen_random_uuid(),
 company_id uuid not null references public.companies(id) on delete cascade,
 scope text not null check (scope in ('company', 'product', 'client')),
 client_id uuid,
 product_id uuid,
 -- Sobre o quê (nulo: geral): research (como buscar), answer (o que
 -- responder), format (formato e tamanho), facts (fatos e correções),
 -- tasks (tarefas longas e documentos).
 kind text check (kind in ('research', 'answer', 'format', 'facts', 'tasks')),
 text text not null check (length(btrim(text)) between 5 and 400),
 status text not null check (status in ('active', 'candidate', 'paused', 'dismissed')),
 origin text not null check (origin in ('mavi', 'person')),
 evidence bigint[] not null default '{}',
 people integer not null default 0,
 has_leader boolean not null default false,
 ups integer not null default 0,
 downs integer not null default 0,
 reviewed_by uuid,
 reviewed_at timestamptz,
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 updated_by uuid,
 check ((scope = 'client') = (client_id is not null)),
 check ((scope = 'product') = (product_id is not null))
);
create index mavi_lessons_company on public.mavi_lessons (company_id, status);
alter table public.mavi_lessons enable row level security;
revoke all on public.mavi_lessons from public, anon, authenticated;

create table mavi_private.mavi_learning_state (
 company_id uuid primary key references public.companies(id) on delete cascade,
 dirty_at timestamptz,
 claimed_at timestamptz,
 running_until timestamptz,
 built_at timestamptz,
 attempts integer not null default 0,
 last_error text
);
alter table mavi_private.mavi_learning_state enable row level security;
revoke all on mavi_private.mavi_learning_state from public, anon, authenticated;

create function mavi_private.mavi_feedback_touch() returns trigger
language plpgsql security definer set search_path = '' as $$ begin
 insert into mavi_private.mavi_learning_state(company_id, dirty_at) values (new.company_id, now())
 on conflict (company_id) do update set dirty_at = coalesce(mavi_learning_state.dirty_at, now());
 return null;
end $$;
create trigger mavi_feedback_learn after insert or update of vote, reason, comment on public.mavi_feedback
 for each row execute function mavi_private.mavi_feedback_touch();

-- 👍/👎 numa resposta (p_vote nulo tira o voto). Quem vê a conversa avalia.
create function public.mavi_feedback_vote(p_message bigint, p_vote text, p_reason text default null,
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
 return jsonb_build_object('message', f.message_id, 'vote', f.vote, 'reason', f.reason, 'comment', f.comment);
end $$;

-- Os meus votos numa conversa (a tela mostra o que a pessoa já avaliou).
create function public.mavi_feedback_mine(p_conversation uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
 select coalesce(jsonb_agg(jsonb_build_object('message', f.message_id, 'vote', f.vote, 'reason', f.reason,
   'comment', f.comment)), '[]')
 from public.mavi_feedback f
 where f.conversation_id = p_conversation and f.user_id = auth.uid()
  and mavi_private.ai_conversation_visible(f.company_id, f.conversation_id)
$$;

-- O que a MAVI recebe em cada pergunta: os aprendizados em uso (cliente,
-- produto e empresa; até 30) e as respostas recusadas há pouco (no cliente
-- da conversa, com comentário ou motivo; sem cliente, as da própria pessoa).
create function public.mavi_learning_context(p_company uuid, p_client uuid, p_contract uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_product uuid; begin
 if not mavi_private.member(p_company) then raise exception 'Sem acesso ao espaço' using errcode = '42501'; end if;
 if p_contract is not null then
  select ct.client_id, ct.product_id into p_client, v_product from public.contracts ct
  where ct.company_id = p_company and ct.id = p_contract;
 end if;
 return jsonb_build_object(
  'lessons', (select coalesce(jsonb_agg(jsonb_build_object('id', l.id, 'scope', l.scope, 'kind', l.kind,
     'text', l.text) order by l.ord, l.people desc, l.updated_at desc), '[]')
   from (select x.*, case x.scope when 'client' then 1 when 'product' then 2 else 3 end as ord
    from public.mavi_lessons x
    where x.company_id = p_company and x.status = 'active'
     and (x.scope = 'company' or (x.scope = 'product' and x.product_id = v_product)
      or (x.scope = 'client' and x.client_id = p_client))
    order by ord, x.people desc, x.updated_at desc limit 30) l),
  'rejected', (select coalesce(jsonb_agg(jsonb_build_object('reason', r.reason, 'comment', r.comment,
     'question', left(r.question, 300), 'at', r.updated_at) order by r.updated_at desc), '[]')
   from (select f.* from public.mavi_feedback f
    where f.company_id = p_company and f.vote = 'down' and f.learned_at is null
     and (f.reason is not null or f.comment <> '')
     and f.updated_at > now() - interval '30 days'
     and case when p_client is not null then f.client_id = p_client else f.user_id = auth.uid() end
    order by f.updated_at desc limit 6) r));
end $$;

-- ------------------------------------------------------------ Painel da MAVI › Aprendizado da MAVI
create function mavi_private.mavi_lesson_json(l public.mavi_lessons) returns jsonb
language sql stable security definer set search_path = '' as $$
 select jsonb_build_object('id', l.id, 'scope', l.scope, 'client_id', l.client_id, 'product_id', l.product_id,
  'kind', l.kind, 'text', l.text, 'status', l.status, 'origin', l.origin, 'people', l.people,
  'has_leader', l.has_leader, 'ups', l.ups, 'downs', l.downs, 'feedbacks', cardinality(l.evidence),
  'reviewed_by', l.reviewed_by, 'reviewed_at', l.reviewed_at, 'created_at', l.created_at,
  'updated_at', l.updated_at, 'updated_by', l.updated_by)
$$;

create function public.mavi_learning_report(p_company uuid, p_from date, p_to date, p_vote text default null,
 p_limit integer default 50, p_offset integer default 0) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_from timestamptz := p_from::timestamptz; v_to timestamptz := (p_to + 1)::timestamptz;
 st mavi_private.mavi_learning_state; begin
 if not mavi_private.leader(p_company) then
  raise exception 'Só administradores e gestores veem o aprendizado da MAVI.' using errcode = '42501';
 end if;
 select * into st from mavi_private.mavi_learning_state where company_id = p_company;
 return jsonb_build_object(
  'totals', (select jsonb_build_object('up', count(*) filter (where f.vote = 'up'),
     'down', count(*) filter (where f.vote = 'down'), 'people', count(distinct f.user_id),
     'answers', (select count(*) from public.ai_messages m where m.company_id = p_company and m.role = 'assistant'
      and m.created_at >= v_from and m.created_at < v_to))
   from public.mavi_feedback f
   where f.company_id = p_company and f.updated_at >= v_from and f.updated_at < v_to),
  'reasons', (select coalesce(jsonb_object_agg(r.reason, r.n), '{}') from (
    select f.reason, count(*)::int as n from public.mavi_feedback f
    where f.company_id = p_company and f.vote = 'down' and f.reason is not null
     and f.updated_at >= v_from and f.updated_at < v_to group by f.reason) r),
  'lessons', (select coalesce(jsonb_agg(mavi_private.mavi_lesson_json(l)
    order by (l.reviewed_at is null and l.status <> 'dismissed') desc,
     case l.status when 'active' then 1 when 'candidate' then 2 when 'paused' then 3 else 4 end, l.updated_at desc), '[]')
   from public.mavi_lessons l where l.company_id = p_company),
  'feedback', (select coalesce(jsonb_agg(jsonb_build_object('id', f.id, 'user_id', f.user_id, 'client_id', f.client_id,
     'product_id', f.product_id, 'module', f.module, 'vote', f.vote, 'reason', f.reason, 'comment', f.comment,
     'question', f.question, 'answer', left(f.answer, 600), 'at', f.updated_at, 'learned', f.learned_at is not null)
    order by f.updated_at desc), '[]')
   from (select * from public.mavi_feedback f
    where f.company_id = p_company and f.updated_at >= v_from and f.updated_at < v_to
     and (p_vote is null or f.vote = p_vote)
    order by f.updated_at desc
    limit least(greatest(coalesce(p_limit, 50), 1), 200) offset greatest(coalesce(p_offset, 0), 0)) f),
  'feedback_total', (select count(*)::int from public.mavi_feedback f
    where f.company_id = p_company and f.updated_at >= v_from and f.updated_at < v_to
     and (p_vote is null or f.vote = p_vote)),
  'pending', (select count(*)::int from public.mavi_feedback f
    where f.company_id = p_company and f.learned_at is null),
  'learned_at', st.built_at);
end $$;

create function public.mavi_lesson_save(p_company uuid, p_id uuid, p_scope text, p_client uuid, p_product uuid,
 p_kind text, p_text text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_id uuid; begin
 if not mavi_private.leader(p_company) then
  raise exception 'Só administradores e gestores editam os aprendizados.' using errcode = '42501';
 end if;
 if coalesce(p_scope, '') not in ('company', 'product', 'client') then
  raise exception 'Escolha onde vale o aprendizado.' using errcode = '22023';
 end if;
 if p_kind is not null and p_kind not in ('research', 'answer', 'format', 'facts', 'tasks') then
  raise exception 'Tipo inválido.' using errcode = '22023';
 end if;
 if length(btrim(coalesce(p_text, ''))) not between 5 and 400 then
  raise exception 'Escreva de 5 a 400 caracteres.' using errcode = '22023';
 end if;
 if p_scope = 'client' and not exists (select 1 from public.clients where company_id = p_company and id = p_client)
  or p_scope = 'product' and not exists (select 1 from public.products where company_id = p_company and id = p_product)
 then raise exception 'Não encontrado na empresa.' using errcode = 'P0002'; end if;
 if p_id is null then
  insert into public.mavi_lessons(company_id, scope, client_id, product_id, kind, text, status, origin,
   reviewed_by, reviewed_at, updated_by)
  values (p_company, p_scope, case when p_scope = 'client' then p_client end,
   case when p_scope = 'product' then p_product end, p_kind, btrim(p_text), 'active', 'person', auth.uid(), now(),
   auth.uid())
  returning id into v_id;
 else
  update public.mavi_lessons set scope = p_scope, client_id = case when p_scope = 'client' then p_client end,
   product_id = case when p_scope = 'product' then p_product end, kind = p_kind, text = btrim(p_text),
   origin = 'person', status = case when status in ('candidate', 'dismissed') then 'active' else status end,
   reviewed_by = auth.uid(), reviewed_at = now(), updated_by = auth.uid(), updated_at = now()
  where id = p_id and company_id = p_company returning id into v_id;
  if v_id is null then raise exception 'Aprendizado não encontrado.' using errcode = 'P0002'; end if;
 end if;
 return v_id;
end $$;

create function public.mavi_lesson_set(p_company uuid, p_id uuid, p_action text) returns void
language plpgsql security definer set search_path = '' as $$ begin
 if not mavi_private.leader(p_company) then
  raise exception 'Só administradores e gestores editam os aprendizados.' using errcode = '42501';
 end if;
 if p_action not in ('review', 'pause', 'activate', 'dismiss') then
  raise exception 'Ação inválida.' using errcode = '22023';
 end if;
 update public.mavi_lessons set
  status = case p_action when 'pause' then 'paused' when 'activate' then 'active' when 'dismiss' then 'dismissed'
   else status end,
  reviewed_by = auth.uid(), reviewed_at = now(), updated_by = auth.uid(), updated_at = now()
 where id = p_id and company_id = p_company;
 if not found then raise exception 'Aprendizado não encontrado.' using errcode = 'P0002'; end if;
end $$;

-- ------------------------------------------------------------ worker do aprendizado
create function mavi_private.mavi_learning_due() returns table(company_id uuid)
language sql stable security definer set search_path = '' as $$
 select s.company_id from mavi_private.mavi_learning_state s
 where s.dirty_at is not null and s.attempts < 5
  and (s.running_until is null or s.running_until < now())
  and (s.dirty_at <= now() - interval '10 minutes'
   or (select count(*) from public.mavi_feedback f where f.company_id = s.company_id and f.learned_at is null) >= 20)
$$;

create function public.mavi_learning_claim(p_secret text) returns jsonb
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
  'feedback', (select coalesce(jsonb_agg(jsonb_build_object('id', f.id, 'user', f.user_id, 'leader', f.leader,
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

create function mavi_private.mavi_lesson_evidence(p_id uuid, p_add bigint[]) returns void
language plpgsql security definer set search_path = '' as $$
declare l public.mavi_lessons; v_ids bigint[]; begin
 select * into l from public.mavi_lessons where id = p_id for update;
 select coalesce(array_agg(distinct x order by x desc), '{}') into v_ids
 from unnest(l.evidence || coalesce(p_add, '{}')) x
 where exists (select 1 from public.mavi_feedback f where f.id = x and f.company_id = l.company_id);
 v_ids := v_ids[1:60];
 update public.mavi_lessons c set evidence = v_ids,
  people = (select count(distinct f.user_id) from public.mavi_feedback f where f.id = any(v_ids)),
  has_leader = exists (select 1 from public.mavi_feedback f where f.id = any(v_ids) and f.leader),
  ups = (select count(*) from public.mavi_feedback f where f.id = any(v_ids) and f.vote = 'up'),
  downs = (select count(*) from public.mavi_feedback f where f.id = any(v_ids) and f.vote = 'down')
 where c.id = p_id;
 -- Entra em uso com 2 pessoas ou um líder; pausado/excluído por líder não muda.
 update public.mavi_lessons c set status = case when c.people >= 2 or c.has_leader then 'active' else 'candidate' end
 where c.id = p_id and c.status in ('active', 'candidate') and c.origin = 'mavi';
end $$;

create function public.mavi_learning_store(p_secret text, p_company uuid, p_ops jsonb, p_learned bigint[],
 p_usage jsonb) returns integer
language plpgsql security definer set search_path = '' as $$
declare o jsonb; v_changed integer := 0; v_id uuid; v_scope text; v_text text; v_kind text; v_ids bigint[];
 v_client uuid; v_product uuid; v_n integer; begin
 if not mavi_private.ai_secret_ok(p_secret) then raise exception 'Sem permissão' using errcode = '42501'; end if;
 for o in select * from jsonb_array_elements(case when jsonb_typeof(p_ops) = 'array' then p_ops else '[]' end) loop
  v_text := btrim(coalesce(o->>'text', ''));
  v_kind := case when o->>'kind' in ('research', 'answer', 'format', 'facts', 'tasks') then o->>'kind' end;
  v_ids := array(select (x)::bigint from jsonb_array_elements_text(case when jsonb_typeof(o->'feedback') = 'array'
   then o->'feedback' else '[]' end) x where x ~ '^\d+$');
  v_id := case when o->>'id' ~* '^[0-9a-f-]{36}$' then (o->>'id')::uuid end;
  if o->>'op' = 'add' then
   v_scope := o->>'scope';
   v_client := case when v_scope = 'client' and o->>'client_id' ~* '^[0-9a-f-]{36}$' then (o->>'client_id')::uuid end;
   v_product := case when v_scope = 'product' and o->>'product_id' ~* '^[0-9a-f-]{36}$'
    then (o->>'product_id')::uuid end;
   continue when v_scope not in ('company', 'product', 'client') or length(v_text) not between 5 and 400
    or cardinality(v_ids) = 0 or (v_scope = 'client' and v_client is null) or (v_scope = 'product' and v_product is null);
   continue when v_scope = 'client' and not exists (select 1 from public.clients where company_id = p_company and id = v_client);
   continue when v_scope = 'product' and not exists (select 1 from public.products where company_id = p_company and id = v_product);
   continue when exists (select 1 from public.mavi_lessons l where l.company_id = p_company
    and lower(l.text) = lower(v_text));
   continue when (select count(*) from public.mavi_lessons l where l.company_id = p_company
    and l.status in ('active', 'candidate')) >= 200;
   insert into public.mavi_lessons(company_id, scope, client_id, product_id, kind, text, status, origin)
   values (p_company, v_scope, v_client, v_product, v_kind, v_text, 'candidate', 'mavi') returning id into v_id;
   perform mavi_private.mavi_lesson_evidence(v_id, v_ids);
   v_changed := v_changed + 1;
  elsif o->>'op' = 'update' and v_id is not null then
   update public.mavi_lessons l set text = case when length(v_text) between 5 and 400 then v_text else l.text end,
    kind = coalesce(v_kind, l.kind), updated_at = now(), updated_by = null,
    reviewed_at = case when length(v_text) between 5 and 400 and v_text <> l.text then null else l.reviewed_at end,
    reviewed_by = case when length(v_text) between 5 and 400 and v_text <> l.text then null else l.reviewed_by end
   where l.id = v_id and l.company_id = p_company and l.origin = 'mavi' and l.status in ('active', 'candidate');
   get diagnostics v_n = row_count;
   if v_n > 0 then
    perform mavi_private.mavi_lesson_evidence(v_id, v_ids);
    v_changed := v_changed + 1;
   end if;
  elsif o->>'op' = 'retire' and v_id is not null then
   delete from public.mavi_lessons l
   where l.id = v_id and l.company_id = p_company and l.origin = 'mavi' and l.status in ('active', 'candidate');
   get diagnostics v_n = row_count; v_changed := v_changed + v_n;
  end if;
 end loop;
 update public.mavi_feedback set learned_at = now()
 where company_id = p_company and id = any(coalesce(p_learned, '{}')) and learned_at is null;
 update mavi_private.mavi_learning_state s set built_at = now(), running_until = null, attempts = 0,
  last_error = null,
  dirty_at = case when exists (select 1 from public.mavi_feedback f where f.company_id = p_company
   and f.learned_at is null) then coalesce(greatest(s.dirty_at, s.claimed_at), now()) else null end
 where s.company_id = p_company;
 if p_usage is not null and jsonb_typeof(p_usage) = 'object' then
  insert into public.ai_usage(company_id, user_id, module, kind, model, input_tokens, output_tokens,
   cache_read_tokens, cache_write_tokens, cost_usd, provider_id, provider_name)
  values (p_company, null, 'mavi', 'learning', left(coalesce(p_usage->>'model', ''), 80),
   greatest(coalesce((p_usage->>'input')::integer, 0), 0), greatest(coalesce((p_usage->>'output')::integer, 0), 0),
   greatest(coalesce((p_usage->>'cache_read')::integer, 0), 0),
   greatest(coalesce((p_usage->>'cache_write')::integer, 0), 0),
   least(greatest(coalesce((p_usage->>'cost')::numeric, 0), 0), 100),
   case when p_usage->>'provider_id' ~* '^[0-9a-f-]{36}$' then (p_usage->>'provider_id')::uuid end,
   left(coalesce(p_usage->>'provider', ''), 120));
 end if;
 return v_changed;
end $$;

create function public.mavi_learning_fail(p_secret text, p_company uuid, p_error text) returns void
language plpgsql security definer set search_path = '' as $$ begin
 if not mavi_private.ai_secret_ok(p_secret) then raise exception 'Sem permissão' using errcode = '42501'; end if;
 update mavi_private.mavi_learning_state set attempts = attempts + 1, last_error = left(coalesce(p_error, ''), 500),
  running_until = now() + (attempts + 1) * interval '10 minutes'
 where company_id = p_company;
end $$;

-- O mesmo agendamento do Copiloto (a cada 10 min) acorda os dois aprendizados.
create or replace function mavi_private.ai_learning_kick() returns void
language plpgsql security definer set search_path = '' as $$
declare cfg mavi_private.ai_config; begin
 select * into cfg from mavi_private.ai_config where id;
 if not found then return; end if;
 if not exists (select 1 from mavi_private.copilot_learning_due())
  and not exists (select 1 from mavi_private.mavi_learning_due()) then return; end if;
 perform net.http_post(url := cfg.url, body := '{"action":"ai-learning"}'::jsonb,
  headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || cfg.secret),
  timeout_milliseconds := 60000);
end $$;

-- ------------------------------------------------------------ permissões
revoke all on function mavi_private.mavi_feedback_touch(), mavi_private.mavi_lesson_json(public.mavi_lessons),
 mavi_private.mavi_learning_due(), mavi_private.mavi_lesson_evidence(uuid, bigint[]), mavi_private.ai_learning_kick()
 from public, anon, authenticated;
revoke all on function public.mavi_feedback_vote(bigint, text, text, text), public.mavi_feedback_mine(uuid),
 public.mavi_learning_context(uuid, uuid, uuid),
 public.mavi_learning_report(uuid, date, date, text, integer, integer),
 public.mavi_lesson_save(uuid, uuid, text, uuid, uuid, text, text), public.mavi_lesson_set(uuid, uuid, text),
 public.ai_set_route(uuid, text, uuid, uuid, text, text)
 from public, anon;
grant execute on function public.mavi_feedback_vote(bigint, text, text, text), public.mavi_feedback_mine(uuid),
 public.mavi_learning_context(uuid, uuid, uuid),
 public.mavi_learning_report(uuid, date, date, text, integer, integer),
 public.mavi_lesson_save(uuid, uuid, text, uuid, uuid, text, text), public.mavi_lesson_set(uuid, uuid, text),
 public.ai_set_route(uuid, text, uuid, uuid, text, text)
 to authenticated;
-- O worker chama como anon + segredo.
revoke all on function public.mavi_learning_claim(text), public.mavi_learning_store(text, uuid, jsonb, bigint[], jsonb),
 public.mavi_learning_fail(text, uuid, text) from public, anon, authenticated;
grant execute on function public.mavi_learning_claim(text), public.mavi_learning_store(text, uuid, jsonb, bigint[], jsonb),
 public.mavi_learning_fail(text, uuid, text) to anon, authenticated;

commit;
