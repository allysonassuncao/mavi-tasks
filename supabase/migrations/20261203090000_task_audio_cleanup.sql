begin;

-- Áudios das tarefas (20261201090000_task_audio): limpeza dos rascunhos e
-- espaço na página Armazenamento.
--
-- Limpeza: o rascunho (task_id nulo) que não entrou numa tarefa nem num
-- comentário em 24 horas sai do banco. O arquivo fica no GCS (bucket público,
-- <empresa>/audio/<id>), que o banco não alcança: quando a última linha que
-- aponta para um caminho sai — rascunho vencido, áudio tirado da tarefa,
-- comentário apagado —, o caminho entra na fila mavi_private.task_audio_cleanup.
-- O pg_cron (supabase/operations/schedule-task-audio-cleanup.sql) chama
-- mavi_private.task_audio_cleanup_kick, que só acorda o worker (ação
-- "task-audio-cleanup" de /api/ai, com o AI_WORKER_SECRET) quando há trabalho.
-- O worker pega os caminhos (task_audio_cleanup_claim), apaga do GCS e
-- confirma (task_audio_cleanup_done). Quem tira um áudio pela tela já apaga o
-- arquivo na hora (api/_uploads.ts, "delete-audio"); a fila garante o
-- arquivo quando isso falha, e o worker trata "já não existe" como feito.
--
-- Armazenamento: storage_uploads ganha o tipo 'audio'. As cópias das tarefas
-- que se repetem apontam para o mesmo arquivo, então cada caminho é uma linha
-- só (source_id é o id no nome do arquivo, o do áudio gravado), que conta
-- desde o envio confirmado até a última linha sair. O cliente vem da tarefa
-- (do áudio original, enquanto existir; senão, da cópia mais antiga).

-- ------------------------------------------------------------ fila do GCS
create table mavi_private.task_audio_cleanup (
 path text primary key check (path ~ '^[0-9a-f-]{36}/audio/[0-9a-f-]{36}$'),
 company_id uuid not null,
 queued_at timestamptz not null default now(),
 next_attempt_at timestamptz not null default now(),
 attempts integer not null default 0,
 last_error text check (length(last_error) <= 500)
);
create index task_audio_cleanup_due on mavi_private.task_audio_cleanup(next_attempt_at) where attempts < 20;
alter table mavi_private.task_audio_cleanup enable row level security;
revoke all on mavi_private.task_audio_cleanup from public, anon, authenticated;

-- Os rascunhos por idade (o índice de 20261201 é por pessoa).
create index task_audios_draft_age on public.task_audios(created_at, id) where task_id is null;

-- ------------------------------------------------------------ armazenamento
alter table public.storage_uploads drop constraint storage_uploads_kind_check;
alter table public.storage_uploads add constraint storage_uploads_kind_check
 check (kind in ('drive','attachment','inline_image','avatar','logo','audio'));

-- O id do áudio gravado, no nome do arquivo (uma linha por caminho).
create function mavi_private.audio_source(p_path text) returns uuid
language sql immutable set search_path = '' as $$
 select substring(p_path from '/audio/([0-9a-f-]{36})$')::uuid
$$;
revoke all on function mavi_private.audio_source(text) from public, anon, authenticated;

-- "Áudio da descrição (1:23)", "Áudio de comentário (0:45)".
create function mavi_private.audio_upload_name(p_purpose text, p_seconds numeric) returns text
language sql immutable set search_path = '' as $$
 select case when p_purpose = 'comment' then 'Áudio de comentário' else 'Áudio da descrição' end
  || format(' (%s:%s)', floor(p_seconds / 60)::int, lpad((floor(p_seconds)::int % 60)::text, 2, '0'))
$$;
revoke all on function mavi_private.audio_upload_name(text, numeric) from public, anon, authenticated;

-- Conta a partir do envio confirmado (o status sai de 'uploading'). As cópias
-- da repetição já encontram a linha do caminho.
create function mavi_private.log_audio_upload() returns trigger
language plpgsql security definer set search_path = '' as $$ begin
 if tg_op = 'UPDATE' then
  if old.status = 'uploading' and new.status <> 'uploading' then
   update public.storage_uploads set completed_at = coalesce(completed_at, now())
   where company_id = new.company_id and kind = 'audio' and source_id = mavi_private.audio_source(new.path);
  end if;
  return null;
 end if;
 insert into public.storage_uploads(company_id, user_id, kind, source_id, name, size_bytes, created_at, completed_at)
 values (new.company_id, new.uploaded_by, 'audio', mavi_private.audio_source(new.path),
  mavi_private.audio_upload_name(new.purpose, new.duration_seconds), new.size_bytes, new.created_at,
  case when new.status <> 'uploading' then new.created_at end)
 on conflict (company_id, kind, source_id) do update
  set deleted_at = null, completed_at = coalesce(storage_uploads.completed_at, excluded.completed_at)
  where storage_uploads.deleted_at is not null or storage_uploads.completed_at is null;
 return null;
end $$;
revoke all on function mavi_private.log_audio_upload() from public, anon, authenticated;
create trigger log_audio_upload after insert or update of status on public.task_audios
 for each row execute function mavi_private.log_audio_upload();

-- A última linha de um caminho saiu: o espaço deixa de contar e o arquivo
-- entra na fila do GCS. Por comando (o gatilho vê o estado depois dele), para
-- que uma limpeza em lote não confira caminho por caminho no meio.
create function mavi_private.release_task_audio_paths() returns trigger
language plpgsql security definer set search_path = '' as $$ begin
 with released as (
  select distinct g.company_id, g.path from gone g
  where not exists (select 1 from public.task_audios a where a.path = g.path)
 ), ledger as (
  update public.storage_uploads u set deleted_at = now()
  from released r
  where u.company_id = r.company_id and u.kind = 'audio' and u.source_id = mavi_private.audio_source(r.path)
   and u.deleted_at is null
 )
 insert into mavi_private.task_audio_cleanup(path, company_id)
 select r.path, r.company_id from released r
 on conflict (path) do update set next_attempt_at = now(), attempts = 0, last_error = null;
 return null;
end $$;
revoke all on function mavi_private.release_task_audio_paths() from public, anon, authenticated;
create trigger release_task_audio_paths after delete on public.task_audios
 referencing old table as gone for each statement execute function mavi_private.release_task_audio_paths();

-- Arquivos em uso: o áudio pertence ao cliente da tarefa em que está (o
-- áudio original; se ele saiu, a cópia mais antiga). Rascunhos, sem cliente.
create or replace function mavi_private.storage_in_use(p_company uuid)
 returns table(id uuid, source_id uuid, user_id uuid, kind text, name text, size_bytes bigint,
  created_at timestamptz, client_id uuid, contract_id uuid)
language sql stable security definer set search_path = '' as $$
 select u.id, u.source_id, u.user_id, u.kind, u.name, u.size_bytes, u.created_at,
  coalesce(f.client_id, k.client_id), coalesce(f.contract_id, k.id)
 from public.storage_uploads u
 left join public.drive_files f on u.kind = 'drive' and f.id = u.source_id
 left join public.attachments a on u.kind = 'attachment' and a.id = u.source_id
 left join public.inline_images i on u.kind = 'inline_image' and i.id = u.source_id
 left join lateral (
  select x.task_id from public.task_audios x
  where u.kind = 'audio' and x.path = u.company_id::text || '/audio/' || u.source_id::text
   and x.task_id is not null
  order by x.id = u.source_id desc, x.created_at, x.id
  limit 1) au on true
 left join public.tasks t on t.id = coalesce(a.task_id, i.task_id, au.task_id)
 left join public.contracts k on k.id = t.contract_id
 where u.company_id = p_company and u.completed_at is not null and u.deleted_at is null
$$;
revoke all on function mavi_private.storage_in_use(uuid) from public, anon, authenticated;

-- Áudios gravados antes desta migração: um por caminho.
insert into public.storage_uploads(company_id, user_id, kind, source_id, name, size_bytes, created_at, completed_at)
select distinct on (a.path) a.company_id, a.uploaded_by, 'audio', mavi_private.audio_source(a.path),
 mavi_private.audio_upload_name(a.purpose, a.duration_seconds), a.size_bytes, a.created_at,
 case when a.status <> 'uploading' then a.created_at end
from public.task_audios a
order by a.path, a.id = mavi_private.audio_source(a.path) desc, a.created_at
on conflict do nothing;

-- ------------------------------------------------------------ worker
-- O worker (anon + segredo): tira os rascunhos vencidos (até p_limit por vez;
-- o gatilho acima põe os arquivos na fila) e pega os caminhos a apagar do
-- GCS. Um caminho que voltou a ser usado sai da fila sem ser apagado. O que
-- foi pego volta daqui a 30 minutos se o worker não confirmar.
create function public.task_audio_cleanup_claim(p_secret text, p_limit integer default 100)
returns table(path text)
language plpgsql security definer set search_path = '' as $$
declare v_limit integer := least(greatest(coalesce(p_limit, 100), 1), 500); begin
 if not mavi_private.ai_secret_ok(p_secret) then raise exception 'Sem permissão' using errcode = '42501'; end if;
 -- bind_task_audios e add_audio_comment travam o rascunho: quem está entrando
 -- numa tarefa agora não é apagado.
 with expired as (
  select a.id from public.task_audios a
  where a.task_id is null and a.created_at < now() - interval '24 hours'
  order by a.created_at, a.id limit v_limit
  for update skip locked)
 delete from public.task_audios a using expired e where a.id = e.id;
 delete from mavi_private.task_audio_cleanup q
 where exists (select 1 from public.task_audios a where a.path = q.path);
 return query
 with due as (
  select q.path from mavi_private.task_audio_cleanup q
  where q.next_attempt_at <= now() and q.attempts < 20
  order by q.next_attempt_at, q.path limit v_limit
  for update skip locked)
 update mavi_private.task_audio_cleanup q set attempts = q.attempts + 1,
  next_attempt_at = now() + interval '30 minutes'
 from due where q.path = due.path
 returning q.path;
end $$;

-- Os arquivos que saíram do GCS (ou já não existiam) saem da fila; os que
-- falharam guardam o erro e tentam de novo na próxima vez.
create function public.task_audio_cleanup_done(p_secret text, p_done text[], p_failed text[] default '{}',
 p_error text default null) returns integer
language plpgsql security definer set search_path = '' as $$
declare n integer; begin
 if not mavi_private.ai_secret_ok(p_secret) then raise exception 'Sem permissão' using errcode = '42501'; end if;
 delete from mavi_private.task_audio_cleanup where path = any(coalesce(p_done, '{}'));
 get diagnostics n = row_count;
 update mavi_private.task_audio_cleanup set last_error = left(coalesce(p_error, 'Falha ao apagar do GCS'), 500)
 where path = any(coalesce(p_failed, '{}'));
 return n;
end $$;

revoke all on function public.task_audio_cleanup_claim(text, integer),
 public.task_audio_cleanup_done(text, text[], text[], text) from public, anon, authenticated;
grant execute on function public.task_audio_cleanup_claim(text, integer),
 public.task_audio_cleanup_done(text, text[], text[], text) to anon, authenticated;

-- pg_cron: acorda o worker só quando há rascunho vencido ou arquivo na fila.
create function mavi_private.task_audio_cleanup_kick() returns void
language plpgsql security definer set search_path = '' as $$
declare cfg mavi_private.ai_config; begin
 select * into cfg from mavi_private.ai_config where id;
 if not found then return; end if;
 if not exists (select 1 from public.task_audios where task_id is null and created_at < now() - interval '24 hours')
  and not exists (select 1 from mavi_private.task_audio_cleanup where next_attempt_at <= now() and attempts < 20)
 then return; end if;
 perform net.http_post(url := cfg.url, body := '{"action":"task-audio-cleanup"}'::jsonb,
  headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || cfg.secret),
  timeout_milliseconds := 60000);
end $$;
revoke all on function mavi_private.task_audio_cleanup_kick() from public, anon, authenticated;

commit;
