begin;

-- Tarefas › ações em massa: mudar o status também escolhe quem fica com cada
-- tarefa, como na mudança de uma por uma ("Responsável a partir de agora").
--
-- * p_change.assignee: 'suggested' (quem o novo status sugere em cada tarefa:
--   Devolvida → criador; Em validação → quem valida, criador ou supervisor da
--   equipe; Em andamento, Alteração e Correção → quem executou por último),
--   o id de uma pessoa para todas, ou 'keep' (cada uma com o responsável que
--   tem; o padrão quando não vem nada). Entregue não troca responsável.
-- * Quem recebe tarefas no lote ganha o aviso agrupado 'tasks_assigned'
--   ("moveu para Em validação e passou N tarefas para você").

-- ------------------------------------------------------------ sugestão
-- Espelha suggestedAssignee (src/domain.ts): só uma sugestão, quem move
-- confirma ou escolhe outra pessoa. Sem ninguém ativo, fica o responsável.
create or replace function mavi_private.suggested_assignee(t public.tasks, p_target text) returns uuid
language plpgsql stable security definer set search_path = '' as $$
declare p public.projects; pick uuid; begin
 if p_target = t.status then return t.assignee_id; end if;
 if p_target = 'returned' then
  pick := t.creator_id;
 elsif p_target = 'review' then
  select * into p from public.projects where company_id = t.company_id and id = t.project_id;
  if found and not p.requires_review then return t.assignee_id; end if;
  if found and p.approver = 'supervisor' then
   -- O responsável que já supervisiona a equipe continua com a tarefa.
   if exists(select 1 from mavi_private.task_supervisors(t) s where s = t.assignee_id) then
    return t.assignee_id; end if;
   select s into pick from mavi_private.task_supervisors(t) s
    join public.memberships m on m.company_id = t.company_id and m.user_id = s
    order by m.name limit 1;
  end if;
  pick := coalesce(pick, t.creator_id);
 elsif t.status in ('progress', 'rejected', 'correction') then
  return t.assignee_id;
 else
  -- Quem estava com a tarefa da última vez que ela saiu de uma etapa de execução.
  select (e.detail->>'assignee_from')::uuid into pick from public.task_events e
  where e.company_id = t.company_id and e.task_id = t.id
   and e.detail->>'from' in ('progress', 'rejected', 'correction')
   and jsonb_typeof(e.detail->'assignee_from') = 'string'
  order by e.created_at desc limit 1;
 end if;
 if pick is not null and exists(select 1 from public.memberships
  where company_id = t.company_id and user_id = pick and active) then return pick; end if;
 return t.assignee_id;
end $$;
revoke all on function mavi_private.suggested_assignee(public.tasks, text) from public, anon, authenticated;

-- Os supervisores ativos da equipe da tarefa (ou das equipes do cliente,
-- quando ela não tem equipe), como mavi_private.task_supervisor.
create or replace function mavi_private.task_supervisors(t public.tasks) returns setof uuid
language sql stable security definer set search_path = '' as $$
 select distinct tm.user_id from public.team_members tm
 join public.memberships m on m.company_id = tm.company_id and m.user_id = tm.user_id and m.active
 join public.contracts k on k.company_id = t.company_id and k.id = t.contract_id
 where tm.company_id = t.company_id and tm.supervisor and (tm.team_id = t.team_id
  or (t.team_id is null and exists(select 1 from public.client_teams ct
   where ct.company_id = k.company_id and ct.client_id = k.client_id and ct.team_id = tm.team_id)))
$$;
revoke all on function mavi_private.task_supervisors(public.tasks) from public, anon, authenticated;

-- ------------------------------------------------------------ alteração em massa
-- A da migração 20270130090000, com o responsável na mudança de status.
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
 v_assign text; v_to uuid;
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
  -- Quem fica com cada tarefa: a sugestão do novo status, uma pessoa para
  -- todas ou o responsável de cada uma (o padrão de quem não manda nada).
  v_assign := coalesce(nullif(p_change->>'assignee', ''), 'keep');
  if v_status = 'done' then v_assign := 'keep';
  elsif v_assign not in ('keep', 'suggested') then
   begin v_person := v_assign::uuid;
   exception when others then raise exception 'Escolha um responsável ativo da empresa'; end;
   if not exists(select 1 from public.memberships where company_id = p_company and user_id = v_person and active) then
    raise exception 'Escolha um responsável ativo da empresa'; end if;
   v_assign := 'person';
  end if;
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
     else
      v_to := case v_assign when 'person' then v_person
       when 'suggested' then mavi_private.suggested_assignee(t, v_status) end;
      perform public.transition_task(t.id, t.version, 'move', v_note, v_status, v_to);
     end if;
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
  if kind in ('assignee', 'team', 'status') then
   insert into public.notifications(company_id, user_id, actor_id, task_id, kind, title, body, link)
   select p_company, r.u, me, null, 'tasks_assigned',
    coalesce((select name from public.memberships where company_id = p_company and user_id = me), 'Alguém')
     || case when kind = 'status' then ' moveu para ' || mavi_private.status_label(v_status) || ' e' else '' end
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

commit;
