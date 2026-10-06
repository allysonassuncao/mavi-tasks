begin;

-- Campanhas › Insights da MAVI na aba Plataforma (pedido de 06/10/2026).
--
-- A Plataforma (Meta e Google) mostra, em cada linha, os insights cujo alvo
-- ou cujos números citam aquele item (campanha, conjunto/grupo, anúncio,
-- palavra-chave, termo de pesquisa, público). Para a campanha e o conjunto
-- contarem os insights dos itens de dentro, cada insight guarda de quem os
-- itens citados são filhos: campaign_insights.extra.parents
-- ({"a:<anúncio>": "s:<conjunto>", "s:<conjunto>": "c:<campanha>"}). Os
-- insights já abertos ganham a lista quando a análise seguinte os reconfirma.

-- A da migração 20270506090000, com parents.
create or replace function mavi_private.campaign_insight_extra(v jsonb) returns jsonb
language plpgsql immutable set search_path = '' as $$
declare v_neg jsonb; v_cre jsonb; v_par jsonb; v_out jsonb := '{}'; begin
 if jsonb_typeof(v) <> 'object' then return null; end if;
 if jsonb_typeof(v->'negatives') = 'array' then
  v_neg := coalesce((select jsonb_agg(jsonb_build_object(
    'term', left(btrim(n->>'term'), 200),
    'match', case when n->>'match' = 'phrase' then 'phrase' else 'exact' end,
    'spend', case when n->>'spend' ~ '^[0-9.]+$' then round((n->>'spend')::numeric, 2) else 0 end,
    'clicks', case when n->>'clicks' ~ '^[0-9]+$' then (n->>'clicks')::int else 0 end,
    'campaign', left(coalesce(n->>'campaign', ''), 200),
    'why', left(coalesce(n->>'why', ''), 200)) order by t.k)
   from jsonb_array_elements(v->'negatives') with ordinality t(n, k)
   where jsonb_typeof(n) = 'object' and length(btrim(coalesce(n->>'term', ''))) between 1 and 200 and t.k <= 60), '[]');
  v_out := v_out || jsonb_build_object('negatives', v_neg);
 end if;
 if jsonb_typeof(v->'creatives') = 'array' then
  v_cre := (select jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
    'entity', left(c->>'entity', 200),
    'name', left(coalesce(c->>'name', ''), 300),
    'parent', nullif(left(coalesce(c->>'parent', ''), 300), ''),
    'key', left(c->>'key', 200),
    'kind', case when c->>'kind' = 'video' then 'video' else 'image' end,
    'thumb', c->>'thumb',
    'link', case when c->>'link' ~ '^https://(www\.)?(facebook|instagram)\.com/' and length(c->>'link') <= 500
     then c->>'link' end,
    'summary', case when jsonb_typeof(c->'summary') = 'object' then nullif(jsonb_strip_nulls(jsonb_build_object(
      'formato', left(c->'summary'->>'formato', 160), 'promessa', left(c->'summary'->>'promessa', 200),
      'gancho', left(c->'summary'->>'gancho', 200), 'oferta', left(c->'summary'->>'oferta', 160),
      'prova', left(c->'summary'->>'prova', 160), 'cta', left(c->'summary'->>'cta', 120),
      'publico_aparente', left(c->'summary'->>'publico_aparente', 160),
      'texto_na_imagem', left(c->'summary'->>'texto_na_imagem', 200),
      'resumo', left(c->'summary'->>'resumo', 300))), '{}') end,
    'transcript', nullif(left(coalesce(c->>'transcript', ''), 600), ''))) order by t.k)
   from jsonb_array_elements(v->'creatives') with ordinality t(c, k)
   where jsonb_typeof(c) = 'object' and t.k <= 6
    and length(coalesce(c->>'entity', '')) between 1 and 200 and length(coalesce(c->>'key', '')) between 3 and 200
    and coalesce(c->>'thumb', '') ~ '^https://storage\.googleapis\.com/' and length(c->>'thumb') <= 600);
  if v_cre is not null then
   if length((v_out || jsonb_build_object('creatives', v_cre))::text) > 19000 then
    v_cre := (select jsonb_agg(x - 'summary' - 'transcript' order by k) from jsonb_array_elements(v_cre)
     with ordinality t(x, k));
   end if;
   if length((v_out || jsonb_build_object('creatives', v_cre))::text) <= 19500 then
    v_out := v_out || jsonb_build_object('creatives', v_cre);
   end if;
  end if;
 end if;
 -- De quem cada item citado é filho (anúncio › conjunto › campanha): até 40, chaves curtas.
 if jsonb_typeof(v->'parents') = 'object' then
  v_par := (select jsonb_object_agg(p.key, p.value #>> '{}') from (select e.key, e.value
    from jsonb_each(v->'parents') e
    where length(e.key) between 3 and 200 and jsonb_typeof(e.value) = 'string'
     and length(e.value #>> '{}') between 3 and 200
    order by e.key limit 40) p);
  if v_par is not null and length((v_out || jsonb_build_object('parents', v_par))::text) <= 19800 then
   v_out := v_out || jsonb_build_object('parents', v_par);
  end if;
 end if;
 return nullif(v_out, '{}');
end $$;

-- Mais um local ligável no Painel da MAVI › Campanhas: "Na aba Plataforma".
alter table public.campaign_insight_settings add column show_platform boolean not null default true;

-- A da migração 20270404150000, com show_platform.
create or replace function mavi_private.campaign_insight_config(c uuid) returns public.campaign_insight_settings
language sql stable security definer set search_path = '' as $$
 select coalesce((select s from public.campaign_insight_settings s where s.company_id = c),
  row(c, false, 'weekdays', '{1,4}'::smallint[], 3, 8, true, true, true, true, true, 'high', 'owners', 'net',
   30, 0.50, 240, 2, 500, null, null, now(), true, true, 6, 15, 10, 4, true, true, true)::public.campaign_insight_settings)
$$;

-- A da migração 20270404150000, com show_platform.
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
 n.show_platform := coalesce((v->>'show_platform')::boolean, s.show_platform);
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
 n.min_results := coalesce((v->>'min_results')::smallint, s.min_results);
 n.max_insights := coalesce((v->>'max_insights')::smallint, s.max_insights);
 n.watch_enabled := coalesce((v->>'watch_enabled')::boolean, s.watch_enabled);
 n.watch_api := coalesce((v->>'watch_api')::boolean, s.watch_api);
 if cardinality(n.weekdays) = 0 then
  raise exception 'Escolha ao menos um dia da semana.' using errcode = '22023';
 end if;
 insert into public.campaign_insight_settings as x (company_id, enabled, frequency, weekdays, every_days, hour,
  show_panel, show_badge, show_tab, mavi_context, notify_inbox, notify_min_priority, notify_who, money_basis,
  monthly_cap_usd, run_cap_usd, min_interval_minutes, min_new_days, google_daily_ops, creative_images, creative_videos,
  creative_new_max, expire_days, min_results, max_insights, watch_enabled, watch_api, show_platform, updated_by, updated_at)
 values (p_company, n.enabled, n.frequency, n.weekdays, n.every_days, n.hour, n.show_panel, n.show_badge, n.show_tab,
  n.mavi_context, n.notify_inbox, n.notify_min_priority, n.notify_who, n.money_basis, n.monthly_cap_usd,
  n.run_cap_usd, n.min_interval_minutes, n.min_new_days, n.google_daily_ops, n.creative_images, n.creative_videos,
  n.creative_new_max, n.expire_days, n.min_results, n.max_insights, n.watch_enabled, n.watch_api, n.show_platform, auth.uid(), now())
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
  min_results = excluded.min_results, max_insights = excluded.max_insights,
  watch_enabled = excluded.watch_enabled, watch_api = excluded.watch_api,
  show_platform = excluded.show_platform,
  -- Teto mudou: avisa de novo se for atingido.
  cap_noticed_month = case when excluded.monthly_cap_usd is distinct from x.monthly_cap_usd then null
   else x.cap_noticed_month end,
  updated_by = excluded.updated_by, updated_at = excluded.updated_at;
 return mavi_private.campaign_insight_settings_json(p_company);
end $$;

-- A da migração 20270404150000, com places.platform.
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
  'places', jsonb_build_object('panel', s.show_panel, 'badge', s.show_badge, 'tab', s.show_tab,
   'platform', s.show_platform),
  'money_basis', s.money_basis,
  'min_interval_minutes', s.min_interval_minutes,
  'expire_days', s.expire_days,
  'watch', s.enabled and s.watch_enabled,
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
  -- Os avisos da vigia diária (abertos até se resolverem) vêm primeiro.
  'current', coalesce((select jsonb_agg(mavi_private.campaign_insight_json(i)
    order by case when i.source = 'watch' then 0 when i.last_seen_run = v_latest then 1 else 2 end,
     mavi_private.campaign_insight_rank(i.priority) * (i.source = 'watch')::int desc, i.rank nulls last,
     mavi_private.campaign_insight_rank(i.priority) desc, i.created_at)
   from public.campaign_insights i where i.company_id = p_company and i.campaign_id = p_campaign
    and i.status = 'new' and (i.last_seen_run = v_latest or i.snooze_until is not null or i.source = 'watch')), '[]'),
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

commit;
