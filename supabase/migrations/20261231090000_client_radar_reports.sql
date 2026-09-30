begin;

-- MAVI · Radar do cliente (Fase 3): o relatório da MAVI.
--
-- - Pedido (radar_reports): um administrador ou gestor escolhe o período e os
--   filtros (tópicos, produtos, equipes, clientes) e a MAVI escreve o
--   relatório. O banco calcula os números (material): por tópico, por produto,
--   os temas com mais clientes, os itens sérios, as promessas vencidas e os
--   clientes com mais itens em aberto; a MAVI (a funcionalidade
--   'client_radar_report') escreve o resumo, uma seção por produto e as ações
--   sugeridas. Os números da tela e do PDF são os do banco, não os do texto.
-- - Agendamento (radar_report_schedules): cada pessoa agenda os seus (toda
--   semana num dia, ou todo mês num dia, numa hora; os últimos N dias até a
--   véspera). Quem deixa de ser líder perde o agendamento.
-- - Pronto (ou falhou 3 vezes): quem pediu recebe o aviso 'radar_report' na
--   caixa de entrada e no push (pelas preferências), e a tela sabe pelo
--   Realtime (kind 'radar'), sem consultar de tempos em tempos.
-- - O mesmo worker do Radar (/api/ai, ação "ai-radar") escreve os relatórios
--   depois das leituras e dos temas; pedir um relatório já acorda o worker.

alter table mavi_private.ai_routes drop constraint ai_routes_feature_check;
alter table mavi_private.ai_routes add constraint ai_routes_feature_check
 check ((scope_type = 'feature') = (feature is not null)
  and (feature is null or feature in ('assistant', 'meetings_history', 'meetings_ask',
   'whatsapp_task', 'social_leads_plan', 'social_leads_adjust', 'social_leads_briefing', 'social_leads_colors',
   'task_copilot', 'client_dossier', 'copilot_learning', 'notice_writer', 'notice_animation',
   'client_temperature', 'client_temperature_text', 'task_audio',
   'whatsapp_transcribe', 'task_audio_transcribe', 'image_generation', 'mavi_page', 'web_search', 'canvas_writer',
   'mavi_rerank', 'conversation_summary', 'skill_coach', 'whatsapp_history', 'client_radar', 'client_radar_check',
   'client_radar_themes', 'client_radar_report')));

-- A da migração 20261230090000, com o relatório do Radar.
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
  'client_radar_themes', 'client_radar_report') then
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

-- ------------------------------------------------------------ avisos
-- A da migração 20261220090000, com o relatório do Radar pronto.
alter table public.notifications drop constraint notifications_kind_check;
alter table public.notifications add constraint notifications_kind_check
 check (kind in ('mention', 'assigned', 'reply', 'social_leads', 'ai_share', 'success_case', 'notice',
  'notice_animation', 'temperature', 'tasks_assigned', 'due_risk', 'status', 'review', 'ai_skill', 'ai_answer',
  'radar_report'));
alter table public.notifications drop constraint notifications_target_check;
alter table public.notifications add constraint notifications_target_check
 check ((kind in ('social_leads', 'ai_share', 'success_case', 'notice', 'notice_animation', 'temperature',
   'tasks_assigned', 'due_risk', 'ai_skill', 'ai_answer', 'radar_report')) = (task_id is null)
  and (task_id is not null or (title is not null and link is not null))
  and ((kind = 'notice') = (notice_id is not null)));
create or replace function mavi_private.notification_pref_keys() returns text[]
language sql immutable set search_path = '' as $$
 select array['assigned', 'mention', 'reply', 'review', 'due_risk',
  'social_leads', 'ai_share', 'success_case', 'temperature', 'ai_skill', 'ai_answer', 'radar_report']
  || array(select 'status.' || s || '.' || r
   from unnest(array['progress', 'returned', 'review', 'rejected', 'correction', 'done']) s,
        unnest(array['creator', 'assignee', 'participant']) r)
$$;

-- ------------------------------------------------------------ tabelas
create table public.radar_report_schedules (
 id uuid primary key default gen_random_uuid(),
 company_id uuid not null references public.companies(id),
 user_id uuid not null,
 name text not null check (length(btrim(name)) between 2 and 120),
 -- weekly: no dia da semana (1 = segunda … 7 = domingo); monthly: no dia do mês.
 frequency text not null check (frequency in ('weekly', 'monthly')),
 weekday smallint not null default 1 check (weekday between 1 and 7),
 month_day smallint not null default 1 check (month_day between 1 and 28),
 hour smallint not null default 8 check (hour between 0 and 23),
 -- O período: os últimos N dias até a véspera.
 period_days integer not null default 7 check (period_days between 1 and 366),
 filters jsonb not null default '{}' check (jsonb_typeof(filters) = 'object'),
 active boolean not null default true,
 next_run_at timestamptz,
 last_run_at timestamptz,
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 foreign key (company_id, user_id) references public.memberships(company_id, user_id) on delete cascade
);
create index radar_report_schedules_due on public.radar_report_schedules (next_run_at) where active;
alter table public.radar_report_schedules enable row level security;
revoke all on public.radar_report_schedules from public, anon, authenticated;

create table public.radar_reports (
 id uuid primary key default gen_random_uuid(),
 company_id uuid not null references public.companies(id),
 -- Quem pediu (ou o dono do agendamento): recebe o aviso.
 requested_by uuid,
 schedule_id uuid references public.radar_report_schedules(id) on delete set null,
 title text not null check (length(btrim(title)) between 2 and 200),
 period_from date not null,
 period_to date not null,
 -- {topics, products ('none' = Geral), teams, clients}
 filters jsonb not null default '{}' check (jsonb_typeof(filters) = 'object'),
 status text not null default 'pending' check (status in ('pending', 'running', 'done', 'failed')),
 attempts integer not null default 0,
 claimed_until timestamptz,
 error text,
 -- Os números (calculados pelo banco na hora de escrever).
 material jsonb,
 -- O texto da MAVI: {headline, summary, sections: [{title, paragraphs, bullets}], actions: [{priority, text}]}.
 content jsonb,
 model text,
 cost_usd numeric not null default 0,
 created_at timestamptz not null default now(),
 finished_at timestamptz,
 check (period_from <= period_to)
);
create index radar_reports_company on public.radar_reports (company_id, created_at desc);
create index radar_reports_due on public.radar_reports (created_at) where status in ('pending', 'running');
alter table public.radar_reports enable row level security;
revoke all on public.radar_reports from public, anon, authenticated;

-- ------------------------------------------------------------ filtros
-- Os filtros que valem na empresa: {topics, products (e 'none'), teams, clients}.
create function mavi_private.radar_report_filters(c uuid, p_filters jsonb) returns jsonb
language sql stable security definer set search_path = '' as $$
 with f as (select case when jsonb_typeof(p_filters) = 'object' then p_filters else '{}'::jsonb end as v),
 ids as (
  select x.key, e.value as id from f, lateral (values ('topics'), ('products'), ('teams'), ('clients')) x(key),
   lateral jsonb_array_elements_text(case when jsonb_typeof(f.v->x.key) = 'array' then f.v->x.key else '[]' end) e
 )
 select jsonb_build_object(
  'topics', coalesce((select jsonb_agg(distinct t.id) from ids join public.radar_topics t on t.id::text = ids.id
    where ids.key = 'topics' and t.company_id = c), '[]'),
  'products', coalesce((select jsonb_agg(distinct x) from (
    select p.id::text as x from ids join public.products p on p.id::text = ids.id where ids.key = 'products' and p.company_id = c
    union select 'none' from ids where ids.key = 'products' and ids.id = 'none') q), '[]'),
  'teams', coalesce((select jsonb_agg(distinct t.id) from ids join public.teams t on t.id::text = ids.id
    where ids.key = 'teams' and t.company_id = c), '[]'),
  'clients', coalesce((select jsonb_agg(distinct k.id) from ids join public.clients k on k.id::text = ids.id
    where ids.key = 'clients' and k.company_id = c), '[]'))
$$;

-- Os nomes dos filtros (para o texto e para a tela).
create function mavi_private.radar_report_labels(c uuid, p_filters jsonb) returns jsonb
language sql stable security definer set search_path = '' as $$
 select jsonb_build_object(
  'topics', coalesce((select jsonb_agg(t.name order by t.position, t.name) from public.radar_topics t
    where t.company_id = c and t.id::text in (select jsonb_array_elements_text(p_filters->'topics'))), '[]'),
  'products', coalesce((select jsonb_agg(x order by x) from (
    select p.name as x from public.products p where p.company_id = c
     and p.id::text in (select jsonb_array_elements_text(p_filters->'products'))
    union all select 'Geral / Agência' where p_filters->'products' ? 'none') q), '[]'),
  'teams', coalesce((select jsonb_agg(t.name order by t.name) from public.teams t where t.company_id = c
    and t.id::text in (select jsonb_array_elements_text(p_filters->'teams'))), '[]'),
  'clients', coalesce((select jsonb_agg(k.name order by k.name) from public.clients k where k.company_id = c
    and k.id::text in (select jsonb_array_elements_text(p_filters->'clients'))), '[]'))
$$;

-- ------------------------------------------------------------ os números
-- O retrato do período: por tópico, por produto e tópico, os temas com mais
-- clientes, os itens sérios em aberto, as promessas vencidas, os clientes
-- com mais itens em aberto e uma amostra dos itens novos. "Novo" = apareceu
-- a primeira vez no período; "ativo" = apareceu no período; "em aberto" e
-- "vencido" = hoje.
create function mavi_private.radar_report_material(c uuid, p_from date, p_to date, p_filters jsonb) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare f jsonb := mavi_private.radar_report_filters(c, p_filters); v_tz text; v_start timestamptz; v_end timestamptz;
 v_today date; v_topics uuid[]; v_products uuid[]; v_none boolean; v_teams uuid[]; v_clients uuid[]; v_out jsonb; begin
 select timezone into v_tz from public.companies where id = c;
 v_tz := coalesce(v_tz, 'America/Sao_Paulo');
 v_start := p_from::timestamp at time zone v_tz;
 v_end := (p_to + 1)::timestamp at time zone v_tz;
 v_today := (now() at time zone v_tz)::date;
 v_topics := array(select x::uuid from jsonb_array_elements_text(f->'topics') x);
 v_products := array(select x::uuid from jsonb_array_elements_text(f->'products') x where x <> 'none');
 v_none := f->'products' ? 'none';
 v_teams := array(select x::uuid from jsonb_array_elements_text(f->'teams') x);
 v_clients := array(select x::uuid from jsonb_array_elements_text(f->'clients') x);
 with it as materialized (
  select i.id, i.topic_id, i.product_id, i.client_id, i.theme_id, i.title, i.summary, i.severity, i.due_date,
   i.mentions, i.created_at, i.last_seen_at, i.status_at, i.assignee_id, t.name as topic_name, t.position as topic_pos,
   t.has_due, coalesce(mavi_private.radar_status(t.statuses, i.status)->>'kind', '') as kind,
   coalesce(mavi_private.radar_status(t.statuses, i.status)->>'label', i.status) as status_label,
   coalesce(p.name, 'Geral / Agência') as product_name, k.name as client_name,
   i.created_at >= v_start and i.created_at < v_end as is_new
  from public.radar_items i
  join public.radar_topics t on t.id = i.topic_id
  join public.clients k on k.id = i.client_id and not k.archived
  left join public.products p on p.id = i.product_id
  where i.company_id = c
   and (cardinality(v_topics) = 0 or i.topic_id = any(v_topics))
   and ((cardinality(v_products) = 0 and not v_none) or i.product_id = any(v_products) or (v_none and i.product_id is null))
   and (cardinality(v_teams) = 0 or exists (select 1 from public.client_teams ct where ct.company_id = c
    and ct.client_id = i.client_id and ct.team_id = any(v_teams)))
   and (cardinality(v_clients) = 0 or i.client_id = any(v_clients))
 ), mp as materialized (
  select m.item_id, count(*)::integer as n, max(m.occurred_at) as last_at
  from public.radar_mentions m join it on it.id = m.item_id
  where m.occurred_at >= v_start and m.occurred_at < v_end
  group by m.item_id
 ), x as materialized (
  select it.*, coalesce(mp.n, 0) as period_mentions, it.is_new or mp.n is not null as active
  from it left join mp on mp.item_id = it.id
 )
 select jsonb_build_object(
  'period', jsonb_build_object('from', p_from, 'to', p_to),
  'today', v_today,
  'company', (select name from public.companies where id = c),
  'filters', mavi_private.radar_report_labels(c, f),
  'topics', coalesce((select jsonb_agg(jsonb_build_object('topic', q.topic_name, 'has_due', q.has_due,
     'new', q.new, 'active', q.active, 'open', q.open, 'closed', q.closed, 'severe', q.severe,
     'overdue', q.overdue, 'mentions', q.mentions, 'clients', q.clients) order by q.pos, q.topic_name)
    from (select x.topic_id, min(x.topic_name) as topic_name, min(x.topic_pos) as pos, bool_or(x.has_due) as has_due,
      count(*) filter (where x.is_new) as new, count(*) filter (where x.active) as active,
      count(*) filter (where x.kind <> 'closed') as open,
      count(*) filter (where x.kind = 'closed' and x.status_at >= v_start and x.status_at < v_end) as closed,
      count(*) filter (where x.kind <> 'closed' and x.severity >= 2) as severe,
      count(*) filter (where x.has_due and x.kind <> 'closed' and x.due_date < v_today) as overdue,
      sum(x.period_mentions) as mentions, count(distinct x.client_id) filter (where x.active) as clients
     from x group by x.topic_id) q), '[]'),
  'products', coalesce((select jsonb_agg(jsonb_build_object('product', pq.product_name, 'clients', pq.clients,
     'topics', pq.topics) order by pq.weight desc, pq.product_name)
    from (select tq.product_name, sum(tq.new + tq.open) as weight,
      (select count(distinct x2.client_id) from x x2 where x2.product_name = tq.product_name and x2.active) as clients,
      jsonb_agg(jsonb_build_object('topic', tq.topic_name, 'new', tq.new, 'open', tq.open, 'severe', tq.severe,
       'overdue', tq.overdue, 'closed', tq.closed) order by tq.pos) as topics
     from (select x.product_name, x.topic_id, min(x.topic_name) as topic_name, min(x.topic_pos) as pos,
       count(*) filter (where x.is_new) as new, count(*) filter (where x.kind <> 'closed') as open,
       count(*) filter (where x.kind <> 'closed' and x.severity >= 2) as severe,
       count(*) filter (where x.has_due and x.kind <> 'closed' and x.due_date < v_today) as overdue,
       count(*) filter (where x.kind = 'closed' and x.status_at >= v_start and x.status_at < v_end) as closed
      from x group by x.product_name, x.topic_id) tq
     group by tq.product_name) pq), '[]'),
  'themes', coalesce((select jsonb_agg(jsonb_build_object('title', th.title, 'summary', th.summary,
     'topic', tq.topic_name, 'product', tq.product_name, 'clients', tq.clients, 'items', tq.items, 'open', tq.open,
     'mentions', tq.mentions, 'max_severity', tq.max_severity, 'client_names', to_jsonb(tq.client_names),
     'quotes', coalesce((select jsonb_agg(q.quote) from (select m.quote from public.radar_mentions m
        join x on x.id = m.item_id where x.theme_id = th.id and m.occurred_at >= v_start and m.occurred_at < v_end
        order by m.occurred_at desc limit 2) q), '[]'))
    order by tq.clients desc, tq.mentions desc)
    from (select x.theme_id, min(x.topic_name) as topic_name, min(x.product_name) as product_name,
      count(distinct x.client_id) as clients, count(*) as items, count(*) filter (where x.kind <> 'closed') as open,
      sum(x.period_mentions) as mentions, max(x.severity) as max_severity,
      (array_agg(distinct x.client_name))[1:6] as client_names
     from x where x.theme_id is not null group by x.theme_id
     having bool_or(x.active)
     order by count(distinct x.client_id) desc, sum(x.period_mentions) desc limit 20) tq
    join public.radar_themes th on th.id = tq.theme_id), '[]'),
  'severe', coalesce((select jsonb_agg(jsonb_build_object('topic', s.topic_name, 'product', s.product_name,
     'client', s.client_name, 'title', s.title, 'summary', left(s.summary, 300), 'severity', s.severity,
     'status', s.status_label, 'mentions', s.mentions, 'last_seen', s.last_seen_at::date)
    order by s.severity desc, s.last_seen_at desc)
    from (select * from x where x.kind <> 'closed' and x.severity >= 2
     order by x.severity desc, x.last_seen_at desc limit 15) s), '[]'),
  'overdue', coalesce((select jsonb_agg(jsonb_build_object('topic', o.topic_name, 'product', o.product_name,
     'client', o.client_name, 'title', o.title, 'due_date', o.due_date, 'status', o.status_label,
     'assignee', (select name from public.memberships m where m.company_id = c and m.user_id = o.assignee_id))
    order by o.due_date)
    from (select * from x where x.has_due and x.kind <> 'closed' and x.due_date < v_today
     order by x.due_date limit 20) o), '[]'),
  'clients', coalesce((select jsonb_agg(jsonb_build_object('client', cq.client_name, 'open', cq.open,
     'severe', cq.severe, 'new', cq.new) order by cq.open desc, cq.severe desc)
    from (select x.client_name, count(*) filter (where x.kind <> 'closed') as open,
      count(*) filter (where x.kind <> 'closed' and x.severity >= 2) as severe, count(*) filter (where x.is_new) as new
     from x group by x.client_id, x.client_name having count(*) filter (where x.kind <> 'closed') > 0
     order by 2 desc, 3 desc limit 10) cq), '[]'),
  'new_items', coalesce((select jsonb_agg(jsonb_build_object('topic', n.topic_name, 'product', n.product_name,
     'client', n.client_name, 'title', n.title, 'severity', n.severity, 'status', n.status_label)
    order by n.created_at desc)
    from (select * from x where x.is_new order by x.created_at desc limit 40) n), '[]'))
 into v_out;
 return v_out;
end $$;

-- ------------------------------------------------------------ agendamento
-- A próxima vez depois de p_after, na hora certa no fuso da empresa.
create function mavi_private.radar_schedule_next(p_frequency text, p_weekday integer, p_month_day integer,
 p_hour integer, p_tz text, p_after timestamptz) returns timestamptz
language plpgsql stable set search_path = '' as $$
declare d date := (p_after at time zone p_tz)::date; cand timestamptz; begin
 for i in 0..62 loop
  cand := ((d + i)::timestamp + make_interval(hours => p_hour)) at time zone p_tz;
  if cand > p_after and ((p_frequency = 'weekly' and extract(isodow from d + i) = p_weekday)
   or (p_frequency = 'monthly' and extract(day from d + i) = p_month_day)) then
   return cand;
  end if;
 end loop;
 return null;
end $$;

create function mavi_private.radar_report_json(r public.radar_reports, p_full boolean) returns jsonb
language sql stable security definer set search_path = '' as $$
 select jsonb_build_object('id', r.id, 'title', r.title, 'period_from', r.period_from, 'period_to', r.period_to,
  'filters', r.filters, 'labels', mavi_private.radar_report_labels(r.company_id, r.filters), 'status', r.status,
  'error', r.error, 'requested_by', r.requested_by,
  'requested_by_name', (select name from public.memberships m where m.company_id = r.company_id and m.user_id = r.requested_by),
  'schedule_id', r.schedule_id, 'schedule_name', (select s.name from public.radar_report_schedules s where s.id = r.schedule_id),
  'headline', r.content->>'headline', 'created_at', r.created_at, 'finished_at', r.finished_at,
  'cost_usd', r.cost_usd)
  || case when p_full then jsonb_build_object('material', r.material, 'content', r.content, 'model', r.model)
   else '{}'::jsonb end
$$;

-- ------------------------------------------------------------ pedidos
create function public.request_radar_report(p_company uuid, p_from date, p_to date, p_filters jsonb,
 p_title text default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare r public.radar_reports; f jsonb; begin
 if not mavi_private.leader(p_company) then raise exception 'Sem permissão' using errcode = '42501'; end if;
 if p_from is null or p_to is null or p_from > p_to then
  raise exception 'Escolha um período válido.' using errcode = '22023';
 end if;
 if p_to - p_from > 366 then raise exception 'O período tem até um ano.' using errcode = '22023'; end if;
 f := mavi_private.radar_report_filters(p_company, p_filters);
 insert into public.radar_reports(company_id, requested_by, title, period_from, period_to, filters)
 values (p_company, auth.uid(), coalesce(nullif(left(btrim(coalesce(p_title, '')), 200), ''),
   format('Radar do cliente · %s a %s', to_char(p_from, 'DD/MM/YYYY'), to_char(p_to, 'DD/MM/YYYY'))),
  p_from, p_to, f)
 returning * into r;
 perform mavi_private.broadcast(p_company, jsonb_build_object('kind', 'radar', 'report', r.id, 'status', r.status));
 perform mavi_private.ai_radar_kick();
 return mavi_private.radar_report_json(r, false);
end $$;

create function public.radar_reports(p_company uuid, p_limit integer default 50, p_offset integer default 0)
returns jsonb
language plpgsql stable security definer set search_path = '' as $$ begin
 if not mavi_private.leader(p_company) then raise exception 'Sem permissão' using errcode = '42501'; end if;
 return jsonb_build_object(
  'total', (select count(*) from public.radar_reports where company_id = p_company),
  'reports', coalesce((select jsonb_agg(mavi_private.radar_report_json(r, false) order by r.created_at desc)
    from (select * from public.radar_reports where company_id = p_company order by created_at desc
      limit least(greatest(coalesce(p_limit, 50), 1), 100) offset greatest(coalesce(p_offset, 0), 0)) r), '[]'));
end $$;

create function public.radar_report(p_company uuid, p_report uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare r public.radar_reports; begin
 if not mavi_private.leader(p_company) then raise exception 'Sem permissão' using errcode = '42501'; end if;
 select * into r from public.radar_reports where company_id = p_company and id = p_report;
 if not found then raise exception 'Relatório não encontrado.' using errcode = 'P0002'; end if;
 return mavi_private.radar_report_json(r, true);
end $$;

-- Tenta de novo um relatório que falhou.
create function public.retry_radar_report(p_company uuid, p_report uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare r public.radar_reports; begin
 if not mavi_private.leader(p_company) then raise exception 'Sem permissão' using errcode = '42501'; end if;
 update public.radar_reports set status = 'pending', attempts = 0, claimed_until = null, error = null
 where company_id = p_company and id = p_report and status = 'failed'
 returning * into r;
 if not found then raise exception 'Só dá para tentar de novo um relatório que falhou.' using errcode = '22023'; end if;
 perform mavi_private.broadcast(p_company, jsonb_build_object('kind', 'radar', 'report', r.id, 'status', r.status));
 perform mavi_private.ai_radar_kick();
 return mavi_private.radar_report_json(r, false);
end $$;

-- Quem pediu ou um administrador exclui.
create function public.delete_radar_report(p_company uuid, p_report uuid) returns void
language plpgsql security definer set search_path = '' as $$ begin
 if not mavi_private.leader(p_company) then raise exception 'Sem permissão' using errcode = '42501'; end if;
 delete from public.radar_reports where company_id = p_company and id = p_report
  and (requested_by = auth.uid() or mavi_private.admin(p_company));
 if not found then raise exception 'Só quem pediu (ou um administrador) exclui o relatório.' using errcode = '42501'; end if;
 perform mavi_private.broadcast(p_company, jsonb_build_object('kind', 'radar', 'report', p_report, 'status', 'deleted'));
end $$;

-- Os agendamentos da pessoa.
create function public.radar_report_schedules(p_company uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$ begin
 if not mavi_private.leader(p_company) then raise exception 'Sem permissão' using errcode = '42501'; end if;
 return coalesce((select jsonb_agg(jsonb_build_object('id', s.id, 'name', s.name, 'frequency', s.frequency,
   'weekday', s.weekday, 'month_day', s.month_day, 'hour', s.hour, 'period_days', s.period_days,
   'filters', s.filters, 'labels', mavi_private.radar_report_labels(s.company_id, s.filters), 'active', s.active,
   'next_run_at', s.next_run_at, 'last_run_at', s.last_run_at) order by s.created_at)
  from public.radar_report_schedules s where s.company_id = p_company and s.user_id = auth.uid()), '[]');
end $$;

create function public.save_radar_report_schedule(p_company uuid, p_schedule jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v jsonb := coalesce(p_schedule, '{}'); v_id uuid; v_tz text; v_freq text; v_week integer; v_day integer;
 v_hour integer; v_days integer; v_active boolean; begin
 if not mavi_private.leader(p_company) then raise exception 'Sem permissão' using errcode = '42501'; end if;
 v_freq := coalesce(v->>'frequency', 'weekly');
 if v_freq not in ('weekly', 'monthly') then raise exception 'Frequência inválida.' using errcode = '22023'; end if;
 v_week := coalesce((v->>'weekday')::integer, 1);
 v_day := coalesce((v->>'month_day')::integer, 1);
 v_hour := coalesce((v->>'hour')::integer, 8);
 v_days := coalesce((v->>'period_days')::integer, case v_freq when 'weekly' then 7 else 30 end);
 v_active := coalesce((v->>'active')::boolean, true);
 if v_week not between 1 and 7 or v_day not between 1 and 28 or v_hour not between 0 and 23
  or v_days not between 1 and 366 then
  raise exception 'Dia, hora ou período inválido.' using errcode = '22023';
 end if;
 if length(btrim(coalesce(v->>'name', ''))) not between 2 and 120 then
  raise exception 'Dê um nome de 2 a 120 caracteres ao agendamento.' using errcode = '22023';
 end if;
 select timezone into v_tz from public.companies where id = p_company;
 v_id := case when v->>'id' ~* '^[0-9a-f-]{36}$' then (v->>'id')::uuid end;
 if v_id is not null then
  update public.radar_report_schedules set name = btrim(v->>'name'), frequency = v_freq, weekday = v_week,
   month_day = v_day, hour = v_hour, period_days = v_days,
   filters = mavi_private.radar_report_filters(p_company, v->'filters'), active = v_active,
   next_run_at = case when v_active then mavi_private.radar_schedule_next(v_freq, v_week, v_day, v_hour,
     coalesce(v_tz, 'America/Sao_Paulo'), now()) end,
   updated_at = now()
  where id = v_id and company_id = p_company and user_id = auth.uid();
  if not found then raise exception 'Agendamento não encontrado.' using errcode = 'P0002'; end if;
 else
  if (select count(*) from public.radar_report_schedules where company_id = p_company and user_id = auth.uid()) >= 10 then
   raise exception 'Cada pessoa tem até 10 agendamentos.' using errcode = '22023';
  end if;
  insert into public.radar_report_schedules(company_id, user_id, name, frequency, weekday, month_day, hour,
   period_days, filters, active, next_run_at)
  values (p_company, auth.uid(), btrim(v->>'name'), v_freq, v_week, v_day, v_hour, v_days,
   mavi_private.radar_report_filters(p_company, v->'filters'), v_active,
   case when v_active then mavi_private.radar_schedule_next(v_freq, v_week, v_day, v_hour,
     coalesce(v_tz, 'America/Sao_Paulo'), now()) end);
 end if;
 return public.radar_report_schedules(p_company);
end $$;

create function public.delete_radar_report_schedule(p_company uuid, p_schedule uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$ begin
 if not mavi_private.leader(p_company) then raise exception 'Sem permissão' using errcode = '42501'; end if;
 delete from public.radar_report_schedules where company_id = p_company and id = p_schedule and user_id = auth.uid();
 if not found then raise exception 'Agendamento não encontrado.' using errcode = 'P0002'; end if;
 return public.radar_report_schedules(p_company);
end $$;

-- ------------------------------------------------------------ worker
-- Os agendamentos vencidos viram pedidos (de quem ainda é líder); depois
-- reserva alguns pedidos e calcula os números de cada um.
create function public.ai_radar_report_claim(p_secret text, p_limit integer default 2) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare s public.radar_report_schedules; v_tz text; v_to date; r public.radar_reports; v_out jsonb := '[]'; begin
 if not mavi_private.ai_secret_ok(p_secret) then raise exception 'Sem permissão' using errcode = '42501'; end if;
 for s in select * from public.radar_report_schedules x where x.active and x.next_run_at <= now()
  order by x.next_run_at limit 20 for update skip locked loop
  select timezone into v_tz from public.companies where id = s.company_id;
  v_tz := coalesce(v_tz, 'America/Sao_Paulo');
  if not exists (select 1 from public.memberships m where m.company_id = s.company_id and m.user_id = s.user_id
   and m.active and m.role in ('admin', 'manager')) then
   update public.radar_report_schedules set active = false, next_run_at = null, updated_at = now() where id = s.id;
   continue;
  end if;
  v_to := (now() at time zone v_tz)::date - 1;
  insert into public.radar_reports(company_id, requested_by, schedule_id, title, period_from, period_to, filters)
  values (s.company_id, s.user_id, s.id, left(format('%s · %s a %s', s.name, to_char(v_to - s.period_days + 1, 'DD/MM'),
    to_char(v_to, 'DD/MM/YYYY')), 200), v_to - s.period_days + 1, v_to, s.filters);
  update public.radar_report_schedules set last_run_at = now(),
   next_run_at = mavi_private.radar_schedule_next(s.frequency, s.weekday, s.month_day, s.hour, v_tz, now())
  where id = s.id;
 end loop;
 for r in
  with due as (
   select x.id from public.radar_reports x
   where x.status in ('pending', 'running') and x.attempts < 3
    and (x.claimed_until is null or x.claimed_until < now())
   order by x.created_at limit least(greatest(coalesce(p_limit, 2), 1), 5)
   for update skip locked
  )
  update public.radar_reports x set status = 'running', attempts = x.attempts + 1,
   claimed_until = now() + interval '10 minutes'
  from due where x.id = due.id
  returning x.*
 loop
  update public.radar_reports set material = mavi_private.radar_report_material(r.company_id, r.period_from,
   r.period_to, r.filters) where id = r.id
  returning * into r;
  perform mavi_private.broadcast(r.company_id, jsonb_build_object('kind', 'radar', 'report', r.id, 'status', r.status));
  v_out := v_out || jsonb_build_object('id', r.id, 'company_id', r.company_id, 'title', r.title,
   'period_from', r.period_from, 'period_to', r.period_to, 'material', r.material);
 end loop;
 return v_out;
end $$;

-- O texto da MAVI: o relatório fica pronto e quem pediu recebe o aviso.
create function public.ai_radar_report_store(p_secret text, p_report uuid, p_content jsonb, p_usage jsonb)
returns void
language plpgsql security definer set search_path = '' as $$
declare r public.radar_reports; v_cost numeric := least(greatest(coalesce((p_usage->>'cost')::numeric, 0), 0), 20); begin
 if not mavi_private.ai_secret_ok(p_secret) then raise exception 'Sem permissão' using errcode = '42501'; end if;
 if jsonb_typeof(p_content) is distinct from 'object' then raise exception 'Conteúdo inválido.' using errcode = '22023'; end if;
 update public.radar_reports set status = 'done', content = p_content, error = null, claimed_until = null,
  finished_at = now(), model = left(coalesce(p_usage->>'model', ''), 80), cost_usd = cost_usd + v_cost
 where id = p_report and status = 'running'
 returning * into r;
 if not found then return; end if;
 if jsonb_typeof(p_usage) = 'object' then
  insert into public.ai_usage(company_id, user_id, module, kind, client_id, model, input_tokens, output_tokens,
   cache_read_tokens, cache_write_tokens, cost_usd, provider_id, provider_name)
  values (r.company_id, r.requested_by, 'radar', 'radar_report', null, left(coalesce(p_usage->>'model', ''), 80),
   greatest(coalesce((p_usage->>'input')::integer, 0), 0), greatest(coalesce((p_usage->>'output')::integer, 0), 0),
   greatest(coalesce((p_usage->>'cache_read')::integer, 0), 0), greatest(coalesce((p_usage->>'cache_write')::integer, 0), 0),
   v_cost, case when p_usage->>'provider_id' ~* '^[0-9a-f-]{36}$' then (p_usage->>'provider_id')::uuid end,
   left(coalesce(p_usage->>'provider', ''), 120));
 end if;
 if r.requested_by is not null and exists (select 1 from public.memberships m where m.company_id = r.company_id
  and m.user_id = r.requested_by and m.active) then
  insert into public.notifications(company_id, user_id, actor_id, task_id, kind, title, body, link)
  values (r.company_id, r.requested_by, null, null, 'radar_report', left('Relatório do Radar pronto: ' || r.title, 300),
   left(coalesce(p_content->>'headline', ''), 300), '/radar?relatorio=' || r.id);
 end if;
 perform mavi_private.broadcast(r.company_id, jsonb_build_object('kind', 'radar', 'report', r.id, 'status', r.status));
end $$;

-- Falhou: tenta de novo mais tarde (até 3 vezes); na última, avisa quem pediu.
create function public.ai_radar_report_fail(p_secret text, p_report uuid, p_error text) returns void
language plpgsql security definer set search_path = '' as $$
declare r public.radar_reports; begin
 if not mavi_private.ai_secret_ok(p_secret) then raise exception 'Sem permissão' using errcode = '42501'; end if;
 update public.radar_reports set error = left(coalesce(p_error, ''), 500),
  status = case when attempts >= 3 then 'failed' else 'pending' end,
  claimed_until = case when attempts >= 3 then null else now() + attempts * interval '5 minutes' end
 where id = p_report and status = 'running'
 returning * into r;
 if not found then return; end if;
 if r.status = 'failed' and r.requested_by is not null and exists (select 1 from public.memberships m
  where m.company_id = r.company_id and m.user_id = r.requested_by and m.active) then
  insert into public.notifications(company_id, user_id, actor_id, task_id, kind, title, body, link)
  values (r.company_id, r.requested_by, null, null, 'radar_report', left('Não deu para escrever o relatório: ' || r.title, 300),
   left(coalesce(r.error, ''), 300), '/radar?relatorio=' || r.id);
 end if;
 perform mavi_private.broadcast(r.company_id, jsonb_build_object('kind', 'radar', 'report', r.id, 'status', r.status));
end $$;

-- pg_cron: acorda o worker quando há leitura, item sem tema, relatório
-- pedido ou agendamento vencido.
create or replace function mavi_private.ai_radar_kick() returns void
language plpgsql security definer set search_path = '' as $$
declare cfg mavi_private.ai_config; begin
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

-- ------------------------------------------------------------ permissões
revoke all on function mavi_private.radar_report_filters(uuid, jsonb), mavi_private.radar_report_labels(uuid, jsonb),
 mavi_private.radar_report_material(uuid, date, date, jsonb),
 mavi_private.radar_schedule_next(text, integer, integer, integer, text, timestamptz),
 mavi_private.radar_report_json(public.radar_reports, boolean), mavi_private.ai_radar_kick()
 from public, anon, authenticated;
revoke all on function public.ai_set_route(uuid, text, uuid, uuid, text, text),
 public.request_radar_report(uuid, date, date, jsonb, text), public.radar_reports(uuid, integer, integer),
 public.radar_report(uuid, uuid), public.retry_radar_report(uuid, uuid), public.delete_radar_report(uuid, uuid),
 public.radar_report_schedules(uuid), public.save_radar_report_schedule(uuid, jsonb),
 public.delete_radar_report_schedule(uuid, uuid)
 from public, anon;
grant execute on function public.ai_set_route(uuid, text, uuid, uuid, text, text),
 public.request_radar_report(uuid, date, date, jsonb, text), public.radar_reports(uuid, integer, integer),
 public.radar_report(uuid, uuid), public.retry_radar_report(uuid, uuid), public.delete_radar_report(uuid, uuid),
 public.radar_report_schedules(uuid), public.save_radar_report_schedule(uuid, jsonb),
 public.delete_radar_report_schedule(uuid, uuid)
 to authenticated;
-- O worker chama como anon + segredo.
revoke all on function public.ai_radar_report_claim(text, integer), public.ai_radar_report_store(text, uuid, jsonb, jsonb),
 public.ai_radar_report_fail(text, uuid, text)
 from public, anon, authenticated;
grant execute on function public.ai_radar_report_claim(text, integer), public.ai_radar_report_store(text, uuid, jsonb, jsonb),
 public.ai_radar_report_fail(text, uuid, text)
 to anon, authenticated;

commit;
