begin;

-- Campanhas › Meus avisos (pedido de 01/10/2026).
--
-- Cada pessoa que usa Campanhas (líder, ou colaborador com o módulo ligado)
-- monta as próprias regras de aviso sobre os números do Dia a Dia: de uma
-- campanha, ou de todas (com filtros de cliente, produto, plataforma,
-- objetivo e equipe). Só pessoal: ninguém cria aviso para outra pessoa.
--
-- - A regra: métrica (consumo, conversões, custo por resultado, CTR, CPC,
--   CPM, impressões, cliques, alcance, frequência — por dia — ou mídia
--   restante, orçamento diário, ritmo de gasto, ritmo de resultados e custo ×
--   meta — do ciclo atual), condição (chegar a/passar de, ficar em/abaixo
--   de, igual por N dias, zerada por N dias, subir ou cair X% em relação aos
--   N dias anteriores), janela (o último dia, os últimos N dias ou o ciclo),
--   dinheiro com ou sem M, repetição (uma vez e rearma quando deixa de valer,
--   todo dia enquanto valer, ou a cada N dias) e entrega (na hora — caixa de
--   entrada e push — ou no resumo do dia, às 11h de Brasília).
-- - Quando confere: logo depois de cada sincronização boa do ciclo atual de
--   uma campanha (gatilho em ad_sync_runs). Os números chegam uma vez por
--   dia, de manhã, até ontem: os dias contados são sempre dias fechados, e
--   um dia sem número gravado (sincronização que falhou) não conta como
--   zerado. Sem consulta periódica: o resumo é um agendamento por dia.
-- - Quem recebe: o dono da regra, enquanto ele enxergar a campanha (a regra
--   do módulo) e o aviso "Meus avisos de campanhas" estiver ligado nas
--   preferências de notificação.
-- - A MAVI monta a regra (na conversa, com cartão de confirmação; e no campo
--   "Descreva o aviso" da tela, funcionalidade 'campaign_alerts' em Quem usa
--   qual modelo). Quem grava é sempre save_campaign_alert_rule.

-- ------------------------------------------------------------ avisos
alter table public.notifications drop constraint notifications_kind_check;
alter table public.notifications add constraint notifications_kind_check
 check (kind in ('mention', 'assigned', 'reply', 'social_leads', 'ai_share', 'success_case', 'notice',
  'notice_animation', 'temperature', 'tasks_assigned', 'due_risk', 'status', 'review', 'ai_skill', 'ai_answer',
  'radar_report', 'radar_alert', 'media_balance', 'priority', 'tasks_priority', 'copilot_lessons', 'mavi_lessons',
  'campaign_alert'));
alter table public.notifications drop constraint notifications_target_check;
alter table public.notifications add constraint notifications_target_check
 check ((kind in ('social_leads', 'ai_share', 'success_case', 'notice', 'notice_animation', 'temperature',
   'tasks_assigned', 'due_risk', 'ai_skill', 'ai_answer', 'radar_report', 'radar_alert', 'media_balance',
   'tasks_priority', 'copilot_lessons', 'mavi_lessons', 'campaign_alert')) = (task_id is null)
  and (task_id is not null or (title is not null and link is not null))
  and ((kind = 'notice') = (notice_id is not null)));

-- A da migração 20270130090000, com os avisos das campanhas.
create or replace function mavi_private.notification_pref_keys() returns text[]
language sql immutable set search_path = '' as $$
 select array['assigned', 'mention', 'reply', 'review', 'due_risk',
  'social_leads', 'ai_share', 'success_case', 'temperature', 'ai_skill', 'ai_answer', 'radar_report', 'radar_alert',
  'media_balance', 'priority', 'campaign_alert']
  || array(select 'status.' || s || '.' || r
   from unnest(array['progress', 'returned', 'review', 'rejected', 'correction', 'done']) s,
        unnest(array['creator', 'assignee', 'participant']) r)
$$;

-- ------------------------------------------------------------ tabelas
create table public.campaign_alert_rules (
 id uuid primary key default gen_random_uuid(),
 company_id uuid not null references public.companies(id),
 user_id uuid not null,
 name text not null check (length(btrim(name)) between 2 and 120),
 -- Uma campanha; nula: todas as ativas que passam pelos filtros (vazio: qualquer).
 campaign_id uuid,
 client_ids uuid[] not null default '{}' check (cardinality(client_ids) <= 50),
 product_ids uuid[] not null default '{}' check (cardinality(product_ids) <= 50),
 platforms text[] not null default '{}' check (platforms <@ array['meta', 'google', 'linkedin', 'tiktok', 'kwai']),
 objectives text[] not null default '{}'
  check (objectives <@ array['lead', 'sale', 'message', 'traffic', 'engagement', 'custom', 'video']),
 team_ids uuid[] not null default '{}' check (cardinality(team_ids) <= 50),
 metric text not null check (metric in ('spend', 'conversions', 'cpa', 'ctr', 'cpc', 'cpm', 'impressions', 'clicks',
  'reach', 'frequency', 'media_left', 'daily_budget', 'spend_pace', 'results_pace', 'cost_vs_goal')),
 -- above: chegar a ou passar de; below: ficar em ou abaixo de; unchanged: igual
 -- por N dias; zero: zerada por N dias; rise/drop: subir/cair X% (N dias × N anteriores).
 condition text not null check (condition in ('above', 'below', 'unchanged', 'zero', 'rise', 'drop')),
 -- day: o último dia fechado; days: os últimos N dias; cycle: o ciclo atual até ontem.
 period text not null default 'day' check (period in ('day', 'days', 'cycle')),
 days smallint not null default 1 check (days between 1 and 30),
 -- O limite (na unidade da métrica) ou o % de subida/queda.
 value numeric(14,2) check (value >= 0),
 -- "Igual": a diferença tolerada entre os dias (% do maior).
 tolerance numeric(5,2) not null default 0 check (tolerance between 0 and 50),
 with_m boolean not null default false,
 -- once: uma vez, e de novo só depois de deixar de valer; daily: todo dia
 -- enquanto valer; every: a cada repeat_days dias enquanto valer.
 repeat text not null default 'once' check (repeat in ('once', 'daily', 'every')),
 repeat_days smallint not null default 3 check (repeat_days between 2 and 30),
 -- now: na hora (caixa de entrada e push); digest: no resumo do dia.
 channel text not null default 'now' check (channel in ('now', 'digest')),
 active boolean not null default true,
 -- Quem montou: a tela ou a MAVI (confirmada pela pessoa).
 origin text not null default 'screen' check (origin in ('screen', 'mavi')),
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 check (campaign_id is null or (client_ids = '{}' and product_ids = '{}' and platforms = '{}' and objectives = '{}'
  and team_ids = '{}')),
 foreign key (company_id, user_id) references public.memberships(company_id, user_id) on delete cascade,
 foreign key (company_id, campaign_id) references public.ad_campaigns(company_id, id) on delete cascade
);
create index campaign_alert_rules_company on public.campaign_alert_rules (company_id) where active;
create index campaign_alert_rules_user on public.campaign_alert_rules (company_id, user_id);
alter table public.campaign_alert_rules enable row level security;
revoke all on public.campaign_alert_rules from public, anon, authenticated;

-- Se a regra valia na última conferência de cada campanha e quando avisou.
create table mavi_private.campaign_alert_state (
 rule_id uuid not null references public.campaign_alert_rules(id) on delete cascade,
 campaign_id uuid not null,
 met boolean not null,
 fired_on date,
 checked_on date not null,
 primary key (rule_id, campaign_id)
);
revoke all on mavi_private.campaign_alert_state from public, anon, authenticated;

-- Cada disparo (o histórico da tela e o que espera o resumo do dia).
create table public.campaign_alert_hits (
 id bigint generated always as identity primary key,
 company_id uuid not null,
 rule_id uuid not null references public.campaign_alert_rules(id) on delete cascade,
 user_id uuid not null,
 campaign_id uuid not null,
 day date not null,
 value numeric,
 detail text not null,
 channel text not null check (channel in ('now', 'digest')),
 digested_at timestamptz,
 created_at timestamptz not null default now()
);
create index campaign_alert_hits_user on public.campaign_alert_hits (company_id, user_id, created_at desc);
create index campaign_alert_hits_rule on public.campaign_alert_hits (rule_id, created_at desc);
create index campaign_alert_hits_digest on public.campaign_alert_hits (company_id, user_id)
 where channel = 'digest' and digested_at is null;
alter table public.campaign_alert_hits enable row level security;
revoke all on public.campaign_alert_hits from public, anon, authenticated;

-- ------------------------------------------------------------ métricas
create function mavi_private.campaign_alert_label(p_metric text) returns text
language sql immutable set search_path = '' as $$
 select case p_metric when 'spend' then 'Consumo' when 'conversions' then 'Conversões'
  when 'cpa' then 'Custo por resultado' when 'ctr' then 'CTR' when 'cpc' then 'CPC' when 'cpm' then 'CPM'
  when 'impressions' then 'Impressões' when 'clicks' then 'Cliques' when 'reach' then 'Alcance'
  when 'frequency' then 'Frequência' when 'media_left' then 'Mídia restante'
  when 'daily_budget' then 'Orçamento diário' when 'spend_pace' then 'Ritmo de gasto'
  when 'results_pace' then 'Ritmo de resultados' when 'cost_vs_goal' then 'Custo × meta' else p_metric end
$$;

-- Do ciclo atual (não somam dias): só "chegar a" e "ficar abaixo de".
create function mavi_private.campaign_alert_cycle_metric(p_metric text) returns boolean
language sql immutable set search_path = '' as $$
 select p_metric in ('media_left', 'daily_budget', 'spend_pace', 'results_pace', 'cost_vs_goal')
$$;

create function mavi_private.campaign_alert_num(v numeric) returns text
language sql immutable set search_path = '' as $$
 select translate(case when round(v, 2) = trunc(v) then to_char(trunc(v), 'FM999,999,999,990')
  else to_char(round(v, 2), 'FM999,999,999,990.00') end, ',.', '.,')
$$;

create function mavi_private.campaign_alert_fmt(p_metric text, v numeric) returns text
language sql immutable set search_path = '' as $$
 select case when v is null then '—'
  when p_metric in ('spend', 'cpa', 'cpc', 'cpm', 'media_left', 'daily_budget') then mavi_private.brl(v)
  when p_metric in ('ctr', 'spend_pace', 'results_pace', 'cost_vs_goal') then mavi_private.campaign_alert_num(v) || '%'
  else mavi_private.campaign_alert_num(v) end
$$;

-- Uma métrica de dia a partir das somas (nula quando a conta não fecha).
create function mavi_private.campaign_alert_value(p_metric text, p_with_m boolean, p_spend numeric, p_gross numeric,
 p_imp numeric, p_reach numeric, p_clicks numeric, p_conv numeric) returns numeric
language sql immutable set search_path = '' as $$
 select case p_metric
  when 'spend' then case when p_with_m then p_gross else p_spend end
  when 'conversions' then p_conv
  when 'impressions' then p_imp
  when 'clicks' then p_clicks
  when 'reach' then p_reach
  when 'cpa' then case when p_conv > 0 then case when p_with_m then p_gross else p_spend end / p_conv end
  when 'cpc' then case when p_clicks > 0 then case when p_with_m then p_gross else p_spend end / p_clicks end
  when 'cpm' then case when p_imp > 0 then case when p_with_m then p_gross else p_spend end * 1000 / p_imp end
  when 'ctr' then case when p_imp > 0 then p_clicks * 100 / p_imp end
  when 'frequency' then case when p_reach > 0 then p_imp / p_reach end
 end
$$;

-- O que está errado na regra (nulo: está boa).
create function mavi_private.campaign_alert_problem(r public.campaign_alert_rules) returns text
language plpgsql immutable set search_path = '' as $$ begin
 if length(btrim(coalesce(r.name, ''))) not between 2 and 120 then return 'Dê um nome de 2 a 120 caracteres ao aviso.'; end if;
 if mavi_private.campaign_alert_cycle_metric(r.metric) and r.condition not in ('above', 'below') then
  return format('%s é do ciclo: use "chegar a ou passar de" ou "ficar em ou abaixo de".',
   mavi_private.campaign_alert_label(r.metric));
 end if;
 if r.condition = 'zero' and r.metric not in ('spend', 'conversions', 'impressions', 'clicks', 'reach') then
  return 'Só consumo, conversões, impressões, cliques e alcance podem ficar zerados.';
 end if;
 if r.condition in ('above', 'below', 'rise', 'drop') and r.value is null then
  return case when r.condition in ('rise', 'drop') then 'Diga de quantos % é a variação.' else 'Diga o valor do limite.' end;
 end if;
 if r.condition in ('rise', 'drop') and r.value <= 0 then return 'A variação precisa ser maior que 0%.'; end if;
 if r.condition = 'unchanged' and r.days < 2 then return 'Para "igual", conte ao menos 2 dias.'; end if;
 if r.condition in ('above', 'below') and r.period = 'days' and r.days < 2 then
  return 'Para "nos últimos dias", conte ao menos 2 dias.';
 end if;
 return null;
end $$;

-- A regra aplicada a uma campanha hoje: se vale, o valor e o texto do aviso;
-- ok = false quando não dá para conferir (sem ciclo em andamento, sem os
-- dias gravados, conta que não fecha).
create function mavi_private.campaign_alert_measure(r public.campaign_alert_rules, p_campaign uuid, p_today date)
 returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare a public.ad_campaigns; y public.ad_cycles; s public.ad_cycle_snapshots; v_last date := p_today - 1;
 n integer := greatest(coalesce(r.days, 1), 1); v_label text := mavi_private.campaign_alert_label(r.metric);
 v_rows integer; v_vals numeric[]; v numeric; v_prev numeric; v_change numeric; v_min numeric; v_max numeric;
 v_met boolean; v_text text; v_where text; m numeric; v_total integer; v_elapsed integer; v_remaining integer;
 v_budget numeric; v_spent numeric; v_gross numeric; v_imp numeric; v_reach numeric; v_clicks numeric;
 v_conv numeric; v_days integer;
begin
 select * into a from public.ad_campaigns where company_id = r.company_id and id = p_campaign;
 if not found then return jsonb_build_object('ok', false, 'reason', 'Campanha não encontrada.'); end if;
 select * into y from public.ad_cycles where company_id = a.company_id and id = a.current_cycle_id;
 if not found then return jsonb_build_object('ok', false, 'reason', 'A campanha não tem ciclo atual.'); end if;
 if v_last < y.start_date then
  return jsonb_build_object('ok', false, 'reason', 'O ciclo atual ainda não tem um dia completo.');
 end if;
 if v_last > y.end_date then return jsonb_build_object('ok', false, 'reason', 'O ciclo atual já terminou.'); end if;
 m := y.multiplier;

 -- O ciclo até ontem: os dias gravados; as conversões, o alcance e os
 -- outros totais pela última foto do acumulado, quando há (como o Dia a Dia).
 if r.period = 'cycle' or mavi_private.campaign_alert_cycle_metric(r.metric) then
  select count(*)::int, coalesce(sum(d.spend), 0), coalesce(sum(d.spend * d.multiplier), 0),
   coalesce(sum(d.impressions), 0), coalesce(sum(d.reach), 0), coalesce(sum(d.clicks), 0),
   coalesce(sum(d.conversions), 0)
  into v_days, v_spent, v_gross, v_imp, v_reach, v_clicks, v_conv
  from public.ad_daily_metrics d
  where d.company_id = a.company_id and d.cycle_id = y.id and d.day between y.start_date and v_last;
  select * into s from public.ad_cycle_snapshots x where x.company_id = a.company_id and x.cycle_id = y.id
   and x.taken_on <= p_today order by x.taken_on desc limit 1;
  if s.id is not null then
   v_imp := s.impressions; v_reach := s.reach; v_clicks := s.clicks; v_conv := s.conversions;
   if v_days = 0 then v_spent := s.spend; v_gross := s.spend * m; end if;
  elsif v_days = 0 then
   return jsonb_build_object('ok', false, 'reason', 'O ciclo atual ainda não tem números.');
  end if;
 end if;

 if mavi_private.campaign_alert_cycle_metric(r.metric) then
  v_total := y.end_date - y.start_date + 1;
  v_elapsed := least(greatest(p_today - y.start_date, 0), v_total);
  v_remaining := greatest(y.end_date - greatest(p_today, y.start_date) + 1, 0);
  v_budget := y.budget / m;
  v := case r.metric
   when 'media_left' then (v_budget - v_gross / m) * case when r.with_m then m else 1 end
   when 'daily_budget' then greatest(v_budget - v_gross / m, 0) / greatest(v_remaining, 1)
    * case when r.with_m then m else 1 end
   when 'spend_pace' then case when v_elapsed > 0 and v_budget > 0
    then v_spent * 100 / (v_budget * v_elapsed / v_total) end
   when 'results_pace' then case when v_elapsed > 0 and y.goal_results > 0
    then v_conv * 100 / (y.goal_results::numeric * v_elapsed / v_total) end
   when 'cost_vs_goal' then case when v_conv > 0 and y.goal_results > 0 and v_budget > 0
    then (v_spent / v_conv) * 100 / (v_budget / y.goal_results) end
  end;
  if v is null then
   return jsonb_build_object('ok', false, 'reason', case r.metric
    when 'results_pace' then 'O ciclo não tem meta de resultados.'
    when 'cost_vs_goal' then 'Ainda sem conversões no ciclo, ou o ciclo não tem meta.'
    else 'O ciclo ainda não tem um dia completo.' end);
  end if;
  v := round(v, 2);
  v_met := case r.condition when 'above' then v >= r.value else v <= r.value end;
  v_text := format('%s: %s (aviso %s %s)', v_label, mavi_private.campaign_alert_fmt(r.metric, v),
   case r.condition when 'above' then 'a partir de' else 'em ou abaixo de' end,
   mavi_private.campaign_alert_fmt(r.metric, r.value));
  return jsonb_build_object('ok', true, 'met', v_met, 'value', v, 'text', v_text);
 end if;

 if r.condition in ('above', 'below') then
  if r.period = 'cycle' then
   v := mavi_private.campaign_alert_value(r.metric, r.with_m, v_spent, v_gross, v_imp, v_reach, v_clicks, v_conv);
   v_where := 'no ciclo';
  else
   n := case when r.period = 'day' then 1 else n end;
   select count(distinct d.day)::int, mavi_private.campaign_alert_value(r.metric, r.with_m, sum(d.spend),
     sum(d.spend * d.multiplier), sum(d.impressions), sum(d.reach), sum(d.clicks), sum(d.conversions))
   into v_rows, v
   from public.ad_daily_metrics d
   where d.company_id = a.company_id and d.campaign_id = a.id and d.day between v_last - n + 1 and v_last;
   if v_rows < n then
    return jsonb_build_object('ok', false, 'reason',
     case when n = 1 then 'Ainda sem o número de ontem.' else format('Ainda não há %s dias de números.', n) end);
   end if;
   v_where := case when n = 1 then 'em ' || to_char(v_last, 'DD/MM') else format('nos últimos %s dias', n) end;
  end if;
  if v is null then
   return jsonb_build_object('ok', false, 'reason', format('%s sem valor %s (sem a base da conta).', v_label, v_where));
  end if;
  v := round(v, 2);
  v_met := case r.condition when 'above' then v >= r.value else v <= r.value end;
  v_text := format('%s %s: %s (aviso %s %s)', v_label, v_where, mavi_private.campaign_alert_fmt(r.metric, v),
   case r.condition when 'above' then 'a partir de' else 'em ou abaixo de' end,
   mavi_private.campaign_alert_fmt(r.metric, r.value));
  return jsonb_build_object('ok', true, 'met', v_met, 'value', v, 'text', v_text);
 end if;

 if r.condition in ('unchanged', 'zero') then
  select count(*)::int, array_agg(round(x.v, 2) order by x.day)
  into v_rows, v_vals
  from (select d.day, mavi_private.campaign_alert_value(r.metric, r.with_m, sum(d.spend), sum(d.spend * d.multiplier),
     sum(d.impressions), sum(d.reach), sum(d.clicks), sum(d.conversions)) as v
   from public.ad_daily_metrics d
   where d.company_id = a.company_id and d.campaign_id = a.id and d.day between v_last - n + 1 and v_last
   group by d.day) x;
  if v_rows < n then
   return jsonb_build_object('ok', false, 'reason', format('Ainda não há %s dias de números.', n));
  end if;
  if exists (select 1 from unnest(v_vals) u where u is null) then
   return jsonb_build_object('ok', false, 'reason', format('%s sem valor em algum dos dias.', v_label));
  end if;
  select min(u), max(u) into v_min, v_max from unnest(v_vals) u;
  v := v_vals[array_length(v_vals, 1)];
  if r.condition = 'zero' then
   v_met := v_max = 0;
   v_text := case when v_met then format('%s: 0 há %s dias seguidos', v_label, n)
    else format('%s de ontem: %s', v_label, mavi_private.campaign_alert_fmt(r.metric, v)) end;
  else
   v_met := v_max - v_min <= abs(v_max) * r.tolerance / 100;
   v_text := case when v_met then format('%s %s há %s dias: %s por dia', v_label,
     case when r.tolerance > 0 then format('praticamente igual (±%s%%)', mavi_private.campaign_alert_num(r.tolerance))
      else 'igual' end, n,
     case when v_min = v_max then mavi_private.campaign_alert_fmt(r.metric, v)
      else mavi_private.campaign_alert_fmt(r.metric, v_min) || ' a ' || mavi_private.campaign_alert_fmt(r.metric, v_max) end)
    else format('%s variou nos últimos %s dias: de %s a %s', v_label, n,
     mavi_private.campaign_alert_fmt(r.metric, v_min), mavi_private.campaign_alert_fmt(r.metric, v_max)) end;
  end if;
  return jsonb_build_object('ok', true, 'met', v_met, 'value', v, 'text', v_text);
 end if;

 -- Subir / cair: os últimos N dias contra os N anteriores.
 select count(distinct d.day) filter (where d.day > v_last - n)::int + count(distinct d.day) filter (where d.day <= v_last - n)::int,
  mavi_private.campaign_alert_value(r.metric, r.with_m, sum(d.spend) filter (where d.day > v_last - n),
   sum(d.spend * d.multiplier) filter (where d.day > v_last - n), sum(d.impressions) filter (where d.day > v_last - n),
   sum(d.reach) filter (where d.day > v_last - n), sum(d.clicks) filter (where d.day > v_last - n),
   sum(d.conversions) filter (where d.day > v_last - n)),
  mavi_private.campaign_alert_value(r.metric, r.with_m, sum(d.spend) filter (where d.day <= v_last - n),
   sum(d.spend * d.multiplier) filter (where d.day <= v_last - n), sum(d.impressions) filter (where d.day <= v_last - n),
   sum(d.reach) filter (where d.day <= v_last - n), sum(d.clicks) filter (where d.day <= v_last - n),
   sum(d.conversions) filter (where d.day <= v_last - n))
 into v_rows, v, v_prev
 from public.ad_daily_metrics d
 where d.company_id = a.company_id and d.campaign_id = a.id and d.day between v_last - 2 * n + 1 and v_last;
 if v_rows < 2 * n then
  return jsonb_build_object('ok', false, 'reason', format('Ainda não há %s dias de números para comparar.', 2 * n));
 end if;
 if v is null or v_prev is null or v_prev = 0 then
  return jsonb_build_object('ok', false, 'reason', format('%s sem base para comparar (zerado ou sem valor antes).', v_label));
 end if;
 v := round(v, 2);
 v_prev := round(v_prev, 2);
 v_change := round((v - v_prev) * 100 / v_prev, 1);
 v_met := case r.condition when 'rise' then v_change >= r.value else v_change <= -r.value end;
 v_where := case when n = 1 then format('ontem × anteontem') else format('últimos %s dias × %s dias antes', n, n) end;
 v_text := format('%s %s %s%% (%s: %s × %s)', v_label, case when v_change >= 0 then 'subiu' else 'caiu' end,
  mavi_private.campaign_alert_num(abs(v_change)), v_where, mavi_private.campaign_alert_fmt(r.metric, v),
  mavi_private.campaign_alert_fmt(r.metric, v_prev));
 return jsonb_build_object('ok', true, 'met', v_met, 'value', v_change, 'text', v_text);
end $$;

-- A regra vale para a campanha (ela mesma, ou pelos filtros).
create function mavi_private.campaign_alert_applies(r public.campaign_alert_rules, p_campaign uuid) returns boolean
language sql stable security definer set search_path = '' as $$
 select case when r.campaign_id is not null then r.campaign_id = p_campaign else exists (
  select 1 from public.ad_campaigns a
  join public.contracts k on k.company_id = a.company_id and k.id = a.contract_id
  left join public.ad_cycles y on y.company_id = a.company_id and y.id = a.current_cycle_id
  where a.company_id = r.company_id and a.id = p_campaign
   and (cardinality(r.client_ids) = 0 or k.client_id = any(r.client_ids))
   and (cardinality(r.product_ids) = 0 or k.product_id = any(r.product_ids))
   and (cardinality(r.platforms) = 0 or a.platform = any(r.platforms))
   and (cardinality(r.objectives) = 0 or y.objective = any(r.objectives))
   and (cardinality(r.team_ids) = 0 or exists (select 1 from public.client_teams ct
    where ct.company_id = a.company_id and ct.client_id = k.client_id and ct.team_id = any(r.team_ids)))) end
$$;

-- A pessoa enxerga a campanha deste cliente no módulo (a regra das telas).
create function mavi_private.campaign_alert_sees(c uuid, u uuid, p_client uuid) returns boolean
language sql stable security definer set search_path = '' as $$
 select exists (select 1 from public.memberships m
  where m.company_id = c and m.user_id = u and m.active and not ('campaigns' = any(m.hidden_pages))
   and (m.role in ('admin', 'manager')
    or (m.role = 'member' and 'campaigns' = any(m.shown_pages)
     and p_client = any(mavi_private.served_clients_of(c, u)))))
$$;

-- ------------------------------------------------------------ conferir
-- As regras ligadas que valem para a campanha, de quem ainda a enxerga.
-- Dispara pela repetição de cada uma; um disparo por regra, campanha e dia.
create function mavi_private.campaign_alert_check(p_company uuid, p_campaign uuid, p_today date default null)
 returns integer
language plpgsql security definer set search_path = '' as $$
declare v_today date := coalesce(p_today, mavi_private.company_today(p_company)); c record;
 r public.campaign_alert_rules; st mavi_private.campaign_alert_state; res jsonb; v_met boolean; v_fire boolean;
 v_n integer := 0; begin
 select a.id, a.name, a.status, a.archived, k.client_id, cl.name as client_name, p.name as product_name into c
 from public.ad_campaigns a
 join public.contracts k on k.company_id = a.company_id and k.id = a.contract_id
 join public.clients cl on cl.company_id = k.company_id and cl.id = k.client_id
 join public.products p on p.company_id = k.company_id and p.id = k.product_id
 where a.company_id = p_company and a.id = p_campaign;
 if not found or c.status <> 'active' or c.archived then return 0; end if;
 for r in
  select rr.* from public.campaign_alert_rules rr
  where rr.company_id = p_company and rr.active and mavi_private.campaign_alert_applies(rr, p_campaign)
   and mavi_private.campaign_alert_sees(p_company, rr.user_id, c.client_id)
  order by rr.created_at
 loop
  res := mavi_private.campaign_alert_measure(r, p_campaign, v_today);
  continue when not coalesce((res ->> 'ok')::boolean, false);
  v_met := (res ->> 'met')::boolean;
  select * into st from mavi_private.campaign_alert_state where rule_id = r.id and campaign_id = p_campaign;
  v_fire := v_met and st.fired_on is distinct from v_today
   and (st.rule_id is null or not st.met
    or (r.repeat = 'daily')
    or (r.repeat = 'every' and (st.fired_on is null or v_today - st.fired_on >= r.repeat_days)));
  insert into mavi_private.campaign_alert_state(rule_id, campaign_id, met, fired_on, checked_on)
  values (r.id, p_campaign, v_met, case when v_fire then v_today end, v_today)
  on conflict (rule_id, campaign_id) do update set met = excluded.met, checked_on = excluded.checked_on,
   fired_on = coalesce(excluded.fired_on, mavi_private.campaign_alert_state.fired_on);
  continue when not v_fire;
  insert into public.campaign_alert_hits(company_id, rule_id, user_id, campaign_id, day, value, detail, channel)
  values (p_company, r.id, r.user_id, p_campaign, v_today, (res ->> 'value')::numeric, left(res ->> 'text', 300), r.channel);
  if r.channel = 'now' then
   insert into public.notifications(company_id, user_id, actor_id, task_id, kind, title, body, link, client_id)
   values (p_company, r.user_id, null, null, 'campaign_alert', left(format('%s: %s', r.name, c.name), 300),
    left(format('%s · %s › %s', res ->> 'text', c.client_name, c.product_name), 300),
    '/campanhas?campanha=' || p_campaign, c.client_id);
  end if;
  v_n := v_n + 1;
 end loop;
 return v_n;
end $$;

-- Depois de cada sincronização boa do ciclo atual (dentro dela: um erro
-- aqui não derruba a sincronização).
create function mavi_private.campaign_alert_after_sync() returns trigger
language plpgsql security definer set search_path = '' as $$ begin
 if exists (select 1 from public.campaign_alert_rules r where r.company_id = new.company_id and r.active)
  and exists (select 1 from public.ad_campaigns a where a.company_id = new.company_id and a.id = new.campaign_id
   and a.current_cycle_id = new.cycle_id) then
  begin
   perform mavi_private.campaign_alert_check(new.company_id, new.campaign_id);
  exception when others then
   raise warning 'campaign alerts failed: %', sqlerrm;
  end;
 end if;
 return null;
end $$;
create trigger campaign_alert_after_sync after insert on public.ad_sync_runs
 for each row when (new.status = 'ok') execute function mavi_private.campaign_alert_after_sync();

-- O resumo do dia: um aviso por pessoa com os disparos que esperavam.
create function mavi_private.campaign_alert_digest() returns integer
language plpgsql security definer set search_path = '' as $$
declare x record; v_n integer := 0; begin
 for x in
  select h.company_id, h.user_id, count(*)::int as n, count(distinct h.campaign_id)::int as campaigns,
   string_agg(format('%s · %s', r.name, a.name), '; ' order by h.created_at) as parts
  from public.campaign_alert_hits h
  join public.campaign_alert_rules r on r.id = h.rule_id
  join public.ad_campaigns a on a.company_id = h.company_id and a.id = h.campaign_id
  where h.channel = 'digest' and h.digested_at is null
  group by h.company_id, h.user_id
 loop
  if exists (select 1 from public.memberships m where m.company_id = x.company_id and m.user_id = x.user_id and m.active) then
   insert into public.notifications(company_id, user_id, actor_id, task_id, kind, title, body, link)
   values (x.company_id, x.user_id, null, null, 'campaign_alert',
    format('Meus avisos de campanhas: %s %s em %s %s', x.n, case when x.n = 1 then 'disparo' else 'disparos' end,
     x.campaigns, case when x.campaigns = 1 then 'campanha' else 'campanhas' end),
    left(x.parts, 300), '/campanhas?avisos=historico');
   v_n := v_n + 1;
  end if;
 end loop;
 update public.campaign_alert_hits set digested_at = now() where channel = 'digest' and digested_at is null;
 return v_n;
end $$;

-- ------------------------------------------------------------ regras (telas e MAVI)
create function mavi_private.campaign_alert_rule_json(r public.campaign_alert_rules, p_campaign uuid default null)
 returns jsonb
language sql stable security definer set search_path = '' as $$
 select jsonb_build_object('id', r.id, 'name', r.name, 'campaign_id', r.campaign_id,
  'client_ids', to_jsonb(r.client_ids), 'product_ids', to_jsonb(r.product_ids), 'platforms', to_jsonb(r.platforms),
  'objectives', to_jsonb(r.objectives), 'team_ids', to_jsonb(r.team_ids), 'metric', r.metric,
  'condition', r.condition, 'period', r.period, 'days', r.days, 'value', r.value, 'tolerance', r.tolerance,
  'with_m', r.with_m, 'repeat', r.repeat, 'repeat_days', r.repeat_days, 'channel', r.channel, 'active', r.active,
  'origin', r.origin, 'created_at', r.created_at, 'updated_at', r.updated_at,
  'labels', jsonb_build_object(
   'campaign', (select a.name from public.ad_campaigns a where a.company_id = r.company_id and a.id = r.campaign_id),
   'campaign_client', (select cl.name from public.ad_campaigns a
    join public.contracts k on k.company_id = a.company_id and k.id = a.contract_id
    join public.clients cl on cl.company_id = k.company_id and cl.id = k.client_id
    where a.company_id = r.company_id and a.id = r.campaign_id),
   'clients', coalesce((select jsonb_agg(c.name order by c.name) from public.clients c
    where c.company_id = r.company_id and c.id = any(r.client_ids)), '[]'),
   'products', coalesce((select jsonb_agg(p.name order by p.name) from public.products p
    where p.company_id = r.company_id and p.id = any(r.product_ids)), '[]'),
   'teams', coalesce((select jsonb_agg(t.name order by t.name) from public.teams t
    where t.company_id = r.company_id and t.id = any(r.team_ids)), '[]')),
  'last_hit', (select jsonb_build_object('day', h.day, 'detail', h.detail, 'campaign',
    (select a.name from public.ad_campaigns a where a.company_id = h.company_id and a.id = h.campaign_id))
   from public.campaign_alert_hits h where h.rule_id = r.id order by h.created_at desc limit 1),
  'hits_30d', (select count(*) from public.campaign_alert_hits h where h.rule_id = r.id
   and h.created_at > now() - interval '30 days'))
  || case when p_campaign is null then '{}'::jsonb
   else jsonb_build_object('applies', mavi_private.campaign_alert_applies(r, p_campaign)) end
$$;

-- A regra a partir do que a tela ou a MAVI mandou, já ajustada (o que não
-- se aplica à condição volta ao padrão).
create function mavi_private.campaign_alert_from_json(p_company uuid, v jsonb) returns public.campaign_alert_rules
language plpgsql stable set search_path = '' as $$
declare r public.campaign_alert_rules; uuid_re text := '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
begin
 v := coalesce(v, '{}');
 r.id := case when v ->> 'id' ~* uuid_re then (v ->> 'id')::uuid end;
 r.company_id := p_company;
 r.user_id := auth.uid();
 r.name := btrim(coalesce(v ->> 'name', ''));
 r.campaign_id := case when v ->> 'campaign_id' ~* uuid_re then (v ->> 'campaign_id')::uuid end;
 r.client_ids := array(select distinct x::uuid from jsonb_array_elements_text(
  case when jsonb_typeof(v -> 'client_ids') = 'array' then v -> 'client_ids' else '[]' end) x where x ~* uuid_re);
 r.product_ids := array(select distinct x::uuid from jsonb_array_elements_text(
  case when jsonb_typeof(v -> 'product_ids') = 'array' then v -> 'product_ids' else '[]' end) x where x ~* uuid_re);
 r.team_ids := array(select distinct x::uuid from jsonb_array_elements_text(
  case when jsonb_typeof(v -> 'team_ids') = 'array' then v -> 'team_ids' else '[]' end) x where x ~* uuid_re);
 r.platforms := array(select distinct x from jsonb_array_elements_text(
  case when jsonb_typeof(v -> 'platforms') = 'array' then v -> 'platforms' else '[]' end) x
  where x in ('meta', 'google', 'linkedin', 'tiktok', 'kwai'));
 r.objectives := array(select distinct x from jsonb_array_elements_text(
  case when jsonb_typeof(v -> 'objectives') = 'array' then v -> 'objectives' else '[]' end) x
  where x in ('lead', 'sale', 'message', 'traffic', 'engagement', 'custom', 'video'));
 if r.campaign_id is not null then
  r.client_ids := '{}'; r.product_ids := '{}'; r.team_ids := '{}'; r.platforms := '{}'; r.objectives := '{}';
 end if;
 r.metric := coalesce(v ->> 'metric', '');
 r.condition := coalesce(v ->> 'condition', '');
 r.period := coalesce(nullif(v ->> 'period', ''), 'day');
 r.days := least(greatest(coalesce(case when jsonb_typeof(v -> 'days') = 'number' then (v ->> 'days')::numeric end, 1), 1), 30)::smallint;
 r.value := case when jsonb_typeof(v -> 'value') = 'number' then round(abs((v ->> 'value')::numeric), 2) end;
 r.tolerance := least(greatest(coalesce(case when jsonb_typeof(v -> 'tolerance') = 'number'
  then (v ->> 'tolerance')::numeric end, 0), 0), 50);
 r.with_m := coalesce((v ->> 'with_m')::boolean, false);
 r.repeat := coalesce(nullif(v ->> 'repeat', ''), 'once');
 r.repeat_days := least(greatest(coalesce(case when jsonb_typeof(v -> 'repeat_days') = 'number'
  then (v ->> 'repeat_days')::numeric end, 3), 2), 30)::smallint;
 r.channel := coalesce(nullif(v ->> 'channel', ''), 'now');
 r.active := coalesce((v ->> 'active')::boolean, true);
 r.origin := case when v ->> 'origin' = 'mavi' then 'mavi' else 'screen' end;
 if r.metric not in ('spend', 'conversions', 'cpa', 'ctr', 'cpc', 'cpm', 'impressions', 'clicks', 'reach',
  'frequency', 'media_left', 'daily_budget', 'spend_pace', 'results_pace', 'cost_vs_goal') then
  raise exception 'Escolha a métrica do aviso.' using errcode = '22023';
 end if;
 if r.condition not in ('above', 'below', 'unchanged', 'zero', 'rise', 'drop') then
  raise exception 'Escolha a condição do aviso.' using errcode = '22023';
 end if;
 if r.period not in ('day', 'days', 'cycle') then r.period := 'day'; end if;
 if r.repeat not in ('once', 'daily', 'every') then r.repeat := 'once'; end if;
 if r.channel not in ('now', 'digest') then r.channel := 'now'; end if;
 -- O que não vale para a condição volta ao padrão.
 if mavi_private.campaign_alert_cycle_metric(r.metric) then r.period := 'cycle'; r.days := 1;
 elsif r.condition in ('unchanged', 'zero', 'rise', 'drop') then r.period := 'days';
 elsif r.period <> 'days' then r.days := 1;
 end if;
 if r.condition <> 'unchanged' then r.tolerance := 0; end if;
 if r.condition in ('unchanged', 'zero') then r.value := null; end if;
 if r.metric not in ('spend', 'cpa', 'cpc', 'cpm', 'media_left', 'daily_budget') then r.with_m := false; end if;
 if r.repeat <> 'every' then r.repeat_days := 3; end if;
 return r;
end $$;

-- A pessoa pode montar a regra: a campanha que ela enxerga; os filtros da empresa.
create function mavi_private.campaign_alert_require(p_company uuid, r public.campaign_alert_rules) returns void
language plpgsql stable security definer set search_path = '' as $$
declare v_problem text := mavi_private.campaign_alert_problem(r); begin
 if v_problem is not null then raise exception '%', v_problem using errcode = '22023'; end if;
 if r.campaign_id is not null then
  if not exists (select 1 from public.ad_campaigns a where a.company_id = p_company and a.id = r.campaign_id) then
   raise exception 'Campanha não encontrada.' using errcode = 'P0002';
  end if;
  perform mavi_private.ad_require_client(p_company, mavi_private.ad_campaign_client(r.campaign_id));
 end if;
 if (select count(*) from public.clients c where c.company_id = p_company and c.id = any(r.client_ids)) <> cardinality(r.client_ids)
  or (select count(*) from public.products p where p.company_id = p_company and p.id = any(r.product_ids)) <> cardinality(r.product_ids)
  or (select count(*) from public.teams t where t.company_id = p_company and t.id = any(r.team_ids)) <> cardinality(r.team_ids) then
  raise exception 'Filtro não encontrado na empresa.' using errcode = 'P0002';
 end if;
end $$;

-- As regras de quem chama (com p_campaign: se cada uma vale para ela).
create function public.campaign_alert_rules(p_company uuid, p_campaign uuid default null) returns jsonb
language plpgsql stable security definer set search_path = '' as $$ begin
 perform mavi_private.ad_require_reader(p_company);
 return coalesce((select jsonb_agg(mavi_private.campaign_alert_rule_json(r, p_campaign) order by r.created_at)
  from public.campaign_alert_rules r where r.company_id = p_company and r.user_id = auth.uid()), '[]');
end $$;

create function public.save_campaign_alert_rule(p_company uuid, p_rule jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare r public.campaign_alert_rules; saved public.campaign_alert_rules; begin
 perform mavi_private.ad_require_reader(p_company);
 r := mavi_private.campaign_alert_from_json(p_company, p_rule);
 perform mavi_private.campaign_alert_require(p_company, r);
 if r.id is not null then
  update public.campaign_alert_rules set name = r.name, campaign_id = r.campaign_id, client_ids = r.client_ids,
   product_ids = r.product_ids, platforms = r.platforms, objectives = r.objectives, team_ids = r.team_ids,
   metric = r.metric, condition = r.condition, period = r.period, days = r.days, value = r.value,
   tolerance = r.tolerance, with_m = r.with_m, repeat = r.repeat, repeat_days = r.repeat_days, channel = r.channel,
   active = r.active, updated_at = now()
  where id = r.id and company_id = p_company and user_id = auth.uid()
  returning * into saved;
  if saved.id is null then raise exception 'Aviso não encontrado.' using errcode = 'P0002'; end if;
  -- Mudou a regra: confere do zero (o "uma vez" rearma).
  delete from mavi_private.campaign_alert_state where rule_id = saved.id;
 else
  if (select count(*) from public.campaign_alert_rules x where x.company_id = p_company and x.user_id = auth.uid()) >= 50 then
   raise exception 'Cada pessoa tem até 50 avisos de campanhas.' using errcode = '22023';
  end if;
  insert into public.campaign_alert_rules(company_id, user_id, name, campaign_id, client_ids, product_ids, platforms,
   objectives, team_ids, metric, condition, period, days, value, tolerance, with_m, repeat, repeat_days, channel,
   active, origin)
  values (p_company, auth.uid(), r.name, r.campaign_id, r.client_ids, r.product_ids, r.platforms, r.objectives,
   r.team_ids, r.metric, r.condition, r.period, r.days, r.value, r.tolerance, r.with_m, r.repeat, r.repeat_days,
   r.channel, r.active, r.origin)
  returning * into saved;
 end if;
 return mavi_private.campaign_alert_rule_json(saved);
end $$;

create function public.delete_campaign_alert_rule(p_company uuid, p_rule uuid) returns void
language plpgsql security definer set search_path = '' as $$ begin
 perform mavi_private.ad_require_reader(p_company);
 delete from public.campaign_alert_rules where company_id = p_company and id = p_rule and user_id = auth.uid();
 if not found then raise exception 'Aviso não encontrado.' using errcode = 'P0002'; end if;
end $$;

-- Conferir agora (sem avisar ninguém): as campanhas ativas que quem chama
-- enxerga e que a regra pega, com o valor de hoje. As que dispararam primeiro.
create function public.campaign_alert_preview(p_company uuid, p_rule jsonb, p_limit integer default 100) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare r public.campaign_alert_rules; v_clients uuid[]; v_today date; v_out jsonb; begin
 perform mavi_private.ad_require_reader(p_company);
 r := mavi_private.campaign_alert_from_json(p_company, p_rule);
 perform mavi_private.campaign_alert_require(p_company, r);
 v_clients := case when mavi_private.leader(p_company) then null else mavi_private.served_clients(p_company) end;
 v_today := mavi_private.company_today(p_company);
 with picked as (
  select a.id, a.name, cl.name as client_name, p.name as product_name, a.platform
  from public.ad_campaigns a
  join public.contracts k on k.company_id = a.company_id and k.id = a.contract_id
  join public.clients cl on cl.company_id = k.company_id and cl.id = k.client_id
  join public.products p on p.company_id = k.company_id and p.id = k.product_id
  where a.company_id = p_company and a.status = 'active' and not a.archived
   and (v_clients is null or k.client_id = any(v_clients))
   and mavi_private.campaign_alert_applies(r, a.id)
  order by mavi_private.fold(cl.name), mavi_private.fold(a.name)
  limit 300
 ), measured as (
  select x.*, mavi_private.campaign_alert_measure(r, x.id, v_today) as res from picked x
 )
 select jsonb_build_object(
  'checked', (select count(*) from measured),
  'met', (select count(*) from measured where (res ->> 'met')::boolean),
  'campaigns', coalesce((select jsonb_agg(jsonb_build_object('id', m.id, 'name', m.name, 'client', m.client_name,
    'product', m.product_name, 'platform', m.platform, 'ok', (m.res ->> 'ok')::boolean,
    'met', coalesce((m.res ->> 'met')::boolean, false), 'value', m.res -> 'value',
    'text', coalesce(m.res ->> 'text', m.res ->> 'reason'))
   order by coalesce((m.res ->> 'met')::boolean, false) desc, coalesce((m.res ->> 'ok')::boolean, false) desc,
    mavi_private.fold(m.client_name), mavi_private.fold(m.name))
   from (select * from measured
    order by coalesce((res ->> 'met')::boolean, false) desc, coalesce((res ->> 'ok')::boolean, false) desc
    limit greatest(least(coalesce(p_limit, 100), 300), 1)) m), '[]'))
 into v_out;
 return v_out;
end $$;

-- Os disparos de quem chama (de uma regra, ou de todas).
create function public.campaign_alert_history(p_company uuid, p_rule uuid default null, p_limit integer default 50)
 returns jsonb
language plpgsql stable security definer set search_path = '' as $$ begin
 perform mavi_private.ad_require_reader(p_company);
 return coalesce((select jsonb_agg(jsonb_build_object('id', h.id, 'rule_id', h.rule_id, 'rule', r.name,
   'campaign_id', h.campaign_id, 'campaign', a.name, 'client', cl.name, 'day', h.day, 'detail', h.detail,
   'channel', h.channel, 'created_at', h.created_at) order by h.created_at desc)
  from (select * from public.campaign_alert_hits x where x.company_id = p_company and x.user_id = auth.uid()
    and (p_rule is null or x.rule_id = p_rule)
   order by x.created_at desc limit greatest(least(coalesce(p_limit, 50), 200), 1)) h
  join public.campaign_alert_rules r on r.id = h.rule_id
  join public.ad_campaigns a on a.company_id = h.company_id and a.id = h.campaign_id
  join public.contracts k on k.company_id = a.company_id and k.id = a.contract_id
  join public.clients cl on cl.company_id = k.company_id and cl.id = k.client_id), '[]');
end $$;

-- ------------------------------------------------------------ MAVI: modelo da tela
-- "Descreva o aviso" (ação "campaign-alert-mavi" de /api/drive): a
-- funcionalidade 'campaign_alerts' em Quem usa qual modelo.
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
   'mavi_judge_check', 'task_title', 'dashboard_builder', 'campaign_alerts')));

-- A da migração 20270201090000, com os avisos das campanhas.
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
  'mavi_judge_check', 'task_title', 'dashboard_builder', 'campaign_alerts') then
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

-- ------------------------------------------------------------ permissões
revoke all on function mavi_private.campaign_alert_label(text), mavi_private.campaign_alert_cycle_metric(text),
 mavi_private.campaign_alert_num(numeric), mavi_private.campaign_alert_fmt(text, numeric),
 mavi_private.campaign_alert_value(text, boolean, numeric, numeric, numeric, numeric, numeric, numeric),
 mavi_private.campaign_alert_problem(public.campaign_alert_rules),
 mavi_private.campaign_alert_measure(public.campaign_alert_rules, uuid, date),
 mavi_private.campaign_alert_applies(public.campaign_alert_rules, uuid),
 mavi_private.campaign_alert_sees(uuid, uuid, uuid), mavi_private.campaign_alert_check(uuid, uuid, date),
 mavi_private.campaign_alert_after_sync(), mavi_private.campaign_alert_digest(),
 mavi_private.campaign_alert_rule_json(public.campaign_alert_rules, uuid),
 mavi_private.campaign_alert_from_json(uuid, jsonb),
 mavi_private.campaign_alert_require(uuid, public.campaign_alert_rules) from public, anon, authenticated;
revoke all on function public.campaign_alert_rules(uuid, uuid), public.save_campaign_alert_rule(uuid, jsonb),
 public.delete_campaign_alert_rule(uuid, uuid), public.campaign_alert_preview(uuid, jsonb, integer),
 public.campaign_alert_history(uuid, uuid, integer) from public, anon;
grant execute on function public.campaign_alert_rules(uuid, uuid), public.save_campaign_alert_rule(uuid, jsonb),
 public.delete_campaign_alert_rule(uuid, uuid), public.campaign_alert_preview(uuid, jsonb, integer),
 public.campaign_alert_history(uuid, uuid, integer) to authenticated;

-- O resumo do dia às 11h de Brasília (14h UTC), depois da janela da
-- sincronização (6h às 11h). O PostgreSQL dos testes não tem pg_cron.
do $$ begin
 if exists(select 1 from pg_available_extensions where name = 'pg_cron') then
  create extension if not exists pg_cron;
  perform cron.schedule('mavi-campaign-alert-digest', '0 14 * * *', 'select mavi_private.campaign_alert_digest()');
 else
  raise notice 'pg_cron unavailable: schedule mavi_private.campaign_alert_digest() on the hosted database';
 end if;
end $$;

commit;
