begin;

-- Campanhas › Insights da MAVI, Fase 4: o ciclo de vida do insight
-- (pedido de 04/10/2026).
--
-- * Status: Novo › Aplicado / Descartado (com motivo) / Lembrar depois (volta
--   na data, com lembrete na caixa de entrada de quem adiou). Reabrir volta
--   para Novo. Tudo fica no histórico (campaign_insight_events). Quem vê a
--   campanha mexe.
-- * O mesmo assunto descartado (60 dias), aplicado (30 dias) ou adiado não
--   volta como novo nas próximas análises.
-- * Criar tarefa a partir do insight: a tarefa fica ligada a ele
--   (campaign_insight_tasks), como no Radar.
-- * 👍/👎 (com motivo) e os descartes viram aprendizados do time
--   (campaign_insight_lessons), pela MAVI, com a regra do Aprendizado da MAVI:
--   vale com 2 pessoas ou 1 líder; os líderes revisam, pausam, editam ou
--   criam no Painel da MAVI › Campanhas. As análises seguintes seguem os
--   aprendizados do cliente, do produto e da empresa.
-- * Antes × depois: o worker mede, nas análises seguintes, o alvo de cada
--   insight aplicado (mesmos dias antes e depois), e guarda em effect.
-- * Contexto da MAVI: com campaign_insight_settings.mavi_context ligado, a
--   conversa sobre a campanha recebe os insights abertos e os aplicados.

-- ------------------------------------------------------------ insights
alter table public.campaign_insights
 add column status_at timestamptz,
 add column status_by uuid,
 add column status_reason text not null default '' check (length(status_reason) <= 300),
 add column snooze_until timestamptz,
 add column applied_at timestamptz,
 -- {days_before, days_after, before, after, change, verdict}
 add column effect jsonb check (effect is null or jsonb_typeof(effect) = 'object'),
 add column effect_at timestamptz;
create index campaign_insights_snoozed on public.campaign_insights(snooze_until) where status = 'snoozed';

create table public.campaign_insight_events (
 id bigint generated always as identity primary key,
 company_id uuid not null,
 insight_id uuid not null references public.campaign_insights(id) on delete cascade,
 -- Nulo: o sistema (ex.: voltou do "Lembrar depois").
 user_id uuid,
 action text not null check (action in ('applied', 'dismissed', 'snoozed', 'reopened', 'returned', 'task')),
 reason text not null default '' check (length(reason) <= 300),
 detail jsonb not null default '{}' check (jsonb_typeof(detail) = 'object'),
 created_at timestamptz not null default now()
);
create index campaign_insight_events_insight on public.campaign_insight_events(insight_id, created_at desc);
alter table public.campaign_insight_events enable row level security;
revoke all on public.campaign_insight_events from public, anon, authenticated;

create table public.campaign_insight_tasks (
 company_id uuid not null,
 insight_id uuid not null references public.campaign_insights(id) on delete cascade,
 task_id uuid not null references public.tasks(id) on delete cascade,
 created_by uuid,
 created_at timestamptz not null default now(),
 primary key (insight_id, task_id)
);
create index campaign_insight_tasks_task on public.campaign_insight_tasks(task_id);
alter table public.campaign_insight_tasks enable row level security;
revoke all on public.campaign_insight_tasks from public, anon, authenticated;

-- ------------------------------------------------------------ avaliação e aprendizados
-- Uma por pessoa e insight: 👍 (up), 👎 (down) ou o descarte (dismiss).
create table public.campaign_insight_feedback (
 id bigint generated always as identity primary key,
 company_id uuid not null,
 user_id uuid not null,
 -- Administrador ou gestor quando avaliou (vale sozinho para o aprendizado).
 leader boolean not null default false,
 insight_id uuid not null references public.campaign_insights(id) on delete cascade,
 campaign_id uuid not null,
 client_id uuid,
 product_id uuid,
 vote text not null check (vote in ('up', 'down', 'dismiss')),
 -- wrong: os números não mostram isso; not_actionable: não dá para aplicar;
 -- known: já sabíamos ou já fazemos; client: restrição do cliente (verba,
 -- estoque, prazo…); timing: não é o momento; other.
 reason text check (reason in ('wrong', 'not_actionable', 'known', 'client', 'timing', 'other')),
 comment text not null default '' check (length(comment) <= 500),
 learned_at timestamptz,
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 unique (user_id, insight_id)
);
create index campaign_insight_feedback_pending on public.campaign_insight_feedback(company_id, created_at)
 where learned_at is null;
alter table public.campaign_insight_feedback enable row level security;
revoke all on public.campaign_insight_feedback from public, anon, authenticated;

create table public.campaign_insight_lessons (
 id uuid primary key default gen_random_uuid(),
 company_id uuid not null references public.companies(id),
 scope text not null check (scope in ('company', 'product', 'client')),
 client_id uuid,
 product_id uuid,
 -- Para que tipo de insight vale (nulo: todos).
 kind text check (kind in ('highlight', 'opportunity', 'problem', 'tracking')),
 text text not null check (length(btrim(text)) between 5 and 400),
 -- candidate: falta confirmar (2 pessoas ou 1 líder); active: vale.
 status text not null default 'candidate' check (status in ('active', 'candidate', 'paused', 'dismissed')),
 origin text not null default 'mavi' check (origin in ('mavi', 'person')),
 evidence bigint[] not null default '{}',
 people integer not null default 0,
 has_leader boolean not null default false,
 ups integer not null default 0,
 downs integer not null default 0,
 reviewed_by uuid,
 reviewed_at timestamptz,
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 updated_by uuid,
 check ((scope = 'client') = (client_id is not null)),
 check ((scope = 'product') = (product_id is not null))
);
create index campaign_insight_lessons_company on public.campaign_insight_lessons(company_id, status);
alter table public.campaign_insight_lessons enable row level security;
revoke all on public.campaign_insight_lessons from public, anon, authenticated;

create table mavi_private.campaign_insight_learning_state (
 company_id uuid primary key,
 claimed_until timestamptz,
 attempts integer not null default 0,
 last_error text,
 built_at timestamptz
);
revoke all on mavi_private.campaign_insight_learning_state from public, anon, authenticated;

-- As empresas com avaliações para aprender (paradas há 10 minutos, ou 10+).
create function mavi_private.campaign_insight_learning_due() returns setof uuid
language sql stable security definer set search_path = '' as $$
 select f.company_id from public.campaign_insight_feedback f
 left join mavi_private.campaign_insight_learning_state s on s.company_id = f.company_id
 where f.learned_at is null and coalesce(s.claimed_until, '-infinity') < now() and coalesce(s.attempts, 0) < 5
 group by f.company_id
 having max(f.updated_at) < now() - interval '10 minutes' or count(*) >= 10
$$;
revoke all on function mavi_private.campaign_insight_learning_due() from public, anon, authenticated;

-- A regra do Aprendizado da MAVI: vale com 2 pessoas ou 1 líder.
create function mavi_private.campaign_insight_lesson_evidence(p_id uuid, p_add bigint[]) returns void
language plpgsql security definer set search_path = '' as $$
declare l public.campaign_insight_lessons; v_ids bigint[]; begin
 select * into l from public.campaign_insight_lessons where id = p_id for update;
 select coalesce(array_agg(distinct x order by x desc), '{}') into v_ids
 from unnest(l.evidence || coalesce(p_add, '{}')) x
 where exists (select 1 from public.campaign_insight_feedback f where f.id = x and f.company_id = l.company_id);
 v_ids := v_ids[1:60];
 update public.campaign_insight_lessons c set evidence = v_ids,
  people = (select count(distinct f.user_id) from public.campaign_insight_feedback f where f.id = any(v_ids)),
  has_leader = exists (select 1 from public.campaign_insight_feedback f where f.id = any(v_ids) and f.leader),
  ups = (select count(*) from public.campaign_insight_feedback f where f.id = any(v_ids) and f.vote = 'up'),
  downs = (select count(*) from public.campaign_insight_feedback f where f.id = any(v_ids) and f.vote <> 'up')
 where c.id = p_id;
 update public.campaign_insight_lessons c set status = case when c.people >= 2 or c.has_leader then 'active' else 'candidate' end
 where c.id = p_id and c.status in ('active', 'candidate') and c.origin = 'mavi';
end $$;
revoke all on function mavi_private.campaign_insight_lesson_evidence(uuid, bigint[]) from public, anon, authenticated;

-- ------------------------------------------------------------ o insight como as telas leem
create or replace function mavi_private.campaign_insight_json(i public.campaign_insights) returns jsonb
language sql stable security definer set search_path = '' as $$
 select jsonb_build_object('id', i.id, 'run_id', i.run_id, 'last_seen_run', i.last_seen_run, 'kind', i.kind,
  'priority', i.priority, 'title', i.title, 'body', i.body, 'action', i.action, 'evidence', i.evidence,
  'target', i.target, 'source', i.source, 'money_basis', i.money_basis, 'confidence', i.confidence,
  'status', i.status, 'seen_count', i.seen_count, 'last_seen_at', i.last_seen_at, 'created_at', i.created_at,
  'status_at', i.status_at, 'status_reason', nullif(i.status_reason, ''),
  'status_by_name', (select m.name from public.memberships m where m.company_id = i.company_id and m.user_id = i.status_by),
  'snooze_until', i.snooze_until, 'applied_at', i.applied_at, 'effect', i.effect, 'effect_at', i.effect_at,
  'my_vote', (select f.vote from public.campaign_insight_feedback f where f.insight_id = i.id
   and f.user_id = auth.uid() and f.vote in ('up', 'down')),
  'votes', jsonb_build_object(
   'up', (select count(*) from public.campaign_insight_feedback f where f.insight_id = i.id and f.vote = 'up'),
   'down', (select count(*) from public.campaign_insight_feedback f where f.insight_id = i.id and f.vote = 'down')),
  'tasks', coalesce((select jsonb_agg(jsonb_build_object('id', tk.id, 'title', tk.title, 'status', tk.status,
     'due_date', tk.due_date, 'assignee_name', mm.name) order by x.created_at desc)
   from public.campaign_insight_tasks x
   join public.tasks tk on tk.id = x.task_id and not tk.archived
   left join public.memberships mm on mm.company_id = tk.company_id and mm.user_id = tk.assignee_id
   where x.insight_id = i.id
    and (mavi_private.leader(i.company_id) or mavi_private.task_access(i.company_id, tk.id))), '[]'))
$$;

-- A da migração 20270327090000, com os aplicados, os adiados e os descartados.
create or replace function public.campaign_insights(p_company uuid, p_campaign uuid, p_runs integer default 8) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare s public.campaign_insight_settings; v_last public.campaign_insight_runs; v_latest uuid; v_wait timestamptz;
begin
 if not mavi_private.campaign_insight_reader(p_company, p_campaign) then
  raise exception 'Sem permissão' using errcode = '42501';
 end if;
 s := mavi_private.campaign_insight_config(p_company);
 select * into v_last from public.campaign_insight_runs r where r.company_id = p_company and r.campaign_id = p_campaign
  and r.status in ('done', 'queued', 'running') order by r.created_at desc limit 1;
 if v_last.id is not null then
  v_wait := v_last.created_at + make_interval(mins => s.min_interval_minutes);
  if v_wait <= now() then v_wait := null; end if;
 end if;
 select r.id into v_latest from public.campaign_insight_runs r where r.company_id = p_company
  and r.campaign_id = p_campaign and r.status = 'done' order by r.finished_at desc nulls last limit 1;
 return jsonb_build_object(
  'enabled', s.enabled,
  'schedule', mavi_private.campaign_insight_schedule(p_company, p_campaign),
  'timezone', mavi_private.company_tz(p_company),
  'last_scheduled_day', (select max(r.local_day) from public.campaign_insight_runs r where r.company_id = p_company
   and r.campaign_id = p_campaign and r.trigger = 'schedule'),
  'places', jsonb_build_object('panel', s.show_panel, 'badge', s.show_badge, 'tab', s.show_tab),
  'money_basis', s.money_basis,
  'min_interval_minutes', s.min_interval_minutes,
  'blocker', mavi_private.campaign_insight_blocker(p_company, p_campaign),
  'capped', mavi_private.campaign_insight_capped(p_company),
  'wait_until', v_wait,
  'pending', (select jsonb_build_object('id', r.id, 'status', r.status, 'trigger', r.trigger,
    'created_at', r.created_at, 'started_at', r.started_at, 'note', r.note,
    -- Na fila com hora marcada: esperando a cota da plataforma (ou o orçamento do Google).
    'waiting_until', case when r.status = 'queued' and r.claimed_until > now() then r.claimed_until end,
    'requested_by_name', (select m.name from public.memberships m where m.company_id = r.company_id
     and m.user_id = r.requested_by))
   from public.campaign_insight_runs r where r.company_id = p_company and r.campaign_id = p_campaign
    and r.status in ('queued', 'running') order by r.created_at desc limit 1),
  'latest_run', v_latest,
  -- Abertos: os da última análise e os que voltaram do "Lembrar depois".
  'current', coalesce((select jsonb_agg(mavi_private.campaign_insight_json(i)
    order by mavi_private.campaign_insight_rank(i.priority) desc, i.created_at)
   from public.campaign_insights i where i.company_id = p_company and i.campaign_id = p_campaign
    and i.status = 'new' and (i.last_seen_run = v_latest or i.snooze_until is not null)), '[]'),
  'applied', coalesce((select jsonb_agg(mavi_private.campaign_insight_json(i) order by i.applied_at desc)
   from (select * from public.campaign_insights i where i.company_id = p_company and i.campaign_id = p_campaign
    and i.status = 'applied' order by i.applied_at desc limit 30) i), '[]'),
  'snoozed', coalesce((select jsonb_agg(mavi_private.campaign_insight_json(i) order by i.snooze_until)
   from public.campaign_insights i where i.company_id = p_company and i.campaign_id = p_campaign
    and i.status = 'snoozed'), '[]'),
  'dismissed', coalesce((select jsonb_agg(mavi_private.campaign_insight_json(i) order by i.status_at desc)
   from (select * from public.campaign_insights i where i.company_id = p_company and i.campaign_id = p_campaign
    and i.status = 'dismissed' and i.status_at > now() - interval '90 days' order by i.status_at desc limit 30) i), '[]'),
  'runs', coalesce((select jsonb_agg(x.j order by x.created_at desc) from (
   select r.created_at, jsonb_build_object('id', r.id, 'trigger', r.trigger, 'status', r.status,
    'requested_by_name', (select m.name from public.memberships m where m.company_id = r.company_id
     and m.user_id = r.requested_by),
    'created_at', r.created_at, 'started_at', r.started_at, 'finished_at', r.finished_at,
    'cost_usd', r.cost_usd, 'model', r.model, 'provider_name', r.provider_name, 'summary', r.summary,
    'note', r.note, 'money_basis', r.money_basis, 'multiplier', r.multiplier, 'windows', r.windows,
    'insights_count', r.insights_count, 'repeated_count', r.repeated_count,
    'api_calls', r.api_calls, 'tokens', r.tokens,
    'insights', coalesce((select jsonb_agg(mavi_private.campaign_insight_json(i)
      order by mavi_private.campaign_insight_rank(i.priority) desc, i.created_at)
     from public.campaign_insights i where i.run_id = r.id), '[]')) as j
   from public.campaign_insight_runs r where r.company_id = p_company and r.campaign_id = p_campaign
   order by r.created_at desc limit least(greatest(coalesce(p_runs, 8), 1), 50)) x), '[]'));
end $$;

-- A da migração 20270327090000: conta também os que voltaram do "Lembrar depois".
create or replace function public.campaign_insight_badges(p_company uuid, p_campaigns uuid[]) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare s public.campaign_insight_settings; begin
 perform mavi_private.ad_require_reader(p_company);
 s := mavi_private.campaign_insight_config(p_company);
 if not s.enabled or not s.show_badge then
  return jsonb_build_object('enabled', s.enabled, 'badge', false, 'rows', '[]'::jsonb);
 end if;
 return jsonb_build_object('enabled', true, 'badge', true, 'rows', coalesce((
  select jsonb_agg(jsonb_build_object('campaign', x.id, 'open', x.open, 'high', x.high, 'medium', x.medium,
   'at', x.at, 'running', x.running))
  from (
   select a.id,
    count(i.id) filter (where i.status = 'new')::int as open,
    count(i.id) filter (where i.status = 'new' and i.priority = 'high')::int as high,
    count(i.id) filter (where i.status = 'new' and i.priority = 'medium')::int as medium,
    max(l.finished_at) as at,
    exists (select 1 from public.campaign_insight_runs q where q.company_id = a.company_id and q.campaign_id = a.id
     and q.status in ('queued', 'running')) as running
   from public.ad_campaigns a
   left join lateral (select r.id, r.finished_at from public.campaign_insight_runs r
    where r.company_id = a.company_id and r.campaign_id = a.id and r.status = 'done'
    order by r.finished_at desc nulls last limit 1) l on true
   left join public.campaign_insights i on i.company_id = a.company_id and i.campaign_id = a.id
    and i.status = 'new' and (i.last_seen_run = l.id or i.snooze_until is not null)
   where a.company_id = p_company and a.id = any(coalesce(p_campaigns, '{}'))
    and mavi_private.campaign_insight_reader(p_company, a.id)
   group by a.id) x
  where x.open > 0 or x.running), '[]'));
end $$;

-- ------------------------------------------------------------ status, tarefas e avaliação
create function public.set_campaign_insight_status(p_company uuid, p_insight uuid, p_status text,
 p_reason text default null, p_comment text default '', p_until timestamptz default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare i public.campaign_insights; v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
 v_comment text := left(btrim(coalesce(p_comment, '')), 500); v_label text; begin
 select * into i from public.campaign_insights where company_id = p_company and id = p_insight for update;
 if not found or not mavi_private.campaign_insight_reader(p_company, i.campaign_id) then
  raise exception 'Sem permissão' using errcode = '42501';
 end if;
 if p_status = 'applied' then
  update public.campaign_insights set status = 'applied', status_at = now(), status_by = auth.uid(),
   status_reason = '', snooze_until = null, applied_at = now(), effect = null, effect_at = null
  where id = i.id;
 elsif p_status = 'dismissed' then
  if v_reason is null or v_reason not in ('wrong', 'not_actionable', 'known', 'client', 'timing', 'other') then
   raise exception 'Escolha o motivo do descarte.' using errcode = '22023';
  end if;
  if v_reason = 'other' and v_comment = '' then
   raise exception 'Conte o motivo do descarte.' using errcode = '22023';
  end if;
  v_label := case v_reason when 'wrong' then 'Os números não mostram isso' when 'not_actionable' then 'Não dá para aplicar'
   when 'known' then 'Já sabíamos ou já fazemos' when 'client' then 'Restrição do cliente'
   when 'timing' then 'Não é o momento' else 'Outro motivo' end;
  update public.campaign_insights set status = 'dismissed', status_at = now(), status_by = auth.uid(),
   status_reason = left(v_label || case when v_comment <> '' then ': ' || v_comment else '' end, 300), snooze_until = null
  where id = i.id;
  -- O descarte ensina a MAVI.
  insert into public.campaign_insight_feedback(company_id, user_id, leader, insight_id, campaign_id, client_id,
   product_id, vote, reason, comment)
  select p_company, auth.uid(), mavi_private.leader(p_company), i.id, i.campaign_id, k.client_id, k.product_id,
   'dismiss', v_reason, v_comment
  from public.ad_campaigns a join public.contracts k on k.company_id = a.company_id and k.id = a.contract_id
  where a.company_id = p_company and a.id = i.campaign_id
  on conflict (user_id, insight_id) do update set vote = 'dismiss', reason = excluded.reason,
   comment = excluded.comment, leader = excluded.leader, learned_at = null, updated_at = now();
 elsif p_status = 'snoozed' then
  if p_until is null or p_until <= now() + interval '5 minutes' or p_until > now() + interval '120 days' then
   raise exception 'Escolha quando o insight volta (até 120 dias).' using errcode = '22023';
  end if;
  update public.campaign_insights set status = 'snoozed', status_at = now(), status_by = auth.uid(),
   status_reason = '', snooze_until = p_until
  where id = i.id;
 elsif p_status = 'new' then
  update public.campaign_insights set status = 'new', status_at = now(), status_by = auth.uid(), status_reason = '',
   snooze_until = null, applied_at = null, effect = null, effect_at = null
  where id = i.id;
 else
  raise exception 'Status inválido.' using errcode = '22023';
 end if;
 insert into public.campaign_insight_events(company_id, insight_id, user_id, action, reason, detail)
 values (p_company, i.id, auth.uid(), case p_status when 'new' then 'reopened' else p_status end,
  coalesce(v_label, ''), case when p_status = 'snoozed' then jsonb_build_object('until', p_until)
   when p_status = 'dismissed' and v_comment <> '' then jsonb_build_object('comment', v_comment) else '{}' end);
 perform mavi_private.broadcast(p_company, jsonb_build_object('kind', 'campaign_insights', 'campaign', i.campaign_id,
  'run', null, 'status', p_status));
 return (select mavi_private.campaign_insight_json(x) from public.campaign_insights x where x.id = i.id);
end $$;

-- 👍 / 👎 (com motivo e comentário opcionais); nulo tira o voto.
create function public.vote_campaign_insight(p_company uuid, p_insight uuid, p_vote text,
 p_reason text default null, p_comment text default '') returns jsonb
language plpgsql security definer set search_path = '' as $$
declare i public.campaign_insights; begin
 select * into i from public.campaign_insights where company_id = p_company and id = p_insight;
 if not found or not mavi_private.campaign_insight_reader(p_company, i.campaign_id) then
  raise exception 'Sem permissão' using errcode = '42501';
 end if;
 if p_vote is null then
  delete from public.campaign_insight_feedback where insight_id = i.id and user_id = auth.uid() and vote <> 'dismiss';
 elsif p_vote in ('up', 'down') then
  if p_reason is not null and p_reason not in ('wrong', 'not_actionable', 'known', 'client', 'timing', 'other') then
   raise exception 'Motivo inválido.' using errcode = '22023';
  end if;
  insert into public.campaign_insight_feedback(company_id, user_id, leader, insight_id, campaign_id, client_id,
   product_id, vote, reason, comment)
  select p_company, auth.uid(), mavi_private.leader(p_company), i.id, i.campaign_id, k.client_id, k.product_id,
   p_vote, case when p_vote = 'down' then p_reason end, left(btrim(coalesce(p_comment, '')), 500)
  from public.ad_campaigns a join public.contracts k on k.company_id = a.company_id and k.id = a.contract_id
  where a.company_id = p_company and a.id = i.campaign_id
  on conflict (user_id, insight_id) do update set vote = excluded.vote, reason = excluded.reason,
   comment = excluded.comment, leader = excluded.leader, learned_at = null, updated_at = now();
 else
  raise exception 'Voto inválido.' using errcode = '22023';
 end if;
 return (select mavi_private.campaign_insight_json(x) from public.campaign_insights x where x.id = i.id);
end $$;

create function public.link_campaign_insight_task(p_company uuid, p_insight uuid, p_task uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare i public.campaign_insights; begin
 select * into i from public.campaign_insights where company_id = p_company and id = p_insight;
 if not found or not mavi_private.campaign_insight_reader(p_company, i.campaign_id) then
  raise exception 'Sem permissão' using errcode = '42501';
 end if;
 if not exists (select 1 from public.tasks where company_id = p_company and id = p_task)
  or (not mavi_private.leader(p_company) and not mavi_private.task_access(p_company, p_task)) then
  raise exception 'Tarefa não encontrada.' using errcode = 'P0002';
 end if;
 insert into public.campaign_insight_tasks(company_id, insight_id, task_id, created_by)
 values (p_company, i.id, p_task, auth.uid()) on conflict do nothing;
 insert into public.campaign_insight_events(company_id, insight_id, user_id, action, detail)
 values (p_company, i.id, auth.uid(), 'task', jsonb_build_object('task', p_task));
 perform mavi_private.broadcast(p_company, jsonb_build_object('kind', 'campaign_insights', 'campaign', i.campaign_id,
  'run', null, 'status', 'task'));
end $$;

create function public.unlink_campaign_insight_task(p_company uuid, p_insight uuid, p_task uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare i public.campaign_insights; begin
 select * into i from public.campaign_insights where company_id = p_company and id = p_insight;
 if not found or not mavi_private.campaign_insight_reader(p_company, i.campaign_id) then
  raise exception 'Sem permissão' using errcode = '42501';
 end if;
 delete from public.campaign_insight_tasks where insight_id = i.id and task_id = p_task;
end $$;

-- O histórico de um insight (quem aplicou, descartou, adiou…).
create function public.campaign_insight_events(p_company uuid, p_insight uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare i public.campaign_insights; begin
 select * into i from public.campaign_insights where company_id = p_company and id = p_insight;
 if not found or not mavi_private.campaign_insight_reader(p_company, i.campaign_id) then
  raise exception 'Sem permissão' using errcode = '42501';
 end if;
 return coalesce((select jsonb_agg(jsonb_build_object('action', e.action, 'reason', e.reason, 'detail', e.detail,
   'created_at', e.created_at, 'user_name', (select m.name from public.memberships m
    where m.company_id = e.company_id and m.user_id = e.user_id)) order by e.created_at desc)
  from public.campaign_insight_events e where e.insight_id = i.id), '[]');
end $$;

-- ------------------------------------------------------------ aprendizados (líderes)
create function mavi_private.campaign_insight_lesson_json(l public.campaign_insight_lessons) returns jsonb
language sql stable security definer set search_path = '' as $$
 select jsonb_build_object('id', l.id, 'scope', l.scope, 'client_id', l.client_id, 'product_id', l.product_id,
  'client_name', (select c.name from public.clients c where c.company_id = l.company_id and c.id = l.client_id),
  'product_name', (select p.name from public.products p where p.company_id = l.company_id and p.id = l.product_id),
  'kind', l.kind, 'text', l.text, 'status', l.status, 'origin', l.origin, 'people', l.people,
  'has_leader', l.has_leader, 'ups', l.ups, 'downs', l.downs, 'reviewed_at', l.reviewed_at,
  'created_at', l.created_at, 'updated_at', l.updated_at)
$$;

create function public.campaign_insight_lessons(p_company uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$ begin
 if not mavi_private.leader(p_company) then raise exception 'Sem permissão' using errcode = '42501'; end if;
 return jsonb_build_object(
  'lessons', coalesce((select jsonb_agg(mavi_private.campaign_insight_lesson_json(l)
    order by case l.status when 'active' then 0 when 'candidate' then 1 when 'paused' then 2 else 3 end,
     l.reviewed_at nulls first, l.updated_at desc)
   from public.campaign_insight_lessons l where l.company_id = p_company and l.status <> 'dismissed'), '[]'),
  'pending', (select count(*)::int from public.campaign_insight_feedback f
   where f.company_id = p_company and f.learned_at is null),
  'feedback_30d', (select count(*)::int from public.campaign_insight_feedback f
   where f.company_id = p_company and f.updated_at > now() - interval '30 days'));
end $$;

-- Criar ou editar um aprendizado à mão (vale na hora).
create function public.save_campaign_insight_lesson(p_company uuid, p_lesson jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_id uuid := case when p_lesson->>'id' ~* '^[0-9a-f-]{36}$' then (p_lesson->>'id')::uuid end;
 v_scope text := coalesce(p_lesson->>'scope', 'company'); v_text text := btrim(coalesce(p_lesson->>'text', ''));
 v_client uuid := case when p_lesson->>'client_id' ~* '^[0-9a-f-]{36}$' then (p_lesson->>'client_id')::uuid end;
 v_product uuid := case when p_lesson->>'product_id' ~* '^[0-9a-f-]{36}$' then (p_lesson->>'product_id')::uuid end;
 v_kind text := case when p_lesson->>'kind' in ('highlight', 'opportunity', 'problem', 'tracking') then p_lesson->>'kind' end;
begin
 if not mavi_private.leader(p_company) then
  raise exception 'Só administradores e gestores editam os aprendizados.' using errcode = '42501';
 end if;
 if length(v_text) not between 5 and 400 then raise exception 'Escreva o aprendizado (5 a 400 caracteres).' using errcode = '22023'; end if;
 if v_scope not in ('company', 'product', 'client') or (v_scope = 'client' and v_client is null)
  or (v_scope = 'product' and v_product is null) then
  raise exception 'Escolha para quem vale o aprendizado.' using errcode = '22023';
 end if;
 if v_id is null then
  insert into public.campaign_insight_lessons(company_id, scope, client_id, product_id, kind, text, status, origin,
   reviewed_by, reviewed_at, updated_by)
  values (p_company, v_scope, case when v_scope = 'client' then v_client end, case when v_scope = 'product' then v_product end,
   v_kind, v_text, 'active', 'person', auth.uid(), now(), auth.uid());
 else
  update public.campaign_insight_lessons set scope = v_scope, client_id = case when v_scope = 'client' then v_client end,
   product_id = case when v_scope = 'product' then v_product end, kind = v_kind, text = v_text,
   status = case when status in ('candidate', 'dismissed') then 'active' else status end,
   reviewed_by = auth.uid(), reviewed_at = now(), updated_by = auth.uid(), updated_at = now()
  where company_id = p_company and id = v_id;
  if not found then raise exception 'Aprendizado não encontrado.' using errcode = 'P0002'; end if;
 end if;
 return public.campaign_insight_lessons(p_company);
end $$;

-- review: conferido; pause / activate / dismiss.
create function public.set_campaign_insight_lesson(p_company uuid, p_lesson uuid, p_action text) returns jsonb
language plpgsql security definer set search_path = '' as $$ begin
 if not mavi_private.leader(p_company) then
  raise exception 'Só administradores e gestores editam os aprendizados.' using errcode = '42501';
 end if;
 if p_action not in ('review', 'pause', 'activate', 'dismiss') then raise exception 'Ação inválida.' using errcode = '22023'; end if;
 update public.campaign_insight_lessons set
  status = case p_action when 'pause' then 'paused' when 'activate' then 'active' when 'dismiss' then 'dismissed' else status end,
  reviewed_by = auth.uid(), reviewed_at = now(), updated_at = now(), updated_by = auth.uid()
 where company_id = p_company and id = p_lesson;
 if not found then raise exception 'Aprendizado não encontrado.' using errcode = 'P0002'; end if;
 return public.campaign_insight_lessons(p_company);
end $$;

-- ------------------------------------------------------------ contexto da MAVI
-- Os insights da campanha para a conversa com a MAVI (quando ligado).
create function public.campaign_insights_ai(p_company uuid, p_campaign uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare s public.campaign_insight_settings; v_latest uuid; begin
 if not mavi_private.campaign_insight_reader(p_company, p_campaign) then return null; end if;
 s := mavi_private.campaign_insight_config(p_company);
 if not s.enabled or not s.mavi_context then return null; end if;
 select r.id into v_latest from public.campaign_insight_runs r where r.company_id = p_company
  and r.campaign_id = p_campaign and r.status = 'done' order by r.finished_at desc nulls last limit 1;
 return jsonb_build_object(
  'money_basis', s.money_basis,
  'open', coalesce((select jsonb_agg(jsonb_build_object('priority', i.priority, 'kind', i.kind, 'title', i.title,
    'action', i.action, 'evidence', i.evidence) order by mavi_private.campaign_insight_rank(i.priority) desc)
   from (select * from public.campaign_insights i where i.company_id = p_company and i.campaign_id = p_campaign
    and i.status = 'new' and (i.last_seen_run = v_latest or i.snooze_until is not null) limit 8) i), '[]'),
  'applied', coalesce((select jsonb_agg(jsonb_build_object('title', i.title, 'applied_at', i.applied_at,
    'effect', i.effect) order by i.applied_at desc)
   from (select * from public.campaign_insights i where i.company_id = p_company and i.campaign_id = p_campaign
    and i.status = 'applied' order by i.applied_at desc limit 5) i), '[]'),
  'dismissed', coalesce((select jsonb_agg(jsonb_build_object('title', i.title, 'reason', i.status_reason))
   from (select * from public.campaign_insights i where i.company_id = p_company and i.campaign_id = p_campaign
    and i.status = 'dismissed' order by i.status_at desc limit 5) i), '[]'));
end $$;

-- ------------------------------------------------------------ worker
-- A da migração 20270327090000, com os aplicados (antes × depois), os
-- aprendizados do time e o motivo dos descartados.
create or replace function public.ai_campaign_insight_material(p_secret text, p_run uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare r public.campaign_insight_runs; a public.ad_campaigns; y public.ad_cycles; k public.contracts;
 s public.campaign_insight_settings; v_block text; v_today date; begin
 if not mavi_private.ai_secret_ok(p_secret) then raise exception 'Sem permissão' using errcode = '42501'; end if;
 select * into r from public.campaign_insight_runs where id = p_run;
 if not found then return null; end if;
 v_block := mavi_private.campaign_insight_blocker(r.company_id, r.campaign_id);
 if v_block is not null then return jsonb_build_object('blocked', v_block); end if;
 select * into a from public.ad_campaigns where company_id = r.company_id and id = r.campaign_id;
 select * into y from public.ad_cycles where company_id = a.company_id and id = a.current_cycle_id;
 select * into k from public.contracts where company_id = a.company_id and id = a.contract_id;
 s := mavi_private.campaign_insight_config(r.company_id);
 v_today := mavi_private.company_today(r.company_id);
 return jsonb_build_object(
  'run', jsonb_build_object('id', r.id, 'trigger', r.trigger),
  'company_id', r.company_id,
  'today', v_today,
  'timezone', mavi_private.company_tz(r.company_id),
  'campaign', jsonb_build_object('id', a.id, 'name', a.name, 'platform', a.platform, 'notes', left(a.notes, 1500)),
  'client', (select jsonb_build_object('id', c.id, 'name', c.name) from public.clients c
   where c.company_id = k.company_id and c.id = k.client_id),
  'product', (select jsonb_build_object('id', p.id, 'name', p.name) from public.products p
   where p.company_id = k.company_id and p.id = k.product_id),
  'contract_id', k.id,
  'cycle', jsonb_build_object('id', y.id, 'start_date', y.start_date, 'end_date', y.end_date,
   'objective', y.objective, 'destination', y.destination, 'goal_results', y.goal_results, 'budget', y.budget,
   'multiplier', y.multiplier, 'niche', y.niche, 'meta_conversions', y.meta_conversions,
   'conversion_actions', to_jsonb(y.conversion_actions)),
  'links', coalesce((select jsonb_agg(jsonb_build_object('account_id', l.account_id,
    'campaign_id', l.external_campaign_id, 'manager_id', l.manager_id) order by l.account_id, l.external_campaign_id)
   from public.ad_cycle_links l where l.company_id = y.company_id and l.cycle_id = y.id), '[]'),
  'meta_tokens', case when a.platform = 'meta' then (select jsonb_object_agg(m.account_id,
    jsonb_build_object('token_cipher', m.token_cipher, 'expires_at', m.token_expires_at))
   from mavi_private.ad_meta_accounts m where m.company_id = y.company_id and m.account_id in
    (select l.account_id from public.ad_cycle_links l where l.company_id = y.company_id and l.cycle_id = y.id)) end,
  'google_token', case when a.platform = 'google' then (select jsonb_build_object('refresh_token_cipher',
    g.refresh_token_cipher) from mavi_private.ad_google_connections g where g.company_id = y.company_id) end,
  'crm_company_id', (select l.crm_company_id from public.client_crm_links l
   where l.company_id = k.company_id and l.client_id = k.client_id),
  -- Os números do ciclo como o MAVI conta (as "Conversões que contam").
  'daily', coalesce((select jsonb_agg(jsonb_build_object('day', d.day, 'spend', d.spend,
    'conversions', d.conversions, 'clicks', d.clicks, 'impressions', d.impressions, 'multiplier', d.multiplier)
    order by d.day)
   from public.ad_daily_metrics d where d.company_id = y.company_id and d.cycle_id = y.id and d.day < v_today), '[]'),
  'settings', jsonb_build_object('money_basis', s.money_basis, 'run_cap_usd', s.run_cap_usd,
   'min_new_days', s.min_new_days),
  'last_done_at', (select max(x.finished_at) from public.campaign_insight_runs x where x.company_id = r.company_id
   and x.campaign_id = r.campaign_id and x.status = 'done' and x.id <> r.id),
  'previous', coalesce((select jsonb_agg(jsonb_build_object('kind', i.kind, 'priority', i.priority,
    'title', i.title, 'fingerprint', i.fingerprint, 'status', i.status, 'seen_count', i.seen_count,
    'last_seen_at', i.last_seen_at, 'status_reason', nullif(i.status_reason, '')) order by i.last_seen_at desc)
   from (select * from public.campaign_insights i where i.company_id = r.company_id and i.campaign_id = r.campaign_id
    order by i.last_seen_at desc limit 20) i), '[]'),
  'context', jsonb_build_object(
   'dossier', coalesce((select jsonb_agg(jsonb_build_object('kind', d.kind, 'text', d.text))
    from (select * from public.client_dossier_items d where d.company_id = k.company_id and d.client_id = k.client_id
     and not d.dismissed order by d.pinned desc, d.created_at desc limit 25) d), '[]'),
   'radar', coalesce((select jsonb_agg(jsonb_build_object('topic', t.name, 'title', i.title,
     'summary', left(i.summary, 400), 'severity', i.severity, 'mentions', i.mentions, 'last_seen', i.last_seen_at::date))
    from (select i.* from public.radar_items i join public.radar_topics t on t.id = i.topic_id
     where i.company_id = k.company_id and i.client_id = k.client_id
      and coalesce(mavi_private.radar_status(t.statuses, i.status)->>'kind', '') <> 'closed'
      and i.last_seen_at > now() - interval '90 days'
     order by i.severity desc nulls last, i.last_seen_at desc limit 10) i
    join public.radar_topics t on t.id = i.topic_id), '[]'),
   'temperature', (select jsonb_build_object('score', round(t.score), 'summary', left(t.summary, 800))
    from mavi_private.temperature_state t where t.client_id = k.client_id and t.company_id = k.company_id
     and t.score is not null),
   'meetings', coalesce((select jsonb_agg(jsonb_build_object('title', x.title, 'date', x.occurred_at::date,
     'text', x.text) order by x.occurred_at desc)
    from (select d.title, d.occurred_at, (select left(string_agg(c.content, E'\n' order by c.ord), 1500)
      from public.ai_chunks c where c.document_id = d.id and c.meta->>'kind' = 'summary') as text
     from public.ai_documents d where d.client_id = k.client_id and d.source_type = 'meeting'
      and d.occurred_at > now() - interval '60 days'
     order by d.occurred_at desc limit 3) x where x.text is not null), '[]')),
  'jev', mavi_private.campaign_insight_jev_route(r.company_id),
  -- Os aplicados nos últimos 30 dias (para medir antes × depois).
  'applied', coalesce((select jsonb_agg(jsonb_build_object('id', i.id, 'title', i.title, 'kind', i.kind,
    'target', i.target, 'applied_at', i.applied_at, 'effect', i.effect) order by i.applied_at desc)
   from (select * from public.campaign_insights i where i.company_id = r.company_id and i.campaign_id = r.campaign_id
    and i.status = 'applied' and i.applied_at > now() - interval '30 days' order by i.applied_at desc limit 5) i), '[]'),
  -- Os aprendizados do time que valem para este cliente.
  'lessons', coalesce((select jsonb_agg(jsonb_build_object('scope', l.scope, 'kind', l.kind, 'text', l.text)
    order by case l.scope when 'client' then 0 when 'product' then 1 else 2 end, l.updated_at desc)
   from (select * from public.campaign_insight_lessons l where l.company_id = r.company_id and l.status = 'active'
    and (l.scope = 'company' or (l.scope = 'client' and l.client_id = k.client_id)
     or (l.scope = 'product' and l.product_id = k.product_id))
    order by case l.scope when 'client' then 0 when 'product' then 1 else 2 end, l.updated_at desc limit 25) l), '[]'));
end $$;

-- A da migração 20270327090000: o descartado, o aplicado e o adiado não
-- voltam como novos; e o efeito medido dos aplicados.
create or replace function public.ai_campaign_insight_store(p_secret text, p_run uuid, p_result jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare r public.campaign_insight_runs; s public.campaign_insight_settings; v jsonb := coalesce(p_result, '{}');
 u jsonb; x jsonb; v_cost numeric := 0; v_client uuid; v_contract uuid; v_new integer := 0; v_again integer := 0;
 v_old uuid; v_basis text; v_notify integer := 0; v_status text; v_first text; v_high integer := 0;
 v_name text; begin
 if not mavi_private.ai_secret_ok(p_secret) then raise exception 'Sem permissão' using errcode = '42501'; end if;
 select * into r from public.campaign_insight_runs where id = p_run for update;
 if not found or r.status <> 'running' then return jsonb_build_object('ok', false); end if;
 s := mavi_private.campaign_insight_config(r.company_id);
 select k.client_id, k.id, a.name into v_client, v_contract, v_name from public.ad_campaigns a
 join public.contracts k on k.company_id = a.company_id and k.id = a.contract_id
 where a.company_id = r.company_id and a.id = r.campaign_id;
 v_basis := case when v->>'money_basis' in ('net', 'gross') then v->>'money_basis' else s.money_basis end;
 v_status := case when v->>'status' = 'skipped' then 'skipped' else 'done' end;

 for u in select * from jsonb_array_elements(case when jsonb_typeof(v->'usage') = 'array' then v->'usage' else '[]' end)
 loop
  insert into public.ai_usage(company_id, user_id, module, kind, client_id, contract_id, model, input_tokens,
   output_tokens, cache_read_tokens, cache_write_tokens, cost_usd, provider_id, provider_name)
  values (r.company_id, r.requested_by, 'campaign_insights', left(coalesce(u->>'kind', 'campaign_insights'), 40),
   v_client, v_contract, left(coalesce(u->>'model', ''), 80), greatest(coalesce((u->>'input')::int, 0), 0),
   greatest(coalesce((u->>'output')::int, 0), 0), greatest(coalesce((u->>'cache_read')::int, 0), 0),
   greatest(coalesce((u->>'cache_write')::int, 0), 0), least(greatest(coalesce((u->>'cost')::numeric, 0), 0), 20),
   case when u->>'provider_id' ~* '^[0-9a-f-]{36}$' then (u->>'provider_id')::uuid end,
   left(coalesce(u->>'provider', ''), 120));
  v_cost := v_cost + least(greatest(coalesce((u->>'cost')::numeric, 0), 0), 20);
 end loop;

 if v_status = 'done' then
  for x in select * from jsonb_array_elements(case when jsonb_typeof(v->'insights') = 'array' then v->'insights'
   else '[]' end)
  loop
   continue when x->>'kind' not in ('highlight', 'opportunity', 'problem', 'tracking')
    or x->>'priority' not in ('high', 'medium', 'low') or length(btrim(coalesce(x->>'title', ''))) < 3
    or jsonb_typeof(x->'evidence') <> 'array' or jsonb_array_length(x->'evidence') not between 1 and 8
    or length(coalesce(x->>'fingerprint', '')) < 3;
   -- O mesmo assunto descartado (60 dias), aplicado (30 dias) ou adiado não volta como novo.
   continue when exists (select 1 from public.campaign_insights i where i.company_id = r.company_id
    and i.campaign_id = r.campaign_id and i.fingerprint = left(x->>'fingerprint', 300)
    and ((i.status = 'dismissed' and i.status_at > now() - interval '60 days')
     or (i.status = 'applied' and i.applied_at > now() - interval '30 days')
     or i.status = 'snoozed'));
   select i.id into v_old from public.campaign_insights i where i.company_id = r.company_id
    and i.campaign_id = r.campaign_id and i.status = 'new' and i.fingerprint = left(x->>'fingerprint', 300)
    and i.last_seen_at > now() - interval '45 days'
   order by i.last_seen_at desc limit 1;
   if v_old is not null then
    update public.campaign_insights set last_seen_run = r.id, last_seen_at = now(), seen_count = seen_count + 1,
     kind = x->>'kind', priority = x->>'priority', title = left(btrim(x->>'title'), 200),
     body = left(coalesce(x->>'body', ''), 2000), action = left(coalesce(x->>'action', ''), 800),
     evidence = x->'evidence', target = case when jsonb_typeof(x->'target') = 'object' then x->'target' end,
     money_basis = v_basis, confidence = case when x->>'confidence' ~ '^[0-9.]+$'
      then least(greatest((x->>'confidence')::numeric, 0), 1) end
    where id = v_old;
    v_again := v_again + 1;
   else
    insert into public.campaign_insights(company_id, campaign_id, run_id, last_seen_run, kind, priority, title, body,
     action, evidence, target, source, fingerprint, money_basis, confidence)
    values (r.company_id, r.campaign_id, r.id, r.id, x->>'kind', x->>'priority', left(btrim(x->>'title'), 200),
     left(coalesce(x->>'body', ''), 2000), left(coalesce(x->>'action', ''), 800), x->'evidence',
     case when jsonb_typeof(x->'target') = 'object' then x->'target' end,
     case when x->>'source' = 'rule' then 'rule' else 'mavi' end, left(x->>'fingerprint', 300), v_basis,
     case when x->>'confidence' ~ '^[0-9.]+$' then least(greatest((x->>'confidence')::numeric, 0), 1) end);
    v_new := v_new + 1;
    if mavi_private.campaign_insight_rank(x->>'priority') >= mavi_private.campaign_insight_rank(s.notify_min_priority)
    then
     v_notify := v_notify + 1;
     v_first := coalesce(v_first, left(btrim(x->>'title'), 200));
     if x->>'priority' = 'high' then v_high := v_high + 1; end if;
    end if;
   end if;
  end loop;
 end if;

 update public.campaign_insight_runs set status = v_status, finished_at = now(), claimed_until = null,
  cost_usd = v_cost, summary = left(coalesce(v->>'summary', ''), 600), note = left(coalesce(v->>'note', ''), 1000),
  money_basis = v_basis, multiplier = case when v->>'multiplier' ~ '^[0-9.]+$' then (v->>'multiplier')::numeric end,
  windows = case when jsonb_typeof(v->'windows') = 'object' then v->'windows' else '{}' end,
  model = left(coalesce(v->>'model', ''), 120), provider_name = left(coalesce(v->>'provider', ''), 120),
  insights_count = v_new, repeated_count = v_again,
  api_calls = case when jsonb_typeof(v->'api_calls') = 'object' then v->'api_calls' else '{}' end,
  tokens = case when jsonb_typeof(v->'tokens') = 'object' then v->'tokens' else '{}' end
 where id = r.id;

 -- O efeito medido dos aplicados (antes × depois).
 for x in select * from jsonb_array_elements(case when jsonb_typeof(v->'effects') = 'array' then v->'effects' else '[]' end)
 loop
  continue when x->>'insight' !~* '^[0-9a-f-]{36}$' or jsonb_typeof(x->'effect') <> 'object';
  update public.campaign_insights set effect = x->'effect', effect_at = now()
  where id = (x->>'insight')::uuid and company_id = r.company_id and campaign_id = r.campaign_id and status = 'applied';
 end loop;

 -- Caixa de entrada + push: quem atende o cliente (e os líderes, se pedido)
 -- e quem pediu a análise. Um aviso por pessoa por análise.
 if v_status = 'done' and s.notify_inbox and (v_notify > 0 or (r.trigger = 'manual' and r.requested_by is not null))
 then
  insert into public.notifications(company_id, user_id, actor_id, task_id, kind, title, body, link, client_id)
  select r.company_id, m.user_id, null, null, 'campaign_insight', left(format('Insights da MAVI: %s', v_name), 300),
   left(case when v_notify > 0 then format('%s %s%s · %s', v_notify,
     case when v_notify = 1 then 'insight novo' else 'insights novos' end,
     case when v_high > 0 then format(' (%s de prioridade alta)', v_high) else '' end, v_first)
    when v_new + v_again > 0 then format('Análise pronta: %s %s.', v_new + v_again,
     case when v_new + v_again = 1 then 'insight' else 'insights' end)
    else 'Análise pronta: nada novo que mereça ação agora.' end, 300),
   '/campanhas/' || r.campaign_id || '?aba=insights', v_client
  from public.memberships m
  where m.company_id = r.company_id and m.active
   and mavi_private.campaign_alert_sees(r.company_id, m.user_id, v_client)
   and ((m.user_id = r.requested_by)
    or (v_notify > 0 and (exists (select 1 from public.client_teams ct join public.team_members tm
       on tm.company_id = ct.company_id and tm.team_id = ct.team_id
      where ct.company_id = r.company_id and ct.client_id = v_client and tm.user_id = m.user_id)
     or (s.notify_who = 'team_leaders' and m.role in ('admin', 'manager')))));
 end if;

 perform mavi_private.broadcast(r.company_id, jsonb_build_object('kind', 'campaign_insights',
  'campaign', r.campaign_id, 'run', r.id, 'status', v_status));
 return jsonb_build_object('ok', true, 'new', v_new, 'repeated', v_again);
end $$;

-- A da migração 20270327090000, com a volta do "Lembrar depois".
create or replace function mavi_private.campaign_insight_tick() returns integer
language plpgsql security definer set search_path = '' as $$
declare s public.campaign_insight_settings; a record; v_n integer := 0; v_month date; begin
 -- "Lembrar depois": chegou a data, o insight volta para os abertos e quem
 -- adiou recebe o lembrete.
 for a in
  update public.campaign_insights i set status = 'new', status_at = now()
  where i.status = 'snoozed' and i.snooze_until <= now()
  returning i.id, i.company_id, i.campaign_id, i.title, i.status_by
 loop
  insert into public.campaign_insight_events(company_id, insight_id, user_id, action)
  values (a.company_id, a.id, null, 'returned');
  if a.status_by is not null then
   insert into public.notifications(company_id, user_id, actor_id, task_id, kind, title, body, link, client_id)
   select a.company_id, a.status_by, null, null, 'campaign_insight', left(format('Lembrete: %s', a.title), 300),
    left(format('O insight que você deixou para depois voltou · %s', c.name), 300),
    '/campanhas/' || a.campaign_id || '?aba=insights', mavi_private.ad_campaign_client(a.campaign_id)
   from public.ad_campaigns c where c.id = a.campaign_id;
  end if;
  perform mavi_private.broadcast(a.company_id, jsonb_build_object('kind', 'campaign_insights', 'campaign', a.campaign_id,
   'run', null, 'status', 'returned'));
 end loop;
 -- Reservas vencidas depois da última tentativa: falhou.
 update public.campaign_insight_runs set status = 'failed', finished_at = now(),
  note = left('A análise não terminou depois de 3 tentativas.', 1000)
 where status = 'running' and claimed_until < now() and attempts >= 3;
 for s in select * from public.campaign_insight_settings where enabled loop
  if mavi_private.campaign_insight_capped(s.company_id) then
   v_month := date_trunc('month', now() at time zone mavi_private.company_tz(s.company_id))::date;
   if s.cap_noticed_month is distinct from v_month then
    update public.campaign_insight_settings set cap_noticed_month = v_month where company_id = s.company_id;
    insert into public.notifications(company_id, user_id, actor_id, task_id, kind, title, body, link)
    select s.company_id, m.user_id, null, null, 'campaign_insight',
     'Insights das campanhas pausados: teto do mês',
     left(format('O gasto do mês chegou a US$ %s (teto de US$ %s). As análises voltam quando o mês virar ou quando o teto subir.',
      to_char(mavi_private.campaign_insight_spent(s.company_id), 'FM999990.00'),
      to_char(s.monthly_cap_usd, 'FM999990.00')), 300),
     '/mavi#campanhas'
    from public.memberships m where m.company_id = s.company_id and m.active and m.role in ('admin', 'manager');
   end if;
   continue;
  end if;
  for a in
   select x.id from public.ad_campaigns x
   where x.company_id = s.company_id and x.status = 'active' and not x.archived and x.platform in ('meta', 'google')
    and not exists (select 1 from public.campaign_insight_runs r where r.company_id = x.company_id
     and r.campaign_id = x.id and r.status in ('queued', 'running'))
   order by x.id
  loop
   continue when mavi_private.campaign_insight_blocker(s.company_id, a.id) is not null;
   continue when not mavi_private.campaign_insight_due(s.company_id, a.id);
   insert into public.campaign_insight_runs(company_id, campaign_id, cycle_id, trigger, local_day)
   select s.company_id, a.id, x.current_cycle_id, 'schedule', mavi_private.company_today(s.company_id)
   from public.ad_campaigns x where x.id = a.id;
   v_n := v_n + 1;
   exit when v_n >= 200;
  end loop;
 end loop;
 return v_n;
end $$;

-- A da migração 20270327090000: acorda também para aprender com as avaliações.
create or replace function mavi_private.campaign_insight_kick() returns void
language plpgsql security definer set search_path = '' as $$ begin
 begin
  perform mavi_private.campaign_insight_tick();
 exception when others then
  raise warning 'campaign insights tick failed: %', sqlerrm;
 end;
 if exists (select 1 from public.campaign_insight_runs r where r.status in ('queued', 'running')
  and coalesce(r.claimed_until, '-infinity') < now() and r.attempts < 3)
  or exists (select 1 from mavi_private.campaign_insight_learning_due()) then
  perform mavi_private.campaign_insight_post();
 end if;
end $$;

-- As avaliações de uma empresa para a MAVI transformar em aprendizados.
create function public.ai_campaign_insight_learning_claim(p_secret text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_company uuid; begin
 if not mavi_private.ai_secret_ok(p_secret) then raise exception 'Sem permissão' using errcode = '42501'; end if;
 select c into v_company from mavi_private.campaign_insight_learning_due() c limit 1;
 if v_company is null then return null; end if;
 insert into mavi_private.campaign_insight_learning_state(company_id, claimed_until, attempts)
 values (v_company, now() + interval '5 minutes', 1)
 on conflict (company_id) do update set claimed_until = excluded.claimed_until,
  attempts = mavi_private.campaign_insight_learning_state.attempts + 1;
 return jsonb_build_object(
  'company', v_company,
  'feedback', coalesce((select jsonb_agg(jsonb_build_object('id', f.id, 'vote', f.vote, 'reason', f.reason,
    'comment', f.comment, 'leader', f.leader, 'kind', i.kind, 'priority', i.priority, 'title', i.title,
    'body', left(i.body, 600), 'action', left(i.action, 300), 'client_id', f.client_id, 'product_id', f.product_id,
    'client_name', (select c.name from public.clients c where c.company_id = f.company_id and c.id = f.client_id),
    'product_name', (select p.name from public.products p where p.company_id = f.company_id and p.id = f.product_id),
    'campaign_name', (select a.name from public.ad_campaigns a where a.company_id = f.company_id and a.id = f.campaign_id))
    order by f.updated_at)
   from (select * from public.campaign_insight_feedback f where f.company_id = v_company and f.learned_at is null
    order by f.updated_at limit 60) f
   join public.campaign_insights i on i.id = f.insight_id), '[]'),
  'lessons', coalesce((select jsonb_agg(jsonb_build_object('id', l.id, 'scope', l.scope, 'client_id', l.client_id,
    'product_id', l.product_id, 'kind', l.kind, 'text', l.text, 'status', l.status, 'origin', l.origin))
   from public.campaign_insight_lessons l where l.company_id = v_company and l.status in ('active', 'candidate', 'paused')), '[]'));
end $$;

-- Aplica o que a MAVI propôs (add / update / retire), com a regra das evidências.
create function public.ai_campaign_insight_learning_store(p_secret text, p_company uuid, p_ops jsonb,
 p_learned bigint[], p_usage jsonb) returns integer
language plpgsql security definer set search_path = '' as $$
declare o jsonb; v_changed integer := 0; v_id uuid; v_scope text; v_text text; v_kind text; v_ids bigint[];
 v_client uuid; v_product uuid; v_n integer; begin
 if not mavi_private.ai_secret_ok(p_secret) then raise exception 'Sem permissão' using errcode = '42501'; end if;
 for o in select * from jsonb_array_elements(case when jsonb_typeof(p_ops) = 'array' then p_ops else '[]' end) loop
  v_text := btrim(coalesce(o->>'text', ''));
  v_kind := case when o->>'kind' in ('highlight', 'opportunity', 'problem', 'tracking') then o->>'kind' end;
  v_ids := array(select (x)::bigint from jsonb_array_elements_text(case when jsonb_typeof(o->'feedback') = 'array'
   then o->'feedback' else '[]' end) x where x ~ '^\d+$');
  v_id := case when o->>'id' ~* '^[0-9a-f-]{36}$' then (o->>'id')::uuid end;
  if o->>'op' = 'add' then
   v_scope := o->>'scope';
   v_client := case when v_scope = 'client' and o->>'client_id' ~* '^[0-9a-f-]{36}$' then (o->>'client_id')::uuid end;
   v_product := case when v_scope = 'product' and o->>'product_id' ~* '^[0-9a-f-]{36}$' then (o->>'product_id')::uuid end;
   continue when v_scope not in ('company', 'product', 'client') or length(v_text) not between 5 and 400
    or cardinality(v_ids) = 0 or (v_scope = 'client' and v_client is null) or (v_scope = 'product' and v_product is null);
   continue when v_scope = 'client' and not exists (select 1 from public.clients where company_id = p_company and id = v_client);
   continue when v_scope = 'product' and not exists (select 1 from public.products where company_id = p_company and id = v_product);
   continue when exists (select 1 from public.campaign_insight_lessons l where l.company_id = p_company
    and lower(l.text) = lower(v_text));
   continue when (select count(*) from public.campaign_insight_lessons l where l.company_id = p_company
    and l.status in ('active', 'candidate')) >= 150;
   insert into public.campaign_insight_lessons(company_id, scope, client_id, product_id, kind, text, status, origin)
   values (p_company, v_scope, v_client, v_product, v_kind, v_text, 'candidate', 'mavi') returning id into v_id;
   perform mavi_private.campaign_insight_lesson_evidence(v_id, v_ids);
   v_changed := v_changed + 1;
  elsif o->>'op' = 'update' and v_id is not null then
   update public.campaign_insight_lessons l set text = case when length(v_text) between 5 and 400 then v_text else l.text end,
    kind = coalesce(v_kind, l.kind), updated_at = now(), updated_by = null,
    reviewed_at = case when length(v_text) between 5 and 400 and v_text <> l.text then null else l.reviewed_at end,
    reviewed_by = case when length(v_text) between 5 and 400 and v_text <> l.text then null else l.reviewed_by end
   where l.id = v_id and l.company_id = p_company and l.origin = 'mavi' and l.status in ('active', 'candidate');
   get diagnostics v_n = row_count;
   if v_n > 0 then
    perform mavi_private.campaign_insight_lesson_evidence(v_id, v_ids);
    v_changed := v_changed + 1;
   end if;
  elsif o->>'op' = 'retire' and v_id is not null then
   delete from public.campaign_insight_lessons l
   where l.id = v_id and l.company_id = p_company and l.origin = 'mavi' and l.status in ('active', 'candidate');
   get diagnostics v_n = row_count; v_changed := v_changed + v_n;
  end if;
 end loop;
 update public.campaign_insight_feedback set learned_at = now()
 where company_id = p_company and id = any(coalesce(p_learned, '{}')) and learned_at is null;
 update mavi_private.campaign_insight_learning_state set claimed_until = null, attempts = 0, last_error = null,
  built_at = now() where company_id = p_company;
 if p_usage is not null and jsonb_typeof(p_usage) = 'object' then
  insert into public.ai_usage(company_id, user_id, module, kind, model, input_tokens, output_tokens,
   cache_read_tokens, cache_write_tokens, cost_usd, provider_id, provider_name)
  values (p_company, null, 'campaign_insights', 'campaign_insights_learning', left(coalesce(p_usage->>'model', ''), 80),
   greatest(coalesce((p_usage->>'input')::integer, 0), 0), greatest(coalesce((p_usage->>'output')::integer, 0), 0),
   greatest(coalesce((p_usage->>'cache_read')::integer, 0), 0),
   greatest(coalesce((p_usage->>'cache_write')::integer, 0), 0),
   least(greatest(coalesce((p_usage->>'cost')::numeric, 0), 0), 20),
   case when p_usage->>'provider_id' ~* '^[0-9a-f-]{36}$' then (p_usage->>'provider_id')::uuid end,
   left(coalesce(p_usage->>'provider', ''), 120));
 end if;
 return v_changed;
end $$;

create function public.ai_campaign_insight_learning_fail(p_secret text, p_company uuid, p_error text) returns void
language plpgsql security definer set search_path = '' as $$ begin
 if not mavi_private.ai_secret_ok(p_secret) then raise exception 'Sem permissão' using errcode = '42501'; end if;
 update mavi_private.campaign_insight_learning_state
 set claimed_until = now() + make_interval(mins => 10 * greatest(attempts, 1)), last_error = left(coalesce(p_error, ''), 500)
 where company_id = p_company;
end $$;

-- ------------------------------------------------------------ permissões
revoke all on function mavi_private.campaign_insight_lesson_json(public.campaign_insight_lessons)
 from public, anon, authenticated;
revoke all on function public.set_campaign_insight_status(uuid, uuid, text, text, text, timestamptz),
 public.vote_campaign_insight(uuid, uuid, text, text, text), public.link_campaign_insight_task(uuid, uuid, uuid),
 public.unlink_campaign_insight_task(uuid, uuid, uuid), public.campaign_insight_events(uuid, uuid),
 public.campaign_insight_lessons(uuid), public.save_campaign_insight_lesson(uuid, jsonb),
 public.set_campaign_insight_lesson(uuid, uuid, text), public.campaign_insights_ai(uuid, uuid) from public, anon;
grant execute on function public.set_campaign_insight_status(uuid, uuid, text, text, text, timestamptz),
 public.vote_campaign_insight(uuid, uuid, text, text, text), public.link_campaign_insight_task(uuid, uuid, uuid),
 public.unlink_campaign_insight_task(uuid, uuid, uuid), public.campaign_insight_events(uuid, uuid),
 public.campaign_insight_lessons(uuid), public.save_campaign_insight_lesson(uuid, jsonb),
 public.set_campaign_insight_lesson(uuid, uuid, text), public.campaign_insights_ai(uuid, uuid) to authenticated;
revoke all on function public.ai_campaign_insight_learning_claim(text),
 public.ai_campaign_insight_learning_store(text, uuid, jsonb, bigint[], jsonb),
 public.ai_campaign_insight_learning_fail(text, uuid, text) from public, anon, authenticated;
grant execute on function public.ai_campaign_insight_learning_claim(text),
 public.ai_campaign_insight_learning_store(text, uuid, jsonb, bigint[], jsonb),
 public.ai_campaign_insight_learning_fail(text, uuid, text) to anon, authenticated;

notify pgrst, 'reload schema';

commit;
