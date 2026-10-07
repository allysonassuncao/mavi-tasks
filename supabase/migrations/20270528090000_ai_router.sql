begin;

-- MAVI · roteador de modelos, fase 1 (pedido de 06/10/2026): modo sombra.
--
-- Antes de cada resposta, o roteador (api/_ai-router.ts) lê o pedido (tipo
-- de tarefa, complexidade, tamanho, ferramentas, anexos, tela) e escolhe o
-- modelo que atenderia com o menor custo e a menor espera. Nesta fase ele só
-- registra o que escolheria: quem responde continua sendo a regra de "Quem
-- usa qual modelo" (as de pessoa, cliente, produto, projeto, funcionalidade
-- e skill travam o modelo; a da empresa é só o padrão) ou o servidor.
--
-- 1. ai_route_decisions: uma linha por resposta, com a classificação, a
--    sugestão (e os candidatos com a nota), o modelo que respondeu, a espera
--    até a primeira palavra e total, o custo e as ferramentas que deram certo
--    ou falharam. Liga-se à mensagem (👍/👎 em mavi_feedback e a
--    autoavaliação em mavi_answer_checks) para o ranking interno.
-- 2. ai_route_candidates: os provedores ativos da empresa e os modelos (sem
--    as chaves), para quem conversa.
-- 3. ai_route_log: grava a decisão (só da própria pessoa, no cliente e na
--    conversa que ela acessa).
-- 4. ai_route_stats: para líderes, o desempenho por tipo de tarefa × modelo
--    (espera, custo, ferramentas, votos, autoavaliação) e o quanto o roteador
--    economizaria.

create table public.ai_route_decisions (
 id bigint generated always as identity primary key,
 company_id uuid not null references public.companies(id) on delete cascade,
 user_id uuid default auth.uid() references auth.users(id) on delete set null,
 surface text not null check (length(surface) between 1 and 40),
 feature text not null default '' check (length(feature) <= 60),
 client_id uuid,
 conversation_id uuid references public.ai_conversations(id) on delete set null,
 message_id bigint,
 task_type text not null check (task_type in ('conversa', 'consulta', 'busca', 'analise', 'redacao',
  'planejamento', 'acao', 'visual', 'codigo', 'utilitario')),
 complexity smallint not null check (complexity between 1 and 3),
 modalities text[] not null default '{text}' check (modalities <@ array['text', 'image', 'document', 'audio']),
 context_tokens integer not null default 0 check (context_tokens >= 0),
 latency_class text not null default 'normal' check (latency_class in ('rapida', 'normal', 'longa')),
 why text[] not null default '{}',
 -- shadow: só registrou; locked: uma regra travou; auto: o roteador escolheu (fase 2).
 mode text not null check (mode in ('shadow', 'locked', 'auto')),
 locked_by text check (locked_by in ('user', 'client', 'contract', 'project', 'feature', 'skill')),
 need_tier smallint check (need_tier between 1 and 3),
 suggested_provider_id uuid,
 suggested_model text check (length(suggested_model) <= 120),
 reason text not null default '' check (length(reason) <= 500),
 candidates jsonb not null default '[]',
 used_provider_id uuid,
 used_model text not null default '' check (length(used_model) <= 120),
 first_token_ms integer check (first_token_ms >= 0),
 total_ms integer not null default 0 check (total_ms >= 0),
 rounds smallint,
 cost_usd numeric(12,6) not null default 0 check (cost_usd >= 0),
 tools_ok smallint not null default 0,
 tools_failed smallint not null default 0,
 capped boolean not null default false,
 escalated boolean not null default false,
 error text check (length(error) <= 300),
 created_at timestamptz not null default now()
);
create index ai_route_decisions_company on public.ai_route_decisions (company_id, created_at desc);
create index ai_route_decisions_type on public.ai_route_decisions (company_id, task_type, used_model, created_at desc);
create index ai_route_decisions_message on public.ai_route_decisions (message_id) where message_id is not null;
alter table public.ai_route_decisions enable row level security;
revoke all on public.ai_route_decisions from public, anon, authenticated;
grant select on public.ai_route_decisions to authenticated;
create policy ai_route_decisions_read on public.ai_route_decisions for select to authenticated
 using (company_id in (select mavi_private.leader_companies()));

-- Os provedores ativos e os modelos, sem a chave (o roteador escolhe entre eles).
create function public.ai_route_candidates(p_company uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$ begin
 if not mavi_private.member(p_company) then raise exception 'Sem acesso ao espaço' using errcode = '42501'; end if;
 return (select coalesce(jsonb_agg(jsonb_build_object('provider_id', p.id, 'name', p.name, 'kind', p.kind,
   'models', p.models) order by p.name), '[]')
  from mavi_private.ai_providers p where p.company_id = p_company and p.active);
end $$;
revoke all on function public.ai_route_candidates(uuid) from public, anon;
grant execute on function public.ai_route_candidates(uuid) to authenticated;

create function public.ai_route_log(p_company uuid, p_entry jsonb) returns bigint
language plpgsql security definer set search_path = '' as $$
declare e jsonb := coalesce(p_entry, '{}'); v_client uuid; v_conv uuid; v_used uuid; v_sugg uuid;
 v_id bigint; begin
 if not mavi_private.member(p_company) then raise exception 'Sem permissão.' using errcode = '42501'; end if;
 v_client := nullif(e->>'client_id', '')::uuid;
 v_conv := nullif(e->>'conversation_id', '')::uuid;
 v_used := nullif(e->>'used_provider_id', '')::uuid;
 v_sugg := nullif(e->>'suggested_provider_id', '')::uuid;
 if v_client is not null and not mavi_private.drive_can_read(p_company, v_client) then
  raise exception 'Sem permissão.' using errcode = '42501';
 end if;
 if v_conv is not null and not exists (select 1 from public.ai_conversations c
  where c.id = v_conv and c.company_id = p_company and c.owner_id = auth.uid()) then
  raise exception 'Conversa inválida.' using errcode = '22023';
 end if;
 -- A mensagem é uma resposta da própria conversa.
 if (e->>'message_id') is not null and (v_conv is null or not exists (select 1 from public.ai_messages m
  where m.id = (e->>'message_id')::bigint and m.conversation_id = v_conv and m.role = 'assistant')) then
  raise exception 'Mensagem inválida.' using errcode = '22023';
 end if;
 if exists (select 1 from unnest(array[v_used, v_sugg]) x(id) where x.id is not null
  and not exists (select 1 from mavi_private.ai_providers p where p.id = x.id and p.company_id = p_company)) then
  raise exception 'Provedor inválido.' using errcode = '22023';
 end if;
 insert into public.ai_route_decisions(company_id, surface, feature, client_id, conversation_id, message_id,
  task_type, complexity, modalities, context_tokens, latency_class, why, mode, locked_by, need_tier,
  suggested_provider_id, suggested_model, reason, candidates, used_provider_id, used_model, first_token_ms,
  total_ms, rounds, cost_usd, tools_ok, tools_failed, capped, escalated, error)
 values (p_company, left(coalesce(e->>'surface', ''), 40), left(coalesce(e->>'feature', ''), 60), v_client, v_conv,
  (e->>'message_id')::bigint, e->>'task_type', (e->>'complexity')::smallint,
  coalesce((select array_agg(x) from jsonb_array_elements_text(e->'modalities') x), '{text}'),
  greatest(coalesce((e->>'context_tokens')::integer, 0), 0), coalesce(e->>'latency_class', 'normal'),
  coalesce((select array_agg(left(x, 120)) from (select x from jsonb_array_elements_text(e->'why') x limit 12) w), '{}'),
  -- Nesta fase, nada é escolhido pelo roteador: auto vira sombra.
  case when e->>'mode' = 'locked' then 'locked' else 'shadow' end,
  case when e->>'mode' = 'locked' then e->>'locked_by' end, (e->>'need_tier')::smallint, v_sugg,
  left(e->>'suggested_model', 120), left(coalesce(e->>'reason', ''), 500),
  case when jsonb_typeof(e->'candidates') = 'array' then
   (select coalesce(jsonb_agg(c), '[]') from (select c from jsonb_array_elements(e->'candidates') c limit 12) t)
  else '[]' end,
  v_used, left(coalesce(e->>'used_model', ''), 120),
  case when (e->>'first_token_ms') is not null then greatest((e->>'first_token_ms')::integer, 0) end,
  greatest(coalesce((e->>'total_ms')::integer, 0), 0),
  least((e->>'rounds')::integer, 999)::smallint, least(greatest(coalesce((e->>'cost_usd')::numeric, 0), 0), 100),
  least(greatest(coalesce((e->>'tools_ok')::integer, 0), 0), 999), least(greatest(coalesce((e->>'tools_failed')::integer, 0), 0), 999),
  coalesce((e->>'capped')::boolean, false), false, left(e->>'error', 300))
 returning id into v_id;
 return v_id;
end $$;
revoke all on function public.ai_route_log(uuid, jsonb) from public, anon;
grant execute on function public.ai_route_log(uuid, jsonb) to authenticated;

-- O desempenho real por tipo de tarefa × modelo, nos últimos p_days dias.
-- quality: a fração de respostas sem sinal ruim (👎, autoavaliação reprovada
-- com confiança, ferramenta com erro, limite de passos, falha). est_ratio: o custo
-- estimado do que o roteador escolheria ÷ o do que respondeu (abaixo de 1,
-- ele economizaria).
create function public.ai_route_stats(p_company uuid, p_days integer default 30) returns jsonb
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
     'est_ratio', round(sum(sugg_est) filter (where sugg_est is not null and used_est > 0)
       / nullif(sum(used_est) filter (where sugg_est is not null and used_est > 0), 0), 3),
     'by_suggestion', (select coalesce(jsonb_agg(s order by s.n desc), '[]') from (
       select task_type, complexity, used_model, suggested_model, count(*) as n from d
       where suggested_model is distinct from used_model
       group by task_type, complexity, used_model, suggested_model order by count(*) desc limit 30) s))
    from d)));
end $$;
revoke all on function public.ai_route_stats(uuid, integer) from public, anon;
grant execute on function public.ai_route_stats(uuid, integer) to authenticated;

commit;
