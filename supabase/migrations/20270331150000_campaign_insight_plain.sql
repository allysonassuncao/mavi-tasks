begin;

-- Campanhas › Insights da MAVI, Fase 5 (pedido de 04/10/2026): menos e
-- melhor, em linguagem simples, para quem responde pela campanha.
--
-- * Responsáveis pela campanha (ad_campaign_owners, até 5 pessoas que veem a
--   campanha): recebem os avisos dos insights. Quem edita campanhas escolhe,
--   na aba Insights. Sem responsável, os avisos vão para as equipes do
--   cliente, como antes.
-- * "Quem recebe" ganha 'owners' (os responsáveis; o novo padrão — as
--   empresas que estavam em 'team' passam para ele, que cai nas equipes
--   quando a campanha não tem responsável).
-- * Insights por análise (max_insights, padrão 4) e amostra mínima
--   (min_results, padrão 10 resultados) no Painel da MAVI; o worker aplica.
-- * A ordem da análise (rank): o primeiro aberto é o "Comece por aqui".

-- ------------------------------------------------------------ configuração
alter table public.campaign_insight_settings
 add column min_results smallint not null default 10 check (min_results between 0 and 100),
 add column max_insights smallint not null default 4 check (max_insights between 2 and 8);
alter table public.campaign_insight_settings drop constraint campaign_insight_settings_notify_who_check;
alter table public.campaign_insight_settings add constraint campaign_insight_settings_notify_who_check
 check (notify_who in ('owners', 'team', 'team_leaders'));
alter table public.campaign_insight_settings alter column notify_who set default 'owners';
update public.campaign_insight_settings set notify_who = 'owners' where notify_who = 'team';

-- A da migração 20270330090000, com a amostra mínima e o limite (no fim da tabela).
create or replace function mavi_private.campaign_insight_config(c uuid) returns public.campaign_insight_settings
language sql stable security definer set search_path = '' as $$
 select coalesce((select s from public.campaign_insight_settings s where s.company_id = c),
  row(c, false, 'weekdays', '{1,4}'::smallint[], 3, 8, true, true, true, true, true, 'high', 'owners', 'net',
   30, 0.50, 240, 2, 500, null, null, now(), true, true, 6, 15, 10, 4)::public.campaign_insight_settings)
$$;

-- A da migração 20270330090000, com a amostra mínima e o limite.
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
 n.min_results := coalesce((v->>'min_results')::smallint, s.min_results);
 n.max_insights := coalesce((v->>'max_insights')::smallint, s.max_insights);
 if cardinality(n.weekdays) = 0 then
  raise exception 'Escolha ao menos um dia da semana.' using errcode = '22023';
 end if;
 insert into public.campaign_insight_settings as x (company_id, enabled, frequency, weekdays, every_days, hour,
  show_panel, show_badge, show_tab, mavi_context, notify_inbox, notify_min_priority, notify_who, money_basis,
  monthly_cap_usd, run_cap_usd, min_interval_minutes, min_new_days, google_daily_ops, creative_images, creative_videos,
  creative_new_max, expire_days, min_results, max_insights, updated_by, updated_at)
 values (p_company, n.enabled, n.frequency, n.weekdays, n.every_days, n.hour, n.show_panel, n.show_badge, n.show_tab,
  n.mavi_context, n.notify_inbox, n.notify_min_priority, n.notify_who, n.money_basis, n.monthly_cap_usd,
  n.run_cap_usd, n.min_interval_minutes, n.min_new_days, n.google_daily_ops, n.creative_images, n.creative_videos,
  n.creative_new_max, n.expire_days, n.min_results, n.max_insights, auth.uid(), now())
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
  -- Teto mudou: avisa de novo se for atingido.
  cap_noticed_month = case when excluded.monthly_cap_usd is distinct from x.monthly_cap_usd then null
   else x.cap_noticed_month end,
  updated_by = excluded.updated_by, updated_at = excluded.updated_at;
 return mavi_private.campaign_insight_settings_json(p_company);
end $$;

-- ------------------------------------------------------------ responsáveis
create table public.ad_campaign_owners (
 company_id uuid not null,
 campaign_id uuid not null,
 user_id uuid not null,
 created_by uuid default auth.uid(),
 created_at timestamptz not null default now(),
 primary key (company_id, campaign_id, user_id),
 foreign key (company_id, campaign_id) references public.ad_campaigns(company_id, id) on delete cascade
);
alter table public.ad_campaign_owners enable row level security;
revoke all on public.ad_campaign_owners from public, anon, authenticated;

create function mavi_private.campaign_owners_json(c uuid, p_campaign uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
 select coalesce(jsonb_agg(jsonb_build_object('id', m.user_id, 'name', m.name) order by m.name), '[]')
 from public.ad_campaign_owners o
 join public.memberships m on m.company_id = o.company_id and m.user_id = o.user_id and m.active
 where o.company_id = c and o.campaign_id = p_campaign
$$;

-- Quem pode ser responsável: as pessoas ativas que veem a campanha.
create function public.campaign_owner_candidates(p_company uuid, p_campaign uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_client uuid; begin
 if not mavi_private.campaign_insight_reader(p_company, p_campaign) then
  raise exception 'Sem permissão' using errcode = '42501';
 end if;
 v_client := mavi_private.ad_campaign_client(p_campaign);
 return coalesce((select jsonb_agg(jsonb_build_object('id', m.user_id, 'name', m.name) order by m.name)
  from public.memberships m where m.company_id = p_company and m.active
   and mavi_private.campaign_alert_sees(p_company, m.user_id, v_client)), '[]');
end $$;

create function public.set_campaign_owners(p_company uuid, p_campaign uuid, p_users uuid[]) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_client uuid; v_users uuid[] := array(select distinct u from unnest(coalesce(p_users, '{}')) u
 where u is not null); begin
 if not mavi_private.campaign_insight_reader(p_company, p_campaign) or not mavi_private.ad_can_write(p_company) then
  raise exception 'Sem permissão' using errcode = '42501';
 end if;
 if cardinality(v_users) > 5 then
  raise exception 'Escolha até 5 responsáveis.' using errcode = '22023';
 end if;
 v_client := mavi_private.ad_campaign_client(p_campaign);
 if exists (select 1 from unnest(v_users) u where not exists (select 1 from public.memberships m
   where m.company_id = p_company and m.user_id = u and m.active
    and mavi_private.campaign_alert_sees(p_company, u, v_client))) then
  raise exception 'Só pessoas que veem a campanha podem ser responsáveis.' using errcode = '22023';
 end if;
 delete from public.ad_campaign_owners where company_id = p_company and campaign_id = p_campaign
  and user_id <> all(v_users);
 insert into public.ad_campaign_owners(company_id, campaign_id, user_id)
 select p_company, p_campaign, u from unnest(v_users) u
 on conflict do nothing;
 return mavi_private.campaign_owners_json(p_company, p_campaign);
end $$;
grant execute on function public.campaign_owner_candidates(uuid, uuid), public.set_campaign_owners(uuid, uuid, uuid[])
 to authenticated;

-- ------------------------------------------------------------ ordem
alter table public.campaign_insights add column rank smallint;

-- A da migração 20270330090000, com os responsáveis e a ordem da análise.
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

-- A da migração 20270330090000, com a ordem e os avisos para os responsáveis.
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
     money_basis = v_basis, rank = v_rank, confidence = case when x->>'confidence' ~ '^[0-9.]+$'
      then least(greatest((x->>'confidence')::numeric, 0), 1) end
    where id = v_old;
    v_again := v_again + 1;
   else
    insert into public.campaign_insights(company_id, campaign_id, run_id, last_seen_run, kind, priority, title, body,
     action, evidence, target, source, fingerprint, money_basis, confidence, rank)
    values (r.company_id, r.campaign_id, r.id, r.id, x->>'kind', x->>'priority', left(btrim(x->>'title'), 200),
     left(coalesce(x->>'body', ''), 2000), left(coalesce(x->>'action', ''), 800), x->'evidence',
     case when jsonb_typeof(x->'target') = 'object' then x->'target' end,
     case when x->>'source' = 'rule' then 'rule' else 'mavi' end, left(x->>'fingerprint', 300), v_basis,
     case when x->>'confidence' ~ '^[0-9.]+$' then least(greatest((x->>'confidence')::numeric, 0), 1) end, v_rank);
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

-- A da migração 20270329090000, com a amostra mínima e o limite.
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
