-- Campanhas › detalhe: as rotinas desta campanha que estão falhando.
--
-- O aviso "Ainda falhando: Insights da MAVI nas campanhas · <campanha>" só
-- chega para quem o admin escolheu em Avisos de falhas. A mesma informação
-- (mavi_private.job_failures, gravada por mavi_private.job_report) passa a
-- aparecer numa faixa no detalhe da campanha, para todos que a veem.
--
-- Rotinas por campanha: sincronização diária, resultados de hoje, Insights e
-- Leitura do dia da MAVI. A faixa aparece quando o aviso sairia (as N falhas
-- seguidas de Avisos de falhas, ou o padrão da rotina), some quando a rotina
-- volta a funcionar e não aparece em campanha inativa/arquivada nem com erro
-- de mais de 15 dias (a rotina parou de rodar para ela).
--
-- Realtime: cada mudança em job_failures dessas rotinas avisa a tela
-- ({kind: 'campaign_jobs', campaign}), sem polling.

create function public.campaign_job_failures(p_company uuid, p_campaign uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$ begin
 if not mavi_private.campaign_insight_reader(p_company, p_campaign) then
  raise exception 'Sem permissão' using errcode = '42501';
 end if;
 if not exists (select 1 from public.ad_campaigns a where a.company_id = p_company and a.id = p_campaign
  and a.status = 'active' and not a.archived) then
  return '[]'::jsonb;
 end if;
 return coalesce((select jsonb_agg(jsonb_build_object('job', f.job, 'label', k.label, 'since', f.since,
    'streak', f.streak, 'error', f.last_error, 'error_at', f.last_error_at) order by k.sort)
  from mavi_private.job_failures f
  join mavi_private.job_catalog() k on k.job = f.job
  left join public.job_alert_settings s on s.company_id = f.company_id and s.job = f.job
  where f.company_id = p_company and f.subject = p_campaign::text
   and f.job in ('ads_sync', 'ads_today', 'campaign_insights', 'campaign_daily')
   and f.recovered_at is null and f.streak > 0
   and f.streak >= coalesce(s.fail_after, k.fail_after, 1)
   and f.last_error_at > now() - interval '15 days'), '[]'::jsonb);
end $$;
revoke all on function public.campaign_job_failures(uuid, uuid) from public, anon;
grant execute on function public.campaign_job_failures(uuid, uuid) to authenticated;

create function mavi_private.broadcast_campaign_job() returns trigger
language plpgsql security definer set search_path = '' as $$
declare f mavi_private.job_failures; begin
 if tg_op = 'DELETE' then f := old; else f := new; end if;
 if f.job in ('ads_sync', 'ads_today', 'campaign_insights', 'campaign_daily') and f.subject <> '' then
  perform mavi_private.broadcast(f.company_id, jsonb_build_object('kind', 'campaign_jobs', 'campaign', f.subject));
 end if;
 return null;
end $$;
revoke all on function mavi_private.broadcast_campaign_job() from public, anon, authenticated;
create trigger broadcast_campaign_job after insert or update or delete on mavi_private.job_failures
 for each row execute function mavi_private.broadcast_campaign_job();
