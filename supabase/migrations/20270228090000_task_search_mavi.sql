begin;

-- Tarefas · a MAVI na Busca avançada (pedido de 02/10/2026):
--
-- Toda busca com texto passa pela MAVI (ação "task-search" de /api/drive,
-- funcionalidade 'task_search' em Painel da MAVI › Quem usa qual modelo):
-- ela entende o pedido ("o que a Ana entregou de logo para a Clínica em
-- setembro"), preenche os filtros da tela, escreve os termos e as variações
-- que provavelmente aparecem no texto (logo, logotipo, identidade visual) e
-- o assunto, que vira um vetor para a busca por significado nas tarefas do
-- cérebro da MAVI (ai_chunks).
--
-- Aqui:
-- - search_task_meaning: as tarefas mais próximas do vetor, com a mesma
--   regra de quem vê da ai_search, e a semelhança (1 − distância do cosseno).
-- - search_task_rows_mavi: a search_task_rows com vários termos (qualquer um)
--   e o vetor, sob os filtros da tela. O navegador guarda os termos e o vetor
--   da MAVI: mudar um filtro depois roda só esta consulta, sem a MAVI.
-- - 'task_search' entra nas funcionalidades de ai_routes e de ai_set_route.

-- ------------------------------------------------------------ por significado
create function public.search_task_meaning(p_company uuid, p_embedding text, p_client uuid default null,
 p_project uuid default null, p_limit integer default 150)
returns table(task_id uuid, similarity double precision, content text)
language plpgsql volatile security definer set search_path = '' as $$
declare v_leader boolean; v_clients uuid[]; v_tasks uuid[]; v_vec extensions.halfvec(1536); v_k integer; begin
 if not mavi_private.member(p_company) then raise exception 'Sem acesso' using errcode = '42501'; end if;
 if nullif(p_embedding, '') is null then return; end if;
 v_vec := p_embedding::extensions.halfvec(1536);
 v_leader := mavi_private.leader(p_company);
 if not v_leader then
  v_clients := mavi_private.ai_visible_clients(p_company);
  v_tasks := mavi_private.ai_visible_tasks(p_company);
 end if;
 v_k := least(greatest(coalesce(p_limit, 150), 1), 300);
 begin
  perform set_config('hnsw.iterative_scan', 'relaxed_order', true);
  perform set_config('hnsw.ef_search', '200', true);
 exception when others then null;
 end;
 -- Os trechos mais próximos (o índice vetorial), e o melhor de cada tarefa.
 return query
 with near as (
  select c.task_id, c.content, c.embedding operator(extensions.<=>) v_vec as dist
  from public.ai_chunks c
  where c.company_id = p_company and c.source_type = 'task' and c.embedding is not null
   and c.task_id is not null
   and (p_client is null or c.client_id = p_client)
   and (p_project is null or c.project_id = p_project)
   and ((c.access = 'client' and (v_leader or c.client_id is null or c.client_id = any(v_clients)))
    or (c.access = 'task' and (v_leader or c.task_id = any(v_tasks))))
  order by c.embedding operator(extensions.<=>) v_vec limit v_k)
 select distinct on (n.task_id) n.task_id, (1 - n.dist)::double precision,
  -- Sem a primeira linha (o cabeçalho "[Tarefa] … · cliente … · produto …").
  btrim(substr(n.content, strpos(n.content, E'\n') + 1))
 from near n order by n.task_id, n.dist;
end $$;
revoke all on function public.search_task_meaning(uuid, text, uuid, uuid, integer) from public, anon;
grant execute on function public.search_task_meaning(uuid, text, uuid, uuid, integer) to authenticated;

-- ------------------------------------------------------------ a busca da MAVI
-- Os termos: qualquer um deles no título, na descrição (e nos áudios dela)
-- ou nos comentários (e nos áudios deles), como a search_task_rows. O vetor:
-- as tarefas próximas o bastante (semelhança de pelo menos 0,3 e a até 0,1
-- da melhor), sob os mesmos filtros. A relevância soma o lugar do termo
-- (título 1, descrição 0,7, comentário 0,5) e o significado (até 0,8); quem
-- bate nos dois sobe. Sem termos nem vetor, os filtros sozinhos listam.
create function public.search_task_rows_mavi(
 p_company uuid,
 p_terms text[] default '{}',
 p_embedding text default null,
 p_in text[] default array['title', 'description', 'comments'],
 p_client uuid default null,
 p_project uuid default null,
 p_assignee uuid default null,
 p_creator uuid default null,
 p_status text default null,
 p_from date default null,
 p_to date default null,
 p_priority boolean default false,
 p_limit integer default 2000,
 p_offset integer default 0)
returns table(task jsonb, match_in text, snippet text, comment_id uuid, rank integer, total bigint)
language sql volatile security invoker set search_path = '' as $$
 with terms as (
  select distinct x.term from (select mavi_private.fold(btrim(t)) as term
   from unnest(coalesce(p_terms, '{}')) t) x
  where length(x.term) >= 2),
 pats as (
  select t.term, '%' || replace(replace(replace(t.term, '\', '\\'), '%', '\%'), '_', '\_') || '%' as pat
  from (select term from terms order by length(term) desc, term limit 12) t),
 arr as (select coalesce(array_agg(pat), '{}') as pats from pats),
 base as (
  select t.* from public.tasks t
  left join public.contracts k on k.company_id = t.company_id and k.id = t.contract_id
  where t.company_id = p_company and not t.archived
   and (p_client is null or k.client_id = p_client)
   and (p_project is null or t.project_id = p_project)
   and (p_assignee is null or t.assignee_id = p_assignee)
   and (p_creator is null or t.creator_id = p_creator)
   and (coalesce(p_status, '') = '' or t.status = p_status)
   and (p_from is null or t.due_date >= p_from)
   and (p_to is null or t.due_date <= p_to)
   and (not coalesce(p_priority, false) or t.priority_weight > 0)),
 term_hits as (
  select b.id as task_id, 'title'::text as match_in, b.title as txt, null::uuid as comment_id, 1 as place,
   b.created_at as at
  from base b, arr a
  where cardinality(a.pats) > 0 and 'title' = any(p_in) and mavi_private.fold(b.title) like any(a.pats)
  union all
  select b.id, 'description', mavi_private.rich_plain(b.description), null, 2, b.created_at
  from base b, arr a
  where cardinality(a.pats) > 0 and 'description' = any(p_in)
   and mavi_private.fold(mavi_private.rich_plain(b.description)) like any(a.pats)
  union all
  select b.id, 'description', x.transcript, null, 2, x.created_at
  from base b join public.task_audios x on x.company_id = b.company_id and x.task_id = b.id and x.comment_id is null,
   arr a
  where cardinality(a.pats) > 0 and 'description' = any(p_in) and x.transcript is not null
   and mavi_private.fold(x.transcript) like any(a.pats)
  union all
  select b.id, 'comment', mavi_private.rich_plain(c.body), c.id, 3, c.created_at
  from base b join public.comments c on c.company_id = b.company_id and c.task_id = b.id, arr a
  where cardinality(a.pats) > 0 and 'comments' = any(p_in)
   and mavi_private.fold(mavi_private.rich_plain(c.body)) like any(a.pats)
  union all
  select b.id, 'comment', x.transcript, x.comment_id, 3, x.created_at
  from base b join public.task_audios x on x.company_id = b.company_id and x.task_id = b.id
   and x.comment_id is not null, arr a
  where cardinality(a.pats) > 0 and 'comments' = any(p_in) and x.transcript is not null
   and mavi_private.fold(x.transcript) like any(a.pats)),
 best_term as (
  select distinct on (h.task_id) h.* from term_hits h order by h.task_id, h.place, h.at desc),
 near as (
  select m.task_id, m.similarity, m.content
  from public.search_task_meaning(p_company, nullif(p_embedding, ''), p_client, p_project, 150) m
  where nullif(p_embedding, '') is not null and m.task_id in (select id from base)),
 top as (select max(similarity) as best from near),
 meaning as (
  select n.* from near n, top
  where n.similarity >= greatest(0.3, top.best - 0.1)),
 found as (
  select coalesce(t.task_id, m.task_id) as task_id,
   coalesce(t.match_in, 'meaning') as match_in, t.txt, t.comment_id, m.content,
   case when t.task_id is null then 0 when t.place = 1 then 1.0 when t.place = 2 then 0.7 else 0.5 end
    + coalesce(0.8 * m.similarity / nullif((select best from top), 0), 0) as score
  from best_term t full join meaning m on m.task_id = t.task_id
  union all
  -- Sem termos nem vetor: os filtros sozinhos.
  select b.id, 'filters', null, null, null, 0
  from base b, arr a
  where cardinality(a.pats) = 0 and nullif(p_embedding, '') is null)
 select to_jsonb(t) - array['description', 'custom_fields'], f.match_in,
  case
   when f.match_in = 'filters' then ''
   when f.match_in = 'meaning' then
    left(regexp_replace(f.content, '\s+', ' ', 'g'), 160)
     || case when length(regexp_replace(f.content, '\s+', ' ', 'g')) > 160 then '…' else '' end
   else coalesce(mavi_private.search_snippet(f.txt,
    (select p.term from pats p where mavi_private.fold(f.txt) like p.pat order by length(p.term) desc limit 1)), '')
  end,
  f.comment_id, (row_number() over (order by f.score desc, t.created_at desc, t.id))::integer, count(*) over ()
 from found f join public.tasks t on t.id = f.task_id
 order by f.score desc, t.created_at desc, t.id
 limit least(greatest(coalesce(p_limit, 2000), 1), 2000) offset greatest(coalesce(p_offset, 0), 0)
$$;
revoke all on function public.search_task_rows_mavi(uuid, text[], text, text[], uuid, uuid, uuid, uuid, text, date,
 date, boolean, integer, integer) from public, anon;
grant execute on function public.search_task_rows_mavi(uuid, text[], text, text[], uuid, uuid, uuid, uuid, text, date,
 date, boolean, integer, integer) to authenticated;

-- ------------------------------------------------------------ Quem usa qual modelo
alter table mavi_private.ai_routes drop constraint ai_routes_feature_check;
alter table mavi_private.ai_routes add constraint ai_routes_feature_check
 check ((scope_type = 'feature') = (feature is not null)
  and (feature is null or feature in ('assistant', 'meetings_history', 'meetings_ask',
   'whatsapp_task', 'social_leads_plan', 'social_leads_adjust', 'social_leads_briefing', 'social_leads_colors',
   'task_copilot', 'client_dossier', 'copilot_learning', 'notice_writer', 'notice_animation',
   'client_temperature', 'client_temperature_text', 'task_audio',
   'whatsapp_transcribe', 'task_audio_transcribe', 'image_generation', 'mavi_page', 'web_search', 'canvas_writer',
   'mavi_rerank', 'conversation_summary', 'skill_coach', 'whatsapp_history', 'client_radar', 'client_radar_check',
   'client_radar_themes', 'client_radar_report', 'mavi_learning', 'campaign_report', 'mavi_judge',
   'mavi_judge_check', 'task_title', 'dashboard_builder', 'campaign_alerts', 'task_search')));

-- A da migração 20270218090000, com a Busca avançada.
create or replace function public.ai_set_route(p_company uuid, p_type text, p_id uuid, p_provider uuid, p_model text,
 p_feature text default null) returns void
language plpgsql security definer set search_path = '' as $$
declare v_id uuid := case when p_type in ('company', 'feature') then null else p_id end;
 v_feature text := case when p_type = 'feature' then p_feature end; v_kind text; begin
 if not mavi_private.leader(p_company) then
  raise exception 'Só administradores e gestores escolhem qual IA cada um usa.' using errcode = '42501';
 end if;
 if p_type not in ('company', 'user', 'client', 'contract', 'project', 'feature', 'skill') then
  raise exception 'Tipo inválido.' using errcode = '22023';
 end if;
 if p_type not in ('company', 'feature') and p_id is null then
  raise exception 'Escolha para quem vale a regra.' using errcode = '22023';
 end if;
 if p_type = 'feature' and coalesce(v_feature, '') not in ('assistant', 'meetings_history', 'meetings_ask',
  'whatsapp_task', 'social_leads_plan', 'social_leads_adjust', 'social_leads_briefing', 'social_leads_colors',
  'task_copilot', 'client_dossier', 'copilot_learning', 'notice_writer', 'notice_animation',
  'client_temperature', 'client_temperature_text', 'task_audio',
  'whatsapp_transcribe', 'task_audio_transcribe', 'image_generation', 'mavi_page', 'web_search', 'canvas_writer',
  'mavi_rerank', 'conversation_summary', 'skill_coach', 'whatsapp_history', 'client_radar', 'client_radar_check',
  'client_radar_themes', 'client_radar_report', 'mavi_learning', 'campaign_report', 'mavi_judge',
  'mavi_judge_check', 'task_title', 'dashboard_builder', 'campaign_alerts', 'task_search') then
  raise exception 'Funcionalidade inválida.' using errcode = '22023';
 end if;
 if p_provider is null then
  delete from mavi_private.ai_routes where company_id = p_company and scope_type = p_type
   and scope_id is not distinct from v_id and feature is not distinct from v_feature;
  return;
 end if;
 select p.kind into v_kind from mavi_private.ai_providers p where p.id = p_provider and p.company_id = p_company
  and exists (select 1 from jsonb_array_elements(p.models) m where m->>'id' = p_model);
 if v_kind is null then
  raise exception 'Escolha um modelo cadastrado no provedor.' using errcode = '22023';
 end if;
 -- Transcrição: o endpoint de transcrição da OpenAI e um modelo que transcreve.
 if mavi_private.ai_transcribe_feature(v_feature) then
  if v_kind not in ('openai', 'groq', 'mistral', 'custom') then
   raise exception 'A transcrição usa a OpenAI, o Groq, a Mistral ou um endereço compatível.' using errcode = '22023';
  end if;
  if not mavi_private.ai_transcribe_model(p_model) then
   raise exception 'Escolha um modelo de transcrição (Whisper, gpt-4o-transcribe, Voxtral…).' using errcode = '22023';
  end if;
 -- Imagens: o endpoint de imagens da OpenAI e um modelo que gera imagens.
 elsif v_feature = 'image_generation' then
  if v_kind not in ('openai', 'google', 'xai', 'openrouter', 'custom') then
   raise exception 'As imagens usam a OpenAI, o Google, a xAI, o OpenRouter ou um endereço compatível.' using errcode = '22023';
  end if;
  if not mavi_private.ai_image_model(p_model) then
   raise exception 'Escolha um modelo de imagem (gpt-image-1, Imagen, grok-2-image…).' using errcode = '22023';
  end if;
 -- Busca na internet: a da Claude (nativa) ou a do OpenRouter (plugin web e modelos online).
 elsif v_feature = 'web_search' then
  if v_kind not in ('anthropic', 'openrouter') then
   raise exception 'A busca na internet usa a Claude (Anthropic) ou o OpenRouter.' using errcode = '22023';
  end if;
  if mavi_private.ai_non_chat_model(p_model) then
   raise exception 'Escolha um modelo de conversa para a busca.' using errcode = '22023';
  end if;
 elsif mavi_private.ai_non_chat_model(p_model) then
  raise exception 'Este modelo só transcreve, gera vetores ou imagens: escolha um modelo de conversa.' using errcode = '22023';
 end if;
 -- O termômetro e a conferência do Radar leem com o Jev pelo OpenRouter; o Jev não conversa.
 if mavi_private.ai_decision_feature(v_feature) and not (v_kind = 'openrouter' and mavi_private.jev_model(p_model)) then
  raise exception 'Esta funcionalidade usa o Jev (TypeSafe) pelo OpenRouter: escolha o modelo do Jev.'
   using errcode = '22023';
 end if;
 if not mavi_private.ai_decision_feature(v_feature) and mavi_private.jev_model(p_model) then
  raise exception 'O Jev só responde a perguntas de decisão: use-o no termômetro, na conferência do Radar ou na autoavaliação da MAVI.'
   using errcode = '22023';
 end if;
 if p_type = 'user' and not exists (select 1 from public.memberships where company_id = p_company and user_id = p_id)
  or p_type = 'client' and not exists (select 1 from public.clients where company_id = p_company and id = p_id)
  or p_type = 'contract' and not exists (select 1 from public.contracts where company_id = p_company and id = p_id)
  or p_type = 'project' and not exists (select 1 from public.projects where company_id = p_company and id = p_id)
  or p_type = 'skill' and not exists (select 1 from public.ai_skills where company_id = p_company and id = p_id) then
  raise exception 'Não encontrado na empresa.' using errcode = 'P0002';
 end if;
 insert into mavi_private.ai_routes(company_id, scope_type, scope_id, feature, provider_id, model)
 values (p_company, p_type, v_id, v_feature, p_provider, p_model)
 on conflict on constraint ai_routes_scope_key do update set provider_id = excluded.provider_id,
  model = excluded.model, updated_by = auth.uid(), updated_at = now();
end $$;

revoke all on function public.ai_set_route(uuid, text, uuid, uuid, text, text) from public, anon;
grant execute on function public.ai_set_route(uuid, text, uuid, uuid, text, text) to authenticated;

notify pgrst, 'reload schema';

commit;
