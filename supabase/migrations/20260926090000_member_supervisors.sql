begin;

-- Any active person in a team may supervise it, not only managers and
-- admins. A supervisor sees and validates the team's tasks (the task's team,
-- or the client's teams when the task has none), with its comments, files and
-- history; everything else keeps the person's own profile limits.

create or replace function mavi_private.task_supervisor(c uuid, t uuid) returns boolean
language sql stable security definer set search_path = '' as $$
 select exists(
  select 1 from public.tasks tk
  join public.contracts k on k.company_id=tk.company_id and k.id=tk.contract_id
  join public.memberships m on m.company_id=tk.company_id and m.user_id=auth.uid() and m.active
  join public.team_members tm on tm.company_id=m.company_id and tm.user_id=m.user_id and tm.supervisor
  where tk.company_id=c and tk.id=t and (
   tm.team_id=tk.team_id or (tk.team_id is null and exists(
    select 1 from public.client_teams ct
    where ct.company_id=k.company_id and ct.client_id=k.client_id and ct.team_id=tm.team_id))))
$$;

-- The same set, computed once per query for the tasks policy.
create or replace function mavi_private.supervised_tasks() returns setof uuid
language sql stable security definer set search_path = '' as $$
 select tk.id from public.tasks tk
 join public.contracts k on k.company_id=tk.company_id and k.id=tk.contract_id
 join public.memberships m on m.company_id=tk.company_id and m.user_id=(select auth.uid()) and m.active
 join public.team_members tm on tm.company_id=m.company_id and tm.user_id=m.user_id and tm.supervisor
 where tm.team_id=tk.team_id or (tk.team_id is null and exists(
  select 1 from public.client_teams ct
  where ct.company_id=k.company_id and ct.client_id=k.client_id and ct.team_id=tm.team_id))
$$;
revoke all on function mavi_private.supervised_tasks() from public, anon;
grant execute on function mavi_private.supervised_tasks() to authenticated;

alter policy tasks_read on public.tasks using (
 company_id in (select mavi_private.active_companies()) and (
  company_id in (select mavi_private.leader_companies())
  or creator_id = (select auth.uid())
  or assignee_id = (select auth.uid())
  or id in (select mavi_private.supervised_tasks())));

create or replace function mavi_private.task_access(c uuid, t uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select mavi_private.member(c) and exists(select 1 from public.tasks where company_id = c and id = t and
    (mavi_private.leader(c) or creator_id = auth.uid() or assignee_id = auth.uid()))
  or (mavi_private.member(c) and mavi_private.task_supervisor(c, t))
$$;

-- Contracts (and so clients and projects) of supervised tasks are readable.
create or replace function mavi_private.own_contracts() returns setof uuid
language sql stable security definer set search_path = '' as $$
 select distinct t.contract_id from public.tasks t join public.memberships m using(company_id)
 where m.user_id=(select auth.uid()) and m.active
 and (t.creator_id=m.user_id or t.assignee_id=m.user_id)
 union
 select tk.contract_id from public.tasks tk where tk.id in (select mavi_private.supervised_tasks())
$$;
create or replace function mavi_private.contract_read(c uuid, k uuid) returns boolean
language sql stable security definer set search_path = '' as $$
 select mavi_private.contract_access(c,k) or (mavi_private.member(c) and exists(
 select 1 from public.tasks where company_id=c and contract_id=k and (creator_id=auth.uid() or assignee_id=auth.uid()
  or id in (select mavi_private.supervised_tasks()))))
$$;

-- Supervisors: any active member of the company.
create or replace function mavi_private.set_team_people(c uuid, p_team uuid, p_users uuid[], p_supervisors uuid[]) returns void
language plpgsql security definer set search_path = '' as $$
declare everyone uuid[]; begin
  everyone := array(select distinct u from unnest(coalesce(p_users, '{}'::uuid[]) || coalesce(p_supervisors, '{}'::uuid[])) as u where u is not null);
  if exists(select 1 from unnest(coalesce(p_supervisors, '{}'::uuid[])) as s where not exists(
    select 1 from public.memberships m where m.company_id=c and m.user_id=s and m.active)) then
    raise exception 'Supervisores precisam ser pessoas ativas da empresa';
  end if;
  delete from public.team_members where company_id=c and team_id=p_team and not (user_id = any(everyone));
  insert into public.team_members(company_id, team_id, user_id, supervisor)
    select c, p_team, u, u = any(coalesce(p_supervisors, '{}'::uuid[])) from unnest(everyone) as u
    on conflict (company_id, team_id, user_id) do update set supervisor = excluded.supervisor;
end $$;
revoke all on function mavi_private.set_team_people(uuid,uuid,uuid[],uuid[]) from public, anon, authenticated;

-- Becoming a Colaborador no longer removes supervision.
create or replace function public.update_member(p_company uuid, p_user uuid, p_name text, p_role text, p_active boolean, p_teams uuid[]) returns void
language plpgsql security definer set search_path = '' as $$
declare target public.memberships; caller_admin boolean; begin
  if not mavi_private.leader(p_company) then raise exception 'Sem permissão' using errcode = '42501'; end if;
  select * into target from public.memberships where company_id = p_company and user_id = p_user for update;
  if not found then raise exception 'Usuário não encontrado na empresa'; end if;
  if p_role not in ('admin', 'manager', 'member') then raise exception 'Perfil de acesso inválido.'; end if;
  if length(trim(coalesce(p_name, ''))) not between 2 and 120 then raise exception 'Informe um nome de 2 a 120 caracteres.'; end if;
  caller_admin := mavi_private.admin(p_company);
  if not caller_admin and (target.role = 'admin' or p_role = 'admin') then
    raise exception 'Somente administradores editam administradores.' using errcode = '42501';
  end if;
  if p_user = auth.uid() and (p_role <> target.role or not p_active) then
    raise exception 'Você não pode alterar o próprio perfil de acesso nem se desativar.' using errcode = '42501';
  end if;
  if target.role = 'admin' and target.active and (p_role <> 'admin' or not p_active) and not exists(
    select 1 from public.memberships
    where company_id = p_company and user_id <> p_user and role = 'admin' and active) then
    raise exception 'A empresa precisa de pelo menos um administrador ativo.';
  end if;

  update public.memberships set name = trim(p_name), role = p_role, active = coalesce(p_active, active)
  where company_id = p_company and user_id = p_user;

  -- Teams: keep supervision in teams the person stays in.
  delete from public.team_members
  where company_id = p_company and user_id = p_user and not (team_id = any(coalesce(p_teams, '{}'::uuid[])));
  insert into public.team_members(company_id, team_id, user_id)
    select p_company, t.id, p_user from public.teams t
    where t.company_id = p_company and t.id = any(coalesce(p_teams, '{}'::uuid[]))
    on conflict do nothing;
end $$;
revoke all on function public.update_member(uuid, uuid, text, text, boolean, uuid[]) from public, anon;
grant execute on function public.update_member(uuid, uuid, text, text, boolean, uuid[]) to authenticated;

-- Supervisors who are not leaders can validate: the entry check accepts
-- anyone who may work on or approve the task.
create or replace function public.transition_task(p_task uuid,p_version integer,p_action text,p_note text default '') returns public.tasks
language plpgsql security definer set search_path = '' as $$ declare t public.tasks; next_status text; review_required boolean; is_admin boolean; me uuid := auth.uid(); begin
 select * into t from public.tasks where id=p_task for update;
 -- Validators (e.g. a team's Colaborador supervisors) reach here too; every
 -- action below checks its own permission.
 if not found or not (mavi_private.can_work(t.company_id,t.id) or mavi_private.can_approve(t.company_id,t.id)) then raise exception 'Sem acesso à tarefa' using errcode='42501'; end if;
 if t.version<>p_version then raise exception 'A tarefa mudou. Atualize antes de continuar.' using errcode='40001'; end if;
 review_required := coalesce((select requires_review from public.projects where company_id=t.company_id and id=t.project_id), true);
 is_admin := mavi_private.admin(t.company_id);
 next_status:=t.status;
 case p_action
 when 'start' then
  if t.status not in ('open','returned','rejected') then raise exception 'Transição inválida'; end if;
  if not mavi_private.can_work(t.company_id,t.id) then raise exception 'Sem permissão para iniciar a tarefa' using errcode='42501'; end if;
  if t.status='returned' then
   if me<>t.creator_id and not is_admin then raise exception 'Somente o criador pode reenviar a tarefa devolvida' using errcode='42501'; end if;
   if length(trim(p_note))<3 then raise exception 'Informe o parecer para reenviar a tarefa'; end if;
  end if;
  next_status:='progress';
 when 'return' then
  if me=t.creator_id then raise exception 'A tarefa não pode ser devolvida pelo próprio criador' using errcode='42501'; end if;
  if not ((me=t.assignee_id and t.status in ('open','progress','rejected'))
   or (is_admin and t.status in ('open','progress','review','rejected'))) then
   raise exception 'Sem permissão para devolver esta tarefa' using errcode='42501'; end if;
  if length(trim(p_note))<3 then raise exception 'Informe o motivo da devolução'; end if; next_status:='returned';
 when 'submit' then
  if t.status not in ('open','progress') then raise exception 'Retome a tarefa antes de enviá-la para validação'; end if;
  if me<>t.assignee_id and not is_admin then raise exception 'Somente o responsável pode enviar a tarefa' using errcode='42501'; end if;
  if review_required and length(trim(p_note))<3 then raise exception 'Descreva a entrega para a validação'; end if;
  next_status:='review';
  if not review_required then t.internal_approved_by:=me; end if;
 when 'reject' then
  if t.status<>'review' or not mavi_private.can_approve(t.company_id,t.id) then raise exception 'Sem permissão para reprovar' using errcode='42501'; end if;
  if length(trim(p_note))<3 then raise exception 'Informe o motivo da reprovação'; end if; next_status:='rejected';
 when 'approve_internal' then
  if t.status<>'review' or not mavi_private.can_approve(t.company_id,t.id) then raise exception 'Sem permissão para aprovar' using errcode='42501'; end if;
  if length(trim(p_note))<3 then raise exception 'Informe as observações da validação'; end if;
  t.internal_approved_by:=me;
 when 'approve_client' then
  if t.status<>'review' or not t.requires_client_approval or not mavi_private.can_approve(t.company_id,t.id) then raise exception 'Sem permissão para registrar aprovação' using errcode='42501'; end if;
  if t.internal_approved_by is null then raise exception 'Registre a aprovação interna antes da aprovação do cliente'; end if;
  if length(trim(p_note))<5 then raise exception 'Informe quem aprovou e a evidência'; end if;
  t.client_approved_by:=me; t.client_approval_note:=p_note;
 when 'reopen' then
  if t.status<>'done' or not (is_admin or me in (t.creator_id,t.assignee_id) or mavi_private.can_approve(t.company_id,t.id)) then
   raise exception 'Sem permissão para reabrir' using errcode='42501'; end if;
  if not is_admin and t.delivered_at < now()-interval '2 days' then
   raise exception 'Não é possível reabrir esta tarefa. A data limite para reabertura da tarefa foi ultrapassada.'; end if;
  if length(trim(p_note))<3 then raise exception 'Informe o motivo'; end if; next_status:='progress';
 else raise exception 'Ação inválida';
 end case;
 if p_action in ('return','reject','reopen') then
  t.internal_approved_by:=null; t.client_approved_by:=null; t.client_approval_note:=null; t.revision:=t.revision+1;
 end if;
 if next_status='review' and t.internal_approved_by is not null and (not t.requires_client_approval or t.client_approved_by is not null) then next_status:='done'; end if;
 update public.tasks set status=next_status, internal_approved_by=t.internal_approved_by, client_approved_by=t.client_approved_by,
 client_approval_note=t.client_approval_note, revision=t.revision, version=version+1, delivered_at=case when next_status='done' then now() else null end where id=t.id;
 insert into public.task_events(company_id,task_id,actor_id,action,detail) values(t.company_id,t.id,me,p_action,
 jsonb_build_object('note',p_note,'from',t.status,'to',next_status,'revision',t.revision,'due_date',t.due_date));
 if p_action in ('start','return','reject','submit','approve_internal','approve_client','reopen') and length(trim(p_note))>0 then
  insert into public.comments(company_id,task_id,body) values(t.company_id,t.id,mavi_private.transition_comment(
   case p_action when 'start' then 'Reenviada ao responsável' when 'return' then 'Devolvida ao criador' when 'reject' then 'Reprovada na validação'
    when 'submit' then 'Enviada para validação' when 'approve_internal' then 'Aprovada na validação'
    when 'approve_client' then 'Aprovação do cliente registrada' else 'Tarefa reaberta' end,p_note));
 end if;
 select * into t from public.tasks where id=t.id;
 return t;
end $$;
revoke all on function public.transition_task(uuid,integer,text,text) from public, anon;
grant execute on function public.transition_task(uuid,integer,text,text) to authenticated;


commit;
