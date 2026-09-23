begin;

-- /api/gcs/sign-upload used to sign a PUT for any object path, without
-- authentication. It now asks these functions, as the requesting user, which
-- object may be uploaded: only a record the caller prepared in the last 15
-- minutes (and, for inline images, not yet bound to a task). Paths are
-- derived here, never taken from the client, so existing objects of other
-- records cannot be overwritten.
create function public.attachment_upload_target(p_attachment uuid) returns table(path text, name text, size_bytes bigint)
language sql stable security definer set search_path = '' as $$
 select a.path, a.name, a.size_bytes from public.attachments a
 where a.id = p_attachment and a.uploaded_by = auth.uid()
  and a.created_at > now() - interval '15 minutes'
  and mavi_private.task_access(a.company_id, a.task_id)
$$;

create function public.inline_image_upload_target(p_image uuid) returns table(path text, name text, size_bytes bigint)
language sql stable security definer set search_path = '' as $$
 select i.path, i.name, i.size_bytes from public.inline_images i
 where i.id = p_image and i.uploaded_by = auth.uid() and i.task_id is null
  and i.created_at > now() - interval '15 minutes'
  and mavi_private.member(i.company_id)
$$;

revoke all on function public.attachment_upload_target(uuid), public.inline_image_upload_target(uuid) from public, anon;
grant execute on function public.attachment_upload_target(uuid), public.inline_image_upload_target(uuid) to authenticated;

commit;
