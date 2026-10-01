begin;

-- Tarefas: anexos importados do MASO (scripts/import-maso-tasks.mjs) ficam
-- no arquivo que o MASO já guarda no mesmo bucket (tasks/<cliente>/<tarefa>/
-- <arquivo>), sem cópia: o caminho do registro aponta para ele. Os anexos do
-- MAVI continuam em <empresa>/<tarefa>/<id> (prepare_attachment); só o import,
-- como postgres, grava um caminho tasks/…. Ninguém sobrescreve esses
-- arquivos pelo MAVI: o envio só é assinado nos 15 minutos depois do registro
-- (attachment_upload_target).
do $$ declare c text; begin
  for c in select conname from pg_constraint
   where conrelid = 'public.attachments'::regclass and contype = 'c'
    and pg_get_constraintdef(oid) like '%path =%'
  loop
    execute format('alter table public.attachments drop constraint %I', c);
  end loop;
end $$;
alter table public.attachments add constraint attachments_check check (
  path = company_id::text || '/' || task_id::text || '/' || id::text
  or path like 'tasks/%');

-- Excluir um anexo do MASO tira só o registro: o arquivo continua sendo do
-- MASO. Sem caminho, /api/gcs/sign-upload não apaga nada no bucket.
create or replace function public.delete_attachment(p_attachment uuid) returns text
language plpgsql security definer set search_path = '' as $$
declare a public.attachments; begin
  select * into a from public.attachments where id = p_attachment for update;
  if not found or not mavi_private.member(a.company_id) or not (
    mavi_private.leader(a.company_id)
    or (a.uploaded_by = auth.uid() and mavi_private.task_access(a.company_id, a.task_id))
  ) then
    raise exception 'Sem permissão' using errcode = '42501';
  end if;
  delete from public.attachments where id = a.id;
  insert into public.task_events(company_id, task_id, actor_id, action, detail)
  values (a.company_id, a.task_id, auth.uid(), 'attachment_deleted',
   jsonb_build_object('name', a.name, 'size_bytes', a.size_bytes));
  return case when a.path like 'tasks/%' then null else a.path end;
end $$;
revoke all on function public.delete_attachment(uuid) from public, anon;
grant execute on function public.delete_attachment(uuid) to authenticated;

commit;
