begin;

-- Social Leads: o cliente que já tem o produto Social Leads, mas que a
-- pessoa não vê na carteira (nenhuma equipe dela, nem o squad, atende o
-- cliente; ex.: cadastrado em Clientes já com o produto, sem equipe), não
-- aparecia em lugar nenhum: fora da carteira e fora do "Adicionar cliente"
-- (que pulava quem já tinha o produto). Agora ele entra na lista do
-- "Adicionar cliente" e adicioná-lo liga o squad ao cliente, com o mesmo
-- produto contratado (nada é duplicado).

create or replace function public.social_leads_addable_clients(p_company uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare s public.social_leads_settings; begin
 if not exists (select 1 from public.memberships where company_id = p_company and user_id = auth.uid() and active) then
  raise exception 'Sem acesso.' using errcode = '42501';
 end if;
 select * into s from public.social_leads_settings where company_id = p_company;
 if not found then return '[]'::jsonb; end if;
 return coalesce((
  select jsonb_agg(jsonb_build_object('id', x.id, 'name', x.name, 'color', x.color,
    'archived_contract', x.archived_contract, 'hidden_contract', x.hidden_contract) order by x.name)
  from (
   select cl.id, cl.name, cl.color,
    (select k.id from public.contracts k where k.company_id = cl.company_id and k.client_id = cl.id
      and k.product_id = s.product_id and k.archived order by k.created_at desc limit 1) as archived_contract,
    (select k.id from public.contracts k where k.company_id = cl.company_id and k.client_id = cl.id
      and k.product_id = s.product_id and not k.archived order by k.created_at desc limit 1) as hidden_contract
   from public.clients cl
   where cl.company_id = p_company and not cl.archived
    and mavi_private.social_leads_may_add(p_company, cl.id)
    -- Fica de fora só quem já está na carteira da pessoa.
    and not exists (select 1 from public.contracts k where k.company_id = cl.company_id and k.client_id = cl.id
     and k.product_id = s.product_id and not k.archived and mavi_private.contract_read(k.company_id, k.id))
  ) x), '[]'::jsonb);
end $$;

create or replace function public.social_leads_add_client(p_company uuid, p_client uuid, p_name text,
 p_teams uuid[] default null) returns uuid
language plpgsql security definer set search_path = '' as $$
declare s public.social_leads_settings; pr public.products; cl public.clients; k uuid; seen boolean; begin
 if not exists (select 1 from public.memberships where company_id = p_company and user_id = auth.uid() and active) then
  raise exception 'Sem acesso.' using errcode = '42501';
 end if;
 select * into s from public.social_leads_settings where company_id = p_company;
 if not found then raise exception 'Configure o Social Leads antes.' using errcode = '22023'; end if;
 if p_client is null then
  raise exception 'Escolha um cliente já cadastrado. Clientes novos são cadastrados em Clientes.' using errcode = '22023';
 end if;
 select * into cl from public.clients where company_id = p_company and id = p_client and not archived;
 if not found then raise exception 'Cliente não encontrado.' using errcode = 'P0002'; end if;
 if not mavi_private.social_leads_may_add(p_company, cl.id) then
  raise exception 'Você só adiciona clientes atendidos por uma equipe sua.' using errcode = '42501';
 end if;
 seen := exists (select 1 from public.contracts x where x.company_id = p_company and x.client_id = cl.id
  and x.product_id = s.product_id and not x.archived and mavi_private.contract_read(p_company, x.id));
 if s.team_id is not null then
  insert into public.client_teams(company_id, client_id, team_id) values (p_company, cl.id, s.team_id)
  on conflict do nothing;
 end if;
 -- Já tem o produto (e a pessoa não o via): o squad passa a atendê-lo.
 select id into k from public.contracts where company_id = p_company and client_id = cl.id
  and product_id = s.product_id and not archived order by created_at desc limit 1;
 if found then
  -- Visible before the squad was added: it was in the portfolio already.
  if seen then
   raise exception 'Este cliente já está no Social Leads.' using errcode = '23505';
  end if;
  if not mavi_private.contract_read(p_company, k) then
   raise exception 'Este cliente já está no Social Leads, atendido por equipes das quais você não faz parte. Peça para entrar na equipe do squad.'
    using errcode = '42501';
  end if;
 else
  select id into k from public.contracts where company_id = p_company and client_id = cl.id
   and product_id = s.product_id and archived order by created_at desc limit 1 for update;
  if found then
   update public.contracts set archived = false where company_id = p_company and id = k;
  else
   select * into pr from public.products where company_id = p_company and id = s.product_id;
   insert into public.contracts(company_id, client_id, product_id, name)
   values (p_company, cl.id, s.product_id, left(coalesce(pr.name, 'Social Leads') || ' · ' || cl.name, 160))
   returning id into k;
  end if;
 end if;
 perform mavi_private.broadcast(p_company, jsonb_build_object('kind', 'social_leads', 'contract', k,
  'table', 'contracts'));
 return k;
end $$;

-- A carteira aberta fica em dia com o que muda fora do Social Leads: um
-- cliente cadastrado em Clientes já com o produto, um produto arquivado ou
-- trocado, um cliente arquivado, uma equipe ligada ao cliente. Um aviso por
-- instrução, só quando envolve o produto do Social Leads (sem consultas
-- periódicas).
create or replace function mavi_private.broadcast_social_leads_contracts() returns trigger
language plpgsql security definer set search_path = '' as $$
declare r record; begin
 for r in
  select distinct x.company_id, x.id from changed x
  join public.social_leads_settings s on s.company_id = x.company_id and s.product_id = x.product_id
 loop
  perform mavi_private.broadcast(r.company_id, jsonb_build_object(
   'kind', 'social_leads', 'contract', r.id, 'table', 'contracts'));
 end loop;
 return null;
end $$;
revoke all on function mavi_private.broadcast_social_leads_contracts() from public, anon, authenticated;
drop trigger if exists broadcast_social_leads_contracts_ins on public.contracts;
drop trigger if exists broadcast_social_leads_contracts_upd on public.contracts;
drop trigger if exists broadcast_social_leads_contracts_del on public.contracts;
create trigger broadcast_social_leads_contracts_ins after insert on public.contracts
 referencing new table as changed for each statement execute function mavi_private.broadcast_social_leads_contracts();
create trigger broadcast_social_leads_contracts_upd after update on public.contracts
 referencing new table as changed for each statement execute function mavi_private.broadcast_social_leads_contracts();
create trigger broadcast_social_leads_contracts_del after delete on public.contracts
 referencing old table as changed for each statement execute function mavi_private.broadcast_social_leads_contracts();

-- Cliente arquivado ou renomeado, e equipe ligada ou tirada do cliente.
create or replace function mavi_private.broadcast_social_leads_clients() returns trigger
language plpgsql security definer set search_path = '' as $$
declare r record; begin
 for r in
  select distinct x.company_id from changed x
  join public.social_leads_settings s on s.company_id = x.company_id
  where exists (select 1 from public.contracts k where k.company_id = x.company_id
   and k.client_id = x.client_id and k.product_id = s.product_id)
 loop
  perform mavi_private.broadcast(r.company_id, jsonb_build_object('kind', 'social_leads', 'table', tg_table_name));
 end loop;
 return null;
end $$;
revoke all on function mavi_private.broadcast_social_leads_clients() from public, anon, authenticated;
drop trigger if exists broadcast_social_leads_client_teams_ins on public.client_teams;
drop trigger if exists broadcast_social_leads_client_teams_del on public.client_teams;
create trigger broadcast_social_leads_client_teams_ins after insert on public.client_teams
 referencing new table as changed for each statement execute function mavi_private.broadcast_social_leads_clients();
create trigger broadcast_social_leads_client_teams_del after delete on public.client_teams
 referencing old table as changed for each statement execute function mavi_private.broadcast_social_leads_clients();

create or replace function mavi_private.broadcast_social_leads_client_rows() returns trigger
language plpgsql security definer set search_path = '' as $$
declare r record; begin
 for r in
  select distinct x.company_id from changed x
  join public.social_leads_settings s on s.company_id = x.company_id
  where exists (select 1 from public.contracts k where k.company_id = x.company_id
   and k.client_id = x.id and k.product_id = s.product_id)
 loop
  perform mavi_private.broadcast(r.company_id, jsonb_build_object('kind', 'social_leads', 'table', 'clients'));
 end loop;
 return null;
end $$;
revoke all on function mavi_private.broadcast_social_leads_client_rows() from public, anon, authenticated;
drop trigger if exists broadcast_social_leads_clients_upd on public.clients;
create trigger broadcast_social_leads_clients_upd after update on public.clients
 referencing new table as changed for each statement execute function mavi_private.broadcast_social_leads_client_rows();

notify pgrst, 'reload schema';

commit;
