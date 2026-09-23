begin;

-- Collaborators now browse Clients and Projects. clients_read only showed a
-- client when the person already had a task in it, so a client served by the
-- person's team stayed invisible until its first task. Rely on contracts_read
-- instead (team contracts or own tasks; RLS applies inside this subquery).
alter policy clients_read on public.clients using (
  mavi_private.leader(company_id) or exists(
    select 1 from public.contracts k
    where k.company_id = clients.company_id and k.client_id = clients.id
  )
);

commit;
