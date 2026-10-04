begin;

-- Campanhas › Insights da MAVI, Fase 6 (pedido de 04/10/2026): o lead que
-- importa.
--
-- * Cada campanha pode ter a etapa do CRM que importa (ex.: Negociação, de um
--   funil do MakeCRM do cliente) e a meta de custo por lead que chega a ela
--   (R$, na base de dinheiro dos insights). Quem edita campanhas escolhe, na
--   aba Insights; as etapas vêm do MakeCRM na hora (api/crm, ação
--   "pipelines").
-- * A MAVI passa a medir o custo por lead na etapa (e compara com a meta), e
--   leva em conta a maturidade dos leads: quantos ainda são recentes demais
--   para ter chegado à etapa (o MakeCRM informa a idade das abertas e quanto
--   tempo o lead costuma levar até cada etapa).

create table public.ad_campaign_crm_goals (
 company_id uuid not null,
 campaign_id uuid not null,
 pipeline_id text not null check (pipeline_id ~* '^[0-9a-f-]{36}$'),
 pipeline_name text not null default '' check (length(pipeline_name) <= 200),
 stage_id text not null check (stage_id ~* '^[0-9a-f-]{36}$'),
 stage_name text not null check (length(stage_name) between 1 and 200),
 cost_goal numeric(14,2) check (cost_goal is null or cost_goal > 0),
 updated_by uuid default auth.uid(),
 updated_at timestamptz not null default now(),
 primary key (company_id, campaign_id),
 foreign key (company_id, campaign_id) references public.ad_campaigns(company_id, id) on delete cascade
);
alter table public.ad_campaign_crm_goals enable row level security;
revoke all on public.ad_campaign_crm_goals from public, anon, authenticated;

create function mavi_private.campaign_crm_goal_json(c uuid, p_campaign uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
 select jsonb_build_object('pipeline_id', g.pipeline_id, 'pipeline_name', g.pipeline_name, 'stage_id', g.stage_id,
  'stage_name', g.stage_name, 'cost_goal', g.cost_goal, 'updated_at', g.updated_at,
  'updated_by_name', (select m.name from public.memberships m where m.company_id = g.company_id
   and m.user_id = g.updated_by))
 from public.ad_campaign_crm_goals g where g.company_id = c and g.campaign_id = p_campaign
$$;

-- Grava (ou tira, com nulo) a etapa que importa e a meta de custo.
create function public.set_campaign_crm_goal(p_company uuid, p_campaign uuid, p_goal jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v jsonb := p_goal; v_cost numeric; begin
 if not mavi_private.campaign_insight_reader(p_company, p_campaign) or not mavi_private.ad_can_write(p_company) then
  raise exception 'Sem permissão' using errcode = '42501';
 end if;
 if v is null or jsonb_typeof(v) <> 'object' or coalesce(v->>'stage_id', '') = '' then
  delete from public.ad_campaign_crm_goals where company_id = p_company and campaign_id = p_campaign;
  return null;
 end if;
 if coalesce(v->>'stage_id', '') !~* '^[0-9a-f-]{36}$' or coalesce(v->>'pipeline_id', '') !~* '^[0-9a-f-]{36}$'
  or length(btrim(coalesce(v->>'stage_name', ''))) = 0 then
  raise exception 'Escolha a etapa do funil.' using errcode = '22023';
 end if;
 v_cost := case when coalesce(v->>'cost_goal', '') = '' then null else (v->>'cost_goal')::numeric end;
 if v_cost is not null and v_cost <= 0 then
  raise exception 'A meta de custo precisa ser maior que zero.' using errcode = '22023';
 end if;
 insert into public.ad_campaign_crm_goals as g (company_id, campaign_id, pipeline_id, pipeline_name, stage_id,
  stage_name, cost_goal, updated_by, updated_at)
 values (p_company, p_campaign, v->>'pipeline_id', left(btrim(coalesce(v->>'pipeline_name', '')), 200),
  v->>'stage_id', left(btrim(v->>'stage_name'), 200), round(v_cost, 2), auth.uid(), now())
 on conflict (company_id, campaign_id) do update set pipeline_id = excluded.pipeline_id,
  pipeline_name = excluded.pipeline_name, stage_id = excluded.stage_id, stage_name = excluded.stage_name,
  cost_goal = excluded.cost_goal, updated_by = excluded.updated_by, updated_at = excluded.updated_at;
 return mavi_private.campaign_crm_goal_json(p_company, p_campaign);
end $$;
grant execute on function public.set_campaign_crm_goal(uuid, uuid, jsonb) to authenticated;

-- A da migração 20270331150000, com a etapa que importa.
create or replace function public.campaign_insights(p_company uuid, p_campaign uuid, p_runs integer default 8) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare s public.campaign_insight_settings; v_client uuid; v_last public.campaign_insight_runs; v_latest uuid; v_wait timestamptz;
begin
 if not mavi_private.campaign_insight_reader(p_company, p_campaign) then
  raise exception 'Sem permissão' using errcode = '42501';
 end if;
 s := mavi_private.campaign_insight_config(p_company);
 v_client := mavi_private.ad_campaign_client(p_campaign);
 select * into v_last from public.campaign_insight_runs r where r.company_id = p_company and r.campaign_id = p_campaign
  and r.status in ('done', 'queued', 'running') order by r.created_at desc limit 1;
 if v_last.id is not null then
  v_wait := v_last.created_at + make_interval(mins => s.min_interval_minutes);
  if v_wait <= now() then v_wait := null; end if;
 end if;
 select r.id into v_latest from public.campaign_insight_runs r where r.company_id = p_company
  and r.campaign_id = p_campaign and r.status = 'done' order by r.finished_at desc nulls last limit 1;
 return jsonb_build_object(
  'enabled', s.enabled,
  'schedule', mavi_private.campaign_insight_schedule(p_company, p_campaign),
  'timezone', mavi_private.company_tz(p_company),
  'last_scheduled_day', (select max(r.local_day) from public.campaign_insight_runs r where r.company_id = p_company
   and r.campaign_id = p_campaign and r.trigger = 'schedule'),
  'places', jsonb_build_object('panel', s.show_panel, 'badge', s.show_badge, 'tab', s.show_tab),
  'money_basis', s.money_basis,
  'min_interval_minutes', s.min_interval_minutes,
  'expire_days', s.expire_days,
  -- Quem responde pela campanha (recebe os avisos dos insights).
  'owners', mavi_private.campaign_owners_json(p_company, p_campaign),
  'can_set_owners', mavi_private.ad_can_write(p_company),
  -- A etapa do CRM que importa nesta campanha e a meta de custo por lead nela.
  'crm_goal', mavi_private.campaign_crm_goal_json(p_company, p_campaign),
  'blocker', mavi_private.campaign_insight_blocker(p_company, p_campaign),
  'capped', mavi_private.campaign_insight_capped(p_company),
  'wait_until', v_wait,
  'pending', (select jsonb_build_object('id', r.id, 'status', r.status, 'trigger', r.trigger,
    'created_at', r.created_at, 'started_at', r.started_at, 'note', r.note,
    -- Na fila com hora marcada: esperando a cota da plataforma (ou o orçamento do Google).
    'waiting_until', case when r.status = 'queued' and r.claimed_until > now() then r.claimed_until end,
    'requested_by_name', (select m.name from public.memberships m where m.company_id = r.company_id
     and m.user_id = r.requested_by))
   from public.campaign_insight_runs r where r.company_id = p_company and r.campaign_id = p_campaign
    and r.status in ('queued', 'running') order by r.created_at desc limit 1),
  'latest_run', v_latest,
  -- Abertos: os da última análise e os que voltaram do "Lembrar depois".
  -- Na ordem da análise (o primeiro é o "Comece por aqui"); os que voltaram
  -- do "Lembrar depois" vêm depois.
  'current', coalesce((select jsonb_agg(mavi_private.campaign_insight_json(i)
    order by (i.last_seen_run = v_latest) desc, i.rank nulls last,
     mavi_private.campaign_insight_rank(i.priority) desc, i.created_at)
   from public.campaign_insights i where i.company_id = p_company and i.campaign_id = p_campaign
    and i.status = 'new' and (i.last_seen_run = v_latest or i.snooze_until is not null)), '[]'),
  'applied', coalesce((select jsonb_agg(mavi_private.campaign_insight_json(i) order by i.applied_at desc)
   from (select * from public.campaign_insights i where i.company_id = p_company and i.campaign_id = p_campaign
    and i.status = 'applied' order by i.applied_at desc limit 30) i), '[]'),
  'snoozed', coalesce((select jsonb_agg(mavi_private.campaign_insight_json(i) order by i.snooze_until)
   from public.campaign_insights i where i.company_id = p_company and i.campaign_id = p_campaign
    and i.status = 'snoozed'), '[]'),
  'dismissed', coalesce((select jsonb_agg(mavi_private.campaign_insight_json(i) order by i.status_at desc)
   from (select * from public.campaign_insights i where i.company_id = p_company and i.campaign_id = p_campaign
    and i.status = 'dismissed' and i.status_at > now() - interval '90 days' order by i.status_at desc limit 30) i), '[]'),
  'runs', coalesce((select jsonb_agg(x.j order by x.created_at desc) from (
   select r.created_at, jsonb_build_object('id', r.id, 'trigger', r.trigger, 'status', r.status,
    'requested_by_name', (select m.name from public.memberships m where m.company_id = r.company_id
     and m.user_id = r.requested_by),
    'created_at', r.created_at, 'started_at', r.started_at, 'finished_at', r.finished_at,
    'cost_usd', r.cost_usd, 'model', r.model, 'provider_name', r.provider_name, 'summary', r.summary,
    'note', r.note, 'money_basis', r.money_basis, 'multiplier', r.multiplier, 'windows', r.windows,
    'insights_count', r.insights_count, 'repeated_count', r.repeated_count,
    'api_calls', r.api_calls, 'tokens', r.tokens,
    -- Os que expiraram sem uso saem da tela: no histórico, só a contagem.
    'expired_count', (select count(*)::int from public.campaign_insights i where i.run_id = r.id and i.status = 'expired'),
    'insights', coalesce((select jsonb_agg(mavi_private.campaign_insight_json(i)
      order by i.rank nulls last, mavi_private.campaign_insight_rank(i.priority) desc, i.created_at)
     from public.campaign_insights i where i.run_id = r.id and i.status <> 'expired'), '[]')) as j
   from public.campaign_insight_runs r where r.company_id = p_company and r.campaign_id = p_campaign
   order by r.created_at desc limit least(greatest(coalesce(p_runs, 8), 1), 50)) x), '[]'));
end $$;

-- A da migração 20270331150000, com a etapa que importa.
create or replace function public.ai_campaign_insight_material(p_secret text, p_run uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare r public.campaign_insight_runs; a public.ad_campaigns; y public.ad_cycles; k public.contracts;
 s public.campaign_insight_settings; v_block text; v_today date; begin
 if not mavi_private.ai_secret_ok(p_secret) then raise exception 'Sem permissão' using errcode = '42501'; end if;
 select * into r from public.campaign_insight_runs where id = p_run;
 if not found then return null; end if;
 v_block := mavi_private.campaign_insight_blocker(r.company_id, r.campaign_id);
 if v_block is not null then return jsonb_build_object('blocked', v_block); end if;
 select * into a from public.ad_campaigns where company_id = r.company_id and id = r.campaign_id;
 select * into y from public.ad_cycles where company_id = a.company_id and id = a.current_cycle_id;
 select * into k from public.contracts where company_id = a.company_id and id = a.contract_id;
 s := mavi_private.campaign_insight_config(r.company_id);
 v_today := mavi_private.company_today(r.company_id);
 return jsonb_build_object(
  'run', jsonb_build_object('id', r.id, 'trigger', r.trigger),
  'company_id', r.company_id,
  'today', v_today,
  'timezone', mavi_private.company_tz(r.company_id),
  'campaign', jsonb_build_object('id', a.id, 'name', a.name, 'platform', a.platform, 'notes', left(a.notes, 1500)),
  'client', (select jsonb_build_object('id', c.id, 'name', c.name) from public.clients c
   where c.company_id = k.company_id and c.id = k.client_id),
  'product', (select jsonb_build_object('id', p.id, 'name', p.name) from public.products p
   where p.company_id = k.company_id and p.id = k.product_id),
  'contract_id', k.id,
  'cycle', jsonb_build_object('id', y.id, 'start_date', y.start_date, 'end_date', y.end_date,
   'objective', y.objective, 'destination', y.destination, 'goal_results', y.goal_results, 'budget', y.budget,
   'multiplier', y.multiplier, 'niche', y.niche, 'meta_conversions', y.meta_conversions,
   'conversion_actions', to_jsonb(y.conversion_actions)),
  'links', coalesce((select jsonb_agg(jsonb_build_object('account_id', l.account_id,
    'campaign_id', l.external_campaign_id, 'manager_id', l.manager_id) order by l.account_id, l.external_campaign_id)
   from public.ad_cycle_links l where l.company_id = y.company_id and l.cycle_id = y.id), '[]'),
  'meta_tokens', case when a.platform = 'meta' then (select jsonb_object_agg(m.account_id,
    jsonb_build_object('token_cipher', m.token_cipher, 'expires_at', m.token_expires_at))
   from mavi_private.ad_meta_accounts m where m.company_id = y.company_id and m.account_id in
    (select l.account_id from public.ad_cycle_links l where l.company_id = y.company_id and l.cycle_id = y.id)) end,
  'google_token', case when a.platform = 'google' then (select jsonb_build_object('refresh_token_cipher',
    g.refresh_token_cipher) from mavi_private.ad_google_connections g where g.company_id = y.company_id) end,
  'crm_company_id', (select l.crm_company_id from public.client_crm_links l
   where l.company_id = k.company_id and l.client_id = k.client_id),
  'crm_goal', mavi_private.campaign_crm_goal_json(r.company_id, r.campaign_id),
  -- Os números do ciclo como o MAVI conta (as "Conversões que contam").
  'daily', coalesce((select jsonb_agg(jsonb_build_object('day', d.day, 'spend', d.spend,
    'conversions', d.conversions, 'clicks', d.clicks, 'impressions', d.impressions, 'multiplier', d.multiplier)
    order by d.day)
   from public.ad_daily_metrics d where d.company_id = y.company_id and d.cycle_id = y.id and d.day < v_today), '[]'),
  'settings', jsonb_build_object('money_basis', s.money_basis, 'run_cap_usd', s.run_cap_usd,
   'min_new_days', s.min_new_days, 'min_results', s.min_results, 'max_insights', s.max_insights),
  'last_done_at', (select max(x.finished_at) from public.campaign_insight_runs x where x.company_id = r.company_id
   and x.campaign_id = r.campaign_id and x.status = 'done' and x.id <> r.id),
  'previous', coalesce((select jsonb_agg(jsonb_build_object('kind', i.kind, 'priority', i.priority,
    'title', i.title, 'fingerprint', i.fingerprint, 'status', i.status, 'seen_count', i.seen_count,
    'last_seen_at', i.last_seen_at, 'status_reason', nullif(i.status_reason, '')) order by i.last_seen_at desc)
   from (select * from public.campaign_insights i where i.company_id = r.company_id and i.campaign_id = r.campaign_id
    order by i.last_seen_at desc limit 20) i), '[]'),
  'context', jsonb_build_object(
   'dossier', coalesce((select jsonb_agg(jsonb_build_object('kind', d.kind, 'text', d.text))
    from (select * from public.client_dossier_items d where d.company_id = k.company_id and d.client_id = k.client_id
     and not d.dismissed order by d.pinned desc, d.created_at desc limit 25) d), '[]'),
   'radar', coalesce((select jsonb_agg(jsonb_build_object('topic', t.name, 'title', i.title,
     'summary', left(i.summary, 400), 'severity', i.severity, 'mentions', i.mentions, 'last_seen', i.last_seen_at::date))
    from (select i.* from public.radar_items i join public.radar_topics t on t.id = i.topic_id
     where i.company_id = k.company_id and i.client_id = k.client_id
      and coalesce(mavi_private.radar_status(t.statuses, i.status)->>'kind', '') <> 'closed'
      and i.last_seen_at > now() - interval '90 days'
     order by i.severity desc nulls last, i.last_seen_at desc limit 10) i
    join public.radar_topics t on t.id = i.topic_id), '[]'),
   'temperature', (select jsonb_build_object('score', round(t.score), 'summary', left(t.summary, 800))
    from mavi_private.temperature_state t where t.client_id = k.client_id and t.company_id = k.company_id
     and t.score is not null),
   'meetings', coalesce((select jsonb_agg(jsonb_build_object('title', x.title, 'date', x.occurred_at::date,
     'text', x.text) order by x.occurred_at desc)
    from (select d.title, d.occurred_at, (select left(string_agg(c.content, E'\n' order by c.ord), 1500)
      from public.ai_chunks c where c.document_id = d.id and c.meta->>'kind' = 'summary') as text
     from public.ai_documents d where d.client_id = k.client_id and d.source_type = 'meeting'
      and d.occurred_at > now() - interval '60 days'
     order by d.occurred_at desc limit 3) x where x.text is not null), '[]')),
  'jev', mavi_private.campaign_insight_jev_route(r.company_id),
  -- Os aplicados nos últimos 30 dias (para medir antes × depois).
  'applied', coalesce((select jsonb_agg(jsonb_build_object('id', i.id, 'title', i.title, 'kind', i.kind,
    'target', i.target, 'applied_at', i.applied_at, 'effect', i.effect) order by i.applied_at desc)
   from (select * from public.campaign_insights i where i.company_id = r.company_id and i.campaign_id = r.campaign_id
    and i.status = 'applied' and i.applied_at > now() - interval '30 days' order by i.applied_at desc limit 5) i), '[]'),
  -- Os aprendizados do time que valem para este cliente.
  'lessons', coalesce((select jsonb_agg(jsonb_build_object('scope', l.scope, 'kind', l.kind, 'text', l.text)
    order by case l.scope when 'client' then 0 when 'product' then 1 else 2 end, l.updated_at desc)
   from (select * from public.campaign_insight_lessons l where l.company_id = r.company_id and l.status = 'active'
    and (l.scope = 'company' or (l.scope = 'client' and l.client_id = k.client_id)
     or (l.scope = 'product' and l.product_id = k.product_id))
    order by case l.scope when 'client' then 0 when 'product' then 1 else 2 end, l.updated_at desc limit 25) l), '[]'));
end $$;

commit;
