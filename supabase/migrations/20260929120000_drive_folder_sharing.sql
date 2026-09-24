begin;

-- Sharing Drive folders that live inside a contracted product (client ›
-- product › folder, at any depth), in two independent ways:
--
-- * Public link (/pasta/<token>): anyone with it browses the folder and its
--   subfolders and views or downloads every ready file in them — including
--   files marked private. Read-only. Turning it off changes the token, so
--   an old link never comes back to life.
-- * People: chosen active members of the company see the folder, its
--   subfolders and their files (view and download), even without access to
--   the client through their teams. Read-only as well.
--
-- Who shares: whoever created the folder, or a leader (same rule as a
-- file's visibility). Every change and every public access is audited.

alter table public.drive_folders
 add column visibility text not null default 'private' check (visibility in ('private', 'public')),
 add column share_token text not null unique
  default (replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', ''));

create table public.drive_folder_members (
 company_id uuid not null,
 folder_id uuid not null,
 user_id uuid not null,
 added_by uuid not null default auth.uid(),
 added_at timestamptz not null default now(),
 primary key (folder_id, user_id),
 foreign key (company_id, folder_id) references public.drive_folders(company_id, id) on delete cascade,
 foreign key (company_id, user_id) references public.memberships(company_id, user_id)
);
create index drive_folder_members_user on public.drive_folder_members(company_id, user_id);
alter table public.drive_folder_members enable row level security;
revoke all on public.drive_folder_members from public, anon, authenticated;

-- The folder and its ancestors, nearest first (the tree is shallow; the
-- depth cap only guards against a cycle).
create function mavi_private.drive_folder_chain(c uuid, p_folder uuid) returns setof uuid
language sql stable security definer set search_path = '' as $$
 with recursive chain(id, parent_id, depth) as (
  select f.id, f.parent_id, 0 from public.drive_folders f where f.company_id = c and f.id = p_folder
  union all
  select f.id, f.parent_id, chain.depth + 1 from public.drive_folders f
   join chain on f.company_id = c and f.id = chain.parent_id
  where chain.depth < 50)
 select id from chain
$$;
revoke all on function mavi_private.drive_folder_chain(uuid, uuid) from public, anon, authenticated;

-- Whether the folder (or one it is inside) was shared with the person.
-- Most people have no shares at all: that check, on an index, comes first.
create function mavi_private.drive_folder_shared(c uuid, p_folder uuid) returns boolean
language sql stable security definer set search_path = '' as $$
 select p_folder is not null and mavi_private.member(c)
  and exists (select 1 from public.drive_folder_members m where m.company_id = c and m.user_id = auth.uid())
  and exists (select 1 from public.drive_folder_members m
   where m.company_id = c and m.user_id = auth.uid()
    and m.folder_id in (select mavi_private.drive_folder_chain(c, p_folder)))
$$;
revoke all on function mavi_private.drive_folder_shared(uuid, uuid) from public, anon;
grant execute on function mavi_private.drive_folder_shared(uuid, uuid) to authenticated;

alter policy drive_folders_read on public.drive_folders using (
 company_id in (select mavi_private.active_companies())
 and (mavi_private.drive_can_read(company_id, client_id) or mavi_private.drive_folder_shared(company_id, id))
);
alter policy drive_files_read on public.drive_files using (
 company_id in (select mavi_private.active_companies())
 and (status = 'ready' or uploaded_by = (select auth.uid()))
 and (mavi_private.drive_can_read(company_id, client_id) or mavi_private.drive_folder_shared(company_id, folder_id))
);

create or replace function public.drive_download_target(p_file uuid, p_inline boolean default false, p_origin jsonb default '{}')
 returns table(path text, name text, content_type text)
language plpgsql security definer set search_path = '' as $$ declare f public.drive_files; begin
  select * into f from public.drive_files d where d.id = p_file and d.status = 'ready';
  if not found or not (mavi_private.drive_can_read(f.company_id, f.client_id)
   or mavi_private.drive_folder_shared(f.company_id, f.folder_id)) then return; end if;
  perform mavi_private.drive_log(f.company_id, case when p_inline then 'file_viewed' else 'file_downloaded' end,
   f.id, f.folder_id, f.name, f.client_id, f.contract_id, jsonb_build_object('visibility', f.visibility),
   mavi_private.clean_origin(p_origin));
  return query select f.path, f.name, f.content_type;
end $$;

-- ------------------------------------------------------------ managing
create function mavi_private.drive_folder_manager(f public.drive_folders) returns boolean
language sql stable security definer set search_path = '' as $$
 select mavi_private.member(f.company_id) and (f.created_by = auth.uid() or mavi_private.leader(f.company_id))
$$;
revoke all on function mavi_private.drive_folder_manager(public.drive_folders) from public, anon, authenticated;

-- What the sharing dialog shows.
create function public.drive_folder_sharing(p_folder uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$ declare f public.drive_folders; begin
  select * into f from public.drive_folders where id = p_folder;
  if not found or not mavi_private.drive_folder_manager(f) then
    raise exception 'Sem permissão para compartilhar esta pasta' using errcode = '42501';
  end if;
  return jsonb_build_object('visibility', f.visibility, 'share_token', f.share_token,
   'members', coalesce((select jsonb_agg(m.user_id order by m.added_at) from public.drive_folder_members m
    where m.folder_id = f.id), '[]'::jsonb));
end $$;

-- Sets both at once: public link on/off and the people it is shared with.
create function public.set_drive_folder_sharing(p_folder uuid, p_public boolean, p_members uuid[])
 returns jsonb
language plpgsql security definer set search_path = '' as $$
declare f public.drive_folders; wanted uuid[]; before uuid[]; next_visibility text; begin
  select * into f from public.drive_folders where id = p_folder for update;
  if not found or not mavi_private.drive_folder_manager(f) then
    raise exception 'Sem permissão para compartilhar esta pasta' using errcode = '42501';
  end if;
  if f.contract_id is null then
    raise exception 'Só pastas dentro de um produto podem ser compartilhadas.';
  end if;
  select coalesce(array_agg(distinct u), '{}') into wanted from unnest(coalesce(p_members, '{}')) u;
  if exists (select 1 from unnest(wanted) u where not exists (select 1 from public.memberships m
   where m.company_id = f.company_id and m.user_id = u and m.active)) then
    raise exception 'Escolha pessoas ativas do espaço.';
  end if;
  select coalesce(array_agg(user_id), '{}') into before from public.drive_folder_members where folder_id = f.id;
  delete from public.drive_folder_members where folder_id = f.id and not user_id = any(wanted);
  insert into public.drive_folder_members(company_id, folder_id, user_id)
   select f.company_id, f.id, u from unnest(wanted) u on conflict do nothing;
  next_visibility := case when p_public then 'public' else 'private' end;
  update public.drive_folders set visibility = next_visibility,
   -- A link turned off is gone for good: a new one is issued next time.
   share_token = case when f.visibility = 'public' and next_visibility = 'private'
    then replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '')
    else share_token end
  where id = f.id returning * into f;
  perform mavi_private.drive_log(f.company_id, 'folder_shared', null, f.id, f.name, f.client_id, f.contract_id,
   jsonb_build_object('visibility', next_visibility,
    'added', (select coalesce(jsonb_agg(u), '[]') from unnest(wanted) u where not u = any(before)),
    'removed', (select coalesce(jsonb_agg(u), '[]') from unnest(before) u where not u = any(wanted))));
  return jsonb_build_object('visibility', f.visibility, 'share_token', f.share_token, 'members', to_jsonb(wanted));
end $$;

-- Folders shared directly with the person ("Compartilhadas comigo").
create function public.my_shared_drive_folders(p_company uuid) returns setof public.drive_folders
language sql stable security definer set search_path = '' as $$
 select f.* from public.drive_folders f
 join public.drive_folder_members m on m.folder_id = f.id and m.company_id = f.company_id
 where f.company_id = p_company and m.user_id = auth.uid() and mavi_private.member(p_company)
 order by f.name
$$;

-- ------------------------------------------------------------ public link
-- The shared folder behind a token, and whether `p_folder` is it or inside it.
create function mavi_private.drive_public_root(p_token text) returns public.drive_folders
language sql stable security definer set search_path = '' as $$
 select * from public.drive_folders where share_token = p_token and visibility = 'public'
$$;
revoke all on function mavi_private.drive_public_root(text) from public, anon, authenticated;

-- One level of a public folder: breadcrumb from the shared folder, its
-- subfolders and ready files. No paths or ids of anything outside it.
create function public.drive_public_folder(p_token text, p_folder uuid default null) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare r public.drive_folders; target uuid; begin
  r := mavi_private.drive_public_root(p_token);
  if r.id is null then return null; end if;
  target := coalesce(p_folder, r.id);
  if not r.id in (select mavi_private.drive_folder_chain(r.company_id, target)) then return null; end if;
  return jsonb_build_object(
   'root', jsonb_build_object('id', r.id, 'name', r.name),
   'folder', target,
   -- From the shared folder down to the one being shown.
   'path', (with recursive up(id, name, parent_id, depth) as (
     select f.id, f.name, f.parent_id, 0 from public.drive_folders f
      where f.company_id = r.company_id and f.id = target
     union all
     select f.id, f.name, f.parent_id, up.depth + 1 from public.drive_folders f
      join up on f.company_id = r.company_id and f.id = up.parent_id
     where up.id <> r.id and up.depth < 50)
    select jsonb_agg(jsonb_build_object('id', id, 'name', name) order by depth desc) from up),
   'folders', (select coalesce(jsonb_agg(jsonb_build_object('id', f.id, 'name', f.name) order by f.name), '[]')
    from public.drive_folders f where f.company_id = r.company_id and f.parent_id = target),
   'files', (select coalesce(jsonb_agg(jsonb_build_object('id', d.id, 'name', d.name,
     'content_type', d.content_type, 'size_bytes', d.size_bytes, 'created_at', d.created_at) order by d.name), '[]')
    from public.drive_files d where d.company_id = r.company_id and d.folder_id = target and d.status = 'ready'));
end $$;
revoke all on function public.drive_public_folder(text, uuid) from public;
grant execute on function public.drive_public_folder(text, uuid) to anon, authenticated;

-- Opening the link counts once per visit (the first level); the files
-- viewed or downloaded are logged one by one.
create function public.log_drive_public_folder(p_token text) returns void
language plpgsql security definer set search_path = '' as $$ declare r public.drive_folders; begin
  r := mavi_private.drive_public_root(p_token);
  if r.id is null then return; end if;
  perform mavi_private.drive_log(r.company_id, 'public_folder_opened', null, r.id, r.name, r.client_id, r.contract_id);
end $$;
revoke all on function public.log_drive_public_folder(text) from public;
grant execute on function public.log_drive_public_folder(text) to anon, authenticated;

-- A file of a public folder (or of a folder inside it), for /api/drive.
create function public.drive_public_folder_file(p_token text, p_file uuid, p_inline boolean default false,
 p_origin jsonb default '{}') returns table(path text, name text, content_type text, size_bytes bigint)
language plpgsql security definer set search_path = '' as $$
declare r public.drive_folders; f public.drive_files; begin
  r := mavi_private.drive_public_root(p_token);
  if r.id is null then return; end if;
  select * into f from public.drive_files d where d.id = p_file and d.company_id = r.company_id and d.status = 'ready';
  if not found or f.folder_id is null
   or not r.id in (select mavi_private.drive_folder_chain(r.company_id, f.folder_id)) then return; end if;
  perform mavi_private.drive_log(f.company_id, case when p_inline then 'public_viewed' else 'public_downloaded' end,
   f.id, f.folder_id, f.name, f.client_id, f.contract_id, jsonb_build_object('via_folder', r.id),
   mavi_private.clean_origin(p_origin));
  return query select f.path, f.name, f.content_type, f.size_bytes;
end $$;
revoke all on function public.drive_public_folder_file(text, uuid, boolean, jsonb) from public;
grant execute on function public.drive_public_folder_file(text, uuid, boolean, jsonb) to anon, authenticated;

do $$ declare f record; begin
 for f in select p.oid::regprocedure as signature from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = any(array['drive_folder_sharing', 'set_drive_folder_sharing',
   'my_shared_drive_folders']) loop
  execute format('revoke all on function %s from public, anon', f.signature);
  execute format('grant execute on function %s to authenticated', f.signature);
 end loop;
end $$;

commit;
