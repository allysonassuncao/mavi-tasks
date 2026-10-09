-- Agente Conversacional › Agentes MAVI: o construtor dos agentes que rodam no
-- motor próprio (projeto mavi-agentes, fora deste banco). Os agentes ficam no
-- motor; aqui só a regra de quem vê e quem edita, a mesma dos prompts do n8n
-- (regra do Drive): quem vê o cliente lê; quem edita no Drive o produto do
-- agente edita, testa e publica; líderes sempre.

create or replace function public.agent_builder_access(p_company uuid, p_client uuid, p_contract uuid default null)
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_client public.clients;
  v_leader boolean;
begin
  if not mavi_private.member(p_company) then
    raise exception 'Sem acesso.' using errcode = '42501';
  end if;
  select * into v_client from public.clients where id = p_client and company_id = p_company;
  if v_client.id is null then
    raise exception 'Cliente não encontrado.' using errcode = 'P0002';
  end if;
  if p_contract is not null and not exists (
    select 1 from public.contracts c where c.id = p_contract and c.client_id = p_client and c.company_id = p_company
  ) then
    raise exception 'Produto não encontrado.' using errcode = 'P0002';
  end if;
  v_leader := mavi_private.leader(p_company);
  return jsonb_build_object(
    'read', v_leader or mavi_private.drive_can_read(p_company, p_client),
    'write', v_leader or (p_contract is not null and mavi_private.drive_can_write(p_company, p_client, p_contract)),
    'leader', v_leader,
    'client_name', v_client.name,
    'user_id', auth.uid(),
    'user_label', coalesce(auth.jwt() ->> 'email', auth.uid()::text)
  );
end $$;

-- Os clientes cujos agentes a pessoa vê (líderes: todos).
create or replace function public.agent_builder_clients(p_company uuid)
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  if not mavi_private.member(p_company) then
    raise exception 'Sem acesso.' using errcode = '42501';
  end if;
  if mavi_private.leader(p_company) then
    return jsonb_build_object('all', true, 'leader', true, 'clients', '[]'::jsonb);
  end if;
  return jsonb_build_object(
    'all', false,
    'leader', false,
    'clients', coalesce((
      select jsonb_agg(k.id)
      from public.clients k
      where k.company_id = p_company and mavi_private.drive_can_read(p_company, k.id)
    ), '[]'::jsonb)
  );
end $$;

revoke all on function public.agent_builder_access(uuid, uuid, uuid), public.agent_builder_clients(uuid) from public, anon;
grant execute on function public.agent_builder_access(uuid, uuid, uuid), public.agent_builder_clients(uuid) to authenticated;
