begin;

-- Leaders (admins and managers) archive a former client and may bring it
-- back. Archiving keeps everything the client has (products, projects,
-- tasks, files) as history; it only stops new work from starting there.
create function public.set_client_archived(p_client uuid, p_archived boolean) returns void
language plpgsql security definer set search_path = '' as $$
declare c public.clients; begin
  select * into c from public.clients where id = p_client for update;
  if not found or not mavi_private.leader(c.company_id) then raise exception 'Sem permissão' using errcode = '42501'; end if;
  if p_archived is null then raise exception 'Informe se o cliente fica arquivado.'; end if;
  update public.clients set archived = p_archived where id = p_client;
end $$;
revoke all on function public.set_client_archived(uuid, boolean) from public, anon;
grant execute on function public.set_client_archived(uuid, boolean) to authenticated;

-- Nothing new for an archived client, whichever function creates it
-- (create_contract, create_project, create_task, submit_suggestion…).
create function mavi_private.reject_archived_client() returns trigger
language plpgsql security definer set search_path = '' as $$
declare r jsonb := to_jsonb(new); client uuid; begin
  client := coalesce((r->>'client_id')::uuid,
   (select k.client_id from public.contracts k where k.company_id = new.company_id and k.id = (r->>'contract_id')::uuid));
  if exists(select 1 from public.clients where company_id = new.company_id and id = client and archived) then
    raise exception 'Este cliente está arquivado. Desarquive-o para adicionar produtos, projetos ou tarefas.'
     using errcode = '22023';
  end if;
  return new;
end $$;
revoke all on function mavi_private.reject_archived_client() from public, anon, authenticated;

create trigger reject_archived_client before insert on public.contracts
 for each row execute function mavi_private.reject_archived_client();
create trigger reject_archived_client before insert on public.projects
 for each row execute function mavi_private.reject_archived_client();
create trigger reject_archived_client before insert on public.tasks
 for each row execute function mavi_private.reject_archived_client();

commit;
