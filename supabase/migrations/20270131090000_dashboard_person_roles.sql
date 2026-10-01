begin;

-- Pessoa nos Dashboards e nos Relatórios: cada um a sua parte.
--
-- Até aqui, "por pessoa" nas Tarefas contava o responsável atual. Depois de
-- enviada para validação, a tarefa fica com quem valida, e o validador
-- levava as tarefas, os atrasos e as horas estimadas de quem executou.
--
-- 1. tasks.executor_ids: todos que estiveram com a tarefa em Em andamento,
--    Alteração ou Correção, na ordem em que entraram. É mantido pelo mesmo
--    trigger do executor_id e preenchido com o histórico de status que existe.
-- 2. mavi_private.task_holder_at: quem estava com a tarefa num momento
--    (o atraso conta para quem estava com ela quando o prazo venceu).
-- 3. Motor dos Dashboards, fonte Tarefas: cada consulta escolhe para quem a
--    tarefa conta (q.attribution):
--    * 'roles' (padrão, "cada um a sua parte"): quantidade, prazo, retrabalho
--      e horas estimadas para todos que executaram (as horas estimadas são
--      divididas entre eles); atrasadas para quem estava com a tarefa no
--      vencimento; prazos apertados ou mais curtos que a MAVI para quem
--      criou;
--    * 'executor': tudo para todos que executaram;
--    * 'assignee': o responsável atual (como era).
--    Sem o campo vale 'roles': os dashboards que já existem passam a contar
--    assim sem ninguém editar. Agrupar por pessoa dá uma linha por pessoa;
--    o total (sem agrupar, por cliente etc.) conta cada tarefa uma vez.
--    O agrupamento "Quem executou" passa a ser todos que executaram.
--    Status das tarefas: as vezes em Devolvida contam para quem devolveu
--    (o tempo parado continua com quem ficou com a tarefa).
-- 4. Relatórios › por pessoa: as horas registradas no período (cronômetro,
--    de quem registrou) e a carga separada por papel: em execução (com as
--    horas estimadas), em validação e devolvidas.

-- ------------------------------------------------------------ quem executou
alter table public.tasks add column executor_ids uuid[] not null default '{}';

create or replace function mavi_private.track_task_executor() returns trigger
language plpgsql set search_path = '' as $$ begin
 if new.status in ('progress', 'rejected', 'correction') then
  new.executor_id := new.assignee_id;
  if new.assignee_id is not null and not new.assignee_id = any(new.executor_ids) then
   new.executor_ids := new.executor_ids || new.assignee_id;
  end if;
 end if;
 return new;
end $$;
revoke all on function mavi_private.track_task_executor() from public, anon, authenticated;

-- From the status history that exists, then the last executor known.
alter table public.tasks disable trigger user;
update public.tasks t set executor_ids = x.ids
from (
 select y.id, array_agg(y.user_id order by y.first_at) as ids
 from (
  select p.task_id as id, p.user_id, min(p.started_at) as first_at
  from public.task_status_periods p where p.status in ('progress', 'rejected', 'correction')
  group by p.task_id, p.user_id
  union all
  select t2.id, t2.executor_id, 'infinity'::timestamptz from public.tasks t2
  where t2.executor_id is not null and not exists (select 1 from public.task_status_periods p
   where p.task_id = t2.id and p.user_id = t2.executor_id and p.status in ('progress', 'rejected', 'correction'))
 ) y group by y.id
) x where x.id = t.id;
alter table public.tasks enable trigger user;

-- ------------------------------------------------------------ quem estava com ela
-- Whoever held the task at a moment; created later than that, whoever got
-- it first.
create or replace function mavi_private.task_holder_at(p_task uuid, p_at timestamptz) returns uuid
language sql stable security definer set search_path = '' as $$
 select coalesce(
  (select p.user_id from public.task_status_periods p
   where p.task_id = p_task and p.started_at <= p_at and (p.ended_at is null or p.ended_at > p_at)
   order by p.started_at desc, p.id desc limit 1),
  (select p.user_id from public.task_status_periods p
   where p.task_id = p_task and p.started_at > p_at order by p.started_at, p.id limit 1))
$$;
revoke all on function mavi_private.task_holder_at(uuid, timestamptz) from public, anon, authenticated;

-- ------------------------------------------------------------ Dashboards
-- A da migração 20270110090000, com para quem cada tarefa conta.
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
      when fld = 'team' then 't.team_id'
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
    when src = 'notices' then case p_group
      when 'person' then person when 'team' then 'tm.team_id' when 'creator' then 'n.created_by'
      when 'notice' then 'n.id' when 'level' then 'n.level' end
    when src = 'social_leads' then case p_group
      when 'client' then 'k.client_id' when 'product' then 'k.product_id' when 'person' then person
      when 'stage' then case when metric = 'clients' then 'a.stage' end end
    when p_group = 'client' then 'k.client_id'
    when p_group = 'product' then 'k.product_id'
    when p_group = 'project' then 't.project_id'
    when p_group = 'team' then 't.team_id'
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
  if src = 'notices' and p_group = 'team' then
    base := base || ' join public.team_members tm on tm.company_id = r.company_id and tm.user_id = r.user_id';
  end if;
  if src = 'radar' and p_group = 'team' then
    base := base || ' join public.client_teams ctg on ctg.company_id = i.company_id and ctg.client_id = i.client_id';
  end if;
  if src = 'temperature' and p_group = 'team' then
    base := base || ' join public.client_teams ctg on ctg.company_id = d.company_id and ctg.client_id = d.client_id';
  end if;
  if src = 'temperature' and p_group = 'product' then
    base := base || ' join (select distinct x.company_id, x.client_id, x.product_id from public.contracts x'
     ' where not x.archived) kpg on kpg.company_id = d.company_id and kpg.client_id = d.client_id';
  end if;
  if src not in ('social_leads', 'notices', 'temperature', 'radar')
   and strpos(array_to_string(conds, ' ') || ' ' || coalesce(key, ''), 'k.') > 0 then
    base := base || ' join public.contracts k on k.id = t.contract_id';
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

-- ------------------------------------------------------------ Relatórios
-- A da migração 20260921120000; por pessoa: as horas registradas no período
-- e a carga de hoje separada por papel.
create or replace function public.report_summary(p_company uuid,p_start timestamptz,p_end timestamptz) returns jsonb
language sql stable security invoker set search_path = '' as $$
 with visible_tasks as (select id,project_id,status,due_date,contract_id,assignee_id,estimated_minutes from public.tasks where company_id=p_company and not archived),
 hours as (select e.*,greatest(0,extract(epoch from (least(coalesce(e.ended_at,now()),p_end)-greatest(e.started_at,p_start)))/60) as minutes
 from public.time_entries e where company_id=p_company and e.started_at<p_end and coalesce(e.ended_at,now())>p_start),
 by_project as (select project_id as id,count(*) as total,count(*) filter(where status='done') as done from visible_tasks where project_id is not null group by project_id),
 by_client as (select c.id,c.name,sum(h.minutes) as minutes from hours h join visible_tasks t on t.id=h.task_id
 join public.contracts k on k.id=t.contract_id join public.clients c on c.id=k.client_id group by c.id,c.name),
 person_minutes as (select h.user_id,sum(h.minutes) as minutes from hours h group by h.user_id),
 by_person as (select m.user_id as id,m.name,
  count(t.id) filter(where t.status in ('open','progress','rejected','correction')) as tasks,
  coalesce(sum(t.estimated_minutes) filter(where t.status in ('open','progress','rejected','correction')),0) as estimated,
  count(t.id) filter(where t.status='review') as reviewing,
  count(t.id) filter(where t.status='returned') as returned,
  coalesce((select pm.minutes from person_minutes pm where pm.user_id=m.user_id),0) as minutes
 from public.memberships m left join visible_tasks t on t.assignee_id=m.user_id and t.status<>'done'
 where m.company_id=p_company and m.active group by m.user_id,m.name),
 delivery as (select count(*) as n from public.task_events where company_id=p_company and detail->>'to'='done' and created_at>=p_start and created_at<p_end)
 select jsonb_build_object('total',(select count(*) from visible_tasks),
 'late',(select count(*) from visible_tasks where status<>'done' and due_date<(now() at time zone (select timezone from public.companies where id=p_company))::date),
 'review',(select count(*) from visible_tasks where status='review'),'done',(select n from delivery),
 'minutes',coalesce((select sum(minutes) from hours),0),'by_client',coalesce((select jsonb_agg(by_client) from by_client),'[]'),
 'by_project',coalesce((select jsonb_agg(by_project) from by_project),'[]'),
 'by_person',coalesce((select jsonb_agg(by_person) from by_person),'[]'))
$$;
revoke all on function public.report_summary(uuid,timestamptz,timestamptz) from public,anon;
grant execute on function public.report_summary(uuid,timestamptz,timestamptz) to authenticated;

commit;
