begin;

-- Prazo padrão das tarefas (Fase 1).
--
-- * Calendário da empresa: sábados, domingos e feriados nacionais não são
--   dias úteis; a empresa soma feriados locais e recessos ("off") e marca os
--   feriados nacionais em que trabalha ("workday").
-- * Regras de prazo: N dias úteis por projeto, cliente, produto, equipe e/ou
--   pessoa (quem executa), combináveis. Vale a mais específica, nesta ordem:
--   Projeto › Cliente › Produto › Equipe › Pessoa; a regra sem critério é o
--   padrão da empresa. Cada regra pode somar dias quando a tarefa pede
--   aprovação do cliente e ter um mínimo: um prazo antes dele só com motivo,
--   que fica no histórico (indicador "prazo apertado").
-- * A contagem parte do início planejado ou, sem ele, do dia da criação; um
--   dia não útil conta como o próximo dia útil.
-- * A tarefa guarda se o prazo veio da regra (due_manual = false): só assim
--   o banco o recalcula (na distribuição por equipe, nas cópias da repetição).
-- * A tarefa principal nunca vence antes de uma subtarefa: o prazo dela
--   acompanha o da subtarefa mais longa.

-- ------------------------------------------------------------ calendário
create table public.company_calendar_days (
 id uuid primary key default gen_random_uuid(),
 company_id uuid not null references public.companies(id) on delete cascade,
 day date not null,
 -- Todo ano no mesmo dia e mês (a partir de `day`).
 yearly boolean not null default false,
 kind text not null check (kind in ('off', 'workday')),
 name text not null check (length(trim(name)) between 2 and 80),
 created_by uuid default auth.uid(),
 created_at timestamptz not null default now(),
 unique (company_id, day)
);
alter table public.company_calendar_days enable row level security;
revoke all on public.company_calendar_days from public, anon, authenticated;
grant select on public.company_calendar_days to authenticated;
create policy company_calendar_days_read on public.company_calendar_days for select to authenticated
 using (mavi_private.member(company_id));

-- Domingo de Páscoa (algoritmo de Meeus/Jones/Butcher).
create function mavi_private.easter(y integer) returns date
language plpgsql immutable set search_path = '' as $$
declare a int := y % 19; b int := y / 100; c int := y % 100; d int; e int; f int; g int; h int;
 i int; k int; l int; m int; begin
 d := b / 4; e := b % 4; f := (b + 8) / 25; g := (b - f + 1) / 3;
 h := (19 * a + b - d - g + 15) % 30; i := c / 4; k := c % 4;
 l := (32 + 2 * e + 2 * i - h - k) % 7; m := (a + 11 * h + 22 * l) / 451;
 return make_date(y, (h + l - 7 * m + 114) / 31, (h + l - 7 * m + 114) % 31 + 1);
end $$;

-- O nome do feriado nacional em `d` (null quando não é). Carnaval e Corpus
-- Christi são ponto facultativo, mas quase todo mundo para; a empresa que
-- trabalha marca o dia como "workday".
create function mavi_private.national_holiday(d date) returns text
language plpgsql immutable set search_path = '' as $$
declare md text := to_char(d, 'MM-DD'); e date := mavi_private.easter(extract(year from d)::integer); begin
 return case
  when md = '01-01' then 'Confraternização Universal'
  when md = '04-21' then 'Tiradentes'
  when md = '05-01' then 'Dia do Trabalho'
  when md = '09-07' then 'Independência do Brasil'
  when md = '10-12' then 'Nossa Senhora Aparecida'
  when md = '11-02' then 'Finados'
  when md = '11-15' then 'Proclamação da República'
  when md = '11-20' and d >= date '2024-01-01' then 'Dia da Consciência Negra'
  when md = '12-25' then 'Natal'
  when d = e - 48 or d = e - 47 then 'Carnaval'
  when d = e - 2 then 'Sexta-feira Santa'
  when d = e + 60 then 'Corpus Christi'
 end;
end $$;

create function mavi_private.calendar_day(c uuid, d date, p_kind text) returns boolean
language sql stable security definer set search_path = '' as $$
 select exists(select 1 from public.company_calendar_days x where x.company_id = c and x.kind = p_kind
  and (x.day = d or (x.yearly and x.day <= d and to_char(x.day, 'MM-DD') = to_char(d, 'MM-DD'))))
$$;

create function mavi_private.is_business_day(c uuid, d date) returns boolean
language sql stable security definer set search_path = '' as $$
 select extract(isodow from d) < 6
  and not mavi_private.calendar_day(c, d, 'off')
  and (mavi_private.national_holiday(d) is null or mavi_private.calendar_day(c, d, 'workday'))
$$;

-- `d` quando é dia útil; senão, o próximo.
create function mavi_private.next_business_day(c uuid, d date) returns date
language plpgsql stable security definer set search_path = '' as $$
declare r date := d; begin
 while not mavi_private.is_business_day(c, r) loop r := r + 1; end loop;
 return r;
end $$;

-- N dias úteis depois (ou antes, com N negativo), no calendário da empresa.
create function mavi_private.add_company_business_days(c uuid, d date, n integer) returns date
language plpgsql stable security definer set search_path = '' as $$
declare r date := d; step integer := case when n < 0 then -1 else 1 end; remaining integer := abs(n); begin
 while remaining > 0 loop
  r := r + step;
  if mavi_private.is_business_day(c, r) then remaining := remaining - 1; end if;
 end loop;
 return r;
end $$;
revoke all on function mavi_private.easter(integer), mavi_private.national_holiday(date),
 mavi_private.calendar_day(uuid, date, text), mavi_private.is_business_day(uuid, date),
 mavi_private.next_business_day(uuid, date), mavi_private.add_company_business_days(uuid, date, integer)
 from public, anon, authenticated;

-- Só administradores mexem no calendário (vale para a empresa toda).
create function public.save_calendar_day(p_company uuid, p_id uuid, p_day date, p_name text,
 p_kind text, p_yearly boolean default false) returns uuid
language plpgsql security definer set search_path = '' as $$ declare result uuid; begin
 if not mavi_private.admin(p_company) then
  raise exception 'Somente administradores configuram o calendário da empresa' using errcode = '42501';
 end if;
 if p_day is null then raise exception 'Escolha o dia'; end if;
 if p_kind not in ('off', 'workday') then raise exception 'Tipo de dia inválido'; end if;
 if p_kind = 'workday' and mavi_private.national_holiday(p_day) is null then
  raise exception 'Só dá para marcar como dia de trabalho um feriado nacional';
 end if;
 if length(trim(coalesce(p_name, ''))) < 2 then raise exception 'Dê um nome ao dia'; end if;
 begin
  if p_id is null then
   insert into public.company_calendar_days(company_id, day, name, kind, yearly)
   values (p_company, p_day, trim(p_name), p_kind, coalesce(p_yearly, false)) returning id into result;
  else
   update public.company_calendar_days set day = p_day, name = trim(p_name), kind = p_kind,
    yearly = coalesce(p_yearly, false)
   where company_id = p_company and id = p_id returning id into result;
   if result is null then raise exception 'Dia não encontrado'; end if;
  end if;
 exception when unique_violation then
  raise exception 'Este dia já está no calendário da empresa';
 end;
 return result;
end $$;
revoke all on function public.save_calendar_day(uuid, uuid, date, text, text, boolean) from public, anon;
grant execute on function public.save_calendar_day(uuid, uuid, date, text, text, boolean) to authenticated;

create function public.delete_calendar_day(p_id uuid) returns void
language plpgsql security definer set search_path = '' as $$ declare c uuid; begin
 select company_id into c from public.company_calendar_days where id = p_id;
 if c is null or not mavi_private.admin(c) then raise exception 'Sem permissão' using errcode = '42501'; end if;
 delete from public.company_calendar_days where id = p_id;
end $$;
revoke all on function public.delete_calendar_day(uuid) from public, anon;
grant execute on function public.delete_calendar_day(uuid) to authenticated;

-- ------------------------------------------------------------ regras
create table public.task_due_rules (
 id uuid primary key default gen_random_uuid(),
 company_id uuid not null references public.companies(id) on delete cascade,
 -- Critérios (null = qualquer). Com projeto, cliente e produto são os dele.
 project_id uuid,
 client_id uuid,
 product_id uuid,
 team_id uuid,
 user_id uuid,
 business_days integer not null check (business_days between 0 and 250),
 -- Antes deste mínimo, só com motivo (null: sem mínimo).
 min_days integer check (min_days between 0 and 250),
 -- Somados (ao prazo e ao mínimo) quando a tarefa pede aprovação do cliente.
 approval_days integer not null default 0 check (approval_days between 0 and 60),
 active boolean not null default true,
 created_by uuid default auth.uid(),
 created_at timestamptz not null default now(),
 updated_by uuid default auth.uid(),
 updated_at timestamptz not null default now(),
 unique (company_id, id),
 -- Projetos só são únicos por produto contratado; a empresa é conferida ao salvar.
 foreign key (project_id) references public.projects(id) on delete cascade,
 foreign key (company_id, client_id) references public.clients(company_id, id) on delete cascade,
 foreign key (company_id, product_id) references public.products(company_id, id) on delete cascade,
 foreign key (company_id, team_id) references public.teams(company_id, id) on delete cascade,
 foreign key (company_id, user_id) references public.memberships(company_id, user_id) on delete cascade,
 check (min_days is null or min_days <= business_days),
 check (project_id is null or (client_id is null and product_id is null))
);
-- Uma regra por combinação de critérios.
create unique index task_due_rules_scope on public.task_due_rules
 (company_id, project_id, client_id, product_id, team_id, user_id) nulls not distinct;
alter table public.task_due_rules enable row level security;
revoke all on public.task_due_rules from public, anon, authenticated;
grant select on public.task_due_rules to authenticated;
-- Quem cria tarefas precisa delas; mudanças só pelas funções abaixo.
create policy task_due_rules_read on public.task_due_rules for select to authenticated
 using (mavi_private.member(company_id));

-- Quanto mais específica, maior (Projeto › Cliente › Produto › Equipe › Pessoa).
create function mavi_private.due_rule_weight(r public.task_due_rules) returns integer
language sql immutable set search_path = '' as $$
 select (case when r.project_id is not null then 16 else 0 end) + (case when r.client_id is not null then 8 else 0 end)
  + (case when r.product_id is not null then 4 else 0 end) + (case when r.team_id is not null then 2 else 0 end)
  + (case when r.user_id is not null then 1 else 0 end)
$$;

-- A regra que vale para uma tarefa. A equipe é a da tarefa (enviada para uma
-- equipe) ou, sem ela, uma equipe de quem executa que atende o cliente. Em
-- empate (duas equipes da pessoa), a de prazo maior.
create function mavi_private.due_rule_for(c uuid, p_contract uuid, p_project uuid, p_team uuid, p_assignee uuid)
 returns public.task_due_rules
language sql stable security definer set search_path = '' as $$
 select r.* from public.task_due_rules r
 join public.contracts k on k.company_id = c and k.id = p_contract
 where r.company_id = c and r.active
  and (r.project_id is null or r.project_id = p_project)
  and (r.client_id is null or r.client_id = k.client_id)
  and (r.product_id is null or r.product_id = k.product_id)
  and (r.team_id is null or r.team_id = p_team or (p_team is null
   and exists(select 1 from public.team_members tm
    where tm.company_id = c and tm.team_id = r.team_id and tm.user_id = p_assignee)
   and exists(select 1 from public.client_teams ct
    where ct.company_id = c and ct.client_id = k.client_id and ct.team_id = r.team_id)))
  and (r.user_id is null or r.user_id = p_assignee)
 order by mavi_private.due_rule_weight(r) desc, r.business_days desc, r.id
 limit 1
$$;

-- O prazo e o mínimo que uma regra dá, contando de `p_base`.
create function mavi_private.rule_due_dates(c uuid, r public.task_due_rules, p_base date, p_approval boolean,
 out due date, out min_due date)
language plpgsql stable security definer set search_path = '' as $$
declare base date := mavi_private.next_business_day(c, p_base);
 extra integer := case when p_approval then r.approval_days else 0 end; begin
 due := mavi_private.add_company_business_days(c, base, r.business_days + extra);
 min_due := case when r.min_days is null then null
  else mavi_private.add_company_business_days(c, base, r.min_days + extra) end;
end $$;

-- O prazo que a tarefa guarda. Sem `p_manual`, o da regra (ou `p_due`, se
-- nenhuma regra vale); com ele, `p_due`, que antes do mínimo da regra pede
-- um motivo (só quando `p_check_min`: na edição, só ao encurtar).
create function mavi_private.choose_due(c uuid, p_contract uuid, p_project uuid, p_team uuid, p_assignee uuid,
 p_base date, p_approval boolean, p_due date, p_manual boolean, p_reason text, p_check_min boolean,
 out due date, out rule_id uuid, out manual boolean, out min_due date, out tight_reason text)
language plpgsql stable security definer set search_path = '' as $$
declare r public.task_due_rules; d record; begin
 r := mavi_private.due_rule_for(c, p_contract, p_project, p_team, p_assignee);
 if r.id is not null then
  select * into d from mavi_private.rule_due_dates(c, r, p_base, coalesce(p_approval, false));
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
revoke all on function mavi_private.due_rule_weight(public.task_due_rules),
 mavi_private.due_rule_for(uuid, uuid, uuid, uuid, uuid),
 mavi_private.rule_due_dates(uuid, public.task_due_rules, date, boolean),
 mavi_private.choose_due(uuid, uuid, uuid, uuid, uuid, date, boolean, date, boolean, text, boolean)
 from public, anon, authenticated;

-- De onde a contagem parte numa tarefa já criada: início planejado ou o dia
-- em que foi criada.
create function mavi_private.task_due_base(t public.tasks) returns date
language sql stable security definer set search_path = '' as $$
 select coalesce(t.start_date, (t.created_at at time zone coalesce(
  (select timezone from public.companies where id = t.company_id), 'America/Sao_Paulo'))::date)
$$;
revoke all on function mavi_private.task_due_base(public.tasks) from public, anon, authenticated;

-- Quem configura: administradores tudo; gestores só regras das suas equipes,
-- dos clientes que elas atendem, dos projetos desses clientes e das pessoas
-- delas — toda regra de gestor tem ao menos um desses critérios, e todos
-- dentro da sua área.
create function mavi_private.can_manage_due_scope(c uuid, p_project uuid, p_client uuid, p_team uuid, p_user uuid)
 returns boolean
language plpgsql stable security definer set search_path = '' as $$
declare my_teams uuid[]; scoped boolean := false; project_client uuid; begin
 if mavi_private.admin(c) then return true; end if;
 if not mavi_private.leader(c) then return false; end if;
 select coalesce(array_agg(tm.team_id), '{}') into my_teams from public.team_members tm
  where tm.company_id = c and tm.user_id = auth.uid();
 if p_team is not null then
  if not p_team = any(my_teams) then return false; end if;
  scoped := true;
 end if;
 if p_project is not null then
  select k.client_id into project_client from public.projects p
   join public.contracts k on k.company_id = p.company_id and k.id = p.contract_id
   where p.company_id = c and p.id = p_project;
 end if;
 if coalesce(p_client, project_client) is not null then
  if not exists(select 1 from public.client_teams ct where ct.company_id = c
   and ct.client_id = coalesce(p_client, project_client) and ct.team_id = any(my_teams)) then return false; end if;
  scoped := true;
 end if;
 if p_user is not null then
  if not exists(select 1 from public.team_members tm where tm.company_id = c
   and tm.user_id = p_user and tm.team_id = any(my_teams)) then return false; end if;
  scoped := true;
 end if;
 return scoped;
end $$;
revoke all on function mavi_private.can_manage_due_scope(uuid, uuid, uuid, uuid, uuid) from public, anon, authenticated;

create function public.save_task_due_rule(p_company uuid, p_id uuid, p_project uuid, p_client uuid,
 p_product uuid, p_team uuid, p_user uuid, p_days integer, p_min integer default null,
 p_approval_days integer default 0, p_active boolean default true) returns uuid
language plpgsql security definer set search_path = '' as $$
declare old public.task_due_rules; result uuid; begin
 if not mavi_private.leader(p_company) then
  raise exception 'Somente administradores e gestores configuram prazos' using errcode = '42501';
 end if;
 -- O projeto já diz o cliente e o produto.
 if p_project is not null then p_client := null; p_product := null; end if;
 if p_days is null or p_days not between 0 and 250 then raise exception 'O prazo vai de 0 a 250 dias úteis'; end if;
 if p_min is not null and p_min not between 0 and p_days then
  raise exception 'O mínimo vai de 0 até o próprio prazo (% dias úteis)', p_days;
 end if;
 if coalesce(p_approval_days, 0) not between 0 and 60 then
  raise exception 'Os dias a mais pela aprovação do cliente vão de 0 a 60';
 end if;
 if p_project is not null and not exists(select 1 from public.projects
  where company_id = p_company and id = p_project) then raise exception 'Projeto não encontrado'; end if;
 if not mavi_private.can_manage_due_scope(p_company, p_project, p_client, p_team, p_user) then
  raise exception 'Gestores configuram só regras das suas equipes, dos clientes que elas atendem e das pessoas delas'
   using errcode = '42501';
 end if;
 begin
  if p_id is null then
   insert into public.task_due_rules(company_id, project_id, client_id, product_id, team_id, user_id,
    business_days, min_days, approval_days, active)
   values (p_company, p_project, p_client, p_product, p_team, p_user, p_days, p_min,
    coalesce(p_approval_days, 0), coalesce(p_active, true)) returning id into result;
  else
   select * into old from public.task_due_rules where company_id = p_company and id = p_id for update;
   if not found then raise exception 'Regra não encontrada'; end if;
   if not mavi_private.can_manage_due_scope(p_company, old.project_id, old.client_id, old.team_id, old.user_id) then
    raise exception 'Sem permissão para mudar esta regra' using errcode = '42501';
   end if;
   update public.task_due_rules set project_id = p_project, client_id = p_client, product_id = p_product,
    team_id = p_team, user_id = p_user, business_days = p_days, min_days = p_min,
    approval_days = coalesce(p_approval_days, 0), active = coalesce(p_active, true),
    updated_by = auth.uid(), updated_at = now()
   where id = p_id returning id into result;
  end if;
 exception when unique_violation then
  raise exception 'Já existe uma regra para essa mesma combinação';
 end;
 return result;
end $$;
revoke all on function public.save_task_due_rule(uuid, uuid, uuid, uuid, uuid, uuid, uuid, integer, integer, integer, boolean)
 from public, anon;
grant execute on function public.save_task_due_rule(uuid, uuid, uuid, uuid, uuid, uuid, uuid, integer, integer, integer, boolean)
 to authenticated;

-- As tarefas já criadas mantêm o prazo que têm.
create function public.delete_task_due_rule(p_rule uuid) returns void
language plpgsql security definer set search_path = '' as $$ declare r public.task_due_rules; begin
 select * into r from public.task_due_rules where id = p_rule;
 if not found or not mavi_private.leader(r.company_id)
  or not mavi_private.can_manage_due_scope(r.company_id, r.project_id, r.client_id, r.team_id, r.user_id) then
  raise exception 'Sem permissão' using errcode = '42501';
 end if;
 delete from public.task_due_rules where id = p_rule;
end $$;
revoke all on function public.delete_task_due_rule(uuid) from public, anon;
grant execute on function public.delete_task_due_rule(uuid) to authenticated;

-- Apps abertos recarregam os catálogos (regras e calendário) quando mudam.
create trigger broadcast_lookup after insert or update or delete on public.task_due_rules
 for each row execute function mavi_private.broadcast_lookup();
create trigger broadcast_lookup after insert or update or delete on public.company_calendar_days
 for each row execute function mavi_private.broadcast_lookup();

-- ------------------------------------------------------------ tarefas
-- Tarefas de antes: prazo escolhido à mão.
alter table public.tasks add column due_manual boolean not null default true;
-- A regra que deu o prazo (só quando due_manual = false).
alter table public.tasks add column due_rule_id uuid;
-- O motivo de um prazo antes do mínimo da regra ("prazo apertado").
alter table public.tasks add column due_tight_reason text;

-- O que muda no histórico quando o prazo fica antes do mínimo.
create function mavi_private.log_tight_due(t public.tasks, p_min date, p_reason text) returns void
language sql security definer set search_path = '' as $$
 insert into public.task_events(company_id, task_id, actor_id, action, detail)
 values (t.company_id, t.id, coalesce(auth.uid(), t.creator_id), 'due_below_minimum',
  jsonb_build_object('due', t.due_date, 'min', p_min, 'reason', p_reason))
$$;
revoke all on function mavi_private.log_tight_due(public.tasks, date, text) from public, anon, authenticated;

-- create_task: sem p_due_manual, o prazo é o da regra, calculado para quem
-- recebe a tarefa (numa equipe, depois da distribuição).
drop function public.create_task(uuid,uuid,text,uuid,date,uuid,uuid,text,text,integer,boolean,uuid,date,jsonb,text);
create function public.create_task(p_company uuid,p_contract uuid,p_title text,p_assignee uuid,p_due date,
 p_project uuid default null,p_team uuid default null,p_description text default '',p_priority text default 'normal',
 p_estimated integer default 0,p_client_approval boolean default false,p_parent uuid default null,p_start date default null,
 p_custom jsonb default '{}', p_repeat text default null, p_due_manual boolean default true,
 p_due_reason text default null) returns uuid
language plpgsql security definer set search_path = '' as $$
declare result uuid; custom jsonb; assignee uuid := p_assignee; ch record; t public.tasks; begin
 if not mavi_private.contract_access(p_company,p_contract) then raise exception 'Sem acesso ao produto contratado' using errcode='42501'; end if;
 if assignee is null and p_team is null then raise exception 'Escolha um responsável ou uma equipe'; end if;
 if p_team is not null and not exists(
  select 1 from public.contracts k join public.client_teams ct on ct.company_id=k.company_id and ct.client_id=k.client_id
  where k.company_id=p_company and k.id=p_contract and ct.team_id=p_team) then raise exception 'Equipe não atende este cliente'; end if;
 if p_parent is not null and not mavi_private.can_edit(p_company,p_parent) then raise exception 'Sem acesso à tarefa principal' using errcode='42501'; end if;
 if assignee is null then
  -- One pick at a time per team, so simultaneous tasks spread out.
  perform 1 from public.teams where company_id=p_company and id=p_team for update;
  assignee := mavi_private.team_assignee(p_company, p_team);
  if assignee is null then
   raise exception 'Esta equipe não tem ninguém ativo para receber a tarefa.';
  end if;
  custom := mavi_private.fill_custom_fields(mavi_private.team_template_fields(p_company,p_contract,p_team), p_custom);
 else
  if not exists(select 1 from public.memberships where company_id=p_company and user_id=assignee and active) then raise exception 'Responsável inválido'; end if;
  custom := mavi_private.fill_custom_fields(mavi_private.template_fields_for(p_company,p_contract,assignee), p_custom);
 end if;
 select * into ch from mavi_private.choose_due(p_company, p_contract, p_project, p_team, assignee,
  coalesce(p_start, mavi_private.company_today(p_company)), p_client_approval, p_due, p_due_manual, p_due_reason, true);
 insert into public.tasks(company_id,contract_id,title,assignee_id,due_date,original_due_date,project_id,team_id,description,priority,estimated_minutes,requires_client_approval,parent_id,start_date,custom_fields,
  due_manual,due_rule_id,due_tight_reason)
 values(p_company,p_contract,trim(p_title),assignee,ch.due,ch.due,p_project,p_team,p_description,p_priority,p_estimated,p_client_approval,p_parent,p_start,custom,
  ch.manual,ch.rule_id,ch.tight_reason) returning * into t;
 result := t.id;
 insert into public.task_events(company_id,task_id,actor_id,action,detail) values(p_company,result,auth.uid(),'created',
  case when ch.rule_id is not null then jsonb_build_object('due_rule', ch.rule_id) else '{}'::jsonb end);
 if ch.tight_reason is not null then perform mavi_private.log_tight_due(t, ch.min_due, ch.tight_reason); end if;
 if p_repeat is not null then perform mavi_private.start_recurrence(result, p_repeat, p_assignee is null); end if;
 return result;
end $$;
revoke all on function public.create_task(uuid,uuid,text,uuid,date,uuid,uuid,text,text,integer,boolean,uuid,date,jsonb,text,boolean,text) from public, anon;
grant execute on function public.create_task(uuid,uuid,text,uuid,date,uuid,uuid,text,text,integer,boolean,uuid,date,jsonb,text,boolean,text) to authenticated;

-- update_task: um prazo novo é à mão, a não ser que venha com
-- p_due_manual = false ("aplicar a regra"); encurtar para antes do mínimo
-- pede motivo. Sem mudar a data, o prazo continua como estava.
drop function public.update_task(uuid,integer,text,text,date,integer,text,date);
create function public.update_task(p_task uuid,p_version integer,p_title text,p_description text,p_due date,p_estimated integer,p_priority text,p_start date default null,
 p_due_manual boolean default null, p_due_reason text default null) returns public.tasks
language plpgsql security definer set search_path = '' as $$ declare t public.tasks; ch record; begin
 select * into t from public.tasks where id=p_task for update;
 if not found or not mavi_private.can_edit(t.company_id,t.id) then raise exception 'Sem permissão' using errcode='42501'; end if;
 if t.version<>p_version then raise exception 'A tarefa mudou. Atualize antes de continuar.' using errcode='40001'; end if;
 if p_due is distinct from t.due_date or p_due_manual is false then
  select * into ch from mavi_private.choose_due(t.company_id, t.contract_id, t.project_id, t.team_id, t.assignee_id,
   coalesce(p_start, mavi_private.task_due_base(t)), t.requires_client_approval, p_due, coalesce(p_due_manual, true),
   p_due_reason, p_due < t.due_date);
 else
  select t.due_date as due, t.due_rule_id as rule_id, t.due_manual as manual, null::date as min_due,
   t.due_tight_reason as tight_reason into ch;
 end if;
 update public.tasks set start_date=p_start,title=trim(p_title),description=p_description,due_date=ch.due,estimated_minutes=p_estimated,priority=p_priority,
 due_manual=ch.manual,due_rule_id=ch.rule_id,
 -- O motivo novo; ou o de antes, enquanto o prazo continua antes do mínimo.
 due_tight_reason=case when ch.due is not distinct from t.due_date then t.due_tight_reason
  when ch.tight_reason is not null then ch.tight_reason
  when ch.min_due is not null and ch.due < ch.min_due then t.due_tight_reason end,
 internal_approved_by=null,client_approved_by=null,client_approval_note=null,revision=revision+1,version=version+1,
 delivered_at=null,status=case when status in ('review','done') then 'progress' else status end where id=t.id;
 insert into public.task_events(company_id,task_id,actor_id,action,detail) values(t.company_id,t.id,auth.uid(),'edited',
  jsonb_build_object('old_due',t.due_date,'new_due',ch.due) || case when ch.due is distinct from t.due_date and not ch.manual
   then jsonb_build_object('due_rule', ch.rule_id) else '{}'::jsonb end);
 select * into t from public.tasks where id=t.id;
 if ch.tight_reason is not null and ch.min_due is not null then perform mavi_private.log_tight_due(t, ch.min_due, ch.tight_reason); end if;
 return t;
end $$;
revoke all on function public.update_task(uuid,integer,text,text,date,integer,text,date,boolean,text) from public, anon;
grant execute on function public.update_task(uuid,integer,text,text,date,integer,text,date,boolean,text) to authenticated;

-- ------------------------------------------------------------ subtarefas
-- A principal nunca vence antes de uma subtarefa: passa a vencer no mesmo
-- dia (não mexe na que já foi entregue).
create function mavi_private.extend_parent_due() returns trigger
language plpgsql security definer set search_path = '' as $$
declare p public.tasks; begin
 if new.parent_id is null or new.archived then return null; end if;
 select * into p from public.tasks where company_id = new.company_id and id = new.parent_id for update;
 if not found or p.archived or p.status = 'done' or p.due_date >= new.due_date then return null; end if;
 update public.tasks set due_date = new.due_date, version = version + 1 where id = p.id;
 insert into public.task_events(company_id, task_id, actor_id, action, detail)
 values (p.company_id, p.id, coalesce(auth.uid(), new.creator_id), 'due_extended_by_subtask',
  jsonb_build_object('old_due', p.due_date, 'new_due', new.due_date, 'subtask', new.id, 'title', new.title));
 -- Num lote as tarefas não avisam uma a uma: a principal avisa aqui.
 if coalesce(current_setting('mavi.bulk_tasks', true), '') = '1' then
  perform mavi_private.broadcast_tasks(p.company_id, array[p.id], mavi_private.task_people(p));
 end if;
 return null;
end $$;
revoke all on function mavi_private.extend_parent_due() from public, anon, authenticated;
create trigger extend_parent_due_ins after insert on public.tasks
 for each row when (new.parent_id is not null) execute function mavi_private.extend_parent_due();
create trigger extend_parent_due_upd after update of due_date, parent_id on public.tasks
 for each row when (new.parent_id is not null and (old.due_date is distinct from new.due_date
  or old.parent_id is distinct from new.parent_id)) execute function mavi_private.extend_parent_due();

-- ------------------------------------------------------------ repetição
-- Uma tarefa com prazo da regra repete com prazo da regra: cada cópia usa a
-- regra do dia em que abre (para quem a recebe). As de prazo à mão mantêm a
-- mesma distância entre abertura e prazo.
alter table public.task_recurrences add column due_by_rule boolean not null default false;

create or replace function mavi_private.start_recurrence(p_task uuid, p_frequency text, p_by_team boolean) returns uuid
language plpgsql security definer set search_path = '' as $$
declare t public.tasks; today date; result uuid; begin
 if p_frequency not in ('daily','weekdays','weekly','biweekly','monthly') then
  raise exception 'Escolha como a tarefa se repete';
 end if;
 select * into t from public.tasks where id = p_task;
 today := mavi_private.company_today(t.company_id);
 insert into public.task_recurrences(company_id, source_task_id, creator_id, frequency, anchor, next_run,
  contract_id, project_id, team_id, parent_id, assignee_id, title, description, priority, estimated_minutes,
  requires_client_approval, custom_fields, due_offset, start_offset, due_by_rule)
 values (t.company_id, t.id, t.creator_id, p_frequency, today, mavi_private.next_recurrence(p_frequency, today, today),
  t.contract_id, t.project_id, t.team_id, t.parent_id, case when p_by_team then null else t.assignee_id end,
  t.title, mavi_private.description_for_copies(t.description), t.priority, t.estimated_minutes,
  t.requires_client_approval, t.custom_fields, greatest(t.due_date - today, 0), t.start_date - today, not t.due_manual)
 returning id into result;
 update public.tasks set recurrence_id = result where id = t.id;
 insert into public.task_events(company_id, task_id, actor_id, action, detail)
  values (t.company_id, t.id, t.creator_id, 'recurrence_started', jsonb_build_object('frequency', p_frequency));
 return result;
end $$;

create or replace function mavi_private.open_recurrence_copy(r public.task_recurrences, today date) returns uuid
language plpgsql security definer set search_path = '' as $$
declare assignee uuid; result uuid; parent uuid; ch record; begin
 if exists(select 1 from public.contracts k where k.company_id = r.company_id and k.id = r.contract_id and k.archived) then
  raise exception 'O produto contratado está arquivado';
 end if;
 if r.assignee_id is null then
  perform 1 from public.teams where company_id = r.company_id and id = r.team_id for update;
  assignee := mavi_private.team_assignee(r.company_id, r.team_id);
  if assignee is null then raise exception 'A equipe não tem ninguém ativo para receber a tarefa'; end if;
 else
  -- Someone who left: the copy goes to whoever set up the repetition.
  select m.user_id into assignee from public.memberships m
   where m.company_id = r.company_id and m.active and m.user_id in (r.assignee_id, r.creator_id)
   order by m.user_id = r.assignee_id desc limit 1;
  if assignee is null then raise exception 'Responsável e criador não estão mais ativos'; end if;
 end if;
 select id into parent from public.tasks
  where company_id = r.company_id and contract_id = r.contract_id and id = r.parent_id and not archived;
 -- Sem regra que valha hoje, a distância de sempre.
 select * into ch from mavi_private.choose_due(r.company_id, r.contract_id, r.project_id, r.team_id, assignee,
  today + coalesce(r.start_offset, 0), r.requires_client_approval, today + r.due_offset, not r.due_by_rule, null, false);
 insert into public.tasks(company_id, contract_id, title, assignee_id, creator_id, due_date, original_due_date,
  project_id, team_id, description, priority, estimated_minutes, requires_client_approval, parent_id, start_date,
  custom_fields, recurrence_id, due_manual, due_rule_id)
 values (r.company_id, r.contract_id, r.title, assignee, r.creator_id, ch.due, ch.due,
  r.project_id, r.team_id, r.description, r.priority, r.estimated_minutes, r.requires_client_approval, parent,
  today + r.start_offset, r.custom_fields, r.id, ch.manual, ch.rule_id)
 returning id into result;
 insert into public.task_events(company_id, task_id, actor_id, action, detail)
  values (r.company_id, result, r.creator_id, 'created', jsonb_build_object('recurrence', r.frequency));
 return result;
end $$;

-- ------------------------------------------------------------ em massa
-- Novo: {"kind":"rule"} recalcula cada prazo pela regra que vale para a
-- tarefa (contando do início planejado ou do dia da criação). "due" e
-- "shift" ficam à mão, pulam os feriados da empresa e, antes do mínimo da
-- regra, pedem o motivo em p_change->>'reason'.
create or replace function public.bulk_update_tasks(p_company uuid, p_tasks uuid[], p_change jsonb,
 p_preview boolean default false) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
 me uuid := auth.uid();
 kind text := p_change->>'kind';
 ids uuid[]; tid uuid;
 t public.tasks; changed public.tasks;
 v_person uuid; v_team uuid; v_status text; v_note text := coalesce(p_change->>'note', '');
 v_due date; v_shift integer; new_due date; pick uuid;
 v_reason text := nullif(trim(coalesce(p_change->>'reason', '')), '');
 ch record; label text; reason text;
 results jsonb := '[]'; items jsonb := '[]';
 touched uuid[] := '{}'; people uuid[] := '{}';
 applied integer := 0; op uuid;
begin
 if me is null or not mavi_private.member(p_company) then
  raise exception 'Sem acesso à empresa' using errcode = '42501'; end if;
 select array_agg(x order by n) into ids
  from (select x, min(n) n from unnest(p_tasks) with ordinality u(x, n) where x is not null group by x) s;
 if coalesce(cardinality(ids), 0) = 0 then raise exception 'Selecione ao menos uma tarefa'; end if;
 if cardinality(ids) > 500 then raise exception 'Selecione no máximo 500 tarefas por vez'; end if;

 case kind
 when 'assignee' then
  v_person := (p_change->>'value')::uuid;
  select name into label from public.memberships where company_id = p_company and user_id = v_person and active;
  if label is null then raise exception 'Escolha um responsável ativo da empresa'; end if;
 when 'team' then
  v_team := (p_change->>'value')::uuid;
  select name into label from public.teams where company_id = p_company and id = v_team;
  if label is null then raise exception 'Equipe não encontrada'; end if;
  if mavi_private.team_assignee(p_company, v_team) is null then
   raise exception 'Esta equipe não tem ninguém ativo para receber tarefas.'; end if;
  -- Uma distribuição por vez por equipe, como na criação de tarefas.
  perform 1 from public.teams where company_id = p_company and id = v_team for update;
 when 'status' then
  v_status := p_change->>'value';
  if v_status is null or v_status not in ('progress', 'returned', 'review', 'rejected', 'correction', 'done') then
   raise exception 'Status inválido'; end if;
 when 'due' then
  v_due := (p_change->>'value')::date;
  if v_due is null then raise exception 'Escolha o novo prazo'; end if;
 when 'shift' then
  v_shift := (p_change->>'value')::integer;
  if v_shift is null or v_shift = 0 or abs(v_shift) > 365 then
   raise exception 'Escolha de 1 a 365 dias úteis'; end if;
 when 'rule' then null;
 else raise exception 'Alteração inválida';
 end case;
 if v_reason is not null and length(v_reason) < 5 then
  raise exception 'Explique o motivo com um pouco mais de detalhe'; end if;

 perform set_config('mavi.bulk_tasks', '1', true);
 begin
  foreach tid in array ids loop
   reason := null;
   select * into t from public.tasks where company_id = p_company and id = tid;
   if not found or t.archived or not mavi_private.task_access(p_company, tid) then
    results := results || jsonb_build_object('id', tid, 'ok', false, 'reason', 'Tarefa não encontrada');
    continue;
   end if;
   begin
    case kind
    when 'assignee' then
     if t.assignee_id = v_person then reason := 'Já está com ' || label;
     else perform public.transition_task(t.id, t.version, 'move', '', t.status, v_person); end if;
    when 'team' then
     if not exists(select 1 from public.contracts k join public.client_teams ct
       on ct.company_id = k.company_id and ct.client_id = k.client_id
       where k.company_id = p_company and k.id = t.contract_id and ct.team_id = v_team) then
      reason := 'A equipe ' || label || ' não atende este cliente';
     else
      pick := mavi_private.team_assignee(p_company, v_team);
      if pick = t.assignee_id then
       reason := 'Continua com ' || coalesce((select name from public.memberships
        where company_id = p_company and user_id = pick), '—') || ', quem tem menos tarefas na equipe';
      else
       perform public.transition_task(t.id, t.version, 'move', '', t.status, pick);
       update public.tasks set team_id = v_team where id = t.id and team_id is distinct from v_team;
      end if;
     end if;
    when 'status' then
     if t.status = v_status then reason := 'Já está em ' || mavi_private.status_label(v_status);
     else perform public.transition_task(t.id, t.version, 'move', v_note, v_status, null); end if;
    else
     if not mavi_private.can_edit(p_company, t.id) then
      reason := 'Só quem criou a tarefa ou um gestor muda o prazo';
     else
      new_due := case kind when 'due' then v_due
       when 'shift' then mavi_private.add_company_business_days(p_company, t.due_date, v_shift) end;
      select * into ch from mavi_private.choose_due(p_company, t.contract_id, t.project_id, t.team_id, t.assignee_id,
       mavi_private.task_due_base(t), t.requires_client_approval, coalesce(new_due, t.due_date), kind <> 'rule',
       null, false);
      if kind = 'rule' and ch.rule_id is null then reason := 'Nenhuma regra de prazo vale para esta tarefa';
      elsif ch.due = t.due_date and kind = 'rule' and not t.due_manual then reason := 'Já está no prazo da regra';
      elsif ch.due = t.due_date and kind <> 'rule' then reason := 'Já tem esse prazo';
      elsif t.start_date is not null and ch.due < t.start_date then
       reason := 'O prazo ficaria antes do início (' || to_char(t.start_date, 'DD/MM') || ')';
      elsif kind <> 'rule' and ch.min_due is not null and ch.due < ch.min_due and ch.due < t.due_date
       and v_reason is null then
       reason := 'Fica antes do mínimo da regra (' || to_char(ch.min_due, 'DD/MM') || '): informe o motivo';
      else
       update public.tasks set due_date = ch.due, due_manual = ch.manual, due_rule_id = ch.rule_id,
        due_tight_reason = case when kind <> 'rule' and ch.min_due is not null and ch.due < ch.min_due
         then coalesce(case when ch.due < t.due_date then v_reason end, t.due_tight_reason) end,
        version = version + 1
       where id = t.id returning * into changed;
       insert into public.task_events(company_id, task_id, actor_id, action, detail)
       values (p_company, t.id, me, 'due_changed', jsonb_build_object('old_due', t.due_date, 'new_due', ch.due)
        || case when kind = 'rule' then jsonb_build_object('due_rule', ch.rule_id) else '{}'::jsonb end);
       if changed.due_tight_reason is not null and changed.due_tight_reason is distinct from t.due_tight_reason then
        perform mavi_private.log_tight_due(changed, ch.min_due, changed.due_tight_reason);
       end if;
      end if;
     end if;
    end case;
   exception when others then
    -- A regra de cada tarefa vale como sempre: a mensagem vira o motivo.
    reason := sqlerrm;
   end;
   select * into changed from public.tasks where id = t.id;
   if reason is null then
    applied := applied + 1;
    touched := touched || t.id;
    people := people || mavi_private.task_people(t) || mavi_private.task_people(changed);
    items := items || jsonb_build_object('task_id', t.id, 'after_version', changed.version,
     'before', jsonb_build_object('status', t.status, 'assignee_id', t.assignee_id, 'team_id', t.team_id,
      'due_date', t.due_date, 'internal_approved_by', t.internal_approved_by,
      'client_approved_by', t.client_approved_by, 'client_approval_note', t.client_approval_note,
      'revision', t.revision, 'delivered_at', t.delivered_at, 'due_manual', t.due_manual,
      'due_rule_id', t.due_rule_id, 'due_tight_reason', t.due_tight_reason));
   end if;
   results := results || jsonb_build_object('id', t.id, 'title', t.title, 'contract_id', t.contract_id,
    'parent_id', t.parent_id, 'ok', reason is null, 'reason', reason,
    'before', jsonb_build_object('status', t.status, 'assignee_id', t.assignee_id, 'due_date', t.due_date),
    'after', jsonb_build_object('status', changed.status, 'assignee_id', changed.assignee_id,
     'due_date', changed.due_date));
  end loop;
  -- A revisão: tudo o que o lote fez é desfeito aqui, o resultado fica.
  if p_preview then raise exception 'mavi bulk preview' using errcode = 'MV001'; end if;
 exception when sqlstate 'MV001' then null;
 end;
 perform set_config('mavi.bulk_tasks', '', true);
 if p_preview then
  return jsonb_build_object('preview', true, 'applied', applied, 'results', results);
 end if;

 if applied > 0 then
  insert into public.task_bulk_operations(company_id, actor_id, change)
  values (p_company, me, p_change) returning id into op;
  insert into public.task_bulk_items(operation_id, company_id, task_id, before, after_version)
  select op, p_company, (i->>'task_id')::uuid, i->'before', (i->>'after_version')::integer
  from jsonb_array_elements(items) i;
  if kind in ('assignee', 'team') then
   insert into public.notifications(company_id, user_id, actor_id, task_id, kind, title, body, link)
   select p_company, r.u, me, null, 'tasks_assigned',
    coalesce((select name from public.memberships where company_id = p_company and user_id = me), 'Alguém')
     || ' passou ' || count(*) || case when count(*) = 1 then ' tarefa' else ' tarefas' end || ' para você',
    left(string_agg(r.title, ' · ' order by r.n), 300),
    '/tarefas?escopo=mine&lote=' || op
   from (select (x->'after'->>'assignee_id')::uuid u, x->>'title' title, n
    from jsonb_array_elements(results) with ordinality e(x, n)
    where (x->>'ok')::boolean and x->'after'->>'assignee_id' is distinct from x->'before'->>'assignee_id') r
   where r.u <> me
   group by r.u;
  end if;
  perform mavi_private.broadcast_tasks(p_company, touched, people);
 end if;
 -- Lotes de mais de uma semana já não se desfazem.
 delete from public.task_bulk_operations
  where company_id = p_company and actor_id = me and created_at < now() - interval '7 days';
 return jsonb_build_object('preview', false, 'operation', op, 'applied', applied, 'results', results);
end $$;

-- O desfazer devolve também de onde o prazo veio (lotes de antes não o
-- guardavam: ficam como estão).
create or replace function public.undo_task_bulk(p_operation uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare o public.task_bulk_operations; i public.task_bulk_items; t public.tasks; b jsonb;
 restored integer := 0; kept integer := 0; touched uuid[] := '{}'; people uuid[] := '{}'; begin
 select * into o from public.task_bulk_operations where id = p_operation for update;
 if not found or o.actor_id <> auth.uid() or not mavi_private.member(o.company_id) then
  raise exception 'Alteração não encontrada' using errcode = '42501'; end if;
 if o.undone_at is not null then raise exception 'Esta alteração já foi desfeita'; end if;
 if o.created_at < now() - interval '24 hours' then
  raise exception 'Só dá para desfazer uma alteração em massa até 24 horas depois'; end if;
 perform set_config('mavi.bulk_tasks', '1', true);
 for i in select * from public.task_bulk_items where operation_id = o.id loop
  select * into t from public.tasks where company_id = o.company_id and id = i.task_id for update;
  if not found or t.version <> i.after_version then kept := kept + 1; continue; end if;
  b := i.before;
  update public.tasks set status = b->>'status', assignee_id = (b->>'assignee_id')::uuid,
   team_id = (b->>'team_id')::uuid, due_date = (b->>'due_date')::date,
   internal_approved_by = (b->>'internal_approved_by')::uuid, client_approved_by = (b->>'client_approved_by')::uuid,
   client_approval_note = b->>'client_approval_note', revision = (b->>'revision')::integer,
   delivered_at = (b->>'delivered_at')::timestamptz,
   due_manual = case when b ? 'due_manual' then (b->>'due_manual')::boolean else due_manual end,
   due_rule_id = case when b ? 'due_manual' then (b->>'due_rule_id')::uuid else due_rule_id end,
   due_tight_reason = case when b ? 'due_manual' then b->>'due_tight_reason' else due_tight_reason end,
   version = version + 1
  where id = t.id;
  insert into public.task_events(company_id, task_id, actor_id, action, detail)
  values (o.company_id, t.id, auth.uid(), 'bulk_undone', jsonb_build_object(
   'from', t.status, 'to', b->>'status', 'assignee_from', t.assignee_id, 'assignee_to', b->>'assignee_id',
   'old_due', t.due_date, 'new_due', b->>'due_date', 'status_since', t.status_changed_at));
  restored := restored + 1;
  touched := touched || t.id;
  people := people || mavi_private.task_people(t) || (b->>'assignee_id')::uuid;
 end loop;
 update public.task_bulk_operations set undone_at = now() where id = o.id;
 -- O aviso de "passou N tarefas para você" deixa de valer.
 delete from public.notifications
  where company_id = o.company_id and kind = 'tasks_assigned' and link like '%lote=' || o.id::text;
 perform set_config('mavi.bulk_tasks', '', true);
 perform mavi_private.broadcast_tasks(o.company_id, touched, people);
 return jsonb_build_object('restored', restored, 'kept', kept);
end $$;

commit;
