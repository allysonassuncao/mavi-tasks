-- MAVI foundation. Apply to a reviewed development project first.
begin;
create schema if not exists mavi_private;
revoke all on schema mavi_private from public;
grant usage on schema mavi_private to authenticated;

create table public.companies (
 id uuid primary key default gen_random_uuid(), name text not null check(length(trim(name)) between 2 and 120),
 timezone text not null default 'America/Sao_Paulo', created_at timestamptz not null default now()
);
create table public.memberships (
 company_id uuid not null references public.companies(id), user_id uuid not null references auth.users(id),
 name text not null, role text not null check(role in ('admin','manager','member')), active boolean not null default true,
 primary key(company_id,user_id)
);
create table public.teams (
 id uuid primary key default gen_random_uuid(), company_id uuid not null references public.companies(id),
 name text not null, unique(company_id,id)
);
create table public.team_members (
 company_id uuid not null, team_id uuid not null, user_id uuid not null,
 primary key(company_id,team_id,user_id),
 foreign key(company_id,team_id) references public.teams(company_id,id),
 foreign key(company_id,user_id) references public.memberships(company_id,user_id)
);
create table public.clients (
 id uuid primary key default gen_random_uuid(), company_id uuid not null references public.companies(id),
 name text not null check(length(trim(name)) between 2 and 160), email text not null default '',
 color text not null default '#8576cf', archived boolean not null default false,
 created_at timestamptz not null default now(), unique(company_id,id)
);
create table public.products (
 id uuid primary key default gen_random_uuid(), company_id uuid not null references public.companies(id),
 name text not null check(length(trim(name)) between 2 and 120), color text not null default '#8576cf',
 unique(company_id,id)
);
create table public.contracts (
 id uuid primary key default gen_random_uuid(), company_id uuid not null references public.companies(id),
 client_id uuid not null, product_id uuid not null, name text not null,
 archived boolean not null default false, created_at timestamptz not null default now(),
 foreign key(company_id,client_id) references public.clients(company_id,id),
 foreign key(company_id,product_id) references public.products(company_id,id), unique(company_id,id)
);
create table public.contract_teams (
 company_id uuid not null, contract_id uuid not null, team_id uuid not null,
 primary key(company_id,contract_id,team_id),
 foreign key(company_id,contract_id) references public.contracts(company_id,id),
 foreign key(company_id,team_id) references public.teams(company_id,id)
);
create table public.projects (
 id uuid primary key default gen_random_uuid(), company_id uuid not null, contract_id uuid not null,
 name text not null check(length(trim(name)) between 2 and 160), due_date date, archived boolean not null default false,
 foreign key(company_id,contract_id) references public.contracts(company_id,id), unique(company_id,contract_id,id)
);
create table public.tasks (
 id uuid primary key default gen_random_uuid(), company_id uuid not null, contract_id uuid not null,
 project_id uuid, team_id uuid, parent_id uuid, title text not null check(length(trim(title)) between 2 and 240),
 description text not null default '', status text not null default 'open' check(status in ('open','progress','returned','review','done')),
 priority text not null default 'normal' check(priority in ('low','normal','high','urgent')),
 creator_id uuid not null default auth.uid(), assignee_id uuid not null,
 due_date date not null, original_due_date date not null, estimated_minutes integer not null default 0 check(estimated_minutes >= 0),
 requires_client_approval boolean not null default false, internal_approved_by uuid, client_approved_by uuid,
 client_approval_note text, delivered_at timestamptz, revision integer not null default 1,
 version integer not null default 1, archived boolean not null default false, created_at timestamptz not null default now(),
 foreign key(company_id,contract_id) references public.contracts(company_id,id),
 foreign key(company_id,contract_id,project_id) references public.projects(company_id,contract_id,id),
 foreign key(company_id,team_id) references public.teams(company_id,id),
 foreign key(company_id,creator_id) references public.memberships(company_id,user_id),
 foreign key(company_id,assignee_id) references public.memberships(company_id,user_id),
 unique(company_id,id), unique(company_id,contract_id,id),
 foreign key(company_id,contract_id,parent_id) references public.tasks(company_id,contract_id,id),
 check(parent_id is distinct from id),
 check(status <> 'done' or (internal_approved_by is not null and (not requires_client_approval or client_approved_by is not null)))
);
create table public.comments (
 id uuid primary key default gen_random_uuid(), company_id uuid not null, task_id uuid not null,
 author_id uuid not null default auth.uid(), body text not null check(length(trim(body)) between 1 and 10000),
 created_at timestamptz not null default now(), foreign key(company_id,task_id) references public.tasks(company_id,id),
 foreign key(company_id,author_id) references public.memberships(company_id,user_id)
);
create table public.time_entries (
 id uuid primary key default gen_random_uuid(), company_id uuid not null, task_id uuid not null,
 user_id uuid not null default auth.uid(), started_at timestamptz not null, ended_at timestamptz,
 note text not null default '', source text not null check(source in ('timer','manual')),
 foreign key(company_id,task_id) references public.tasks(company_id,id),
 foreign key(company_id,user_id) references public.memberships(company_id,user_id),
 check(ended_at is null or ended_at > started_at)
);
create unique index one_running_timer_per_user on public.time_entries(user_id) where ended_at is null;
create table public.task_events (
 id uuid primary key default gen_random_uuid(), company_id uuid not null, task_id uuid not null,
 actor_id uuid not null, action text not null, detail jsonb not null default '{}', created_at timestamptz not null default now(),
 foreign key(company_id,task_id) references public.tasks(company_id,id)
);
create table public.attachments (
 id uuid primary key default gen_random_uuid(), company_id uuid not null, task_id uuid not null,
 uploaded_by uuid not null default auth.uid(), name text not null, path text not null unique,
 size_bytes bigint not null check(size_bytes between 1 and 20971520), created_at timestamptz not null default now(),
 foreign key(company_id,task_id) references public.tasks(company_id,id),
 check(path = company_id::text || '/' || task_id::text || '/' || id::text)
);
create index memberships_user on public.memberships(user_id,company_id) where active;
create index team_members_user on public.team_members(company_id,user_id,team_id);
create index contracts_client on public.contracts(company_id,client_id);
create index tasks_list on public.tasks(company_id,due_date,id) where not archived;
create index tasks_contract on public.tasks(company_id,contract_id);
create index tasks_assignee on public.tasks(company_id,assignee_id,status);
create index tasks_creator on public.tasks(company_id,creator_id);
create index time_entries_task on public.time_entries(company_id,task_id,started_at);
create index comments_task on public.comments(company_id,task_id,created_at);
create index task_events_task on public.task_events(company_id,task_id,created_at);
create index attachments_task on public.attachments(company_id,task_id);

-- Helpers run as owner to avoid recursive membership policies. All inspect auth.uid().
create function mavi_private.member(c uuid) returns boolean language sql stable security definer set search_path = '' as $$
 select exists(select 1 from public.memberships where company_id=c and user_id=auth.uid() and active)
$$;
create function mavi_private.admin(c uuid) returns boolean language sql stable security definer set search_path = '' as $$
 select exists(select 1 from public.memberships where company_id=c and user_id=auth.uid() and active and role='admin')
$$;
create function mavi_private.manager(c uuid, t uuid) returns boolean language sql stable security definer set search_path = '' as $$
 select exists(select 1 from public.memberships m join public.team_members tm using(company_id,user_id)
 where m.company_id=c and m.user_id=auth.uid() and m.active and m.role='manager' and tm.team_id=t)
$$;
create function mavi_private.contract_access(c uuid, k uuid) returns boolean language sql stable security definer set search_path = '' as $$
 select mavi_private.member(c) and (mavi_private.admin(c) or exists(
 select 1 from public.contract_teams ct join public.team_members tm using(company_id,team_id)
 where ct.company_id=c and ct.contract_id=k and tm.user_id=auth.uid()))
$$;
create function mavi_private.task_access(c uuid, t uuid) returns boolean language sql stable security definer set search_path = '' as $$
 select mavi_private.member(c) and exists(select 1 from public.tasks where company_id=c and id=t and
 (mavi_private.contract_access(c,contract_id) or creator_id=auth.uid() or assignee_id=auth.uid()))
$$;
create function mavi_private.contract_read(c uuid, k uuid) returns boolean language sql stable security definer set search_path = '' as $$
 select mavi_private.contract_access(c,k) or (mavi_private.member(c) and exists(
 select 1 from public.tasks where company_id=c and contract_id=k and (creator_id=auth.uid() or assignee_id=auth.uid())))
$$;
create function mavi_private.can_edit(c uuid, t uuid) returns boolean language sql stable security definer set search_path = '' as $$
 select mavi_private.task_access(c,t) and exists(select 1 from public.tasks where company_id=c and id=t and
 (mavi_private.admin(c) or mavi_private.manager(c,team_id) or creator_id=auth.uid() or assignee_id=auth.uid()))
$$;
create function mavi_private.can_approve(c uuid, t uuid) returns boolean language sql stable security definer set search_path = '' as $$
 select mavi_private.task_access(c,t) and exists(select 1 from public.tasks where company_id=c and id=t and
 (creator_id=auth.uid() or mavi_private.manager(c,team_id)))
$$;
revoke all on all functions in schema mavi_private from public, anon;
grant execute on all functions in schema mavi_private to authenticated;

-- No direct client writes. Authorized transactional RPCs below are the mutation boundary.
do $$ declare n text; begin
 foreach n in array array['companies','memberships','teams','team_members','clients','products','contracts','contract_teams','projects','tasks','comments','time_entries','task_events','attachments'] loop
 execute format('alter table public.%I enable row level security',n);
 execute format('revoke all on public.%I from anon, authenticated',n);
 execute format('grant select on public.%I to authenticated',n);
 end loop;
end $$;
create policy companies_read on public.companies for select to authenticated using(mavi_private.member(id));
create policy memberships_read on public.memberships for select to authenticated using(mavi_private.member(company_id));
create policy teams_read on public.teams for select to authenticated using(mavi_private.member(company_id));
create policy team_members_read on public.team_members for select to authenticated using(mavi_private.member(company_id));
create policy products_read on public.products for select to authenticated using(mavi_private.member(company_id));
create policy contracts_read on public.contracts for select to authenticated using(mavi_private.contract_read(company_id,id));
create policy clients_read on public.clients for select to authenticated using(mavi_private.admin(company_id) or exists(
 select 1 from public.contracts k where k.company_id=clients.company_id and k.client_id=clients.id));
create policy contract_teams_read on public.contract_teams for select to authenticated using(mavi_private.contract_read(company_id,contract_id));
create policy projects_read on public.projects for select to authenticated using(mavi_private.contract_read(company_id,contract_id));
create policy tasks_read on public.tasks for select to authenticated using(mavi_private.task_access(company_id,id));
create policy comments_read on public.comments for select to authenticated using(mavi_private.task_access(company_id,task_id));
create policy events_read on public.task_events for select to authenticated using(mavi_private.task_access(company_id,task_id));
create policy attachments_read on public.attachments for select to authenticated using(mavi_private.task_access(company_id,task_id));
create policy hours_read on public.time_entries for select to authenticated using(mavi_private.task_access(company_id,task_id) and
 (user_id=auth.uid() or mavi_private.admin(company_id) or exists(select 1 from public.tasks t where t.id=task_id and mavi_private.manager(company_id,t.team_id))));

create function public.create_client(p_company uuid,p_name text,p_email text default '') returns uuid
language plpgsql security definer set search_path = '' as $$ declare result uuid; begin
 if not mavi_private.admin(p_company) then raise exception 'Sem permissão para cadastrar clientes' using errcode='42501'; end if;
 insert into public.clients(company_id,name,email) values(p_company,trim(p_name),trim(p_email)) returning id into result; return result;
end $$;
create function public.create_product(p_company uuid,p_name text) returns uuid
language plpgsql security definer set search_path = '' as $$ declare result uuid; begin
 if not mavi_private.admin(p_company) then raise exception 'Sem permissão' using errcode='42501'; end if;
 insert into public.products(company_id,name) values(p_company,trim(p_name)) returning id into result; return result;
end $$;
create function public.create_contract(p_company uuid,p_client uuid,p_product uuid,p_name text,p_team uuid default null) returns uuid
language plpgsql security definer set search_path = '' as $$ declare result uuid; begin
 if not mavi_private.admin(p_company) then raise exception 'Sem permissão' using errcode='42501'; end if;
 insert into public.contracts(company_id,client_id,product_id,name) values(p_company,p_client,p_product,p_name) returning id into result;
 if p_team is not null then insert into public.contract_teams values(p_company,result,p_team); end if; return result;
end $$;
create function public.create_project(p_company uuid,p_contract uuid,p_name text,p_due date default null) returns uuid
language plpgsql security definer set search_path = '' as $$ declare result uuid; begin
 if not mavi_private.contract_access(p_company,p_contract) or not (mavi_private.admin(p_company) or exists(
 select 1 from public.contract_teams where company_id=p_company and contract_id=p_contract and mavi_private.manager(p_company,team_id)))
 then raise exception 'Sem permissão' using errcode='42501'; end if;
 insert into public.projects(company_id,contract_id,name,due_date) values(p_company,p_contract,trim(p_name),p_due) returning id into result; return result;
end $$;
create function public.create_task(p_company uuid,p_contract uuid,p_title text,p_assignee uuid,p_due date,
 p_project uuid default null,p_team uuid default null,p_description text default '',p_priority text default 'normal',
 p_estimated integer default 0,p_client_approval boolean default false,p_parent uuid default null) returns uuid
language plpgsql security definer set search_path = '' as $$ declare result uuid; begin
 if not mavi_private.contract_access(p_company,p_contract) then raise exception 'Sem acesso ao produto contratado' using errcode='42501'; end if;
 if not exists(select 1 from public.memberships where company_id=p_company and user_id=p_assignee and active) then raise exception 'Responsável inválido'; end if;
 if p_team is not null and not exists(select 1 from public.contract_teams where company_id=p_company and contract_id=p_contract and team_id=p_team) then raise exception 'Equipe fora do produto contratado'; end if;
 if p_parent is not null and not mavi_private.can_edit(p_company,p_parent) then raise exception 'Sem acesso à tarefa principal' using errcode='42501'; end if;
 insert into public.tasks(company_id,contract_id,title,assignee_id,due_date,original_due_date,project_id,team_id,description,priority,estimated_minutes,requires_client_approval,parent_id)
 values(p_company,p_contract,trim(p_title),p_assignee,p_due,p_due,p_project,p_team,p_description,p_priority,p_estimated,p_client_approval,p_parent) returning id into result;
 insert into public.task_events(company_id,task_id,actor_id,action) values(p_company,result,auth.uid(),'created'); return result;
end $$;

create function public.transition_task(p_task uuid,p_version integer,p_action text,p_note text default '') returns void
language plpgsql security definer set search_path = '' as $$ declare t public.tasks; next_status text; begin
 select * into t from public.tasks where id=p_task for update;
 if not found or not mavi_private.can_edit(t.company_id,t.id) then raise exception 'Sem acesso à tarefa' using errcode='42501'; end if;
 if t.version<>p_version then raise exception 'A tarefa mudou. Atualize antes de continuar.' using errcode='40001'; end if;
 next_status:=t.status;
 case p_action
 when 'start' then
  if t.status not in ('open','returned') then raise exception 'Transição inválida'; end if; next_status:='progress';
 when 'return' then
  if t.status not in ('open','progress','review') or length(trim(p_note))<3 then raise exception 'Informe o motivo da devolução'; end if; next_status:='returned';
 when 'submit' then
  if t.status not in ('open','progress','returned') then raise exception 'Transição inválida'; end if; next_status:='review';
 when 'reject' then
  if t.status<>'review' or not mavi_private.can_approve(t.company_id,t.id) then raise exception 'Sem permissão para reprovar' using errcode='42501'; end if;
  if length(trim(p_note))<3 then raise exception 'Informe o motivo da reprovação'; end if; next_status:='progress';
 when 'approve_internal' then
  if t.status<>'review' or not mavi_private.can_approve(t.company_id,t.id) then raise exception 'Sem permissão para aprovar' using errcode='42501'; end if;
  t.internal_approved_by:=auth.uid();
 when 'approve_client' then
  if t.status<>'review' or not t.requires_client_approval or not mavi_private.can_approve(t.company_id,t.id) then raise exception 'Sem permissão para registrar aprovação' using errcode='42501'; end if;
  if length(trim(p_note))<5 then raise exception 'Informe quem aprovou e a evidência'; end if;
  t.client_approved_by:=auth.uid(); t.client_approval_note:=p_note;
 when 'reopen' then
  if t.status<>'done' or not mavi_private.can_approve(t.company_id,t.id) then raise exception 'Sem permissão para reabrir' using errcode='42501'; end if;
  if length(trim(p_note))<3 then raise exception 'Informe o motivo'; end if; next_status:='progress';
 else raise exception 'Ação inválida';
 end case;
 if p_action in ('return','reject','reopen') then
  t.internal_approved_by:=null; t.client_approved_by:=null; t.client_approval_note:=null; t.revision:=t.revision+1;
 end if;
 if next_status='review' and t.internal_approved_by is not null and (not t.requires_client_approval or t.client_approved_by is not null) then next_status:='done'; end if;
 update public.tasks set status=next_status, internal_approved_by=t.internal_approved_by, client_approved_by=t.client_approved_by,
 client_approval_note=t.client_approval_note, revision=t.revision, version=version+1, delivered_at=case when next_status='done' then now() else null end where id=t.id;
 insert into public.task_events(company_id,task_id,actor_id,action,detail) values(t.company_id,t.id,auth.uid(),p_action,
 jsonb_build_object('note',p_note,'from',t.status,'to',next_status,'revision',t.revision,'due_date',t.due_date));
end $$;

create function public.update_task(p_task uuid,p_version integer,p_title text,p_description text,p_due date,p_estimated integer,p_priority text) returns void
language plpgsql security definer set search_path = '' as $$ declare t public.tasks; begin
 select * into t from public.tasks where id=p_task for update;
 if not found or not mavi_private.can_edit(t.company_id,t.id) then raise exception 'Sem permissão' using errcode='42501'; end if;
 if t.version<>p_version then raise exception 'A tarefa mudou. Atualize antes de continuar.' using errcode='40001'; end if;
 if t.status='done' then raise exception 'Reabra a tarefa antes de editar'; end if;
 update public.tasks set title=trim(p_title),description=p_description,due_date=p_due,estimated_minutes=p_estimated,priority=p_priority,
 internal_approved_by=null,client_approved_by=null,client_approval_note=null,revision=revision+1,version=version+1,
 status=case when status='review' then 'progress' else status end where id=t.id;
 insert into public.task_events(company_id,task_id,actor_id,action,detail) values(t.company_id,t.id,auth.uid(),'edited',jsonb_build_object('old_due',t.due_date,'new_due',p_due));
end $$;
create function public.add_comment(p_task uuid,p_body text) returns uuid
language plpgsql security definer set search_path = '' as $$ declare t public.tasks; result uuid; begin
 select * into t from public.tasks where id=p_task;
 if not found or not mavi_private.task_access(t.company_id,t.id) then raise exception 'Sem permissão' using errcode='42501'; end if;
 insert into public.comments(company_id,task_id,body) values(t.company_id,t.id,trim(p_body)) returning id into result; return result;
end $$;
create function public.start_timer(p_task uuid) returns uuid
language plpgsql security definer set search_path = '' as $$ declare t public.tasks; result uuid; begin
 select * into t from public.tasks where id=p_task;
 if not found or not mavi_private.task_access(t.company_id,t.id) then raise exception 'Sem permissão' using errcode='42501'; end if;
 if t.status='done' then raise exception 'Tarefa já entregue'; end if;
 perform pg_advisory_xact_lock(hashtextextended(auth.uid()::text,0));
 select id into result from public.time_entries where user_id=auth.uid() and ended_at is null and task_id=p_task;
 if found then return result; end if;
 if exists(select 1 from public.time_entries where user_id=auth.uid() and ended_at is null) then raise exception 'Já existe um cronômetro em andamento. Encerre-o antes de iniciar outro.'; end if;
 insert into public.time_entries(company_id,task_id,started_at,source) values(t.company_id,t.id,clock_timestamp(),'timer') returning id into result; return result;
end $$;
create function public.stop_timer(p_entry uuid) returns void
language plpgsql security definer set search_path = '' as $$ declare e public.time_entries; begin
 select * into e from public.time_entries where id=p_entry for update;
 if not found or e.user_id<>auth.uid() or not mavi_private.task_access(e.company_id,e.task_id) then raise exception 'Sem permissão' using errcode='42501'; end if;
 if e.ended_at is not null then return; end if;
 update public.time_entries set ended_at=greatest(clock_timestamp(),started_at+interval '1 millisecond') where id=e.id;
end $$;
create function public.log_time(p_task uuid,p_start timestamptz,p_end timestamptz,p_note text default '') returns uuid
language plpgsql security definer set search_path = '' as $$ declare t public.tasks; result uuid; begin
 select * into t from public.tasks where id=p_task;
 if not found or not mavi_private.task_access(t.company_id,t.id) then raise exception 'Sem permissão' using errcode='42501'; end if;
 if p_start is null or p_end is null or p_end<=p_start or p_end>now()+interval '1 minute' then raise exception 'Período inválido'; end if;
 perform pg_advisory_xact_lock(hashtextextended(auth.uid()::text,0));
 if exists(select 1 from public.time_entries where user_id=auth.uid() and started_at<p_end and coalesce(ended_at,now())>p_start) then raise exception 'Este período sobrepõe outro apontamento'; end if;
 insert into public.time_entries(company_id,task_id,started_at,ended_at,note,source) values(t.company_id,t.id,p_start,p_end,p_note,'manual') returning id into result; return result;
end $$;
create function public.prepare_attachment(p_task uuid,p_name text,p_size bigint) returns public.attachments
language plpgsql security definer set search_path = '' as $$ declare t public.tasks; a public.attachments; aid uuid:=gen_random_uuid(); begin
 select * into t from public.tasks where id=p_task;
 if not found or not mavi_private.task_access(t.company_id,t.id) then raise exception 'Sem permissão' using errcode='42501'; end if;
 insert into public.attachments(id,company_id,task_id,name,path,size_bytes) values(aid,t.company_id,t.id,p_name,t.company_id::text||'/'||t.id::text||'/'||aid::text,p_size) returning * into a; return a;
end $$;
create function public.create_team(p_company uuid,p_name text,p_users uuid[] default '{}') returns uuid
language plpgsql security definer set search_path = '' as $$ declare result uuid; u uuid; begin
 if not mavi_private.admin(p_company) then raise exception 'Sem permissão' using errcode='42501'; end if;
 if length(trim(p_name))<2 then raise exception 'Nome obrigatório'; end if;
 insert into public.teams(company_id,name) values(p_company,trim(p_name)) returning id into result;
 foreach u in array p_users loop insert into public.team_members values(p_company,result,u); end loop; return result;
end $$;

-- Grants apply only to these application functions; never revoke unrelated project functions.
do $$ declare f record; begin
 for f in select p.oid::regprocedure as signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace
 where n.nspname='public' and p.proname=any(array['create_client','create_product','create_contract','create_project','create_task','transition_task','update_task','add_comment','start_timer','stop_timer','log_time','prepare_attachment','create_team']) loop
 execute format('revoke all on function %s from public, anon',f.signature);
 execute format('grant execute on function %s to authenticated',f.signature);
 end loop;
end $$;
commit;
