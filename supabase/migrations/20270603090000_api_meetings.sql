begin;

-- API pública: POST /api/v1/clients/{id}/meetings registra uma reunião já
-- feita (gravada fora da MAVI: Zoom, Fireflies, tl;dv…) nas Gravações do
-- cliente, com transcrição e o resumo de quem envia. A busca da MAVI, o
-- Termômetro e o Radar seguem pelos gatilhos de sempre (ai_knowledge,
-- client_temperature, client_radar).
--
-- O servidor (api/_api-meetings.ts) já normaliza a transcrição para o
-- formato das gravações ({speakers, segments}) e o resumo para as chaves de
-- sempre; o banco confere de novo os limites e isola a empresa pela chave.
--
-- O vídeo vem por link: entra na fila abaixo e o worker (ação
-- "meeting-video-import" de /api/ai, com o segredo) baixa e guarda no GCS;
-- só então a gravação ganha video_bucket/video_path.

create table mavi_private.meeting_video_imports (
 recording_id uuid primary key,
 company_id uuid not null,
 url text not null check (url ~ '^https://' and length(url) <= 2000),
 status text not null default 'pending' check (status in ('pending', 'working', 'done', 'failed')),
 attempts integer not null default 0,
 error text,
 next_at timestamptz not null default now(),
 claimed_at timestamptz,
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 foreign key(company_id, recording_id) references public.meeting_recordings(company_id, id) on delete cascade
);
create index meeting_video_imports_due on mavi_private.meeting_video_imports(next_at) where status in ('pending', 'working');
revoke all on mavi_private.meeting_video_imports from public, anon, authenticated;

-- Acorda o worker (o pg_net não espera a resposta).
create function mavi_private.meeting_video_kick() returns void
language plpgsql security definer set search_path = '' as $$
declare cfg record; begin
 select url, secret into cfg from mavi_private.ai_config limit 1;
 if cfg.url is null or cfg.secret is null then return; end if;
 perform net.http_post(url := cfg.url, body := '{"action":"meeting-video-import"}'::jsonb,
  headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || cfg.secret),
  timeout_milliseconds := 5000);
exception when others then
 raise warning 'meeting_video_kick: %', sqlerrm;
end $$;
revoke all on function mavi_private.meeting_video_kick() from public, anon, authenticated;

-- O agendamento: só chama o worker quando há vídeo esperando a vez (nova
-- tentativa) ou parado há mais de 10 minutos.
create function mavi_private.meeting_video_due() returns void
language plpgsql security definer set search_path = '' as $$ begin
 if exists (select 1 from mavi_private.meeting_video_imports
  where (status = 'pending' and next_at <= now())
   or (status = 'working' and claimed_at < now() - interval '10 minutes')) then
  perform mavi_private.meeting_video_kick();
 end if;
end $$;
revoke all on function mavi_private.meeting_video_due() from public, anon, authenticated;

-- POST /api/v1/clients/{id}/meetings
create function public.api_create_meeting(p_key text, p_client uuid, p_meeting jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare c uuid := mavi_private.api_company(p_key); m jsonb := p_meeting; v_external text; v_source text;
 v_title text; v_at timestamptz; v_duration integer; v_by text; v_link text; v_video text; v_summary jsonb;
 v_attendees text[] := '{}'; v_speakers text[] := '{}'; v_segments jsonb; dup uuid; result uuid; s jsonb; begin
 if jsonb_typeof(m) is distinct from 'object' then
  raise exception 'Corpo inválido' using errcode = '22023';
 end if;
 if not exists (select 1 from public.clients where company_id = c and id = p_client) then
  raise exception 'Cliente não encontrado' using errcode = 'P0002';
 end if;

 v_external := nullif(trim(coalesce(m ->> 'external_id', '')), '');
 if v_external is not null and length(v_external) > 100 then
  raise exception 'external_id deve ter até 100 caracteres' using errcode = '22023';
 end if;
 v_source := 'api:' || coalesce(v_external, gen_random_uuid()::text);

 v_title := trim(coalesce(m ->> 'title', ''));
 if length(v_title) > 300 then raise exception 'title deve ter até 300 caracteres' using errcode = '22023'; end if;

 if nullif(trim(coalesce(m ->> 'recorded_at', '')), '') is null then
  raise exception 'Informe recorded_at (data e hora da reunião, ISO 8601)' using errcode = '22023';
 end if;
 begin
  v_at := (m ->> 'recorded_at')::timestamptz;
 exception when others then
  raise exception 'recorded_at inválido: use ISO 8601, ex. 2026-10-07T14:00:00-03:00' using errcode = '22023';
 end;
 if v_at > now() + interval '1 day' or v_at < '2000-01-01' then
  raise exception 'recorded_at fora do intervalo aceito' using errcode = '22023';
 end if;

 if m ? 'duration_seconds' and jsonb_typeof(m -> 'duration_seconds') <> 'null' then
  if jsonb_typeof(m -> 'duration_seconds') <> 'number' or (m ->> 'duration_seconds')::numeric not between 0 and 86400 then
   raise exception 'duration_seconds deve ser um número de 0 a 86400' using errcode = '22023';
  end if;
  v_duration := round((m ->> 'duration_seconds')::numeric);
 end if;

 v_by := lower(trim(coalesce(m ->> 'recorded_by_email', '')));
 if v_by <> '' and v_by !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
  raise exception 'recorded_by_email inválido' using errcode = '22023';
 end if;

 v_link := nullif(trim(coalesce(m ->> 'meet_link', '')), '');
 if v_link is not null and (length(v_link) > 500 or v_link !~* '^https?://') then
  raise exception 'meet_link deve ser um link http(s) de até 500 caracteres' using errcode = '22023';
 end if;

 v_video := nullif(trim(coalesce(m ->> 'video_url', '')), '');
 if v_video is not null and (length(v_video) > 2000 or v_video !~ '^https://') then
  raise exception 'video_url deve ser um link https de até 2000 caracteres' using errcode = '22023';
 end if;

 if jsonb_typeof(coalesce(m -> 'attendees', '[]')) <> 'array' or jsonb_array_length(coalesce(m -> 'attendees', '[]')) > 200 then
  raise exception 'attendees deve ser uma lista de até 200 itens' using errcode = '22023';
 end if;
 for s in select * from jsonb_array_elements(coalesce(m -> 'attendees', '[]')) loop
  if jsonb_typeof(s) <> 'string' or length(trim(s #>> '{}')) not between 1 and 200 then
   raise exception 'attendees deve conter textos (nome ou e-mail) de até 200 caracteres' using errcode = '22023';
  end if;
  v_attendees := v_attendees || trim(s #>> '{}');
 end loop;

 v_summary := coalesce(m -> 'summary', '{}');
 if jsonb_typeof(v_summary) <> 'object' then raise exception 'summary deve ser um objeto' using errcode = '22023'; end if;
 if length(v_summary::text) > 200000 then raise exception 'summary grande demais' using errcode = '22023'; end if;

 v_segments := coalesce(m #> '{transcript,segments}', '[]');
 if jsonb_typeof(v_segments) <> 'array' or jsonb_typeof(coalesce(m #> '{transcript,speakers}', '[]')) <> 'array' then
  raise exception 'transcript inválida' using errcode = '22023';
 end if;
 if jsonb_array_length(v_segments) > 20000 then
  raise exception 'A transcrição pode ter até 20000 trechos' using errcode = '22023';
 end if;
 if exists (select 1 from jsonb_array_elements(v_segments) x
  where jsonb_typeof(x) <> 'array' or jsonb_array_length(x) <> 4 or jsonb_typeof(x -> 3) <> 'string'
   or jsonb_typeof(x -> 0) not in ('number', 'null') or jsonb_typeof(x -> 1) not in ('number', 'null')
   or jsonb_typeof(x -> 2) not in ('number', 'null')) then
  raise exception 'transcript inválida' using errcode = '22023';
 end if;
 select coalesce(array_agg(left(trim(x), 120) order by n), '{}') into v_speakers
 from jsonb_array_elements_text(coalesce(m #> '{transcript,speakers}', '[]')) with ordinality t(x, n);
 if cardinality(v_speakers) > 200 then
  raise exception 'A transcrição pode ter até 200 falantes' using errcode = '22023';
 end if;

 if jsonb_array_length(v_segments) = 0 and v_summary = '{}' and v_video is null then
  raise exception 'Envie ao menos a transcrição, o resumo ou o video_url' using errcode = '22023';
 end if;

 select id into dup from public.meeting_recordings where company_id = c and source_id = v_source;
 if dup is not null then
  raise exception 'Já existe uma reunião com este external_id' using errcode = '23505', detail = dup::text;
 end if;

 insert into public.meeting_recordings(company_id, client_id, source_id, title, recorded_at, duration_seconds,
  recorded_by_email, attendees, speakers, meet_link, summary)
 values (c, p_client, v_source, v_title, v_at, v_duration, v_by, v_attendees, v_speakers, v_link, v_summary)
 returning id into result;
 if jsonb_array_length(v_segments) > 0 then
  insert into public.meeting_transcripts(recording_id, company_id, speakers, segments)
  values (result, c, v_speakers, v_segments);
 end if;
 if v_video is not null then
  insert into mavi_private.meeting_video_imports(recording_id, company_id, url) values (result, c, v_video);
  perform mavi_private.meeting_video_kick();
 end if;

 return jsonb_build_object('meeting', jsonb_build_object(
  'id', result, 'client_id', p_client, 'external_id', v_external, 'title', v_title, 'recorded_at', v_at,
  'duration_seconds', v_duration, 'recorded_by_email', v_by, 'attendees', to_jsonb(v_attendees),
  'meet_link', v_link, 'speakers', to_jsonb(v_speakers), 'segments', jsonb_array_length(v_segments),
  'timed', coalesce((select bool_or(jsonb_typeof(x -> 0) = 'number') from jsonb_array_elements(v_segments) x), false),
  'summary', v_summary,
  'video', case when v_video is null then 'none' else 'pending' end));
end $$;
revoke all on function public.api_create_meeting(text, uuid, jsonb) from public, anon, authenticated;
grant execute on function public.api_create_meeting(text, uuid, jsonb) to anon, authenticated;

-- O worker pega até p_limit vídeos (os que chegaram a vez e os parados).
create function public.meeting_video_claim(p_secret text, p_limit integer default 2)
returns table(recording_id uuid, company_id uuid, url text, attempts integer)
language plpgsql security definer set search_path = '' as $$ begin
 if not mavi_private.ai_secret_ok(p_secret) then raise exception 'Sem permissão' using errcode = '42501'; end if;
 -- Parou três vezes no meio (a função acabou o tempo): não tenta mais.
 update mavi_private.meeting_video_imports i set status = 'failed', updated_at = now(),
  error = 'O download não terminou a tempo (vídeo grande demais ou servidor lento).'
 where i.status = 'working' and i.claimed_at < now() - interval '10 minutes' and i.attempts >= 3;
 return query
 with picked as (
  select i.recording_id from mavi_private.meeting_video_imports i
  where (i.status = 'pending' and i.next_at <= now())
   or (i.status = 'working' and i.claimed_at < now() - interval '10 minutes')
  order by i.next_at
  limit least(greatest(coalesce(p_limit, 2), 1), 5)
  for update skip locked)
 update mavi_private.meeting_video_imports i set status = 'working', claimed_at = now(),
  attempts = i.attempts + 1, updated_at = now()
 from picked where i.recording_id = picked.recording_id
 returning i.recording_id, i.company_id, i.url, i.attempts;
end $$;

-- O resultado do worker: com p_path o vídeo vai para a gravação; sem ele,
-- p_retry devolve à fila (até 3 tentativas, 15 e 60 minutos depois) ou o
-- erro fica registrado.
create function public.meeting_video_save(p_secret text, p_recording uuid, p_bucket text, p_path text,
 p_type text, p_bytes bigint, p_error text, p_retry boolean default false) returns void
language plpgsql security definer set search_path = '' as $$
declare i mavi_private.meeting_video_imports; begin
 if not mavi_private.ai_secret_ok(p_secret) then raise exception 'Sem permissão' using errcode = '42501'; end if;
 select * into i from mavi_private.meeting_video_imports where recording_id = p_recording for update;
 if not found then return; end if;
 if nullif(p_path, '') is not null and nullif(p_bucket, '') is not null then
  update public.meeting_recordings set video_bucket = p_bucket, video_path = p_path,
   video_type = left(coalesce(nullif(p_type, ''), 'video/mp4'), 100), video_bytes = greatest(p_bytes, 0)
  where company_id = i.company_id and id = i.recording_id;
  update mavi_private.meeting_video_imports set status = 'done', error = null, updated_at = now()
  where recording_id = i.recording_id;
 elsif coalesce(p_retry, false) and i.attempts < 3 then
  update mavi_private.meeting_video_imports set status = 'pending', claimed_at = null,
   next_at = now() + case when i.attempts = 1 then interval '15 minutes' else interval '60 minutes' end,
   error = left(coalesce(p_error, ''), 500), updated_at = now()
  where recording_id = i.recording_id;
 else
  update mavi_private.meeting_video_imports set status = 'failed',
   error = left(coalesce(nullif(p_error, ''), 'Não foi possível baixar o vídeo.'), 500), updated_at = now()
  where recording_id = i.recording_id;
 end if;
end $$;
revoke all on function public.meeting_video_claim(text, integer),
 public.meeting_video_save(text, uuid, text, text, text, bigint, text, boolean) from public, anon, authenticated;
grant execute on function public.meeting_video_claim(text, integer),
 public.meeting_video_save(text, uuid, text, text, text, bigint, text, boolean) to anon, authenticated;

do $$ begin
 if exists (select 1 from pg_extension where extname = 'pg_cron') then
  perform cron.schedule('mavi-meeting-video', '*/10 * * * *', 'select mavi_private.meeting_video_due();');
 end if;
end $$;

commit;
