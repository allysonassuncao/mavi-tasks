begin;

-- Prazo inteligente (Fase 3). A MAVI sugere um prazo ao lado da regra:
--
-- 1. Histórico: a mediana, em dias úteis, de tarefas parecidas já entregues
--    (da criação, ou do início planejado, até a primeira entrega, sem os dias
--    em Devolvida — esperando quem pediu). Parecidas, do mais específico ao
--    mais geral: mesma pessoa + mesmo produto contratado › mesmo produto
--    contratado (cliente + produto) › mesma pessoa + mesmo produto › mesmo
--    produto. Vale o primeiro nível com 5 ou mais entregas no último ano (as
--    30 mais recentes); com menos em todos, não há sugestão.
-- 2. Carga: o que quem executa tem em aberto e vence antes (estimado menos o
--    já lançado, com prioridade igual ou maior) mais a estimativa desta
--    tarefa, contra as horas por dia da pessoa menos as reuniões (horários
--    ocupados da agenda Google, só o total por dia). Se não couber até a
--    data do histórico, a sugestão vai para o dia em que couber.
-- 3. Aprovação do cliente: os dias da regra entram quando as parecidas, na
--    maioria, não pediam aprovação.
-- 4. Retrabalho: com histórico que não é do cliente, um cliente com bem mais
--    retrabalho que a média ganha um dia a mais.
-- 5. Nunca antes do mínimo da regra.
--
-- A empresa escolhe o modo: 'suggest' (a sugestão aparece ao lado; padrão),
-- 'fill' (preenche o prazo sozinha, até a pessoa mudar) ou 'off'. A tarefa
-- guarda o que a regra e a MAVI sugeriram na criação, para comparar com o
-- prazo definido e a entrega (Fase 4).

-- ------------------------------------------------------------ modo
alter table public.companies add column smart_due text not null default 'suggest'
 check (smart_due in ('off', 'suggest', 'fill'));

create function public.set_company_smart_due(p_company uuid, p_mode text) returns void
language plpgsql security definer set search_path = '' as $$ begin
 if not mavi_private.admin(p_company) then
  raise exception 'Somente administradores mudam o prazo inteligente' using errcode = '42501';
 end if;
 if p_mode not in ('off', 'suggest', 'fill') then raise exception 'Modo inválido'; end if;
 update public.companies set smart_due = p_mode where id = p_company;
end $$;
revoke all on function public.set_company_smart_due(uuid, text) from public, anon;
grant execute on function public.set_company_smart_due(uuid, text) to authenticated;

-- ------------------------------------------------------------ tarefas
-- O prazo veio da sugestão da MAVI (com due_manual = false).
alter table public.tasks add column due_smart boolean not null default false;
-- O que a regra e a MAVI davam na criação (null: sem regra / sem sugestão).
alter table public.tasks add column due_rule_date date;
alter table public.tasks add column due_smart_date date;

-- ------------------------------------------------------------ agenda
-- Minutos ocupados por dia na agenda Google de cada pessoa (só o total; nada
-- do compromisso). O servidor lê os horários ocupados quando uma sugestão
-- precisa deles e guarda aqui; a conta usa o que tiver sido lido na última
-- hora (e o formulário pede de novo quando está velho).
create table mavi_private.person_busy_days (
 user_id uuid not null references auth.users(id) on delete cascade,
 day date not null,
 minutes integer not null check (minutes between 0 and 1440),
 primary key (user_id, day)
);
create table mavi_private.person_busy_reads (
 user_id uuid primary key references auth.users(id) on delete cascade,
 read_at timestamptz not null,
 until_day date not null
);
alter table mavi_private.person_busy_days enable row level security;
alter table mavi_private.person_busy_reads enable row level security;
revoke all on mavi_private.person_busy_days, mavi_private.person_busy_reads from public, anon, authenticated;

-- Só para /api/google (o segredo do servidor): os tokens cifrados de quem
-- vai executar, para ler os horários ocupados. Quem pede precisa ser da
-- mesma empresa que a pessoa.
create function public.google_busy_tokens(p_secret text, p_company uuid, p_user uuid)
 returns table(refresh_token_cipher text, access_token_cipher text, access_expires_at timestamptz)
language plpgsql stable security definer set search_path = '' as $$ begin
 if not mavi_private.ai_secret_ok(p_secret) or not mavi_private.member(p_company)
  or not exists(select 1 from public.memberships m where m.company_id = p_company and m.user_id = p_user and m.active) then
  raise exception 'Sem permissão' using errcode = '42501';
 end if;
 return query select c.refresh_token_cipher, c.access_token_cipher, c.access_expires_at
  from mavi_private.google_connections c where c.user_id = p_user;
end $$;

-- Guarda os minutos ocupados de `p_from` a `p_to` ({"AAAA-MM-DD": minutos})
-- e, quando o servidor renovou o acesso, o token novo.
create function public.google_busy_save(p_secret text, p_company uuid, p_user uuid, p_from date, p_to date,
 p_days jsonb, p_access_cipher text default null, p_expires_at timestamptz default null) returns void
language plpgsql security definer set search_path = '' as $$ begin
 if not mavi_private.ai_secret_ok(p_secret) or not mavi_private.member(p_company)
  or not exists(select 1 from public.memberships m where m.company_id = p_company and m.user_id = p_user and m.active) then
  raise exception 'Sem permissão' using errcode = '42501';
 end if;
 if p_to < p_from or p_to - p_from > 120 then raise exception 'Período inválido'; end if;
 delete from mavi_private.person_busy_days where user_id = p_user and day between p_from and p_to;
 insert into mavi_private.person_busy_days(user_id, day, minutes)
 select p_user, d.key::date, least(greatest(round((d.value #>> '{}')::numeric)::integer, 0), 1440)
 from jsonb_each(coalesce(p_days, '{}')) d
 where d.key::date between p_from and p_to and (d.value #>> '{}')::numeric > 0;
 insert into mavi_private.person_busy_reads(user_id, read_at, until_day) values (p_user, now(), p_to)
 on conflict (user_id) do update set read_at = now(), until_day = excluded.until_day;
 -- Dias que já passaram não servem mais.
 delete from mavi_private.person_busy_days where user_id = p_user and day < p_from - 7;
 if p_access_cipher is not null then
  update mavi_private.google_connections set access_token_cipher = p_access_cipher,
   access_expires_at = p_expires_at, updated_at = now()
  where user_id = p_user;
 end if;
end $$;
revoke all on function public.google_busy_tokens(text, uuid, uuid),
 public.google_busy_save(text, uuid, uuid, date, date, jsonb, text, timestamptz) from public, anon;
grant execute on function public.google_busy_tokens(text, uuid, uuid),
 public.google_busy_save(text, uuid, uuid, date, date, jsonb, text, timestamptz) to authenticated;

-- ------------------------------------------------------------ cálculo
create function mavi_private.priority_rank(p text) returns integer
language sql immutable set search_path = '' as $$
 select case p when 'urgent' then 4 when 'high' then 3 when 'normal' then 2 else 1 end
$$;

-- Dias úteis (da empresa) depois de `a` até `b`.
create function mavi_private.business_days_between(c uuid, a date, b date) returns integer
language sql stable security definer set search_path = '' as $$
 select case when b <= a then 0 else (select count(*)::integer from generate_series(a + 1, least(b, a + 400), interval '1 day') d
  where mavi_private.is_business_day(c, d::date)) end
$$;

-- O ciclo de uma tarefa entregue: dias úteis do início (ou criação) à
-- primeira entrega, menos os dias em Devolvida. Null se nunca foi entregue.
create function mavi_private.task_cycle_days(t public.tasks, tz text) returns integer
language sql stable security definer set search_path = '' as $$
 with done as (
  select min(p.ended_at) at time zone tz as done_at from public.task_status_periods p
  where p.task_id = t.id and p.to_status = 'done'
 )
 select case when done.done_at is null then null else greatest(
  mavi_private.business_days_between(t.company_id,
   coalesce(t.start_date, (t.created_at at time zone tz)::date), done.done_at::date)
  - coalesce((select sum(mavi_private.business_days_between(t.company_id,
      (p.started_at at time zone tz)::date, (p.ended_at at time zone tz)::date))
    from public.task_status_periods p
    where p.task_id = t.id and p.status = 'returned' and p.ended_at is not null
     and p.ended_at <= (select min(q.ended_at) from public.task_status_periods q
      where q.task_id = t.id and q.to_status = 'done')), 0), 0) end
 from done
$$;

-- A sugestão da MAVI para uma tarefa de `p_assignee`, contando de `p_base`.
create function mavi_private.smart_due_calc(c uuid, p_contract uuid, p_project uuid, p_team uuid, p_assignee uuid,
 p_base date, p_approval boolean, p_priority text, p_estimated integer, p_exclude uuid default null) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
 tz text := coalesce((select timezone from public.companies where id = c), 'America/Sao_Paulo');
 k public.contracts; r public.task_due_rules; rd record;
 lvl integer; sample integer[]; approvals numeric; median integer := null;
 labels text[] := array['quem executa, neste cliente e produto', 'este cliente e produto',
  'quem executa, neste produto', 'este produto'];
 days integer; approval_added integer := 0; rework_added integer := 0;
 base date; candidate date; due date;
 daily integer; load_minutes integer := 0; load_tasks integer := 0; unestimated integer := 0;
 own integer := greatest(coalesce(p_estimated, 0), 0);
 need integer; have integer := 0; d date; busy integer; busy_total integer := 0; load_days integer := 0;
 client_rate numeric; level_rate numeric;
begin
 select * into k from public.contracts where company_id = c and id = p_contract;
 if not found or p_assignee is null then return jsonb_build_object('available', false, 'reason', 'target'); end if;

 -- 1. Histórico, do nível mais específico ao mais geral.
 for i in 1..4 loop
  select array_agg(x.cycle order by x.cycle), avg(x.approval::integer) into sample, approvals from (
   select mavi_private.task_cycle_days(t, tz) cycle, t.requires_client_approval approval
   from public.tasks t join public.contracts tk on tk.company_id = t.company_id and tk.id = t.contract_id
   where t.company_id = c and not t.archived and t.id is distinct from p_exclude
    and t.delivered_at is not null and t.delivered_at > now() - interval '365 days'
    and case i
     when 1 then t.contract_id = p_contract and coalesce(t.executor_id, t.assignee_id) = p_assignee
     when 2 then t.contract_id = p_contract
     when 3 then tk.product_id = k.product_id and coalesce(t.executor_id, t.assignee_id) = p_assignee
     else tk.product_id = k.product_id end
   order by t.delivered_at desc limit 30) x
  where x.cycle is not null;
  if coalesce(cardinality(sample), 0) >= 5 then lvl := i; exit; end if;
 end loop;
 if lvl is null then
  return jsonb_build_object('available', false, 'reason', 'history');
 end if;
 median := sample[(cardinality(sample) + 1) / 2];
 days := median;

 -- 3. Aprovação do cliente que o histórico não costumava ter.
 r := mavi_private.due_rule_for(c, p_contract, p_project, p_team, p_assignee);
 if p_approval and approvals < 0.5 then
  approval_added := coalesce(r.approval_days, 0);
  days := days + approval_added;
 end if;

 -- 4. Retrabalho do cliente acima da média (só com histórico que não é dele).
 if lvl >= 3 then
  select avg(x.rw::integer) into client_rate from (
   select exists(select 1 from public.task_status_periods p where p.task_id = t.id
    and p.status in ('rejected', 'correction')) rw
   from public.tasks t join public.contracts tk on tk.company_id = t.company_id and tk.id = t.contract_id
   where t.company_id = c and tk.client_id = k.client_id and t.delivered_at > now() - interval '365 days'
   order by t.delivered_at desc limit 30) x having count(*) >= 5;
  select avg(x.rw::integer) into level_rate from (
   select exists(select 1 from public.task_status_periods p where p.task_id = t.id
    and p.status in ('rejected', 'correction')) rw
   from public.tasks t join public.contracts tk on tk.company_id = t.company_id and tk.id = t.contract_id
   where t.company_id = c and tk.product_id = k.product_id and t.delivered_at > now() - interval '365 days'
   order by t.delivered_at desc limit 100) x;
  if client_rate is not null and level_rate is not null and client_rate >= level_rate + 0.2 then
   rework_added := 1;
   days := days + 1;
  end if;
 end if;

 base := mavi_private.next_person_business_day(c, p_assignee, p_base);
 candidate := mavi_private.add_person_business_days(c, p_assignee, base, days);

 -- 2. Carga até lá: o que vence antes, com prioridade igual ou maior.
 select coalesce(sum(greatest(t.estimated_minutes - coalesce((select sum(extract(epoch from (e.ended_at - e.started_at)) / 60)
    from public.time_entries e where e.task_id = t.id and e.ended_at is not null), 0), 0)), 0)::integer,
  count(*) filter (where t.estimated_minutes > 0)::integer,
  count(*) filter (where t.estimated_minutes = 0)::integer
 into load_minutes, load_tasks, unestimated
 from public.tasks t
 where t.company_id = c and t.assignee_id = p_assignee and t.status <> 'done' and not t.archived
  and t.id is distinct from p_exclude and t.due_date <= candidate
  and mavi_private.priority_rank(t.priority) >= mavi_private.priority_rank(p_priority);
 daily := coalesce((select m.work_minutes from public.memberships m where m.company_id = c and m.user_id = p_assignee),
  (select work_minutes from public.companies where id = c), 480);
 need := load_minutes + own;
 if need > 0 then
  d := base;
  loop
   select coalesce((select b.minutes from mavi_private.person_busy_days b where b.user_id = p_assignee and b.day = d), 0)
    into busy;
   busy := least(busy, daily);
   busy_total := busy_total + case when d <= candidate then busy else 0 end;
   have := have + daily - busy;
   load_days := load_days + 1;
   exit when have >= need or load_days > 250;
   d := mavi_private.add_person_business_days(c, p_assignee, d, 1);
  end loop;
  -- Contando o dia do início: a última hora cai no dia load_days - 1 depois dele.
  load_days := load_days - 1;
 end if;
 if load_days > days then days := load_days; end if;

 due := mavi_private.add_person_business_days(c, p_assignee, base, days);
 -- 5. Nunca antes do mínimo da regra.
 if r.id is not null and r.min_days is not null then
  select * into rd from mavi_private.rule_due_dates(c, r, p_base, coalesce(p_approval, false), p_assignee);
  if rd.min_due is not null and due < rd.min_due then due := rd.min_due; end if;
 end if;

 return jsonb_build_object('available', true, 'due', due, 'days', days, 'assignee', p_assignee,
  'level', lvl, 'level_label', labels[lvl], 'sample', cardinality(sample), 'median_days', median,
  'approval_days', approval_added, 'rework_days', rework_added,
  'load_minutes', load_minutes, 'load_tasks', load_tasks, 'unestimated_tasks', unestimated,
  'own_minutes', own, 'daily_minutes', daily, 'busy_minutes', busy_total, 'load_days', load_days,
  'history_due', candidate);
end $$;
revoke all on function mavi_private.priority_rank(text), mavi_private.business_days_between(uuid, date, date),
 mavi_private.task_cycle_days(public.tasks, text),
 mavi_private.smart_due_calc(uuid, uuid, uuid, uuid, uuid, date, boolean, text, integer, uuid)
 from public, anon, authenticated;

-- O formulário: a sugestão para quem vai executar (numa equipe, para quem a
-- equipe daria a tarefa agora), com o estado da agenda: 'none' (sem Google),
-- 'stale' (ler de novo pelo /api/google) ou 'fresh'.
create function public.smart_due_suggestion(p_company uuid, p_contract uuid, p_project uuid, p_team uuid,
 p_assignee uuid, p_start date, p_approval boolean, p_priority text, p_estimated integer, p_task uuid default null)
 returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare who uuid := p_assignee; mode text; out jsonb; rd record; busy text; begin
 if not mavi_private.member(p_company) or not mavi_private.contract_access(p_company, p_contract) then
  raise exception 'Sem acesso ao produto contratado' using errcode = '42501';
 end if;
 select smart_due into mode from public.companies where id = p_company;
 if mode = 'off' then return jsonb_build_object('available', false, 'reason', 'off', 'mode', mode); end if;
 if who is null and p_team is not null then who := mavi_private.team_assignee(p_company, p_team); end if;
 out := mavi_private.smart_due_calc(p_company, p_contract, p_project, p_team, who,
  coalesce(p_start, mavi_private.company_today(p_company)), coalesce(p_approval, false),
  coalesce(p_priority, 'normal'), p_estimated, p_task);
 busy := case
  when not exists(select 1 from mavi_private.google_connections g where g.user_id = who) then 'none'
  when exists(select 1 from mavi_private.person_busy_reads b where b.user_id = who
   and b.read_at > now() - interval '1 hour'
   and b.until_day >= coalesce((out->>'due')::date, mavi_private.company_today(p_company) + 30)) then 'fresh'
  else 'stale' end;
 return out || jsonb_build_object('mode', mode, 'assignee', who, 'busy', busy);
end $$;
revoke all on function public.smart_due_suggestion(uuid, uuid, uuid, uuid, uuid, date, boolean, text, integer, uuid)
 from public, anon;
grant execute on function public.smart_due_suggestion(uuid, uuid, uuid, uuid, uuid, date, boolean, text, integer, uuid)
 to authenticated;

-- ------------------------------------------------------------ criação
-- p_due_smart: sem prazo à mão, o da MAVI (se houver sugestão; senão, o da
-- regra). A tarefa guarda o que a regra e a MAVI davam.
drop function public.create_task(uuid,uuid,text,uuid,date,uuid,uuid,text,text,integer,boolean,uuid,date,jsonb,text,boolean,text);
create function public.create_task(p_company uuid,p_contract uuid,p_title text,p_assignee uuid,p_due date,
 p_project uuid default null,p_team uuid default null,p_description text default '',p_priority text default 'normal',
 p_estimated integer default 0,p_client_approval boolean default false,p_parent uuid default null,p_start date default null,
 p_custom jsonb default '{}', p_repeat text default null, p_due_manual boolean default true,
 p_due_reason text default null, p_due_smart boolean default false) returns uuid
language plpgsql security definer set search_path = '' as $$
declare result uuid; custom jsonb; assignee uuid := p_assignee; ch record; t public.tasks;
 base date := coalesce(p_start, mavi_private.company_today(p_company)); r public.task_due_rules;
 rule_date date; smart jsonb; use_smart boolean := false; begin
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
  base, p_client_approval, p_due, p_due_manual, p_due_reason, true);
 r := mavi_private.due_rule_for(p_company, p_contract, p_project, p_team, assignee);
 if r.id is not null then
  select d.due into rule_date from mavi_private.rule_due_dates(p_company, r, base, coalesce(p_client_approval, false), assignee) d;
 end if;
 if (select smart_due from public.companies where id = p_company) <> 'off' then
  smart := mavi_private.smart_due_calc(p_company, p_contract, p_project, p_team, assignee, base,
   coalesce(p_client_approval, false), coalesce(p_priority, 'normal'), p_estimated);
  use_smart := coalesce(p_due_smart, false) and not ch.manual and (smart->>'available')::boolean;
 end if;
 if use_smart then ch.due := (smart->>'due')::date; end if;
 insert into public.tasks(company_id,contract_id,title,assignee_id,due_date,original_due_date,project_id,team_id,description,priority,estimated_minutes,requires_client_approval,parent_id,start_date,custom_fields,
  due_manual,due_rule_id,due_tight_reason,due_smart,due_rule_date,due_smart_date)
 values(p_company,p_contract,trim(p_title),assignee,ch.due,ch.due,p_project,p_team,p_description,p_priority,p_estimated,p_client_approval,p_parent,p_start,custom,
  ch.manual,case when use_smart then r.id else ch.rule_id end,ch.tight_reason,use_smart,rule_date,
  case when (smart->>'available')::boolean then (smart->>'due')::date end) returning * into t;
 result := t.id;
 insert into public.task_events(company_id,task_id,actor_id,action,detail) values(p_company,result,auth.uid(),'created',
  case when use_smart then jsonb_build_object('due_smart', true)
   when ch.rule_id is not null then jsonb_build_object('due_rule', ch.rule_id) else '{}'::jsonb end);
 if ch.tight_reason is not null then perform mavi_private.log_tight_due(t, ch.min_due, ch.tight_reason); end if;
 if p_repeat is not null then perform mavi_private.start_recurrence(result, p_repeat, p_assignee is null); end if;
 return result;
end $$;
revoke all on function public.create_task(uuid,uuid,text,uuid,date,uuid,uuid,text,text,integer,boolean,uuid,date,jsonb,text,boolean,text,boolean) from public, anon;
grant execute on function public.create_task(uuid,uuid,text,uuid,date,uuid,uuid,text,text,integer,boolean,uuid,date,jsonb,text,boolean,text,boolean) to authenticated;

-- Mudar o prazo depois (à mão ou pela regra) deixa de ser o da MAVI.
create function mavi_private.clear_due_smart() returns trigger
language plpgsql set search_path = '' as $$ begin
 if new.due_date is distinct from old.due_date then new.due_smart := false; end if;
 return new;
end $$;
revoke all on function mavi_private.clear_due_smart() from public, anon, authenticated;
create trigger clear_due_smart before update of due_date on public.tasks
 for each row when (old.due_smart) execute function mavi_private.clear_due_smart();

commit;
