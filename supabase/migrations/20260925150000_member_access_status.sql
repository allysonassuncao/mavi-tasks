begin;

-- Whether the signed-in person may use the app: 'active' with at least one
-- active membership, 'inactive' when every membership was deactivated, and
-- 'none' before being linked to a company. The app signs out 'inactive'
-- sessions; RLS already hides all company data from them.
create or replace function public.my_access() returns text
language sql stable security definer set search_path = '' as $$
 select case
  when exists(select 1 from public.memberships where user_id = auth.uid() and active) then 'active'
  when exists(select 1 from public.memberships where user_id = auth.uid()) then 'inactive'
  else 'none' end
$$;
revoke all on function public.my_access() from public, anon;
grant execute on function public.my_access() to authenticated;

commit;
