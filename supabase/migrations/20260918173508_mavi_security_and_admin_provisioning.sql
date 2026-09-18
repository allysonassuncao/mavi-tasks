begin;
create index comments_author on public.comments(company_id,author_id);
create index contract_teams_team on public.contract_teams(company_id,team_id);
create index contracts_product on public.contracts(company_id,product_id);
create index tasks_parent on public.tasks(company_id,contract_id,parent_id);
create index tasks_project on public.tasks(company_id,contract_id,project_id);
create index tasks_team on public.tasks(company_id,team_id);
create index time_entries_user on public.time_entries(company_id,user_id);

alter policy hours_read on public.time_entries using(mavi_private.task_access(company_id,task_id) and
 (user_id=(select auth.uid()) or mavi_private.admin(company_id) or exists(
 select 1 from public.tasks t where t.id=time_entries.task_id and mavi_private.manager(time_entries.company_id,t.team_id))));
alter policy mavi_files_insert on storage.objects with check(bucket_id='mavi-attachments' and exists(
 select 1 from public.attachments a where a.path=storage.objects.name and a.uploaded_by=(select auth.uid()) and mavi_private.task_access(a.company_id,a.task_id)));

-- Preserve the platform event trigger; remove only its unnecessary API execution grants.
do $$ begin
 if to_regprocedure('public.rls_auto_enable()') is not null then
  revoke execute on function public.rls_auto_enable() from public,anon,authenticated;
 end if;
end $$;

-- Server-only, one-use allowlist for a verified first administrator.
create table mavi_private.admin_provisioning (
 company_id uuid primary key references public.companies(id),
 email text not null check(email=lower(trim(email))),
 name text not null,
 consumed_by uuid references auth.users(id),
 consumed_at timestamptz,
 created_at timestamptz not null default now()
);
create index admin_provisioning_email on mavi_private.admin_provisioning(email) where consumed_at is null;
alter table mavi_private.admin_provisioning enable row level security;
revoke all on mavi_private.admin_provisioning from public,anon,authenticated;

create function mavi_private.attach_verified_admin() returns trigger
language plpgsql security definer set search_path = '' as $$ declare pending record; begin
 if new.email_confirmed_at is null or new.email is null then return new; end if;
 for pending in select * from mavi_private.admin_provisioning
 where email=lower(trim(new.email)) and consumed_at is null for update loop
  if not exists(select 1 from public.memberships where company_id=pending.company_id and role='admin' and active) then
   insert into public.memberships(company_id,user_id,name,role,active)
   values(pending.company_id,new.id,pending.name,'admin',true);
   update mavi_private.admin_provisioning set consumed_by=new.id,consumed_at=now() where company_id=pending.company_id;
  end if;
 end loop;
 return new;
end $$;
revoke all on function mavi_private.attach_verified_admin() from public,anon,authenticated;
create trigger mavi_verified_admin after insert or update of email_confirmed_at on auth.users
for each row execute function mavi_private.attach_verified_admin();
commit;
