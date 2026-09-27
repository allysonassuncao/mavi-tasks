begin;

-- Mural de avisos · fase 2.
--
-- 1. Quem recebeu (notice_people): cada pessoa da rodada atual, com as
--    equipes, quando recebeu, viu, confirmou, adiou e foi cobrada. Só para
--    quem edita o aviso.
-- 2. Cobrar pendentes (remind_notice): quem ainda não viu, ou não confirmou
--    quando o aviso pede "Li e entendi", recebe de novo pelos mesmos formatos
--    (volta ao topo da caixa de entrada, push, a faixa e o popup reaparecem).
--    No máximo uma cobrança por hora por aviso. O "visto" não é apagado: o
--    tempo até ver continua medindo a entrega.
-- 3. Modelos de aviso (notice_templates): a biblioteca da agência, para todos
--    os administradores e gestores; edita quem criou ou um administrador. O
--    modelo guarda o conteúdo, os formatos e o público, nunca os anexos.
-- 4. A MAVI na escrita do aviso: funcionalidade 'notice_writer' no Painel da
--    MAVI (provedor e modelo próprios).
-- 5. Dashboards: a fonte "Avisos" (notice_receipts), com enviados, entregas,
--    vistos, pendentes, confirmações, taxas e tempo até ver/confirmar, por
--    pessoa, equipe de quem recebeu, autor, aviso, nível e tempo.

-- ------------------------------------------------------------ cobrança
alter table public.notice_receipts add column reminded_at timestamptz,
 add column reminders integer not null default 0;
alter table public.notices add column last_reminded_at timestamptz;

create function public.remind_notice(p_notice uuid) returns integer
language plpgsql security definer set search_path = '' as $$
declare n public.notices; v_users uuid[]; v_tz text; begin
 select * into n from public.notices where id = p_notice for update;
 if not found or not mavi_private.notice_can_edit(n) then
  raise exception 'Sem permissão para cobrar este aviso.' using errcode = '42501';
 end if;
 if mavi_private.notice_status(n) <> 'live' then
  raise exception 'Só avisos no ar podem ser cobrados.' using errcode = '22023';
 end if;
 if n.last_reminded_at > now() - interval '1 hour' then
  select coalesce(timezone, 'America/Sao_Paulo') into v_tz from public.companies where id = n.company_id;
  raise exception 'Este aviso já foi cobrado há menos de uma hora. Dá para cobrar de novo às %.',
   to_char((n.last_reminded_at + interval '1 hour') at time zone v_tz, 'HH24:MI') using errcode = '22023';
 end if;
 with up as (
  update public.notice_receipts r set snoozed_until = null, banner_closed_at = null,
   reminded_at = now(), reminders = r.reminders + 1
  where r.notice_id = n.id and r.round = n.round
   and (r.seen_at is null or (n.require_ack and r.acked_at is null))
  returning r.user_id)
 select coalesce(array_agg(user_id), '{}') into v_users from up;
 if cardinality(v_users) = 0 then return 0; end if;
 update public.notices set last_reminded_at = now() where id = n.id;
 n.title := 'Lembrete: ' || n.title;
 if n.inbox then
  delete from public.notifications where notice_id = n.id and user_id = any(v_users);
  insert into public.notifications(company_id, user_id, actor_id, task_id, kind, title, body, link, notice_id)
  select n.company_id, u, auth.uid(), null, 'notice', left(n.title, 300),
   nullif(mavi_private.notice_excerpt(n), ''), '/mural?aviso=' || n.id, n.id
  from unnest(v_users) u;
 end if;
 if n.push then perform mavi_private.notice_push(n, v_users); end if;
 perform mavi_private.broadcast(n.company_id, jsonb_build_object('kind', 'notice', 'notice', n.id,
  'users', case when cardinality(v_users) <= 200 then to_jsonb(v_users) else null end));
 return cardinality(v_users);
end $$;

-- ------------------------------------------------------------ quem recebeu
create function public.notice_people(p_notice uuid)
returns table(user_id uuid, name text, teams text, delivered_at timestamptz, seen_at timestamptz,
 acked_at timestamptz, snoozed_until timestamptz, reminded_at timestamptz, reminders integer)
language sql stable security definer set search_path = '' as $$
 select r.user_id, m.name,
  (select string_agg(t.name, ', ' order by t.name) from public.team_members tm
   join public.teams t on t.company_id = tm.company_id and t.id = tm.team_id
   where tm.company_id = r.company_id and tm.user_id = r.user_id),
  r.delivered_at, r.seen_at, r.acked_at, r.snoozed_until, r.reminded_at, r.reminders
 from public.notices n
 join public.notice_receipts r on r.notice_id = n.id and r.round = n.round
 join public.memberships m on m.company_id = r.company_id and m.user_id = r.user_id
 where n.id = p_notice and mavi_private.notice_can_edit(n)
 order by (r.seen_at is null or (n.require_ack and r.acked_at is null)) desc, m.name
 limit 5000
$$;

-- O popup volta depois de uma cobrança: a pessoa que adiou nesta sessão vê de novo.
drop function public.my_live_notices(uuid);
create function public.my_live_notices(p_company uuid)
returns table(id uuid, title text, body text, level text, popup boolean, banner boolean, pinned boolean,
 require_ack boolean, round integer, publish_at timestamptz, expires_at timestamptz, author_name text,
 delivered_at timestamptz, seen_at timestamptz, acked_at timestamptz, snoozed_until timestamptz,
 banner_closed_at timestamptz, attachments integer, reminded_at timestamptz)
language sql stable security definer set search_path = '' as $$
 select n.id, n.title, n.body, n.level, n.popup, n.banner, n.pinned, n.require_ack, n.round, n.publish_at,
  n.expires_at, mavi_private.member_name(n.company_id, n.created_by), r.delivered_at, r.seen_at, r.acked_at,
  r.snoozed_until, r.banner_closed_at,
  (select count(*)::integer from public.notice_attachments a where a.notice_id = n.id and a.status = 'ready'),
  r.reminded_at
 from public.notice_receipts r
 join public.notices n on n.id = r.notice_id and n.round = r.round
 where r.company_id = p_company and r.user_id = auth.uid() and mavi_private.member(p_company)
  and mavi_private.notice_status(n) = 'live'
 order by case n.level when 'critical' then 0 when 'important' then 1 else 2 end, r.delivered_at desc
 limit 50
$$;

-- O aviso aberto também diz quando foi a última cobrança.
create or replace function public.notice_detail(p_notice uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare n public.notices; r public.notice_receipts; v_edit boolean; begin
 select * into n from public.notices where id = p_notice;
 if not found or not mavi_private.notice_can_see(n) then return null; end if;
 v_edit := mavi_private.notice_can_edit(n);
 select * into r from public.notice_receipts where notice_id = n.id and user_id = auth.uid();
 return jsonb_build_object(
  'id', n.id, 'company_id', n.company_id, 'title', n.title, 'body', n.body, 'level', n.level,
  'popup', n.popup, 'inbox', n.inbox, 'push', n.push, 'banner', n.banner, 'pinned', n.pinned,
  'require_ack', n.require_ack, 'publish_at', n.publish_at, 'expires_at', n.expires_at, 'repeat', n.repeat,
  'next_repeat', n.next_repeat, 'round', n.round, 'status', mavi_private.notice_status(n),
  'created_by', n.created_by, 'author_name', mavi_private.member_name(n.company_id, n.created_by),
  'created_at', n.created_at, 'updated_at', n.updated_at, 'version', n.version, 'can_edit', v_edit,
  'last_reminded_at', case when v_edit then n.last_reminded_at end,
  'receipt', case when r.notice_id is null or r.round <> n.round then null else jsonb_build_object(
   'delivered_at', r.delivered_at, 'seen_at', r.seen_at, 'acked_at', r.acked_at,
   'snoozed_until', r.snoozed_until, 'banner_closed_at', r.banner_closed_at) end,
  'attachments', coalesce((select jsonb_agg(jsonb_build_object('id', a.id, 'name', a.name,
    'content_type', a.content_type, 'size_bytes', a.size_bytes, 'source', a.source) order by a.position, a.created_at)
   from public.notice_attachments a where a.notice_id = n.id and a.status = 'ready'), '[]'),
  'targets', case when v_edit then coalesce((select jsonb_agg(jsonb_build_object('kind', t.kind, 'id', t.target_id,
    'mode', t.mode)) from public.notice_targets t where t.notice_id = n.id and t.kind <> 'exclude'), '[]') end,
  'exclude', case when v_edit then coalesce((select jsonb_agg(t.target_id) from public.notice_targets t
    where t.notice_id = n.id and t.kind = 'exclude'), '[]') end);
end $$;

-- ------------------------------------------------------------ modelos
create table public.notice_templates (
 id uuid primary key default gen_random_uuid(),
 company_id uuid not null references public.companies(id),
 name text not null check (length(btrim(name)) between 2 and 80),
 content jsonb not null check (jsonb_typeof(content) = 'object' and octet_length(content::text) <= 100000),
 created_by uuid not null,
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 updated_by uuid,
 unique (company_id, id),
 foreign key (company_id, created_by) references public.memberships(company_id, user_id)
);
create index notice_templates_company on public.notice_templates(company_id, name);
alter table public.notice_templates enable row level security;
revoke all on public.notice_templates from public, anon, authenticated;

create function public.notice_templates(p_company uuid)
returns table(id uuid, name text, content jsonb, created_by uuid, author_name text, updated_at timestamptz,
 can_edit boolean)
language sql stable security definer set search_path = '' as $$
 select t.id, t.name, t.content, t.created_by, mavi_private.member_name(t.company_id, t.created_by), t.updated_at,
  mavi_private.admin(t.company_id) or t.created_by = auth.uid()
 from public.notice_templates t
 where t.company_id = p_company and mavi_private.leader(p_company)
 order by lower(t.name), t.id
$$;

-- Guarda só o que um aviso usa (o público é conferido de novo ao publicar).
create function public.save_notice_template(p_company uuid, p_template uuid, p_name text, p_content jsonb)
returns uuid
language plpgsql security definer set search_path = '' as $$
declare t public.notice_templates; v_name text := btrim(regexp_replace(coalesce(p_name, ''), '\s+', ' ', 'g'));
 v_content jsonb; v_id uuid; begin
 if not mavi_private.leader(p_company) then
  raise exception 'Somente administradores e gestores criam modelos de aviso.' using errcode = '42501';
 end if;
 if length(v_name) < 2 or length(v_name) > 80 then
  raise exception 'Dê um nome de 2 a 80 caracteres ao modelo.' using errcode = '22023';
 end if;
 if jsonb_typeof(p_content) is distinct from 'object' then raise exception 'Modelo inválido' using errcode = '22023'; end if;
 select coalesce(jsonb_object_agg(k, v), '{}') into v_content from jsonb_each(p_content) x(k, v)
 where k in ('title', 'body', 'level', 'popup', 'inbox', 'push', 'banner', 'pinned', 'require_ack', 'repeat',
  'targets', 'exclude');
 if p_template is null then
  insert into public.notice_templates(company_id, name, content, created_by)
  values (p_company, v_name, v_content, auth.uid()) returning id into v_id;
  return v_id;
 end if;
 select * into t from public.notice_templates where id = p_template for update;
 if not found or t.company_id <> p_company then raise exception 'Modelo não encontrado.' using errcode = 'P0002'; end if;
 if not (mavi_private.admin(p_company) or t.created_by = auth.uid()) then
  raise exception 'Só quem criou o modelo ou um administrador o altera.' using errcode = '42501';
 end if;
 update public.notice_templates set name = v_name, content = v_content, updated_at = now(), updated_by = auth.uid()
 where id = t.id;
 return t.id;
end $$;

create function public.delete_notice_template(p_template uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare t public.notice_templates; begin
 select * into t from public.notice_templates where id = p_template;
 if not found or not mavi_private.leader(t.company_id)
  or not (mavi_private.admin(t.company_id) or t.created_by = auth.uid()) then
  raise exception 'Só quem criou o modelo ou um administrador o apaga.' using errcode = '42501';
 end if;
 delete from public.notice_templates where id = t.id;
end $$;

revoke all on function public.remind_notice(uuid), public.notice_people(uuid), public.my_live_notices(uuid),
 public.notice_detail(uuid), public.notice_templates(uuid), public.save_notice_template(uuid, uuid, text, jsonb),
 public.delete_notice_template(uuid) from public, anon;
grant execute on function public.remind_notice(uuid), public.notice_people(uuid), public.my_live_notices(uuid),
 public.notice_detail(uuid), public.notice_templates(uuid), public.save_notice_template(uuid, uuid, text, jsonb),
 public.delete_notice_template(uuid) to authenticated;

-- ------------------------------------------------------------ a MAVI na escrita
alter table mavi_private.ai_routes drop constraint ai_routes_feature_check;
alter table mavi_private.ai_routes add constraint ai_routes_feature_check
 check ((scope_type = 'feature') = (feature is not null)
  and (feature is null or feature in ('assistant', 'meetings_history', 'meetings_ask', 'whatsapp_task',
   'social_leads_plan', 'social_leads_adjust', 'social_leads_briefing', 'social_leads_colors',
   'task_copilot', 'client_dossier', 'copilot_learning', 'notice_writer')));

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
  'task_copilot', 'client_dossier', 'copilot_learning', 'notice_writer') then
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

-- ------------------------------------------------------------ dashboards
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
  -- Tasks, status history and validations all read the task (t.).
  on_task boolean := src in ('tasks', 'status_history', 'reviews');
  executor constant text := 'coalesce(t.executor_id, t.assignee_id)';
  validator constant text := 'coalesce(p.ended_by, p.user_id)';
  dur constant text := 'extract(epoch from (coalesce(p.ended_at, now()) - p.started_at))';
  delivered_day text;
  rework constant text := 'exists (select 1 from public.task_status_periods x where x.task_id = t.id'
   ' and (x.status in (''rejected'', ''correction'') or x.from_status = ''done''))';
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
    end;
    if metric in ('lead_time_days', 'on_time_rate', 'on_time_original_rate', 'delay_days', 'first_pass_rate',
     'rework_per_task') then
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
       ' where x.plan_id = p.id and x.decision = ''approved'') = 8) a join public.contracts k on k.id = a.contract_id';
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
  if src not in ('social_leads', 'notices') and strpos(array_to_string(conds, ' ') || ' ' || coalesce(key, ''), 'k.') > 0 then
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

create or replace function mavi_private.dashboard_check(c uuid, p_panels jsonb, p_variables jsonb) returns void
language plpgsql stable security definer set search_path = '' as $$
declare p jsonb; q jsonb; spec jsonb; ids text[] := '{}'; refs text[]; expr text; begin
  if jsonb_typeof(p_panels) <> 'array' or jsonb_array_length(p_panels) > 48 then
    raise exception 'Um dashboard tem até 48 painéis' using errcode = '22023';
  end if;
  if octet_length(p_panels::text) > 300000 then raise exception 'Dashboard grande demais' using errcode = '22023'; end if;
  if jsonb_typeof(coalesce(p_variables, '{}'::jsonb)) <> 'object' then
    raise exception 'Variáveis inválidas' using errcode = '22023';
  end if;
  for p in select value from jsonb_array_elements(p_panels) loop
    if coalesce(p->>'id', '') !~ '^[a-z0-9-]{1,40}$' or p->>'id' = any(ids) then
      raise exception 'Painel com identificador inválido' using errcode = '22023';
    end if;
    ids := ids || (p->>'id');
    if length(coalesce(p->>'title', '')) > 120 then raise exception 'Título de painel longo demais' using errcode = '22023'; end if;
    if jsonb_typeof(p->'x') <> 'number' or jsonb_typeof(p->'y') <> 'number'
     or jsonb_typeof(p->'w') <> 'number' or jsonb_typeof(p->'h') <> 'number'
     or (p->>'x')::int not between 0 and 11 or (p->>'w')::int not between 1 and 12
     or (p->>'x')::int + (p->>'w')::int > 12 or (p->>'y')::int not between 0 and 2000
     or (p->>'h')::int not between 1 and 24 then
      raise exception 'Posição de painel inválida' using errcode = '22023';
    end if;
    spec := p->'spec';
    if coalesce(spec->>'viz', '') not in ('stat', 'line', 'area', 'bar', 'hbar', 'donut', 'table') then
      raise exception 'Visualização inválida' using errcode = '22023';
    end if;
    if coalesce(spec->>'groupBy', 'none') not in
     ('none', 'time', 'client', 'product', 'project', 'team', 'person', 'creator', 'status', 'priority', 'stage',
      'executor', 'previous', 'validator', 'notice', 'level') then
      raise exception 'Agrupamento inválido' using errcode = '22023';
    end if;
    if coalesce(spec->>'interval', 'auto') not in ('auto', 'day', 'week', 'month') then
      raise exception 'Intervalo inválido' using errcode = '22023';
    end if;
    if jsonb_typeof(spec->'queries') <> 'array' or jsonb_array_length(spec->'queries') not between 1 and 5 then
      raise exception 'Cada painel tem de 1 a 5 consultas' using errcode = '22023';
    end if;
    expr := coalesce(spec->'formula'->>'expr', '');
    if length(expr) > 200 or expr !~ '^[A-E0-9+*/(). -]*$' then
      raise exception 'Fórmula inválida: use A a E, números, + - * / e parênteses' using errcode = '22023';
    end if;
    refs := '{}';
    for q in select value from jsonb_array_elements(spec->'queries') loop
      if coalesce(q->>'ref', '') !~ '^[A-E]$' or q->>'ref' = any(refs) then
        raise exception 'Consulta inválida' using errcode = '22023';
      end if;
      refs := refs || (q->>'ref');
      perform mavi_private.dashboard_sql(c, q, coalesce(spec->>'groupBy', 'none'), 'month',
       current_date, current_date, coalesce(p_variables->'filters', '{}'::jsonb), 10);
    end loop;
  end loop;
end $$;
revoke all on function mavi_private.dashboard_check(uuid, jsonb, jsonb) from public, anon, authenticated;

commit;
