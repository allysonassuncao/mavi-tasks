-- Campanhas › Insights da MAVI: o agendamento das análises (migration
-- 20270327090000_campaign_insights). Usa a mesma mavi_private.ai_config (URL
-- do /api/ai e AI_WORKER_SECRET) da indexação — rode depois de
-- schedule-ai-index.sql. Sem segredos neste arquivo. Rodar de novo substitui
-- o job.
-- - A cada 5 minutos: põe na fila as campanhas cuja vez chegou (frequência do
--   Painel da MAVI › Campanhas, no fuso de cada empresa, abaixo do teto do
--   mês) e, havendo fila, acorda o worker; sem trabalho, não faz nada.
-- - O "Analisar agora" acorda o worker na hora, sem esperar este job.
begin;
create extension if not exists pg_cron;
create extension if not exists pg_net with schema extensions;
do $$ begin
 if not exists (select 1 from mavi_private.ai_config where id) then
  raise exception 'Configure mavi_private.ai_config (url, secret) first';
 end if;
end $$;
select cron.schedule('mavi-campaign-insights', '*/5 * * * *', $job$ select mavi_private.campaign_insight_kick(); $job$);
commit;
