-- Termômetro: as ~960 leituras "prontas na fila" que o worker não pega
-- (ele responde "signals":0). O worker só pega leituras de clientes não
-- arquivados e que não estejam reservadas. Só leitura.

select
 case when k.id is null then 'cliente apagado'
      when k.archived then 'cliente arquivado'
      else 'cliente ativo' end as cliente,
 case when x.claimed_until > now() then 'reservada até ' || to_char(max(x.claimed_until), 'DD/MM HH24:MI')
      else 'livre' end as reserva,
 x.source_type,
 count(*) as leituras,
 count(distinct x.client_id) as clientes,
 min(x.day) as dia_mais_antigo,
 max(x.day) as dia_mais_novo
from public.temperature_signals x
left join public.clients k on k.id = x.client_id
where x.status = 'pending' and x.dirty_at <= now() - interval '20 minutes'
group by 1, (x.claimed_until > now()), x.source_type
order by leituras desc;
