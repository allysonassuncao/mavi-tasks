begin;

-- Prazos, Fase 4: quem entrega antes, risco de atraso, replanejamento e o
-- acerto das sugestões nos Dashboards.
--
-- * Horas que faltam numa tarefa: o estimado menos o já lançado (nunca
--   menos de zero). Horas livres de uma pessoa num dia: a jornada dela menos
--   as reuniões da agenda (Fase 3), nos dias em que trabalha (Fase 2).
-- * Quem entrega antes (smart_due_candidates): para cada pessoa das equipes
--   que atendem o cliente, a data da MAVI (ou da regra), a carga em aberto e
--   se está fora hoje.
-- * Risco de atraso: uma tarefa em aberto corre risco quando o que falta
--   dela, somado ao que a pessoa tem vencendo antes (com prioridade igual ou
--   maior), passa das horas livres até o prazo. Uma rotina diária (8 h)
--   guarda o risco em task_due_risks e avisa o responsável e quem criou,
--   uma vez por prazo; a tarefa mostra na hora (task_due_risk).
-- * Replanejamento (replan_proposal/apply_replan): para as tarefas de uma
--   pessoa que correm risco ou vencem num dia em que ela não trabalha, a
--   MAVI propõe passar para quem da equipe dá conta no prazo ou, sem
--   ninguém, o primeiro prazo em que cabe. Um gestor revisa e aplica.
-- * Dashboards (Tarefas): entregas até a data da MAVI e até a da regra (%),
--   erro médio da MAVI (dias), prazos apertados e prazos mais curtos que a
--   sugestão da MAVI.

-- ------------------------------------------------------------ horas
create function mavi_private.task_remaining_minutes(t public.tasks) returns integer
language sql stable security definer set search_path = '' as $$
 select greatest(t.estimated_minutes - coalesce((select sum(extract(epoch from (e.ended_at - e.started_at)) / 60)
  from public.time_entries e where e.task_id = t.id and e.ended_at is not null), 0), 0)::integer
$$;

-- O que a pessoa tem em aberto vencendo até `p_until`, com prioridade igual
-- ou maior que `p_rank`.
create function mavi_private.person_need_minutes(c uuid, u uuid, p_until date, p_rank integer, p_exclude uuid)
 returns integer
language sql stable security definer set search_path = '' as $$
 select coalesce(sum(mavi_private.task_remaining_minutes(t)), 0)::integer from public.tasks t
 where t.company_id = c and t.assignee_id = u and t.status <> 'done' and not t.archived
  and t.id is distinct from p_exclude and t.due_date <= p_until
  and mavi_private.priority_rank(t.priority) >= p_rank
$$;

-- Horas livres (minutos) de `p_from` a `p_to`, nos dias em que a pessoa trabalha.
create function mavi_private.person_free_minutes(c uuid, u uuid, p_from date, p_to date) returns integer
language plpgsql stable security definer set search_path = '' as $$
declare d date := p_from; total integer := 0; daily integer; busy integer; begin
 daily := coalesce((select m.work_minutes from public.memberships m where m.company_id = c and m.user_id = u),
  (select work_minutes from public.companies where id = c), 480);
 while d <= p_to and d <= p_from + 400 loop
  if mavi_private.is_person_business_day(c, u, d) then
   select coalesce((select b.minutes from mavi_private.person_busy_days b where b.user_id = u and b.day = d), 0)
    into busy;
   total := total + greatest(daily - busy, 0);
  end if;
  d := d + 1;
 end loop;
 return total;
end $$;
revoke all on function mavi_private.task_remaining_minutes(public.tasks),
 mavi_private.person_need_minutes(uuid, uuid, date, integer, uuid),
 mavi_private.person_free_minutes(uuid, uuid, date, date) from public, anon, authenticated;

-- ------------------------------------------------------------ quem entrega antes
create function public.smart_due_candidates(p_company uuid, p_contract uuid, p_project uuid, p_start date,
 p_approval boolean, p_priority text, p_estimated integer) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare k public.contracts; mode text; u record; s jsonb; r public.task_due_rules; rule_due date;
 base date; today date; out jsonb := '[]'; begin
 if not mavi_private.member(p_company) or not mavi_private.contract_access(p_company, p_contract) then
  raise exception 'Sem acesso ao produto contratado' using errcode = '42501';
 end if;
 select * into k from public.contracts where company_id = p_company and id = p_contract;
 select smart_due into mode from public.companies where id = p_company;
 today := mavi_private.company_today(p_company);
 base := coalesce(p_start, today);
 for u in select distinct m.user_id, m.name from public.client_teams ct
   join public.team_members tm on tm.company_id = ct.company_id and tm.team_id = ct.team_id
   join public.memberships m on m.company_id = tm.company_id and m.user_id = tm.user_id and m.active
   where ct.company_id = p_company and ct.client_id = k.client_id
   order by m.name limit 20 loop
  s := case when mode <> 'off' then mavi_private.smart_due_calc(p_company, p_contract, p_project, null, u.user_id,
   base, coalesce(p_approval, false), coalesce(p_priority, 'normal'), p_estimated) end;
  r := mavi_private.due_rule_for(p_company, p_contract, p_project, null, u.user_id);
  rule_due := null;
  if r.id is not null then
   select d.due into rule_due from mavi_private.rule_due_dates(p_company, r, base, coalesce(p_approval, false), u.user_id) d;
  end if;
  out := out || jsonb_build_object('user_id', u.user_id, 'name', u.name,
   'due', coalesce(case when (s->>'available')::boolean then (s->>'due')::date end, rule_due),
   'source', case when (s->>'available')::boolean then 'smart' when rule_due is not null then 'rule' end,
   'open_minutes', mavi_private.person_need_minutes(p_company, u.user_id, today + 3650, 1, null),
   'away_today', exists(select 1 from public.member_absences a where a.company_id = p_company
    and a.user_id = u.user_id and today between a.starts_on and a.ends_on));
 end loop;
 return (select coalesce(jsonb_agg(x order by (x->>'due') nulls last, (x->>'open_minutes')::integer, x->>'name'), '[]')
  from jsonb_array_elements(out) x);
end $$;
revoke all on function public.smart_due_candidates(uuid, uuid, uuid, date, boolean, text, integer) from public, anon;
grant execute on function public.smart_due_candidates(uuid, uuid, uuid, date, boolean, text, integer) to authenticated;

-- ------------------------------------------------------------ risco
-- {risky, own, ahead, need, free, due}: `ahead` é o que vence antes (ou no
-- mesmo dia) com prioridade igual ou maior; `free`, as horas livres de hoje
-- até o prazo. Sem estimativa na tarefa, o risco é não sobrar nenhuma hora.
create function mavi_private.task_risk(t public.tasks) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare today date; own integer; ahead integer; free integer; begin
 today := mavi_private.company_today(t.company_id);
 if t.status = 'done' or t.archived or t.due_date < today then return null; end if;
 own := mavi_private.task_remaining_minutes(t);
 ahead := mavi_private.person_need_minutes(t.company_id, t.assignee_id, t.due_date,
  mavi_private.priority_rank(t.priority), t.id);
 free := mavi_private.person_free_minutes(t.company_id, t.assignee_id, today, t.due_date);
 return jsonb_build_object('risky', own + ahead > 0 and (own + ahead > free or (own = 0 and ahead >= free)),
  'own', own, 'ahead', ahead, 'need', own + ahead, 'free', free, 'due', t.due_date);
end $$;
revoke all on function mavi_private.task_risk(public.tasks) from public, anon, authenticated;

-- A tarefa aberta, na hora (para quem a vê).
create function public.task_due_risk(p_task uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare t public.tasks; begin
 select * into t from public.tasks where id = p_task;
 if not found or not mavi_private.task_access(t.company_id, t.id) then
  raise exception 'Sem acesso à tarefa' using errcode = '42501';
 end if;
 return mavi_private.task_risk(t);
end $$;
revoke all on function public.task_due_risk(uuid) from public, anon;
grant execute on function public.task_due_risk(uuid) to authenticated;

-- O último cálculo da rotina e o prazo já avisado (um aviso por prazo).
create table public.task_due_risks (
 task_id uuid primary key,
 company_id uuid not null,
 need_minutes integer not null,
 free_minutes integer not null,
 computed_at timestamptz not null default now(),
 notified_due date,
 foreign key (company_id, task_id) references public.tasks(company_id, id) on delete cascade
);
create index task_due_risks_company on public.task_due_risks(company_id);
alter table public.task_due_risks enable row level security;
revoke all on public.task_due_risks from public, anon, authenticated;
grant select on public.task_due_risks to authenticated;
create policy task_due_risks_read on public.task_due_risks for select to authenticated
 using (mavi_private.task_access(company_id, task_id));

alter table public.notifications drop constraint notifications_kind_check;
alter table public.notifications add constraint notifications_kind_check
 check (kind in ('mention', 'assigned', 'reply', 'social_leads', 'ai_share', 'success_case', 'notice',
  'notice_animation', 'temperature', 'tasks_assigned', 'due_risk'));
alter table public.notifications drop constraint notifications_target_check;
alter table public.notifications add constraint notifications_target_check
 check ((kind in ('social_leads', 'ai_share', 'success_case', 'notice', 'notice_animation', 'temperature',
   'tasks_assigned', 'due_risk')) = (task_id is null)
  and (task_id is not null or (title is not null and link is not null))
  and ((kind = 'notice') = (notice_id is not null)));

-- Rotina diária: as tarefas que vencem nos próximos 20 dias. Quem corre
-- risco fica em task_due_risks; quem deixou de correr sai de lá.
create function mavi_private.run_due_risks() returns integer
language plpgsql security definer set search_path = '' as $$
declare t public.tasks; r jsonb; old public.task_due_risks; warned integer := 0; h text; begin
 for t in select tk.* from public.tasks tk join public.companies co on co.id = tk.company_id
  where tk.status <> 'done' and not tk.archived
   and tk.due_date between (now() at time zone co.timezone)::date and (now() at time zone co.timezone)::date + 20
   and exists(select 1 from public.memberships m where m.company_id = tk.company_id and m.user_id = tk.assignee_id and m.active)
 loop
  r := mavi_private.task_risk(t);
  select * into old from public.task_due_risks where task_id = t.id;
  if r is null or not (r->>'risky')::boolean then
   if old.task_id is not null then delete from public.task_due_risks where task_id = t.id; end if;
   continue;
  end if;
  insert into public.task_due_risks(task_id, company_id, need_minutes, free_minutes, computed_at, notified_due)
  values (t.id, t.company_id, (r->>'need')::integer, (r->>'free')::integer, now(), old.notified_due)
  on conflict (task_id) do update set need_minutes = excluded.need_minutes, free_minutes = excluded.free_minutes,
   computed_at = now();
  if old.notified_due is distinct from t.due_date then
   h := to_char(round((r->>'need')::numeric / 60, 1), 'FM999990.0');
   insert into public.notifications(company_id, user_id, actor_id, task_id, kind, title, body, link)
   select t.company_id, x.u, x.u, null, 'due_risk', left('“' || t.title || '” pode atrasar', 240),
    'Até ' || to_char(t.due_date, 'DD/MM') || ' há ' || to_char(round((r->>'free')::numeric / 60, 1), 'FM999990.0')
     || ' h livres para ' || replace(h, '.', ',') || ' h de trabalho (esta tarefa e o que vence antes). Veja se dá para replanejar.',
    '/tarefas/' || t.id
   from (select distinct unnest(array[t.assignee_id, t.creator_id]) u) x
   where exists(select 1 from public.memberships m where m.company_id = t.company_id and m.user_id = x.u and m.active);
   update public.task_due_risks set notified_due = t.due_date where task_id = t.id;
   warned := warned + 1;
  end if;
 end loop;
 -- Tarefas que saíram da janela (entregues, arquivadas, vencidas).
 delete from public.task_due_risks d using public.tasks tk
  where tk.id = d.task_id and (tk.status = 'done' or tk.archived);
 return warned;
end $$;
revoke all on function mavi_private.run_due_risks() from public, anon, authenticated;

-- ------------------------------------------------------------ replanejamento
-- Quem da equipe (que atende o cliente) dá conta desta tarefa até o prazo:
-- o que tem vencendo até lá mais o que falta dela cabe nas horas livres. A
-- de mais folga; null se ninguém.
create function mavi_private.replan_helper(t public.tasks, p_own integer) returns jsonb
language sql stable security definer set search_path = '' as $$
 select jsonb_build_object('user_id', x.user_id, 'name', x.name, 'slack', x.slack) from (
  select m.user_id, m.name,
   mavi_private.person_free_minutes(t.company_id, m.user_id, mavi_private.company_today(t.company_id), t.due_date)
   - mavi_private.person_need_minutes(t.company_id, m.user_id, t.due_date, mavi_private.priority_rank(t.priority), null)
   - p_own as slack
  from public.contracts k
  join public.client_teams ct on ct.company_id = k.company_id and ct.client_id = k.client_id
  join public.team_members tm on tm.company_id = ct.company_id and tm.team_id = ct.team_id
  join public.memberships m on m.company_id = tm.company_id and m.user_id = tm.user_id and m.active
  where k.company_id = t.company_id and k.id = t.contract_id and m.user_id <> t.assignee_id
   and not mavi_private.person_off(t.company_id, m.user_id, mavi_private.company_today(t.company_id))
   and not mavi_private.person_off(t.company_id, m.user_id, t.due_date)
  group by m.user_id, m.name) x
 where x.slack >= 0
 order by x.slack desc, x.name limit 1
$$;
revoke all on function mavi_private.replan_helper(public.tasks, integer) from public, anon, authenticated;

-- As tarefas de uma pessoa que precisam de outro plano (nos próximos 60
-- dias): em risco ou vencendo num dia em que ela não trabalha. Para cada
-- uma, a proposta (passar para alguém ou adiar) e a outra opção.
create function public.replan_proposal(p_company uuid, p_user uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare t public.tasks; today date; r jsonb; off boolean; own integer; helper jsonb; push date;
 out jsonb := '[]'; begin
 if not mavi_private.can_manage_person(p_company, p_user) then
  raise exception 'Gestores replanejam só as tarefas das pessoas das suas equipes' using errcode = '42501';
 end if;
 today := mavi_private.company_today(p_company);
 for t in select * from public.tasks where company_id = p_company and assignee_id = p_user and status <> 'done'
  and not archived and due_date between today and today + 60 order by due_date, created_at limit 100 loop
  r := mavi_private.task_risk(t);
  off := mavi_private.person_off(p_company, p_user, t.due_date);
  continue when not off and not coalesce((r->>'risky')::boolean, false);
  own := (r->>'own')::integer;
  helper := mavi_private.replan_helper(t, own);
  -- O primeiro dia de trabalho da pessoa em que tudo cabe (até 60 dias úteis).
  push := mavi_private.next_person_business_day(p_company, p_user, t.due_date);
  for i in 1..60 loop
   exit when mavi_private.person_need_minutes(p_company, p_user, push, mavi_private.priority_rank(t.priority), t.id) + own
    <= mavi_private.person_free_minutes(p_company, p_user, today, push);
   push := mavi_private.add_person_business_days(p_company, p_user, push, 1);
  end loop;
  out := out || jsonb_build_object('task_id', t.id, 'title', t.title, 'contract_id', t.contract_id,
   'due', t.due_date, 'priority', t.priority, 'own_minutes', own, 'need_minutes', (r->>'need')::integer,
   'free_minutes', (r->>'free')::integer, 'reason', case when off then 'off' else 'risk' end,
   'helper', helper, 'push_due', push,
   'proposal', case when helper is not null then jsonb_build_object('assignee', helper->>'user_id', 'due', t.due_date)
    else jsonb_build_object('assignee', p_user, 'due', push) end);
 end loop;
 return out;
end $$;
revoke all on function public.replan_proposal(uuid, uuid) from public, anon;
grant execute on function public.replan_proposal(uuid, uuid) to authenticated;

-- Aplica o que o gestor aprovou: [{task, assignee, due}]. Cada tarefa passa
-- pelas regras de sempre (quem pode mover, quem pode mudar o prazo); a que
-- não pode fica de fora com o motivo.
create function public.apply_replan(p_company uuid, p_items jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare i jsonb; t public.tasks; who uuid; due date; reason text; results jsonb := '[]'; applied integer := 0; begin
 if not mavi_private.leader(p_company) then
  raise exception 'Só gestores e administradores aplicam um replanejamento' using errcode = '42501';
 end if;
 if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) > 100 then
  raise exception 'Replaneje até 100 tarefas por vez';
 end if;
 for i in select * from jsonb_array_elements(p_items) loop
  reason := null;
  select * into t from public.tasks where company_id = p_company and id = (i->>'task')::uuid;
  if not found or t.archived or t.status = 'done' then
   results := results || jsonb_build_object('task_id', i->>'task', 'ok', false, 'reason', 'Tarefa não encontrada ou já entregue');
   continue;
  end if;
  who := nullif(i->>'assignee', '')::uuid;
  due := nullif(i->>'due', '')::date;
  begin
   if not mavi_private.can_manage_person(p_company, t.assignee_id) then
    raise exception 'Fora das suas equipes';
   end if;
   if who is not null and who <> t.assignee_id then
    perform public.transition_task(t.id, t.version, 'move', '', t.status, who);
    select * into t from public.tasks where id = t.id;
   end if;
   if due is not null and due <> t.due_date then
    if t.start_date is not null and due < t.start_date then raise exception 'O prazo ficaria antes do início'; end if;
    update public.tasks set due_date = due, due_manual = true, due_rule_id = null, version = version + 1 where id = t.id;
    insert into public.task_events(company_id, task_id, actor_id, action, detail)
    values (p_company, t.id, auth.uid(), 'due_changed',
     jsonb_build_object('old_due', t.due_date, 'new_due', due, 'replan', true));
   end if;
   applied := applied + 1;
  exception when others then
   reason := sqlerrm;
  end;
  results := results || jsonb_build_object('task_id', t.id, 'ok', reason is null, 'reason', reason);
 end loop;
 return jsonb_build_object('applied', applied, 'results', results);
end $$;
revoke all on function public.apply_replan(uuid, jsonb) from public, anon;
grant execute on function public.apply_replan(uuid, jsonb) to authenticated;

-- ------------------------------------------------------------ Dashboards
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
  -- Temperatura (migration 20261110090000): the bands that warn, by index.
  bands jsonb;
  alert_bands integer[];
  ind text;
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
    when p_group = 'executor' and src = 'tasks' then executor
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
  if src = 'temperature' and p_group = 'team' then
    base := base || ' join public.client_teams ctg on ctg.company_id = d.company_id and ctg.client_id = d.client_id';
  end if;
  if src = 'temperature' and p_group = 'product' then
    base := base || ' join (select distinct x.company_id, x.client_id, x.product_id from public.contracts x'
     ' where not x.archived) kpg on kpg.company_id = d.company_id and kpg.client_id = d.client_id';
  end if;
  if src not in ('social_leads', 'notices', 'temperature')
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
-- Hosted Supabase runs the risk check every day at 8 h (Brasília); the
-- embedded PostgreSQL used in tests has no pg_cron.
do $$ begin
 if exists(select 1 from pg_available_extensions where name = 'pg_cron') then
  create extension if not exists pg_cron;
  perform cron.schedule('mavi-due-risks', '0 11 * * *', 'select mavi_private.run_due_risks()');
 else
  raise notice 'pg_cron unavailable: schedule mavi_private.run_due_risks() on the hosted database';
 end if;
end $$;

commit;
