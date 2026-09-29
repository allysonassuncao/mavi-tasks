begin;

-- Leaders remove a product from a client. Added by mistake (nothing points
-- at it yet), it is deleted for good. With history (projects, tasks, files,
-- campaigns, Social Leads, AI usage…), it is archived instead: it leaves the
-- client's active products and takes no new work, while that history stays.
-- Returns 'deleted' or 'archived'.
create function public.remove_contract(p_contract uuid) returns text
language plpgsql security definer set search_path = '' as $$
declare k public.contracts; begin
 select * into k from public.contracts where id = p_contract for update;
 if not found or not mavi_private.leader(k.company_id) then
  raise exception 'Sem permissão' using errcode = '42501';
 end if;
 -- AI usage keeps the product without a foreign key: it is history too.
 if not exists (select 1 from public.ai_usage where company_id = k.company_id and contract_id = k.id) then
  begin
   delete from public.contracts where id = k.id;
   return 'deleted';
  exception when foreign_key_violation then
   null; -- Something still points at it: archive below.
  end;
 end if;
 update public.contracts set archived = true where id = k.id;
 return 'archived';
end $$;
revoke all on function public.remove_contract(uuid) from public, anon;
grant execute on function public.remove_contract(uuid) to authenticated;

notify pgrst, 'reload schema';

commit;
