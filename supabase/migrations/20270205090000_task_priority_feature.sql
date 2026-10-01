begin;

-- Prioridades como recurso extra por pessoa. Alta e Urgente passam a ser de
-- administradores e gestores (sempre) e de quem tem memberships.task_priority
-- ligado — em qualquer tarefa que a pessoa vê. O recurso nasce desligado;
-- administradores ligam para todos e gestores para as pessoas das suas
-- equipes (set_member_task_priority, como set_member_multi_timer). Ser
-- supervisor da equipe do responsável deixa de bastar (antes, 20270130090000).
-- Baixa ↔ Normal segue com quem edita a tarefa.

alter table public.memberships add column task_priority boolean not null default false;

-- `p` (o responsável) fica pelos chamadores (gatilho, may_set_priority,
-- set_task_priority, can_prioritize); a regra agora é só da pessoa. Ver a
-- tarefa já é exigido em cada caminho (set_task_priority e a alteração em
-- massa conferem task_access; Editar, can_edit; na criação é a própria
-- pessoa quem cria).
create or replace function mavi_private.can_prioritize_as(c uuid, actor uuid, p uuid) returns boolean
language sql stable security definer set search_path = '' as $$
 select exists(select 1 from public.memberships m where m.company_id = c and m.user_id = actor and m.active
  and (m.role in ('admin', 'manager') or m.task_priority))
$$;

create or replace function mavi_private.guard_task_priority() returns trigger
language plpgsql security definer set search_path = '' as $$
declare me uuid := auth.uid(); was text := case when tg_op = 'UPDATE' then old.priority else 'normal' end; begin
 if tg_op = 'UPDATE' and new.priority is not distinct from old.priority then return new; end if;
 if mavi_private.priority_weight(new.priority) = 0 and mavi_private.priority_weight(was) = 0 then
  new.priority_set_by := null;
  new.priority_set_at := null;
  return new;
 end if;
 -- Uma pessoa precisa poder marcar. Passam as rotinas sem pessoa, a cópia
 -- da repetição (repete a prioridade da tarefa de origem) e o desfazer do lote.
 if me is not null and coalesce(current_setting('mavi.priority_system', true), '') <> '1'
  and not (tg_op = 'INSERT' and new.recurrence_id is not null)
  and not mavi_private.can_prioritize_as(new.company_id, me, new.assignee_id) then
  raise exception 'Só administradores, gestores e quem tem o recurso "Marcar prioridade" dão ou tiram a prioridade Alta ou Urgente.'
   using errcode = '42501';
 end if;
 if mavi_private.priority_weight(new.priority) > 0 then
  new.priority_set_by := me;
  new.priority_set_at := now();
 else
  new.priority_set_by := null;
  new.priority_set_at := null;
 end if;
 return new;
end $$;

-- ------------------------------------------------------------ em massa
-- A mensagem de quem não pode, com o recurso (20270130090000 citava o supervisor).
do $$
declare src text; begin
 select pg_get_functiondef('public.bulk_update_tasks(uuid, uuid[], jsonb, boolean)'::regprocedure) into src;
 if position('o supervisor da equipe do responsável dão ou tiram' in src) = 0 then
  raise exception 'bulk_update_tasks mudou: revise a mensagem da prioridade';
 end if;
 execute replace(src, 'o supervisor da equipe do responsável dão ou tiram',
  'quem tem o recurso "Marcar prioridade" dão ou tiram');
end $$;

-- ------------------------------------------------------------ liga e desliga
create function public.set_member_task_priority(p_company uuid, p_user uuid, p_on boolean) returns void
language plpgsql security definer set search_path = '' as $$
declare target public.memberships; begin
 select * into target from public.memberships where company_id = p_company and user_id = p_user;
 if not found then raise exception 'Pessoa não encontrada'; end if;
 if not mavi_private.can_manage_person(p_company, p_user)
  or (target.role = 'admin' and not mavi_private.admin(p_company)) then
  raise exception 'Administradores liberam para todos; gestores, para as pessoas das suas equipes' using errcode = '42501';
 end if;
 update public.memberships set task_priority = coalesce(p_on, false) where company_id = p_company and user_id = p_user;
end $$;
revoke all on function public.set_member_task_priority(uuid, uuid, boolean) from public, anon;
grant execute on function public.set_member_task_priority(uuid, uuid, boolean) to authenticated;

notify pgrst, 'reload schema';

commit;
