begin;

-- Campanhas › lista: a Leitura do dia da MAVI (pedido de 04/10/2026). Toda
-- manhã, depois da sincronização, a MAVI escreve por campanha ativa uma
-- frase curta sobre o momento dela (ciclo × meta, ontem, hoje até agora,
-- ritmo de gasto, insights abertos) olhando públicos, conjuntos, anúncios e
-- as copys/criativos, e até 3 pontos de apoio. Aparece no ícone da coluna
-- MAVI da lista (junto com os insights abertos).
--
-- * Faz parte dos Insights da MAVI: só roda com eles ligados, e pode ser
--   desligada à parte (Painel da MAVI › Campanhas). O custo entra no teto do
--   mês dos insights (ai_usage módulo 'campaign_insights', tipo
--   'campaign_daily') e cada leitura tem o seu teto.
-- * Modelo: a funcionalidade 'campaign_daily' em Quem usa qual modelo (sem
--   regra própria, o modelo dos insights).
-- * Limites das APIs: as mesmas pausas e o mesmo orçamento do Google dos
--   insights; uma campanha por vez em cada conta (insights ou leitura).
--   Sem investimento ontem nem hoje, a frase sai sem a MAVI e sem a API.
--
-- O worker é a ação "ai-campaign-daily" de /api/ai (api/_campaign-daily.ts),
-- acordado por mavi_private.campaign_daily_kick
-- (supabase/operations/schedule-campaign-daily.sql).

-- ------------------------------------------------------------ Quem usa qual modelo
-- A da migração 20270328090000, com a leitura do dia.
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
   'campaign_insights', 'campaign_insights_check', 'campaign_creative_image', 'campaign_creative_transcribe',
  'campaign_daily')));

-- A da migração 20270328090000, com a leitura do dia.
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
  'campaign_insights', 'campaign_insights_check', 'campaign_creative_image', 'campaign_creative_transcribe',
  'campaign_daily') then
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

-- ------------------------------------------------------------ configuração
create table public.campaign_daily_settings (
 company_id uuid primary key references public.companies(id),
 enabled boolean not null default true,
 -- A partir desta hora (local): espera a sincronização da manhã até 3 h depois.
 hour smallint not null default 7 check (hour between 0 and 20),
 -- Teto por leitura (US$).
 run_cap_usd numeric(6,2) not null default 0.10 check (run_cap_usd between 0.02 and 5),
 updated_by uuid,
 updated_at timestamptz not null default now()
);
alter table public.campaign_daily_settings enable row level security;
revoke all on public.campaign_daily_settings from public, anon, authenticated;

create function mavi_private.campaign_daily_config(c uuid) returns public.campaign_daily_settings
language sql stable security definer set search_path = '' as $$
 select coalesce((select s from public.campaign_daily_settings s where s.company_id = c),
  row(c, true, 7, 0.10, null, now())::public.campaign_daily_settings)
$$;

-- ------------------------------------------------------------ leituras
create table public.campaign_daily_reads (
 id uuid primary key default gen_random_uuid(),
 company_id uuid not null,
 campaign_id uuid not null,
 cycle_id uuid,
 local_day date not null,
 -- queued › running › done | skipped | failed.
 status text not null default 'queued' check (status in ('queued', 'running', 'done', 'skipped', 'failed')),
 attempts smallint not null default 0,
 claimed_until timestamptz,
 -- good: no caminho; attention: pede atenção; bad: fora da meta.
 tone text check (tone in ('good', 'attention', 'bad')),
 headline text not null default '' check (length(headline) <= 320),
 points jsonb not null default '[]' check (jsonb_typeof(points) = 'array'),
 money_basis text check (money_basis in ('net', 'gross')),
 -- Sem a MAVI (sem investimento) ou sem a plataforma (cota, conexão).
 source text not null default 'mavi' check (source in ('mavi', 'rule')),
 note text not null default '' check (length(note) <= 1000),
 model text not null default '',
 provider_name text not null default '',
 cost_usd numeric(12,6) not null default 0,
 api_calls jsonb not null default '{}' check (jsonb_typeof(api_calls) = 'object'),
 created_at timestamptz not null default now(),
 started_at timestamptz,
 finished_at timestamptz,
 unique (company_id, campaign_id, local_day),
 foreign key (company_id, campaign_id) references public.ad_campaigns(company_id, id) on delete cascade
);
create index campaign_daily_reads_queue on public.campaign_daily_reads(created_at)
 where status in ('queued', 'running');
alter table public.campaign_daily_reads enable row level security;
revoke all on public.campaign_daily_reads from public, anon, authenticated;

-- Liga: os insights da empresa ligados, a leitura ligada e abaixo do teto do mês.
create function mavi_private.campaign_daily_on(c uuid) returns boolean
language sql stable security definer set search_path = '' as $$
 select (mavi_private.campaign_insight_config(c)).enabled and (mavi_private.campaign_daily_config(c)).enabled
  and not mavi_private.campaign_insight_capped(c)
$$;

-- Acorda o worker.
create function mavi_private.campaign_daily_post() returns void
language plpgsql security definer set search_path = '' as $$
declare cfg mavi_private.ai_config; begin
 select * into cfg from mavi_private.ai_config where id;
 if not found then return; end if;
 perform net.http_post(url := cfg.url, body := '{"action":"ai-campaign-daily"}'::jsonb,
  headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || cfg.secret),
  timeout_milliseconds := 290000);
end $$;

-- Põe na fila a leitura de hoje das campanhas que podem ser analisadas (as
-- regras dos insights), depois da sincronização da manhã do ciclo atual — ou,
-- se ela não vier, 3 horas depois da hora marcada.
create function mavi_private.campaign_daily_tick() returns integer
language plpgsql security definer set search_path = '' as $$
declare c uuid; cfg public.campaign_daily_settings; a record; v_n integer := 0; v_today date; v_hour integer;
 v_tz text; begin
 -- Reservas vencidas depois da última tentativa: falhou.
 update public.campaign_daily_reads set status = 'failed', finished_at = now(),
  note = left('A leitura não terminou depois de 3 tentativas.', 1000)
 where status = 'running' and claimed_until < now() and attempts >= 3;
 for c in select s.company_id from public.campaign_insight_settings s where s.enabled loop
  continue when not mavi_private.campaign_daily_on(c);
  cfg := mavi_private.campaign_daily_config(c);
  v_tz := mavi_private.company_tz(c);
  v_today := mavi_private.company_today(c);
  v_hour := extract(hour from now() at time zone v_tz)::int;
  continue when v_hour < cfg.hour;
  for a in
   select x.id, x.current_cycle_id from public.ad_campaigns x
   where x.company_id = c and x.status = 'active' and not x.archived and x.platform in ('meta', 'google')
    and not exists (select 1 from public.campaign_daily_reads r where r.company_id = c and r.campaign_id = x.id
     and r.local_day = v_today)
   order by x.id
  loop
   continue when mavi_private.campaign_insight_blocker(c, a.id) is not null;
   continue when v_hour < cfg.hour + 3 and not exists (select 1 from public.ad_sync_runs r
    where r.company_id = c and r.cycle_id = a.current_cycle_id and r.status = 'ok'
     and r.created_at >= (v_today::timestamp at time zone v_tz));
   insert into public.campaign_daily_reads(company_id, campaign_id, cycle_id, local_day)
   values (c, a.id, a.current_cycle_id, v_today) on conflict do nothing;
   v_n := v_n + 1;
   exit when v_n >= 300;
  end loop;
 end loop;
 return v_n;
end $$;

-- Chamado pelo pg_cron.
create function mavi_private.campaign_daily_kick() returns void
language plpgsql security definer set search_path = '' as $$ begin
 begin
  perform mavi_private.campaign_daily_tick();
 exception when others then
  raise warning 'campaign daily tick failed: %', sqlerrm;
 end;
 if exists (select 1 from public.campaign_daily_reads r where r.status in ('queued', 'running')
  and coalesce(r.claimed_until, '-infinity') < now() and r.attempts < 3) then
  perform mavi_private.campaign_daily_post();
 end if;
end $$;

revoke all on function mavi_private.campaign_daily_config(uuid), mavi_private.campaign_daily_on(uuid),
 mavi_private.campaign_daily_post(), mavi_private.campaign_daily_tick(), mavi_private.campaign_daily_kick()
 from public, anon, authenticated;

-- ------------------------------------------------------------ worker
-- As leituras a fazer, reservadas por 6 minutos. Pula as contas pausadas
-- pela cota e as que uma análise ou outra leitura está lendo agora.
create function public.ai_campaign_daily_claim(p_secret text, p_limit integer default 3) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare r record; v_accounts text[]; v_busy text[] := '{}'; v_out jsonb := '[]';
 v_limit integer := least(greatest(coalesce(p_limit, 3), 1), 10); begin
 if not mavi_private.ai_secret_ok(p_secret) then raise exception 'Sem permissão' using errcode = '42501'; end if;
 select coalesce(array_agg(distinct q.platform || ':' || x), '{}') into v_busy from (
  select a.platform, q.company_id, q.campaign_id from public.campaign_insight_runs q
  join public.ad_campaigns a on a.company_id = q.company_id and a.id = q.campaign_id
  where q.status = 'running' and q.claimed_until > now()
  union all
  select a.platform, q.company_id, q.campaign_id from public.campaign_daily_reads q
  join public.ad_campaigns a on a.company_id = q.company_id and a.id = q.campaign_id
  where q.status = 'running' and q.claimed_until > now()
 ) q, unnest(mavi_private.campaign_insight_accounts(q.company_id, q.campaign_id)) x;
 for r in
  select q.id, q.company_id, q.campaign_id, a.platform from public.campaign_daily_reads q
  join public.ad_campaigns a on a.company_id = q.company_id and a.id = q.campaign_id
  where q.status in ('queued', 'running') and coalesce(q.claimed_until, '-infinity') < now() and q.attempts < 3
  order by q.created_at
  limit 200
  for update of q skip locked
 loop
  v_accounts := mavi_private.campaign_insight_accounts(r.company_id, r.campaign_id);
  continue when mavi_private.campaign_insight_paused(r.platform, v_accounts) is not null;
  continue when exists (select 1 from unnest(v_accounts) x where r.platform || ':' || x = any(v_busy));
  update public.campaign_daily_reads set status = 'running', attempts = attempts + 1,
   claimed_until = now() + interval '6 minutes', started_at = coalesce(started_at, now())
  where id = r.id;
  v_busy := v_busy || array(select r.platform || ':' || x from unnest(v_accounts) x);
  v_out := v_out || jsonb_build_array(jsonb_build_object('id', r.id, 'company_id', r.company_id,
   'campaign_id', r.campaign_id));
  exit when jsonb_array_length(v_out) >= v_limit;
 end loop;
 return v_out;
end $$;

-- O que o worker precisa (no formato do material dos insights, que a
-- leitura da plataforma usa) e o que a lista mostra: hoje até agora e os
-- insights abertos. Nulo: a leitura sumiu; blocked: não pode mais ler.
create function public.ai_campaign_daily_material(p_secret text, p_read uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare r public.campaign_daily_reads; a public.ad_campaigns; y public.ad_cycles; k public.contracts;
 s public.campaign_insight_settings; d public.campaign_daily_settings; v_block text; v_today date; begin
 if not mavi_private.ai_secret_ok(p_secret) then raise exception 'Sem permissão' using errcode = '42501'; end if;
 select * into r from public.campaign_daily_reads where id = p_read;
 if not found then return null; end if;
 v_block := mavi_private.campaign_insight_blocker(r.company_id, r.campaign_id);
 if v_block is not null then return jsonb_build_object('blocked', v_block); end if;
 if not mavi_private.campaign_daily_on(r.company_id) then
  return jsonb_build_object('blocked', 'A leitura do dia foi desligada ou o teto do mês chegou.');
 end if;
 select * into a from public.ad_campaigns where company_id = r.company_id and id = r.campaign_id;
 select * into y from public.ad_cycles where company_id = a.company_id and id = a.current_cycle_id;
 select * into k from public.contracts where company_id = a.company_id and id = a.contract_id;
 s := mavi_private.campaign_insight_config(r.company_id);
 d := mavi_private.campaign_daily_config(r.company_id);
 v_today := mavi_private.company_today(r.company_id);
 return jsonb_build_object(
  'run', jsonb_build_object('id', r.id, 'trigger', 'schedule'),
  'company_id', r.company_id,
  'today', v_today,
  'timezone', mavi_private.company_tz(r.company_id),
  'campaign', jsonb_build_object('id', a.id, 'name', a.name, 'platform', a.platform, 'notes', left(a.notes, 800)),
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
  'daily', coalesce((select jsonb_agg(jsonb_build_object('day', x.day, 'spend', x.spend,
    'conversions', x.conversions, 'clicks', x.clicks, 'impressions', x.impressions, 'multiplier', x.multiplier)
    order by x.day)
   from public.ad_daily_metrics x where x.company_id = y.company_id and x.cycle_id = y.id and x.day < v_today), '[]'),
  -- O acumulado do ciclo como o cabeçalho conta (o último, senão os dias).
  'cycle_total', (select jsonb_build_object('spend', x.spend, 'conversions', x.conversions, 'until', x.period_end)
   from public.ad_cycle_snapshots x where x.company_id = y.company_id and x.cycle_id = y.id
   order by x.taken_on desc limit 1),
  'today_read', (select jsonb_build_object('spend', x.spend, 'conversions', x.conversions, 'read_at', x.read_at)
   from public.ad_today_metrics x where x.company_id = a.company_id and x.campaign_id = a.id and x.day = v_today),
  'open_insights', coalesce((select jsonb_agg(jsonb_build_object('priority', i.priority, 'kind', i.kind,
    'title', i.title, 'action', left(i.action, 300)) order by mavi_private.campaign_insight_rank(i.priority) desc,
    i.last_seen_at desc)
   from (select * from public.campaign_insights i where i.company_id = a.company_id and i.campaign_id = a.id
    and i.status = 'new' and i.snooze_until is null order by i.last_seen_at desc limit 6) i), '[]'),
  'settings', jsonb_build_object('money_basis', s.money_basis, 'run_cap_usd', d.run_cap_usd, 'min_new_days', 0),
  'last_done_at', null,
  'previous', '[]'::jsonb,
  'context', jsonb_build_object('dossier', '[]'::jsonb, 'radar', '[]'::jsonb, 'temperature', null,
   'meetings', '[]'::jsonb),
  'jev', null);
end $$;

-- Grava a leitura (ou o motivo de ter pulado), o gasto e avisa as telas.
create function public.ai_campaign_daily_store(p_secret text, p_read uuid, p_result jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare r public.campaign_daily_reads; v jsonb := coalesce(p_result, '{}'); u jsonb; v_cost numeric := 0;
 v_client uuid; v_contract uuid; v_status text; v_points jsonb; begin
 if not mavi_private.ai_secret_ok(p_secret) then raise exception 'Sem permissão' using errcode = '42501'; end if;
 select * into r from public.campaign_daily_reads where id = p_read for update;
 if not found or r.status <> 'running' then return jsonb_build_object('ok', false); end if;
 select k.client_id, k.id into v_client, v_contract from public.ad_campaigns a
 join public.contracts k on k.company_id = a.company_id and k.id = a.contract_id
 where a.company_id = r.company_id and a.id = r.campaign_id;
 v_status := case when v->>'status' = 'skipped' then 'skipped' else 'done' end;
 for u in select * from jsonb_array_elements(case when jsonb_typeof(v->'usage') = 'array' then v->'usage' else '[]' end)
 loop
  insert into public.ai_usage(company_id, user_id, module, kind, client_id, contract_id, model, input_tokens,
   output_tokens, cache_read_tokens, cache_write_tokens, cost_usd, provider_id, provider_name)
  values (r.company_id, null, 'campaign_insights', left(coalesce(u->>'kind', 'campaign_daily'), 40),
   v_client, v_contract, left(coalesce(u->>'model', ''), 80), greatest(coalesce((u->>'input')::int, 0), 0),
   greatest(coalesce((u->>'output')::int, 0), 0), greatest(coalesce((u->>'cache_read')::int, 0), 0),
   greatest(coalesce((u->>'cache_write')::int, 0), 0), least(greatest(coalesce((u->>'cost')::numeric, 0), 0), 5),
   case when u->>'provider_id' ~* '^[0-9a-f-]{36}$' then (u->>'provider_id')::uuid end,
   left(coalesce(u->>'provider', ''), 120));
  v_cost := v_cost + least(greatest(coalesce((u->>'cost')::numeric, 0), 0), 5);
 end loop;
 select coalesce(jsonb_agg(left(x, 220)), '[]') into v_points from (
  select x from jsonb_array_elements_text(case when jsonb_typeof(v->'points') = 'array' then v->'points' else '[]' end) x
  where length(btrim(x)) > 0 limit 3) p;
 update public.campaign_daily_reads set status = v_status, claimed_until = null, finished_at = now(),
  tone = case when v_status = 'done' and v->>'tone' in ('good', 'attention', 'bad') then v->>'tone' end,
  headline = case when v_status = 'done' then left(btrim(coalesce(v->>'headline', '')), 320) else '' end,
  points = case when v_status = 'done' then v_points else '[]'::jsonb end,
  money_basis = case when v->>'money_basis' in ('net', 'gross') then v->>'money_basis' end,
  source = case when v->>'source' = 'rule' then 'rule' else 'mavi' end,
  note = left(coalesce(v->>'note', ''), 1000), model = left(coalesce(v->>'model', ''), 80),
  provider_name = left(coalesce(v->>'provider', ''), 120), cost_usd = v_cost,
  api_calls = case when jsonb_typeof(v->'api_calls') = 'object' then v->'api_calls' else '{}' end
 where id = r.id;
 perform mavi_private.broadcast(r.company_id, jsonb_build_object('kind', 'campaign_insights',
  'campaign', r.campaign_id, 'run', r.id, 'status', 'daily'));
 return jsonb_build_object('ok', true, 'cost', v_cost);
end $$;

-- Uma tentativa que falhou: volta para a fila (até 3) ou fica como falha.
create function public.ai_campaign_daily_fail(p_secret text, p_read uuid, p_error text, p_final boolean default false)
returns void
language plpgsql security definer set search_path = '' as $$
declare r public.campaign_daily_reads; begin
 if not mavi_private.ai_secret_ok(p_secret) then raise exception 'Sem permissão' using errcode = '42501'; end if;
 select * into r from public.campaign_daily_reads where id = p_read for update;
 if not found or r.status <> 'running' then return; end if;
 if p_final or r.attempts >= 3 then
  update public.campaign_daily_reads set status = 'failed', finished_at = now(), claimed_until = null,
   note = left(coalesce(p_error, ''), 1000) where id = r.id;
 else
  update public.campaign_daily_reads set status = 'queued', note = left(coalesce(p_error, ''), 1000),
   claimed_until = now() + make_interval(mins => 5 * r.attempts) where id = r.id;
 end if;
end $$;

-- A cota pediu espera: volta para a fila na hora marcada, sem contar tentativa.
create function public.ai_campaign_daily_defer(p_secret text, p_read uuid, p_until timestamptz, p_note text)
returns void
language plpgsql security definer set search_path = '' as $$
declare r public.campaign_daily_reads; begin
 if not mavi_private.ai_secret_ok(p_secret) then raise exception 'Sem permissão' using errcode = '42501'; end if;
 select * into r from public.campaign_daily_reads where id = p_read for update;
 if not found or r.status <> 'running' then return; end if;
 update public.campaign_daily_reads set status = 'queued', attempts = greatest(attempts - 1, 0),
  claimed_until = least(greatest(coalesce(p_until, now() + interval '15 minutes'), now() + interval '1 minute'),
   now() + interval '12 hours'),
  note = left(coalesce(p_note, ''), 1000)
 where id = r.id;
end $$;

revoke all on function public.ai_campaign_daily_claim(text, integer), public.ai_campaign_daily_material(text, uuid),
 public.ai_campaign_daily_store(text, uuid, jsonb), public.ai_campaign_daily_fail(text, uuid, text, boolean),
 public.ai_campaign_daily_defer(text, uuid, timestamptz, text) from public, anon, authenticated;
-- anon: o servidor com o segredo do worker.
grant execute on function public.ai_campaign_daily_claim(text, integer), public.ai_campaign_daily_material(text, uuid),
 public.ai_campaign_daily_store(text, uuid, jsonb), public.ai_campaign_daily_fail(text, uuid, text, boolean),
 public.ai_campaign_daily_defer(text, uuid, timestamptz, text) to anon, authenticated;

-- ------------------------------------------------------------ telas
-- A coluna MAVI da lista: a leitura mais recente (hoje; senão a dos últimos
-- 3 dias, com o dia) e os insights abertos de cada campanha da página.
create function public.campaign_daily_reads(p_company uuid, p_campaigns uuid[]) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_on boolean; v_today date; begin
 perform mavi_private.ad_require_reader(p_company);
 v_on := (mavi_private.campaign_insight_config(p_company)).enabled
  and (mavi_private.campaign_daily_config(p_company)).enabled;
 v_today := mavi_private.company_today(p_company);
 return jsonb_build_object('enabled', v_on, 'today', v_today, 'rows', coalesce((
  select jsonb_agg(jsonb_build_object('campaign', a.id, 'day', l.local_day, 'tone', l.tone,
   'headline', l.headline, 'points', l.points, 'at', l.finished_at, 'money_basis', l.money_basis,
   'source', l.source, 'pending', exists (select 1 from public.campaign_daily_reads q where q.company_id = a.company_id
    and q.campaign_id = a.id and q.local_day = v_today and q.status in ('queued', 'running')),
   'insights', coalesce((select jsonb_agg(jsonb_build_object('title', i.title, 'priority', i.priority))
    from (select i.title, i.priority from public.campaign_insights i where i.company_id = a.company_id
     and i.campaign_id = a.id and i.status = 'new' and i.snooze_until is null
     order by mavi_private.campaign_insight_rank(i.priority) desc, i.last_seen_at desc limit 2) i), '[]')))
  from public.ad_campaigns a
  left join lateral (select r.* from public.campaign_daily_reads r where r.company_id = a.company_id
   and r.campaign_id = a.id and r.status = 'done' and r.local_day >= v_today - 3
   order by r.local_day desc limit 1) l on true
  where a.company_id = p_company and a.id = any(coalesce(p_campaigns, '{}'))
   and mavi_private.campaign_insight_reader(p_company, a.id)
   and (l.id is not null or exists (select 1 from public.campaign_daily_reads q where q.company_id = a.company_id
    and q.campaign_id = a.id and q.local_day = v_today and q.status in ('queued', 'running')))), '[]'));
end $$;

-- Painel da MAVI › Campanhas: ligar, a hora e o teto, com o gasto do mês.
create function public.campaign_daily_settings(p_company uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare d public.campaign_daily_settings; v_tz text; begin
 if not mavi_private.leader(p_company) then raise exception 'Sem permissão' using errcode = '42501'; end if;
 d := mavi_private.campaign_daily_config(p_company);
 v_tz := mavi_private.company_tz(p_company);
 return jsonb_build_object('enabled', d.enabled, 'hour', d.hour, 'run_cap_usd', d.run_cap_usd,
  'insights_enabled', (mavi_private.campaign_insight_config(p_company)).enabled,
  'month', (select jsonb_build_object('reads', count(*) filter (where r.status = 'done'),
    'cost_usd', coalesce(sum(r.cost_usd), 0))
   from public.campaign_daily_reads r where r.company_id = p_company
    and r.created_at >= (date_trunc('month', now() at time zone v_tz) at time zone v_tz)));
end $$;

create function public.save_campaign_daily_settings(p_company uuid, p_settings jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v jsonb := coalesce(p_settings, '{}'); d public.campaign_daily_settings; begin
 if not mavi_private.leader(p_company) then
  raise exception 'Só administradores e gestores configuram a leitura do dia.' using errcode = '42501';
 end if;
 d := mavi_private.campaign_daily_config(p_company);
 insert into public.campaign_daily_settings as s(company_id, enabled, hour, run_cap_usd, updated_by, updated_at)
 values (p_company, coalesce((v->>'enabled')::boolean, d.enabled),
  least(greatest(coalesce((v->>'hour')::int, d.hour), 0), 20),
  least(greatest(coalesce((v->>'run_cap_usd')::numeric, d.run_cap_usd), 0.02), 5), auth.uid(), now())
 on conflict (company_id) do update set enabled = excluded.enabled, hour = excluded.hour,
  run_cap_usd = excluded.run_cap_usd, updated_by = excluded.updated_by, updated_at = now();
 return public.campaign_daily_settings(p_company);
end $$;

revoke all on function public.campaign_daily_reads(uuid, uuid[]), public.campaign_daily_settings(uuid),
 public.save_campaign_daily_settings(uuid, jsonb) from public, anon;
grant execute on function public.campaign_daily_reads(uuid, uuid[]), public.campaign_daily_settings(uuid),
 public.save_campaign_daily_settings(uuid, jsonb) to authenticated;

commit;
