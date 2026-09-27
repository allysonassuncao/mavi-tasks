begin;

-- MAVI · Assistente MAVI nas tarefas (copiloto em tempo real).
--
-- Enquanto alguém cria ou edita uma tarefa, a MAVI confere o rascunho contra
-- o histórico do cliente: tarefas parecidas (duplicadas), cases de sucesso,
-- o que o cliente gosta, não gosta, pediu ou reclamou. Duas camadas:
--
-- - "Relacionados" (sem modelo): task_copilot_context com o vetor do
--   rascunho — tarefas parecidas do mesmo cliente e cases de qualquer
--   cliente, numa chamada só.
-- - A análise da MAVI: a mesma função traz também o dossiê do cliente e os
--   trechos do histórico mais próximos do rascunho; o servidor faz uma única
--   chamada ao modelo (funcionalidade 'task_copilot' do Painel da MAVI).
--
-- Dossiê do cliente: um resumo curto e estável (gostos, o que não gosta,
-- regras, tom, contexto, histórico) que vai no começo do prompt — o mesmo
-- texto para todos que criam tarefas daquele cliente, então o cache do
-- provedor é reaproveitado. É mantido em segundo plano pelo worker
-- (/api/ai, ação "ai-dossier", funcionalidade 'client_dossier'), só para
-- clientes em uso (quem abre o copiloto ou o dossiê marca o cliente) e só
-- com o material novo desde a última leitura. Líderes fixam, corrigem e
-- removem itens; o que eles removem a MAVI não traz de volta.
--
-- Agendamento: supabase/operations/schedule-client-dossier.sql.

-- ------------------------------------------------------------ funcionalidades
alter table mavi_private.ai_routes drop constraint ai_routes_feature_check;
alter table mavi_private.ai_routes add constraint ai_routes_feature_check
 check ((scope_type = 'feature') = (feature is not null)
  and (feature is null or feature in ('assistant', 'meetings_history', 'meetings_ask', 'whatsapp_task',
   'social_leads_plan', 'social_leads_adjust', 'social_leads_briefing', 'social_leads_colors',
   'task_copilot', 'client_dossier')));

create or replace function public.ai_set_route(p_company uuid, p_type text, p_id uuid, p_provider uuid, p_model text,
 p_feature text default null) returns void
language plpgsql security definer set search_path = '' as $$
declare v_id uuid := case when p_type in ('company', 'feature') then null else p_id end;
 v_feature text := case when p_type = 'feature' then p_feature end; begin
 if not mavi_private.admin(p_company) then
  raise exception 'Só administradores escolhem qual IA cada um usa.' using errcode = '42501';
 end if;
 if p_type not in ('company', 'user', 'client', 'contract', 'project', 'feature') then
  raise exception 'Tipo inválido.' using errcode = '22023';
 end if;
 if p_type not in ('company', 'feature') and p_id is null then
  raise exception 'Escolha para quem vale a regra.' using errcode = '22023';
 end if;
 if p_type = 'feature' and coalesce(v_feature, '') not in ('assistant', 'meetings_history', 'meetings_ask',
  'whatsapp_task', 'social_leads_plan', 'social_leads_adjust', 'social_leads_briefing', 'social_leads_colors',
  'task_copilot', 'client_dossier') then
  raise exception 'Funcionalidade inválida.' using errcode = '22023';
 end if;
 if p_provider is null then
  delete from mavi_private.ai_routes where company_id = p_company and scope_type = p_type
   and scope_id is not distinct from v_id and feature is not distinct from v_feature;
  return;
 end if;
 if not exists (select 1 from mavi_private.ai_providers p where p.id = p_provider and p.company_id = p_company
   and exists (select 1 from jsonb_array_elements(p.models) m where m->>'id' = p_model)) then
  raise exception 'Escolha um modelo cadastrado no provedor.' using errcode = '22023';
 end if;
 if p_type = 'user' and not exists (select 1 from public.memberships where company_id = p_company and user_id = p_id)
  or p_type = 'client' and not exists (select 1 from public.clients where company_id = p_company and id = p_id)
  or p_type = 'contract' and not exists (select 1 from public.contracts where company_id = p_company and id = p_id)
  or p_type = 'project' and not exists (select 1 from public.projects where company_id = p_company and id = p_id) then
  raise exception 'Não encontrado na empresa.' using errcode = 'P0002';
 end if;
 insert into mavi_private.ai_routes(company_id, scope_type, scope_id, feature, provider_id, model)
 values (p_company, p_type, v_id, v_feature, p_provider, p_model)
 on conflict on constraint ai_routes_scope_key do update set provider_id = excluded.provider_id,
  model = excluded.model, updated_by = auth.uid(), updated_at = now();
end $$;

-- O worker (sem pessoa logada) também escolhe o provedor: funcionalidade ›
-- empresa › servidor (nulo).
create or replace function public.ai_worker_route(p_secret text, p_company uuid, p_feature text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare r record; begin
 if not mavi_private.ai_secret_ok(p_secret) then raise exception 'Sem permissão' using errcode = '42501'; end if;
 select rt.scope_type, rt.model, p.id, p.name, p.kind, p.base_url, p.key_cipher, p.models into r
 from mavi_private.ai_routes rt join mavi_private.ai_providers p on p.id = rt.provider_id and p.active
 where rt.company_id = p_company and ((rt.scope_type = 'feature' and rt.feature = p_feature) or rt.scope_type = 'company')
 order by case rt.scope_type when 'feature' then 1 else 2 end
 limit 1;
 if not found then return null; end if;
 return jsonb_build_object('scope', r.scope_type, 'provider_id', r.id, 'provider', r.name, 'kind', r.kind,
  'base_url', r.base_url, 'key_cipher', r.key_cipher, 'model', r.model,
  'price', (select m from jsonb_array_elements(r.models) m where m->>'id' = r.model limit 1));
end $$;

-- ------------------------------------------------------------ dossiê
create table public.client_dossier_items (
 id uuid primary key default gen_random_uuid(),
 company_id uuid not null references public.companies(id),
 client_id uuid not null,
 -- prefers: o cliente gosta/prefere · avoids: não gosta/não quer · rule: regra
 -- ou combinado · style: tom, identidade visual, linguagem · context: o negócio
 -- · history: problemas, reclamações e decisões que pesam nas entregas.
 kind text not null check (kind in ('prefers', 'avoids', 'rule', 'style', 'context', 'history')),
 text text not null check (length(btrim(text)) between 3 and 600),
 origin text not null check (origin in ('mavi', 'person')),
 -- Fixado: a MAVI não muda nem remove. Itens de pessoas nascem fixados.
 pinned boolean not null default false,
 -- Removido por um líder: some do dossiê e a MAVI não traz de volta.
 dismissed boolean not null default false,
 sources jsonb not null default '[]' check (jsonb_typeof(sources) = 'array'),
 -- Data da evidência mais recente (o mais novo vale quando há contradição).
 seen_at timestamptz,
 created_by uuid,
 updated_by uuid,
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 foreign key (company_id, client_id) references public.clients(company_id, id) on delete cascade
);
create index client_dossier_items_client on public.client_dossier_items (client_id, kind);
alter table public.client_dossier_items enable row level security;
revoke all on public.client_dossier_items from public, anon, authenticated;

create table mavi_private.client_dossier_state (
 client_id uuid primary key,
 company_id uuid not null,
 -- Material novo desde (nulo: em dia).
 dirty_at timestamptz,
 claimed_at timestamptz,
 running_until timestamptz,
 built_at timestamptz,
 -- Até onde o worker já leu (ai_documents.indexed_at, id).
 cursor_at timestamptz,
 cursor_id uuid,
 -- Muda a cada alteração nos itens (o navegador descarta análises antigas).
 version integer not null default 0,
 attempts integer not null default 0,
 last_error text
);
create index client_dossier_state_due on mavi_private.client_dossier_state (dirty_at) where dirty_at is not null;
revoke all on mavi_private.client_dossier_state from public, anon, authenticated;

-- Material que entra no dossiê (não entram cases: são de outros clientes).
create function mavi_private.dossier_types() returns text[]
language sql immutable set search_path = '' as $$
 select array['meeting', 'whatsapp', 'task', 'drive_file', 'social_briefing', 'social_plan', 'campaign']
$$;

-- Documento novo ou mudado de um cliente em uso: o dossiê fica pendente.
-- Só atualiza (não cria): clientes entram no dossiê quando alguém usa.
create function mavi_private.dossier_touch() returns trigger
language plpgsql security definer set search_path = '' as $$ begin
 if new.client_id is not null and new.source_type = any(mavi_private.dossier_types()) then
  update mavi_private.client_dossier_state set dirty_at = coalesce(dirty_at, now())
  where client_id = new.client_id and dirty_at is null;
 end if;
 return null;
end $$;
create trigger ai_documents_dossier after insert or update of content_hash on public.ai_documents
 for each row execute function mavi_private.dossier_touch();

-- O cliente passa a ter dossiê (primeira leitura logo em seguida).
create function mavi_private.dossier_want(c uuid, p_client uuid) returns void
language sql security definer set search_path = '' as $$
 insert into mavi_private.client_dossier_state(client_id, company_id, dirty_at)
 values (p_client, c, now()) on conflict (client_id) do nothing
$$;

create function mavi_private.dossier_bump(p_client uuid) returns void
language sql security definer set search_path = '' as $$
 update mavi_private.client_dossier_state set version = version + 1 where client_id = p_client
$$;

create function mavi_private.dossier_items_json(p_client uuid, p_with_dismissed boolean) returns jsonb
language sql stable security definer set search_path = '' as $$
 select coalesce(jsonb_agg(jsonb_build_object('id', i.id, 'kind', i.kind, 'text', i.text, 'origin', i.origin,
   'pinned', i.pinned, 'dismissed', i.dismissed, 'sources', i.sources, 'seen_at', i.seen_at,
   'updated_at', i.updated_at, 'updated_by', i.updated_by)
  order by i.kind, i.pinned desc, i.seen_at desc nulls last, i.created_at), '[]')
 from public.client_dossier_items i
 where i.client_id = p_client and (p_with_dismissed or not i.dismissed)
$$;

create function mavi_private.dossier_reader(c uuid, p_client uuid) returns boolean
language sql stable security definer set search_path = '' as $$
 select mavi_private.member(c) and exists (select 1 from public.clients k where k.company_id = c and k.id = p_client)
  and (mavi_private.leader(c) or mavi_private.drive_can_read(c, p_client))
$$;

-- O dossiê na tela (Drive › cliente › Dossiê da MAVI). Abrir já coloca o
-- cliente na fila, se ainda não tiver dossiê.
create function public.client_dossier(p_company uuid, p_client uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare s mavi_private.client_dossier_state; begin
 if not mavi_private.dossier_reader(p_company, p_client) then
  raise exception 'Sem acesso a este cliente.' using errcode = '42501';
 end if;
 perform mavi_private.dossier_want(p_company, p_client);
 select * into s from mavi_private.client_dossier_state where client_id = p_client;
 return jsonb_build_object('items', mavi_private.dossier_items_json(p_client, mavi_private.leader(p_company)),
  'version', s.version, 'built_at', s.built_at, 'pending', s.dirty_at is not null,
  'failed', s.attempts >= 5, 'can_edit', mavi_private.leader(p_company));
end $$;

-- Um líder escreve (novo) ou corrige (existente) um item: fica fixado.
create function public.client_dossier_save(p_company uuid, p_client uuid, p_id uuid, p_kind text, p_text text)
returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_id uuid; begin
 if not mavi_private.leader(p_company) then
  raise exception 'Só administradores e gestores editam o dossiê.' using errcode = '42501';
 end if;
 if not exists (select 1 from public.clients where company_id = p_company and id = p_client) then
  raise exception 'Cliente não encontrado.' using errcode = 'P0002';
 end if;
 if coalesce(p_kind, '') not in ('prefers', 'avoids', 'rule', 'style', 'context', 'history') then
  raise exception 'Tipo inválido.' using errcode = '22023';
 end if;
 if length(btrim(coalesce(p_text, ''))) not between 3 and 600 then
  raise exception 'Escreva de 3 a 600 caracteres.' using errcode = '22023';
 end if;
 if p_id is null then
  insert into public.client_dossier_items(company_id, client_id, kind, text, origin, pinned, seen_at, created_by,
   updated_by)
  values (p_company, p_client, p_kind, btrim(p_text), 'person', true, now(), auth.uid(), auth.uid())
  returning id into v_id;
 else
  update public.client_dossier_items set kind = p_kind, text = btrim(p_text), pinned = true, dismissed = false,
   updated_by = auth.uid(), updated_at = now()
  where id = p_id and company_id = p_company and client_id = p_client
  returning id into v_id;
  if v_id is null then raise exception 'Item não encontrado.' using errcode = 'P0002'; end if;
 end if;
 perform mavi_private.dossier_want(p_company, p_client);
 perform mavi_private.dossier_bump(p_client);
 return v_id;
end $$;

-- Fixar/soltar, remover (item de pessoa sai de vez; da MAVI fica marcado
-- para não voltar) ou restaurar um item removido.
create function public.client_dossier_set(p_company uuid, p_id uuid, p_action text) returns void
language plpgsql security definer set search_path = '' as $$
declare i public.client_dossier_items; begin
 if not mavi_private.leader(p_company) then
  raise exception 'Só administradores e gestores editam o dossiê.' using errcode = '42501';
 end if;
 select * into i from public.client_dossier_items where id = p_id and company_id = p_company for update;
 if not found then raise exception 'Item não encontrado.' using errcode = 'P0002'; end if;
 if p_action = 'pin' then
  update public.client_dossier_items set pinned = true, updated_by = auth.uid(), updated_at = now() where id = p_id;
 elsif p_action = 'unpin' then
  update public.client_dossier_items set pinned = (origin = 'person'), updated_by = auth.uid(), updated_at = now()
  where id = p_id;
 elsif p_action = 'remove' then
  if i.origin = 'person' then delete from public.client_dossier_items where id = p_id;
  else update public.client_dossier_items set dismissed = true, pinned = false, updated_by = auth.uid(),
   updated_at = now() where id = p_id;
  end if;
 elsif p_action = 'restore' then
  update public.client_dossier_items set dismissed = false, updated_by = auth.uid(), updated_at = now()
  where id = p_id;
 else
  raise exception 'Ação inválida.' using errcode = '22023';
 end if;
 perform mavi_private.dossier_bump(i.client_id);
end $$;

-- ------------------------------------------------------------ worker do dossiê
-- Clientes com material novo parado há 15 min (primeira leitura: na hora).
create function public.ai_dossier_claim(p_secret text, p_limit integer default 4)
returns table(client_id uuid, company_id uuid, client_name text, products text, cursor_at timestamptz,
 cursor_id uuid, items jsonb)
language plpgsql security definer set search_path = '' as $$ begin
 if not mavi_private.ai_secret_ok(p_secret) then raise exception 'Sem permissão' using errcode = '42501'; end if;
 return query
 with due as (
  select s.client_id from mavi_private.client_dossier_state s
  join public.clients k on k.id = s.client_id and not k.archived
  where s.dirty_at is not null and s.attempts < 5
   and (s.built_at is null or s.dirty_at <= now() - interval '15 minutes')
   and (s.running_until is null or s.running_until < now())
  order by s.built_at nulls first, s.dirty_at
  limit least(greatest(coalesce(p_limit, 4), 1), 10)
  for update of s skip locked
 ), claimed as (
  update mavi_private.client_dossier_state s set claimed_at = now(), running_until = now() + interval '4 minutes'
  from due where s.client_id = due.client_id
  returning s.client_id, s.company_id, s.cursor_at, s.cursor_id
 )
 select c.client_id, c.company_id, k.name,
  (select coalesce(string_agg(distinct p.name, ', '), '') from public.contracts ct
   join public.products p on p.company_id = ct.company_id and p.id = ct.product_id
   where ct.company_id = c.company_id and ct.client_id = c.client_id and not ct.archived),
  c.cursor_at, c.cursor_id, mavi_private.dossier_items_json(c.client_id, true)
 from claimed c join public.clients k on k.company_id = c.company_id and k.id = c.client_id;
end $$;

-- O material novo de um cliente, do mais antigo para o mais novo, até o
-- limite de caracteres (o que sobrar fica para a próxima rodada). Primeira
-- leitura: os últimos 90 dias. Reunião entra pelo resumo.
create function public.ai_dossier_material(p_secret text, p_client uuid, p_cursor_at timestamptz,
 p_cursor_id uuid, p_max_chars integer default 60000, p_doc_chars integer default 4000) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare d record; v_docs jsonb := '[]'; v_total integer := 0; v_text text; v_at timestamptz; v_id uuid;
 v_more boolean := false; v_from timestamptz := coalesce(p_cursor_at, now() - interval '90 days'); begin
 if not mavi_private.ai_secret_ok(p_secret) then raise exception 'Sem permissão' using errcode = '42501'; end if;
 for d in
  select x.id, x.source_type, x.title, x.occurred_at, x.indexed_at from public.ai_documents x
  where x.client_id = p_client and x.source_type = any(mavi_private.dossier_types())
   and (x.indexed_at, x.id) > (v_from, coalesce(p_cursor_id, '00000000-0000-0000-0000-000000000000'::uuid))
  order by x.indexed_at, x.id
  limit 400
 loop
  select left(string_agg(c.content, E'\n' order by c.ord), greatest(coalesce(p_doc_chars, 4000), 500))
   into v_text from public.ai_chunks c
   where c.document_id = d.id
    and (d.source_type <> 'meeting' or c.meta->>'kind' = 'summary'
     or not exists (select 1 from public.ai_chunks s where s.document_id = d.id and s.meta->>'kind' = 'summary'));
  v_text := coalesce(v_text, '');
  if v_total > 0 and v_total + length(v_text) > coalesce(p_max_chars, 60000) then
   v_more := true; exit;
  end if;
  v_total := v_total + length(v_text);
  v_at := d.indexed_at; v_id := d.id;
  if v_text <> '' then
   v_docs := v_docs || jsonb_build_object('type', d.source_type, 'title', d.title, 'date', d.occurred_at,
    'text', v_text);
  end if;
 end loop;
 if not v_more and v_id is not null then
  v_more := exists (select 1 from public.ai_documents x where x.client_id = p_client
   and x.source_type = any(mavi_private.dossier_types()) and (x.indexed_at, x.id) > (v_at, v_id));
 end if;
 return jsonb_build_object('docs', v_docs, 'cursor_at', coalesce(v_at, p_cursor_at),
  'cursor_id', coalesce(v_id, p_cursor_id), 'more', v_more);
end $$;

-- Aplica as mudanças que a MAVI propôs. Itens fixados ou removidos por
-- pessoas não mudam; no máximo 60 itens ativos por cliente.
create function public.ai_dossier_store(p_secret text, p_client uuid, p_cursor_at timestamptz, p_cursor_id uuid,
 p_more boolean, p_ops jsonb, p_usage jsonb) returns integer
language plpgsql security definer set search_path = '' as $$
declare s mavi_private.client_dossier_state; o jsonb; v_changed integer := 0; v_n integer; v_kind text;
 v_text text; v_sources jsonb; v_seen timestamptz; v_id uuid; begin
 if not mavi_private.ai_secret_ok(p_secret) then raise exception 'Sem permissão' using errcode = '42501'; end if;
 select * into s from mavi_private.client_dossier_state where client_id = p_client for update;
 if not found then return 0; end if;
 for o in select * from jsonb_array_elements(case when jsonb_typeof(p_ops) = 'array' then p_ops else '[]' end) loop
  v_kind := o->>'kind';
  v_text := btrim(coalesce(o->>'text', ''));
  v_sources := case when jsonb_typeof(o->'sources') = 'array' then o->'sources' else '[]' end;
  v_seen := case when o->>'seen_at' ~ '^\d{4}-\d{2}-\d{2}' then (o->>'seen_at')::timestamptz end;
  v_id := case when o->>'id' ~* '^[0-9a-f-]{36}$' then (o->>'id')::uuid end;
  if o->>'op' = 'add' then
   continue when v_kind is null or v_kind not in ('prefers', 'avoids', 'rule', 'style', 'context', 'history')
    or length(v_text) not between 3 and 600;
   continue when exists (select 1 from public.client_dossier_items i where i.client_id = p_client
    and lower(i.text) = lower(v_text));
   continue when (select count(*) from public.client_dossier_items i where i.client_id = p_client
    and not i.dismissed) >= 60;
   insert into public.client_dossier_items(company_id, client_id, kind, text, origin, sources, seen_at)
   values (s.company_id, p_client, v_kind, v_text, 'mavi', v_sources, coalesce(v_seen, now()));
   v_changed := v_changed + 1;
  elsif o->>'op' = 'update' and v_id is not null then
   continue when length(v_text) not between 3 and 600;
   update public.client_dossier_items i set text = v_text,
    kind = case when v_kind in ('prefers', 'avoids', 'rule', 'style', 'context', 'history') then v_kind else i.kind end,
    sources = case when jsonb_array_length(v_sources) > 0 then v_sources else i.sources end,
    seen_at = coalesce(v_seen, i.seen_at), updated_by = null, updated_at = now()
   where i.id = v_id and i.client_id = p_client and i.origin = 'mavi' and not i.pinned and not i.dismissed;
   get diagnostics v_n = row_count; v_changed := v_changed + v_n;
  elsif o->>'op' = 'remove' and v_id is not null then
   delete from public.client_dossier_items i
   where i.id = v_id and i.client_id = p_client and i.origin = 'mavi' and not i.pinned and not i.dismissed;
   get diagnostics v_n = row_count; v_changed := v_changed + v_n;
  end if;
 end loop;
 update mavi_private.client_dossier_state set built_at = now(), running_until = null, attempts = 0, last_error = null,
  cursor_at = coalesce(p_cursor_at, cursor_at), cursor_id = coalesce(p_cursor_id, cursor_id),
  version = version + case when v_changed > 0 then 1 else 0 end,
  -- Ainda há material: volta logo. Chegou material durante a leitura: fica pendente.
  dirty_at = case when p_more then now() - interval '1 hour'
   when dirty_at > claimed_at then dirty_at else null end
 where client_id = p_client;
 if p_usage is not null and jsonb_typeof(p_usage) = 'object' then
  insert into public.ai_usage(company_id, user_id, module, kind, client_id, model, input_tokens, output_tokens,
   cache_read_tokens, cache_write_tokens, cost_usd, provider_id, provider_name)
  values (s.company_id, null, 'tasks', 'dossier', p_client, left(coalesce(p_usage->>'model', ''), 80),
   greatest(coalesce((p_usage->>'input')::integer, 0), 0), greatest(coalesce((p_usage->>'output')::integer, 0), 0),
   greatest(coalesce((p_usage->>'cache_read')::integer, 0), 0),
   greatest(coalesce((p_usage->>'cache_write')::integer, 0), 0),
   least(greatest(coalesce((p_usage->>'cost')::numeric, 0), 0), 100),
   case when p_usage->>'provider_id' ~* '^[0-9a-f-]{36}$' then (p_usage->>'provider_id')::uuid end,
   left(coalesce(p_usage->>'provider', ''), 120));
 end if;
 return v_changed;
end $$;

-- Falhou: tenta de novo mais tarde (até 5 vezes; abrir o dossiê não reseta).
create function public.ai_dossier_fail(p_secret text, p_client uuid, p_error text) returns void
language plpgsql security definer set search_path = '' as $$ begin
 if not mavi_private.ai_secret_ok(p_secret) then raise exception 'Sem permissão' using errcode = '42501'; end if;
 update mavi_private.client_dossier_state set attempts = attempts + 1, last_error = left(coalesce(p_error, ''), 500),
  running_until = now() + (attempts + 1) * interval '10 minutes'
 where client_id = p_client;
end $$;

-- pg_cron: acorda o worker só quando há dossiê para ler.
create function mavi_private.ai_dossier_kick() returns void
language plpgsql security definer set search_path = '' as $$
declare cfg mavi_private.ai_config; begin
 select * into cfg from mavi_private.ai_config where id;
 if not found then return; end if;
 if not exists (select 1 from mavi_private.client_dossier_state s
  where s.dirty_at is not null and s.attempts < 5
   and (s.built_at is null or s.dirty_at <= now() - interval '15 minutes')
   and (s.running_until is null or s.running_until < now())) then return; end if;
 perform net.http_post(url := cfg.url, body := '{"action":"ai-dossier"}'::jsonb,
  headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || cfg.secret),
  timeout_milliseconds := 60000);
end $$;

-- ------------------------------------------------------------ copiloto
-- Tudo que o copiloto precisa numa ida ao banco, como quem está criando a
-- tarefa (a busca só devolve o que a pessoa pode ver):
-- - similar: tarefas parecidas do mesmo cliente (com semelhança 0–1); as dos
--   colegas que a pessoa não abre vêm só com título e status (restricted);
-- - cases: cases de sucesso aprovados de qualquer cliente;
-- - com p_review: o dossiê e os trechos do histórico mais próximos, e um
--   freio de 12 análises por minuto por pessoa (throttled).
create function public.task_copilot_context(p_company uuid, p_contract uuid, p_task uuid, p_embedding text,
 p_query text, p_review boolean default false) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_client uuid; v_product text; v_client_name text; v_vec extensions.halfvec(1536); v_similar jsonb;
 v_cases jsonb; v_evidence jsonb := '[]'; s mavi_private.client_dossier_state; v_reader boolean;
 v_visible uuid[]; begin
 if not mavi_private.member(p_company) then raise exception 'Sem acesso' using errcode = '42501'; end if;
 if p_task is not null then
  if not mavi_private.task_access(p_company, p_task) then
   raise exception 'Sem acesso a esta tarefa.' using errcode = '42501';
  end if;
  select t.contract_id into p_contract from public.tasks t where t.company_id = p_company and t.id = p_task;
 end if;
 select ct.client_id, p.name, k.name into v_client, v_product, v_client_name
 from public.contracts ct
 join public.products p on p.company_id = ct.company_id and p.id = ct.product_id
 join public.clients k on k.company_id = ct.company_id and k.id = ct.client_id
 where ct.company_id = p_company and ct.id = p_contract;
 if v_client is null then raise exception 'Produto não encontrado.' using errcode = 'P0002'; end if;
 if p_task is null and not mavi_private.dossier_reader(p_company, v_client) then
  raise exception 'Sem acesso a este cliente.' using errcode = '42501';
 end if;
 if p_review and (select count(*) from public.ai_usage u where u.company_id = p_company and u.user_id = auth.uid()
   and u.kind = 'copilot' and u.created_at > now() - interval '1 minute') >= 12 then
  return jsonb_build_object('throttled', true);
 end if;
 if nullif(p_embedding, '') is not null then v_vec := p_embedding::extensions.halfvec(1536); end if;

 -- Tarefas parecidas: as que a pessoa vê (busca híbrida) e, para quem
 -- atende o cliente, também as dos colegas pelo vetor — dessas, só o título
 -- e o status (restricted), para avisar que o pedido já existe.
 v_reader := mavi_private.dossier_reader(p_company, v_client);
 if not mavi_private.leader(p_company) then v_visible := mavi_private.ai_visible_tasks(p_company); end if;
 select coalesce(jsonb_agg(x order by (x->>'similarity')::numeric desc nulls last), '[]') into v_similar from (
  select case when b.restricted
   then jsonb_build_object('id', b.id, 'title', t.title, 'status', t.status, 'restricted', true,
    'similarity', round(b.sim::numeric, 3))
   else jsonb_build_object('id', b.id, 'title', t.title, 'status', t.status, 'restricted', false,
    'assignee', t.assignee_id, 'due', t.due_date, 'date', b.occurred_at,
    'snippet', left(btrim(regexp_replace(b.content, '^[^\n]*\n', '')), 400),
    'similarity', round(b.sim::numeric, 3)) end as x
  from (
   select distinct on (u.id) u.*, (v_visible is not null and not (u.id = any(v_visible))) as restricted
   from (
    select r.source_id as id, r.content, r.occurred_at, r.score,
     case when v_vec is not null and c.embedding is not null
      then 1 - (c.embedding operator(extensions.<=>) v_vec) end as sim
    from public.ai_search(p_company, p_embedding, p_query,
     jsonb_build_object('client', v_client, 'types', jsonb_build_array('task')), 16) r
    join public.ai_chunks c on c.id = r.chunk_id
    union all
    select k.* from (
     select d.source_id, c.content, c.occurred_at, 0::double precision,
      1 - (c.embedding operator(extensions.<=>) v_vec)
     from public.ai_chunks c join public.ai_documents d on d.id = c.document_id
     where v_reader and v_vec is not null and c.company_id = p_company and c.client_id = v_client
      and c.source_type = 'task' and c.embedding is not null
     order by c.embedding operator(extensions.<=>) v_vec limit 24
    ) k
   ) u
   where u.id is distinct from p_task
   order by u.id, u.sim desc nulls last, u.score desc
  ) b
  join public.tasks t on t.company_id = p_company and t.id = b.id and not t.archived
  order by b.sim desc nulls last limit 6
 ) z;

 select coalesce(jsonb_agg(x order by (x->>'similarity')::numeric desc nulls last), '[]') into v_cases from (
  select jsonb_build_object('id', b.source_id, 'title', b.title, 'date', b.occurred_at,
   'snippet', left(btrim(regexp_replace(b.content, '^[^\n]*\n', '')), 500),
   'similarity', round(b.sim::numeric, 3)) as x
  from (
   select distinct on (r.source_id) r.*, case when v_vec is not null and c.embedding is not null
     then 1 - (c.embedding operator(extensions.<=>) v_vec) end as sim
   from public.ai_search(p_company, p_embedding, p_query,
    jsonb_build_object('types', jsonb_build_array('success_case')), 8) r
   join public.ai_chunks c on c.id = r.chunk_id
   order by r.source_id, sim desc nulls last, r.score desc
  ) b
  order by b.sim desc nulls last limit 3
 ) t;

 if p_review then
  select coalesce(jsonb_agg(jsonb_build_object('type', r.source_type, 'id', r.source_id, 'title', r.title,
    'date', r.occurred_at, 'meta', r.meta, 'contract', r.contract_id, 'content', left(r.content, 1400))
   order by r.score desc), '[]') into v_evidence
  from public.ai_search(p_company, p_embedding, p_query,
   jsonb_build_object('client', v_client, 'types',
    jsonb_build_array('meeting', 'whatsapp', 'drive_file', 'social_briefing', 'social_plan', 'campaign')), 10) r;
  perform mavi_private.dossier_want(p_company, v_client);
  select * into s from mavi_private.client_dossier_state where client_id = v_client;
 end if;

 return jsonb_build_object('throttled', false,
  'client', jsonb_build_object('id', v_client, 'name', v_client_name), 'contract', p_contract, 'product', v_product,
  'similar', v_similar, 'cases', v_cases, 'evidence', v_evidence,
  'dossier', case when p_review then jsonb_build_object('version', coalesce(s.version, 0), 'built_at', s.built_at,
   'items', mavi_private.dossier_items_json(v_client, false)) end);
end $$;

-- O que as pessoas fazem com os alertas (aplicou, útil, não útil, ignorou…):
-- mede a qualidade do copiloto.
create table public.task_copilot_events (
 id bigint generated always as identity primary key,
 company_id uuid not null references public.companies(id),
 user_id uuid default auth.uid(),
 client_id uuid,
 task_id uuid,
 kind text not null,
 severity text not null default '',
 action text not null check (action in ('applied', 'useful', 'not_useful', 'dismissed', 'ignored', 'opened')),
 title text not null default '',
 created_at timestamptz not null default now()
);
create index task_copilot_events_company on public.task_copilot_events (company_id, created_at desc);
alter table public.task_copilot_events enable row level security;
revoke all on public.task_copilot_events from public, anon, authenticated;

create function public.task_copilot_feedback(p_company uuid, p_client uuid, p_task uuid, p_events jsonb)
returns integer
language plpgsql security definer set search_path = '' as $$
declare v_n integer; begin
 if not mavi_private.member(p_company) then raise exception 'Sem acesso' using errcode = '42501'; end if;
 if p_client is not null and not mavi_private.dossier_reader(p_company, p_client) then
  raise exception 'Sem acesso a este cliente.' using errcode = '42501';
 end if;
 if p_task is not null and not mavi_private.task_access(p_company, p_task) then
  raise exception 'Sem acesso a esta tarefa.' using errcode = '42501';
 end if;
 insert into public.task_copilot_events(company_id, client_id, task_id, kind, severity, action, title)
 select p_company, p_client, p_task, left(coalesce(e->>'kind', ''), 20), left(coalesce(e->>'severity', ''), 10),
  e->>'action', left(coalesce(e->>'title', ''), 200)
 from jsonb_array_elements(case when jsonb_typeof(p_events) = 'array' then p_events else '[]' end) with ordinality
  as a(e, n)
 where a.n <= 30 and e->>'action' in ('applied', 'useful', 'not_useful', 'dismissed', 'ignored', 'opened');
 get diagnostics v_n = row_count;
 return v_n;
end $$;

-- ------------------------------------------------------------ permissões
revoke all on function mavi_private.dossier_types(), mavi_private.dossier_touch(),
 mavi_private.dossier_want(uuid, uuid), mavi_private.dossier_bump(uuid),
 mavi_private.dossier_items_json(uuid, boolean), mavi_private.dossier_reader(uuid, uuid),
 mavi_private.ai_dossier_kick() from public, anon, authenticated;
revoke all on function public.client_dossier(uuid, uuid), public.client_dossier_save(uuid, uuid, uuid, text, text),
 public.client_dossier_set(uuid, uuid, text), public.task_copilot_context(uuid, uuid, uuid, text, text, boolean),
 public.task_copilot_feedback(uuid, uuid, uuid, jsonb), public.ai_set_route(uuid, text, uuid, uuid, text, text)
 from public, anon;
grant execute on function public.client_dossier(uuid, uuid), public.client_dossier_save(uuid, uuid, uuid, text, text),
 public.client_dossier_set(uuid, uuid, text), public.task_copilot_context(uuid, uuid, uuid, text, text, boolean),
 public.task_copilot_feedback(uuid, uuid, uuid, jsonb), public.ai_set_route(uuid, text, uuid, uuid, text, text)
 to authenticated;
-- O worker chama como anon + segredo.
revoke all on function public.ai_worker_route(text, uuid, text), public.ai_dossier_claim(text, integer),
 public.ai_dossier_material(text, uuid, timestamptz, uuid, integer, integer),
 public.ai_dossier_store(text, uuid, timestamptz, uuid, boolean, jsonb, jsonb),
 public.ai_dossier_fail(text, uuid, text) from public, anon, authenticated;
grant execute on function public.ai_worker_route(text, uuid, text), public.ai_dossier_claim(text, integer),
 public.ai_dossier_material(text, uuid, timestamptz, uuid, integer, integer),
 public.ai_dossier_store(text, uuid, timestamptz, uuid, boolean, jsonb, jsonb),
 public.ai_dossier_fail(text, uuid, text) to anon, authenticated;

commit;
