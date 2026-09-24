begin;

-- Dashboards (a native, Grafana-like module). Leaders (admins and managers)
-- build dashboards of panels; each panel holds up to five queries (A–E) over
-- the company's tasks or hours, an optional formula combining them and a
-- visualization. Nobody writes SQL: a query is a JSON spec (source, metric,
-- date field, filters) and mavi_private.dashboard_sql turns it into SQL only
-- from the whitelisted names below, always scoped to the dashboard's company.
--
-- Access: leaders edit every dashboard of the company; chosen people and
-- teams view it in the app; the share link opens it for anyone (public) or
-- with a password. Viewers see figures of the whole company scope the
-- dashboard defines — sharing a dashboard shares its aggregates.
--
-- Performance: everything is aggregated in the database, one panel per call
-- (the page loads panels in parallel, as they scroll into view); categories
-- come back as the top N plus "Outros", time series as at most 400 buckets;
-- results are cached for 60 seconds per panel, period and filters.

create extension if not exists pgcrypto with schema extensions;

create table public.dashboards (
 id uuid primary key default gen_random_uuid(),
 company_id uuid not null references public.companies(id),
 name text not null check (length(trim(name)) between 2 and 120),
 description text not null default '' check (length(description) <= 500),
 -- [{id, title, x, y, w, h, spec}] on a 12-column grid.
 panels jsonb not null default '[]',
 -- {range: {preset} | {from, to}, filters: {clients, products, teams, people}}
 variables jsonb not null default '{}',
 link_access text not null default 'none' check (link_access in ('none','password','public')),
 share_token text not null unique default (replace(gen_random_uuid()::text,'-','') || replace(gen_random_uuid()::text,'-','')),
 password_hash text,
 has_password boolean generated always as (password_hash is not null) stored,
 version integer not null default 1,
 created_by uuid not null default auth.uid(),
 updated_by uuid,
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 unique (company_id, id),
 foreign key (company_id, created_by) references public.memberships(company_id, user_id),
 check (link_access <> 'password' or password_hash is not null)
);
create index dashboards_company on public.dashboards(company_id, updated_at desc);

-- People and teams of the company who view a dashboard in the app.
create table public.dashboard_members (
 company_id uuid not null,
 dashboard_id uuid not null,
 user_id uuid,
 team_id uuid,
 foreign key (company_id, dashboard_id) references public.dashboards(company_id, id) on delete cascade,
 foreign key (company_id, user_id) references public.memberships(company_id, user_id),
 foreign key (company_id, team_id) references public.teams(company_id, id),
 check ((user_id is null) <> (team_id is null))
);
create unique index dashboard_members_user on public.dashboard_members(dashboard_id, user_id) where user_id is not null;
create unique index dashboard_members_team on public.dashboard_members(dashboard_id, team_id) where team_id is not null;
create index dashboard_members_lookup_user on public.dashboard_members(user_id) where user_id is not null;

create function mavi_private.dashboard_viewer(d_company uuid, d_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
 select mavi_private.member(d_company) and (mavi_private.leader(d_company) or exists(
  select 1 from public.dashboard_members dm
  where dm.dashboard_id = d_id and (dm.user_id = auth.uid() or dm.team_id in (
   select tm.team_id from public.team_members tm where tm.company_id = d_company and tm.user_id = auth.uid()))))
$$;
revoke all on function mavi_private.dashboard_viewer(uuid, uuid) from public, anon;
grant execute on function mavi_private.dashboard_viewer(uuid, uuid) to authenticated;

alter table public.dashboards enable row level security;
revoke all on public.dashboards from anon, authenticated;
grant select (id, company_id, name, description, panels, variables, link_access, share_token, has_password,
 version, created_by, updated_by, created_at, updated_at) on public.dashboards to authenticated;
create policy dashboards_read on public.dashboards for select to authenticated using (
 company_id in (select mavi_private.active_companies()) and mavi_private.dashboard_viewer(company_id, id)
);
alter table public.dashboard_members enable row level security;
revoke all on public.dashboard_members from anon, authenticated;
grant select on public.dashboard_members to authenticated;
create policy dashboard_members_read on public.dashboard_members for select to authenticated using (
 company_id in (select mavi_private.leader_companies())
);

-- Indexes for the period filters (due_date already has tasks_list, and
-- started_at time_entries_company_started).
create index if not exists tasks_company_created on public.tasks(company_id, created_at) where not archived;
create index if not exists tasks_company_delivered on public.tasks(company_id, delivered_at)
 where not archived and delivered_at is not null;

-- ------------------------------------------------------------ query engine
-- The SQL of one query (a JSON spec), grouped by nothing, by time buckets or
-- by a category. Every name comes from the lists below; values are quoted
-- literals. Returns a query yielding one jsonb array of {k, l?, v}.
create function mavi_private.dashboard_sql(c uuid, q jsonb, p_group text, p_interval text,
 p_from date, p_to date, p_filters jsonb, p_limit integer) returns text
language plpgsql stable security definer set search_path = '' as $$
declare
  src text := q->>'source';
  metric text := q->>'metric';
  tz text;
  base text;
  conds text[];
  m text;
  additive boolean := true;
  datef text;
  col text;
  is_ts boolean := true;
  person text;
  late text;
  f jsonb;
  fld text;
  op text;
  vals text[];
  colf text;
  typed text;
  key text;
  label text;
  bucket text;
  other text := '';
  lim integer := least(greatest(coalesce(p_limit, 1000), 1), 1000);
  filters jsonb;
begin
  select timezone into tz from public.companies where id = c;
  if tz is null then raise exception 'Empresa não encontrada'; end if;
  late := format('((t.status <> ''done'' and t.due_date < (now() at time zone %1$L)::date)'
   ' or (t.delivered_at is not null and (t.delivered_at at time zone %1$L)::date > t.due_date))', tz);

  if src = 'tasks' then
    base := 'public.tasks t';
    conds := array[format('t.company_id = %L', c), 'not t.archived'];
    person := 't.assignee_id';
    datef := coalesce(q->>'dateField', 'created_at');
    if datef = 'created_at' then col := 't.created_at';
    elsif datef = 'delivered_at' then col := 't.delivered_at';
    elsif datef = 'due_date' then col := 't.due_date'; is_ts := false;
    else raise exception 'Campo de data inválido: %', datef using errcode = '22023';
    end if;
    m := case metric
      when 'count' then 'count(*)'
      when 'estimated_hours' then 'coalesce(sum(t.estimated_minutes), 0) / 60.0'
      when 'late' then format('count(*) filter (where %s)', late)
      when 'lead_time_days' then 'avg(extract(epoch from (t.delivered_at - t.created_at)) / 86400.0)'
    end;
    if metric = 'lead_time_days' then
      additive := false;
      conds := conds || 't.delivered_at is not null'::text;
    end if;
  elsif src = 'hours' then
    base := 'public.time_entries e';
    conds := array[format('e.company_id = %L', c)];
    person := 'e.user_id';
    col := 'e.started_at';
    m := case metric
      when 'hours' then 'coalesce(sum(extract(epoch from (coalesce(e.ended_at, now()) - e.started_at))), 0) / 3600.0'
      when 'entries' then 'count(*)'
      when 'people' then 'count(distinct e.user_id)'
      when 'tasks' then 'count(distinct e.task_id)'
    end;
    if metric in ('people', 'tasks') then additive := false; end if;
  else
    raise exception 'Fonte de dados inválida: %', src using errcode = '22023';
  end if;
  if m is null then raise exception 'Métrica inválida: %', metric using errcode = '22023'; end if;

  if is_ts then
    conds := conds || format('%1$s >= (%2$L::timestamp at time zone %4$L) and %1$s < (%3$L::timestamp at time zone %4$L)',
     col, p_from, p_to + 1, tz);
  else
    conds := conds || format('%s between %L and %L', col, p_from, p_to);
  end if;

  -- The query's own filters, then the dashboard's (client, product, team, person).
  filters := coalesce(q->'filters', '[]'::jsonb);
  if jsonb_typeof(filters) <> 'array' then raise exception 'Filtros inválidos' using errcode = '22023'; end if;
  filters := filters || coalesce((
    select jsonb_agg(jsonb_build_object('field', x.field, 'values', p_filters->x.name))
    from (values ('clients','client'), ('products','product'), ('teams','team'), ('people','person')) x(name, field)
    where jsonb_typeof(p_filters->x.name) = 'array' and jsonb_array_length(p_filters->x.name) > 0
  ), '[]'::jsonb);
  if jsonb_array_length(filters) > 20 then raise exception 'Filtros demais' using errcode = '22023'; end if;
  for f in select value from jsonb_array_elements(filters) loop
    fld := f->>'field';
    op := coalesce(f->>'op', 'in');
    if op not in ('in', 'not_in') then raise exception 'Operador inválido: %', op using errcode = '22023'; end if;
    if jsonb_typeof(coalesce(f->'values', '[]'::jsonb)) <> 'array' then
      raise exception 'Valores de filtro inválidos' using errcode = '22023';
    end if;
    select coalesce(array_agg(x), '{}') into vals from jsonb_array_elements_text(coalesce(f->'values', '[]'::jsonb)) x;
    if cardinality(vals) = 0 then continue; end if;
    if cardinality(vals) > 500 then raise exception 'Filtro com valores demais' using errcode = '22023'; end if;
    if fld = 'late' and src = 'tasks' then
      conds := conds || case when (vals[1] = 'true') = (op = 'in') then late else format('not %s', late) end;
      continue;
    end if;
    colf := case
      when fld = 'client' then 'k.client_id'
      when fld = 'product' then 'k.product_id'
      when fld = 'project' then 't.project_id'
      when fld = 'team' then 't.team_id'
      when fld = 'person' then person
      when fld = 'creator' and src = 'tasks' then 't.creator_id'
      when fld = 'status' and src = 'tasks' then 't.status'
      when fld = 'priority' and src = 'tasks' then 't.priority'
      when fld = 'entry_source' and src = 'hours' then 'e.source'
    end;
    if colf is null then raise exception 'Filtro inválido para esta fonte: %', fld using errcode = '22023'; end if;
    typed := format(case when fld in ('status', 'priority', 'entry_source') then '%L::text[]' else '%L::uuid[]' end, vals);
    conds := conds || format(case when op = 'in' then '%1$s = any(%2$s)' else '(%1$s is null or %1$s <> all(%2$s))' end,
     colf, typed);
  end loop;

  -- Joins only when something reads the task (t.) or its contract (k.):
  -- hours by day or by person never touch tasks.
  key := case
    when p_group = 'client' then 'k.client_id'
    when p_group = 'product' then 'k.product_id'
    when p_group = 'project' then 't.project_id'
    when p_group = 'team' then 't.team_id'
    when p_group = 'person' then person
    when p_group = 'creator' and src = 'tasks' then 't.creator_id'
    when p_group = 'status' and src = 'tasks' then 't.status'
    when p_group = 'priority' and src = 'tasks' then 't.priority'
  end;
  if src = 'hours' and (strpos(array_to_string(conds, ' ') || ' ' || coalesce(key, ''), 't.') > 0
   or strpos(array_to_string(conds, ' ') || ' ' || coalesce(key, ''), 'k.') > 0) then
    base := base || ' join public.tasks t on t.id = e.task_id';
  end if;
  if strpos(array_to_string(conds, ' ') || ' ' || coalesce(key, ''), 'k.') > 0 then
    base := base || ' join public.contracts k on k.id = t.contract_id';
  end if;

  if p_group = 'none' then
    return format('select jsonb_build_array(jsonb_build_object(''k'', ''total'', ''v'', %s)) from %s where %s',
     m, base, array_to_string(conds, ' and '));
  end if;

  if p_group = 'time' then
    if p_interval not in ('day', 'week', 'month') then
      raise exception 'Intervalo inválido: %', p_interval using errcode = '22023';
    end if;
    bucket := case when is_ts then format('date_trunc(%L, %s at time zone %L)::date', p_interval, col, tz)
      else format('date_trunc(%L, %s::timestamp)::date', p_interval, col) end;
    return format($f$with g as (select %1$s as k, %2$s as v from %3$s where %4$s group by 1),
 b as (select d::date as k from generate_series(date_trunc(%5$L, %6$L::timestamp), %7$L::timestamp, %8$L::interval) d)
 select coalesce(jsonb_agg(jsonb_build_object('k', b.k, 'v', %9$s) order by b.k), '[]') from b left join g on g.k = b.k$f$,
     bucket, m, base, array_to_string(conds, ' and '), p_interval, p_from, p_to, '1 ' || p_interval,
     case when additive then 'coalesce(g.v, 0)' else 'g.v' end);
  end if;

  if key is null then raise exception 'Agrupamento inválido para esta fonte: %', p_group using errcode = '22023'; end if;
  label := case p_group
    when 'client' then '(select x.name from public.clients x where x.id = r.k)'
    when 'product' then '(select x.name from public.products x where x.id = r.k)'
    when 'project' then '(select x.name from public.projects x where x.id = r.k)'
    when 'team' then '(select x.name from public.teams x where x.id = r.k)'
    when 'person' then format('(select x.name from public.memberships x where x.company_id = %L and x.user_id = r.k)', c)
    when 'creator' then format('(select x.name from public.memberships x where x.company_id = %L and x.user_id = r.k)', c)
    else 'r.k::text'
  end;
  -- Sums and counts fold the rest into "Outros"; averages and distinct
  -- counts cannot be added up, so the rest is left out.
  if additive then
    other := format('union all select jsonb_build_object(''k'', ''__other__'', ''l'', ''Outros'', ''v'', sum(r.v)), %s from r where r.n > %s having count(*) > 0',
     lim + 1, lim);
  end if;
  return format($f$with g as (select %1$s as k, %2$s as v from %3$s where %4$s group by 1),
 r as (select k, v, row_number() over (order by v desc nulls last, k) as n from g)
 select coalesce(jsonb_agg(o order by n), '[]') from (
  select jsonb_build_object('k', r.k::text, 'l', %5$s, 'v', r.v) as o, r.n from r where r.n <= %6$s
  %7$s
 ) s$f$, key, m, base, array_to_string(conds, ' and '), label, lim, other);
end $$;
revoke all on function mavi_private.dashboard_sql(uuid, jsonb, text, text, date, date, jsonb, integer) from public, anon, authenticated;

create function mavi_private.dashboard_series(c uuid, q jsonb, p_group text, p_interval text,
 p_from date, p_to date, p_filters jsonb, p_limit integer) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare result jsonb; begin
  execute mavi_private.dashboard_sql(c, q, p_group, p_interval, p_from, p_to, p_filters, p_limit) into result;
  return coalesce(result, '[]'::jsonb);
end $$;
revoke all on function mavi_private.dashboard_series(uuid, jsonb, text, text, date, date, jsonb, integer) from public, anon, authenticated;

-- A panel's data: {series: {A: [...], …}, previous: {…}, interval}.
-- With a formula, every group comes back (up to 1000) so that A, B… share
-- keys; the browser applies the formula and then the top N.
create function mavi_private.dashboard_run(c uuid, spec jsonb, p_from date, p_to date, p_filters jsonb) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  q jsonb;
  series jsonb := '{}';
  previous jsonb := '{}';
  grp text := coalesce(spec->>'groupBy', 'none');
  iv text := coalesce(spec->>'interval', 'auto');
  days integer;
  lim integer;
begin
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 3700 then
    raise exception 'Período inválido' using errcode = '22023';
  end if;
  days := p_to - p_from + 1;
  if jsonb_typeof(spec->'queries') <> 'array' or jsonb_array_length(spec->'queries') not between 1 and 5 then
    raise exception 'Cada painel tem de 1 a 5 consultas' using errcode = '22023';
  end if;
  if iv = 'auto' then iv := case when days <= 62 then 'day' when days <= 366 then 'week' else 'month' end; end if;
  if grp = 'time' and iv = 'day' and days > 400 then
    raise exception 'Para períodos acima de 400 dias, agrupe por semana ou mês.' using errcode = '22023';
  end if;
  lim := case when coalesce(spec->'formula'->>'expr', '') <> '' then null
    else least(greatest(coalesce((spec->>'limit')::integer, 10), 1), 50) end;
  for q in select value from jsonb_array_elements(spec->'queries') loop
    if coalesce(q->>'ref', '') !~ '^[A-E]$' then raise exception 'Consulta inválida' using errcode = '22023'; end if;
    series := series || jsonb_build_object(q->>'ref',
     mavi_private.dashboard_series(c, q, grp, iv, p_from, p_to, p_filters, lim));
    if grp = 'none' and coalesce((spec->>'compare')::boolean, false) then
      previous := previous || jsonb_build_object(q->>'ref',
       mavi_private.dashboard_series(c, q, grp, iv, p_from - days, p_from - 1, p_filters, lim));
    end if;
  end loop;
  return jsonb_build_object('series', series, 'previous', previous, 'interval', iv);
end $$;
revoke all on function mavi_private.dashboard_run(uuid, jsonb, date, date, jsonb) from public, anon, authenticated;

-- Validates panels and variables before saving: layout bounds, sizes, and
-- that every query builds (unknown names raise).
create function mavi_private.dashboard_check(c uuid, p_panels jsonb, p_variables jsonb) returns void
language plpgsql stable security definer set search_path = '' as $$
declare p jsonb; q jsonb; spec jsonb; ids text[] := '{}'; refs text[]; expr text; begin
  if jsonb_typeof(p_panels) <> 'array' or jsonb_array_length(p_panels) > 48 then
    raise exception 'Um dashboard tem até 48 painéis' using errcode = '22023';
  end if;
  if octet_length(p_panels::text) > 300000 then raise exception 'Dashboard grande demais' using errcode = '22023'; end if;
  if jsonb_typeof(coalesce(p_variables, '{}'::jsonb)) <> 'object' then
    raise exception 'Variáveis inválidas' using errcode = '22023';
  end if;
  for p in select value from jsonb_array_elements(p_panels) loop
    if coalesce(p->>'id', '') !~ '^[a-z0-9-]{1,40}$' or p->>'id' = any(ids) then
      raise exception 'Painel com identificador inválido' using errcode = '22023';
    end if;
    ids := ids || (p->>'id');
    if length(coalesce(p->>'title', '')) > 120 then raise exception 'Título de painel longo demais' using errcode = '22023'; end if;
    if jsonb_typeof(p->'x') <> 'number' or jsonb_typeof(p->'y') <> 'number'
     or jsonb_typeof(p->'w') <> 'number' or jsonb_typeof(p->'h') <> 'number'
     or (p->>'x')::int not between 0 and 11 or (p->>'w')::int not between 1 and 12
     or (p->>'x')::int + (p->>'w')::int > 12 or (p->>'y')::int not between 0 and 2000
     or (p->>'h')::int not between 1 and 24 then
      raise exception 'Posição de painel inválida' using errcode = '22023';
    end if;
    spec := p->'spec';
    if coalesce(spec->>'viz', '') not in ('stat', 'line', 'area', 'bar', 'hbar', 'donut', 'table') then
      raise exception 'Visualização inválida' using errcode = '22023';
    end if;
    if coalesce(spec->>'groupBy', 'none') not in
     ('none', 'time', 'client', 'product', 'project', 'team', 'person', 'creator', 'status', 'priority') then
      raise exception 'Agrupamento inválido' using errcode = '22023';
    end if;
    if coalesce(spec->>'interval', 'auto') not in ('auto', 'day', 'week', 'month') then
      raise exception 'Intervalo inválido' using errcode = '22023';
    end if;
    if jsonb_typeof(spec->'queries') <> 'array' or jsonb_array_length(spec->'queries') not between 1 and 5 then
      raise exception 'Cada painel tem de 1 a 5 consultas' using errcode = '22023';
    end if;
    expr := coalesce(spec->'formula'->>'expr', '');
    if length(expr) > 200 or expr !~ '^[A-E0-9+*/(). -]*$' then
      raise exception 'Fórmula inválida: use A a E, números, + - * / e parênteses' using errcode = '22023';
    end if;
    refs := '{}';
    for q in select value from jsonb_array_elements(spec->'queries') loop
      if coalesce(q->>'ref', '') !~ '^[A-E]$' or q->>'ref' = any(refs) then
        raise exception 'Consulta inválida' using errcode = '22023';
      end if;
      refs := refs || (q->>'ref');
      perform mavi_private.dashboard_sql(c, q, coalesce(spec->>'groupBy', 'none'), 'month',
       current_date, current_date, coalesce(p_variables->'filters', '{}'::jsonb), 10);
    end loop;
  end loop;
end $$;
revoke all on function mavi_private.dashboard_check(uuid, jsonb, jsonb) from public, anon, authenticated;

-- ------------------------------------------------------------ access
-- Wrong passwords are counted per dashboard: 10 in 15 minutes lock the link
-- for the rest of the window. Callers never raise after counting (that
-- would roll the count back): they return the state instead.
create table mavi_private.dashboard_password_attempts (
 dashboard_id uuid primary key references public.dashboards(id) on delete cascade,
 window_start timestamptz not null default now(),
 failures integer not null default 0
);
alter table mavi_private.dashboard_password_attempts enable row level security;
revoke all on mavi_private.dashboard_password_attempts from public, anon, authenticated;

-- 'editor' (leaders) | 'viewer' | 'password' (link needs the password) |
-- 'locked' (too many wrong passwords) | null (no access).
create function mavi_private.dashboard_access(d public.dashboards, p_token text, p_password text) returns text
language plpgsql volatile security definer set search_path = '' as $$
declare a mavi_private.dashboard_password_attempts; begin
  if auth.uid() is not null and mavi_private.member(d.company_id) then
    if mavi_private.leader(d.company_id) then return 'editor'; end if;
    if mavi_private.dashboard_viewer(d.company_id, d.id) then return 'viewer'; end if;
  end if;
  if p_token is null or p_token <> d.share_token then return null; end if;
  if d.link_access = 'public' then return 'viewer'; end if;
  if d.link_access <> 'password' then return null; end if;
  select * into a from mavi_private.dashboard_password_attempts where dashboard_id = d.id for update;
  if found and a.failures >= 10 and a.window_start > now() - interval '15 minutes' then return 'locked'; end if;
  if nullif(p_password, '') is null then return 'password'; end if;
  if d.password_hash = extensions.crypt(p_password, d.password_hash) then return 'viewer'; end if;
  insert into mavi_private.dashboard_password_attempts(dashboard_id, window_start, failures) values (d.id, now(), 1)
  on conflict (dashboard_id) do update set
   failures = case when mavi_private.dashboard_password_attempts.window_start < now() - interval '15 minutes'
    then 1 else mavi_private.dashboard_password_attempts.failures + 1 end,
   window_start = case when mavi_private.dashboard_password_attempts.window_start < now() - interval '15 minutes'
    then now() else mavi_private.dashboard_password_attempts.window_start end;
  return 'password';
end $$;
revoke all on function mavi_private.dashboard_access(public.dashboards, text, text) from public, anon, authenticated;

-- Panel results for 60 seconds, per dashboard version, panel, period and
-- filters (public dashboards may be opened by many people at once).
create table mavi_private.dashboard_cache (
 cache_key text primary key,
 dashboard_id uuid not null,
 created_at timestamptz not null default now(),
 data jsonb not null
);
create index dashboard_cache_age on mavi_private.dashboard_cache(created_at);
create index dashboard_cache_dashboard on mavi_private.dashboard_cache(dashboard_id);
alter table mavi_private.dashboard_cache enable row level security;
revoke all on mavi_private.dashboard_cache from public, anon, authenticated;

-- A shared link: the dashboard to show, or what is missing to show it.
create function public.dashboard_shared(p_token text, p_password text default null) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare d public.dashboards; acc text; begin
  select * into d from public.dashboards where share_token = p_token;
  if not found or d.link_access = 'none' then
    raise exception 'Link inválido ou dashboard indisponível.' using errcode = 'P0002';
  end if;
  acc := mavi_private.dashboard_access(d, p_token, p_password);
  if acc = 'locked' then return jsonb_build_object('status', 'locked'); end if;
  if acc = 'password' then
    return jsonb_build_object('status', 'password', 'wrong', nullif(p_password, '') is not null);
  end if;
  if acc is null then raise exception 'Link inválido ou dashboard indisponível.' using errcode = 'P0002'; end if;
  return jsonb_build_object('status', 'ok', 'id', d.id, 'name', d.name, 'description', d.description,
   'panels', d.panels, 'variables', d.variables, 'updated_at', d.updated_at,
   'timezone', (select timezone from public.companies where id = d.company_id),
   'company', (select name from public.companies where id = d.company_id));
end $$;

-- One panel's data, for the app (p_dashboard) or a shared link (p_token).
-- Only leaders apply their own filters (p_vars); everyone else sees the
-- saved ones and may only change the period. p_fresh skips the cache for
-- people signed in with access.
create function public.dashboard_panel_data(p_dashboard uuid, p_panel text, p_from date, p_to date,
 p_vars jsonb default null, p_token text default null, p_password text default null, p_fresh boolean default false)
 returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare d public.dashboards; acc text; panel jsonb; filters jsonb; key text; hit jsonb; result jsonb; begin
  if p_token is not null then select * into d from public.dashboards where share_token = p_token;
  else select * into d from public.dashboards where id = p_dashboard; end if;
  if not found then raise exception 'Dashboard não encontrado' using errcode = '42501'; end if;
  acc := mavi_private.dashboard_access(d, p_token, p_password);
  if acc = 'locked' then return jsonb_build_object('error', 'Muitas tentativas. Tente novamente em alguns minutos.'); end if;
  if acc = 'password' then return jsonb_build_object('error', 'Senha incorreta.'); end if;
  if acc is null then raise exception 'Sem acesso a este dashboard' using errcode = '42501'; end if;
  select value into panel from jsonb_array_elements(d.panels) where value->>'id' = p_panel;
  if panel is null then raise exception 'Painel não encontrado' using errcode = 'P0002'; end if;
  filters := coalesce(case when acc = 'editor' and p_vars is not null then p_vars->'filters' end,
   d.variables->'filters', '{}'::jsonb);
  key := md5(concat_ws('|', d.id, d.version, p_panel, p_from, p_to, filters::text));
  if not (p_fresh and auth.uid() is not null) then
    select data into hit from mavi_private.dashboard_cache
    where cache_key = key and created_at > now() - interval '60 seconds';
    if hit is not null then return hit; end if;
  end if;
  result := mavi_private.dashboard_run(d.company_id, panel->'spec', p_from, p_to, filters)
   || jsonb_build_object('computed_at', now());
  insert into mavi_private.dashboard_cache(cache_key, dashboard_id, created_at, data) values (key, d.id, now(), result)
  on conflict (cache_key) do update set created_at = excluded.created_at, data = excluded.data;
  return result;
end $$;

-- A panel being edited (not saved yet), for leaders. Never cached.
create function public.dashboard_preview(p_company uuid, p_spec jsonb, p_from date, p_to date, p_vars jsonb default '{}')
 returns jsonb
language plpgsql stable security definer set search_path = '' as $$ begin
  if not mavi_private.leader(p_company) then raise exception 'Sem permissão' using errcode = '42501'; end if;
  perform mavi_private.dashboard_check(p_company,
   jsonb_build_array(jsonb_build_object('id', 'preview', 'title', '', 'x', 0, 'y', 0, 'w', 12, 'h', 4, 'spec', p_spec)),
   coalesce(p_vars, '{}'::jsonb));
  return mavi_private.dashboard_run(p_company, p_spec, p_from, p_to, coalesce(p_vars->'filters', '{}'::jsonb))
   || jsonb_build_object('computed_at', now());
end $$;

-- ------------------------------------------------------------ editing
-- Creates (p_dashboard null) or updates a dashboard. p_version guards
-- against overwriting someone else's newer changes.
create function public.save_dashboard(p_company uuid, p_dashboard uuid, p_name text, p_description text,
 p_panels jsonb, p_variables jsonb, p_version integer default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare d public.dashboards; begin
  if not mavi_private.leader(p_company) then raise exception 'Sem permissão' using errcode = '42501'; end if;
  if length(trim(coalesce(p_name, ''))) not between 2 and 120 then
    raise exception 'Informe um nome de 2 a 120 caracteres.' using errcode = '22023';
  end if;
  if length(coalesce(p_description, '')) > 500 then raise exception 'Descrição longa demais.' using errcode = '22023'; end if;
  perform mavi_private.dashboard_check(p_company, coalesce(p_panels, '[]'::jsonb), coalesce(p_variables, '{}'::jsonb));
  if p_dashboard is null then
    insert into public.dashboards(company_id, name, description, panels, variables, updated_by)
    values (p_company, trim(p_name), coalesce(p_description, ''), coalesce(p_panels, '[]'::jsonb),
     coalesce(p_variables, '{}'::jsonb), auth.uid())
    returning * into d;
  else
    update public.dashboards set name = trim(p_name), description = coalesce(p_description, ''),
     panels = coalesce(p_panels, '[]'::jsonb), variables = coalesce(p_variables, '{}'::jsonb),
     version = version + 1, updated_by = auth.uid(), updated_at = now()
    where id = p_dashboard and company_id = p_company and (p_version is null or version = p_version)
    returning * into d;
    if not found then
      if exists(select 1 from public.dashboards where id = p_dashboard and company_id = p_company) then
        raise exception 'Este dashboard foi alterado por outra pessoa. Recarregue para ver a versão atual.'
         using errcode = '40001';
      end if;
      raise exception 'Dashboard não encontrado' using errcode = 'P0002';
    end if;
  end if;
  return to_jsonb(d) - 'password_hash';
end $$;

create function public.delete_dashboard(p_dashboard uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare d public.dashboards; begin
  select * into d from public.dashboards where id = p_dashboard for update;
  if not found or not mavi_private.leader(d.company_id) then raise exception 'Sem permissão' using errcode = '42501'; end if;
  delete from mavi_private.dashboard_cache where dashboard_id = d.id;
  delete from public.dashboards where id = d.id;
end $$;

-- Who sees it: people and teams in the app, plus the link (none, password or
-- public). A new password replaces the old one; leaving the password mode
-- forgets it. p_new_link invalidates the current link.
create function public.set_dashboard_sharing(p_dashboard uuid, p_link_access text, p_password text default null,
 p_users uuid[] default '{}', p_teams uuid[] default '{}', p_new_link boolean default false) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare d public.dashboards; begin
  select * into d from public.dashboards where id = p_dashboard for update;
  if not found or not mavi_private.leader(d.company_id) then raise exception 'Sem permissão' using errcode = '42501'; end if;
  if p_link_access not in ('none', 'password', 'public') then raise exception 'Acesso inválido' using errcode = '22023'; end if;
  if nullif(p_password, '') is not null and length(p_password) not between 6 and 72 then
    raise exception 'A senha precisa ter de 6 a 72 caracteres.' using errcode = '22023';
  end if;
  if p_link_access = 'password' and nullif(p_password, '') is null and d.password_hash is null then
    raise exception 'Defina uma senha para o link.' using errcode = '22023';
  end if;
  update public.dashboards set
   link_access = p_link_access,
   password_hash = case when p_link_access <> 'password' then null
    when nullif(p_password, '') is not null then extensions.crypt(p_password, extensions.gen_salt('bf', 8))
    else password_hash end,
   share_token = case when p_new_link
    then replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '') else share_token end
  where id = d.id returning * into d;
  if nullif(p_password, '') is not null or p_link_access <> 'password' then
    delete from mavi_private.dashboard_password_attempts where dashboard_id = d.id;
  end if;
  delete from public.dashboard_members where dashboard_id = d.id;
  insert into public.dashboard_members(company_id, dashboard_id, user_id)
  select d.company_id, d.id, m.user_id from public.memberships m
  where m.company_id = d.company_id and m.active and m.user_id = any(coalesce(p_users, '{}'));
  insert into public.dashboard_members(company_id, dashboard_id, team_id)
  select d.company_id, d.id, t.id from public.teams t
  where t.company_id = d.company_id and t.id = any(coalesce(p_teams, '{}'));
  return to_jsonb(d) - 'password_hash';
end $$;

revoke all on function public.dashboard_shared(text, text),
 public.dashboard_panel_data(uuid, text, date, date, jsonb, text, text, boolean) from public;
grant execute on function public.dashboard_shared(text, text),
 public.dashboard_panel_data(uuid, text, date, date, jsonb, text, text, boolean) to anon, authenticated;
revoke all on function public.dashboard_preview(uuid, jsonb, date, date, jsonb),
 public.save_dashboard(uuid, uuid, text, text, jsonb, jsonb, integer), public.delete_dashboard(uuid),
 public.set_dashboard_sharing(uuid, text, text, uuid[], uuid[], boolean) from public, anon;
grant execute on function public.dashboard_preview(uuid, jsonb, date, date, jsonb),
 public.save_dashboard(uuid, uuid, text, text, jsonb, jsonb, integer), public.delete_dashboard(uuid),
 public.set_dashboard_sharing(uuid, text, text, uuid[], uuid[], boolean) to authenticated;

-- Old cache entries are dropped every 10 minutes (entries older than 60
-- seconds are never read).
do $$ begin
  if exists(select 1 from pg_available_extensions where name = 'pg_cron') then
    create extension if not exists pg_cron;
    perform cron.schedule('mavi-dashboard-cache-cleanup', '*/10 * * * *',
     $job$delete from mavi_private.dashboard_cache where created_at < now() - interval '5 minutes'$job$);
  else
    raise notice 'pg_cron unavailable: schedule the dashboard cache cleanup on the hosted database';
  end if;
end $$;

commit;
