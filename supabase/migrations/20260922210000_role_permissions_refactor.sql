begin;

-- Helper functions for leader role (admin or manager)
create or replace function mavi_private.leader(c uuid) returns boolean language sql stable security definer set search_path = '' as $$
  select exists(select 1 from public.memberships where company_id = c and user_id = auth.uid() and active and role in ('admin', 'manager'))
$$;

create or replace function mavi_private.leader_companies() returns setof uuid language sql stable security definer set search_path = '' as $$
  select company_id from public.memberships where user_id = (select auth.uid()) and active and role in ('admin', 'manager')
$$;

revoke all on function mavi_private.leader(uuid), mavi_private.leader_companies() from public, anon;
grant execute on function mavi_private.leader(uuid), mavi_private.leader_companies() to authenticated;

-- Task and contract access permissions
create or replace function mavi_private.task_access(c uuid, t uuid) returns boolean language sql stable security definer set search_path = '' as $$
  select mavi_private.member(c) and exists(select 1 from public.tasks where company_id = c and id = t and
    (mavi_private.leader(c) or creator_id = auth.uid() or assignee_id = auth.uid()))
$$;

create or replace function mavi_private.can_work(c uuid, t uuid) returns boolean language sql stable security definer set search_path = '' as $$
  select mavi_private.task_access(c, t) and exists(select 1 from public.tasks where company_id = c and id = t and
    (mavi_private.leader(c) or creator_id = auth.uid() or assignee_id = auth.uid()))
$$;

create or replace function mavi_private.can_edit(c uuid, t uuid) returns boolean language sql stable security definer set search_path = '' as $$
  select mavi_private.task_access(c, t) and exists(select 1 from public.tasks where company_id = c and id = t and
    (mavi_private.leader(c) or creator_id = auth.uid()))
$$;

create or replace function mavi_private.can_approve(c uuid, t uuid) returns boolean language sql stable security definer set search_path = '' as $$
  select mavi_private.task_access(c, t) and exists(select 1 from public.tasks where company_id = c and id = t and
    (mavi_private.leader(c) or creator_id = auth.uid()))
$$;

-- RLS policies update
alter policy tasks_read on public.tasks using (
  company_id in (select mavi_private.active_companies()) and (
    company_id in (select mavi_private.leader_companies()) or
    creator_id = (select auth.uid()) or
    assignee_id = (select auth.uid())
  )
);

alter policy clients_read on public.clients using (
  mavi_private.leader(company_id) or exists(
    select 1 from public.contracts k join public.tasks t on t.contract_id = k.id
    where k.company_id = clients.company_id and k.client_id = clients.id and (
      mavi_private.contract_access(k.company_id, k.id) or t.creator_id = auth.uid() or t.assignee_id = auth.uid()
    )
  )
);

alter policy contracts_read on public.contracts using (
  company_id in (select mavi_private.active_companies()) and (
    company_id in (select mavi_private.leader_companies()) or
    id in (select mavi_private.team_contracts()) or
    id in (select mavi_private.own_contracts())
  )
);

-- Entity creation and update functions allowing leaders (admin & manager)
create or replace function public.create_client(p_company uuid, p_name text, p_email text default '') returns uuid
language plpgsql security definer set search_path = '' as $$ declare result uuid; begin
  if not mavi_private.leader(p_company) then raise exception 'Sem permissão para cadastrar clientes' using errcode = '42501'; end if;
  insert into public.clients(company_id, name, email) values(p_company, trim(p_name), trim(p_email)) returning id into result;
  return result;
end $$;

create or replace function public.create_product(p_company uuid, p_name text) returns uuid
language plpgsql security definer set search_path = '' as $$ declare result uuid; begin
  if not mavi_private.leader(p_company) then raise exception 'Sem permissão' using errcode = '42501'; end if;
  insert into public.products(company_id, name) values(p_company, trim(p_name)) returning id into result;
  return result;
end $$;

create or replace function public.create_contract(p_company uuid, p_client uuid, p_product uuid, p_name text, p_team uuid default null) returns uuid
language plpgsql security definer set search_path = '' as $$ declare result uuid; begin
  if not mavi_private.leader(p_company) then raise exception 'Sem permissão' using errcode = '42501'; end if;
  insert into public.contracts(company_id, client_id, product_id, name) values(p_company, p_client, p_product, p_name) returning id into result;
  if p_team is not null then insert into public.contract_teams values(p_company, result, p_team); end if;
  return result;
end $$;

create or replace function public.create_project(p_company uuid, p_contract uuid, p_name text, p_due date default null) returns uuid
language plpgsql security definer set search_path = '' as $$ declare result uuid; begin
  if not mavi_private.leader(p_company) then raise exception 'Sem permissão' using errcode = '42501'; end if;
  insert into public.projects(company_id, contract_id, name, due_date) values(p_company, p_contract, trim(p_name), p_due) returning id into result;
  return result;
end $$;

create or replace function public.create_team(p_company uuid, p_name text) returns uuid
language plpgsql security definer set search_path = '' as $$ declare result uuid; begin
  if not mavi_private.leader(p_company) then raise exception 'Sem permissão' using errcode = '42501'; end if;
  insert into public.teams(company_id, name) values(p_company, trim(p_name)) returning id into result;
  return result;
end $$;

create or replace function public.update_client(p_client uuid, p_name text, p_email text) returns void
language plpgsql security definer set search_path = '' as $$
declare c public.clients; begin
  select * into c from public.clients where id = p_client for update;
  if not found or not mavi_private.leader(c.company_id) then raise exception 'Sem permissão' using errcode = '42501'; end if;
  update public.clients set name = trim(p_name), email = trim(p_email) where id = p_client;
end $$;

create or replace function public.update_product(p_product uuid, p_name text) returns void
language plpgsql security definer set search_path = '' as $$
declare p public.products; begin
  select * into p from public.products where id = p_product for update;
  if not found or not mavi_private.leader(p.company_id) then raise exception 'Sem permissão' using errcode = '42501'; end if;
  update public.products set name = trim(p_name) where id = p_product;
end $$;

create or replace function public.update_project(p_project uuid, p_name text, p_due date, p_contract uuid default null) returns void
language plpgsql security definer set search_path = '' as $$
declare p public.projects; begin
  select * into p from public.projects where id = p_project for update;
  if not found or not mavi_private.leader(p.company_id) then raise exception 'Sem permissão' using errcode = '42501'; end if;
  if p_contract is not null and p_contract <> p.contract_id and exists(select 1 from public.tasks where project_id = p_project) then
    raise exception 'Projetos com tarefas não podem mudar de produto contratado.';
  end if;
  update public.projects set name = trim(p_name), due_date = p_due, contract_id = coalesce(p_contract, contract_id) where id = p_project;
end $$;

create or replace function public.update_contract(p_contract uuid, p_name text, p_client uuid, p_product uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare c public.contracts; begin
  select * into c from public.contracts where id = p_contract for update;
  if not found or not mavi_private.leader(c.company_id) then raise exception 'Sem permissão' using errcode = '42501'; end if;
  if length(trim(p_name)) not between 2 and 160 then raise exception 'Informe um nome de 2 a 160 caracteres'; end if;
  update public.contracts set name = trim(p_name), client_id = p_client, product_id = p_product where id = p_contract;
end $$;

create or replace function public.assign_user_teams(
  p_company uuid,
  p_user uuid,
  p_teams uuid[]
) returns void
language plpgsql security definer set search_path = '' as $$
declare tid uuid; begin
  if not mavi_private.leader(p_company) then
    raise exception 'Sem permissão' using errcode = '42501';
  end if;

  if not exists (
    select 1 from public.memberships
    where company_id = p_company and user_id = p_user
  ) then
    raise exception 'Usuário não encontrado na empresa';
  end if;

  delete from public.team_members
  where company_id = p_company and user_id = p_user;

  if p_teams is not null then
    foreach tid in array p_teams loop
      if exists (select 1 from public.teams where company_id = p_company and id = tid) then
        insert into public.team_members(company_id, team_id, user_id)
        values(p_company, tid, p_user)
        on conflict do nothing;
      end if;
    end loop;
  end if;
end $$;

create or replace function mavi_private.consume_invite_limit(p_company uuid, p_actor uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare w timestamptz := date_trunc('hour', statement_timestamp()); s text; cap integer; n integer; begin
  if not exists(select 1 from public.memberships where company_id = p_company and user_id = p_actor and active and role in ('admin', 'manager'))
  then raise exception 'Sem permissão' using errcode = '42501'; end if;
  perform pg_advisory_xact_lock(hashtextextended('invite:' || p_company::text, 0));
  foreach s in array array['company', p_actor::text] loop
    cap := case when s = 'company' then 50 else 10 end;
    select used into n from mavi_private.invite_limits where company_id = p_company and scope = s and window_start = w;
    if coalesce(n, 0) >= cap then
      return jsonb_build_object('allowed', false, 'retry_after', greatest(1, ceil(extract(epoch from (w + interval '1 hour' - statement_timestamp())))));
    end if;
  end loop;
  foreach s in array array['company', p_actor::text] loop
    insert into mavi_private.invite_limits values(p_company, s, w, 1)
    on conflict(company_id, scope) do update set window_start = w,
      used = case when invite_limits.window_start = w then invite_limits.used + 1 else 1 end;
  end loop;
  return jsonb_build_object('allowed', true, 'retry_after', 0);
end $$;

commit;
