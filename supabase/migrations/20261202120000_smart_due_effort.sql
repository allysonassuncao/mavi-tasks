begin;

-- Prazo inteligente: a complexidade pela descrição e a sugestão na edição.
--
-- * A análise da MAVI no formulário (Assistente MAVI) diz também se a
--   entrega é mais simples, normal ou mais trabalhosa que o comum para o
--   tipo de tarefa. Na sugestão, mais simples tira 1 dia útil do histórico
--   (sem ficar abaixo de 1); mais trabalhosa soma um quarto (pelo menos 1).
--   Continua nunca antes do mínimo da regra.
-- * Na edição, "Usar" a sugestão da MAVI (update_task com p_due_smart)
--   conta a data de novo no banco, sem a própria tarefa na carga.

-- Só os três níveis valem; o resto é "normal".
create function mavi_private.effort_level(p text) returns text
language sql immutable set search_path = '' as $$
 select case when p in ('simple', 'complex') then p else null end
$$;
revoke all on function mavi_private.effort_level(text) from public, anon, authenticated;

drop function mavi_private.smart_due_calc(uuid, uuid, uuid, uuid, uuid, date, boolean, text, integer, uuid);
create function mavi_private.smart_due_calc(c uuid, p_contract uuid, p_project uuid, p_team uuid, p_assignee uuid,
 p_base date, p_approval boolean, p_priority text, p_estimated integer, p_exclude uuid default null,
 p_effort text default null) returns jsonb
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
 client_rate numeric; level_rate numeric; effort_added integer := 0;
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
 -- A MAVI leu a descrição: mais simples que o comum tira um dia (sem ficar
 -- abaixo de 1); mais trabalhosa soma um quarto (pelo menos 1 dia).
 effort_added := case p_effort when 'simple' then case when median > 1 then -1 else 0 end
  when 'complex' then greatest(1, ceil(median * 0.25)::integer) else 0 end;
 days := median + effort_added;

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
  'approval_days', approval_added, 'rework_days', rework_added, 'effort', p_effort, 'effort_days', effort_added,
  'load_minutes', load_minutes, 'load_tasks', load_tasks, 'unestimated_tasks', unestimated,
  'own_minutes', own, 'daily_minutes', daily, 'busy_minutes', busy_total, 'load_days', load_days,
  'history_due', candidate);
end $$;
revoke all on function mavi_private.smart_due_calc(uuid, uuid, uuid, uuid, uuid, date, boolean, text, integer, uuid, text)
 from public, anon, authenticated;

drop function public.smart_due_suggestion(uuid, uuid, uuid, uuid, uuid, date, boolean, text, integer, uuid);
create function public.smart_due_suggestion(p_company uuid, p_contract uuid, p_project uuid, p_team uuid,
 p_assignee uuid, p_start date, p_approval boolean, p_priority text, p_estimated integer, p_task uuid default null,
 p_effort text default null)
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
  coalesce(p_priority, 'normal'), p_estimated, p_task, mavi_private.effort_level(p_effort));
 busy := case
  when not exists(select 1 from mavi_private.google_connections g where g.user_id = who) then 'none'
  when exists(select 1 from mavi_private.person_busy_reads b where b.user_id = who
   and b.read_at > now() - interval '1 hour'
   and b.until_day >= coalesce((out->>'due')::date, mavi_private.company_today(p_company) + 30)) then 'fresh'
  else 'stale' end;
 return out || jsonb_build_object('mode', mode, 'assignee', who, 'busy', busy);
end $$;
revoke all on function public.smart_due_suggestion(uuid, uuid, uuid, uuid, uuid, date, boolean, text, integer, uuid, text)
 from public, anon;
grant execute on function public.smart_due_suggestion(uuid, uuid, uuid, uuid, uuid, date, boolean, text, integer, uuid, text)
 to authenticated;

drop function public.create_task(uuid,uuid,text,uuid,date,uuid,uuid,text,text,integer,boolean,uuid,date,jsonb,text,boolean,text,boolean);
create function public.create_task(p_company uuid,p_contract uuid,p_title text,p_assignee uuid,p_due date,
 p_project uuid default null,p_team uuid default null,p_description text default '',p_priority text default 'normal',
 p_estimated integer default 0,p_client_approval boolean default false,p_parent uuid default null,p_start date default null,
 p_custom jsonb default '{}', p_repeat text default null, p_due_manual boolean default true,
 p_due_reason text default null, p_due_smart boolean default false, p_due_effort text default null) returns uuid
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
   coalesce(p_client_approval, false), coalesce(p_priority, 'normal'), p_estimated, null,
   mavi_private.effort_level(p_due_effort));
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
revoke all on function public.create_task(uuid,uuid,text,uuid,date,uuid,uuid,text,text,integer,boolean,uuid,date,jsonb,text,boolean,text,boolean,text) from public, anon;
grant execute on function public.create_task(uuid,uuid,text,uuid,date,uuid,uuid,text,text,integer,boolean,uuid,date,jsonb,text,boolean,text,boolean,text) to authenticated;

drop function public.update_task(uuid,integer,text,text,date,integer,text,date,boolean,text);
create function public.update_task(p_task uuid,p_version integer,p_title text,p_description text,p_due date,p_estimated integer,p_priority text,p_start date default null,
 p_due_manual boolean default null, p_due_reason text default null, p_due_smart boolean default null,
 p_due_effort text default null) returns public.tasks
language plpgsql security definer set search_path = '' as $$ declare t public.tasks; ch record; smart jsonb; begin
 select * into t from public.tasks where id=p_task for update;
 if not found or not mavi_private.can_edit(t.company_id,t.id) then raise exception 'Sem permissão' using errcode='42501'; end if;
 if t.version<>p_version then raise exception 'A tarefa mudou. Atualize antes de continuar.' using errcode='40001'; end if;
 -- "Usar" a sugestão da MAVI: a data dela, contada de novo aqui (a tarefa
 -- fica fora da própria carga), nunca antes do mínimo da regra.
 if p_due_smart then
  smart := mavi_private.smart_due_calc(t.company_id, t.contract_id, t.project_id, t.team_id, t.assignee_id,
   coalesce(p_start, mavi_private.task_due_base(t)), t.requires_client_approval, coalesce(p_priority, t.priority),
   p_estimated, t.id, mavi_private.effort_level(p_due_effort));
  if not coalesce((smart->>'available')::boolean, false) then
   raise exception 'A MAVI não tem sugestão para esta tarefa agora';
  end if;
  p_due := (smart->>'due')::date;
  p_due_manual := true;
 end if;
 if p_due is distinct from t.due_date or p_due_manual is false then
  select * into ch from mavi_private.choose_due(t.company_id, t.contract_id, t.project_id, t.team_id, t.assignee_id,
   coalesce(p_start, mavi_private.task_due_base(t)), t.requires_client_approval, p_due, coalesce(p_due_manual, true),
   p_due_reason, p_due < t.due_date);
 else
  select t.due_date as due, t.due_rule_id as rule_id, t.due_manual as manual, null::date as min_due,
   t.due_tight_reason as tight_reason into ch;
 end if;
 -- Como na criação: a data da MAVI não é "à mão".
 if smart is not null then ch.manual := false; end if;
 update public.tasks set start_date=p_start,title=trim(p_title),description=p_description,due_date=ch.due,estimated_minutes=p_estimated,priority=p_priority,
 due_manual=ch.manual,due_rule_id=ch.rule_id,
 due_smart=case when smart is not null then true when ch.due is distinct from t.due_date or p_due_manual is false then false
  else t.due_smart end,
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
revoke all on function public.update_task(uuid,integer,text,text,date,integer,text,date,boolean,text,boolean,text) from public, anon;
grant execute on function public.update_task(uuid,integer,text,text,date,integer,text,date,boolean,text,boolean,text) to authenticated;

-- Um prazo que muda deixa de ser o da MAVI, a não ser que a própria mudança
-- diga que é (a edição com "Usar").
create or replace function mavi_private.clear_due_smart() returns trigger
language plpgsql set search_path = '' as $$ begin
 if new.due_date is distinct from old.due_date and new.due_smart = old.due_smart then new.due_smart := false; end if;
 return new;
end $$;

commit;
