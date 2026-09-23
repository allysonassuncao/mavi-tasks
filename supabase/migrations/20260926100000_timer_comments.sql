begin;

-- Play and pause are also posted as comments on the task: "Iniciou o
-- trabalho" on play, "Pausou o trabalho · sessão de 25min" on pause —
-- including the automatic pause when the person starts another task.

-- "1h 05min", "25min", "40s".
create or replace function mavi_private.session_label(p_from timestamptz, p_to timestamptz) returns text
language sql immutable set search_path = '' as $$
 select case
  when s < 60 then s || 's'
  when s < 3600 then (s / 60) || 'min'
  else (s / 3600) || 'h ' || lpad(((s % 3600) / 60)::text, 2, '0') || 'min' end
 from (select greatest(0, floor(extract(epoch from p_to - p_from)))::bigint as s) x
$$;

-- Posts the pause comment for a finished timer session.
create or replace function mavi_private.comment_pause(e public.time_entries, p_automatic boolean) returns void
language sql security definer set search_path = '' as $$
 insert into public.comments(company_id, task_id, author_id, body)
 values (e.company_id, e.task_id, e.user_id, mavi_private.transition_comment(
  case when p_automatic then 'Pausou o trabalho (ao iniciar outra tarefa)' else 'Pausou o trabalho' end,
  'Sessão de ' || mavi_private.session_label(e.started_at, e.ended_at)))
$$;
revoke all on function mavi_private.comment_pause(public.time_entries, boolean) from public, anon, authenticated;

create or replace function public.start_timer(p_task uuid) returns public.time_entries
language plpgsql security definer set search_path = '' as $$
declare t public.tasks; entry public.time_entries; stopped public.time_entries; switched_at timestamptz; begin
 perform pg_advisory_xact_lock(hashtextextended(auth.uid()::text,0));
 select * into t from public.tasks where id=p_task;
 if not found or not mavi_private.task_access(t.company_id,t.id) then raise exception 'Sem permissão' using errcode='42501'; end if;
 select * into entry from public.time_entries where user_id=auth.uid() and ended_at is null and task_id=p_task;
 if found then return entry; end if;
 select greatest(clock_timestamp(),coalesce(max(started_at)+interval '1 millisecond',clock_timestamp())) into switched_at from public.time_entries where user_id=auth.uid() and ended_at is null;
 for stopped in update public.time_entries set ended_at=switched_at where user_id=auth.uid() and ended_at is null returning * loop
  perform mavi_private.comment_pause(stopped, true);
 end loop;
 insert into public.time_entries(company_id,task_id,started_at,source) values(t.company_id,t.id,switched_at,'timer') returning * into entry;
 insert into public.comments(company_id, task_id, body)
 values (t.company_id, t.id, mavi_private.transition_comment('Iniciou o trabalho', ''));
 return entry;
end $$;

create or replace function public.stop_timer(p_entry uuid) returns public.time_entries
language plpgsql security definer set search_path = '' as $$
declare e public.time_entries; begin
 perform pg_advisory_xact_lock(hashtextextended(auth.uid()::text,0));
 select * into e from public.time_entries where id=p_entry for update;
 if not found or e.user_id<>auth.uid() then raise exception 'Sem permissão' using errcode='42501'; end if;
 if e.ended_at is not null then return e; end if;
 update public.time_entries set ended_at=greatest(clock_timestamp(),started_at+interval '1 millisecond') where id=e.id
 returning * into e;
 perform mavi_private.comment_pause(e, false);
 return e;
end $$;

revoke all on function public.start_timer(uuid) from public, anon;
grant execute on function public.start_timer(uuid) to authenticated;
revoke all on function public.stop_timer(uuid) from public, anon;
grant execute on function public.stop_timer(uuid) to authenticated;

commit;
