begin;

-- The inbox moves from postgres_changes to Broadcast, like the rest of the
-- live updates (live_task_sync). While anyone has a postgres_changes
-- subscription open, Realtime polls the replication slot with
-- realtime.list_changes() non-stop and decodes every change to the tables
-- in its publication — tasks included, which nothing listens to any more.
-- That polling was most of the database's time. With no postgres_changes
-- subscribers and an empty publication, it stops.
do $$ declare t text; begin
 foreach t in array array['tasks', 'notifications'] loop
  if exists (select 1 from pg_publication_tables
   where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t) then
   execute format('alter publication supabase_realtime drop table public.%I', t);
  end if;
 end loop;
end $$;

-- Each new notification is announced on the person's own private topic
-- "mavi:inbox:<company>:<user>", carrying only ids: the app then reloads
-- its inbox through my_notifications.
create function mavi_private.broadcast_notification() returns trigger
language plpgsql security definer set search_path = '' as $$ begin
 perform realtime.send(
  jsonb_build_object('id', new.id, 'task_id', new.task_id, 'company_id', new.company_id, 'kind', new.kind),
  'notification', 'mavi:inbox:' || new.company_id || ':' || new.user_id, true);
 return null;
exception when others then
 -- The notification stays in the inbox even if it can't be announced.
 raise warning 'mavi inbox broadcast failed: %', sqlerrm;
 return null;
end $$;
revoke all on function mavi_private.broadcast_notification() from public, anon, authenticated;
create trigger broadcast_notification after insert on public.notifications
 for each row execute function mavi_private.broadcast_notification();

-- Only the person, while an active member of the company, joins it.
create policy "mavi people receive their own notifications" on realtime.messages
 for select to authenticated
 using (
  realtime.messages.extension = 'broadcast'
  and case when (select realtime.topic()) ~ '^mavi:inbox:[0-9a-f-]{36}:[0-9a-f-]{36}$'
   then split_part((select realtime.topic()), ':', 4)::uuid = (select auth.uid())
    and mavi_private.member(split_part((select realtime.topic()), ':', 3)::uuid)
   else false end
 );

commit;
