begin;

-- IA do MAVI · menos escrita no índice de vetores.
--
-- ai_store_embeddings era a consulta que mais pesava no banco (~40% do tempo,
-- ~12 ms por trecho). Gravar um vetor é caro por natureza: cada um entra no
-- grafo HNSW. O desperdício estava em quantas vezes isso acontecia:
--  1. qualquer mudança num documento apagava todos os trechos e gerava os
--     vetores de novo — o dia de um grupo do Whatsapp, a cada busca de 2 em 2
--     horas, refazia o dia inteiro; uma reunião que ganhava o resumo refazia
--     a transcrição toda. Agora os trechos com o mesmo texto ficam (com o
--     vetor): só o que é novo vai para a API e para o índice;
--  2. atualizar um trecho que fica (a posição mudou, o produto mudou) ou
--     reservá-lo para o worker não pode reescrever as entradas dos índices —
--     num UPDATE que não é HOT, o Postgres insere a linha de novo em todos
--     eles, inclusive no HNSW. Para ser HOT, nenhuma coluna indexada pode
--     mudar e a página precisa de espaço: o índice por documento deixa de
--     incluir a posição (os documentos têm poucos trechos) e a tabela passa a
--     deixar 15% de folga nas páginas;
--  3. um lote gravado duas vezes (reserva vencida e outro worker) não entra
--     no índice de novo.

-- (document_id) no lugar de (document_id, ord): mudar a posição fica HOT.
drop index public.ai_chunks_document;
create index ai_chunks_document on public.ai_chunks (document_id);
-- Vale para as páginas novas (as antigas ganham folga conforme o vacuum limpa).
alter table public.ai_chunks set (fillfactor = 85);

-- Grava o documento e os trechos, só quando o texto mudou. Trechos com o
-- mesmo texto são pareados (o n-ésimo igual com o n-ésimo igual) e mantidos;
-- os outros saem e os novos entram sem vetor.
create or replace function mavi_private.ai_save_document(c uuid, p_type text, p_source uuid, p_access text,
 p_client uuid, p_contract uuid, p_project uuid, p_task uuid, p_title text, p_at timestamptz, p_header text,
 p_pieces jsonb)
returns void
language plpgsql security definer set search_path = '' as $$
declare v_hash text; v_doc uuid; v_old text; begin
 v_hash := md5(p_header || p_pieces::text || coalesce(p_client::text, '') || coalesce(p_contract::text, '')
  || coalesce(p_project::text, ''));
 select id, content_hash into v_doc, v_old from public.ai_documents
  where company_id = c and source_type = p_type and source_id = p_source;
 if v_old = v_hash then return; end if;
 if v_doc is null then
  insert into public.ai_documents(company_id, source_type, source_id, access, client_id, contract_id, project_id,
   task_id, title, occurred_at, content_hash)
  values (c, p_type, p_source, p_access, p_client, p_contract, p_project, p_task, left(p_title, 300), p_at, v_hash)
  returning id into v_doc;
 else
  update public.ai_documents set access = p_access, client_id = p_client, contract_id = p_contract,
   project_id = p_project, task_id = p_task, title = left(p_title, 300), occurred_at = p_at,
   content_hash = v_hash, indexed_at = now()
  where id = v_doc;
 end if;
 with fresh as (
  select (p.n - 1)::integer as ord, p_header || E'\n' || (p.v->>'text') as content,
   coalesce(p.v->'meta', '{}') as meta
  from jsonb_array_elements(p_pieces) with ordinality p(v, n)
  where length(btrim(p.v->>'text')) > 0),
 f as (select fresh.*, row_number() over (partition by content order by ord) as k from fresh),
 o as (select x.id, x.content, row_number() over (partition by x.content order by x.ord, x.id) as k
  from public.ai_chunks x where x.document_id = v_doc),
 pairs as (select o.id, f.ord, f.meta from f join o on o.content = f.content and o.k = f.k),
 kept as (
  update public.ai_chunks x set ord = p.ord, meta = p.meta, source_type = p_type, access = p_access,
   client_id = p_client, contract_id = p_contract, project_id = p_project, task_id = p_task, occurred_at = p_at
  from pairs p
  where x.id = p.id
   and (x.ord, x.meta, x.source_type, x.access, x.client_id, x.contract_id, x.project_id, x.task_id, x.occurred_at)
    is distinct from (p.ord, p.meta, p_type, p_access, p_client, p_contract, p_project, p_task, p_at)),
 gone as (
  delete from public.ai_chunks x
  where x.document_id = v_doc and not exists (select 1 from pairs p where p.id = x.id))
 insert into public.ai_chunks(company_id, document_id, ord, content, meta, source_type, access, client_id,
  contract_id, project_id, task_id, occurred_at)
 select c, v_doc, f.ord, f.content, f.meta, p_type, p_access, p_client, p_contract, p_project, p_task, p_at
 from f where not exists (select 1 from pairs p where p.ord = f.ord);
end $$;
revoke all on function mavi_private.ai_save_document(uuid, text, uuid, text, uuid, uuid, uuid, uuid, text,
 timestamptz, text, jsonb) from public, anon, authenticated;

-- Só trechos ainda sem vetor: o texto de um trecho nunca muda (texto novo é
-- trecho novo), então um vetor já gravado não precisa entrar no índice de novo.
create or replace function public.ai_store_embeddings(p_secret text, p_model text, p_items jsonb) returns integer
language plpgsql security definer set search_path = '' as $$
declare n integer; begin
 if not mavi_private.ai_secret_ok(p_secret) then raise exception 'Sem permissão' using errcode = '42501'; end if;
 update public.ai_chunks c set embedding = (i->>'embedding')::extensions.halfvec(1536),
  embedding_model = left(p_model, 80), claimed_at = null
 from jsonb_array_elements(p_items) i where c.id = (i->>'id')::bigint and c.embedding is null;
 get diagnostics n = row_count;
 return n;
end $$;
revoke all on function public.ai_store_embeddings(text, text, jsonb) from public, anon, authenticated;
grant execute on function public.ai_store_embeddings(text, text, jsonb) to anon, authenticated;

commit;
