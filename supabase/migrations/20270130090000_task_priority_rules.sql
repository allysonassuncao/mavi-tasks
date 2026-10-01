begin;

-- Tarefas › Prioridades. A prioridade da tarefa (Baixa, Normal, Alta,
-- Urgente) continua, mas Alta e Urgente passam a ser o destaque da lista:
--
-- * Só administradores, gestores e o supervisor de uma equipe do
--   responsável dão ou tiram Alta/Urgente (na criação, em Editar, direto na
--   tarefa ou em massa). Baixa ↔ Normal segue com quem edita a tarefa. A regra
--   está num gatilho de tasks, então vale em todo caminho de uma pessoa; as
--   rotinas sem pessoa (pg_cron, Make) e as cópias da repetição passam.
-- * Quem marcou e quando ficam na tarefa (priority_set_by/at) e cada mudança
--   vai para o histórico (task_events 'priority').
-- * O responsável é avisado quando a tarefa dele sobe para Alta ou Urgente
--   (aviso 'priority', ou 'tasks_priority' agrupado na alteração em massa),
--   conforme Meu perfil › Notificações.
-- * priority_weight (2 Urgente, 1 Alta, 0 as outras) ordena a lista: as
--   prioritárias primeiro, depois o "Ordenar por".
-- * As regras automáticas (anúncio do Social Leads, reunião do ciclo, bug das
--   Sugestões) passam a criar Normal; as tarefas abertas com Alta/Urgente de
--   quem não poderia marcar voltam a Normal, com registro no histórico.

-- ------------------------------------------------------------ colunas
alter table public.tasks add column priority_set_by uuid, add column priority_set_at timestamptz,
 add column priority_weight smallint not null
  generated always as (case priority when 'urgent' then 2 when 'high' then 1 else 0 end) stored;

create or replace function mavi_private.priority_weight(p text) returns smallint
language sql immutable set search_path = '' as $$
 select (case p when 'urgent' then 2 when 'high' then 1 else 0 end)::smallint
$$;
create or replace function mavi_private.priority_label(p text) returns text
language sql immutable set search_path = '' as $$
 select case p when 'urgent' then 'Urgente' when 'high' then 'Alta' when 'low' then 'Baixa' else 'Normal' end
$$;
grant execute on function mavi_private.priority_weight(text), mavi_private.priority_label(text) to authenticated;

-- ------------------------------------------------------------ quem pode
-- `actor` dá ou tira Alta/Urgente de uma tarefa cujo responsável é `p`:
-- administrador ou gestor ativo, ou supervisor de uma equipe de `p` (como
-- mavi_private.supervises, com a pessoa explícita).
create or replace function mavi_private.can_prioritize_as(c uuid, actor uuid, p uuid) returns boolean
language sql stable security definer set search_path = '' as $$
 select exists(select 1 from public.memberships m where m.company_id = c and m.user_id = actor and m.active
   and m.role in ('admin', 'manager'))
  or exists(select 1 from public.team_members s
   join public.memberships ms on ms.company_id = s.company_id and ms.user_id = s.user_id and ms.active
   join public.team_members a on a.company_id = s.company_id and a.team_id = s.team_id
   where s.company_id = c and s.user_id = actor and s.supervisor and a.user_id = p)
$$;
create or replace function mavi_private.can_prioritize(c uuid, p uuid) returns boolean
language sql stable security definer set search_path = '' as $$
 select mavi_private.can_prioritize_as(c, auth.uid(), p)
$$;
revoke all on function mavi_private.can_prioritize_as(uuid, uuid, uuid) from public, anon, authenticated;
revoke all on function mavi_private.can_prioritize(uuid, uuid) from public, anon;
grant execute on function mavi_private.can_prioritize(uuid, uuid) to authenticated;

-- Se a pessoa pode passar a tarefa para `next`: quem pode marcar, sempre;
-- Baixa ↔ Normal, também quem edita a tarefa (criador, gestor, admin).
create or replace function mavi_private.may_set_priority(t public.tasks, next text) returns boolean
language sql stable security definer set search_path = '' as $$
 select next = t.priority
  or mavi_private.can_prioritize(t.company_id, t.assignee_id)
  or (mavi_private.priority_weight(next) = 0 and mavi_private.priority_weight(t.priority) = 0
   and mavi_private.can_edit(t.company_id, t.id))
$$;
revoke all on function mavi_private.may_set_priority(public.tasks, text) from public, anon, authenticated;

-- ------------------------------------------------------------ gatilhos
create or replace function mavi_private.guard_task_priority() returns trigger
language plpgsql security definer set search_path = '' as $$
declare me uuid := auth.uid(); was text := case when tg_op = 'UPDATE' then old.priority else 'normal' end; begin
 if tg_op = 'UPDATE' and new.priority is not distinct from old.priority then return new; end if;
 if mavi_private.priority_weight(new.priority) = 0 and mavi_private.priority_weight(was) = 0 then
  new.priority_set_by := null;
  new.priority_set_at := null;
  return new;
 end if;
 -- Uma pessoa precisa poder marcar. Passam as rotinas sem pessoa, a cópia
 -- da repetição (repete a prioridade da tarefa de origem) e o desfazer do lote.
 if me is not null and coalesce(current_setting('mavi.priority_system', true), '') <> '1'
  and not (tg_op = 'INSERT' and new.recurrence_id is not null)
  and not mavi_private.can_prioritize_as(new.company_id, me, new.assignee_id) then
  raise exception 'Só administradores, gestores e o supervisor da equipe do responsável dão ou tiram a prioridade Alta ou Urgente.'
   using errcode = '42501';
 end if;
 if mavi_private.priority_weight(new.priority) > 0 then
  new.priority_set_by := me;
  new.priority_set_at := now();
 else
  new.priority_set_by := null;
  new.priority_set_at := null;
 end if;
 return new;
end $$;
revoke all on function mavi_private.guard_task_priority() from public, anon, authenticated;
create trigger guard_task_priority before insert or update of priority on public.tasks
 for each row execute function mavi_private.guard_task_priority();

-- O histórico e o aviso ao responsável (a criação já avisa "Nova tarefa").
-- Na alteração em massa o aviso sai agrupado (bulk_update_tasks).
create or replace function mavi_private.log_task_priority() returns trigger
language plpgsql security definer set search_path = '' as $$
declare me uuid := auth.uid(); begin
 if new.priority is not distinct from old.priority then return null; end if;
 insert into public.task_events(company_id, task_id, actor_id, action, detail)
 values (new.company_id, new.id, coalesce(me, new.creator_id), 'priority',
  jsonb_build_object('from', old.priority, 'to', new.priority) || case when me is null
   then jsonb_build_object('system', true) else '{}'::jsonb end);
 if me is not null and new.assignee_id is distinct from me
  and mavi_private.priority_weight(new.priority) > mavi_private.priority_weight(old.priority)
  and coalesce(current_setting('mavi.bulk_tasks', true), '') <> '1'
  and exists(select 1 from public.memberships
   where company_id = new.company_id and user_id = new.assignee_id and active) then
  insert into public.notifications(company_id, user_id, actor_id, task_id, kind, title)
  values (new.company_id, new.assignee_id, me, new.id, 'priority',
   'marcou como prioridade ' || mavi_private.priority_label(new.priority));
 end if;
 return null;
end $$;
revoke all on function mavi_private.log_task_priority() from public, anon, authenticated;
create trigger log_task_priority after update of priority on public.tasks
 for each row when (old.priority is distinct from new.priority)
 execute function mavi_private.log_task_priority();

-- ------------------------------------------------------------ direto na tarefa
-- Só a prioridade muda (status e aprovações ficam, ao contrário de Editar).
-- Mudam quem edita a tarefa e quem pode marcar; Alta/Urgente, o gatilho confere.
create or replace function public.set_task_priority(p_task uuid, p_version integer, p_priority text)
 returns public.tasks
language plpgsql security definer set search_path = '' as $$
declare t public.tasks; changed public.tasks; begin
 select * into t from public.tasks where id = p_task for update;
 if not found or t.archived or not mavi_private.task_access(t.company_id, t.id)
  or not (mavi_private.can_edit(t.company_id, t.id) or mavi_private.can_prioritize(t.company_id, t.assignee_id)) then
  raise exception 'Sem permissão para mudar a prioridade desta tarefa' using errcode = '42501';
 end if;
 if t.version <> p_version then raise exception 'A tarefa mudou. Atualize antes de continuar.' using errcode = '40001'; end if;
 if p_priority is null or p_priority not in ('low', 'normal', 'high', 'urgent') then
  raise exception 'Prioridade inválida' using errcode = '22023';
 end if;
 if p_priority = t.priority then raise exception 'A tarefa já tem essa prioridade.' using errcode = '22023'; end if;
 update public.tasks set priority = p_priority, version = version + 1 where id = t.id returning * into changed;
 return changed;
end $$;
revoke all on function public.set_task_priority(uuid, integer, text) from public, anon;
grant execute on function public.set_task_priority(uuid, integer, text) to authenticated;

-- ------------------------------------------------------------ avisos
alter table public.notifications drop constraint notifications_kind_check;
alter table public.notifications add constraint notifications_kind_check
 check (kind in ('mention', 'assigned', 'reply', 'social_leads', 'ai_share', 'success_case', 'notice',
  'notice_animation', 'temperature', 'tasks_assigned', 'due_risk', 'status', 'review', 'ai_skill', 'ai_answer',
  'radar_report', 'radar_alert', 'media_balance', 'priority', 'tasks_priority'));
alter table public.notifications drop constraint notifications_target_check;
alter table public.notifications add constraint notifications_target_check
 check ((kind in ('social_leads', 'ai_share', 'success_case', 'notice', 'notice_animation', 'temperature',
   'tasks_assigned', 'due_risk', 'ai_skill', 'ai_answer', 'radar_report', 'radar_alert', 'media_balance',
   'tasks_priority')) = (task_id is null)
  and (task_id is not null or (title is not null and link is not null))
  and ((kind = 'notice') = (notice_id is not null)));

create or replace function mavi_private.notification_pref_keys() returns text[]
language sql immutable set search_path = '' as $$
 select array['assigned', 'mention', 'reply', 'review', 'due_risk',
  'social_leads', 'ai_share', 'success_case', 'temperature', 'ai_skill', 'ai_answer', 'radar_report', 'radar_alert',
  'media_balance', 'priority']
  || array(select 'status.' || s || '.' || r
   from unnest(array['progress', 'returned', 'review', 'rejected', 'correction', 'done']) s,
        unnest(array['creator', 'assignee', 'participant']) r)
$$;

create or replace function mavi_private.filter_notification() returns trigger
language plpgsql security definer set search_path = '' as $$ begin
 if new.kind in ('notice', 'notice_animation', 'status') then return new; end if;
 if not mavi_private.wants_notification(new.company_id, new.user_id,
  case new.kind when 'tasks_assigned' then 'assigned' when 'tasks_priority' then 'priority' else new.kind end) then
  return null; end if;
 return new;
end $$;

-- O push: o aviso de prioridade, e a tarefa nova já marcada.
create or replace function mavi_private.push_notification() returns trigger
language plpgsql security definer set search_path = '' as $$
declare cfg mavi_private.push_config; subs jsonb; t public.tasks;
 actor text; excerpt text; title text; body text; url text; begin
 select * into cfg from mavi_private.push_config where id;
 if cfg.url is null then return null; end if;
 if mavi_private.notifications_paused(new.company_id, new.user_id) then return null; end if;
 select jsonb_agg(jsonb_build_object('endpoint', s.endpoint,
  'keys', jsonb_build_object('p256dh', s.p256dh, 'auth', s.auth)))
  into subs from public.push_subscriptions s where s.user_id = new.user_id;
 if subs is null then return null; end if;
 if new.task_id is null then
  title := new.title;
  body := coalesce(new.body, '');
  url := new.link;
 else
  select * into t from public.tasks where company_id = new.company_id and id = new.task_id;
  select name into actor from public.memberships
   where company_id = new.company_id and user_id = new.actor_id;
  if new.kind = 'assigned' then
   title := case t.priority when 'urgent' then 'Nova tarefa urgente para você'
    when 'high' then 'Nova tarefa prioritária para você' else 'Nova tarefa para você' end;
   body := coalesce(actor, 'Alguém') || ' criou: ' || t.title
    || ' · prazo ' || to_char(t.due_date, 'DD/MM');
  elsif new.kind in ('status', 'review', 'priority') then
   title := coalesce(actor, 'Alguém') || ' ' || new.title;
   body := t.title || ' · prazo ' || to_char(t.due_date, 'DD/MM');
  else
   select left(regexp_replace(mavi_private.rich_plain(c.body), '\s+', ' ', 'g'), 140)
    into excerpt from public.comments c where c.id = new.comment_id;
   title := coalesce(actor, 'Alguém') || case when new.kind = 'reply'
    then ' respondeu um comentário' else ' mencionou você' end;
   body := t.title || coalesce(': ' || nullif(excerpt, ''), '');
  end if;
  url := '/tarefas/' || new.task_id;
 end if;
 perform net.http_post(
  url := cfg.url,
  body := jsonb_build_object('subscriptions', subs, 'message', jsonb_build_object(
   'title', title, 'body', body, 'tag', new.id, 'url', url)),
  headers := jsonb_build_object('Content-Type', 'application/json',
   'Authorization', 'Bearer ' || cfg.secret),
  timeout_milliseconds := 8000);
 return null;
exception when others then
 -- The notification stays in the inbox even if it can't be pushed.
 raise warning 'mavi push failed: %', sqlerrm;
 return null;
end $$;

-- ------------------------------------------------------------ em massa
-- A da migração 20270110090000, com a prioridade (kind 'priority'): vale para
-- quem pode marcar (mavi_private.may_set_priority), o desfazer a restaura e o
-- responsável recebe um aviso agrupado quando as tarefas dele sobem.
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
 v_logged uuid[] := '{}';
 v_priority text;
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
 when 'priority' then
  v_priority := p_change->>'value';
  if v_priority is null or v_priority not in ('low', 'normal', 'high', 'urgent') then
   raise exception 'Prioridade inválida'; end if;
  label := mavi_private.priority_label(v_priority);
 when 'rule' then null;
 else raise exception 'Alteração inválida';
 end case;
 if v_reason is not null and length(v_reason) < 5 then
  raise exception 'Explique o motivo com um pouco mais de detalhe'; end if;
 -- Migração 20270110090000: mudar o prazo pede sempre o motivo.
 if kind in ('due', 'shift', 'rule') then perform mavi_private.require_due_reason(v_reason); end if;

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
    when 'priority' then
     if t.priority = v_priority then reason := 'Já está com prioridade ' || label;
     elsif not mavi_private.may_set_priority(t, v_priority) then
      reason := case when mavi_private.priority_weight(v_priority) = 0 and mavi_private.priority_weight(t.priority) = 0
       then 'Sem permissão para mudar a prioridade desta tarefa'
       else 'Só administradores, gestores e o supervisor da equipe do responsável dão ou tiram a prioridade Alta ou Urgente' end;
     else
      update public.tasks set priority = v_priority, version = version + 1 where id = t.id;
     end if;
    else
     if not mavi_private.can_change_due(t) then
      reason := 'Sem permissão para mudar o prazo desta tarefa';
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
       -- "Pela regra" na mesma data só volta a seguir a regra: nada a registrar.
       if changed.due_date <> t.due_date then
        v_logged := v_logged || mavi_private.log_due_change(changed, t.due_date, v_reason, 'bulk');
       end if;
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
      'due_rule_id', t.due_rule_id, 'due_tight_reason', t.due_tight_reason, 'priority', t.priority));
   end if;
   results := results || jsonb_build_object('id', t.id, 'title', t.title, 'contract_id', t.contract_id,
    'parent_id', t.parent_id, 'ok', reason is null, 'reason', reason,
    'before', jsonb_build_object('status', t.status, 'assignee_id', t.assignee_id, 'due_date', t.due_date,
     'priority', t.priority),
    'after', jsonb_build_object('status', changed.status, 'assignee_id', changed.assignee_id,
     'due_date', changed.due_date, 'priority', changed.priority));
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
  -- Desfazer o lote tira estes registros das métricas.
  update public.task_due_changes set operation_id = op where id = any(v_logged);
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
  if kind = 'priority' then
   insert into public.notifications(company_id, user_id, actor_id, task_id, kind, title, body, link)
   select p_company, r.u, me, null, 'tasks_priority',
    coalesce((select name from public.memberships where company_id = p_company and user_id = me), 'Alguém')
     || ' marcou ' || count(*) || case when count(*) = 1 then ' tarefa sua' else ' tarefas suas' end
     || ' como prioridade ' || label,
    left(string_agg(r.title, ' · ' order by r.n), 300),
    '/tarefas?escopo=mine&prioritarias=1&lote=' || op
   from (select (x->'after'->>'assignee_id')::uuid u, x->>'title' title, n
    from jsonb_array_elements(results) with ordinality e(x, n)
    where (x->>'ok')::boolean and mavi_private.priority_weight(x->'after'->>'priority')
     > mavi_private.priority_weight(x->'before'->>'priority')) r
   where r.u is distinct from me and exists(select 1 from public.memberships
    where company_id = p_company and user_id = r.u and active)
   group by r.u;
  end if;
  perform mavi_private.broadcast_tasks(p_company, touched, people);
 end if;
 -- Lotes de mais de uma semana já não se desfazem.
 delete from public.task_bulk_operations
  where company_id = p_company and actor_id = me and created_at < now() - interval '7 days';
 return jsonb_build_object('preview', false, 'operation', op, 'applied', applied, 'results', results);
end $$;

-- A da migração 20270110090000: o desfazer também volta a prioridade (quem
-- fez o lote podia marcar; mavi.priority_system deixa passar).
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
 perform set_config('mavi.priority_system', '1', true);
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
   priority = case when b ? 'priority' then b->>'priority' else priority end,
   version = version + 1
  where id = t.id;
  insert into public.task_events(company_id, task_id, actor_id, action, detail)
  values (o.company_id, t.id, auth.uid(), 'bulk_undone', jsonb_build_object(
   'from', t.status, 'to', b->>'status', 'assignee_from', t.assignee_id, 'assignee_to', b->>'assignee_id',
   'old_due', t.due_date, 'new_due', b->>'due_date', 'status_since', t.status_changed_at));
  -- A mudança de prazo desfeita sai das métricas (migração 20270110090000).
  delete from public.task_due_changes where operation_id = o.id and task_id = t.id;
  restored := restored + 1;
  touched := touched || t.id;
  people := people || mavi_private.task_people(t) || (b->>'assignee_id')::uuid;
 end loop;
 update public.task_bulk_operations set undone_at = now() where id = o.id;
 -- O aviso de "passou N tarefas para você" deixa de valer.
 delete from public.notifications
  where company_id = o.company_id and kind in ('tasks_assigned', 'tasks_priority') and link like '%lote=' || o.id::text;
 perform set_config('mavi.bulk_tasks', '', true);
 perform set_config('mavi.priority_system', '', true);
 perform mavi_private.broadcast_tasks(o.company_id, touched, people);
 return jsonb_build_object('restored', restored, 'kept', kept);
end $$;

-- ------------------------------------------------------------ regras automáticas
-- A da migração 20270103090000: a arte do anúncio nasce Normal (Alta e
-- Urgente são marcadas por pessoas).
create or replace function public.social_leads_release(p_plan uuid, p_assign jsonb default '{}') returns jsonb
language plpgsql security definer set search_path = '' as $$
declare p public.social_leads_plans; s public.social_leads_settings; fallback uuid; client uuid; name text;
 x public.social_leads_posts; a jsonb; team uuid; who uuid; t uuid; n integer := 0; due date; cyc boolean;
 cycle jsonb; begin
 select * into p from public.social_leads_plans where id = p_plan;
 if not found or not mavi_private.social_leads_can_write(p.company_id, p.contract_id) then
  raise exception 'Plano não encontrado.' using errcode = 'P0002';
 end if;
 if p_assign is not null and jsonb_typeof(p_assign) <> 'object' then
  raise exception 'Escolha de responsáveis inválida.' using errcode = '22023';
 end if;
 cycle := coalesce(p_assign->'cycle', '{}');
 if jsonb_typeof(cycle) <> 'object'
  or coalesce(jsonb_typeof(cycle->'followup'), 'string') <> 'string'
  or coalesce(jsonb_typeof(cycle->'meeting'), 'string') <> 'string'
  or coalesce(cycle->>'followup', '00000000-0000-0000-0000-000000000000') !~* '^[0-9a-f-]{36}$'
  or coalesce(cycle->>'meeting', '00000000-0000-0000-0000-000000000000') !~* '^[0-9a-f-]{36}$' then
  raise exception 'Responsável do ciclo inválido.' using errcode = '22023';
 end if;
 select s2.* into s from public.contracts k2
 join public.social_leads_settings s2 on s2.company_id = k2.company_id and s2.product_id = k2.product_id
 where k2.company_id = p.company_id and k2.id = p.contract_id;
 fallback := coalesce(s.design_team_id, s.team_id);
 if not exists (select 1 from public.social_leads_posts where plan_id = p.id and decision = 'approved' and task_id is null) then
  raise exception 'Nenhum post aprovado sem tarefa.' using errcode = '22023';
 end if;
 select k.client_id, coalesce(nullif(b.fields->>'clientName', ''), c.name) into client, name
 from public.contracts k join public.clients c on c.company_id = k.company_id and c.id = k.client_id
 left join public.social_leads_briefings b on b.company_id = k.company_id and b.contract_id = k.id
 where k.company_id = p.company_id and k.id = p.contract_id;
 due := mavi_private.company_today(p.company_id) + coalesce(s.art_days, 5);
 for x in select * from public.social_leads_posts where plan_id = p.id and decision = 'approved' and task_id is null
  order by number for update loop
  a := coalesce(p_assign, '{}')->(x.number::text);
  team := null;
  who := null;
  if a is not null and jsonb_typeof(a->'user') = 'string' then
   who := (a->>'user')::uuid;
   if not exists (select 1 from public.memberships where company_id = p.company_id and user_id = who and active) then
    raise exception 'Post %: responsável inválido.', x.number using errcode = '22023';
   end if;
  elsif a is not null and jsonb_typeof(a->'team') = 'string' then
   team := (a->>'team')::uuid;
   if not exists (select 1 from public.teams where company_id = p.company_id and id = team) then
    raise exception 'Post %: equipe não encontrada.', x.number using errcode = '22023';
   end if;
  else
   team := fallback;
   if team is null then
    raise exception 'Post %: escolha uma equipe ou um responsável (ou a equipe de criação em Configurar).', x.number
     using errcode = '22023';
   end if;
  end if;
  if team is not null then
   insert into public.client_teams(company_id, client_id, team_id) values (p.company_id, client, team) on conflict do nothing;
  end if;
  t := public.create_task(p.company_id, p.contract_id,
   left(format('Arte do post %s%s · %s · %s', x.number, ' · ' || nullif(btrim(x.format), ''), p.label, name), 240), who, due, null, team,
   mavi_private.social_leads_task_text(x, p.label), 'normal',
   0, false, null, null, '{}', null);
  update public.social_leads_posts set task_id = t where plan_id = p.id and number = x.number;
  n := n + 1;
 end loop;
 cyc := mavi_private.social_leads_start_cycle(p.company_id, p.contract_id,
  (cycle->>'followup')::uuid, (cycle->>'meeting')::uuid);
 return jsonb_build_object('created', n, 'cycle', cyc);
end $$;

-- A da migração 20261210090000: a reunião do ciclo nasce Normal.
create or replace function mavi_private.social_leads_start_cycle(p_company uuid, p_contract uuid,
 p_followup uuid default null, p_meeting uuid default null) returns boolean
language plpgsql security definer set search_path = '' as $$
declare b public.social_leads_briefings; client text; today date; f uuid; m uuid; begin
 select * into b from public.social_leads_briefings where company_id = p_company and contract_id = p_contract for update;
 if not found or b.cycle ? 'followup' then return false; end if;
 if exists (select 1 from unnest(array[p_followup, p_meeting]) as u where u is not null and not exists (
  select 1 from public.memberships where company_id = p_company and user_id = u and active)) then
  raise exception 'Responsável do ciclo inválido.' using errcode = '22023';
 end if;
 select coalesce(nullif(b.fields->>'clientName', ''), c.name) into client
 from public.contracts k join public.clients c on c.company_id = k.company_id and c.id = k.client_id
 where k.company_id = p_company and k.id = p_contract;
 today := mavi_private.company_today(p_company);
 f := public.create_task(p_company, p_contract, left('Acompanhamento quinzenal · ' || client, 240),
  coalesce(p_followup, auth.uid()), today + 14,
  null, null, 'Revise os resultados das últimas duas semanas (alcance, seguidores, leads) e alinhe com o cliente o que ajustar.',
  'normal', 30, false, null, null, '{}', 'biweekly');
 m := public.create_task(p_company, p_contract, left('Reunião de resultados e novo plano · ' || client, 240),
  coalesce(p_meeting, auth.uid()), today + 28,
  null, null, 'Apresente os resultados do mês ao cliente e gere o plano do próximo mês em Planejamento › '
   || mavi_private.social_leads_module_name(mavi_private.social_leads_module_of(p_company, p_contract)) || '.',
  'normal', 60, false, null, null, '{}', 'monthly');
 update public.social_leads_briefings set cycle = jsonb_build_object('followup', f, 'meeting', m, 'started_at', now())
 where company_id = p_company and contract_id = p_contract;
 return true;
end $$;

-- A da migração 20260929170000: o bug também nasce Normal.
create or replace function public.submit_suggestion(p_company uuid, p_kind text, p_title text,
 p_description text, p_assignee uuid) returns uuid
language plpgsql security definer set search_path = '' as $$
declare s public.suggestion_settings; result uuid; due date; custom jsonb; begin
 if not mavi_private.member(p_company) then raise exception 'Sem permissão' using errcode = '42501'; end if;
 if p_kind is null or p_kind not in ('feature', 'bug') then
  raise exception 'Escolha nova funcionalidade ou bug' using errcode = '22023';
 end if;
 select * into s from public.suggestion_settings where company_id = p_company;
 if not found then
  raise exception 'Sugestões ainda não configuradas: um gestor precisa escolher a equipe de P&D' using errcode = '22023';
 end if;
 if not exists (select 1 from public.team_members tm
  join public.memberships m on m.company_id = tm.company_id and m.user_id = tm.user_id and m.active
  where tm.company_id = p_company and tm.team_id = s.team_id and tm.user_id = p_assignee) then
  raise exception 'Escolha um responsável da equipe de P&D' using errcode = '22023';
 end if;
 due := current_date + case when p_kind = 'bug' then 2 else 7 end;
 -- Template fields can't be asked of whoever suggests: the task gets them
 -- empty (required ones included) for the P&D member to fill in.
 select coalesce(jsonb_agg(x.f || jsonb_build_object('value', null) order by x.n), '[]')
  into custom from jsonb_array_elements(
   mavi_private.template_fields_for(p_company, s.contract_id, p_assignee)) with ordinality as x(f, n);
 insert into public.tasks(company_id, contract_id, title, assignee_id, due_date, original_due_date,
  project_id, team_id, description, priority, custom_fields)
 values (p_company, s.contract_id, trim(p_title), p_assignee, due, due, s.project_id, s.team_id,
  coalesce(p_description, ''), 'normal', custom)
 returning id into result;
 insert into public.task_events(company_id, task_id, actor_id, action, detail)
 values (p_company, result, auth.uid(), 'created', jsonb_build_object('suggestion', p_kind));
 return result;
end $$;


-- ------------------------------------------------------------ busca avançada
-- O filtro "Prioritárias" (p_priority: só Alta e Urgente). search_tasks chama
-- pelos 12 primeiros parâmetros e continua igual.
drop function public.search_task_rows(uuid, text, text[], uuid, uuid, uuid, uuid, text, date, date, integer, integer);
create function public.search_task_rows(
 p_company uuid,
 p_query text default '',
 p_in text[] default array['title', 'description', 'comments'],
 p_client uuid default null,
 p_project uuid default null,
 p_assignee uuid default null,
 p_creator uuid default null,
 p_status text default null,
 p_from date default null,
 p_to date default null,
 p_limit integer default 2000,
 p_offset integer default 0,
 p_priority boolean default false)
returns table(task jsonb, match_in text, snippet text, comment_id uuid, rank integer, total bigint)
language sql stable security invoker set search_path = '' as $$
 with q as (
  select mavi_private.fold(trim(coalesce(p_query, ''))) as term),
 pattern as (
  select term, '%' || replace(replace(replace(term, '\', '\\'), '%', '\%'), '_', '\_') || '%' as pat from q),
 base as (
  select t.* from public.tasks t
  left join public.contracts k on k.company_id = t.company_id and k.id = t.contract_id
  where t.company_id = p_company and not t.archived
   and (p_client is null or k.client_id = p_client)
   and (p_project is null or t.project_id = p_project)
   and (p_assignee is null or t.assignee_id = p_assignee)
   and (p_creator is null or t.creator_id = p_creator)
   and (coalesce(p_status, '') = '' or t.status = p_status)
   and (p_from is null or t.due_date >= p_from)
   and (p_to is null or t.due_date <= p_to)
   and (not coalesce(p_priority, false) or t.priority_weight > 0)),
 hits as (
  -- No text: the filters alone list the tasks.
  select b.id as task_id, 'filters'::text as match_in, ''::text as txt, null::uuid as comment_id, 0 as rank, b.created_at as at
  from base b, pattern p where p.term = ''
  union all
  select b.id, 'title', b.title, null, 1, b.created_at
  from base b, pattern p
  where p.term <> '' and 'title' = any(p_in) and mavi_private.fold(b.title) like p.pat
  union all
  select b.id, 'description', mavi_private.rich_plain(b.description), null, 2, b.created_at
  from base b, pattern p
  where p.term <> '' and 'description' = any(p_in)
   and mavi_private.fold(mavi_private.rich_plain(b.description)) like p.pat
  union all
  select b.id, 'description', a.transcript, null, 2, a.created_at
  from base b join public.task_audios a on a.company_id = b.company_id and a.task_id = b.id and a.comment_id is null,
   pattern p
  where p.term <> '' and 'description' = any(p_in) and a.transcript is not null
   and mavi_private.fold(a.transcript) like p.pat
  union all
  select b.id, 'comment', mavi_private.rich_plain(c.body), c.id, 3, c.created_at
  from base b join public.comments c on c.company_id = b.company_id and c.task_id = b.id, pattern p
  where p.term <> '' and 'comments' = any(p_in)
   and mavi_private.fold(mavi_private.rich_plain(c.body)) like p.pat
  union all
  select b.id, 'comment', a.transcript, a.comment_id, 3, a.created_at
  from base b join public.task_audios a on a.company_id = b.company_id and a.task_id = b.id and a.comment_id is not null,
   pattern p
  where p.term <> '' and 'comments' = any(p_in) and a.transcript is not null
   and mavi_private.fold(a.transcript) like p.pat),
 best as (
  select distinct on (h.task_id) h.* from hits h order by h.task_id, h.rank, h.at desc)
 select to_jsonb(t) - array['description', 'custom_fields'], b.match_in,
  case when b.match_in = 'filters' then '' else mavi_private.search_snippet(b.txt, p.term) end,
  b.comment_id, b.rank, count(*) over ()
 from best b join public.tasks t on t.id = b.task_id, pattern p
 order by b.rank, t.created_at desc, t.id
 limit least(greatest(coalesce(p_limit, 2000), 1), 2000) offset greatest(coalesce(p_offset, 0), 0)
$$;
revoke all on function public.search_task_rows(uuid, text, text[], uuid, uuid, uuid, uuid, text, date, date, integer, integer, boolean) from public, anon;
grant execute on function public.search_task_rows(uuid, text, text[], uuid, uuid, uuid, uuid, text, date, date, integer, integer, boolean) to authenticated;

-- ------------------------------------------------------------ o que já existe
-- As abertas com Alta/Urgente que vieram de regra automática ou de quem não
-- poderia marcar voltam a Normal (o histórico diz que foi a regra); as
-- outras guardam quem criou como quem marcou. As repetições, idem.
create temporary table priority_reset on commit drop as
select t.id, t.priority from public.tasks t
where not t.archived and t.status <> 'done' and t.priority in ('high', 'urgent')
 and (exists(select 1 from public.social_leads_posts p where p.task_id = t.id)
  or exists(select 1 from public.task_events e where e.company_id = t.company_id and e.task_id = t.id
   and e.action = 'created' and e.detail ? 'suggestion')
  or exists(select 1 from public.social_leads_briefings b
   left join public.task_recurrences r on r.company_id = b.company_id and r.source_task_id::text = b.cycle->>'meeting'
   where b.company_id = t.company_id and (b.cycle->>'meeting' = t.id::text or r.id = t.recurrence_id))
  or not mavi_private.can_prioritize_as(t.company_id, coalesce((select e.actor_id from public.task_events e
   where e.company_id = t.company_id and e.task_id = t.id and e.action = 'created'
   order by e.created_at limit 1), t.creator_id), t.assignee_id));
update public.tasks t set priority = 'normal', version = version + 1
from priority_reset x where t.id = x.id;
update public.tasks t set priority_set_by = coalesce((select e.actor_id from public.task_events e
  where e.company_id = t.company_id and e.task_id = t.id and e.action = 'created'
  order by e.created_at limit 1), t.creator_id),
 priority_set_at = t.created_at
where t.priority in ('high', 'urgent') and t.priority_set_by is null;

update public.task_recurrences r set priority = 'normal'
where r.priority in ('high', 'urgent')
 and (exists(select 1 from public.social_leads_briefings b
   where b.company_id = r.company_id and b.cycle->>'meeting' = r.source_task_id::text)
  or not (mavi_private.can_prioritize_as(r.company_id, r.creator_id, r.assignee_id)
   or (r.assignee_id is null and exists(select 1 from public.team_members s
    where s.company_id = r.company_id and s.team_id = r.team_id and s.user_id = r.creator_id and s.supervisor))));

notify pgrst, 'reload schema';

commit;
