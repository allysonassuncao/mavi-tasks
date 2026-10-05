begin;

-- Termômetro: o pg_cron acordava o worker a cada 2 minutos por causa das
-- leituras pendentes de clientes arquivados (em 05/10/2026, 961 leituras),
-- que a reserva (ai_temperature_claim) nunca entrega; o worker voltava com
-- "signals":0. Agora o acordar olha o mesmo que as reservas (das leituras e
-- dos textos da MAVI): só clientes não arquivados. As leituras ficam como
-- estão e voltam a contar se o cliente for desarquivado.
create or replace function mavi_private.ai_temperature_kick() returns void
language plpgsql security definer set search_path = '' as $$
declare cfg mavi_private.ai_config; begin
 select * into cfg from mavi_private.ai_config where id;
 if not found then return; end if;
 if not exists (select 1 from public.temperature_signals x
   join public.clients k on k.id = x.client_id and not k.archived
   where x.status = 'pending' and x.dirty_at <= now() - interval '20 minutes'
    and (x.claimed_until is null or x.claimed_until < now())
    and x.company_id in (select co.id from public.companies co where mavi_private.temperature_route(co.id) is not null))
  and not exists (select 1 from mavi_private.temperature_state st where st.refresh_from is not null
   and mavi_private.temperature_refresh_due(st))
  and not exists (select 1 from mavi_private.temperature_state st
   join public.clients k on k.id = st.client_id and not k.archived
   where st.summary_pending and st.summary_attempts < 5
   and (st.summary_until is null or st.summary_until < now())) then
  return;
 end if;
 perform net.http_post(url := cfg.url, body := '{"action":"ai-temperature"}'::jsonb,
  headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || cfg.secret),
  timeout_milliseconds := 60000);
end $$;
revoke all on function mavi_private.ai_temperature_kick() from public, anon, authenticated;

commit;
