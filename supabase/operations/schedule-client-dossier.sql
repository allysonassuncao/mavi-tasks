-- Assistente MAVI nas tarefas: o worker do dossiê do cliente (migration
-- 20261101090000_task_copilot). Usa a mesma mavi_private.ai_config (URL do
-- /api/ai e AI_WORKER_SECRET) da indexação — rode depois de
-- schedule-ai-index.sql. Sem segredos neste arquivo. Rodar de novo substitui
-- o job.
-- A cada 5 minutos: se algum cliente em uso tem material novo parado há 15
-- minutos (ou ainda não tem dossiê), acorda o worker; sem trabalho, não faz
-- nada.
begin;
create extension if not exists pg_cron;
create extension if not exists pg_net with schema extensions;
do $$ begin
 if not exists (select 1 from mavi_private.ai_config where id) then
  raise exception 'Configure mavi_private.ai_config (url, secret) first';
 end if;
end $$;
select cron.schedule('mavi-client-dossier', '*/5 * * * *', $job$ select mavi_private.ai_dossier_kick(); $job$);
commit;
