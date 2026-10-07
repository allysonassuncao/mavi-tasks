begin;

-- Desativar um usuário pede quem assume a fila dele.
--
-- * Se a pessoa é responsável e/ou criadora de tarefas ainda não entregues
--   (fora as arquivadas) ou de repetições ativas, update_member só a desativa
--   com p_handover: um usuário ativo da empresa, diferente dela.
-- * p_handover fica no lugar dela em cada papel: onde era responsável vira o
--   responsável (mesmo status; o cronômetro de quem saiu é pausado por
--   pause_on_reassign), onde era criadora vira o criador (Devolvida e a
--   validação passam a ir para alguém ativo). Cada troca fica no histórico
--   ('move' para o responsável, 'creator_changed' para o criador) e num
--   comentário na tarefa.
-- * As repetições ativas também: as próximas cópias já nascem com p_handover.
-- * Quem recebe ganha um aviso só ('tasks_assigned'), como no lote.
-- * member_open_work conta o que há na fila, para o formulário avisar antes.

-- ------------------------------------------------------------ o que há na fila
create or replace function public.member_open_work(p_company uuid, p_user uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare by_status jsonb; total integer; as_assignee integer; as_creator integer; recurrences integer; begin
 if not mavi_private.leader(p_company) then raise exception 'Sem permissão' using errcode = '42501'; end if;
 select coalesce(jsonb_object_agg(status, n), '{}'), coalesce(sum(n), 0), coalesce(sum(a), 0), coalesce(sum(c), 0)
  into by_status, total, as_assignee, as_creator
  from (select status, count(*)::integer n, count(*) filter (where assignee_id = p_user)::integer a,
    count(*) filter (where creator_id = p_user)::integer c
   from public.tasks
   where company_id = p_company and p_user in (assignee_id, creator_id) and status <> 'done' and not archived
   group by status) s;
 select count(*)::integer into recurrences from public.task_recurrences
  where company_id = p_company and p_user in (assignee_id, creator_id) and active;
 return jsonb_build_object('tasks', total, 'as_assignee', as_assignee, 'as_creator', as_creator,
  'by_status', by_status, 'recurrences', recurrences);
end $$;
revoke all on function public.member_open_work(uuid, uuid) from public, anon;
grant execute on function public.member_open_work(uuid, uuid) to authenticated;

-- ------------------------------------------------------------ desativar com quem assume
-- A da migração 20260926090000, com p_handover.
drop function public.update_member(uuid, uuid, text, text, boolean, uuid[]);
create function public.update_member(p_company uuid, p_user uuid, p_name text, p_role text, p_active boolean,
 p_teams uuid[], p_handover uuid default null) returns void
language plpgsql security definer set search_path = '' as $$
declare target public.memberships; caller_admin boolean; me uuid := auth.uid();
 deactivating boolean; open_tasks integer; open_recurrences integer; receiver text; note text; label text;
 cur public.tasks; changed public.tasks; touched uuid[] := '{}'; people uuid[] := '{}'; titles text[] := '{}';
 assigned integer := 0; created integer := 0;
begin
  if not mavi_private.leader(p_company) then raise exception 'Sem permissão' using errcode = '42501'; end if;
  select * into target from public.memberships where company_id = p_company and user_id = p_user for update;
  if not found then raise exception 'Usuário não encontrado na empresa'; end if;
  if p_role not in ('admin', 'manager', 'member') then raise exception 'Perfil de acesso inválido.'; end if;
  if length(trim(coalesce(p_name, ''))) not between 2 and 120 then raise exception 'Informe um nome de 2 a 120 caracteres.'; end if;
  caller_admin := mavi_private.admin(p_company);
  if not caller_admin and (target.role = 'admin' or p_role = 'admin') then
    raise exception 'Somente administradores editam administradores.' using errcode = '42501';
  end if;
  if p_user = me and (p_role <> target.role or not p_active) then
    raise exception 'Você não pode alterar o próprio perfil de acesso nem se desativar.' using errcode = '42501';
  end if;
  if target.role = 'admin' and target.active and (p_role <> 'admin' or not p_active) and not exists(
    select 1 from public.memberships
    where company_id = p_company and user_id <> p_user and role = 'admin' and active) then
    raise exception 'A empresa precisa de pelo menos um administrador ativo.';
  end if;

  -- Desativando: a fila não entregue precisa de quem a assuma.
  deactivating := target.active and p_active is not null and not p_active;
  if deactivating then
    select count(*) into open_tasks from public.tasks
     where company_id = p_company and p_user in (assignee_id, creator_id) and status <> 'done' and not archived;
    select count(*) into open_recurrences from public.task_recurrences
     where company_id = p_company and p_user in (assignee_id, creator_id) and active;
    if open_tasks + open_recurrences > 0 then
      if p_handover is null then
        raise exception '% tem % na fila: escolha quem assume antes de desativar.', trim(target.name),
         array_to_string(array[
          case when open_tasks > 0 then open_tasks
           || case when open_tasks = 1 then ' tarefa não entregue' else ' tarefas não entregues' end end,
          case when open_recurrences > 0 then open_recurrences
           || case when open_recurrences = 1 then ' repetição' else ' repetições' end end], ' e ');
      end if;
      select name into receiver from public.memberships
       where company_id = p_company and user_id = p_handover and active and user_id <> p_user;
      if receiver is null then raise exception 'Escolha um usuário ativo para assumir as tarefas.'; end if;
    end if;
  end if;

  update public.memberships set name = trim(p_name), role = p_role, active = coalesce(p_active, active)
  where company_id = p_company and user_id = p_user;

  -- Teams: keep supervision in teams the person stays in.
  delete from public.team_members
  where company_id = p_company and user_id = p_user and not (team_id = any(coalesce(p_teams, '{}'::uuid[])));
  insert into public.team_members(company_id, team_id, user_id)
    select p_company, t.id, p_user from public.teams t
    where t.company_id = p_company and t.id = any(coalesce(p_teams, '{}'::uuid[]))
    on conflict do nothing;

  if receiver is null then return; end if;

  -- As tarefas, no mesmo status; um aviso no fim em vez de um por tarefa.
  note := 'Usuário desativado: ' || trim(target.name) || '.';
  perform set_config('mavi.bulk_tasks', '1', true);
  for cur in select * from public.tasks
   where company_id = p_company and p_user in (assignee_id, creator_id) and status <> 'done' and not archived
   order by due_date nulls last, created_at
   for update
  loop
    update public.tasks set
     assignee_id = case when assignee_id = p_user then p_handover else assignee_id end,
     creator_id = case when creator_id = p_user then p_handover else creator_id end,
     version = version + 1
    where id = cur.id returning * into changed;
    label := null;
    if cur.assignee_id = p_user then
      assigned := assigned + 1;
      label := 'Responsável alterado · Responsável: ' || receiver;
      insert into public.task_events(company_id, task_id, actor_id, action, detail) values (p_company, cur.id, me, 'move',
       jsonb_build_object('note', note, 'from', cur.status, 'to', cur.status, 'revision', cur.revision, 'due_date', cur.due_date,
        'assignee_from', p_user, 'assignee_to', p_handover, 'status_since', cur.status_changed_at));
    end if;
    if cur.creator_id = p_user then
      created := created + 1;
      label := coalesce(label || ' · Criador: ', 'Criador alterado · Criador: ') || receiver;
      insert into public.task_events(company_id, task_id, actor_id, action, detail) values (p_company, cur.id, me,
       'creator_changed', jsonb_build_object('note', note, 'creator_from', p_user, 'creator_to', p_handover));
    end if;
    insert into public.comments(company_id, task_id, body) values (p_company, cur.id,
     mavi_private.transition_comment(label, note));
    touched := touched || cur.id;
    titles := titles || cur.title;
    people := people || mavi_private.task_people(cur) || mavi_private.task_people(changed);
  end loop;
  perform set_config('mavi.bulk_tasks', '', true);

  update public.task_recurrences set
    assignee_id = case when assignee_id = p_user then p_handover else assignee_id end,
    creator_id = case when creator_id = p_user then p_handover else creator_id end
   where company_id = p_company and p_user in (assignee_id, creator_id) and active;

  if cardinality(touched) > 0 then
    if p_handover <> me then
      insert into public.notifications(company_id, user_id, actor_id, task_id, kind, title, body, link)
      values (p_company, p_handover, me, null, 'tasks_assigned',
       coalesce((select name from public.memberships where company_id = p_company and user_id = me), 'Alguém')
        || ' desativou ' || trim(target.name) || ' e passou para você ' || array_to_string(array[
         case when assigned > 0 then assigned
          || case when assigned = 1 then ' tarefa como responsável' else ' tarefas como responsável' end end,
         case when created > 0 then created
          || case when created = 1 then ' tarefa como criador' else ' tarefas como criador' end end], ' e '),
       left(array_to_string(titles, ' · '), 300),
       case when assigned > 0 then '/tarefas?escopo=mine' else '/tarefas?escopo=created' end);
    end if;
    perform mavi_private.broadcast_tasks(p_company, touched,
     (select array_agg(distinct u) from unnest(people) u where u is not null));
  end if;
end $$;
revoke all on function public.update_member(uuid, uuid, text, text, boolean, uuid[], uuid) from public, anon;
grant execute on function public.update_member(uuid, uuid, text, text, boolean, uuid[], uuid) to authenticated;

commit;
