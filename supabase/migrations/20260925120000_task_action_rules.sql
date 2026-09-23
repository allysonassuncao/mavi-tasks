begin;

-- Task action rules (REGRAS_BOTOES_TAREFA), mirrored by taskActions() in the
-- frontend:
-- * Requesting validation / concluding is for the assignee (or an admin), and
--   validation requests need a description.
-- * Approving internally needs observations; client approval only after the
--   internal approval.
-- * Returning is never done by the creator: the assignee returns open,
--   in-progress or rejected tasks; admins may also return tasks in validation.
-- * Reopening a delivered task is for its creator, assignee or validator, up
--   to 2 days after delivery (admins at any time).
-- * A returned task goes back to execution only through its creator (or an
--   admin), with an explanation.
-- Every written reason is also posted as a comment.
create or replace function public.transition_task(p_task uuid,p_version integer,p_action text,p_note text default '') returns public.tasks
language plpgsql security definer set search_path = '' as $$ declare t public.tasks; next_status text; review_required boolean; is_admin boolean; me uuid := auth.uid(); begin
 select * into t from public.tasks where id=p_task for update;
 if not found or not mavi_private.can_work(t.company_id,t.id) then raise exception 'Sem acesso à tarefa' using errcode='42501'; end if;
 if t.version<>p_version then raise exception 'A tarefa mudou. Atualize antes de continuar.' using errcode='40001'; end if;
 review_required := coalesce((select requires_review from public.projects where company_id=t.company_id and id=t.project_id), true);
 is_admin := mavi_private.admin(t.company_id);
 next_status:=t.status;
 case p_action
 when 'start' then
  if t.status not in ('open','returned','rejected') then raise exception 'Transição inválida'; end if;
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
