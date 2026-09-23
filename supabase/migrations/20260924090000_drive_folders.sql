begin;

-- Drive tree: root → one virtual folder per client → one per contracted
-- product → folders people create. Every folder and file stores where it
-- lives (client, product, parent folder). Leaders (admins and managers) may
-- add and change things anywhere; everyone else only inside products of
-- clients their teams serve. Collaborators see only those clients' items;
-- items at the root are visible to the whole company.
create table public.drive_folders (
 id uuid primary key default gen_random_uuid(),
 company_id uuid not null references public.companies(id),
 client_id uuid,
 contract_id uuid,
 parent_id uuid,
 name text not null check (length(trim(name)) between 1 and 120),
 created_by uuid not null default auth.uid(),
 created_at timestamptz not null default now(),
 unique(company_id,id),
 foreign key(company_id,client_id) references public.clients(company_id,id),
 foreign key(company_id,contract_id) references public.contracts(company_id,id),
 foreign key(company_id,parent_id) references public.drive_folders(company_id,id),
 foreign key(company_id,created_by) references public.memberships(company_id,user_id),
 check (contract_id is null or client_id is not null)
);
create index drive_folders_location on public.drive_folders(company_id, client_id, contract_id, parent_id);
alter table public.drive_folders enable row level security;
revoke all on public.drive_folders from anon, authenticated;
grant select on public.drive_folders to authenticated;

alter table public.drive_files
 add column client_id uuid,
 add column contract_id uuid,
 add column folder_id uuid,
 add foreign key(company_id,client_id) references public.clients(company_id,id),
 add foreign key(company_id,contract_id) references public.contracts(company_id,id),
 add foreign key(company_id,folder_id) references public.drive_folders(company_id,id),
 add check (contract_id is null or client_id is not null);
create index drive_files_location on public.drive_files(company_id, client_id, contract_id, folder_id);
grant select (client_id, contract_id, folder_id) on public.drive_files to authenticated;

create function mavi_private.drive_can_read(c uuid, p_client uuid) returns boolean
language sql stable security definer set search_path = '' as $$
 select mavi_private.member(c) and (p_client is null or mavi_private.leader(c) or exists(
  select 1 from public.client_teams ct
  join public.team_members tm on tm.company_id=ct.company_id and tm.team_id=ct.team_id
  where ct.company_id=c and ct.client_id=p_client and tm.user_id=auth.uid()))
$$;
create function mavi_private.drive_can_write(c uuid, p_client uuid, p_contract uuid) returns boolean
language sql stable security definer set search_path = '' as $$
 select mavi_private.member(c) and (mavi_private.leader(c)
  or (p_contract is not null and mavi_private.drive_can_read(c, p_client)))
$$;
revoke all on function mavi_private.drive_can_read(uuid,uuid), mavi_private.drive_can_write(uuid,uuid,uuid) from public, anon;
grant execute on function mavi_private.drive_can_read(uuid,uuid), mavi_private.drive_can_write(uuid,uuid,uuid) to authenticated;

-- Normalizes a target location: a folder carries its own client/product; a
-- product implies its client.
create function mavi_private.drive_location(c uuid, p_client uuid, p_contract uuid, p_folder uuid,
 out client_id uuid, out contract_id uuid)
language plpgsql stable security definer set search_path = '' as $$ begin
  if p_folder is not null then
    select f.client_id, f.contract_id into client_id, contract_id from public.drive_folders f where f.company_id = c and f.id = p_folder;
    if not found then raise exception 'Pasta não encontrada'; end if;
  elsif p_contract is not null then
    select k.client_id, k.id into client_id, contract_id from public.contracts k where k.company_id = c and k.id = p_contract;
    if not found then raise exception 'Produto não encontrado'; end if;
  elsif p_client is not null then
    if not exists(select 1 from public.clients k where k.company_id = c and k.id = p_client) then
      raise exception 'Cliente não encontrado';
    end if;
    client_id := p_client;
  end if;
end $$;
revoke all on function mavi_private.drive_location(uuid,uuid,uuid,uuid) from public, anon, authenticated;

create policy drive_folders_read on public.drive_folders for select to authenticated using (
 company_id in (select mavi_private.active_companies()) and mavi_private.drive_can_read(company_id, client_id)
);
alter policy drive_files_read on public.drive_files using (
 company_id in (select mavi_private.active_companies())
 and (status = 'ready' or uploaded_by = (select auth.uid()))
 and mavi_private.drive_can_read(company_id, client_id)
);

drop function public.prepare_drive_file(uuid,text,bigint,text,text);
create function public.prepare_drive_file(p_company uuid, p_name text, p_size bigint, p_content_type text,
 p_visibility text default 'private', p_client uuid default null, p_contract uuid default null, p_folder uuid default null) returns uuid
language plpgsql security definer set search_path = '' as $$
declare result uuid := gen_random_uuid(); loc record; begin
  if not mavi_private.member(p_company) then raise exception 'Sem acesso ao espaço' using errcode = '42501'; end if;
  select * into loc from mavi_private.drive_location(p_company, p_client, p_contract, p_folder);
  if not mavi_private.drive_can_write(p_company, loc.client_id, loc.contract_id) then
    raise exception 'Somente administradores e gestores enviam arquivos fora das pastas de produto.' using errcode = '42501';
  end if;
  if p_size is null or p_size < 1 or p_size > 524288000 then raise exception 'Envie arquivos de até 500 MB.'; end if;
  insert into public.drive_files(id, company_id, name, content_type, size_bytes, path, visibility, client_id, contract_id, folder_id)
  values(result, p_company, trim(p_name), coalesce(nullif(trim(p_content_type), ''), 'application/octet-stream'), p_size,
   'drive/' || p_company || '/' || result, coalesce(p_visibility, 'private'), loc.client_id, loc.contract_id, p_folder);
  return result;
end $$;

create or replace function public.drive_download_target(p_file uuid) returns table(path text, name text, content_type text)
language sql stable security definer set search_path = '' as $$
 select f.path, f.name, f.content_type from public.drive_files f
 where f.id = p_file and f.status = 'ready' and mavi_private.drive_can_read(f.company_id, f.client_id)
$$;

create function public.create_drive_folder(p_company uuid, p_name text, p_client uuid default null,
 p_contract uuid default null, p_parent uuid default null) returns uuid
language plpgsql security definer set search_path = '' as $$
declare result uuid; loc record; begin
  if not mavi_private.member(p_company) then raise exception 'Sem acesso ao espaço' using errcode = '42501'; end if;
  select * into loc from mavi_private.drive_location(p_company, p_client, p_contract, p_parent);
  if not mavi_private.drive_can_write(p_company, loc.client_id, loc.contract_id) then
    raise exception 'Somente administradores e gestores criam pastas fora das pastas de produto.' using errcode = '42501';
  end if;
  insert into public.drive_folders(company_id, client_id, contract_id, parent_id, name)
  values(p_company, loc.client_id, loc.contract_id, p_parent, trim(p_name)) returning id into result;
  return result;
end $$;

create function public.rename_drive_folder(p_folder uuid, p_name text) returns void
language plpgsql security definer set search_path = '' as $$ declare f public.drive_folders; begin
  select * into f from public.drive_folders where id = p_folder for update;
  if not found or not mavi_private.drive_can_write(f.company_id, f.client_id, f.contract_id) then
    raise exception 'Sem permissão para alterar esta pasta' using errcode = '42501';
  end if;
  update public.drive_folders set name = trim(p_name) where id = p_folder;
end $$;

-- Only empty folders, by whoever created them or a leader.
create function public.delete_drive_folder(p_folder uuid) returns void
language plpgsql security definer set search_path = '' as $$ declare f public.drive_folders; begin
  select * into f from public.drive_folders where id = p_folder for update;
  if not found or not mavi_private.drive_can_write(f.company_id, f.client_id, f.contract_id)
   or not (f.created_by = auth.uid() or mavi_private.leader(f.company_id)) then
    raise exception 'Sem permissão para excluir esta pasta' using errcode = '42501';
  end if;
  if exists(select 1 from public.drive_folders where parent_id = p_folder)
   or exists(select 1 from public.drive_files where folder_id = p_folder) then
    raise exception 'Esvazie a pasta antes de excluí-la.';
  end if;
  delete from public.drive_folders where id = p_folder;
end $$;

create function public.rename_drive_file(p_file uuid, p_name text) returns void
language plpgsql security definer set search_path = '' as $$ declare f public.drive_files; begin
  select * into f from public.drive_files where id = p_file for update;
  if not found or not mavi_private.drive_can_write(f.company_id, f.client_id, f.contract_id) then
    raise exception 'Sem permissão para alterar este arquivo' using errcode = '42501';
  end if;
  update public.drive_files set name = trim(p_name) where id = p_file;
end $$;

do $$ declare f record; begin
 for f in select p.oid::regprocedure as signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='public' and p.proname=any(array['prepare_drive_file','create_drive_folder','rename_drive_folder',
   'delete_drive_folder','rename_drive_file']) loop
 execute format('revoke all on function %s from public,anon',f.signature);
 execute format('grant execute on function %s to authenticated',f.signature);
 end loop;
end $$;

commit;
