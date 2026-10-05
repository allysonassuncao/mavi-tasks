begin;

-- Tutoriais, Fase 3: trilhas (pedido de 05/10/2026).
--
-- - Uma trilha é uma lista ordenada de tutoriais. Quem cria escolhe se a
--   ordem é só sugerida (abre qualquer um) ou em sequência (o próximo libera
--   quando o anterior é concluído; a trava vale na trilha, não no tutorial,
--   que continua na biblioteca para quem o vê).
-- - Quem escreve: como nos tutoriais (administradores editam todas; gestores,
--   as que criaram). Líderes veem todas as trilhas publicadas e o progresso
--   das pessoas.
-- - Quem vê: todos (padrão) ou papéis, equipes e pessoas, menos as excluídas.
-- - Obrigatória: para quem entrar na agência a partir de quando a opção foi
--   ligada (memberships.joined_at, novo) e/ou para um público (todos, papéis,
--   equipes, pessoas). As exclusões de "quem vê" valem também aqui. Quem é
--   obrigado sempre vê. A trilha "chega" à pessoa numa linha de
--   tutorial_trail_assignments (ao publicar, ao salvar e a cada 10 minutos
--   pelo pg_cron, para quem entrou depois numa equipe ou na agência), com um
--   aviso na caixa de entrada ('tutorial_trail'). O prazo opcional (dias)
--   conta dessa chegada; vencido, um aviso de atraso (uma vez).
-- - Progresso: por pessoa e tutorial (vale em todas as trilhas que o têm).
--   Chegar ao fim do tutorial conclui sozinho; o botão marca e desmarca (quem
--   desmarcou não é concluído sozinho de novo). Só contam os tutoriais
--   publicados que a pessoa vê.
-- - Tutorial atualizado depois de concluído continua concluído (a tela mostra
--   o selo pela versão); quem edita pode pedir que releiam
--   (ask_tutorial_reread), e a conclusão volta a pendente.

-- ------------------------------------------------------------ quando a pessoa entrou
-- Quem já está na agência fica com a data desta migração.
alter table public.memberships add column if not exists joined_at timestamptz not null default now();

-- ------------------------------------------------------------ tabelas
create table public.tutorial_trails (
 id uuid primary key default gen_random_uuid(),
 company_id uuid not null references public.companies(id),
 title text not null check (length(btrim(title)) between 3 and 120),
 summary text not null default '' check (length(summary) <= 600),
 -- Em sequência: o próximo tutorial só libera depois de concluir o anterior.
 sequential boolean not null default false,
 status text not null default 'draft' check (status in ('draft', 'published')),
 -- Quem vê (além de quem é obrigado).
 aud_all boolean not null default true,
 aud_roles text[] not null default '{}' check (aud_roles <@ array['admin', 'manager', 'member']::text[]),
 aud_teams uuid[] not null default '{}',
 aud_users uuid[] not null default '{}',
 aud_exclude uuid[] not null default '{}',
 -- Quem é obrigado: quem entrar a partir de req_since e/ou o público req_*.
 req_newcomers boolean not null default false,
 req_since timestamptz,
 req_all boolean not null default false,
 req_roles text[] not null default '{}' check (req_roles <@ array['admin', 'manager', 'member']::text[]),
 req_teams uuid[] not null default '{}',
 req_users uuid[] not null default '{}',
 -- Prazo em dias desde que a trilha chega à pessoa (nulo: sem prazo).
 due_days integer check (due_days between 1 and 365),
 revision integer not null default 1,
 published_at timestamptz,
 created_by uuid not null,
 created_at timestamptz not null default now(),
 updated_by uuid not null,
 updated_at timestamptz not null default now(),
 unique(company_id, id),
 check (not req_newcomers or req_since is not null),
 foreign key(company_id, created_by) references public.memberships(company_id, user_id)
);
create index tutorial_trails_list on public.tutorial_trails(company_id, status);
alter table public.tutorial_trails enable row level security;
revoke all on public.tutorial_trails from public, anon, authenticated;

create table public.tutorial_trail_items (
 company_id uuid not null,
 trail_id uuid not null,
 tutorial_id uuid not null,
 position integer not null check (position > 0),
 primary key(trail_id, tutorial_id),
 foreign key(company_id, trail_id) references public.tutorial_trails(company_id, id) on delete cascade,
 foreign key(company_id, tutorial_id) references public.tutorials(company_id, id) on delete cascade
);
create index tutorial_trail_items_tutorial on public.tutorial_trail_items(company_id, tutorial_id);
alter table public.tutorial_trail_items enable row level security;
revoke all on public.tutorial_trail_items from public, anon, authenticated;

-- O progresso de cada pessoa em cada tutorial.
create table public.tutorial_progress (
 company_id uuid not null,
 user_id uuid not null,
 tutorial_id uuid not null,
 opened_at timestamptz not null default now(),
 completed_at timestamptz,
 -- A versão concluída: maior no tutorial = "atualizado depois que você concluiu".
 completed_version integer,
 completed_how text check (completed_how in ('auto', 'manual')),
 -- Desmarcou à mão: chegar ao fim não conclui sozinho de novo.
 undone_at timestamptz,
 primary key(company_id, user_id, tutorial_id),
 check ((completed_at is null) = (completed_version is null)),
 foreign key(company_id, tutorial_id) references public.tutorials(company_id, id) on delete cascade,
 foreign key(company_id, user_id) references public.memberships(company_id, user_id) on delete cascade
);
create index tutorial_progress_tutorial on public.tutorial_progress(company_id, tutorial_id);
alter table public.tutorial_progress enable row level security;
revoke all on public.tutorial_progress from public, anon, authenticated;

-- Quando a trilha obrigatória chegou a cada pessoa (o prazo conta daí).
create table public.tutorial_trail_assignments (
 company_id uuid not null,
 trail_id uuid not null,
 user_id uuid not null,
 assigned_at timestamptz not null default now(),
 overdue_notified_at timestamptz,
 primary key(trail_id, user_id),
 foreign key(company_id, trail_id) references public.tutorial_trails(company_id, id) on delete cascade,
 foreign key(company_id, user_id) references public.memberships(company_id, user_id) on delete cascade
);
create index tutorial_trail_assignments_user on public.tutorial_trail_assignments(company_id, user_id);
alter table public.tutorial_trail_assignments enable row level security;
revoke all on public.tutorial_trail_assignments from public, anon, authenticated;

-- ------------------------------------------------------------ avisos na caixa de entrada
-- As listas que já estão no banco (da migração 20270406090000 e das que
-- vieram depois, em qualquer ordem), com as trilhas obrigatórias. Fora das
-- preferências de notificação: a trilha obrigatória sempre avisa.
do $$ declare v text[]; w text[]; begin
 select coalesce(array_agg(distinct m[1]), '{}') into v from pg_constraint k,
  regexp_matches(pg_get_constraintdef(k.oid), '''([a-z_]+)''', 'g') m
 where k.conname = 'notifications_kind_check' and k.conrelid = 'public.notifications'::regclass;
 select coalesce(array_agg(distinct m[1]), '{}') into w from pg_constraint k,
  regexp_matches(pg_get_constraintdef(k.oid), '''([a-z_]+)''', 'g') m
 where k.conname = 'notifications_target_check' and k.conrelid = 'public.notifications'::regclass;
 v := array(select distinct x from unnest(v || array['tutorial_trail']) x order by x);
 w := array(select distinct x from unnest(w || array['tutorial_trail', 'notice']) x order by x);
 alter table public.notifications drop constraint notifications_kind_check;
 execute format('alter table public.notifications add constraint notifications_kind_check check (kind in (%s))',
  (select string_agg(quote_literal(x), ',') from unnest(v) x));
 alter table public.notifications drop constraint notifications_target_check;
 execute format('alter table public.notifications add constraint notifications_target_check check ('
  '((kind in (%s)) = (task_id is null)) '
  'and (task_id is not null or (title is not null and link is not null)) '
  'and ((kind = ''notice'') = (notice_id is not null)))', (select string_agg(quote_literal(x), ',') from unnest(w) x));
end $$;

-- ------------------------------------------------------------ regras
-- A pessoa está no público (papel, equipe, ela mesma, ou todos)?
create function mavi_private.tutorial_aud_has(c uuid, u uuid, p_all boolean, p_roles text[], p_teams uuid[],
 p_users uuid[]) returns boolean
language sql stable security definer set search_path = '' as $$
 select p_all or u = any(p_users)
  or exists (select 1 from public.memberships m where m.company_id = c and m.user_id = u and m.role = any(p_roles))
  or exists (select 1 from public.team_members tm
   where tm.company_id = c and tm.user_id = u and tm.team_id = any(p_teams))
$$;

-- Como mavi_private.tutorial_for_me, para qualquer pessoa ativa.
create function mavi_private.tutorial_for_user(t public.tutorials, u uuid) returns boolean
language sql stable security definer set search_path = '' as $$
 select t.status = 'published' and not (u = any(t.aud_exclude))
  and exists (select 1 from public.memberships m where m.company_id = t.company_id and m.user_id = u and m.active)
  and mavi_private.tutorial_aud_has(t.company_id, u, t.aud_all, t.aud_roles, t.aud_teams, t.aud_users)
$$;

create function mavi_private.trail_required_for(tr public.tutorial_trails, u uuid) returns boolean
language sql stable security definer set search_path = '' as $$
 select tr.status = 'published' and not (u = any(tr.aud_exclude)) and exists (
  select 1 from public.memberships m where m.company_id = tr.company_id and m.user_id = u and m.active and (
   (tr.req_newcomers and m.joined_at >= tr.req_since)
   or mavi_private.tutorial_aud_has(tr.company_id, u, tr.req_all, tr.req_roles, tr.req_teams, tr.req_users)))
$$;

create function mavi_private.trail_for_user(tr public.tutorial_trails, u uuid) returns boolean
language sql stable security definer set search_path = '' as $$
 select tr.status = 'published' and (mavi_private.trail_required_for(tr, u) or (
  not (u = any(tr.aud_exclude))
  and exists (select 1 from public.memberships m where m.company_id = tr.company_id and m.user_id = u and m.active)
  and mavi_private.tutorial_aud_has(tr.company_id, u, tr.aud_all, tr.aud_roles, tr.aud_teams, tr.aud_users)))
$$;

create function mavi_private.trail_can_edit(tr public.tutorial_trails) returns boolean
language sql stable security definer set search_path = '' as $$
 select mavi_private.admin(tr.company_id) or (tr.created_by = auth.uid() and mavi_private.leader(tr.company_id))
$$;

-- Vê: quem edita, os líderes (as publicadas, para acompanhar) e o público.
create function mavi_private.trail_can_see(tr public.tutorial_trails) returns boolean
language sql stable security definer set search_path = '' as $$
 select mavi_private.member(tr.company_id) and (mavi_private.trail_can_edit(tr)
  or (tr.status = 'published' and mavi_private.leader(tr.company_id))
  or mavi_private.trail_for_user(tr, auth.uid()))
$$;

create function mavi_private.trail_has_required(tr public.tutorial_trails) returns boolean
language sql immutable set search_path = '' as $$
 select tr.req_newcomers or tr.req_all
  or cardinality(tr.req_roles) + cardinality(tr.req_teams) + cardinality(tr.req_users) > 0
$$;

-- Quantos tutoriais da trilha a pessoa tem (publicados que ela vê) e
-- quantos concluiu.
create function mavi_private.trail_counts(tr public.tutorial_trails, u uuid, out total integer, out done integer,
 out last_done_at timestamptz)
language sql stable security definer set search_path = '' as $$
 select count(*)::integer, count(p.completed_at)::integer, max(p.completed_at)
 from public.tutorial_trail_items i
 join public.tutorials t on t.company_id = i.company_id and t.id = i.tutorial_id
 left join public.tutorial_progress p on p.company_id = i.company_id and p.user_id = u and p.tutorial_id = i.tutorial_id
 where i.trail_id = tr.id and mavi_private.tutorial_for_user(t, u)
$$;

create function mavi_private.trail_done(tr public.tutorial_trails, u uuid) returns boolean
language sql stable security definer set search_path = '' as $$
 select c.total > 0 and c.done = c.total from mavi_private.trail_counts(tr, u) c
$$;

-- O primeiro tutorial ainda não concluído (na ordem), entre os que a pessoa vê.
create function mavi_private.trail_next(tr public.tutorial_trails, u uuid) returns uuid
language sql stable security definer set search_path = '' as $$
 select i.tutorial_id
 from public.tutorial_trail_items i
 join public.tutorials t on t.company_id = i.company_id and t.id = i.tutorial_id
 left join public.tutorial_progress p on p.company_id = i.company_id and p.user_id = u and p.tutorial_id = i.tutorial_id
 where i.trail_id = tr.id and mavi_private.tutorial_for_user(t, u) and p.completed_at is null
 order by i.position limit 1
$$;

create function mavi_private.trail_due_at(tr public.tutorial_trails, p_assigned timestamptz) returns timestamptz
language sql immutable set search_path = '' as $$
 select case when tr.due_days is not null and p_assigned is not null
  then p_assigned + make_interval(days => tr.due_days) end
$$;

-- Dia e mês no fuso da empresa (os avisos).
create function mavi_private.trail_day(c uuid, p timestamptz) returns text
language sql stable security definer set search_path = '' as $$
 select to_char(p at time zone coalesce((select timezone from public.companies where id = c), 'America/Sao_Paulo'),
  'DD/MM')
$$;

revoke all on function mavi_private.tutorial_aud_has(uuid, uuid, boolean, text[], uuid[], uuid[]),
 mavi_private.tutorial_for_user(public.tutorials, uuid),
 mavi_private.trail_required_for(public.tutorial_trails, uuid), mavi_private.trail_for_user(public.tutorial_trails, uuid),
 mavi_private.trail_can_edit(public.tutorial_trails), mavi_private.trail_can_see(public.tutorial_trails),
 mavi_private.trail_has_required(public.tutorial_trails), mavi_private.trail_counts(public.tutorial_trails, uuid),
 mavi_private.trail_done(public.tutorial_trails, uuid), mavi_private.trail_next(public.tutorial_trails, uuid),
 mavi_private.trail_due_at(public.tutorial_trails, timestamptz), mavi_private.trail_day(uuid, timestamptz)
 from public, anon, authenticated;

-- ------------------------------------------------------------ conteúdo
-- Os ids (pessoas ou equipes) da empresa que vieram na lista.
create function mavi_private.trail_ids(c uuid, p jsonb, p_kind text) returns uuid[]
language sql stable security definer set search_path = '' as $$
 select coalesce(array_agg(x.id order by x.id), '{}') from (
  select tm.id from public.teams tm where p_kind = 'team' and tm.company_id = c and tm.id::text in (
   select jsonb_array_elements_text(case when jsonb_typeof(p) = 'array' then p else '[]' end))
  union
  select m.user_id from public.memberships m where p_kind = 'user' and m.company_id = c and m.user_id::text in (
   select jsonb_array_elements_text(case when jsonb_typeof(p) = 'array' then p else '[]' end))) x
$$;

create function mavi_private.trail_roles(p jsonb) returns text[]
language sql immutable set search_path = '' as $$
 select array(select distinct r from jsonb_array_elements_text(case when jsonb_typeof(p) = 'array' then p else '[]' end) r
  where r in ('admin', 'manager', 'member') order by r)
$$;

-- O conteúdo que a pessoa enviou, limpo e conferido.
create function mavi_private.trail_clean(c uuid, p jsonb) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_title text; v_summary text; v_tutorials uuid[]; v_all boolean; v_roles text[]; v_teams uuid[];
 v_users uuid[]; v_exclude uuid[]; v_new boolean; v_rall boolean; v_rroles text[]; v_rteams uuid[]; v_rusers uuid[];
 v_due integer; v_required boolean; begin
 if jsonb_typeof(p) <> 'object' then raise exception 'Conteúdo inválido' using errcode = '22023'; end if;
 v_title := regexp_replace(btrim(coalesce(p->>'title', '')), '\s+', ' ', 'g');
 if length(v_title) < 3 or length(v_title) > 120 then
  raise exception 'Dê um título de 3 a 120 caracteres à trilha.' using errcode = '22023';
 end if;
 v_summary := btrim(coalesce(p->>'summary', ''));
 if length(v_summary) > 600 then raise exception 'O resumo pode ter até 600 caracteres.' using errcode = '22023'; end if;

 -- Na ordem enviada, sem repetidos, só tutoriais da empresa.
 select coalesce(array_agg(t.id order by x.ord), '{}') into v_tutorials
 from (select e.value as id, min(e.ord) as ord
  from jsonb_array_elements_text(case when jsonb_typeof(p->'tutorials') = 'array' then p->'tutorials' else '[]' end)
   with ordinality e(value, ord)
  where e.value ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
  group by e.value) x
 join public.tutorials t on t.company_id = c and t.id = x.id::uuid;
 if cardinality(v_tutorials) > 50 then raise exception 'Uma trilha pode ter até 50 tutoriais.' using errcode = '22023'; end if;

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
  'sequential', coalesce((p->>'sequential')::boolean, false), 'tutorials', to_jsonb(v_tutorials),
  'aud_all', v_all, 'aud_roles', to_jsonb(v_roles), 'aud_teams', to_jsonb(v_teams), 'aud_users', to_jsonb(v_users),
  'aud_exclude', to_jsonb(v_exclude), 'req_newcomers', v_new, 'req_all', v_rall, 'req_roles', to_jsonb(v_rroles),
  'req_teams', to_jsonb(v_rteams), 'req_users', to_jsonb(v_rusers), 'due_days', v_due);
end $$;
revoke all on function mavi_private.trail_ids(uuid, jsonb, text), mavi_private.trail_roles(jsonb),
 mavi_private.trail_clean(uuid, jsonb) from public, anon, authenticated;

-- ------------------------------------------------------------ chegada e atrasos
-- A trilha chega a quem é obrigado e ainda não a recebeu: linha nova e
-- aviso (menos para quem publicou e para quem já concluiu tudo).
create function mavi_private.tutorial_trail_assign(p_trail uuid) returns integer
language plpgsql security definer set search_path = '' as $$
declare tr public.tutorial_trails; v_users uuid[]; v_total integer; v_body text; begin
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
 v_body := case when v_total = 1 then '1 tutorial' else v_total || ' tutoriais' end
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

-- A cada 10 minutos: quem passou a ser obrigado recebe; prazo vencido avisa
-- uma vez.
create function mavi_private.tutorial_trails_run() returns void
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
    format('O prazo era %s. Faltam %s de %s tutoriais.',
     mavi_private.trail_day(a.company_id, mavi_private.trail_due_at(a.trail, a.assigned_at)), c.total - c.done, c.total),
    '/tutoriais?trilha=' || a.trail_id);
  end if;
  update public.tutorial_trail_assignments set overdue_notified_at = now()
  where trail_id = a.trail_id and user_id = a.user_id;
 end loop;
end $$;
revoke all on function mavi_private.tutorial_trail_assign(uuid), mavi_private.tutorial_trails_run()
 from public, anon, authenticated;

-- ------------------------------------------------------------ salvar
-- Cria ou salva uma trilha. p_publish: publica (uma publicada salva direto
-- no ar). Devolve {id, status, revision}.
create function public.save_tutorial_trail(p_company uuid, p_trail uuid, p_content jsonb, p_publish boolean default false,
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
  raise exception 'Escolha ao menos um tutorial para a trilha.' using errcode = '22023';
 end if;

 update public.tutorial_trails set title = v->>'title', summary = v->>'summary',
  sequential = (v->>'sequential')::boolean,
  aud_all = (v->>'aud_all')::boolean, aud_roles = array(select jsonb_array_elements_text(v->'aud_roles')),
  aud_teams = array(select jsonb_array_elements_text(v->'aud_teams'))::uuid[],
  aud_users = array(select jsonb_array_elements_text(v->'aud_users'))::uuid[],
  aud_exclude = array(select jsonb_array_elements_text(v->'aud_exclude'))::uuid[],
  req_newcomers = (v->>'req_newcomers')::boolean,
  -- "Quem entrar a partir de agora" conta de quando a opção foi ligada.
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

 delete from public.tutorial_trail_items where trail_id = tr.id;
 insert into public.tutorial_trail_items(company_id, trail_id, tutorial_id, position)
 select tr.company_id, tr.id, x.id::uuid, x.ord
 from jsonb_array_elements_text(v->'tutorials') with ordinality x(id, ord);

 perform mavi_private.tutorial_trail_assign(tr.id);
 return jsonb_build_object('id', tr.id, 'status', tr.status, 'revision', tr.revision);
end $$;

-- Tira do ar (volta a rascunho; o progresso e as chegadas ficam).
create function public.unpublish_tutorial_trail(p_trail uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare tr public.tutorial_trails; begin
 select * into tr from public.tutorial_trails where id = p_trail for update;
 if not found or not mavi_private.trail_can_edit(tr) then raise exception 'Sem permissão' using errcode = '42501'; end if;
 update public.tutorial_trails set status = 'draft', revision = revision + 1, updated_by = auth.uid(), updated_at = now()
 where id = tr.id;
end $$;

create function public.delete_tutorial_trail(p_trail uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare tr public.tutorial_trails; begin
 select * into tr from public.tutorial_trails where id = p_trail for update;
 if not found or not mavi_private.trail_can_edit(tr) then
  raise exception 'Só um administrador ou o gestor que criou a trilha pode apagá-la.' using errcode = '42501';
 end if;
 delete from public.tutorial_trails where id = tr.id;
end $$;

-- ------------------------------------------------------------ progresso
-- p_action: 'open' (abriu), 'auto' (chegou ao fim; não vale para quem
-- desmarcou), 'complete' (o botão; também "li a versão nova") ou 'undo'.
-- Só nos tutoriais publicados que a pessoa vê (rascunhos não contam).
create function public.set_tutorial_progress(p_tutorial uuid, p_action text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare t public.tutorials; me uuid := auth.uid(); p public.tutorial_progress; v_before timestamptz; begin
 if p_action not in ('open', 'auto', 'complete', 'undo') then raise exception 'Ação inválida' using errcode = '22023'; end if;
 select * into t from public.tutorials where id = p_tutorial;
 if not found or not mavi_private.tutorial_for_user(t, me) then return null; end if;
 select completed_at into v_before from public.tutorial_progress
 where company_id = t.company_id and user_id = me and tutorial_id = t.id;

 insert into public.tutorial_progress(company_id, user_id, tutorial_id) values (t.company_id, me, t.id)
 on conflict do nothing;
 if p_action = 'auto' then
  update public.tutorial_progress set completed_at = now(), completed_version = t.version, completed_how = 'auto'
  where company_id = t.company_id and user_id = me and tutorial_id = t.id and completed_at is null and undone_at is null;
 elsif p_action = 'complete' then
  update public.tutorial_progress set completed_at = now(), completed_version = t.version, completed_how = 'manual',
   undone_at = null
  where company_id = t.company_id and user_id = me and tutorial_id = t.id;
 elsif p_action = 'undo' then
  update public.tutorial_progress set completed_at = null, completed_version = null, completed_how = null, undone_at = now()
  where company_id = t.company_id and user_id = me and tutorial_id = t.id;
 end if;
 select * into p from public.tutorial_progress where company_id = t.company_id and user_id = me and tutorial_id = t.id;
 -- Quem acompanha o progresso (e as trilhas da própria pessoa) relê.
 if p.completed_at is distinct from v_before then
  perform mavi_private.broadcast(t.company_id, jsonb_build_object('kind', 'tutorials', 'progress', true, 'user', me,
   'tutorial', t.id));
 end if;
 return jsonb_build_object('completed_at', p.completed_at, 'completed_version', p.completed_version,
  'completed_how', p.completed_how, 'undone', p.undone_at is not null);
end $$;

-- Pede que releiam: quem concluiu volta a pendente (quem edita, depois de
-- publicar uma alteração). Devolve quantas pessoas voltaram.
create function public.ask_tutorial_reread(p_tutorial uuid) returns integer
language plpgsql security definer set search_path = '' as $$
declare t public.tutorials; v_count integer; begin
 select * into t from public.tutorials where id = p_tutorial;
 if not found or not mavi_private.tutorial_can_edit(t) then raise exception 'Sem permissão' using errcode = '42501'; end if;
 update public.tutorial_progress set completed_at = null, completed_version = null, completed_how = null, undone_at = null
 where company_id = t.company_id and tutorial_id = t.id and completed_at is not null;
 get diagnostics v_count = row_count;
 if v_count > 0 then
  perform mavi_private.broadcast(t.company_id, jsonb_build_object('kind', 'tutorials', 'progress', true,
   'tutorial', t.id));
 end if;
 return v_count;
end $$;

-- ------------------------------------------------------------ ler
-- As trilhas que a pessoa vê (líderes: também as publicadas fora do seu
-- público e os rascunhos que editam), com o progresso dela e, para os
-- líderes, o resumo do time.
create function public.list_tutorial_trails(p_company uuid)
returns table(id uuid, title text, summary text, sequential boolean, status text, aud_all boolean, required boolean,
 due_days integer, for_me boolean, required_for_me boolean, assigned_at timestamptz, due_at timestamptz,
 total integer, done integer, next_tutorial uuid, can_edit boolean, created_by uuid, author_name text,
 updated_at timestamptz, people integer, people_done integer, people_overdue integer)
language plpgsql stable security definer set search_path = '' as $$
declare me uuid := auth.uid(); v_leader boolean; begin
 if not mavi_private.member(p_company) then raise exception 'Sem acesso ao espaço' using errcode = '42501'; end if;
 v_leader := mavi_private.leader(p_company);
 return query
 with seen as (
  select tr, mavi_private.trail_for_user(tr, me) as mine, mavi_private.trail_required_for(tr, me) as req,
   mavi_private.trail_can_edit(tr) as editor
  from public.tutorial_trails tr
  where tr.company_id = p_company and mavi_private.trail_can_see(tr)),
 team as (
  select (s.tr).id as trail_id, count(*)::integer as people,
   count(*) filter (where c.total > 0 and c.done = c.total)::integer as people_done,
   count(*) filter (where r.required and not (c.total > 0 and c.done = c.total)
    and mavi_private.trail_due_at(s.tr, x.assigned_at) < now())::integer as people_overdue
  from seen s
  join public.memberships m on m.company_id = p_company and m.active
  cross join lateral (select mavi_private.trail_required_for(s.tr, m.user_id) as required) r
  cross join lateral mavi_private.trail_counts(s.tr, m.user_id) c
  left join public.tutorial_trail_assignments x on x.trail_id = (s.tr).id and x.user_id = m.user_id
  where v_leader and (s.tr).status = 'published' and mavi_private.trail_for_user(s.tr, m.user_id)
  group by (s.tr).id)
 select (s.tr).id, (s.tr).title, (s.tr).summary, (s.tr).sequential, (s.tr).status, (s.tr).aud_all,
  mavi_private.trail_has_required(s.tr), (s.tr).due_days, s.mine, s.req, x.assigned_at,
  case when s.req then mavi_private.trail_due_at(s.tr, x.assigned_at) end,
  c.total, c.done, mavi_private.trail_next(s.tr, me), s.editor, (s.tr).created_by,
  mavi_private.member_name(p_company, (s.tr).created_by), (s.tr).updated_at,
  tm.people, tm.people_done, tm.people_overdue
 from seen s
 cross join lateral mavi_private.trail_counts(s.tr, me) c
 left join public.tutorial_trail_assignments x on x.trail_id = (s.tr).id and x.user_id = me
 left join team tm on tm.trail_id = (s.tr).id
 order by
  -- Obrigatórias pendentes primeiro (o prazo mais perto antes).
  (s.req and not (c.total > 0 and c.done = c.total)) desc,
  mavi_private.trail_due_at(s.tr, x.assigned_at) nulls last,
  s.mine desc, (s.tr).status desc, (s.tr).title, (s.tr).id;
end $$;

-- Tudo de uma trilha para a tela: os tutoriais na ordem com o progresso da
-- pessoa e, para quem edita e os líderes, a configuração.
create function public.tutorial_trail_detail(p_trail uuid) returns jsonb
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
  'items', coalesce((
   select jsonb_agg(jsonb_build_object('tutorial_id', t.id, 'title', t.title, 'summary', t.summary,
     'modules', to_jsonb(t.modules), 'status', t.status, 'version', t.version, 'aud_all', t.aud_all,
     'visible', v.visible, 'completed_at', p.completed_at, 'completed_version', p.completed_version,
     'video_count', (select count(*)::integer from public.tutorial_media m
      where m.company_id = t.company_id and m.tutorial_id = t.id and m.status = 'ready'))
    order by i.position)
   from public.tutorial_trail_items i
   join public.tutorials t on t.company_id = i.company_id and t.id = i.tutorial_id
   cross join lateral (select mavi_private.tutorial_for_user(t, me) as visible) v
   left join public.tutorial_progress p on p.company_id = i.company_id and p.user_id = me and p.tutorial_id = t.id
   -- Quem não edita só vê os tutoriais que tem.
   where i.trail_id = tr.id and (v.visible or v_edit)), '[]'),
  'can_edit', v_edit);
end $$;

-- O progresso de cada pessoa que tem a trilha (líderes), os atrasados antes.
create function public.tutorial_trail_progress(p_trail uuid)
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
   where pr.company_id = tr.company_id and pr.user_id = r.user_id and pr.completed_at is not null), '{}'),
  r.st
 from rated r
 order by array_position(array['overdue', 'todo', 'progress', 'done'], r.st), r.due nulls last, r.name, r.user_id;
end $$;

-- Quantas trilhas obrigatórias a pessoa ainda não concluiu (o número no menu).
create function public.my_tutorial_trails_pending(p_company uuid) returns integer
language sql stable security definer set search_path = '' as $$
 select count(*)::integer from public.tutorial_trails tr
 where tr.company_id = p_company and mavi_private.member(p_company) and tr.status = 'published'
  and mavi_private.trail_required_for(tr, auth.uid()) and not mavi_private.trail_done(tr, auth.uid())
$$;

-- A da migração 20270420090000, com o progresso da pessoa e as trilhas que
-- têm o tutorial.
create or replace function public.tutorial_detail(p_tutorial uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare t public.tutorials; d public.tutorial_drafts; v_edit boolean; p public.tutorial_progress; begin
 select * into t from public.tutorials where id = p_tutorial;
 if not found or not mavi_private.tutorial_can_see(t) then return null; end if;
 v_edit := mavi_private.tutorial_can_edit(t);
 if v_edit then select * into d from public.tutorial_drafts where tutorial_id = t.id; end if;
 select * into p from public.tutorial_progress x where x.company_id = t.company_id and x.user_id = auth.uid()
  and x.tutorial_id = t.id;
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
    'size_bytes', m.size_bytes, 'duration_seconds', m.duration_seconds, 'transcript', m.transcript,
    'transcript_status', m.transcript_status, 'transcript_source', m.transcript_source,
    'transcript_error', case when v_edit then m.transcript_error end) order by m.created_at)
   from public.tutorial_media m where m.company_id = t.company_id and m.tutorial_id = t.id and m.status = 'ready'), '[]'),
  'draft', case when d.tutorial_id is not null then jsonb_build_object('content', d.content, 'saved_at', d.saved_at,
   'saved_by_name', mavi_private.member_name(t.company_id, d.saved_by)) end,
  'can_edit', v_edit,
  'trackable', mavi_private.tutorial_for_user(t, auth.uid()),
  'progress', case when p.tutorial_id is not null then jsonb_build_object('completed_at', p.completed_at,
   'completed_version', p.completed_version, 'completed_how', p.completed_how, 'undone', p.undone_at is not null) end,
  'trails', coalesce((select jsonb_agg(jsonb_build_object('id', tr.id, 'title', tr.title) order by tr.title)
   from public.tutorial_trail_items i join public.tutorial_trails tr on tr.id = i.trail_id
   where i.company_id = t.company_id and i.tutorial_id = t.id and mavi_private.trail_can_see(tr)), '[]'));
end $$;

-- ------------------------------------------------------------ avisos ao vivo
create function mavi_private.broadcast_tutorial_trail() returns trigger
language plpgsql security definer set search_path = '' as $$ begin
 perform mavi_private.broadcast(coalesce(new.company_id, old.company_id), jsonb_build_object('kind', 'tutorials',
  'trails', true, 'trail', coalesce(new.id, old.id)));
 return null;
end $$;
revoke all on function mavi_private.broadcast_tutorial_trail() from public, anon, authenticated;
create trigger broadcast_tutorial_trail after insert or update or delete on public.tutorial_trails
 for each row execute function mavi_private.broadcast_tutorial_trail();

-- ------------------------------------------------------------ permissões
revoke all on function public.save_tutorial_trail(uuid, uuid, jsonb, boolean, integer),
 public.unpublish_tutorial_trail(uuid), public.delete_tutorial_trail(uuid), public.set_tutorial_progress(uuid, text),
 public.ask_tutorial_reread(uuid), public.list_tutorial_trails(uuid), public.tutorial_trail_detail(uuid),
 public.tutorial_trail_progress(uuid), public.my_tutorial_trails_pending(uuid)
 from public, anon, authenticated;
grant execute on function public.save_tutorial_trail(uuid, uuid, jsonb, boolean, integer),
 public.unpublish_tutorial_trail(uuid), public.delete_tutorial_trail(uuid), public.set_tutorial_progress(uuid, text),
 public.ask_tutorial_reread(uuid), public.list_tutorial_trails(uuid), public.tutorial_trail_detail(uuid),
 public.tutorial_trail_progress(uuid), public.my_tutorial_trails_pending(uuid)
 to authenticated;

-- ------------------------------------------------------------ agendamento
-- O PostgreSQL dos testes não tem pg_cron.
do $$ begin
 if exists(select 1 from pg_available_extensions where name = 'pg_cron') then
  create extension if not exists pg_cron;
  perform cron.schedule('mavi-tutorial-trails', '*/10 * * * *', 'select mavi_private.tutorial_trails_run()');
 else
  raise notice 'pg_cron unavailable: schedule mavi_private.tutorial_trails_run() on the hosted database';
 end if;
end $$;

notify pgrst, 'reload schema';

commit;
