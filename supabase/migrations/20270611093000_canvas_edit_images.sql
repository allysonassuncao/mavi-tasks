-- MAVI · edição direta no canvas: as imagens que a pessoa envia do computador
-- no editor entram como anexos (I#) da versão salva, junto com o documento.
-- Assim o link delas se assina como o das imagens da MAVI (ai-image-urls
-- confere que o caminho está numa mensagem da conversa).

drop function public.ai_canvas_edit(uuid, text, jsonb);
create function public.ai_canvas_edit(p_conversation uuid, p_note text, p_artifact jsonb, p_images jsonb default '[]')
returns bigint
language plpgsql security definer set search_path = '' as $$
declare v_company uuid; v_all jsonb; v_id bigint; begin
 select company_id into v_company from public.ai_conversations
 where id = p_conversation and owner_id = auth.uid();
 if v_company is null or not mavi_private.member(v_company) then
  raise exception 'Só quem começou a conversa salva versões nela.' using errcode = '42501';
 end if;
 if jsonb_typeof(coalesce(p_artifact, 'null')) <> 'object' or p_artifact->>'type' <> 'canvas'
  or jsonb_typeof(p_artifact->'canvas') <> 'object' then
  raise exception 'Documento inválido.' using errcode = '22023';
 end if;
 if jsonb_typeof(coalesce(p_images, '[]')) <> 'array' or jsonb_array_length(coalesce(p_images, '[]')) > 8
  or exists (select 1 from jsonb_array_elements(coalesce(p_images, '[]')) i
   where i->>'type' <> 'image' or coalesce(i->>'ref', '') !~ '^I[0-9]{1,3}$') then
  raise exception 'Imagens inválidas.' using errcode = '22023';
 end if;
 v_all := jsonb_build_array(p_artifact) || coalesce(p_images, '[]');
 if not mavi_private.ai_artifacts_ok(v_company, v_all) then raise exception 'Documento inválido.' using errcode = '22023'; end if;
 if coalesce(p_artifact->>'ref', '') !~ '^D[0-9]{1,3}$' then raise exception 'Referência inválida.' using errcode = '22023'; end if;
 if exists (select 1 from jsonb_array_elements(v_all) a, public.ai_messages m
  where m.company_id = v_company and m.conversation_id = p_conversation
   and m.artifacts @> jsonb_build_array(jsonb_build_object('ref', a->>'ref'))) then
  raise exception 'A conversa já tem essa referência: atualize a página e salve de novo.' using errcode = '23505';
 end if;
 insert into public.ai_messages(company_id, conversation_id, role, content, artifacts)
 values (v_company, p_conversation, 'user', left(coalesce(nullif(btrim(p_note), ''), 'Editei no canvas.'), 2000), v_all)
 returning id into v_id;
 update public.ai_conversations set updated_at = now() where id = p_conversation;
 return v_id;
end $$;
revoke all on function public.ai_canvas_edit(uuid, text, jsonb, jsonb) from public, anon;
grant execute on function public.ai_canvas_edit(uuid, text, jsonb, jsonb) to authenticated;
