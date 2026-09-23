begin;

-- @mentions in task comments (and in the notes posted with status changes,
-- which are comments too). Whoever is mentioned becomes a participant of the
-- task, so they can open it, and gets a notification.
--
-- A mention is a rich-text node {"type":"mention","attrs":{"id","label"}}.

-- Participants also live on the task row, so the task list can filter
-- ("Participando") and show them. task_participants stays the access source.
alter table public.tasks add column participant_ids uuid[] not null default '{}';
update public.tasks t set participant_ids = array(
 select p.user_id from public.task_participants p where p.task_id=t.id order by p.added_at);
create index tasks_participants on public.tasks using gin(participant_ids);
create function mavi_private.task_assignee_participant() returns trigger
language plpgsql set search_path = '' as $$ begin
 if not new.assignee_id = any(new.participant_ids) then
  new.participant_ids := new.participant_ids || new.assignee_id;
 end if;
 return new;
end $$;
create trigger task_assignee_participant before insert or update of assignee_id on public.tasks
 for each row execute function mavi_private.task_assignee_participant();

create function mavi_private.add_participant(c uuid, t uuid, u uuid) returns void
language plpgsql security definer set search_path = '' as $$ begin
 insert into public.task_participants(company_id,task_id,user_id) values(c,t,u) on conflict do nothing;
 -- The version is left alone: joining a task doesn't conflict with edits.
 update public.tasks set participant_ids = participant_ids || u
  where company_id=c and id=t and not u = any(participant_ids);
end $$;
revoke all on function mavi_private.add_participant(uuid,uuid,uuid) from public, anon, authenticated;

create table public.notifications (
 id uuid primary key default gen_random_uuid(),
 company_id uuid not null,
 user_id uuid not null,
 actor_id uuid,
 task_id uuid not null,
 comment_id uuid references public.comments(id) on delete cascade,
 kind text not null check(kind in ('mention')),
 read_at timestamptz,
 created_at timestamptz not null default now(),
 foreign key(company_id,user_id) references public.memberships(company_id,user_id),
 foreign key(company_id,task_id) references public.tasks(company_id,id) on delete cascade
);
create index notifications_inbox on public.notifications(company_id,user_id,created_at desc);
alter table public.notifications enable row level security;
-- Each person reads only their own (realtime delivers through this policy).
create policy notifications_read on public.notifications for select to authenticated
 using (user_id = (select auth.uid()) and company_id in (select mavi_private.active_companies()));
grant select on public.notifications to authenticated;
do $$ begin
 if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
  and not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime'
   and schemaname = 'public' and tablename = 'notifications') then
  alter publication supabase_realtime add table public.notifications;
 end if;
end $$;

-- People mentioned in a comment: active members of the company, but not its
-- author.
create function mavi_private.comment_mentions() returns trigger
language plpgsql security definer set search_path = '' as $$
declare prefix constant text := 'mavi:richtext:v1:'; doc jsonb; mentioned uuid; begin
 if left(new.body,length(prefix))<>prefix then return new; end if;
 begin doc := substr(new.body,length(prefix)+1)::jsonb; exception when others then return new; end;
 for mentioned in
  select distinct m.user_id
  from jsonb_path_query(doc,'strict $.** ? (@.type == "mention")') as v(node)
  join public.memberships m on m.company_id=new.company_id and m.active
   and m.user_id::text = v.node->'attrs'->>'id'
  where m.user_id is distinct from new.author_id
 loop
  perform mavi_private.add_participant(new.company_id,new.task_id,mentioned);
  insert into public.notifications(company_id,user_id,actor_id,task_id,comment_id,kind)
   values(new.company_id,mentioned,new.author_id,new.task_id,new.id,'mention');
 end loop;
 return new;
end $$;
create trigger comment_mentions after insert on public.comments
 for each row execute function mavi_private.comment_mentions();

-- Mentions read as "@Name" in plain text (search, notification excerpts).
create or replace function mavi_private.rich_plain(p text) returns text
language plpgsql immutable parallel safe set search_path = '' as $$
declare prefix constant text := 'mavi:richtext:v1:'; doc jsonb; begin
 if p is null or left(p, length(prefix)) <> prefix then return coalesce(p, ''); end if;
 begin
  doc := substr(p, length(prefix) + 1)::jsonb;
 exception when others then return p;
 end;
 return coalesce((select string_agg(case when v.node->>'type' = 'mention'
   then '@' || coalesce(v.node->'attrs'->>'label', '') else v.node->>'text' end, ' ' order by v.n)
  from jsonb_path_query(doc, 'strict $.** ? (@.type == "text" || @.type == "mention")')
   with ordinality as v(node, n)), '');
end $$;

-- The person's latest notifications, with what the screen shows.
create function public.my_notifications(p_company uuid, p_limit integer default 30)
returns table(id uuid, kind text, task_id uuid, task_title text, actor_id uuid, actor_name text,
 excerpt text, read_at timestamptz, created_at timestamptz)
language sql stable security definer set search_path = '' as $$
 select n.id, n.kind, n.task_id, t.title, n.actor_id, m.name,
  left(regexp_replace(mavi_private.rich_plain(c.body), '\s+', ' ', 'g'), 160), n.read_at, n.created_at
 from public.notifications n
 join public.tasks t on t.company_id = n.company_id and t.id = n.task_id
 left join public.memberships m on m.company_id = n.company_id and m.user_id = n.actor_id
 left join public.comments c on c.id = n.comment_id
 where n.company_id = p_company and n.user_id = auth.uid() and mavi_private.member(p_company)
 order by n.created_at desc
 limit least(greatest(coalesce(p_limit, 30), 1), 100)
$$;
revoke all on function public.my_notifications(uuid, integer) from public, anon;
grant execute on function public.my_notifications(uuid, integer) to authenticated;

-- Marks the given notifications (all, when none is given) as read.
create function public.read_notifications(p_company uuid, p_ids uuid[] default null) returns integer
language plpgsql security definer set search_path = '' as $$ declare changed integer; begin
 update public.notifications set read_at = now()
 where company_id = p_company and user_id = auth.uid() and read_at is null
  and (p_ids is null or id = any(p_ids));
 get diagnostics changed = row_count;
 return changed;
end $$;
revoke all on function public.read_notifications(uuid, uuid[]) from public, anon;
grant execute on function public.read_notifications(uuid, uuid[]) to authenticated;

commit;
