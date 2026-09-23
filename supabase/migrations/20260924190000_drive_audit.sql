begin;

-- Audit trail of every Drive action. Rows are written only by the Drive
-- functions themselves (so no action can skip it), are readable by leaders,
-- and can never be changed or removed. Names are snapshotted so entries stay
-- meaningful after files or folders are renamed or deleted.
create table public.drive_audit (
 id bigint generated always as identity primary key,
 company_id uuid not null references public.companies(id),
 actor_id uuid,          -- null: anonymous access through a public link
 action text not null,
 file_id uuid,
 folder_id uuid,
 item_name text,
 client_id uuid,
 contract_id uuid,
 details jsonb not null default '{}',
 created_at timestamptz not null default now()
);
create index drive_audit_company_created on public.drive_audit(company_id, created_at desc, id desc);
create index drive_audit_file on public.drive_audit(company_id, file_id) where file_id is not null;
create index drive_audit_folder on public.drive_audit(company_id, folder_id) where folder_id is not null;
alter table public.drive_audit enable row level security;
revoke all on public.drive_audit from public, anon, authenticated;
grant select on public.drive_audit to authenticated;
create policy drive_audit_read on public.drive_audit for select to authenticated
 using (company_id in (select mavi_private.leader_companies()));

create function mavi_private.drive_audit_immutable() returns trigger
language plpgsql set search_path = '' as $$ begin
  raise exception 'O histórico do Drive não pode ser alterado.';
end $$;
create trigger drive_audit_immutable before update or delete on public.drive_audit
 for each row execute function mavi_private.drive_audit_immutable();

-- Where the request came from, as seen by the API gateway (browser calls).
create function mavi_private.request_client() returns jsonb
language sql stable set search_path = '' as $$
 select jsonb_strip_nulls(jsonb_build_object(
  'ip', nullif(trim(split_part(coalesce(h->>'x-forwarded-for', h->>'x-real-ip', ''), ',', 1)), ''),
  'user_agent', left(h->>'user-agent', 300)))
 from (select nullif(current_setting('request.headers', true), '')::jsonb as h) r
$$;

create function mavi_private.drive_log(c uuid, p_action text, p_file uuid, p_folder uuid, p_name text,
 p_client uuid, p_contract uuid, p_details jsonb default '{}', p_origin jsonb default null) returns void
language sql security definer set search_path = '' as $$
 insert into public.drive_audit(company_id, actor_id, action, file_id, folder_id, item_name, client_id, contract_id, details)
 values (c, auth.uid(), p_action, p_file, p_folder, p_name, p_client, p_contract,
  coalesce(p_details, '{}') || jsonb_build_object('origin',
   coalesce(nullif(p_origin, '{}'::jsonb), mavi_private.request_client(), '{}'::jsonb)))
$$;
revoke all on function mavi_private.drive_log(uuid,text,uuid,uuid,text,uuid,uuid,jsonb,jsonb),
 mavi_private.request_client(), mavi_private.drive_audit_immutable() from public, anon, authenticated;

-- Server-supplied origin (IP/user agent) is only kept for fields the gateway
-- could not see, and trimmed.
create function mavi_private.clean_origin(p jsonb) returns jsonb
language sql immutable set search_path = '' as $$
 select jsonb_strip_nulls(jsonb_build_object(
  'ip', left(nullif(trim(p->>'ip'), ''), 64),
  'user_agent', left(nullif(trim(p->>'user_agent'), ''), 300)))
$$;
revoke all on function mavi_private.clean_origin(jsonb) from public, anon, authenticated;

-- ---------------------------------------------------------------- files
create or replace function public.prepare_drive_file(p_company uuid, p_name text, p_size bigint, p_content_type text,
 p_visibility text default 'private', p_client uuid default null, p_contract uuid default null, p_folder uuid default null) returns uuid
language plpgsql security definer set search_path = '' as $$
declare result uuid := gen_random_uuid(); loc record; begin
  if not mavi_private.member(p_company) then raise exception 'Sem acesso ao espaço' using errcode = '42501'; end if;
  select * into loc from mavi_private.drive_location(p_company, p_client, p_contract, p_folder);
  if not mavi_private.drive_can_write(p_company, loc.client_id, loc.contract_id) then
    raise exception 'Somente administradores e gestores enviam arquivos fora das pastas de produto.' using errcode = '42501';
  end if;
  if p_size is null or p_size < 1 or p_size > 524288000 then raise exception 'Envie arquivos de até 500 MB.'; end if;
  insert into public.drive_files(id, company_id, name, content_type, size_bytes, path, visibility, client_id, contract_id, folder_id)
  values(result, p_company, trim(p_name), coalesce(nullif(trim(p_content_type), ''), 'application/octet-stream'), p_size,
   'drive/' || p_company || '/' || result, coalesce(p_visibility, 'private'), loc.client_id, loc.contract_id, p_folder);
  perform mavi_private.drive_log(p_company, 'upload_started', result, p_folder, trim(p_name), loc.client_id, loc.contract_id,
   jsonb_build_object('size_bytes', p_size, 'content_type', coalesce(nullif(trim(p_content_type), ''), 'application/octet-stream'),
    'visibility', coalesce(p_visibility, 'private')));
  return result;
end $$;

create or replace function public.confirm_drive_file(p_file uuid) returns void
language plpgsql security definer set search_path = '' as $$ declare f public.drive_files; begin
  update public.drive_files set status = 'ready'
  where id = p_file and uploaded_by = auth.uid() and status = 'pending' returning * into f;
  if not found then raise exception 'Arquivo não encontrado' using errcode = '42501'; end if;
  perform mavi_private.drive_log(f.company_id, 'upload_completed', f.id, f.folder_id, f.name, f.client_id, f.contract_id,
   jsonb_build_object('size_bytes', f.size_bytes, 'content_type', f.content_type, 'visibility', f.visibility));
end $$;

create or replace function public.set_drive_file_visibility(p_file uuid, p_visibility text) returns void
language plpgsql security definer set search_path = '' as $$ declare f public.drive_files; begin
  select * into f from public.drive_files where id = p_file for update;
  if not found or not mavi_private.drive_manager(f) then raise exception 'Sem permissão' using errcode = '42501'; end if;
  update public.drive_files set visibility = p_visibility where id = p_file;
  perform mavi_private.drive_log(f.company_id, 'visibility_changed', f.id, f.folder_id, f.name, f.client_id, f.contract_id,
   jsonb_build_object('from', f.visibility, 'to', p_visibility));
end $$;

create or replace function public.rename_drive_file(p_file uuid, p_name text) returns void
language plpgsql security definer set search_path = '' as $$ declare f public.drive_files; begin
  select * into f from public.drive_files where id = p_file for update;
  if not found or not mavi_private.drive_can_write(f.company_id, f.client_id, f.contract_id) then
    raise exception 'Sem permissão para alterar este arquivo' using errcode = '42501';
  end if;
  update public.drive_files set name = trim(p_name) where id = p_file;
  perform mavi_private.drive_log(f.company_id, 'file_renamed', f.id, f.folder_id, trim(p_name), f.client_id, f.contract_id,
   jsonb_build_object('from', f.name, 'to', trim(p_name)));
end $$;

create or replace function public.delete_drive_file(p_file uuid) returns text
language plpgsql security definer set search_path = '' as $$ declare f public.drive_files; begin
  select * into f from public.drive_files where id = p_file for update;
  if not found or not mavi_private.drive_manager(f) then raise exception 'Sem permissão' using errcode = '42501'; end if;
  delete from public.drive_files where id = p_file;
  perform mavi_private.drive_log(f.company_id, 'file_deleted', f.id, f.folder_id, f.name, f.client_id, f.contract_id,
   jsonb_build_object('size_bytes', f.size_bytes, 'content_type', f.content_type, 'visibility', f.visibility,
    'uploaded_by', f.uploaded_by, 'status', f.status));
  return f.path;
end $$;

-- The client copies a public link without talking to the server; it reports it.
create function public.log_drive_link_copied(p_file uuid) returns void
language plpgsql security definer set search_path = '' as $$ declare f public.drive_files; begin
  select * into f from public.drive_files where id = p_file and status = 'ready' and visibility = 'public';
  if not found or not mavi_private.drive_can_read(f.company_id, f.client_id) then
    raise exception 'Arquivo não encontrado' using errcode = '42501';
  end if;
  perform mavi_private.drive_log(f.company_id, 'link_copied', f.id, f.folder_id, f.name, f.client_id, f.contract_id);
end $$;

-- Downloads and views go through /api/drive, which forwards the browser's
-- origin (the gateway only sees the server).
drop function public.drive_download_target(uuid);
create function public.drive_download_target(p_file uuid, p_inline boolean default false, p_origin jsonb default '{}')
 returns table(path text, name text, content_type text)
language plpgsql security definer set search_path = '' as $$ declare f public.drive_files; begin
  select * into f from public.drive_files d where d.id = p_file and d.status = 'ready';
  if not found or not mavi_private.drive_can_read(f.company_id, f.client_id) then return; end if;
  perform mavi_private.drive_log(f.company_id, case when p_inline then 'file_viewed' else 'file_downloaded' end,
   f.id, f.folder_id, f.name, f.client_id, f.contract_id, jsonb_build_object('visibility', f.visibility),
   mavi_private.clean_origin(p_origin));
  return query select f.path, f.name, f.content_type;
end $$;

drop function public.drive_public_target(text);
create function public.drive_public_target(p_token text, p_inline boolean default false, p_origin jsonb default '{}')
 returns table(path text, name text, content_type text, size_bytes bigint)
language plpgsql security definer set search_path = '' as $$ declare f public.drive_files; begin
  select * into f from public.drive_files d where d.share_token = p_token and d.visibility = 'public' and d.status = 'ready';
  if not found then return; end if;
  perform mavi_private.drive_log(f.company_id, case when p_inline then 'public_viewed' else 'public_downloaded' end,
   f.id, f.folder_id, f.name, f.client_id, f.contract_id, '{}', mavi_private.clean_origin(p_origin));
  return query select f.path, f.name, f.content_type, f.size_bytes;
end $$;

-- ---------------------------------------------------------------- folders
create or replace function public.create_drive_folder(p_company uuid, p_name text, p_client uuid default null,
 p_contract uuid default null, p_parent uuid default null) returns uuid
language plpgsql security definer set search_path = '' as $$
declare result uuid; loc record; begin
  if not mavi_private.member(p_company) then raise exception 'Sem acesso ao espaço' using errcode = '42501'; end if;
  select * into loc from mavi_private.drive_location(p_company, p_client, p_contract, p_parent);
  if not mavi_private.drive_can_write(p_company, loc.client_id, loc.contract_id) then
    raise exception 'Somente administradores e gestores criam pastas fora das pastas de produto.' using errcode = '42501';
  end if;
  insert into public.drive_folders(company_id, client_id, contract_id, parent_id, name)
  values(p_company, loc.client_id, loc.contract_id, p_parent, trim(p_name)) returning id into result;
  perform mavi_private.drive_log(p_company, 'folder_created', null, result, trim(p_name), loc.client_id, loc.contract_id,
   jsonb_build_object('parent_id', p_parent));
  return result;
end $$;

create or replace function public.rename_drive_folder(p_folder uuid, p_name text) returns void
language plpgsql security definer set search_path = '' as $$ declare f public.drive_folders; begin
  select * into f from public.drive_folders where id = p_folder for update;
  if not found or not mavi_private.drive_can_write(f.company_id, f.client_id, f.contract_id) then
    raise exception 'Sem permissão para alterar esta pasta' using errcode = '42501';
  end if;
  update public.drive_folders set name = trim(p_name) where id = p_folder;
  perform mavi_private.drive_log(f.company_id, 'folder_renamed', null, f.id, trim(p_name), f.client_id, f.contract_id,
   jsonb_build_object('from', f.name, 'to', trim(p_name)));
end $$;

create or replace function public.delete_drive_folder(p_folder uuid) returns void
language plpgsql security definer set search_path = '' as $$ declare f public.drive_folders; begin
  select * into f from public.drive_folders where id = p_folder for update;
  if not found or not mavi_private.drive_can_write(f.company_id, f.client_id, f.contract_id)
   or not (f.created_by = auth.uid() or mavi_private.leader(f.company_id)) then
    raise exception 'Sem permissão para excluir esta pasta' using errcode = '42501';
  end if;
  if exists(select 1 from public.drive_folders where parent_id = p_folder)
   or exists(select 1 from public.drive_files where folder_id = p_folder) then
    raise exception 'Esvazie a pasta antes de excluí-la.';
  end if;
  delete from public.drive_folders where id = p_folder;
  perform mavi_private.drive_log(f.company_id, 'folder_deleted', null, f.id, f.name, f.client_id, f.contract_id,
   jsonb_build_object('parent_id', f.parent_id, 'created_by', f.created_by));
end $$;

do $$ declare f record; begin
 for f in select p.oid::regprocedure as signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='public' and p.proname=any(array['drive_download_target','log_drive_link_copied']) loop
 execute format('revoke all on function %s from public,anon',f.signature);
 execute format('grant execute on function %s to authenticated',f.signature);
 end loop;
end $$;
revoke all on function public.drive_public_target(text, boolean, jsonb) from public;
grant execute on function public.drive_public_target(text, boolean, jsonb) to anon, authenticated;

commit;
