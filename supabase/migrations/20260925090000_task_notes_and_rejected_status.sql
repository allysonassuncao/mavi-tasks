begin;

-- "Reprovada" becomes its own status: a task sent back by the validator stays
-- visibly rejected until the assignee resumes it. Returned, rejected and
-- in-validation tasks can no longer be sent to validation directly.
do $$ declare c record; begin
 for c in select conname from pg_constraint
  where conrelid='public.tasks'::regclass and contype='c'
   and pg_get_constraintdef(oid) like '%status%returned%' loop
  execute format('alter table public.tasks drop constraint %I',c.conname);
 end loop;
end $$;
alter table public.tasks add constraint tasks_status_check
 check(status in ('open','progress','returned','rejected','review','done'));

-- Builds the comment posted with a transition note: a bold label followed by
-- the note itself (rich text, or legacy plain text split into paragraphs).
create or replace function mavi_private.transition_comment(p_label text,p_note text) returns text
language plpgsql immutable set search_path = '' as $$ declare
 prefix constant text := 'mavi:richtext:v1:'; doc jsonb; label jsonb;
begin
 label := jsonb_build_object('type','paragraph','content',jsonb_build_array(
  jsonb_build_object('type','text','text',p_label,'marks',jsonb_build_array(jsonb_build_object('type','bold')))));
 if left(p_note,length(prefix))=prefix then
  begin doc := substr(p_note,length(prefix)+1)::jsonb; exception when others then doc := null; end;
 end if;
 if doc is null or doc->>'type' is distinct from 'doc' then
  doc := jsonb_build_object('type','doc','content',(
   select coalesce(jsonb_agg(case when line='' then jsonb_build_object('type','paragraph')
    else jsonb_build_object('type','paragraph','content',jsonb_build_array(jsonb_build_object('type','text','text',line))) end order by n),'[]'::jsonb)
   from unnest(string_to_array(trim(p_note),E'\n')) with ordinality as l(line,n)));
 end if;
 return prefix || jsonb_build_object('type','doc','content',jsonb_build_array(label) || coalesce(doc->'content','[]'::jsonb))::text;
end $$;
revoke all on function mavi_private.transition_comment(text,text) from public, anon, authenticated;

create or replace function public.transition_task(p_task uuid,p_version integer,p_action text,p_note text default '') returns public.tasks
language plpgsql security definer set search_path = '' as $$ declare t public.tasks; next_status text; review_required boolean; begin
 select * into t from public.tasks where id=p_task for update;
 if not found or not mavi_private.can_work(t.company_id,t.id) then raise exception 'Sem acesso à tarefa' using errcode='42501'; end if;
 if t.version<>p_version then raise exception 'A tarefa mudou. Atualize antes de continuar.' using errcode='40001'; end if;
 review_required := coalesce((select requires_review from public.projects where company_id=t.company_id and id=t.project_id), true);
 next_status:=t.status;
 case p_action
 when 'start' then
  if t.status not in ('open','returned','rejected') then raise exception 'Transição inválida'; end if; next_status:='progress';
 when 'return' then
  if t.status not in ('open','progress','review','rejected') or length(trim(p_note))<3 then raise exception 'Informe o motivo da devolução'; end if; next_status:='returned';
 when 'submit' then
  if t.status not in ('open','progress') then raise exception 'Retome a tarefa antes de enviá-la para validação'; end if; next_status:='review';
  if not review_required then t.internal_approved_by:=auth.uid(); end if;
 when 'reject' then
  if t.status<>'review' or not mavi_private.can_approve(t.company_id,t.id) then raise exception 'Sem permissão para reprovar' using errcode='42501'; end if;
  if length(trim(p_note))<3 then raise exception 'Informe o motivo da reprovação'; end if; next_status:='rejected';
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
 -- The reason given when returning or validating also joins the conversation.
 if p_action in ('return','reject','approve_client','reopen') and length(trim(p_note))>0 then
  insert into public.comments(company_id,task_id,body) values(t.company_id,t.id,mavi_private.transition_comment(
   case p_action when 'return' then 'Devolvida ao criador' when 'reject' then 'Reprovada na validação'
    when 'approve_client' then 'Aprovação do cliente registrada' else 'Tarefa reaberta' end,p_note));
 end if;
 select * into t from public.tasks where id=t.id;
 return t;
end $$;
revoke all on function public.transition_task(uuid,integer,text,text) from public, anon;
grant execute on function public.transition_task(uuid,integer,text,text) to authenticated;

commit;
