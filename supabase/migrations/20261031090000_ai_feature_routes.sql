begin;

-- MAVI · provedor e modelo por funcionalidade.
--
-- Cada funcionalidade com IA (assistente, perguntas às gravações, tarefa a
-- partir do WhatsApp, plano/ajuste/briefing/cores do Social Leads) pode ter o
-- seu provedor e modelo da biblioteca, em vez de usar sempre o padrão da
-- Vercel (ANTHROPIC_API_KEY e AI_MODEL / MEETINGS_MODEL / SOCIAL_LEADS_MODEL /
-- WHATSAPP_TASK_MODEL). A regra da funcionalidade é uma linha de ai_routes com
-- scope_type 'feature' e o nome dela em feature.
--
-- Ordem de quem responde:
-- - nas conversas com a MAVI (assistente, histórico das gravações e pergunta
--   a uma reunião): projeto › produto › cliente › pessoa › funcionalidade ›
--   empresa › servidor;
-- - nas demais funcionalidades: funcionalidade › empresa › servidor.
--
-- As chamadas de antes (ai_resolve_route com 4 argumentos e ai_set_route com
-- 5) continuam valendo: o argumento novo tem padrão nulo.

alter table mavi_private.ai_routes add column if not exists feature text;

-- As restrições antigas têm nomes gerados; troca todas por nomes fixos.
do $$ declare c record; begin
 for c in select conname from pg_constraint
  where conrelid = 'mavi_private.ai_routes'::regclass and contype in ('c', 'u')
 loop
  execute format('alter table mavi_private.ai_routes drop constraint %I', c.conname);
 end loop;
end $$;
alter table mavi_private.ai_routes
 add constraint ai_routes_scope_type_check
  check (scope_type in ('company', 'user', 'client', 'contract', 'project', 'feature')),
 add constraint ai_routes_scope_check check ((scope_type in ('company', 'feature')) = (scope_id is null)),
 add constraint ai_routes_feature_check check ((scope_type = 'feature') = (feature is not null)
  and (feature is null or feature in ('assistant', 'meetings_history', 'meetings_ask', 'whatsapp_task',
   'social_leads_plan', 'social_leads_adjust', 'social_leads_briefing', 'social_leads_colors'))),
 add constraint ai_routes_model_check check (length(model) between 1 and 120),
 add constraint ai_routes_scope_key unique nulls not distinct (company_id, scope_type, scope_id, feature);

-- A biblioteca passa a trazer a funcionalidade de cada regra.
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
     'feature', r.feature, 'provider_id', r.provider_id, 'model', r.model, 'updated_at', r.updated_at)
    order by r.scope_type, r.updated_at), '[]') from mavi_private.ai_routes r where r.company_id = p_company));
end $$;

-- Uma regra: p_provider nulo tira a regra (volta a valer a menos específica).
-- Para uma funcionalidade: p_type 'feature', p_id nulo e o nome em p_feature.
drop function if exists public.ai_set_route(uuid, text, uuid, uuid, text);
create or replace function public.ai_set_route(p_company uuid, p_type text, p_id uuid, p_provider uuid, p_model text,
 p_feature text default null) returns void
language plpgsql security definer set search_path = '' as $$
declare v_id uuid := case when p_type in ('company', 'feature') then null else p_id end;
 v_feature text := case when p_type = 'feature' then p_feature end; begin
 if not mavi_private.admin(p_company) then
  raise exception 'Só administradores escolhem qual IA cada um usa.' using errcode = '42501';
 end if;
 if p_type not in ('company', 'user', 'client', 'contract', 'project', 'feature') then
  raise exception 'Tipo inválido.' using errcode = '22023';
 end if;
 if p_type not in ('company', 'feature') and p_id is null then
  raise exception 'Escolha para quem vale a regra.' using errcode = '22023';
 end if;
 if p_type = 'feature' and coalesce(v_feature, '') not in ('assistant', 'meetings_history', 'meetings_ask',
  'whatsapp_task', 'social_leads_plan', 'social_leads_adjust', 'social_leads_briefing', 'social_leads_colors') then
  raise exception 'Funcionalidade inválida.' using errcode = '22023';
 end if;
 if p_provider is null then
  delete from mavi_private.ai_routes where company_id = p_company and scope_type = p_type
   and scope_id is not distinct from v_id and feature is not distinct from v_feature;
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
 insert into mavi_private.ai_routes(company_id, scope_type, scope_id, feature, provider_id, model)
 values (p_company, p_type, v_id, v_feature, p_provider, p_model)
 on conflict on constraint ai_routes_scope_key do update set provider_id = excluded.provider_id,
  model = excluded.model, updated_by = auth.uid(), updated_at = now();
end $$;

-- Qual IA responde: a regra mais específica que vale para quem pede, onde e
-- em qual funcionalidade. As regras de pessoa, cliente, produto e projeto só
-- valem nas conversas (p_feature nulo é o assistente, como antes). Só
-- provedores ativos. Nulo: o padrão do servidor. A chave vem selada.
drop function if exists public.ai_resolve_route(uuid, uuid, uuid, uuid);
create or replace function public.ai_resolve_route(p_company uuid, p_client uuid, p_contract uuid, p_project uuid,
 p_feature text default null) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_contract uuid := p_contract; v_client uuid := p_client; v_feature text := coalesce(p_feature, 'assistant');
 v_talk boolean; r record; begin
 if not mavi_private.member(p_company) then raise exception 'Sem acesso ao espaço' using errcode = '42501'; end if;
 v_talk := v_feature in ('assistant', 'meetings_history', 'meetings_ask');
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
   (v_talk and (
    (rt.scope_type = 'project' and rt.scope_id = p_project and v_contract is not distinct from
      (select pr.contract_id from public.projects pr where pr.id = p_project))
    or (rt.scope_type = 'contract' and rt.scope_id = v_contract)
    or (rt.scope_type = 'client' and rt.scope_id = v_client)
    or (rt.scope_type = 'user' and rt.scope_id = auth.uid())))
   or (rt.scope_type = 'feature' and rt.feature = v_feature)
   or rt.scope_type = 'company')
 order by case rt.scope_type when 'project' then 1 when 'contract' then 2 when 'client' then 3
  when 'user' then 4 when 'feature' then 5 else 6 end
 limit 1;
 if not found then return null; end if;
 return jsonb_build_object('scope', r.scope_type, 'provider_id', r.id, 'provider', r.name, 'kind', r.kind,
  'base_url', r.base_url, 'key_cipher', r.key_cipher, 'model', r.model,
  'price', (select m from jsonb_array_elements(r.models) m where m->>'id' = r.model limit 1));
end $$;

revoke all on function public.ai_provider_list(uuid), public.ai_set_route(uuid, text, uuid, uuid, text, text),
 public.ai_resolve_route(uuid, uuid, uuid, uuid, text) from public, anon;
grant execute on function public.ai_provider_list(uuid), public.ai_set_route(uuid, text, uuid, uuid, text, text),
 public.ai_resolve_route(uuid, uuid, uuid, uuid, text) to authenticated;

commit;
