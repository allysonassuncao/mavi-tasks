begin;

-- MAVI · roteador de modelos, fase 5 (pedido de 06/10/2026): o conjunto de
-- avaliação da empresa.
--
-- 1. Casos (ai_eval_cases): perguntas reais com a resposta de referência. A
--    partir de uma resposta aprovada (👍), o caso guarda a pergunta, a
--    resposta como referência (editável) e o material que ela usou (os
--    trechos das fontes citadas e o dossiê do cliente, congelados: o teste
--    se repete igual meses depois). Ou à mão, com o material de apoio
--    colado. Só líderes veem e editam.
-- 2. Testes (ai_eval_runs + ai_eval_results): um líder escolhe um modelo e
--    testa; em segundo plano (no agendamento do aprendizado) o modelo
--    responde cada caso com o material, e o juiz dá a nota comparando com a
--    referência (o que faltou, o que errou). Teto de custo por teste.
-- 3. Liberação: com ela ligada, o roteador (no automático) só usa modelos
--    aprovados no conjunto com a nota mínima; as regras travadas continuam
--    valendo. Sem nenhum aprovado, segue com todos (e avisa no motivo).

-- ------------------------------------------------------------ casos
create table public.ai_eval_cases (
 id uuid primary key default gen_random_uuid(),
 company_id uuid not null references public.companies(id) on delete cascade,
 question text not null check (length(btrim(question)) between 3 and 4000),
 reference text not null check (length(btrim(reference)) between 3 and 12000),
 -- O material congelado (da resposta de origem) ou o de apoio colado à mão.
 material jsonb,
 context text check (length(context) <= 20000),
 client_id uuid references public.clients(id) on delete set null,
 -- Preenchido pelo worker no primeiro teste (a mesma leitura do roteador).
 task_type text,
 origin text not null default 'manual' check (origin in ('manual', 'answer')),
 message_id bigint,
 active boolean not null default true,
 created_by uuid default auth.uid(),
 created_at timestamptz not null default now(),
 updated_by uuid default auth.uid(),
 updated_at timestamptz not null default now()
);
create index ai_eval_cases_company on public.ai_eval_cases (company_id, created_at desc);
create unique index ai_eval_cases_message on public.ai_eval_cases (company_id, message_id) where message_id is not null;
alter table public.ai_eval_cases enable row level security;
revoke all on public.ai_eval_cases from public, anon, authenticated;
grant select on public.ai_eval_cases to authenticated;
create policy ai_eval_cases_read on public.ai_eval_cases for select to authenticated
 using (company_id in (select mavi_private.leader_companies()));

create table public.ai_eval_runs (
 id uuid primary key default gen_random_uuid(),
 company_id uuid not null references public.companies(id) on delete cascade,
 -- Nulo: a Claude do servidor.
 provider_id uuid,
 provider_name text not null default '',
 model text not null check (length(model) between 1 and 120),
 status text not null default 'running' check (status in ('running', 'done', 'cancelled')),
 cases_total integer not null default 0,
 cases_done integer not null default 0,
 cases_failed integer not null default 0,
 score numeric(4,3),
 passed integer not null default 0,
 cost_usd numeric(12,6) not null default 0,
 cap_usd numeric(8,4) not null check (cap_usd between 0.05 and 50),
 avg_ms integer,
 created_by uuid default auth.uid(),
 created_at timestamptz not null default now(),
 finished_at timestamptz
);
create index ai_eval_runs_company on public.ai_eval_runs (company_id, created_at desc);
alter table public.ai_eval_runs enable row level security;
revoke all on public.ai_eval_runs from public, anon, authenticated;
grant select on public.ai_eval_runs to authenticated;
create policy ai_eval_runs_read on public.ai_eval_runs for select to authenticated
 using (company_id in (select mavi_private.leader_companies()));

create table public.ai_eval_results (
 id bigint generated always as identity primary key,
 run_id uuid not null references public.ai_eval_runs(id) on delete cascade,
 case_id uuid references public.ai_eval_cases(id) on delete set null,
 company_id uuid not null references public.companies(id) on delete cascade,
 status text not null default 'pending' check (status in ('pending', 'done', 'error', 'skipped')),
 attempts smallint not null default 0,
 claimed_until timestamptz,
 answer text check (length(answer) <= 12000),
 -- 0 a 1; aprovado com 0,7 ou mais.
 score numeric(4,3) check (score between 0 and 1),
 passed boolean,
 explanation text check (length(explanation) <= 800),
 ms integer,
 cost_usd numeric(12,6) not null default 0,
 last_error text check (length(last_error) <= 300),
 judged_at timestamptz
);
create index ai_eval_results_pending on public.ai_eval_results (company_id, id) where status = 'pending';
create index ai_eval_results_run on public.ai_eval_results (run_id);
alter table public.ai_eval_results enable row level security;
revoke all on public.ai_eval_results from public, anon, authenticated;

-- ------------------------------------------------------------ liberação
alter table mavi_private.ai_router_settings
 add column gate_enabled boolean not null default false,
 add column gate_min numeric(4,3) not null default 0.8 check (gate_min between 0.3 and 1);

alter table mavi_private.ai_settings_log drop constraint ai_settings_log_field_check;
alter table mavi_private.ai_settings_log add constraint ai_settings_log_field_check
 check (field in ('model', 'effort', 'provider', 'name', 'kind', 'base_url', 'active', 'key', 'models', 'knowledge',
  'access', 'auto', 'mode', 'level', 'surface_levels', 'escalate', 'escalate_cap', 'providers', 'secret_providers',
  'sigiloso', 'judge_sample', 'eval_enabled', 'eval_rate', 'eval_daily_cap', 'gate_enabled', 'gate_min'));

-- A da migração 20270531090000, com a liberação.
create or replace function mavi_private.ai_router_settings_log() returns trigger
language plpgsql security definer set search_path = '' as $$
declare f text; v_old jsonb; v_new jsonb; o jsonb; n jsonb; d jsonb := jsonb_build_object('mode', 'shadow',
 'level', 'equilibrado', 'surface_levels', '{}'::jsonb, 'escalate', true, 'escalate_cap', 0.5, 'judge_sample', 0.1,
 'eval_enabled', true, 'eval_rate', 0.2, 'eval_daily_cap', 0.5, 'gate_enabled', false, 'gate_min', 0.8); begin
 if not exists (select 1 from public.companies where id = new.company_id) then return null; end if;
 o := case when tg_op = 'INSERT' then null else to_jsonb(old) end;
 n := to_jsonb(new);
 foreach f in array array['mode', 'level', 'surface_levels', 'escalate', 'escalate_cap', 'providers', 'secret_providers',
  'judge_sample', 'eval_enabled', 'eval_rate', 'eval_daily_cap', 'gate_enabled', 'gate_min'] loop
  v_old := o->f; v_new := n->f;
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
  'eval_daily_cap', coalesce(s.eval_daily_cap, 0.5), 'gate_enabled', coalesce(s.gate_enabled, false),
  'gate_min', coalesce(s.gate_min, 0.8), 'updated_at', s.updated_at,
  'scopes', (select coalesce(jsonb_agg(jsonb_build_object('type', x.scope_type, 'scope_id', x.scope_id,
    'level', x.level, 'providers', to_jsonb(x.providers), 'sigiloso', x.sigiloso, 'updated_at', x.updated_at)
    order by x.scope_type, x.updated_at), '[]') from mavi_private.ai_router_scopes x where x.company_id = p_company));
end $$;

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
  gate_enabled = case when s ? 'gate_enabled' then (s->>'gate_enabled')::boolean else gate_enabled end,
  gate_min = case when s ? 'gate_min' then (s->>'gate_min')::numeric else gate_min end,
  updated_by = auth.uid(), updated_at = now()
 where company_id = p_company;
end $$;

-- A nota mais recente de cada modelo no conjunto (testes terminados).
create function mavi_private.ai_eval_latest(p_company uuid) returns table(provider_id uuid, model text, score numeric,
 run_id uuid, finished_at timestamptz)
language sql stable security definer set search_path = '' as $$
 select distinct on (r.provider_id, r.model) r.provider_id, r.model, r.score, r.id, r.finished_at
 from public.ai_eval_runs r
 where r.company_id = p_company and r.status = 'done' and r.score is not null and r.cases_done > 0
 order by r.provider_id, r.model, r.finished_at desc
$$;
revoke all on function mavi_private.ai_eval_latest(uuid) from public, anon, authenticated;

-- ------------------------------------------------------------ casos (líderes)
create function public.ai_eval_case_save(p_company uuid, p_id uuid, p_question text, p_reference text,
 p_client uuid, p_context text, p_active boolean default true) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_id uuid; begin
 if not mavi_private.leader(p_company) then
  raise exception 'Só administradores e gestores cuidam do conjunto de avaliação.' using errcode = '42501';
 end if;
 if length(btrim(coalesce(p_question, ''))) < 3 then raise exception 'Escreva a pergunta.' using errcode = '22023'; end if;
 if length(btrim(coalesce(p_reference, ''))) < 3 then
  raise exception 'Escreva a resposta de referência (ou o que ela precisa ter).' using errcode = '22023';
 end if;
 if p_client is not null and not exists (select 1 from public.clients where id = p_client and company_id = p_company) then
  raise exception 'Cliente não encontrado.' using errcode = 'P0002';
 end if;
 if p_id is null then
  insert into public.ai_eval_cases(company_id, question, reference, client_id, context, active)
  values (p_company, btrim(p_question), btrim(p_reference), p_client, nullif(btrim(coalesce(p_context, '')), ''),
   coalesce(p_active, true))
  returning id into v_id;
 else
  update public.ai_eval_cases set question = btrim(p_question), reference = btrim(p_reference), client_id = p_client,
   context = nullif(btrim(coalesce(p_context, '')), ''), active = coalesce(p_active, true),
   -- A pergunta mudou: a leitura do tipo de pedido refaz no próximo teste.
   task_type = case when question = btrim(p_question) then task_type end,
   updated_by = auth.uid(), updated_at = now()
  where id = p_id and company_id = p_company
  returning id into v_id;
  if v_id is null then raise exception 'Caso não encontrado.' using errcode = 'P0002'; end if;
 end if;
 return v_id;
end $$;
revoke all on function public.ai_eval_case_save(uuid, uuid, text, text, uuid, text, boolean) from public, anon;
grant execute on function public.ai_eval_case_save(uuid, uuid, text, text, uuid, text, boolean) to authenticated;

-- Um caso a partir de uma resposta da MAVI: a pergunta, a resposta como
-- referência e o material congelado.
create function public.ai_eval_case_from_message(p_company uuid, p_message bigint) returns uuid
language plpgsql security definer set search_path = '' as $$
declare m public.ai_messages; mat jsonb; v_client uuid; v_id uuid; begin
 if not mavi_private.leader(p_company) then
  raise exception 'Só administradores e gestores cuidam do conjunto de avaliação.' using errcode = '42501';
 end if;
 select * into m from public.ai_messages where id = p_message and role = 'assistant' and company_id = p_company;
 if m.id is null then raise exception 'Resposta não encontrada.' using errcode = 'P0002'; end if;
 select id into v_id from public.ai_eval_cases where company_id = p_company and message_id = p_message;
 if v_id is not null then return v_id; end if;
 mat := mavi_private.ai_message_material(p_message);
 if coalesce(mat->>'question', '') = '' then raise exception 'A resposta não tem pergunta.' using errcode = '22023'; end if;
 select case when c.scope->>'client' ~* '^[0-9a-f-]{36}$' then (c.scope->>'client')::uuid end into v_client
 from public.ai_conversations c where c.id = m.conversation_id;
 insert into public.ai_eval_cases(company_id, question, reference, material, client_id, origin, message_id)
 values (p_company, left(mat->>'question', 4000), left(coalesce(nullif(btrim(m.content), ''), '-'), 12000),
  jsonb_build_object('client', mat->'client', 'sources', mat->'sources', 'dossier', mat->'dossier'),
  (select x.id from public.clients x where x.id = v_client and x.company_id = p_company), 'answer', p_message)
 returning id into v_id;
 return v_id;
end $$;
revoke all on function public.ai_eval_case_from_message(uuid, bigint) from public, anon;
grant execute on function public.ai_eval_case_from_message(uuid, bigint) to authenticated;

create function public.ai_eval_case_delete(p_company uuid, p_id uuid) returns void
language plpgsql security definer set search_path = '' as $$ begin
 if not mavi_private.leader(p_company) then
  raise exception 'Só administradores e gestores cuidam do conjunto de avaliação.' using errcode = '42501';
 end if;
 delete from public.ai_eval_cases where id = p_id and company_id = p_company;
end $$;
revoke all on function public.ai_eval_case_delete(uuid, uuid) from public, anon;
grant execute on function public.ai_eval_case_delete(uuid, uuid) to authenticated;

-- O conjunto, as sugestões (respostas com 👍 dos últimos 60 dias que ainda
-- não viraram caso), os testes e a nota mais recente de cada modelo.
create function public.ai_eval_overview(p_company uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$ begin
 if not mavi_private.leader(p_company) then
  raise exception 'Só administradores e gestores cuidam do conjunto de avaliação.' using errcode = '42501';
 end if;
 return jsonb_build_object(
  'cases', (select coalesce(jsonb_agg(jsonb_build_object('id', c.id, 'question', c.question, 'reference', c.reference,
    'context', c.context, 'client_id', c.client_id, 'task_type', c.task_type, 'origin', c.origin, 'active', c.active,
    'sources', coalesce(jsonb_array_length(c.material->'sources'), 0), 'updated_at', c.updated_at)
    order by c.created_at desc), '[]') from public.ai_eval_cases c where c.company_id = p_company),
  'suggestions', (select coalesce(jsonb_agg(jsonb_build_object('message', f.message_id, 'question', left(f.question, 300),
    'answer', left(f.answer, 400), 'at', f.updated_at) order by f.updated_at desc), '[]') from (
    select distinct on (f.message_id) f.message_id, f.question, f.answer, f.updated_at from public.mavi_feedback f
    where f.company_id = p_company and f.vote = 'up' and f.updated_at > now() - interval '60 days'
     and not exists (select 1 from public.ai_eval_cases c where c.company_id = p_company and c.message_id = f.message_id)
     and not exists (select 1 from public.mavi_feedback d where d.message_id = f.message_id and d.vote = 'down')
    order by f.message_id, f.updated_at desc limit 30) f),
  'runs', (select coalesce(jsonb_agg(jsonb_build_object('id', r.id, 'provider_id', r.provider_id,
    'provider', r.provider_name, 'model', r.model, 'status', r.status, 'cases_total', r.cases_total,
    'cases_done', r.cases_done, 'cases_failed', r.cases_failed, 'score', r.score, 'passed', r.passed,
    'cost_usd', r.cost_usd, 'cap_usd', r.cap_usd, 'avg_ms', r.avg_ms, 'created_by', r.created_by,
    'created_at', r.created_at, 'finished_at', r.finished_at) order by r.created_at desc), '[]')
   from (select * from public.ai_eval_runs x where x.company_id = p_company order by x.created_at desc limit 20) r),
  'latest', (select coalesce(jsonb_agg(jsonb_build_object('provider_id', l.provider_id, 'model', l.model,
    'score', l.score, 'run_id', l.run_id, 'finished_at', l.finished_at)), '[]') from mavi_private.ai_eval_latest(p_company) l));
end $$;
revoke all on function public.ai_eval_overview(uuid) from public, anon;
grant execute on function public.ai_eval_overview(uuid) to authenticated;

-- Testar um modelo com os casos ativos (até 100), com teto de custo.
create function public.ai_eval_run_start(p_company uuid, p_provider uuid, p_model text, p_cap numeric) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_id uuid; v_name text := 'Servidor'; n integer; begin
 if not mavi_private.leader(p_company) then
  raise exception 'Só administradores e gestores testam modelos.' using errcode = '42501';
 end if;
 if p_provider is not null then
  select p.name into v_name from mavi_private.ai_providers p where p.id = p_provider and p.company_id = p_company
   and p.active and exists (select 1 from jsonb_array_elements(p.models) m where m->>'id' = p_model);
  if v_name is null then raise exception 'Escolha um modelo de um provedor ligado.' using errcode = '22023'; end if;
 elsif coalesce(p_model, '') !~ '^claude-[a-z0-9.-]+$' then
  raise exception 'Escolha um modelo da Claude do servidor.' using errcode = '22023';
 end if;
 if p_cap is null or p_cap < 0.05 or p_cap > 50 then
  raise exception 'O teto vai de US$ 0,05 a US$ 50.' using errcode = '22023';
 end if;
 if exists (select 1 from public.ai_eval_runs r where r.company_id = p_company and r.status = 'running'
   and r.provider_id is not distinct from p_provider and r.model = p_model) then
  raise exception 'Este modelo já está em teste.' using errcode = '22023';
 end if;
 select count(*) into n from public.ai_eval_cases c where c.company_id = p_company and c.active;
 if n = 0 then raise exception 'Ative pelo menos um caso no conjunto.' using errcode = '22023'; end if;
 insert into public.ai_eval_runs(company_id, provider_id, provider_name, model, cap_usd, cases_total)
 values (p_company, p_provider, v_name, p_model, p_cap, least(n, 100))
 returning id into v_id;
 insert into public.ai_eval_results(run_id, case_id, company_id)
 select v_id, c.id, p_company from public.ai_eval_cases c
 where c.company_id = p_company and c.active order by c.created_at desc limit 100;
 return v_id;
end $$;
revoke all on function public.ai_eval_run_start(uuid, uuid, text, numeric) from public, anon;
grant execute on function public.ai_eval_run_start(uuid, uuid, text, numeric) to authenticated;

-- Fecha o teste: a nota média, os aprovados e a espera média dos que terminaram.
create function mavi_private.ai_eval_finish(p_run uuid, p_status text) returns void
language plpgsql security definer set search_path = '' as $$ begin
 update public.ai_eval_results set status = 'skipped', claimed_until = null
 where run_id = p_run and status = 'pending';
 update public.ai_eval_runs r set status = p_status, finished_at = now(),
  cases_done = (select count(*) from public.ai_eval_results x where x.run_id = r.id and x.status = 'done'),
  cases_failed = (select count(*) from public.ai_eval_results x where x.run_id = r.id and x.status in ('error', 'skipped')),
  score = (select round(avg(x.score), 3) from public.ai_eval_results x where x.run_id = r.id and x.status = 'done'),
  passed = (select count(*) from public.ai_eval_results x where x.run_id = r.id and x.status = 'done' and x.passed),
  avg_ms = (select round(avg(x.ms))::integer from public.ai_eval_results x where x.run_id = r.id and x.status = 'done')
 where r.id = p_run and r.status = 'running';
end $$;
revoke all on function mavi_private.ai_eval_finish(uuid, text) from public, anon, authenticated;

create function public.ai_eval_run_cancel(p_company uuid, p_run uuid) returns void
language plpgsql security definer set search_path = '' as $$ begin
 if not mavi_private.leader(p_company) then
  raise exception 'Só administradores e gestores testam modelos.' using errcode = '42501';
 end if;
 if not exists (select 1 from public.ai_eval_runs where id = p_run and company_id = p_company) then
  raise exception 'Teste não encontrado.' using errcode = 'P0002';
 end if;
 perform mavi_private.ai_eval_finish(p_run, 'cancelled');
end $$;
revoke all on function public.ai_eval_run_cancel(uuid, uuid) from public, anon;
grant execute on function public.ai_eval_run_cancel(uuid, uuid) to authenticated;

-- O resultado de um teste, caso a caso (os que não passaram primeiro).
create function public.ai_eval_run_detail(p_company uuid, p_run uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$ begin
 if not mavi_private.leader(p_company) then
  raise exception 'Só administradores e gestores testam modelos.' using errcode = '42501';
 end if;
 if not exists (select 1 from public.ai_eval_runs where id = p_run and company_id = p_company) then
  raise exception 'Teste não encontrado.' using errcode = 'P0002';
 end if;
 return (select coalesce(jsonb_agg(jsonb_build_object('id', x.id, 'case_id', x.case_id, 'question', c.question,
   'reference', c.reference, 'task_type', c.task_type, 'status', x.status, 'answer', x.answer, 'score', x.score,
   'passed', x.passed, 'explanation', x.explanation, 'ms', x.ms, 'cost_usd', x.cost_usd, 'error', x.last_error)
   order by (x.status = 'done' and x.passed), x.score nulls first, x.id), '[]')
  from public.ai_eval_results x left join public.ai_eval_cases c on c.id = x.case_id where x.run_id = p_run);
end $$;
revoke all on function public.ai_eval_run_detail(uuid, uuid) from public, anon;
grant execute on function public.ai_eval_run_detail(uuid, uuid) to authenticated;

-- ------------------------------------------------------------ worker
create function mavi_private.ai_eval_due() returns table(run_id uuid)
language sql stable security definer set search_path = '' as $$
 select r.id from public.ai_eval_runs r
 where r.status = 'running' and r.cost_usd < r.cap_usd
  and exists (select 1 from public.ai_eval_results x where x.run_id = r.id and x.status = 'pending' and x.attempts < 3
   and (x.claimed_until is null or x.claimed_until < now()))
$$;
revoke all on function mavi_private.ai_eval_due() from public, anon, authenticated;

create function public.ai_eval_claim(p_secret text, p_limit integer default 3) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare x public.ai_eval_results; r public.ai_eval_runs; c public.ai_eval_cases; p mavi_private.ai_providers;
 v_out jsonb := '[]'; begin
 if not mavi_private.ai_secret_ok(p_secret) then raise exception 'Sem permissão' using errcode = '42501'; end if;
 -- Testes que bateram o teto ou acabaram os casos: fecham.
 for r in select * from public.ai_eval_runs y where y.status = 'running' and (y.cost_usd >= y.cap_usd
   or not exists (select 1 from public.ai_eval_results z where z.run_id = y.id and z.status = 'pending')) loop
  if not exists (select 1 from public.ai_eval_results z where z.run_id = r.id and z.status = 'pending'
    and z.claimed_until > now()) then
   perform mavi_private.ai_eval_finish(r.id, 'done');
  end if;
 end loop;
 for x in select * from public.ai_eval_results y
  where y.run_id in (select d.run_id from mavi_private.ai_eval_due() d)
   and y.status = 'pending' and y.attempts < 3 and (y.claimed_until is null or y.claimed_until < now())
  order by y.id limit least(greatest(coalesce(p_limit, 3), 1), 6) for update skip locked
 loop
  update public.ai_eval_results set claimed_until = now() + interval '5 minutes', attempts = attempts + 1 where id = x.id;
  select * into r from public.ai_eval_runs where id = x.run_id;
  select * into c from public.ai_eval_cases where id = x.case_id;
  if c.id is null then
   update public.ai_eval_results set status = 'skipped', claimed_until = null, last_error = 'caso excluído' where id = x.id;
   continue;
  end if;
  p := null;
  if r.provider_id is not null then
   select * into p from mavi_private.ai_providers v where v.id = r.provider_id and v.active;
   if p.id is null then
    update public.ai_eval_results set status = 'error', claimed_until = null, last_error = 'provedor indisponível'
    where id = x.id;
    continue;
   end if;
  end if;
  v_out := v_out || jsonb_build_array(jsonb_build_object('id', x.id, 'run', r.id, 'company', r.company_id,
   'model', r.model, 'case', jsonb_build_object('id', c.id, 'question', c.question, 'reference', c.reference,
    'material', c.material, 'context', c.context, 'task_type', c.task_type,
    'client', (select k.name from public.clients k where k.id = c.client_id)),
   'provider', case when p.id is null then null else jsonb_build_object('provider_id', p.id, 'provider', p.name,
     'kind', p.kind, 'base_url', p.base_url, 'key_cipher', p.key_cipher,
     'price', (select m from jsonb_array_elements(p.models) m where m->>'id' = r.model limit 1)) end));
 end loop;
 return v_out;
end $$;
revoke all on function public.ai_eval_claim(text, integer) from public, anon, authenticated;
grant execute on function public.ai_eval_claim(text, integer) to anon, authenticated;

create function public.ai_eval_store(p_secret text, p_result bigint, p_answer text, p_score numeric,
 p_explanation text, p_ms integer, p_task_type text, p_usage jsonb) returns void
language plpgsql security definer set search_path = '' as $$
declare x public.ai_eval_results; u jsonb; v_cost numeric := 0; begin
 if not mavi_private.ai_secret_ok(p_secret) then raise exception 'Sem permissão' using errcode = '42501'; end if;
 select * into x from public.ai_eval_results where id = p_result for update;
 if x.id is null then return; end if;
 for u in select * from jsonb_array_elements(case when jsonb_typeof(p_usage) = 'array' then p_usage else '[]' end) loop
  v_cost := v_cost + least(greatest(coalesce((u->>'cost')::numeric, 0), 0), 100);
  insert into public.ai_usage(company_id, user_id, module, kind, model, input_tokens, output_tokens,
   cache_read_tokens, cache_write_tokens, cost_usd, provider_id, provider_name)
  values (x.company_id, null, 'mavi', 'eval_set', left(coalesce(u->>'model', ''), 80),
   greatest(coalesce((u->>'input')::integer, 0), 0), greatest(coalesce((u->>'output')::integer, 0), 0),
   greatest(coalesce((u->>'cache_read')::integer, 0), 0), greatest(coalesce((u->>'cache_write')::integer, 0), 0),
   least(greatest(coalesce((u->>'cost')::numeric, 0), 0), 100),
   (select v.id from mavi_private.ai_providers v where v.id = nullif(u->>'provider_id', '')::uuid and v.company_id = x.company_id),
   left(coalesce(u->>'provider', ''), 80));
 end loop;
 update public.ai_eval_results set status = 'done', claimed_until = null, last_error = null, judged_at = now(),
  answer = left(coalesce(p_answer, ''), 12000), score = least(greatest(coalesce(p_score, 0), 0), 1),
  passed = coalesce(p_score, 0) >= 0.7, explanation = left(btrim(coalesce(p_explanation, '')), 800),
  ms = greatest(coalesce(p_ms, 0), 0), cost_usd = v_cost
 where id = p_result;
 update public.ai_eval_runs set cost_usd = cost_usd + v_cost,
  cases_done = (select count(*) from public.ai_eval_results z where z.run_id = x.run_id and z.status = 'done')
 where id = x.run_id;
 if p_task_type in ('conversa', 'consulta', 'busca', 'analise', 'redacao', 'planejamento', 'acao', 'visual', 'codigo',
  'utilitario') then
  update public.ai_eval_cases set task_type = p_task_type where id = x.case_id and task_type is null;
 end if;
 if not exists (select 1 from public.ai_eval_results z where z.run_id = x.run_id and z.status = 'pending') then
  perform mavi_private.ai_eval_finish(x.run_id, 'done');
 end if;
end $$;
revoke all on function public.ai_eval_store(text, bigint, text, numeric, text, integer, text, jsonb) from public, anon, authenticated;
grant execute on function public.ai_eval_store(text, bigint, text, numeric, text, integer, text, jsonb) to anon, authenticated;

create function public.ai_eval_fail(p_secret text, p_result bigint, p_error text) returns void
language plpgsql security definer set search_path = '' as $$
declare x public.ai_eval_results; begin
 if not mavi_private.ai_secret_ok(p_secret) then raise exception 'Sem permissão' using errcode = '42501'; end if;
 update public.ai_eval_results set claimed_until = null, last_error = left(coalesce(p_error, ''), 300),
  status = case when attempts >= 3 then 'error' else 'pending' end
 where id = p_result returning * into x;
 if x.id is not null and not exists (select 1 from public.ai_eval_results z where z.run_id = x.run_id and z.status = 'pending') then
  perform mavi_private.ai_eval_finish(x.run_id, 'done');
 end if;
end $$;
revoke all on function public.ai_eval_fail(text, bigint, text) from public, anon, authenticated;
grant execute on function public.ai_eval_fail(text, bigint, text) to anon, authenticated;

-- O agendamento do aprendizado acorda também para os testes do conjunto.
create or replace function mavi_private.ai_learning_kick() returns void
language plpgsql security definer set search_path = '' as $$
declare cfg mavi_private.ai_config; begin
 select * into cfg from mavi_private.ai_config where id;
 if not found then return; end if;
 if not exists (select 1 from mavi_private.copilot_learning_due())
  and not exists (select 1 from mavi_private.mavi_learning_due())
  and not exists (select 1 from mavi_private.mavi_judge_due())
  and not exists (select 1 from mavi_private.mavi_person_due())
  and not exists (select 1 from mavi_private.ai_route_eval_due())
  and not exists (select 1 from mavi_private.ai_eval_due()) then return; end if;
 perform net.http_post(url := cfg.url, body := '{"action":"ai-learning"}'::jsonb,
  headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || cfg.secret),
  timeout_milliseconds := 60000);
end $$;

-- A da migração 20270531090000, com a liberação: os modelos aprovados no conjunto.
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
    group by d.task_type having count(*) >= 2) t),
  'gate', coalesce(s.gate_enabled, false),
  'approved', case when coalesce(s.gate_enabled, false) then (select coalesce(jsonb_agg(jsonb_build_object(
    'provider_id', l.provider_id, 'model', l.model)), '[]') from mavi_private.ai_eval_latest(p_company) l
    where l.score >= coalesce(s.gate_min, 0.8)) else '[]'::jsonb end);
end $$;

commit;
