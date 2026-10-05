-- Radar pessoal: a reserva dos grupos (ai_personal_radar_claim) não gira mais
-- em falso.
--
-- 1. Grupo nunca lido (cursor_at nulo) e sem mensagem no histórico: o material
--    volta nulo e marca checked_until, mas a fila só olhava checked_until com
--    o cursor preenchido. O grupo voltava na mesma hora, o worker o reservava
--    de novo e ficava nisso o tempo todo (centenas de reservas por rodada, a
--    cada 2 minutos), e esses grupos, primeiro na fila, tomavam o lugar dos
--    que tinham o que ler. Agora o "conferido até aqui" vale sempre.
-- 2. A fila calculava quem a MAVI lê (personal_radar_candidates, a conta cara)
--    em todo grupo antes de ordenar. Agora vai primeiro o filtro barato, com
--    quem usa calculado uma vez por empresa (cliente de uma equipe dela, abaixo
--    do teto, celular entre os participantes), e a conta certa só até achar o
--    que pediu, na ordem da fila.

-- Os grupos para ler agora, na ordem da fila (p_company nulo: de todas).
create function mavi_private.personal_radar_pick(p_company uuid, p_limit integer)
returns table(group_id uuid, company_id uuid)
language plpgsql stable security definer set search_path = '' as $$
declare r record; n integer := 0; begin
 if coalesce(p_limit, 0) < 1 then return; end if;
 for r in
  with people as (
   select p.company_id, p.user_id from public.personal_radar_people p
   where p.active and (p_company is null or p.company_id = p_company)
    and mavi_private.personal_radar_allowed(p.company_id, p.user_id)
    and mavi_private.personal_radar_spent(p.company_id, p.user_id) < mavi_private.personal_radar_cap(p.company_id, p.user_id)
  ), reach as (
   select e.company_id,
    (select coalesce(array_agg(distinct c.id), '{}') from people x
      cross join lateral unnest(mavi_private.served_clients_of(x.company_id, x.user_id)) c(id)
     where x.company_id = e.company_id) as clients,
    (select coalesce(array_agg(distinct up.key), '{}') from people x
      join mavi_private.user_phones up on up.user_id = x.user_id
     where x.company_id = e.company_id) as keys
   from (select distinct x.company_id from people x) e
  )
  select g.id, g.company_id from reach
  join public.whatsapp_groups g on g.company_id = reach.company_id and g.client_id = any(reach.clients)
  left join public.personal_radar_groups q on q.group_id = g.id
  where not g.ignored and g.synced_until is not null
   and (q.claimed_until is null or q.claimed_until < now())
   and (q.retry_at is null or q.retry_at < now())
   -- greatest ignora o nulo: lido ou conferido, vale o mais recente.
   and (greatest(q.cursor_at, q.checked_until) is null or g.synced_until > greatest(q.cursor_at, q.checked_until))
   and (g.member_count is null or exists (select 1 from public.whatsapp_group_members w
    where w.group_id = g.id and w.phone_key = any(reach.keys)))
  order by q.cursor_at nulls first, g.synced_until desc
 loop
  if exists (select 1 from mavi_private.personal_radar_candidates(r.company_id, r.id)) then
   group_id := r.id;
   company_id := r.company_id;
   return next;
   n := n + 1;
   exit when n >= p_limit;
  end if;
 end loop;
end $$;
revoke all on function mavi_private.personal_radar_pick(uuid, integer) from public, anon, authenticated;

-- A da migração 20270304090000, pela fila nova.
create or replace function mavi_private.personal_radar_due(c uuid) returns boolean
language sql stable security definer set search_path = '' as $$
 select exists (select 1 from mavi_private.personal_radar_pick(c, 1))
$$;

-- A da migração 20270304090000, pela fila nova.
create or replace function public.ai_personal_radar_claim(p_secret text, p_limit integer default 4) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_out jsonb; begin
 if not mavi_private.ai_secret_ok(p_secret) then raise exception 'Sem permissão' using errcode = '42501'; end if;
 with due as (
  select d.group_id, d.company_id from mavi_private.personal_radar_pick(null, least(greatest(coalesce(p_limit, 4), 1), 12)) d
 ), claimed as (
  insert into public.personal_radar_groups as q (group_id, company_id, claimed_until)
  select d.group_id, d.company_id, now() + interval '10 minutes' from due d
  on conflict (group_id) do update set claimed_until = excluded.claimed_until
  where q.claimed_until is null or q.claimed_until < now()
  returning q.group_id, q.company_id
 )
 select coalesce(jsonb_agg(jsonb_build_object('group_id', c.group_id, 'company_id', c.company_id)), '[]')
 into v_out from claimed c;
 return v_out;
end $$;
