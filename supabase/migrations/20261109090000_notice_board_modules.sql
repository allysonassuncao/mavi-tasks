begin;

-- Mural de avisos em "Módulos visíveis": um administrador esconde o Mural de
-- uma pessoa como esconde os outros módulos. Quem está com ele escondido não
-- aparece no público dos avisos (sem popup, faixa, caixa de entrada ou push);
-- se o módulo voltar, a rotina de entrega inclui a pessoa nos avisos no ar.

alter table public.memberships drop constraint if exists memberships_hidden_pages_check;
alter table public.memberships add constraint memberships_hidden_pages_check
 check (hidden_pages <@ array['overview','tasks','agenda','clients','products','projects','campaigns','hours',
  'reports','drive','storage','dashboards','onboarding','aiUsage','assistant','cases','notices']::text[]);

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
  'reports','drive','storage','dashboards','onboarding','aiUsage','assistant','cases','notices']::text[] then
  raise exception 'Módulo inválido' using errcode = '22023';
 end if;
 update public.memberships set hidden_pages = v where company_id = p_company and user_id = p_user
  and hidden_pages is distinct from v;
end $$;

create or replace function mavi_private.notice_audience(p_notice uuid) returns setof uuid
language sql stable security definer set search_path = '' as $$
 with n as (select id, company_id, created_by from public.notices where id = p_notice),
 t as (select x.* from public.notice_targets x join n on x.notice_id = n.id),
 picked as (
  select m.user_id from n join public.memberships m on m.company_id = n.company_id
   where exists (select 1 from t where t.kind = 'everyone')
  union
  select t.target_id from t where t.kind = 'user'
  union
  select tm.user_id from t
   join public.team_members tm on tm.company_id = t.company_id and tm.team_id = t.target_id
   where t.kind = 'team'
  union
  select tm.user_id from t
   join public.client_teams ct on ct.company_id = t.company_id and ct.client_id = t.target_id
   join public.team_members tm on tm.company_id = ct.company_id and tm.team_id = ct.team_id
   where t.kind = 'client' and t.mode in ('teams', 'both')
  union
  select tk.assignee_id from t
   join public.contracts k on k.company_id = t.company_id and k.client_id = t.target_id
   join public.tasks tk on tk.company_id = k.company_id and tk.contract_id = k.id
   where t.kind = 'client' and t.mode in ('assignees', 'both') and not tk.archived and tk.status <> 'done'
  union
  select tm.user_id from t
   join public.projects p on p.company_id = t.company_id and p.id = t.target_id
   join public.contracts k on k.company_id = p.company_id and k.id = p.contract_id
   join public.client_teams ct on ct.company_id = k.company_id and ct.client_id = k.client_id
   join public.team_members tm on tm.company_id = ct.company_id and tm.team_id = ct.team_id
   where t.kind = 'project' and t.mode in ('teams', 'both')
  union
  select tk.assignee_id from t
   join public.projects p on p.company_id = t.company_id and p.id = t.target_id
   join public.tasks tk on tk.company_id = p.company_id and tk.contract_id = p.contract_id and tk.project_id = p.id
   where t.kind = 'project' and t.mode in ('assignees', 'both') and not tk.archived and tk.status <> 'done'
 )
 select p.user_id from picked p
 join n on true
 join public.memberships m on m.company_id = n.company_id and m.user_id = p.user_id and m.active
 where p.user_id <> n.created_by
  and not exists (select 1 from t where t.kind = 'exclude' and t.target_id = p.user_id)
  -- Quem está com o Mural escondido (Módulos visíveis) não recebe.
  and not ('notices' = any(m.hidden_pages))
$$;
revoke all on function mavi_private.notice_audience(uuid) from public, anon, authenticated;

commit;
