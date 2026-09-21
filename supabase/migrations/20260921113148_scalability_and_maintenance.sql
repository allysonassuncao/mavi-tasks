begin;
-- A range column after status <> cannot efficiently bound the index scan.
create index tasks_late_due on public.tasks(company_id,due_date,id)
 where not archived and status <> 'done';
create index if not exists task_events_company_created on public.task_events(company_id,created_at);
create index task_events_retention on public.task_events(created_at,id);
create index attachments_task_created on public.attachments(company_id,task_id,created_at desc,id desc);

-- Uncorrelated sets are evaluated once per statement, not once per task.
-- Private owner lookups avoid recursive policies; all derive identity from auth.uid().
create function mavi_private.active_companies() returns setof uuid
language sql stable security definer set search_path='' as $$
 select company_id from public.memberships where user_id=(select auth.uid()) and active
$$;
create function mavi_private.admin_companies() returns setof uuid
language sql stable security definer set search_path='' as $$
 select company_id from public.memberships where user_id=(select auth.uid()) and active and role='admin'
$$;
create function mavi_private.team_contracts() returns setof uuid
language sql stable security definer set search_path='' as $$
 select distinct ct.contract_id from public.contract_teams ct
 join public.team_members tm using(company_id,team_id)
 join public.memberships m using(company_id,user_id)
 where tm.user_id=(select auth.uid()) and m.active
$$;
create function mavi_private.own_contracts() returns setof uuid
language sql stable security definer set search_path='' as $$
 select distinct t.contract_id from public.tasks t join public.memberships m using(company_id)
 where m.user_id=(select auth.uid()) and m.active
 and (t.creator_id=m.user_id or t.assignee_id=m.user_id)
$$;
revoke all on function mavi_private.active_companies(),mavi_private.admin_companies(),mavi_private.team_contracts(),mavi_private.own_contracts() from public,anon;
grant execute on function mavi_private.active_companies(),mavi_private.admin_companies(),mavi_private.team_contracts(),mavi_private.own_contracts() to authenticated;

alter policy tasks_read on public.tasks using (
 company_id in (select mavi_private.active_companies()) and (
 company_id in (select mavi_private.admin_companies()) or
 contract_id in (select mavi_private.team_contracts()) or
 creator_id=(select auth.uid()) or assignee_id=(select auth.uid()))
);
alter policy contracts_read on public.contracts using (
 company_id in (select mavi_private.active_companies()) and (
 company_id in (select mavi_private.admin_companies()) or
 id in (select mavi_private.team_contracts()) or id in (select mavi_private.own_contracts()))
);
-- Child records use the optimized tasks policy, including active membership.
alter policy comments_read on public.comments using (exists(
 select 1 from public.tasks t where t.company_id=comments.company_id and t.id=comments.task_id));
alter policy events_read on public.task_events using (exists(
 select 1 from public.tasks t where t.company_id=task_events.company_id and t.id=task_events.task_id));
alter policy attachments_read on public.attachments using (exists(
 select 1 from public.tasks t where t.company_id=attachments.company_id and t.id=attachments.task_id));

-- Invoker RPC keeps RLS and returns exactly the same bounded collections.
create function public.task_extras(p_task uuid) returns jsonb
language plpgsql stable security invoker set search_path='' as $$
declare c uuid; begin
 select company_id into c from public.tasks where id=p_task;
 if not found then raise exception 'Sem acesso à tarefa' using errcode='42501'; end if;
 return jsonb_build_object(
 'comments',(select coalesce(jsonb_agg(r order by r.created_at desc,r.id desc),'[]'::jsonb) from
   (select * from public.comments where company_id=c and task_id=p_task order by created_at desc,id desc limit 100) r),
 'attachments',(select coalesce(jsonb_agg(r order by r.created_at desc,r.id desc),'[]'::jsonb) from
   (select * from public.attachments where company_id=c and task_id=p_task order by created_at desc,id desc limit 100) r),
 'events',(select coalesce(jsonb_agg(r order by r.created_at desc,r.id desc),'[]'::jsonb) from
   (select * from public.task_events where company_id=c and task_id=p_task order by created_at desc,id desc limit 100) r));
end $$;
revoke all on function public.task_extras(uuid) from public,anon;
grant execute on function public.task_extras(uuid) to authenticated;

-- One calendar month, as requested. Bounded batches avoid long transactions.
create function mavi_private.prune_task_events() returns integer
language plpgsql security definer set search_path='' as $$
declare removed integer; begin
 with expired as (select id from public.task_events
   where created_at < now()-interval '1 month' order by created_at,id limit 5000 for update skip locked)
 delete from public.task_events e using expired x where e.id=x.id;
 get diagnostics removed = row_count;
 return removed;
end $$;
revoke all on function mavi_private.prune_task_events() from public,anon,authenticated;

-- Atomic, shared across Edge instances. Failed Auth sends also consume quota.
create table mavi_private.invite_limits (
 company_id uuid not null references public.companies(id),
 scope text not null,
 window_start timestamptz not null,
 used integer not null check(used>0),
 primary key(company_id,scope)
);
alter table mavi_private.invite_limits enable row level security;
revoke all on mavi_private.invite_limits from public,anon,authenticated;
create function mavi_private.consume_invite_limit(p_company uuid,p_actor uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare w timestamptz:=date_trunc('hour',statement_timestamp()); s text; cap integer; n integer; begin
 if not exists(select 1 from public.memberships where company_id=p_company and user_id=p_actor and active and role='admin')
 then raise exception 'Sem permissão' using errcode='42501'; end if;
 perform pg_advisory_xact_lock(hashtextextended('invite:'||p_company::text,0));
 foreach s in array array['company',p_actor::text] loop
  cap:=case when s='company' then 50 else 10 end;
  select used into n from mavi_private.invite_limits where company_id=p_company and scope=s and window_start=w;
  if coalesce(n,0)>=cap then
   return jsonb_build_object('allowed',false,'retry_after',greatest(1,ceil(extract(epoch from (w+interval '1 hour'-statement_timestamp())))));
  end if;
 end loop;
 foreach s in array array['company',p_actor::text] loop
  insert into mavi_private.invite_limits values(p_company,s,w,1)
  on conflict(company_id,scope) do update set window_start=w,
   used=case when invite_limits.window_start=w then invite_limits.used+1 else 1 end;
 end loop;
 return jsonb_build_object('allowed',true,'retry_after',0);
end $$;
create function public.consume_invite_limit(p_company uuid,p_actor uuid) returns jsonb
language sql security invoker set search_path='' as $$ select mavi_private.consume_invite_limit(p_company,p_actor) $$;
revoke all on function mavi_private.consume_invite_limit(uuid,uuid),public.consume_invite_limit(uuid,uuid) from public,anon,authenticated;
grant usage on schema mavi_private to service_role;
grant execute on function mavi_private.consume_invite_limit(uuid,uuid),public.consume_invite_limit(uuid,uuid) to service_role;

-- Tombstones survive failed Storage calls. Removing draft metadata under a row
-- lock makes binding and collection mutually exclusive. No SQL deletes of blobs.
create table mavi_private.storage_cleanup (
 bucket_id text not null check(bucket_id in ('mavi-attachments','mavi-inline-images')),
 path text not null,
 next_attempt_at timestamptz not null default now(),
 attempts integer not null default 0,
 primary key(bucket_id,path)
);
create index storage_cleanup_pending on mavi_private.storage_cleanup(next_attempt_at);
alter table mavi_private.storage_cleanup enable row level security;
revoke all on mavi_private.storage_cleanup from public,anon,authenticated;
create index inline_images_pending on public.inline_images(created_at,id) where task_id is null;
create index attachments_pending on public.attachments(created_at,id);

create function mavi_private.claim_storage_cleanup() returns table(bucket_id text,path text)
language plpgsql security definer set search_path='' as $$ begin
 -- Uploaded but never bound, or abandoned before upload. Bind takes the same lock.
 with expired as (select id from public.inline_images where task_id is null
   and created_at<now()-interval '24 hours' order by created_at,id limit 100 for update skip locked),
 removed as (delete from public.inline_images i using expired e where i.id=e.id returning i.path)
 insert into mavi_private.storage_cleanup(bucket_id,path)
 select 'mavi-inline-images',r.path from removed r on conflict do nothing;
 -- Attachment metadata already links to a task at prepare time; preserve every
 -- successfully uploaded attachment, including ones the client failed to confirm.
 with expired as (select a.id from public.attachments a where a.created_at<now()-interval '24 hours'
   and not exists(select 1 from storage.objects o where o.bucket_id='mavi-attachments' and o.name=a.path)
   order by a.created_at,a.id limit 100 for update of a skip locked),
 removed as (delete from public.attachments a using expired e where a.id=e.id returning a.path)
 insert into mavi_private.storage_cleanup(bucket_id,path)
 select 'mavi-attachments',r.path from removed r on conflict do nothing;
 -- Includes objects whose upload finished after their pending metadata expired.
 insert into mavi_private.storage_cleanup(bucket_id,path)
 select o.bucket_id,o.name from storage.objects o
 where o.bucket_id in ('mavi-attachments','mavi-inline-images') and o.created_at<now()-interval '24 hours'
 and not exists(select 1 from public.attachments a where o.bucket_id='mavi-attachments' and a.path=o.name)
 and not exists(select 1 from public.inline_images i where o.bucket_id='mavi-inline-images' and i.path=o.name)
 and not exists(select 1 from mavi_private.storage_cleanup q where q.bucket_id=o.bucket_id and q.path=o.name)
 order by o.created_at,o.id limit 100 on conflict do nothing;
 return query
 with pending as (select q.bucket_id,q.path from mavi_private.storage_cleanup q
   where q.next_attempt_at<=now() order by q.next_attempt_at,q.bucket_id,q.path limit 100 for update skip locked)
 update mavi_private.storage_cleanup q set next_attempt_at=now()+interval '15 minutes',attempts=q.attempts+1
 from pending p where q.bucket_id=p.bucket_id and q.path=p.path returning q.bucket_id,q.path;
end $$;
create function mavi_private.complete_storage_cleanup(p_bucket text,p_paths text[]) returns void
language sql security definer set search_path='' as $$
 delete from mavi_private.storage_cleanup where bucket_id=p_bucket and path=any(p_paths)
$$;
create function public.claim_storage_cleanup() returns table(bucket_id text,path text)
language sql security invoker set search_path='' as $$ select * from mavi_private.claim_storage_cleanup() $$;
create function public.complete_storage_cleanup(p_bucket text,p_paths text[]) returns void
language sql security invoker set search_path='' as $$ select mavi_private.complete_storage_cleanup(p_bucket,p_paths) $$;
revoke all on function mavi_private.claim_storage_cleanup(),mavi_private.complete_storage_cleanup(text,text[]),public.claim_storage_cleanup(),public.complete_storage_cleanup(text,text[]) from public,anon,authenticated;
grant execute on function mavi_private.claim_storage_cleanup(),mavi_private.complete_storage_cleanup(text,text[]),public.claim_storage_cleanup(),public.complete_storage_cleanup(text,text[]) to service_role;

-- Hosted Supabase supports pg_cron; embedded PostgreSQL used in tests does not.
-- The Edge invocation is installed separately once its Vault secret is available.
do $$ begin
 if exists(select 1 from pg_available_extensions where name='pg_cron') then
  create extension if not exists pg_cron;
  perform cron.schedule('mavi-task-event-retention','*/10 * * * *','select mavi_private.prune_task_events()');
  perform cron.schedule('mavi-invite-limit-cleanup','15 3 * * *',
   $job$delete from mavi_private.invite_limits where window_start<now()-interval '2 days'$job$);
 else
  raise notice 'pg_cron unavailable: retention must be scheduled on the hosted database';
 end if;
end $$;
commit;
