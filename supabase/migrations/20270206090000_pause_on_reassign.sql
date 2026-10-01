begin;

-- Trocar o responsável da tarefa pausa o cronômetro de quem a tinha.
--
-- Até aqui só a mudança de status pausava (migração 20260929090000). Ao
-- transferir sem mudar o status, o cronômetro do responsável antigo
-- continuava rodando. Como no status, fica no banco, para todo caminho que
-- troca o responsável (Editar, em massa, menu de status, distribuição para a
-- equipe), e vira comentário na tarefa ("Pausou o
-- trabalho (tarefa transferida para Bia) · Sessão de 25min"). Os outros que
-- cronometram a tarefa (participantes) seguem; quem saiu pode dar play de
-- novo, como participante. Com o status mudando junto, quem pausa (todos os
-- cronômetros da tarefa) é pause_on_status_change, com o comentário do status.
create function mavi_private.pause_on_reassign() returns trigger
language plpgsql security definer set search_path = '' as $$
declare e public.time_entries; receiver text; begin
 select m.name into receiver from public.memberships m
  where m.company_id = new.company_id and m.user_id = new.assignee_id;
 for e in
  update public.time_entries
   set ended_at = greatest(clock_timestamp(), started_at + interval '1 millisecond')
   where company_id = new.company_id and task_id = new.id and user_id = old.assignee_id and ended_at is null
   returning *
 loop
  insert into public.comments(company_id, task_id, author_id, body)
  values (e.company_id, e.task_id, e.user_id, mavi_private.transition_comment(
   'Pausou o trabalho (tarefa transferida para ' || coalesce(split_part(receiver, ' ', 1), 'outra pessoa') || ')',
   'Sessão de ' || mavi_private.session_label(e.started_at, e.ended_at)));
 end loop;
 return null;
end $$;
revoke all on function mavi_private.pause_on_reassign() from public, anon, authenticated;
create trigger pause_on_reassign after update of assignee_id on public.tasks
 for each row when (old.assignee_id is distinct from new.assignee_id and old.assignee_id is not null
  and old.status is not distinct from new.status)
 execute function mavi_private.pause_on_reassign();

commit;
