begin;
create function mavi_private.can_work(c uuid, t uuid) returns boolean language sql stable security definer set search_path = '' as $$
 select mavi_private.task_access(c,t) and exists(select 1 from public.tasks where company_id=c and id=t and
 (mavi_private.admin(c) or mavi_private.manager(c,team_id) or creator_id=auth.uid() or assignee_id=auth.uid()))
$$;
revoke all on function mavi_private.can_work(uuid,uuid) from public,anon;
grant execute on function mavi_private.can_work(uuid,uuid) to authenticated;
create or replace function public.transition_task(p_task uuid,p_version integer,p_action text,p_note text default '') returns void
language plpgsql security definer set search_path = '' as $$ declare t public.tasks; next_status text; begin
 select * into t from public.tasks where id=p_task for update;
 if not found or not mavi_private.can_work(t.company_id,t.id) then raise exception 'Sem acesso à tarefa' using errcode='42501'; end if;
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

alter table public.tasks add column start_date date;
alter table public.tasks add constraint task_planned_dates check(start_date is null or start_date <= due_date);
create or replace function mavi_private.can_edit(c uuid,t uuid) returns boolean language sql stable security definer set search_path='' as $$
 select mavi_private.task_access(c,t) and exists(select 1 from public.tasks where company_id=c and id=t and (mavi_private.admin(c) or creator_id=auth.uid()))
$$;
create or replace function public.start_timer(p_task uuid) returns uuid language plpgsql security definer set search_path='' as $$
declare t public.tasks; result uuid; switched_at timestamptz; begin
 perform pg_advisory_xact_lock(hashtextextended(auth.uid()::text,0));
 select * into t from public.tasks where id=p_task;
 if not found or not mavi_private.task_access(t.company_id,t.id) then raise exception 'Sem permissão' using errcode='42501'; end if;
 select id into result from public.time_entries where user_id=auth.uid() and ended_at is null and task_id=p_task;
 if found then return result; end if;
 select greatest(clock_timestamp(),coalesce(max(started_at)+interval '1 millisecond',clock_timestamp())) into switched_at from public.time_entries where user_id=auth.uid() and ended_at is null;
 update public.time_entries set ended_at=switched_at where user_id=auth.uid() and ended_at is null;
 insert into public.time_entries(company_id,task_id,started_at,source) values(t.company_id,t.id,switched_at,'timer') returning id into result;
 return result;
end $$;
create or replace function public.stop_timer(p_entry uuid) returns void language plpgsql security definer set search_path='' as $$
declare e public.time_entries; begin
 perform pg_advisory_xact_lock(hashtextextended(auth.uid()::text,0));
 select * into e from public.time_entries where id=p_entry for update;
 if not found or e.user_id<>auth.uid() then raise exception 'Sem permissão' using errcode='42501'; end if;
 if e.ended_at is not null then return; end if;
 update public.time_entries set ended_at=greatest(clock_timestamp(),started_at+interval '1 millisecond') where id=e.id;
end $$;
drop function public.create_task(uuid,uuid,text,uuid,date,uuid,uuid,text,text,integer,boolean,uuid);
create function public.create_task(p_company uuid,p_contract uuid,p_title text,p_assignee uuid,p_due date,
 p_project uuid default null,p_team uuid default null,p_description text default '',p_priority text default 'normal',
 p_estimated integer default 0,p_client_approval boolean default false,p_parent uuid default null,p_start date default null) returns uuid
language plpgsql security definer set search_path = '' as $$ declare result uuid; begin
 if not mavi_private.contract_access(p_company,p_contract) then raise exception 'Sem acesso ao produto contratado' using errcode='42501'; end if;
 if not exists(select 1 from public.memberships where company_id=p_company and user_id=p_assignee and active) then raise exception 'Responsável inválido'; end if;
 if p_team is not null and not exists(select 1 from public.contract_teams where company_id=p_company and contract_id=p_contract and team_id=p_team) then raise exception 'Equipe fora do produto contratado'; end if;
 if p_parent is not null and not mavi_private.can_edit(p_company,p_parent) then raise exception 'Sem acesso à tarefa principal' using errcode='42501'; end if;
 insert into public.tasks(company_id,contract_id,title,assignee_id,due_date,original_due_date,project_id,team_id,description,priority,estimated_minutes,requires_client_approval,parent_id,start_date)
 values(p_company,p_contract,trim(p_title),p_assignee,p_due,p_due,p_project,p_team,p_description,p_priority,p_estimated,p_client_approval,p_parent,p_start) returning id into result;
 insert into public.task_events(company_id,task_id,actor_id,action) values(p_company,result,auth.uid(),'created'); return result;
end $$;


drop function public.update_task(uuid,integer,text,text,date,integer,text);
create function public.update_task(p_task uuid,p_version integer,p_title text,p_description text,p_due date,p_estimated integer,p_priority text,p_start date default null) returns void
language plpgsql security definer set search_path = '' as $$ declare t public.tasks; begin
 select * into t from public.tasks where id=p_task for update;
 if not found or not mavi_private.can_edit(t.company_id,t.id) then raise exception 'Sem permissão' using errcode='42501'; end if;
 if t.version<>p_version then raise exception 'A tarefa mudou. Atualize antes de continuar.' using errcode='40001'; end if;

 update public.tasks set start_date=p_start,title=trim(p_title),description=p_description,due_date=p_due,estimated_minutes=p_estimated,priority=p_priority,
 internal_approved_by=null,client_approved_by=null,client_approval_note=null,revision=revision+1,version=version+1,
 delivered_at=null,status=case when status in ('review','done') then 'progress' else status end where id=t.id;
 insert into public.task_events(company_id,task_id,actor_id,action,detail) values(t.company_id,t.id,auth.uid(),'edited',jsonb_build_object('old_due',t.due_date,'new_due',p_due));
end $$;

create or replace function public.create_project(p_company uuid,p_contract uuid,p_name text,p_due date default null) returns uuid
language plpgsql security definer set search_path='' as $$ declare result uuid; begin
 if not mavi_private.admin(p_company) then raise exception 'Sem permissão' using errcode='42501'; end if;
 insert into public.projects(company_id,contract_id,name,due_date) values(p_company,p_contract,trim(p_name),p_due) returning id into result; return result;
end $$;
create function public.update_client(p_client uuid,p_name text,p_email text) returns void language plpgsql security definer set search_path='' as $$
declare c public.clients; begin
 select * into c from public.clients where id=p_client for update;
 if not found or not mavi_private.admin(c.company_id) then raise exception 'Sem permissão' using errcode='42501'; end if;
 update public.clients set name=trim(p_name),email=trim(p_email) where id=p_client;
end $$;
create function public.update_product(p_product uuid,p_name text) returns void language plpgsql security definer set search_path='' as $$
declare p public.products; begin
 select * into p from public.products where id=p_product for update;
 if not found or not mavi_private.admin(p.company_id) then raise exception 'Sem permissão' using errcode='42501'; end if;
 update public.products set name=trim(p_name) where id=p_product;
end $$;
create function public.update_project(p_project uuid,p_name text,p_due date,p_contract uuid default null) returns void language plpgsql security definer set search_path='' as $$
declare p public.projects; begin
 select * into p from public.projects where id=p_project for update;
 if not found or not mavi_private.admin(p.company_id) then raise exception 'Sem permissão' using errcode='42501'; end if;
 if p_contract is not null and p_contract<>p.contract_id and exists(select 1 from public.tasks where project_id=p_project) then raise exception 'Projetos com tarefas não podem mudar de produto contratado.'; end if;
 update public.projects set name=trim(p_name),due_date=p_due,contract_id=coalesce(p_contract,contract_id) where id=p_project;
end $$;
create function public.update_contract(p_contract uuid,p_name text,p_client uuid,p_product uuid) returns void language plpgsql security definer set search_path='' as $$
declare c public.contracts; begin
 select * into c from public.contracts where id=p_contract for update;
 if not found or not mavi_private.admin(c.company_id) then raise exception 'Sem permissão' using errcode='42501'; end if;
 if length(trim(p_name)) not between 2 and 160 then raise exception 'Informe um nome de 2 a 160 caracteres'; end if;
 update public.contracts set name=trim(p_name),client_id=p_client,product_id=p_product where id=p_contract;
end $$;

-- Images are private drafts until a task or comment binds them in the same transaction.
create table public.inline_images (
 id uuid primary key default gen_random_uuid(), company_id uuid not null references public.companies(id),
 task_id uuid, uploaded_by uuid not null default auth.uid() references auth.users(id),
 name text not null, path text not null unique, size_bytes bigint not null check(size_bytes between 1 and 5242880),
 created_at timestamptz not null default now(),
 foreign key(company_id,task_id) references public.tasks(company_id,id),
 check(path=company_id::text || '/' || uploaded_by::text || '/' || id::text)
);
create index inline_images_task on public.inline_images(company_id,task_id);
create index inline_images_author on public.inline_images(uploaded_by,created_at);
alter table public.inline_images enable row level security;
revoke all on public.inline_images from public,anon,authenticated;
grant select on public.inline_images to authenticated;
create policy inline_images_read on public.inline_images for select to authenticated using(
 mavi_private.member(company_id) and ((task_id is null and uploaded_by=(select auth.uid())) or (task_id is not null and mavi_private.task_access(company_id,task_id)))
);
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
 values('mavi-inline-images','mavi-inline-images',false,5242880,array['image/jpeg','image/png','image/webp']);
create policy inline_images_storage_read on storage.objects for select to authenticated using(bucket_id='mavi-inline-images' and exists(select 1 from public.inline_images i where i.path=storage.objects.name));
create policy inline_images_storage_insert on storage.objects for insert to authenticated with check(bucket_id='mavi-inline-images' and exists(select 1 from public.inline_images i where i.path=storage.objects.name and i.uploaded_by=(select auth.uid()) and i.task_id is null));
create function public.prepare_inline_image(p_company uuid,p_name text,p_size bigint) returns public.inline_images language plpgsql security definer set search_path='' as $$
declare result public.inline_images; image_id uuid:=gen_random_uuid(); begin
 if not mavi_private.member(p_company) then raise exception 'Sem permissão' using errcode='42501'; end if;
 if length(trim(p_name)) not between 1 and 240 then raise exception 'Nome de arquivo inválido'; end if;
 insert into public.inline_images(id,company_id,name,path,size_bytes) values(image_id,p_company,p_name,p_company::text||'/'||auth.uid()::text||'/'||image_id::text,p_size) returning * into result;
 return result;
end $$;
create function mavi_private.bind_inline_images(c uuid,t uuid,body text) returns void language plpgsql security definer set search_path='' as $$
declare doc jsonb; node jsonb; image_id uuid; image_row public.inline_images; begin
 if left(body,17)<>'mavi:richtext:v1:' then return; end if;
 doc:=substring(body from 18)::jsonb;
 for node in select distinct value from jsonb_path_query(doc,'$.** ? (@.type == "inlineImage")') as nodes(value) loop
  image_id:=(node->'attrs'->>'imageId')::uuid;
  select * into image_row from public.inline_images where id=image_id for update;
  if not found or image_row.company_id<>c or not ((image_row.task_id is not distinct from t) or (image_row.task_id is null and image_row.uploaded_by=auth.uid())) then raise exception 'Imagem não autorizada para esta tarefa' using errcode='42501'; end if;
  if not exists(select 1 from storage.objects where bucket_id='mavi-inline-images' and name=image_row.path) then raise exception 'Aguarde o envio completo da imagem'; end if;
  update public.inline_images set task_id=t where id=image_id and task_id is null;
 end loop;
end $$;
create function mavi_private.bind_task_images() returns trigger language plpgsql security definer set search_path='' as $$ begin perform mavi_private.bind_inline_images(new.company_id,new.id,new.description); return new; end $$;
create function mavi_private.bind_comment_images() returns trigger language plpgsql security definer set search_path='' as $$ begin perform mavi_private.bind_inline_images(new.company_id,new.task_id,new.body); return new; end $$;
create trigger bind_task_images after insert or update of description on public.tasks for each row execute function mavi_private.bind_task_images();
create trigger bind_comment_images after insert or update of body on public.comments for each row execute function mavi_private.bind_comment_images();
revoke all on function mavi_private.bind_inline_images(uuid,uuid,text),mavi_private.bind_task_images(),mavi_private.bind_comment_images() from public,anon,authenticated;
-- Increase serialized comment capacity; image binary data stays in Storage.
alter table public.comments drop constraint comments_body_check;
alter table public.comments add constraint comments_body_check check(length(trim(body)) between 1 and 100000);
do $$ declare f record; begin
 for f in select p.oid::regprocedure as signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname=any(array['create_task','update_task','update_client','update_product','update_project','update_contract','prepare_inline_image']) loop
 execute format('revoke all on function %s from public,anon',f.signature);
 execute format('grant execute on function %s to authenticated',f.signature);
 end loop;
end $$;
commit;
