begin;

-- MAVI · Avaliação dinâmica (pedido de 07/10/2026): no lugar do conjunto de
-- casos montados à mão, os registros reais de cada módulo.
--
-- O conjunto antigo dava notas de 3% a 15% a todos os modelos: cada caso
-- tentava remontar o material depois, e o que as ferramentas devolveram já
-- tinha se perdido (o modelo testado respondia "não tenho os dados").
--
-- 1. Registros (ai_samples): cada chamada à MAVI de um módulo (a conversa,
--    o Radar, o Termômetro, os Insights…) grava a entrada inteira (as
--    instruções, o contexto, a conversa, as ferramentas e o que cada
--    consulta devolveu) e a resposta. Ficam os 10 mais recentes de cada
--    módulo, no máximo 2 da mesma pessoa (conversas de pessoas diferentes).
--    Só líderes veem, pelo Painel da MAVI.
-- 2. Testes: um líder escolhe o modelo e os módulos; o modelo recebe a
--    mesma entrada de cada registro e as consultas devolvem o que foi
--    gravado (nada é executado de verdade). O juiz compara às cegas com a
--    resposta original: vence, empata ou perde. A nota é a parte dos
--    registros em que o modelo foi igual ou melhor.
-- 3. Teste semanal: toda segunda, até 3 modelos que o roteador pode
--    escolher (os testados há mais tempo), com todos os módulos, dentro de
--    um teto por modelo.
-- 4. Privacidade: só modelos de provedores permitidos no Roteamento; os
--    registros de clientes sigilosos só vão para os provedores de dados
--    sigilosos.
--
-- A liberação no roteador passa a usar só os testes dinâmicos. Os casos
-- antigos (ai_eval_cases) ficam guardados, sem tela.

-- ------------------------------------------------------------ registros
create table public.ai_samples (
 id bigint generated always as identity primary key,
 company_id uuid not null references public.companies(id) on delete cascade,
 feature text not null check (feature ~ '^[a-z_]{2,60}$'),
 user_id uuid,
 client_id uuid references public.clients(id) on delete set null,
 sigiloso boolean not null default false,
 question text not null default '' check (length(question) <= 2000),
 -- {instructions, context, messages, tools, max_rounds, effort, max_tokens, calls}
 request jsonb not null,
 answer text not null check (length(answer) <= 60000),
 provider_id uuid,
 provider_name text not null default '',
 model text not null default '' check (length(model) <= 120),
 cost_usd numeric(12,6) not null default 0,
 ms integer,
 rounds integer,
 chars integer not null default 0,
 created_at timestamptz not null default now()
);
create index ai_samples_feature on public.ai_samples (company_id, feature, created_at desc);
alter table public.ai_samples enable row level security;
revoke all on public.ai_samples from public, anon, authenticated;

-- Grava um registro (nas telas, com o login de quem pediu; nos agendamentos,
-- com o segredo do worker) e mantém os 10 mais recentes do módulo.
create function public.ai_sample_save(p_secret text, p_company uuid, p_feature text, p_client uuid, p_sample jsonb)
returns void
language plpgsql security definer set search_path = '' as $$
declare v_worker boolean := mavi_private.ai_secret_ok(p_secret); v_user uuid := auth.uid(); v_client uuid;
 v_provider uuid; v_chars integer := length(coalesce(p_sample, '{}')::text); begin
 if not v_worker and (v_user is null or not mavi_private.member(p_company)) then
  raise exception 'Sem permissão' using errcode = '42501';
 end if;
 if v_worker then v_user := null; end if;
 if coalesce(p_feature, '') !~ '^[a-z_]{2,60}$' or jsonb_typeof(p_sample->'request') is distinct from 'object'
  or btrim(coalesce(p_sample->>'answer', '')) = '' or v_chars > 900000 then
  return;
 end if;
 -- Várias instâncias da Vercel: um registro por minuto em cada módulo.
 if exists (select 1 from public.ai_samples x where x.company_id = p_company and x.feature = p_feature
   and x.created_at > now() - interval '1 minute') then
  return;
 end if;
 select k.id into v_client from public.clients k where k.id = p_client and k.company_id = p_company;
 select v.id into v_provider from mavi_private.ai_providers v
 where v.company_id = p_company and v.id::text = coalesce(p_sample->>'provider_id', '');
 insert into public.ai_samples(company_id, feature, user_id, client_id, sigiloso, question, request, answer,
  provider_id, provider_name, model, cost_usd, ms, rounds, chars)
 values (p_company, p_feature, v_user, v_client,
  v_client is not null and exists (select 1 from mavi_private.ai_router_scopes sc where sc.company_id = p_company
   and sc.scope_type = 'client' and sc.scope_id = v_client and sc.sigiloso),
  left(coalesce(p_sample->>'question', ''), 2000), p_sample->'request', left(p_sample->>'answer', 60000),
  v_provider, coalesce((select v.name from mavi_private.ai_providers v where v.id = v_provider), 'Servidor'),
  left(coalesce(p_sample->>'model', ''), 120),
  least(greatest(coalesce((p_sample->>'cost')::numeric, 0), 0), 100),
  greatest(coalesce((p_sample->>'ms')::integer, 0), 0), greatest(coalesce((p_sample->>'rounds')::integer, 0), 0),
  v_chars);
 -- No máximo 2 da mesma pessoa e 10 por módulo (os que um teste ainda vai usar ficam).
 if v_user is not null then
  delete from public.ai_samples s where s.id in (select x.id from public.ai_samples x
    where x.company_id = p_company and x.feature = p_feature and x.user_id = v_user
    order by x.created_at desc offset 2)
   and not exists (select 1 from public.ai_eval_results r where r.sample_id = s.id and r.status = 'pending');
 end if;
 delete from public.ai_samples s where s.id in (select x.id from public.ai_samples x
   where x.company_id = p_company and x.feature = p_feature order by x.created_at desc offset 10)
  and not exists (select 1 from public.ai_eval_results r where r.sample_id = s.id and r.status = 'pending');
end $$;
revoke all on function public.ai_sample_save(text, uuid, text, uuid, jsonb) from public;
grant execute on function public.ai_sample_save(text, uuid, text, uuid, jsonb) to anon, authenticated;

-- ------------------------------------------------------------ testes
alter table public.ai_eval_runs
 add column kind text not null default 'set' check (kind in ('set', 'dynamic')),
 add column features text[],
 add column auto boolean not null default false,
 add column wins integer not null default 0,
 add column ties integer not null default 0,
 add column losses integer not null default 0;

-- Cada resultado guarda o retrato do registro (o registro sai da fila depois).
alter table public.ai_eval_results
 add column sample_id bigint references public.ai_samples(id) on delete set null,
 add column feature text,
 add column question text check (length(question) <= 2000),
 add column reference text check (length(reference) <= 12000),
 add column base_model text,
 add column base_cost numeric(12,6),
 add column base_ms integer,
 -- O gasto só da resposta do modelo testado (sem o juiz), para comparar com a original.
 add column answer_cost numeric(12,6),
 add column outcome text check (outcome in ('win', 'tie', 'loss'));
create index ai_eval_results_sample on public.ai_eval_results (sample_id) where status = 'pending';

-- O teste semanal.
create table mavi_private.ai_eval_settings (
 company_id uuid primary key references public.companies(id) on delete cascade,
 weekly boolean not null default true,
 weekly_cap numeric(8,4) not null default 1 check (weekly_cap between 0.05 and 20),
 updated_by uuid default auth.uid(),
 updated_at timestamptz not null default now()
);

-- A nota mais recente de cada modelo: só os testes dinâmicos.
create or replace function mavi_private.ai_eval_latest(p_company uuid) returns table(provider_id uuid, model text,
 score numeric, run_id uuid, finished_at timestamptz)
language sql stable security definer set search_path = '' as $$
 select distinct on (r.provider_id, r.model) r.provider_id, r.model, r.score, r.id, r.finished_at
 from public.ai_eval_runs r
 where r.company_id = p_company and r.kind = 'dynamic' and r.status = 'done' and r.score is not null
  and r.cases_done > 0
 order by r.provider_id, r.model, r.finished_at desc
$$;

-- Os casos à mão saem (a tabela fica guardada).
drop function public.ai_eval_case_save(uuid, uuid, text, text, uuid, text, boolean);
drop function public.ai_eval_case_from_message(uuid, bigint);
drop function public.ai_eval_case_delete(uuid, uuid);
drop function public.ai_eval_run_start(uuid, uuid, text, numeric);
drop function public.ai_eval_store(text, bigint, text, numeric, text, integer, text, jsonb);

-- Cria o teste de um modelo com os 10 registros mais recentes de cada módulo.
create function mavi_private.ai_eval_create(p_company uuid, p_provider uuid, p_model text, p_cap numeric,
 p_features text[], p_auto boolean) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_id uuid; v_name text := 'Servidor'; st mavi_private.ai_router_settings; n integer;
 v_key uuid := coalesce(p_provider, '00000000-0000-0000-0000-000000000000'::uuid); begin
 if p_provider is not null then
  select p.name into v_name from mavi_private.ai_providers p where p.id = p_provider and p.company_id = p_company
   and p.active and exists (select 1 from jsonb_array_elements(p.models) m where m->>'id' = p_model);
  if v_name is null then raise exception 'Escolha um modelo de um provedor ligado.' using errcode = '22023'; end if;
 elsif coalesce(p_model, '') !~ '^claude-[a-z0-9.-]+$' then
  raise exception 'Escolha um modelo da Claude do servidor.' using errcode = '22023';
 end if;
 if p_model ~* 'typesafe/jev' then
  raise exception 'O Jev confere e audita respostas; não responde pela MAVI.' using errcode = '22023';
 end if;
 if p_cap is null or p_cap < 0.05 or p_cap > 50 then
  raise exception 'O teto vai de US$ 0,05 a US$ 50.' using errcode = '22023';
 end if;
 if coalesce(cardinality(p_features), 0) = 0 then
  raise exception 'Escolha pelo menos um módulo.' using errcode = '22023';
 end if;
 select * into st from mavi_private.ai_router_settings where company_id = p_company;
 -- Os registros têm dados da empresa: só vão para os provedores permitidos.
 if st.providers is not null and not (v_key = any(st.providers)) then
  raise exception 'O provedor % não está entre os permitidos no Roteamento.', v_name using errcode = '22023';
 end if;
 if exists (select 1 from public.ai_eval_runs r where r.company_id = p_company and r.status = 'running'
   and r.provider_id is not distinct from p_provider and r.model = p_model) then
  raise exception 'Este modelo já está em teste.' using errcode = '22023';
 end if;
 insert into public.ai_eval_runs(company_id, provider_id, provider_name, model, cap_usd, kind, features, auto)
 values (p_company, p_provider, v_name, p_model, p_cap, 'dynamic', p_features, coalesce(p_auto, false))
 returning id into v_id;
 insert into public.ai_eval_results(run_id, company_id, sample_id, feature, question, reference, base_model,
  base_cost, base_ms)
 select v_id, p_company, x.id, x.feature, left(x.question, 2000), left(x.answer, 12000), x.model, x.cost_usd, x.ms
 from (select s.*, row_number() over (partition by s.feature order by s.created_at desc) as rn
   from public.ai_samples s
   where s.company_id = p_company and s.feature = any(p_features)
    -- Cliente sigiloso: só nos provedores de dados sigilosos.
    and (not s.sigiloso or st.secret_providers is null or v_key = any(st.secret_providers))) x
 where x.rn <= 10
 order by x.feature, x.created_at desc;
 get diagnostics n = row_count;
 if n = 0 then
  raise exception 'Ainda não há registros desses módulos para testar.' using errcode = '22023';
 end if;
 update public.ai_eval_runs set cases_total = n where id = v_id;
 return v_id;
end $$;
revoke all on function mavi_private.ai_eval_create(uuid, uuid, text, numeric, text[], boolean) from public, anon, authenticated;

create function public.ai_eval_run_start(p_company uuid, p_provider uuid, p_model text, p_cap numeric,
 p_features text[]) returns uuid
language plpgsql security definer set search_path = '' as $$ begin
 if not mavi_private.leader(p_company) then
  raise exception 'Só administradores e gestores testam modelos.' using errcode = '42501';
 end if;
 return mavi_private.ai_eval_create(p_company, p_provider, p_model, p_cap, p_features, false);
end $$;
revoke all on function public.ai_eval_run_start(uuid, uuid, text, numeric, text[]) from public, anon;
grant execute on function public.ai_eval_run_start(uuid, uuid, text, numeric, text[]) to authenticated;

-- Fecha o teste: vitórias, empates e derrotas; a nota é a parte igual ou melhor.
create or replace function mavi_private.ai_eval_finish(p_run uuid, p_status text) returns void
language plpgsql security definer set search_path = '' as $$ begin
 update public.ai_eval_results set status = 'skipped', claimed_until = null
 where run_id = p_run and status = 'pending';
 update public.ai_eval_runs r set status = p_status, finished_at = now(),
  cases_done = (select count(*) from public.ai_eval_results x where x.run_id = r.id and x.status = 'done'),
  cases_failed = (select count(*) from public.ai_eval_results x where x.run_id = r.id and x.status in ('error', 'skipped')),
  score = (select round(avg(x.score), 3) from public.ai_eval_results x where x.run_id = r.id and x.status = 'done'),
  passed = (select count(*) from public.ai_eval_results x where x.run_id = r.id and x.status = 'done' and x.passed),
  wins = (select count(*) from public.ai_eval_results x where x.run_id = r.id and x.status = 'done' and x.outcome = 'win'),
  ties = (select count(*) from public.ai_eval_results x where x.run_id = r.id and x.status = 'done' and x.outcome = 'tie'),
  losses = (select count(*) from public.ai_eval_results x where x.run_id = r.id and x.status = 'done' and x.outcome = 'loss'),
  avg_ms = (select round(avg(x.ms))::integer from public.ai_eval_results x where x.run_id = r.id and x.status = 'done')
 where r.id = p_run and r.status = 'running';
end $$;

-- Os registros por módulo, os testes, a nota mais recente e o teste semanal.
create or replace function public.ai_eval_overview(p_company uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare e mavi_private.ai_eval_settings; begin
 if not mavi_private.leader(p_company) then
  raise exception 'Só administradores e gestores cuidam da avaliação.' using errcode = '42501';
 end if;
 select * into e from mavi_private.ai_eval_settings where company_id = p_company;
 return jsonb_build_object(
  'samples', (select coalesce(jsonb_agg(jsonb_build_object('id', s.id, 'feature', s.feature,
    'question', left(s.question, 240), 'model', s.model, 'provider', s.provider_name, 'client_id', s.client_id,
    'sigiloso', s.sigiloso, 'tools', coalesce(jsonb_array_length(s.request->'calls'), 0), 'cost_usd', s.cost_usd,
    'ms', s.ms, 'created_at', s.created_at) order by s.feature, s.created_at desc), '[]')
   from public.ai_samples s where s.company_id = p_company),
  'runs', (select coalesce(jsonb_agg(jsonb_build_object('id', r.id, 'provider_id', r.provider_id,
    'provider', r.provider_name, 'model', r.model, 'status', r.status, 'features', to_jsonb(r.features),
    'auto', r.auto, 'cases_total', r.cases_total, 'cases_done', r.cases_done, 'cases_failed', r.cases_failed,
    'score', r.score, 'wins', r.wins, 'ties', r.ties, 'losses', r.losses, 'cost_usd', r.cost_usd,
    'cap_usd', r.cap_usd, 'avg_ms', r.avg_ms, 'created_by', r.created_by, 'created_at', r.created_at,
    'finished_at', r.finished_at,
    -- Os mesmos registros na resposta original: o gasto e a espera, para comparar.
    'answer_cost', (select sum(x.answer_cost) from public.ai_eval_results x where x.run_id = r.id and x.status = 'done'),
    'base_cost', (select sum(x.base_cost) from public.ai_eval_results x where x.run_id = r.id and x.status = 'done'),
    'base_ms', (select round(avg(x.base_ms))::integer from public.ai_eval_results x
     where x.run_id = r.id and x.status = 'done')) order by r.created_at desc), '[]')
   from (select * from public.ai_eval_runs x where x.company_id = p_company and x.kind = 'dynamic'
    order by x.created_at desc limit 20) r),
  'latest', (select coalesce(jsonb_agg(jsonb_build_object('provider_id', l.provider_id, 'model', l.model,
    'score', l.score, 'run_id', l.run_id, 'finished_at', l.finished_at)), '[]') from mavi_private.ai_eval_latest(p_company) l),
  'settings', jsonb_build_object('weekly', coalesce(e.weekly, true), 'weekly_cap', coalesce(e.weekly_cap, 1)));
end $$;

create function public.ai_eval_settings_save(p_company uuid, p_weekly boolean, p_cap numeric) returns void
language plpgsql security definer set search_path = '' as $$ begin
 if not mavi_private.leader(p_company) then
  raise exception 'Só administradores e gestores cuidam da avaliação.' using errcode = '42501';
 end if;
 if p_cap is null or p_cap < 0.05 or p_cap > 20 then
  raise exception 'O teto por modelo vai de US$ 0,05 a US$ 20.' using errcode = '22023';
 end if;
 insert into mavi_private.ai_eval_settings(company_id, weekly, weekly_cap) values (p_company, coalesce(p_weekly, true), p_cap)
 on conflict (company_id) do update set weekly = excluded.weekly, weekly_cap = excluded.weekly_cap,
  updated_by = auth.uid(), updated_at = now();
end $$;
revoke all on function public.ai_eval_settings_save(uuid, boolean, numeric) from public, anon;
grant execute on function public.ai_eval_settings_save(uuid, boolean, numeric) to authenticated;

-- O resultado registro a registro (as derrotas primeiro).
create or replace function public.ai_eval_run_detail(p_company uuid, p_run uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$ begin
 if not mavi_private.leader(p_company) then
  raise exception 'Só administradores e gestores testam modelos.' using errcode = '42501';
 end if;
 if not exists (select 1 from public.ai_eval_runs where id = p_run and company_id = p_company) then
  raise exception 'Teste não encontrado.' using errcode = 'P0002';
 end if;
 return (select coalesce(jsonb_agg(jsonb_build_object('id', x.id, 'sample_id', x.sample_id, 'feature', x.feature,
   'question', x.question, 'reference', x.reference, 'base_model', x.base_model, 'base_cost', x.base_cost,
   'base_ms', x.base_ms, 'status', x.status, 'answer', x.answer, 'answer_cost', x.answer_cost, 'outcome', x.outcome,
   'explanation', x.explanation, 'ms', x.ms, 'cost_usd', x.cost_usd, 'error', x.last_error)
   order by x.feature, case x.outcome when 'loss' then 0 when 'tie' then 1 when 'win' then 2 else 3 end, x.id), '[]')
  from public.ai_eval_results x where x.run_id = p_run);
end $$;

-- ------------------------------------------------------------ worker
create or replace function public.ai_eval_claim(p_secret text, p_limit integer default 3) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare x public.ai_eval_results; r public.ai_eval_runs; s public.ai_samples; p mavi_private.ai_providers;
 v_out jsonb := '[]'; begin
 if not mavi_private.ai_secret_ok(p_secret) then raise exception 'Sem permissão' using errcode = '42501'; end if;
 -- Testes que bateram o teto ou acabaram os registros: fecham.
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
  s := null;
  select * into s from public.ai_samples where id = x.sample_id;
  if s.id is null then
   update public.ai_eval_results set status = 'skipped', claimed_until = null, last_error = 'o registro saiu da fila'
   where id = x.id;
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
   'model', r.model,
   'sample', jsonb_build_object('id', s.id, 'feature', s.feature, 'request', s.request, 'answer', s.answer,
    'model', s.model),
   'provider', case when p.id is null then null else jsonb_build_object('provider_id', p.id, 'provider', p.name,
     'kind', p.kind, 'base_url', p.base_url, 'key_cipher', p.key_cipher,
     'price', (select m from jsonb_array_elements(p.models) m where m->>'id' = r.model limit 1)) end));
 end loop;
 return v_out;
end $$;

create function public.ai_eval_store(p_secret text, p_result bigint, p_answer text, p_outcome text,
 p_explanation text, p_ms integer, p_usage jsonb) returns void
language plpgsql security definer set search_path = '' as $$
declare x public.ai_eval_results; u jsonb; v_cost numeric := 0; begin
 if not mavi_private.ai_secret_ok(p_secret) then raise exception 'Sem permissão' using errcode = '42501'; end if;
 if p_outcome is null or p_outcome not in ('win', 'tie', 'loss') then
  raise exception 'Resultado inválido.' using errcode = '22023';
 end if;
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
  answer = left(coalesce(p_answer, ''), 12000), outcome = p_outcome,
  answer_cost = least(greatest(coalesce((p_usage->0->>'cost')::numeric, 0), 0), 100),
  score = case when p_outcome = 'loss' then 0 else 1 end, passed = p_outcome <> 'loss',
  explanation = left(btrim(coalesce(p_explanation, '')), 800), ms = greatest(coalesce(p_ms, 0), 0), cost_usd = v_cost
 where id = p_result;
 update public.ai_eval_runs set cost_usd = cost_usd + v_cost,
  cases_done = (select count(*) from public.ai_eval_results z where z.run_id = x.run_id and z.status = 'done')
 where id = x.run_id;
 if not exists (select 1 from public.ai_eval_results z where z.run_id = x.run_id and z.status = 'pending') then
  perform mavi_private.ai_eval_finish(x.run_id, 'done');
 end if;
end $$;
revoke all on function public.ai_eval_store(text, bigint, text, text, text, integer, jsonb) from public;
grant execute on function public.ai_eval_store(text, bigint, text, text, text, integer, jsonb) to anon, authenticated;

-- ------------------------------------------------------------ teste semanal
-- Toda segunda: em cada empresa com registros e o teste semanal ligado, até
-- 3 modelos que o roteador pode escolher (os testados há mais tempo), com
-- todos os módulos. Sem a lista do roteador, os modelos de conversa dos
-- provedores ligados.
create function mavi_private.ai_eval_weekly() returns integer
language plpgsql security definer set search_path = '' as $$
declare c record; m record; v_features text[]; n integer := 0; begin
 for c in select co.id as company_id, coalesce(e.weekly_cap, 1) as cap, rs.route_models
  from public.companies co
  left join mavi_private.ai_eval_settings e on e.company_id = co.id
  left join mavi_private.ai_router_settings rs on rs.company_id = co.id
  where coalesce(e.weekly, true) and exists (select 1 from public.ai_samples s where s.company_id = co.id)
 loop
  v_features := array(select distinct s.feature from public.ai_samples s where s.company_id = c.company_id order by 1);
  for m in select x.provider_id, x.model from (
    select nullif(split_part(k, '|', 1), '00000000-0000-0000-0000-000000000000')::uuid as provider_id,
     substr(k, length(split_part(k, '|', 1)) + 2) as model
    from unnest(c.route_models) k
    where c.route_models is not null
    union
    select p.id, mm->>'id' from mavi_private.ai_providers p cross join jsonb_array_elements(p.models) mm
    where c.route_models is null and p.company_id = c.company_id and p.active
     and coalesce(mm->>'id', '') <> ''
     and mm->>'id' !~* '(typesafe/jev|transcribe|whisper|embed|image|dall-e|tts|voxtral)') x
   left join lateral (select max(r.created_at) as last from public.ai_eval_runs r where r.company_id = c.company_id
     and r.kind = 'dynamic' and r.provider_id is not distinct from x.provider_id and r.model = x.model) t on true
   order by t.last nulls first, x.model
   limit 3
  loop
   begin
    perform mavi_private.ai_eval_create(c.company_id, m.provider_id, m.model, c.cap, v_features, true);
    n := n + 1;
   exception when others then
    -- Provedor desligado, não permitido ou já em teste: segue com os outros.
    null;
   end;
  end loop;
 end loop;
 return n;
end $$;
revoke all on function mavi_private.ai_eval_weekly() from public, anon, authenticated;

do $$ begin
 if exists (select 1 from pg_extension where extname = 'pg_cron') then
  perform cron.schedule('mavi-eval-weekly', '30 10 * * 1', 'select mavi_private.ai_eval_weekly()');
 end if;
end $$;

commit;
