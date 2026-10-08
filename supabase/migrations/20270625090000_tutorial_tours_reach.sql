begin;

-- Onboarding, Fase 2: mais público, onde aparece e duas escolhas por passo.
--
-- - Público: além de papéis, equipes e pessoas, squads (cs_squad_members) e
--   quem atende clientes (equipes do cliente, client_teams) ou produtos
--   (equipes do produto, product_teams). Recalculado a cada leitura.
-- - Onde aparece (opcional): só nas telas de certos clientes ou produtos. A
--   tela manda o que sabe dela (cliente, produto, contrato, campanha, tarefa)
--   e o banco descobre o cliente e o produto. Sem tela (a lista da aba
--   Onboarding), aparece sempre.
-- - Por passo: `record` ('any': qualquer registro do mesmo tipo, a 1ª linha
--   no lugar da gravada; 'same': o registro gravado) e `real` (false: o
--   clique no botão é só mostrado, não chega ao sistema).

alter table public.tutorial_tours
 add column aud_squads uuid[] not null default '{}',
 add column aud_clients uuid[] not null default '{}',
 add column aud_products uuid[] not null default '{}',
 add column scr_clients uuid[] not null default '{}',
 add column scr_products uuid[] not null default '{}';

-- ------------------------------------------------------------ público
create or replace function mavi_private.tour_for_me(t public.tutorial_tours) returns boolean
language sql stable security definer set search_path = '' as $$
 select t.status = 'published' and not (auth.uid() = any(t.aud_exclude)) and (
  t.aud_all or auth.uid() = any(t.aud_users)
  or exists (select 1 from public.memberships m
   where m.company_id = t.company_id and m.user_id = auth.uid() and m.role = any(t.aud_roles))
  or exists (select 1 from public.team_members tm
   where tm.company_id = t.company_id and tm.user_id = auth.uid() and tm.team_id = any(t.aud_teams))
  or exists (select 1 from public.cs_squad_members sm
   where sm.company_id = t.company_id and sm.user_id = auth.uid() and sm.squad_id = any(t.aud_squads))
  or exists (select 1 from public.team_members tm join public.client_teams ct
    on ct.company_id = tm.company_id and ct.team_id = tm.team_id
   where tm.company_id = t.company_id and tm.user_id = auth.uid() and ct.client_id = any(t.aud_clients))
  or exists (select 1 from public.team_members tm join public.product_teams pt
    on pt.company_id = tm.company_id and pt.team_id = tm.team_id
   where tm.company_id = t.company_id and tm.user_id = auth.uid() and pt.product_id = any(t.aud_products)))
$$;

-- O cliente e o produto da tela, pelo que ela sabe de si:
-- {clients, products, contracts, campaign, task} (ids; os de fora somem).
create function mavi_private.tour_screen(c uuid, p jsonb, out clients uuid[], out products uuid[])
language plpgsql stable security definer set search_path = '' as $$
declare ids text[]; v_contracts uuid[]; begin
 clients := '{}';
 products := '{}';
 if p is null or jsonb_typeof(p) <> 'object' then return; end if;
 ids := array(select jsonb_array_elements_text(case when jsonb_typeof(p->'clients') = 'array' then p->'clients' else '[]' end));
 clients := array(select k.id from public.clients k where k.company_id = c and k.id::text = any(ids[1:20]));
 ids := array(select jsonb_array_elements_text(case when jsonb_typeof(p->'products') = 'array' then p->'products' else '[]' end));
 products := array(select k.id from public.products k where k.company_id = c and k.id::text = any(ids[1:20]));
 ids := array(select jsonb_array_elements_text(case when jsonb_typeof(p->'contracts') = 'array' then p->'contracts' else '[]' end));
 v_contracts := array(select k.id from public.contracts k where k.company_id = c and k.id::text = any(ids[1:20]));
 if coalesce(p->>'campaign', '') ~ '^[0-9a-f-]{36}$' then
  v_contracts := v_contracts || array(select a.contract_id from public.ad_campaigns a
   where a.company_id = c and a.id = (p->>'campaign')::uuid);
 end if;
 if coalesce(p->>'task', '') ~ '^[0-9a-f-]{36}$' then
  v_contracts := v_contracts || array(select x.contract_id from public.tasks x
   where x.company_id = c and x.id = (p->>'task')::uuid and x.contract_id is not null);
 end if;
 if cardinality(v_contracts) > 0 then
  clients := clients || array(select k.client_id from public.contracts k where k.company_id = c and k.id = any(v_contracts));
  products := products || array(select k.product_id from public.contracts k where k.company_id = c and k.id = any(v_contracts));
 end if;
end $$;
revoke all on function mavi_private.tour_screen(uuid, jsonb) from public, anon, authenticated;

-- ------------------------------------------------------------ conteúdo
create or replace function mavi_private.tour_steps_clean(p jsonb) returns jsonb
language plpgsql stable set search_path = '' as $$
declare s jsonb; n integer := 0; ids text[] := '{}'; v_id text; v_kind text; v_place text; v_page text; v_url text;
 v_title text; v_body text; v_target jsonb; v_record text; v_real boolean; result jsonb := '[]'; begin
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
  v_record := case when s->>'record' = 'same' then 'same' else 'any' end;
  -- Só um clique esperado pode ficar "só mostrado"; o tour que clica, clica.
  v_real := case when v_kind = 'click' then coalesce((s->>'real')::boolean, true) else true end;
  result := result || jsonb_build_array(jsonb_build_object('id', v_id, 'kind', v_kind, 'placement', v_place,
   'page', v_page, 'url', v_url, 'title', v_title, 'body', v_body, 'target', v_target, 'record', v_record,
   'real', v_real));
 end loop;
 return result;
end $$;

-- Ids de uma lista que existem na empresa (tabela com company_id e id).
create function mavi_private.tour_ids(c uuid, p jsonb, p_table text) returns uuid[]
language plpgsql stable security definer set search_path = '' as $$
declare ids text[]; result uuid[]; begin
 ids := array(select jsonb_array_elements_text(case when jsonb_typeof(p) = 'array' then p else '[]' end));
 if cardinality(ids) = 0 then return '{}'; end if;
 if cardinality(ids) > 200 then raise exception 'Escolha até 200 itens por lista.' using errcode = '22023'; end if;
 execute format('select coalesce(array_agg(x.id order by x.id), ''{}'') from public.%I x where x.company_id = $1 and x.id::text = any($2)',
  p_table) into result using c, ids;
 return result;
end $$;
revoke all on function mavi_private.tour_ids(uuid, jsonb, text) from public, anon, authenticated;

create or replace function mavi_private.tour_clean(c uuid, p jsonb) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_title text; v_summary text; v_steps jsonb; v_modules text[]; v_all boolean; v_roles text[]; v_teams uuid[];
 v_users uuid[]; v_exclude uuid[]; v_squads uuid[]; v_clients uuid[]; v_products uuid[]; v_scr_clients uuid[];
 v_scr_products uuid[]; x text; begin
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
 v_teams := mavi_private.tour_ids(c, p->'aud_teams', 'teams');
 v_squads := mavi_private.tour_ids(c, p->'aud_squads', 'cs_squads');
 v_clients := mavi_private.tour_ids(c, p->'aud_clients', 'clients');
 v_products := mavi_private.tour_ids(c, p->'aud_products', 'products');
 v_scr_clients := mavi_private.tour_ids(c, p->'scr_clients', 'clients');
 v_scr_products := mavi_private.tour_ids(c, p->'scr_products', 'products');
 v_users := array(select m.user_id from public.memberships m where m.company_id = c and m.user_id::text in (
  select jsonb_array_elements_text(case when jsonb_typeof(p->'aud_users') = 'array' then p->'aud_users' else '[]' end))
  order by m.user_id);
 v_exclude := array(select m.user_id from public.memberships m where m.company_id = c and m.user_id::text in (
  select jsonb_array_elements_text(case when jsonb_typeof(p->'aud_exclude') = 'array' then p->'aud_exclude' else '[]' end))
  order by m.user_id);
 if not v_all and cardinality(v_roles) + cardinality(v_teams) + cardinality(v_users) + cardinality(v_squads)
  + cardinality(v_clients) + cardinality(v_products) = 0 then
  raise exception 'Escolha quem recebe o onboarding: todos, papéis, equipes, squads, clientes, produtos ou pessoas.'
   using errcode = '22023';
 end if;
 if v_all then v_roles := '{}'; v_teams := '{}'; v_users := '{}'; v_squads := '{}'; v_clients := '{}'; v_products := '{}'; end if;

 return jsonb_build_object('title', v_title, 'summary', v_summary, 'steps', v_steps, 'modules', to_jsonb(v_modules),
  'aud_all', v_all, 'aud_roles', to_jsonb(v_roles), 'aud_teams', to_jsonb(v_teams), 'aud_users', to_jsonb(v_users),
  'aud_exclude', to_jsonb(v_exclude), 'aud_squads', to_jsonb(v_squads), 'aud_clients', to_jsonb(v_clients),
  'aud_products', to_jsonb(v_products), 'scr_clients', to_jsonb(v_scr_clients), 'scr_products', to_jsonb(v_scr_products));
end $$;

create or replace function mavi_private.tour_content(t public.tutorial_tours) returns jsonb
language sql stable set search_path = '' as $$
 select jsonb_build_object('title', t.title, 'summary', t.summary, 'steps', t.steps, 'modules', to_jsonb(t.modules),
  'aud_all', t.aud_all, 'aud_roles', to_jsonb(t.aud_roles), 'aud_teams', to_jsonb(t.aud_teams),
  'aud_users', to_jsonb(t.aud_users), 'aud_exclude', to_jsonb(t.aud_exclude), 'aud_squads', to_jsonb(t.aud_squads),
  'aud_clients', to_jsonb(t.aud_clients), 'aud_products', to_jsonb(t.aud_products),
  'scr_clients', to_jsonb(t.scr_clients), 'scr_products', to_jsonb(t.scr_products))
$$;

create or replace function mavi_private.tour_apply(p_id uuid, v jsonb) returns void
language sql security definer set search_path = '' as $$
 update public.tutorial_tours set title = v->>'title', summary = v->>'summary', steps = v->'steps',
  modules = array(select jsonb_array_elements_text(v->'modules')),
  start_page = coalesce(v->'steps'->0->>'page', ''),
  aud_all = (v->>'aud_all')::boolean,
  aud_roles = array(select jsonb_array_elements_text(v->'aud_roles')),
  aud_teams = array(select jsonb_array_elements_text(v->'aud_teams'))::uuid[],
  aud_users = array(select jsonb_array_elements_text(v->'aud_users'))::uuid[],
  aud_exclude = array(select jsonb_array_elements_text(v->'aud_exclude'))::uuid[],
  aud_squads = array(select jsonb_array_elements_text(coalesce(v->'aud_squads', '[]')))::uuid[],
  aud_clients = array(select jsonb_array_elements_text(coalesce(v->'aud_clients', '[]')))::uuid[],
  aud_products = array(select jsonb_array_elements_text(coalesce(v->'aud_products', '[]')))::uuid[],
  scr_clients = array(select jsonb_array_elements_text(coalesce(v->'scr_clients', '[]')))::uuid[],
  scr_products = array(select jsonb_array_elements_text(coalesce(v->'scr_products', '[]')))::uuid[],
  updated_by = auth.uid(), updated_at = now(), revision = revision + 1
 where id = p_id
$$;

-- ------------------------------------------------------------ ler
-- p_context: a tela de onde se pergunta (o "?"). Os onboardings "só nas
-- telas de" aparecem só quando ela é de um dos clientes ou produtos; sem
-- p_context (a aba Onboarding), aparecem sempre.
drop function public.list_tutorial_tours(uuid, text, text, text);
create function public.list_tutorial_tours(p_company uuid, p_scope text default 'library', p_module text default null,
 p_page text default null, p_context jsonb default null)
returns table(id uuid, title text, summary text, modules text[], start_page text, step_count integer, status text,
 version integer, has_draft boolean, aud_all boolean, created_by uuid, author_name text, updated_at timestamptz,
 published_at timestamptz, can_edit boolean, my_status text, my_step integer, misses integer, screen_only boolean)
language plpgsql stable security definer set search_path = '' as $$
declare scr record; begin
 if not mavi_private.member(p_company) then raise exception 'Sem acesso ao espaço' using errcode = '42501'; end if;
 if p_scope = 'admin' and not mavi_private.leader(p_company) then return; end if;
 select * into scr from mavi_private.tour_screen(p_company, p_context);
 return query
 with base as (
  select t.*, mavi_private.tour_can_edit(t) as editor, mavi_private.tour_for_me(t) as for_me
  from public.tutorial_tours t
  where t.company_id = p_company
   and ((coalesce(p_module, '') = '' and coalesce(p_page, '') = '')
    or (coalesce(p_module, '') <> '' and p_module = any(t.modules))
    or (coalesce(p_page, '') <> '' and t.start_page = p_page))
   and (p_context is null or p_scope = 'admin'
    or (cardinality(t.scr_clients) = 0 and cardinality(t.scr_products) = 0)
    or t.scr_clients && scr.clients or t.scr_products && scr.products))
 select b.id, b.title, b.summary, b.modules, b.start_page, jsonb_array_length(b.steps), b.status, b.version,
  b.editor and exists (select 1 from public.tutorial_tour_drafts d where d.tour_id = b.id),
  b.aud_all, b.created_by, mavi_private.member_name(p_company, b.created_by),
  b.updated_at, b.published_at, b.editor, pr.status, pr.step,
  case when b.editor then (select coalesce(sum(m.misses), 0)::integer from public.tutorial_tour_misses m
   where m.tour_id = b.id and m.version = b.version) else 0 end,
  cardinality(b.scr_clients) + cardinality(b.scr_products) > 0
 from base b
 left join public.tutorial_tour_progress pr on pr.tour_id = b.id and pr.user_id = auth.uid()
 where b.for_me or (p_scope = 'admin' and b.editor)
 order by
  case when p_scope = 'library' then (pr.status = 'completed') end nulls first,
  case when p_scope = 'admin' then b.updated_at end desc nulls last,
  b.published_at desc nulls last, b.title, b.id
 limit 200;
end $$;
revoke all on function public.list_tutorial_tours(uuid, text, text, text, jsonb) from public, anon, authenticated;
grant execute on function public.list_tutorial_tours(uuid, text, text, text, jsonb) to authenticated;

create or replace function public.tutorial_tour_detail(p_tour uuid) returns jsonb
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
   'aud_teams', to_jsonb(t.aud_teams), 'aud_users', to_jsonb(t.aud_users), 'aud_exclude', to_jsonb(t.aud_exclude),
   'aud_squads', to_jsonb(t.aud_squads), 'aud_clients', to_jsonb(t.aud_clients),
   'aud_products', to_jsonb(t.aud_products), 'scr_clients', to_jsonb(t.scr_clients),
   'scr_products', to_jsonb(t.scr_products)) end,
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

-- Os avisos ao vivo também quando muda o público novo.
drop trigger broadcast_tutorial_tour on public.tutorial_tours;
create trigger broadcast_tutorial_tour after insert or delete or update of title, summary, steps, modules,
 aud_all, aud_roles, aud_teams, aud_users, aud_exclude, aud_squads, aud_clients, aud_products, scr_clients,
 scr_products, status, version on public.tutorial_tours
 for each row execute function mavi_private.broadcast_tutorial_tour();

commit;
