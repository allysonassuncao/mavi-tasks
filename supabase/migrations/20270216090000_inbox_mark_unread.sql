begin;

-- "Marcar como não lida" in the Caixa de entrada (top bar panel and page):
-- the given notifications of the person go back to unread. Counterpart of
-- read_notifications; only the person's own, in the company.
create function public.unread_notifications(p_company uuid, p_ids uuid[]) returns integer
language plpgsql security definer set search_path = '' as $$ declare changed integer; begin
 update public.notifications set read_at = null
 where company_id = p_company and user_id = auth.uid() and read_at is not null
  and id = any(coalesce(p_ids, '{}'));
 get diagnostics changed = row_count;
 return changed;
end $$;
revoke all on function public.unread_notifications(uuid, uuid[]) from public, anon;
grant execute on function public.unread_notifications(uuid, uuid[]) to authenticated;

commit;
