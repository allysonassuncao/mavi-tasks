begin;

-- Update bind_inline_images to support GCS storage where files are stored in GCS
-- rather than Supabase internal storage.objects.
create or replace function mavi_private.bind_inline_images(c uuid, t uuid, body text) returns void
language plpgsql security definer set search_path = '' as $$
declare doc jsonb; node jsonb; image_id uuid; image_row public.inline_images; begin
 if left(body,17)<>'mavi:richtext:v1:' then return; end if;
 doc:=substring(body from 18)::jsonb;
 for node in select distinct value from jsonb_path_query(doc,'$.** ? (@.type == "inlineImage")') as nodes(value) loop
  image_id:=(node->'attrs'->>'imageId')::uuid;
  select * into image_row from public.inline_images where id=image_id for update;
  if not found or image_row.company_id<>c or not ((image_row.task_id is not distinct from t) or (image_row.task_id is null and image_row.uploaded_by=auth.uid())) then
    raise exception 'Imagem não autorizada para esta tarefa' using errcode='42501';
  end if;
  update public.inline_images set task_id=t where id=image_id and task_id is null;
 end loop;
end $$;

revoke all on function mavi_private.bind_inline_images(uuid,uuid,text) from public,anon,authenticated;

commit;
