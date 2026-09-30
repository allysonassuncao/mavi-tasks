begin;

-- MAVI · o custo de cada conversa, por modelo:
--
-- 1. Todo gasto da MAVI (a resposta, a busca nos vetores, as imagens, o
--    escritor do canvas, a busca na internet, a skill com modelo próprio, a
--    reordenação, os anexos lidos e o resumo das conversas longas) fica
--    ligado à conversa (ai_usage.conversation_id) e à resposta que o gerou
--    (message_id). Durante a resposta, cada gasto leva o id da vez (turn_id);
--    depois que a resposta é salva, ai_usage_close_turn liga à conversa e à
--    mensagem. Os anexos entram pela conversa em que foram usados.
-- 2. ai_conversation_cost: total, por modelo (com os tokens), por tipo de
--    gasto e por resposta. Vê quem começou a conversa e os administradores e
--    gestores (compartilhar a conversa não mostra o custo).

alter table public.ai_usage
 add column conversation_id uuid references public.ai_conversations(id) on delete set null,
 add column message_id bigint,
 add column turn_id uuid,
 add column attachment_id uuid references public.ai_attachments(id) on delete set null;
create index ai_usage_conversation on public.ai_usage (conversation_id) where conversation_id is not null;
create index ai_usage_turn on public.ai_usage (turn_id) where turn_id is not null;
create index ai_usage_attachment on public.ai_usage (attachment_id) where attachment_id is not null;

-- O registro (o da migração 20261025090000) com a conversa, a vez e o anexo.
drop function public.ai_log_usage(uuid, text, text, uuid, uuid, uuid, uuid, text, integer, integer, integer,
 integer, integer, numeric, uuid);
create function public.ai_log_usage(p_company uuid, p_module text, p_kind text, p_client uuid, p_contract uuid,
 p_project uuid, p_recording uuid, p_model text, p_input integer, p_output integer, p_cache_read integer,
 p_cache_write integer, p_embedding integer, p_cost numeric, p_provider uuid default null,
 p_conversation uuid default null, p_turn uuid default null, p_attachment uuid default null) returns void
language plpgsql security definer set search_path = '' as $$
declare v_name text := ''; begin
 if not mavi_private.member(p_company) then raise exception 'Sem permissão.' using errcode = '42501'; end if;
 if p_client is not null and not mavi_private.drive_can_read(p_company, p_client) then
  raise exception 'Sem permissão.' using errcode = '42501';
 end if;
 if p_module = 'mcp' and not mavi_private.mcp_allowed(p_company) then
  raise exception 'Sem permissão.' using errcode = '42501';
 end if;
 if p_cost is null or p_cost < 0 or p_cost > 100 then raise exception 'Custo inválido.' using errcode = '22023'; end if;
 if p_provider is not null then
  select p.name into v_name from mavi_private.ai_providers p where p.id = p_provider and p.company_id = p_company;
  if v_name is null then raise exception 'Provedor inválido.' using errcode = '22023'; end if;
 end if;
 -- Só as conversas e os anexos de quem gasta.
 if p_conversation is not null and not exists (select 1 from public.ai_conversations c
  where c.id = p_conversation and c.company_id = p_company and c.owner_id = auth.uid()) then
  raise exception 'Conversa inválida.' using errcode = '22023';
 end if;
 if p_attachment is not null and not exists (select 1 from public.ai_attachments a
  where a.id = p_attachment and a.company_id = p_company and a.owner_id = auth.uid()) then
  raise exception 'Anexo inválido.' using errcode = '22023';
 end if;
 insert into public.ai_usage(company_id, module, kind, client_id, contract_id, project_id, recording_id, model,
  input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, embedding_tokens, cost_usd, provider_id,
  provider_name, conversation_id, turn_id, attachment_id)
 values (p_company, left(coalesce(p_module, ''), 40), left(coalesce(p_kind, ''), 40), p_client, p_contract,
  p_project, p_recording, left(coalesce(p_model, ''), 80), greatest(coalesce(p_input, 0), 0),
  greatest(coalesce(p_output, 0), 0), greatest(coalesce(p_cache_read, 0), 0),
  greatest(coalesce(p_cache_write, 0), 0), greatest(coalesce(p_embedding, 0), 0), p_cost, p_provider, v_name,
  p_conversation, p_turn, p_attachment);
end $$;
revoke all on function public.ai_log_usage(uuid, text, text, uuid, uuid, uuid, uuid, text, integer, integer, integer,
 integer, integer, numeric, uuid, uuid, uuid, uuid) from public, anon;
grant execute on function public.ai_log_usage(uuid, text, text, uuid, uuid, uuid, uuid, text, integer, integer, integer,
 integer, integer, numeric, uuid, uuid, uuid, uuid) to authenticated;

-- A resposta foi salva: os gastos da vez passam a ser dela (e da conversa,
-- quando ela nasceu nesta resposta). Devolve quantos gastos ligou.
create function public.ai_usage_close_turn(p_conversation uuid, p_turn uuid) returns integer
language plpgsql security definer set search_path = '' as $$
declare v_message bigint; n integer; begin
 if not exists (select 1 from public.ai_conversations c where c.id = p_conversation and c.owner_id = auth.uid()) then
  raise exception 'Conversa não encontrada.' using errcode = 'P0002';
 end if;
 select max(m.id) into v_message from public.ai_messages m
 where m.conversation_id = p_conversation and m.role = 'assistant';
 update public.ai_usage set conversation_id = p_conversation, message_id = v_message
 where turn_id = p_turn and user_id = auth.uid() and (conversation_id is null or conversation_id = p_conversation);
 get diagnostics n = row_count;
 return n;
end $$;
revoke all on function public.ai_usage_close_turn(uuid, uuid) from public, anon;
grant execute on function public.ai_usage_close_turn(uuid, uuid) to authenticated;

-- O custo da conversa: total, por modelo, por tipo e por resposta.
create function public.ai_conversation_cost(p_conversation uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare c public.ai_conversations; begin
 select * into c from public.ai_conversations where id = p_conversation;
 if c.id is null or not mavi_private.member(c.company_id)
  or (c.owner_id is distinct from auth.uid() and not mavi_private.leader(c.company_id)) then
  raise exception 'Conversa não encontrada.' using errcode = 'P0002';
 end if;
 return (with u as (
   select * from public.ai_usage x
   where x.company_id = c.company_id and (x.conversation_id = c.id
    or x.attachment_id in (select a.id from public.ai_attachments a where a.conversation_id = c.id)))
  select jsonb_build_object(
   'total', (select jsonb_build_object('cost', coalesce(sum(cost_usd), 0), 'input_tokens', coalesce(sum(input_tokens), 0),
     'output_tokens', coalesce(sum(output_tokens), 0), 'cache_read_tokens', coalesce(sum(cache_read_tokens), 0),
     'cache_write_tokens', coalesce(sum(cache_write_tokens), 0), 'embedding_tokens', coalesce(sum(embedding_tokens), 0),
     'calls', count(*), 'answers', count(distinct message_id)) from u),
   'by_model', (select coalesce(jsonb_agg(x order by x.cost desc), '[]') from (
     select provider_name as provider, model, sum(cost_usd) as cost, count(*) as calls,
      sum(input_tokens) as input_tokens, sum(output_tokens) as output_tokens,
      sum(cache_read_tokens) as cache_read_tokens, sum(cache_write_tokens) as cache_write_tokens,
      sum(embedding_tokens) as embedding_tokens,
      (select jsonb_agg(distinct k.kind) from u k where k.model = u.model and k.provider_name = u.provider_name) as kinds
     from u group by provider_name, model) x),
   'by_kind', (select coalesce(jsonb_agg(x order by x.cost desc), '[]') from (
     select kind, sum(cost_usd) as cost, count(*) as calls from u group by kind) x),
   'by_message', (select coalesce(jsonb_agg(x order by x.message), '[]') from (
     select message_id as message, sum(cost_usd) as cost,
      jsonb_agg(jsonb_build_object('provider', provider_name, 'model', model, 'kind', kind, 'cost', cost_usd,
       'input_tokens', input_tokens, 'output_tokens', output_tokens, 'cache_read_tokens', cache_read_tokens,
       'cache_write_tokens', cache_write_tokens, 'embedding_tokens', embedding_tokens) order by id) as items
     from u where message_id is not null group by message_id) x)));
end $$;
revoke all on function public.ai_conversation_cost(uuid) from public, anon;
grant execute on function public.ai_conversation_cost(uuid) to authenticated;

commit;
