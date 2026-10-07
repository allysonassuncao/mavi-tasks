begin;

-- MAVI · roteador de modelos: quais modelos o roteador pode escolher.
--
-- Painel da MAVI › Roteamento ganha a lista dos modelos permitidos no
-- roteamento, a partir dos provedores e modelos já cadastrados (e das
-- Claudes do servidor): no automático, o roteador só escolhe entre eles
-- (também na reserva e na segunda tentativa). Nula: todos os de conversa.
-- As regras travadas de "Quem usa qual modelo" continuam valendo.
--
-- O Jev (TypeSafe, pelo OpenRouter) confere e audita respostas (Termômetro,
-- autoavaliação); não escreve respostas: nunca entra na lista, nem os
-- modelos de transcrição, imagem e vetores.

alter table mavi_private.ai_router_settings add column route_models text[];

alter table mavi_private.ai_settings_log drop constraint ai_settings_log_field_check;
alter table mavi_private.ai_settings_log add constraint ai_settings_log_field_check
 check (field in ('model', 'effort', 'provider', 'name', 'kind', 'base_url', 'active', 'key', 'models', 'knowledge',
  'access', 'auto', 'mode', 'level', 'surface_levels', 'escalate', 'escalate_cap', 'providers', 'secret_providers',
  'sigiloso', 'judge_sample', 'eval_enabled', 'eval_rate', 'eval_daily_cap', 'gate_enabled', 'gate_min',
  'route_models'));

-- Cada "provedor|modelo" é um modelo de conversa cadastrado num provedor da
-- empresa, ou uma Claude do servidor.
create function mavi_private.ai_router_check_models(p_company uuid, p text[]) returns void
language plpgsql stable security definer set search_path = '' as $$
declare k text; v_provider text; v_model text; begin
 foreach k in array coalesce(p, '{}') loop
  v_provider := split_part(k, '|', 1);
  v_model := substr(k, length(v_provider) + 2);
  if v_provider !~* '^[0-9a-f-]{36}$' or v_model = '' then
   raise exception 'Modelo inválido: %.', k using errcode = '22023';
  end if;
  if v_model ~* 'typesafe/jev' then
   raise exception 'O Jev confere e audita respostas; não pode responder pela MAVI.' using errcode = '22023';
  end if;
  if v_model ~* '(transcribe|whisper|embed|image|dall-e|tts|voxtral)' then
   raise exception 'O modelo % não conversa.', v_model using errcode = '22023';
  end if;
  if v_provider = '00000000-0000-0000-0000-000000000000' then
   if v_model !~ '^claude-[a-z0-9.-]+$' then
    raise exception 'Modelo do servidor inválido: %.', v_model using errcode = '22023';
   end if;
  elsif not exists (select 1 from mavi_private.ai_providers v where v.id = v_provider::uuid and v.company_id = p_company
   and exists (select 1 from jsonb_array_elements(v.models) m where m->>'id' = v_model)) then
   raise exception 'Modelo não cadastrado: %.', v_model using errcode = '22023';
  end if;
 end loop;
end $$;
revoke all on function mavi_private.ai_router_check_models(uuid, text[]) from public, anon, authenticated;

-- As da migração 20270601090000, com os modelos do roteamento.
create or replace function mavi_private.ai_router_settings_log() returns trigger
language plpgsql security definer set search_path = '' as $$
declare f text; v_old jsonb; v_new jsonb; o jsonb; n jsonb; d jsonb := jsonb_build_object('mode', 'shadow',
 'level', 'equilibrado', 'surface_levels', '{}'::jsonb, 'escalate', true, 'escalate_cap', 0.5, 'judge_sample', 0.1,
 'eval_enabled', true, 'eval_rate', 0.2, 'eval_daily_cap', 0.5, 'gate_enabled', false, 'gate_min', 0.8); begin
 if not exists (select 1 from public.companies where id = new.company_id) then return null; end if;
 o := case when tg_op = 'INSERT' then null else to_jsonb(old) end;
 n := to_jsonb(new);
 foreach f in array array['mode', 'level', 'surface_levels', 'escalate', 'escalate_cap', 'providers', 'secret_providers',
  'judge_sample', 'eval_enabled', 'eval_rate', 'eval_daily_cap', 'gate_enabled', 'gate_min', 'route_models'] loop
  v_old := o->f; v_new := n->f;
  if tg_op = 'INSERT' then
   continue when v_new is null or v_new = 'null'
    or (jsonb_typeof(v_new) = 'number' and d ? f and (v_new)::numeric = (d->>f)::numeric)
    or (jsonb_typeof(v_new) <> 'number' and v_new = d->f);
  end if;
  continue when v_old is not distinct from v_new
   or (jsonb_typeof(v_new) = 'number' and jsonb_typeof(v_old) = 'number' and (v_old)::numeric = (v_new)::numeric);
  perform mavi_private.ai_log(new.company_id, 'router', '', '', f,
   case when tg_op = 'INSERT' then 'created' else 'changed' end,
   case when v_old is null then null else jsonb_build_object(f, v_old) end, jsonb_build_object(f, v_new));
 end loop;
 return null;
end $$;

create or replace function public.ai_router_get(p_company uuid) returns jsonb
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
  'secret_providers', to_jsonb(s.secret_providers), 'judge_sample', coalesce(s.judge_sample, 0.1),
  'eval_enabled', coalesce(s.eval_enabled, true), 'eval_rate', coalesce(s.eval_rate, 0.2),
  'eval_daily_cap', coalesce(s.eval_daily_cap, 0.5), 'gate_enabled', coalesce(s.gate_enabled, false),
  'gate_min', coalesce(s.gate_min, 0.8), 'route_models', to_jsonb(s.route_models), 'updated_at', s.updated_at,
  'scopes', (select coalesce(jsonb_agg(jsonb_build_object('type', x.scope_type, 'scope_id', x.scope_id,
    'level', x.level, 'providers', to_jsonb(x.providers), 'sigiloso', x.sigiloso, 'updated_at', x.updated_at)
    order by x.scope_type, x.updated_at), '[]') from mavi_private.ai_router_scopes x where x.company_id = p_company));
end $$;

create or replace function public.ai_router_save(p_company uuid, p_settings jsonb) returns void
language plpgsql security definer set search_path = '' as $$
declare s jsonb := coalesce(p_settings, '{}'); v_levels jsonb; k text;
 v_providers uuid[]; v_secret uuid[]; v_models text[]; begin
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
 -- Os modelos que o roteador pode escolher: "provedor|modelo" (o Servidor pelo id zero).
 if s ? 'route_models' and jsonb_typeof(s->'route_models') = 'array' then
  v_models := array(select distinct x from jsonb_array_elements_text(s->'route_models') x);
  if cardinality(v_models) = 0 then
   raise exception 'Deixe pelo menos um modelo para o roteador escolher.' using errcode = '22023';
  end if;
  perform mavi_private.ai_router_check_models(p_company, v_models);
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
  judge_sample = case when s ? 'judge_sample' then (s->>'judge_sample')::numeric else judge_sample end,
  eval_enabled = case when s ? 'eval_enabled' then (s->>'eval_enabled')::boolean else eval_enabled end,
  eval_rate = case when s ? 'eval_rate' then (s->>'eval_rate')::numeric else eval_rate end,
  eval_daily_cap = case when s ? 'eval_daily_cap' then (s->>'eval_daily_cap')::numeric else eval_daily_cap end,
  gate_enabled = case when s ? 'gate_enabled' then (s->>'gate_enabled')::boolean else gate_enabled end,
  gate_min = case when s ? 'gate_min' then (s->>'gate_min')::numeric else gate_min end,
  route_models = case when s ? 'route_models' then v_models else route_models end,
  updated_by = auth.uid(), updated_at = now()
 where company_id = p_company;
end $$;

create or replace function public.ai_route_context(p_company uuid, p_client uuid, p_contract uuid, p_project uuid,
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
   where p.company_id = p_company and p.active and (v_allowed is null or p.id = any(v_allowed))),
  'stats', (select coalesce(jsonb_agg(jsonb_build_object('task_type', r.task_type, 'model', r.model,
    'n', r.live_n + r.eval_n, 'quality', r.quality)), '[]')
   from mavi_private.ai_route_rank r where r.company_id = p_company and r.live_n + r.eval_n >= 5),
  'person_bad', (select coalesce(jsonb_agg(t.task_type), '[]') from (
    select d.task_type from public.ai_route_decisions d
    where d.company_id = p_company and d.user_id = auth.uid() and d.created_at > now() - interval '14 days'
     and d.message_id is not null
     and (exists (select 1 from public.mavi_feedback f where f.message_id = d.message_id and f.vote = 'down')
      or exists (select 1 from public.mavi_answer_checks x where x.message_id = d.message_id
       and x.signals && array['frustration', 'repeated']))
    group by d.task_type having count(*) >= 2) t),
  'route_models', to_jsonb(s.route_models),
  'gate', coalesce(s.gate_enabled, false),
  'approved', case when coalesce(s.gate_enabled, false) then (select coalesce(jsonb_agg(jsonb_build_object(
    'provider_id', l.provider_id, 'model', l.model)), '[]') from mavi_private.ai_eval_latest(p_company) l
    where l.score >= coalesce(s.gate_min, 0.8)) else '[]'::jsonb end);
end $$;

commit;
