-- Agentes MAVI › Custos: os gastos ficam no motor (cost_events/cost_daily);
-- aqui ficam a cotação do dólar (PTAX do Banco Central, por dia) e uma cópia
-- das somas por dia × agente × caixa × tipo × modelo para os Dashboards.
-- De hora em hora o pg_cron acorda o /api/ai ("agent-costs-sync"), que busca
-- a PTAX e as somas dos últimos dias no motor.

begin;

-- ------------------------------------------------------------ cotação
create table public.fx_ptax (
  day date primary key,
  -- R$ por US$ (PTAX de venda do fechamento do dia).
  usd_brl numeric(10, 4) not null check (usd_brl > 0),
  fetched_at timestamptz not null default now()
);
alter table public.fx_ptax enable row level security;
create policy fx_ptax_read on public.fx_ptax for select to authenticated using (true);
grant select on public.fx_ptax to authenticated;

-- A cotação de um dia: a do dia ou a última antes dele (fim de semana,
-- feriado, hoje antes do fechamento); antes da primeira, a primeira.
create function mavi_private.ptax_on(d date) returns numeric
language sql stable security definer set search_path = '' as $$
  select coalesce(
    (select x.usd_brl from public.fx_ptax x where x.day <= d order by x.day desc limit 1),
    (select x.usd_brl from public.fx_ptax x order by x.day limit 1))
$$;
revoke all on function mavi_private.ptax_on(date) from public, anon, authenticated;

-- As cotações de um período (com a última antes dele), para a tela converter.
create function public.fx_ptax_rates(p_from date, p_to date) returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_object_agg(to_char(x.day, 'YYYY-MM-DD'), x.usd_brl), '{}'::jsonb)
  from public.fx_ptax x
  where (x.day between p_from and p_to)
     or x.day = (select max(y.day) from public.fx_ptax y where y.day < p_from)
$$;
revoke all on function public.fx_ptax_rates(date, date) from public, anon;
grant execute on function public.fx_ptax_rates(date, date) to authenticated;

-- ------------------------------------------------------------ somas por dia (cópia do motor)
create table mavi_private.agent_cost_daily (
  day date not null,
  agent_id text not null,
  agent_name text not null default '',
  company_id uuid not null references public.companies (id),
  client_id uuid,
  contract_id uuid,
  inbox_id text not null default '',
  inbox_name text not null default '',
  source text not null,
  -- ia, midias, conhecimento, analises, whatsapp, testes
  cost_group text not null,
  model text not null default '',
  simulation boolean not null default false,
  events integer not null default 0,
  cost_usd numeric(16, 6) not null default 0,
  tokens_in bigint not null default 0,
  tokens_out bigint not null default 0,
  units numeric(16, 3) not null default 0,
  synced_at timestamptz not null default now(),
  primary key (day, agent_id, inbox_id, source, model, simulation)
);
create index agent_cost_daily_company on mavi_private.agent_cost_daily (company_id, day);

-- ------------------------------------------------------------ worker (segredo do /api/ai)
create function public.fx_ptax_store(p_secret text, p_rows jsonb) returns integer
language plpgsql security definer set search_path = '' as $$
declare n integer;
begin
  if not mavi_private.ai_secret_ok(p_secret) then raise exception 'Sem permissão' using errcode = '42501'; end if;
  insert into public.fx_ptax (day, usd_brl)
  select (x->>'day')::date, (x->>'usd_brl')::numeric
  from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) x
  where (x->>'usd_brl')::numeric > 0
  on conflict (day) do update set usd_brl = excluded.usd_brl, fetched_at = now();
  get diagnostics n = row_count;
  return n;
end $$;

-- Troca as somas do período pelas que vieram do motor (o motor é a fonte).
create function public.agent_costs_store(p_secret text, p_from date, p_to date, p_rows jsonb) returns integer
language plpgsql security definer set search_path = '' as $$
declare n integer;
begin
  if not mavi_private.ai_secret_ok(p_secret) then raise exception 'Sem permissão' using errcode = '42501'; end if;
  delete from mavi_private.agent_cost_daily where day between p_from and p_to;
  insert into mavi_private.agent_cost_daily (day, agent_id, agent_name, company_id, client_id, contract_id, inbox_id, inbox_name,
    source, cost_group, model, simulation, events, cost_usd, tokens_in, tokens_out, units)
  select (x->>'day')::date, x->>'agent_id', coalesce(x->>'agent_name', ''), (x->>'company_id')::uuid,
         nullif(x->>'client_id', '')::uuid, nullif(x->>'contract_id', '')::uuid,
         coalesce(x->>'inbox_id', ''), coalesce(x->>'inbox_name', ''), x->>'source', x->>'cost_group',
         coalesce(x->>'model', ''), coalesce((x->>'simulation')::boolean, false), coalesce((x->>'events')::integer, 0),
         coalesce((x->>'cost_usd')::numeric, 0), coalesce((x->>'tokens_in')::bigint, 0), coalesce((x->>'tokens_out')::bigint, 0),
         coalesce((x->>'units')::numeric, 0)
  from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) x
  where (x->>'day')::date between p_from and p_to
    and exists (select 1 from public.companies k where k.id = (x->>'company_id')::uuid);
  get diagnostics n = row_count;
  return n;
end $$;

revoke all on function public.fx_ptax_store(text, jsonb), public.agent_costs_store(text, date, date, jsonb) from public, authenticated;
grant execute on function public.fx_ptax_store(text, jsonb), public.agent_costs_store(text, date, date, jsonb) to anon;

-- ------------------------------------------------------------ agendamento
create function mavi_private.agent_costs_kick() returns void
language plpgsql security definer set search_path = '' as $$
declare cfg mavi_private.ai_config; begin
 select * into cfg from mavi_private.ai_config where id;
 if not found then return; end if;
 perform net.http_post(url := cfg.url, body := '{"action":"agent-costs-sync"}'::jsonb,
  headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || cfg.secret),
  timeout_milliseconds := 60000);
end $$;
revoke all on function mavi_private.agent_costs_kick() from public, anon, authenticated;

do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('mavi-agent-costs', '7 * * * *', $job$ select mavi_private.agent_costs_kick(); $job$);
  end if;
end $$;


-- ------------------------------------------------------------ Dashboards: fonte "Agentes MAVI · Custos"
-- Igual à de 20270224090000_dashboard_records, mais a fonte agent_costs (só
-- líderes) e os agrupamentos por agente, caixa, tipo de gasto e modelo.
create or replace function mavi_private.dashboard_sql(c uuid, q jsonb, p_group text, p_interval text,
 p_from date, p_to date, p_filters jsonb, p_limit integer) returns text
language plpgsql stable security definer set search_path = '' as $$
declare
  src text := q->>'source';
  metric text := q->>'metric';
  tz text;
  base text;
  conds text[];
  m text;
  additive boolean := true;
  datef text;
  col text;
  is_ts boolean := true;
  person text;
  late text;
  f jsonb;
  fld text;
  op text;
  vals text[];
  colf text;
  typed text;
  key text;
  label text;
  bucket text;
  other text := '';
  lim integer := least(greatest(coalesce(p_limit, 1000), 1), 1000);
  filters jsonb;
  nodate boolean := false;
  -- Tasks, status history, validations and due date changes all read the task (t.).
  on_task boolean := src in ('tasks', 'status_history', 'reviews', 'due_changes');
  executor constant text := 'coalesce(t.executor_id, t.assignee_id)';
  -- Everyone who executed the task (migration 20270131090000); a task never
  -- executed counts for its responsible.
  doers constant text := 'coalesce(nullif(t.executor_ids, ''{}''::uuid[]), array[t.assignee_id])';
  -- Tarefas: who each task counts for. 'roles' (cada um a sua parte, the
  -- default), 'executor' (everyone who executed) or 'assignee' (who has it now).
  attribution text := coalesce(nullif(q->>'attribution', ''), 'roles');
  -- One row per executor (w.user_id): grouping by them splits the task.
  joined boolean := false;
  -- Migration 20270209090000: everyone a row counts for, as an array — on
  -- tasks and hours, a team is its people (see the team filter below).
  people text;
  validator constant text := 'coalesce(p.ended_by, p.user_id)';
  dur constant text := 'extract(epoch from (coalesce(p.ended_at, now()) - p.started_at))';
  delivered_day text;
  rework constant text := 'exists (select 1 from public.task_status_periods x where x.task_id = t.id'
   ' and (x.status in (''rejected'', ''correction'') or x.from_status = ''done''))';
  -- Temperatura (migration 20261110090000): the bands that warn, by index.
  bands jsonb;
  alert_bands integer[];
  ind text;
  -- Radar (migration 20261230090000): the kind of the item's status.
  rkind text;
  -- Migration 20270224090000: the records behind the figure (q.__rows).
  rid text;
  kind text;
  keyx text;
  rkeys text[];
  rexcl text[];
begin
  select timezone into tz from public.companies where id = c;
  if tz is null then raise exception 'Empresa não encontrada'; end if;
  late := format('((t.status <> ''done'' and t.due_date < (now() at time zone %1$L)::date)'
   ' or (t.delivered_at is not null and (t.delivered_at at time zone %1$L)::date > t.due_date))', tz);
  delivered_day := format('(t.delivered_at at time zone %L)::date', tz);

  if src = 'tasks' then
    base := 'public.tasks t';
    conds := array[format('t.company_id = %L', c), 'not t.archived'];
    datef := coalesce(q->>'dateField', 'created_at');
    if datef = 'created_at' then col := 't.created_at';
    elsif datef = 'delivered_at' then col := 't.delivered_at';
    elsif datef = 'due_date' then col := 't.due_date'; is_ts := false;
    else raise exception 'Campo de data inválido: %', datef using errcode = '22023';
    end if;
    -- Who each task counts for (migration 20270131090000). Cada um a sua
    -- parte: the work is of everyone who executed it; a late task, of
    -- whoever had it when the due date passed (still in validation: the
    -- validator); a due date set tight or shorter than the MAVI's, of who
    -- created the task.
    if attribution not in ('roles', 'executor', 'assignee') then
      raise exception 'Atribuição inválida: %', attribution using errcode = '22023';
    end if;
    if attribution = 'assignee' then person := 't.assignee_id';
    elsif attribution = 'roles' and metric = 'late' then
      person := format('coalesce(mavi_private.task_holder_at(t.id, ((t.due_date + 1)::timestamp at time zone %L)), %s)',
       tz, executor);
      conds := conds || late;
    elsif attribution = 'roles' and metric in ('tight_due', 'shorter_than_smart') then person := 't.creator_id';
    else person := 'w.user_id';
    end if;
    joined := p_group = 'executor' or (p_group = 'person' and person = 'w.user_id');
    if joined then base := format('public.tasks t cross join lateral unnest(%s) w(user_id)', doers); end if;
    m := case metric
      when 'count' then 'count(*)'
      -- Split among the executors when each one gets a row.
      when 'estimated_hours' then case when joined
        then format('coalesce(sum(t.estimated_minutes::numeric / cardinality(%s)), 0) / 60.0', doers)
        else 'coalesce(sum(t.estimated_minutes), 0) / 60.0' end
      when 'late' then format('count(*) filter (where %s)', late)
      when 'lead_time_days' then 'avg(extract(epoch from (t.delivered_at - t.created_at)) / 86400.0)'
      -- Migration 20261104090000: delivery quality.
      when 'on_time_rate' then format('100.0 * count(*) filter (where %s <= t.due_date) / nullif(count(*), 0)', delivered_day)
      when 'on_time_original_rate' then
        format('100.0 * count(*) filter (where %s <= t.original_due_date) / nullif(count(*), 0)', delivered_day)
      when 'delay_days' then format('avg((%1$s - t.due_date)::numeric) filter (where %1$s > t.due_date)', delivered_day)
      when 'rescheduled' then 'count(*) filter (where t.due_date <> t.original_due_date)'
      when 'first_pass_rate' then format('100.0 * count(*) filter (where not %s) / nullif(count(*), 0)', rework)
      when 'rework_per_task' then 'avg((select count(*) from public.task_status_periods x where x.task_id = t.id'
       ' and x.status in (''rejected'', ''correction'') and x.from_status is distinct from x.status))'
      -- Migration 20261201120000: how the suggested due dates did. Among the
      -- delivered tasks that had the suggestion, the share delivered by it
      -- and the MAVI's average miss (days, either way).
      when 'smart_hit_rate' then format('100.0 * count(*) filter (where %s <= t.due_smart_date)'
       ' / nullif(count(*) filter (where t.due_smart_date is not null), 0)', delivered_day)
      when 'rule_hit_rate' then format('100.0 * count(*) filter (where %s <= t.due_rule_date)'
       ' / nullif(count(*) filter (where t.due_rule_date is not null), 0)', delivered_day)
      when 'smart_error_days' then format('avg(abs(%s - t.due_smart_date)::numeric)'
       ' filter (where t.due_smart_date is not null)', delivered_day)
      -- A date set before the rule's minimum (with a reason) and one set
      -- earlier than the MAVI suggested.
      when 'tight_due' then 'count(*) filter (where t.due_tight_reason is not null)'
      when 'shorter_than_smart' then 'count(*) filter (where t.original_due_date < t.due_smart_date)'
    end;
    if metric in ('lead_time_days', 'on_time_rate', 'on_time_original_rate', 'delay_days', 'first_pass_rate',
     'rework_per_task', 'smart_hit_rate', 'rule_hit_rate', 'smart_error_days') then
      additive := false;
      conds := conds || 't.delivered_at is not null'::text;
    end if;
  elsif src = 'hours' then
    base := 'public.time_entries e';
    conds := array[format('e.company_id = %L', c)];
    person := 'e.user_id';
    col := 'e.started_at';
    m := case metric
      when 'hours' then 'coalesce(sum(extract(epoch from (coalesce(e.ended_at, now()) - e.started_at))), 0) / 3600.0'
      when 'entries' then 'count(*)'
      when 'people' then 'count(distinct e.user_id)'
      when 'tasks' then 'count(distinct e.task_id)'
    end;
    if metric in ('people', 'tasks') then additive := false; end if;
  elsif src = 'status_history' then
    -- Migration 20261104090000: each period a task spent in a status with a
    -- responsible. "Vezes" counts entries into the status (a change of hands
    -- inside it is not a new entry); time runs until now while open.
    base := 'public.task_status_periods p join public.tasks t on t.id = p.task_id';
    conds := array[format('p.company_id = %L', c), 'not t.archived'];
    -- The time is of whoever held the task in the status (executing,
    -- validating, waiting for information). Migration 20270131090000: the
    -- times it was returned (Devolvida) count for who returned it.
    person := case when metric = 'entries'
      then 'case when p.status = ''returned'' then p.previous_user_id else p.user_id end'
      else 'p.user_id' end;
    datef := coalesce(q->>'dateField', 'started_at');
    if datef = 'started_at' then col := 'p.started_at';
    elsif datef = 'ended_at' then col := 'p.ended_at';
    else raise exception 'Campo de data inválido: %', datef using errcode = '22023';
    end if;
    m := case metric
      when 'entries' then 'count(*) filter (where p.from_status is distinct from p.status)'
      when 'hours' then format('coalesce(sum(%s), 0) / 3600.0', dur)
      when 'avg_hours' then format('avg(%s) / 3600.0', dur)
      when 'tasks' then 'count(distinct p.task_id)'
      when 'reopens' then 'count(*) filter (where p.from_status = ''done'')'
    end;
    if metric in ('avg_hours', 'tasks') then additive := false; end if;
  elsif src = 'reviews' then
    -- Migration 20261104090000: the validation periods. Approved = left
    -- validation delivered; reproved = sent back to Alteração or Correção.
    -- The person is whoever sent it to validation; the validator, whoever
    -- decided (or held it, while undecided).
    base := 'public.task_status_periods p join public.tasks t on t.id = p.task_id';
    conds := array[format('p.company_id = %L', c), 'not t.archived', 'p.status = ''review'''];
    person := 'p.previous_user_id';
    -- Each metric has its own date: the sending or the decision.
    col := case when metric = 'sent' then 'p.started_at' else 'p.ended_at' end;
    m := case metric
      when 'sent' then 'count(*) filter (where p.from_status is distinct from ''review'')'
      when 'approved' then 'count(*) filter (where p.to_status = ''done'')'
      when 'reproved' then 'count(*) filter (where p.to_status in (''rejected'', ''correction''))'
      when 'approval_rate' then '100.0 * count(*) filter (where p.to_status = ''done'')'
       ' / nullif(count(*) filter (where p.to_status in (''done'', ''rejected'', ''correction'')), 0)'
      when 'reproval_rate' then '100.0 * count(*) filter (where p.to_status in (''rejected'', ''correction''))'
       ' / nullif(count(*) filter (where p.to_status in (''done'', ''rejected'', ''correction'')), 0)'
      when 'avg_hours' then format('avg(%s) / 3600.0', dur)
    end;
    if metric in ('approval_rate', 'reproval_rate', 'avg_hours') then additive := false; end if;
  elsif src = 'due_changes' then
    -- Migration 20270110090000: each change of a task's due date after its
    -- creation, with its reason (task, edit, bulk or replanning). "Pessoa" is
    -- who changed it; the date, when it was changed.
    base := 'public.task_due_changes x join public.tasks t on t.id = x.task_id';
    conds := array[format('x.company_id = %L', c), 'not t.archived'];
    person := 'x.changed_by';
    col := 'x.created_at';
    m := case metric
      when 'changes' then 'count(*)'
      when 'tasks' then 'count(distinct x.task_id)'
      when 'avg_days' then 'avg(abs(x.new_due - x.old_due)::numeric)'
      when 'earlier' then 'count(*) filter (where x.new_due < x.old_due)'
      when 'later' then 'count(*) filter (where x.new_due > x.old_due)'
    end;
    if metric in ('tasks', 'avg_days') then additive := false; end if;
  elsif src = 'notices' then
    -- Mural de avisos (migration 20261107090000): one row per person reached
    -- by a notice (its current round), dated by the delivery. Seen, confirmed
    -- ("Li e entendi", only notices that ask for it) and pending (not seen,
    -- or not confirmed when asked).
    base := 'public.notice_receipts r join public.notices n on n.id = r.notice_id';
    conds := array[format('r.company_id = %L', c)];
    person := 'r.user_id';
    col := 'r.delivered_at';
    m := case metric
      when 'notices' then 'count(distinct r.notice_id)'
      when 'delivered' then 'count(*)'
      when 'seen' then 'count(r.seen_at)'
      when 'pending' then 'count(*) filter (where r.seen_at is null or (n.require_ack and r.acked_at is null))'
      when 'seen_rate' then '100.0 * count(r.seen_at) / nullif(count(*), 0)'
      when 'acked' then 'count(r.acked_at)'
      when 'ack_rate' then '100.0 * count(r.acked_at) / nullif(count(*) filter (where n.require_ack), 0)'
      when 'hours_to_see' then 'avg(extract(epoch from (r.seen_at - r.delivered_at))) / 3600.0'
      when 'hours_to_ack' then 'avg(extract(epoch from (r.acked_at - r.delivered_at))) / 3600.0'
    end;
    if metric in ('notices', 'seen_rate', 'ack_rate', 'hours_to_see', 'hours_to_ack') then additive := false; end if;
  elsif src = 'temperature' then
    -- Termômetro (migration 20261110090000): one row per client and day with
    -- the day's temperature (0–100), each indicator and the alert signals.
    -- Averages over the client-days of the period; counts are distinct
    -- clients.
    select s.bands into bands from public.temperature_settings s where s.company_id = c;
    select coalesce(array_agg((x.n - 1)::integer), '{}') into alert_bands
    from jsonb_array_elements(coalesce(bands, '[]')) with ordinality x(b, n) where coalesce((x.b->>'alert')::boolean, false);
    base := 'public.temperature_days d join public.clients cl on cl.id = d.client_id';
    conds := array[format('d.company_id = %L', c), 'not cl.archived'];
    col := 'd.day';
    is_ts := false;
    ind := q->>'indicator';
    if metric = 'indicator' and coalesce(ind, '') !~ '^[a-z][a-z0-9_]{1,39}$' then
      raise exception 'Escolha o indicador do termômetro.' using errcode = '22023';
    end if;
    m := case metric
      when 'score' then 'avg(d.score)'
      when 'indicator' then format('avg((d.indicators->>%L)::numeric)', ind)
      when 'clients' then 'count(distinct d.client_id) filter (where d.score is not null)'
      when 'alert_clients' then format('count(distinct d.client_id) filter (where d.band = any(%L::integer[]))', alert_bands)
      when 'alert_rate' then format('100.0 * count(distinct d.client_id) filter (where d.band = any(%L::integer[]))'
       ' / nullif(count(distinct d.client_id) filter (where d.score is not null), 0)', alert_bands)
      when 'flag_clients' then 'count(distinct d.client_id) filter (where cardinality(d.flags) > 0)'
    end;
    additive := false;
  elsif src = 'social_leads' then
    -- Social Leads (migration 20261020120000): decisions from the posts'
    -- history, the time until a plan's 8 posts are approved, and the
    -- clients by stage (today's picture: no period).
    if metric in ('approvals', 'rejections', 'approval_rate', 'rejection_rate', 'adjust_per_post') then
      base := 'public.social_leads_post_events e join public.contracts k on k.id = e.contract_id';
      conds := array[format('e.company_id = %L', c), 'e.kind in (''approved'', ''rejected'')'];
      person := 'e.actor_id';
      col := 'e.created_at';
      m := case metric
        when 'approvals' then 'count(*) filter (where e.kind = ''approved'')'
        when 'rejections' then 'count(*) filter (where e.kind = ''rejected'')'
        when 'approval_rate' then '100.0 * count(*) filter (where e.kind = ''approved'') / nullif(count(*), 0)'
        when 'rejection_rate' then '100.0 * count(*) filter (where e.kind = ''rejected'') / nullif(count(*), 0)'
        when 'adjust_per_post' then
          'count(*) filter (where e.kind = ''rejected'')::numeric / nullif(count(distinct (e.plan_id, e.number)), 0)'
      end;
      if metric not in ('approvals', 'rejections') then additive := false; end if;
    elsif metric = 'approval_days' then
      base := '(select p.id, p.company_id, p.contract_id, p.created_at, p.created_by,'
       ' (select max(x.decided_at) from public.social_leads_posts x where x.plan_id = p.id) as approved_at'
       ' from public.social_leads_plans p where (select count(*) from public.social_leads_posts x'
       ' where x.plan_id = p.id and x.decision = ''approved'') = (select count(*) from public.social_leads_posts x'
       ' where x.plan_id = p.id)) a join public.contracts k on k.id = a.contract_id';
      conds := array[format('a.company_id = %L', c)];
      person := 'a.created_by';
      col := 'a.approved_at';
      m := 'avg(extract(epoch from (a.approved_at - a.created_at)) / 86400.0)';
      additive := false;
    elsif metric = 'clients' then
      base := '(select k2.id, k2.company_id, mavi_private.social_leads_stage(k2.company_id, k2.id) as stage,'
       ' (select b.responsible_id from public.social_leads_briefings b where b.company_id = k2.company_id'
       ' and b.contract_id = k2.id) as responsible'
       ' from public.contracts k2 join public.social_leads_settings s on s.company_id = k2.company_id'
       ' and s.product_id = k2.product_id join public.clients cl on cl.id = k2.client_id'
       ' where not k2.archived and not cl.archived) a join public.contracts k on k.id = a.id';
      conds := array[format('a.company_id = %L', c)];
      person := 'a.responsible';
      nodate := true;
      m := 'count(*)';
    end if;
  elsif src = 'radar' then
    -- Radar do cliente (migration 20261230090000): one row per item (a
    -- subject of a client in a topic); "Ocorrências" counts each time it came
    -- up. "Pessoa" is the item's responsible; "Equipe", the teams that serve
    -- the client.
    rkind := 'coalesce(mavi_private.radar_status(rt.statuses, i.status)->>''kind'', '''')';
    if metric = 'mentions' then
      base := 'public.radar_mentions mn join public.radar_items i on i.id = mn.item_id'
       ' join public.radar_topics rt on rt.id = i.topic_id join public.clients cl on cl.id = i.client_id';
      col := 'mn.occurred_at';
    else
      base := 'public.radar_items i join public.radar_topics rt on rt.id = i.topic_id'
       ' join public.clients cl on cl.id = i.client_id';
      datef := coalesce(q->>'dateField', 'created_at');
      if datef = 'created_at' then col := 'i.created_at';
      elsif datef = 'last_seen_at' then col := 'i.last_seen_at';
      elsif datef = 'status_at' then col := 'i.status_at';
      else raise exception 'Campo de data inválido: %', datef using errcode = '22023';
      end if;
    end if;
    conds := array[format('i.company_id = %L', c), 'not cl.archived'];
    person := 'i.assignee_id';
    m := case metric
      when 'items' then 'count(*)'
      when 'open_items' then format('count(*) filter (where %s <> ''closed'')', rkind)
      when 'closed_items' then format('count(*) filter (where %s = ''closed'')', rkind)
      when 'severe' then 'count(*) filter (where i.severity >= 2)'
      when 'overdue' then format('count(*) filter (where i.due_date < (now() at time zone %L)::date and %s <> ''closed'')',
       tz, rkind)
      when 'recurring' then 'count(*) filter (where i.mentions > 1)'
      when 'clients' then 'count(distinct i.client_id)'
      when 'avg_severity' then 'avg(i.severity)'
      when 'days_to_close' then format('avg(extract(epoch from (i.status_at - i.first_seen_at)) / 86400.0)'
       ' filter (where %s = ''closed'')', rkind)
      when 'mentions' then 'count(*)'
    end;
    if metric in ('clients', 'avg_severity', 'days_to_close') then additive := false; end if;
  elsif src = 'agent_costs' then
    -- Agentes MAVI › Custos (migração 20270706090000): as somas por dia ×
    -- agente × caixa × tipo × modelo copiadas do motor; R$ pela PTAX do dia.
    -- Custo é financeiro: só administradores e gestores.
    if not mavi_private.leader(c) then
      raise exception 'Os custos dos Agentes MAVI são só de administradores e gestores.' using errcode = '42501';
    end if;
    base := 'mavi_private.agent_cost_daily ac';
    conds := array[format('ac.company_id = %L', c)];
    col := 'ac.day';
    is_ts := false;
    m := case metric
      when 'cost_brl' then 'coalesce(sum(ac.cost_usd * mavi_private.ptax_on(ac.day)), 0)'
      when 'cost_usd' then 'coalesce(sum(ac.cost_usd), 0)'
      when 'whatsapp_brl' then 'coalesce(sum(ac.cost_usd * mavi_private.ptax_on(ac.day)) filter (where ac.cost_group = ''whatsapp''), 0)'
      when 'ai_brl' then 'coalesce(sum(ac.cost_usd * mavi_private.ptax_on(ac.day)) filter (where ac.cost_group <> ''whatsapp''), 0)'
      when 'events' then 'coalesce(sum(ac.events), 0)'
      when 'tokens' then 'coalesce(sum(ac.tokens_in + ac.tokens_out), 0)'
      when 'agents' then 'count(distinct ac.agent_id)'
    end;
    if metric = 'agents' then additive := false; end if;
  else
    raise exception 'Fonte de dados inválida: %', src using errcode = '22023';
  end if;
  if m is null then raise exception 'Métrica inválida: %', metric using errcode = '22023'; end if;

  if nodate then
    if p_group = 'time' then
      raise exception 'Clientes por etapa é a situação de hoje: agrupe por etapa, cliente ou sem agrupar.' using errcode = '22023';
    end if;
  elsif is_ts then
    conds := conds || format('%1$s >= (%2$L::timestamp at time zone %4$L) and %1$s < (%3$L::timestamp at time zone %4$L)',
     col, p_from, p_to + 1, tz);
  else
    conds := conds || format('%s between %L and %L', col, p_from, p_to);
  end if;

  if src in ('tasks', 'hours', 'status_history', 'reviews', 'due_changes') then
    people := case when person = 'w.user_id' and not joined then doers else format('array[%s]', person) end;
  end if;

  -- The query's own filters, then the dashboard's (client, product, team, person).
  filters := coalesce(q->'filters', '[]'::jsonb);
  if jsonb_typeof(filters) <> 'array' then raise exception 'Filtros inválidos' using errcode = '22023'; end if;
  filters := filters || coalesce((
    select jsonb_agg(jsonb_build_object('field', x.field, 'values', p_filters->x.name))
    from (values ('clients','client'), ('products','product'), ('teams','team'), ('people','person')) x(name, field)
    where jsonb_typeof(p_filters->x.name) = 'array' and jsonb_array_length(p_filters->x.name) > 0
  ), '[]'::jsonb);
  if jsonb_array_length(filters) > 20 then raise exception 'Filtros demais' using errcode = '22023'; end if;
  for f in select value from jsonb_array_elements(filters) loop
    fld := f->>'field';
    op := coalesce(f->>'op', 'in');
    if op not in ('in', 'not_in') then raise exception 'Operador inválido: %', op using errcode = '22023'; end if;
    if jsonb_typeof(coalesce(f->'values', '[]'::jsonb)) <> 'array' then
      raise exception 'Valores de filtro inválidos' using errcode = '22023';
    end if;
    select coalesce(array_agg(x), '{}') into vals from jsonb_array_elements_text(coalesce(f->'values', '[]'::jsonb)) x;
    if cardinality(vals) = 0 then continue; end if;
    if cardinality(vals) > 500 then raise exception 'Filtro com valores demais' using errcode = '22023'; end if;
    if src = 'agent_costs' then
      -- Custos: o cliente e o produto do agente; equipe e pessoa pelo cliente.
      if fld = 'project' then continue; end if;
      colf := case fld
        when 'client' then 'unused'
        when 'product' then format('select k.id from public.contracts k where k.company_id = %L'
          ' and k.product_id = any(%L::uuid[])', c, vals)
        when 'team' then format('select ct.client_id from public.client_teams ct where ct.company_id = %L'
          ' and ct.team_id = any(%L::uuid[])', c, vals)
        when 'person' then format('select ct.client_id from public.client_teams ct join public.team_members tm'
          ' on tm.company_id = ct.company_id and tm.team_id = ct.team_id where ct.company_id = %L'
          ' and tm.user_id = any(%L::uuid[])', c, vals)
      end;
      if colf is null then raise exception 'Filtro inválido para esta fonte: %', fld using errcode = '22023'; end if;
      conds := conds || case
        when fld = 'client' then format(case when op = 'in' then 'ac.client_id = any(%L::uuid[])'
          else '(ac.client_id is null or ac.client_id <> all(%L::uuid[]))' end, vals)
        when fld = 'product' then format(case when op = 'in' then 'ac.contract_id in (%s)'
          else '(ac.contract_id is null or ac.contract_id not in (%s))' end, colf)
        else format(case when op = 'in' then 'ac.client_id in (%s)'
          else '(ac.client_id is null or ac.client_id not in (%s))' end, colf) end;
      continue;
    end if;
    if src = 'temperature' then
      -- A client's temperature: the client itself, the products it hires,
      -- the teams that serve it and the people in those teams; the project
      -- filter doesn't apply.
      if fld = 'project' then continue; end if;
      if fld = 'band' then
        conds := conds || format(case when op = 'in' then 'd.band = any(%L::integer[])'
          else '(d.band is null or d.band <> all(%L::integer[]))' end,
         (select coalesce(array_agg(v::integer), '{}') from unnest(vals) v where v ~ '^\d{1,2}$'));
        continue;
      end if;
      colf := case fld
        when 'client' then format('select %L::uuid[]', vals)
        when 'product' then format('select k.client_id from public.contracts k where k.company_id = %L'
          ' and not k.archived and k.product_id = any(%L::uuid[])', c, vals)
        when 'team' then format('select ct.client_id from public.client_teams ct where ct.company_id = %L'
          ' and ct.team_id = any(%L::uuid[])', c, vals)
        when 'person' then format('select ct.client_id from public.client_teams ct join public.team_members tm'
          ' on tm.company_id = ct.company_id and tm.team_id = ct.team_id where ct.company_id = %L'
          ' and tm.user_id = any(%L::uuid[])', c, vals)
      end;
      if colf is null then raise exception 'Filtro inválido para esta fonte: %', fld using errcode = '22023'; end if;
      conds := conds || case when fld = 'client'
        then format(case when op = 'in' then 'd.client_id = any(%L::uuid[])' else 'd.client_id <> all(%L::uuid[])' end, vals)
        else format(case when op = 'in' then 'd.client_id in (%s)' else 'd.client_id not in (%s)' end, colf) end;
      continue;
    end if;
    if src = 'radar' then
      -- The item's client, product (none = Geral / Agência), responsible,
      -- topic, theme, severity and kind of status; a team is the clients it
      -- serves. The project filter doesn't apply.
      if fld = 'project' then continue; end if;
      if fld = 'team' then
        conds := conds || format(case when op = 'in' then 'i.client_id in (%s)' else 'i.client_id not in (%s)' end,
         format('select ct.client_id from public.client_teams ct where ct.company_id = %L and ct.team_id = any(%L::uuid[])',
          c, vals));
        continue;
      end if;
      if fld = 'severity' then
        conds := conds || format(case when op = 'in' then 'i.severity = any(%L::integer[])'
          else '(i.severity is null or i.severity <> all(%L::integer[]))' end,
         (select coalesce(array_agg(v::integer), '{}') from unnest(vals) v where v ~ '^[0-3]$'));
        continue;
      end if;
      if fld = 'state' then
        conds := conds || format(case when op = 'in' then '%s = any(%L::text[])' else '%s <> all(%L::text[])' end,
         rkind, vals);
        continue;
      end if;
      if fld = 'product' and 'none' = any(vals) then
        conds := conds || format(case when op = 'in' then '(i.product_id is null or i.product_id = any(%L::uuid[]))'
          else '(i.product_id is not null and i.product_id <> all(%L::uuid[]))' end,
         (select coalesce(array_agg(v), '{}') from unnest(vals) v where v ~* '^[0-9a-f-]{36}$'));
        continue;
      end if;
      colf := case fld when 'client' then 'i.client_id' when 'product' then 'i.product_id'
       when 'person' then 'i.assignee_id' when 'topic' then 'i.topic_id' when 'theme' then 'i.theme_id' end;
      if colf is null then raise exception 'Filtro inválido para esta fonte: %', fld using errcode = '22023'; end if;
      conds := conds || format(case when op = 'in' then '%1$s = any(%2$L::uuid[])' else '(%1$s is null or %1$s <> all(%2$L::uuid[]))' end,
       colf, (select coalesce(array_agg(v), '{}') from unnest(vals) v where v ~* '^[0-9a-f-]{36}$'));
      continue;
    end if;
    if src = 'social_leads' then
      -- A team counts the clients it serves.
      if fld = 'team' then
        conds := conds || format(case when op = 'in' then '%1$s in (%2$s)' else '%1$s not in (%2$s)' end,
         'k.client_id', format('select ct.client_id from public.client_teams ct where ct.company_id = %L and ct.team_id = any(%L::uuid[])',
          c, vals));
        continue;
      end if;
      if fld not in ('client', 'product', 'person') then
        raise exception 'Filtro inválido para esta fonte: %', fld using errcode = '22023';
      end if;
    end if;
    if src = 'notices' then
      -- Avisos não têm cliente, produto nem projeto: esses filtros do
      -- dashboard não se aplicam a eles. A equipe é a de quem recebeu.
      if fld in ('client', 'product', 'project') then continue; end if;
      if fld = 'team' then
        conds := conds || format(case when op = 'in' then '%1$s in (%2$s)' else '%1$s not in (%2$s)' end,
         'r.user_id', format('select tm.user_id from public.team_members tm where tm.company_id = %L and tm.team_id = any(%L::uuid[])',
          c, vals));
        continue;
      end if;
      if fld not in ('person', 'creator', 'level') then
        raise exception 'Filtro inválido para esta fonte: %', fld using errcode = '22023';
      end if;
    end if;
    -- Migration 20270209090000: on tasks and hours, "Equipe" is the team's
    -- people — whoever the "Pessoa" filter would read (executors, holder at
    -- the due date, creator, who registered…). tasks.team_id is set only
    -- when a task is sent to the team, so the tasks given straight to its
    -- people were left out.
    if fld = 'team' and people is not null then
      conds := conds || format(case when op = 'in' then 'exists (%s)' else 'not exists (%s)' end,
       format('select 1 from public.team_members tm where tm.company_id = %L and tm.team_id = any(%L::uuid[])'
        ' and tm.user_id = any(%s)', c, vals, people));
      continue;
    end if;
    if fld = 'late' and src = 'tasks' then
      conds := conds || case when (vals[1] = 'true') = (op = 'in') then late else format('not %s', late) end;
      continue;
    end if;
    -- Migration 20270131090000: the executors are a list. With one row per
    -- executor, the filter keeps those rows; otherwise, the tasks one of
    -- them executed (each task counted once).
    if src = 'tasks' and (fld = 'executor' or (fld = 'person' and person = 'w.user_id')) then
      conds := conds || case
        when joined then format(case when op = 'in' then 'w.user_id = any(%L::uuid[])'
          else '(w.user_id is null or w.user_id <> all(%L::uuid[]))' end, vals)
        else format(case when op = 'in' then '%1$s && %2$L::uuid[]' else 'not (%1$s && %2$L::uuid[])' end, doers, vals) end;
      continue;
    end if;
    colf := case
      when fld = 'client' then 'k.client_id'
      when fld = 'product' then 'k.product_id'
      when fld = 'project' then 't.project_id'
      when fld = 'person' then person
      when fld = 'creator' and on_task then 't.creator_id'
      when fld = 'status' and src = 'tasks' then 't.status'
      when fld = 'status' and src = 'status_history' then 'p.status'
      when fld = 'priority' and on_task then 't.priority'
      when fld = 'entry_source' and src = 'hours' then 'e.source'
      when fld = 'previous' and src = 'status_history' then 'p.previous_user_id'
      when fld = 'validator' and src = 'reviews' then validator
      when fld = 'creator' and src = 'notices' then 'n.created_by'
      when fld = 'level' and src = 'notices' then 'n.level'
    end;
    if colf is null then raise exception 'Filtro inválido para esta fonte: %', fld using errcode = '22023'; end if;
    typed := format(case when fld in ('status', 'priority', 'entry_source', 'level') then '%L::text[]' else '%L::uuid[]' end, vals);
    conds := conds || format(case when op = 'in' then '%1$s = any(%2$s)' else '(%1$s is null or %1$s <> all(%2$s))' end,
     colf, typed);
  end loop;

  -- Joins only when something reads the task (t.) or its contract (k.):
  -- hours by day or by person never touch tasks.
  key := case
    when src = 'radar' then case p_group
      when 'client' then 'i.client_id' when 'product' then 'i.product_id' when 'person' then 'i.assignee_id'
      when 'team' then 'ctg.team_id' when 'topic' then 'i.topic_id' when 'theme' then 'i.theme_id'
      when 'severity' then 'i.severity' when 'status' then rkind end
    when src = 'temperature' then case p_group
      when 'client' then 'd.client_id' when 'band' then 'd.band'
      when 'team' then 'ctg.team_id' when 'product' then 'kpg.product_id' end
    when src = 'agent_costs' then case p_group
      when 'client' then 'ac.client_id' when 'product' then '(select kx.product_id from public.contracts kx where kx.id = ac.contract_id)'
      when 'team' then 'ctg.team_id' when 'agent' then 'ac.agent_id' when 'inbox' then 'ac.inbox_id'
      when 'cost_group' then 'ac.cost_group' when 'model' then 'ac.model' end
    when src = 'notices' then case p_group
      when 'person' then person when 'team' then 'tm.team_id' when 'creator' then 'n.created_by'
      when 'notice' then 'n.id' when 'level' then 'n.level' end
    when src = 'social_leads' then case p_group
      when 'client' then 'k.client_id' when 'product' then 'k.product_id' when 'person' then person
      when 'stage' then case when metric = 'clients' then 'a.stage' end end
    when p_group = 'client' then 'k.client_id'
    when p_group = 'product' then 'k.product_id'
    when p_group = 'project' then 't.project_id'
    when p_group = 'team' then 'tg.team_id'
    when p_group = 'person' then person
    when p_group = 'creator' and on_task then 't.creator_id'
    when p_group = 'status' and src = 'tasks' then 't.status'
    when p_group = 'status' and src = 'status_history' then 'p.status'
    when p_group = 'priority' and on_task then 't.priority'
    when p_group = 'executor' and src = 'tasks' then 'w.user_id'
    when p_group = 'previous' and src = 'status_history' then 'p.previous_user_id'
    when p_group = 'validator' and src = 'reviews' then validator
  end;
  if src = 'hours' and (strpos(array_to_string(conds, ' ') || ' ' || coalesce(key, ''), 't.') > 0
   or strpos(array_to_string(conds, ' ') || ' ' || coalesce(key, ''), 'k.') > 0) then
    base := base || ' join public.tasks t on t.id = e.task_id';
  end if;
  -- Each team of the row's people once (a task done by two people of the
  -- same team counts once for it); nobody in a team: "Sem equipe".
  if p_group = 'team' and people is not null then
    base := base || format(' left join lateral (select distinct tm.team_id from public.team_members tm'
     ' where tm.company_id = %L and tm.user_id = any(%s)) tg on true', c, people);
  end if;
  if src = 'notices' and p_group = 'team' then
    base := base || ' join public.team_members tm on tm.company_id = r.company_id and tm.user_id = r.user_id';
  end if;
  if src = 'radar' and p_group = 'team' then
    base := base || ' join public.client_teams ctg on ctg.company_id = i.company_id and ctg.client_id = i.client_id';
  end if;
  if src = 'agent_costs' and p_group = 'team' then
    base := base || ' join public.client_teams ctg on ctg.company_id = ac.company_id and ctg.client_id = ac.client_id';
  end if;
  if src = 'temperature' and p_group = 'team' then
    base := base || ' join public.client_teams ctg on ctg.company_id = d.company_id and ctg.client_id = d.client_id';
  end if;
  if src = 'temperature' and p_group = 'product' then
    base := base || ' join (select distinct x.company_id, x.client_id, x.product_id from public.contracts x'
     ' where not x.archived) kpg on kpg.company_id = d.company_id and kpg.client_id = d.client_id';
  end if;
  if src not in ('social_leads', 'notices', 'temperature', 'radar', 'agent_costs')
   and strpos(array_to_string(conds, ' ') || ' ' || coalesce(key, ''), 'k.') > 0 then
    base := base || ' join public.contracts k on k.id = t.contract_id';
  end if;
  -- Migration 20270202090000: hours that read nothing of the task (by
  -- person, by period, in total) are the person's clock time — two tasks
  -- timed together count once; by task, client, product… each task keeps
  -- its full time.
  if src = 'hours' and metric = 'hours' and strpos(base, 'join public.tasks') = 0 then
    m := 'coalesce(sum(greatest(0, extract(epoch from (coalesce(e.ended_at, now()) - greatest(e.started_at,'
     ' least(coalesce(e.covered_until, e.started_at), now())))))), 0) / 3600.0';
  end if;

  -- The category's name (also read by the records below).
  label := case
    when src = 'radar' and p_group = 'product' then
     'coalesce((select x.name from public.products x where x.id = r.k), ''Geral / Agência'')'
    when src = 'radar' and p_group = 'person' then
     format('coalesce((select x.name from public.memberships x where x.company_id = %L and x.user_id = r.k), ''Sem responsável'')', c)
    when src = 'radar' and p_group = 'status' then 'case r.k::text when ''open'' then ''Aberto'''
     ' when ''progress'' then ''Em andamento'' when ''closed'' then ''Fechado'' else r.k::text end'
    when p_group = 'topic' then '(select x.name from public.radar_topics x where x.id = r.k)'
    when p_group = 'theme' then 'coalesce((select x.title from public.radar_themes x where x.id = r.k), ''Sem tema'')'
    when p_group = 'severity' then 'case r.k::text when ''0'' then ''Baixa'' when ''1'' then ''Média'''
     ' when ''2'' then ''Alta'' when ''3'' then ''Crítica'' else ''Sem gravidade'' end'
    when p_group = 'agent' then format('coalesce((select max(x.agent_name) from mavi_private.agent_cost_daily x'
     ' where x.company_id = %L and x.agent_id = r.k::text), r.k::text)', c)
    when p_group = 'inbox' then format('coalesce(nullif((select max(x.inbox_name) from mavi_private.agent_cost_daily x'
     ' where x.company_id = %L and x.inbox_id = r.k::text), ''''), case when r.k::text = '''' then ''Sem caixa (testes, conhecimento)'''
     ' else r.k::text end)', c)
    when p_group = 'cost_group' then 'case r.k::text when ''ia'' then ''IA nas conversas'' when ''midias'' then ''Mídias'''
     ' when ''conhecimento'' then ''Conhecimento'' when ''analises'' then ''Análises da MAVI'' when ''whatsapp'' then ''WhatsApp oficial'''
     ' when ''testes'' then ''Testes'' else r.k::text end'
    when p_group = 'model' then 'coalesce(nullif(r.k::text, ''''), ''Sem modelo (WhatsApp oficial)'')'
    when p_group = 'client' then '(select x.name from public.clients x where x.id = r.k)'
    when p_group = 'product' then '(select x.name from public.products x where x.id = r.k)'
    when p_group = 'project' then '(select x.name from public.projects x where x.id = r.k)'
    when p_group = 'team' then '(select x.name from public.teams x where x.id = r.k)'
    when p_group in ('person', 'creator', 'executor', 'previous', 'validator') then
      format('(select x.name from public.memberships x where x.company_id = %L and x.user_id = r.k)', c)
    when p_group = 'notice' then '(select x.title from public.notices x where x.id = r.k)'
    when p_group = 'level' then 'case r.k::text when ''info'' then ''Informativo'' when ''important'' then ''Importante'''
     ' when ''critical'' then ''Crítico'' else r.k::text end'
    when p_group = 'stage' then 'case r.k::text when ''briefing'' then ''Briefing'' when ''plan'' then ''Plano para revisar'''
     ' when ''approval'' then ''Aguardando o cliente'' when ''production'' then ''Aprovado / produção'''
     ' when ''campaign'' then ''Campanha no ar'' else r.k::text end'
    when p_group = 'band' then format('coalesce((%L::jsonb)->(r.k::integer)->>''name'', ''Sem nota'')', coalesce(bands, '[]'))
    else 'r.k::text'
  end;
  -- Migration 20270224090000: the records behind the figure. Same base and
  -- conditions, one row per record (task, entry, period, delivery…) with
  -- its part of the value (the metric over that record alone) and its
  -- category; and the value itself over the same rows, so the list always
  -- adds up to what the panel shows. __keys: only these categories (a bar
  -- clicked); __exclude: all but these ("Outros").
  if q ? '__rows' then
    rid := case src
      when 'tasks' then 't.id::text'
      when 'hours' then case metric when 'tasks' then 'e.task_id::text' when 'people' then 'e.user_id::text'
        else 'e.id::text' end
      when 'status_history' then case when metric = 'tasks' then 'p.task_id::text' else 'p.id::text' end
      when 'reviews' then 'p.id::text'
      when 'due_changes' then case when metric = 'tasks' then 'x.task_id::text' else 'x.id::text' end
      when 'notices' then case when metric = 'notices' then 'r.notice_id::text'
        else 'r.notice_id::text || '':'' || r.user_id::text' end
      when 'temperature' then 'd.client_id::text'
      when 'social_leads' then case when metric = 'adjust_per_post' then 'e.plan_id::text || '':'' || e.number::text'
        when metric in ('approval_days', 'clients') then 'a.id::text' else 'e.id::text' end
      when 'radar' then case metric when 'mentions' then 'mn.id::text' when 'clients' then 'i.client_id::text'
        else 'i.id::text' end
      when 'agent_costs' then 'ac.agent_name || '' · '' || to_char(ac.day, ''DD/MM/YYYY'')'
    end;
    kind := case
      when src = 'tasks' or (src in ('hours', 'status_history', 'due_changes') and metric = 'tasks') then 'task'
      when src = 'hours' then case when metric = 'people' then 'person' else 'entry' end
      when src in ('status_history', 'reviews') then 'period'
      when src = 'due_changes' then 'due_change'
      when src = 'notices' then case when metric = 'notices' then 'notice' else 'receipt' end
      when src = 'temperature' then 'client'
      when src = 'social_leads' then case when metric = 'adjust_per_post' then 'sl_post'
        when metric = 'approval_days' then 'sl_plan' when metric = 'clients' then 'sl_contract' else 'sl_event' end
      when src = 'radar' then case metric when 'mentions' then 'mention' when 'clients' then 'client'
        else 'radar_item' end
      when src = 'agent_costs' then 'agent_cost'
    end;
    if p_group = 'none' then keyx := 'null::text';
    elsif p_group = 'time' then
      if p_interval not in ('day', 'week', 'month') then
        raise exception 'Intervalo inválido: %', p_interval using errcode = '22023';
      end if;
      keyx := case when is_ts then format('date_trunc(%L, %s at time zone %L)::date', p_interval, col, tz)
        else format('date_trunc(%L, %s::timestamp)::date', p_interval, col) end;
    elsif key is null then
      raise exception 'Agrupamento inválido para esta fonte: %', p_group using errcode = '22023';
    else keyx := key;
    end if;
    select coalesce(array_agg(x), '{}') into rkeys from jsonb_array_elements_text(
     case when jsonb_typeof(q->'__keys') = 'array' then q->'__keys' else '[]'::jsonb end) x;
    select coalesce(array_agg(x), '{}') into rexcl from jsonb_array_elements_text(
     case when jsonb_typeof(q->'__exclude') = 'array' then q->'__exclude' else '[]'::jsonb end) x;
    if cardinality(rkeys) + cardinality(rexcl) > 1000 then
      raise exception 'Categorias demais' using errcode = '22023';
    end if;
    if cardinality(rkeys) > 0 then
      conds := conds || format('coalesce((%s)::text, ''__null__'') = any(%L::text[])', keyx, rkeys);
    end if;
    if cardinality(rexcl) > 0 then
      conds := conds || format('coalesce((%s)::text, ''__null__'') <> all(%L::text[])', keyx, rexcl);
    end if;
    -- A record that adds nothing to a sum or a count is not behind it; in an
    -- average or a rate a zero counts (a task delivered late is a 0 in the
    -- on-time rate), and only the ones left out of it (null) go. Hours keep
    -- their zeros: an entry fully covered by another timer of the same
    -- person (migration 20270202090000) shows why it adds nothing.
    return format($f$with g as (select %1$s as id, %2$s as k, %3$s as v, %4$s as d, count(*) as n
  from %5$s where %6$s group by 1, 2),
 a as (select %3$s as v from %5$s where %6$s),
 r as (select g.*, row_number() over (order by g.d desc nulls last, g.id) as rn from g where %7$s)
 select jsonb_build_object('kind', %8$L, 'value', (select a.v from a), 'total', (select count(*) from r),
  'rows', coalesce((select jsonb_agg(jsonb_build_object('id', r.id, 'k', r.k::text, 'l', %9$s, 'v', r.v,
   'd', r.d, 'n', r.n) order by r.rn) from r where r.rn <= 1000), '[]'::jsonb))$f$,
     rid, keyx, m, case when col is null then 'null::timestamptz' else format('max(%s)', col) end, base,
     array_to_string(conds, ' and '),
     case when (not additive and m !~* '^count\(distinct') or src = 'hours' then 'g.v is not null'
      else 'coalesce(g.v, 0) <> 0' end,
     kind, case when p_group in ('none', 'time') then 'null::text' else label end);
  end if;
  if p_group = 'none' then
    return format('select jsonb_build_array(jsonb_build_object(''k'', ''total'', ''v'', %s)) from %s where %s',
     m, base, array_to_string(conds, ' and '));
  end if;

  if p_group = 'time' then
    if p_interval not in ('day', 'week', 'month') then
      raise exception 'Intervalo inválido: %', p_interval using errcode = '22023';
    end if;
    bucket := case when is_ts then format('date_trunc(%L, %s at time zone %L)::date', p_interval, col, tz)
      else format('date_trunc(%L, %s::timestamp)::date', p_interval, col) end;
    return format($f$with g as (select %1$s as k, %2$s as v from %3$s where %4$s group by 1),
 b as (select d::date as k from generate_series(date_trunc(%5$L, %6$L::timestamp), %7$L::timestamp, %8$L::interval) d)
 select coalesce(jsonb_agg(jsonb_build_object('k', b.k, 'v', %9$s) order by b.k), '[]') from b left join g on g.k = b.k$f$,
     bucket, m, base, array_to_string(conds, ' and '), p_interval, p_from, p_to, '1 ' || p_interval,
     case when additive then 'coalesce(g.v, 0)' else 'g.v' end);
  end if;

  if key is null then raise exception 'Agrupamento inválido para esta fonte: %', p_group using errcode = '22023'; end if;
  -- Sums and counts fold the rest into "Outros"; averages and distinct
  -- counts cannot be added up, so the rest is left out.
  if additive then
    other := format('union all select jsonb_build_object(''k'', ''__other__'', ''l'', ''Outros'', ''v'', sum(r.v)), %s from r where r.n > %s having count(*) > 0',
     lim + 1, lim);
  end if;
  return format($f$with g as (select %1$s as k, %2$s as v from %3$s where %4$s group by 1),
 r as (select k, v, row_number() over (order by v desc nulls last, k) as n from g)
 select coalesce(jsonb_agg(o order by n), '[]') from (
  select jsonb_build_object('k', r.k::text, 'l', %5$s, 'v', r.v) as o, r.n from r where r.n <= %6$s
  %7$s
 ) s$f$, key, m, base, array_to_string(conds, ' and '), label, lim, other);
end $$;
revoke all on function mavi_private.dashboard_sql(uuid, jsonb, text, text, date, date, jsonb, integer) from public, anon, authenticated;

-- Igual à de 20270523090000_cs_rules_sources, mais os agrupamentos dos custos.
create or replace function mavi_private.dashboard_check(c uuid, p_panels jsonb, p_variables jsonb) returns void
language plpgsql stable security definer set search_path = '' as $$
declare p jsonb; q jsonb; spec jsonb; ids text[] := '{}'; refs text[]; expr text; cs integer; begin
  if jsonb_typeof(p_panels) <> 'array' or jsonb_array_length(p_panels) > 48 then
    raise exception 'Um dashboard tem até 48 painéis' using errcode = '22023';
  end if;
  if octet_length(p_panels::text) > 300000 then raise exception 'Dashboard grande demais' using errcode = '22023'; end if;
  if jsonb_typeof(coalesce(p_variables, '{}'::jsonb)) <> 'object' then
    raise exception 'Variáveis inválidas' using errcode = '22023';
  end if;
  for p in select value from jsonb_array_elements(p_panels) loop
    if coalesce(p->>'id', '') !~ '^[a-z0-9-]{1,40}$' or p->>'id' = any(ids) then
      raise exception 'Painel com identificador inválido' using errcode = '22023';
    end if;
    ids := ids || (p->>'id');
    if length(coalesce(p->>'title', '')) > 120 then raise exception 'Título de painel longo demais' using errcode = '22023'; end if;
    if jsonb_typeof(p->'x') <> 'number' or jsonb_typeof(p->'y') <> 'number'
     or jsonb_typeof(p->'w') <> 'number' or jsonb_typeof(p->'h') <> 'number'
     or (p->>'x')::int not between 0 and 11 or (p->>'w')::int not between 1 and 12
     or (p->>'x')::int + (p->>'w')::int > 12 or (p->>'y')::int not between 0 and 2000
     or (p->>'h')::int not between 1 and 24 then
      raise exception 'Posição de painel inválida' using errcode = '22023';
    end if;
    spec := p->'spec';
    if coalesce(spec->>'viz', '') not in ('stat', 'line', 'area', 'bar', 'hbar', 'donut', 'table') then
      raise exception 'Visualização inválida' using errcode = '22023';
    end if;
    if coalesce(spec->>'groupBy', 'none') not in
     ('none', 'time', 'client', 'product', 'project', 'team', 'person', 'creator', 'status', 'priority', 'stage',
      'executor', 'previous', 'validator', 'notice', 'level', 'band', 'topic', 'theme', 'severity',
      'squad', 'cs_category', 'cs_adimplencia', 'cs_reason', 'cs_band', 'cs_phase',
      'agent', 'inbox', 'cost_group', 'model') then
      raise exception 'Agrupamento inválido' using errcode = '22023';
    end if;
    if coalesce(spec->>'interval', 'auto') not in ('auto', 'day', 'week', 'month') then
      raise exception 'Intervalo inválido' using errcode = '22023';
    end if;
    if jsonb_typeof(spec->'queries') <> 'array' or jsonb_array_length(spec->'queries') not between 1 and 5 then
      raise exception 'Cada painel tem de 1 a 5 consultas' using errcode = '22023';
    end if;
    expr := coalesce(spec->'formula'->>'expr', '');
    if length(expr) > 200 or expr !~ '^[A-E0-9+*/(). -]*$' then
      raise exception 'Fórmula inválida: use A a E, números, + - * / e parênteses' using errcode = '22023';
    end if;
    -- Um painel é todo de CS ou todo das outras fontes (o de CS é calculado na tela).
    select count(*) into cs from jsonb_array_elements(spec->'queries') x where x->>'source' like 'cs\_%';
    if cs > 0 and cs < jsonb_array_length(spec->'queries') then
      raise exception 'Um painel não mistura fontes de Customer Success com as outras fontes.' using errcode = '22023';
    end if;
    refs := '{}';
    for q in select value from jsonb_array_elements(spec->'queries') loop
      if coalesce(q->>'ref', '') !~ '^[A-E]$' or q->>'ref' = any(refs) then
        raise exception 'Consulta inválida' using errcode = '22023';
      end if;
      refs := refs || (q->>'ref');
      if cs > 0 then
        perform mavi_private.cs_query_check(c, q, coalesce(spec->>'groupBy', 'none'));
      else
        perform mavi_private.dashboard_sql(c, q, coalesce(spec->>'groupBy', 'none'), 'month',
         current_date, current_date, coalesce(p_variables->'filters', '{}'::jsonb), 10);
      end if;
    end loop;
  end loop;
end $$;
revoke all on function mavi_private.dashboard_check(uuid, jsonb, jsonb) from public, anon, authenticated;

commit;
