begin;

-- Campanhas: "Conversões que contam" também no Meta. Até aqui o resultado do
-- ciclo no Meta era uma regra fixa pelo objetivo e destino
-- (api/_ads-sync.ts, metaResults): Lead em página externa contava só o
-- "Lead do pixel", e conversões personalizadas, conversas iniciadas e outros
-- eventos ficavam de fora. Agora cada ciclo do Meta pode escolher os tipos de
-- ação (action_type dos insights) que contam.
--
-- A escolha é uma lista de regras com a data em que cada uma passa a valer,
-- porque quem salva escolhe:
--  - recalcular o ciclo inteiro: uma regra só, desde o início do ciclo; os
--    dias e os acumulados da Linha do tempo são refeitos na sincronização;
--  - só daqui para frente: os dias até ontem ficam com a regra de antes e a
--    nova vale a partir de hoje.
-- [{"from": null | "AAAA-MM-DD", "actions": ["action_type", …] | null}, …]:
-- a primeira vale desde o início do ciclo (from null), actions null é a regra
-- padrão do objetivo. Sem lista (null), vale o padrão no ciclo todo.
-- Um ciclo novo herda a escolha que estava valendo no ciclo anterior.

alter table public.ad_cycles
 add column meta_conversions jsonb
  check (meta_conversions is null or (jsonb_typeof(meta_conversions) = 'array'
   and jsonb_array_length(meta_conversions) between 1 and 60)),
 -- "Recalcular o ciclo inteiro": a próxima sincronização refaz também os
 -- acumulados já gravados da Linha do tempo (a sincronização não mexe neles).
 add column meta_conversions_recount boolean not null default false;

-- ------------------------------------------------------------ herança
create function mavi_private.ad_cycle_inherit_meta_conversions() returns trigger
language plpgsql security definer set search_path = '' as $$
declare prev jsonb; last_actions jsonb; begin
 if new.meta_conversions is not null then return new; end if;
 if (select a.platform from public.ad_campaigns a where a.company_id = new.company_id and a.id = new.campaign_id)
  is distinct from 'meta' then
  return new;
 end if;
 select y.meta_conversions into prev from public.ad_cycles y
 where y.company_id = new.company_id and y.campaign_id = new.campaign_id and y.id <> new.id
 order by y.start_date desc, y.created_at desc limit 1;
 if prev is null then return new; end if;
 -- The rule that was counting at the end of the previous cycle.
 last_actions := prev -> (jsonb_array_length(prev) - 1) -> 'actions';
 if last_actions is null or jsonb_typeof(last_actions) <> 'array' then return new; end if;
 new.meta_conversions := jsonb_build_array(jsonb_build_object('from', null, 'actions', last_actions,
  'inherited', true));
 return new;
end $$;
revoke all on function mavi_private.ad_cycle_inherit_meta_conversions() from public, anon, authenticated;

create trigger ad_cycles_inherit_meta_conversions before insert on public.ad_cycles
 for each row execute function mavi_private.ad_cycle_inherit_meta_conversions();

-- ------------------------------------------------------------ escolha
-- p_actions null (ou vazio): volta para a regra padrão do objetivo.
-- p_mode 'all' recalcula o ciclo inteiro; 'forward' vale a partir de hoje.
create function public.set_ad_cycle_meta_conversions(p_cycle uuid, p_actions text[], p_mode text default 'all')
returns void
language plpgsql security definer set search_path = '' as $$
declare y public.ad_cycles; v_platform text; v text[]; t date; mode text := p_mode; kept jsonb; last_rule jsonb;
 want jsonb; result jsonb; begin
 select * into y from public.ad_cycles where id = p_cycle for update;
 if not found or not (mavi_private.ad_can_write(y.company_id) and mavi_private.module_client(y.company_id, 'campaigns',
  mavi_private.ad_campaign_client(y.campaign_id))) then
  raise exception 'Sem permissão' using errcode = '42501';
 end if;
 select a.platform into v_platform from public.ad_campaigns a where a.company_id = y.company_id and a.id = y.campaign_id;
 if v_platform <> 'meta' then
  raise exception 'Este ciclo não é de uma campanha do Meta Ads.' using errcode = '22023';
 end if;
 if mode is null or mode not in ('all', 'forward') then
  raise exception 'Escolha recalcular o ciclo inteiro ou só daqui para frente.' using errcode = '22023';
 end if;
 select case when count(*) = 0 then null else array_agg(distinct x order by x) end into v
 from unnest(coalesce(p_actions, '{}')) x where trim(x) <> '';
 if v is not null and (cardinality(v) > 50 or exists (select 1 from unnest(v) x where x !~ '^[a-z0-9_.]{1,120}$')) then
  raise exception 'Conversão inválida' using errcode = '22023';
 end if;
 t := mavi_private.company_today(y.company_id);
 -- A cycle not started yet: from today is the whole cycle.
 if mode = 'forward' and t <= y.start_date then mode := 'all'; end if;
 if mode = 'forward' and t > y.end_date then
  raise exception 'O ciclo já terminou: só dá para recalcular o ciclo inteiro.' using errcode = '22023';
 end if;
 want := coalesce(to_jsonb(v), 'null'::jsonb);
 if mode = 'all' then
  result := case when v is null then null
   else jsonb_build_array(jsonb_build_object('from', null, 'actions', want)) end;
 else
  -- The rules of the days before today stay; a change made earlier today is
  -- replaced.
  select coalesce(jsonb_agg(r order by o), '[]') into kept
  from jsonb_array_elements(coalesce(y.meta_conversions, '[]')) with ordinality e(r, o)
  where r ->> 'from' is null or (r ->> 'from')::date < t;
  if jsonb_array_length(kept) = 0 then
   kept := jsonb_build_array(jsonb_build_object('from', null, 'actions', null));
  end if;
  last_rule := kept -> (jsonb_array_length(kept) - 1);
  result := case when coalesce(last_rule -> 'actions', 'null'::jsonb) = want then kept
   else kept || jsonb_build_array(jsonb_build_object('from', t, 'actions', want)) end;
  -- Only the default left: no list.
  if not exists (select 1 from jsonb_array_elements(result) r where jsonb_typeof(r -> 'actions') = 'array') then
   result := null;
  end if;
 end if;
 if result is not distinct from y.meta_conversions then return; end if;
 update public.ad_cycles set meta_conversions = result,
  meta_conversions_recount = meta_conversions_recount or mode = 'all', updated_at = now()
 where id = y.id;
 perform mavi_private.ad_log(y.company_id, y.campaign_id, y.id, 'meta_conversions',
  jsonb_build_object('from', y.meta_conversions, 'to', result, 'mode', mode, 'actions', want,
   'since', case when mode = 'forward' then to_jsonb(t) else 'null'::jsonb end));
end $$;

revoke all on function public.set_ad_cycle_meta_conversions(uuid, text[], text) from public, anon, authenticated;
grant execute on function public.set_ad_cycle_meta_conversions(uuid, text[], text) to authenticated;

-- As conversões de um ciclo (a da migração 20270107090000), com a escolha do
-- Meta.
create or replace function public.ad_cycle_conversion_context(p_cycle uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare y public.ad_cycles; a public.ad_campaigns; begin
 select * into y from public.ad_cycles where id = p_cycle;
 if not found then raise exception 'Ciclo não encontrado' using errcode = '42501'; end if;
 perform mavi_private.ad_require_client(y.company_id, mavi_private.ad_campaign_client(y.campaign_id));
 select * into a from public.ad_campaigns where company_id = y.company_id and id = y.campaign_id;
 return jsonb_build_object('company_id', y.company_id, 'platform', a.platform, 'objective', y.objective,
  'destination', y.destination, 'start_date', y.start_date, 'end_date', y.end_date,
  'today', mavi_private.company_today(y.company_id), 'conversion_actions', y.conversion_actions,
  'meta_conversions', y.meta_conversions,
  'links', coalesce((select jsonb_agg(jsonb_build_object('account_id', k.account_id,
    'campaign_id', k.external_campaign_id, 'manager_id', k.manager_id) order by k.account_id, k.external_campaign_id)
   from public.ad_cycle_links k where k.company_id = y.company_id and k.cycle_id = y.id), '[]'));
end $$;

-- ------------------------------------------------------------ sincronização
-- A da migração 20270107090000, com a escolha do Meta e os acumulados a
-- refazer depois de "recalcular o ciclo inteiro".
create or replace function public.ad_sync_targets(p_secret text, p_campaign uuid default null, p_limit integer default 15)
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_company uuid; result jsonb; begin
 if p_campaign is not null then
  select company_id into v_company from public.ad_campaigns where id = p_campaign;
  if v_company is null or not mavi_private.ad_sync_allowed(p_secret, v_company) then
   raise exception 'Sem permissão' using errcode = '42501';
  end if;
  if not mavi_private.ad_sync_allowed(p_secret, null)
   and not mavi_private.module_client(v_company, 'campaigns', mavi_private.ad_campaign_client(p_campaign)) then
   raise exception 'Sem permissão' using errcode = '42501';
  end if;
 elsif not mavi_private.ad_sync_allowed(p_secret, null) then
  raise exception 'Sem permissão' using errcode = '42501';
 end if;
 select coalesce(jsonb_agg(t order by t.last_run nulls first), '[]') into result from (
  select y.id as cycle_id, y.company_id, a.id as campaign_id, a.platform, y.objective, y.destination,
   y.start_date, y.end_date, y.goal_results, y.budget, y.multiplier, y.landing_pages, y.conversion_actions,
   y.meta_conversions,
   mavi_private.company_today(y.company_id) as today,
   (select max(d.day) from public.ad_daily_metrics d where d.company_id = y.company_id and d.cycle_id = y.id
     and d.source in ('meta','google')) as last_day,
   (select max(r.created_at) from public.ad_sync_runs r where r.company_id = y.company_id and r.cycle_id = y.id) as last_run,
   -- The days that already have the cycle's cumulative (the sync fills the rest).
   (select coalesce(jsonb_agg(s.taken_on order by s.taken_on), '[]') from public.ad_cycle_snapshots s
    where s.company_id = y.company_id and s.cycle_id = y.id) as snapshot_days,
   -- After "recalcular o ciclo inteiro": the period ends of the cumulatives
   -- the sync took before today, to count again with the new choice.
   case when y.meta_conversions_recount and a.platform = 'meta' then
    (select coalesce(jsonb_agg(distinct s.period_end), '[]') from public.ad_cycle_snapshots s
     where s.company_id = y.company_id and s.cycle_id = y.id and s.source = 'meta'
      and s.taken_on < mavi_private.company_today(y.company_id)) end as recount_snapshots,
   (select jsonb_agg(jsonb_build_object('account_id', k.account_id, 'campaign_id', k.external_campaign_id,
     'manager_id', k.manager_id) order by k.account_id, k.external_campaign_id)
    from public.ad_cycle_links k where k.company_id = y.company_id and k.cycle_id = y.id) as links,
   case when a.platform = 'meta' then (select jsonb_object_agg(m.account_id, jsonb_build_object(
     'token_cipher', m.token_cipher, 'expires_at', m.token_expires_at))
    from mavi_private.ad_meta_accounts m where m.company_id = y.company_id and m.account_id in
     (select k.account_id from public.ad_cycle_links k where k.company_id = y.company_id and k.cycle_id = y.id)) end
    as meta_tokens,
   case when a.platform = 'google' then (select jsonb_build_object('refresh_token_cipher', g.refresh_token_cipher)
    from mavi_private.ad_google_connections g where g.company_id = y.company_id) end as google_token
  from public.ad_cycles y
  join public.ad_campaigns a on a.company_id = y.company_id and a.id = y.campaign_id
  where a.platform in ('meta','google') and not a.archived
   and (p_campaign is null or a.id = p_campaign)
   and exists (select 1 from public.ad_cycle_links k where k.company_id = y.company_id and k.cycle_id = y.id)
   and y.start_date < mavi_private.company_today(y.company_id)
   -- An older cycle only to count again with a new choice.
   and (y.end_date >= mavi_private.company_today(y.company_id) - 8 or y.meta_conversions_recount)
   and (p_campaign is not null or not exists (select 1 from public.ad_sync_runs r where r.company_id = y.company_id
     and r.cycle_id = y.id and r.created_at >= (mavi_private.company_today(y.company_id))::timestamp))
  -- The longest without a sync first (never synced before all), then the
  -- cycles still running: a call picks up where the last one stopped.
  order by last_run nulls first, y.end_date desc, y.id
  limit greatest(least(coalesce(p_limit, 15), 50), 1)
 ) t;
 return result;
end $$;

-- The cumulatives counted again (conversions and Bom/Ruim; the rest is the
-- platform's and doesn't change). Imported from the MASO or edited by hand:
-- kept. Clears the cycle's flag.
create function public.ad_sync_recount(p_secret text, p_cycle uuid, p_snapshots jsonb default '[]') returns integer
language plpgsql security definer set search_path = '' as $$
declare y public.ad_cycles; s jsonb; v numeric; n integer := 0; k integer; begin
 select * into y from public.ad_cycles where id = p_cycle;
 if not found or not mavi_private.ad_sync_allowed(p_secret, y.company_id) then
  raise exception 'Sem permissão' using errcode = '42501';
 end if;
 if jsonb_typeof(coalesce(p_snapshots, '[]')) <> 'array' then
  raise exception 'Acumulados inválidos' using errcode = '22023';
 end if;
 for s in select * from jsonb_array_elements(coalesce(p_snapshots, '[]')) loop
  continue when jsonb_typeof(s) <> 'object' or (s ->> 'period_end') is null;
  v := round(greatest(coalesce((s ->> 'conversions')::numeric, 0), 0), 2);
  update public.ad_cycle_snapshots x set conversions = v,
   goal_status = mavi_private.ad_goal_status(y, jsonb_build_object('spend', x.spend, 'conversions', v))
  where x.company_id = y.company_id and x.cycle_id = y.id and x.source = 'meta'
   and x.period_end = (s ->> 'period_end')::date
   and x.taken_on < mavi_private.company_today(y.company_id);
  get diagnostics k = row_count;
  n := n + k;
 end loop;
 update public.ad_cycles set meta_conversions_recount = false where id = y.id and meta_conversions_recount;
 return n;
end $$;

revoke all on function public.ad_sync_recount(text, uuid, jsonb) from public, anon, authenticated;
-- anon: the server calling back for the schedule, with the secret.
grant execute on function public.ad_sync_recount(text, uuid, jsonb) to anon, authenticated;

-- ------------------------------------------------------------ relatórios
-- A da migração 20270120090000, com a escolha do Meta de cada ciclo.
create or replace function public.ad_report_sources(p_campaign uuid, p_start date, p_end date) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare a public.ad_campaigns; begin
 a := mavi_private.ad_report_campaign(p_campaign);
 return jsonb_build_object('platform', a.platform,
  'cycles', (select coalesce(jsonb_agg(jsonb_build_object('id', y.id, 'start_date', y.start_date,
    'end_date', y.end_date, 'objective', y.objective, 'destination', y.destination,
    'conversion_actions', to_jsonb(y.conversion_actions), 'meta_conversions', y.meta_conversions)
    order by y.start_date), '[]')
   from public.ad_cycles y where y.company_id = a.company_id and y.campaign_id = a.id
    and y.start_date <= p_end and y.end_date >= p_start),
  'links', (select coalesce(jsonb_agg(distinct jsonb_build_object('account_id', l.account_id,
    'campaign_id', l.external_campaign_id, 'manager_id', l.manager_id)), '[]')
   from public.ad_cycle_links l join public.ad_cycles y on y.company_id = l.company_id and y.id = l.cycle_id
   where y.company_id = a.company_id and y.campaign_id = a.id and y.start_date <= p_end and y.end_date >= p_start));
end $$;

commit;
