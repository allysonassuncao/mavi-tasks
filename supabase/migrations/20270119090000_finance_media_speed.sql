begin;

-- Financeiro › Mídia mais rápido (migração 20270114090000_finance_media):
--  * O saldo de cada conta fica pronto em media_accounts (saldo, quantos
--    lançamentos e o último), somado a cada gravação no extrato, em vez de
--    somar o extrato inteiro a cada abertura da página. Como lançamentos não
--    se editam nem se apagam, a soma nunca desencontra.
--  * A lista de contas lê esse saldo e manda só o que a tela mostra.
--  * A contagem de lançamentos por categoria usa um índice.
--  * O aviso de saldo só busca nomes quando há aviso a dar.

alter table public.media_accounts
 add column balance numeric(16,2) not null default 0,
 add column entries integer not null default 0 check (entries >= 0),
 add column last_at timestamptz;

insert into public.media_accounts(company_id, contract_id, alert_level)
select distinct e.company_id, e.contract_id, 'ok' from public.media_entries e
on conflict do nothing;
update public.media_accounts a set balance = t.balance, entries = t.n, last_at = t.last_at
from (
 select e.company_id, e.contract_id, sum(case e.kind when 'credit' then e.amount else -e.amount end) as balance,
  count(*) as n, max(e.created_at) as last_at
 from public.media_entries e group by 1, 2
) t where t.company_id = a.company_id and t.contract_id = a.contract_id;

create index media_entries_category on public.media_entries(company_id, category_id) where category_id is not null;

-- O saldo pronto (zero para a conta sem lançamento).
create or replace function mavi_private.media_balance(c uuid, p_contract uuid) returns numeric
language sql stable security definer set search_path = '' as $$
 select coalesce((select a.balance from public.media_accounts a where a.company_id = c and a.contract_id = p_contract), 0)
$$;

-- A da migração 20270114090000: soma o que entrou no saldo de cada conta
-- mexida e, se o nível piorou, avisa.
create or replace function mavi_private.media_entries_changed() returns trigger
language plpgsql security definer set search_path = '' as $$
declare x record; v_balance numeric; v_min numeric; v_old text; v_level text;
 v_rank jsonb := '{"ok":0,"low":1,"negative":2}'; v_contracts jsonb; v_company uuid; k record; begin
 for x in
  select n.company_id, n.contract_id, sum(case n.kind when 'credit' then n.amount else -n.amount end) as delta,
   count(*) as n, max(n.created_at) as last_at, max(n.created_by::text) as actor
  from changed n group by 1, 2
 loop
  insert into public.media_accounts(company_id, contract_id, balance, entries, last_at)
  values (x.company_id, x.contract_id, x.delta, x.n, x.last_at)
  on conflict (company_id, contract_id) do update set balance = public.media_accounts.balance + excluded.balance,
   entries = public.media_accounts.entries + excluded.entries,
   last_at = greatest(public.media_accounts.last_at, excluded.last_at)
  returning balance, min_balance, alert_level into v_balance, v_min, v_old;
  v_level := mavi_private.media_level(v_balance, v_min);
  continue when v_level = v_old;
  update public.media_accounts set alert_level = v_level
  where company_id = x.company_id and contract_id = x.contract_id;
  continue when (v_rank ->> v_level)::int < (v_rank ->> v_old)::int;
  select k2.client_id, cl.name as client_name, p.name as product_name into k
  from public.contracts k2
  join public.clients cl on cl.company_id = k2.company_id and cl.id = k2.client_id
  join public.products p on p.company_id = k2.company_id and p.id = k2.product_id
  where k2.company_id = x.company_id and k2.id = x.contract_id;
  insert into public.notifications(company_id, user_id, actor_id, task_id, kind, title, body, link)
  select x.company_id, u, x.actor::uuid, null, 'media_balance',
   left(format('%s: %s › %s', case v_level when 'negative' then 'Saldo de mídia negativo'
    else 'Saldo de mídia baixo' end, k.client_name, k.product_name), 300),
   left(format('Saldo %s%s', mavi_private.brl(v_balance),
    case when v_min is not null then format(' · mínimo %s', mavi_private.brl(v_min)) else '' end), 300),
   '/financeiro/midia?contrato=' || x.contract_id
  from mavi_private.media_recipients(x.company_id, k.client_id) u;
 end loop;
 for v_company, v_contracts in
  select n.company_id, jsonb_agg(distinct n.contract_id) from changed n group by n.company_id
 loop
  perform mavi_private.broadcast(v_company, jsonb_build_object('kind', 'media',
   'contracts', case when jsonb_array_length(v_contracts) <= 50 then v_contracts end));
 end loop;
 return null;
end $$;

-- A da migração 20270114090000, lendo o saldo pronto e com só o que a tela
-- mostra: conta, cliente, produto, arquivado, saldo, mínimo e nível.
create or replace function public.media_accounts(p_company uuid, p_all boolean default false) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_clients uuid[]; begin
 v_clients := mavi_private.module_scope(p_company, 'financeMedia');
 return jsonb_build_object(
  'is_admin', mavi_private.admin(p_company),
  'is_leader', mavi_private.leader(p_company),
  'accounts', coalesce((
   with campaigns as (
    select c.contract_id from public.ad_campaigns c where c.company_id = p_company and not c.archived
    group by c.contract_id
   )
   select jsonb_agg(jsonb_build_object('contract_id', k.id, 'client_id', k.client_id, 'client_name', cl.name,
     'product_name', p.name, 'product_color', p.color, 'archived', k.archived or cl.archived,
     'balance', coalesce(a.balance, 0), 'min_balance', a.min_balance,
     'level', mavi_private.media_level(coalesce(a.balance, 0), a.min_balance))
    order by mavi_private.fold(cl.name), mavi_private.fold(p.name))
   from public.contracts k
   join public.clients cl on cl.company_id = k.company_id and cl.id = k.client_id
   join public.products p on p.company_id = k.company_id and p.id = k.product_id
   left join public.media_accounts a on a.company_id = k.company_id and a.contract_id = k.id
   left join campaigns g on g.contract_id = k.id
   where k.company_id = p_company
    and (v_clients is null or k.client_id = any(v_clients))
    and (a.contract_id is not null or g.contract_id is not null
     or (coalesce(p_all, false) and not k.archived and not cl.archived))), '[]'));
end $$;

commit;
