begin;

-- Armazenamento: leaders manage files from the storage page. Drive files use
-- the existing delete_drive_file and set_drive_file_visibility (uploader or
-- leader). Task attachments had no way to be removed: delete_attachment
-- removes one permanently — the record here, the object by the caller
-- (/api/gcs/sign-upload, with the returned path) — and leaves a line in the
-- task's history. Live sync (broadcast_attachment) takes it off open tasks.
create function public.delete_attachment(p_attachment uuid) returns text
language plpgsql security definer set search_path = '' as $$
declare a public.attachments; begin
  select * into a from public.attachments where id = p_attachment for update;
  if not found or not mavi_private.member(a.company_id) or not (
    mavi_private.leader(a.company_id)
    or (a.uploaded_by = auth.uid() and mavi_private.task_access(a.company_id, a.task_id))
  ) then
    raise exception 'Sem permissão' using errcode = '42501';
  end if;
  delete from public.attachments where id = a.id;
  insert into public.task_events(company_id, task_id, actor_id, action, detail)
  values (a.company_id, a.task_id, auth.uid(), 'attachment_deleted',
   jsonb_build_object('name', a.name, 'size_bytes', a.size_bytes));
  return a.path;
end $$;
revoke all on function public.delete_attachment(uuid) from public, anon;
grant execute on function public.delete_attachment(uuid) to authenticated;

-- A client's files now also carry the owning record (source_id), so the page
-- can act on them.
drop function public.storage_client_files(uuid, uuid, integer);
drop function mavi_private.storage_in_use(uuid);
create function mavi_private.storage_in_use(p_company uuid)
 returns table(id uuid, source_id uuid, user_id uuid, kind text, name text, size_bytes bigint,
  created_at timestamptz, client_id uuid, contract_id uuid)
language sql stable security definer set search_path = '' as $$
 select u.id, u.source_id, u.user_id, u.kind, u.name, u.size_bytes, u.created_at,
  coalesce(f.client_id, k.client_id), coalesce(f.contract_id, k.id)
 from public.storage_uploads u
 left join public.drive_files f on u.kind = 'drive' and f.id = u.source_id
 left join public.attachments a on u.kind = 'attachment' and a.id = u.source_id
 left join public.inline_images i on u.kind = 'inline_image' and i.id = u.source_id
 left join public.tasks t on t.id = coalesce(a.task_id, i.task_id)
 left join public.contracts k on k.id = t.contract_id
 where u.company_id = p_company and u.completed_at is not null and u.deleted_at is null
$$;
revoke all on function mavi_private.storage_in_use(uuid) from public, anon, authenticated;

create function public.storage_client_files(p_company uuid, p_client uuid, p_limit integer default 50)
 returns table(id uuid, source_id uuid, user_id uuid, kind text, name text, size_bytes bigint,
  created_at timestamptz, contract_id uuid)
language plpgsql stable security definer set search_path = '' as $$ begin
  if not mavi_private.leader(p_company) then raise exception 'Sem permissão' using errcode = '42501'; end if;
  return query
  select s.id, s.source_id, s.user_id, s.kind, s.name, s.size_bytes, s.created_at, s.contract_id
  from mavi_private.storage_in_use(p_company) s
  where s.client_id is not distinct from p_client
  order by s.size_bytes desc, s.created_at desc
  limit least(greatest(coalesce(p_limit, 50), 1), 200);
end $$;
revoke all on function public.storage_client_files(uuid, uuid, integer) from public, anon;
grant execute on function public.storage_client_files(uuid, uuid, integer) to authenticated;

commit;
