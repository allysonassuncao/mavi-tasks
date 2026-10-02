begin;

-- MAVI · Radar pessoal: o número de situações em aberto da pessoa, para o
-- menu lateral (Radar › Pessoal). O mesmo recorte da aba "Em aberto" da
-- lista (personal_radar_items): situações abertas em que ela é dona e não
-- descartou, dos clientes das equipes dela. A tela relê pelo aviso do
-- Realtime (kind "personal_radar"), sem consulta periódica.
create function public.personal_radar_open_count(p_company uuid) returns integer
language sql stable security definer set search_path = '' as $$
 select count(*)::integer from public.personal_radar_owners o
 join public.personal_radar_items i on i.id = o.item_id and i.status = 'open'
 where o.company_id = p_company and o.user_id = auth.uid() and o.state = 'open'
  and mavi_private.member(p_company)
  and i.client_id = any(mavi_private.served_clients_of(p_company, auth.uid()))
$$;
revoke all on function public.personal_radar_open_count(uuid) from public, anon;
grant execute on function public.personal_radar_open_count(uuid) to authenticated;

commit;
