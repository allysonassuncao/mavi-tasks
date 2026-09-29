begin;

-- MAVI · Conexões (MCP) (Fase 3 da orquestradora):
--
-- 1. Poder novo 'mcp': a MAVI usa as ferramentas de servidores MCP externos
--    (Notion, Linear, HubSpot, um sistema próprio…). Vem desligado, como os
--    outros; quem tem o poder usa as conexões da empresa liberadas para ela
--    e pode criar as suas.
-- 2. Conexões da empresa (administradores e gestores cadastram e dizem quem
--    usa) e pessoais (só de quem criou). Autenticação: nenhuma, uma chave no
--    cabeçalho, ou OAuth (a conta da empresa, conectada por um líder, ou a
--    conta de cada pessoa). Chaves e tokens ficam selados pelo servidor
--    (AI_PROVIDER_KEY): o banco só guarda o texto cifrado.
-- 3. As ferramentas de cada servidor ficam guardadas (a MAVI não pergunta a
--    lista a cada resposta); quem edita liga e desliga cada uma. As que só
--    leem rodam direto; as outras viram uma ação que a pessoa confirma no
--    card (ai_mcp_claim_action e ai_mcp_action_result).
-- As funções de poderes abaixo são as da migração 20261216090000 com 'mcp';
-- quem as redefinir depois mantém os valores.

alter table public.ai_powers drop constraint ai_powers_power_check;
alter table public.ai_powers add constraint ai_powers_power_check
 check (power in ('visuals', 'images', 'actions', 'skills', 'canvas', 'web', 'mcp'));
alter table public.ai_tool_calls drop constraint ai_tool_calls_power_check;
alter table public.ai_tool_calls add constraint ai_tool_calls_power_check
 check (power in ('visuals', 'images', 'actions', 'skills', 'canvas', 'web', 'mcp'));

create or replace function public.ai_my_powers(p_company uuid) returns text[]
language sql stable security definer set search_path = '' as $$
 select coalesce(array_agg(p order by p), '{}')
 from unnest(array['actions', 'canvas', 'images', 'mcp', 'skills', 'visuals', 'web']) p
 where mavi_private.member(p_company) and mavi_private.ai_power_on(p_company, auth.uid(), p)
$$;

create or replace function public.ai_powers_admin(p_company uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$ begin
 if not mavi_private.leader(p_company) then
  raise exception 'Só administradores e gestores configuram os poderes da MAVI.' using errcode = '42501';
 end if;
 return (select coalesce(jsonb_agg(jsonb_build_object('power', p.power,
   'enabled', coalesce(w.enabled, false), 'everyone', coalesce(w.everyone, true),
   'team_ids', to_jsonb(coalesce(w.team_ids, '{}')), 'user_ids', to_jsonb(coalesce(w.user_ids, '{}')),
   'except_ids', to_jsonb(coalesce(w.except_ids, '{}')), 'updated_at', w.updated_at, 'updated_by', w.updated_by)
   order by p.ord), '[]')
  from unnest(array['visuals', 'images', 'actions', 'canvas', 'web', 'skills', 'mcp']) with ordinality p(power, ord)
  left join public.ai_powers w on w.company_id = p_company and w.power = p.power);
end $$;

create or replace function public.ai_set_power(p_company uuid, p_power text, p_enabled boolean, p_everyone boolean,
 p_teams uuid[], p_users uuid[], p_except uuid[]) returns void
language plpgsql security definer set search_path = '' as $$
declare v_teams uuid[]; v_users uuid[]; v_except uuid[]; begin
 if not mavi_private.leader(p_company) then
  raise exception 'Só administradores e gestores configuram os poderes da MAVI.' using errcode = '42501';
 end if;
 if p_power not in ('visuals', 'images', 'actions', 'skills', 'canvas', 'web', 'mcp') then
  raise exception 'Poder inválido.' using errcode = '22023';
 end if;
 select coalesce(array_agg(distinct t), '{}') into v_teams from unnest(coalesce(p_teams, '{}')) t
 where exists (select 1 from public.teams x where x.company_id = p_company and x.id = t);
 select coalesce(array_agg(distinct u), '{}') into v_users from unnest(coalesce(p_users, '{}')) u
 where exists (select 1 from public.memberships x where x.company_id = p_company and x.user_id = u);
 select coalesce(array_agg(distinct u), '{}') into v_except from unnest(coalesce(p_except, '{}')) u
 where exists (select 1 from public.memberships x where x.company_id = p_company and x.user_id = u);
 if coalesce(p_enabled, false) and not coalesce(p_everyone, true)
  and cardinality(v_teams) = 0 and cardinality(v_users) = 0 then
  raise exception 'Escolha pelo menos uma equipe ou pessoa (ou libere para todos).' using errcode = '22023';
 end if;
 insert into public.ai_powers(company_id, power, enabled, everyone, team_ids, user_ids, except_ids, updated_by)
 values (p_company, p_power, coalesce(p_enabled, false), coalesce(p_everyone, true), v_teams, v_users, v_except,
  auth.uid())
 on conflict (company_id, power) do update set enabled = excluded.enabled, everyone = excluded.everyone,
  team_ids = excluded.team_ids, user_ids = excluded.user_ids, except_ids = excluded.except_ids,
  updated_by = auth.uid(), updated_at = now();
end $$;

create or replace function public.ai_log_tool_calls(p_company uuid, p_conversation uuid, p_module text, p_calls jsonb)
returns void
language plpgsql security definer set search_path = '' as $$
declare v_conversation uuid := p_conversation; begin
 if not mavi_private.member(p_company) then raise exception 'Sem permissão.' using errcode = '42501'; end if;
 if jsonb_typeof(coalesce(p_calls, '[]')) <> 'array' or jsonb_array_length(coalesce(p_calls, '[]')) > 60 then
  raise exception 'Lista de chamadas inválida.' using errcode = '22023';
 end if;
 if v_conversation is not null and not exists (select 1 from public.ai_conversations v
  where v.company_id = p_company and v.id = v_conversation and v.owner_id = auth.uid()) then
  v_conversation := null;
 end if;
 insert into public.ai_tool_calls(company_id, conversation_id, module, tool, power, ok, duration_ms, cost_usd, error,
  skill_id, skill_version)
 select p_company, v_conversation, left(coalesce(p_module, 'assistant'), 40), left(x.tool, 80),
  case when x.power in ('visuals', 'images', 'actions', 'skills', 'canvas', 'web', 'mcp') then x.power end,
  coalesce(x.ok, false),
  least(greatest(coalesce(x.ms, 0), 0), 3600000), least(greatest(coalesce(x.cost, 0), 0), 100),
  left(x.error, 300),
  (select k.id from public.ai_skills k where k.company_id = p_company and k.id = x.skill),
  case when exists (select 1 from public.ai_skills k where k.company_id = p_company and k.id = x.skill)
   then x.skill_version end
 from jsonb_to_recordset(coalesce(p_calls, '[]')) as x(tool text, power text, ok boolean, ms integer, cost numeric,
  error text, skill uuid, skill_version integer)
 where coalesce(btrim(x.tool), '') <> '';
end $$;

-- ------------------------------------------------------------ conexões
create table mavi_private.ai_mcp_servers (
 id uuid primary key default gen_random_uuid(),
 company_id uuid not null references public.companies(id) on delete cascade,
 -- Sem dono: da empresa. Com dono: só dele.
 owner_id uuid references auth.users(id) on delete cascade,
 -- O prefixo das ferramentas para a MAVI (mcp_<slug>_<ferramenta>).
 slug text not null check (slug ~ '^[a-z0-9]{2,16}$'),
 name text not null check (length(btrim(name)) between 2 and 60),
 url text not null check (url ~ '^https://[^[:space:]]{4,}$' and length(url) <= 500),
 -- Quando usar (vai para a MAVI junto com as ferramentas).
 instructions text not null default '' check (length(instructions) <= 2000),
 auth text not null default 'none' check (auth in ('none', 'header', 'oauth')),
 -- OAuth da empresa: cada pessoa conecta a própria conta (senão, uma conta da empresa).
 per_person boolean not null default false,
 header_name text check (header_name ~ '^[A-Za-z0-9-]{1,60}$'),
 header_cipher text check (length(header_cipher) <= 8000),
 header_hint text check (length(header_hint) <= 8),
 -- Descoberta e cadastro do OAuth: endpoints, client_id, client_secret_cipher, scope, resource.
 oauth jsonb not null default '{}' check (jsonb_typeof(oauth) = 'object' and length(oauth::text) <= 12000),
 tools jsonb not null default '[]'
  check (jsonb_typeof(tools) = 'array' and jsonb_array_length(tools) <= 200),
 tools_at timestamptz,
 last_error text check (length(last_error) <= 300),
 enabled boolean not null default true,
 everyone boolean not null default true,
 team_ids uuid[] not null default '{}',
 user_ids uuid[] not null default '{}',
 except_ids uuid[] not null default '{}',
 created_by uuid default auth.uid(),
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 unique (company_id, slug),
 check (owner_id is null or not per_person),
 check ((auth = 'header') = (header_name is not null))
);
create index ai_mcp_servers_company on mavi_private.ai_mcp_servers(company_id, owner_id);

create table mavi_private.ai_mcp_tokens (
 server_id uuid not null references mavi_private.ai_mcp_servers(id) on delete cascade,
 -- Sem pessoa: a conta da empresa (conectada por um líder).
 user_id uuid references auth.users(id) on delete cascade,
 access_cipher text not null check (length(access_cipher) <= 16000),
 refresh_cipher text check (length(refresh_cipher) <= 16000),
 expires_at timestamptz,
 scope text check (length(scope) <= 1000),
 connected_by uuid default auth.uid(),
 updated_at timestamptz not null default now(),
 unique nulls not distinct (server_id, user_id)
);

create table mavi_private.ai_mcp_oauth_states (
 state_hash text primary key check (state_hash ~ '^[0-9a-f]{64}$'),
 server_id uuid not null references mavi_private.ai_mcp_servers(id) on delete cascade,
 user_id uuid not null references auth.users(id) on delete cascade,
 shared boolean not null,
 verifier_cipher text not null check (length(verifier_cipher) <= 1000),
 back text not null check (back ~ '^/[^[:space:]]*$' and length(back) <= 300),
 created_at timestamptz not null default now()
);

alter table mavi_private.ai_mcp_servers enable row level security;
alter table mavi_private.ai_mcp_tokens enable row level security;
alter table mavi_private.ai_mcp_oauth_states enable row level security;
revoke all on mavi_private.ai_mcp_servers, mavi_private.ai_mcp_tokens, mavi_private.ai_mcp_oauth_states
 from public, anon, authenticated;

-- A pessoa usa a conexão: o poder, a conexão ativa e (da empresa) no público dela.
create function mavi_private.ai_mcp_open(u uuid, s mavi_private.ai_mcp_servers) returns boolean
language sql stable security definer set search_path = '' as $$
 select s.enabled and mavi_private.ai_power_on(s.company_id, u, 'mcp')
  and (coalesce(s.owner_id = u, false) or (s.owner_id is null and not (u = any(s.except_ids))
   and (s.everyone or u = any(s.user_ids) or exists (select 1 from public.team_members tm
    where tm.company_id = s.company_id and tm.user_id = u and tm.team_id = any(s.team_ids)))))
$$;
-- Quem edita: o dono (pessoal) ou os líderes (da empresa).
create function mavi_private.ai_mcp_editor(s mavi_private.ai_mcp_servers) returns boolean
language sql stable security definer set search_path = '' as $$
 select mavi_private.member(s.company_id)
  and (coalesce(s.owner_id = auth.uid(), false) or (s.owner_id is null and mavi_private.leader(s.company_id)))
$$;
-- De quem é o token que a pessoa usa: dela (pessoal ou cada um com a sua) ou da empresa.
create function mavi_private.ai_mcp_token_user(u uuid, s mavi_private.ai_mcp_servers) returns uuid
language sql immutable set search_path = '' as $$
 select case when s.owner_id is not null then s.owner_id when s.per_person then u end
$$;
revoke all on function mavi_private.ai_mcp_open(uuid, mavi_private.ai_mcp_servers),
 mavi_private.ai_mcp_editor(mavi_private.ai_mcp_servers),
 mavi_private.ai_mcp_token_user(uuid, mavi_private.ai_mcp_servers) from public, anon, authenticated;

create function mavi_private.ai_mcp_get(p_server uuid) returns mavi_private.ai_mcp_servers
language plpgsql stable security definer set search_path = '' as $$
declare s mavi_private.ai_mcp_servers; begin
 select * into s from mavi_private.ai_mcp_servers where id = p_server;
 if s.id is null or not mavi_private.member(s.company_id)
  or not (mavi_private.ai_mcp_editor(s) or mavi_private.ai_mcp_open(auth.uid(), s)) then
  raise exception 'Conexão não encontrada.' using errcode = 'P0002';
 end if;
 return s;
end $$;
revoke all on function mavi_private.ai_mcp_get(uuid) from public, anon, authenticated;

-- O que a tela mostra (sem nada selado).
create function mavi_private.ai_mcp_view(s mavi_private.ai_mcp_servers, u uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
 select jsonb_build_object('id', s.id, 'slug', s.slug, 'name', s.name, 'url', s.url,
  'instructions', s.instructions, 'auth', s.auth, 'per_person', s.per_person, 'personal', s.owner_id is not null,
  'header_name', s.header_name, 'header_hint', s.header_hint, 'has_header', s.header_cipher is not null,
  'client_id', s.oauth->>'client_id', 'has_client_secret', s.oauth ? 'client_secret_cipher',
  'oauth_ready', s.oauth ? 'token_endpoint',
  'tools', (select coalesce(jsonb_agg(t - 'input_schema'), '[]') from jsonb_array_elements(s.tools) t),
  'tools_at', s.tools_at, 'last_error', s.last_error, 'enabled', s.enabled,
  'everyone', s.everyone, 'team_ids', to_jsonb(s.team_ids), 'user_ids', to_jsonb(s.user_ids),
  'except_ids', to_jsonb(s.except_ids), 'updated_at', s.updated_at,
  'editable', mavi_private.ai_mcp_editor(s), 'usable', mavi_private.ai_mcp_open(u, s),
  'connected', s.auth <> 'oauth' or exists (select 1 from mavi_private.ai_mcp_tokens k
   where k.server_id = s.id and k.user_id is not distinct from mavi_private.ai_mcp_token_user(u, s)),
  'connected_at', (select k.updated_at from mavi_private.ai_mcp_tokens k
   where k.server_id = s.id and k.user_id is not distinct from mavi_private.ai_mcp_token_user(u, s)))
$$;
revoke all on function mavi_private.ai_mcp_view(mavi_private.ai_mcp_servers, uuid) from public, anon, authenticated;

-- As conexões que a pessoa vê: as da empresa liberadas para ela (os líderes veem todas) e as dela.
create function public.ai_mcp_list(p_company uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
 select coalesce(jsonb_agg(mavi_private.ai_mcp_view(s, auth.uid())
   order by s.owner_id is not null, lower(s.name)), '[]')
 from mavi_private.ai_mcp_servers s
 where mavi_private.member(p_company) and s.company_id = p_company
  and (s.owner_id = auth.uid()
   or (s.owner_id is null and (mavi_private.leader(p_company) or mavi_private.ai_mcp_open(auth.uid(), s))))
$$;

-- Criar ou editar. A chave do cabeçalho chega selada pelo servidor (null mantém; '' tira).
-- Trocar o endereço esquece o OAuth, os tokens e as ferramentas.
create function public.ai_mcp_save(p_company uuid, p_server uuid, p_personal boolean, p_name text, p_url text,
 p_instructions text, p_auth text, p_per_person boolean, p_header_name text, p_header_cipher text,
 p_header_hint text, p_enabled boolean) returns uuid
language plpgsql security definer set search_path = '' as $$
declare s mavi_private.ai_mcp_servers; v_id uuid; v_slug text; v_base text; n integer := 1;
 v_personal boolean := coalesce(p_personal, false); v_url text := btrim(coalesce(p_url, '')); begin
 if not mavi_private.member(p_company) then raise exception 'Sem permissão.' using errcode = '42501'; end if;
 if coalesce(p_auth, '') not in ('none', 'header', 'oauth') then
  raise exception 'Autenticação inválida.' using errcode = '22023';
 end if;
 if v_url !~ '^https://[^[:space:]]{4,}$' or length(v_url) > 500 then
  raise exception 'Informe o endereço do servidor MCP começando com https://.' using errcode = '22023';
 end if;
 if length(btrim(coalesce(p_name, ''))) not between 2 and 60 then
  raise exception 'Dê um nome à conexão (2 a 60 letras).' using errcode = '22023';
 end if;
 if p_server is not null then
  select * into s from mavi_private.ai_mcp_servers where id = p_server and company_id = p_company;
  if s.id is null or not mavi_private.ai_mcp_editor(s) then
   raise exception 'Só quem criou a conexão (ou, na da empresa, administradores e gestores) edita.' using errcode = '42501';
  end if;
  v_personal := s.owner_id is not null;
 elsif v_personal then
  if not mavi_private.ai_power_on(p_company, auth.uid(), 'mcp') then
   raise exception 'As conexões (MCP) não estão liberadas para você. Um administrador ou gestor libera em Painel da MAVI › Poderes.' using errcode = '42501';
  end if;
 elsif not mavi_private.leader(p_company) then
  raise exception 'Só administradores e gestores criam conexões da empresa.' using errcode = '42501';
 end if;
 if p_auth = 'header' and (coalesce(p_header_name, '') !~ '^[A-Za-z0-9-]{1,60}$'
  or (coalesce(p_header_cipher, '') = '' and (s.id is null or s.header_cipher is null))) then
  raise exception 'Informe o nome do cabeçalho e a chave.' using errcode = '22023';
 end if;
 if p_server is null then
  v_base := left(regexp_replace(lower(translate(p_name, 'ÁÀÂÃÄáàâãäÉÈÊËéèêëÍÌÎÏíìîïÓÒÔÕÖóòôõöÚÙÛÜúùûüÇçÑñ',
   'AAAAAaaaaaEEEEeeeeIIIIiiiiOOOOOoooooUUUUuuuuCcNn')), '[^a-z0-9]', '', 'g'), 12);
  if length(v_base) < 2 then v_base := 'mcp'; end if;
  v_slug := v_base;
  while exists (select 1 from mavi_private.ai_mcp_servers x where x.company_id = p_company and x.slug = v_slug) loop
   n := n + 1;
   v_slug := v_base || n;
  end loop;
  insert into mavi_private.ai_mcp_servers(company_id, owner_id, slug, name, url, instructions, auth, per_person,
   header_name, header_cipher, header_hint, enabled)
  values (p_company, case when v_personal then auth.uid() end, v_slug, btrim(p_name), v_url,
   left(btrim(coalesce(p_instructions, '')), 2000), p_auth,
   p_auth = 'oauth' and not v_personal and coalesce(p_per_person, false),
   case when p_auth = 'header' then p_header_name end,
   case when p_auth = 'header' then nullif(p_header_cipher, '') end,
   case when p_auth = 'header' then left(p_header_hint, 8) end, coalesce(p_enabled, true))
  returning id into v_id;
  return v_id;
 end if;
 update mavi_private.ai_mcp_servers x set name = btrim(p_name), url = v_url,
  instructions = left(btrim(coalesce(p_instructions, '')), 2000), auth = p_auth,
  per_person = p_auth = 'oauth' and not v_personal and coalesce(p_per_person, false),
  header_name = case when p_auth = 'header' then p_header_name end,
  header_cipher = case when p_auth <> 'header' then null
   when p_header_cipher is null then x.header_cipher else nullif(p_header_cipher, '') end,
  header_hint = case when p_auth <> 'header' then null
   when p_header_cipher is null then x.header_hint else left(p_header_hint, 8) end,
  oauth = case when x.url <> v_url or p_auth <> 'oauth' then '{}' else x.oauth end,
  tools = case when x.url <> v_url then '[]' else x.tools end,
  tools_at = case when x.url <> v_url then null else x.tools_at end,
  enabled = coalesce(p_enabled, true), updated_at = now()
 where x.id = s.id;
 -- Outro endereço, outra autenticação ou outro jeito de conectar: as contas conectadas não valem mais.
 if s.url <> v_url or s.auth <> p_auth or s.per_person <> (p_auth = 'oauth' and not v_personal and coalesce(p_per_person, false)) then
  delete from mavi_private.ai_mcp_tokens where server_id = s.id;
 end if;
 return s.id;
end $$;

create function public.ai_mcp_set_audience(p_server uuid, p_everyone boolean, p_teams uuid[], p_users uuid[],
 p_except uuid[]) returns void
language plpgsql security definer set search_path = '' as $$
declare s mavi_private.ai_mcp_servers; begin
 select * into s from mavi_private.ai_mcp_servers where id = p_server;
 if s.id is null or s.owner_id is not null or not mavi_private.leader(s.company_id) then
  raise exception 'Só administradores e gestores dizem quem usa cada conexão da empresa.' using errcode = '42501';
 end if;
 update mavi_private.ai_mcp_servers set everyone = coalesce(p_everyone, true),
  team_ids = coalesce((select array_agg(distinct t) from unnest(coalesce(p_teams, '{}')) t
   where exists (select 1 from public.teams x where x.company_id = s.company_id and x.id = t)), '{}'),
  user_ids = coalesce((select array_agg(distinct u) from unnest(coalesce(p_users, '{}')) u
   where exists (select 1 from public.memberships x where x.company_id = s.company_id and x.user_id = u)), '{}'),
  except_ids = coalesce((select array_agg(distinct u) from unnest(coalesce(p_except, '{}')) u
   where exists (select 1 from public.memberships x where x.company_id = s.company_id and x.user_id = u)), '{}'),
  updated_at = now()
 where id = p_server;
 if not coalesce(p_everyone, true) and (select cardinality(team_ids) + cardinality(user_ids)
  from mavi_private.ai_mcp_servers where id = p_server) = 0 then
  raise exception 'Escolha pelo menos uma equipe ou pessoa (ou libere para todos).' using errcode = '22023';
 end if;
end $$;

create function public.ai_mcp_delete(p_server uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare s mavi_private.ai_mcp_servers; begin
 select * into s from mavi_private.ai_mcp_servers where id = p_server;
 if s.id is null or not mavi_private.ai_mcp_editor(s) then
  raise exception 'Só quem criou a conexão (ou, na da empresa, administradores e gestores) apaga.' using errcode = '42501';
 end if;
 delete from mavi_private.ai_mcp_servers where id = p_server;
end $$;

-- A lista de ferramentas que o servidor devolveu (o servidor da MAVI guarda).
-- Mantém o liga/desliga de cada uma; as novas entram ligadas. Sem lista: só o erro.
create function public.ai_mcp_set_tools(p_server uuid, p_tools jsonb, p_error text) returns void
language plpgsql security definer set search_path = '' as $$
declare s mavi_private.ai_mcp_servers; begin
 select * into s from mavi_private.ai_mcp_servers where id = p_server;
 if s.id is null or not mavi_private.ai_mcp_editor(s) then
  raise exception 'Só quem edita a conexão atualiza as ferramentas.' using errcode = '42501';
 end if;
 if p_tools is null then
  update mavi_private.ai_mcp_servers set last_error = left(p_error, 300) where id = p_server;
  return;
 end if;
 if jsonb_typeof(p_tools) <> 'array' or jsonb_array_length(p_tools) > 200 or length(p_tools::text) > 600000 then
  raise exception 'Lista de ferramentas inválida.' using errcode = '22023';
 end if;
 update mavi_private.ai_mcp_servers x set tools = (
   select coalesce(jsonb_agg(jsonb_build_object('name', t.name, 'title', left(coalesce(t.item->>'title', ''), 120),
     'description', left(coalesce(t.item->>'description', ''), 2000),
     'read_only', coalesce((t.item->>'read_only')::boolean, false),
     'input_schema', case when jsonb_typeof(t.item->'input_schema') = 'object' then t.item->'input_schema'
      else '{"type":"object"}'::jsonb end,
     'enabled', coalesce((select (o->>'enabled')::boolean from jsonb_array_elements(x.tools) o
      where o->>'name' = t.name), true)) order by t.ord), '[]')
   from (select distinct on (e.item->>'name') e.item->>'name' as name, e.item, e.ord
    from jsonb_array_elements(p_tools) with ordinality e(item, ord)
    where jsonb_typeof(e.item) = 'object' and coalesce(e.item->>'name', '') ~ '^[A-Za-z0-9_./-]{1,128}$'
    order by e.item->>'name', e.ord) t),
  tools_at = now(), last_error = left(p_error, 300)
 where x.id = p_server;
end $$;

create function public.ai_mcp_toggle_tool(p_server uuid, p_tool text, p_enabled boolean) returns void
language plpgsql security definer set search_path = '' as $$
declare s mavi_private.ai_mcp_servers; begin
 select * into s from mavi_private.ai_mcp_servers where id = p_server;
 if s.id is null or not mavi_private.ai_mcp_editor(s) then
  raise exception 'Só quem edita a conexão liga e desliga as ferramentas.' using errcode = '42501';
 end if;
 update mavi_private.ai_mcp_servers x set tools = (
   select coalesce(jsonb_agg(case when t->>'name' = p_tool
     then t || jsonb_build_object('enabled', coalesce(p_enabled, false)) else t end order by ord), '[]')
   from jsonb_array_elements(x.tools) with ordinality e(t, ord)), updated_at = now()
 where x.id = p_server;
end $$;

-- O OAuth descoberto (e o cadastro do app): quem edita, ou quem conecta a
-- própria conta enquanto o app ainda não foi cadastrado.
create function public.ai_mcp_set_oauth(p_server uuid, p_oauth jsonb) returns void
language plpgsql security definer set search_path = '' as $$
declare s mavi_private.ai_mcp_servers; begin
 s := mavi_private.ai_mcp_get(p_server);
 if s.auth <> 'oauth' then raise exception 'Esta conexão não usa OAuth.' using errcode = '22023'; end if;
 if not mavi_private.ai_mcp_editor(s) and (s.oauth ? 'client_id' or not s.per_person) then
  raise exception 'Só quem edita a conexão muda o OAuth.' using errcode = '42501';
 end if;
 if jsonb_typeof(p_oauth) <> 'object' or length(p_oauth::text) > 12000 then
  raise exception 'OAuth inválido.' using errcode = '22023';
 end if;
 update mavi_private.ai_mcp_servers set oauth = p_oauth, updated_at = now() where id = p_server;
end $$;

-- Para o servidor da MAVI falar com a conexão: o endereço, a chave selada, o
-- OAuth e o token de quem pergunta (selados).
create function mavi_private.ai_mcp_secret(s mavi_private.ai_mcp_servers, u uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
 select jsonb_build_object('id', s.id, 'slug', s.slug, 'name', s.name, 'url', s.url, 'auth', s.auth,
  'per_person', s.per_person, 'personal', s.owner_id is not null, 'instructions', s.instructions,
  'header_name', s.header_name, 'header_cipher', s.header_cipher, 'oauth', s.oauth,
  'token', (select jsonb_build_object('access_cipher', k.access_cipher, 'refresh_cipher', k.refresh_cipher,
    'expires_at', k.expires_at) from mavi_private.ai_mcp_tokens k
   where k.server_id = s.id and k.user_id is not distinct from mavi_private.ai_mcp_token_user(u, s)))
$$;
revoke all on function mavi_private.ai_mcp_secret(mavi_private.ai_mcp_servers, uuid) from public, anon, authenticated;

create function public.ai_mcp_connection(p_server uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare s mavi_private.ai_mcp_servers; begin
 s := mavi_private.ai_mcp_get(p_server);
 return mavi_private.ai_mcp_secret(s, auth.uid()) || jsonb_build_object('editable', mavi_private.ai_mcp_editor(s),
  'tools', s.tools);
end $$;

-- As conexões desta resposta: as abertas para a pessoa, prontas (com a chave
-- ou a conta conectada), com as ferramentas ligadas; e as que faltam conectar.
create function public.ai_mcp_catalog(p_company uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
 with usable as (
  select s as srv, s.name, s.tools, (s.auth = 'none' or (s.auth = 'header' and s.header_cipher is not null)
    or (s.auth = 'oauth' and exists (select 1 from mavi_private.ai_mcp_tokens k where k.server_id = s.id
     and k.user_id is not distinct from mavi_private.ai_mcp_token_user(auth.uid(), s)))) as ready
  from mavi_private.ai_mcp_servers s
  where mavi_private.member(p_company) and s.company_id = p_company and mavi_private.ai_mcp_open(auth.uid(), s))
 select jsonb_build_object(
  'servers', (select coalesce(jsonb_agg(mavi_private.ai_mcp_secret(u.srv, auth.uid()) || jsonb_build_object('tools',
    (select coalesce(jsonb_agg(t), '[]') from jsonb_array_elements(u.tools) t
     where coalesce((t->>'enabled')::boolean, true))) order by lower(u.name)), '[]') from usable u where u.ready),
  'missing', (select coalesce(jsonb_agg(u.name order by lower(u.name)), '[]') from usable u where not u.ready))
$$;

-- O token renovado pelo servidor da MAVI (de quem está usando).
create function public.ai_mcp_save_token(p_server uuid, p_access text, p_refresh text, p_expires timestamptz,
 p_scope text) returns void
language plpgsql security definer set search_path = '' as $$
declare s mavi_private.ai_mcp_servers; begin
 s := mavi_private.ai_mcp_get(p_server);
 if coalesce(p_access, '') = '' then raise exception 'Token vazio.' using errcode = '22023'; end if;
 update mavi_private.ai_mcp_tokens set access_cipher = p_access,
  refresh_cipher = coalesce(nullif(p_refresh, ''), refresh_cipher), expires_at = p_expires,
  scope = coalesce(left(p_scope, 1000), scope), updated_at = now()
 where server_id = s.id and user_id is not distinct from mavi_private.ai_mcp_token_user(auth.uid(), s);
end $$;

create function public.ai_mcp_disconnect(p_server uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare s mavi_private.ai_mcp_servers; v_user uuid; begin
 s := mavi_private.ai_mcp_get(p_server);
 v_user := mavi_private.ai_mcp_token_user(auth.uid(), s);
 if v_user is null and not mavi_private.ai_mcp_editor(s) then
  raise exception 'Só administradores e gestores desconectam a conta da empresa.' using errcode = '42501';
 end if;
 delete from mavi_private.ai_mcp_tokens where server_id = s.id and user_id is not distinct from v_user;
end $$;

-- ------------------------------------------------------------ OAuth
-- Começa a conexão: guarda o estado (o hash) e o verificador do PKCE (selado).
create function public.ai_mcp_oauth_begin(p_server uuid, p_state_hash text, p_verifier_cipher text, p_back text)
returns void
language plpgsql security definer set search_path = '' as $$
declare s mavi_private.ai_mcp_servers; v_shared boolean; begin
 s := mavi_private.ai_mcp_get(p_server);
 if s.auth <> 'oauth' then raise exception 'Esta conexão não usa OAuth.' using errcode = '22023'; end if;
 v_shared := mavi_private.ai_mcp_token_user(auth.uid(), s) is null;
 if v_shared and not mavi_private.ai_mcp_editor(s) then
  raise exception 'Só administradores e gestores conectam a conta da empresa.' using errcode = '42501';
 end if;
 if not v_shared and not mavi_private.ai_mcp_open(auth.uid(), s) then
  raise exception 'Esta conexão não está liberada para você.' using errcode = '42501';
 end if;
 delete from mavi_private.ai_mcp_oauth_states where created_at < now() - interval '15 minutes';
 insert into mavi_private.ai_mcp_oauth_states(state_hash, server_id, user_id, shared, verifier_cipher, back)
 values (p_state_hash, s.id, auth.uid(), v_shared, p_verifier_cipher, coalesce(p_back, '/'));
end $$;

-- A volta do OAuth (sem login: vale o estado, que só quem começou tem).
create function public.ai_mcp_oauth_pending(p_state_hash text) returns jsonb
language sql stable security definer set search_path = '' as $$
 select jsonb_build_object('server', s.id, 'company', s.company_id, 'url', s.url, 'oauth', s.oauth,
  'verifier_cipher', st.verifier_cipher, 'back', st.back)
 from mavi_private.ai_mcp_oauth_states st join mavi_private.ai_mcp_servers s on s.id = st.server_id
 where st.state_hash = p_state_hash and st.created_at > now() - interval '15 minutes'
$$;

create function public.ai_mcp_oauth_finish(p_state_hash text, p_access text, p_refresh text, p_expires timestamptz,
 p_scope text) returns text
language plpgsql security definer set search_path = '' as $$
declare st mavi_private.ai_mcp_oauth_states; begin
 delete from mavi_private.ai_mcp_oauth_states where state_hash = p_state_hash
  and created_at > now() - interval '15 minutes' returning * into st;
 if st.state_hash is null then raise exception 'A conexão expirou. Tente de novo.' using errcode = 'P0002'; end if;
 if coalesce(p_access, '') = '' then raise exception 'Token vazio.' using errcode = '22023'; end if;
 insert into mavi_private.ai_mcp_tokens(server_id, user_id, access_cipher, refresh_cipher, expires_at, scope,
  connected_by)
 values (st.server_id, case when st.shared then null else st.user_id end, p_access, nullif(p_refresh, ''),
  p_expires, left(p_scope, 1000), st.user_id)
 on conflict (server_id, user_id) do update set access_cipher = excluded.access_cipher,
  refresh_cipher = excluded.refresh_cipher, expires_at = excluded.expires_at, scope = excluded.scope,
  connected_by = excluded.connected_by, updated_at = now();
 update mavi_private.ai_mcp_servers set last_error = null where id = st.server_id;
 return st.back;
end $$;

-- ------------------------------------------------------------ ações confirmadas
-- A pessoa confirmou a ação de uma conexão: fica "confirmada" antes de rodar
-- (não roda duas vezes) e volta o que a MAVI propôs, como foi gravado.
create function public.ai_mcp_claim_action(p_conversation uuid, p_artifact text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_company uuid; v_message bigint; v_action jsonb; begin
 select company_id into v_company from public.ai_conversations
 where id = p_conversation and owner_id = auth.uid();
 if v_company is null or not mavi_private.member(v_company) then
  raise exception 'Só quem começou a conversa decide as ações dela.' using errcode = '42501';
 end if;
 select m.id, a->'action' into v_message, v_action
 from public.ai_messages m, jsonb_array_elements(m.artifacts) a
 where m.company_id = v_company and m.conversation_id = p_conversation
  and a->>'id' = p_artifact and a->>'type' = 'action' and a->>'state' = 'pending'
  and a->'action'->>'kind' = 'mcp_call'
 order by m.id desc limit 1;
 if v_message is null then raise exception 'Esta ação já foi decidida.' using errcode = 'P0002'; end if;
 update public.ai_messages m set artifacts = (
  select jsonb_agg(case when a->>'id' = p_artifact
    then a || jsonb_build_object('state', 'confirmed', 'result', '{"running":true}'::jsonb,
     'decided_at', now(), 'decided_by', auth.uid())
    else a end order by ord)
  from jsonb_array_elements(m.artifacts) with ordinality t(a, ord))
 where m.id = v_message;
 return v_action || jsonb_build_object('company', v_company);
end $$;

create function public.ai_mcp_action_result(p_conversation uuid, p_artifact text, p_ok boolean, p_result jsonb)
returns void
language plpgsql security definer set search_path = '' as $$
declare v_company uuid; v_message bigint; begin
 select company_id into v_company from public.ai_conversations
 where id = p_conversation and owner_id = auth.uid();
 if v_company is null then raise exception 'Sem permissão.' using errcode = '42501'; end if;
 if jsonb_typeof(coalesce(p_result, '{}')) <> 'object' or length(coalesce(p_result, '{}')::text) > 4000 then
  raise exception 'Resultado inválido.' using errcode = '22023';
 end if;
 select m.id into v_message from public.ai_messages m
 where m.company_id = v_company and m.conversation_id = p_conversation
  and m.artifacts @> jsonb_build_array(jsonb_build_object('id', p_artifact, 'type', 'action', 'state', 'confirmed',
   'result', jsonb_build_object('running', true)))
 order by m.id desc limit 1;
 if v_message is null then return; end if;
 update public.ai_messages m set artifacts = (
  select jsonb_agg(case when a->>'id' = p_artifact
    then a || jsonb_build_object('state', case when coalesce(p_ok, false) then 'confirmed' else 'failed' end,
     'result', coalesce(p_result, '{}'))
    else a end order by ord)
  from jsonb_array_elements(m.artifacts) with ordinality t(a, ord))
 where m.id = v_message;
end $$;

revoke all on function public.ai_mcp_list(uuid),
 public.ai_mcp_save(uuid, uuid, boolean, text, text, text, text, boolean, text, text, text, boolean),
 public.ai_mcp_set_audience(uuid, boolean, uuid[], uuid[], uuid[]), public.ai_mcp_delete(uuid),
 public.ai_mcp_set_tools(uuid, jsonb, text), public.ai_mcp_toggle_tool(uuid, text, boolean),
 public.ai_mcp_set_oauth(uuid, jsonb), public.ai_mcp_connection(uuid), public.ai_mcp_catalog(uuid),
 public.ai_mcp_save_token(uuid, text, text, timestamptz, text), public.ai_mcp_disconnect(uuid),
 public.ai_mcp_oauth_begin(uuid, text, text, text), public.ai_mcp_oauth_pending(text),
 public.ai_mcp_oauth_finish(text, text, text, timestamptz, text),
 public.ai_mcp_claim_action(uuid, text), public.ai_mcp_action_result(uuid, text, boolean, jsonb)
 from public, anon;
grant execute on function public.ai_mcp_list(uuid),
 public.ai_mcp_save(uuid, uuid, boolean, text, text, text, text, boolean, text, text, text, boolean),
 public.ai_mcp_set_audience(uuid, boolean, uuid[], uuid[], uuid[]), public.ai_mcp_delete(uuid),
 public.ai_mcp_set_tools(uuid, jsonb, text), public.ai_mcp_toggle_tool(uuid, text, boolean),
 public.ai_mcp_set_oauth(uuid, jsonb), public.ai_mcp_connection(uuid), public.ai_mcp_catalog(uuid),
 public.ai_mcp_save_token(uuid, text, text, timestamptz, text), public.ai_mcp_disconnect(uuid),
 public.ai_mcp_oauth_begin(uuid, text, text, text),
 public.ai_mcp_claim_action(uuid, text), public.ai_mcp_action_result(uuid, text, boolean, jsonb)
 to authenticated;
-- A volta do OAuth chega sem login.
grant execute on function public.ai_mcp_oauth_pending(text), public.ai_mcp_oauth_finish(text, text, text, timestamptz, text)
 to anon, authenticated;

commit;
