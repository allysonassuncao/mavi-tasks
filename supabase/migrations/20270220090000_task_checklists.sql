-- Checklist nas tarefas (painel lateral "Checklist" nos detalhes).
--
-- Cada tarefa tem quantos checklists quiser, cada um com nome; os itens têm
-- um nível de subitens. Um checklist fica concluído quando todos os itens
-- estão marcados (ou pelo "Concluir checklist", que marca o que falta); um
-- item com subitens fica marcado quando todos os subitens estão. Tudo o que
-- acontece fica em task_checklist_log, que não se apaga com o histórico de
-- 1 mês; o Histórico da tarefa mostra o principal (marcar, desmarcar,
-- concluir, excluir) e o painel mostra o registro inteiro.
--
-- Quem vê a tarefa cria checklists, adiciona itens e marca. Renomear e
-- excluir é de quem criou aquilo, do criador da tarefa, de gestores e
-- administradores. "Só entregar com o checklist concluído"
-- (tasks.checklist_required) é escolhido na Nova tarefa, em "Adicionar
-- detalhes", e depois no painel por quem edita a tarefa: com ele ligado, a
-- tarefa não vai para Em validação nem Entregue com item em aberto, por
-- nenhum caminho (gatilho em tasks).
--
-- Modelos de checklist (checklist_templates): administradores e gestores
-- montam em Equipe e configurações › Templates de tarefa; qualquer pessoa
-- aplica na tarefa. Um modelo pode ser sugerido para um produto e/ou uma
-- equipe: a Nova tarefa já vem com ele marcado. A repetição de tarefas copia
-- os checklists da tarefa original, sem as marcações.
begin;

alter table public.tasks add column checklist_required boolean not null default false;

-- ------------------------------------------------------------ tabelas
create table public.task_checklists (
 id uuid primary key default gen_random_uuid(),
 company_id uuid not null,
 task_id uuid not null,
 title text not null check (length(btrim(title)) between 1 and 120),
 position integer not null default 0,
 -- O modelo de onde veio (só informação: o modelo pode sair depois).
 template_id uuid,
 created_by uuid not null,
 created_at timestamptz not null default now(),
 completed_by uuid,
 completed_at timestamptz,
 unique (company_id, id),
 foreign key (company_id, task_id) references public.tasks(company_id, id) on delete cascade
);
create index task_checklists_task on public.task_checklists(company_id, task_id, position);

create table public.task_checklist_items (
 id uuid primary key default gen_random_uuid(),
 company_id uuid not null,
 task_id uuid not null,
 checklist_id uuid not null,
 -- Um nível só: o pai é sempre um item sem pai (conferido nas funções).
 parent_id uuid,
 title text not null check (length(btrim(title)) between 1 and 500),
 position integer not null default 0,
 done boolean not null default false,
 done_by uuid,
 done_at timestamptz,
 created_by uuid not null,
 created_at timestamptz not null default now(),
 unique (company_id, id),
 foreign key (company_id, checklist_id) references public.task_checklists(company_id, id) on delete cascade,
 foreign key (company_id, parent_id) references public.task_checklist_items(company_id, id) on delete cascade
);
create index task_checklist_items_list on public.task_checklist_items(company_id, checklist_id, position);
create index task_checklist_items_open on public.task_checklist_items(company_id, task_id) where not done;

create table public.task_checklist_log (
 id uuid primary key default gen_random_uuid(),
 company_id uuid not null,
 task_id uuid not null,
 actor_id uuid not null,
 -- checklist_added · checklist_renamed · checklist_deleted · checklist_completed
 -- checklist_reopened · item_added · item_edited · item_deleted · item_checked
 -- item_unchecked · required_on · required_off
 action text not null,
 detail jsonb not null default '{}',
 created_at timestamptz not null default now(),
 foreign key (company_id, task_id) references public.tasks(company_id, id) on delete cascade
);
create index task_checklist_log_task on public.task_checklist_log(task_id, created_at desc);

create table public.checklist_templates (
 id uuid primary key default gen_random_uuid(),
 company_id uuid not null references public.companies(id),
 name text not null check (length(btrim(name)) between 2 and 80),
 -- [{ "title": "…", "children": [{ "title": "…" }] }]
 items jsonb not null default '[]',
 -- Sugerido na Nova tarefa deste produto e/ou desta equipe (sem os dois:
 -- só aplicado à mão).
 product_id uuid,
 team_id uuid,
 active boolean not null default true,
 created_by uuid not null default auth.uid(),
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 unique (company_id, id),
 foreign key (company_id, product_id) references public.products(company_id, id),
 foreign key (company_id, team_id) references public.teams(company_id, id)
);
create index checklist_templates_company on public.checklist_templates(company_id) where active;

-- Leitura: quem vê a tarefa vê os checklists e o registro dela (task_extras é
-- security invoker); os modelos, todo membro. Escrita só pelas funções.
alter table public.task_checklists enable row level security;
alter table public.task_checklist_items enable row level security;
alter table public.task_checklist_log enable row level security;
alter table public.checklist_templates enable row level security;
revoke all on public.task_checklists, public.task_checklist_items, public.task_checklist_log,
 public.checklist_templates from public, anon, authenticated;
grant select on public.task_checklists, public.task_checklist_items, public.task_checklist_log,
 public.checklist_templates to authenticated;
create policy task_checklists_read on public.task_checklists for select to authenticated
 using (mavi_private.task_access(company_id, task_id));
create policy task_checklist_items_read on public.task_checklist_items for select to authenticated
 using (mavi_private.task_access(company_id, task_id));
create policy task_checklist_log_read on public.task_checklist_log for select to authenticated
 using (mavi_private.task_access(company_id, task_id));
create policy checklist_templates_read on public.checklist_templates for select to authenticated
 using (mavi_private.member(company_id));

-- Os apps abertos recarregam os catálogos (e os modelos) quando um muda.
create trigger broadcast_lookup after insert or update or delete on public.checklist_templates
 for each row execute function mavi_private.broadcast_lookup();

-- ------------------------------------------------------------ apoio
-- A tarefa para mexer no checklist: quem a vê, sem estar arquivada.
create function mavi_private.checklist_task(p_task uuid) returns public.tasks
language plpgsql stable security definer set search_path = '' as $$
declare t public.tasks; begin
 select * into t from public.tasks where id = p_task;
 if not found or t.archived or not mavi_private.task_access(t.company_id, t.id) then
  raise exception 'Sem acesso à tarefa' using errcode = '42501';
 end if;
 return t;
end $$;

-- Quem renomeia e exclui o que outra pessoa criou, e liga a exigência.
create function mavi_private.checklist_manager(t public.tasks) returns boolean
language sql stable security definer set search_path = '' as $$
 select mavi_private.leader(t.company_id) or auth.uid() = t.creator_id
$$;

-- Os checklists da tarefa, com os itens (o painel monta a árvore). Security
-- invoker: em task_extras vale a leitura de quem pede.
create function mavi_private.task_checklists_json(c uuid, p_task uuid) returns jsonb
language sql stable security invoker set search_path = '' as $$
 select coalesce(jsonb_agg(jsonb_build_object(
   'id', l.id, 'task_id', l.task_id, 'title', l.title, 'position', l.position,
   'template_id', l.template_id, 'created_by', l.created_by, 'created_at', l.created_at,
   'completed_by', l.completed_by, 'completed_at', l.completed_at,
   'items', (select coalesce(jsonb_agg(jsonb_build_object(
      'id', i.id, 'parent_id', i.parent_id, 'title', i.title, 'position', i.position,
      'done', i.done, 'done_by', i.done_by, 'done_at', i.done_at,
      'created_by', i.created_by, 'created_at', i.created_at)
     order by i.position, i.created_at, i.id), '[]'::jsonb)
    from public.task_checklist_items i where i.company_id = c and i.checklist_id = l.id))
  order by l.position, l.created_at, l.id), '[]'::jsonb)
 from public.task_checklists l where l.company_id = c and l.task_id = p_task
$$;

create function mavi_private.checklist_log(t public.tasks, p_action text, p_detail jsonb) returns void
language sql security definer set search_path = '' as $$
 insert into public.task_checklist_log(company_id, task_id, actor_id, action, detail)
 values (t.company_id, t.id, coalesce(auth.uid(), t.creator_id), p_action, p_detail)
$$;

-- Um aviso ao vivo por ação (a tarefa aberta recarrega os extras).
create function mavi_private.checklist_notice(t public.tasks) returns void
language sql security definer set search_path = '' as $$
 select mavi_private.broadcast(t.company_id, jsonb_build_object(
  'kind', 'extras', 'op', 'update', 'task', t.id, 'users', to_jsonb(mavi_private.task_people(t))))
$$;

-- Itens no formato dos modelos: até 300 no total, título de 1 a 500
-- caracteres, subitens só no primeiro nível.
create function mavi_private.checklist_items_valid(p_items jsonb) returns boolean
language plpgsql immutable set search_path = '' as $$
declare it jsonb; ch jsonb; total integer := 0; begin
 if p_items is null or jsonb_typeof(p_items) <> 'array' then return false; end if;
 for it in select value from jsonb_array_elements(p_items) loop
  if jsonb_typeof(it) <> 'object' or jsonb_typeof(it->'title') <> 'string'
   or length(btrim(it->>'title')) not between 1 and 500 then return false; end if;
  total := total + 1;
  if it ? 'children' and jsonb_typeof(it->'children') <> 'null' then
   if jsonb_typeof(it->'children') <> 'array' then return false; end if;
   for ch in select value from jsonb_array_elements(it->'children') loop
    if jsonb_typeof(ch) <> 'object' or jsonb_typeof(ch->'title') <> 'string'
     or length(btrim(ch->>'title')) not between 1 and 500 then return false; end if;
    total := total + 1;
   end loop;
  end if;
 end loop;
 return total <= 300;
end $$;

-- Cria um checklist com os itens (de um modelo, da Nova tarefa ou do painel).
create function mavi_private.insert_checklist(t public.tasks, p_title text, p_items jsonb, p_template uuid,
 p_by uuid) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_id uuid; v_parent uuid; it jsonb; ch jsonb; n integer := 0; m integer; begin
 if (select count(*) from public.task_checklists where company_id = t.company_id and task_id = t.id) >= 30 then
  raise exception 'Uma tarefa pode ter até 30 checklists.' using errcode = '22023';
 end if;
 if length(btrim(coalesce(p_title, ''))) not between 1 and 120 then
  raise exception 'Dê um nome ao checklist (até 120 caracteres).' using errcode = '22023';
 end if;
 if not mavi_private.checklist_items_valid(coalesce(p_items, '[]')) then
  raise exception 'Revise os itens: cada um precisa de um texto de até 500 caracteres (no máximo 300 itens).'
   using errcode = '22023';
 end if;
 insert into public.task_checklists(company_id, task_id, title, position, template_id, created_by)
 values (t.company_id, t.id, btrim(p_title),
  coalesce((select max(position) + 1 from public.task_checklists where company_id = t.company_id and task_id = t.id), 0),
  p_template, p_by)
 returning id into v_id;
 for it in select value from jsonb_array_elements(coalesce(p_items, '[]')) loop
  insert into public.task_checklist_items(company_id, task_id, checklist_id, title, position, created_by)
  values (t.company_id, t.id, v_id, btrim(it->>'title'), n, p_by) returning id into v_parent;
  n := n + 1;
  m := 0;
  if jsonb_typeof(it->'children') = 'array' then
   for ch in select value from jsonb_array_elements(it->'children') loop
    insert into public.task_checklist_items(company_id, task_id, checklist_id, parent_id, title, position, created_by)
    values (t.company_id, t.id, v_id, v_parent, btrim(ch->>'title'), m, p_by);
    m := m + 1;
   end loop;
  end if;
 end loop;
 return v_id;
end $$;

-- Depois de cada mudança: o item com subitens acompanha os subitens, e o
-- checklist fica concluído (ou volta a abrir) conforme os itens.
create function mavi_private.settle_checklist(t public.tasks, p_checklist uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare l public.task_checklists; total integer; open integer; me uuid := coalesce(auth.uid(), t.creator_id); begin
 update public.task_checklist_items p set done = s.all_done,
  done_by = case when s.all_done then me end, done_at = case when s.all_done then now() end
 from (select parent_id, bool_and(done) as all_done from public.task_checklist_items
   where company_id = t.company_id and checklist_id = p_checklist and parent_id is not null group by parent_id) s
 where p.company_id = t.company_id and p.id = s.parent_id and p.done <> s.all_done;
 select * into l from public.task_checklists where company_id = t.company_id and id = p_checklist;
 select count(*), count(*) filter (where not done) into total, open
 from public.task_checklist_items where company_id = t.company_id and checklist_id = p_checklist;
 if total > 0 and open = 0 and l.completed_at is null then
  update public.task_checklists set completed_by = me, completed_at = now() where id = l.id;
  perform mavi_private.checklist_log(t, 'checklist_completed', jsonb_build_object('checklist', l.id, 'title', l.title));
 elsif (total = 0 or open > 0) and l.completed_at is not null then
  update public.task_checklists set completed_by = null, completed_at = null where id = l.id;
  perform mavi_private.checklist_log(t, 'checklist_reopened', jsonb_build_object('checklist', l.id, 'title', l.title));
 end if;
end $$;

-- Itens em aberto da tarefa (o que trava a entrega).
create function mavi_private.open_checklist_items(c uuid, p_task uuid) returns integer
language sql stable security definer set search_path = '' as $$
 select count(*)::integer from public.task_checklist_items where company_id = c and task_id = p_task and not done
$$;

revoke all on function mavi_private.task_checklists_json(uuid, uuid) from public, anon;
grant execute on function mavi_private.task_checklists_json(uuid, uuid) to authenticated;
revoke all on function mavi_private.checklist_task(uuid), mavi_private.checklist_manager(public.tasks),
 mavi_private.checklist_log(public.tasks, text, jsonb),
 mavi_private.checklist_notice(public.tasks), mavi_private.checklist_items_valid(jsonb),
 mavi_private.insert_checklist(public.tasks, text, jsonb, uuid, uuid),
 mavi_private.settle_checklist(public.tasks, uuid), mavi_private.open_checklist_items(uuid, uuid)
 from public, anon, authenticated;

-- ------------------------------------------------------------ checklists
create function public.add_task_checklist(p_task uuid, p_title text, p_items jsonb default '[]') returns jsonb
language plpgsql security definer set search_path = '' as $$
declare t public.tasks := mavi_private.checklist_task(p_task); v_id uuid; begin
 perform 1 from public.tasks where id = t.id for update;
 v_id := mavi_private.insert_checklist(t, p_title, p_items, null, auth.uid());
 perform mavi_private.checklist_log(t, 'checklist_added', jsonb_build_object('checklist', v_id, 'title', btrim(p_title)));
 perform mavi_private.checklist_notice(t);
 return mavi_private.task_checklists_json(t.company_id, t.id);
end $$;

-- Modelos na tarefa (painel ou Nova tarefa) e, junto, a exigência para entregar.
create function public.apply_checklist_templates(p_task uuid, p_templates uuid[], p_required boolean default null)
 returns jsonb
language plpgsql security definer set search_path = '' as $$
declare t public.tasks := mavi_private.checklist_task(p_task); tpl public.checklist_templates; v_id uuid; begin
 perform 1 from public.tasks where id = t.id for update;
 for tpl in select x.* from unnest(coalesce(p_templates, '{}')) with ordinality u(id, n)
   join public.checklist_templates x on x.company_id = t.company_id and x.id = u.id order by u.n loop
  v_id := mavi_private.insert_checklist(t, tpl.name, tpl.items, tpl.id, auth.uid());
  perform mavi_private.checklist_log(t, 'checklist_added',
   jsonb_build_object('checklist', v_id, 'title', tpl.name, 'template', tpl.name));
 end loop;
 if cardinality(coalesce(p_templates, '{}')) > 0 and v_id is null then
  raise exception 'Modelo de checklist não encontrado' using errcode = '22023';
 end if;
 if p_required is not null and p_required <> t.checklist_required then
  if not mavi_private.checklist_manager(t) then
   raise exception 'Só quem edita a tarefa muda a exigência do checklist' using errcode = '42501';
  end if;
  update public.tasks set checklist_required = p_required, version = version + 1 where id = t.id;
  perform mavi_private.checklist_log(t, case when p_required then 'required_on' else 'required_off' end, '{}');
 end if;
 perform mavi_private.checklist_notice(t);
 return mavi_private.task_checklists_json(t.company_id, t.id);
end $$;

create function public.rename_task_checklist(p_checklist uuid, p_title text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare l public.task_checklists; t public.tasks; begin
 select * into l from public.task_checklists where id = p_checklist for update;
 if not found then raise exception 'Checklist não encontrado' using errcode = '42501'; end if;
 t := mavi_private.checklist_task(l.task_id);
 if not (l.created_by = auth.uid() or mavi_private.checklist_manager(t)) then
  raise exception 'Só quem criou o checklist, o criador da tarefa ou um gestor o renomeia' using errcode = '42501';
 end if;
 if length(btrim(coalesce(p_title, ''))) not between 1 and 120 then
  raise exception 'Dê um nome ao checklist (até 120 caracteres).' using errcode = '22023';
 end if;
 if btrim(p_title) <> l.title then
  update public.task_checklists set title = btrim(p_title) where id = l.id;
  perform mavi_private.checklist_log(t, 'checklist_renamed',
   jsonb_build_object('checklist', l.id, 'from', l.title, 'title', btrim(p_title)));
  perform mavi_private.checklist_notice(t);
 end if;
 return mavi_private.task_checklists_json(t.company_id, t.id);
end $$;

create function public.delete_task_checklist(p_checklist uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare l public.task_checklists; t public.tasks; n integer; begin
 select * into l from public.task_checklists where id = p_checklist for update;
 if not found then raise exception 'Checklist não encontrado' using errcode = '42501'; end if;
 t := mavi_private.checklist_task(l.task_id);
 if not (l.created_by = auth.uid() or mavi_private.checklist_manager(t)) then
  raise exception 'Só quem criou o checklist, o criador da tarefa ou um gestor o exclui' using errcode = '42501';
 end if;
 select count(*) into n from public.task_checklist_items where company_id = l.company_id and checklist_id = l.id;
 delete from public.task_checklists where id = l.id;
 perform mavi_private.checklist_log(t, 'checklist_deleted',
  jsonb_build_object('checklist', l.id, 'title', l.title, 'items', n));
 perform mavi_private.checklist_notice(t);
 return mavi_private.task_checklists_json(t.company_id, t.id);
end $$;

-- "Concluir checklist": marca tudo o que falta de uma vez.
create function public.complete_task_checklist(p_checklist uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare l public.task_checklists; t public.tasks; n integer; begin
 select * into l from public.task_checklists where id = p_checklist for update;
 if not found then raise exception 'Checklist não encontrado' using errcode = '42501'; end if;
 t := mavi_private.checklist_task(l.task_id);
 update public.task_checklist_items set done = true, done_by = auth.uid(), done_at = now()
 where company_id = l.company_id and checklist_id = l.id and not done;
 get diagnostics n = row_count;
 if n = 0 and not exists (select 1 from public.task_checklist_items where company_id = l.company_id and checklist_id = l.id) then
  raise exception 'Adicione itens ao checklist antes de concluir.' using errcode = '22023';
 end if;
 perform mavi_private.settle_checklist(t, l.id);
 perform mavi_private.checklist_notice(t);
 return mavi_private.task_checklists_json(t.company_id, t.id);
end $$;

create function public.reorder_task_checklists(p_task uuid, p_ids uuid[]) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare t public.tasks := mavi_private.checklist_task(p_task); begin
 update public.task_checklists l set position = u.n - 1
 from unnest(p_ids) with ordinality u(id, n)
 where l.company_id = t.company_id and l.task_id = t.id and l.id = u.id;
 perform mavi_private.checklist_notice(t);
 return mavi_private.task_checklists_json(t.company_id, t.id);
end $$;

-- ------------------------------------------------------------ itens
create function public.add_checklist_item(p_checklist uuid, p_title text, p_parent uuid default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare l public.task_checklists; t public.tasks; parent public.task_checklist_items; begin
 select * into l from public.task_checklists where id = p_checklist for update;
 if not found then raise exception 'Checklist não encontrado' using errcode = '42501'; end if;
 t := mavi_private.checklist_task(l.task_id);
 if length(btrim(coalesce(p_title, ''))) not between 1 and 500 then
  raise exception 'Escreva o item (até 500 caracteres).' using errcode = '22023';
 end if;
 if (select count(*) from public.task_checklist_items where company_id = l.company_id and checklist_id = l.id) >= 300 then
  raise exception 'Um checklist pode ter até 300 itens.' using errcode = '22023';
 end if;
 if p_parent is not null then
  select * into parent from public.task_checklist_items where company_id = l.company_id and id = p_parent;
  if not found or parent.checklist_id <> l.id then raise exception 'Item não encontrado' using errcode = '22023'; end if;
  if parent.parent_id is not null then
   raise exception 'Subitens não têm outros subitens.' using errcode = '22023';
  end if;
 end if;
 insert into public.task_checklist_items(company_id, task_id, checklist_id, parent_id, title, position, created_by)
 values (l.company_id, l.task_id, l.id, p_parent, btrim(p_title),
  coalesce((select max(position) + 1 from public.task_checklist_items where company_id = l.company_id
    and checklist_id = l.id and parent_id is not distinct from p_parent), 0), auth.uid());
 perform mavi_private.checklist_log(t, 'item_added', jsonb_build_object('checklist', l.id, 'list', l.title,
  'title', btrim(p_title), 'parent', parent.title));
 perform mavi_private.settle_checklist(t, l.id);
 perform mavi_private.checklist_notice(t);
 return mavi_private.task_checklists_json(t.company_id, t.id);
end $$;

create function public.edit_checklist_item(p_item uuid, p_title text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare i public.task_checklist_items; l public.task_checklists; t public.tasks; begin
 select * into i from public.task_checklist_items where id = p_item;
 if not found then raise exception 'Item não encontrado' using errcode = '42501'; end if;
 select * into l from public.task_checklists where company_id = i.company_id and id = i.checklist_id for update;
 t := mavi_private.checklist_task(i.task_id);
 if not (i.created_by = auth.uid() or mavi_private.checklist_manager(t)) then
  raise exception 'Só quem criou o item, o criador da tarefa ou um gestor o altera' using errcode = '42501';
 end if;
 if length(btrim(coalesce(p_title, ''))) not between 1 and 500 then
  raise exception 'Escreva o item (até 500 caracteres).' using errcode = '22023';
 end if;
 if btrim(p_title) <> i.title then
  update public.task_checklist_items set title = btrim(p_title) where id = i.id;
  perform mavi_private.checklist_log(t, 'item_edited', jsonb_build_object('checklist', l.id, 'list', l.title,
   'from', i.title, 'title', btrim(p_title)));
  perform mavi_private.checklist_notice(t);
 end if;
 return mavi_private.task_checklists_json(t.company_id, t.id);
end $$;

create function public.delete_checklist_item(p_item uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare i public.task_checklist_items; l public.task_checklists; t public.tasks; n integer; begin
 select * into i from public.task_checklist_items where id = p_item;
 if not found then raise exception 'Item não encontrado' using errcode = '42501'; end if;
 select * into l from public.task_checklists where company_id = i.company_id and id = i.checklist_id for update;
 t := mavi_private.checklist_task(i.task_id);
 if not (i.created_by = auth.uid() or mavi_private.checklist_manager(t)) then
  raise exception 'Só quem criou o item, o criador da tarefa ou um gestor o exclui' using errcode = '42501';
 end if;
 select count(*) into n from public.task_checklist_items where company_id = i.company_id and parent_id = i.id;
 delete from public.task_checklist_items where id = i.id;
 perform mavi_private.checklist_log(t, 'item_deleted', jsonb_build_object('checklist', l.id, 'list', l.title,
  'title', i.title, 'subitems', n, 'was_done', i.done));
 perform mavi_private.settle_checklist(t, l.id);
 perform mavi_private.checklist_notice(t);
 return mavi_private.task_checklists_json(t.company_id, t.id);
end $$;

-- Marcar ou desmarcar. Um item com subitens leva os subitens junto.
create function public.set_checklist_item_done(p_item uuid, p_done boolean) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare i public.task_checklist_items; l public.task_checklists; t public.tasks; n integer := 0; begin
 select * into i from public.task_checklist_items where id = p_item;
 if not found then raise exception 'Item não encontrado' using errcode = '42501'; end if;
 select * into l from public.task_checklists where company_id = i.company_id and id = i.checklist_id for update;
 t := mavi_private.checklist_task(i.task_id);
 select * into i from public.task_checklist_items where id = p_item;
 if i.done = coalesce(p_done, false) and not exists (select 1 from public.task_checklist_items
   where company_id = i.company_id and parent_id = i.id and done <> coalesce(p_done, false)) then
  return mavi_private.task_checklists_json(t.company_id, t.id);
 end if;
 update public.task_checklist_items set done = coalesce(p_done, false),
  done_by = case when p_done then auth.uid() end, done_at = case when p_done then now() end
 where company_id = i.company_id and (id = i.id or parent_id = i.id) and done <> coalesce(p_done, false);
 select count(*) into n from public.task_checklist_items where company_id = i.company_id and parent_id = i.id;
 perform mavi_private.checklist_log(t, case when p_done then 'item_checked' else 'item_unchecked' end,
  jsonb_build_object('checklist', l.id, 'list', l.title, 'title', i.title, 'subitems', n));
 perform mavi_private.settle_checklist(t, l.id);
 perform mavi_private.checklist_notice(t);
 return mavi_private.task_checklists_json(t.company_id, t.id);
end $$;

-- A ordem de um nível (os itens de um checklist, ou os subitens de um item).
create function public.reorder_checklist_items(p_checklist uuid, p_parent uuid, p_ids uuid[]) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare l public.task_checklists; t public.tasks; begin
 select * into l from public.task_checklists where id = p_checklist for update;
 if not found then raise exception 'Checklist não encontrado' using errcode = '42501'; end if;
 t := mavi_private.checklist_task(l.task_id);
 update public.task_checklist_items i set position = u.n - 1
 from unnest(p_ids) with ordinality u(id, n)
 where i.company_id = l.company_id and i.checklist_id = l.id and i.parent_id is not distinct from p_parent
  and i.id = u.id;
 perform mavi_private.checklist_notice(t);
 return mavi_private.task_checklists_json(t.company_id, t.id);
end $$;

-- Devolve a linha da tarefa (a versão muda), como as outras edições dela.
create function public.set_task_checklist_required(p_task uuid, p_required boolean) returns public.tasks
language plpgsql security definer set search_path = '' as $$
declare t public.tasks := mavi_private.checklist_task(p_task); begin
 perform public.apply_checklist_templates(t.id, '{}', coalesce(p_required, false));
 select * into t from public.tasks where id = t.id;
 return t;
end $$;

-- O registro inteiro do checklist da tarefa (o painel mostra sob "Registro").
create function public.task_checklist_history(p_task uuid) returns setof public.task_checklist_log
language sql stable security invoker set search_path = '' as $$
 select * from public.task_checklist_log where task_id = p_task order by created_at desc, id desc limit 500
$$;

do $$ declare f text; begin
 foreach f in array array[
  'add_task_checklist(uuid, text, jsonb)', 'apply_checklist_templates(uuid, uuid[], boolean)',
  'rename_task_checklist(uuid, text)', 'delete_task_checklist(uuid)', 'complete_task_checklist(uuid)',
  'reorder_task_checklists(uuid, uuid[])', 'add_checklist_item(uuid, text, uuid)',
  'edit_checklist_item(uuid, text)', 'delete_checklist_item(uuid)', 'set_checklist_item_done(uuid, boolean)',
  'reorder_checklist_items(uuid, uuid, uuid[])', 'set_task_checklist_required(uuid, boolean)',
  'task_checklist_history(uuid)'] loop
  execute format('revoke all on function public.%s from public, anon', f);
  execute format('grant execute on function public.%s to authenticated', f);
 end loop;
end $$;

-- ------------------------------------------------------------ modelos
create function public.save_checklist_template(p_company uuid, p_id uuid, p_name text, p_items jsonb,
 p_product uuid default null, p_team uuid default null, p_active boolean default true) returns uuid
language plpgsql security definer set search_path = '' as $$ declare result uuid; begin
 if not mavi_private.leader(p_company) then
  raise exception 'Somente administradores e gestores configuram modelos de checklist' using errcode = '42501';
 end if;
 if length(btrim(coalesce(p_name, ''))) not between 2 and 80 then
  raise exception 'Dê um nome ao modelo (de 2 a 80 caracteres).' using errcode = '22023';
 end if;
 if not mavi_private.checklist_items_valid(p_items) or jsonb_array_length(p_items) = 0 then
  raise exception 'Adicione ao menos um item (cada um com até 500 caracteres; no máximo 300).' using errcode = '22023';
 end if;
 if p_id is null then
  insert into public.checklist_templates(company_id, name, items, product_id, team_id, active)
  values (p_company, btrim(p_name), p_items, p_product, p_team, coalesce(p_active, true)) returning id into result;
 else
  update public.checklist_templates set name = btrim(p_name), items = p_items, product_id = p_product,
   team_id = p_team, active = coalesce(p_active, true), updated_at = now()
  where company_id = p_company and id = p_id returning id into result;
  if result is null then raise exception 'Modelo não encontrado'; end if;
 end if;
 return result;
end $$;

-- As tarefas guardam a cópia dos itens: o modelo pode sair a qualquer hora.
create function public.delete_checklist_template(p_template uuid) returns void
language plpgsql security definer set search_path = '' as $$ declare c uuid; begin
 select company_id into c from public.checklist_templates where id = p_template;
 if c is null or not mavi_private.leader(c) then raise exception 'Sem permissão' using errcode = '42501'; end if;
 delete from public.checklist_templates where id = p_template;
end $$;
revoke all on function public.save_checklist_template(uuid, uuid, text, jsonb, uuid, uuid, boolean),
 public.delete_checklist_template(uuid) from public, anon;
grant execute on function public.save_checklist_template(uuid, uuid, text, jsonb, uuid, uuid, boolean),
 public.delete_checklist_template(uuid) to authenticated;

-- ------------------------------------------------------------ entrega
-- Com a exigência ligada, nada leva a tarefa a Em validação ou Entregue com
-- item em aberto (mudança de status, em massa, aprovação, MAVI, API).
create function mavi_private.checklist_gate() returns trigger
language plpgsql security definer set search_path = '' as $$
declare n integer; begin
 if new.checklist_required and new.status in ('review', 'done') and new.status is distinct from old.status then
  n := mavi_private.open_checklist_items(new.company_id, new.id);
  if n > 0 then
   raise exception 'Conclua o checklist antes de entregar: % em aberto.',
    case when n = 1 then '1 item' else n || ' itens' end using errcode = '23514';
  end if;
 end if;
 return new;
end $$;
revoke all on function mavi_private.checklist_gate() from public, anon, authenticated;
create trigger checklist_gate before update of status on public.tasks
 for each row execute function mavi_private.checklist_gate();

-- ------------------------------------------------------------ repetição
-- A cópia aberta pela repetição leva os checklists da tarefa original (sem
-- marcações) e a exigência.
create function mavi_private.checklist_copy_required() returns trigger
language plpgsql security definer set search_path = '' as $$ begin
 if new.recurrence_id is not null then
  select s.checklist_required into new.checklist_required
  from public.task_recurrences r join public.tasks s on s.company_id = r.company_id and s.id = r.source_task_id
  where r.company_id = new.company_id and r.id = new.recurrence_id and s.id <> new.id;
  new.checklist_required := coalesce(new.checklist_required, false);
 end if;
 return new;
end $$;
create function mavi_private.checklist_copy() returns trigger
language plpgsql security definer set search_path = '' as $$
declare src uuid; l public.task_checklists; v_list uuid; it public.task_checklist_items; v_item uuid; begin
 select r.source_task_id into src from public.task_recurrences r
 where r.company_id = new.company_id and r.id = new.recurrence_id;
 if src is null or src = new.id then return null; end if;
 for l in select * from public.task_checklists where company_id = new.company_id and task_id = src
   order by position, created_at, id loop
  insert into public.task_checklists(company_id, task_id, title, position, template_id, created_by)
  values (new.company_id, new.id, l.title, l.position, l.template_id, new.creator_id) returning id into v_list;
  for it in select * from public.task_checklist_items where company_id = new.company_id and checklist_id = l.id
    and parent_id is null order by position, created_at, id loop
   insert into public.task_checklist_items(company_id, task_id, checklist_id, title, position, created_by)
   values (new.company_id, new.id, v_list, it.title, it.position, new.creator_id) returning id into v_item;
   insert into public.task_checklist_items(company_id, task_id, checklist_id, parent_id, title, position, created_by)
   select new.company_id, new.id, v_list, v_item, c.title, c.position, new.creator_id
   from public.task_checklist_items c where c.company_id = new.company_id and c.parent_id = it.id
   order by c.position, c.created_at, c.id;
  end loop;
 end loop;
 return null;
end $$;
revoke all on function mavi_private.checklist_copy_required(), mavi_private.checklist_copy()
 from public, anon, authenticated;
create trigger checklist_copy_required before insert on public.tasks
 for each row when (new.recurrence_id is not null) execute function mavi_private.checklist_copy_required();
create trigger checklist_copy after insert on public.tasks
 for each row when (new.recurrence_id is not null) execute function mavi_private.checklist_copy();

-- ------------------------------------------------------------ detalhes
-- A da migração 20270110090000 com os checklists e, no histórico, o
-- principal do registro do checklist (até 50 linhas, à parte das 100).
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
   (select * from (select * from (select e.id, e.company_id, e.task_id, e.actor_id, e.action, e.detail, e.created_at
     from public.task_events e where e.company_id=c and e.task_id=p_task
    union all
    select x.id, x.company_id, x.task_id, x.changed_by, 'due_changed',
     jsonb_build_object('old_due', x.old_due, 'new_due', x.new_due, 'reason', x.reason, 'source', x.source), x.created_at
     from public.task_due_changes x where x.company_id=c and x.task_id=p_task
      and not exists (select 1 from public.task_events e where e.id = x.id)) u
    order by created_at desc,id desc limit 100) a
    union all
    select * from (select k.id, k.company_id, k.task_id, k.actor_id, 'checklist', k.detail || jsonb_build_object('kind', k.action),
      k.created_at from public.task_checklist_log k where k.company_id=c and k.task_id=p_task
      and k.action in ('checklist_added','checklist_deleted','checklist_completed','checklist_reopened',
       'item_checked','item_unchecked','item_deleted','required_on','required_off')
     order by k.created_at desc, k.id desc limit 50) b) r),
 'audios',(select coalesce(jsonb_agg(to_jsonb(r) - 'working_at' order by r.position, r.created_at, r.id),'[]'::jsonb) from
   (select * from public.task_audios where company_id=c and task_id=p_task order by position, created_at, id limit 200) r),
 'recurrence',(select jsonb_build_object('id',r.id,'frequency',r.frequency,'next_run',r.next_run,'active',r.active,
   'creator_id',r.creator_id,'copies',r.copies,'last_error',r.last_error)
   from public.task_recurrences r where r.company_id=c and r.id=rec),
 'checklists', mavi_private.task_checklists_json(c, p_task));
end $$;

commit;
