begin;

-- Skills · devolver com texto formatado e anexos:
--
-- 1. O "O que precisa mudar?" passa a ser texto rico (o mesmo editor das
--    tarefas: negrito, listas, imagens no texto). O valor guardado é o
--    serializado (mavi:richtext:v1:…), então o limite sobe; o aviso na caixa
--    de entrada leva só o texto puro, que a tela manda à parte.
-- 2. Anexos da devolução: qualquer arquivo de até 100 MB (menos programas),
--    até 10 por devolução, no bucket público (caminho com uuid). O líder
--    prepara e envia antes de devolver; só os que a devolução cita aparecem.
--    Quem vê: quem edita a skill (quem criou e os líderes).

alter table public.ai_skill_versions drop constraint ai_skill_versions_review_note_check;
alter table public.ai_skill_versions add constraint ai_skill_versions_review_note_check
 check (length(review_note) <= 60000);

create table public.ai_skill_review_files (
 id uuid primary key default gen_random_uuid(),
 company_id uuid not null,
 skill_id uuid not null,
 version integer not null,
 name text not null check (length(btrim(name)) between 1 and 240),
 -- <empresa>/skills/<skill>/<versão>/<anexo>
 path text not null unique,
 size_bytes bigint not null check (size_bytes between 1 and 104857600),
 -- Falso até o envio terminar; sent: a devolução levou o anexo.
 uploaded boolean not null default false,
 sent boolean not null default false,
 uploaded_by uuid not null default auth.uid(),
 created_at timestamptz not null default now(),
 foreign key (skill_id, version) references public.ai_skill_versions(skill_id, version) on delete cascade
);
create index ai_skill_review_files_version on public.ai_skill_review_files(skill_id, version) where sent;
alter table public.ai_skill_review_files enable row level security;
revoke all on public.ai_skill_review_files from public, anon, authenticated;

-- Um anexo para a versão que espera aprovação (líderes).
create function public.prepare_skill_review_file(p_skill uuid, p_version integer, p_name text, p_size bigint)
returns uuid language plpgsql security definer set search_path = '' as $$
declare s public.ai_skills; v public.ai_skill_versions; v_id uuid := gen_random_uuid(); begin
 select * into s from public.ai_skills where id = p_skill;
 if s.id is null or not mavi_private.leader(s.company_id) then
  raise exception 'Só administradores e gestores devolvem skills.' using errcode = '42501';
 end if;
 select * into v from public.ai_skill_versions where skill_id = p_skill and version = p_version;
 if v.state is distinct from 'pending' then
  raise exception 'Esta versão não está esperando aprovação.' using errcode = 'P0002';
 end if;
 if length(btrim(coalesce(p_name, ''))) not between 1 and 240 then
  raise exception 'Nome de arquivo inválido' using errcode = '22023';
 end if;
 if mavi_private.blocked_file(p_name) then
  raise exception 'Por segurança, programas e scripts (.exe, .bat, .sh, .apk…) não podem ser anexados.'
   using errcode = '22023';
 end if;
 if coalesce(p_size, 0) not between 1 and 104857600 then
  raise exception 'Escolha um arquivo não vazio de até 100 MB.' using errcode = '22023';
 end if;
 -- Envios que ficaram pela metade (ou devoluções desistidas) somem.
 delete from public.ai_skill_review_files where uploaded_by = auth.uid() and not sent
  and created_at < now() - interval '1 day';
 if (select count(*) from public.ai_skill_review_files where skill_id = p_skill and version = p_version
   and uploaded_by = auth.uid() and not sent) >= 10 then
  raise exception 'Uma devolução tem até 10 anexos.' using errcode = '22023';
 end if;
 insert into public.ai_skill_review_files(id, company_id, skill_id, version, name, path, size_bytes)
 values (v_id, s.company_id, p_skill, p_version, btrim(p_name),
  s.company_id::text || '/skills/' || p_skill::text || '/' || p_version || '/' || v_id::text, p_size);
 return v_id;
end $$;

-- Para /api/gcs/sign-upload: o que quem chama acabou de preparar.
create function public.skill_review_file_upload_target(p_file uuid)
returns table(path text, name text, size_bytes bigint)
language sql stable security definer set search_path = '' as $$
 select f.path, f.name, f.size_bytes from public.ai_skill_review_files f
 where f.id = p_file and f.uploaded_by = auth.uid() and not f.uploaded and not f.sent
  and f.created_at > now() - interval '15 minutes' and mavi_private.leader(f.company_id)
$$;

create function public.confirm_skill_review_file(p_file uuid) returns void
language plpgsql security definer set search_path = '' as $$ begin
 update public.ai_skill_review_files set uploaded = true
 where id = p_file and uploaded_by = auth.uid() and not uploaded;
 if not found then raise exception 'Anexo não encontrado' using errcode = 'P0002'; end if;
end $$;

create function public.discard_skill_review_file(p_file uuid) returns void
language sql security definer set search_path = '' as $$
 delete from public.ai_skill_review_files where id = p_file and uploaded_by = auth.uid() and not sent
$$;

-- Os anexos da devolução de uma versão (quem edita a skill).
create function public.skill_review_files(p_skill uuid, p_version integer) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare s public.ai_skills; begin
 select * into s from public.ai_skills where id = p_skill;
 if s.id is null or not mavi_private.ai_skill_editor(s) then return '[]'; end if;
 return (select coalesce(jsonb_agg(jsonb_build_object('id', f.id, 'name', f.name, 'path', f.path,
   'size_bytes', f.size_bytes) order by f.created_at), '[]')
  from public.ai_skill_review_files f where f.skill_id = p_skill and f.version = p_version and f.sent);
end $$;

-- Aprovar ou devolver: agora com o texto puro (para o aviso) e os anexos.
drop function public.ai_skill_review(uuid, integer, boolean, text);
create function public.ai_skill_review(p_skill uuid, p_version integer, p_approve boolean, p_note text,
 p_plain text default null, p_files uuid[] default '{}')
returns void language plpgsql security definer set search_path = '' as $$
declare s public.ai_skills; v public.ai_skill_versions; v_plain text; n integer; begin
 select * into s from public.ai_skills where id = p_skill;
 if s.id is null or not mavi_private.leader(s.company_id) then
  raise exception 'Só administradores e gestores aprovam skills.' using errcode = '42501';
 end if;
 select * into v from public.ai_skill_versions where skill_id = p_skill and version = p_version for update;
 if v.state is distinct from 'pending' then
  raise exception 'Esta versão não está esperando aprovação.' using errcode = 'P0002';
 end if;
 v_plain := btrim(coalesce(p_plain, p_note, ''));
 if not coalesce(p_approve, false) then
  update public.ai_skill_review_files set sent = true
  where skill_id = p_skill and version = p_version and uploaded_by = auth.uid() and uploaded and not sent
   and id = any(coalesce(p_files, '{}'));
  get diagnostics n = row_count;
  if length(v_plain) < 3 and n = 0 then
   raise exception 'Diga o que precisa mudar.' using errcode = '22023';
  end if;
 end if;
 update public.ai_skill_versions set review_note = nullif(btrim(coalesce(p_note, '')), '')
 where skill_id = p_skill and version = p_version;
 if p_approve then
  perform mavi_private.ai_skill_publish(p_skill, p_version);
 else
  update public.ai_skill_versions set state = 'rejected', reviewed_by = auth.uid(), reviewed_at = now()
  where skill_id = p_skill and version = p_version;
 end if;
 perform mavi_private.ai_skill_notify(s.company_id, array[v.created_by, s.author_id], s.id,
  case when p_approve then 'Sua skill foi aprovada' else 'Sua skill voltou para ajustes' end,
  v.name || ' · versão ' || v.version || coalesce(' · ' || nullif(regexp_replace(v_plain, '\s+', ' ', 'g'), ''), ''));
end $$;

revoke all on function public.prepare_skill_review_file(uuid, integer, text, bigint),
 public.skill_review_file_upload_target(uuid), public.confirm_skill_review_file(uuid),
 public.discard_skill_review_file(uuid), public.skill_review_files(uuid, integer),
 public.ai_skill_review(uuid, integer, boolean, text, text, uuid[]) from public, anon;
grant execute on function public.prepare_skill_review_file(uuid, integer, text, bigint),
 public.skill_review_file_upload_target(uuid), public.confirm_skill_review_file(uuid),
 public.discard_skill_review_file(uuid), public.skill_review_files(uuid, integer),
 public.ai_skill_review(uuid, integer, boolean, text, text, uuid[]) to authenticated;

commit;
