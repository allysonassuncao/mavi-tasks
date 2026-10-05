begin;

-- Anyone who works on a folder's client can share it, not only whoever
-- created it or a leader: the same rule as editing there (drive_can_write
-- — a leader, or someone on one of the client's teams, inside a product).
-- People the folder was shared with stay read-only and cannot share it.
-- Whoever created the folder keeps the right they had.
--
-- Every change was already in the Drive's history (drive_audit: who, when,
-- from where, link on/off, people added/removed, what the link accepts);
-- it now also says in what capacity the person shared it (creator, leader
-- or team) and who created the folder, so a share by someone else can be
-- told apart later.

create or replace function mavi_private.drive_folder_manager(f public.drive_folders) returns boolean
language sql stable security definer set search_path = '' as $$
 select mavi_private.member(f.company_id) and (f.created_by = auth.uid()
  or mavi_private.drive_can_write(f.company_id, f.client_id, f.contract_id))
$$;
revoke all on function mavi_private.drive_folder_manager(public.drive_folders) from public, anon, authenticated;

create function mavi_private.drive_folder_share_role(f public.drive_folders) returns text
language sql stable security definer set search_path = '' as $$
 select case when f.created_by = auth.uid() then 'creator'
  when mavi_private.leader(f.company_id) then 'leader' else 'team' end
$$;
revoke all on function mavi_private.drive_folder_share_role(public.drive_folders) from public, anon, authenticated;

-- Same as 20270118090000, with the capacity and the folder's creator in the log.
create or replace function public.set_drive_folder_sharing(p_folder uuid, p_public boolean, p_members uuid[],
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
    'upload', mavi_private.drive_upload_rules(f),
    'by', mavi_private.drive_folder_share_role(f), 'owner', f.created_by));
  return jsonb_build_object('visibility', f.visibility, 'share_token', f.share_token, 'members', to_jsonb(wanted),
   'upload', mavi_private.drive_upload_rules(f));
end $$;

-- Same as 20261121090000 (Social Leads), with the same two details in the log.
create or replace function public.set_drive_folder_upload(p_folder uuid, p_enabled boolean) returns void
language plpgsql security definer set search_path = '' as $$
declare f public.drive_folders; begin
 select * into f from public.drive_folders where id = p_folder for update;
 if not found or not mavi_private.drive_folder_manager(f) then
  raise exception 'Sem permissão para compartilhar esta pasta' using errcode = '42501';
 end if;
 if p_enabled and f.visibility <> 'public' then
  raise exception 'Ligue o link público da pasta antes.' using errcode = '22023';
 end if;
 update public.drive_folders set public_upload = coalesce(p_enabled, false) where id = f.id;
 perform mavi_private.drive_log(f.company_id, 'folder_shared', null, f.id, f.name, f.client_id, f.contract_id,
  jsonb_build_object('public_upload', coalesce(p_enabled, false),
   'by', mavi_private.drive_folder_share_role(f), 'owner', f.created_by));
end $$;

commit;
