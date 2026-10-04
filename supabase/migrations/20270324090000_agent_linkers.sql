begin;

-- Agente Conversacional › quem liga os fluxos aos clientes. Antes só
-- administradores e gestores usavam "Trocar cliente" (aba Agentes) e a aba
-- "Sem cliente". Agora eles liberam também outras pessoas (aba Permissões
-- do módulo). Líderes sempre podem. Quem foi liberado:
--  - vê a aba "Sem cliente" (lê os fluxos sem cliente e os prompts deles),
--    liga ao cliente e ao produto, desliga e ignora;
--  - usa "Trocar cliente" nos fluxos dos clientes que já vê;
--  - liga só a clientes que ele vê (a regra do Drive): o fluxo não some da
--    tela dele nem vai para um cliente que ele não atende.
-- Publicar um prompt continua com a regra do Drive (fluxo sem cliente: só
-- líderes).

create table public.agent_linkers (
 company_id uuid not null references public.companies(id) on delete cascade,
 user_id uuid not null references auth.users(id) on delete cascade,
 granted_by uuid references auth.users(id) on delete set null,
 granted_at timestamptz not null default now(),
 primary key (company_id, user_id)
);
alter table public.agent_linkers enable row level security;
revoke all on public.agent_linkers from public, anon, authenticated;

-- A pessoa liga fluxos aos clientes: líder, ou liberada e ativa.
create function mavi_private.agent_linker(c uuid) returns boolean
language sql stable security definer set search_path = '' as $$
 select mavi_private.member(c) and (mavi_private.leader(c) or exists (
  select 1 from public.agent_linkers l join public.memberships m on m.company_id = l.company_id
   and m.user_id = l.user_id and m.active
  where l.company_id = c and l.user_id = auth.uid()))
$$;
revoke all on function mavi_private.agent_linker(uuid) from public, anon, authenticated;

-- Ler: quem vê o cliente (regra do Drive); fluxo sem cliente, quem liga.
create or replace function mavi_private.agent_reader(w public.agent_workflows) returns boolean
language sql stable security definer set search_path = '' as $$
 select mavi_private.member(w.company_id) and (mavi_private.leader(w.company_id)
  or (w.client_id is not null and mavi_private.drive_can_read(w.company_id, w.client_id))
  or (w.client_id is null and mavi_private.agent_linker(w.company_id)))
$$;

create or replace function public.agent_list(p_company uuid, p_client uuid default null, p_contract uuid default null,
 p_query text default null, p_unlinked boolean default false) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare q text := lower(btrim(coalesce(p_query, ''))); begin
 if not mavi_private.member(p_company) then raise exception 'Sem acesso.' using errcode = '42501'; end if;
 if coalesce(p_unlinked, false) and not mavi_private.agent_linker(p_company) then
  raise exception 'Você não tem permissão para ligar fluxos aos clientes.' using errcode = '42501';
 end if;
 if length(q) > 200 then q := left(q, 200); end if;
 return coalesce((select jsonb_agg(mavi_private.agent_workflow_json(w, q)
   order by (select k.name from public.clients k where k.id = w.client_id) nulls first,
    case w.role when 'main' then 0 when 'subflow' then 1 else 2 end, w.name, w.id)
  from public.agent_workflows w
  where w.company_id = p_company and w.removed_at is null
   and (case when coalesce(p_unlinked, false) then w.client_id is null
    else w.client_id is not null and mavi_private.agent_reader(w) end)
   and (p_client is null or w.client_id = p_client)
   and (p_contract is null or w.contract_id = p_contract)
   and (q = '' or strpos(lower(w.name), q) > 0
    or strpos(lower(coalesce((select k.name from public.clients k where k.id = w.client_id), '')), q) > 0
    or exists (select 1 from public.agent_prompts p where p.workflow_id = w.id and p.removed_at is null
     and (strpos(lower(p.prompt), q) > 0 or strpos(lower(p.node_name), q) > 0)))), '[]');
end $$;

-- O topo do módulo: o que a pessoa pode (liga fluxos? é líder?) e, para
-- quem liga, quantos estão sem cliente; as VPS só para líderes.
create or replace function public.agent_status(p_company uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_linker boolean; begin
 if not mavi_private.member(p_company) then raise exception 'Sem acesso.' using errcode = '42501'; end if;
 v_linker := mavi_private.agent_linker(p_company);
 if not v_linker then return jsonb_build_object('leader', false, 'linker', false); end if;
 return jsonb_build_object('leader', mavi_private.leader(p_company), 'linker', true,
  'admin', mavi_private.admin(p_company),
  'unlinked', (select count(*) from public.agent_workflows w where w.company_id = p_company
   and w.removed_at is null and w.client_id is null and not w.ignored and w.role <> 'copy'),
  'unlinked_all', (select count(*) from public.agent_workflows w where w.company_id = p_company
   and w.removed_at is null and w.client_id is null))
  || case when mavi_private.leader(p_company) then jsonb_build_object(
   'instances', (select count(*) from public.agent_instances i where i.company_id = p_company),
   'errors', (select count(*) from public.agent_instances i where i.company_id = p_company and i.enabled
    and i.last_error is not null),
   'last_sync_at', (select max(i.last_sync_at) from public.agent_instances i where i.company_id = p_company))
  else '{}' end;
end $$;

create or replace function public.agent_workflow_link(p_workflow uuid, p_client uuid, p_contract uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare w public.agent_workflows := mavi_private.agent_workflow_row(p_workflow); v_old uuid := w.client_id;
 v_old_contract uuid := w.contract_id; begin
 if not mavi_private.agent_linker(w.company_id) then
  raise exception 'Você não tem permissão para ligar fluxos aos clientes.' using errcode = '42501';
 end if;
 if p_client is null and p_contract is not null then raise exception 'Escolha o cliente.' using errcode = '22023'; end if;
 if p_client is not null and not exists (select 1 from public.clients k where k.company_id = w.company_id
  and k.id = p_client) then
  raise exception 'Cliente não encontrado.' using errcode = 'P0002';
 end if;
 -- Quem não é líder liga só a clientes que atende.
 if p_client is not null and not mavi_private.leader(w.company_id)
  and not mavi_private.drive_can_read(w.company_id, p_client) then
  raise exception 'Você só liga fluxos aos clientes que atende.' using errcode = '42501';
 end if;
 if p_contract is not null and not exists (select 1 from public.contracts k where k.company_id = w.company_id
  and k.id = p_contract and k.client_id = p_client) then
  raise exception 'O produto escolhido não é deste cliente.' using errcode = '22023';
 end if;
 update public.agent_workflows set client_id = p_client, contract_id = p_contract, link_source = 'manual',
  linked_by = auth.uid(), linked_at = now(), ignored = case when p_client is not null then false else ignored end
 where id = w.id returning * into w;
 if p_client is not null then perform mavi_private.agent_autolink(w.instance_id); end if;
 perform mavi_private.broadcast(w.company_id, jsonb_build_object('kind', 'agents', 'client', coalesce(p_client, v_old),
  'contract', coalesce(p_contract, v_old_contract), 'workflow', w.id));
 return mavi_private.agent_workflow_json(w, null);
end $$;

create or replace function public.agent_workflow_ignore(p_workflow uuid, p_ignored boolean) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare w public.agent_workflows := mavi_private.agent_workflow_row(p_workflow); begin
 if not mavi_private.agent_linker(w.company_id) then
  raise exception 'Você não tem permissão para ligar fluxos aos clientes.' using errcode = '42501';
 end if;
 update public.agent_workflows set ignored = coalesce(p_ignored, false),
  client_id = case when coalesce(p_ignored, false) then null else client_id end,
  contract_id = case when coalesce(p_ignored, false) then null else contract_id end,
  link_source = 'manual', linked_by = auth.uid(), linked_at = now()
 where id = w.id returning * into w;
 perform mavi_private.broadcast(w.company_id, jsonb_build_object('kind', 'agents', 'workflow', w.id));
 return mavi_private.agent_workflow_json(w, null);
end $$;

-- ------------------------------------------------------------ permissões
-- As pessoas ativas e se ligam fluxos (líderes sempre; os outros, liberados).
create function public.agent_linkers_list(p_company uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$ begin
 if not mavi_private.leader(p_company) then
  raise exception 'Somente administradores e gestores escolhem quem liga os fluxos.' using errcode = '42501';
 end if;
 return coalesce((select jsonb_agg(jsonb_build_object('user_id', m.user_id, 'name', m.name, 'role', m.role,
   'leader', m.role in ('admin', 'manager'),
   'allowed', m.role in ('admin', 'manager') or l.user_id is not null,
   'granted_at', l.granted_at, 'granted_by_name', mavi_private.agent_name(p_company, l.granted_by))
   order by m.role in ('admin', 'manager') desc, m.name, m.user_id)
  from public.memberships m
  left join public.agent_linkers l on l.company_id = m.company_id and l.user_id = m.user_id
  where m.company_id = p_company and m.active), '[]');
end $$;

create function public.agent_linker_set(p_company uuid, p_user uuid, p_allowed boolean) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_role text; begin
 if not mavi_private.leader(p_company) then
  raise exception 'Somente administradores e gestores escolhem quem liga os fluxos.' using errcode = '42501';
 end if;
 select m.role into v_role from public.memberships m where m.company_id = p_company and m.user_id = p_user
  and m.active;
 if v_role is null then raise exception 'Pessoa não encontrada.' using errcode = 'P0002'; end if;
 if v_role in ('admin', 'manager') then
  raise exception 'Administradores e gestores já ligam fluxos aos clientes.' using errcode = '22023';
 end if;
 if coalesce(p_allowed, false) then
  insert into public.agent_linkers(company_id, user_id, granted_by) values (p_company, p_user, auth.uid())
  on conflict (company_id, user_id) do nothing;
 else
  delete from public.agent_linkers where company_id = p_company and user_id = p_user;
 end if;
 perform mavi_private.broadcast(p_company, jsonb_build_object('kind', 'agents'));
 return jsonb_build_object('user_id', p_user, 'allowed', coalesce(p_allowed, false));
end $$;

revoke all on function public.agent_linkers_list(uuid), public.agent_linker_set(uuid, uuid, boolean)
 from public, anon;
grant execute on function public.agent_linkers_list(uuid), public.agent_linker_set(uuid, uuid, boolean)
 to authenticated;

commit;
