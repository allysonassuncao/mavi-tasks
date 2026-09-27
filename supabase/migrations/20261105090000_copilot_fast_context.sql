begin;

-- Assistente MAVI · contexto rápido e só com o que tem a ver.
--
-- O contexto do copiloto usava a busca híbrida geral (ai_search) até quatro
-- vezes por análise. A parte de texto dela junta as palavras com OU e ordena
-- todos os trechos que tenham qualquer uma: num rascunho com palavras comuns
-- ("campanha", "Meta", "Ads", "criativos") e nos cases (busca na empresa
-- toda) isso estourava o tempo do banco (statement timeout). E um trecho
-- achado só por palavra — o "Ads" do produto no cabeçalho — aparecia como
-- tarefa ou case relacionado sem ter nada a ver.
--
-- Agora o copiloto faz as suas próprias buscas, só por vetor e com a
-- distância exata, dentro do cliente (tarefas e histórico) ou só entre os
-- cases: poucos milhares de linhas por cliente, pelo índice (company_id,
-- client_id, occurred_at), em milissegundos. Toda tarefa e case volta com a
-- semelhança; o servidor mostra só os que passam do mínimo, e a análise da
-- MAVI confirma quais têm a ver de fato.
--
-- As permissões são as mesmas: histórico só para quem atende o cliente (ou
-- líder); Social Leads pela regra do produto; tarefas dos colegas que a
-- pessoa não abre, só com título e status.

create or replace function public.task_copilot_context(p_company uuid, p_contract uuid, p_task uuid, p_embedding text,
 p_query text, p_review boolean default false) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_client uuid; v_product text; v_client_name text; v_product_id uuid; v_vec extensions.halfvec(1536);
 v_similar jsonb := '[]'; v_cases jsonb := '[]'; v_evidence jsonb := '[]'; s mavi_private.client_dossier_state;
 v_leader boolean; v_reader boolean; v_visible uuid[]; v_contracts uuid[]; begin
 if not mavi_private.member(p_company) then raise exception 'Sem acesso' using errcode = '42501'; end if;
 if p_task is not null then
  if not mavi_private.task_access(p_company, p_task) then
   raise exception 'Sem acesso a esta tarefa.' using errcode = '42501';
  end if;
  select t.contract_id into p_contract from public.tasks t where t.company_id = p_company and t.id = p_task;
 end if;
 select ct.client_id, p.name, k.name, ct.product_id into v_client, v_product, v_client_name, v_product_id
 from public.contracts ct
 join public.products p on p.company_id = ct.company_id and p.id = ct.product_id
 join public.clients k on k.company_id = ct.company_id and k.id = ct.client_id
 where ct.company_id = p_company and ct.id = p_contract;
 if v_client is null then raise exception 'Produto não encontrado.' using errcode = 'P0002'; end if;
 v_leader := mavi_private.leader(p_company);
 v_reader := mavi_private.dossier_reader(p_company, v_client);
 if p_task is null and not v_reader then
  raise exception 'Sem acesso a este cliente.' using errcode = '42501';
 end if;
 if p_review and (select count(*) from public.ai_usage u where u.company_id = p_company and u.user_id = auth.uid()
   and u.kind = 'copilot' and u.created_at > now() - interval '1 minute') >= 12 then
  return jsonb_build_object('throttled', true);
 end if;
 if nullif(p_embedding, '') is not null then v_vec := p_embedding::extensions.halfvec(1536); end if;
 if not v_leader then v_visible := mavi_private.ai_visible_tasks(p_company); end if;

 if v_vec is not null then
  -- Tarefas do cliente (as dos colegas só para quem atende o cliente). O
  -- "materialized" garante a distância exata sobre as linhas do cliente, em
  -- vez do índice vetorial da empresa toda filtrado depois.
  select coalesce(jsonb_agg(x order by (x->>'similarity')::numeric desc), '[]') into v_similar from (
   select case when b.restricted
    then jsonb_build_object('id', b.id, 'title', t.title, 'status', t.status, 'restricted', true,
     'similarity', round(b.sim::numeric, 3))
    else jsonb_build_object('id', b.id, 'title', t.title, 'status', t.status, 'restricted', false,
     'assignee', t.assignee_id, 'due', t.due_date, 'date', b.occurred_at,
     'snippet', left(btrim(regexp_replace(b.content, '^[^\n]*\n', '')), 400),
     'similarity', round(b.sim::numeric, 3)) end as x
   from (
    select distinct on (c.task_id) c.task_id as id, c.content, c.occurred_at,
     1 - (c.embedding operator(extensions.<=>) v_vec) as sim,
     (v_visible is not null and not (c.task_id = any(v_visible))) as restricted
    from (
     with cand as materialized (
      select x.task_id, x.content, x.occurred_at, x.embedding from public.ai_chunks x
      where x.company_id = p_company and x.client_id = v_client and x.source_type = 'task'
       and x.embedding is not null and x.task_id is not null and x.task_id is distinct from p_task
      order by x.occurred_at desc nulls last limit 20000
     ) select * from cand
    ) c
    where v_reader or v_leader or c.task_id = any(v_visible)
    order by c.task_id, c.embedding operator(extensions.<=>) v_vec
   ) b
   join public.tasks t on t.company_id = p_company and t.id = b.id and not t.archived
   order by b.sim desc limit 6
  ) z;

  -- Cases de sucesso aprovados (de qualquer cliente: trechos sem cliente).
  select coalesce(jsonb_agg(x order by (x->>'similarity')::numeric desc), '[]') into v_cases from (
   select jsonb_build_object('id', b.source_id, 'title', b.title, 'date', b.occurred_at,
    'snippet', left(btrim(regexp_replace(b.content, '^[^\n]*\n', '')), 500),
    'similarity', round(b.sim::numeric, 3)) as x
   from (
    select distinct on (d.source_id) d.source_id, d.title, c.content, c.occurred_at,
     1 - (c.embedding operator(extensions.<=>) v_vec) as sim
    from (
     with cand as materialized (
      select x.document_id, x.content, x.occurred_at, x.embedding from public.ai_chunks x
      where x.company_id = p_company and x.client_id is null and x.source_type = 'success_case'
       and x.embedding is not null
     ) select * from cand
    ) c
    join public.ai_documents d on d.id = c.document_id
    order by d.source_id, c.embedding operator(extensions.<=>) v_vec
   ) b
   order by b.sim desc limit 3
  ) z;

  -- Na análise: os trechos do histórico do cliente mais próximos do rascunho.
  if p_review and (v_reader or v_leader) then
   v_contracts := mavi_private.ai_visible_contracts(p_company);
   select coalesce(jsonb_agg(jsonb_build_object('type', b.source_type, 'id', d.source_id, 'title', d.title,
     'date', b.occurred_at, 'meta', b.meta, 'contract', b.contract_id, 'content', left(b.content, 1400),
     'similarity', round(b.sim::numeric, 3)) order by b.sim desc), '[]') into v_evidence
   from (
    select c.*, 1 - (c.embedding operator(extensions.<=>) v_vec) as sim from (
     with cand as materialized (
      select x.document_id, x.source_type, x.content, x.meta, x.contract_id, x.occurred_at, x.embedding, x.access
      from public.ai_chunks x
      where x.company_id = p_company and x.client_id = v_client and x.embedding is not null
       and x.source_type in ('meeting', 'whatsapp', 'drive_file', 'social_briefing', 'social_plan', 'campaign')
      order by x.occurred_at desc nulls last limit 30000
     ) select * from cand
    ) c
    where c.access = 'client' or (c.access = 'contract' and c.contract_id = any(v_contracts))
     or (c.access = 'leader' and v_leader)
    order by c.embedding operator(extensions.<=>) v_vec limit 10
   ) b
   join public.ai_documents d on d.id = b.document_id;
  end if;
 end if;

 if p_review then
  perform mavi_private.dossier_want(p_company, v_client);
  select * into s from mavi_private.client_dossier_state where client_id = v_client;
 end if;

 return jsonb_build_object('throttled', false,
  'client', jsonb_build_object('id', v_client, 'name', v_client_name), 'contract', p_contract, 'product', v_product,
  'similar', v_similar, 'cases', v_cases, 'evidence', v_evidence,
  'dossier', case when p_review then jsonb_build_object('version', coalesce(s.version, 0), 'built_at', s.built_at,
   'items', mavi_private.dossier_items_json(v_client, false)) end,
  'lessons', case when p_review then mavi_private.copilot_lessons_for(p_company, v_product_id, v_client) end);
end $$;

revoke all on function public.task_copilot_context(uuid, uuid, uuid, text, text, boolean) from public, anon;
grant execute on function public.task_copilot_context(uuid, uuid, uuid, text, text, boolean) to authenticated;

commit;
