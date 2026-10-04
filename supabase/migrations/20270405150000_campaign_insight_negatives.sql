begin;

-- Campanhas › Insights da MAVI, Fase 8 (pedido de 04/10/2026): termos de
-- pesquisa e negativas no Google.
--
-- * O worker separa os termos de pesquisa do ciclo que gastaram sem nenhuma
--   conversão (e ainda não foram negativados); a MAVI escolhe, pelo contexto
--   do cliente, os que são claramente fora do que ele vende; o servidor soma
--   o gasto e monta UM insight com a lista pronta para colar no Google Ads.
-- * A lista vai em campaign_insights.extra ({negatives: [{term, match, spend,
--   clicks, campaign, why}]}): a tela mostra e copia ([exata] / "frase").

alter table public.campaign_insights add column extra jsonb
 check (extra is null or (jsonb_typeof(extra) = 'object' and length(extra::text) <= 20000));

-- Só o que a tela entende: até 60 negativas bem formadas.
create function mavi_private.campaign_insight_extra(v jsonb) returns jsonb
language sql immutable set search_path = '' as $$
 select case when jsonb_typeof(v) = 'object' and jsonb_typeof(v->'negatives') = 'array' then
  jsonb_build_object('negatives', coalesce((select jsonb_agg(jsonb_build_object(
    'term', left(btrim(n->>'term'), 200),
    'match', case when n->>'match' = 'phrase' then 'phrase' else 'exact' end,
    'spend', case when n->>'spend' ~ '^[0-9.]+$' then round((n->>'spend')::numeric, 2) else 0 end,
    'clicks', case when n->>'clicks' ~ '^[0-9]+$' then (n->>'clicks')::int else 0 end,
    'campaign', left(coalesce(n->>'campaign', ''), 200),
    'why', left(coalesce(n->>'why', ''), 200)) order by t.k)
   from jsonb_array_elements(v->'negatives') with ordinality t(n, k)
   where jsonb_typeof(n) = 'object' and length(btrim(coalesce(n->>'term', ''))) between 1 and 200 and t.k <= 60), '[]'))
 end
$$;

-- A da migração 20270329090000, com a lista (extra).
create or replace function mavi_private.campaign_insight_json(i public.campaign_insights) returns jsonb
language sql stable security definer set search_path = '' as $$
 select jsonb_build_object('id', i.id, 'run_id', i.run_id, 'last_seen_run', i.last_seen_run, 'kind', i.kind,
  'priority', i.priority, 'title', i.title, 'body', i.body, 'action', i.action, 'evidence', i.evidence,
  'target', i.target, 'source', i.source, 'money_basis', i.money_basis, 'confidence', i.confidence,
  'status', i.status, 'seen_count', i.seen_count, 'last_seen_at', i.last_seen_at, 'created_at', i.created_at,
  'status_at', i.status_at, 'status_reason', nullif(i.status_reason, ''),
  'status_by_name', (select m.name from public.memberships m where m.company_id = i.company_id and m.user_id = i.status_by),
  'snooze_until', i.snooze_until, 'applied_at', i.applied_at, 'effect', i.effect, 'effect_at', i.effect_at,
  'extra', i.extra,
  'my_vote', (select f.vote from public.campaign_insight_feedback f where f.insight_id = i.id
   and f.user_id = auth.uid() and f.vote in ('up', 'down')),
  'votes', jsonb_build_object(
   'up', (select count(*) from public.campaign_insight_feedback f where f.insight_id = i.id and f.vote = 'up'),
   'down', (select count(*) from public.campaign_insight_feedback f where f.insight_id = i.id and f.vote = 'down')),
  'tasks', coalesce((select jsonb_agg(jsonb_build_object('id', tk.id, 'title', tk.title, 'status', tk.status,
     'due_date', tk.due_date, 'assignee_name', mm.name) order by x.created_at desc)
   from public.campaign_insight_tasks x
   join public.tasks tk on tk.id = x.task_id and not tk.archived
   left join public.memberships mm on mm.company_id = tk.company_id and mm.user_id = tk.assignee_id
   where x.insight_id = i.id
    and (mavi_private.leader(i.company_id) or mavi_private.task_access(i.company_id, tk.id))), '[]'))
$$;

-- A da migração 20270331150000, com a lista (extra).
create or replace function public.ai_campaign_insight_store(p_secret text, p_run uuid, p_result jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare r public.campaign_insight_runs; s public.campaign_insight_settings; v jsonb := coalesce(p_result, '{}');
 u jsonb; x jsonb; v_cost numeric := 0; v_client uuid; v_contract uuid; v_new integer := 0; v_again integer := 0;
 v_old uuid; v_basis text; v_notify integer := 0; v_status text; v_first text; v_high integer := 0;
 v_name text; v_rank integer; v_owners boolean; begin
 if not mavi_private.ai_secret_ok(p_secret) then raise exception 'Sem permissão' using errcode = '42501'; end if;
 select * into r from public.campaign_insight_runs where id = p_run for update;
 if not found or r.status <> 'running' then return jsonb_build_object('ok', false); end if;
 s := mavi_private.campaign_insight_config(r.company_id);
 select k.client_id, k.id, a.name into v_client, v_contract, v_name from public.ad_campaigns a
 join public.contracts k on k.company_id = a.company_id and k.id = a.contract_id
 where a.company_id = r.company_id and a.id = r.campaign_id;
 v_basis := case when v->>'money_basis' in ('net', 'gross') then v->>'money_basis' else s.money_basis end;
 v_status := case when v->>'status' = 'skipped' then 'skipped' else 'done' end;

 for u in select * from jsonb_array_elements(case when jsonb_typeof(v->'usage') = 'array' then v->'usage' else '[]' end)
 loop
  insert into public.ai_usage(company_id, user_id, module, kind, client_id, contract_id, model, input_tokens,
   output_tokens, cache_read_tokens, cache_write_tokens, cost_usd, provider_id, provider_name)
  values (r.company_id, r.requested_by, 'campaign_insights', left(coalesce(u->>'kind', 'campaign_insights'), 40),
   v_client, v_contract, left(coalesce(u->>'model', ''), 80), greatest(coalesce((u->>'input')::int, 0), 0),
   greatest(coalesce((u->>'output')::int, 0), 0), greatest(coalesce((u->>'cache_read')::int, 0), 0),
   greatest(coalesce((u->>'cache_write')::int, 0), 0), least(greatest(coalesce((u->>'cost')::numeric, 0), 0), 20),
   case when u->>'provider_id' ~* '^[0-9a-f-]{36}$' then (u->>'provider_id')::uuid end,
   left(coalesce(u->>'provider', ''), 120));
  v_cost := v_cost + least(greatest(coalesce((u->>'cost')::numeric, 0), 0), 20);
 end loop;

 if v_status = 'done' then
  -- Na ordem em que vêm (a ordem da análise; o primeiro é o "Comece por aqui").
  for x, v_rank in select t.e, t.n from jsonb_array_elements(case when jsonb_typeof(v->'insights') = 'array'
   then v->'insights' else '[]' end) with ordinality t(e, n)
  loop
   continue when x->>'kind' not in ('highlight', 'opportunity', 'problem', 'tracking')
    or x->>'priority' not in ('high', 'medium', 'low') or length(btrim(coalesce(x->>'title', ''))) < 3
    or jsonb_typeof(x->'evidence') <> 'array' or jsonb_array_length(x->'evidence') not between 1 and 8
    or length(coalesce(x->>'fingerprint', '')) < 3;
   -- O mesmo assunto descartado (60 dias), aplicado ou expirado sem uso (30
   -- dias) ou adiado não volta como novo.
   continue when exists (select 1 from public.campaign_insights i where i.company_id = r.company_id
    and i.campaign_id = r.campaign_id and i.fingerprint = left(x->>'fingerprint', 300)
    and ((i.status = 'dismissed' and i.status_at > now() - interval '60 days')
     or (i.status = 'applied' and i.applied_at > now() - interval '30 days')
     or (i.status = 'expired' and i.status_at > now() - interval '30 days')
     or i.status = 'snoozed'));
   select i.id into v_old from public.campaign_insights i where i.company_id = r.company_id
    and i.campaign_id = r.campaign_id and i.status = 'new' and i.fingerprint = left(x->>'fingerprint', 300)
    and i.last_seen_at > now() - interval '45 days'
   order by i.last_seen_at desc limit 1;
   if v_old is not null then
    update public.campaign_insights set last_seen_run = r.id, last_seen_at = now(), seen_count = seen_count + 1,
     kind = x->>'kind', priority = x->>'priority', title = left(btrim(x->>'title'), 200),
     body = left(coalesce(x->>'body', ''), 2000), action = left(coalesce(x->>'action', ''), 800),
     evidence = x->'evidence', target = case when jsonb_typeof(x->'target') = 'object' then x->'target' end,
     money_basis = v_basis, rank = v_rank, extra = mavi_private.campaign_insight_extra(x->'extra'), confidence = case when x->>'confidence' ~ '^[0-9.]+$'
      then least(greatest((x->>'confidence')::numeric, 0), 1) end
    where id = v_old;
    v_again := v_again + 1;
   else
    insert into public.campaign_insights(company_id, campaign_id, run_id, last_seen_run, kind, priority, title, body,
     action, evidence, target, source, fingerprint, money_basis, confidence, rank, extra)
    values (r.company_id, r.campaign_id, r.id, r.id, x->>'kind', x->>'priority', left(btrim(x->>'title'), 200),
     left(coalesce(x->>'body', ''), 2000), left(coalesce(x->>'action', ''), 800), x->'evidence',
     case when jsonb_typeof(x->'target') = 'object' then x->'target' end,
     case when x->>'source' = 'rule' then 'rule' else 'mavi' end, left(x->>'fingerprint', 300), v_basis,
     case when x->>'confidence' ~ '^[0-9.]+$' then least(greatest((x->>'confidence')::numeric, 0), 1) end, v_rank,
     mavi_private.campaign_insight_extra(x->'extra'));
    v_new := v_new + 1;
    if mavi_private.campaign_insight_rank(x->>'priority') >= mavi_private.campaign_insight_rank(s.notify_min_priority)
    then
     v_notify := v_notify + 1;
     v_first := coalesce(v_first, left(btrim(x->>'title'), 200));
     if x->>'priority' = 'high' then v_high := v_high + 1; end if;
    end if;
   end if;
  end loop;
 end if;

 update public.campaign_insight_runs set status = v_status, finished_at = now(), claimed_until = null,
  cost_usd = v_cost, summary = left(coalesce(v->>'summary', ''), 600), note = left(coalesce(v->>'note', ''), 1000),
  money_basis = v_basis, multiplier = case when v->>'multiplier' ~ '^[0-9.]+$' then (v->>'multiplier')::numeric end,
  windows = case when jsonb_typeof(v->'windows') = 'object' then v->'windows' else '{}' end,
  model = left(coalesce(v->>'model', ''), 120), provider_name = left(coalesce(v->>'provider', ''), 120),
  insights_count = v_new, repeated_count = v_again,
  api_calls = case when jsonb_typeof(v->'api_calls') = 'object' then v->'api_calls' else '{}' end,
  tokens = case when jsonb_typeof(v->'tokens') = 'object' then v->'tokens' else '{}' end
 where id = r.id;

 -- O efeito medido dos aplicados (antes × depois).
 for x in select * from jsonb_array_elements(case when jsonb_typeof(v->'effects') = 'array' then v->'effects' else '[]' end)
 loop
  continue when x->>'insight' !~* '^[0-9a-f-]{36}$' or jsonb_typeof(x->'effect') <> 'object';
  update public.campaign_insights set effect = x->'effect', effect_at = now()
  where id = (x->>'insight')::uuid and company_id = r.company_id and campaign_id = r.campaign_id and status = 'applied';
 end loop;

 -- Caixa de entrada + push: os responsáveis pela campanha (sem responsável,
 -- ou se a empresa pediu: as equipes do cliente; e os líderes, se pedido) e
 -- quem pediu a análise. Um aviso por pessoa por análise.
 v_owners := exists (select 1 from public.ad_campaign_owners o join public.memberships mm
  on mm.company_id = o.company_id and mm.user_id = o.user_id and mm.active
  where o.company_id = r.company_id and o.campaign_id = r.campaign_id);
 if v_status = 'done' and s.notify_inbox and (v_notify > 0 or (r.trigger = 'manual' and r.requested_by is not null))
 then
  insert into public.notifications(company_id, user_id, actor_id, task_id, kind, title, body, link, client_id)
  select r.company_id, m.user_id, null, null, 'campaign_insight', left(format('Insights da MAVI: %s', v_name), 300),
   left(case when v_notify > 0 then format('%s %s%s · %s', v_notify,
     case when v_notify = 1 then 'insight novo' else 'insights novos' end,
     case when v_high > 0 then format(' (%s para fazer hoje)', v_high) else '' end, v_first)
    when v_new + v_again > 0 then format('Análise pronta: %s %s.', v_new + v_again,
     case when v_new + v_again = 1 then 'insight' else 'insights' end)
    else 'Análise pronta: nada novo que mereça ação agora.' end, 300),
   '/campanhas/' || r.campaign_id || '?aba=insights', v_client
  from public.memberships m
  where m.company_id = r.company_id and m.active
   and mavi_private.campaign_alert_sees(r.company_id, m.user_id, v_client)
   and ((m.user_id = r.requested_by)
    or (v_notify > 0 and (exists (select 1 from public.ad_campaign_owners o where o.company_id = r.company_id
       and o.campaign_id = r.campaign_id and o.user_id = m.user_id)
     or ((s.notify_who <> 'owners' or not v_owners) and exists (select 1 from public.client_teams ct
       join public.team_members tm on tm.company_id = ct.company_id and tm.team_id = ct.team_id
      where ct.company_id = r.company_id and ct.client_id = v_client and tm.user_id = m.user_id))
     or (s.notify_who = 'team_leaders' and m.role in ('admin', 'manager')))));
 end if;

 perform mavi_private.broadcast(r.company_id, jsonb_build_object('kind', 'campaign_insights',
  'campaign', r.campaign_id, 'run', r.id, 'status', v_status));
 return jsonb_build_object('ok', true, 'new', v_new, 'repeated', v_again);
end $$;

commit;
