-- Modelos de checklist por cliente e por projeto (além de produto e equipe).
--
-- A Nova tarefa já vem com o modelo marcado quando tudo o que ele pede bate
-- com a tarefa: o produto e o cliente do produto contratado, o projeto e a
-- equipe do responsável (ou a equipe que recebe). Sem nada preenchido, o
-- modelo continua só aplicado à mão. Um projeto é de um produto contratado:
-- com projeto, o cliente e o produto do modelo (quando escolhidos) precisam
-- ser os dele.
begin;

alter table public.checklist_templates
 add column client_id uuid,
 add column project_id uuid,
 add foreign key (company_id, client_id) references public.clients(company_id, id),
 add foreign key (project_id) references public.projects(id);

-- A da migração 20270220090000, com cliente e projeto no fim (os apps ainda
-- abertos com a versão anterior continuam salvando sem eles).
drop function public.save_checklist_template(uuid, uuid, text, jsonb, uuid, uuid, boolean);
create function public.save_checklist_template(p_company uuid, p_id uuid, p_name text, p_items jsonb,
 p_product uuid default null, p_team uuid default null, p_active boolean default true,
 p_client uuid default null, p_project uuid default null) returns uuid
language plpgsql security definer set search_path = '' as $$
declare result uuid; pc public.contracts; begin
 if not mavi_private.leader(p_company) then
  raise exception 'Somente administradores e gestores configuram modelos de checklist' using errcode = '42501';
 end if;
 if length(btrim(coalesce(p_name, ''))) not between 2 and 80 then
  raise exception 'Dê um nome ao modelo (de 2 a 80 caracteres).' using errcode = '22023';
 end if;
 if not mavi_private.checklist_items_valid(p_items) or jsonb_array_length(p_items) = 0 then
  raise exception 'Adicione ao menos um item (cada um com até 500 caracteres; no máximo 300).' using errcode = '22023';
 end if;
 if p_client is not null and not exists (select 1 from public.clients where company_id = p_company and id = p_client) then
  raise exception 'Cliente não encontrado' using errcode = '22023';
 end if;
 if p_project is not null then
  select c.* into pc from public.projects p join public.contracts c on c.company_id = p.company_id and c.id = p.contract_id
  where p.company_id = p_company and p.id = p_project;
  if not found then raise exception 'Projeto não encontrado' using errcode = '22023'; end if;
  if (p_client is not null and pc.client_id <> p_client) or (p_product is not null and pc.product_id <> p_product) then
   raise exception 'O projeto escolhido é de outro cliente ou produto.' using errcode = '22023';
  end if;
 end if;
 if p_id is null then
  insert into public.checklist_templates(company_id, name, items, product_id, team_id, client_id, project_id, active)
  values (p_company, btrim(p_name), p_items, p_product, p_team, p_client, p_project, coalesce(p_active, true))
  returning id into result;
 else
  update public.checklist_templates set name = btrim(p_name), items = p_items, product_id = p_product,
   team_id = p_team, client_id = p_client, project_id = p_project, active = coalesce(p_active, true),
   updated_at = now()
  where company_id = p_company and id = p_id returning id into result;
  if result is null then raise exception 'Modelo não encontrado'; end if;
 end if;
 return result;
end $$;
revoke all on function public.save_checklist_template(uuid, uuid, text, jsonb, uuid, uuid, boolean, uuid, uuid)
 from public, anon;
grant execute on function public.save_checklist_template(uuid, uuid, text, jsonb, uuid, uuid, boolean, uuid, uuid)
 to authenticated;

commit;
