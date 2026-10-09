begin;

-- Onboarding: "Começa sozinho" ganha a opção de voltar até a pessoa
-- concluir (trg_until_done). Enquanto quem recebe não concluir, o
-- onboarding começa de novo toda vez que ela entra na tela onde ele começa,
-- do passo onde parou (fechar e continuar na mesma tela não reabre; quem
-- concluiu não recebe mais). Vale também para quem recebeu por um envio.
-- As funções de conteúdo são as da migração 20270626090000 com a chave
-- nova; my_auto_tutorial_tours (da 20270703150000) devolve until_done e o
-- passo onde a pessoa parou.

alter table public.tutorial_tours add column trg_until_done boolean not null default false;

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
  'trg_visit', coalesce((p->>'trg_visit')::boolean, false), 'trg_login', coalesce((p->>'trg_login')::boolean, false),
  'trg_until_done', coalesce((p->>'trg_until_done')::boolean, false));
end $$;

create or replace function mavi_private.tour_content(t public.tutorial_tours) returns jsonb
language sql stable set search_path = '' as $$
 select jsonb_build_object('title', t.title, 'summary', t.summary, 'steps', t.steps, 'modules', to_jsonb(t.modules),
  'aud_all', t.aud_all, 'aud_roles', to_jsonb(t.aud_roles), 'aud_teams', to_jsonb(t.aud_teams),
  'aud_users', to_jsonb(t.aud_users), 'aud_exclude', to_jsonb(t.aud_exclude), 'aud_squads', to_jsonb(t.aud_squads),
  'aud_clients', to_jsonb(t.aud_clients), 'aud_products', to_jsonb(t.aud_products),
  'scr_clients', to_jsonb(t.scr_clients), 'scr_products', to_jsonb(t.scr_products),
  'trg_visit', t.trg_visit, 'trg_login', t.trg_login, 'trg_until_done', t.trg_until_done)
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
  trg_until_done = coalesce((v->>'trg_until_done')::boolean, false),
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
   'scr_products', to_jsonb(t.scr_products), 'trg_visit', t.trg_visit, 'trg_login', t.trg_login,
   'trg_until_done', t.trg_until_done) end,
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
 scr_products, trg_visit, trg_login, trg_until_done, status, version on public.tutorial_tours
 for each row execute function mavi_private.broadcast_tutorial_tour();

drop function public.my_auto_tutorial_tours(uuid);
create function public.my_auto_tutorial_tours(p_company uuid)
returns table(id uuid, title text, start_page text, trg_visit boolean, trg_login boolean, screen_only boolean,
 send_id uuid, until_done boolean, my_step integer)
language plpgsql stable security definer set search_path = '' as $$ begin
 if not mavi_private.member(p_company) then return; end if;
 return query
 (select t.id, t.title, t.start_page, false, false, false, sp.send_id, false, 0
  from public.tutorial_tour_send_people sp
  join public.tutorial_tours t on t.id = sp.tour_id
  join public.tutorial_tour_sends s on s.id = sp.send_id
  where sp.company_id = p_company and sp.user_id = auth.uid() and sp.started_at is null and s.status = 'sent'
   and t.status = 'published' and jsonb_array_length(t.steps) > 0
  order by sp.delivered_at
  limit 20)
 union all
 -- Os de disparo: os que começam uma vez (sem progresso) e os que voltam
 -- até a pessoa concluir (com o passo onde ela parou).
 (select t.id, t.title, t.start_page, t.trg_visit, t.trg_login,
   cardinality(t.scr_clients) + cardinality(t.scr_products) > 0, null::uuid, t.trg_until_done,
   case when p.status = 'dismissed' or p.status = 'started' then coalesce(p.step, 0) else 0 end
  from public.tutorial_tours t
  left join public.tutorial_tour_progress p on p.tour_id = t.id and p.user_id = auth.uid()
  where t.company_id = p_company and t.status = 'published' and (t.trg_visit or t.trg_login or t.trg_until_done)
   and jsonb_array_length(t.steps) > 0 and mavi_private.tour_for_me(t)
   and (p.tour_id is null
    or (t.trg_until_done and p.status <> 'completed' and p.times_completed = 0))
  order by t.published_at, t.id
  limit 50);
end $$;
revoke all on function public.my_auto_tutorial_tours(uuid) from public, anon, authenticated;
grant execute on function public.my_auto_tutorial_tours(uuid) to authenticated;

notify pgrst, 'reload schema';

commit;
