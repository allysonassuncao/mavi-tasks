begin;

-- Módulos visíveis por pessoa: além das regras fixas do perfil de acesso
-- (colaborador, gestor, administrador), um administrador escolhe quais
-- módulos do menu cada pessoa vê. Só restringe: o que o perfil não permite
-- continua fora, e "Meu perfil" e "Equipe e configurações" não se escondem.
-- A lista guarda os módulos escondidos, para um módulo novo aparecer para
-- todos até alguém escondê-lo.

alter table public.memberships add column hidden_pages text[] not null default '{}'
 check (hidden_pages <@ array['overview','tasks','agenda','clients','products','projects','campaigns','hours',
  'reports','drive','storage','dashboards']::text[]);

create function public.set_member_pages(p_company uuid, p_user uuid, p_hidden text[]) returns void
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
  'reports','drive','storage','dashboards']::text[] then
  raise exception 'Módulo inválido' using errcode = '22023';
 end if;
 update public.memberships set hidden_pages = v where company_id = p_company and user_id = p_user
  and hidden_pages is distinct from v;
end $$;
revoke all on function public.set_member_pages(uuid, uuid, text[]) from public, anon;
grant execute on function public.set_member_pages(uuid, uuid, text[]) to authenticated;

commit;
