begin;

-- IA do MAVI · biblioteca de provedores e regras de uso.
--
-- O administrador cadastra provedores de IA (Claude, OpenAI, Gemini,
-- OpenRouter… ou qualquer API compatível com a da OpenAI), cada um com a sua
-- API Key e os modelos liberados (com o preço de cada um, para o Consumo de
-- IA e os limites). Depois escolhe qual provedor e modelo respondem para a
-- empresa toda, para uma pessoa, um cliente, um produto ou um projeto. Vale a
-- regra mais específica: projeto › produto › cliente › pessoa › empresa; sem
-- regra, responde o padrão do servidor (ANTHROPIC_API_KEY e AI_MODEL).
--
-- A API Key nunca chega ao banco em texto: o servidor (/api/ai) a sela com
-- AES-256-GCM sob AI_PROVIDER_KEY, que o banco não conhece — o texto guardado
-- não serve para nada sem essa chave. O navegador só vê os 4 últimos
-- caracteres.
--
-- O assistente de IA (o balão em todas as telas) vira um módulo: o
-- administrador o liga ou desliga em "Módulos visíveis" de cada pessoa.
--
-- Pode rodar de novo sem estragar nada (tudo com if not exists / or
-- replace): em produção este SQL foi aplicado antes da 20261024090000_ai_mcp,
-- que depois recriou a ai_log_usage antiga e tirou 'assistant' dos módulos.
-- Rodar esta migration de novo desfaz isso.

alter table public.memberships drop constraint if exists memberships_hidden_pages_check;
alter table public.memberships add constraint memberships_hidden_pages_check
 check (hidden_pages <@ array['overview','tasks','agenda','clients','products','projects','campaigns','hours',
  'reports','drive','storage','dashboards','onboarding','aiUsage','assistant']::text[]);

create or replace function public.set_member_pages(p_company uuid, p_user uuid, p_hidden text[]) returns void
language plpgsql security definer set search_path = '' as $$
declare v text[]; begin
 if not mavi_private.admin(p_company) then
  raise exception 'Somente administradores escolhem os módulos de cada pessoa.' using errcode = '42501';
 end if;
 if not exists (select 1 from public.memberships where company_id = p_company and user_id = p_user) then
  raise exception 'Usuário não encontrado na empresa';
 end if;
 select coalesce(array_agg(distinct x order by x), '{}') into v from unnest(coalesce(p_hidden, '{}')) x;
 if not v <@ array['overview','tasks','agenda','clients','products','projects','campaigns','hours',
  'reports','drive','storage','dashboards','onboarding','aiUsage','assistant']::text[] then
  raise exception 'Módulo inválido' using errcode = '22023';
 end if;
 update public.memberships set hidden_pages = v where company_id = p_company and user_id = p_user
  and hidden_pages is distinct from v;
end $$;

-- ------------------------------------------------------------ provedores
-- kind: o modelo do catálogo (api/_ai-providers.ts). 'anthropic' fala a API
-- da Claude; os demais falam a API de chat da OpenAI (Gemini e os outros
-- também a oferecem). models: [{id, label, input, output, cached}] com os
-- preços em US$ por milhão de tokens.
create table if not exists mavi_private.ai_providers (
 id uuid primary key default gen_random_uuid(),
 company_id uuid not null references public.companies(id) on delete cascade,
 name text not null check (length(btrim(name)) between 1 and 80),
 kind text not null check (kind in ('anthropic', 'openai', 'google', 'openrouter', 'groq', 'deepseek',
  'mistral', 'xai', 'custom')),
 base_url text check (base_url is null or (base_url ~ '^https://' and length(base_url) <= 300)),
 key_cipher text not null check (key_cipher ~ '^v1:'),
 key_hint text not null default '' check (length(key_hint) <= 8),
 models jsonb not null default '[]' check (jsonb_typeof(models) = 'array' and jsonb_array_length(models) <= 60),
 active boolean not null default true,
 created_by uuid default auth.uid(),
 created_at timestamptz not null default now(),
 updated_by uuid default auth.uid(),
 updated_at timestamptz not null default now(),
 unique (company_id, name)
);
create index if not exists ai_providers_company on mavi_private.ai_providers (company_id);
alter table mavi_private.ai_providers enable row level security;
revoke all on mavi_private.ai_providers from public, anon, authenticated;

-- Quem usa o quê. scope_type 'company' vale para todos (scope_id nulo).
create table if not exists mavi_private.ai_routes (
 id uuid primary key default gen_random_uuid(),
 company_id uuid not null references public.companies(id) on delete cascade,
 scope_type text not null check (scope_type in ('company', 'user', 'client', 'contract', 'project')),
 scope_id uuid,
 provider_id uuid not null references mavi_private.ai_providers(id) on delete cascade,
 model text not null check (length(model) between 1 and 120),
 updated_by uuid default auth.uid(),
 updated_at timestamptz not null default now(),
 check ((scope_type = 'company') = (scope_id is null)),
 unique nulls not distinct (company_id, scope_type, scope_id)
);
create index if not exists ai_routes_provider on mavi_private.ai_routes (provider_id);
alter table mavi_private.ai_routes enable row level security;
revoke all on mavi_private.ai_routes from public, anon, authenticated;

-- Confere a lista de modelos: id, nome e preços (US$ por milhão de tokens).
create or replace function mavi_private.ai_clean_models(p_models jsonb) returns jsonb
language plpgsql immutable set search_path = '' as $$
declare m jsonb; out jsonb := '[]'; ids text[] := '{}'; v_id text; begin
 if p_models is null or jsonb_typeof(p_models) <> 'array' then raise exception 'Lista de modelos inválida.' using errcode = '22023'; end if;
 for m in select * from jsonb_array_elements(p_models) loop
  v_id := btrim(coalesce(m->>'id', ''));
  if v_id = '' or length(v_id) > 120 or v_id !~ '^[A-Za-z0-9._:/@+-]+$' then
   raise exception 'Modelo inválido: %', left(v_id, 120) using errcode = '22023';
  end if;
  if v_id = any(ids) then continue; end if;
  if jsonb_typeof(m->'input') is distinct from 'number' or jsonb_typeof(m->'output') is distinct from 'number'
   or (m->>'input')::numeric < 0 or (m->>'output')::numeric < 0
   or (m->>'input')::numeric > 1000 or (m->>'output')::numeric > 1000 then
   raise exception 'Informe os preços do modelo % (US$ por milhão de tokens).', v_id using errcode = '22023';
  end if;
  if m ? 'cached' and m->'cached' <> 'null' and (jsonb_typeof(m->'cached') <> 'number'
   or (m->>'cached')::numeric < 0 or (m->>'cached')::numeric > 1000) then
   raise exception 'Preço de cache inválido no modelo %.', v_id using errcode = '22023';
  end if;
  ids := ids || v_id;
  out := out || jsonb_build_array(jsonb_strip_nulls(jsonb_build_object('id', v_id,
   'label', nullif(left(btrim(coalesce(m->>'label', '')), 80), ''),
   'input', (m->>'input')::numeric, 'output', (m->>'output')::numeric,
   'cached', case when jsonb_typeof(m->'cached') = 'number' then (m->>'cached')::numeric end)));
 end loop;
 if jsonb_array_length(out) = 0 then raise exception 'Escolha ao menos um modelo.' using errcode = '22023'; end if;
 if jsonb_array_length(out) > 60 then raise exception 'No máximo 60 modelos por provedor.' using errcode = '22023'; end if;
 return out;
end $$;
revoke all on function mavi_private.ai_clean_models(jsonb) from public, anon, authenticated;

-- A biblioteca (administradores): sem a chave, só o final dela.
create or replace function public.ai_provider_list(p_company uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$ begin
 if not mavi_private.admin(p_company) then
  raise exception 'Só administradores configuram os provedores de IA.' using errcode = '42501';
 end if;
 return jsonb_build_object(
  'providers', (select coalesce(jsonb_agg(jsonb_build_object('id', p.id, 'name', p.name, 'kind', p.kind,
     'base_url', p.base_url, 'key_hint', p.key_hint, 'models', p.models, 'active', p.active,
     'updated_at', p.updated_at, 'routes', (select count(*) from mavi_private.ai_routes r where r.provider_id = p.id))
    order by p.name), '[]') from mavi_private.ai_providers p where p.company_id = p_company),
  'routes', (select coalesce(jsonb_agg(jsonb_build_object('id', r.id, 'type', r.scope_type, 'scope_id', r.scope_id,
     'provider_id', r.provider_id, 'model', r.model, 'updated_at', r.updated_at)
    order by r.scope_type, r.updated_at), '[]') from mavi_private.ai_routes r where r.company_id = p_company));
end $$;

-- Cadastra ou altera um provedor. Chamada pelo /api/ai, que sela a chave;
-- p_key_cipher nulo numa alteração mantém a chave de antes.
create or replace function public.ai_save_provider(p_company uuid, p_id uuid, p_name text, p_kind text, p_base_url text,
 p_models jsonb, p_key_cipher text, p_key_hint text, p_active boolean) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_id uuid; v_models jsonb; begin
 if not mavi_private.admin(p_company) then
  raise exception 'Só administradores configuram os provedores de IA.' using errcode = '42501';
 end if;
 if p_kind not in ('anthropic', 'openai', 'google', 'openrouter', 'groq', 'deepseek', 'mistral', 'xai', 'custom') then
  raise exception 'Provedor inválido.' using errcode = '22023';
 end if;
 if p_kind = 'custom' and coalesce(p_base_url, '') = '' then
  raise exception 'Informe o endereço da API.' using errcode = '22023';
 end if;
 if p_key_cipher is not null and p_key_cipher !~ '^v1:' then raise exception 'Chave inválida.' using errcode = '22023'; end if;
 if length(btrim(coalesce(p_name, ''))) not between 1 and 80 then
  raise exception 'Dê um nome de até 80 caracteres ao provedor.' using errcode = '22023';
 end if;
 v_models := mavi_private.ai_clean_models(p_models);
 if p_id is null then
  if p_key_cipher is null then raise exception 'Informe a API Key.' using errcode = '22023'; end if;
  insert into mavi_private.ai_providers(company_id, name, kind, base_url, key_cipher, key_hint, models, active)
  values (p_company, btrim(p_name), p_kind, nullif(p_base_url, ''), p_key_cipher, left(coalesce(p_key_hint, ''), 8),
   v_models, coalesce(p_active, true))
  returning id into v_id;
 else
  update mavi_private.ai_providers set name = btrim(p_name), kind = p_kind, base_url = nullif(p_base_url, ''),
   key_cipher = coalesce(p_key_cipher, key_cipher),
   key_hint = case when p_key_cipher is null then key_hint else left(coalesce(p_key_hint, ''), 8) end,
   models = v_models, active = coalesce(p_active, active), updated_by = auth.uid(), updated_at = now()
  where id = p_id and company_id = p_company returning id into v_id;
  if v_id is null then raise exception 'Provedor não encontrado.' using errcode = 'P0002'; end if;
  -- Regras de modelos que saíram da lista deixam de valer.
  delete from mavi_private.ai_routes r where r.provider_id = v_id
   and not exists (select 1 from jsonb_array_elements(v_models) m where m->>'id' = r.model);
 end if;
 return v_id;
exception when unique_violation then
 raise exception 'Já existe um provedor com esse nome.' using errcode = '23505';
end $$;

create or replace function public.ai_set_provider_active(p_company uuid, p_id uuid, p_active boolean) returns void
language plpgsql security definer set search_path = '' as $$ begin
 if not mavi_private.admin(p_company) then
  raise exception 'Só administradores configuram os provedores de IA.' using errcode = '42501';
 end if;
 update mavi_private.ai_providers set active = coalesce(p_active, false), updated_by = auth.uid(), updated_at = now()
 where id = p_id and company_id = p_company;
 if not found then raise exception 'Provedor não encontrado.' using errcode = 'P0002'; end if;
end $$;

-- Remove o provedor e as regras que o usam (o histórico de consumo fica).
create or replace function public.ai_delete_provider(p_company uuid, p_id uuid) returns void
language plpgsql security definer set search_path = '' as $$ begin
 if not mavi_private.admin(p_company) then
  raise exception 'Só administradores configuram os provedores de IA.' using errcode = '42501';
 end if;
 delete from mavi_private.ai_providers where id = p_id and company_id = p_company;
end $$;

-- Para o /api/ai testar a conexão e buscar os modelos (administradores):
-- a chave selada, inútil sem a chave do servidor.
create or replace function public.ai_provider_secret(p_company uuid, p_id uuid) returns table(kind text, base_url text,
 key_cipher text, models jsonb)
language plpgsql stable security definer set search_path = '' as $$ begin
 if not mavi_private.admin(p_company) then
  raise exception 'Só administradores configuram os provedores de IA.' using errcode = '42501';
 end if;
 return query select p.kind, p.base_url, p.key_cipher, p.models from mavi_private.ai_providers p
  where p.id = p_id and p.company_id = p_company;
end $$;

-- Uma regra: p_provider nulo tira a regra (volta a valer a menos específica).
create or replace function public.ai_set_route(p_company uuid, p_type text, p_id uuid, p_provider uuid, p_model text) returns void
language plpgsql security definer set search_path = '' as $$ begin
 if not mavi_private.admin(p_company) then
  raise exception 'Só administradores escolhem qual IA cada um usa.' using errcode = '42501';
 end if;
 if p_type not in ('company', 'user', 'client', 'contract', 'project') then raise exception 'Tipo inválido.' using errcode = '22023'; end if;
 if p_type <> 'company' and p_id is null then raise exception 'Escolha para quem vale a regra.' using errcode = '22023'; end if;
 if p_provider is null then
  delete from mavi_private.ai_routes where company_id = p_company and scope_type = p_type
   and scope_id is not distinct from case when p_type = 'company' then null else p_id end;
  return;
 end if;
 if not exists (select 1 from mavi_private.ai_providers p where p.id = p_provider and p.company_id = p_company
   and exists (select 1 from jsonb_array_elements(p.models) m where m->>'id' = p_model)) then
  raise exception 'Escolha um modelo cadastrado no provedor.' using errcode = '22023';
 end if;
 if p_type = 'user' and not exists (select 1 from public.memberships where company_id = p_company and user_id = p_id)
  or p_type = 'client' and not exists (select 1 from public.clients where company_id = p_company and id = p_id)
  or p_type = 'contract' and not exists (select 1 from public.contracts where company_id = p_company and id = p_id)
  or p_type = 'project' and not exists (select 1 from public.projects where company_id = p_company and id = p_id) then
  raise exception 'Não encontrado na empresa.' using errcode = 'P0002';
 end if;
 insert into mavi_private.ai_routes(company_id, scope_type, scope_id, provider_id, model)
 values (p_company, p_type, case when p_type = 'company' then null else p_id end, p_provider, p_model)
 on conflict (company_id, scope_type, scope_id) do update set provider_id = excluded.provider_id,
  model = excluded.model, updated_by = auth.uid(), updated_at = now();
end $$;

-- Qual IA responde a esta pergunta: a regra mais específica que vale para
-- quem pergunta e onde (o projeto leva ao produto e o produto ao cliente).
-- Só provedores ativos. Nulo: o padrão do servidor. Para o /api/ai: a chave
-- vem selada.
create or replace function public.ai_resolve_route(p_company uuid, p_client uuid, p_contract uuid, p_project uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_contract uuid := p_contract; v_client uuid := p_client; r record; begin
 if not mavi_private.member(p_company) then raise exception 'Sem acesso ao espaço' using errcode = '42501'; end if;
 if p_project is not null then
  select coalesce(pr.contract_id, v_contract) into v_contract from public.projects pr
  where pr.id = p_project and pr.company_id = p_company;
 end if;
 if v_contract is not null then
  select coalesce(k.client_id, v_client) into v_client from public.contracts k
  where k.id = v_contract and k.company_id = p_company;
 end if;
 -- Só vale o contexto de clientes que a pessoa acessa.
 if v_client is not null and not mavi_private.drive_can_read(p_company, v_client) then
  v_client := null; v_contract := null;
 end if;
 select rt.scope_type, rt.model, p.id, p.name, p.kind, p.base_url, p.key_cipher, p.models into r
 from mavi_private.ai_routes rt join mavi_private.ai_providers p on p.id = rt.provider_id and p.active
 where rt.company_id = p_company and (
   (rt.scope_type = 'project' and rt.scope_id = p_project and v_contract is not distinct from
     (select pr.contract_id from public.projects pr where pr.id = p_project))
   or (rt.scope_type = 'contract' and rt.scope_id = v_contract)
   or (rt.scope_type = 'client' and rt.scope_id = v_client)
   or (rt.scope_type = 'user' and rt.scope_id = auth.uid())
   or rt.scope_type = 'company')
 order by case rt.scope_type when 'project' then 1 when 'contract' then 2 when 'client' then 3
  when 'user' then 4 else 5 end
 limit 1;
 if not found then return null; end if;
 return jsonb_build_object('scope', r.scope_type, 'provider_id', r.id, 'provider', r.name, 'kind', r.kind,
  'base_url', r.base_url, 'key_cipher', r.key_cipher, 'model', r.model,
  'price', (select m from jsonb_array_elements(r.models) m where m->>'id' = r.model limit 1));
end $$;

revoke all on function public.ai_provider_list(uuid),
 public.ai_save_provider(uuid, uuid, text, text, text, jsonb, text, text, boolean),
 public.ai_set_provider_active(uuid, uuid, boolean), public.ai_delete_provider(uuid, uuid),
 public.ai_provider_secret(uuid, uuid), public.ai_set_route(uuid, text, uuid, uuid, text),
 public.ai_resolve_route(uuid, uuid, uuid, uuid) from public, anon;
grant execute on function public.ai_provider_list(uuid),
 public.ai_save_provider(uuid, uuid, text, text, text, jsonb, text, text, boolean),
 public.ai_set_provider_active(uuid, uuid, boolean), public.ai_delete_provider(uuid, uuid),
 public.ai_provider_secret(uuid, uuid), public.ai_set_route(uuid, text, uuid, uuid, text),
 public.ai_resolve_route(uuid, uuid, uuid, uuid) to authenticated;

-- ------------------------------------------------------------ consumo
-- Qual provedor respondeu (o nome fica guardado mesmo que o provedor saia).
alter table public.ai_usage add column if not exists provider_id uuid;
alter table public.ai_usage add column if not exists provider_name text not null default '';

drop function if exists public.ai_log_usage(uuid, text, text, uuid, uuid, uuid, uuid, text, integer, integer, integer, integer,
 integer, numeric);
create or replace function public.ai_log_usage(p_company uuid, p_module text, p_kind text, p_client uuid, p_contract uuid,
 p_project uuid, p_recording uuid, p_model text, p_input integer, p_output integer, p_cache_read integer,
 p_cache_write integer, p_embedding integer, p_cost numeric, p_provider uuid default null) returns void
language plpgsql security definer set search_path = '' as $$
declare v_name text := ''; begin
 if not mavi_private.member(p_company) then raise exception 'Sem permissão.' using errcode = '42501'; end if;
 if p_client is not null and not mavi_private.drive_can_read(p_company, p_client) then
  raise exception 'Sem permissão.' using errcode = '42501';
 end if;
 if p_module = 'mcp' and not mavi_private.mcp_allowed(p_company) then
  raise exception 'Sem permissão.' using errcode = '42501';
 end if;
 if p_cost is null or p_cost < 0 or p_cost > 100 then raise exception 'Custo inválido.' using errcode = '22023'; end if;
 if p_provider is not null then
  select p.name into v_name from mavi_private.ai_providers p where p.id = p_provider and p.company_id = p_company;
  if v_name is null then raise exception 'Provedor inválido.' using errcode = '22023'; end if;
 end if;
 insert into public.ai_usage(company_id, module, kind, client_id, contract_id, project_id, recording_id, model,
  input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, embedding_tokens, cost_usd, provider_id,
  provider_name)
 values (p_company, left(coalesce(p_module, ''), 40), left(coalesce(p_kind, ''), 40), p_client, p_contract,
  p_project, p_recording, left(coalesce(p_model, ''), 80), greatest(coalesce(p_input, 0), 0),
  greatest(coalesce(p_output, 0), 0), greatest(coalesce(p_cache_read, 0), 0),
  greatest(coalesce(p_cache_write, 0), 0), greatest(coalesce(p_embedding, 0), 0), p_cost, p_provider, v_name);
end $$;
revoke all on function public.ai_log_usage(uuid, text, text, uuid, uuid, uuid, uuid, text, integer, integer, integer,
 integer, integer, numeric, uuid) from public, anon;
grant execute on function public.ai_log_usage(uuid, text, text, uuid, uuid, uuid, uuid, text, integer, integer, integer,
 integer, integer, numeric, uuid) to authenticated;

-- O painel ganha a divisão por provedor e modelo.
create or replace function public.ai_usage_report(p_company uuid, p_from date, p_to date) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_from timestamptz; v_to timestamptz; v_start timestamptz := mavi_private.ai_month_start(); begin
 if not mavi_private.leader(p_company) then raise exception 'Sem permissão.' using errcode = '42501'; end if;
 v_from := p_from::timestamp at time zone 'America/Sao_Paulo';
 v_to := (p_to + 1)::timestamp at time zone 'America/Sao_Paulo';
 return (with u as (
   select * from public.ai_usage where company_id = p_company and created_at >= v_from and created_at < v_to)
  select jsonb_build_object(
   'total', (select jsonb_build_object('cost', coalesce(sum(cost_usd), 0),
     'asks', count(*) filter (where kind = 'ask'),
     'index_cost', coalesce(sum(cost_usd) filter (where kind = 'index'), 0),
     'input_tokens', coalesce(sum(input_tokens), 0), 'output_tokens', coalesce(sum(output_tokens), 0),
     'embedding_tokens', coalesce(sum(embedding_tokens), 0)) from u),
   'by_user', (select coalesce(jsonb_agg(x order by x.cost desc), '[]') from (
     select user_id as id, sum(cost_usd) as cost, count(*) filter (where kind = 'ask') as asks
     from u where user_id is not null group by user_id) x),
   'by_client', (select coalesce(jsonb_agg(x order by x.cost desc), '[]') from (
     select client_id as id, sum(cost_usd) as cost, count(*) filter (where kind = 'ask') as asks
     from u where client_id is not null group by client_id) x),
   'by_contract', (select coalesce(jsonb_agg(x order by x.cost desc), '[]') from (
     select contract_id as id, sum(cost_usd) as cost, count(*) filter (where kind = 'ask') as asks
     from u where contract_id is not null group by contract_id) x),
   'by_project', (select coalesce(jsonb_agg(x order by x.cost desc), '[]') from (
     select project_id as id, sum(cost_usd) as cost, count(*) filter (where kind = 'ask') as asks
     from u where project_id is not null group by project_id) x),
   'by_module', (select coalesce(jsonb_agg(x order by x.cost desc), '[]') from (
     select module as id, sum(cost_usd) as cost, count(*) filter (where kind = 'ask') as asks
     from u group by module) x),
   'by_model', (select coalesce(jsonb_agg(x order by x.cost desc), '[]') from (
     select provider_name || '|' || model as id, provider_name as provider, model, sum(cost_usd) as cost,
      count(*) filter (where kind = 'ask') as asks,
      sum(input_tokens + cache_read_tokens + cache_write_tokens) as input_tokens, sum(output_tokens) as output_tokens
     from u group by provider_name, model) x),
   'by_day', (select coalesce(jsonb_agg(x order by x.day), '[]') from (
     select to_char(created_at at time zone 'America/Sao_Paulo', 'YYYY-MM-DD') as day, sum(cost_usd) as cost,
      count(*) filter (where kind = 'ask') as asks
     from u group by 1) x),
   'limits', (select coalesce(jsonb_agg(jsonb_build_object('type', l.scope_type, 'id', l.scope_id,
      'monthly_usd', l.monthly_usd, 'month_spent', (
       select coalesce(sum(a.cost_usd), 0) from public.ai_usage a
       where a.company_id = p_company and a.created_at >= v_start and case l.scope_type
        when 'company' then true when 'user' then a.user_id = l.scope_id when 'client' then a.client_id = l.scope_id
        when 'contract' then a.contract_id = l.scope_id else a.project_id = l.scope_id end))
      order by l.scope_type), '[]') from public.ai_limits l where l.company_id = p_company)));
end $$;

commit;
