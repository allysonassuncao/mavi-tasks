begin;

-- MAVI · o trecho de cada fonte citada, pelos índices.
--
-- "Adicionar" uma resposta aprovada ao conjunto de avaliação estourava o
-- tempo do banco (57014): a busca do trecho de cada fonte comparava o id do
-- documento como texto (d.source_id::text = …), sem usar o índice único de
-- ai_documents, e o tipo não filtrava nada; no WhatsApp, procurava a
-- mensagem no meta de todos os trechos da empresa. Com muitos documentos,
-- cada fonte varria a base inteira. A mesma busca estava na fila da
-- autoavaliação (mavi_judge_claim) e no material dos testes fora do ar.
--
-- Agora: o documento pela chave (empresa, tipo, id) e os trechos dele pelo
-- índice do documento; no WhatsApp, a mensagem pelo id, o dia do grupo, o
-- documento do dia e, nele, o trecho da mensagem (ou o bloco que a contém).

create function mavi_private.ai_source_excerpt(p_company uuid, src jsonb) returns text
language plpgsql stable security definer set search_path = '' as $$
declare v_id uuid; v_doc uuid; v_types text[]; v_group uuid; v_sent timestamptz; v_day uuid; v text; begin
 if coalesce(src->>'id', '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then return null; end if;
 v_id := (src->>'id')::uuid;
 if src->>'type' = 'whatsapp' then
  select x.group_id, x.sent_at into v_group, v_sent from public.whatsapp_messages x
  where x.id = v_id and x.company_id = p_company;
  if v_group is null then return null; end if;
  select d.id into v_day from mavi_private.whatsapp_ai_days d
  where d.group_id = v_group and d.day = (v_sent at time zone 'America/Sao_Paulo')::date and d.company_id = p_company;
  if v_day is null then return null; end if;
  select d.id into v_doc from public.ai_documents d
  where d.company_id = p_company and d.source_type = 'whatsapp' and d.source_id = v_day;
  if v_doc is null then return null; end if;
  -- O trecho da mensagem; senão, o bloco que começou antes dela e mais perto.
  select x.content into v from public.ai_chunks x where x.document_id = v_doc
  order by (x.meta->>'message' = v_id::text) desc,
   case when x.meta->>'at' ~ '^\d{4}-' and (x.meta->>'at')::timestamptz <= v_sent
    then extract(epoch from v_sent - (x.meta->>'at')::timestamptz) end nulls last, x.ord
  limit 1;
  return v;
 end if;
 v_types := case src->>'type' when 'file' then array['drive_file'] when 'case' then array['success_case']
  when 'social' then array['social_plan', 'social_briefing'] else array[src->>'type'] end;
 select d.id into v_doc from public.ai_documents d
 where d.company_id = p_company and d.source_type = any(v_types) and d.source_id = v_id
 limit 1;
 if v_doc is null then return null; end if;
 -- Nas gravações e nos PDFs, o trecho mais perto do momento ou da página citada.
 select x.content into v from public.ai_chunks x where x.document_id = v_doc
 order by case when src->>'start' ~ '^\d+(\.\d+)?$' and x.meta->>'start' ~ '^\d+(\.\d+)?$'
   then abs((x.meta->>'start')::numeric - (src->>'start')::numeric)
  when src->>'page' ~ '^\d+$' and x.meta->>'page' ~ '^\d+$'
   then abs((x.meta->>'page')::numeric - (src->>'page')::numeric)
  else x.ord end
 limit 1;
 return v;
end $$;
revoke all on function mavi_private.ai_source_excerpt(uuid, jsonb) from public, anon, authenticated;

-- A da migração 20270531090000, com o trecho pelos índices.
create or replace function mavi_private.ai_message_material(p_message bigint) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare m public.ai_messages; c public.ai_conversations; v_client uuid; begin
 select * into m from public.ai_messages where id = p_message and role = 'assistant';
 if m.id is null then return null; end if;
 select * into c from public.ai_conversations where id = m.conversation_id;
 v_client := case when c.scope->>'client' ~* '^[0-9a-f-]{36}$' then (c.scope->>'client')::uuid end;
 if v_client is null and c.scope->>'contract' ~* '^[0-9a-f-]{36}$' then
  select ct.client_id into v_client from public.contracts ct where ct.id = (c.scope->>'contract')::uuid;
 end if;
 return jsonb_build_object(
  'question', (select left(u.content, 2000) from public.ai_messages u where u.conversation_id = m.conversation_id
    and u.role = 'user' and u.id < m.id order by u.id desc limit 1),
  'answer', left(coalesce(m.content, ''), 8000),
  'client', (select k2.name from public.clients k2 where k2.id = v_client),
  'sources', (select coalesce(jsonb_agg(jsonb_build_object('ref', src->>'ref', 'type', src->>'type',
     'title', src->>'title', 'date', src->>'date', 'excerpt', mavi_private.ai_source_excerpt(m.company_id, src))
     order by i), '[]')
    from jsonb_array_elements(case when jsonb_typeof(m.sources) = 'array' then m.sources else '[]' end)
     with ordinality s(src, i)
    where i <= 10),
  'dossier', (select coalesce(jsonb_agg(jsonb_build_object('kind', di.kind, 'text', di.text)), '[]') from (
    select i.kind, i.text from public.client_dossier_items i
    where i.client_id = v_client and not i.dismissed order by i.pinned desc, i.seen_at desc nulls last limit 15) di));
end $$;

-- A da migração 20270115090000, com o trecho pelos índices.
create or replace function public.mavi_judge_claim(p_secret text, p_limit integer default 3) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare k public.mavi_answer_checks; m public.ai_messages; c public.ai_conversations; v_client uuid;
 v_out jsonb := '[]'; begin
 if not mavi_private.ai_secret_ok(p_secret) then raise exception 'Sem permissão' using errcode = '42501'; end if;
 for k in select * from public.mavi_answer_checks x
  where x.company_id in (select d.company_id from mavi_private.mavi_judge_due() d)
   and x.status = 'pending' and x.attempts < 3 and (x.claimed_until is null or x.claimed_until < now())
   and x.updated_at <= now() - interval '2 minutes'
  order by x.updated_at limit least(greatest(coalesce(p_limit, 3), 1), 10) for update skip locked
 loop
  update public.mavi_answer_checks set claimed_until = now() + interval '5 minutes', attempts = attempts + 1
  where message_id = k.message_id;
  select * into m from public.ai_messages where id = k.message_id;
  select * into c from public.ai_conversations where id = k.conversation_id;
  v_client := case when c.scope->>'client' ~* '^[0-9a-f-]{36}$' then (c.scope->>'client')::uuid end;
  if v_client is null and c.scope->>'contract' ~* '^[0-9a-f-]{36}$' then
   select ct.client_id into v_client from public.contracts ct where ct.id = (c.scope->>'contract')::uuid;
  end if;
  v_out := v_out || jsonb_build_array(jsonb_build_object(
   'message', k.message_id, 'company', k.company_id, 'conversation', k.conversation_id, 'signals', to_jsonb(k.signals),
   'question', (select left(u.content, 2000) from public.ai_messages u where u.conversation_id = m.conversation_id
     and u.role = 'user' and u.id < m.id order by u.id desc limit 1),
   'answer', left(coalesce(m.content, ''), 8000),
   'steps', (select left(string_agg(coalesce(s->>'label', '') || coalesce(' (' || (s->>'detail') || ')', ''), '; '), 2000)
     from jsonb_array_elements(case when jsonb_typeof(m.steps) = 'array' then m.steps else '[]' end) s),
   'artifacts', (select coalesce(jsonb_agg(jsonb_build_object('ref', a->>'ref', 'type', a->>'type',
      'title', coalesce(a#>>'{canvas,title}', a->>'title', ''))), '[]')
     from jsonb_array_elements(case when jsonb_typeof(m.artifacts) = 'array' then m.artifacts else '[]' end) a),
   'client', (select k2.name from public.clients k2 where k2.id = v_client),
   'sources', (select coalesce(jsonb_agg(jsonb_build_object('ref', src->>'ref', 'type', src->>'type',
      'title', src->>'title', 'date', src->>'date', 'excerpt', mavi_private.ai_source_excerpt(m.company_id, src))
      order by i), '[]')
     from jsonb_array_elements(case when jsonb_typeof(m.sources) = 'array' then m.sources else '[]' end)
      with ordinality s(src, i)
     where i <= 10),
   'dossier', (select coalesce(jsonb_agg(jsonb_build_object('kind', di.kind, 'text', di.text)), '[]') from (
     select i.kind, i.text from public.client_dossier_items i
     where i.client_id = v_client and not i.dismissed order by i.pinned desc, i.seen_at desc nulls last limit 15) di),
   'person', (select coalesce(jsonb_agg(jsonb_build_object('vote', f.vote, 'reason', f.reason, 'comment', f.comment,
      'question', left(f.question, 200)) order by f.updated_at desc), '[]') from (
     select * from public.mavi_feedback f where f.company_id = k.company_id and f.user_id = k.user_id
      and (f.comment <> '' or f.reason is not null) order by f.updated_at desc limit 8) f)));
 end loop;
 return v_out;
end $$;

commit;
