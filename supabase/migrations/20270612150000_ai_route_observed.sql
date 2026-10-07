begin;

-- MAVI · roteador de modelos: leitura do pedido conferida depois da resposta.
--
-- No modo sombra, o roteador sugeria o modelo mais barato até para pedidos
-- que criaram apresentação e usaram várias rodadas de ferramentas: a
-- leitura (só pelo texto da pergunta) dizia "Consulta, complexidade 1".
-- Além de ler melhor o pedido (no servidor), agora:
--
-- 1. O registro guarda a complexidade observada (pelas rodadas, ferramentas
--    e entregáveis da resposta) e marca a decisão subestimada quando a
--    leitura ficou abaixo do que a resposta precisou.
-- 2. No ranking, a subestimada conta como teste reprovado para o modelo que o
--    roteador sugeriu naquele tipo de pedido.
-- 3. Os tipos de pedido que costumam ser subestimados (5 ou mais e 25% ou
--    mais nos últimos 30 dias) sobem um degrau na leitura (ai_route_context).
-- 4. Testes fora do ar só para respostas sem entregável e com até 2 rodadas
--    (o candidato responde sem ferramentas).
-- 5. Desempenho e últimas decisões mostram as subestimadas.

alter table public.ai_route_decisions
 add column observed_complexity smallint check (observed_complexity between 1 and 3),
 add column underestimated boolean not null default false;

-- As das migrações 20270531090000, 20270602090000, 20270528090000 e 20270529090000.
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
  total_ms, rounds, cost_usd, tools_ok, tools_failed, capped, escalated, error, observed_complexity, underestimated)
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
  coalesce((e->>'capped')::boolean, false), coalesce((e->>'escalated')::boolean, false), left(e->>'error', 300),
  case when (e->>'observed_complexity') ~ '^[1-3]$' then (e->>'observed_complexity')::smallint end,
  coalesce((e->>'underestimated')::boolean, false))
 returning id into v_id;
 -- Teste fora do ar: resposta salva, sem falha, com candidato diferente, no sorteio e até 200 por dia.
 -- Só respostas sem entregável e com até 2 rodadas: o candidato responde sem
 -- ferramentas, e a comparação com um documento ou uma busca longa não seria justa.
 if coalesce(s.eval_enabled, true) and (e->>'message_id') is not null and e->>'error' is null
  and coalesce((e->>'rounds')::integer, 0) <= 2 and coalesce((e->>'artifacts')::integer, 0) = 0
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

create or replace function mavi_private.ai_route_rank_refresh(p_company uuid default null) returns integer
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
  select x.company_id, x.task_type, x.model, sum(x.n) as n, sum(x.ok) as ok from (
   select e.company_id, e.task_type, e.candidate_model as model, count(*) as n,
    count(*) filter (where e.verdict in ('better', 'same') and coalesce(e.confidence, 0) >= 0.5) as ok
   from public.ai_route_evals e
   where e.status = 'done' and e.verdict is not null and e.judged_at > now() - interval '60 days'
    and (p_company is null or e.company_id = p_company)
   group by 1, 2, 3
   union all
   -- A leitura ficou abaixo do que a resposta precisou: o modelo que o roteador
   -- sugeriu (de faixa baixa demais) conta como teste reprovado naquele tipo.
   select d.company_id, d.task_type, d.suggested_model, count(*), 0
   from public.ai_route_decisions d
   where d.underestimated and d.suggested_model is not null and d.suggested_model <> d.used_model
    and d.created_at > now() - interval '60 days' and (p_company is null or d.company_id = p_company)
   group by 1, 2, 3) x
  group by 1, 2, 3)
 select coalesce(l.company_id, v.company_id), coalesce(l.task_type, v.task_type), coalesce(l.model, v.model),
  coalesce(l.n, 0), coalesce(l.good, 0), coalesce(v.n, 0), coalesce(v.ok, 0),
  round((coalesce(l.good, 0) + coalesce(v.ok, 0) + 0.85 * 5)::numeric / (coalesce(l.n, 0) + coalesce(v.n, 0) + 5), 3)
 from live l full join ev v on v.company_id = l.company_id and v.task_type = l.task_type and v.model = l.model;
 get diagnostics n = row_count;
 return n;
end $$;

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
  'route_models', to_jsonb(s.route_models),
  -- Pedidos deste tipo costumam precisar de mais do que a leitura indica (30 dias).
  'underestimated_types', (select coalesce(jsonb_agg(t.task_type), '[]') from (
    select d.task_type from public.ai_route_decisions d
    where d.company_id = p_company and d.created_at > now() - interval '30 days' and d.observed_complexity is not null
    group by d.task_type
    having count(*) filter (where d.underestimated) >= 5
     and count(*) filter (where d.underestimated)::numeric / count(*) >= 0.25) t),
  'gate', coalesce(s.gate_enabled, false),
  'approved', case when coalesce(s.gate_enabled, false) then (select coalesce(jsonb_agg(jsonb_build_object(
    'provider_id', l.provider_id, 'model', l.model)), '[]') from mavi_private.ai_eval_latest(p_company) l
    where l.score >= coalesce(s.gate_min, 0.8)) else '[]'::jsonb end);
end $$;

create or replace function public.ai_route_stats(p_company uuid, p_days integer default 30) returns jsonb
language plpgsql stable security definer set search_path = '' as $$ begin
 if not mavi_private.leader(p_company) then
  raise exception 'Só administradores e gestores veem o desempenho dos modelos.' using errcode = '42501';
 end if;
 return (with d as (
   select r.*,
    f.up, f.down,
    (k.status = 'done' and coalesce((k.verdict->>'ok')::boolean, true) = false
     and coalesce((k.verdict->>'confidence')::numeric, 0) >= 0.6) as judged_bad,
    (k.status = 'done') as judged,
    (select (c->>'est')::numeric from jsonb_array_elements(r.candidates) c
     where c->>'model' = r.suggested_model and (c->>'providerId') is not distinct from r.suggested_provider_id::text limit 1) as sugg_est,
    (select (c->>'est')::numeric from jsonb_array_elements(r.candidates) c
     where c->>'model' = r.used_model and (c->>'providerId') is not distinct from r.used_provider_id::text limit 1) as used_est
   from public.ai_route_decisions r
   left join lateral (select count(*) filter (where x.vote = 'up') as up, count(*) filter (where x.vote = 'down') as down
    from public.mavi_feedback x where x.message_id = r.message_id and x.company_id = r.company_id) f on true
   left join public.mavi_answer_checks k on k.message_id = r.message_id
   where r.company_id = p_company and r.created_at >= now() - make_interval(days => least(greatest(coalesce(p_days, 30), 1), 365)))
  select jsonb_build_object(
   'total', (select count(*) from d),
   'by_type_model', (select coalesce(jsonb_agg(x order by x.task_type, x.n desc), '[]') from (
     select task_type, used_model as model, count(*) as n,
      round(avg(cost_usd), 6) as cost_avg,
      percentile_disc(0.5) within group (order by total_ms) as total_ms_p50,
      percentile_disc(0.95) within group (order by total_ms) as total_ms_p95,
      percentile_disc(0.5) within group (order by first_token_ms) as first_token_ms_p50,
      round(sum(tools_failed)::numeric / nullif(sum(tools_ok + tools_failed), 0), 3) as tool_fail_rate,
      sum(up) as up, sum(down) as down,
      count(*) filter (where judged) as judged, count(*) filter (where judged_bad) as judged_bad,
      round(1 - count(*) filter (where down > 0 or judged_bad or tools_failed > 0 or capped or error is not null)::numeric / count(*), 3) as quality,
      round(avg(complexity), 2) as complexity_avg
     from d group by task_type, used_model) x),
   'shadow', (select jsonb_build_object(
     'agree', count(*) filter (where suggested_model = used_model),
     'differ', count(*) filter (where suggested_model is distinct from used_model),
     'locked', count(*) filter (where mode = 'locked'),
     'underestimated', count(*) filter (where underestimated),
     'est_ratio', round(sum(sugg_est) filter (where sugg_est is not null and used_est > 0)
       / nullif(sum(used_est) filter (where sugg_est is not null and used_est > 0), 0), 3),
     'by_suggestion', (select coalesce(jsonb_agg(s order by s.n desc), '[]') from (
       select task_type, complexity, used_model, suggested_model, count(*) as n from d
       where suggested_model is distinct from used_model
       group by task_type, complexity, used_model, suggested_model order by count(*) desc limit 30) s))
    from d)));
end $$;

create or replace function public.ai_route_recent(p_company uuid, p_limit integer default 50) returns jsonb
language plpgsql stable security definer set search_path = '' as $$ begin
 if not mavi_private.leader(p_company) then
  raise exception 'Só administradores e gestores veem o desempenho dos modelos.' using errcode = '42501';
 end if;
 return (select coalesce(jsonb_agg(jsonb_build_object('id', d.id, 'at', d.created_at, 'user_id', d.user_id,
   'surface', d.surface, 'task_type', d.task_type, 'complexity', d.complexity, 'mode', d.mode,
   'locked_by', d.locked_by, 'suggested_model', d.suggested_model, 'used_model', d.used_model, 'reason', d.reason,
   'first_token_ms', d.first_token_ms, 'total_ms', d.total_ms, 'cost_usd', d.cost_usd, 'tools_failed', d.tools_failed,
   'escalated', d.escalated, 'error', d.error, 'observed_complexity', d.observed_complexity,
   'underestimated', d.underestimated, 'conversation_id', d.conversation_id) order by d.id desc), '[]')
  from (select * from public.ai_route_decisions x where x.company_id = p_company
   order by x.id desc limit least(greatest(coalesce(p_limit, 50), 1), 200)) d);
end $$;

commit;
