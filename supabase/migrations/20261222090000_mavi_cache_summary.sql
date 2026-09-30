begin;

-- MAVI · cache do prompt, conversas longas resumidas e reordenação da busca:
--
-- 1. Conversas longas: a MAVI guarda um resumo acumulado das mensagens
--    antigas (ai_conversations.summary, até summary_upto) e manda para o
--    modelo o resumo + as mensagens recentes, em vez de esquecer o começo.
--    O resumo é refeito em segundo plano quando a conversa cresce.
-- 2. "Quem usa qual modelo" ganha duas funcionalidades:
--    - 'conversation_summary' (quem resume as conversas longas): sem regra,
--      usa o padrão da empresa;
--    - 'mavi_rerank' (reordenação da busca): um modelo rápido reordena os
--      trechos que a busca achou. Não herda o padrão da empresa: sem
--      escolha, não reordena.
-- 3. O Consumo mostra quanto da entrada veio do cache do prompt (o cache em si
--    é montado no servidor da MAVI).
-- ai_set_route é a da migração 20261217090000 com as duas funcionalidades.

alter table public.ai_conversations
 add column summary text check (length(summary) <= 40000),
 add column summary_upto bigint,
 add column summary_at timestamptz;

alter table mavi_private.ai_routes drop constraint ai_routes_feature_check;
alter table mavi_private.ai_routes add constraint ai_routes_feature_check
 check ((scope_type = 'feature') = (feature is not null)
  and (feature is null or feature in ('assistant', 'meetings_history', 'meetings_ask',
   'whatsapp_task', 'social_leads_plan', 'social_leads_adjust', 'social_leads_briefing', 'social_leads_colors',
   'task_copilot', 'client_dossier', 'copilot_learning', 'notice_writer', 'notice_animation',
   'client_temperature', 'client_temperature_text', 'task_audio',
   'whatsapp_transcribe', 'task_audio_transcribe', 'image_generation', 'mavi_page', 'web_search', 'canvas_writer',
   'mavi_rerank', 'conversation_summary')));

create or replace function mavi_private.ai_own_model_feature(p_feature text) returns boolean
language sql immutable set search_path = '' as $$
 select mavi_private.ai_transcribe_feature(p_feature)
  or coalesce(p_feature, '') in ('image_generation', 'web_search', 'canvas_writer', 'mavi_rerank')
$$;

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
  'mavi_rerank', 'conversation_summary') then
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
 -- O termômetro lê com o Jev pelo OpenRouter; o Jev não conversa.
 if v_feature = 'client_temperature' and not (v_kind = 'openrouter' and mavi_private.jev_model(p_model)) then
  raise exception 'O termômetro usa o Jev (TypeSafe) pelo OpenRouter: escolha o modelo do Jev.' using errcode = '22023';
 end if;
 if coalesce(v_feature, '') <> 'client_temperature' and mavi_private.jev_model(p_model) then
  raise exception 'O Jev só responde a perguntas de decisão: use-o no termômetro do cliente.' using errcode = '22023';
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


-- O resumo das mensagens antigas (o servidor da MAVI faz; só quem começou a
-- conversa grava). Só avança: um resumo mais antigo não substitui um novo.
create function public.ai_conversation_summary_save(p_conversation uuid, p_summary text, p_upto bigint)
returns boolean
language plpgsql security definer set search_path = '' as $$
declare v public.ai_conversations; begin
 select * into v from public.ai_conversations where id = p_conversation and owner_id = auth.uid();
 if v.id is null or not mavi_private.member(v.company_id) then
  raise exception 'Conversa não encontrada.' using errcode = 'P0002';
 end if;
 if length(btrim(coalesce(p_summary, ''))) < 20 then
  raise exception 'Resumo vazio.' using errcode = '22023';
 end if;
 if not exists (select 1 from public.ai_messages m where m.company_id = v.company_id
  and m.conversation_id = v.id and m.id = p_upto) then
  raise exception 'Mensagem fora da conversa.' using errcode = '22023';
 end if;
 update public.ai_conversations set summary = left(p_summary, 40000), summary_upto = p_upto, summary_at = now()
 where id = v.id and (summary_upto is null or summary_upto < p_upto);
 return found;
end $$;
revoke all on function public.ai_conversation_summary_save(uuid, text, bigint) from public, anon;
grant execute on function public.ai_conversation_summary_save(uuid, text, bigint) to authenticated;

-- O relatório do Consumo (o da migração 20261212090000) com os tokens do cache.
create or replace function public.ai_usage_report(p_company uuid, p_from date, p_to date) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_from timestamptz; v_to timestamptz; v_start timestamptz := mavi_private.ai_month_start(); begin
 if not mavi_private.leader(p_company) then raise exception 'Sem permissão.' using errcode = '42501'; end if;
 v_from := p_from::timestamp at time zone 'America/Sao_Paulo';
 v_to := (p_to + 1)::timestamp at time zone 'America/Sao_Paulo';
 return (with u as (
   select * from public.ai_usage where company_id = p_company and created_at >= v_from and created_at < v_to)
  select jsonb_build_object(
   'total', (select jsonb_build_object('cost', coalesce(sum(cost_usd), 0),
     'asks', count(*) filter (where kind = 'ask'),
     'index_cost', coalesce(sum(cost_usd) filter (where kind = 'index'), 0),
     'input_tokens', coalesce(sum(input_tokens), 0), 'output_tokens', coalesce(sum(output_tokens), 0),
     'embedding_tokens', coalesce(sum(embedding_tokens), 0),
     -- O cache do prompt: o que foi lido do cache (custa ~10% da entrada) e gravado nele.
     'cache_read_tokens', coalesce(sum(cache_read_tokens), 0),
     'cache_write_tokens', coalesce(sum(cache_write_tokens), 0)) from u),
   'by_user', (select coalesce(jsonb_agg(x order by x.cost desc), '[]') from (
     select user_id as id, sum(cost_usd) as cost, count(*) filter (where kind = 'ask') as asks
     from u where user_id is not null group by user_id) x),
   'by_client', (select coalesce(jsonb_agg(x order by x.cost desc), '[]') from (
     select client_id as id, sum(cost_usd) as cost, count(*) filter (where kind = 'ask') as asks
     from u where client_id is not null group by client_id) x),
   'by_contract', (select coalesce(jsonb_agg(x order by x.cost desc), '[]') from (
     select contract_id as id, sum(cost_usd) as cost, count(*) filter (where kind = 'ask') as asks
     from u where contract_id is not null group by contract_id) x),
   'by_project', (select coalesce(jsonb_agg(x order by x.cost desc), '[]') from (
     select project_id as id, sum(cost_usd) as cost, count(*) filter (where kind = 'ask') as asks
     from u where project_id is not null group by project_id) x),
   'by_module', (select coalesce(jsonb_agg(x order by x.cost desc), '[]') from (
     select module as id, sum(cost_usd) as cost, count(*) filter (where kind = 'ask') as asks
     from u group by module) x),
   'by_model', (select coalesce(jsonb_agg(x order by x.cost desc), '[]') from (
     select provider_name || '|' || model as id, provider_name as provider, model, sum(cost_usd) as cost,
      count(*) filter (where kind = 'ask') as asks,
      sum(input_tokens + cache_read_tokens + cache_write_tokens) as input_tokens, sum(output_tokens) as output_tokens,
      sum(cache_read_tokens) as cache_read_tokens
     from u group by provider_name, model) x),
   'by_tool', (select coalesce(jsonb_agg(x order by x.calls desc), '[]') from (
     select tool as id, count(*) as calls, count(*) filter (where not ok) as errors,
      round(avg(duration_ms))::integer as avg_ms, sum(cost_usd) as cost, count(distinct user_id) as people
     from public.ai_tool_calls where company_id = p_company and created_at >= v_from and created_at < v_to
     group by tool) x),
   'by_day', (select coalesce(jsonb_agg(x order by x.day), '[]') from (
     select to_char(created_at at time zone 'America/Sao_Paulo', 'YYYY-MM-DD') as day, sum(cost_usd) as cost,
      count(*) filter (where kind = 'ask') as asks
     from u group by 1) x),
   'limits', (select coalesce(jsonb_agg(jsonb_build_object('type', l.scope_type, 'id', l.scope_id,
      'monthly_usd', l.monthly_usd, 'month_spent', (
       select coalesce(sum(a.cost_usd), 0) from public.ai_usage a
       where a.company_id = p_company and a.created_at >= v_start and case l.scope_type
        when 'company' then true when 'user' then a.user_id = l.scope_id when 'client' then a.client_id = l.scope_id
        when 'contract' then a.contract_id = l.scope_id else a.project_id = l.scope_id end))
      order by l.scope_type), '[]') from public.ai_limits l where l.company_id = p_company)));
end $$;

commit;
