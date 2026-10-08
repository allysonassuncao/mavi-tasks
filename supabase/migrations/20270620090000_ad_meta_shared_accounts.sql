begin;

-- Campanhas › Conexões: uma conta de anúncio do Meta pode ser de mais de um
-- cliente (o mesmo dono com dois contratos, por exemplo). Antes, uma conta
-- que já era de outro cliente vinha bloqueada no seletor ("já é do cliente
-- X") e o banco recusava; agora ela é compartilhada: vale para todos os
-- clientes marcados, com o mesmo acesso, e nenhum perde nada.
--  * ad_meta_account_clients guarda TODOS os clientes de cada conta;
--  * ad_meta_accounts.client_id continua sendo o primeiro (quem ainda lê a
--    coluna segue funcionando) e um gatilho mantém a tabela em dia quando
--    alguém grava só a coluna (a importação do MASO, por exemplo);
--  * desconectar um cliente tira só ele; a conta some quando não sobra
--    nenhum cliente.

create table mavi_private.ad_meta_account_clients (
 company_id uuid not null,
 account_id text not null,
 client_id uuid not null,
 created_at timestamptz not null default now(),
 primary key (company_id, account_id, client_id),
 foreign key (company_id, account_id) references mavi_private.ad_meta_accounts(company_id, account_id)
  on delete cascade,
 foreign key (company_id, client_id) references public.clients(company_id, id) on delete cascade
);
create index ad_meta_account_clients_client on mavi_private.ad_meta_account_clients(company_id, client_id);
alter table mavi_private.ad_meta_account_clients enable row level security;
revoke all on mavi_private.ad_meta_account_clients from public, anon, authenticated;

insert into mavi_private.ad_meta_account_clients(company_id, account_id, client_id, created_at)
select company_id, account_id, client_id, updated_at from mavi_private.ad_meta_accounts where client_id is not null
on conflict do nothing;

create function mavi_private.ad_meta_account_owner_link() returns trigger
language plpgsql security definer set search_path = '' as $$ begin
 insert into mavi_private.ad_meta_account_clients(company_id, account_id, client_id)
 values (new.company_id, new.account_id, new.client_id) on conflict do nothing;
 return null;
end $$;
revoke all on function mavi_private.ad_meta_account_owner_link() from public, anon, authenticated;
create trigger ad_meta_account_owner_link after insert or update of client_id on mavi_private.ad_meta_accounts
 for each row when (new.client_id is not null) execute function mavi_private.ad_meta_account_owner_link();

-- ---- as da migração 20270107090000, agora por ad_meta_account_clients

create or replace function public.ad_connections(p_company uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_clients uuid[]; begin
 perform mavi_private.ad_require_reader(p_company);
 v_clients := mavi_private.module_scope(p_company, 'campaigns');
 return jsonb_build_object(
  'meta', (select jsonb_build_object('accounts', count(*), 'people', coalesce(jsonb_agg(distinct m.fb_user_name), '[]'),
    'expires_at', min(m.token_expires_at), 'updated_at', max(m.updated_at))
   from mavi_private.ad_meta_accounts m where m.company_id = p_company
    and (v_clients is null or exists (select 1 from mavi_private.ad_meta_account_clients x
     where x.company_id = m.company_id and x.account_id = m.account_id and x.client_id = any(v_clients)))
   having count(*) > 0),
  'google', (select jsonb_build_object('email', account_email, 'connected_at', connected_at)
   from mavi_private.ad_google_connections where company_id = p_company),
  'can_manage_agency', v_clients is null);
end $$;

-- Uma linha por conta e cliente (a conta compartilhada aparece para cada um);
-- a conta ainda sem cliente vem com client_id nulo, só para os líderes.
create or replace function public.ad_meta_account_list(p_company uuid) returns table(account_id text, name text,
 currency text, account_status integer, token_expires_at timestamptz, fb_user_id text, fb_user_name text,
 client_id uuid, client_name text)
language plpgsql stable security definer set search_path = '' as $$
declare v_clients uuid[]; begin
 perform mavi_private.ad_require_reader(p_company);
 v_clients := mavi_private.module_scope(p_company, 'campaigns');
 return query select m.account_id, m.name, m.currency, m.account_status, m.token_expires_at, m.fb_user_id,
  m.fb_user_name, x.client_id, c.name
  from mavi_private.ad_meta_accounts m
  left join mavi_private.ad_meta_account_clients x on x.company_id = m.company_id and x.account_id = m.account_id
  left join public.clients c on c.company_id = x.company_id and c.id = x.client_id
  where m.company_id = p_company and (v_clients is null or x.client_id = any(v_clients))
  order by c.name nulls last, m.name, m.account_id;
end $$;

create or replace function public.ad_meta_token(p_company uuid, p_account text) returns table(token_cipher text,
 token_expires_at timestamptz)
language plpgsql stable security definer set search_path = '' as $$
declare v_clients uuid[]; begin
 perform mavi_private.ad_require_reader(p_company);
 v_clients := mavi_private.module_scope(p_company, 'campaigns');
 return query select m.token_cipher, m.token_expires_at from mavi_private.ad_meta_accounts m
  where m.company_id = p_company and m.account_id = p_account
   and (v_clients is null or exists (select 1 from mavi_private.ad_meta_account_clients x
    where x.company_id = m.company_id and x.account_id = m.account_id and x.client_id = any(v_clients)));
end $$;

-- O seletor: cada conta diz se já é deste cliente (mine) e de quais outros
-- clientes é (others; para quem não é líder, o cliente que não atende vem
-- como "outro cliente"). client_id/client seguem para quem ainda os lê.
create or replace function public.ad_meta_pending(p_pending uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare p mavi_private.ad_meta_pending; v_leader boolean; v_served uuid[]; begin
 select * into p from mavi_private.ad_meta_pending where id = p_pending and created_at > now() - interval '1 hour';
 if not found then raise exception 'A conexão expirou. Conecte de novo.' using errcode = '22023'; end if;
 perform mavi_private.ad_require_client(p.company_id, p.client_id);
 v_leader := mavi_private.leader(p.company_id);
 v_served := coalesce(mavi_private.served_clients(p.company_id), '{}');
 return jsonb_build_object(
  'id', p.id, 'client_id', p.client_id, 'campaign_id', p.campaign_id,
  'client', (select name from public.clients where company_id = p.company_id and id = p.client_id),
  'profile', p.fb_user_name, 'expires_at', p.token_expires_at,
  'accounts', (select coalesce(jsonb_agg(a || jsonb_build_object(
    'mine', o.mine,
    'others', o.others,
    'client_id', case when o.mine then p.client_id else o.first_other end,
    'client', nullif(array_to_string(array(select jsonb_array_elements_text(o.others)), ', '), ''))
    order by a ->> 'name'), '[]')
   from jsonb_array_elements(p.accounts) a
   cross join lateral (select
     coalesce(bool_or(x.client_id = p.client_id), false) as mine,
     (array_agg(x.client_id order by x.created_at) filter (where x.client_id <> p.client_id))[1] as first_other,
     coalesce(jsonb_agg(distinct case when v_leader or x.client_id = any(v_served) then c.name else 'outro cliente' end)
      filter (where x.client_id <> p.client_id), '[]') as others
    from mavi_private.ad_meta_account_clients x
    join public.clients c on c.company_id = x.company_id and c.id = x.client_id
    where x.company_id = p.company_id and x.account_id = a ->> 'account_id') o));
end $$;

-- As contas marcadas passam a ser (também) deste cliente, com o token deste
-- perfil. A de outro cliente fica compartilhada: o outro não perde nada.
create or replace function public.ad_confirm_meta_accounts(p_pending uuid, p_accounts text[]) returns integer
language plpgsql security definer set search_path = '' as $$
declare p mavi_private.ad_meta_pending; a jsonb; n integer := 0; begin
 select * into p from mavi_private.ad_meta_pending where id = p_pending and created_at > now() - interval '1 hour'
  for update;
 if not found then raise exception 'A conexão expirou. Conecte de novo.' using errcode = '22023'; end if;
 perform mavi_private.ad_require_client(p.company_id, p.client_id);
 if coalesce(array_length(p_accounts, 1), 0) = 0 then
  raise exception 'Marque ao menos uma conta do cliente' using errcode = '22023';
 end if;
 for a in select * from jsonb_array_elements(p.accounts) where value ->> 'account_id' = any(p_accounts) loop
  insert into mavi_private.ad_meta_accounts(company_id, account_id, name, currency, account_status, fb_user_id,
   fb_user_name, token_cipher, token_expires_at, connected_by, client_id)
  values (p.company_id, a ->> 'account_id', coalesce(a ->> 'name', ''), coalesce(a ->> 'currency', ''),
   (a ->> 'account_status')::integer, p.fb_user_id, p.fb_user_name, p.token_cipher, p.token_expires_at, p.user_id,
   p.client_id)
  on conflict (company_id, account_id) do update set name = excluded.name, currency = excluded.currency,
   account_status = excluded.account_status, fb_user_id = excluded.fb_user_id, fb_user_name = excluded.fb_user_name,
   token_cipher = excluded.token_cipher, token_expires_at = excluded.token_expires_at,
   connected_by = excluded.connected_by, client_id = coalesce(ad_meta_accounts.client_id, excluded.client_id),
   updated_at = now();
  insert into mavi_private.ad_meta_account_clients(company_id, account_id, client_id)
  values (p.company_id, a ->> 'account_id', p.client_id) on conflict do nothing;
  n := n + 1;
 end loop;
 if n = 0 then raise exception 'Nenhuma das contas marcadas veio desta conexão' using errcode = '22023'; end if;
 delete from mavi_private.ad_meta_pending where id = p.id;
 return n;
end $$;

create or replace function public.ad_meta_clients(p_company uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_clients uuid[]; begin
 perform mavi_private.ad_require_reader(p_company);
 v_clients := mavi_private.module_scope(p_company, 'campaigns');
 return (with clients as (
   select distinct k.client_id from public.ad_campaigns a
   join public.contracts k on k.company_id = a.company_id and k.id = a.contract_id
   where a.company_id = p_company and a.platform = 'meta' and a.status = 'active' and not a.archived
   union
   select x.client_id from mavi_private.ad_meta_account_clients x where x.company_id = p_company
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'client_id', c.id, 'client', c.name,
    'campaigns', (select count(*) from public.ad_campaigns a
      join public.contracts k on k.company_id = a.company_id and k.id = a.contract_id
      where a.company_id = p_company and k.client_id = c.id and a.platform = 'meta' and a.status = 'active'
       and not a.archived),
    'expires_at', (select min(m.token_expires_at) from mavi_private.ad_meta_accounts m
      join mavi_private.ad_meta_account_clients x on x.company_id = m.company_id and x.account_id = m.account_id
      where m.company_id = p_company and x.client_id = c.id),
    'accounts', (select coalesce(jsonb_agg(jsonb_build_object('account_id', m.account_id, 'name', m.name,
       'profile', m.fb_user_name, 'expires_at', m.token_expires_at, 'account_status', m.account_status)
       order by m.name), '[]')
      from mavi_private.ad_meta_accounts m
      join mavi_private.ad_meta_account_clients x on x.company_id = m.company_id and x.account_id = m.account_id
      where m.company_id = p_company and x.client_id = c.id))
   order by c.name), '[]')
  from clients x join public.clients c on c.company_id = p_company and c.id = x.client_id
  where v_clients is null or c.id = any(v_clients));
end $$;

-- Tira as contas deste cliente. A compartilhada continua com os outros (e o
-- token); só a que fica sem nenhum cliente é apagada.
create or replace function public.ad_disconnect_meta_client(p_company uuid, p_client uuid) returns integer
language plpgsql security definer set search_path = '' as $$
declare v_ids text[]; begin
 perform mavi_private.ad_require_client(p_company, p_client);
 select coalesce(array_agg(distinct account_id), '{}') into v_ids from (
  select x.account_id from mavi_private.ad_meta_account_clients x where x.company_id = p_company and x.client_id = p_client
  union all
  select m.account_id from mavi_private.ad_meta_accounts m where m.company_id = p_company and m.client_id = p_client) t;
 delete from mavi_private.ad_meta_account_clients where company_id = p_company and client_id = p_client;
 delete from mavi_private.ad_meta_accounts m where m.company_id = p_company and m.account_id = any(v_ids)
  and not exists (select 1 from mavi_private.ad_meta_account_clients x
   where x.company_id = m.company_id and x.account_id = m.account_id);
 update mavi_private.ad_meta_accounts m set client_id = (select x.client_id from mavi_private.ad_meta_account_clients x
   where x.company_id = m.company_id and x.account_id = m.account_id order by x.created_at limit 1)
 where m.company_id = p_company and m.account_id = any(v_ids) and m.client_id = p_client;
 return coalesce(array_length(v_ids, 1), 0);
end $$;

-- ---- a da migração 20261010090000: os tokens das contas do cliente do formulário

create or replace function public.ad_leadgen_claim(p_secret text, p_leadgen text, p_page text, p_form text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare d public.ad_lead_deliveries; f public.ad_lead_forms; page_token text; begin
 if not mavi_private.ad_sync_allowed(p_secret, null) then raise exception 'Sem permissão' using errcode = '42501'; end if;
 if coalesce(p_leadgen, '') !~ '^[0-9]{1,40}$' then raise exception 'Cadastro inválido' using errcode = '22023'; end if;
 select * into f from public.ad_lead_forms where form_id = coalesce(p_form, '') order by updated_at desc limit 1;
 if found then
  select token_cipher into page_token from mavi_private.ad_meta_pages where company_id = f.company_id and page_id = f.page_id;
 end if;
 insert into public.ad_lead_deliveries(leadgen_id, company_id, lead_form_id, page_id, form_id, status)
 values (p_leadgen, f.company_id, f.id, left(coalesce(p_page, ''), 40), left(coalesce(p_form, ''), 40),
  case when f.id is null or page_token is null then 'no_link' else 'processing' end)
 on conflict (leadgen_id) do update set attempts = ad_lead_deliveries.attempts + 1, status = excluded.status,
  company_id = excluded.company_id, lead_form_id = excluded.lead_form_id, updated_at = now()
 where ad_lead_deliveries.status = 'error'
  or (ad_lead_deliveries.status = 'processing' and ad_lead_deliveries.updated_at < now() - interval '10 minutes')
  or (ad_lead_deliveries.status = 'no_link' and excluded.status = 'processing')
 returning * into d;
 if d.id is null then return jsonb_build_object('skip', true, 'reason', 'already'); end if;
 if d.status = 'no_link' then return jsonb_build_object('skip', true, 'reason', 'no_link'); end if;
 return jsonb_build_object('skip', false, 'company_id', f.company_id, 'lead_form_id', f.id,
  'landing_page_id', f.landing_page_id, 'make_user_id', f.make_user_id, 'page_token_cipher', page_token,
  'account_token_ciphers', coalesce((select jsonb_agg(m.token_cipher order by m.updated_at desc)
   from mavi_private.ad_meta_accounts m where m.company_id = f.company_id and f.client_id is not null
    and exists (select 1 from mavi_private.ad_meta_account_clients x
     where x.company_id = m.company_id and x.account_id = m.account_id and x.client_id = f.client_id)
    and (m.token_expires_at is null or m.token_expires_at > now())), '[]'));
end $$;

-- ---- a da migração 20270225090000: as contas que a MAVI consulta, por cliente

create or replace function public.ad_ai_accounts(p_company uuid, p_client uuid default null) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_clients uuid[]; begin
 perform mavi_private.ad_require_reader(p_company);
 v_clients := mavi_private.module_scope(p_company, 'campaigns');
 if p_client is not null and v_clients is not null and not p_client = any(v_clients) then
  raise exception 'Sem permissão: este cliente não é de uma equipe sua' using errcode = '42501';
 end if;
 return (
  with links as (
   select a.platform, l.account_id, l.account_name, l.manager_id, k.client_id, a.id as campaign_id,
    a.name as campaign_name, a.status, l.external_campaign_id, l.campaign_name as external_name
   from public.ad_cycle_links l
   join public.ad_cycles y on y.company_id = l.company_id and y.id = l.cycle_id
   join public.ad_campaigns a on a.company_id = y.company_id and a.id = y.campaign_id
   join public.contracts k on k.company_id = a.company_id and k.id = a.contract_id
   where l.company_id = p_company and a.platform in ('meta', 'google') and not a.archived
    and (v_clients is null or k.client_id = any(v_clients)) and (p_client is null or k.client_id = p_client)),
  accounts as (
   select platform, account_id, client_id from links
   union
   select 'meta', x.account_id, x.client_id from mavi_private.ad_meta_account_clients x
   where x.company_id = p_company
    and (v_clients is null or x.client_id = any(v_clients)) and (p_client is null or x.client_id = p_client))
  select coalesce(jsonb_agg(jsonb_build_object(
    'platform', x.platform, 'account_id', x.account_id,
    'name', coalesce(
     (select nullif(m.name, '') from mavi_private.ad_meta_accounts m
      where x.platform = 'meta' and m.company_id = p_company and m.account_id = x.account_id),
     (select max(nullif(l.account_name, '')) from links l where l.platform = x.platform and l.account_id = x.account_id),
     ''),
    'manager_id', coalesce((select max(nullif(l.manager_id, '')) from links l
     where l.platform = x.platform and l.account_id = x.account_id), ''),
    'client_id', x.client_id, 'client', c.name,
    -- Meta: a conta tem a conexão do Facebook (o token) para ler ao vivo.
    'connected', x.platform = 'google' or exists (select 1 from mavi_private.ad_meta_accounts m
     where m.company_id = p_company and m.account_id = x.account_id),
    'campaigns', (select coalesce(jsonb_agg(jsonb_build_object('id', g.campaign_id, 'name', g.campaign_name,
       'status', g.status, 'platform_campaigns', g.ext) order by g.status, g.campaign_name), '[]')
     from (select l.campaign_id, l.campaign_name, l.status,
       coalesce(jsonb_agg(distinct jsonb_build_object('id', l.external_campaign_id, 'name', l.external_name))
        filter (where l.external_campaign_id <> ''), '[]') as ext
      from links l where l.platform = x.platform and l.account_id = x.account_id and l.client_id = x.client_id
      group by l.campaign_id, l.campaign_name, l.status) g))
   order by c.name, x.platform, x.account_id), '[]')
  from accounts x join public.clients c on c.company_id = p_company and c.id = x.client_id);
end $$;

commit;
