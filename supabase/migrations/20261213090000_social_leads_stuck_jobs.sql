-- Geração do plano presa em "running": quando a Vercel encerra a função no
-- meio (limite de 300 s), social_leads_finish_job nunca é chamada e a tela
-- fica em "A MAVI está escrevendo…" para sempre. Passados 6 minutos (mais que
-- qualquer geração pode durar), o banco fecha a geração como falha e avisa
-- quem pediu; a atualização do job já chega à tela pelo Realtime.
begin;

create or replace function mavi_private.social_leads_expire_jobs() returns integer
language plpgsql security definer set search_path = '' as $$
declare j public.social_leads_jobs; client text; n integer := 0;
 msg constant text := 'A geração foi interrompida antes de terminar e não voltou. Tente de novo.';
begin
 for j in select * from public.social_leads_jobs
  where status = 'running' and created_at < now() - interval '6 minutes'
  for update skip locked
 loop
  update public.social_leads_jobs set status = 'failed', error = msg, finished_at = now() where id = j.id;
  select coalesce(nullif(b.fields->>'clientName', ''), c.name) into client
  from public.contracts k join public.clients c on c.company_id = k.company_id and c.id = k.client_id
  left join public.social_leads_briefings b on b.company_id = k.company_id and b.contract_id = k.id
  where k.company_id = j.company_id and k.id = j.contract_id;
  insert into public.notifications(company_id, user_id, actor_id, task_id, kind, title, body, link)
  values (j.company_id, j.created_by, null, null, 'social_leads',
   format('A geração do plano de %s falhou', client), msg,
   mavi_private.social_leads_module_path(mavi_private.social_leads_module_of(j.company_id, j.contract_id))
    || '?contrato=' || j.contract_id);
  n := n + 1;
 end loop;
 return n;
end $$;
revoke all on function mavi_private.social_leads_expire_jobs() from public, anon, authenticated;

do $$ begin
 if exists (select 1 from pg_available_extensions where name = 'pg_cron') then
  create extension if not exists pg_cron;
  perform cron.schedule('mavi-social-leads-stuck-jobs', '* * * * *',
   'select mavi_private.social_leads_expire_jobs()');
 else
  raise notice 'pg_cron unavailable: social_leads_expire_jobs must be scheduled on the hosted database';
 end if;
end $$;

-- As que já estão presas.
select mavi_private.social_leads_expire_jobs();

commit;
