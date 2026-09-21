-- Run after deployment and after saving matching Vault/Edge secrets. No secrets
-- are embedded in cron.job or source control. Re-running replaces the named job.
begin;
create extension if not exists pg_cron;
create extension if not exists pg_net with schema extensions;
do $$ begin
 if not exists(select 1 from vault.decrypted_secrets where name='mavi_supabase_url')
 or not exists(select 1 from vault.decrypted_secrets where name='mavi_maintenance_secret' and length(decrypted_secret)>=32)
 then raise exception 'Configure mavi_supabase_url and mavi_maintenance_secret in Vault first'; end if;
end $$;
select cron.schedule('mavi-storage-reconcile','*/15 * * * *', $job$
 select net.http_post(
   url := rtrim((select decrypted_secret from vault.decrypted_secrets where name='mavi_supabase_url'),'/') || '/functions/v1/storage-reconcile',
   headers := jsonb_build_object('Content-Type','application/json','Authorization',
     'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name='mavi_maintenance_secret')),
   body := '{}'::jsonb,
   timeout_milliseconds := 60000
 );
$job$);
-- Keep this maintenance subsystem's own scheduler history bounded as well.
select cron.schedule('mavi-cron-history-cleanup','30 3 * * *', $job$
 delete from cron.job_run_details where end_time<now()-interval '7 days'
 and jobid in (select jobid from cron.job where jobname in (
   'mavi-storage-reconcile','mavi-task-event-retention','mavi-invite-limit-cleanup','mavi-cron-history-cleanup'));
$job$);
commit;
