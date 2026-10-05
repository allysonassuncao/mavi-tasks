begin;

-- Stopping generation and removing copies already created are different
-- operations. Older clients retain the stop-only behavior. New clients can
-- archive later copies, including when the series was already stopped.
drop function public.stop_task_recurrence(uuid);
create function public.stop_task_recurrence(p_task uuid, p_remove_future boolean default false) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
 t public.tasks; r public.task_recurrences; copied public.tasks; timer public.time_entries;
 cutoff date; removed uuid[] := '{}';
begin
 select * into t from public.tasks where id = p_task;
 if not found or t.recurrence_id is null then raise exception 'Esta tarefa não se repete'; end if;
 if auth.uid() is null or not mavi_private.member(t.company_id) then
  raise exception 'Sem acesso à tarefa' using errcode = '42501';
 end if;
 -- Same lock as the generator: once this returns, the series cannot create
 -- another copy. A copy committed by a run already in flight is included.
 select * into r from public.task_recurrences
  where company_id = t.company_id and id = t.recurrence_id for update;
 if not (mavi_private.leader(r.company_id) or r.creator_id = auth.uid()) then
  raise exception 'Só quem programou a repetição ou um gestor pode pará-la' using errcode = '42501';
 end if;
 select * into t from public.tasks where id = p_task for update;
 cutoff := greatest(t.due_date, mavi_private.company_today(t.company_id));
 if r.active then
  update public.task_recurrences set active = false, stopped_by = auth.uid(), stopped_at = now() where id = r.id;
  insert into public.task_events(company_id, task_id, actor_id, action)
   values (t.company_id, t.id, auth.uid(), 'recurrence_stopped');
 end if;
 if coalesce(p_remove_future, false) then
  for copied in select * from public.tasks s
   where s.company_id = r.company_id and s.recurrence_id = r.id
    and s.id <> t.id and s.id <> r.source_task_id
    and s.due_date > cutoff and not s.archived and s.status <> 'done'
   order by s.id for update
  loop
   update public.tasks set archived = true, version = version + 1 where id = copied.id;
   -- Archived tasks must not leave running timers behind. Logged work,
   -- comments and attachments remain available in the stored history.
   for timer in update public.time_entries
    set ended_at = greatest(clock_timestamp(), started_at + interval '1 millisecond')
    where company_id = r.company_id and task_id = copied.id and ended_at is null returning *
   loop
    perform mavi_private.comment_pause(timer, true);
   end loop;
   insert into public.task_events(company_id, task_id, actor_id, action, detail)
    values (r.company_id, copied.id, auth.uid(), 'recurrence_copy_archived',
     jsonb_build_object('recurrence_id', r.id, 'from_task', t.id, 'after_due', cutoff));
   removed := array_append(removed, copied.id);
  end loop;
  if cardinality(removed) > 0 then
   insert into public.task_events(company_id, task_id, actor_id, action, detail)
    values (t.company_id, t.id, auth.uid(), 'recurrence_future_removed',
     jsonb_build_object('count', cardinality(removed), 'after_due', cutoff, 'tasks', removed));
  end if;
 end if;
 return jsonb_build_object('archived_task_ids', removed, 'archived_count', cardinality(removed));
end $$;
revoke all on function public.stop_task_recurrence(uuid, boolean) from public, anon;
grant execute on function public.stop_task_recurrence(uuid, boolean) to authenticated;

commit;
