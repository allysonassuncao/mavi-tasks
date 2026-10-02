begin;

-- MAVI · Radar pessoal: a lista por ordem de chegada, da mais recente para a
-- mais antiga (a última fala do cliente em cada situação). Antes, as mais
-- urgentes vinham primeiro; a urgência continua no selo de cada item.

-- A da migração 20270304090000, com a ordem por chegada.
create or replace function public.personal_radar_items(p_company uuid, p_user uuid default null, p_filters jsonb default '{}')
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_user uuid := coalesce(p_user, auth.uid()); f jsonb := coalesce(p_filters, '{}');
 v_status text := coalesce(nullif(f->>'status', ''), 'open'); v_q text := nullif(btrim(coalesce(f->>'q', '')), '');
 v_limit integer := least(greatest(coalesce((f->>'limit')::integer, 50), 1), 200);
 v_offset integer := greatest(coalesce((f->>'offset')::integer, 0), 0); v_out jsonb;
 v_client uuid := case when coalesce(f->>'client', '') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  then (f->>'client')::uuid end; begin
 if not mavi_private.personal_radar_can_view(p_company, v_user) then
  raise exception 'Sem permissão' using errcode = '42501';
 end if;
 with mine as (
  select i.*, o.state from public.personal_radar_owners o
  join public.personal_radar_items i on i.id = o.item_id
  where o.company_id = p_company and o.user_id = v_user
   and i.client_id = any(mavi_private.served_clients_of(p_company, v_user))
 ), base as (
  select * from mine i
  where (v_status = 'all'
    or (v_status = 'open' and i.status = 'open' and i.state = 'open')
    or (v_status = 'resolved' and i.status = 'resolved' and i.state = 'open')
    or (v_status = 'dismissed' and i.state = 'dismissed'))
   and (coalesce(f->>'kind', '') = '' or i.kind = f->>'kind')
   and (v_client is null or i.client_id = v_client)
   and (v_q is null or i.search @@ websearch_to_tsquery('portuguese', v_q) or i.title ilike '%' || v_q || '%'
    or exists (select 1 from public.clients k where k.id = i.client_id and k.name ilike '%' || v_q || '%'))
 ), page as (
  select b.*, count(*) over () as total from base b
  order by b.last_at desc, b.id
  limit v_limit offset v_offset
 )
 select jsonb_build_object(
  'total', coalesce((select max(total) from page), 0),
  'counts', (select jsonb_build_object(
    'open', count(*) filter (where status = 'open' and state = 'open'),
    'resolved', count(*) filter (where status = 'resolved' and state = 'open'),
    'dismissed', count(*) filter (where state = 'dismissed')) from mine),
  'clients', (select coalesce(jsonb_agg(distinct jsonb_build_object('id', k.id, 'name', k.name)), '[]')
   from mine m join public.clients k on k.id = m.client_id),
  'items', coalesce((select jsonb_agg(mavi_private.personal_radar_item_json(i, v_user)
    order by i.last_at desc, i.id)
   from page join public.personal_radar_items i on i.id = page.id), '[]'))
 into v_out;
 return v_out;
end $$;

commit;
