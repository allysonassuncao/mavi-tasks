begin;

-- Tutoriais: a base de guias de uso do sistema, por empresa. Administradores
-- e gestores escrevem (texto com seções, imagens e vídeos); cada tutorial tem
-- o seu público e fica ligado aos módulos de que fala (o botão "?" de cada
-- tela abre os daquele módulo).
--
-- - Quem escreve: administradores e gestores criam. Administradores editam
--   todos; gestores, só os que criaram. Colaboradores só leem.
-- - Público: todos (padrão) ou a soma de papéis, equipes e pessoas, menos as
--   excluídas. Quem edita sempre vê. Recalculado a cada leitura: quem entra
--   numa equipe passa a ver na hora.
-- - Rascunho → publicado: um tutorial nasce rascunho e só aparece depois de
--   publicado. Num publicado, "Salvar rascunho" guarda a alteração à parte
--   (tutorial_drafts) e a versão no ar continua até publicar de novo. Cada
--   publicação vira uma versão (tutorial_versions) que pode ser restaurada.
-- - Vídeos enviados ficam no GCS (bucket do Drive, privado; links assinados
--   em api/_tutorials.ts); os de YouTube, Loom e Vimeo entram no texto só
--   pelo provedor e o id (o navegador monta o endereço). As mídias ficam até
--   o tutorial ser apagado, porque as versões antigas podem usá-las.
-- - Tudo passa por funções: as tabelas não têm leitura direta.
-- - Fases seguintes: busca com a MAVI e o cérebro dela (trechos por seção),
--   trilhas, "Isso ajudou?" e avisos de tutorial novo.

-- ------------------------------------------------------------ tabelas
create table public.tutorials (
 id uuid primary key default gen_random_uuid(),
 company_id uuid not null references public.companies(id),
 title text not null check (length(btrim(title)) between 3 and 160),
 summary text not null default '' check (length(summary) <= 600),
 -- Texto rico (mavi:richtext:v1:…), com seções, imagens e vídeos.
 body text not null default '' check (length(body) <= 600000),
 -- Os módulos de que fala (ids do app: tasks, campaigns, drive…).
 modules text[] not null default '{}',
 category text not null default '' check (length(category) <= 60),
 tags text[] not null default '{}',
 aud_all boolean not null default true,
 aud_roles text[] not null default '{}' check (aud_roles <@ array['admin', 'manager', 'member']::text[]),
 aud_teams uuid[] not null default '{}',
 aud_users uuid[] not null default '{}',
 aud_exclude uuid[] not null default '{}',
 status text not null default 'draft' check (status in ('draft', 'published')),
 -- A versão publicada (0: nunca publicado).
 version integer not null default 0,
 -- Cada salvamento: quem salva com uma revisão velha é avisado.
 revision integer not null default 1,
 published_at timestamptz,
 published_by uuid,
 created_by uuid not null,
 created_at timestamptz not null default now(),
 updated_by uuid not null,
 updated_at timestamptz not null default now(),
 -- Texto da busca, sem acentos (título, resumo, texto, categoria, tags).
 search text not null default '',
 unique(company_id, id),
 foreign key(company_id, created_by) references public.memberships(company_id, user_id)
);
create index tutorials_list on public.tutorials(company_id, status, published_at desc);
create index tutorials_modules on public.tutorials using gin(modules);
alter table public.tutorials enable row level security;
revoke all on public.tutorials from public, anon, authenticated;

-- A alteração de um tutorial publicado que ainda não foi ao ar.
create table public.tutorial_drafts (
 tutorial_id uuid primary key,
 company_id uuid not null,
 content jsonb not null check (jsonb_typeof(content) = 'object'),
 saved_by uuid not null,
 saved_at timestamptz not null default now(),
 foreign key(company_id, tutorial_id) references public.tutorials(company_id, id) on delete cascade
);
alter table public.tutorial_drafts enable row level security;
revoke all on public.tutorial_drafts from public, anon, authenticated;

create table public.tutorial_versions (
 company_id uuid not null,
 tutorial_id uuid not null,
 version integer not null check (version > 0),
 content jsonb not null check (jsonb_typeof(content) = 'object'),
 published_by uuid not null,
 published_at timestamptz not null default now(),
 -- Restaurar publica uma versão nova com o conteúdo de uma antiga.
 restored_from integer,
 primary key(tutorial_id, version),
 foreign key(company_id, tutorial_id) references public.tutorials(company_id, id) on delete cascade
);
alter table public.tutorial_versions enable row level security;
revoke all on public.tutorial_versions from public, anon, authenticated;

create table public.tutorial_media (
 id uuid primary key default gen_random_uuid(),
 company_id uuid not null,
 tutorial_id uuid not null,
 name text not null check (length(btrim(name)) between 1 and 255),
 content_type text not null check (content_type like 'video/%' and length(content_type) <= 200),
 size_bytes bigint not null check (size_bytes between 1 and 524288000),
 path text not null unique,
 status text not null default 'uploading' check (status in ('uploading', 'ready')),
 created_by uuid not null,
 created_at timestamptz not null default now(),
 unique(company_id, id),
 foreign key(company_id, tutorial_id) references public.tutorials(company_id, id) on delete cascade
);
create index tutorial_media_tutorial on public.tutorial_media(company_id, tutorial_id);
alter table public.tutorial_media enable row level security;
revoke all on public.tutorial_media from public, anon, authenticated;

-- ------------------------------------------------------------ regras
-- Edita (publica, apaga, envia vídeos): administradores, ou o gestor que criou.
create function mavi_private.tutorial_can_edit(t public.tutorials) returns boolean
language sql stable security definer set search_path = '' as $$
 select mavi_private.admin(t.company_id) or (t.created_by = auth.uid() and mavi_private.leader(t.company_id))
$$;

-- Publicado e no público da pessoa (papel, equipe, ela mesma; sem exclusão).
create function mavi_private.tutorial_for_me(t public.tutorials) returns boolean
language sql stable security definer set search_path = '' as $$
 select t.status = 'published' and not (auth.uid() = any(t.aud_exclude)) and (
  t.aud_all or auth.uid() = any(t.aud_users)
  or exists (select 1 from public.memberships m
   where m.company_id = t.company_id and m.user_id = auth.uid() and m.role = any(t.aud_roles))
  or exists (select 1 from public.team_members tm
   where tm.company_id = t.company_id and tm.user_id = auth.uid() and tm.team_id = any(t.aud_teams)))
$$;

create function mavi_private.tutorial_can_see(t public.tutorials) returns boolean
language sql stable security definer set search_path = '' as $$
 select mavi_private.member(t.company_id) and (mavi_private.tutorial_can_edit(t) or mavi_private.tutorial_for_me(t))
$$;
revoke all on function mavi_private.tutorial_can_edit(public.tutorials), mavi_private.tutorial_for_me(public.tutorials),
 mavi_private.tutorial_can_see(public.tutorials) from public, anon, authenticated;

-- Uma lista de rótulos limpa: espaços juntados, sem repetidos (sem acento e
-- maiúscula) e na grafia que já existe nos tutoriais da empresa.
create function mavi_private.tutorial_labels(c uuid, p jsonb, p_kind text, p_max integer, p_len integer)
returns text[]
language plpgsql stable security definer set search_path = '' as $$
declare v text; k text; canon text; seen text[] := '{}'; result text[] := '{}'; begin
 for v in select jsonb_array_elements_text(case when jsonb_typeof(p) = 'array' then p else '[]' end) loop
  v := regexp_replace(btrim(v), '\s+', ' ', 'g');
  continue when v = '';
  if length(v) > p_len then
   raise exception '% pode ter até % caracteres.', case p_kind when 'tag' then 'Cada tag' else 'A categoria' end, p_len
    using errcode = '22023';
  end if;
  k := mavi_private.fold(v);
  continue when k = any(seen);
  seen := seen || k;
  select z.x into canon from (
   select unnest(t.tags) as x from public.tutorials t where t.company_id = c and p_kind = 'tag'
   union all
   select t.category from public.tutorials t where t.company_id = c and p_kind <> 'tag') z
  where z.x <> '' and mavi_private.fold(z.x) = k group by z.x order by count(*) desc, z.x limit 1;
  result := result || coalesce(canon, v);
 end loop;
 if cardinality(result) > p_max then
  raise exception '%', case p_kind when 'tag' then format('Use até %s tags.', p_max) else 'Escolha uma categoria só.' end
   using errcode = '22023';
 end if;
 return result;
end $$;

-- O conteúdo que a pessoa enviou, limpo e conferido.
create function mavi_private.tutorial_clean(c uuid, p jsonb) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_title text; v_summary text; v_body text; v_modules text[]; v_category text[]; v_tags text[];
 v_all boolean; v_roles text[]; v_teams uuid[]; v_users uuid[]; v_exclude uuid[]; x text; begin
 if jsonb_typeof(p) <> 'object' then raise exception 'Conteúdo inválido' using errcode = '22023'; end if;
 v_title := regexp_replace(btrim(coalesce(p->>'title', '')), '\s+', ' ', 'g');
 if length(v_title) < 3 or length(v_title) > 160 then
  raise exception 'Dê um título de 3 a 160 caracteres ao tutorial.' using errcode = '22023';
 end if;
 v_summary := btrim(coalesce(p->>'summary', ''));
 if length(v_summary) > 600 then raise exception 'O resumo pode ter até 600 caracteres.' using errcode = '22023'; end if;
 v_body := coalesce(p->>'body', '');
 if length(v_body) > 600000 then raise exception 'O texto do tutorial está grande demais. Divida em mais de um.' using errcode = '22023'; end if;

 v_modules := '{}';
 for x in select distinct jsonb_array_elements_text(case when jsonb_typeof(p->'modules') = 'array' then p->'modules' else '[]' end) loop
  if x !~ '^[a-zA-Z]{2,40}$' then raise exception 'Módulo inválido: %', left(x, 40) using errcode = '22023'; end if;
  v_modules := v_modules || x;
 end loop;
 if cardinality(v_modules) > 12 then raise exception 'Ligue o tutorial a até 12 módulos.' using errcode = '22023'; end if;
 v_modules := array(select m from unnest(v_modules) m order by m);

 v_category := mavi_private.tutorial_labels(c, case when coalesce(p->>'category', '') = '' then '[]'::jsonb
  else jsonb_build_array(p->>'category') end, 'category', 1, 60);
 v_tags := mavi_private.tutorial_labels(c, p->'tags', 'tag', 12, 40);

 v_all := coalesce((p->>'aud_all')::boolean, true);
 v_roles := array(select distinct r from jsonb_array_elements_text(
  case when jsonb_typeof(p->'aud_roles') = 'array' then p->'aud_roles' else '[]' end) r
  where r in ('admin', 'manager', 'member') order by r);
 -- Equipes e pessoas de fora da empresa (ou que não existem mais) saem.
 v_teams := array(select tm.id from public.teams tm where tm.company_id = c and tm.id::text in (
  select jsonb_array_elements_text(case when jsonb_typeof(p->'aud_teams') = 'array' then p->'aud_teams' else '[]' end))
  order by tm.id);
 v_users := array(select m.user_id from public.memberships m where m.company_id = c and m.user_id::text in (
  select jsonb_array_elements_text(case when jsonb_typeof(p->'aud_users') = 'array' then p->'aud_users' else '[]' end))
  order by m.user_id);
 v_exclude := array(select m.user_id from public.memberships m where m.company_id = c and m.user_id::text in (
  select jsonb_array_elements_text(case when jsonb_typeof(p->'aud_exclude') = 'array' then p->'aud_exclude' else '[]' end))
  order by m.user_id);
 if not v_all and cardinality(v_roles) + cardinality(v_teams) + cardinality(v_users) = 0 then
  raise exception 'Escolha quem vê o tutorial: todos, papéis, equipes ou pessoas.' using errcode = '22023';
 end if;
 if v_all then v_roles := '{}'; v_teams := '{}'; v_users := '{}'; end if;

 return jsonb_build_object('title', v_title, 'summary', v_summary, 'body', v_body, 'modules', to_jsonb(v_modules),
  'category', coalesce(v_category[1], ''), 'tags', to_jsonb(v_tags), 'aud_all', v_all, 'aud_roles', to_jsonb(v_roles),
  'aud_teams', to_jsonb(v_teams), 'aud_users', to_jsonb(v_users), 'aud_exclude', to_jsonb(v_exclude));
end $$;

-- O conteúdo do tutorial como está no ar (ou no rascunho nunca publicado).
create function mavi_private.tutorial_content(t public.tutorials) returns jsonb
language sql stable set search_path = '' as $$
 select jsonb_build_object('title', t.title, 'summary', t.summary, 'body', t.body, 'modules', to_jsonb(t.modules),
  'category', t.category, 'tags', to_jsonb(t.tags), 'aud_all', t.aud_all, 'aud_roles', to_jsonb(t.aud_roles),
  'aud_teams', to_jsonb(t.aud_teams), 'aud_users', to_jsonb(t.aud_users), 'aud_exclude', to_jsonb(t.aud_exclude))
$$;

-- Grava o conteúdo limpo na linha do tutorial.
create function mavi_private.tutorial_apply(p_id uuid, v jsonb) returns void
language sql security definer set search_path = '' as $$
 update public.tutorials set title = v->>'title', summary = v->>'summary', body = v->>'body',
  modules = array(select jsonb_array_elements_text(v->'modules')), category = v->>'category',
  tags = array(select jsonb_array_elements_text(v->'tags')), aud_all = (v->>'aud_all')::boolean,
  aud_roles = array(select jsonb_array_elements_text(v->'aud_roles')),
  aud_teams = array(select jsonb_array_elements_text(v->'aud_teams'))::uuid[],
  aud_users = array(select jsonb_array_elements_text(v->'aud_users'))::uuid[],
  aud_exclude = array(select jsonb_array_elements_text(v->'aud_exclude'))::uuid[],
  updated_by = auth.uid(), updated_at = now(), revision = revision + 1
 where id = p_id
$$;

-- Publica o que está na linha: versão nova (com o conteúdo inteiro).
create function mavi_private.tutorial_publish(p_id uuid, p_restored integer default null) returns void
language plpgsql security definer set search_path = '' as $$
declare t public.tutorials; begin
 update public.tutorials set status = 'published', version = version + 1, published_at = now(), published_by = auth.uid()
 where id = p_id returning * into t;
 insert into public.tutorial_versions(company_id, tutorial_id, version, content, published_by, restored_from)
 values (t.company_id, t.id, t.version, mavi_private.tutorial_content(t), auth.uid(), p_restored);
 delete from public.tutorial_drafts where tutorial_id = t.id;
end $$;
revoke all on function mavi_private.tutorial_labels(uuid, jsonb, text, integer, integer),
 mavi_private.tutorial_clean(uuid, jsonb), mavi_private.tutorial_content(public.tutorials),
 mavi_private.tutorial_apply(uuid, jsonb), mavi_private.tutorial_publish(uuid, integer)
 from public, anon, authenticated;

-- O texto da busca (sem acentos).
create function mavi_private.tutorial_search_text() returns trigger
language plpgsql security definer set search_path = '' as $$ begin
 new.search := mavi_private.fold(concat_ws(' ', new.title, new.summary, new.category, array_to_string(new.tags, ' '),
  mavi_private.rich_plain(new.body)));
 return new;
end $$;
revoke all on function mavi_private.tutorial_search_text() from public, anon, authenticated;
create trigger tutorial_search before insert or update of title, summary, body, category, tags
 on public.tutorials for each row execute function mavi_private.tutorial_search_text();

-- ------------------------------------------------------------ salvar
-- Cria ou salva um tutorial. p_publish: publica (ou publica a alteração).
-- Sem publicar, um tutorial no ar guarda a alteração como rascunho e
-- continua como estava. Devolve {id, mode, status, version, revision}:
-- mode 'created', 'saved' (rascunho que nunca foi ao ar), 'draft'
-- (alteração guardada à parte) ou 'published'.
create function public.save_tutorial(p_company uuid, p_tutorial uuid, p_content jsonb, p_publish boolean default false,
 p_revision integer default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare t public.tutorials; v jsonb; v_mode text; begin
 if not mavi_private.leader(p_company) then
  raise exception 'Só administradores e gestores escrevem tutoriais.' using errcode = '42501';
 end if;
 v := mavi_private.tutorial_clean(p_company, p_content);

 if p_tutorial is null then
  insert into public.tutorials(company_id, title, created_by, updated_by)
  values (p_company, v->>'title', auth.uid(), auth.uid()) returning * into t;
  perform mavi_private.tutorial_apply(t.id, v);
  -- O primeiro salvamento é a revisão 1.
  update public.tutorials set revision = 1 where id = t.id;
  if p_publish then perform mavi_private.tutorial_publish(t.id); end if;
  select * into t from public.tutorials where id = t.id;
  return jsonb_build_object('id', t.id, 'mode', case when p_publish then 'published' else 'created' end,
   'status', t.status, 'version', t.version, 'revision', t.revision);
 end if;

 select * into t from public.tutorials where id = p_tutorial and company_id = p_company for update;
 if not found or not mavi_private.tutorial_can_edit(t) then
  raise exception 'Só um administrador ou o gestor que criou o tutorial pode editá-lo.' using errcode = '42501';
 end if;
 if p_revision is not null and p_revision <> t.revision then
  raise exception 'Este tutorial foi alterado por outra pessoa. Abra de novo para ver a versão atual.' using errcode = '40001';
 end if;

 if t.status = 'published' and not p_publish then
  insert into public.tutorial_drafts(tutorial_id, company_id, content, saved_by)
  values (t.id, t.company_id, v, auth.uid())
  on conflict (tutorial_id) do update set content = excluded.content, saved_by = excluded.saved_by, saved_at = now();
  update public.tutorials set revision = revision + 1 where id = t.id returning * into t;
  v_mode := 'draft';
 else
  perform mavi_private.tutorial_apply(t.id, v);
  if p_publish then perform mavi_private.tutorial_publish(t.id); end if;
  select * into t from public.tutorials where id = t.id;
  v_mode := case when p_publish then 'published' else 'saved' end;
 end if;
 return jsonb_build_object('id', t.id, 'mode', v_mode, 'status', t.status, 'version', t.version, 'revision', t.revision);
end $$;

-- Desiste da alteração guardada de um tutorial no ar.
create function public.discard_tutorial_draft(p_tutorial uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare t public.tutorials; begin
 select * into t from public.tutorials where id = p_tutorial for update;
 if not found or not mavi_private.tutorial_can_edit(t) then raise exception 'Sem permissão' using errcode = '42501'; end if;
 delete from public.tutorial_drafts where tutorial_id = t.id;
 update public.tutorials set revision = revision + 1 where id = t.id;
end $$;

-- Tira do ar (volta a rascunho; as versões ficam).
create function public.unpublish_tutorial(p_tutorial uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare t public.tutorials; v jsonb; begin
 select * into t from public.tutorials where id = p_tutorial for update;
 if not found or not mavi_private.tutorial_can_edit(t) then raise exception 'Sem permissão' using errcode = '42501'; end if;
 if t.status <> 'published' then return; end if;
 -- A alteração guardada vira o rascunho (senão se perderia).
 select content into v from public.tutorial_drafts where tutorial_id = t.id;
 if v is not null then
  perform mavi_private.tutorial_apply(t.id, mavi_private.tutorial_clean(t.company_id, v));
  delete from public.tutorial_drafts where tutorial_id = t.id;
 end if;
 update public.tutorials set status = 'draft', revision = revision + 1 where id = t.id;
end $$;

-- Publica de novo o conteúdo de uma versão antiga (título, resumo, texto,
-- módulos, categoria e tags; o público fica o de agora).
create function public.restore_tutorial_version(p_tutorial uuid, p_version integer) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare t public.tutorials; old jsonb; cur jsonb; begin
 select * into t from public.tutorials where id = p_tutorial for update;
 if not found or not mavi_private.tutorial_can_edit(t) then raise exception 'Sem permissão' using errcode = '42501'; end if;
 select content into old from public.tutorial_versions where tutorial_id = t.id and version = p_version;
 if old is null then raise exception 'Versão não encontrada' using errcode = 'P0002'; end if;
 cur := mavi_private.tutorial_content(t);
 perform mavi_private.tutorial_apply(t.id, mavi_private.tutorial_clean(t.company_id, cur || jsonb_build_object(
  'title', old->'title', 'summary', old->'summary', 'body', old->'body', 'modules', old->'modules',
  'category', old->'category', 'tags', old->'tags')));
 perform mavi_private.tutorial_publish(t.id, p_version);
 select * into t from public.tutorials where id = t.id;
 return jsonb_build_object('id', t.id, 'mode', 'published', 'status', t.status, 'version', t.version, 'revision', t.revision);
end $$;

-- Apaga o tutorial com versões e vídeos. Devolve os caminhos a remover.
create function public.delete_tutorial(p_tutorial uuid) returns text[]
language plpgsql security definer set search_path = '' as $$
declare t public.tutorials; paths text[]; begin
 select * into t from public.tutorials where id = p_tutorial for update;
 if not found or not mavi_private.tutorial_can_edit(t) then
  raise exception 'Só um administrador ou o gestor que criou o tutorial pode apagá-lo.' using errcode = '42501';
 end if;
 select coalesce(array_agg(path), '{}') into paths from public.tutorial_media where company_id = t.company_id and tutorial_id = t.id;
 delete from public.tutorials where id = t.id;
 return paths;
end $$;

-- ------------------------------------------------------------ vídeos
create function public.prepare_tutorial_media(p_tutorial uuid, p_name text, p_size bigint, p_content_type text)
returns uuid
language plpgsql security definer set search_path = '' as $$
declare t public.tutorials; v_id uuid := gen_random_uuid(); v_type text; begin
 select * into t from public.tutorials where id = p_tutorial;
 if not found or not mavi_private.tutorial_can_edit(t) then
  raise exception 'Sem permissão para enviar vídeos a este tutorial.' using errcode = '42501';
 end if;
 if p_size is null or p_size < 1 or p_size > 524288000 then raise exception 'Envie vídeos de até 500 MB.' using errcode = '22023'; end if;
 if length(btrim(coalesce(p_name, ''))) = 0 then raise exception 'Arquivo sem nome' using errcode = '22023'; end if;
 v_type := lower(btrim(coalesce(p_content_type, '')));
 if v_type !~ '^video/[a-z0-9][a-z0-9!#$&^_.+-]*$' then
  raise exception 'Envie um arquivo de vídeo (MP4, WebM ou MOV).' using errcode = '22023';
 end if;
 if (select count(*) from public.tutorial_media where company_id = t.company_id and tutorial_id = t.id) >= 50 then
  raise exception 'Um tutorial pode ter até 50 vídeos.' using errcode = '22023';
 end if;
 -- Envios que ficaram pela metade (mais de um dia) somem.
 delete from public.tutorial_media where created_by = auth.uid() and status = 'uploading'
  and created_at < now() - interval '1 day';
 insert into public.tutorial_media(id, company_id, tutorial_id, name, content_type, size_bytes, path, created_by)
 values (v_id, t.company_id, t.id, left(btrim(p_name), 255), v_type, p_size,
  'tutorials/' || t.company_id || '/' || t.id || '/' || v_id, auth.uid());
 return v_id;
end $$;

-- Onde enviar (só no servidor, que assina o PUT): da própria pessoa,
-- ainda enviando, preparado há menos de um dia.
create function public.tutorial_upload_target(p_media uuid)
returns table(path text, content_type text, size_bytes bigint)
language sql stable security definer set search_path = '' as $$
 select m.path, m.content_type, m.size_bytes from public.tutorial_media m
 where m.id = p_media and m.created_by = auth.uid() and m.status = 'uploading'
  and m.created_at > now() - interval '1 day' and mavi_private.leader(m.company_id)
$$;

create function public.confirm_tutorial_media(p_media uuid) returns void
language plpgsql security definer set search_path = '' as $$ begin
 update public.tutorial_media set status = 'ready'
 where id = p_media and created_by = auth.uid() and status = 'uploading';
 if not found then raise exception 'Vídeo não encontrado' using errcode = '42501'; end if;
end $$;

-- Onde estão os vídeos que a pessoa pode ver (o servidor assina o GET).
create function public.tutorial_media_targets(p_ids uuid[])
returns table(id uuid, path text, name text, content_type text)
language sql stable security definer set search_path = '' as $$
 select m.id, m.path, m.name, m.content_type
 from public.tutorial_media m join public.tutorials t on t.company_id = m.company_id and t.id = m.tutorial_id
 where m.id = any(p_ids[1:60]) and m.status = 'ready' and mavi_private.tutorial_can_see(t)
$$;

-- ------------------------------------------------------------ ler
-- A lista: 'library' (os publicados que a pessoa vê) ou 'admin' (líderes:
-- administradores veem todos; gestores, os seus e os publicados que veem).
-- Busca por todas as palavras, sem acento; módulo, categoria e tags filtram.
create function public.list_tutorials(p_company uuid, p_query text default '', p_module text default null,
 p_category text default null, p_tags text[] default null, p_scope text default 'library', p_limit integer default 30,
 p_offset integer default 0)
returns table(id uuid, title text, summary text, modules text[], category text, tags text[], status text,
 version integer, has_draft boolean, aud_all boolean, created_by uuid, author_name text, updated_by_name text,
 published_at timestamptz, updated_at timestamptz, video_count integer, can_edit boolean, total bigint)
language plpgsql stable security definer set search_path = '' as $$
declare v_words text[]; v_tags text[]; v_cat text; begin
 if not mavi_private.member(p_company) then raise exception 'Sem acesso ao espaço' using errcode = '42501'; end if;
 if p_scope = 'admin' and not mavi_private.leader(p_company) then return; end if;
 v_words := array(select w from unnest(regexp_split_to_array(mavi_private.fold(btrim(left(coalesce(p_query, ''), 200))), '\s+')) w
  where w <> '');
 v_tags := case when cardinality(p_tags) > 0 then array(select mavi_private.fold(x) from unnest(p_tags) x) end;
 v_cat := nullif(mavi_private.fold(btrim(coalesce(p_category, ''))), '');
 return query
 with base as (
  select t.*, mavi_private.tutorial_can_edit(t) as editor, mavi_private.tutorial_for_me(t) as for_me
  from public.tutorials t
  where t.company_id = p_company
   and (p_module is null or p_module = '' or p_module = any(t.modules))
   and (v_cat is null or mavi_private.fold(t.category) = v_cat)
   and (v_tags is null or exists (select 1 from unnest(t.tags) g where mavi_private.fold(g) = any(v_tags)))
   and not exists (select 1 from unnest(v_words) w where strpos(t.search, w) = 0)),
 shown as (
  select b.* from base b
  where b.for_me or (p_scope = 'admin' and b.editor))
 select s.id, s.title, s.summary, s.modules, s.category, s.tags, s.status, s.version,
  s.editor and exists (select 1 from public.tutorial_drafts d where d.tutorial_id = s.id),
  s.aud_all, s.created_by, mavi_private.member_name(p_company, s.created_by),
  mavi_private.member_name(p_company, s.updated_by), s.published_at, s.updated_at,
  (select count(*)::integer from public.tutorial_media m where m.company_id = s.company_id and m.tutorial_id = s.id
    and m.status = 'ready'),
  s.editor, count(*) over ()
 from shown s
 order by
  -- Com busca, o que tem mais palavras no título vem antes.
  (select count(*) from unnest(v_words) w where strpos(mavi_private.fold(s.title), w) > 0) desc,
  case when p_scope = 'admin' then s.updated_at end desc nulls last,
  s.published_at desc nulls last, s.title, s.id
 limit least(greatest(coalesce(p_limit, 30), 1), 100) offset greatest(coalesce(p_offset, 0), 0);
end $$;

-- Categorias e tags em uso (com quantos tutoriais a pessoa vê), para os
-- filtros e o autocompletar.
create function public.tutorial_facets(p_company uuid) returns table(kind text, value text, tutorials integer)
language plpgsql stable security definer set search_path = '' as $$ begin
 if not mavi_private.member(p_company) then raise exception 'Sem acesso ao espaço' using errcode = '42501'; end if;
 return query
 with mine as (
  select t.* from public.tutorials t
  where t.company_id = p_company and (mavi_private.tutorial_for_me(t) or mavi_private.tutorial_can_edit(t))),
 used as (
  select 'category'::text as k, m.category as x, (m.status = 'published')::integer as w from mine m where m.category <> ''
  union all
  select 'tag', g, (m.status = 'published')::integer from mine m, unnest(m.tags) g)
 select u.k, (array_agg(u.x order by u.x))[1], sum(u.w)::integer
 from used u group by u.k, mavi_private.fold(u.x)
 order by 1, 3 desc, 2 limit 400;
end $$;

-- Tudo de um tutorial para a tela: o conteúdo no ar (e, para quem edita, a
-- alteração guardada e o público), vídeos e o que a pessoa pode fazer.
create function public.tutorial_detail(p_tutorial uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare t public.tutorials; d public.tutorial_drafts; v_edit boolean; begin
 select * into t from public.tutorials where id = p_tutorial;
 if not found or not mavi_private.tutorial_can_see(t) then return null; end if;
 v_edit := mavi_private.tutorial_can_edit(t);
 if v_edit then select * into d from public.tutorial_drafts where tutorial_id = t.id; end if;
 return jsonb_build_object(
  'id', t.id, 'company_id', t.company_id, 'title', t.title, 'summary', t.summary, 'body', t.body,
  'modules', to_jsonb(t.modules), 'category', t.category, 'tags', to_jsonb(t.tags), 'status', t.status,
  'version', t.version, 'revision', t.revision,
  'audience', case when v_edit then jsonb_build_object('aud_all', t.aud_all, 'aud_roles', to_jsonb(t.aud_roles),
   'aud_teams', to_jsonb(t.aud_teams), 'aud_users', to_jsonb(t.aud_users), 'aud_exclude', to_jsonb(t.aud_exclude)) end,
  'created_by', t.created_by, 'author_name', mavi_private.member_name(t.company_id, t.created_by),
  'updated_by_name', mavi_private.member_name(t.company_id, t.updated_by),
  'created_at', t.created_at, 'updated_at', t.updated_at, 'published_at', t.published_at,
  'media', coalesce((select jsonb_agg(jsonb_build_object('id', m.id, 'name', m.name, 'content_type', m.content_type,
    'size_bytes', m.size_bytes) order by m.created_at)
   from public.tutorial_media m where m.company_id = t.company_id and m.tutorial_id = t.id and m.status = 'ready'), '[]'),
  'draft', case when d.tutorial_id is not null then jsonb_build_object('content', d.content, 'saved_at', d.saved_at,
   'saved_by_name', mavi_private.member_name(t.company_id, d.saved_by)) end,
  'can_edit', v_edit);
end $$;

-- As versões publicadas (quem edita).
create function public.tutorial_version_list(p_tutorial uuid)
returns table(version integer, title text, published_by_name text, published_at timestamptz, restored_from integer)
language plpgsql stable security definer set search_path = '' as $$
declare t public.tutorials; begin
 select * into t from public.tutorials where id = p_tutorial;
 if not found or not mavi_private.tutorial_can_edit(t) then return; end if;
 return query select v.version, v.content->>'title', mavi_private.member_name(t.company_id, v.published_by),
  v.published_at, v.restored_from
 from public.tutorial_versions v where v.tutorial_id = t.id order by v.version desc;
end $$;

create function public.tutorial_version(p_tutorial uuid, p_version integer) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare t public.tutorials; v public.tutorial_versions; begin
 select * into t from public.tutorials where id = p_tutorial;
 if not found or not mavi_private.tutorial_can_edit(t) then return null; end if;
 select * into v from public.tutorial_versions x where x.tutorial_id = t.id and x.version = p_version;
 if not found then return null; end if;
 return v.content || jsonb_build_object('version', v.version, 'published_at', v.published_at,
  'published_by_name', mavi_private.member_name(t.company_id, v.published_by), 'restored_from', v.restored_from);
end $$;

-- ------------------------------------------------------------ avisos ao vivo
-- Só o id: cada tela pergunta de novo o que pode ver.
create function mavi_private.broadcast_tutorial() returns trigger
language plpgsql security definer set search_path = '' as $$
declare r record; begin
 r := coalesce(new, old);
 perform mavi_private.broadcast(r.company_id, jsonb_build_object('kind', 'tutorials',
  'tutorial', coalesce(to_jsonb(r)->>'tutorial_id', to_jsonb(r)->>'id')));
 return null;
end $$;
revoke all on function mavi_private.broadcast_tutorial() from public, anon, authenticated;
create trigger broadcast_tutorial after insert or delete or update of title, summary, body, modules, category, tags,
 aud_all, aud_roles, aud_teams, aud_users, aud_exclude, status, version on public.tutorials
 for each row execute function mavi_private.broadcast_tutorial();
create trigger broadcast_tutorial_draft after insert or update or delete on public.tutorial_drafts
 for each row execute function mavi_private.broadcast_tutorial();

-- ------------------------------------------------------------ permissões
revoke all on function public.save_tutorial(uuid, uuid, jsonb, boolean, integer), public.discard_tutorial_draft(uuid),
 public.unpublish_tutorial(uuid), public.restore_tutorial_version(uuid, integer), public.delete_tutorial(uuid),
 public.prepare_tutorial_media(uuid, text, bigint, text), public.tutorial_upload_target(uuid),
 public.confirm_tutorial_media(uuid), public.tutorial_media_targets(uuid[]),
 public.list_tutorials(uuid, text, text, text, text[], text, integer, integer), public.tutorial_facets(uuid),
 public.tutorial_detail(uuid), public.tutorial_version_list(uuid), public.tutorial_version(uuid, integer)
 from public, anon, authenticated;
grant execute on function public.save_tutorial(uuid, uuid, jsonb, boolean, integer), public.discard_tutorial_draft(uuid),
 public.unpublish_tutorial(uuid), public.restore_tutorial_version(uuid, integer), public.delete_tutorial(uuid),
 public.prepare_tutorial_media(uuid, text, bigint, text), public.tutorial_upload_target(uuid),
 public.confirm_tutorial_media(uuid), public.tutorial_media_targets(uuid[]),
 public.list_tutorials(uuid, text, text, text, text[], text, integer, integer), public.tutorial_facets(uuid),
 public.tutorial_detail(uuid), public.tutorial_version_list(uuid), public.tutorial_version(uuid, integer)
 to authenticated;

commit;
