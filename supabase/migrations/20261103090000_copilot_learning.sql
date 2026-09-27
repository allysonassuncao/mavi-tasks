begin;

-- MAVI · o Assistente MAVI das tarefas aprende com o feedback do time.
--
-- - Cada 👍/👎 num alerta é gravado na hora (copilot_feedback), com o motivo
--   e o comentário do 👎. Mudar de ideia troca o voto (um por pessoa, por
--   alerta, por abertura do formulário).
-- - O worker (/api/ai, ação "ai-learning", funcionalidade 'copilot_learning'
--   do Painel da MAVI) lê os feedbacks novos de cada empresa e cria, ajusta
--   ou aposenta aprendizados (copilot_lessons) da empresa, de um produto ou
--   de um cliente. Um aprendizado só entra em uso com evidência: feedback de
--   pelo menos 2 pessoas ou de um líder; antes disso fica "aguardando".
-- - Os aprendizados ativos vão no prompt de cada análise (logo depois do
--   dossiê, na parte que fica em cache).
-- - Administradores e gestores conferem tudo no Painel da MAVI › Copiloto:
--   números por tipo de alerta, aprendizados (novos, ativos, aguardando,
--   pausados) e os feedbacks. Aprendizado editado por líder fica com ele; o
--   que um líder exclui a MAVI não recria.
--
-- Agendamento: supabase/operations/schedule-copilot-learning.sql.

-- ------------------------------------------------------------ funcionalidade
alter table mavi_private.ai_routes drop constraint ai_routes_feature_check;
alter table mavi_private.ai_routes add constraint ai_routes_feature_check
 check ((scope_type = 'feature') = (feature is not null)
  and (feature is null or feature in ('assistant', 'meetings_history', 'meetings_ask', 'whatsapp_task',
   'social_leads_plan', 'social_leads_adjust', 'social_leads_briefing', 'social_leads_colors',
   'task_copilot', 'client_dossier', 'copilot_learning')));

create or replace function public.ai_set_route(p_company uuid, p_type text, p_id uuid, p_provider uuid, p_model text,
 p_feature text default null) returns void
language plpgsql security definer set search_path = '' as $$
declare v_id uuid := case when p_type in ('company', 'feature') then null else p_id end;
 v_feature text := case when p_type = 'feature' then p_feature end; begin
 if not mavi_private.admin(p_company) then
  raise exception 'Só administradores escolhem qual IA cada um usa.' using errcode = '42501';
 end if;
 if p_type not in ('company', 'user', 'client', 'contract', 'project', 'feature') then
  raise exception 'Tipo inválido.' using errcode = '22023';
 end if;
 if p_type not in ('company', 'feature') and p_id is null then
  raise exception 'Escolha para quem vale a regra.' using errcode = '22023';
 end if;
 if p_type = 'feature' and coalesce(v_feature, '') not in ('assistant', 'meetings_history', 'meetings_ask',
  'whatsapp_task', 'social_leads_plan', 'social_leads_adjust', 'social_leads_briefing', 'social_leads_colors',
  'task_copilot', 'client_dossier', 'copilot_learning') then
  raise exception 'Funcionalidade inválida.' using errcode = '22023';
 end if;
 if p_provider is null then
  delete from mavi_private.ai_routes where company_id = p_company and scope_type = p_type
   and scope_id is not distinct from v_id and feature is not distinct from v_feature;
  return;
 end if;
 if not exists (select 1 from mavi_private.ai_providers p where p.id = p_provider and p.company_id = p_company
   and exists (select 1 from jsonb_array_elements(p.models) m where m->>'id' = p_model)) then
  raise exception 'Escolha um modelo cadastrado no provedor.' using errcode = '22023';
 end if;
 if p_type = 'user' and not exists (select 1 from public.memberships where company_id = p_company and user_id = p_id)
  or p_type = 'client' and not exists (select 1 from public.clients where company_id = p_company and id = p_id)
  or p_type = 'contract' and not exists (select 1 from public.contracts where company_id = p_company and id = p_id)
  or p_type = 'project' and not exists (select 1 from public.projects where company_id = p_company and id = p_id) then
  raise exception 'Não encontrado na empresa.' using errcode = 'P0002';
 end if;
 insert into mavi_private.ai_routes(company_id, scope_type, scope_id, feature, provider_id, model)
 values (p_company, p_type, v_id, v_feature, p_provider, p_model)
 on conflict on constraint ai_routes_scope_key do update set provider_id = excluded.provider_id,
  model = excluded.model, updated_by = auth.uid(), updated_at = now();
end $$;

-- ------------------------------------------------------------ feedback
create table public.copilot_feedback (
 id bigint generated always as identity primary key,
 company_id uuid not null references public.companies(id),
 user_id uuid not null default auth.uid(),
 -- Líder quando votou (o feedback de líder basta para um aprendizado).
 leader boolean not null default false,
 -- Uma abertura do formulário (o navegador gera).
 session_id uuid not null,
 alert_key text not null check (length(alert_key) between 1 and 200),
 client_id uuid,
 contract_id uuid,
 product_id uuid,
 task_id uuid,
 kind text not null check (kind in ('error', 'avoids', 'prefers', 'duplicate', 'missing', 'suggestion', 'case')),
 severity text not null default 'medium' check (severity in ('high', 'medium', 'low')),
 alert_title text not null default '',
 alert_text text not null default '',
 draft_title text not null default '',
 vote text not null check (vote in ('up', 'down')),
 -- Só no 👎: não se aplica, informação errada, óbvio, já estava na tarefa, outro.
 reason text check (reason in ('not_applicable', 'wrong', 'obvious', 'already', 'other')),
 comment text not null default '' check (length(comment) <= 500),
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 -- Nulo: o worker ainda não aprendeu com este feedback.
 learned_at timestamptz,
 unique (user_id, session_id, alert_key)
);
create index copilot_feedback_company on public.copilot_feedback (company_id, created_at desc);
create index copilot_feedback_pending on public.copilot_feedback (company_id, updated_at) where learned_at is null;
alter table public.copilot_feedback enable row level security;
revoke all on public.copilot_feedback from public, anon, authenticated;

-- ------------------------------------------------------------ aprendizados
create table public.copilot_lessons (
 id uuid primary key default gen_random_uuid(),
 company_id uuid not null references public.companies(id),
 scope text not null check (scope in ('company', 'product', 'client')),
 client_id uuid,
 product_id uuid,
 -- O tipo de alerta a que se refere (nulo: todos).
 kind text check (kind in ('error', 'avoids', 'prefers', 'duplicate', 'missing', 'suggestion', 'case')),
 text text not null check (length(btrim(text)) between 5 and 400),
 -- active: em uso · candidate: aguardando evidência · paused: pausado por
 -- líder · dismissed: excluído por líder (a MAVI não recria).
 status text not null check (status in ('active', 'candidate', 'paused', 'dismissed')),
 origin text not null check (origin in ('mavi', 'person')),
 -- Feedbacks que sustentam (ids, até 60), pessoas distintas e se há líder.
 evidence bigint[] not null default '{}',
 people integer not null default 0,
 has_leader boolean not null default false,
 ups integer not null default 0,
 downs integer not null default 0,
 -- Conferido por um líder (nulo: aparece como novo).
 reviewed_by uuid,
 reviewed_at timestamptz,
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 updated_by uuid,
 check ((scope = 'client') = (client_id is not null)),
 check ((scope = 'product') = (product_id is not null))
);
create index copilot_lessons_company on public.copilot_lessons (company_id, status);
alter table public.copilot_lessons enable row level security;
revoke all on public.copilot_lessons from public, anon, authenticated;

create table mavi_private.copilot_learning_state (
 company_id uuid primary key,
 dirty_at timestamptz,
 claimed_at timestamptz,
 running_until timestamptz,
 built_at timestamptz,
 attempts integer not null default 0,
 last_error text
);
revoke all on mavi_private.copilot_learning_state from public, anon, authenticated;

-- Feedback novo ou mudado: a empresa tem o que aprender.
create function mavi_private.copilot_feedback_touch() returns trigger
language plpgsql security definer set search_path = '' as $$ begin
 insert into mavi_private.copilot_learning_state(company_id, dirty_at) values (new.company_id, now())
 on conflict (company_id) do update set dirty_at = coalesce(copilot_learning_state.dirty_at, now());
 return null;
end $$;
create trigger copilot_feedback_learn after insert or update of vote, reason, comment on public.copilot_feedback
 for each row execute function mavi_private.copilot_feedback_touch();

-- Os aprendizados em uso para uma análise: da empresa, do produto e do
-- cliente (os mais específicos e mais sustentados primeiro; até 30).
create function mavi_private.copilot_lessons_for(c uuid, p_product uuid, p_client uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
 select coalesce(jsonb_agg(jsonb_build_object('id', l.id, 'scope', l.scope, 'kind', l.kind, 'text', l.text)
  order by l.ord, l.people desc, l.updated_at desc), '[]')
 from (
  select x.*, case x.scope when 'client' then 1 when 'product' then 2 else 3 end as ord
  from public.copilot_lessons x
  where x.company_id = c and x.status = 'active'
   and (x.scope = 'company' or (x.scope = 'product' and x.product_id = p_product)
    or (x.scope = 'client' and x.client_id = p_client))
  order by ord, x.people desc, x.updated_at desc
  limit 30
 ) l
$$;

-- 👍/👎 num alerta (p_vote nulo tira o voto). Grava na hora.
create function public.copilot_feedback_vote(p_company uuid, p_contract uuid, p_task uuid, p_session uuid,
 p_alert jsonb, p_vote text, p_reason text default null, p_comment text default null) returns void
language plpgsql security definer set search_path = '' as $$
declare v_client uuid; v_product uuid; v_key text := left(coalesce(p_alert->>'key', ''), 200); begin
 if not mavi_private.member(p_company) then raise exception 'Sem acesso' using errcode = '42501'; end if;
 if p_session is null or v_key = '' then raise exception 'Alerta inválido.' using errcode = '22023'; end if;
 if p_task is not null then
  if not mavi_private.task_access(p_company, p_task) then
   raise exception 'Sem acesso a esta tarefa.' using errcode = '42501';
  end if;
  select t.contract_id into p_contract from public.tasks t where t.company_id = p_company and t.id = p_task;
 end if;
 select ct.client_id, ct.product_id into v_client, v_product from public.contracts ct
 where ct.company_id = p_company and ct.id = p_contract;
 if v_client is null then raise exception 'Produto não encontrado.' using errcode = 'P0002'; end if;
 if p_task is null and not mavi_private.dossier_reader(p_company, v_client) then
  raise exception 'Sem acesso a este cliente.' using errcode = '42501';
 end if;
 if p_vote is null then
  delete from public.copilot_feedback where user_id = auth.uid() and session_id = p_session and alert_key = v_key;
  return;
 end if;
 if p_vote not in ('up', 'down') then raise exception 'Voto inválido.' using errcode = '22023'; end if;
 if coalesce(p_alert->>'kind', '') not in ('error', 'avoids', 'prefers', 'duplicate', 'missing', 'suggestion', 'case')
 then raise exception 'Alerta inválido.' using errcode = '22023'; end if;
 insert into public.copilot_feedback(company_id, leader, session_id, alert_key, client_id, contract_id, product_id,
  task_id, kind, severity, alert_title, alert_text, draft_title, vote, reason, comment)
 values (p_company, mavi_private.leader(p_company), p_session, v_key, v_client, p_contract, v_product, p_task,
  p_alert->>'kind', case when p_alert->>'severity' in ('high', 'low') then p_alert->>'severity' else 'medium' end,
  left(coalesce(p_alert->>'title', ''), 200), left(coalesce(p_alert->>'text', ''), 600),
  left(coalesce(p_alert->>'draft', ''), 200), p_vote,
  case when p_vote = 'down' and p_reason in ('not_applicable', 'wrong', 'obvious', 'already', 'other')
   then p_reason end,
  case when p_vote = 'down' then left(btrim(coalesce(p_comment, '')), 500) else '' end)
 on conflict (user_id, session_id, alert_key) do update set vote = excluded.vote, reason = excluded.reason,
  comment = excluded.comment, task_id = coalesce(excluded.task_id, copilot_feedback.task_id),
  updated_at = now(), learned_at = null;
end $$;

-- A tarefa foi criada: os votos daquela abertura passam a apontar para ela.
create function public.copilot_feedback_attach(p_company uuid, p_session uuid, p_task uuid) returns void
language plpgsql security definer set search_path = '' as $$ begin
 if not mavi_private.task_access(p_company, p_task) then
  raise exception 'Sem acesso a esta tarefa.' using errcode = '42501';
 end if;
 update public.copilot_feedback set task_id = p_task
 where company_id = p_company and user_id = auth.uid() and session_id = p_session and task_id is null;
end $$;

-- ------------------------------------------------------------ Painel da MAVI › Copiloto
create function mavi_private.copilot_lesson_json(l public.copilot_lessons) returns jsonb
language sql stable security definer set search_path = '' as $$
 select jsonb_build_object('id', l.id, 'scope', l.scope, 'client_id', l.client_id, 'product_id', l.product_id,
  'kind', l.kind, 'text', l.text, 'status', l.status, 'origin', l.origin, 'people', l.people,
  'has_leader', l.has_leader, 'ups', l.ups, 'downs', l.downs, 'feedbacks', cardinality(l.evidence),
  'reviewed_by', l.reviewed_by, 'reviewed_at', l.reviewed_at, 'created_at', l.created_at,
  'updated_at', l.updated_at, 'updated_by', l.updated_by)
$$;

-- Tudo da aba: números por tipo de alerta no período, aprendizados e os
-- feedbacks (os mais recentes; p_vote filtra).
create function public.copilot_learning_report(p_company uuid, p_from date, p_to date, p_vote text default null,
 p_limit integer default 100, p_offset integer default 0) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_from timestamptz := p_from::timestamptz; v_to timestamptz := (p_to + 1)::timestamptz;
 st mavi_private.copilot_learning_state; begin
 if not mavi_private.leader(p_company) then
  raise exception 'Só administradores e gestores veem o aprendizado do copiloto.' using errcode = '42501';
 end if;
 select * into st from mavi_private.copilot_learning_state where company_id = p_company;
 return jsonb_build_object(
  'kinds', (select coalesce(jsonb_agg(jsonb_build_object('kind', k.kind, 'up', k.up, 'down', k.down,
     'applied', k.applied, 'dismissed', k.dismissed, 'ignored', k.ignored) order by k.kind), '[]')
   from (
    select kind, sum(up)::int as up, sum(down)::int as down, sum(applied)::int as applied,
     sum(dismissed)::int as dismissed, sum(ignored)::int as ignored
    from (
     select f.kind, (f.vote = 'up')::int as up, (f.vote = 'down')::int as down, 0 as applied, 0 as dismissed,
      0 as ignored
     from public.copilot_feedback f
     where f.company_id = p_company and f.updated_at >= v_from and f.updated_at < v_to
     union all
     select e.kind, 0, 0, (e.action = 'applied')::int, (e.action = 'dismissed')::int, (e.action = 'ignored')::int
     from public.task_copilot_events e
     where e.company_id = p_company and e.created_at >= v_from and e.created_at < v_to
      and e.action in ('applied', 'dismissed', 'ignored')
    ) u group by kind
   ) k),
  'reasons', (select coalesce(jsonb_object_agg(r.reason, r.n), '{}') from (
    select f.reason, count(*)::int as n from public.copilot_feedback f
    where f.company_id = p_company and f.vote = 'down' and f.reason is not null
     and f.updated_at >= v_from and f.updated_at < v_to group by f.reason) r),
  'lessons', (select coalesce(jsonb_agg(mavi_private.copilot_lesson_json(l)
    order by (l.reviewed_at is null and l.status <> 'dismissed') desc,
     case l.status when 'active' then 1 when 'candidate' then 2 when 'paused' then 3 else 4 end, l.updated_at desc), '[]')
   from public.copilot_lessons l where l.company_id = p_company),
  'feedback', (select coalesce(jsonb_agg(jsonb_build_object('id', f.id, 'user_id', f.user_id, 'client_id', f.client_id,
     'product_id', f.product_id, 'task_id', f.task_id, 'kind', f.kind, 'severity', f.severity,
     'alert_title', f.alert_title, 'alert_text', f.alert_text, 'draft_title', f.draft_title, 'vote', f.vote,
     'reason', f.reason, 'comment', f.comment, 'at', f.updated_at, 'learned', f.learned_at is not null)
    order by f.updated_at desc), '[]')
   from (select * from public.copilot_feedback f
    where f.company_id = p_company and f.updated_at >= v_from and f.updated_at < v_to
     and (p_vote is null or f.vote = p_vote)
    order by f.updated_at desc
    limit least(greatest(coalesce(p_limit, 100), 1), 200) offset greatest(coalesce(p_offset, 0), 0)) f),
  'feedback_total', (select count(*)::int from public.copilot_feedback f
    where f.company_id = p_company and f.updated_at >= v_from and f.updated_at < v_to
     and (p_vote is null or f.vote = p_vote)),
  'pending', (select count(*)::int from public.copilot_feedback f
    where f.company_id = p_company and f.learned_at is null),
  'learned_at', st.built_at);
end $$;

-- Um líder escreve (novo) ou corrige um aprendizado: fica com ele, em uso.
create function public.copilot_lesson_save(p_company uuid, p_id uuid, p_scope text, p_client uuid, p_product uuid,
 p_kind text, p_text text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_id uuid; begin
 if not mavi_private.leader(p_company) then
  raise exception 'Só administradores e gestores editam os aprendizados.' using errcode = '42501';
 end if;
 if coalesce(p_scope, '') not in ('company', 'product', 'client') then
  raise exception 'Escolha onde vale o aprendizado.' using errcode = '22023';
 end if;
 if p_kind is not null and p_kind not in ('error', 'avoids', 'prefers', 'duplicate', 'missing', 'suggestion', 'case')
 then raise exception 'Tipo inválido.' using errcode = '22023'; end if;
 if length(btrim(coalesce(p_text, ''))) not between 5 and 400 then
  raise exception 'Escreva de 5 a 400 caracteres.' using errcode = '22023';
 end if;
 if p_scope = 'client' and not exists (select 1 from public.clients where company_id = p_company and id = p_client)
  or p_scope = 'product' and not exists (select 1 from public.products where company_id = p_company and id = p_product)
 then raise exception 'Não encontrado na empresa.' using errcode = 'P0002'; end if;
 if p_id is null then
  insert into public.copilot_lessons(company_id, scope, client_id, product_id, kind, text, status, origin,
   reviewed_by, reviewed_at, updated_by)
  values (p_company, p_scope, case when p_scope = 'client' then p_client end,
   case when p_scope = 'product' then p_product end, p_kind, btrim(p_text), 'active', 'person', auth.uid(), now(),
   auth.uid())
  returning id into v_id;
 else
  update public.copilot_lessons set scope = p_scope, client_id = case when p_scope = 'client' then p_client end,
   product_id = case when p_scope = 'product' then p_product end, kind = p_kind, text = btrim(p_text),
   origin = 'person', status = case when status in ('candidate', 'dismissed') then 'active' else status end,
   reviewed_by = auth.uid(), reviewed_at = now(), updated_by = auth.uid(), updated_at = now()
  where id = p_id and company_id = p_company returning id into v_id;
  if v_id is null then raise exception 'Aprendizado não encontrado.' using errcode = 'P0002'; end if;
 end if;
 return v_id;
end $$;

-- Conferir, pausar, ativar ou excluir (a MAVI não recria o excluído).
create function public.copilot_lesson_set(p_company uuid, p_id uuid, p_action text) returns void
language plpgsql security definer set search_path = '' as $$ begin
 if not mavi_private.leader(p_company) then
  raise exception 'Só administradores e gestores editam os aprendizados.' using errcode = '42501';
 end if;
 if p_action not in ('review', 'pause', 'activate', 'dismiss') then
  raise exception 'Ação inválida.' using errcode = '22023';
 end if;
 update public.copilot_lessons set
  status = case p_action when 'pause' then 'paused' when 'activate' then 'active' when 'dismiss' then 'dismissed'
   else status end,
  reviewed_by = auth.uid(), reviewed_at = now(), updated_by = auth.uid(), updated_at = now()
 where id = p_id and company_id = p_company;
 if not found then raise exception 'Aprendizado não encontrado.' using errcode = 'P0002'; end if;
end $$;

-- ------------------------------------------------------------ worker do aprendizado
-- Empresas com feedback novo parado há 10 min (ou 20 feedbacks esperando).
create function mavi_private.copilot_learning_due() returns table(company_id uuid)
language sql stable security definer set search_path = '' as $$
 select s.company_id from mavi_private.copilot_learning_state s
 where s.dirty_at is not null and s.attempts < 5
  and (s.running_until is null or s.running_until < now())
  and (s.dirty_at <= now() - interval '10 minutes'
   or (select count(*) from public.copilot_feedback f where f.company_id = s.company_id and f.learned_at is null) >= 20)
$$;

create function public.ai_learning_claim(p_secret text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_company uuid; begin
 if not mavi_private.ai_secret_ok(p_secret) then raise exception 'Sem permissão' using errcode = '42501'; end if;
 select s.company_id into v_company from mavi_private.copilot_learning_state s
 where s.company_id in (select d.company_id from mavi_private.copilot_learning_due() d)
 order by s.dirty_at limit 1 for update skip locked;
 if v_company is null then return null; end if;
 update mavi_private.copilot_learning_state set claimed_at = now(), running_until = now() + interval '4 minutes'
 where company_id = v_company;
 return jsonb_build_object('company', v_company,
  -- Os feedbacks ainda não aprendidos (os mais antigos primeiro; até 150).
  'feedback', (select coalesce(jsonb_agg(jsonb_build_object('id', f.id, 'user', f.user_id, 'leader', f.leader,
     'client_id', f.client_id, 'client', k.name, 'product_id', f.product_id, 'product', p.name, 'kind', f.kind,
     'severity', f.severity, 'title', f.alert_title, 'text', f.alert_text, 'draft', f.draft_title, 'vote', f.vote,
     'reason', f.reason, 'comment', f.comment, 'at', f.updated_at) order by f.updated_at), '[]')
   from (select * from public.copilot_feedback x where x.company_id = v_company and x.learned_at is null
    order by x.updated_at limit 150) f
   left join public.clients k on k.company_id = f.company_id and k.id = f.client_id
   left join public.products p on p.company_id = f.company_id and p.id = f.product_id),
  'lessons', (select coalesce(jsonb_agg(jsonb_build_object('id', l.id, 'scope', l.scope, 'client_id', l.client_id,
     'client', k.name, 'product_id', l.product_id, 'product', p.name, 'kind', l.kind, 'text', l.text,
     'status', l.status, 'origin', l.origin, 'people', l.people) order by l.updated_at desc), '[]')
   from public.copilot_lessons l
   left join public.clients k on k.company_id = l.company_id and k.id = l.client_id
   left join public.products p on p.company_id = l.company_id and p.id = l.product_id
   where l.company_id = v_company));
end $$;

-- Recalcula a evidência de um aprendizado e decide se ele entra em uso.
create function mavi_private.copilot_lesson_evidence(p_id uuid, p_add bigint[]) returns void
language plpgsql security definer set search_path = '' as $$
declare l public.copilot_lessons; v_ids bigint[]; begin
 select * into l from public.copilot_lessons where id = p_id for update;
 select coalesce(array_agg(distinct x order by x desc), '{}') into v_ids
 from unnest(l.evidence || coalesce(p_add, '{}')) x
 where exists (select 1 from public.copilot_feedback f where f.id = x and f.company_id = l.company_id);
 v_ids := v_ids[1:60];
 update public.copilot_lessons c set evidence = v_ids,
  people = (select count(distinct f.user_id) from public.copilot_feedback f where f.id = any(v_ids)),
  has_leader = exists (select 1 from public.copilot_feedback f where f.id = any(v_ids) and f.leader),
  ups = (select count(*) from public.copilot_feedback f where f.id = any(v_ids) and f.vote = 'up'),
  downs = (select count(*) from public.copilot_feedback f where f.id = any(v_ids) and f.vote = 'down')
 where c.id = p_id;
 -- Entra em uso com 2 pessoas ou um líder; pausado/excluído por líder não muda.
 update public.copilot_lessons c set status = case when c.people >= 2 or c.has_leader then 'active' else 'candidate' end
 where c.id = p_id and c.status in ('active', 'candidate') and c.origin = 'mavi';
end $$;

-- Aplica as mudanças que a MAVI propôs e marca os feedbacks como aprendidos.
-- add: {scope, client_id, product_id, kind, text, feedback[]} · update: {id,
-- text, kind, feedback[]} · retire: {id}. Só mexe em aprendizados da MAVI
-- ainda não editados por líder; não recria um excluído (mesmo texto).
create function public.ai_learning_store(p_secret text, p_company uuid, p_ops jsonb, p_learned bigint[],
 p_usage jsonb) returns integer
language plpgsql security definer set search_path = '' as $$
declare o jsonb; v_changed integer := 0; v_id uuid; v_scope text; v_text text; v_kind text; v_ids bigint[];
 v_client uuid; v_product uuid; v_n integer; begin
 if not mavi_private.ai_secret_ok(p_secret) then raise exception 'Sem permissão' using errcode = '42501'; end if;
 for o in select * from jsonb_array_elements(case when jsonb_typeof(p_ops) = 'array' then p_ops else '[]' end) loop
  v_text := btrim(coalesce(o->>'text', ''));
  v_kind := case when o->>'kind' in ('error', 'avoids', 'prefers', 'duplicate', 'missing', 'suggestion', 'case')
   then o->>'kind' end;
  v_ids := array(select (x)::bigint from jsonb_array_elements_text(case when jsonb_typeof(o->'feedback') = 'array'
   then o->'feedback' else '[]' end) x where x ~ '^\d+$');
  v_id := case when o->>'id' ~* '^[0-9a-f-]{36}$' then (o->>'id')::uuid end;
  if o->>'op' = 'add' then
   v_scope := o->>'scope';
   v_client := case when v_scope = 'client' and o->>'client_id' ~* '^[0-9a-f-]{36}$' then (o->>'client_id')::uuid end;
   v_product := case when v_scope = 'product' and o->>'product_id' ~* '^[0-9a-f-]{36}$'
    then (o->>'product_id')::uuid end;
   continue when v_scope not in ('company', 'product', 'client') or length(v_text) not between 5 and 400
    or cardinality(v_ids) = 0 or (v_scope = 'client' and v_client is null) or (v_scope = 'product' and v_product is null);
   continue when v_scope = 'client' and not exists (select 1 from public.clients where company_id = p_company and id = v_client);
   continue when v_scope = 'product' and not exists (select 1 from public.products where company_id = p_company and id = v_product);
   continue when exists (select 1 from public.copilot_lessons l where l.company_id = p_company
    and lower(l.text) = lower(v_text));
   continue when (select count(*) from public.copilot_lessons l where l.company_id = p_company
    and l.status in ('active', 'candidate')) >= 200;
   insert into public.copilot_lessons(company_id, scope, client_id, product_id, kind, text, status, origin)
   values (p_company, v_scope, v_client, v_product, v_kind, v_text, 'candidate', 'mavi') returning id into v_id;
   perform mavi_private.copilot_lesson_evidence(v_id, v_ids);
   v_changed := v_changed + 1;
  elsif o->>'op' = 'update' and v_id is not null then
   update public.copilot_lessons l set text = case when length(v_text) between 5 and 400 then v_text else l.text end,
    kind = coalesce(v_kind, l.kind), updated_at = now(), updated_by = null,
    -- Mudou o texto: volta a aparecer como novo para os líderes.
    reviewed_at = case when length(v_text) between 5 and 400 and v_text <> l.text then null else l.reviewed_at end,
    reviewed_by = case when length(v_text) between 5 and 400 and v_text <> l.text then null else l.reviewed_by end
   where l.id = v_id and l.company_id = p_company and l.origin = 'mavi' and l.status in ('active', 'candidate');
   get diagnostics v_n = row_count;
   if v_n > 0 then
    perform mavi_private.copilot_lesson_evidence(v_id, v_ids);
    v_changed := v_changed + 1;
   end if;
  elsif o->>'op' = 'retire' and v_id is not null then
   delete from public.copilot_lessons l
   where l.id = v_id and l.company_id = p_company and l.origin = 'mavi' and l.status in ('active', 'candidate');
   get diagnostics v_n = row_count; v_changed := v_changed + v_n;
  end if;
 end loop;
 update public.copilot_feedback set learned_at = now()
 where company_id = p_company and id = any(coalesce(p_learned, '{}')) and learned_at is null;
 update mavi_private.copilot_learning_state s set built_at = now(), running_until = null, attempts = 0,
  last_error = null,
  dirty_at = case when exists (select 1 from public.copilot_feedback f where f.company_id = p_company
   and f.learned_at is null) then coalesce(greatest(s.dirty_at, s.claimed_at), now()) else null end
 where s.company_id = p_company;
 if p_usage is not null and jsonb_typeof(p_usage) = 'object' then
  insert into public.ai_usage(company_id, user_id, module, kind, model, input_tokens, output_tokens,
   cache_read_tokens, cache_write_tokens, cost_usd, provider_id, provider_name)
  values (p_company, null, 'tasks', 'learning', left(coalesce(p_usage->>'model', ''), 80),
   greatest(coalesce((p_usage->>'input')::integer, 0), 0), greatest(coalesce((p_usage->>'output')::integer, 0), 0),
   greatest(coalesce((p_usage->>'cache_read')::integer, 0), 0),
   greatest(coalesce((p_usage->>'cache_write')::integer, 0), 0),
   least(greatest(coalesce((p_usage->>'cost')::numeric, 0), 0), 100),
   case when p_usage->>'provider_id' ~* '^[0-9a-f-]{36}$' then (p_usage->>'provider_id')::uuid end,
   left(coalesce(p_usage->>'provider', ''), 120));
 end if;
 return v_changed;
end $$;

create function public.ai_learning_fail(p_secret text, p_company uuid, p_error text) returns void
language plpgsql security definer set search_path = '' as $$ begin
 if not mavi_private.ai_secret_ok(p_secret) then raise exception 'Sem permissão' using errcode = '42501'; end if;
 update mavi_private.copilot_learning_state set attempts = attempts + 1, last_error = left(coalesce(p_error, ''), 500),
  running_until = now() + (attempts + 1) * interval '10 minutes'
 where company_id = p_company;
end $$;

create function mavi_private.ai_learning_kick() returns void
language plpgsql security definer set search_path = '' as $$
declare cfg mavi_private.ai_config; begin
 select * into cfg from mavi_private.ai_config where id;
 if not found then return; end if;
 if not exists (select 1 from mavi_private.copilot_learning_due()) then return; end if;
 perform net.http_post(url := cfg.url, body := '{"action":"ai-learning"}'::jsonb,
  headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || cfg.secret),
  timeout_milliseconds := 60000);
end $$;

-- ------------------------------------------------------------ copiloto
-- O contexto da análise passa a trazer os aprendizados em uso (lessons).
create or replace function public.task_copilot_context(p_company uuid, p_contract uuid, p_task uuid, p_embedding text,
 p_query text, p_review boolean default false) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_client uuid; v_product text; v_client_name text; v_vec extensions.halfvec(1536); v_similar jsonb;
 v_cases jsonb; v_evidence jsonb := '[]'; s mavi_private.client_dossier_state; v_reader boolean;
 v_visible uuid[]; v_product_id uuid; begin
 if not mavi_private.member(p_company) then raise exception 'Sem acesso' using errcode = '42501'; end if;
 if p_task is not null then
  if not mavi_private.task_access(p_company, p_task) then
   raise exception 'Sem acesso a esta tarefa.' using errcode = '42501';
  end if;
  select t.contract_id into p_contract from public.tasks t where t.company_id = p_company and t.id = p_task;
 end if;
 select ct.client_id, p.name, k.name, ct.product_id into v_client, v_product, v_client_name, v_product_id
 from public.contracts ct
 join public.products p on p.company_id = ct.company_id and p.id = ct.product_id
 join public.clients k on k.company_id = ct.company_id and k.id = ct.client_id
 where ct.company_id = p_company and ct.id = p_contract;
 if v_client is null then raise exception 'Produto não encontrado.' using errcode = 'P0002'; end if;
 if p_task is null and not mavi_private.dossier_reader(p_company, v_client) then
  raise exception 'Sem acesso a este cliente.' using errcode = '42501';
 end if;
 if p_review and (select count(*) from public.ai_usage u where u.company_id = p_company and u.user_id = auth.uid()
   and u.kind = 'copilot' and u.created_at > now() - interval '1 minute') >= 12 then
  return jsonb_build_object('throttled', true);
 end if;
 if nullif(p_embedding, '') is not null then v_vec := p_embedding::extensions.halfvec(1536); end if;

 -- Tarefas parecidas: as que a pessoa vê (busca híbrida) e, para quem
 -- atende o cliente, também as dos colegas pelo vetor — dessas, só o título
 -- e o status (restricted), para avisar que o pedido já existe.
 v_reader := mavi_private.dossier_reader(p_company, v_client);
 if not mavi_private.leader(p_company) then v_visible := mavi_private.ai_visible_tasks(p_company); end if;
 select coalesce(jsonb_agg(x order by (x->>'similarity')::numeric desc nulls last), '[]') into v_similar from (
  select case when b.restricted
   then jsonb_build_object('id', b.id, 'title', t.title, 'status', t.status, 'restricted', true,
    'similarity', round(b.sim::numeric, 3))
   else jsonb_build_object('id', b.id, 'title', t.title, 'status', t.status, 'restricted', false,
    'assignee', t.assignee_id, 'due', t.due_date, 'date', b.occurred_at,
    'snippet', left(btrim(regexp_replace(b.content, '^[^\n]*\n', '')), 400),
    'similarity', round(b.sim::numeric, 3)) end as x
  from (
   select distinct on (u.id) u.*, (v_visible is not null and not (u.id = any(v_visible))) as restricted
   from (
    select r.source_id as id, r.content, r.occurred_at, r.score,
     case when v_vec is not null and c.embedding is not null
      then 1 - (c.embedding operator(extensions.<=>) v_vec) end as sim
    from public.ai_search(p_company, p_embedding, p_query,
     jsonb_build_object('client', v_client, 'types', jsonb_build_array('task')), 16) r
    join public.ai_chunks c on c.id = r.chunk_id
    union all
    select k.* from (
     select d.source_id, c.content, c.occurred_at, 0::double precision,
      1 - (c.embedding operator(extensions.<=>) v_vec)
     from public.ai_chunks c join public.ai_documents d on d.id = c.document_id
     where v_reader and v_vec is not null and c.company_id = p_company and c.client_id = v_client
      and c.source_type = 'task' and c.embedding is not null
     order by c.embedding operator(extensions.<=>) v_vec limit 24
    ) k
   ) u
   where u.id is distinct from p_task
   order by u.id, u.sim desc nulls last, u.score desc
  ) b
  join public.tasks t on t.company_id = p_company and t.id = b.id and not t.archived
  order by b.sim desc nulls last limit 6
 ) z;

 select coalesce(jsonb_agg(x order by (x->>'similarity')::numeric desc nulls last), '[]') into v_cases from (
  select jsonb_build_object('id', b.source_id, 'title', b.title, 'date', b.occurred_at,
   'snippet', left(btrim(regexp_replace(b.content, '^[^\n]*\n', '')), 500),
   'similarity', round(b.sim::numeric, 3)) as x
  from (
   select distinct on (r.source_id) r.*, case when v_vec is not null and c.embedding is not null
     then 1 - (c.embedding operator(extensions.<=>) v_vec) end as sim
   from public.ai_search(p_company, p_embedding, p_query,
    jsonb_build_object('types', jsonb_build_array('success_case')), 8) r
   join public.ai_chunks c on c.id = r.chunk_id
   order by r.source_id, sim desc nulls last, r.score desc
  ) b
  order by b.sim desc nulls last limit 3
 ) t;

 if p_review then
  select coalesce(jsonb_agg(jsonb_build_object('type', r.source_type, 'id', r.source_id, 'title', r.title,
    'date', r.occurred_at, 'meta', r.meta, 'contract', r.contract_id, 'content', left(r.content, 1400))
   order by r.score desc), '[]') into v_evidence
  from public.ai_search(p_company, p_embedding, p_query,
   jsonb_build_object('client', v_client, 'types',
    jsonb_build_array('meeting', 'whatsapp', 'drive_file', 'social_briefing', 'social_plan', 'campaign')), 10) r;
  perform mavi_private.dossier_want(p_company, v_client);
  select * into s from mavi_private.client_dossier_state where client_id = v_client;
 end if;

 return jsonb_build_object('throttled', false,
  'client', jsonb_build_object('id', v_client, 'name', v_client_name), 'contract', p_contract, 'product', v_product,
  'similar', v_similar, 'cases', v_cases, 'evidence', v_evidence,
  'dossier', case when p_review then jsonb_build_object('version', coalesce(s.version, 0), 'built_at', s.built_at,
   'items', mavi_private.dossier_items_json(v_client, false)) end,
  -- O que a MAVI aprendeu com o feedback do time (empresa, produto, cliente).
  'lessons', case when p_review then mavi_private.copilot_lessons_for(p_company, v_product_id, v_client) end);
end $$;
-- ------------------------------------------------------------ permissões
revoke all on function mavi_private.copilot_feedback_touch(), mavi_private.copilot_lessons_for(uuid, uuid, uuid),
 mavi_private.copilot_lesson_json(public.copilot_lessons), mavi_private.copilot_learning_due(),
 mavi_private.copilot_lesson_evidence(uuid, bigint[]), mavi_private.ai_learning_kick()
 from public, anon, authenticated;
revoke all on function public.copilot_feedback_vote(uuid, uuid, uuid, uuid, jsonb, text, text, text),
 public.copilot_feedback_attach(uuid, uuid, uuid),
 public.copilot_learning_report(uuid, date, date, text, integer, integer),
 public.copilot_lesson_save(uuid, uuid, text, uuid, uuid, text, text),
 public.copilot_lesson_set(uuid, uuid, text), public.ai_set_route(uuid, text, uuid, uuid, text, text),
 public.task_copilot_context(uuid, uuid, uuid, text, text, boolean) from public, anon;
grant execute on function public.copilot_feedback_vote(uuid, uuid, uuid, uuid, jsonb, text, text, text),
 public.copilot_feedback_attach(uuid, uuid, uuid),
 public.copilot_learning_report(uuid, date, date, text, integer, integer),
 public.copilot_lesson_save(uuid, uuid, text, uuid, uuid, text, text),
 public.copilot_lesson_set(uuid, uuid, text), public.ai_set_route(uuid, text, uuid, uuid, text, text),
 public.task_copilot_context(uuid, uuid, uuid, text, text, boolean) to authenticated;
-- O worker chama como anon + segredo.
revoke all on function public.ai_learning_claim(text), public.ai_learning_store(text, uuid, jsonb, bigint[], jsonb),
 public.ai_learning_fail(text, uuid, text) from public, anon, authenticated;
grant execute on function public.ai_learning_claim(text), public.ai_learning_store(text, uuid, jsonb, bigint[], jsonb),
 public.ai_learning_fail(text, uuid, text) to anon, authenticated;

commit;
