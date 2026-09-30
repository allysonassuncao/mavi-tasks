begin;

-- MAVI · Radar do cliente (Fase 4): avisos por regra pessoal e a leitura do
-- histórico.
--
-- - Avisos (radar_alert_rules): cada administrador ou gestor cria as suas
--   regras — tópico, produto (ou Geral / Agência), cliente, equipe e
--   gravidade mínima — para os eventos item novo, voltou a aparecer, reabriu,
--   prazo amanhã e prazo vencido, e escolhe o canal: na hora (caixa de
--   entrada e push, pelas preferências) ou um resumo por dia às 8h. Sem
--   regra, sem aviso. Um aviso por pessoa, item, evento e dia. Fala com mais
--   de 3 dias (o histórico) não avisa.
-- - Os eventos saem de ai_radar_store (item novo, fala nova num item que
--   existia, item que reabriu); os de prazo e o resumo, uma vez por dia, às
--   8h no fuso da empresa (mavi_private.radar_tick, chamado pelo kick de 2 em
--   2 minutos, sem agendamento novo).
-- - Histórico: um líder vê quantas reuniões e dias de grupo existem antes de
--   o Radar ligar, com o custo estimado pelas leituras já feitas, e manda ler
--   desde uma data. Essas leituras (radar_signals.backfill) vão depois das do
--   dia a dia e podem ser paradas.
-- - radar_overview traz o que já foi lido, para a tela explicar como o Radar
--   lê e por que há poucos itens no começo.

-- ------------------------------------------------------------ avisos
-- A da migração 20261231090000, com o aviso do Radar.
alter table public.notifications drop constraint notifications_kind_check;
alter table public.notifications add constraint notifications_kind_check
 check (kind in ('mention', 'assigned', 'reply', 'social_leads', 'ai_share', 'success_case', 'notice',
  'notice_animation', 'temperature', 'tasks_assigned', 'due_risk', 'status', 'review', 'ai_skill', 'ai_answer',
  'radar_report', 'radar_alert'));
alter table public.notifications drop constraint notifications_target_check;
alter table public.notifications add constraint notifications_target_check
 check ((kind in ('social_leads', 'ai_share', 'success_case', 'notice', 'notice_animation', 'temperature',
   'tasks_assigned', 'due_risk', 'ai_skill', 'ai_answer', 'radar_report', 'radar_alert')) = (task_id is null)
  and (task_id is not null or (title is not null and link is not null))
  and ((kind = 'notice') = (notice_id is not null)));
create or replace function mavi_private.notification_pref_keys() returns text[]
language sql immutable set search_path = '' as $$
 select array['assigned', 'mention', 'reply', 'review', 'due_risk',
  'social_leads', 'ai_share', 'success_case', 'temperature', 'ai_skill', 'ai_answer', 'radar_report', 'radar_alert']
  || array(select 'status.' || s || '.' || r
   from unnest(array['progress', 'returned', 'review', 'rejected', 'correction', 'done']) s,
        unnest(array['creator', 'assignee', 'participant']) r)
$$;

-- ------------------------------------------------------------ tabelas
alter table public.radar_settings
 -- O histórico: desde quando foi pedido, quando e por quem.
 add column backfill_from date,
 add column backfill_started_at timestamptz,
 add column backfill_by uuid,
 -- O último dia em que os avisos do dia (prazos e resumo) saíram.
 add column daily_on date;
-- Leitura do histórico: vem depois das leituras do dia a dia e não avisa.
alter table public.radar_signals add column backfill boolean not null default false;

create table public.radar_alert_rules (
 id uuid primary key default gen_random_uuid(),
 company_id uuid not null references public.companies(id),
 user_id uuid not null,
 name text not null check (length(btrim(name)) between 2 and 120),
 -- Nulo: qualquer um.
 topic_id uuid references public.radar_topics(id) on delete cascade,
 product_id uuid references public.products(id) on delete cascade,
 -- Só os itens sem produto (Geral / Agência).
 product_none boolean not null default false,
 client_id uuid references public.clients(id) on delete cascade,
 team_id uuid references public.teams(id) on delete cascade,
 -- Gravidade mínima (0 a 3); nulo: qualquer uma.
 min_severity smallint check (min_severity between 0 and 3),
 -- new (item novo), recurring (voltou a aparecer), reopened (reabriu), due_soon (prazo amanhã), overdue (prazo vencido).
 events text[] not null check (cardinality(events) between 1 and 5
  and events <@ array['new', 'recurring', 'reopened', 'due_soon', 'overdue']),
 -- now: na hora (caixa de entrada e push); digest: um resumo por dia às 8h.
 channel text not null default 'now' check (channel in ('now', 'digest')),
 active boolean not null default true,
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 check (not (product_none and product_id is not null)),
 foreign key (company_id, user_id) references public.memberships(company_id, user_id) on delete cascade
);
create index radar_alert_rules_company on public.radar_alert_rules (company_id) where active;
alter table public.radar_alert_rules enable row level security;
revoke all on public.radar_alert_rules from public, anon, authenticated;

-- Um aviso por pessoa, item, evento e dia (mesmo com várias regras).
create table mavi_private.radar_alert_sent (
 user_id uuid not null,
 item_id uuid not null,
 kind text not null,
 day date not null,
 primary key (user_id, item_id, kind, day)
);
revoke all on mavi_private.radar_alert_sent from public, anon, authenticated;

-- O que espera o resumo do dia.
create table mavi_private.radar_alert_digest (
 id bigint generated always as identity primary key,
 company_id uuid not null,
 user_id uuid not null,
 item_id uuid not null,
 kind text not null,
 created_at timestamptz not null default now()
);
create index radar_alert_digest_user on mavi_private.radar_alert_digest (company_id, user_id);
revoke all on mavi_private.radar_alert_digest from public, anon, authenticated;

-- ------------------------------------------------------------ o aviso
create function mavi_private.radar_event_label(p_kind text) returns text
language sql immutable set search_path = '' as $$
 select case p_kind when 'new' then 'Novo' when 'recurring' then 'Voltou a aparecer' when 'reopened' then 'Reabriu'
  when 'due_soon' then 'Prazo amanhã' when 'overdue' then 'Prazo vencido' else p_kind end
$$;

-- Um evento de um item vai para as regras que batem: na hora, ou para o
-- resumo do dia. Evento de fala com mais de 3 dias (o histórico) não avisa.
create function mavi_private.radar_alert(p_item uuid, p_kind text, p_at timestamptz) returns integer
language plpgsql security definer set search_path = '' as $$
declare i record; r public.radar_alert_rules; v_tz text; v_today date; v_n integer := 0; begin
 if p_at is not null and p_at < now() - interval '3 days' then return 0; end if;
 select it.*, t.name as topic_name, k.name as client_name, coalesce(p.name, 'Geral / Agência') as product_name,
  coalesce(t.severity_levels->>(it.severity::integer), '') as severity_text
 into i
 from public.radar_items it
 join public.radar_topics t on t.id = it.topic_id
 join public.clients k on k.id = it.client_id and not k.archived
 left join public.products p on p.id = it.product_id
 where it.id = p_item;
 if not found then return 0; end if;
 select timezone into v_tz from public.companies where id = i.company_id;
 v_today := (now() at time zone coalesce(v_tz, 'America/Sao_Paulo'))::date;
 for r in
  select rr.* from public.radar_alert_rules rr
  join public.memberships m on m.company_id = rr.company_id and m.user_id = rr.user_id and m.active
   and m.role in ('admin', 'manager') and not ('radar' = any(m.hidden_pages))
  where rr.company_id = i.company_id and rr.active and p_kind = any(rr.events)
   and (rr.topic_id is null or rr.topic_id = i.topic_id)
   and (not rr.product_none or i.product_id is null)
   and (rr.product_id is null or rr.product_id = i.product_id)
   and (rr.client_id is null or rr.client_id = i.client_id)
   and (rr.team_id is null or exists (select 1 from public.client_teams ct where ct.company_id = i.company_id
    and ct.client_id = i.client_id and ct.team_id = rr.team_id))
   and (rr.min_severity is null or coalesce(i.severity, -1) >= rr.min_severity)
  order by case rr.channel when 'now' then 0 else 1 end, rr.created_at
 loop
  insert into mavi_private.radar_alert_sent(user_id, item_id, kind, day) values (r.user_id, i.id, p_kind, v_today)
  on conflict do nothing;
  continue when not found;
  if r.channel = 'now' then
   insert into public.notifications(company_id, user_id, actor_id, task_id, kind, title, body, link)
   values (i.company_id, r.user_id, null, null, 'radar_alert', left(format('%s: %s', i.topic_name, i.title), 300),
    left(concat_ws(' · ', mavi_private.radar_event_label(p_kind), i.client_name, i.product_name,
     nullif(split_part(i.severity_text, ':', 1), ''),
     case when p_kind in ('due_soon', 'overdue') and i.due_date is not null then 'prazo ' || to_char(i.due_date, 'DD/MM') end), 300),
    '/radar?item=' || i.id);
  else
   insert into mavi_private.radar_alert_digest(company_id, user_id, item_id, kind) values (i.company_id, r.user_id, i.id, p_kind);
  end if;
  v_n := v_n + 1;
 end loop;
 return v_n;
end $$;

-- Os avisos do dia de uma empresa (às 8h no fuso dela): prazo amanhã, prazo
-- vencido ontem e o resumo de quem pediu resumo.
create function mavi_private.radar_daily(c uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare v_tz text; v_today date; x record; begin
 select timezone into v_tz from public.companies where id = c;
 v_today := (now() at time zone coalesce(v_tz, 'America/Sao_Paulo'))::date;
 for x in
  select i.id, i.due_date from public.radar_items i join public.radar_topics t on t.id = i.topic_id
  where i.company_id = c and t.has_due and i.due_date in (v_today + 1, v_today - 1)
   and coalesce(mavi_private.radar_status(t.statuses, i.status)->>'kind', '') <> 'closed'
 loop
  perform mavi_private.radar_alert(x.id, case when x.due_date > v_today then 'due_soon' else 'overdue' end, now());
 end loop;
 for x in
  select d.user_id, count(distinct d.item_id) as n,
   string_agg(distinct format('%s %s', q.n, lower(mavi_private.radar_event_label(q.kind))), ' · ') as parts
  from mavi_private.radar_alert_digest d
  join (select dd.user_id, dd.kind, count(distinct dd.item_id) as n from mavi_private.radar_alert_digest dd
    where dd.company_id = c group by 1, 2) q on q.user_id = d.user_id and q.kind = d.kind
  where d.company_id = c
  group by d.user_id
 loop
  if exists (select 1 from public.memberships m where m.company_id = c and m.user_id = x.user_id and m.active) then
   insert into public.notifications(company_id, user_id, actor_id, task_id, kind, title, body, link)
   values (c, x.user_id, null, null, 'radar_alert',
    format('Radar: %s %s desde o último resumo', x.n, case when x.n = 1 then 'novidade' else 'novidades' end),
    left(x.parts, 300), '/radar');
  end if;
 end loop;
 delete from mavi_private.radar_alert_digest where company_id = c;
 update public.radar_settings set daily_on = v_today where company_id = c;
end $$;

-- A cada 2 minutos (pelo kick): a empresa que já passou das 8h e ainda não
-- teve o dia rodado.
create function mavi_private.radar_tick() returns void
language plpgsql security definer set search_path = '' as $$
declare x record; begin
 for x in
  select s.company_id from public.radar_settings s join public.companies co on co.id = s.company_id
  where (s.daily_on is null or s.daily_on < (now() at time zone coalesce(co.timezone, 'America/Sao_Paulo'))::date)
   and extract(hour from now() at time zone coalesce(co.timezone, 'America/Sao_Paulo')) >= 8
  for update of s skip locked
 loop
  perform mavi_private.radar_daily(x.company_id);
 end loop;
end $$;

-- A da migração 20261231090000, que também roda os avisos do dia.
create or replace function mavi_private.ai_radar_kick() returns void
language plpgsql security definer set search_path = '' as $$
declare cfg mavi_private.ai_config; begin
 begin
  perform mavi_private.radar_tick();
 exception when others then
  raise warning 'radar tick failed: %', sqlerrm;
 end;
 select * into cfg from mavi_private.ai_config where id;
 if not found then return; end if;
 if not exists (select 1 from public.radar_signals x where x.status = 'pending' and mavi_private.radar_due(x))
  and not exists (select 1 from public.radar_items i where i.theme_pending and not i.theme_locked
   and i.theme_attempts < 3 and (i.theme_claimed_until is null or i.theme_claimed_until < now()))
  and not exists (select 1 from public.radar_reports r where r.status in ('pending', 'running') and r.attempts < 3
   and (r.claimed_until is null or r.claimed_until < now()))
  and not exists (select 1 from public.radar_report_schedules s where s.active and s.next_run_at <= now()) then
  return;
 end if;
 perform net.http_post(url := cfg.url, body := '{"action":"ai-radar"}'::jsonb,
  headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || cfg.secret),
  -- O worker trabalha até 4 min (uma leitura leva até ~90 s).
  timeout_milliseconds := 290000);
end $$;

-- A da migração 20261229090000: as leituras do dia a dia antes das do histórico.
create or replace function public.ai_radar_claim(p_secret text, p_limit integer default 6) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_out jsonb; begin
 if not mavi_private.ai_secret_ok(p_secret) then raise exception 'Sem permissão' using errcode = '42501'; end if;
 with due as (
  select x.id from public.radar_signals x
  join public.clients k on k.id = x.client_id and not k.archived
  where x.status = 'pending' and mavi_private.radar_due(x)
  order by x.backfill, x.occurred_at desc
  limit least(greatest(coalesce(p_limit, 6), 1), 20)
  for update of x skip locked
 ), claimed as (
  update public.radar_signals x set claimed_at = now(), claimed_until = now() + interval '10 minutes'
  from due where x.id = due.id
  returning x.id, x.company_id, x.client_id, x.source_type, x.occurred_at, x.backfill
 )
 select coalesce(jsonb_agg(jsonb_build_object('id', c.id, 'company_id', c.company_id, 'client_id', c.client_id,
   'source_type', c.source_type) order by c.backfill, c.occurred_at desc), '[]') into v_out
 from claimed c;
 return v_out;
end $$;

-- ------------------------------------------------------------ regras (telas)
create function mavi_private.radar_alert_rule_json(r public.radar_alert_rules) returns jsonb
language sql stable security definer set search_path = '' as $$
 select jsonb_build_object('id', r.id, 'name', r.name, 'topic_id', r.topic_id, 'product_id', r.product_id,
  'product_none', r.product_none, 'client_id', r.client_id, 'team_id', r.team_id, 'min_severity', r.min_severity,
  'events', to_jsonb(r.events), 'channel', r.channel, 'active', r.active,
  'labels', jsonb_build_object(
   'topic', (select name from public.radar_topics where id = r.topic_id),
   'product', case when r.product_none then 'Geral / Agência' else (select name from public.products where id = r.product_id) end,
   'client', (select name from public.clients where id = r.client_id),
   'team', (select name from public.teams where id = r.team_id)))
$$;

create function public.radar_alert_rules(p_company uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$ begin
 if not mavi_private.leader(p_company) then raise exception 'Sem permissão' using errcode = '42501'; end if;
 return coalesce((select jsonb_agg(mavi_private.radar_alert_rule_json(r) order by r.created_at)
  from public.radar_alert_rules r where r.company_id = p_company and r.user_id = auth.uid()), '[]');
end $$;

create function public.save_radar_alert_rule(p_company uuid, p_rule jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v jsonb := coalesce(p_rule, '{}'); v_id uuid; v_events text[]; v_topic uuid; v_product uuid; v_client uuid;
 v_team uuid; v_sev smallint; begin
 if not mavi_private.leader(p_company) then raise exception 'Sem permissão' using errcode = '42501'; end if;
 if length(btrim(coalesce(v->>'name', ''))) not between 2 and 120 then
  raise exception 'Dê um nome de 2 a 120 caracteres ao aviso.' using errcode = '22023';
 end if;
 select coalesce(array_agg(distinct e), '{}') into v_events from jsonb_array_elements_text(
  case when jsonb_typeof(v->'events') = 'array' then v->'events' else '[]' end) e
 where e in ('new', 'recurring', 'reopened', 'due_soon', 'overdue');
 if cardinality(v_events) = 0 then raise exception 'Escolha ao menos um evento.' using errcode = '22023'; end if;
 if coalesce(v->>'channel', 'now') not in ('now', 'digest') then raise exception 'Canal inválido.' using errcode = '22023'; end if;
 v_topic := case when v->>'topic_id' ~* '^[0-9a-f-]{36}$' then (v->>'topic_id')::uuid end;
 v_product := case when v->>'product_id' ~* '^[0-9a-f-]{36}$' then (v->>'product_id')::uuid end;
 v_client := case when v->>'client_id' ~* '^[0-9a-f-]{36}$' then (v->>'client_id')::uuid end;
 v_team := case when v->>'team_id' ~* '^[0-9a-f-]{36}$' then (v->>'team_id')::uuid end;
 v_sev := case when jsonb_typeof(v->'min_severity') = 'number' then (v->>'min_severity')::smallint end;
 if v_topic is not null and not exists (select 1 from public.radar_topics where id = v_topic and company_id = p_company)
  or v_product is not null and not exists (select 1 from public.products where id = v_product and company_id = p_company)
  or v_client is not null and not exists (select 1 from public.clients where id = v_client and company_id = p_company)
  or v_team is not null and not exists (select 1 from public.teams where id = v_team and company_id = p_company) then
  raise exception 'Filtro não encontrado na empresa.' using errcode = 'P0002';
 end if;
 if v_sev is not null and v_sev not between 0 and 3 then raise exception 'Gravidade inválida.' using errcode = '22023'; end if;
 v_id := case when v->>'id' ~* '^[0-9a-f-]{36}$' then (v->>'id')::uuid end;
 if v_id is not null then
  update public.radar_alert_rules set name = btrim(v->>'name'), topic_id = v_topic, product_id = v_product,
   product_none = v_product is null and coalesce((v->>'product_none')::boolean, false), client_id = v_client,
   team_id = v_team, min_severity = v_sev, events = v_events, channel = coalesce(v->>'channel', 'now'),
   active = coalesce((v->>'active')::boolean, true), updated_at = now()
  where id = v_id and company_id = p_company and user_id = auth.uid();
  if not found then raise exception 'Aviso não encontrado.' using errcode = 'P0002'; end if;
 else
  if (select count(*) from public.radar_alert_rules where company_id = p_company and user_id = auth.uid()) >= 20 then
   raise exception 'Cada pessoa tem até 20 avisos.' using errcode = '22023';
  end if;
  insert into public.radar_alert_rules(company_id, user_id, name, topic_id, product_id, product_none, client_id,
   team_id, min_severity, events, channel, active)
  values (p_company, auth.uid(), btrim(v->>'name'), v_topic, v_product,
   v_product is null and coalesce((v->>'product_none')::boolean, false), v_client, v_team, v_sev, v_events,
   coalesce(v->>'channel', 'now'), coalesce((v->>'active')::boolean, true));
 end if;
 return public.radar_alert_rules(p_company);
end $$;

create function public.delete_radar_alert_rule(p_company uuid, p_rule uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$ begin
 if not mavi_private.leader(p_company) then raise exception 'Sem permissão' using errcode = '42501'; end if;
 delete from public.radar_alert_rules where company_id = p_company and id = p_rule and user_id = auth.uid();
 if not found then raise exception 'Aviso não encontrado.' using errcode = 'P0002'; end if;
 return public.radar_alert_rules(p_company);
end $$;

-- ------------------------------------------------------------ histórico
-- O que dá para ler antes de o Radar ligar (a partir de p_from): quantas
-- reuniões e dias de grupo, o tamanho do texto e o custo médio das leituras
-- que já foram feitas (para a estimativa na tela).
create function public.radar_backfill_estimate(p_company uuid, p_from date) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_tz text; v_until date; v_start timestamptz; v_out jsonb; begin
 if not mavi_private.leader(p_company) then raise exception 'Sem permissão' using errcode = '42501'; end if;
 select coalesce(co.timezone, 'America/Sao_Paulo'), s.started_at into v_tz, v_start
 from public.companies co left join public.radar_settings s on s.company_id = co.id where co.id = p_company;
 v_until := (coalesce(v_start, now()) at time zone v_tz)::date - 1;
 with docs as (
  select d.source_type, d.source_id, coalesce(w.day, (coalesce(d.occurred_at, d.indexed_at) at time zone v_tz)::date) as day,
   w.group_id
  from public.ai_documents d
  join public.clients k on k.id = d.client_id and not k.archived
  left join mavi_private.whatsapp_ai_days w on d.source_type = 'whatsapp' and w.id = d.source_id
  where d.company_id = p_company and d.source_type in ('meeting', 'whatsapp') and d.client_id is not null
   and not exists (select 1 from public.radar_signals x where x.company_id = p_company
    and x.source_type = d.source_type and x.source_id = d.source_id)
 ), pick as (select * from docs where docs.day between coalesce(p_from, '1900-01-01') and v_until)
 select jsonb_build_object(
  'from', p_from, 'until', v_until,
  'oldest', (select min(docs.day) from docs where docs.day <= v_until),
  'meetings', (select count(*) from pick where source_type = 'meeting'),
  'whatsapp_days', (select count(*) from pick where source_type = 'whatsapp'),
  'meeting_chars', coalesce((select sum(length(t.segments::text)) from pick
    join public.meeting_transcripts t on t.company_id = p_company and t.recording_id = pick.source_id
    where pick.source_type = 'meeting'), 0),
  'whatsapp_chars', coalesce((select sum(length(m.body) + coalesce(length(m.content_text), 0))
    from pick join public.whatsapp_messages m on m.company_id = p_company and m.group_id = pick.group_id
     and m.sent_at >= pick.day::timestamp at time zone v_tz and m.sent_at < (pick.day + 1)::timestamp at time zone v_tz
    where pick.source_type = 'whatsapp'), 0),
  'avg_meeting_cost', (select avg(x.cost_usd) from public.radar_signals x where x.company_id = p_company
    and x.status = 'done' and x.source_type = 'meeting' and x.cost_usd > 0),
  'avg_whatsapp_cost', (select avg(x.cost_usd) from public.radar_signals x where x.company_id = p_company
    and x.status = 'done' and x.source_type = 'whatsapp' and x.cost_usd > 0),
  'samples', (select count(*) from public.radar_signals x where x.company_id = p_company and x.status = 'done'
    and x.cost_usd > 0),
  'price', (select m from mavi_private.ai_routes rt join mavi_private.ai_providers p on p.id = rt.provider_id and p.active
    cross join lateral jsonb_array_elements(p.models) m
    where rt.company_id = p_company and m->>'id' = rt.model
     and ((rt.scope_type = 'feature' and rt.feature = 'client_radar') or rt.scope_type = 'company')
    order by case rt.scope_type when 'feature' then 1 else 2 end limit 1))
 into v_out;
 return v_out;
end $$;

-- Começa a ler o histórico desde p_from: as reuniões e os dias de grupo de
-- antes de o Radar ligar entram na fila, depois das leituras do dia a dia.
create function public.start_radar_backfill(p_company uuid, p_from date) returns integer
language plpgsql security definer set search_path = '' as $$
declare v_tz text; v_start timestamptz; v_until date; v_n integer; begin
 if not mavi_private.leader(p_company) then raise exception 'Sem permissão' using errcode = '42501'; end if;
 perform mavi_private.radar_seed(p_company);
 select coalesce(co.timezone, 'America/Sao_Paulo'), s.started_at into v_tz, v_start
 from public.companies co join public.radar_settings s on s.company_id = co.id where co.id = p_company;
 v_until := (v_start at time zone v_tz)::date - 1;
 if p_from is null or p_from > v_until then
  raise exception 'Escolha uma data antes de %.', to_char(v_until + 1, 'DD/MM/YYYY') using errcode = '22023';
 end if;
 insert into public.radar_signals(company_id, client_id, source_type, source_id, group_id, title, occurred_at, day,
  status, dirty_at, backfill)
 select d.company_id, d.client_id, d.source_type, d.source_id, w.group_id, left(coalesce(d.title, ''), 300),
  coalesce(d.occurred_at, d.indexed_at),
  coalesce(w.day, (coalesce(d.occurred_at, d.indexed_at) at time zone v_tz)::date), 'pending', now() - interval '1 hour', true
 from public.ai_documents d
 join public.clients k on k.id = d.client_id and not k.archived
 left join mavi_private.whatsapp_ai_days w on d.source_type = 'whatsapp' and w.id = d.source_id
 where d.company_id = p_company and d.source_type in ('meeting', 'whatsapp') and d.client_id is not null
  and coalesce(w.day, (coalesce(d.occurred_at, d.indexed_at) at time zone v_tz)::date) between p_from and v_until
 on conflict (company_id, source_type, source_id) do nothing;
 get diagnostics v_n = row_count;
 -- Dali para frente, o que mudar nesses dias também entra.
 update public.radar_settings set started_at = least(started_at, p_from::timestamp at time zone v_tz),
  backfill_from = least(coalesce(backfill_from, p_from), p_from), backfill_started_at = now(), backfill_by = auth.uid(),
  updated_at = now()
 where company_id = p_company;
 perform mavi_private.ai_radar_kick();
 return v_n;
end $$;

-- Para a leitura do histórico: o que ainda está na fila sai.
create function public.cancel_radar_backfill(p_company uuid) returns integer
language plpgsql security definer set search_path = '' as $$
declare v_n integer; begin
 if not mavi_private.leader(p_company) then raise exception 'Sem permissão' using errcode = '42501'; end if;
 delete from public.radar_signals where company_id = p_company and backfill and status = 'pending'
  and (claimed_until is null or claimed_until < now());
 get diagnostics v_n = row_count;
 return v_n;
end $$;

-- ------------------------------------------------------------ as leituras
-- A da migração 20261229090000, com os avisos.
create or replace function public.ai_radar_store(p_secret text, p_id uuid, p_result jsonb) returns integer
language plpgsql security definer set search_path = '' as $$
declare g public.radar_signals; x jsonb; mm jsonb; t public.radar_topics; it public.radar_items; v_prod uuid;
 v_touched uuid[] := '{}'; v_n integer := 0; v_st jsonb; v_sev smallint; v_due date; v_at timestamptz;
 v_msg uuid; v_sec integer; v_quote text; v_role text; v_fields jsonb; v_recorded timestamptz; v_new boolean;
 v_cost numeric := 0; u jsonb; v_before uuid[] := '{}'; v_reopen boolean; v_added integer; v_last timestamptz; begin
 if not mavi_private.ai_secret_ok(p_secret) then raise exception 'Sem permissão' using errcode = '42501'; end if;
 select * into g from public.radar_signals where id = p_id for update;
 if not found then return 0; end if;
 -- A reunião mudou durante a leitura: lê de novo.
 if g.source_type = 'meeting' and g.dirty_at > g.claimed_at then
  update public.radar_signals set claimed_until = null where id = g.id;
  return 0;
 end if;
 if g.source_type = 'meeting' then
  select coalesce(array_agg(distinct m.item_id), '{}') into v_touched from public.radar_mentions m where m.signal_id = g.id;
  -- Os itens que esta reunião já sustentava: lê-la de novo não é "voltou a aparecer".
  v_before := v_touched;
  delete from public.radar_mentions where signal_id = g.id;
  select recorded_at into v_recorded from public.meeting_recordings where company_id = g.company_id and id = g.source_id;
 end if;

 for x in select * from jsonb_array_elements(case when jsonb_typeof(p_result->'items') = 'array'
   then p_result->'items' else '[]' end) loop
  continue when coalesce(x->>'topic_id', '') !~* '^[0-9a-f-]{36}$';
  select tt.* into t from public.radar_topics tt
  join mavi_private.radar_client_topics(g.company_id, g.client_id, null) ct on ct.id = tt.id
  where tt.id = (x->>'topic_id')::uuid;
  continue when not found;
  continue when jsonb_typeof(x->'mentions') is distinct from 'array' or jsonb_array_length(x->'mentions') = 0;
  -- Produto: um dos que o cliente contrata e em que o tópico vale; senão, Geral.
  v_prod := case when x->>'product_id' ~* '^[0-9a-f-]{36}$' then (x->>'product_id')::uuid end;
  if t.product_id is not null then v_prod := t.product_id;
  elsif v_prod is not null and (v_prod = any(t.off_products) or not exists (select 1 from public.contracts k
    where k.company_id = g.company_id and k.client_id = g.client_id and k.product_id = v_prod and not k.archived)) then
   v_prod := null;
  end if;
  v_sev := case when t.severity and jsonb_typeof(x->'severity') = 'number'
   then least(greatest(round((x->>'severity')::numeric), 0), 3)::smallint end;
  v_due := case when t.has_due and coalesce(x->>'due_date', '') ~ '^\d{4}-\d{2}-\d{2}$' then (x->>'due_date')::date end;
  -- Campos extras: só os do tópico, em texto curto.
  select coalesce(jsonb_object_agg(f->>'key', left(x->'fields'->>(f->>'key'), 300)), '{}') into v_fields
  from jsonb_array_elements(t.fields) f
  where jsonb_typeof(x->'fields') = 'object' and nullif(btrim(coalesce(x->'fields'->>(f->>'key'), '')), '') is not null;

  it := null;
  if x->>'item_id' ~* '^[0-9a-f-]{36}$' then
   select * into it from public.radar_items where id = (x->>'item_id')::uuid and client_id = g.client_id
    and topic_id = t.id for update;
  end if;
  v_new := it.id is null;
  -- Item novo precisa de título; a fala que vai para um item existente, não.
  continue when v_new and length(btrim(coalesce(x->>'title', ''))) < 3;
  if v_new then
   insert into public.radar_items(company_id, client_id, topic_id, product_id, title, summary, status, severity,
    due_date, fields, speaker_confirmed)
   values (g.company_id, g.client_id, t.id, v_prod, left(btrim(x->>'title'), 200),
    left(btrim(coalesce(x->>'summary', '')), 1500), mavi_private.radar_first_status(t.statuses), v_sev, v_due,
    v_fields, coalesce((x->>'speaker_confirmed')::boolean, true))
   returning * into it;
  else
   v_st := mavi_private.radar_status(t.statuses, it.status);
   v_reopen := coalesce(v_st->>'kind', '') = 'closed' and coalesce((v_st->>'reopen')::boolean, false);
   update public.radar_items set
    summary = case when not person_edited and nullif(btrim(coalesce(x->>'summary', '')), '') is not null
     then left(btrim(x->>'summary'), 1500) else summary end,
    product_id = case when not person_edited and product_id is null then v_prod else product_id end,
    severity = case when severity_person or v_sev is null then severity else greatest(coalesce(severity, 0), v_sev) end,
    due_date = coalesce(v_due, due_date),
    fields = fields || v_fields,
    speaker_confirmed = speaker_confirmed or coalesce((x->>'speaker_confirmed')::boolean, true),
    -- Fechado com "reabre": a fala nova reabre o item.
    status = case when coalesce(v_st->>'kind', '') = 'closed' and coalesce((v_st->>'reopen')::boolean, false)
     then mavi_private.radar_first_status(t.statuses) else status end,
    reopened_at = case when coalesce(v_st->>'kind', '') = 'closed' and coalesce((v_st->>'reopen')::boolean, false)
     then now() else reopened_at end,
    status_at = case when coalesce(v_st->>'kind', '') = 'closed' and coalesce((v_st->>'reopen')::boolean, false)
     then now() else status_at end,
    status_by = case when coalesce(v_st->>'kind', '') = 'closed' and coalesce((v_st->>'reopen')::boolean, false)
     then null else status_by end,
    updated_at = now()
   where id = it.id;
  end if;

  v_added := 0; v_last := null;
  if v_new then v_reopen := false; end if;
  for mm in select * from jsonb_array_elements(x->'mentions') loop
   v_quote := left(btrim(coalesce(mm->>'quote', '')), 700);
   continue when v_quote = '';
   v_role := case when mm->>'role' in ('client', 'team', 'unknown') then mm->>'role' else 'unknown' end;
   v_msg := null; v_sec := null; v_at := g.occurred_at;
   if g.source_type = 'whatsapp' and mm->>'message_id' ~* '^[0-9a-f-]{36}$' then
    select w.id, w.sent_at into v_msg, v_at from public.whatsapp_messages w
    where w.company_id = g.company_id and w.group_id = g.group_id and w.id = (mm->>'message_id')::uuid;
    v_at := coalesce(v_at, g.occurred_at);
   elsif g.source_type = 'meeting' and jsonb_typeof(mm->'at_seconds') = 'number' then
    v_sec := greatest(round((mm->>'at_seconds')::numeric), 0)::integer;
    v_at := coalesce(v_recorded, g.occurred_at) + make_interval(secs => v_sec);
   end if;
   -- A mesma fala do mesmo lugar não entra duas vezes.
   continue when exists (select 1 from public.radar_mentions r where r.item_id = it.id and r.source_id = g.source_id
    and r.quote = v_quote);
   insert into public.radar_mentions(company_id, item_id, signal_id, source_type, source_id, group_id, message_id,
    at_seconds, quote, speaker, role, occurred_at)
   values (g.company_id, it.id, g.id, g.source_type, g.source_id, g.group_id, v_msg, v_sec, v_quote,
    left(coalesce(mm->>'speaker', ''), 120), v_role, v_at);
   v_added := v_added + 1;
   v_last := greatest(coalesce(v_last, v_at), v_at);
  end loop;
  -- Os avisos de quem pediu (Fase 4): item novo, que voltou ou que reabriu.
  -- O histórico (leituras antigas) não avisa.
  if not g.backfill and v_added > 0 then
   if v_new then perform mavi_private.radar_alert(it.id, 'new', v_last);
   elsif not (it.id = any(v_before)) then
    perform mavi_private.radar_alert(it.id, case when v_reopen then 'reopened' else 'recurring' end, v_last);
   end if;
  end if;
  v_touched := v_touched || it.id;
  v_n := v_n + 1;
 end loop;
 perform mavi_private.radar_items_sync(v_touched);

 -- O custo, por cliente (a leitura da MAVI e a conferência do Jev).
 for u in select * from jsonb_array_elements(case when jsonb_typeof(p_result->'usage') = 'array'
   then p_result->'usage' else '[]' end) loop
  continue when coalesce(u->>'kind', '') not in ('radar', 'radar_check');
  v_cost := v_cost + least(greatest(coalesce((u->>'cost')::numeric, 0), 0), 20);
  insert into public.ai_usage(company_id, user_id, module, kind, client_id, model, input_tokens, output_tokens,
   cache_read_tokens, cache_write_tokens, cost_usd, provider_id, provider_name)
  values (g.company_id, null, 'radar', u->>'kind', g.client_id, left(coalesce(u->>'model', ''), 80),
   greatest(coalesce((u->>'input')::integer, 0), 0), greatest(coalesce((u->>'output')::integer, 0), 0),
   greatest(coalesce((u->>'cache_read')::integer, 0), 0), greatest(coalesce((u->>'cache_write')::integer, 0), 0),
   least(greatest(coalesce((u->>'cost')::numeric, 0), 0), 20),
   case when u->>'provider_id' ~* '^[0-9a-f-]{36}$' then (u->>'provider_id')::uuid end,
   left(coalesce(u->>'provider', ''), 120));
 end loop;

 update public.radar_signals set
  seen = case when g.source_type = 'whatsapp' then (select coalesce(array_agg(distinct s), '{}') from unnest(g.seen
    || coalesce((select array_agg(v::uuid) from jsonb_array_elements_text(case when jsonb_typeof(p_result->'seen') = 'array'
      then p_result->'seen' else '[]' end) v where v ~* '^[0-9a-f-]{36}$'), '{}')) s) else '{}' end,
  items = case when g.source_type = 'meeting' then v_n else items + v_n end,
  cost_usd = cost_usd + v_cost, evaluated_at = now(), attempts = 0, last_error = null, claimed_until = null,
  status = case when dirty_at > claimed_at then 'pending' else 'done' end
 where id = g.id;
 return v_n;
end $$;

-- A da migração 20261229090000, com o que já foi lido.
create or replace function public.radar_overview(p_company uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$ begin
 if not mavi_private.leader(p_company) then raise exception 'Sem permissão' using errcode = '42501'; end if;
 perform mavi_private.radar_seed(p_company);
 return jsonb_build_object(
  'topics', coalesce((select jsonb_agg(mavi_private.radar_topic_json(t) || jsonb_build_object(
     'open', (select count(*) from public.radar_items i where i.topic_id = t.id
       and coalesce(mavi_private.radar_status(t.statuses, i.status)->>'kind', '') <> 'closed'),
     'new_7d', (select count(*) from public.radar_items i where i.topic_id = t.id and i.created_at > now() - interval '7 days'),
     'severe', (select count(*) from public.radar_items i where i.topic_id = t.id and i.severity >= 2
       and coalesce(mavi_private.radar_status(t.statuses, i.status)->>'kind', '') <> 'closed'),
     'overdue', case when t.has_due then (select count(*) from public.radar_items i where i.topic_id = t.id
       and i.due_date < current_date
       and coalesce(mavi_private.radar_status(t.statuses, i.status)->>'kind', '') <> 'closed') end,
     'total', (select count(*) from public.radar_items i where i.topic_id = t.id))
    order by t.position, t.created_at)
   from public.radar_topics t where t.company_id = p_company and t.active), '[]'),
  'pending', (select count(*) from public.radar_signals x where x.company_id = p_company and x.status = 'pending'),
  'started_at', (select started_at from public.radar_settings where company_id = p_company),
  -- Para a mensagem de como o Radar lê: o que já foi lido e o histórico.
  'reading', (select jsonb_build_object('done', count(*) filter (where x.status = 'done'),
     'meetings', count(*) filter (where x.status = 'done' and x.source_type = 'meeting'),
     'whatsapp', count(*) filter (where x.status = 'done' and x.source_type = 'whatsapp'),
     'last_at', max(x.evaluated_at),
     'backfill_pending', count(*) filter (where x.backfill and x.status = 'pending'))
    from public.radar_signals x where x.company_id = p_company),
  'backfill_from', (select backfill_from from public.radar_settings where company_id = p_company),
  'can_configure', true);
end $$;

-- A da migração 20261229090000, com o histórico.
create or replace function public.radar_settings(p_company uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$ begin
 if not mavi_private.leader(p_company) then raise exception 'Sem permissão' using errcode = '42501'; end if;
 perform mavi_private.radar_seed(p_company);
 return jsonb_build_object(
  'topics', coalesce((select jsonb_agg(mavi_private.radar_topic_json(t) || jsonb_build_object('items',
     (select count(*) from public.radar_items i where i.topic_id = t.id)) order by t.position, t.created_at)
    from public.radar_topics t where t.company_id = p_company), '[]'),
  'started_at', (select started_at from public.radar_settings where company_id = p_company),
  'jev', (select jsonb_build_object('provider', x->>'provider', 'model', x->>'model')
    from (select mavi_private.radar_jev_route(p_company) as x) q where x is not null),
  'model', (select jsonb_build_object('provider', p.name, 'model', rt.model)
    from mavi_private.ai_routes rt join mavi_private.ai_providers p on p.id = rt.provider_id and p.active
    where rt.company_id = p_company and ((rt.scope_type = 'feature' and rt.feature = 'client_radar')
     or rt.scope_type = 'company')
    order by case rt.scope_type when 'feature' then 1 else 2 end limit 1),
  'stats', (select jsonb_build_object('done', count(*) filter (where x.status = 'done'),
     'pending', count(*) filter (where x.status = 'pending'), 'failed', count(*) filter (where x.status = 'failed'),
     'skipped', count(*) filter (where x.status = 'skipped'))
    from public.radar_signals x where x.company_id = p_company),
  'cost_30d', (select coalesce(sum(u.cost_usd), 0) from public.ai_usage u where u.company_id = p_company
    and u.module = 'radar' and u.created_at > now() - interval '30 days'),
  'backfill', (select jsonb_build_object('from', s.backfill_from, 'started_at', s.backfill_started_at,
     'by_name', (select m.name from public.memberships m where m.company_id = p_company and m.user_id = s.backfill_by),
     'pending', (select count(*) from public.radar_signals x where x.company_id = p_company and x.backfill
       and x.status = 'pending'),
     'done', (select count(*) from public.radar_signals x where x.company_id = p_company and x.backfill
       and x.status in ('done', 'skipped')),
     'failed', (select count(*) from public.radar_signals x where x.company_id = p_company and x.backfill
       and x.status = 'failed'),
     'cost', (select coalesce(sum(x.cost_usd), 0) from public.radar_signals x where x.company_id = p_company
       and x.backfill))
    from public.radar_settings s where s.company_id = p_company));
end $$;

-- ------------------------------------------------------------ permissões
revoke all on function mavi_private.radar_event_label(text), mavi_private.radar_alert(uuid, text, timestamptz),
 mavi_private.radar_daily(uuid), mavi_private.radar_tick(), mavi_private.ai_radar_kick(),
 mavi_private.radar_alert_rule_json(public.radar_alert_rules)
 from public, anon, authenticated;
revoke all on function public.radar_alert_rules(uuid), public.save_radar_alert_rule(uuid, jsonb),
 public.delete_radar_alert_rule(uuid, uuid), public.radar_backfill_estimate(uuid, date),
 public.start_radar_backfill(uuid, date), public.cancel_radar_backfill(uuid), public.radar_overview(uuid),
 public.radar_settings(uuid)
 from public, anon;
grant execute on function public.radar_alert_rules(uuid), public.save_radar_alert_rule(uuid, jsonb),
 public.delete_radar_alert_rule(uuid, uuid), public.radar_backfill_estimate(uuid, date),
 public.start_radar_backfill(uuid, date), public.cancel_radar_backfill(uuid), public.radar_overview(uuid),
 public.radar_settings(uuid)
 to authenticated;
revoke all on function public.ai_radar_claim(text, integer), public.ai_radar_store(text, uuid, jsonb)
 from public, anon, authenticated;
grant execute on function public.ai_radar_claim(text, integer), public.ai_radar_store(text, uuid, jsonb)
 to anon, authenticated;

commit;
