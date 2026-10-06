begin;

-- Painel da MAVI › Quem usa qual modelo: o esforço também nas regras de
-- pessoas, clientes, produtos e projetos.
--
-- O esforço fica na própria regra (ai_routes.effort): vale quando é ela que
-- escolhe quem responde e, sem escolha, segue o esforço da funcionalidade
-- (ai_efforts). Trocar o modelo da regra mantém o esforço; tirar a regra
-- leva os dois. Com uma skill carregada, continua valendo o esforço da skill.
--
-- ai_resolve_route é a da migração 20261228090000 e ai_provider_list a da
-- 20261223090000, agora com o esforço da regra. O histórico de alterações
-- (20270223090000) ganha o campo "esforço" das regras por gatilho.

alter table mavi_private.ai_routes add column effort text
 check (effort in ('low', 'medium', 'high', 'xhigh', 'max'));

-- O esforço de uma regra de pessoa, cliente, produto ou projeto (nulo: o da
-- funcionalidade).
create function public.ai_set_route_effort(p_company uuid, p_type text, p_id uuid, p_effort text) returns void
language plpgsql security definer set search_path = '' as $$ begin
 if not mavi_private.leader(p_company) then
  raise exception 'Só administradores e gestores escolhem o esforço da MAVI.' using errcode = '42501';
 end if;
 if p_type not in ('user', 'client', 'contract', 'project') or p_id is null then
  raise exception 'O esforço por regra vale para pessoas, clientes, produtos e projetos.' using errcode = '22023';
 end if;
 if p_effort is not null and p_effort not in ('low', 'medium', 'high', 'xhigh', 'max') then
  raise exception 'Esforço inválido.' using errcode = '22023';
 end if;
 update mavi_private.ai_routes set effort = p_effort, updated_by = auth.uid(), updated_at = now()
 where company_id = p_company and scope_type = p_type and scope_id = p_id;
 if not found then
  raise exception 'Escolha o provedor e o modelo da regra antes do esforço.' using errcode = 'P0002';
 end if;
end $$;
revoke all on function public.ai_set_route_effort(uuid, text, uuid, text) from public, anon;
grant execute on function public.ai_set_route_effort(uuid, text, uuid, text) to authenticated;

-- Histórico: o esforço da regra é um campo à parte do modelo (o gatilho
-- ai_routes_log só olha provedor e modelo).
create function mavi_private.ai_routes_effort_log() returns trigger
language plpgsql security definer set search_path = '' as $$
declare r mavi_private.ai_routes; v_old text; v_new text; begin
 if tg_op = 'DELETE' then r := old; else r := new; end if;
 v_old := case when tg_op = 'INSERT' then null else old.effort end;
 v_new := case when tg_op = 'DELETE' then null else new.effort end;
 if v_old is not distinct from v_new then return null; end if;
 if not exists (select 1 from public.companies where id = r.company_id) then return null; end if;
 perform mavi_private.ai_log(r.company_id, r.scope_type,
  case when r.scope_type = 'feature' then r.feature else coalesce(r.scope_id::text, '') end,
  case when r.scope_type in ('company', 'feature') then '' else mavi_private.ai_log_subject(r.company_id, r.scope_type, r.scope_id) end,
  'effort',
  case when v_old is null then 'created' when v_new is null then 'removed' else 'changed' end,
  case when v_old is null then null else jsonb_build_object('effort', v_old) end,
  case when v_new is null then null else jsonb_build_object('effort', v_new) end);
 return null;
end $$;
revoke all on function mavi_private.ai_routes_effort_log() from public, anon, authenticated;
create trigger ai_routes_effort_log after insert or update or delete on mavi_private.ai_routes
 for each row execute function mavi_private.ai_routes_effort_log();

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
 select rt.scope_type, rt.model, rt.effort, p.id, p.name, p.kind, p.base_url, p.key_cipher, p.models into r
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
  'base_url', r.base_url, 'key_cipher', r.key_cipher, 'model', r.model, 'effort', r.effort,
  'price', (select m from jsonb_array_elements(r.models) m where m->>'id' = r.model limit 1));
end $$;

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
     'feature', r.feature, 'provider_id', r.provider_id, 'model', r.model, 'effort', r.effort,
     'updated_at', r.updated_at)
    order by r.scope_type, r.updated_at), '[]') from mavi_private.ai_routes r where r.company_id = p_company),
  'efforts', (select coalesce(jsonb_object_agg(e.key, e.effort), '{}') from mavi_private.ai_efforts e
   where e.company_id = p_company));
end $$;

commit;
