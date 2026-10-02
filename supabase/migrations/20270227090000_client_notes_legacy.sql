begin;

-- Anotações do cliente, parte 2 (depois de 20270226090000_client_notes):
--
-- 1. Imagens no texto. As imagens coladas numa anotação ficavam sem dono
--    (inline_images.task_id nulo): só quem colou via e, em 24 horas, a
--    limpeza apagava. Agora a anotação prende as imagens dela (note_id), quem
--    vê o cliente vê as imagens, e a limpeza deixa as presas em paz.
-- 2. O bloco de notas do MASO (scripts/import-maso-notes.mjs). Cada linha do
--    MASO é uma versão; quem escreveu e não está no MAVI aparece pelo nome do
--    MASO ("Fulano (MASO)"), e a versão importada diz de onde veio.

-- ------------------------------------------------------------ imagens
alter table public.inline_images
 add column note_id uuid references public.client_notes(id) on delete set null;
create index inline_images_note on public.inline_images(note_id) where note_id is not null;

drop policy inline_images_read on public.inline_images;
create policy inline_images_read on public.inline_images for select to authenticated using (
 mavi_private.member(company_id) and (
  (task_id is null and note_id is null and uploaded_by = (select auth.uid()))
  or (task_id is not null and mavi_private.task_access(company_id, task_id))
  -- A anotação filtra pelas regras dela (quem vê o cliente).
  or (note_id is not null and exists (select 1 from public.client_notes n where n.id = inline_images.note_id))));

-- Prende à anotação as imagens do texto ainda soltas, enviadas por quem
-- salva. Uma imagem que já é de uma tarefa ou de outra anotação (o texto foi
-- copiado de lá) não muda de dono, e o salvamento segue.
create function mavi_private.bind_note_images() returns trigger
language plpgsql security definer set search_path = '' as $$
declare doc jsonb; image_id uuid; begin
 if left(new.body, 17) <> 'mavi:richtext:v1:' then return null; end if;
 begin
  doc := substring(new.body from 18)::jsonb;
 exception when others then return null;
 end;
 for image_id in select distinct (x.value->'attrs'->>'imageId')::uuid
  from jsonb_path_query(doc, '$.** ? (@.type == "inlineImage")') as x(value)
  where x.value->'attrs'->>'imageId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' loop
  update public.inline_images set note_id = new.id
  where id = image_id and company_id = new.company_id and task_id is null and note_id is null
   and uploaded_by = auth.uid();
 end loop;
 return null;
end $$;
revoke all on function mavi_private.bind_note_images() from public, anon, authenticated;
create trigger bind_note_images after insert or update of body on public.client_notes
 for each row execute function mavi_private.bind_note_images();

create or replace function mavi_private.claim_storage_cleanup() returns table(bucket_id text,path text)
language plpgsql security definer set search_path='' as $$ begin
 -- Uploaded but never bound, or abandoned before upload. Bind takes the same lock.
 with expired as (select id from public.inline_images where task_id is null and note_id is null
   and created_at<now()-interval '24 hours' order by created_at,id limit 100 for update skip locked),
 removed as (delete from public.inline_images i using expired e where i.id=e.id returning i.path)
 insert into mavi_private.storage_cleanup(bucket_id,path)
 select 'mavi-inline-images',r.path from removed r on conflict do nothing;
 -- Attachment metadata already links to a task at prepare time; preserve every
 -- successfully uploaded attachment, including ones the client failed to confirm.
 with expired as (select a.id from public.attachments a where a.created_at<now()-interval '24 hours'
   and not exists(select 1 from storage.objects o where o.bucket_id='mavi-attachments' and o.name=a.path)
   order by a.created_at,a.id limit 100 for update of a skip locked),
 removed as (delete from public.attachments a using expired e where a.id=e.id returning a.path)
 insert into mavi_private.storage_cleanup(bucket_id,path)
 select 'mavi-attachments',r.path from removed r on conflict do nothing;
 -- Includes objects whose upload finished after their pending metadata expired.
 insert into mavi_private.storage_cleanup(bucket_id,path)
 select o.bucket_id,o.name from storage.objects o
 where o.bucket_id in ('mavi-attachments','mavi-inline-images') and o.created_at<now()-interval '24 hours'
 and not exists(select 1 from public.attachments a where o.bucket_id='mavi-attachments' and a.path=o.name)
 and not exists(select 1 from public.inline_images i where o.bucket_id='mavi-inline-images' and i.path=o.name)
 and not exists(select 1 from mavi_private.storage_cleanup q where q.bucket_id=o.bucket_id and q.path=o.name)
 order by o.created_at,o.id limit 100 on conflict do nothing;
 return query
 with pending as (select q.bucket_id,q.path from mavi_private.storage_cleanup q
   where q.next_attempt_at<=now() order by q.next_attempt_at,q.bucket_id,q.path limit 100 for update skip locked)
 update mavi_private.storage_cleanup q set next_attempt_at=now()+interval '15 minutes',attempts=q.attempts+1
 from pending p where q.bucket_id=p.bucket_id and q.path=p.path returning q.bucket_id,q.path;
end $$;

-- ------------------------------------------------------------ autor do MASO
alter table public.client_notes
 add column legacy_created_by text check (length(legacy_created_by) <= 120),
 add column legacy_updated_by text check (length(legacy_updated_by) <= 120);
alter table public.client_note_versions
 add column legacy_saved_by text check (length(legacy_saved_by) <= 120);
alter table public.client_note_versions drop constraint client_note_versions_action_check;
alter table public.client_note_versions add constraint client_note_versions_action_check
 check (action in ('create', 'save', 'restore', 'import'));

-- O nome de quem fez: a pessoa no MAVI ou, importado, o nome do MASO.
create function mavi_private.client_note_who(c uuid, u uuid, p_legacy text) returns text
language sql stable security definer set search_path = '' as $$
 select coalesce((select m.name from public.memberships m where m.company_id = c and m.user_id = u),
  case when nullif(btrim(p_legacy), '') is not null then btrim(p_legacy) || ' (MASO)' end)
$$;
revoke all on function mavi_private.client_note_who(uuid, uuid, text) from public, anon, authenticated;

create or replace function mavi_private.client_note_view(n public.client_notes, p_body boolean) returns jsonb
language sql stable security definer set search_path = '' as $$
 select jsonb_build_object('id', n.id, 'company_id', n.company_id, 'client_id', n.client_id, 'title', n.title,
  'excerpt', left(regexp_replace(mavi_private.client_note_plain(n.body), '\s+', ' ', 'g'), 180),
  'secrets', mavi_private.client_note_secret_count(n.body),
  'version', n.version, 'created_by', n.created_by,
  'created_by_name', mavi_private.client_note_who(n.company_id, n.created_by, n.legacy_created_by),
  'created_at', n.created_at, 'updated_by', n.updated_by,
  'updated_by_name', mavi_private.client_note_who(n.company_id, n.updated_by, n.legacy_updated_by),
  'updated_at', n.updated_at, 'deleted_at', n.deleted_at,
  'deleted_by_name', (select m.name from public.memberships m where m.company_id = n.company_id and m.user_id = n.deleted_by))
  || case when p_body then jsonb_build_object('body', n.body,
   'client_name', (select k.name from public.clients k where k.id = n.client_id)) else '{}' end
$$;

create or replace function mavi_private.client_note_write(p_note uuid, p_title text, p_body text, p_base integer,
 p_action text, p_from integer) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare n public.client_notes; v_title text := mavi_private.client_note_clean_title(p_title);
 v_body text := mavi_private.client_note_check_body(p_body); begin
 n := mavi_private.client_note_row(p_note);
 select * into n from public.client_notes where id = n.id for update;
 if n.deleted_at is not null then
  raise exception 'Esta anotação foi excluída. Restaure-a antes de editar.' using errcode = '22023';
 end if;
 if p_base is distinct from n.version then
  raise exception '% salvou uma versão nova desta anotação enquanto você editava.',
   coalesce(mavi_private.client_note_who(n.company_id, n.updated_by, n.legacy_updated_by), 'Outra pessoa')
   using errcode = '40001', hint = 'version:' || n.version;
 end if;
 if v_title = n.title and v_body = n.body then return mavi_private.client_note_view(n, true); end if;
 update public.client_notes set title = v_title, body = v_body, version = n.version + 1,
  updated_by = auth.uid(), legacy_updated_by = null, updated_at = now()
 where id = n.id returning * into n;
 insert into public.client_note_versions(company_id, note_id, version, title, body, action, restored_from, saved_by)
 values (n.company_id, n.id, n.version, n.title, n.body, p_action, p_from, auth.uid());
 perform mavi_private.drive_log(n.company_id, case p_action when 'restore' then 'note_restored' else 'note_saved' end,
  null, null, n.title, n.client_id, null,
  jsonb_strip_nulls(jsonb_build_object('note', n.id, 'version', n.version, 'from', p_from)));
 return mavi_private.client_note_view(n, true);
end $$;

create or replace function public.client_note_versions(p_note uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
 select coalesce(jsonb_agg(jsonb_build_object('version', v.version, 'title', v.title, 'action', v.action,
   'restored_from', v.restored_from, 'saved_by', v.saved_by,
   'saved_by_name', mavi_private.client_note_who(v.company_id, v.saved_by, v.legacy_saved_by),
   'saved_at', v.saved_at, 'chars', length(mavi_private.client_note_plain(v.body)),
   'secrets', mavi_private.client_note_secret_count(v.body)) order by v.version desc), '[]')
 from public.client_note_versions v where v.note_id = (mavi_private.client_note_row(p_note)).id
$$;

create or replace function public.client_note_version(p_note uuid, p_version integer) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare n public.client_notes := mavi_private.client_note_row(p_note); v public.client_note_versions; begin
 select * into v from public.client_note_versions where note_id = n.id and version = p_version;
 if v.id is null then raise exception 'Versão não encontrada.' using errcode = 'P0002'; end if;
 return jsonb_build_object('version', v.version, 'title', v.title, 'body', v.body, 'action', v.action,
  'restored_from', v.restored_from, 'saved_at', v.saved_at,
  'saved_by_name', mavi_private.client_note_who(v.company_id, v.saved_by, v.legacy_saved_by));
end $$;

create or replace function public.client_notes_context(p_company uuid, p_client uuid, p_limit integer default 20)
returns jsonb language plpgsql stable security definer set search_path = '' as $$ begin
 if not mavi_private.client_note_reader(p_company, p_client) then return '[]'; end if;
 return coalesce((select jsonb_agg(jsonb_build_object('id', x.id, 'title', x.title, 'updated_at', x.updated_at,
   'updated_by_name', x.who, 'text', left(mavi_private.client_note_plain(x.body), 6000)) order by x.updated_at desc)
  from (select n.*, mavi_private.client_note_who(n.company_id, n.updated_by, n.legacy_updated_by) as who
   from public.client_notes n where n.company_id = p_company and n.client_id = p_client and n.deleted_at is null
   order by n.updated_at desc limit least(greatest(coalesce(p_limit, 20), 1), 50)) x), '[]');
end $$;

commit;
