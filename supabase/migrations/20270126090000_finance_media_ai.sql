begin;

-- Financeiro › Mídia na MAVI (migrações 20270114090000 e 20270119090000): as
-- entradas (depósitos e outros créditos lançados por pessoas) de cada conta
-- de mídia, para a MAVI responder "quanto o cliente depositou", "quando foi o
-- último depósito", "quem lançou", "quais clientes depositaram este mês".
--  * Com cliente: cada conta (produto) com o saldo, o mínimo, o total de
--    entradas (e o que foi estornado), a primeira e a última, o que entrou e
--    saiu no período, as entradas mês a mês (12 meses) e a lista das entradas,
--    da mais recente, com categoria, motivo, quem lançou, estorno e
--    comprovantes.
--  * Sem cliente: a carteira, das contas com mais entradas no período.
-- Entrada = lançamento manual de crédito (source 'manual', kind 'credit'); os
-- ajustes do gasto das Campanhas e os estornos não são depósitos.
-- Acesso: o do módulo (module_scope 'financeMedia'); quem tem o módulo
-- escondido em "Módulos visíveis" também não vê pela MAVI.

-- Só os depósitos (poucos perto do gasto diário das Campanhas), por data.
create index media_entries_deposits on public.media_entries(company_id, occurred_on, contract_id)
 include (amount) where kind = 'credit' and source = 'manual';

create function public.media_ai(p_company uuid, p_client uuid default null, p_from date default null,
 p_to date default null, p_limit integer default 30) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_clients uuid[]; v_limit integer := greatest(least(coalesce(p_limit, 30), 100), 1); result jsonb; begin
 v_clients := mavi_private.module_scope(p_company, 'financeMedia');
 if exists (select 1 from public.memberships m where m.company_id = p_company and m.user_id = auth.uid()
   and 'financeMedia' = any(m.hidden_pages)) then
  raise exception 'Sem permissão: Financeiro › Mídia não está disponível para você' using errcode = '42501';
 end if;
 if p_client is not null and v_clients is not null and not p_client = any(v_clients) then
  raise exception 'Sem permissão: este cliente não é de uma equipe sua' using errcode = '42501';
 end if;

 if p_client is null then
  with period as (
   select e.company_id, e.contract_id, sum(e.amount) as credits, count(*) as n, max(e.occurred_on) as last_on
   from public.media_entries e
   where e.company_id = p_company and e.kind = 'credit' and e.source = 'manual'
    and (p_from is null or e.occurred_on >= p_from) and (p_to is null or e.occurred_on <= p_to)
    and not exists (select 1 from public.media_entries r where r.reversal_of = e.id)
   group by 1, 2
  ), rows as (
   select k.id as contract_id, k.client_id, cl.name as client_name, p.name as product_name,
    k.archived or cl.archived as archived, t.credits, t.n, t.last_on,
    coalesce(a.balance, 0) as balance, a.min_balance,
    mavi_private.media_level(coalesce(a.balance, 0), a.min_balance) as level
   from period t
   join public.contracts k on k.company_id = t.company_id and k.id = t.contract_id
   join public.clients cl on cl.company_id = k.company_id and cl.id = k.client_id
   join public.products p on p.company_id = k.company_id and p.id = k.product_id
   left join public.media_accounts a on a.company_id = k.company_id and a.contract_id = k.id
   where v_clients is null or k.client_id = any(v_clients)
  )
  select jsonb_build_object('client', false, 'from', p_from, 'to', p_to,
   'accounts_with_credits', (select count(*) from rows),
   'credits', (select coalesce(sum(credits), 0) from rows),
   'credits_count', (select coalesce(sum(n), 0) from rows),
   'accounts', coalesce((select jsonb_agg(jsonb_build_object('contract_id', r.contract_id, 'client_id', r.client_id,
     'client_name', r.client_name, 'product_name', r.product_name, 'archived', r.archived, 'credits', r.credits,
     'credits_count', r.n, 'last_on', r.last_on, 'balance', r.balance, 'min_balance', r.min_balance, 'level', r.level)
    order by r.credits desc, r.client_name)
    from (select * from rows order by credits desc, client_name limit v_limit) r), '[]'))
  into result;
  return result;
 end if;

 with accounts as (
  select k.id as contract_id, p.name as product_name, k.archived or cl.archived as archived,
   coalesce(a.balance, 0) as balance, a.min_balance, coalesce(a.entries, 0) as entries
  from public.contracts k
  join public.clients cl on cl.company_id = k.company_id and cl.id = k.client_id
  join public.products p on p.company_id = k.company_id and p.id = k.product_id
  left join public.media_accounts a on a.company_id = k.company_id and a.contract_id = k.id
  where k.company_id = p_company and k.client_id = p_client
   and (a.contract_id is not null
    or exists (select 1 from public.ad_campaigns c where c.company_id = k.company_id and c.contract_id = k.id))
 ), credits as (
  select e.*, rv.id as reversal_id, rv.created_at as reversed_at, rv.reason as reversal_reason,
   rm.name as reversed_by
  from public.media_entries e
  join accounts ac on ac.contract_id = e.contract_id
  left join public.media_entries rv on rv.reversal_of = e.id
  left join public.memberships rm on rm.company_id = rv.company_id and rm.user_id = rv.created_by
  where e.company_id = p_company and e.kind = 'credit' and e.source = 'manual'
 )
 select jsonb_build_object('client', true, 'from', p_from, 'to', p_to,
  'accounts', coalesce((select jsonb_agg(jsonb_build_object(
    'contract_id', ac.contract_id, 'product_name', ac.product_name, 'archived', ac.archived,
    'balance', ac.balance, 'min_balance', ac.min_balance,
    'level', mavi_private.media_level(ac.balance, ac.min_balance), 'entries', ac.entries,
    'credits', (select coalesce(sum(c.amount), 0) from credits c where c.contract_id = ac.contract_id
      and c.reversal_id is null),
    'credits_count', (select count(*) from credits c where c.contract_id = ac.contract_id and c.reversal_id is null),
    'reversed', (select coalesce(sum(c.amount), 0) from credits c where c.contract_id = ac.contract_id
      and c.reversal_id is not null),
    'first_on', (select min(c.occurred_on) from credits c where c.contract_id = ac.contract_id and c.reversal_id is null),
    'last', (select jsonb_build_object('on', c.occurred_on, 'amount', c.amount) from credits c
      where c.contract_id = ac.contract_id and c.reversal_id is null
      order by c.occurred_on desc, c.created_at desc limit 1),
    'period', case when p_from is not null or p_to is not null then (
      select jsonb_build_object(
       'credits', coalesce(sum(e.amount) filter (where e.kind = 'credit' and e.source = 'manual'
        and not exists (select 1 from public.media_entries r where r.reversal_of = e.id)), 0),
       'debits', coalesce(sum(e.amount) filter (where e.kind = 'debit'), 0),
       'campaign_spend', coalesce(sum(case e.kind when 'debit' then e.amount else -e.amount end)
        filter (where e.source = 'campaign'), 0))
      from public.media_entries e
      where e.company_id = p_company and e.contract_id = ac.contract_id
       and (p_from is null or e.occurred_on >= p_from) and (p_to is null or e.occurred_on <= p_to)) end)
   order by ac.archived, ac.product_name) from accounts ac), '[]'),
  'monthly', coalesce((select jsonb_agg(jsonb_build_object('month', m.month, 'credits', m.credits, 'count', m.n)
    order by m.month desc)
   from (select to_char(date_trunc('month', c.occurred_on), 'YYYY-MM') as month, sum(c.amount) as credits,
     count(*) as n
    from credits c where c.reversal_id is null
     and c.occurred_on >= (date_trunc('month', coalesce(p_to, mavi_private.company_today(p_company)))
      - interval '11 months')::date
     and c.occurred_on <= coalesce(p_to, mavi_private.company_today(p_company))
    group by 1) m), '[]'),
  'total', (select count(*) from credits c
   where (p_from is null or c.occurred_on >= p_from) and (p_to is null or c.occurred_on <= p_to)),
  'credits', coalesce((select jsonb_agg(jsonb_build_object(
    'id', c.id, 'contract_id', c.contract_id, 'product_name', ac.product_name, 'occurred_on', c.occurred_on,
    'amount', c.amount, 'category', g.name, 'reason', c.reason, 'by', m.name, 'created_at', c.created_at,
    'receipts', (select count(*) from public.media_receipts rc where rc.company_id = c.company_id
      and rc.entry_id = c.id and rc.uploaded),
    'reversed', case when c.reversal_id is not null then jsonb_build_object('at', c.reversed_at,
      'by', c.reversed_by, 'reason', c.reversal_reason) end)
   order by c.occurred_on desc, c.created_at desc)
   from (select * from credits c
    where (p_from is null or c.occurred_on >= p_from) and (p_to is null or c.occurred_on <= p_to)
    order by c.occurred_on desc, c.created_at desc limit v_limit) c
   join accounts ac on ac.contract_id = c.contract_id
   left join public.media_categories g on g.company_id = c.company_id and g.id = c.category_id
   left join public.memberships m on m.company_id = c.company_id and m.user_id = c.created_by), '[]'))
 into result;
 return result;
end $$;
revoke all on function public.media_ai(uuid, uuid, date, date, integer) from public, anon;
grant execute on function public.media_ai(uuid, uuid, date, date, integer) to authenticated;

commit;
