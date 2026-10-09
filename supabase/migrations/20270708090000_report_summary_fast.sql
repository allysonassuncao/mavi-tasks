-- Relatórios / Visão geral: report_summary estourava o tempo (57014) em
-- empresas com muito histórico. Era "security invoker": as regras de acesso
-- (RLS) de tarefas, horas e eventos rodavam linha a linha — a de horas chama
-- mavi_private.task_access() para cada apontamento —, as horas eram lidas
-- desde o começo (só "começou antes do fim do período") e as entregas varriam
-- todos os eventos do mês.
--
-- Agora o mesmo resultado, com o acesso resolvido uma vez: as tarefas que a
-- pessoa vê (a regra de tasks_read), as horas delas que a pessoa vê (a de
-- hours_read: as próprias, administrador ou gestor da equipe da tarefa) e as
-- entregas dessas tarefas; horas pelo fim do apontamento (índice) e entregas
-- por um índice só dos eventos de entrega.

begin;

-- Apontamentos que terminam depois do começo do período (os em andamento contam como "sem fim").
create index if not exists time_entries_company_ended
  on public.time_entries (company_id, (coalesce(ended_at, 'infinity'::timestamptz)));

-- Só os eventos de entrega (status → done), por empresa e data.
create index if not exists task_events_done
  on public.task_events (company_id, created_at) where (detail->>'to') = 'done';

create or replace function public.report_summary(p_company uuid, p_start timestamptz, p_end timestamptz) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_leader boolean;
  v_admin boolean;
  v_mgr_teams uuid[];
  v_tz text;
  result jsonb;
begin
  -- A mesma porta de tasks_read: empresa ativa da pessoa. De fora, o resumo
  -- vazio (como antes, quando as regras de acesso escondiam tudo).
  if v_uid is null or p_company not in (select mavi_private.active_companies()) then
    return jsonb_build_object('total', 0, 'late', 0, 'review', 0, 'done', 0, 'minutes', 0,
      'by_client', '[]'::jsonb, 'by_project', '[]'::jsonb, 'by_person', '[]'::jsonb);
  end if;
  v_leader := p_company in (select mavi_private.leader_companies());
  v_admin := mavi_private.admin(p_company);
  -- hours_read: gestor vê as horas das tarefas das equipes que gerencia.
  select coalesce(array_agg(tm.team_id), '{}') into v_mgr_teams
  from public.team_members tm
  join public.memberships m on m.company_id = tm.company_id and m.user_id = tm.user_id
  where tm.company_id = p_company and tm.user_id = v_uid and m.active and m.role = 'manager';
  select timezone into v_tz from public.companies where id = p_company;

  with access as materialized (
    -- tasks_read: líder vê tudo; os outros, as que criaram, de que são
    -- responsáveis, que supervisionam ou em que participam (arquivadas também:
    -- as horas e as entregas delas contam como antes).
    select t.id, t.project_id, t.status, t.due_date, t.contract_id, t.assignee_id, t.estimated_minutes, t.team_id, t.archived
    from public.tasks t
    where t.company_id = p_company
      and (v_leader or t.creator_id = v_uid or t.assignee_id = v_uid
        or t.id in (select mavi_private.supervised_tasks())
        or t.id in (select mavi_private.participant_tasks()))
  ),
  visible_tasks as (select * from access where not archived),
  hours as (
    select e.task_id, e.user_id,
      greatest(0, extract(epoch from (least(coalesce(e.ended_at, now()), p_end) - greatest(e.started_at, p_start))) / 60) as minutes,
      greatest(0, extract(epoch from (least(coalesce(e.ended_at, now()), p_end)
        - greatest(e.started_at, p_start, least(coalesce(e.covered_until, e.started_at), now())))) / 60) as own_minutes
    from public.time_entries e
    join access a on a.id = e.task_id
    where e.company_id = p_company
      and coalesce(e.ended_at, 'infinity'::timestamptz) > p_start
      and e.started_at < p_end
      and coalesce(e.ended_at, now()) > p_start
      and (e.user_id = v_uid or v_admin or a.team_id = any (v_mgr_teams))
  ),
  by_project as (
    select project_id as id, count(*) as total, count(*) filter (where status = 'done') as done
    from visible_tasks where project_id is not null group by project_id
  ),
  by_client as (
    select c.id, c.name, sum(h.minutes) as minutes
    from hours h join visible_tasks t on t.id = h.task_id
    join public.contracts k on k.id = t.contract_id join public.clients c on c.id = k.client_id
    group by c.id, c.name
  ),
  person_minutes as (select h.user_id, sum(h.own_minutes) as minutes from hours h group by h.user_id),
  by_person as (
    select m.user_id as id, m.name,
      count(t.id) filter (where t.status in ('open', 'progress', 'rejected', 'correction')) as tasks,
      coalesce(sum(t.estimated_minutes) filter (where t.status in ('open', 'progress', 'rejected', 'correction')), 0) as estimated,
      count(t.id) filter (where t.status = 'review') as reviewing,
      count(t.id) filter (where t.status = 'returned') as returned,
      coalesce((select pm.minutes from person_minutes pm where pm.user_id = m.user_id), 0) as minutes
    from public.memberships m
    left join visible_tasks t on t.assignee_id = m.user_id and t.status <> 'done'
    where m.company_id = p_company and m.active
    group by m.user_id, m.name
  ),
  delivery as (
    select count(*) as n from public.task_events ev
    where ev.company_id = p_company and (ev.detail->>'to') = 'done'
      and ev.created_at >= p_start and ev.created_at < p_end
      and ev.task_id in (select a.id from access a)
  )
  select jsonb_build_object(
    'total', (select count(*) from visible_tasks),
    'late', (select count(*) from visible_tasks where status <> 'done' and due_date < (now() at time zone v_tz)::date),
    'review', (select count(*) from visible_tasks where status = 'review'),
    'done', (select n from delivery),
    'minutes', coalesce((select sum(own_minutes) from hours), 0),
    'by_client', coalesce((select jsonb_agg(by_client) from by_client), '[]'),
    'by_project', coalesce((select jsonb_agg(by_project) from by_project), '[]'),
    'by_person', coalesce((select jsonb_agg(by_person) from by_person), '[]'))
  into result;
  return result;
end $$;
revoke all on function public.report_summary(uuid, timestamptz, timestamptz) from public, anon;
grant execute on function public.report_summary(uuid, timestamptz, timestamptz) to authenticated;

commit;
