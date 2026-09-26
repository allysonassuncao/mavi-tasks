begin;

-- Social Leads › "Preencher com a IA": as reuniões do cliente aparecem como
-- em Drive › Gravações da MAVI (meetingTitle): o título do resumo da IA da
-- gravação, senão o título da reunião; com um trecho da visão geral e quem
-- falou, para achar a reunião certa sem abrir cada uma.

create or replace function public.social_leads_meetings(p_company uuid, p_contract uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare client uuid; begin
 if not mavi_private.social_leads_can_write(p_company, p_contract) then
  raise exception 'Sem permissão.' using errcode = '42501';
 end if;
 select client_id into client from public.contracts where company_id = p_company and id = p_contract;
 return coalesce((
  select jsonb_agg(jsonb_build_object('id', r.id,
   'title', coalesce(nullif(trim(r.summary->>'title'), ''), nullif(trim(r.title), ''), ''),
   'overview', left(coalesce(r.summary->>'overview', ''), 220),
   'speakers', to_jsonb(r.speakers),
   'recorded_at', r.recorded_at, 'duration_seconds', r.duration_seconds,
   'has_transcript', exists (select 1 from public.meeting_transcripts t
    where t.company_id = r.company_id and t.recording_id = r.id and jsonb_array_length(t.segments) > 0))
   order by r.recorded_at desc)
  from (select * from public.meeting_recordings
   where company_id = p_company and client_id = client order by recorded_at desc limit 30) r
 ), '[]'::jsonb);
end $$;
revoke all on function public.social_leads_meetings(uuid, uuid) from public, anon;
grant execute on function public.social_leads_meetings(uuid, uuid) to authenticated;

-- A IA também lê o título do resumo.
create or replace function public.social_leads_meeting_text(p_company uuid, p_contract uuid, p_recording uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare r public.meeting_recordings; t public.meeting_transcripts; begin
 if not mavi_private.social_leads_can_write(p_company, p_contract) then
  raise exception 'Sem permissão.' using errcode = '42501';
 end if;
 select m.* into r from public.meeting_recordings m
 join public.contracts k on k.company_id = m.company_id and k.client_id = m.client_id
 where m.company_id = p_company and m.id = p_recording and k.id = p_contract;
 if not found then raise exception 'Reunião não encontrada.' using errcode = 'P0002'; end if;
 select * into t from public.meeting_transcripts where company_id = p_company and recording_id = r.id;
 if not found or jsonb_array_length(t.segments) = 0 then
  raise exception 'Esta reunião ainda não tem transcrição.' using errcode = 'P0002';
 end if;
 return jsonb_build_object('title', coalesce(nullif(trim(r.summary->>'title'), ''), nullif(trim(r.title), ''), ''),
  'recorded_at', r.recorded_at, 'speakers', to_jsonb(t.speakers), 'segments', t.segments, 'summary', r.summary);
end $$;
revoke all on function public.social_leads_meeting_text(uuid, uuid, uuid) from public, anon;
grant execute on function public.social_leads_meeting_text(uuid, uuid, uuid) to authenticated;

notify pgrst, 'reload schema';

commit;
