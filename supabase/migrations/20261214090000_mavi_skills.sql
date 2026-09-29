begin;

-- MAVI · Skills (Fase 2 da orquestradora):
--
-- 1. Uma skill é um jeito de trabalhar que a MAVI aprende: nome, descrição
--    (quando usar), instruções e arquivos de referência (texto), no formato
--    das Skills da Claude (SKILL.md). A MAVI vê só o nome e a descrição das
--    skills que a pessoa pode usar e carrega o resto quando decide usar.
-- 2. Qualquer pessoa cria; administradores e gestores aprovam (as deles já
--    nascem publicadas). Editar uma skill publicada abre uma versão nova,
--    que volta para aprovação; a publicada continua valendo até aprovarem.
--    Cada versão fica guardada e não muda depois de enviada; líderes
--    restauram uma versão antiga (vira uma versão nova, publicada).
-- 3. Quem pode usar cada skill: todos, ou equipes e pessoas, com exceções
--    (os líderes decidem). O poder 'skills' liga as skills na empresa.
-- 4. Quem criou testa a versão ainda não aprovada nas próprias conversas.
-- 5. Cada uso registra a skill e a versão (ai_tool_calls). Aviso na caixa
--    de entrada: skill para aprovar, e a sua aprovada ou devolvida.
-- Tudo por funções: as tabelas não se leem direto.

-- ------------------------------------------------------------ poder 'skills'
alter table public.ai_powers drop constraint ai_powers_power_check;
alter table public.ai_powers add constraint ai_powers_power_check
 check (power in ('visuals', 'images', 'actions', 'skills'));
alter table public.ai_tool_calls drop constraint ai_tool_calls_power_check;
alter table public.ai_tool_calls add constraint ai_tool_calls_power_check
 check (power in ('visuals', 'images', 'actions', 'skills'));

create or replace function public.ai_my_powers(p_company uuid) returns text[]
language sql stable security definer set search_path = '' as $$
 select coalesce(array_agg(p order by p), '{}') from unnest(array['actions', 'images', 'skills', 'visuals']) p
 where mavi_private.member(p_company) and mavi_private.ai_power_on(p_company, auth.uid(), p)
$$;

create or replace function public.ai_powers_admin(p_company uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$ begin
 if not mavi_private.leader(p_company) then
  raise exception 'Só administradores e gestores configuram os poderes da MAVI.' using errcode = '42501';
 end if;
 return (select coalesce(jsonb_agg(jsonb_build_object('power', p.power,
   'enabled', coalesce(w.enabled, false), 'everyone', coalesce(w.everyone, true),
   'team_ids', to_jsonb(coalesce(w.team_ids, '{}')), 'user_ids', to_jsonb(coalesce(w.user_ids, '{}')),
   'except_ids', to_jsonb(coalesce(w.except_ids, '{}')), 'updated_at', w.updated_at, 'updated_by', w.updated_by)
   order by p.ord), '[]')
  from unnest(array['visuals', 'images', 'actions', 'skills']) with ordinality p(power, ord)
  left join public.ai_powers w on w.company_id = p_company and w.power = p.power);
end $$;

create or replace function public.ai_set_power(p_company uuid, p_power text, p_enabled boolean, p_everyone boolean,
 p_teams uuid[], p_users uuid[], p_except uuid[]) returns void
language plpgsql security definer set search_path = '' as $$
declare v_teams uuid[]; v_users uuid[]; v_except uuid[]; begin
 if not mavi_private.leader(p_company) then
  raise exception 'Só administradores e gestores configuram os poderes da MAVI.' using errcode = '42501';
 end if;
 if p_power not in ('visuals', 'images', 'actions', 'skills') then
  raise exception 'Poder inválido.' using errcode = '22023';
 end if;
 select coalesce(array_agg(distinct t), '{}') into v_teams from unnest(coalesce(p_teams, '{}')) t
 where exists (select 1 from public.teams x where x.company_id = p_company and x.id = t);
 select coalesce(array_agg(distinct u), '{}') into v_users from unnest(coalesce(p_users, '{}')) u
 where exists (select 1 from public.memberships x where x.company_id = p_company and x.user_id = u);
 select coalesce(array_agg(distinct u), '{}') into v_except from unnest(coalesce(p_except, '{}')) u
 where exists (select 1 from public.memberships x where x.company_id = p_company and x.user_id = u);
 if coalesce(p_enabled, false) and not coalesce(p_everyone, true)
  and cardinality(v_teams) = 0 and cardinality(v_users) = 0 then
  raise exception 'Escolha pelo menos uma equipe ou pessoa (ou libere para todos).' using errcode = '22023';
 end if;
 insert into public.ai_powers(company_id, power, enabled, everyone, team_ids, user_ids, except_ids, updated_by)
 values (p_company, p_power, coalesce(p_enabled, false), coalesce(p_everyone, true), v_teams, v_users, v_except,
  auth.uid())
 on conflict (company_id, power) do update set enabled = excluded.enabled, everyone = excluded.everyone,
  team_ids = excluded.team_ids, user_ids = excluded.user_ids, except_ids = excluded.except_ids,
  updated_by = auth.uid(), updated_at = now();
end $$;

-- ------------------------------------------------------------ skills
create table public.ai_skills (
 id uuid primary key default gen_random_uuid(),
 company_id uuid not null references public.companies(id),
 slug text not null check (slug ~ '^[a-z0-9][a-z0-9-]{1,62}$'),
 author_id uuid not null default auth.uid(),
 -- A versão que a MAVI usa (nula: ainda não aprovada).
 published integer,
 archived boolean not null default false,
 everyone boolean not null default true,
 team_ids uuid[] not null default '{}',
 user_ids uuid[] not null default '{}',
 except_ids uuid[] not null default '{}',
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 unique (company_id, slug),
 unique (company_id, id),
 foreign key (company_id, author_id) references public.memberships(company_id, user_id)
);
create table public.ai_skill_versions (
 company_id uuid not null,
 skill_id uuid not null,
 version integer not null check (version >= 1),
 name text not null check (length(btrim(name)) between 2 and 80),
 description text not null check (length(btrim(description)) between 10 and 600),
 instructions text not null check (length(btrim(instructions)) between 20 and 40000),
 state text not null default 'draft' check (state in ('draft', 'pending', 'approved', 'rejected', 'superseded')),
 note text check (length(note) <= 500),
 review_note text check (length(review_note) <= 500),
 created_by uuid not null default auth.uid(),
 created_at timestamptz not null default now(),
 submitted_at timestamptz,
 reviewed_by uuid,
 reviewed_at timestamptz,
 primary key (skill_id, version),
 foreign key (company_id, skill_id) references public.ai_skills(company_id, id) on delete cascade
);
create index ai_skill_versions_pending on public.ai_skill_versions(company_id) where state = 'pending';
-- Arquivos de referência de cada versão (texto; a MAVI lê quando precisa).
create table public.ai_skill_files (
 company_id uuid not null,
 skill_id uuid not null,
 version integer not null,
 name text not null check (name ~ '^[A-Za-z0-9._ ()-][A-Za-z0-9._ ()/-]{0,119}$' and name !~ '\.\.'
  and name !~ '//'),
 content text not null check (length(content) <= 200000),
 size_bytes integer not null default 0 check (size_bytes >= 0),
 primary key (skill_id, version, name),
 foreign key (skill_id, version) references public.ai_skill_versions(skill_id, version) on delete cascade
);
alter table public.ai_skills enable row level security;
alter table public.ai_skill_versions enable row level security;
alter table public.ai_skill_files enable row level security;
revoke all on public.ai_skills, public.ai_skill_versions, public.ai_skill_files from public, anon, authenticated;

alter table public.ai_tool_calls add column skill_id uuid, add column skill_version integer;
create index ai_tool_calls_skill on public.ai_tool_calls(skill_id, created_at desc) where skill_id is not null;

-- A pessoa pode usar a skill (publicada, não arquivada, no público dela e com o poder).
create function mavi_private.ai_skill_open(c uuid, u uuid, s public.ai_skills) returns boolean
language sql stable security definer set search_path = '' as $$
 select s.company_id = c and s.published is not null and not s.archived
  and mavi_private.ai_power_on(c, u, 'skills')
  and not (u = any(s.except_ids))
  and (s.everyone or u = any(s.user_ids) or exists (select 1 from public.team_members tm
   where tm.company_id = c and tm.user_id = u and tm.team_id = any(s.team_ids)))
$$;
-- Quem edita e vê todas as versões: quem criou e os líderes.
create function mavi_private.ai_skill_editor(s public.ai_skills) returns boolean
language sql stable security definer set search_path = '' as $$
 select mavi_private.member(s.company_id) and (s.author_id = auth.uid() or mavi_private.leader(s.company_id))
$$;
revoke all on function mavi_private.ai_skill_open(uuid, uuid, public.ai_skills),
 mavi_private.ai_skill_editor(public.ai_skills) from public, anon, authenticated;

-- Avisos na caixa de entrada.
alter table public.notifications drop constraint notifications_kind_check;
alter table public.notifications add constraint notifications_kind_check
 check (kind in ('mention', 'assigned', 'reply', 'social_leads', 'ai_share', 'success_case', 'notice',
  'notice_animation', 'temperature', 'tasks_assigned', 'due_risk', 'status', 'review', 'ai_skill'));
alter table public.notifications drop constraint notifications_target_check;
alter table public.notifications add constraint notifications_target_check
 check ((kind in ('social_leads', 'ai_share', 'success_case', 'notice', 'notice_animation', 'temperature',
   'tasks_assigned', 'due_risk', 'ai_skill')) = (task_id is null)
  and (task_id is not null or (title is not null and link is not null))
  and ((kind = 'notice') = (notice_id is not null)));
create or replace function mavi_private.notification_pref_keys() returns text[]
language sql immutable set search_path = '' as $$
 select array['assigned', 'mention', 'reply', 'review', 'due_risk',
  'social_leads', 'ai_share', 'success_case', 'temperature', 'ai_skill']
  || array(select 'status.' || s || '.' || r
   from unnest(array['progress', 'returned', 'review', 'rejected', 'correction', 'done']) s,
        unnest(array['creator', 'assignee', 'participant']) r)
$$;

create function mavi_private.ai_skill_notify(c uuid, p_users uuid[], p_skill uuid, p_title text, p_body text)
returns void language sql security definer set search_path = '' as $$
 insert into public.notifications(company_id, user_id, actor_id, task_id, kind, title, body, link)
 select c, u, auth.uid(), null, 'ai_skill', left(p_title, 300), left(p_body, 300), '/mavi/skills/' || p_skill
 from (select distinct x as u from unnest(coalesce(p_users, '{}')) x) q
 where u is distinct from auth.uid()
  and exists (select 1 from public.memberships m where m.company_id = c and m.user_id = u and m.active)
$$;
revoke all on function mavi_private.ai_skill_notify(uuid, uuid[], uuid, text, text) from public, anon, authenticated;

-- Os arquivos, de um jsonb [{name, content}] (até 20 e 1 MB no total).
create function mavi_private.ai_skill_put_files(c uuid, p_skill uuid, p_version integer, p_files jsonb)
returns void language plpgsql security definer set search_path = '' as $$ begin
 if jsonb_typeof(coalesce(p_files, '[]')) <> 'array' or jsonb_array_length(coalesce(p_files, '[]')) > 20 then
  raise exception 'Até 20 arquivos por skill.' using errcode = '22023';
 end if;
 if (select coalesce(sum(length(f->>'content')), 0) from jsonb_array_elements(coalesce(p_files, '[]')) f) > 1000000 then
  raise exception 'Os arquivos da skill passam de 1 MB de texto.' using errcode = '22023';
 end if;
 delete from public.ai_skill_files where skill_id = p_skill and version = p_version;
 insert into public.ai_skill_files(company_id, skill_id, version, name, content, size_bytes)
 select c, p_skill, p_version, btrim(f->>'name'), coalesce(f->>'content', ''), octet_length(coalesce(f->>'content', ''))
 from jsonb_array_elements(coalesce(p_files, '[]')) f;
exception when unique_violation then
 raise exception 'Dois arquivos com o mesmo nome.' using errcode = '22023';
end $$;
revoke all on function mavi_private.ai_skill_put_files(uuid, uuid, integer, jsonb) from public, anon, authenticated;

-- Publica a versão (a anterior aprovada fica no histórico).
create function mavi_private.ai_skill_publish(p_skill uuid, p_version integer) returns void
language sql security definer set search_path = '' as $$
 update public.ai_skill_versions set state = 'superseded'
 where skill_id = p_skill and state = 'approved' and version <> p_version;
 update public.ai_skill_versions set state = 'approved', reviewed_by = auth.uid(), reviewed_at = now(),
  submitted_at = coalesce(submitted_at, now())
 where skill_id = p_skill and version = p_version;
 update public.ai_skills set published = p_version, updated_at = now() where id = p_skill;
$$;
revoke all on function mavi_private.ai_skill_publish(uuid, integer) from public, anon, authenticated;

-- Cria ou edita. Sem p_skill: uma skill nova (versão 1). Com p_skill: a
-- última versão, se ainda for rascunho ou estiver esperando aprovação (volta
-- a rascunho); senão, uma versão nova. p_submit envia para aprovação (o
-- líder publica direto).
create function public.ai_skill_save(p_company uuid, p_skill uuid, p_slug text, p_name text, p_description text,
 p_instructions text, p_files jsonb, p_note text, p_submit boolean) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare s public.ai_skills; v record; v_version integer; v_state text; v_leader boolean; v_slug text; begin
 if not mavi_private.member(p_company) then raise exception 'Sem acesso ao espaço' using errcode = '42501'; end if;
 v_leader := mavi_private.leader(p_company);
 if p_skill is null then
  v_slug := lower(btrim(coalesce(p_slug, '')));
  if v_slug !~ '^[a-z0-9][a-z0-9-]{1,62}$' then
   raise exception 'O identificador usa letras minúsculas, números e hífens (ex.: relatorio-mensal).' using errcode = '22023';
  end if;
  if exists (select 1 from public.ai_skills where company_id = p_company and slug = v_slug) then
   raise exception 'Já existe uma skill com o identificador %.', v_slug using errcode = '23505';
  end if;
  insert into public.ai_skills(company_id, slug) values (p_company, v_slug) returning * into s;
  v_version := 1;
 else
  select * into s from public.ai_skills where id = p_skill and company_id = p_company for update;
  if s.id is null then raise exception 'Skill não encontrada.' using errcode = 'P0002'; end if;
  if not mavi_private.ai_skill_editor(s) then
   raise exception 'Só quem criou a skill e os líderes editam.' using errcode = '42501';
  end if;
  select version, state into v from public.ai_skill_versions where skill_id = s.id order by version desc limit 1;
  if v.state in ('draft', 'pending') then v_version := v.version;
  else v_version := v.version + 1; end if;
 end if;
 v_state := case when coalesce(p_submit, false) then (case when v_leader then 'approved' else 'pending' end)
  else 'draft' end;
 insert into public.ai_skill_versions(company_id, skill_id, version, name, description, instructions, state, note,
  submitted_at)
 values (p_company, s.id, v_version, btrim(coalesce(p_name, '')), btrim(coalesce(p_description, '')),
  btrim(coalesce(p_instructions, '')), case when v_state = 'approved' then 'draft' else v_state end,
  nullif(btrim(coalesce(p_note, '')), ''), case when v_state <> 'draft' then now() end)
 on conflict (skill_id, version) do update set name = excluded.name, description = excluded.description,
  instructions = excluded.instructions, state = excluded.state, note = excluded.note,
  submitted_at = excluded.submitted_at, created_by = auth.uid(), created_at = now(),
  review_note = null, reviewed_by = null, reviewed_at = null;
 perform mavi_private.ai_skill_put_files(p_company, s.id, v_version, p_files);
 if v_state = 'approved' then
  perform mavi_private.ai_skill_publish(s.id, v_version);
 elsif v_state = 'pending' then
  perform mavi_private.ai_skill_notify(p_company,
   array(select m.user_id from public.memberships m where m.company_id = p_company and m.active
    and m.role in ('admin', 'manager')), s.id,
   'Skill da MAVI para aprovar', btrim(p_name) || ' · versão ' || v_version);
 end if;
 update public.ai_skills set updated_at = now() where id = s.id;
 return jsonb_build_object('id', s.id, 'slug', s.slug, 'version', v_version,
  'state', (select state from public.ai_skill_versions where skill_id = s.id and version = v_version));
end $$;

-- Aprovar ou devolver a versão que espera (líderes).
create function public.ai_skill_review(p_skill uuid, p_version integer, p_approve boolean, p_note text)
returns void language plpgsql security definer set search_path = '' as $$
declare s public.ai_skills; v public.ai_skill_versions; begin
 select * into s from public.ai_skills where id = p_skill;
 if s.id is null or not mavi_private.leader(s.company_id) then
  raise exception 'Só administradores e gestores aprovam skills.' using errcode = '42501';
 end if;
 select * into v from public.ai_skill_versions where skill_id = p_skill and version = p_version for update;
 if v.state is distinct from 'pending' then
  raise exception 'Esta versão não está esperando aprovação.' using errcode = 'P0002';
 end if;
 if not coalesce(p_approve, false) and length(btrim(coalesce(p_note, ''))) < 3 then
  raise exception 'Diga o que precisa mudar.' using errcode = '22023';
 end if;
 update public.ai_skill_versions set review_note = nullif(btrim(coalesce(p_note, '')), '')
 where skill_id = p_skill and version = p_version;
 if p_approve then
  perform mavi_private.ai_skill_publish(p_skill, p_version);
 else
  update public.ai_skill_versions set state = 'rejected', reviewed_by = auth.uid(), reviewed_at = now()
  where skill_id = p_skill and version = p_version;
 end if;
 perform mavi_private.ai_skill_notify(s.company_id, array[v.created_by, s.author_id], s.id,
  case when p_approve then 'Sua skill foi aprovada' else 'Sua skill voltou para ajustes' end,
  v.name || ' · versão ' || v.version || coalesce(' · ' || nullif(btrim(coalesce(p_note, '')), ''), ''));
end $$;

-- Volta a uma versão antiga: uma versão nova, igual a ela, já publicada (líderes).
create function public.ai_skill_restore(p_skill uuid, p_version integer) returns integer
language plpgsql security definer set search_path = '' as $$
declare s public.ai_skills; v public.ai_skill_versions; n integer; begin
 select * into s from public.ai_skills where id = p_skill for update;
 if s.id is null or not mavi_private.leader(s.company_id) then
  raise exception 'Só administradores e gestores restauram versões.' using errcode = '42501';
 end if;
 select * into v from public.ai_skill_versions where skill_id = p_skill and version = p_version;
 if v.version is null or v.state not in ('approved', 'superseded') then
  raise exception 'Só dá para restaurar uma versão que já foi publicada.' using errcode = '22023';
 end if;
 -- Um rascunho ou pedido em aberto fica para trás: a restauração vem depois dele.
 select max(version) + 1 into n from public.ai_skill_versions where skill_id = p_skill;
 insert into public.ai_skill_versions(company_id, skill_id, version, name, description, instructions, state, note,
  submitted_at)
 values (s.company_id, p_skill, n, v.name, v.description, v.instructions, 'draft',
  'Restaurada da versão ' || p_version, now());
 insert into public.ai_skill_files(company_id, skill_id, version, name, content, size_bytes)
 select company_id, skill_id, n, name, content, size_bytes from public.ai_skill_files
 where skill_id = p_skill and version = p_version;
 update public.ai_skill_versions set state = 'superseded'
 where skill_id = p_skill and version < n and state in ('draft', 'pending');
 perform mavi_private.ai_skill_publish(p_skill, n);
 return n;
end $$;

create function public.ai_skill_set_audience(p_skill uuid, p_everyone boolean, p_teams uuid[], p_users uuid[],
 p_except uuid[]) returns void
language plpgsql security definer set search_path = '' as $$
declare s public.ai_skills; begin
 select * into s from public.ai_skills where id = p_skill;
 if s.id is null or not mavi_private.leader(s.company_id) then
  raise exception 'Só administradores e gestores dizem quem usa cada skill.' using errcode = '42501';
 end if;
 update public.ai_skills set everyone = coalesce(p_everyone, true),
  team_ids = coalesce((select array_agg(distinct t) from unnest(coalesce(p_teams, '{}')) t
   where exists (select 1 from public.teams x where x.company_id = s.company_id and x.id = t)), '{}'),
  user_ids = coalesce((select array_agg(distinct u) from unnest(coalesce(p_users, '{}')) u
   where exists (select 1 from public.memberships x where x.company_id = s.company_id and x.user_id = u)), '{}'),
  except_ids = coalesce((select array_agg(distinct u) from unnest(coalesce(p_except, '{}')) u
   where exists (select 1 from public.memberships x where x.company_id = s.company_id and x.user_id = u)), '{}'),
  updated_at = now()
 where id = p_skill;
 if not coalesce(p_everyone, true) and (select cardinality(team_ids) + cardinality(user_ids)
  from public.ai_skills where id = p_skill) = 0 then
  raise exception 'Escolha pelo menos uma equipe ou pessoa (ou libere para todos).' using errcode = '22023';
 end if;
end $$;

-- Arquivar (a MAVI deixa de usar) ou apagar: quem criou e os líderes.
create function public.ai_skill_archive(p_skill uuid, p_archived boolean) returns void
language plpgsql security definer set search_path = '' as $$
declare s public.ai_skills; begin
 select * into s from public.ai_skills where id = p_skill;
 if s.id is null or not mavi_private.ai_skill_editor(s) then
  raise exception 'Só quem criou a skill e os líderes arquivam.' using errcode = '42501';
 end if;
 update public.ai_skills set archived = coalesce(p_archived, true), updated_at = now() where id = p_skill;
end $$;
create function public.ai_skill_delete(p_skill uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare s public.ai_skills; begin
 select * into s from public.ai_skills where id = p_skill;
 if s.id is null or not mavi_private.ai_skill_editor(s)
  or (s.published is not null and not mavi_private.leader(s.company_id)) then
  raise exception 'Uma skill publicada só os líderes apagam (quem criou pode arquivar).' using errcode = '42501';
 end if;
 delete from public.ai_skills where id = p_skill;
end $$;

-- ------------------------------------------------------------ leitura (tela)
-- As skills que a pessoa vê: as que pode usar, as dela e, para líderes, todas.
create function public.ai_skills_list(p_company uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare me uuid := auth.uid(); v_leader boolean; begin
 if not mavi_private.member(p_company) then raise exception 'Sem acesso ao espaço' using errcode = '42501'; end if;
 v_leader := mavi_private.leader(p_company);
 return (select coalesce(jsonb_agg(jsonb_build_object(
   'id', s.id, 'slug', s.slug, 'author_id', s.author_id, 'published', s.published, 'archived', s.archived,
   'everyone', s.everyone, 'team_ids', to_jsonb(s.team_ids), 'user_ids', to_jsonb(s.user_ids),
   'except_ids', to_jsonb(s.except_ids), 'updated_at', s.updated_at,
   'available', mavi_private.ai_skill_open(p_company, me, s),
   'mine', s.author_id = me,
   'current', (select jsonb_build_object('version', v.version, 'name', v.name, 'description', v.description)
     from public.ai_skill_versions v where v.skill_id = s.id and v.version = s.published),
   'latest', (select jsonb_build_object('version', v.version, 'name', v.name, 'description', v.description,
      'state', v.state, 'review_note', v.review_note)
     from public.ai_skill_versions v where v.skill_id = s.id order by v.version desc limit 1),
   'uses_30d', (select count(*) from public.ai_tool_calls t where t.skill_id = s.id
     and t.created_at > now() - interval '30 days'))
  order by lower(coalesce((select v.name from public.ai_skill_versions v where v.skill_id = s.id
   and v.version = s.published), s.slug))), '[]')
 from public.ai_skills s
 where s.company_id = p_company and (v_leader or s.author_id = me or mavi_private.ai_skill_open(p_company, me, s)));
end $$;

-- Uma skill com uma versão (nula: a publicada, ou a última para quem edita)
-- e, para quem edita, o histórico.
create function public.ai_skill_get(p_skill uuid, p_version integer default null) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare s public.ai_skills; v public.ai_skill_versions; v_edit boolean; begin
 select * into s from public.ai_skills where id = p_skill;
 if s.id is null or not mavi_private.member(s.company_id) then
  raise exception 'Skill não encontrada.' using errcode = 'P0002';
 end if;
 v_edit := mavi_private.ai_skill_editor(s);
 if not v_edit and (not mavi_private.ai_skill_open(s.company_id, auth.uid(), s)
  or (p_version is not null and p_version <> s.published)) then
  raise exception 'Skill não encontrada.' using errcode = 'P0002';
 end if;
 select * into v from public.ai_skill_versions where skill_id = p_skill
  and version = coalesce(p_version, case when v_edit then
   (select max(version) from public.ai_skill_versions where skill_id = p_skill) else s.published end);
 if v.version is null then raise exception 'Versão não encontrada.' using errcode = 'P0002'; end if;
 return jsonb_build_object('id', s.id, 'slug', s.slug, 'author_id', s.author_id, 'published', s.published,
  'archived', s.archived, 'everyone', s.everyone, 'team_ids', to_jsonb(s.team_ids),
  'user_ids', to_jsonb(s.user_ids), 'except_ids', to_jsonb(s.except_ids), 'editable', v_edit,
  'available', mavi_private.ai_skill_open(s.company_id, auth.uid(), s),
  'version', jsonb_build_object('version', v.version, 'name', v.name, 'description', v.description,
   'instructions', v.instructions, 'state', v.state, 'note', v.note, 'review_note', v.review_note,
   'created_by', v.created_by, 'created_at', v.created_at, 'reviewed_by', v.reviewed_by, 'reviewed_at', v.reviewed_at,
   'files', (select coalesce(jsonb_agg(jsonb_build_object('name', f.name, 'content', f.content,
     'size', f.size_bytes) order by f.name), '[]') from public.ai_skill_files f
    where f.skill_id = s.id and f.version = v.version)),
  'versions', case when v_edit then (select coalesce(jsonb_agg(jsonb_build_object('version', x.version,
    'name', x.name, 'state', x.state, 'note', x.note, 'review_note', x.review_note, 'created_by', x.created_by,
    'created_at', x.created_at, 'reviewed_by', x.reviewed_by, 'reviewed_at', x.reviewed_at,
    'uses', (select count(*) from public.ai_tool_calls t where t.skill_id = s.id and t.skill_version = x.version))
    order by x.version desc), '[]') from public.ai_skill_versions x where x.skill_id = s.id) else '[]' end);
end $$;

create function public.ai_skill_review_count(p_company uuid) returns integer
language sql stable security definer set search_path = '' as $$
 select case when mavi_private.leader(p_company) then (select count(*)::integer from public.ai_skill_versions v
  join public.ai_skills s on s.id = v.skill_id
  where v.company_id = p_company and v.state = 'pending' and not s.archived) else 0 end
$$;

-- ------------------------------------------------------------ leitura (MAVI)
-- O catálogo desta pessoa: nome e descrição das skills que ela pode usar.
create function public.ai_skill_catalog(p_company uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
 select coalesce(jsonb_agg(jsonb_build_object('slug', s.slug, 'version', v.version, 'name', v.name,
   'description', v.description) order by lower(v.name)), '[]')
 from public.ai_skills s join public.ai_skill_versions v on v.skill_id = s.id and v.version = s.published
 where mavi_private.member(p_company) and s.company_id = p_company
  and mavi_private.ai_skill_open(p_company, auth.uid(), s)
$$;

-- As instruções (e a lista dos arquivos) de uma skill. Com p_version, a versão
-- em teste: só para quem edita a skill.
create function public.ai_skill_load(p_company uuid, p_slug text, p_version integer default null) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare s public.ai_skills; v public.ai_skill_versions; begin
 select * into s from public.ai_skills where company_id = p_company and slug = lower(btrim(coalesce(p_slug, '')));
 if s.id is null or not mavi_private.member(p_company) then return null; end if;
 if p_version is null then
  if not mavi_private.ai_skill_open(p_company, auth.uid(), s) then return null; end if;
 elsif not (mavi_private.ai_skill_editor(s) and mavi_private.ai_power_on(p_company, auth.uid(), 'skills')) then
  return null;
 end if;
 select * into v from public.ai_skill_versions where skill_id = s.id and version = coalesce(p_version, s.published);
 if v.version is null then return null; end if;
 return jsonb_build_object('id', s.id, 'slug', s.slug, 'version', v.version, 'name', v.name,
  'description', v.description, 'instructions', v.instructions, 'test', p_version is not null,
  'files', (select coalesce(jsonb_agg(jsonb_build_object('name', f.name, 'size', f.size_bytes) order by f.name), '[]')
   from public.ai_skill_files f where f.skill_id = s.id and f.version = v.version));
end $$;

create function public.ai_skill_file(p_company uuid, p_slug text, p_version integer, p_name text) returns text
language plpgsql stable security definer set search_path = '' as $$
declare s public.ai_skills; begin
 select * into s from public.ai_skills where company_id = p_company and slug = lower(btrim(coalesce(p_slug, '')));
 if s.id is null or not mavi_private.member(p_company) then return null; end if;
 if not (mavi_private.ai_skill_open(p_company, auth.uid(), s) and p_version = s.published)
  and not (mavi_private.ai_skill_editor(s) and mavi_private.ai_power_on(p_company, auth.uid(), 'skills')) then
  return null;
 end if;
 return (select content from public.ai_skill_files where skill_id = s.id and version = p_version and name = p_name);
end $$;

-- As chamadas também dizem a skill e a versão.
create or replace function public.ai_log_tool_calls(p_company uuid, p_conversation uuid, p_module text, p_calls jsonb)
returns void
language plpgsql security definer set search_path = '' as $$
declare v_conversation uuid := p_conversation; begin
 if not mavi_private.member(p_company) then raise exception 'Sem permissão.' using errcode = '42501'; end if;
 if jsonb_typeof(coalesce(p_calls, '[]')) <> 'array' or jsonb_array_length(coalesce(p_calls, '[]')) > 60 then
  raise exception 'Lista de chamadas inválida.' using errcode = '22023';
 end if;
 if v_conversation is not null and not exists (select 1 from public.ai_conversations v
  where v.company_id = p_company and v.id = v_conversation and v.owner_id = auth.uid()) then
  v_conversation := null;
 end if;
 insert into public.ai_tool_calls(company_id, conversation_id, module, tool, power, ok, duration_ms, cost_usd, error,
  skill_id, skill_version)
 select p_company, v_conversation, left(coalesce(p_module, 'assistant'), 40), left(x.tool, 80),
  case when x.power in ('visuals', 'images', 'actions', 'skills') then x.power end, coalesce(x.ok, false),
  least(greatest(coalesce(x.ms, 0), 0), 3600000), least(greatest(coalesce(x.cost, 0), 0), 100),
  left(x.error, 300),
  (select k.id from public.ai_skills k where k.company_id = p_company and k.id = x.skill),
  case when exists (select 1 from public.ai_skills k where k.company_id = p_company and k.id = x.skill)
   then x.skill_version end
 from jsonb_to_recordset(coalesce(p_calls, '[]')) as x(tool text, power text, ok boolean, ms integer, cost numeric,
  error text, skill uuid, skill_version integer)
 where coalesce(btrim(x.tool), '') <> '';
end $$;

revoke all on function public.ai_skill_save(uuid, uuid, text, text, text, text, jsonb, text, boolean),
 public.ai_skill_review(uuid, integer, boolean, text), public.ai_skill_restore(uuid, integer),
 public.ai_skill_set_audience(uuid, boolean, uuid[], uuid[], uuid[]), public.ai_skill_archive(uuid, boolean),
 public.ai_skill_delete(uuid), public.ai_skills_list(uuid), public.ai_skill_get(uuid, integer),
 public.ai_skill_review_count(uuid), public.ai_skill_catalog(uuid), public.ai_skill_load(uuid, text, integer),
 public.ai_skill_file(uuid, text, integer, text) from public, anon;
grant execute on function public.ai_skill_save(uuid, uuid, text, text, text, text, jsonb, text, boolean),
 public.ai_skill_review(uuid, integer, boolean, text), public.ai_skill_restore(uuid, integer),
 public.ai_skill_set_audience(uuid, boolean, uuid[], uuid[], uuid[]), public.ai_skill_archive(uuid, boolean),
 public.ai_skill_delete(uuid), public.ai_skills_list(uuid), public.ai_skill_get(uuid, integer),
 public.ai_skill_review_count(uuid), public.ai_skill_catalog(uuid), public.ai_skill_load(uuid, text, integer),
 public.ai_skill_file(uuid, text, integer, text) to authenticated;

commit;
