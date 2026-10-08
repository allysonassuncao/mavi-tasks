begin;

-- MakeCRM › Anúncios (contas Make Ads): quando o MASO não tem os registros
-- diários de uma campanha no período, o MakeCRM pede os números ao MAVI
-- (POST /api/makecrm-ads, com MAKECRM_ADS_SECRET; o servidor do MAVI chama
-- estas funções com o ADS_SYNC_SECRET, como /api/make-leads).
--
-- O MakeCRM chega às campanhas do MAVI por dois caminhos:
--  * a campanha do MASO (id_campanha), que a importação guardou em
--    ad_campaigns.legacy_id;
--  * a empresa do MakeCRM ligada ao cliente em Campanhas › Conexões
--    (client_crm_links): todas as campanhas do cliente, inclusive as criadas
--    só no MAVI.
-- Só leitura: nada aqui grava.

-- ------------------------------------------------------------ alcance
-- As campanhas (Meta e Google) que a empresa do MakeCRM alcança: as do MASO
-- pedidas (legacy_id) e todas as dos clientes ligados a ela.
create function mavi_private.makecrm_campaigns(p_crm_company uuid, p_legacy text[])
returns table(company_id uuid, campaign_id uuid)
language sql stable security definer set search_path = '' as $$
 select a.company_id, a.id from public.ad_campaigns a
 where a.platform in ('meta', 'google')
  and (a.legacy_id = any(coalesce(p_legacy, '{}'))
   or exists (select 1 from public.client_crm_links l
    join public.contracts k on k.company_id = l.company_id and k.client_id = l.client_id
    where l.crm_company_id = p_crm_company and k.company_id = a.company_id and k.id = a.contract_id))
$$;
revoke all on function mavi_private.makecrm_campaigns(uuid, text[]) from public, anon, authenticated;

-- Os vínculos (conta e campanha na plataforma) dos ciclos que cruzam o
-- período; sem nenhum, os do ciclo atual.
create function mavi_private.makecrm_links(p_company uuid, p_campaign uuid, p_since date, p_until date)
returns setof public.ad_cycle_links
language sql stable security definer set search_path = '' as $$
 with period as (
  select l.* from public.ad_cycle_links l
  join public.ad_cycles y on y.company_id = l.company_id and y.id = l.cycle_id
  where y.company_id = p_company and y.campaign_id = p_campaign
   and y.start_date <= p_until and y.end_date >= p_since)
 select * from period
 union all
 select l.* from public.ad_cycle_links l
 join public.ad_campaigns a on a.company_id = l.company_id and a.current_cycle_id = l.cycle_id
 where a.company_id = p_company and a.id = p_campaign and not exists (select 1 from period)
$$;
revoke all on function mavi_private.makecrm_links(uuid, uuid, date, date) from public, anon, authenticated;

create function mavi_private.makecrm_period(p_since date, p_until date) returns void
language plpgsql immutable set search_path = '' as $$ begin
 if p_since is null or p_until is null or p_until < p_since or p_until - p_since > 400 then
  raise exception 'Período inválido' using errcode = '22023';
 end if;
end $$;
revoke all on function mavi_private.makecrm_period(date, date) from public, anon, authenticated;

-- ------------------------------------------------------------ campanhas
-- As campanhas com números no período: a soma dos dias (ad_daily_metrics),
-- o investimento sem e com o M de cada dia (o MASO multiplicava o registro
-- diário pelo M dele), o ciclo do período e os vínculos na plataforma, com os
-- nomes, para o MakeCRM casar com as UTMs.
create function public.makecrm_ads_campaigns(p_secret text, p_crm_company uuid, p_legacy text[],
 p_since date, p_until date) returns jsonb
language plpgsql stable security definer set search_path = '' as $$ begin
 if not mavi_private.ad_sync_allowed(p_secret, null) then
  raise exception 'Sem permissão' using errcode = '42501';
 end if;
 perform mavi_private.makecrm_period(p_since, p_until);
 return (
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', a.id, 'legacy_id', a.legacy_id, 'name', a.name, 'platform', a.platform, 'status', a.status,
    'created_on', (a.created_at at time zone 'America/Sao_Paulo')::date,
    'cycle', (select jsonb_build_object('id', y.id, 'legacy_id', y.legacy_id, 'objective', y.objective,
       'start_date', y.start_date, 'end_date', y.end_date)
      from public.ad_cycles y where y.company_id = a.company_id and y.campaign_id = a.id
      order by (y.start_date <= p_until and y.end_date >= p_since) desc, (y.id = a.current_cycle_id) desc,
       y.start_date desc
      limit 1),
    'links', (select coalesce(jsonb_agg(distinct jsonb_build_object('account_id', l.account_id,
       'campaign_id', l.external_campaign_id, 'campaign_name', l.campaign_name, 'manager_id', l.manager_id)), '[]')
      from mavi_private.makecrm_links(a.company_id, a.id, p_since, p_until) l),
    'totals', to_jsonb(t)) order by a.name), '[]')
  from mavi_private.makecrm_campaigns(p_crm_company, p_legacy) m
  join public.ad_campaigns a on a.company_id = m.company_id and a.id = m.campaign_id
  cross join lateral (
   select count(*) as days, sum(d.spend) as spend, sum(d.spend * d.multiplier) as spend_m,
    sum(d.impressions) as impressions, sum(d.reach) as reach, sum(d.clicks) as clicks,
    sum(d.conversions) as conversions, sum(d.view_content) as view_content,
    sum(d.add_to_cart) as add_to_cart, sum(d.initiate_checkout) as initiate_checkout
   from public.ad_daily_metrics d
   where d.company_id = a.company_id and d.campaign_id = a.id and d.day between p_since and p_until) t
  where t.days > 0);
end $$;

-- ------------------------------------------------------------ acesso ao Meta
-- Para os anúncios e o público: as contas do Meta das campanhas pedidas (o id
-- do MAVI ou o do MASO), com as campanhas da plataforma de cada uma e o token
-- da conta (cifrado; só o servidor do MAVI abre). Conta sem conexão vem sem
-- token.
create function public.makecrm_ads_meta_access(p_secret text, p_crm_company uuid, p_refs text[],
 p_since date, p_until date) returns jsonb
language plpgsql stable security definer set search_path = '' as $$ begin
 if not mavi_private.ad_sync_allowed(p_secret, null) then
  raise exception 'Sem permissão' using errcode = '42501';
 end if;
 perform mavi_private.makecrm_period(p_since, p_until);
 return (
  select coalesce(jsonb_agg(jsonb_build_object(
    'campaign', x.campaign_id, 'legacy_id', x.legacy_id, 'account_id', x.account_id,
    'campaign_ids', x.campaign_ids, 'token_cipher', ma.token_cipher, 'expires_at', ma.token_expires_at)
    order by x.account_id), '[]')
  from (
   select a.company_id, a.id as campaign_id, a.legacy_id, l.account_id,
    coalesce(jsonb_agg(distinct l.external_campaign_id) filter (where l.external_campaign_id <> ''), '[]')
     as campaign_ids
   from mavi_private.makecrm_campaigns(p_crm_company, p_refs) m
   join public.ad_campaigns a on a.company_id = m.company_id and a.id = m.campaign_id
   cross join lateral mavi_private.makecrm_links(a.company_id, a.id, p_since, p_until) l
   where a.platform = 'meta' and (a.id::text = any(p_refs) or a.legacy_id = any(p_refs))
   group by a.company_id, a.id, a.legacy_id, l.account_id) x
  left join mavi_private.ad_meta_accounts ma on ma.company_id = x.company_id and ma.account_id = x.account_id);
end $$;

revoke all on function public.makecrm_ads_campaigns(text, uuid, text[], date, date),
 public.makecrm_ads_meta_access(text, uuid, text[], date, date) from public, anon, authenticated;
-- anon: o servidor do MAVI, com o segredo.
grant execute on function public.makecrm_ads_campaigns(text, uuid, text[], date, date),
 public.makecrm_ads_meta_access(text, uuid, text[], date, date) to anon, authenticated;

commit;
