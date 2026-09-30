-- Prazo da tarefa com motivo (corrige a 20270109090000, que pôs a regra na
-- "data de entrada": o pedido era para o Prazo). A data de entrada sai.
--
-- Quem cria, quem é responsável, os participantes, os supervisores das
-- equipes do responsável, gestores e administradores mudam o prazo direto
-- na tarefa (set_task_due), sem mexer em aprovação nem status. Toda mudança
-- de prazo feita por alguém — na tarefa, em Editar, em massa ou no
-- replanejamento — pede o motivo, fica no histórico e em task_due_changes
-- (não se apaga com o histórico de 1 mês) e entra nos Dashboards na fonte
-- "Mudanças de prazo". As que o sistema faz sozinho (a principal acompanhar
-- a subtarefa, a regra recalcular) não entram.
begin;

-- ------------------------------------------------------------ sai a data de entrada
drop function public.set_task_entry_date(uuid, integer, date, text);
drop function mavi_private.can_change_entry(public.tasks);
drop table public.task_entry_changes;
delete from public.task_events where action = 'entry_changed';
alter table public.tasks drop column entered_at;

-- ------------------------------------------------------------ registro
create table public.task_due_changes (
 id uuid primary key default gen_random_uuid(),
 company_id uuid not null,
 task_id uuid not null,
 changed_by uuid not null,
 old_due date not null,
 new_due date not null,
 reason text not null check (length(btrim(reason)) between 5 and 1000),
 -- task = direto no Prazo; edit = Editar tarefa; bulk = em massa; replan = replanejamento.
 source text not null check (source in ('task', 'edit', 'bulk', 'replan')),
 -- O lote em massa, para o desfazer tirar o registro.
 operation_id uuid,
 created_at timestamptz not null default now(),
 check (new_due <> old_due),
 foreign key (company_id, task_id) references public.tasks(company_id, id) on delete cascade
);
create index task_due_changes_task on public.task_due_changes(task_id, created_at desc);
create index task_due_changes_company on public.task_due_changes(company_id, created_at);
create index task_due_changes_operation on public.task_due_changes(operation_id) where operation_id is not null;
alter table public.task_due_changes enable row level security;
-- Quem vê a tarefa vê as mudanças de prazo dela (task_extras é security invoker).
create policy task_due_changes_read on public.task_due_changes for select to authenticated
 using (mavi_private.task_access(company_id, task_id));
revoke all on public.task_due_changes from anon, authenticated;
grant select on public.task_due_changes to authenticated;

-- Quem muda o prazo direto na tarefa: criador, responsável, participantes
-- (mencionados e quem já foi responsável), supervisor de uma equipe do
-- responsável, gestores e administradores.
create or replace function mavi_private.can_change_due(t public.tasks) returns boolean
language sql stable security definer set search_path = '' as $$
 select mavi_private.member(t.company_id) and (
  mavi_private.leader(t.company_id)
  or auth.uid() in (t.creator_id, t.assignee_id)
  or auth.uid() = any(coalesce(t.participant_ids, '{}'))
  or exists (select 1 from public.task_participants p
   where p.company_id = t.company_id and p.task_id = t.id and p.user_id = auth.uid())
  or exists (select 1 from public.team_members s
   join public.team_members a on a.company_id = s.company_id and a.team_id = s.team_id
   where s.company_id = t.company_id and s.user_id = auth.uid() and s.supervisor and a.user_id = t.assignee_id))
$$;

create or replace function mavi_private.require_due_reason(p_reason text) returns void
language plpgsql immutable set search_path = '' as $$ begin
 if length(btrim(coalesce(p_reason, ''))) < 5 then
  raise exception 'Informe o motivo da mudança de prazo (ao menos 5 caracteres).' using errcode = '22023';
 end if;
 if length(btrim(p_reason)) > 1000 then
  raise exception 'O motivo pode ter até 1000 caracteres.' using errcode = '22023';
 end if;
end $$;

-- O registro durável e o histórico, com o mesmo id (task_extras junta os
-- dois sem repetir). t já está com o prazo novo.
create or replace function mavi_private.log_due_change(t public.tasks, p_old date, p_reason text, p_source text)
 returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_id uuid := gen_random_uuid(); v_by uuid := coalesce(auth.uid(), t.creator_id); v_reason text := btrim(p_reason); begin
 insert into public.task_due_changes(id, company_id, task_id, changed_by, old_due, new_due, reason, source)
 values (v_id, t.company_id, t.id, v_by, p_old, t.due_date, v_reason, p_source);
 insert into public.task_events(id, company_id, task_id, actor_id, action, detail)
 values (v_id, t.company_id, t.id, v_by, 'due_changed',
  jsonb_build_object('old_due', p_old, 'new_due', t.due_date, 'reason', v_reason, 'source', p_source));
 return v_id;
end $$;
revoke all on function mavi_private.can_change_due(public.tasks), mavi_private.require_due_reason(text),
 mavi_private.log_due_change(public.tasks, date, text, text) from public, anon, authenticated;

-- ------------------------------------------------------------ direto na tarefa
-- Só a data muda (aprovações e status ficam, como na alteração em massa); o
-- prazo passa a ser "à mão". Antes do mínimo da regra, o mesmo motivo vale
-- como justificativa do prazo apertado.
create or replace function public.set_task_due(p_task uuid, p_version integer, p_due date, p_reason text)
 returns public.tasks
language plpgsql security definer set search_path = '' as $$
declare t public.tasks; changed public.tasks; ch record; begin
 select * into t from public.tasks where id = p_task for update;
 if not found or t.archived or not mavi_private.can_change_due(t) then
  raise exception 'Sem permissão para mudar o prazo desta tarefa' using errcode = '42501';
 end if;
 if t.version <> p_version then raise exception 'A tarefa mudou. Atualize antes de continuar.' using errcode = '40001'; end if;
 if p_due is null then raise exception 'Escolha o novo prazo.' using errcode = '22023'; end if;
 if p_due = t.due_date then raise exception 'A tarefa já tem esse prazo.' using errcode = '22023'; end if;
 perform mavi_private.require_due_reason(p_reason);
 if t.start_date is not null and p_due < t.start_date then
  raise exception 'O prazo não pode ficar antes do início planejado (%).', to_char(t.start_date, 'DD/MM/YYYY')
   using errcode = '22023';
 end if;
 select * into ch from mavi_private.choose_due(t.company_id, t.contract_id, t.project_id, t.team_id, t.assignee_id,
  mavi_private.task_due_base(t), t.requires_client_approval, p_due, true, p_reason, p_due < t.due_date);
 update public.tasks set due_date = ch.due, due_manual = true, due_rule_id = null, due_smart = false,
  due_tight_reason = case when ch.tight_reason is not null then ch.tight_reason
   when ch.min_due is not null and ch.due < ch.min_due then t.due_tight_reason end,
  version = version + 1
 where id = t.id returning * into changed;
 if ch.tight_reason is not null then perform mavi_private.log_tight_due(changed, ch.min_due, ch.tight_reason); end if;
 perform mavi_private.log_due_change(changed, t.due_date, p_reason, 'task');
 select * into changed from public.tasks where id = t.id;
 return changed;
end $$;
revoke all on function public.set_task_due(uuid, integer, date, text) from public, anon;
grant execute on function public.set_task_due(uuid, integer, date, text) to authenticated;

-- ------------------------------------------------------------ Editar tarefa
-- A da migração 20261215090000: mudar o prazo pede o motivo (p_due_reason).
create or replace function public.update_task(p_task uuid,p_version integer,p_title text,p_description text,p_due date,p_estimated integer,p_priority text,p_start date default null,
 p_due_manual boolean default null, p_due_reason text default null, p_due_smart boolean default null,
 p_due_effort text default null, p_contract uuid default null, p_project uuid default null) returns public.tasks
language plpgsql security definer set search_path = '' as $$
declare t public.tasks; ch record; smart jsonb; moved boolean; old_k record; new_k record; move_detail jsonb := '{}';
 v_old_due date; begin
 select * into t from public.tasks where id=p_task for update;
 if not found or not mavi_private.can_edit(t.company_id,t.id) then raise exception 'Sem permissão' using errcode='42501'; end if;
 if t.version<>p_version then raise exception 'A tarefa mudou. Atualize antes de continuar.' using errcode='40001'; end if;
 moved := p_contract is not null and p_contract <> t.contract_id;
 if moved then
  if t.parent_id is not null then
   raise exception 'Subtarefa fica no cliente da tarefa principal. Troque o cliente da principal.';
  end if;
  if exists(select 1 from public.social_leads_posts where task_id = t.id) then
   raise exception 'Esta tarefa é de um post do Social Leads e fica no cliente do plano.';
  end if;
  select k.id, k.name, k.archived, c.id as client_id, c.name as client_name, c.archived as client_archived,
   p.name as product into new_k
  from public.contracts k join public.clients c on c.company_id = k.company_id and c.id = k.client_id
  join public.products p on p.company_id = k.company_id and p.id = k.product_id
  where k.company_id = t.company_id and k.id = p_contract;
  if not found then raise exception 'Produto contratado não encontrado'; end if;
  if new_k.archived or new_k.client_archived then
   raise exception 'Este cliente está arquivado. Desarquive-o para mover tarefas para ele.' using errcode = '22023';
  end if;
  if not mavi_private.contract_access(t.company_id, p_contract) then
   raise exception 'Sem acesso ao produto contratado' using errcode = '42501';
  end if;
  if p_project is not null and not exists(select 1 from public.projects
   where company_id = t.company_id and contract_id = p_contract and id = p_project) then
   raise exception 'O projeto não é deste produto do cliente';
  end if;
  select c.name as client_name, p.name as product into old_k
  from public.contracts k join public.clients c on c.company_id = k.company_id and c.id = k.client_id
  join public.products p on p.company_id = k.company_id and p.id = k.product_id
  where k.company_id = t.company_id and k.id = t.contract_id;
  -- A principal e as subtarefas de uma vez (ver acima).
  update public.tasks s set contract_id = p_contract, project_id = p_project,
   team_id = case when s.team_id is not null and exists(select 1 from public.client_teams ct
    where ct.company_id = s.company_id and ct.client_id = new_k.client_id and ct.team_id = s.team_id)
    then s.team_id end
  where s.company_id = t.company_id and (s.id = t.id or s.parent_id = t.id);
  update public.task_recurrences r set contract_id = p_contract, project_id = p_project,
   team_id = case when r.team_id is not null and exists(select 1 from public.client_teams ct
    where ct.company_id = r.company_id and ct.client_id = new_k.client_id and ct.team_id = r.team_id)
    then r.team_id end
  where r.company_id = t.company_id and r.id in (select s.recurrence_id from public.tasks s
   where s.company_id = t.company_id and (s.id = t.id or s.parent_id = t.id) and s.recurrence_id is not null);
  move_detail := jsonb_build_object('old_client', old_k.client_name, 'old_product', old_k.product,
   'new_client', new_k.client_name, 'new_product', new_k.product);
  select * into t from public.tasks where id = t.id;
 end if;
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
 -- Migração 20270110090000: mudar o prazo pede sempre o motivo.
 v_old_due := t.due_date;
 if ch.due is distinct from t.due_date then perform mavi_private.require_due_reason(p_due_reason); end if;
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
   then jsonb_build_object('due_rule', ch.rule_id) else '{}'::jsonb end
  || move_detail);
 select * into t from public.tasks where id=t.id;
 if ch.tight_reason is not null and ch.min_due is not null then perform mavi_private.log_tight_due(t, ch.min_due, ch.tight_reason); end if;
 if t.due_date is distinct from v_old_due then perform mavi_private.log_due_change(t, v_old_due, p_due_reason, 'edit'); end if;
 return t;
end $$;
revoke all on function public.update_task(uuid,integer,text,text,date,integer,text,date,boolean,text,boolean,text,uuid,uuid) from public, anon;
grant execute on function public.update_task(uuid,integer,text,text,date,integer,text,date,boolean,text,boolean,text,uuid,uuid) to authenticated;

-- ------------------------------------------------------------ em massa
-- A da migração 20261126120000: prazo pede o motivo (p_change->>'reason'),
-- vale para quem pode mudar o prazo da tarefa e cada mudança é registrada.
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
  perform mavi_private.broadcast_tasks(p_company, touched, people);
 end if;
 -- Lotes de mais de uma semana já não se desfazem.
 delete from public.task_bulk_operations
  where company_id = p_company and actor_id = me and created_at < now() - interval '7 days';
 return jsonb_build_object('preview', false, 'operation', op, 'applied', applied, 'results', results);
end $$;

-- A da migração 20261126120000: o desfazer tira o registro da mudança de prazo.
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
  -- A mudança de prazo desfeita sai das métricas (migração 20270110090000).
  delete from public.task_due_changes where operation_id = o.id and task_id = t.id;
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

-- ------------------------------------------------------------ replanejamento
-- A da migração 20261201120000, com o motivo.
drop function public.apply_replan(uuid, jsonb);
create function public.apply_replan(p_company uuid, p_items jsonb, p_reason text default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare i jsonb; t public.tasks; changed public.tasks; who uuid; due date; reason text; results jsonb := '[]'; applied integer := 0; begin
 if not mavi_private.leader(p_company) then
  raise exception 'Só gestores e administradores aplicam um replanejamento' using errcode = '42501';
 end if;
 if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) > 100 then
  raise exception 'Replaneje até 100 tarefas por vez';
 end if;
 -- Migração 20270110090000: adiar pede o motivo (vale para todas do lote).
 if exists (select 1 from jsonb_array_elements(p_items) x where nullif(x->>'due', '') is not null) then
  perform mavi_private.require_due_reason(p_reason);
 end if;
 for i in select * from jsonb_array_elements(p_items) loop
  reason := null;
  select * into t from public.tasks where company_id = p_company and id = (i->>'task')::uuid;
  if not found or t.archived or t.status = 'done' then
   results := results || jsonb_build_object('task_id', i->>'task', 'ok', false, 'reason', 'Tarefa não encontrada ou já entregue');
   continue;
  end if;
  who := nullif(i->>'assignee', '')::uuid;
  due := nullif(i->>'due', '')::date;
  begin
   if not mavi_private.can_manage_person(p_company, t.assignee_id) then
    raise exception 'Fora das suas equipes';
   end if;
   if who is not null and who <> t.assignee_id then
    perform public.transition_task(t.id, t.version, 'move', '', t.status, who);
    select * into t from public.tasks where id = t.id;
   end if;
   if due is not null and due <> t.due_date then
    if t.start_date is not null and due < t.start_date then raise exception 'O prazo ficaria antes do início'; end if;
    update public.tasks set due_date = due, due_manual = true, due_rule_id = null, version = version + 1 where id = t.id
     returning * into changed;
    perform mavi_private.log_due_change(changed, t.due_date, p_reason, 'replan');
   end if;
   applied := applied + 1;
  exception when others then
   reason := sqlerrm;
  end;
  results := results || jsonb_build_object('task_id', t.id, 'ok', reason is null, 'reason', reason);
 end loop;
 return jsonb_build_object('applied', applied, 'results', results);
end $$;
revoke all on function public.apply_replan(uuid, jsonb, text) from public, anon;
grant execute on function public.apply_replan(uuid, jsonb, text) to authenticated;

-- ------------------------------------------------------------ histórico
-- O histórico da tarefa: os eventos (1 mês) e, sempre, as mudanças de prazo
-- com o motivo (a da migração 20270109090000).
create or replace function public.task_extras(p_task uuid) returns jsonb
language plpgsql stable security invoker set search_path='' as $$
declare c uuid; rec uuid; begin
 select company_id, recurrence_id into c, rec from public.tasks where id=p_task;
 if not found then raise exception 'Sem acesso à tarefa' using errcode='42501'; end if;
 return jsonb_build_object(
 'comments',(select coalesce(jsonb_agg(r order by r.created_at desc,r.id desc),'[]'::jsonb) from
   (select * from public.comments where company_id=c and task_id=p_task order by created_at desc,id desc limit 100) r),
 'attachments',(select coalesce(jsonb_agg(r order by r.created_at desc,r.id desc),'[]'::jsonb) from
   (select * from public.attachments where company_id=c and task_id=p_task order by created_at desc,id desc limit 100) r),
 'events',(select coalesce(jsonb_agg(r order by r.created_at desc,r.id desc),'[]'::jsonb) from
   (select * from (select e.id, e.company_id, e.task_id, e.actor_id, e.action, e.detail, e.created_at
     from public.task_events e where e.company_id=c and e.task_id=p_task
    union all
    select x.id, x.company_id, x.task_id, x.changed_by, 'due_changed',
     jsonb_build_object('old_due', x.old_due, 'new_due', x.new_due, 'reason', x.reason, 'source', x.source), x.created_at
     from public.task_due_changes x where x.company_id=c and x.task_id=p_task
      and not exists (select 1 from public.task_events e where e.id = x.id)) u
    order by created_at desc,id desc limit 100) r),
 'audios',(select coalesce(jsonb_agg(to_jsonb(r) - 'working_at' order by r.position, r.created_at, r.id),'[]'::jsonb) from
   (select * from public.task_audios where company_id=c and task_id=p_task order by position, created_at, id limit 200) r),
 'recurrence',(select jsonb_build_object('id',r.id,'frequency',r.frequency,'next_run',r.next_run,'active',r.active,
   'creator_id',r.creator_id,'copies',r.copies,'last_error',r.last_error)
   from public.task_recurrences r where r.company_id=c and r.id=rec));
end $$;

-- ------------------------------------------------------------ Dashboards
-- A da migração 20270109090000 sem a data de entrada (o prazo médio volta a
-- contar da criação) e com a fonte 'due_changes' no lugar de 'entry_changes'.
create or replace function mavi_private.dashboard_sql(c uuid, q jsonb, p_group text, p_interval text,
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
  nodate boolean := false;
  -- Tasks, status history, validations and due date changes all read the task (t.).
  on_task boolean := src in ('tasks', 'status_history', 'reviews', 'due_changes');
  executor constant text := 'coalesce(t.executor_id, t.assignee_id)';
  validator constant text := 'coalesce(p.ended_by, p.user_id)';
  dur constant text := 'extract(epoch from (coalesce(p.ended_at, now()) - p.started_at))';
  delivered_day text;
  rework constant text := 'exists (select 1 from public.task_status_periods x where x.task_id = t.id'
   ' and (x.status in (''rejected'', ''correction'') or x.from_status = ''done''))';
  -- Temperatura (migration 20261110090000): the bands that warn, by index.
  bands jsonb;
  alert_bands integer[];
  ind text;
  -- Radar (migration 20261230090000): the kind of the item's status.
  rkind text;
begin
  select timezone into tz from public.companies where id = c;
  if tz is null then raise exception 'Empresa não encontrada'; end if;
  late := format('((t.status <> ''done'' and t.due_date < (now() at time zone %1$L)::date)'
   ' or (t.delivered_at is not null and (t.delivered_at at time zone %1$L)::date > t.due_date))', tz);
  delivered_day := format('(t.delivered_at at time zone %L)::date', tz);

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
      -- Migration 20261104090000: delivery quality.
      when 'on_time_rate' then format('100.0 * count(*) filter (where %s <= t.due_date) / nullif(count(*), 0)', delivered_day)
      when 'on_time_original_rate' then
        format('100.0 * count(*) filter (where %s <= t.original_due_date) / nullif(count(*), 0)', delivered_day)
      when 'delay_days' then format('avg((%1$s - t.due_date)::numeric) filter (where %1$s > t.due_date)', delivered_day)
      when 'rescheduled' then 'count(*) filter (where t.due_date <> t.original_due_date)'
      when 'first_pass_rate' then format('100.0 * count(*) filter (where not %s) / nullif(count(*), 0)', rework)
      when 'rework_per_task' then 'avg((select count(*) from public.task_status_periods x where x.task_id = t.id'
       ' and x.status in (''rejected'', ''correction'') and x.from_status is distinct from x.status))'
      -- Migration 20261201120000: how the suggested due dates did. Among the
      -- delivered tasks that had the suggestion, the share delivered by it
      -- and the MAVI's average miss (days, either way).
      when 'smart_hit_rate' then format('100.0 * count(*) filter (where %s <= t.due_smart_date)'
       ' / nullif(count(*) filter (where t.due_smart_date is not null), 0)', delivered_day)
      when 'rule_hit_rate' then format('100.0 * count(*) filter (where %s <= t.due_rule_date)'
       ' / nullif(count(*) filter (where t.due_rule_date is not null), 0)', delivered_day)
      when 'smart_error_days' then format('avg(abs(%s - t.due_smart_date)::numeric)'
       ' filter (where t.due_smart_date is not null)', delivered_day)
      -- A date set before the rule's minimum (with a reason) and one set
      -- earlier than the MAVI suggested.
      when 'tight_due' then 'count(*) filter (where t.due_tight_reason is not null)'
      when 'shorter_than_smart' then 'count(*) filter (where t.original_due_date < t.due_smart_date)'
    end;
    if metric in ('lead_time_days', 'on_time_rate', 'on_time_original_rate', 'delay_days', 'first_pass_rate',
     'rework_per_task', 'smart_hit_rate', 'rule_hit_rate', 'smart_error_days') then
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
  elsif src = 'status_history' then
    -- Migration 20261104090000: each period a task spent in a status with a
    -- responsible. "Vezes" counts entries into the status (a change of hands
    -- inside it is not a new entry); time runs until now while open.
    base := 'public.task_status_periods p join public.tasks t on t.id = p.task_id';
    conds := array[format('p.company_id = %L', c), 'not t.archived'];
    person := 'p.user_id';
    datef := coalesce(q->>'dateField', 'started_at');
    if datef = 'started_at' then col := 'p.started_at';
    elsif datef = 'ended_at' then col := 'p.ended_at';
    else raise exception 'Campo de data inválido: %', datef using errcode = '22023';
    end if;
    m := case metric
      when 'entries' then 'count(*) filter (where p.from_status is distinct from p.status)'
      when 'hours' then format('coalesce(sum(%s), 0) / 3600.0', dur)
      when 'avg_hours' then format('avg(%s) / 3600.0', dur)
      when 'tasks' then 'count(distinct p.task_id)'
      when 'reopens' then 'count(*) filter (where p.from_status = ''done'')'
    end;
    if metric in ('avg_hours', 'tasks') then additive := false; end if;
  elsif src = 'reviews' then
    -- Migration 20261104090000: the validation periods. Approved = left
    -- validation delivered; reproved = sent back to Alteração or Correção.
    -- The person is whoever sent it to validation; the validator, whoever
    -- decided (or held it, while undecided).
    base := 'public.task_status_periods p join public.tasks t on t.id = p.task_id';
    conds := array[format('p.company_id = %L', c), 'not t.archived', 'p.status = ''review'''];
    person := 'p.previous_user_id';
    -- Each metric has its own date: the sending or the decision.
    col := case when metric = 'sent' then 'p.started_at' else 'p.ended_at' end;
    m := case metric
      when 'sent' then 'count(*) filter (where p.from_status is distinct from ''review'')'
      when 'approved' then 'count(*) filter (where p.to_status = ''done'')'
      when 'reproved' then 'count(*) filter (where p.to_status in (''rejected'', ''correction''))'
      when 'approval_rate' then '100.0 * count(*) filter (where p.to_status = ''done'')'
       ' / nullif(count(*) filter (where p.to_status in (''done'', ''rejected'', ''correction'')), 0)'
      when 'reproval_rate' then '100.0 * count(*) filter (where p.to_status in (''rejected'', ''correction''))'
       ' / nullif(count(*) filter (where p.to_status in (''done'', ''rejected'', ''correction'')), 0)'
      when 'avg_hours' then format('avg(%s) / 3600.0', dur)
    end;
    if metric in ('approval_rate', 'reproval_rate', 'avg_hours') then additive := false; end if;
  elsif src = 'due_changes' then
    -- Migration 20270110090000: each change of a task's due date after its
    -- creation, with its reason (task, edit, bulk or replanning). "Pessoa" is
    -- who changed it; the date, when it was changed.
    base := 'public.task_due_changes x join public.tasks t on t.id = x.task_id';
    conds := array[format('x.company_id = %L', c), 'not t.archived'];
    person := 'x.changed_by';
    col := 'x.created_at';
    m := case metric
      when 'changes' then 'count(*)'
      when 'tasks' then 'count(distinct x.task_id)'
      when 'avg_days' then 'avg(abs(x.new_due - x.old_due)::numeric)'
      when 'earlier' then 'count(*) filter (where x.new_due < x.old_due)'
      when 'later' then 'count(*) filter (where x.new_due > x.old_due)'
    end;
    if metric in ('tasks', 'avg_days') then additive := false; end if;
  elsif src = 'notices' then
    -- Mural de avisos (migration 20261107090000): one row per person reached
    -- by a notice (its current round), dated by the delivery. Seen, confirmed
    -- ("Li e entendi", only notices that ask for it) and pending (not seen,
    -- or not confirmed when asked).
    base := 'public.notice_receipts r join public.notices n on n.id = r.notice_id';
    conds := array[format('r.company_id = %L', c)];
    person := 'r.user_id';
    col := 'r.delivered_at';
    m := case metric
      when 'notices' then 'count(distinct r.notice_id)'
      when 'delivered' then 'count(*)'
      when 'seen' then 'count(r.seen_at)'
      when 'pending' then 'count(*) filter (where r.seen_at is null or (n.require_ack and r.acked_at is null))'
      when 'seen_rate' then '100.0 * count(r.seen_at) / nullif(count(*), 0)'
      when 'acked' then 'count(r.acked_at)'
      when 'ack_rate' then '100.0 * count(r.acked_at) / nullif(count(*) filter (where n.require_ack), 0)'
      when 'hours_to_see' then 'avg(extract(epoch from (r.seen_at - r.delivered_at))) / 3600.0'
      when 'hours_to_ack' then 'avg(extract(epoch from (r.acked_at - r.delivered_at))) / 3600.0'
    end;
    if metric in ('notices', 'seen_rate', 'ack_rate', 'hours_to_see', 'hours_to_ack') then additive := false; end if;
  elsif src = 'temperature' then
    -- Termômetro (migration 20261110090000): one row per client and day with
    -- the day's temperature (0–100), each indicator and the alert signals.
    -- Averages over the client-days of the period; counts are distinct
    -- clients.
    select s.bands into bands from public.temperature_settings s where s.company_id = c;
    select coalesce(array_agg((x.n - 1)::integer), '{}') into alert_bands
    from jsonb_array_elements(coalesce(bands, '[]')) with ordinality x(b, n) where coalesce((x.b->>'alert')::boolean, false);
    base := 'public.temperature_days d join public.clients cl on cl.id = d.client_id';
    conds := array[format('d.company_id = %L', c), 'not cl.archived'];
    col := 'd.day';
    is_ts := false;
    ind := q->>'indicator';
    if metric = 'indicator' and coalesce(ind, '') !~ '^[a-z][a-z0-9_]{1,39}$' then
      raise exception 'Escolha o indicador do termômetro.' using errcode = '22023';
    end if;
    m := case metric
      when 'score' then 'avg(d.score)'
      when 'indicator' then format('avg((d.indicators->>%L)::numeric)', ind)
      when 'clients' then 'count(distinct d.client_id) filter (where d.score is not null)'
      when 'alert_clients' then format('count(distinct d.client_id) filter (where d.band = any(%L::integer[]))', alert_bands)
      when 'alert_rate' then format('100.0 * count(distinct d.client_id) filter (where d.band = any(%L::integer[]))'
       ' / nullif(count(distinct d.client_id) filter (where d.score is not null), 0)', alert_bands)
      when 'flag_clients' then 'count(distinct d.client_id) filter (where cardinality(d.flags) > 0)'
    end;
    additive := false;
  elsif src = 'social_leads' then
    -- Social Leads (migration 20261020120000): decisions from the posts'
    -- history, the time until a plan's 8 posts are approved, and the
    -- clients by stage (today's picture: no period).
    if metric in ('approvals', 'rejections', 'approval_rate', 'rejection_rate', 'adjust_per_post') then
      base := 'public.social_leads_post_events e join public.contracts k on k.id = e.contract_id';
      conds := array[format('e.company_id = %L', c), 'e.kind in (''approved'', ''rejected'')'];
      person := 'e.actor_id';
      col := 'e.created_at';
      m := case metric
        when 'approvals' then 'count(*) filter (where e.kind = ''approved'')'
        when 'rejections' then 'count(*) filter (where e.kind = ''rejected'')'
        when 'approval_rate' then '100.0 * count(*) filter (where e.kind = ''approved'') / nullif(count(*), 0)'
        when 'rejection_rate' then '100.0 * count(*) filter (where e.kind = ''rejected'') / nullif(count(*), 0)'
        when 'adjust_per_post' then
          'count(*) filter (where e.kind = ''rejected'')::numeric / nullif(count(distinct (e.plan_id, e.number)), 0)'
      end;
      if metric not in ('approvals', 'rejections') then additive := false; end if;
    elsif metric = 'approval_days' then
      base := '(select p.id, p.company_id, p.contract_id, p.created_at, p.created_by,'
       ' (select max(x.decided_at) from public.social_leads_posts x where x.plan_id = p.id) as approved_at'
       ' from public.social_leads_plans p where (select count(*) from public.social_leads_posts x'
       ' where x.plan_id = p.id and x.decision = ''approved'') = (select count(*) from public.social_leads_posts x'
       ' where x.plan_id = p.id)) a join public.contracts k on k.id = a.contract_id';
      conds := array[format('a.company_id = %L', c)];
      person := 'a.created_by';
      col := 'a.approved_at';
      m := 'avg(extract(epoch from (a.approved_at - a.created_at)) / 86400.0)';
      additive := false;
    elsif metric = 'clients' then
      base := '(select k2.id, k2.company_id, mavi_private.social_leads_stage(k2.company_id, k2.id) as stage,'
       ' (select b.responsible_id from public.social_leads_briefings b where b.company_id = k2.company_id'
       ' and b.contract_id = k2.id) as responsible'
       ' from public.contracts k2 join public.social_leads_settings s on s.company_id = k2.company_id'
       ' and s.product_id = k2.product_id join public.clients cl on cl.id = k2.client_id'
       ' where not k2.archived and not cl.archived) a join public.contracts k on k.id = a.id';
      conds := array[format('a.company_id = %L', c)];
      person := 'a.responsible';
      nodate := true;
      m := 'count(*)';
    end if;
  elsif src = 'radar' then
    -- Radar do cliente (migration 20261230090000): one row per item (a
    -- subject of a client in a topic); "Ocorrências" counts each time it came
    -- up. "Pessoa" is the item's responsible; "Equipe", the teams that serve
    -- the client.
    rkind := 'coalesce(mavi_private.radar_status(rt.statuses, i.status)->>''kind'', '''')';
    if metric = 'mentions' then
      base := 'public.radar_mentions mn join public.radar_items i on i.id = mn.item_id'
       ' join public.radar_topics rt on rt.id = i.topic_id join public.clients cl on cl.id = i.client_id';
      col := 'mn.occurred_at';
    else
      base := 'public.radar_items i join public.radar_topics rt on rt.id = i.topic_id'
       ' join public.clients cl on cl.id = i.client_id';
      datef := coalesce(q->>'dateField', 'created_at');
      if datef = 'created_at' then col := 'i.created_at';
      elsif datef = 'last_seen_at' then col := 'i.last_seen_at';
      elsif datef = 'status_at' then col := 'i.status_at';
      else raise exception 'Campo de data inválido: %', datef using errcode = '22023';
      end if;
    end if;
    conds := array[format('i.company_id = %L', c), 'not cl.archived'];
    person := 'i.assignee_id';
    m := case metric
      when 'items' then 'count(*)'
      when 'open_items' then format('count(*) filter (where %s <> ''closed'')', rkind)
      when 'closed_items' then format('count(*) filter (where %s = ''closed'')', rkind)
      when 'severe' then 'count(*) filter (where i.severity >= 2)'
      when 'overdue' then format('count(*) filter (where i.due_date < (now() at time zone %L)::date and %s <> ''closed'')',
       tz, rkind)
      when 'recurring' then 'count(*) filter (where i.mentions > 1)'
      when 'clients' then 'count(distinct i.client_id)'
      when 'avg_severity' then 'avg(i.severity)'
      when 'days_to_close' then format('avg(extract(epoch from (i.status_at - i.first_seen_at)) / 86400.0)'
       ' filter (where %s = ''closed'')', rkind)
      when 'mentions' then 'count(*)'
    end;
    if metric in ('clients', 'avg_severity', 'days_to_close') then additive := false; end if;
  else
    raise exception 'Fonte de dados inválida: %', src using errcode = '22023';
  end if;
  if m is null then raise exception 'Métrica inválida: %', metric using errcode = '22023'; end if;

  if nodate then
    if p_group = 'time' then
      raise exception 'Clientes por etapa é a situação de hoje: agrupe por etapa, cliente ou sem agrupar.' using errcode = '22023';
    end if;
  elsif is_ts then
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
    if src = 'temperature' then
      -- A client's temperature: the client itself, the products it hires,
      -- the teams that serve it and the people in those teams; the project
      -- filter doesn't apply.
      if fld = 'project' then continue; end if;
      if fld = 'band' then
        conds := conds || format(case when op = 'in' then 'd.band = any(%L::integer[])'
          else '(d.band is null or d.band <> all(%L::integer[]))' end,
         (select coalesce(array_agg(v::integer), '{}') from unnest(vals) v where v ~ '^\d{1,2}$'));
        continue;
      end if;
      colf := case fld
        when 'client' then format('select %L::uuid[]', vals)
        when 'product' then format('select k.client_id from public.contracts k where k.company_id = %L'
          ' and not k.archived and k.product_id = any(%L::uuid[])', c, vals)
        when 'team' then format('select ct.client_id from public.client_teams ct where ct.company_id = %L'
          ' and ct.team_id = any(%L::uuid[])', c, vals)
        when 'person' then format('select ct.client_id from public.client_teams ct join public.team_members tm'
          ' on tm.company_id = ct.company_id and tm.team_id = ct.team_id where ct.company_id = %L'
          ' and tm.user_id = any(%L::uuid[])', c, vals)
      end;
      if colf is null then raise exception 'Filtro inválido para esta fonte: %', fld using errcode = '22023'; end if;
      conds := conds || case when fld = 'client'
        then format(case when op = 'in' then 'd.client_id = any(%L::uuid[])' else 'd.client_id <> all(%L::uuid[])' end, vals)
        else format(case when op = 'in' then 'd.client_id in (%s)' else 'd.client_id not in (%s)' end, colf) end;
      continue;
    end if;
    if src = 'radar' then
      -- The item's client, product (none = Geral / Agência), responsible,
      -- topic, theme, severity and kind of status; a team is the clients it
      -- serves. The project filter doesn't apply.
      if fld = 'project' then continue; end if;
      if fld = 'team' then
        conds := conds || format(case when op = 'in' then 'i.client_id in (%s)' else 'i.client_id not in (%s)' end,
         format('select ct.client_id from public.client_teams ct where ct.company_id = %L and ct.team_id = any(%L::uuid[])',
          c, vals));
        continue;
      end if;
      if fld = 'severity' then
        conds := conds || format(case when op = 'in' then 'i.severity = any(%L::integer[])'
          else '(i.severity is null or i.severity <> all(%L::integer[]))' end,
         (select coalesce(array_agg(v::integer), '{}') from unnest(vals) v where v ~ '^[0-3]$'));
        continue;
      end if;
      if fld = 'state' then
        conds := conds || format(case when op = 'in' then '%s = any(%L::text[])' else '%s <> all(%L::text[])' end,
         rkind, vals);
        continue;
      end if;
      if fld = 'product' and 'none' = any(vals) then
        conds := conds || format(case when op = 'in' then '(i.product_id is null or i.product_id = any(%L::uuid[]))'
          else '(i.product_id is not null and i.product_id <> all(%L::uuid[]))' end,
         (select coalesce(array_agg(v), '{}') from unnest(vals) v where v ~* '^[0-9a-f-]{36}$'));
        continue;
      end if;
      colf := case fld when 'client' then 'i.client_id' when 'product' then 'i.product_id'
       when 'person' then 'i.assignee_id' when 'topic' then 'i.topic_id' when 'theme' then 'i.theme_id' end;
      if colf is null then raise exception 'Filtro inválido para esta fonte: %', fld using errcode = '22023'; end if;
      conds := conds || format(case when op = 'in' then '%1$s = any(%2$L::uuid[])' else '(%1$s is null or %1$s <> all(%2$L::uuid[]))' end,
       colf, (select coalesce(array_agg(v), '{}') from unnest(vals) v where v ~* '^[0-9a-f-]{36}$'));
      continue;
    end if;
    if src = 'social_leads' then
      -- A team counts the clients it serves.
      if fld = 'team' then
        conds := conds || format(case when op = 'in' then '%1$s in (%2$s)' else '%1$s not in (%2$s)' end,
         'k.client_id', format('select ct.client_id from public.client_teams ct where ct.company_id = %L and ct.team_id = any(%L::uuid[])',
          c, vals));
        continue;
      end if;
      if fld not in ('client', 'product', 'person') then
        raise exception 'Filtro inválido para esta fonte: %', fld using errcode = '22023';
      end if;
    end if;
    if src = 'notices' then
      -- Avisos não têm cliente, produto nem projeto: esses filtros do
      -- dashboard não se aplicam a eles. A equipe é a de quem recebeu.
      if fld in ('client', 'product', 'project') then continue; end if;
      if fld = 'team' then
        conds := conds || format(case when op = 'in' then '%1$s in (%2$s)' else '%1$s not in (%2$s)' end,
         'r.user_id', format('select tm.user_id from public.team_members tm where tm.company_id = %L and tm.team_id = any(%L::uuid[])',
          c, vals));
        continue;
      end if;
      if fld not in ('person', 'creator', 'level') then
        raise exception 'Filtro inválido para esta fonte: %', fld using errcode = '22023';
      end if;
    end if;
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
      when fld = 'creator' and on_task then 't.creator_id'
      when fld = 'status' and src = 'tasks' then 't.status'
      when fld = 'status' and src = 'status_history' then 'p.status'
      when fld = 'priority' and on_task then 't.priority'
      when fld = 'entry_source' and src = 'hours' then 'e.source'
      when fld = 'executor' and src = 'tasks' then executor
      when fld = 'previous' and src = 'status_history' then 'p.previous_user_id'
      when fld = 'validator' and src = 'reviews' then validator
      when fld = 'creator' and src = 'notices' then 'n.created_by'
      when fld = 'level' and src = 'notices' then 'n.level'
    end;
    if colf is null then raise exception 'Filtro inválido para esta fonte: %', fld using errcode = '22023'; end if;
    typed := format(case when fld in ('status', 'priority', 'entry_source', 'level') then '%L::text[]' else '%L::uuid[]' end, vals);
    conds := conds || format(case when op = 'in' then '%1$s = any(%2$s)' else '(%1$s is null or %1$s <> all(%2$s))' end,
     colf, typed);
  end loop;

  -- Joins only when something reads the task (t.) or its contract (k.):
  -- hours by day or by person never touch tasks.
  key := case
    when src = 'radar' then case p_group
      when 'client' then 'i.client_id' when 'product' then 'i.product_id' when 'person' then 'i.assignee_id'
      when 'team' then 'ctg.team_id' when 'topic' then 'i.topic_id' when 'theme' then 'i.theme_id'
      when 'severity' then 'i.severity' when 'status' then rkind end
    when src = 'temperature' then case p_group
      when 'client' then 'd.client_id' when 'band' then 'd.band'
      when 'team' then 'ctg.team_id' when 'product' then 'kpg.product_id' end
    when src = 'notices' then case p_group
      when 'person' then person when 'team' then 'tm.team_id' when 'creator' then 'n.created_by'
      when 'notice' then 'n.id' when 'level' then 'n.level' end
    when src = 'social_leads' then case p_group
      when 'client' then 'k.client_id' when 'product' then 'k.product_id' when 'person' then person
      when 'stage' then case when metric = 'clients' then 'a.stage' end end
    when p_group = 'client' then 'k.client_id'
    when p_group = 'product' then 'k.product_id'
    when p_group = 'project' then 't.project_id'
    when p_group = 'team' then 't.team_id'
    when p_group = 'person' then person
    when p_group = 'creator' and on_task then 't.creator_id'
    when p_group = 'status' and src = 'tasks' then 't.status'
    when p_group = 'status' and src = 'status_history' then 'p.status'
    when p_group = 'priority' and on_task then 't.priority'
    when p_group = 'executor' and src = 'tasks' then executor
    when p_group = 'previous' and src = 'status_history' then 'p.previous_user_id'
    when p_group = 'validator' and src = 'reviews' then validator
  end;
  if src = 'hours' and (strpos(array_to_string(conds, ' ') || ' ' || coalesce(key, ''), 't.') > 0
   or strpos(array_to_string(conds, ' ') || ' ' || coalesce(key, ''), 'k.') > 0) then
    base := base || ' join public.tasks t on t.id = e.task_id';
  end if;
  if src = 'notices' and p_group = 'team' then
    base := base || ' join public.team_members tm on tm.company_id = r.company_id and tm.user_id = r.user_id';
  end if;
  if src = 'radar' and p_group = 'team' then
    base := base || ' join public.client_teams ctg on ctg.company_id = i.company_id and ctg.client_id = i.client_id';
  end if;
  if src = 'temperature' and p_group = 'team' then
    base := base || ' join public.client_teams ctg on ctg.company_id = d.company_id and ctg.client_id = d.client_id';
  end if;
  if src = 'temperature' and p_group = 'product' then
    base := base || ' join (select distinct x.company_id, x.client_id, x.product_id from public.contracts x'
     ' where not x.archived) kpg on kpg.company_id = d.company_id and kpg.client_id = d.client_id';
  end if;
  if src not in ('social_leads', 'notices', 'temperature', 'radar')
   and strpos(array_to_string(conds, ' ') || ' ' || coalesce(key, ''), 'k.') > 0 then
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
  label := case
    when src = 'radar' and p_group = 'product' then
     'coalesce((select x.name from public.products x where x.id = r.k), ''Geral / Agência'')'
    when src = 'radar' and p_group = 'person' then
     format('coalesce((select x.name from public.memberships x where x.company_id = %L and x.user_id = r.k), ''Sem responsável'')', c)
    when src = 'radar' and p_group = 'status' then 'case r.k::text when ''open'' then ''Aberto'''
     ' when ''progress'' then ''Em andamento'' when ''closed'' then ''Fechado'' else r.k::text end'
    when p_group = 'topic' then '(select x.name from public.radar_topics x where x.id = r.k)'
    when p_group = 'theme' then 'coalesce((select x.title from public.radar_themes x where x.id = r.k), ''Sem tema'')'
    when p_group = 'severity' then 'case r.k::text when ''0'' then ''Baixa'' when ''1'' then ''Média'''
     ' when ''2'' then ''Alta'' when ''3'' then ''Crítica'' else ''Sem gravidade'' end'
    when p_group = 'client' then '(select x.name from public.clients x where x.id = r.k)'
    when p_group = 'product' then '(select x.name from public.products x where x.id = r.k)'
    when p_group = 'project' then '(select x.name from public.projects x where x.id = r.k)'
    when p_group = 'team' then '(select x.name from public.teams x where x.id = r.k)'
    when p_group in ('person', 'creator', 'executor', 'previous', 'validator') then
      format('(select x.name from public.memberships x where x.company_id = %L and x.user_id = r.k)', c)
    when p_group = 'notice' then '(select x.title from public.notices x where x.id = r.k)'
    when p_group = 'level' then 'case r.k::text when ''info'' then ''Informativo'' when ''important'' then ''Importante'''
     ' when ''critical'' then ''Crítico'' else r.k::text end'
    when p_group = 'stage' then 'case r.k::text when ''briefing'' then ''Briefing'' when ''plan'' then ''Plano para revisar'''
     ' when ''approval'' then ''Aguardando o cliente'' when ''production'' then ''Aprovado / produção'''
     ' when ''campaign'' then ''Campanha no ar'' else r.k::text end'
    when p_group = 'band' then format('coalesce((%L::jsonb)->(r.k::integer)->>''name'', ''Sem nota'')', coalesce(bands, '[]'))
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

commit;
