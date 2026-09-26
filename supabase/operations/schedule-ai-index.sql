-- IA do MAVI: indexação da base de conhecimento (migration
-- 20261021090000_ai_knowledge). Rode depois da migration, com
-- mavi_private.ai_config preenchida com a URL do /api/ai e o mesmo
-- AI_WORKER_SECRET configurado na Vercel:
--   insert into mavi_private.ai_config(url, secret)
--   values ('https://<seu domínio>/api/ai', '<AI_WORKER_SECRET>');
-- Sem segredos neste arquivo. Rodar de novo substitui o job.
-- A cada minuto: se houver itens na fila ou trechos sem vetor, acorda o
-- worker (que trabalha ~50 s por chamada); sem trabalho, não faz nada.
begin;
create extension if not exists pg_cron;
create extension if not exists pg_net with schema extensions;
do $$ begin
 if not exists (select 1 from mavi_private.ai_config where id) then
  raise exception 'Configure mavi_private.ai_config (url, secret) first';
 end if;
end $$;
select cron.schedule('mavi-ai-index', '* * * * *', $job$ select mavi_private.ai_kick(); $job$);
commit;
