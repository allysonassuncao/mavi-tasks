begin;

-- Mover arquivos e pastas no Drive, inclusive para outro cliente.
--
-- * Quem move: quem pode editar na origem e no destino (drive_can_write nos
--   dois lugares — a mesma regra de renomear e de criar).
-- * Uma pasta leva tudo o que tem dentro: subpastas e arquivos passam a ser
--   do cliente/produto do destino. O caminho no GCS não muda (é pelo id).
-- * A MAVI: os documentos e trechos dos arquivos movidos trocam de cliente
--   na hora (a MAVI do cliente antigo deixa de achá-los já) e todos voltam
--   para a fila, que reescreve o cabeçalho (cliente, produto, pasta).
-- * Links: entrar numa pasta com link público ou compartilhada com pessoas
--   expõe o item; sair dela tira o acesso. A prévia avisa antes. Uma pasta
--   compartilhada que vai para fora de um produto tem o compartilhamento
--   desligado (só pastas de produto podem ser compartilhadas).
-- * Não se movem: a pasta da marca (nem os arquivos dela, nem nada para
--   dentro dela) e a pasta da prova social do Social Leads para outro
--   produto. As pastas virtuais não são linhas de drive_folders.
-- * Histórico: file_moved / folder_moved em drive_audit, com origem e
--   destino (ids e o caminho legível da época).

-- O caminho legível de um lugar: Drive › Cliente › Produto › Pasta › …
create function mavi_private.drive_place_label(c uuid, p_client uuid, p_contract uuid, p_folder uuid) returns text
language sql stable security definer set search_path = '' as $$
 select concat_ws(' › ', 'Drive',
  (select k.name from public.clients k where k.company_id = c and k.id = p_client),
  (select coalesce(nullif(p.name, ''), k.name) from public.contracts k
    left join public.products p on p.company_id = k.company_id and p.id = k.product_id
    where k.company_id = c and k.id = p_contract),
  (with recursive chain(id, parent_id, name, depth) as (
    select d.id, d.parent_id, d.name, 0 from public.drive_folders d where d.company_id = c and d.id = p_folder
    union all
    select d.id, d.parent_id, d.name, ch.depth + 1 from public.drive_folders d
     join chain ch on d.company_id = c and d.id = ch.parent_id
    where ch.depth < 50)
   select string_agg(name, ' › ' order by depth desc) from chain))
$$;

-- As pastas e tudo o que está abaixo delas.
create function mavi_private.drive_folder_subtree(c uuid, p_folders uuid[]) returns setof uuid
language sql stable security definer set search_path = '' as $$
 with recursive tree(id, depth) as (
  select f.id, 0 from public.drive_folders f where f.company_id = c and f.id = any(p_folders)
  union all
  select f.id, t.depth + 1 from public.drive_folders f join tree t on f.company_id = c and f.parent_id = t.id
  where t.depth < 50)
 select distinct id from tree
$$;
revoke all on function mavi_private.drive_place_label(uuid, uuid, uuid, uuid),
 mavi_private.drive_folder_subtree(uuid, uuid[]) from public, anon, authenticated;

-- Confere e (com p_apply) faz a movimentação. Devolve o que acontece:
-- quantos itens, se troca de cliente, os links em que entra e de que sai,
-- e as pastas que perdem o compartilhamento.
create function mavi_private.drive_move(p_company uuid, p_files uuid[], p_folders uuid[],
 p_client uuid, p_contract uuid, p_folder uuid, p_apply boolean) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare loc record; target public.drive_folders; f record; v_folders uuid[]; v_files uuid[];
 tree uuid[]; inner_files uuid[]; all_files uuid[]; to_place jsonb; to_label text; n integer;
 enter_public text[]; enter_people text[]; leave_public text[]; leave_people text[]; unshare text[];
 from_clients uuid[]; v_name text; removed_members jsonb; begin
 if not mavi_private.member(p_company) then raise exception 'Sem acesso ao espaço' using errcode = '42501'; end if;
 p_files := coalesce(p_files, '{}'); p_folders := coalesce(p_folders, '{}');
 if cardinality(p_files) + cardinality(p_folders) = 0 then
  raise exception 'Escolha o que mover.' using errcode = '22023';
 end if;
 if cardinality(p_files) + cardinality(p_folders) > 500 then
  raise exception 'Mova até 500 itens de cada vez.' using errcode = '22023';
 end if;

 -- O destino.
 select * into loc from mavi_private.drive_location(p_company, p_client, p_contract, p_folder);
 if p_folder is not null then
  select * into target from public.drive_folders where company_id = p_company and id = p_folder;
  if target.system is not null then
   raise exception 'A pasta da marca recebe arquivos pela tela Drive › cliente › Marca.' using errcode = '42501';
  end if;
 end if;
 if not mavi_private.drive_can_write(p_company, loc.client_id, loc.contract_id) then
  raise exception 'Você não pode colocar itens neste lugar. Fora das pastas de produto, só administradores e gestores fazem alterações.'
   using errcode = '42501';
 end if;

 -- As pastas: existem, não são do sistema, a pessoa edita onde estão, e
 -- nenhuma vai para dentro dela mesma.
 for f in select * from public.drive_folders where company_id = p_company and id = any(p_folders)
  order by id for update loop
  if f.system is not null then
   raise exception 'A pasta da marca é do sistema e não sai do lugar.' using errcode = '42501';
  end if;
  if not mavi_private.drive_can_write(p_company, f.client_id, f.contract_id) then
   raise exception 'Sem permissão para mover a pasta "%".', f.name using errcode = '42501';
  end if;
 end loop;
 if (select count(*) from public.drive_folders where company_id = p_company and id = any(p_folders))
  <> (select count(distinct x) from unnest(p_folders) x) then
  raise exception 'Pasta não encontrada' using errcode = 'P0002';
 end if;
 if p_folder is not null then
  select d.name into v_name from public.drive_folders d
  where d.company_id = p_company and d.id = any(p_folders)
   and d.id in (select mavi_private.drive_folder_chain(p_company, p_folder)) limit 1;
  if found then
   raise exception 'Não dá para mover a pasta "%" para dentro dela mesma.', v_name using errcode = '22023';
  end if;
 end if;
 -- Uma pasta escolhida junto com outra que a contém vai junto com a de fora;
 -- as que já estão no destino ficam como estão.
 select coalesce(array_agg(d.id), '{}') into v_folders from public.drive_folders d
 where d.company_id = p_company and d.id = any(p_folders)
  and not exists (select 1 from mavi_private.drive_folder_chain(p_company, d.parent_id) a where a = any(p_folders))
  and (d.parent_id, d.client_id, d.contract_id) is distinct from (p_folder, loc.client_id, loc.contract_id);
 select coalesce(array_agg(x), '{}') into tree from mavi_private.drive_folder_subtree(p_company, v_folders) x;

 -- Os arquivos.
 for f in select * from public.drive_files where company_id = p_company and id = any(p_files)
  order by id for update loop
  if f.status <> 'ready' then raise exception 'Arquivo não encontrado' using errcode = 'P0002'; end if;
  if not mavi_private.drive_can_write(p_company, f.client_id, f.contract_id) then
   raise exception 'Sem permissão para mover "%".', f.name using errcode = '42501';
  end if;
  if exists (select 1 from public.drive_folders d where d.company_id = p_company and d.id = f.folder_id
   and d.system is not null) then
   raise exception 'Os arquivos da marca são movidos pela tela Drive › cliente › Marca.' using errcode = '42501';
  end if;
 end loop;
 if (select count(*) from public.drive_files where company_id = p_company and id = any(p_files))
  <> (select count(distinct x) from unnest(p_files) x) then
  raise exception 'Arquivo não encontrado' using errcode = 'P0002';
 end if;
 select coalesce(array_agg(d.id), '{}') into v_files from public.drive_files d
 where d.company_id = p_company and d.id = any(p_files)
  and not (d.folder_id is not null and d.folder_id = any(tree))
  and not exists (select 1 from mavi_private.drive_folder_chain(p_company, d.folder_id) a where a = any(p_folders))
  and (d.folder_id, d.client_id, d.contract_id) is distinct from (p_folder, loc.client_id, loc.contract_id);
 if cardinality(v_files) + cardinality(v_folders) = 0 then
  raise exception 'Já está neste lugar.' using errcode = '22023';
 end if;
 select coalesce(array_agg(d.id), '{}') into inner_files from public.drive_files d
 where d.company_id = p_company and d.folder_id = any(tree);
 all_files := v_files || inner_files;

 -- A prova social do Social Leads fica no produto do briefing.
 select d.name into v_name from public.social_leads_briefings b
  join public.drive_folders d on d.id = b.proof_folder
 where b.company_id = p_company and b.proof_folder = any(tree) and b.contract_id is distinct from loc.contract_id
 limit 1;
 if found then
  raise exception 'A pasta "%" recebe a prova social do Social Leads deste produto. Para levá-la a outro produto, troque a pasta no briefing antes.', v_name
   using errcode = '42501';
 end if;

 -- Os links: em que o destino está, de que os itens saem, o que desliga.
 select coalesce(array_agg(d.name) filter (where d.visibility = 'public'), '{}'),
  coalesce(array_agg(d.name) filter (where exists (select 1 from public.drive_folder_members m where m.folder_id = d.id)), '{}')
 into enter_public, enter_people
 from public.drive_folders d where d.company_id = p_company and p_folder is not null
  and d.id in (select mavi_private.drive_folder_chain(p_company, p_folder));
 with sources as (
  select distinct a from public.drive_files x, mavi_private.drive_folder_chain(p_company, x.folder_id) a
  where x.company_id = p_company and x.id = any(v_files)
  union
  select distinct a from public.drive_folders x, mavi_private.drive_folder_chain(p_company, x.parent_id) a
  where x.company_id = p_company and x.id = any(v_folders)),
 left_behind as (
  select d.* from public.drive_folders d join sources s on s.a = d.id
  where p_folder is null or d.id not in (select mavi_private.drive_folder_chain(p_company, p_folder)))
 select coalesce(array_agg(name) filter (where visibility = 'public'), '{}'),
  coalesce(array_agg(name) filter (where exists (select 1 from public.drive_folder_members m where m.folder_id = left_behind.id)), '{}')
 into leave_public, leave_people from left_behind;
 select coalesce(array_agg(d.name order by d.name), '{}') into unshare from public.drive_folders d
 where loc.contract_id is null and d.company_id = p_company and d.id = any(tree)
  and (d.visibility = 'public' or d.public_upload
   or exists (select 1 from public.drive_folder_members m where m.folder_id = d.id));
 select coalesce(array_agg(distinct x.client_id) filter (where x.client_id is distinct from loc.client_id), '{}')
 into from_clients from (
  select client_id from public.drive_files where company_id = p_company and id = any(v_files)
  union all select client_id from public.drive_folders where company_id = p_company and id = any(v_folders)) x;
 to_label := mavi_private.drive_place_label(p_company, loc.client_id, loc.contract_id, p_folder);
 to_place := jsonb_build_object('client_id', loc.client_id, 'contract_id', loc.contract_id,
  'folder_id', p_folder, 'label', to_label);

 if p_apply then
  -- O histórico primeiro: o caminho de origem ainda é o de antes.
  insert into public.drive_audit(company_id, actor_id, action, file_id, folder_id, item_name, client_id, contract_id, details)
  select p_company, auth.uid(), 'file_moved', d.id, p_folder, d.name, loc.client_id, loc.contract_id,
   jsonb_build_object('from', jsonb_build_object('client_id', d.client_id, 'contract_id', d.contract_id,
     'folder_id', d.folder_id, 'label', mavi_private.drive_place_label(p_company, d.client_id, d.contract_id, d.folder_id)),
    'to', to_place, 'origin', coalesce(mavi_private.request_client(), '{}'))
  from public.drive_files d where d.company_id = p_company and d.id = any(v_files);
  insert into public.drive_audit(company_id, actor_id, action, file_id, folder_id, item_name, client_id, contract_id, details)
  select p_company, auth.uid(), 'folder_moved', null, d.id, d.name, loc.client_id, loc.contract_id,
   jsonb_build_object('from', jsonb_build_object('client_id', d.client_id, 'contract_id', d.contract_id,
     'folder_id', d.parent_id, 'label', mavi_private.drive_place_label(p_company, d.client_id, d.contract_id, d.parent_id)),
    'to', to_place,
    'folders', (select count(*) - 1 from mavi_private.drive_folder_subtree(p_company, array[d.id])),
    'files', (select count(*) from public.drive_files x where x.company_id = p_company
     and x.folder_id in (select mavi_private.drive_folder_subtree(p_company, array[d.id]))),
    'origin', coalesce(mavi_private.request_client(), '{}'))
  from public.drive_folders d where d.company_id = p_company and d.id = any(v_folders);

  update public.drive_folders set client_id = loc.client_id, contract_id = loc.contract_id,
   parent_id = case when id = any(v_folders) then p_folder else parent_id end
  where company_id = p_company and id = any(tree);
  -- Um só update: o gatilho da MAVI enfileira tudo de uma vez.
  update public.drive_files set client_id = loc.client_id, contract_id = loc.contract_id,
   folder_id = case when id = any(v_files) then p_folder else folder_id end
  where company_id = p_company and id = any(all_files);

  -- Fora de um produto não há compartilhamento: desliga e registra.
  if cardinality(unshare) > 0 then
   for f in select * from public.drive_folders d where d.company_id = p_company and d.id = any(tree)
    and (d.visibility = 'public' or d.public_upload
     or exists (select 1 from public.drive_folder_members m where m.folder_id = d.id)) loop
    with gone as (delete from public.drive_folder_members where folder_id = f.id returning user_id)
    select coalesce(jsonb_agg(user_id), '[]') into removed_members from gone;
    update public.drive_folders set visibility = 'private', public_upload = false,
     share_token = replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '')
    where id = f.id;
    perform mavi_private.drive_log(p_company, 'folder_shared', null, f.id, f.name, loc.client_id, loc.contract_id,
     jsonb_build_object('visibility', 'private', 'via', 'move', 'added', '[]'::jsonb, 'removed', removed_members));
   end loop;
  end if;

  -- A MAVI: o cliente muda já nos documentos e trechos (a busca filtra por
  -- eles), e a fila reescreve o cabeçalho com o caminho novo.
  update public.ai_documents set client_id = loc.client_id, contract_id = loc.contract_id
  where company_id = p_company and source_type = 'drive_file' and source_id = any(all_files)
   and (client_id, contract_id) is distinct from (loc.client_id, loc.contract_id);
  update public.ai_chunks c set client_id = loc.client_id, contract_id = loc.contract_id
  from public.ai_documents d
  where d.company_id = p_company and d.source_type = 'drive_file' and d.source_id = any(all_files)
   and c.company_id = d.company_id and c.document_id = d.id
   and (c.client_id, c.contract_id) is distinct from (loc.client_id, loc.contract_id);
  perform mavi_private.ai_enqueue('drive_file', (select jsonb_agg(jsonb_build_object('id', x, 'company_id', p_company))
   from unnest(all_files) x));
 end if;

 return jsonb_build_object(
  'files', cardinality(v_files), 'folders', cardinality(v_folders),
  'inner_files', cardinality(inner_files), 'inner_folders', cardinality(tree) - cardinality(v_folders),
  'from_clients', to_jsonb(from_clients), 'to', to_place,
  'enter_public', to_jsonb(enter_public), 'enter_people', to_jsonb(enter_people),
  'leave_public', to_jsonb(leave_public), 'leave_people', to_jsonb(leave_people),
  'unshare', to_jsonb(unshare));
end $$;
revoke all on function mavi_private.drive_move(uuid, uuid[], uuid[], uuid, uuid, uuid, boolean)
 from public, anon, authenticated;

-- O que a tela pergunta antes de confirmar (não muda nada).
create function public.drive_move_preview(p_company uuid, p_files uuid[], p_folders uuid[],
 p_client uuid default null, p_contract uuid default null, p_folder uuid default null) returns jsonb
language sql security definer set search_path = '' as $$
 select mavi_private.drive_move(p_company, p_files, p_folders, p_client, p_contract, p_folder, false)
$$;
create function public.move_drive_items(p_company uuid, p_files uuid[], p_folders uuid[],
 p_client uuid default null, p_contract uuid default null, p_folder uuid default null) returns jsonb
language sql security definer set search_path = '' as $$
 select mavi_private.drive_move(p_company, p_files, p_folders, p_client, p_contract, p_folder, true)
$$;
revoke all on function public.drive_move_preview(uuid, uuid[], uuid[], uuid, uuid, uuid),
 public.move_drive_items(uuid, uuid[], uuid[], uuid, uuid, uuid) from public, anon;
grant execute on function public.drive_move_preview(uuid, uuid[], uuid[], uuid, uuid, uuid),
 public.move_drive_items(uuid, uuid[], uuid[], uuid, uuid, uuid) to authenticated;

-- O histórico de um arquivo ou pasta, para quem o vê: de onde veio, por
-- onde passou, nomes e compartilhamento. Inclui as mudanças das pastas em
-- que ele está (mover a pasta leva o arquivo junto). Sem visualizações,
-- downloads nem IP: isso fica na aba Histórico, dos líderes.
create function public.drive_item_history(p_company uuid, p_file uuid default null, p_folder uuid default null)
 returns table(id bigint, actor_id uuid, action text, item_name text, client_id uuid, contract_id uuid,
  details jsonb, created_at timestamptz, via_folder boolean)
language plpgsql stable security definer set search_path = '' as $$
declare v_parent uuid; v_since timestamptz; begin
 if (p_file is null) = (p_folder is null) then raise exception 'Escolha um arquivo ou uma pasta.' using errcode = '22023'; end if;
 if p_file is not null then
  select x.folder_id, x.created_at into v_parent, v_since from public.drive_files x
  where x.company_id = p_company and x.id = p_file and x.status = 'ready'
   and (mavi_private.drive_can_read(x.company_id, x.client_id) or mavi_private.drive_folder_shared(x.company_id, x.folder_id));
 else
  select x.parent_id, x.created_at into v_parent, v_since from public.drive_folders x
  where x.company_id = p_company and x.id = p_folder and x.system is null
   and (mavi_private.drive_can_read(x.company_id, x.client_id) or mavi_private.drive_folder_shared(x.company_id, x.id));
 end if;
 if not found then raise exception 'Item não encontrado ou sem acesso.' using errcode = '42501'; end if;
 return query
 select a.id, a.actor_id, a.action, a.item_name, a.client_id, a.contract_id, a.details - 'origin', a.created_at, false
 from public.drive_audit a
 where a.company_id = p_company
  and (case when p_file is not null then a.file_id = p_file else a.folder_id = p_folder and a.file_id is null end)
  and a.action in ('upload_completed', 'public_upload_completed', 'file_renamed', 'file_moved', 'visibility_changed',
   'folder_created', 'folder_renamed', 'folder_moved', 'folder_shared')
 union all
 select a.id, a.actor_id, a.action, a.item_name, a.client_id, a.contract_id, a.details - 'origin', a.created_at, true
 from public.drive_audit a
 where a.company_id = p_company and a.action = 'folder_moved' and a.created_at >= v_since
  and a.folder_id in (select mavi_private.drive_folder_chain(p_company, v_parent))
 order by 8 desc, 1 desc
 limit 200;
end $$;
revoke all on function public.drive_item_history(uuid, uuid, uuid) from public, anon;
grant execute on function public.drive_item_history(uuid, uuid, uuid) to authenticated;

commit;
