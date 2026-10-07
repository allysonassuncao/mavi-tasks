begin;

-- MAVI · a conversa perdia a vez (ou sumia inteira) quando a resposta tinha um
-- cartão que a conferência não conhecia: o cartão "Anotei" da memória
-- (remember_about_me, tipo 'memory', migração 20270611090000) ou mais de 12
-- cartões numa resposta. O ai_save_turn recusava a pergunta e a resposta
-- juntas; numa conversa nova, o ai_run_finish via a conversa vazia e apagava.
--
-- 1. A conferência passa a conhecer o tipo 'memory' (o item é um uuid),
--    também no canvas e no fim da tarefa longa.
-- 2. O ai_save_turn não recusa mais a vez por causa dos cartões: guarda o
--    texto sempre e os 12 primeiros cartões que passam na conferência (o
--    limite da coluna ai_messages.artifacts), sem passar de 1 MB.
create or replace function mavi_private.ai_artifacts_ok(c uuid, p jsonb) returns boolean
language sql immutable set search_path = '' as $$
 select jsonb_typeof(coalesce(p, '[]')) = 'array' and jsonb_array_length(coalesce(p, '[]')) <= 12
  and not exists (select 1 from jsonb_array_elements(coalesce(p, '[]')) a
   where jsonb_typeof(a) <> 'object' or coalesce(a->>'id', '') !~ '^[A-Za-z0-9_-]{4,64}$'
    or coalesce(a->>'type', '') not in ('visual', 'image', 'action', 'canvas', 'question', 'task', 'search', 'tutorial',
     'memory')
    or (a->>'type' = 'image' and coalesce(a->>'path', '') !~
     ('^ai-images/' || c::text || '/[0-9a-f-]{36}\.(png|webp|jpg)$'))
    or (a->>'type' = 'task' and coalesce(a->>'task', '') !~
     '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
    or (a->>'type' = 'tutorial' and coalesce(a->>'tutorial', '') !~
     '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
    or (a->>'type' = 'memory' and coalesce(a->>'item', '') !~
     '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'))
$$;
revoke all on function mavi_private.ai_artifacts_ok(uuid, jsonb) from public, anon, authenticated;

create or replace function public.ai_save_turn(p_company uuid, p_conversation uuid, p_scope jsonb, p_module text,
 p_question text, p_answer text, p_sources jsonb, p_steps jsonb, p_artifacts jsonb default '[]') returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_id uuid := p_conversation; v_owner uuid; v_cards jsonb; begin
 if not mavi_private.member(p_company) then raise exception 'Sem acesso ao espaço' using errcode = '42501'; end if;
 -- Só os cartões que passam na conferência; o texto fica sempre.
 select coalesce(jsonb_agg(k.a order by k.ord), '[]') into v_cards
 from (select t.a, t.ord
  from jsonb_array_elements(case when jsonb_typeof(p_artifacts) = 'array' then p_artifacts else '[]' end)
   with ordinality t(a, ord)
  where mavi_private.ai_artifacts_ok(p_company, jsonb_build_array(t.a))
  order by t.ord limit 12) k;
 if pg_column_size(v_cards) > 1048576 then v_cards := '[]'; end if;
 if v_id is null then
  insert into public.ai_conversations(company_id, title, scope, module)
  values (p_company, left(coalesce(nullif(btrim(regexp_replace(p_question, '\s+', ' ', 'g')), ''), 'Nova conversa'), 80),
   coalesce(p_scope, '{}'), left(coalesce(p_module, 'assistant'), 40))
  returning id into v_id;
 else
  select owner_id into v_owner from public.ai_conversations where company_id = p_company and id = v_id;
  if v_owner is null then raise exception 'Conversa não encontrada.' using errcode = 'P0002'; end if;
  if v_owner <> auth.uid() then
   raise exception 'Só quem começou a conversa continua nela.' using errcode = '42501';
  end if;
  update public.ai_conversations set updated_at = now() where id = v_id;
 end if;
 insert into public.ai_messages(company_id, conversation_id, role, content) values (p_company, v_id, 'user', left(p_question, 40000));
 insert into public.ai_messages(company_id, conversation_id, role, content, sources, steps, artifacts)
 values (p_company, v_id, 'assistant', left(p_answer, 40000), coalesce(p_sources, '[]'), coalesce(p_steps, '[]'), v_cards);
 return v_id;
end $$;
revoke all on function public.ai_save_turn(uuid, uuid, jsonb, text, text, text, jsonb, jsonb, jsonb) from public, anon;
grant execute on function public.ai_save_turn(uuid, uuid, jsonb, text, text, text, jsonb, jsonb, jsonb) to authenticated;

commit;
