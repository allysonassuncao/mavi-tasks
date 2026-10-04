-- Campanhas › lista: o leitor do "hoje" (migração
-- 20270331090000_campaign_list_results). Rode depois da migração, com
-- mavi_private.ad_sync_config já preenchida (a mesma URL /api/ads-sync e o
-- mesmo ADS_SYNC_SECRET da sincronização). Sem segredos aqui. Rodar de novo
-- substitui o agendamento.
-- A cada 15 minutos: mavi_private.ad_today_kick só acorda o servidor quando
-- há ciclos para ler (das 7h ao fim do dia na hora da empresa; o Meta a cada
-- hora, o Google a cada duas, uma leitura por conta de anúncios).
begin;
create extension if not exists pg_cron;
create extension if not exists pg_net with schema extensions;
do $$ begin
 if not exists (select 1 from mavi_private.ad_sync_config where id) then
  raise exception 'Configure mavi_private.ad_sync_config (url, secret) first';
 end if;
end $$;
select cron.schedule('mavi-ads-today', '*/15 * * * *', $job$ select mavi_private.ad_today_kick(); $job$);
commit;
