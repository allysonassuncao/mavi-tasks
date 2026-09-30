begin;

-- Financeiro › Mídia: a conta de mídia de cada produto contratado (cliente +
-- produto), como uma conta bancária: entradas (créditos) e saídas (débitos),
-- cada uma com valor, data, categoria, motivo e quem lançou.
--  * Nada se edita nem se apaga: um lançamento errado se corrige com um
--    estorno (o lançamento contrário, com motivo), ligado ao original.
--  * O gasto das Campanhas vira saída sozinho: por dia e por ciclo, o gasto
--    da plataforma × o M do dia (o que sai da verba do cliente). Quando a
--    sincronização refaz os últimos dias e o valor muda, o Sistema lança só a
--    diferença (um ajuste). Todo o histórico já registrado entra agora.
--  * Saldo mínimo por conta: quando o saldo fica abaixo dele (ou negativo),
--    avisa (sino + push) os líderes e quem tem o módulo nos clientes das
--    equipes. O aviso sai na piora, não a cada lançamento.
--  * Categorias por empresa, mantidas pelos administradores (vêm com uma
--    lista padrão).
--  * Comprovantes: arquivos no GCS (como os anexos das tarefas), ligados ao
--    lançamento; podem ser anexados depois.
-- Acesso: o módulo "financeMedia" segue a regra da Visão geral em "Módulos
-- visíveis" (migrações 20270105090000 e 20270107090000): administradores e
-- gestores em todos os clientes; o colaborador só com o módulo ligado, e aí
-- usa tudo, mas só nos clientes das equipes dele. As tabelas não são lidas
-- direto: tudo passa pelas funções abaixo, que recortam pelo cliente.

-- ------------------------------------------------------------ módulo
alter table public.memberships drop constraint if exists memberships_hidden_pages_check;
alter table public.memberships add constraint memberships_hidden_pages_check
 check (hidden_pages <@ array['overview','tasks','agenda','clients','products','projects','campaigns','hours',
  'reports','drive','storage','dashboards','onboarding','aiUsage','assistant','cases','notices',
  'temperature','socialMedia','radar','financeMedia']::text[]);
alter table public.memberships drop constraint if exists memberships_shown_pages_check;
alter table public.memberships add constraint memberships_shown_pages_check
 check (shown_pages <@ array['overview','campaigns','radar','dashboards','financeMedia']::text[]);

-- A da migração 20270105090000, com Financeiro › Mídia entre os opcionais.
create or replace function public.set_member_pages(p_company uuid, p_user uuid, p_hidden text[]) returns void
language plpgsql security definer set search_path = '' as $$
declare v text[]; v_role text; opt text[] := array['overview','campaigns','radar','dashboards','financeMedia'];
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
  'temperature','socialMedia','radar','financeMedia']::text[] then
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

-- ------------------------------------------------------------ avisos
alter table public.notifications drop constraint notifications_kind_check;
alter table public.notifications add constraint notifications_kind_check
 check (kind in ('mention', 'assigned', 'reply', 'social_leads', 'ai_share', 'success_case', 'notice',
  'notice_animation', 'temperature', 'tasks_assigned', 'due_risk', 'status', 'review', 'ai_skill', 'ai_answer',
  'radar_report', 'radar_alert', 'media_balance'));
alter table public.notifications drop constraint notifications_target_check;
alter table public.notifications add constraint notifications_target_check
 check ((kind in ('social_leads', 'ai_share', 'success_case', 'notice', 'notice_animation', 'temperature',
   'tasks_assigned', 'due_risk', 'ai_skill', 'ai_answer', 'radar_report', 'radar_alert', 'media_balance')) = (task_id is null)
  and (task_id is not null or (title is not null and link is not null))
  and ((kind = 'notice') = (notice_id is not null)));
create or replace function mavi_private.notification_pref_keys() returns text[]
language sql immutable set search_path = '' as $$
 select array['assigned', 'mention', 'reply', 'review', 'due_risk',
  'social_leads', 'ai_share', 'success_case', 'temperature', 'ai_skill', 'ai_answer', 'radar_report', 'radar_alert',
  'media_balance']
  || array(select 'status.' || s || '.' || r
   from unnest(array['progress', 'returned', 'review', 'rejected', 'correction', 'done']) s,
        unnest(array['creator', 'assignee', 'participant']) r)
$$;

-- ------------------------------------------------------------ tabelas
create table public.media_categories (
 id uuid primary key default gen_random_uuid(),
 company_id uuid not null references public.companies(id),
 name text not null check (length(btrim(name)) between 2 and 60),
 -- Para que lançamentos ela vale: entradas, saídas ou os dois.
 kind text not null check (kind in ('credit', 'debit', 'both')),
 archived boolean not null default false,
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 unique (company_id, id)
);
create unique index media_categories_name on public.media_categories(company_id, lower(btrim(name)));

-- O que é da conta além do extrato: o saldo mínimo e o último nível avisado.
create table public.media_accounts (
 company_id uuid not null,
 contract_id uuid not null,
 -- Nulo: sem mínimo (só avisa quando fica negativo).
 min_balance numeric(14,2) check (min_balance >= 0 and min_balance < 1000000000000),
 -- O nível do último aviso: o aviso sai quando ele piora.
 alert_level text not null default 'ok' check (alert_level in ('ok', 'low', 'negative')),
 updated_by uuid,
 updated_at timestamptz not null default now(),
 primary key (company_id, contract_id),
 foreign key (company_id, contract_id) references public.contracts(company_id, id)
);

create table public.media_entries (
 id uuid primary key default gen_random_uuid(),
 company_id uuid not null,
 contract_id uuid not null,
 kind text not null check (kind in ('credit', 'debit')),
 amount numeric(14,2) not null check (amount > 0 and amount < 1000000000000),
 -- Quando o dinheiro entrou ou saiu (pode ser antes do registro).
 occurred_on date not null,
 -- manual: lançado por uma pessoa; campaign: o gasto das Campanhas (e os
 -- ajustes dele); reversal: o estorno de outro lançamento.
 source text not null check (source in ('manual', 'campaign', 'reversal')),
 category_id uuid,
 reason text not null check (length(btrim(reason)) between 3 and 1000),
 reversal_of uuid unique references public.media_entries(id),
 -- Do gasto das Campanhas: de que campanha, ciclo e dia, e os números usados.
 campaign_id uuid,
 cycle_id uuid,
 day date,
 spend numeric(14,2),
 multiplier numeric(6,3),
 -- Quem lançou; nulo: o Sistema (a sincronização das Campanhas).
 created_by uuid,
 created_at timestamptz not null default now(),
 unique (company_id, id),
 foreign key (company_id, contract_id) references public.contracts(company_id, id),
 foreign key (company_id, category_id) references public.media_categories(company_id, id),
 check ((source = 'manual') = (category_id is not null)),
 check ((source = 'reversal') = (reversal_of is not null)),
 check ((source = 'campaign') = (cycle_id is not null and day is not null)),
 check (source <> 'manual' or created_by is not null)
);
create index media_entries_account on public.media_entries(company_id, contract_id, occurred_on, created_at, id);
create index media_entries_campaign_day on public.media_entries(cycle_id, day) where source = 'campaign';

create table public.media_receipts (
 id uuid primary key default gen_random_uuid(),
 company_id uuid not null,
 entry_id uuid not null,
 name text not null check (length(btrim(name)) between 1 and 240),
 -- <empresa>/media/<conta>/<comprovante>
 path text not null unique,
 size_bytes bigint not null check (size_bytes between 1 and 104857600),
 -- Falso até o envio terminar (o que não terminou não aparece).
 uploaded boolean not null default false,
 uploaded_by uuid not null default auth.uid(),
 created_at timestamptz not null default now(),
 foreign key (company_id, entry_id) references public.media_entries(company_id, id)
);
create index media_receipts_entry on public.media_receipts(company_id, entry_id);

-- Tudo passa pelas funções abaixo.
alter table public.media_categories enable row level security;
alter table public.media_accounts enable row level security;
alter table public.media_entries enable row level security;
alter table public.media_receipts enable row level security;
revoke all on public.media_categories, public.media_accounts, public.media_entries, public.media_receipts
 from public, anon, authenticated;

-- O extrato não muda: nem quem tem acesso direto ao banco edita ou apaga.
create function mavi_private.media_entries_frozen() returns trigger
language plpgsql set search_path = '' as $$ begin
 raise exception 'Lançamentos não são editados nem excluídos: faça um estorno.' using errcode = '42501';
end $$;
revoke all on function mavi_private.media_entries_frozen() from public, anon, authenticated;
create trigger media_entries_frozen before update or delete on public.media_entries
 for each row execute function mavi_private.media_entries_frozen();

-- ------------------------------------------------------------ apoio
-- R$ 1.234,56 (e -R$ 1.234,56).
create function mavi_private.brl(v numeric) returns text
language sql immutable set search_path = '' as $$
 select case when v < 0 then '-' else '' end || 'R$ '
  || translate(to_char(abs(round(v, 2)), 'FM999,999,999,999,990.00'), ',.', '.,')
$$;
revoke all on function mavi_private.brl(numeric) from public, anon, authenticated;

create function mavi_private.media_platform(p text) returns text
language sql immutable set search_path = '' as $$
 select case p when 'meta' then 'Meta' when 'google' then 'Google' when 'linkedin' then 'LinkedIn'
  when 'tiktok' then 'TikTok' when 'kwai' then 'Kwai' else coalesce(p, '') end
$$;
revoke all on function mavi_private.media_platform(text) from public, anon, authenticated;

-- 1,3 (sem zeros sobrando).
create function mavi_private.media_m(m numeric) returns text
language sql immutable set search_path = '' as $$
 select replace(rtrim(rtrim(m::text, '0'), '.'), '.', ',')
$$;
revoke all on function mavi_private.media_m(numeric) from public, anon, authenticated;

-- O cliente do produto contratado.
create function mavi_private.media_contract_client(c uuid, p_contract uuid) returns uuid
language sql stable security definer set search_path = '' as $$
 select k.client_id from public.contracts k where k.company_id = c and k.id = p_contract
$$;
revoke all on function mavi_private.media_contract_client(uuid, uuid) from public, anon, authenticated;

-- Quem chama usa a conta: líder, ou colaborador com o módulo ligado numa
-- equipe do cliente.
create function mavi_private.media_require(c uuid, p_contract uuid) returns uuid
language plpgsql stable security definer set search_path = '' as $$
declare v_client uuid; begin
 v_client := mavi_private.media_contract_client(c, p_contract);
 if v_client is null then raise exception 'Produto contratado não encontrado' using errcode = 'P0002'; end if;
 if not mavi_private.module_client(c, 'financeMedia', v_client) then
  raise exception 'Sem permissão: este cliente não é de uma equipe sua' using errcode = '42501';
 end if;
 return v_client;
end $$;
revoke all on function mavi_private.media_require(uuid, uuid) from public, anon, authenticated;

create function mavi_private.media_balance(c uuid, p_contract uuid) returns numeric
language sql stable security definer set search_path = '' as $$
 select coalesce(sum(case e.kind when 'credit' then e.amount else -e.amount end), 0)
 from public.media_entries e where e.company_id = c and e.contract_id = p_contract
$$;
revoke all on function mavi_private.media_balance(uuid, uuid) from public, anon, authenticated;

create function mavi_private.media_level(p_balance numeric, p_min numeric) returns text
language sql immutable set search_path = '' as $$
 select case when p_balance < 0 then 'negative' when p_min is not null and p_balance < p_min then 'low' else 'ok' end
$$;
revoke all on function mavi_private.media_level(numeric, numeric) from public, anon, authenticated;

-- ------------------------------------------------------------ categorias
create function mavi_private.media_default_categories(c uuid) returns void
language sql security definer set search_path = '' as $$
 insert into public.media_categories(company_id, name, kind)
 select c, x.name, x.kind from (values
  ('Saldo inicial', 'credit'), ('Depósito do cliente', 'credit'), ('Bônus ou cortesia', 'credit'),
  ('Devolução ao cliente', 'debit'), ('Taxa ou imposto', 'debit'), ('Gasto em outra plataforma', 'debit'),
  ('Transferência entre contas', 'both'), ('Ajuste', 'both')) x(name, kind)
 on conflict do nothing
$$;
revoke all on function mavi_private.media_default_categories(uuid) from public, anon, authenticated;
select mavi_private.media_default_categories(id) from public.companies;

create function mavi_private.media_company_created() returns trigger
language plpgsql security definer set search_path = '' as $$ begin
 perform mavi_private.media_default_categories(new.id);
 return null;
end $$;
revoke all on function mavi_private.media_company_created() from public, anon, authenticated;
create trigger media_default_categories after insert on public.companies
 for each row execute function mavi_private.media_company_created();

create function public.media_categories(p_company uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$ begin
 perform mavi_private.module_scope(p_company, 'financeMedia');
 return coalesce((select jsonb_agg(jsonb_build_object('id', g.id, 'name', g.name, 'kind', g.kind, 'archived', g.archived,
   'entries', (select count(*) from public.media_entries e where e.company_id = g.company_id and e.category_id = g.id))
  order by g.archived, mavi_private.fold(g.name))
  from public.media_categories g where g.company_id = p_company), '[]');
end $$;

-- Cria (p_id nulo) ou muda uma categoria; arquivar tira dos novos lançamentos
-- e mantém nos antigos.
create function public.save_media_category(p_company uuid, p_id uuid, p_name text, p_kind text,
 p_archived boolean default false) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_name text := btrim(coalesce(p_name, '')); begin
 if not mavi_private.admin(p_company) then
  raise exception 'Somente administradores mudam as categorias.' using errcode = '42501';
 end if;
 if length(v_name) not between 2 and 60 then
  raise exception 'O nome da categoria precisa ter de 2 a 60 caracteres.' using errcode = '22023';
 end if;
 if coalesce(p_kind, '') not in ('credit', 'debit', 'both') then
  raise exception 'Escolha se a categoria é de entradas, de saídas ou das duas.' using errcode = '22023';
 end if;
 if exists (select 1 from public.media_categories g where g.company_id = p_company
   and lower(btrim(g.name)) = lower(v_name) and g.id is distinct from p_id) then
  raise exception 'Já existe uma categoria com esse nome.' using errcode = '23505';
 end if;
 if p_id is null then
  insert into public.media_categories(company_id, name, kind, archived)
  values (p_company, v_name, p_kind, coalesce(p_archived, false));
 else
  update public.media_categories set name = v_name, kind = p_kind, archived = coalesce(p_archived, false),
   updated_at = now()
  where company_id = p_company and id = p_id;
  if not found then raise exception 'Categoria não encontrada' using errcode = 'P0002'; end if;
 end if;
 return public.media_categories(p_company);
end $$;

-- ------------------------------------------------------------ contas
-- As contas que quem chama usa: os produtos contratados com lançamento,
-- campanha ou saldo mínimo (e, com p_all, todos os ativos), com o saldo.
create function public.media_accounts(p_company uuid, p_all boolean default false) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_clients uuid[]; begin
 v_clients := mavi_private.module_scope(p_company, 'financeMedia');
 return jsonb_build_object(
  'is_admin', mavi_private.admin(p_company),
  'is_leader', mavi_private.leader(p_company),
  'accounts', coalesce((select jsonb_agg(x order by mavi_private.fold(x ->> 'client_name'), mavi_private.fold(x ->> 'product_name'))
   from (
    select jsonb_build_object('contract_id', k.id, 'client_id', k.client_id, 'client_name', cl.name,
     'product_id', k.product_id, 'product_name', p.name, 'product_color', p.color, 'contract_name', k.name,
     'archived', k.archived or cl.archived,
     'balance', coalesce(t.balance, 0), 'credits', coalesce(t.credits, 0), 'debits', coalesce(t.debits, 0),
     'entries', coalesce(t.n, 0), 'last_on', t.last_on, 'last_at', t.last_at,
     'min_balance', a.min_balance,
     'level', mavi_private.media_level(coalesce(t.balance, 0), a.min_balance),
     'campaigns', (select count(*) from public.ad_campaigns c where c.company_id = k.company_id
       and c.contract_id = k.id and not c.archived)) as x
    from public.contracts k
    join public.clients cl on cl.company_id = k.company_id and cl.id = k.client_id
    join public.products p on p.company_id = k.company_id and p.id = k.product_id
    left join public.media_accounts a on a.company_id = k.company_id and a.contract_id = k.id
    left join lateral (
     select sum(case e.kind when 'credit' then e.amount else -e.amount end) as balance,
      sum(e.amount) filter (where e.kind = 'credit') as credits,
      sum(e.amount) filter (where e.kind = 'debit') as debits,
      count(*) as n, max(e.occurred_on) as last_on, max(e.created_at) as last_at
     from public.media_entries e where e.company_id = k.company_id and e.contract_id = k.id
    ) t on true
    where k.company_id = p_company
     and (v_clients is null or k.client_id = any(v_clients))
     and (coalesce(t.n, 0) > 0 or a.contract_id is not null
      or exists (select 1 from public.ad_campaigns c where c.company_id = k.company_id and c.contract_id = k.id
       and not c.archived)
      or (coalesce(p_all, false) and not k.archived and not cl.archived))
   ) s), '[]'));
end $$;

-- O extrato de uma conta no período, do mais novo ao mais antigo, com o
-- saldo depois de cada lançamento.
create function public.media_statement(p_company uuid, p_contract uuid, p_from date default null,
 p_to date default null, p_kind text default '', p_category uuid default null, p_limit integer default 100,
 p_offset integer default 0) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_min numeric; v_balance numeric; v_opening numeric; result jsonb; begin
 perform mavi_private.media_require(p_company, p_contract);
 select a.min_balance into v_min from public.media_accounts a
 where a.company_id = p_company and a.contract_id = p_contract;
 v_balance := mavi_private.media_balance(p_company, p_contract);
 select coalesce(sum(case e.kind when 'credit' then e.amount else -e.amount end), 0) into v_opening
 from public.media_entries e where e.company_id = p_company and e.contract_id = p_contract
  and p_from is not null and e.occurred_on < p_from;
 with running as (
  select e.*, sum(case e.kind when 'credit' then e.amount else -e.amount end)
    over (order by e.occurred_on, e.created_at, e.id) as balance_after
  from public.media_entries e where e.company_id = p_company and e.contract_id = p_contract
 ), filtered as (
  select r.* from running r
  where (p_from is null or r.occurred_on >= p_from) and (p_to is null or r.occurred_on <= p_to)
   and (coalesce(p_kind, '') = '' or r.kind = p_kind
    or (p_kind = 'campaign' and r.source = 'campaign') or (p_kind = 'reversal' and r.source = 'reversal'))
   and (p_category is null or r.category_id = p_category)
 ), page as (
  select f.* from filtered f order by f.occurred_on desc, f.created_at desc, f.id desc
  limit greatest(least(coalesce(p_limit, 100), 500), 1) offset greatest(coalesce(p_offset, 0), 0)
 )
 select jsonb_build_object(
  'balance', v_balance, 'min_balance', v_min, 'level', mavi_private.media_level(v_balance, v_min),
  'opening', v_opening,
  'total', (select count(*) from filtered),
  'credits', (select coalesce(sum(amount), 0) from filtered where kind = 'credit'),
  'debits', (select coalesce(sum(amount), 0) from filtered where kind = 'debit'),
  'entries', coalesce((select jsonb_agg(jsonb_build_object(
    'id', g.id, 'kind', g.kind, 'amount', g.amount, 'occurred_on', g.occurred_on, 'source', g.source,
    'category_id', g.category_id, 'category_name', cat.name, 'reason', g.reason,
    'campaign_id', g.campaign_id, 'campaign_name', ac.name, 'platform', ac.platform, 'day', g.day,
    'spend', g.spend, 'multiplier', g.multiplier,
    'created_by', g.created_by, 'created_by_name', m.name, 'created_at', g.created_at,
    'balance_after', g.balance_after,
    'reversal_of', g.reversal_of,
    'reversed_by', (select jsonb_build_object('id', rv.id, 'created_at', rv.created_at, 'by_name', rm.name,
      'reason', rv.reason)
     from public.media_entries rv left join public.memberships rm on rm.company_id = rv.company_id
      and rm.user_id = rv.created_by
     where rv.reversal_of = g.id),
    'receipts', coalesce((select jsonb_agg(jsonb_build_object('id', rc.id, 'name', rc.name, 'path', rc.path,
      'size_bytes', rc.size_bytes, 'created_at', rc.created_at) order by rc.created_at)
     from public.media_receipts rc where rc.company_id = g.company_id and rc.entry_id = g.id and rc.uploaded), '[]'))
   order by g.occurred_on desc, g.created_at desc, g.id desc)
   from page g
   left join public.media_categories cat on cat.company_id = g.company_id and cat.id = g.category_id
   left join public.ad_campaigns ac on ac.company_id = g.company_id and ac.id = g.campaign_id
   left join public.memberships m on m.company_id = g.company_id and m.user_id = g.created_by), '[]'))
 into result;
 return result;
end $$;

-- ------------------------------------------------------------ lançamentos
create function public.create_media_entry(p_company uuid, p_contract uuid, p_kind text, p_amount numeric,
 p_occurred_on date, p_category uuid, p_reason text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare g public.media_categories; v_id uuid; v_reason text := btrim(coalesce(p_reason, '')); begin
 perform mavi_private.media_require(p_company, p_contract);
 if coalesce(p_kind, '') not in ('credit', 'debit') then
  raise exception 'Escolha entrada ou saída.' using errcode = '22023';
 end if;
 if p_amount is null or p_amount <= 0 or p_amount >= 1000000000000 or round(p_amount, 2) <> p_amount then
  raise exception 'Informe um valor maior que zero, com até dois decimais.' using errcode = '22023';
 end if;
 if p_occurred_on is null then raise exception 'Informe a data do lançamento.' using errcode = '22023'; end if;
 if p_occurred_on > mavi_private.company_today(p_company) then
  raise exception 'A data do lançamento não pode ser futura.' using errcode = '22023';
 end if;
 if p_occurred_on < date '2000-01-01' then raise exception 'Data inválida.' using errcode = '22023'; end if;
 select * into g from public.media_categories where company_id = p_company and id = p_category;
 if not found or g.archived then raise exception 'Escolha uma categoria.' using errcode = '22023'; end if;
 if g.kind <> 'both' and g.kind <> p_kind then
  raise exception 'A categoria "%" é só de %.', g.name, case g.kind when 'credit' then 'entradas' else 'saídas' end
   using errcode = '22023';
 end if;
 if length(v_reason) not between 3 and 1000 then
  raise exception 'Escreva o motivo do lançamento (de 3 a 1000 caracteres).' using errcode = '22023';
 end if;
 insert into public.media_entries(company_id, contract_id, kind, amount, occurred_on, source, category_id, reason,
  created_by)
 values (p_company, p_contract, p_kind, p_amount, p_occurred_on, 'manual', g.id, v_reason, auth.uid())
 returning id into v_id;
 return v_id;
end $$;

-- O estorno: o lançamento contrário, de hoje, com o motivo. Um por lançamento;
-- estorno não se estorna. O gasto das Campanhas também pode ser estornado (a
-- sincronização segue lançando só as diferenças do gasto, sem refazer o que
-- foi estornado).
create function public.reverse_media_entry(p_company uuid, p_entry uuid, p_reason text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare e public.media_entries; v_id uuid; v_reason text := btrim(coalesce(p_reason, '')); begin
 select * into e from public.media_entries where company_id = p_company and id = p_entry;
 if not found then raise exception 'Lançamento não encontrado' using errcode = 'P0002'; end if;
 perform mavi_private.media_require(p_company, e.contract_id);
 if e.source = 'reversal' then
  raise exception 'Um estorno não pode ser estornado: faça um novo lançamento.' using errcode = '22023';
 end if;
 if exists (select 1 from public.media_entries r where r.reversal_of = e.id) then
  raise exception 'Este lançamento já foi estornado.' using errcode = '23505';
 end if;
 if length(v_reason) not between 3 and 1000 then
  raise exception 'Escreva o motivo do estorno (de 3 a 1000 caracteres).' using errcode = '22023';
 end if;
 insert into public.media_entries(company_id, contract_id, kind, amount, occurred_on, source, reason, reversal_of,
  created_by)
 values (e.company_id, e.contract_id, case e.kind when 'credit' then 'debit' else 'credit' end, e.amount,
  greatest(mavi_private.company_today(p_company), e.occurred_on), 'reversal', v_reason, e.id, auth.uid())
 returning id into v_id;
 return v_id;
end $$;

-- O saldo mínimo da conta (nulo: sem mínimo). O nível passa a ser o do saldo
-- de agora, sem avisar quem acabou de mudar.
create function public.set_media_account(p_company uuid, p_contract uuid, p_min_balance numeric) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_balance numeric; begin
 perform mavi_private.media_require(p_company, p_contract);
 if p_min_balance is not null and (p_min_balance < 0 or p_min_balance >= 1000000000000) then
  raise exception 'O saldo mínimo precisa ser zero ou mais.' using errcode = '22023';
 end if;
 v_balance := mavi_private.media_balance(p_company, p_contract);
 insert into public.media_accounts(company_id, contract_id, min_balance, alert_level, updated_by, updated_at)
 values (p_company, p_contract, round(p_min_balance, 2), mavi_private.media_level(v_balance, p_min_balance),
  auth.uid(), now())
 on conflict (company_id, contract_id) do update set min_balance = excluded.min_balance,
  alert_level = excluded.alert_level, updated_by = excluded.updated_by, updated_at = now();
 return jsonb_build_object('min_balance', round(p_min_balance, 2), 'level',
  mavi_private.media_level(v_balance, p_min_balance));
end $$;

-- ------------------------------------------------------------ comprovantes
create function public.prepare_media_receipt(p_company uuid, p_entry uuid, p_name text, p_size bigint)
 returns public.media_receipts
language plpgsql security definer set search_path = '' as $$
declare e public.media_entries; r public.media_receipts; rid uuid := gen_random_uuid(); begin
 select * into e from public.media_entries where company_id = p_company and id = p_entry;
 if not found then raise exception 'Lançamento não encontrado' using errcode = 'P0002'; end if;
 perform mavi_private.media_require(p_company, e.contract_id);
 if length(btrim(coalesce(p_name, ''))) not between 1 and 240 then
  raise exception 'Nome de arquivo inválido' using errcode = '22023';
 end if;
 if mavi_private.blocked_file(p_name) then
  raise exception 'Por segurança, programas e scripts (.exe, .bat, .sh, .apk…) não podem ser anexados.'
   using errcode = '22023';
 end if;
 if coalesce(p_size, 0) not between 1 and 104857600 then
  raise exception 'Escolha um arquivo não vazio de até 100 MB.' using errcode = '22023';
 end if;
 if (select count(*) from public.media_receipts x where x.company_id = p_company and x.entry_id = p_entry
   and x.uploaded) >= 10 then
  raise exception 'Um lançamento tem até 10 comprovantes.' using errcode = '22023';
 end if;
 insert into public.media_receipts(id, company_id, entry_id, name, path, size_bytes)
 values (rid, p_company, p_entry, btrim(p_name),
  p_company::text || '/media/' || e.contract_id::text || '/' || rid::text, p_size)
 returning * into r;
 return r;
end $$;

-- Para /api/gcs/sign-upload: o que quem chama acabou de preparar.
create function public.media_receipt_upload_target(p_receipt uuid) returns table(path text, name text, size_bytes bigint)
language sql stable security definer set search_path = '' as $$
 select r.path, r.name, r.size_bytes from public.media_receipts r
 join public.media_entries e on e.company_id = r.company_id and e.id = r.entry_id
 where r.id = p_receipt and r.uploaded_by = auth.uid() and not r.uploaded
  and r.created_at > now() - interval '15 minutes'
  and mavi_private.module_client(r.company_id, 'financeMedia', mavi_private.media_contract_client(e.company_id, e.contract_id))
$$;

-- O envio terminou: o comprovante aparece no extrato.
create function public.confirm_media_receipt(p_receipt uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare v_contract uuid; v_company uuid; begin
 update public.media_receipts r set uploaded = true
 where r.id = p_receipt and r.uploaded_by = auth.uid() and not r.uploaded
 returning r.company_id, (select e.contract_id from public.media_entries e where e.company_id = r.company_id
  and e.id = r.entry_id) into v_company, v_contract;
 if not found then raise exception 'Comprovante não encontrado' using errcode = 'P0002'; end if;
 perform mavi_private.broadcast(v_company, jsonb_build_object('kind', 'media', 'contracts', jsonb_build_array(v_contract)));
end $$;

-- O envio falhou: o rascunho sai.
create function public.discard_media_receipt(p_receipt uuid) returns void
language sql security definer set search_path = '' as $$
 delete from public.media_receipts where id = p_receipt and uploaded_by = auth.uid() and not uploaded
$$;

-- ------------------------------------------------------------ Campanhas
-- O que a campanha tirou da conta num dia: gasto × M. O extrato guarda o que
-- já foi lançado para o ciclo e o dia; cada mudança lança só a diferença.
create function mavi_private.media_campaign_reason(p_first boolean, p_removed boolean, p_platform text,
 p_campaign text, p_day date, p_spend numeric, p_m numeric) returns text
language sql immutable set search_path = '' as $$
 select left(case
  when p_removed then format('Gasto %s de %s removido da campanha %s (registro excluído)',
   mavi_private.media_platform(p_platform), to_char(p_day, 'DD/MM/YYYY'), coalesce(p_campaign, '—'))
  when p_first then format('Gasto %s de %s na campanha %s: %s × M %s',
   mavi_private.media_platform(p_platform), to_char(p_day, 'DD/MM/YYYY'), coalesce(p_campaign, '—'),
   mavi_private.brl(p_spend), mavi_private.media_m(p_m))
  else format('Ajuste do gasto %s de %s na campanha %s: agora %s × M %s',
   mavi_private.media_platform(p_platform), to_char(p_day, 'DD/MM/YYYY'), coalesce(p_campaign, '—'),
   mavi_private.brl(p_spend), mavi_private.media_m(p_m)) end, 1000)
$$;
revoke all on function mavi_private.media_campaign_reason(boolean, boolean, text, text, date, numeric, numeric)
 from public, anon, authenticated;

create function mavi_private.media_campaign_spend() returns trigger
language plpgsql security definer set search_path = '' as $$
declare r record; v_target numeric; v_done numeric; v_n integer; v_contract uuid; v_diff numeric; a record; begin
 if tg_op = 'DELETE' then r := old; else r := new; end if;
 if tg_op = 'UPDATE' and new.spend = old.spend and new.multiplier = old.multiplier then return null; end if;
 v_target := case when tg_op = 'DELETE' then 0 else round(r.spend * r.multiplier, 2) end;
 select coalesce(sum(case e.kind when 'debit' then e.amount else -e.amount end), 0), count(*),
  (array_agg(e.contract_id))[1]
 into v_done, v_n, v_contract
 from public.media_entries e where e.cycle_id = r.cycle_id and e.day = r.day and e.source = 'campaign';
 v_diff := v_target - v_done;
 if v_diff = 0 then return null; end if;
 select c.name, c.platform, c.contract_id into a from public.ad_campaigns c
 where c.company_id = r.company_id and c.id = r.campaign_id;
 v_contract := coalesce(v_contract, a.contract_id);
 if v_contract is null then return null; end if;
 insert into public.media_entries(company_id, contract_id, kind, amount, occurred_on, source, reason,
  campaign_id, cycle_id, day, spend, multiplier, created_by)
 values (r.company_id, v_contract, case when v_diff > 0 then 'debit' else 'credit' end, abs(v_diff), r.day,
  'campaign', mavi_private.media_campaign_reason(v_n = 0, tg_op = 'DELETE', a.platform, a.name, r.day, r.spend,
   r.multiplier),
  r.campaign_id, r.cycle_id, r.day, case when tg_op = 'DELETE' then 0 else r.spend end, r.multiplier,
  -- Um dia digitado à mão é de quem digitou; o da plataforma, do Sistema.
  case when tg_op <> 'DELETE' and r.source = 'manual' then auth.uid() end);
 return null;
end $$;
revoke all on function mavi_private.media_campaign_spend() from public, anon, authenticated;

-- Todo o histórico já registrado (o do MASO também), antes dos avisos.
insert into public.media_entries(company_id, contract_id, kind, amount, occurred_on, source, reason,
 campaign_id, cycle_id, day, spend, multiplier, created_by, created_at)
select d.company_id, c.contract_id, 'debit', round(d.spend * d.multiplier, 2), d.day, 'campaign',
 mavi_private.media_campaign_reason(true, false, c.platform, c.name, d.day, d.spend, d.multiplier),
 d.campaign_id, d.cycle_id, d.day, d.spend, d.multiplier, null, coalesce(d.synced_at, now())
from public.ad_daily_metrics d
join public.ad_campaigns c on c.company_id = d.company_id and c.id = d.campaign_id
where round(d.spend * d.multiplier, 2) > 0;

insert into public.media_accounts(company_id, contract_id, alert_level)
select e.company_id, e.contract_id,
 mavi_private.media_level(sum(case e.kind when 'credit' then e.amount else -e.amount end), null)
from public.media_entries e group by e.company_id, e.contract_id
on conflict do nothing;

create trigger media_campaign_spend after insert or update of spend, multiplier or delete on public.ad_daily_metrics
 for each row execute function mavi_private.media_campaign_spend();

-- ------------------------------------------------------------ avisos do saldo
-- Quem recebe: líderes (com o módulo à vista) e colaboradores com o módulo
-- ligado numa equipe do cliente. A preferência "media_balance" de cada um
-- vale (filter_notification).
create function mavi_private.media_recipients(c uuid, p_client uuid) returns setof uuid
language sql stable security definer set search_path = '' as $$
 select m.user_id from public.memberships m
 where m.company_id = c and m.active and not ('financeMedia' = any(m.hidden_pages))
  and (m.role in ('admin', 'manager')
   or (m.role = 'member' and 'financeMedia' = any(m.shown_pages)
    and p_client = any(mavi_private.served_clients_of(c, m.user_id))))
$$;
revoke all on function mavi_private.media_recipients(uuid, uuid) from public, anon, authenticated;

-- Depois de cada gravação no extrato: o nível de cada conta mexida; se
-- piorou, o aviso; e um aviso ao vivo para as telas abertas.
create function mavi_private.media_entries_changed() returns trigger
language plpgsql security definer set search_path = '' as $$
declare x record; v_balance numeric; v_level text; v_rank jsonb := '{"ok":0,"low":1,"negative":2}';
 v_contracts jsonb; v_company uuid; begin
 for x in
  select n.company_id, n.contract_id, a.min_balance, coalesce(a.alert_level, 'ok') as alert_level,
   k.client_id, cl.name as client_name, p.name as product_name, max(n.created_by::text) as actor
  from changed n
  join public.contracts k on k.company_id = n.company_id and k.id = n.contract_id
  join public.clients cl on cl.company_id = k.company_id and cl.id = k.client_id
  join public.products p on p.company_id = k.company_id and p.id = k.product_id
  left join public.media_accounts a on a.company_id = n.company_id and a.contract_id = n.contract_id
  group by 1, 2, 3, 4, 5, 6, 7
 loop
  v_balance := mavi_private.media_balance(x.company_id, x.contract_id);
  v_level := mavi_private.media_level(v_balance, x.min_balance);
  if v_level is distinct from x.alert_level then
   insert into public.media_accounts(company_id, contract_id, alert_level)
   values (x.company_id, x.contract_id, v_level)
   on conflict (company_id, contract_id) do update set alert_level = excluded.alert_level;
  end if;
  if (v_rank ->> v_level)::int > (v_rank ->> x.alert_level)::int then
   insert into public.notifications(company_id, user_id, actor_id, task_id, kind, title, body, link)
   select x.company_id, u, x.actor::uuid, null, 'media_balance',
    left(format('%s: %s › %s', case v_level when 'negative' then 'Saldo de mídia negativo'
     else 'Saldo de mídia baixo' end, x.client_name, x.product_name), 300),
    left(format('Saldo %s%s', mavi_private.brl(v_balance),
     case when x.min_balance is not null then format(' · mínimo %s', mavi_private.brl(x.min_balance)) else '' end), 300),
    '/financeiro/midia?contrato=' || x.contract_id
   from mavi_private.media_recipients(x.company_id, x.client_id) u;
  end if;
 end loop;
 for v_company, v_contracts in
  select n.company_id, jsonb_agg(distinct n.contract_id) from changed n group by n.company_id
 loop
  perform mavi_private.broadcast(v_company, jsonb_build_object('kind', 'media',
   'contracts', case when jsonb_array_length(v_contracts) <= 50 then v_contracts end));
 end loop;
 return null;
end $$;
revoke all on function mavi_private.media_entries_changed() from public, anon, authenticated;
create trigger media_entries_changed after insert on public.media_entries
 referencing new table as changed for each statement execute function mavi_private.media_entries_changed();

-- ------------------------------------------------------------ permissões
revoke all on function public.media_categories(uuid), public.save_media_category(uuid, uuid, text, text, boolean),
 public.media_accounts(uuid, boolean),
 public.media_statement(uuid, uuid, date, date, text, uuid, integer, integer),
 public.create_media_entry(uuid, uuid, text, numeric, date, uuid, text),
 public.reverse_media_entry(uuid, uuid, text), public.set_media_account(uuid, uuid, numeric),
 public.prepare_media_receipt(uuid, uuid, text, bigint), public.media_receipt_upload_target(uuid),
 public.confirm_media_receipt(uuid), public.discard_media_receipt(uuid) from public, anon;
grant execute on function public.media_categories(uuid), public.save_media_category(uuid, uuid, text, text, boolean),
 public.media_accounts(uuid, boolean),
 public.media_statement(uuid, uuid, date, date, text, uuid, integer, integer),
 public.create_media_entry(uuid, uuid, text, numeric, date, uuid, text),
 public.reverse_media_entry(uuid, uuid, text), public.set_media_account(uuid, uuid, numeric),
 public.prepare_media_receipt(uuid, uuid, text, bigint), public.media_receipt_upload_target(uuid),
 public.confirm_media_receipt(uuid), public.discard_media_receipt(uuid) to authenticated;

commit;
