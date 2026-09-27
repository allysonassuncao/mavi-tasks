begin;

-- Drive › cliente › "Whatsapp" (etapa 2): a pasta no Drive — conversas por
-- grupo, galeria de mídias e tarefas a partir das mensagens. A leitura das
-- mensagens já segue a regra do Drive (migration 20261027150000); aqui, o
-- que o servidor precisa para assinar os links das mídias.

-- Onde estão as mídias (só no servidor, que assina os links). Devolve só as
-- que a pessoa vê e que já foram copiadas para o GCS. Abrir ou baixar uma
-- mídia (p_download, uma por vez) entra no histórico do Drive; as prévias da
-- conversa e da galeria, não.
create function public.whatsapp_media_targets(p_ids uuid[], p_download boolean default false, p_origin jsonb default null)
returns table(id uuid, bucket text, path text, content_type text, name text, kind text)
language plpgsql security definer set search_path = '' as $$
#variable_conflict use_column
declare n integer := coalesce(cardinality(p_ids), 0); r record; begin
 if n = 0 then return; end if;
 if n > 100 then raise exception 'No máximo 100 mídias por vez.' using errcode = '22023'; end if;
 for r in
  select m.id, m.company_id, m.group_id, m.media_bucket, m.media_path, m.media_mime, m.media_name, m.kind,
   m.sent_at, g.client_id, g.title
  from public.whatsapp_messages m
  join public.whatsapp_groups g on g.company_id = m.company_id and g.id = m.group_id
  where m.id = any(p_ids) and m.media_status = 'stored'
   and g.client_id is not null and not g.ignored
   and g.company_id in (select mavi_private.active_companies())
   and mavi_private.drive_can_read(g.company_id, g.client_id)
 loop
  if p_download and n = 1 then
   perform mavi_private.drive_log(r.company_id, 'whatsapp_media_opened', null, null,
    coalesce(r.media_name, case r.kind when 'image' then 'Imagem' when 'video' then 'Vídeo'
     when 'audio' then 'Áudio' when 'sticker' then 'Figurinha' else 'Arquivo' end) || ' · ' || r.title,
    r.client_id, null, jsonb_build_object('message', r.id, 'group', r.group_id, 'kind', r.kind),
    mavi_private.clean_origin(p_origin));
  end if;
  id := r.id; bucket := r.media_bucket; path := r.media_path; content_type := r.media_mime;
  name := r.media_name; kind := r.kind;
  return next;
 end loop;
end $$;
revoke all on function public.whatsapp_media_targets(uuid[], boolean, jsonb) from public, anon;
grant execute on function public.whatsapp_media_targets(uuid[], boolean, jsonb) to authenticated;

-- Links enviados nos grupos (aba Links da galeria): as mensagens com
-- endereço, sem varrer o texto de todas.
create index whatsapp_messages_links on public.whatsapp_messages(company_id, group_id, sent_at desc)
 where kind = 'text' and body ~* 'https?://';

commit;
