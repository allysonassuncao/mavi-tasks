-- Áudios das tarefas: a limpeza dos rascunhos e dos arquivos no GCS
-- (migration 20261203090000_task_audio_cleanup). Usa a mesma
-- mavi_private.ai_config (URL do /api/ai e AI_WORKER_SECRET) da indexação —
-- rode depois de schedule-ai-index.sql. Sem segredos neste arquivo. Rodar de
-- novo substitui o job.
-- A cada hora: se há rascunho com mais de 24 horas ou arquivo na fila,
-- acorda o worker; sem trabalho, não faz nada.
begin;
create extension if not exists pg_cron;
create extension if not exists pg_net with schema extensions;
do $$ begin
 if not exists (select 1 from mavi_private.ai_config where id) then
  raise exception 'Configure mavi_private.ai_config (url, secret) first';
 end if;
end $$;
select cron.schedule('mavi-task-audio-cleanup', '23 * * * *', $job$ select mavi_private.task_audio_cleanup_kick(); $job$);
commit;
