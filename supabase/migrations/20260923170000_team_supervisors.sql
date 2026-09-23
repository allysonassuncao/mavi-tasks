begin;

-- Each team names its supervisors: the people who validate the team's tasks
-- in projects set to "Supervisor da equipe". Supervisors must be active
-- managers or admins (collaborators cannot see tasks they don't own).
alter table public.team_members add column supervisor boolean not null default false;

-- Until now the supervisors were the managers in each team; keep them.
update public.team_members tm set supervisor = true
 from public.memberships m
 where m.company_id=tm.company_id and m.user_id=tm.user_id and m.role='manager';

-- Replaces a team's people; supervisors are always members too.
create function mavi_private.set_team_people(c uuid, p_team uuid, p_users uuid[], p_supervisors uuid[]) returns void
language plpgsql security definer set search_path = '' as $$
declare everyone uuid[]; begin
  everyone := array(select distinct u from unnest(coalesce(p_users, '{}'::uuid[]) || coalesce(p_supervisors, '{}'::uuid[])) as u where u is not null);
  if exists(select 1 from unnest(coalesce(p_supervisors, '{}'::uuid[])) as s where not exists(
    select 1 from public.memberships m where m.company_id=c and m.user_id=s and m.active and m.role in ('admin','manager'))) then
    raise exception 'Supervisores precisam ser gestores ou administradores ativos';
  end if;
  delete from public.team_members where company_id=c and team_id=p_team and not (user_id = any(everyone));
  insert into public.team_members(company_id, team_id, user_id, supervisor)
    select c, p_team, u, u = any(coalesce(p_supervisors, '{}'::uuid[])) from unnest(everyone) as u
    on conflict (company_id, team_id, user_id) do update set supervisor = excluded.supervisor;
end $$;
revoke all on function mavi_private.set_team_people(uuid,uuid,uuid[],uuid[]) from public, anon, authenticated;

-- Two create_team overloads coexisted (admin-only with members, leader
-- without members), making two-argument calls ambiguous. Keep one.
drop function public.create_team(uuid,text,uuid[]);
drop function public.create_team(uuid,text);
create function public.create_team(p_company uuid, p_name text, p_users uuid[] default '{}', p_supervisors uuid[] default '{}') returns uuid
language plpgsql security definer set search_path = '' as $$ declare result uuid; begin
  if not mavi_private.leader(p_company) then raise exception 'Sem permissão' using errcode = '42501'; end if;
  if length(trim(p_name)) < 2 then raise exception 'Nome obrigatório'; end if;
  insert into public.teams(company_id, name) values(p_company, trim(p_name)) returning id into result;
  perform mavi_private.set_team_people(p_company, result, p_users, p_supervisors);
  return result;
end $$;

create function public.update_team(p_team uuid, p_name text, p_users uuid[], p_supervisors uuid[] default '{}') returns void
language plpgsql security definer set search_path = '' as $$
declare t public.teams; begin
  select * into t from public.teams where id = p_team for update;
  if not found or not mavi_private.leader(t.company_id) then raise exception 'Sem permissão' using errcode = '42501'; end if;
  if length(trim(p_name)) < 2 then raise exception 'Nome obrigatório'; end if;
  update public.teams set name = trim(p_name) where id = p_team;
  perform mavi_private.set_team_people(t.company_id, p_team, p_users, p_supervisors);
end $$;

-- Changing a person's teams keeps their supervisor role in teams they stay in.
create or replace function public.assign_user_teams(p_company uuid, p_user uuid, p_teams uuid[]) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not mavi_private.leader(p_company) then raise exception 'Sem permissão' using errcode = '42501'; end if;
  if not exists (select 1 from public.memberships where company_id = p_company and user_id = p_user) then
    raise exception 'Usuário não encontrado na empresa';
  end if;
  delete from public.team_members
   where company_id = p_company and user_id = p_user and not (team_id = any(coalesce(p_teams, '{}'::uuid[])));
  insert into public.team_members(company_id, team_id, user_id)
    select p_company, t.id, p_user from public.teams t
    where t.company_id = p_company and t.id = any(coalesce(p_teams, '{}'::uuid[]))
    on conflict do nothing;
end $$;

do $$ declare f record; begin
 for f in select p.oid::regprocedure as signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='public' and p.proname=any(array['create_team','update_team','assign_user_teams']) loop
 execute format('revoke all on function %s from public,anon',f.signature);
 execute format('grant execute on function %s to authenticated',f.signature);
 end loop;
end $$;

-- "Supervisor da equipe" now means the supervisors chosen for the task's team
-- (or for the client's teams when the task has no team).
create or replace function mavi_private.task_supervisor(c uuid, t uuid) returns boolean
language sql stable security definer set search_path = '' as $$
 select exists(
  select 1 from public.tasks tk
  join public.contracts k on k.company_id=tk.company_id and k.id=tk.contract_id
  join public.memberships m on m.company_id=tk.company_id and m.user_id=auth.uid() and m.active and m.role in ('admin','manager')
  join public.team_members tm on tm.company_id=m.company_id and tm.user_id=m.user_id and tm.supervisor
  where tk.company_id=c and tk.id=t and (
   tm.team_id=tk.team_id or (tk.team_id is null and exists(
    select 1 from public.client_teams ct
    where ct.company_id=k.company_id and ct.client_id=k.client_id and ct.team_id=tm.team_id))))
$$;

commit;
