begin;

-- Onboarding, Fase 3: disparos automáticos, aviso de passo quebrado e
-- onboardings como itens das trilhas.
--
-- - Disparos (quem cria escolhe por onboarding; o "?" e a aba valem sempre):
--   trg_visit = começa sozinho na 1ª vez que a pessoa abre a tela onde ele
--   começa; trg_login = começa logo que a pessoa entra no sistema. Cada um
--   uma vez só por pessoa: qualquer progresso (começou, fechou, concluiu)
--   tira o onboarding da lista dos automáticos (my_auto_tutorial_tours).
-- - Passo quebrado: quando o elemento de um passo não aparece para quem
--   recebe, quem criou o onboarding recebe um aviso na caixa de entrada
--   ('tutorial'), com quantas vezes e quantas pessoas. De novo só depois de
--   7 dias (se continuar acontecendo) ou numa versão nova.
-- - Trilhas: a lista de itens da trilha continua uma lista de ids na ordem
--   ('tutorials' no conteúdo); cada id é um tutorial ou um onboarding (os ids
--   não se repetem entre as tabelas). Os onboardings ficam em
--   tutorial_trail_tours, com a posição na mesma numeração dos tutoriais, e
--   contam como concluídos quando a pessoa chega ao fim do tour. Como os
--   tutoriais, só contam os publicados que a pessoa recebe.

alter table public.tutorial_tours
 add column trg_visit boolean not null default false,
 add column trg_login boolean not null default false;
alter table public.tutorial_tour_misses add column notified_at timestamptz;

create table public.tutorial_trail_tours (
 company_id uuid not null,
 trail_id uuid not null,
 tour_id uuid not null,
 position integer not null check (position > 0),
 primary key(trail_id, tour_id),
 foreign key(company_id, trail_id) references public.tutorial_trails(company_id, id) on delete cascade,
 foreign key(company_id, tour_id) references public.tutorial_tours(company_id, id) on delete cascade
);
create index tutorial_trail_tours_tour on public.tutorial_trail_tours(company_id, tour_id);
alter table public.tutorial_trail_tours enable row level security;
revoke all on public.tutorial_trail_tours from public, anon, authenticated;

-- ------------------------------------------------------------ público
-- O público de uma pessoa qualquer (as trilhas contam por pessoa).
create function mavi_private.tour_for_user(t public.tutorial_tours, u uuid) returns boolean
language sql stable security definer set search_path = '' as $$
 select t.status = 'published' and u is not null and not (u = any(t.aud_exclude))
  and exists (select 1 from public.memberships m where m.company_id = t.company_id and m.user_id = u and m.active)
  and (
  t.aud_all or u = any(t.aud_users)
  or exists (select 1 from public.memberships m
   where m.company_id = t.company_id and m.user_id = u and m.role = any(t.aud_roles))
  or exists (select 1 from public.team_members tm
   where tm.company_id = t.company_id and tm.user_id = u and tm.team_id = any(t.aud_teams))
  or exists (select 1 from public.cs_squad_members sm
   where sm.company_id = t.company_id and sm.user_id = u and sm.squad_id = any(t.aud_squads))
  or exists (select 1 from public.team_members tm join public.client_teams ct
    on ct.company_id = tm.company_id and ct.team_id = tm.team_id
   where tm.company_id = t.company_id and tm.user_id = u and ct.client_id = any(t.aud_clients))
  or exists (select 1 from public.team_members tm join public.product_teams pt
    on pt.company_id = tm.company_id and pt.team_id = tm.team_id
   where tm.company_id = t.company_id and tm.user_id = u and pt.product_id = any(t.aud_products)))
$$;
revoke all on function mavi_private.tour_for_user(public.tutorial_tours, uuid) from public, anon, authenticated;

create or replace function mavi_private.tour_for_me(t public.tutorial_tours) returns boolean
language sql stable security definer set search_path = '' as $$
 select mavi_private.tour_for_user(t, auth.uid())
$$;

-- ------------------------------------------------------------ conteúdo (com os disparos)
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
  'aud_products', to_jsonb(v_products), 'scr_clients', to_jsonb(v_scr_clients), 'scr_products', to_jsonb(v_scr_products),
  'trg_visit', coalesce((p->>'trg_visit')::boolean, false), 'trg_login', coalesce((p->>'trg_login')::boolean, false));
end $$;

create or replace function mavi_private.tour_content(t public.tutorial_tours) returns jsonb
language sql stable set search_path = '' as $$
 select jsonb_build_object('title', t.title, 'summary', t.summary, 'steps', t.steps, 'modules', to_jsonb(t.modules),
  'aud_all', t.aud_all, 'aud_roles', to_jsonb(t.aud_roles), 'aud_teams', to_jsonb(t.aud_teams),
  'aud_users', to_jsonb(t.aud_users), 'aud_exclude', to_jsonb(t.aud_exclude), 'aud_squads', to_jsonb(t.aud_squads),
  'aud_clients', to_jsonb(t.aud_clients), 'aud_products', to_jsonb(t.aud_products),
  'scr_clients', to_jsonb(t.scr_clients), 'scr_products', to_jsonb(t.scr_products),
  'trg_visit', t.trg_visit, 'trg_login', t.trg_login)
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
  trg_visit = coalesce((v->>'trg_visit')::boolean, false),
  trg_login = coalesce((v->>'trg_login')::boolean, false),
  updated_by = auth.uid(), updated_at = now(), revision = revision + 1
 where id = p_id
$$;

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
   'scr_products', to_jsonb(t.scr_products), 'trg_visit', t.trg_visit, 'trg_login', t.trg_login) end,
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

drop trigger broadcast_tutorial_tour on public.tutorial_tours;
create trigger broadcast_tutorial_tour after insert or delete or update of title, summary, steps, modules,
 aud_all, aud_roles, aud_teams, aud_users, aud_exclude, aud_squads, aud_clients, aud_products, scr_clients,
 scr_products, trg_visit, trg_login, status, version on public.tutorial_tours
 for each row execute function mavi_private.broadcast_tutorial_tour();

-- ------------------------------------------------------------ disparos
-- Os onboardings automáticos que ainda não chegaram à pessoa (nenhum
-- progresso), o mais antigo antes. A tela confere a página e, nos "só nas
-- telas de", pergunta à lista com o contexto dela.
create function public.my_auto_tutorial_tours(p_company uuid)
returns table(id uuid, title text, start_page text, trg_visit boolean, trg_login boolean, screen_only boolean)
language plpgsql stable security definer set search_path = '' as $$ begin
 if not mavi_private.member(p_company) then return; end if;
 return query
 select t.id, t.title, t.start_page, t.trg_visit, t.trg_login,
  cardinality(t.scr_clients) + cardinality(t.scr_products) > 0
 from public.tutorial_tours t
 where t.company_id = p_company and t.status = 'published' and (t.trg_visit or t.trg_login)
  and jsonb_array_length(t.steps) > 0 and mavi_private.tour_for_me(t)
  and not exists (select 1 from public.tutorial_tour_progress p where p.tour_id = t.id and p.user_id = auth.uid())
 order by t.published_at, t.id
 limit 50;
end $$;
revoke all on function public.my_auto_tutorial_tours(uuid) from public, anon, authenticated;
grant execute on function public.my_auto_tutorial_tours(uuid) to authenticated;

-- ------------------------------------------------------------ passo quebrado
create or replace function public.log_tutorial_tour_miss(p_tour uuid, p_step_id text, p_path text default '') returns void
language plpgsql security definer set search_path = '' as $$
declare t public.tutorial_tours; m public.tutorial_tour_misses; v_n integer; v_title text; begin
 select * into t from public.tutorial_tours where id = p_tour;
 if not found or not mavi_private.member(t.company_id) or not mavi_private.tour_for_me(t) then return; end if;
 select s.n, s.title into v_n, v_title from (
  select x.ord::integer as n, coalesce(nullif(x.s->>'title', ''), 'sem título') as title
  from jsonb_array_elements(t.steps) with ordinality x(s, ord) where x.s->>'id' = p_step_id) s;
 if v_n is null then return; end if;
 insert into public.tutorial_tour_misses as x(company_id, tour_id, version, step_id, misses, people, last_path)
 values (t.company_id, t.id, t.version, p_step_id, 1, array[auth.uid()], left(coalesce(p_path, ''), 600))
 on conflict (tour_id, version, step_id) do update set misses = x.misses + 1,
  people = case when auth.uid() = any(x.people) or cardinality(x.people) >= 500 then x.people else x.people || auth.uid() end,
  last_path = excluded.last_path, last_at = now()
 returning * into m;
 -- Avisa quem criou: na 1ª vez e, se continuar, de 7 em 7 dias.
 if (m.notified_at is null or m.notified_at < now() - interval '7 days')
  and t.created_by is distinct from auth.uid()
  and exists (select 1 from public.memberships k where k.company_id = t.company_id and k.user_id = t.created_by and k.active)
 then
  insert into public.notifications(company_id, user_id, actor_id, task_id, kind, title, body, link)
  values (t.company_id, t.created_by, null, null, 'tutorial', left('Onboarding com passo não encontrado: ' || t.title, 300),
   left(format('O elemento do passo %s (%s) não apareceu na tela de %s (%s %s). Confira a tela ou escolha o elemento de novo.',
    v_n, v_title, case when cardinality(m.people) = 1 then '1 pessoa' else cardinality(m.people) || ' pessoas' end,
    m.misses, case when m.misses = 1 then 'vez' else 'vezes' end), 500),
   '/tutoriais?aba=onboarding&ver=gerenciar');
  update public.tutorial_tour_misses set notified_at = now()
  where tour_id = m.tour_id and version = m.version and step_id = m.step_id;
 end if;
end $$;

-- ------------------------------------------------------------ trilhas
-- Os itens: tutoriais e onboardings da empresa, na ordem enviada, sem repetidos.
create or replace function mavi_private.trail_clean(c uuid, p jsonb) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_title text; v_summary text; v_items uuid[]; v_all boolean; v_roles text[]; v_teams uuid[];
 v_users uuid[]; v_exclude uuid[]; v_new boolean; v_rall boolean; v_rroles text[]; v_rteams uuid[]; v_rusers uuid[];
 v_due integer; v_required boolean; begin
 if jsonb_typeof(p) <> 'object' then raise exception 'Conteúdo inválido' using errcode = '22023'; end if;
 v_title := regexp_replace(btrim(coalesce(p->>'title', '')), '\s+', ' ', 'g');
 if length(v_title) < 3 or length(v_title) > 120 then
  raise exception 'Dê um título de 3 a 120 caracteres à trilha.' using errcode = '22023';
 end if;
 v_summary := btrim(coalesce(p->>'summary', ''));
 if length(v_summary) > 600 then raise exception 'O resumo pode ter até 600 caracteres.' using errcode = '22023'; end if;

 select coalesce(array_agg(x.id::uuid order by x.ord), '{}') into v_items
 from (select e.value as id, min(e.ord) as ord
  from jsonb_array_elements_text(case when jsonb_typeof(p->'tutorials') = 'array' then p->'tutorials' else '[]' end)
   with ordinality e(value, ord)
  where e.value ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
  group by e.value) x
 where exists (select 1 from public.tutorials t where t.company_id = c and t.id = x.id::uuid)
  or exists (select 1 from public.tutorial_tours o where o.company_id = c and o.id = x.id::uuid);
 if cardinality(v_items) > 50 then raise exception 'Uma trilha pode ter até 50 itens.' using errcode = '22023'; end if;

 v_all := coalesce((p->>'aud_all')::boolean, true);
 v_roles := mavi_private.trail_roles(p->'aud_roles');
 v_teams := mavi_private.trail_ids(c, p->'aud_teams', 'team');
 v_users := mavi_private.trail_ids(c, p->'aud_users', 'user');
 v_exclude := mavi_private.trail_ids(c, p->'aud_exclude', 'user');
 if v_all then v_roles := '{}'; v_teams := '{}'; v_users := '{}'; end if;

 v_new := coalesce((p->>'req_newcomers')::boolean, false);
 v_rall := coalesce((p->>'req_all')::boolean, false);
 v_rroles := mavi_private.trail_roles(p->'req_roles');
 v_rteams := mavi_private.trail_ids(c, p->'req_teams', 'team');
 v_rusers := mavi_private.trail_ids(c, p->'req_users', 'user');
 if v_rall then v_rroles := '{}'; v_rteams := '{}'; v_rusers := '{}'; end if;
 v_required := v_new or v_rall or cardinality(v_rroles) + cardinality(v_rteams) + cardinality(v_rusers) > 0;

 if not v_all and cardinality(v_roles) + cardinality(v_teams) + cardinality(v_users) = 0 and not v_required then
  raise exception 'Escolha quem vê a trilha: todos, papéis, equipes ou pessoas.' using errcode = '22023';
 end if;
 if nullif(p->>'due_days', '') is not null then
  begin v_due := (p->>'due_days')::integer;
  exception when others then raise exception 'O prazo é um número de dias.' using errcode = '22023'; end;
  if v_due < 1 or v_due > 365 then raise exception 'O prazo vai de 1 a 365 dias.' using errcode = '22023'; end if;
 end if;
 if not v_required then v_due := null; end if;

 return jsonb_build_object('title', v_title, 'summary', v_summary,
  'sequential', coalesce((p->>'sequential')::boolean, false), 'tutorials', to_jsonb(v_items),
  'aud_all', v_all, 'aud_roles', to_jsonb(v_roles), 'aud_teams', to_jsonb(v_teams), 'aud_users', to_jsonb(v_users),
  'aud_exclude', to_jsonb(v_exclude), 'req_newcomers', v_new, 'req_all', v_rall, 'req_roles', to_jsonb(v_rroles),
  'req_teams', to_jsonb(v_rteams), 'req_users', to_jsonb(v_rusers), 'due_days', v_due);
end $$;

create or replace function public.save_tutorial_trail(p_company uuid, p_trail uuid, p_content jsonb, p_publish boolean default false,
 p_revision integer default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare tr public.tutorial_trails; v jsonb; begin
 if not mavi_private.leader(p_company) then
  raise exception 'Só administradores e gestores montam trilhas.' using errcode = '42501';
 end if;
 v := mavi_private.trail_clean(p_company, p_content);

 if p_trail is null then
  insert into public.tutorial_trails(company_id, title, created_by, updated_by)
  values (p_company, v->>'title', auth.uid(), auth.uid()) returning * into tr;
 else
  select * into tr from public.tutorial_trails where id = p_trail and company_id = p_company for update;
  if not found or not mavi_private.trail_can_edit(tr) then
   raise exception 'Só um administrador ou o gestor que criou a trilha pode editá-la.' using errcode = '42501';
  end if;
  if p_revision is not null and p_revision <> tr.revision then
   raise exception 'Esta trilha foi alterada por outra pessoa. Abra de novo para ver a versão atual.' using errcode = '40001';
  end if;
 end if;
 if (p_publish or tr.status = 'published') and jsonb_array_length(v->'tutorials') = 0 then
  raise exception 'Escolha ao menos um tutorial ou onboarding para a trilha.' using errcode = '22023';
 end if;

 update public.tutorial_trails set title = v->>'title', summary = v->>'summary',
  sequential = (v->>'sequential')::boolean,
  aud_all = (v->>'aud_all')::boolean, aud_roles = array(select jsonb_array_elements_text(v->'aud_roles')),
  aud_teams = array(select jsonb_array_elements_text(v->'aud_teams'))::uuid[],
  aud_users = array(select jsonb_array_elements_text(v->'aud_users'))::uuid[],
  aud_exclude = array(select jsonb_array_elements_text(v->'aud_exclude'))::uuid[],
  req_newcomers = (v->>'req_newcomers')::boolean,
  req_since = case when (v->>'req_newcomers')::boolean
   then coalesce(case when tr.req_newcomers then tr.req_since end, now()) end,
  req_all = (v->>'req_all')::boolean, req_roles = array(select jsonb_array_elements_text(v->'req_roles')),
  req_teams = array(select jsonb_array_elements_text(v->'req_teams'))::uuid[],
  req_users = array(select jsonb_array_elements_text(v->'req_users'))::uuid[],
  due_days = (v->>'due_days')::integer,
  status = case when p_publish then 'published' else status end,
  published_at = case when p_publish then coalesce(published_at, now()) else published_at end,
  revision = case when p_trail is null then 1 else revision + 1 end,
  updated_by = auth.uid(), updated_at = now()
 where id = tr.id returning * into tr;

 -- Cada item na sua tabela, com a posição na ordem única da trilha.
 delete from public.tutorial_trail_items where trail_id = tr.id;
 delete from public.tutorial_trail_tours where trail_id = tr.id;
 insert into public.tutorial_trail_items(company_id, trail_id, tutorial_id, position)
 select tr.company_id, tr.id, x.id::uuid, x.ord
 from jsonb_array_elements_text(v->'tutorials') with ordinality x(id, ord)
 where exists (select 1 from public.tutorials t where t.company_id = tr.company_id and t.id = x.id::uuid);
 insert into public.tutorial_trail_tours(company_id, trail_id, tour_id, position)
 select tr.company_id, tr.id, x.id::uuid, x.ord
 from jsonb_array_elements_text(v->'tutorials') with ordinality x(id, ord)
 where exists (select 1 from public.tutorial_tours o where o.company_id = tr.company_id and o.id = x.id::uuid);

 perform mavi_private.tutorial_trail_assign(tr.id);
 return jsonb_build_object('id', tr.id, 'status', tr.status, 'revision', tr.revision);
end $$;

-- Os itens que a pessoa tem (tutoriais e onboardings publicados do público
-- dela) e quantos concluiu.
create or replace function mavi_private.trail_counts(tr public.tutorial_trails, u uuid, out total integer, out done integer,
 out last_done_at timestamptz)
language sql stable security definer set search_path = '' as $$
 select count(*)::integer, count(z.done_at)::integer, max(z.done_at) from (
  select p.completed_at as done_at
  from public.tutorial_trail_items i
  join public.tutorials t on t.company_id = i.company_id and t.id = i.tutorial_id
  left join public.tutorial_progress p on p.company_id = i.company_id and p.user_id = u and p.tutorial_id = i.tutorial_id
  where i.trail_id = tr.id and mavi_private.tutorial_for_user(t, u)
  union all
  select case when p.status = 'completed' or p.times_completed > 0 then coalesce(p.completed_at, p.updated_at) end
  from public.tutorial_trail_tours i
  join public.tutorial_tours o on o.company_id = i.company_id and o.id = i.tour_id
  left join public.tutorial_tour_progress p on p.tour_id = i.tour_id and p.user_id = u
  where i.trail_id = tr.id and mavi_private.tour_for_user(o, u)) z
$$;

-- O primeiro item ainda não concluído (tutorial ou onboarding), na ordem.
create or replace function mavi_private.trail_next(tr public.tutorial_trails, u uuid) returns uuid
language sql stable security definer set search_path = '' as $$
 select z.id from (
  select i.tutorial_id as id, i.position
  from public.tutorial_trail_items i
  join public.tutorials t on t.company_id = i.company_id and t.id = i.tutorial_id
  left join public.tutorial_progress p on p.company_id = i.company_id and p.user_id = u and p.tutorial_id = i.tutorial_id
  where i.trail_id = tr.id and mavi_private.tutorial_for_user(t, u) and p.completed_at is null
  union all
  select i.tour_id, i.position
  from public.tutorial_trail_tours i
  join public.tutorial_tours o on o.company_id = i.company_id and o.id = i.tour_id
  left join public.tutorial_tour_progress p on p.tour_id = i.tour_id and p.user_id = u
  where i.trail_id = tr.id and mavi_private.tour_for_user(o, u)
   and not (coalesce(p.status, '') = 'completed' or coalesce(p.times_completed, 0) > 0)) z
 order by z.position limit 1
$$;

create or replace function mavi_private.tutorial_trail_assign(p_trail uuid) returns integer
language plpgsql security definer set search_path = '' as $$
declare tr public.tutorial_trails; v_users uuid[]; v_total integer; v_tours integer; v_body text; begin
 select * into tr from public.tutorial_trails where id = p_trail;
 if not found or tr.status <> 'published' or not mavi_private.trail_has_required(tr) then return 0; end if;
 with ins as (
  insert into public.tutorial_trail_assignments(company_id, trail_id, user_id)
  select tr.company_id, tr.id, m.user_id from public.memberships m
  where m.company_id = tr.company_id and m.active and mavi_private.trail_required_for(tr, m.user_id)
  on conflict do nothing
  returning user_id)
 select coalesce(array_agg(user_id), '{}') into v_users from ins;
 if cardinality(v_users) = 0 then return 0; end if;
 select count(*) into v_total from public.tutorial_trail_items where trail_id = tr.id;
 select count(*) into v_tours from public.tutorial_trail_tours where trail_id = tr.id;
 v_body := concat_ws(' e ',
   case when v_total = 1 then '1 tutorial' when v_total > 1 then v_total || ' tutoriais' end,
   case when v_tours = 1 then '1 onboarding' when v_tours > 1 then v_tours || ' onboardings' end)
  || case when tr.due_days is not null
   then ' · conclua até ' || mavi_private.trail_day(tr.company_id, now() + make_interval(days => tr.due_days))
   else '' end
  || case when tr.summary <> '' then '. ' || tr.summary else '' end;
 insert into public.notifications(company_id, user_id, actor_id, task_id, kind, title, body, link)
 select tr.company_id, u, tr.updated_by, null, 'tutorial_trail', left('Trilha obrigatória: ' || tr.title, 300),
  left(v_body, 500), '/tutoriais?trilha=' || tr.id
 from unnest(v_users) u
 where u is distinct from auth.uid() and not mavi_private.trail_done(tr, u);
 return cardinality(v_users);
end $$;

create or replace function mavi_private.tutorial_trails_run() returns void
language plpgsql security definer set search_path = '' as $$
declare tr record; a record; c record; begin
 for tr in select t.id from public.tutorial_trails t
  where t.status = 'published' and mavi_private.trail_has_required(t) loop
  perform mavi_private.tutorial_trail_assign(tr.id);
 end loop;
 for a in
  select x.*, t as trail from public.tutorial_trail_assignments x
  join public.tutorial_trails t on t.id = x.trail_id
  where x.overdue_notified_at is null and t.status = 'published' and t.due_days is not null
   and mavi_private.trail_due_at(t, x.assigned_at) < now()
 loop
  if mavi_private.trail_required_for(a.trail, a.user_id) and not mavi_private.trail_done(a.trail, a.user_id) then
   select * into c from mavi_private.trail_counts(a.trail, a.user_id);
   insert into public.notifications(company_id, user_id, actor_id, task_id, kind, title, body, link)
   values (a.company_id, a.user_id, null, null, 'tutorial_trail', left('Trilha atrasada: ' || (a.trail).title, 300),
    format('O prazo era %s. Faltam %s de %s %s.',
     mavi_private.trail_day(a.company_id, mavi_private.trail_due_at(a.trail, a.assigned_at)), c.total - c.done, c.total,
     case when exists (select 1 from public.tutorial_trail_tours i where i.trail_id = a.trail_id) then 'itens'
      else 'tutoriais' end),
    '/tutoriais?trilha=' || a.trail_id);
  end if;
  update public.tutorial_trail_assignments set overdue_notified_at = now()
  where trail_id = a.trail_id and user_id = a.user_id;
 end loop;
end $$;

-- A trilha na tela: os onboardings entram entre os tutoriais (kind 'tour';
-- tutorial_id leva o id do onboarding, para a tela tratar todos iguais).
create or replace function public.tutorial_trail_detail(p_trail uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare tr public.tutorial_trails; me uuid := auth.uid(); v_edit boolean; v_leader boolean; x public.tutorial_trail_assignments;
 c record; v_req boolean; begin
 select * into tr from public.tutorial_trails where id = p_trail;
 if not found or not mavi_private.trail_can_see(tr) then return null; end if;
 v_edit := mavi_private.trail_can_edit(tr);
 v_leader := mavi_private.leader(tr.company_id);
 v_req := mavi_private.trail_required_for(tr, me);
 select * into x from public.tutorial_trail_assignments a where a.trail_id = tr.id and a.user_id = me;
 select * into c from mavi_private.trail_counts(tr, me);
 return jsonb_build_object(
  'id', tr.id, 'company_id', tr.company_id, 'title', tr.title, 'summary', tr.summary, 'sequential', tr.sequential,
  'status', tr.status, 'revision', tr.revision, 'required', mavi_private.trail_has_required(tr), 'due_days', tr.due_days,
  'created_by', tr.created_by, 'author_name', mavi_private.member_name(tr.company_id, tr.created_by),
  'updated_at', tr.updated_at, 'published_at', tr.published_at,
  'for_me', mavi_private.trail_for_user(tr, me), 'required_for_me', v_req,
  'assigned_at', x.assigned_at, 'due_at', case when v_req then mavi_private.trail_due_at(tr, x.assigned_at) end,
  'total', c.total, 'done', c.done,
  'config', case when v_edit or v_leader then jsonb_build_object(
   'aud_all', tr.aud_all, 'aud_roles', to_jsonb(tr.aud_roles), 'aud_teams', to_jsonb(tr.aud_teams),
   'aud_users', to_jsonb(tr.aud_users), 'aud_exclude', to_jsonb(tr.aud_exclude),
   'req_newcomers', tr.req_newcomers, 'req_since', tr.req_since, 'req_all', tr.req_all,
   'req_roles', to_jsonb(tr.req_roles), 'req_teams', to_jsonb(tr.req_teams), 'req_users', to_jsonb(tr.req_users)) end,
  'items', coalesce((select jsonb_agg(z.item order by z.position) from (
   select i.position, jsonb_build_object('kind', 'tutorial', 'tutorial_id', t.id, 'title', t.title, 'summary', t.summary,
     'modules', to_jsonb(t.modules), 'status', t.status, 'version', t.version, 'aud_all', t.aud_all,
     'visible', v.visible, 'completed_at', p.completed_at, 'completed_version', p.completed_version,
     'video_count', (select count(*)::integer from public.tutorial_media m
      where m.company_id = t.company_id and m.tutorial_id = t.id and m.status = 'ready')) as item
   from public.tutorial_trail_items i
   join public.tutorials t on t.company_id = i.company_id and t.id = i.tutorial_id
   cross join lateral (select mavi_private.tutorial_for_user(t, me) as visible) v
   left join public.tutorial_progress p on p.company_id = i.company_id and p.user_id = me and p.tutorial_id = t.id
   where i.trail_id = tr.id and (v.visible or v_edit)
   union all
   select i.position, jsonb_build_object('kind', 'tour', 'tutorial_id', o.id, 'title', o.title, 'summary', o.summary,
     'modules', to_jsonb(o.modules), 'status', o.status, 'version', o.version, 'aud_all', o.aud_all,
     'visible', v.visible,
     'completed_at', case when p.status = 'completed' or p.times_completed > 0 then coalesce(p.completed_at, p.updated_at) end,
     'completed_version', case when p.status = 'completed' or p.times_completed > 0 then p.version end,
     'video_count', 0, 'step_count', jsonb_array_length(o.steps),
     'my_status', p.status, 'my_step', p.step)
   from public.tutorial_trail_tours i
   join public.tutorial_tours o on o.company_id = i.company_id and o.id = i.tour_id
   cross join lateral (select mavi_private.tour_for_user(o, me) as visible) v
   left join public.tutorial_tour_progress p on p.tour_id = o.id and p.user_id = me
   where i.trail_id = tr.id and (v.visible or v_edit)) z), '[]'),
  'can_edit', v_edit);
end $$;

create or replace function public.tutorial_trail_progress(p_trail uuid)
returns table(user_id uuid, name text, required boolean, assigned_at timestamptz, due_at timestamptz, total integer,
 done integer, last_done_at timestamptz, done_ids uuid[], state text)
language plpgsql stable security definer set search_path = '' as $$
declare tr public.tutorial_trails; begin
 select * into tr from public.tutorial_trails where id = p_trail;
 if not found or not mavi_private.trail_can_see(tr) or not mavi_private.leader(tr.company_id) then return; end if;
 return query
 with people as (
  select m.user_id, m.name, mavi_private.trail_required_for(tr, m.user_id) as req, x.assigned_at, c.total, c.done,
   c.last_done_at
  from public.memberships m
  cross join lateral mavi_private.trail_counts(tr, m.user_id) c
  left join public.tutorial_trail_assignments x on x.trail_id = tr.id and x.user_id = m.user_id
  where m.company_id = tr.company_id and m.active and mavi_private.trail_for_user(tr, m.user_id)),
 rated as (
  select p.*, case when p.req then mavi_private.trail_due_at(tr, p.assigned_at) end as due,
   case when p.total > 0 and p.done = p.total then 'done'
    when p.req and mavi_private.trail_due_at(tr, p.assigned_at) < now() then 'overdue'
    when p.done > 0 then 'progress' else 'todo' end as st
  from people p)
 select r.user_id, r.name, r.req, r.assigned_at, r.due, r.total, r.done,
  case when r.st = 'done' then r.last_done_at end,
  coalesce((select array_agg(pr.tutorial_id) from public.tutorial_progress pr
   join public.tutorial_trail_items i on i.trail_id = tr.id and i.tutorial_id = pr.tutorial_id
   where pr.company_id = tr.company_id and pr.user_id = r.user_id and pr.completed_at is not null), '{}')
  || coalesce((select array_agg(tp.tour_id) from public.tutorial_tour_progress tp
   join public.tutorial_trail_tours i on i.trail_id = tr.id and i.tour_id = tp.tour_id
   where tp.user_id = r.user_id and (tp.status = 'completed' or tp.times_completed > 0)), '{}'),
  r.st
 from rated r
 order by array_position(array['overdue', 'todo', 'progress', 'done'], r.st), r.due nulls last, r.name, r.user_id;
end $$;

-- Concluir um onboarding mexe nas trilhas da pessoa (o número no menu).
create function mavi_private.broadcast_tour_progress() returns trigger
language plpgsql security definer set search_path = '' as $$ begin
 if new.status = 'completed' and (tg_op = 'INSERT' or old.status is distinct from 'completed')
  and exists (select 1 from public.tutorial_trail_tours i where i.tour_id = new.tour_id) then
  perform mavi_private.broadcast(new.company_id, jsonb_build_object('kind', 'tutorials', 'progress', true));
 end if;
 return null;
end $$;
revoke all on function mavi_private.broadcast_tour_progress() from public, anon, authenticated;
create trigger broadcast_tour_progress after insert or update of status on public.tutorial_tour_progress
 for each row execute function mavi_private.broadcast_tour_progress();

commit;
