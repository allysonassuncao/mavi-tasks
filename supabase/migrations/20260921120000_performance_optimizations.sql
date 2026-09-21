begin;
-- Trigram index so the task search box (ilike '%term%') can use an index instead
-- of a sequential scan as the tasks table grows.
create extension if not exists pg_trgm;
create index if not exists tasks_title_trgm on public.tasks using gin(title gin_trgm_ops);

-- Covers the "late" filter combo (status <> 'done' ordered/filtered by due_date),
-- used by both the task list and report_summary's late count.
create index if not exists tasks_open_due on public.tasks(company_id,status,due_date) where not archived;

-- report_summary aggregates task_events/time_entries by company + time range;
-- neither table previously had an index led by company_id + the range column.
create index if not exists task_events_company_created on public.task_events(company_id,created_at);
create index if not exists time_entries_company_started on public.time_entries(company_id,started_at);

-- report_summary previously materialized full task rows (select *) just to count
-- and aggregate a handful of columns; narrow it so the growing description/notes
-- columns aren't copied into the CTE's working set on every dashboard load.
create or replace function public.report_summary(p_company uuid,p_start timestamptz,p_end timestamptz) returns jsonb
language sql stable security invoker set search_path = '' as $$
 with visible_tasks as (select id,project_id,status,due_date,contract_id,assignee_id,estimated_minutes from public.tasks where company_id=p_company and not archived),
 hours as (select e.*,greatest(0,extract(epoch from (least(coalesce(e.ended_at,now()),p_end)-greatest(e.started_at,p_start)))/60) as minutes
 from public.time_entries e where company_id=p_company and e.started_at<p_end and coalesce(e.ended_at,now())>p_start),
 by_project as (select project_id as id,count(*) as total,count(*) filter(where status='done') as done from visible_tasks where project_id is not null group by project_id),
 by_client as (select c.id,c.name,sum(h.minutes) as minutes from hours h join visible_tasks t on t.id=h.task_id
 join public.contracts k on k.id=t.contract_id join public.clients c on c.id=k.client_id group by c.id,c.name),
 by_person as (select m.user_id as id,m.name,count(t.id) as tasks,coalesce(sum(t.estimated_minutes),0) as estimated
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

-- Mutation RPCs below now return the affected row so the client can patch local
-- state directly instead of invalidating and refetching the whole snapshot after
-- every single change. Logic is unchanged; only the return value is enriched.
drop function public.transition_task(uuid,integer,text,text);
create function public.transition_task(p_task uuid,p_version integer,p_action text,p_note text default '') returns public.tasks
language plpgsql security definer set search_path = '' as $$ declare t public.tasks; next_status text; begin
 select * into t from public.tasks where id=p_task for update;
 if not found or not mavi_private.can_work(t.company_id,t.id) then raise exception 'Sem acesso à tarefa' using errcode='42501'; end if;
 if t.version<>p_version then raise exception 'A tarefa mudou. Atualize antes de continuar.' using errcode='40001'; end if;
 next_status:=t.status;
 case p_action
 when 'start' then
  if t.status not in ('open','returned') then raise exception 'Transição inválida'; end if; next_status:='progress';
 when 'return' then
  if t.status not in ('open','progress','review') or length(trim(p_note))<3 then raise exception 'Informe o motivo da devolução'; end if; next_status:='returned';
 when 'submit' then
  if t.status not in ('open','progress','returned') then raise exception 'Transição inválida'; end if; next_status:='review';
 when 'reject' then
  if t.status<>'review' or not mavi_private.can_approve(t.company_id,t.id) then raise exception 'Sem permissão para reprovar' using errcode='42501'; end if;
  if length(trim(p_note))<3 then raise exception 'Informe o motivo da reprovação'; end if; next_status:='progress';
 when 'approve_internal' then
  if t.status<>'review' or not mavi_private.can_approve(t.company_id,t.id) then raise exception 'Sem permissão para aprovar' using errcode='42501'; end if;
  t.internal_approved_by:=auth.uid();
 when 'approve_client' then
  if t.status<>'review' or not t.requires_client_approval or not mavi_private.can_approve(t.company_id,t.id) then raise exception 'Sem permissão para registrar aprovação' using errcode='42501'; end if;
  if length(trim(p_note))<5 then raise exception 'Informe quem aprovou e a evidência'; end if;
  t.client_approved_by:=auth.uid(); t.client_approval_note:=p_note;
 when 'reopen' then
  if t.status<>'done' or not mavi_private.can_approve(t.company_id,t.id) then raise exception 'Sem permissão para reabrir' using errcode='42501'; end if;
  if length(trim(p_note))<3 then raise exception 'Informe o motivo'; end if; next_status:='progress';
 else raise exception 'Ação inválida';
 end case;
 if p_action in ('return','reject','reopen') then
  t.internal_approved_by:=null; t.client_approved_by:=null; t.client_approval_note:=null; t.revision:=t.revision+1;
 end if;
 if next_status='review' and t.internal_approved_by is not null and (not t.requires_client_approval or t.client_approved_by is not null) then next_status:='done'; end if;
 update public.tasks set status=next_status, internal_approved_by=t.internal_approved_by, client_approved_by=t.client_approved_by,
 client_approval_note=t.client_approval_note, revision=t.revision, version=version+1, delivered_at=case when next_status='done' then now() else null end where id=t.id;
 insert into public.task_events(company_id,task_id,actor_id,action,detail) values(t.company_id,t.id,auth.uid(),p_action,
 jsonb_build_object('note',p_note,'from',t.status,'to',next_status,'revision',t.revision,'due_date',t.due_date));
 select * into t from public.tasks where id=t.id;
 return t;
end $$;

drop function public.update_task(uuid,integer,text,text,date,integer,text,date);
create function public.update_task(p_task uuid,p_version integer,p_title text,p_description text,p_due date,p_estimated integer,p_priority text,p_start date default null) returns public.tasks
language plpgsql security definer set search_path = '' as $$ declare t public.tasks; begin
 select * into t from public.tasks where id=p_task for update;
 if not found or not mavi_private.can_edit(t.company_id,t.id) then raise exception 'Sem permissão' using errcode='42501'; end if;
 if t.version<>p_version then raise exception 'A tarefa mudou. Atualize antes de continuar.' using errcode='40001'; end if;
 update public.tasks set start_date=p_start,title=trim(p_title),description=p_description,due_date=p_due,estimated_minutes=p_estimated,priority=p_priority,
 internal_approved_by=null,client_approved_by=null,client_approval_note=null,revision=revision+1,version=version+1,
 delivered_at=null,status=case when status in ('review','done') then 'progress' else status end where id=t.id;
 insert into public.task_events(company_id,task_id,actor_id,action,detail) values(t.company_id,t.id,auth.uid(),'edited',jsonb_build_object('old_due',t.due_date,'new_due',p_due));
 select * into t from public.tasks where id=t.id;
 return t;
end $$;

drop function public.start_timer(uuid);
create function public.start_timer(p_task uuid) returns public.time_entries language plpgsql security definer set search_path='' as $$
declare t public.tasks; entry public.time_entries; switched_at timestamptz; begin
 perform pg_advisory_xact_lock(hashtextextended(auth.uid()::text,0));
 select * into t from public.tasks where id=p_task;
 if not found or not mavi_private.task_access(t.company_id,t.id) then raise exception 'Sem permissão' using errcode='42501'; end if;
 select * into entry from public.time_entries where user_id=auth.uid() and ended_at is null and task_id=p_task;
 if found then return entry; end if;
 select greatest(clock_timestamp(),coalesce(max(started_at)+interval '1 millisecond',clock_timestamp())) into switched_at from public.time_entries where user_id=auth.uid() and ended_at is null;
 update public.time_entries set ended_at=switched_at where user_id=auth.uid() and ended_at is null;
 insert into public.time_entries(company_id,task_id,started_at,source) values(t.company_id,t.id,switched_at,'timer') returning * into entry;
 return entry;
end $$;

drop function public.stop_timer(uuid);
create function public.stop_timer(p_entry uuid) returns public.time_entries language plpgsql security definer set search_path='' as $$
declare e public.time_entries; begin
 perform pg_advisory_xact_lock(hashtextextended(auth.uid()::text,0));
 select * into e from public.time_entries where id=p_entry for update;
 if not found or e.user_id<>auth.uid() then raise exception 'Sem permissão' using errcode='42501'; end if;
 if e.ended_at is not null then return e; end if;
 update public.time_entries set ended_at=greatest(clock_timestamp(),started_at+interval '1 millisecond') where id=e.id;
 select * into e from public.time_entries where id=e.id;
 return e;
end $$;

drop function public.add_comment(uuid,text);
create function public.add_comment(p_task uuid,p_body text) returns public.comments
language plpgsql security definer set search_path = '' as $$ declare t public.tasks; result public.comments; begin
 select * into t from public.tasks where id=p_task;
 if not found or not mavi_private.task_access(t.company_id,t.id) then raise exception 'Sem permissão' using errcode='42501'; end if;
 insert into public.comments(company_id,task_id,body) values(t.company_id,t.id,trim(p_body)) returning * into result; return result;
end $$;

do $$ declare f record; begin
 for f in select p.oid::regprocedure as signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace
 where n.nspname='public' and p.proname=any(array['transition_task','update_task','start_timer','stop_timer','add_comment']) loop
 execute format('revoke all on function %s from public, anon',f.signature);
 execute format('grant execute on function %s to authenticated',f.signature);
 end loop;
end $$;
commit;
