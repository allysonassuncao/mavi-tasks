-- Radar do cliente: o worker da MAVI (migration 20261229090000_client_radar).
-- Usa a mesma mavi_private.ai_config (URL do /api/ai e AI_WORKER_SECRET) da
-- indexação — rode depois de schedule-ai-index.sql. Sem segredos neste
-- arquivo. Rodar de novo substitui o job.
-- - A cada 2 minutos: se há reunião nova (parada há 2 min) ou dia de grupo
--   com mensagens novas (parado há 10 min, depois da busca de 2 h), acorda o
--   worker; sem trabalho, não faz nada.
begin;
create extension if not exists pg_cron;
create extension if not exists pg_net with schema extensions;
do $$ begin
 if not exists (select 1 from mavi_private.ai_config where id) then
  raise exception 'Configure mavi_private.ai_config (url, secret) first';
 end if;
end $$;
select cron.schedule('mavi-client-radar', '*/2 * * * *', $job$ select mavi_private.ai_radar_kick(); $job$);
commit;
