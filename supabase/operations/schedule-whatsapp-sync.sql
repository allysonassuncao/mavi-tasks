-- Drive › cliente › Whatsapp: a coleta dos grupos na Uazapi (migration
-- 20261027150000_whatsapp_groups). Rode depois da migration, com
-- mavi_private.whatsapp_config preenchida com a empresa do número, a URL do
-- /api/whatsapp e o mesmo WHATSAPP_WORKER_SECRET configurado na Vercel:
--   insert into mavi_private.whatsapp_config(company_id, url, secret)
--   values ('<id da empresa>', 'https://<seu domínio>/api/whatsapp', '<WHATSAPP_WORKER_SECRET>');
-- Sem segredos neste arquivo. Rodar de novo substitui o job.
-- A cada minuto o banco confere se há trabalho: a varredura de hora em hora
-- venceu, ou ainda há grupos para ler ou mídias na fila. Só então acorda o
-- servidor (que trabalha ~80 s por chamada); sem trabalho, não faz nada.
begin;
create extension if not exists pg_cron;
create extension if not exists pg_net with schema extensions;
do $$ begin
 if not exists (select 1 from mavi_private.whatsapp_config where id) then
  raise exception 'Configure mavi_private.whatsapp_config (company_id, url, secret) first';
 end if;
end $$;
select cron.schedule('mavi-whatsapp-sync', '* * * * *', $job$ select mavi_private.whatsapp_kick(); $job$);
commit;
