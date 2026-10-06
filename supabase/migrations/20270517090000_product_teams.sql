begin;

-- As equipes responsáveis passam a ser escolhidas no produto: ao adicionar um
-- produto a um cliente, as equipes do produto passam a atender o cliente
-- inteiro (como antes, todos os produtos, projetos e tarefas dele). O cliente
-- ainda pode ter equipes extras, como exceção.
--
-- client_teams continua sendo a fonte de acesso de todo o sistema; agora é
-- mantida pelo banco: uma linha existe enquanto um produto ativo do cliente
-- traz a equipe (by_product) ou enquanto ela é extra (manual).
create table public.product_teams (
 company_id uuid not null, product_id uuid not null, team_id uuid not null,
 primary key(company_id,product_id,team_id),
 foreign key(company_id,product_id) references public.products(company_id,id),
 foreign key(company_id,team_id) references public.teams(company_id,id)
);
create index product_teams_team on public.product_teams(company_id,team_id);
alter table public.product_teams enable row level security;
revoke all on public.product_teams from anon, authenticated;
grant select on public.product_teams to authenticated;
create policy product_teams_read on public.product_teams for select to authenticated
 using(company_id in (select mavi_private.active_companies()));
create trigger broadcast_lookup after insert or update or delete on public.product_teams
 for each row execute function mavi_private.broadcast_lookup();

-- As ligações de hoje continuam como extras até os produtos terem equipes.
-- Quem grava direto em client_teams (Social Leads, create_contract com
-- p_team) segue criando extras pelos valores padrão.
alter table public.client_teams
 add column manual boolean not null default true,
 add column by_product boolean not null default false,
 add constraint client_teams_reason check (manual or by_product);
comment on column public.client_teams.manual is
 'Equipe extra do cliente (exceção), fora as que os produtos trazem (20270517090000).';
comment on column public.client_teams.by_product is
 'Um produto ativo do cliente traz esta equipe (product_teams). Mantido pelo banco (20270517090000).';

-- Refaz as equipes que os produtos ativos trazem ao cliente. Uma equipe que
-- passa a vir pelo produto deixa de ser extra: se o produto deixar de
-- trazê-la, ela sai do cliente.
create function mavi_private.sync_client_teams(c uuid, p_client uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare s uuid[]; begin
 select coalesce(array_agg(distinct pt.team_id), '{}') into s
 from public.contracts k
 join public.product_teams pt on pt.company_id = k.company_id and pt.product_id = k.product_id
 where k.company_id = c and k.client_id = p_client and not k.archived;
 insert into public.client_teams as ct(company_id, client_id, team_id, manual, by_product)
  select c, p_client, t, false, true from unnest(s) as t
 on conflict (company_id, client_id, team_id) do update set manual = false, by_product = true
  where ct.manual or not ct.by_product;
 delete from public.client_teams
  where company_id = c and client_id = p_client and by_product and not manual and team_id <> all(s);
 update public.client_teams set by_product = false
  where company_id = c and client_id = p_client and by_product and team_id <> all(s);
end $$;
revoke all on function mavi_private.sync_client_teams(uuid, uuid) from public, anon, authenticated;

-- Produto adicionado, removido, arquivado, reativado ou trocado de cliente.
create function mavi_private.sync_contract_client_teams() returns trigger
language plpgsql security definer set search_path = '' as $$
declare r record; begin
 if tg_op = 'INSERT' then
  for r in select distinct company_id, client_id from new_rows loop
   perform mavi_private.sync_client_teams(r.company_id, r.client_id);
  end loop;
 elsif tg_op = 'DELETE' then
  for r in select distinct company_id, client_id from old_rows loop
   perform mavi_private.sync_client_teams(r.company_id, r.client_id);
  end loop;
 else
  for r in
   select n.company_id, n.client_id from new_rows n join old_rows o on o.id = n.id
    where (n.client_id, n.product_id, n.archived) is distinct from (o.client_id, o.product_id, o.archived)
   union
   select o.company_id, o.client_id from new_rows n join old_rows o on o.id = n.id
    where (n.client_id, n.product_id, n.archived) is distinct from (o.client_id, o.product_id, o.archived)
  loop
   perform mavi_private.sync_client_teams(r.company_id, r.client_id);
  end loop;
 end if;
 return null;
end $$;
revoke all on function mavi_private.sync_contract_client_teams() from public, anon, authenticated;
create trigger sync_client_teams_ins after insert on public.contracts
 referencing new table as new_rows for each statement execute function mavi_private.sync_contract_client_teams();
create trigger sync_client_teams_upd after update on public.contracts
 referencing old table as old_rows new table as new_rows for each statement
 execute function mavi_private.sync_contract_client_teams();
create trigger sync_client_teams_del after delete on public.contracts
 referencing old table as old_rows for each statement execute function mavi_private.sync_contract_client_teams();

-- Equipes do produto mudaram: todos os clientes com ele acompanham.
create function mavi_private.sync_product_client_teams() returns trigger
language plpgsql security definer set search_path = '' as $$
declare r record; begin
 for r in
  select distinct k.company_id, k.client_id from public.contracts k
  where (k.company_id, k.product_id) in (select company_id, product_id from changed)
 loop
  perform mavi_private.sync_client_teams(r.company_id, r.client_id);
 end loop;
 return null;
end $$;
revoke all on function mavi_private.sync_product_client_teams() from public, anon, authenticated;
create trigger sync_client_teams_ins after insert on public.product_teams
 referencing new table as changed for each statement execute function mavi_private.sync_product_client_teams();
create trigger sync_client_teams_del after delete on public.product_teams
 referencing old table as changed for each statement execute function mavi_private.sync_product_client_teams();

-- Troca as equipes de um produto; a chave composta recusa equipes de outra empresa.
create function mavi_private.set_product_teams(c uuid, p_product uuid, p_teams uuid[]) returns void
language sql security definer set search_path = '' as $$
 delete from public.product_teams where company_id = c and product_id = p_product
  and team_id <> all(coalesce(p_teams, '{}'::uuid[]));
 insert into public.product_teams(company_id, product_id, team_id)
  select distinct c, p_product, t from unnest(p_teams) as t where t is not null
 on conflict do nothing;
$$;
revoke all on function mavi_private.set_product_teams(uuid, uuid, uuid[]) from public, anon, authenticated;

-- Agora troca só as equipes extras do cliente. As que os produtos trazem
-- ficam, escolhidas ou não (create_client, update_client, api_create_client).
create or replace function mavi_private.set_client_teams(c uuid, p_client uuid, p_teams uuid[]) returns void
language sql security definer set search_path = '' as $$
 delete from public.client_teams where company_id = c and client_id = p_client and manual and not by_product
  and team_id <> all(coalesce(p_teams, '{}'::uuid[]));
 update public.client_teams set manual = false where company_id = c and client_id = p_client and manual and by_product
  and team_id <> all(coalesce(p_teams, '{}'::uuid[]));
 insert into public.client_teams(company_id, client_id, team_id)
  select distinct c, p_client, t from unnest(p_teams) as t where t is not null
 on conflict do nothing;
$$;

drop function public.create_product(uuid, text);
create function public.create_product(p_company uuid, p_name text, p_teams uuid[] default null) returns uuid
language plpgsql security definer set search_path = '' as $$ declare result uuid; begin
  if not mavi_private.leader(p_company) then raise exception 'Sem permissão' using errcode = '42501'; end if;
  insert into public.products(company_id, name) values(p_company, trim(p_name)) returning id into result;
  perform mavi_private.set_product_teams(p_company, result, coalesce(p_teams, '{}'::uuid[]));
  return result;
end $$;
revoke all on function public.create_product(uuid, text, uuid[]) from public, anon;
grant execute on function public.create_product(uuid, text, uuid[]) to authenticated;

-- Sem p_teams as equipes do produto ficam como estão.
drop function public.update_product(uuid, text, text, boolean);
create function public.update_product(p_product uuid, p_name text, p_color text default null,
 p_task_project_field boolean default null, p_teams uuid[] default null) returns void
language plpgsql security definer set search_path = '' as $$
declare p public.products; begin
  select * into p from public.products where id = p_product for update;
  if not found or not mavi_private.leader(p.company_id) then raise exception 'Sem permissão' using errcode = '42501'; end if;
  if p_color is not null and p_color !~ '^#[0-9A-Fa-f]{6}$' then
    raise exception 'Cor inválida: use o formato #RRGGBB.' using errcode = '22023';
  end if;
  update public.products set name = trim(p_name), color = coalesce(lower(p_color), color),
   task_project_field = coalesce(p_task_project_field, task_project_field)
  where id = p_product;
  if p_teams is not null then perform mavi_private.set_product_teams(p.company_id, p_product, p_teams); end if;
end $$;
revoke all on function public.update_product(uuid, text, text, boolean, uuid[]) from public, anon;
grant execute on function public.update_product(uuid, text, text, boolean, uuid[]) to authenticated;

notify pgrst, 'reload schema';

commit;
