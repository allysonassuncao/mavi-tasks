begin;

-- MAVI · anexos na conversa (módulo MAVI):
--
-- 1. Poder novo 'attachments' (Anexos na conversa): documentos (PDF, Word,
--    PowerPoint, Excel, texto, CSV, JSON), imagens, áudios e vídeos curtos.
--    Vem desligado, como os outros.
-- 2. O arquivo vai direto do navegador para o GCS (ai-files/<empresa>/<id>/);
--    o servidor da MAVI lê (extração de texto, descrição e texto das imagens,
--    transcrição de áudio e vídeo), divide em trechos com o nome do arquivo e
--    a página, e vetoriza na hora. Os trechos ficam em ai_chunks como os do
--    resto da base, com acesso 'private': a busca geral (ai_search, ai_read)
--    nunca os devolve; só a busca dos anexos da própria conversa.
-- 3. O mesmo arquivo de novo (mesmo SHA-256, da mesma pessoa): nada sobe nem
--    é lido outra vez; os trechos e os vetores são copiados.
-- As funções de poderes abaixo são as da migração 20261220090000 com
-- 'attachments'; quem as redefinir depois mantém os valores.

alter table public.ai_powers drop constraint ai_powers_power_check;
alter table public.ai_powers add constraint ai_powers_power_check
 check (power in ('visuals', 'images', 'actions', 'skills', 'canvas', 'web', 'mcp', 'scrape', 'attachments'));
alter table public.ai_tool_calls drop constraint ai_tool_calls_power_check;
alter table public.ai_tool_calls add constraint ai_tool_calls_power_check
 check (power in ('visuals', 'images', 'actions', 'skills', 'canvas', 'web', 'mcp', 'scrape', 'attachments'));

create or replace function public.ai_my_powers(p_company uuid) returns text[]
language sql stable security definer set search_path = '' as $$
 select coalesce(array_agg(p order by p), '{}')
 from unnest(array['actions', 'attachments', 'canvas', 'images', 'mcp', 'scrape', 'skills', 'visuals', 'web']) p
 where mavi_private.member(p_company) and mavi_private.ai_power_on(p_company, auth.uid(), p)
$$;

create or replace function public.ai_powers_admin(p_company uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$ begin
 if not mavi_private.leader(p_company) then
  raise exception 'Só administradores e gestores configuram os poderes da MAVI.' using errcode = '42501';
 end if;
 return (select coalesce(jsonb_agg(jsonb_build_object('power', p.power,
   'enabled', coalesce(w.enabled, false), 'everyone', coalesce(w.everyone, true),
   'team_ids', to_jsonb(coalesce(w.team_ids, '{}')), 'user_ids', to_jsonb(coalesce(w.user_ids, '{}')),
   'except_ids', to_jsonb(coalesce(w.except_ids, '{}')), 'updated_at', w.updated_at, 'updated_by', w.updated_by)
   order by p.ord), '[]')
  from unnest(array['visuals', 'images', 'actions', 'canvas', 'attachments', 'web', 'scrape', 'skills', 'mcp'])
   with ordinality p(power, ord)
  left join public.ai_powers w on w.company_id = p_company and w.power = p.power);
end $$;

create or replace function public.ai_set_power(p_company uuid, p_power text, p_enabled boolean, p_everyone boolean,
 p_teams uuid[], p_users uuid[], p_except uuid[]) returns void
language plpgsql security definer set search_path = '' as $$
declare v_teams uuid[]; v_users uuid[]; v_except uuid[]; begin
 if not mavi_private.leader(p_company) then
  raise exception 'Só administradores e gestores configuram os poderes da MAVI.' using errcode = '42501';
 end if;
 if p_power not in ('visuals', 'images', 'actions', 'skills', 'canvas', 'web', 'mcp', 'scrape', 'attachments') then
  raise exception 'Poder inválido.' using errcode = '22023';
 end if;
 select coalesce(array_agg(distinct t), '{}') into v_teams from unnest(coalesce(p_teams, '{}')) t
 where exists (select 1 from public.teams x where x.company_id = p_company and x.id = t);
 select coalesce(array_agg(distinct u), '{}') into v_users from unnest(coalesce(p_users, '{}')) u
 where exists (select 1 from public.memberships x where x.company_id = p_company and x.user_id = u);
 select coalesce(array_agg(distinct u), '{}') into v_except from unnest(coalesce(p_except, '{}')) u
 where exists (select 1 from public.memberships x where x.company_id = p_company and x.user_id = u);
 if coalesce(p_enabled, false) and not coalesce(p_everyone, true)
  and cardinality(v_teams) = 0 and cardinality(v_users) = 0 then
  raise exception 'Escolha pelo menos uma equipe ou pessoa (ou libere para todos).' using errcode = '22023';
 end if;
 insert into public.ai_powers(company_id, power, enabled, everyone, team_ids, user_ids, except_ids, updated_by)
 values (p_company, p_power, coalesce(p_enabled, false), coalesce(p_everyone, true), v_teams, v_users, v_except,
  auth.uid())
 on conflict (company_id, power) do update set enabled = excluded.enabled, everyone = excluded.everyone,
  team_ids = excluded.team_ids, user_ids = excluded.user_ids, except_ids = excluded.except_ids,
  updated_by = auth.uid(), updated_at = now();
end $$;

create or replace function public.ai_log_tool_calls(p_company uuid, p_conversation uuid, p_module text, p_calls jsonb)
returns void
language plpgsql security definer set search_path = '' as $$
declare v_conversation uuid := p_conversation; begin
 if not mavi_private.member(p_company) then raise exception 'Sem permissão.' using errcode = '42501'; end if;
 if jsonb_typeof(coalesce(p_calls, '[]')) <> 'array' or jsonb_array_length(coalesce(p_calls, '[]')) > 60 then
  raise exception 'Lista de chamadas inválida.' using errcode = '22023';
 end if;
 if v_conversation is not null and not exists (select 1 from public.ai_conversations v
  where v.company_id = p_company and v.id = v_conversation and v.owner_id = auth.uid()) then
  v_conversation := null;
 end if;
 insert into public.ai_tool_calls(company_id, conversation_id, module, tool, power, ok, duration_ms, cost_usd, error,
  skill_id, skill_version)
 select p_company, v_conversation, left(coalesce(p_module, 'assistant'), 40), left(x.tool, 80),
  case when x.power in ('visuals', 'images', 'actions', 'skills', 'canvas', 'web', 'mcp', 'scrape', 'attachments')
   then x.power end,
  coalesce(x.ok, false),
  least(greatest(coalesce(x.ms, 0), 0), 3600000), least(greatest(coalesce(x.cost, 0), 0), 100),
  left(x.error, 300),
  (select k.id from public.ai_skills k where k.company_id = p_company and k.id = x.skill),
  case when exists (select 1 from public.ai_skills k where k.company_id = p_company and k.id = x.skill)
   then x.skill_version end
 from jsonb_to_recordset(coalesce(p_calls, '[]')) as x(tool text, power text, ok boolean, ms integer, cost numeric,
  error text, skill uuid, skill_version integer)
 where coalesce(btrim(x.tool), '') <> '';
end $$;

-- ------------------------------------------------------------ base
alter table public.ai_documents drop constraint ai_documents_source_type_check;
alter table public.ai_documents add constraint ai_documents_source_type_check
 check (source_type in ('meeting', 'task', 'drive_file', 'social_plan', 'social_briefing', 'campaign',
  'success_case', 'whatsapp', 'ai_attachment'));
-- 'private': só a busca dos anexos da conversa devolve (a geral não conhece).
alter table public.ai_documents drop constraint ai_documents_access_check;
alter table public.ai_documents add constraint ai_documents_access_check
 check (access in ('client', 'task', 'contract', 'leader', 'private'));

create table public.ai_attachments (
 id uuid primary key default gen_random_uuid(),
 company_id uuid not null references public.companies(id) on delete cascade,
 owner_id uuid not null references auth.users(id) on delete cascade,
 -- Sem conversa até a pergunta ser enviada.
 conversation_id uuid references public.ai_conversations(id) on delete cascade,
 name text not null check (length(btrim(name)) between 1 and 200),
 mime text not null check (length(mime) <= 120),
 size_bytes bigint not null check (size_bytes between 1 and 52428800),
 kind text not null check (kind in ('document', 'image', 'audio', 'video')),
 sha256 text check (sha256 ~ '^[0-9a-f]{64}$'),
 path text not null check (path ~ '^ai-files/[0-9a-f-]{36}/[0-9a-f-]{36}/'),
 status text not null default 'uploading'
  check (status in ('uploading', 'processing', 'ready', 'empty', 'error', 'unsupported')),
 error text check (length(error) <= 300),
 pages integer,
 chars integer,
 -- O começo do texto (ou a descrição da imagem), para a tela e para a MAVI.
 preview text check (length(preview) <= 600),
 created_at timestamptz not null default now(),
 processed_at timestamptz
);
create index ai_attachments_conversation on public.ai_attachments(conversation_id, created_at);
create index ai_attachments_owner_hash on public.ai_attachments(company_id, owner_id, sha256) where status = 'ready';
alter table public.ai_attachments enable row level security;
revoke all on public.ai_attachments from public, anon, authenticated;
grant select on public.ai_attachments to authenticated;
-- Quem vê a conversa vê a lista dos anexos dela; os soltos, só quem enviou.
create policy ai_attachments_read on public.ai_attachments for select to authenticated
 using (company_id in (select mavi_private.active_companies())
  and (owner_id = (select auth.uid())
   or (conversation_id is not null and mavi_private.ai_conversation_visible(company_id, conversation_id))));

create function mavi_private.ai_attachment_mine(p_attachment uuid) returns public.ai_attachments
language plpgsql stable security definer set search_path = '' as $$
declare a public.ai_attachments; begin
 select * into a from public.ai_attachments where id = p_attachment and owner_id = auth.uid();
 if a.id is null or not mavi_private.member(a.company_id) then
  raise exception 'Anexo não encontrado.' using errcode = 'P0002';
 end if;
 return a;
end $$;
revoke all on function mavi_private.ai_attachment_mine(uuid) from public, anon, authenticated;

create function mavi_private.ai_attachment_view(a public.ai_attachments) returns jsonb
language sql immutable set search_path = '' as $$
 select jsonb_build_object('id', a.id, 'conversation', a.conversation_id, 'name', a.name, 'mime', a.mime,
  'size', a.size_bytes, 'kind', a.kind, 'status', a.status, 'error', a.error, 'pages', a.pages,
  'chars', a.chars, 'preview', a.preview, 'created_at', a.created_at)
$$;
revoke all on function mavi_private.ai_attachment_view(public.ai_attachments) from public, anon, authenticated;

-- Cria o anexo (antes de subir). Com o mesmo arquivo já lido pela pessoa, copia
-- os trechos e os vetores e o anexo já nasce pronto (nada sobe).
create function public.ai_attachment_create(p_company uuid, p_conversation uuid, p_name text, p_mime text,
 p_size bigint, p_kind text, p_sha256 text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_id uuid := gen_random_uuid(); v_name text := left(btrim(regexp_replace(coalesce(p_name, ''), '[\/\\\x00-\x1f]', '_', 'g')), 200);
 old public.ai_attachments; a public.ai_attachments; v_doc uuid; v_src uuid; v_max bigint; begin
 if not mavi_private.member(p_company) then raise exception 'Sem acesso ao espaço' using errcode = '42501'; end if;
 if not mavi_private.ai_power_on(p_company, auth.uid(), 'attachments') then
  raise exception 'Os anexos na conversa não estão liberados para você. Um administrador ou gestor libera em Painel da MAVI › Poderes.'
   using errcode = '42501';
 end if;
 if p_conversation is not null and not exists (select 1 from public.ai_conversations v
  where v.company_id = p_company and v.id = p_conversation and v.owner_id = auth.uid()) then
  raise exception 'Só quem começou a conversa anexa nela.' using errcode = '42501';
 end if;
 if length(v_name) = 0 then raise exception 'Arquivo sem nome.' using errcode = '22023'; end if;
 if p_kind not in ('document', 'image', 'audio', 'video') then
  raise exception 'Tipo de arquivo não aceito.' using errcode = '22023';
 end if;
 v_max := case when p_kind in ('audio', 'video') then 26214400 else 52428800 end;
 if p_size is null or p_size < 1 or p_size > v_max then
  raise exception 'Arquivo grande demais: até 50 MB (áudio e vídeo até 25 MB).' using errcode = '22023';
 end if;
 if p_conversation is not null and (select count(*) from public.ai_attachments x
  where x.conversation_id = p_conversation) >= 40 then
  raise exception 'Esta conversa já tem 40 anexos: comece uma nova.' using errcode = '22023';
 end if;
 -- Até 60 arquivos por pessoa por hora (o que mais pesa é ler e vetorizar).
 if (select count(*) from public.ai_attachments x where x.owner_id = auth.uid() and x.company_id = p_company
  and x.created_at > now() - interval '1 hour') >= 60 then
  raise exception 'Muitos anexos em pouco tempo: tente de novo daqui a pouco.' using errcode = '54000';
 end if;
 if p_sha256 ~ '^[0-9a-f]{64}$' then
  select * into old from public.ai_attachments x where x.company_id = p_company and x.owner_id = auth.uid()
   and x.sha256 = p_sha256 and x.status = 'ready' order by x.created_at desc limit 1;
 end if;
 insert into public.ai_attachments(id, company_id, owner_id, conversation_id, name, mime, size_bytes, kind, sha256,
  path, status, pages, chars, preview, processed_at)
 values (v_id, p_company, auth.uid(), p_conversation, v_name, left(coalesce(p_mime, ''), 120), p_size, p_kind,
  case when p_sha256 ~ '^[0-9a-f]{64}$' then p_sha256 end,
  coalesce(old.path, 'ai-files/' || p_company || '/' || v_id || '/'
   || left(regexp_replace(regexp_replace(v_name, '[^A-Za-z0-9._-]+', '_', 'g'), '_{2,}', '_', 'g'), 120)),
  case when old.id is null then 'uploading' else 'ready' end, old.pages, old.chars, old.preview,
  case when old.id is not null then now() end)
 returning * into a;
 if old.id is not null then
  select id into v_src from public.ai_documents where company_id = p_company and source_type = 'ai_attachment'
   and source_id = old.id;
  if v_src is not null then
   insert into public.ai_documents(company_id, source_type, source_id, access, title, occurred_at, content_hash)
   select company_id, source_type, a.id, access, a.name, now(), content_hash from public.ai_documents where id = v_src
   returning id into v_doc;
   insert into public.ai_chunks(company_id, document_id, ord, content, meta, source_type, access, occurred_at,
    embedding, embedding_model)
   select c.company_id, v_doc, c.ord,
    replace(c.content, '“' || old.name || '”', '“' || a.name || '”'),
    c.meta || jsonb_build_object('attachment', a.id), c.source_type, c.access, now(), c.embedding, c.embedding_model
   from public.ai_chunks c where c.document_id = v_src;
  end if;
 end if;
 return mavi_private.ai_attachment_view(a) || jsonb_build_object('path', a.path, 'reused', old.id is not null);
end $$;

-- Como o anexo está (de quem enviou).
create function public.ai_attachment_get(p_attachment uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare a public.ai_attachments; begin
 a := mavi_private.ai_attachment_mine(p_attachment);
 return mavi_private.ai_attachment_view(a);
end $$;

-- O servidor começa a ler (depois do upload): devolve o que precisa.
create function public.ai_attachment_begin(p_attachment uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare a public.ai_attachments; begin
 a := mavi_private.ai_attachment_mine(p_attachment);
 if a.status = 'ready' then return mavi_private.ai_attachment_view(a) || jsonb_build_object('path', a.path); end if;
 if a.status = 'processing' and a.processed_at > now() - interval '3 minutes' then
  raise exception 'O anexo já está sendo lido.' using errcode = '55000';
 end if;
 update public.ai_attachments set status = 'processing', error = null, processed_at = now()
 where id = a.id returning * into a;
 return mavi_private.ai_attachment_view(a) || jsonb_build_object('path', a.path, 'company', a.company_id);
end $$;

-- O fim da leitura: guarda os trechos (com o nome do arquivo e a página em
-- cada um) e devolve os que faltam vetorizar, para o servidor fazer na hora.
create function public.ai_attachment_finish(p_attachment uuid, p_status text, p_pages jsonb, p_error text)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare a public.ai_attachments; v_pieces jsonb; v_chars integer; v_pages integer; v_preview text; begin
 a := mavi_private.ai_attachment_mine(p_attachment);
 if p_status not in ('ready', 'empty', 'error', 'unsupported') then
  raise exception 'Situação inválida.' using errcode = '22023';
 end if;
 if p_status = 'ready' then
  if jsonb_typeof(p_pages) <> 'array' or jsonb_array_length(p_pages) = 0 or length(p_pages::text) > 2000000 then
   raise exception 'Conteúdo inválido.' using errcode = '22023';
  end if;
  select coalesce(sum(length(pg->>'text')), 0), count(*),
   left(regexp_replace(string_agg(pg->>'text', ' ' order by n), '\s+', ' ', 'g'), 600)
   into v_chars, v_pages, v_preview
  from jsonb_array_elements(p_pages) with ordinality x(pg, n);
  select coalesce(jsonb_agg(jsonb_build_object(
    'text', case when nullif(btrim(pg->>'label'), '') is null then part else (pg->>'label') || ': ' || part end,
    'meta', jsonb_build_object('kind', 'attachment', 'attachment', a.id, 'page', n,
     'label', nullif(btrim(pg->>'label'), ''))) order by n, k), '[]')
   into v_pieces
  from jsonb_array_elements(p_pages) with ordinality x(pg, n),
   lateral mavi_private.ai_split(coalesce(pg->>'text', ''), 1500) with ordinality s(part, k)
  where length(btrim(part)) > 0;
  perform mavi_private.ai_save_document(a.company_id, 'ai_attachment', a.id, 'private', null, null, null, null,
   a.name, a.created_at, 'Anexo “' || a.name || '”', v_pieces);
 end if;
 update public.ai_attachments set status = p_status, error = left(p_error, 300), processed_at = now(),
  chars = case when p_status = 'ready' then v_chars end, pages = case when p_status = 'ready' then v_pages end,
  preview = case when p_status = 'ready' then v_preview end
 where id = a.id;
 return (select coalesce(jsonb_agg(jsonb_build_object('id', c.id, 'content', c.content) order by c.ord), '[]')
  from public.ai_chunks c join public.ai_documents d on d.id = c.document_id
  where d.company_id = a.company_id and d.source_type = 'ai_attachment' and d.source_id = a.id
   and c.embedding is null);
end $$;

-- Os vetores dos trechos do anexo (o worker de sempre faz o que faltar).
create function public.ai_attachment_store_embeddings(p_attachment uuid, p_model text, p_items jsonb)
returns integer
language plpgsql security definer set search_path = '' as $$
declare a public.ai_attachments; n integer; begin
 a := mavi_private.ai_attachment_mine(p_attachment);
 update public.ai_chunks c set embedding = (i->>'embedding')::extensions.halfvec(1536),
  embedding_model = left(p_model, 80), claimed_at = null
 from jsonb_array_elements(coalesce(p_items, '[]')) i, public.ai_documents d
 where c.id = (i->>'id')::bigint and c.document_id = d.id and d.company_id = a.company_id
  and d.source_type = 'ai_attachment' and d.source_id = a.id and c.embedding is null;
 get diagnostics n = row_count;
 return n;
end $$;

-- A pergunta foi enviada: os anexos soltos passam a ser da conversa.
create function public.ai_attachments_link(p_conversation uuid, p_ids uuid[]) returns integer
language plpgsql security definer set search_path = '' as $$
declare v_company uuid; n integer; begin
 select company_id into v_company from public.ai_conversations where id = p_conversation and owner_id = auth.uid();
 if v_company is null or not mavi_private.member(v_company) then
  raise exception 'Só quem começou a conversa anexa nela.' using errcode = '42501';
 end if;
 update public.ai_attachments set conversation_id = p_conversation
 where id = any(coalesce(p_ids, '{}')) and owner_id = auth.uid() and company_id = v_company
  and (conversation_id is null or conversation_id = p_conversation);
 get diagnostics n = row_count;
 return n;
end $$;

create function public.ai_attachments_list(p_conversation uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
 select coalesce(jsonb_agg(mavi_private.ai_attachment_view(a) order by a.created_at), '[]')
 from public.ai_attachments a join public.ai_conversations v on v.id = a.conversation_id
 where a.conversation_id = p_conversation and mavi_private.ai_conversation_visible(v.company_id, v.id)
$$;

-- Busca nos anexos da conversa (quem começou a conversa): vetores + texto,
-- juntados por RRF, como a busca geral.
create function public.ai_attachment_search(p_conversation uuid, p_embedding text, p_query text,
 p_limit integer default 8, p_ids uuid[] default null)
returns table(chunk_id bigint, attachment_id uuid, name text, content text, meta jsonb, score double precision)
language plpgsql stable security definer set search_path = '' as $$
#variable_conflict use_column
declare v_company uuid; v_docs uuid[]; v_vec extensions.halfvec(1536); v_tq tsquery;
 v_limit integer := least(greatest(coalesce(p_limit, 8), 1), 20); begin
 select company_id into v_company from public.ai_conversations where id = p_conversation and owner_id = auth.uid();
 if v_company is null or not mavi_private.member(v_company) then
  raise exception 'Conversa não encontrada.' using errcode = 'P0002';
 end if;
 select coalesce(array_agg(d.id), '{}') into v_docs
 from public.ai_documents d join public.ai_attachments a on a.id = d.source_id
 where d.company_id = v_company and d.source_type = 'ai_attachment' and a.conversation_id = p_conversation
  and a.status = 'ready' and (p_ids is null or a.id = any(p_ids));
 if cardinality(v_docs) = 0 then return; end if;
 begin
  v_vec := p_embedding::extensions.halfvec(1536);
 exception when others then v_vec := null;
 end;
 begin
  v_tq := nullif(replace(plainto_tsquery('portuguese', coalesce(p_query, ''))::text, ' & ', ' | '), '')::tsquery;
 exception when others then v_tq := null;
 end;
 return query
 with vec as (
  select c.id, row_number() over (order by c.embedding operator(extensions.<=>) v_vec) as r
  from public.ai_chunks c
  where v_vec is not null and c.document_id = any(v_docs) and c.embedding is not null
  order by c.embedding operator(extensions.<=>) v_vec limit 40),
 txt as (
  select c.id, row_number() over (order by ts_rank_cd(c.search, v_tq) desc) as r
  from public.ai_chunks c
  where v_tq is not null and c.document_id = any(v_docs) and c.search @@ v_tq
  order by ts_rank_cd(c.search, v_tq) desc limit 40),
 fused as (
  select u.id, sum(1.0 / (60 + u.r))::double precision as s from (select * from vec union all select * from txt) u
  group by u.id)
 select c.id, d.source_id, d.title, c.content, c.meta, f.s
 from fused f join public.ai_chunks c on c.id = f.id join public.ai_documents d on d.id = c.document_id
 order by f.s desc limit v_limit;
end $$;

-- O anexo inteiro (ou a partir de um trecho), até p_max caracteres.
create function public.ai_attachment_read(p_attachment uuid, p_from integer default 0, p_max integer default 30000)
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare a public.ai_attachments; v_parts jsonb := '[]'; v_size integer := 0; v_more boolean := false; r record;
 v_max integer := least(greatest(coalesce(p_max, 30000), 1000), 60000); begin
 select * into a from public.ai_attachments where id = p_attachment;
 if a.id is null or a.conversation_id is null or not exists (select 1 from public.ai_conversations v
  where v.id = a.conversation_id and v.owner_id = auth.uid()) or not mavi_private.member(a.company_id) then
  raise exception 'Anexo não encontrado.' using errcode = 'P0002';
 end if;
 for r in select c.ord, c.meta, substr(c.content, strpos(c.content, E'\n') + 1) as body
  from public.ai_chunks c join public.ai_documents d on d.id = c.document_id
  where d.company_id = a.company_id and d.source_type = 'ai_attachment' and d.source_id = a.id
   and c.ord >= coalesce(p_from, 0)
  order by c.ord loop
  if v_size + length(r.body) > v_max and v_size > 0 then v_more := true; exit; end if;
  v_parts := v_parts || jsonb_build_object('ord', r.ord, 'label', r.meta->>'label', 'text', r.body);
  v_size := v_size + length(r.body);
 end loop;
 return jsonb_build_object('id', a.id, 'name', a.name, 'kind', a.kind, 'pages', a.pages, 'chars', a.chars,
  'parts', v_parts, 'more', v_more);
end $$;

-- Tirar o anexo: sai da base; o servidor apaga o arquivo se ninguém mais usa.
create function public.ai_attachment_delete(p_attachment uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare a public.ai_attachments; begin
 a := mavi_private.ai_attachment_mine(p_attachment);
 perform mavi_private.ai_forget('ai_attachment', a.id);
 delete from public.ai_attachments where id = a.id;
 return jsonb_build_object('path', a.path,
  'last', not exists (select 1 from public.ai_attachments x where x.path = a.path));
end $$;

-- Para abrir o arquivo (link assinado pelo servidor): quem vê a conversa.
create function public.ai_attachment_file(p_attachment uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
 select jsonb_build_object('path', a.path, 'name', a.name, 'mime', a.mime)
 from public.ai_attachments a
 where a.id = p_attachment and mavi_private.member(a.company_id)
  and (a.owner_id = auth.uid() or (a.conversation_id is not null
   and mavi_private.ai_conversation_visible(a.company_id, a.conversation_id)))
$$;

revoke all on function public.ai_attachment_create(uuid, uuid, text, text, bigint, text, text),
 public.ai_attachment_begin(uuid), public.ai_attachment_finish(uuid, text, jsonb, text),
 public.ai_attachment_store_embeddings(uuid, text, jsonb), public.ai_attachments_link(uuid, uuid[]),
 public.ai_attachments_list(uuid), public.ai_attachment_search(uuid, text, text, integer, uuid[]),
 public.ai_attachment_read(uuid, integer, integer), public.ai_attachment_delete(uuid),
 public.ai_attachment_file(uuid), public.ai_attachment_get(uuid) from public, anon;
grant execute on function public.ai_attachment_create(uuid, uuid, text, text, bigint, text, text),
 public.ai_attachment_begin(uuid), public.ai_attachment_finish(uuid, text, jsonb, text),
 public.ai_attachment_store_embeddings(uuid, text, jsonb), public.ai_attachments_link(uuid, uuid[]),
 public.ai_attachments_list(uuid), public.ai_attachment_search(uuid, text, text, integer, uuid[]),
 public.ai_attachment_read(uuid, integer, integer), public.ai_attachment_delete(uuid),
 public.ai_attachment_file(uuid), public.ai_attachment_get(uuid) to authenticated;

commit;
