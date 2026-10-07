begin;

-- MAVI · roteador de modelos, fase 4 (pedido de 06/10/2026): o ciclo de
-- aprendizado. O roteador passa a escolher pelo desempenho real na empresa,
-- não só pela faixa do modelo.
--
-- 1. Amostra para a autoavaliação: além das respostas com sinal de problema,
--    uma fração das respostas sem sinal vai para o juiz (sinal "sample"),
--    para a qualidade medida não ver só os casos ruins. Até 30% do limite
--    diário do juiz.
-- 2. Testes fora do ar (decisão de 06/10/2026: nada ao vivo): para uma
--    amostra das respostas, um modelo candidato (o que o roteador escolheria,
--    ou um mais barato) responde a mesma pergunta em segundo plano, com as
--    mesmas fontes, e o juiz compara as duas às cegas (ai_route_evals). Com
--    teto de custo por dia.
-- 3. Ranking interno (ai_route_rank, a cada hora): por tipo de pedido ×
--    modelo, as respostas reais sem sinal ruim e os testes em que o
--    candidato foi tão bom ou melhor, com uma nota suavizada. Entra na
--    escolha do roteador (ai_route_context) e deixa descer de modelo quando
--    um mais barato provou que dá conta.
-- 4. O comportamento recente da pessoa: os tipos de pedido em que ela teve
--    duas ou mais respostas ruins nos últimos 14 dias sobem um degrau.
-- 5. A configuração (amostra, testes, teto) no Painel da MAVI › Roteamento,
--    com histórico de alterações.

-- ------------------------------------------------------------ configuração
alter table mavi_private.ai_router_settings
 add column judge_sample numeric(4,3) not null default 0.1 check (judge_sample between 0 and 0.5),
 add column eval_enabled boolean not null default true,
 add column eval_rate numeric(4,3) not null default 0.2 check (eval_rate between 0 and 1),
 add column eval_daily_cap numeric(8,4) not null default 0.5 check (eval_daily_cap between 0 and 20);

alter table mavi_private.ai_settings_log drop constraint ai_settings_log_field_check;
alter table mavi_private.ai_settings_log add constraint ai_settings_log_field_check
 check (field in ('model', 'effort', 'provider', 'name', 'kind', 'base_url', 'active', 'key', 'models', 'knowledge',
  'access', 'auto', 'mode', 'level', 'surface_levels', 'escalate', 'escalate_cap', 'providers', 'secret_providers',
  'sigiloso', 'judge_sample', 'eval_enabled', 'eval_rate', 'eval_daily_cap'));

-- A da migração 20270529090000, com os campos do aprendizado.
create or replace function mavi_private.ai_router_settings_log() returns trigger
language plpgsql security definer set search_path = '' as $$
declare f text; v_old jsonb; v_new jsonb; o jsonb; n jsonb; d jsonb := jsonb_build_object('mode', 'shadow',
 'level', 'equilibrado', 'surface_levels', '{}'::jsonb, 'escalate', true, 'escalate_cap', 0.5, 'judge_sample', 0.1,
 'eval_enabled', true, 'eval_rate', 0.2, 'eval_daily_cap', 0.5); begin
 if not exists (select 1 from public.companies where id = new.company_id) then return null; end if;
 o := case when tg_op = 'INSERT' then null else to_jsonb(old) end;
 n := to_jsonb(new);
 foreach f in array array['mode', 'level', 'surface_levels', 'escalate', 'escalate_cap', 'providers', 'secret_providers',
  'judge_sample', 'eval_enabled', 'eval_rate', 'eval_daily_cap'] loop
  v_old := o->f; v_new := n->f;
  -- A linha nasce com os padrões: só o que mudou de verdade entra.
  if tg_op = 'INSERT' then
   continue when v_new is null or v_new = 'null'
    or (jsonb_typeof(v_new) = 'number' and d ? f and (v_new)::numeric = (d->>f)::numeric)
    or (jsonb_typeof(v_new) <> 'number' and v_new = d->f);
  end if;
  continue when v_old is not distinct from v_new
   or (jsonb_typeof(v_new) = 'number' and jsonb_typeof(v_old) = 'number' and (v_old)::numeric = (v_new)::numeric);
  perform mavi_private.ai_log(new.company_id, 'router', '', '', f,
   case when tg_op = 'INSERT' then 'created' else 'changed' end,
   case when v_old is null then null else jsonb_build_object(f, v_old) end, jsonb_build_object(f, v_new));
 end loop;
 return null;
end $$;

create or replace function public.ai_router_get(p_company uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare s mavi_private.ai_router_settings; begin
 if not mavi_private.leader(p_company) then
  raise exception 'Só administradores e gestores configuram o roteador da MAVI.' using errcode = '42501';
 end if;
 select * into s from mavi_private.ai_router_settings where company_id = p_company;
 return jsonb_build_object(
  'mode', coalesce(s.mode, 'shadow'), 'level', coalesce(s.level, 'equilibrado'),
  'surface_levels', coalesce(s.surface_levels, '{}'), 'escalate', coalesce(s.escalate, true),
  'escalate_cap', coalesce(s.escalate_cap, 0.5), 'providers', to_jsonb(s.providers),
  'secret_providers', to_jsonb(s.secret_providers), 'judge_sample', coalesce(s.judge_sample, 0.1),
  'eval_enabled', coalesce(s.eval_enabled, true), 'eval_rate', coalesce(s.eval_rate, 0.2),
  'eval_daily_cap', coalesce(s.eval_daily_cap, 0.5), 'updated_at', s.updated_at,
  'scopes', (select coalesce(jsonb_agg(jsonb_build_object('type', x.scope_type, 'scope_id', x.scope_id,
    'level', x.level, 'providers', to_jsonb(x.providers), 'sigiloso', x.sigiloso, 'updated_at', x.updated_at)
    order by x.scope_type, x.updated_at), '[]') from mavi_private.ai_router_scopes x where x.company_id = p_company));
end $$;

-- A da migração 20270529090000, com os campos do aprendizado.
create or replace function public.ai_router_save(p_company uuid, p_settings jsonb) returns void
language plpgsql security definer set search_path = '' as $$
declare s jsonb := coalesce(p_settings, '{}'); v_levels jsonb; k text;
 v_providers uuid[]; v_secret uuid[]; begin
 if not mavi_private.leader(p_company) then
  raise exception 'Só administradores e gestores configuram o roteador da MAVI.' using errcode = '42501';
 end if;
 if s ? 'surface_levels' then
  v_levels := coalesce(s->'surface_levels', '{}');
  if jsonb_typeof(v_levels) <> 'object' then raise exception 'Níveis por tela inválidos.' using errcode = '22023'; end if;
  for k in select jsonb_object_keys(v_levels) loop
   if not mavi_private.ai_router_surface(k) or v_levels->>k not in ('economico', 'equilibrado', 'maxima') then
    raise exception 'Nível inválido para a tela %.', k using errcode = '22023';
   end if;
  end loop;
 end if;
 if s ? 'providers' and jsonb_typeof(s->'providers') = 'array' then
  v_providers := array(select x::uuid from jsonb_array_elements_text(s->'providers') x);
  if cardinality(v_providers) = 0 then
   raise exception 'Deixe pelo menos um provedor permitido.' using errcode = '22023';
  end if;
 end if;
 if s ? 'secret_providers' and jsonb_typeof(s->'secret_providers') = 'array' then
  v_secret := array(select x::uuid from jsonb_array_elements_text(s->'secret_providers') x);
 end if;
 perform mavi_private.ai_router_check_providers(p_company, v_providers);
 perform mavi_private.ai_router_check_providers(p_company, v_secret);
 insert into mavi_private.ai_router_settings(company_id) values (p_company) on conflict do nothing;
 update mavi_private.ai_router_settings set
  mode = case when s ? 'mode' then s->>'mode' else mode end,
  level = case when s ? 'level' then s->>'level' else level end,
  surface_levels = case when s ? 'surface_levels' then v_levels else surface_levels end,
  escalate = case when s ? 'escalate' then (s->>'escalate')::boolean else escalate end,
  escalate_cap = case when s ? 'escalate_cap' then (s->>'escalate_cap')::numeric else escalate_cap end,
  providers = case when s ? 'providers' then v_providers else providers end,
  secret_providers = case when s ? 'secret_providers' then v_secret else secret_providers end,
  judge_sample = case when s ? 'judge_sample' then (s->>'judge_sample')::numeric else judge_sample end,
  eval_enabled = case when s ? 'eval_enabled' then (s->>'eval_enabled')::boolean else eval_enabled end,
  eval_rate = case when s ? 'eval_rate' then (s->>'eval_rate')::numeric else eval_rate end,
  eval_daily_cap = case when s ? 'eval_daily_cap' then (s->>'eval_daily_cap')::numeric else eval_daily_cap end,
  updated_by = auth.uid(), updated_at = now()
 where company_id = p_company;
end $$;

-- ------------------------------------------------------------ amostra para o juiz
alter table public.mavi_answer_checks drop constraint if exists mavi_answer_checks_signals_check;
alter table public.mavi_answer_checks add constraint mavi_answer_checks_signals_check
 check (signals <@ array['capped', 'tool_errors', 'no_sources', 'announce', 'frustration', 'repeated',
  'down_unexplained', 'sample']::text[]);

-- A da migração 20270115090000, com a amostra.
create or replace function mavi_private.mavi_signal(p_message bigint, p_signals text[]) returns void
language plpgsql security definer set search_path = '' as $$
declare m public.ai_messages; c public.ai_conversations; v_signals text[]; begin
 select array(select distinct s from unnest(coalesce(p_signals, '{}')) s
  where s in ('capped', 'tool_errors', 'no_sources', 'announce', 'frustration', 'repeated', 'down_unexplained', 'sample'))
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

-- Uma resposta sem sinal entra no sorteio da amostra (só a de quem pergunta).
-- Devolve se entrou.
create function public.mavi_answer_sample(p_message bigint) returns boolean
language plpgsql security definer set search_path = '' as $$
declare v_company uuid; v_rate numeric; v_cap integer; begin
 select c.company_id into v_company from public.ai_messages m join public.ai_conversations c on c.id = m.conversation_id
 where m.id = p_message and m.role = 'assistant' and c.owner_id = auth.uid() and mavi_private.member(c.company_id);
 if v_company is null then raise exception 'Resposta não encontrada.' using errcode = 'P0002'; end if;
 if not (mavi_private.mavi_judge_config(v_company)->>'enabled')::boolean then return false; end if;
 select coalesce((select s.judge_sample from mavi_private.ai_router_settings s where s.company_id = v_company), 0.1)
 into v_rate;
 if v_rate <= 0 or random() >= v_rate then return false; end if;
 v_cap := greatest(1, floor((mavi_private.mavi_judge_config(v_company)->>'daily_limit')::integer * 0.3)::integer);
 if (select count(*) from public.mavi_answer_checks x where x.company_id = v_company and 'sample' = any(x.signals)
   and x.created_at > now() - interval '1 day') >= v_cap then return false; end if;
 perform mavi_private.mavi_signal(p_message, array['sample']);
 return true;
end $$;
revoke all on function public.mavi_answer_sample(bigint) from public, anon;
grant execute on function public.mavi_answer_sample(bigint) to authenticated;

-- ------------------------------------------------------------ testes fora do ar
create table public.ai_route_evals (
 id bigint generated always as identity primary key,
 company_id uuid not null references public.companies(id) on delete cascade,
 decision_id bigint references public.ai_route_decisions(id) on delete set null,
 message_id bigint not null,
 task_type text not null,
 complexity smallint not null,
 base_provider_id uuid,
 base_model text not null check (length(base_model) <= 120),
 candidate_provider_id uuid,
 candidate_model text not null check (length(candidate_model) <= 120),
 status text not null default 'pending' check (status in ('pending', 'done', 'error')),
 attempts smallint not null default 0,
 claimed_until timestamptz,
 -- Para o candidato: better (melhor que a resposta real), same, worse.
 verdict text check (verdict in ('better', 'same', 'worse')),
 confidence numeric(3,2) check (confidence between 0 and 1),
 explanation text check (length(explanation) <= 600),
 candidate_answer text check (length(candidate_answer) <= 8000),
 cost_usd numeric(12,6) not null default 0 check (cost_usd >= 0),
 last_error text check (length(last_error) <= 300),
 created_at timestamptz not null default now(),
 judged_at timestamptz
);
create index ai_route_evals_pending on public.ai_route_evals (company_id, created_at) where status = 'pending';
create index ai_route_evals_company on public.ai_route_evals (company_id, created_at desc);
alter table public.ai_route_evals enable row level security;
revoke all on public.ai_route_evals from public, anon, authenticated;
grant select on public.ai_route_evals to authenticated;
create policy ai_route_evals_read on public.ai_route_evals for select to authenticated
 using (company_id in (select mavi_private.leader_companies()));

create index if not exists ai_route_decisions_user on public.ai_route_decisions (company_id, user_id, created_at desc);

-- A da migração 20270529090000: com o roteador aprendendo, uma amostra das
-- respostas vira teste fora do ar com o candidato que o servidor indicou.
create or replace function public.ai_route_log(p_company uuid, p_entry jsonb) returns bigint
language plpgsql security definer set search_path = '' as $$
declare e jsonb := coalesce(p_entry, '{}'); v_client uuid; v_conv uuid; v_used uuid; v_sugg uuid; v_eval uuid;
 v_active boolean; v_mode text; v_id bigint; s mavi_private.ai_router_settings; begin
 if not mavi_private.member(p_company) then raise exception 'Sem permissão.' using errcode = '42501'; end if;
 v_client := nullif(e->>'client_id', '')::uuid;
 v_conv := nullif(e->>'conversation_id', '')::uuid;
 v_used := nullif(e->>'used_provider_id', '')::uuid;
 v_sugg := nullif(e->>'suggested_provider_id', '')::uuid;
 v_eval := nullif(e#>>'{eval_candidate,provider_id}', '')::uuid;
 if v_client is not null and not mavi_private.drive_can_read(p_company, v_client) then
  raise exception 'Sem permissão.' using errcode = '42501';
 end if;
 if v_conv is not null and not exists (select 1 from public.ai_conversations c
  where c.id = v_conv and c.company_id = p_company and c.owner_id = auth.uid()) then
  raise exception 'Conversa inválida.' using errcode = '22023';
 end if;
 if (e->>'message_id') is not null and (v_conv is null or not exists (select 1 from public.ai_messages m
  where m.id = (e->>'message_id')::bigint and m.conversation_id = v_conv and m.role = 'assistant')) then
  raise exception 'Mensagem inválida.' using errcode = '22023';
 end if;
 if exists (select 1 from unnest(array[v_used, v_sugg, v_eval]) x(id) where x.id is not null
  and not exists (select 1 from mavi_private.ai_providers p where p.id = x.id and p.company_id = p_company)) then
  raise exception 'Provedor inválido.' using errcode = '22023';
 end if;
 select * into s from mavi_private.ai_router_settings where company_id = p_company;
 v_active := coalesce(s.mode = 'active', false);
 v_mode := case when e->>'mode' = 'locked' then 'locked' when e->>'mode' = 'auto' and v_active then 'auto' else 'shadow' end;
 insert into public.ai_route_decisions(company_id, surface, feature, client_id, conversation_id, message_id,
  task_type, complexity, modalities, context_tokens, latency_class, why, mode, locked_by, need_tier,
  suggested_provider_id, suggested_model, reason, candidates, used_provider_id, used_model, first_token_ms,
  total_ms, rounds, cost_usd, tools_ok, tools_failed, capped, escalated, error)
 values (p_company, left(coalesce(e->>'surface', ''), 40), left(coalesce(e->>'feature', ''), 60), v_client, v_conv,
  (e->>'message_id')::bigint, e->>'task_type', (e->>'complexity')::smallint,
  coalesce((select array_agg(x) from jsonb_array_elements_text(e->'modalities') x), '{text}'),
  greatest(coalesce((e->>'context_tokens')::integer, 0), 0), coalesce(e->>'latency_class', 'normal'),
  coalesce((select array_agg(left(x, 120)) from (select x from jsonb_array_elements_text(e->'why') x limit 12) w), '{}'),
  v_mode, case when v_mode = 'locked' then e->>'locked_by' end, (e->>'need_tier')::smallint, v_sugg,
  left(e->>'suggested_model', 120), left(coalesce(e->>'reason', ''), 500),
  case when jsonb_typeof(e->'candidates') = 'array' then
   (select coalesce(jsonb_agg(c), '[]') from (select c from jsonb_array_elements(e->'candidates') c limit 12) t)
  else '[]' end,
  v_used, left(coalesce(e->>'used_model', ''), 120),
  case when (e->>'first_token_ms') is not null then greatest((e->>'first_token_ms')::integer, 0) end,
  greatest(coalesce((e->>'total_ms')::integer, 0), 0),
  least((e->>'rounds')::integer, 999)::smallint, least(greatest(coalesce((e->>'cost_usd')::numeric, 0), 0), 100),
  least(greatest(coalesce((e->>'tools_ok')::integer, 0), 0), 999), least(greatest(coalesce((e->>'tools_failed')::integer, 0), 0), 999),
  coalesce((e->>'capped')::boolean, false), coalesce((e->>'escalated')::boolean, false), left(e->>'error', 300))
 returning id into v_id;
 -- Teste fora do ar: resposta salva, sem falha, com candidato diferente, no sorteio e até 200 por dia.
 if coalesce(s.eval_enabled, true) and (e->>'message_id') is not null and e->>'error' is null
  and coalesce(e#>>'{eval_candidate,model}', '') <> '' and e#>>'{eval_candidate,model}' <> coalesce(e->>'used_model', '')
  and random() < coalesce(s.eval_rate, 0.2)
  and (select count(*) from public.ai_route_evals x where x.company_id = p_company and x.created_at > now() - interval '1 day') < 200
 then
  insert into public.ai_route_evals(company_id, decision_id, message_id, task_type, complexity, base_provider_id,
   base_model, candidate_provider_id, candidate_model)
  values (p_company, v_id, (e->>'message_id')::bigint, e->>'task_type', (e->>'complexity')::smallint, v_used,
   left(coalesce(e->>'used_model', ''), 120), v_eval, left(e#>>'{eval_candidate,model}', 120));
 end if;
 return v_id;
end $$;

-- O material de uma resposta (a pergunta, a resposta, os trechos das fontes
-- citadas, o cliente e o dossiê), como o juiz lê.
create function mavi_private.ai_message_material(p_message bigint) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare m public.ai_messages; c public.ai_conversations; v_client uuid; begin
 select * into m from public.ai_messages where id = p_message and role = 'assistant';
 if m.id is null then return null; end if;
 select * into c from public.ai_conversations where id = m.conversation_id;
 v_client := case when c.scope->>'client' ~* '^[0-9a-f-]{36}$' then (c.scope->>'client')::uuid end;
 if v_client is null and c.scope->>'contract' ~* '^[0-9a-f-]{36}$' then
  select ct.client_id into v_client from public.contracts ct where ct.id = (c.scope->>'contract')::uuid;
 end if;
 return jsonb_build_object(
  'question', (select left(u.content, 2000) from public.ai_messages u where u.conversation_id = m.conversation_id
    and u.role = 'user' and u.id < m.id order by u.id desc limit 1),
  'answer', left(coalesce(m.content, ''), 8000),
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
    where i.client_id = v_client and not i.dismissed order by i.pinned desc, i.seen_at desc nulls last limit 15) di));
end $$;
revoke all on function mavi_private.ai_message_material(bigint) from public, anon, authenticated;

-- As empresas com testes a fazer e teto do dia sobrando.
create function mavi_private.ai_route_eval_due() returns table(company_id uuid)
language sql stable security definer set search_path = '' as $$
 select distinct e.company_id from public.ai_route_evals e
 left join mavi_private.ai_router_settings s on s.company_id = e.company_id
 where e.status = 'pending' and e.attempts < 3 and (e.claimed_until is null or e.claimed_until < now())
  and e.created_at <= now() - interval '2 minutes'
  and coalesce(s.eval_enabled, true)
  and (select coalesce(sum(x.cost_usd), 0) from public.ai_route_evals x where x.company_id = e.company_id
   and x.judged_at > now() - interval '1 day') < coalesce(s.eval_daily_cap, 0.5)
$$;
revoke all on function mavi_private.ai_route_eval_due() from public, anon, authenticated;

create function public.ai_route_eval_claim(p_secret text, p_limit integer default 2) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare e public.ai_route_evals; v_out jsonb := '[]'; p mavi_private.ai_providers; begin
 if not mavi_private.ai_secret_ok(p_secret) then raise exception 'Sem permissão' using errcode = '42501'; end if;
 for e in select * from public.ai_route_evals x
  where x.company_id in (select d.company_id from mavi_private.ai_route_eval_due() d)
   and x.status = 'pending' and x.attempts < 3 and (x.claimed_until is null or x.claimed_until < now())
   and x.created_at <= now() - interval '2 minutes'
  order by x.created_at limit least(greatest(coalesce(p_limit, 2), 1), 5) for update skip locked
 loop
  update public.ai_route_evals set claimed_until = now() + interval '5 minutes', attempts = attempts + 1 where id = e.id;
  p := null;
  if e.candidate_provider_id is not null then
   select * into p from mavi_private.ai_providers v where v.id = e.candidate_provider_id and v.active;
   -- O provedor saiu ou foi desligado: o teste não vale mais.
   if p.id is null then
    update public.ai_route_evals set status = 'error', last_error = 'provedor indisponível', claimed_until = null where id = e.id;
    continue;
   end if;
  end if;
  v_out := v_out || jsonb_build_array(jsonb_build_object('id', e.id, 'company', e.company_id, 'message', e.message_id,
   'task_type', e.task_type, 'base_model', e.base_model, 'candidate_model', e.candidate_model,
   'candidate', case when p.id is null then null else jsonb_build_object('provider_id', p.id, 'provider', p.name,
     'kind', p.kind, 'base_url', p.base_url, 'key_cipher', p.key_cipher,
     'price', (select m from jsonb_array_elements(p.models) m where m->>'id' = e.candidate_model limit 1)) end,
   'material', mavi_private.ai_message_material(e.message_id)));
 end loop;
 return v_out;
end $$;
revoke all on function public.ai_route_eval_claim(text, integer) from public, anon, authenticated;
grant execute on function public.ai_route_eval_claim(text, integer) to anon, authenticated;

create function public.ai_route_eval_store(p_secret text, p_id bigint, p_answer text, p_verdict text,
 p_confidence numeric, p_explanation text, p_usage jsonb) returns void
language plpgsql security definer set search_path = '' as $$
declare e public.ai_route_evals; u jsonb; v_cost numeric := 0; begin
 if not mavi_private.ai_secret_ok(p_secret) then raise exception 'Sem permissão' using errcode = '42501'; end if;
 select * into e from public.ai_route_evals where id = p_id for update;
 if e.id is null then return; end if;
 for u in select * from jsonb_array_elements(case when jsonb_typeof(p_usage) = 'array' then p_usage else '[]' end) loop
  v_cost := v_cost + least(greatest(coalesce((u->>'cost')::numeric, 0), 0), 100);
  insert into public.ai_usage(company_id, user_id, module, kind, model, input_tokens, output_tokens,
   cache_read_tokens, cache_write_tokens, cost_usd, provider_id, provider_name)
  values (e.company_id, null, 'mavi', 'route_eval', left(coalesce(u->>'model', ''), 80),
   greatest(coalesce((u->>'input')::integer, 0), 0), greatest(coalesce((u->>'output')::integer, 0), 0),
   greatest(coalesce((u->>'cache_read')::integer, 0), 0), greatest(coalesce((u->>'cache_write')::integer, 0), 0),
   least(greatest(coalesce((u->>'cost')::numeric, 0), 0), 100),
   (select v.id from mavi_private.ai_providers v where v.id = nullif(u->>'provider_id', '')::uuid and v.company_id = e.company_id),
   left(coalesce(u->>'provider', ''), 80));
 end loop;
 update public.ai_route_evals set status = 'done', claimed_until = null, last_error = null, judged_at = now(),
  verdict = case when p_verdict in ('better', 'same', 'worse') then p_verdict end,
  confidence = least(greatest(coalesce(p_confidence, 0.5), 0), 1),
  explanation = left(btrim(coalesce(p_explanation, '')), 600), candidate_answer = left(coalesce(p_answer, ''), 8000),
  cost_usd = v_cost
 where id = p_id;
end $$;
revoke all on function public.ai_route_eval_store(text, bigint, text, text, numeric, text, jsonb) from public, anon, authenticated;
grant execute on function public.ai_route_eval_store(text, bigint, text, text, numeric, text, jsonb) to anon, authenticated;

create function public.ai_route_eval_fail(p_secret text, p_id bigint, p_error text) returns void
language plpgsql security definer set search_path = '' as $$ begin
 if not mavi_private.ai_secret_ok(p_secret) then raise exception 'Sem permissão' using errcode = '42501'; end if;
 update public.ai_route_evals set claimed_until = null, last_error = left(coalesce(p_error, ''), 300),
  status = case when attempts >= 3 then 'error' else 'pending' end
 where id = p_id;
end $$;
revoke all on function public.ai_route_eval_fail(text, bigint, text) from public, anon, authenticated;
grant execute on function public.ai_route_eval_fail(text, bigint, text) to anon, authenticated;

-- O agendamento do aprendizado acorda também para os testes fora do ar.
create or replace function mavi_private.ai_learning_kick() returns void
language plpgsql security definer set search_path = '' as $$
declare cfg mavi_private.ai_config; begin
 select * into cfg from mavi_private.ai_config where id;
 if not found then return; end if;
 if not exists (select 1 from mavi_private.copilot_learning_due())
  and not exists (select 1 from mavi_private.mavi_learning_due())
  and not exists (select 1 from mavi_private.mavi_judge_due())
  and not exists (select 1 from mavi_private.mavi_person_due())
  and not exists (select 1 from mavi_private.ai_route_eval_due()) then return; end if;
 perform net.http_post(url := cfg.url, body := '{"action":"ai-learning"}'::jsonb,
  headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || cfg.secret),
  timeout_milliseconds := 60000);
end $$;

-- ------------------------------------------------------------ ranking interno
create table mavi_private.ai_route_rank (
 company_id uuid not null references public.companies(id) on delete cascade,
 task_type text not null,
 model text not null,
 live_n integer not null default 0,
 live_good integer not null default 0,
 eval_n integer not null default 0,
 eval_ok integer not null default 0,
 quality numeric(4,3) not null,
 refreshed_at timestamptz not null default now(),
 primary key (company_id, task_type, model)
);
alter table mavi_private.ai_route_rank enable row level security;
revoke all on mavi_private.ai_route_rank from public, anon, authenticated;

-- Os últimos 60 dias: respostas reais (sem 👎, sem reprovação do juiz, sem
-- ferramenta com erro, limite de passos, falha, reclamação ou repetição na
-- pergunta seguinte) e testes fora do ar (o candidato tão bom ou melhor, com
-- confiança). Nota suavizada: (boas + 0,85 × 5) ÷ (total + 5).
create function mavi_private.ai_route_rank_refresh(p_company uuid default null) returns integer
language plpgsql security definer set search_path = '' as $$
declare n integer; begin
 delete from mavi_private.ai_route_rank where p_company is null or company_id = p_company;
 insert into mavi_private.ai_route_rank(company_id, task_type, model, live_n, live_good, eval_n, eval_ok, quality)
 with live as (
  select d.company_id, d.task_type, d.used_model as model, count(*) as n,
   count(*) filter (where d.tools_failed = 0 and not d.capped and d.error is null
    and not exists (select 1 from public.mavi_feedback f where f.message_id = d.message_id and f.vote = 'down')
    and not exists (select 1 from public.mavi_answer_checks k where k.message_id = d.message_id
     and (k.signals && array['frustration', 'repeated']
      or (k.status = 'done' and coalesce((k.verdict->>'ok')::boolean, true) = false
       and coalesce((k.verdict->>'confidence')::numeric, 0) >= 0.6)))) as good
  from public.ai_route_decisions d
  where d.created_at > now() - interval '60 days' and d.used_model <> ''
   and (p_company is null or d.company_id = p_company)
  group by 1, 2, 3),
 ev as (
  select e.company_id, e.task_type, e.candidate_model as model, count(*) as n,
   count(*) filter (where e.verdict in ('better', 'same') and coalesce(e.confidence, 0) >= 0.5) as ok
  from public.ai_route_evals e
  where e.status = 'done' and e.verdict is not null and e.judged_at > now() - interval '60 days'
   and (p_company is null or e.company_id = p_company)
  group by 1, 2, 3)
 select coalesce(l.company_id, v.company_id), coalesce(l.task_type, v.task_type), coalesce(l.model, v.model),
  coalesce(l.n, 0), coalesce(l.good, 0), coalesce(v.n, 0), coalesce(v.ok, 0),
  round((coalesce(l.good, 0) + coalesce(v.ok, 0) + 0.85 * 5)::numeric / (coalesce(l.n, 0) + coalesce(v.n, 0) + 5), 3)
 from live l full join ev v on v.company_id = l.company_id and v.task_type = l.task_type and v.model = l.model;
 get diagnostics n = row_count;
 return n;
end $$;
revoke all on function mavi_private.ai_route_rank_refresh(uuid) from public, anon, authenticated;

do $$ begin
 if exists (select 1 from pg_extension where extname = 'pg_cron') then
  perform cron.schedule('mavi-route-rank', '17 * * * *', 'select mavi_private.ai_route_rank_refresh();');
 end if;
end $$;

-- Para o painel (líderes): o ranking e os últimos testes fora do ar.
create function public.ai_route_learning(p_company uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$ begin
 if not mavi_private.leader(p_company) then
  raise exception 'Só administradores e gestores veem o desempenho dos modelos.' using errcode = '42501';
 end if;
 return jsonb_build_object(
  'refreshed_at', (select max(r.refreshed_at) from mavi_private.ai_route_rank r where r.company_id = p_company),
  'rank', (select coalesce(jsonb_agg(jsonb_build_object('task_type', r.task_type, 'model', r.model, 'live_n', r.live_n,
    'live_good', r.live_good, 'eval_n', r.eval_n, 'eval_ok', r.eval_ok, 'quality', r.quality)
    order by r.task_type, r.quality desc, r.live_n + r.eval_n desc), '[]')
   from mavi_private.ai_route_rank r where r.company_id = p_company),
  'evals', (select coalesce(jsonb_agg(jsonb_build_object('id', e.id, 'at', e.created_at, 'task_type', e.task_type,
    'complexity', e.complexity, 'base_model', e.base_model, 'candidate_model', e.candidate_model, 'status', e.status,
    'verdict', e.verdict, 'confidence', e.confidence, 'explanation', e.explanation, 'cost_usd', e.cost_usd,
    'question', (select left(u.content, 300) from public.ai_messages m join public.ai_messages u
      on u.conversation_id = m.conversation_id and u.role = 'user' and u.id < m.id
      where m.id = e.message_id order by u.id desc limit 1)) order by e.id desc), '[]')
   from (select * from public.ai_route_evals x where x.company_id = p_company order by x.id desc limit 30) e),
  'spent_today', (select coalesce(sum(x.cost_usd), 0) from public.ai_route_evals x where x.company_id = p_company
   and x.judged_at > now() - interval '1 day'),
  'samples_today', (select count(*) from public.mavi_answer_checks x where x.company_id = p_company
   and 'sample' = any(x.signals) and x.created_at > now() - interval '1 day'));
end $$;
revoke all on function public.ai_route_learning(uuid) from public, anon;
grant execute on function public.ai_route_learning(uuid) to authenticated;

-- Atualizar agora (líderes), sem esperar a hora cheia.
create function public.ai_route_rank_now(p_company uuid) returns integer
language plpgsql security definer set search_path = '' as $$ begin
 if not mavi_private.leader(p_company) then
  raise exception 'Só administradores e gestores atualizam o ranking.' using errcode = '42501';
 end if;
 return mavi_private.ai_route_rank_refresh(p_company);
end $$;
revoke all on function public.ai_route_rank_now(uuid) from public, anon;
grant execute on function public.ai_route_rank_now(uuid) to authenticated;

-- A da migração 20270529090000, com o ranking da empresa e os tipos de
-- pedido em que a pessoa teve respostas ruins há pouco.
create or replace function public.ai_route_context(p_company uuid, p_client uuid, p_contract uuid, p_project uuid,
 p_surface text default null) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_client uuid := p_client; v_contract uuid := p_contract; s mavi_private.ai_router_settings;
 u mavi_private.ai_router_scopes; c mavi_private.ai_router_scopes; k mavi_private.ai_router_scopes;
 v_allowed uuid[]; v_sig boolean; v_level text; begin
 if not mavi_private.member(p_company) then raise exception 'Sem acesso ao espaço' using errcode = '42501'; end if;
 if p_project is not null then
  select coalesce(pr.contract_id, v_contract) into v_contract from public.projects pr
  where pr.id = p_project and pr.company_id = p_company;
 end if;
 if v_contract is not null then
  select coalesce(x.client_id, v_client) into v_client from public.contracts x
  where x.id = v_contract and x.company_id = p_company;
 end if;
 if v_client is not null and not mavi_private.drive_can_read(p_company, v_client) then
  v_client := null; v_contract := null;
 end if;
 select * into s from mavi_private.ai_router_settings where company_id = p_company;
 select * into u from mavi_private.ai_router_scopes where company_id = p_company and scope_type = 'user' and scope_id = auth.uid();
 select * into c from mavi_private.ai_router_scopes where company_id = p_company and scope_type = 'client' and scope_id = v_client;
 select * into k from mavi_private.ai_router_scopes where company_id = p_company and scope_type = 'contract' and scope_id = v_contract;
 v_level := coalesce(k.level, c.level, u.level,
  case when mavi_private.ai_router_surface(p_surface) then s.surface_levels->>p_surface end, s.level, 'equilibrado');
 v_allowed := mavi_private.ai_router_meet(mavi_private.ai_router_meet(mavi_private.ai_router_meet(s.providers, u.providers),
  c.providers), k.providers);
 v_sig := coalesce(c.sigiloso, false) or coalesce(k.sigiloso, false);
 if v_sig then v_allowed := mavi_private.ai_router_meet(v_allowed, s.secret_providers); end if;
 return jsonb_build_object(
  'mode', coalesce(s.mode, 'shadow'), 'level', v_level, 'escalate', coalesce(s.escalate, true),
  'escalate_cap', coalesce(s.escalate_cap, 0.5), 'sigiloso', v_sig, 'restricted', v_allowed is not null,
  'server', v_allowed is null or '00000000-0000-0000-0000-000000000000'::uuid = any(v_allowed),
  'candidates', (select coalesce(jsonb_agg(jsonb_build_object('provider_id', p.id, 'name', p.name, 'kind', p.kind,
    'base_url', p.base_url, 'key_cipher', p.key_cipher, 'models', p.models) order by p.name), '[]')
   from mavi_private.ai_providers p
   where p.company_id = p_company and p.active and (v_allowed is null or p.id = any(v_allowed))),
  'stats', (select coalesce(jsonb_agg(jsonb_build_object('task_type', r.task_type, 'model', r.model,
    'n', r.live_n + r.eval_n, 'quality', r.quality)), '[]')
   from mavi_private.ai_route_rank r where r.company_id = p_company and r.live_n + r.eval_n >= 5),
  'person_bad', (select coalesce(jsonb_agg(t.task_type), '[]') from (
    select d.task_type from public.ai_route_decisions d
    where d.company_id = p_company and d.user_id = auth.uid() and d.created_at > now() - interval '14 days'
     and d.message_id is not null
     and (exists (select 1 from public.mavi_feedback f where f.message_id = d.message_id and f.vote = 'down')
      or exists (select 1 from public.mavi_answer_checks x where x.message_id = d.message_id
       and x.signals && array['frustration', 'repeated']))
    group by d.task_type having count(*) >= 2) t));
end $$;

commit;
