-- Diagnóstico: por que "Insights da MAVI nas campanhas" e "Leituras do Termômetro"
-- aparecem como "Sem execuções ainda" em Painel da MAVI › Avisos de falhas.
-- Só leitura. Uma consulta só (o pgAdmin mostra apenas o último resultado).

select * from (
 -- Os gatilhos existem e estão ligados? ('O' = ligado)
 select 1 as ord, 'gatilho ' || tgname as item, tgenabled::text as valor
 from pg_trigger where tgname in ('job_campaign_insights', 'job_temperature')
 union all
 -- O que a tela lê (sem linha = "Sem execuções ainda")
 select 2, 'job_status ' || job, coalesce('ok ' || last_ok_at::text, '-') || ' | falha ' ||
  coalesce(last_fail_at::text, '-') || ' ' || coalesce(last_error, '')
 from mavi_private.job_status where job in ('campaign_insights', 'temperature')
 union all
 -- Insights desde 04/10 por situação ("skipped" não conta como execução)
 select 3, 'insights desde 04/10: ' || status || ' (' || trigger || ')',
  count(*)::text || ' | última ' || coalesce(max(coalesce(finished_at, created_at))::text, '-')
 from public.campaign_insight_runs where created_at >= '2026-10-04' group by status, trigger
 union all
 -- Insights: a última de cada situação, em qualquer data
 select 4, 'insights última ' || status, coalesce(max(finished_at)::text, '-')
 from public.campaign_insight_runs group by status
 union all
 -- Insights: regras de agendamento ligadas
 select 5, 'insights regras ligadas (campanha)', count(*)::text
 from public.campaign_insight_rules where enabled
 union all
 -- Termômetro: leituras por situação, avaliadas desde 04/10 e prontas na fila
 select 6, 'termometro ' || status, count(*)::text || ' | avaliadas desde 04/10: ' ||
  count(*) filter (where evaluated_at >= '2026-10-04')::text || ' | prontas na fila: ' ||
  count(*) filter (where status = 'pending' and dirty_at <= now() - interval '20 minutes')::text ||
  ' | última avaliação ' || coalesce(max(evaluated_at)::text, '-')
 from public.temperature_signals group by status
 union all
 -- Termômetro: leituras criadas desde 04/10 (reuniões e dias de WhatsApp novos)
 select 7, 'termometro criadas desde 04/10: ' || source_type, count(*)::text
 from public.temperature_signals where occurred_at >= '2026-10-04' group by source_type
 union all
 -- Termômetro: a empresa tem modelo configurado? (vazio = o worker não pega nada)
 select 8, 'termometro rota ' || co.name, coalesce((select r->>'provider' || ' / ' || (r->>'model')
  from (select mavi_private.temperature_route(co.id) as r) x where r is not null), 'NULO')
 from public.companies co
) d order by ord, item;
