begin;

-- Antes da migração 20270408090000, toda varredura religava todos os grupos:
-- o cliente renomeado ou arquivado e o produto contratado, retirado ou
-- renomeado chegavam aos grupos na varredura seguinte. A varredura agora só
-- religa grupos novos ou com título mudado; para nada mudar nos outros
-- módulos (Radar, Termômetro, Drive), estes gatilhos religam na hora só os
-- grupos automáticos afetados. A religação do dia fica como rede de segurança.
-- Um erro aqui nunca impede salvar o cliente, o contrato ou o produto.

-- Os grupos pelo código do título (a religação acha os afetados sem ler todos).
create index whatsapp_groups_code on public.whatsapp_groups (company_id, (mavi_private.whatsapp_code(title)));

-- Religa os grupos automáticos da empresa com um destes códigos no título ou
-- ligados a um destes clientes. Devolve quantos mudaram.
create function mavi_private.whatsapp_rematch_some(c uuid, p_codes text[], p_clients uuid[]) returns integer
language plpgsql security definer set search_path = '' as $$
declare n integer := 0; begin
 if c is null or not exists (select 1 from mavi_private.whatsapp_config where company_id = c) then return 0; end if;
 with m as (
  select w.id, x.client_id, coalesce(x.product_ids, '{}') as product_ids
  from public.whatsapp_groups w cross join lateral mavi_private.whatsapp_match(c, w.title) x
  where w.company_id = c and w.linked_by = 'auto'
   and (mavi_private.whatsapp_code(w.title) = any(coalesce(p_codes, '{}'))
    or w.client_id = any(coalesce(p_clients, '{}')))
 )
 update public.whatsapp_groups w set client_id = m.client_id, product_ids = m.product_ids, updated_at = now()
 from m
 where w.id = m.id and (w.client_id is distinct from m.client_id or w.product_ids is distinct from m.product_ids);
 get diagnostics n = row_count;
 return n;
exception when others then
 raise warning 'whatsapp rematch failed: %', sqlerrm;
 return 0;
end $$;

-- Cliente novo, renomeado ou (des)arquivado: os grupos do código antigo e do novo.
create function mavi_private.whatsapp_rematch_client() returns trigger
language plpgsql security definer set search_path = '' as $$ begin
 perform mavi_private.whatsapp_rematch_some(new.company_id,
  array_remove(array[substring(new.name from '^\d+'),
   case when tg_op = 'UPDATE' then substring(old.name from '^\d+') end], null),
  case when tg_op = 'UPDATE' then array[new.id] else '{}' end);
 return null;
end $$;
create trigger whatsapp_rematch_client_ins after insert on public.clients
 for each row when (new.name ~ '^\d') execute function mavi_private.whatsapp_rematch_client();
create trigger whatsapp_rematch_client_upd after update of name, archived on public.clients
 for each row when (old.name is distinct from new.name or old.archived is distinct from new.archived)
 execute function mavi_private.whatsapp_rematch_client();

-- Produto contratado, retirado ou trocado: os grupos do cliente.
create function mavi_private.whatsapp_rematch_contract() returns trigger
language plpgsql security definer set search_path = '' as $$ begin
 if tg_op in ('UPDATE', 'DELETE') then
  perform mavi_private.whatsapp_rematch_some(old.company_id, '{}',
   array[old.client_id] || case when tg_op = 'UPDATE' then array[new.client_id] else '{}' end);
 else
  perform mavi_private.whatsapp_rematch_some(new.company_id, '{}', array[new.client_id]);
 end if;
 return null;
end $$;
create trigger whatsapp_rematch_contract_ins after insert on public.contracts
 for each row execute function mavi_private.whatsapp_rematch_contract();
create trigger whatsapp_rematch_contract_upd after update of client_id, product_id on public.contracts
 for each row when (old.client_id is distinct from new.client_id or old.product_id is distinct from new.product_id)
 execute function mavi_private.whatsapp_rematch_contract();
create trigger whatsapp_rematch_contract_del after delete on public.contracts
 for each row execute function mavi_private.whatsapp_rematch_contract();

-- Produto renomeado (o título cita o produto pelo nome): os grupos de quem o contrata.
create function mavi_private.whatsapp_rematch_product() returns trigger
language plpgsql security definer set search_path = '' as $$ begin
 perform mavi_private.whatsapp_rematch_some(new.company_id, '{}',
  array(select distinct ct.client_id from public.contracts ct
   where ct.company_id = new.company_id and ct.product_id = new.id));
 return null;
end $$;
create trigger whatsapp_rematch_product after update of name on public.products
 for each row when (old.name is distinct from new.name) execute function mavi_private.whatsapp_rematch_product();

revoke all on function mavi_private.whatsapp_rematch_some(uuid, text[], uuid[]),
 mavi_private.whatsapp_rematch_client(), mavi_private.whatsapp_rematch_contract(),
 mavi_private.whatsapp_rematch_product() from public, anon, authenticated;

commit;
