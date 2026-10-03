begin;

-- Campanhas › "Abrir no CRM": um clique abre o MakeCRM do cliente, já logado.
--
-- O MakeCRM é outro SaaS (outro Supabase) em que cada login pertence a uma
-- empresa só. Aqui fica qual empresa do CRM é de cada cliente do MAVI (um
-- administrador ou gestor liga em Campanhas › Conexões) e quem abriu o CRM de
-- qual cliente, quando. O resto acontece fora do banco: o servidor do MAVI
-- (api/crm) pede ao servidor do MakeCRM, com um segredo que o banco não tem,
-- um link de entrada de uso único para o login desta pessoa naquela empresa
-- (criado no primeiro clique, com o papel que ela tem no MAVI).

-- ------------------------------------------------------------ tabelas
create table public.client_crm_links (
 company_id uuid not null references public.companies(id) on delete cascade,
 client_id uuid not null,
 -- companys.id no MakeCRM.
 crm_company_id uuid not null,
 -- Como a empresa aparece na escolha ("Código Make 1234 · Fulano"), para
 -- mostrar sem perguntar ao CRM.
 crm_label text not null default '' check (length(crm_label) <= 300),
 linked_by uuid references auth.users(id) on delete set null,
 linked_at timestamptz not null default now(),
 primary key (company_id, client_id),
 foreign key (company_id, client_id) references public.clients(company_id, id) on delete cascade
);
alter table public.client_crm_links enable row level security;
revoke all on public.client_crm_links from public, anon, authenticated;
grant select on public.client_crm_links to authenticated;
-- Vê a ligação quem vê o cliente em Campanhas (é o que mostra o botão).
create policy client_crm_links_read on public.client_crm_links for select to authenticated
 using (company_id in (select mavi_private.active_companies())
  and mavi_private.module_client(company_id, 'campaigns', client_id));

-- Quem abriu o CRM de qual cliente (nunca alterado).
create table public.client_crm_opens (
 id bigint generated always as identity primary key,
 company_id uuid not null references public.companies(id) on delete cascade,
 client_id uuid not null references public.clients(id) on delete cascade,
 user_id uuid references auth.users(id) on delete set null,
 crm_company_id uuid not null,
 -- O papel com que entrou no CRM: admin, manager ou member.
 role text not null,
 created_at timestamptz not null default now()
);
create index client_crm_opens_user on public.client_crm_opens(user_id, created_at desc);
create index client_crm_opens_client on public.client_crm_opens(company_id, client_id, created_at desc);
alter table public.client_crm_opens enable row level security;
revoke all on public.client_crm_opens from public, anon, authenticated;

-- ------------------------------------------------------------ ligar (líderes)
create function mavi_private.crm_require_leader(c uuid) returns void
language plpgsql stable security definer set search_path = '' as $$ begin
 if not mavi_private.leader(c) then
  raise exception 'Sem permissão: só administradores e gestores ligam clientes ao CRM' using errcode = '42501';
 end if;
end $$;
revoke all on function mavi_private.crm_require_leader(uuid) from public, anon;
grant execute on function mavi_private.crm_require_leader(uuid) to authenticated;

-- Os clientes com campanha (e os já ligados), com a ligação e os códigos da
-- Make dos formulários de leads deles, para sugerir a empresa do CRM.
create function public.crm_link_clients(p_company uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$ begin
 perform mavi_private.crm_require_leader(p_company);
 return coalesce((select jsonb_agg(jsonb_build_object(
   'client_id', c.id, 'name', c.name,
   'crm_company_id', l.crm_company_id, 'crm_label', l.crm_label, 'linked_at', l.linked_at,
   'make_ids', coalesce((select jsonb_agg(distinct f.make_user_id) from public.ad_lead_forms f
     where f.company_id = c.company_id and f.client_id = c.id), '[]'))
  order by c.name)
  from public.clients c
  left join public.client_crm_links l on l.company_id = c.company_id and l.client_id = c.id
  where c.company_id = p_company and (l.client_id is not null or (not c.archived and exists (
   select 1 from public.ad_campaigns a join public.contracts k on k.company_id = a.company_id and k.id = a.contract_id
   where a.company_id = c.company_id and k.client_id = c.id)))), '[]');
end $$;

create function public.crm_link_set(p_company uuid, p_client uuid, p_crm_company uuid, p_label text)
returns void language plpgsql security definer set search_path = '' as $$ begin
 perform mavi_private.crm_require_leader(p_company);
 if not exists (select 1 from public.clients c where c.company_id = p_company and c.id = p_client) then
  raise exception 'Cliente não encontrado.' using errcode = 'P0002';
 end if;
 if p_crm_company is null then raise exception 'Escolha a empresa do CRM.' using errcode = '22023'; end if;
 insert into public.client_crm_links(company_id, client_id, crm_company_id, crm_label, linked_by)
 values (p_company, p_client, p_crm_company, left(coalesce(btrim(p_label), ''), 300), auth.uid())
 on conflict (company_id, client_id) do update set crm_company_id = excluded.crm_company_id,
  crm_label = excluded.crm_label, linked_by = excluded.linked_by, linked_at = now();
end $$;

create function public.crm_link_remove(p_company uuid, p_client uuid)
returns void language plpgsql security definer set search_path = '' as $$ begin
 perform mavi_private.crm_require_leader(p_company);
 delete from public.client_crm_links where company_id = p_company and client_id = p_client;
end $$;

-- Para o servidor confirmar que quem pede a lista de empresas do CRM é líder.
create function public.crm_link_admin(p_company uuid) returns boolean
language plpgsql stable security definer set search_path = '' as $$ begin
 perform mavi_private.crm_require_leader(p_company);
 return true;
end $$;

-- ------------------------------------------------------------ abrir
-- Chamado pelo servidor do MAVI com o login da pessoa: confere o acesso ao
-- cliente pela regra de Campanhas, registra e devolve o que o MakeCRM precisa
-- para achar ou criar o login dela naquela empresa.
create function public.crm_open(p_company uuid, p_client uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare l public.client_crm_links; m public.memberships; v_email text; begin
 if not mavi_private.module_client(p_company, 'campaigns', p_client) then
  raise exception 'Sem permissão: este cliente não é de uma equipe sua' using errcode = '42501';
 end if;
 select * into l from public.client_crm_links where company_id = p_company and client_id = p_client;
 if l.client_id is null then
  raise exception 'Este cliente ainda não está ligado a uma empresa do MakeCRM.' using errcode = 'P0002';
 end if;
 select * into m from public.memberships where company_id = p_company and user_id = auth.uid() and active;
 if m.user_id is null then raise exception 'Sem permissão' using errcode = '42501'; end if;
 -- Até 120 aberturas por pessoa por hora.
 if (select count(*) from public.client_crm_opens o where o.user_id = auth.uid()
  and o.created_at > now() - interval '1 hour') >= 120 then
  raise exception 'Muitas aberturas do CRM em pouco tempo: tente de novo daqui a pouco.' using errcode = '54000';
 end if;
 select u.email into v_email from auth.users u where u.id = auth.uid();
 insert into public.client_crm_opens(company_id, client_id, user_id, crm_company_id, role)
 values (p_company, p_client, auth.uid(), l.crm_company_id, m.role);
 return jsonb_build_object('crm_company_id', l.crm_company_id, 'user_id', auth.uid(),
  'email', coalesce(v_email, m.email), 'name', coalesce(nullif(btrim(m.name), ''), v_email, m.email), 'role', m.role);
end $$;

revoke all on function public.crm_link_clients(uuid), public.crm_link_set(uuid, uuid, uuid, text),
 public.crm_link_remove(uuid, uuid), public.crm_link_admin(uuid), public.crm_open(uuid, uuid) from public, anon;
grant execute on function public.crm_link_clients(uuid), public.crm_link_set(uuid, uuid, uuid, text),
 public.crm_link_remove(uuid, uuid), public.crm_link_admin(uuid), public.crm_open(uuid, uuid) to authenticated;

commit;
