begin;

-- Social Leads: tirar um cliente da carteira e o "Adicionar cliente" só com
-- clientes já cadastrados.
-- 1. Arquivar: o produto Social Leads do cliente fica arquivado (o cliente,
--    os outros produtos, o briefing, os planos, as tarefas e os arquivos
--    ficam guardados; as tarefas que se repetem do ciclo param de abrir
--    cópias enquanto ele estiver arquivado). Grava quem grava no cliente.
--    O cliente volta pelo "Adicionar cliente", com o histórico.
-- 2. Excluir de vez: só o que foi adicionado por engano, sem plano, tarefa
--    nem arquivo (o produto contratado e o briefing vazio saem).
-- 3. Quem pode adicionar quais clientes (social_leads_addable_clients): os
--    líderes, todos; os demais, os clientes atendidos por uma equipe sua e,
--    para quem é do squad, qualquer cliente (o squad passa a atendê-lo). A
--    lista vem do banco porque a visibilidade de Clientes esconde de quem não
--    é líder o cliente que ainda não tem produto contratado.
-- 4. O cadastro de cliente novo sai do Social Leads (fica em Clientes).

-- ------------------------------------------------------------ quem pode adicionar
create or replace function mavi_private.social_leads_may_add(c uuid, p_client uuid) returns boolean
language sql stable security definer set search_path = '' as $$
 select mavi_private.leader(c)
  or exists (select 1 from public.client_teams ct
   join public.team_members tm on tm.company_id = ct.company_id and tm.team_id = ct.team_id
   where ct.company_id = c and ct.client_id = p_client and tm.user_id = auth.uid())
  or exists (select 1 from public.social_leads_settings s
   join public.team_members tm on tm.company_id = s.company_id and tm.team_id = s.team_id
   where s.company_id = c and tm.user_id = auth.uid())
$$;
revoke all on function mavi_private.social_leads_may_add(uuid, uuid) from public, anon, authenticated;

-- Os clientes que a pessoa pode pôr na carteira: ativos, sem o Social Leads
-- ativo. Os que já tiveram (arquivado) voltam com o histórico.
create or replace function public.social_leads_addable_clients(p_company uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare s public.social_leads_settings; begin
 if not exists (select 1 from public.memberships where company_id = p_company and user_id = auth.uid() and active) then
  raise exception 'Sem acesso.' using errcode = '42501';
 end if;
 select * into s from public.social_leads_settings where company_id = p_company;
 if not found then return '[]'::jsonb; end if;
 return coalesce((
  select jsonb_agg(jsonb_build_object('id', cl.id, 'name', cl.name, 'color', cl.color,
    'archived_contract', (select k.id from public.contracts k where k.company_id = cl.company_id
     and k.client_id = cl.id and k.product_id = s.product_id and k.archived order by k.created_at desc limit 1))
   order by cl.name)
  from public.clients cl
  where cl.company_id = p_company and not cl.archived
   and not exists (select 1 from public.contracts k where k.company_id = cl.company_id and k.client_id = cl.id
    and k.product_id = s.product_id and not k.archived)
   and mavi_private.social_leads_may_add(p_company, cl.id)), '[]'::jsonb);
end $$;
revoke all on function public.social_leads_addable_clients(uuid) from public, anon;
grant execute on function public.social_leads_addable_clients(uuid) to authenticated;

-- Só clientes já cadastrados. O que já teve o Social Leads (arquivado) volta
-- com o histórico; os outros ganham o produto. O squad passa a atender o
-- cliente. p_name e p_teams ficam na assinatura (a tela antiga), sem uso.
create or replace function public.social_leads_add_client(p_company uuid, p_client uuid, p_name text,
 p_teams uuid[] default null) returns uuid
language plpgsql security definer set search_path = '' as $$
declare s public.social_leads_settings; pr public.products; cl public.clients; k uuid; begin
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
 if exists (select 1 from public.contracts where company_id = p_company and client_id = cl.id
  and product_id = s.product_id and not archived) then
  raise exception 'Este cliente já está no Social Leads.' using errcode = '23505';
 end if;
 if s.team_id is not null then
  insert into public.client_teams(company_id, client_id, team_id) values (p_company, cl.id, s.team_id)
  on conflict do nothing;
 end if;
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
 perform mavi_private.broadcast(p_company, jsonb_build_object('kind', 'social_leads', 'contract', k,
  'table', 'contracts'));
 return k;
end $$;

-- ------------------------------------------------------------ arquivar e excluir
-- p_archived false é o mesmo que "Adicionar cliente" de volta.
create or replace function public.social_leads_archive(p_contract uuid, p_archived boolean) returns void
language plpgsql security definer set search_path = '' as $$
declare k public.contracts; s public.social_leads_settings; begin
 select * into k from public.contracts where id = p_contract for update;
 if not found then raise exception 'Cliente não encontrado no Social Leads.' using errcode = 'P0002'; end if;
 select * into s from public.social_leads_settings where company_id = k.company_id;
 if not found or k.product_id <> s.product_id then
  raise exception 'Cliente não encontrado no Social Leads.' using errcode = 'P0002';
 end if;
 if p_archived is null then raise exception 'Informe se o cliente sai do Social Leads.' using errcode = '22023'; end if;
 if p_archived then
  if not mavi_private.social_leads_can_write(k.company_id, k.id) then
   raise exception 'Sem permissão para tirar este cliente do Social Leads.' using errcode = '42501';
  end if;
  if exists (select 1 from public.social_leads_jobs where contract_id = k.id and status = 'running'
   and created_at > now() - interval '15 minutes') then
   raise exception 'A MAVI está gerando o plano deste cliente. Espere terminar para arquivar.' using errcode = '55P03';
  end if;
  update public.contracts set archived = true where id = k.id;
 else
  if not mavi_private.social_leads_may_add(k.company_id, k.client_id) then
   raise exception 'Você só adiciona clientes atendidos por uma equipe sua.' using errcode = '42501';
  end if;
  if exists (select 1 from public.contracts where company_id = k.company_id and client_id = k.client_id
   and product_id = k.product_id and not archived and id <> k.id) then
   raise exception 'Este cliente já está no Social Leads.' using errcode = '23505';
  end if;
  if exists (select 1 from public.clients where company_id = k.company_id and id = k.client_id and archived) then
   raise exception 'Este cliente está arquivado em Clientes. Desarquive-o antes.' using errcode = '22023';
  end if;
  update public.contracts set archived = false where id = k.id;
  if s.team_id is not null then
   insert into public.client_teams(company_id, client_id, team_id) values (k.company_id, k.client_id, s.team_id)
   on conflict do nothing;
  end if;
 end if;
 perform mavi_private.broadcast(k.company_id, jsonb_build_object('kind', 'social_leads', 'contract', k.id,
  'table', 'contracts'));
end $$;
revoke all on function public.social_leads_archive(uuid, boolean) from public, anon;
grant execute on function public.social_leads_archive(uuid, boolean) to authenticated;

-- Excluir de vez o que foi adicionado por engano: sem plano, tarefa, projeto,
-- arquivo ou pasta no Drive, nem campanha. Havendo histórico, o caminho é
-- arquivar.
create or replace function public.social_leads_remove(p_contract uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare k public.contracts; s public.social_leads_settings; begin
 select * into k from public.contracts where id = p_contract for update;
 select * into s from public.social_leads_settings where company_id = k.company_id;
 if k.id is null or s.company_id is null or k.product_id <> s.product_id then
  raise exception 'Cliente não encontrado no Social Leads.' using errcode = 'P0002';
 end if;
 if not mavi_private.social_leads_can_write(k.company_id, k.id) then
  raise exception 'Sem permissão para tirar este cliente do Social Leads.' using errcode = '42501';
 end if;
 if exists (select 1 from public.social_leads_plans where contract_id = k.id)
  or exists (select 1 from public.tasks where company_id = k.company_id and contract_id = k.id)
  or exists (select 1 from public.projects where company_id = k.company_id and contract_id = k.id)
  or exists (select 1 from public.drive_files where company_id = k.company_id and contract_id = k.id)
  or exists (select 1 from public.drive_folders where company_id = k.company_id and contract_id = k.id)
  or exists (select 1 from public.ad_campaigns where company_id = k.company_id and contract_id = k.id) then
  raise exception 'Este cliente já tem histórico no Social Leads (plano, tarefa ou arquivo). Arquive em vez de excluir.'
   using errcode = '23503';
 end if;
 begin
  delete from public.social_leads_ai_usage where contract_id = k.id;
  delete from public.social_leads_jobs where contract_id = k.id;
  delete from public.social_leads_briefings where company_id = k.company_id and contract_id = k.id;
  delete from public.contracts where id = k.id;
 exception when foreign_key_violation then
  -- Something else of the app still points at the product (hours, notes…).
  raise exception 'Este cliente já tem histórico ligado a este produto. Arquive em vez de excluir.'
   using errcode = '23503';
 end;
 perform mavi_private.broadcast(k.company_id, jsonb_build_object('kind', 'social_leads', 'contract', k.id,
  'table', 'contracts'));
end $$;
revoke all on function public.social_leads_remove(uuid) from public, anon;
grant execute on function public.social_leads_remove(uuid) to authenticated;

notify pgrst, 'reload schema';

commit;
