begin;

-- Responsible teams belong to the client, not to each product the client
-- bought: a team serving a client works on all of that client's products,
-- projects and tasks. client_teams replaces contract_teams as the source of
-- team access.
create table public.client_teams (
 company_id uuid not null, client_id uuid not null, team_id uuid not null,
 primary key(company_id,client_id,team_id),
 foreign key(company_id,client_id) references public.clients(company_id,id),
 foreign key(company_id,team_id) references public.teams(company_id,id)
);
create index client_teams_team on public.client_teams(company_id,team_id);
alter table public.client_teams enable row level security;
revoke all on public.client_teams from anon, authenticated;
grant select on public.client_teams to authenticated;
create policy client_teams_read on public.client_teams for select to authenticated
 using(company_id in (select mavi_private.active_companies()));

-- Every team that served one of a client's products now serves the client.
insert into public.client_teams(company_id,client_id,team_id)
 select distinct k.company_id, k.client_id, ct.team_id
 from public.contract_teams ct
 join public.contracts k on k.company_id=ct.company_id and k.id=ct.contract_id
 on conflict do nothing;
comment on table public.contract_teams is
 'Superseded by client_teams (20260923120000); no longer read or written.';

-- Team access to a contracted product now flows through its client.
create or replace function mavi_private.contract_access(c uuid, k uuid) returns boolean language sql stable security definer set search_path = '' as $$
 select mavi_private.member(c) and (mavi_private.admin(c) or exists(
 select 1 from public.contracts kk
 join public.client_teams ct on ct.company_id=kk.company_id and ct.client_id=kk.client_id
 join public.team_members tm on tm.company_id=ct.company_id and tm.team_id=ct.team_id
 where kk.company_id=c and kk.id=k and tm.user_id=auth.uid()))
$$;
create or replace function mavi_private.team_contracts() returns setof uuid
language sql stable security definer set search_path='' as $$
 select distinct k.id from public.client_teams ct
 join public.contracts k on k.company_id=ct.company_id and k.client_id=ct.client_id
 join public.team_members tm on tm.company_id=ct.company_id and tm.team_id=ct.team_id
 join public.memberships m on m.company_id=tm.company_id and m.user_id=tm.user_id
 where tm.user_id=(select auth.uid()) and m.active
$$;

-- Replaces a client's teams; the composite foreign key rejects other companies' teams.
create function mavi_private.set_client_teams(c uuid, p_client uuid, p_teams uuid[]) returns void
language sql security definer set search_path='' as $$
 delete from public.client_teams where company_id=c and client_id=p_client;
 insert into public.client_teams(company_id,client_id,team_id)
  select distinct c, p_client, t from unnest(p_teams) as t where t is not null;
$$;
revoke all on function mavi_private.set_client_teams(uuid,uuid,uuid[]) from public, anon, authenticated;

drop function public.create_client(uuid,text,text);
create function public.create_client(p_company uuid, p_name text, p_email text default '', p_teams uuid[] default null) returns uuid
language plpgsql security definer set search_path = '' as $$ declare result uuid; begin
  if not mavi_private.leader(p_company) then raise exception 'Sem permissão para cadastrar clientes' using errcode = '42501'; end if;
  insert into public.clients(company_id, name, email) values(p_company, trim(p_name), trim(p_email)) returning id into result;
  perform mavi_private.set_client_teams(p_company, result, coalesce(p_teams, '{}'::uuid[]));
  return result;
end $$;

-- p_teams null keeps the client's current teams.
drop function public.update_client(uuid,text,text);
create function public.update_client(p_client uuid, p_name text, p_email text, p_teams uuid[] default null) returns void
language plpgsql security definer set search_path = '' as $$
declare c public.clients; begin
  select * into c from public.clients where id = p_client for update;
  if not found or not mavi_private.leader(c.company_id) then raise exception 'Sem permissão' using errcode = '42501'; end if;
  update public.clients set name = trim(p_name), email = trim(p_email) where id = p_client;
  if p_teams is not null then perform mavi_private.set_client_teams(c.company_id, p_client, p_teams); end if;
end $$;

-- Products no longer carry teams. A p_team from older callers still grants
-- that team access, now through the client.
create or replace function public.create_contract(p_company uuid, p_client uuid, p_product uuid, p_name text, p_team uuid default null) returns uuid
language plpgsql security definer set search_path = '' as $$ declare result uuid; begin
  if not mavi_private.leader(p_company) then raise exception 'Sem permissão' using errcode = '42501'; end if;
  insert into public.contracts(company_id, client_id, product_id, name) values(p_company, p_client, p_product, p_name) returning id into result;
  if p_team is not null then
    insert into public.client_teams values(p_company, p_client, p_team) on conflict do nothing;
  end if;
  return result;
end $$;

-- A task's team must be one of its client's teams.
create or replace function public.create_task(p_company uuid,p_contract uuid,p_title text,p_assignee uuid,p_due date,
 p_project uuid default null,p_team uuid default null,p_description text default '',p_priority text default 'normal',
 p_estimated integer default 0,p_client_approval boolean default false,p_parent uuid default null,p_start date default null) returns uuid
language plpgsql security definer set search_path = '' as $$ declare result uuid; begin
 if not mavi_private.contract_access(p_company,p_contract) then raise exception 'Sem acesso ao produto contratado' using errcode='42501'; end if;
 if not exists(select 1 from public.memberships where company_id=p_company and user_id=p_assignee and active) then raise exception 'Responsável inválido'; end if;
 if p_team is not null and not exists(
  select 1 from public.contracts k join public.client_teams ct on ct.company_id=k.company_id and ct.client_id=k.client_id
  where k.company_id=p_company and k.id=p_contract and ct.team_id=p_team) then raise exception 'Equipe não atende este cliente'; end if;
 if p_parent is not null and not mavi_private.can_edit(p_company,p_parent) then raise exception 'Sem acesso à tarefa principal' using errcode='42501'; end if;
 insert into public.tasks(company_id,contract_id,title,assignee_id,due_date,original_due_date,project_id,team_id,description,priority,estimated_minutes,requires_client_approval,parent_id,start_date)
 values(p_company,p_contract,trim(p_title),p_assignee,p_due,p_due,p_project,p_team,p_description,p_priority,p_estimated,p_client_approval,p_parent,p_start) returning id into result;
 insert into public.task_events(company_id,task_id,actor_id,action) values(p_company,result,auth.uid(),'created'); return result;
end $$;

do $$ declare f record; begin
 for f in select p.oid::regprocedure as signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='public' and p.proname=any(array['create_client','update_client']) loop
 execute format('revoke all on function %s from public,anon',f.signature);
 execute format('grant execute on function %s to authenticated',f.signature);
 end loop;
end $$;

commit;
