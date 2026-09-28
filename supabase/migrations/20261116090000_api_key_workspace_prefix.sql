begin;

-- Chaves de API com o prefixo "workspace_" (antes "mavi_"); o prefixo
-- guardado para a lista passa a mostrar 8 caracteres depois dele.
create or replace function public.api_key_create(p_company uuid, p_name text) returns text
language plpgsql security definer set search_path = '' as $$
declare k text := 'workspace_' || encode(extensions.gen_random_bytes(32), 'hex'); begin
 perform mavi_private.api_require_admin(p_company);
 if (select count(*) from mavi_private.api_keys where company_id = p_company and revoked_at is null) >= 20 then
  raise exception 'Limite de 20 chaves ativas. Revogue uma antes de criar outra.' using errcode = '22023';
 end if;
 insert into mavi_private.api_keys(company_id, name, prefix, key_hash, created_by)
 values (p_company, trim(coalesce(p_name, '')), left(k, 18), extensions.digest(k, 'sha256'), auth.uid());
 return k;
end $$;

commit;
