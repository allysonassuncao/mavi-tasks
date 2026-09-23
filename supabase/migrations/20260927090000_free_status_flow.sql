begin;

-- Free status flow, in the spirit of ClickUp: the whole cycle (request,
-- execution, validation, changes) lives in the same task, which moves freely
-- between its working statuses. Whoever moves it also picks, by hand, who is
-- responsible for it from then on.
--
-- Status keys are kept; their labels changed:
--   open = Em delegação · progress = Em andamento · returned = Devolvida
--   (missing information) · review = Em validação · rejected = Alteração ·
--   done = Entregue.
--
-- * Moving (and reassigning) is for the current assignee, the creator or a
--   leader; while in validation, whoever validates may move it too.
-- * Delivery still needs the validator's approval (and the client's, when
--   required); projects without validation deliver straight from the menu.
-- * Everyone who was ever responsible keeps seeing the task as a participant.

-- When the task entered its current status (time in status, as in ClickUp).
alter table public.tasks add column status_changed_at timestamptz;
update public.tasks t set status_changed_at = coalesce(
 (select max(e.created_at) from public.task_events e
  where e.company_id=t.company_id and e.task_id=t.id
   and e.detail->>'to' = t.status and e.detail->>'from' is distinct from t.status),
 t.delivered_at, t.created_at);
alter table public.tasks alter column status_changed_at set default now(),
 alter column status_changed_at set not null;
create function mavi_private.touch_task_status() returns trigger
language plpgsql set search_path = '' as $$ begin
 if new.status is distinct from old.status then new.status_changed_at := now(); end if;
 return new;
end $$;
create trigger touch_task_status before update of status on public.tasks
 for each row execute function mavi_private.touch_task_status();

-- Past and present assignees.
create table public.task_participants (
 company_id uuid not null, task_id uuid not null, user_id uuid not null,
 added_at timestamptz not null default now(),
 primary key(task_id,user_id),
 foreign key(company_id,task_id) references public.tasks(company_id,id) on delete cascade,
 foreign key(company_id,user_id) references public.memberships(company_id,user_id)
);
create index task_participants_user on public.task_participants(company_id,user_id);
-- Read only through the access helpers below.
alter table public.task_participants enable row level security;
insert into public.task_participants(company_id,task_id,user_id)
 select company_id,id,assignee_id from public.tasks on conflict do nothing;
create function mavi_private.track_task_participants() returns trigger
language plpgsql security definer set search_path = '' as $$ begin
 insert into public.task_participants(company_id,task_id,user_id)
  values(new.company_id,new.id,new.assignee_id) on conflict do nothing;
 return new;
end $$;
create trigger track_task_participants after insert or update of assignee_id on public.tasks
 for each row execute function mavi_private.track_task_participants();

create function mavi_private.participant_tasks() returns setof uuid
language sql stable security definer set search_path = '' as $$
 select p.task_id from public.task_participants p
 join public.memberships m on m.company_id=p.company_id and m.user_id=p.user_id and m.active
 where p.user_id=(select auth.uid())
$$;
revoke all on function mavi_private.participant_tasks() from public, anon;
grant execute on function mavi_private.participant_tasks() to authenticated;

alter policy tasks_read on public.tasks using (
 company_id in (select mavi_private.active_companies()) and (
  company_id in (select mavi_private.leader_companies())
  or creator_id = (select auth.uid())
  or assignee_id = (select auth.uid())
  or id in (select mavi_private.supervised_tasks())
  or id in (select mavi_private.participant_tasks())));

-- Participants see, comment on and time the task like its assignee does.
create or replace function mavi_private.task_access(c uuid, t uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select mavi_private.member(c) and exists(select 1 from public.tasks where company_id = c and id = t and
    (mavi_private.leader(c) or creator_id = auth.uid() or assignee_id = auth.uid()))
  or (mavi_private.member(c) and mavi_private.task_supervisor(c, t))
  or (mavi_private.member(c) and exists(select 1 from public.task_participants
    where company_id = c and task_id = t and user_id = auth.uid()))
$$;

create or replace function mavi_private.own_contracts() returns setof uuid
language sql stable security definer set search_path = '' as $$
 select distinct t.contract_id from public.tasks t join public.memberships m using(company_id)
 where m.user_id=(select auth.uid()) and m.active
 and (t.creator_id=m.user_id or t.assignee_id=m.user_id)
 union
 select tk.contract_id from public.tasks tk where tk.id in (select mavi_private.supervised_tasks())
 union
 select tk.contract_id from public.tasks tk where tk.id in (select mavi_private.participant_tasks())
$$;
create or replace function mavi_private.contract_read(c uuid, k uuid) returns boolean
language sql stable security definer set search_path = '' as $$
 select mavi_private.contract_access(c,k) or (mavi_private.member(c) and exists(
 select 1 from public.tasks where company_id=c and contract_id=k and (creator_id=auth.uid() or assignee_id=auth.uid()
  or id in (select mavi_private.supervised_tasks()) or id in (select mavi_private.participant_tasks()))))
$$;

create function mavi_private.status_label(s text) returns text
language sql immutable set search_path = '' as $$
 select case s when 'open' then 'Em delegação' when 'progress' then 'Em andamento'
  when 'returned' then 'Devolvida' when 'review' then 'Em validação'
  when 'rejected' then 'Alteração' when 'done' then 'Entregue' else s end
$$;
revoke all on function mavi_private.status_label(text) from public, anon, authenticated;

drop function public.transition_task(uuid,integer,text,text);
create function public.transition_task(p_task uuid,p_version integer,p_action text,p_note text default '',
 p_status text default null,p_assignee uuid default null) returns public.tasks
language plpgsql security definer set search_path = '' as $$
declare t public.tasks; next_status text; next_assignee uuid; review_required boolean; is_admin boolean;
 approver boolean; mover boolean; label text; me uuid := auth.uid();
 working constant text[] := array['open','progress','returned','review','rejected'];
begin
 select * into t from public.tasks where id=p_task for update;
 if not found or not (mavi_private.task_access(t.company_id,t.id) or mavi_private.can_approve(t.company_id,t.id)) then
  raise exception 'Sem acesso à tarefa' using errcode='42501'; end if;
 if t.version<>p_version then raise exception 'A tarefa mudou. Atualize antes de continuar.' using errcode='40001'; end if;
 review_required := coalesce((select requires_review from public.projects where company_id=t.company_id and id=t.project_id), true);
 is_admin := mavi_private.admin(t.company_id);
 approver := mavi_private.can_approve(t.company_id,t.id);
 mover := me in (t.assignee_id,t.creator_id) or mavi_private.leader(t.company_id) or (t.status='review' and approver);
 -- Actions of the previous, linear flow (e.g. from a cached app) become moves.
 if p_action in ('start','submit','return','reject') then
  p_status := case p_action when 'start' then 'progress' when 'return' then 'returned' when 'reject' then 'rejected'
   else case when review_required then 'review' else 'done' end end;
  p_action := 'move';
 end if;
 next_status := t.status;
 next_assignee := coalesce(p_assignee,t.assignee_id);
 if next_assignee<>t.assignee_id and not exists(select 1 from public.memberships
  where company_id=t.company_id and user_id=next_assignee and active) then
  raise exception 'Escolha um responsável ativo da empresa'; end if;
 case p_action
 when 'move' then
  if not mover then raise exception 'Somente o responsável, o criador ou um gestor muda o status da tarefa' using errcode='42501'; end if;
  if t.status='done' then raise exception 'Reabra a tarefa entregue para mudar o status'; end if;
  p_status := coalesce(p_status,t.status);
  if p_status='done' then
   if review_required then raise exception 'Este projeto exige validação: a entrega é aprovada por quem valida' using errcode='42501'; end if;
   -- Delivered below, unless the client's approval is still pending.
   t.internal_approved_by:=me; next_status:='review';
  elsif p_status = any(working) then next_status:=p_status;
  else raise exception 'Status inválido'; end if;
  if p_status=t.status and next_assignee=t.assignee_id then raise exception 'Escolha outro status ou outro responsável'; end if;
  if next_status<>t.status and next_status='returned' and length(trim(p_note))<3 then raise exception 'Informe quais informações faltam'; end if;
  if next_status<>t.status and next_status='rejected' and length(trim(p_note))<3 then raise exception 'Descreva a alteração solicitada'; end if;
 when 'approve_internal' then
  if t.status<>'review' or not approver then raise exception 'Sem permissão para aprovar' using errcode='42501'; end if;
  if length(trim(p_note))<3 then raise exception 'Informe as observações da validação'; end if;
  t.internal_approved_by:=me;
 when 'approve_client' then
  if t.status<>'review' or not t.requires_client_approval or not approver then raise exception 'Sem permissão para registrar aprovação' using errcode='42501'; end if;
  if t.internal_approved_by is null then raise exception 'Registre a aprovação interna antes da aprovação do cliente'; end if;
  if length(trim(p_note))<5 then raise exception 'Informe quem aprovou e a evidência'; end if;
  t.client_approved_by:=me; t.client_approval_note:=p_note;
 when 'reopen' then
  if t.status<>'done' or not (is_admin or me in (t.creator_id,t.assignee_id) or approver) then
   raise exception 'Sem permissão para reabrir' using errcode='42501'; end if;
  if not is_admin and t.delivered_at < now()-interval '2 days' then
   raise exception 'Não é possível reabrir esta tarefa. A data limite para reabertura da tarefa foi ultrapassada.'; end if;
  if length(trim(p_note))<3 then raise exception 'Informe o motivo'; end if;
  next_status := coalesce(p_status,'progress');
  if not next_status = any(working) then raise exception 'Status inválido'; end if;
 else raise exception 'Ação inválida';
 end case;
 -- Leaving validation drops its approvals; a new round of changes is a new revision.
 if p_action in ('move','reopen') and next_status<>'review' then
  t.internal_approved_by:=null; t.client_approved_by:=null; t.client_approval_note:=null;
 end if;
 if p_action='reopen' or (next_status<>t.status and next_status in ('returned','rejected')) then t.revision:=t.revision+1; end if;
 if next_status='review' and t.internal_approved_by is not null and (not t.requires_client_approval or t.client_approved_by is not null) then next_status:='done'; end if;
 update public.tasks set status=next_status, assignee_id=next_assignee, internal_approved_by=t.internal_approved_by,
  client_approved_by=t.client_approved_by, client_approval_note=t.client_approval_note, revision=t.revision,
  version=version+1, delivered_at=case when next_status='done' then now() else null end where id=t.id;
 insert into public.task_events(company_id,task_id,actor_id,action,detail) values(t.company_id,t.id,me,p_action,
  jsonb_build_object('note',p_note,'from',t.status,'to',next_status,'revision',t.revision,'due_date',t.due_date,
   'assignee_from',t.assignee_id,'assignee_to',next_assignee,'status_since',t.status_changed_at));
 -- A written note also joins the conversation, headed by what changed.
 if length(trim(p_note))>0 then
  label := case p_action when 'approve_internal' then 'Aprovada na validação'
   when 'approve_client' then 'Aprovação do cliente registrada'
   when 'reopen' then 'Tarefa reaberta · ' || mavi_private.status_label(next_status)
   else case when next_status<>t.status then mavi_private.status_label(next_status) else 'Responsável alterado' end end;
  if next_assignee<>t.assignee_id then
   label := label || ' · Responsável: ' || coalesce((select name from public.memberships
    where company_id=t.company_id and user_id=next_assignee),'—');
  end if;
  insert into public.comments(company_id,task_id,body) values(t.company_id,t.id,mavi_private.transition_comment(label,p_note));
 end if;
 select * into t from public.tasks where id=t.id;
 return t;
end $$;
revoke all on function public.transition_task(uuid,integer,text,text,text,uuid) from public, anon;
grant execute on function public.transition_task(uuid,integer,text,text,text,uuid) to authenticated;

commit;
