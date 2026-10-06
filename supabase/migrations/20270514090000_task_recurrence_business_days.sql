-- Repetição: a distância entre a abertura e o prazo (e o início planejado)
-- passa a contar dias úteis do calendário da empresa. Uma tarefa criada na
-- terça com prazo na quinta (2 dias úteis) repete na quinta com prazo na
-- segunda, não no sábado. Vale também para as séries que já existem.
-- Sem mudança nas cópias de prazo pela regra (a regra já conta dias úteis).
begin;

-- Dias úteis da empresa em (a, b]; negativo quando b vem antes de a (os de
-- [b, a)). É o inverso de mavi_private.add_company_business_days.
create function mavi_private.count_company_business_days(c uuid, a date, b date) returns integer
language sql stable security definer set search_path = '' as $$
 select case when b >= a
  then (select count(*)::integer from generate_series(a + 1, b, interval '1 day') d
   where mavi_private.is_business_day(c, d::date))
  else -(select count(*)::integer from generate_series(b, a - 1, interval '1 day') d
   where mavi_private.is_business_day(c, d::date)) end
$$;
revoke all on function mavi_private.count_company_business_days(uuid, date, date) from public, anon, authenticated;

alter table public.task_recurrences add column due_business_days integer,
 add column start_business_days integer;
update public.task_recurrences set
 due_business_days = mavi_private.count_company_business_days(company_id, anchor, anchor + due_offset),
 start_business_days = case when start_offset is not null
  then mavi_private.count_company_business_days(company_id, anchor, anchor + start_offset) end;
alter table public.task_recurrences alter column due_business_days set not null,
 alter column due_business_days set default 0,
 add constraint task_recurrences_due_business_days check (due_business_days >= 0);

create or replace function mavi_private.start_recurrence(p_task uuid, p_frequency text, p_by_team boolean) returns uuid
language plpgsql security definer set search_path = '' as $$
declare t public.tasks; today date; result uuid; begin
 if p_frequency not in ('daily','weekdays','weekly','biweekly','monthly') then
  raise exception 'Escolha como a tarefa se repete';
 end if;
 select * into t from public.tasks where id = p_task;
 today := mavi_private.company_today(t.company_id);
 insert into public.task_recurrences(company_id, source_task_id, creator_id, frequency, anchor, next_run,
  contract_id, project_id, team_id, parent_id, assignee_id, title, description, priority, estimated_minutes,
  requires_client_approval, custom_fields, due_offset, start_offset, due_by_rule,
  due_business_days, start_business_days)
 values (t.company_id, t.id, t.creator_id, p_frequency, today, mavi_private.next_recurrence(p_frequency, today, today),
  t.contract_id, t.project_id, t.team_id, t.parent_id, case when p_by_team then null else t.assignee_id end,
  t.title, mavi_private.description_for_copies(t.description), t.priority, t.estimated_minutes,
  t.requires_client_approval, t.custom_fields, greatest(t.due_date - today, 0), t.start_date - today, not t.due_manual,
  greatest(mavi_private.count_company_business_days(t.company_id, today, t.due_date), 0),
  case when t.start_date is not null then mavi_private.count_company_business_days(t.company_id, today, t.start_date) end)
 returning id into result;
 update public.tasks set recurrence_id = result where id = t.id;
 insert into public.task_events(company_id, task_id, actor_id, action, detail)
  values (t.company_id, t.id, t.creator_id, 'recurrence_started', jsonb_build_object('frequency', p_frequency));
 return result;
end $$;

create or replace function mavi_private.open_recurrence_copy(r public.task_recurrences, today date) returns uuid
language plpgsql security definer set search_path = '' as $$
declare assignee uuid; result uuid; parent uuid; ch record; start date; begin
 if exists(select 1 from public.contracts k where k.company_id = r.company_id and k.id = r.contract_id and k.archived) then
  raise exception 'O produto contratado está arquivado';
 end if;
 if r.assignee_id is null then
  perform 1 from public.teams where company_id = r.company_id and id = r.team_id for update;
  assignee := mavi_private.team_assignee(r.company_id, r.team_id);
  if assignee is null then raise exception 'A equipe não tem ninguém ativo para receber a tarefa'; end if;
 else
  -- Someone who left: the copy goes to whoever set up the repetition.
  select m.user_id into assignee from public.memberships m
   where m.company_id = r.company_id and m.active and m.user_id in (r.assignee_id, r.creator_id)
   order by m.user_id = r.assignee_id desc limit 1;
  if assignee is null then raise exception 'Responsável e criador não estão mais ativos'; end if;
 end if;
 select id into parent from public.tasks
  where company_id = r.company_id and contract_id = r.contract_id and id = r.parent_id and not archived;
 start := case when r.start_business_days is not null
  then mavi_private.add_company_business_days(r.company_id, today, r.start_business_days) end;
 -- Sem regra que valha hoje, os mesmos dias úteis de distância.
 select * into ch from mavi_private.choose_due(r.company_id, r.contract_id, r.project_id, r.team_id, assignee,
  coalesce(start, today), r.requires_client_approval,
  mavi_private.add_company_business_days(r.company_id, today, r.due_business_days), not r.due_by_rule, null, false);
 insert into public.tasks(company_id, contract_id, title, assignee_id, creator_id, due_date, original_due_date,
  project_id, team_id, description, priority, estimated_minutes, requires_client_approval, parent_id, start_date,
  custom_fields, recurrence_id, due_manual, due_rule_id)
 values (r.company_id, r.contract_id, r.title, assignee, r.creator_id, ch.due, ch.due,
  r.project_id, r.team_id, r.description, r.priority, r.estimated_minutes, r.requires_client_approval, parent,
  start, r.custom_fields, r.id, ch.manual, ch.rule_id)
 returning id into result;
 insert into public.task_events(company_id, task_id, actor_id, action, detail)
  values (r.company_id, result, r.creator_id, 'created', jsonb_build_object('recurrence', r.frequency));
 return result;
end $$;

commit;
