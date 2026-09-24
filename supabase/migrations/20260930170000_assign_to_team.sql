begin;

-- A new task can go to a team instead of a person: create_task receives the
-- team and no assignee, and the task goes to the active team member with the
-- fewest open tasks (not delivered, not archived, in any client). The team's
-- supervisors receive only when the team has nobody else. Ties go to whoever
-- received a task longest ago, then by name.
create function mavi_private.team_assignee(c uuid, p_team uuid) returns uuid
language sql stable security definer set search_path = '' as $$
 select tm.user_id from public.team_members tm
 join public.memberships m on m.company_id=tm.company_id and m.user_id=tm.user_id and m.active
 where tm.company_id=c and tm.team_id=p_team
 order by tm.supervisor,
  (select count(*) from public.tasks t
    where t.company_id=c and t.assignee_id=tm.user_id and t.status<>'done' and not t.archived),
  (select max(t.created_at) from public.tasks t where t.company_id=c and t.assignee_id=tm.user_id) nulls first,
  m.name, tm.user_id
 limit 1
$$;
revoke all on function mavi_private.team_assignee(uuid, uuid) from public, anon, authenticated;

-- The template fields of a task sent to a team: those of the product and of
-- that team (whoever receives it, the form could only know the team).
create function mavi_private.team_template_fields(c uuid, p_contract uuid, p_team uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
 select coalesce(jsonb_agg(f || jsonb_build_object('template_id', t.id, 'template_name', t.name)
  order by t.name, t.id, n), '[]')
 from public.task_templates t, jsonb_array_elements(t.fields) with ordinality as x(f, n)
 where t.company_id = c and t.active
  and (t.product_id is null or t.product_id = (select k.product_id from public.contracts k
   where k.company_id = c and k.id = p_contract))
  and (t.team_id is null or t.team_id = p_team)
$$;
revoke all on function mavi_private.team_template_fields(uuid, uuid, uuid) from public, anon, authenticated;

create or replace function public.create_task(p_company uuid,p_contract uuid,p_title text,p_assignee uuid,p_due date,
 p_project uuid default null,p_team uuid default null,p_description text default '',p_priority text default 'normal',
 p_estimated integer default 0,p_client_approval boolean default false,p_parent uuid default null,p_start date default null,
 p_custom jsonb default '{}') returns uuid
language plpgsql security definer set search_path = '' as $$
declare result uuid; custom jsonb; assignee uuid := p_assignee; begin
 if not mavi_private.contract_access(p_company,p_contract) then raise exception 'Sem acesso ao produto contratado' using errcode='42501'; end if;
 if assignee is null and p_team is null then raise exception 'Escolha um responsável ou uma equipe'; end if;
 if p_team is not null and not exists(
  select 1 from public.contracts k join public.client_teams ct on ct.company_id=k.company_id and ct.client_id=k.client_id
  where k.company_id=p_company and k.id=p_contract and ct.team_id=p_team) then raise exception 'Equipe não atende este cliente'; end if;
 if p_parent is not null and not mavi_private.can_edit(p_company,p_parent) then raise exception 'Sem acesso à tarefa principal' using errcode='42501'; end if;
 if assignee is null then
  -- One pick at a time per team, so simultaneous tasks spread out.
  perform 1 from public.teams where company_id=p_company and id=p_team for update;
  assignee := mavi_private.team_assignee(p_company, p_team);
  if assignee is null then
   raise exception 'Esta equipe não tem ninguém ativo para receber a tarefa.';
  end if;
  custom := mavi_private.fill_custom_fields(mavi_private.team_template_fields(p_company,p_contract,p_team), p_custom);
 else
  if not exists(select 1 from public.memberships where company_id=p_company and user_id=assignee and active) then raise exception 'Responsável inválido'; end if;
  custom := mavi_private.fill_custom_fields(mavi_private.template_fields_for(p_company,p_contract,assignee), p_custom);
 end if;
 insert into public.tasks(company_id,contract_id,title,assignee_id,due_date,original_due_date,project_id,team_id,description,priority,estimated_minutes,requires_client_approval,parent_id,start_date,custom_fields)
 values(p_company,p_contract,trim(p_title),assignee,p_due,p_due,p_project,p_team,p_description,p_priority,p_estimated,p_client_approval,p_parent,p_start,custom) returning id into result;
 insert into public.task_events(company_id,task_id,actor_id,action) values(p_company,result,auth.uid(),'created'); return result;
end $$;

commit;
