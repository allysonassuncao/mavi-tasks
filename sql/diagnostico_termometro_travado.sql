-- Diagnóstico: o Termômetro tem ~960 leituras prontas na fila e o worker não
-- termina nenhuma. Só leitura. Uma consulta só (o pgAdmin mostra apenas o
-- último resultado).

select * from (
 -- O que o worker respondeu nas últimas horas (o pg_net guarda ~6 h). O do
 -- Termômetro responde {"signals":…,"failed":…,"skipped":…} ou {"error":…}.
 select 1 as ord, to_char(r.created, 'DD/MM HH24:MI') || ' · http ' || coalesce(r.status_code::text, '-') ||
   case when r.timed_out then ' · tempo esgotado' else '' end as item,
  left(coalesce(r.error_msg, '') || ' ' || coalesce(r.content, ''), 300) as valor
 from net._http_response r
 where r.content ilike '%signals%' or r.content ilike '%termômetro%' or r.content ilike '%Jev%'
  or r.content ilike '%error%' or r.error_msg is not null or r.timed_out
 union all
 -- As leituras na fila: reservadas agora, com tentativas, com erro
 select 2, 'fila: total pendentes', count(*)::text
 from public.temperature_signals where status = 'pending'
 union all
 select 2, 'fila: reservadas agora (claimed_until no futuro)', count(*)::text
 from public.temperature_signals where status = 'pending' and claimed_until > now()
 union all
 select 2, 'fila: já reservadas alguma vez desde 04/10', count(*)::text
 from public.temperature_signals where status = 'pending' and claimed_at >= '2026-10-04'
 union all
 select 2, 'fila: com tentativas > 0', count(*)::text
 from public.temperature_signals where status = 'pending' and attempts > 0
 union all
 select 2, 'fila: última reserva', coalesce(max(claimed_at)::text, '-')
 from public.temperature_signals where status = 'pending'
 union all
 select 2, 'fila: dirty_at mais antigo / mais novo', min(dirty_at)::text || ' / ' || max(dirty_at)::text
 from public.temperature_signals where status = 'pending'
 union all
 -- Os erros mais comuns das leituras (se houver)
 select 3, 'erro (' || count(*) || ')', left(last_error, 300)
 from public.temperature_signals where last_error is not null group by last_error
 union all
 -- O endereço que o pg_cron chama (só o domínio)
 select 4, 'worker url', substring(url from '^https?://[^/]+') from mavi_private.ai_config where id
 union all
 -- Mudanças na configuração do Termômetro (refaz as leituras)
 select 5, 'configuração do Termômetro: versão / alterada em', version::text || ' / ' || updated_at::text
 from public.temperature_settings
) d order by ord, item desc;
