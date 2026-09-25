begin;

-- Campanhas: o cron do Google no MASO gravava as impressões na coluna
-- "alcance" (o Google não tem alcance) e deixava "impressao" vazia; a
-- importação do histórico copiou assim. Nas campanhas do Google, os números
-- vindos do MASO passam a ter as impressões no lugar certo e alcance zero
-- (como a sincronização grava). Só mexe onde as impressões estão zeradas e o
-- "alcance" não: rodar de novo não muda nada.

update public.ad_cycle_snapshots s set impressions = s.reach, reach = 0
from public.ad_campaigns a
where a.company_id = s.company_id and a.id = s.campaign_id and a.platform = 'google'
 and s.source = 'maso' and s.impressions = 0 and s.reach > 0;

update public.ad_daily_metrics d set impressions = d.reach, reach = 0
from public.ad_campaigns a
where a.company_id = d.company_id and a.id = d.campaign_id and a.platform = 'google'
 and d.source = 'maso' and d.impressions = 0 and d.reach > 0;

commit;
