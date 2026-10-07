begin;

-- MAVI · roteador de modelos, fase 2 (pedido de 06/10/2026): o roteador
-- passa a escolher, com as travas que o administrador configura.
--
-- 1. ai_router_settings (uma linha por empresa): o modo (sombra: só
--    registra; ativo: escolhe), o nível de custo padrão (Econômico,
--    Equilibrado, Máxima qualidade) e o de cada tela, o escalonamento (refaz
--    com um modelo mais forte quando a resposta sai fraca, até um teto por
--    resposta), os provedores permitidos na empresa e os liberados para
--    clientes e produtos sigilosos. O "Servidor" (a Claude da Vercel) entra
--    nas listas pelo id 00000000-0000-0000-0000-000000000000.
-- 2. ai_router_scopes: exceções por pessoa, cliente e produto (nível,
--    provedores permitidos e, em cliente e produto, sigiloso).
-- 3. ai_routes.auto: a regra de "Quem usa qual modelo" que, em vez de
--    travar o modelo, deixa o roteador escolher (o modelo dela vale no modo
--    sombra e quando o roteador não tem candidato).
-- 4. ai_route_context: o que o roteador precisa a cada pergunta, de uma vez
--    (a política que vale para quem pergunta e onde, e os provedores
--    permitidos com a chave selada, como ai_resolve_route já devolve).
-- 5. ai_route_log aceita "auto" (com o roteador ativo) e o escalonamento.
-- 6. Histórico de alterações (20270223090000): a configuração do roteador,
--    as exceções e o "Automático" das regras entram por gatilho.

create table mavi_private.ai_router_settings (
 company_id uuid primary key references public.companies(id) on delete cascade,
 mode text not null default 'shadow' check (mode in ('shadow', 'active')),
 level text not null default 'equilibrado' check (level in ('economico', 'equilibrado', 'maxima')),
 surface_levels jsonb not null default '{}' check (jsonb_typeof(surface_levels) = 'object'),
 escalate boolean not null default true,
 escalate_cap numeric(8,4) not null default 0.5 check (escalate_cap between 0 and 20),
 providers uuid[],
 secret_providers uuid[],
 updated_by uuid default auth.uid(),
 updated_at timestamptz not null default now()
);
alter table mavi_private.ai_router_settings enable row level security;
revoke all on mavi_private.ai_router_settings from public, anon, authenticated;

create table mavi_private.ai_router_scopes (
 id uuid primary key default gen_random_uuid(),
 company_id uuid not null references public.companies(id) on delete cascade,
 scope_type text not null check (scope_type in ('user', 'client', 'contract')),
 scope_id uuid not null,
 level text check (level in ('economico', 'equilibrado', 'maxima')),
 providers uuid[],
 sigiloso boolean not null default false check (not sigiloso or scope_type in ('client', 'contract')),
 updated_by uuid default auth.uid(),
 updated_at timestamptz not null default now(),
 unique (company_id, scope_type, scope_id)
);
alter table mavi_private.ai_router_scopes enable row level security;
revoke all on mavi_private.ai_router_scopes from public, anon, authenticated;

alter table mavi_private.ai_routes add column auto boolean not null default false;

-- As telas em que se conversa com a MAVI (o nível de cada uma).
create function mavi_private.ai_router_surface(p text) returns boolean
language sql immutable set search_path = '' as $$
 select p in ('bubble', 'page', 'campaigns', 'whatsapp', 'meetings', 'meeting', 'task_search', 'dashboard',
  'tutorials', 'skill_coach', 'personal_radar', 'copilot')
$$;
revoke all on function mavi_private.ai_router_surface(text) from public, anon, authenticated;

-- A interseção das listas (nula: sem restrição).
create function mavi_private.ai_router_meet(a uuid[], b uuid[]) returns uuid[]
language sql immutable set search_path = '' as $$
 select case when a is null then b when b is null then a
  else coalesce((select array_agg(x) from unnest(a) x where x = any(b)), '{}') end
$$;
revoke all on function mavi_private.ai_router_meet(uuid[], uuid[]) from public, anon, authenticated;

-- Os provedores da lista são da empresa (ou o Servidor).
create function mavi_private.ai_router_check_providers(p_company uuid, p uuid[]) returns void
language plpgsql stable security definer set search_path = '' as $$ begin
 if p is not null and exists (select 1 from unnest(p) x where x <> '00000000-0000-0000-0000-000000000000'
   and not exists (select 1 from mavi_private.ai_providers v where v.id = x and v.company_id = p_company)) then
  raise exception 'Provedor inválido.' using errcode = '22023';
 end if;
end $$;
revoke all on function mavi_private.ai_router_check_providers(uuid, uuid[]) from public, anon, authenticated;

-- ------------------------------------------------------------ configuração
create function public.ai_router_get(p_company uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare s mavi_private.ai_router_settings; begin
 if not mavi_private.leader(p_company) then
  raise exception 'Só administradores e gestores configuram o roteador da MAVI.' using errcode = '42501';
 end if;
 select * into s from mavi_private.ai_router_settings where company_id = p_company;
 return jsonb_build_object(
  'mode', coalesce(s.mode, 'shadow'), 'level', coalesce(s.level, 'equilibrado'),
  'surface_levels', coalesce(s.surface_levels, '{}'), 'escalate', coalesce(s.escalate, true),
  'escalate_cap', coalesce(s.escalate_cap, 0.5), 'providers', to_jsonb(s.providers),
  'secret_providers', to_jsonb(s.secret_providers), 'updated_at', s.updated_at,
  'scopes', (select coalesce(jsonb_agg(jsonb_build_object('type', x.scope_type, 'scope_id', x.scope_id,
    'level', x.level, 'providers', to_jsonb(x.providers), 'sigiloso', x.sigiloso, 'updated_at', x.updated_at)
    order by x.scope_type, x.updated_at), '[]') from mavi_private.ai_router_scopes x where x.company_id = p_company));
end $$;
revoke all on function public.ai_router_get(uuid) from public, anon;
grant execute on function public.ai_router_get(uuid) to authenticated;

-- Salva a configuração (os campos que vierem; os outros ficam como estão).
create function public.ai_router_save(p_company uuid, p_settings jsonb) returns void
language plpgsql security definer set search_path = '' as $$
declare s jsonb := coalesce(p_settings, '{}'); v_levels jsonb; k text;
 v_providers uuid[]; v_secret uuid[]; begin
 if not mavi_private.leader(p_company) then
  raise exception 'Só administradores e gestores configuram o roteador da MAVI.' using errcode = '42501';
 end if;
 if s ? 'surface_levels' then
  v_levels := coalesce(s->'surface_levels', '{}');
  if jsonb_typeof(v_levels) <> 'object' then raise exception 'Níveis por tela inválidos.' using errcode = '22023'; end if;
  for k in select jsonb_object_keys(v_levels) loop
   if not mavi_private.ai_router_surface(k) or v_levels->>k not in ('economico', 'equilibrado', 'maxima') then
    raise exception 'Nível inválido para a tela %.', k using errcode = '22023';
   end if;
  end loop;
 end if;
 if s ? 'providers' and jsonb_typeof(s->'providers') = 'array' then
  v_providers := array(select x::uuid from jsonb_array_elements_text(s->'providers') x);
  if cardinality(v_providers) = 0 then
   raise exception 'Deixe pelo menos um provedor permitido.' using errcode = '22023';
  end if;
 end if;
 if s ? 'secret_providers' and jsonb_typeof(s->'secret_providers') = 'array' then
  v_secret := array(select x::uuid from jsonb_array_elements_text(s->'secret_providers') x);
 end if;
 perform mavi_private.ai_router_check_providers(p_company, v_providers);
 perform mavi_private.ai_router_check_providers(p_company, v_secret);
 insert into mavi_private.ai_router_settings(company_id) values (p_company) on conflict do nothing;
 update mavi_private.ai_router_settings set
  mode = case when s ? 'mode' then s->>'mode' else mode end,
  level = case when s ? 'level' then s->>'level' else level end,
  surface_levels = case when s ? 'surface_levels' then v_levels else surface_levels end,
  escalate = case when s ? 'escalate' then (s->>'escalate')::boolean else escalate end,
  escalate_cap = case when s ? 'escalate_cap' then (s->>'escalate_cap')::numeric else escalate_cap end,
  providers = case when s ? 'providers' then v_providers else providers end,
  secret_providers = case when s ? 'secret_providers' then v_secret else secret_providers end,
  updated_by = auth.uid(), updated_at = now()
 where company_id = p_company;
end $$;
revoke all on function public.ai_router_save(uuid, jsonb) from public, anon;
grant execute on function public.ai_router_save(uuid, jsonb) to authenticated;

-- Uma exceção de pessoa, cliente ou produto (tudo vazio: tira a exceção).
create function public.ai_router_scope_save(p_company uuid, p_type text, p_id uuid, p_level text,
 p_providers uuid[], p_sigiloso boolean) returns void
language plpgsql security definer set search_path = '' as $$ begin
 if not mavi_private.leader(p_company) then
  raise exception 'Só administradores e gestores configuram o roteador da MAVI.' using errcode = '42501';
 end if;
 if p_type not in ('user', 'client', 'contract') or p_id is null then
  raise exception 'As exceções valem para pessoas, clientes e produtos.' using errcode = '22023';
 end if;
 if coalesce(p_sigiloso, false) and p_type = 'user' then
  raise exception 'Sigiloso vale para clientes e produtos.' using errcode = '22023';
 end if;
 if p_providers is not null and cardinality(p_providers) = 0 then
  raise exception 'Deixe pelo menos um provedor permitido.' using errcode = '22023';
 end if;
 if p_type = 'user' and not exists (select 1 from public.memberships where company_id = p_company and user_id = p_id)
  or p_type = 'client' and not exists (select 1 from public.clients where company_id = p_company and id = p_id)
  or p_type = 'contract' and not exists (select 1 from public.contracts where company_id = p_company and id = p_id) then
  raise exception 'Não encontrado na empresa.' using errcode = 'P0002';
 end if;
 perform mavi_private.ai_router_check_providers(p_company, p_providers);
 if p_level is null and p_providers is null and not coalesce(p_sigiloso, false) then
  delete from mavi_private.ai_router_scopes where company_id = p_company and scope_type = p_type and scope_id = p_id;
  return;
 end if;
 insert into mavi_private.ai_router_scopes(company_id, scope_type, scope_id, level, providers, sigiloso)
 values (p_company, p_type, p_id, p_level, p_providers, coalesce(p_sigiloso, false))
 on conflict (company_id, scope_type, scope_id) do update set level = excluded.level,
  providers = excluded.providers, sigiloso = excluded.sigiloso, updated_by = auth.uid(), updated_at = now();
end $$;
revoke all on function public.ai_router_scope_save(uuid, text, uuid, text, uuid[], boolean) from public, anon;
grant execute on function public.ai_router_scope_save(uuid, text, uuid, text, uuid[], boolean) to authenticated;

-- "Automático" numa regra de "Quem usa qual modelo".
create function public.ai_set_route_auto(p_company uuid, p_type text, p_id uuid, p_feature text, p_auto boolean)
returns void
language plpgsql security definer set search_path = '' as $$ begin
 if not mavi_private.leader(p_company) then
  raise exception 'Só administradores e gestores escolhem qual IA cada um usa.' using errcode = '42501';
 end if;
 if p_type not in ('user', 'client', 'contract', 'project', 'feature') then
  raise exception 'O automático vale para as regras de funcionalidade, pessoa, cliente, produto e projeto.'
   using errcode = '22023';
 end if;
 update mavi_private.ai_routes set auto = coalesce(p_auto, false), updated_by = auth.uid(), updated_at = now()
 where company_id = p_company and scope_type = p_type
  and scope_id is not distinct from case when p_type = 'feature' then null else p_id end
  and feature is not distinct from case when p_type = 'feature' then p_feature end;
 if not found then
  raise exception 'Escolha o provedor e o modelo da regra antes.' using errcode = 'P0002';
 end if;
end $$;
revoke all on function public.ai_set_route_auto(uuid, text, uuid, text, boolean) from public, anon;
grant execute on function public.ai_set_route_auto(uuid, text, uuid, text, boolean) to authenticated;

-- ------------------------------------------------------------ a cada pergunta
-- A política que vale para quem pergunta, no cliente/produto/projeto e na
-- tela, e os provedores permitidos (com a chave selada). O nível segue a
-- ordem das regras de modelo: produto › cliente › pessoa › tela › empresa.
create function public.ai_route_context(p_company uuid, p_client uuid, p_contract uuid, p_project uuid,
 p_surface text default null) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_client uuid := p_client; v_contract uuid := p_contract; s mavi_private.ai_router_settings;
 u mavi_private.ai_router_scopes; c mavi_private.ai_router_scopes; k mavi_private.ai_router_scopes;
 v_allowed uuid[]; v_sig boolean; v_level text; begin
 if not mavi_private.member(p_company) then raise exception 'Sem acesso ao espaço' using errcode = '42501'; end if;
 if p_project is not null then
  select coalesce(pr.contract_id, v_contract) into v_contract from public.projects pr
  where pr.id = p_project and pr.company_id = p_company;
 end if;
 if v_contract is not null then
  select coalesce(x.client_id, v_client) into v_client from public.contracts x
  where x.id = v_contract and x.company_id = p_company;
 end if;
 if v_client is not null and not mavi_private.drive_can_read(p_company, v_client) then
  v_client := null; v_contract := null;
 end if;
 select * into s from mavi_private.ai_router_settings where company_id = p_company;
 select * into u from mavi_private.ai_router_scopes where company_id = p_company and scope_type = 'user' and scope_id = auth.uid();
 select * into c from mavi_private.ai_router_scopes where company_id = p_company and scope_type = 'client' and scope_id = v_client;
 select * into k from mavi_private.ai_router_scopes where company_id = p_company and scope_type = 'contract' and scope_id = v_contract;
 v_level := coalesce(k.level, c.level, u.level,
  case when mavi_private.ai_router_surface(p_surface) then s.surface_levels->>p_surface end, s.level, 'equilibrado');
 v_allowed := mavi_private.ai_router_meet(mavi_private.ai_router_meet(mavi_private.ai_router_meet(s.providers, u.providers),
  c.providers), k.providers);
 v_sig := coalesce(c.sigiloso, false) or coalesce(k.sigiloso, false);
 if v_sig then v_allowed := mavi_private.ai_router_meet(v_allowed, s.secret_providers); end if;
 return jsonb_build_object(
  'mode', coalesce(s.mode, 'shadow'), 'level', v_level, 'escalate', coalesce(s.escalate, true),
  'escalate_cap', coalesce(s.escalate_cap, 0.5), 'sigiloso', v_sig, 'restricted', v_allowed is not null,
  'server', v_allowed is null or '00000000-0000-0000-0000-000000000000'::uuid = any(v_allowed),
  'candidates', (select coalesce(jsonb_agg(jsonb_build_object('provider_id', p.id, 'name', p.name, 'kind', p.kind,
    'base_url', p.base_url, 'key_cipher', p.key_cipher, 'models', p.models) order by p.name), '[]')
   from mavi_private.ai_providers p
   where p.company_id = p_company and p.active and (v_allowed is null or p.id = any(v_allowed))));
end $$;
revoke all on function public.ai_route_context(uuid, uuid, uuid, uuid, text) from public, anon;
grant execute on function public.ai_route_context(uuid, uuid, uuid, uuid, text) to authenticated;

-- A da migração 20270519090000, com o "Automático" da regra.
create or replace function public.ai_resolve_route(p_company uuid, p_client uuid, p_contract uuid, p_project uuid,
 p_feature text default null) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_contract uuid := p_contract; v_client uuid := p_client; v_feature text := coalesce(p_feature, 'assistant');
 v_talk boolean; v_own boolean; r record; begin
 if not mavi_private.member(p_company) then raise exception 'Sem acesso ao espaço' using errcode = '42501'; end if;
 v_talk := v_feature in ('assistant', 'mavi_page', 'meetings_history', 'meetings_ask', 'whatsapp_history');
 v_own := mavi_private.ai_own_model_feature(v_feature);
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
 select rt.scope_type, rt.model, rt.effort, rt.auto, p.id, p.name, p.kind, p.base_url, p.key_cipher, p.models into r
 from mavi_private.ai_routes rt join mavi_private.ai_providers p on p.id = rt.provider_id and p.active
 where rt.company_id = p_company and (
   (v_talk and (
    (rt.scope_type = 'project' and rt.scope_id = p_project and v_contract is not distinct from
      (select pr.contract_id from public.projects pr where pr.id = p_project))
    or (rt.scope_type = 'contract' and rt.scope_id = v_contract)
    or (rt.scope_type = 'client' and rt.scope_id = v_client)
    or (rt.scope_type = 'user' and rt.scope_id = auth.uid())))
   or (rt.scope_type = 'feature' and (rt.feature = v_feature
    -- O módulo MAVI sem regra própria segue a da bolinha.
    or (v_feature = 'mavi_page' and rt.feature = 'assistant')))
   or (rt.scope_type = 'company' and not v_own))
 order by case rt.scope_type when 'project' then 1 when 'contract' then 2 when 'client' then 3
  when 'user' then 4 when 'feature' then 5 else 6 end,
  case when rt.feature = v_feature then 0 else 1 end
 limit 1;
 if not found then return null; end if;
 return jsonb_build_object('scope', r.scope_type, 'provider_id', r.id, 'provider', r.name, 'kind', r.kind,
  'base_url', r.base_url, 'key_cipher', r.key_cipher, 'model', r.model, 'effort', r.effort, 'auto', r.auto,
  'price', (select m from jsonb_array_elements(r.models) m where m->>'id' = r.model limit 1));
end $$;

-- A da migração 20270519090000, com o "Automático" de cada regra.
create or replace function public.ai_provider_list(p_company uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$ begin
 if not mavi_private.leader(p_company) then
  raise exception 'Só administradores e gestores veem os provedores da MAVI.' using errcode = '42501';
 end if;
 return jsonb_build_object(
  'providers', (select coalesce(jsonb_agg(jsonb_build_object('id', p.id, 'name', p.name, 'kind', p.kind,
     'base_url', p.base_url, 'key_hint', p.key_hint, 'models', p.models, 'active', p.active,
     'updated_at', p.updated_at, 'routes', (select count(*) from mavi_private.ai_routes r where r.provider_id = p.id))
    order by p.name), '[]') from mavi_private.ai_providers p where p.company_id = p_company),
  'routes', (select coalesce(jsonb_agg(jsonb_build_object('id', r.id, 'type', r.scope_type, 'scope_id', r.scope_id,
     'feature', r.feature, 'provider_id', r.provider_id, 'model', r.model, 'effort', r.effort, 'auto', r.auto,
     'updated_at', r.updated_at)
    order by r.scope_type, r.updated_at), '[]') from mavi_private.ai_routes r where r.company_id = p_company),
  'efforts', (select coalesce(jsonb_object_agg(e.key, e.effort), '{}') from mavi_private.ai_efforts e
   where e.company_id = p_company));
end $$;

-- A da migração 20270528090000: "auto" vale com o roteador ativo; o escalonamento fica marcado.
create or replace function public.ai_route_log(p_company uuid, p_entry jsonb) returns bigint
language plpgsql security definer set search_path = '' as $$
declare e jsonb := coalesce(p_entry, '{}'); v_client uuid; v_conv uuid; v_used uuid; v_sugg uuid;
 v_active boolean; v_mode text; v_id bigint; begin
 if not mavi_private.member(p_company) then raise exception 'Sem permissão.' using errcode = '42501'; end if;
 v_client := nullif(e->>'client_id', '')::uuid;
 v_conv := nullif(e->>'conversation_id', '')::uuid;
 v_used := nullif(e->>'used_provider_id', '')::uuid;
 v_sugg := nullif(e->>'suggested_provider_id', '')::uuid;
 if v_client is not null and not mavi_private.drive_can_read(p_company, v_client) then
  raise exception 'Sem permissão.' using errcode = '42501';
 end if;
 if v_conv is not null and not exists (select 1 from public.ai_conversations c
  where c.id = v_conv and c.company_id = p_company and c.owner_id = auth.uid()) then
  raise exception 'Conversa inválida.' using errcode = '22023';
 end if;
 if (e->>'message_id') is not null and (v_conv is null or not exists (select 1 from public.ai_messages m
  where m.id = (e->>'message_id')::bigint and m.conversation_id = v_conv and m.role = 'assistant')) then
  raise exception 'Mensagem inválida.' using errcode = '22023';
 end if;
 if exists (select 1 from unnest(array[v_used, v_sugg]) x(id) where x.id is not null
  and not exists (select 1 from mavi_private.ai_providers p where p.id = x.id and p.company_id = p_company)) then
  raise exception 'Provedor inválido.' using errcode = '22023';
 end if;
 v_active := coalesce((select s.mode = 'active' from mavi_private.ai_router_settings s where s.company_id = p_company), false);
 v_mode := case when e->>'mode' = 'locked' then 'locked' when e->>'mode' = 'auto' and v_active then 'auto' else 'shadow' end;
 insert into public.ai_route_decisions(company_id, surface, feature, client_id, conversation_id, message_id,
  task_type, complexity, modalities, context_tokens, latency_class, why, mode, locked_by, need_tier,
  suggested_provider_id, suggested_model, reason, candidates, used_provider_id, used_model, first_token_ms,
  total_ms, rounds, cost_usd, tools_ok, tools_failed, capped, escalated, error)
 values (p_company, left(coalesce(e->>'surface', ''), 40), left(coalesce(e->>'feature', ''), 60), v_client, v_conv,
  (e->>'message_id')::bigint, e->>'task_type', (e->>'complexity')::smallint,
  coalesce((select array_agg(x) from jsonb_array_elements_text(e->'modalities') x), '{text}'),
  greatest(coalesce((e->>'context_tokens')::integer, 0), 0), coalesce(e->>'latency_class', 'normal'),
  coalesce((select array_agg(left(x, 120)) from (select x from jsonb_array_elements_text(e->'why') x limit 12) w), '{}'),
  v_mode, case when v_mode = 'locked' then e->>'locked_by' end, (e->>'need_tier')::smallint, v_sugg,
  left(e->>'suggested_model', 120), left(coalesce(e->>'reason', ''), 500),
  case when jsonb_typeof(e->'candidates') = 'array' then
   (select coalesce(jsonb_agg(c), '[]') from (select c from jsonb_array_elements(e->'candidates') c limit 12) t)
  else '[]' end,
  v_used, left(coalesce(e->>'used_model', ''), 120),
  case when (e->>'first_token_ms') is not null then greatest((e->>'first_token_ms')::integer, 0) end,
  greatest(coalesce((e->>'total_ms')::integer, 0), 0),
  least((e->>'rounds')::integer, 999)::smallint, least(greatest(coalesce((e->>'cost_usd')::numeric, 0), 0), 100),
  least(greatest(coalesce((e->>'tools_ok')::integer, 0), 0), 999), least(greatest(coalesce((e->>'tools_failed')::integer, 0), 0), 999),
  coalesce((e->>'capped')::boolean, false), coalesce((e->>'escalated')::boolean, false), left(e->>'error', 300))
 returning id into v_id;
 return v_id;
end $$;

-- Para o painel: as últimas decisões, com o porquê (líderes).
create function public.ai_route_recent(p_company uuid, p_limit integer default 50) returns jsonb
language plpgsql stable security definer set search_path = '' as $$ begin
 if not mavi_private.leader(p_company) then
  raise exception 'Só administradores e gestores veem o desempenho dos modelos.' using errcode = '42501';
 end if;
 return (select coalesce(jsonb_agg(jsonb_build_object('id', d.id, 'at', d.created_at, 'user_id', d.user_id,
   'surface', d.surface, 'task_type', d.task_type, 'complexity', d.complexity, 'mode', d.mode,
   'locked_by', d.locked_by, 'suggested_model', d.suggested_model, 'used_model', d.used_model, 'reason', d.reason,
   'first_token_ms', d.first_token_ms, 'total_ms', d.total_ms, 'cost_usd', d.cost_usd, 'tools_failed', d.tools_failed,
   'escalated', d.escalated, 'error', d.error, 'conversation_id', d.conversation_id) order by d.id desc), '[]')
  from (select * from public.ai_route_decisions x where x.company_id = p_company
   order by x.id desc limit least(greatest(coalesce(p_limit, 50), 1), 200)) d);
end $$;
revoke all on function public.ai_route_recent(uuid, integer) from public, anon;
grant execute on function public.ai_route_recent(uuid, integer) to authenticated;

-- ------------------------------------------------------------ histórico
alter table mavi_private.ai_settings_log drop constraint ai_settings_log_area_check;
alter table mavi_private.ai_settings_log add constraint ai_settings_log_area_check
 check (area in ('company', 'feature', 'skill', 'user', 'client', 'contract', 'project', 'animation', 'provider',
  'router'));
alter table mavi_private.ai_settings_log drop constraint ai_settings_log_field_check;
alter table mavi_private.ai_settings_log add constraint ai_settings_log_field_check
 check (field in ('model', 'effort', 'provider', 'name', 'kind', 'base_url', 'active', 'key', 'models', 'knowledge',
  'access', 'auto', 'mode', 'level', 'surface_levels', 'escalate', 'escalate_cap', 'providers', 'secret_providers',
  'sigiloso'));

create function mavi_private.ai_router_settings_log() returns trigger
language plpgsql security definer set search_path = '' as $$
declare f text; v_old jsonb; v_new jsonb; o jsonb; n jsonb; begin
 if not exists (select 1 from public.companies where id = new.company_id) then return null; end if;
 o := case when tg_op = 'INSERT' then null else to_jsonb(old) end;
 n := to_jsonb(new);
 foreach f in array array['mode', 'level', 'surface_levels', 'escalate', 'escalate_cap', 'providers', 'secret_providers'] loop
  v_old := o->f; v_new := n->f;
  -- A linha nasce com os padrões: só o que mudou de verdade entra.
  if tg_op = 'INSERT' then
   continue when v_new = to_jsonb(case f when 'mode' then 'shadow'::text when 'level' then 'equilibrado' end)
    or (f = 'surface_levels' and v_new = '{}') or (f = 'escalate' and v_new = 'true')
    or (f = 'escalate_cap' and (v_new)::numeric = 0.5) or v_new is null or v_new = 'null';
  end if;
  continue when v_old is not distinct from v_new;
  perform mavi_private.ai_log(new.company_id, 'router', '', '', f,
   case when tg_op = 'INSERT' then 'created' else 'changed' end,
   case when v_old is null then null else jsonb_build_object(f, v_old) end, jsonb_build_object(f, v_new));
 end loop;
 return null;
end $$;
revoke all on function mavi_private.ai_router_settings_log() from public, anon, authenticated;
create trigger ai_router_settings_log after insert or update on mavi_private.ai_router_settings
 for each row execute function mavi_private.ai_router_settings_log();

create function mavi_private.ai_router_scopes_log() returns trigger
language plpgsql security definer set search_path = '' as $$
declare r mavi_private.ai_router_scopes; f text; o jsonb; n jsonb; begin
 if tg_op = 'DELETE' then r := old; else r := new; end if;
 if not exists (select 1 from public.companies where id = r.company_id) then return null; end if;
 o := case when tg_op = 'INSERT' then '{}' else to_jsonb(old) end;
 n := case when tg_op = 'DELETE' then '{}' else to_jsonb(new) end;
 foreach f in array array['level', 'providers', 'sigiloso'] loop
  continue when coalesce(o->f, 'null') = coalesce(n->f, 'null')
   or (f = 'sigiloso' and coalesce(o->>f, 'false') = coalesce(n->>f, 'false'));
  perform mavi_private.ai_log(r.company_id, r.scope_type, r.scope_id::text,
   mavi_private.ai_log_subject(r.company_id, r.scope_type, r.scope_id), f,
   case when coalesce(o->f, 'null') in ('null', 'false') then 'created'
    when coalesce(n->f, 'null') in ('null', 'false') then 'removed' else 'changed' end,
   case when coalesce(o->f, 'null') in ('null', 'false') then null else jsonb_build_object(f, o->f) end,
   case when coalesce(n->f, 'null') in ('null', 'false') then null else jsonb_build_object(f, n->f) end);
 end loop;
 return null;
end $$;
revoke all on function mavi_private.ai_router_scopes_log() from public, anon, authenticated;
create trigger ai_router_scopes_log after insert or update or delete on mavi_private.ai_router_scopes
 for each row execute function mavi_private.ai_router_scopes_log();

-- O "Automático" da regra é um campo à parte (o gatilho do modelo não olha).
create function mavi_private.ai_routes_auto_log() returns trigger
language plpgsql security definer set search_path = '' as $$ begin
 if old.auto is not distinct from new.auto then return null; end if;
 if not exists (select 1 from public.companies where id = new.company_id) then return null; end if;
 perform mavi_private.ai_log(new.company_id, new.scope_type,
  case when new.scope_type = 'feature' then new.feature else coalesce(new.scope_id::text, '') end,
  case when new.scope_type in ('company', 'feature') then '' else mavi_private.ai_log_subject(new.company_id, new.scope_type, new.scope_id) end,
  'auto', 'changed', jsonb_build_object('auto', old.auto), jsonb_build_object('auto', new.auto));
 return null;
end $$;
revoke all on function mavi_private.ai_routes_auto_log() from public, anon, authenticated;
create trigger ai_routes_auto_log after update on mavi_private.ai_routes
 for each row execute function mavi_private.ai_routes_auto_log();

commit;
