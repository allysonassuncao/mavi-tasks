begin;

-- Agente Conversacional: o assistente de WhatsApp que a agência vende aos
-- clientes (o produto "MAVI") roda em fluxos do n8n, em VPS da agência. Aqui
-- o MAVI Tasks lê o prompt de sistema de cada nó "AI Agent" desses fluxos,
-- guarda as versões e publica as edições de volta no n8n.
--
--  - VPS (agent_instances): endereço + chave da API do n8n, cadastrados por
--    um administrador. A chave fica cifrada pelo servidor (AI_PROVIDER_KEY,
--    a mesma dos provedores de IA); o banco só guarda o valor cifrado.
--  - Fluxos (agent_workflows): só os que têm nó AI Agent. Papel calculado na
--    leitura: 'main' (ativo), 'subflow' (chamado por um fluxo ativo, direto
--    ou por outro subfluxo) ou 'copy' (backups e versões antigas, parados e
--    sem ninguém chamando). Cada fluxo é ligado a um cliente (e ao produto
--    contratado dele, normalmente o "MAVI"): sozinho pelo nome do fluxo, o
--    subfluxo herda do fluxo que o chama, e um líder corrige ou ignora.
--  - Prompts (agent_prompts): um por nó AI Agent, com a ficha técnica
--    (modelo, ferramentas, memória). Cada texto diferente vira uma versão
--    (agent_prompt_versions, imutável): a que veio do n8n ou a publicada aqui.
--
-- Acesso: a regra do Drive. Quem vê o cliente lê; quem edita no Drive o
-- produto do cliente edita (publica no n8n). Fluxo sem cliente: só líderes.
-- A leitura a cada 1h é do servidor para o n8n (pg_cron chama /api/ai com o
-- AI_WORKER_SECRET, como a indexação da MAVI); o navegador só recebe avisos.
-- Os prompts dos fluxos principais e subfluxos ligados a um cliente entram
-- na base da MAVI (fonte 'agent_prompt'); as cópias ficam de fora.

-- ------------------------------------------------------------ tabelas
create table public.agent_instances (
 id uuid primary key default gen_random_uuid(),
 company_id uuid not null references public.companies(id) on delete cascade,
 name text not null check (length(btrim(name)) between 1 and 80),
 base_url text not null check (base_url ~ '^https://[^/?#@\s]+(/[^?#\s]*)?$' and length(base_url) <= 300),
 key_cipher text not null check (key_cipher ~ '^v1:[A-Za-z0-9+/=]+$' and length(key_cipher) <= 8000),
 key_hint text not null default '' check (length(key_hint) <= 12),
 enabled boolean not null default true,
 -- A última leitura completa que deu certo, a última tentativa e o erro dela.
 last_sync_at timestamptz,
 last_attempt_at timestamptz,
 last_error text check (length(last_error) <= 1000),
 last_stats jsonb not null default '{}',
 -- Uma leitura por vez (o servidor pega, guarda e solta).
 claimed_at timestamptz,
 created_by uuid references auth.users(id) on delete set null,
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 unique (company_id, id)
);
alter table public.agent_instances enable row level security;
revoke all on public.agent_instances from public, anon, authenticated;

create table public.agent_workflows (
 id uuid primary key default gen_random_uuid(),
 company_id uuid not null,
 instance_id uuid not null,
 n8n_id text not null check (length(n8n_id) between 1 and 64),
 name text not null default '' check (length(name) <= 300),
 active boolean not null default false,
 archived boolean not null default false,
 role text not null default 'copy' check (role in ('main', 'subflow', 'copy')),
 -- Os fluxos vivos que chamam este ([{id, name}], ids do n8n).
 called_by jsonb not null default '[]' check (jsonb_typeof(called_by) = 'array'),
 n8n_version_id text check (length(n8n_version_id) <= 64),
 n8n_updated_at timestamptz,
 client_id uuid,
 contract_id uuid,
 -- Quem ligou ao cliente: 'auto' (pelo nome ou pelo fluxo que chama) ou
 -- 'manual' (um líder; também quando desliga, para não religar sozinho).
 link_source text check (link_source in ('auto', 'manual')),
 linked_by uuid references auth.users(id) on delete set null,
 linked_at timestamptz,
 -- Fluxo que não é de cliente (interno): fora da lista "Sem cliente".
 ignored boolean not null default false,
 -- Sumiu do n8n (apagado): some das listas, o histórico fica.
 removed_at timestamptz,
 created_at timestamptz not null default now(),
 unique (instance_id, n8n_id),
 unique (company_id, id),
 foreign key (company_id, instance_id) references public.agent_instances(company_id, id) on delete cascade,
 foreign key (company_id, client_id) references public.clients(company_id, id) on delete set null (client_id),
 foreign key (company_id, contract_id) references public.contracts(company_id, id) on delete set null (contract_id),
 check (contract_id is null or client_id is not null)
);
create index agent_workflows_client on public.agent_workflows(company_id, client_id, contract_id);
alter table public.agent_workflows enable row level security;
revoke all on public.agent_workflows from public, anon, authenticated;

create table public.agent_prompts (
 id uuid primary key default gen_random_uuid(),
 company_id uuid not null,
 workflow_id uuid not null,
 node_id text not null check (length(node_id) between 1 and 64),
 node_name text not null default '' check (length(node_name) <= 300),
 node_type text not null default '' check (length(node_type) <= 200),
 prompt text not null default '' check (length(prompt) <= 200000),
 -- O texto é uma expressão do n8n ("=" na frente, com {{ }}): publicar
 -- mantém o "=".
 expression boolean not null default false,
 -- A ficha técnica: {model, model_node, tools: [..], memory, disabled}.
 setup jsonb not null default '{}' check (jsonb_typeof(setup) = 'object'),
 version integer not null default 1 check (version >= 1),
 -- Quando o texto mudou pela última vez e quem publicou (null = no n8n).
 changed_at timestamptz not null default now(),
 changed_by uuid references auth.users(id) on delete set null,
 -- O nó saiu do fluxo.
 removed_at timestamptz,
 created_at timestamptz not null default now(),
 unique (workflow_id, node_id),
 unique (company_id, id),
 foreign key (company_id, workflow_id) references public.agent_workflows(company_id, id) on delete cascade
);
alter table public.agent_prompts enable row level security;
revoke all on public.agent_prompts from public, anon, authenticated;

create table public.agent_prompt_versions (
 id uuid primary key default gen_random_uuid(),
 company_id uuid not null,
 prompt_id uuid not null,
 version integer not null check (version >= 1),
 prompt text not null,
 expression boolean not null default false,
 -- 'first': o texto quando o fluxo foi lido a 1ª vez; 'n8n': mudou direto no
 -- n8n; 'edit': publicado aqui; 'restore': uma versão antiga publicada de novo.
 source text not null check (source in ('first', 'n8n', 'edit', 'restore')),
 restored_from integer,
 note text not null default '' check (length(note) <= 500),
 saved_by uuid references auth.users(id) on delete set null,
 saved_at timestamptz not null default now(),
 n8n_version_id text,
 unique (prompt_id, version),
 foreign key (company_id, prompt_id) references public.agent_prompts(company_id, id) on delete cascade
);
alter table public.agent_prompt_versions enable row level security;
revoke all on public.agent_prompt_versions from public, anon, authenticated;

create function mavi_private.agent_immutable() returns trigger
language plpgsql set search_path = '' as $$ begin
 raise exception 'O histórico dos prompts não pode ser alterado.';
end $$;
revoke all on function mavi_private.agent_immutable() from public, anon, authenticated;
create trigger agent_prompt_versions_immutable before update on public.agent_prompt_versions
 for each row execute function mavi_private.agent_immutable();

-- ------------------------------------------------------------ acesso
-- Ler: quem vê o cliente (regra do Drive); fluxo sem cliente, só líderes.
create function mavi_private.agent_reader(w public.agent_workflows) returns boolean
language sql stable security definer set search_path = '' as $$
 select mavi_private.member(w.company_id) and (mavi_private.leader(w.company_id)
  or (w.client_id is not null and mavi_private.drive_can_read(w.company_id, w.client_id)))
$$;
-- Publicar: quem edita no Drive o produto do cliente (líderes sempre).
create function mavi_private.agent_writer(w public.agent_workflows) returns boolean
language sql stable security definer set search_path = '' as $$
 select mavi_private.member(w.company_id) and (mavi_private.leader(w.company_id)
  or (w.client_id is not null and mavi_private.drive_can_write(w.company_id, w.client_id, w.contract_id)))
$$;
revoke all on function mavi_private.agent_reader(public.agent_workflows),
 mavi_private.agent_writer(public.agent_workflows) from public, anon, authenticated;

create function mavi_private.agent_workflow_row(p_workflow uuid) returns public.agent_workflows
language plpgsql stable security definer set search_path = '' as $$
declare w public.agent_workflows; begin
 select * into w from public.agent_workflows where id = p_workflow;
 if w.id is null or not mavi_private.agent_reader(w) then
  raise exception 'Fluxo não encontrado.' using errcode = 'P0002';
 end if;
 return w;
end $$;
create function mavi_private.agent_prompt_row(p_prompt uuid) returns public.agent_prompts
language plpgsql stable security definer set search_path = '' as $$
declare p public.agent_prompts; begin
 select * into p from public.agent_prompts where id = p_prompt;
 if p.id is null then raise exception 'Prompt não encontrado.' using errcode = 'P0002'; end if;
 perform mavi_private.agent_workflow_row(p.workflow_id);
 return p;
end $$;
revoke all on function mavi_private.agent_workflow_row(uuid), mavi_private.agent_prompt_row(uuid)
 from public, anon, authenticated;

-- O agendamento (o segredo da MAVI) ou um administrador da empresa.
create function mavi_private.agent_sync_allowed(p_secret text, c uuid) returns boolean
language sql stable security definer set search_path = '' as $$
 select mavi_private.ai_secret_ok(p_secret) or (c is not null and mavi_private.admin(c))
$$;
revoke all on function mavi_private.agent_sync_allowed(text, uuid) from public, anon, authenticated;

create function mavi_private.agent_name(c uuid, u uuid) returns text
language sql stable security definer set search_path = '' as $$
 select m.name from public.memberships m where m.company_id = c and m.user_id = u
$$;
revoke all on function mavi_private.agent_name(uuid, uuid) from public, anon, authenticated;

-- ------------------------------------------------------------ VPS
-- Líderes veem as VPS e como foi a última leitura (nunca a chave).
create function public.agent_instances_list(p_company uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$ begin
 if not mavi_private.leader(p_company) then
  raise exception 'Somente administradores e gestores veem as VPS.' using errcode = '42501';
 end if;
 return coalesce((select jsonb_agg(jsonb_build_object('id', i.id, 'name', i.name, 'base_url', i.base_url,
   'key_hint', i.key_hint, 'enabled', i.enabled, 'last_sync_at', i.last_sync_at,
   'last_attempt_at', i.last_attempt_at, 'last_error', i.last_error, 'last_stats', i.last_stats,
   'syncing', coalesce(i.claimed_at > now() - interval '10 minutes', false),
   'workflows', (select count(*) from public.agent_workflows w where w.instance_id = i.id and w.removed_at is null),
   'created_at', i.created_at) order by i.created_at, i.id)
  from public.agent_instances i where i.company_id = p_company), '[]');
end $$;

-- Chamada pelo servidor (api/_agents), com o login de um administrador: ele
-- cifra a chave; p_key_cipher nulo ao editar mantém a chave guardada.
create function public.agent_instance_save(p_company uuid, p_id uuid, p_name text, p_base_url text,
 p_key_cipher text, p_key_hint text, p_enabled boolean) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_name text := btrim(regexp_replace(coalesce(p_name, ''), '[\x00-\x1f]+', ' ', 'g'));
 v_url text := regexp_replace(btrim(coalesce(p_base_url, '')), '/+$', ''); i public.agent_instances; begin
 if not mavi_private.admin(p_company) then
  raise exception 'Somente administradores cadastram as VPS do n8n.' using errcode = '42501';
 end if;
 if length(v_name) = 0 or length(v_name) > 80 then
  raise exception 'Dê um nome à VPS (até 80 caracteres).' using errcode = '22023';
 end if;
 if v_url !~ '^https://[^/?#@\s]+(/[^?#\s]*)?$' or length(v_url) > 300 then
  raise exception 'Endereço inválido: use https://… (o endereço do n8n, sem /api).' using errcode = '22023';
 end if;
 if p_key_cipher is not null and p_key_cipher !~ '^v1:[A-Za-z0-9+/=]+$' then
  raise exception 'Chave inválida.' using errcode = '22023';
 end if;
 if p_id is null then
  if p_key_cipher is null then raise exception 'Informe a chave da API do n8n.' using errcode = '22023'; end if;
  insert into public.agent_instances(company_id, name, base_url, key_cipher, key_hint, enabled, created_by)
  values (p_company, v_name, v_url, p_key_cipher, left(coalesce(p_key_hint, ''), 12), coalesce(p_enabled, true), auth.uid())
  returning * into i;
 else
  update public.agent_instances set name = v_name, base_url = v_url,
   key_cipher = coalesce(p_key_cipher, key_cipher),
   key_hint = case when p_key_cipher is null then key_hint else left(coalesce(p_key_hint, ''), 12) end,
   enabled = coalesce(p_enabled, enabled), updated_at = now(),
   -- Endereço ou chave novos: lê de novo na próxima volta.
   last_attempt_at = case when p_key_cipher is not null or v_url <> base_url then null else last_attempt_at end
  where company_id = p_company and id = p_id returning * into i;
  if i.id is null then raise exception 'VPS não encontrada.' using errcode = 'P0002'; end if;
 end if;
 return jsonb_build_object('id', i.id, 'name', i.name, 'base_url', i.base_url, 'key_hint', i.key_hint,
  'enabled', i.enabled);
end $$;

-- Apagar a VPS apaga os fluxos, prompts e versões dela (e tira da MAVI).
create function public.agent_instance_delete(p_company uuid, p_id uuid) returns void
language plpgsql security definer set search_path = '' as $$ begin
 if not mavi_private.admin(p_company) then
  raise exception 'Somente administradores removem as VPS do n8n.' using errcode = '42501';
 end if;
 delete from public.agent_instances where company_id = p_company and id = p_id;
 perform mavi_private.broadcast(p_company, jsonb_build_object('kind', 'agents'));
end $$;

-- A chave cifrada da VPS, para o servidor testar a conexão (administrador).
create function public.agent_instance_secret(p_company uuid, p_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare i public.agent_instances; begin
 if not mavi_private.admin(p_company) then
  raise exception 'Somente administradores.' using errcode = '42501';
 end if;
 select * into i from public.agent_instances where company_id = p_company and id = p_id;
 if i.id is null then raise exception 'VPS não encontrada.' using errcode = 'P0002'; end if;
 return jsonb_build_object('id', i.id, 'base_url', i.base_url, 'key_cipher', i.key_cipher);
end $$;

-- ------------------------------------------------------------ leitura do n8n
-- As VPS a ler agora, com a chave cifrada (inútil sem a chave do servidor) e
-- a versão de cada fluxo já guardado (os iguais não são reenviados). Pelo
-- agendamento: as que passaram de 1h da última tentativa. Um administrador
-- (Sincronizar agora): a VPS pedida, ou todas da empresa.
create function public.agent_sync_targets(p_secret text, p_company uuid default null, p_instance uuid default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_ids uuid[]; begin
 if not mavi_private.agent_sync_allowed(p_secret, p_company) then
  raise exception 'Sem permissão.' using errcode = '42501';
 end if;
 if mavi_private.ai_secret_ok(p_secret) then
  select coalesce(array_agg(i.id), '{}') into v_ids from public.agent_instances i
  where i.enabled and (i.last_attempt_at is null or i.last_attempt_at < now() - interval '55 minutes')
   and (i.claimed_at is null or i.claimed_at < now() - interval '10 minutes');
 else
  select coalesce(array_agg(i.id), '{}') into v_ids from public.agent_instances i
  where i.company_id = p_company and (p_instance is null or i.id = p_instance)
   and (p_instance is not null or i.enabled)
   and (i.claimed_at is null or i.claimed_at < now() - interval '2 minutes');
  if p_instance is not null and cardinality(v_ids) = 0 then
   raise exception 'Esta VPS já está sendo lida agora. Tente de novo em alguns minutos.' using errcode = '55P03';
  end if;
 end if;
 update public.agent_instances set claimed_at = now() where id = any(v_ids);
 return coalesce((select jsonb_agg(jsonb_build_object('id', i.id, 'company_id', i.company_id, 'name', i.name,
   'base_url', i.base_url, 'key_cipher', i.key_cipher,
   'known', coalesce((select jsonb_object_agg(w.n8n_id, coalesce(w.n8n_version_id, '')) from public.agent_workflows w
    where w.instance_id = i.id and w.removed_at is null), '{}')))
  from public.agent_instances i where i.id = any(v_ids)), '[]');
end $$;

-- Nome comparável: minúsculo, sem acento, só letras e números separados por
-- um espaço, com espaço nas pontas (para achar palavras inteiras).
create function mavi_private.agent_norm(p text) returns text
language sql immutable parallel safe set search_path = '' as $$
 select ' ' || btrim(regexp_replace(lower(translate(coalesce(p, ''),
  'ÁÀÂÃÄÉÈÊËÍÌÎÏÓÒÔÕÖÚÙÛÜÇÑáàâãäéèêëíìîïóòôõöúùûüçñ',
  'AAAAAEEEEIIIIOOOOOUUUUCNaaaaaeeeeiiiiooooouuuucn')), '[^a-z0-9]+', ' ', 'g')) || ' '
$$;
revoke all on function mavi_private.agent_norm(text) from public, anon, authenticated;

-- O produto do cliente onde o agente mora: o contrato aberto do produto
-- "MAVI"; havendo só um contrato aberto, ele.
create function mavi_private.agent_contract_for(c uuid, p_client uuid) returns uuid
language sql stable security definer set search_path = '' as $$
 select coalesce(
  (select case when count(*) = 1 then (array_agg(k.id))[1] end from public.contracts k
   join public.products p on p.company_id = k.company_id and p.id = k.product_id
   where k.company_id = c and k.client_id = p_client and not k.archived
    and mavi_private.agent_norm(p.name) = ' mavi '),
  (select case when count(*) = 1 then (array_agg(k.id))[1] end from public.contracts k
   where k.company_id = c and k.client_id = p_client and not k.archived))
$$;
revoke all on function mavi_private.agent_contract_for(uuid, uuid) from public, anon, authenticated;

-- Liga sozinho os fluxos sem cliente (nunca os ligados ou desligados à mão,
-- nem os ignorados): primeiro pelo cliente cujo nome aparece inteiro no nome
-- do fluxo (o nome mais longo; empate não liga); depois o subfluxo herda o
-- cliente do fluxo que o chama.
create function mavi_private.agent_autolink(p_instance uuid) returns integer
language plpgsql security definer set search_path = '' as $$
declare r record; v_client uuid; v_contract uuid; n integer := 0; v_round integer; v_rows integer; begin
 for r in select w.* from public.agent_workflows w
  where w.instance_id = p_instance and w.client_id is null and w.link_source is null and not w.ignored
   and w.removed_at is null loop
  select x.id into v_client from (
   select k.id, length(mavi_private.agent_norm(k.name)) as len,
    max(length(mavi_private.agent_norm(k.name))) over () as top,
    count(*) over (partition by length(mavi_private.agent_norm(k.name))) as same
   from public.clients k
   where k.company_id = r.company_id and not k.archived
    and length(mavi_private.agent_norm(k.name)) >= 5
    and position(mavi_private.agent_norm(k.name) in mavi_private.agent_norm(r.name)) > 0) x
  where x.len = x.top and x.same = 1;
  if v_client is not null then
   v_contract := mavi_private.agent_contract_for(r.company_id, v_client);
   update public.agent_workflows set client_id = v_client, contract_id = v_contract, link_source = 'auto',
    linked_at = now() where id = r.id;
   n := n + 1;
  end if;
  v_client := null;
 end loop;
 -- Depois os subfluxos: em voltas, para alcançar o subfluxo de um subfluxo.
 for v_round in 1..5 loop
  with heirs as (
   select distinct on (w.id) w.id, p.client_id, p.contract_id
   from public.agent_workflows w
   join lateral jsonb_array_elements(w.called_by) cb on true
   join public.agent_workflows p on p.instance_id = w.instance_id and p.n8n_id = cb->>'id'
    and p.client_id is not null and p.removed_at is null
   where w.instance_id = p_instance and w.client_id is null and w.link_source is null and not w.ignored
    and w.removed_at is null
   order by w.id, p.role = 'main' desc, p.link_source = 'manual' desc, p.n8n_id)
  update public.agent_workflows w set client_id = h.client_id, contract_id = h.contract_id,
   link_source = 'auto', linked_at = now()
  from heirs h where w.id = h.id;
  get diagnostics v_rows = row_count;
  n := n + v_rows;
  exit when v_rows = 0;
 end loop;
 return n;
end $$;
revoke all on function mavi_private.agent_autolink(uuid) from public, anon, authenticated;

-- Guarda um fluxo lido do n8n. p: {n8n_id, name, active, archived, role?,
-- called_by?, version_id, updated_at, nodes?: [{node_id, node_name,
-- node_type, prompt, expression, setup}]}. Sem nodes: o fluxo não mudou
-- desde a última leitura (só nome/estado/papel). Devolve se algo mudou.
create function mavi_private.agent_store_workflow(i public.agent_instances, p jsonb, p_user uuid) returns boolean
language plpgsql security definer set search_path = '' as $$
declare w public.agent_workflows; v_new public.agent_workflows; n jsonb; pr public.agent_prompts;
 v_changed boolean := false; v_ids text[] := '{}'; v_text text; v_expr boolean; v_first boolean; begin
 if coalesce(p->>'n8n_id', '') = '' then return false; end if;
 select * into w from public.agent_workflows where instance_id = i.id and n8n_id = p->>'n8n_id' for update;
 v_first := w.id is null;
 if v_first then
  insert into public.agent_workflows(company_id, instance_id, n8n_id, name, active, archived, role, called_by,
   n8n_version_id, n8n_updated_at)
  values (i.company_id, i.id, p->>'n8n_id', left(coalesce(p->>'name', ''), 300), coalesce((p->>'active')::boolean, false),
   coalesce((p->>'archived')::boolean, false), coalesce(p->>'role', 'copy'), coalesce(p->'called_by', '[]'),
   nullif(p->>'version_id', ''), (p->>'updated_at')::timestamptz)
  returning * into w;
  v_changed := true;
 else
  update public.agent_workflows set name = left(coalesce(p->>'name', name), 300),
   active = coalesce((p->>'active')::boolean, active), archived = coalesce((p->>'archived')::boolean, archived),
   role = coalesce(p->>'role', role), called_by = coalesce(p->'called_by', called_by),
   n8n_version_id = coalesce(nullif(p->>'version_id', ''), n8n_version_id),
   n8n_updated_at = coalesce((p->>'updated_at')::timestamptz, n8n_updated_at), removed_at = null
  where id = w.id and (name, active, archived, role, called_by, n8n_version_id, n8n_updated_at, removed_at)
   is distinct from (left(coalesce(p->>'name', name), 300), coalesce((p->>'active')::boolean, active),
    coalesce((p->>'archived')::boolean, archived), coalesce(p->>'role', role), coalesce(p->'called_by', called_by),
    coalesce(nullif(p->>'version_id', ''), n8n_version_id), coalesce((p->>'updated_at')::timestamptz, n8n_updated_at),
    null::timestamptz)
  returning * into v_new;
  if v_new.id is not null then v_changed := true; w := v_new; end if;
 end if;
 if jsonb_typeof(p->'nodes') is distinct from 'array' then return v_changed; end if;
 for n in select value from jsonb_array_elements(p->'nodes') limit 50 loop
  continue when coalesce(n->>'node_id', '') = '';
  v_ids := v_ids || (n->>'node_id');
  v_text := left(coalesce(n->>'prompt', ''), 200000);
  v_expr := coalesce((n->>'expression')::boolean, false);
  select * into pr from public.agent_prompts where workflow_id = w.id and node_id = n->>'node_id' for update;
  if pr.id is null then
   insert into public.agent_prompts(company_id, workflow_id, node_id, node_name, node_type, prompt, expression, setup)
   values (w.company_id, w.id, n->>'node_id', left(coalesce(n->>'node_name', ''), 300),
    left(coalesce(n->>'node_type', ''), 200), v_text, v_expr,
    case when jsonb_typeof(n->'setup') = 'object' then n->'setup' else '{}' end)
   returning * into pr;
   insert into public.agent_prompt_versions(company_id, prompt_id, version, prompt, expression, source, saved_by,
    n8n_version_id)
   values (pr.company_id, pr.id, 1, v_text, v_expr, 'first', null, nullif(p->>'version_id', ''));
   v_changed := true;
  elsif pr.prompt is distinct from v_text or pr.expression is distinct from v_expr then
   update public.agent_prompts set prompt = v_text, expression = v_expr, version = pr.version + 1,
    changed_at = now(), changed_by = p_user, removed_at = null,
    node_name = left(coalesce(n->>'node_name', node_name), 300), node_type = left(coalesce(n->>'node_type', node_type), 200),
    setup = case when jsonb_typeof(n->'setup') = 'object' then n->'setup' else setup end
   where id = pr.id;
   insert into public.agent_prompt_versions(company_id, prompt_id, version, prompt, expression, source, saved_by,
    n8n_version_id)
   values (pr.company_id, pr.id, pr.version + 1, v_text, v_expr, 'n8n', null, nullif(p->>'version_id', ''));
   v_changed := true;
  else
   update public.agent_prompts set removed_at = null,
    node_name = left(coalesce(n->>'node_name', node_name), 300), node_type = left(coalesce(n->>'node_type', node_type), 200),
    setup = case when jsonb_typeof(n->'setup') = 'object' then n->'setup' else setup end
   where id = pr.id and (removed_at, node_name, node_type, setup) is distinct from (null::timestamptz,
    left(coalesce(n->>'node_name', node_name), 300), left(coalesce(n->>'node_type', node_type), 200),
    case when jsonb_typeof(n->'setup') = 'object' then n->'setup' else setup end);
   if found then v_changed := true; end if;
  end if;
  pr := null;
 end loop;
 update public.agent_prompts set removed_at = now()
 where workflow_id = w.id and removed_at is null and not node_id = any(v_ids);
 if found then v_changed := true; end if;
 return v_changed;
end $$;
revoke all on function mavi_private.agent_store_workflow(public.agent_instances, jsonb, uuid)
 from public, anon, authenticated;

-- O resultado da leitura de uma VPS (agendamento ou administrador). Com
-- p_error: só registra a falha. p_complete: a lista é a VPS inteira — os
-- fluxos que não vieram foram apagados no n8n.
create function public.agent_sync_store(p_secret text, p_instance uuid, p_workflows jsonb, p_complete boolean,
 p_error text, p_stats jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare i public.agent_instances; x jsonb; v_changed integer := 0; v_removed integer := 0; v_linked integer := 0;
 v_ids text[] := '{}'; begin
 select * into i from public.agent_instances where id = p_instance;
 if i.id is null or not mavi_private.agent_sync_allowed(p_secret, i.company_id) then
  raise exception 'Sem permissão.' using errcode = '42501';
 end if;
 if p_error is not null then
  update public.agent_instances set last_attempt_at = now(), last_error = left(p_error, 1000), claimed_at = null
  where id = i.id;
  return jsonb_build_object('error', true);
 end if;
 if jsonb_typeof(p_workflows) is distinct from 'array' then raise exception 'Lista inválida.' using errcode = '22023'; end if;
 for x in select value from jsonb_array_elements(p_workflows) loop
  v_ids := v_ids || coalesce(x->>'n8n_id', '');
  if mavi_private.agent_store_workflow(i, x, null) then v_changed := v_changed + 1; end if;
 end loop;
 if coalesce(p_complete, false) then
  update public.agent_workflows set removed_at = now()
  where instance_id = i.id and removed_at is null and not n8n_id = any(v_ids);
  get diagnostics v_removed = row_count;
 end if;
 v_linked := mavi_private.agent_autolink(i.id);
 update public.agent_instances set last_attempt_at = now(), claimed_at = null,
  last_sync_at = case when coalesce(p_complete, false) then now() else last_sync_at end,
  last_error = case when coalesce(p_complete, false) then null else last_error end,
  last_stats = case when jsonb_typeof(p_stats) = 'object' then p_stats else last_stats end
 where id = i.id;
 if v_changed + v_removed + v_linked > 0 then
  perform mavi_private.broadcast(i.company_id, jsonb_build_object('kind', 'agents'));
 end if;
 return jsonb_build_object('changed', v_changed, 'removed', v_removed, 'linked', v_linked);
end $$;

-- ------------------------------------------------------------ um fluxo
-- O que o servidor precisa para reler um fluxo (Atualizar) ou publicar um
-- prompt: a VPS e a chave cifrada. Quem lê o fluxo.
create function public.agent_workflow_target(p_workflow uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare w public.agent_workflows := mavi_private.agent_workflow_row(p_workflow); i public.agent_instances; begin
 select * into i from public.agent_instances where id = w.instance_id;
 return jsonb_build_object('workflow', w.id, 'n8n_id', w.n8n_id, 'instance', i.id, 'base_url', i.base_url,
  'key_cipher', i.key_cipher);
end $$;

-- Guarda o fluxo relido (Atualizar): mesmo formato de agent_sync_store.
create function public.agent_workflow_store(p_workflow uuid, p_data jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare w public.agent_workflows := mavi_private.agent_workflow_row(p_workflow); i public.agent_instances;
 v_changed boolean; begin
 select * into i from public.agent_instances where id = w.instance_id;
 if p_data->>'n8n_id' is distinct from w.n8n_id then raise exception 'Fluxo diferente.' using errcode = '22023'; end if;
 -- O papel e quem chama dependem da VPS inteira: ficam os da última leitura.
 v_changed := mavi_private.agent_store_workflow(i, p_data - 'role' - 'called_by', null);
 if v_changed then
  perform mavi_private.broadcast(w.company_id, jsonb_build_object('kind', 'agents', 'client', w.client_id,
   'contract', w.contract_id, 'workflow', w.id));
 end if;
 return jsonb_build_object('changed', v_changed);
end $$;

-- Antes de publicar: confere quem publica e a versão que a pessoa abriu.
-- Devolve o necessário para o servidor reler o fluxo no n8n e trocar só o
-- texto deste nó (e o texto guardado, para ver se mudou direto no n8n).
create function public.agent_prompt_edit_target(p_prompt uuid, p_base integer) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare p public.agent_prompts := mavi_private.agent_prompt_row(p_prompt); w public.agent_workflows;
 i public.agent_instances; v_who text; begin
 select * into w from public.agent_workflows where id = p.workflow_id;
 if not mavi_private.agent_writer(w) then
  raise exception 'Você não pode editar o agente deste cliente.' using errcode = '42501';
 end if;
 if w.removed_at is not null or p.removed_at is not null then
  raise exception 'Este nó não existe mais no n8n.' using errcode = '22023';
 end if;
 if p_base is distinct from p.version then
  v_who := coalesce(mavi_private.agent_name(p.company_id, p.changed_by), 'Alguém no n8n');
  raise exception '% mudou este prompt enquanto você editava.', v_who
   using errcode = '40001', hint = 'version:' || p.version;
 end if;
 select * into i from public.agent_instances where id = w.instance_id;
 return jsonb_build_object('prompt', p.id, 'workflow', w.id, 'n8n_id', w.n8n_id, 'node_id', p.node_id,
  'stored', p.prompt, 'expression', p.expression, 'version', p.version, 'instance', i.id,
  'base_url', i.base_url, 'key_cipher', i.key_cipher);
end $$;

-- Depois de publicar no n8n: a versão nova (p_action 'edit' ou 'restore').
create function public.agent_prompt_saved(p_prompt uuid, p_base integer, p_text text, p_note text,
 p_action text, p_from integer, p_version_id text, p_updated_at timestamptz) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare p public.agent_prompts := mavi_private.agent_prompt_row(p_prompt); w public.agent_workflows;
 v_text text := left(coalesce(p_text, ''), 200000); begin
 select * into w from public.agent_workflows where id = p.workflow_id for update;
 if not mavi_private.agent_writer(w) then
  raise exception 'Você não pode editar o agente deste cliente.' using errcode = '42501';
 end if;
 if p_action not in ('edit', 'restore') then raise exception 'Ação inválida.' using errcode = '22023'; end if;
 select * into p from public.agent_prompts where id = p.id for update;
 if p.prompt is not distinct from v_text then
  update public.agent_workflows set n8n_version_id = coalesce(nullif(p_version_id, ''), n8n_version_id),
   n8n_updated_at = coalesce(p_updated_at, n8n_updated_at) where id = w.id;
  return jsonb_build_object('version', p.version);
 end if;
 update public.agent_prompts set prompt = v_text, version = p.version + 1, changed_at = now(),
  changed_by = auth.uid() where id = p.id;
 insert into public.agent_prompt_versions(company_id, prompt_id, version, prompt, expression, source,
  restored_from, note, saved_by, n8n_version_id)
 values (p.company_id, p.id, p.version + 1, v_text, p.expression, p_action,
  case when p_action = 'restore' then p_from end,
  left(btrim(regexp_replace(coalesce(p_note, ''), '[\x00-\x08\x0b-\x1f]+', ' ', 'g')), 500),
  auth.uid(), nullif(p_version_id, ''));
 update public.agent_workflows set n8n_version_id = coalesce(nullif(p_version_id, ''), n8n_version_id),
  n8n_updated_at = coalesce(p_updated_at, n8n_updated_at) where id = w.id;
 perform mavi_private.drive_log(p.company_id, case p_action when 'restore' then 'agent_prompt_restored'
  else 'agent_prompt_published' end, null, null, w.name || ' › ' || p.node_name, w.client_id, w.contract_id,
  jsonb_strip_nulls(jsonb_build_object('prompt', p.id, 'workflow', w.id, 'version', p.version + 1,
   'from', case when p_action = 'restore' then p_from end)));
 perform mavi_private.broadcast(p.company_id, jsonb_build_object('kind', 'agents', 'client', w.client_id,
  'contract', w.contract_id, 'workflow', w.id, 'prompt', p.id, 'version', p.version + 1));
 return jsonb_build_object('version', p.version + 1);
end $$;

-- ------------------------------------------------------------ listas
create function mavi_private.agent_workflow_json(w public.agent_workflows, p_query text) returns jsonb
language sql stable security definer set search_path = '' as $$
 select jsonb_build_object('id', w.id, 'instance', w.instance_id,
  'instance_name', (select i.name from public.agent_instances i where i.id = w.instance_id),
  'n8n_url', (select i.base_url from public.agent_instances i where i.id = w.instance_id) || '/workflow/' || w.n8n_id,
  'n8n_id', w.n8n_id, 'name', w.name, 'active', w.active, 'archived', w.archived, 'role', w.role,
  'called_by', w.called_by, 'n8n_updated_at', w.n8n_updated_at, 'client_id', w.client_id,
  'client_name', (select k.name from public.clients k where k.id = w.client_id),
  'contract_id', w.contract_id,
  'product_name', (select p.name from public.contracts k join public.products p on p.company_id = k.company_id
   and p.id = k.product_id where k.id = w.contract_id),
  'link_source', w.link_source, 'ignored', w.ignored, 'removed_at', w.removed_at,
  'can_edit', mavi_private.agent_writer(w),
  'prompts', coalesce((select jsonb_agg(jsonb_build_object('id', p.id, 'node_name', p.node_name,
    'node_type', p.node_type, 'chars', length(p.prompt), 'version', p.version, 'changed_at', p.changed_at,
    'changed_by_name', mavi_private.agent_name(p.company_id, p.changed_by), 'setup', p.setup,
    'expression', p.expression, 'removed', p.removed_at is not null,
    'excerpt', case when coalesce(btrim(p_query), '') <> '' and strpos(lower(p.prompt), lower(btrim(p_query))) > 0
     then '…' || regexp_replace(substr(p.prompt, greatest(strpos(lower(p.prompt), lower(btrim(p_query))) - 80, 1), 240),
      '\s+', ' ', 'g') || '…'
     else left(regexp_replace(p.prompt, '\s+', ' ', 'g'), 200) end)
   order by p.removed_at is not null, p.node_name, p.id)
   from public.agent_prompts p where p.workflow_id = w.id), '[]'))
$$;
revoke all on function mavi_private.agent_workflow_json(public.agent_workflows, text) from public, anon, authenticated;

-- Os fluxos que a pessoa vê. p_client/p_contract: os de um cliente/produto
-- (a pasta do Drive). p_query: busca no nome do fluxo, do cliente, do nó e
-- no texto dos prompts. p_unlinked: os sem cliente (só líderes).
create function public.agent_list(p_company uuid, p_client uuid default null, p_contract uuid default null,
 p_query text default null, p_unlinked boolean default false) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare q text := lower(btrim(coalesce(p_query, ''))); begin
 if not mavi_private.member(p_company) then raise exception 'Sem acesso.' using errcode = '42501'; end if;
 if coalesce(p_unlinked, false) and not mavi_private.leader(p_company) then
  raise exception 'Somente administradores e gestores ligam fluxos aos clientes.' using errcode = '42501';
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

-- Quantos fluxos ativos ou subfluxos o produto tem (o cartão no Drive).
create function public.agent_count(p_company uuid, p_contract uuid) returns integer
language sql stable security definer set search_path = '' as $$
 select count(*)::integer from public.agent_workflows w
 where w.company_id = p_company and w.contract_id = p_contract and w.removed_at is null
  and mavi_private.agent_reader(w)
$$;

-- O resumo para o topo do módulo (líderes): VPS e fluxos sem cliente.
create function public.agent_status(p_company uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$ begin
 if not mavi_private.member(p_company) then raise exception 'Sem acesso.' using errcode = '42501'; end if;
 if not mavi_private.leader(p_company) then return jsonb_build_object('leader', false); end if;
 return jsonb_build_object('leader', true, 'admin', mavi_private.admin(p_company),
  'instances', (select count(*) from public.agent_instances i where i.company_id = p_company),
  'errors', (select count(*) from public.agent_instances i where i.company_id = p_company and i.enabled
   and i.last_error is not null),
  'last_sync_at', (select max(i.last_sync_at) from public.agent_instances i where i.company_id = p_company),
  'unlinked', (select count(*) from public.agent_workflows w where w.company_id = p_company
   and w.removed_at is null and w.client_id is null and not w.ignored and w.role <> 'copy'),
  'unlinked_all', (select count(*) from public.agent_workflows w where w.company_id = p_company
   and w.removed_at is null and w.client_id is null));
end $$;

create function public.agent_prompt_get(p_prompt uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
 select jsonb_build_object('id', p.id, 'workflow_id', p.workflow_id, 'node_id', p.node_id, 'node_name', p.node_name,
  'node_type', p.node_type, 'prompt', p.prompt, 'expression', p.expression, 'setup', p.setup, 'version', p.version,
  'changed_at', p.changed_at, 'changed_by_name', mavi_private.agent_name(p.company_id, p.changed_by),
  'removed', p.removed_at is not null,
  'workflow', mavi_private.agent_workflow_json(w, null))
 from public.agent_prompts p join public.agent_workflows w on w.id = p.workflow_id
 where p.id = (mavi_private.agent_prompt_row(p_prompt)).id
$$;

create function public.agent_prompt_versions(p_prompt uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
 select coalesce(jsonb_agg(jsonb_build_object('version', v.version, 'source', v.source,
   'restored_from', v.restored_from, 'note', v.note,
   'saved_by_name', mavi_private.agent_name(v.company_id, v.saved_by), 'saved_at', v.saved_at,
   'chars', length(v.prompt)) order by v.version desc), '[]')
 from public.agent_prompt_versions v where v.prompt_id = (mavi_private.agent_prompt_row(p_prompt)).id
$$;

create function public.agent_prompt_version(p_prompt uuid, p_version integer) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare p public.agent_prompts := mavi_private.agent_prompt_row(p_prompt); v public.agent_prompt_versions; begin
 select * into v from public.agent_prompt_versions where prompt_id = p.id and version = p_version;
 if v.id is null then raise exception 'Versão não encontrada.' using errcode = 'P0002'; end if;
 return jsonb_build_object('version', v.version, 'prompt', v.prompt, 'expression', v.expression, 'source', v.source,
  'restored_from', v.restored_from, 'note', v.note, 'saved_at', v.saved_at,
  'saved_by_name', mavi_private.agent_name(v.company_id, v.saved_by));
end $$;

-- ------------------------------------------------------------ ligar ao cliente
-- Líderes ligam o fluxo a um cliente (e ao produto dele), desligam (nulo) ou
-- ignoram (fluxo interno). Ligar o principal leva junto os subfluxos dele
-- que ainda não têm cliente.
create function public.agent_workflow_link(p_workflow uuid, p_client uuid, p_contract uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare w public.agent_workflows := mavi_private.agent_workflow_row(p_workflow); v_old uuid := w.client_id;
 v_old_contract uuid := w.contract_id; begin
 if not mavi_private.leader(w.company_id) then
  raise exception 'Somente administradores e gestores ligam fluxos aos clientes.' using errcode = '42501';
 end if;
 if p_client is null and p_contract is not null then raise exception 'Escolha o cliente.' using errcode = '22023'; end if;
 if p_client is not null and not exists (select 1 from public.clients k where k.company_id = w.company_id
  and k.id = p_client) then
  raise exception 'Cliente não encontrado.' using errcode = 'P0002';
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

create function public.agent_workflow_ignore(p_workflow uuid, p_ignored boolean) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare w public.agent_workflows := mavi_private.agent_workflow_row(p_workflow); begin
 if not mavi_private.leader(w.company_id) then
  raise exception 'Somente administradores e gestores.' using errcode = '42501';
 end if;
 update public.agent_workflows set ignored = coalesce(p_ignored, false),
  client_id = case when coalesce(p_ignored, false) then null else client_id end,
  contract_id = case when coalesce(p_ignored, false) then null else contract_id end,
  link_source = 'manual', linked_by = auth.uid(), linked_at = now()
 where id = w.id returning * into w;
 perform mavi_private.broadcast(w.company_id, jsonb_build_object('kind', 'agents', 'workflow', w.id));
 return mavi_private.agent_workflow_json(w, null);
end $$;

-- ------------------------------------------------------------ MAVI
-- Os prompts do cliente para a conversa com a MAVI e para o Copiloto (quem
-- vê o cliente). p_contract: só os do produto (sem p_client, o cliente vem
-- dele). Sem as cópias.
create function public.agent_prompts_context(p_company uuid, p_client uuid, p_contract uuid default null,
 p_chars integer default 6000) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_client uuid := coalesce(p_client, (select k.client_id from public.contracts k
 where k.company_id = p_company and k.id = p_contract)); begin
 if v_client is null or not mavi_private.dossier_reader(p_company, v_client) then return '[]'; end if;
 return coalesce((select jsonb_agg(jsonb_build_object('id', p.id, 'workflow', w.name, 'node', p.node_name,
   'role', w.role, 'active', w.active, 'contract_id', w.contract_id,
   'product', (select pr.name from public.contracts k join public.products pr on pr.company_id = k.company_id
    and pr.id = k.product_id where k.id = w.contract_id),
   'model', p.setup->>'model', 'changed_at', p.changed_at, 'chars', length(p.prompt),
   'text', left(p.prompt, least(greatest(coalesce(p_chars, 6000), 200), 20000)))
   order by w.role = 'main' desc, w.active desc, w.name, p.node_name)
  from public.agent_workflows w join public.agent_prompts p on p.workflow_id = w.id
  where w.company_id = p_company and w.client_id = v_client and w.removed_at is null and not w.ignored
   and w.role <> 'copy' and not w.archived and p.removed_at is null and btrim(p.prompt) <> ''
   and (p_contract is null or w.contract_id = p_contract)), '[]');
end $$;

-- O mesmo para o Radar (servidor, com o segredo da MAVI): referência das
-- regras do robô ao julgar reclamações sobre ele.
create function public.agent_prompts_for_worker(p_secret text, p_client uuid, p_chars integer default 4000)
returns jsonb language plpgsql stable security definer set search_path = '' as $$ begin
 if not mavi_private.ai_secret_ok(p_secret) then raise exception 'Sem permissão.' using errcode = '42501'; end if;
 return coalesce((select jsonb_agg(jsonb_build_object('workflow', w.name, 'node', p.node_name,
   'contract_id', w.contract_id, 'text', left(p.prompt, least(greatest(coalesce(p_chars, 4000), 200), 20000)))
   order by w.role = 'main' desc, w.active desc, w.name, p.node_name)
  from public.agent_workflows w join public.agent_prompts p on p.workflow_id = w.id
  where w.client_id = p_client and w.removed_at is null and not w.ignored and w.role <> 'copy'
   and not w.archived and p.removed_at is null and btrim(p.prompt) <> ''), '[]');
end $$;

alter table public.ai_documents drop constraint ai_documents_source_type_check;
alter table public.ai_documents add constraint ai_documents_source_type_check
 check (source_type in ('meeting', 'task', 'drive_file', 'social_plan', 'social_briefing', 'campaign',
  'success_case', 'whatsapp', 'ai_attachment', 'client_note', 'agent_prompt'));

-- Quem vê o cliente acha o prompt (acesso 'client', com o produto).
create function mavi_private.ai_build_agent_prompt(p_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare r record; v_pieces jsonb := '[]'; piece text; begin
 select p.id, p.company_id, p.prompt, p.node_name, p.version, p.changed_at, p.removed_at, p.setup,
  w.name as workflow, w.client_id, w.contract_id, w.role, w.active, w.archived, w.ignored,
  w.removed_at as workflow_removed, k.name as client_name,
  (select pr.name from public.contracts c join public.products pr on pr.company_id = c.company_id
   and pr.id = c.product_id where c.id = w.contract_id) as product
 into r from public.agent_prompts p
 join public.agent_workflows w on w.id = p.workflow_id
 left join public.clients k on k.id = w.client_id
 where p.id = p_id;
 if not found or r.removed_at is not null or r.workflow_removed is not null or r.client_id is null
  or r.ignored or r.role = 'copy' or r.archived or btrim(r.prompt) = '' then
  perform mavi_private.ai_forget('agent_prompt', p_id);
  return;
 end if;
 for piece in select mavi_private.ai_split(r.prompt) loop
  v_pieces := v_pieces || jsonb_build_array(jsonb_build_object('text', piece,
   'meta', jsonb_build_object('kind', 'agent_prompt', 'version', r.version)));
 end loop;
 perform mavi_private.ai_save_document(r.company_id, 'agent_prompt', r.id, 'client', r.client_id, r.contract_id,
  null, null, r.workflow || ' › ' || r.node_name, r.changed_at,
  format('[Agente Conversacional do cliente — prompt de sistema do robô de WhatsApp] fluxo "%s" · nó "%s" · cliente %s%s · %s%s · atualizado em %s',
   r.workflow, r.node_name, r.client_name, coalesce(' · produto ' || r.product, ''),
   case r.role when 'main' then 'fluxo principal' else 'subfluxo' end,
   case when r.active then ' (ativo)' else '' end,
   to_char(r.changed_at at time zone 'America/Sao_Paulo', 'DD/MM/YYYY')),
  v_pieces);
end $$;
revoke all on function mavi_private.ai_build_agent_prompt(uuid) from public, anon, authenticated;

create or replace function mavi_private.ai_build(p_type text, p_id uuid) returns void
language plpgsql security definer set search_path = '' as $$ begin
 if p_type = 'meeting' then perform mavi_private.ai_build_meeting(p_id);
 elsif p_type = 'task' then perform mavi_private.ai_build_task(p_id);
 elsif p_type = 'drive_file' then perform mavi_private.ai_build_drive_file(p_id);
 elsif p_type = 'social_plan' then perform mavi_private.ai_build_social_plan(p_id);
 elsif p_type = 'social_briefing' then perform mavi_private.ai_build_social_briefing(p_id);
 elsif p_type = 'campaign' then perform mavi_private.ai_build_campaign(p_id);
 elsif p_type = 'success_case' then perform mavi_private.case_index(p_id);
 elsif p_type = 'whatsapp' then perform mavi_private.ai_build_whatsapp(p_id);
 elsif p_type = 'client_note' then perform mavi_private.ai_build_client_note(p_id);
 elsif p_type = 'agent_prompt' then perform mavi_private.ai_build_agent_prompt(p_id);
 end if;
end $$;
revoke all on function mavi_private.ai_build(text, uuid) from public, anon, authenticated;

create trigger ai_queue_agent_prompts_ins after insert on public.agent_prompts
 referencing new table as changed for each statement execute function mavi_private.ai_queue_rows('agent_prompt', 'id');
create trigger ai_queue_agent_prompts_upd after update on public.agent_prompts
 referencing new table as changed for each statement execute function mavi_private.ai_queue_rows('agent_prompt', 'id');
create trigger ai_queue_agent_prompts_del after delete on public.agent_prompts
 referencing old table as changed for each statement execute function mavi_private.ai_queue_rows('agent_prompt', 'id');

-- O fluxo mudou de cliente, papel ou estado: os prompts dele são refeitos.
create function mavi_private.ai_queue_agent_workflow() returns trigger
language plpgsql security definer set search_path = '' as $$ begin
 perform mavi_private.ai_enqueue('agent_prompt', (select jsonb_agg(jsonb_build_object('id', p.id,
  'company_id', p.company_id)) from public.agent_prompts p where p.workflow_id = new.id));
 return null;
end $$;
revoke all on function mavi_private.ai_queue_agent_workflow() from public, anon, authenticated;
create trigger ai_queue_agent_workflows after update on public.agent_workflows for each row
 when ((old.client_id, old.contract_id, old.role, old.active, old.archived, old.ignored, old.removed_at, old.name)
  is distinct from (new.client_id, new.contract_id, new.role, new.active, new.archived, new.ignored, new.removed_at,
   new.name))
 execute function mavi_private.ai_queue_agent_workflow();

-- ------------------------------------------------------------ agendamento
-- A cada 5 minutos o banco vê se alguma VPS passou de 1h sem leitura e chama
-- o servidor (/api/ai, o mesmo da indexação da MAVI, com o segredo dela).
create function mavi_private.agent_kick() returns void
language plpgsql security definer set search_path = '' as $$
declare cfg mavi_private.ai_config; begin
 select * into cfg from mavi_private.ai_config where id;
 if not found then return; end if;
 if not exists (select 1 from public.agent_instances i where i.enabled
  and (i.last_attempt_at is null or i.last_attempt_at < now() - interval '55 minutes')
  and (i.claimed_at is null or i.claimed_at < now() - interval '10 minutes')) then return; end if;
 perform net.http_post(url := cfg.url, body := '{"action":"agent-sync"}'::jsonb,
  headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || cfg.secret),
  timeout_milliseconds := 60000);
end $$;
revoke all on function mavi_private.agent_kick() from public, anon, authenticated;

-- Sem passo manual: com o pg_cron no banco (produção), o agendamento já fica
-- criado; sem ele (testes), nada acontece.
do $$ begin
 if exists (select 1 from pg_extension where extname = 'pg_cron') then
  perform cron.schedule('mavi-agent-sync', '*/5 * * * *', 'select mavi_private.agent_kick();');
 end if;
end $$;

-- ------------------------------------------------------------ módulo
alter table public.memberships drop constraint if exists memberships_hidden_pages_check;
alter table public.memberships add constraint memberships_hidden_pages_check
 check (hidden_pages <@ array['overview','tasks','agenda','clients','products','projects','campaigns','hours',
  'reports','drive','storage','dashboards','onboarding','aiUsage','assistant','cases','notices',
  'temperature','socialMedia','radar','financeMedia','personalRadar','agents']::text[]);

-- A da migração 20270304090000, com o Agente Conversacional.
create or replace function public.set_member_pages(p_company uuid, p_user uuid, p_hidden text[]) returns void
language plpgsql security definer set search_path = '' as $$
declare v text[]; v_role text; opt text[] := array['overview','campaigns','radar','dashboards','financeMedia','personalRadar'];
 v_shown text[]; begin
 if not mavi_private.admin(p_company) then
  raise exception 'Somente administradores escolhem os módulos de cada pessoa.' using errcode = '42501';
 end if;
 select role into v_role from public.memberships where company_id = p_company and user_id = p_user;
 if not found then
  raise exception 'Usuário não encontrado na empresa';
 end if;
 select coalesce(array_agg(distinct x order by x), '{}') into v from unnest(coalesce(p_hidden, '{}')) x;
 if not v <@ array['overview','tasks','agenda','clients','products','projects','campaigns','hours',
  'reports','drive','storage','dashboards','onboarding','aiUsage','assistant','cases','notices',
  'temperature','socialMedia','radar','financeMedia','personalRadar','agents']::text[] then
  raise exception 'Módulo inválido' using errcode = '22023';
 end if;
 if v_role = 'member' then
  select coalesce(array_agg(x order by x), '{}') into v_shown from unnest(opt) x where not x = any(v);
  select coalesce(array_agg(x order by x), '{}') into v from unnest(v) x where not x = any(opt);
  update public.memberships set hidden_pages = v, shown_pages = v_shown
  where company_id = p_company and user_id = p_user
   and (hidden_pages is distinct from v or shown_pages is distinct from v_shown);
 else
  update public.memberships set hidden_pages = v where company_id = p_company and user_id = p_user
   and hidden_pages is distinct from v;
 end if;
end $$;

-- ------------------------------------------------------------ permissões
revoke all on function public.agent_instances_list(uuid),
 public.agent_instance_save(uuid, uuid, text, text, text, text, boolean), public.agent_instance_delete(uuid, uuid),
 public.agent_instance_secret(uuid, uuid), public.agent_sync_targets(text, uuid, uuid),
 public.agent_sync_store(text, uuid, jsonb, boolean, text, jsonb), public.agent_workflow_target(uuid),
 public.agent_workflow_store(uuid, jsonb), public.agent_prompt_edit_target(uuid, integer),
 public.agent_prompt_saved(uuid, integer, text, text, text, integer, text, timestamptz),
 public.agent_list(uuid, uuid, uuid, text, boolean), public.agent_count(uuid, uuid), public.agent_status(uuid),
 public.agent_prompt_get(uuid), public.agent_prompt_versions(uuid), public.agent_prompt_version(uuid, integer),
 public.agent_workflow_link(uuid, uuid, uuid), public.agent_workflow_ignore(uuid, boolean),
 public.agent_prompts_context(uuid, uuid, uuid, integer), public.agent_prompts_for_worker(text, uuid, integer)
 from public, anon;
grant execute on function public.agent_instances_list(uuid),
 public.agent_instance_save(uuid, uuid, text, text, text, text, boolean), public.agent_instance_delete(uuid, uuid),
 public.agent_instance_secret(uuid, uuid), public.agent_workflow_target(uuid),
 public.agent_workflow_store(uuid, jsonb), public.agent_prompt_edit_target(uuid, integer),
 public.agent_prompt_saved(uuid, integer, text, text, text, integer, text, timestamptz),
 public.agent_list(uuid, uuid, uuid, text, boolean), public.agent_count(uuid, uuid), public.agent_status(uuid),
 public.agent_prompt_get(uuid), public.agent_prompt_versions(uuid), public.agent_prompt_version(uuid, integer),
 public.agent_workflow_link(uuid, uuid, uuid), public.agent_workflow_ignore(uuid, boolean),
 public.agent_prompts_context(uuid, uuid, uuid, integer) to authenticated;
-- anon: o servidor no agendamento, com o segredo.
grant execute on function public.agent_sync_targets(text, uuid, uuid),
 public.agent_sync_store(text, uuid, jsonb, boolean, text, jsonb),
 public.agent_prompts_for_worker(text, uuid, integer) to anon, authenticated;

commit;
