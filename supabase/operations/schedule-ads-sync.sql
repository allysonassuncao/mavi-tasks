-- Campanhas: the daily sync of the cycles' numbers (migration
-- 20261002090000_ad_metrics). Run after the migration, once
-- mavi_private.ad_sync_config holds the /api/ads-sync URL and the same
-- ADS_SYNC_SECRET set on Vercel. No secrets here. Re-running replaces the job.
-- Every 20 minutes from 06:00 to 09:40 (UTC-3): each call syncs the next
-- cycles not synced today, so a large portfolio spreads over several calls.
begin;
create extension if not exists pg_cron;
create extension if not exists pg_net with schema extensions;
do $$ begin
 if not exists (select 1 from mavi_private.ad_sync_config where id) then
  raise exception 'Configure mavi_private.ad_sync_config (url, secret) first';
 end if;
end $$;
select cron.schedule('mavi-ads-sync', '*/20 9-12 * * *', $job$ select mavi_private.ad_sync_kick(); $job$);
commit;
