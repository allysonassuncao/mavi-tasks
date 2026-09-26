begin;

-- Campanhas: quais ações de conversão do Google contam como resultado do
-- ciclo. O MASO contava as ações pelo nome (uma lista: lead, contato,
-- whats…); ação com outro nome contava zero e o analista lançava à mão.
-- Agora cada ciclo pode escolher as ações (os ids das ações de conversão do
-- Google e "phone_calls" para as ligações dos anúncios); sem escolha, valem
-- as categorias do objetivo (api/_conversions.ts). A escolha entra no
-- histórico da campanha e vai para a sincronização.

alter table public.ad_cycles add column conversion_actions text[]
 check (conversion_actions is null or (cardinality(conversion_actions) between 1 and 200
  and array_to_string(conversion_actions, ',') ~ '^([0-9]{1,30}|phone_calls)(,([0-9]{1,30}|phone_calls))*$'));

-- null (or an empty list): back to the categories.
create function public.set_ad_cycle_conversion_actions(p_cycle uuid, p_actions text[]) returns void
language plpgsql security definer set search_path = '' as $$
declare y public.ad_cycles; v text[]; begin
 select * into y from public.ad_cycles where id = p_cycle;
 if not found or not mavi_private.ad_can_write(y.company_id) then
  raise exception 'Sem permissão' using errcode = '42501';
 end if;
 select case when count(*) = 0 then null else array_agg(distinct x order by x) end into v
 from unnest(coalesce(p_actions, '{}')) x;
 if v is not null and exists (select 1 from unnest(v) x where x !~ '^([0-9]{1,30}|phone_calls)$') then
  raise exception 'Ação de conversão inválida' using errcode = '22023';
 end if;
 if v is not distinct from y.conversion_actions then return; end if;
 update public.ad_cycles set conversion_actions = v, updated_at = now() where id = p_cycle;
 perform mavi_private.ad_log(y.company_id, y.campaign_id, y.id, 'conversion_actions',
  jsonb_build_object('from', to_jsonb(y.conversion_actions), 'to', to_jsonb(v)));
end $$;

-- What the "Conversões do Google que contam" window needs (the server reads
-- the platform with it): the cycle's period, objective, destination, links
-- and choice.
create function public.ad_cycle_conversion_context(p_cycle uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare y public.ad_cycles; a public.ad_campaigns; begin
 select * into y from public.ad_cycles where id = p_cycle;
 if not found then raise exception 'Ciclo não encontrado' using errcode = '42501'; end if;
 perform mavi_private.ad_require_admin(y.company_id);
 select * into a from public.ad_campaigns where company_id = y.company_id and id = y.campaign_id;
 return jsonb_build_object('company_id', y.company_id, 'platform', a.platform, 'objective', y.objective,
  'destination', y.destination, 'start_date', y.start_date, 'end_date', y.end_date,
  'today', mavi_private.company_today(y.company_id), 'conversion_actions', y.conversion_actions,
  'links', coalesce((select jsonb_agg(jsonb_build_object('account_id', k.account_id,
    'campaign_id', k.external_campaign_id, 'manager_id', k.manager_id) order by k.account_id, k.external_campaign_id)
   from public.ad_cycle_links k where k.company_id = y.company_id and k.cycle_id = y.id), '[]'));
end $$;

revoke all on function public.set_ad_cycle_conversion_actions(uuid, text[]), public.ad_cycle_conversion_context(uuid)
 from public, anon, authenticated;
grant execute on function public.set_ad_cycle_conversion_actions(uuid, text[]), public.ad_cycle_conversion_context(uuid)
 to authenticated;

-- The sync gets the cycle's choice.
create or replace function public.ad_sync_targets(p_secret text, p_campaign uuid default null, p_limit integer default 15)
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_company uuid; result jsonb; begin
 if p_campaign is not null then
  select company_id into v_company from public.ad_campaigns where id = p_campaign;
  if v_company is null or not mavi_private.ad_sync_allowed(p_secret, v_company) then
   raise exception 'Sem permissão' using errcode = '42501';
  end if;
 elsif not mavi_private.ad_sync_allowed(p_secret, null) then
  raise exception 'Sem permissão' using errcode = '42501';
 end if;
 select coalesce(jsonb_agg(t order by t.last_run nulls first), '[]') into result from (
  select y.id as cycle_id, y.company_id, a.id as campaign_id, a.platform, y.objective, y.destination,
   y.start_date, y.end_date, y.goal_results, y.budget, y.multiplier, y.landing_pages, y.conversion_actions,
   mavi_private.company_today(y.company_id) as today,
   (select max(d.day) from public.ad_daily_metrics d where d.company_id = y.company_id and d.cycle_id = y.id
     and d.source in ('meta','google')) as last_day,
   (select max(r.created_at) from public.ad_sync_runs r where r.company_id = y.company_id and r.cycle_id = y.id) as last_run,
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
   and y.end_date >= mavi_private.company_today(y.company_id) - 8
   and (p_campaign is not null or not exists (select 1 from public.ad_sync_runs r where r.company_id = y.company_id
     and r.cycle_id = y.id and r.created_at >= (mavi_private.company_today(y.company_id))::timestamp))
  limit greatest(least(coalesce(p_limit, 15), 50), 1)
 ) t;
 return result;
end $$;

commit;
