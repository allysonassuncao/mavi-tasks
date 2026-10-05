begin;

-- Busca da MAVI: gravar os vetores passava às vezes dos 3 s do banco (o
-- worker fala como anon). Cada vetor entra no índice HNSW, que em 05/10/2026
-- tinha 563 MB para 256 MB de shared_buffers: a gravação lê páginas do disco
-- e o tempo varia muito (64 vetores levaram 2,3 s; 16 ainda estouravam às
-- vezes). Estourar perdia o lote inteiro, já pago na OpenAI, e os trechos
-- esperavam 5 minutos pela reserva vencer. Agora a gravação para depois de
-- 1,5 s e solta na hora os trechos que faltaram: a próxima reserva já os
-- pega. Devolve, como antes, quantos vetores gravou.
create or replace function public.ai_store_embeddings(p_secret text, p_model text, p_items jsonb) returns integer
language plpgsql security definer set search_path = '' as $$
declare i jsonb; n integer := 0; k integer; t0 timestamptz := clock_timestamp(); v_left bigint[] := '{}'; begin
 if not mavi_private.ai_secret_ok(p_secret) then raise exception 'Sem permissão' using errcode = '42501'; end if;
 for i in select x from jsonb_array_elements(case when jsonb_typeof(p_items) = 'array' then p_items else '[]' end) x
 loop
  continue when coalesce(i->>'id', '') !~ '^[0-9]+$';
  if clock_timestamp() - t0 > interval '1500 milliseconds' then
   v_left := v_left || (i->>'id')::bigint;
   continue;
  end if;
  update public.ai_chunks c set embedding = (i->>'embedding')::extensions.halfvec(1536),
   embedding_model = left(p_model, 80), claimed_at = null
  where c.id = (i->>'id')::bigint and c.embedding is null;
  get diagnostics k = row_count;
  n := n + k;
 end loop;
 if cardinality(v_left) > 0 then
  update public.ai_chunks set claimed_at = null where id = any(v_left) and embedding is null;
 end if;
 return n;
end $$;
revoke all on function public.ai_store_embeddings(text, text, jsonb) from public, anon, authenticated;
grant execute on function public.ai_store_embeddings(text, text, jsonb) to anon, authenticated;

commit;
