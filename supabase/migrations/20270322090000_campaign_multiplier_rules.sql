-- Campanhas: regras do índice de performance (M).
--
-- 1. O mínimo passa a ser 1 (o máximo continua 100). Vale para o que é
--    alterado daqui para frente: ciclos e dias que já estão abaixo de 1
--    ficam como estão (a lista deles está em ad_multiplier_below_min) e só
--    podem ser alterados para 1 ou mais. Ciclo novo sempre começa com 1 ou
--    mais.
-- 2. Toda alteração do M pede um motivo: editar o ciclo, criar um ciclo com
--    M diferente do anterior e editar o M de um dia no Dia a Dia.
-- 3. Ao mudar o M do ciclo, quem altera escolhe a quais dias já
--    registrados o M novo se aplica: todos os dias do ciclo, só de hoje em
--    diante, ou um período. Os dias que ainda vão entrar usam sempre o M do
--    ciclo. O débito no Financeiro › Mídia acompanha (gatilho
--    media_campaign_spend).
-- 4. Tudo vai para um registro de auditoria para sempre e imutável
--    (mavi_private.ad_multiplier_log), além do histórico da campanha
--    (evento multiplier_changed; motivo no daily_edited). A lista geral é
--    de administradores e gestores.

-- ------------------------------------------------------------ registro
create table mavi_private.ad_multiplier_log (
 id bigint generated always as identity primary key,
 company_id uuid not null references public.companies(id) on delete cascade,
 at timestamptz not null default now(),
 actor uuid default auth.uid(),
 campaign_id uuid not null,
 cycle_id uuid not null,
 contract_id uuid,
 -- Os nomes na hora (o que for apagado continua legível).
 campaign_label text not null default '',
 client_label text not null default '',
 product_label text not null default '',
 platform text,
 cycle_start date,
 cycle_end date,
 -- cycle: editou o ciclo; new_cycle: criou um ciclo com M diferente do
 -- anterior; day: editou o M de um dia no Dia a Dia.
 kind text not null check (kind in ('cycle', 'new_cycle', 'day')),
 day date,
 old_value numeric(6,3),
 new_value numeric(6,3) not null,
 reason text not null,
 -- Só no kind cycle: a quais dias registrados o M novo se aplicou.
 apply text check (apply in ('all', 'forward', 'range')),
 apply_from date,
 apply_to date,
 -- Os dias registrados cujo M mudou: [{day, from}].
 days jsonb not null default '[]',
 -- Quanto o investimento com M desses dias mudou (= o ajuste no débito de
 -- mídia do Financeiro).
 media_diff numeric(14,2) not null default 0
);
create index ad_multiplier_log_company on mavi_private.ad_multiplier_log (company_id, id desc);
create index ad_multiplier_log_campaign on mavi_private.ad_multiplier_log (company_id, campaign_id, id desc);
alter table mavi_private.ad_multiplier_log enable row level security;
revoke all on mavi_private.ad_multiplier_log from public, anon, authenticated;

-- Ninguém altera nem apaga um registro (só a exclusão da empresa leva junto).
create function mavi_private.ad_multiplier_log_guard() returns trigger
language plpgsql set search_path = '' as $$ begin
 if tg_op = 'DELETE' then
  if not exists (select 1 from public.companies where id = old.company_id) then return old; end if;
 end if;
 raise exception 'O registro de alterações do M não pode ser alterado nem apagado.' using errcode = '42501';
end $$;
create trigger ad_multiplier_log_guard before update or delete on mavi_private.ad_multiplier_log
 for each row execute function mavi_private.ad_multiplier_log_guard();
create trigger ad_multiplier_log_no_truncate before truncate on mavi_private.ad_multiplier_log
 for each statement execute function mavi_private.ad_multiplier_log_guard();

-- ------------------------------------------------------------ ajudantes
-- O M alterado: no mínimo 1 e no máximo 100.
create function mavi_private.ad_multiplier_check(p_m numeric) returns void
language plpgsql immutable set search_path = '' as $$ begin
 if p_m is null or p_m < 1 or p_m > 100 then
  raise exception 'O índice de performance (M) precisa ser no mínimo 1 e no máximo 100' using errcode = '22023';
 end if;
end $$;
revoke all on function mavi_private.ad_multiplier_check(numeric) from public, anon, authenticated;

-- O motivo de uma alteração do M: obrigatório, até 1000 caracteres.
create function mavi_private.ad_multiplier_reason(p_reason text) returns text
language plpgsql immutable set search_path = '' as $$
declare v text := trim(coalesce(p_reason, '')); begin
 if v = '' then
  raise exception 'Informe o motivo da alteração do índice de performance (M)' using errcode = '22023';
 end if;
 if length(v) > 1000 then
  raise exception 'O motivo da alteração do M pode ter até 1000 caracteres' using errcode = '22023';
 end if;
 return v;
end $$;
revoke all on function mavi_private.ad_multiplier_reason(text) from public, anon, authenticated;

-- Os dias registrados do ciclo que uma escolha alcança: todos, de hoje em
-- diante (no fuso da empresa) ou o período.
create function mavi_private.ad_multiplier_in(p_day date, p_apply text, p_today date, p_from date, p_to date)
returns boolean language sql immutable set search_path = '' as $$
 select case p_apply when 'all' then true when 'forward' then p_day >= p_today
  when 'range' then p_day between p_from and p_to else false end
$$;
revoke all on function mavi_private.ad_multiplier_in(date, text, date, date, date) from public, anon, authenticated;

create function mavi_private.ad_multiplier_record(y public.ad_cycles, p_kind text, p_day date, p_old numeric,
 p_new numeric, p_reason text, p_apply text default null, p_from date default null, p_to date default null,
 p_days jsonb default '[]', p_diff numeric default 0) returns void
language plpgsql security definer set search_path = '' as $$
declare a public.ad_campaigns; v_client text; v_product text; begin
 select * into a from public.ad_campaigns where id = y.campaign_id;
 select cl.name, p.name into v_client, v_product from public.contracts k
  left join public.clients cl on cl.company_id = k.company_id and cl.id = k.client_id
  left join public.products p on p.company_id = k.company_id and p.id = k.product_id
 where k.company_id = a.company_id and k.id = a.contract_id;
 insert into mavi_private.ad_multiplier_log(company_id, campaign_id, cycle_id, contract_id, campaign_label,
  client_label, product_label, platform, cycle_start, cycle_end, kind, day, old_value, new_value, reason, apply,
  apply_from, apply_to, days, media_diff)
 values (y.company_id, y.campaign_id, y.id, a.contract_id, coalesce(a.name, ''), coalesce(v_client, ''),
  coalesce(v_product, ''), a.platform, y.start_date, y.end_date, p_kind, p_day, p_old, p_new, p_reason, p_apply,
  case when p_apply = 'range' then p_from end, case when p_apply = 'range' then p_to end,
  coalesce(p_days, '[]'), coalesce(p_diff, 0));
end $$;
revoke all on function mavi_private.ad_multiplier_record(public.ad_cycles, text, date, numeric, numeric, text, text,
 date, date, jsonb, numeric) from public, anon, authenticated;

-- ------------------------------------------------------------ prévia
-- O que cada escolha muda nos dias já registrados do ciclo, antes de
-- salvar: quantos dias, quantos foram editados à mão e quanto o
-- investimento com M (o débito de mídia) muda. p_from/p_to: o período.
create function public.ad_multiplier_impact(p_cycle uuid, p_multiplier numeric, p_from date default null,
 p_to date default null) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare y public.ad_cycles; v_today date; v_m numeric := round(p_multiplier, 3); begin
 select * into y from public.ad_cycles where id = p_cycle;
 if not found or not (mavi_private.ad_can_write(y.company_id) and mavi_private.module_client(y.company_id,
  'campaigns', mavi_private.ad_campaign_client(y.campaign_id))) then
  raise exception 'Sem permissão' using errcode = '42501';
 end if;
 v_today := mavi_private.company_today(y.company_id);
 return jsonb_build_object('today', v_today,
  'registered', (select count(*) from public.ad_daily_metrics d where d.cycle_id = y.id),
  'first_day', (select min(d.day) from public.ad_daily_metrics d where d.cycle_id = y.id),
  'last_day', (select max(d.day) from public.ad_daily_metrics d where d.cycle_id = y.id),
  'options', (select jsonb_object_agg(s.apply, jsonb_build_object('days', s.days, 'manual', s.manual,
    'diff', s.diff))
   from (select o.apply, count(d.id) as days, count(d.id) filter (where d.source = 'manual') as manual,
     coalesce(sum(round(d.spend * v_m, 2) - round(d.spend * d.multiplier, 2)), 0) as diff
    from unnest(case when p_from is not null and p_to is not null and p_from <= p_to
      then array['all', 'forward', 'range'] else array['all', 'forward'] end) o(apply)
    left join public.ad_daily_metrics d on d.cycle_id = y.id and d.multiplier <> v_m
     and mavi_private.ad_multiplier_in(d.day, o.apply, v_today, p_from, p_to)
    group by o.apply) s));
end $$;
revoke all on function public.ad_multiplier_impact(uuid, numeric, date, date) from public, anon;
grant execute on function public.ad_multiplier_impact(uuid, numeric, date, date) to authenticated;

-- ------------------------------------------------------------ ciclos
-- As da migração 20270301090000_campaign_shared_day, com as regras do M:
-- p_multiplier_reason (o motivo) e, na edição, p_multiplier_apply ('all',
-- 'forward' ou 'range') com o período p_multiplier_from/p_multiplier_to.
drop function public.create_ad_cycle(uuid, date, date, date, text, integer, numeric, numeric, text, text[], text,
 jsonb, boolean, text, text, text);
drop function public.update_ad_cycle(uuid, integer, date, date, date, text, integer, numeric, numeric, text, text[],
 text, jsonb, text, text, text);

create function public.create_ad_cycle(p_campaign uuid, p_competence date, p_start date, p_end date,
 p_objective text, p_goal_results integer, p_budget numeric, p_multiplier numeric default null,
 p_destination text default 'external_page', p_landing_pages text[] default '{}', p_niche text default '',
 p_links jsonb default '[]', p_make_current boolean default false, p_media_override text default null,
 p_shared_start text default null, p_shared_end text default null, p_multiplier_reason text default null)
 returns uuid
language plpgsql security definer set search_path = '' as $$
declare a public.ad_campaigns; result uuid; prev public.ad_cycles; m numeric; links jsonb; release jsonb;
 v_next uuid; v_reason text; y public.ad_cycles; begin
 select * into a from public.ad_campaigns where id = p_campaign for update;
 if not found or not (mavi_private.ad_can_write(a.company_id) and mavi_private.module_client(a.company_id, 'campaigns',
  (select k.client_id from public.contracts k where k.company_id = a.company_id and k.id = a.contract_id))) then
  raise exception 'Sem permissão' using errcode = '42501';
 end if;
 if a.archived then raise exception 'Campanha arquivada' using errcode = '22023'; end if;
 perform mavi_private.ad_cycle_checks(a.company_id, a.id, null, p_start, p_end, p_objective, p_goal_results,
  p_budget, p_destination, p_landing_pages);
 select * into prev from public.ad_cycles where campaign_id = a.id
  order by start_date desc, created_at desc limit 1;
 m := round(coalesce(p_multiplier, prev.multiplier, 1), 3);
 -- Ciclo novo: sempre 1 ou mais; diferente do anterior, com motivo.
 perform mavi_private.ad_multiplier_check(m);
 if prev.id is not null and m <> prev.multiplier then
  v_reason := mavi_private.ad_multiplier_reason(p_multiplier_reason);
 end if;
 release := mavi_private.media_cycle_guard(a, null, p_end, p_budget, p_media_override);
 insert into public.ad_cycles(company_id, campaign_id, competence_month, start_date, end_date, objective,
  goal_results, budget, multiplier, destination, landing_pages, niche, conversion_actions)
 values (a.company_id, a.id, date_trunc('month', coalesce(p_competence, p_start))::date, p_start, p_end,
  p_objective, p_goal_results, round(p_budget, 2), m, p_destination,
  case when p_destination = 'make_landing_page' then coalesce(p_landing_pages, '{}') else '{}' end,
  trim(coalesce(p_niche, '')),
  -- Google: as conversões que contam vêm do ciclo anterior.
  case when a.platform = 'google' then prev.conversion_actions end)
 returning * into y;
 result := y.id;
 links := mavi_private.ad_set_links(a.company_id, result, p_links);
 perform mavi_private.ad_log(a.company_id, a.id, result, 'cycle_created', jsonb_build_object(
  'start_date', p_start, 'end_date', p_end, 'objective', p_objective, 'goal_results', p_goal_results,
  'budget', round(p_budget, 2), 'multiplier', m, 'links', links));
 if v_reason is not null then
  perform mavi_private.ad_log(a.company_id, a.id, result, 'multiplier_changed', jsonb_build_object(
   'kind', 'new_cycle', 'from', prev.multiplier, 'to', m, 'reason', v_reason, 'days', 0, 'media_diff', 0));
  perform mavi_private.ad_multiplier_record(y, 'new_cycle', null, prev.multiplier, m, v_reason);
 end if;
 perform mavi_private.ad_set_shared_day(a.company_id, a.id, result, p_shared_start, true);
 select x.id into v_next from public.ad_cycles x where x.company_id = a.company_id and x.campaign_id = a.id
  and x.id <> result and x.start_date = p_end and x.end_date > p_end;
 if v_next is not null then
  perform mavi_private.ad_set_shared_day(a.company_id, a.id, v_next, p_shared_end, true);
 end if;
 if release is not null then
  perform mavi_private.ad_log(a.company_id, a.id, result, 'media_override', release);
 end if;
 if p_make_current then
  update public.ad_campaigns set current_cycle_id = result, updated_at = now(), version = version + 1 where id = a.id;
  perform mavi_private.ad_log(a.company_id, a.id, result, 'current_cycle',
   jsonb_build_object('from', a.current_cycle_id, 'to', result));
 end if;
 return result;
end $$;

create function public.update_ad_cycle(p_cycle uuid, p_version integer, p_competence date, p_start date, p_end date,
 p_objective text, p_goal_results integer, p_budget numeric, p_multiplier numeric default null,
 p_destination text default 'external_page', p_landing_pages text[] default '{}', p_niche text default '',
 p_links jsonb default '[]', p_media_override text default null,
 p_shared_start text default null, p_shared_end text default null, p_multiplier_reason text default null,
 p_multiplier_apply text default null, p_multiplier_from date default null, p_multiplier_to date default null)
 returns void
language plpgsql security definer set search_path = '' as $$
declare y public.ad_cycles; z public.ad_cycles; a public.ad_campaigns; before_links jsonb; links jsonb;
 changes jsonb; release jsonb; v_next uuid; v_m numeric; v_reason text; v_apply text; v_today date;
 v_days jsonb := '[]'; v_diff numeric := 0; begin
 select * into y from public.ad_cycles where id = p_cycle for update;
 if found then select * into a from public.ad_campaigns where id = y.campaign_id; end if;
 if not found or not (mavi_private.ad_can_write(a.company_id) and mavi_private.module_client(a.company_id, 'campaigns',
  (select k.client_id from public.contracts k where k.company_id = a.company_id and k.id = a.contract_id))) then
  raise exception 'Sem permissão' using errcode = '42501';
 end if;
 if y.version <> p_version then
  raise exception 'O ciclo foi alterado por outra pessoa. Recarregue e tente de novo.' using errcode = '40001';
 end if;
 perform mavi_private.ad_cycle_checks(a.company_id, a.id, y.id, p_start, p_end, p_objective, p_goal_results,
  p_budget, p_destination, p_landing_pages);
 -- O M: sem alteração, fica como está (mesmo abaixo de 1, de antes da
 -- regra); alterado, 1 ou mais, com motivo e a escolha dos dias.
 v_m := round(coalesce(p_multiplier, y.multiplier), 3);
 if v_m <> y.multiplier then
  perform mavi_private.ad_multiplier_check(v_m);
  v_reason := mavi_private.ad_multiplier_reason(p_multiplier_reason);
  v_apply := p_multiplier_apply;
  if v_apply is null and not exists (select 1 from public.ad_daily_metrics d where d.cycle_id = y.id) then
   v_apply := 'all';
  end if;
  if v_apply is null or v_apply not in ('all', 'forward', 'range') then
   raise exception 'Escolha a quais dias já registrados o novo M se aplica' using errcode = '22023';
  end if;
  if v_apply = 'range' and (p_multiplier_from is null or p_multiplier_to is null
   or p_multiplier_from > p_multiplier_to or p_multiplier_from < p_start or p_multiplier_to > p_end) then
   raise exception 'Informe um período dentro do ciclo para aplicar o novo M' using errcode = '22023';
  end if;
 end if;
 release := mavi_private.media_cycle_guard(a, y.id, p_end, p_budget, p_media_override);
 select coalesce(jsonb_agg(jsonb_build_object('account_id', account_id, 'campaign_id', external_campaign_id)
  order by account_id, external_campaign_id), '[]') into before_links from public.ad_cycle_links where cycle_id = y.id;
 update public.ad_cycles set competence_month = date_trunc('month', coalesce(p_competence, p_start))::date,
  start_date = p_start, end_date = p_end, objective = p_objective, goal_results = p_goal_results,
  budget = round(p_budget, 2), multiplier = v_m,
  destination = p_destination,
  landing_pages = case when p_destination = 'make_landing_page' then coalesce(p_landing_pages, '{}') else '{}' end,
  niche = trim(coalesce(p_niche, '')),
  -- Outro início: outro dia de virada, outra escolha.
  shared_day = case when p_start = start_date then shared_day end,
  updated_at = now(), version = version + 1
 where id = y.id returning * into z;
 links := mavi_private.ad_set_links(a.company_id, y.id, p_links);
 -- O M tem o próprio evento (multiplier_changed), com o motivo.
 changes := mavi_private.ad_changes(to_jsonb(y), to_jsonb(z), array['competence_month','start_date','end_date',
  'objective','goal_results','budget','destination','landing_pages','niche']);
 if before_links is distinct from links then
  changes := changes || jsonb_build_object('links', jsonb_build_object('from', before_links, 'to', links));
 end if;
 if changes <> '{}' then
  perform mavi_private.ad_log(a.company_id, a.id, y.id, 'cycle_updated', changes);
 end if;
 if v_reason is not null then
  -- Os dias registrados escolhidos passam ao M novo; o gatilho do
  -- Financeiro › Mídia acerta o débito de cada um.
  v_today := mavi_private.company_today(a.company_id);
  select coalesce(jsonb_agg(jsonb_build_object('day', d.day, 'from', d.multiplier) order by d.day), '[]'),
   coalesce(sum(round(d.spend * v_m, 2) - round(d.spend * d.multiplier, 2)), 0)
  into v_days, v_diff from public.ad_daily_metrics d
  where d.cycle_id = y.id and d.multiplier <> v_m
   and mavi_private.ad_multiplier_in(d.day, v_apply, v_today, p_multiplier_from, p_multiplier_to);
  update public.ad_daily_metrics d set multiplier = v_m
  where d.cycle_id = y.id and d.multiplier <> v_m
   and mavi_private.ad_multiplier_in(d.day, v_apply, v_today, p_multiplier_from, p_multiplier_to);
  perform mavi_private.ad_log(a.company_id, a.id, y.id, 'multiplier_changed', jsonb_build_object(
   'kind', 'cycle', 'from', y.multiplier, 'to', v_m, 'reason', v_reason, 'apply', v_apply,
   'since', case when v_apply = 'forward' then v_today end,
   'apply_from', case when v_apply = 'range' then p_multiplier_from end,
   'apply_to', case when v_apply = 'range' then p_multiplier_to end,
   'days', jsonb_array_length(v_days), 'media_diff', v_diff));
  perform mavi_private.ad_multiplier_record(z, 'cycle', null, y.multiplier, v_m, v_reason, v_apply,
   p_multiplier_from, p_multiplier_to, v_days, v_diff);
 end if;
 -- O dia de virada: a escolha só é pedida quando a data dividida mudou.
 perform mavi_private.ad_clear_shared_days(a.company_id, a.id);
 perform mavi_private.ad_set_shared_day(a.company_id, a.id, y.id, p_shared_start, p_start <> y.start_date);
 select x.id into v_next from public.ad_cycles x where x.company_id = a.company_id and x.campaign_id = a.id
  and x.id <> y.id and x.start_date = p_end and x.end_date > p_end;
 if v_next is not null then
  perform mavi_private.ad_set_shared_day(a.company_id, a.id, v_next, p_shared_end, p_end <> y.end_date);
 end if;
 if release is not null then
  perform mavi_private.ad_log(a.company_id, a.id, y.id, 'media_override', release);
 end if;
end $$;

revoke all on function public.create_ad_cycle(uuid, date, date, date, text, integer, numeric, numeric, text, text[],
 text, jsonb, boolean, text, text, text, text), public.update_ad_cycle(uuid, integer, date, date, date, text, integer,
 numeric, numeric, text, text[], text, jsonb, text, text, text, text, text, date, date) from public, anon;
grant execute on function public.create_ad_cycle(uuid, date, date, date, text, integer, numeric, numeric, text, text[],
 text, jsonb, boolean, text, text, text, text), public.update_ad_cycle(uuid, integer, date, date, date, text, integer,
 numeric, numeric, text, text[], text, jsonb, text, text, text, text, text, date, date) to authenticated;

-- ------------------------------------------------------------ dia a dia
-- A da migração 20270107090000_member_opt_in_full, com p_reason: o M do
-- dia alterado precisa ser 1 ou mais e ter motivo.
drop function public.update_ad_daily_metric(uuid, date, jsonb);
create function public.update_ad_daily_metric(p_cycle uuid, p_day date, p_values jsonb, p_reason text default null)
 returns void
language plpgsql security definer set search_path = '' as $$
declare r public.ad_daily_metrics; y public.ad_cycles; m jsonb; v_m numeric; changes jsonb; v_reason text;
 detail jsonb; begin
 select * into r from public.ad_daily_metrics where cycle_id = p_cycle and day = p_day;
 if not found or not (mavi_private.ad_can_write(r.company_id) and mavi_private.module_client(r.company_id, 'campaigns',
  mavi_private.ad_campaign_client(r.campaign_id))) then
  raise exception 'Sem permissão' using errcode = '42501';
 end if;
 if jsonb_typeof(coalesce(p_values, 'null')) <> 'object' then
  raise exception 'Valores inválidos' using errcode = '22023';
 end if;
 m := mavi_private.ad_edit_metrics(p_values, to_jsonb(r));
 v_m := mavi_private.ad_edit_number(p_values, 'multiplier', r.multiplier);
 if v_m is null or v_m <= 0 or v_m > 100 then
  raise exception 'O índice de performance (M) precisa ser no mínimo 1 e no máximo 100' using errcode = '22023';
 end if;
 v_m := round(v_m, 3);
 if v_m <> r.multiplier then
  perform mavi_private.ad_multiplier_check(v_m);
  v_reason := mavi_private.ad_multiplier_reason(p_reason);
 end if;
 changes := mavi_private.ad_changes(to_jsonb(r), m || jsonb_build_object('multiplier', v_m),
  array['multiplier','spend','impressions','reach','clicks','conversions','view_content','add_to_cart',
   'initiate_checkout']);
 if changes = '{}' then return; end if;
 update public.ad_daily_metrics set multiplier = v_m, spend = (m ->> 'spend')::numeric,
  impressions = (m ->> 'impressions')::bigint, reach = (m ->> 'reach')::bigint, clicks = (m ->> 'clicks')::bigint,
  conversions = (m ->> 'conversions')::numeric, view_content = (m ->> 'view_content')::numeric,
  add_to_cart = (m ->> 'add_to_cart')::numeric, initiate_checkout = (m ->> 'initiate_checkout')::numeric,
  source = 'manual', synced_at = now()
 where id = r.id;
 detail := jsonb_build_object('day', r.day, 'changes', changes);
 if v_reason is not null then
  detail := detail || jsonb_build_object('reason', v_reason);
  select * into y from public.ad_cycles where id = r.cycle_id;
  perform mavi_private.ad_multiplier_record(y, 'day', r.day, r.multiplier, v_m, v_reason, null, null, null,
   jsonb_build_array(jsonb_build_object('day', r.day, 'from', r.multiplier)),
   round((m ->> 'spend')::numeric * v_m, 2) - round(r.spend * r.multiplier, 2));
 end if;
 perform mavi_private.ad_log(r.company_id, r.campaign_id, r.cycle_id, 'daily_edited', detail);
end $$;
revoke all on function public.update_ad_daily_metric(uuid, date, jsonb, text) from public, anon;
grant execute on function public.update_ad_daily_metric(uuid, date, jsonb, text) to authenticated;

-- ------------------------------------------------------------ leitura
-- Todas as alterações do M da empresa, da mais recente à mais antiga, para
-- administradores e gestores. Filtros no banco: campanha, quem alterou,
-- período (datas no fuso da empresa) e busca por campanha, cliente ou
-- produto. p_before: o id do último já carregado.
create function public.ad_multiplier_log(p_company uuid, p_campaign uuid default null, p_actor uuid default null,
 p_from date default null, p_to date default null, p_search text default '', p_before bigint default null,
 p_limit integer default 30) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_tz text; v_limit integer := least(greatest(coalesce(p_limit, 30), 1), 100);
 v_search text := nullif(trim(coalesce(p_search, '')), ''); v_items jsonb; begin
 if not mavi_private.leader(p_company) then
  raise exception 'Só administradores e gestores veem as alterações do M.' using errcode = '42501';
 end if;
 select coalesce(c.timezone, 'America/Sao_Paulo') into v_tz from public.companies c where c.id = p_company;
 select coalesce(jsonb_agg(x.item order by x.id desc), '[]') into v_items from (
  select l.id, jsonb_build_object('id', l.id, 'at', l.at, 'actor', l.actor,
   'actor_name', coalesce((select mm.name from public.memberships mm where mm.company_id = l.company_id
    and mm.user_id = l.actor), ''),
   'campaign_id', l.campaign_id, 'cycle_id', l.cycle_id, 'campaign', l.campaign_label, 'client', l.client_label,
   'product', l.product_label, 'platform', l.platform, 'cycle_start', l.cycle_start, 'cycle_end', l.cycle_end,
   'kind', l.kind, 'day', l.day, 'from', l.old_value, 'to', l.new_value, 'reason', l.reason, 'apply', l.apply,
   'apply_from', l.apply_from, 'apply_to', l.apply_to, 'days', l.days, 'media_diff', l.media_diff) as item
  from mavi_private.ad_multiplier_log l
  where l.company_id = p_company
   and (p_campaign is null or l.campaign_id = p_campaign)
   and (p_actor is null or l.actor = p_actor)
   and (p_from is null or (l.at at time zone v_tz)::date >= p_from)
   and (p_to is null or (l.at at time zone v_tz)::date <= p_to)
   and (v_search is null or l.campaign_label ilike '%' || v_search || '%' or l.client_label ilike '%' || v_search || '%'
    or l.product_label ilike '%' || v_search || '%')
   and (p_before is null or l.id < p_before)
  order by l.id desc limit v_limit + 1) x;
 return jsonb_build_object(
  'items', (select coalesce(jsonb_agg(e order by (e ->> 'id')::bigint desc), '[]')
   from (select e from jsonb_array_elements(v_items) e limit v_limit) s),
  'more', jsonb_array_length(v_items) > v_limit);
end $$;
revoke all on function public.ad_multiplier_log(uuid, uuid, uuid, date, date, text, bigint, integer) from public, anon;
grant execute on function public.ad_multiplier_log(uuid, uuid, uuid, date, date, text, bigint, integer) to authenticated;

-- Os ciclos com M abaixo de 1, no ciclo ou em algum dia registrado (de
-- antes da regra): ficam como estão, listados para revisão.
create function public.ad_multiplier_below_min(p_company uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$ begin
 if not mavi_private.leader(p_company) then
  raise exception 'Só administradores e gestores veem as alterações do M.' using errcode = '42501';
 end if;
 return (select coalesce(jsonb_agg(jsonb_build_object('campaign_id', a.id, 'campaign', a.name,
   'client', coalesce(cl.name, ''), 'product', coalesce(p.name, ''), 'platform', a.platform,
   'archived', a.archived, 'cycle_id', y.id, 'start_date', y.start_date, 'end_date', y.end_date,
   'multiplier', y.multiplier, 'days_below', b.n, 'lowest_day', b.lowest)
   order by y.multiplier >= 1, y.start_date desc, a.name), '[]')
  from public.ad_cycles y
  join public.ad_campaigns a on a.company_id = y.company_id and a.id = y.campaign_id
  left join public.contracts k on k.company_id = a.company_id and k.id = a.contract_id
  left join public.clients cl on cl.company_id = k.company_id and cl.id = k.client_id
  left join public.products p on p.company_id = k.company_id and p.id = k.product_id
  cross join lateral (select count(*) as n, min(d.multiplier) as lowest from public.ad_daily_metrics d
   where d.cycle_id = y.id and d.multiplier < 1) b
  where y.company_id = p_company and (y.multiplier < 1 or b.n > 0));
end $$;
revoke all on function public.ad_multiplier_below_min(uuid) from public, anon;
grant execute on function public.ad_multiplier_below_min(uuid) to authenticated;
