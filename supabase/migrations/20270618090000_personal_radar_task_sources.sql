begin;

-- MAVI · Radar pessoal: as fontes da tarefa sugerida.
--
-- A situação traz só as 4 últimas falas do grupo. Para a descrição da tarefa
-- criada pelo "Revisar e criar" levar as fontes inteiras, a tela lê as falas
-- da situação (até 30, das mais antigas às mais novas, com a mensagem para o
-- link), só para quem é dono da situação.
create function public.personal_radar_item_sources(p_company uuid, p_item uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$ begin
 if not exists (select 1 from public.personal_radar_owners where company_id = p_company and item_id = p_item
   and user_id = auth.uid())
  or not mavi_private.member(p_company) then
  raise exception 'Item não encontrado' using errcode = 'P0002';
 end if;
 return (select coalesce(jsonb_agg(jsonb_build_object('message_id', q.message_id, 'role', q.role, 'speaker', q.speaker,
   'quote', q.quote, 'at', q.at) order by q.at), '[]')
  from (select * from public.personal_radar_mentions pm where pm.company_id = p_company and pm.item_id = p_item
   order by pm.at desc limit 30) q);
end $$;
revoke all on function public.personal_radar_item_sources(uuid, uuid) from public, anon;
grant execute on function public.personal_radar_item_sources(uuid, uuid) to authenticated;

commit;
