begin;

-- Anotações do cliente: textos com editor (acessos, links úteis, combinados)
-- que pertencem ao cliente — aparecem em todas as tarefas dele e no Drive ›
-- cliente › Anotações. Quem vê o cliente (regra do Drive) lê e edita todas.
-- Cada "Salvar" grava uma versão inteira (título + texto), para voltar a
-- qualquer uma; restaurar também vira uma versão nova, nada se perde.
--
-- Trechos secretos (senhas): o valor nunca fica no texto. O texto guarda só
-- um marcador {type: "noteSecret", attrs: {secretId, label}}; o valor fica em
-- client_note_secrets, cifrado pelo servidor (api/client-notes) com uma chave
-- que o banco não tem. Um secreto nunca muda: trocar o valor cria outro, e
-- assim restaurar uma versão antiga devolve também os valores daquela época.
-- Quem mostra ou copia um valor fica registrado. A MAVI lê o texto (o
-- secreto entra só como "[Secreto: nome — valor oculto]"): ela sabe que
-- existe, mas não tem como repetir o valor.

-- ------------------------------------------------------------ acesso
-- Membro ativo e o cliente nas equipes dele (ou líder): a regra do Drive.
create function mavi_private.client_note_reader(c uuid, p_client uuid) returns boolean
language sql stable security definer set search_path = '' as $$
 select mavi_private.dossier_reader(c, p_client)
$$;
-- A política de leitura chama como a própria pessoa.
revoke all on function mavi_private.client_note_reader(uuid, uuid) from public, anon;
grant execute on function mavi_private.client_note_reader(uuid, uuid) to authenticated;

-- ------------------------------------------------------------ tabelas
create table public.client_notes (
 id uuid primary key default gen_random_uuid(),
 company_id uuid not null references public.companies(id) on delete cascade,
 client_id uuid not null references public.clients(id) on delete cascade,
 title text not null check (length(btrim(title)) between 1 and 200),
 body text not null default '' check (length(body) <= 400000),
 -- A versão atual (a última gravada em client_note_versions).
 version integer not null default 1 check (version >= 1),
 created_by uuid references auth.users(id) on delete set null,
 created_at timestamptz not null default now(),
 updated_by uuid references auth.users(id) on delete set null,
 updated_at timestamptz not null default now(),
 -- Excluída: some da lista e da MAVI, mas volta com "Restaurar".
 deleted_at timestamptz,
 deleted_by uuid references auth.users(id) on delete set null
);
create index client_notes_client on public.client_notes(company_id, client_id, updated_at desc);
alter table public.client_notes enable row level security;
revoke all on public.client_notes from public, anon, authenticated;
grant select on public.client_notes to authenticated;
create policy client_notes_read on public.client_notes for select to authenticated
 using (company_id in (select mavi_private.active_companies())
  and mavi_private.client_note_reader(company_id, client_id));

create table public.client_note_versions (
 id uuid primary key default gen_random_uuid(),
 company_id uuid not null references public.companies(id) on delete cascade,
 note_id uuid not null references public.client_notes(id) on delete cascade,
 version integer not null check (version >= 1),
 title text not null,
 body text not null,
 action text not null check (action in ('create', 'save', 'restore')),
 -- Restaurar: de qual versão veio o conteúdo.
 restored_from integer,
 saved_by uuid references auth.users(id) on delete set null,
 saved_at timestamptz not null default now(),
 unique (note_id, version)
);
alter table public.client_note_versions enable row level security;
revoke all on public.client_note_versions from public, anon, authenticated;

-- O valor cifrado de cada trecho secreto ("v1:" + base64, AES-256-GCM).
create table public.client_note_secrets (
 id uuid primary key default gen_random_uuid(),
 company_id uuid not null references public.companies(id) on delete cascade,
 client_id uuid not null references public.clients(id) on delete cascade,
 label text not null check (length(btrim(label)) between 1 and 120),
 sealed text not null check (sealed ~ '^v1:[A-Za-z0-9+/=]+$' and length(sealed) <= 20000),
 created_by uuid references auth.users(id) on delete set null,
 created_at timestamptz not null default now()
);
create index client_note_secrets_client on public.client_note_secrets(company_id, client_id);
alter table public.client_note_secrets enable row level security;
revoke all on public.client_note_secrets from public, anon, authenticated;

-- Quem mostrou ou copiou cada valor (nunca alterado nem apagado).
create table public.client_note_secret_views (
 id bigint generated always as identity primary key,
 company_id uuid not null references public.companies(id) on delete cascade,
 secret_id uuid not null references public.client_note_secrets(id) on delete cascade,
 note_id uuid references public.client_notes(id) on delete set null,
 user_id uuid references auth.users(id) on delete set null,
 action text not null check (action in ('view', 'copy')),
 created_at timestamptz not null default now()
);
create index client_note_secret_views_note on public.client_note_secret_views(note_id, created_at desc);
create index client_note_secret_views_user on public.client_note_secret_views(user_id, created_at desc);
alter table public.client_note_secret_views enable row level security;
revoke all on public.client_note_secret_views from public, anon, authenticated;

create function mavi_private.client_note_immutable() returns trigger
language plpgsql set search_path = '' as $$ begin
 raise exception 'O histórico das anotações não pode ser alterado.';
end $$;
revoke all on function mavi_private.client_note_immutable() from public, anon, authenticated;
create trigger client_note_versions_immutable before update on public.client_note_versions
 for each row execute function mavi_private.client_note_immutable();
create trigger client_note_secrets_immutable before update on public.client_note_secrets
 for each row execute function mavi_private.client_note_immutable();
create trigger client_note_secret_views_immutable before update on public.client_note_secret_views
 for each row execute function mavi_private.client_note_immutable();

-- ------------------------------------------------------------ texto puro
-- O texto que a MAVI lê: parágrafos em linhas, listas com marcador, links
-- com o endereço e o secreto só com o nome.
create function mavi_private.client_note_node_text(n jsonb, depth integer) returns text
language plpgsql immutable parallel safe set search_path = '' as $$
declare t text := n->>'type'; acc text := ''; child jsonb; href text; i integer := 0; part text; begin
 if depth > 40 or jsonb_typeof(n) <> 'object' then return ''; end if;
 if t = 'text' then
  select m->'attrs'->>'href' into href from jsonb_array_elements(coalesce(n->'marks', '[]')) m
   where m->>'type' = 'link' limit 1;
  return coalesce(n->>'text', '')
   || case when href is not null and href <> coalesce(n->>'text', '') then ' (' || href || ')' else '' end;
 elsif t = 'mention' then return '@' || coalesce(n->'attrs'->>'label', '');
 elsif t = 'noteSecret' then
  return '[Secreto: ' || coalesce(nullif(btrim(n->'attrs'->>'label'), ''), 'sem nome') || ' — valor oculto]';
 elsif t = 'hardBreak' then return E'\n';
 elsif t = 'inlineImage' then return '[imagem]';
 end if;
 for child in select value from jsonb_array_elements(case when jsonb_typeof(n->'content') = 'array'
  then n->'content' else '[]' end) loop
  i := i + 1;
  part := mavi_private.client_note_node_text(child, depth + 1);
  if t = 'bulletList' then acc := acc || case when i > 1 then E'\n' else '' end || '- ' || part;
  elsif t = 'orderedList' then acc := acc || case when i > 1 then E'\n' else '' end || i || '. ' || part;
  elsif t in ('doc', 'listItem') then acc := acc || case when i > 1 then E'\n' else '' end || part;
  else acc := acc || part;
  end if;
 end loop;
 return acc;
end $$;

create function mavi_private.client_note_plain(p text) returns text
language plpgsql immutable parallel safe set search_path = '' as $$
declare prefix constant text := 'mavi:richtext:v1:'; doc jsonb; begin
 if p is null or left(p, length(prefix)) <> prefix then return coalesce(p, ''); end if;
 begin
  doc := substr(p, length(prefix) + 1)::jsonb;
 exception when others then return p;
 end;
 return btrim(mavi_private.client_note_node_text(doc, 0), E' \n');
end $$;
revoke all on function mavi_private.client_note_node_text(jsonb, integer), mavi_private.client_note_plain(text)
 from public, anon, authenticated;

-- Quantos secretos o texto tem.
create function mavi_private.client_note_secret_count(p text) returns integer
language sql immutable parallel safe set search_path = '' as $$
 select coalesce((length(p) - length(replace(p, '"type":"noteSecret"', ''))) / length('"type":"noteSecret"'), 0)
$$;
revoke all on function mavi_private.client_note_secret_count(text) from public, anon, authenticated;

-- ------------------------------------------------------------ leitura
create function mavi_private.client_note_view(n public.client_notes, p_body boolean) returns jsonb
language sql stable security definer set search_path = '' as $$
 select jsonb_build_object('id', n.id, 'company_id', n.company_id, 'client_id', n.client_id, 'title', n.title,
  'excerpt', left(regexp_replace(mavi_private.client_note_plain(n.body), '\s+', ' ', 'g'), 180),
  'secrets', mavi_private.client_note_secret_count(n.body),
  'version', n.version, 'created_by', n.created_by,
  'created_by_name', (select m.name from public.memberships m where m.company_id = n.company_id and m.user_id = n.created_by),
  'created_at', n.created_at, 'updated_by', n.updated_by,
  'updated_by_name', (select m.name from public.memberships m where m.company_id = n.company_id and m.user_id = n.updated_by),
  'updated_at', n.updated_at, 'deleted_at', n.deleted_at,
  'deleted_by_name', (select m.name from public.memberships m where m.company_id = n.company_id and m.user_id = n.deleted_by))
  || case when p_body then jsonb_build_object('body', n.body,
   'client_name', (select k.name from public.clients k where k.id = n.client_id)) else '{}' end
$$;
revoke all on function mavi_private.client_note_view(public.client_notes, boolean) from public, anon, authenticated;

-- A anotação, com a checagem de acesso (para todas as funções abaixo).
create function mavi_private.client_note_row(p_note uuid) returns public.client_notes
language plpgsql stable security definer set search_path = '' as $$
declare n public.client_notes; begin
 select * into n from public.client_notes where id = p_note;
 if n.id is null or not mavi_private.client_note_reader(n.company_id, n.client_id) then
  raise exception 'Anotação não encontrada.' using errcode = 'P0002';
 end if;
 return n;
end $$;
revoke all on function mavi_private.client_note_row(uuid) from public, anon, authenticated;

-- As anotações do cliente (mais recentes primeiro); p_deleted: as excluídas.
create function public.client_notes_list(p_company uuid, p_client uuid, p_deleted boolean default false)
returns jsonb language plpgsql stable security definer set search_path = '' as $$ begin
 if not mavi_private.client_note_reader(p_company, p_client) then
  raise exception 'Sem acesso a este cliente.' using errcode = '42501';
 end if;
 return coalesce((select jsonb_agg(mavi_private.client_note_view(n, false) order by n.updated_at desc, n.id)
  from public.client_notes n
  where n.company_id = p_company and n.client_id = p_client
   and (case when coalesce(p_deleted, false) then n.deleted_at is not null else n.deleted_at is null end)), '[]');
end $$;

create function public.client_note_get(p_note uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
 select mavi_private.client_note_view(mavi_private.client_note_row(p_note), true)
$$;

-- Quantas anotações o cliente tem (o cartão da pasta no Drive).
create function public.client_notes_count(p_company uuid, p_client uuid) returns integer
language plpgsql stable security definer set search_path = '' as $$ begin
 if not mavi_private.client_note_reader(p_company, p_client) then return 0; end if;
 return (select count(*) from public.client_notes n
  where n.company_id = p_company and n.client_id = p_client and n.deleted_at is null);
end $$;

-- ------------------------------------------------------------ escrita
create function mavi_private.client_note_clean_title(p text) returns text
language plpgsql immutable set search_path = '' as $$
declare v text := btrim(regexp_replace(coalesce(p, ''), '[\x00-\x1f]+', ' ', 'g')); begin
 if length(v) = 0 then raise exception 'Dê um título à anotação.' using errcode = '22023'; end if;
 if length(v) > 200 then raise exception 'Título longo demais (até 200 caracteres).' using errcode = '22023'; end if;
 return v;
end $$;
revoke all on function mavi_private.client_note_clean_title(text) from public, anon, authenticated;

create function mavi_private.client_note_check_body(p text) returns text
language plpgsql immutable set search_path = '' as $$ begin
 if length(coalesce(p, '')) > 400000 then
  raise exception 'Anotação longa demais: divida em mais de uma.' using errcode = '22023';
 end if;
 return coalesce(p, '');
end $$;
revoke all on function mavi_private.client_note_check_body(text) from public, anon, authenticated;

create function public.client_note_create(p_company uuid, p_client uuid, p_title text, p_body text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare n public.client_notes; begin
 if not mavi_private.client_note_reader(p_company, p_client) then
  raise exception 'Sem acesso a este cliente.' using errcode = '42501';
 end if;
 -- Até 120 anotações novas por pessoa por hora.
 if (select count(*) from public.client_notes x where x.company_id = p_company and x.created_by = auth.uid()
  and x.created_at > now() - interval '1 hour') >= 120 then
  raise exception 'Muitas anotações em pouco tempo: tente de novo daqui a pouco.' using errcode = '54000';
 end if;
 insert into public.client_notes(company_id, client_id, title, body, created_by, updated_by)
 values (p_company, p_client, mavi_private.client_note_clean_title(p_title),
  mavi_private.client_note_check_body(p_body), auth.uid(), auth.uid())
 returning * into n;
 insert into public.client_note_versions(company_id, note_id, version, title, body, action, saved_by)
 values (n.company_id, n.id, 1, n.title, n.body, 'create', auth.uid());
 perform mavi_private.drive_log(n.company_id, 'note_created', null, null, n.title, n.client_id, null,
  jsonb_build_object('note', n.id, 'version', 1));
 return mavi_private.client_note_view(n, true);
end $$;

-- Grava uma versão nova. p_base é a versão que a pessoa abriu: se alguém
-- salvou outra no meio tempo, nada é gravado (quem salvou primeiro não perde).
create function mavi_private.client_note_write(p_note uuid, p_title text, p_body text, p_base integer,
 p_action text, p_from integer) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare n public.client_notes; v_title text := mavi_private.client_note_clean_title(p_title);
 v_body text := mavi_private.client_note_check_body(p_body); v_who text; begin
 n := mavi_private.client_note_row(p_note);
 select * into n from public.client_notes where id = n.id for update;
 if n.deleted_at is not null then
  raise exception 'Esta anotação foi excluída. Restaure-a antes de editar.' using errcode = '22023';
 end if;
 if p_base is distinct from n.version then
  select m.name into v_who from public.memberships m where m.company_id = n.company_id and m.user_id = n.updated_by;
  raise exception '% salvou uma versão nova desta anotação enquanto você editava.', coalesce(v_who, 'Outra pessoa')
   using errcode = '40001', hint = 'version:' || n.version;
 end if;
 if v_title = n.title and v_body = n.body then return mavi_private.client_note_view(n, true); end if;
 update public.client_notes set title = v_title, body = v_body, version = n.version + 1,
  updated_by = auth.uid(), updated_at = now()
 where id = n.id returning * into n;
 insert into public.client_note_versions(company_id, note_id, version, title, body, action, restored_from, saved_by)
 values (n.company_id, n.id, n.version, n.title, n.body, p_action, p_from, auth.uid());
 perform mavi_private.drive_log(n.company_id, case p_action when 'restore' then 'note_restored' else 'note_saved' end,
  null, null, n.title, n.client_id, null,
  jsonb_strip_nulls(jsonb_build_object('note', n.id, 'version', n.version, 'from', p_from)));
 return mavi_private.client_note_view(n, true);
end $$;
revoke all on function mavi_private.client_note_write(uuid, text, text, integer, text, integer)
 from public, anon, authenticated;

create function public.client_note_save(p_note uuid, p_title text, p_body text, p_base integer) returns jsonb
language sql security definer set search_path = '' as $$
 select mavi_private.client_note_write(p_note, p_title, p_body, p_base, 'save', null)
$$;

-- Volta ao conteúdo de uma versão antiga, como uma versão nova.
create function public.client_note_restore(p_note uuid, p_version integer, p_base integer) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare n public.client_notes := mavi_private.client_note_row(p_note); v public.client_note_versions; begin
 select * into v from public.client_note_versions where note_id = n.id and version = p_version;
 if v.id is null then raise exception 'Versão não encontrada.' using errcode = 'P0002'; end if;
 return mavi_private.client_note_write(n.id, v.title, v.body, p_base, 'restore', v.version);
end $$;

create function public.client_note_versions(p_note uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
 select coalesce(jsonb_agg(jsonb_build_object('version', v.version, 'title', v.title, 'action', v.action,
   'restored_from', v.restored_from, 'saved_by', v.saved_by,
   'saved_by_name', (select m.name from public.memberships m where m.company_id = v.company_id and m.user_id = v.saved_by),
   'saved_at', v.saved_at, 'chars', length(mavi_private.client_note_plain(v.body)),
   'secrets', mavi_private.client_note_secret_count(v.body)) order by v.version desc), '[]')
 from public.client_note_versions v where v.note_id = (mavi_private.client_note_row(p_note)).id
$$;

create function public.client_note_version(p_note uuid, p_version integer) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare n public.client_notes := mavi_private.client_note_row(p_note); v public.client_note_versions; begin
 select * into v from public.client_note_versions where note_id = n.id and version = p_version;
 if v.id is null then raise exception 'Versão não encontrada.' using errcode = 'P0002'; end if;
 return jsonb_build_object('version', v.version, 'title', v.title, 'body', v.body, 'action', v.action,
  'restored_from', v.restored_from, 'saved_at', v.saved_at,
  'saved_by_name', (select m.name from public.memberships m where m.company_id = v.company_id and m.user_id = v.saved_by));
end $$;

create function public.client_note_delete(p_note uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare n public.client_notes := mavi_private.client_note_row(p_note); begin
 if n.deleted_at is null then
  update public.client_notes set deleted_at = now(), deleted_by = auth.uid() where id = n.id returning * into n;
  perform mavi_private.drive_log(n.company_id, 'note_deleted', null, null, n.title, n.client_id, null,
   jsonb_build_object('note', n.id, 'version', n.version));
 end if;
 return mavi_private.client_note_view(n, false);
end $$;

create function public.client_note_undelete(p_note uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare n public.client_notes := mavi_private.client_note_row(p_note); begin
 if n.deleted_at is not null then
  update public.client_notes set deleted_at = null, deleted_by = null where id = n.id returning * into n;
  perform mavi_private.drive_log(n.company_id, 'note_undeleted', null, null, n.title, n.client_id, null,
   jsonb_build_object('note', n.id, 'version', n.version));
 end if;
 return mavi_private.client_note_view(n, false);
end $$;

-- ------------------------------------------------------------ secretos
-- Chamadas pelo servidor (api/client-notes), com o login da pessoa: quem cifra
-- e decifra é o servidor; o banco só guarda e confere o acesso.
create function public.client_note_secret_create(p_company uuid, p_client uuid, p_label text, p_sealed text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_label text := btrim(regexp_replace(coalesce(p_label, ''), '[\x00-\x1f]+', ' ', 'g')); v_id uuid; begin
 if not mavi_private.client_note_reader(p_company, p_client) then
  raise exception 'Sem acesso a este cliente.' using errcode = '42501';
 end if;
 if length(v_label) = 0 then raise exception 'Dê um nome ao secreto (ex.: Senha do Meta).' using errcode = '22023'; end if;
 if length(v_label) > 120 then raise exception 'Nome longo demais (até 120 caracteres).' using errcode = '22023'; end if;
 if coalesce(p_sealed, '') !~ '^v1:[A-Za-z0-9+/=]+$' or length(p_sealed) > 20000 then
  raise exception 'Valor do secreto inválido.' using errcode = '22023';
 end if;
 if (select count(*) from public.client_note_secrets x where x.company_id = p_company and x.created_by = auth.uid()
  and x.created_at > now() - interval '1 hour') >= 300 then
  raise exception 'Muitos secretos em pouco tempo: tente de novo daqui a pouco.' using errcode = '54000';
 end if;
 insert into public.client_note_secrets(company_id, client_id, label, sealed, created_by)
 values (p_company, p_client, v_label, p_sealed, auth.uid()) returning id into v_id;
 return jsonb_build_object('id', v_id, 'label', v_label);
end $$;

-- O valor cifrado para o servidor decifrar, registrando quem viu ou copiou.
create function public.client_note_secret_open(p_secret uuid, p_note uuid, p_action text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare s public.client_note_secrets; v_note uuid; v_title text; begin
 select * into s from public.client_note_secrets where id = p_secret;
 if s.id is null or not mavi_private.client_note_reader(s.company_id, s.client_id) then
  raise exception 'Secreto não encontrado.' using errcode = 'P0002';
 end if;
 if p_action not in ('view', 'copy') then raise exception 'Ação inválida.' using errcode = '22023'; end if;
 -- Até 200 aberturas por pessoa por hora: ninguém varre os valores.
 if (select count(*) from public.client_note_secret_views x where x.user_id = auth.uid()
  and x.created_at > now() - interval '1 hour') >= 200 then
  raise exception 'Muitos secretos abertos em pouco tempo: tente de novo daqui a pouco.' using errcode = '54000';
 end if;
 select n.id, n.title into v_note, v_title from public.client_notes n
 where n.id = p_note and n.company_id = s.company_id and n.client_id = s.client_id;
 insert into public.client_note_secret_views(company_id, secret_id, note_id, user_id, action)
 values (s.company_id, s.id, v_note, auth.uid(), p_action);
 perform mavi_private.drive_log(s.company_id, case p_action when 'copy' then 'note_secret_copied' else 'note_secret_viewed' end,
  null, null, coalesce(v_title, s.label), s.client_id, null,
  jsonb_strip_nulls(jsonb_build_object('note', v_note, 'secret', s.id, 'label', s.label)));
 return jsonb_build_object('id', s.id, 'label', s.label, 'sealed', s.sealed);
end $$;

-- Quem mostrou ou copiou os secretos desta anotação (os 200 mais recentes).
create function public.client_note_secret_log(p_note uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
 select coalesce(jsonb_agg(x.j order by x.at desc), '[]') from (
  select v.created_at as at, jsonb_build_object('at', v.created_at, 'action', v.action, 'label', s.label,
   'user_id', v.user_id,
   'user_name', (select m.name from public.memberships m where m.company_id = v.company_id and m.user_id = v.user_id)) as j
  from public.client_note_secret_views v join public.client_note_secrets s on s.id = v.secret_id
  where v.note_id = (mavi_private.client_note_row(p_note)).id
  order by v.created_at desc limit 200) x
$$;

revoke all on function public.client_notes_list(uuid, uuid, boolean), public.client_note_get(uuid),
 public.client_notes_count(uuid, uuid), public.client_note_create(uuid, uuid, text, text),
 public.client_note_save(uuid, text, text, integer), public.client_note_restore(uuid, integer, integer),
 public.client_note_versions(uuid), public.client_note_version(uuid, integer), public.client_note_delete(uuid),
 public.client_note_undelete(uuid), public.client_note_secret_create(uuid, uuid, text, text),
 public.client_note_secret_open(uuid, uuid, text), public.client_note_secret_log(uuid) from public, anon;
grant execute on function public.client_notes_list(uuid, uuid, boolean), public.client_note_get(uuid),
 public.client_notes_count(uuid, uuid), public.client_note_create(uuid, uuid, text, text),
 public.client_note_save(uuid, text, text, integer), public.client_note_restore(uuid, integer, integer),
 public.client_note_versions(uuid), public.client_note_version(uuid, integer), public.client_note_delete(uuid),
 public.client_note_undelete(uuid), public.client_note_secret_create(uuid, uuid, text, text),
 public.client_note_secret_open(uuid, uuid, text), public.client_note_secret_log(uuid) to authenticated;

-- ------------------------------------------------------------ na tela de todos
create function mavi_private.broadcast_client_note() returns trigger
language plpgsql security definer set search_path = '' as $$
declare r record; begin
 r := coalesce(new, old);
 perform mavi_private.broadcast(r.company_id, jsonb_build_object('kind', 'client_notes', 'client', r.client_id,
  'note', r.id, 'version', r.version));
 return null;
end $$;
revoke all on function mavi_private.broadcast_client_note() from public, anon, authenticated;
create trigger broadcast_client_note after insert or update or delete on public.client_notes
 for each row execute function mavi_private.broadcast_client_note();

-- ------------------------------------------------------------ MAVI
alter table public.ai_documents drop constraint ai_documents_source_type_check;
alter table public.ai_documents add constraint ai_documents_source_type_check
 check (source_type in ('meeting', 'task', 'drive_file', 'social_plan', 'social_briefing', 'campaign',
  'success_case', 'whatsapp', 'ai_attachment', 'client_note'));

-- Quem vê o cliente acha a anotação (acesso 'client', sempre com o cliente).
create function mavi_private.ai_build_client_note(p_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare r record; v_text text; v_pieces jsonb := '[]'; piece text; begin
 select n.*, k.name as client_name into r from public.client_notes n
  join public.clients k on k.company_id = n.company_id and k.id = n.client_id
  where n.id = p_id;
 if not found or r.deleted_at is not null then perform mavi_private.ai_forget('client_note', p_id); return; end if;
 v_text := mavi_private.client_note_plain(r.body);
 for piece in select mavi_private.ai_split(coalesce(nullif(v_text, ''), '(anotação sem texto)')) loop
  v_pieces := v_pieces || jsonb_build_array(jsonb_build_object('text', piece,
   'meta', jsonb_build_object('kind', 'client_note', 'version', r.version)));
 end loop;
 perform mavi_private.ai_save_document(r.company_id, 'client_note', r.id, 'client', r.client_id, null, null, null,
  r.title, r.updated_at,
  format('[Anotação do cliente] "%s" · cliente %s · atualizada em %s', r.title, r.client_name,
   to_char(r.updated_at at time zone 'America/Sao_Paulo', 'DD/MM/YYYY')),
  v_pieces);
end $$;
revoke all on function mavi_private.ai_build_client_note(uuid) from public, anon, authenticated;

create or replace function mavi_private.ai_build(p_type text, p_id uuid) returns void
language plpgsql security definer set search_path = '' as $$ begin
 if p_type = 'meeting' then perform mavi_private.ai_build_meeting(p_id);
 elsif p_type = 'task' then perform mavi_private.ai_build_task(p_id);
 elsif p_type = 'drive_file' then perform mavi_private.ai_build_drive_file(p_id);
 elsif p_type = 'social_plan' then perform mavi_private.ai_build_social_plan(p_id);
 elsif p_type = 'social_briefing' then perform mavi_private.ai_build_social_briefing(p_id);
 elsif p_type = 'campaign' then perform mavi_private.ai_build_campaign(p_id);
 elsif p_type = 'success_case' then perform mavi_private.case_index(p_id);
 elsif p_type = 'whatsapp' then perform mavi_private.ai_build_whatsapp(p_id);
 elsif p_type = 'client_note' then perform mavi_private.ai_build_client_note(p_id);
 end if;
end $$;
revoke all on function mavi_private.ai_build(text, uuid) from public, anon, authenticated;

create trigger ai_queue_client_notes_ins after insert on public.client_notes
 referencing new table as changed for each statement execute function mavi_private.ai_queue_rows('client_note', 'id');
create trigger ai_queue_client_notes_upd after update on public.client_notes
 referencing new table as changed for each statement execute function mavi_private.ai_queue_rows('client_note', 'id');
create trigger ai_queue_client_notes_del after delete on public.client_notes
 referencing old table as changed for each statement execute function mavi_private.ai_queue_rows('client_note', 'id');

-- As anotações também alimentam o Dossiê da MAVI do cliente.
create or replace function mavi_private.dossier_types() returns text[]
language sql immutable set search_path = '' as $$
 select array['meeting', 'whatsapp', 'task', 'drive_file', 'social_briefing', 'social_plan', 'campaign', 'client_note']
$$;

-- Para a conversa com a MAVI sobre o cliente: as anotações em texto (os
-- secretos só com o nome), as mais recentes primeiro.
create function public.client_notes_context(p_company uuid, p_client uuid, p_limit integer default 20)
returns jsonb language plpgsql stable security definer set search_path = '' as $$ begin
 if not mavi_private.client_note_reader(p_company, p_client) then return '[]'; end if;
 return coalesce((select jsonb_agg(jsonb_build_object('id', x.id, 'title', x.title, 'updated_at', x.updated_at,
   'updated_by_name', x.who, 'text', left(mavi_private.client_note_plain(x.body), 6000)) order by x.updated_at desc)
  from (select n.*, (select m.name from public.memberships m where m.company_id = n.company_id
    and m.user_id = n.updated_by) as who
   from public.client_notes n where n.company_id = p_company and n.client_id = p_client and n.deleted_at is null
   order by n.updated_at desc limit least(greatest(coalesce(p_limit, 20), 1), 50)) x), '[]');
end $$;
revoke all on function public.client_notes_context(uuid, uuid, integer) from public, anon;
grant execute on function public.client_notes_context(uuid, uuid, integer) to authenticated;

commit;
