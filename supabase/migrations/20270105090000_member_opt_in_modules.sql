begin;

-- Visão geral, Campanhas, Radar do cliente e Dashboards deixam de ser só de
-- administradores e gestores: em "Módulos visíveis", um administrador os liga
-- para um colaborador. Para colaboradores eles começam desligados (nada muda
-- para ninguém até alguém ligar) e, ligados, são só leitura e só dos clientes
-- das equipes da pessoa:
--  * Visão geral: os números e as tarefas da própria pessoa (o resumo e as
--    tarefas já vêm assim do banco);
--  * Campanhas: as campanhas dos clientes das equipes dela, com ciclos,
--    números e histórico; sem editar, sincronizar nem conectar contas;
--  * Radar: os itens dos clientes das equipes dela (visão geral e lista); os
--    temas, os relatórios, os avisos e a configuração seguem dos líderes;
--  * Dashboards: a lista dos que foram compartilhados com ela ou com a equipe
--    (o acesso a eles já era esse, pelo link).
-- memberships.shown_pages guarda os ligados; hidden_pages segue guardando os
-- escondidos, e esconder vence ligar. Para líderes, shown_pages não conta.

alter table public.memberships add column if not exists shown_pages text[] not null default '{}';
alter table public.memberships drop constraint if exists memberships_shown_pages_check;
alter table public.memberships add constraint memberships_shown_pages_check
 check (shown_pages <@ array['overview','campaigns','radar','dashboards']::text[]);

-- Se o módulo está ligado para quem chama e ele é colaborador.
create or replace function mavi_private.opt_in_on(c uuid, p_module text) returns boolean
language sql stable security definer set search_path = '' as $$
 select exists (select 1 from public.memberships m where m.company_id = c and m.user_id = auth.uid()
  and m.active and m.role = 'member' and p_module = any(m.shown_pages) and not p_module = any(m.hidden_pages))
$$;
revoke all on function mavi_private.opt_in_on(uuid, text) from public, anon;
grant execute on function mavi_private.opt_in_on(uuid, text) to authenticated;

-- Os clientes das equipes de quem chama (a regra do Drive, de uma vez).
create or replace function mavi_private.served_clients(c uuid) returns uuid[]
language sql stable security definer set search_path = '' as $$
 select coalesce(array_agg(distinct ct.client_id), '{}') from public.client_teams ct
 join public.team_members tm on tm.company_id = ct.company_id and tm.team_id = ct.team_id
 where ct.company_id = c and tm.user_id = auth.uid()
$$;
revoke all on function mavi_private.served_clients(uuid) from public, anon;
grant execute on function mavi_private.served_clients(uuid) to authenticated;

-- A lista chega com tudo o que está desligado para a pessoa (como a tela
-- mostra); para um colaborador, os módulos opcionais viram os ligados.
create or replace function public.set_member_pages(p_company uuid, p_user uuid, p_hidden text[]) returns void
language plpgsql security definer set search_path = '' as $$
declare v text[]; v_role text; opt text[] := array['overview','campaigns','radar','dashboards']; v_shown text[]; begin
 if not mavi_private.admin(p_company) then
  raise exception 'Somente administradores escolhem os módulos de cada pessoa.' using errcode = '42501';
 end if;
 select role into v_role from public.memberships where company_id = p_company and user_id = p_user;
 if not found then
  raise exception 'Usuário não encontrado na empresa';
 end if;
 select coalesce(array_agg(distinct x order by x), '{}') into v from unnest(coalesce(p_hidden, '{}')) x;
 if not v <@ array['overview','tasks','agenda','clients','products','projects','campaigns','hours',
  'reports','drive','storage','dashboards','onboarding','aiUsage','assistant','cases','notices',
  'temperature','socialMedia','radar']::text[] then
  raise exception 'Módulo inválido' using errcode = '22023';
 end if;
 if v_role = 'member' then
  select coalesce(array_agg(x order by x), '{}') into v_shown from unnest(opt) x where not x = any(v);
  select coalesce(array_agg(x order by x), '{}') into v from unnest(v) x where not x = any(opt);
  update public.memberships set hidden_pages = v, shown_pages = v_shown
  where company_id = p_company and user_id = p_user
   and (hidden_pages is distinct from v or shown_pages is distinct from v_shown);
 else
  update public.memberships set hidden_pages = v where company_id = p_company and user_id = p_user
   and hidden_pages is distinct from v;
 end if;
end $$;

-- ------------------------------------------------------------ Campanhas
-- Ler: líderes, ou o colaborador com o módulo ligado (cada leitura filtra os
-- clientes dele). Escrever segue em ad_can_write (só líderes).
create or replace function mavi_private.ad_require_reader(c uuid) returns void
language plpgsql stable security definer set search_path = '' as $$ begin
 if not (mavi_private.leader(c) or mavi_private.opt_in_on(c, 'campaigns')) then
  raise exception 'Sem permissão: Campanhas não está disponível para você' using errcode = '42501';
 end if;
end $$;

alter policy ad_campaigns_read on public.ad_campaigns
 using (company_id in (select mavi_private.leader_companies())
  or (mavi_private.opt_in_on(company_id, 'campaigns') and contract_id in (select mavi_private.team_contracts())));
-- Os números seguem a campanha (a política acima vale dentro da subconsulta).
alter policy ad_daily_metrics_read on public.ad_daily_metrics
 using (company_id in (select mavi_private.leader_companies())
  or campaign_id in (select a.id from public.ad_campaigns a where a.company_id = ad_daily_metrics.company_id));
alter policy ad_cycle_snapshots_read on public.ad_cycle_snapshots
 using (company_id in (select mavi_private.leader_companies())
  or campaign_id in (select a.id from public.ad_campaigns a where a.company_id = ad_cycle_snapshots.company_id));
alter policy ad_sync_runs_read on public.ad_sync_runs
 using (company_id in (select mavi_private.leader_companies())
  or campaign_id in (select a.id from public.ad_campaigns a where a.company_id = ad_sync_runs.company_id));

-- A da migração 20261003090000, lida também pelo colaborador com o módulo
-- ligado: só as campanhas dos clientes das equipes dele.
create or replace function public.ad_campaign_page(p_company uuid, p_scope text default 'active', p_search text default '',
 p_platform text default '', p_attention boolean default false, p_limit integer default 25, p_offset integer default 0)
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare t date; term text := mavi_private.fold(trim(coalesce(p_search, ''))); result jsonb; v_clients uuid[]; begin
 perform mavi_private.ad_require_reader(p_company);
 v_clients := case when mavi_private.leader(p_company) then null else mavi_private.served_clients(p_company) end;
 t := mavi_private.company_today(p_company);
 with scoped as (
  select a.*, cl.name as client_name, p.name as product_name
  from public.ad_campaigns a
  join public.contracts k on k.company_id = a.company_id and k.id = a.contract_id
  join public.clients cl on cl.company_id = k.company_id and cl.id = k.client_id
  join public.products p on p.company_id = k.company_id and p.id = k.product_id
  where a.company_id = p_company and not a.archived
   and (v_clients is null or k.client_id = any(v_clients))
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
   join public.contracts k on k.company_id = a.company_id and k.id = a.contract_id
   where a.company_id = p_company and not a.archived and a.status = 'inactive' and a.legacy_id is null
    and (v_clients is null or k.client_id = any(v_clients))
    and a.created_at > now() - interval '60 days'
    and not exists (select 1 from public.ad_campaign_events e
     where e.company_id = a.company_id and e.campaign_id = a.id and e.action = 'status')));
 end if;
 return result;
end $$;

-- ------------------------------------------------------------ Radar
-- A da migração 20270101090000: o colaborador com o módulo ligado vê os
-- números só dos clientes das equipes dele e não configura nada.
create or replace function public.radar_overview(p_company uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_leader boolean := mavi_private.leader(p_company); v_clients uuid[]; begin
 if not (v_leader or mavi_private.opt_in_on(p_company, 'radar')) then
  raise exception 'Sem permissão' using errcode = '42501';
 end if;
 if v_leader then perform mavi_private.radar_seed(p_company);
 else v_clients := mavi_private.served_clients(p_company); end if;
 return jsonb_build_object(
  'topics', coalesce((select jsonb_agg(mavi_private.radar_topic_json(t) || jsonb_build_object(
     'open', (select count(*) from public.radar_items i where i.topic_id = t.id
       and (v_clients is null or i.client_id = any(v_clients))
       and coalesce(mavi_private.radar_status(t.statuses, i.status)->>'kind', '') <> 'closed'),
     'new_7d', (select count(*) from public.radar_items i where i.topic_id = t.id
       and (v_clients is null or i.client_id = any(v_clients)) and i.created_at > now() - interval '7 days'),
     'severe', (select count(*) from public.radar_items i where i.topic_id = t.id and i.severity >= 2
       and (v_clients is null or i.client_id = any(v_clients))
       and coalesce(mavi_private.radar_status(t.statuses, i.status)->>'kind', '') <> 'closed'),
     'overdue', case when t.has_due then (select count(*) from public.radar_items i where i.topic_id = t.id
       and (v_clients is null or i.client_id = any(v_clients))
       and i.due_date < current_date
       and coalesce(mavi_private.radar_status(t.statuses, i.status)->>'kind', '') <> 'closed') end,
     'total', (select count(*) from public.radar_items i where i.topic_id = t.id
       and (v_clients is null or i.client_id = any(v_clients))))
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
  'can_configure', v_leader);
end $$;

-- A da migração 20261230090000, com o mesmo recorte para o colaborador.
create or replace function public.radar_items(p_company uuid, p_filters jsonb) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare f jsonb := coalesce(p_filters, '{}'); v_topic uuid; v_q text; v_limit integer; v_offset integer;
 v_out jsonb; v_clients uuid[]; begin
 if mavi_private.leader(p_company) then v_clients := null;
 elsif mavi_private.opt_in_on(p_company, 'radar') then v_clients := mavi_private.served_clients(p_company);
 else raise exception 'Sem permissão' using errcode = '42501'; end if;
 v_topic := case when f->>'topic' ~* '^[0-9a-f-]{36}$' then (f->>'topic')::uuid end;
 v_q := nullif(btrim(coalesce(f->>'q', '')), '');
 v_limit := least(greatest(coalesce((f->>'limit')::integer, 50), 1), 200);
 v_offset := greatest(coalesce((f->>'offset')::integer, 0), 0);
 with base as (
  select i.*, coalesce(mavi_private.radar_status(t.statuses, i.status)->>'kind', '') as kind
  from public.radar_items i
  join public.radar_topics t on t.id = i.topic_id
  where i.company_id = p_company
   and (v_clients is null or i.client_id = any(v_clients))
   and (v_topic is null or i.topic_id = v_topic)
   and (v_q is null or i.search @@ websearch_to_tsquery('portuguese', v_q) or i.title ilike '%' || v_q || '%'
    or exists (select 1 from public.clients k where k.id = i.client_id and k.name ilike '%' || v_q || '%'))
   and (coalesce(f->>'product', '') = '' or (f->>'product' = 'none' and i.product_id is null)
    or (f->>'product' ~* '^[0-9a-f-]{36}$' and i.product_id = (f->>'product')::uuid))
   and (coalesce(f->>'client', '') !~* '^[0-9a-f-]{36}$' or i.client_id = (f->>'client')::uuid)
   and (coalesce(f->>'team', '') !~* '^[0-9a-f-]{36}$' or exists (select 1 from public.client_teams ct
    where ct.company_id = i.company_id and ct.client_id = i.client_id and ct.team_id = (f->>'team')::uuid))
   and (jsonb_typeof(f->'statuses') is distinct from 'array' or jsonb_array_length(f->'statuses') = 0
    or i.status in (select jsonb_array_elements_text(f->'statuses')))
   and (jsonb_typeof(f->'severity') is distinct from 'number' or i.severity >= (f->>'severity')::integer)
   and (coalesce(f->>'assignee', '') = '' or (f->>'assignee' = 'none' and i.assignee_id is null)
    or (f->>'assignee' ~* '^[0-9a-f-]{36}$' and i.assignee_id = (f->>'assignee')::uuid))
   and (coalesce(f->>'theme', '') = '' or (f->>'theme' = 'none' and i.theme_id is null)
    or (f->>'theme' ~* '^[0-9a-f-]{36}$' and i.theme_id = (f->>'theme')::uuid))
   and (jsonb_typeof(f->'days') is distinct from 'number' or (f->>'days')::integer <= 0
    or i.last_seen_at > now() - make_interval(days => (f->>'days')::integer))
 ), page as (
  select b.*, count(*) over () as total from base b
  order by
   case when f->>'sort' = 'mentions' then b.mentions end desc nulls last,
   case when f->>'sort' = 'severity' then b.severity end desc nulls last,
   case when f->>'sort' = 'oldest' then b.first_seen_at end asc,
   case when b.kind = 'closed' then 1 else 0 end,
   b.last_seen_at desc, b.id
  limit v_limit offset v_offset
 )
 select jsonb_build_object('total', coalesce(max(page.total), 0),
  'items', coalesce(jsonb_agg(mavi_private.radar_item_json(i)
   order by case when f->>'sort' = 'mentions' then page.mentions end desc nulls last,
    case when f->>'sort' = 'severity' then page.severity end desc nulls last,
    case when f->>'sort' = 'oldest' then page.first_seen_at end asc,
    case when page.kind = 'closed' then 1 else 0 end,
    page.last_seen_at desc, page.id), '[]'))
 into v_out
 from page join public.radar_items i on i.id = page.id;
 return v_out;
end $$;

commit;
