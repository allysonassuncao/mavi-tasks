-- Campanhas › lista: a Leitura do dia da MAVI (migração
-- 20270403170000_campaign_daily_read). Rode depois da migração, com
-- mavi_private.ai_config já preenchida (a mesma do worker da MAVI). Sem
-- segredos aqui. Rodar de novo substitui o agendamento.
-- A cada 10 minutos: mavi_private.campaign_daily_kick põe na fila as
-- campanhas cuja sincronização da manhã terminou (ou 3 h depois da hora
-- marcada) e acorda o worker só quando há leitura para fazer.
begin;
create extension if not exists pg_cron;
create extension if not exists pg_net with schema extensions;
do $$ begin
 if not exists (select 1 from mavi_private.ai_config where id) then
  raise exception 'Configure mavi_private.ai_config (url, secret) first';
 end if;
end $$;
select cron.schedule('mavi-campaign-daily', '*/10 * * * *', $job$ select mavi_private.campaign_daily_kick(); $job$);
commit;
