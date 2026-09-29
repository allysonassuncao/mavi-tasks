begin;

-- MAVI · parar a resposta, sair e ser avisado, e ler páginas da internet:
--
-- 1. Cada resposta da MAVI em tempo real é uma execução (ai_runs): quem
--    pergunta pode pedir para parar; se a pessoa sai (fecha a aba, muda de
--    página), a resposta continua no servidor e, ao terminar, um aviso
--    'ai_answer' chega na caixa de entrada (e no push, pelas preferências).
--    Uma conversa nova já nasce no começo (quem volta vê que está
--    respondendo); se a resposta falha sem nada salvo, ela sai. O fim é
--    anunciado no tópico privado da pessoa ('ai_run'), sem postgres_changes.
-- 2. Poder novo 'scrape' (Leitura de páginas): a MAVI abre páginas públicas
--    e lê texto, tabelas e dados estruturados, com qualquer modelo.
-- As funções de poderes abaixo são as da migração 20261218090000 com
-- 'scrape'; quem as redefinir depois mantém os valores.

alter table public.ai_powers drop constraint ai_powers_power_check;
alter table public.ai_powers add constraint ai_powers_power_check
 check (power in ('visuals', 'images', 'actions', 'skills', 'canvas', 'web', 'mcp', 'scrape'));
alter table public.ai_tool_calls drop constraint ai_tool_calls_power_check;
alter table public.ai_tool_calls add constraint ai_tool_calls_power_check
 check (power in ('visuals', 'images', 'actions', 'skills', 'canvas', 'web', 'mcp', 'scrape'));

create or replace function public.ai_my_powers(p_company uuid) returns text[]
language sql stable security definer set search_path = '' as $$
 select coalesce(array_agg(p order by p), '{}')
 from unnest(array['actions', 'canvas', 'images', 'mcp', 'scrape', 'skills', 'visuals', 'web']) p
 where mavi_private.member(p_company) and mavi_private.ai_power_on(p_company, auth.uid(), p)
$$;

create or replace function public.ai_powers_admin(p_company uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$ begin
 if not mavi_private.leader(p_company) then
  raise exception 'Só administradores e gestores configuram os poderes da MAVI.' using errcode = '42501';
 end if;
 return (select coalesce(jsonb_agg(jsonb_build_object('power', p.power,
   'enabled', coalesce(w.enabled, false), 'everyone', coalesce(w.everyone, true),
   'team_ids', to_jsonb(coalesce(w.team_ids, '{}')), 'user_ids', to_jsonb(coalesce(w.user_ids, '{}')),
   'except_ids', to_jsonb(coalesce(w.except_ids, '{}')), 'updated_at', w.updated_at, 'updated_by', w.updated_by)
   order by p.ord), '[]')
  from unnest(array['visuals', 'images', 'actions', 'canvas', 'web', 'scrape', 'skills', 'mcp'])
   with ordinality p(power, ord)
  left join public.ai_powers w on w.company_id = p_company and w.power = p.power);
end $$;

create or replace function public.ai_set_power(p_company uuid, p_power text, p_enabled boolean, p_everyone boolean,
 p_teams uuid[], p_users uuid[], p_except uuid[]) returns void
language plpgsql security definer set search_path = '' as $$
declare v_teams uuid[]; v_users uuid[]; v_except uuid[]; begin
 if not mavi_private.leader(p_company) then
  raise exception 'Só administradores e gestores configuram os poderes da MAVI.' using errcode = '42501';
 end if;
 if p_power not in ('visuals', 'images', 'actions', 'skills', 'canvas', 'web', 'mcp', 'scrape') then
  raise exception 'Poder inválido.' using errcode = '22023';
 end if;
 select coalesce(array_agg(distinct t), '{}') into v_teams from unnest(coalesce(p_teams, '{}')) t
 where exists (select 1 from public.teams x where x.company_id = p_company and x.id = t);
 select coalesce(array_agg(distinct u), '{}') into v_users from unnest(coalesce(p_users, '{}')) u
 where exists (select 1 from public.memberships x where x.company_id = p_company and x.user_id = u);
 select coalesce(array_agg(distinct u), '{}') into v_except from unnest(coalesce(p_except, '{}')) u
 where exists (select 1 from public.memberships x where x.company_id = p_company and x.user_id = u);
 if coalesce(p_enabled, false) and not coalesce(p_everyone, true)
  and cardinality(v_teams) = 0 and cardinality(v_users) = 0 then
  raise exception 'Escolha pelo menos uma equipe ou pessoa (ou libere para todos).' using errcode = '22023';
 end if;
 insert into public.ai_powers(company_id, power, enabled, everyone, team_ids, user_ids, except_ids, updated_by)
 values (p_company, p_power, coalesce(p_enabled, false), coalesce(p_everyone, true), v_teams, v_users, v_except,
  auth.uid())
 on conflict (company_id, power) do update set enabled = excluded.enabled, everyone = excluded.everyone,
  team_ids = excluded.team_ids, user_ids = excluded.user_ids, except_ids = excluded.except_ids,
  updated_by = auth.uid(), updated_at = now();
end $$;

create or replace function public.ai_log_tool_calls(p_company uuid, p_conversation uuid, p_module text, p_calls jsonb)
returns void
language plpgsql security definer set search_path = '' as $$
declare v_conversation uuid := p_conversation; begin
 if not mavi_private.member(p_company) then raise exception 'Sem permissão.' using errcode = '42501'; end if;
 if jsonb_typeof(coalesce(p_calls, '[]')) <> 'array' or jsonb_array_length(coalesce(p_calls, '[]')) > 60 then
  raise exception 'Lista de chamadas inválida.' using errcode = '22023';
 end if;
 if v_conversation is not null and not exists (select 1 from public.ai_conversations v
  where v.company_id = p_company and v.id = v_conversation and v.owner_id = auth.uid()) then
  v_conversation := null;
 end if;
 insert into public.ai_tool_calls(company_id, conversation_id, module, tool, power, ok, duration_ms, cost_usd, error,
  skill_id, skill_version)
 select p_company, v_conversation, left(coalesce(p_module, 'assistant'), 40), left(x.tool, 80),
  case when x.power in ('visuals', 'images', 'actions', 'skills', 'canvas', 'web', 'mcp', 'scrape') then x.power end,
  coalesce(x.ok, false),
  least(greatest(coalesce(x.ms, 0), 0), 3600000), least(greatest(coalesce(x.cost, 0), 0), 100),
  left(x.error, 300),
  (select k.id from public.ai_skills k where k.company_id = p_company and k.id = x.skill),
  case when exists (select 1 from public.ai_skills k where k.company_id = p_company and k.id = x.skill)
   then x.skill_version end
 from jsonb_to_recordset(coalesce(p_calls, '[]')) as x(tool text, power text, ok boolean, ms integer, cost numeric,
  error text, skill uuid, skill_version integer)
 where coalesce(btrim(x.tool), '') <> '';
end $$;

-- ------------------------------------------------------------ avisos
alter table public.notifications drop constraint notifications_kind_check;
alter table public.notifications add constraint notifications_kind_check
 check (kind in ('mention', 'assigned', 'reply', 'social_leads', 'ai_share', 'success_case', 'notice',
  'notice_animation', 'temperature', 'tasks_assigned', 'due_risk', 'status', 'review', 'ai_skill', 'ai_answer'));
alter table public.notifications drop constraint notifications_target_check;
alter table public.notifications add constraint notifications_target_check
 check ((kind in ('social_leads', 'ai_share', 'success_case', 'notice', 'notice_animation', 'temperature',
   'tasks_assigned', 'due_risk', 'ai_skill', 'ai_answer')) = (task_id is null)
  and (task_id is not null or (title is not null and link is not null))
  and ((kind = 'notice') = (notice_id is not null)));
create or replace function mavi_private.notification_pref_keys() returns text[]
language sql immutable set search_path = '' as $$
 select array['assigned', 'mention', 'reply', 'review', 'due_risk',
  'social_leads', 'ai_share', 'success_case', 'temperature', 'ai_skill', 'ai_answer']
  || array(select 'status.' || s || '.' || r
   from unnest(array['progress', 'returned', 'review', 'rejected', 'correction', 'done']) s,
        unnest(array['creator', 'assignee', 'participant']) r)
$$;

-- ------------------------------------------------------------ execuções
create table public.ai_runs (
 id uuid primary key default gen_random_uuid(),
 company_id uuid not null references public.companies(id) on delete cascade,
 user_id uuid not null references auth.users(id) on delete cascade,
 conversation_id uuid references public.ai_conversations(id) on delete set null,
 -- A conversa nasceu com esta execução (sai se a resposta falhar sem nada salvo).
 created_conversation boolean not null default false,
 module text not null default 'assistant' check (length(module) <= 40),
 question text not null check (length(question) <= 300),
 status text not null default 'running' check (status in ('running', 'done', 'cancelled', 'error')),
 cancel_requested boolean not null default false,
 -- A pessoa saiu antes do fim (a conexão caiu): o fim vira aviso.
 detached boolean not null default false,
 error text check (length(error) <= 300),
 started_at timestamptz not null default now(),
 finished_at timestamptz
);
create index ai_runs_running on public.ai_runs(user_id, started_at desc) where status = 'running';
alter table public.ai_runs enable row level security;
revoke all on public.ai_runs from public, anon, authenticated;
grant select on public.ai_runs to authenticated;
create policy ai_runs_read on public.ai_runs for select to authenticated
 using (user_id = (select auth.uid()) and company_id in (select mavi_private.active_companies()));
-- A tela fica sabendo pelo tópico privado da pessoa (mavi:inbox:<empresa>:<pessoa>,
-- como a caixa de entrada), sem postgres_changes.
create function mavi_private.ai_run_broadcast(r public.ai_runs) returns void
language plpgsql security definer set search_path = '' as $$ begin
 perform realtime.send(jsonb_build_object('id', r.id, 'company_id', r.company_id, 'conversation', r.conversation_id,
  'status', r.status), 'ai_run', 'mavi:inbox:' || r.company_id || ':' || r.user_id, true);
exception when others then
 raise warning 'mavi ai_run broadcast failed: %', sqlerrm;
end $$;
revoke all on function mavi_private.ai_run_broadcast(public.ai_runs) from public, anon, authenticated;

-- Começa a resposta. Sem conversa, ela já nasce (com o título da pergunta).
-- Execuções velhas "respondendo" (a função caiu) viram erro.
create function public.ai_run_start(p_company uuid, p_conversation uuid, p_question text, p_module text,
 p_scope jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_conversation uuid := p_conversation; v_created boolean := false; v_id uuid;
 v_title text := left(coalesce(nullif(btrim(regexp_replace(coalesce(p_question, ''), '\s+', ' ', 'g')), ''),
  'Nova conversa'), 80); begin
 if not mavi_private.member(p_company) then raise exception 'Sem acesso ao espaço' using errcode = '42501'; end if;
 update public.ai_runs set status = 'error', error = 'A resposta foi interrompida.', finished_at = now()
 where user_id = auth.uid() and status = 'running' and started_at < now() - interval '10 minutes';
 if v_conversation is null then
  insert into public.ai_conversations(company_id, title, scope, module)
  values (p_company, v_title, coalesce(p_scope, '{}'), left(coalesce(p_module, 'assistant'), 40))
  returning id into v_conversation;
  v_created := true;
 elsif not exists (select 1 from public.ai_conversations v where v.company_id = p_company and v.id = v_conversation
  and v.owner_id = auth.uid()) then
  raise exception 'Só quem começou a conversa continua nela.' using errcode = '42501';
 end if;
 insert into public.ai_runs(company_id, user_id, conversation_id, created_conversation, module, question)
 values (p_company, auth.uid(), v_conversation, v_created, left(coalesce(p_module, 'assistant'), 40),
  left(v_title, 300))
 returning id into v_id;
 return jsonb_build_object('id', v_id, 'conversation', v_conversation, 'created', v_created);
end $$;

-- Parar: quem perguntou pede; o servidor para no próximo passo.
create function public.ai_run_cancel(p_run uuid) returns boolean
language sql security definer set search_path = '' as $$
 update public.ai_runs set cancel_requested = true
 where id = p_run and user_id = auth.uid() and status = 'running'
 returning true
$$;

-- A conexão caiu: se foi para parar, devolve true; senão a resposta segue
-- em segundo plano e o fim vira aviso.
create function public.ai_run_detach(p_run uuid) returns boolean
language plpgsql security definer set search_path = '' as $$
declare v_cancel boolean; begin
 update public.ai_runs set detached = not cancel_requested
 where id = p_run and user_id = auth.uid() and status = 'running'
 returning cancel_requested into v_cancel;
 return coalesce(v_cancel, false);
end $$;

-- Em segundo plano, o servidor confere entre um passo e outro se é para parar.
create function public.ai_run_should_stop(p_run uuid) returns boolean
language sql stable security definer set search_path = '' as $$
 select coalesce((select cancel_requested or status <> 'running' from public.ai_runs
  where id = p_run and user_id = auth.uid()), false)
$$;

-- O fim: guarda a situação e, se a pessoa saiu, avisa na caixa de entrada.
create function public.ai_run_finish(p_run uuid, p_status text, p_error text) returns void
language plpgsql security definer set search_path = '' as $$
declare r public.ai_runs; v_empty boolean; begin
 if p_status not in ('done', 'cancelled', 'error') then
  raise exception 'Situação inválida.' using errcode = '22023';
 end if;
 update public.ai_runs set status = p_status, error = left(p_error, 300), finished_at = now()
 where id = p_run and user_id = auth.uid() and status = 'running'
 returning * into r;
 if r.id is null then return; end if;
 v_empty := not exists (select 1 from public.ai_messages m where m.company_id = r.company_id
  and m.conversation_id = r.conversation_id);
 -- A conversa que nasceu com a resposta e ficou vazia não fica na lista.
 if r.created_conversation and v_empty and r.conversation_id is not null then
  delete from public.ai_conversations where company_id = r.company_id and id = r.conversation_id;
  update public.ai_runs set conversation_id = null where id = r.id;
  r.conversation_id := null;
 end if;
 perform mavi_private.ai_run_broadcast(r);
 if r.detached and p_status in ('done', 'error') then
  insert into public.notifications(company_id, user_id, actor_id, task_id, kind, title, body, link)
  values (r.company_id, r.user_id, null, null, 'ai_answer',
   case when p_status = 'done' then 'A MAVI terminou de responder' else 'A MAVI não conseguiu terminar a resposta' end,
   left(r.question, 300),
   case when r.conversation_id is null then '/mavi/conversas' else '/mavi/conversas/' || r.conversation_id end);
 end if;
end $$;

-- As respostas em andamento da pessoa (a tela mostra ao voltar).
create function public.ai_runs_active(p_company uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
 select coalesce(jsonb_agg(jsonb_build_object('id', r.id, 'conversation', r.conversation_id,
   'question', r.question, 'started_at', r.started_at, 'cancel_requested', r.cancel_requested)
   order by r.started_at desc), '[]')
 from public.ai_runs r
 where mavi_private.member(p_company) and r.company_id = p_company and r.user_id = auth.uid()
  and r.status = 'running' and r.started_at > now() - interval '10 minutes'
$$;

revoke all on function public.ai_run_start(uuid, uuid, text, text, jsonb), public.ai_run_cancel(uuid),
 public.ai_run_detach(uuid), public.ai_run_should_stop(uuid), public.ai_run_finish(uuid, text, text),
 public.ai_runs_active(uuid) from public, anon;
grant execute on function public.ai_run_start(uuid, uuid, text, text, jsonb), public.ai_run_cancel(uuid),
 public.ai_run_detach(uuid), public.ai_run_should_stop(uuid), public.ai_run_finish(uuid, text, text),
 public.ai_runs_active(uuid) to authenticated;

commit;
