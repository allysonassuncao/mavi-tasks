begin;

-- Campanhas: o dia de virada. Um ciclo pode começar no mesmo dia em que o
-- anterior termina (o ciclo de 31/08 a 30/09 e o novo de 30/09 a 29/10):
-- só esse dia pode ser dividido; sobreposição maior continua bloqueada, e
-- cada ciclo precisa de ao menos um dia só dele.
--
-- No dia dividido, uma campanha da plataforma que está nos dois ciclos
-- contaria o gasto e os resultados duas vezes (e o débito no saldo de mídia
-- também). Quem cadastra escolhe, e a escolha fica no ciclo que começa
-- nesse dia (shared_day) e no histórico:
--  - 'later' (recomendado): o dia conta no ciclo novo; o anterior deixa de
--    contar, nesse dia, as campanhas (e páginas da Make) que estão nos dois;
--  - 'earlier': o dia conta no ciclo que termina; o novo deixa de contar,
--    nesse dia, o que está nos dois;
--  - 'both': cada ciclo mostra o dia inteiro (conta duas vezes).
-- Sem escolha (null): os ciclos importados do MASO que já dividiam o dia —
-- contam nos dois, como antes.
--
-- Um ciclo novo do Google herda as conversões que contam do ciclo anterior
-- (os vínculos, o destino e o M já vinham dele, pela tela).

alter table public.ad_cycles add column shared_day text
 check (shared_day in ('later', 'earlier', 'both'));

-- ------------------------------------------------------------ conflito
-- A da migração 20261118090000, com o dia de virada.
create or replace function mavi_private.ad_cycle_checks(c uuid, p_campaign uuid, p_cycle uuid, p_start date, p_end date,
 p_objective text, p_goal integer, p_budget numeric, p_destination text, p_landing_pages text[]) returns void
language plpgsql stable security definer set search_path = '' as $$
declare other public.ad_cycles; begin
 if p_start is null or p_end is null or p_end < p_start then
  raise exception 'O término precisa ser igual ou posterior ao início' using errcode = '22023';
 end if;
 if p_end - p_start >= 366 then
  raise exception 'Um ciclo não pode passar de um ano' using errcode = '22023';
 end if;
 if p_objective is null or p_objective not in ('lead','sale','message','traffic','engagement','custom','video') then
  raise exception 'Objetivo inválido' using errcode = '22023';
 end if;
 if p_goal is null or p_goal < 0 then
  raise exception 'Informe a quantidade de resultados esperada' using errcode = '22023';
 end if;
 if p_budget is null or p_budget < 0 then
  raise exception 'Informe a verba do ciclo' using errcode = '22023';
 end if;
 if p_destination is null or p_destination not in ('lead_form','external_page','make_landing_page') then
  raise exception 'Destino inválido' using errcode = '22023';
 end if;
 if p_destination = 'make_landing_page' and coalesce(cardinality(p_landing_pages), 0) = 0 then
  raise exception 'Informe ao menos uma página de captura da Make' using errcode = '22023';
 end if;
 if p_cycle is not null and exists (select 1 from public.ad_cycles where company_id = c and id = p_cycle
  and start_date = p_start and end_date = p_end) then
  return;
 end if;
 select * into other from public.ad_cycles y where y.company_id = c and y.campaign_id = p_campaign
  and y.id is distinct from p_cycle and y.start_date <= p_end and y.end_date >= p_start
  -- O dia de virada: um termina no dia em que o outro começa, e cada um
  -- tem ao menos um dia só dele.
  and not (y.end_date = p_start and y.start_date < p_start and p_end > p_start)
  and not (y.start_date = p_end and y.end_date > p_end and p_start < p_end)
 order by y.start_date limit 1;
 if found then
  raise exception 'O período conflita com o ciclo de % a % desta campanha. Só o dia de virada pode ser dividido: o ciclo pode começar no dia em que o outro termina',
   to_char(other.start_date, 'DD/MM/YYYY'), to_char(other.end_date, 'DD/MM/YYYY') using errcode = '23P01';
 end if;
end $$;
revoke all on function mavi_private.ad_cycle_checks(uuid, uuid, uuid, date, date, text, integer, numeric, text, text[])
 from public, anon, authenticated;

-- ------------------------------------------------------------ a escolha
-- Grava onde conta o dia que `p_later` divide com o ciclo que termina no
-- início dele, e registra no histórico. p_choice null mantém a escolha
-- gravada; sem nenhuma, pede (p_required) ou deixa sem (os importados).
create function mavi_private.ad_set_shared_day(c uuid, p_campaign uuid, p_later uuid, p_choice text,
 p_required boolean) returns void
language plpgsql security definer set search_path = '' as $$
declare z public.ad_cycles; e public.ad_cycles; begin
 select * into z from public.ad_cycles where company_id = c and id = p_later;
 select * into e from public.ad_cycles y where y.company_id = c and y.campaign_id = p_campaign and y.id <> z.id
  and y.end_date = z.start_date and y.start_date < z.start_date
 order by y.start_date desc limit 1;
 if not found then return; end if;
 if p_choice is not null and p_choice not in ('later', 'earlier', 'both') then
  raise exception 'Escolha inválida para o dia de virada' using errcode = '22023';
 end if;
 if p_choice is null and z.shared_day is null and p_required then
  raise exception 'Escolha em qual ciclo conta o dia de virada (%)', to_char(z.start_date, 'DD/MM/YYYY')
   using errcode = '22023';
 end if;
 if p_choice is null or p_choice is not distinct from z.shared_day then return; end if;
 update public.ad_cycles set shared_day = p_choice, updated_at = now(), version = version + 1 where id = z.id;
 perform mavi_private.ad_log(c, p_campaign, z.id, 'shared_day', jsonb_build_object(
  'day', z.start_date, 'from', z.shared_day, 'to', p_choice,
  'earlier', jsonb_build_object('id', e.id, 'start_date', e.start_date, 'end_date', e.end_date),
  'later', jsonb_build_object('id', z.id, 'start_date', z.start_date, 'end_date', z.end_date)));
end $$;
revoke all on function mavi_private.ad_set_shared_day(uuid, uuid, uuid, text, boolean) from public, anon, authenticated;

-- Os ciclos que deixaram de dividir o dia (o período mudou) perdem a escolha.
create function mavi_private.ad_clear_shared_days(c uuid, p_campaign uuid) returns void
language sql security definer set search_path = '' as $$
 update public.ad_cycles z set shared_day = null, updated_at = now(), version = version + 1
 where z.company_id = c and z.campaign_id = p_campaign and z.shared_day is not null
  and not exists (select 1 from public.ad_cycles y where y.company_id = z.company_id
   and y.campaign_id = z.campaign_id and y.id <> z.id and y.end_date = z.start_date and y.start_date < z.start_date)
$$;
revoke all on function mavi_private.ad_clear_shared_days(uuid, uuid) from public, anon, authenticated;

-- ------------------------------------------------------------ ciclos
-- As da migração 20270222090000_campaign_media_room, com a escolha do dia de
-- virada: p_shared_start (o dia que este ciclo divide com o anterior) e
-- p_shared_end (o que divide com o seguinte, gravado no seguinte).
drop function public.create_ad_cycle(uuid, date, date, date, text, integer, numeric, numeric, text, text[], text,
 jsonb, boolean, text);
drop function public.update_ad_cycle(uuid, integer, date, date, date, text, integer, numeric, numeric, text, text[],
 text, jsonb, text);

create function public.create_ad_cycle(p_campaign uuid, p_competence date, p_start date, p_end date,
 p_objective text, p_goal_results integer, p_budget numeric, p_multiplier numeric default null,
 p_destination text default 'external_page', p_landing_pages text[] default '{}', p_niche text default '',
 p_links jsonb default '[]', p_make_current boolean default false, p_media_override text default null,
 p_shared_start text default null, p_shared_end text default null) returns uuid
language plpgsql security definer set search_path = '' as $$
declare a public.ad_campaigns; result uuid; prev public.ad_cycles; m numeric; links jsonb; release jsonb;
 v_next uuid; begin
 select * into a from public.ad_campaigns where id = p_campaign for update;
 if not found or not (mavi_private.ad_can_write(a.company_id) and mavi_private.module_client(a.company_id, 'campaigns',
  (select k.client_id from public.contracts k where k.company_id = a.company_id and k.id = a.contract_id))) then
  raise exception 'Sem permissão' using errcode = '42501';
 end if;
 if a.archived then raise exception 'Campanha arquivada' using errcode = '22023'; end if;
 perform mavi_private.ad_cycle_checks(a.company_id, a.id, null, p_start, p_end, p_objective, p_goal_results,
  p_budget, p_destination, p_landing_pages);
 release := mavi_private.media_cycle_guard(a, null, p_end, p_budget, p_media_override);
 select * into prev from public.ad_cycles where campaign_id = a.id
  order by start_date desc, created_at desc limit 1;
 m := coalesce(p_multiplier, prev.multiplier, 1);
 insert into public.ad_cycles(company_id, campaign_id, competence_month, start_date, end_date, objective,
  goal_results, budget, multiplier, destination, landing_pages, niche, conversion_actions)
 values (a.company_id, a.id, date_trunc('month', coalesce(p_competence, p_start))::date, p_start, p_end,
  p_objective, p_goal_results, round(p_budget, 2), m, p_destination,
  case when p_destination = 'make_landing_page' then coalesce(p_landing_pages, '{}') else '{}' end,
  trim(coalesce(p_niche, '')),
  -- Google: as conversões que contam vêm do ciclo anterior.
  case when a.platform = 'google' then prev.conversion_actions end)
 returning id into result;
 links := mavi_private.ad_set_links(a.company_id, result, p_links);
 perform mavi_private.ad_log(a.company_id, a.id, result, 'cycle_created', jsonb_build_object(
  'start_date', p_start, 'end_date', p_end, 'objective', p_objective, 'goal_results', p_goal_results,
  'budget', round(p_budget, 2), 'multiplier', m, 'links', links));
 perform mavi_private.ad_set_shared_day(a.company_id, a.id, result, p_shared_start, true);
 select y.id into v_next from public.ad_cycles y where y.company_id = a.company_id and y.campaign_id = a.id
  and y.id <> result and y.start_date = p_end and y.end_date > p_end;
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
 p_shared_start text default null, p_shared_end text default null) returns void
language plpgsql security definer set search_path = '' as $$
declare y public.ad_cycles; z public.ad_cycles; a public.ad_campaigns; before_links jsonb; links jsonb;
 changes jsonb; release jsonb; v_next uuid; begin
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
 release := mavi_private.media_cycle_guard(a, y.id, p_end, p_budget, p_media_override);
 select coalesce(jsonb_agg(jsonb_build_object('account_id', account_id, 'campaign_id', external_campaign_id)
  order by account_id, external_campaign_id), '[]') into before_links from public.ad_cycle_links where cycle_id = y.id;
 update public.ad_cycles set competence_month = date_trunc('month', coalesce(p_competence, p_start))::date,
  start_date = p_start, end_date = p_end, objective = p_objective, goal_results = p_goal_results,
  budget = round(p_budget, 2), multiplier = coalesce(p_multiplier, multiplier),
  destination = p_destination,
  landing_pages = case when p_destination = 'make_landing_page' then coalesce(p_landing_pages, '{}') else '{}' end,
  niche = trim(coalesce(p_niche, '')),
  -- Outro início: outro dia de virada, outra escolha.
  shared_day = case when p_start = start_date then shared_day end,
  updated_at = now(), version = version + 1
 where id = y.id returning * into z;
 links := mavi_private.ad_set_links(a.company_id, y.id, p_links);
 changes := mavi_private.ad_changes(to_jsonb(y), to_jsonb(z), array['competence_month','start_date','end_date',
  'objective','goal_results','budget','multiplier','destination','landing_pages','niche']);
 if before_links is distinct from links then
  changes := changes || jsonb_build_object('links', jsonb_build_object('from', before_links, 'to', links));
 end if;
 if changes <> '{}' then
  perform mavi_private.ad_log(a.company_id, a.id, y.id, 'cycle_updated', changes);
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
 text, jsonb, boolean, text, text, text), public.update_ad_cycle(uuid, integer, date, date, date, text, integer,
 numeric, numeric, text, text[], text, jsonb, text, text, text) from public, anon;
grant execute on function public.create_ad_cycle(uuid, date, date, date, text, integer, numeric, numeric, text, text[],
 text, jsonb, boolean, text, text, text), public.update_ad_cycle(uuid, integer, date, date, date, text, integer,
 numeric, numeric, text, text[], text, jsonb, text, text, text) to authenticated;

-- ------------------------------------------------------------ sincronização
-- O que o ciclo deixa de contar nos dias que divide (api/_ads-sync.ts): o
-- dia, os vínculos do outro ciclo (a sincronização tira a parte em comum) e
-- as páginas da Make do outro, quando ele também conta os cadastros delas.
create function public.ad_sync_shared_days(p_secret text, p_cycle uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare y public.ad_cycles; begin
 select * into y from public.ad_cycles where id = p_cycle;
 if not found or not mavi_private.ad_sync_allowed(p_secret, y.company_id) then
  raise exception 'Sem permissão' using errcode = '42501';
 end if;
 return (select coalesce(jsonb_agg(jsonb_build_object('day', s.day,
   'links', (select coalesce(jsonb_agg(jsonb_build_object('account_id', k.account_id,
     'campaign_id', k.external_campaign_id)), '[]')
    from public.ad_cycle_links k where k.company_id = s.company_id and k.cycle_id = s.other),
   'landing_pages', case when s.destination = 'make_landing_page' and s.objective not in ('traffic', 'engagement')
    then to_jsonb(s.landing_pages) else '[]'::jsonb end) order by s.day), '[]')
  from (
   -- O dia que este divide com o anterior, quando conta no anterior.
   select y.start_date as day, e.id as other, e.company_id, e.destination, e.objective, e.landing_pages
   from public.ad_cycles e where y.shared_day = 'earlier' and e.company_id = y.company_id
    and e.campaign_id = y.campaign_id and e.id <> y.id and e.end_date = y.start_date and e.start_date < y.start_date
   union all
   -- O dia que este divide com o seguinte, quando conta no seguinte.
   select y.end_date, n.id, n.company_id, n.destination, n.objective, n.landing_pages
   from public.ad_cycles n where n.shared_day = 'later' and n.company_id = y.company_id
    and n.campaign_id = y.campaign_id and n.id <> y.id and n.start_date = y.end_date and n.end_date > y.end_date
  ) s);
end $$;
revoke all on function public.ad_sync_shared_days(text, uuid) from public, anon, authenticated;
-- anon: the server calling back for the schedule, with the secret.
grant execute on function public.ad_sync_shared_days(text, uuid) to anon, authenticated;

-- ------------------------------------------------------------ lista
-- A da migração 20270208090000_campaign_daily_budget: o próximo ciclo pode
-- começar no dia em que o atual termina (sem o aviso "terminando"), e no dia
-- de virada o ciclo que cobre hoje é o que começa.
create or replace function public.ad_campaign_page(p_company uuid, p_scope text default 'active', p_search text default '',
 p_platform text default '', p_attention boolean default false, p_limit integer default 25, p_offset integer default 0)
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare t date; term text := mavi_private.fold(trim(coalesce(p_search, ''))); result jsonb; v_clients uuid[]; begin
 perform mavi_private.ad_require_reader(p_company);
 v_clients := case when mavi_private.leader(p_company) then null else mavi_private.served_clients(p_company) end;
 t := mavi_private.company_today(p_company);
 with scoped as (
  select a.*, cl.name as client_name, p.name as product_name,
   a.status = 'inactive' and a.legacy_id is null and a.created_at > now() - interval '60 days'
    and not exists (select 1 from public.ad_campaign_events e
     where e.company_id = a.company_id and e.campaign_id = a.id and e.action = 'status') as waiting
  from public.ad_campaigns a
  join public.contracts k on k.company_id = a.company_id and k.id = a.contract_id
  join public.clients cl on cl.company_id = k.company_id and cl.id = k.client_id
  join public.products p on p.company_id = k.company_id and p.id = k.product_id
  where a.company_id = p_company and not a.archived
   and (v_clients is null or k.client_id = any(v_clients))
 ), statused as (
  select s.* from scoped s
  where case coalesce(p_scope, 'active')
    when 'pending' then s.waiting
    when 'inactive' then s.status = 'inactive'
    when 'all' then true
    else s.status = 'active' end
 ), alerts as (
  -- Only what the alert needs, for every campaign of the scope (the counts
  -- and the "atenção" filter); the cycles' data only for the page below.
  select s.*, cur.end_date as current_end,
   -- Uma inativa (fora as novas aguardando ativação) não tem alerta de ciclo.
   case when s.status = 'inactive' and not s.waiting then 'none'
    when not exists (select 1 from public.ad_cycles y
     where y.company_id = s.company_id and y.campaign_id = s.id) then 'no_cycle'
    when cur.end_date is null then 'no_current'
    when t > cur.end_date then 'ended'
    when t = cur.end_date then 'ends_today'
    when cur.end_date - t + 1 <= 10 and not exists (select 1 from public.ad_cycles y
     where y.company_id = s.company_id and y.campaign_id = s.id and y.id <> s.current_cycle_id
      and y.start_date >= cur.end_date and y.start_date > cur.start_date) then 'ending'
    else 'none' end as alert_kind
  from statused s
  left join public.ad_cycles cur on cur.company_id = s.company_id and cur.id = s.current_cycle_id
 ), filtered as (
  select a.* from alerts a
  where (term = '' or strpos(mavi_private.fold(a.name || ' ' || a.client_name), term) > 0)
   and (coalesce(p_platform, '') = '' or a.platform = p_platform)
   and (not coalesce(p_attention, false) or a.alert_kind <> 'none')
 ), sliced as (
  select f.* from filtered f
  order by (f.status <> 'active'), mavi_private.fold(f.client_name), mavi_private.fold(f.name), f.id
  limit greatest(least(coalesce(p_limit, 25), 100), 1) offset greatest(coalesce(p_offset, 0), 0)
 ), page as (
  select f.*,
   (select to_jsonb(y) from public.ad_cycles y where y.company_id = f.company_id and y.id = f.current_cycle_id) as current,
   (select to_jsonb(y) from public.ad_cycles y where y.company_id = f.company_id and y.campaign_id = f.id
     and f.current_end is not null and y.id <> f.current_cycle_id and y.start_date >= f.current_end
     and y.start_date > cur.start_date
     order by y.start_date limit 1) as next,
   (select to_jsonb(y) from public.ad_cycles y where y.company_id = f.company_id and y.campaign_id = f.id
     and y.start_date <= t and y.end_date >= t order by y.start_date desc limit 1) as covering,
   (select to_jsonb(y) from public.ad_cycles y where y.company_id = f.company_id and y.campaign_id = f.id
     and y.start_date > t order by y.start_date limit 1) as future,
   (select to_jsonb(y) from public.ad_cycles y where y.company_id = f.company_id and y.campaign_id = f.id
     order by y.start_date desc limit 1) as last,
   case when f.current_cycle_id is null then null
    when dm.days > 0 then jsonb_build_object('net', dm.net, 'gross', dm.gross)
    else jsonb_build_object('net', coalesce(sn.spend, 0), 'gross', coalesce(sn.spend * cur.multiplier, 0)) end as spent
  from sliced f
  left join public.ad_cycles cur on cur.company_id = f.company_id and cur.id = f.current_cycle_id
  left join lateral (select count(*) as days, coalesce(sum(d.spend), 0) as net,
    coalesce(sum(d.spend * d.multiplier), 0) as gross
   from public.ad_daily_metrics d
   where d.company_id = f.company_id and d.cycle_id = f.current_cycle_id) dm on true
  left join lateral (select s.spend from public.ad_cycle_snapshots s
   where s.company_id = f.company_id and s.cycle_id = f.current_cycle_id
   order by s.taken_on desc limit 1) sn on true
 )
 select jsonb_build_object(
  'total', (select count(*) from filtered),
  'all', (select count(*) from alerts),
  'attention', (select count(*) from alerts where alert_kind <> 'none'),
  'rows', coalesce((select jsonb_agg(jsonb_build_object(
    'campaign', jsonb_build_object('id', p.id, 'company_id', p.company_id, 'contract_id', p.contract_id,
     'name', p.name, 'platform', p.platform, 'status', p.status, 'current_cycle_id', p.current_cycle_id,
     'briefing_url', p.briefing_url, 'media_plan_url', p.media_plan_url, 'notes', p.notes,
     'archived', p.archived, 'created_by', p.created_by, 'created_at', p.created_at,
     'updated_at', p.updated_at, 'version', p.version),
    'client_name', p.client_name,
    'product_name', p.product_name,
    'current', p.current,
    'alert', jsonb_build_object('kind', p.alert_kind,
     'days', case p.alert_kind when 'ended' then t - p.current_end
      when 'ending' then p.current_end - t + 1 end,
     'next', case p.alert_kind when 'ended' then coalesce(p.covering, p.next)
      when 'no_current' then coalesce(p.covering, p.future, p.last)
      when 'ends_today' then p.next when 'ending' then p.next end),
    'waiting', p.waiting,
    'spent', p.spent)
   order by (p.status <> 'active'), mavi_private.fold(p.client_name), mavi_private.fold(p.name), p.id) from page p), '[]')
 ) into result;
 -- New campaigns waiting for their first activation (a separate count).
 if coalesce(p_scope, 'active') <> 'pending' then
  result := result || jsonb_build_object('pending', (select count(*) from public.ad_campaigns a
   join public.contracts k on k.company_id = a.company_id and k.id = a.contract_id
   where a.company_id = p_company and not a.archived and a.status = 'inactive' and a.legacy_id is null
    and (v_clients is null or k.client_id = any(v_clients))
    and a.created_at > now() - interval '60 days'
    and not exists (select 1 from public.ad_campaign_events e
     where e.company_id = a.company_id and e.campaign_id = a.id and e.action = 'status')));
 end if;
 return result;
end $$;

commit;
