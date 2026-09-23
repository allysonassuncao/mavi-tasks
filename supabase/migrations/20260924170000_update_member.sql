begin;

-- Admins and managers edit a person's name, access profile, teams and status.
-- Guardrails: managers cannot edit admins or grant the admin profile; nobody
-- changes their own profile or deactivates themselves; the company always
-- keeps an active admin. People who stop being leaders lose supervision.
create function public.update_member(p_company uuid, p_user uuid, p_name text, p_role text, p_active boolean, p_teams uuid[]) returns void
language plpgsql security definer set search_path = '' as $$
declare target public.memberships; caller_admin boolean; begin
  if not mavi_private.leader(p_company) then raise exception 'Sem permissão' using errcode = '42501'; end if;
  select * into target from public.memberships where company_id = p_company and user_id = p_user for update;
  if not found then raise exception 'Usuário não encontrado na empresa'; end if;
  if p_role not in ('admin', 'manager', 'member') then raise exception 'Perfil de acesso inválido.'; end if;
  if length(trim(coalesce(p_name, ''))) not between 2 and 120 then raise exception 'Informe um nome de 2 a 120 caracteres.'; end if;
  caller_admin := mavi_private.admin(p_company);
  if not caller_admin and (target.role = 'admin' or p_role = 'admin') then
    raise exception 'Somente administradores editam administradores.' using errcode = '42501';
  end if;
  if p_user = auth.uid() and (p_role <> target.role or not p_active) then
    raise exception 'Você não pode alterar o próprio perfil de acesso nem se desativar.' using errcode = '42501';
  end if;
  if target.role = 'admin' and target.active and (p_role <> 'admin' or not p_active) and not exists(
    select 1 from public.memberships
    where company_id = p_company and user_id <> p_user and role = 'admin' and active) then
    raise exception 'A empresa precisa de pelo menos um administrador ativo.';
  end if;

  update public.memberships set name = trim(p_name), role = p_role, active = coalesce(p_active, active)
  where company_id = p_company and user_id = p_user;

  -- Teams: keep supervision in teams the person stays in (if still a leader).
  delete from public.team_members
  where company_id = p_company and user_id = p_user and not (team_id = any(coalesce(p_teams, '{}'::uuid[])));
  insert into public.team_members(company_id, team_id, user_id)
    select p_company, t.id, p_user from public.teams t
    where t.company_id = p_company and t.id = any(coalesce(p_teams, '{}'::uuid[]))
    on conflict do nothing;
  if p_role = 'member' then
    update public.team_members set supervisor = false where company_id = p_company and user_id = p_user;
  end if;
end $$;
revoke all on function public.update_member(uuid, uuid, text, text, boolean, uuid[]) from public, anon;
grant execute on function public.update_member(uuid, uuid, text, text, boolean, uuid[]) to authenticated;

commit;
