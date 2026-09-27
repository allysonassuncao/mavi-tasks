-- Assistente MAVI nas tarefas: o worker que aprende com o feedback do time
-- (migration 20261103090000_copilot_learning). Usa a mesma
-- mavi_private.ai_config (URL do /api/ai e AI_WORKER_SECRET) da indexação —
-- rode depois de schedule-ai-index.sql. Sem segredos neste arquivo. Rodar de
-- novo substitui o job.
-- A cada 10 minutos: se alguma empresa tem feedback novo parado há 10 minutos
-- (ou 20 esperando), acorda o worker; sem trabalho, não faz nada.
begin;
create extension if not exists pg_cron;
create extension if not exists pg_net with schema extensions;
do $$ begin
 if not exists (select 1 from mavi_private.ai_config where id) then
  raise exception 'Configure mavi_private.ai_config (url, secret) first';
 end if;
end $$;
select cron.schedule('mavi-copilot-learning', '*/10 * * * *', $job$ select mavi_private.ai_learning_kick(); $job$);
commit;
