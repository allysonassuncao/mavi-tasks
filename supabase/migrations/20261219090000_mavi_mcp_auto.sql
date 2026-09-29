begin;

-- MAVI · Conexões (MCP): ferramentas que rodam sem pedir confirmação.
--
-- O servidor MCP diz quais ferramentas só leem (readOnlyHint); as outras
-- pedem confirmação no card. Muitos servidores não marcam as de consulta
-- (ex.: "esperar a geração terminar"), então quem edita a conexão pode dizer
-- que uma ferramenta roda sem pedir confirmação ('auto'). Na primeira vez, o
-- servidor da MAVI sugere pelo nome (esperar, buscar, listar, ver: sim; criar,
-- gerar, enviar, apagar: não); depois, atualizar a lista mantém a escolha.
-- ai_mcp_set_tools é a da migração 20261218090000 com o 'auto'.

create or replace function public.ai_mcp_set_tools(p_server uuid, p_tools jsonb, p_error text) returns void
language plpgsql security definer set search_path = '' as $$
declare s mavi_private.ai_mcp_servers; begin
 select * into s from mavi_private.ai_mcp_servers where id = p_server;
 if s.id is null or not mavi_private.ai_mcp_editor(s) then
  raise exception 'Só quem edita a conexão atualiza as ferramentas.' using errcode = '42501';
 end if;
 if p_tools is null then
  update mavi_private.ai_mcp_servers set last_error = left(p_error, 300) where id = p_server;
  return;
 end if;
 if jsonb_typeof(p_tools) <> 'array' or jsonb_array_length(p_tools) > 200 or length(p_tools::text) > 600000 then
  raise exception 'Lista de ferramentas inválida.' using errcode = '22023';
 end if;
 update mavi_private.ai_mcp_servers x set tools = (
   select coalesce(jsonb_agg(jsonb_build_object('name', t.name, 'title', left(coalesce(t.item->>'title', ''), 120),
     'description', left(coalesce(t.item->>'description', ''), 2000),
     'read_only', coalesce((t.item->>'read_only')::boolean, false),
     'input_schema', case when jsonb_typeof(t.item->'input_schema') = 'object' then t.item->'input_schema'
      else '{"type":"object"}'::jsonb end,
     'enabled', coalesce((select (o->>'enabled')::boolean from jsonb_array_elements(x.tools) o
      where o->>'name' = t.name), true),
     'auto', coalesce((select (o->>'auto')::boolean from jsonb_array_elements(x.tools) o
      where o->>'name' = t.name), (t.item->>'auto')::boolean, false)) order by t.ord), '[]')
   from (select distinct on (e.item->>'name') e.item->>'name' as name, e.item, e.ord
    from jsonb_array_elements(p_tools) with ordinality e(item, ord)
    where jsonb_typeof(e.item) = 'object' and coalesce(e.item->>'name', '') ~ '^[A-Za-z0-9_./-]{1,128}$'
    order by e.item->>'name', e.ord) t),
  tools_at = now(), last_error = left(p_error, 300)
 where x.id = p_server;
end $$;

-- Rodar sem pedir confirmação (só quem edita a conexão).
create function public.ai_mcp_tool_auto(p_server uuid, p_tool text, p_auto boolean) returns void
language plpgsql security definer set search_path = '' as $$
declare s mavi_private.ai_mcp_servers; begin
 select * into s from mavi_private.ai_mcp_servers where id = p_server;
 if s.id is null or not mavi_private.ai_mcp_editor(s) then
  raise exception 'Só quem edita a conexão diz o que roda sem confirmação.' using errcode = '42501';
 end if;
 update mavi_private.ai_mcp_servers x set tools = (
   select coalesce(jsonb_agg(case when t->>'name' = p_tool
     then t || jsonb_build_object('auto', coalesce(p_auto, false)) else t end order by ord), '[]')
   from jsonb_array_elements(x.tools) with ordinality e(t, ord)), updated_at = now()
 where x.id = p_server;
end $$;
revoke all on function public.ai_mcp_tool_auto(uuid, text, boolean) from public, anon;
grant execute on function public.ai_mcp_tool_auto(uuid, text, boolean) to authenticated;

commit;
