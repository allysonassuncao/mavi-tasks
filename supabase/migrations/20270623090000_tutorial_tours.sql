begin;

-- Onboarding (Tutoriais › Onboarding): tours guiados por cima das telas do
-- sistema. Quem cria navega pelo sistema, escolhe elementos (botão, tabela,
-- campo, modal…) e escreve um balão para cada passo; quem recebe segue o
-- passo a passo na tela de verdade.
--
-- - Quem cria: administradores e gestores. Administradores editam todos;
--   gestores, só os que criaram (a mesma regra dos tutoriais).
-- - Os passos ficam numa lista (steps, jsonb): a tela (página e endereço), o
--   elemento (as "impressões digitais" que o navegador usa para achá-lo de
--   novo; nulo = balão no centro), o texto do balão e o tipo do passo
--   (próximo, esperar o clique, esperar preencher, o tour clica sozinho).
-- - Rascunho → publicado com versões, como nos tutoriais: num publicado, a
--   alteração fica à parte (tutorial_tour_drafts) até publicar de novo.
-- - Público: o mesmo dos tutoriais (todos, papéis, equipes, pessoas, menos
--   as excluídas). Fase 2: squads, clientes e produtos.
-- - Progresso por pessoa (continuar de onde parou) e os passos que não
--   acharam o elemento na tela de quem recebe (tutorial_tour_misses).
-- - Tudo passa por funções: as tabelas não têm leitura direta.

-- ------------------------------------------------------------ tabelas
create table public.tutorial_tours (
 id uuid primary key default gen_random_uuid(),
 company_id uuid not null references public.companies(id),
 title text not null check (length(btrim(title)) between 3 and 160),
 summary text not null default '' check (length(summary) <= 600),
 steps jsonb not null default '[]' check (jsonb_typeof(steps) = 'array'),
 -- Os módulos das telas por onde passa (o "?" de cada tela mostra os seus).
 modules text[] not null default '{}',
 -- A página do primeiro passo (id do app: tasks, campaigns…).
 start_page text not null default '',
 aud_all boolean not null default true,
 aud_roles text[] not null default '{}' check (aud_roles <@ array['admin', 'manager', 'member']::text[]),
 aud_teams uuid[] not null default '{}',
 aud_users uuid[] not null default '{}',
 aud_exclude uuid[] not null default '{}',
 status text not null default 'draft' check (status in ('draft', 'published')),
 version integer not null default 0,
 revision integer not null default 1,
 published_at timestamptz,
 published_by uuid,
 created_by uuid not null,
 created_at timestamptz not null default now(),
 updated_by uuid not null,
 updated_at timestamptz not null default now(),
 unique(company_id, id),
 foreign key(company_id, created_by) references public.memberships(company_id, user_id)
);
create index tutorial_tours_list on public.tutorial_tours(company_id, status, published_at desc);
create index tutorial_tours_modules on public.tutorial_tours using gin(modules);
alter table public.tutorial_tours enable row level security;
revoke all on public.tutorial_tours from public, anon, authenticated;

create table public.tutorial_tour_drafts (
 tour_id uuid primary key,
 company_id uuid not null,
 content jsonb not null check (jsonb_typeof(content) = 'object'),
 saved_by uuid not null,
 saved_at timestamptz not null default now(),
 foreign key(company_id, tour_id) references public.tutorial_tours(company_id, id) on delete cascade
);
alter table public.tutorial_tour_drafts enable row level security;
revoke all on public.tutorial_tour_drafts from public, anon, authenticated;

create table public.tutorial_tour_versions (
 company_id uuid not null,
 tour_id uuid not null,
 version integer not null check (version > 0),
 content jsonb not null check (jsonb_typeof(content) = 'object'),
 published_by uuid not null,
 published_at timestamptz not null default now(),
 primary key(tour_id, version),
 foreign key(company_id, tour_id) references public.tutorial_tours(company_id, id) on delete cascade
);
alter table public.tutorial_tour_versions enable row level security;
revoke all on public.tutorial_tour_versions from public, anon, authenticated;

-- Onde cada pessoa está: em andamento (passo atual), concluído ou fechado
-- antes do fim (dá para continuar de onde parou).
create table public.tutorial_tour_progress (
 company_id uuid not null,
 tour_id uuid not null,
 user_id uuid not null,
 version integer not null,
 status text not null check (status in ('started', 'completed', 'dismissed')),
 step integer not null default 0 check (step >= 0),
 step_id text not null default '',
 started_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 completed_at timestamptz,
 times_completed integer not null default 0,
 primary key(tour_id, user_id),
 foreign key(company_id, tour_id) references public.tutorial_tours(company_id, id) on delete cascade
);
create index tutorial_tour_progress_user on public.tutorial_tour_progress(company_id, user_id);
alter table public.tutorial_tour_progress enable row level security;
revoke all on public.tutorial_tour_progress from public, anon, authenticated;

-- Passos cujo elemento não apareceu na tela de quem recebe (por versão).
create table public.tutorial_tour_misses (
 company_id uuid not null,
 tour_id uuid not null,
 version integer not null,
 step_id text not null,
 misses integer not null default 0,
 people uuid[] not null default '{}',
 last_path text not null default '',
 last_at timestamptz not null default now(),
 primary key(tour_id, version, step_id),
 foreign key(company_id, tour_id) references public.tutorial_tours(company_id, id) on delete cascade
);
alter table public.tutorial_tour_misses enable row level security;
revoke all on public.tutorial_tour_misses from public, anon, authenticated;

-- ------------------------------------------------------------ regras
create function mavi_private.tour_can_edit(t public.tutorial_tours) returns boolean
language sql stable security definer set search_path = '' as $$
 select mavi_private.admin(t.company_id) or (t.created_by = auth.uid() and mavi_private.leader(t.company_id))
$$;

create function mavi_private.tour_for_me(t public.tutorial_tours) returns boolean
language sql stable security definer set search_path = '' as $$
 select t.status = 'published' and not (auth.uid() = any(t.aud_exclude)) and (
  t.aud_all or auth.uid() = any(t.aud_users)
  or exists (select 1 from public.memberships m
   where m.company_id = t.company_id and m.user_id = auth.uid() and m.role = any(t.aud_roles))
  or exists (select 1 from public.team_members tm
   where tm.company_id = t.company_id and tm.user_id = auth.uid() and tm.team_id = any(t.aud_teams)))
$$;

create function mavi_private.tour_can_see(t public.tutorial_tours) returns boolean
language sql stable security definer set search_path = '' as $$
 select mavi_private.member(t.company_id) and (mavi_private.tour_can_edit(t) or mavi_private.tour_for_me(t))
$$;
revoke all on function mavi_private.tour_can_edit(public.tutorial_tours), mavi_private.tour_for_me(public.tutorial_tours),
 mavi_private.tour_can_see(public.tutorial_tours) from public, anon, authenticated;

-- Os passos, limpos e conferidos. Cada passo guarda só as chaves conhecidas.
create function mavi_private.tour_steps_clean(p jsonb) returns jsonb
language plpgsql stable set search_path = '' as $$
declare s jsonb; n integer := 0; ids text[] := '{}'; v_id text; v_kind text; v_place text; v_page text; v_url text;
 v_title text; v_body text; v_target jsonb; result jsonb := '[]'; begin
 if p is null or jsonb_typeof(p) <> 'array' then return '[]'; end if;
 if jsonb_array_length(p) > 60 then raise exception 'Um onboarding pode ter até 60 passos.' using errcode = '22023'; end if;
 for s in select x from jsonb_array_elements(p) x loop
  n := n + 1;
  if jsonb_typeof(s) <> 'object' then raise exception 'Passo % inválido', n using errcode = '22023'; end if;
  v_id := coalesce(s->>'id', '');
  if v_id !~ '^[a-z0-9]{6,24}$' or v_id = any(ids) then raise exception 'Passo % sem identificador válido', n using errcode = '22023'; end if;
  ids := ids || v_id;
  v_kind := coalesce(s->>'kind', 'next');
  if v_kind not in ('next', 'click', 'input', 'auto') then raise exception 'Tipo do passo % inválido', n using errcode = '22023'; end if;
  v_place := coalesce(s->>'placement', 'auto');
  if v_place not in ('auto', 'top', 'bottom', 'left', 'right') then v_place := 'auto'; end if;
  v_page := coalesce(s->>'page', '');
  if v_page !~ '^[a-zA-Z]{2,40}$' then raise exception 'O passo % não tem a tela onde aparece.', n using errcode = '22023'; end if;
  v_url := coalesce(s->>'url', '');
  if v_url !~ '^/' or v_url ~ '^//' or v_url ~ '[\\\r\n]' or length(v_url) > 600 then
   raise exception 'Endereço do passo % inválido', n using errcode = '22023';
  end if;
  v_title := regexp_replace(btrim(coalesce(s->>'title', '')), '\s+', ' ', 'g');
  if length(v_title) > 120 then raise exception 'O título do passo % pode ter até 120 caracteres.', n using errcode = '22023'; end if;
  v_body := coalesce(s->>'body', '');
  if length(v_body) > 60000 then raise exception 'O texto do passo % está grande demais.', n using errcode = '22023'; end if;
  v_target := s->'target';
  if v_target is not null and jsonb_typeof(v_target) = 'null' then v_target := null; end if;
  if v_target is not null and (jsonb_typeof(v_target) <> 'object' or length(v_target::text) > 8000) then
   raise exception 'Elemento do passo % inválido', n using errcode = '22023';
  end if;
  if v_target is null and v_kind <> 'next' then
   raise exception 'O passo % precisa de um elemento na tela para esse tipo.', n using errcode = '22023';
  end if;
  if v_title = '' and mavi_private.rich_plain(v_body) ~ '^\s*$' and v_kind <> 'auto' then
   raise exception 'Escreva o texto do balão do passo %.', n using errcode = '22023';
  end if;
  result := result || jsonb_build_array(jsonb_build_object('id', v_id, 'kind', v_kind, 'placement', v_place,
   'page', v_page, 'url', v_url, 'title', v_title, 'body', v_body, 'target', v_target));
 end loop;
 return result;
end $$;

-- O conteúdo que a pessoa enviou, limpo e conferido.
create function mavi_private.tour_clean(c uuid, p jsonb) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_title text; v_summary text; v_steps jsonb; v_modules text[]; v_all boolean; v_roles text[]; v_teams uuid[];
 v_users uuid[]; v_exclude uuid[]; x text; begin
 if jsonb_typeof(p) <> 'object' then raise exception 'Conteúdo inválido' using errcode = '22023'; end if;
 v_title := regexp_replace(btrim(coalesce(p->>'title', '')), '\s+', ' ', 'g');
 if length(v_title) < 3 or length(v_title) > 160 then
  raise exception 'Dê um nome de 3 a 160 caracteres ao onboarding.' using errcode = '22023';
 end if;
 v_summary := btrim(coalesce(p->>'summary', ''));
 if length(v_summary) > 600 then raise exception 'O resumo pode ter até 600 caracteres.' using errcode = '22023'; end if;
 v_steps := mavi_private.tour_steps_clean(p->'steps');
 if length(v_steps::text) > 900000 then raise exception 'O onboarding está grande demais. Divida em mais de um.' using errcode = '22023'; end if;

 v_modules := '{}';
 for x in select distinct jsonb_array_elements_text(case when jsonb_typeof(p->'modules') = 'array' then p->'modules' else '[]' end) loop
  if x !~ '^[a-zA-Z]{2,40}$' then raise exception 'Módulo inválido: %', left(x, 40) using errcode = '22023'; end if;
  v_modules := v_modules || x;
 end loop;
 v_modules := array(select m from unnest(v_modules) m order by m limit 20);

 v_all := coalesce((p->>'aud_all')::boolean, true);
 v_roles := array(select distinct r from jsonb_array_elements_text(
  case when jsonb_typeof(p->'aud_roles') = 'array' then p->'aud_roles' else '[]' end) r
  where r in ('admin', 'manager', 'member') order by r);
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
  raise exception 'Escolha quem recebe o onboarding: todos, papéis, equipes ou pessoas.' using errcode = '22023';
 end if;
 if v_all then v_roles := '{}'; v_teams := '{}'; v_users := '{}'; end if;

 return jsonb_build_object('title', v_title, 'summary', v_summary, 'steps', v_steps, 'modules', to_jsonb(v_modules),
  'aud_all', v_all, 'aud_roles', to_jsonb(v_roles), 'aud_teams', to_jsonb(v_teams), 'aud_users', to_jsonb(v_users),
  'aud_exclude', to_jsonb(v_exclude));
end $$;

create function mavi_private.tour_content(t public.tutorial_tours) returns jsonb
language sql stable set search_path = '' as $$
 select jsonb_build_object('title', t.title, 'summary', t.summary, 'steps', t.steps, 'modules', to_jsonb(t.modules),
  'aud_all', t.aud_all, 'aud_roles', to_jsonb(t.aud_roles), 'aud_teams', to_jsonb(t.aud_teams),
  'aud_users', to_jsonb(t.aud_users), 'aud_exclude', to_jsonb(t.aud_exclude))
$$;

create function mavi_private.tour_apply(p_id uuid, v jsonb) returns void
language sql security definer set search_path = '' as $$
 update public.tutorial_tours set title = v->>'title', summary = v->>'summary', steps = v->'steps',
  modules = array(select jsonb_array_elements_text(v->'modules')),
  start_page = coalesce(v->'steps'->0->>'page', ''),
  aud_all = (v->>'aud_all')::boolean,
  aud_roles = array(select jsonb_array_elements_text(v->'aud_roles')),
  aud_teams = array(select jsonb_array_elements_text(v->'aud_teams'))::uuid[],
  aud_users = array(select jsonb_array_elements_text(v->'aud_users'))::uuid[],
  aud_exclude = array(select jsonb_array_elements_text(v->'aud_exclude'))::uuid[],
  updated_by = auth.uid(), updated_at = now(), revision = revision + 1
 where id = p_id
$$;

create function mavi_private.tour_publish(p_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare t public.tutorial_tours; begin
 select * into t from public.tutorial_tours where id = p_id;
 if jsonb_array_length(t.steps) = 0 then
  raise exception 'Adicione ao menos um passo antes de publicar.' using errcode = '22023';
 end if;
 update public.tutorial_tours set status = 'published', version = version + 1, published_at = now(), published_by = auth.uid()
 where id = p_id returning * into t;
 insert into public.tutorial_tour_versions(company_id, tour_id, version, content, published_by)
 values (t.company_id, t.id, t.version, mavi_private.tour_content(t), auth.uid());
 delete from public.tutorial_tour_drafts where tour_id = t.id;
end $$;
revoke all on function mavi_private.tour_steps_clean(jsonb), mavi_private.tour_clean(uuid, jsonb),
 mavi_private.tour_content(public.tutorial_tours), mavi_private.tour_apply(uuid, jsonb), mavi_private.tour_publish(uuid)
 from public, anon, authenticated;

-- ------------------------------------------------------------ salvar
-- Cria ou salva. Sem publicar, um onboarding no ar guarda a alteração à
-- parte e continua como estava. Devolve {id, mode, status, version, revision}.
create function public.save_tutorial_tour(p_company uuid, p_tour uuid, p_content jsonb, p_publish boolean default false,
 p_revision integer default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare t public.tutorial_tours; v jsonb; v_mode text; begin
 if not mavi_private.leader(p_company) then
  raise exception 'Só administradores e gestores criam onboardings.' using errcode = '42501';
 end if;
 v := mavi_private.tour_clean(p_company, p_content);

 if p_tour is null then
  insert into public.tutorial_tours(company_id, title, created_by, updated_by)
  values (p_company, v->>'title', auth.uid(), auth.uid()) returning * into t;
  perform mavi_private.tour_apply(t.id, v);
  update public.tutorial_tours set revision = 1 where id = t.id;
  if p_publish then perform mavi_private.tour_publish(t.id); end if;
  select * into t from public.tutorial_tours where id = t.id;
  return jsonb_build_object('id', t.id, 'mode', case when p_publish then 'published' else 'created' end,
   'status', t.status, 'version', t.version, 'revision', t.revision);
 end if;

 select * into t from public.tutorial_tours where id = p_tour and company_id = p_company for update;
 if not found or not mavi_private.tour_can_edit(t) then
  raise exception 'Só um administrador ou o gestor que criou o onboarding pode editá-lo.' using errcode = '42501';
 end if;
 if p_revision is not null and p_revision <> t.revision then
  raise exception 'Este onboarding foi alterado por outra pessoa. Abra de novo para ver a versão atual.' using errcode = '40001';
 end if;

 if t.status = 'published' and not p_publish then
  insert into public.tutorial_tour_drafts(tour_id, company_id, content, saved_by)
  values (t.id, t.company_id, v, auth.uid())
  on conflict (tour_id) do update set content = excluded.content, saved_by = excluded.saved_by, saved_at = now();
  update public.tutorial_tours set revision = revision + 1 where id = t.id returning * into t;
  v_mode := 'draft';
 else
  perform mavi_private.tour_apply(t.id, v);
  if p_publish then perform mavi_private.tour_publish(t.id); end if;
  select * into t from public.tutorial_tours where id = t.id;
  v_mode := case when p_publish then 'published' else 'saved' end;
 end if;
 return jsonb_build_object('id', t.id, 'mode', v_mode, 'status', t.status, 'version', t.version, 'revision', t.revision);
end $$;

create function public.discard_tutorial_tour_draft(p_tour uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare t public.tutorial_tours; begin
 select * into t from public.tutorial_tours where id = p_tour for update;
 if not found or not mavi_private.tour_can_edit(t) then raise exception 'Sem permissão' using errcode = '42501'; end if;
 delete from public.tutorial_tour_drafts where tour_id = t.id;
 update public.tutorial_tours set revision = revision + 1 where id = t.id;
end $$;

-- Tira do ar (volta a rascunho; versões e progresso ficam).
create function public.unpublish_tutorial_tour(p_tour uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare t public.tutorial_tours; v jsonb; begin
 select * into t from public.tutorial_tours where id = p_tour for update;
 if not found or not mavi_private.tour_can_edit(t) then raise exception 'Sem permissão' using errcode = '42501'; end if;
 if t.status <> 'published' then return; end if;
 select content into v from public.tutorial_tour_drafts where tour_id = t.id;
 if v is not null then
  perform mavi_private.tour_apply(t.id, mavi_private.tour_clean(t.company_id, v));
  delete from public.tutorial_tour_drafts where tour_id = t.id;
 end if;
 update public.tutorial_tours set status = 'draft', revision = revision + 1 where id = t.id;
end $$;

create function public.delete_tutorial_tour(p_tour uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare t public.tutorial_tours; begin
 select * into t from public.tutorial_tours where id = p_tour for update;
 if not found or not mavi_private.tour_can_edit(t) then
  raise exception 'Só um administrador ou o gestor que criou o onboarding pode apagá-lo.' using errcode = '42501';
 end if;
 delete from public.tutorial_tours where id = t.id;
end $$;

-- ------------------------------------------------------------ ler
-- 'library': os publicados que a pessoa recebe, com o progresso dela.
-- 'admin' (líderes): administradores veem todos; gestores, os seus e os
-- publicados que recebem. p_module/p_page filtram (o "?" de cada tela).
create function public.list_tutorial_tours(p_company uuid, p_scope text default 'library', p_module text default null,
 p_page text default null)
returns table(id uuid, title text, summary text, modules text[], start_page text, step_count integer, status text,
 version integer, has_draft boolean, aud_all boolean, created_by uuid, author_name text, updated_at timestamptz,
 published_at timestamptz, can_edit boolean, my_status text, my_step integer, misses integer)
language plpgsql stable security definer set search_path = '' as $$ begin
 if not mavi_private.member(p_company) then raise exception 'Sem acesso ao espaço' using errcode = '42501'; end if;
 if p_scope = 'admin' and not mavi_private.leader(p_company) then return; end if;
 return query
 with base as (
  select t.*, mavi_private.tour_can_edit(t) as editor, mavi_private.tour_for_me(t) as for_me
  from public.tutorial_tours t
  where t.company_id = p_company
   -- Sem filtro: todos. Com módulo e/ou página: os que passam pelo módulo
   -- ou começam na página.
   and ((coalesce(p_module, '') = '' and coalesce(p_page, '') = '')
    or (coalesce(p_module, '') <> '' and p_module = any(t.modules))
    or (coalesce(p_page, '') <> '' and t.start_page = p_page)))
 select b.id, b.title, b.summary, b.modules, b.start_page, jsonb_array_length(b.steps), b.status, b.version,
  b.editor and exists (select 1 from public.tutorial_tour_drafts d where d.tour_id = b.id),
  b.aud_all, b.created_by, mavi_private.member_name(p_company, b.created_by), b.updated_at, b.published_at, b.editor,
  pr.status, pr.step,
  case when b.editor then (select coalesce(sum(m.misses), 0)::integer from public.tutorial_tour_misses m
   where m.tour_id = b.id and m.version = b.version) else 0 end
 from base b
 left join public.tutorial_tour_progress pr on pr.tour_id = b.id and pr.user_id = auth.uid()
 where b.for_me or (p_scope = 'admin' and b.editor)
 order by
  -- Na biblioteca, o que a pessoa ainda não terminou vem antes.
  case when p_scope = 'library' then (pr.status = 'completed') end nulls first,
  case when p_scope = 'admin' then b.updated_at end desc nulls last,
  b.published_at desc nulls last, b.title, b.id
 limit 200;
end $$;

-- Um onboarding para tocar ou editar. Quem recebe vê o que está no ar; quem
-- edita vê também a alteração guardada, o público e os passos que falharam.
create function public.tutorial_tour_detail(p_tour uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare t public.tutorial_tours; d public.tutorial_tour_drafts; pr public.tutorial_tour_progress; v_edit boolean; begin
 select * into t from public.tutorial_tours where id = p_tour;
 if not found or not mavi_private.tour_can_see(t) then return null; end if;
 v_edit := mavi_private.tour_can_edit(t);
 if v_edit then select * into d from public.tutorial_tour_drafts where tour_id = t.id; end if;
 select * into pr from public.tutorial_tour_progress where tour_id = t.id and user_id = auth.uid();
 return jsonb_build_object(
  'id', t.id, 'company_id', t.company_id, 'title', t.title, 'summary', t.summary, 'steps', t.steps,
  'modules', to_jsonb(t.modules), 'start_page', t.start_page, 'status', t.status, 'version', t.version,
  'revision', t.revision,
  'audience', case when v_edit then jsonb_build_object('aud_all', t.aud_all, 'aud_roles', to_jsonb(t.aud_roles),
   'aud_teams', to_jsonb(t.aud_teams), 'aud_users', to_jsonb(t.aud_users), 'aud_exclude', to_jsonb(t.aud_exclude)) end,
  'created_by', t.created_by, 'author_name', mavi_private.member_name(t.company_id, t.created_by),
  'updated_at', t.updated_at, 'published_at', t.published_at,
  'draft', case when d.tour_id is not null then jsonb_build_object('content', d.content, 'saved_at', d.saved_at,
   'saved_by_name', mavi_private.member_name(t.company_id, d.saved_by)) end,
  'misses', case when v_edit then coalesce((select jsonb_agg(jsonb_build_object('step_id', m.step_id,
    'misses', m.misses, 'people', cardinality(m.people), 'last_path', m.last_path, 'last_at', m.last_at))
   from public.tutorial_tour_misses m where m.tour_id = t.id and m.version = t.version), '[]') end,
  'progress', case when pr.tour_id is not null then jsonb_build_object('status', pr.status, 'step', pr.step,
   'step_id', pr.step_id, 'version', pr.version, 'completed_at', pr.completed_at) end,
  'can_edit', v_edit);
end $$;

-- ------------------------------------------------------------ progresso
-- 'start' (do começo), 'step' (avançou), 'complete' (chegou ao fim) e
-- 'dismiss' (fechou antes do fim). Só conta para quem recebe o publicado.
create function public.set_tutorial_tour_progress(p_tour uuid, p_action text, p_step integer default 0,
 p_step_id text default '') returns jsonb
language plpgsql security definer set search_path = '' as $$
declare t public.tutorial_tours; pr public.tutorial_tour_progress; v_step integer; begin
 select * into t from public.tutorial_tours where id = p_tour;
 if not found or not mavi_private.member(t.company_id) or not mavi_private.tour_for_me(t) then return null; end if;
 if p_action not in ('start', 'step', 'complete', 'dismiss') then raise exception 'Ação inválida' using errcode = '22023'; end if;
 v_step := least(greatest(coalesce(p_step, 0), 0), greatest(jsonb_array_length(t.steps) - 1, 0));
 insert into public.tutorial_tour_progress as x(company_id, tour_id, user_id, version, status, step, step_id,
  completed_at, times_completed)
 values (t.company_id, t.id, auth.uid(), t.version,
  case p_action when 'complete' then 'completed' when 'dismiss' then 'dismissed' else 'started' end,
  case when p_action = 'start' then 0 else v_step end, left(coalesce(p_step_id, ''), 24),
  case when p_action = 'complete' then now() end, case when p_action = 'complete' then 1 else 0 end)
 on conflict (tour_id, user_id) do update set
  version = excluded.version,
  -- Quem já concluiu e só passeia de novo continua com o concluído.
  status = case when p_action = 'step' and x.status = 'completed' then 'completed' else excluded.status end,
  step = excluded.step, step_id = excluded.step_id,
  started_at = case when p_action = 'start' then now() else x.started_at end,
  completed_at = case when p_action = 'complete' then now() else x.completed_at end,
  times_completed = x.times_completed + case when p_action = 'complete' then 1 else 0 end,
  updated_at = now()
 returning * into pr;
 return jsonb_build_object('status', pr.status, 'step', pr.step, 'step_id', pr.step_id, 'version', pr.version,
  'completed_at', pr.completed_at);
end $$;

-- Um passo cujo elemento não apareceu na tela de quem recebe.
create function public.log_tutorial_tour_miss(p_tour uuid, p_step_id text, p_path text default '') returns void
language plpgsql security definer set search_path = '' as $$
declare t public.tutorial_tours; begin
 select * into t from public.tutorial_tours where id = p_tour;
 if not found or not mavi_private.member(t.company_id) or not mavi_private.tour_for_me(t) then return; end if;
 if not exists (select 1 from jsonb_array_elements(t.steps) s where s->>'id' = p_step_id) then return; end if;
 insert into public.tutorial_tour_misses as m(company_id, tour_id, version, step_id, misses, people, last_path)
 values (t.company_id, t.id, t.version, p_step_id, 1, array[auth.uid()], left(coalesce(p_path, ''), 600))
 on conflict (tour_id, version, step_id) do update set misses = m.misses + 1,
  people = case when auth.uid() = any(m.people) or cardinality(m.people) >= 500 then m.people else m.people || auth.uid() end,
  last_path = excluded.last_path, last_at = now();
end $$;

-- ------------------------------------------------------------ avisos ao vivo
-- Só o id: cada tela pergunta de novo o que pode ver.
create function mavi_private.broadcast_tutorial_tour() returns trigger
language plpgsql security definer set search_path = '' as $$
declare r record; begin
 r := coalesce(new, old);
 perform mavi_private.broadcast(r.company_id, jsonb_build_object('kind', 'tutorials',
  'tour', coalesce(to_jsonb(r)->>'tour_id', to_jsonb(r)->>'id')));
 return null;
end $$;
revoke all on function mavi_private.broadcast_tutorial_tour() from public, anon, authenticated;
create trigger broadcast_tutorial_tour after insert or delete or update of title, summary, steps, modules,
 aud_all, aud_roles, aud_teams, aud_users, aud_exclude, status, version on public.tutorial_tours
 for each row execute function mavi_private.broadcast_tutorial_tour();
create trigger broadcast_tutorial_tour_draft after insert or update or delete on public.tutorial_tour_drafts
 for each row execute function mavi_private.broadcast_tutorial_tour();

-- ------------------------------------------------------------ permissões
revoke all on function public.save_tutorial_tour(uuid, uuid, jsonb, boolean, integer),
 public.discard_tutorial_tour_draft(uuid), public.unpublish_tutorial_tour(uuid), public.delete_tutorial_tour(uuid),
 public.list_tutorial_tours(uuid, text, text, text), public.tutorial_tour_detail(uuid),
 public.set_tutorial_tour_progress(uuid, text, integer, text), public.log_tutorial_tour_miss(uuid, text, text)
 from public, anon, authenticated;
grant execute on function public.save_tutorial_tour(uuid, uuid, jsonb, boolean, integer),
 public.discard_tutorial_tour_draft(uuid), public.unpublish_tutorial_tour(uuid), public.delete_tutorial_tour(uuid),
 public.list_tutorial_tours(uuid, text, text, text), public.tutorial_tour_detail(uuid),
 public.set_tutorial_tour_progress(uuid, text, integer, text), public.log_tutorial_tour_miss(uuid, text, text)
 to authenticated;

commit;
