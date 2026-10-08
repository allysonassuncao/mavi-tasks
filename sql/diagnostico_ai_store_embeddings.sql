-- ai_store_embeddings ainda passa de 3 s com lotes de 16: espera por
-- bloqueio (outro processo mexendo nos mesmos trechos) ou disco lento (o
-- índice de vetores maior que a memória)? Rode as partes separadas.

-- PARTE 1 (só leitura): tamanho do índice de vetores × memória do banco, e o
-- tempo das chamadas registradas (as que estouraram não entram na média).
select 'índice de vetores (HNSW)' as item, pg_size_pretty(pg_relation_size('public.ai_chunks_embedding')) as valor
union all select 'tabela ai_chunks', pg_size_pretty(pg_total_relation_size('public.ai_chunks'))
union all select 'trechos com vetor', count(*)::text from public.ai_chunks where embedding is not null
union all select 'shared_buffers (memória do banco)', current_setting('shared_buffers')
union all select 'effective_cache_size', current_setting('effective_cache_size');

-- PARTE 2 (mede e DESFAZ): grava um vetor emprestado em até 32 trechos
-- pendentes, um por um, desistindo de quem estiver bloqueado em 200 ms.
-- O resultado aparece na aba Messages como ERROR "medição: …"; nada fica gravado.
do $$
declare v extensions.halfvec(1536); r record; t0 timestamptz; ms numeric; n integer := 0; locked integer := 0;
 total numeric := 0; worst numeric := 0; slow integer := 0; begin
 select embedding into v from public.ai_chunks where embedding is not null limit 1;
 set local lock_timeout = '200ms';
 for r in select id from public.ai_chunks where embedding is null order by id limit 32 loop
  t0 := clock_timestamp();
  begin
   update public.ai_chunks set embedding = v where id = r.id;
   ms := extract(epoch from clock_timestamp() - t0) * 1000;
   n := n + 1; total := total + ms; worst := greatest(worst, ms);
   if ms > 200 then slow := slow + 1; end if;
  exception when lock_not_available then
   locked := locked + 1;
  end;
 end loop;
 raise exception 'medição: % gravados em % ms (média % ms, pior % ms, % acima de 200 ms); % bloqueados por outro processo. (Desfeito, nada gravado.)',
  n, round(total), round(total / greatest(n, 1)), round(worst), slow, locked;
end $$;

-- PARTE 3 (só leitura): quem está mexendo em ai_chunks agora (rode algumas
-- vezes; linhas com wait_event_type = 'Lock' são esperas por bloqueio).
select pid, state, wait_event_type, wait_event, round(extract(epoch from now() - query_start)::numeric, 1) as segundos,
 left(regexp_replace(query, '\s+', ' ', 'g'), 120) as consulta
from pg_stat_activity
where query ilike '%ai_%' and pid <> pg_backend_pid() and state <> 'idle'
order by query_start;
