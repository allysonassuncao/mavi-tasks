begin;

-- Alterações em massa na lista de tarefas e visões salvas por pessoa.
--
-- * bulk_update_tasks troca o responsável (uma pessoa ou "distribuir na
--   equipe"), o status ou o prazo (data fixa ou N dias úteis) de até 500
--   tarefas de uma vez. Cada tarefa passa pelas mesmas regras de hoje:
--   responsável e status por transition_task, prazo só por quem pode editar a
--   tarefa. A que não pode mudar fica de fora com o motivo, e as outras
--   seguem. Com p_preview o banco faz tudo e desfaz no fim: a revisão mostra
--   exatamente o que vai acontecer, inclusive quem a equipe vai receber.
-- * Mudar só o prazo não apaga aprovações nem muda o status (update_task
--   continua como está para a edição completa).
-- * undo_task_bulk desfaz um lote de quem o fez, nas tarefas que ninguém
--   mexeu depois.
-- * Um lote manda um aviso só no tópico da empresa, em vez de um por tarefa,
--   comentário e evento.
-- * task_views guarda as visões da lista de cada pessoa (só ela vê).

-- ------------------------------------------------------------ um aviso por lote
-- Com mavi.bulk_tasks ligado na transação, as tarefas e o que pende delas não
-- avisam uma a uma: o lote manda um aviso "tasks" no fim.
create or replace function mavi_private.broadcast_task() returns trigger
language plpgsql security definer set search_path = '' as $$
declare people uuid[]; begin
 if coalesce(current_setting('mavi.bulk_tasks', true), '') = '1' then return null; end if;
 if tg_op = 'UPDATE' and old is not distinct from new then return null; end if;
 people := case tg_op
  when 'INSERT' then mavi_private.task_people(new)
  when 'DELETE' then mavi_private.task_people(old)
  -- Before and after: whoever lost the task must hear about it too.
  else (select array_agg(distinct u) from unnest(
   mavi_private.task_people(old) || mavi_private.task_people(new)) u) end;
 perform mavi_private.broadcast(coalesce(new.company_id, old.company_id), jsonb_build_object(
  'kind', 'task', 'op', lower(tg_op), 'task', coalesce(new.id, old.id), 'users', to_jsonb(people)));
 return null;
end $$;
revoke all on function mavi_private.broadcast_task() from public, anon, authenticated;

create or replace function mavi_private.broadcast_task_child() returns trigger
language plpgsql security definer set search_path = '' as $$
declare r record; t public.tasks; people uuid[]; begin
 if coalesce(current_setting('mavi.bulk_tasks', true), '') = '1' then return null; end if;
 r := coalesce(new, old);
 select * into t from public.tasks where company_id = r.company_id and id = r.task_id;
 people := case when t.id is null then '{}' else mavi_private.task_people(t) end;
 if tg_table_name = 'time_entries' then people := people || r.user_id; end if;
 perform mavi_private.broadcast(r.company_id, jsonb_build_object(
  'kind', case when tg_table_name = 'time_entries' then 'hours' else 'extras' end,
  'op', lower(tg_op), 'task', r.task_id, 'users', to_jsonb(people)));
 return null;
end $$;
revoke all on function mavi_private.broadcast_task_child() from public, anon, authenticated;

-- O aviso do lote: as tarefas e todos os envolvidos, antes e depois.
create function mavi_private.broadcast_tasks(c uuid, p_tasks uuid[], p_people uuid[]) returns void
language plpgsql security definer set search_path = '' as $$ begin
 if coalesce(cardinality(p_tasks), 0) = 0 then return; end if;
 perform mavi_private.broadcast(c, jsonb_build_object('kind', 'tasks', 'op', 'update',
  'tasks', to_jsonb(p_tasks),
  'users', coalesce((select to_jsonb(array_agg(distinct u)) from unnest(p_people) u where u is not null), '[]')));
end $$;
revoke all on function mavi_private.broadcast_tasks(uuid, uuid[], uuid[]) from public, anon, authenticated;

-- ------------------------------------------------------------ dias úteis
-- N dias úteis depois (ou antes, com N negativo), pulando sábados e domingos.
create function mavi_private.add_business_days(d date, n integer) returns date
language plpgsql immutable set search_path = '' as $$
declare r date := d; step integer := case when n < 0 then -1 else 1 end; remaining integer := abs(n); begin
 while remaining > 0 loop
  r := r + step;
  if extract(isodow from r) < 6 then remaining := remaining - 1; end if;
 end loop;
 return r;
end $$;
revoke all on function mavi_private.add_business_days(date, integer) from public, anon, authenticated;

-- ------------------------------------------------------------ lotes
-- Cada lote aplicado e, por tarefa alterada, como ela estava antes (para
-- desfazer) e a versão em que ficou (só desfaz se ninguém mexeu depois).
create table public.task_bulk_operations (
 id uuid primary key default gen_random_uuid(),
 company_id uuid not null references public.companies(id) on delete cascade,
 actor_id uuid not null,
 change jsonb not null,
 created_at timestamptz not null default now(),
 undone_at timestamptz,
 foreign key(company_id, actor_id) references public.memberships(company_id, user_id)
);
create index task_bulk_operations_actor on public.task_bulk_operations(company_id, actor_id, created_at desc);
create table public.task_bulk_items (
 operation_id uuid not null references public.task_bulk_operations(id) on delete cascade,
 company_id uuid not null,
 task_id uuid not null,
 before jsonb not null,
 after_version integer not null,
 primary key(operation_id, task_id),
 foreign key(company_id, task_id) references public.tasks(company_id, id) on delete cascade
);
create index task_bulk_items_task on public.task_bulk_items(company_id, task_id);
alter table public.task_bulk_operations enable row level security;
alter table public.task_bulk_items enable row level security;
revoke all on public.task_bulk_operations, public.task_bulk_items from anon, authenticated;

-- ------------------------------------------------------------ aviso agrupado
-- Quem recebe tarefas num lote ganha um aviso só: "Ana passou 12 tarefas
-- para você", com o link da aba Para você.
alter table public.notifications drop constraint notifications_kind_check;
alter table public.notifications add constraint notifications_kind_check
 check (kind in ('mention', 'assigned', 'reply', 'social_leads', 'ai_share', 'success_case', 'notice',
  'notice_animation', 'temperature', 'tasks_assigned'));
alter table public.notifications drop constraint notifications_target_check;
alter table public.notifications add constraint notifications_target_check
 check ((kind in ('social_leads', 'ai_share', 'success_case', 'notice', 'notice_animation', 'temperature',
   'tasks_assigned')) = (task_id is null)
  and (task_id is not null or (title is not null and link is not null))
  and ((kind = 'notice') = (notice_id is not null)));

-- ------------------------------------------------------------ alteração em massa
-- p_change: {"kind":"assignee","value":<pessoa>} | {"kind":"team","value":<equipe>}
--  | {"kind":"status","value":<status>,"note":<texto>} | {"kind":"due","value":"AAAA-MM-DD"}
--  | {"kind":"shift","value":<dias úteis, negativo antecipa>}
-- Devolve {"preview","operation","applied","results":[{id,title,contract_id,
--  parent_id,ok,reason,before:{status,assignee_id,due_date},after:{…}}]}.
create function public.bulk_update_tasks(p_company uuid, p_tasks uuid[], p_change jsonb,
 p_preview boolean default false) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
 me uuid := auth.uid();
 kind text := p_change->>'kind';
 ids uuid[]; tid uuid;
 t public.tasks; changed public.tasks;
 v_person uuid; v_team uuid; v_status text; v_note text := coalesce(p_change->>'note', '');
 v_due date; v_shift integer; new_due date; pick uuid;
 label text; reason text;
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
 else raise exception 'Alteração inválida';
 end case;

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
      new_due := case kind when 'due' then v_due else mavi_private.add_business_days(t.due_date, v_shift) end;
      if new_due = t.due_date then reason := 'Já tem esse prazo';
      elsif t.start_date is not null and new_due < t.start_date then
       reason := 'O prazo ficaria antes do início (' || to_char(t.start_date, 'DD/MM') || ')';
      else
       update public.tasks set due_date = new_due, version = version + 1 where id = t.id;
       insert into public.task_events(company_id, task_id, actor_id, action, detail)
       values (p_company, t.id, me, 'due_changed', jsonb_build_object('old_due', t.due_date, 'new_due', new_due));
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
      'revision', t.revision, 'delivered_at', t.delivered_at));
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
revoke all on function public.bulk_update_tasks(uuid, uuid[], jsonb, boolean) from public, anon;
grant execute on function public.bulk_update_tasks(uuid, uuid[], jsonb, boolean) to authenticated;

-- Desfaz um lote (só quem o fez, até 24 horas depois). A tarefa que alguém
-- mexeu depois do lote fica como está e entra na contagem das mantidas.
create function public.undo_task_bulk(p_operation uuid) returns jsonb
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
   delivered_at = (b->>'delivered_at')::timestamptz, version = version + 1
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
revoke all on function public.undo_task_bulk(uuid) from public, anon;
grant execute on function public.undo_task_bulk(uuid) to authenticated;

-- ------------------------------------------------------------ visões da lista
-- O que a pessoa guardou da lista (agrupamento, filtros, visualização) com um
-- nome; uma delas pode abrir por padrão. Só a própria pessoa vê as suas.
create table public.task_views (
 id uuid primary key default gen_random_uuid(),
 company_id uuid not null references public.companies(id) on delete cascade,
 user_id uuid not null default auth.uid(),
 name text not null check (length(trim(name)) between 1 and 60),
 config jsonb not null default '{}' check (jsonb_typeof(config) = 'object'),
 is_default boolean not null default false,
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 foreign key(company_id, user_id) references public.memberships(company_id, user_id) on delete cascade
);
create unique index task_views_one_default on public.task_views(company_id, user_id) where is_default;
create index task_views_owner on public.task_views(company_id, user_id, name);
alter table public.task_views enable row level security;
create policy task_views_read on public.task_views for select to authenticated
 using (user_id = (select auth.uid()) and mavi_private.member(company_id));
grant select on public.task_views to authenticated;

create function public.save_task_view(p_company uuid, p_id uuid, p_name text, p_config jsonb,
 p_default boolean default false) returns public.task_views
language plpgsql security definer set search_path = '' as $$
declare v public.task_views; me uuid := auth.uid(); begin
 if me is null or not mavi_private.member(p_company) then
  raise exception 'Sem acesso à empresa' using errcode = '42501'; end if;
 if length(trim(coalesce(p_name, ''))) not between 1 and 60 then
  raise exception 'Dê um nome de até 60 caracteres à visão'; end if;
 if p_config is null or jsonb_typeof(p_config) <> 'object' or length(p_config::text) > 4000 then
  raise exception 'Visão inválida'; end if;
 if p_default then
  update public.task_views set is_default = false
   where company_id = p_company and user_id = me and is_default and id is distinct from p_id;
 end if;
 if p_id is null then
  if (select count(*) from public.task_views where company_id = p_company and user_id = me) >= 30 then
   raise exception 'Você pode guardar até 30 visões. Exclua uma para salvar outra.'; end if;
  insert into public.task_views(company_id, user_id, name, config, is_default)
  values (p_company, me, trim(p_name), p_config, coalesce(p_default, false)) returning * into v;
 else
  update public.task_views set name = trim(p_name), config = p_config, is_default = coalesce(p_default, false),
   updated_at = now()
  where id = p_id and company_id = p_company and user_id = me returning * into v;
  if not found then raise exception 'Visão não encontrada'; end if;
 end if;
 return v;
end $$;
revoke all on function public.save_task_view(uuid, uuid, text, jsonb, boolean) from public, anon;
grant execute on function public.save_task_view(uuid, uuid, text, jsonb, boolean) to authenticated;

create function public.delete_task_view(p_id uuid) returns void
language sql security definer set search_path = '' as $$
 delete from public.task_views where id = p_id and user_id = auth.uid()
$$;
revoke all on function public.delete_task_view(uuid) from public, anon;
grant execute on function public.delete_task_view(uuid) to authenticated;

commit;
