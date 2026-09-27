begin;

-- Indicadores de performance das tarefas, para os Dashboards.
--
-- 1. Histórico de status (task_status_periods). Cada linha é um período em
--    que a tarefa ficou num status com um responsável: quando entrou, quando
--    saiu, quem a colocou ali, quem estava com ela antes e para onde foi.
--    Um trigger em public.tasks mantém o histórico por qualquer caminho que
--    mude o status ou o responsável (menu, aprovação, edição, repetição,
--    distribuição para a equipe). O task_events não serve para isso: ele é
--    apagado depois de um mês. Estes períodos ficam para sempre (são linhas
--    pequenas, com índices pelo período e pela pessoa).
--    "Entregue" não abre período: a tarefa terminou. Reabrir abre um novo,
--    com from_status = 'done'.
--
-- 2. Quem executou (tasks.executor_id): a última pessoa que esteve com a
--    tarefa em Em andamento, Alteração ou Correção. Depois de validada, a
--    tarefa costuma ficar com quem validou; o prazo de entrega "por pessoa"
--    precisa de quem fez o trabalho.
--
-- 3. Duas fontes novas no motor dos Dashboards, e métricas novas em Tarefas:
--    * "Status das tarefas" (status_history): vezes no status, tempo no
--      status (horas), tempo médio por vez, tarefas distintas e reaberturas,
--      por responsável no status ou pelo responsável anterior.
--    * "Validações" (reviews): envios para validação, aprovadas, reprovadas
--      (validação que volta para Alteração ou Correção), taxas e tempo médio
--      em validação, por quem enviou ou por quem validou.
--    * Tarefas: entregas no prazo e no prazo original (%), atraso médio das
--      entregas atrasadas, tarefas com prazo alterado, aprovadas de primeira
--      (%) e retrabalhos por tarefa entregue; agrupamento "Quem executou".
--
-- O histórico anterior a esta migração vem do task_events que ainda existe
-- (o último mês) e da situação atual de cada tarefa; o que é mais antigo do
-- que isso não é inventado.

-- ------------------------------------------------------------ histórico
create table public.task_status_periods (
 id bigint generated always as identity primary key,
 company_id uuid not null,
 task_id uuid not null,
 status text not null,
 -- Responsável durante o período.
 user_id uuid not null,
 -- Status anterior: null na criação; igual a status quando só o responsável
 -- mudou (uma troca de mãos, que não conta como nova entrada no status).
 from_status text,
 -- Quem estava com a tarefa antes de ela entrar neste status (mantido nas
 -- trocas de mãos): quem enviou para validação, quem devolveu, quem pediu a
 -- alteração.
 previous_user_id uuid,
 -- Quem moveu (null: automático ou histórico sem autor).
 moved_by uuid,
 revision integer not null default 1,
 started_at timestamptz not null,
 ended_at timestamptz,
 -- Quem tirou a tarefa deste status e para qual status ela foi.
 ended_by uuid,
 to_status text,
 foreign key (company_id, task_id) references public.tasks(company_id, id) on delete cascade,
 check (ended_at is null or ended_at >= started_at)
);
create unique index task_status_periods_open on public.task_status_periods(task_id) where ended_at is null;
create index task_status_periods_task on public.task_status_periods(task_id, started_at);
create index task_status_periods_started on public.task_status_periods(company_id, started_at);
create index task_status_periods_ended on public.task_status_periods(company_id, ended_at) where ended_at is not null;
create index task_status_periods_user on public.task_status_periods(company_id, user_id, started_at);
create index task_status_periods_reviews on public.task_status_periods(company_id, ended_at)
 where status = 'review' and ended_at is not null;
-- Lido só pelos Dashboards (funções do banco).
alter table public.task_status_periods enable row level security;
revoke all on public.task_status_periods from public, anon, authenticated;

alter table public.tasks add column executor_id uuid;

create function mavi_private.track_task_executor() returns trigger
language plpgsql set search_path = '' as $$ begin
 if new.status in ('progress', 'rejected', 'correction') then new.executor_id := new.assignee_id; end if;
 return new;
end $$;
revoke all on function mavi_private.track_task_executor() from public, anon, authenticated;
create trigger track_task_executor before insert or update of status, assignee_id on public.tasks
 for each row execute function mavi_private.track_task_executor();

create function mavi_private.track_task_status_periods() returns trigger
language plpgsql security definer set search_path = '' as $$
declare prev public.task_status_periods; begin
 if tg_op = 'INSERT' then
  if new.status <> 'done' then
   insert into public.task_status_periods(company_id, task_id, status, user_id, moved_by, revision, started_at)
   values (new.company_id, new.id, new.status, new.assignee_id, coalesce(auth.uid(), new.creator_id), new.revision,
    least(new.created_at, now()));
  end if;
  return null;
 end if;
 if new.status is not distinct from old.status and new.assignee_id is not distinct from old.assignee_id then
  return null;
 end if;
 update public.task_status_periods set ended_at = greatest(now(), started_at), ended_by = auth.uid(), to_status = new.status
 where task_id = new.id and ended_at is null
 returning * into prev;
 if new.status <> 'done' then
  insert into public.task_status_periods(company_id, task_id, status, user_id, from_status, previous_user_id,
   moved_by, revision, started_at)
  values (new.company_id, new.id, new.status, new.assignee_id, old.status,
   case when new.status = old.status and prev.id is not null then prev.previous_user_id else old.assignee_id end,
   auth.uid(), new.revision, now());
 end if;
 return null;
end $$;
revoke all on function mavi_private.track_task_status_periods() from public, anon, authenticated;

-- ------------------------------------------------------------ backfill
-- Do task_events que ainda existe e da situação atual das tarefas.
do $$
declare
 t record; e record;
 cur_status text; cur_user uuid; prev_user uuid; from_s text; mover uuid; rev integer; since timestamptz;
 next_user uuid; complete boolean; cut timestamptz;
begin
 for t in select id, company_id, status, assignee_id, creator_id, created_at, status_changed_at, revision
  from public.tasks loop
  cur_status := null; cur_user := null; prev_user := null; from_s := null; mover := null; since := null;
  -- With its "created" event still here, the task's history is complete.
  complete := exists(select 1 from public.task_events x
   where x.company_id = t.company_id and x.task_id = t.id and x.action = 'created');
  for e in select x.created_at, x.actor_id, x.detail->>'from' as f, x.detail->>'to' as s,
    nullif(x.detail->>'assignee_from', '')::uuid as af, nullif(x.detail->>'assignee_to', '')::uuid as at2,
    nullif(x.detail->>'status_since', '')::timestamptz as ss, nullif(x.detail->>'revision', '')::integer as rv
   from public.task_events x
   where x.company_id = t.company_id and x.task_id = t.id
    and x.action in ('move', 'reopen', 'approve_internal', 'approve_client', 'start', 'submit', 'return', 'reject')
    and x.detail ? 'from' and x.detail ? 'to'
   order by x.created_at, x.id loop
   if cur_status is null then
    -- The first move still recorded: the status it left and since when.
    cur_status := e.f;
    cur_user := coalesce(e.af, t.assignee_id);
    since := coalesce(e.ss, case when complete then t.created_at end);
    rev := 1;
   end if;
   next_user := coalesce(e.at2, cur_user);
   if e.s is distinct from cur_status or next_user is distinct from cur_user then
    if since is not null and cur_status <> 'done' then
     insert into public.task_status_periods(company_id, task_id, status, user_id, from_status, previous_user_id,
      moved_by, revision, started_at, ended_at, ended_by, to_status)
     values (t.company_id, t.id, cur_status, cur_user, from_s, prev_user, mover, coalesce(rev, 1),
      least(since, e.created_at), e.created_at, e.actor_id, e.s);
    end if;
    prev_user := case when e.s = cur_status then prev_user else cur_user end;
    from_s := cur_status; cur_status := e.s; cur_user := next_user;
    since := e.created_at; mover := e.actor_id; rev := coalesce(e.rv, rev);
   end if;
  end loop;
  if cur_status is null then
   -- No move recorded: the current status, since it was entered.
   cur_status := t.status; cur_user := t.assignee_id; since := t.status_changed_at; rev := t.revision;
  elsif cur_status is distinct from t.status or cur_user is distinct from t.assignee_id then
   -- Changed without a move event (an edit sending it back to Em andamento,
   -- history older than a month): close what we know, open the current one.
   cut := greatest(coalesce(since, t.status_changed_at), t.status_changed_at);
   if since is not null and cur_status <> 'done' then
    insert into public.task_status_periods(company_id, task_id, status, user_id, from_status, previous_user_id,
     moved_by, revision, started_at, ended_at, to_status)
    values (t.company_id, t.id, cur_status, cur_user, from_s, prev_user, mover, coalesce(rev, 1), since, cut, t.status);
   end if;
   prev_user := case when t.status = cur_status then prev_user else cur_user end;
   from_s := cur_status; cur_status := t.status; cur_user := t.assignee_id; since := cut; mover := null;
   rev := t.revision;
  end if;
  if cur_status <> 'done' and since is not null then
   insert into public.task_status_periods(company_id, task_id, status, user_id, from_status, previous_user_id,
    moved_by, revision, started_at)
   values (t.company_id, t.id, cur_status, cur_user, from_s, prev_user, mover, coalesce(rev, t.revision),
    least(since, now()));
  end if;
 end loop;
end $$;

-- The last executor: now when executing; else from the history.
alter table public.tasks disable trigger user;
update public.tasks t set executor_id = case
 when t.status in ('progress', 'rejected', 'correction') then t.assignee_id
 else (select p.user_id from public.task_status_periods p
  where p.task_id = t.id and p.status in ('progress', 'rejected', 'correction')
  order by p.started_at desc, p.id desc limit 1) end;
alter table public.tasks enable trigger user;

create trigger track_task_status_periods after insert or update of status, assignee_id on public.tasks
 for each row execute function mavi_private.track_task_status_periods();

-- ------------------------------------------------------------ query engine
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
  -- Tasks, status history and validations all read the task (t.).
  on_task boolean := src in ('tasks', 'status_history', 'reviews');
  executor constant text := 'coalesce(t.executor_id, t.assignee_id)';
  validator constant text := 'coalesce(p.ended_by, p.user_id)';
  dur constant text := 'extract(epoch from (coalesce(p.ended_at, now()) - p.started_at))';
  delivered_day text;
  rework constant text := 'exists (select 1 from public.task_status_periods x where x.task_id = t.id'
   ' and (x.status in (''rejected'', ''correction'') or x.from_status = ''done''))';
begin
  select timezone into tz from public.companies where id = c;
  if tz is null then raise exception 'Empresa não encontrada'; end if;
  late := format('((t.status <> ''done'' and t.due_date < (now() at time zone %1$L)::date)'
   ' or (t.delivered_at is not null and (t.delivered_at at time zone %1$L)::date > t.due_date))', tz);
  delivered_day := format('(t.delivered_at at time zone %L)::date', tz);

  if src = 'tasks' then
    base := 'public.tasks t';
    conds := array[format('t.company_id = %L', c), 'not t.archived'];
    person := 't.assignee_id';
    datef := coalesce(q->>'dateField', 'created_at');
    if datef = 'created_at' then col := 't.created_at';
    elsif datef = 'delivered_at' then col := 't.delivered_at';
    elsif datef = 'due_date' then col := 't.due_date'; is_ts := false;
    else raise exception 'Campo de data inválido: %', datef using errcode = '22023';
    end if;
    m := case metric
      when 'count' then 'count(*)'
      when 'estimated_hours' then 'coalesce(sum(t.estimated_minutes), 0) / 60.0'
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
    end;
    if metric in ('lead_time_days', 'on_time_rate', 'on_time_original_rate', 'delay_days', 'first_pass_rate',
     'rework_per_task') then
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
    person := 'p.user_id';
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
       ' where x.plan_id = p.id and x.decision = ''approved'') = 8) a join public.contracts k on k.id = a.contract_id';
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
    if fld = 'late' and src = 'tasks' then
      conds := conds || case when (vals[1] = 'true') = (op = 'in') then late else format('not %s', late) end;
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
      when fld = 'executor' and src = 'tasks' then executor
      when fld = 'previous' and src = 'status_history' then 'p.previous_user_id'
      when fld = 'validator' and src = 'reviews' then validator
    end;
    if colf is null then raise exception 'Filtro inválido para esta fonte: %', fld using errcode = '22023'; end if;
    typed := format(case when fld in ('status', 'priority', 'entry_source') then '%L::text[]' else '%L::uuid[]' end, vals);
    conds := conds || format(case when op = 'in' then '%1$s = any(%2$s)' else '(%1$s is null or %1$s <> all(%2$s))' end,
     colf, typed);
  end loop;

  -- Joins only when something reads the task (t.) or its contract (k.):
  -- hours by day or by person never touch tasks.
  key := case
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
    when p_group = 'executor' and src = 'tasks' then executor
    when p_group = 'previous' and src = 'status_history' then 'p.previous_user_id'
    when p_group = 'validator' and src = 'reviews' then validator
  end;
  if src = 'hours' and (strpos(array_to_string(conds, ' ') || ' ' || coalesce(key, ''), 't.') > 0
   or strpos(array_to_string(conds, ' ') || ' ' || coalesce(key, ''), 'k.') > 0) then
    base := base || ' join public.tasks t on t.id = e.task_id';
  end if;
  if src <> 'social_leads' and strpos(array_to_string(conds, ' ') || ' ' || coalesce(key, ''), 'k.') > 0 then
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
    when p_group = 'client' then '(select x.name from public.clients x where x.id = r.k)'
    when p_group = 'product' then '(select x.name from public.products x where x.id = r.k)'
    when p_group = 'project' then '(select x.name from public.projects x where x.id = r.k)'
    when p_group = 'team' then '(select x.name from public.teams x where x.id = r.k)'
    when p_group in ('person', 'creator', 'executor', 'previous', 'validator') then
      format('(select x.name from public.memberships x where x.company_id = %L and x.user_id = r.k)', c)
    when p_group = 'stage' then 'case r.k::text when ''briefing'' then ''Briefing'' when ''plan'' then ''Plano para revisar'''
     ' when ''approval'' then ''Aguardando o cliente'' when ''production'' then ''Aprovado / produção'''
     ' when ''campaign'' then ''Campanha no ar'' else r.k::text end'
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

create or replace function mavi_private.dashboard_check(c uuid, p_panels jsonb, p_variables jsonb) returns void
language plpgsql stable security definer set search_path = '' as $$
declare p jsonb; q jsonb; spec jsonb; ids text[] := '{}'; refs text[]; expr text; begin
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
      'executor', 'previous', 'validator') then
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
    refs := '{}';
    for q in select value from jsonb_array_elements(spec->'queries') loop
      if coalesce(q->>'ref', '') !~ '^[A-E]$' or q->>'ref' = any(refs) then
        raise exception 'Consulta inválida' using errcode = '22023';
      end if;
      refs := refs || (q->>'ref');
      perform mavi_private.dashboard_sql(c, q, coalesce(spec->>'groupBy', 'none'), 'month',
       current_date, current_date, coalesce(p_variables->'filters', '{}'::jsonb), 10);
    end loop;
  end loop;
end $$;
revoke all on function mavi_private.dashboard_check(uuid, jsonb, jsonb) from public, anon, authenticated;

commit;
