begin;

-- IA do MAVI · base de conhecimento (fase 1: Gravações da MAVI e tarefas).
--
-- Tudo que a IA consulta vira documentos (um por item do SaaS: reunião,
-- tarefa…) quebrados em trechos. Cada trecho tem o texto (com um cabeçalho
-- de contexto: cliente, produto, título, data), o índice de texto completo
-- e o vetor de significado (embedding). A busca é híbrida — vetor + texto,
-- fundidos por RRF — e já sai filtrada pelas permissões de quem pergunta,
-- seja qual for o modelo de linguagem por trás.
--
-- Indexação sem polling:
--  1. triggers colocam o item mudado na fila (mudanças repetidas se juntam);
--  2. o worker (api/drive.ts, ação "ai-index", chamado pelo pg_cron via
--     mavi_private.ai_kick) refaz os trechos do item no banco — só quando o
--     texto mudou (hash) — e gera os vetores em lotes;
--  3. status, responsável e prazo de tarefas não entram no texto: vêm ao vivo
--     na busca, então mudar o status não gera vetores novos.
--
-- Configuração (uma vez, fora do git):
--   insert into mavi_private.ai_config(url, secret)
--   values ('https://<app>/api/ai', '<AI_WORKER_SECRET>');
-- e supabase/operations/schedule-ai-index.sql para o agendamento.

create extension if not exists vector with schema extensions;

create table mavi_private.ai_config (
 id boolean primary key default true check (id),
 url text not null check (url ~ '^https://'),
 secret text not null check (length(secret) >= 32)
);
alter table mavi_private.ai_config enable row level security;
revoke all on mavi_private.ai_config from public, anon, authenticated;

create function mavi_private.ai_secret_ok(p_secret text) returns boolean
language sql stable security definer set search_path = '' as $$
 select p_secret is not null and exists (select 1 from mavi_private.ai_config where id and secret = p_secret)
$$;
revoke all on function mavi_private.ai_secret_ok(text) from public, anon, authenticated;

-- ------------------------------------------------------------ tabelas
-- access: como decidir quem vê — 'client' (regra do Drive pelo cliente) ou
-- 'task' (quem vê a tarefa). Fontes novas escolhem uma (ou ganham outra).
create table public.ai_documents (
 id uuid primary key default gen_random_uuid(),
 company_id uuid not null references public.companies(id),
 source_type text not null check (source_type in ('meeting', 'task')),
 source_id uuid not null,
 access text not null check (access in ('client', 'task')),
 client_id uuid,
 contract_id uuid,
 project_id uuid,
 task_id uuid,
 title text not null default '',
 occurred_at timestamptz,
 content_hash text not null,
 indexed_at timestamptz not null default now(),
 unique(company_id, id),
 unique(company_id, source_type, source_id)
);
alter table public.ai_documents enable row level security;
revoke all on public.ai_documents from public, anon, authenticated;

-- Os filtros vivem no próprio trecho (copiados do documento): a busca filtra
-- dentro da varredura do índice, sem joins.
create table public.ai_chunks (
 id bigint generated always as identity primary key,
 company_id uuid not null,
 document_id uuid not null,
 ord integer not null,
 content text not null,
 meta jsonb not null default '{}',
 source_type text not null,
 access text not null,
 client_id uuid,
 contract_id uuid,
 project_id uuid,
 task_id uuid,
 occurred_at timestamptz,
 search tsvector generated always as (to_tsvector('portuguese'::regconfig, content)) stored,
 embedding extensions.halfvec(1536),
 embedding_model text,
 claimed_at timestamptz,
 foreign key(company_id, document_id) references public.ai_documents(company_id, id) on delete cascade
);
create index ai_chunks_embedding on public.ai_chunks using hnsw (embedding extensions.halfvec_cosine_ops);
create index ai_chunks_search on public.ai_chunks using gin (search);
create index ai_chunks_scope on public.ai_chunks (company_id, client_id, occurred_at desc);
create index ai_chunks_document on public.ai_chunks (document_id, ord);
create index ai_chunks_pending on public.ai_chunks (id) where embedding is null;
alter table public.ai_chunks enable row level security;
revoke all on public.ai_chunks from public, anon, authenticated;

create table mavi_private.ai_queue (
 source_type text not null,
 source_id uuid not null,
 company_id uuid not null,
 enqueued_at timestamptz not null default now(),
 attempts integer not null default 0,
 last_error text,
 primary key (source_type, source_id)
);
create index ai_queue_order on mavi_private.ai_queue (enqueued_at);
revoke all on mavi_private.ai_queue from public, anon, authenticated;

-- Quanto a IA custou, com as dimensões do painel e dos limites (fase 2).
create table public.ai_usage (
 id bigint generated always as identity primary key,
 company_id uuid not null references public.companies(id),
 user_id uuid default auth.uid(),
 module text not null default '',
 kind text not null,
 client_id uuid,
 contract_id uuid,
 project_id uuid,
 recording_id uuid,
 model text not null default '',
 input_tokens integer not null default 0,
 output_tokens integer not null default 0,
 cache_read_tokens integer not null default 0,
 cache_write_tokens integer not null default 0,
 embedding_tokens integer not null default 0,
 cost_usd numeric(12,6) not null default 0,
 created_at timestamptz not null default now()
);
create index ai_usage_company on public.ai_usage (company_id, created_at desc);
create index ai_usage_user on public.ai_usage (company_id, user_id, created_at desc);
alter table public.ai_usage enable row level security;
revoke all on public.ai_usage from public, anon, authenticated;
grant select on public.ai_usage to authenticated;
create policy ai_usage_read on public.ai_usage for select to authenticated
 using (company_id in (select mavi_private.leader_companies()));

-- O custo das perguntas às gravações passa para a tabela geral.
insert into public.ai_usage(company_id, user_id, module, kind, client_id, recording_id, model, input_tokens,
 output_tokens, cache_read_tokens, cache_write_tokens, cost_usd, created_at)
select company_id, user_id, 'meetings', kind, client_id, recording_id, model, input_tokens, output_tokens,
 cache_read_tokens, cache_write_tokens, cost_usd, created_at
from public.meeting_ai_usage;
drop function public.meeting_log_usage(uuid, uuid, text, text, integer, integer, integer, integer, numeric);
drop table public.meeting_ai_usage;

create function public.ai_log_usage(p_company uuid, p_module text, p_kind text, p_client uuid, p_contract uuid,
 p_project uuid, p_recording uuid, p_model text, p_input integer, p_output integer, p_cache_read integer,
 p_cache_write integer, p_embedding integer, p_cost numeric) returns void
language plpgsql security definer set search_path = '' as $$ begin
 if not mavi_private.member(p_company) then raise exception 'Sem permissão.' using errcode = '42501'; end if;
 if p_client is not null and not mavi_private.drive_can_read(p_company, p_client) then
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
revoke all on function public.ai_log_usage(uuid, text, text, uuid, uuid, uuid, uuid, text, integer, integer,
 integer, integer, integer, numeric) from public, anon;
grant execute on function public.ai_log_usage(uuid, text, text, uuid, uuid, uuid, uuid, text, integer, integer,
 integer, integer, integer, numeric) to authenticated;

-- ------------------------------------------------------------ montagem dos trechos
-- Um texto longo em pedaços de ~p_size caracteres, cortando em parágrafos e,
-- se preciso, em frases.
create function mavi_private.ai_split(p_text text, p_size integer default 1500) returns setof text
language plpgsql immutable set search_path = '' as $$
declare part text; buf text := ''; piece text; begin
 for part in select unnest(regexp_split_to_array(coalesce(p_text, ''), E'\\n\\s*\\n')) loop
  part := btrim(part, E' \n\t\r');
  continue when part = '';
  if length(part) > p_size then
   for piece in select unnest(regexp_split_to_array(part, E'(?<=[.!?…])\\s+')) loop
    if length(buf) + length(piece) + 1 > p_size and buf <> '' then return next buf; buf := ''; end if;
    buf := btrim(buf || ' ' || piece, E' \n\t\r');
   end loop;
  else
   if length(buf) + length(part) + 2 > p_size and buf <> '' then return next buf; buf := ''; end if;
   buf := btrim(buf || E'\n\n' || part, E' \n\t\r');
  end if;
 end loop;
 if buf <> '' then return next buf; end if;
end $$;

-- Grava o documento e os trechos, só quando o texto mudou.
create function mavi_private.ai_save_document(c uuid, p_type text, p_source uuid, p_access text, p_client uuid,
 p_contract uuid, p_project uuid, p_task uuid, p_title text, p_at timestamptz, p_header text, p_pieces jsonb)
returns void
language plpgsql security definer set search_path = '' as $$
declare v_hash text; v_doc uuid; v_old text; begin
 v_hash := md5(p_header || p_pieces::text || coalesce(p_client::text, '') || coalesce(p_contract::text, '')
  || coalesce(p_project::text, ''));
 select id, content_hash into v_doc, v_old from public.ai_documents
  where company_id = c and source_type = p_type and source_id = p_source;
 if v_old = v_hash then return; end if;
 if v_doc is null then
  insert into public.ai_documents(company_id, source_type, source_id, access, client_id, contract_id, project_id,
   task_id, title, occurred_at, content_hash)
  values (c, p_type, p_source, p_access, p_client, p_contract, p_project, p_task, left(p_title, 300), p_at, v_hash)
  returning id into v_doc;
 else
  update public.ai_documents set access = p_access, client_id = p_client, contract_id = p_contract,
   project_id = p_project, task_id = p_task, title = left(p_title, 300), occurred_at = p_at,
   content_hash = v_hash, indexed_at = now()
  where id = v_doc;
  delete from public.ai_chunks where document_id = v_doc;
 end if;
 insert into public.ai_chunks(company_id, document_id, ord, content, meta, source_type, access, client_id,
  contract_id, project_id, task_id, occurred_at)
 select c, v_doc, (p.n - 1)::integer, p_header || E'\n' || (p.v->>'text'), coalesce(p.v->'meta', '{}'),
  p_type, p_access, p_client, p_contract, p_project, p_task, p_at
 from jsonb_array_elements(p_pieces) with ordinality p(v, n)
 where length(btrim(p.v->>'text')) > 0;
end $$;

create function mavi_private.ai_forget(p_type text, p_source uuid) returns void
language sql security definer set search_path = '' as $$
 delete from public.ai_documents where source_type = p_type and source_id = p_source
$$;

create function mavi_private.ai_clock(p numeric) returns text
language sql immutable set search_path = '' as $$
 select case when p >= 3600 then to_char(make_interval(secs => floor(p)), 'FMHH24:MI:SS')
  else to_char(make_interval(secs => floor(p)), 'MI:SS') end
$$;

-- Reunião: um trecho com o resumo e trechos da transcrição (~900
-- caracteres, uns 30 a 60 s de conversa, com o minuto de início: a citação
-- abre o vídeo perto do momento exato).
create function mavi_private.ai_build_meeting(p_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare r record; v_pieces jsonb := '[]'; v_summary text; s jsonb; v_line text; buf text := '';
 buf_start numeric; buf_end numeric; v_start numeric; v_name text; v_header text; begin
 select m.*, k.name as client_name, t.speakers as t_speakers, t.segments
  into r from public.meeting_recordings m
  join public.clients k on k.company_id = m.company_id and k.id = m.client_id
  left join public.meeting_transcripts t on t.company_id = m.company_id and t.recording_id = m.id
  where m.id = p_id;
 if not found then perform mavi_private.ai_forget('meeting', p_id); return; end if;
 v_header := format('[Reunião] "%s" · cliente %s · %s · gravada por %s',
  coalesce(nullif(r.summary->>'title', ''), nullif(r.title, ''), 'sem título'), r.client_name,
  to_char(r.recorded_at at time zone 'America/Sao_Paulo', 'DD/MM/YYYY'), split_part(r.recorded_by_email, '@', 1));
 v_summary := concat_ws(E'\n',
  case when r.title <> '' then 'Agenda: ' || r.title end,
  case when r.summary->>'overview' is not null then 'Resumo: ' || (r.summary->>'overview') end,
  (select string_agg('- ' || (n->>'title') || ': ' || (n->>'description'), E'\n')
    from jsonb_array_elements(coalesce(r.summary->'notes', '[]')) n),
  (select 'Próximos passos:' || E'\n' || string_agg('- ' || concat_ws(' · ', nullif(a->>'owner', ''),
     a->>'description', nullif(a->>'deadline', '')), E'\n')
    from jsonb_array_elements(coalesce(r.summary->'action_items', '[]') || coalesce(r.summary->'todo', '[]')) a),
  (select 'Palavras-chave: ' || string_agg(k2, ', ') from jsonb_array_elements_text(coalesce(r.summary->'keywords', '[]')) k2),
  case when cardinality(r.speakers) > 0 then 'Participantes: ' || array_to_string(r.speakers, ', ') end);
 if btrim(coalesce(v_summary, '')) <> '' then
  v_pieces := v_pieces || jsonb_build_array(jsonb_build_object('text', v_summary, 'meta', jsonb_build_object('kind', 'summary')));
 end if;
 for s in select value from jsonb_array_elements(coalesce(r.segments, '[]')) loop
  v_start := case when jsonb_typeof(s->0) = 'number' then (s->>0)::numeric end;
  v_name := coalesce(nullif(r.t_speakers[((s->>2)::integer) + 1], ''),
   'Falante ' || (coalesce((s->>2)::integer, 0) + 1));
  v_line := case when v_start is not null then '[' || mavi_private.ai_clock(v_start) || '] ' else '' end
   || v_name || ': ' || (s->>3);
  if buf <> '' and length(buf) + length(v_line) > 900 then
   v_pieces := v_pieces || jsonb_build_array(jsonb_build_object('text', buf,
    'meta', jsonb_strip_nulls(jsonb_build_object('kind', 'transcript', 'start', buf_start, 'end', buf_end))));
   buf := ''; buf_start := null;
  end if;
  if buf = '' then buf_start := v_start; end if;
  buf := case when buf = '' then v_line else buf || E'\n' || v_line end;
  buf_end := case when jsonb_typeof(s->1) = 'number' then (s->>1)::numeric else buf_end end;
 end loop;
 if buf <> '' then
  v_pieces := v_pieces || jsonb_build_array(jsonb_build_object('text', buf,
   'meta', jsonb_strip_nulls(jsonb_build_object('kind', 'transcript', 'start', buf_start, 'end', buf_end))));
 end if;
 perform mavi_private.ai_save_document(r.company_id, 'meeting', r.id, 'client', r.client_id, null, null, null,
  coalesce(nullif(r.summary->>'title', ''), nullif(r.title, ''), 'Reunião'), r.recorded_at, v_header, v_pieces);
end $$;

-- Tarefa: descrição e campos de template, depois os comentários (autor e
-- data). Status, responsável e prazo ficam de fora (vêm ao vivo na busca).
create function mavi_private.ai_build_task(p_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare t record; v_pieces jsonb := '[]'; v_body text; v_comments text; v_header text; piece text; begin
 select x.*, k.client_id, cl.name as client_name, coalesce(nullif(p.name, ''), k.name) as product_name,
  pj.name as project_name
  into t from public.tasks x
  join public.contracts k on k.company_id = x.company_id and k.id = x.contract_id
  join public.clients cl on cl.company_id = k.company_id and cl.id = k.client_id
  left join public.products p on p.company_id = k.company_id and p.id = k.product_id
  left join public.projects pj on pj.company_id = x.company_id and pj.id = x.project_id
  where x.id = p_id;
 if not found or t.archived then perform mavi_private.ai_forget('task', p_id); return; end if;
 v_header := concat_ws(' · ', format('[Tarefa] "%s"', t.title), 'cliente ' || t.client_name,
  'produto ' || t.product_name, case when t.project_name is not null then 'projeto ' || t.project_name end,
  'criada em ' || to_char(t.created_at at time zone 'America/Sao_Paulo', 'DD/MM/YYYY'));
 v_body := concat_ws(E'\n\n', nullif(btrim(mavi_private.rich_plain(t.description)), ''),
  (select string_agg((f->>'label') || ': ' || (case jsonb_typeof(f->'value') when 'string' then f->>'value'
    else (f->'value')::text end), E'\n')
   from jsonb_array_elements(coalesce(t.custom_fields, '[]')) f
   where f->'value' is not null and jsonb_typeof(f->'value') <> 'null' and (f->>'value') <> ''));
 for piece in select mavi_private.ai_split(coalesce(v_body, '')) loop
  v_pieces := v_pieces || jsonb_build_array(jsonb_build_object('text', piece, 'meta', jsonb_build_object('kind', 'task')));
 end loop;
 if jsonb_array_length(v_pieces) = 0 then
  v_pieces := jsonb_build_array(jsonb_build_object('text', t.title, 'meta', jsonb_build_object('kind', 'task')));
 end if;
 select string_agg(format('[%s] %s: %s', to_char(c.created_at at time zone 'America/Sao_Paulo', 'DD/MM/YYYY'),
   coalesce(m.name, 'Alguém'), btrim(mavi_private.rich_plain(c.body))), E'\n\n' order by c.created_at)
  into v_comments
  from public.comments c
  left join public.memberships m on m.company_id = c.company_id and m.user_id = c.author_id
  where c.company_id = t.company_id and c.task_id = t.id;
 for piece in select mavi_private.ai_split(coalesce(v_comments, '')) loop
  v_pieces := v_pieces || jsonb_build_array(jsonb_build_object('text', 'Comentários:' || E'\n' || piece,
   'meta', jsonb_build_object('kind', 'comments')));
 end loop;
 perform mavi_private.ai_save_document(t.company_id, 'task', t.id, 'task', t.client_id, t.contract_id,
  t.project_id, t.id, t.title, t.created_at, v_header, v_pieces);
end $$;

create function mavi_private.ai_build(p_type text, p_id uuid) returns void
language plpgsql security definer set search_path = '' as $$ begin
 if p_type = 'meeting' then perform mavi_private.ai_build_meeting(p_id);
 elsif p_type = 'task' then perform mavi_private.ai_build_task(p_id);
 end if;
end $$;
revoke all on function mavi_private.ai_split(text, integer), mavi_private.ai_save_document(uuid, text, uuid, text,
 uuid, uuid, uuid, uuid, text, timestamptz, text, jsonb), mavi_private.ai_forget(text, uuid),
 mavi_private.ai_clock(numeric), mavi_private.ai_build_meeting(uuid), mavi_private.ai_build_task(uuid),
 mavi_private.ai_build(text, uuid) from public, anon, authenticated;

-- ------------------------------------------------------------ fila
create function mavi_private.ai_enqueue(p_type text, p_rows jsonb) returns void
language sql security definer set search_path = '' as $$
 insert into mavi_private.ai_queue(source_type, source_id, company_id)
 select distinct p_type, (x->>'id')::uuid, (x->>'company_id')::uuid from jsonb_array_elements(p_rows) x
 where x->>'id' is not null
 on conflict (source_type, source_id) do update set enqueued_at = excluded.enqueued_at, attempts = 0, last_error = null
$$;
revoke all on function mavi_private.ai_enqueue(text, jsonb) from public, anon, authenticated;

-- Triggers por instrução: uma importação de milhares de linhas é um único
-- insert na fila.
create function mavi_private.ai_queue_meeting() returns trigger
language plpgsql security definer set search_path = '' as $$ begin
 if tg_table_name = 'meeting_recordings' then
  perform mavi_private.ai_enqueue('meeting', (select jsonb_agg(jsonb_build_object('id', id, 'company_id', company_id)) from changed));
 else
  perform mavi_private.ai_enqueue('meeting', (select jsonb_agg(jsonb_build_object('id', recording_id, 'company_id', company_id)) from changed));
 end if;
 return null;
end $$;
create trigger ai_queue_recordings_ins after insert on public.meeting_recordings
 referencing new table as changed for each statement execute function mavi_private.ai_queue_meeting();
create trigger ai_queue_recordings_upd after update on public.meeting_recordings
 referencing new table as changed for each statement execute function mavi_private.ai_queue_meeting();
create trigger ai_queue_recordings_del after delete on public.meeting_recordings
 referencing old table as changed for each statement execute function mavi_private.ai_queue_meeting();
create trigger ai_queue_transcripts_ins after insert on public.meeting_transcripts
 referencing new table as changed for each statement execute function mavi_private.ai_queue_meeting();
create trigger ai_queue_transcripts_upd after update on public.meeting_transcripts
 referencing new table as changed for each statement execute function mavi_private.ai_queue_meeting();

create function mavi_private.ai_queue_task() returns trigger
language plpgsql security definer set search_path = '' as $$ begin
 if tg_table_name = 'comments' then
  perform mavi_private.ai_enqueue('task', (select jsonb_agg(jsonb_build_object('id', task_id, 'company_id', company_id)) from changed));
 else
  perform mavi_private.ai_enqueue('task', (select jsonb_agg(jsonb_build_object('id', id, 'company_id', company_id)) from changed));
 end if;
 return null;
end $$;
-- Tarefas alteradas só entram na fila quando muda o que vai para o texto
-- (status, responsável e prazo não).
create function mavi_private.ai_queue_task_update() returns trigger
language plpgsql security definer set search_path = '' as $$ begin
 perform mavi_private.ai_enqueue('task', (select jsonb_agg(jsonb_build_object('id', n.id, 'company_id', n.company_id))
  from new_rows n join old_rows o on o.id = n.id
  where (n.title, n.description, n.contract_id, n.project_id, n.custom_fields, n.archived)
   is distinct from (o.title, o.description, o.contract_id, o.project_id, o.custom_fields, o.archived)));
 return null;
end $$;
create trigger ai_queue_tasks_ins after insert on public.tasks
 referencing new table as changed for each statement execute function mavi_private.ai_queue_task();
create trigger ai_queue_tasks_upd after update on public.tasks
 referencing old table as old_rows new table as new_rows for each statement execute function mavi_private.ai_queue_task_update();
create trigger ai_queue_tasks_del after delete on public.tasks
 referencing old table as changed for each statement execute function mavi_private.ai_queue_task();
create trigger ai_queue_comments_ins after insert on public.comments
 referencing new table as changed for each statement execute function mavi_private.ai_queue_task();
create trigger ai_queue_comments_upd after update on public.comments
 referencing new table as changed for each statement execute function mavi_private.ai_queue_task();
create trigger ai_queue_comments_del after delete on public.comments
 referencing old table as changed for each statement execute function mavi_private.ai_queue_task();
revoke all on function mavi_private.ai_queue_meeting(), mavi_private.ai_queue_task(),
 mavi_private.ai_queue_task_update() from public, anon, authenticated;

-- ------------------------------------------------------------ worker
-- Monta os documentos dos próximos itens da fila (vários workers ao mesmo
-- tempo não pegam o mesmo item). Um item que falha volta para a fila (até 5
-- tentativas).
create function public.ai_index_step(p_secret text, p_limit integer default 100) returns integer
language plpgsql security definer set search_path = '' as $$
declare q record; n integer := 0; begin
 if not mavi_private.ai_secret_ok(p_secret) then raise exception 'Sem permissão' using errcode = '42501'; end if;
 for q in
  with picked as (
   select source_type, source_id from mavi_private.ai_queue
   where attempts < 5 order by enqueued_at limit least(greatest(coalesce(p_limit, 100), 1), 500)
   for update skip locked)
  delete from mavi_private.ai_queue a using picked
  where a.source_type = picked.source_type and a.source_id = picked.source_id
  returning a.*
 loop
  begin
   perform mavi_private.ai_build(q.source_type, q.source_id);
  exception when others then
   insert into mavi_private.ai_queue(source_type, source_id, company_id, attempts, last_error)
   values (q.source_type, q.source_id, q.company_id, q.attempts + 1, left(sqlerrm, 500))
   on conflict (source_type, source_id) do nothing;
  end;
  n := n + 1;
 end loop;
 return n;
end $$;

-- Os próximos trechos sem vetor (um trecho pego por um worker fica reservado
-- por 5 minutos).
create function public.ai_claim_chunks(p_secret text, p_limit integer default 200)
returns table(id bigint, company_id uuid, content text)
language plpgsql security definer set search_path = '' as $$ begin
 if not mavi_private.ai_secret_ok(p_secret) then raise exception 'Sem permissão' using errcode = '42501'; end if;
 return query
 update public.ai_chunks c set claimed_at = now()
 where c.id in (select x.id from public.ai_chunks x
  where x.embedding is null and (x.claimed_at is null or x.claimed_at < now() - interval '5 minutes')
  order by x.id limit least(greatest(coalesce(p_limit, 200), 1), 1000) for update skip locked)
 returning c.id, c.company_id, c.content;
end $$;

-- O custo da indexação, por empresa (o worker não tem usuário).
create function public.ai_log_indexing(p_secret text, p_model text, p_items jsonb) returns void
language plpgsql security definer set search_path = '' as $$ begin
 if not mavi_private.ai_secret_ok(p_secret) then raise exception 'Sem permissão' using errcode = '42501'; end if;
 insert into public.ai_usage(company_id, user_id, module, kind, model, embedding_tokens, cost_usd)
 select (i->>'company')::uuid, null, 'index', 'index', left(coalesce(p_model, ''), 80),
  greatest(coalesce((i->>'tokens')::integer, 0), 0), least(greatest(coalesce((i->>'cost')::numeric, 0), 0), 100)
 from jsonb_array_elements(p_items) i
 where exists (select 1 from public.companies c where c.id = (i->>'company')::uuid);
end $$;

create function public.ai_store_embeddings(p_secret text, p_model text, p_items jsonb) returns integer
language plpgsql security definer set search_path = '' as $$
declare n integer; begin
 if not mavi_private.ai_secret_ok(p_secret) then raise exception 'Sem permissão' using errcode = '42501'; end if;
 update public.ai_chunks c set embedding = (i->>'embedding')::extensions.halfvec(1536),
  embedding_model = left(p_model, 80), claimed_at = null
 from jsonb_array_elements(p_items) i where c.id = (i->>'id')::bigint;
 get diagnostics n = row_count;
 return n;
end $$;

create function public.ai_index_status(p_secret text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$ begin
 if not mavi_private.ai_secret_ok(p_secret) then raise exception 'Sem permissão' using errcode = '42501'; end if;
 return jsonb_build_object(
  'queue', (select count(*) from mavi_private.ai_queue where attempts < 5),
  'failed', (select count(*) from mavi_private.ai_queue where attempts >= 5),
  'pending', (select count(*) from public.ai_chunks where embedding is null),
  'chunks', (select count(*) from public.ai_chunks),
  'documents', (select count(*) from public.ai_documents));
end $$;
revoke all on function public.ai_index_step(text, integer), public.ai_claim_chunks(text, integer),
 public.ai_store_embeddings(text, text, jsonb), public.ai_index_status(text),
 public.ai_log_indexing(text, text, jsonb) from public, anon, authenticated;
-- anon: o servidor voltando com o segredo do agendamento.
grant execute on function public.ai_index_step(text, integer), public.ai_claim_chunks(text, integer),
 public.ai_store_embeddings(text, text, jsonb), public.ai_index_status(text),
 public.ai_log_indexing(text, text, jsonb) to anon, authenticated;

-- O pg_cron chama isto a cada minuto: só acorda o worker quando há trabalho.
create function mavi_private.ai_kick() returns void
language plpgsql security definer set search_path = '' as $$
declare cfg mavi_private.ai_config; begin
 select * into cfg from mavi_private.ai_config where id;
 if not found then return; end if;
 if not exists (select 1 from mavi_private.ai_queue where attempts < 5)
  and not exists (select 1 from public.ai_chunks where embedding is null) then return; end if;
 perform net.http_post(url := cfg.url, body := '{"action":"ai-index"}'::jsonb,
  headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || cfg.secret),
  timeout_milliseconds := 60000);
end $$;
revoke all on function mavi_private.ai_kick() from public, anon, authenticated;

-- ------------------------------------------------------------ busca
-- Tarefas que a pessoa vê (as mesmas regras do RLS de tasks).
create function mavi_private.ai_visible_tasks(c uuid) returns uuid[]
language sql stable security definer set search_path = '' as $$
 select coalesce(array_agg(distinct x), '{}') from (
  select id as x from public.tasks where company_id = c and (creator_id = auth.uid() or assignee_id = auth.uid())
  union select mavi_private.supervised_tasks()
  union select mavi_private.participant_tasks()) v
$$;
-- Clientes que a pessoa vê no Drive (as equipes dela).
create function mavi_private.ai_visible_clients(c uuid) returns uuid[]
language sql stable security definer set search_path = '' as $$
 select coalesce(array_agg(distinct ct.client_id), '{}') from public.client_teams ct
 join public.team_members tm on tm.company_id = ct.company_id and tm.team_id = ct.team_id
 where ct.company_id = c and tm.user_id = auth.uid()
$$;
revoke all on function mavi_private.ai_visible_tasks(uuid), mavi_private.ai_visible_clients(uuid)
 from public, anon, authenticated;

-- Busca híbrida: os melhores trechos por significado (vetor) e por termos
-- (texto completo), fundidos por RRF. Filtros opcionais em p_filters:
-- client, contract, project, task, types (lista), from, to (datas).
-- A resposta traz o estado atual das tarefas (status, responsável, prazo).
create function public.ai_search(p_company uuid, p_embedding text, p_query text, p_filters jsonb default '{}',
 p_limit integer default 12)
returns table(chunk_id bigint, document_id uuid, source_type text, source_id uuid, title text, content text,
 meta jsonb, client_id uuid, contract_id uuid, project_id uuid, occurred_at timestamptz, score double precision,
 task_status text, task_assignee uuid, task_due date)
language plpgsql volatile security definer set search_path = '' as $$
declare
 v_leader boolean; v_clients uuid[]; v_tasks uuid[]; v_vec extensions.halfvec(1536); v_tq tsquery;
 f_client uuid; f_contract uuid; f_project uuid; f_task uuid; f_types text[]; f_from timestamptz; f_to timestamptz;
 v_k integer; v_limit integer;
begin
 if not mavi_private.member(p_company) then raise exception 'Sem acesso' using errcode = '42501'; end if;
 v_leader := mavi_private.leader(p_company);
 if not v_leader then
  v_clients := mavi_private.ai_visible_clients(p_company);
  v_tasks := mavi_private.ai_visible_tasks(p_company);
 end if;
 f_client := nullif(p_filters->>'client', '')::uuid;
 f_contract := nullif(p_filters->>'contract', '')::uuid;
 f_project := nullif(p_filters->>'project', '')::uuid;
 f_task := nullif(p_filters->>'task', '')::uuid;
 f_types := case when jsonb_typeof(p_filters->'types') = 'array'
  then array(select jsonb_array_elements_text(p_filters->'types')) end;
 f_from := nullif(p_filters->>'from', '')::timestamptz;
 f_to := nullif(p_filters->>'to', '')::timestamptz;
 v_limit := least(greatest(coalesce(p_limit, 12), 1), 40);
 v_k := greatest(v_limit * 4, 40);
 if nullif(p_embedding, '') is not null then v_vec := p_embedding::extensions.halfvec(1536); end if;
 -- Termos com OU (perguntas em linguagem natural raramente têm todas as
 -- palavras no mesmo trecho); o ranking favorece quem tem mais.
 v_tq := nullif(replace(plainto_tsquery('portuguese'::regconfig, left(coalesce(p_query, ''), 500))::text, ' & ', ' | '), '')::tsquery;
 begin
  perform set_config('hnsw.iterative_scan', 'relaxed_order', true);
  perform set_config('hnsw.ef_search', '100', true);
 exception when others then null;
 end;
 -- O filtro se repete nas duas buscas de propósito: um CTE compartilhado
 -- seria materializado e o índice vetorial deixaria de ser usado.
 return query
 with vec as (
  select s.id, row_number() over () as rn from (
   select c.id from public.ai_chunks c
   where v_vec is not null and c.embedding is not null and c.company_id = p_company
    and (f_client is null or c.client_id = f_client)
    and (f_contract is null or c.contract_id = f_contract)
    and (f_project is null or c.project_id = f_project)
    and (f_task is null or c.task_id = f_task)
    and (f_types is null or c.source_type = any(f_types))
    and (f_from is null or c.occurred_at >= f_from)
    and (f_to is null or c.occurred_at < f_to + interval '1 day')
    and (v_leader
     or (c.access = 'client' and (c.client_id is null or c.client_id = any(v_clients)))
     or (c.access = 'task' and c.task_id = any(v_tasks)))
   order by c.embedding operator(extensions.<=>) v_vec limit v_k) s
 ),
 txt as (
  select s.id, row_number() over () as rn from (
   select c.id from public.ai_chunks c
   where v_tq is not null and c.search @@ v_tq and c.company_id = p_company
    and (f_client is null or c.client_id = f_client)
    and (f_contract is null or c.contract_id = f_contract)
    and (f_project is null or c.project_id = f_project)
    and (f_task is null or c.task_id = f_task)
    and (f_types is null or c.source_type = any(f_types))
    and (f_from is null or c.occurred_at >= f_from)
    and (f_to is null or c.occurred_at < f_to + interval '1 day')
    and (v_leader
     or (c.access = 'client' and (c.client_id is null or c.client_id = any(v_clients)))
     or (c.access = 'task' and c.task_id = any(v_tasks)))
   order by ts_rank_cd(c.search, v_tq) desc limit v_k) s
 ),
 fused as (
  select u.id, sum(1.0 / (60 + u.rn)) as score from (select * from vec union all select * from txt) u
  group by u.id order by score desc limit v_limit
 )
 select c.id, c.document_id, c.source_type, d.source_id, d.title, c.content, c.meta, c.client_id, c.contract_id,
  c.project_id, c.occurred_at, f.score::double precision, t.status, t.assignee_id, t.due_date
 from fused f
 join public.ai_chunks c on c.id = f.id
 join public.ai_documents d on d.id = c.document_id
 left join public.tasks t on t.company_id = c.company_id and t.id = c.task_id
 order by f.score desc;
end $$;

-- Os trechos vizinhos de um trecho (ler mais do mesmo documento).
create function public.ai_read(p_chunk bigint, p_window integer default 2)
returns table(chunk_id bigint, document_id uuid, ord integer, content text, meta jsonb)
language plpgsql stable security definer set search_path = '' as $$
declare c public.ai_chunks; v_ok boolean; begin
 select * into c from public.ai_chunks x where x.id = p_chunk;
 if not found then return; end if;
 v_ok := mavi_private.member(c.company_id) and (mavi_private.leader(c.company_id)
  or (c.access = 'client' and mavi_private.drive_can_read(c.company_id, c.client_id))
  or (c.access = 'task' and mavi_private.task_access(c.company_id, c.task_id)));
 if not v_ok then raise exception 'Sem acesso' using errcode = '42501'; end if;
 return query select x.id, x.document_id, x.ord, x.content, x.meta from public.ai_chunks x
  where x.document_id = c.document_id and x.ord between c.ord - least(greatest(p_window, 0), 5)
   and c.ord + least(greatest(p_window, 0), 5)
  order by x.ord;
end $$;
revoke all on function public.ai_search(uuid, text, text, jsonb, integer), public.ai_read(bigint, integer)
 from public, anon;
grant execute on function public.ai_search(uuid, text, text, jsonb, integer), public.ai_read(bigint, integer)
 to authenticated;

-- Tudo que já existe entra na fila (o worker indexa aos poucos).
insert into mavi_private.ai_queue(source_type, source_id, company_id)
select 'meeting', id, company_id from public.meeting_recordings
union all
select 'task', id, company_id from public.tasks where not archived
on conflict do nothing;

commit;
