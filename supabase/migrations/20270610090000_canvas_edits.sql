-- MAVI · edição direta no canvas: a pessoa edita o documento, a
-- apresentação, o design ou a planilha ali mesmo e, ao salvar, a versão
-- editada vira uma mensagem dela na conversa ("Editei o D1 no canvas:
-- versão D3"), com o documento anexado. Assim a versão aparece no
-- histórico, dá para voltar à anterior e a MAVI continua a partir dela.
-- Só quem começou a conversa salva (como em ai_save_turn); a referência
-- (D3) não pode repetir uma da conversa.

create function public.ai_canvas_edit(p_conversation uuid, p_note text, p_artifact jsonb) returns bigint
language plpgsql security definer set search_path = '' as $$
declare v_company uuid; v_ref text := p_artifact->>'ref'; v_id bigint; begin
 select company_id into v_company from public.ai_conversations
 where id = p_conversation and owner_id = auth.uid();
 if v_company is null or not mavi_private.member(v_company) then
  raise exception 'Só quem começou a conversa salva versões nela.' using errcode = '42501';
 end if;
 if jsonb_typeof(coalesce(p_artifact, 'null')) <> 'object' or p_artifact->>'type' <> 'canvas'
  or jsonb_typeof(p_artifact->'canvas') <> 'object'
  or not mavi_private.ai_artifacts_ok(v_company, jsonb_build_array(p_artifact)) then
  raise exception 'Documento inválido.' using errcode = '22023';
 end if;
 if coalesce(v_ref, '') !~ '^D[0-9]{1,3}$' then raise exception 'Referência inválida.' using errcode = '22023'; end if;
 if exists (select 1 from public.ai_messages m where m.company_id = v_company and m.conversation_id = p_conversation
  and m.artifacts @> jsonb_build_array(jsonb_build_object('ref', v_ref))) then
  raise exception 'A conversa já tem um %: atualize a página e salve de novo.', v_ref using errcode = '23505';
 end if;
 insert into public.ai_messages(company_id, conversation_id, role, content, artifacts)
 values (v_company, p_conversation, 'user', left(coalesce(nullif(btrim(p_note), ''), 'Editei no canvas.'), 2000),
  jsonb_build_array(p_artifact))
 returning id into v_id;
 update public.ai_conversations set updated_at = now() where id = p_conversation;
 return v_id;
end $$;
revoke all on function public.ai_canvas_edit(uuid, text, jsonb) from public, anon;
grant execute on function public.ai_canvas_edit(uuid, text, jsonb) to authenticated;
