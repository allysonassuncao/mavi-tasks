begin;

-- Campanhas › Insights da MAVI: o insight que ninguém usa expira (pedido de
-- 04/10/2026).
--
-- * Aberto há N dias sem uso (Painel da MAVI › Campanhas; padrão 15, 0 = nunca) — aplicar, lembrar depois, descartar, criar
--   tarefa, 👍/👎 ou reabrir —, o insight passa a 'expired' e sai da tela
--   (painel, aba, selo da lista e conversa com a MAVI). No histórico das
--   análises fica só a contagem ("N expiraram sem uso"), para auditoria.
-- * A conta começa quando o insight apareceu, ou quando voltou do "Lembrar
--   depois" ou foi reaberto (status_at). Ser confirmado de novo numa análise
--   não zera a conta.
-- * O mesmo assunto não volta como novo por 30 dias.
-- * Quem expira é o agendamento dos insights (campaign_insight_tick, a cada
--   5 minutos), com o registro no histórico do insight.

-- O prazo (dias); 0: o insight nunca expira.
alter table public.campaign_insight_settings
 add column expire_days smallint not null default 15 check (expire_days between 0 and 90);

-- A da migração 20270328090000, com o prazo (coluna no fim da tabela).
create or replace function mavi_private.campaign_insight_config(c uuid) returns public.campaign_insight_settings
language sql stable security definer set search_path = '' as $$
 select coalesce((select s from public.campaign_insight_settings s where s.company_id = c),
  row(c, false, 'weekdays', '{1,4}'::smallint[], 3, 8, true, true, true, true, true, 'high', 'team', 'net',
   30, 0.50, 240, 2, 500, null, null, now(), true, true, 6, 15)::public.campaign_insight_settings)
$$;

-- A da migração 20270328090000, com o prazo.
create or replace function public.save_campaign_insight_settings(p_company uuid, p_settings jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare s public.campaign_insight_settings; v jsonb := p_settings; n public.campaign_insight_settings; begin
 if not mavi_private.leader(p_company) then
  raise exception 'Só administradores e gestores configuram os insights.' using errcode = '42501';
 end if;
 s := mavi_private.campaign_insight_config(p_company);
 if v is null or jsonb_typeof(v) <> 'object' then raise exception 'Configuração inválida.' using errcode = '22023'; end if;
 n := s;
 n.enabled := coalesce((v->>'enabled')::boolean, s.enabled);
 n.frequency := coalesce(v->>'frequency', s.frequency);
 n.weekdays := coalesce(mavi_private.campaign_insight_weekdays(v->'weekdays'), s.weekdays);
 n.every_days := coalesce((v->>'every_days')::smallint, s.every_days);
 n.hour := coalesce((v->>'hour')::smallint, s.hour);
 n.show_panel := coalesce((v->>'show_panel')::boolean, s.show_panel);
 n.show_badge := coalesce((v->>'show_badge')::boolean, s.show_badge);
 n.show_tab := coalesce((v->>'show_tab')::boolean, s.show_tab);
 n.mavi_context := coalesce((v->>'mavi_context')::boolean, s.mavi_context);
 n.notify_inbox := coalesce((v->>'notify_inbox')::boolean, s.notify_inbox);
 n.notify_min_priority := coalesce(v->>'notify_min_priority', s.notify_min_priority);
 n.notify_who := coalesce(v->>'notify_who', s.notify_who);
 n.money_basis := coalesce(v->>'money_basis', s.money_basis);
 n.monthly_cap_usd := case when v ? 'monthly_cap_usd' then (v->>'monthly_cap_usd')::numeric else s.monthly_cap_usd end;
 n.run_cap_usd := coalesce((v->>'run_cap_usd')::numeric, s.run_cap_usd);
 n.min_interval_minutes := coalesce((v->>'min_interval_minutes')::int, s.min_interval_minutes);
 n.min_new_days := coalesce((v->>'min_new_days')::smallint, s.min_new_days);
 n.google_daily_ops := coalesce((v->>'google_daily_ops')::int, s.google_daily_ops);
 n.creative_images := coalesce((v->>'creative_images')::boolean, s.creative_images);
 n.creative_videos := coalesce((v->>'creative_videos')::boolean, s.creative_videos);
 n.creative_new_max := coalesce((v->>'creative_new_max')::smallint, s.creative_new_max);
 n.expire_days := coalesce((v->>'expire_days')::smallint, s.expire_days);
 if cardinality(n.weekdays) = 0 then
  raise exception 'Escolha ao menos um dia da semana.' using errcode = '22023';
 end if;
 insert into public.campaign_insight_settings as x (company_id, enabled, frequency, weekdays, every_days, hour,
  show_panel, show_badge, show_tab, mavi_context, notify_inbox, notify_min_priority, notify_who, money_basis,
  monthly_cap_usd, run_cap_usd, min_interval_minutes, min_new_days, google_daily_ops, creative_images, creative_videos,
  creative_new_max, expire_days, updated_by, updated_at)
 values (p_company, n.enabled, n.frequency, n.weekdays, n.every_days, n.hour, n.show_panel, n.show_badge, n.show_tab,
  n.mavi_context, n.notify_inbox, n.notify_min_priority, n.notify_who, n.money_basis, n.monthly_cap_usd,
  n.run_cap_usd, n.min_interval_minutes, n.min_new_days, n.google_daily_ops, n.creative_images, n.creative_videos,
  n.creative_new_max, n.expire_days, auth.uid(), now())
 on conflict (company_id) do update set enabled = excluded.enabled, frequency = excluded.frequency,
  weekdays = excluded.weekdays, every_days = excluded.every_days, hour = excluded.hour,
  show_panel = excluded.show_panel, show_badge = excluded.show_badge, show_tab = excluded.show_tab,
  mavi_context = excluded.mavi_context, notify_inbox = excluded.notify_inbox,
  notify_min_priority = excluded.notify_min_priority, notify_who = excluded.notify_who,
  money_basis = excluded.money_basis, monthly_cap_usd = excluded.monthly_cap_usd,
  run_cap_usd = excluded.run_cap_usd, min_interval_minutes = excluded.min_interval_minutes,
  min_new_days = excluded.min_new_days, google_daily_ops = excluded.google_daily_ops,
  creative_images = excluded.creative_images, creative_videos = excluded.creative_videos,
  creative_new_max = excluded.creative_new_max, expire_days = excluded.expire_days,
  -- Teto mudou: avisa de novo se for atingido.
  cap_noticed_month = case when excluded.monthly_cap_usd is distinct from x.monthly_cap_usd then null
   else x.cap_noticed_month end,
  updated_by = excluded.updated_by, updated_at = excluded.updated_at;
 return mavi_private.campaign_insight_settings_json(p_company);
end $$;

alter table public.campaign_insights drop constraint campaign_insights_status_check;
alter table public.campaign_insights add constraint campaign_insights_status_check
 check (status in ('new', 'applied', 'dismissed', 'snoozed', 'expired'));
alter table public.campaign_insight_events drop constraint campaign_insight_events_action_check;
alter table public.campaign_insight_events add constraint campaign_insight_events_action_check
 check (action in ('applied', 'dismissed', 'snoozed', 'reopened', 'returned', 'task', 'expired'));

-- A da migração 20270329090000: o histórico das análises não mostra os
-- expirados (só a contagem).
create or replace function public.campaign_insights(p_company uuid, p_campaign uuid, p_runs integer default 8) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare s public.campaign_insight_settings; v_last public.campaign_insight_runs; v_latest uuid; v_wait timestamptz;
begin
 if not mavi_private.campaign_insight_reader(p_company, p_campaign) then
  raise exception 'Sem permissão' using errcode = '42501';
 end if;
 s := mavi_private.campaign_insight_config(p_company);
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
  'current', coalesce((select jsonb_agg(mavi_private.campaign_insight_json(i)
    order by mavi_private.campaign_insight_rank(i.priority) desc, i.created_at)
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
      order by mavi_private.campaign_insight_rank(i.priority) desc, i.created_at)
     from public.campaign_insights i where i.run_id = r.id and i.status <> 'expired'), '[]')) as j
   from public.campaign_insight_runs r where r.company_id = p_company and r.campaign_id = p_campaign
   order by r.created_at desc limit least(greatest(coalesce(p_runs, 8), 1), 50)) x), '[]'));
end $$;

-- A da migração 20270329090000: o expirado também não volta como novo.
create or replace function public.ai_campaign_insight_store(p_secret text, p_run uuid, p_result jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare r public.campaign_insight_runs; s public.campaign_insight_settings; v jsonb := coalesce(p_result, '{}');
 u jsonb; x jsonb; v_cost numeric := 0; v_client uuid; v_contract uuid; v_new integer := 0; v_again integer := 0;
 v_old uuid; v_basis text; v_notify integer := 0; v_status text; v_first text; v_high integer := 0;
 v_name text; begin
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
  for x in select * from jsonb_array_elements(case when jsonb_typeof(v->'insights') = 'array' then v->'insights'
   else '[]' end)
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
     money_basis = v_basis, confidence = case when x->>'confidence' ~ '^[0-9.]+$'
      then least(greatest((x->>'confidence')::numeric, 0), 1) end
    where id = v_old;
    v_again := v_again + 1;
   else
    insert into public.campaign_insights(company_id, campaign_id, run_id, last_seen_run, kind, priority, title, body,
     action, evidence, target, source, fingerprint, money_basis, confidence)
    values (r.company_id, r.campaign_id, r.id, r.id, x->>'kind', x->>'priority', left(btrim(x->>'title'), 200),
     left(coalesce(x->>'body', ''), 2000), left(coalesce(x->>'action', ''), 800), x->'evidence',
     case when jsonb_typeof(x->'target') = 'object' then x->'target' end,
     case when x->>'source' = 'rule' then 'rule' else 'mavi' end, left(x->>'fingerprint', 300), v_basis,
     case when x->>'confidence' ~ '^[0-9.]+$' then least(greatest((x->>'confidence')::numeric, 0), 1) end);
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

 -- Caixa de entrada + push: quem atende o cliente (e os líderes, se pedido)
 -- e quem pediu a análise. Um aviso por pessoa por análise.
 if v_status = 'done' and s.notify_inbox and (v_notify > 0 or (r.trigger = 'manual' and r.requested_by is not null))
 then
  insert into public.notifications(company_id, user_id, actor_id, task_id, kind, title, body, link, client_id)
  select r.company_id, m.user_id, null, null, 'campaign_insight', left(format('Insights da MAVI: %s', v_name), 300),
   left(case when v_notify > 0 then format('%s %s%s · %s', v_notify,
     case when v_notify = 1 then 'insight novo' else 'insights novos' end,
     case when v_high > 0 then format(' (%s de prioridade alta)', v_high) else '' end, v_first)
    when v_new + v_again > 0 then format('Análise pronta: %s %s.', v_new + v_again,
     case when v_new + v_again = 1 then 'insight' else 'insights' end)
    else 'Análise pronta: nada novo que mereça ação agora.' end, 300),
   '/campanhas/' || r.campaign_id || '?aba=insights', v_client
  from public.memberships m
  where m.company_id = r.company_id and m.active
   and mavi_private.campaign_alert_sees(r.company_id, m.user_id, v_client)
   and ((m.user_id = r.requested_by)
    or (v_notify > 0 and (exists (select 1 from public.client_teams ct join public.team_members tm
       on tm.company_id = ct.company_id and tm.team_id = ct.team_id
      where ct.company_id = r.company_id and ct.client_id = v_client and tm.user_id = m.user_id)
     or (s.notify_who = 'team_leaders' and m.role in ('admin', 'manager')))));
 end if;

 perform mavi_private.broadcast(r.company_id, jsonb_build_object('kind', 'campaign_insights',
  'campaign', r.campaign_id, 'run', r.id, 'status', v_status));
 return jsonb_build_object('ok', true, 'new', v_new, 'repeated', v_again);
end $$;

-- A da migração 20270329090000, com os insights que expiram sem uso.
create or replace function mavi_private.campaign_insight_tick() returns integer
language plpgsql security definer set search_path = '' as $$
declare s public.campaign_insight_settings; a record; v_n integer := 0; v_month date; begin
 -- N dias (o prazo da empresa) abertos sem uso (aplicar, lembrar depois, descartar, tarefa,
 -- 👍/👎 ou reabrir): o insight expira e sai da tela. Conta desde que apareceu
 -- ou voltou (do "Lembrar depois" ou reaberto); ser confirmado de novo numa
 -- análise não zera a conta.
 for a in
  update public.campaign_insights i set status = 'expired', status_at = now(), status_by = null
  where i.status = 'new'
   and coalesce((select x.expire_days from public.campaign_insight_settings x where x.company_id = i.company_id), 15) > 0
   and coalesce(i.status_at, i.created_at) < now() - make_interval(days =>
    coalesce((select x.expire_days from public.campaign_insight_settings x where x.company_id = i.company_id), 15))
   and not exists (select 1 from public.campaign_insight_tasks t where t.insight_id = i.id)
   and not exists (select 1 from public.campaign_insight_feedback f where f.insight_id = i.id)
  returning i.id, i.company_id, i.campaign_id
 loop
  insert into public.campaign_insight_events(company_id, insight_id, user_id, action)
  values (a.company_id, a.id, null, 'expired');
 end loop;
 -- "Lembrar depois": chegou a data, o insight volta para os abertos e quem
 -- adiou recebe o lembrete.
 for a in
  update public.campaign_insights i set status = 'new', status_at = now()
  where i.status = 'snoozed' and i.snooze_until <= now()
  returning i.id, i.company_id, i.campaign_id, i.title, i.status_by
 loop
  insert into public.campaign_insight_events(company_id, insight_id, user_id, action)
  values (a.company_id, a.id, null, 'returned');
  if a.status_by is not null then
   insert into public.notifications(company_id, user_id, actor_id, task_id, kind, title, body, link, client_id)
   select a.company_id, a.status_by, null, null, 'campaign_insight', left(format('Lembrete: %s', a.title), 300),
    left(format('O insight que você deixou para depois voltou · %s', c.name), 300),
    '/campanhas/' || a.campaign_id || '?aba=insights', mavi_private.ad_campaign_client(a.campaign_id)
   from public.ad_campaigns c where c.id = a.campaign_id;
  end if;
  perform mavi_private.broadcast(a.company_id, jsonb_build_object('kind', 'campaign_insights', 'campaign', a.campaign_id,
   'run', null, 'status', 'returned'));
 end loop;
 -- Reservas vencidas depois da última tentativa: falhou.
 update public.campaign_insight_runs set status = 'failed', finished_at = now(),
  note = left('A análise não terminou depois de 3 tentativas.', 1000)
 where status = 'running' and claimed_until < now() and attempts >= 3;
 for s in select * from public.campaign_insight_settings where enabled loop
  if mavi_private.campaign_insight_capped(s.company_id) then
   v_month := date_trunc('month', now() at time zone mavi_private.company_tz(s.company_id))::date;
   if s.cap_noticed_month is distinct from v_month then
    update public.campaign_insight_settings set cap_noticed_month = v_month where company_id = s.company_id;
    insert into public.notifications(company_id, user_id, actor_id, task_id, kind, title, body, link)
    select s.company_id, m.user_id, null, null, 'campaign_insight',
     'Insights das campanhas pausados: teto do mês',
     left(format('O gasto do mês chegou a US$ %s (teto de US$ %s). As análises voltam quando o mês virar ou quando o teto subir.',
      to_char(mavi_private.campaign_insight_spent(s.company_id), 'FM999990.00'),
      to_char(s.monthly_cap_usd, 'FM999990.00')), 300),
     '/mavi#campanhas'
    from public.memberships m where m.company_id = s.company_id and m.active and m.role in ('admin', 'manager');
   end if;
   continue;
  end if;
  for a in
   select x.id from public.ad_campaigns x
   where x.company_id = s.company_id and x.status = 'active' and not x.archived and x.platform in ('meta', 'google')
    and not exists (select 1 from public.campaign_insight_runs r where r.company_id = x.company_id
     and r.campaign_id = x.id and r.status in ('queued', 'running'))
   order by x.id
  loop
   continue when mavi_private.campaign_insight_blocker(s.company_id, a.id) is not null;
   continue when not mavi_private.campaign_insight_due(s.company_id, a.id);
   insert into public.campaign_insight_runs(company_id, campaign_id, cycle_id, trigger, local_day)
   select s.company_id, a.id, x.current_cycle_id, 'schedule', mavi_private.company_today(s.company_id)
   from public.ad_campaigns x where x.id = a.id;
   v_n := v_n + 1;
   exit when v_n >= 200;
  end loop;
 end loop;
 return v_n;
end $$;

notify pgrst, 'reload schema';

commit;
