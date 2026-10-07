begin;

-- MAVI · a resposta com o cartão "Ver na Busca avançada" (find_tasks, anexo
-- search) ou "Abrir tutorial" (search_tutorials, anexo tutorial) não era
-- gravada: a conferência dos anexos só conhecia os tipos antigos, o
-- ai_save_turn recusava a resposta inteira e a tela avisava "Não foi possível
-- salvar esta conversa". Os dois tipos passam a valer (também no fim da
-- tarefa longa, que usa a mesma conferência). O tutorial guarda o id dele.
create or replace function mavi_private.ai_artifacts_ok(c uuid, p jsonb) returns boolean
language sql immutable set search_path = '' as $$
 select jsonb_typeof(coalesce(p, '[]')) = 'array' and jsonb_array_length(coalesce(p, '[]')) <= 12
  and not exists (select 1 from jsonb_array_elements(coalesce(p, '[]')) a
   where jsonb_typeof(a) <> 'object' or coalesce(a->>'id', '') !~ '^[A-Za-z0-9_-]{4,64}$'
    or coalesce(a->>'type', '') not in ('visual', 'image', 'action', 'canvas', 'question', 'task', 'search', 'tutorial')
    or (a->>'type' = 'image' and coalesce(a->>'path', '') !~
     ('^ai-images/' || c::text || '/[0-9a-f-]{36}\.(png|webp|jpg)$'))
    or (a->>'type' = 'task' and coalesce(a->>'task', '') !~
     '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
    or (a->>'type' = 'tutorial' and coalesce(a->>'tutorial', '') !~
     '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'))
$$;
revoke all on function mavi_private.ai_artifacts_ok(uuid, jsonb) from public, anon, authenticated;

commit;
