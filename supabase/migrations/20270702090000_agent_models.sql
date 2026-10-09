begin;

-- Painel da MAVI › Agentes MAVI: os modelos que os agentes do motor
-- (mavi-agentes) podem usar, escolhidos por administradores e gestores entre
-- os modelos de conversa já cadastrados nos provedores, e o padrão (com o
-- reserva). O construtor só oferece os liberados; publicar confere de novo
-- (api/_agent-builder.ts). Agente publicado com um modelo que deixou de ser
-- liberado continua rodando até alguém editar e publicar de novo.
--
-- Chave: "<provedor_id>|<modelo>" (como em "Modelos que o roteador pode
-- escolher"). O motor recebe "<tipo>:<modelo>" (ex.: openrouter:openai/gpt-5.2)
-- e o preço por milhão de tokens; quem paga é a chave do próprio agente
-- (cadastrada no construtor, guardada só no motor) ou a do motor.

create table mavi_private.agent_model_settings (
 company_id uuid primary key references public.companies(id) on delete cascade,
 models text[] not null default '{}',
 default_model text,
 default_fallback text,
 updated_by uuid default auth.uid(),
 updated_at timestamptz not null default now()
);
alter table mavi_private.agent_model_settings enable row level security;
revoke all on mavi_private.agent_model_settings from public, anon, authenticated;

-- Os provedores que o motor fala (o "custom" fica de fora: endereço próprio).
create function mavi_private.agent_engine_kind(p_kind text) returns boolean
language sql immutable set search_path = '' as $$
 select p_kind in ('openrouter', 'openai', 'anthropic', 'google', 'deepseek', 'groq', 'mistral', 'xai')
$$;

-- Os modelos de conversa dos provedores ativos que o motor fala.
create function mavi_private.agent_model_rows(p_company uuid)
returns table (key text, ref text, provider_id uuid, provider_name text, kind text, model text, label text,
 input numeric, output numeric, cached numeric)
language sql stable security definer set search_path = '' as $$
 select p.id::text || '|' || (m->>'id'), p.kind || ':' || (m->>'id'), p.id, p.name, p.kind, m->>'id',
  coalesce(nullif(btrim(m->>'label'), ''), m->>'id'),
  nullif(m->>'input', '')::numeric, nullif(m->>'output', '')::numeric, nullif(m->>'cached', '')::numeric
 from mavi_private.ai_providers p, jsonb_array_elements(p.models) m
 where p.company_id = p_company and p.active and mavi_private.agent_engine_kind(p.kind)
  and coalesce(m->>'id', '') <> ''
  and (m->>'id') !~* '(transcribe|whisper|embed|image|dall-e|tts|voxtral|typesafe/jev)'
$$;
revoke all on function mavi_private.agent_engine_kind(text), mavi_private.agent_model_rows(uuid) from public, anon, authenticated;

-- Para o construtor (membros: só os liberados) e para o Painel (líderes: todos, com "allowed").
create function public.agent_models(p_company uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare s mavi_private.agent_model_settings; v_leader boolean; begin
 if not mavi_private.member(p_company) then raise exception 'Sem acesso.' using errcode = '42501'; end if;
 v_leader := mavi_private.leader(p_company);
 select * into s from mavi_private.agent_model_settings where company_id = p_company;
 return jsonb_build_object(
  'can_edit', v_leader,
  'default', s.default_model,
  'fallback', s.default_fallback,
  'updated_at', s.updated_at,
  'models', coalesce((
   select jsonb_agg(jsonb_build_object('key', r.key, 'ref', r.ref, 'provider_id', r.provider_id,
     'provider_name', r.provider_name, 'kind', r.kind, 'model', r.model, 'label', r.label,
     'input', r.input, 'output', r.output, 'cached', r.cached,
     'allowed', r.key = any(coalesce(s.models, '{}'))) order by r.provider_name, r.label)
   from mavi_private.agent_model_rows(p_company) r
   where v_leader or r.key = any(coalesce(s.models, '{}'))), '[]'::jsonb));
end $$;

create function public.agent_models_set(p_company uuid, p_models text[], p_default text, p_fallback text)
returns void
language plpgsql security definer set search_path = '' as $$
declare v_valid text[]; k text; begin
 if not mavi_private.leader(p_company) then
  raise exception 'Só administradores e gestores liberam os modelos dos agentes.' using errcode = '42501';
 end if;
 select coalesce(array_agg(r.key), '{}') into v_valid from mavi_private.agent_model_rows(p_company) r;
 foreach k in array coalesce(p_models, '{}') loop
  if not k = any(v_valid) then raise exception 'Modelo não cadastrado ou que não conversa: %.', k using errcode = '22023'; end if;
 end loop;
 if p_default is not null and not p_default = any(coalesce(p_models, '{}')) then
  raise exception 'O modelo padrão precisa estar entre os liberados.' using errcode = '22023';
 end if;
 if p_fallback is not null and not p_fallback = any(coalesce(p_models, '{}')) then
  raise exception 'O modelo reserva precisa estar entre os liberados.' using errcode = '22023';
 end if;
 insert into mavi_private.agent_model_settings as a (company_id, models, default_model, default_fallback, updated_by, updated_at)
 values (p_company, coalesce(p_models, '{}'), p_default, p_fallback, auth.uid(), now())
 on conflict (company_id) do update set models = excluded.models, default_model = excluded.default_model,
  default_fallback = excluded.default_fallback, updated_by = auth.uid(), updated_at = now();
end $$;

revoke all on function public.agent_models(uuid), public.agent_models_set(uuid, text[], text, text) from public, anon;
grant execute on function public.agent_models(uuid), public.agent_models_set(uuid, text[], text, text) to authenticated;

commit;
