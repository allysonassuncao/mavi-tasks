begin;

-- Drive thumbnails, as in Google Drive: the lists show a small picture of
-- each file instead of a fixed icon. The browser makes it (images, videos
-- and PDFs) right after an upload and stores it next to the object
-- (<path>.thumb.webp); files sent before that get theirs the first time
-- someone who sees them opens the folder. /api/drive signs the URLs, so the
-- paths stay hidden. Showing a thumbnail is not a view: nothing is logged.
--
-- thumb: null = not made yet; ready = stored; failed = the browser could
-- not read the file (no more attempts, the icon stays).
alter table public.drive_files add column thumb text check (thumb in ('ready', 'failed'));

-- Whether the person sees the file (the rule of drive_download_target).
create function mavi_private.drive_file_readable(f public.drive_files) returns boolean
language sql stable security definer set search_path = '' as $$
 select f.status = 'ready' and (mavi_private.drive_can_read(f.company_id, f.client_id)
  or mavi_private.drive_folder_shared(f.company_id, f.folder_id))
$$;
revoke all on function mavi_private.drive_file_readable(public.drive_files) from public, anon, authenticated;

-- For /api/drive: what to show for each file of a list (up to 200). The
-- thumbnail when there is one (ready); otherwise, for a file a thumbnail can
-- be made from, the file itself, so the browser makes it once.
create function public.drive_thumb_sources(p_files uuid[])
 returns table(id uuid, path text, ready boolean)
language sql stable security definer set search_path = '' as $$
 select f.id, case when f.thumb = 'ready' then f.path || '.thumb.webp' else f.path end, coalesce(f.thumb = 'ready', false)
 from public.drive_files f
 where f.id = any(p_files[1:200]) and mavi_private.drive_file_readable(f)
  and (f.thumb = 'ready' or (f.thumb is null and (
   f.content_type like 'video/%'
   or ((f.content_type like 'image/%' or f.content_type = 'application/pdf') and f.size_bytes <= 26214400))))
$$;

-- Where the browser stores a thumbnail it made: whoever may change the file
-- (after an upload), or anyone who sees it while it has none.
create function public.drive_thumb_target(p_file uuid) returns table(path text)
language sql stable security definer set search_path = '' as $$
 select f.path || '.thumb.webp' from public.drive_files f
 where f.id = p_file and mavi_private.drive_file_readable(f)
  and (f.thumb is null or mavi_private.drive_can_write(f.company_id, f.client_id, f.contract_id))
$$;

-- After the upload (ready) or when the file could not be read (failed).
create function public.set_drive_thumb(p_file uuid, p_ready boolean) returns void
language plpgsql security definer set search_path = '' as $$ begin
  update public.drive_files f set thumb = case when p_ready then 'ready' else 'failed' end
  where f.id = p_file and mavi_private.drive_file_readable(f)
   and (f.thumb is null or mavi_private.drive_can_write(f.company_id, f.client_id, f.contract_id));
  if not found then raise exception 'Arquivo não encontrado' using errcode = '42501'; end if;
end $$;

do $$ declare f record; begin
 for f in select p.oid::regprocedure as signature from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = any(array['drive_thumb_sources', 'drive_thumb_target', 'set_drive_thumb']) loop
  execute format('revoke all on function %s from public, anon', f.signature);
  execute format('grant execute on function %s to authenticated', f.signature);
 end loop;
end $$;

commit;
