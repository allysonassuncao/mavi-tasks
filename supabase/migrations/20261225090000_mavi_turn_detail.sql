begin;

-- MAVI · o custo da resposta com tudo o que aconteceu nela (continua a
-- migração 20261224090000):
--
-- 1. O passo a passo de cada resposta (ai_turn_details): cada rodada do
--    modelo (tokens de entrada, do cache e de saída, custo, as ferramentas
--    que pediu), cada ferramenta que rodou (tempo, custo próprio) e de onde
--    veio a entrada da primeira rodada (a mensagem da pessoa, o histórico,
--    as instruções e ferramentas da MAVI, o contexto, as skills e anexos).
-- 2. Os anexos enviados com a pergunta passam a contar na resposta dela
--    (ai_usage_close_turn recebe os anexos); o que terminar de ler depois
--    conta na primeira resposta salva depois do gasto.
-- 3. O resumo das conversas longas conta na resposta que o disparou (o
--    servidor registra com a mesma vez e fecha de novo).

create table public.ai_turn_details (
 company_id uuid not null references public.companies(id),
 conversation_id uuid not null references public.ai_conversations(id) on delete cascade,
 message_id bigint not null,
 turn_id uuid not null,
 detail jsonb not null check (jsonb_typeof(detail) = 'object' and length(detail::text) <= 60000),
 created_at timestamptz not null default now(),
 primary key (conversation_id, message_id)
);
alter table public.ai_turn_details enable row level security;
revoke all on public.ai_turn_details from public, anon, authenticated;

drop function public.ai_usage_close_turn(uuid, uuid);
-- Devolve a resposta (a mensagem) em que os gastos ficaram.
create function public.ai_usage_close_turn(p_conversation uuid, p_turn uuid, p_detail jsonb default null,
 p_attachments uuid[] default null) returns bigint
language plpgsql security definer set search_path = '' as $$
declare v_message bigint; v_company uuid; begin
 select c.company_id into v_company from public.ai_conversations c
 where c.id = p_conversation and c.owner_id = auth.uid();
 if v_company is null then raise exception 'Conversa não encontrada.' using errcode = 'P0002'; end if;
 -- A resposta desta vez: a que já tem gasto dela, senão a última salva.
 select coalesce((select max(x.message_id) from public.ai_usage x where x.turn_id = p_turn and x.user_id = auth.uid()),
  (select max(msg.id) from public.ai_messages msg where msg.conversation_id = p_conversation and msg.role = 'assistant'))
 into v_message;
 update public.ai_usage set conversation_id = p_conversation, message_id = v_message
 where turn_id = p_turn and user_id = auth.uid() and (conversation_id is null or conversation_id = p_conversation);
 -- A leitura dos anexos desta pergunta (a pessoa é a dona deles).
 if coalesce(cardinality(p_attachments), 0) > 0 then
  update public.ai_usage u set message_id = v_message
  from public.ai_attachments a
  where u.attachment_id = a.id and a.id = any(p_attachments[1:20]) and a.owner_id = auth.uid()
   and a.conversation_id = p_conversation and u.message_id is null;
 end if;
 if p_detail is not null and v_message is not null then
  if jsonb_typeof(p_detail) <> 'object' or length(p_detail::text) > 60000 then
   raise exception 'Detalhe inválido.' using errcode = '22023';
  end if;
  insert into public.ai_turn_details(company_id, conversation_id, message_id, turn_id, detail)
  values (v_company, p_conversation, v_message, p_turn, p_detail)
  on conflict (conversation_id, message_id) do update set detail = excluded.detail, turn_id = excluded.turn_id;
 end if;
 return v_message;
end $$;
revoke all on function public.ai_usage_close_turn(uuid, uuid, jsonb, uuid[]) from public, anon;
grant execute on function public.ai_usage_close_turn(uuid, uuid, jsonb, uuid[]) to authenticated;

-- O custo da conversa (o da migração 20261224090000) com o passo a passo de
-- cada resposta e os anexos lidos depois contando na resposta seguinte.
create or replace function public.ai_conversation_cost(p_conversation uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare c public.ai_conversations; begin
 select * into c from public.ai_conversations where id = p_conversation;
 if c.id is null or not mavi_private.member(c.company_id)
  or (c.owner_id is distinct from auth.uid() and not mavi_private.leader(c.company_id)) then
  raise exception 'Conversa não encontrada.' using errcode = 'P0002';
 end if;
 return (with u as (
   select x.*, coalesce(x.message_id, case when x.attachment_id is not null then
     (select min(msg.id) from public.ai_messages msg where msg.conversation_id = c.id and msg.role = 'assistant'
      and msg.created_at >= x.created_at) end) as answer
   from public.ai_usage x
   where x.company_id = c.company_id and (x.conversation_id = c.id
    or x.attachment_id in (select a.id from public.ai_attachments a where a.conversation_id = c.id)))
  select jsonb_build_object(
   'total', (select jsonb_build_object('cost', coalesce(sum(cost_usd), 0), 'input_tokens', coalesce(sum(input_tokens), 0),
     'output_tokens', coalesce(sum(output_tokens), 0), 'cache_read_tokens', coalesce(sum(cache_read_tokens), 0),
     'cache_write_tokens', coalesce(sum(cache_write_tokens), 0), 'embedding_tokens', coalesce(sum(embedding_tokens), 0),
     'calls', count(*), 'answers', count(distinct answer)) from u),
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
     select answer as message, sum(cost_usd) as cost,
      jsonb_agg(jsonb_build_object('provider', provider_name, 'model', model, 'kind', kind, 'cost', cost_usd,
       'input_tokens', input_tokens, 'output_tokens', output_tokens, 'cache_read_tokens', cache_read_tokens,
       'cache_write_tokens', cache_write_tokens, 'embedding_tokens', embedding_tokens) order by id) as items,
      (select d.detail from public.ai_turn_details d where d.conversation_id = c.id and d.message_id = u.answer) as detail
     from u where answer is not null group by answer) x)));
end $$;

commit;
