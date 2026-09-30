begin;

-- MAVI · Radar do cliente (Fase 1).
--
-- O que os clientes reclamam e o que o time promete, lido pela MAVI nas
-- reuniões gravadas (Gravações da MAVI) e nos grupos de WhatsApp, separado
-- por produto, numa base que administradores e gestores acompanham.
--
-- - Tópicos (radar_topics): o que a MAVI procura. A empresa nasce com
--   "Problemas / reclamações" (falas do cliente) e "Promessas" (falas do
--   time, com prazo). Administradores e gestores criam outros com nome,
--   explicação com exemplos, o que não conta, quem fala, fontes, status,
--   campos extras e a escala de gravidade. Um tópico da empresa pode ser
--   desligado em alguns produtos; um tópico pode ser só de um produto.
-- - Itens (radar_items): um por assunto do cliente, com status, responsável,
--   gravidade, prazo e as ocorrências (radar_mentions: o trecho, quem falou,
--   a data e o link para o momento da reunião ou a mensagem). A mesma
--   reclamação em outra reunião vira ocorrência do mesmo item; um item
--   resolvido que volta a aparecer reabre sozinho (se o status mandar).
-- - Leituras (radar_signals): uma por reunião e uma por dia de cada grupo,
--   criadas pelo trigger em ai_documents (o documento da MAVI mudou), como
--   no Termômetro. O WhatsApp é lido a cada busca (2 h), só com as mensagens
--   novas (radar_signals.seen guarda as já lidas); o resto do dia vai como
--   contexto. Áudio ou documento esperando a transcrição fica para a próxima.
--   Só entram reuniões e dias a partir de radar_settings.started_at (o
--   histórico é uma etapa própria, com o custo mostrado antes).
-- - O worker (/api/ai, ação "ai-radar", pelo pg_cron em
--   supabase/operations/schedule-client-radar.sql): o modelo da
--   funcionalidade 'client_radar' tira os itens; o Jev (funcionalidade
--   'client_radar_check', ou o Jev do termômetro) confirma cada um e dá a
--   gravidade. Sem Jev, os itens entram sem gravidade.
-- - Acesso: o módulo /radar e a configuração são de administradores e
--   gestores; a aba Radar do cliente no Drive segue a regra do Drive (só
--   leitura para quem não é líder).

-- ------------------------------------------------------------ funcionalidades
alter table mavi_private.ai_routes drop constraint ai_routes_feature_check;
alter table mavi_private.ai_routes add constraint ai_routes_feature_check
 check ((scope_type = 'feature') = (feature is not null)
  and (feature is null or feature in ('assistant', 'meetings_history', 'meetings_ask',
   'whatsapp_task', 'social_leads_plan', 'social_leads_adjust', 'social_leads_briefing', 'social_leads_colors',
   'task_copilot', 'client_dossier', 'copilot_learning', 'notice_writer', 'notice_animation',
   'client_temperature', 'client_temperature_text', 'task_audio',
   'whatsapp_transcribe', 'task_audio_transcribe', 'image_generation', 'mavi_page', 'web_search', 'canvas_writer',
   'mavi_rerank', 'conversation_summary', 'skill_coach', 'whatsapp_history', 'client_radar', 'client_radar_check')));

-- As funcionalidades que respondem com o Jev (decisões, não texto).
create function mavi_private.ai_decision_feature(p_feature text) returns boolean
language sql immutable set search_path = '' as $$
 select coalesce(p_feature, '') in ('client_temperature', 'client_radar_check')
$$;

-- A da migração 20261228090000, com o Radar (e o Jev também no Radar).
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
  'mavi_rerank', 'conversation_summary', 'skill_coach', 'whatsapp_history', 'client_radar', 'client_radar_check') then
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
  raise exception 'O Jev só responde a perguntas de decisão: use-o no termômetro ou na conferência do Radar.'
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

-- O Jev do Radar: o escolhido para a conferência ou, sem escolha, o do
-- termômetro (que cai no primeiro Jev cadastrado num OpenRouter ligado).
create function mavi_private.radar_jev_route(c uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
 select coalesce(
  (select jsonb_build_object('provider_id', p.id, 'provider', p.name, 'kind', p.kind, 'base_url', p.base_url,
    'key_cipher', p.key_cipher, 'model', rt.model,
    'price', (select m from jsonb_array_elements(p.models) m where m->>'id' = rt.model limit 1))
   from mavi_private.ai_routes rt join mavi_private.ai_providers p on p.id = rt.provider_id and p.active
   where rt.company_id = c and rt.scope_type = 'feature' and rt.feature = 'client_radar_check'
   limit 1),
  mavi_private.temperature_route(c))
$$;

-- ------------------------------------------------------------ módulo no menu
alter table public.memberships drop constraint if exists memberships_hidden_pages_check;
alter table public.memberships add constraint memberships_hidden_pages_check
 check (hidden_pages <@ array['overview','tasks','agenda','clients','products','projects','campaigns','hours',
  'reports','drive','storage','dashboards','onboarding','aiUsage','assistant','cases','notices',
  'temperature','socialMedia','radar']::text[]);

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
  'reports','drive','storage','dashboards','onboarding','aiUsage','assistant','cases','notices',
  'temperature','socialMedia','radar']::text[] then
  raise exception 'Módulo inválido' using errcode = '22023';
 end if;
 update public.memberships set hidden_pages = v where company_id = p_company and user_id = p_user
  and hidden_pages is distinct from v;
end $$;

-- ------------------------------------------------------------ configuração
create table public.radar_settings (
 company_id uuid primary key references public.companies(id),
 -- As reuniões e os dias de grupo a partir daqui entram no Radar.
 started_at timestamptz not null default now(),
 updated_by uuid,
 updated_at timestamptz not null default now()
);
alter table public.radar_settings enable row level security;
revoke all on public.radar_settings from public, anon, authenticated;

create table public.radar_topics (
 id uuid primary key default gen_random_uuid(),
 company_id uuid not null references public.companies(id),
 -- Nulo: da empresa. Com produto: só para os clientes que contratam o produto.
 product_id uuid,
 key text not null check (key ~ '^[a-z][a-z0-9_]{1,39}$'),
 name text not null check (length(btrim(name)) between 2 and 60),
 -- O que conta, com exemplos (é o que a MAVI e o Jev leem).
 description text not null check (length(btrim(description)) between 10 and 2000),
 -- O que não conta.
 exclude text not null default '' check (length(exclude) <= 1000),
 -- Quem fala: client (o cliente), team (o time) ou any.
 speaker text not null default 'any' check (speaker in ('client', 'team', 'any')),
 sources text[] not null default '{meeting,whatsapp}'
  check (cardinality(sources) between 1 and 2 and sources <@ array['meeting', 'whatsapp']),
 -- Com prazo (as promessas): a MAVI anota a data quando é citada.
 has_due boolean not null default false,
 -- Gravidade: 4 níveis, do mais leve ao mais sério (o Jev escolhe).
 severity boolean not null default true,
 severity_label text not null default 'Gravidade' check (length(btrim(severity_label)) between 2 and 30),
 severity_levels jsonb not null check (jsonb_typeof(severity_levels) = 'array' and jsonb_array_length(severity_levels) = 4),
 -- Campos extras: [{key, label, type: text|number|date|choice, options}].
 fields jsonb not null default '[]' check (jsonb_typeof(fields) = 'array'),
 -- Status: [{key, label, color, kind: open|progress|closed, reopen}], o primeiro "open" é o inicial.
 statuses jsonb not null check (jsonb_typeof(statuses) = 'array' and jsonb_array_length(statuses) between 2 and 8),
 color text not null default '#6b52b3' check (color ~* '^#[0-9a-f]{6}$'),
 -- Tópico da empresa desligado nestes produtos.
 off_products uuid[] not null default '{}',
 active boolean not null default true,
 position integer not null default 0,
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 unique (company_id, key),
 unique (company_id, id),
 foreign key (company_id, product_id) references public.products(company_id, id) on delete cascade
);
create index radar_topics_company on public.radar_topics (company_id, position);
alter table public.radar_topics enable row level security;
revoke all on public.radar_topics from public, anon, authenticated;

-- ------------------------------------------------------------ leituras
create table public.radar_signals (
 id uuid primary key default gen_random_uuid(),
 company_id uuid not null,
 client_id uuid not null,
 source_type text not null check (source_type in ('meeting', 'whatsapp')),
 -- Reunião: a gravação. WhatsApp: o dia do grupo (mavi_private.whatsapp_ai_days).
 source_id uuid not null,
 group_id uuid,
 title text not null default '',
 occurred_at timestamptz not null,
 day date not null,
 status text not null default 'pending' check (status in ('pending', 'done', 'skipped', 'failed')),
 dirty_at timestamptz,
 claimed_at timestamptz,
 claimed_until timestamptz,
 attempts integer not null default 0,
 last_error text,
 -- WhatsApp: as mensagens já lidas (a próxima leitura pega só as novas).
 seen uuid[] not null default '{}',
 items integer not null default 0,
 cost_usd numeric not null default 0,
 evaluated_at timestamptz,
 created_at timestamptz not null default now(),
 unique (company_id, source_type, source_id),
 foreign key (company_id, client_id) references public.clients(company_id, id) on delete cascade
);
create index radar_signals_due on public.radar_signals (dirty_at) where status = 'pending';
create index radar_signals_client on public.radar_signals (client_id, day);
alter table public.radar_signals enable row level security;
revoke all on public.radar_signals from public, anon, authenticated;

-- ------------------------------------------------------------ itens
create table public.radar_items (
 id uuid primary key default gen_random_uuid(),
 company_id uuid not null,
 client_id uuid not null,
 topic_id uuid not null,
 -- Nulo: Geral / Agência.
 product_id uuid,
 title text not null check (length(btrim(title)) between 3 and 200),
 summary text not null default '' check (length(summary) <= 1500),
 status text not null,
 status_at timestamptz not null default now(),
 -- Quem mudou o status (nulo: a MAVI).
 status_by uuid,
 assignee_id uuid,
 -- 0 a 3 (do mais leve ao mais sério); nulo sem o Jev.
 severity smallint check (severity between 0 and 3),
 severity_person boolean not null default false,
 due_date date,
 fields jsonb not null default '{}' check (jsonb_typeof(fields) = 'object'),
 -- Quem falou foi confirmado (telefone do time, nome do membro); falso: deduzido.
 speaker_confirmed boolean not null default true,
 mentions integer not null default 0,
 first_seen_at timestamptz not null default now(),
 last_seen_at timestamptz not null default now(),
 -- Título, resumo ou produto mudados por pessoa: a MAVI não reescreve.
 person_edited boolean not null default false,
 reopened_at timestamptz,
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 search tsvector generated always as (
  to_tsvector('portuguese'::regconfig, left(title || ' ' || summary, 4000))
 ) stored,
 unique (company_id, id),
 foreign key (company_id, client_id) references public.clients(company_id, id) on delete cascade,
 foreign key (company_id, topic_id) references public.radar_topics(company_id, id) on delete cascade,
 foreign key (company_id, product_id) references public.products(company_id, id) on delete set null (product_id)
);
create index radar_items_topic on public.radar_items (company_id, topic_id, last_seen_at desc);
create index radar_items_client on public.radar_items (client_id, topic_id);
create index radar_items_search on public.radar_items using gin (search);
alter table public.radar_items enable row level security;
revoke all on public.radar_items from public, anon, authenticated;

create table public.radar_mentions (
 id uuid primary key default gen_random_uuid(),
 company_id uuid not null,
 item_id uuid not null references public.radar_items(id) on delete cascade,
 signal_id uuid references public.radar_signals(id) on delete set null,
 source_type text not null check (source_type in ('meeting', 'whatsapp')),
 source_id uuid not null,
 group_id uuid,
 message_id uuid,
 -- Reunião: o segundo da fala (o link abre ali).
 at_seconds integer check (at_seconds is null or at_seconds >= 0),
 quote text not null check (length(quote) between 1 and 700),
 speaker text not null default '' check (length(speaker) <= 120),
 role text not null default 'unknown' check (role in ('client', 'team', 'unknown')),
 occurred_at timestamptz not null,
 created_at timestamptz not null default now()
);
create index radar_mentions_item on public.radar_mentions (item_id, occurred_at desc);
create index radar_mentions_signal on public.radar_mentions (signal_id);
alter table public.radar_mentions enable row level security;
revoke all on public.radar_mentions from public, anon, authenticated;

-- ------------------------------------------------------------ status
-- O status inicial (o primeiro "open"; sem nenhum, o primeiro).
create function mavi_private.radar_first_status(p_statuses jsonb) returns text
language sql immutable set search_path = '' as $$
 select coalesce((select s->>'key' from jsonb_array_elements(p_statuses) with ordinality x(s, n)
   where s->>'kind' = 'open' order by n limit 1), p_statuses->0->>'key')
$$;
create function mavi_private.radar_status(p_statuses jsonb, p_key text) returns jsonb
language sql immutable set search_path = '' as $$
 select s from jsonb_array_elements(p_statuses) s where s->>'key' = p_key limit 1
$$;

-- ------------------------------------------------------------ tópicos iniciais
create function mavi_private.radar_seed(c uuid) returns void
language plpgsql security definer set search_path = '' as $$ begin
 insert into public.radar_settings(company_id) values (c) on conflict (company_id) do nothing;
 if exists (select 1 from public.radar_topics where company_id = c) then return; end if;
 insert into public.radar_topics(company_id, key, name, description, exclude, speaker, has_due, severity_label,
  severity_levels, statuses, color, position) values
 (c, 'problemas', 'Problemas / reclamações',
  'Problemas, reclamações e insatisfações que o cliente traz sobre o trabalho da agência ou sobre os resultados: atrasos, erros, qualidade das entregas, resultados abaixo do esperado, falhas de comunicação, cobranças e pedidos repetidos que não foram atendidos. Ex.: "os leads caíram muito esse mês", "de novo a arte saiu com o logo errado", "estou esperando resposta desde segunda".',
  'Dúvidas simples, pedidos novos sem reclamação, problemas do negócio do cliente sem relação com a agência (ex.: "meu funcionário faltou") e brincadeiras.',
  'client', false, 'Gravidade',
  '["Baixa: incômodo pequeno, sem risco para a relação",
    "Média: incomoda o cliente e precisa de atenção",
    "Alta: o cliente está irritado ou o problema afeta os resultados",
    "Crítica: ameaça a relação (fala em cancelar, cobra duramente, prejuízo sério)"]',
  '[{"key":"aberto","label":"Aberto","color":"#e34948","kind":"open","reopen":false},
    {"key":"em_tratamento","label":"Em tratamento","color":"#eda100","kind":"progress","reopen":false},
    {"key":"resolvido","label":"Resolvido","color":"#2f9e6b","kind":"closed","reopen":true},
    {"key":"descartado","label":"Descartado","color":"#a3acab","kind":"closed","reopen":false}]',
  '#e34948', 1),
 (c, 'promessas', 'Promessas',
  'Compromissos que alguém do time da agência assume com o cliente: entregas, prazos, ajustes, retornos, reuniões, relatórios, bônus ou condições especiais. Ex.: "até sexta te mando as artes", "vamos refazer a campanha sem custo", "amanhã te ligo com os números".',
  'Combinados que só dependem do cliente, planos genéricos sem compromisso ("a ideia é crescer") e respostas automáticas.',
  'team', true, 'Importância',
  '["Baixa: detalhe do dia a dia",
    "Média: compromisso normal de entrega",
    "Alta: o cliente conta com isso para o negócio dele",
    "Crítica: envolve dinheiro, prazo crítico ou condição especial"]',
  '[{"key":"pendente","label":"Pendente","color":"#2a78d6","kind":"open","reopen":false},
    {"key":"em_andamento","label":"Em andamento","color":"#eda100","kind":"progress","reopen":false},
    {"key":"cumprida","label":"Cumprida","color":"#2f9e6b","kind":"closed","reopen":false},
    {"key":"nao_cumprida","label":"Não cumprida","color":"#e34948","kind":"closed","reopen":false}]',
  '#2a78d6', 2);
end $$;

-- Os tópicos que valem para um cliente numa fonte, com os produtos em que
-- cada um vale (nulo: o tópico da empresa sem produto).
create function mavi_private.radar_client_topics(c uuid, p_client uuid, p_source text)
returns table(id uuid, key text, name text, description text, exclude text, speaker text, has_due boolean,
 severity boolean, severity_label text, severity_levels jsonb, fields jsonb, statuses jsonb, product_id uuid,
 products uuid[], "position" integer)
language sql stable security definer set search_path = '' as $$
 with prods as (
  select distinct k.product_id from public.contracts k
  where k.company_id = c and k.client_id = p_client and not k.archived
 )
 select t.id, t.key, t.name, t.description, t.exclude, t.speaker, t.has_due, t.severity, t.severity_label,
  t.severity_levels, t.fields, t.statuses, t.product_id,
  case when t.product_id is not null then array[t.product_id]
   else coalesce((select array_agg(p.product_id) from prods p where not (p.product_id = any(t.off_products))), '{}') end,
  t.position
 from public.radar_topics t
 where t.company_id = c and t.active and (p_source is null or p_source = any(t.sources)) and (
  (t.product_id is null and (not exists (select 1 from prods)
    or exists (select 1 from prods p where not (p.product_id = any(t.off_products)))))
  or t.product_id in (select product_id from prods))
$$;

-- ------------------------------------------------------------ fila
-- Tira as ocorrências de uma leitura e recalcula os itens mexidos.
create function mavi_private.radar_items_sync(p_items uuid[]) returns void
language plpgsql security definer set search_path = '' as $$ begin
 if coalesce(cardinality(p_items), 0) = 0 then return; end if;
 update public.radar_items i set mentions = s.n, first_seen_at = s.f, last_seen_at = s.l, updated_at = now()
 from (select m.item_id, count(*)::integer as n, min(m.occurred_at) as f, max(m.occurred_at) as l
   from public.radar_mentions m where m.item_id = any(p_items) group by m.item_id) s
 where i.id = s.item_id;
 -- Sem ocorrência e sem nada feito por pessoa: o item some.
 delete from public.radar_items i where i.id = any(p_items)
  and not exists (select 1 from public.radar_mentions m where m.item_id = i.id)
  and not i.person_edited and not i.severity_person and i.status_by is null and i.assignee_id is null;
 update public.radar_items i set mentions = 0 where i.id = any(p_items)
  and not exists (select 1 from public.radar_mentions m where m.item_id = i.id) and i.mentions <> 0;
end $$;

create function mavi_private.radar_forget_signal(p_signal uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare v_items uuid[]; begin
 select coalesce(array_agg(distinct m.item_id), '{}') into v_items from public.radar_mentions m where m.signal_id = p_signal;
 delete from public.radar_mentions where signal_id = p_signal;
 perform mavi_private.radar_items_sync(v_items);
end $$;

-- O documento da MAVI de uma reunião ou de um dia de grupo mudou: a leitura
-- fica pendente (ou sai, com o documento).
create function mavi_private.radar_touch() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_tz text; v_day date; v_group uuid; o public.radar_signals; v_start timestamptz; begin
 if tg_op = 'DELETE' then
  if old.source_type in ('meeting', 'whatsapp') then
   select * into o from public.radar_signals where company_id = old.company_id and source_type = old.source_type
    and source_id = old.source_id;
   if o.id is not null then
    perform mavi_private.radar_forget_signal(o.id);
    delete from public.radar_signals where id = o.id;
   end if;
  end if;
  return null;
 end if;
 if new.source_type not in ('meeting', 'whatsapp') then return null; end if;
 select * into o from public.radar_signals where company_id = new.company_id and source_type = new.source_type
  and source_id = new.source_id;
 if new.client_id is null then
  if o.id is not null then
   perform mavi_private.radar_forget_signal(o.id);
   delete from public.radar_signals where id = o.id;
  end if;
  return null;
 end if;
 select timezone into v_tz from public.companies where id = new.company_id;
 if new.source_type = 'whatsapp' then
  select d.day, d.group_id into v_day, v_group from mavi_private.whatsapp_ai_days d where d.id = new.source_id;
 else
  v_day := (coalesce(new.occurred_at, now()) at time zone coalesce(v_tz, 'America/Sao_Paulo'))::date;
 end if;
 v_day := coalesce(v_day, current_date);
 -- Antes de o Radar ligar: fica para a leitura do histórico.
 if o.id is null then
  perform mavi_private.radar_seed(new.company_id);
  select started_at into v_start from public.radar_settings where company_id = new.company_id;
  if v_day < (v_start at time zone coalesce(v_tz, 'America/Sao_Paulo'))::date then return null; end if;
 end if;
 -- Mudou de cliente: o antigo perde as ocorrências e a leitura recomeça.
 if o.id is not null and o.client_id <> new.client_id then
  perform mavi_private.radar_forget_signal(o.id);
  update public.radar_signals set seen = '{}', items = 0 where id = o.id;
 end if;
 insert into public.radar_signals(company_id, client_id, source_type, source_id, group_id, title, occurred_at, day,
  status, dirty_at)
 values (new.company_id, new.client_id, new.source_type, new.source_id, v_group, left(coalesce(new.title, ''), 300),
  coalesce(new.occurred_at, now()), v_day, 'pending', now())
 on conflict (company_id, source_type, source_id) do update set client_id = excluded.client_id,
  group_id = excluded.group_id, title = excluded.title, occurred_at = excluded.occurred_at, day = excluded.day,
  status = 'pending', dirty_at = now(), attempts = 0, last_error = null;
 return null;
end $$;
create trigger ai_documents_radar after insert or update of content_hash, client_id or delete
 on public.ai_documents for each row execute function mavi_private.radar_touch();

-- Pendentes paradas: a reunião há 2 min, o dia do grupo há 10 min (a busca
-- do WhatsApp terminou).
create function mavi_private.radar_due(x public.radar_signals) returns boolean
language sql stable set search_path = '' as $$
 select x.status = 'pending' and (x.claimed_until is null or x.claimed_until < now())
  and x.dirty_at <= now() - case x.source_type when 'meeting' then interval '2 minutes' else interval '10 minutes' end
$$;

-- ------------------------------------------------------------ worker
-- O Jev da empresa (a chave vai selada).
create function public.ai_radar_config(p_secret text, p_company uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$ begin
 if not mavi_private.ai_secret_ok(p_secret) then raise exception 'Sem permissão' using errcode = '42501'; end if;
 return jsonb_build_object('jev', mavi_private.radar_jev_route(p_company));
end $$;

-- Só reserva (o material vem por ai_radar_material, uma leitura por chamada).
create function public.ai_radar_claim(p_secret text, p_limit integer default 6) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_out jsonb; begin
 if not mavi_private.ai_secret_ok(p_secret) then raise exception 'Sem permissão' using errcode = '42501'; end if;
 with due as (
  select x.id from public.radar_signals x
  join public.clients k on k.id = x.client_id and not k.archived
  where x.status = 'pending' and mavi_private.radar_due(x)
  order by x.occurred_at desc
  limit least(greatest(coalesce(p_limit, 6), 1), 20)
  for update of x skip locked
 ), claimed as (
  update public.radar_signals x set claimed_at = now(), claimed_until = now() + interval '10 minutes'
  from due where x.id = due.id
  returning x.id, x.company_id, x.client_id, x.source_type, x.occurred_at
 )
 select coalesce(jsonb_agg(jsonb_build_object('id', c.id, 'company_id', c.company_id, 'client_id', c.client_id,
   'source_type', c.source_type) order by c.occurred_at desc), '[]') into v_out
 from claimed c;
 return v_out;
end $$;

-- O material de uma leitura reservada: as falas numeradas (com quem é time e
-- quem é cliente), os tópicos que valem, os itens que o cliente já tem e,
-- no WhatsApp, as mensagens já lidas como contexto. Nada novo para ler: a
-- leitura termina aqui e volta nulo.
create function public.ai_radar_material(p_secret text, p_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare g public.radar_signals; r record; v_names text[]; v_keys text[]; v_lines jsonb; v_context jsonb;
 v_new uuid[]; v_summary text; v_topics jsonb; v_items jsonb; v_products jsonb; v_group_products jsonb := '[]';
 v_from timestamptz; v_to timestamptz; v_title text; v_date text; v_group text; begin
 if not mavi_private.ai_secret_ok(p_secret) then raise exception 'Sem permissão' using errcode = '42501'; end if;
 select * into g from public.radar_signals where id = p_id;
 if not found then return null; end if;

 select coalesce(jsonb_agg(jsonb_build_object('id', t.id, 'key', t.key, 'name', t.name, 'description', t.description,
   'exclude', t.exclude, 'speaker', t.speaker, 'has_due', t.has_due, 'severity', t.severity,
   'severity_label', t.severity_label, 'severity_levels', t.severity_levels, 'fields', t.fields,
   'product_id', t.product_id, 'products', to_jsonb(t.products)) order by t.position, t.name), '[]')
 into v_topics from mavi_private.radar_client_topics(g.company_id, g.client_id, g.source_type) t;
 if jsonb_array_length(v_topics) = 0 then
  update public.radar_signals set status = 'skipped', claimed_until = null, evaluated_at = now() where id = g.id;
  return null;
 end if;

 if g.source_type = 'meeting' then
  select mr.*, t.speakers as t_speakers, t.segments into r from public.meeting_recordings mr
  left join public.meeting_transcripts t on t.company_id = mr.company_id and t.recording_id = mr.id
  where mr.company_id = g.company_id and mr.id = g.source_id;
  if not found then
   update public.radar_signals set status = 'skipped', claimed_until = null, evaluated_at = now() where id = g.id;
   return null;
  end if;
  select coalesce(array_agg(distinct mavi_private.temperature_norm(x.name)), '{}') into v_names
  from public.memberships x where x.company_id = g.company_id;
  -- Falas seguidas da mesma pessoa viram uma linha (com o segundo da primeira).
  with seg as materialized (
   select e.n, btrim(coalesce(e.s->>3, '')) as txt,
    greatest(floor(coalesce(nullif(e.s->>0, '')::numeric, 0)), 0)::integer as t0,
    coalesce(nullif(r.t_speakers[((e.s->>2)::integer) + 1], ''), 'Falante ' || (coalesce((e.s->>2)::integer, 0) + 1)) as who
   from jsonb_array_elements(coalesce(r.segments, '[]')) with ordinality e(s, n)
  ), roles as materialized (
   select q.who, case when q.who ~ '^Falante \d+$' then 'unknown'
    when mavi_private.temperature_is_team(q.who, v_names) then 'team' else 'client' end as role
   from (select distinct seg.who from seg) q
  ), chg as (
   select seg.*, case when seg.who is distinct from lag(seg.who) over (order by seg.n) then 1 else 0 end as c
   from seg where seg.txt <> ''
  ), grp as (
   select chg.*, sum(chg.c) over (order by chg.n) as gid from chg
  ), lin as (
   select min(grp.n) as n, min(grp.who) as who, min(grp.t0) as t, left(string_agg(grp.txt, ' ' order by grp.n), 3000) as txt
   from grp group by grp.gid
  )
  select coalesce(jsonb_agg(jsonb_build_object('role', ro.role, 'who', lin.who, 'text', lin.txt, 't', lin.t)
   order by lin.n), '[]')
  into v_lines from lin join roles ro on ro.who = lin.who;
  v_summary := nullif(concat_ws(E'\n',
   case when r.summary->>'overview' is not null then 'Resumo: ' || (r.summary->>'overview') end,
   (select string_agg('- ' || (nt->>'title') || ': ' || (nt->>'description'), E'\n')
     from jsonb_array_elements(coalesce(r.summary->'notes', '[]')) nt)), '');
  if jsonb_array_length(v_lines) = 0 then
   update public.radar_signals set status = 'skipped', claimed_until = null, evaluated_at = now() where id = g.id;
   return null;
  end if;
  v_title := coalesce(nullif(r.summary->>'title', ''), nullif(r.title, ''), 'Reunião');
  v_date := to_char(r.recorded_at at time zone 'America/Sao_Paulo', 'DD/MM/YYYY');
  v_context := '[]';
 else
  select d.*, wg.title as group_title, wg.product_ids into r from mavi_private.whatsapp_ai_days d
  join public.whatsapp_groups wg on wg.company_id = d.company_id and wg.id = d.group_id
  where d.id = g.source_id;
  if not found then
   update public.radar_signals set status = 'skipped', claimed_until = null, evaluated_at = now() where id = g.id;
   return null;
  end if;
  v_keys := mavi_private.team_phone_keys(g.company_id);
  v_from := r.day::timestamp at time zone 'America/Sao_Paulo';
  v_to := (r.day + 1)::timestamp at time zone 'America/Sao_Paulo';
  with msg as materialized (
   select w.id, w.sent_at, mavi_private.whatsapp_line(w) as line, mavi_private.whatsapp_sender(w) as who,
    case when w.from_me or mavi_private.phone_key(w.sender_phone) = any(v_keys) then 'team' else 'client' end as role,
    w.id = any(g.seen) as seen,
    -- Áudio ou documento esperando o texto (até 6 h): fica para a próxima leitura.
    (w.content_status = 'pending' and w.kind in ('audio', 'document') and w.sent_at > now() - interval '6 hours') as held
   from public.whatsapp_messages w
   where w.company_id = r.company_id and w.group_id = r.group_id and w.sent_at >= v_from and w.sent_at < v_to
    and w.kind not in ('reaction', 'sticker')
  )
  select
   coalesce(jsonb_agg(jsonb_build_object('role', m.role, 'who', m.who, 'text', left(m.line, 3000), 'msg', m.id,
     'at', to_char(m.sent_at at time zone 'America/Sao_Paulo', 'HH24:MI')) order by m.sent_at, m.id)
    filter (where not m.seen and not m.held), '[]'),
   coalesce(array_agg(m.id) filter (where not m.seen and not m.held), '{}')
  into v_lines, v_new
  from msg m where coalesce(m.line, '') <> '';
  if jsonb_array_length(v_lines) = 0 then
   -- Nada novo: a leitura fica como está.
   update public.radar_signals set status = case when dirty_at > claimed_at then 'pending' else 'done' end,
    claimed_until = null, evaluated_at = now()
   where id = g.id;
   return null;
  end if;
  -- As últimas 60 mensagens já lidas do dia: contexto.
  select coalesce(jsonb_agg(jsonb_build_object('role', q.role, 'who', q.who, 'text', left(q.line, 600),
    'at', to_char(q.sent_at at time zone 'America/Sao_Paulo', 'HH24:MI')) order by q.sent_at, q.id), '[]')
  into v_context
  from (
   select w.id, w.sent_at, mavi_private.whatsapp_line(w) as line, mavi_private.whatsapp_sender(w) as who,
    case when w.from_me or mavi_private.phone_key(w.sender_phone) = any(v_keys) then 'team' else 'client' end as role
   from public.whatsapp_messages w
   where w.company_id = r.company_id and w.group_id = r.group_id and w.sent_at >= v_from and w.sent_at < v_to
    and w.kind not in ('reaction', 'sticker') and w.id = any(g.seen)
   order by w.sent_at desc, w.id desc limit 60
  ) q where coalesce(q.line, '') <> '';
  v_group := r.group_title;
  v_group_products := to_jsonb(coalesce(r.product_ids, '{}'));
  v_title := 'Grupo "' || r.group_title || '"';
  v_date := to_char(r.day, 'DD/MM/YYYY');
 end if;

 select coalesce(jsonb_agg(jsonb_build_object('id', p.id, 'name', p.name) order by p.name), '[]') into v_products
 from public.products p where p.company_id = g.company_id and p.id in (select k.product_id from public.contracts k
  where k.company_id = g.company_id and k.client_id = g.client_id and not k.archived);

 -- Os itens do cliente (abertos, e os fechados dos últimos 120 dias), para
 -- a MAVI juntar a mesma fala ao item que já existe.
 select coalesce(jsonb_agg(jsonb_build_object('id', q.id, 'topic_id', q.topic_id, 'title', q.title,
   'summary', left(q.summary, 240), 'product_id', q.product_id, 'status', q.label, 'closed', q.closed,
   'last_seen', to_char(q.last_seen_at at time zone 'America/Sao_Paulo', 'DD/MM/YYYY')) order by q.last_seen_at desc), '[]')
 into v_items
 from (
  select i.*, coalesce(st->>'label', i.status) as label, coalesce(st->>'kind', '') = 'closed' as closed
  from public.radar_items i
  join public.radar_topics t on t.id = i.topic_id
  cross join lateral (select mavi_private.radar_status(t.statuses, i.status) as st) s
  where i.client_id = g.client_id and i.topic_id in (select (x->>'id')::uuid from jsonb_array_elements(v_topics) x)
   and (coalesce(st->>'kind', '') <> 'closed' or i.last_seen_at > now() - interval '120 days')
  order by i.last_seen_at desc limit 80
 ) q;

 return jsonb_strip_nulls(jsonb_build_object('id', g.id, 'company_id', g.company_id, 'client_id', g.client_id,
  'source_type', g.source_type, 'client_name', (select name from public.clients where id = g.client_id),
  'title', v_title, 'date', v_date, 'group', v_group, 'summary', v_summary,
  'products', v_products, 'group_products', v_group_products,
  'topics', v_topics, 'items', v_items, 'lines', v_lines, 'context', v_context, 'seen', to_jsonb(v_new)));
end $$;

-- O resultado de uma leitura: {items: [{topic_id, item_id, title, summary,
-- product_id, severity, due_date, fields, speaker_confirmed, mentions:
-- [{quote, speaker, role, at_seconds, message_id}]}], seen, usage: [...]}.
-- A reunião lida de novo troca as ocorrências dela; no WhatsApp, as
-- mensagens lidas entram em seen.
create function public.ai_radar_store(p_secret text, p_id uuid, p_result jsonb) returns integer
language plpgsql security definer set search_path = '' as $$
declare g public.radar_signals; x jsonb; mm jsonb; t public.radar_topics; it public.radar_items; v_prod uuid;
 v_touched uuid[] := '{}'; v_n integer := 0; v_st jsonb; v_sev smallint; v_due date; v_at timestamptz;
 v_msg uuid; v_sec integer; v_quote text; v_role text; v_fields jsonb; v_recorded timestamptz; v_new boolean;
 v_cost numeric := 0; u jsonb; begin
 if not mavi_private.ai_secret_ok(p_secret) then raise exception 'Sem permissão' using errcode = '42501'; end if;
 select * into g from public.radar_signals where id = p_id for update;
 if not found then return 0; end if;
 -- A reunião mudou durante a leitura: lê de novo.
 if g.source_type = 'meeting' and g.dirty_at > g.claimed_at then
  update public.radar_signals set claimed_until = null where id = g.id;
  return 0;
 end if;
 if g.source_type = 'meeting' then
  select coalesce(array_agg(distinct m.item_id), '{}') into v_touched from public.radar_mentions m where m.signal_id = g.id;
  delete from public.radar_mentions where signal_id = g.id;
  select recorded_at into v_recorded from public.meeting_recordings where company_id = g.company_id and id = g.source_id;
 end if;

 for x in select * from jsonb_array_elements(case when jsonb_typeof(p_result->'items') = 'array'
   then p_result->'items' else '[]' end) loop
  continue when coalesce(x->>'topic_id', '') !~* '^[0-9a-f-]{36}$';
  select tt.* into t from public.radar_topics tt
  join mavi_private.radar_client_topics(g.company_id, g.client_id, null) ct on ct.id = tt.id
  where tt.id = (x->>'topic_id')::uuid;
  continue when not found;
  continue when jsonb_typeof(x->'mentions') is distinct from 'array' or jsonb_array_length(x->'mentions') = 0;
  -- Produto: um dos que o cliente contrata e em que o tópico vale; senão, Geral.
  v_prod := case when x->>'product_id' ~* '^[0-9a-f-]{36}$' then (x->>'product_id')::uuid end;
  if t.product_id is not null then v_prod := t.product_id;
  elsif v_prod is not null and (v_prod = any(t.off_products) or not exists (select 1 from public.contracts k
    where k.company_id = g.company_id and k.client_id = g.client_id and k.product_id = v_prod and not k.archived)) then
   v_prod := null;
  end if;
  v_sev := case when t.severity and jsonb_typeof(x->'severity') = 'number'
   then least(greatest(round((x->>'severity')::numeric), 0), 3)::smallint end;
  v_due := case when t.has_due and coalesce(x->>'due_date', '') ~ '^\d{4}-\d{2}-\d{2}$' then (x->>'due_date')::date end;
  -- Campos extras: só os do tópico, em texto curto.
  select coalesce(jsonb_object_agg(f->>'key', left(x->'fields'->>(f->>'key'), 300)), '{}') into v_fields
  from jsonb_array_elements(t.fields) f
  where jsonb_typeof(x->'fields') = 'object' and nullif(btrim(coalesce(x->'fields'->>(f->>'key'), '')), '') is not null;

  it := null;
  if x->>'item_id' ~* '^[0-9a-f-]{36}$' then
   select * into it from public.radar_items where id = (x->>'item_id')::uuid and client_id = g.client_id
    and topic_id = t.id for update;
  end if;
  v_new := it.id is null;
  -- Item novo precisa de título; a fala que vai para um item existente, não.
  continue when v_new and length(btrim(coalesce(x->>'title', ''))) < 3;
  if v_new then
   insert into public.radar_items(company_id, client_id, topic_id, product_id, title, summary, status, severity,
    due_date, fields, speaker_confirmed)
   values (g.company_id, g.client_id, t.id, v_prod, left(btrim(x->>'title'), 200),
    left(btrim(coalesce(x->>'summary', '')), 1500), mavi_private.radar_first_status(t.statuses), v_sev, v_due,
    v_fields, coalesce((x->>'speaker_confirmed')::boolean, true))
   returning * into it;
  else
   v_st := mavi_private.radar_status(t.statuses, it.status);
   update public.radar_items set
    summary = case when not person_edited and nullif(btrim(coalesce(x->>'summary', '')), '') is not null
     then left(btrim(x->>'summary'), 1500) else summary end,
    product_id = case when not person_edited and product_id is null then v_prod else product_id end,
    severity = case when severity_person or v_sev is null then severity else greatest(coalesce(severity, 0), v_sev) end,
    due_date = coalesce(v_due, due_date),
    fields = fields || v_fields,
    speaker_confirmed = speaker_confirmed or coalesce((x->>'speaker_confirmed')::boolean, true),
    -- Fechado com "reabre": a fala nova reabre o item.
    status = case when coalesce(v_st->>'kind', '') = 'closed' and coalesce((v_st->>'reopen')::boolean, false)
     then mavi_private.radar_first_status(t.statuses) else status end,
    reopened_at = case when coalesce(v_st->>'kind', '') = 'closed' and coalesce((v_st->>'reopen')::boolean, false)
     then now() else reopened_at end,
    status_at = case when coalesce(v_st->>'kind', '') = 'closed' and coalesce((v_st->>'reopen')::boolean, false)
     then now() else status_at end,
    status_by = case when coalesce(v_st->>'kind', '') = 'closed' and coalesce((v_st->>'reopen')::boolean, false)
     then null else status_by end,
    updated_at = now()
   where id = it.id;
  end if;

  for mm in select * from jsonb_array_elements(x->'mentions') loop
   v_quote := left(btrim(coalesce(mm->>'quote', '')), 700);
   continue when v_quote = '';
   v_role := case when mm->>'role' in ('client', 'team', 'unknown') then mm->>'role' else 'unknown' end;
   v_msg := null; v_sec := null; v_at := g.occurred_at;
   if g.source_type = 'whatsapp' and mm->>'message_id' ~* '^[0-9a-f-]{36}$' then
    select w.id, w.sent_at into v_msg, v_at from public.whatsapp_messages w
    where w.company_id = g.company_id and w.group_id = g.group_id and w.id = (mm->>'message_id')::uuid;
    v_at := coalesce(v_at, g.occurred_at);
   elsif g.source_type = 'meeting' and jsonb_typeof(mm->'at_seconds') = 'number' then
    v_sec := greatest(round((mm->>'at_seconds')::numeric), 0)::integer;
    v_at := coalesce(v_recorded, g.occurred_at) + make_interval(secs => v_sec);
   end if;
   -- A mesma fala do mesmo lugar não entra duas vezes.
   continue when exists (select 1 from public.radar_mentions r where r.item_id = it.id and r.source_id = g.source_id
    and r.quote = v_quote);
   insert into public.radar_mentions(company_id, item_id, signal_id, source_type, source_id, group_id, message_id,
    at_seconds, quote, speaker, role, occurred_at)
   values (g.company_id, it.id, g.id, g.source_type, g.source_id, g.group_id, v_msg, v_sec, v_quote,
    left(coalesce(mm->>'speaker', ''), 120), v_role, v_at);
  end loop;
  v_touched := v_touched || it.id;
  v_n := v_n + 1;
 end loop;
 perform mavi_private.radar_items_sync(v_touched);

 -- O custo, por cliente (a leitura da MAVI e a conferência do Jev).
 for u in select * from jsonb_array_elements(case when jsonb_typeof(p_result->'usage') = 'array'
   then p_result->'usage' else '[]' end) loop
  continue when coalesce(u->>'kind', '') not in ('radar', 'radar_check');
  v_cost := v_cost + least(greatest(coalesce((u->>'cost')::numeric, 0), 0), 20);
  insert into public.ai_usage(company_id, user_id, module, kind, client_id, model, input_tokens, output_tokens,
   cache_read_tokens, cache_write_tokens, cost_usd, provider_id, provider_name)
  values (g.company_id, null, 'radar', u->>'kind', g.client_id, left(coalesce(u->>'model', ''), 80),
   greatest(coalesce((u->>'input')::integer, 0), 0), greatest(coalesce((u->>'output')::integer, 0), 0),
   greatest(coalesce((u->>'cache_read')::integer, 0), 0), greatest(coalesce((u->>'cache_write')::integer, 0), 0),
   least(greatest(coalesce((u->>'cost')::numeric, 0), 0), 20),
   case when u->>'provider_id' ~* '^[0-9a-f-]{36}$' then (u->>'provider_id')::uuid end,
   left(coalesce(u->>'provider', ''), 120));
 end loop;

 update public.radar_signals set
  seen = case when g.source_type = 'whatsapp' then (select coalesce(array_agg(distinct s), '{}') from unnest(g.seen
    || coalesce((select array_agg(v::uuid) from jsonb_array_elements_text(case when jsonb_typeof(p_result->'seen') = 'array'
      then p_result->'seen' else '[]' end) v where v ~* '^[0-9a-f-]{36}$'), '{}')) s) else '{}' end,
  items = case when g.source_type = 'meeting' then v_n else items + v_n end,
  cost_usd = cost_usd + v_cost, evaluated_at = now(), attempts = 0, last_error = null, claimed_until = null,
  status = case when dirty_at > claimed_at then 'pending' else 'done' end
 where id = g.id;
 return v_n;
end $$;

-- Falhou: tenta de novo mais tarde (até 5 vezes).
create function public.ai_radar_fail(p_secret text, p_id uuid, p_error text) returns void
language plpgsql security definer set search_path = '' as $$ begin
 if not mavi_private.ai_secret_ok(p_secret) then raise exception 'Sem permissão' using errcode = '42501'; end if;
 update public.radar_signals set attempts = attempts + 1, last_error = left(coalesce(p_error, ''), 500),
  claimed_until = now() + (attempts + 1) * interval '10 minutes',
  status = case when attempts + 1 >= 5 then 'failed' else status end
 where id = p_id;
end $$;

-- pg_cron: acorda o worker só quando há o que ler.
create function mavi_private.ai_radar_kick() returns void
language plpgsql security definer set search_path = '' as $$
declare cfg mavi_private.ai_config; begin
 select * into cfg from mavi_private.ai_config where id;
 if not found then return; end if;
 if not exists (select 1 from public.radar_signals x where x.status = 'pending' and mavi_private.radar_due(x)) then
  return;
 end if;
 perform net.http_post(url := cfg.url, body := '{"action":"ai-radar"}'::jsonb,
  headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || cfg.secret),
  -- O worker trabalha até 4 min (uma leitura leva até ~90 s).
  timeout_milliseconds := 290000);
end $$;

-- ------------------------------------------------------------ telas
create function mavi_private.radar_topic_json(t public.radar_topics) returns jsonb
language sql stable security definer set search_path = '' as $$
 select jsonb_build_object('id', t.id, 'key', t.key, 'name', t.name, 'description', t.description,
  'exclude', t.exclude, 'speaker', t.speaker, 'sources', to_jsonb(t.sources), 'has_due', t.has_due,
  'severity', t.severity, 'severity_label', t.severity_label, 'severity_levels', t.severity_levels,
  'fields', t.fields, 'statuses', t.statuses, 'color', t.color, 'product_id', t.product_id,
  'off_products', to_jsonb(t.off_products), 'active', t.active, 'position', t.position)
$$;

create function mavi_private.radar_item_json(i public.radar_items) returns jsonb
language sql stable security definer set search_path = '' as $$
 select jsonb_build_object('id', i.id, 'topic_id', i.topic_id, 'client_id', i.client_id,
  'client_name', k.name, 'client_color', k.color, 'product_id', i.product_id, 'product_name', p.name,
  'title', i.title, 'summary', i.summary, 'status', i.status, 'status_at', i.status_at,
  'assignee_id', i.assignee_id, 'assignee_name', m.name, 'severity', i.severity, 'due_date', i.due_date,
  'fields', i.fields, 'speaker_confirmed', i.speaker_confirmed, 'mentions', i.mentions,
  'first_seen_at', i.first_seen_at, 'last_seen_at', i.last_seen_at, 'reopened_at', i.reopened_at,
  'created_at', i.created_at)
 from public.clients k
 left join public.products p on p.company_id = i.company_id and p.id = i.product_id
 left join public.memberships m on m.company_id = i.company_id and m.user_id = i.assignee_id
 where k.id = i.client_id
$$;

-- O topo do módulo: os tópicos com os números de cada um.
create function public.radar_overview(p_company uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$ begin
 if not mavi_private.leader(p_company) then raise exception 'Sem permissão' using errcode = '42501'; end if;
 perform mavi_private.radar_seed(p_company);
 return jsonb_build_object(
  'topics', coalesce((select jsonb_agg(mavi_private.radar_topic_json(t) || jsonb_build_object(
     'open', (select count(*) from public.radar_items i where i.topic_id = t.id
       and coalesce(mavi_private.radar_status(t.statuses, i.status)->>'kind', '') <> 'closed'),
     'new_7d', (select count(*) from public.radar_items i where i.topic_id = t.id and i.created_at > now() - interval '7 days'),
     'severe', (select count(*) from public.radar_items i where i.topic_id = t.id and i.severity >= 2
       and coalesce(mavi_private.radar_status(t.statuses, i.status)->>'kind', '') <> 'closed'),
     'overdue', case when t.has_due then (select count(*) from public.radar_items i where i.topic_id = t.id
       and i.due_date < current_date
       and coalesce(mavi_private.radar_status(t.statuses, i.status)->>'kind', '') <> 'closed') end,
     'total', (select count(*) from public.radar_items i where i.topic_id = t.id))
    order by t.position, t.created_at)
   from public.radar_topics t where t.company_id = p_company and t.active), '[]'),
  'pending', (select count(*) from public.radar_signals x where x.company_id = p_company and x.status = 'pending'),
  'started_at', (select started_at from public.radar_settings where company_id = p_company),
  'can_configure', true);
end $$;

-- A lista do módulo, com os filtros resolvidos no banco: {topic, q, product
-- ('none' = Geral), client, team, statuses, severity (mínima), assignee
-- ('none' = sem responsável), days (visto nos últimos), sort (recent,
-- mentions, severity, oldest), limit, offset}.
create function public.radar_items(p_company uuid, p_filters jsonb) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare f jsonb := coalesce(p_filters, '{}'); v_topic uuid; v_q text; v_limit integer; v_offset integer;
 v_out jsonb; begin
 if not mavi_private.leader(p_company) then raise exception 'Sem permissão' using errcode = '42501'; end if;
 v_topic := case when f->>'topic' ~* '^[0-9a-f-]{36}$' then (f->>'topic')::uuid end;
 v_q := nullif(btrim(coalesce(f->>'q', '')), '');
 v_limit := least(greatest(coalesce((f->>'limit')::integer, 50), 1), 200);
 v_offset := greatest(coalesce((f->>'offset')::integer, 0), 0);
 with base as (
  select i.*, coalesce(mavi_private.radar_status(t.statuses, i.status)->>'kind', '') as kind
  from public.radar_items i
  join public.radar_topics t on t.id = i.topic_id
  where i.company_id = p_company
   and (v_topic is null or i.topic_id = v_topic)
   and (v_q is null or i.search @@ websearch_to_tsquery('portuguese', v_q) or i.title ilike '%' || v_q || '%'
    or exists (select 1 from public.clients k where k.id = i.client_id and k.name ilike '%' || v_q || '%'))
   and (coalesce(f->>'product', '') = '' or (f->>'product' = 'none' and i.product_id is null)
    or (f->>'product' ~* '^[0-9a-f-]{36}$' and i.product_id = (f->>'product')::uuid))
   and (coalesce(f->>'client', '') !~* '^[0-9a-f-]{36}$' or i.client_id = (f->>'client')::uuid)
   and (coalesce(f->>'team', '') !~* '^[0-9a-f-]{36}$' or exists (select 1 from public.client_teams ct
    where ct.company_id = i.company_id and ct.client_id = i.client_id and ct.team_id = (f->>'team')::uuid))
   and (jsonb_typeof(f->'statuses') is distinct from 'array' or jsonb_array_length(f->'statuses') = 0
    or i.status in (select jsonb_array_elements_text(f->'statuses')))
   and (jsonb_typeof(f->'severity') is distinct from 'number' or i.severity >= (f->>'severity')::integer)
   and (coalesce(f->>'assignee', '') = '' or (f->>'assignee' = 'none' and i.assignee_id is null)
    or (f->>'assignee' ~* '^[0-9a-f-]{36}$' and i.assignee_id = (f->>'assignee')::uuid))
   and (jsonb_typeof(f->'days') is distinct from 'number' or (f->>'days')::integer <= 0
    or i.last_seen_at > now() - make_interval(days => (f->>'days')::integer))
 ), page as (
  select b.*, count(*) over () as total from base b
  order by
   case when f->>'sort' = 'mentions' then b.mentions end desc nulls last,
   case when f->>'sort' = 'severity' then b.severity end desc nulls last,
   case when f->>'sort' = 'oldest' then b.first_seen_at end asc,
   case when b.kind = 'closed' then 1 else 0 end,
   b.last_seen_at desc, b.id
  limit v_limit offset v_offset
 )
 select jsonb_build_object('total', coalesce(max(page.total), 0),
  'items', coalesce(jsonb_agg(mavi_private.radar_item_json(i)
   order by case when f->>'sort' = 'mentions' then page.mentions end desc nulls last,
    case when f->>'sort' = 'severity' then page.severity end desc nulls last,
    case when f->>'sort' = 'oldest' then page.first_seen_at end asc,
    case when page.kind = 'closed' then 1 else 0 end,
    page.last_seen_at desc, page.id), '[]'))
 into v_out
 from page join public.radar_items i on i.id = page.id;
 if v_out is null or v_out->'total' is null then v_out := jsonb_build_object('total', 0, 'items', '[]'::jsonb); end if;
 return v_out;
end $$;

-- Um item com as ocorrências (a regra do Drive; só líderes editam).
create function public.radar_item(p_company uuid, p_item uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare i public.radar_items; t public.radar_topics; begin
 select * into i from public.radar_items where company_id = p_company and id = p_item;
 if not found or not mavi_private.dossier_reader(p_company, i.client_id) then
  raise exception 'Item não encontrado.' using errcode = 'P0002';
 end if;
 select * into t from public.radar_topics where id = i.topic_id;
 return mavi_private.radar_item_json(i) || jsonb_build_object(
  'topic', mavi_private.radar_topic_json(t),
  'can_edit', mavi_private.leader(p_company),
  'client_products', coalesce((select jsonb_agg(jsonb_build_object('id', p.id, 'name', p.name) order by p.name)
    from public.products p where p.company_id = p_company and p.id in (select k.product_id from public.contracts k
     where k.company_id = p_company and k.client_id = i.client_id and not k.archived)), '[]'),
  'occurrences', coalesce((select jsonb_agg(jsonb_build_object('id', m.id, 'source_type', m.source_type,
     'source_id', m.source_id, 'group_id', m.group_id, 'message_id', m.message_id, 'at_seconds', m.at_seconds,
     'quote', m.quote, 'speaker', m.speaker, 'role', m.role, 'occurred_at', m.occurred_at, 'title', s.title)
    order by m.occurred_at desc)
   from (select * from public.radar_mentions m where m.item_id = i.id order by m.occurred_at desc limit 100) m
   left join public.radar_signals s on s.id = m.signal_id), '[]'));
end $$;

-- Edita um item (líderes): status, responsável, gravidade, prazo, produto,
-- título, resumo e campos extras.
create function public.update_radar_item(p_company uuid, p_item uuid, p_patch jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare i public.radar_items; t public.radar_topics; v jsonb := coalesce(p_patch, '{}'); v_prod uuid; begin
 if not mavi_private.leader(p_company) then raise exception 'Sem permissão' using errcode = '42501'; end if;
 select * into i from public.radar_items where company_id = p_company and id = p_item for update;
 if not found then raise exception 'Item não encontrado.' using errcode = 'P0002'; end if;
 select * into t from public.radar_topics where id = i.topic_id;
 if v ? 'status' and mavi_private.radar_status(t.statuses, v->>'status') is null then
  raise exception 'Status inválido.' using errcode = '22023';
 end if;
 if v ? 'assignee_id' and v->>'assignee_id' is not null and not exists (select 1 from public.memberships m
  where m.company_id = p_company and m.user_id::text = v->>'assignee_id' and m.active) then
  raise exception 'Responsável não encontrado.' using errcode = 'P0002';
 end if;
 if v ? 'product_id' and v->>'product_id' is not null then
  v_prod := (v->>'product_id')::uuid;
  if not exists (select 1 from public.contracts k where k.company_id = p_company and k.client_id = i.client_id
   and k.product_id = v_prod and not k.archived) then
   raise exception 'O cliente não contrata este produto.' using errcode = '22023';
  end if;
 end if;
 if v ? 'title' and length(btrim(coalesce(v->>'title', ''))) not between 3 and 200 then
  raise exception 'O título tem de 3 a 200 caracteres.' using errcode = '22023';
 end if;
 if v ? 'severity' and v->>'severity' is not null and (v->>'severity')::integer not between 0 and 3 then
  raise exception 'Gravidade inválida.' using errcode = '22023';
 end if;
 update public.radar_items set
  status = case when v ? 'status' then v->>'status' else status end,
  status_at = case when v ? 'status' and v->>'status' <> status then now() else status_at end,
  status_by = case when v ? 'status' and v->>'status' <> status then auth.uid() else status_by end,
  assignee_id = case when v ? 'assignee_id' then (v->>'assignee_id')::uuid else assignee_id end,
  severity = case when v ? 'severity' then (v->>'severity')::smallint else severity end,
  severity_person = severity_person or v ? 'severity',
  due_date = case when v ? 'due_date' then (v->>'due_date')::date else due_date end,
  product_id = case when v ? 'product_id' then v_prod else product_id end,
  title = case when v ? 'title' then btrim(v->>'title') else title end,
  summary = case when v ? 'summary' then left(btrim(coalesce(v->>'summary', '')), 1500) else summary end,
  person_edited = person_edited or v ?| array['title', 'summary', 'product_id'],
  fields = case when jsonb_typeof(v->'fields') = 'object' then (select coalesce(jsonb_object_agg(f->>'key',
     left(v->'fields'->>(f->>'key'), 300)), '{}') from jsonb_array_elements(t.fields) f
     where nullif(btrim(coalesce(v->'fields'->>(f->>'key'), '')), '') is not null) else fields end,
  updated_at = now()
 where id = i.id;
 return public.radar_item(p_company, p_item);
end $$;

-- A aba Radar do cliente no Drive (a regra do Drive).
create function public.client_radar(p_company uuid, p_client uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$ begin
 if not mavi_private.dossier_reader(p_company, p_client) then
  raise exception 'Sem acesso a este cliente.' using errcode = '42501';
 end if;
 return jsonb_build_object(
  'topics', coalesce((select jsonb_agg(mavi_private.radar_topic_json(t) order by t.position, t.created_at)
    from public.radar_topics t where t.company_id = p_company
     and (t.active or exists (select 1 from public.radar_items i where i.topic_id = t.id and i.client_id = p_client))), '[]'),
  'items', coalesce((select jsonb_agg(mavi_private.radar_item_json(i) order by q.closed, i.last_seen_at desc)
    from (select i.id, coalesce(mavi_private.radar_status(t.statuses, i.status)->>'kind', '') = 'closed' as closed
      from public.radar_items i join public.radar_topics t on t.id = i.topic_id
      where i.company_id = p_company and i.client_id = p_client
      order by i.last_seen_at desc limit 500) q
    join public.radar_items i on i.id = q.id), '[]'),
  'pending', (select count(*) from public.radar_signals x where x.client_id = p_client and x.status = 'pending'),
  'can_edit', mavi_private.leader(p_company));
end $$;

-- A configuração (Painel da MAVI › Radar).
create function public.radar_settings(p_company uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$ begin
 if not mavi_private.leader(p_company) then raise exception 'Sem permissão' using errcode = '42501'; end if;
 perform mavi_private.radar_seed(p_company);
 return jsonb_build_object(
  'topics', coalesce((select jsonb_agg(mavi_private.radar_topic_json(t) || jsonb_build_object('items',
     (select count(*) from public.radar_items i where i.topic_id = t.id)) order by t.position, t.created_at)
    from public.radar_topics t where t.company_id = p_company), '[]'),
  'started_at', (select started_at from public.radar_settings where company_id = p_company),
  'jev', (select jsonb_build_object('provider', x->>'provider', 'model', x->>'model')
    from (select mavi_private.radar_jev_route(p_company) as x) q where x is not null),
  'model', (select jsonb_build_object('provider', p.name, 'model', rt.model)
    from mavi_private.ai_routes rt join mavi_private.ai_providers p on p.id = rt.provider_id and p.active
    where rt.company_id = p_company and ((rt.scope_type = 'feature' and rt.feature = 'client_radar')
     or rt.scope_type = 'company')
    order by case rt.scope_type when 'feature' then 1 else 2 end limit 1),
  'stats', (select jsonb_build_object('done', count(*) filter (where x.status = 'done'),
     'pending', count(*) filter (where x.status = 'pending'), 'failed', count(*) filter (where x.status = 'failed'),
     'skipped', count(*) filter (where x.status = 'skipped'))
    from public.radar_signals x where x.company_id = p_company),
  'cost_30d', (select coalesce(sum(u.cost_usd), 0) from public.ai_usage u where u.company_id = p_company
    and u.module = 'radar' and u.created_at > now() - interval '30 days'));
end $$;

-- Salva os tópicos de uma vez. Um tópico com itens não é excluído: desligue.
-- Status que saem levam os itens para o primeiro status do mesmo tipo.
create function public.save_radar_topics(p_company uuid, p_topics jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare x jsonb; s jsonb; f jsonb; v_ids uuid[] := '{}'; v_keys text[] := '{}'; v_id uuid; v_key text; v_base text;
 v_i integer; v_pos integer := 0; v_statuses jsonb; v_skeys text[]; v_fields jsonb; v_fkeys text[]; v_sources text[];
 v_levels jsonb; v_off uuid[]; v_old public.radar_topics; v_name text; v_skey text; v_ftype text; v_opts jsonb; begin
 if not mavi_private.leader(p_company) then raise exception 'Sem permissão' using errcode = '42501'; end if;
 perform mavi_private.radar_seed(p_company);
 if jsonb_typeof(p_topics) <> 'array' or jsonb_array_length(p_topics) not between 1 and 30 then
  raise exception 'Informe de 1 a 30 tópicos.' using errcode = '22023';
 end if;
 for x in select * from jsonb_array_elements(p_topics) loop
  v_pos := v_pos + 1;
  v_name := btrim(coalesce(x->>'name', ''));
  if length(v_name) not between 2 and 60 then
   raise exception 'Cada tópico precisa de um nome de 2 a 60 caracteres.' using errcode = '22023';
  end if;
  if length(btrim(coalesce(x->>'description', ''))) not between 10 and 2000 then
   raise exception 'Explique o tópico "%" em 10 a 2000 caracteres: é o que a MAVI lê.', v_name using errcode = '22023';
  end if;
  if length(coalesce(x->>'exclude', '')) > 1000 then
   raise exception 'O que não conta em "%" tem até 1000 caracteres.', v_name using errcode = '22023';
  end if;
  if coalesce(x->>'speaker', 'any') not in ('client', 'team', 'any') then
   raise exception 'Quem fala inválido.' using errcode = '22023';
  end if;
  select coalesce(array_agg(distinct v), '{}') into v_sources from jsonb_array_elements_text(
   case when jsonb_typeof(x->'sources') = 'array' then x->'sources' else '["meeting","whatsapp"]' end) v
  where v in ('meeting', 'whatsapp');
  if cardinality(v_sources) = 0 then
   raise exception 'Escolha ao menos uma fonte para "%".', v_name using errcode = '22023';
  end if;
  if x->>'product_id' is not null and not exists (select 1 from public.products where company_id = p_company
   and id::text = x->>'product_id') then
   raise exception 'Produto não encontrado.' using errcode = 'P0002';
  end if;
  -- Gravidade: 4 níveis.
  v_levels := case when jsonb_typeof(x->'severity_levels') = 'array' then (select coalesce(jsonb_agg(left(btrim(l), 200)), '[]')
   from jsonb_array_elements_text(x->'severity_levels') l where btrim(l) <> '') end;
  if v_levels is null or jsonb_array_length(v_levels) <> 4 then
   raise exception 'A escala de "%" tem 4 níveis, do mais leve ao mais sério.', v_name using errcode = '22023';
  end if;
  -- Status: de 2 a 8, ao menos um aberto e um fechado.
  if jsonb_typeof(x->'statuses') <> 'array' or jsonb_array_length(x->'statuses') not between 2 and 8 then
   raise exception 'O tópico "%" tem de 2 a 8 status.', v_name using errcode = '22023';
  end if;
  v_statuses := '[]'; v_skeys := '{}';
  for s in select * from jsonb_array_elements(x->'statuses') loop
   if length(btrim(coalesce(s->>'label', ''))) not between 1 and 30 or coalesce(s->>'color', '') !~* '^#[0-9a-f]{6}$'
    or coalesce(s->>'kind', '') not in ('open', 'progress', 'closed') then
    raise exception 'Cada status de "%" precisa de nome (até 30 caracteres), cor e tipo.', v_name using errcode = '22023';
   end if;
   v_skey := coalesce(nullif(btrim(s->>'key'), ''), left(regexp_replace(mavi_private.temperature_norm(s->>'label'), ' ', '_', 'g'), 30));
   if v_skey !~ '^[a-z][a-z0-9_]{0,39}$' then v_skey := 'status_' || (jsonb_array_length(v_statuses) + 1); end if;
   if v_skey = any(v_skeys) then v_skey := v_skey || '_' || (jsonb_array_length(v_statuses) + 1); end if;
   v_skeys := v_skeys || v_skey;
   v_statuses := v_statuses || jsonb_build_object('key', v_skey, 'label', btrim(s->>'label'), 'color', lower(s->>'color'),
    'kind', s->>'kind', 'reopen', s->>'kind' = 'closed' and coalesce((s->>'reopen')::boolean, false));
  end loop;
  if not exists (select 1 from jsonb_array_elements(v_statuses) q where q->>'kind' = 'open')
   or not exists (select 1 from jsonb_array_elements(v_statuses) q where q->>'kind' = 'closed') then
   raise exception 'O tópico "%" precisa de um status aberto e de um fechado.', v_name using errcode = '22023';
  end if;
  -- Campos extras: até 8.
  v_fields := '[]'; v_fkeys := '{}';
  if jsonb_typeof(x->'fields') = 'array' then
   if jsonb_array_length(x->'fields') > 8 then
    raise exception 'O tópico "%" tem até 8 campos extras.', v_name using errcode = '22023';
   end if;
   for f in select * from jsonb_array_elements(x->'fields') loop
    v_ftype := coalesce(f->>'type', 'text');
    if length(btrim(coalesce(f->>'label', ''))) not between 1 and 40 or v_ftype not in ('text', 'number', 'date', 'choice') then
     raise exception 'Cada campo de "%" precisa de nome (até 40 caracteres) e tipo.', v_name using errcode = '22023';
    end if;
    v_opts := case when v_ftype = 'choice' then (select coalesce(jsonb_agg(distinct left(btrim(o), 60)), '[]')
     from jsonb_array_elements_text(case when jsonb_typeof(f->'options') = 'array' then f->'options' else '[]' end) o
     where btrim(o) <> '') else '[]' end;
    if v_ftype = 'choice' and jsonb_array_length(v_opts) not between 2 and 20 then
     raise exception 'O campo "%" precisa de 2 a 20 opções.', btrim(f->>'label') using errcode = '22023';
    end if;
    v_skey := coalesce(nullif(btrim(f->>'key'), ''), left(regexp_replace(mavi_private.temperature_norm(f->>'label'), ' ', '_', 'g'), 30));
    if v_skey !~ '^[a-z][a-z0-9_]{0,39}$' then v_skey := 'campo_' || (jsonb_array_length(v_fields) + 1); end if;
    if v_skey = any(v_fkeys) then v_skey := v_skey || '_' || (jsonb_array_length(v_fields) + 1); end if;
    v_fkeys := v_fkeys || v_skey;
    v_fields := v_fields || jsonb_build_object('key', v_skey, 'label', btrim(f->>'label'), 'type', v_ftype,
     'options', v_opts, 'hint', left(btrim(coalesce(f->>'hint', '')), 200));
   end loop;
  end if;
  select coalesce(array_agg(distinct p.id), '{}') into v_off from public.products p
  where p.company_id = p_company and p.id::text in (select jsonb_array_elements_text(
   case when jsonb_typeof(x->'off_products') = 'array' then x->'off_products' else '[]' end));

  v_id := case when x->>'id' ~* '^[0-9a-f-]{36}$' then (x->>'id')::uuid end;
  select * into v_old from public.radar_topics where id = v_id and company_id = p_company;
  if found then
   -- Os itens de um status que saiu vão para o primeiro do mesmo tipo.
   update public.radar_items i set status = coalesce(
     (select q->>'key' from jsonb_array_elements(v_statuses) q
      where q->>'kind' = coalesce(mavi_private.radar_status(v_old.statuses, i.status)->>'kind', 'open') limit 1),
     mavi_private.radar_first_status(v_statuses)), status_at = now()
   where i.topic_id = v_id and not (i.status = any(v_skeys));
   update public.radar_topics set product_id = (x->>'product_id')::uuid, name = v_name,
    description = btrim(x->>'description'), exclude = btrim(coalesce(x->>'exclude', '')),
    speaker = coalesce(x->>'speaker', 'any'), sources = v_sources, has_due = coalesce((x->>'has_due')::boolean, false),
    severity = coalesce((x->>'severity')::boolean, true),
    severity_label = coalesce(nullif(left(btrim(x->>'severity_label'), 30), ''), 'Gravidade'),
    severity_levels = v_levels, fields = v_fields, statuses = v_statuses,
    color = case when coalesce(x->>'color', '') ~* '^#[0-9a-f]{6}$' then lower(x->>'color') else color end,
    off_products = case when x->>'product_id' is null then v_off else '{}' end,
    active = coalesce((x->>'active')::boolean, true), position = v_pos, updated_at = now()
   where id = v_id;
  else
   v_base := left(coalesce(nullif(regexp_replace(mavi_private.temperature_norm(v_name), ' ', '_', 'g'), ''), 'topico'), 30);
   if v_base !~ '^[a-z]' then v_base := 't_' || v_base; end if;
   v_base := left(v_base, 30);
   if length(v_base) < 2 then v_base := 'topico'; end if;
   v_key := v_base; v_i := 1;
   while v_key = any(v_keys) or exists (select 1 from public.radar_topics where company_id = p_company
    and key = v_key and not (id = any(v_ids))) loop
    v_i := v_i + 1; v_key := v_base || '_' || v_i;
   end loop;
   insert into public.radar_topics(company_id, product_id, key, name, description, exclude, speaker, sources, has_due,
    severity, severity_label, severity_levels, fields, statuses, color, off_products, active, position)
   values (p_company, (x->>'product_id')::uuid, v_key, v_name, btrim(x->>'description'),
    btrim(coalesce(x->>'exclude', '')), coalesce(x->>'speaker', 'any'), v_sources,
    coalesce((x->>'has_due')::boolean, false), coalesce((x->>'severity')::boolean, true),
    coalesce(nullif(left(btrim(x->>'severity_label'), 30), ''), 'Gravidade'), v_levels, v_fields, v_statuses,
    case when coalesce(x->>'color', '') ~* '^#[0-9a-f]{6}$' then lower(x->>'color') else '#6b52b3' end,
    case when x->>'product_id' is null then v_off else '{}' end, coalesce((x->>'active')::boolean, true), v_pos)
   returning id into v_id;
  end if;
  v_ids := v_ids || v_id;
  v_keys := v_keys || (select key from public.radar_topics where id = v_id);
 end loop;
 select name into v_name from public.radar_topics t where t.company_id = p_company and not (t.id = any(v_ids))
  and exists (select 1 from public.radar_items i where i.topic_id = t.id) limit 1;
 if v_name is not null then
  raise exception 'O tópico "%" já tem itens: desligue-o em vez de excluir.', v_name using errcode = '22023';
 end if;
 delete from public.radar_topics where company_id = p_company and not (id = any(v_ids));
 update public.radar_settings set updated_by = auth.uid(), updated_at = now() where company_id = p_company;
 return public.radar_settings(p_company);
end $$;

-- ------------------------------------------------------------ empresas
select mavi_private.radar_seed(id) from public.companies;

-- ------------------------------------------------------------ permissões
revoke all on function mavi_private.ai_decision_feature(text), mavi_private.radar_jev_route(uuid),
 mavi_private.radar_first_status(jsonb), mavi_private.radar_status(jsonb, text), mavi_private.radar_seed(uuid),
 mavi_private.radar_client_topics(uuid, uuid, text), mavi_private.radar_items_sync(uuid[]),
 mavi_private.radar_forget_signal(uuid), mavi_private.radar_touch(), mavi_private.radar_due(public.radar_signals),
 mavi_private.ai_radar_kick(), mavi_private.radar_topic_json(public.radar_topics),
 mavi_private.radar_item_json(public.radar_items)
 from public, anon, authenticated;
revoke all on function public.ai_set_route(uuid, text, uuid, uuid, text, text), public.set_member_pages(uuid, uuid, text[]),
 public.radar_overview(uuid), public.radar_items(uuid, jsonb), public.radar_item(uuid, uuid),
 public.update_radar_item(uuid, uuid, jsonb), public.client_radar(uuid, uuid), public.radar_settings(uuid),
 public.save_radar_topics(uuid, jsonb)
 from public, anon;
grant execute on function public.ai_set_route(uuid, text, uuid, uuid, text, text), public.set_member_pages(uuid, uuid, text[]),
 public.radar_overview(uuid), public.radar_items(uuid, jsonb), public.radar_item(uuid, uuid),
 public.update_radar_item(uuid, uuid, jsonb), public.client_radar(uuid, uuid), public.radar_settings(uuid),
 public.save_radar_topics(uuid, jsonb)
 to authenticated;
-- O worker chama como anon + segredo.
revoke all on function public.ai_radar_config(text, uuid), public.ai_radar_claim(text, integer),
 public.ai_radar_material(text, uuid), public.ai_radar_store(text, uuid, jsonb), public.ai_radar_fail(text, uuid, text)
 from public, anon, authenticated;
grant execute on function public.ai_radar_config(text, uuid), public.ai_radar_claim(text, integer),
 public.ai_radar_material(text, uuid), public.ai_radar_store(text, uuid, jsonb), public.ai_radar_fail(text, uuid, text)
 to anon, authenticated;

commit;
