begin;

-- Drive › Gravações da MAVI › Link público: uma gravação pode ter um link
-- (/gravacao/<token>) que abre sem login, com o que quem compartilhou
-- escolheu mostrar (vídeo, transcrição, resumo), se pode baixar, até quando
-- vale e, se quiser, uma senha. Os próximos passos e a MAVI ficam de fora.
--
-- Quem vê o cliente no Drive cria o link; quem o criou ou um líder altera e
-- desativa. Desativar apaga o link: um novo terá outro endereço, então um
-- link antigo nunca volta a funcionar. Mudar as opções mantém o endereço.
-- Cada abertura e cada download pelo link entram no histórico do Drive e na
-- contagem do próprio link.
create table public.meeting_shares (
 recording_id uuid primary key,
 company_id uuid not null,
 token text not null unique
  default (replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '')),
 show_video boolean not null default true,
 show_transcript boolean not null default true,
 show_summary boolean not null default true,
 allow_download boolean not null default false,
 expires_at timestamptz,
 password_hash text,
 created_by uuid not null default auth.uid(),
 created_at timestamptz not null default now(),
 updated_by uuid,
 updated_at timestamptz not null default now(),
 opens integer not null default 0,
 downloads integer not null default 0,
 last_opened_at timestamptz,
 -- Senhas erradas: 10 em 15 minutos bloqueiam o link por um tempo.
 failures integer not null default 0,
 failures_since timestamptz,
 foreign key (company_id, recording_id) references public.meeting_recordings(company_id, id) on delete cascade,
 foreign key (company_id, created_by) references public.memberships(company_id, user_id),
 check (show_video or show_transcript or show_summary)
);
create index meeting_shares_company on public.meeting_shares(company_id);
alter table public.meeting_shares enable row level security;
revoke all on public.meeting_shares from public, anon, authenticated;

create function mavi_private.meeting_share_title(r public.meeting_recordings) returns text
language sql immutable set search_path = '' as $$
 select coalesce(nullif(r.summary->>'title', ''), nullif(r.title, ''), 'Gravação')
$$;

-- O que o diálogo de compartilhar mostra (nunca a senha).
create function mavi_private.meeting_share_json(s public.meeting_shares) returns jsonb
language sql stable security definer set search_path = '' as $$
 select jsonb_build_object('token', s.token, 'show_video', s.show_video, 'show_transcript', s.show_transcript,
  'show_summary', s.show_summary, 'allow_download', s.allow_download, 'expires_at', s.expires_at,
  'expired', s.expires_at is not null and s.expires_at <= now(), 'has_password', s.password_hash is not null,
  'created_by', s.created_by, 'created_at', s.created_at, 'updated_at', s.updated_at,
  'opens', s.opens, 'downloads', s.downloads, 'last_opened_at', s.last_opened_at,
  'can_manage', s.created_by = auth.uid() or mavi_private.leader(s.company_id))
$$;
revoke all on function mavi_private.meeting_share_title(public.meeting_recordings),
 mavi_private.meeting_share_json(public.meeting_shares) from public, anon, authenticated;

-- A gravação, para quem a vê no Drive.
create function mavi_private.meeting_share_recording(p_recording uuid) returns public.meeting_recordings
language plpgsql stable security definer set search_path = '' as $$
declare r public.meeting_recordings; begin
 select * into r from public.meeting_recordings m where m.id = p_recording;
 if not found or not mavi_private.drive_can_read(r.company_id, r.client_id) then
  raise exception 'Sem acesso a esta gravação.' using errcode = '42501';
 end if;
 return r;
end $$;
revoke all on function mavi_private.meeting_share_recording(uuid) from public, anon, authenticated;

-- ------------------------------------------------------------ gerenciar
-- O link da gravação (nulo: ainda não tem).
create function public.meeting_share(p_recording uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare r public.meeting_recordings; s public.meeting_shares; begin
 r := mavi_private.meeting_share_recording(p_recording);
 select * into s from public.meeting_shares where company_id = r.company_id and recording_id = r.id;
 if not found then return null; end if;
 return mavi_private.meeting_share_json(s);
end $$;

-- Cria o link ou muda as opções dele (o endereço continua o mesmo).
-- p_keep_password: mantém a senha que o link já tem (p_password é ignorada);
-- senão, p_password vazia tira a senha.
create function public.set_meeting_share(p_recording uuid, p_video boolean, p_transcript boolean,
 p_summary boolean, p_download boolean, p_expires_at timestamptz, p_password text default null,
 p_keep_password boolean default true) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare r public.meeting_recordings; s public.meeting_shares; existed boolean; hash text; begin
 r := mavi_private.meeting_share_recording(p_recording);
 if not coalesce(p_video, false) and not coalesce(p_transcript, false) and not coalesce(p_summary, false) then
  raise exception 'Escolha o que o link mostra: vídeo, transcrição ou resumo.' using errcode = '22023';
 end if;
 if p_expires_at is not null and p_expires_at <= now() then
  raise exception 'Escolha uma validade no futuro.' using errcode = '22023';
 end if;
 select * into s from public.meeting_shares where company_id = r.company_id and recording_id = r.id for update;
 existed := found;
 if existed and not (s.created_by = auth.uid() or mavi_private.leader(r.company_id)) then
  raise exception 'Só quem criou o link ou um líder altera o compartilhamento.' using errcode = '42501';
 end if;
 if existed and coalesce(p_keep_password, true) then hash := s.password_hash;
 elsif nullif(p_password, '') is null then hash := null;
 elsif length(p_password) < 4 or octet_length(p_password) > 72 then
  raise exception 'A senha precisa ter de 4 a 72 caracteres.' using errcode = '22023';
 else hash := extensions.crypt(p_password, extensions.gen_salt('bf', 8));
 end if;
 if existed then
  update public.meeting_shares set show_video = p_video, show_transcript = p_transcript, show_summary = p_summary,
   allow_download = coalesce(p_download, false), expires_at = p_expires_at, password_hash = hash,
   updated_by = auth.uid(), updated_at = now(),
   failures = case when hash is distinct from s.password_hash then 0 else failures end,
   failures_since = case when hash is distinct from s.password_hash then null else failures_since end
  where recording_id = r.id returning * into s;
 else
  insert into public.meeting_shares(recording_id, company_id, show_video, show_transcript, show_summary,
   allow_download, expires_at, password_hash)
  values (r.id, r.company_id, p_video, p_transcript, p_summary, coalesce(p_download, false), p_expires_at, hash)
  returning * into s;
 end if;
 perform mavi_private.drive_log(r.company_id, 'recording_shared', null, null, mavi_private.meeting_share_title(r),
  r.client_id, null, jsonb_build_object('recording', r.id, 'created', not existed, 'video', s.show_video,
   'transcript', s.show_transcript, 'summary', s.show_summary, 'download', s.allow_download,
   'expires_at', s.expires_at, 'password', s.password_hash is not null));
 return mavi_private.meeting_share_json(s);
end $$;

-- Desativa o link (para sempre: um novo link terá outro endereço).
create function public.delete_meeting_share(p_recording uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare r public.meeting_recordings; s public.meeting_shares; begin
 r := mavi_private.meeting_share_recording(p_recording);
 select * into s from public.meeting_shares where company_id = r.company_id and recording_id = r.id for update;
 if not found then return; end if;
 if not (s.created_by = auth.uid() or mavi_private.leader(r.company_id)) then
  raise exception 'Só quem criou o link ou um líder desativa o compartilhamento.' using errcode = '42501';
 end if;
 delete from public.meeting_shares where recording_id = r.id;
 perform mavi_private.drive_log(r.company_id, 'recording_unshared', null, null, mavi_private.meeting_share_title(r),
  r.client_id, null, jsonb_build_object('recording', r.id, 'opens', s.opens, 'downloads', s.downloads));
end $$;

-- As gravações do cliente com link público (o selo na lista).
create function public.meeting_shared_recordings(p_company uuid, p_client uuid)
returns table(recording_id uuid, expires_at timestamptz)
language sql stable security definer set search_path = '' as $$
 select s.recording_id, s.expires_at from public.meeting_shares s
 join public.meeting_recordings r on r.company_id = s.company_id and r.id = s.recording_id
 where s.company_id = p_company and r.client_id = p_client and mavi_private.drive_can_read(p_company, p_client)
$$;

do $$ declare f record; begin
 for f in select p.oid::regprocedure as signature from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = any(array['meeting_share', 'set_meeting_share',
   'delete_meeting_share', 'meeting_shared_recordings']) loop
  execute format('revoke all on function %s from public, anon', f.signature);
  execute format('grant execute on function %s to authenticated', f.signature);
 end loop;
end $$;

-- ------------------------------------------------------------ link público
-- 'ok' | 'expired' | 'password' (pede a senha) | 'wrong' (senha errada) |
-- 'locked' (senhas erradas demais).
create function mavi_private.meeting_share_access(s public.meeting_shares, p_password text) returns text
language plpgsql volatile security definer set search_path = '' as $$ begin
 if s.expires_at is not null and s.expires_at <= now() then return 'expired'; end if;
 if s.password_hash is null then return 'ok'; end if;
 if s.failures >= 10 and s.failures_since > now() - interval '15 minutes' then return 'locked'; end if;
 if nullif(p_password, '') is null then return 'password'; end if;
 if s.password_hash = extensions.crypt(p_password, s.password_hash) then return 'ok'; end if;
 update public.meeting_shares set
  failures = case when failures_since is null or failures_since < now() - interval '15 minutes' then 1 else failures + 1 end,
  failures_since = case when failures_since is null or failures_since < now() - interval '15 minutes'
   then now() else failures_since end
 where recording_id = s.recording_id;
 return 'wrong';
end $$;
revoke all on function mavi_private.meeting_share_access(public.meeting_shares, text) from public, anon, authenticated;

-- A página pública: só o que o link mostra. Sem e-mails da agência, sem
-- próximos passos, sem o caminho do vídeo. p_opened conta a abertura (uma
-- vez por visita).
create function public.meeting_public(p_token text, p_password text default null, p_opened boolean default false)
returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare s public.meeting_shares; r public.meeting_recordings; t public.meeting_transcripts; access text; begin
 if p_token is null or p_token !~ '^[0-9a-f]{64}$' then return null; end if;
 select * into s from public.meeting_shares where token = p_token;
 if not found then return null; end if;
 access := mavi_private.meeting_share_access(s, p_password);
 if access <> 'ok' then return jsonb_build_object('status', access); end if;
 select * into r from public.meeting_recordings where company_id = s.company_id and id = s.recording_id;
 if s.show_transcript then
  select * into t from public.meeting_transcripts where company_id = s.company_id and recording_id = r.id;
 end if;
 if coalesce(p_opened, false) then
  update public.meeting_shares set opens = opens + 1, last_opened_at = now() where recording_id = s.recording_id;
  perform mavi_private.drive_log(r.company_id, 'recording_public_opened', null, null,
   mavi_private.meeting_share_title(r), r.client_id, null, jsonb_build_object('recording', r.id));
 end if;
 return jsonb_build_object('status', 'ok',
  'company', (select c.name from public.companies c where c.id = r.company_id),
  'title', mavi_private.meeting_share_title(r),
  'recorded_at', r.recorded_at,
  'duration_seconds', r.duration_seconds,
  'speakers', to_jsonb(r.speakers),
  'video', s.show_video and r.video_path is not null,
  'download', s.allow_download,
  'expires_at', s.expires_at,
  'show_transcript', s.show_transcript,
  'show_summary', s.show_summary,
  'summary', case when s.show_summary then r.summary - 'todo' - 'action_items' end,
  'transcript', case when s.show_transcript and t.recording_id is not null then jsonb_build_object(
   'speakers', to_jsonb(t.speakers), 'segments', t.segments, 'timed', t.timed) end);
end $$;

-- O vídeo do link, para /api/drive (que assina o endereço). Baixar só com
-- o download liberado; cada download conta e entra no histórico.
create function public.meeting_public_video(p_token text, p_password text default null,
 p_download boolean default false, p_origin jsonb default null)
returns table(bucket text, path text, content_type text, title text)
language plpgsql volatile security definer set search_path = '' as $$
declare s public.meeting_shares; r public.meeting_recordings; begin
 if p_token is null or p_token !~ '^[0-9a-f]{64}$' then return; end if;
 select * into s from public.meeting_shares m where m.token = p_token;
 if not found or mavi_private.meeting_share_access(s, p_password) <> 'ok' or not s.show_video then return; end if;
 select * into r from public.meeting_recordings m where m.company_id = s.company_id and m.id = s.recording_id;
 if r.video_path is null then return; end if;
 if coalesce(p_download, false) then
  if not s.allow_download then return; end if;
  update public.meeting_shares set downloads = downloads + 1 where recording_id = s.recording_id;
  perform mavi_private.drive_log(r.company_id, 'recording_public_downloaded', null, null,
   mavi_private.meeting_share_title(r), r.client_id, null, jsonb_build_object('recording', r.id),
   mavi_private.clean_origin(p_origin));
 end if;
 return query select r.video_bucket, r.video_path, r.video_type, mavi_private.meeting_share_title(r);
end $$;

revoke all on function public.meeting_public(text, text, boolean),
 public.meeting_public_video(text, text, boolean, jsonb) from public;
grant execute on function public.meeting_public(text, text, boolean),
 public.meeting_public_video(text, text, boolean, jsonb) to anon, authenticated;

commit;
