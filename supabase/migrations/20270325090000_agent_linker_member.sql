begin;

-- Agente Conversacional › quem liga os fluxos aos clientes ("Trocar cliente"
-- e a aba "Sem cliente") vira um recurso da pessoa, como "Marcar
-- prioridade": fica em Módulos visíveis e em Editar usuário › Recursos
-- extras, não mais na aba Permissões do módulo (20270324090000). Quem já
-- estava liberado continua. Administradores e gestores sempre podem;
-- administradores liberam para todos e gestores para as pessoas das suas
-- equipes (a regra dos outros recursos extras).

alter table public.memberships add column agent_linker boolean not null default false;

update public.memberships m set agent_linker = true
from public.agent_linkers l
where l.company_id = m.company_id and l.user_id = m.user_id;

create or replace function mavi_private.agent_linker(c uuid) returns boolean
language sql stable security definer set search_path = '' as $$
 select mavi_private.member(c) and (mavi_private.leader(c) or exists (
  select 1 from public.memberships m
  where m.company_id = c and m.user_id = auth.uid() and m.active and m.agent_linker))
$$;

drop function public.agent_linkers_list(uuid);
drop function public.agent_linker_set(uuid, uuid, boolean);
drop table public.agent_linkers;

create function public.set_member_agent_linker(p_company uuid, p_user uuid, p_on boolean) returns void
language plpgsql security definer set search_path = '' as $$
declare target public.memberships; begin
 select * into target from public.memberships where company_id = p_company and user_id = p_user;
 if not found then raise exception 'Pessoa não encontrada'; end if;
 if not mavi_private.can_manage_person(p_company, p_user)
  or (target.role = 'admin' and not mavi_private.admin(p_company)) then
  raise exception 'Administradores liberam para todos; gestores, para as pessoas das suas equipes' using errcode = '42501';
 end if;
 update public.memberships set agent_linker = coalesce(p_on, false)
 where company_id = p_company and user_id = p_user and agent_linker is distinct from coalesce(p_on, false);
 -- A tela do módulo de quem foi liberado (ou não) se ajusta na hora.
 perform mavi_private.broadcast(p_company, jsonb_build_object('kind', 'agents'));
end $$;
revoke all on function public.set_member_agent_linker(uuid, uuid, boolean) from public, anon;
grant execute on function public.set_member_agent_linker(uuid, uuid, boolean) to authenticated;

notify pgrst, 'reload schema';

commit;
