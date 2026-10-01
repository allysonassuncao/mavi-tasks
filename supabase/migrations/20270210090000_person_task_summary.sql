-- Balão da pessoa e página /pessoas/<id>: quantas tarefas a pessoa tem como
-- responsável — em aberto, atrasadas (prazo antes de hoje no fuso da
-- empresa), em validação e entregues nos últimos 30 dias. Lida como quem
-- pergunta (security invoker): conta só as tarefas que essa pessoa já vê;
-- fora da empresa, zero.
-- Uma consulta por abertura do balão, pelo índice tasks_assignee.

create or replace function public.person_task_summary(p_company uuid, p_user uuid)
returns table(open bigint, late bigint, review bigint, done_30d bigint)
language sql stable security invoker set search_path = '' as $$
 select
  count(*) filter (where t.status <> 'done'),
  count(*) filter (where t.status <> 'done'
   and t.due_date < (now() at time zone coalesce(c.timezone, 'America/Sao_Paulo'))::date),
  count(*) filter (where t.status = 'review'),
  count(*) filter (where t.status = 'done' and t.delivered_at >= now() - interval '30 days')
 from public.companies c
 left join public.tasks t on t.company_id = c.id and t.assignee_id = p_user and not t.archived
 where c.id = p_company and mavi_private.member(c.id)
$$;
revoke all on function public.person_task_summary(uuid, uuid) from public, anon;
grant execute on function public.person_task_summary(uuid, uuid) to authenticated;

-- As próximas entregas da pessoa (página /pessoas/<id>): as tarefas em
-- aberto em que ela é responsável, das mais atrasadas às mais distantes,
-- também só as que quem pergunta vê.
create or replace function public.person_next_tasks(p_company uuid, p_user uuid, p_limit integer default 8)
returns table(id uuid, title text, status text, priority text, due_date date)
language sql stable security invoker set search_path = '' as $$
 select t.id, t.title, t.status, t.priority, t.due_date
 from public.tasks t
 where t.company_id = p_company and t.assignee_id = p_user and not t.archived
  and t.status <> 'done'
 order by t.due_date, t.created_at, t.id
 limit least(greatest(coalesce(p_limit, 8), 1), 50)
$$;
revoke all on function public.person_next_tasks(uuid, uuid, integer) from public, anon;
grant execute on function public.person_next_tasks(uuid, uuid, integer) to authenticated;
