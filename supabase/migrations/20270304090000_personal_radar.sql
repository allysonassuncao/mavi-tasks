begin;

-- MAVI · Radar pessoal (Radar › Pessoal), Fase 1: a MAVI Assistente Pessoal
-- lê os grupos de WhatsApp dos clientes em que a pessoa está e lista as
-- situações que cabem a ela (dúvidas, solicitações, reclamações, materiais
-- enviados, aprovações e cobranças de prazo). Só leitura: nada é enviado ao
-- grupo.
--
-- * Quem usa: o administrador libera (módulo opcional "personalRadar", igual
--   a Visão geral/Campanhas/Radar para colaboradores; gestores e
--   administradores têm por padrão, salvo se ocultado) e a própria pessoa liga.
-- * Os grupos da pessoa: ela participa do grupo (lista de participantes da
--   Uazapi, /group/info, pelos celulares cadastrados — ou já falou nele) E o
--   cliente do grupo é de uma equipe dela.
-- * Quem é o dono: menção (@) ou resposta direta à pessoa primeiro; senão, o
--   assunto pelo que a pessoa faz (equipes + "O que é comigo"). Cada dono tem o
--   motivo. A mesma situação pode ser de duas pessoas; resolvida, sai das duas.
-- * Repetição: o cliente que volta ao assunto soma no mesmo item ("cobrou 3x");
--   o item liga à tarefa aberta e ao item do Radar do cliente sobre o assunto.
-- * Resolvido: a MAVI fecha quando vê a resposta do time no grupo ("Resolvido
--   por Fulano às 14h"); a pessoa também fecha, e reabre.
-- * Ritmo: com alguém usando, a varredura do WhatsApp roda a cada
--   personal_radar_settings.interval_minutes (padrão 15, administrador ou
--   gestor escolhe) em vez de a cada hora; ao ligar, a MAVI lê os últimos
--   history_days (padrão 30) dias já guardados.
-- * Custo: funcionalidade 'personal_radar' em Quem usa qual modelo; o custo de
--   cada leitura é dividido entre as pessoas do grupo (ai_usage, módulo
--   'personal_radar') e cada uma tem um teto por mês (padrão da empresa ou o
--   da pessoa, escolhidos pelo administrador). No teto, a pessoa sai da leitura
--   até o mês virar.
-- * Quem vê a lista: a própria pessoa; administradores (todas), gestores (as
--   de quem não é administrador) e supervisores (as da equipe), só leitura.
--
-- O worker é a ação "ai-personal-radar" de /api/ai (api/_personal-radar.ts),
-- acordada junto com o Radar do cliente (mavi_private.ai_radar_kick, a cada 2
-- minutos — nenhum agendamento novo).

-- ------------------------------------------------------------ módulo
alter table public.memberships drop constraint if exists memberships_hidden_pages_check;
alter table public.memberships add constraint memberships_hidden_pages_check
 check (hidden_pages <@ array['overview','tasks','agenda','clients','products','projects','campaigns','hours',
  'reports','drive','storage','dashboards','onboarding','aiUsage','assistant','cases','notices',
  'temperature','socialMedia','radar','financeMedia','personalRadar']::text[]);
alter table public.memberships drop constraint if exists memberships_shown_pages_check;
alter table public.memberships add constraint memberships_shown_pages_check
 check (shown_pages <@ array['overview','campaigns','radar','dashboards','financeMedia','personalRadar']::text[]);

-- A da migração 20270114090000, com o Radar pessoal entre os opcionais.
create or replace function public.set_member_pages(p_company uuid, p_user uuid, p_hidden text[]) returns void
language plpgsql security definer set search_path = '' as $$
declare v text[]; v_role text; opt text[] := array['overview','campaigns','radar','dashboards','financeMedia','personalRadar'];
 v_shown text[]; begin
 if not mavi_private.admin(p_company) then
  raise exception 'Somente administradores escolhem os módulos de cada pessoa.' using errcode = '42501';
 end if;
 select role into v_role from public.memberships where company_id = p_company and user_id = p_user;
 if not found then
  raise exception 'Usuário não encontrado na empresa';
 end if;
 select coalesce(array_agg(distinct x order by x), '{}') into v from unnest(coalesce(p_hidden, '{}')) x;
 if not v <@ array['overview','tasks','agenda','clients','products','projects','campaigns','hours',
  'reports','drive','storage','dashboards','onboarding','aiUsage','assistant','cases','notices',
  'temperature','socialMedia','radar','financeMedia','personalRadar']::text[] then
  raise exception 'Módulo inválido' using errcode = '22023';
 end if;
 if v_role = 'member' then
  select coalesce(array_agg(x order by x), '{}') into v_shown from unnest(opt) x where not x = any(v);
  select coalesce(array_agg(x order by x), '{}') into v from unnest(v) x where not x = any(opt);
  update public.memberships set hidden_pages = v, shown_pages = v_shown
  where company_id = p_company and user_id = p_user
   and (hidden_pages is distinct from v or shown_pages is distinct from v_shown);
 else
  update public.memberships set hidden_pages = v where company_id = p_company and user_id = p_user
   and hidden_pages is distinct from v;
 end if;
end $$;

-- A pessoa tem o módulo: ativa, não ocultado e, colaborador, liberado.
create function mavi_private.personal_radar_allowed(c uuid, u uuid) returns boolean
language sql stable security definer set search_path = '' as $$
 select exists (select 1 from public.memberships m where m.company_id = c and m.user_id = u and m.active
  and not 'personalRadar' = any(m.hidden_pages)
  and (m.role in ('admin', 'manager') or 'personalRadar' = any(m.shown_pages)))
$$;

-- ------------------------------------------------------------ Quem usa qual modelo
-- 'personal_radar': a leitura dos grupos (situações, donos, repetição,
-- resolução). 'personal_assistant': a resposta sugerida (Fase 2).
alter table mavi_private.ai_routes drop constraint ai_routes_feature_check;
alter table mavi_private.ai_routes add constraint ai_routes_feature_check
 check ((scope_type = 'feature') = (feature is not null)
  and (feature is null or feature in ('assistant', 'meetings_history', 'meetings_ask',
   'whatsapp_task', 'social_leads_plan', 'social_leads_adjust', 'social_leads_briefing', 'social_leads_colors',
   'task_copilot', 'client_dossier', 'copilot_learning', 'notice_writer', 'notice_animation',
   'client_temperature', 'client_temperature_text', 'task_audio',
   'whatsapp_transcribe', 'task_audio_transcribe', 'image_generation', 'mavi_page', 'web_search', 'canvas_writer',
   'mavi_rerank', 'conversation_summary', 'skill_coach', 'whatsapp_history', 'client_radar', 'client_radar_check',
   'client_radar_themes', 'client_radar_report', 'mavi_learning', 'campaign_report', 'mavi_judge',
   'mavi_judge_check', 'task_title', 'dashboard_builder', 'campaign_alerts', 'task_search',
   'personal_radar', 'personal_assistant')));

-- A da migração 20270228090000, com o Radar pessoal.
create or replace function public.ai_set_route(p_company uuid, p_type text, p_id uuid, p_provider uuid, p_model text,
 p_feature text default null) returns void
language plpgsql security definer set search_path = '' as $$
declare v_id uuid := case when p_type in ('company', 'feature') then null else p_id end;
 v_feature text := case when p_type = 'feature' then p_feature end; v_kind text; begin
 if not mavi_private.leader(p_company) then
  raise exception 'Só administradores e gestores escolhem qual IA cada um usa.' using errcode = '42501';
 end if;
 if p_type not in ('company', 'user', 'client', 'contract', 'project', 'feature', 'skill') then
  raise exception 'Tipo inválido.' using errcode = '22023';
 end if;
 if p_type not in ('company', 'feature') and p_id is null then
  raise exception 'Escolha para quem vale a regra.' using errcode = '22023';
 end if;
 if p_type = 'feature' and coalesce(v_feature, '') not in ('assistant', 'meetings_history', 'meetings_ask',
  'whatsapp_task', 'social_leads_plan', 'social_leads_adjust', 'social_leads_briefing', 'social_leads_colors',
  'task_copilot', 'client_dossier', 'copilot_learning', 'notice_writer', 'notice_animation',
  'client_temperature', 'client_temperature_text', 'task_audio',
  'whatsapp_transcribe', 'task_audio_transcribe', 'image_generation', 'mavi_page', 'web_search', 'canvas_writer',
  'mavi_rerank', 'conversation_summary', 'skill_coach', 'whatsapp_history', 'client_radar', 'client_radar_check',
  'client_radar_themes', 'client_radar_report', 'mavi_learning', 'campaign_report', 'mavi_judge',
  'mavi_judge_check', 'task_title', 'dashboard_builder', 'campaign_alerts', 'task_search',
  'personal_radar', 'personal_assistant') then
  raise exception 'Funcionalidade inválida.' using errcode = '22023';
 end if;
 if p_provider is null then
  delete from mavi_private.ai_routes where company_id = p_company and scope_type = p_type
   and scope_id is not distinct from v_id and feature is not distinct from v_feature;
  return;
 end if;
 select p.kind into v_kind from mavi_private.ai_providers p where p.id = p_provider and p.company_id = p_company
  and exists (select 1 from jsonb_array_elements(p.models) m where m->>'id' = p_model);
 if v_kind is null then
  raise exception 'Escolha um modelo cadastrado no provedor.' using errcode = '22023';
 end if;
 -- Transcrição: o endpoint de transcrição da OpenAI e um modelo que transcreve.
 if mavi_private.ai_transcribe_feature(v_feature) then
  if v_kind not in ('openai', 'groq', 'mistral', 'custom') then
   raise exception 'A transcrição usa a OpenAI, o Groq, a Mistral ou um endereço compatível.' using errcode = '22023';
  end if;
  if not mavi_private.ai_transcribe_model(p_model) then
   raise exception 'Escolha um modelo de transcrição (Whisper, gpt-4o-transcribe, Voxtral…).' using errcode = '22023';
  end if;
 -- Imagens: o endpoint de imagens da OpenAI e um modelo que gera imagens.
 elsif v_feature = 'image_generation' then
  if v_kind not in ('openai', 'google', 'xai', 'openrouter', 'custom') then
   raise exception 'As imagens usam a OpenAI, o Google, a xAI, o OpenRouter ou um endereço compatível.' using errcode = '22023';
  end if;
  if not mavi_private.ai_image_model(p_model) then
   raise exception 'Escolha um modelo de imagem (gpt-image-1, Imagen, grok-2-image…).' using errcode = '22023';
  end if;
 -- Busca na internet: a da Claude (nativa) ou a do OpenRouter (plugin web e modelos online).
 elsif v_feature = 'web_search' then
  if v_kind not in ('anthropic', 'openrouter') then
   raise exception 'A busca na internet usa a Claude (Anthropic) ou o OpenRouter.' using errcode = '22023';
  end if;
  if mavi_private.ai_non_chat_model(p_model) then
   raise exception 'Escolha um modelo de conversa para a busca.' using errcode = '22023';
  end if;
 elsif mavi_private.ai_non_chat_model(p_model) then
  raise exception 'Este modelo só transcreve, gera vetores ou imagens: escolha um modelo de conversa.' using errcode = '22023';
 end if;
 -- O termômetro e a conferência do Radar leem com o Jev pelo OpenRouter; o Jev não conversa.
 if mavi_private.ai_decision_feature(v_feature) and not (v_kind = 'openrouter' and mavi_private.jev_model(p_model)) then
  raise exception 'Esta funcionalidade usa o Jev (TypeSafe) pelo OpenRouter: escolha o modelo do Jev.'
   using errcode = '22023';
 end if;
 if not mavi_private.ai_decision_feature(v_feature) and mavi_private.jev_model(p_model) then
  raise exception 'O Jev só responde a perguntas de decisão: use-o no termômetro, na conferência do Radar ou na autoavaliação da MAVI.'
   using errcode = '22023';
 end if;
 if p_type = 'user' and not exists (select 1 from public.memberships where company_id = p_company and user_id = p_id)
  or p_type = 'client' and not exists (select 1 from public.clients where company_id = p_company and id = p_id)
  or p_type = 'contract' and not exists (select 1 from public.contracts where company_id = p_company and id = p_id)
  or p_type = 'project' and not exists (select 1 from public.projects where company_id = p_company and id = p_id)
  or p_type = 'skill' and not exists (select 1 from public.ai_skills where company_id = p_company and id = p_id) then
  raise exception 'Não encontrado na empresa.' using errcode = 'P0002';
 end if;
 insert into mavi_private.ai_routes(company_id, scope_type, scope_id, feature, provider_id, model)
 values (p_company, p_type, v_id, v_feature, p_provider, p_model)
 on conflict on constraint ai_routes_scope_key do update set provider_id = excluded.provider_id,
  model = excluded.model, updated_by = auth.uid(), updated_at = now();
end $$;
revoke all on function public.ai_set_route(uuid, text, uuid, uuid, text, text) from public, anon;
grant execute on function public.ai_set_route(uuid, text, uuid, uuid, text, text) to authenticated;

-- ------------------------------------------------------------ configuração
create table public.personal_radar_settings (
 company_id uuid primary key references public.companies(id),
 -- De quanto em quanto tempo a varredura do WhatsApp roda com alguém usando.
 interval_minutes integer not null default 15 check (interval_minutes between 5 and 60),
 -- Quanto a MAVI lê para trás quando a pessoa liga.
 history_days integer not null default 30 check (history_days between 1 and 60),
 -- Teto por pessoa por mês (US$), salvo o da pessoa.
 monthly_cap_usd numeric(8,2) not null default 10 check (monthly_cap_usd between 0 and 1000),
 updated_by uuid,
 updated_at timestamptz not null default now()
);
alter table public.personal_radar_settings enable row level security;
revoke all on public.personal_radar_settings from public, anon, authenticated;

create table public.personal_radar_people (
 company_id uuid not null,
 user_id uuid not null,
 active boolean not null default false,
 started_at timestamptz,
 -- "O que é comigo": o que a pessoa resolve, nas palavras dela.
 about text not null default '' check (length(about) <= 1500),
 -- O teto da pessoa (administrador); nulo = o da empresa.
 cap_usd numeric(8,2) check (cap_usd between 0 and 1000),
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 primary key (company_id, user_id),
 foreign key (company_id, user_id) references public.memberships(company_id, user_id) on delete cascade
);
create index personal_radar_people_active on public.personal_radar_people(company_id) where active;
alter table public.personal_radar_people enable row level security;
revoke all on public.personal_radar_people from public, anon, authenticated;

create function mavi_private.personal_radar_config(c uuid) returns public.personal_radar_settings
language sql stable security definer set search_path = '' as $$
 select coalesce((select s from public.personal_radar_settings s where s.company_id = c),
  row(c, 15, 30, 10, null, now())::public.personal_radar_settings)
$$;

-- O gasto do mês (fuso de São Paulo) e o teto da pessoa.
create function mavi_private.personal_radar_spent(c uuid, u uuid) returns numeric
language sql stable security definer set search_path = '' as $$
 select coalesce(sum(a.cost_usd), 0) from public.ai_usage a
 where a.company_id = c and a.user_id = u and a.module = 'personal_radar'
  and a.created_at >= (date_trunc('month', now() at time zone 'America/Sao_Paulo') at time zone 'America/Sao_Paulo')
$$;
create function mavi_private.personal_radar_cap(c uuid, u uuid) returns numeric
language sql stable security definer set search_path = '' as $$
 select coalesce((select p.cap_usd from public.personal_radar_people p where p.company_id = c and p.user_id = u),
  (mavi_private.personal_radar_config(c)).monthly_cap_usd)
$$;

-- Alguém da empresa usando (a varredura fica mais frequente).
create function mavi_private.personal_radar_on(c uuid) returns boolean
language sql stable security definer set search_path = '' as $$
 select exists (select 1 from public.personal_radar_people p where p.company_id = c and p.active
  and mavi_private.personal_radar_allowed(c, p.user_id))
$$;

-- ------------------------------------------------------------ participantes dos grupos
alter table public.whatsapp_groups add column members_at timestamptz,
 add column members_claimed_at timestamptz,
 add column members_error text,
 add column member_count integer;

create table public.whatsapp_group_members (
 company_id uuid not null,
 group_id uuid not null,
 -- Quem é: a chave do celular (mavi_private.phone_key) ou, sem número, o JID.
 key text not null check (length(key) between 3 and 200),
 jid text not null default '',
 lid text not null default '',
 phone text not null default '' check (phone = '' or phone ~ '^\d{8,15}$'),
 phone_key text,
 name text not null default '' check (length(name) <= 200),
 is_admin boolean not null default false,
 seen_at timestamptz not null default now(),
 primary key (group_id, key),
 foreign key (company_id, group_id) references public.whatsapp_groups(company_id, id) on delete cascade
);
create index whatsapp_group_members_phone on public.whatsapp_group_members(company_id, phone_key) where phone_key is not null;
create index whatsapp_group_members_lid on public.whatsapp_group_members(group_id, lid) where lid <> '';
alter table public.whatsapp_group_members enable row level security;
revoke all on public.whatsapp_group_members from public, anon, authenticated;

-- Com alguém usando o Radar pessoal, a varredura roda no ritmo dele.
create function mavi_private.whatsapp_sweep_every(cfg mavi_private.whatsapp_config) returns interval
language sql stable security definer set search_path = '' as $$
 select case when mavi_private.personal_radar_on(cfg.company_id)
  then least(make_interval(hours => cfg.sweep_hours),
   make_interval(mins => (mavi_private.personal_radar_config(cfg.company_id)).interval_minutes))
  else make_interval(hours => cfg.sweep_hours) end
$$;

-- Os participantes de um grupo ficam velhos em 12 horas; só lidos com alguém
-- usando o Radar pessoal.
create function mavi_private.whatsapp_members_due(c uuid) returns boolean
language sql stable security definer set search_path = '' as $$
 select mavi_private.personal_radar_on(c) and exists (select 1 from public.whatsapp_groups g
  where g.company_id = c and g.client_id is not null and not g.ignored
   and (g.members_at is null or g.members_at < now() - interval '12 hours')
   and (g.members_claimed_at is null or g.members_claimed_at < now() - interval '5 minutes'))
$$;

-- A da migração 20261027150000, no ritmo do Radar pessoal e com os participantes.
create or replace function public.whatsapp_worker_state(p_secret text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare cfg mavi_private.whatsapp_config; begin
 select * into cfg from mavi_private.whatsapp_config where id;
 if cfg.company_id is null or mavi_private.whatsapp_company(p_secret) is null then
  raise exception 'Não autorizado' using errcode = '42501';
 end if;
 update mavi_private.whatsapp_config set last_run_at = now() where id;
 return jsonb_build_object(
  'company', cfg.company_id,
  'sweep_due', cfg.last_sweep_at is null or cfg.last_sweep_at < now() - mavi_private.whatsapp_sweep_every(cfg) + interval '1 minute',
  'members_due', mavi_private.whatsapp_members_due(cfg.company_id),
  'backfill_days', cfg.backfill_days);
end $$;

-- A da migração 20261030150000, no ritmo do Radar pessoal e com os participantes.
create or replace function mavi_private.whatsapp_kick() returns void
language plpgsql security definer set search_path = '' as $$
declare cfg mavi_private.whatsapp_config; begin
 select * into cfg from mavi_private.whatsapp_config where id;
 if not found then return; end if;
 if not (cfg.last_sweep_at is null or cfg.last_sweep_at < now() - mavi_private.whatsapp_sweep_every(cfg) + interval '1 minute'
  or exists (select 1 from public.whatsapp_groups g where g.company_id = cfg.company_id and g.client_id is not null
   and not g.ignored and (g.synced_until is null or g.last_message_at > g.synced_until)
   and (g.sync_claimed_at is null or g.sync_claimed_at < now() - interval '5 minutes'))
  or exists (select 1 from public.whatsapp_messages m where m.media_status in ('pending', 'failed')
   and m.company_id = cfg.company_id and (m.media_claimed_at is null or m.media_claimed_at < now() - interval '10 minutes'))
  or exists (select 1 from public.whatsapp_messages m where m.content_status = 'pending' and m.content_attempts < 3
   and m.company_id = cfg.company_id and (m.content_claimed_at is null or m.content_claimed_at < now() - interval '10 minutes'))
  or mavi_private.whatsapp_members_due(cfg.company_id))
 then return; end if;
 -- Uma chamada de cada vez: a anterior ainda pode estar trabalhando.
 if cfg.last_run_at > now() - interval '100 seconds' then return; end if;
 perform net.http_post(url := cfg.url, body := '{"action":"whatsapp-sync"}'::jsonb,
  headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || cfg.secret),
  timeout_milliseconds := 60000);
end $$;

-- Grupos para ler os participantes (/group/info), reservados por 5 minutos.
create function public.whatsapp_claim_members(p_secret text, p_limit integer default 10)
returns table(id uuid, jid text)
language plpgsql security definer set search_path = '' as $$
#variable_conflict use_column
declare c uuid := mavi_private.whatsapp_company(p_secret); begin
 if c is null then raise exception 'Não autorizado' using errcode = '42501'; end if;
 if not mavi_private.personal_radar_on(c) then return; end if;
 return query
 with picked as (
  select g.id from public.whatsapp_groups g
  where g.company_id = c and g.client_id is not null and not g.ignored
   and (g.members_at is null or g.members_at < now() - interval '12 hours')
   and (g.members_claimed_at is null or g.members_claimed_at < now() - interval '5 minutes')
  order by g.members_at nulls first, g.last_message_at desc nulls last
  limit least(greatest(coalesce(p_limit, 10), 1), 40)
  for update skip locked
 )
 update public.whatsapp_groups g set members_claimed_at = now()
 from picked where g.id = picked.id
 returning g.id, g.jid;
end $$;

-- Os participantes lidos: p_members = [{jid, lid, phone, name, admin}]. A
-- lista troca inteira (quem saiu do grupo sai daqui). Com erro, a lista fica
-- como estava e o grupo volta em 12 horas.
create function public.whatsapp_store_members(p_secret text, p_group uuid, p_members jsonb,
 p_error text default null) returns integer
language plpgsql security definer set search_path = '' as $$
declare c uuid := mavi_private.whatsapp_company(p_secret); n integer := 0; begin
 if c is null then raise exception 'Não autorizado' using errcode = '42501'; end if;
 if not exists (select 1 from public.whatsapp_groups where company_id = c and id = p_group) then return 0; end if;
 if p_error is null then
  with d as (
   select left(coalesce(m->>'jid', ''), 200) as jid, left(coalesce(m->>'lid', ''), 200) as lid,
    case when regexp_replace(coalesce(m->>'phone', ''), '\D', '', 'g') ~ '^\d{8,15}$'
     then regexp_replace(m->>'phone', '\D', '', 'g') else '' end as phone,
    left(coalesce(m->>'name', ''), 200) as name, coalesce((m->>'admin')::boolean, false) as is_admin
   from jsonb_array_elements(case when jsonb_typeof(p_members) = 'array' then p_members else '[]' end) m
   where jsonb_typeof(m) = 'object'
  ), k as (
   select distinct on (x.key) x.* from (
    select coalesce(mavi_private.phone_key(nullif(d.phone, '')), nullif(d.lid, ''), nullif(d.jid, '')) as key,
     d.jid, d.lid, d.phone, mavi_private.phone_key(nullif(d.phone, '')) as phone_key, d.name, d.is_admin
    from d
   ) x where length(coalesce(x.key, '')) >= 3
   order by x.key, (x.phone <> '') desc
  ), gone as (
   delete from public.whatsapp_group_members w where w.group_id = p_group
    and not exists (select 1 from k where k.key = w.key)
   returning 1
  ), saved as (
   insert into public.whatsapp_group_members as w (company_id, group_id, key, jid, lid, phone, phone_key, name, is_admin, seen_at)
   select c, p_group, k.key, k.jid, k.lid, k.phone, k.phone_key, k.name, k.is_admin, now() from k
   on conflict (group_id, key) do update set jid = excluded.jid, lid = excluded.lid, phone = excluded.phone,
    phone_key = excluded.phone_key, name = excluded.name, is_admin = excluded.is_admin, seen_at = now()
   returning 1
  ) select count(*) into n from saved;
 end if;
 update public.whatsapp_groups set members_claimed_at = null,
  members_at = now(),
  members_error = left(p_error, 500),
  member_count = case when p_error is null then n else member_count end
 where company_id = c and id = p_group;
 return n;
end $$;

revoke all on function mavi_private.personal_radar_allowed(uuid, uuid), mavi_private.personal_radar_config(uuid),
 mavi_private.personal_radar_spent(uuid, uuid), mavi_private.personal_radar_cap(uuid, uuid),
 mavi_private.personal_radar_on(uuid), mavi_private.whatsapp_sweep_every(mavi_private.whatsapp_config),
 mavi_private.whatsapp_members_due(uuid) from public, anon, authenticated;
revoke all on function public.whatsapp_claim_members(text, integer),
 public.whatsapp_store_members(text, uuid, jsonb, text) from public, anon, authenticated;
grant execute on function public.whatsapp_claim_members(text, integer),
 public.whatsapp_store_members(text, uuid, jsonb, text) to anon, authenticated;

-- ------------------------------------------------------------ quem está em cada grupo
-- A pessoa de um celular (qualquer pessoa da empresa).
create function mavi_private.personal_radar_phone_user(c uuid, p_key text) returns uuid
language sql stable security definer set search_path = '' as $$
 select p.user_id from mavi_private.user_phones p
 join public.memberships m on m.company_id = c and m.user_id = p.user_id
 where p_key is not null and p.key = p_key
 order by m.active desc, p.position limit 1
$$;

-- Quem a MAVI lê num grupo agora: ligou, tem o módulo, o cliente é de uma
-- equipe dela, está no grupo e não chegou ao teto do mês. "Está no grupo" é
-- a lista de participantes; antes de ela ser lida pela primeira vez, vale ter
-- falado no grupo nos últimos 60 dias.
create function mavi_private.personal_radar_candidates(c uuid, p_group uuid) returns setof uuid
language sql stable security definer set search_path = '' as $$
 select p.user_id from public.personal_radar_people p
 join public.whatsapp_groups g on g.company_id = c and g.id = p_group and g.client_id is not null and not g.ignored
 where p.company_id = c and p.active and mavi_private.personal_radar_allowed(c, p.user_id)
  and g.client_id = any(mavi_private.served_clients_of(c, p.user_id))
  and (exists (select 1 from public.whatsapp_group_members w
    join mavi_private.user_phones up on up.key = w.phone_key and up.user_id = p.user_id
    where w.group_id = g.id)
   or (g.member_count is null and exists (select 1 from mavi_private.user_phones up
    where up.user_id = p.user_id and exists (select 1 from public.whatsapp_messages w
     where w.company_id = c and w.group_id = g.id and w.sender_phone <> ''
      and mavi_private.phone_key(w.sender_phone) = up.key and w.sent_at > now() - interval '60 days'))))
  and mavi_private.personal_radar_spent(c, p.user_id) < mavi_private.personal_radar_cap(c, p.user_id)
$$;

-- Os celulares de quem usa (o filtro rápido antes de olhar cada grupo).
create function mavi_private.personal_radar_keys(c uuid) returns text[]
language sql stable security definer set search_path = '' as $$
 select coalesce(array_agg(distinct up.key), '{}') from public.personal_radar_people p
 join mavi_private.user_phones up on up.user_id = p.user_id
 where p.company_id = c and p.active
$$;

-- O grupo pode ter alguém para ler (filtro rápido; a conta certa é a de
-- personal_radar_candidates).
create function mavi_private.personal_radar_maybe(g public.whatsapp_groups) returns boolean
language sql stable security definer set search_path = '' as $$
 select g.member_count is null or exists (select 1 from public.whatsapp_group_members w
  where w.group_id = g.id and w.phone_key = any(mavi_private.personal_radar_keys(g.company_id)))
$$;

-- Os grupos de uma pessoa (sem olhar se ligou nem o teto: o que ela teria).
create function mavi_private.personal_radar_groups_of(c uuid, u uuid) returns setof uuid
language sql stable security definer set search_path = '' as $$
 select g.id from public.whatsapp_groups g
 where g.company_id = c and g.client_id is not null and not g.ignored
  and g.client_id = any(mavi_private.served_clients_of(c, u))
  and (exists (select 1 from public.whatsapp_group_members w
    join mavi_private.user_phones up on up.key = w.phone_key and up.user_id = u
    where w.group_id = g.id)
   or (g.member_count is null and exists (select 1 from mavi_private.user_phones up where up.user_id = u
    and exists (select 1 from public.whatsapp_messages w where w.company_id = c and w.group_id = g.id
     and w.sender_phone <> '' and mavi_private.phone_key(w.sender_phone) = up.key
     and w.sent_at > now() - interval '60 days'))))
$$;

-- ------------------------------------------------------------ fila e itens
-- Um por grupo: até onde a MAVI já leu.
create table public.personal_radar_groups (
 group_id uuid primary key,
 company_id uuid not null,
 cursor_at timestamptz,
 cursor_id uuid,
 -- Conferido até aqui sem nada novo (o cursor não anda sem mensagem lida).
 checked_until timestamptz,
 claimed_until timestamptz,
 retry_at timestamptz,
 attempts integer not null default 0,
 last_error text,
 read_at timestamptz,
 cost_usd numeric(12,6) not null default 0,
 foreign key (company_id, group_id) references public.whatsapp_groups(company_id, id) on delete cascade
);
alter table public.personal_radar_groups enable row level security;
revoke all on public.personal_radar_groups from public, anon, authenticated;

create table public.personal_radar_items (
 id uuid primary key default gen_random_uuid(),
 company_id uuid not null,
 client_id uuid not null,
 group_id uuid not null,
 kind text not null check (kind in ('question', 'request', 'complaint', 'material', 'approval', 'deadline')),
 title text not null check (length(title) between 3 and 200),
 summary text not null default '' check (length(summary) <= 1500),
 -- 0 baixa · 1 normal · 2 alta · 3 urgente.
 urgency smallint not null default 1 check (urgency between 0 and 3),
 status text not null default 'open' check (status in ('open', 'resolved')),
 -- Quantas vezes o cliente trouxe o assunto (mensagens distintas).
 asks integer not null default 1 check (asks >= 1),
 first_at timestamptz not null,
 last_at timestamptz not null,
 resolved_at timestamptz,
 resolved_how text check (resolved_how in ('auto', 'person')),
 resolved_by uuid,
 resolved_by_name text,
 resolved_message uuid,
 reopened_at timestamptz,
 task_id uuid,
 radar_item_id uuid,
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 search tsvector generated always as (
  to_tsvector('portuguese'::regconfig, left(coalesce(title, '') || ' ' || coalesce(summary, ''), 4000))
 ) stored,
 unique (company_id, id),
 foreign key (company_id, group_id) references public.whatsapp_groups(company_id, id) on delete cascade,
 foreign key (company_id, client_id) references public.clients(company_id, id) on delete cascade
);
create index personal_radar_items_group on public.personal_radar_items(group_id, status, last_at desc);
create index personal_radar_items_search on public.personal_radar_items using gin(search);
alter table public.personal_radar_items enable row level security;
revoke all on public.personal_radar_items from public, anon, authenticated;

create table public.personal_radar_owners (
 company_id uuid not null,
 item_id uuid not null references public.personal_radar_items(id) on delete cascade,
 user_id uuid not null,
 reason text not null check (reason in ('mention', 'reply', 'role', 'general')),
 why text not null default '' check (length(why) <= 300),
 state text not null default 'open' check (state in ('open', 'dismissed')),
 dismissed_reason text check (dismissed_reason in ('not_mine', 'not_situation', 'already_resolved', 'other')),
 dismissed_note text check (length(dismissed_note) <= 1000),
 dismissed_at timestamptz,
 created_at timestamptz not null default now(),
 primary key (item_id, user_id),
 foreign key (company_id, user_id) references public.memberships(company_id, user_id) on delete cascade
);
create index personal_radar_owners_user on public.personal_radar_owners(company_id, user_id, state);
alter table public.personal_radar_owners enable row level security;
revoke all on public.personal_radar_owners from public, anon, authenticated;

create table public.personal_radar_mentions (
 id uuid primary key default gen_random_uuid(),
 company_id uuid not null,
 item_id uuid not null references public.personal_radar_items(id) on delete cascade,
 message_id uuid not null,
 role text not null check (role in ('client', 'team')),
 speaker text not null default '' check (length(speaker) <= 200),
 quote text not null default '' check (length(quote) <= 700),
 at timestamptz not null,
 unique (item_id, message_id)
);
create index personal_radar_mentions_message on public.personal_radar_mentions(message_id);
alter table public.personal_radar_mentions enable row level security;
revoke all on public.personal_radar_mentions from public, anon, authenticated;

-- Tudo o que a pessoa faz com os itens: o que a MAVI aprende (Fases 2 e 3
-- leem daqui; a Fase 1 já usa os "não é comigo" como exemplos).
create table public.personal_radar_feedback (
 id uuid primary key default gen_random_uuid(),
 company_id uuid not null,
 item_id uuid references public.personal_radar_items(id) on delete set null,
 user_id uuid not null,
 action text not null check (action in ('not_mine', 'not_situation', 'already_resolved', 'other', 'resolved',
  'reopened', 'approved', 'edited', 'rejected', 'training')),
 note text not null default '' check (length(note) <= 4000),
 snapshot jsonb not null default '{}' check (jsonb_typeof(snapshot) = 'object'),
 learned_at timestamptz,
 created_at timestamptz not null default now(),
 foreign key (company_id, user_id) references public.memberships(company_id, user_id) on delete cascade
);
create index personal_radar_feedback_user on public.personal_radar_feedback(company_id, user_id, created_at desc);
alter table public.personal_radar_feedback enable row level security;
revoke all on public.personal_radar_feedback from public, anon, authenticated;

-- O nome de quem falou: a pessoa da empresa pelo celular, o número da
-- agência ou o nome do WhatsApp.
create function mavi_private.personal_radar_who(m public.whatsapp_messages) returns text
language sql stable security definer set search_path = '' as $$
 select coalesce((select mm.name from public.memberships mm where mm.company_id = m.company_id
   and mm.user_id = mavi_private.personal_radar_phone_user(m.company_id, mavi_private.phone_key(nullif(m.sender_phone, '')))),
  mavi_private.whatsapp_sender(m))
$$;

-- As pessoas citadas numa mensagem (menções da Uazapi, por JID ou LID, e "@número" no texto).
create function mavi_private.personal_radar_mentioned(m public.whatsapp_messages) returns uuid[]
language sql stable security definer set search_path = '' as $$
 select coalesce(array_agg(distinct u) filter (where u is not null), '{}') from (
  select mavi_private.personal_radar_phone_user(m.company_id, coalesce(
    (select w.phone_key from public.whatsapp_group_members w where w.group_id = m.group_id
      and (w.lid = j or w.jid = j or (w.lid <> '' and split_part(w.lid, '@', 1) = split_part(j, '@', 1))) limit 1),
    case when j !~ '@lid$' and regexp_replace(split_part(j, '@', 1), '\D', '', 'g') ~ '^\d{10,15}$'
     then mavi_private.phone_key(regexp_replace(split_part(j, '@', 1), '\D', '', 'g')) end)) as u
  from (
   select x as j from jsonb_array_elements_text(case when jsonb_typeof(m.extra->'mentions') = 'array'
    then m.extra->'mentions' else '[]' end) x
   union
   select t[1] from regexp_matches(coalesce(m.body, ''), '@(\d{8,16})', 'g') t
  ) s
 ) q
$$;

revoke all on function mavi_private.personal_radar_keys(uuid), mavi_private.personal_radar_maybe(public.whatsapp_groups)
 from public, anon, authenticated;
revoke all on function mavi_private.personal_radar_phone_user(uuid, text), mavi_private.personal_radar_candidates(uuid, uuid),
 mavi_private.personal_radar_groups_of(uuid, uuid), mavi_private.personal_radar_who(public.whatsapp_messages),
 mavi_private.personal_radar_mentioned(public.whatsapp_messages) from public, anon, authenticated;

-- ------------------------------------------------------------ worker
-- Grupos com mensagem nova desde a última leitura e alguém para ler.
create function mavi_private.personal_radar_due(c uuid) returns boolean
language sql stable security definer set search_path = '' as $$
 select exists (select 1 from public.whatsapp_groups g
  left join public.personal_radar_groups q on q.group_id = g.id
  where g.company_id = c and g.client_id is not null and not g.ignored and g.synced_until is not null
   and (q.group_id is null or ((q.claimed_until is null or q.claimed_until < now())
    and (q.retry_at is null or q.retry_at < now()) and (q.cursor_at is null or g.synced_until > greatest(q.cursor_at, q.checked_until))))
   and mavi_private.personal_radar_maybe(g)
   and exists (select 1 from mavi_private.personal_radar_candidates(c, g.id)))
$$;

-- Chamado pelo Radar do cliente a cada 2 minutos.
create function mavi_private.personal_radar_kick() returns void
language plpgsql security definer set search_path = '' as $$
declare cfg mavi_private.ai_config; begin
 select * into cfg from mavi_private.ai_config where id;
 if not found then return; end if;
 if not exists (select 1 from public.personal_radar_people p where p.active
  and mavi_private.personal_radar_due(p.company_id)) then return; end if;
 perform net.http_post(url := cfg.url, body := '{"action":"ai-personal-radar"}'::jsonb,
  headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || cfg.secret),
  timeout_milliseconds := 290000);
end $$;

-- A da migração 20270101090000, que também acorda o Radar pessoal.
create or replace function mavi_private.ai_radar_kick() returns void
language plpgsql security definer set search_path = '' as $$
declare cfg mavi_private.ai_config; begin
 begin
  perform mavi_private.radar_tick();
 exception when others then
  raise warning 'radar tick failed: %', sqlerrm;
 end;
 begin
  perform mavi_private.personal_radar_kick();
 exception when others then
  raise warning 'personal radar kick failed: %', sqlerrm;
 end;
 select * into cfg from mavi_private.ai_config where id;
 if not found then return; end if;
 if not exists (select 1 from public.radar_signals x where x.status = 'pending' and mavi_private.radar_due(x))
  and not exists (select 1 from public.radar_items i where i.theme_pending and not i.theme_locked
   and i.theme_attempts < 3 and (i.theme_claimed_until is null or i.theme_claimed_until < now()))
  and not exists (select 1 from public.radar_reports r where r.status in ('pending', 'running') and r.attempts < 3
   and (r.claimed_until is null or r.claimed_until < now()))
  and not exists (select 1 from public.radar_report_schedules s where s.active and s.next_run_at <= now()) then
  return;
 end if;
 perform net.http_post(url := cfg.url, body := '{"action":"ai-radar"}'::jsonb,
  headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || cfg.secret),
  -- O worker trabalha até 4 min (uma leitura leva até ~90 s).
  timeout_milliseconds := 290000);
end $$;

-- Reserva até p_limit grupos por 10 minutos: [{group_id, company_id}].
create function public.ai_personal_radar_claim(p_secret text, p_limit integer default 4) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_out jsonb; begin
 if not mavi_private.ai_secret_ok(p_secret) then raise exception 'Sem permissão' using errcode = '42501'; end if;
 with due as (
  select g.id, g.company_id, g.synced_until from public.whatsapp_groups g
  left join public.personal_radar_groups q on q.group_id = g.id
  where g.client_id is not null and not g.ignored and g.synced_until is not null
   and exists (select 1 from public.personal_radar_people p where p.company_id = g.company_id and p.active)
   and (q.group_id is null or ((q.claimed_until is null or q.claimed_until < now())
    and (q.retry_at is null or q.retry_at < now()) and (q.cursor_at is null or g.synced_until > greatest(q.cursor_at, q.checked_until))))
   and mavi_private.personal_radar_maybe(g)
   and exists (select 1 from mavi_private.personal_radar_candidates(g.company_id, g.id))
  order by q.cursor_at nulls first, g.synced_until desc
  limit least(greatest(coalesce(p_limit, 4), 1), 12)
 ), claimed as (
  insert into public.personal_radar_groups as q (group_id, company_id, claimed_until)
  select d.id, d.company_id, now() + interval '10 minutes' from due d
  on conflict (group_id) do update set claimed_until = excluded.claimed_until
  where q.claimed_until is null or q.claimed_until < now()
  returning q.group_id, q.company_id
 )
 select coalesce(jsonb_agg(jsonb_build_object('group_id', c.group_id, 'company_id', c.company_id)), '[]')
 into v_out from claimed c;
 return v_out;
end $$;

-- O material de um grupo reservado: as mensagens novas (até 200, com quem é
-- do time, quem foi citado e a quem a mensagem responde), um pouco da conversa
-- antes, as pessoas que a MAVI lê no grupo, os itens do grupo, as tarefas
-- abertas e o Radar do cliente. Nada novo: o grupo fica em dia e volta nulo.
create function public.ai_personal_radar_material(p_secret text, p_group uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare g public.whatsapp_groups; q public.personal_radar_groups; s public.personal_radar_settings;
 v_people uuid[]; v_keys text[]; v_from timestamptz; v_from_id uuid := '00000000-0000-0000-0000-000000000000';
 v_all jsonb; v_stop integer; v_lines jsonb; v_count integer; v_until_at timestamptz; v_until_id uuid; v_more boolean;
 v_context jsonb; v_people_json jsonb; v_items jsonb; v_tasks jsonb; v_radar jsonb; v_products jsonb; begin
 if not mavi_private.ai_secret_ok(p_secret) then raise exception 'Sem permissão' using errcode = '42501'; end if;
 select * into g from public.whatsapp_groups where id = p_group;
 select * into q from public.personal_radar_groups where group_id = p_group;
 if g.id is null or g.client_id is null or g.ignored then
  update public.personal_radar_groups set claimed_until = null where group_id = p_group;
  return null;
 end if;
 s := mavi_private.personal_radar_config(g.company_id);
 select coalesce(array_agg(u), '{}') into v_people from mavi_private.personal_radar_candidates(g.company_id, g.id) u;
 if cardinality(v_people) = 0 then
  update public.personal_radar_groups set claimed_until = null where group_id = p_group;
  return null;
 end if;
 v_from := now() - make_interval(days => s.history_days);
 if q.cursor_at is not null and q.cursor_at >= v_from then
  v_from := q.cursor_at;
  v_from_id := coalesce(q.cursor_id, v_from_id);
 end if;
 v_keys := mavi_private.team_phone_keys(g.company_id);

 -- As próximas 201 mensagens, numeradas (n) na ordem do grupo.
 select coalesce(jsonb_agg(r order by (r->>'n')::integer), '[]') into v_all from (
  select jsonb_build_object('n', row_number() over (order by w.sent_at, w.id), 'msg', w.id, 'ts', w.sent_at,
   'role', case when w.from_me or mavi_private.phone_key(nullif(w.sender_phone, '')) = any(v_keys) then 'team' else 'client' end,
   'who', mavi_private.personal_radar_who(w),
   'text', left(coalesce(mavi_private.whatsapp_line(w), ''), 2500),
   'at', to_char(w.sent_at at time zone 'America/Sao_Paulo', 'DD/MM HH24:MI'),
   'to', to_jsonb(mavi_private.personal_radar_mentioned(w)),
   'reply_to', (select mavi_private.personal_radar_phone_user(g.company_id, mavi_private.phone_key(nullif(o.sender_phone, '')))
    from public.whatsapp_messages o where o.company_id = w.company_id and o.group_id = w.group_id
     and o.wa_id = w.quoted_wa_id limit 1),
   'reply_text', (select left(mavi_private.whatsapp_line(o), 160) from public.whatsapp_messages o
    where o.company_id = w.company_id and o.group_id = w.group_id and o.wa_id = w.quoted_wa_id limit 1),
   'item', (select pm.item_id from public.personal_radar_mentions pm where pm.message_id = w.id limit 1),
   'held', (w.content_status = 'pending' and w.kind in ('audio', 'document') and w.sent_at > now() - interval '6 hours')) as r
  from (select m.id from public.whatsapp_messages m
   where m.company_id = g.company_id and m.group_id = g.id and (m.sent_at, m.id) > (v_from, v_from_id)
    and m.kind not in ('reaction', 'sticker')
   order by m.sent_at, m.id limit 201) pick
  join public.whatsapp_messages w on w.id = pick.id
 ) x;

 -- Áudio ou documento esperando o texto: a leitura para antes dele.
 select min((e->>'n')::integer) into v_stop from jsonb_array_elements(v_all) e where (e->>'held')::boolean;
 select count(*) into v_count from jsonb_array_elements(v_all) e where v_stop is null or (e->>'n')::integer < v_stop;
 v_more := v_stop is null and v_count > 200;
 v_count := least(v_count, 200);
 if v_count = 0 then
  update public.personal_radar_groups set claimed_until = null, read_at = now(), attempts = 0, last_error = null,
   retry_at = case when v_stop is not null then now() + interval '5 minutes' end,
   checked_until = case when v_stop is null then g.synced_until else checked_until end
  where group_id = p_group;
  return null;
 end if;

 select coalesce(jsonb_agg(jsonb_strip_nulls(e - 'n' - 'ts' - 'held'
    - case when jsonb_array_length(coalesce(e->'to', '[]')) = 0 then 'to' else '' end) order by (e->>'n')::integer), '[]')
 into v_lines
 from jsonb_array_elements(v_all) e where (e->>'n')::integer <= v_count;
 select (e->>'ts')::timestamptz, (e->>'msg')::uuid into v_until_at, v_until_id
 from jsonb_array_elements(v_all) e where (e->>'n')::integer = v_count;

 -- As 25 mensagens antes: contexto.
 select coalesce(jsonb_agg(jsonb_build_object('role', c.role, 'who', c.who, 'text', left(c.line, 500),
   'at', to_char(c.sent_at at time zone 'America/Sao_Paulo', 'DD/MM HH24:MI')) order by c.sent_at, c.id), '[]')
 into v_context
 from (
  select w.id, w.sent_at, mavi_private.whatsapp_line(w) as line, mavi_private.personal_radar_who(w) as who,
   case when w.from_me or mavi_private.phone_key(nullif(w.sender_phone, '')) = any(v_keys) then 'team' else 'client' end as role
  from public.whatsapp_messages w
  where w.company_id = g.company_id and w.group_id = g.id and (w.sent_at, w.id) <= (v_from, v_from_id)
   and w.kind not in ('reaction', 'sticker') and w.sent_at > v_from - interval '7 days'
  order by w.sent_at desc, w.id desc limit 25
 ) c where coalesce(c.line, '') <> '';

 -- Quem a MAVI lê: nome, equipes, o que é com a pessoa e o que ela já disse
 -- que não era com ela.
 select coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object('id', m.user_id, 'name', m.name,
   'teams', (select coalesce(jsonb_agg(distinct t.name), '[]') from public.team_members tm
     join public.teams t on t.company_id = tm.company_id and t.id = tm.team_id
     where tm.company_id = g.company_id and tm.user_id = m.user_id),
   'about', nullif(p.about, ''),
   'not_mine', (select jsonb_agg(x.title) from (select i.title from public.personal_radar_owners o
     join public.personal_radar_items i on i.id = o.item_id
     where o.company_id = g.company_id and o.user_id = m.user_id and o.state = 'dismissed'
      and o.dismissed_reason in ('not_mine', 'not_situation')
     order by o.dismissed_at desc limit 8) x))) order by m.name), '[]')
 into v_people_json
 from public.memberships m
 join public.personal_radar_people p on p.company_id = m.company_id and p.user_id = m.user_id
 where m.company_id = g.company_id and m.user_id = any(v_people);

 -- Os itens do grupo (abertos e os resolvidos nos últimos 14 dias).
 select coalesce(jsonb_agg(jsonb_build_object('id', i.id, 'kind', i.kind, 'title', i.title,
   'summary', left(i.summary, 300), 'status', i.status, 'asks', i.asks,
   'last', to_char(i.last_at at time zone 'America/Sao_Paulo', 'DD/MM HH24:MI'),
   'owners', (select coalesce(jsonb_agg(o.user_id), '[]') from public.personal_radar_owners o where o.item_id = i.id))
   order by i.last_at desc), '[]')
 into v_items
 from (select * from public.personal_radar_items i where i.group_id = g.id
  and (i.status = 'open' or i.resolved_at > now() - interval '14 days')
  order by i.last_at desc limit 60) i;

 -- As tarefas abertas do cliente e o Radar do cliente em aberto.
 select coalesce(jsonb_agg(jsonb_build_object('id', t.id, 'title', t.title, 'status', t.status,
   'assignee', t.assignee, 'due', to_char(t.due_date, 'DD/MM')) order by t.created_at desc), '[]')
 into v_tasks
 from (select tk.id, tk.title, tk.status, tk.due_date, tk.created_at, mm.name as assignee
  from public.tasks tk
  join public.contracts k on k.company_id = tk.company_id and k.id = tk.contract_id and k.client_id = g.client_id
  left join public.memberships mm on mm.company_id = tk.company_id and mm.user_id = tk.assignee_id
  where tk.company_id = g.company_id and not tk.archived and tk.status <> 'done'
  order by tk.created_at desc limit 40) t;
 select coalesce(jsonb_agg(jsonb_build_object('id', r.id, 'title', r.title, 'topic', r.topic) order by r.last_seen_at desc), '[]')
 into v_radar
 from (select i.id, i.title, t.name as topic, i.last_seen_at from public.radar_items i
  join public.radar_topics t on t.id = i.topic_id
  where i.company_id = g.company_id and i.client_id = g.client_id
   and coalesce(mavi_private.radar_status(t.statuses, i.status)->>'kind', '') <> 'closed'
  order by i.last_seen_at desc limit 25) r;
 select coalesce(jsonb_agg(p.name order by p.name), '[]') into v_products
 from public.products p where p.company_id = g.company_id and p.id in (select k.product_id from public.contracts k
  where k.company_id = g.company_id and k.client_id = g.client_id and not k.archived)
  and (cardinality(g.product_ids) = 0 or p.id = any(g.product_ids));

 return jsonb_build_object('group_id', g.id, 'company_id', g.company_id, 'client_id', g.client_id,
  'client_name', (select name from public.clients where id = g.client_id), 'group', g.title,
  'products', v_products, 'people', v_people_json, 'lines', v_lines, 'context', v_context,
  'items', v_items, 'tasks', v_tasks, 'radar', v_radar,
  'until_at', v_until_at, 'until_id', v_until_id, 'more', v_more);
end $$;

-- O resultado: {until_at, until_id, people: [ids lidos], items: [{item_id |
-- null, kind, title, summary, urgency, owners: [{user_id, reason, why}],
-- mentions: [{message_id, quote}], task_id, radar_item_id}], resolved:
-- [{item_id, message_id}], usage: {model, input, output, cache_read,
-- cache_write, cost, provider_id, provider}}. Tudo é conferido aqui: item do
-- grupo, mensagem do grupo, dono entre quem foi lido, tarefa do cliente.
create function public.ai_personal_radar_store(p_secret text, p_group uuid, p_result jsonb) returns integer
language plpgsql security definer set search_path = '' as $$
declare g public.whatsapp_groups; x jsonb; o jsonb; v_item uuid; v_new boolean; n integer := 0;
 v_people uuid[]; v_keys text[]; v_client_msgs integer; v_first timestamptz; v_last timestamptz; v_cost numeric;
 v_touched uuid[] := '{}'; v_task uuid; v_radar uuid; v_msg public.whatsapp_messages; v_owner uuid;
 v_quotes jsonb; v_last_client timestamptz; v_reopen boolean; begin
 if not mavi_private.ai_secret_ok(p_secret) then raise exception 'Sem permissão' using errcode = '42501'; end if;
 select * into g from public.whatsapp_groups where id = p_group;
 if not found then return 0; end if;
 v_keys := mavi_private.team_phone_keys(g.company_id);
 select coalesce(array_agg(distinct p.user_id), '{}') into v_people
 from jsonb_array_elements_text(case when jsonb_typeof(p_result->'people') = 'array' then p_result->'people' else '[]' end) u(id)
 join public.personal_radar_people p on p.company_id = g.company_id and p.user_id::text = lower(u.id);

 for x in select * from jsonb_array_elements(case when jsonb_typeof(p_result->'items') = 'array' then p_result->'items' else '[]' end) loop
  -- As mensagens citadas, só as do grupo.
  select coalesce(jsonb_agg(jsonb_build_object('message_id', q.id, 'quote', q.quote, 'role', q.role,
    'speaker', q.speaker, 'at', q.sent_at)), '[]')
  into v_quotes
  from (
   select distinct on (w.id) w.id, w.sent_at,
    left(coalesce(nullif(btrim(mm.quote), ''), mavi_private.whatsapp_line(w)), 700) as quote,
    case when w.from_me or mavi_private.phone_key(nullif(w.sender_phone, '')) = any(v_keys) then 'team' else 'client' end as role,
    left(mavi_private.personal_radar_who(w), 200) as speaker
   from (select (m->>'message_id')::uuid as mid, m->>'quote' as quote
    from jsonb_array_elements(case when jsonb_typeof(x->'mentions') = 'array' then x->'mentions' else '[]' end) m
    where jsonb_typeof(m) = 'object' and coalesce(m->>'message_id', '') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') mm
   join public.whatsapp_messages w on w.company_id = g.company_id and w.group_id = g.id and w.id = mm.mid
  ) q;
  continue when jsonb_array_length(v_quotes) = 0;
  select count(*) filter (where q.role = 'client'), min(q.at), max(q.at), max(q.at) filter (where q.role = 'client')
  into v_client_msgs, v_first, v_last, v_last_client
  from jsonb_to_recordset(v_quotes) q(message_id uuid, quote text, role text, speaker text, at timestamptz);
  v_task := case when (x->>'task_id') ~* '^[0-9a-f-]{36}$' then (select tk.id from public.tasks tk
   join public.contracts k on k.company_id = tk.company_id and k.id = tk.contract_id and k.client_id = g.client_id
   where tk.company_id = g.company_id and tk.id = (x->>'task_id')::uuid) end;
  v_radar := case when (x->>'radar_item_id') ~* '^[0-9a-f-]{36}$' then (select i.id from public.radar_items i
   where i.company_id = g.company_id and i.client_id = g.client_id and i.id = (x->>'radar_item_id')::uuid) end;
  v_item := case when (x->>'item_id') ~* '^[0-9a-f-]{36}$' then (select i.id from public.personal_radar_items i
   where i.group_id = g.id and i.id = (x->>'item_id')::uuid) end;
  v_new := v_item is null;
  if v_new then
   -- Item novo: precisa de título, do tipo e de uma fala do cliente.
   continue when coalesce(length(btrim(x->>'title')), 0) < 3 or v_client_msgs = 0
    or coalesce(x->>'kind', '') not in ('question', 'request', 'complaint', 'material', 'approval', 'deadline');
   insert into public.personal_radar_items(company_id, client_id, group_id, kind, title, summary, urgency, asks,
    first_at, last_at, task_id, radar_item_id)
   values (g.company_id, g.client_id, g.id, x->>'kind', left(btrim(x->>'title'), 200), left(coalesce(x->>'summary', ''), 1500),
    least(greatest(coalesce((x->>'urgency')::integer, 1), 0), 3), greatest(v_client_msgs, 1), v_first, v_last, v_task, v_radar)
   returning id into v_item;
  else
   -- Item que já existe: soma as cobranças novas, sobe a urgência e reabre
   -- quando o cliente volta ao assunto depois de resolvido.
   select i.status = 'resolved' and v_last_client is not null and v_last_client > coalesce(i.resolved_at, i.last_at)
   into v_reopen from public.personal_radar_items i where i.id = v_item;
   update public.personal_radar_items i set
    asks = i.asks + (select count(*) from jsonb_to_recordset(v_quotes) pq(message_id uuid, role text) where pq.role = 'client'
     and not exists (select 1 from public.personal_radar_mentions pm where pm.item_id = i.id and pm.message_id = pq.message_id)),
    last_at = greatest(i.last_at, v_last),
    summary = case when coalesce(btrim(x->>'summary'), '') <> '' then left(x->>'summary', 1500) else i.summary end,
    urgency = greatest(i.urgency, least(greatest(coalesce((x->>'urgency')::integer, 0), 0), 3)),
    task_id = coalesce(v_task, i.task_id),
    radar_item_id = coalesce(v_radar, i.radar_item_id),
    status = case when v_reopen then 'open' else i.status end,
    reopened_at = case when v_reopen then now() else i.reopened_at end,
    resolved_at = case when v_reopen then null else i.resolved_at end,
    resolved_how = case when v_reopen then null else i.resolved_how end,
    resolved_by = case when v_reopen then null else i.resolved_by end,
    resolved_by_name = case when v_reopen then null else i.resolved_by_name end,
    resolved_message = case when v_reopen then null else i.resolved_message end,
    updated_at = now()
   where i.id = v_item;
  end if;
  insert into public.personal_radar_mentions(company_id, item_id, message_id, role, speaker, quote, at)
  select g.company_id, v_item, pq.message_id, pq.role, pq.speaker, pq.quote, pq.at
  from jsonb_to_recordset(v_quotes) pq(message_id uuid, quote text, role text, speaker text, at timestamptz)
  on conflict (item_id, message_id) do nothing;
  -- Os donos, só entre quem foi lido. Quem disse que não era com ela não volta.
  for o in select * from jsonb_array_elements(case when jsonb_typeof(x->'owners') = 'array' then x->'owners' else '[]' end) loop
   v_owner := case when (o->>'user_id') ~* '^[0-9a-f-]{36}$' then (o->>'user_id')::uuid end;
   continue when v_owner is null or not v_owner = any(v_people);
   insert into public.personal_radar_owners(company_id, item_id, user_id, reason, why)
   values (g.company_id, v_item, v_owner,
    case when o->>'reason' in ('mention', 'reply', 'role', 'general') then o->>'reason' else 'role' end,
    left(coalesce(o->>'why', ''), 300))
   on conflict (item_id, user_id) do update set
    reason = case when excluded.reason in ('mention', 'reply') and public.personal_radar_owners.reason not in ('mention', 'reply')
     then excluded.reason else public.personal_radar_owners.reason end,
    why = case when excluded.reason in ('mention', 'reply') and public.personal_radar_owners.reason not in ('mention', 'reply')
     then excluded.why else public.personal_radar_owners.why end;
  end loop;
  -- Sem dono nenhum, o item não aparece para ninguém: vai para todos os lidos.
  if not exists (select 1 from public.personal_radar_owners where item_id = v_item) then
   insert into public.personal_radar_owners(company_id, item_id, user_id, reason, why)
   select g.company_id, v_item, u, 'general', 'Ninguém do time foi citado; assunto geral do cliente.' from unnest(v_people) u
   on conflict do nothing;
  end if;
  v_touched := v_touched || v_item;
  n := n + case when v_new then 1 else 0 end;
 end loop;

 -- Resolvidos: só por uma fala do time no grupo, depois da última do cliente.
 for x in select * from jsonb_array_elements(case when jsonb_typeof(p_result->'resolved') = 'array' then p_result->'resolved' else '[]' end) loop
  continue when coalesce(x->>'item_id', '') !~* '^[0-9a-f-]{36}$' or coalesce(x->>'message_id', '') !~* '^[0-9a-f-]{36}$';
  select * into v_msg from public.whatsapp_messages w where w.company_id = g.company_id and w.group_id = g.id
   and w.id = (x->>'message_id')::uuid;
  continue when v_msg.id is null
   or not (v_msg.from_me or mavi_private.phone_key(nullif(v_msg.sender_phone, '')) = any(v_keys));
  update public.personal_radar_items i set status = 'resolved', resolved_at = v_msg.sent_at, resolved_how = 'auto',
   resolved_by = mavi_private.personal_radar_phone_user(g.company_id, mavi_private.phone_key(nullif(v_msg.sender_phone, ''))),
   resolved_by_name = left(mavi_private.personal_radar_who(v_msg), 200), resolved_message = v_msg.id, updated_at = now()
  where i.group_id = g.id and i.id = (x->>'item_id')::uuid and i.status = 'open' and v_msg.sent_at >= i.last_at;
  if found then
   insert into public.personal_radar_mentions(company_id, item_id, message_id, role, speaker, quote, at)
   values (g.company_id, (x->>'item_id')::uuid, v_msg.id, 'team', left(mavi_private.personal_radar_who(v_msg), 200),
    left(mavi_private.whatsapp_line(v_msg), 700), v_msg.sent_at)
   on conflict (item_id, message_id) do nothing;
   v_touched := v_touched || (x->>'item_id')::uuid;
  end if;
 end loop;

 -- O custo, dividido entre quem foi lido.
 v_cost := least(greatest(coalesce((p_result->'usage'->>'cost')::numeric, 0), 0), 100);
 if cardinality(v_people) > 0 and (v_cost > 0 or coalesce((p_result->'usage'->>'input')::integer, 0) > 0) then
  insert into public.ai_usage(company_id, user_id, module, kind, client_id, model, input_tokens, output_tokens,
   cache_read_tokens, cache_write_tokens, cost_usd, provider_id, provider_name)
  select g.company_id, u, 'personal_radar', 'detect', g.client_id, left(coalesce(p_result->'usage'->>'model', ''), 80),
   coalesce((p_result->'usage'->>'input')::integer, 0) / cardinality(v_people),
   coalesce((p_result->'usage'->>'output')::integer, 0) / cardinality(v_people),
   coalesce((p_result->'usage'->>'cache_read')::integer, 0) / cardinality(v_people),
   coalesce((p_result->'usage'->>'cache_write')::integer, 0) / cardinality(v_people),
   round(v_cost / cardinality(v_people), 6),
   case when (p_result->'usage'->>'provider_id') ~* '^[0-9a-f-]{36}$' then (p_result->'usage'->>'provider_id')::uuid end,
   left(coalesce(p_result->'usage'->>'provider', ''), 120)
  from unnest(v_people) u;
 end if;

 update public.personal_radar_groups set claimed_until = null, read_at = now(), attempts = 0, last_error = null,
  retry_at = null, cost_usd = cost_usd + v_cost,
  cursor_at = coalesce((p_result->>'until_at')::timestamptz, cursor_at),
  cursor_id = case when (p_result->>'until_id') ~* '^[0-9a-f-]{36}$' then (p_result->>'until_id')::uuid else cursor_id end
 where group_id = p_group;
 if cardinality(v_touched) > 0 then
  perform mavi_private.broadcast(g.company_id, jsonb_build_object('kind', 'personal_radar',
   'people', (select coalesce(jsonb_agg(distinct o.user_id), '[]') from public.personal_radar_owners o
    where o.item_id = any(v_touched))));
 end if;
 return n;
end $$;

-- Deu erro: tenta de novo em (tentativas × 10) minutos; depois de 5, em 6 horas.
create function public.ai_personal_radar_fail(p_secret text, p_group uuid, p_error text) returns void
language plpgsql security definer set search_path = '' as $$ begin
 if not mavi_private.ai_secret_ok(p_secret) then raise exception 'Sem permissão' using errcode = '42501'; end if;
 update public.personal_radar_groups set claimed_until = null, attempts = attempts + 1, last_error = left(p_error, 1000),
  retry_at = now() + case when attempts + 1 >= 5 then interval '6 hours' else make_interval(mins => (attempts + 1) * 10) end
 where group_id = p_group;
end $$;

revoke all on function mavi_private.personal_radar_due(uuid), mavi_private.personal_radar_kick() from public, anon, authenticated;
revoke all on function public.ai_personal_radar_claim(text, integer), public.ai_personal_radar_material(text, uuid),
 public.ai_personal_radar_store(text, uuid, jsonb), public.ai_personal_radar_fail(text, uuid, text) from public, anon, authenticated;
grant execute on function public.ai_personal_radar_claim(text, integer), public.ai_personal_radar_material(text, uuid),
 public.ai_personal_radar_store(text, uuid, jsonb), public.ai_personal_radar_fail(text, uuid, text) to anon, authenticated;

-- ------------------------------------------------------------ a pessoa
-- De quem a pessoa vê a lista: a dela; administradores, todas; gestores, as
-- de quem não é administrador; supervisores, as da equipe.
create function mavi_private.personal_radar_can_view(c uuid, u uuid) returns boolean
language sql stable security definer set search_path = '' as $$
 select mavi_private.member(c) and (u = auth.uid() or mavi_private.admin(c)
  or (mavi_private.leader(c) and not exists (select 1 from public.memberships m where m.company_id = c and m.user_id = u
   and m.role = 'admin'))
  or mavi_private.supervises(c, u))
$$;
revoke all on function mavi_private.personal_radar_can_view(uuid, uuid) from public, anon, authenticated;

-- O estado da tela: se a pessoa tem o módulo, se ligou, o que é com ela, o
-- gasto do mês, os grupos dela, de quem mais ela vê e o que pode configurar.
create function public.personal_radar_state(p_company uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_me uuid := auth.uid(); p public.personal_radar_people; s public.personal_radar_settings; begin
 if not mavi_private.member(p_company) then raise exception 'Sem permissão' using errcode = '42501'; end if;
 select * into p from public.personal_radar_people where company_id = p_company and user_id = v_me;
 s := mavi_private.personal_radar_config(p_company);
 return jsonb_build_object(
  'allowed', mavi_private.personal_radar_allowed(p_company, v_me),
  'active', coalesce(p.active, false),
  'started_at', p.started_at,
  'about', coalesce(p.about, ''),
  'spent', mavi_private.personal_radar_spent(p_company, v_me),
  'cap', mavi_private.personal_radar_cap(p_company, v_me),
  'groups', (select count(*) from mavi_private.personal_radar_groups_of(p_company, v_me)),
  'phones', (select count(*) from mavi_private.user_phones where user_id = v_me),
  'whatsapp', exists (select 1 from mavi_private.whatsapp_config where id and company_id = p_company),
  'settings', jsonb_build_object('interval_minutes', s.interval_minutes, 'history_days', s.history_days,
   'monthly_cap_usd', s.monthly_cap_usd),
  'can_interval', mavi_private.leader(p_company),
  'can_configure', mavi_private.admin(p_company),
  'viewable', (select coalesce(jsonb_agg(jsonb_build_object('id', m.user_id, 'name', m.name) order by m.name), '[]')
   from public.memberships m join public.personal_radar_people pp on pp.company_id = m.company_id
    and pp.user_id = m.user_id and pp.started_at is not null
   where m.company_id = p_company and m.active and m.user_id <> v_me
    and mavi_private.personal_radar_can_view(p_company, m.user_id)));
end $$;

-- Ligar/desligar e "O que é comigo" (só a própria pessoa). Na primeira vez,
-- a MAVI volta history_days dias nos grupos da pessoa.
create function public.set_personal_radar(p_company uuid, p_active boolean, p_about text default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_me uuid := auth.uid(); v_first boolean; s public.personal_radar_settings; begin
 if not mavi_private.member(p_company) then raise exception 'Sem permissão' using errcode = '42501'; end if;
 if coalesce(p_active, false) and not mavi_private.personal_radar_allowed(p_company, v_me) then
  raise exception 'O Radar pessoal ainda não foi liberado para você. Peça a um administrador.' using errcode = '42501';
 end if;
 if length(coalesce(p_about, '')) > 1500 then
  raise exception 'Descreva em até 1.500 caracteres.' using errcode = '22023';
 end if;
 select started_at is null into v_first from public.personal_radar_people where company_id = p_company and user_id = v_me;
 v_first := coalesce(v_first, true) and coalesce(p_active, false);
 insert into public.personal_radar_people as p (company_id, user_id, active, started_at, about)
 values (p_company, v_me, coalesce(p_active, false), case when p_active then now() end, coalesce(btrim(p_about), ''))
 on conflict (company_id, user_id) do update set active = excluded.active,
  started_at = coalesce(p.started_at, excluded.started_at),
  about = case when p_about is null then p.about else excluded.about end,
  updated_at = now();
 -- A primeira vez: os grupos dela voltam ao começo do histórico (o que já
 -- foi lido para outra pessoa não se repete: as falas já ligadas a um item
 -- vão marcadas, e ela só entra como dona).
 if v_first then
  s := mavi_private.personal_radar_config(p_company);
  update public.personal_radar_groups q set cursor_at = least(q.cursor_at, now() - make_interval(days => s.history_days)),
   cursor_id = '00000000-0000-0000-0000-000000000000'
  where q.company_id = p_company and q.group_id in (select mavi_private.personal_radar_groups_of(p_company, v_me))
   and q.cursor_at > now() - make_interval(days => s.history_days);
 end if;
 return public.personal_radar_state(p_company);
end $$;

-- Ritmo (administrador ou gestor), histórico e teto (administrador).
create function public.set_personal_radar_settings(p_company uuid, p_interval integer, p_history integer default null,
 p_cap numeric default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare s public.personal_radar_settings := mavi_private.personal_radar_config(p_company); begin
 if not mavi_private.leader(p_company) then
  raise exception 'Só administradores e gestores mudam o ritmo do Radar pessoal.' using errcode = '42501';
 end if;
 if (p_history is not null and p_history is distinct from s.history_days or p_cap is not null and p_cap is distinct from s.monthly_cap_usd)
  and not mavi_private.admin(p_company) then
  raise exception 'Só administradores mudam o histórico e o teto.' using errcode = '42501';
 end if;
 if coalesce(p_interval, s.interval_minutes) not between 5 and 60 then
  raise exception 'Escolha entre 5 e 60 minutos.' using errcode = '22023';
 end if;
 if coalesce(p_history, s.history_days) not between 1 and 60 then
  raise exception 'Escolha entre 1 e 60 dias.' using errcode = '22023';
 end if;
 if coalesce(p_cap, s.monthly_cap_usd) not between 0 and 1000 then
  raise exception 'Escolha um teto entre US$ 0 e US$ 1.000.' using errcode = '22023';
 end if;
 insert into public.personal_radar_settings as x (company_id, interval_minutes, history_days, monthly_cap_usd, updated_by)
 values (p_company, coalesce(p_interval, s.interval_minutes), coalesce(p_history, s.history_days),
  coalesce(p_cap, s.monthly_cap_usd), auth.uid())
 on conflict (company_id) do update set interval_minutes = excluded.interval_minutes,
  history_days = excluded.history_days, monthly_cap_usd = excluded.monthly_cap_usd,
  updated_by = excluded.updated_by, updated_at = now();
 return public.personal_radar_state(p_company);
end $$;

-- As pessoas (administrador): liberado, ligado, gasto, teto e grupos.
create function public.personal_radar_people(p_company uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$ begin
 if not mavi_private.admin(p_company) then raise exception 'Apenas administradores' using errcode = '42501'; end if;
 return (select coalesce(jsonb_agg(jsonb_build_object('id', m.user_id, 'name', m.name, 'role', m.role,
   'allowed', mavi_private.personal_radar_allowed(p_company, m.user_id),
   'active', coalesce(p.active, false), 'started_at', p.started_at,
   'cap_usd', p.cap_usd, 'cap', mavi_private.personal_radar_cap(p_company, m.user_id),
   'spent', mavi_private.personal_radar_spent(p_company, m.user_id),
   'groups', (select count(*) from mavi_private.personal_radar_groups_of(p_company, m.user_id)),
   'phones', (select count(*) from mavi_private.user_phones up where up.user_id = m.user_id))
   order by coalesce(p.active, false) desc, m.name), '[]')
  from public.memberships m
  left join public.personal_radar_people p on p.company_id = m.company_id and p.user_id = m.user_id
  where m.company_id = p_company and m.active);
end $$;

-- O teto de uma pessoa (administrador); nulo volta ao da empresa.
create function public.set_personal_radar_cap(p_company uuid, p_user uuid, p_cap numeric) returns void
language plpgsql security definer set search_path = '' as $$ begin
 if not mavi_private.admin(p_company) then raise exception 'Apenas administradores' using errcode = '42501'; end if;
 if p_cap is not null and p_cap not between 0 and 1000 then
  raise exception 'Escolha um teto entre US$ 0 e US$ 1.000.' using errcode = '22023';
 end if;
 if not exists (select 1 from public.memberships where company_id = p_company and user_id = p_user) then
  raise exception 'Usuário não encontrado na empresa' using errcode = 'P0002';
 end if;
 insert into public.personal_radar_people as p (company_id, user_id, cap_usd) values (p_company, p_user, p_cap)
 on conflict (company_id, user_id) do update set cap_usd = excluded.cap_usd, updated_at = now();
end $$;

-- Um item como a tela mostra, do ponto de vista de p_user.
create function mavi_private.personal_radar_item_json(i public.personal_radar_items, p_user uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
 select jsonb_strip_nulls(jsonb_build_object('id', i.id, 'kind', i.kind, 'title', i.title, 'summary', i.summary,
  'urgency', i.urgency, 'status', i.status, 'asks', i.asks, 'first_at', i.first_at, 'last_at', i.last_at,
  'resolved_at', i.resolved_at, 'resolved_how', i.resolved_how, 'resolved_by_name', i.resolved_by_name,
  'reopened_at', i.reopened_at,
  'client', jsonb_build_object('id', i.client_id, 'name', (select k.name from public.clients k where k.id = i.client_id)),
  'group', jsonb_build_object('id', i.group_id, 'title', (select w.title from public.whatsapp_groups w where w.id = i.group_id)),
  'reason', o.reason, 'why', o.why, 'state', o.state, 'dismissed_reason', o.dismissed_reason,
  'others', (select jsonb_agg(m.name order by m.name) from public.personal_radar_owners x
   join public.memberships m on m.company_id = x.company_id and m.user_id = x.user_id
   where x.item_id = i.id and x.user_id <> p_user and x.state = 'open'),
  'mentions', (select jsonb_agg(jsonb_build_object('message_id', q.message_id, 'role', q.role, 'speaker', q.speaker,
    'quote', q.quote, 'at', q.at) order by q.at) from (select * from public.personal_radar_mentions pm
    where pm.item_id = i.id order by pm.at desc limit 4) q),
  'mention_count', (select count(*) from public.personal_radar_mentions pm where pm.item_id = i.id),
  'task', (select jsonb_build_object('id', t.id, 'title', t.title, 'status', t.status) from public.tasks t
   where t.id = i.task_id and not t.archived and (mavi_private.leader(i.company_id) or mavi_private.task_access(i.company_id, t.id))),
  'radar', (select jsonb_build_object('id', r.id, 'title', r.title) from public.radar_items r where r.id = i.radar_item_id)))
 from public.personal_radar_owners o where o.item_id = i.id and o.user_id = p_user
$$;
revoke all on function mavi_private.personal_radar_item_json(public.personal_radar_items, uuid) from public, anon, authenticated;

-- A lista: p_user (nulo = a própria pessoa) e filtros {status: open | resolved
-- | dismissed | all, kind, client, q, limit, offset}.
create function public.personal_radar_items(p_company uuid, p_user uuid default null, p_filters jsonb default '{}')
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_user uuid := coalesce(p_user, auth.uid()); f jsonb := coalesce(p_filters, '{}');
 v_status text := coalesce(nullif(f->>'status', ''), 'open'); v_q text := nullif(btrim(coalesce(f->>'q', '')), '');
 v_limit integer := least(greatest(coalesce((f->>'limit')::integer, 50), 1), 200);
 v_offset integer := greatest(coalesce((f->>'offset')::integer, 0), 0); v_out jsonb;
 v_client uuid := case when coalesce(f->>'client', '') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  then (f->>'client')::uuid end; begin
 if not mavi_private.personal_radar_can_view(p_company, v_user) then
  raise exception 'Sem permissão' using errcode = '42501';
 end if;
 with mine as (
  select i.*, o.state from public.personal_radar_owners o
  join public.personal_radar_items i on i.id = o.item_id
  where o.company_id = p_company and o.user_id = v_user
   and i.client_id = any(mavi_private.served_clients_of(p_company, v_user))
 ), base as (
  select * from mine i
  where (v_status = 'all'
    or (v_status = 'open' and i.status = 'open' and i.state = 'open')
    or (v_status = 'resolved' and i.status = 'resolved' and i.state = 'open')
    or (v_status = 'dismissed' and i.state = 'dismissed'))
   and (coalesce(f->>'kind', '') = '' or i.kind = f->>'kind')
   and (v_client is null or i.client_id = v_client)
   and (v_q is null or i.search @@ websearch_to_tsquery('portuguese', v_q) or i.title ilike '%' || v_q || '%'
    or exists (select 1 from public.clients k where k.id = i.client_id and k.name ilike '%' || v_q || '%'))
 ), page as (
  select b.*, count(*) over () as total from base b
  order by case when b.status = 'open' then 0 else 1 end, b.urgency desc, b.last_at desc, b.id
  limit v_limit offset v_offset
 )
 select jsonb_build_object(
  'total', coalesce((select max(total) from page), 0),
  'counts', (select jsonb_build_object(
    'open', count(*) filter (where status = 'open' and state = 'open'),
    'resolved', count(*) filter (where status = 'resolved' and state = 'open'),
    'dismissed', count(*) filter (where state = 'dismissed')) from mine),
  'clients', (select coalesce(jsonb_agg(distinct jsonb_build_object('id', k.id, 'name', k.name)), '[]')
   from mine m join public.clients k on k.id = m.client_id),
  'items', coalesce((select jsonb_agg(mavi_private.personal_radar_item_json(i, v_user)
    order by case when i.status = 'open' then 0 else 1 end, i.urgency desc, i.last_at desc, i.id)
   from page join public.personal_radar_items i on i.id = page.id), '[]'))
 into v_out;
 return v_out;
end $$;

-- O que a pessoa faz com um item dela: resolve, reabre, ou diz que não é
-- com ela / não é uma situação / já estava resolvido (com uma nota). Fica no
-- histórico de aprendizado.
create function public.personal_radar_act(p_company uuid, p_item uuid, p_action text, p_note text default '')
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_me uuid := auth.uid(); i public.personal_radar_items; o public.personal_radar_owners; begin
 select * into o from public.personal_radar_owners where company_id = p_company and item_id = p_item and user_id = v_me;
 if not found or not mavi_private.member(p_company) then raise exception 'Item não encontrado' using errcode = 'P0002'; end if;
 select * into i from public.personal_radar_items where id = p_item for update;
 if p_action not in ('resolved', 'reopened', 'not_mine', 'not_situation', 'already_resolved', 'other') then
  raise exception 'Ação inválida' using errcode = '22023';
 end if;
 if length(coalesce(p_note, '')) > 1000 then raise exception 'Escreva em até 1.000 caracteres.' using errcode = '22023'; end if;
 if p_action = 'resolved' then
  update public.personal_radar_items set status = 'resolved', resolved_at = now(), resolved_how = 'person',
   resolved_by = v_me, resolved_by_name = (select name from public.memberships where company_id = p_company and user_id = v_me),
   resolved_message = null, updated_at = now()
  where id = p_item and status = 'open';
 elsif p_action = 'reopened' then
  update public.personal_radar_owners set state = 'open', dismissed_reason = null, dismissed_note = null, dismissed_at = null
  where item_id = p_item and user_id = v_me;
  update public.personal_radar_items set status = 'open', resolved_at = null, resolved_how = null, resolved_by = null,
   resolved_by_name = null, resolved_message = null, reopened_at = now(), updated_at = now()
  where id = p_item and status = 'resolved';
 else
  update public.personal_radar_owners set state = 'dismissed', dismissed_reason = p_action,
   dismissed_note = nullif(btrim(coalesce(p_note, '')), ''), dismissed_at = now()
  where item_id = p_item and user_id = v_me;
  -- "Já estava resolvido" fecha para todos.
  if p_action = 'already_resolved' then
   update public.personal_radar_items set status = 'resolved', resolved_at = now(), resolved_how = 'person',
    resolved_by = v_me, resolved_by_name = (select name from public.memberships where company_id = p_company and user_id = v_me),
    updated_at = now()
   where id = p_item and status = 'open';
  end if;
 end if;
 insert into public.personal_radar_feedback(company_id, item_id, user_id, action, note, snapshot)
 values (p_company, p_item, v_me, p_action, coalesce(btrim(p_note), ''),
  jsonb_build_object('kind', i.kind, 'title', i.title, 'summary', i.summary, 'reason', o.reason, 'why', o.why));
 perform mavi_private.broadcast(p_company, jsonb_build_object('kind', 'personal_radar',
  'people', (select coalesce(jsonb_agg(x.user_id), '[]') from public.personal_radar_owners x where x.item_id = p_item)));
 select * into i from public.personal_radar_items where id = p_item;
 return mavi_private.personal_radar_item_json(i, v_me);
end $$;

revoke all on function public.personal_radar_state(uuid), public.set_personal_radar(uuid, boolean, text),
 public.set_personal_radar_settings(uuid, integer, integer, numeric), public.personal_radar_people(uuid),
 public.set_personal_radar_cap(uuid, uuid, numeric), public.personal_radar_items(uuid, uuid, jsonb),
 public.personal_radar_act(uuid, uuid, text, text) from public, anon;
grant execute on function public.personal_radar_state(uuid), public.set_personal_radar(uuid, boolean, text),
 public.set_personal_radar_settings(uuid, integer, integer, numeric), public.personal_radar_people(uuid),
 public.set_personal_radar_cap(uuid, uuid, numeric), public.personal_radar_items(uuid, uuid, jsonb),
 public.personal_radar_act(uuid, uuid, text, text) to authenticated;

commit;
