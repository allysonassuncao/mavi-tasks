begin;

-- Campanhas › Insights da MAVI, Fase 3: os criativos (pedido de 04/10/2026).
--
-- A MAVI passa a ENXERGAR os anúncios que pesam na campanha: a imagem (ou a
-- capa do vídeo) com o texto do anúncio e, nos vídeos, a transcrição do
-- áudio. Cada criativo é lido UMA vez — pela imagem (hash), pelo vídeo (id)
-- ou pelo criativo — e o resumo (formato, promessa, gancho, oferta, prova,
-- chamada, público aparente, texto na imagem) fica guardado em
-- campaign_creatives: as análises seguintes e as outras campanhas que usam
-- o mesmo criativo reaproveitam sem gastar de novo.
--
-- * Modelos no Painel da MAVI › Quem usa qual modelo: 'campaign_creative_image'
--   (lê as imagens: precisa ser um modelo com visão; sem regra, a regra da
--   empresa ou a Claude do servidor) e 'campaign_creative_transcribe' (o
--   áudio dos vídeos: um modelo de transcrição; sem regra, a OpenAI do
--   servidor), como as outras transcrições.
-- * Painel da MAVI › Campanhas: ler as imagens, ler os vídeos e quantos
--   criativos novos cada análise pode ler (o resto fica para a próxima). O
--   gasto entra no custo da análise (e nos tetos).

-- ------------------------------------------------------------ Quem usa qual modelo
create or replace function mavi_private.ai_transcribe_feature(p_feature text) returns boolean
language sql immutable set search_path = '' as $$
 select coalesce(p_feature, '') in ('whatsapp_transcribe', 'task_audio_transcribe', 'campaign_creative_transcribe')
$$;

-- A da migração 20270327090000, com os criativos.
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
   'campaign_insights', 'campaign_insights_check', 'campaign_creative_image', 'campaign_creative_transcribe')));

-- A da migração 20270327090000, com os criativos.
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
  'campaign_insights', 'campaign_insights_check', 'campaign_creative_image', 'campaign_creative_transcribe') then
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
alter table public.campaign_insight_settings
 add column creative_images boolean not null default true,
 add column creative_videos boolean not null default true,
 add column creative_new_max smallint not null default 6 check (creative_new_max between 0 and 20);

-- A da migração 20270327090000, com os criativos (colunas no fim da tabela).
create or replace function mavi_private.campaign_insight_config(c uuid) returns public.campaign_insight_settings
language sql stable security definer set search_path = '' as $$
 select coalesce((select s from public.campaign_insight_settings s where s.company_id = c),
  row(c, false, 'weekdays', '{1,4}'::smallint[], 3, 8, true, true, true, true, true, 'high', 'team', 'net',
   30, 0.50, 240, 2, 500, null, null, now(), true, true, 6)::public.campaign_insight_settings)
$$;

-- A da migração 20270327090000, com os criativos.
create or replace function public.save_campaign_insight_settings(p_company uuid, p_settings jsonb) returns jsonb
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
 n.creative_images := coalesce((v->>'creative_images')::boolean, s.creative_images);
 n.creative_videos := coalesce((v->>'creative_videos')::boolean, s.creative_videos);
 n.creative_new_max := coalesce((v->>'creative_new_max')::smallint, s.creative_new_max);
 if cardinality(n.weekdays) = 0 then
  raise exception 'Escolha ao menos um dia da semana.' using errcode = '22023';
 end if;
 insert into public.campaign_insight_settings as x (company_id, enabled, frequency, weekdays, every_days, hour,
  show_panel, show_badge, show_tab, mavi_context, notify_inbox, notify_min_priority, notify_who, money_basis,
  monthly_cap_usd, run_cap_usd, min_interval_minutes, min_new_days, google_daily_ops, creative_images, creative_videos,
  creative_new_max, updated_by, updated_at)
 values (p_company, n.enabled, n.frequency, n.weekdays, n.every_days, n.hour, n.show_panel, n.show_badge, n.show_tab,
  n.mavi_context, n.notify_inbox, n.notify_min_priority, n.notify_who, n.money_basis, n.monthly_cap_usd,
  n.run_cap_usd, n.min_interval_minutes, n.min_new_days, n.google_daily_ops, n.creative_images, n.creative_videos,
  n.creative_new_max, auth.uid(), now())
 on conflict (company_id) do update set enabled = excluded.enabled, frequency = excluded.frequency,
  weekdays = excluded.weekdays, every_days = excluded.every_days, hour = excluded.hour,
  show_panel = excluded.show_panel, show_badge = excluded.show_badge, show_tab = excluded.show_tab,
  mavi_context = excluded.mavi_context, notify_inbox = excluded.notify_inbox,
  notify_min_priority = excluded.notify_min_priority, notify_who = excluded.notify_who,
  money_basis = excluded.money_basis, monthly_cap_usd = excluded.monthly_cap_usd,
  run_cap_usd = excluded.run_cap_usd, min_interval_minutes = excluded.min_interval_minutes,
  min_new_days = excluded.min_new_days, google_daily_ops = excluded.google_daily_ops,
  creative_images = excluded.creative_images, creative_videos = excluded.creative_videos,
  creative_new_max = excluded.creative_new_max,
  -- Teto mudou: avisa de novo se for atingido.
  cap_noticed_month = case when excluded.monthly_cap_usd is distinct from x.monthly_cap_usd then null
   else x.cap_noticed_month end,
  updated_by = excluded.updated_by, updated_at = excluded.updated_at;
 return mavi_private.campaign_insight_settings_json(p_company);
end $$;

-- ------------------------------------------------------------ criativos
create table public.campaign_creatives (
 company_id uuid not null references public.companies(id) on delete cascade,
 platform text not null check (platform in ('meta', 'google')),
 -- i:<hash da imagem> · v:<id do vídeo> · c:<id do criativo> · u:<hash do endereço>
 key text not null check (length(key) between 3 and 200),
 kind text not null check (kind in ('image', 'video')),
 -- {formato, promessa, gancho, oferta, prova, cta, publico_aparente, texto_na_imagem, resumo}
 summary jsonb not null default '{}' check (jsonb_typeof(summary) = 'object'),
 transcript text not null default '' check (length(transcript) <= 20000),
 -- Por que não deu para ler tudo (vídeo grande demais, sem acesso ao arquivo…).
 note text not null default '' check (length(note) <= 500),
 model text not null default '',
 cost_usd numeric(12,6) not null default 0,
 read_at timestamptz not null default now(),
 primary key (company_id, platform, key)
);
alter table public.campaign_creatives enable row level security;
revoke all on public.campaign_creatives from public, anon, authenticated;

-- O que já foi lido destes criativos e as escolhas da empresa.
create function public.ai_campaign_creatives_get(p_secret text, p_company uuid, p_platform text, p_keys text[])
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare s public.campaign_insight_settings; begin
 if not mavi_private.ai_secret_ok(p_secret) then raise exception 'Sem permissão' using errcode = '42501'; end if;
 s := mavi_private.campaign_insight_config(p_company);
 return jsonb_build_object(
  'settings', jsonb_build_object('images', s.creative_images, 'videos', s.creative_videos, 'new_max', s.creative_new_max),
  'items', coalesce((select jsonb_agg(jsonb_build_object('key', x.key, 'kind', x.kind, 'summary', x.summary,
    'transcript', left(x.transcript, 2000), 'note', x.note, 'read_at', x.read_at))
   from public.campaign_creatives x
   where x.company_id = p_company and x.platform = p_platform
    and x.key = any((coalesce(p_keys, '{}'))[1:200])), '[]'));
end $$;

-- Guarda o que foi lido (um criativo relido substitui o anterior).
create function public.ai_campaign_creatives_put(p_secret text, p_company uuid, p_platform text, p_items jsonb)
returns integer
language plpgsql security definer set search_path = '' as $$
declare x jsonb; v_n integer := 0; begin
 if not mavi_private.ai_secret_ok(p_secret) then raise exception 'Sem permissão' using errcode = '42501'; end if;
 if p_platform not in ('meta', 'google') then return 0; end if;
 for x in select * from jsonb_array_elements(case when jsonb_typeof(p_items) = 'array' then p_items else '[]' end)
 loop
  continue when length(coalesce(x->>'key', '')) not between 3 and 200 or x->>'kind' not in ('image', 'video')
   or jsonb_typeof(x->'summary') <> 'object';
  insert into public.campaign_creatives(company_id, platform, key, kind, summary, transcript, note, model, cost_usd)
  values (p_company, p_platform, x->>'key', x->>'kind', x->'summary', left(coalesce(x->>'transcript', ''), 20000),
   left(coalesce(x->>'note', ''), 500), left(coalesce(x->>'model', ''), 120),
   least(greatest(coalesce((x->>'cost')::numeric, 0), 0), 20))
  on conflict (company_id, platform, key) do update set kind = excluded.kind, summary = excluded.summary,
   transcript = excluded.transcript, note = excluded.note, model = excluded.model, cost_usd = excluded.cost_usd,
   read_at = now();
  v_n := v_n + 1;
 end loop;
 return v_n;
end $$;

revoke all on function public.ai_campaign_creatives_get(text, uuid, text, text[]),
 public.ai_campaign_creatives_put(text, uuid, text, jsonb) from public, anon, authenticated;
grant execute on function public.ai_campaign_creatives_get(text, uuid, text, text[]),
 public.ai_campaign_creatives_put(text, uuid, text, jsonb) to anon, authenticated;

notify pgrst, 'reload schema';

commit;
