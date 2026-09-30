begin;

-- Campanhas: os números demoravam para colaboradores com o módulo ligado
-- (migrações 20270105090000 e 20270107090000). A leitura de quem não é
-- líder conferia, para cada registro, a lista de todas as campanhas da
-- empresa até achar a do registro, checando o acesso da pessoa em cada uma:
-- registros × campanhas. Numa empresa com milhares de campanhas (o histórico
-- do MASO), a tela da campanha passava do tempo limite do banco ("statement
-- timeout") e mostrava "Não foi possível carregar os números".
--
-- Agora cada registro procura só a própria campanha, pelo índice (como os
-- ciclos e o histórico já faziam); a regra de quem vê a campanha continua a
-- mesma (a política de ad_campaigns vale dentro da subconsulta).
alter policy ad_daily_metrics_read on public.ad_daily_metrics
 using (company_id in (select mavi_private.leader_companies())
  or exists (select 1 from public.ad_campaigns a
   where a.company_id = ad_daily_metrics.company_id and a.id = ad_daily_metrics.campaign_id));
alter policy ad_cycle_snapshots_read on public.ad_cycle_snapshots
 using (company_id in (select mavi_private.leader_companies())
  or exists (select 1 from public.ad_campaigns a
   where a.company_id = ad_cycle_snapshots.company_id and a.id = ad_cycle_snapshots.campaign_id));
alter policy ad_sync_runs_read on public.ad_sync_runs
 using (company_id in (select mavi_private.leader_companies())
  or exists (select 1 from public.ad_campaigns a
   where a.company_id = ad_sync_runs.company_id and a.id = ad_sync_runs.campaign_id));
alter policy ad_campaign_comments_read on public.ad_campaign_comments
 using (company_id in (select mavi_private.leader_companies())
  or exists (select 1 from public.ad_campaigns a
   where a.company_id = ad_campaign_comments.company_id and a.id = ad_campaign_comments.campaign_id));

commit;
