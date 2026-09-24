begin;

-- Sugestões: anyone in the company can suggest a new feature or report a
-- bug, and it becomes a task for someone of the P&D team — even if the
-- person can't otherwise create tasks in that client. Leaders choose, once,
-- which team is P&D and where its tasks live (product contracted and,
-- optionally, project).
create table public.suggestion_settings (
 company_id uuid primary key references public.companies(id),
 team_id uuid not null,
 contract_id uuid not null,
 project_id uuid,
 updated_by uuid not null default auth.uid(),
 updated_at timestamptz not null default now(),
 foreign key (company_id, team_id) references public.teams(company_id, id),
 foreign key (company_id, contract_id) references public.contracts(company_id, id),
 foreign key (company_id, contract_id, project_id) references public.projects(company_id, contract_id, id)
);
alter table public.suggestion_settings enable row level security;
-- Everyone reads it: the form lists the P&D team's members.
create policy suggestion_settings_read on public.suggestion_settings for select to authenticated
 using (company_id in (select mavi_private.active_companies()));
grant select on public.suggestion_settings to authenticated;

create function public.save_suggestion_settings(p_company uuid, p_team uuid, p_contract uuid,
 p_project uuid default null) returns void
language plpgsql security definer set search_path = '' as $$ begin
 if not mavi_private.leader(p_company) then raise exception 'Sem permissão' using errcode = '42501'; end if;
 -- Same rule as create_task: the team must serve the contract's client.
 if not exists (select 1 from public.contracts k
  join public.client_teams ct on ct.company_id = k.company_id and ct.client_id = k.client_id
  where k.company_id = p_company and k.id = p_contract and not k.archived and ct.team_id = p_team) then
  raise exception 'A equipe de P&D precisa atender o cliente escolhido' using errcode = '22023';
 end if;
 if p_project is not null and not exists (select 1 from public.projects
  where company_id = p_company and contract_id = p_contract and id = p_project and not archived) then
  raise exception 'Projeto inválido para este produto' using errcode = '22023';
 end if;
 insert into public.suggestion_settings(company_id, team_id, contract_id, project_id)
 values (p_company, p_team, p_contract, p_project)
 on conflict (company_id) do update set team_id = excluded.team_id, contract_id = excluded.contract_id,
  project_id = excluded.project_id, updated_by = auth.uid(), updated_at = now();
end $$;
revoke all on function public.save_suggestion_settings(uuid, uuid, uuid, uuid) from public, anon;
grant execute on function public.save_suggestion_settings(uuid, uuid, uuid, uuid) to authenticated;

-- The suggestion as a task: created by whoever sent it (so they follow it
-- and attach files), for the chosen P&D member. A bug is high priority and
-- due in 2 days; a feature, normal and due in a week (both can be changed).
create function public.submit_suggestion(p_company uuid, p_kind text, p_title text,
 p_description text, p_assignee uuid) returns uuid
language plpgsql security definer set search_path = '' as $$
declare s public.suggestion_settings; result uuid; due date; custom jsonb; begin
 if not mavi_private.member(p_company) then raise exception 'Sem permissão' using errcode = '42501'; end if;
 if p_kind is null or p_kind not in ('feature', 'bug') then
  raise exception 'Escolha nova funcionalidade ou bug' using errcode = '22023';
 end if;
 select * into s from public.suggestion_settings where company_id = p_company;
 if not found then
  raise exception 'Sugestões ainda não configuradas: um gestor precisa escolher a equipe de P&D' using errcode = '22023';
 end if;
 if not exists (select 1 from public.team_members tm
  join public.memberships m on m.company_id = tm.company_id and m.user_id = tm.user_id and m.active
  where tm.company_id = p_company and tm.team_id = s.team_id and tm.user_id = p_assignee) then
  raise exception 'Escolha um responsável da equipe de P&D' using errcode = '22023';
 end if;
 due := current_date + case when p_kind = 'bug' then 2 else 7 end;
 -- Template fields can't be asked of whoever suggests: the task gets them
 -- empty (required ones included) for the P&D member to fill in.
 select coalesce(jsonb_agg(x.f || jsonb_build_object('value', null) order by x.n), '[]')
  into custom from jsonb_array_elements(
   mavi_private.template_fields_for(p_company, s.contract_id, p_assignee)) with ordinality as x(f, n);
 insert into public.tasks(company_id, contract_id, title, assignee_id, due_date, original_due_date,
  project_id, team_id, description, priority, custom_fields)
 values (p_company, s.contract_id, trim(p_title), p_assignee, due, due, s.project_id, s.team_id,
  coalesce(p_description, ''), case when p_kind = 'bug' then 'high' else 'normal' end, custom)
 returning id into result;
 insert into public.task_events(company_id, task_id, actor_id, action, detail)
 values (p_company, result, auth.uid(), 'created', jsonb_build_object('suggestion', p_kind));
 return result;
end $$;
revoke all on function public.submit_suggestion(uuid, text, text, text, uuid) from public, anon;
grant execute on function public.submit_suggestion(uuid, text, text, text, uuid) to authenticated;

commit;
