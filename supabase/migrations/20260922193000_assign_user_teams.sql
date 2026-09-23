begin;

create or replace function public.assign_user_teams(
  p_company uuid,
  p_user uuid,
  p_teams uuid[]
) returns void
language plpgsql security definer set search_path = '' as $$
declare
  tid uuid;
begin
  if not mavi_private.admin(p_company) then
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

revoke all on function public.assign_user_teams(uuid, uuid, uuid[]) from public, anon;
grant execute on function public.assign_user_teams(uuid, uuid, uuid[]) to authenticated;

commit;
