-- Termômetro do cliente: o worker do Jev (migration
-- 20261110090000_client_temperature). Usa a mesma mavi_private.ai_config
-- (URL do /api/ai e AI_WORKER_SECRET) da indexação — rode depois de
-- schedule-ai-index.sql. Sem segredos neste arquivo. Rodar de novo substitui
-- os jobs.
-- - A cada 2 minutos: se há leitura pendente parada há 20 minutos (de uma
--   empresa com o Jev cadastrado), cliente para recalcular ou texto da MAVI
--   para escrever, acorda o worker; sem trabalho, não faz nada.
-- - Todo dia às 06:15 UTC (03:15 em Brasília): a idade das leituras muda a
--   temperatura; marca os clientes para o recálculo do dia.
begin;
create extension if not exists pg_cron;
create extension if not exists pg_net with schema extensions;
do $$ begin
 if not exists (select 1 from mavi_private.ai_config where id) then
  raise exception 'Configure mavi_private.ai_config (url, secret) first';
 end if;
end $$;
select cron.schedule('mavi-client-temperature', '*/2 * * * *', $job$ select mavi_private.ai_temperature_kick(); $job$);
select cron.schedule('mavi-client-temperature-daily', '15 6 * * *', $job$ select mavi_private.temperature_daily(); $job$);
commit;
