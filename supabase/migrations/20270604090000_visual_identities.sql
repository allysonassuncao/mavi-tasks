-- MAVI · identidades visuais dos documentos e apresentações.
--
-- Uma identidade é o "tema" que a MAVI aplica nos arquivos que gera (PDF,
-- PowerPoint, Word, HTML): cores por função, fontes de título e de texto,
-- logos, cantos, capa e detalhes — e o Guia da marca, um texto em Markdown
-- com o que não cabe nos tokens (essência, tom, o que fazer e evitar,
-- exemplos aprovados, aprendizados), que a MAVI lê quando precisa.
--
-- - scope 'client': uma por cliente (Drive › cliente › Marca); quem atende
--   o cliente lê e edita.
-- - scope 'company': a da própria empresa (uma); qualquer pessoa da empresa.
-- - scope 'gallery': estilos da galeria; qualquer pessoa cria e edita.
--
-- Cada salvamento é uma versão (imutável), com autor e motivo; restaurar
-- vira versão nova. Os logos e as fontes são arquivos de alguma pasta de
-- marca do Drive (tokens.logo / tokens.faces guardam os ids).

create table public.visual_identities (
 id uuid primary key default gen_random_uuid(),
 company_id uuid not null references public.companies(id) on delete cascade,
 scope text not null check (scope in ('company', 'client', 'gallery')),
 client_id uuid,
 name text not null check (length(name) between 1 and 80),
 description text not null default '' check (length(description) <= 300),
 tokens jsonb not null default '{}' check (jsonb_typeof(tokens) = 'object' and length(tokens::text) <= 20000),
 guide text not null default '' check (length(guide) <= 30000),
 version integer not null default 1,
 archived boolean not null default false,
 created_by uuid default auth.uid(),
 created_at timestamptz not null default now(),
 updated_by uuid default auth.uid(),
 updated_at timestamptz not null default now(),
 check ((scope = 'client') = (client_id is not null)),
 foreign key (company_id, client_id) references public.clients(company_id, id) on delete cascade
);
create unique index visual_identities_company_one on public.visual_identities(company_id)
 where scope = 'company' and not archived;
create unique index visual_identities_client_one on public.visual_identities(company_id, client_id)
 where scope = 'client' and not archived;
create index visual_identities_gallery on public.visual_identities(company_id, updated_at desc)
 where scope = 'gallery' and not archived;

create table public.visual_identity_versions (
 id uuid primary key default gen_random_uuid(),
 identity_id uuid not null references public.visual_identities(id) on delete cascade,
 company_id uuid not null,
 version integer not null,
 name text not null,
 description text not null default '',
 tokens jsonb not null,
 guide text not null default '',
 reason text not null default '' check (length(reason) <= 300),
 author uuid default auth.uid(),
 created_at timestamptz not null default now(),
 unique (identity_id, version)
);

alter table public.visual_identities enable row level security;
alter table public.visual_identity_versions enable row level security;
-- Só pelas funções abaixo.
revoke all on public.visual_identities, public.visual_identity_versions from anon, authenticated;

-- Quem lê (e edita) uma identidade: da empresa e da galeria, qualquer pessoa
-- ativa na empresa; a do cliente, quem atende o cliente.
create function mavi_private.identity_can(p_company uuid, p_scope text, p_client uuid) returns boolean
language sql stable security definer set search_path = '' as $$
 select p_company in (select mavi_private.active_companies())
  and (p_scope <> 'client' or mavi_private.drive_can_read(p_company, p_client))
$$;
revoke all on function mavi_private.identity_can(uuid, text, uuid) from public, anon;
grant execute on function mavi_private.identity_can(uuid, text, uuid) to authenticated;

-- Os ids de arquivos que os tokens usam (logos e fontes).
create function mavi_private.identity_files(p_tokens jsonb) returns uuid[]
language sql immutable set search_path = '' as $$
 select coalesce(array_agg(distinct v::uuid), '{}') from (
  select p_tokens->'logo'->>'light' v
  union all select p_tokens->'logo'->>'dark'
  union all select f->>'file' from jsonb_array_elements(
   case when jsonb_typeof(p_tokens->'faces') = 'array' then p_tokens->'faces' else '[]' end) f
 ) x where v ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
$$;

create function mavi_private.identity_row(i public.visual_identities, p_guide boolean) returns jsonb
language sql stable security definer set search_path = '' as $$
 select jsonb_build_object(
  'id', i.id, 'scope', i.scope, 'client_id', i.client_id,
  'client_name', (select name from public.clients c where c.company_id = i.company_id and c.id = i.client_id),
  'name', i.name, 'description', i.description, 'tokens', i.tokens,
  'guide_chars', length(i.guide), 'version', i.version, 'updated_at', i.updated_at,
  'updated_by_name', (select m.name from public.memberships m where m.company_id = i.company_id and m.user_id = i.updated_by)
 ) || case when p_guide then jsonb_build_object('guide', i.guide) else '{}' end
$$;
revoke all on function mavi_private.identity_row(public.visual_identities, boolean) from public, anon;

-- O que dá para usar: a da empresa, a do cliente (se pedir e atender) e a
-- galeria. Sem o texto do guia (vem em identity_get).
create function public.identity_list(p_company uuid, p_client uuid default null) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
 if p_company not in (select mavi_private.active_companies()) then return null; end if;
 return jsonb_build_object(
  'company', (select mavi_private.identity_row(i, false) from public.visual_identities i
   where i.company_id = p_company and i.scope = 'company' and not i.archived),
  'client', case when p_client is not null and mavi_private.drive_can_read(p_company, p_client) then
   (select mavi_private.identity_row(i, false) from public.visual_identities i
    where i.company_id = p_company and i.scope = 'client' and i.client_id = p_client and not i.archived) end,
  'gallery', coalesce((select jsonb_agg(mavi_private.identity_row(i, false) order by i.updated_at desc)
   from (select * from public.visual_identities i where i.company_id = p_company and i.scope = 'gallery'
    and not i.archived order by i.updated_at desc limit 200) i), '[]'));
end $$;
revoke all on function public.identity_list(uuid, uuid) from public, anon;
grant execute on function public.identity_list(uuid, uuid) to authenticated;

-- Uma identidade inteira, com o guia e as últimas versões.
create function public.identity_get(p_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare i public.visual_identities; begin
 select * into i from public.visual_identities where id = p_id;
 if i.id is null or not mavi_private.identity_can(i.company_id, i.scope, i.client_id) then return null; end if;
 return mavi_private.identity_row(i, true) || jsonb_build_object('archived', i.archived, 'versions',
  coalesce((select jsonb_agg(jsonb_build_object('version', v.version, 'reason', v.reason, 'created_at', v.created_at,
    'author_name', (select m.name from public.memberships m where m.company_id = v.company_id and m.user_id = v.author))
   order by v.version desc)
   from (select * from public.visual_identity_versions v where v.identity_id = i.id order by v.version desc limit 60) v), '[]'));
end $$;
revoke all on function public.identity_get(uuid) from public, anon;
grant execute on function public.identity_get(uuid) to authenticated;

-- A identidade de um cliente (para a MAVI e a Marca), sem saber o id.
create function public.identity_of_client(p_company uuid, p_client uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
 select public.identity_get(i.id) from public.visual_identities i
 where i.company_id = p_company and i.scope = 'client' and i.client_id = p_client and not i.archived
$$;
revoke all on function public.identity_of_client(uuid, uuid) from public, anon;
grant execute on function public.identity_of_client(uuid, uuid) to authenticated;

-- Cria (p_id null) ou salva uma versão nova. Os arquivos dos tokens precisam
-- estar numa pasta de marca da empresa (a do próprio cliente, na dele).
create function public.identity_save(p_company uuid, p_id uuid, p_scope text, p_client uuid, p_name text,
 p_description text, p_tokens jsonb, p_guide text, p_reason text default '') returns jsonb
language plpgsql security definer set search_path = '' as $$
declare i public.visual_identities; v_files uuid[]; v_name text := trim(coalesce(p_name, '')); begin
 if p_id is not null then
  select * into i from public.visual_identities where id = p_id and company_id = p_company for update;
  if i.id is null or i.archived then raise exception 'Identidade não encontrada.' using errcode = 'P0002'; end if;
  p_scope := i.scope; p_client := i.client_id;
 end if;
 if p_scope not in ('company', 'client', 'gallery') then raise exception 'Tipo inválido.' using errcode = '22023'; end if;
 if p_scope <> 'client' then p_client := null; end if;
 if p_scope = 'client' and p_client is null then raise exception 'Diga o cliente.' using errcode = '22023'; end if;
 if not mavi_private.identity_can(p_company, p_scope, p_client) then
  raise exception '%', case when p_scope = 'client' then 'Só quem atende este cliente edita a identidade dele.'
   else 'Sem acesso a esta empresa.' end using errcode = '42501';
 end if;
 if length(v_name) not between 1 and 80 then raise exception 'Dê um nome de até 80 letras.' using errcode = '22023'; end if;
 if jsonb_typeof(coalesce(p_tokens, 'null')) <> 'object' or length(p_tokens::text) > 20000 then
  raise exception 'Tema inválido.' using errcode = '22023';
 end if;
 if length(coalesce(p_guide, '')) > 30000 then raise exception 'O guia passa de 30 mil caracteres.' using errcode = '22023'; end if;
 v_files := mavi_private.identity_files(p_tokens);
 if exists (select 1 from unnest(v_files) f where not exists (
  select 1 from public.drive_files df join public.drive_folders fo on fo.company_id = df.company_id and fo.id = df.folder_id
  where df.company_id = p_company and df.id = f and df.status = 'ready' and fo.system = 'brand'
   and (p_scope <> 'client' or fo.client_id = p_client)
   and mavi_private.drive_can_read(p_company, fo.client_id))) then
  raise exception 'Logos e fontes precisam estar na Marca de um cliente que você atende%.',
   case when p_scope = 'client' then ' (a deste cliente)' else '' end using errcode = '22023';
 end if;
 if i.id is null then
  insert into public.visual_identities(company_id, scope, client_id, name, description, tokens, guide)
  values (p_company, p_scope, p_client, v_name, left(trim(coalesce(p_description, '')), 300), p_tokens, coalesce(p_guide, ''))
  returning * into i;
 else
  update public.visual_identities set name = v_name, description = left(trim(coalesce(p_description, '')), 300),
   tokens = p_tokens, guide = coalesce(p_guide, ''), version = version + 1, updated_by = auth.uid(), updated_at = now()
  where id = i.id returning * into i;
 end if;
 insert into public.visual_identity_versions(identity_id, company_id, version, name, description, tokens, guide, reason)
 values (i.id, p_company, i.version, i.name, i.description, i.tokens, i.guide, left(trim(coalesce(p_reason, '')), 300));
 return jsonb_build_object('id', i.id, 'version', i.version);
exception when unique_violation then
 raise exception '%', case when p_scope = 'company' then 'A empresa já tem uma identidade: abra e edite.'
  else 'Este cliente já tem uma identidade: abra e edite.' end using errcode = '23505';
end $$;
revoke all on function public.identity_save(uuid, uuid, text, uuid, text, text, jsonb, text, text) from public, anon;
grant execute on function public.identity_save(uuid, uuid, text, uuid, text, text, jsonb, text, text) to authenticated;

-- Uma versão antiga inteira (para ver antes de restaurar).
create function public.identity_version(p_id uuid, p_version integer) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare i public.visual_identities; v public.visual_identity_versions; begin
 select * into i from public.visual_identities where id = p_id;
 if i.id is null or not mavi_private.identity_can(i.company_id, i.scope, i.client_id) then return null; end if;
 select * into v from public.visual_identity_versions where identity_id = p_id and version = p_version;
 if v.id is null then return null; end if;
 return jsonb_build_object('version', v.version, 'name', v.name, 'description', v.description,
  'tokens', v.tokens, 'guide', v.guide, 'reason', v.reason, 'created_at', v.created_at);
end $$;
revoke all on function public.identity_version(uuid, integer) from public, anon;
grant execute on function public.identity_version(uuid, integer) to authenticated;

-- Restaurar = uma versão nova igual à antiga.
create function public.identity_restore(p_id uuid, p_version integer) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare i public.visual_identities; v public.visual_identity_versions; begin
 select * into i from public.visual_identities where id = p_id;
 if i.id is null or not mavi_private.identity_can(i.company_id, i.scope, i.client_id) then
  raise exception 'Identidade não encontrada.' using errcode = 'P0002';
 end if;
 select * into v from public.visual_identity_versions where identity_id = p_id and version = p_version;
 if v.id is null then raise exception 'Versão não encontrada.' using errcode = 'P0002'; end if;
 return public.identity_save(i.company_id, i.id, i.scope, i.client_id, v.name, v.description, v.tokens, v.guide,
  format('Restaurou a versão %s', p_version));
end $$;
revoke all on function public.identity_restore(uuid, integer) from public, anon;
grant execute on function public.identity_restore(uuid, integer) to authenticated;

-- Arquivar (sai das listas; as versões ficam). A do cliente e a da empresa
-- podem ser criadas de novo depois.
create function public.identity_archive(p_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare i public.visual_identities; begin
 select * into i from public.visual_identities where id = p_id;
 if i.id is null or not mavi_private.identity_can(i.company_id, i.scope, i.client_id) then
  raise exception 'Identidade não encontrada.' using errcode = 'P0002';
 end if;
 update public.visual_identities set archived = true, updated_by = auth.uid(), updated_at = now() where id = p_id;
end $$;
revoke all on function public.identity_archive(uuid) from public, anon;
grant execute on function public.identity_archive(uuid) to authenticated;

-- Onde estão os arquivos de marca que um documento usa (só o servidor
-- chama, para assinar os links): da Marca de um cliente que a pessoa atende,
-- ou usados pela identidade da empresa ou por um estilo da galeria (que
-- todos da empresa usam).
create function public.identity_file_targets(p_company uuid, p_files uuid[])
returns table(id uuid, name text, content_type text, path text)
language plpgsql stable security definer set search_path = '' as $$
#variable_conflict use_column
begin
 if p_company not in (select mavi_private.active_companies()) then return; end if;
 return query select f.id, f.name, f.content_type, f.path
 from public.drive_files f join public.drive_folders fo on fo.company_id = f.company_id and fo.id = f.folder_id
 where f.company_id = p_company and f.id = any(p_files[1:40]) and f.status = 'ready' and fo.system = 'brand'
  and (mavi_private.drive_can_read(p_company, fo.client_id)
   or exists (select 1 from public.visual_identities i where i.company_id = p_company and i.scope <> 'client'
    and not i.archived and f.id = any(mavi_private.identity_files(i.tokens))));
end $$;
revoke all on function public.identity_file_targets(uuid, uuid[]) from public, anon;
grant execute on function public.identity_file_targets(uuid, uuid[]) to authenticated;
