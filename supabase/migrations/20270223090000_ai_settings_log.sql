begin;

-- Painel da MAVI › Quem usa qual modelo: histórico de alterações (auditoria).
--
-- Toda alteração em cada campo da aba fica registrada: o padrão da empresa,
-- o modelo e o esforço de cada funcionalidade e de cada skill, as regras de
-- pessoas, clientes, produtos e projetos, as animações do Mural (modelos
-- liberados, pessoas e equipes de cada um, consulta à base) e a biblioteca
-- de Provedores e modelos (nome, tipo, endereço, ligado, API Key trocada —
-- nunca a chave — e a lista de modelos com os preços).
--
-- Quem grava são gatilhos nas próprias tabelas: vale para qualquer caminho
-- (a tela, a MAVI, o servidor), e também para o que muda sozinho — a regra
-- que some porque o provedor foi excluído, porque o modelo saiu da lista do
-- provedor ou porque a skill foi apagada fica com a causa ao lado
-- (mavi.ai_log_cause, válida só na transação que causou).
--
-- O registro é para sempre e ninguém o edita nem apaga (só some junto com a
-- empresa). Leem administradores e gestores, os mesmos que editam a aba.
-- Na aplicação desta migração, a configuração que já existe entra como
-- "estado inicial", para a primeira alteração ter com o que comparar.

create table mavi_private.ai_settings_log (
 id bigint generated always as identity primary key,
 company_id uuid not null references public.companies(id) on delete cascade,
 at timestamptz not null default now(),
 -- Quem alterou (nulo: o sistema).
 actor uuid default auth.uid(),
 -- A seção da aba: o padrão da empresa, as regras por funcionalidade, skill,
 -- pessoa, cliente, produto e projeto, as animações e os provedores.
 area text not null check (area in ('company', 'feature', 'skill', 'user', 'client', 'contract', 'project',
  'animation', 'provider')),
 -- Qual linha: a funcionalidade, o id da skill/pessoa/cliente/produto/
 -- projeto/provedor, ou "provedor|modelo" nas animações ('' na empresa e na
 -- consulta à base das animações).
 subject text not null default '',
 -- O nome na hora (o que foi apagado continua legível).
 subject_label text not null default '',
 field text not null check (field in ('model', 'effort', 'provider', 'name', 'kind', 'base_url', 'active', 'key',
  'models', 'knowledge', 'access')),
 action text not null check (action in ('created', 'changed', 'removed')),
 old_value jsonb,
 new_value jsonb,
 -- Nulo: alteração direta. {type: provider_deleted | model_removed |
 -- skill_deleted | baseline, label, ...}.
 cause jsonb
);
create index ai_settings_log_company on mavi_private.ai_settings_log (company_id, id desc);
create index ai_settings_log_field on mavi_private.ai_settings_log (company_id, area, subject, field, id desc);
alter table mavi_private.ai_settings_log enable row level security;
revoke all on mavi_private.ai_settings_log from public, anon, authenticated;

-- Ninguém altera nem apaga um registro (só a exclusão da empresa leva junto).
create function mavi_private.ai_settings_log_guard() returns trigger
language plpgsql set search_path = '' as $$ begin
 if tg_op = 'DELETE' then
  if not exists (select 1 from public.companies where id = old.company_id) then return old; end if;
 end if;
 raise exception 'O histórico de alterações não pode ser alterado nem apagado.' using errcode = '42501';
end $$;
create trigger ai_settings_log_guard before update or delete on mavi_private.ai_settings_log
 for each row execute function mavi_private.ai_settings_log_guard();
create trigger ai_settings_log_no_truncate before truncate on mavi_private.ai_settings_log
 for each statement execute function mavi_private.ai_settings_log_guard();

-- ------------------------------------------------------------ ajudantes
create function mavi_private.ai_log_cause() returns jsonb
language sql stable set search_path = '' as $$
 select nullif(current_setting('mavi.ai_log_cause', true), '')::jsonb
$$;

create function mavi_private.ai_log(p_company uuid, p_area text, p_subject text, p_label text, p_field text,
 p_action text, p_old jsonb, p_new jsonb) returns void
language sql security definer set search_path = '' as $$
 insert into mavi_private.ai_settings_log(company_id, actor, area, subject, subject_label, field, action,
  old_value, new_value, cause)
 values (p_company, auth.uid(), p_area, coalesce(p_subject, ''), coalesce(p_label, ''), p_field, p_action,
  p_old, p_new, mavi_private.ai_log_cause())
$$;

-- Provedor e modelo com os nomes da hora. Se o provedor acabou de ser
-- excluído (a regra sai em cascata), os nomes vêm da causa.
create function mavi_private.ai_log_choice(p_provider uuid, p_model text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_name text; v_models jsonb; c jsonb := mavi_private.ai_log_cause(); begin
 if p_provider is null then return null; end if;
 select p.name, p.models into v_name, v_models from mavi_private.ai_providers p where p.id = p_provider;
 if v_name is null and c->>'provider_id' = p_provider::text then
  v_name := c->>'provider'; v_models := c->'models';
 end if;
 return jsonb_strip_nulls(jsonb_build_object('provider_id', p_provider, 'provider', v_name, 'model', p_model,
  'model_label', (select nullif(m->>'label', '') from jsonb_array_elements(coalesce(v_models, '[]')) m
   where m->>'id' = p_model limit 1)));
end $$;

-- O nome de quem a regra vale (pessoa, cliente, produto, projeto, skill).
create function mavi_private.ai_log_subject(p_company uuid, p_type text, p_id uuid) returns text
language plpgsql stable security definer set search_path = '' as $$
declare v text; c jsonb := mavi_private.ai_log_cause(); begin
 if p_id is null then return ''; end if;
 if p_type = 'user' then
  select m.name into v from public.memberships m where m.company_id = p_company and m.user_id = p_id;
 elsif p_type = 'client' then
  select x.name into v from public.clients x where x.company_id = p_company and x.id = p_id;
 elsif p_type = 'contract' then
  select pr.name || ' · ' || cl.name into v from public.contracts k
  join public.products pr on pr.company_id = k.company_id and pr.id = k.product_id
  join public.clients cl on cl.company_id = k.company_id and cl.id = k.client_id
  where k.company_id = p_company and k.id = p_id;
 elsif p_type = 'project' then
  select x.name into v from public.projects x where x.company_id = p_company and x.id = p_id;
 elsif p_type = 'skill' then
  select s.slug into v from public.ai_skills s where s.company_id = p_company and s.id = p_id;
  if v is null and c->>'skill_id' = p_id::text then v := c->>'label'; end if;
 end if;
 return coalesce(v, '');
end $$;

revoke all on function mavi_private.ai_log_cause(), mavi_private.ai_log(uuid, text, text, text, text, text, jsonb, jsonb),
 mavi_private.ai_log_choice(uuid, text), mavi_private.ai_log_subject(uuid, text, uuid)
 from public, anon, authenticated;

-- ------------------------------------------------------------ regras
create function mavi_private.ai_routes_log() returns trigger
language plpgsql security definer set search_path = '' as $$
declare r mavi_private.ai_routes; v_subject text; begin
 if tg_op = 'UPDATE' and new.provider_id = old.provider_id and new.model = old.model then return null; end if;
 if tg_op = 'DELETE' then r := old; else r := new; end if;
 -- A empresa sendo excluída leva tudo junto: nada a registrar.
 if not exists (select 1 from public.companies where id = r.company_id) then return null; end if;
 v_subject := case when r.scope_type = 'feature' then r.feature else coalesce(r.scope_id::text, '') end;
 perform mavi_private.ai_log(r.company_id, r.scope_type, v_subject,
  case when r.scope_type in ('company', 'feature') then '' else mavi_private.ai_log_subject(r.company_id, r.scope_type, r.scope_id) end,
  'model',
  case tg_op when 'INSERT' then 'created' when 'DELETE' then 'removed' else 'changed' end,
  case when tg_op = 'INSERT' then null else mavi_private.ai_log_choice(old.provider_id, old.model) end,
  case when tg_op = 'DELETE' then null else mavi_private.ai_log_choice(new.provider_id, new.model) end);
 return null;
end $$;
create trigger ai_routes_log after insert or update or delete on mavi_private.ai_routes
 for each row execute function mavi_private.ai_routes_log();

-- ------------------------------------------------------------ esforço
create function mavi_private.ai_efforts_log() returns trigger
language plpgsql security definer set search_path = '' as $$
declare r mavi_private.ai_efforts; v_skill uuid; begin
 if tg_op = 'UPDATE' and new.effort = old.effort then return null; end if;
 if tg_op = 'DELETE' then r := old; else r := new; end if;
 if not exists (select 1 from public.companies where id = r.company_id) then return null; end if;
 if r.key like 'skill:%' then v_skill := substr(r.key, 7)::uuid; end if;
 perform mavi_private.ai_log(r.company_id, case when v_skill is null then 'feature' else 'skill' end,
  coalesce(v_skill::text, r.key), case when v_skill is null then '' else mavi_private.ai_log_subject(r.company_id, 'skill', v_skill) end,
  'effort',
  case tg_op when 'INSERT' then 'created' when 'DELETE' then 'removed' else 'changed' end,
  case when tg_op = 'INSERT' then null else jsonb_build_object('effort', old.effort) end,
  case when tg_op = 'DELETE' then null else jsonb_build_object('effort', new.effort) end);
 return null;
end $$;
create trigger ai_efforts_log after insert or update or delete on mavi_private.ai_efforts
 for each row execute function mavi_private.ai_efforts_log();

-- Apagar a skill leva a regra e o esforço dela: a causa vai junto.
create function mavi_private.ai_skills_log_cause() returns trigger
language plpgsql security definer set search_path = '' as $$ begin
 perform set_config('mavi.ai_log_cause', jsonb_build_object('type', 'skill_deleted', 'skill_id', old.id,
  'label', old.slug)::text, true);
 return old;
end $$;
create trigger ai_skills_log_cause before delete on public.ai_skills
 for each row execute function mavi_private.ai_skills_log_cause();

-- ------------------------------------------------------------ provedores
-- Os modelos como ficam no histórico: id, nome e preços.
create function mavi_private.ai_log_models(p jsonb) returns jsonb
language sql immutable set search_path = '' as $$
 select coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object('id', m->>'id', 'label', nullif(m->>'label', ''),
  'input', m->'input', 'output', m->'output', 'cached', case when jsonb_typeof(m->'cached') = 'number' then m->'cached' end))
  order by ord), '[]')
 from jsonb_array_elements(coalesce(p, '[]')) with ordinality as t(m, ord)
$$;
revoke all on function mavi_private.ai_log_models(jsonb) from public, anon, authenticated;

create function mavi_private.ai_providers_log() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_removed jsonb; begin
 if tg_op = 'INSERT' then
  perform mavi_private.ai_log(new.company_id, 'provider', new.id::text, new.name, 'provider', 'created', null,
   jsonb_strip_nulls(jsonb_build_object('name', new.name, 'kind', new.kind, 'base_url', new.base_url,
    'active', new.active, 'key_hint', new.key_hint, 'models', mavi_private.ai_log_models(new.models))));
  return null;
 end if;
 if tg_op = 'DELETE' then
  if not exists (select 1 from public.companies where id = old.company_id) then return null; end if;
  -- A exclusão em si é direta (a causa vale para o que sai junto).
  insert into mavi_private.ai_settings_log(company_id, actor, area, subject, subject_label, field, action, old_value)
  values (old.company_id, auth.uid(), 'provider', old.id::text, old.name, 'provider', 'removed',
   jsonb_strip_nulls(jsonb_build_object('name', old.name, 'kind', old.kind, 'base_url', old.base_url,
    'active', old.active, 'key_hint', old.key_hint, 'models', mavi_private.ai_log_models(old.models))));
  return null;
 end if;
 if new.name is distinct from old.name then
  perform mavi_private.ai_log(new.company_id, 'provider', new.id::text, new.name, 'name', 'changed',
   to_jsonb(old.name), to_jsonb(new.name));
 end if;
 if new.kind is distinct from old.kind then
  perform mavi_private.ai_log(new.company_id, 'provider', new.id::text, new.name, 'kind', 'changed',
   to_jsonb(old.kind), to_jsonb(new.kind));
 end if;
 if new.base_url is distinct from old.base_url then
  perform mavi_private.ai_log(new.company_id, 'provider', new.id::text, new.name, 'base_url', 'changed',
   to_jsonb(old.base_url), to_jsonb(new.base_url));
 end if;
 if new.active is distinct from old.active then
  perform mavi_private.ai_log(new.company_id, 'provider', new.id::text, new.name, 'active', 'changed',
   to_jsonb(old.active), to_jsonb(new.active));
 end if;
 -- A chave em si nunca: só que foi trocada e o final dela.
 if new.key_cipher is distinct from old.key_cipher then
  perform mavi_private.ai_log(new.company_id, 'provider', new.id::text, new.name, 'key', 'changed',
   jsonb_build_object('key_hint', old.key_hint), jsonb_build_object('key_hint', new.key_hint));
 end if;
 if mavi_private.ai_log_models(new.models) is distinct from mavi_private.ai_log_models(old.models) then
  perform mavi_private.ai_log(new.company_id, 'provider', new.id::text, new.name, 'models', 'changed',
   mavi_private.ai_log_models(old.models), mavi_private.ai_log_models(new.models));
  -- As regras dos modelos que saíram vão embora logo depois (ai_save_provider).
  select coalesce(jsonb_agg(m->>'id'), '[]') into v_removed from jsonb_array_elements(old.models) m
  where not exists (select 1 from jsonb_array_elements(new.models) n where n->>'id' = m->>'id');
  if jsonb_array_length(v_removed) > 0 then
   perform set_config('mavi.ai_log_cause', jsonb_build_object('type', 'model_removed', 'provider_id', new.id,
    'provider', new.name, 'label', new.name, 'removed', v_removed, 'models', mavi_private.ai_log_models(old.models))::text, true);
  end if;
 end if;
 return null;
end $$;
create trigger ai_providers_log after insert or update or delete on mavi_private.ai_providers
 for each row execute function mavi_private.ai_providers_log();

-- Excluir o provedor leva as regras e as animações dele: a causa vai junto.
create function mavi_private.ai_providers_log_cause() returns trigger
language plpgsql security definer set search_path = '' as $$ begin
 perform set_config('mavi.ai_log_cause', jsonb_build_object('type', 'provider_deleted', 'provider_id', old.id,
  'provider', old.name, 'label', old.name, 'models', mavi_private.ai_log_models(old.models))::text, true);
 return old;
end $$;
create trigger ai_providers_log_cause before delete on mavi_private.ai_providers
 for each row execute function mavi_private.ai_providers_log_cause();

-- ------------------------------------------------------------ animações do Mural
-- O que o set_notice_animation_admin regrava inteiro é comparado lá dentro;
-- aqui só o modelo que sai junto com o provedor excluído.
create function mavi_private.notice_animation_models_log() returns trigger
language plpgsql security definer set search_path = '' as $$
declare c jsonb := mavi_private.ai_log_cause(); v_choice jsonb; begin
 if coalesce(c->>'type', '') <> 'provider_deleted' then return null; end if;
 if not exists (select 1 from public.companies where id = old.company_id) then return null; end if;
 v_choice := mavi_private.ai_log_choice(old.provider_id, old.model);
 perform mavi_private.ai_log(old.company_id, 'animation', old.provider_id::text || '|' || old.model,
  coalesce(v_choice->>'provider', '?') || ' · ' || coalesce(v_choice->>'model_label', old.model), 'model', 'removed',
  v_choice || jsonb_build_object('user_ids', to_jsonb(old.user_ids), 'team_ids', to_jsonb(old.team_ids)), null);
 return null;
end $$;
create trigger notice_animation_models_log after delete on public.notice_animation_models
 for each row execute function mavi_private.notice_animation_models_log();

-- A de 20261204150000_ai_routes_managers, comparando antes e depois.
create or replace function public.set_notice_animation_admin(p_company uuid, p_knowledge boolean, p_models jsonb) returns void
language plpgsql security definer set search_path = '' as $$
declare x jsonb; i integer := 0; v_provider uuid; v_model text; v_before jsonb; v_after jsonb; v_knowledge boolean;
 k text; b jsonb; a jsonb; v_choice jsonb; begin
 if not mavi_private.leader(p_company) then
  raise exception 'Só administradores e gestores escolhem os modelos das animações.' using errcode = '42501';
 end if;
 if jsonb_typeof(coalesce(p_models, '[]')) <> 'array' or jsonb_array_length(coalesce(p_models, '[]')) > 20 then
  raise exception 'Lista de modelos inválida' using errcode = '22023';
 end if;
 select s.knowledge into v_knowledge from public.notice_animation_settings s where s.company_id = p_company;
 v_knowledge := coalesce(v_knowledge, true);
 select coalesce(jsonb_object_agg(m.provider_id::text || '|' || m.model, jsonb_build_object(
   'user_ids', (select coalesce(jsonb_agg(u order by u), '[]') from unnest(m.user_ids) u),
   'team_ids', (select coalesce(jsonb_agg(t order by t), '[]') from unnest(m.team_ids) t))), '{}')
 into v_before from public.notice_animation_models m where m.company_id = p_company;

 insert into public.notice_animation_settings(company_id, knowledge, updated_by)
 values (p_company, coalesce(p_knowledge, true), auth.uid())
 on conflict (company_id) do update set knowledge = excluded.knowledge, updated_at = now(), updated_by = auth.uid();
 delete from public.notice_animation_models where company_id = p_company;
 for x in select * from jsonb_array_elements(coalesce(p_models, '[]')) loop
  v_provider := nullif(x->>'provider_id', '')::uuid;
  v_model := x->>'model';
  if not exists (select 1 from mavi_private.ai_providers p where p.id = v_provider and p.company_id = p_company
    and exists (select 1 from jsonb_array_elements(p.models) m where m->>'id' = v_model)) then
   raise exception 'Escolha um modelo cadastrado no provedor.' using errcode = '22023';
  end if;
  insert into public.notice_animation_models(company_id, provider_id, model, user_ids, team_ids, position)
  values (p_company, v_provider, v_model,
   coalesce((select array_agg(distinct u::uuid) from jsonb_array_elements_text(coalesce(x->'user_ids', '[]')) u
    where exists (select 1 from public.memberships mm where mm.company_id = p_company and mm.user_id = u::uuid)), '{}'),
   coalesce((select array_agg(distinct t::uuid) from jsonb_array_elements_text(coalesce(x->'team_ids', '[]')) t
    where exists (select 1 from public.teams tt where tt.company_id = p_company and tt.id = t::uuid)), '{}'),
   i)
  on conflict (company_id, provider_id, model) do nothing;
  i := i + 1;
 end loop;

 -- O histórico: só o que mudou de fato.
 if coalesce(p_knowledge, true) is distinct from v_knowledge then
  perform mavi_private.ai_log(p_company, 'animation', '', '', 'knowledge', 'changed',
   to_jsonb(v_knowledge), to_jsonb(coalesce(p_knowledge, true)));
 end if;
 select coalesce(jsonb_object_agg(m.provider_id::text || '|' || m.model, jsonb_build_object(
   'user_ids', (select coalesce(jsonb_agg(u order by u), '[]') from unnest(m.user_ids) u),
   'team_ids', (select coalesce(jsonb_agg(t order by t), '[]') from unnest(m.team_ids) t))), '{}')
 into v_after from public.notice_animation_models m where m.company_id = p_company;
 for k in select key from jsonb_each(v_before) union select key from jsonb_each(v_after) loop
  b := v_before->k; a := v_after->k;
  if b = a then continue; end if;
  v_choice := mavi_private.ai_log_choice(split_part(k, '|', 1)::uuid, substr(k, length(split_part(k, '|', 1)) + 2));
  perform mavi_private.ai_log(p_company, 'animation', k,
   coalesce(v_choice->>'provider', '?') || ' · ' || coalesce(v_choice->>'model_label', v_choice->>'model'),
   case when b is null or a is null then 'model' else 'access' end,
   case when b is null then 'created' when a is null then 'removed' else 'changed' end,
   case when b is null then null else v_choice || b end,
   case when a is null then null else v_choice || a end);
 end loop;
end $$;

-- ------------------------------------------------------------ leitura
-- O histórico, do mais recente ao mais antigo, com filtros no banco: seção,
-- linha e campo (o ícone de cada campo), quem alterou e o período (datas no
-- fuso da empresa). p_before: o id do último já carregado.
create function public.ai_settings_log(p_company uuid, p_area text default null, p_subject text default null,
 p_field text default null, p_actor uuid default null, p_from date default null, p_to date default null,
 p_before bigint default null, p_limit integer default 30) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_tz text; begin
 if not mavi_private.leader(p_company) then
  raise exception 'Só administradores e gestores veem o histórico de alterações.' using errcode = '42501';
 end if;
 select coalesce(c.timezone, 'America/Sao_Paulo') into v_tz from public.companies c where c.id = p_company;
 return jsonb_build_object('items', (select coalesce(jsonb_agg(jsonb_build_object('id', l.id, 'at', l.at,
   'actor', l.actor, 'area', l.area, 'subject', l.subject, 'subject_label', l.subject_label, 'field', l.field,
   'action', l.action, 'old', l.old_value, 'new', l.new_value, 'cause', l.cause) order by l.id desc), '[]')
  from (select * from mavi_private.ai_settings_log l
   where l.company_id = p_company
    and (p_area is null or l.area = p_area)
    and (p_subject is null or l.subject = p_subject)
    -- 'model' no ícone do provedor e da animação inclui os outros campos da linha.
    and (p_field is null or l.field = any(string_to_array(p_field, ',')))
    and (p_actor is null or l.actor = p_actor)
    and (p_from is null or (l.at at time zone v_tz)::date >= p_from)
    and (p_to is null or (l.at at time zone v_tz)::date <= p_to)
    and (p_before is null or l.id < p_before)
   order by l.id desc limit least(greatest(coalesce(p_limit, 30), 1), 100)) l));
end $$;
revoke all on function public.ai_settings_log(uuid, text, text, text, uuid, date, date, bigint, integer) from public, anon;
grant execute on function public.ai_settings_log(uuid, text, text, text, uuid, date, date, bigint, integer) to authenticated;

-- ------------------------------------------------------------ estado inicial
-- O que já está configurado entra uma vez, com quem fez a última mudança.
insert into mavi_private.ai_settings_log(company_id, at, actor, area, subject, subject_label, field, action, new_value, cause)
select r.company_id, now(), r.updated_by, r.scope_type,
 case when r.scope_type = 'feature' then r.feature else coalesce(r.scope_id::text, '') end,
 case when r.scope_type in ('company', 'feature') then '' else mavi_private.ai_log_subject(r.company_id, r.scope_type, r.scope_id) end,
 'model', 'created', mavi_private.ai_log_choice(r.provider_id, r.model), '{"type": "baseline"}'
from mavi_private.ai_routes r order by r.updated_at;

insert into mavi_private.ai_settings_log(company_id, at, actor, area, subject, subject_label, field, action, new_value, cause)
select e.company_id, now(), e.updated_by, case when e.key like 'skill:%' then 'skill' else 'feature' end,
 case when e.key like 'skill:%' then substr(e.key, 7) else e.key end,
 case when e.key like 'skill:%' then mavi_private.ai_log_subject(e.company_id, 'skill', substr(e.key, 7)::uuid) else '' end,
 'effort', 'created', jsonb_build_object('effort', e.effort), '{"type": "baseline"}'
from mavi_private.ai_efforts e order by e.updated_at;

insert into mavi_private.ai_settings_log(company_id, at, actor, area, subject, subject_label, field, action, new_value, cause)
select p.company_id, now(), coalesce(p.updated_by, p.created_by), 'provider', p.id::text, p.name, 'provider', 'created',
 jsonb_strip_nulls(jsonb_build_object('name', p.name, 'kind', p.kind, 'base_url', p.base_url, 'active', p.active,
  'key_hint', p.key_hint, 'models', mavi_private.ai_log_models(p.models))), '{"type": "baseline"}'
from mavi_private.ai_providers p order by p.created_at;

insert into mavi_private.ai_settings_log(company_id, at, actor, area, subject, subject_label, field, action, new_value, cause)
select s.company_id, now(), s.updated_by, 'animation', '', '', 'knowledge', 'created', to_jsonb(s.knowledge),
 '{"type": "baseline"}'
from public.notice_animation_settings s where not s.knowledge;

insert into mavi_private.ai_settings_log(company_id, at, actor, area, subject, subject_label, field, action, new_value, cause)
select m.company_id, now(), null, 'animation', m.provider_id::text || '|' || m.model,
 coalesce(c->>'provider', '?') || ' · ' || coalesce(c->>'model_label', m.model), 'model', 'created',
 c || jsonb_build_object('user_ids', (select coalesce(jsonb_agg(u order by u), '[]') from unnest(m.user_ids) u),
  'team_ids', (select coalesce(jsonb_agg(t order by t), '[]') from unnest(m.team_ids) t)),
 '{"type": "baseline"}'
from public.notice_animation_models m, lateral (select mavi_private.ai_log_choice(m.provider_id, m.model) c) x
order by m.company_id, m.position;

commit;
