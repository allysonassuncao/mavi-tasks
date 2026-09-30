begin;

-- Sending files through a shared folder's public link, from the Drive's own
-- sharing dialog (until now only the Social Leads social proof folder turned
-- it on, 20261121090000). Whoever shares the folder chooses which kinds of
-- file the link accepts and the largest size, and three checks keep it safe:
--  - the kind comes from the file's extension, never from what the browser
--    says, and only formats that carry no code are on the list (no SVG, no
--    HTML, no macro-enabled Office files, no archives, no programs);
--  - the signed upload only takes exactly the declared size;
--  - the file only becomes visible after /api/drive reads its first bytes
--    and they match the format (a program renamed to .jpg is thrown away).
-- The last step needs the server's secret (the same one the MAVI workers
-- use, mavi_private.ai_config), so a browser cannot skip it.

alter table public.drive_folders
 add column if not exists public_upload_types text[] not null default '{image,video,audio,pdf}',
 add column if not exists public_upload_max_mb integer not null default 500;
alter table public.drive_folders
 add constraint drive_folders_public_upload_types check (
  cardinality(public_upload_types) between 1 and 5
  and public_upload_types <@ array['image', 'video', 'audio', 'pdf', 'document']),
 add constraint drive_folders_public_upload_max_mb check (public_upload_max_mb between 1 and 500);

-- The formats a link may accept, by extension (src/drive-upload-types.ts
-- has the same list, checked by api/_drive-upload-types.test.ts).
create function mavi_private.drive_upload_format(p_name text) returns table(kind text, content_type text)
language sql immutable set search_path = '' as $$
 select k.kind, k.content_type from (values
  ('jpg', 'image', 'image/jpeg'), ('jpeg', 'image', 'image/jpeg'), ('png', 'image', 'image/png'),
  ('gif', 'image', 'image/gif'), ('webp', 'image', 'image/webp'), ('heic', 'image', 'image/heic'),
  ('heif', 'image', 'image/heif'), ('avif', 'image', 'image/avif'),
  ('mp4', 'video', 'video/mp4'), ('mov', 'video', 'video/quicktime'), ('m4v', 'video', 'video/x-m4v'),
  ('webm', 'video', 'video/webm'), ('mkv', 'video', 'video/x-matroska'), ('avi', 'video', 'video/x-msvideo'),
  ('3gp', 'video', 'video/3gpp'),
  ('mp3', 'audio', 'audio/mpeg'), ('m4a', 'audio', 'audio/mp4'), ('wav', 'audio', 'audio/wav'),
  ('ogg', 'audio', 'audio/ogg'), ('opus', 'audio', 'audio/ogg'), ('aac', 'audio', 'audio/aac'),
  ('pdf', 'pdf', 'application/pdf'),
  ('docx', 'document', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'),
  ('xlsx', 'document', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'),
  ('pptx', 'document', 'application/vnd.openxmlformats-officedocument.presentationml.presentation'),
  ('odt', 'document', 'application/vnd.oasis.opendocument.text'),
  ('ods', 'document', 'application/vnd.oasis.opendocument.spreadsheet'),
  ('odp', 'document', 'application/vnd.oasis.opendocument.presentation'),
  ('txt', 'document', 'text/plain'), ('csv', 'document', 'text/csv')
 ) k(ext, kind, content_type)
 where k.ext = lower(substring(coalesce(p_name, '') from '\.([A-Za-z0-9]+)$'))
$$;
revoke all on function mavi_private.drive_upload_format(text) from public, anon, authenticated;

create function mavi_private.drive_upload_rules(f public.drive_folders) returns jsonb
language sql immutable set search_path = '' as $$
 select jsonb_build_object('enabled', f.public_upload, 'types', to_jsonb(f.public_upload_types),
  'max_mb', f.public_upload_max_mb)
$$;
revoke all on function mavi_private.drive_upload_rules(public.drive_folders) from public, anon, authenticated;

-- What the sharing dialog shows: also whether the link accepts files.
create or replace function public.drive_folder_sharing(p_folder uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$ declare f public.drive_folders; begin
  select * into f from public.drive_folders where id = p_folder;
  if not found or not mavi_private.drive_folder_manager(f) then
    raise exception 'Sem permissão para compartilhar esta pasta' using errcode = '42501';
  end if;
  return jsonb_build_object('visibility', f.visibility, 'share_token', f.share_token,
   'members', coalesce((select jsonb_agg(m.user_id order by m.added_at) from public.drive_folder_members m
    where m.folder_id = f.id), '[]'::jsonb),
   'upload', mavi_private.drive_upload_rules(f));
end $$;

-- Sets everything at once: public link, the people, and (p_upload, when
-- given) sending through the link: {enabled, types, max_mb}. Without the
-- link there is no sending; turning the link off keeps the chosen rules.
drop function public.set_drive_folder_sharing(uuid, boolean, uuid[]);
create function public.set_drive_folder_sharing(p_folder uuid, p_public boolean, p_members uuid[],
 p_upload jsonb default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare f public.drive_folders; wanted uuid[]; before uuid[]; next_visibility text;
 up_on boolean; up_types text[]; up_max integer; begin
  select * into f from public.drive_folders where id = p_folder for update;
  if not found or not mavi_private.drive_folder_manager(f) then
    raise exception 'Sem permissão para compartilhar esta pasta' using errcode = '42501';
  end if;
  if f.contract_id is null then
    raise exception 'Só pastas dentro de um produto podem ser compartilhadas.';
  end if;
  up_on := f.public_upload; up_types := f.public_upload_types; up_max := f.public_upload_max_mb;
  if p_upload is not null then
    up_on := coalesce((p_upload->>'enabled')::boolean, false);
    if jsonb_typeof(p_upload->'types') = 'array' then
      select coalesce(array_agg(distinct t order by t), '{}') into up_types
      from jsonb_array_elements_text(p_upload->'types') t;
    end if;
    if p_upload ? 'max_mb' then up_max := (p_upload->>'max_mb')::integer; end if;
    if up_on and (cardinality(up_types) = 0
     or not up_types <@ array['image', 'video', 'audio', 'pdf', 'document']) then
      raise exception 'Escolha que tipos de arquivo o link aceita.' using errcode = '22023';
    end if;
    if up_max is null or up_max not between 1 and 500 then
      raise exception 'O tamanho máximo vai de 1 MB a 500 MB.' using errcode = '22023';
    end if;
    if cardinality(up_types) = 0 then up_types := f.public_upload_types; end if;
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
   public_upload = p_public and up_on, public_upload_types = up_types, public_upload_max_mb = up_max,
   -- A link turned off is gone for good: a new one is issued next time.
   share_token = case when f.visibility = 'public' and next_visibility = 'private'
    then replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '')
    else share_token end
  where id = f.id returning * into f;
  perform mavi_private.drive_log(f.company_id, 'folder_shared', null, f.id, f.name, f.client_id, f.contract_id,
   jsonb_build_object('visibility', next_visibility,
    'added', (select coalesce(jsonb_agg(u), '[]') from unnest(wanted) u where not u = any(before)),
    'removed', (select coalesce(jsonb_agg(u), '[]') from unnest(before) u where not u = any(wanted)),
    'upload', mavi_private.drive_upload_rules(f)));
  return jsonb_build_object('visibility', f.visibility, 'share_token', f.share_token, 'members', to_jsonb(wanted),
   'upload', mavi_private.drive_upload_rules(f));
end $$;
revoke all on function public.set_drive_folder_sharing(uuid, boolean, uuid[], jsonb) from public, anon;
grant execute on function public.set_drive_folder_sharing(uuid, boolean, uuid[], jsonb) to authenticated;

-- The public folder also tells what the link accepts, and whether it is a
-- client's social proof folder (the page then asks for testimonials).
create or replace function public.drive_public_folder(p_token text, p_folder uuid default null) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare r public.drive_folders; target uuid; begin
  r := mavi_private.drive_public_root(p_token);
  if r.id is null then return null; end if;
  target := coalesce(p_folder, r.id);
  if not r.id in (select mavi_private.drive_folder_chain(r.company_id, target)) then return null; end if;
  return jsonb_build_object(
   'root', jsonb_build_object('id', r.id, 'name', r.name),
   'folder', target,
   'upload', r.public_upload,
   'upload_types', case when r.public_upload then to_jsonb(r.public_upload_types) end,
   'upload_max_mb', case when r.public_upload then r.public_upload_max_mb end,
   'social_proof', r.public_upload and exists (select 1 from public.social_leads_briefings b
    where b.company_id = r.company_id and b.proof_folder = r.id),
   'company', (select name from public.companies where id = r.company_id),
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

-- A send through the public link (only /api/drive calls it, without
-- sign-in): the extension says the format, which must be one the folder
-- accepts, within its size. The file waits (pending, invisible) until the
-- server has checked its content. Up to 60 sends an hour per folder.
create or replace function public.drive_public_upload(p_token text, p_name text, p_size bigint, p_content_type text,
 p_origin jsonb default '{}') returns table(id uuid, path text, content_type text)
language plpgsql security definer set search_path = '' as $$
declare r public.drive_folders; f uuid := gen_random_uuid(); fmt record; name text; begin
 r := mavi_private.drive_public_root(p_token);
 if r.id is null or not r.public_upload then
  raise exception 'Esta pasta não recebe arquivos.' using errcode = '42501';
 end if;
 name := left(trim(regexp_replace(coalesce(p_name, ''), '[\\/\x00-\x1f]', '_', 'g')), 255);
 select * into fmt from mavi_private.drive_upload_format(name);
 if fmt.kind is null or not fmt.kind = any(r.public_upload_types) then
  raise exception 'Este tipo de arquivo não é aceito nesta pasta.' using errcode = '22023';
 end if;
 if p_size is null or p_size < 1 or p_size > r.public_upload_max_mb::bigint * 1048576 then
  raise exception 'Envie arquivos de até % MB.', r.public_upload_max_mb using errcode = '22023';
 end if;
 if (select count(*) from public.drive_audit a where a.company_id = r.company_id and a.folder_id = r.id
  and a.action = 'public_upload_started' and a.created_at > now() - interval '1 hour') >= 60 then
  raise exception 'Muitos envios nesta pasta agora. Tente de novo em alguns minutos.' using errcode = '53400';
 end if;
 insert into public.drive_files(id, company_id, name, content_type, size_bytes, path, visibility, uploaded_by,
  client_id, contract_id, folder_id)
 values (f, r.company_id, name, fmt.content_type, p_size, 'drive/' || r.company_id || '/' || f, 'private',
  r.created_by, r.client_id, r.contract_id, r.id);
 perform mavi_private.drive_log(r.company_id, 'public_upload_started', f, r.id, name, r.client_id, r.contract_id,
  jsonb_build_object('size_bytes', p_size, 'content_type', fmt.content_type), mavi_private.clean_origin(p_origin));
 return query select f, 'drive/' || r.company_id || '/' || f, fmt.content_type;
end $$;

-- The send still waiting for the content check (for /api/drive).
create function public.drive_public_upload_pending(p_secret text, p_token text, p_file uuid)
 returns table(path text, name text, content_type text, size_bytes bigint)
language plpgsql stable security definer set search_path = '' as $$
declare r public.drive_folders; begin
 if not mavi_private.ai_secret_ok(p_secret) then raise exception 'Sem permissão' using errcode = '42501'; end if;
 r := mavi_private.drive_public_root(p_token);
 if r.id is null or not r.public_upload then
  raise exception 'Esta pasta não recebe arquivos.' using errcode = '42501';
 end if;
 return query select d.path, d.name, d.content_type, d.size_bytes from public.drive_files d
  where d.id = p_file and d.company_id = r.company_id and d.folder_id = r.id and d.status = 'pending'
   and d.created_at > now() - interval '6 hours';
end $$;

-- The end of the send, after the content check: accepted, it shows in the
-- folder (and the Social Leads page hears of it when it is a proof folder);
-- rejected, the record goes and the history keeps why.
drop function public.drive_public_upload_done(text, uuid);
create function public.drive_public_upload_done(p_secret text, p_token text, p_file uuid,
 p_rejected text default null) returns void
language plpgsql security definer set search_path = '' as $$
declare r public.drive_folders; f public.drive_files; b record; begin
 if not mavi_private.ai_secret_ok(p_secret) then raise exception 'Sem permissão' using errcode = '42501'; end if;
 r := mavi_private.drive_public_root(p_token);
 if r.id is null or not r.public_upload then
  raise exception 'Esta pasta não recebe arquivos.' using errcode = '42501';
 end if;
 select * into f from public.drive_files d
 where d.id = p_file and d.company_id = r.company_id and d.folder_id = r.id and d.status = 'pending'
  and d.created_at > now() - interval '6 hours'
 for update;
 if not found then raise exception 'Envio não encontrado.' using errcode = 'P0002'; end if;
 if p_rejected is not null then
  delete from public.drive_files where id = f.id;
  perform mavi_private.drive_log(f.company_id, 'public_upload_rejected', f.id, f.folder_id, f.name, f.client_id,
   f.contract_id, jsonb_build_object('size_bytes', f.size_bytes, 'content_type', f.content_type,
    'reason', left(p_rejected, 200)));
  return;
 end if;
 update public.drive_files set status = 'ready' where id = f.id returning * into f;
 perform mavi_private.drive_log(f.company_id, 'public_upload_completed', f.id, f.folder_id, f.name, f.client_id,
  f.contract_id, jsonb_build_object('size_bytes', f.size_bytes, 'content_type', f.content_type));
 for b in select company_id, contract_id from public.social_leads_briefings where proof_folder = r.id loop
  perform mavi_private.broadcast(b.company_id, jsonb_build_object(
   'kind', 'social_leads', 'contract', b.contract_id, 'table', 'drive_files'));
 end loop;
end $$;

do $$ declare f record; begin
 for f in select p.oid::regprocedure as signature from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
   and p.proname = any(array['drive_public_upload_pending', 'drive_public_upload_done']) loop
  execute format('revoke all on function %s from public', f.signature);
  execute format('grant execute on function %s to anon, authenticated', f.signature);
 end loop;
end $$;

commit;
