begin;

-- Every upload leaves a row here, whatever it was for: Drive files, task
-- attachments, images pasted into descriptions and comments, and profile
-- photos. Rows are written only by the triggers below (on the tables that own
-- each file) and by set_my_avatar, never by clients. A deleted file keeps its
-- row with deleted_at, so the table is also the upload history.
--
-- Space in use = rows that finished uploading (completed_at) and still exist
-- (deleted_at is null). Sizes are the ones declared when preparing the upload;
-- the signed URL (api/_uploads.ts, api/drive.ts, api/_profile.ts) never
-- accepts a larger object than that.
create table public.storage_uploads (
 id uuid primary key default gen_random_uuid(),
 company_id uuid not null references public.companies(id),
 -- Who uploaded it. No foreign key: history outlives removed people.
 user_id uuid not null,
 kind text not null check (kind in ('drive','attachment','inline_image','avatar')),
 -- The owning record (drive_files, attachments, inline_images) or, for a
 -- profile photo, the id in its object name.
 source_id uuid not null,
 name text not null default '',
 size_bytes bigint not null check (size_bytes >= 0),
 created_at timestamptz not null default now(),
 completed_at timestamptz,
 deleted_at timestamptz,
 unique (company_id, kind, source_id)
);
create index storage_uploads_in_use on public.storage_uploads(company_id, user_id, kind)
 include (size_bytes, completed_at) where completed_at is not null and deleted_at is null;
create index storage_uploads_user_recent on public.storage_uploads(company_id, user_id, created_at desc);
alter table public.storage_uploads enable row level security;
revoke all on public.storage_uploads from anon, authenticated;
grant select on public.storage_uploads to authenticated;
-- Leaders (admins and managers) see the whole company; everyone sees their own.
create policy storage_uploads_read on public.storage_uploads for select to authenticated using (
 company_id in (select mavi_private.active_companies())
 and (user_id = (select auth.uid()) or company_id in (select mavi_private.leader_companies()))
);

-- One function for the three file tables (TG_ARGV[0] is the kind). Drive
-- files count once confirmed (status 'ready'); attachments and inline images
-- have no confirmation step and count from the start (a failed upload is
-- discarded, which deletes the record and so marks the row deleted).
create function mavi_private.log_upload() returns trigger
language plpgsql security definer set search_path = '' as $$
declare k text := tg_argv[0]; r jsonb; begin
  if tg_op = 'DELETE' then
    update public.storage_uploads set deleted_at = now()
    where company_id = old.company_id and kind = k and source_id = old.id and deleted_at is null;
    return old;
  end if;
  r := to_jsonb(new);
  if tg_op = 'INSERT' then
    insert into public.storage_uploads(company_id, user_id, kind, source_id, name, size_bytes, created_at, completed_at)
    values (new.company_id, (r->>'uploaded_by')::uuid, k, new.id, r->>'name', (r->>'size_bytes')::bigint,
     (r->>'created_at')::timestamptz,
     case when coalesce(r->>'status', 'ready') = 'ready' then (r->>'created_at')::timestamptz end)
    on conflict (company_id, kind, source_id) do nothing;
  else
    update public.storage_uploads set name = r->>'name',
     completed_at = case when coalesce(r->>'status', 'ready') = 'ready' then coalesce(completed_at, now()) end
    where company_id = new.company_id and kind = k and source_id = new.id;
  end if;
  return new;
end $$;
revoke all on function mavi_private.log_upload() from public, anon, authenticated;

create trigger log_drive_upload after insert or update of name, status or delete on public.drive_files
 for each row execute function mavi_private.log_upload('drive');
create trigger log_attachment_upload after insert or update of name or delete on public.attachments
 for each row execute function mavi_private.log_upload('attachment');
create trigger log_inline_image_upload after insert or delete on public.inline_images
 for each row execute function mavi_private.log_upload('inline_image');

-- Profile photos: the browser now also reports the optimized image's size
-- (capped at the 512 KB the signed URL accepts). The photo lives on every
-- membership of the person, so it is recorded in each of their companies;
-- the previous photo stops counting.
drop function public.set_my_avatar(text);
create function public.set_my_avatar(p_url text, p_size bigint default null) returns void
language plpgsql security definer set search_path = '' as $$ begin
  if p_url is not null and p_url !~ ('/avatars/' || auth.uid() || '/[0-9a-f-]{36}\.(webp|jpg)$') then
    raise exception 'Foto inválida.';
  end if;
  update public.memberships set avatar_url = p_url where user_id = auth.uid();
  if not found then raise exception 'Perfil não encontrado' using errcode = '42501'; end if;
  update public.storage_uploads set deleted_at = now()
  where user_id = auth.uid() and kind = 'avatar' and deleted_at is null;
  if p_url is not null then
    insert into public.storage_uploads(company_id, user_id, kind, source_id, name, size_bytes, completed_at)
    select m.company_id, auth.uid(), 'avatar', substring(p_url from '/([0-9a-f-]{36})\.(?:webp|jpg)$')::uuid,
     'Foto de perfil', least(greatest(coalesce(p_size, 0), 0), 524288), now()
    from public.memberships m where m.user_id = auth.uid()
    on conflict (company_id, kind, source_id) do update set deleted_at = null, size_bytes = excluded.size_bytes;
  end if;
end $$;
revoke all on function public.set_my_avatar(text, bigint) from public, anon;
grant execute on function public.set_my_avatar(text, bigint) to authenticated;

-- Space in use per person and kind, for the Armazenamento page (leaders).
create function public.storage_usage(p_company uuid)
 returns table(user_id uuid, kind text, files bigint, bytes bigint, last_upload_at timestamptz)
language plpgsql stable security definer set search_path = '' as $$ begin
  if not mavi_private.leader(p_company) then raise exception 'Sem permissão' using errcode = '42501'; end if;
  return query
  select u.user_id, u.kind, count(*), sum(u.size_bytes)::bigint, max(u.completed_at)
  from public.storage_uploads u
  where u.company_id = p_company and u.completed_at is not null and u.deleted_at is null
  group by u.user_id, u.kind;
end $$;
revoke all on function public.storage_usage(uuid) from public, anon;
grant execute on function public.storage_usage(uuid) to authenticated;

-- Files uploaded before this migration. Profile photos had no recorded size.
insert into public.storage_uploads(company_id, user_id, kind, source_id, name, size_bytes, created_at, completed_at)
select company_id, uploaded_by, 'attachment', id, name, size_bytes, created_at, created_at from public.attachments
union all
select company_id, uploaded_by, 'inline_image', id, name, size_bytes, created_at, created_at from public.inline_images
union all
select company_id, uploaded_by, 'drive', id, name, size_bytes, created_at,
 case when status = 'ready' then created_at end from public.drive_files
union all
select company_id, user_id, 'avatar', substring(avatar_url from '/([0-9a-f-]{36})\.(?:webp|jpg)$')::uuid,
 'Foto de perfil', 0, now(), now() from public.memberships where avatar_url is not null
on conflict do nothing;

commit;
