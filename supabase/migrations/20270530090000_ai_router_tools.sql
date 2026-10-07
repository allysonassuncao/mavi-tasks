begin;

-- MAVI · roteador de modelos, fase 3 (pedido de 06/10/2026): ferramentas por
-- intenção. As ferramentas das conexões (MCP) e das contas de anúncio vão
-- quando combinam com o pedido ou quando a conversa as usou há pouco: esta
-- função devolve as últimas usadas (só na conversa de quem pergunta), pelo
-- nome do registro (mcp:<conexão>/<ferramenta> nas conexões).

create function public.ai_recent_tools(p_conversation uuid, p_limit integer default 30) returns text[]
language plpgsql stable security definer set search_path = '' as $$ begin
 if not exists (select 1 from public.ai_conversations c where c.id = p_conversation and c.owner_id = auth.uid()) then
  return '{}';
 end if;
 return coalesce((select array_agg(distinct x.tool) from (select t.tool from public.ai_tool_calls t
   where t.conversation_id = p_conversation and t.user_id = auth.uid() and t.ok
   order by t.id desc limit least(greatest(coalesce(p_limit, 30), 1), 100)) x), '{}');
end $$;
revoke all on function public.ai_recent_tools(uuid, integer) from public, anon;
grant execute on function public.ai_recent_tools(uuid, integer) to authenticated;

commit;
