begin;

-- Visão geral, Campanhas, Radar do cliente e Dashboards para colaboradores
-- (migração 20270105090000): com o módulo ligado em "Módulos visíveis", o
-- colaborador passa a usar tudo o que o módulo tem, como um gestor, mas só nos
-- clientes das equipes dele. Continua desligado até um administrador ligar.
--  * Campanhas: cadastrar e editar campanhas e ciclos, ativar e inativar,
--    editar os registros, sincronizar, as conversões do Google, a conexão do
--    Facebook do cliente e os formulários de lead. Um gatilho em cada tabela
--    do módulo confere o cliente de toda gravação de quem não é líder. A
--    conexão do Google é da agência (sem cliente): o colaborador usa as contas
--    já vinculadas às campanhas dos clientes dele; conectar ou desconectar o
--    Google (e desligar o Facebook da agência inteira) segue dos líderes.
--  * Radar: mexer nos itens, temas, relatórios e avisos, recortados pelos
--    clientes dele. A configuração (tópicos, histórico, modelos) segue dos
--    líderes, no Painel da MAVI.
--  * Dashboards: criar, editar, duplicar, compartilhar e excluir os seus. Os
--    painéis de um dashboard criado por colaborador mostram só os clientes
--    das equipes de quem o criou, para quem quer que o abra (também pelo
--    link); a fonte Mural de avisos, que não tem cliente, fica de fora deles.

-- ------------------------------------------------------------ regra comum
create or replace function mavi_private.served_clients_of(c uuid, u uuid) returns uuid[]
language sql stable security definer set search_path = '' as $$
 select coalesce(array_agg(distinct ct.client_id), '{}') from public.client_teams ct
 join public.team_members tm on tm.company_id = ct.company_id and tm.team_id = ct.team_id
 where ct.company_id = c and tm.user_id = u
$$;
create or replace function mavi_private.served_clients(c uuid) returns uuid[]
language sql stable security definer set search_path = '' as $$
 select mavi_private.served_clients_of(c, auth.uid())
$$;
create or replace function mavi_private.opt_in_for(c uuid, u uuid, p_module text) returns boolean
language sql stable security definer set search_path = '' as $$
 select exists (select 1 from public.memberships m where m.company_id = c and m.user_id = u
  and m.active and m.role = 'member' and p_module = any(m.shown_pages) and not p_module = any(m.hidden_pages))
$$;
create or replace function mavi_private.opt_in_on(c uuid, p_module text) returns boolean
language sql stable security definer set search_path = '' as $$
 select mavi_private.opt_in_for(c, auth.uid(), p_module)
$$;
-- Quem chama trabalha neste cliente pelo módulo: líder, ou colaborador com o
-- módulo ligado numa equipe do cliente.
create or replace function mavi_private.module_client(c uuid, p_module text, p_client uuid) returns boolean
language sql stable security definer set search_path = '' as $$
 select mavi_private.leader(c) or (p_client is not null and mavi_private.opt_in_on(c, p_module)
  and p_client = any(mavi_private.served_clients(c)))
$$;
-- Os clientes a que quem chama se limita no módulo (null: líder, todos).
create or replace function mavi_private.module_scope(c uuid, p_module text) returns uuid[]
language plpgsql stable security definer set search_path = '' as $$ begin
 if mavi_private.leader(c) then return null; end if;
 if mavi_private.opt_in_on(c, p_module) then return mavi_private.served_clients(c); end if;
 raise exception 'Sem permissão' using errcode = '42501';
end $$;
revoke all on function mavi_private.served_clients_of(uuid, uuid), mavi_private.opt_in_for(uuid, uuid, text),
 mavi_private.module_client(uuid, text, uuid), mavi_private.module_scope(uuid, text) from public, anon;
grant execute on function mavi_private.served_clients_of(uuid, uuid), mavi_private.opt_in_for(uuid, uuid, text),
 mavi_private.module_client(uuid, text, uuid), mavi_private.module_scope(uuid, text) to authenticated;

-- ------------------------------------------------------------ Campanhas
create or replace function mavi_private.ad_campaign_client(p_campaign uuid) returns uuid
language sql stable security definer set search_path = '' as $$
 select k.client_id from public.ad_campaigns a
 join public.contracts k on k.company_id = a.company_id and k.id = a.contract_id where a.id = p_campaign
$$;
create or replace function mavi_private.ad_require_client(c uuid, p_client uuid) returns void
language plpgsql stable security definer set search_path = '' as $$ begin
 if not mavi_private.module_client(c, 'campaigns', p_client) then
  raise exception 'Sem permissão: este cliente não é de uma equipe sua' using errcode = '42501';
 end if;
end $$;

-- As funções de gravação continuam as mesmas; quem não é líder passa por
-- elas com o módulo ligado, e o gatilho abaixo confere o cliente de cada
-- linha gravada.
create or replace function mavi_private.ad_can_write(c uuid) returns boolean
language sql stable security definer set search_path = '' as $$
 select mavi_private.leader(c) or mavi_private.opt_in_on(c, 'campaigns')
$$;
create or replace function mavi_private.ad_sync_allowed(p_secret text, c uuid) returns boolean
language sql stable security definer set search_path = '' as $$
 select (p_secret is not null and exists (select 1 from mavi_private.ad_sync_config where id and secret = p_secret))
  or (c is not null and (mavi_private.leader(c) or mavi_private.opt_in_on(c, 'campaigns')))
$$;

-- Toda gravação nas tabelas do módulo feita por uma pessoa que não é líder
-- tem de ser de um cliente das equipes dela (a agenda e o webhook, sem
-- pessoa, passam direto).
create or replace function mavi_private.ad_guard_client() returns trigger
language plpgsql security definer set search_path = '' as $$
declare j jsonb; v_company uuid; v_client uuid; begin
 if auth.uid() is null then
  if tg_op = 'DELETE' then return old; end if;
  return new;
 end if;
 -- A linha de antes (troca ou exclusão) e a de depois (inclusão ou troca).
 for j in select x from unnest(array[case when tg_op in ('UPDATE', 'DELETE') then to_jsonb(old) end,
   case when tg_op in ('INSERT', 'UPDATE') then to_jsonb(new) end]) x where x is not null
 loop
  v_company := (j->>'company_id')::uuid;
  if mavi_private.leader(v_company) then continue; end if;
  if tg_table_name = 'ad_campaigns' then
   select k.client_id into v_client from public.contracts k
   where k.company_id = v_company and k.id = (j->>'contract_id')::uuid;
  elsif tg_table_name = 'ad_cycle_links' then
   select k.client_id into v_client from public.ad_cycles y
   join public.ad_campaigns a on a.company_id = y.company_id and a.id = y.campaign_id
   join public.contracts k on k.company_id = a.company_id and k.id = a.contract_id
   where y.id = (j->>'cycle_id')::uuid;
  else
   v_client := mavi_private.ad_campaign_client((j->>'campaign_id')::uuid);
  end if;
  if not mavi_private.module_client(v_company, 'campaigns', v_client) then
   raise exception 'Sem permissão: esta campanha não é de um cliente das suas equipes' using errcode = '42501';
  end if;
 end loop;
 if tg_op = 'DELETE' then return old; end if;
 return new;
end $$;
revoke all on function mavi_private.ad_guard_client() from public, anon, authenticated;
do $$ declare t text; begin
 foreach t in array array['ad_campaigns', 'ad_cycles', 'ad_cycle_links', 'ad_campaign_events', 'ad_daily_metrics',
  'ad_cycle_snapshots', 'ad_sync_runs', 'ad_campaign_comments'] loop
  execute format('drop trigger if exists ad_guard_client on public.%I', t);
  execute format('create trigger ad_guard_client before insert or update or delete on public.%I'
   ' for each row execute function mavi_private.ad_guard_client()', t);
 end loop;
end $$;

alter policy ad_campaign_comments_read on public.ad_campaign_comments
 using (company_id in (select mavi_private.leader_companies())
  or campaign_id in (select a.id from public.ad_campaigns a where a.company_id = ad_campaign_comments.company_id));

-- As gravações conferem o cliente antes de tudo (as mensagens de validação
-- não contam nada de campanhas alheias); o gatilho acima é a trava final.
-- Os corpos são os das migrações de origem de cada uma.

create or replace function public.create_ad_campaign(p_company uuid, p_contract uuid, p_name text, p_platform text,
 p_briefing_url text default '', p_media_plan_url text default '', p_notes text default '') returns uuid
language plpgsql security definer set search_path = '' as $$
declare result uuid; begin
 if not (mavi_private.ad_can_write(p_company) and mavi_private.module_client(p_company, 'campaigns',
  (select k.client_id from public.contracts k where k.company_id = p_company and k.id = p_contract))) then
  raise exception 'Sem permissão: Campanhas é exclusivo de administradores' using errcode = '42501';
 end if;
 if not exists (select 1 from public.contracts where company_id = p_company and id = p_contract and not archived) then
  raise exception 'Produto contratado inválido' using errcode = '22023';
 end if;
 perform mavi_private.ad_check_urls(p_briefing_url, p_media_plan_url);
 insert into public.ad_campaigns(company_id, contract_id, name, platform, briefing_url, media_plan_url, notes)
 values (p_company, p_contract, trim(p_name), p_platform, trim(coalesce(p_briefing_url, '')),
  trim(coalesce(p_media_plan_url, '')), coalesce(p_notes, ''))
 returning id into result;
 perform mavi_private.ad_log(p_company, result, null, 'created',
  jsonb_build_object('name', trim(p_name), 'platform', p_platform));
 return result;
end $$;

create or replace function public.update_ad_campaign(p_campaign uuid, p_version integer, p_name text, p_platform text,
 p_briefing_url text default '', p_media_plan_url text default '', p_notes text default '') returns void
language plpgsql security definer set search_path = '' as $$
declare a public.ad_campaigns; b public.ad_campaigns; begin
 select * into a from public.ad_campaigns where id = p_campaign for update;
 if not found or not (mavi_private.ad_can_write(a.company_id) and mavi_private.module_client(a.company_id, 'campaigns',
  (select k.client_id from public.contracts k where k.company_id = a.company_id and k.id = a.contract_id))) then
  raise exception 'Sem permissão' using errcode = '42501';
 end if;
 if a.version <> p_version then
  raise exception 'A campanha foi alterada por outra pessoa. Recarregue e tente de novo.' using errcode = '40001';
 end if;
 if p_platform <> a.platform and (select count(*) from public.ad_cycles where campaign_id = a.id) > 1 then
  raise exception 'A plataforma não muda depois do segundo ciclo: cadastre uma nova campanha' using errcode = '22023';
 end if;
 perform mavi_private.ad_check_urls(p_briefing_url, p_media_plan_url);
 update public.ad_campaigns set name = trim(p_name), platform = p_platform,
  briefing_url = trim(coalesce(p_briefing_url, '')), media_plan_url = trim(coalesce(p_media_plan_url, '')),
  notes = coalesce(p_notes, ''), updated_at = now(), version = version + 1
 where id = a.id returning * into b;
 perform mavi_private.ad_log(a.company_id, a.id, null, 'updated', mavi_private.ad_changes(to_jsonb(a), to_jsonb(b),
  array['name','platform','briefing_url','media_plan_url','notes']));
end $$;

create or replace function public.set_ad_campaign_status(p_campaign uuid, p_status text, p_reason text) returns void
language plpgsql security definer set search_path = '' as $$
declare a public.ad_campaigns; begin
 select * into a from public.ad_campaigns where id = p_campaign for update;
 if not found or not (mavi_private.ad_can_write(a.company_id) and mavi_private.module_client(a.company_id, 'campaigns',
  (select k.client_id from public.contracts k where k.company_id = a.company_id and k.id = a.contract_id))) then
  raise exception 'Sem permissão' using errcode = '42501';
 end if;
 if p_status is null or p_status not in ('active', 'inactive') then
  raise exception 'Status inválido' using errcode = '22023';
 end if;
 if a.status = p_status then
  raise exception 'A campanha já está %', case p_status when 'active' then 'ativa' else 'inativa' end using errcode = '22023';
 end if;
 if length(trim(coalesce(p_reason, ''))) < 3 then
  raise exception 'Informe o motivo' using errcode = '22023';
 end if;
 if p_status = 'active' and a.current_cycle_id is null then
  raise exception 'Defina o ciclo atual antes de ativar a campanha' using errcode = '22023';
 end if;
 update public.ad_campaigns set status = p_status, updated_at = now(), version = version + 1 where id = a.id;
 perform mavi_private.ad_log(a.company_id, a.id, a.current_cycle_id, 'status',
  jsonb_build_object('from', a.status, 'to', p_status, 'reason', trim(p_reason)));
end $$;

create or replace function public.set_ad_campaign_current_cycle(p_campaign uuid, p_cycle uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare a public.ad_campaigns; begin
 select * into a from public.ad_campaigns where id = p_campaign for update;
 if not found or not (mavi_private.ad_can_write(a.company_id) and mavi_private.module_client(a.company_id, 'campaigns',
  (select k.client_id from public.contracts k where k.company_id = a.company_id and k.id = a.contract_id))) then
  raise exception 'Sem permissão' using errcode = '42501';
 end if;
 if not exists (select 1 from public.ad_cycles where campaign_id = a.id and id = p_cycle) then
  raise exception 'Ciclo inválido para esta campanha' using errcode = '22023';
 end if;
 if a.current_cycle_id is not distinct from p_cycle then return; end if;
 update public.ad_campaigns set current_cycle_id = p_cycle, updated_at = now(), version = version + 1 where id = a.id;
 perform mavi_private.ad_log(a.company_id, a.id, p_cycle, 'current_cycle',
  jsonb_build_object('from', a.current_cycle_id, 'to', p_cycle));
end $$;

create or replace function public.create_ad_cycle(p_campaign uuid, p_competence date, p_start date, p_end date,
 p_objective text, p_goal_results integer, p_budget numeric, p_multiplier numeric default null,
 p_destination text default 'external_page', p_landing_pages text[] default '{}', p_niche text default '',
 p_links jsonb default '[]', p_make_current boolean default false) returns uuid
language plpgsql security definer set search_path = '' as $$
declare a public.ad_campaigns; result uuid; inherited numeric; m numeric; links jsonb; begin
 select * into a from public.ad_campaigns where id = p_campaign for update;
 if not found or not (mavi_private.ad_can_write(a.company_id) and mavi_private.module_client(a.company_id, 'campaigns',
  (select k.client_id from public.contracts k where k.company_id = a.company_id and k.id = a.contract_id))) then
  raise exception 'Sem permissão' using errcode = '42501';
 end if;
 if a.archived then raise exception 'Campanha arquivada' using errcode = '22023'; end if;
 perform mavi_private.ad_cycle_checks(a.company_id, a.id, null, p_start, p_end, p_objective, p_goal_results,
  p_budget, p_destination, p_landing_pages);
 select multiplier into inherited from public.ad_cycles where campaign_id = a.id
  order by start_date desc, created_at desc limit 1;
 inherited := coalesce(inherited, 1);
 m := coalesce(p_multiplier, inherited);
 insert into public.ad_cycles(company_id, campaign_id, competence_month, start_date, end_date, objective,
  goal_results, budget, multiplier, destination, landing_pages, niche)
 values (a.company_id, a.id, date_trunc('month', coalesce(p_competence, p_start))::date, p_start, p_end,
  p_objective, p_goal_results, round(p_budget, 2), m, p_destination,
  case when p_destination = 'make_landing_page' then coalesce(p_landing_pages, '{}') else '{}' end,
  trim(coalesce(p_niche, '')))
 returning id into result;
 links := mavi_private.ad_set_links(a.company_id, result, p_links);
 perform mavi_private.ad_log(a.company_id, a.id, result, 'cycle_created', jsonb_build_object(
  'start_date', p_start, 'end_date', p_end, 'objective', p_objective, 'goal_results', p_goal_results,
  'budget', round(p_budget, 2), 'multiplier', m, 'links', links));
 if p_make_current then
  update public.ad_campaigns set current_cycle_id = result, updated_at = now(), version = version + 1 where id = a.id;
  perform mavi_private.ad_log(a.company_id, a.id, result, 'current_cycle',
   jsonb_build_object('from', a.current_cycle_id, 'to', result));
 end if;
 return result;
end $$;

create or replace function public.update_ad_cycle(p_cycle uuid, p_version integer, p_competence date, p_start date, p_end date,
 p_objective text, p_goal_results integer, p_budget numeric, p_multiplier numeric default null,
 p_destination text default 'external_page', p_landing_pages text[] default '{}', p_niche text default '',
 p_links jsonb default '[]') returns void
language plpgsql security definer set search_path = '' as $$
declare y public.ad_cycles; z public.ad_cycles; a public.ad_campaigns; before_links jsonb; links jsonb;
 changes jsonb; begin
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
 select coalesce(jsonb_agg(jsonb_build_object('account_id', account_id, 'campaign_id', external_campaign_id)
  order by account_id, external_campaign_id), '[]') into before_links from public.ad_cycle_links where cycle_id = y.id;
 update public.ad_cycles set competence_month = date_trunc('month', coalesce(p_competence, p_start))::date,
  start_date = p_start, end_date = p_end, objective = p_objective, goal_results = p_goal_results,
  budget = round(p_budget, 2), multiplier = coalesce(p_multiplier, multiplier),
  destination = p_destination,
  landing_pages = case when p_destination = 'make_landing_page' then coalesce(p_landing_pages, '{}') else '{}' end,
  niche = trim(coalesce(p_niche, '')), updated_at = now(), version = version + 1
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
end $$;

create or replace function public.add_ad_campaign_comment(p_campaign uuid, p_kind text, p_body text)
returns public.ad_campaign_comments
language plpgsql security definer set search_path = '' as $$
declare a public.ad_campaigns; result public.ad_campaign_comments; begin
 select * into a from public.ad_campaigns where id = p_campaign;
 if not found or not (mavi_private.ad_can_write(a.company_id) and mavi_private.module_client(a.company_id, 'campaigns',
  (select k.client_id from public.contracts k where k.company_id = a.company_id and k.id = a.contract_id))) then
  raise exception 'Sem permissão' using errcode = '42501';
 end if;
 if p_kind not in ('optimization','correction','information') then
  raise exception 'Informe o que você realizou' using errcode = '22023';
 end if;
 if length(trim(coalesce(p_body, ''))) = 0 then
  raise exception 'Escreva o comentário' using errcode = '22023';
 end if;
 insert into public.ad_campaign_comments(company_id, campaign_id, cycle_id, author_id, kind, body)
 values (a.company_id, a.id, a.current_cycle_id, auth.uid(), p_kind, left(p_body, 20000))
 returning * into result;
 return result;
end $$;

create or replace function public.update_ad_daily_metric(p_cycle uuid, p_day date, p_values jsonb) returns void
language plpgsql security definer set search_path = '' as $$
declare r public.ad_daily_metrics; m jsonb; v_m numeric; changes jsonb; begin
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
  raise exception 'O M deve ser maior que 0 e no máximo 100' using errcode = '22023';
 end if;
 changes := mavi_private.ad_changes(to_jsonb(r), m || jsonb_build_object('multiplier', round(v_m, 3)),
  array['multiplier','spend','impressions','reach','clicks','conversions','view_content','add_to_cart',
   'initiate_checkout']);
 if changes = '{}' then return; end if;
 update public.ad_daily_metrics set multiplier = round(v_m, 3), spend = (m ->> 'spend')::numeric,
  impressions = (m ->> 'impressions')::bigint, reach = (m ->> 'reach')::bigint, clicks = (m ->> 'clicks')::bigint,
  conversions = (m ->> 'conversions')::numeric, view_content = (m ->> 'view_content')::numeric,
  add_to_cart = (m ->> 'add_to_cart')::numeric, initiate_checkout = (m ->> 'initiate_checkout')::numeric,
  source = 'manual', synced_at = now()
 where id = r.id;
 perform mavi_private.ad_log(r.company_id, r.campaign_id, r.cycle_id, 'daily_edited',
  jsonb_build_object('day', r.day, 'changes', changes));
end $$;

create or replace function public.update_ad_cycle_snapshot(p_id bigint, p_values jsonb) returns void
language plpgsql security definer set search_path = '' as $$
declare s public.ad_cycle_snapshots; y public.ad_cycles; m jsonb; v_end date; v_status text; changes jsonb; begin
 select * into s from public.ad_cycle_snapshots where id = p_id;
 if not found or not (mavi_private.ad_can_write(s.company_id) and mavi_private.module_client(s.company_id, 'campaigns',
  mavi_private.ad_campaign_client(s.campaign_id))) then
  raise exception 'Sem permissão' using errcode = '42501';
 end if;
 if jsonb_typeof(coalesce(p_values, 'null')) <> 'object' then
  raise exception 'Valores inválidos' using errcode = '22023';
 end if;
 select * into y from public.ad_cycles where company_id = s.company_id and id = s.cycle_id;
 m := mavi_private.ad_edit_metrics(p_values, to_jsonb(s));
 begin
  v_end := coalesce(nullif(p_values ->> 'period_end', '')::date, s.period_end);
 exception when others then
  raise exception 'Data final inválida' using errcode = '22023';
 end;
 if v_end < s.period_start or v_end > greatest(y.end_date, s.period_end) then
  raise exception 'A data final vai de % a %', to_char(s.period_start, 'DD/MM/YYYY'),
   to_char(greatest(y.end_date, s.period_end), 'DD/MM/YYYY') using errcode = '22023';
 end if;
 v_status := case when not (p_values ? 'goal_status') then s.goal_status
  when p_values ->> 'goal_status' in ('good','bad') then p_values ->> 'goal_status'
  when p_values ->> 'goal_status' = 'auto' then
   case when y.goal_results <= 0 then null
    when (m ->> 'conversions')::numeric > 0
     and (m ->> 'spend')::numeric / (m ->> 'conversions')::numeric <= (y.budget / y.multiplier) / y.goal_results
     then 'good' else 'bad' end
  when p_values -> 'goal_status' = 'null'::jsonb then null
  else 'invalid' end;
 if v_status = 'invalid' then raise exception 'Status inválido' using errcode = '22023'; end if;
 changes := mavi_private.ad_changes(to_jsonb(s), m || jsonb_build_object('period_end', v_end, 'goal_status', v_status),
  array['period_end','spend','impressions','reach','clicks','conversions','view_content','add_to_cart',
   'initiate_checkout','goal_status']);
 if changes = '{}' then return; end if;
 update public.ad_cycle_snapshots set period_end = v_end, spend = (m ->> 'spend')::numeric,
  impressions = (m ->> 'impressions')::bigint, reach = (m ->> 'reach')::bigint, clicks = (m ->> 'clicks')::bigint,
  conversions = (m ->> 'conversions')::numeric, view_content = (m ->> 'view_content')::numeric,
  add_to_cart = (m ->> 'add_to_cart')::numeric, initiate_checkout = (m ->> 'initiate_checkout')::numeric,
  goal_status = v_status, source = 'manual'
 where id = s.id;
 perform mavi_private.ad_log(s.company_id, s.campaign_id, s.cycle_id, 'snapshot_edited',
  jsonb_build_object('taken_on', s.taken_on, 'changes', changes));
end $$;

create or replace function public.set_ad_cycle_conversion_actions(p_cycle uuid, p_actions text[]) returns void
language plpgsql security definer set search_path = '' as $$
declare y public.ad_cycles; v text[]; begin
 select * into y from public.ad_cycles where id = p_cycle;
 if not found or not (mavi_private.ad_can_write(y.company_id) and mavi_private.module_client(y.company_id, 'campaigns',
  mavi_private.ad_campaign_client(y.campaign_id))) then
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

create or replace function public.delete_ad_campaign_comment(p_comment uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare c public.ad_campaign_comments; begin
 select * into c from public.ad_campaign_comments where id = p_comment;
 if not found or not (mavi_private.ad_can_write(c.company_id) and mavi_private.module_client(c.company_id, 'campaigns',
  mavi_private.ad_campaign_client(c.campaign_id))) or c.author_id <> auth.uid() then
  raise exception 'Só quem escreveu remove o comentário' using errcode = '42501';
 end if;
 delete from public.ad_campaign_comments where id = p_comment;
end $$;

-- A sincronização de uma campanha pedida por uma pessoa: só as dos clientes
-- dela (a da migração 20261119090000).
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
   mavi_private.company_today(y.company_id) as today,
   (select max(d.day) from public.ad_daily_metrics d where d.company_id = y.company_id and d.cycle_id = y.id
     and d.source in ('meta','google')) as last_day,
   (select max(r.created_at) from public.ad_sync_runs r where r.company_id = y.company_id and r.cycle_id = y.id) as last_run,
   -- The days that already have the cycle's cumulative (the sync fills the rest).
   (select coalesce(jsonb_agg(s.taken_on order by s.taken_on), '[]') from public.ad_cycle_snapshots s
    where s.company_id = y.company_id and s.cycle_id = y.id) as snapshot_days,
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
  -- The longest without a sync first (never synced before all), then the
  -- cycles still running: a call picks up where the last one stopped.
  order by last_run nulls first, y.end_date desc, y.id
  limit greatest(least(coalesce(p_limit, 15), 50), 1)
 ) t;
 return result;
end $$;

-- As conversões do Google de um ciclo (a da migração 20261014090000).
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
  'links', coalesce((select jsonb_agg(jsonb_build_object('account_id', k.account_id,
    'campaign_id', k.external_campaign_id, 'manager_id', k.manager_id) order by k.account_id, k.external_campaign_id)
   from public.ad_cycle_links k where k.company_id = y.company_id and k.cycle_id = y.id), '[]'));
end $$;

-- A situação da sincronização (a da migração 20261004090000), só das
-- campanhas dos clientes de quem não é líder.
create or replace function public.ad_sync_overview(p_company uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare t date; tz text; job jsonb := null; result jsonb; v_clients uuid[]; begin
 perform mavi_private.ad_require_reader(p_company);
 v_clients := mavi_private.module_scope(p_company, 'campaigns');
 t := mavi_private.company_today(p_company);
 tz := coalesce((select timezone from public.companies where id = p_company), 'America/Sao_Paulo');
 -- pg_cron may be missing (local databases): then there is no job to show.
 if to_regclass('cron.job') is not null then
  execute $q$
   select jsonb_build_object('schedule', j.schedule, 'active', j.active,
    'last_run', (select jsonb_build_object('status', d.status, 'start_time', d.start_time,
      'message', left(coalesce(d.return_message, ''), 300))
     from cron.job_run_details d where d.jobid = j.jobid order by d.start_time desc limit 1))
   from cron.job j where j.jobname = 'mavi-ads-sync' limit 1 $q$ into job;
 end if;
 with due as (
  select y.id, y.end_date, a.id as campaign_id, a.name as campaign
  from public.ad_cycles y
  join public.ad_campaigns a on a.company_id = y.company_id and a.id = y.campaign_id
  join public.contracts k on k.company_id = a.company_id and k.id = a.contract_id
  where y.company_id = p_company and a.platform in ('meta','google') and not a.archived
   and (v_clients is null or k.client_id = any(v_clients))
   and exists (select 1 from public.ad_cycle_links l where l.company_id = y.company_id and l.cycle_id = y.id)
   and y.start_date < t and y.end_date >= t - 8
 ), state as (
  select d.*,
   (select r.status from public.ad_sync_runs r where r.company_id = p_company and r.cycle_id = d.id
     and (r.created_at at time zone tz)::date = t order by r.created_at desc limit 1) as today_status,
   (select r.message from public.ad_sync_runs r where r.company_id = p_company and r.cycle_id = d.id
     and (r.created_at at time zone tz)::date = t order by r.created_at desc limit 1) as today_message,
   (select max(m.day) from public.ad_daily_metrics m where m.company_id = p_company and m.cycle_id = d.id
     and m.source in ('meta','google')) as last_day
  from due d
 )
 select jsonb_build_object(
  'configured', exists (select 1 from mavi_private.ad_sync_config where id),
  'job', job,
  'today', t,
  'last_schedule', (select max(r.created_at) from public.ad_sync_runs r
    where r.company_id = p_company and r.trigger = 'schedule'),
  'due', (select count(*) from state),
  'synced', (select count(*) from state where today_status = 'ok'),
  'failed', (select count(*) from state where today_status = 'error'),
  'pending', (select count(*) from state where today_status is null),
  'up_to_date', (select count(*) from state where last_day >= least(end_date, t - 1)),
  'errors', coalesce((select jsonb_agg(jsonb_build_object('campaign_id', s.campaign_id, 'campaign', s.campaign,
     'message', s.today_message) order by s.campaign) from (select * from state where today_status = 'error'
     order by campaign limit 30) s), '[]'),
  'stale', coalesce((select jsonb_agg(jsonb_build_object('campaign_id', s.campaign_id, 'campaign', s.campaign,
     'last_day', s.last_day) order by s.campaign) from (select * from state
     where last_day is null or last_day < least(end_date, t - 1) order by campaign limit 30) s), '[]')
 ) into result;
 return result;
end $$;

-- ---- conexões (as das migrações 20261001090000 e 20261005090000)
create or replace function public.ad_connections(p_company uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_clients uuid[]; begin
 perform mavi_private.ad_require_reader(p_company);
 v_clients := mavi_private.module_scope(p_company, 'campaigns');
 return jsonb_build_object(
  'meta', (select jsonb_build_object('accounts', count(*), 'people', coalesce(jsonb_agg(distinct fb_user_name), '[]'),
    'expires_at', min(token_expires_at), 'updated_at', max(updated_at))
   from mavi_private.ad_meta_accounts where company_id = p_company
    and (v_clients is null or client_id = any(v_clients)) having count(*) > 0),
  'google', (select jsonb_build_object('email', account_email, 'connected_at', connected_at)
   from mavi_private.ad_google_connections where company_id = p_company),
  'can_manage_agency', v_clients is null);
end $$;

create or replace function public.ad_meta_account_list(p_company uuid) returns table(account_id text, name text,
 currency text, account_status integer, token_expires_at timestamptz, fb_user_id text, fb_user_name text,
 client_id uuid, client_name text)
language plpgsql stable security definer set search_path = '' as $$
declare v_clients uuid[]; begin
 perform mavi_private.ad_require_reader(p_company);
 v_clients := mavi_private.module_scope(p_company, 'campaigns');
 return query select m.account_id, m.name, m.currency, m.account_status, m.token_expires_at, m.fb_user_id,
  m.fb_user_name, m.client_id, c.name
  from mavi_private.ad_meta_accounts m
  left join public.clients c on c.company_id = m.company_id and c.id = m.client_id
  where m.company_id = p_company and (v_clients is null or m.client_id = any(v_clients))
  order by c.name nulls last, m.name, m.account_id;
end $$;

-- For /api/ads only: encrypted tokens (useless without the server's key).
create or replace function public.ad_meta_token(p_company uuid, p_account text) returns table(token_cipher text,
 token_expires_at timestamptz)
language plpgsql stable security definer set search_path = '' as $$
declare v_clients uuid[]; begin
 perform mavi_private.ad_require_reader(p_company);
 v_clients := mavi_private.module_scope(p_company, 'campaigns');
 return query select m.token_cipher, m.token_expires_at from mavi_private.ad_meta_accounts m
  where m.company_id = p_company and m.account_id = p_account
   and (v_clients is null or m.client_id = any(v_clients));
end $$;

-- A conexão do Google é da agência: o colaborador usa as contas vinculadas
-- às campanhas dos clientes dele (o servidor filtra por ad_google_scope).
create or replace function public.ad_google_tokens(p_company uuid) returns table(refresh_token_cipher text,
 access_token_cipher text, access_expires_at timestamptz)
language plpgsql stable security definer set search_path = '' as $$ begin
 perform mavi_private.ad_require_reader(p_company);
 return query select g.refresh_token_cipher, g.access_token_cipher, g.access_expires_at
  from mavi_private.ad_google_connections g where g.company_id = p_company;
end $$;
create or replace function public.ad_google_save_access(p_company uuid, p_access_cipher text, p_expires_at timestamptz)
returns void
language plpgsql security definer set search_path = '' as $$ begin
 perform mavi_private.ad_require_reader(p_company);
 update mavi_private.ad_google_connections set access_token_cipher = p_access_cipher,
  access_expires_at = p_expires_at, updated_at = now() where company_id = p_company;
end $$;
-- As contas do Google que a pessoa pode ver (null: líder, todas).
create or replace function public.ad_google_scope(p_company uuid) returns text[]
language plpgsql stable security definer set search_path = '' as $$
declare v_clients uuid[]; begin
 perform mavi_private.ad_require_reader(p_company);
 v_clients := mavi_private.module_scope(p_company, 'campaigns');
 if v_clients is null then return null; end if;
 return coalesce((select array_agg(distinct l.account_id) from public.ad_cycle_links l
  join public.ad_cycles y on y.company_id = l.company_id and y.id = l.cycle_id
  join public.ad_campaigns a on a.company_id = y.company_id and a.id = y.campaign_id
  join public.contracts k on k.company_id = a.company_id and k.id = a.contract_id
  where l.company_id = p_company and a.platform = 'google' and k.client_id = any(v_clients)), '{}');
end $$;
revoke all on function public.ad_google_scope(uuid) from public, anon, authenticated;
grant execute on function public.ad_google_scope(uuid) to authenticated;

-- Conectar: o Facebook de um cliente das equipes da pessoa; o Google, só
-- líderes (é da agência).
create or replace function public.ad_begin_connect(p_company uuid, p_provider text, p_client uuid default null,
 p_campaign uuid default null) returns text
language plpgsql security definer set search_path = '' as $$
declare s text := encode(extensions.gen_random_bytes(32), 'hex'); begin
 if p_provider = 'meta' then perform mavi_private.ad_require_client(p_company, p_client);
 else perform mavi_private.ad_require_admin(p_company); end if;
 if p_provider not in ('meta', 'google') then raise exception 'Plataforma inválida' using errcode = '22023'; end if;
 if p_provider = 'meta' and not exists (select 1 from public.clients where company_id = p_company and id = p_client) then
  raise exception 'Escolha o cliente da conexão do Facebook' using errcode = '22023';
 end if;
 if p_campaign is not null and not exists (select 1 from public.ad_campaigns where company_id = p_company and id = p_campaign) then
  p_campaign := null;
 end if;
 delete from mavi_private.ad_oauth_states where created_at < now() - interval '15 minutes'
  or (user_id = auth.uid() and company_id = p_company and provider = p_provider);
 insert into mavi_private.ad_oauth_states(state, company_id, user_id, provider, client_id, campaign_id)
 values (s, p_company, auth.uid(), p_provider, case when p_provider = 'meta' then p_client end, p_campaign);
 return s;
end $$;

-- A volta do Facebook (sem sessão): quem começou tem de ser líder ou, com o
-- módulo ligado, atender o cliente (a da migração 20261009090000).
create or replace function public.ad_complete_meta_connect(p_state text, p_fb_user_id text, p_fb_user_name text,
 p_token_cipher text, p_expires_at timestamptz, p_accounts jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare st mavi_private.ad_oauth_states; accounts jsonb; pending uuid; begin
 delete from mavi_private.ad_oauth_states s
 where s.state = p_state and s.provider = 'meta' and s.created_at > now() - interval '15 minutes'
 returning * into st;
 if st.state is null or st.client_id is null or not (exists (select 1 from public.memberships m
   where m.company_id = st.company_id and m.user_id = st.user_id and m.active and m.role in ('admin','manager'))
   or (mavi_private.opt_in_for(st.company_id, st.user_id, 'campaigns')
    and st.client_id = any(mavi_private.served_clients_of(st.company_id, st.user_id)))) then
  raise exception 'Conexão expirada. Tente conectar de novo.' using errcode = '42501';
 end if;
 if coalesce(p_token_cipher, '') !~ '^v1:' then raise exception 'Resposta do Facebook incompleta.' using errcode = '22023'; end if;
 select coalesce(jsonb_agg(jsonb_build_object('account_id', a ->> 'account_id', 'name', left(coalesce(a ->> 'name', ''), 200),
   'currency', left(coalesce(a ->> 'currency', ''), 10),
   'account_status', case when coalesce(a ->> 'account_status', '') ~ '^[0-9]{1,4}$' then (a ->> 'account_status')::integer end)),
  '[]') into accounts
 from jsonb_array_elements(case when jsonb_typeof(p_accounts) = 'array' then p_accounts else '[]' end) a
 where coalesce(a ->> 'account_id', '') ~ '^[0-9]{1,30}$';
 if jsonb_array_length(accounts) = 0 then return null; end if;
 delete from mavi_private.ad_meta_pending where created_at < now() - interval '1 hour'
  or (company_id = st.company_id and user_id = st.user_id);
 insert into mavi_private.ad_meta_pending(company_id, client_id, campaign_id, user_id, fb_user_id, fb_user_name,
  token_cipher, token_expires_at, accounts)
 values (st.company_id, st.client_id, st.campaign_id, st.user_id, left(coalesce(p_fb_user_id, ''), 40),
  left(coalesce(p_fb_user_name, ''), 200), p_token_cipher, p_expires_at, accounts)
 returning id into pending;
 return jsonb_build_object('pending', pending, 'campaign', st.campaign_id);
end $$;

-- O que o seletor mostra; para quem não é líder, o outro cliente de uma
-- conta aparece sem o nome.
create or replace function public.ad_meta_pending(p_pending uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare p mavi_private.ad_meta_pending; v_leader boolean; begin
 select * into p from mavi_private.ad_meta_pending where id = p_pending and created_at > now() - interval '1 hour';
 if not found then raise exception 'A conexão expirou. Conecte de novo.' using errcode = '22023'; end if;
 perform mavi_private.ad_require_client(p.company_id, p.client_id);
 v_leader := mavi_private.leader(p.company_id);
 return jsonb_build_object(
  'id', p.id, 'client_id', p.client_id, 'campaign_id', p.campaign_id,
  'client', (select name from public.clients where company_id = p.company_id and id = p.client_id),
  'profile', p.fb_user_name, 'expires_at', p.token_expires_at,
  'accounts', (select coalesce(jsonb_agg(a || jsonb_build_object(
    'client_id', m.client_id,
    'client', case when v_leader or m.client_id = p.client_id or m.client_id = any(mavi_private.served_clients(p.company_id))
      then (select name from public.clients c where c.company_id = p.company_id and c.id = m.client_id)
      when m.client_id is not null then 'outro cliente' end)
    order by a ->> 'name'), '[]')
   from jsonb_array_elements(p.accounts) a
   left join mavi_private.ad_meta_accounts m on m.company_id = p.company_id and m.account_id = a ->> 'account_id'));
end $$;

create or replace function public.ad_confirm_meta_accounts(p_pending uuid, p_accounts text[]) returns integer
language plpgsql security definer set search_path = '' as $$
declare p mavi_private.ad_meta_pending; a jsonb; n integer := 0; other text; begin
 select * into p from mavi_private.ad_meta_pending where id = p_pending and created_at > now() - interval '1 hour'
  for update;
 if not found then raise exception 'A conexão expirou. Conecte de novo.' using errcode = '22023'; end if;
 perform mavi_private.ad_require_client(p.company_id, p.client_id);
 if coalesce(array_length(p_accounts, 1), 0) = 0 then
  raise exception 'Marque ao menos uma conta do cliente' using errcode = '22023';
 end if;
 for a in select * from jsonb_array_elements(p.accounts) where value ->> 'account_id' = any(p_accounts) loop
  select case when mavi_private.leader(p.company_id) or c.id = any(mavi_private.served_clients(p.company_id))
    then c.name else 'outro cliente' end into other from mavi_private.ad_meta_accounts m
   join public.clients c on c.company_id = m.company_id and c.id = m.client_id
   where m.company_id = p.company_id and m.account_id = a ->> 'account_id' and m.client_id <> p.client_id;
  if other is not null then
   raise exception 'A conta % já é do cliente %', a ->> 'account_id', other using errcode = '23505';
  end if;
  insert into mavi_private.ad_meta_accounts(company_id, account_id, name, currency, account_status, fb_user_id,
   fb_user_name, token_cipher, token_expires_at, connected_by, client_id)
  values (p.company_id, a ->> 'account_id', coalesce(a ->> 'name', ''), coalesce(a ->> 'currency', ''),
   (a ->> 'account_status')::integer, p.fb_user_id, p.fb_user_name, p.token_cipher, p.token_expires_at, p.user_id,
   p.client_id)
  on conflict (company_id, account_id) do update set name = excluded.name, currency = excluded.currency,
   account_status = excluded.account_status, fb_user_id = excluded.fb_user_id, fb_user_name = excluded.fb_user_name,
   token_cipher = excluded.token_cipher, token_expires_at = excluded.token_expires_at,
   connected_by = excluded.connected_by, client_id = excluded.client_id, updated_at = now();
  n := n + 1;
 end loop;
 if n = 0 then raise exception 'Nenhuma das contas marcadas veio desta conexão' using errcode = '22023'; end if;
 delete from mavi_private.ad_meta_pending where id = p.id;
 return n;
end $$;

create or replace function public.ad_meta_clients(p_company uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_clients uuid[]; begin
 perform mavi_private.ad_require_reader(p_company);
 v_clients := mavi_private.module_scope(p_company, 'campaigns');
 return (with clients as (
   select distinct k.client_id from public.ad_campaigns a
   join public.contracts k on k.company_id = a.company_id and k.id = a.contract_id
   where a.company_id = p_company and a.platform = 'meta' and a.status = 'active' and not a.archived
   union
   select m.client_id from mavi_private.ad_meta_accounts m where m.company_id = p_company and m.client_id is not null
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'client_id', c.id, 'client', c.name,
    'campaigns', (select count(*) from public.ad_campaigns a
      join public.contracts k on k.company_id = a.company_id and k.id = a.contract_id
      where a.company_id = p_company and k.client_id = c.id and a.platform = 'meta' and a.status = 'active'
       and not a.archived),
    'expires_at', (select min(m.token_expires_at) from mavi_private.ad_meta_accounts m
      where m.company_id = p_company and m.client_id = c.id),
    'accounts', (select coalesce(jsonb_agg(jsonb_build_object('account_id', m.account_id, 'name', m.name,
       'profile', m.fb_user_name, 'expires_at', m.token_expires_at, 'account_status', m.account_status)
       order by m.name), '[]')
      from mavi_private.ad_meta_accounts m where m.company_id = p_company and m.client_id = c.id))
   order by c.name), '[]')
  from clients x join public.clients c on c.company_id = p_company and c.id = x.client_id
  where v_clients is null or c.id = any(v_clients));
end $$;

create or replace function public.ad_disconnect_meta_client(p_company uuid, p_client uuid) returns integer
language plpgsql security definer set search_path = '' as $$
declare n integer; begin
 perform mavi_private.ad_require_client(p_company, p_client);
 delete from mavi_private.ad_meta_accounts where company_id = p_company and client_id = p_client;
 get diagnostics n = row_count;
 return n;
end $$;

-- ---- formulários de lead (os da migração 20261010090000)
create or replace function public.ad_save_lead_form(p_company uuid, p_client uuid, p_page_id text, p_page_name text,
 p_page_token_cipher text, p_form_id text, p_form_name text, p_landing_page text, p_make_user text)
returns public.ad_lead_forms
language plpgsql security definer set search_path = '' as $$
declare result public.ad_lead_forms; v_owner uuid; begin
 if mavi_private.leader(p_company) then null;
 else
  -- Quem não é líder liga o formulário a um cliente seu, e não tira de outro.
  perform mavi_private.ad_require_client(p_company, p_client);
  select client_id into v_owner from public.ad_lead_forms where company_id = p_company and form_id = p_form_id;
  if found and v_owner is distinct from p_client then
   raise exception 'Este formulário já está ligado a outro cliente.' using errcode = '42501';
  end if;
 end if;
 if p_client is not null and not exists (select 1 from public.clients where company_id = p_company and id = p_client) then
  raise exception 'Cliente inválido' using errcode = '22023';
 end if;
 if coalesce(p_page_id, '') !~ '^[0-9]{1,30}$' then raise exception 'Página do Facebook inválida' using errcode = '22023'; end if;
 if coalesce(p_form_id, '') !~ '^[0-9]{1,30}$' then raise exception 'Formulário do Facebook inválido' using errcode = '22023'; end if;
 if coalesce(trim(p_landing_page), '') !~ '^[0-9A-Za-z_-]{1,60}$' then
  raise exception 'Escolha a página de captura da Make' using errcode = '22023';
 end if;
 if coalesce(trim(p_make_user), '') !~ '^[0-9]{1,20}$' then
  raise exception 'Informe o ID do cliente na Make (números)' using errcode = '22023';
 end if;
 if coalesce(p_page_token_cipher, '') !~ '^v1:' then raise exception 'Acesso à página ausente' using errcode = '22023'; end if;
 insert into mavi_private.ad_meta_pages(company_id, page_id, name, token_cipher, connected_by)
 values (p_company, p_page_id, left(coalesce(p_page_name, ''), 200), p_page_token_cipher, auth.uid())
 on conflict (company_id, page_id) do update set name = case when excluded.name <> '' then excluded.name
  else ad_meta_pages.name end, token_cipher = excluded.token_cipher, connected_by = excluded.connected_by,
  updated_at = now();
 insert into public.ad_lead_forms(company_id, client_id, page_id, page_name, form_id, form_name, landing_page_id,
  make_user_id, created_by)
 values (p_company, p_client, p_page_id, left(coalesce(p_page_name, ''), 200), p_form_id, left(coalesce(p_form_name, ''), 300),
  trim(p_landing_page), trim(p_make_user), auth.uid())
 on conflict (company_id, form_id) do update set client_id = coalesce(excluded.client_id, ad_lead_forms.client_id),
  page_id = excluded.page_id, page_name = case when excluded.page_name <> '' then excluded.page_name else ad_lead_forms.page_name end,
  form_name = case when excluded.form_name <> '' then excluded.form_name else ad_lead_forms.form_name end,
  landing_page_id = excluded.landing_page_id, make_user_id = excluded.make_user_id, updated_at = now()
 returning * into result;
 return result;
end $$;

create or replace function public.ad_delete_lead_form(p_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare f public.ad_lead_forms; begin
 select * into f from public.ad_lead_forms where id = p_id;
 if not found then raise exception 'Formulário não encontrado' using errcode = '42501'; end if;
 perform mavi_private.ad_require_client(f.company_id, f.client_id);
 delete from public.ad_lead_forms where id = p_id;
end $$;

create or replace function public.ad_lead_forms_overview(p_company uuid, p_client uuid default null) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare result jsonb; v_clients uuid[]; begin
 perform mavi_private.ad_require_reader(p_company);
 v_clients := mavi_private.module_scope(p_company, 'campaigns');
 select coalesce(jsonb_agg(jsonb_build_object('id', f.id, 'client_id', f.client_id,
   'client', (select c.name from public.clients c where c.company_id = f.company_id and c.id = f.client_id),
   'page_id', f.page_id, 'page_name', f.page_name, 'form_id', f.form_id, 'form_name', f.form_name,
   'landing_page_id', f.landing_page_id, 'make_user_id', f.make_user_id, 'source', f.source,
   'updated_at', f.updated_at,
   'last_lead_at', (select max(d.created_at) from public.ad_lead_deliveries d where d.lead_form_id = f.id
     and d.status in ('sent','duplicate')),
   'sent_30d', (select count(*) from public.ad_lead_deliveries d where d.lead_form_id = f.id
     and d.status in ('sent','duplicate') and d.created_at > now() - interval '30 days'),
   'last_error', (select jsonb_build_object('at', d.updated_at, 'message', d.message)
     from public.ad_lead_deliveries d where d.lead_form_id = f.id and d.status = 'error'
     order by d.updated_at desc limit 1))
  order by f.updated_at desc), '[]') into result
 from public.ad_lead_forms f
 where f.company_id = p_company and (p_client is null or f.client_id = p_client)
  and (v_clients is null or f.client_id = any(v_clients));
 return result;
end $$;

-- ------------------------------------------------------------ Radar
-- Quem trabalha no Radar pelo módulo: líder, ou colaborador com o módulo
-- ligado (para uma pessoa qualquer: a agenda e o worker não têm sessão).
create or replace function mavi_private.leader_of(c uuid, u uuid) returns boolean
language sql stable security definer set search_path = '' as $$
 select exists (select 1 from public.memberships m where m.company_id = c and m.user_id = u and m.active
  and m.role in ('admin', 'manager'))
$$;
revoke all on function mavi_private.leader_of(uuid, uuid) from public, anon, authenticated;


-- O item: edita o líder ou o colaborador com o módulo ligado no cliente (a
-- da migração 20261230090000).
create or replace function public.radar_item(p_company uuid, p_item uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare i public.radar_items; t public.radar_topics; v_leader boolean; v_edit boolean; begin
 select * into i from public.radar_items where company_id = p_company and id = p_item;
 if not found or not mavi_private.dossier_reader(p_company, i.client_id) then
  raise exception 'Item não encontrado.' using errcode = 'P0002';
 end if;
 select * into t from public.radar_topics where id = i.topic_id;
 v_leader := mavi_private.leader(p_company);
 v_edit := mavi_private.module_client(p_company, 'radar', i.client_id);
 return mavi_private.radar_item_json(i) || jsonb_build_object(
  'topic', mavi_private.radar_topic_json(t),
  'can_edit', v_edit,
  'client_products', coalesce((select jsonb_agg(jsonb_build_object('id', p.id, 'name', p.name) order by p.name)
    from public.products p where p.company_id = p_company and p.id in (select k.product_id from public.contracts k
     where k.company_id = p_company and k.client_id = i.client_id and not k.archived)), '[]'),
  'occurrences', coalesce((select jsonb_agg(jsonb_build_object('id', m.id, 'source_type', m.source_type,
     'source_id', m.source_id, 'group_id', m.group_id, 'message_id', m.message_id, 'at_seconds', m.at_seconds,
     'quote', m.quote, 'speaker', m.speaker, 'role', m.role, 'occurred_at', m.occurred_at, 'title', s.title)
    order by m.occurred_at desc)
   from (select * from public.radar_mentions m where m.item_id = i.id order by m.occurred_at desc limit 100) m
   left join public.radar_signals s on s.id = m.signal_id), '[]'),
  'theme_options', case when v_edit then coalesce((select jsonb_agg(jsonb_build_object('id', th.id, 'title', th.title)
     order by th.title)
    from (select * from public.radar_themes th where th.company_id = p_company and th.topic_id = i.topic_id
      and th.product_id is not distinct from i.product_id order by th.updated_at desc limit 200) th), '[]')
   else '[]'::jsonb end,
  'tasks', coalesce((select jsonb_agg(jsonb_build_object('id', tk.id, 'title', tk.title, 'status', tk.status,
     'due_date', tk.due_date, 'assignee_name', mm.name) order by rt.created_at desc)
    from public.radar_item_tasks rt
    join public.tasks tk on tk.id = rt.task_id and not tk.archived
    left join public.memberships mm on mm.company_id = tk.company_id and mm.user_id = tk.assignee_id
    where rt.item_id = i.id and (v_leader or mavi_private.task_access(p_company, tk.id))), '[]'));
end $$;

create or replace function public.update_radar_item(p_company uuid, p_item uuid, p_patch jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare i public.radar_items; t public.radar_topics; v jsonb := coalesce(p_patch, '{}'); v_prod uuid; begin
 select * into i from public.radar_items where company_id = p_company and id = p_item for update;
 if not found then raise exception 'Item não encontrado.' using errcode = 'P0002'; end if;
 if not mavi_private.module_client(p_company, 'radar', i.client_id) then
  raise exception 'Sem permissão' using errcode = '42501';
 end if;
 select * into t from public.radar_topics where id = i.topic_id;
 if v ? 'status' and mavi_private.radar_status(t.statuses, v->>'status') is null then
  raise exception 'Status inválido.' using errcode = '22023';
 end if;
 if v ? 'assignee_id' and v->>'assignee_id' is not null and not exists (select 1 from public.memberships m
  where m.company_id = p_company and m.user_id::text = v->>'assignee_id' and m.active) then
  raise exception 'Responsável não encontrado.' using errcode = 'P0002';
 end if;
 if v ? 'product_id' and v->>'product_id' is not null then
  v_prod := (v->>'product_id')::uuid;
  if not exists (select 1 from public.contracts k where k.company_id = p_company and k.client_id = i.client_id
   and k.product_id = v_prod and not k.archived) then
   raise exception 'O cliente não contrata este produto.' using errcode = '22023';
  end if;
 end if;
 if v ? 'title' and length(btrim(coalesce(v->>'title', ''))) not between 3 and 200 then
  raise exception 'O título tem de 3 a 200 caracteres.' using errcode = '22023';
 end if;
 if v ? 'severity' and v->>'severity' is not null and (v->>'severity')::integer not between 0 and 3 then
  raise exception 'Gravidade inválida.' using errcode = '22023';
 end if;
 update public.radar_items set
  status = case when v ? 'status' then v->>'status' else status end,
  status_at = case when v ? 'status' and v->>'status' <> status then now() else status_at end,
  status_by = case when v ? 'status' and v->>'status' <> status then auth.uid() else status_by end,
  assignee_id = case when v ? 'assignee_id' then (v->>'assignee_id')::uuid else assignee_id end,
  severity = case when v ? 'severity' then (v->>'severity')::smallint else severity end,
  severity_person = severity_person or v ? 'severity',
  due_date = case when v ? 'due_date' then (v->>'due_date')::date else due_date end,
  product_id = case when v ? 'product_id' then v_prod else product_id end,
  theme_id = case when v ? 'product_id' and v_prod is distinct from product_id then null else theme_id end,
  theme_locked = case when v ? 'product_id' and v_prod is distinct from product_id then false else theme_locked end,
  theme_pending = case when v ? 'product_id' and v_prod is distinct from product_id then true else theme_pending end,
  theme_attempts = case when v ? 'product_id' and v_prod is distinct from product_id then 0 else theme_attempts end,
  title = case when v ? 'title' then btrim(v->>'title') else title end,
  summary = case when v ? 'summary' then left(btrim(coalesce(v->>'summary', '')), 1500) else summary end,
  person_edited = person_edited or v ?| array['title', 'summary', 'product_id'],
  fields = case when jsonb_typeof(v->'fields') = 'object' then (select coalesce(jsonb_object_agg(f->>'key',
     left(v->'fields'->>(f->>'key'), 300)), '{}') from jsonb_array_elements(t.fields) f
     where nullif(btrim(coalesce(v->'fields'->>(f->>'key'), '')), '') is not null) else fields end,
  updated_at = now()
 where id = i.id;
 return public.radar_item(p_company, p_item);
end $$;

create or replace function public.set_radar_item_theme(p_company uuid, p_item uuid, p_theme uuid, p_title text default null,
 p_auto boolean default false) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare i public.radar_items; v_theme uuid := p_theme; begin
 select * into i from public.radar_items where company_id = p_company and id = p_item for update;
 if not found then raise exception 'Item não encontrado.' using errcode = 'P0002'; end if;
 if not mavi_private.module_client(p_company, 'radar', i.client_id) then
  raise exception 'Sem permissão' using errcode = '42501';
 end if;
 if coalesce(p_auto, false) then
  update public.radar_items set theme_id = null, theme_locked = false, theme_pending = true, theme_attempts = 0,
   theme_claimed_until = null, updated_at = now() where id = i.id;
  return public.radar_item(p_company, p_item);
 end if;
 if nullif(btrim(coalesce(p_title, '')), '') is not null then
  if length(btrim(p_title)) not between 3 and 160 then
   raise exception 'O nome do tema tem de 3 a 160 caracteres.' using errcode = '22023';
  end if;
  insert into public.radar_themes(company_id, topic_id, product_id, title, person_edited, created_by)
  values (p_company, i.topic_id, i.product_id, btrim(p_title), true, auth.uid()) returning id into v_theme;
 elsif v_theme is not null and not exists (select 1 from public.radar_themes th where th.id = v_theme
   and th.company_id = p_company and th.topic_id = i.topic_id and th.product_id is not distinct from i.product_id) then
  raise exception 'O tema precisa ser do mesmo tópico e produto do item.' using errcode = '22023';
 end if;
 update public.radar_items set theme_id = v_theme, theme_locked = true, theme_pending = false,
  theme_claimed_until = null, updated_at = now()
 where id = i.id;
 if v_theme is not null then update public.radar_themes set updated_at = now() where id = v_theme; end if;
 return public.radar_item(p_company, p_item);
end $$;

create or replace function public.link_radar_task(p_company uuid, p_item uuid, p_task uuid) returns void
language plpgsql security definer set search_path = '' as $$ begin
 if not mavi_private.module_client(p_company, 'radar',
   (select client_id from public.radar_items where company_id = p_company and id = p_item)) then
  raise exception 'Sem permissão' using errcode = '42501';
 end if;
 if not exists (select 1 from public.radar_items where company_id = p_company and id = p_item) then
  raise exception 'Item não encontrado.' using errcode = 'P0002';
 end if;
 if not exists (select 1 from public.tasks where company_id = p_company and id = p_task) then
  raise exception 'Tarefa não encontrada.' using errcode = 'P0002';
 end if;
 if not mavi_private.leader(p_company) and not mavi_private.task_access(p_company, p_task) then
  raise exception 'Tarefa não encontrada.' using errcode = 'P0002';
 end if;
 insert into public.radar_item_tasks(company_id, item_id, task_id, created_by)
 values (p_company, p_item, p_task, auth.uid()) on conflict do nothing;
end $$;

-- Temas: quem não é líder vê os temas com itens dos clientes dele, contados
-- só nesses itens.
create or replace function public.radar_themes(p_company uuid, p_filters jsonb) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare f jsonb := coalesce(p_filters, '{}'); v_topic uuid; v_q text; v_open boolean; v_days integer;
 v_limit integer; v_offset integer; v_out jsonb; v_clients uuid[]; begin
 v_clients := mavi_private.module_scope(p_company, 'radar');
 v_topic := case when f->>'topic' ~* '^[0-9a-f-]{36}$' then (f->>'topic')::uuid end;
 if v_topic is null then raise exception 'Escolha o tópico.' using errcode = '22023'; end if;
 v_q := nullif(btrim(coalesce(f->>'q', '')), '');
 v_open := coalesce((f->>'open_only')::boolean, true);
 v_days := case when jsonb_typeof(f->'days') = 'number' then (f->>'days')::integer end;
 v_limit := least(greatest(coalesce((f->>'limit')::integer, 50), 1), 200);
 v_offset := greatest(coalesce((f->>'offset')::integer, 0), 0);
 with agg as (
  select th.id, count(*)::integer as items,
   count(*) filter (where coalesce(mavi_private.radar_status(t.statuses, i.status)->>'kind', '') <> 'closed')::integer
    as open_items,
   count(distinct i.client_id)::integer as clients, sum(i.mentions)::integer as mentions,
   max(i.last_seen_at) as last_seen_at, max(i.severity) as max_severity,
   (array_agg(distinct k.name))[1:6] as client_names
  from public.radar_themes th
  join public.radar_topics t on t.id = th.topic_id
  join public.radar_items i on i.theme_id = th.id and (v_clients is null or i.client_id = any(v_clients))
  join public.clients k on k.id = i.client_id and not k.archived
  where th.company_id = p_company and th.topic_id = v_topic
   and (coalesce(f->>'product', '') = '' or (f->>'product' = 'none' and th.product_id is null)
    or (f->>'product' ~* '^[0-9a-f-]{36}$' and th.product_id = (f->>'product')::uuid))
   and (v_q is null or th.title ilike '%' || v_q || '%' or th.summary ilike '%' || v_q || '%')
   and (v_days is null or v_days <= 0 or i.last_seen_at > now() - make_interval(days => v_days))
  group by th.id
 ), page as (
  select a.*, count(*) over () as total from agg a
  where not v_open or a.open_items > 0
  order by
   case when coalesce(f->>'sort', 'clients') = 'clients' then a.clients end desc,
   case when coalesce(f->>'sort', 'clients') = 'clients' then a.items end desc,
   case when f->>'sort' = 'items' then a.items end desc,
   case when f->>'sort' = 'mentions' then a.mentions end desc,
   a.last_seen_at desc, a.id
  limit v_limit offset v_offset
 )
 select jsonb_build_object('total', coalesce(max(p.total), 0),
  'themes', coalesce(jsonb_agg(jsonb_build_object('id', th.id, 'topic_id', th.topic_id, 'product_id', th.product_id,
    'product_name', pr.name, 'title', th.title, 'summary', th.summary, 'person_edited', th.person_edited,
    'items', p.items, 'open_items', p.open_items, 'clients', p.clients, 'mentions', p.mentions,
    'last_seen_at', p.last_seen_at, 'max_severity', p.max_severity, 'client_names', to_jsonb(p.client_names))
   order by case when coalesce(f->>'sort', 'clients') = 'clients' then p.clients end desc,
    case when coalesce(f->>'sort', 'clients') = 'clients' then p.items end desc,
    case when f->>'sort' = 'items' then p.items end desc,
    case when f->>'sort' = 'mentions' then p.mentions end desc,
    p.last_seen_at desc, p.id), '[]'),
  'pending', (select count(*) from public.radar_items i where i.company_id = p_company and i.topic_id = v_topic
    and i.theme_pending and (v_clients is null or i.client_id = any(v_clients))),
  'without', (select count(*) from public.radar_items i where i.company_id = p_company and i.topic_id = v_topic
    and i.theme_id is null and not i.theme_pending and (v_clients is null or i.client_id = any(v_clients))))
 into v_out
 from page p
 join public.radar_themes th on th.id = p.id
 left join public.products pr on pr.company_id = th.company_id and pr.id = th.product_id;
 return v_out;
end $$;

create or replace function public.radar_theme(p_company uuid, p_theme uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare th public.radar_themes; v_clients uuid[]; begin
 v_clients := mavi_private.module_scope(p_company, 'radar');
 select * into th from public.radar_themes where company_id = p_company and id = p_theme;
 if not found or (v_clients is not null and not exists (select 1 from public.radar_items i
   where i.theme_id = th.id and i.client_id = any(v_clients))) then
  raise exception 'Tema não encontrado.' using errcode = 'P0002';
 end if;
 return jsonb_build_object('id', th.id, 'topic_id', th.topic_id, 'product_id', th.product_id,
  'product_name', (select name from public.products where id = th.product_id),
  'title', th.title, 'summary', th.summary, 'person_edited', th.person_edited, 'created_at', th.created_at,
  'topic', (select mavi_private.radar_topic_json(t) from public.radar_topics t where t.id = th.topic_id),
  'items', coalesce((select jsonb_agg(mavi_private.radar_item_json(i) order by i.last_seen_at desc)
    from public.radar_items i where i.theme_id = th.id and (v_clients is null or i.client_id = any(v_clients))), '[]'),
  -- Renomear ou juntar mexe nos outros clientes: só quando o tema é todo seu.
  'can_edit', v_clients is null or not exists (select 1 from public.radar_items i where i.theme_id = th.id
    and not i.client_id = any(v_clients)),
  'others', coalesce((select jsonb_agg(jsonb_build_object('id', o.id, 'title', o.title) order by o.title)
    from (select * from public.radar_themes o where o.company_id = p_company and o.topic_id = th.topic_id
      and o.product_id is not distinct from th.product_id and o.id <> th.id order by o.updated_at desc limit 200) o), '[]'));
end $$;

-- Um tema é de vários clientes: quem não é líder só o renomeia ou junta
-- quando todos os itens dele são de clientes seus.
create or replace function mavi_private.radar_theme_all_mine(c uuid, p_theme uuid) returns void
language plpgsql stable security definer set search_path = '' as $$
declare v_clients uuid[] := mavi_private.module_scope(c, 'radar'); begin
 if v_clients is not null and (not exists (select 1 from public.radar_items i where i.theme_id = p_theme
    and i.client_id = any(v_clients))
   or exists (select 1 from public.radar_items i where i.theme_id = p_theme and not i.client_id = any(v_clients))) then
  raise exception 'Este tema tem itens de clientes que não são das suas equipes.' using errcode = '42501';
 end if;
end $$;
revoke all on function mavi_private.radar_theme_all_mine(uuid, uuid) from public, anon, authenticated;
create or replace function public.update_radar_theme(p_company uuid, p_theme uuid, p_title text, p_summary text) returns jsonb
language plpgsql security definer set search_path = '' as $$ begin
 perform mavi_private.radar_theme_all_mine(p_company, p_theme);
 if length(btrim(coalesce(p_title, ''))) not between 3 and 160 then
  raise exception 'O nome do tema tem de 3 a 160 caracteres.' using errcode = '22023';
 end if;
 update public.radar_themes set title = btrim(p_title), summary = left(btrim(coalesce(p_summary, '')), 1000),
  person_edited = true, updated_at = now()
 where company_id = p_company and id = p_theme;
 if not found then raise exception 'Tema não encontrado.' using errcode = 'P0002'; end if;
 return public.radar_theme(p_company, p_theme);
end $$;

create or replace function public.merge_radar_themes(p_company uuid, p_target uuid, p_sources uuid[]) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare th public.radar_themes; v_src uuid; begin
 perform mavi_private.radar_theme_all_mine(p_company, p_target);
 foreach v_src in array coalesce(p_sources, '{}') loop
  perform mavi_private.radar_theme_all_mine(p_company, v_src);
 end loop;
 select * into th from public.radar_themes where company_id = p_company and id = p_target;
 if not found then raise exception 'Tema não encontrado.' using errcode = 'P0002'; end if;
 if exists (select 1 from unnest(coalesce(p_sources, '{}')) s where s <> p_target and not exists (
   select 1 from public.radar_themes o where o.id = s and o.company_id = p_company and o.topic_id = th.topic_id
    and o.product_id is not distinct from th.product_id)) then
  raise exception 'Só dá para juntar temas do mesmo tópico e produto.' using errcode = '22023';
 end if;
 update public.radar_items set theme_id = p_target, updated_at = now()
 where company_id = p_company and theme_id = any(p_sources) and theme_id <> p_target;
 delete from public.radar_themes where company_id = p_company and id = any(p_sources) and id <> p_target;
 update public.radar_themes set updated_at = now() where id = p_target;
 return public.radar_theme(p_company, p_target);
end $$;

create or replace function public.radar_theme_options(p_company uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_clients uuid[]; begin
 -- Também para quem monta dashboards (os temas dos clientes dele).
 if mavi_private.leader(p_company) then v_clients := null;
 elsif mavi_private.opt_in_on(p_company, 'radar') or mavi_private.opt_in_on(p_company, 'dashboards') then
  v_clients := mavi_private.served_clients(p_company);
 else raise exception 'Sem permissão' using errcode = '42501'; end if;
 return jsonb_build_object(
  'topics', coalesce((select jsonb_agg(jsonb_build_object('id', t.id, 'name', t.name) order by t.position, t.name)
    from public.radar_topics t where t.company_id = p_company), '[]'),
  'themes', coalesce((select jsonb_agg(jsonb_build_object('id', th.id, 'title', th.title, 'topic', t.name,
     'product', p.name) order by th.title)
    from (select * from public.radar_themes th where th.company_id = p_company and (v_clients is null or exists (
      select 1 from public.radar_items i where i.theme_id = th.id and i.client_id = any(v_clients)))
     order by th.updated_at desc limit 500) th
    join public.radar_topics t on t.id = th.topic_id
    left join public.products p on p.id = th.product_id), '[]'));
end $$;

-- Relatórios: quem não é líder vê e refaz os seus, e o material fica só nos
-- clientes das equipes de quem pediu (calculado quando o worker pega).
drop function mavi_private.radar_report_material(uuid, date, date, jsonb);
create or replace function mavi_private.radar_report_material(c uuid, p_from date, p_to date, p_filters jsonb, p_scope uuid[] default null) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare f jsonb := mavi_private.radar_report_filters(c, p_filters); v_tz text; v_start timestamptz; v_end timestamptz;
 v_today date; v_topics uuid[]; v_products uuid[]; v_none boolean; v_teams uuid[]; v_clients uuid[]; v_out jsonb; begin
 select timezone into v_tz from public.companies where id = c;
 v_tz := coalesce(v_tz, 'America/Sao_Paulo');
 v_start := p_from::timestamp at time zone v_tz;
 v_end := (p_to + 1)::timestamp at time zone v_tz;
 v_today := (now() at time zone v_tz)::date;
 v_topics := array(select x::uuid from jsonb_array_elements_text(f->'topics') x);
 v_products := array(select x::uuid from jsonb_array_elements_text(f->'products') x where x <> 'none');
 v_none := f->'products' ? 'none';
 v_teams := array(select x::uuid from jsonb_array_elements_text(f->'teams') x);
 v_clients := array(select x::uuid from jsonb_array_elements_text(f->'clients') x);
 with it as materialized (
  select i.id, i.topic_id, i.product_id, i.client_id, i.theme_id, i.title, i.summary, i.severity, i.due_date,
   i.mentions, i.created_at, i.last_seen_at, i.status_at, i.assignee_id, t.name as topic_name, t.position as topic_pos,
   t.has_due, coalesce(mavi_private.radar_status(t.statuses, i.status)->>'kind', '') as kind,
   coalesce(mavi_private.radar_status(t.statuses, i.status)->>'label', i.status) as status_label,
   coalesce(p.name, 'Geral / Agência') as product_name, k.name as client_name,
   i.created_at >= v_start and i.created_at < v_end as is_new
  from public.radar_items i
  join public.radar_topics t on t.id = i.topic_id
  join public.clients k on k.id = i.client_id and not k.archived
  left join public.products p on p.id = i.product_id
  where i.company_id = c
   and (cardinality(v_topics) = 0 or i.topic_id = any(v_topics))
   and ((cardinality(v_products) = 0 and not v_none) or i.product_id = any(v_products) or (v_none and i.product_id is null))
   and (cardinality(v_teams) = 0 or exists (select 1 from public.client_teams ct where ct.company_id = c
    and ct.client_id = i.client_id and ct.team_id = any(v_teams)))
   and (cardinality(v_clients) = 0 or i.client_id = any(v_clients))
   and (p_scope is null or i.client_id = any(p_scope))
 ), mp as materialized (
  select m.item_id, count(*)::integer as n, max(m.occurred_at) as last_at
  from public.radar_mentions m join it on it.id = m.item_id
  where m.occurred_at >= v_start and m.occurred_at < v_end
  group by m.item_id
 ), x as materialized (
  select it.*, coalesce(mp.n, 0) as period_mentions, it.is_new or mp.n is not null as active
  from it left join mp on mp.item_id = it.id
 )
 select jsonb_build_object(
  'period', jsonb_build_object('from', p_from, 'to', p_to),
  'today', v_today,
  'company', (select name from public.companies where id = c),
  'filters', mavi_private.radar_report_labels(c, f),
  'topics', coalesce((select jsonb_agg(jsonb_build_object('topic', q.topic_name, 'has_due', q.has_due,
     'new', q.new, 'active', q.active, 'open', q.open, 'closed', q.closed, 'severe', q.severe,
     'overdue', q.overdue, 'mentions', q.mentions, 'clients', q.clients) order by q.pos, q.topic_name)
    from (select x.topic_id, min(x.topic_name) as topic_name, min(x.topic_pos) as pos, bool_or(x.has_due) as has_due,
      count(*) filter (where x.is_new) as new, count(*) filter (where x.active) as active,
      count(*) filter (where x.kind <> 'closed') as open,
      count(*) filter (where x.kind = 'closed' and x.status_at >= v_start and x.status_at < v_end) as closed,
      count(*) filter (where x.kind <> 'closed' and x.severity >= 2) as severe,
      count(*) filter (where x.has_due and x.kind <> 'closed' and x.due_date < v_today) as overdue,
      sum(x.period_mentions) as mentions, count(distinct x.client_id) filter (where x.active) as clients
     from x group by x.topic_id) q), '[]'),
  'products', coalesce((select jsonb_agg(jsonb_build_object('product', pq.product_name, 'clients', pq.clients,
     'topics', pq.topics) order by pq.weight desc, pq.product_name)
    from (select tq.product_name, sum(tq.new + tq.open) as weight,
      (select count(distinct x2.client_id) from x x2 where x2.product_name = tq.product_name and x2.active) as clients,
      jsonb_agg(jsonb_build_object('topic', tq.topic_name, 'new', tq.new, 'open', tq.open, 'severe', tq.severe,
       'overdue', tq.overdue, 'closed', tq.closed) order by tq.pos) as topics
     from (select x.product_name, x.topic_id, min(x.topic_name) as topic_name, min(x.topic_pos) as pos,
       count(*) filter (where x.is_new) as new, count(*) filter (where x.kind <> 'closed') as open,
       count(*) filter (where x.kind <> 'closed' and x.severity >= 2) as severe,
       count(*) filter (where x.has_due and x.kind <> 'closed' and x.due_date < v_today) as overdue,
       count(*) filter (where x.kind = 'closed' and x.status_at >= v_start and x.status_at < v_end) as closed
      from x group by x.product_name, x.topic_id) tq
     group by tq.product_name) pq), '[]'),
  'themes', coalesce((select jsonb_agg(jsonb_build_object('title', th.title, 'summary', th.summary,
     'topic', tq.topic_name, 'product', tq.product_name, 'clients', tq.clients, 'items', tq.items, 'open', tq.open,
     'mentions', tq.mentions, 'max_severity', tq.max_severity, 'client_names', to_jsonb(tq.client_names),
     'quotes', coalesce((select jsonb_agg(q.quote) from (select m.quote from public.radar_mentions m
        join x on x.id = m.item_id where x.theme_id = th.id and m.occurred_at >= v_start and m.occurred_at < v_end
        order by m.occurred_at desc limit 2) q), '[]'))
    order by tq.clients desc, tq.mentions desc)
    from (select x.theme_id, min(x.topic_name) as topic_name, min(x.product_name) as product_name,
      count(distinct x.client_id) as clients, count(*) as items, count(*) filter (where x.kind <> 'closed') as open,
      sum(x.period_mentions) as mentions, max(x.severity) as max_severity,
      (array_agg(distinct x.client_name))[1:6] as client_names
     from x where x.theme_id is not null group by x.theme_id
     having bool_or(x.active)
     order by count(distinct x.client_id) desc, sum(x.period_mentions) desc limit 20) tq
    join public.radar_themes th on th.id = tq.theme_id), '[]'),
  'severe', coalesce((select jsonb_agg(jsonb_build_object('topic', s.topic_name, 'product', s.product_name,
     'client', s.client_name, 'title', s.title, 'summary', left(s.summary, 300), 'severity', s.severity,
     'status', s.status_label, 'mentions', s.mentions, 'last_seen', s.last_seen_at::date)
    order by s.severity desc, s.last_seen_at desc)
    from (select * from x where x.kind <> 'closed' and x.severity >= 2
     order by x.severity desc, x.last_seen_at desc limit 15) s), '[]'),
  'overdue', coalesce((select jsonb_agg(jsonb_build_object('topic', o.topic_name, 'product', o.product_name,
     'client', o.client_name, 'title', o.title, 'due_date', o.due_date, 'status', o.status_label,
     'assignee', (select name from public.memberships m where m.company_id = c and m.user_id = o.assignee_id))
    order by o.due_date)
    from (select * from x where x.has_due and x.kind <> 'closed' and x.due_date < v_today
     order by x.due_date limit 20) o), '[]'),
  'clients', coalesce((select jsonb_agg(jsonb_build_object('client', cq.client_name, 'open', cq.open,
     'severe', cq.severe, 'new', cq.new) order by cq.open desc, cq.severe desc)
    from (select x.client_name, count(*) filter (where x.kind <> 'closed') as open,
      count(*) filter (where x.kind <> 'closed' and x.severity >= 2) as severe, count(*) filter (where x.is_new) as new
     from x group by x.client_id, x.client_name having count(*) filter (where x.kind <> 'closed') > 0
     order by 2 desc, 3 desc limit 10) cq), '[]'),
  'new_items', coalesce((select jsonb_agg(jsonb_build_object('topic', n.topic_name, 'product', n.product_name,
     'client', n.client_name, 'title', n.title, 'severity', n.severity, 'status', n.status_label)
    order by n.created_at desc)
    from (select * from x where x.is_new order by x.created_at desc limit 40) n), '[]'))
 into v_out;
 return v_out;
end $$;
revoke all on function mavi_private.radar_report_material(uuid, date, date, jsonb, uuid[]) from public, anon, authenticated;

create or replace function public.request_radar_report(p_company uuid, p_from date, p_to date, p_filters jsonb,
 p_title text default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare r public.radar_reports; f jsonb; begin
 perform mavi_private.module_scope(p_company, 'radar');
 if p_from is null or p_to is null or p_from > p_to then
  raise exception 'Escolha um período válido.' using errcode = '22023';
 end if;
 if p_to - p_from > 366 then raise exception 'O período tem até um ano.' using errcode = '22023'; end if;
 f := mavi_private.radar_report_filters(p_company, p_filters);
 insert into public.radar_reports(company_id, requested_by, title, period_from, period_to, filters)
 values (p_company, auth.uid(), coalesce(nullif(left(btrim(coalesce(p_title, '')), 200), ''),
   format('Radar do cliente · %s a %s', to_char(p_from, 'DD/MM/YYYY'), to_char(p_to, 'DD/MM/YYYY'))),
  p_from, p_to, f)
 returning * into r;
 perform mavi_private.broadcast(p_company, jsonb_build_object('kind', 'radar', 'report', r.id, 'status', r.status));
 perform mavi_private.ai_radar_kick();
 return mavi_private.radar_report_json(r, false);
end $$;

create or replace function public.delete_radar_report(p_company uuid, p_report uuid) returns void
language plpgsql security definer set search_path = '' as $$ begin
 perform mavi_private.module_scope(p_company, 'radar');
 delete from public.radar_reports where company_id = p_company and id = p_report
  and (requested_by = auth.uid() or mavi_private.admin(p_company));
 if not found then raise exception 'Só quem pediu (ou um administrador) exclui o relatório.' using errcode = '42501'; end if;
 perform mavi_private.broadcast(p_company, jsonb_build_object('kind', 'radar', 'report', p_report, 'status', 'deleted'));
end $$;

create or replace function public.radar_report_schedules(p_company uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$ begin
 perform mavi_private.module_scope(p_company, 'radar');
 return coalesce((select jsonb_agg(jsonb_build_object('id', s.id, 'name', s.name, 'frequency', s.frequency,
   'weekday', s.weekday, 'month_day', s.month_day, 'hour', s.hour, 'period_days', s.period_days,
   'filters', s.filters, 'labels', mavi_private.radar_report_labels(s.company_id, s.filters), 'active', s.active,
   'next_run_at', s.next_run_at, 'last_run_at', s.last_run_at) order by s.created_at)
  from public.radar_report_schedules s where s.company_id = p_company and s.user_id = auth.uid()), '[]');
end $$;

create or replace function public.save_radar_report_schedule(p_company uuid, p_schedule jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v jsonb := coalesce(p_schedule, '{}'); v_id uuid; v_tz text; v_freq text; v_week integer; v_day integer;
 v_hour integer; v_days integer; v_active boolean; begin
 perform mavi_private.module_scope(p_company, 'radar');
 v_freq := coalesce(v->>'frequency', 'weekly');
 if v_freq not in ('weekly', 'monthly') then raise exception 'Frequência inválida.' using errcode = '22023'; end if;
 v_week := coalesce((v->>'weekday')::integer, 1);
 v_day := coalesce((v->>'month_day')::integer, 1);
 v_hour := coalesce((v->>'hour')::integer, 8);
 v_days := coalesce((v->>'period_days')::integer, case v_freq when 'weekly' then 7 else 30 end);
 v_active := coalesce((v->>'active')::boolean, true);
 if v_week not between 1 and 7 or v_day not between 1 and 28 or v_hour not between 0 and 23
  or v_days not between 1 and 366 then
  raise exception 'Dia, hora ou período inválido.' using errcode = '22023';
 end if;
 if length(btrim(coalesce(v->>'name', ''))) not between 2 and 120 then
  raise exception 'Dê um nome de 2 a 120 caracteres ao agendamento.' using errcode = '22023';
 end if;
 select timezone into v_tz from public.companies where id = p_company;
 v_id := case when v->>'id' ~* '^[0-9a-f-]{36}$' then (v->>'id')::uuid end;
 if v_id is not null then
  update public.radar_report_schedules set name = btrim(v->>'name'), frequency = v_freq, weekday = v_week,
   month_day = v_day, hour = v_hour, period_days = v_days,
   filters = mavi_private.radar_report_filters(p_company, v->'filters'), active = v_active,
   next_run_at = case when v_active then mavi_private.radar_schedule_next(v_freq, v_week, v_day, v_hour,
     coalesce(v_tz, 'America/Sao_Paulo'), now()) end,
   updated_at = now()
  where id = v_id and company_id = p_company and user_id = auth.uid();
  if not found then raise exception 'Agendamento não encontrado.' using errcode = 'P0002'; end if;
 else
  if (select count(*) from public.radar_report_schedules where company_id = p_company and user_id = auth.uid()) >= 10 then
   raise exception 'Cada pessoa tem até 10 agendamentos.' using errcode = '22023';
  end if;
  insert into public.radar_report_schedules(company_id, user_id, name, frequency, weekday, month_day, hour,
   period_days, filters, active, next_run_at)
  values (p_company, auth.uid(), btrim(v->>'name'), v_freq, v_week, v_day, v_hour, v_days,
   mavi_private.radar_report_filters(p_company, v->'filters'), v_active,
   case when v_active then mavi_private.radar_schedule_next(v_freq, v_week, v_day, v_hour,
     coalesce(v_tz, 'America/Sao_Paulo'), now()) end);
 end if;
 return public.radar_report_schedules(p_company);
end $$;

create or replace function public.delete_radar_report_schedule(p_company uuid, p_schedule uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$ begin
 perform mavi_private.module_scope(p_company, 'radar');
 delete from public.radar_report_schedules where company_id = p_company and id = p_schedule and user_id = auth.uid();
 if not found then raise exception 'Agendamento não encontrado.' using errcode = 'P0002'; end if;
 return public.radar_report_schedules(p_company);
end $$;

create or replace function public.radar_reports(p_company uuid, p_limit integer default 50, p_offset integer default 0)
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_all boolean := mavi_private.module_scope(p_company, 'radar') is null; begin
 return jsonb_build_object(
  'total', (select count(*) from public.radar_reports where company_id = p_company
    and (v_all or requested_by = auth.uid())),
  'reports', coalesce((select jsonb_agg(mavi_private.radar_report_json(r, false) order by r.created_at desc)
    from (select * from public.radar_reports where company_id = p_company
      and (v_all or requested_by = auth.uid()) order by created_at desc
      limit least(greatest(coalesce(p_limit, 50), 1), 100) offset greatest(coalesce(p_offset, 0), 0)) r), '[]'));
end $$;

create or replace function public.radar_report(p_company uuid, p_report uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare r public.radar_reports; v_all boolean; begin
 v_all := mavi_private.module_scope(p_company, 'radar') is null;
 select * into r from public.radar_reports where company_id = p_company and id = p_report
  and (v_all or requested_by = auth.uid());
 if not found then raise exception 'Relatório não encontrado.' using errcode = 'P0002'; end if;
 return mavi_private.radar_report_json(r, true);
end $$;

create or replace function public.retry_radar_report(p_company uuid, p_report uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare r public.radar_reports; v_all boolean; begin
 v_all := mavi_private.module_scope(p_company, 'radar') is null;
 update public.radar_reports set status = 'pending', attempts = 0, claimed_until = null, error = null
 where company_id = p_company and id = p_report and status = 'failed' and (v_all or requested_by = auth.uid())
 returning * into r;
 if not found then raise exception 'Só dá para tentar de novo um relatório que falhou.' using errcode = '22023'; end if;
 perform mavi_private.broadcast(p_company, jsonb_build_object('kind', 'radar', 'report', r.id, 'status', r.status));
 perform mavi_private.ai_radar_kick();
 return mavi_private.radar_report_json(r, false);
end $$;

create or replace function public.ai_radar_report_claim(p_secret text, p_limit integer default 2) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare s public.radar_report_schedules; v_tz text; v_to date; r public.radar_reports; v_out jsonb := '[]'; begin
 if not mavi_private.ai_secret_ok(p_secret) then raise exception 'Sem permissão' using errcode = '42501'; end if;
 for s in select * from public.radar_report_schedules x where x.active and x.next_run_at <= now()
  order by x.next_run_at limit 20 for update skip locked loop
  select timezone into v_tz from public.companies where id = s.company_id;
  v_tz := coalesce(v_tz, 'America/Sao_Paulo');
  if not (mavi_private.leader_of(s.company_id, s.user_id) or mavi_private.opt_in_for(s.company_id, s.user_id, 'radar')) then
   update public.radar_report_schedules set active = false, next_run_at = null, updated_at = now() where id = s.id;
   continue;
  end if;
  v_to := (now() at time zone v_tz)::date - 1;
  insert into public.radar_reports(company_id, requested_by, schedule_id, title, period_from, period_to, filters)
  values (s.company_id, s.user_id, s.id, left(format('%s · %s a %s', s.name, to_char(v_to - s.period_days + 1, 'DD/MM'),
    to_char(v_to, 'DD/MM/YYYY')), 200), v_to - s.period_days + 1, v_to, s.filters);
  update public.radar_report_schedules set last_run_at = now(),
   next_run_at = mavi_private.radar_schedule_next(s.frequency, s.weekday, s.month_day, s.hour, v_tz, now())
  where id = s.id;
 end loop;
 for r in
  with due as (
   select x.id from public.radar_reports x
   where x.status in ('pending', 'running') and x.attempts < 3
    and (x.claimed_until is null or x.claimed_until < now())
   order by x.created_at limit least(greatest(coalesce(p_limit, 2), 1), 5)
   for update skip locked
  )
  update public.radar_reports x set status = 'running', attempts = x.attempts + 1,
   claimed_until = now() + interval '10 minutes'
  from due where x.id = due.id
  returning x.*
 loop
  update public.radar_reports set material = mavi_private.radar_report_material(r.company_id, r.period_from,
   r.period_to, r.filters, case when r.requested_by is null or mavi_private.leader_of(r.company_id, r.requested_by)
    then null else mavi_private.served_clients_of(r.company_id, r.requested_by) end) where id = r.id
  returning * into r;
  perform mavi_private.broadcast(r.company_id, jsonb_build_object('kind', 'radar', 'report', r.id, 'status', r.status));
  v_out := v_out || jsonb_build_object('id', r.id, 'company_id', r.company_id, 'title', r.title,
   'period_from', r.period_from, 'period_to', r.period_to, 'material', r.material);
 end loop;
 return v_out;
end $$;

create or replace function public.radar_alert_rules(p_company uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$ begin
 perform mavi_private.module_scope(p_company, 'radar');
 return coalesce((select jsonb_agg(mavi_private.radar_alert_rule_json(r) order by r.created_at)
  from public.radar_alert_rules r where r.company_id = p_company and r.user_id = auth.uid()), '[]');
end $$;

create or replace function public.delete_radar_alert_rule(p_company uuid, p_rule uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$ begin
 perform mavi_private.module_scope(p_company, 'radar');
 delete from public.radar_alert_rules where company_id = p_company and id = p_rule and user_id = auth.uid();
 if not found then raise exception 'Aviso não encontrado.' using errcode = 'P0002'; end if;
 return public.radar_alert_rules(p_company);
end $$;

create or replace function public.save_radar_alert_rule(p_company uuid, p_rule jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v jsonb := coalesce(p_rule, '{}'); v_id uuid; v_events text[]; v_topic uuid; v_product uuid; v_client uuid;
 v_team uuid; v_sev smallint; v_clients uuid[]; begin
 v_clients := mavi_private.module_scope(p_company, 'radar');
 if length(btrim(coalesce(v->>'name', ''))) not between 2 and 120 then
  raise exception 'Dê um nome de 2 a 120 caracteres ao aviso.' using errcode = '22023';
 end if;
 select coalesce(array_agg(distinct e), '{}') into v_events from jsonb_array_elements_text(
  case when jsonb_typeof(v->'events') = 'array' then v->'events' else '[]' end) e
 where e in ('new', 'recurring', 'reopened', 'due_soon', 'overdue');
 if cardinality(v_events) = 0 then raise exception 'Escolha ao menos um evento.' using errcode = '22023'; end if;
 if coalesce(v->>'channel', 'now') not in ('now', 'digest') then raise exception 'Canal inválido.' using errcode = '22023'; end if;
 v_topic := case when v->>'topic_id' ~* '^[0-9a-f-]{36}$' then (v->>'topic_id')::uuid end;
 v_product := case when v->>'product_id' ~* '^[0-9a-f-]{36}$' then (v->>'product_id')::uuid end;
 v_client := case when v->>'client_id' ~* '^[0-9a-f-]{36}$' then (v->>'client_id')::uuid end;
 v_team := case when v->>'team_id' ~* '^[0-9a-f-]{36}$' then (v->>'team_id')::uuid end;
 v_sev := case when jsonb_typeof(v->'min_severity') = 'number' then (v->>'min_severity')::smallint end;
 if v_topic is not null and not exists (select 1 from public.radar_topics where id = v_topic and company_id = p_company)
  or v_product is not null and not exists (select 1 from public.products where id = v_product and company_id = p_company)
  or v_client is not null and not exists (select 1 from public.clients where id = v_client and company_id = p_company)
  or v_team is not null and not exists (select 1 from public.teams where id = v_team and company_id = p_company) then
  raise exception 'Filtro não encontrado na empresa.' using errcode = 'P0002';
 end if;
 -- Quem não é líder filtra pelos clientes e pelas equipes dele.
 if v_clients is not null and (v_client is not null and not v_client = any(v_clients)
   or v_team is not null and not exists (select 1 from public.team_members tm where tm.company_id = p_company
    and tm.team_id = v_team and tm.user_id = auth.uid())) then
  raise exception 'Filtro não encontrado na empresa.' using errcode = 'P0002';
 end if;
 if v_sev is not null and v_sev not between 0 and 3 then raise exception 'Gravidade inválida.' using errcode = '22023'; end if;
 v_id := case when v->>'id' ~* '^[0-9a-f-]{36}$' then (v->>'id')::uuid end;
 if v_id is not null then
  update public.radar_alert_rules set name = btrim(v->>'name'), topic_id = v_topic, product_id = v_product,
   product_none = v_product is null and coalesce((v->>'product_none')::boolean, false), client_id = v_client,
   team_id = v_team, min_severity = v_sev, events = v_events, channel = coalesce(v->>'channel', 'now'),
   active = coalesce((v->>'active')::boolean, true), updated_at = now()
  where id = v_id and company_id = p_company and user_id = auth.uid();
  if not found then raise exception 'Aviso não encontrado.' using errcode = 'P0002'; end if;
 else
  if (select count(*) from public.radar_alert_rules where company_id = p_company and user_id = auth.uid()) >= 20 then
   raise exception 'Cada pessoa tem até 20 avisos.' using errcode = '22023';
  end if;
  insert into public.radar_alert_rules(company_id, user_id, name, topic_id, product_id, product_none, client_id,
   team_id, min_severity, events, channel, active)
  values (p_company, auth.uid(), btrim(v->>'name'), v_topic, v_product,
   v_product is null and coalesce((v->>'product_none')::boolean, false), v_client, v_team, v_sev, v_events,
   coalesce(v->>'channel', 'now'), coalesce((v->>'active')::boolean, true));
 end if;
 return public.radar_alert_rules(p_company);
end $$;

create or replace function mavi_private.radar_alert(p_item uuid, p_kind text, p_at timestamptz) returns integer
language plpgsql security definer set search_path = '' as $$
declare i record; r public.radar_alert_rules; v_tz text; v_today date; v_n integer := 0; begin
 if p_at is not null and p_at < now() - interval '3 days' then return 0; end if;
 select it.*, t.name as topic_name, k.name as client_name, coalesce(p.name, 'Geral / Agência') as product_name,
  coalesce(t.severity_levels->>(it.severity::integer), '') as severity_text
 into i
 from public.radar_items it
 join public.radar_topics t on t.id = it.topic_id
 join public.clients k on k.id = it.client_id and not k.archived
 left join public.products p on p.id = it.product_id
 where it.id = p_item;
 if not found then return 0; end if;
 select timezone into v_tz from public.companies where id = i.company_id;
 v_today := (now() at time zone coalesce(v_tz, 'America/Sao_Paulo'))::date;
 for r in
  select rr.* from public.radar_alert_rules rr
  join public.memberships m on m.company_id = rr.company_id and m.user_id = rr.user_id and m.active
   and not ('radar' = any(m.hidden_pages)) and (m.role in ('admin', 'manager')
    -- O colaborador com o Radar ligado só recebe dos clientes das equipes dele.
    or (m.role = 'member' and 'radar' = any(m.shown_pages)
     and i.client_id = any(mavi_private.served_clients_of(i.company_id, m.user_id))))
  where rr.company_id = i.company_id and rr.active and p_kind = any(rr.events)
   and (rr.topic_id is null or rr.topic_id = i.topic_id)
   and (not rr.product_none or i.product_id is null)
   and (rr.product_id is null or rr.product_id = i.product_id)
   and (rr.client_id is null or rr.client_id = i.client_id)
   and (rr.team_id is null or exists (select 1 from public.client_teams ct where ct.company_id = i.company_id
    and ct.client_id = i.client_id and ct.team_id = rr.team_id))
   and (rr.min_severity is null or coalesce(i.severity, -1) >= rr.min_severity)
  order by case rr.channel when 'now' then 0 else 1 end, rr.created_at
 loop
  insert into mavi_private.radar_alert_sent(user_id, item_id, kind, day) values (r.user_id, i.id, p_kind, v_today)
  on conflict do nothing;
  continue when not found;
  if r.channel = 'now' then
   insert into public.notifications(company_id, user_id, actor_id, task_id, kind, title, body, link)
   values (i.company_id, r.user_id, null, null, 'radar_alert', left(format('%s: %s', i.topic_name, i.title), 300),
    left(concat_ws(' · ', mavi_private.radar_event_label(p_kind), i.client_name, i.product_name,
     nullif(split_part(i.severity_text, ':', 1), ''),
     case when p_kind in ('due_soon', 'overdue') and i.due_date is not null then 'prazo ' || to_char(i.due_date, 'DD/MM') end), 300),
    '/radar?item=' || i.id);
  else
   insert into mavi_private.radar_alert_digest(company_id, user_id, item_id, kind) values (i.company_id, r.user_id, i.id, p_kind);
  end if;
  v_n := v_n + 1;
 end loop;
 return v_n;
end $$;

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
  'can_configure', v_leader,
  -- Itens, temas, relatórios e avisos (recortados pelos clientes de quem não é líder).
  'can_use', true);
end $$;

-- ------------------------------------------------------------ Dashboards
-- Os dados de um dashboard: tudo, se quem o criou é líder; senão, só os
-- clientes das equipes de quem o criou (para quem quer que o abra).
create or replace function mavi_private.dashboard_scope(d public.dashboards) returns uuid[]
language sql stable security definer set search_path = '' as $$
 select case when mavi_private.leader_of(d.company_id, d.created_by) then null
  else mavi_private.served_clients_of(d.company_id, d.created_by) end
$$;
-- O colaborador com o módulo ligado edita os dashboards que ele criou.
create or replace function mavi_private.dashboard_owner(d public.dashboards) returns boolean
language sql stable security definer set search_path = '' as $$
 select auth.uid() is not null and d.created_by = auth.uid() and mavi_private.opt_in_on(d.company_id, 'dashboards')
$$;
-- Filtros do dashboard com o recorte (a chave "__scope" nunca vem de fora).
create or replace function mavi_private.dashboard_scoped(p_filters jsonb, p_scope uuid[]) returns jsonb
language sql immutable set search_path = '' as $$
 select (case when jsonb_typeof(p_filters) = 'object' then p_filters else '{}'::jsonb end - '__scope')
  || (case when p_scope is null then '{}'::jsonb else jsonb_build_object('__scope', to_jsonb(p_scope)) end)
$$;
revoke all on function mavi_private.dashboard_scope(public.dashboards), mavi_private.dashboard_owner(public.dashboards),
 mavi_private.dashboard_scoped(jsonb, uuid[]) from public, anon, authenticated;

alter policy dashboards_read on public.dashboards using (
 company_id in (select mavi_private.active_companies()) and (mavi_private.dashboard_viewer(company_id, id)
  or (created_by = (select auth.uid()) and mavi_private.opt_in_on(company_id, 'dashboards'))));
alter policy dashboard_members_read on public.dashboard_members using (
 company_id in (select mavi_private.leader_companies())
 or dashboard_id in (select x.id from public.dashboards x where x.created_by = (select auth.uid())
  and mavi_private.opt_in_on(x.company_id, 'dashboards')));

-- Cada consulta com o recorte ganha o filtro de cliente; o Mural de avisos
-- não tem cliente e fica de fora (a da migração 20260930140000).
create or replace function mavi_private.dashboard_series(c uuid, q jsonb, p_group text, p_interval text,
 p_from date, p_to date, p_filters jsonb, p_limit integer) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare result jsonb; v_scope jsonb := p_filters->'__scope'; begin
  if jsonb_typeof(v_scope) = 'array' then
    if q->>'source' = 'notices' then
      raise exception 'O Mural de avisos não entra nos dashboards de colaboradores (os avisos não têm cliente).'
       using errcode = '22023';
    end if;
    q := jsonb_set(q, '{filters}', (case when jsonb_typeof(q->'filters') = 'array' then q->'filters' else '[]'::jsonb end)
     || jsonb_build_array(jsonb_build_object('field', 'client', 'op', 'in', 'values',
      case when jsonb_array_length(v_scope) = 0 then '["00000000-0000-0000-0000-000000000000"]'::jsonb
       else v_scope end)));
  end if;
  execute mavi_private.dashboard_sql(c, q, p_group, p_interval, p_from, p_to, coalesce(p_filters, '{}'::jsonb) - '__scope',
   p_limit) into result;
  return coalesce(result, '[]'::jsonb);
end $$;


-- Quem criou (colaborador com o módulo ligado) também edita.
create or replace function mavi_private.dashboard_access(d public.dashboards, p_token text, p_password text) returns text
language plpgsql volatile security definer set search_path = '' as $$
declare a mavi_private.dashboard_password_attempts; begin
  if auth.uid() is not null and mavi_private.member(d.company_id) then
    if mavi_private.leader(d.company_id) or mavi_private.dashboard_owner(d) then return 'editor'; end if;
    if mavi_private.dashboard_viewer(d.company_id, d.id) then return 'viewer'; end if;
  end if;
  if p_token is null or p_token <> d.share_token then return null; end if;
  if d.link_access = 'public' then return 'viewer'; end if;
  if d.link_access <> 'password' then return null; end if;
  select * into a from mavi_private.dashboard_password_attempts where dashboard_id = d.id for update;
  if found and a.failures >= 10 and a.window_start > now() - interval '15 minutes' then return 'locked'; end if;
  if nullif(p_password, '') is null then return 'password'; end if;
  if d.password_hash = extensions.crypt(p_password, d.password_hash) then return 'viewer'; end if;
  insert into mavi_private.dashboard_password_attempts(dashboard_id, window_start, failures) values (d.id, now(), 1)
  on conflict (dashboard_id) do update set
   failures = case when mavi_private.dashboard_password_attempts.window_start < now() - interval '15 minutes'
    then 1 else mavi_private.dashboard_password_attempts.failures + 1 end,
   window_start = case when mavi_private.dashboard_password_attempts.window_start < now() - interval '15 minutes'
    then now() else mavi_private.dashboard_password_attempts.window_start end;
  return 'password';
end $$;

-- O recorte entra nos filtros, e por isso na chave do cache.
create or replace function public.dashboard_panel_data(p_dashboard uuid, p_panel text, p_from date, p_to date,
 p_vars jsonb default null, p_token text default null, p_password text default null, p_fresh boolean default false)
 returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare d public.dashboards; acc text; panel jsonb; filters jsonb; key text; hit jsonb; result jsonb; begin
  if p_token is not null then select * into d from public.dashboards where share_token = p_token;
  else select * into d from public.dashboards where id = p_dashboard; end if;
  if not found then raise exception 'Dashboard não encontrado' using errcode = '42501'; end if;
  acc := mavi_private.dashboard_access(d, p_token, p_password);
  if acc = 'locked' then return jsonb_build_object('error', 'Muitas tentativas. Tente novamente em alguns minutos.'); end if;
  if acc = 'password' then return jsonb_build_object('error', 'Senha incorreta.'); end if;
  if acc is null then raise exception 'Sem acesso a este dashboard' using errcode = '42501'; end if;
  select value into panel from jsonb_array_elements(d.panels) where value->>'id' = p_panel;
  if panel is null then raise exception 'Painel não encontrado' using errcode = 'P0002'; end if;
  filters := mavi_private.dashboard_scoped(coalesce(case when acc = 'editor' and p_vars is not null
   then p_vars->'filters' end, d.variables->'filters', '{}'::jsonb), mavi_private.dashboard_scope(d));
  key := md5(concat_ws('|', d.id, d.version, p_panel, p_from, p_to, filters::text));
  if not (p_fresh and auth.uid() is not null) then
    select data into hit from mavi_private.dashboard_cache
    where cache_key = key and created_at > now() - interval '60 seconds';
    if hit is not null then return hit; end if;
  end if;
  result := mavi_private.dashboard_run(d.company_id, panel->'spec', p_from, p_to, filters)
   || jsonb_build_object('computed_at', now());
  insert into mavi_private.dashboard_cache(cache_key, dashboard_id, created_at, data) values (key, d.id, now(), result)
  on conflict (cache_key) do update set created_at = excluded.created_at, data = excluded.data;
  return result;
end $$;

create or replace function public.dashboard_preview(p_company uuid, p_spec jsonb, p_from date, p_to date, p_vars jsonb default '{}')
 returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_scope uuid[]; begin
  if mavi_private.leader(p_company) then v_scope := null;
  elsif mavi_private.opt_in_on(p_company, 'dashboards') then v_scope := mavi_private.served_clients(p_company);
  else raise exception 'Sem permissão' using errcode = '42501'; end if;
  perform mavi_private.dashboard_check(p_company,
   jsonb_build_array(jsonb_build_object('id', 'preview', 'title', '', 'x', 0, 'y', 0, 'w', 12, 'h', 4, 'spec', p_spec)),
   coalesce(p_vars, '{}'::jsonb));
  return mavi_private.dashboard_run(p_company, p_spec, p_from, p_to,
   mavi_private.dashboard_scoped(coalesce(p_vars->'filters', '{}'::jsonb), v_scope))
   || jsonb_build_object('computed_at', now());
end $$;

create or replace function public.save_dashboard(p_company uuid, p_dashboard uuid, p_name text, p_description text,
 p_panels jsonb, p_variables jsonb, p_version integer default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare d public.dashboards; v_leader boolean := mavi_private.leader(p_company); begin
  if not (v_leader or mavi_private.opt_in_on(p_company, 'dashboards')) then
    raise exception 'Sem permissão' using errcode = '42501';
  end if;
  if p_dashboard is not null and not v_leader and not exists (select 1 from public.dashboards
    where id = p_dashboard and company_id = p_company and created_by = auth.uid()) then
    raise exception 'Sem permissão: só quem criou edita este dashboard.' using errcode = '42501';
  end if;
  if jsonb_typeof(p_variables->'filters') = 'object' then
    p_variables := jsonb_set(p_variables, '{filters}', (p_variables->'filters') - '__scope');
  end if;
  -- O Mural de avisos não tem cliente: fica fora dos dashboards de colaboradores.
  if not coalesce(mavi_private.leader_of(p_company, coalesce((select created_by from public.dashboards
      where id = p_dashboard), auth.uid())), false)
   and exists (select 1 from jsonb_array_elements(case when jsonb_typeof(p_panels) = 'array' then p_panels else '[]' end) p,
    jsonb_array_elements(case when jsonb_typeof(p->'spec'->'queries') = 'array' then p->'spec'->'queries' else '[]' end) q
    where q->>'source' = 'notices') then
    raise exception 'O Mural de avisos não entra nos dashboards de colaboradores (os avisos não têm cliente).'
     using errcode = '22023';
  end if;
  if length(trim(coalesce(p_name, ''))) not between 2 and 120 then
    raise exception 'Informe um nome de 2 a 120 caracteres.' using errcode = '22023';
  end if;
  if length(coalesce(p_description, '')) > 500 then raise exception 'Descrição longa demais.' using errcode = '22023'; end if;
  perform mavi_private.dashboard_check(p_company, coalesce(p_panels, '[]'::jsonb), coalesce(p_variables, '{}'::jsonb));
  if p_dashboard is null then
    insert into public.dashboards(company_id, name, description, panels, variables, updated_by)
    values (p_company, trim(p_name), coalesce(p_description, ''), coalesce(p_panels, '[]'::jsonb),
     coalesce(p_variables, '{}'::jsonb), auth.uid())
    returning * into d;
  else
    update public.dashboards set name = trim(p_name), description = coalesce(p_description, ''),
     panels = coalesce(p_panels, '[]'::jsonb), variables = coalesce(p_variables, '{}'::jsonb),
     version = version + 1, updated_by = auth.uid(), updated_at = now()
    where id = p_dashboard and company_id = p_company and (p_version is null or version = p_version)
    returning * into d;
    if not found then
      if exists(select 1 from public.dashboards where id = p_dashboard and company_id = p_company) then
        raise exception 'Este dashboard foi alterado por outra pessoa. Recarregue para ver a versão atual.'
         using errcode = '40001';
      end if;
      raise exception 'Dashboard não encontrado' using errcode = 'P0002';
    end if;
  end if;
  return to_jsonb(d) - 'password_hash';
end $$;

create or replace function public.delete_dashboard(p_dashboard uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare d public.dashboards; begin
  select * into d from public.dashboards where id = p_dashboard for update;
  if not found or not (mavi_private.leader(d.company_id) or mavi_private.dashboard_owner(d)) then raise exception 'Sem permissão' using errcode = '42501'; end if;
  delete from mavi_private.dashboard_cache where dashboard_id = d.id;
  delete from public.dashboards where id = d.id;
end $$;

create or replace function public.set_dashboard_sharing(p_dashboard uuid, p_link_access text, p_password text default null,
 p_users uuid[] default '{}', p_teams uuid[] default '{}', p_new_link boolean default false) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare d public.dashboards; begin
  select * into d from public.dashboards where id = p_dashboard for update;
  if not found or not (mavi_private.leader(d.company_id) or mavi_private.dashboard_owner(d)) then raise exception 'Sem permissão' using errcode = '42501'; end if;
  if p_link_access not in ('none', 'password', 'public') then raise exception 'Acesso inválido' using errcode = '22023'; end if;
  if nullif(p_password, '') is not null and length(p_password) not between 6 and 72 then
    raise exception 'A senha precisa ter de 6 a 72 caracteres.' using errcode = '22023';
  end if;
  if p_link_access = 'password' and nullif(p_password, '') is null and d.password_hash is null then
    raise exception 'Defina uma senha para o link.' using errcode = '22023';
  end if;
  update public.dashboards set
   link_access = p_link_access,
   password_hash = case when p_link_access <> 'password' then null
    when nullif(p_password, '') is not null then extensions.crypt(p_password, extensions.gen_salt('bf', 8))
    else password_hash end,
   share_token = case when p_new_link
    then replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '') else share_token end
  where id = d.id returning * into d;
  if nullif(p_password, '') is not null or p_link_access <> 'password' then
    delete from mavi_private.dashboard_password_attempts where dashboard_id = d.id;
  end if;
  delete from public.dashboard_members where dashboard_id = d.id;
  insert into public.dashboard_members(company_id, dashboard_id, user_id)
  select d.company_id, d.id, m.user_id from public.memberships m
  where m.company_id = d.company_id and m.active and m.user_id = any(coalesce(p_users, '{}'));
  insert into public.dashboard_members(company_id, dashboard_id, team_id)
  select d.company_id, d.id, t.id from public.teams t
  where t.company_id = d.company_id and t.id = any(coalesce(p_teams, '{}'));
  return to_jsonb(d) - 'password_hash';
end $$;

commit;
