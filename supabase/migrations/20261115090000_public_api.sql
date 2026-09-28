begin;

-- API pública (/api/v1): sistemas de fora (CRM, checkout, n8n…) cadastram
-- clientes e vinculam produtos com uma chave de API do espaço. A chave só
-- existe em claro no momento em que é criada; aqui fica o SHA-256 dela.
-- O servidor chama as funções api_* sem sessão (chave publicável), então
-- cada uma começa validando a chave e só enxerga a empresa dela.
create table mavi_private.api_keys (
 id uuid primary key default gen_random_uuid(),
 company_id uuid not null references public.companies(id),
 name text not null check (length(trim(name)) between 2 and 80),
 prefix text not null,
 key_hash bytea not null unique,
 created_by uuid not null,
 created_at timestamptz not null default now(),
 last_used_at timestamptz,
 revoked_at timestamptz,
 foreign key (company_id, created_by) references public.memberships(company_id, user_id)
);
create index api_keys_company on mavi_private.api_keys(company_id, created_at desc);

create function mavi_private.api_require_admin(c uuid) returns void
language plpgsql stable security definer set search_path = '' as $$ begin
 if not mavi_private.admin(c) then
  raise exception 'Sem permissão: chaves de API são exclusivas de administradores' using errcode = '42501';
 end if;
end $$;
revoke all on function mavi_private.api_require_admin(uuid) from public, anon, authenticated;

-- Cria a chave e devolve o texto dela (a única vez em que aparece).
create function public.api_key_create(p_company uuid, p_name text) returns text
language plpgsql security definer set search_path = '' as $$
declare k text := 'mavi_' || encode(extensions.gen_random_bytes(32), 'hex'); begin
 perform mavi_private.api_require_admin(p_company);
 if (select count(*) from mavi_private.api_keys where company_id = p_company and revoked_at is null) >= 20 then
  raise exception 'Limite de 20 chaves ativas. Revogue uma antes de criar outra.' using errcode = '22023';
 end if;
 insert into mavi_private.api_keys(company_id, name, prefix, key_hash, created_by)
 values (p_company, trim(coalesce(p_name, '')), left(k, 13), extensions.digest(k, 'sha256'), auth.uid());
 return k;
end $$;

create function public.api_keys_list(p_company uuid) returns table(
 id uuid, name text, prefix text, created_by_name text, created_at timestamptz,
 last_used_at timestamptz, revoked_at timestamptz)
language plpgsql stable security definer set search_path = '' as $$ begin
 perform mavi_private.api_require_admin(p_company);
 return query select k.id, k.name, k.prefix, m.name, k.created_at, k.last_used_at, k.revoked_at
  from mavi_private.api_keys k
  join public.memberships m on m.company_id = k.company_id and m.user_id = k.created_by
  where k.company_id = p_company
  order by k.revoked_at is not null, k.created_at desc;
end $$;

create function public.api_key_revoke(p_key uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare c uuid; begin
 select company_id into c from mavi_private.api_keys where id = p_key;
 perform mavi_private.api_require_admin(c);
 update mavi_private.api_keys set revoked_at = now() where id = p_key and revoked_at is null;
end $$;

-- A empresa da chave (ativa); registra o uso.
create function mavi_private.api_company(p_key text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare c uuid; begin
 update mavi_private.api_keys set last_used_at = now()
  where key_hash = extensions.digest(coalesce(p_key, ''), 'sha256') and revoked_at is null
  returning company_id into c;
 if c is null then raise exception 'Chave de API inválida ou revogada' using errcode = '42501'; end if;
 return c;
end $$;
revoke all on function mavi_private.api_company(text) from public, anon, authenticated;

-- Um produto ou equipe da empresa, pelo id ou pelo nome (sem diferenciar
-- maiúsculas). Aceita "texto" ou {"id": …} / {"name": …}.
create function mavi_private.api_resolve(c uuid, p_kind text, p_ref jsonb) returns uuid
language plpgsql stable security definer set search_path = '' as $$
declare ref text; by_id boolean; ids uuid[];
 label text := case p_kind when 'product' then 'Produto' else 'Equipe' end;
 missing text := case p_kind when 'product' then 'Produto não encontrado' else 'Equipe não encontrada' end; begin
 if jsonb_typeof(p_ref) = 'string' then ref := p_ref #>> '{}';
 elsif jsonb_typeof(p_ref) = 'object' then ref := coalesce(p_ref ->> 'id', p_ref ->> 'name');
 end if;
 ref := trim(coalesce(ref, ''));
 if ref = '' then raise exception '% sem id ou nome', label using errcode = '22023'; end if;
 by_id := ref ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
 if p_kind = 'product' then
  select array_agg(id) into ids from public.products
   where company_id = c and (case when by_id then id = ref::uuid else lower(trim(name)) = lower(ref) end);
 else
  select array_agg(id) into ids from public.teams
   where company_id = c and (case when by_id then id = ref::uuid else lower(trim(name)) = lower(ref) end);
 end if;
 if ids is null then raise exception '%: %', missing, ref using errcode = '22023'; end if;
 if array_length(ids, 1) > 1 then
  raise exception 'Há mais de um registro com o nome "%"; use o id', ref using errcode = '22023';
 end if;
 return ids[1];
end $$;
revoke all on function mavi_private.api_resolve(uuid, text, jsonb) from public, anon, authenticated;

create function mavi_private.api_client_json(c uuid, p_client uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
 select jsonb_build_object(
  'id', cl.id, 'name', cl.name, 'email', cl.email, 'archived', cl.archived, 'created_at', cl.created_at,
  'teams', coalesce((select jsonb_agg(jsonb_build_object('id', t.id, 'name', t.name) order by t.name)
   from public.client_teams ct join public.teams t on t.company_id = ct.company_id and t.id = ct.team_id
   where ct.company_id = c and ct.client_id = cl.id), '[]'),
  'products', coalesce((select jsonb_agg(jsonb_build_object('contract_id', k.id, 'product_id', p.id,
    'product_name', p.name, 'contract_name', k.name, 'created_at', k.created_at) order by k.created_at)
   from public.contracts k join public.products p on p.company_id = k.company_id and p.id = k.product_id
   where k.company_id = c and k.client_id = cl.id and not k.archived), '[]'))
 from public.clients cl where cl.company_id = c and cl.id = p_client
$$;
revoke all on function mavi_private.api_client_json(uuid, uuid) from public, anon, authenticated;

-- Vincula cada produto ao cliente; um produto já vinculado (e não
-- arquivado) não é duplicado. Devolve um item por produto pedido.
create function mavi_private.api_link_products(c uuid, p_client uuid, p_products jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare item jsonb; product uuid; existing uuid; contract uuid; label text; client_name text; product_name text;
 seen uuid[] := '{}'; out jsonb := '[]'; begin
 if jsonb_typeof(coalesce(p_products, '[]')) <> 'array' then
  raise exception 'products deve ser uma lista' using errcode = '22023';
 end if;
 if jsonb_array_length(coalesce(p_products, '[]')) > 50 then
  raise exception 'No máximo 50 produtos por requisição' using errcode = '22023';
 end if;
 select name into client_name from public.clients where company_id = c and id = p_client;
 for item in select * from jsonb_array_elements(coalesce(p_products, '[]')) loop
  product := mavi_private.api_resolve(c, 'product', item);
  continue when product = any(seen);
  seen := seen || product;
  select name into product_name from public.products where company_id = c and id = product;
  select id into existing from public.contracts
   where company_id = c and client_id = p_client and product_id = product and not archived
   order by created_at limit 1;
  if existing is not null then
   contract := existing;
  else
   label := trim(coalesce(case when jsonb_typeof(item) = 'object' then item ->> 'contract_name' end, ''));
   if label = '' then label := product_name || ' · ' || client_name; end if;
   insert into public.contracts(company_id, client_id, product_id, name)
   values (c, p_client, product, left(label, 200)) returning id into contract;
  end if;
  out := out || jsonb_build_object('contract_id', contract, 'product_id', product,
   'product_name', product_name, 'created', existing is null);
 end loop;
 return out;
end $$;
revoke all on function mavi_private.api_link_products(uuid, uuid, jsonb) from public, anon, authenticated;

-- POST /api/v1/clients: o cliente, suas equipes e produtos, tudo ou nada.
-- Um cliente ativo com o mesmo e-mail barra o cadastro (o id dele vai em
-- detail) para uma nova tentativa da integração não duplicar o cliente.
create function public.api_create_client(p_key text, p_client jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare c uuid := mavi_private.api_company(p_key); v_name text; v_email text; teams uuid[] := '{}'; t jsonb;
 dup uuid; result uuid; linked jsonb; begin
 if jsonb_typeof(p_client) <> 'object' then raise exception 'Corpo inválido' using errcode = '22023'; end if;
 v_name := trim(coalesce(p_client ->> 'name', ''));
 v_email := lower(trim(coalesce(p_client ->> 'email', '')));
 if length(v_name) not between 2 and 160 then
  raise exception 'name deve ter de 2 a 160 caracteres' using errcode = '22023';
 end if;
 if v_email <> '' and v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
  raise exception 'email inválido' using errcode = '22023';
 end if;
 if jsonb_typeof(coalesce(p_client -> 'teams', '[]')) <> 'array' then
  raise exception 'teams deve ser uma lista' using errcode = '22023';
 end if;
 for t in select * from jsonb_array_elements(coalesce(p_client -> 'teams', '[]')) loop
  teams := teams || mavi_private.api_resolve(c, 'team', t);
 end loop;
 if v_email <> '' then
  select id into dup from public.clients where company_id = c and not archived and lower(email) = v_email limit 1;
  if dup is not null then
   raise exception 'Já existe um cliente ativo com este e-mail' using errcode = '23505', detail = dup::text;
  end if;
 end if;
 insert into public.clients(company_id, name, email) values (c, v_name, v_email) returning id into result;
 perform mavi_private.set_client_teams(c, result, teams);
 linked := mavi_private.api_link_products(c, result, p_client -> 'products');
 return jsonb_build_object('client', mavi_private.api_client_json(c, result), 'linked', linked);
end $$;

-- POST /api/v1/clients/{id}/products
create function public.api_link_client_products(p_key text, p_client uuid, p_products jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare c uuid := mavi_private.api_company(p_key); linked jsonb; begin
 if not exists (select 1 from public.clients where company_id = c and id = p_client) then
  raise exception 'Cliente não encontrado' using errcode = 'P0002';
 end if;
 if jsonb_array_length(coalesce(p_products, '[]')) = 0 then
  raise exception 'Informe ao menos um produto' using errcode = '22023';
 end if;
 linked := mavi_private.api_link_products(c, p_client, p_products);
 return jsonb_build_object('client', mavi_private.api_client_json(c, p_client), 'linked', linked);
end $$;

-- GET /api/v1/clients/{id}
create function public.api_get_client(p_key text, p_client uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare c uuid := mavi_private.api_company(p_key); r jsonb; begin
 r := mavi_private.api_client_json(c, p_client);
 if r is null then raise exception 'Cliente não encontrado' using errcode = 'P0002'; end if;
 return r;
end $$;

-- GET /api/v1/clients?email=…&search=…: até 20, os ativos primeiro.
create function public.api_find_clients(p_key text, p_email text default null, p_search text default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare c uuid := mavi_private.api_company(p_key); e text := lower(trim(coalesce(p_email, '')));
 s text := trim(coalesce(p_search, '')); begin
 if e = '' and length(s) < 2 then
  raise exception 'Informe email ou search (2 caracteres ou mais)' using errcode = '22023';
 end if;
 return coalesce((select jsonb_agg(jsonb_build_object('id', id, 'name', name, 'email', email, 'archived', archived))
  from (select id, name, email, archived from public.clients
   where company_id = c and (e = '' or lower(email) = e)
    and (s = '' or name ilike '%' || replace(replace(replace(s, '\', '\\'), '%', '\%'), '_', '\_') || '%')
   order by archived, name limit 20) x), '[]');
end $$;

-- GET /api/v1/products e /api/v1/teams
create function public.api_list_products(p_key text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare c uuid := mavi_private.api_company(p_key); begin
 return coalesce((select jsonb_agg(jsonb_build_object('id', id, 'name', name) order by name)
  from public.products where company_id = c), '[]');
end $$;
create function public.api_list_teams(p_key text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare c uuid := mavi_private.api_company(p_key); begin
 return coalesce((select jsonb_agg(jsonb_build_object('id', id, 'name', name) order by name)
  from public.teams where company_id = c), '[]');
end $$;

do $$ declare f record; begin
 for f in select p.oid::regprocedure as signature, p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname like 'api\_%' loop
  execute format('revoke all on function %s from public, anon, authenticated', f.signature);
  if f.proname like 'api\_key%' then
   execute format('grant execute on function %s to authenticated', f.signature);
  else
   execute format('grant execute on function %s to anon, authenticated', f.signature);
  end if;
 end loop;
end $$;

commit;
