begin;

-- Termômetro dos clientes em "Módulos visíveis": um administrador esconde o
-- módulo 'temperature' de uma pessoa como esconde os outros (a migration
-- 20261110090000_client_temperature esqueceu de liberá-lo aqui). Quem está
-- com ele escondido também não recebe os avisos de cliente que esfriou.

alter table public.memberships drop constraint if exists memberships_hidden_pages_check;
alter table public.memberships add constraint memberships_hidden_pages_check
 check (hidden_pages <@ array['overview','tasks','agenda','clients','products','projects','campaigns','hours',
  'reports','drive','storage','dashboards','onboarding','aiUsage','assistant','cases','notices',
  'temperature']::text[]);

create or replace function public.set_member_pages(p_company uuid, p_user uuid, p_hidden text[]) returns void
language plpgsql security definer set search_path = '' as $$
declare v text[]; begin
 if not mavi_private.admin(p_company) then
  raise exception 'Somente administradores escolhem os módulos de cada pessoa.' using errcode = '42501';
 end if;
 if not exists (select 1 from public.memberships where company_id = p_company and user_id = p_user) then
  raise exception 'Usuário não encontrado na empresa';
 end if;
 select coalesce(array_agg(distinct x order by x), '{}') into v from unnest(coalesce(p_hidden, '{}')) x;
 if not v <@ array['overview','tasks','agenda','clients','products','projects','campaigns','hours',
  'reports','drive','storage','dashboards','onboarding','aiUsage','assistant','cases','notices',
  'temperature']::text[] then
  raise exception 'Módulo inválido' using errcode = '22023';
 end if;
 update public.memberships set hidden_pages = v where company_id = p_company and user_id = p_user
  and hidden_pages is distinct from v;
end $$;

-- Os avisos do termômetro vão só para quem tem o módulo: os supervisores das
-- equipes do cliente; sem nenhum, os administradores.
create or replace function mavi_private.temperature_recipients(c uuid, p_client uuid) returns uuid[]
language sql stable security definer set search_path = '' as $$
 select coalesce(
  (select array_agg(distinct tm.user_id) from public.client_teams ct
   join public.team_members tm on tm.company_id = ct.company_id and tm.team_id = ct.team_id and tm.supervisor
   join public.memberships m on m.company_id = tm.company_id and m.user_id = tm.user_id and m.active
   where ct.company_id = c and ct.client_id = p_client and not ('temperature' = any(m.hidden_pages))),
  (select array_agg(m.user_id) from public.memberships m where m.company_id = c and m.active and m.role = 'admin'
   and not ('temperature' = any(m.hidden_pages))),
  '{}')
$$;
revoke all on function mavi_private.temperature_recipients(uuid, uuid) from public, anon, authenticated;

commit;
