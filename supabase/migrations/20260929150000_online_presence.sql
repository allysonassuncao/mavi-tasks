begin;

-- Who is online, live: each open app announces itself with Realtime
-- Presence on the private topic "mavi:presence:<company>". Nothing is stored;
-- these policies only decide who may join. Active members of the company
-- may follow who is there (select) and announce themselves (insert).

create policy "mavi members see who is online" on realtime.messages
 for select to authenticated
 using (
  realtime.messages.extension = 'presence'
  and case when (select realtime.topic()) ~ '^mavi:presence:[0-9a-f-]{36}$'
   then mavi_private.member(substr((select realtime.topic()), 15)::uuid)
   else false end
 );

create policy "mavi members announce they are online" on realtime.messages
 for insert to authenticated
 with check (
  realtime.messages.extension = 'presence'
  and case when (select realtime.topic()) ~ '^mavi:presence:[0-9a-f-]{36}$'
   then mavi_private.member(substr((select realtime.topic()), 15)::uuid)
   else false end
 );

commit;
