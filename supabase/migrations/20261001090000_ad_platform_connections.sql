begin;

-- Campanhas: conexão com as plataformas de anúncio, para o cadastro do ciclo
-- listar as contas e as campanhas reais (como o MASO fazia ao vivo).
-- Segue o MASO:
--  * Meta: um administrador entra com o Facebook; o token de longa duração
--    (~60 dias) fica guardado POR CONTA DE ANÚNCIO que essa pessoa enxerga. A
--    última pessoa que conectou "assume" a conta.
--  * Google Ads: um único token da agência (acesso à MCC), renovado sozinho.
-- Os tokens chegam aqui já cifrados pelo servidor (AES-256-GCM, chave
-- GOOGLE_TOKEN_KEY, que o banco nunca vê) e só os administradores da empresa
-- alcançam as conexões, pelas funções abaixo.

-- One-time values tying the platform's redirect back to whoever started it.
create table mavi_private.ad_oauth_states (
 state text primary key check (state ~ '^[0-9a-f]{64}$'),
 company_id uuid not null references public.companies(id) on delete cascade,
 user_id uuid not null references auth.users(id) on delete cascade,
 provider text not null check (provider in ('meta','google')),
 created_at timestamptz not null default now()
);
alter table mavi_private.ad_oauth_states enable row level security;
revoke all on mavi_private.ad_oauth_states from public, anon, authenticated;

-- Meta ad accounts reachable by the company, each with the token of the last
-- person who connected them (MASO: usuarios_make_facebook_accounts).
create table mavi_private.ad_meta_accounts (
 company_id uuid not null references public.companies(id) on delete cascade,
 account_id text not null check (account_id ~ '^[0-9]{1,30}$'),
 name text not null default '',
 currency text not null default '',
 account_status integer,
 fb_user_id text not null default '',
 fb_user_name text not null default '',
 token_cipher text not null check (token_cipher ~ '^v1:'),
 token_expires_at timestamptz,
 connected_by uuid not null references auth.users(id),
 updated_at timestamptz not null default now(),
 primary key (company_id, account_id)
);
alter table mavi_private.ad_meta_accounts enable row level security;
revoke all on mavi_private.ad_meta_accounts from public, anon, authenticated;

-- The agency's Google Ads connection (MASO: google_api, tipo ADS).
create table mavi_private.ad_google_connections (
 company_id uuid primary key references public.companies(id) on delete cascade,
 account_email text not null default '',
 scope text not null default '',
 refresh_token_cipher text not null check (refresh_token_cipher ~ '^v1:'),
 access_token_cipher text,
 access_expires_at timestamptz,
 connected_by uuid not null references auth.users(id),
 connected_at timestamptz not null default now(),
 updated_at timestamptz not null default now()
);
alter table mavi_private.ad_google_connections enable row level security;
revoke all on mavi_private.ad_google_connections from public, anon, authenticated;

create function mavi_private.ad_require_admin(c uuid) returns void
language plpgsql stable security definer set search_path = '' as $$ begin
 if not mavi_private.admin(c) then
  raise exception 'Sem permissão: Campanhas é exclusivo de administradores' using errcode = '42501';
 end if;
end $$;
revoke all on function mavi_private.ad_require_admin(uuid) from public, anon, authenticated;

-- Starts a connection: a fresh state (15 minutes) for the administrator.
create function public.ad_begin_connect(p_company uuid, p_provider text) returns text
language plpgsql security definer set search_path = '' as $$
declare s text := encode(extensions.gen_random_bytes(32), 'hex'); begin
 perform mavi_private.ad_require_admin(p_company);
 if p_provider not in ('meta', 'google') then raise exception 'Plataforma inválida' using errcode = '22023'; end if;
 delete from mavi_private.ad_oauth_states where created_at < now() - interval '15 minutes'
  or (user_id = auth.uid() and company_id = p_company and provider = p_provider);
 insert into mavi_private.ad_oauth_states(state, company_id, user_id, provider) values (s, p_company, auth.uid(), p_provider);
 return s;
end $$;

-- Consumes a fresh state of the given platform (the redirect has no session:
-- the server calls these anonymously). The person must still be an admin.
create function mavi_private.ad_take_state(p_state text, p_provider text, out company_id uuid, out user_id uuid)
language plpgsql security definer set search_path = '' as $$ begin
 delete from mavi_private.ad_oauth_states s
 where s.state = p_state and s.provider = p_provider and s.created_at > now() - interval '15 minutes'
 returning s.company_id, s.user_id into company_id, user_id;
 if company_id is null or not exists (select 1 from public.memberships m where m.company_id = ad_take_state.company_id
   and m.user_id = ad_take_state.user_id and m.active and m.role = 'admin') then
  raise exception 'Conexão expirada. Tente conectar de novo.' using errcode = '42501';
 end if;
end $$;
revoke all on function mavi_private.ad_take_state(text, text) from public, anon, authenticated;

-- Meta: the long-lived token and every ad account it reaches
-- ([{account_id, name, currency, account_status}]). Returns how many.
create function public.ad_complete_meta_connect(p_state text, p_fb_user_id text, p_fb_user_name text,
 p_token_cipher text, p_expires_at timestamptz, p_accounts jsonb) returns integer
language plpgsql security definer set search_path = '' as $$
declare t record; a jsonb; n integer := 0; begin
 select * into t from mavi_private.ad_take_state(p_state, 'meta');
 if coalesce(p_token_cipher, '') !~ '^v1:' then raise exception 'Resposta do Facebook incompleta.' using errcode = '22023'; end if;
 if jsonb_typeof(coalesce(p_accounts, '[]')) <> 'array' then raise exception 'Contas inválidas' using errcode = '22023'; end if;
 for a in select * from jsonb_array_elements(coalesce(p_accounts, '[]')) loop
  continue when coalesce(a ->> 'account_id', '') !~ '^[0-9]{1,30}$';
  insert into mavi_private.ad_meta_accounts(company_id, account_id, name, currency, account_status, fb_user_id,
   fb_user_name, token_cipher, token_expires_at, connected_by)
  values (t.company_id, a ->> 'account_id', left(coalesce(a ->> 'name', ''), 200), left(coalesce(a ->> 'currency', ''), 10),
   case when coalesce(a ->> 'account_status', '') ~ '^[0-9]{1,4}$' then (a ->> 'account_status')::integer end,
   left(coalesce(p_fb_user_id, ''), 40), left(coalesce(p_fb_user_name, ''), 200), p_token_cipher, p_expires_at, t.user_id)
  on conflict (company_id, account_id) do update set name = excluded.name, currency = excluded.currency,
   account_status = excluded.account_status, fb_user_id = excluded.fb_user_id, fb_user_name = excluded.fb_user_name,
   token_cipher = excluded.token_cipher, token_expires_at = excluded.token_expires_at,
   connected_by = excluded.connected_by, updated_at = now();
  n := n + 1;
 end loop;
 return n;
end $$;

-- Google: the agency's refresh token (one per company).
create function public.ad_complete_google_connect(p_state text, p_email text, p_scope text,
 p_refresh_cipher text, p_access_cipher text, p_expires_at timestamptz) returns void
language plpgsql security definer set search_path = '' as $$
declare t record; begin
 select * into t from mavi_private.ad_take_state(p_state, 'google');
 if coalesce(p_refresh_cipher, '') !~ '^v1:' then raise exception 'Resposta do Google incompleta.' using errcode = '22023'; end if;
 insert into mavi_private.ad_google_connections(company_id, account_email, scope, refresh_token_cipher,
  access_token_cipher, access_expires_at, connected_by)
 values (t.company_id, left(coalesce(p_email, ''), 320), left(coalesce(p_scope, ''), 2000), p_refresh_cipher,
  p_access_cipher, p_expires_at, t.user_id)
 on conflict (company_id) do update set account_email = excluded.account_email, scope = excluded.scope,
  refresh_token_cipher = excluded.refresh_token_cipher, access_token_cipher = excluded.access_token_cipher,
  access_expires_at = excluded.access_expires_at, connected_by = excluded.connected_by,
  connected_at = now(), updated_at = now();
end $$;

-- What the page shows (no tokens): Meta accounts and who connected them,
-- and the Google account.
create function public.ad_connections(p_company uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$ begin
 perform mavi_private.ad_require_admin(p_company);
 return jsonb_build_object(
  'meta', (select jsonb_build_object('accounts', count(*), 'people', coalesce(jsonb_agg(distinct fb_user_name), '[]'),
    'expires_at', min(token_expires_at), 'updated_at', max(updated_at))
   from mavi_private.ad_meta_accounts where company_id = p_company having count(*) > 0),
  'google', (select jsonb_build_object('email', account_email, 'connected_at', connected_at)
   from mavi_private.ad_google_connections where company_id = p_company));
end $$;

create function public.ad_meta_account_list(p_company uuid) returns table(account_id text, name text, currency text,
 account_status integer, token_expires_at timestamptz, fb_user_name text)
language plpgsql stable security definer set search_path = '' as $$ begin
 perform mavi_private.ad_require_admin(p_company);
 return query select m.account_id, m.name, m.currency, m.account_status, m.token_expires_at, m.fb_user_name
  from mavi_private.ad_meta_accounts m where m.company_id = p_company order by m.name, m.account_id;
end $$;

-- For /api/ads only: encrypted tokens (useless without the server's key).
create function public.ad_meta_token(p_company uuid, p_account text) returns table(token_cipher text,
 token_expires_at timestamptz)
language plpgsql stable security definer set search_path = '' as $$ begin
 perform mavi_private.ad_require_admin(p_company);
 return query select m.token_cipher, m.token_expires_at from mavi_private.ad_meta_accounts m
  where m.company_id = p_company and m.account_id = p_account;
end $$;

create function public.ad_google_tokens(p_company uuid) returns table(refresh_token_cipher text,
 access_token_cipher text, access_expires_at timestamptz)
language plpgsql stable security definer set search_path = '' as $$ begin
 perform mavi_private.ad_require_admin(p_company);
 return query select g.refresh_token_cipher, g.access_token_cipher, g.access_expires_at
  from mavi_private.ad_google_connections g where g.company_id = p_company;
end $$;

create function public.ad_google_save_access(p_company uuid, p_access_cipher text, p_expires_at timestamptz) returns void
language plpgsql security definer set search_path = '' as $$ begin
 perform mavi_private.ad_require_admin(p_company);
 update mavi_private.ad_google_connections set access_token_cipher = p_access_cipher,
  access_expires_at = p_expires_at, updated_at = now() where company_id = p_company;
end $$;

create function public.ad_disconnect(p_company uuid, p_provider text) returns void
language plpgsql security definer set search_path = '' as $$ begin
 perform mavi_private.ad_require_admin(p_company);
 if p_provider = 'meta' then delete from mavi_private.ad_meta_accounts where company_id = p_company;
 elsif p_provider = 'google' then delete from mavi_private.ad_google_connections where company_id = p_company;
 else raise exception 'Plataforma inválida' using errcode = '22023';
 end if;
end $$;

revoke all on function public.ad_begin_connect(uuid, text),
 public.ad_complete_meta_connect(text, text, text, text, timestamptz, jsonb),
 public.ad_complete_google_connect(text, text, text, text, text, timestamptz),
 public.ad_connections(uuid), public.ad_meta_account_list(uuid), public.ad_meta_token(uuid, text),
 public.ad_google_tokens(uuid), public.ad_google_save_access(uuid, text, timestamptz),
 public.ad_disconnect(uuid, text) from public, anon, authenticated;
grant execute on function public.ad_begin_connect(uuid, text), public.ad_connections(uuid),
 public.ad_meta_account_list(uuid), public.ad_meta_token(uuid, text), public.ad_google_tokens(uuid),
 public.ad_google_save_access(uuid, text, timestamptz), public.ad_disconnect(uuid, text) to authenticated;
grant execute on function public.ad_complete_meta_connect(text, text, text, text, timestamptz, jsonb),
 public.ad_complete_google_connect(text, text, text, text, text, timestamptz) to anon, authenticated;

-- Links now keep the names shown when they were chosen, and, on Google, the
-- manager account (MCC) the account is reached through (login-customer-id).
alter table public.ad_cycle_links
 add column manager_id text not null default '' check (manager_id ~ '^[0-9]{0,20}$'),
 add column account_name text not null default '' check (length(account_name) <= 200),
 add column campaign_name text not null default '' check (length(campaign_name) <= 300);

-- Same as before, plus: ids in one form (Meta without "act_", Google without
-- dashes), the names and the MCC, and (as in the MASO) a platform campaign
-- belongs to a single campaign of the company.
create or replace function mavi_private.ad_set_links(c uuid, p_cycle uuid, p_links jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare l jsonb; v_platform text; v_campaign uuid; v_account text; v_external text; other text; begin
 if p_links is not null and jsonb_typeof(p_links) <> 'array' then
  raise exception 'Vínculos inválidos' using errcode = '22023';
 end if;
 select a.platform, a.id into v_platform, v_campaign from public.ad_cycles y
  join public.ad_campaigns a on a.company_id = y.company_id and a.id = y.campaign_id where y.id = p_cycle;
 delete from public.ad_cycle_links where cycle_id = p_cycle;
 for l in select * from jsonb_array_elements(coalesce(p_links, '[]')) loop
  v_account := trim(coalesce(l ->> 'account_id', ''));
  if v_platform = 'meta' then v_account := regexp_replace(v_account, '^act_', '', 'i');
  elsif v_platform = 'google' then v_account := replace(v_account, '-', '');
  end if;
  if length(v_account) = 0 then
   raise exception 'Informe a conta de anúncio de cada vínculo' using errcode = '22023';
  end if;
  v_external := trim(coalesce(l ->> 'campaign_id', ''));
  if v_external <> '' then
   select a.name into other from public.ad_cycle_links k
    join public.ad_cycles y on y.company_id = k.company_id and y.id = k.cycle_id
    join public.ad_campaigns a on a.company_id = y.company_id and a.id = y.campaign_id
    where k.company_id = c and k.account_id = v_account and k.external_campaign_id = v_external and a.id <> v_campaign
    limit 1;
   if other is not null then
    raise exception 'A campanha % da plataforma já está vinculada à campanha "%"',
     coalesce(nullif(trim(l ->> 'campaign_name'), ''), v_external), other using errcode = '23505';
   end if;
  end if;
  insert into public.ad_cycle_links(company_id, cycle_id, account_id, external_campaign_id, manager_id,
   account_name, campaign_name)
  values (c, p_cycle, v_account, v_external,
   case when v_platform = 'google' then replace(coalesce(l ->> 'manager_id', ''), '-', '') else '' end,
   left(trim(coalesce(l ->> 'account_name', '')), 200), left(trim(coalesce(l ->> 'campaign_name', '')), 300))
  on conflict do nothing;
 end loop;
 return (select coalesce(jsonb_agg(jsonb_build_object('account_id', account_id, 'campaign_id', external_campaign_id)
  order by account_id, external_campaign_id), '[]') from public.ad_cycle_links where cycle_id = p_cycle);
end $$;

commit;
