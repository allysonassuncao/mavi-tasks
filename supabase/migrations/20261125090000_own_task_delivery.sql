begin;

-- Whoever creates a task for themselves delivers it without "Em validação":
-- when the person moving it is both its creator and its responsible, the
-- move to Entregue skips the validator's approval (the client's approval,
-- when the task requires it, is still awaited). Everything else is as in
-- 20260929110000_correction_status.

create or replace function public.transition_task(p_task uuid,p_version integer,p_action text,p_note text default '',
 p_status text default null,p_assignee uuid default null) returns public.tasks
language plpgsql security definer set search_path = '' as $$
declare t public.tasks; next_status text; next_assignee uuid; review_required boolean; is_admin boolean;
 approver boolean; mover boolean; label text; me uuid := auth.uid();
 working constant text[] := array['progress','returned','review','rejected','correction'];
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
   if review_required and not (me = t.creator_id and me = t.assignee_id) then raise exception 'Este projeto exige validação: a entrega é aprovada por quem valida' using errcode='42501'; end if;
   -- Delivered below, unless the client's approval is still pending.
   t.internal_approved_by:=me; next_status:='review';
  elsif p_status = any(working) then next_status:=p_status;
  else raise exception 'Status inválido'; end if;
  if p_status=t.status and next_assignee=t.assignee_id then raise exception 'Escolha outro status ou outro responsável'; end if;
  if next_status<>t.status and next_status='returned' and length(trim(p_note))<3 then raise exception 'Informe quais informações faltam'; end if;
  if next_status<>t.status and next_status='rejected' and length(trim(p_note))<3 then raise exception 'Descreva a alteração solicitada'; end if;
  if next_status<>t.status and next_status='correction' and length(trim(p_note))<3 then raise exception 'Descreva a correção necessária'; end if;
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
 if p_action='reopen' or (next_status<>t.status and next_status in ('returned','rejected','correction')) then t.revision:=t.revision+1; end if;
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
