begin;

-- Armazenamento por cliente. The client of an upload is read from where the
-- file lives now, not stored with it: a Drive file carries its client; a
-- task attachment or an inline image belongs to its task's client (through
-- the contracted product). Files moved to another folder, or tasks moved to
-- another product, count for the new client right away. Uploads with no
-- client — Drive files outside client folders, images not yet in a task,
-- profile photos — come with client_id null.
create function mavi_private.storage_in_use(p_company uuid)
 returns table(id uuid, user_id uuid, kind text, name text, size_bytes bigint, created_at timestamptz,
  client_id uuid, contract_id uuid)
language sql stable security definer set search_path = '' as $$
 select u.id, u.user_id, u.kind, u.name, u.size_bytes, u.created_at,
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

-- Space in use per client and kind (leaders).
create function public.storage_usage_by_client(p_company uuid)
 returns table(client_id uuid, kind text, files bigint, bytes bigint, last_upload_at timestamptz)
language plpgsql stable security definer set search_path = '' as $$ begin
  if not mavi_private.leader(p_company) then raise exception 'Sem permissão' using errcode = '42501'; end if;
  return query
  select s.client_id, s.kind, count(*), sum(s.size_bytes)::bigint, max(s.created_at)
  from mavi_private.storage_in_use(p_company) s
  group by s.client_id, s.kind;
end $$;

-- A client's largest files in use (p_client null: the uploads with no client).
create function public.storage_client_files(p_company uuid, p_client uuid, p_limit integer default 50)
 returns table(id uuid, user_id uuid, kind text, name text, size_bytes bigint, created_at timestamptz, contract_id uuid)
language plpgsql stable security definer set search_path = '' as $$ begin
  if not mavi_private.leader(p_company) then raise exception 'Sem permissão' using errcode = '42501'; end if;
  return query
  select s.id, s.user_id, s.kind, s.name, s.size_bytes, s.created_at, s.contract_id
  from mavi_private.storage_in_use(p_company) s
  where s.client_id is not distinct from p_client
  order by s.size_bytes desc, s.created_at desc
  limit least(greatest(coalesce(p_limit, 50), 1), 200);
end $$;

revoke all on function public.storage_usage_by_client(uuid), public.storage_client_files(uuid, uuid, integer) from public, anon;
grant execute on function public.storage_usage_by_client(uuid), public.storage_client_files(uuid, uuid, integer) to authenticated;

commit;
