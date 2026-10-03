begin;

-- Radar do cliente › item: vincular tarefas que já existem (03/10/2026).
--
-- Ao lado de "Criar tarefa", o painel do item ganha "Vincular tarefa":
-- - radar_link_candidates: sem termo, as tarefas do cliente do item (as que
--   não foram entregues primeiro); com termo, pelo título em tudo o que a
--   pessoa vê, as do cliente primeiro. Com a sessão da pessoa (RLS das
--   tarefas), só ids e colunas da lista.
-- - radar_task_suggestions: as tarefas parecidas com o item, pela mesma
--   busca por significado da Busca avançada (search_task_meaning). O vetor do
--   item é guardado com o texto de onde saiu (título + resumo): sem vetor, ou
--   com o texto mudado, volta {embed: true} e a API (ação radar-task-suggest
--   de /api/drive) o gera e chama de novo com p_embedding.
-- - unlink_radar_task: desfaz a ligação; a tarefa não muda.
-- Quem vincula e desvincula é quem edita o item (module_client), como em
-- link_radar_task (20270107090000), que continua sendo a ligação.

alter table public.radar_items add column if not exists link_embedding extensions.halfvec(1536),
 add column if not exists link_embedding_text text;

-- ------------------------------------------------------------ desvincular
create function public.unlink_radar_task(p_company uuid, p_item uuid, p_task uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare v_client uuid; begin
 select client_id into v_client from public.radar_items where company_id = p_company and id = p_item;
 if not found then raise exception 'Item não encontrado.' using errcode = 'P0002'; end if;
 if not mavi_private.module_client(p_company, 'radar', v_client) then
  raise exception 'Sem permissão' using errcode = '42501';
 end if;
 delete from public.radar_item_tasks where company_id = p_company and item_id = p_item and task_id = p_task;
end $$;
revoke all on function public.unlink_radar_task(uuid, uuid, uuid) from public, anon;
grant execute on function public.unlink_radar_task(uuid, uuid, uuid) to authenticated;

-- ------------------------------------------------------------ a busca
create function public.radar_link_candidates(p_company uuid, p_client uuid, p_query text default '',
 p_exclude uuid[] default '{}', p_limit integer default 40)
returns table(task jsonb, same_client boolean)
language sql stable security invoker set search_path = '' as $$
 with q as (select nullif(mavi_private.fold(btrim(coalesce(p_query, ''))), '') as term),
 pat as (
  select '%' || replace(replace(replace(q.term, '\', '\\'), '%', '\%'), '_', '\_') || '%' as p
  from q where length(q.term) >= 2),
 titled as (
  select s.task_id from mavi_private.task_search_texts s, pat
  where s.company_id = p_company and s.source = 'title' and s.folded like pat.p)
 select to_jsonb(t) - array['description', 'custom_fields'], coalesce(k.client_id = p_client, false)
 from public.tasks t
 left join public.contracts k on k.company_id = t.company_id and k.id = t.contract_id
 where t.company_id = p_company and not t.archived
  and not (t.id = any(coalesce(p_exclude, '{}')))
  and case when exists (select 1 from pat) then t.id in (select task_id from titled)
   else k.client_id = p_client end
 order by coalesce(k.client_id = p_client, false) desc, t.status = 'done',
  coalesce(t.delivered_at, t.created_at) desc, t.id
 limit least(greatest(coalesce(p_limit, 40), 1), 100)
$$;
revoke all on function public.radar_link_candidates(uuid, uuid, text, uuid[], integer) from public, anon;
grant execute on function public.radar_link_candidates(uuid, uuid, text, uuid[], integer) to authenticated;

-- ------------------------------------------------------------ parecidas
-- Até 5 tarefas, as mais próximas (o cliente do item conta um pouco a mais),
-- sem as já ligadas. search_task_meaning só traz o que a pessoa enxerga.
create function public.radar_task_suggestions(p_company uuid, p_item uuid, p_embedding text default null)
returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare i public.radar_items; v_text text; v_vec extensions.halfvec(1536); v_out jsonb; begin
 select * into i from public.radar_items where company_id = p_company and id = p_item;
 if not found then raise exception 'Item não encontrado.' using errcode = 'P0002'; end if;
 if not mavi_private.module_client(p_company, 'radar', i.client_id) then
  raise exception 'Sem permissão' using errcode = '42501';
 end if;
 v_text := left(btrim(i.title || E'\n' || coalesce(i.summary, '')), 2000);
 if nullif(p_embedding, '') is not null then
  v_vec := p_embedding::extensions.halfvec(1536);
  update public.radar_items set link_embedding = v_vec, link_embedding_text = v_text where id = i.id;
 elsif i.link_embedding is not null and i.link_embedding_text = v_text then
  v_vec := i.link_embedding;
 else
  return jsonb_build_object('embed', true, 'text', v_text);
 end if;
 with near as (
  select m.task_id, m.similarity + case when k.client_id = i.client_id then 0.05 else 0 end as score,
   m.similarity
  from public.search_task_meaning(p_company, v_vec::text, null, null, 150) m
  join public.tasks t on t.id = m.task_id and t.company_id = p_company and not t.archived
  left join public.contracts k on k.company_id = t.company_id and k.id = t.contract_id
  where not exists (select 1 from public.radar_item_tasks rt where rt.item_id = i.id and rt.task_id = m.task_id)),
 top as (select max(similarity) as best from near)
 select coalesce(jsonb_agg(jsonb_build_object('id', x.task_id, 'similarity', round(x.similarity::numeric, 3))
   order by x.score desc), '[]')
 into v_out
 from (select n.* from near n, top where n.similarity >= greatest(0.3, top.best - 0.12)
  order by n.score desc limit 5) x;
 return jsonb_build_object('tasks', v_out);
end $$;
revoke all on function public.radar_task_suggestions(uuid, uuid, text) from public, anon;
grant execute on function public.radar_task_suggestions(uuid, uuid, text) to authenticated;

commit;
