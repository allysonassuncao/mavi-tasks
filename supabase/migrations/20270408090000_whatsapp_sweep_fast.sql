begin;

-- A varredura do WhatsApp dentro do limite de 3 s (ela roda pelo PostgREST
-- como anon, com statement_timeout=3s): em produção, só ligar os 842 grupos
-- aos clientes levava 1,7 s por rodada, e a varredura falhava de vez em quando
-- ("canceling statement due to statement timeout"). Enquanto ela falha, as
-- mensagens novas não são lidas (é ela que avança last_message_at).
--
-- * O cliente pelo código: um índice pelo número do começo do nome
--   (substring(name from '^\d+')), no lugar da expressão regular contra todos
--   os clientes a cada grupo. Mesmo resultado: "2745" e "2745 - Facilita"
--   têm o código 2745; "27450 - X" não.
-- * A varredura só religa quem precisa: grupos novos e automáticos com título
--   mudado ou ainda sem cliente. E só grava o que mudou (título, última
--   mensagem, ligação), em vez de reescrever todos os grupos a cada rodada.
-- * Uma vez por dia, mavi_private.whatsapp_rematch_all (pg_cron, sem o limite
--   de 3 s) religa todos os automáticos: cobre o cliente renomeado e o
--   produto contratado ou retirado.
-- * Intervalo da varredura: o administrador escolhe em Painel da MAVI › Grupos
--   do Whatsapp (5 a 240 minutos); sem escolha, segue o automático (o ritmo
--   do Radar pessoal com alguém usando, senão sweep_hours).

-- ------------------------------------------------------------ o cliente pelo código
create index clients_code on public.clients (company_id, (substring(name from '^\d+'))) where name ~ '^\d';

-- A da migração 20261027150000, com a busca pelo índice.
create or replace function mavi_private.whatsapp_match(c uuid, p_title text, out client_id uuid, out product_ids uuid[])
language plpgsql stable security definer set search_path = '' as $$
declare code text := mavi_private.whatsapp_code(p_title); begin
 product_ids := '{}';
 if code is null then return; end if;
 select cl.id into client_id from public.clients cl
  where cl.company_id = c and cl.name ~ '^\d' and substring(cl.name from '^\d+') = code
  order by cl.archived, (cl.name = code) desc, cl.created_at limit 1;
 if client_id is null then return; end if;
 select coalesce(array_agg(distinct p.id), '{}') into product_ids
  from public.contracts ct join public.products p on p.company_id = ct.company_id and p.id = ct.product_id
  where ct.company_id = c and ct.client_id = whatsapp_match.client_id
   and p_title ~* ('\m' || regexp_replace(trim(p.name), '([.^$*+?()\[\]{}|\\-])', '\\\1', 'g') || '\M');
end $$;

-- ------------------------------------------------------------ a varredura
-- A da migração 20261027150000: religa só quem precisa e grava só o que
-- mudou. Devolve quantos grupos a Uazapi mandou (como antes).
create or replace function public.whatsapp_sweep(p_secret text, p_groups jsonb, p_error text default null)
returns integer
language plpgsql security definer set search_path = '' as $$
declare c uuid := mavi_private.whatsapp_company(p_secret); n integer := 0; begin
 if c is null then raise exception 'Não autorizado' using errcode = '42501'; end if;
 if p_error is not null then
  update mavi_private.whatsapp_config set last_sweep_error = left(p_error, 2000) where id;
  return 0;
 end if;
 with incoming as (
  select distinct on (g->>'jid') g->>'jid' as jid, left(coalesce(g->>'title', ''), 300) as title,
   case when (g->>'last_message_at') ~ '^\d+$' and (g->>'last_message_at')::bigint > 0
    then to_timestamp((g->>'last_message_at')::bigint / 1000.0) end as last_at
  from jsonb_array_elements(coalesce(p_groups, '[]')) g
  where g->>'jid' ~ '@g\.us$'
 ), known as (
  select i.jid, i.title, i.last_at, w.id is not null as existing, w.title as old_title, w.client_id as old_client,
   w.product_ids as old_products, w.last_message_at as old_last,
   (w.id is null or (w.linked_by = 'auto' and (w.title is distinct from i.title or w.client_id is null))) as rematch
  from incoming i left join public.whatsapp_groups w on w.company_id = c and w.jid = i.jid
 ), matched as (
  -- A busca só para quem precisa: o "where k.rematch" vira um filtro antes
  -- da chamada (o offset 0 impede o plano de juntar a subconsulta e chamar
  -- a função antes de olhar o filtro).
  select k.*, m.client_id as new_client, m.product_ids as new_products
  from known k
  left join lateral (select x.client_id, coalesce(x.product_ids, '{}') as product_ids
   from mavi_private.whatsapp_match(c, k.title) x where k.rematch offset 0) m on true
 ), todo as (
  select jid, title, last_at,
   case when rematch then new_client else old_client end as client_id,
   case when rematch then coalesce(new_products, '{}') else coalesce(old_products, '{}') end as product_ids
  from matched
  where not existing or title is distinct from old_title
   or last_at > coalesce(old_last, '-infinity'::timestamptz)
   or (rematch and (new_client is distinct from old_client
    or coalesce(new_products, '{}') is distinct from coalesce(old_products, '{}')))
 ), upserted as (
  insert into public.whatsapp_groups as w (company_id, jid, title, client_id, product_ids, last_message_at)
  select c, t.jid, t.title, t.client_id, t.product_ids, t.last_at from todo t
  on conflict (company_id, jid) do update set
   title = excluded.title,
   last_message_at = greatest(w.last_message_at, excluded.last_message_at),
   client_id = case when w.linked_by = 'auto' then excluded.client_id else w.client_id end,
   product_ids = case when w.linked_by = 'auto' then excluded.product_ids else w.product_ids end,
   updated_at = case when w.title is distinct from excluded.title
    or (w.linked_by = 'auto' and (w.client_id is distinct from excluded.client_id or w.product_ids is distinct from excluded.product_ids))
    then now() else w.updated_at end
  returning 1
 ) select count(*) into n from incoming;
 update mavi_private.whatsapp_config set last_sweep_at = now(), last_sweep_error = null where id;
 return n;
end $$;

-- ------------------------------------------------------------ a religação do dia
-- Religa todos os grupos automáticos da empresa (cliente renomeado, produto
-- contratado ou retirado). Devolve quantos mudaram.
create function mavi_private.whatsapp_rematch(c uuid) returns integer
language plpgsql security definer set search_path = '' as $$
declare n integer; begin
 with m as (
  select w.id, x.client_id, coalesce(x.product_ids, '{}') as product_ids
  from public.whatsapp_groups w cross join lateral mavi_private.whatsapp_match(c, w.title) x
  where w.company_id = c and w.linked_by = 'auto'
 )
 update public.whatsapp_groups w set client_id = m.client_id, product_ids = m.product_ids, updated_at = now()
 from m
 where w.id = m.id and (w.client_id is distinct from m.client_id or w.product_ids is distinct from m.product_ids);
 get diagnostics n = row_count;
 return n;
end $$;

create function mavi_private.whatsapp_rematch_all() returns integer
language plpgsql security definer set search_path = '' as $$
declare c uuid; n integer := 0; begin
 for c in select company_id from mavi_private.whatsapp_config loop
  n := n + mavi_private.whatsapp_rematch(c);
 end loop;
 return n;
end $$;
revoke all on function mavi_private.whatsapp_rematch(uuid), mavi_private.whatsapp_rematch_all()
 from public, anon, authenticated;

-- ------------------------------------------------------------ o intervalo
-- Minutos entre as varreduras escolhidos pelo administrador (nulo: automático).
alter table mavi_private.whatsapp_config add column sweep_minutes integer
 check (sweep_minutes between 5 and 240);

-- A da migração 20270304090000: a escolha do administrador vale primeiro.
create or replace function mavi_private.whatsapp_sweep_every(cfg mavi_private.whatsapp_config) returns interval
language sql stable security definer set search_path = '' as $$
 select case when cfg.sweep_minutes is not null then make_interval(mins => cfg.sweep_minutes)
  when mavi_private.personal_radar_on(cfg.company_id)
  then least(make_interval(hours => cfg.sweep_hours),
   make_interval(mins => (mavi_private.personal_radar_config(cfg.company_id)).interval_minutes))
  else make_interval(hours => cfg.sweep_hours) end
$$;

-- O intervalo automático (sem a escolha do administrador), para a tela.
create function mavi_private.whatsapp_auto_minutes(cfg mavi_private.whatsapp_config) returns integer
language sql stable security definer set search_path = '' as $$
 select (extract(epoch from mavi_private.whatsapp_sweep_every(
  jsonb_populate_record(cfg, '{"sweep_minutes": null}'))) / 60)::integer
$$;
revoke all on function mavi_private.whatsapp_auto_minutes(mavi_private.whatsapp_config) from public, anon, authenticated;

-- A da migração 20261030150000, com o intervalo.
create or replace function public.whatsapp_status(p_company uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare cfg mavi_private.whatsapp_config; begin
 if not mavi_private.leader(p_company) then raise exception 'Apenas administradores e gestores' using errcode = '42501'; end if;
 select * into cfg from mavi_private.whatsapp_config where id and company_id = p_company;
 return jsonb_build_object(
  'configured', cfg.company_id is not null,
  'last_sweep_at', cfg.last_sweep_at,
  'last_sweep_error', cfg.last_sweep_error,
  'sweep_hours', coalesce(cfg.sweep_hours, 2),
  'sweep_minutes', cfg.sweep_minutes,
  'auto_minutes', case when cfg.company_id is not null then mavi_private.whatsapp_auto_minutes(cfg) end,
  'radar_minutes', case when cfg.company_id is not null and mavi_private.personal_radar_on(cfg.company_id)
   then (mavi_private.personal_radar_config(cfg.company_id)).interval_minutes end,
  'backfill_days', coalesce(cfg.backfill_days, 8),
  'groups_pending', (select count(*) from public.whatsapp_groups g where g.company_id = p_company
   and g.client_id is not null and not g.ignored and (g.synced_until is null or g.last_message_at > g.synced_until)),
  'groups_with_error', (select count(*) from public.whatsapp_groups g where g.company_id = p_company and g.sync_error is not null),
  'messages', (select coalesce(sum(message_count), 0) from public.whatsapp_groups g where g.company_id = p_company),
  'media_pending', (select count(*) from public.whatsapp_messages m where m.company_id = p_company
   and m.media_status in ('pending', 'failed')),
  'media_lost', (select count(*) from public.whatsapp_messages m where m.company_id = p_company
   and m.media_status in ('lost', 'too_large')),
  'content_pending', (select count(*) from public.whatsapp_messages m where m.company_id = p_company
   and m.content_status = 'pending' and m.content_attempts < 3),
  'content_done', (select count(*) from public.whatsapp_messages m where m.company_id = p_company
   and m.content_status = 'done'));
end $$;

-- O administrador escolhe o intervalo (nulo: automático).
create function public.set_whatsapp_sweep(p_company uuid, p_minutes integer) returns jsonb
language plpgsql security definer set search_path = '' as $$ begin
 if not mavi_private.admin(p_company) then
  raise exception 'Só administradores mudam o intervalo da varredura.' using errcode = '42501';
 end if;
 if p_minutes is not null and p_minutes not between 5 and 240 then
  raise exception 'Escolha de 5 a 240 minutos.' using errcode = '22023';
 end if;
 update mavi_private.whatsapp_config set sweep_minutes = p_minutes where id and company_id = p_company;
 if not found then raise exception 'A coleta do WhatsApp ainda não foi ligada.' using errcode = '22023'; end if;
 return public.whatsapp_status(p_company);
end $$;
revoke all on function public.set_whatsapp_sweep(uuid, integer) from public, anon;
grant execute on function public.set_whatsapp_sweep(uuid, integer) to authenticated;

-- ------------------------------------------------------------ agendamento
-- O PostgreSQL dos testes não tem pg_cron.
do $$ begin
 if exists(select 1 from pg_available_extensions where name = 'pg_cron') then
  create extension if not exists pg_cron;
  perform cron.schedule('mavi-whatsapp-rematch', '17 7 * * *', 'select mavi_private.whatsapp_rematch_all()');
 else
  raise notice 'pg_cron unavailable: schedule mavi_private.whatsapp_rematch_all() on the hosted database';
 end if;
end $$;

commit;
