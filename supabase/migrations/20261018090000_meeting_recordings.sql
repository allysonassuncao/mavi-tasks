begin;

-- Drive › cliente › "Gravações da MAVI": as reuniões gravadas e transcritas
-- pelo gravador da MAVI (bot que entra no Google Meet). Uma pasta virtual por
-- cliente, ao lado das pastas de produto, com a mesma regra de leitura do
-- Drive (líderes e as equipes que atendem o cliente).
--
-- Contrato para o gravador (escreve com a service role, fora do RLS):
--  1. insert em meeting_recordings (company_id, client_id, source_id = id do
--     bot, recorded_at, title, recorded_by_email, attendees, speakers,
--     meet_link, duration_seconds, video_bucket/video_path, summary, cost);
--     source_id é único por empresa, então "on conflict do nothing" torna o
--     envio idempotente.
--  2. insert em meeting_transcripts (recording_id, company_id, speakers,
--     segments), segments = [[início s, fim s, índice do falante, texto], …]
--     (início/fim null quando a transcrição não tem tempo). A busca é
--     calculada pelo banco.
-- O vídeo fica no GCS; o navegador nunca vê o caminho, só um link assinado
-- (api/drive.ts, ação "meeting-video").
create table public.meeting_recordings (
 id uuid primary key default gen_random_uuid(),
 company_id uuid not null references public.companies(id),
 client_id uuid not null,
 source_id text not null check (length(source_id) between 1 and 120),
 title text not null default '' check (length(title) <= 300),
 recorded_at timestamptz not null,
 duration_seconds integer check (duration_seconds is null or duration_seconds >= 0),
 recorded_by_email text not null default '',
 attendees text[] not null default '{}',
 speakers text[] not null default '{}',
 meet_link text,
 video_bucket text,
 video_path text,
 video_type text,
 video_bytes bigint,
 summary jsonb not null default '{}' check (jsonb_typeof(summary) = 'object'),
 cost numeric,
 created_at timestamptz not null default now(),
 unique(company_id, id),
 unique(company_id, source_id),
 foreign key(company_id, client_id) references public.clients(company_id, id),
 check ((video_bucket is null) = (video_path is null))
);
create index meeting_recordings_client on public.meeting_recordings(company_id, client_id, recorded_at desc);
alter table public.meeting_recordings enable row level security;
revoke all on public.meeting_recordings from public, anon, authenticated;
-- O caminho do vídeo não sai para o navegador.
grant select (id, company_id, client_id, source_id, title, recorded_at, duration_seconds, recorded_by_email,
 attendees, speakers, meet_link, video_type, video_bytes, summary, created_at) on public.meeting_recordings to authenticated;
create policy meeting_recordings_read on public.meeting_recordings for select to authenticated using (
 company_id in (select mavi_private.active_companies()) and mavi_private.drive_can_read(company_id, client_id)
);

-- A transcrição, compacta: uma linha por reunião.
create table public.meeting_transcripts (
 recording_id uuid primary key,
 company_id uuid not null,
 speakers text[] not null default '{}',
 segments jsonb not null default '[]' check (jsonb_typeof(segments) = 'array'),
 timed boolean not null default true,
 search tsvector,
 foreign key(company_id, recording_id) references public.meeting_recordings(company_id, id) on delete cascade
);
create index meeting_transcripts_search on public.meeting_transcripts using gin(search);
alter table public.meeting_transcripts enable row level security;
revoke all on public.meeting_transcripts from public, anon, authenticated;
grant select (recording_id, company_id, speakers, segments, timed) on public.meeting_transcripts to authenticated;
create policy meeting_transcripts_read on public.meeting_transcripts for select to authenticated using (
 exists (select 1 from public.meeting_recordings r where r.company_id = meeting_transcripts.company_id
  and r.id = meeting_transcripts.recording_id)
);

-- Texto de uma transcrição (para a busca e para a IA).
create function mavi_private.meeting_plain(p_segments jsonb) returns text
language sql immutable set search_path = '' as $$
 select coalesce(string_agg(s->>3, ' '), '') from jsonb_array_elements(p_segments) s
$$;
-- A busca guarda só as palavras (sem posições): cabe em qualquer reunião,
-- por mais longa que seja.
create function mavi_private.meeting_transcript_search() returns trigger
language plpgsql set search_path = '' as $$ begin
 new.search := strip(to_tsvector('portuguese'::regconfig, left(mavi_private.meeting_plain(new.segments), 900000)));
 new.timed := coalesce((select bool_or(jsonb_typeof(s->0) = 'number') from jsonb_array_elements(new.segments) s), false);
 return new;
end $$;
create trigger meeting_transcript_search before insert or update of segments on public.meeting_transcripts
 for each row execute function mavi_private.meeting_transcript_search();
revoke all on function mavi_private.meeting_transcript_search(), mavi_private.meeting_plain(jsonb) from public, anon, authenticated;

-- Comentários num ponto da gravação.
create table public.meeting_comments (
 id uuid primary key default gen_random_uuid(),
 company_id uuid not null,
 recording_id uuid not null,
 at_seconds numeric(10,2) not null check (at_seconds >= 0),
 body text not null check (length(trim(body)) between 1 and 4000),
 author_id uuid not null default auth.uid(),
 created_at timestamptz not null default now(),
 foreign key(company_id, recording_id) references public.meeting_recordings(company_id, id) on delete cascade,
 foreign key(company_id, author_id) references public.memberships(company_id, user_id)
);
create index meeting_comments_recording on public.meeting_comments(company_id, recording_id, at_seconds);
alter table public.meeting_comments enable row level security;
revoke all on public.meeting_comments from public, anon, authenticated;
grant select on public.meeting_comments to authenticated;
create policy meeting_comments_read on public.meeting_comments for select to authenticated using (
 exists (select 1 from public.meeting_recordings r where r.company_id = meeting_comments.company_id
  and r.id = meeting_comments.recording_id)
);

-- Quanto a IA custou (perguntas sobre uma reunião ou sobre o histórico).
create table public.meeting_ai_usage (
 id bigint generated always as identity primary key,
 company_id uuid not null references public.companies(id),
 client_id uuid not null,
 recording_id uuid,
 user_id uuid not null default auth.uid(),
 kind text not null check (kind in ('ask', 'ask_client')),
 model text not null default '',
 input_tokens integer not null default 0,
 output_tokens integer not null default 0,
 cache_read_tokens integer not null default 0,
 cache_write_tokens integer not null default 0,
 cost_usd numeric(12,6) not null default 0,
 created_at timestamptz not null default now(),
 foreign key(company_id, client_id) references public.clients(company_id, id)
);
create index meeting_ai_usage_company on public.meeting_ai_usage(company_id, created_at desc);
alter table public.meeting_ai_usage enable row level security;
revoke all on public.meeting_ai_usage from public, anon, authenticated;
grant select on public.meeting_ai_usage to authenticated;
create policy meeting_ai_usage_read on public.meeting_ai_usage for select to authenticated
 using (company_id in (select mavi_private.leader_companies()));

-- ------------------------------------------------------------ funções
-- Onde está o vídeo (só no servidor, que assina o link). Cada abertura entra
-- no histórico do Drive.
create function public.meeting_video_target(p_recording uuid, p_origin jsonb default null)
returns table(bucket text, path text, content_type text, title text)
language plpgsql security definer set search_path = '' as $$
declare r public.meeting_recordings; begin
 select * into r from public.meeting_recordings m where m.id = p_recording;
 if not found or not mavi_private.drive_can_read(r.company_id, r.client_id) then
  raise exception 'Sem acesso a esta gravação.' using errcode = '42501';
 end if;
 if r.video_path is null then raise exception 'O vídeo desta reunião não está disponível.' using errcode = 'P0002'; end if;
 perform mavi_private.drive_log(r.company_id, 'recording_view', null, null,
  coalesce(nullif(r.summary->>'title', ''), nullif(r.title, ''), 'Gravação'), r.client_id, null,
  jsonb_build_object('recording', r.id), mavi_private.clean_origin(p_origin));
 return query select r.video_bucket, r.video_path, r.video_type, coalesce(nullif(r.summary->>'title', ''), r.title);
end $$;
revoke all on function public.meeting_video_target(uuid, jsonb) from public, anon;
grant execute on function public.meeting_video_target(uuid, jsonb) to authenticated;

-- Busca no histórico do cliente: os trechos (com o tempo) que batem com o
-- texto, para quem vê o cliente no Drive.
create function public.search_meeting_segments(p_company uuid, p_client uuid, p_query text, p_limit integer default 60)
returns table(recording_id uuid, recorded_at timestamptz, start_seconds numeric, speaker integer, text text)
language sql stable security definer set search_path = '' as $$
 with q as (select websearch_to_tsquery('portuguese'::regconfig, left(coalesce(p_query, ''), 200)) as q),
 hits as (
  select t.recording_id, r.recorded_at, t.segments from public.meeting_transcripts t
  join public.meeting_recordings r on r.company_id = t.company_id and r.id = t.recording_id, q
  where r.company_id = p_company and r.client_id = p_client and t.search @@ q.q
   and mavi_private.drive_can_read(p_company, p_client)
 )
 select h.recording_id, h.recorded_at,
  case when jsonb_typeof(s.value->0) = 'number' then (s.value->>0)::numeric end,
  case when jsonb_typeof(s.value->2) = 'number' then (s.value->>2)::integer end,
  s.value->>3
 from hits h cross join lateral jsonb_array_elements(h.segments) with ordinality s(value, n), q
 where to_tsvector('portuguese'::regconfig, s.value->>3) @@ q.q
 order by h.recorded_at desc, s.n
 limit least(greatest(coalesce(p_limit, 60), 1), 200)
$$;
revoke all on function public.search_meeting_segments(uuid, uuid, text, integer) from public, anon;
grant execute on function public.search_meeting_segments(uuid, uuid, text, integer) to authenticated;

create function public.add_meeting_comment(p_recording uuid, p_at numeric, p_body text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare r public.meeting_recordings; result uuid; begin
 select * into r from public.meeting_recordings m where m.id = p_recording;
 if not found or not mavi_private.drive_can_read(r.company_id, r.client_id) then
  raise exception 'Sem acesso a esta gravação.' using errcode = '42501';
 end if;
 insert into public.meeting_comments(company_id, recording_id, at_seconds, body)
 values (r.company_id, r.id, greatest(round(coalesce(p_at, 0), 2), 0), trim(p_body)) returning id into result;
 return result;
end $$;
create function public.delete_meeting_comment(p_comment uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare c public.meeting_comments; begin
 select * into c from public.meeting_comments m where m.id = p_comment;
 if not found then raise exception 'Comentário não encontrado.' using errcode = 'P0002'; end if;
 if c.author_id is distinct from auth.uid() and not mavi_private.leader(c.company_id) then
  raise exception 'Só quem escreveu ou um líder apaga este comentário.' using errcode = '42501';
 end if;
 delete from public.meeting_comments where id = p_comment;
end $$;
revoke all on function public.add_meeting_comment(uuid, numeric, text), public.delete_meeting_comment(uuid) from public, anon;
grant execute on function public.add_meeting_comment(uuid, numeric, text), public.delete_meeting_comment(uuid) to authenticated;

create function public.meeting_log_usage(p_client uuid, p_recording uuid, p_kind text, p_model text,
 p_input integer, p_output integer, p_cache_read integer, p_cache_write integer, p_cost numeric) returns void
language plpgsql security definer set search_path = '' as $$
declare c uuid; begin
 select k.company_id into c from public.clients k where k.id = p_client;
 if c is null or not mavi_private.drive_can_read(c, p_client) then
  raise exception 'Sem permissão.' using errcode = '42501';
 end if;
 if p_recording is not null and not exists (select 1 from public.meeting_recordings r
  where r.id = p_recording and r.company_id = c and r.client_id = p_client) then
  raise exception 'Gravação não encontrada.' using errcode = 'P0002';
 end if;
 if p_cost is null or p_cost < 0 or p_cost > 100 then raise exception 'Custo inválido.' using errcode = '22023'; end if;
 insert into public.meeting_ai_usage(company_id, client_id, recording_id, kind, model, input_tokens, output_tokens,
  cache_read_tokens, cache_write_tokens, cost_usd)
 values (c, p_client, p_recording, p_kind, left(coalesce(p_model, ''), 80), greatest(coalesce(p_input, 0), 0),
  greatest(coalesce(p_output, 0), 0), greatest(coalesce(p_cache_read, 0), 0), greatest(coalesce(p_cache_write, 0), 0), p_cost);
end $$;
revoke all on function public.meeting_log_usage(uuid, uuid, text, text, integer, integer, integer, integer, numeric) from public, anon;
grant execute on function public.meeting_log_usage(uuid, uuid, text, text, integer, integer, integer, integer, numeric) to authenticated;

-- ------------------------------------------------------------ avisos ao vivo
-- Comentários aparecem para quem está com a gravação aberta; gravações novas
-- (o gravador) aparecem na pasta do cliente.
create function mavi_private.broadcast_meeting_comment() returns trigger
language plpgsql security definer set search_path = '' as $$
declare r record; begin
 r := coalesce(new, old);
 perform mavi_private.broadcast(r.company_id, jsonb_build_object('kind', 'meeting', 'table', tg_table_name,
  'recording', r.recording_id));
 return null;
end $$;
-- Gravações: um aviso por cliente em cada instrução (uma importação grande
-- não vira milhares de avisos).
create function mavi_private.broadcast_meeting_recordings() returns trigger
language plpgsql security definer set search_path = '' as $$
declare r record; begin
 for r in select distinct company_id, client_id from changed loop
  perform mavi_private.broadcast(r.company_id, jsonb_build_object('kind', 'meeting', 'table', 'meeting_recordings',
   'client', r.client_id));
 end loop;
 return null;
end $$;
revoke all on function mavi_private.broadcast_meeting_comment(), mavi_private.broadcast_meeting_recordings()
 from public, anon, authenticated;
create trigger broadcast_meeting_comment after insert or delete on public.meeting_comments
 for each row execute function mavi_private.broadcast_meeting_comment();
create trigger broadcast_meeting_recordings after insert on public.meeting_recordings
 referencing new table as changed for each statement execute function mavi_private.broadcast_meeting_recordings();

commit;
