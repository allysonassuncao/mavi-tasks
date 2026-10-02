begin;

-- Campanhas › Conversar com a MAVI: a MAVI consulta ao vivo as contas de
-- anúncio dos clientes, só leitura.
--  * Meta Ads: pela conexão do Facebook que as Campanhas já têm (o botão
--    Conectar do cliente, com ads_read): as mesmas leituras da aba
--    Plataforma e consultas livres ao Graph, só GET.
--  * Google Ads: as mesmas consultas do MCP oficial do Google (contas, GAQL e
--    os campos de cada recurso), pela conexão da agência (MCC).
--  * O recorte é o das Campanhas: a pessoa só consulta as contas vinculadas
--    aos clientes que ela vê no módulo (líderes: todos os clientes; quem tem
--    o módulo ligado: os clientes das equipes dela). O token de uma conexão
--    pode enxergar outras contas: o servidor só usa o token da própria conta
--    e confere de que conta é cada objeto antes de ler.

-- ------------------------------------------------------------ contas por cliente
-- As contas de anúncio que a pessoa pode consultar com a MAVI, por cliente:
-- as do Facebook ligadas ao cliente e as vinculadas aos ciclos das campanhas
-- (Meta e Google), com as campanhas do MAVI e as da plataforma de cada uma.
create or replace function public.ad_ai_accounts(p_company uuid, p_client uuid default null) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_clients uuid[]; begin
 perform mavi_private.ad_require_reader(p_company);
 v_clients := mavi_private.module_scope(p_company, 'campaigns');
 if p_client is not null and v_clients is not null and not p_client = any(v_clients) then
  raise exception 'Sem permissão: este cliente não é de uma equipe sua' using errcode = '42501';
 end if;
 return (
  with links as (
   select a.platform, l.account_id, l.account_name, l.manager_id, k.client_id, a.id as campaign_id,
    a.name as campaign_name, a.status, l.external_campaign_id, l.campaign_name as external_name
   from public.ad_cycle_links l
   join public.ad_cycles y on y.company_id = l.company_id and y.id = l.cycle_id
   join public.ad_campaigns a on a.company_id = y.company_id and a.id = y.campaign_id
   join public.contracts k on k.company_id = a.company_id and k.id = a.contract_id
   where l.company_id = p_company and a.platform in ('meta', 'google') and not a.archived
    and (v_clients is null or k.client_id = any(v_clients)) and (p_client is null or k.client_id = p_client)),
  accounts as (
   select platform, account_id, client_id from links
   union
   select 'meta', m.account_id, m.client_id from mavi_private.ad_meta_accounts m
   where m.company_id = p_company and m.client_id is not null
    and (v_clients is null or m.client_id = any(v_clients)) and (p_client is null or m.client_id = p_client))
  select coalesce(jsonb_agg(jsonb_build_object(
    'platform', x.platform, 'account_id', x.account_id,
    'name', coalesce(
     (select nullif(m.name, '') from mavi_private.ad_meta_accounts m
      where x.platform = 'meta' and m.company_id = p_company and m.account_id = x.account_id),
     (select max(nullif(l.account_name, '')) from links l where l.platform = x.platform and l.account_id = x.account_id),
     ''),
    'manager_id', coalesce((select max(nullif(l.manager_id, '')) from links l
     where l.platform = x.platform and l.account_id = x.account_id), ''),
    'client_id', x.client_id, 'client', c.name,
    -- Meta: a conta tem a conexão do Facebook (o token) para ler ao vivo.
    'connected', x.platform = 'google' or exists (select 1 from mavi_private.ad_meta_accounts m
     where m.company_id = p_company and m.account_id = x.account_id),
    'campaigns', (select coalesce(jsonb_agg(jsonb_build_object('id', g.campaign_id, 'name', g.campaign_name,
       'status', g.status, 'platform_campaigns', g.ext) order by g.status, g.campaign_name), '[]')
     from (select l.campaign_id, l.campaign_name, l.status,
       coalesce(jsonb_agg(distinct jsonb_build_object('id', l.external_campaign_id, 'name', l.external_name))
        filter (where l.external_campaign_id <> ''), '[]') as ext
      from links l where l.platform = x.platform and l.account_id = x.account_id and l.client_id = x.client_id
      group by l.campaign_id, l.campaign_name, l.status) g))
   order by c.name, x.platform, x.account_id), '[]')
  from accounts x join public.clients c on c.company_id = p_company and c.id = x.client_id);
end $$;
revoke all on function public.ad_ai_accounts(uuid, uuid) from public, anon;
grant execute on function public.ad_ai_accounts(uuid, uuid) to authenticated;

commit;
