begin;

-- Editar tarefa: trocar o cliente (o produto contratado) da tarefa.
-- * p_contract null (ou o mesmo): nada muda — as chamadas de antes seguem iguais.
-- * Só em cliente aberto (produto e cliente não arquivados) que a pessoa pode
--   usar para criar tarefas (mavi_private.contract_access, como no create_task).
-- * Subtarefa segue a tarefa principal: não troca de cliente sozinha. A
--   principal leva as subtarefas junto, no mesmo comando (a chave
--   (company_id, contract_id, parent_id) é conferida no fim dele).
-- * Projeto: o escolhido no novo produto (p_project), ou nenhum; as
--   subtarefas vão para o mesmo projeto.
-- * Equipe: fica se atender o novo cliente; senão sai (a tarefa continua com
--   o responsável). Vale para as subtarefas.
-- * A repetição da tarefa (e das subtarefas) passa a abrir as cópias no novo cliente.
-- * Tarefa de post do Social Leads fica no cliente do plano.
-- * O histórico registra de qual para qual cliente/produto.

drop function public.update_task(uuid,integer,text,text,date,integer,text,date,boolean,text,boolean,text);
create function public.update_task(p_task uuid,p_version integer,p_title text,p_description text,p_due date,p_estimated integer,p_priority text,p_start date default null,
 p_due_manual boolean default null, p_due_reason text default null, p_due_smart boolean default null,
 p_due_effort text default null, p_contract uuid default null, p_project uuid default null) returns public.tasks
language plpgsql security definer set search_path = '' as $$
declare t public.tasks; ch record; smart jsonb; moved boolean; old_k record; new_k record; move_detail jsonb := '{}'; begin
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
 return t;
end $$;
revoke all on function public.update_task(uuid,integer,text,text,date,integer,text,date,boolean,text,boolean,text,uuid,uuid) from public, anon;
grant execute on function public.update_task(uuid,integer,text,text,date,integer,text,date,boolean,text,boolean,text,uuid,uuid) to authenticated;

commit;
