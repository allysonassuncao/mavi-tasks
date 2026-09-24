begin;

-- "Programar repetição": a new task can repeat every day, every weekday,
-- weekly, every two weeks or monthly. The rule keeps a copy of the task as
-- created; on each date the database opens a new task from it (same title,
-- description, fields, product, project, team…), with the same distance
-- between opening and due date. A task sent to a team is handed out again
-- each time (see mavi_private.team_assignee). Repeats until someone stops it.
-- Attachments are not copied, nor images inside the description.
create table public.task_recurrences (
 id uuid primary key default gen_random_uuid(),
 company_id uuid not null references public.companies(id),
 source_task_id uuid not null,
 creator_id uuid not null,
 frequency text not null check (frequency in ('daily','weekdays','weekly','biweekly','monthly')),
 -- The day the series started; weekly/biweekly/monthly dates count from it.
 anchor date not null,
 next_run date not null,
 contract_id uuid not null,
 project_id uuid,
 team_id uuid,
 parent_id uuid,
 -- Null when the task goes to the team (handed out on each copy).
 assignee_id uuid,
 title text not null,
 description text not null default '',
 priority text not null,
 estimated_minutes integer not null default 0,
 requires_client_approval boolean not null default false,
 custom_fields jsonb not null default '[]',
 due_offset integer not null default 0 check (due_offset >= 0),
 start_offset integer,
 copies integer not null default 0,
 last_error text,
 active boolean not null default true,
 stopped_by uuid,
 stopped_at timestamptz,
 created_at timestamptz not null default now(),
 unique (company_id, id),
 foreign key (company_id, source_task_id) references public.tasks(company_id, id),
 foreign key (company_id, creator_id) references public.memberships(company_id, user_id),
 foreign key (company_id, contract_id) references public.contracts(company_id, id),
 foreign key (company_id, team_id) references public.teams(company_id, id),
 check (assignee_id is not null or team_id is not null)
);
create index task_recurrences_due on public.task_recurrences(next_run) where active;

alter table public.tasks add column recurrence_id uuid;
alter table public.tasks add constraint tasks_recurrence_fk
 foreign key (company_id, recurrence_id) references public.task_recurrences(company_id, id);
create index tasks_recurrence on public.tasks(company_id, recurrence_id) where recurrence_id is not null;

-- Who sees a rule: leaders, whoever created it and whoever sees one of its
-- tasks (the tasks policy decides). Changes go through the functions below.
alter table public.task_recurrences enable row level security;
revoke all on public.task_recurrences from public, anon, authenticated;
grant select on public.task_recurrences to authenticated;
create policy task_recurrences_read on public.task_recurrences for select to authenticated using (
 company_id in (select mavi_private.active_companies()) and (
  company_id in (select mavi_private.leader_companies())
  or creator_id = (select auth.uid())
  or id in (select t.recurrence_id from public.tasks t where t.recurrence_id is not null)));

-- The first date of the series after `after`.
create function mavi_private.next_recurrence(p_frequency text, p_anchor date, p_after date) returns date
language plpgsql immutable set search_path = '' as $$
declare d date; n integer; begin
 if p_frequency = 'daily' then return p_after + 1; end if;
 if p_frequency = 'weekdays' then
  d := p_after + 1;
  while extract(isodow from d) in (6, 7) loop d := d + 1; end loop;
  return d;
 end if;
 if p_frequency in ('weekly', 'biweekly') then
  n := case p_frequency when 'weekly' then 7 else 14 end;
  return p_anchor + n * (greatest(floor((p_after - p_anchor)::numeric / n), -1)::integer + 1);
 end if;
 -- Monthly: the anchor's day, or the month's last day when it is shorter.
 n := greatest(0, (extract(year from p_after)::integer - extract(year from p_anchor)::integer) * 12
  + extract(month from p_after)::integer - extract(month from p_anchor)::integer - 1);
 loop
  d := (p_anchor + make_interval(months => n))::date;
  exit when d > p_after;
  n := n + 1;
 end loop;
 return d;
end $$;

-- A rich-text description without its inline images (they belong to the
-- task they were sent with, so copies can't show them).
create function mavi_private.without_inline_images(doc jsonb) returns jsonb
language sql immutable set search_path = '' as $$
 select case when jsonb_typeof(doc) = 'object' then (
  select coalesce(jsonb_object_agg(k, case when k = 'content' and jsonb_typeof(v) = 'array' then (
   select coalesce(jsonb_agg(mavi_private.without_inline_images(e) order by n), '[]')
   from jsonb_array_elements(v) with ordinality as x(e, n)
   where e->>'type' is distinct from 'inlineImage') else v end), '{}')
  from jsonb_each(doc) as j(k, v))
 else doc end
$$;
create function mavi_private.description_for_copies(body text) returns text
language sql immutable set search_path = '' as $$
 select case when left(body, 17) = 'mavi:richtext:v1:'
  then 'mavi:richtext:v1:' || mavi_private.without_inline_images(substring(body from 18)::jsonb)::text
  else body end
$$;
revoke all on function mavi_private.next_recurrence(text, date, date), mavi_private.without_inline_images(jsonb),
 mavi_private.description_for_copies(text) from public, anon, authenticated;

-- Starts a series from a task just created (called by create_task).
create function mavi_private.start_recurrence(p_task uuid, p_frequency text, p_by_team boolean) returns uuid
language plpgsql security definer set search_path = '' as $$
declare t public.tasks; today date; result uuid; begin
 if p_frequency not in ('daily','weekdays','weekly','biweekly','monthly') then
  raise exception 'Escolha como a tarefa se repete';
 end if;
 select * into t from public.tasks where id = p_task;
 today := mavi_private.company_today(t.company_id);
 insert into public.task_recurrences(company_id, source_task_id, creator_id, frequency, anchor, next_run,
  contract_id, project_id, team_id, parent_id, assignee_id, title, description, priority, estimated_minutes,
  requires_client_approval, custom_fields, due_offset, start_offset)
 values (t.company_id, t.id, t.creator_id, p_frequency, today, mavi_private.next_recurrence(p_frequency, today, today),
  t.contract_id, t.project_id, t.team_id, t.parent_id, case when p_by_team then null else t.assignee_id end,
  t.title, mavi_private.description_for_copies(t.description), t.priority, t.estimated_minutes,
  t.requires_client_approval, t.custom_fields, greatest(t.due_date - today, 0), t.start_date - today)
 returning id into result;
 update public.tasks set recurrence_id = result where id = t.id;
 insert into public.task_events(company_id, task_id, actor_id, action, detail)
  values (t.company_id, t.id, t.creator_id, 'recurrence_started', jsonb_build_object('frequency', p_frequency));
 return result;
end $$;
revoke all on function mavi_private.start_recurrence(uuid, text, boolean) from public, anon, authenticated;

-- Opens the copy of one rule for `today`. Raises when it can't (the caller
-- records why and tries again on the next run).
create function mavi_private.open_recurrence_copy(r public.task_recurrences, today date) returns uuid
language plpgsql security definer set search_path = '' as $$
declare assignee uuid; result uuid; parent uuid; begin
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
 insert into public.tasks(company_id, contract_id, title, assignee_id, creator_id, due_date, original_due_date,
  project_id, team_id, description, priority, estimated_minutes, requires_client_approval, parent_id, start_date,
  custom_fields, recurrence_id)
 values (r.company_id, r.contract_id, r.title, assignee, r.creator_id, today + r.due_offset, today + r.due_offset,
  r.project_id, r.team_id, r.description, r.priority, r.estimated_minutes, r.requires_client_approval, parent,
  today + r.start_offset, r.custom_fields, r.id)
 returning id into result;
 insert into public.task_events(company_id, task_id, actor_id, action, detail)
  values (r.company_id, result, r.creator_id, 'created', jsonb_build_object('recurrence', r.frequency));
 return result;
end $$;
revoke all on function mavi_private.open_recurrence_copy(public.task_recurrences, date) from public, anon, authenticated;

-- Run by pg_cron: opens today's copies. A series that missed dates (the job
-- was off) opens a single copy and moves on to its next date. One that can't
-- open (e.g. an archived client) keeps its date and the reason, and is tried
-- again on the next run.
create function mavi_private.run_task_recurrences(p_today date default null) returns integer
language plpgsql security definer set search_path = '' as $$
declare r public.task_recurrences; today date; opened integer := 0; begin
 for r in select * from public.task_recurrences where active
  -- No company's "today" is past tomorrow in UTC.
  and next_run <= coalesce(p_today, (now() at time zone 'UTC')::date + 1)
  order by next_run, id for update skip locked loop
  today := coalesce(p_today, mavi_private.company_today(r.company_id));
  continue when r.next_run > today;
  begin
   perform mavi_private.open_recurrence_copy(r, today);
   update public.task_recurrences set copies = copies + 1, last_error = null,
    next_run = mavi_private.next_recurrence(frequency, anchor, today) where id = r.id;
   opened := opened + 1;
  exception when others then
   update public.task_recurrences set last_error = sqlerrm where id = r.id;
  end;
 end loop;
 return opened;
end $$;
revoke all on function mavi_private.run_task_recurrences(date) from public, anon, authenticated;

-- Stops a series; the tasks already opened stay as they are.
create function public.stop_task_recurrence(p_task uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare t public.tasks; r public.task_recurrences; begin
 select * into t from public.tasks where id = p_task;
 if not found or t.recurrence_id is null then raise exception 'Esta tarefa não se repete'; end if;
 select * into r from public.task_recurrences where id = t.recurrence_id for update;
 if not (mavi_private.leader(r.company_id) or r.creator_id = auth.uid()) then
  raise exception 'Só quem programou a repetição ou um gestor pode pará-la' using errcode = '42501';
 end if;
 if not r.active then return; end if;
 update public.task_recurrences set active = false, stopped_by = auth.uid(), stopped_at = now() where id = r.id;
 insert into public.task_events(company_id, task_id, actor_id, action)
  values (t.company_id, t.id, auth.uid(), 'recurrence_stopped');
end $$;
revoke all on function public.stop_task_recurrence(uuid) from public, anon;
grant execute on function public.stop_task_recurrence(uuid) to authenticated;

-- create_task takes the repetition (null: the task doesn't repeat).
drop function public.create_task(uuid,uuid,text,uuid,date,uuid,uuid,text,text,integer,boolean,uuid,date,jsonb);
create function public.create_task(p_company uuid,p_contract uuid,p_title text,p_assignee uuid,p_due date,
 p_project uuid default null,p_team uuid default null,p_description text default '',p_priority text default 'normal',
 p_estimated integer default 0,p_client_approval boolean default false,p_parent uuid default null,p_start date default null,
 p_custom jsonb default '{}', p_repeat text default null) returns uuid
language plpgsql security definer set search_path = '' as $$
declare result uuid; custom jsonb; assignee uuid := p_assignee; begin
 if not mavi_private.contract_access(p_company,p_contract) then raise exception 'Sem acesso ao produto contratado' using errcode='42501'; end if;
 if assignee is null and p_team is null then raise exception 'Escolha um responsável ou uma equipe'; end if;
 if p_team is not null and not exists(
  select 1 from public.contracts k join public.client_teams ct on ct.company_id=k.company_id and ct.client_id=k.client_id
  where k.company_id=p_company and k.id=p_contract and ct.team_id=p_team) then raise exception 'Equipe não atende este cliente'; end if;
 if p_parent is not null and not mavi_private.can_edit(p_company,p_parent) then raise exception 'Sem acesso à tarefa principal' using errcode='42501'; end if;
 if assignee is null then
  -- One pick at a time per team, so simultaneous tasks spread out.
  perform 1 from public.teams where company_id=p_company and id=p_team for update;
  assignee := mavi_private.team_assignee(p_company, p_team);
  if assignee is null then
   raise exception 'Esta equipe não tem ninguém ativo para receber a tarefa.';
  end if;
  custom := mavi_private.fill_custom_fields(mavi_private.team_template_fields(p_company,p_contract,p_team), p_custom);
 else
  if not exists(select 1 from public.memberships where company_id=p_company and user_id=assignee and active) then raise exception 'Responsável inválido'; end if;
  custom := mavi_private.fill_custom_fields(mavi_private.template_fields_for(p_company,p_contract,assignee), p_custom);
 end if;
 insert into public.tasks(company_id,contract_id,title,assignee_id,due_date,original_due_date,project_id,team_id,description,priority,estimated_minutes,requires_client_approval,parent_id,start_date,custom_fields)
 values(p_company,p_contract,trim(p_title),assignee,p_due,p_due,p_project,p_team,p_description,p_priority,p_estimated,p_client_approval,p_parent,p_start,custom) returning id into result;
 insert into public.task_events(company_id,task_id,actor_id,action) values(p_company,result,auth.uid(),'created');
 if p_repeat is not null then perform mavi_private.start_recurrence(result, p_repeat, p_assignee is null); end if;
 return result;
end $$;
revoke all on function public.create_task(uuid,uuid,text,uuid,date,uuid,uuid,text,text,integer,boolean,uuid,date,jsonb,text) from public, anon;
grant execute on function public.create_task(uuid,uuid,text,uuid,date,uuid,uuid,text,text,integer,boolean,uuid,date,jsonb,text) to authenticated;

-- The task's details bring its repetition, when it has one.
create or replace function public.task_extras(p_task uuid) returns jsonb
language plpgsql stable security invoker set search_path='' as $$
declare c uuid; rec uuid; begin
 select company_id, recurrence_id into c, rec from public.tasks where id=p_task;
 if not found then raise exception 'Sem acesso à tarefa' using errcode='42501'; end if;
 return jsonb_build_object(
 'comments',(select coalesce(jsonb_agg(r order by r.created_at desc,r.id desc),'[]'::jsonb) from
   (select * from public.comments where company_id=c and task_id=p_task order by created_at desc,id desc limit 100) r),
 'attachments',(select coalesce(jsonb_agg(r order by r.created_at desc,r.id desc),'[]'::jsonb) from
   (select * from public.attachments where company_id=c and task_id=p_task order by created_at desc,id desc limit 100) r),
 'events',(select coalesce(jsonb_agg(r order by r.created_at desc,r.id desc),'[]'::jsonb) from
   (select * from public.task_events where company_id=c and task_id=p_task order by created_at desc,id desc limit 100) r),
 'recurrence',(select jsonb_build_object('id',r.id,'frequency',r.frequency,'next_run',r.next_run,'active',r.active,
   'creator_id',r.creator_id,'copies',r.copies,'last_error',r.last_error)
   from public.task_recurrences r where r.company_id=c and r.id=rec));
end $$;

-- Hosted Supabase supports pg_cron; embedded PostgreSQL used in tests does
-- not. Every 30 minutes, so each series opens early on its day in any zone.
do $$ begin
 if exists(select 1 from pg_available_extensions where name = 'pg_cron') then
  create extension if not exists pg_cron;
  perform cron.schedule('mavi-task-recurrences', '*/30 * * * *', 'select mavi_private.run_task_recurrences()');
 else
  raise notice 'pg_cron unavailable: schedule mavi_private.run_task_recurrences() on the hosted database';
 end if;
end $$;

commit;
