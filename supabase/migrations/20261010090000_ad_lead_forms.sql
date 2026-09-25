begin;

-- Campanhas: formulários nativos do Facebook (Meta Lead Ads) ligados às
-- páginas de captura da Make, como o MASO fazia no ciclo ("Integrar
-- Formulário do Facebook?", ciclo/editar/v3 + webhook/facebook/leadgen.php).
--  * ad_meta_pages: a Página do Facebook e o token dela (cifrado com a
--    GOOGLE_TOKEN_KEY_ADS pelo servidor, como os das contas), inscrita no
--    webhook "leadgen" do app;
--  * ad_lead_forms: cada formulário e a página de captura da Make (e o
--    cliente da Make dono dela) para onde vão os cadastros;
--  * ad_lead_deliveries: cada cadastro recebido do Facebook (uma vez só,
--    mesmo que o Facebook reenvie) e como foi a entrega à Make.
-- Leitura e escrita: administradores e gestores (como o resto do módulo).
-- O webhook (/api/meta-leadgen) fala com o banco pelo segredo do servidor
-- (ADS_SYNC_SECRET), como a sincronização diária.

create table mavi_private.ad_meta_pages (
 company_id uuid not null references public.companies(id) on delete cascade,
 page_id text not null check (page_id ~ '^[0-9]{1,30}$'),
 name text not null default '' check (length(name) <= 200),
 token_cipher text not null check (token_cipher ~ '^v1:'),
 connected_by uuid not null references auth.users(id),
 updated_at timestamptz not null default now(),
 primary key (company_id, page_id)
);
alter table mavi_private.ad_meta_pages enable row level security;
revoke all on mavi_private.ad_meta_pages from public, anon, authenticated;

create table public.ad_lead_forms (
 id uuid primary key default gen_random_uuid(),
 company_id uuid not null references public.companies(id) on delete cascade,
 client_id uuid,
 page_id text not null check (page_id ~ '^[0-9]{1,30}$'),
 page_name text not null default '' check (length(page_name) <= 200),
 form_id text not null check (form_id ~ '^[0-9]{1,30}$'),
 form_name text not null default '' check (length(form_name) <= 300),
 -- The Make capture page (MASO id_squeeze / id_capture) and its owner in
 -- the Make (MASO id_usuario), which the optin API asks for.
 landing_page_id text not null check (landing_page_id ~ '^[0-9A-Za-z_-]{1,60}$'),
 make_user_id text not null check (make_user_id ~ '^[0-9]{1,20}$'),
 source text not null default 'mavi' check (source in ('mavi','maso')),
 created_by uuid not null references auth.users(id),
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 unique (company_id, form_id),
 foreign key (company_id, client_id) references public.clients(company_id, id) on delete set null (client_id)
);
create index ad_lead_forms_client on public.ad_lead_forms(company_id, client_id);
create index ad_lead_forms_form on public.ad_lead_forms(form_id);

create table public.ad_lead_deliveries (
 id bigint generated always as identity primary key,
 leadgen_id text not null unique check (leadgen_id ~ '^[0-9]{1,40}$'),
 company_id uuid references public.companies(id) on delete cascade,
 lead_form_id uuid references public.ad_lead_forms(id) on delete set null,
 page_id text not null default '',
 form_id text not null default '',
 -- processing → sent / duplicate (the Make already had it) / error; no_link:
 -- a form nobody linked (nothing is sent).
 status text not null check (status in ('processing','sent','duplicate','no_link','error')),
 message text not null default '' check (length(message) <= 1000),
 attempts integer not null default 1,
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now()
);
create index ad_lead_deliveries_form on public.ad_lead_deliveries(lead_form_id, created_at desc);

alter table public.ad_lead_forms enable row level security;
alter table public.ad_lead_deliveries enable row level security;
create policy ad_lead_forms_read on public.ad_lead_forms for select to authenticated using (
 company_id in (select mavi_private.leader_companies()));
create policy ad_lead_deliveries_read on public.ad_lead_deliveries for select to authenticated using (
 company_id in (select mavi_private.leader_companies()));
revoke all on public.ad_lead_forms, public.ad_lead_deliveries from anon, authenticated;
grant select on public.ad_lead_forms, public.ad_lead_deliveries to authenticated;

-- Links a form (the server calls it after subscribing the Page to the
-- webhook, with the Page's sealed token). A form goes to one capture page:
-- linking it again moves it.
create function public.ad_save_lead_form(p_company uuid, p_client uuid, p_page_id text, p_page_name text,
 p_page_token_cipher text, p_form_id text, p_form_name text, p_landing_page text, p_make_user text)
returns public.ad_lead_forms
language plpgsql security definer set search_path = '' as $$
declare result public.ad_lead_forms; begin
 perform mavi_private.ad_require_admin(p_company);
 if p_client is not null and not exists (select 1 from public.clients where company_id = p_company and id = p_client) then
  raise exception 'Cliente inválido' using errcode = '22023';
 end if;
 if coalesce(p_page_id, '') !~ '^[0-9]{1,30}$' then raise exception 'Página do Facebook inválida' using errcode = '22023'; end if;
 if coalesce(p_form_id, '') !~ '^[0-9]{1,30}$' then raise exception 'Formulário do Facebook inválido' using errcode = '22023'; end if;
 if coalesce(trim(p_landing_page), '') !~ '^[0-9A-Za-z_-]{1,60}$' then
  raise exception 'Escolha a página de captura da Make' using errcode = '22023';
 end if;
 if coalesce(trim(p_make_user), '') !~ '^[0-9]{1,20}$' then
  raise exception 'Informe o ID do cliente na Make (números)' using errcode = '22023';
 end if;
 if coalesce(p_page_token_cipher, '') !~ '^v1:' then raise exception 'Acesso à página ausente' using errcode = '22023'; end if;
 insert into mavi_private.ad_meta_pages(company_id, page_id, name, token_cipher, connected_by)
 values (p_company, p_page_id, left(coalesce(p_page_name, ''), 200), p_page_token_cipher, auth.uid())
 on conflict (company_id, page_id) do update set name = case when excluded.name <> '' then excluded.name
  else ad_meta_pages.name end, token_cipher = excluded.token_cipher, connected_by = excluded.connected_by,
  updated_at = now();
 insert into public.ad_lead_forms(company_id, client_id, page_id, page_name, form_id, form_name, landing_page_id,
  make_user_id, created_by)
 values (p_company, p_client, p_page_id, left(coalesce(p_page_name, ''), 200), p_form_id, left(coalesce(p_form_name, ''), 300),
  trim(p_landing_page), trim(p_make_user), auth.uid())
 on conflict (company_id, form_id) do update set client_id = coalesce(excluded.client_id, ad_lead_forms.client_id),
  page_id = excluded.page_id, page_name = case when excluded.page_name <> '' then excluded.page_name else ad_lead_forms.page_name end,
  form_name = case when excluded.form_name <> '' then excluded.form_name else ad_lead_forms.form_name end,
  landing_page_id = excluded.landing_page_id, make_user_id = excluded.make_user_id, updated_at = now()
 returning * into result;
 return result;
end $$;

create function public.ad_delete_lead_form(p_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare f public.ad_lead_forms; begin
 select * into f from public.ad_lead_forms where id = p_id;
 if not found then raise exception 'Formulário não encontrado' using errcode = '42501'; end if;
 perform mavi_private.ad_require_admin(f.company_id);
 delete from public.ad_lead_forms where id = p_id;
end $$;

-- The linked forms (of a client, or all), with how the deliveries go.
create function public.ad_lead_forms_overview(p_company uuid, p_client uuid default null) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare result jsonb; begin
 perform mavi_private.ad_require_admin(p_company);
 select coalesce(jsonb_agg(jsonb_build_object('id', f.id, 'client_id', f.client_id,
   'client', (select c.name from public.clients c where c.company_id = f.company_id and c.id = f.client_id),
   'page_id', f.page_id, 'page_name', f.page_name, 'form_id', f.form_id, 'form_name', f.form_name,
   'landing_page_id', f.landing_page_id, 'make_user_id', f.make_user_id, 'source', f.source,
   'updated_at', f.updated_at,
   'last_lead_at', (select max(d.created_at) from public.ad_lead_deliveries d where d.lead_form_id = f.id
     and d.status in ('sent','duplicate')),
   'sent_30d', (select count(*) from public.ad_lead_deliveries d where d.lead_form_id = f.id
     and d.status in ('sent','duplicate') and d.created_at > now() - interval '30 days'),
   'last_error', (select jsonb_build_object('at', d.updated_at, 'message', d.message)
     from public.ad_lead_deliveries d where d.lead_form_id = f.id and d.status = 'error'
     order by d.updated_at desc limit 1))
  order by f.updated_at desc), '[]') into result
 from public.ad_lead_forms f
 where f.company_id = p_company and (p_client is null or f.client_id = p_client);
 return result;
end $$;

-- The webhook, for each lead: records it once (a lead that failed before,
-- or got stuck processing, may be tried again) and says where it goes —
-- the capture page, the Make client, the Page's sealed token and, to find
-- the ad's names (UTMs), the sealed tokens of the client's ad accounts.
create function public.ad_leadgen_claim(p_secret text, p_leadgen text, p_page text, p_form text) returns jsonb
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
    and m.client_id = f.client_id and (m.token_expires_at is null or m.token_expires_at > now())), '[]'));
end $$;

create function public.ad_leadgen_finish(p_secret text, p_leadgen text, p_status text, p_message text default '')
returns void
language plpgsql security definer set search_path = '' as $$ begin
 if not mavi_private.ad_sync_allowed(p_secret, null) then raise exception 'Sem permissão' using errcode = '42501'; end if;
 if p_status not in ('sent','duplicate','error') then raise exception 'Status inválido' using errcode = '22023'; end if;
 update public.ad_lead_deliveries set status = p_status, message = left(coalesce(p_message, ''), 1000), updated_at = now()
 where leadgen_id = p_leadgen;
end $$;

revoke all on function public.ad_save_lead_form(uuid, uuid, text, text, text, text, text, text, text),
 public.ad_delete_lead_form(uuid), public.ad_lead_forms_overview(uuid, uuid),
 public.ad_leadgen_claim(text, text, text, text), public.ad_leadgen_finish(text, text, text, text)
 from public, anon, authenticated;
grant execute on function public.ad_save_lead_form(uuid, uuid, text, text, text, text, text, text, text),
 public.ad_delete_lead_form(uuid), public.ad_lead_forms_overview(uuid, uuid) to authenticated;
-- anon: the webhook, with the server's secret.
grant execute on function public.ad_leadgen_claim(text, text, text, text), public.ad_leadgen_finish(text, text, text, text)
 to anon, authenticated;

commit;
