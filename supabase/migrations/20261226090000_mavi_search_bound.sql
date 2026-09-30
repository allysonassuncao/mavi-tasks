begin;

-- MAVI · a busca geral (ai_search) sem estourar o tempo do banco.
--
-- A parte de texto juntava as palavras com OU e ordenava todos os trechos da
-- empresa que tivessem qualquer uma. Numa busca sem cliente e com palavras
-- comuns ("MakeCRM marca logo cores fonte identidade visual"), milhares de
-- trechos batiam e a busca caía por statement timeout — na MAVI, o passo
-- "Buscando … · falhou". (O copiloto já tinha saído dela pelo mesmo motivo:
-- 20261105090000.)
--
-- Agora o texto busca com todas as palavras (E) e, só quando isso acha menos
-- trechos que o pedido, também com qualquer uma (OU); as duas listas entram
-- na fusão com a do vetor, e quem bate nas duas sobe. Cada lista ordena por
-- relevância um lote de até 2.000 trechos que batem, não todos. Vetor,
-- permissões e formato do resultado não mudam.

create or replace function public.ai_search(p_company uuid, p_embedding text, p_query text, p_filters jsonb default '{}',
 p_limit integer default 12)
returns table(chunk_id bigint, document_id uuid, source_type text, source_id uuid, title text, content text,
 meta jsonb, client_id uuid, contract_id uuid, project_id uuid, occurred_at timestamptz, score double precision,
 task_status text, task_assignee uuid, task_due date)
language plpgsql volatile security definer set search_path = '' as $$
declare
 v_leader boolean; v_clients uuid[]; v_tasks uuid[]; v_contracts uuid[]; v_vec extensions.halfvec(1536); v_tq tsquery;
 f_client uuid; f_contract uuid; f_project uuid; f_task uuid; f_types text[]; f_from timestamptz; f_to timestamptz;
 v_k integer; v_limit integer; v_any tsquery; v_hits integer;
begin
 if not mavi_private.member(p_company) then raise exception 'Sem acesso' using errcode = '42501'; end if;
 v_leader := mavi_private.leader(p_company);
 if not v_leader then
  v_clients := mavi_private.ai_visible_clients(p_company);
  v_tasks := mavi_private.ai_visible_tasks(p_company);
 end if;
 -- Social Leads segue o contract_read (gestores fora das equipes não veem).
 v_contracts := mavi_private.ai_visible_contracts(p_company);
 f_client := nullif(p_filters->>'client', '')::uuid;
 f_contract := nullif(p_filters->>'contract', '')::uuid;
 f_project := nullif(p_filters->>'project', '')::uuid;
 f_task := nullif(p_filters->>'task', '')::uuid;
 f_types := case when jsonb_typeof(p_filters->'types') = 'array'
  then array(select jsonb_array_elements_text(p_filters->'types')) end;
 f_from := nullif(p_filters->>'from', '')::timestamptz;
 f_to := nullif(p_filters->>'to', '')::timestamptz;
 v_limit := least(greatest(coalesce(p_limit, 12), 1), 40);
 v_k := greatest(v_limit * 4, 40);
 if nullif(p_embedding, '') is not null then v_vec := p_embedding::extensions.halfvec(1536); end if;
 -- Texto: com todas as palavras (E); com qualquer uma (OU) só quando o E acha
 -- pouco. Com OU e palavras comuns ("marca", "cores"), milhares de trechos
 -- batem, e ordenar todos estourava o tempo do banco.
 v_tq := nullif(plainto_tsquery('portuguese'::regconfig, left(coalesce(p_query, ''), 500))::text, '')::tsquery;
 if v_tq is not null and numnode(v_tq) > 1 then
  select count(*) into v_hits from (select 1 from public.ai_chunks c
   where c.company_id = p_company and c.search @@ v_tq limit v_limit) x;
  if v_hits < v_limit then v_any := replace(v_tq::text, ' & ', ' | ')::tsquery; end if;
 end if;
 begin
  perform set_config('hnsw.iterative_scan', 'relaxed_order', true);
  perform set_config('hnsw.ef_search', '100', true);
 exception when others then null;
 end;
 -- O filtro se repete nas duas buscas de propósito: um CTE compartilhado
 -- seria materializado e o índice vetorial deixaria de ser usado.
 return query
 with vec as (
  select s.id, row_number() over () as rn from (
   select c.id from public.ai_chunks c
   where v_vec is not null and c.embedding is not null and c.company_id = p_company
    and (f_client is null or c.client_id = f_client)
    and (f_contract is null or c.contract_id = f_contract)
    and (f_project is null or c.project_id = f_project)
    and (f_task is null or c.task_id = f_task)
    and (f_types is null or c.source_type = any(f_types))
    and (f_from is null or c.occurred_at >= f_from)
    and (f_to is null or c.occurred_at < f_to + interval '1 day')
    and ((c.access = 'client' and (v_leader or c.client_id is null or c.client_id = any(v_clients)))
     or (c.access = 'task' and (v_leader or c.task_id = any(v_tasks)))
     or (c.access = 'contract' and c.contract_id = any(v_contracts))
     or (c.access = 'leader' and v_leader))
   order by c.embedding operator(extensions.<=>) v_vec limit v_k) s
 ),
 txt as (
  select s.id, row_number() over () as rn from (
   select p.id from (
   select c.id, c.search from public.ai_chunks c
   where v_tq is not null and c.search @@ v_tq and c.company_id = p_company
    and (f_client is null or c.client_id = f_client)
    and (f_contract is null or c.contract_id = f_contract)
    and (f_project is null or c.project_id = f_project)
    and (f_task is null or c.task_id = f_task)
    and (f_types is null or c.source_type = any(f_types))
    and (f_from is null or c.occurred_at >= f_from)
    and (f_to is null or c.occurred_at < f_to + interval '1 day')
    and ((c.access = 'client' and (v_leader or c.client_id is null or c.client_id = any(v_clients)))
     or (c.access = 'task' and (v_leader or c.task_id = any(v_tasks)))
     or (c.access = 'contract' and c.contract_id = any(v_contracts))
     or (c.access = 'leader' and v_leader))
   limit 2000) p
   order by ts_rank_cd(p.search, v_tq) desc limit v_k) s
 ),
 txt_any as (
  select s.id, row_number() over () as rn from (
   select p.id from (
   select c.id, c.search from public.ai_chunks c
   where v_any is not null and c.search @@ v_any and c.company_id = p_company
    and (f_client is null or c.client_id = f_client)
    and (f_contract is null or c.contract_id = f_contract)
    and (f_project is null or c.project_id = f_project)
    and (f_task is null or c.task_id = f_task)
    and (f_types is null or c.source_type = any(f_types))
    and (f_from is null or c.occurred_at >= f_from)
    and (f_to is null or c.occurred_at < f_to + interval '1 day')
    and ((c.access = 'client' and (v_leader or c.client_id is null or c.client_id = any(v_clients)))
     or (c.access = 'task' and (v_leader or c.task_id = any(v_tasks)))
     or (c.access = 'contract' and c.contract_id = any(v_contracts))
     or (c.access = 'leader' and v_leader))
   limit 2000) p
   order by ts_rank_cd(p.search, v_any) desc limit v_k) s
 ),
 fused as (
  select u.id, sum(1.0 / (60 + u.rn)) as score from (select * from vec union all select * from txt union all select * from txt_any) u
  group by u.id order by score desc limit v_limit
 )
 select c.id, c.document_id, c.source_type, d.source_id, d.title, c.content, c.meta, c.client_id, c.contract_id,
  c.project_id, c.occurred_at, f.score::double precision, t.status, t.assignee_id, t.due_date
 from fused f
 join public.ai_chunks c on c.id = f.id
 join public.ai_documents d on d.id = c.document_id
 left join public.tasks t on t.company_id = c.company_id and t.id = c.task_id
 order by f.score desc;
end $$;

commit;
