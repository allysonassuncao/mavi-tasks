begin;

-- Drive: files people upload to GCS. The object path is never readable by
-- clients (column grant below); the /api/drive server resolves it through the
-- functions at the bottom, which check permissions, and hands out short-lived
-- signed URLs. Private files: any active member of the company. Public files:
-- anyone holding the share link.
create table public.drive_files (
 id uuid primary key default gen_random_uuid(),
 company_id uuid not null references public.companies(id),
 name text not null check (length(trim(name)) between 1 and 255),
 content_type text not null default 'application/octet-stream' check (length(content_type) between 1 and 255),
 size_bytes bigint not null check (size_bytes between 1 and 524288000),
 path text not null unique,
 visibility text not null default 'private' check (visibility in ('private','public')),
 share_token text not null unique default (replace(gen_random_uuid()::text,'-','') || replace(gen_random_uuid()::text,'-','')),
 status text not null default 'pending' check (status in ('pending','ready')),
 uploaded_by uuid not null default auth.uid(),
 created_at timestamptz not null default now(),
 unique(company_id,id),
 foreign key(company_id,uploaded_by) references public.memberships(company_id,user_id)
);
create index drive_files_company_created on public.drive_files(company_id, created_at desc);
alter table public.drive_files enable row level security;
revoke all on public.drive_files from anon, authenticated;
grant select (id, company_id, name, content_type, size_bytes, visibility, share_token, status, uploaded_by, created_at)
 on public.drive_files to authenticated;
-- Pending uploads are visible only to whoever is uploading them.
create policy drive_files_read on public.drive_files for select to authenticated using (
 company_id in (select mavi_private.active_companies())
 and (status = 'ready' or uploaded_by = (select auth.uid()))
);

create function mavi_private.drive_manager(f public.drive_files) returns boolean
language sql stable security definer set search_path = '' as $$
 select mavi_private.member(f.company_id) and (f.uploaded_by = auth.uid() or mavi_private.leader(f.company_id))
$$;
revoke all on function mavi_private.drive_manager(public.drive_files) from public, anon;
grant execute on function mavi_private.drive_manager(public.drive_files) to authenticated;

create function public.prepare_drive_file(p_company uuid, p_name text, p_size bigint, p_content_type text, p_visibility text default 'private') returns uuid
language plpgsql security definer set search_path = '' as $$ declare result uuid := gen_random_uuid(); begin
  if not mavi_private.member(p_company) then raise exception 'Sem acesso ao espaço' using errcode = '42501'; end if;
  if p_size is null or p_size < 1 or p_size > 524288000 then raise exception 'Envie arquivos de até 500 MB.'; end if;
  insert into public.drive_files(id, company_id, name, content_type, size_bytes, path, visibility)
  values(result, p_company, trim(p_name), coalesce(nullif(trim(p_content_type), ''), 'application/octet-stream'), p_size,
   'drive/' || p_company || '/' || result, coalesce(p_visibility, 'private'));
  return result;
end $$;

create function public.confirm_drive_file(p_file uuid) returns void
language plpgsql security definer set search_path = '' as $$ begin
  update public.drive_files set status = 'ready'
  where id = p_file and uploaded_by = auth.uid() and status = 'pending';
  if not found then raise exception 'Arquivo não encontrado' using errcode = '42501'; end if;
end $$;

create function public.set_drive_file_visibility(p_file uuid, p_visibility text) returns void
language plpgsql security definer set search_path = '' as $$ declare f public.drive_files; begin
  select * into f from public.drive_files where id = p_file for update;
  if not found or not mavi_private.drive_manager(f) then raise exception 'Sem permissão' using errcode = '42501'; end if;
  update public.drive_files set visibility = p_visibility where id = p_file;
end $$;

-- Used by /api/drive only: each returns the object path when the caller may
-- perform that operation.
create function public.drive_upload_target(p_file uuid) returns table(path text, content_type text)
language sql stable security definer set search_path = '' as $$
 select f.path, f.content_type from public.drive_files f
 where f.id = p_file and f.uploaded_by = auth.uid() and f.status = 'pending' and mavi_private.member(f.company_id)
$$;
create function public.drive_download_target(p_file uuid) returns table(path text, name text, content_type text)
language sql stable security definer set search_path = '' as $$
 select f.path, f.name, f.content_type from public.drive_files f
 where f.id = p_file and f.status = 'ready' and mavi_private.member(f.company_id)
$$;
create function public.drive_public_target(p_token text) returns table(path text, name text, content_type text, size_bytes bigint)
language sql stable security definer set search_path = '' as $$
 select f.path, f.name, f.content_type, f.size_bytes from public.drive_files f
 where f.share_token = p_token and f.visibility = 'public' and f.status = 'ready'
$$;
-- Deletes the record and returns the path so the server can remove the object.
create function public.delete_drive_file(p_file uuid) returns text
language plpgsql security definer set search_path = '' as $$ declare f public.drive_files; begin
  select * into f from public.drive_files where id = p_file for update;
  if not found or not mavi_private.drive_manager(f) then raise exception 'Sem permissão' using errcode = '42501'; end if;
  delete from public.drive_files where id = p_file;
  return f.path;
end $$;

do $$ declare f record; begin
 for f in select p.oid::regprocedure as signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='public' and p.proname=any(array['prepare_drive_file','confirm_drive_file','set_drive_file_visibility',
   'drive_upload_target','drive_download_target','delete_drive_file']) loop
 execute format('revoke all on function %s from public,anon',f.signature);
 execute format('grant execute on function %s to authenticated',f.signature);
 end loop;
end $$;
revoke all on function public.drive_public_target(text) from public;
grant execute on function public.drive_public_target(text) to anon, authenticated;

-- New-task notifications rely on realtime inserts of tasks.
do $$ begin
 if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
  and not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'tasks') then
  alter publication supabase_realtime add table public.tasks;
 end if;
end $$;

commit;
