begin;

-- Campanhas › Insights da MAVI, Fase 7 (pedido de 04/10/2026): a vigia
-- diária, sem a MAVI.
--
-- * Pelos números do dia (Dia a Dia): logo depois de cada sincronização boa
--   do ciclo atual, checagens em SQL — gasto disparou, conversões pararam
--   (possível rastreio quebrado), custo por resultado quase dobrou, parou de
--   gastar. Custo zero: sem API e sem modelo.
-- * Uma leitura leve por dia nas plataformas e no CRM (o worker dos insights,
--   fila campaign_watch_queue): anúncios reprovados (Meta e Google), campanha
--   do Google limitada pelo orçamento, e conversões na plataforma sem nenhum
--   lead no CRM nos últimos 2 dias (quando antes chegavam).
-- * Cada achado vira um insight de origem 'watch', aberto até a situação
--   passar ('resolved', automático) ou alguém agir; avisa os responsáveis da
--   campanha (ou as equipes) só quando é novo. Liga e desliga no Painel da
--   MAVI › Campanhas (vigia e a leitura das plataformas, à parte).

-- ------------------------------------------------------------ configuração
alter table public.campaign_insight_settings
 add column watch_enabled boolean not null default true,
 add column watch_api boolean not null default true;

-- A da migração 20270331150000, com a vigia (no fim da tabela).
create or replace function mavi_private.campaign_insight_config(c uuid) returns public.campaign_insight_settings
language sql stable security definer set search_path = '' as $$
 select coalesce((select s from public.campaign_insight_settings s where s.company_id = c),
  row(c, false, 'weekdays', '{1,4}'::smallint[], 3, 8, true, true, true, true, true, 'high', 'owners', 'net',
   30, 0.50, 240, 2, 500, null, null, now(), true, true, 6, 15, 10, 4, true, true)::public.campaign_insight_settings)
$$;

-- A da migração 20270331150000, com a vigia.
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
 n.expire_days := coalesce((v->>'expire_days')::smallint, s.expire_days);
 n.min_results := coalesce((v->>'min_results')::smallint, s.min_results);
 n.max_insights := coalesce((v->>'max_insights')::smallint, s.max_insights);
 n.watch_enabled := coalesce((v->>'watch_enabled')::boolean, s.watch_enabled);
 n.watch_api := coalesce((v->>'watch_api')::boolean, s.watch_api);
 if cardinality(n.weekdays) = 0 then
  raise exception 'Escolha ao menos um dia da semana.' using errcode = '22023';
 end if;
 insert into public.campaign_insight_settings as x (company_id, enabled, frequency, weekdays, every_days, hour,
  show_panel, show_badge, show_tab, mavi_context, notify_inbox, notify_min_priority, notify_who, money_basis,
  monthly_cap_usd, run_cap_usd, min_interval_minutes, min_new_days, google_daily_ops, creative_images, creative_videos,
  creative_new_max, expire_days, min_results, max_insights, watch_enabled, watch_api, updated_by, updated_at)
 values (p_company, n.enabled, n.frequency, n.weekdays, n.every_days, n.hour, n.show_panel, n.show_badge, n.show_tab,
  n.mavi_context, n.notify_inbox, n.notify_min_priority, n.notify_who, n.money_basis, n.monthly_cap_usd,
  n.run_cap_usd, n.min_interval_minutes, n.min_new_days, n.google_daily_ops, n.creative_images, n.creative_videos,
  n.creative_new_max, n.expire_days, n.min_results, n.max_insights, n.watch_enabled, n.watch_api, auth.uid(), now())
 on conflict (company_id) do update set enabled = excluded.enabled, frequency = excluded.frequency,
  weekdays = excluded.weekdays, every_days = excluded.every_days, hour = excluded.hour,
  show_panel = excluded.show_panel, show_badge = excluded.show_badge, show_tab = excluded.show_tab,
  mavi_context = excluded.mavi_context, notify_inbox = excluded.notify_inbox,
  notify_min_priority = excluded.notify_min_priority, notify_who = excluded.notify_who,
  money_basis = excluded.money_basis, monthly_cap_usd = excluded.monthly_cap_usd,
  run_cap_usd = excluded.run_cap_usd, min_interval_minutes = excluded.min_interval_minutes,
  min_new_days = excluded.min_new_days, google_daily_ops = excluded.google_daily_ops,
  creative_images = excluded.creative_images, creative_videos = excluded.creative_videos,
  creative_new_max = excluded.creative_new_max, expire_days = excluded.expire_days,
  min_results = excluded.min_results, max_insights = excluded.max_insights,
  watch_enabled = excluded.watch_enabled, watch_api = excluded.watch_api,
  -- Teto mudou: avisa de novo se for atingido.
  cap_noticed_month = case when excluded.monthly_cap_usd is distinct from x.monthly_cap_usd then null
   else x.cap_noticed_month end,
  updated_by = excluded.updated_by, updated_at = excluded.updated_at;
 return mavi_private.campaign_insight_settings_json(p_company);
end $$;

-- ------------------------------------------------------------ os avisos da vigia
-- Sem análise: run_id e last_seen_run ficam nulos; a origem é 'watch'.
-- 'resolved': a vigia viu a situação passar (sai da tela, fica no histórico).
alter table public.campaign_insights alter column run_id drop not null;
alter table public.campaign_insights alter column last_seen_run drop not null;
alter table public.campaign_insights drop constraint campaign_insights_source_check;
alter table public.campaign_insights add constraint campaign_insights_source_check
 check (source in ('rule', 'mavi', 'watch'));
alter table public.campaign_insights drop constraint campaign_insights_status_check;
alter table public.campaign_insights add constraint campaign_insights_status_check
 check (status in ('new', 'applied', 'dismissed', 'snoozed', 'expired', 'resolved'));
alter table public.campaign_insight_events drop constraint campaign_insight_events_action_check;
alter table public.campaign_insight_events add constraint campaign_insight_events_action_check
 check (action in ('applied', 'dismissed', 'snoozed', 'reopened', 'returned', 'task', 'expired', 'resolved'));
create index campaign_insights_watch on public.campaign_insights(company_id, campaign_id)
 where source = 'watch' and status = 'new';

-- Grava os avisos de um grupo da vigia ('dia': os números do dia; 'api': a
-- leitura das plataformas e do CRM): confirma os que já estão abertos, cria
-- os novos (respeitando descartados, aplicados, expirados e adiados, como as
-- análises), resolve os do mesmo grupo que não valem mais e avisa os
-- responsáveis (ou as equipes) dos novos. Nulo em p_items: a leitura não
-- aconteceu (nada muda).
create function mavi_private.campaign_watch_apply(p_company uuid, p_campaign uuid, p_group text, p_items jsonb)
returns integer
language plpgsql security definer set search_path = '' as $$
declare s public.campaign_insight_settings; x jsonb; v_old uuid; v_new integer := 0; v_notify integer := 0;
 v_first text; v_prints text[] := '{}'; v_client uuid; v_name text; v_owners boolean; a record; begin
 if p_items is null or jsonb_typeof(p_items) <> 'array' or p_group not in ('dia', 'api') then return 0; end if;
 s := mavi_private.campaign_insight_config(p_company);
 select k.client_id, c.name into v_client, v_name from public.ad_campaigns c
 join public.contracts k on k.company_id = c.company_id and k.id = c.contract_id
 where c.company_id = p_company and c.id = p_campaign;
 if v_name is null then return 0; end if;
 for x in select * from jsonb_array_elements(p_items) loop
  continue when x->>'kind' not in ('highlight', 'opportunity', 'problem', 'tracking')
   or x->>'priority' not in ('high', 'medium', 'low') or length(btrim(coalesce(x->>'title', ''))) < 3
   or jsonb_typeof(x->'evidence') <> 'array' or jsonb_array_length(x->'evidence') not between 1 and 8
   or coalesce(x->>'fingerprint', '') not like '%#vigia-' || p_group || '-%';
  v_prints := v_prints || left(x->>'fingerprint', 300);
  continue when exists (select 1 from public.campaign_insights i where i.company_id = p_company
   and i.campaign_id = p_campaign and i.fingerprint = left(x->>'fingerprint', 300)
   and ((i.status = 'dismissed' and i.status_at > now() - interval '60 days')
    or (i.status = 'applied' and i.applied_at > now() - interval '30 days')
    or (i.status = 'expired' and i.status_at > now() - interval '30 days')
    or i.status = 'snoozed'));
  select i.id into v_old from public.campaign_insights i where i.company_id = p_company
   and i.campaign_id = p_campaign and i.status = 'new' and i.fingerprint = left(x->>'fingerprint', 300)
  order by i.last_seen_at desc limit 1;
  if v_old is not null then
   update public.campaign_insights set last_seen_at = now(), seen_count = seen_count + 1, kind = x->>'kind',
    priority = x->>'priority', title = left(btrim(x->>'title'), 200), body = left(coalesce(x->>'body', ''), 2000),
    action = left(coalesce(x->>'action', ''), 800), evidence = x->'evidence', money_basis = s.money_basis
   where id = v_old;
  else
   insert into public.campaign_insights(company_id, campaign_id, run_id, last_seen_run, kind, priority, title, body,
    action, evidence, target, source, fingerprint, money_basis)
   values (p_company, p_campaign, null, null, x->>'kind', x->>'priority', left(btrim(x->>'title'), 200),
    left(coalesce(x->>'body', ''), 2000), left(coalesce(x->>'action', ''), 800), x->'evidence',
    case when jsonb_typeof(x->'target') = 'object' then x->'target' end, 'watch', left(x->>'fingerprint', 300),
    s.money_basis);
   v_new := v_new + 1;
   if mavi_private.campaign_insight_rank(x->>'priority') >= mavi_private.campaign_insight_rank(s.notify_min_priority)
   then
    v_notify := v_notify + 1;
    v_first := coalesce(v_first, left(btrim(x->>'title'), 200));
   end if;
  end if;
 end loop;
 -- Os do grupo que não apareceram de novo: a situação passou.
 for a in
  update public.campaign_insights i set status = 'resolved', status_at = now(), status_by = null
  where i.company_id = p_company and i.campaign_id = p_campaign and i.source = 'watch' and i.status = 'new'
   and i.fingerprint like '%#vigia-' || p_group || '-%' and i.fingerprint <> all(v_prints)
  returning i.id
 loop
  insert into public.campaign_insight_events(company_id, insight_id, user_id, action)
  values (p_company, a.id, null, 'resolved');
 end loop;
 if v_notify > 0 and s.notify_inbox then
  v_owners := exists (select 1 from public.ad_campaign_owners o join public.memberships mm
   on mm.company_id = o.company_id and mm.user_id = o.user_id and mm.active
   where o.company_id = p_company and o.campaign_id = p_campaign);
  insert into public.notifications(company_id, user_id, actor_id, task_id, kind, title, body, link, client_id)
  select p_company, m.user_id, null, null, 'campaign_insight', left(format('Vigia da MAVI: %s', v_name), 300),
   left(case when v_notify = 1 then v_first else format('%s · e mais %s', v_first, v_notify - 1) end, 300),
   '/campanhas/' || p_campaign || '?aba=insights', v_client
  from public.memberships m
  where m.company_id = p_company and m.active
   and mavi_private.campaign_alert_sees(p_company, m.user_id, v_client)
   and (exists (select 1 from public.ad_campaign_owners o where o.company_id = p_company
      and o.campaign_id = p_campaign and o.user_id = m.user_id)
    or ((s.notify_who <> 'owners' or not v_owners) and exists (select 1 from public.client_teams ct
      join public.team_members tm on tm.company_id = ct.company_id and tm.team_id = ct.team_id
     where ct.company_id = p_company and ct.client_id = v_client and tm.user_id = m.user_id))
    or (s.notify_who = 'team_leaders' and m.role in ('admin', 'manager')));
 end if;
 perform mavi_private.broadcast(p_company, jsonb_build_object('kind', 'campaign_insights', 'campaign', p_campaign,
  'watch', p_group));
 return v_new;
end $$;
revoke all on function mavi_private.campaign_watch_apply(uuid, uuid, text, jsonb) from public, anon, authenticated;

-- Uma evidência da vigia (o valor já na base de dinheiro da empresa).
create function mavi_private.campaign_watch_ev(p_label text, p_value numeric, p_unit text, p_window text,
 p_name text, p_metric text) returns jsonb
language sql immutable set search_path = '' as $$
 select jsonb_build_object('label', p_label, 'value', round(coalesce(p_value, 0), 2), 'unit', p_unit,
  'window', p_window, 'entity', 'total', 'name', p_name, 'metric', p_metric)
$$;
create function mavi_private.campaign_watch_brl(v numeric) returns text
language sql immutable set search_path = '' as $$
 select 'R$ ' || replace(replace(replace(to_char(round(coalesce(v, 0), 2), 'FM999G999G990D00'), ',', '#'), '.', ','),
  '#', '.')
$$;

-- As checagens pelos números do dia (Dia a Dia, sincronizado de manhã até
-- ontem): sem API e sem a MAVI.
--  - gasto disparou: ontem ≥ 2× a média dos 7 dias antes (e R$ 30 a mais),
--    sem os resultados acompanharem;
--  - conversões pararam: 2 dias com investimento e zero conversões, quando
--    os 7 dias antes tinham ao menos 1 por dia;
--  - custo por resultado dobrou: os 2 últimos dias a 1,8× o dos 7 antes
--    (com 5+ resultados antes; não junto com o gasto disparado);
--  - parou de gastar: ontem zerado depois de 3 dias gastando, no ciclo.
create function mavi_private.campaign_watch_metrics(p_company uuid, p_campaign uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare s public.campaign_insight_settings; c public.ad_campaigns; y public.ad_cycles; v_y date; v_name text;
 v_out jsonb := '[]'; v_gross boolean;
 y_n integer; y_spend numeric; y_conv numeric;
 p_n integer; p_spend numeric; p_conv numeric; p_days_spend integer;
 d2_n integer; d2_spend numeric; d2_conv numeric; d2_days_spend integer;
 b_n integer; b_spend numeric; b_conv numeric;
 l3_n integer; v_spike boolean := false; begin
 s := mavi_private.campaign_insight_config(p_company);
 select * into c from public.ad_campaigns where company_id = p_company and id = p_campaign;
 if c.id is null or c.status <> 'active' or c.archived or c.current_cycle_id is null then return '[]'; end if;
 select * into y from public.ad_cycles where company_id = p_company and id = c.current_cycle_id;
 v_y := mavi_private.company_today(p_company) - 1;
 if y.id is null or v_y < y.start_date or v_y > y.end_date then return '[]'; end if;
 v_name := c.name;
 v_gross := s.money_basis = 'gross';
 -- O dinheiro na base da empresa; dias de outros ciclos da campanha também contam na comparação.
 select count(*), sum(d.spend * case when v_gross then d.multiplier else 1 end), sum(d.conversions)
  into y_n, y_spend, y_conv
 from public.ad_daily_metrics d where d.company_id = p_company and d.campaign_id = p_campaign and d.day = v_y;
 if y_n = 0 then return '[]'; end if;
 select count(*), sum(d.spend * case when v_gross then d.multiplier else 1 end), sum(d.conversions),
  count(*) filter (where d.spend > 0)
  into p_n, p_spend, p_conv, p_days_spend
 from public.ad_daily_metrics d where d.company_id = p_company and d.campaign_id = p_campaign
  and d.day between v_y - 7 and v_y - 1;
 select count(*), sum(d.spend * case when v_gross then d.multiplier else 1 end), sum(d.conversions),
  count(*) filter (where d.spend > 0)
  into d2_n, d2_spend, d2_conv, d2_days_spend
 from public.ad_daily_metrics d where d.company_id = p_company and d.campaign_id = p_campaign
  and d.day between v_y - 1 and v_y;
 select count(*), sum(d.spend * case when v_gross then d.multiplier else 1 end), sum(d.conversions)
  into b_n, b_spend, b_conv
 from public.ad_daily_metrics d where d.company_id = p_company and d.campaign_id = p_campaign
  and d.day between v_y - 8 and v_y - 2;
 select count(*) into l3_n from public.ad_daily_metrics d where d.company_id = p_company
  and d.campaign_id = p_campaign and d.day between v_y - 3 and v_y - 1 and d.spend > 0;

 -- Parou de gastar.
 if coalesce(y_spend, 0) = 0 and l3_n = 3 then
  v_out := v_out || jsonb_build_array(jsonb_build_object('kind', 'problem', 'priority', 'high',
   'title', 'A campanha parou de gastar ontem',
   'body', format('Ontem a campanha não investiu nada, depois de gastar em média %s por dia na semana anterior. '
    || 'Sem entrega, ela não traz resultados — e o ciclo ainda está rodando.',
    mavi_private.campaign_watch_brl(p_spend / greatest(p_n, 1))),
   'action', E'Confira no Gerenciador se há anúncios reprovados ou a conta com problema de pagamento\n'
    || E'Veja se a campanha ou os conjuntos foram pausados ou chegaram ao fim da programação\n'
    || 'Se foi de propósito, ignore este aviso',
   'evidence', jsonb_build_array(
    mavi_private.campaign_watch_ev('Investimento', 0, 'money', 'yesterday', v_name, 'spend'),
    mavi_private.campaign_watch_ev('Investimento médio por dia', p_spend / greatest(p_n, 1), 'money', 'prev7', v_name,
     'spend_avg')),
   'fingerprint', 'problem#total#vigia-dia-parou-de-gastar'));
 end if;

 -- Gasto disparou (sem os resultados acompanharem).
 if p_n >= 5 and p_days_spend >= 3 and coalesce(p_spend, 0) > 0
  and y_spend >= 2 * (p_spend / p_n) and y_spend - p_spend / p_n >= 30
  and coalesce(y_conv, 0) <= 1.3 * coalesce(p_conv, 0) / p_n then
  v_out := v_out || jsonb_build_array(jsonb_build_object('kind', 'problem', 'priority', 'high',
   'title', 'O gasto de ontem foi o dobro do normal',
   'body', format('Ontem a campanha investiu %s, contra a média de %s por dia na semana anterior, e os resultados '
    || 'não acompanharam. Pode ser uma verba alterada, uma regra automática ou o leilão mais caro.',
    mavi_private.campaign_watch_brl(y_spend), mavi_private.campaign_watch_brl(p_spend / p_n)),
   'action', E'Confira no Gerenciador se alguém mudou a verba ou criou uma regra automática\n'
    || E'Se não foi de propósito, volte a verba ao valor normal\n'
    || 'Acompanhe o dia de hoje antes de mexer em mais nada',
   'evidence', jsonb_build_array(
    mavi_private.campaign_watch_ev('Investimento', y_spend, 'money', 'yesterday', v_name, 'spend'),
    mavi_private.campaign_watch_ev('Investimento médio por dia', p_spend / p_n, 'money', 'prev7', v_name, 'spend_avg'),
    mavi_private.campaign_watch_ev('Resultados', coalesce(y_conv, 0), 'count', 'yesterday', v_name, 'results')),
   'fingerprint', 'problem#total#vigia-dia-gasto-disparou'));
  v_spike := true;
 end if;

 -- Conversões pararam (possível rastreio quebrado).
 if d2_n = 2 and d2_days_spend = 2 and coalesce(d2_conv, 0) = 0 and b_n >= 5 and coalesce(b_conv, 0) >= b_n then
  v_out := v_out || jsonb_build_array(jsonb_build_object('kind', 'tracking', 'priority', 'high',
   'title', 'As conversões pararam de chegar há 2 dias',
   'body', format('Nos últimos 2 dias a campanha investiu %s e não registrou nenhuma conversão, mas na semana anterior '
    || 'registrava em média %s por dia. Quando isso acontece de repente, o mais comum é o pixel, a tag ou o formulário '
    || 'ter parado de funcionar.', mavi_private.campaign_watch_brl(d2_spend),
    replace(to_char(round(b_conv / b_n, 1), 'FM999990D0'), '.', ',')),
   'action', E'Faça um cadastro de teste pelo anúncio e veja se a conversão aparece na plataforma\n'
    || E'Confira se a página ou o formulário mudou nos últimos dias\n'
    || 'Se o teste não registrar, chame quem cuida do pixel/tag antes de mexer na campanha',
   'evidence', jsonb_build_array(
    mavi_private.campaign_watch_ev('Conversões', 0, 'count', 'd2', v_name, 'results'),
    mavi_private.campaign_watch_ev('Investimento', d2_spend, 'money', 'd2', v_name, 'spend'),
    mavi_private.campaign_watch_ev('Conversões por dia', b_conv / b_n, 'ratio', 'prev7', v_name, 'results_avg')),
   'fingerprint', 'tracking#total#vigia-dia-conversoes-pararam'));
 -- Custo por resultado dobrou.
 -- (com o gasto disparado, o custo sobe junto: um aviso só)
 elsif not v_spike and d2_n = 2 and coalesce(d2_conv, 0) > 0 and b_n >= 5 and coalesce(b_conv, 0) >= 5 and coalesce(b_spend, 0) > 0
  and (d2_spend / d2_conv) >= 1.8 * (b_spend / b_conv) and d2_spend >= 0.5 * 2 * (b_spend / b_n) then
  v_out := v_out || jsonb_build_array(jsonb_build_object('kind', 'problem', 'priority', 'medium',
   'title', 'O custo por resultado quase dobrou nos últimos 2 dias',
   'body', format('Nos últimos 2 dias cada resultado custou %s, contra %s na semana anterior. Pode ser cansaço do '
    || 'anúncio, um conjunto novo caro ou mudança no leilão.',
    mavi_private.campaign_watch_brl(d2_spend / d2_conv), mavi_private.campaign_watch_brl(b_spend / b_conv)),
   'action', E'Veja no Gerenciador qual conjunto ou anúncio puxou o custo para cima\n'
    || E'Se foi um item novo, dê mais 2 ou 3 dias antes de pausar\n'
    || 'Se foi um item antigo, troque o criativo ou tire verba dele',
   'evidence', jsonb_build_array(
    mavi_private.campaign_watch_ev('Custo por resultado', d2_spend / d2_conv, 'money', 'd2', v_name, 'cpa'),
    mavi_private.campaign_watch_ev('Custo por resultado', b_spend / b_conv, 'money', 'prev7', v_name, 'cpa'),
    mavi_private.campaign_watch_ev('Resultados', d2_conv, 'count', 'd2', v_name, 'results')),
   'fingerprint', 'problem#total#vigia-dia-custo-dobrou'));
 end if;
 return v_out;
end $$;
revoke all on function mavi_private.campaign_watch_metrics(uuid, uuid) from public, anon, authenticated;

-- ------------------------------------------------------------ a leitura das plataformas (uma por dia)
create table mavi_private.campaign_watch_queue (
 company_id uuid not null,
 campaign_id uuid not null,
 day date not null,
 status text not null default 'queued' check (status in ('queued', 'running', 'done', 'failed')),
 attempts smallint not null default 0,
 claimed_until timestamptz,
 note text not null default '',
 created_at timestamptz not null default now(),
 finished_at timestamptz,
 primary key (company_id, campaign_id, day)
);
create index campaign_watch_queue_due on mavi_private.campaign_watch_queue(status, claimed_until)
 where status in ('queued', 'running');

-- Depois de cada sincronização boa do ciclo atual: os números do dia e a
-- leitura das plataformas na fila (uma por campanha por dia).
create function mavi_private.campaign_watch_after_sync() returns trigger
language plpgsql security definer set search_path = '' as $$
declare s public.campaign_insight_settings; c public.ad_campaigns; begin
 s := mavi_private.campaign_insight_config(new.company_id);
 if not s.enabled or not s.watch_enabled then return null; end if;
 select * into c from public.ad_campaigns where company_id = new.company_id and id = new.campaign_id;
 if c.id is null or c.current_cycle_id is distinct from new.cycle_id or c.status <> 'active' then return null; end if;
 begin
  perform mavi_private.campaign_watch_apply(new.company_id, new.campaign_id, 'dia',
   mavi_private.campaign_watch_metrics(new.company_id, new.campaign_id));
  if s.watch_api and c.platform in ('meta', 'google')
   and exists (select 1 from public.ad_cycle_links l where l.company_id = c.company_id and l.cycle_id = c.current_cycle_id)
  then
   insert into mavi_private.campaign_watch_queue(company_id, campaign_id, day)
   values (new.company_id, new.campaign_id, mavi_private.company_today(new.company_id))
   on conflict do nothing;
  end if;
 exception when others then
  raise warning 'campaign watch failed: %', sqlerrm;
 end;
 return null;
end $$;
create trigger campaign_watch_after_sync after insert on public.ad_sync_runs
 for each row when (new.status = 'ok') execute function mavi_private.campaign_watch_after_sync();

-- A da migração 20270329090000, que também acorda o worker para a vigia.
create or replace function mavi_private.campaign_insight_kick() returns void
language plpgsql security definer set search_path = '' as $$ begin
 begin
  perform mavi_private.campaign_insight_tick();
 exception when others then
  raise warning 'campaign insights tick failed: %', sqlerrm;
 end;
 if exists (select 1 from public.campaign_insight_runs r where r.status in ('queued', 'running')
  and coalesce(r.claimed_until, '-infinity') < now() and r.attempts < 3)
  or exists (select 1 from mavi_private.campaign_insight_learning_due())
  or exists (select 1 from mavi_private.campaign_watch_queue q where q.status in ('queued', 'running')
   and coalesce(q.claimed_until, '-infinity') < now() and q.attempts < 3) then
  perform mavi_private.campaign_insight_post();
 end if;
end $$;

-- O worker pega leituras da vigia (uma conta por vez; as pausadas pela cota esperam).
create function public.ai_campaign_watch_claim(p_secret text, p_limit integer default 5) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare r record; v_accounts text[]; v_busy text[] := '{}'; v_out jsonb := '[]'; s public.campaign_insight_settings;
 c public.ad_campaigns; y public.ad_cycles; k public.contracts; v_y date; v_gross boolean;
 v_limit integer := least(greatest(coalesce(p_limit, 5), 1), 20); begin
 if not mavi_private.ai_secret_ok(p_secret) then raise exception 'Sem permissão' using errcode = '42501'; end if;
 select coalesce(array_agg(distinct a.platform || ':' || x), '{}') into v_busy
 from public.campaign_insight_runs q
 join public.ad_campaigns a on a.company_id = q.company_id and a.id = q.campaign_id,
  unnest(mavi_private.campaign_insight_accounts(q.company_id, q.campaign_id)) x
 where q.status = 'running' and q.claimed_until > now();
 for r in
  select q.company_id, q.campaign_id, q.day, a.platform from mavi_private.campaign_watch_queue q
  join public.ad_campaigns a on a.company_id = q.company_id and a.id = q.campaign_id
  where q.status in ('queued', 'running') and coalesce(q.claimed_until, '-infinity') < now() and q.attempts < 3
  order by q.created_at limit 200
  for update of q skip locked
 loop
  s := mavi_private.campaign_insight_config(r.company_id);
  if not s.enabled or not s.watch_enabled or not s.watch_api then
   update mavi_private.campaign_watch_queue set status = 'done', finished_at = now(), note = 'Vigia desligada.'
   where company_id = r.company_id and campaign_id = r.campaign_id and day = r.day;
   continue;
  end if;
  v_accounts := mavi_private.campaign_insight_accounts(r.company_id, r.campaign_id);
  continue when mavi_private.campaign_insight_paused(r.platform, v_accounts) is not null;
  continue when exists (select 1 from unnest(v_accounts) x where r.platform || ':' || x = any(v_busy));
  update mavi_private.campaign_watch_queue set status = 'running', attempts = attempts + 1,
   claimed_until = now() + interval '5 minutes'
  where company_id = r.company_id and campaign_id = r.campaign_id and day = r.day;
  v_busy := v_busy || array(select r.platform || ':' || x from unnest(v_accounts) x);
  select * into c from public.ad_campaigns where company_id = r.company_id and id = r.campaign_id;
  select * into y from public.ad_cycles where company_id = c.company_id and id = c.current_cycle_id;
  select * into k from public.contracts where company_id = c.company_id and id = c.contract_id;
  v_y := mavi_private.company_today(r.company_id) - 1;
  v_gross := s.money_basis = 'gross';
  v_out := v_out || jsonb_build_array(jsonb_build_object(
   'company_id', r.company_id, 'campaign_id', r.campaign_id, 'day', r.day,
   'campaign', jsonb_build_object('id', c.id, 'name', c.name, 'platform', c.platform),
   'money_basis', s.money_basis,
   'links', coalesce((select jsonb_agg(jsonb_build_object('account_id', l.account_id,
     'campaign_id', l.external_campaign_id, 'manager_id', l.manager_id) order by l.account_id, l.external_campaign_id)
    from public.ad_cycle_links l where l.company_id = y.company_id and l.cycle_id = y.id), '[]'),
   'meta_tokens', case when c.platform = 'meta' then (select jsonb_object_agg(m.account_id,
     jsonb_build_object('token_cipher', m.token_cipher, 'expires_at', m.token_expires_at))
    from mavi_private.ad_meta_accounts m where m.company_id = y.company_id and m.account_id in
     (select l.account_id from public.ad_cycle_links l where l.company_id = y.company_id and l.cycle_id = y.id)) end,
   'google_token', case when c.platform = 'google' then (select jsonb_build_object('refresh_token_cipher',
     g.refresh_token_cipher) from mavi_private.ad_google_connections g where g.company_id = y.company_id) end,
   'crm_company_id', (select l.crm_company_id from public.client_crm_links l
    where l.company_id = k.company_id and l.client_id = k.client_id),
   'yesterday', v_y,
   -- Os números do Dia a Dia para comparar: os 2 últimos dias e o ciclo (com a meta).
   'd2', (select jsonb_build_object('days', count(*), 'conversions', coalesce(sum(d.conversions), 0),
     'spend', coalesce(sum(d.spend * case when v_gross then d.multiplier else 1 end), 0))
    from public.ad_daily_metrics d where d.company_id = c.company_id and d.campaign_id = c.id
     and d.day between v_y - 1 and v_y),
   'cycle', (select jsonb_build_object('spend', coalesce(sum(d.spend * case when v_gross then d.multiplier else 1 end), 0),
     'conversions', coalesce(sum(d.conversions), 0),
     'goal_cpa', case when y.goal_results > 0 then round((case when v_gross then y.budget
      else y.budget / greatest(y.multiplier, 0.001) end) / y.goal_results, 2) end)
    from public.ad_daily_metrics d where d.company_id = y.company_id and d.cycle_id = y.id and d.day <= v_y)));
  exit when jsonb_array_length(v_out) >= v_limit;
 end loop;
 return v_out;
end $$;

-- O que a leitura achou (nulo em p_items: não leu; nada muda) e o fim da leitura.
create function public.ai_campaign_watch_store(p_secret text, p_company uuid, p_campaign uuid, p_day date,
 p_items jsonb, p_note text default '') returns integer
language plpgsql security definer set search_path = '' as $$
declare v integer; begin
 if not mavi_private.ai_secret_ok(p_secret) then raise exception 'Sem permissão' using errcode = '42501'; end if;
 v := mavi_private.campaign_watch_apply(p_company, p_campaign, 'api', p_items);
 update mavi_private.campaign_watch_queue set status = 'done', finished_at = now(), claimed_until = null,
  note = left(coalesce(p_note, ''), 1000)
 where company_id = p_company and campaign_id = p_campaign and day = p_day;
 return v;
end $$;

-- Falhou: volta para a fila (até 3) ou para; com p_until (limite da plataforma), espera sem gastar tentativa.
create function public.ai_campaign_watch_fail(p_secret text, p_company uuid, p_campaign uuid, p_day date,
 p_error text, p_until timestamptz default null) returns void
language plpgsql security definer set search_path = '' as $$ begin
 if not mavi_private.ai_secret_ok(p_secret) then raise exception 'Sem permissão' using errcode = '42501'; end if;
 update mavi_private.campaign_watch_queue q set
  status = case when p_until is null and q.attempts >= 3 then 'failed' else 'queued' end,
  attempts = case when p_until is null then q.attempts else greatest(q.attempts - 1, 0) end,
  claimed_until = coalesce(p_until, now() + make_interval(mins => 10 * q.attempts)),
  finished_at = case when p_until is null and q.attempts >= 3 then now() end,
  note = left(coalesce(p_error, ''), 1000)
 where q.company_id = p_company and q.campaign_id = p_campaign and q.day = p_day and q.status = 'running';
end $$;
revoke all on function public.ai_campaign_watch_claim(text, integer),
 public.ai_campaign_watch_store(text, uuid, uuid, date, jsonb, text),
 public.ai_campaign_watch_fail(text, uuid, uuid, date, text, timestamptz) from public;
grant execute on function public.ai_campaign_watch_claim(text, integer),
 public.ai_campaign_watch_store(text, uuid, uuid, date, jsonb, text),
 public.ai_campaign_watch_fail(text, uuid, uuid, date, text, timestamptz) to anon, authenticated;

-- ------------------------------------------------------------ a tela
-- A da migração 20270402150000, com os avisos da vigia entre os abertos.
create or replace function public.campaign_insights(p_company uuid, p_campaign uuid, p_runs integer default 8) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare s public.campaign_insight_settings; v_client uuid; v_last public.campaign_insight_runs; v_latest uuid; v_wait timestamptz;
begin
 if not mavi_private.campaign_insight_reader(p_company, p_campaign) then
  raise exception 'Sem permissão' using errcode = '42501';
 end if;
 s := mavi_private.campaign_insight_config(p_company);
 v_client := mavi_private.ad_campaign_client(p_campaign);
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
  'expire_days', s.expire_days,
  'watch', s.enabled and s.watch_enabled,
  -- Quem responde pela campanha (recebe os avisos dos insights).
  'owners', mavi_private.campaign_owners_json(p_company, p_campaign),
  'can_set_owners', mavi_private.ad_can_write(p_company),
  -- A etapa do CRM que importa nesta campanha e a meta de custo por lead nela.
  'crm_goal', mavi_private.campaign_crm_goal_json(p_company, p_campaign),
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
  -- Abertos: os da última análise e os que voltaram do "Lembrar depois".
  -- Na ordem da análise (o primeiro é o "Comece por aqui"); os que voltaram
  -- do "Lembrar depois" vêm depois.
  -- Os avisos da vigia diária (abertos até se resolverem) vêm primeiro.
  'current', coalesce((select jsonb_agg(mavi_private.campaign_insight_json(i)
    order by case when i.source = 'watch' then 0 when i.last_seen_run = v_latest then 1 else 2 end,
     mavi_private.campaign_insight_rank(i.priority) * (i.source = 'watch')::int desc, i.rank nulls last,
     mavi_private.campaign_insight_rank(i.priority) desc, i.created_at)
   from public.campaign_insights i where i.company_id = p_company and i.campaign_id = p_campaign
    and i.status = 'new' and (i.last_seen_run = v_latest or i.snooze_until is not null or i.source = 'watch')), '[]'),
  'applied', coalesce((select jsonb_agg(mavi_private.campaign_insight_json(i) order by i.applied_at desc)
   from (select * from public.campaign_insights i where i.company_id = p_company and i.campaign_id = p_campaign
    and i.status = 'applied' order by i.applied_at desc limit 30) i), '[]'),
  'snoozed', coalesce((select jsonb_agg(mavi_private.campaign_insight_json(i) order by i.snooze_until)
   from public.campaign_insights i where i.company_id = p_company and i.campaign_id = p_campaign
    and i.status = 'snoozed'), '[]'),
  'dismissed', coalesce((select jsonb_agg(mavi_private.campaign_insight_json(i) order by i.status_at desc)
   from (select * from public.campaign_insights i where i.company_id = p_company and i.campaign_id = p_campaign
    and i.status = 'dismissed' and i.status_at > now() - interval '90 days' order by i.status_at desc limit 30) i), '[]'),
  'runs', coalesce((select jsonb_agg(x.j order by x.created_at desc) from (
   select r.created_at, jsonb_build_object('id', r.id, 'trigger', r.trigger, 'status', r.status,
    'requested_by_name', (select m.name from public.memberships m where m.company_id = r.company_id
     and m.user_id = r.requested_by),
    'created_at', r.created_at, 'started_at', r.started_at, 'finished_at', r.finished_at,
    'cost_usd', r.cost_usd, 'model', r.model, 'provider_name', r.provider_name, 'summary', r.summary,
    'note', r.note, 'money_basis', r.money_basis, 'multiplier', r.multiplier, 'windows', r.windows,
    'insights_count', r.insights_count, 'repeated_count', r.repeated_count,
    'api_calls', r.api_calls, 'tokens', r.tokens,
    -- Os que expiraram sem uso saem da tela: no histórico, só a contagem.
    'expired_count', (select count(*)::int from public.campaign_insights i where i.run_id = r.id and i.status = 'expired'),
    'insights', coalesce((select jsonb_agg(mavi_private.campaign_insight_json(i)
      order by i.rank nulls last, mavi_private.campaign_insight_rank(i.priority) desc, i.created_at)
     from public.campaign_insights i where i.run_id = r.id and i.status <> 'expired'), '[]')) as j
   from public.campaign_insight_runs r where r.company_id = p_company and r.campaign_id = p_campaign
   order by r.created_at desc limit least(greatest(coalesce(p_runs, 8), 1), 50)) x), '[]'));
end $$;

commit;
