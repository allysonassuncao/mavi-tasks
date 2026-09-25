begin;

-- Campanhas: a conexão do Meta é do CLIENTE. Cada cliente tem sua conta de
-- anúncio e o perfil do Facebook por onde ela é acessada (a "Conta
-- Incogniton" do MASO), então:
--  * a conexão começa no contexto de um cliente (e de uma campanha, para
--    voltar a ela);
--  * depois do login, as contas que o perfil enxerga ficam pendentes até um
--    administrador marcar quais são daquele cliente (uma conta pertence a
--    um só cliente, como no MASO);
--  * o token fica em cada conta marcada, ligado ao cliente, e o ciclo só
--    lista as contas do cliente da campanha.
-- O Google Ads continua com uma conexão só, da agência (MCC).

alter table mavi_private.ad_oauth_states
 add column client_id uuid,
 add column campaign_id uuid;

alter table mavi_private.ad_meta_accounts add column client_id uuid;
alter table mavi_private.ad_meta_accounts
 add foreign key (company_id, client_id) references public.clients(company_id, id) on delete set null (client_id);
create index ad_meta_accounts_client on mavi_private.ad_meta_accounts(company_id, client_id);

-- After the login, before the accounts are chosen (an hour at most).
create table mavi_private.ad_meta_pending (
 id uuid primary key default gen_random_uuid(),
 company_id uuid not null references public.companies(id) on delete cascade,
 client_id uuid not null,
 campaign_id uuid,
 user_id uuid not null references auth.users(id) on delete cascade,
 fb_user_id text not null default '',
 fb_user_name text not null default '',
 token_cipher text not null check (token_cipher ~ '^v1:'),
 token_expires_at timestamptz,
 accounts jsonb not null default '[]',
 created_at timestamptz not null default now(),
 foreign key (company_id, client_id) references public.clients(company_id, id) on delete cascade
);
alter table mavi_private.ad_meta_pending enable row level security;
revoke all on mavi_private.ad_meta_pending from public, anon, authenticated;

-- Starting a connection: Meta always for a client (and a campaign to come
-- back to); Google for the agency.
drop function public.ad_begin_connect(uuid, text);
create function public.ad_begin_connect(p_company uuid, p_provider text, p_client uuid default null,
 p_campaign uuid default null) returns text
language plpgsql security definer set search_path = '' as $$
declare s text := encode(extensions.gen_random_bytes(32), 'hex'); begin
 perform mavi_private.ad_require_admin(p_company);
 if p_provider not in ('meta', 'google') then raise exception 'Plataforma inválida' using errcode = '22023'; end if;
 if p_provider = 'meta' and not exists (select 1 from public.clients where company_id = p_company and id = p_client) then
  raise exception 'Escolha o cliente da conexão do Facebook' using errcode = '22023';
 end if;
 if p_campaign is not null and not exists (select 1 from public.ad_campaigns where company_id = p_company and id = p_campaign) then
  p_campaign := null;
 end if;
 delete from mavi_private.ad_oauth_states where created_at < now() - interval '15 minutes'
  or (user_id = auth.uid() and company_id = p_company and provider = p_provider);
 insert into mavi_private.ad_oauth_states(state, company_id, user_id, provider, client_id, campaign_id)
 values (s, p_company, auth.uid(), p_provider, case when p_provider = 'meta' then p_client end, p_campaign);
 return s;
end $$;

-- Facebook's redirect: keeps the token and the accounts the profile sees as
-- pending, for an administrator to choose the client's. Returns where to go
-- ({pending, campaign}), or null when the profile sees no account.
drop function public.ad_complete_meta_connect(text, text, text, text, timestamptz, jsonb);
create function public.ad_complete_meta_connect(p_state text, p_fb_user_id text, p_fb_user_name text,
 p_token_cipher text, p_expires_at timestamptz, p_accounts jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare st mavi_private.ad_oauth_states; accounts jsonb; pending uuid; begin
 delete from mavi_private.ad_oauth_states s
 where s.state = p_state and s.provider = 'meta' and s.created_at > now() - interval '15 minutes'
 returning * into st;
 if st.state is null or st.client_id is null or not exists (select 1 from public.memberships m
   where m.company_id = st.company_id and m.user_id = st.user_id and m.active and m.role = 'admin') then
  raise exception 'Conexão expirada. Tente conectar de novo.' using errcode = '42501';
 end if;
 if coalesce(p_token_cipher, '') !~ '^v1:' then raise exception 'Resposta do Facebook incompleta.' using errcode = '22023'; end if;
 select coalesce(jsonb_agg(jsonb_build_object('account_id', a ->> 'account_id', 'name', left(coalesce(a ->> 'name', ''), 200),
   'currency', left(coalesce(a ->> 'currency', ''), 10),
   'account_status', case when coalesce(a ->> 'account_status', '') ~ '^[0-9]{1,4}$' then (a ->> 'account_status')::integer end)),
  '[]') into accounts
 from jsonb_array_elements(case when jsonb_typeof(p_accounts) = 'array' then p_accounts else '[]' end) a
 where coalesce(a ->> 'account_id', '') ~ '^[0-9]{1,30}$';
 if jsonb_array_length(accounts) = 0 then return null; end if;
 delete from mavi_private.ad_meta_pending where created_at < now() - interval '1 hour'
  or (company_id = st.company_id and user_id = st.user_id);
 insert into mavi_private.ad_meta_pending(company_id, client_id, campaign_id, user_id, fb_user_id, fb_user_name,
  token_cipher, token_expires_at, accounts)
 values (st.company_id, st.client_id, st.campaign_id, st.user_id, left(coalesce(p_fb_user_id, ''), 40),
  left(coalesce(p_fb_user_name, ''), 200), p_token_cipher, p_expires_at, accounts)
 returning id into pending;
 return jsonb_build_object('pending', pending, 'campaign', st.campaign_id);
end $$;

-- What the chooser shows (no token): the client, the profile and each
-- account with the client it already belongs to, if any.
create function public.ad_meta_pending(p_pending uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare p mavi_private.ad_meta_pending; begin
 select * into p from mavi_private.ad_meta_pending where id = p_pending and created_at > now() - interval '1 hour';
 if not found then raise exception 'A conexão expirou. Conecte de novo.' using errcode = '22023'; end if;
 perform mavi_private.ad_require_admin(p.company_id);
 return jsonb_build_object(
  'id', p.id, 'client_id', p.client_id, 'campaign_id', p.campaign_id,
  'client', (select name from public.clients where company_id = p.company_id and id = p.client_id),
  'profile', p.fb_user_name, 'expires_at', p.token_expires_at,
  'accounts', (select coalesce(jsonb_agg(a || jsonb_build_object(
    'client_id', m.client_id,
    'client', (select name from public.clients c where c.company_id = p.company_id and c.id = m.client_id))
    order by a ->> 'name'), '[]')
   from jsonb_array_elements(p.accounts) a
   left join mavi_private.ad_meta_accounts m on m.company_id = p.company_id and m.account_id = a ->> 'account_id'));
end $$;

-- The accounts chosen become the client's, with this profile's token. An
-- account of another client is refused (remove it from there first).
create function public.ad_confirm_meta_accounts(p_pending uuid, p_accounts text[]) returns integer
language plpgsql security definer set search_path = '' as $$
declare p mavi_private.ad_meta_pending; a jsonb; n integer := 0; other text; begin
 select * into p from mavi_private.ad_meta_pending where id = p_pending and created_at > now() - interval '1 hour'
  for update;
 if not found then raise exception 'A conexão expirou. Conecte de novo.' using errcode = '22023'; end if;
 perform mavi_private.ad_require_admin(p.company_id);
 if coalesce(array_length(p_accounts, 1), 0) = 0 then
  raise exception 'Marque ao menos uma conta do cliente' using errcode = '22023';
 end if;
 for a in select * from jsonb_array_elements(p.accounts) where value ->> 'account_id' = any(p_accounts) loop
  select c.name into other from mavi_private.ad_meta_accounts m
   join public.clients c on c.company_id = m.company_id and c.id = m.client_id
   where m.company_id = p.company_id and m.account_id = a ->> 'account_id' and m.client_id <> p.client_id;
  if other is not null then
   raise exception 'A conta % já é do cliente %', a ->> 'account_id', other using errcode = '23505';
  end if;
  insert into mavi_private.ad_meta_accounts(company_id, account_id, name, currency, account_status, fb_user_id,
   fb_user_name, token_cipher, token_expires_at, connected_by, client_id)
  values (p.company_id, a ->> 'account_id', coalesce(a ->> 'name', ''), coalesce(a ->> 'currency', ''),
   (a ->> 'account_status')::integer, p.fb_user_id, p.fb_user_name, p.token_cipher, p.token_expires_at, p.user_id,
   p.client_id)
  on conflict (company_id, account_id) do update set name = excluded.name, currency = excluded.currency,
   account_status = excluded.account_status, fb_user_id = excluded.fb_user_id, fb_user_name = excluded.fb_user_name,
   token_cipher = excluded.token_cipher, token_expires_at = excluded.token_expires_at,
   connected_by = excluded.connected_by, client_id = excluded.client_id, updated_at = now();
  n := n + 1;
 end loop;
 if n = 0 then raise exception 'Nenhuma das contas marcadas veio desta conexão' using errcode = '22023'; end if;
 delete from mavi_private.ad_meta_pending where id = p.id;
 return n;
end $$;

-- The account list now says the client of each account.
drop function public.ad_meta_account_list(uuid);
create function public.ad_meta_account_list(p_company uuid) returns table(account_id text, name text, currency text,
 account_status integer, token_expires_at timestamptz, fb_user_id text, fb_user_name text, client_id uuid,
 client_name text)
language plpgsql stable security definer set search_path = '' as $$ begin
 perform mavi_private.ad_require_admin(p_company);
 return query select m.account_id, m.name, m.currency, m.account_status, m.token_expires_at, m.fb_user_id,
  m.fb_user_name, m.client_id, c.name
  from mavi_private.ad_meta_accounts m
  left join public.clients c on c.company_id = m.company_id and c.id = m.client_id
  where m.company_id = p_company order by c.name nulls last, m.name, m.account_id;
end $$;

-- The Conexões list: every client with an active Meta campaign or a
-- connected account, with its accounts and the soonest expiry.
create function public.ad_meta_clients(p_company uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$ begin
 perform mavi_private.ad_require_admin(p_company);
 return (with clients as (
   select distinct k.client_id from public.ad_campaigns a
   join public.contracts k on k.company_id = a.company_id and k.id = a.contract_id
   where a.company_id = p_company and a.platform = 'meta' and a.status = 'active' and not a.archived
   union
   select m.client_id from mavi_private.ad_meta_accounts m where m.company_id = p_company and m.client_id is not null
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'client_id', c.id, 'client', c.name,
    'campaigns', (select count(*) from public.ad_campaigns a
      join public.contracts k on k.company_id = a.company_id and k.id = a.contract_id
      where a.company_id = p_company and k.client_id = c.id and a.platform = 'meta' and a.status = 'active'
       and not a.archived),
    'expires_at', (select min(m.token_expires_at) from mavi_private.ad_meta_accounts m
      where m.company_id = p_company and m.client_id = c.id),
    'accounts', (select coalesce(jsonb_agg(jsonb_build_object('account_id', m.account_id, 'name', m.name,
       'profile', m.fb_user_name, 'expires_at', m.token_expires_at, 'account_status', m.account_status)
       order by m.name), '[]')
      from mavi_private.ad_meta_accounts m where m.company_id = p_company and m.client_id = c.id))
   order by c.name), '[]')
  from clients x join public.clients c on c.company_id = p_company and c.id = x.client_id);
end $$;

-- Removes the connection of one client (its accounts' tokens).
create function public.ad_disconnect_meta_client(p_company uuid, p_client uuid) returns integer
language plpgsql security definer set search_path = '' as $$
declare n integer; begin
 perform mavi_private.ad_require_admin(p_company);
 delete from mavi_private.ad_meta_accounts where company_id = p_company and client_id = p_client;
 get diagnostics n = row_count;
 return n;
end $$;

revoke all on function public.ad_begin_connect(uuid, text, uuid, uuid),
 public.ad_complete_meta_connect(text, text, text, text, timestamptz, jsonb),
 public.ad_meta_pending(uuid), public.ad_confirm_meta_accounts(uuid, text[]),
 public.ad_meta_account_list(uuid), public.ad_meta_clients(uuid), public.ad_disconnect_meta_client(uuid, uuid)
 from public, anon, authenticated;
grant execute on function public.ad_begin_connect(uuid, text, uuid, uuid), public.ad_meta_pending(uuid),
 public.ad_confirm_meta_accounts(uuid, text[]), public.ad_meta_account_list(uuid), public.ad_meta_clients(uuid),
 public.ad_disconnect_meta_client(uuid, uuid) to authenticated;
grant execute on function public.ad_complete_meta_connect(text, text, text, text, timestamptz, jsonb)
 to anon, authenticated;

commit;
