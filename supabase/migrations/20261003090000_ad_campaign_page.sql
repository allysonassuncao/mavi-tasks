begin;

-- Campanhas: a lista paginada no servidor. Antes a tela lia todas as
-- campanhas, ciclos e vínculos da empresa (milhares com o histórico do MASO)
-- e filtrava no navegador. Agora cada página vem pronta daqui:
--  * só campanhas ativas (a lista nunca mostra as inativas), ou, no escopo
--    'pending', as criadas no MAVI nos últimos 60 dias que nunca foram
--    ativadas — para uma campanha nova não se perder antes do primeiro ciclo;
--  * cada linha com o cliente, o produto, o ciclo atual e o alerta do ciclo
--    (a mesma regra de cycleAlert em src/campaigns.ts);
--  * busca (sem acento) no nome da campanha e do cliente, plataforma e
--    "precisam de atenção", com o total e a página pedida.
-- Só administradores (como o resto do módulo).

create index ad_campaigns_listing on public.ad_campaigns(company_id, status) where not archived;
create index ad_campaign_events_status on public.ad_campaign_events(company_id, campaign_id) where action = 'status';

create function public.ad_campaign_page(p_company uuid, p_scope text default 'active', p_search text default '',
 p_platform text default '', p_attention boolean default false, p_limit integer default 25, p_offset integer default 0)
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare t date; term text := mavi_private.fold(trim(coalesce(p_search, ''))); result jsonb; begin
 perform mavi_private.ad_require_admin(p_company);
 t := mavi_private.company_today(p_company);
 with scoped as (
  select a.*, cl.name as client_name, p.name as product_name
  from public.ad_campaigns a
  join public.contracts k on k.company_id = a.company_id and k.id = a.contract_id
  join public.clients cl on cl.company_id = k.company_id and cl.id = k.client_id
  join public.products p on p.company_id = k.company_id and p.id = k.product_id
  where a.company_id = p_company and not a.archived
   and case when p_scope = 'pending' then
     a.status = 'inactive' and a.legacy_id is null and a.created_at > now() - interval '60 days'
     and not exists (select 1 from public.ad_campaign_events e
      where e.company_id = a.company_id and e.campaign_id = a.id and e.action = 'status')
    else a.status = 'active' end
 ), alerts as (
  -- Only what the alert needs, for every campaign of the scope (the counts
  -- and the "atenção" filter); the cycles' data only for the page below.
  select s.*, cur.end_date as current_end,
   case when not exists (select 1 from public.ad_cycles y
     where y.company_id = s.company_id and y.campaign_id = s.id) then 'no_cycle'
    when cur.end_date is null then 'no_current'
    when t > cur.end_date then 'ended'
    when t = cur.end_date then 'ends_today'
    when cur.end_date - t + 1 <= 10 and not exists (select 1 from public.ad_cycles y
     where y.company_id = s.company_id and y.campaign_id = s.id and y.id <> s.current_cycle_id
      and y.start_date > cur.end_date) then 'ending'
    else 'none' end as alert_kind
  from scoped s
  left join public.ad_cycles cur on cur.company_id = s.company_id and cur.id = s.current_cycle_id
 ), filtered as (
  select a.* from alerts a
  where (term = '' or strpos(mavi_private.fold(a.name || ' ' || a.client_name), term) > 0)
   and (coalesce(p_platform, '') = '' or a.platform = p_platform)
   and (not coalesce(p_attention, false) or a.alert_kind <> 'none')
 ), sliced as (
  select f.* from filtered f
  order by mavi_private.fold(f.client_name), mavi_private.fold(f.name), f.id
  limit greatest(least(coalesce(p_limit, 25), 100), 1) offset greatest(coalesce(p_offset, 0), 0)
 ), page as (
  select f.*,
   (select to_jsonb(y) from public.ad_cycles y where y.company_id = f.company_id and y.id = f.current_cycle_id) as current,
   (select to_jsonb(y) from public.ad_cycles y where y.company_id = f.company_id and y.campaign_id = f.id
     and f.current_end is not null and y.id <> f.current_cycle_id and y.start_date > f.current_end
     order by y.start_date limit 1) as next,
   (select to_jsonb(y) from public.ad_cycles y where y.company_id = f.company_id and y.campaign_id = f.id
     and y.start_date <= t and y.end_date >= t order by y.start_date limit 1) as covering,
   (select to_jsonb(y) from public.ad_cycles y where y.company_id = f.company_id and y.campaign_id = f.id
     and y.start_date > t order by y.start_date limit 1) as future,
   (select to_jsonb(y) from public.ad_cycles y where y.company_id = f.company_id and y.campaign_id = f.id
     order by y.start_date desc limit 1) as last
  from sliced f
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
      when 'ends_today' then p.next when 'ending' then p.next end))
   order by mavi_private.fold(p.client_name), mavi_private.fold(p.name), p.id) from page p), '[]')
 ) into result;
 -- New campaigns waiting for their first activation (a separate count).
 if coalesce(p_scope, 'active') <> 'pending' then
  result := result || jsonb_build_object('pending', (select count(*) from public.ad_campaigns a
   where a.company_id = p_company and not a.archived and a.status = 'inactive' and a.legacy_id is null
    and a.created_at > now() - interval '60 days'
    and not exists (select 1 from public.ad_campaign_events e
     where e.company_id = a.company_id and e.campaign_id = a.id and e.action = 'status')));
 end if;
 return result;
end $$;
revoke all on function public.ad_campaign_page(uuid, text, text, text, boolean, integer, integer) from public, anon, authenticated;
grant execute on function public.ad_campaign_page(uuid, text, text, text, boolean, integer, integer) to authenticated;

commit;
