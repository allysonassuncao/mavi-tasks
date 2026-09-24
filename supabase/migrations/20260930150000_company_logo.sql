begin;

-- Company logo (the workspace image in the sidebar). Administrators upload
-- it like a profile photo: the database picks the object path inside the
-- company's own folder of the public bucket (company_logo_upload_path, used
-- by /api/profile) and only accepts a URL from that folder. The upload is
-- recorded in storage_uploads (kind 'logo'); the previous logo stops counting.
alter table public.companies add column logo_url text
 check (logo_url is null or logo_url ~ '^https://storage\.googleapis\.com/[a-z0-9._-]+/company-logos/[0-9a-f-]{36}/[0-9a-f-]{36}\.(webp|jpg)$');

alter table public.storage_uploads drop constraint storage_uploads_kind_check;
alter table public.storage_uploads add constraint storage_uploads_kind_check
 check (kind in ('drive','attachment','inline_image','avatar','logo'));

create function public.company_logo_upload_path(p_company uuid, p_format text default 'webp') returns text
language plpgsql security definer set search_path = '' as $$ begin
  if not mavi_private.admin(p_company) then raise exception 'Sem permissão' using errcode = '42501'; end if;
  if p_format not in ('webp', 'jpg') then raise exception 'Formato de imagem inválido.' using errcode = '22023'; end if;
  return 'company-logos/' || p_company || '/' || gen_random_uuid() || '.' || p_format;
end $$;

create function public.set_company_logo(p_company uuid, p_url text, p_size bigint default null) returns void
language plpgsql security definer set search_path = '' as $$ begin
  if not mavi_private.admin(p_company) then raise exception 'Sem permissão' using errcode = '42501'; end if;
  if p_url is not null and p_url !~ ('/company-logos/' || p_company || '/[0-9a-f-]{36}\.(webp|jpg)$') then
    raise exception 'Imagem inválida.' using errcode = '22023';
  end if;
  update public.companies set logo_url = p_url where id = p_company;
  update public.storage_uploads set deleted_at = now()
  where company_id = p_company and kind = 'logo' and deleted_at is null;
  if p_url is not null then
    insert into public.storage_uploads(company_id, user_id, kind, source_id, name, size_bytes, completed_at)
    values (p_company, auth.uid(), 'logo', substring(p_url from '/([0-9a-f-]{36})\.(?:webp|jpg)$')::uuid,
     'Logo da empresa', least(greatest(coalesce(p_size, 0), 0), 524288), now())
    on conflict (company_id, kind, source_id) do update set deleted_at = null, size_bytes = excluded.size_bytes;
  end if;
end $$;

revoke all on function public.company_logo_upload_path(uuid, text), public.set_company_logo(uuid, text, bigint) from public, anon;
grant execute on function public.company_logo_upload_path(uuid, text), public.set_company_logo(uuid, text, bigint) to authenticated;

commit;
