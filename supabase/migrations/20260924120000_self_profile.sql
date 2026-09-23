begin;

-- People edit their own basic info and profile photo. The name and photo live
-- on every membership of the person, so lookups (and realtime) already carry
-- them to everyone who can see that membership.
alter table public.memberships add column avatar_url text
 check (avatar_url is null or avatar_url ~ '^https://storage\.googleapis\.com/[a-z0-9._-]+/avatars/[0-9a-f-]{36}/[0-9a-f-]{36}\.(webp|jpg)$');

create function public.update_my_profile(p_name text) returns void
language plpgsql security definer set search_path = '' as $$ begin
  if length(trim(coalesce(p_name, ''))) not between 2 and 120 then
    raise exception 'Informe um nome de 2 a 120 caracteres.';
  end if;
  update public.memberships set name = trim(p_name) where user_id = auth.uid();
  if not found then raise exception 'Perfil não encontrado' using errcode = '42501'; end if;
end $$;

-- A fresh object path inside the caller's own avatar folder (used by /api/profile).
-- WebP normally; JPEG for browsers that cannot encode WebP (Safari).
create function public.avatar_upload_path(p_format text default 'webp') returns text
language plpgsql security definer set search_path = '' as $$ begin
  if p_format not in ('webp', 'jpg') then raise exception 'Formato de foto inválido.'; end if;
  if auth.uid() is null or not exists(select 1 from public.memberships where user_id = auth.uid() and active) then
    raise exception 'Perfil não encontrado' using errcode = '42501';
  end if;
  return 'avatars/' || auth.uid() || '/' || gen_random_uuid() || '.' || p_format;
end $$;

-- Only photos stored in the caller's own avatar folder are accepted.
create function public.set_my_avatar(p_url text) returns void
language plpgsql security definer set search_path = '' as $$ begin
  if p_url is not null and p_url !~ ('/avatars/' || auth.uid() || '/[0-9a-f-]{36}\.(webp|jpg)$') then
    raise exception 'Foto inválida.';
  end if;
  update public.memberships set avatar_url = p_url where user_id = auth.uid();
  if not found then raise exception 'Perfil não encontrado' using errcode = '42501'; end if;
end $$;

do $$ declare f record; begin
 for f in select p.oid::regprocedure as signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='public' and p.proname=any(array['update_my_profile','avatar_upload_path','set_my_avatar']) loop
 execute format('revoke all on function %s from public,anon',f.signature);
 execute format('grant execute on function %s to authenticated',f.signature);
 end loop;
end $$;

commit;
