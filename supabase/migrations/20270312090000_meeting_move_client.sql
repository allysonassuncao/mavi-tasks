begin;

-- Drive › cliente › Gravações da MAVI: levar gravações para outro cliente
-- (a reunião caiu no cliente errado).
--
-- * Quem move: quem vê no Drive o cliente de origem e o de destino
--   (drive_can_read nos dois). Cliente arquivado não recebe gravações.
-- * A gravação continua só com cliente (sem produto nem pasta): vai para as
--   Gravações da MAVI do novo cliente. Vídeo, transcrição, comentários e o
--   link público vão junto (o link é da gravação, não do cliente).
-- * A MAVI: o documento e os trechos da reunião trocam de cliente na hora
--   (a MAVI do cliente antigo deixa de achá-la já) e a reunião volta para a
--   fila, que reescreve o cabeçalho com o novo cliente.
-- * Radar e Termômetro: a troca de cliente no documento da MAVI dispara os
--   gatilhos que já existem (ai_documents_radar / ai_documents_temperature):
--   o cliente antigo perde as ocorrências e a leitura, e a reunião é lida de
--   novo para o novo cliente.
-- * Custos da MAVI já gastos (meeting_ai_usage, ai_usage) ficam onde
--   aconteceram.
-- * Histórico: recording_moved em drive_audit, com origem e destino.

create function mavi_private.meeting_move(p_company uuid, p_recordings uuid[], p_client uuid, p_apply boolean)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare k public.clients; r record; v_ids uuid[]; from_clients uuid[]; to_place jsonb;
 v_shared integer; v_radar integer; v_temperature integer; begin
 if not mavi_private.member(p_company) then raise exception 'Sem acesso ao espaço' using errcode = '42501'; end if;
 p_recordings := coalesce(p_recordings, '{}');
 if cardinality(p_recordings) = 0 then raise exception 'Escolha as gravações.' using errcode = '22023'; end if;
 if cardinality(p_recordings) > 500 then
  raise exception 'Mova até 500 gravações de cada vez.' using errcode = '22023';
 end if;

 -- As gravações: existem e a pessoa vê o cliente de cada uma.
 for r in select m.id, m.client_id, c.name as client_name from public.meeting_recordings m
  join public.clients c on c.company_id = m.company_id and c.id = m.client_id
  where m.company_id = p_company and m.id = any(p_recordings) order by m.id for update of m loop
  if not mavi_private.drive_can_read(p_company, r.client_id) then
   raise exception 'Sem acesso às gravações de "%".', r.client_name using errcode = '42501';
  end if;
 end loop;
 if (select count(*) from public.meeting_recordings where company_id = p_company and id = any(p_recordings))
  <> (select count(distinct x) from unnest(p_recordings) x) then
  raise exception 'Gravação não encontrada.' using errcode = 'P0002';
 end if;

 -- O destino.
 select * into k from public.clients where company_id = p_company and id = p_client;
 if not found then raise exception 'Cliente não encontrado.' using errcode = 'P0002'; end if;
 if k.archived then
  raise exception 'O cliente "%" está arquivado e não recebe gravações.', k.name using errcode = '42501';
 end if;
 if not mavi_private.drive_can_read(p_company, p_client) then
  raise exception 'Você não atende o cliente "%" e não pode colocar gravações nele.', k.name using errcode = '42501';
 end if;

 select coalesce(array_agg(id), '{}'), coalesce(array_agg(distinct client_id), '{}') into v_ids, from_clients
 from public.meeting_recordings where company_id = p_company and id = any(p_recordings) and client_id <> p_client;
 if cardinality(v_ids) = 0 then
  raise exception 'Já está nas gravações de "%".', k.name using errcode = '22023';
 end if;

 -- O que a pessoa lê antes de confirmar.
 select count(*) into v_shared from public.meeting_shares s
 where s.company_id = p_company and s.recording_id = any(v_ids) and (s.expires_at is null or s.expires_at > now());
 select count(*) into v_radar from public.radar_mentions m
 where m.company_id = p_company and m.source_type = 'meeting' and m.source_id = any(v_ids);
 select count(*) into v_temperature from public.temperature_signals t
 where t.company_id = p_company and t.source_type = 'meeting' and t.source_id = any(v_ids) and t.answers <> '{}';
 to_place := jsonb_build_object('client_id', p_client, 'contract_id', null, 'folder_id', null,
  'label', mavi_private.drive_place_label(p_company, p_client, null, null) || ' › Gravações da MAVI');

 if p_apply then
  -- O histórico primeiro: a origem ainda é a de antes.
  insert into public.drive_audit(company_id, actor_id, action, file_id, folder_id, item_name, client_id, contract_id, details)
  select p_company, auth.uid(), 'recording_moved', null, null,
   coalesce(nullif(m.summary->>'title', ''), nullif(m.title, ''), 'Gravação'), p_client, null,
   jsonb_build_object('recording', m.id,
    'from', jsonb_build_object('client_id', m.client_id, 'contract_id', null, 'folder_id', null,
     'label', mavi_private.drive_place_label(p_company, m.client_id, null, null) || ' › Gravações da MAVI'),
    'to', to_place, 'origin', coalesce(mavi_private.request_client(), '{}'))
  from public.meeting_recordings m where m.company_id = p_company and m.id = any(v_ids);

  -- Um só update: o gatilho da MAVI enfileira todas de uma vez.
  update public.meeting_recordings set client_id = p_client where company_id = p_company and id = any(v_ids);

  -- A MAVI: o cliente muda já no documento e nos trechos (a busca filtra por
  -- eles). Este update também leva o Radar e o Termômetro para o novo cliente.
  update public.ai_documents set client_id = p_client, contract_id = null
  where company_id = p_company and source_type = 'meeting' and source_id = any(v_ids)
   and (client_id, contract_id) is distinct from (p_client, null::uuid);
  update public.ai_chunks c set client_id = p_client, contract_id = null
  from public.ai_documents d
  where d.company_id = p_company and d.source_type = 'meeting' and d.source_id = any(v_ids)
   and c.company_id = d.company_id and c.document_id = d.id
   and (c.client_id, c.contract_id) is distinct from (p_client, null::uuid);

  -- Quem está com as gravações de um dos clientes aberta vê a lista mudar.
  for r in select distinct x as client_id from unnest(from_clients || p_client) x loop
   perform mavi_private.broadcast(p_company, jsonb_build_object('kind', 'meeting', 'table', 'meeting_recordings',
    'client', r.client_id));
  end loop;
 end if;

 return jsonb_build_object('recordings', cardinality(v_ids), 'from_clients', to_jsonb(from_clients), 'to', to_place,
  'shared', v_shared, 'radar_mentions', v_radar, 'temperature', v_temperature);
end $$;
revoke all on function mavi_private.meeting_move(uuid, uuid[], uuid, boolean) from public, anon, authenticated;

-- O que a tela mostra antes de confirmar (não muda nada).
create function public.meeting_move_preview(p_company uuid, p_recordings uuid[], p_client uuid) returns jsonb
language sql security definer set search_path = '' as $$
 select mavi_private.meeting_move(p_company, p_recordings, p_client, false)
$$;
create function public.move_meeting_recordings(p_company uuid, p_recordings uuid[], p_client uuid) returns jsonb
language sql security definer set search_path = '' as $$
 select mavi_private.meeting_move(p_company, p_recordings, p_client, true)
$$;
revoke all on function public.meeting_move_preview(uuid, uuid[], uuid),
 public.move_meeting_recordings(uuid, uuid[], uuid) from public, anon;
grant execute on function public.meeting_move_preview(uuid, uuid[], uuid),
 public.move_meeting_recordings(uuid, uuid[], uuid) to authenticated;

commit;
