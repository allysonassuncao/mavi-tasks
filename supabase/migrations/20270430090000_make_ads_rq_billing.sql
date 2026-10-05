begin;

-- Financeiro › Make Ads RQ (pedido de 05/10/2026).
--
-- O Make Ads RQ cobra o cliente por resultado, todo mês, pelo mês anterior:
-- por reunião qualificada (o lead chegou a uma etapa do funil do MakeCRM, ou
-- passou dela) ou por venda realizada (o negócio foi ganho no CRM). No modal
-- "Etapas que importam no CRM" da campanha, quando o cliente tem o produto
-- "Make Ads RQ", escolhe-se o que gera cobrança e quanto custa; no começo do
-- mês, a pessoa confere os leads do mês anterior, tira ou inclui com motivo
-- e valida: o fechamento congela (reabrir só líderes, com motivo).
--
-- * rq_billing: a regra de cada cliente — modelo, funil/etapa, valor fixo
--   por lead ou % da venda, contrato (só variável, fixo + variável ou mínimo
--   garantido, com teto opcional) e quais leads contam (todos, com UTM, ou por
--   origem/campanha do CRM). rq_billing_log guarda cada versão.
-- * rq_adjustments: os leads tirados ou incluídos à mão num mês ainda aberto.
-- * rq_closings: o mês validado, congelado (regra, leads e totais), com quem
--   validou; reaberto, volta a ser contado ao vivo até validar de novo.
-- * rq_events: o histórico (regra, ajustes, validação, reabertura).
-- * Os leads vêm do MakeCRM na hora (api/_crm.ts, ação rq-month); este banco
--   guarda a regra, os ajustes, o que já foi cobrado e a mídia investida.
-- * Módulo próprio "Financeiro › Make Ads RQ" (financeMakeAdsRq) em Módulos
--   visíveis: para colaboradores começa desligado e, ligado, vale só nos
--   clientes das equipes da pessoa (igual ao Financeiro › Mídia).
-- * Dia 1 de cada mês, às 9h de Brasília: aviso 'rq_closing' com os clientes
--   do mês anterior a validar.

-- ------------------------------------------------------------ módulo
-- As listas das outras migrações, com o módulo novo (sem perder o que outra
-- migração tenha acrescentado: lidas da própria regra e escritas de novo com
-- os valores entre aspas, para a próxima poder fazer o mesmo).
do $$ declare v text[]; begin
 select coalesce(array_agg(distinct m[1]), '{}') into v from pg_constraint k,
  regexp_matches(pg_get_constraintdef(k.oid), '''([A-Za-z]+)''', 'g') m
 where k.conname = 'memberships_hidden_pages_check' and k.conrelid = 'public.memberships'::regclass;
 v := array(select distinct x from unnest(v || array['financeMakeAdsRq']) x order by x);
 alter table public.memberships drop constraint if exists memberships_hidden_pages_check;
 execute format('alter table public.memberships add constraint memberships_hidden_pages_check check (hidden_pages <@ array[%s]::text[])',
  (select string_agg(quote_literal(x), ',') from unnest(v) x));
 select coalesce(array_agg(distinct m[1]), '{}') into v from pg_constraint k,
  regexp_matches(pg_get_constraintdef(k.oid), '''([A-Za-z]+)''', 'g') m
 where k.conname = 'memberships_shown_pages_check' and k.conrelid = 'public.memberships'::regclass;
 v := array(select distinct x from unnest(v || array['financeMakeAdsRq']) x order by x);
 alter table public.memberships drop constraint if exists memberships_shown_pages_check;
 execute format('alter table public.memberships add constraint memberships_shown_pages_check check (shown_pages <@ array[%s]::text[])',
  (select string_agg(quote_literal(x), ',') from unnest(v) x));
end $$;

-- A da migração 20270323090000, com o Make Ads RQ entre os opcionais.
create or replace function public.set_member_pages(p_company uuid, p_user uuid, p_hidden text[]) returns void
language plpgsql security definer set search_path = '' as $$
declare v text[]; v_role text;
 opt text[] := array['overview','campaigns','radar','dashboards','financeMedia','financeMakeAdsRq','personalRadar'];
 v_shown text[]; begin
 if not mavi_private.admin(p_company) then
  raise exception 'Somente administradores escolhem os módulos de cada pessoa.' using errcode = '42501';
 end if;
 select role into v_role from public.memberships where company_id = p_company and user_id = p_user;
 if not found then
  raise exception 'Usuário não encontrado na empresa';
 end if;
 select coalesce(array_agg(distinct x order by x), '{}') into v from unnest(coalesce(p_hidden, '{}')) x;
 if not v <@ array['overview','tasks','agenda','clients','products','projects','campaigns','hours',
  'reports','drive','storage','dashboards','onboarding','aiUsage','assistant','cases','notices',
  'temperature','socialMedia','radar','financeMedia','financeMakeAdsRq','personalRadar','agents']::text[] then
  raise exception 'Módulo inválido' using errcode = '22023';
 end if;
 if v_role = 'member' then
  select coalesce(array_agg(x order by x), '{}') into v_shown from unnest(opt) x where not x = any(v);
  select coalesce(array_agg(x order by x), '{}') into v from unnest(v) x where not x = any(opt);
  update public.memberships set hidden_pages = v, shown_pages = v_shown
  where company_id = p_company and user_id = p_user
   and (hidden_pages is distinct from v or shown_pages is distinct from v_shown);
 else
  update public.memberships set hidden_pages = v where company_id = p_company and user_id = p_user
   and hidden_pages is distinct from v;
 end if;
end $$;

-- Quem mexe na cobrança deste cliente: líderes com o módulo à vista, ou
-- colaborador com o módulo ligado numa equipe do cliente.
create function mavi_private.rq_can_for(c uuid, u uuid, p_client uuid) returns boolean
language sql stable security definer set search_path = '' as $$
 select exists (select 1 from public.memberships m
  where m.company_id = c and m.user_id = u and m.active and not ('financeMakeAdsRq' = any(m.hidden_pages))
   and (m.role in ('admin', 'manager')
    or (m.role = 'member' and 'financeMakeAdsRq' = any(m.shown_pages)
     and p_client = any(mavi_private.served_clients_of(c, m.user_id)))))
$$;
create function mavi_private.rq_can(c uuid, p_client uuid) returns boolean
language sql stable security definer set search_path = '' as $$
 select mavi_private.rq_can_for(c, auth.uid(), p_client)
$$;
-- Os clientes do módulo para quem chama (null: líder, todos).
create function mavi_private.rq_scope(c uuid) returns uuid[]
language plpgsql stable security definer set search_path = '' as $$
declare m record; begin
 select role, hidden_pages, shown_pages into m from public.memberships
 where company_id = c and user_id = auth.uid() and active;
 if not found or 'financeMakeAdsRq' = any(m.hidden_pages) then
  raise exception 'Sem permissão' using errcode = '42501';
 end if;
 if m.role in ('admin', 'manager') then return null; end if;
 if 'financeMakeAdsRq' = any(m.shown_pages) then return mavi_private.served_clients(c); end if;
 raise exception 'Sem permissão' using errcode = '42501';
end $$;

-- O cliente tem o produto "Make Ads RQ" contratado (pelo nome, sem ligar
-- para maiúsculas e espaços).
create function mavi_private.rq_product(p_name text) returns boolean
language sql immutable set search_path = '' as $$
 select lower(regexp_replace(btrim(coalesce(p_name, '')), '\s+', ' ', 'g')) = 'make ads rq'
$$;
create function mavi_private.rq_client(c uuid, p_client uuid) returns boolean
language sql stable security definer set search_path = '' as $$
 select exists (select 1 from public.contracts k
  join public.products p on p.company_id = k.company_id and p.id = k.product_id
  where k.company_id = c and k.client_id = p_client and not k.archived and mavi_private.rq_product(p.name))
$$;

-- ------------------------------------------------------------ tabelas
create table public.rq_billing (
 company_id uuid not null references public.companies(id),
 client_id uuid not null,
 -- meeting: por reunião qualificada (etapa); sale: por venda realizada (ganho no CRM).
 model text not null check (model in ('meeting', 'sale')),
 pipeline_id text,
 pipeline_name text not null default '',
 stage_id text,
 stage_name text not null default '',
 -- fixed: valor por lead/venda; percent: % do valor da venda (só por venda).
 price_kind text not null default 'fixed' check (price_kind in ('fixed', 'percent')),
 unit_price numeric(14, 2) check (unit_price > 0),
 percent numeric(6, 3) check (percent > 0 and percent <= 100),
 -- variable: só o variável; fixed_plus: fixo + variável; minimum: o maior entre o variável e o mínimo.
 contract_kind text not null default 'variable' check (contract_kind in ('variable', 'fixed_plus', 'minimum')),
 fixed_amount numeric(14, 2) check (fixed_amount > 0),
 cap numeric(14, 2) check (cap > 0),
 -- {mode: 'all'} | {mode: 'utm', utm_sources: [..]} | {mode: 'crm', sources: [{id,name}], campaigns: [{id,name}]}
 lead_filter jsonb not null default '{"mode": "all"}',
 updated_by uuid default auth.uid(),
 updated_at timestamptz not null default now(),
 primary key (company_id, client_id),
 foreign key (company_id, client_id) references public.clients(company_id, id) on delete cascade,
 check (model = 'sale' or (pipeline_id is not null and stage_id is not null)),
 check ((price_kind = 'fixed' and unit_price is not null and percent is null)
  or (price_kind = 'percent' and model = 'sale' and percent is not null and unit_price is null)),
 check (contract_kind = 'variable' or fixed_amount is not null)
);
alter table public.rq_billing enable row level security;
revoke all on public.rq_billing from public, anon, authenticated;

create table public.rq_billing_log (
 id bigint generated always as identity primary key,
 company_id uuid not null references public.companies(id),
 client_id uuid not null,
 -- nulo: a regra foi removida.
 config jsonb,
 changed_by uuid default auth.uid(),
 changed_at timestamptz not null default now()
);
create index rq_billing_log_client on public.rq_billing_log(company_id, client_id, changed_at desc);
alter table public.rq_billing_log enable row level security;
revoke all on public.rq_billing_log from public, anon, authenticated;

create table public.rq_adjustments (
 id uuid primary key default gen_random_uuid(),
 company_id uuid not null references public.companies(id),
 client_id uuid not null,
 month date not null check (extract(day from month) = 1),
 -- A chave do lead no CRM (oportunidade; na venda, oportunidade:data do ganho).
 key text not null check (length(key) between 1 and 120),
 action text not null check (action in ('exclude', 'include')),
 reason text not null check (length(btrim(reason)) between 3 and 500),
 -- O lead como estava (nome, contato, data, valor): para mostrar e, incluído, para contar.
 lead jsonb not null default '{}',
 created_by uuid default auth.uid(),
 created_at timestamptz not null default now(),
 unique (company_id, client_id, month, key),
 foreign key (company_id, client_id) references public.clients(company_id, id) on delete cascade
);
alter table public.rq_adjustments enable row level security;
revoke all on public.rq_adjustments from public, anon, authenticated;

create table public.rq_closings (
 id uuid primary key default gen_random_uuid(),
 company_id uuid not null references public.companies(id),
 client_id uuid not null,
 month date not null check (extract(day from month) = 1),
 status text not null check (status in ('validated', 'reopened')),
 -- O que valia ao validar: a regra, os leads cobrados e os totais (receita, mídia, resultado).
 config jsonb not null,
 leads jsonb not null check (jsonb_typeof(leads) = 'array'),
 totals jsonb not null check (jsonb_typeof(totals) = 'object'),
 validated_by uuid,
 validated_at timestamptz,
 reopened_by uuid,
 reopened_at timestamptz,
 reopen_reason text,
 unique (company_id, client_id, month),
 foreign key (company_id, client_id) references public.clients(company_id, id) on delete cascade
);
alter table public.rq_closings enable row level security;
revoke all on public.rq_closings from public, anon, authenticated;

create table public.rq_events (
 id bigint generated always as identity primary key,
 company_id uuid not null references public.companies(id),
 client_id uuid not null,
 month date,
 action text not null check (action in ('config', 'exclude', 'include', 'undo', 'validated', 'reopened')),
 reason text,
 detail jsonb not null default '{}',
 user_id uuid default auth.uid(),
 created_at timestamptz not null default now()
);
create index rq_events_client on public.rq_events(company_id, client_id, month, created_at desc);
alter table public.rq_events enable row level security;
revoke all on public.rq_events from public, anon, authenticated;

-- ------------------------------------------------------------ regra
create function mavi_private.rq_config_json(r public.rq_billing) returns jsonb
language sql stable security definer set search_path = '' as $$
 select jsonb_build_object('model', r.model, 'pipeline_id', r.pipeline_id, 'pipeline_name', r.pipeline_name,
  'stage_id', r.stage_id, 'stage_name', r.stage_name, 'price_kind', r.price_kind, 'unit_price', r.unit_price,
  'percent', r.percent, 'contract_kind', r.contract_kind, 'fixed_amount', r.fixed_amount, 'cap', r.cap,
  'lead_filter', r.lead_filter, 'updated_at', r.updated_at,
  'updated_by_name', (select m.name from public.memberships m where m.company_id = r.company_id and m.user_id = r.updated_by))
$$;

-- O filtro dos leads como chega da tela.
create function mavi_private.rq_lead_filter(v jsonb) returns jsonb
language plpgsql immutable set search_path = '' as $$
declare v_mode text := coalesce(v->>'mode', 'all'); v_list jsonb; begin
 if v_mode = 'all' then return '{"mode": "all"}'; end if;
 if v_mode = 'utm' then
  select coalesce(jsonb_agg(distinct lower(btrim(x))), '[]') into v_list
  from jsonb_array_elements_text(case when jsonb_typeof(v->'utm_sources') = 'array' then v->'utm_sources' else '[]' end) x
  where length(btrim(x)) between 1 and 120;
  if jsonb_array_length(v_list) > 20 then
   raise exception 'Escolha até 20 valores de utm_source.' using errcode = '22023';
  end if;
  return jsonb_build_object('mode', 'utm', 'utm_sources', v_list);
 end if;
 if v_mode = 'crm' then
  return jsonb_build_object('mode', 'crm',
   'sources', (select coalesce(jsonb_agg(jsonb_build_object('id', x->>'id', 'name', left(coalesce(x->>'name', ''), 200))), '[]')
    from jsonb_array_elements(case when jsonb_typeof(v->'sources') = 'array' then v->'sources' else '[]' end) x
    where coalesce(x->>'id', '') <> ''),
   'campaigns', (select coalesce(jsonb_agg(jsonb_build_object('id', x->>'id', 'name', left(coalesce(x->>'name', ''), 200))), '[]')
    from jsonb_array_elements(case when jsonb_typeof(v->'campaigns') = 'array' then v->'campaigns' else '[]' end) x
    where coalesce(x->>'id', '') <> ''));
 end if;
 raise exception 'Escolha quais leads contam.' using errcode = '22023';
end $$;

-- A regra de cobrança do cliente, para o modal das etapas e o Financeiro.
-- is_rq: o cliente tem o Make Ads RQ; can_edit: quem chama mexe na cobrança
-- (a regra, com valores, só vai para quem pode).
create function public.rq_billing(p_company uuid, p_client uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare r public.rq_billing; v_can boolean; begin
 if not (mavi_private.module_client(p_company, 'campaigns', p_client) or mavi_private.rq_can(p_company, p_client)) then
  raise exception 'Sem permissão' using errcode = '42501';
 end if;
 v_can := mavi_private.rq_can(p_company, p_client);
 select * into r from public.rq_billing where company_id = p_company and client_id = p_client;
 return jsonb_build_object('is_rq', mavi_private.rq_client(p_company, p_client), 'can_edit', v_can,
  'config', case when v_can and r.client_id is not null then mavi_private.rq_config_json(r) end);
end $$;

-- Grava (ou, com p_config nulo, remove) a regra do cliente.
create function public.set_rq_billing(p_company uuid, p_client uuid, p_config jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare r public.rq_billing; v_model text := p_config->>'model'; v_price text := coalesce(p_config->>'price_kind', 'fixed');
 v_contract text := coalesce(p_config->>'contract_kind', 'variable'); v_unit numeric; v_percent numeric;
 v_fixed numeric; v_cap numeric;
 num constant text := '^\s*[0-9]+(\.[0-9]+)?\s*$'; begin
 if not mavi_private.rq_can(p_company, p_client) then
  raise exception 'Sem permissão para a cobrança deste cliente.' using errcode = '42501';
 end if;
 if p_config is null then
  delete from public.rq_billing where company_id = p_company and client_id = p_client;
  insert into public.rq_billing_log(company_id, client_id, config) values (p_company, p_client, null);
  insert into public.rq_events(company_id, client_id, action, detail) values (p_company, p_client, 'config', '{"removed": true}');
  return null;
 end if;
 if not mavi_private.rq_client(p_company, p_client) then
  raise exception 'O cliente não tem o Make Ads RQ contratado.' using errcode = '22023';
 end if;
 if v_model is null or v_model not in ('meeting', 'sale') then
  raise exception 'Escolha se a cobrança é por reunião qualificada ou por venda.' using errcode = '22023';
 end if;
 if v_model = 'meeting' and (coalesce(p_config->>'stage_id', '') !~* '^[0-9a-f-]{36}$'
  or coalesce(p_config->>'pipeline_id', '') !~* '^[0-9a-f-]{36}$') then
  raise exception 'Escolha a etapa que gera cobrança.' using errcode = '22023';
 end if;
 if coalesce(p_config->>'pipeline_id', '') <> '' and p_config->>'pipeline_id' !~* '^[0-9a-f-]{36}$' then
  raise exception 'Funil inválido.' using errcode = '22023';
 end if;
 if v_model = 'meeting' then v_price := 'fixed'; end if;
 if v_price not in ('fixed', 'percent') or v_contract not in ('variable', 'fixed_plus', 'minimum') then
  raise exception 'Regra de cobrança inválida.' using errcode = '22023';
 end if;
 if v_price = 'fixed' then
  if coalesce(p_config->>'unit_price', '') !~ num or (p_config->>'unit_price')::numeric <= 0 then
   raise exception 'Informe o valor cobrado por %.', case v_model when 'meeting' then 'reunião' else 'venda' end
    using errcode = '22023';
  end if;
  v_unit := round((p_config->>'unit_price')::numeric, 2);
 else
  if coalesce(p_config->>'percent', '') !~ num or (p_config->>'percent')::numeric <= 0
   or (p_config->>'percent')::numeric > 100 then
   raise exception 'Informe a porcentagem da venda (de 0,01 a 100).' using errcode = '22023';
  end if;
  v_percent := round((p_config->>'percent')::numeric, 3);
 end if;
 if v_contract <> 'variable' then
  if coalesce(p_config->>'fixed_amount', '') !~ num or (p_config->>'fixed_amount')::numeric <= 0 then
   raise exception '%', case v_contract when 'fixed_plus' then 'Informe a mensalidade fixa.'
    else 'Informe o valor mínimo mensal.' end using errcode = '22023';
  end if;
  v_fixed := round((p_config->>'fixed_amount')::numeric, 2);
 end if;
 if coalesce(p_config->>'cap', '') <> '' then
  if p_config->>'cap' !~ num or (p_config->>'cap')::numeric <= 0 then
   raise exception 'O teto precisa ser maior que zero.' using errcode = '22023';
  end if;
  v_cap := round((p_config->>'cap')::numeric, 2);
  if v_fixed is not null and v_cap < v_fixed then
   raise exception 'O teto não pode ser menor que o valor fixo/mínimo.' using errcode = '22023';
  end if;
 end if;
 insert into public.rq_billing(company_id, client_id, model, pipeline_id, pipeline_name, stage_id, stage_name,
  price_kind, unit_price, percent, contract_kind, fixed_amount, cap, lead_filter, updated_by, updated_at)
 values (p_company, p_client, v_model, nullif(p_config->>'pipeline_id', ''),
  left(btrim(coalesce(p_config->>'pipeline_name', '')), 200),
  case when v_model = 'meeting' then p_config->>'stage_id' end,
  case when v_model = 'meeting' then left(btrim(coalesce(p_config->>'stage_name', '')), 200) else '' end,
  v_price, v_unit, v_percent, v_contract, v_fixed, v_cap, mavi_private.rq_lead_filter(p_config->'lead_filter'),
  auth.uid(), now())
 on conflict (company_id, client_id) do update set model = excluded.model, pipeline_id = excluded.pipeline_id,
  pipeline_name = excluded.pipeline_name, stage_id = excluded.stage_id, stage_name = excluded.stage_name,
  price_kind = excluded.price_kind, unit_price = excluded.unit_price, percent = excluded.percent,
  contract_kind = excluded.contract_kind, fixed_amount = excluded.fixed_amount, cap = excluded.cap,
  lead_filter = excluded.lead_filter, updated_by = excluded.updated_by, updated_at = excluded.updated_at
 returning * into r;
 insert into public.rq_billing_log(company_id, client_id, config)
 values (p_company, p_client, mavi_private.rq_config_json(r) - 'updated_by_name' - 'updated_at');
 insert into public.rq_events(company_id, client_id, action, detail)
 values (p_company, p_client, 'config', mavi_private.rq_config_json(r) - 'updated_by_name' - 'updated_at');
 return mavi_private.rq_config_json(r);
end $$;

-- ------------------------------------------------------------ o mês
create function mavi_private.rq_month_of(p text) returns date
language plpgsql immutable set search_path = '' as $$ begin
 if coalesce(p, '') !~ '^\d{4}-(0[1-9]|1[0-2])(-01)?$' then
  raise exception 'Mês inválido.' using errcode = '22023';
 end if;
 return (left(p, 7) || '-01')::date;
end $$;

-- A mídia investida no mês: as campanhas dos contratos Make Ads RQ do
-- cliente (sem nenhuma, as campanhas do cliente). net: o gasto da
-- plataforma; gross: com o M.
create function mavi_private.rq_spend(c uuid, p_client uuid, p_month date) returns jsonb
language sql stable security definer set search_path = '' as $$
 with k as (
  select k.id, mavi_private.rq_product(p.name) as rq from public.contracts k
  join public.products p on p.company_id = k.company_id and p.id = k.product_id
  where k.company_id = c and k.client_id = p_client
 ), camp as (
  select a.id from public.ad_campaigns a join k on k.id = a.contract_id
  where a.company_id = c and (k.rq or not exists (select 1 from public.ad_campaigns b join k k2 on k2.id = b.contract_id
   where b.company_id = c and k2.rq))
 )
 select jsonb_build_object(
  'net', coalesce(round(sum(d.spend), 2), 0),
  'gross', coalesce(round(sum(d.spend * d.multiplier), 2), 0),
  'campaigns', (select count(*) from camp))
 from public.ad_daily_metrics d
 where d.company_id = c and d.campaign_id in (select id from camp)
  and d.day >= p_month and d.day < (p_month + interval '1 month')::date
$$;

create function mavi_private.rq_closing_json(x public.rq_closings) returns jsonb
language sql stable security definer set search_path = '' as $$
 select jsonb_build_object('status', x.status, 'config', x.config, 'leads', x.leads, 'totals', x.totals,
  'validated_at', x.validated_at, 'reopened_at', x.reopened_at, 'reopen_reason', x.reopen_reason,
  'validated_by_name', (select m.name from public.memberships m where m.company_id = x.company_id and m.user_id = x.validated_by),
  'reopened_by_name', (select m.name from public.memberships m where m.company_id = x.company_id and m.user_id = x.reopened_by))
$$;

-- Tudo do mês de um cliente para contar (o servidor junta com os leads do
-- MakeCRM): a regra, o fechamento (se houver), os ajustes, as chaves já
-- cobradas em outros meses validados (um lead não é cobrado duas vezes), a
-- mídia e a empresa do CRM ligada ao cliente.
create function public.rq_month(p_company uuid, p_client uuid, p_month text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_month date := mavi_private.rq_month_of(p_month); r public.rq_billing; x public.rq_closings;
 v_today date := mavi_private.company_today(p_company); begin
 if not mavi_private.rq_can(p_company, p_client) then
  raise exception 'Sem permissão' using errcode = '42501';
 end if;
 select * into r from public.rq_billing where company_id = p_company and client_id = p_client;
 select * into x from public.rq_closings where company_id = p_company and client_id = p_client and month = v_month;
 return jsonb_build_object(
  'client', p_client,
  'client_name', (select name from public.clients where company_id = p_company and id = p_client),
  'month', to_char(v_month, 'YYYY-MM'),
  'is_rq', mavi_private.rq_client(p_company, p_client),
  -- O mês já acabou (só então se valida).
  'closed_month', v_month < date_trunc('month', v_today)::date,
  'current_month', v_month = date_trunc('month', v_today)::date,
  'today', v_today,
  'config', case when r.client_id is not null then mavi_private.rq_config_json(r) end,
  'closing', case when x.id is not null then mavi_private.rq_closing_json(x) end,
  'can_reopen', mavi_private.leader(p_company),
  'adjustments', (select coalesce(jsonb_agg(jsonb_build_object('key', a.key, 'action', a.action, 'reason', a.reason,
    'lead', a.lead, 'created_at', a.created_at,
    'by', (select m.name from public.memberships m where m.company_id = a.company_id and m.user_id = a.created_by))
    order by a.created_at), '[]')
   from public.rq_adjustments a where a.company_id = p_company and a.client_id = p_client and a.month = v_month),
  'billed', (select coalesce(jsonb_object_agg(l->>'key', to_char(c.month, 'YYYY-MM')), '{}')
   from public.rq_closings c, jsonb_array_elements(c.leads) l
   where c.company_id = p_company and c.client_id = p_client and c.status = 'validated' and c.month <> v_month),
  'spend', mavi_private.rq_spend(p_company, p_client, v_month),
  'crm_company_id', (select l.crm_company_id from public.client_crm_links l
   where l.company_id = p_company and l.client_id = p_client));
end $$;

-- Os clientes Make Ads RQ do módulo no mês (a tela do Financeiro): a regra,
-- o fechamento e a mídia de cada um; os leads abertos a tela pede um a um.
create function public.rq_overview(p_company uuid, p_month text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_month date := mavi_private.rq_month_of(p_month); v_scope uuid[] := mavi_private.rq_scope(p_company);
 v_today date := mavi_private.company_today(p_company); begin
 return jsonb_build_object(
  'month', to_char(v_month, 'YYYY-MM'),
  'closed_month', v_month < date_trunc('month', v_today)::date,
  'current_month', v_month = date_trunc('month', v_today)::date,
  'can_reopen', mavi_private.leader(p_company),
  'clients', (select coalesce(jsonb_agg(jsonb_build_object(
    'client', cl.id, 'client_name', cl.name, 'color', cl.color,
    'config', case when r.client_id is not null then mavi_private.rq_config_json(r) end,
    'closing', case when x.id is not null then mavi_private.rq_closing_json(x) - 'leads' end,
    'linked', exists (select 1 from public.client_crm_links l where l.company_id = p_company and l.client_id = cl.id),
    'spend', mavi_private.rq_spend(p_company, cl.id, v_month),
    'campaign', (select a.id from public.ad_campaigns a
     join public.contracts k on k.company_id = a.company_id and k.id = a.contract_id
     join public.products p on p.company_id = k.company_id and p.id = k.product_id
     where a.company_id = p_company and k.client_id = cl.id and not a.archived
     order by mavi_private.rq_product(p.name) desc, a.status = 'active' desc, a.updated_at desc limit 1))
    order by cl.name), '[]')
   from public.clients cl
   left join public.rq_billing r on r.company_id = cl.company_id and r.client_id = cl.id
   left join public.rq_closings x on x.company_id = cl.company_id and x.client_id = cl.id and x.month = v_month
   where cl.company_id = p_company and not cl.archived and mavi_private.rq_client(p_company, cl.id)
    and (v_scope is null or cl.id = any(v_scope))));
end $$;

-- Tira ou inclui um lead no mês aberto (p_action nulo: desfaz o ajuste).
create function public.rq_adjust(p_company uuid, p_client uuid, p_month text, p_key text, p_action text,
 p_reason text, p_lead jsonb) returns void
language plpgsql security definer set search_path = '' as $$
declare v_month date := mavi_private.rq_month_of(p_month); v_old public.rq_adjustments; begin
 if not mavi_private.rq_can(p_company, p_client) then
  raise exception 'Sem permissão' using errcode = '42501';
 end if;
 if exists (select 1 from public.rq_closings where company_id = p_company and client_id = p_client
  and month = v_month and status = 'validated') then
  raise exception 'O mês já foi validado: reabra para mudar.' using errcode = '22023';
 end if;
 if coalesce(p_key, '') = '' or length(p_key) > 120 then
  raise exception 'Lead inválido.' using errcode = '22023';
 end if;
 select * into v_old from public.rq_adjustments
 where company_id = p_company and client_id = p_client and month = v_month and key = p_key;
 if p_action is null then
  if v_old.id is null then return; end if;
  delete from public.rq_adjustments where id = v_old.id;
  insert into public.rq_events(company_id, client_id, month, action, reason, detail)
  values (p_company, p_client, v_month, 'undo', null,
   jsonb_build_object('key', p_key, 'was', v_old.action, 'lead', v_old.lead));
  return;
 end if;
 if p_action not in ('exclude', 'include') then
  raise exception 'Ajuste inválido.' using errcode = '22023';
 end if;
 if length(btrim(coalesce(p_reason, ''))) < 3 then
  raise exception 'Conte o motivo.' using errcode = '22023';
 end if;
 insert into public.rq_adjustments(company_id, client_id, month, key, action, reason, lead)
 values (p_company, p_client, v_month, p_key, p_action, left(btrim(p_reason), 500),
  coalesce(case when jsonb_typeof(p_lead) = 'object' then p_lead end, '{}'))
 on conflict (company_id, client_id, month, key) do update set action = excluded.action, reason = excluded.reason,
  lead = excluded.lead, created_by = auth.uid(), created_at = now();
 insert into public.rq_events(company_id, client_id, month, action, reason, detail)
 values (p_company, p_client, v_month, p_action, left(btrim(p_reason), 500), jsonb_build_object('key', p_key,
  'lead', coalesce(case when jsonb_typeof(p_lead) = 'object' then p_lead end, '{}')));
end $$;

-- Valida o mês: congela a regra, os leads e os totais que o servidor contou.
create function public.rq_validate(p_company uuid, p_client uuid, p_month text, p_result jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_month date := mavi_private.rq_month_of(p_month); x public.rq_closings; begin
 if not mavi_private.rq_can(p_company, p_client) then
  raise exception 'Sem permissão' using errcode = '42501';
 end if;
 if v_month >= date_trunc('month', mavi_private.company_today(p_company))::date then
  raise exception 'Só dá para validar depois que o mês acabar.' using errcode = '22023';
 end if;
 if coalesce(jsonb_typeof(p_result->'config'), '') <> 'object' or coalesce(jsonb_typeof(p_result->'leads'), '') <> 'array'
  or coalesce(jsonb_typeof(p_result->'totals'), '') <> 'object' then
  raise exception 'Fechamento inválido.' using errcode = '22023';
 end if;
 if exists (select 1 from jsonb_array_elements(p_result->'leads') l where coalesce(l->>'key', '') = '') then
  raise exception 'Fechamento inválido.' using errcode = '22023';
 end if;
 insert into public.rq_closings(company_id, client_id, month, status, config, leads, totals, validated_by, validated_at)
 values (p_company, p_client, v_month, 'validated', p_result->'config', p_result->'leads', p_result->'totals',
  auth.uid(), now())
 on conflict (company_id, client_id, month) do update set status = 'validated', config = excluded.config,
  leads = excluded.leads, totals = excluded.totals, validated_by = excluded.validated_by,
  validated_at = excluded.validated_at
  where public.rq_closings.status <> 'validated'
 returning * into x;
 if x.id is null then
  raise exception 'O mês já foi validado.' using errcode = '22023';
 end if;
 insert into public.rq_events(company_id, client_id, month, action, detail)
 values (p_company, p_client, v_month, 'validated', jsonb_build_object('count', p_result->'totals'->'count',
  'total', p_result->'totals'->'total'));
 return mavi_private.rq_closing_json(x);
end $$;

-- Reabre um mês validado (só líderes, com motivo): volta a contar ao vivo.
create function public.rq_reopen(p_company uuid, p_client uuid, p_month text, p_reason text) returns void
language plpgsql security definer set search_path = '' as $$
declare v_month date := mavi_private.rq_month_of(p_month); begin
 if not (mavi_private.rq_can(p_company, p_client) and mavi_private.leader(p_company)) then
  raise exception 'Só administradores e gestores reabrem um mês validado.' using errcode = '42501';
 end if;
 if length(btrim(coalesce(p_reason, ''))) < 3 then
  raise exception 'Conte o motivo.' using errcode = '22023';
 end if;
 update public.rq_closings set status = 'reopened', reopened_by = auth.uid(), reopened_at = now(),
  reopen_reason = left(btrim(p_reason), 500)
 where company_id = p_company and client_id = p_client and month = v_month and status = 'validated';
 if not found then
  raise exception 'Este mês não está validado.' using errcode = '22023';
 end if;
 insert into public.rq_events(company_id, client_id, month, action, reason, detail)
 values (p_company, p_client, v_month, 'reopened', left(btrim(p_reason), 500), '{}');
end $$;

-- O histórico do cliente (no mês e as mudanças da regra).
create function public.rq_events(p_company uuid, p_client uuid, p_month text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_month date := mavi_private.rq_month_of(p_month); begin
 if not mavi_private.rq_can(p_company, p_client) then
  raise exception 'Sem permissão' using errcode = '42501';
 end if;
 return (select coalesce(jsonb_agg(jsonb_build_object('action', e.action, 'reason', e.reason, 'detail', e.detail,
   'month', to_char(e.month, 'YYYY-MM'), 'created_at', e.created_at,
   'user_name', (select m.name from public.memberships m where m.company_id = e.company_id and m.user_id = e.user_id))
   order by e.created_at desc, e.id desc), '[]')
  from (select * from public.rq_events e where e.company_id = p_company and e.client_id = p_client
   and (e.month = v_month or e.month is null) order by e.created_at desc, e.id desc limit 100) e);
end $$;

-- A empresa do CRM do cliente para quem tem o módulo mas não Campanhas (a
-- tabela client_crm_links só abre para Campanhas).
create function public.rq_crm_company(p_company uuid, p_client uuid) returns text
language plpgsql stable security definer set search_path = '' as $$ begin
 if not mavi_private.rq_can(p_company, p_client) then
  raise exception 'Sem permissão' using errcode = '42501';
 end if;
 return (select l.crm_company_id from public.client_crm_links l where l.company_id = p_company and l.client_id = p_client);
end $$;

revoke all on function mavi_private.rq_can_for(uuid, uuid, uuid), mavi_private.rq_can(uuid, uuid),
 mavi_private.rq_scope(uuid), mavi_private.rq_client(uuid, uuid), mavi_private.rq_config_json(public.rq_billing),
 mavi_private.rq_lead_filter(jsonb), mavi_private.rq_spend(uuid, uuid, date),
 mavi_private.rq_closing_json(public.rq_closings) from public, anon, authenticated;
revoke all on function public.rq_billing(uuid, uuid), public.set_rq_billing(uuid, uuid, jsonb),
 public.rq_month(uuid, uuid, text), public.rq_overview(uuid, text),
 public.rq_adjust(uuid, uuid, text, text, text, text, jsonb), public.rq_validate(uuid, uuid, text, jsonb),
 public.rq_reopen(uuid, uuid, text, text), public.rq_events(uuid, uuid, text),
 public.rq_crm_company(uuid, uuid) from public, anon;
grant execute on function public.rq_billing(uuid, uuid), public.set_rq_billing(uuid, uuid, jsonb),
 public.rq_month(uuid, uuid, text), public.rq_overview(uuid, text),
 public.rq_adjust(uuid, uuid, text, text, text, text, jsonb), public.rq_validate(uuid, uuid, text, jsonb),
 public.rq_reopen(uuid, uuid, text, text), public.rq_events(uuid, uuid, text),
 public.rq_crm_company(uuid, uuid) to authenticated;

-- ------------------------------------------------------------ aviso do dia 1
-- As listas da migração 20270406090000 (e de outras que tenham vindo depois),
-- com o fechamento do Make Ads RQ.
do $$ declare v text[]; w text[]; begin
 select coalesce(array_agg(distinct m[1]), '{}') into v from pg_constraint k,
  regexp_matches(pg_get_constraintdef(k.oid), '''([a-z_]+)''', 'g') m
 where k.conname = 'notifications_kind_check' and k.conrelid = 'public.notifications'::regclass;
 select coalesce(array_agg(distinct m[1]), '{}') into w from pg_constraint k,
  regexp_matches(pg_get_constraintdef(k.oid), '''([a-z_]+)''', 'g') m
 where k.conname = 'notifications_target_check' and k.conrelid = 'public.notifications'::regclass;
 v := array(select distinct x from unnest(v || array['rq_closing']) x order by x);
 w := array(select distinct x from unnest(w || array['rq_closing', 'notice']) x order by x);
 alter table public.notifications drop constraint notifications_kind_check;
 execute format('alter table public.notifications add constraint notifications_kind_check check (kind in (%s))',
  (select string_agg(quote_literal(x), ',') from unnest(v) x));
 alter table public.notifications drop constraint notifications_target_check;
 execute format('alter table public.notifications add constraint notifications_target_check check ('
  '((kind in (%s)) = (task_id is null)) '
  'and (task_id is not null or (title is not null and link is not null)) '
  'and ((kind = ''notice'') = (notice_id is not null)))', (select string_agg(quote_literal(x), ',') from unnest(w) x));
end $$;

-- A da migração 20270406090000, com o fechamento do Make Ads RQ.
create or replace function mavi_private.notification_pref_keys() returns text[]
language sql immutable set search_path = '' as $$
 select array['assigned', 'mention', 'reply', 'review', 'due_risk',
  'social_leads', 'ai_share', 'success_case', 'temperature', 'ai_skill', 'ai_answer', 'radar_report', 'radar_alert',
  'media_balance', 'priority', 'campaign_alert', 'campaign_insight', 'job_alert', 'rq_closing']
  || array(select 'status.' || s || '.' || r
   from unnest(array['progress', 'returned', 'review', 'rejected', 'correction', 'done']) s,
        unnest(array['creator', 'assignee', 'participant']) r)
$$;

-- Dia 1: para cada pessoa do módulo, um aviso com os clientes do mês
-- anterior ainda sem validar (os com a regra definida) e os sem regra.
create function mavi_private.rq_monthly_notice() returns integer
language plpgsql security definer set search_path = '' as $$
declare n integer := 0; k integer; c record; v_month date; begin
 for c in select distinct r.company_id from public.rq_billing r loop
  v_month := (date_trunc('month', mavi_private.company_today(c.company_id)) - interval '1 month')::date;
  insert into public.notifications(company_id, user_id, actor_id, task_id, kind, title, body, link)
  select c.company_id, m.user_id, null, null, 'rq_closing',
   left(format('Fechamento Make Ads RQ de %s: %s %s para validar', mavi_private.rq_month_name(v_month),
    count(*), case when count(*) = 1 then 'cliente' else 'clientes' end), 300),
   left(string_agg(cl.name, ', ' order by cl.name), 300),
   '/financeiro/make-ads-rq?mes=' || to_char(v_month, 'YYYY-MM')
  from public.memberships m
  join public.clients cl on cl.company_id = m.company_id and not cl.archived
  where m.company_id = c.company_id and m.active
   and mavi_private.rq_client(c.company_id, cl.id)
   and mavi_private.rq_can_for(c.company_id, m.user_id, cl.id)
   and not exists (select 1 from public.rq_closings x where x.company_id = c.company_id and x.client_id = cl.id
    and x.month = v_month and x.status = 'validated')
  group by m.user_id;
  get diagnostics k = row_count;
  n := n + k;
 end loop;
 return n;
end $$;
create function mavi_private.rq_month_name(d date) returns text
language sql immutable set search_path = '' as $$
 select (array['janeiro','fevereiro','março','abril','maio','junho','julho','agosto','setembro','outubro',
  'novembro','dezembro'])[extract(month from d)::int] || '/' || extract(year from d)::int
$$;
revoke all on function mavi_private.rq_monthly_notice(), mavi_private.rq_month_name(date) from public, anon, authenticated;

do $$ begin
 if exists (select 1 from pg_extension where extname = 'pg_cron') then
  -- 12h UTC = 9h de Brasília, no dia 1.
  perform cron.schedule('mavi-rq-closing', '0 12 1 * *', 'select mavi_private.rq_monthly_notice();');
 end if;
end $$;

commit;
