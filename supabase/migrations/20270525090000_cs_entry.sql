begin;

-- Customer Success, fase 5 (pedido de 06/10/2026): o lançamento no MAVI e a
-- planilha desligada.
--
--  * Chave única (cs_settings.source): enquanto a fonte é a planilha, ela
--    manda e as telas de lançamento são só prévia; um administrador vira
--    "Fonte: MAVI" quando estiver pronto — a leitura para e o histórico fica.
--    Dá para voltar à planilha (a próxima leitura sobrescreve o que ela tem).
--  * Quem lança: administradores e gestores tudo; quem está num squad lança
--    ciclos, pagamentos, Health Score e eventos dos clientes do próprio squad.
--    Cadastro de cliente, metas e regras só líderes.
--  * Cada lançamento fica no histórico (cs_edit_log), com antes e depois.
--  * Mês novo: um líder clica "Abrir mês", vê a prévia (ciclos copiados do
--    mês anterior) e confirma.

-- ------------------------------------------------------------ a chave
alter table public.cs_settings add column source text not null default 'sheet' check (source in ('sheet', 'mavi'));
alter table public.cs_settings add column source_changed_at timestamptz;
alter table public.cs_settings add column source_changed_by uuid;

create table public.cs_edit_log (
 id bigint generated always as identity primary key,
 company_id uuid not null references public.companies(id) on delete cascade,
 entity text not null check (entity in ('source', 'client', 'cycle', 'hs', 'goal', 'month')),
 action text not null check (action in ('insert', 'update', 'delete')),
 cs_client_id uuid,
 month date,
 squad_id uuid,
 before jsonb,
 after jsonb,
 reason text check (length(reason) <= 500),
 by uuid,
 at timestamptz not null default now()
);
create index cs_edit_log_company on public.cs_edit_log(company_id, at desc);
create index cs_edit_log_client on public.cs_edit_log(company_id, cs_client_id, at desc);
alter table public.cs_edit_log enable row level security;
revoke all on public.cs_edit_log from public, anon, authenticated;

create function mavi_private.cs_log(c uuid, p_entity text, p_action text, p_client uuid, p_month date, p_squad uuid,
 p_before jsonb, p_after jsonb, p_reason text default null) returns void
language sql security definer set search_path = '' as $$
 insert into public.cs_edit_log(company_id, entity, action, cs_client_id, month, squad_id, before, after, reason, by)
 select c, p_entity, p_action, p_client, p_month, p_squad, p_before, p_after, nullif(left(btrim(coalesce(p_reason, '')), 500), ''),
  auth.uid()
 where p_before is distinct from p_after
$$;

-- A fonte de CS da empresa ('sheet' quando nada foi configurado).
create function mavi_private.cs_source(c uuid) returns text
language sql stable security definer set search_path = '' as $$
 select coalesce((select source from public.cs_settings where company_id = c), 'sheet')
$$;

-- Pode lançar para o squad? (fonte MAVI; líder, ou membro do squad).
create function mavi_private.cs_can_write(c uuid, p_squad uuid) returns boolean
language sql stable security definer set search_path = '' as $$
 select mavi_private.cs_source(c) = 'mavi' and (mavi_private.cs_reader(c) or (p_squad is not null and exists (
  select 1 from public.cs_squad_members sm join public.memberships m on m.company_id = sm.company_id
   and m.user_id = sm.user_id and m.active
  where sm.company_id = c and sm.squad_id = p_squad and sm.user_id = auth.uid())))
$$;

create function mavi_private.cs_write_check(c uuid, p_squad uuid) returns void
language plpgsql stable security definer set search_path = '' as $$ begin
 if mavi_private.cs_source(c) <> 'mavi' then
  raise exception 'A fonte de CS ainda é a planilha: lance lá. Um administrador vira a chave em Equipe e configurações › Customer Success.'
   using errcode = '55000';
 end if;
 if not mavi_private.cs_can_write(c, p_squad) then
  raise exception 'Você só lança para os clientes do seu squad.' using errcode = '42501';
 end if;
end $$;

-- O que a tela de lançamento precisa saber: a fonte e o que a pessoa lança.
create function public.cs_entry_access(p_company uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare s public.cs_settings; sc jsonb := mavi_private.cs_ai_scope(p_company); begin
 if sc is null then raise exception 'Sem acesso aos dados de Customer Success.' using errcode = '42501'; end if;
 select * into s from public.cs_settings where company_id = p_company;
 return jsonb_build_object(
  'source', coalesce(s.source, 'sheet'),
  'source_changed_at', s.source_changed_at,
  'source_changed_by', (select m.name from public.memberships m where m.company_id = p_company and m.user_id = s.source_changed_by),
  'has_sheet', s.sheet_id is not null,
  'can_switch', mavi_private.admin(p_company),
  'is_leader', mavi_private.cs_reader(p_company),
  'scope', sc,
  'today', mavi_private.company_today(p_company));
end $$;

-- A configuração de CS (igual à de 20270520090000) com a fonte.
create or replace function public.cs_settings(p_company uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare s public.cs_settings; r public.cs_sync_runs; begin
 if not mavi_private.cs_reader(p_company) then
  raise exception 'Sem permissão' using errcode = '42501';
 end if;
 select * into s from public.cs_settings where company_id = p_company;
 select * into r from public.cs_sync_runs where company_id = p_company order by started_at desc limit 1;
 return jsonb_build_object(
  'sheet_id', s.sheet_id,
  'enabled', coalesce(s.enabled, false),
  'source', coalesce(s.source, 'sheet'),
  'source_changed_at', s.source_changed_at,
  'source_changed_by', (select m.name from public.memberships m where m.company_id = p_company and m.user_id = s.source_changed_by),
  'can_edit', mavi_private.admin(p_company),
  'running', s.claimed_at is not null and s.claimed_at > now() - interval '3 minutes',
  'last_run', case when r.id is not null then mavi_private.cs_run_row(r) end,
  'last_ok_at', (select max(finished_at) from public.cs_sync_runs
   where company_id = p_company and status <> 'error'),
  'totals', jsonb_build_object(
   'clients', (select count(*) from public.cs_clients where company_id = p_company),
   'active', (select count(*) from public.cs_clients where company_id = p_company and status <> 'INATIVO'),
   'linked', (select count(*) from public.cs_clients where company_id = p_company and client_id is not null),
   'cycles', (select count(*) from public.cs_cycles where company_id = p_company),
   'months', coalesce((select jsonb_agg(jsonb_build_object('month', month, 'cycles', n) order by month desc)
    from (select month, count(*) n from public.cs_cycles where company_id = p_company group by month) x), '[]'),
   'hs_months', coalesce((select jsonb_agg(month order by month desc)
    from (select distinct month from public.cs_health_scores where company_id = p_company) x), '[]'),
   'goals', (select count(*) from public.cs_goals where company_id = p_company)));
end $$;

-- Vira a chave (só administradores, com motivo).
create function public.set_cs_source(p_company uuid, p_source text, p_reason text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare old text := mavi_private.cs_source(p_company); begin
 if not mavi_private.admin(p_company) then
  raise exception 'Somente administradores trocam a fonte dos dados de CS.' using errcode = '42501';
 end if;
 if p_source not in ('sheet', 'mavi') then raise exception 'Fonte inválida.' using errcode = '22023'; end if;
 if length(btrim(coalesce(p_reason, ''))) < 3 then raise exception 'Diga o motivo da troca.' using errcode = '22023'; end if;
 if p_source = 'sheet' and not exists (select 1 from public.cs_settings where company_id = p_company and sheet_id is not null) then
  raise exception 'Configure o link da planilha antes de voltar para ela.' using errcode = '22023';
 end if;
 perform pg_advisory_xact_lock(hashtextextended('cs_sync:' || p_company::text, 0));
 insert into public.cs_settings(company_id, source, source_changed_at, source_changed_by, enabled, updated_by)
 values (p_company, p_source, now(), auth.uid(), p_source = 'sheet', auth.uid())
 on conflict (company_id) do update set source = excluded.source, source_changed_at = now(),
  source_changed_by = auth.uid(), enabled = (excluded.source = 'sheet'), updated_by = auth.uid(), updated_at = now();
 perform mavi_private.cs_log(p_company, 'source', 'update', null, null, null, to_jsonb(old), to_jsonb(p_source), p_reason);
 perform mavi_private.cs_changed(p_company, 'source');
 return public.cs_entry_access(p_company);
end $$;

-- A leitura da planilha só roda com a fonte na planilha (iguais às de
-- 20270520090000, mais a condição da fonte).
create or replace function mavi_private.cs_sync_kick() returns void
language plpgsql security definer set search_path = '' as $$
declare cfg mavi_private.ai_config; begin
 select * into cfg from mavi_private.ai_config where id;
 if not found then return; end if;
 if not exists (select 1 from public.cs_settings s where s.enabled and s.source = 'sheet' and s.sheet_id is not null
  and (s.last_attempt_at is null or s.last_attempt_at < now() - interval '9 minutes')
  and (s.claimed_at is null or s.claimed_at < now() - interval '5 minutes')) then return; end if;
 perform net.http_post(url := cfg.url, body := '{"action":"cs-sync"}'::jsonb,
  headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || cfg.secret),
  timeout_milliseconds := 60000);
end $$;

create or replace function public.cs_sync_targets(p_secret text, p_company uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v jsonb; begin
 if p_company is null then
  if not mavi_private.ai_secret_ok(p_secret) then
   raise exception 'Sem permissão' using errcode = '42501';
  end if;
  with due as (
   select company_id from public.cs_settings
   where enabled and source = 'sheet' and sheet_id is not null
    and (last_attempt_at is null or last_attempt_at < now() - interval '9 minutes')
    and (claimed_at is null or claimed_at < now() - interval '5 minutes')
   for update skip locked),
  upd as (
   update public.cs_settings s set claimed_at = now(), last_attempt_at = now()
   from due where s.company_id = due.company_id
   returning s.company_id, s.sheet_id)
  select coalesce(jsonb_agg(jsonb_build_object('company', company_id, 'sheet_id', sheet_id)), '[]') into v from upd;
  return v;
 end if;
 if not mavi_private.cs_sync_allowed(p_secret, p_company) then
  raise exception 'Sem permissão' using errcode = '42501';
 end if;
 if mavi_private.cs_source(p_company) = 'mavi' then
  raise exception 'A fonte de CS é o MAVI: a planilha não é mais lida. Para voltar a ela, troque a fonte em Equipe e configurações › Customer Success.'
   using errcode = '55000';
 end if;
 if not exists (select 1 from public.cs_settings where company_id = p_company and sheet_id is not null) then
  raise exception 'Configure o link da planilha de CS antes de sincronizar.' using errcode = '22023';
 end if;
 update public.cs_settings set claimed_at = now(), last_attempt_at = now()
 where company_id = p_company and (claimed_at is null or claimed_at < now() - interval '2 minutes')
 returning jsonb_build_array(jsonb_build_object('company', company_id, 'sheet_id', sheet_id)) into v;
 if v is null then
  raise exception 'Uma leitura da planilha já está em andamento. Aguarde um minuto.' using errcode = '55P03';
 end if;
 return v;
end $$;

-- Uma leitura que começou antes da troca não grava depois dela: a gravação
-- da leitura passa pela mesma trava da troca e confere a fonte.
alter function public.cs_sync_store(text, uuid, jsonb, text, text, boolean) rename to cs_sync_store_sheet;
alter function public.cs_sync_store_sheet(text, uuid, jsonb, text, text, boolean) set schema mavi_private;
revoke all on function mavi_private.cs_sync_store_sheet(text, uuid, jsonb, text, text, boolean) from public, anon, authenticated;

create function public.cs_sync_store(p_secret text, p_company uuid, p_payload jsonb, p_error text,
 p_trigger text, p_allow_removals boolean default false) returns jsonb
language plpgsql security definer set search_path = '' as $$ begin
 if not mavi_private.cs_sync_allowed(p_secret, p_company) then
  raise exception 'Sem permissão' using errcode = '42501';
 end if;
 perform pg_advisory_xact_lock(hashtextextended('cs_sync:' || p_company::text, 0));
 if mavi_private.cs_source(p_company) = 'mavi' then
  raise exception 'A fonte de CS virou o MAVI durante a leitura: nada da planilha foi gravado.' using errcode = '55000';
 end if;
 return mavi_private.cs_sync_store_sheet(p_secret, p_company, p_payload, p_error, p_trigger, p_allow_removals);
end $$;
revoke all on function public.cs_sync_store(text, uuid, jsonb, text, text, boolean) from public;
grant execute on function public.cs_sync_store(text, uuid, jsonb, text, text, boolean) to anon, authenticated;

-- A base de CS (igual à de 20270524090000) com a fonte no 'sync'.
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
  -- Fonte MAVI: o último lançamento no lugar da última leitura da planilha.
  'sync', case when mavi_private.cs_source(c) = 'mavi' then jsonb_build_object('source', 'mavi',
    'finished_at', (select max(l.at) from public.cs_edit_log l where l.company_id = c), 'status', 'ok', 'warnings', 0)
   else (select jsonb_build_object('source', 'sheet', 'finished_at', x.finished_at, 'status', x.status,
    'warnings', cardinality(x.warnings))
    from public.cs_sync_runs x where x.company_id = c order by x.started_at desc limit 1) end
 )
$$;

-- ------------------------------------------------------------ ciclos
-- Lê um valor do patch: o novo se veio, senão o atual.
create function mavi_private.cs_pick(p jsonb, k text, cur text) returns text
language sql immutable set search_path = '' as $$
 select case when p ? k then nullif(btrim(p->>k), '') else cur end
$$;

-- Grava o ciclo de um cliente no mês (cria ou altera só o que veio).
create function public.save_cs_cycle(p_company uuid, p_client uuid, p_month date, p_fields jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare m date := date_trunc('month', p_month)::date; k public.cs_clients; y public.cs_cycles; before jsonb;
 v_squad uuid; pays jsonb; v_paid numeric; v_paid_date date; n numeric; begin
 select * into k from public.cs_clients where company_id = p_company and id = p_client;
 if not found then raise exception 'Cliente de CS não encontrado.' using errcode = 'P0002'; end if;
 if jsonb_typeof(p_fields) <> 'object' then raise exception 'Campos inválidos.' using errcode = '22023'; end if;
 select * into y from public.cs_cycles where company_id = p_company and cs_client_id = p_client and month = m;
 before := case when found then to_jsonb(y) end;
 -- O squad do ciclo (o novo, o atual do ciclo ou o do cliente) decide quem lança.
 v_squad := coalesce(mavi_private.cs_pick(p_fields, 'squad_id', y.squad_id::text)::uuid, y.squad_id, k.squad_id);
 perform mavi_private.cs_write_check(p_company, coalesce(y.squad_id, k.squad_id));
 perform mavi_private.cs_write_check(p_company, v_squad);
 if y.id is null then
  y.company_id := p_company; y.cs_client_id := p_client; y.month := m; y.best := 0; y.probable := 0;
  y.probability := 'PROVAVEL'; y.paid := 0; y.status := 'PENDENTE'; y.adimplencia := 'ADIMPLENTE'; y.acl := false;
  y.m1_discounted := false;
 end if;
 begin
  y.squad_id := mavi_private.cs_pick(p_fields, 'squad_id', y.squad_id::text)::uuid;
  y.start_date := mavi_private.cs_pick(p_fields, 'start_date', y.start_date::text)::date;
  y.end_date := mavi_private.cs_pick(p_fields, 'end_date', y.end_date::text)::date;
  y.billing_date := mavi_private.cs_pick(p_fields, 'billing_date', y.billing_date::text)::date;
  y.best := coalesce(mavi_private.cs_pick(p_fields, 'best', y.best::text)::numeric, 0);
  y.probable := coalesce(mavi_private.cs_pick(p_fields, 'probable', y.probable::text)::numeric, 0);
  y.probability := upper(coalesce(mavi_private.cs_pick(p_fields, 'probability', y.probability), 'PROVAVEL'));
  y.paid := coalesce(mavi_private.cs_pick(p_fields, 'paid', y.paid::text)::numeric, 0);
  y.paid_date := mavi_private.cs_pick(p_fields, 'paid_date', y.paid_date::text)::date;
  y.status := upper(coalesce(mavi_private.cs_pick(p_fields, 'status', y.status), 'PENDENTE'));
  y.adimplencia := upper(coalesce(mavi_private.cs_pick(p_fields, 'adimplencia', y.adimplencia), 'ADIMPLENTE'));
  y.acl := coalesce(mavi_private.cs_pick(p_fields, 'acl', y.acl::text)::boolean, false);
  y.acl_value := case when y.acl then nullif(mavi_private.cs_pick(p_fields, 'acl_value', y.acl_value::text)::numeric, 0) end;
  y.fee_planned := nullif(mavi_private.cs_pick(p_fields, 'fee_planned', y.fee_planned::text)::numeric, 0);
  y.fee_paid := nullif(mavi_private.cs_pick(p_fields, 'fee_paid', y.fee_paid::text)::numeric, 0);
  y.notes := left(mavi_private.cs_pick(p_fields, 'notes', y.notes), 5000);
 exception when others then
  raise exception 'Valor inválido: confira datas (AAAA-MM-DD) e números.' using errcode = '22023';
 end;
 if y.squad_id is not null and not exists (select 1 from public.cs_squads where company_id = p_company and id = y.squad_id) then
  raise exception 'Squad inválido.' using errcode = '22023';
 end if;
 if y.probability not in ('ALTA', 'PROVAVEL', 'BAIXA') or y.status not in ('PAGO', 'PARCIAL', 'PENDENTE', 'PERDA', 'ISENTO')
  or y.adimplencia not in ('ADIMPLENTE', 'INADIMPLENTE', 'PERDA') then
  raise exception 'Probabilidade, status ou adimplência inválidos.' using errcode = '22023';
 end if;
 foreach n in array array[y.best, y.probable, y.paid, coalesce(y.acl_value, 0), coalesce(y.fee_planned, 0), coalesce(y.fee_paid, 0)] loop
  if n < 0 or n > 100000000 then raise exception 'Valores de 0 a R$ 100 milhões.' using errcode = '22023'; end if;
 end loop;
 if y.start_date is not null and y.end_date is not null and y.end_date < y.start_date then
  raise exception 'O fim do ciclo vem antes do início.' using errcode = '22023';
 end if;
 -- Pagamento picado: as parcelas somam o pago, e a data é a da primeira.
 pays := p_fields->'payments';
 if pays is not null then
  if jsonb_typeof(pays) <> 'array' or jsonb_array_length(pays) > 6 then
   raise exception 'Até 6 parcelas.' using errcode = '22023';
  end if;
  begin
   select sum((x->>'amount')::numeric), min((x->>'date')::date) into v_paid, v_paid_date
   from jsonb_array_elements(pays) x where coalesce((x->>'amount')::numeric, 0) > 0;
  exception when others then
   raise exception 'Parcela inválida: data (AAAA-MM-DD) e valor.' using errcode = '22023';
  end;
  if v_paid is not null then y.paid := v_paid; y.paid_date := v_paid_date; end if;
 end if;
 y.source := 'app';
 y.updated_at := now();
 insert into public.cs_cycles as t(company_id, cs_client_id, month, squad_id, start_date, end_date, billing_date, best,
  probable, probability, paid, paid_date, status, adimplencia, acl, acl_value, fee_planned, fee_paid, m1_discounted, notes, source)
 values (p_company, p_client, m, y.squad_id, y.start_date, y.end_date, y.billing_date, y.best, y.probable, y.probability,
  y.paid, y.paid_date, y.status, y.adimplencia, y.acl, y.acl_value, y.fee_planned, y.fee_paid, coalesce(y.m1_discounted, false),
  y.notes, 'app')
 on conflict (company_id, cs_client_id, month) do update set squad_id = excluded.squad_id, start_date = excluded.start_date,
  end_date = excluded.end_date, billing_date = excluded.billing_date, best = excluded.best, probable = excluded.probable,
  probability = excluded.probability, paid = excluded.paid, paid_date = excluded.paid_date, status = excluded.status,
  adimplencia = excluded.adimplencia, acl = excluded.acl, acl_value = excluded.acl_value, fee_planned = excluded.fee_planned,
  fee_paid = excluded.fee_paid, notes = excluded.notes, source = 'app', updated_at = now()
 returning * into y;
 -- O pago digitado direto (sem parcelas) substitui as parcelas que havia.
 if pays is null and (p_fields ? 'paid' or p_fields ? 'paid_date') then
  delete from public.cs_cycle_payments where company_id = p_company and cycle_id = y.id;
 end if;
 if pays is not null then
  delete from public.cs_cycle_payments where company_id = p_company and cycle_id = y.id;
  insert into public.cs_cycle_payments(company_id, cycle_id, ord, paid_date, amount)
  select p_company, y.id, row_number() over (order by (x->>'date')::date), (x->>'date')::date, (x->>'amount')::numeric
  from jsonb_array_elements(pays) x where coalesce((x->>'amount')::numeric, 0) > 0 and x->>'date' is not null;
 end if;
 -- Replanejamento: a foto quando o fim do ciclo, a cobrança ou o provável mudam (como a leitura da planilha).
 if before is null or (before->>'end_date') is distinct from y.end_date::text or (before->>'billing_date') is distinct from y.billing_date::text
  or abs(coalesce((before->>'probable')::numeric, 0) - y.probable) > 0.009 then
  insert into public.cs_cycle_history(company_id, cs_client_id, month, end_date, billing_date, probable)
  values (p_company, p_client, m, y.end_date, y.billing_date, y.probable);
 end if;
 perform mavi_private.cs_log(p_company, 'cycle', case when before is null then 'insert' else 'update' end, p_client, m,
  coalesce(y.squad_id, k.squad_id), before - 'updated_at' - 'created_at', to_jsonb(y) - 'updated_at' - 'created_at');
 perform mavi_private.cs_changed(p_company, 'entry');
 return to_jsonb(y) || jsonb_build_object('payments', coalesce((select jsonb_agg(jsonb_build_object('ord', p.ord, 'date', p.paid_date,
  'amount', p.amount) order by p.ord) from public.cs_cycle_payments p where p.company_id = p_company and p.cycle_id = y.id), '[]'));
end $$;

create function public.delete_cs_cycle(p_company uuid, p_client uuid, p_month date, p_reason text) returns void
language plpgsql security definer set search_path = '' as $$
declare y public.cs_cycles; k public.cs_clients; begin
 select * into k from public.cs_clients where company_id = p_company and id = p_client;
 select * into y from public.cs_cycles where company_id = p_company and cs_client_id = p_client
  and month = date_trunc('month', p_month)::date;
 if y.id is null then raise exception 'Ciclo não encontrado.' using errcode = 'P0002'; end if;
 perform mavi_private.cs_write_check(p_company, coalesce(y.squad_id, k.squad_id));
 if length(btrim(coalesce(p_reason, ''))) < 3 then raise exception 'Diga o motivo.' using errcode = '22023'; end if;
 delete from public.cs_cycles where id = y.id;
 perform mavi_private.cs_log(p_company, 'cycle', 'delete', p_client, y.month, coalesce(y.squad_id, k.squad_id),
  to_jsonb(y) - 'updated_at' - 'created_at', null, p_reason);
 perform mavi_private.cs_changed(p_company, 'entry');
end $$;

-- ------------------------------------------------------------ Health Score
create function public.save_cs_hs(p_company uuid, p_client uuid, p_month date, p_fields jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare m date := date_trunc('month', p_month)::date; k public.cs_clients; h public.cs_health_scores; before jsonb;
 v_squad uuid; begin
 select * into k from public.cs_clients where company_id = p_company and id = p_client;
 if not found then raise exception 'Cliente de CS não encontrado.' using errcode = 'P0002'; end if;
 v_squad := coalesce((select squad_id from public.cs_cycles where company_id = p_company and cs_client_id = p_client and month = m),
  k.squad_id);
 perform mavi_private.cs_write_check(p_company, v_squad);
 select * into h from public.cs_health_scores where company_id = p_company and cs_client_id = p_client and month = m;
 before := case when found then to_jsonb(h) end;
 begin
  insert into public.cs_health_scores as t(company_id, cs_client_id, month, creatives, meeting, payment, perception, goal,
   manual_score, notes, source)
  values (p_company, p_client, m,
   coalesce((p_fields->>'creatives')::boolean, h.creatives, false), coalesce((p_fields->>'meeting')::boolean, h.meeting, false),
   coalesce((p_fields->>'payment')::boolean, h.payment, false), coalesce((p_fields->>'perception')::boolean, h.perception, false),
   coalesce((p_fields->>'goal')::boolean, h.goal, false),
   case when p_fields ? 'manual_score' then nullif(p_fields->>'manual_score', '')::numeric else h.manual_score end,
   left(case when p_fields ? 'notes' then nullif(btrim(p_fields->>'notes'), '') else h.notes end, 2000), 'app')
  on conflict (company_id, cs_client_id, month) do update set creatives = excluded.creatives, meeting = excluded.meeting,
   payment = excluded.payment, perception = excluded.perception, goal = excluded.goal, manual_score = excluded.manual_score,
   notes = excluded.notes, source = 'app'
  returning * into h;
 exception when check_violation or invalid_text_representation then
  raise exception 'Critérios sim/não e nota de 0 a 100.' using errcode = '22023';
 end;
 perform mavi_private.cs_log(p_company, 'hs', case when before is null then 'insert' else 'update' end, p_client, m, v_squad,
  before - 'updated_at', to_jsonb(h) - 'updated_at');
 perform mavi_private.cs_changed(p_company, 'entry');
 return to_jsonb(h);
end $$;

-- ------------------------------------------------------------ clientes (líderes)
create function public.save_cs_client(p_company uuid, p_id uuid, p_fields jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare k public.cs_clients; before jsonb; v_churn date; begin
 if not mavi_private.cs_reader(p_company) then
  raise exception 'Só administradores e gestores cadastram clientes de CS.' using errcode = '42501';
 end if;
 perform mavi_private.cs_write_check(p_company, null);
 if p_id is not null then
  select * into k from public.cs_clients where company_id = p_company and id = p_id;
  if not found then raise exception 'Cliente de CS não encontrado.' using errcode = 'P0002'; end if;
  before := to_jsonb(k);
 else
  k.company_id := p_company; k.origin := 'comercial'; k.kind := 'BASE'; k.status := 'ATIVO'; k.link_mode := 'auto';
 end if;
 begin
  k.external_id := mavi_private.cs_pick(p_fields, 'external_id', k.external_id);
  k.name := mavi_private.cs_pick(p_fields, 'name', k.name);
  k.squad_id := mavi_private.cs_pick(p_fields, 'squad_id', k.squad_id::text)::uuid;
  k.vertical := mavi_private.cs_pick(p_fields, 'vertical', k.vertical);
  k.origin := lower(coalesce(mavi_private.cs_pick(p_fields, 'origin', k.origin), 'comercial'));
  k.kind := upper(coalesce(mavi_private.cs_pick(p_fields, 'kind', k.kind), 'BASE'));
  k.trial_month := mavi_private.cs_pick(p_fields, 'trial_month', k.trial_month::text)::smallint;
  k.status := upper(coalesce(mavi_private.cs_pick(p_fields, 'status', k.status), 'ATIVO'));
  k.entry_date := mavi_private.cs_pick(p_fields, 'entry_date', k.entry_date::text)::date;
  v_churn := mavi_private.cs_pick(p_fields, 'churn_date', k.churn_date::text)::date;
  -- Segundo churn de quem foi reativado: o par antigo vai para os eventos
  -- (como a aba EVENTOS da planilha) e o churn novo fica no cadastro.
  if k.churn_date is not null and k.reactivation_date is not null and k.reactivation_date > k.churn_date
   and v_churn is not null and v_churn > k.reactivation_date then
   insert into public.cs_client_events(company_id, cs_client_id, kind, date, churn_reason)
   values (p_company, k.id, 'CHURN', k.churn_date, k.churn_reason), (p_company, k.id, 'REATIVACAO', k.reactivation_date, null)
   on conflict do nothing;
   k.reactivation_date := case when p_fields ? 'reactivation_date' and (p_fields->>'reactivation_date')::date > v_churn
    then (p_fields->>'reactivation_date')::date end;
  else
   k.reactivation_date := mavi_private.cs_pick(p_fields, 'reactivation_date', k.reactivation_date::text)::date;
  end if;
  k.churn_date := v_churn;
  k.churn_reason := lower(mavi_private.cs_pick(p_fields, 'churn_reason', k.churn_reason));
  k.notes := left(mavi_private.cs_pick(p_fields, 'notes', k.notes), 5000);
 exception when others then
  raise exception 'Valor inválido: confira datas (AAAA-MM-DD), squad e números.' using errcode = '22023';
 end;
 if k.external_id is null or k.external_id !~ '^[0-9]{1,20}$' then raise exception 'O ID (código) é um número.' using errcode = '22023'; end if;
 if length(btrim(coalesce(k.name, ''))) = 0 then raise exception 'Informe o nome.' using errcode = '22023'; end if;
 if k.squad_id is null then raise exception 'Escolha o squad.' using errcode = '22023'; end if;
 if k.entry_date is null then raise exception 'Informe a data de entrada.' using errcode = '22023'; end if;
 if k.churn_date is not null and k.churn_date < k.entry_date then raise exception 'O churn vem antes da entrada.' using errcode = '22023'; end if;
 begin
  if p_id is null then
   insert into public.cs_clients(company_id, external_id, name, squad_id, vertical, origin, kind, trial_month, status, entry_date,
    churn_date, reactivation_date, churn_reason, notes)
   values (p_company, k.external_id, btrim(k.name), k.squad_id, k.vertical, k.origin, k.kind, k.trial_month, k.status,
    k.entry_date, k.churn_date, k.reactivation_date, k.churn_reason, k.notes)
   returning * into k;
  else
   update public.cs_clients set external_id = k.external_id, name = btrim(k.name), squad_id = k.squad_id, vertical = k.vertical,
    origin = k.origin, kind = k.kind, trial_month = k.trial_month, status = k.status, entry_date = k.entry_date,
    churn_date = k.churn_date, reactivation_date = k.reactivation_date, churn_reason = k.churn_reason, notes = k.notes,
    updated_at = now()
   where company_id = p_company and id = p_id returning * into k;
  end if;
 exception
  when unique_violation then raise exception 'Já existe um cliente de CS com esse ID.' using errcode = '23505';
  when check_violation or foreign_key_violation then
   raise exception 'Valor inválido: origem, tipo, status, motivo ou squad.' using errcode = '22023';
 end;
 if p_id is null then perform mavi_private.cs_link_auto(p_company, k.id); end if;
 perform mavi_private.cs_log(p_company, 'client', case when p_id is null then 'insert' else 'update' end, k.id, null, k.squad_id,
  before - 'updated_at', to_jsonb(k) - 'updated_at');
 perform mavi_private.cs_changed(p_company, 'entry');
 return to_jsonb(k);
end $$;

create function public.delete_cs_client(p_company uuid, p_id uuid, p_reason text) returns void
language plpgsql security definer set search_path = '' as $$
declare k public.cs_clients; begin
 if not mavi_private.cs_reader(p_company) then
  raise exception 'Só administradores e gestores excluem clientes de CS.' using errcode = '42501';
 end if;
 perform mavi_private.cs_write_check(p_company, null);
 if length(btrim(coalesce(p_reason, ''))) < 3 then raise exception 'Diga o motivo.' using errcode = '22023'; end if;
 delete from public.cs_clients where company_id = p_company and id = p_id returning * into k;
 if k.id is null then raise exception 'Cliente de CS não encontrado.' using errcode = 'P0002'; end if;
 perform mavi_private.cs_log(p_company, 'client', 'delete', null, null, k.squad_id, to_jsonb(k), null, p_reason);
 perform mavi_private.cs_changed(p_company, 'entry');
end $$;

-- ------------------------------------------------------------ metas (líderes)
create function public.save_cs_goal(p_company uuid, p_squad uuid, p_month date, p_revenue numeric, p_retention numeric,
 p_ticket numeric) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare m date := date_trunc('month', p_month)::date; g public.cs_goals; before jsonb; begin
 if not mavi_private.cs_reader(p_company) then
  raise exception 'Só administradores e gestores lançam as metas.' using errcode = '42501';
 end if;
 perform mavi_private.cs_write_check(p_company, null);
 select * into g from public.cs_goals where company_id = p_company and squad_id = p_squad and month = m;
 before := case when found then to_jsonb(g) end;
 if p_revenue is null then
  delete from public.cs_goals where company_id = p_company and squad_id = p_squad and month = m;
  g := null;
 else
  if p_revenue < 0 or p_revenue > 1000000000 then raise exception 'Meta inválida.' using errcode = '22023'; end if;
  insert into public.cs_goals as t(company_id, squad_id, month, revenue, retention_pct, ticket)
  values (p_company, p_squad, m, p_revenue, p_retention, p_ticket)
  on conflict (company_id, squad_id, month) do update set revenue = excluded.revenue, retention_pct = excluded.retention_pct,
   ticket = excluded.ticket, updated_at = now()
  returning * into g;
 end if;
 perform mavi_private.cs_log(p_company, 'goal', case when before is null then 'insert' when g.squad_id is null then 'delete'
  else 'update' end, null, m, p_squad, before - 'updated_at', case when g.squad_id is not null then to_jsonb(g) - 'updated_at' end);
 perform mavi_private.cs_changed(p_company, 'entry');
 return to_jsonb(g);
exception when foreign_key_violation then raise exception 'Squad inválido.' using errcode = '22023';
end $$;

-- ------------------------------------------------------------ abrir o mês (líderes)
-- Os clientes na carteira no mês sem ciclo, com os valores do mês anterior
-- (provável, melhor, probabilidade, squad e datas um mês depois). Sem
-- p_confirm, só a prévia.
create function public.cs_open_month(p_company uuid, p_month date, p_confirm boolean default false) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare m date := date_trunc('month', p_month)::date; prev date := (m - interval '1 month')::date; items jsonb; n integer := 0;
 r record; begin
 if not mavi_private.cs_reader(p_company) then
  raise exception 'Só administradores e gestores abrem o mês.' using errcode = '42501';
 end if;
 perform mavi_private.cs_write_check(p_company, null);
 if m > (date_trunc('month', mavi_private.company_today(p_company)) + interval '1 month')::date then
  raise exception 'Dá para abrir até o próximo mês.' using errcode = '22023';
 end if;
 select coalesce(jsonb_agg(jsonb_build_object('cs_client_id', k.id, 'external_id', k.external_id, 'name', k.name,
   'squad_id', coalesce(p.squad_id, k.squad_id), 'kind', k.kind, 'from_previous', p.id is not null,
   'best', coalesce(p.best, 0), 'probable', coalesce(p.probable, 0), 'probability', coalesce(p.probability, 'PROVAVEL'),
   'start_date', (p.start_date + interval '1 month')::date, 'end_date', (p.end_date + interval '1 month')::date,
   'billing_date', (p.billing_date + interval '1 month')::date, 'fee_planned', p.fee_planned)
   order by k.name), '[]') into items
 from public.cs_clients k
 left join public.cs_cycles p on p.company_id = k.company_id and p.cs_client_id = k.id and p.month = prev
 where k.company_id = p_company and mavi_private.cs_active_in(k, m)
  and not exists (select 1 from public.cs_cycles y where y.company_id = k.company_id and y.cs_client_id = k.id and y.month = m);
 if not p_confirm then return jsonb_build_object('month', m, 'items', items, 'created', 0); end if;
 for r in select x from jsonb_array_elements(items) x loop
  insert into public.cs_cycles(company_id, cs_client_id, month, squad_id, start_date, end_date, billing_date, best, probable,
   probability, fee_planned, source)
  values (p_company, (r.x->>'cs_client_id')::uuid, m, (r.x->>'squad_id')::uuid, (r.x->>'start_date')::date,
   (r.x->>'end_date')::date, (r.x->>'billing_date')::date, (r.x->>'best')::numeric, (r.x->>'probable')::numeric,
   r.x->>'probability', (r.x->>'fee_planned')::numeric, 'app')
  on conflict do nothing;
  if found then
   n := n + 1;
   insert into public.cs_cycle_history(company_id, cs_client_id, month, end_date, billing_date, probable)
   values (p_company, (r.x->>'cs_client_id')::uuid, m, (r.x->>'end_date')::date, (r.x->>'billing_date')::date,
    (r.x->>'probable')::numeric);
  end if;
 end loop;
 if n > 0 then
  perform mavi_private.cs_log(p_company, 'month', 'insert', null, m, null, null, jsonb_build_object('created', n));
  perform mavi_private.cs_changed(p_company, 'entry');
 end if;
 return jsonb_build_object('month', m, 'items', items, 'created', n);
end $$;

-- ------------------------------------------------------------ a grade do mês
-- O que a tela de lançamento mostra num mês: os clientes que a pessoa vê
-- (o squad: os do squad hoje ou com ciclo do squad no mês), os ciclos com
-- as parcelas e as observações, o Health Score e as metas.
create function public.cs_entry_month(p_company uuid, p_month date) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare m date := date_trunc('month', p_month)::date; sc jsonb := mavi_private.cs_ai_scope(p_company); v_all boolean;
 ids uuid[]; begin
 if sc is null then raise exception 'Sem acesso aos dados de Customer Success.' using errcode = '42501'; end if;
 v_all := sc->>'scope' = 'all';
 select coalesce(array_agg(k.id), '{}') into ids from public.cs_clients k
 where k.company_id = p_company and (v_all or (sc->'squads') ? (k.squad_id::text) or exists (
  select 1 from public.cs_cycles y where y.company_id = k.company_id and y.cs_client_id = k.id and y.month = m
   and (sc->'squads') ? (y.squad_id::text)));
 return jsonb_build_object(
  'month', m,
  'access', public.cs_entry_access(p_company),
  'squads', coalesce((select jsonb_agg(jsonb_build_object('id', s.id, 'name', s.name, 'color', s.color, 'archived', s.archived)
   order by s.archived, s.sort, s.name) from public.cs_squads s where s.company_id = p_company), '[]'),
  'clients', coalesce((select jsonb_agg(jsonb_build_object('id', k.id, 'external_id', k.external_id, 'name', k.name,
   'squad_id', k.squad_id, 'vertical', k.vertical, 'origin', k.origin, 'kind', k.kind, 'trial_month', k.trial_month,
   'status', k.status, 'entry_date', k.entry_date, 'churn_date', k.churn_date, 'reactivation_date', k.reactivation_date,
   'churn_reason', k.churn_reason, 'notes', k.notes, 'client_name', cl.name, 'active', mavi_private.cs_active_in(k, m))
   order by k.name) from public.cs_clients k left join public.clients cl on cl.company_id = k.company_id and cl.id = k.client_id
   where k.company_id = p_company and k.id = any(ids)), '[]'),
  'cycles', coalesce((select jsonb_agg(to_jsonb(y) - 'company_id' - 'created_at' || jsonb_build_object('payments',
   coalesce((select jsonb_agg(jsonb_build_object('ord', p.ord, 'date', p.paid_date, 'amount', p.amount) order by p.ord)
    from public.cs_cycle_payments p where p.company_id = y.company_id and p.cycle_id = y.id), '[]')))
   from public.cs_cycles y where y.company_id = p_company and y.month = m and y.cs_client_id = any(ids)), '[]'),
  'previous', coalesce((select jsonb_agg(jsonb_build_object('cs_client_id', y.cs_client_id, 'probable', y.probable,
   'paid', y.paid, 'status', y.status)) from public.cs_cycles y
   where y.company_id = p_company and y.month = (m - interval '1 month')::date and y.cs_client_id = any(ids)), '[]'),
  'hs', coalesce((select jsonb_agg(to_jsonb(h) - 'company_id') from public.cs_health_scores h
   where h.company_id = p_company and h.month = m and h.cs_client_id = any(ids)), '[]'),
  'goals', coalesce((select jsonb_agg(to_jsonb(g) - 'company_id') from public.cs_goals g
   where g.company_id = p_company and g.month = m and (v_all or (sc->'squads') ? (g.squad_id::text))), '[]'),
  'rules', mavi_private.cs_rules_at(p_company, m));
end $$;

-- ------------------------------------------------------------ histórico
create function public.cs_edit_log_list(p_company uuid, p_client uuid default null, p_limit integer default 100) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare sc jsonb := mavi_private.cs_ai_scope(p_company); begin
 if sc is null then raise exception 'Sem acesso aos dados de Customer Success.' using errcode = '42501'; end if;
 return coalesce((select jsonb_agg(x order by (x->>'at') desc) from (
  select jsonb_build_object('id', l.id, 'entity', l.entity, 'action', l.action, 'cs_client_id', l.cs_client_id,
   'client_name', (select k.name from public.cs_clients k where k.id = l.cs_client_id), 'month', l.month,
   'squad_id', l.squad_id, 'before', l.before, 'after', l.after, 'reason', l.reason, 'at', l.at,
   'by_name', (select m.name from public.memberships m where m.company_id = l.company_id and m.user_id = l.by)) x
  from public.cs_edit_log l
  where l.company_id = p_company and (p_client is null or l.cs_client_id = p_client)
   and (sc->>'scope' = 'all' or (sc->'squads') ? (l.squad_id::text))
  order by l.at desc limit least(greatest(coalesce(p_limit, 100), 1), 500)) t), '[]');
end $$;

revoke all on function mavi_private.cs_log(uuid, text, text, uuid, date, uuid, jsonb, jsonb, text), mavi_private.cs_source(uuid),
 mavi_private.cs_can_write(uuid, uuid), mavi_private.cs_write_check(uuid, uuid), mavi_private.cs_pick(jsonb, text, text)
 from public, anon, authenticated;
revoke all on function public.cs_entry_access(uuid), public.set_cs_source(uuid, text, text),
 public.save_cs_cycle(uuid, uuid, date, jsonb), public.delete_cs_cycle(uuid, uuid, date, text),
 public.save_cs_hs(uuid, uuid, date, jsonb), public.save_cs_client(uuid, uuid, jsonb), public.delete_cs_client(uuid, uuid, text),
 public.save_cs_goal(uuid, uuid, date, numeric, numeric, numeric), public.cs_open_month(uuid, date, boolean),
 public.cs_edit_log_list(uuid, uuid, integer), public.cs_entry_month(uuid, date) from public, anon;
grant execute on function public.cs_entry_access(uuid), public.set_cs_source(uuid, text, text),
 public.save_cs_cycle(uuid, uuid, date, jsonb), public.delete_cs_cycle(uuid, uuid, date, text),
 public.save_cs_hs(uuid, uuid, date, jsonb), public.save_cs_client(uuid, uuid, jsonb), public.delete_cs_client(uuid, uuid, text),
 public.save_cs_goal(uuid, uuid, date, numeric, numeric, numeric), public.cs_open_month(uuid, date, boolean),
 public.cs_edit_log_list(uuid, uuid, integer), public.cs_entry_month(uuid, date) to authenticated;

notify pgrst, 'reload schema';

commit;
