begin;

-- MAVI · arte por código, marca do cliente e esforço:
--
-- 1. Drive › cliente › "Marca": logos, fontes, cores e regras de uso de cada
--    cliente, num lugar só. Os arquivos ficam numa pasta de verdade do Drive
--    (drive_folders.system = 'brand', uma por cliente, escondida da lista de
--    pastas: a tela "Marca" mostra), e as cores, o papel de cada fonte e as
--    regras em client_brands. Quem atende o cliente (drive_can_read) edita: a
--    marca é trabalho do time, não só de gestores.
-- 2. A MAVI lê a marca (ai_brand_kit) para montar a arte e o servidor pega os
--    caminhos dos arquivos (brand_asset_targets) para assinar os links.
-- 3. "Quem usa qual modelo" ganha o esforço (quanto a IA raciocina) de cada
--    funcionalidade de conversa e de cada skill, escolhido por administradores
--    e gestores (ai_efforts). Sem escolha, o automático de sempre.

-- ------------------------------------------------------------ marca
alter table public.drive_folders add column system text check (system in ('brand'));
create unique index drive_folders_brand_key on public.drive_folders(company_id, client_id) where system = 'brand';

create table public.client_brands (
 company_id uuid not null references public.companies(id),
 client_id uuid not null,
 -- [{name, hex}]: as cores da marca, na ordem de importância.
 colors jsonb not null default '[]' check (jsonb_typeof(colors) = 'array' and jsonb_array_length(colors) <= 24),
 -- [{file, family, weight, style, role}]: cada arquivo de fonte e para que serve.
 fonts jsonb not null default '[]' check (jsonb_typeof(fonts) = 'array' and jsonb_array_length(fonts) <= 40),
 -- Regras de uso (tipografia, tom, o que não fazer).
 notes text not null default '' check (length(notes) <= 6000),
 updated_by uuid default auth.uid(),
 updated_at timestamptz not null default now(),
 primary key (company_id, client_id),
 foreign key (company_id, client_id) references public.clients(company_id, id) on delete cascade
);
alter table public.client_brands enable row level security;
create policy client_brands_read on public.client_brands for select to authenticated using (
 company_id in (select mavi_private.active_companies()) and mavi_private.drive_can_read(company_id, client_id));
grant select on public.client_brands to authenticated;

-- A pasta da marca do cliente (criada na primeira vez).
create function mavi_private.brand_folder(p_company uuid, p_client uuid) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v uuid; begin
 select id into v from public.drive_folders where company_id = p_company and client_id = p_client and system = 'brand';
 if v is not null then return v; end if;
 insert into public.drive_folders(company_id, client_id, contract_id, parent_id, name, created_by, system)
 values (p_company, p_client, null, null, 'Marca', auth.uid(), 'brand')
 on conflict (company_id, client_id) where system = 'brand' do nothing
 returning id into v;
 if v is null then
  select id into v from public.drive_folders where company_id = p_company and client_id = p_client and system = 'brand';
 else
  perform mavi_private.drive_log(p_company, 'folder_created', null, v, 'Marca', p_client, null);
 end if;
 return v;
end $$;
revoke all on function mavi_private.brand_folder(uuid, uuid) from public, anon, authenticated;

create function mavi_private.brand_can_edit(p_company uuid, p_client uuid) returns boolean
language sql stable security definer set search_path = '' as $$
 select mavi_private.member(p_company) and p_client is not null
  and exists (select 1 from public.clients c where c.company_id = p_company and c.id = p_client)
  and mavi_private.drive_can_read(p_company, p_client)
$$;
revoke all on function mavi_private.brand_can_edit(uuid, uuid) from public, anon;
grant execute on function mavi_private.brand_can_edit(uuid, uuid) to authenticated;

-- Um arquivo novo na marca (logo, fonte, imagem ou manual). Depois do envio,
-- confirm_drive_file (quem enviou) deixa pronto, como no resto do Drive.
create function public.prepare_brand_file(p_company uuid, p_client uuid, p_name text, p_size bigint,
 p_content_type text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_id uuid := gen_random_uuid(); v_folder uuid; v_name text := trim(coalesce(p_name, ''));
 v_type text := coalesce(nullif(trim(p_content_type), ''), 'application/octet-stream'); begin
 if not mavi_private.brand_can_edit(p_company, p_client) then
  raise exception 'Só quem atende este cliente edita a marca dele.' using errcode = '42501';
 end if;
 if length(v_name) not between 1 and 200 then raise exception 'Nome inválido.' using errcode = '22023'; end if;
 if lower(v_name) !~ '\.(png|jpe?g|webp|gif|svg|ttf|otf|woff2?|pdf)$' then
  raise exception 'Na marca vão imagens (PNG, JPG, WebP, SVG), fontes (TTF, OTF, WOFF) e PDF.' using errcode = '22023';
 end if;
 if p_size is null or p_size < 1 or p_size > 52428800 then
  raise exception 'Envie arquivos de até 50 MB.' using errcode = '22023';
 end if;
 v_folder := mavi_private.brand_folder(p_company, p_client);
 insert into public.drive_files(id, company_id, name, content_type, size_bytes, path, visibility, client_id, contract_id, folder_id)
 values (v_id, p_company, v_name, v_type, p_size, 'drive/' || p_company || '/' || v_id, 'private', p_client, null, v_folder);
 perform mavi_private.drive_log(p_company, 'upload_started', v_id, v_folder, v_name, p_client, null,
  jsonb_build_object('size_bytes', p_size, 'content_type', v_type, 'visibility', 'private', 'brand', true));
 return v_id;
end $$;
revoke all on function public.prepare_brand_file(uuid, uuid, text, bigint, text) from public, anon;
grant execute on function public.prepare_brand_file(uuid, uuid, text, bigint, text) to authenticated;

-- Tirar um arquivo da marca: quem atende o cliente (o arquivo no GCS o
-- servidor apaga com o caminho devolvido).
create function public.delete_brand_file(p_file uuid) returns text
language plpgsql security definer set search_path = '' as $$
declare f public.drive_files; begin
 select fi.* into f from public.drive_files fi
 join public.drive_folders fo on fo.company_id = fi.company_id and fo.id = fi.folder_id and fo.system = 'brand'
 where fi.id = p_file for update of fi;
 if not found or not mavi_private.brand_can_edit(f.company_id, f.client_id) then
  raise exception 'Arquivo não encontrado.' using errcode = 'P0002';
 end if;
 delete from public.drive_files where id = f.id;
 update public.client_brands set fonts = coalesce((select jsonb_agg(x) from jsonb_array_elements(fonts) x
  where x->>'file' is distinct from f.id::text), '[]'), updated_by = auth.uid(), updated_at = now()
 where company_id = f.company_id and client_id = f.client_id;
 perform mavi_private.drive_log(f.company_id, 'file_deleted', f.id, f.folder_id, f.name, f.client_id, null,
  jsonb_build_object('size_bytes', f.size_bytes, 'content_type', f.content_type, 'brand', true));
 return f.path;
end $$;
revoke all on function public.delete_brand_file(uuid) from public, anon;
grant execute on function public.delete_brand_file(uuid) to authenticated;

-- As cores, as fontes (família, peso, estilo e papel de cada arquivo) e as regras.
create function public.save_client_brand(p_company uuid, p_client uuid, p_colors jsonb, p_fonts jsonb, p_notes text)
returns void
language plpgsql security definer set search_path = '' as $$
declare v_folder uuid; v_colors jsonb; v_fonts jsonb; begin
 if not mavi_private.brand_can_edit(p_company, p_client) then
  raise exception 'Só quem atende este cliente edita a marca dele.' using errcode = '42501';
 end if;
 if jsonb_typeof(coalesce(p_colors, '[]')) <> 'array' or jsonb_typeof(coalesce(p_fonts, '[]')) <> 'array' then
  raise exception 'Formato inválido.' using errcode = '22023';
 end if;
 if exists (select 1 from jsonb_array_elements(coalesce(p_colors, '[]')) c
  where coalesce(c->>'hex', '') !~* '^#[0-9a-f]{6}$' or length(coalesce(c->>'name', '')) > 60) then
  raise exception 'Cada cor precisa de um código #RRGGBB (e um nome de até 60 letras).' using errcode = '22023';
 end if;
 v_colors := coalesce((select jsonb_agg(jsonb_build_object('name', trim(coalesce(c->>'name', '')), 'hex', upper(c->>'hex')))
  from jsonb_array_elements(coalesce(p_colors, '[]')) c), '[]');
 v_folder := mavi_private.brand_folder(p_company, p_client);
 -- Só as fontes que estão na pasta da marca deste cliente.
 if exists (select 1 from jsonb_array_elements(coalesce(p_fonts, '[]')) x
  where not exists (select 1 from public.drive_files f where f.company_id = p_company and f.folder_id = v_folder
   and f.id::text = x->>'file')
   or length(trim(coalesce(x->>'family', ''))) not between 1 and 80
   or coalesce(x->>'weight', '400') !~ '^[1-9]00$'
   or coalesce(x->>'style', 'normal') not in ('normal', 'italic')
   or length(coalesce(x->>'role', '')) > 80) then
  raise exception 'Confira as fontes: arquivo da marca, família (até 80 letras), peso de 100 a 900 e estilo normal ou itálico.' using errcode = '22023';
 end if;
 v_fonts := coalesce((select jsonb_agg(jsonb_build_object('file', x->>'file', 'family', trim(x->>'family'),
   'weight', coalesce(x->>'weight', '400')::integer, 'style', coalesce(x->>'style', 'normal'),
   'role', trim(coalesce(x->>'role', ''))))
  from jsonb_array_elements(coalesce(p_fonts, '[]')) x), '[]');
 insert into public.client_brands(company_id, client_id, colors, fonts, notes, updated_by, updated_at)
 values (p_company, p_client, v_colors, v_fonts, left(coalesce(p_notes, ''), 6000), auth.uid(), now())
 on conflict (company_id, client_id) do update set colors = excluded.colors, fonts = excluded.fonts,
  notes = excluded.notes, updated_by = auth.uid(), updated_at = now();
 perform mavi_private.drive_log(p_company, 'brand_updated', null, v_folder, 'Marca', p_client, null,
  jsonb_build_object('colors', jsonb_array_length(v_colors), 'fonts', jsonb_array_length(v_fonts)));
end $$;
revoke all on function public.save_client_brand(uuid, uuid, jsonb, jsonb, text) from public, anon;
grant execute on function public.save_client_brand(uuid, uuid, jsonb, jsonb, text) to authenticated;

-- A marca inteira (para a tela e para a MAVI): cores, fontes, regras e os
-- arquivos da pasta. Sem acesso ao cliente, nada.
create function public.ai_brand_kit(p_company uuid, p_client uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_folder uuid; b public.client_brands; begin
 if not mavi_private.brand_can_edit(p_company, p_client) then return null; end if;
 select id into v_folder from public.drive_folders where company_id = p_company and client_id = p_client and system = 'brand';
 select * into b from public.client_brands where company_id = p_company and client_id = p_client;
 return jsonb_build_object(
  'client', p_client,
  'client_name', (select name from public.clients where company_id = p_company and id = p_client),
  'folder', v_folder,
  'colors', coalesce(b.colors, '[]'),
  'fonts', coalesce(b.fonts, '[]'),
  'notes', coalesce(b.notes, ''),
  'updated_at', b.updated_at,
  'files', coalesce((select jsonb_agg(jsonb_build_object('id', f.id, 'name', f.name, 'content_type', f.content_type,
    'size', f.size_bytes, 'created_at', f.created_at) order by f.created_at)
   from public.drive_files f where f.company_id = p_company and f.folder_id = v_folder and f.status = 'ready'), '[]'));
end $$;
revoke all on function public.ai_brand_kit(uuid, uuid) from public, anon;
grant execute on function public.ai_brand_kit(uuid, uuid) to authenticated;

-- Onde estão os arquivos da marca (só o servidor usa, para assinar os links).
create function public.brand_asset_targets(p_company uuid, p_client uuid)
returns table(id uuid, name text, content_type text, path text, size bigint)
language plpgsql stable security definer set search_path = '' as $$
#variable_conflict use_column
begin
 if not mavi_private.brand_can_edit(p_company, p_client) then return; end if;
 return query select f.id, f.name, f.content_type, f.path, f.size_bytes
 from public.drive_files f join public.drive_folders fo on fo.company_id = f.company_id and fo.id = f.folder_id
 where f.company_id = p_company and fo.client_id = p_client and fo.system = 'brand' and f.status = 'ready'
 order by f.created_at limit 60;
end $$;
revoke all on function public.brand_asset_targets(uuid, uuid) from public, anon;
grant execute on function public.brand_asset_targets(uuid, uuid) to authenticated;

-- A pasta da marca não se renomeia nem se apaga pelas telas de pasta.
create function mavi_private.drive_folder_system_guard() returns trigger
language plpgsql set search_path = '' as $$ begin
 if old.system is not null and (tg_op = 'DELETE' or new.name is distinct from old.name
  or new.parent_id is distinct from old.parent_id or new.system is distinct from old.system) then
  raise exception 'A pasta da marca é do sistema: edite em Drive › cliente › Marca.' using errcode = '42501';
 end if;
 return case when tg_op = 'DELETE' then old else new end;
end $$;
create trigger drive_folder_system_guard before update or delete on public.drive_folders
 for each row execute function mavi_private.drive_folder_system_guard();

-- ------------------------------------------------------------ esforço
create table mavi_private.ai_efforts (
 company_id uuid not null references public.companies(id),
 -- A funcionalidade (ex.: 'mavi_page') ou 'skill:<id da skill>'.
 key text not null,
 effort text not null check (effort in ('low', 'medium', 'high', 'xhigh', 'max')),
 updated_by uuid default auth.uid(),
 updated_at timestamptz not null default now(),
 primary key (company_id, key)
);
alter table mavi_private.ai_efforts enable row level security;

create function public.ai_set_effort(p_company uuid, p_key text, p_effort text) returns void
language plpgsql security definer set search_path = '' as $$
declare v_skill uuid; begin
 if not mavi_private.leader(p_company) then
  raise exception 'Só administradores e gestores escolhem o esforço da MAVI.' using errcode = '42501';
 end if;
 if p_key ~ '^skill:[0-9a-f-]{36}$' then
  v_skill := substr(p_key, 7)::uuid;
  if not exists (select 1 from public.ai_skills where company_id = p_company and id = v_skill) then
   raise exception 'Skill não encontrada.' using errcode = 'P0002';
  end if;
 elsif coalesce(p_key, '') not in ('assistant', 'mavi_page', 'meetings_history', 'canvas_writer', 'web_search') then
  raise exception 'Esta funcionalidade não tem esforço para escolher.' using errcode = '22023';
 end if;
 if p_effort is null then
  delete from mavi_private.ai_efforts where company_id = p_company and key = p_key;
  return;
 end if;
 if p_effort not in ('low', 'medium', 'high', 'xhigh', 'max') then
  raise exception 'Esforço inválido.' using errcode = '22023';
 end if;
 insert into mavi_private.ai_efforts(company_id, key, effort) values (p_company, p_key, p_effort)
 on conflict (company_id, key) do update set effort = excluded.effort, updated_by = auth.uid(), updated_at = now();
end $$;
revoke all on function public.ai_set_effort(uuid, text, text) from public, anon;
grant execute on function public.ai_set_effort(uuid, text, text) to authenticated;

-- Os esforços da empresa ({chave: esforço}), para o servidor da MAVI.
create function public.ai_efforts(p_company uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$ begin
 if not mavi_private.member(p_company) then raise exception 'Sem acesso ao espaço' using errcode = '42501'; end if;
 return coalesce((select jsonb_object_agg(key, effort) from mavi_private.ai_efforts where company_id = p_company), '{}');
end $$;
revoke all on function public.ai_efforts(uuid) from public, anon;
grant execute on function public.ai_efforts(uuid) to authenticated;

-- Apagar a skill apaga o esforço dela.
create function mavi_private.ai_skill_forget_effort() returns trigger
language plpgsql security definer set search_path = '' as $$ begin
 delete from mavi_private.ai_efforts where company_id = old.company_id and key = 'skill:' || old.id;
 return old;
end $$;
revoke all on function mavi_private.ai_skill_forget_effort() from public, anon, authenticated;
create trigger ai_skill_forget_effort after delete on public.ai_skills
 for each row execute function mavi_private.ai_skill_forget_effort();

-- A biblioteca (a da migração 20261204150000) com os esforços.
create or replace function public.ai_provider_list(p_company uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$ begin
 if not mavi_private.leader(p_company) then
  raise exception 'Só administradores e gestores veem os provedores da MAVI.' using errcode = '42501';
 end if;
 return jsonb_build_object(
  'providers', (select coalesce(jsonb_agg(jsonb_build_object('id', p.id, 'name', p.name, 'kind', p.kind,
     'base_url', p.base_url, 'key_hint', p.key_hint, 'models', p.models, 'active', p.active,
     'updated_at', p.updated_at, 'routes', (select count(*) from mavi_private.ai_routes r where r.provider_id = p.id))
    order by p.name), '[]') from mavi_private.ai_providers p where p.company_id = p_company),
  'routes', (select coalesce(jsonb_agg(jsonb_build_object('id', r.id, 'type', r.scope_type, 'scope_id', r.scope_id,
     'feature', r.feature, 'provider_id', r.provider_id, 'model', r.model, 'updated_at', r.updated_at)
    order by r.scope_type, r.updated_at), '[]') from mavi_private.ai_routes r where r.company_id = p_company),
  'efforts', (select coalesce(jsonb_object_agg(e.key, e.effort), '{}') from mavi_private.ai_efforts e
   where e.company_id = p_company));
end $$;

commit;
