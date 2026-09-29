begin;

-- The list's "Equipes" and "Outras" tabs used to send, in the request URL,
-- every contract of every client served by the person's teams — a URL that
-- grows with the portfolio until the gateway rejects it. Each task now keeps
-- the teams responsible for it (its own team or, without one, its client's
-- teams), so those tabs filter by the person's few team ids on an index.
alter table public.tasks add column scope_teams uuid[] not null default '{}';
comment on column public.tasks.scope_teams is
 'Teams responsible for the task: its team, or its client''s teams when it has none. Kept by the database (20261205090000).';

-- A contract's client teams, sorted so unchanged sets compare equal.
create function mavi_private.contract_scope_teams(c uuid, k uuid) returns uuid[]
language sql stable security definer set search_path = '' as $$
 select coalesce(array_agg(distinct ct.team_id order by ct.team_id), '{}')
 from public.contracts kk
 join public.client_teams ct on ct.company_id = kk.company_id and ct.client_id = kk.client_id
 where kk.company_id = c and kk.id = k
$$;
revoke all on function mavi_private.contract_scope_teams(uuid, uuid) from public, anon, authenticated;

-- Existing tasks, without a realtime notice for each of them.
alter table public.tasks disable trigger broadcast_task;
update public.tasks set scope_teams = case when team_id is not null then array[team_id]
 else mavi_private.contract_scope_teams(company_id, contract_id) end;
alter table public.tasks enable trigger broadcast_task;

create index tasks_scope_teams on public.tasks using gin(scope_teams);

-- The task's own team or contract changes (also overrides any direct write).
create function mavi_private.set_task_scope_teams() returns trigger
language plpgsql security definer set search_path = '' as $$ begin
 new.scope_teams := case when new.team_id is not null then array[new.team_id]
  else mavi_private.contract_scope_teams(new.company_id, new.contract_id) end;
 return new;
end $$;
revoke all on function mavi_private.set_task_scope_teams() from public, anon, authenticated;
create trigger set_task_scope_teams before insert or update of team_id, contract_id, scope_teams on public.tasks
 for each row execute function mavi_private.set_task_scope_teams();

-- A client's teams change: its tasks without a team follow.
create function mavi_private.refresh_client_scope_teams() returns trigger
language plpgsql security definer set search_path = '' as $$ begin
 update public.tasks t set scope_teams = mavi_private.contract_scope_teams(t.company_id, t.contract_id)
 from public.contracts k
 where k.company_id = t.company_id and k.id = t.contract_id and t.team_id is null
  and (k.company_id, k.client_id) in (select distinct company_id, client_id from changed)
  and t.scope_teams is distinct from mavi_private.contract_scope_teams(t.company_id, t.contract_id);
 return null;
end $$;
revoke all on function mavi_private.refresh_client_scope_teams() from public, anon, authenticated;
create trigger refresh_scope_teams_ins after insert on public.client_teams
 referencing new table as changed for each statement execute function mavi_private.refresh_client_scope_teams();
create trigger refresh_scope_teams_del after delete on public.client_teams
 referencing old table as changed for each statement execute function mavi_private.refresh_client_scope_teams();

-- A contract moves to another client (update_contract): same for its tasks.
create function mavi_private.refresh_contract_scope_teams() returns trigger
language plpgsql security definer set search_path = '' as $$ begin
 update public.tasks t set scope_teams = mavi_private.contract_scope_teams(t.company_id, t.contract_id)
 from new_rows n join old_rows o on o.id = n.id
 where n.client_id is distinct from o.client_id
  and t.company_id = n.company_id and t.contract_id = n.id and t.team_id is null;
 return null;
end $$;
revoke all on function mavi_private.refresh_contract_scope_teams() from public, anon, authenticated;
create trigger refresh_scope_teams_upd after update on public.contracts
 referencing old table as old_rows new table as new_rows for each statement
 execute function mavi_private.refresh_contract_scope_teams();

commit;
