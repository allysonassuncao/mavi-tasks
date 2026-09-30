begin;

-- MAVI · tarefas longas (pedidos grandes que não cabem numa resposta):
--
-- 1. Quando o pedido é grande (juntar o histórico de vários clientes e
--    escrever um material longo), a MAVI monta um plano (ai_tasks + uma
--    etapa por capítulo em ai_task_steps) com o custo estimado e o teto da
--    empresa. Nada roda antes de a pessoa confirmar no card da conversa.
-- 2. Confirmada, a tarefa roda no servidor em fatias de até ~5 minutos (cada
--    fatia pega a vez com ai_task_claim, faz algumas etapas em paralelo e
--    chama a próxima), sempre com o token de quem pediu: as ferramentas só
--    veem o que a pessoa vê. Se o token vencer, a tarefa pausa e continua
--    quando a pessoa abrir a conversa.
-- 3. O progresso chega pelo tópico privado da pessoa (mavi:inbox:<empresa>:<pessoa>,
--    evento ai_task), sem postgres_changes e sem consultas periódicas.
-- 4. No fim, o documento entra na conversa como uma resposta da MAVI
--    (ai_task_finish), com o custo da tarefa ligado a ela, e a pessoa recebe
--    o aviso na caixa de entrada. Perto do teto, a MAVI entrega o que já tem
--    e diz o que faltou.
-- 5. O teto por tarefa é da empresa (padrão US$ 10): administradores e
--    gestores mudam em Painel da MAVI › Consumo e limites.

-- ------------------------------------------------------------ teto
create table mavi_private.ai_task_settings (
 company_id uuid primary key references public.companies(id) on delete cascade,
 cap_usd numeric(8,2) not null check (cap_usd >= 0.5 and cap_usd <= 100),
 updated_by uuid references auth.users(id) on delete set null,
 updated_at timestamptz not null default now()
);
alter table mavi_private.ai_task_settings enable row level security;
revoke all on mavi_private.ai_task_settings from public, anon, authenticated;

create function mavi_private.ai_task_cap_of(c uuid) returns numeric
language sql stable security definer set search_path = '' as $$
 select coalesce((select s.cap_usd from mavi_private.ai_task_settings s where s.company_id = c), 10)
$$;
revoke all on function mavi_private.ai_task_cap_of(uuid) from public, anon, authenticated;

create function public.ai_task_cap(p_company uuid) returns numeric
language plpgsql stable security definer set search_path = '' as $$ begin
 if not mavi_private.member(p_company) then raise exception 'Sem acesso ao espaço' using errcode = '42501'; end if;
 return mavi_private.ai_task_cap_of(p_company);
end $$;

-- Sem valor, volta ao padrão (US$ 10).
create function public.ai_set_task_cap(p_company uuid, p_usd numeric) returns numeric
language plpgsql security definer set search_path = '' as $$ begin
 if not mavi_private.leader(p_company) then
  raise exception 'Só administradores e gestores mudam o teto das tarefas longas.' using errcode = '42501';
 end if;
 if p_usd is null then
  delete from mavi_private.ai_task_settings where company_id = p_company;
 else
  if p_usd < 0.5 or p_usd > 100 then
   raise exception 'O teto por tarefa vai de US$ 0,50 a US$ 100.' using errcode = '22023';
  end if;
  insert into mavi_private.ai_task_settings(company_id, cap_usd, updated_by)
  values (p_company, round(p_usd, 2), auth.uid())
  on conflict (company_id) do update set cap_usd = excluded.cap_usd, updated_by = auth.uid(), updated_at = now();
 end if;
 return mavi_private.ai_task_cap_of(p_company);
end $$;

-- ------------------------------------------------------------ tarefas
create table public.ai_tasks (
 id uuid primary key default gen_random_uuid(),
 company_id uuid not null references public.companies(id) on delete cascade,
 user_id uuid not null references auth.users(id) on delete cascade,
 conversation_id uuid not null references public.ai_conversations(id) on delete cascade,
 module text not null default 'assistant' check (length(module) <= 40),
 title text not null check (length(btrim(title)) between 3 and 160),
 goal text not null check (length(goal) <= 4000),
 -- A parte final (resumo, visão geral), escrita depois das etapas: {title, instructions}.
 closing jsonb check (closing is null or jsonb_typeof(closing) = 'object'),
 status text not null default 'proposed'
  check (status in ('proposed', 'running', 'paused', 'stopping', 'done', 'cancelled', 'error')),
 pause_reason text check (length(pause_reason) <= 300),
 error text check (length(error) <= 300),
 estimate_usd numeric(10,4) not null default 0 check (estimate_usd >= 0),
 cap_usd numeric(8,2) not null,
 spent_usd numeric(10,4) not null default 0,
 -- As fontes citadas nas etapas, numeradas para a tarefa inteira ([S#]).
 sources jsonb not null default '[]' check (jsonb_typeof(sources) = 'array' and pg_column_size(sources) <= 1048576),
 -- O gasto de todas as fatias fica nesta vez (ai_usage.turn_id) e vai para a resposta final.
 turn_id uuid not null default gen_random_uuid(),
 lease_until timestamptz,
 slices integer not null default 0,
 result_message bigint,
 created_at timestamptz not null default now(),
 confirmed_at timestamptz,
 finished_at timestamptz,
 updated_at timestamptz not null default now()
);
create index ai_tasks_user on public.ai_tasks (user_id, created_at desc);
create index ai_tasks_conversation on public.ai_tasks (conversation_id);
create index ai_tasks_company_done on public.ai_tasks (company_id, finished_at desc) where status = 'done';

create table public.ai_task_steps (
 task_id uuid not null references public.ai_tasks(id) on delete cascade,
 ord smallint not null check (ord between 1 and 40),
 title text not null check (length(btrim(title)) between 1 and 160),
 instructions text not null check (length(instructions) <= 3000),
 client_ids uuid[] not null default '{}' check (cardinality(client_ids) <= 10),
 status text not null default 'pending' check (status in ('pending', 'running', 'done', 'error', 'skipped')),
 result text check (length(result) <= 40000),
 error text check (length(error) <= 300),
 cost_usd numeric(10,4) not null default 0,
 attempts smallint not null default 0,
 started_at timestamptz,
 finished_at timestamptz,
 primary key (task_id, ord)
);

alter table public.ai_tasks enable row level security;
alter table public.ai_task_steps enable row level security;
revoke all on public.ai_tasks, public.ai_task_steps from public, anon, authenticated;
-- Tudo passa pelas funções abaixo (só quem pediu a tarefa).

-- O aviso para a tela (a tarefa mudou): quem está com a conversa aberta relê.
create function mavi_private.ai_task_broadcast(t public.ai_tasks) returns void
language plpgsql security definer set search_path = '' as $$
declare v_done integer; v_total integer; begin
 select count(*) filter (where s.status in ('done', 'error', 'skipped')), count(*) into v_done, v_total
 from public.ai_task_steps s where s.task_id = t.id;
 perform realtime.send(jsonb_build_object('id', t.id, 'company_id', t.company_id, 'conversation', t.conversation_id,
  'status', t.status, 'done', v_done, 'total', v_total, 'spent', t.spent_usd), 'ai_task',
  'mavi:inbox:' || t.company_id || ':' || t.user_id, true);
exception when others then
 raise warning 'mavi ai_task broadcast failed: %', sqlerrm;
end $$;
revoke all on function mavi_private.ai_task_broadcast(public.ai_tasks) from public, anon, authenticated;

-- A tarefa inteira (as etapas com o texto de cada uma).
create function mavi_private.ai_task_json(t public.ai_tasks, p_results boolean) returns jsonb
language sql stable security definer set search_path = '' as $$
 select jsonb_build_object('id', t.id, 'company_id', t.company_id, 'conversation', t.conversation_id,
  'module', t.module, 'title', t.title, 'goal', t.goal, 'closing', t.closing, 'status', t.status,
  'pause_reason', t.pause_reason, 'error', t.error, 'estimate', t.estimate_usd, 'cap', t.cap_usd,
  'spent', t.spent_usd, 'turn', t.turn_id, 'slices', t.slices, 'message', t.result_message,
  'lease_until', t.lease_until, 'created_at', t.created_at, 'confirmed_at', t.confirmed_at,
  'finished_at', t.finished_at, 'updated_at', t.updated_at,
  'sources', case when p_results then t.sources else '[]'::jsonb end,
  'steps', coalesce((select jsonb_agg(jsonb_build_object('ord', s.ord, 'title', s.title,
     'instructions', s.instructions, 'client_ids', to_jsonb(s.client_ids), 'status', s.status,
     'error', s.error, 'cost', s.cost_usd, 'attempts', s.attempts, 'started_at', s.started_at,
     'finished_at', s.finished_at)
    || case when p_results then jsonb_build_object('result', s.result) else '{}'::jsonb end
    order by s.ord) from public.ai_task_steps s where s.task_id = t.id), '[]'))
$$;
revoke all on function mavi_private.ai_task_json(public.ai_tasks, boolean) from public, anon, authenticated;

-- A tarefa de quem pede (ou nada).
create function mavi_private.ai_task_mine(p_task uuid) returns public.ai_tasks
language sql stable security definer set search_path = '' as $$
 select t.* from public.ai_tasks t
 where t.id = p_task and t.user_id = auth.uid() and mavi_private.member(t.company_id)
$$;
revoke all on function mavi_private.ai_task_mine(uuid) from public, anon, authenticated;

-- O custo médio de uma etapa nas últimas tarefas da empresa (para a estimativa).
create function public.ai_task_basis(p_company uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$ begin
 if not mavi_private.member(p_company) then raise exception 'Sem acesso ao espaço' using errcode = '42501'; end if;
 return (select jsonb_build_object('step', avg(s.cost_usd), 'steps', count(*))
  from public.ai_task_steps s
  where s.status = 'done' and s.cost_usd > 0 and s.task_id in (
   select t.id from public.ai_tasks t where t.company_id = p_company and t.status = 'done'
   order by t.finished_at desc nulls last limit 20));
end $$;

-- O plano: só a pessoa dona da conversa, com clientes que ela acessa. Um
-- plano novo na mesma conversa substitui o que ainda esperava confirmação.
create function public.ai_task_create(p_company uuid, p_conversation uuid, p_title text, p_goal text,
 p_steps jsonb, p_closing jsonb, p_estimate numeric, p_module text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare t public.ai_tasks; s jsonb; v_ord integer := 0; v_client uuid; v_clients uuid[]; begin
 if not mavi_private.member(p_company) then raise exception 'Sem acesso ao espaço' using errcode = '42501'; end if;
 if not exists (select 1 from public.ai_conversations c where c.id = p_conversation and c.company_id = p_company
  and c.owner_id = auth.uid()) then
  raise exception 'Só quem começou a conversa monta tarefas nela.' using errcode = '42501';
 end if;
 if jsonb_typeof(p_steps) <> 'array' or jsonb_array_length(p_steps) not between 1 and 40 then
  raise exception 'O plano precisa de 1 a 40 etapas.' using errcode = '22023';
 end if;
 if (select count(*) from public.ai_tasks x where x.user_id = auth.uid()
  and x.status in ('running', 'paused', 'stopping')) >= 3 then
  raise exception 'Você já tem 3 tarefas longas em andamento. Espere uma terminar ou pare uma delas.'
   using errcode = '22023';
 end if;
 update public.ai_tasks set status = 'cancelled', finished_at = now(), updated_at = now()
 where conversation_id = p_conversation and user_id = auth.uid() and status = 'proposed';
 insert into public.ai_tasks(company_id, user_id, conversation_id, module, title, goal, closing, estimate_usd, cap_usd)
 values (p_company, auth.uid(), p_conversation, left(coalesce(p_module, 'assistant'), 40), left(btrim(p_title), 160),
  left(coalesce(p_goal, ''), 4000),
  case when jsonb_typeof(p_closing) = 'object' and length(coalesce(p_closing->>'title', '')) >= 1
   then jsonb_build_object('title', left(p_closing->>'title', 160), 'instructions',
    left(coalesce(p_closing->>'instructions', ''), 3000)) end,
  greatest(coalesce(p_estimate, 0), 0), mavi_private.ai_task_cap_of(p_company))
 returning * into t;
 for s in select * from jsonb_array_elements(p_steps) loop
  v_ord := v_ord + 1;
  v_clients := '{}';
  if jsonb_typeof(s->'client_ids') = 'array' then
   for v_client in select distinct (x #>> '{}')::uuid from jsonb_array_elements(s->'client_ids') x
    where (x #>> '{}') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' limit 10 loop
    if not mavi_private.dossier_reader(p_company, v_client) then
     raise exception 'O plano cita um cliente que você não acessa.' using errcode = '42501';
    end if;
    v_clients := v_clients || v_client;
   end loop;
  end if;
  insert into public.ai_task_steps(task_id, ord, title, instructions, client_ids)
  values (t.id, v_ord, left(coalesce(nullif(btrim(s->>'title'), ''), 'Etapa ' || v_ord), 160),
   left(coalesce(s->>'instructions', ''), 3000), v_clients);
 end loop;
 return jsonb_build_object('id', t.id, 'cap', t.cap_usd);
end $$;

create function public.ai_task_get(p_task uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare t public.ai_tasks := mavi_private.ai_task_mine(p_task); begin
 if t.id is null then return null; end if;
 return mavi_private.ai_task_json(t, false);
end $$;

-- A pessoa confirmou o plano no card.
create function public.ai_task_confirm(p_task uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare t public.ai_tasks := mavi_private.ai_task_mine(p_task); begin
 if t.id is null then raise exception 'Tarefa não encontrada.' using errcode = 'P0002'; end if;
 if t.status <> 'proposed' then raise exception 'Esta tarefa já foi decidida.' using errcode = '22023'; end if;
 if (select count(*) from public.ai_tasks x where x.user_id = auth.uid()
  and x.status in ('running', 'paused', 'stopping')) >= 3 then
  raise exception 'Você já tem 3 tarefas longas em andamento. Espere uma terminar ou pare uma delas.'
   using errcode = '22023';
 end if;
 update public.ai_tasks set status = 'running', confirmed_at = now(), updated_at = now(),
  -- O teto vale o de agora (pode ter mudado desde o plano).
  cap_usd = mavi_private.ai_task_cap_of(company_id)
 where id = t.id returning * into t;
 perform mavi_private.ai_task_broadcast(t);
 return mavi_private.ai_task_json(t, false);
end $$;

-- Uma fatia pega a vez (ninguém mais roda a mesma tarefa até a vez vencer).
-- Etapas que ficaram "rodando" numa fatia que caiu voltam para a fila.
create function public.ai_task_claim(p_task uuid, p_seconds integer) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare t public.ai_tasks := mavi_private.ai_task_mine(p_task); begin
 if t.id is null then raise exception 'Tarefa não encontrada.' using errcode = 'P0002'; end if;
 if t.status not in ('running', 'paused', 'stopping') then return null; end if;
 if t.lease_until is not null and t.lease_until > now() then return null; end if;
 if t.slices >= 60 then
  update public.ai_tasks set status = 'error', error = 'A tarefa passou do número máximo de rodadas no servidor.',
   finished_at = now(), updated_at = now(), lease_until = null where id = t.id returning * into t;
  perform mavi_private.ai_task_broadcast(t);
  return null;
 end if;
 update public.ai_task_steps set status = 'pending' where task_id = t.id and status = 'running';
 update public.ai_tasks set status = case when status = 'paused' then 'running' else status end,
  pause_reason = null, slices = slices + 1, updated_at = now(),
  lease_until = now() + make_interval(secs => least(greatest(coalesce(p_seconds, 300), 30), 900))
 where id = t.id returning * into t;
 perform mavi_private.ai_task_broadcast(t);
 return mavi_private.ai_task_json(t, true);
end $$;

-- Uma etapa começa. Depois de 3 tentativas, fica de fora (com erro).
create function public.ai_task_step_start(p_task uuid, p_ord integer) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare t public.ai_tasks := mavi_private.ai_task_mine(p_task); begin
 if t.id is null then raise exception 'Tarefa não encontrada.' using errcode = 'P0002'; end if;
 update public.ai_task_steps set status = case when attempts >= 3 then 'error' else 'running' end,
  error = case when attempts >= 3 then 'Não deu certo em 3 tentativas.' else error end,
  attempts = case when attempts >= 3 then attempts else attempts + 1 end,
  started_at = now(), finished_at = case when attempts >= 3 then now() end
 where task_id = t.id and ord = p_ord and status = 'pending';
 perform mavi_private.ai_task_broadcast(t);
 return jsonb_build_object('status', t.status, 'spent', t.spent_usd, 'cap', t.cap_usd,
  'run', exists (select 1 from public.ai_task_steps s where s.task_id = t.id and s.ord = p_ord and s.status = 'running'));
end $$;

-- O resultado de uma etapa (ou a volta para a fila, sem texto) e o gasto dela.
-- As fontes novas entram na lista da tarefa (as que já estão ficam).
create function public.ai_task_step_save(p_task uuid, p_ord integer, p_status text, p_result text, p_error text,
 p_cost numeric, p_sources jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare t public.ai_tasks := mavi_private.ai_task_mine(p_task); begin
 if t.id is null then raise exception 'Tarefa não encontrada.' using errcode = 'P0002'; end if;
 if p_status not in ('pending', 'done', 'error') then raise exception 'Situação inválida.' using errcode = '22023'; end if;
 if p_cost is null or p_cost < 0 or p_cost > 100 then raise exception 'Custo inválido.' using errcode = '22023'; end if;
 update public.ai_task_steps set status = p_status, result = left(p_result, 40000), error = left(p_error, 300),
  cost_usd = cost_usd + p_cost, finished_at = case when p_status = 'pending' then null else now() end
 where task_id = t.id and ord = p_ord;
 update public.ai_tasks set spent_usd = spent_usd + p_cost, updated_at = now(),
  sources = sources || coalesce((select jsonb_agg(n) from jsonb_array_elements(
    case when jsonb_typeof(p_sources) = 'array' then p_sources else '[]'::jsonb end) n
   where jsonb_typeof(n) = 'object' and not exists (select 1 from jsonb_array_elements(sources) o
    where o->>'ref' = n->>'ref')), '[]')
 where id = t.id returning * into t;
 perform mavi_private.ai_task_broadcast(t);
 return jsonb_build_object('status', t.status, 'spent', t.spent_usd, 'cap', t.cap_usd);
end $$;

-- A fatia acabou: solta a vez. paused (o token venceu ou a próxima fatia não
-- começou) e error encerram a vez com o motivo; running só solta.
create function public.ai_task_release(p_task uuid, p_status text, p_reason text) returns void
language plpgsql security definer set search_path = '' as $$
declare t public.ai_tasks := mavi_private.ai_task_mine(p_task); begin
 if t.id is null then return; end if;
 if p_status not in ('running', 'paused', 'error') then raise exception 'Situação inválida.' using errcode = '22023'; end if;
 update public.ai_tasks set lease_until = null, updated_at = now(),
  status = case when status in ('done', 'cancelled', 'error') then status
   when p_status = 'running' then status
   when p_status = 'paused' and status = 'stopping' then status
   else p_status end,
  pause_reason = case when p_status = 'paused' then left(p_reason, 300) else pause_reason end,
  error = case when p_status = 'error' then left(p_reason, 300) else error end,
  finished_at = case when p_status = 'error' then now() else finished_at end
 where id = t.id returning * into t;
 perform mavi_private.ai_task_broadcast(t);
end $$;

-- Parar: antes de começar, cancela; rodando, a MAVI entrega o que já tem.
create function public.ai_task_stop(p_task uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare t public.ai_tasks := mavi_private.ai_task_mine(p_task); begin
 if t.id is null then raise exception 'Tarefa não encontrada.' using errcode = 'P0002'; end if;
 update public.ai_tasks set updated_at = now(),
  status = case status when 'proposed' then 'cancelled' when 'running' then 'stopping' when 'paused' then 'stopping'
   else status end,
  finished_at = case when status = 'proposed' then now() else finished_at end
 where id = t.id returning * into t;
 perform mavi_private.ai_task_broadcast(t);
 return mavi_private.ai_task_json(t, false);
end $$;

-- O fim: o documento entra na conversa como uma resposta da MAVI, a tarefa
-- aponta para ela e a pessoa recebe o aviso. Parada pela pessoa, a entrega
-- (com o que já tinha) fica como cancelled.
create function public.ai_task_finish(p_task uuid, p_answer text, p_sources jsonb, p_artifacts jsonb, p_steps jsonb,
 p_status text) returns bigint
language plpgsql security definer set search_path = '' as $$
declare t public.ai_tasks := mavi_private.ai_task_mine(p_task); v_message bigint; v_status text; begin
 if t.id is null then raise exception 'Tarefa não encontrada.' using errcode = 'P0002'; end if;
 if t.status not in ('running', 'stopping', 'paused') then raise exception 'Esta tarefa já terminou.' using errcode = '22023'; end if;
 if p_status not in ('done', 'error') then raise exception 'Situação inválida.' using errcode = '22023'; end if;
 v_status := case when t.status = 'stopping' and p_status = 'done' then 'cancelled' else p_status end;
 if not mavi_private.ai_artifacts_ok(t.company_id, p_artifacts) then
  raise exception 'Anexos da resposta inválidos.' using errcode = '22023';
 end if;
 insert into public.ai_messages(company_id, conversation_id, role, content, sources, steps, artifacts)
 values (t.company_id, t.conversation_id, 'assistant', left(coalesce(p_answer, ''), 40000),
  coalesce(p_sources, '[]'), coalesce(p_steps, '[]'), coalesce(p_artifacts, '[]'))
 returning id into v_message;
 update public.ai_conversations set updated_at = now() where id = t.conversation_id;
 update public.ai_tasks set status = v_status, result_message = v_message, finished_at = now(), updated_at = now(),
  lease_until = null, pause_reason = null
 where id = t.id returning * into t;
 perform mavi_private.ai_task_broadcast(t);
 insert into public.notifications(company_id, user_id, actor_id, task_id, kind, title, body, link)
 values (t.company_id, t.user_id, null, null, 'ai_answer',
  case v_status when 'done' then 'A MAVI terminou a tarefa longa'
   when 'cancelled' then 'A MAVI entregou o que já tinha da tarefa longa'
   else 'A MAVI não conseguiu terminar a tarefa longa' end,
  left(t.title, 300), '/mavi/conversas/' || t.conversation_id);
 return v_message;
end $$;

-- As tarefas em andamento da pessoa (a tela retoma a que pausou).
create function public.ai_tasks_active(p_company uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
 select coalesce(jsonb_agg(jsonb_build_object('id', t.id, 'conversation', t.conversation_id, 'title', t.title,
   'status', t.status, 'lease_until', t.lease_until) order by t.created_at desc), '[]')
 from public.ai_tasks t
 where mavi_private.member(p_company) and t.company_id = p_company and t.user_id = auth.uid()
  and t.status in ('running', 'paused', 'stopping')
$$;

revoke all on function public.ai_task_cap(uuid), public.ai_set_task_cap(uuid, numeric), public.ai_task_basis(uuid),
 public.ai_task_create(uuid, uuid, text, text, jsonb, jsonb, numeric, text), public.ai_task_get(uuid),
 public.ai_task_confirm(uuid), public.ai_task_claim(uuid, integer), public.ai_task_step_start(uuid, integer),
 public.ai_task_step_save(uuid, integer, text, text, text, numeric, jsonb), public.ai_task_release(uuid, text, text),
 public.ai_task_stop(uuid), public.ai_task_finish(uuid, text, jsonb, jsonb, jsonb, text), public.ai_tasks_active(uuid)
 from public, anon;
grant execute on function public.ai_task_cap(uuid), public.ai_set_task_cap(uuid, numeric), public.ai_task_basis(uuid),
 public.ai_task_create(uuid, uuid, text, text, jsonb, jsonb, numeric, text), public.ai_task_get(uuid),
 public.ai_task_confirm(uuid), public.ai_task_claim(uuid, integer), public.ai_task_step_start(uuid, integer),
 public.ai_task_step_save(uuid, integer, text, text, text, numeric, jsonb), public.ai_task_release(uuid, text, text),
 public.ai_task_stop(uuid), public.ai_task_finish(uuid, text, jsonb, jsonb, jsonb, text), public.ai_tasks_active(uuid)
 to authenticated;

-- O card da tarefa (task) passa a valer nas respostas.
create or replace function mavi_private.ai_artifacts_ok(c uuid, p jsonb) returns boolean
language sql immutable set search_path = '' as $$
 select jsonb_typeof(coalesce(p, '[]')) = 'array' and jsonb_array_length(coalesce(p, '[]')) <= 12
  and not exists (select 1 from jsonb_array_elements(coalesce(p, '[]')) a
   where jsonb_typeof(a) <> 'object' or coalesce(a->>'id', '') !~ '^[A-Za-z0-9_-]{4,64}$'
    or coalesce(a->>'type', '') not in ('visual', 'image', 'action', 'canvas', 'question', 'task')
    or (a->>'type' = 'image' and coalesce(a->>'path', '') !~
     ('^ai-images/' || c::text || '/[0-9a-f-]{36}\.(png|webp|jpg)$'))
    or (a->>'type' = 'task' and coalesce(a->>'task', '') !~
     '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'))
$$;

commit;
