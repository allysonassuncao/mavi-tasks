begin;
create function public.discard_pending_attachment(p_attachment uuid) returns void
language plpgsql security definer set search_path = '' as $$ declare a public.attachments; begin
 select * into a from public.attachments where id=p_attachment for update;
 if not found then return; end if;
 if a.uploaded_by<>auth.uid() or not mavi_private.task_access(a.company_id,a.task_id) then raise exception 'Sem permissão' using errcode='42501'; end if;
 if exists(select 1 from storage.objects where bucket_id='mavi-attachments' and name=a.path) then raise exception 'O arquivo já foi enviado'; end if;
 delete from public.attachments where id=a.id;
end $$;
revoke all on function public.discard_pending_attachment(uuid) from public,anon;
grant execute on function public.discard_pending_attachment(uuid) to authenticated;
commit;
