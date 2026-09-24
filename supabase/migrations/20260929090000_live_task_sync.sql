begin;

-- 1. Changing a task's status pauses every timer running on it, whoever
-- started it, and says so in the task's comments ("Pausou o trabalho
-- (status alterado para Em validação) · Sessão de 25min"). Done in the
-- database so every path that moves a task (menu, approval, older apps)
-- behaves the same.
create function mavi_private.pause_on_status_change() returns trigger
language plpgsql security definer set search_path = '' as $$
declare e public.time_entries; begin
 for e in
  update public.time_entries
   set ended_at = greatest(clock_timestamp(), started_at + interval '1 millisecond')
   where company_id = new.company_id and task_id = new.id and ended_at is null
   returning *
 loop
  insert into public.comments(company_id, task_id, author_id, body)
  values (e.company_id, e.task_id, e.user_id, mavi_private.transition_comment(
   'Pausou o trabalho (status alterado para ' || mavi_private.status_label(new.status) || ')',
   'Sessão de ' || mavi_private.session_label(e.started_at, e.ended_at)));
 end loop;
 return null;
end $$;
revoke all on function mavi_private.pause_on_status_change() from public, anon, authenticated;
create trigger pause_on_status_change after update of status on public.tasks
 for each row when (old.status is distinct from new.status)
 execute function mavi_private.pause_on_status_change();

-- 2. Live updates. Every change to a task — and to what hangs from it
-- (comments, attachments, history, time) — is announced on the company's
-- private Realtime topic "mavi:company:<id>". The message carries only ids:
-- which task, what kind of change, and who is involved (creator, assignee,
-- participants, before and after). Each app decides whether it concerns
-- its person, drops that task from its cache and reloads what is on
-- screen, through the usual RLS-checked queries. Broadcast fans out
-- without re-checking row policies per subscriber, unlike
-- postgres_changes, so it scales with the number of people connected.
create function mavi_private.broadcast(p_company uuid, p_payload jsonb) returns void
language plpgsql security definer set search_path = '' as $$ begin
 perform realtime.send(p_payload, 'change', 'mavi:company:' || p_company, true);
exception when others then
 -- A notice that can't be sent must never undo the change itself.
 raise warning 'mavi broadcast failed: %', sqlerrm;
end $$;
revoke all on function mavi_private.broadcast(uuid, jsonb) from public, anon, authenticated;

-- Creator, assignee and participants of a task row, without repeats.
create function mavi_private.task_people(t public.tasks) returns uuid[]
language sql immutable set search_path = '' as $$
 select coalesce(array_agg(distinct u) filter (where u is not null), '{}')
 from unnest(array[t.creator_id, t.assignee_id] || coalesce(t.participant_ids, '{}')) u
$$;
revoke all on function mavi_private.task_people(public.tasks) from public, anon, authenticated;

create function mavi_private.broadcast_task() returns trigger
language plpgsql security definer set search_path = '' as $$
declare people uuid[]; begin
 if tg_op = 'UPDATE' and old is not distinct from new then return null; end if;
 people := case tg_op
  when 'INSERT' then mavi_private.task_people(new)
  when 'DELETE' then mavi_private.task_people(old)
  -- Before and after: whoever lost the task must hear about it too.
  else (select array_agg(distinct u) from unnest(
   mavi_private.task_people(old) || mavi_private.task_people(new)) u) end;
 perform mavi_private.broadcast(coalesce(new.company_id, old.company_id), jsonb_build_object(
  'kind', 'task', 'op', lower(tg_op), 'task', coalesce(new.id, old.id), 'users', to_jsonb(people)));
 return null;
end $$;
revoke all on function mavi_private.broadcast_task() from public, anon, authenticated;
create trigger broadcast_task after insert or update or delete on public.tasks
 for each row execute function mavi_private.broadcast_task();

-- Comments, attachments, history ("extras") and time entries ("hours").
create function mavi_private.broadcast_task_child() returns trigger
language plpgsql security definer set search_path = '' as $$
declare r record; t public.tasks; people uuid[]; begin
 r := coalesce(new, old);
 select * into t from public.tasks where company_id = r.company_id and id = r.task_id;
 people := case when t.id is null then '{}' else mavi_private.task_people(t) end;
 if tg_table_name = 'time_entries' then people := people || r.user_id; end if;
 perform mavi_private.broadcast(r.company_id, jsonb_build_object(
  'kind', case when tg_table_name = 'time_entries' then 'hours' else 'extras' end,
  'op', lower(tg_op), 'task', r.task_id, 'users', to_jsonb(people)));
 return null;
end $$;
revoke all on function mavi_private.broadcast_task_child() from public, anon, authenticated;
create trigger broadcast_comment after insert or update or delete on public.comments
 for each row execute function mavi_private.broadcast_task_child();
create trigger broadcast_attachment after insert or update or delete on public.attachments
 for each row execute function mavi_private.broadcast_task_child();
create trigger broadcast_task_event after insert or update or delete on public.task_events
 for each row execute function mavi_private.broadcast_task_child();
create trigger broadcast_time_entry after insert or update or delete on public.time_entries
 for each row execute function mavi_private.broadcast_task_child();

-- Catalogs (clients, products, projects, teams, people): one notice per
-- company per transaction, however many rows it touched, so an import or a
-- bulk edit doesn't flood the topic.
create function mavi_private.broadcast_lookup() returns trigger
language plpgsql security definer set search_path = '' as $$
declare c uuid := coalesce(new.company_id, old.company_id);
 flag text := 'mavi.lookup_' || replace(c::text, '-', ''); begin
 if coalesce(current_setting(flag, true), '') = '1' then return null; end if;
 perform set_config(flag, '1', true);
 perform mavi_private.broadcast(c, jsonb_build_object('kind', 'lookup', 'table', tg_table_name));
 return null;
end $$;
revoke all on function mavi_private.broadcast_lookup() from public, anon, authenticated;
do $$ declare t text; begin
 foreach t in array array['clients','products','contracts','projects','teams',
  'team_members','client_teams','memberships'] loop
  execute format('create trigger broadcast_lookup after insert or update or delete on public.%I
   for each row execute function mavi_private.broadcast_lookup()', t);
 end loop;
end $$;

-- Only active members of the company may join its topic.
create policy "mavi members receive company changes" on realtime.messages
 for select to authenticated
 using (
  realtime.messages.extension = 'broadcast'
  and case when (select realtime.topic()) ~ '^mavi:company:[0-9a-f-]{36}$'
   then mavi_private.member(substr((select realtime.topic()), 14)::uuid)
   else false end
 );

commit;
