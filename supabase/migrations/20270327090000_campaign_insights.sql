begin;

-- Campanhas › Insights da MAVI, Fase 1 (pedido de 04/10/2026).
--
-- De tempos em tempos a MAVI analisa cada campanha ativa do Meta e do Google
-- (as campanhas da plataforma vinculadas ao ciclo atual) e traz insights
-- aplicáveis: destaques, oportunidades, problemas e correções de
-- rastreamento (UTM). Cruza os números da plataforma (ciclo, 7, 15 e 30 dias
-- e desde a última análise) com o MakeCRM por UTM e com o contexto do
-- cliente (dossiê, Radar, Termômetro e as últimas reuniões).
--
-- * Prova obrigatória: todo insight traz evidências em números. A MAVI só
--   aponta ONDE está cada número (entidade, janela e métrica); quem preenche
--   o valor é o servidor, a partir do material lido. Insight sem evidência
--   que confira é descartado. O Jev (funcionalidade 'campaign_insights_check')
--   confere, quando cadastrado, se as evidências sustentam o que foi dito.
-- * Frequência: o padrão da empresa (diário, dias da semana ou a cada N dias,
--   a partir de uma hora) e ajustes por cliente ou por campanha — o mais
--   específico vence; cada um pode desligar. Administradores e gestores
--   configuram no Painel da MAVI (#campanhas).
-- * "Analisar agora": quem vê a campanha pede; respeita o intervalo mínimo
--   desde a última análise e mostra o histórico (auditoria e custo).
-- * Custo: teto por mês da empresa (no teto, as análises param até o mês
--   virar), teto por análise (o worker enxuga o material para caber) e o
--   custo de cada análise visível no histórico. Gasto em ai_usage, módulo
--   'campaign_insights'.
-- * Onde aparece: painel lateral no detalhe da campanha, selo na lista, aba
--   "Insights", caixa de entrada (com a prioridade mínima e quem recebe) e o
--   contexto da MAVI — cada um ligado ou desligado pelos líderes.
-- * Quem vê: todos que veem a campanha (a regra do módulo), inclusive os
--   valores em R$, sempre com a indicação de que estão com ou sem M.
--
-- * Limites das APIs: a leitura é enxuta (Meta: uma chamada de insights por
--   nível com todas as janelas; Google: uma consulta por visão, por dia,
--   somada por janela). Uma campanha por vez em cada conta de anúncios. Com
--   o consumo da cota acima de 75% ou um erro de limite, a conta (ou a
--   plataforma inteira) fica pausada até a hora que a plataforma indica, e a
--   análise volta para a fila sem contar como tentativa. Google: a MAVI tem
--   um orçamento próprio de operações por dia (o developer token é
--   compartilhado com a sincronização e a aba Plataforma).
-- * Sem leitura à toa: sem investimento desde a última análise, ou (no
--   agendamento) com menos dias novos com investimento que o mínimo da
--   empresa, a análise é pulada sem chamar a API nem a MAVI.
--
-- O worker é a ação "ai-campaign-insights" de /api/ai (api/_campaign-insights.ts),
-- acordada por mavi_private.campaign_insight_kick (pg_cron a cada 5 minutos:
-- supabase/operations/schedule-campaign-insights.sql) e na hora pelo
-- "Analisar agora".

-- ------------------------------------------------------------ avisos
alter table public.notifications drop constraint notifications_kind_check;
alter table public.notifications add constraint notifications_kind_check
 check (kind in ('mention', 'assigned', 'reply', 'social_leads', 'ai_share', 'success_case', 'notice',
  'notice_animation', 'temperature', 'tasks_assigned', 'due_risk', 'status', 'review', 'ai_skill', 'ai_answer',
  'radar_report', 'radar_alert', 'media_balance', 'priority', 'tasks_priority', 'copilot_lessons', 'mavi_lessons',
  'campaign_alert', 'campaign_insight'));
alter table public.notifications drop constraint notifications_target_check;
alter table public.notifications add constraint notifications_target_check
 check ((kind in ('social_leads', 'ai_share', 'success_case', 'notice', 'notice_animation', 'temperature',
   'tasks_assigned', 'due_risk', 'ai_skill', 'ai_answer', 'radar_report', 'radar_alert', 'media_balance',
   'tasks_priority', 'copilot_lessons', 'mavi_lessons', 'campaign_alert', 'campaign_insight')) = (task_id is null)
  and (task_id is not null or (title is not null and link is not null))
  and ((kind = 'notice') = (notice_id is not null)));

-- A da migração 20270218090000, com os insights das campanhas.
create or replace function mavi_private.notification_pref_keys() returns text[]
language sql immutable set search_path = '' as $$
 select array['assigned', 'mention', 'reply', 'review', 'due_risk',
  'social_leads', 'ai_share', 'success_case', 'temperature', 'ai_skill', 'ai_answer', 'radar_report', 'radar_alert',
  'media_balance', 'priority', 'campaign_alert', 'campaign_insight']
  || array(select 'status.' || s || '.' || r
   from unnest(array['progress', 'returned', 'review', 'rejected', 'correction', 'done']) s,
        unnest(array['creator', 'assignee', 'participant']) r)
$$;

-- ------------------------------------------------------------ Quem usa qual modelo
-- 'campaign_insights': a análise; 'campaign_insights_check': a conferência (Jev).
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
   'personal_radar', 'personal_assistant', 'personal_radar_check', 'social_media_schedule',
   'campaign_insights', 'campaign_insights_check')));

-- A da migração 20270307090000, com a conferência dos insights das campanhas.
create or replace function mavi_private.ai_decision_feature(p_feature text) returns boolean
language sql immutable set search_path = '' as $$
 select coalesce(p_feature, '') in ('client_temperature', 'client_radar_check', 'mavi_judge_check', 'personal_radar_check',
  'campaign_insights_check')
$$;

-- A da migração 20270315090000, com os insights das campanhas.
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
  'personal_radar', 'personal_assistant', 'personal_radar_check', 'social_media_schedule',
  'campaign_insights', 'campaign_insights_check') then
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
 -- O termômetro e as conferências leem com o Jev pelo OpenRouter; o Jev não conversa.
 if mavi_private.ai_decision_feature(v_feature) and not (v_kind = 'openrouter' and mavi_private.jev_model(p_model)) then
  raise exception 'Esta funcionalidade usa o Jev (TypeSafe) pelo OpenRouter: escolha o modelo do Jev.'
   using errcode = '22023';
 end if;
 if not mavi_private.ai_decision_feature(v_feature) and mavi_private.jev_model(p_model) then
  raise exception 'O Jev só responde a perguntas de decisão: use-o no termômetro, nas conferências (Radar, insights das campanhas) ou na autoavaliação da MAVI.'
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

-- O Jev da conferência: a regra própria, senão o do termômetro.
create function mavi_private.campaign_insight_jev_route(c uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
 select coalesce(
  (select jsonb_build_object('provider_id', p.id, 'provider', p.name, 'kind', p.kind, 'base_url', p.base_url,
    'key_cipher', p.key_cipher, 'model', rt.model,
    'price', (select m from jsonb_array_elements(p.models) m where m->>'id' = rt.model limit 1))
   from mavi_private.ai_routes rt join mavi_private.ai_providers p on p.id = rt.provider_id and p.active
   where rt.company_id = c and rt.scope_type = 'feature' and rt.feature = 'campaign_insights_check'
   limit 1),
  mavi_private.temperature_route(c))
$$;
revoke all on function mavi_private.campaign_insight_jev_route(uuid) from public, anon, authenticated;

-- ------------------------------------------------------------ configuração
create table public.campaign_insight_settings (
 company_id uuid primary key references public.companies(id),
 -- Desligado até um líder ligar.
 enabled boolean not null default false,
 -- daily: todo dia; weekdays: nos dias da semana escolhidos (0 = domingo);
 -- every: a cada every_days dias. Sempre a partir de hour (hora local).
 frequency text not null default 'weekdays' check (frequency in ('daily', 'weekdays', 'every')),
 weekdays smallint[] not null default '{1,4}'
  check (cardinality(weekdays) between 1 and 7 and weekdays <@ array[0,1,2,3,4,5,6]::smallint[]),
 every_days smallint not null default 3 check (every_days between 2 and 30),
 hour smallint not null default 8 check (hour between 0 and 23),
 -- Onde aparece.
 show_panel boolean not null default true,
 show_badge boolean not null default true,
 show_tab boolean not null default true,
 mavi_context boolean not null default true,
 -- Caixa de entrada + push: a prioridade mínima e quem recebe (team: as
 -- pessoas das equipes do cliente que usam Campanhas; team_leaders: e os
 -- administradores e gestores). Quem pediu "Analisar agora" recebe sempre.
 notify_inbox boolean not null default true,
 notify_min_priority text not null default 'high' check (notify_min_priority in ('high', 'medium', 'low')),
 notify_who text not null default 'team' check (notify_who in ('team', 'team_leaders')),
 -- Os valores em R$: net = sem M (o da plataforma); gross = com M.
 money_basis text not null default 'net' check (money_basis in ('net', 'gross')),
 -- Tetos em US$ (nulo no do mês: sem teto) e o intervalo do "Analisar agora".
 monthly_cap_usd numeric(8,2) default 30 check (monthly_cap_usd between 0 and 5000),
 run_cap_usd numeric(6,2) not null default 0.50 check (run_cap_usd between 0.05 and 20),
 min_interval_minutes integer not null default 240 check (min_interval_minutes between 0 and 10080),
 -- Agendamento: só relê com ao menos N dias novos com investimento (0: sempre).
 min_new_days smallint not null default 2 check (min_new_days between 0 and 14),
 -- Google: as operações do developer token por 24 h que a MAVI pode usar.
 google_daily_ops integer not null default 500 check (google_daily_ops between 0 and 100000),
 -- O mês em que os líderes já foram avisados do teto.
 cap_noticed_month date,
 updated_by uuid,
 updated_at timestamptz not null default now()
);
alter table public.campaign_insight_settings enable row level security;
revoke all on public.campaign_insight_settings from public, anon, authenticated;

-- Ajustes por cliente ou por campanha (o mais específico vence).
create table public.campaign_insight_rules (
 id uuid primary key default gen_random_uuid(),
 company_id uuid not null references public.companies(id),
 client_id uuid,
 campaign_id uuid,
 enabled boolean not null default true,
 frequency text not null default 'weekdays' check (frequency in ('daily', 'weekdays', 'every')),
 weekdays smallint[] not null default '{1,4}'
  check (cardinality(weekdays) between 1 and 7 and weekdays <@ array[0,1,2,3,4,5,6]::smallint[]),
 every_days smallint not null default 3 check (every_days between 2 and 30),
 hour smallint not null default 8 check (hour between 0 and 23),
 updated_by uuid,
 updated_at timestamptz not null default now(),
 check ((client_id is null) <> (campaign_id is null)),
 foreign key (company_id, client_id) references public.clients(company_id, id) on delete cascade,
 foreign key (company_id, campaign_id) references public.ad_campaigns(company_id, id) on delete cascade
);
create unique index campaign_insight_rules_client on public.campaign_insight_rules(company_id, client_id)
 where client_id is not null;
create unique index campaign_insight_rules_campaign on public.campaign_insight_rules(company_id, campaign_id)
 where campaign_id is not null;
alter table public.campaign_insight_rules enable row level security;
revoke all on public.campaign_insight_rules from public, anon, authenticated;

-- ------------------------------------------------------------ análises e insights
create table public.campaign_insight_runs (
 id uuid primary key default gen_random_uuid(),
 company_id uuid not null,
 campaign_id uuid not null,
 cycle_id uuid,
 trigger text not null check (trigger in ('schedule', 'manual')),
 requested_by uuid,
 -- queued › running › done | skipped | failed.
 status text not null default 'queued' check (status in ('queued', 'running', 'done', 'skipped', 'failed')),
 attempts smallint not null default 0,
 claimed_until timestamptz,
 -- O dia local em que foi pedida (o agendamento roda no máximo uma vez por dia).
 local_day date not null,
 money_basis text check (money_basis in ('net', 'gross')),
 multiplier numeric(6,3),
 -- As janelas lidas: {cycle: {since, until}, d7: …, since_last: …}.
 windows jsonb not null default '{}' check (jsonb_typeof(windows) = 'object'),
 model text not null default '',
 provider_name text not null default '',
 cost_usd numeric(12,6) not null default 0,
 -- A frase da MAVI sobre a campanha nesta análise.
 summary text not null default '' check (length(summary) <= 600),
 -- Por que pulou ou falhou, e o que foi enxugado para caber no teto.
 note text not null default '' check (length(note) <= 1000),
 insights_count integer not null default 0,
 repeated_count integer not null default 0,
 -- O que a análise gastou das APIs ({meta, google}) e de tokens ({input, output}).
 api_calls jsonb not null default '{}' check (jsonb_typeof(api_calls) = 'object'),
 tokens jsonb not null default '{}' check (jsonb_typeof(tokens) = 'object'),
 created_at timestamptz not null default now(),
 started_at timestamptz,
 finished_at timestamptz,
 foreign key (company_id, campaign_id) references public.ad_campaigns(company_id, id) on delete cascade
);
create index campaign_insight_runs_campaign on public.campaign_insight_runs(company_id, campaign_id, created_at desc);
create index campaign_insight_runs_queue on public.campaign_insight_runs(created_at)
 where status in ('queued', 'running');
alter table public.campaign_insight_runs enable row level security;
revoke all on public.campaign_insight_runs from public, anon, authenticated;

create table public.campaign_insights (
 id uuid primary key default gen_random_uuid(),
 company_id uuid not null,
 campaign_id uuid not null,
 -- A análise em que apareceu pela primeira vez e a última que o confirmou.
 run_id uuid not null references public.campaign_insight_runs(id) on delete cascade,
 last_seen_run uuid not null,
 kind text not null check (kind in ('highlight', 'opportunity', 'problem', 'tracking')),
 priority text not null check (priority in ('high', 'medium', 'low')),
 title text not null check (length(btrim(title)) between 3 and 200),
 body text not null default '' check (length(body) <= 2000),
 action text not null default '' check (length(action) <= 800),
 -- [{label, value, unit, window, entity, name}] com os valores do material.
 evidence jsonb not null check (jsonb_typeof(evidence) = 'array' and jsonb_array_length(evidence) between 1 and 8),
 -- {level, id, name, parent} do que o insight fala (nulo: a campanha toda).
 target jsonb check (target is null or jsonb_typeof(target) = 'object'),
 -- rule: detecção automática do servidor; mavi: a análise da MAVI.
 source text not null check (source in ('rule', 'mavi')),
 fingerprint text not null check (length(fingerprint) between 3 and 300),
 money_basis text not null check (money_basis in ('net', 'gross')),
 -- A conferência do Jev (0 a 1; nula sem o Jev).
 confidence numeric(4,3) check (confidence between 0 and 1),
 -- Fase 4: Aplicado / Descartado / Lembrar depois.
 status text not null default 'new' check (status in ('new', 'applied', 'dismissed', 'snoozed')),
 seen_count integer not null default 1,
 last_seen_at timestamptz not null default now(),
 created_at timestamptz not null default now(),
 foreign key (company_id, campaign_id) references public.ad_campaigns(company_id, id) on delete cascade
);
create index campaign_insights_campaign on public.campaign_insights(company_id, campaign_id, last_seen_at desc);
create index campaign_insights_run on public.campaign_insights(run_id);
create index campaign_insights_seen on public.campaign_insights(last_seen_run);
create index campaign_insights_fingerprint on public.campaign_insights(company_id, campaign_id, fingerprint)
 where status = 'new';
alter table public.campaign_insights enable row level security;
revoke all on public.campaign_insights from public, anon, authenticated;

-- Contas pausadas pela cota da plataforma (account_id '*': a plataforma
-- inteira, ex.: o limite do app no Meta ou o diário do developer token).
create table mavi_private.ad_api_cooldowns (
 platform text not null check (platform in ('meta', 'google')),
 account_id text not null check (length(account_id) between 1 and 60),
 until timestamptz not null,
 reason text not null default '' check (length(reason) <= 300),
 updated_at timestamptz not null default now(),
 primary key (platform, account_id)
);
revoke all on mavi_private.ad_api_cooldowns from public, anon, authenticated;

-- As operações do Google usadas pela MAVI, por hora (as últimas 24 h contam).
create table mavi_private.campaign_insight_google_ops (
 company_id uuid not null,
 hour timestamptz not null,
 ops integer not null default 0,
 primary key (company_id, hour)
);
revoke all on mavi_private.campaign_insight_google_ops from public, anon, authenticated;

create function mavi_private.campaign_insight_google_used(c uuid) returns integer
language sql stable security definer set search_path = '' as $$
 select coalesce(sum(o.ops), 0)::int from mavi_private.campaign_insight_google_ops o
 where o.company_id = c and o.hour > now() - interval '24 hours'
$$;
revoke all on function mavi_private.campaign_insight_google_used(uuid) from public, anon, authenticated;

-- A conta (ou a plataforma) está pausada pela cota.
create function mavi_private.campaign_insight_paused(p_platform text, p_accounts text[]) returns timestamptz
language sql stable security definer set search_path = '' as $$
 select max(k.until) from mavi_private.ad_api_cooldowns k
 where k.platform = p_platform and k.until > now() and (k.account_id = '*' or k.account_id = any(p_accounts))
$$;
revoke all on function mavi_private.campaign_insight_paused(text, text[]) from public, anon, authenticated;

-- As contas de anúncios do ciclo atual de uma campanha.
create function mavi_private.campaign_insight_accounts(c uuid, p_campaign uuid) returns text[]
language sql stable security definer set search_path = '' as $$
 select coalesce(array_agg(distinct l.account_id), '{}') from public.ad_campaigns a
 join public.ad_cycle_links l on l.company_id = a.company_id and l.cycle_id = a.current_cycle_id
 where a.company_id = c and a.id = p_campaign
$$;
revoke all on function mavi_private.campaign_insight_accounts(uuid, uuid) from public, anon, authenticated;

-- ------------------------------------------------------------ regras comuns
-- A configuração da empresa (o padrão quando ainda não há).
create function mavi_private.campaign_insight_config(c uuid) returns public.campaign_insight_settings
language sql stable security definer set search_path = '' as $$
 select coalesce((select s from public.campaign_insight_settings s where s.company_id = c),
  row(c, false, 'weekdays', '{1,4}'::smallint[], 3, 8, true, true, true, true, true, 'high', 'team', 'net',
   30, 0.50, 240, 2, 500, null, null, now())::public.campaign_insight_settings)
$$;

-- A frequência que vale para a campanha: a dela, a do cliente ou a da empresa.
create function mavi_private.campaign_insight_schedule(c uuid, p_campaign uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
 with k as (
  select k.client_id from public.ad_campaigns a join public.contracts k on k.company_id = a.company_id
   and k.id = a.contract_id where a.company_id = c and a.id = p_campaign)
 select coalesce(
  (select jsonb_build_object('source', 'campaign', 'rule', r.id, 'enabled', r.enabled, 'frequency', r.frequency,
    'weekdays', to_jsonb(r.weekdays), 'every_days', r.every_days, 'hour', r.hour)
   from public.campaign_insight_rules r where r.company_id = c and r.campaign_id = p_campaign),
  (select jsonb_build_object('source', 'client', 'rule', r.id, 'enabled', r.enabled, 'frequency', r.frequency,
    'weekdays', to_jsonb(r.weekdays), 'every_days', r.every_days, 'hour', r.hour)
   from public.campaign_insight_rules r, k where r.company_id = c and r.client_id = k.client_id),
  (select jsonb_build_object('source', 'company', 'rule', null, 'enabled', s.enabled, 'frequency', s.frequency,
    'weekdays', to_jsonb(s.weekdays), 'every_days', s.every_days, 'hour', s.hour)
   from (select (mavi_private.campaign_insight_config(c)).*) s))
$$;

-- O gasto do mês (no fuso da empresa).
create function mavi_private.campaign_insight_spent(c uuid) returns numeric
language sql stable security definer set search_path = '' as $$
 select coalesce(sum(u.cost_usd), 0) from public.ai_usage u
 where u.company_id = c and u.module = 'campaign_insights'
  and u.created_at >= (date_trunc('month', now() at time zone mavi_private.company_tz(c))
   at time zone mavi_private.company_tz(c))
$$;

create function mavi_private.campaign_insight_capped(c uuid) returns boolean
language sql stable security definer set search_path = '' as $$
 select s.monthly_cap_usd is not null and mavi_private.campaign_insight_spent(c) >= s.monthly_cap_usd
 from (select (mavi_private.campaign_insight_config(c)).*) s
$$;

-- A campanha pode ser analisada: Meta ou Google, ativa, com o ciclo atual em
-- andamento há ao menos um dia completo e campanhas da plataforma vinculadas.
-- Devolve o motivo quando não pode (nulo: pode).
create function mavi_private.campaign_insight_blocker(c uuid, p_campaign uuid) returns text
language plpgsql stable security definer set search_path = '' as $$
declare a public.ad_campaigns; y public.ad_cycles; v_today date := mavi_private.company_today(c); begin
 select * into a from public.ad_campaigns where company_id = c and id = p_campaign;
 if not found then return 'Campanha não encontrada.'; end if;
 if a.platform not in ('meta', 'google') then return 'Os insights leem campanhas do Meta e do Google.'; end if;
 if a.archived or a.status <> 'active' then return 'A campanha não está ativa.'; end if;
 select * into y from public.ad_cycles where company_id = c and id = a.current_cycle_id;
 if not found then return 'A campanha não tem ciclo atual.'; end if;
 if y.start_date >= v_today then return 'O ciclo atual ainda não tem um dia completo.'; end if;
 if y.end_date < v_today - 1 then return 'O ciclo atual já terminou.'; end if;
 if not exists (select 1 from public.ad_cycle_links k where k.company_id = c and k.cycle_id = y.id) then
  return 'O ciclo atual não tem campanhas da plataforma vinculadas.';
 end if;
 return null;
end $$;

-- Hoje cabe uma análise agendada (a hora já chegou e a frequência pede).
create function mavi_private.campaign_insight_due(c uuid, p_campaign uuid) returns boolean
language plpgsql stable security definer set search_path = '' as $$
declare s jsonb := mavi_private.campaign_insight_schedule(c, p_campaign);
 v_now timestamp := now() at time zone mavi_private.company_tz(c); v_day date := v_now::date; v_last date; begin
 if not coalesce((s->>'enabled')::boolean, false) then return false; end if;
 if extract(hour from v_now) < (s->>'hour')::int then return false; end if;
 select max(r.local_day) into v_last from public.campaign_insight_runs r
 where r.company_id = c and r.campaign_id = p_campaign and r.trigger = 'schedule';
 if s->>'frequency' = 'every' then
  return v_last is null or v_day - v_last >= (s->>'every_days')::int;
 end if;
 if s->>'frequency' = 'weekdays' and not (extract(dow from v_day)::int in
  (select (x)::int from jsonb_array_elements_text(s->'weekdays') x)) then
  return false;
 end if;
 return v_last is null or v_last < v_day;
end $$;

-- Quem trabalha nesta campanha pelo módulo (a regra das telas).
create function mavi_private.campaign_insight_reader(c uuid, p_campaign uuid) returns boolean
language sql stable security definer set search_path = '' as $$
 select mavi_private.module_client(c, 'campaigns', mavi_private.ad_campaign_client(p_campaign))
  and exists (select 1 from public.ad_campaigns a where a.company_id = c and a.id = p_campaign)
$$;

-- Um insight como as telas leem.
create function mavi_private.campaign_insight_json(i public.campaign_insights) returns jsonb
language sql stable security definer set search_path = '' as $$
 select jsonb_build_object('id', i.id, 'run_id', i.run_id, 'last_seen_run', i.last_seen_run, 'kind', i.kind,
  'priority', i.priority, 'title', i.title, 'body', i.body, 'action', i.action, 'evidence', i.evidence,
  'target', i.target, 'source', i.source, 'money_basis', i.money_basis, 'confidence', i.confidence,
  'status', i.status, 'seen_count', i.seen_count, 'last_seen_at', i.last_seen_at, 'created_at', i.created_at)
$$;

create function mavi_private.campaign_insight_rank(p text) returns integer
language sql immutable set search_path = '' as $$
 select case p when 'high' then 3 when 'medium' then 2 when 'low' then 1 else 0 end
$$;

-- Acorda o worker (sem esperar o agendamento).
create function mavi_private.campaign_insight_post() returns void
language plpgsql security definer set search_path = '' as $$
declare cfg mavi_private.ai_config; begin
 select * into cfg from mavi_private.ai_config where id;
 if not found then return; end if;
 perform net.http_post(url := cfg.url, body := '{"action":"ai-campaign-insights"}'::jsonb,
  headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || cfg.secret),
  timeout_milliseconds := 290000);
end $$;

revoke all on function mavi_private.campaign_insight_config(uuid), mavi_private.campaign_insight_schedule(uuid, uuid),
 mavi_private.campaign_insight_spent(uuid), mavi_private.campaign_insight_capped(uuid),
 mavi_private.campaign_insight_blocker(uuid, uuid), mavi_private.campaign_insight_due(uuid, uuid),
 mavi_private.campaign_insight_reader(uuid, uuid), mavi_private.campaign_insight_json(public.campaign_insights),
 mavi_private.campaign_insight_post() from public, anon, authenticated;

-- ------------------------------------------------------------ agendamento
-- Põe na fila as campanhas cuja vez chegou (empresas ligadas e abaixo do teto
-- do mês). No teto, avisa os líderes uma vez por mês.
create function mavi_private.campaign_insight_tick() returns integer
language plpgsql security definer set search_path = '' as $$
declare s public.campaign_insight_settings; a record; v_n integer := 0; v_month date; begin
 -- Reservas vencidas depois da última tentativa: falhou.
 update public.campaign_insight_runs set status = 'failed', finished_at = now(),
  note = left('A análise não terminou depois de 3 tentativas.', 1000)
 where status = 'running' and claimed_until < now() and attempts >= 3;
 for s in select * from public.campaign_insight_settings where enabled loop
  if mavi_private.campaign_insight_capped(s.company_id) then
   v_month := date_trunc('month', now() at time zone mavi_private.company_tz(s.company_id))::date;
   if s.cap_noticed_month is distinct from v_month then
    update public.campaign_insight_settings set cap_noticed_month = v_month where company_id = s.company_id;
    insert into public.notifications(company_id, user_id, actor_id, task_id, kind, title, body, link)
    select s.company_id, m.user_id, null, null, 'campaign_insight',
     'Insights das campanhas pausados: teto do mês',
     left(format('O gasto do mês chegou a US$ %s (teto de US$ %s). As análises voltam quando o mês virar ou quando o teto subir.',
      to_char(mavi_private.campaign_insight_spent(s.company_id), 'FM999990.00'),
      to_char(s.monthly_cap_usd, 'FM999990.00')), 300),
     '/mavi#campanhas'
    from public.memberships m where m.company_id = s.company_id and m.active and m.role in ('admin', 'manager');
   end if;
   continue;
  end if;
  for a in
   select x.id from public.ad_campaigns x
   where x.company_id = s.company_id and x.status = 'active' and not x.archived and x.platform in ('meta', 'google')
    and not exists (select 1 from public.campaign_insight_runs r where r.company_id = x.company_id
     and r.campaign_id = x.id and r.status in ('queued', 'running'))
   order by x.id
  loop
   continue when mavi_private.campaign_insight_blocker(s.company_id, a.id) is not null;
   continue when not mavi_private.campaign_insight_due(s.company_id, a.id);
   insert into public.campaign_insight_runs(company_id, campaign_id, cycle_id, trigger, local_day)
   select s.company_id, a.id, x.current_cycle_id, 'schedule', mavi_private.company_today(s.company_id)
   from public.ad_campaigns x where x.id = a.id;
   v_n := v_n + 1;
   exit when v_n >= 200;
  end loop;
 end loop;
 return v_n;
end $$;

-- Chamado pelo pg_cron (supabase/operations/schedule-campaign-insights.sql).
create function mavi_private.campaign_insight_kick() returns void
language plpgsql security definer set search_path = '' as $$ begin
 begin
  perform mavi_private.campaign_insight_tick();
 exception when others then
  raise warning 'campaign insights tick failed: %', sqlerrm;
 end;
 if exists (select 1 from public.campaign_insight_runs r where r.status in ('queued', 'running')
  and coalesce(r.claimed_until, '-infinity') < now() and r.attempts < 3) then
  perform mavi_private.campaign_insight_post();
 end if;
end $$;
revoke all on function mavi_private.campaign_insight_tick(), mavi_private.campaign_insight_kick()
 from public, anon, authenticated;

-- ------------------------------------------------------------ telas
-- A campanha: a frequência que vale, o que está na fila, o que dá para pedir
-- e o histórico das análises com os insights de cada uma.
create function public.campaign_insights(p_company uuid, p_campaign uuid, p_runs integer default 8) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare s public.campaign_insight_settings; v_last public.campaign_insight_runs; v_latest uuid; v_wait timestamptz;
begin
 if not mavi_private.campaign_insight_reader(p_company, p_campaign) then
  raise exception 'Sem permissão' using errcode = '42501';
 end if;
 s := mavi_private.campaign_insight_config(p_company);
 select * into v_last from public.campaign_insight_runs r where r.company_id = p_company and r.campaign_id = p_campaign
  and r.status in ('done', 'queued', 'running') order by r.created_at desc limit 1;
 if v_last.id is not null then
  v_wait := v_last.created_at + make_interval(mins => s.min_interval_minutes);
  if v_wait <= now() then v_wait := null; end if;
 end if;
 select r.id into v_latest from public.campaign_insight_runs r where r.company_id = p_company
  and r.campaign_id = p_campaign and r.status = 'done' order by r.finished_at desc nulls last limit 1;
 return jsonb_build_object(
  'enabled', s.enabled,
  'schedule', mavi_private.campaign_insight_schedule(p_company, p_campaign),
  'timezone', mavi_private.company_tz(p_company),
  'last_scheduled_day', (select max(r.local_day) from public.campaign_insight_runs r where r.company_id = p_company
   and r.campaign_id = p_campaign and r.trigger = 'schedule'),
  'places', jsonb_build_object('panel', s.show_panel, 'badge', s.show_badge, 'tab', s.show_tab),
  'money_basis', s.money_basis,
  'min_interval_minutes', s.min_interval_minutes,
  'blocker', mavi_private.campaign_insight_blocker(p_company, p_campaign),
  'capped', mavi_private.campaign_insight_capped(p_company),
  'wait_until', v_wait,
  'pending', (select jsonb_build_object('id', r.id, 'status', r.status, 'trigger', r.trigger,
    'created_at', r.created_at, 'started_at', r.started_at, 'note', r.note,
    -- Na fila com hora marcada: esperando a cota da plataforma (ou o orçamento do Google).
    'waiting_until', case when r.status = 'queued' and r.claimed_until > now() then r.claimed_until end,
    'requested_by_name', (select m.name from public.memberships m where m.company_id = r.company_id
     and m.user_id = r.requested_by))
   from public.campaign_insight_runs r where r.company_id = p_company and r.campaign_id = p_campaign
    and r.status in ('queued', 'running') order by r.created_at desc limit 1),
  'latest_run', v_latest,
  'current', coalesce((select jsonb_agg(mavi_private.campaign_insight_json(i)
    order by mavi_private.campaign_insight_rank(i.priority) desc, i.created_at)
   from public.campaign_insights i where i.company_id = p_company and i.campaign_id = p_campaign
    and i.last_seen_run = v_latest and i.status = 'new'), '[]'),
  'runs', coalesce((select jsonb_agg(x.j order by x.created_at desc) from (
   select r.created_at, jsonb_build_object('id', r.id, 'trigger', r.trigger, 'status', r.status,
    'requested_by_name', (select m.name from public.memberships m where m.company_id = r.company_id
     and m.user_id = r.requested_by),
    'created_at', r.created_at, 'started_at', r.started_at, 'finished_at', r.finished_at,
    'cost_usd', r.cost_usd, 'model', r.model, 'provider_name', r.provider_name, 'summary', r.summary,
    'note', r.note, 'money_basis', r.money_basis, 'multiplier', r.multiplier, 'windows', r.windows,
    'insights_count', r.insights_count, 'repeated_count', r.repeated_count,
    'api_calls', r.api_calls, 'tokens', r.tokens,
    'insights', coalesce((select jsonb_agg(mavi_private.campaign_insight_json(i)
      order by mavi_private.campaign_insight_rank(i.priority) desc, i.created_at)
     from public.campaign_insights i where i.run_id = r.id), '[]')) as j
   from public.campaign_insight_runs r where r.company_id = p_company and r.campaign_id = p_campaign
   order by r.created_at desc limit least(greatest(coalesce(p_runs, 8), 1), 50)) x), '[]'));
end $$;

-- "Analisar agora": quem vê a campanha pede (uma de cada vez, respeitando o
-- intervalo mínimo desde a última análise e o teto do mês).
create function public.request_campaign_insight(p_company uuid, p_campaign uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare s public.campaign_insight_settings; v_sched jsonb; v_block text; v_last public.campaign_insight_runs;
 v_id uuid; begin
 if not mavi_private.campaign_insight_reader(p_company, p_campaign) then
  raise exception 'Sem permissão' using errcode = '42501';
 end if;
 s := mavi_private.campaign_insight_config(p_company);
 if not s.enabled then
  return jsonb_build_object('ok', false, 'reason', 'Os insights das campanhas estão desligados no Painel da MAVI.');
 end if;
 v_sched := mavi_private.campaign_insight_schedule(p_company, p_campaign);
 if not coalesce((v_sched->>'enabled')::boolean, false) then
  return jsonb_build_object('ok', false, 'reason', case v_sched->>'source'
   when 'campaign' then 'Os insights estão desligados para esta campanha.'
   else 'Os insights estão desligados para este cliente.' end);
 end if;
 v_block := mavi_private.campaign_insight_blocker(p_company, p_campaign);
 if v_block is not null then return jsonb_build_object('ok', false, 'reason', v_block); end if;
 select * into v_last from public.campaign_insight_runs r where r.company_id = p_company and r.campaign_id = p_campaign
  and r.status in ('queued', 'running') order by r.created_at desc limit 1;
 if found then
  return jsonb_build_object('ok', false, 'reason', 'Já há uma análise em andamento.', 'run', v_last.id);
 end if;
 select * into v_last from public.campaign_insight_runs r where r.company_id = p_company and r.campaign_id = p_campaign
  and r.status = 'done' order by r.created_at desc limit 1;
 if found and v_last.created_at + make_interval(mins => s.min_interval_minutes) > now() then
  return jsonb_build_object('ok', false, 'reason', 'A última análise é recente.', 'run', v_last.id,
   'wait_until', v_last.created_at + make_interval(mins => s.min_interval_minutes));
 end if;
 if mavi_private.campaign_insight_capped(p_company) then
  return jsonb_build_object('ok', false, 'reason',
   'O teto do mês dos insights foi atingido. As análises voltam quando o mês virar ou quando o teto subir.');
 end if;
 insert into public.campaign_insight_runs(company_id, campaign_id, cycle_id, trigger, requested_by, local_day)
 select p_company, a.id, a.current_cycle_id, 'manual', auth.uid(), mavi_private.company_today(p_company)
 from public.ad_campaigns a where a.company_id = p_company and a.id = p_campaign
 returning id into v_id;
 perform mavi_private.broadcast(p_company, jsonb_build_object('kind', 'campaign_insights', 'campaign', p_campaign,
  'run', v_id, 'status', 'queued'));
 begin
  perform mavi_private.campaign_insight_post();
 exception when others then
  raise warning 'campaign insights post failed: %', sqlerrm;
 end;
 return jsonb_build_object('ok', true, 'run', v_id);
end $$;

-- Os selos da lista: os insights abertos da última análise de cada campanha.
create function public.campaign_insight_badges(p_company uuid, p_campaigns uuid[]) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare s public.campaign_insight_settings; begin
 perform mavi_private.ad_require_reader(p_company);
 s := mavi_private.campaign_insight_config(p_company);
 if not s.enabled or not s.show_badge then
  return jsonb_build_object('enabled', s.enabled, 'badge', false, 'rows', '[]'::jsonb);
 end if;
 return jsonb_build_object('enabled', true, 'badge', true, 'rows', coalesce((
  select jsonb_agg(jsonb_build_object('campaign', x.id, 'open', x.open, 'high', x.high, 'medium', x.medium,
   'at', x.at, 'running', x.running))
  from (
   select a.id,
    count(i.id) filter (where i.status = 'new')::int as open,
    count(i.id) filter (where i.status = 'new' and i.priority = 'high')::int as high,
    count(i.id) filter (where i.status = 'new' and i.priority = 'medium')::int as medium,
    max(l.finished_at) as at,
    exists (select 1 from public.campaign_insight_runs q where q.company_id = a.company_id and q.campaign_id = a.id
     and q.status in ('queued', 'running')) as running
   from public.ad_campaigns a
   left join lateral (select r.id, r.finished_at from public.campaign_insight_runs r
    where r.company_id = a.company_id and r.campaign_id = a.id and r.status = 'done'
    order by r.finished_at desc nulls last limit 1) l on true
   left join public.campaign_insights i on i.last_seen_run = l.id
   where a.company_id = p_company and a.id = any(coalesce(p_campaigns, '{}'))
    and mavi_private.campaign_insight_reader(p_company, a.id)
   group by a.id) x
  where x.open > 0 or x.running), '[]'));
end $$;

-- ------------------------------------------------------------ Painel da MAVI
create function mavi_private.campaign_insight_settings_json(c uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
 select jsonb_build_object(
  'settings', (select to_jsonb(s) - 'company_id' - 'cap_noticed_month'
   from (select (mavi_private.campaign_insight_config(c)).*) s),
  'rules', coalesce((select jsonb_agg(jsonb_build_object('id', r.id, 'client_id', r.client_id,
    'campaign_id', r.campaign_id, 'enabled', r.enabled, 'frequency', r.frequency, 'weekdays', to_jsonb(r.weekdays),
    'every_days', r.every_days, 'hour', r.hour, 'updated_at', r.updated_at,
    'client_name', coalesce(cl.name, ccl.name), 'campaign_name', a.name, 'platform', a.platform)
    order by coalesce(cl.name, ccl.name), a.name nulls first)
   from public.campaign_insight_rules r
   left join public.clients cl on cl.company_id = r.company_id and cl.id = r.client_id
   left join public.ad_campaigns a on a.company_id = r.company_id and a.id = r.campaign_id
   left join public.contracts k on k.company_id = a.company_id and k.id = a.contract_id
   left join public.clients ccl on ccl.company_id = k.company_id and ccl.id = k.client_id
   where r.company_id = c), '[]'),
  'spent_month', mavi_private.campaign_insight_spent(c),
  'runs_month', (select count(*)::int from public.campaign_insight_runs r where r.company_id = c
   and r.status = 'done' and r.created_at >= (date_trunc('month', now() at time zone mavi_private.company_tz(c))
    at time zone mavi_private.company_tz(c))),
  'campaigns', (select count(*)::int from public.ad_campaigns a where a.company_id = c and a.status = 'active'
   and not a.archived and a.platform in ('meta', 'google')),
  'capped', mavi_private.campaign_insight_capped(c),
  'google_ops_24h', mavi_private.campaign_insight_google_used(c),
  -- As contas pausadas agora pela cota (das campanhas da empresa).
  'paused', coalesce((select jsonb_agg(jsonb_build_object('platform', k.platform, 'account_id', k.account_id,
    'until', k.until, 'reason', k.reason) order by k.until desc)
   from mavi_private.ad_api_cooldowns k where k.until > now()
    and (k.account_id = '*' or exists (select 1 from public.ad_cycle_links l where l.company_id = c
     and l.account_id = k.account_id))), '[]'),
  'timezone', mavi_private.company_tz(c))
$$;
revoke all on function mavi_private.campaign_insight_settings_json(uuid) from public, anon, authenticated;

create function public.campaign_insight_settings(p_company uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$ begin
 if not mavi_private.leader(p_company) then raise exception 'Sem permissão' using errcode = '42501'; end if;
 return mavi_private.campaign_insight_settings_json(p_company);
end $$;

create function mavi_private.campaign_insight_weekdays(v jsonb) returns smallint[]
language plpgsql immutable set search_path = '' as $$
declare r smallint[]; begin
 if v is null or jsonb_typeof(v) <> 'array' then return null; end if;
 select coalesce(array_agg(distinct (x)::smallint order by (x)::smallint), '{}') into r
 from jsonb_array_elements_text(v) x where x ~ '^[0-6]$';
 return r;
end $$;
revoke all on function mavi_private.campaign_insight_weekdays(jsonb) from public, anon, authenticated;

create function public.save_campaign_insight_settings(p_company uuid, p_settings jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare s public.campaign_insight_settings; v jsonb := p_settings; n public.campaign_insight_settings; begin
 if not mavi_private.leader(p_company) then
  raise exception 'Só administradores e gestores configuram os insights.' using errcode = '42501';
 end if;
 s := mavi_private.campaign_insight_config(p_company);
 if v is null or jsonb_typeof(v) <> 'object' then raise exception 'Configuração inválida.' using errcode = '22023'; end if;
 n := s;
 n.enabled := coalesce((v->>'enabled')::boolean, s.enabled);
 n.frequency := coalesce(v->>'frequency', s.frequency);
 n.weekdays := coalesce(mavi_private.campaign_insight_weekdays(v->'weekdays'), s.weekdays);
 n.every_days := coalesce((v->>'every_days')::smallint, s.every_days);
 n.hour := coalesce((v->>'hour')::smallint, s.hour);
 n.show_panel := coalesce((v->>'show_panel')::boolean, s.show_panel);
 n.show_badge := coalesce((v->>'show_badge')::boolean, s.show_badge);
 n.show_tab := coalesce((v->>'show_tab')::boolean, s.show_tab);
 n.mavi_context := coalesce((v->>'mavi_context')::boolean, s.mavi_context);
 n.notify_inbox := coalesce((v->>'notify_inbox')::boolean, s.notify_inbox);
 n.notify_min_priority := coalesce(v->>'notify_min_priority', s.notify_min_priority);
 n.notify_who := coalesce(v->>'notify_who', s.notify_who);
 n.money_basis := coalesce(v->>'money_basis', s.money_basis);
 n.monthly_cap_usd := case when v ? 'monthly_cap_usd' then (v->>'monthly_cap_usd')::numeric else s.monthly_cap_usd end;
 n.run_cap_usd := coalesce((v->>'run_cap_usd')::numeric, s.run_cap_usd);
 n.min_interval_minutes := coalesce((v->>'min_interval_minutes')::int, s.min_interval_minutes);
 n.min_new_days := coalesce((v->>'min_new_days')::smallint, s.min_new_days);
 n.google_daily_ops := coalesce((v->>'google_daily_ops')::int, s.google_daily_ops);
 if cardinality(n.weekdays) = 0 then
  raise exception 'Escolha ao menos um dia da semana.' using errcode = '22023';
 end if;
 insert into public.campaign_insight_settings as x (company_id, enabled, frequency, weekdays, every_days, hour,
  show_panel, show_badge, show_tab, mavi_context, notify_inbox, notify_min_priority, notify_who, money_basis,
  monthly_cap_usd, run_cap_usd, min_interval_minutes, min_new_days, google_daily_ops, updated_by, updated_at)
 values (p_company, n.enabled, n.frequency, n.weekdays, n.every_days, n.hour, n.show_panel, n.show_badge, n.show_tab,
  n.mavi_context, n.notify_inbox, n.notify_min_priority, n.notify_who, n.money_basis, n.monthly_cap_usd,
  n.run_cap_usd, n.min_interval_minutes, n.min_new_days, n.google_daily_ops, auth.uid(), now())
 on conflict (company_id) do update set enabled = excluded.enabled, frequency = excluded.frequency,
  weekdays = excluded.weekdays, every_days = excluded.every_days, hour = excluded.hour,
  show_panel = excluded.show_panel, show_badge = excluded.show_badge, show_tab = excluded.show_tab,
  mavi_context = excluded.mavi_context, notify_inbox = excluded.notify_inbox,
  notify_min_priority = excluded.notify_min_priority, notify_who = excluded.notify_who,
  money_basis = excluded.money_basis, monthly_cap_usd = excluded.monthly_cap_usd,
  run_cap_usd = excluded.run_cap_usd, min_interval_minutes = excluded.min_interval_minutes,
  min_new_days = excluded.min_new_days, google_daily_ops = excluded.google_daily_ops,
  -- Teto mudou: avisa de novo se for atingido.
  cap_noticed_month = case when excluded.monthly_cap_usd is distinct from x.monthly_cap_usd then null
   else x.cap_noticed_month end,
  updated_by = excluded.updated_by, updated_at = excluded.updated_at;
 return mavi_private.campaign_insight_settings_json(p_company);
end $$;

-- Ajuste por cliente ou por campanha ({id?, client_id | campaign_id, enabled,
-- frequency, weekdays, every_days, hour}).
create function public.save_campaign_insight_rule(p_company uuid, p_rule jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_id uuid; v_client uuid; v_campaign uuid; v_days smallint[]; begin
 if not mavi_private.leader(p_company) then
  raise exception 'Só administradores e gestores configuram os insights.' using errcode = '42501';
 end if;
 if p_rule is null or jsonb_typeof(p_rule) <> 'object' then
  raise exception 'Ajuste inválido.' using errcode = '22023';
 end if;
 v_id := case when p_rule->>'id' ~* '^[0-9a-f-]{36}$' then (p_rule->>'id')::uuid end;
 v_client := case when p_rule->>'client_id' ~* '^[0-9a-f-]{36}$' then (p_rule->>'client_id')::uuid end;
 v_campaign := case when p_rule->>'campaign_id' ~* '^[0-9a-f-]{36}$' then (p_rule->>'campaign_id')::uuid end;
 if (v_client is null) = (v_campaign is null) then
  raise exception 'Escolha um cliente ou uma campanha.' using errcode = '22023';
 end if;
 if v_client is not null and not exists (select 1 from public.clients where company_id = p_company and id = v_client)
  or v_campaign is not null and not exists (select 1 from public.ad_campaigns where company_id = p_company
   and id = v_campaign) then
  raise exception 'Não encontrado na empresa.' using errcode = 'P0002';
 end if;
 v_days := coalesce(mavi_private.campaign_insight_weekdays(p_rule->'weekdays'), '{1,4}');
 if cardinality(v_days) = 0 then raise exception 'Escolha ao menos um dia da semana.' using errcode = '22023'; end if;
 if v_id is not null then
  update public.campaign_insight_rules set client_id = v_client, campaign_id = v_campaign,
   enabled = coalesce((p_rule->>'enabled')::boolean, true), frequency = coalesce(p_rule->>'frequency', 'weekdays'),
   weekdays = v_days, every_days = coalesce((p_rule->>'every_days')::smallint, 3),
   hour = coalesce((p_rule->>'hour')::smallint, 8), updated_by = auth.uid(), updated_at = now()
  where company_id = p_company and id = v_id;
  if not found then raise exception 'Ajuste não encontrado.' using errcode = 'P0002'; end if;
 else
  begin
   insert into public.campaign_insight_rules(company_id, client_id, campaign_id, enabled, frequency, weekdays,
    every_days, hour, updated_by)
   values (p_company, v_client, v_campaign, coalesce((p_rule->>'enabled')::boolean, true),
    coalesce(p_rule->>'frequency', 'weekdays'), v_days, coalesce((p_rule->>'every_days')::smallint, 3),
    coalesce((p_rule->>'hour')::smallint, 8), auth.uid());
  exception when unique_violation then
   raise exception 'Já existe um ajuste para %.', case when v_client is not null then 'este cliente'
    else 'esta campanha' end using errcode = '23505';
  end;
 end if;
 return mavi_private.campaign_insight_settings_json(p_company);
end $$;

create function public.delete_campaign_insight_rule(p_company uuid, p_rule uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$ begin
 if not mavi_private.leader(p_company) then
  raise exception 'Só administradores e gestores configuram os insights.' using errcode = '42501';
 end if;
 delete from public.campaign_insight_rules where company_id = p_company and id = p_rule;
 return mavi_private.campaign_insight_settings_json(p_company);
end $$;

-- ------------------------------------------------------------ worker
-- As análises a fazer (pedidas primeiro), reservadas por 8 minutos. Pula as
-- de contas pausadas pela cota e as de contas que outra análise está lendo
-- agora (uma campanha por vez em cada conta de anúncios).
create function public.ai_campaign_insight_claim(p_secret text, p_limit integer default 3) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare r record; v_accounts text[]; v_busy text[] := '{}'; v_out jsonb := '[]';
 v_limit integer := least(greatest(coalesce(p_limit, 3), 1), 10); begin
 if not mavi_private.ai_secret_ok(p_secret) then raise exception 'Sem permissão' using errcode = '42501'; end if;
 -- As contas já em leitura agora.
 select coalesce(array_agg(distinct a.platform || ':' || x), '{}') into v_busy
 from public.campaign_insight_runs q
 join public.ad_campaigns a on a.company_id = q.company_id and a.id = q.campaign_id,
  unnest(mavi_private.campaign_insight_accounts(q.company_id, q.campaign_id)) x
 where q.status = 'running' and q.claimed_until > now();
 for r in
  select q.id, q.company_id, q.campaign_id, a.platform from public.campaign_insight_runs q
  join public.ad_campaigns a on a.company_id = q.company_id and a.id = q.campaign_id
  where q.status in ('queued', 'running') and coalesce(q.claimed_until, '-infinity') < now() and q.attempts < 3
  order by (q.trigger = 'manual') desc, q.created_at
  limit 200
  for update of q skip locked
 loop
  v_accounts := mavi_private.campaign_insight_accounts(r.company_id, r.campaign_id);
  continue when mavi_private.campaign_insight_paused(r.platform, v_accounts) is not null;
  continue when exists (select 1 from unnest(v_accounts) x where r.platform || ':' || x = any(v_busy));
  update public.campaign_insight_runs set status = 'running', attempts = attempts + 1,
   claimed_until = now() + interval '8 minutes', started_at = coalesce(started_at, now())
  where id = r.id;
  v_busy := v_busy || array(select r.platform || ':' || x from unnest(v_accounts) x);
  v_out := v_out || jsonb_build_array(jsonb_build_object('id', r.id, 'company_id', r.company_id,
   'campaign_id', r.campaign_id));
  exit when jsonb_array_length(v_out) >= v_limit;
 end loop;
 return v_out;
end $$;

-- Tudo o que o worker precisa ler da campanha (os tokens vão selados; só o
-- servidor abre). Nulo quando a campanha deixou de poder ser analisada.
create function public.ai_campaign_insight_material(p_secret text, p_run uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare r public.campaign_insight_runs; a public.ad_campaigns; y public.ad_cycles; k public.contracts;
 s public.campaign_insight_settings; v_block text; v_today date; begin
 if not mavi_private.ai_secret_ok(p_secret) then raise exception 'Sem permissão' using errcode = '42501'; end if;
 select * into r from public.campaign_insight_runs where id = p_run;
 if not found then return null; end if;
 v_block := mavi_private.campaign_insight_blocker(r.company_id, r.campaign_id);
 if v_block is not null then return jsonb_build_object('blocked', v_block); end if;
 select * into a from public.ad_campaigns where company_id = r.company_id and id = r.campaign_id;
 select * into y from public.ad_cycles where company_id = a.company_id and id = a.current_cycle_id;
 select * into k from public.contracts where company_id = a.company_id and id = a.contract_id;
 s := mavi_private.campaign_insight_config(r.company_id);
 v_today := mavi_private.company_today(r.company_id);
 return jsonb_build_object(
  'run', jsonb_build_object('id', r.id, 'trigger', r.trigger),
  'company_id', r.company_id,
  'today', v_today,
  'timezone', mavi_private.company_tz(r.company_id),
  'campaign', jsonb_build_object('id', a.id, 'name', a.name, 'platform', a.platform, 'notes', left(a.notes, 1500)),
  'client', (select jsonb_build_object('id', c.id, 'name', c.name) from public.clients c
   where c.company_id = k.company_id and c.id = k.client_id),
  'product', (select jsonb_build_object('id', p.id, 'name', p.name) from public.products p
   where p.company_id = k.company_id and p.id = k.product_id),
  'contract_id', k.id,
  'cycle', jsonb_build_object('id', y.id, 'start_date', y.start_date, 'end_date', y.end_date,
   'objective', y.objective, 'destination', y.destination, 'goal_results', y.goal_results, 'budget', y.budget,
   'multiplier', y.multiplier, 'niche', y.niche, 'meta_conversions', y.meta_conversions,
   'conversion_actions', to_jsonb(y.conversion_actions)),
  'links', coalesce((select jsonb_agg(jsonb_build_object('account_id', l.account_id,
    'campaign_id', l.external_campaign_id, 'manager_id', l.manager_id) order by l.account_id, l.external_campaign_id)
   from public.ad_cycle_links l where l.company_id = y.company_id and l.cycle_id = y.id), '[]'),
  'meta_tokens', case when a.platform = 'meta' then (select jsonb_object_agg(m.account_id,
    jsonb_build_object('token_cipher', m.token_cipher, 'expires_at', m.token_expires_at))
   from mavi_private.ad_meta_accounts m where m.company_id = y.company_id and m.account_id in
    (select l.account_id from public.ad_cycle_links l where l.company_id = y.company_id and l.cycle_id = y.id)) end,
  'google_token', case when a.platform = 'google' then (select jsonb_build_object('refresh_token_cipher',
    g.refresh_token_cipher) from mavi_private.ad_google_connections g where g.company_id = y.company_id) end,
  'crm_company_id', (select l.crm_company_id from public.client_crm_links l
   where l.company_id = k.company_id and l.client_id = k.client_id),
  -- Os números do ciclo como o MAVI conta (as "Conversões que contam").
  'daily', coalesce((select jsonb_agg(jsonb_build_object('day', d.day, 'spend', d.spend,
    'conversions', d.conversions, 'clicks', d.clicks, 'impressions', d.impressions, 'multiplier', d.multiplier)
    order by d.day)
   from public.ad_daily_metrics d where d.company_id = y.company_id and d.cycle_id = y.id and d.day < v_today), '[]'),
  'settings', jsonb_build_object('money_basis', s.money_basis, 'run_cap_usd', s.run_cap_usd,
   'min_new_days', s.min_new_days),
  'last_done_at', (select max(x.finished_at) from public.campaign_insight_runs x where x.company_id = r.company_id
   and x.campaign_id = r.campaign_id and x.status = 'done' and x.id <> r.id),
  'previous', coalesce((select jsonb_agg(jsonb_build_object('kind', i.kind, 'priority', i.priority,
    'title', i.title, 'fingerprint', i.fingerprint, 'status', i.status, 'seen_count', i.seen_count,
    'last_seen_at', i.last_seen_at) order by i.last_seen_at desc)
   from (select * from public.campaign_insights i where i.company_id = r.company_id and i.campaign_id = r.campaign_id
    order by i.last_seen_at desc limit 20) i), '[]'),
  'context', jsonb_build_object(
   'dossier', coalesce((select jsonb_agg(jsonb_build_object('kind', d.kind, 'text', d.text))
    from (select * from public.client_dossier_items d where d.company_id = k.company_id and d.client_id = k.client_id
     and not d.dismissed order by d.pinned desc, d.created_at desc limit 25) d), '[]'),
   'radar', coalesce((select jsonb_agg(jsonb_build_object('topic', t.name, 'title', i.title,
     'summary', left(i.summary, 400), 'severity', i.severity, 'mentions', i.mentions, 'last_seen', i.last_seen_at::date))
    from (select i.* from public.radar_items i join public.radar_topics t on t.id = i.topic_id
     where i.company_id = k.company_id and i.client_id = k.client_id
      and coalesce(mavi_private.radar_status(t.statuses, i.status)->>'kind', '') <> 'closed'
      and i.last_seen_at > now() - interval '90 days'
     order by i.severity desc nulls last, i.last_seen_at desc limit 10) i
    join public.radar_topics t on t.id = i.topic_id), '[]'),
   'temperature', (select jsonb_build_object('score', round(t.score), 'summary', left(t.summary, 800))
    from mavi_private.temperature_state t where t.client_id = k.client_id and t.company_id = k.company_id
     and t.score is not null),
   'meetings', coalesce((select jsonb_agg(jsonb_build_object('title', x.title, 'date', x.occurred_at::date,
     'text', x.text) order by x.occurred_at desc)
    from (select d.title, d.occurred_at, (select left(string_agg(c.content, E'\n' order by c.ord), 1500)
      from public.ai_chunks c where c.document_id = d.id and c.meta->>'kind' = 'summary') as text
     from public.ai_documents d where d.client_id = k.client_id and d.source_type = 'meeting'
      and d.occurred_at > now() - interval '60 days'
     order by d.occurred_at desc limit 3) x where x.text is not null), '[]')),
  'jev', mavi_private.campaign_insight_jev_route(r.company_id));
end $$;

-- Grava a análise: os insights (o mesmo insight ainda aberto só é
-- confirmado de novo), o gasto, os avisos e o aviso às telas. Sem insights
-- e com motivo, "skipped".
create function public.ai_campaign_insight_store(p_secret text, p_run uuid, p_result jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare r public.campaign_insight_runs; s public.campaign_insight_settings; v jsonb := coalesce(p_result, '{}');
 u jsonb; x jsonb; v_cost numeric := 0; v_client uuid; v_contract uuid; v_new integer := 0; v_again integer := 0;
 v_old uuid; v_basis text; v_notify integer := 0; v_status text; v_first text; v_high integer := 0;
 v_name text; begin
 if not mavi_private.ai_secret_ok(p_secret) then raise exception 'Sem permissão' using errcode = '42501'; end if;
 select * into r from public.campaign_insight_runs where id = p_run for update;
 if not found or r.status <> 'running' then return jsonb_build_object('ok', false); end if;
 s := mavi_private.campaign_insight_config(r.company_id);
 select k.client_id, k.id, a.name into v_client, v_contract, v_name from public.ad_campaigns a
 join public.contracts k on k.company_id = a.company_id and k.id = a.contract_id
 where a.company_id = r.company_id and a.id = r.campaign_id;
 v_basis := case when v->>'money_basis' in ('net', 'gross') then v->>'money_basis' else s.money_basis end;
 v_status := case when v->>'status' = 'skipped' then 'skipped' else 'done' end;

 for u in select * from jsonb_array_elements(case when jsonb_typeof(v->'usage') = 'array' then v->'usage' else '[]' end)
 loop
  insert into public.ai_usage(company_id, user_id, module, kind, client_id, contract_id, model, input_tokens,
   output_tokens, cache_read_tokens, cache_write_tokens, cost_usd, provider_id, provider_name)
  values (r.company_id, r.requested_by, 'campaign_insights', left(coalesce(u->>'kind', 'campaign_insights'), 40),
   v_client, v_contract, left(coalesce(u->>'model', ''), 80), greatest(coalesce((u->>'input')::int, 0), 0),
   greatest(coalesce((u->>'output')::int, 0), 0), greatest(coalesce((u->>'cache_read')::int, 0), 0),
   greatest(coalesce((u->>'cache_write')::int, 0), 0), least(greatest(coalesce((u->>'cost')::numeric, 0), 0), 20),
   case when u->>'provider_id' ~* '^[0-9a-f-]{36}$' then (u->>'provider_id')::uuid end,
   left(coalesce(u->>'provider', ''), 120));
  v_cost := v_cost + least(greatest(coalesce((u->>'cost')::numeric, 0), 0), 20);
 end loop;

 if v_status = 'done' then
  for x in select * from jsonb_array_elements(case when jsonb_typeof(v->'insights') = 'array' then v->'insights'
   else '[]' end)
  loop
   continue when x->>'kind' not in ('highlight', 'opportunity', 'problem', 'tracking')
    or x->>'priority' not in ('high', 'medium', 'low') or length(btrim(coalesce(x->>'title', ''))) < 3
    or jsonb_typeof(x->'evidence') <> 'array' or jsonb_array_length(x->'evidence') not between 1 and 8
    or length(coalesce(x->>'fingerprint', '')) < 3;
   select i.id into v_old from public.campaign_insights i where i.company_id = r.company_id
    and i.campaign_id = r.campaign_id and i.status = 'new' and i.fingerprint = left(x->>'fingerprint', 300)
    and i.last_seen_at > now() - interval '45 days'
   order by i.last_seen_at desc limit 1;
   if v_old is not null then
    update public.campaign_insights set last_seen_run = r.id, last_seen_at = now(), seen_count = seen_count + 1,
     kind = x->>'kind', priority = x->>'priority', title = left(btrim(x->>'title'), 200),
     body = left(coalesce(x->>'body', ''), 2000), action = left(coalesce(x->>'action', ''), 800),
     evidence = x->'evidence', target = case when jsonb_typeof(x->'target') = 'object' then x->'target' end,
     money_basis = v_basis, confidence = case when x->>'confidence' ~ '^[0-9.]+$'
      then least(greatest((x->>'confidence')::numeric, 0), 1) end
    where id = v_old;
    v_again := v_again + 1;
   else
    insert into public.campaign_insights(company_id, campaign_id, run_id, last_seen_run, kind, priority, title, body,
     action, evidence, target, source, fingerprint, money_basis, confidence)
    values (r.company_id, r.campaign_id, r.id, r.id, x->>'kind', x->>'priority', left(btrim(x->>'title'), 200),
     left(coalesce(x->>'body', ''), 2000), left(coalesce(x->>'action', ''), 800), x->'evidence',
     case when jsonb_typeof(x->'target') = 'object' then x->'target' end,
     case when x->>'source' = 'rule' then 'rule' else 'mavi' end, left(x->>'fingerprint', 300), v_basis,
     case when x->>'confidence' ~ '^[0-9.]+$' then least(greatest((x->>'confidence')::numeric, 0), 1) end);
    v_new := v_new + 1;
    if mavi_private.campaign_insight_rank(x->>'priority') >= mavi_private.campaign_insight_rank(s.notify_min_priority)
    then
     v_notify := v_notify + 1;
     v_first := coalesce(v_first, left(btrim(x->>'title'), 200));
     if x->>'priority' = 'high' then v_high := v_high + 1; end if;
    end if;
   end if;
  end loop;
 end if;

 update public.campaign_insight_runs set status = v_status, finished_at = now(), claimed_until = null,
  cost_usd = v_cost, summary = left(coalesce(v->>'summary', ''), 600), note = left(coalesce(v->>'note', ''), 1000),
  money_basis = v_basis, multiplier = case when v->>'multiplier' ~ '^[0-9.]+$' then (v->>'multiplier')::numeric end,
  windows = case when jsonb_typeof(v->'windows') = 'object' then v->'windows' else '{}' end,
  model = left(coalesce(v->>'model', ''), 120), provider_name = left(coalesce(v->>'provider', ''), 120),
  insights_count = v_new, repeated_count = v_again,
  api_calls = case when jsonb_typeof(v->'api_calls') = 'object' then v->'api_calls' else '{}' end,
  tokens = case when jsonb_typeof(v->'tokens') = 'object' then v->'tokens' else '{}' end
 where id = r.id;

 -- Caixa de entrada + push: quem atende o cliente (e os líderes, se pedido)
 -- e quem pediu a análise. Um aviso por pessoa por análise.
 if v_status = 'done' and s.notify_inbox and (v_notify > 0 or (r.trigger = 'manual' and r.requested_by is not null))
 then
  insert into public.notifications(company_id, user_id, actor_id, task_id, kind, title, body, link, client_id)
  select r.company_id, m.user_id, null, null, 'campaign_insight', left(format('Insights da MAVI: %s', v_name), 300),
   left(case when v_notify > 0 then format('%s %s%s · %s', v_notify,
     case when v_notify = 1 then 'insight novo' else 'insights novos' end,
     case when v_high > 0 then format(' (%s de prioridade alta)', v_high) else '' end, v_first)
    when v_new + v_again > 0 then format('Análise pronta: %s %s.', v_new + v_again,
     case when v_new + v_again = 1 then 'insight' else 'insights' end)
    else 'Análise pronta: nada novo que mereça ação agora.' end, 300),
   '/campanhas/' || r.campaign_id || '?aba=insights', v_client
  from public.memberships m
  where m.company_id = r.company_id and m.active
   and mavi_private.campaign_alert_sees(r.company_id, m.user_id, v_client)
   and ((m.user_id = r.requested_by)
    or (v_notify > 0 and (exists (select 1 from public.client_teams ct join public.team_members tm
       on tm.company_id = ct.company_id and tm.team_id = ct.team_id
      where ct.company_id = r.company_id and ct.client_id = v_client and tm.user_id = m.user_id)
     or (s.notify_who = 'team_leaders' and m.role in ('admin', 'manager')))));
 end if;

 perform mavi_private.broadcast(r.company_id, jsonb_build_object('kind', 'campaign_insights',
  'campaign', r.campaign_id, 'run', r.id, 'status', v_status));
 return jsonb_build_object('ok', true, 'new', v_new, 'repeated', v_again);
end $$;

-- Uma tentativa que falhou: volta para a fila (até 3) ou fica como falha.
create function public.ai_campaign_insight_fail(p_secret text, p_run uuid, p_error text, p_final boolean default false)
returns void
language plpgsql security definer set search_path = '' as $$
declare r public.campaign_insight_runs; begin
 if not mavi_private.ai_secret_ok(p_secret) then raise exception 'Sem permissão' using errcode = '42501'; end if;
 select * into r from public.campaign_insight_runs where id = p_run for update;
 if not found or r.status <> 'running' then return; end if;
 if p_final or r.attempts >= 3 then
  update public.campaign_insight_runs set status = 'failed', finished_at = now(), claimed_until = null,
   note = left(coalesce(p_error, ''), 1000) where id = r.id;
 else
  update public.campaign_insight_runs set status = 'queued', note = left(coalesce(p_error, ''), 1000),
   claimed_until = now() + make_interval(mins => 5 * r.attempts) where id = r.id;
 end if;
 perform mavi_private.broadcast(r.company_id, jsonb_build_object('kind', 'campaign_insights',
  'campaign', r.campaign_id, 'run', r.id, 'status', case when p_final or r.attempts >= 3 then 'failed' else 'queued' end));
end $$;

-- A cota da plataforma pediu espera (ou o orçamento do Google acabou): a
-- análise volta para a fila na hora marcada, sem contar como tentativa.
create function public.ai_campaign_insight_defer(p_secret text, p_run uuid, p_until timestamptz, p_note text)
returns void
language plpgsql security definer set search_path = '' as $$
declare r public.campaign_insight_runs; begin
 if not mavi_private.ai_secret_ok(p_secret) then raise exception 'Sem permissão' using errcode = '42501'; end if;
 select * into r from public.campaign_insight_runs where id = p_run for update;
 if not found or r.status <> 'running' then return; end if;
 update public.campaign_insight_runs set status = 'queued', attempts = greatest(attempts - 1, 0),
  claimed_until = least(greatest(coalesce(p_until, now() + interval '15 minutes'), now() + interval '1 minute'),
   now() + interval '24 hours'),
  note = left(coalesce(p_note, ''), 1000)
 where id = r.id;
 perform mavi_private.broadcast(r.company_id, jsonb_build_object('kind', 'campaign_insights',
  'campaign', r.campaign_id, 'run', r.id, 'status', 'queued'));
end $$;

-- Pausa uma conta (ou a plataforma, '*') até a hora indicada pela cota.
create function public.ai_campaign_insight_cooldown(p_secret text, p_platform text, p_account text,
 p_until timestamptz, p_reason text default '') returns void
language plpgsql security definer set search_path = '' as $$ begin
 if not mavi_private.ai_secret_ok(p_secret) then raise exception 'Sem permissão' using errcode = '42501'; end if;
 if p_platform not in ('meta', 'google') or coalesce(p_account, '') = '' then return; end if;
 insert into mavi_private.ad_api_cooldowns(platform, account_id, until, reason)
 values (p_platform, left(p_account, 60), least(p_until, now() + interval '24 hours'), left(coalesce(p_reason, ''), 300))
 on conflict (platform, account_id) do update set until = greatest(excluded.until, mavi_private.ad_api_cooldowns.until),
  reason = excluded.reason, updated_at = now();
 delete from mavi_private.ad_api_cooldowns where until < now() - interval '7 days';
end $$;

-- Operações do Google da MAVI: com p_check, só reserva se couber no
-- orçamento das últimas 24 h; sem, registra (o acerto depois da leitura).
create function public.ai_campaign_insight_google_ops(p_secret text, p_company uuid, p_ops integer,
 p_check boolean default true) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_used integer; v_budget integer; begin
 if not mavi_private.ai_secret_ok(p_secret) then raise exception 'Sem permissão' using errcode = '42501'; end if;
 perform pg_advisory_xact_lock(hashtext('campaign_insight_google_ops:' || p_company));
 v_used := mavi_private.campaign_insight_google_used(p_company);
 v_budget := (mavi_private.campaign_insight_config(p_company)).google_daily_ops;
 if p_check and v_used + greatest(p_ops, 0) > v_budget then
  return jsonb_build_object('ok', false, 'used', v_used, 'budget', v_budget,
   -- Quando a hora mais antiga das 24 h sai da conta.
   'retry_at', coalesce((select min(o.hour) + interval '24 hours 5 minutes' from mavi_private.campaign_insight_google_ops o
    where o.company_id = p_company and o.hour > now() - interval '24 hours' and o.ops > 0), now() + interval '1 hour'));
 end if;
 insert into mavi_private.campaign_insight_google_ops(company_id, hour, ops)
 values (p_company, date_trunc('hour', now()), coalesce(p_ops, 0))
 on conflict (company_id, hour) do update set ops = mavi_private.campaign_insight_google_ops.ops + excluded.ops;
 delete from mavi_private.campaign_insight_google_ops where company_id = p_company and hour < now() - interval '3 days';
 return jsonb_build_object('ok', true, 'used', v_used + coalesce(p_ops, 0), 'budget', v_budget);
end $$;

-- ------------------------------------------------------------ permissões
revoke all on function public.campaign_insights(uuid, uuid, integer), public.request_campaign_insight(uuid, uuid),
 public.campaign_insight_badges(uuid, uuid[]), public.campaign_insight_settings(uuid),
 public.save_campaign_insight_settings(uuid, jsonb), public.save_campaign_insight_rule(uuid, jsonb),
 public.delete_campaign_insight_rule(uuid, uuid) from public, anon;
grant execute on function public.campaign_insights(uuid, uuid, integer), public.request_campaign_insight(uuid, uuid),
 public.campaign_insight_badges(uuid, uuid[]), public.campaign_insight_settings(uuid),
 public.save_campaign_insight_settings(uuid, jsonb), public.save_campaign_insight_rule(uuid, jsonb),
 public.delete_campaign_insight_rule(uuid, uuid) to authenticated;
revoke all on function public.ai_campaign_insight_claim(text, integer), public.ai_campaign_insight_material(text, uuid),
 public.ai_campaign_insight_store(text, uuid, jsonb), public.ai_campaign_insight_fail(text, uuid, text, boolean),
 public.ai_campaign_insight_defer(text, uuid, timestamptz, text),
 public.ai_campaign_insight_cooldown(text, text, text, timestamptz, text),
 public.ai_campaign_insight_google_ops(text, uuid, integer, boolean)
 from public, anon, authenticated;
-- anon: o worker chama com o segredo.
grant execute on function public.ai_campaign_insight_claim(text, integer), public.ai_campaign_insight_material(text, uuid),
 public.ai_campaign_insight_store(text, uuid, jsonb), public.ai_campaign_insight_fail(text, uuid, text, boolean),
 public.ai_campaign_insight_defer(text, uuid, timestamptz, text),
 public.ai_campaign_insight_cooldown(text, text, text, timestamptz, text),
 public.ai_campaign_insight_google_ops(text, uuid, integer, boolean)
 to anon, authenticated;

notify pgrst, 'reload schema';

commit;
