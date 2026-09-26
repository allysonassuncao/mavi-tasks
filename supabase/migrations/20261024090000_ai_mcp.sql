begin;

-- IA do MAVI · fase 4: servidor MCP (Claude, ChatGPT e outros clientes de IA
-- usando a base de conhecimento do MAVI com o login de cada pessoa).
--
-- O login é o OAuth 2.1 do Supabase Auth: o token que o cliente de IA recebe
-- é um token da própria pessoa, e o servidor MCP (/api/mcp) o repassa ao
-- banco — as permissões são as de sempre (RLS e as funções da IA). Aqui fica
-- só quem pode usar: um módulo por pessoa, liberado por padrão para
-- administradores e gestores; colaboradores, só se um administrador liberar.
-- Desligar vale na hora, mesmo para apps já conectados.

-- "Consumo de IA" (fase 2) também pode ser escondido pelo administrador.
alter table public.memberships drop constraint if exists memberships_hidden_pages_check;
alter table public.memberships add constraint memberships_hidden_pages_check
 check (hidden_pages <@ array['overview','tasks','agenda','clients','products','projects','campaigns','hours',
  'reports','drive','storage','dashboards','onboarding','aiUsage']::text[]);

create or replace function public.set_member_pages(p_company uuid, p_user uuid, p_hidden text[]) returns void
language plpgsql security definer set search_path = '' as $$
declare v text[]; begin
 if not mavi_private.admin(p_company) then
  raise exception 'Somente administradores escolhem os módulos de cada pessoa.' using errcode = '42501';
 end if;
 if not exists (select 1 from public.memberships where company_id = p_company and user_id = p_user) then
  raise exception 'Usuário não encontrado na empresa';
 end if;
 select coalesce(array_agg(distinct x order by x), '{}') into v from unnest(coalesce(p_hidden, '{}')) x;
 if not v <@ array['overview','tasks','agenda','clients','products','projects','campaigns','hours',
  'reports','drive','storage','dashboards','onboarding','aiUsage']::text[] then
  raise exception 'Módulo inválido' using errcode = '22023';
 end if;
 update public.memberships set hidden_pages = v where company_id = p_company and user_id = p_user
  and hidden_pages is distinct from v;
end $$;

-- 'default': liberado para administradores e gestores; 'on'/'off': escolha
-- de um administrador.
alter table public.memberships add column mcp_access text not null default 'default'
 check (mcp_access in ('default', 'on', 'off'));

create function mavi_private.mcp_allowed(c uuid) returns boolean
language sql stable security definer set search_path = '' as $$
 select exists (select 1 from public.memberships m where m.company_id = c and m.user_id = auth.uid() and m.active
  and (m.mcp_access = 'on' or (m.mcp_access = 'default' and m.role in ('admin', 'manager'))))
$$;
revoke all on function mavi_private.mcp_allowed(uuid) from public, anon;
grant execute on function mavi_private.mcp_allowed(uuid) to authenticated;

-- As empresas em que a pessoa pode usar o MCP (o servidor escolhe por aqui).
create function public.mcp_workspaces() returns table(company_id uuid, name text, role text, allowed boolean)
language sql stable security definer set search_path = '' as $$
 select m.company_id, c.name, m.role, mavi_private.mcp_allowed(m.company_id)
 from public.memberships m join public.companies c on c.id = m.company_id
 where m.user_id = auth.uid() and m.active
 order by c.name
$$;
revoke all on function public.mcp_workspaces() from public, anon;
grant execute on function public.mcp_workspaces() to authenticated;

create function public.set_member_mcp(p_company uuid, p_user uuid, p_access text) returns void
language plpgsql security definer set search_path = '' as $$ begin
 if not mavi_private.admin(p_company) then
  raise exception 'Somente administradores liberam o MCP para cada pessoa.' using errcode = '42501';
 end if;
 if p_access not in ('default', 'on', 'off') then raise exception 'Opção inválida' using errcode = '22023'; end if;
 update public.memberships set mcp_access = p_access where company_id = p_company and user_id = p_user;
 if not found then raise exception 'Usuário não encontrado na empresa'; end if;
end $$;
revoke all on function public.set_member_mcp(uuid, uuid, text) from public, anon;
grant execute on function public.set_member_mcp(uuid, uuid, text) to authenticated;

-- O uso pelo MCP entra no Consumo de IA como módulo "mcp", e só vale para
-- quem pode usar o MCP naquela empresa.
create or replace function public.ai_log_usage(p_company uuid, p_module text, p_kind text, p_client uuid, p_contract uuid,
 p_project uuid, p_recording uuid, p_model text, p_input integer, p_output integer, p_cache_read integer,
 p_cache_write integer, p_embedding integer, p_cost numeric) returns void
language plpgsql security definer set search_path = '' as $$ begin
 if not mavi_private.member(p_company) then raise exception 'Sem permissão.' using errcode = '42501'; end if;
 if p_client is not null and not mavi_private.drive_can_read(p_company, p_client) then
  raise exception 'Sem permissão.' using errcode = '42501';
 end if;
 if p_module = 'mcp' and not mavi_private.mcp_allowed(p_company) then
  raise exception 'Sem permissão.' using errcode = '42501';
 end if;
 if p_cost is null or p_cost < 0 or p_cost > 100 then raise exception 'Custo inválido.' using errcode = '22023'; end if;
 insert into public.ai_usage(company_id, module, kind, client_id, contract_id, project_id, recording_id, model,
  input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, embedding_tokens, cost_usd)
 values (p_company, left(coalesce(p_module, ''), 40), left(coalesce(p_kind, ''), 40), p_client, p_contract,
  p_project, p_recording, left(coalesce(p_model, ''), 80), greatest(coalesce(p_input, 0), 0),
  greatest(coalesce(p_output, 0), 0), greatest(coalesce(p_cache_read, 0), 0),
  greatest(coalesce(p_cache_write, 0), 0), greatest(coalesce(p_embedding, 0), 0), p_cost);
end $$;

commit;
