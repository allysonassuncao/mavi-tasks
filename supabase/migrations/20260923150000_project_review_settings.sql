begin;

-- Each project decides whether its tasks go through a validation step and,
-- if so, who validates: the task's creator or the team's supervisor (a
-- manager who belongs to the task's team, or to the client's teams when the
-- task has no team). Admins can always validate. Tasks outside a project keep
-- the previous rule (creator or any leader).
alter table public.projects
 add column requires_review boolean not null default true,
 add column approver text not null default 'creator' check (approver in ('creator','supervisor'));

create function mavi_private.task_supervisor(c uuid, t uuid) returns boolean
language sql stable security definer set search_path = '' as $$
 select exists(
  select 1 from public.tasks tk
  join public.contracts k on k.company_id=tk.company_id and k.id=tk.contract_id
  join public.memberships m on m.company_id=tk.company_id and m.user_id=auth.uid() and m.active and m.role='manager'
  join public.team_members tm on tm.company_id=m.company_id and tm.user_id=m.user_id
  where tk.company_id=c and tk.id=t and (
   tm.team_id=tk.team_id or (tk.team_id is null and exists(
    select 1 from public.client_teams ct
    where ct.company_id=k.company_id and ct.client_id=k.client_id and ct.team_id=tm.team_id))))
$$;
revoke all on function mavi_private.task_supervisor(uuid,uuid) from public, anon;
grant execute on function mavi_private.task_supervisor(uuid,uuid) to authenticated;

create or replace function mavi_private.can_approve(c uuid, t uuid) returns boolean language sql stable security definer set search_path = '' as $$
 select mavi_private.task_access(c, t) and exists(
  select 1 from public.tasks tk
  left join public.projects p on p.company_id=tk.company_id and p.id=tk.project_id
  where tk.company_id=c and tk.id=t and (
   mavi_private.admin(c)
   or ((p.id is null or not p.requires_review) and (mavi_private.leader(c) or tk.creator_id=auth.uid()))
   or (p.requires_review and p.approver='creator' and tk.creator_id=auth.uid())
   or (p.requires_review and p.approver='supervisor' and mavi_private.task_supervisor(c, t))))
$$;

drop function public.create_project(uuid,uuid,text,date);
create function public.create_project(p_company uuid, p_contract uuid, p_name text, p_due date default null,
 p_requires_review boolean default true, p_approver text default 'creator') returns uuid
language plpgsql security definer set search_path = '' as $$ declare result uuid; begin
  if not mavi_private.leader(p_company) then raise exception 'Sem permissão' using errcode = '42501'; end if;
  insert into public.projects(company_id, contract_id, name, due_date, requires_review, approver)
  values(p_company, p_contract, trim(p_name), p_due, coalesce(p_requires_review, true), coalesce(p_approver, 'creator'))
  returning id into result;
  return result;
end $$;

-- Null review settings keep the project's current ones.
drop function public.update_project(uuid,text,date,uuid);
create function public.update_project(p_project uuid, p_name text, p_due date, p_contract uuid default null,
 p_requires_review boolean default null, p_approver text default null) returns void
language plpgsql security definer set search_path = '' as $$
declare p public.projects; begin
  select * into p from public.projects where id = p_project for update;
  if not found or not mavi_private.leader(p.company_id) then raise exception 'Sem permissão' using errcode = '42501'; end if;
  if p_contract is not null and p_contract <> p.contract_id and exists(select 1 from public.tasks where project_id = p_project) then
    raise exception 'Projetos com tarefas não podem mudar de produto contratado.';
  end if;
  update public.projects set name = trim(p_name), due_date = p_due, contract_id = coalesce(p_contract, contract_id),
   requires_review = coalesce(p_requires_review, requires_review), approver = coalesce(p_approver, approver)
  where id = p_project;
end $$;

do $$ declare f record; begin
 for f in select p.oid::regprocedure as signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='public' and p.proname=any(array['create_project','update_project']) loop
 execute format('revoke all on function %s from public,anon',f.signature);
 execute format('grant execute on function %s to authenticated',f.signature);
 end loop;
end $$;

-- Without a validation step, submitting completes the task (it still waits
-- for the client when the task requires client approval).
create or replace function public.transition_task(p_task uuid,p_version integer,p_action text,p_note text default '') returns public.tasks
language plpgsql security definer set search_path = '' as $$ declare t public.tasks; next_status text; review_required boolean; begin
 select * into t from public.tasks where id=p_task for update;
 if not found or not mavi_private.can_work(t.company_id,t.id) then raise exception 'Sem acesso à tarefa' using errcode='42501'; end if;
 if t.version<>p_version then raise exception 'A tarefa mudou. Atualize antes de continuar.' using errcode='40001'; end if;
 review_required := coalesce((select requires_review from public.projects where company_id=t.company_id and id=t.project_id), true);
 next_status:=t.status;
 case p_action
 when 'start' then
  if t.status not in ('open','returned') then raise exception 'Transição inválida'; end if; next_status:='progress';
 when 'return' then
  if t.status not in ('open','progress','review') or length(trim(p_note))<3 then raise exception 'Informe o motivo da devolução'; end if; next_status:='returned';
 when 'submit' then
  if t.status not in ('open','progress','returned') then raise exception 'Transição inválida'; end if; next_status:='review';
  if not review_required then t.internal_approved_by:=auth.uid(); end if;
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

commit;
