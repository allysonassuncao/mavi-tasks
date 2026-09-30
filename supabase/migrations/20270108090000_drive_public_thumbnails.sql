begin;

-- Drive thumbnails on public links (/pasta/<token> and /arquivo/<token>),
-- as in the Drive itself (20261209090000_drive_thumbnails): whoever holds
-- the link sees the thumbnails and, like anyone who sees a file inside the
-- Drive, may make the one still missing (a file sent through a public
-- folder gets its thumbnail from the browser that sent it). An existing
-- thumbnail is never replaced from a link. Nothing is logged: a thumbnail is
-- not a view.

-- Whether the link shows the file: its own public link, or a public folder
-- it is inside (at any depth).
create function mavi_private.drive_public_sees(p_token text, f public.drive_files) returns boolean
language sql stable security definer set search_path = '' as $$
 select f.status = 'ready' and p_token ~ '^[0-9a-f]{64}$' and (
  (f.share_token = p_token and f.visibility = 'public')
  or (f.folder_id is not null and exists (select 1 from public.drive_folders r
   where r.share_token = p_token and r.visibility = 'public' and r.company_id = f.company_id
    and r.id in (select mavi_private.drive_folder_chain(f.company_id, f.folder_id)))))
$$;
revoke all on function mavi_private.drive_public_sees(text, public.drive_files) from public, anon, authenticated;

-- For /api/drive: what each file of the link shows (up to 200, same rule as
-- drive_thumb_sources). The file's own link needs no ids: it is the file.
create function public.drive_public_thumb_sources(p_token text, p_files uuid[] default '{}')
 returns table(id uuid, path text, ready boolean)
language sql stable security definer set search_path = '' as $$
 select f.id, case when f.thumb = 'ready' then f.path || '.thumb.webp' else f.path end, coalesce(f.thumb = 'ready', false)
 from public.drive_files f
 where (f.id = any((coalesce(p_files, '{}'::uuid[]))[1:200]) or f.share_token = p_token)
  and mavi_private.drive_public_sees(p_token, f)
  and (f.thumb = 'ready' or (f.thumb is null and (
   f.content_type like 'video/%'
   or ((f.content_type like 'image/%' or f.content_type = 'application/pdf') and f.size_bytes <= 26214400))))
$$;

-- Where the browser stores the thumbnail it made: only while there is none.
create function public.drive_public_thumb_target(p_token text, p_file uuid) returns table(path text)
language sql stable security definer set search_path = '' as $$
 select f.path || '.thumb.webp' from public.drive_files f
 where f.id = p_file and f.thumb is null and mavi_private.drive_public_sees(p_token, f)
$$;

create function public.set_drive_public_thumb(p_token text, p_file uuid, p_ready boolean) returns void
language plpgsql security definer set search_path = '' as $$ begin
  update public.drive_files f set thumb = case when p_ready then 'ready' else 'failed' end
  where f.id = p_file and f.thumb is null and mavi_private.drive_public_sees(p_token, f);
  if not found then raise exception 'Arquivo não encontrado' using errcode = '42501'; end if;
end $$;

do $$ declare f record; begin
 for f in select p.oid::regprocedure as signature from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
   and p.proname = any(array['drive_public_thumb_sources', 'drive_public_thumb_target', 'set_drive_public_thumb']) loop
  execute format('revoke all on function %s from public', f.signature);
  execute format('grant execute on function %s to anon, authenticated', f.signature);
 end loop;
end $$;

commit;
