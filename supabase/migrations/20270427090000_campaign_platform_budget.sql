begin;

-- Campanhas › lista: o orçamento configurado no Meta e no Google, ao lado do
-- "Orçamento diário" recomendado (pedido de 05/10/2026), sem deixar a lista
-- mais lenta nem gastar a cota das plataformas:
--  - a lista só lê o banco (ad_platform_budgets, uma linha por campanha);
--  - quem lê é o leitor em 2º plano do "hoje" (o mesmo agendamento,
--    POST /api/ads-sync {"today": true}): uma leitura leve por conta de
--    anúncios a cada ~3 h (Meta: as campanhas com os conjuntos numa chamada;
--    Google: uma consulta), com as pausas da cota (ad_api_cooldowns);
--  - o botão "Atualizar" da lista lê só as contas da campanha, no máximo uma
--    vez a cada 5 minutos por campanha;
--  - o valor é sempre o real da plataforma (sem M). A comparação é com o
--    recomendado sem M; o vitalício aparece à parte e não entra nela;
--  - "Meus avisos" ganha a métrica platform_budget: a diferença, em %, entre
--    o orçamento da plataforma e o recomendado (campanha parada = 100%).

-- ------------------------------------------------------------ leitura
-- A última leitura do orçamento de cada campanha. read_at nulo: ainda não
-- houve leitura boa (só a tentativa, com o erro). items: cada campanha
-- (CBO, Google) ou conjunto (ABO) da plataforma, para o balão da lista.
create table public.ad_platform_budgets (
 company_id uuid not null,
 campaign_id uuid not null,
 cycle_id uuid not null,
 daily numeric(14,2) not null default 0 check (daily >= 0),
 lifetime numeric(14,2) not null default 0 check (lifetime >= 0),
 lifetime_left numeric(14,2) not null default 0 check (lifetime_left >= 0),
 active_items integer not null default 0 check (active_items >= 0),
 total_items integer not null default 0 check (total_items >= 0),
 items jsonb not null default '[]' check (jsonb_typeof(items) = 'array'),
 currency text not null default 'BRL' check (length(currency) <= 8),
 -- O diário antes da última mudança, e quando ela foi vista.
 previous_daily numeric(14,2),
 changed_at timestamptz,
 read_at timestamptz,
 tried_at timestamptz not null default now(),
 error text check (length(error) <= 500),
 -- Quem pediu a última leitura pelo botão (nulo: o agendamento).
 refreshed_by uuid,
 primary key (company_id, campaign_id),
 foreign key (company_id, campaign_id, cycle_id) references public.ad_cycles(company_id, campaign_id, id)
  on delete cascade
);
alter table public.ad_platform_budgets enable row level security;
revoke all on public.ad_platform_budgets from public, anon, authenticated;

-- Os ciclos cujo orçamento o leitor deve ler agora: o ciclo atual (que cobre
-- hoje) das campanhas ativas do Meta e do Google com vínculos, a partir das
-- 7h, quando a última tentativa passou de ~3 h (ou o ciclo mudou) e nenhuma
-- conta do ciclo está pausada pela cota.
create function mavi_private.ad_budget_due() returns table(cycle_id uuid, tried_at timestamptz)
language sql stable security definer set search_path = '' as $$
 select y.id, case when b.cycle_id = y.id then b.tried_at end
 from public.ad_campaigns a
 join public.ad_cycles y on y.company_id = a.company_id and y.id = a.current_cycle_id
 left join public.ad_platform_budgets b on b.company_id = a.company_id and b.campaign_id = a.id
 where a.status = 'active' and not a.archived and a.platform in ('meta', 'google')
  and y.start_date <= mavi_private.company_today(a.company_id)
  and y.end_date >= mavi_private.company_today(a.company_id)
  and extract(hour from now() at time zone mavi_private.company_tz(a.company_id)) >= 7
  and exists (select 1 from public.ad_cycle_links k where k.company_id = y.company_id and k.cycle_id = y.id)
  and (b.tried_at is null or b.cycle_id <> y.id or b.tried_at < now() - interval '175 minutes')
  and mavi_private.campaign_insight_paused(a.platform, array(select k.account_id from public.ad_cycle_links k
   where k.company_id = y.company_id and k.cycle_id = y.id)) is null
$$;
revoke all on function mavi_private.ad_budget_due() from public, anon, authenticated;

-- O que ler. Com o segredo: os ciclos em dia de leitura, os mais antigos
-- primeiro. Com p_campaign (o botão "Atualizar", por quem vê a campanha): o
-- ciclo atual dela, no máximo uma vez a cada 5 minutos e fora das pausas da
-- cota; a tentativa já fica marcada.
create function public.ad_budget_targets(p_secret text, p_campaign uuid default null, p_limit integer default 300)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_company uuid; v_a public.ad_campaigns; v_y public.ad_cycles; v_b public.ad_platform_budgets; v_until timestamptz;
 v_cycles uuid[]; result jsonb; begin
 if p_campaign is not null then
  select * into v_a from public.ad_campaigns where id = p_campaign;
  v_company := v_a.company_id;
  if v_company is null or not mavi_private.ad_sync_allowed(p_secret, v_company) then
   raise exception 'Sem permissão' using errcode = '42501';
  end if;
  if not mavi_private.ad_sync_allowed(p_secret, null)
   and not mavi_private.module_client(v_company, 'campaigns', mavi_private.ad_campaign_client(p_campaign)) then
   raise exception 'Sem permissão' using errcode = '42501';
  end if;
  if v_a.platform not in ('meta', 'google') then
   raise exception 'O orçamento da plataforma só é lido no Meta e no Google.' using errcode = '22023';
  end if;
  select * into v_y from public.ad_cycles where company_id = v_a.company_id and id = v_a.current_cycle_id;
  if v_y.id is null or mavi_private.company_today(v_a.company_id) not between v_y.start_date and v_y.end_date then
   raise exception 'A campanha não tem ciclo em andamento.' using errcode = '22023';
  end if;
  if not exists (select 1 from public.ad_cycle_links k where k.company_id = v_y.company_id and k.cycle_id = v_y.id) then
   raise exception 'O ciclo não tem contas vinculadas.' using errcode = '22023';
  end if;
  v_until := mavi_private.campaign_insight_paused(v_a.platform, array(select k.account_id from public.ad_cycle_links k
   where k.company_id = v_y.company_id and k.cycle_id = v_y.id));
  if v_until is not null then
   raise exception 'A conta está descansando pela cota da plataforma até %.',
    to_char(v_until at time zone mavi_private.company_tz(v_a.company_id), 'HH24:MI') using errcode = '22023';
  end if;
  select * into v_b from public.ad_platform_budgets where company_id = v_a.company_id and campaign_id = v_a.id;
  if v_b.tried_at > now() - interval '5 minutes' then
   raise exception 'O orçamento desta campanha foi lido há pouco. Tente de novo em % min.',
    greatest(ceil(extract(epoch from v_b.tried_at + interval '5 minutes' - now()) / 60), 1)::int using errcode = '22023';
  end if;
  insert into public.ad_platform_budgets as x(company_id, campaign_id, cycle_id, tried_at, refreshed_by)
  values (v_a.company_id, v_a.id, v_y.id, now(), auth.uid())
  on conflict (company_id, campaign_id) do update set tried_at = now(), refreshed_by = auth.uid();
  v_cycles := array[v_y.id];
 elsif not mavi_private.ad_sync_allowed(p_secret, null) then
  raise exception 'Sem permissão' using errcode = '42501';
 else
  select array_agg(d.cycle_id order by d.tried_at nulls first, d.cycle_id) into v_cycles
  from (select * from mavi_private.ad_budget_due() order by tried_at nulls first, cycle_id
   limit greatest(least(coalesce(p_limit, 300), 1000), 1)) d;
 end if;
 select coalesce(jsonb_agg(t order by t.ord), '[]') into result from (
  select o.ord, y.id as cycle_id, y.company_id, a.id as campaign_id, a.platform,
   mavi_private.company_today(y.company_id) as today,
   (select jsonb_agg(jsonb_build_object('account_id', k.account_id, 'campaign_id', k.external_campaign_id,
     'manager_id', k.manager_id) order by k.account_id, k.external_campaign_id)
    from public.ad_cycle_links k where k.company_id = y.company_id and k.cycle_id = y.id) as links,
   case when a.platform = 'meta' then (select jsonb_object_agg(m.account_id, jsonb_build_object(
     'token_cipher', m.token_cipher, 'expires_at', m.token_expires_at, 'currency', m.currency))
    from mavi_private.ad_meta_accounts m where m.company_id = y.company_id and m.account_id in
     (select k.account_id from public.ad_cycle_links k where k.company_id = y.company_id and k.cycle_id = y.id)) end
    as meta_tokens,
   case when a.platform = 'google' then (select jsonb_build_object('refresh_token_cipher', g.refresh_token_cipher)
    from mavi_private.ad_google_connections g where g.company_id = y.company_id) end as google_token
  from unnest(coalesce(v_cycles, '{}')) with ordinality o(cycle_id, ord)
  join public.ad_cycles y on y.id = o.cycle_id
  join public.ad_campaigns a on a.company_id = y.company_id and a.id = y.campaign_id
 ) t;
 return result;
end $$;

-- Grava a leitura: o orçamento de cada ciclo lido ({cycle_id, daily,
-- lifetime, lifetime_left, active, total, items, currency}), as tentativas
-- que falharam ({cycle_id, error}) e as contas que a cota pausou ({platform,
-- account, until, reason}). Quando o diário muda, guarda o de antes. As telas
-- abertas recarregam e os avisos de orçamento da plataforma são conferidos.
create function public.ad_budget_store(p_secret text, p_rows jsonb default '[]', p_errors jsonb default '[]',
 p_cooldowns jsonb default '[]') returns integer
language plpgsql security definer set search_path = '' as $$
declare r jsonb; y public.ad_cycles; old public.ad_platform_budgets; v_daily numeric; n integer := 0;
 v_companies uuid[] := '{}'; v_checks uuid[] := '{}'; c uuid; v_items jsonb; begin
 if not mavi_private.ad_sync_allowed(p_secret, null) then
  raise exception 'Sem permissão' using errcode = '42501';
 end if;
 for r in select * from jsonb_array_elements(case jsonb_typeof(p_rows) when 'array' then p_rows else '[]' end) loop
  select * into y from public.ad_cycles where id = (r->>'cycle_id')::uuid;
  continue when not found;
  select * into old from public.ad_platform_budgets where company_id = y.company_id and campaign_id = y.campaign_id;
  v_daily := round(greatest(coalesce((r->>'daily')::numeric, 0), 0), 2);
  v_items := case when jsonb_typeof(r->'items') = 'array' then r->'items' else '[]' end;
  -- No máximo 60 itens no balão (o total continua contado).
  if jsonb_array_length(v_items) > 60 then
   v_items := (select jsonb_agg(e) from (select e from jsonb_array_elements(v_items) with ordinality x(e, i)
    order by i limit 60) s);
  end if;
  insert into public.ad_platform_budgets as x(company_id, campaign_id, cycle_id, daily, lifetime, lifetime_left,
   active_items, total_items, items, currency, previous_daily, changed_at, read_at, tried_at, error, refreshed_by)
  values (y.company_id, y.campaign_id, y.id, v_daily,
   round(greatest(coalesce((r->>'lifetime')::numeric, 0), 0), 2),
   round(greatest(coalesce((r->>'lifetime_left')::numeric, 0), 0), 2),
   greatest(coalesce((r->>'active')::integer, 0), 0), greatest(coalesce((r->>'total')::integer, 0), 0),
   v_items, left(coalesce(nullif(r->>'currency', ''), 'BRL'), 8),
   case when old.read_at is not null and old.cycle_id = y.id and old.daily <> v_daily then old.daily
    else old.previous_daily end,
   case when old.read_at is not null and old.cycle_id = y.id and old.daily <> v_daily then now()
    else old.changed_at end,
   now(), now(), null, old.refreshed_by)
  on conflict (company_id, campaign_id) do update set cycle_id = excluded.cycle_id, daily = excluded.daily,
   lifetime = excluded.lifetime, lifetime_left = excluded.lifetime_left, active_items = excluded.active_items,
   total_items = excluded.total_items, items = excluded.items, currency = excluded.currency,
   previous_daily = excluded.previous_daily, changed_at = excluded.changed_at, read_at = excluded.read_at,
   tried_at = excluded.tried_at, error = null;
  n := n + 1;
  if not y.company_id = any(v_companies) then v_companies := v_companies || y.company_id; end if;
  if exists (select 1 from public.campaign_alert_rules ar where ar.company_id = y.company_id and ar.active
   and ar.metric = 'platform_budget') then
   v_checks := v_checks || y.campaign_id;
  end if;
 end loop;
 for r in select * from jsonb_array_elements(case jsonb_typeof(p_errors) when 'array' then p_errors else '[]' end) loop
  select * into y from public.ad_cycles where id = (r->>'cycle_id')::uuid;
  continue when not found;
  -- A última leitura boa continua na lista; só a tentativa e o erro mudam.
  insert into public.ad_platform_budgets as x(company_id, campaign_id, cycle_id, tried_at, error)
  values (y.company_id, y.campaign_id, y.id, now(), left(coalesce(r->>'error', 'Erro na leitura.'), 500))
  on conflict (company_id, campaign_id) do update set tried_at = excluded.tried_at, error = excluded.error;
  if not y.company_id = any(v_companies) then v_companies := v_companies || y.company_id; end if;
 end loop;
 for r in select * from jsonb_array_elements(case jsonb_typeof(p_cooldowns) when 'array' then p_cooldowns else '[]' end) loop
  continue when coalesce(r->>'platform', '') not in ('meta', 'google') or coalesce(r->>'account', '') = ''
   or (r->>'until') is null;
  insert into mavi_private.ad_api_cooldowns as k(platform, account_id, until, reason, updated_at)
  values (r->>'platform', left(r->>'account', 60), least((r->>'until')::timestamptz, now() + interval '1 day'),
   left(coalesce(r->>'reason', ''), 300), now())
  on conflict (platform, account_id) do update set until = greatest(k.until, excluded.until),
   reason = excluded.reason, updated_at = now();
 end loop;
 -- Os avisos de "Orçamento na plataforma × recomendado" (um erro aqui não
 -- derruba a gravação).
 foreach c in array v_checks loop
  begin
   perform mavi_private.campaign_alert_check((select a.company_id from public.ad_campaigns a where a.id = c), c);
  exception when others then
   raise warning 'campaign alerts failed: %', sqlerrm;
  end;
 end loop;
 foreach c in array v_companies loop
  perform mavi_private.broadcast(c, jsonb_build_object('kind', 'campaign_today'));
 end loop;
 return n;
end $$;

revoke all on function public.ad_budget_targets(text, uuid, integer), public.ad_budget_store(text, jsonb, jsonb, jsonb)
 from public, anon, authenticated;
-- anon: o servidor chamando de volta para o agendamento, com o segredo;
-- authenticated: o botão "Atualizar" (a gravação é sempre com o segredo).
grant execute on function public.ad_budget_targets(text, uuid, integer), public.ad_budget_store(text, jsonb, jsonb, jsonb)
 to anon, authenticated;

-- O pg_cron do leitor do "hoje" (supabase/operations/schedule-ads-today.sql)
-- acorda o servidor também quando só há orçamento para ler.
create or replace function mavi_private.ad_today_kick() returns void
language plpgsql security definer set search_path = '' as $$
declare cfg mavi_private.ad_sync_config; begin
 select * into cfg from mavi_private.ad_sync_config where id;
 if not found then return; end if;
 if not exists (select 1 from mavi_private.ad_today_due()) and not exists (select 1 from mavi_private.ad_budget_due()) then
  return;
 end if;
 perform net.http_post(url := cfg.url, body := '{"today": true}'::jsonb,
  headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || cfg.secret),
  timeout_milliseconds := 60000);
end $$;
revoke all on function mavi_private.ad_today_kick() from public, anon, authenticated;

-- ------------------------------------------------------------ avisos
alter table public.campaign_alert_rules drop constraint campaign_alert_rules_metric_check;
alter table public.campaign_alert_rules add constraint campaign_alert_rules_metric_check
 check (metric in ('spend', 'conversions', 'cpa', 'ctr', 'cpc', 'cpm', 'impressions', 'clicks', 'reach', 'frequency',
  'media_left', 'daily_budget', 'spend_pace', 'results_pace', 'cost_vs_goal', 'platform_budget'));

create or replace function mavi_private.campaign_alert_label(p_metric text) returns text
language sql immutable set search_path = '' as $$
 select case p_metric when 'spend' then 'Consumo' when 'conversions' then 'Conversões'
  when 'cpa' then 'Custo por resultado' when 'ctr' then 'CTR' when 'cpc' then 'CPC' when 'cpm' then 'CPM'
  when 'impressions' then 'Impressões' when 'clicks' then 'Cliques' when 'reach' then 'Alcance'
  when 'frequency' then 'Frequência' when 'media_left' then 'Mídia restante'
  when 'daily_budget' then 'Orçamento diário' when 'spend_pace' then 'Ritmo de gasto'
  when 'results_pace' then 'Ritmo de resultados' when 'cost_vs_goal' then 'Custo × meta'
  when 'platform_budget' then 'Orçamento na plataforma × recomendado' else p_metric end
$$;

create or replace function mavi_private.campaign_alert_cycle_metric(p_metric text) returns boolean
language sql immutable set search_path = '' as $$
 select p_metric in ('media_left', 'daily_budget', 'spend_pace', 'results_pace', 'cost_vs_goal', 'platform_budget')
$$;

create or replace function mavi_private.campaign_alert_fmt(p_metric text, v numeric) returns text
language sql immutable set search_path = '' as $$
 select case when v is null then '—'
  when p_metric in ('spend', 'cpa', 'cpc', 'cpm', 'media_left', 'daily_budget') then mavi_private.brl(v)
  when p_metric in ('ctr', 'spend_pace', 'results_pace', 'cost_vs_goal', 'platform_budget')
   then mavi_private.campaign_alert_num(v) || '%'
  else mavi_private.campaign_alert_num(v) end
$$;

-- As métricas de antes continuam na função de antes; a nova é medida aqui.
alter function mavi_private.campaign_alert_measure(public.campaign_alert_rules, uuid, date)
 rename to campaign_alert_measure_metrics;

-- Orçamento na plataforma × recomendado: a diferença, em %, entre o diário
-- configurado no Meta/Google (a última leitura, de até 24 h) e o recomendado
-- sem M (mídia restante ÷ dias que faltam, hoje incluído — a conta da
-- lista). Campanha parada na plataforma = 100%. Com orçamento vitalício não
-- confere (não se compara com o diário).
create function mavi_private.campaign_alert_measure(r public.campaign_alert_rules, p_campaign uuid, p_today date)
 returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare a public.ad_campaigns; y public.ad_cycles; b public.ad_platform_budgets; v_days integer; v_gross numeric;
 v_rec numeric; v numeric; v_met boolean; v_text text; v_remaining integer; begin
 if r.metric <> 'platform_budget' then
  return mavi_private.campaign_alert_measure_metrics(r, p_campaign, p_today);
 end if;
 select * into a from public.ad_campaigns where company_id = r.company_id and id = p_campaign;
 if not found then return jsonb_build_object('ok', false, 'reason', 'Campanha não encontrada.'); end if;
 if a.platform not in ('meta', 'google') then
  return jsonb_build_object('ok', false, 'reason', 'O orçamento da plataforma só é lido no Meta e no Google.');
 end if;
 select * into y from public.ad_cycles where company_id = a.company_id and id = a.current_cycle_id;
 if not found then return jsonb_build_object('ok', false, 'reason', 'A campanha não tem ciclo atual.'); end if;
 if p_today not between y.start_date and y.end_date then
  return jsonb_build_object('ok', false, 'reason', 'O ciclo atual não está em andamento.');
 end if;
 select * into b from public.ad_platform_budgets x where x.company_id = a.company_id and x.campaign_id = a.id
  and x.cycle_id = y.id;
 if b.read_at is null then
  return jsonb_build_object('ok', false, 'reason', 'Ainda sem a leitura do orçamento na plataforma.');
 end if;
 if b.read_at < now() - interval '24 hours' then
  return jsonb_build_object('ok', false, 'reason', 'A última leitura do orçamento na plataforma tem mais de 24 h.');
 end if;
 if b.active_items > 0 and b.lifetime > 0 then
  return jsonb_build_object('ok', false, 'reason', 'A campanha usa orçamento vitalício: não se compara com o diário.');
 end if;
 -- O que o ciclo já gastou (como a lista): os dias gravados, senão a última foto × M.
 select count(*)::int, coalesce(sum(d.spend * d.multiplier), 0) into v_days, v_gross
 from public.ad_daily_metrics d where d.company_id = a.company_id and d.cycle_id = y.id;
 if v_days = 0 then
  select coalesce((select s.spend * y.multiplier from public.ad_cycle_snapshots s
   where s.company_id = a.company_id and s.cycle_id = y.id order by s.taken_on desc limit 1), 0) into v_gross;
 end if;
 v_remaining := greatest(y.end_date - greatest(p_today, y.start_date) + 1, 1);
 v_rec := round(greatest(y.budget / y.multiplier - v_gross / y.multiplier, 0) / v_remaining, 2);
 v := case when v_rec > 0 then abs(b.daily - v_rec) * 100 / v_rec when b.daily > 0 then 100 else 0 end;
 v := round(least(v, 999), 1);
 v_met := case r.condition when 'above' then v >= r.value else v <= r.value end;
 v_text := case when b.active_items = 0 then format('%s na plataforma; o recomendado é %s/dia (aviso %s %s)',
   case when b.total_items = 0 then 'Campanha não encontrada' else 'Campanha parada' end, mavi_private.brl(v_rec),
   case r.condition when 'above' then 'a partir de' else 'em ou abaixo de' end,
   mavi_private.campaign_alert_fmt(r.metric, r.value))
  else format('Orçamento na plataforma: %s/dia × recomendado %s/dia (%s%s%%; aviso %s %s)', mavi_private.brl(b.daily),
   mavi_private.brl(v_rec), case when b.daily >= v_rec then '+' else '−' end, mavi_private.campaign_alert_num(v),
   case r.condition when 'above' then 'a partir de' else 'em ou abaixo de' end,
   mavi_private.campaign_alert_fmt(r.metric, r.value)) end;
 return jsonb_build_object('ok', true, 'met', v_met, 'value', v, 'text', v_text);
end $$;
revoke all on function mavi_private.campaign_alert_measure(public.campaign_alert_rules, uuid, date)
 from public, anon, authenticated;

-- A da migração 20270218090000_campaign_alerts, com a métrica nova.
create or replace function mavi_private.campaign_alert_from_json(p_company uuid, v jsonb) returns public.campaign_alert_rules
language plpgsql stable set search_path = '' as $$
declare r public.campaign_alert_rules; uuid_re text := '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
begin
 v := coalesce(v, '{}');
 r.id := case when v ->> 'id' ~* uuid_re then (v ->> 'id')::uuid end;
 r.company_id := p_company;
 r.user_id := auth.uid();
 r.name := btrim(coalesce(v ->> 'name', ''));
 r.campaign_id := case when v ->> 'campaign_id' ~* uuid_re then (v ->> 'campaign_id')::uuid end;
 r.client_ids := array(select distinct x::uuid from jsonb_array_elements_text(
  case when jsonb_typeof(v -> 'client_ids') = 'array' then v -> 'client_ids' else '[]' end) x where x ~* uuid_re);
 r.product_ids := array(select distinct x::uuid from jsonb_array_elements_text(
  case when jsonb_typeof(v -> 'product_ids') = 'array' then v -> 'product_ids' else '[]' end) x where x ~* uuid_re);
 r.team_ids := array(select distinct x::uuid from jsonb_array_elements_text(
  case when jsonb_typeof(v -> 'team_ids') = 'array' then v -> 'team_ids' else '[]' end) x where x ~* uuid_re);
 r.platforms := array(select distinct x from jsonb_array_elements_text(
  case when jsonb_typeof(v -> 'platforms') = 'array' then v -> 'platforms' else '[]' end) x
  where x in ('meta', 'google', 'linkedin', 'tiktok', 'kwai'));
 r.objectives := array(select distinct x from jsonb_array_elements_text(
  case when jsonb_typeof(v -> 'objectives') = 'array' then v -> 'objectives' else '[]' end) x
  where x in ('lead', 'sale', 'message', 'traffic', 'engagement', 'custom', 'video'));
 if r.campaign_id is not null then
  r.client_ids := '{}'; r.product_ids := '{}'; r.team_ids := '{}'; r.platforms := '{}'; r.objectives := '{}';
 end if;
 r.metric := coalesce(v ->> 'metric', '');
 r.condition := coalesce(v ->> 'condition', '');
 r.period := coalesce(nullif(v ->> 'period', ''), 'day');
 r.days := least(greatest(coalesce(case when jsonb_typeof(v -> 'days') = 'number' then (v ->> 'days')::numeric end, 1), 1), 30)::smallint;
 r.value := case when jsonb_typeof(v -> 'value') = 'number' then round(abs((v ->> 'value')::numeric), 2) end;
 r.tolerance := least(greatest(coalesce(case when jsonb_typeof(v -> 'tolerance') = 'number'
  then (v ->> 'tolerance')::numeric end, 0), 0), 50);
 r.with_m := coalesce((v ->> 'with_m')::boolean, false);
 r.repeat := coalesce(nullif(v ->> 'repeat', ''), 'once');
 r.repeat_days := least(greatest(coalesce(case when jsonb_typeof(v -> 'repeat_days') = 'number'
  then (v ->> 'repeat_days')::numeric end, 3), 2), 30)::smallint;
 r.channel := coalesce(nullif(v ->> 'channel', ''), 'now');
 r.active := coalesce((v ->> 'active')::boolean, true);
 r.origin := case when v ->> 'origin' = 'mavi' then 'mavi' else 'screen' end;
 if r.metric not in ('spend', 'conversions', 'cpa', 'ctr', 'cpc', 'cpm', 'impressions', 'clicks', 'reach',
  'frequency', 'media_left', 'daily_budget', 'spend_pace', 'results_pace', 'cost_vs_goal', 'platform_budget') then
  raise exception 'Escolha a métrica do aviso.' using errcode = '22023';
 end if;
 if r.condition not in ('above', 'below', 'unchanged', 'zero', 'rise', 'drop') then
  raise exception 'Escolha a condição do aviso.' using errcode = '22023';
 end if;
 if r.period not in ('day', 'days', 'cycle') then r.period := 'day'; end if;
 if r.repeat not in ('once', 'daily', 'every') then r.repeat := 'once'; end if;
 if r.channel not in ('now', 'digest') then r.channel := 'now'; end if;
 -- O que não vale para a condição volta ao padrão.
 if mavi_private.campaign_alert_cycle_metric(r.metric) then r.period := 'cycle'; r.days := 1;
 elsif r.condition in ('unchanged', 'zero', 'rise', 'drop') then r.period := 'days';
 elsif r.period <> 'days' then r.days := 1;
 end if;
 if r.condition <> 'unchanged' then r.tolerance := 0; end if;
 if r.condition in ('unchanged', 'zero') then r.value := null; end if;
 if r.metric not in ('spend', 'cpa', 'cpc', 'cpm', 'media_left', 'daily_budget') then r.with_m := false; end if;
 if r.repeat <> 'every' then r.repeat_days := 3; end if;
 return r;
end $$;

-- ------------------------------------------------------------ lista
-- A da migração 20270331090000_campaign_list_results, com o orçamento da
-- plataforma de cada campanha da página.
create or replace function public.ad_campaign_page(p_company uuid, p_scope text default 'active', p_search text default '',
 p_platform text default '', p_attention boolean default false, p_limit integer default 25, p_offset integer default 0)
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare t date; term text := mavi_private.fold(trim(coalesce(p_search, ''))); result jsonb; v_clients uuid[]; begin
 perform mavi_private.ad_require_reader(p_company);
 v_clients := case when mavi_private.leader(p_company) then null else mavi_private.served_clients(p_company) end;
 t := mavi_private.company_today(p_company);
 with scoped as (
  select a.*, cl.name as client_name, p.name as product_name,
   a.status = 'inactive' and a.legacy_id is null and a.created_at > now() - interval '60 days'
    and not exists (select 1 from public.ad_campaign_events e
     where e.company_id = a.company_id and e.campaign_id = a.id and e.action = 'status') as waiting
  from public.ad_campaigns a
  join public.contracts k on k.company_id = a.company_id and k.id = a.contract_id
  join public.clients cl on cl.company_id = k.company_id and cl.id = k.client_id
  join public.products p on p.company_id = k.company_id and p.id = k.product_id
  where a.company_id = p_company and not a.archived
   and (v_clients is null or k.client_id = any(v_clients))
 ), statused as (
  select s.* from scoped s
  where case coalesce(p_scope, 'active')
    when 'pending' then s.waiting
    when 'inactive' then s.status = 'inactive'
    when 'all' then true
    else s.status = 'active' end
 ), alerts as (
  -- Only what the alert needs, for every campaign of the scope (the counts
  -- and the "atenção" filter); the cycles' data only for the page below.
  select s.*, cur.end_date as current_end,
   -- Uma inativa (fora as novas aguardando ativação) não tem alerta de ciclo.
   case when s.status = 'inactive' and not s.waiting then 'none'
    when not exists (select 1 from public.ad_cycles y
     where y.company_id = s.company_id and y.campaign_id = s.id) then 'no_cycle'
    when cur.end_date is null then 'no_current'
    when t > cur.end_date then 'ended'
    when t = cur.end_date then 'ends_today'
    when cur.end_date - t + 1 <= 10 and not exists (select 1 from public.ad_cycles y
     where y.company_id = s.company_id and y.campaign_id = s.id and y.id <> s.current_cycle_id
      and y.start_date >= cur.end_date and y.start_date > cur.start_date) then 'ending'
    else 'none' end as alert_kind
  from statused s
  left join public.ad_cycles cur on cur.company_id = s.company_id and cur.id = s.current_cycle_id
 ), filtered as (
  select a.* from alerts a
  where (term = '' or strpos(mavi_private.fold(a.name || ' ' || a.client_name), term) > 0)
   and (coalesce(p_platform, '') = '' or a.platform = p_platform)
   and (not coalesce(p_attention, false) or a.alert_kind <> 'none')
 ), sliced as (
  select f.* from filtered f
  order by (f.status <> 'active'), mavi_private.fold(f.client_name), mavi_private.fold(f.name), f.id
  limit greatest(least(coalesce(p_limit, 25), 100), 1) offset greatest(coalesce(p_offset, 0), 0)
 ), page as (
  select f.*,
   (select to_jsonb(y) from public.ad_cycles y where y.company_id = f.company_id and y.id = f.current_cycle_id) as current,
   (select to_jsonb(y) from public.ad_cycles y where y.company_id = f.company_id and y.campaign_id = f.id
     and f.current_end is not null and y.id <> f.current_cycle_id and y.start_date >= f.current_end
     and y.start_date > cur.start_date
     order by y.start_date limit 1) as next,
   (select to_jsonb(y) from public.ad_cycles y where y.company_id = f.company_id and y.campaign_id = f.id
     and y.start_date <= t and y.end_date >= t order by y.start_date desc limit 1) as covering,
   (select to_jsonb(y) from public.ad_cycles y where y.company_id = f.company_id and y.campaign_id = f.id
     and y.start_date > t order by y.start_date limit 1) as future,
   (select to_jsonb(y) from public.ad_cycles y where y.company_id = f.company_id and y.campaign_id = f.id
     order by y.start_date desc limit 1) as last,
   case when f.current_cycle_id is null then null
    when dm.days > 0 then jsonb_build_object('net', dm.net, 'gross', dm.gross)
    else jsonb_build_object('net', coalesce(sn.spend, 0), 'gross', coalesce(sn.spend * cur.multiplier, 0)) end as spent,
   -- Os resultados: o ciclo (o último acumulado, senão a soma dos dias — a
   -- conta do cabeçalho da campanha), ontem (o dia sincronizado, de qualquer
   -- ciclo da campanha) e hoje (a última leitura do leitor em 2º plano).
   jsonb_build_object(
    'cycle', case when f.current_cycle_id is null or (sn.spend is null and dm.days = 0) then null
     when sn.spend is not null then jsonb_build_object('spend', sn.spend, 'conversions', sn.conversions)
     else jsonb_build_object('spend', dm.net, 'conversions', dm.conversions) end,
    'yesterday', (select jsonb_build_object('spend', d.spend, 'conversions', d.conversions, 'multiplier', d.multiplier)
     from public.ad_daily_metrics d where d.company_id = f.company_id and d.campaign_id = f.id and d.day = t - 1
     order by (d.cycle_id = f.current_cycle_id) desc limit 1),
    'today', (select jsonb_build_object('spend', x.spend, 'conversions', x.conversions, 'multiplier', x.multiplier,
      'read_at', x.read_at)
     from public.ad_today_metrics x where x.company_id = f.company_id and x.campaign_id = f.id and x.day = t)
   ) as results
   ,
   -- O orçamento configurado na plataforma (a última leitura do ciclo atual).
   (select jsonb_build_object('daily', b.daily, 'lifetime', b.lifetime, 'lifetime_left', b.lifetime_left,
     'active', b.active_items, 'total', b.total_items, 'items', b.items, 'currency', b.currency,
     'previous_daily', b.previous_daily, 'changed_at', b.changed_at, 'read_at', b.read_at, 'tried_at', b.tried_at,
     'error', b.error)
    from public.ad_platform_budgets b where b.company_id = f.company_id and b.campaign_id = f.id
     and b.cycle_id = f.current_cycle_id) as platform_budget
  from sliced f
  left join public.ad_cycles cur on cur.company_id = f.company_id and cur.id = f.current_cycle_id
  left join lateral (select count(*) as days, coalesce(sum(d.spend), 0) as net,
    coalesce(sum(d.spend * d.multiplier), 0) as gross, coalesce(sum(d.conversions), 0) as conversions
   from public.ad_daily_metrics d
   where d.company_id = f.company_id and d.cycle_id = f.current_cycle_id) dm on true
  left join lateral (select s.spend, s.conversions from public.ad_cycle_snapshots s
   where s.company_id = f.company_id and s.cycle_id = f.current_cycle_id
   order by s.taken_on desc limit 1) sn on true
 )
 select jsonb_build_object(
  'total', (select count(*) from filtered),
  'all', (select count(*) from alerts),
  'attention', (select count(*) from alerts where alert_kind <> 'none'),
  'rows', coalesce((select jsonb_agg(jsonb_build_object(
    'campaign', jsonb_build_object('id', p.id, 'company_id', p.company_id, 'contract_id', p.contract_id,
     'name', p.name, 'platform', p.platform, 'status', p.status, 'current_cycle_id', p.current_cycle_id,
     'briefing_url', p.briefing_url, 'media_plan_url', p.media_plan_url, 'notes', p.notes,
     'archived', p.archived, 'created_by', p.created_by, 'created_at', p.created_at,
     'updated_at', p.updated_at, 'version', p.version),
    'client_name', p.client_name,
    'product_name', p.product_name,
    'current', p.current,
    'alert', jsonb_build_object('kind', p.alert_kind,
     'days', case p.alert_kind when 'ended' then t - p.current_end
      when 'ending' then p.current_end - t + 1 end,
     'next', case p.alert_kind when 'ended' then coalesce(p.covering, p.next)
      when 'no_current' then coalesce(p.covering, p.future, p.last)
      when 'ends_today' then p.next when 'ending' then p.next end),
    'waiting', p.waiting,
    'spent', p.spent,
    'results', p.results,
    'platform_budget', p.platform_budget)
   order by (p.status <> 'active'), mavi_private.fold(p.client_name), mavi_private.fold(p.name), p.id) from page p), '[]')
 ) into result;
 -- New campaigns waiting for their first activation (a separate count).
 if coalesce(p_scope, 'active') <> 'pending' then
  result := result || jsonb_build_object('pending', (select count(*) from public.ad_campaigns a
   join public.contracts k on k.company_id = a.company_id and k.id = a.contract_id
   where a.company_id = p_company and not a.archived and a.status = 'inactive' and a.legacy_id is null
    and (v_clients is null or k.client_id = any(v_clients))
    and a.created_at > now() - interval '60 days'
    and not exists (select 1 from public.ad_campaign_events e
     where e.company_id = a.company_id and e.campaign_id = a.id and e.action = 'status')));
 end if;
 return result;
end $$;

commit;
