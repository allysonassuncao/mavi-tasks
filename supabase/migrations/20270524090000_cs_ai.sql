begin;

-- Customer Success, fase 4a (pedido de 06/10/2026): os dados de CS na MAVI
-- (bolinha e módulo) e no MCP do MAVI (Claude.ai, ChatGPT), no lugar do
-- conector antigo do Cloudflare. As consultas usam o motor do painel CS Make
-- (src/cs-engine.ts) com os dados que a pessoa pode ver:
--  * administradores e gestores: tudo;
--  * quem está num squad (Equipe e configurações › Squads): só o próprio
--    squad — os clientes que passaram por ele, as metas e o faturamento
--    oficial dele;
--  * os demais: nada.

-- A base de CS (igual à de 20270522090000, mais os apelidos dos squads:
-- "1", "Primog"… — as consultas aceitam o squad como o time escreve).
create or replace function mavi_private.cs_snapshot(c uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
 select jsonb_build_object(
  'today', mavi_private.company_today(c),
  'squads', coalesce((select jsonb_agg(jsonb_build_object('id', s.id, 'name', s.name, 'color', s.color, 'sort', s.sort,
    'archived', s.archived, 'aliases', s.aliases) order by s.sort, s.name) from public.cs_squads s where s.company_id = c), '[]'),
  'clients', coalesce((select jsonb_agg(jsonb_build_object('id', k.id, 'external_id', k.external_id, 'name', k.name,
    'squad_id', k.squad_id, 'vertical', k.vertical, 'origin', k.origin, 'kind', k.kind, 'trial_month', k.trial_month,
    'status', k.status, 'entry_date', k.entry_date, 'churn_date', k.churn_date, 'reactivation_date', k.reactivation_date,
    'churn_reason', k.churn_reason, 'notes', k.notes, 'client_id', k.client_id)
    order by lpad(k.external_id, 20, '0')) from public.cs_clients k where k.company_id = c), '[]'),
  'cycles', coalesce((select jsonb_agg(jsonb_build_object('id', y.id, 'client', y.cs_client_id, 'month', y.month,
    'squad_id', y.squad_id, 'start_date', y.start_date, 'end_date', y.end_date, 'billing_date', y.billing_date,
    'best', y.best, 'probable', y.probable, 'probability', y.probability, 'paid', y.paid, 'paid_date', y.paid_date,
    'status', y.status, 'adimplencia', y.adimplencia, 'acl', y.acl, 'acl_value', y.acl_value,
    'fee_planned', y.fee_planned, 'fee_paid', y.fee_paid, 'm1_discounted', y.m1_discounted)
    order by y.month, y.created_at) from public.cs_cycles y where y.company_id = c), '[]'),
  'payments', coalesce((select jsonb_agg(jsonb_build_object('cycle', p.cycle_id, 'ord', p.ord, 'date', p.paid_date,
    'amount', p.amount) order by p.cycle_id, p.ord) from public.cs_cycle_payments p where p.company_id = c), '[]'),
  'hs', coalesce((select jsonb_agg(jsonb_build_object('client', h.cs_client_id, 'month', h.month,
    'creatives', h.creatives, 'meeting', h.meeting, 'payment', h.payment, 'perception', h.perception, 'goal', h.goal,
    'score', h.score, 'band', h.band) order by h.month, lpad(k.external_id, 20, '0'))
    from public.cs_health_scores h join public.cs_clients k on k.id = h.cs_client_id where h.company_id = c), '[]'),
  'goals', coalesce((select jsonb_agg(jsonb_build_object('squad_id', g.squad_id, 'month', g.month, 'revenue', g.revenue,
    'retention_pct', g.retention_pct, 'ticket', g.ticket) order by g.month) from public.cs_goals g where g.company_id = c), '[]'),
  'events', coalesce((select jsonb_agg(jsonb_build_object('client', e.cs_client_id, 'kind', e.kind, 'date', e.date,
    'churn_reason', e.churn_reason) order by e.date) from public.cs_client_events e where e.company_id = c), '[]'),
  'history', coalesce((select jsonb_agg(jsonb_build_object('client', h.cs_client_id, 'month', h.month,
    'end_date', h.end_date, 'billing_date', h.billing_date, 'probable', h.probable, 'recorded_at', h.recorded_at)
    order by h.recorded_at, h.seq) from public.cs_cycle_history h where h.company_id = c), '[]'),
  'official_revenue', coalesce((select jsonb_agg(jsonb_build_object('squad_id', o.squad_id, 'month', o.month,
    'achieved', o.achieved)) from public.cs_official_revenue o where o.company_id = c), '[]'),
  'multipliers', coalesce((select jsonb_agg(jsonb_build_object('client', m.cs_client_id, 'month', m.month,
    'value', m.value)) from public.cs_multipliers m where m.company_id = c), '[]'),
  'rules', coalesce((select jsonb_agg(jsonb_build_object('valid_from', r.valid_from, 'rules', r.rules)
    order by r.valid_from) from public.cs_rules r where r.company_id = c), '[]'),
  'sync', (select jsonb_build_object('finished_at', x.finished_at, 'status', x.status,
    'warnings', cardinality(x.warnings))
    from public.cs_sync_runs x where x.company_id = c order by x.started_at desc limit 1)
 )
$$;

-- O alcance da pessoa nos dados de CS (nulo = sem acesso).
create function mavi_private.cs_ai_scope(c uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
 select case
  when mavi_private.cs_reader(c) then jsonb_build_object('scope', 'all')
  when exists (select 1 from public.cs_squad_members sm join public.memberships m
    on m.company_id = sm.company_id and m.user_id = sm.user_id and m.active
    where sm.company_id = c and sm.user_id = auth.uid())
   then jsonb_build_object('scope', 'squads', 'squads',
    (select jsonb_agg(sm.squad_id order by s.sort, s.name) from public.cs_squad_members sm
      join public.cs_squads s on s.company_id = sm.company_id and s.id = sm.squad_id
      where sm.company_id = c and sm.user_id = auth.uid()))
 end
$$;
revoke all on function mavi_private.cs_ai_scope(uuid) from public, anon, authenticated;

-- A base de CS que a pessoa pode ver (o formato do motor, como cs_snapshot).
create function public.cs_ai_data(p_company uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare sc jsonb := mavi_private.cs_ai_scope(p_company); s jsonb; sq jsonb; ids jsonb; cyc jsonb; begin
 if sc is null then
  raise exception 'Sem acesso aos dados de Customer Success: só administradores, gestores e quem está num squad.'
   using errcode = '42501';
 end if;
 s := mavi_private.cs_snapshot(p_company);
 if sc->>'scope' = 'all' then return s || jsonb_build_object('access', sc); end if;
 sq := sc->'squads';
 -- Os clientes do squad: os de hoje e os que tiveram ciclo nele.
 select coalesce(jsonb_agg(distinct x.id), '[]') into ids from (
  select k->>'id' id from jsonb_array_elements(s->'clients') k where sq ? (k->>'squad_id')
  union
  select y->>'client' from jsonb_array_elements(s->'cycles') y where sq ? (y->>'squad_id')) x;
 select coalesce(jsonb_agg(y), '[]') into cyc from jsonb_array_elements(s->'cycles') y where ids ? (y->>'client');
 return s || jsonb_build_object(
  'clients', (select coalesce(jsonb_agg(k), '[]') from jsonb_array_elements(s->'clients') k where ids ? (k->>'id')),
  'cycles', cyc,
  'payments', (select coalesce(jsonb_agg(p), '[]') from jsonb_array_elements(s->'payments') p
    where exists (select 1 from jsonb_array_elements(cyc) y where y->>'id' = p->>'cycle')),
  'hs', (select coalesce(jsonb_agg(h), '[]') from jsonb_array_elements(s->'hs') h where ids ? (h->>'client')),
  'events', (select coalesce(jsonb_agg(e), '[]') from jsonb_array_elements(s->'events') e where ids ? (e->>'client')),
  'history', (select coalesce(jsonb_agg(h), '[]') from jsonb_array_elements(s->'history') h where ids ? (h->>'client')),
  'multipliers', (select coalesce(jsonb_agg(m), '[]') from jsonb_array_elements(s->'multipliers') m where ids ? (m->>'client')),
  'goals', (select coalesce(jsonb_agg(g), '[]') from jsonb_array_elements(s->'goals') g where sq ? (g->>'squad_id')),
  'official_revenue', (select coalesce(jsonb_agg(o), '[]') from jsonb_array_elements(s->'official_revenue') o
    where sq ? (o->>'squad_id')),
  'access', sc);
end $$;

-- As empresas em que a pessoa consulta CS (o MCP só mostra as ferramentas
-- de CS a quem tem acesso em alguma, e a MAVI só as oferece a essas pessoas).
create function public.cs_ai_access() returns jsonb
language sql stable security definer set search_path = '' as $$
 select coalesce(jsonb_agg(jsonb_build_object('company_id', m.company_id, 'name', c.name,
   'scope', mavi_private.cs_ai_scope(m.company_id)->>'scope') order by c.name), '[]')
 from public.memberships m join public.companies c on c.id = m.company_id
 where m.user_id = auth.uid() and m.active and mavi_private.cs_ai_scope(m.company_id) is not null
  and exists (select 1 from public.cs_clients k where k.company_id = m.company_id)
$$;

-- ============================================================ fase 4b: sugestão de Health Score
-- A MAVI sugere os 5 critérios do Health Score de cada cliente no mês, com a
-- evidência de cada um. Pagamento em dia vem do ciclo do mês e Reunião de
-- alinhamento das reuniões gravadas (sem IA); Meta batida, Percepção de valor
-- e Aprovação de criativos a MAVI decide lendo as campanhas (Bom/Ruim do
-- ciclo), o Termômetro, as aprovações do Social Leads, o WhatsApp e o Radar.
-- O time vê no painel CS Make e no perfil do cliente e lança na planilha
-- (na fase 5 a sugestão vira o lançamento). Roda sozinha do dia 25 ao dia 5
-- do mês seguinte e quando alguém pede.

-- A funcionalidade nova em "Quem usa qual modelo" (como em 20270503090000).
do $$ declare v text[]; begin
 v := array(select distinct x from unnest(mavi_private.ai_route_features() || array['cs_health_score']) x order by x);
 alter table mavi_private.ai_routes drop constraint ai_routes_feature_check;
 execute format('alter table mavi_private.ai_routes add constraint ai_routes_feature_check check ('
  '(scope_type = ''feature'') = (feature is not null) and (feature is null or feature in (%s)))',
  (select string_agg(quote_literal(x), ',') from unnest(v) x));
end $$;

create table public.cs_hs_suggestions (
 company_id uuid not null references public.companies(id) on delete cascade,
 cs_client_id uuid not null,
 month date not null check (extract(day from month) = 1),
 -- {goal|perception|payment|meeting|creatives: {value: true|false|null,
 --  confidence: alta|media|baixa, why, evidence: [{type, id, title, date, group?}]}}
 criteria jsonb not null default '{}' check (jsonb_typeof(criteria) = 'object'),
 score numeric(5,2),
 band text check (band in ('SATISFEITO', 'ALERTA', 'CRITICO')),
 model text,
 requested_at timestamptz not null default now(),
 requested_by uuid,
 claimed_at timestamptz,
 done_at timestamptz,
 attempts integer not null default 0,
 error text,
 primary key (company_id, cs_client_id, month),
 foreign key (company_id, cs_client_id) references public.cs_clients(company_id, id) on delete cascade
);
create index cs_hs_suggestions_pending on public.cs_hs_suggestions(requested_at) where done_at is null;
alter table public.cs_hs_suggestions enable row level security;
revoke all on public.cs_hs_suggestions from public, anon, authenticated;

-- Os clientes na carteira no mês (como o motor: só pelas datas).
create function mavi_private.cs_active_in(k public.cs_clients, m date) returns boolean
language sql immutable set search_path = '' as $$
 select k.entry_date <= (m + interval '1 month - 1 day')::date
  and (k.churn_date is null or k.churn_date > (m + interval '1 month - 1 day')::date
   or (k.reactivation_date is not null and k.reactivation_date > k.churn_date
    and k.reactivation_date <= (m + interval '1 month - 1 day')::date))
$$;

-- Pede as sugestões de um mês (de todos os clientes da carteira) e acorda o worker.
create function mavi_private.cs_hs_enqueue(c uuid, m date, p_by uuid, p_stale interval) returns integer
language plpgsql security definer set search_path = '' as $$
declare n integer; begin
 insert into public.cs_hs_suggestions(company_id, cs_client_id, month, requested_by)
 select c, k.id, m, p_by from public.cs_clients k where k.company_id = c and mavi_private.cs_active_in(k, m)
 on conflict (company_id, cs_client_id, month) do update set requested_at = now(), requested_by = excluded.requested_by,
  done_at = null, attempts = 0, error = null, claimed_at = null
 where public.cs_hs_suggestions.done_at is not null and public.cs_hs_suggestions.done_at < now() - p_stale;
 get diagnostics n = row_count;
 return n;
end $$;

-- Acorda o worker quando há sugestão pendente (o pg_cron chama a cada 2 minutos).
create function mavi_private.cs_hs_kick() returns void
language plpgsql security definer set search_path = '' as $$
declare cfg mavi_private.ai_config; begin
 select * into cfg from mavi_private.ai_config where id;
 if not found then return; end if;
 if not exists (select 1 from public.cs_hs_suggestions where done_at is null and attempts < 3
  and (claimed_at is null or claimed_at < now() - interval '10 minutes')) then return; end if;
 perform net.http_post(url := cfg.url, body := '{"action":"cs-hs"}'::jsonb,
  headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || cfg.secret),
  timeout_milliseconds := 60000);
end $$;

-- Todo dia: do dia 25 ao fim do mês, o mês corrente; do dia 1 ao 5, o que fechou.
create function mavi_private.cs_hs_auto() returns void
language plpgsql security definer set search_path = '' as $$
declare r record; t date; begin
 for r in select distinct k.company_id from public.cs_clients k loop
  t := mavi_private.company_today(r.company_id);
  if extract(day from t) >= 25 then
   perform mavi_private.cs_hs_enqueue(r.company_id, date_trunc('month', t)::date, null, interval '20 hours');
  elsif extract(day from t) <= 5 then
   perform mavi_private.cs_hs_enqueue(r.company_id, (date_trunc('month', t) - interval '1 month')::date, null,
    interval '20 hours');
  end if;
 end loop;
 perform mavi_private.cs_hs_kick();
end $$;

-- "Pedir sugestões agora" (administradores e gestores), num mês até o atual.
create function public.cs_hs_request(p_company uuid, p_month date) returns integer
language plpgsql security definer set search_path = '' as $$
declare m date := date_trunc('month', p_month)::date; n integer; begin
 if not mavi_private.cs_reader(p_company) then
  raise exception 'Só administradores e gestores pedem as sugestões de Health Score.' using errcode = '42501';
 end if;
 if m > date_trunc('month', mavi_private.company_today(p_company))::date then
  raise exception 'Escolha um mês até o atual.' using errcode = '22023';
 end if;
 n := mavi_private.cs_hs_enqueue(p_company, m, auth.uid(), interval '1 hour');
 perform mavi_private.cs_hs_kick();
 return n;
end $$;

-- O material de um cliente no mês, para a MAVI decidir.
create function mavi_private.cs_hs_pack(c uuid, p_client uuid, m date) returns jsonb
language sql stable security definer set search_path = '' as $$
 with k as (select * from public.cs_clients where company_id = c and id = p_client),
 tz as (select coalesce(timezone, 'America/Sao_Paulo') tz from public.companies where id = c),
 lim as (select m ini, (m + interval '1 month - 1 day')::date fim)
 select jsonb_build_object(
  'client', (select jsonb_build_object('name', k.name, 'external_id', k.external_id, 'kind', k.kind,
    'trial_month', k.trial_month, 'entry_date', k.entry_date, 'linked', k.client_id is not null,
    'squad', (select s.name from public.cs_squads s where s.company_id = c and s.id = k.squad_id)) from k),
  'cycle', (select jsonb_build_object('status', y.status, 'adimplencia', y.adimplencia, 'billing_date', y.billing_date,
    'paid_date', y.paid_date, 'paid', y.paid, 'probable', y.probable, 'probability', y.probability)
    from public.cs_cycles y where y.company_id = c and y.cs_client_id = p_client and y.month = m),
  'registered', (select jsonb_build_object('score', h.score, 'goal', h.goal, 'perception', h.perception,
    'payment', h.payment, 'meeting', h.meeting, 'creatives', h.creatives)
    from public.cs_health_scores h where h.company_id = c and h.cs_client_id = p_client and h.month = m),
  'meetings', coalesce((select jsonb_agg(jsonb_build_object('id', r.id, 'title', r.title,
    'date', (r.recorded_at at time zone (select tz from tz))::date, 'minutes', round(coalesce(r.duration_seconds, 0) / 60.0),
    'overview', left(coalesce(r.summary->>'overview', ''), 500)) order by r.recorded_at)
    from public.meeting_recordings r, k, lim where r.company_id = c and r.client_id = k.client_id
     and (r.recorded_at at time zone (select tz from tz))::date between lim.ini and lim.fim), '[]'),
  'temperature', (select jsonb_build_object('days', count(*), 'score', round(avg(d.score), 1),
    'satisfacao', round(avg((d.indicators->>'satisfacao')::numeric), 1),
    'permanencia', round(avg((d.indicators->>'permanencia')::numeric), 1),
    'flags', (select coalesce(jsonb_agg(distinct f), '[]') from public.temperature_days d2, unnest(d2.flags) f, k, lim
      where d2.client_id = k.client_id and d2.day between lim.ini and lim.fim))
    from public.temperature_days d, k, lim where d.client_id = k.client_id and d.day between lim.ini and lim.fim
    having count(*) > 0),
  'temperature_readings', coalesce((select jsonb_agg(x order by x->>'date') from (
    select jsonb_build_object('id', g.id, 'source', g.source_type, 'source_id', g.source_id, 'group', g.group_id,
     'message', g.message_id, 'title', g.title, 'date', g.day, 'reason', left(coalesce(g.reason::text, ''), 300),
     'excerpt', left(coalesce(g.excerpt, ''), 300)) x
    from public.temperature_signals g, k, lim where g.client_id = k.client_id and g.day between lim.ini and lim.fim
     and g.status = 'done' order by g.day desc limit 12) t), '[]'),
  'campaigns', coalesce((select jsonb_agg(jsonb_build_object('id', a.id, 'campaign', a.name, 'platform', a.platform,
    'goal_results', cy.goal_results, 'budget', cy.budget, 'multiplier', cy.multiplier,
    'start', cy.start_date, 'end', cy.end_date,
    'last', (select jsonb_build_object('taken_on', sn.taken_on, 'spend', sn.spend, 'results', sn.conversions,
       'goal_status', sn.goal_status) from public.ad_cycle_snapshots sn where sn.cycle_id = cy.id
       order by sn.taken_on desc limit 1)))
    from public.ad_cycles cy join public.ad_campaigns a on a.id = cy.campaign_id
    join public.contracts ct on ct.id = a.contract_id, k
    where a.company_id = c and ct.client_id = k.client_id and cy.competence_month = m), '[]'),
  'social_leads', (select jsonb_build_object('approved', count(*) filter (where e.kind = 'approved'),
    'rejected', count(*) filter (where e.kind = 'rejected'),
    'notes', coalesce(jsonb_agg(jsonb_build_object('kind', e.kind, 'date', e.created_at::date, 'post', e.number,
      'note', left(e.note, 200))) filter (where e.note is not null and e.note <> ''), '[]'))
    from public.social_leads_post_events e join public.contracts ct on ct.id = e.contract_id, k, lim
    where e.company_id = c and ct.client_id = k.client_id and e.kind in ('approved', 'rejected')
     and (e.created_at at time zone (select tz from tz))::date between lim.ini and lim.fim
    having count(*) > 0),
  'whatsapp', coalesce((select jsonb_agg(x order by x->>'at') from (
    select jsonb_build_object('id', w.id, 'group', w.group_id, 'at', w.sent_at, 'from_team', w.from_me,
     'sender', w.sender_name, 'text', left(coalesce(nullif(w.content_text, ''), w.body), 280)) x
    from public.whatsapp_messages w join public.whatsapp_groups gr on gr.id = w.group_id, k, lim
    where w.company_id = c and gr.client_id = k.client_id
     and (w.sent_at at time zone (select tz from tz))::date between lim.ini and lim.fim
     and coalesce(nullif(w.content_text, ''), w.body) ~* '(aprov|arte|criativ|post|v[ií]deo|resultad|meta|lead|vend|campanha|satisf|gost|ador|insatisf|ruim|reclam|caro|cancel|parab|excelente|ótimo|otimo|não (est|gost)|nao (est|gost))'
    order by w.sent_at desc limit 40) t), '[]'),
  'radar', coalesce((select jsonb_agg(jsonb_build_object('id', i.id, 'topic', tp.name, 'title', i.title,
    'summary', left(coalesce(i.summary, ''), 240), 'status', i.status, 'severity', i.severity, 'last_seen', i.last_seen_at::date))
    from public.radar_items i join public.radar_topics tp on tp.id = i.topic_id, k, lim
    where i.company_id = c and i.client_id = k.client_id
     and (i.last_seen_at::date between lim.ini and lim.fim or i.first_seen_at::date between lim.ini and lim.fim)), '[]'))
$$;

-- O worker pega até p_limit pendentes e recebe o material de cada um.
create function public.cs_hs_claim(p_secret text, p_limit integer default 6) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare out jsonb; begin
 if not mavi_private.ai_secret_ok(p_secret) then raise exception 'Sem permissão' using errcode = '42501'; end if;
 with picked as (
  select company_id, cs_client_id, month from public.cs_hs_suggestions
  where done_at is null and attempts < 3 and (claimed_at is null or claimed_at < now() - interval '10 minutes')
  order by requested_at limit least(greatest(coalesce(p_limit, 6), 1), 20) for update skip locked),
 upd as (
  update public.cs_hs_suggestions s set claimed_at = now(), attempts = s.attempts + 1
  from picked where s.company_id = picked.company_id and s.cs_client_id = picked.cs_client_id and s.month = picked.month
  returning s.company_id, s.cs_client_id, s.month)
 select coalesce(jsonb_agg(jsonb_build_object('company_id', u.company_id, 'cs_client_id', u.cs_client_id, 'month', u.month,
   'today', mavi_private.company_today(u.company_id),
   'rules', mavi_private.cs_rules_at(u.company_id, u.month),
   'pack', mavi_private.cs_hs_pack(u.company_id, u.cs_client_id, u.month))), '[]') into out from upd u;
 return out;
end $$;

-- Grava as sugestões (ou o erro) e o custo de cada uma.
create function public.cs_hs_store(p_secret text, p_items jsonb) returns integer
language plpgsql security definer set search_path = '' as $$
declare it jsonb; n integer := 0; u jsonb; begin
 if not mavi_private.ai_secret_ok(p_secret) then raise exception 'Sem permissão' using errcode = '42501'; end if;
 for it in select value from jsonb_array_elements(case when jsonb_typeof(p_items) = 'array' then p_items else '[]' end) loop
  if it->>'error' is not null then
   update public.cs_hs_suggestions set error = left(it->>'error', 500), claimed_at = null
   where company_id = (it->>'company_id')::uuid and cs_client_id = (it->>'cs_client_id')::uuid and month = (it->>'month')::date;
   continue;
  end if;
  update public.cs_hs_suggestions set criteria = coalesce(it->'criteria', '{}'),
   score = least(100, greatest(0, (it->>'score')::numeric)), band = it->>'band', model = left(it->>'model', 120),
   done_at = now(), error = null, claimed_at = null
  where company_id = (it->>'company_id')::uuid and cs_client_id = (it->>'cs_client_id')::uuid and month = (it->>'month')::date;
  if found then n := n + 1; end if;
  u := it->'usage';
  if u is not null and coalesce((u->>'cost')::numeric, 0) > 0 then
   insert into public.ai_usage(company_id, user_id, module, kind, client_id, model, input_tokens, output_tokens,
    cache_read_tokens, cache_write_tokens, cost_usd, provider_id, provider_name)
   select k.company_id, null, 'clients', 'cs_health_score', k.client_id, left(coalesce(u->>'model', ''), 80),
    greatest(coalesce((u->>'input')::integer, 0), 0), greatest(coalesce((u->>'output')::integer, 0), 0),
    greatest(coalesce((u->>'cache_read')::integer, 0), 0), greatest(coalesce((u->>'cache_write')::integer, 0), 0),
    least(greatest(coalesce((u->>'cost')::numeric, 0), 0), 10),
    case when u->>'provider_id' ~* '^[0-9a-f-]{36}$' then (u->>'provider_id')::uuid end, left(coalesce(u->>'provider', ''), 120)
   from public.cs_clients k where k.company_id = (it->>'company_id')::uuid and k.id = (it->>'cs_client_id')::uuid;
  end if;
 end loop;
 if n > 0 then
  perform mavi_private.cs_changed(c.company_id, 'hs') from (select distinct (x->>'company_id')::uuid company_id
   from jsonb_array_elements(p_items) x where x->>'error' is null) c;
 end if;
 return n;
end $$;

-- As sugestões de um mês, com a nota lançada para comparar (quem vê CS: o
-- squad de quem é de squad, pelo squad do ciclo do mês).
create function public.cs_hs_suggestions(p_company uuid, p_month date) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare sc jsonb := mavi_private.cs_ai_scope(p_company); m date := date_trunc('month', p_month)::date; begin
 if sc is null then
  raise exception 'Sem acesso aos dados de Customer Success.' using errcode = '42501';
 end if;
 return jsonb_build_object(
  'month', m,
  'can_request', mavi_private.cs_reader(p_company),
  'pending', (select count(*) from public.cs_hs_suggestions s where s.company_id = p_company and s.month = m and s.done_at is null),
  'items', coalesce((select jsonb_agg(jsonb_build_object('cs_client_id', s.cs_client_id, 'criteria', s.criteria,
    'score', s.score, 'band', s.band, 'done_at', s.done_at, 'error', s.error, 'model', s.model,
    'registered', (select jsonb_build_object('score', h.score, 'band', h.band, 'goal', h.goal, 'perception', h.perception,
      'payment', h.payment, 'meeting', h.meeting, 'creatives', h.creatives) from public.cs_health_scores h
      where h.company_id = s.company_id and h.cs_client_id = s.cs_client_id and h.month = m)))
   from public.cs_hs_suggestions s join public.cs_clients k on k.company_id = s.company_id and k.id = s.cs_client_id
   where s.company_id = p_company and s.month = m
    and (sc->>'scope' = 'all' or (sc->'squads') ? coalesce((select y.squad_id::text from public.cs_cycles y
      where y.company_id = s.company_id and y.cs_client_id = s.cs_client_id and y.month = m), k.squad_id::text))), '[]'));
end $$;

do $$ begin
 if exists (select 1 from pg_extension where extname = 'pg_cron') then
  perform cron.schedule('mavi-cs-hs', '0 9 * * *', 'select mavi_private.cs_hs_auto();');
  perform cron.schedule('mavi-cs-hs-kick', '*/2 * * * *', 'select mavi_private.cs_hs_kick();');
 end if;
end $$;

revoke all on function mavi_private.cs_active_in(public.cs_clients, date), mavi_private.cs_hs_enqueue(uuid, date, uuid, interval),
 mavi_private.cs_hs_kick(), mavi_private.cs_hs_auto(), mavi_private.cs_hs_pack(uuid, uuid, date)
 from public, anon, authenticated;
revoke all on function public.cs_hs_request(uuid, date), public.cs_hs_suggestions(uuid, date),
 public.cs_hs_claim(text, integer), public.cs_hs_store(text, jsonb) from public;
grant execute on function public.cs_hs_request(uuid, date), public.cs_hs_suggestions(uuid, date) to authenticated;
grant execute on function public.cs_hs_claim(text, integer), public.cs_hs_store(text, jsonb) to anon, authenticated;

revoke all on function public.cs_ai_data(uuid), public.cs_ai_access() from public, anon;
grant execute on function public.cs_ai_data(uuid), public.cs_ai_access() to authenticated;

notify pgrst, 'reload schema';

commit;
