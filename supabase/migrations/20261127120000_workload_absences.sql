begin;

-- Prazo padrão, Fase 2: jornada e ausências.
--
-- * Jornada: horas por dia da empresa (companies.work_minutes) e, por
--   pessoa, outras horas e/ou só alguns dias da semana (memberships.
--   work_minutes, work_days: 1 = segunda … 5 = sexta). As horas servem ao
--   prazo inteligente (carga × jornada); os dias entram na contagem já.
-- * Ausências: férias, folgas e afastamentos por pessoa, de um dia a outro.
-- * O prazo da regra conta só os dias em que quem executa trabalha: fora
--   da jornada ou ausente, o dia não conta (e quem chega de férias começa a
--   contar na volta).
-- * Na distribuição por equipe, quem está ausente hoje só recebe quando a
--   equipe inteira está ausente.
-- * Administradores configuram tudo; gestores, a jornada e as ausências das
--   pessoas das suas equipes.

-- ------------------------------------------------------------ jornada
alter table public.companies add column work_minutes integer not null default 480
 check (work_minutes between 60 and 1440);
alter table public.memberships add column work_minutes integer
 check (work_minutes between 30 and 1440);
alter table public.memberships add column work_days smallint[]
 check (work_days is null or (cardinality(work_days) between 1 and 5 and work_days <@ '{1,2,3,4,5}'::smallint[]));

create function public.set_company_work_minutes(p_company uuid, p_minutes integer) returns void
language plpgsql security definer set search_path = '' as $$ begin
 if not mavi_private.admin(p_company) then
  raise exception 'Somente administradores mudam a jornada da empresa' using errcode = '42501';
 end if;
 if p_minutes is null or p_minutes not between 60 and 1440 then
  raise exception 'A jornada vai de 1 a 24 horas por dia';
 end if;
 update public.companies set work_minutes = p_minutes where id = p_company;
end $$;
revoke all on function public.set_company_work_minutes(uuid, integer) from public, anon;
grant execute on function public.set_company_work_minutes(uuid, integer) to authenticated;

-- A pessoa pode mexer? Administradores em todos; gestores nas pessoas das
-- suas equipes (as mesmas de mavi_private.can_manage_due_scope).
create function mavi_private.can_manage_person(c uuid, p_user uuid) returns boolean
language sql stable security definer set search_path = '' as $$
 select mavi_private.can_manage_due_scope(c, null, null, null, p_user)
$$;
revoke all on function mavi_private.can_manage_person(uuid, uuid) from public, anon, authenticated;

-- Null volta ao padrão da empresa (horas) ou a segunda a sexta (dias).
create function public.set_member_workload(p_company uuid, p_user uuid, p_minutes integer, p_days smallint[])
 returns void
language plpgsql security definer set search_path = '' as $$
declare days smallint[]; begin
 if not mavi_private.can_manage_person(p_company, p_user) then
  raise exception 'Gestores mudam só a jornada das pessoas das suas equipes' using errcode = '42501';
 end if;
 if p_minutes is not null and p_minutes not between 30 and 1440 then
  raise exception 'A jornada vai de meia hora a 24 horas por dia';
 end if;
 select array_agg(distinct d order by d) into days from unnest(p_days) d where d is not null;
 if days is not null and not days <@ '{1,2,3,4,5}'::smallint[] then
  raise exception 'Escolha dias de segunda a sexta';
 end if;
 if days = '{1,2,3,4,5}'::smallint[] then days := null; end if;
 update public.memberships set work_minutes = p_minutes, work_days = days
 where company_id = p_company and user_id = p_user;
 if not found then raise exception 'Pessoa não encontrada'; end if;
end $$;
revoke all on function public.set_member_workload(uuid, uuid, integer, smallint[]) from public, anon;
grant execute on function public.set_member_workload(uuid, uuid, integer, smallint[]) to authenticated;

-- ------------------------------------------------------------ ausências
create table public.member_absences (
 id uuid primary key default gen_random_uuid(),
 company_id uuid not null references public.companies(id) on delete cascade,
 user_id uuid not null,
 starts_on date not null,
 ends_on date not null,
 kind text not null check (kind in ('vacation', 'day_off', 'leave')),
 created_by uuid default auth.uid(),
 created_at timestamptz not null default now(),
 foreign key (company_id, user_id) references public.memberships(company_id, user_id) on delete cascade,
 check (ends_on >= starts_on and ends_on - starts_on <= 366)
);
create index member_absences_person on public.member_absences(company_id, user_id, ends_on);
alter table public.member_absences enable row level security;
revoke all on public.member_absences from public, anon, authenticated;
grant select on public.member_absences to authenticated;
-- Todos da empresa veem (o formulário avisa quem está fora); só o tipo e as
-- datas, sem observações.
create policy member_absences_read on public.member_absences for select to authenticated
 using (mavi_private.member(company_id));
create trigger broadcast_lookup after insert or update or delete on public.member_absences
 for each row execute function mavi_private.broadcast_lookup();

-- Devolve {id, open_tasks}: quantas tarefas em aberto da pessoa vencem no
-- período (para rever os prazos; nada muda sozinho).
create function public.save_member_absence(p_company uuid, p_id uuid, p_user uuid, p_starts date,
 p_ends date, p_kind text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare old public.member_absences; result uuid; n integer; begin
 if not mavi_private.can_manage_person(p_company, p_user) then
  raise exception 'Gestores registram só ausências das pessoas das suas equipes' using errcode = '42501';
 end if;
 if p_starts is null or p_ends is null then raise exception 'Escolha o primeiro e o último dia'; end if;
 if p_ends < p_starts then raise exception 'O último dia vem antes do primeiro'; end if;
 if p_ends - p_starts > 366 then raise exception 'Registre no máximo um ano por vez'; end if;
 if p_kind not in ('vacation', 'day_off', 'leave') then raise exception 'Tipo de ausência inválido'; end if;
 if exists(select 1 from public.member_absences a where a.company_id = p_company and a.user_id = p_user
  and a.id is distinct from p_id and a.starts_on <= p_ends and a.ends_on >= p_starts) then
  raise exception 'Já há uma ausência dessa pessoa nesse período';
 end if;
 if p_id is null then
  insert into public.member_absences(company_id, user_id, starts_on, ends_on, kind)
  values (p_company, p_user, p_starts, p_ends, p_kind) returning id into result;
 else
  select * into old from public.member_absences where company_id = p_company and id = p_id for update;
  if not found then raise exception 'Ausência não encontrada'; end if;
  if not mavi_private.can_manage_person(p_company, old.user_id) then
   raise exception 'Sem permissão para mudar esta ausência' using errcode = '42501';
  end if;
  update public.member_absences set user_id = p_user, starts_on = p_starts, ends_on = p_ends, kind = p_kind
  where id = p_id returning id into result;
 end if;
 select count(*) into n from public.tasks t where t.company_id = p_company and t.assignee_id = p_user
  and t.status <> 'done' and not t.archived and t.due_date between p_starts and p_ends;
 return jsonb_build_object('id', result, 'open_tasks', n);
end $$;
revoke all on function public.save_member_absence(uuid, uuid, uuid, date, date, text) from public, anon;
grant execute on function public.save_member_absence(uuid, uuid, uuid, date, date, text) to authenticated;

create function public.delete_member_absence(p_id uuid) returns void
language plpgsql security definer set search_path = '' as $$ declare a public.member_absences; begin
 select * into a from public.member_absences where id = p_id;
 if not found or not mavi_private.can_manage_person(a.company_id, a.user_id) then
  raise exception 'Sem permissão' using errcode = '42501';
 end if;
 delete from public.member_absences where id = p_id;
end $$;
revoke all on function public.delete_member_absence(uuid) from public, anon;
grant execute on function public.delete_member_absence(uuid) to authenticated;

-- ------------------------------------------------------------ contagem
-- A pessoa não trabalha em `d`: fora dos seus dias da semana ou ausente.
create function mavi_private.person_off(c uuid, u uuid, d date) returns boolean
language sql stable security definer set search_path = '' as $$
 select exists(select 1 from public.memberships m where m.company_id = c and m.user_id = u
   and m.work_days is not null and not extract(isodow from d)::smallint = any(m.work_days))
  or exists(select 1 from public.member_absences a where a.company_id = c and a.user_id = u
   and d between a.starts_on and a.ends_on)
$$;

-- Dia útil da empresa em que a pessoa trabalha (sem pessoa: o da empresa).
create function mavi_private.is_person_business_day(c uuid, u uuid, d date) returns boolean
language sql stable security definer set search_path = '' as $$
 select mavi_private.is_business_day(c, d) and (u is null or not mavi_private.person_off(c, u, d))
$$;

create function mavi_private.next_person_business_day(c uuid, u uuid, d date) returns date
language plpgsql stable security definer set search_path = '' as $$
declare r date := d; begin
 while not mavi_private.is_person_business_day(c, u, r) loop
  r := r + 1;
  if r - d > 800 then raise exception 'Não há dia de trabalho de quem executa nos próximos dois anos'; end if;
 end loop;
 return r;
end $$;

create function mavi_private.add_person_business_days(c uuid, u uuid, d date, n integer) returns date
language plpgsql stable security definer set search_path = '' as $$
declare r date := d; remaining integer := n; begin
 while remaining > 0 loop
  r := r + 1;
  if mavi_private.is_person_business_day(c, u, r) then remaining := remaining - 1; end if;
  if r - d > 800 + n then raise exception 'Não há dias de trabalho de quem executa suficientes para o prazo'; end if;
 end loop;
 return r;
end $$;
revoke all on function mavi_private.person_off(uuid, uuid, date), mavi_private.is_person_business_day(uuid, uuid, date),
 mavi_private.next_person_business_day(uuid, uuid, date), mavi_private.add_person_business_days(uuid, uuid, date, integer)
 from public, anon, authenticated;

-- A regra conta nos dias de quem executa.
drop function mavi_private.rule_due_dates(uuid, public.task_due_rules, date, boolean);
create function mavi_private.rule_due_dates(c uuid, r public.task_due_rules, p_base date, p_approval boolean,
 p_user uuid, out due date, out min_due date)
language plpgsql stable security definer set search_path = '' as $$
declare base date := mavi_private.next_person_business_day(c, p_user, p_base);
 extra integer := case when p_approval then r.approval_days else 0 end; begin
 due := mavi_private.add_person_business_days(c, p_user, base, r.business_days + extra);
 min_due := case when r.min_days is null then null
  else mavi_private.add_person_business_days(c, p_user, base, r.min_days + extra) end;
end $$;
revoke all on function mavi_private.rule_due_dates(uuid, public.task_due_rules, date, boolean, uuid)
 from public, anon, authenticated;

create or replace function mavi_private.choose_due(c uuid, p_contract uuid, p_project uuid, p_team uuid, p_assignee uuid,
 p_base date, p_approval boolean, p_due date, p_manual boolean, p_reason text, p_check_min boolean,
 out due date, out rule_id uuid, out manual boolean, out min_due date, out tight_reason text)
language plpgsql stable security definer set search_path = '' as $$
declare r public.task_due_rules; d record; begin
 r := mavi_private.due_rule_for(c, p_contract, p_project, p_team, p_assignee);
 if r.id is not null then
  select * into d from mavi_private.rule_due_dates(c, r, p_base, coalesce(p_approval, false), p_assignee);
  min_due := d.min_due;
 end if;
 manual := coalesce(p_manual, true);
 if not manual and r.id is not null then
  due := d.due; rule_id := r.id;
  return;
 end if;
 if p_due is null then raise exception 'Escolha o prazo'; end if;
 due := p_due;
 if p_check_min and min_due is not null and p_due < min_due then
  if length(trim(coalesce(p_reason, ''))) < 5 then
   raise exception 'Este prazo fica antes do mínimo da regra (%). Explique o motivo para continuar.',
    to_char(min_due, 'DD/MM/YYYY') using errcode = 'MV002';
  end if;
  tight_reason := left(trim(p_reason), 500);
 end if;
end $$;

-- ------------------------------------------------------------ equipe
-- Quem está ausente hoje vai para o fim da fila (recebe só se a equipe
-- inteira está ausente); o resto como antes.
create or replace function mavi_private.team_assignee(c uuid, p_team uuid) returns uuid
language sql stable security definer set search_path = '' as $$
 select tm.user_id from public.team_members tm
 join public.memberships m on m.company_id=tm.company_id and m.user_id=tm.user_id and m.active
 where tm.company_id=c and tm.team_id=p_team
 order by exists(select 1 from public.member_absences a where a.company_id=c and a.user_id=tm.user_id
   and mavi_private.company_today(c) between a.starts_on and a.ends_on),
  tm.supervisor,
  (select count(*) from public.tasks t
    where t.company_id=c and t.assignee_id=tm.user_id and t.status<>'done' and not t.archived),
  (select max(t.created_at) from public.tasks t where t.company_id=c and t.assignee_id=tm.user_id) nulls first,
  m.name, tm.user_id
 limit 1
$$;

commit;
