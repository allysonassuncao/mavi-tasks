begin;

-- Campanhas (tráfego pago), vindas do módulo "Acompanhamento" do MASO.
-- Uma campanha pertence a um produto contratado (a contratação do cliente) e
-- passa por ciclos: períodos em que uma verba é consumida, com um objetivo e
-- uma quantidade esperada de resultados. O fim do ciclo é quando o próximo
-- investimento precisa entrar. A troca do ciclo atual é sempre manual.
-- Acesso exclusivo de administradores da empresa (leitura e escrita).
-- Especificação: maso/contas/acompanhamento/ESPECIFICACAO_MODULO_CAMPANHAS.md
create table public.ad_campaigns (
 id uuid primary key default gen_random_uuid(),
 company_id uuid not null references public.companies(id),
 contract_id uuid not null,
 name text not null check (length(trim(name)) between 2 and 160),
 platform text not null check (platform in ('meta','google','linkedin','tiktok','kwai')),
 status text not null default 'inactive' check (status in ('active','inactive')),
 current_cycle_id uuid,
 briefing_url text not null default '' check (briefing_url = '' or briefing_url ~* '^https?://'),
 media_plan_url text not null default '' check (media_plan_url = '' or media_plan_url ~* '^https?://'),
 notes text not null default '' check (length(notes) <= 4000),
 -- maso_acompanhamento.id_campanha, preserved for links and migration.
 legacy_id text,
 archived boolean not null default false,
 created_by uuid not null default auth.uid(),
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 version integer not null default 1,
 unique (company_id, id),
 unique (company_id, legacy_id),
 foreign key (company_id, contract_id) references public.contracts(company_id, id)
);
create index ad_campaigns_contract on public.ad_campaigns(company_id, contract_id);

create table public.ad_cycles (
 id uuid primary key default gen_random_uuid(),
 company_id uuid not null,
 campaign_id uuid not null,
 -- Financial month of reference (first day of the month).
 competence_month date not null check (extract(day from competence_month) = 1),
 start_date date not null,
 end_date date not null,
 objective text not null check (objective in ('lead','sale','message','traffic','engagement','custom','video')),
 -- How many results (leads, messages, sales…) the cycle is expected to bring.
 goal_results integer not null check (goal_results >= 0),
 -- The cycle's media budget, as contracted by the client.
 budget numeric(14,2) not null check (budget >= 0),
 -- "Índice de performance" (M) of the operation.
 multiplier numeric(6,3) not null default 1 check (multiplier > 0 and multiplier <= 100),
 destination text not null default 'external_page'
  check (destination in ('lead_form','external_page','make_landing_page')),
 -- Make landing pages (ids), only when the destination is one of them.
 landing_pages text[] not null default '{}',
 niche text not null default '' check (length(niche) <= 120),
 legacy_id text,
 created_by uuid not null default auth.uid(),
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 version integer not null default 1,
 check (end_date >= start_date and end_date - start_date < 366),
 check (destination = 'make_landing_page' or landing_pages = '{}'),
 unique (company_id, id),
 unique (company_id, campaign_id, id),
 unique (company_id, legacy_id),
 foreign key (company_id, campaign_id) references public.ad_campaigns(company_id, id)
);
create index ad_cycles_campaign on public.ad_cycles(company_id, campaign_id, start_date);

-- The current cycle must be one of the campaign's own cycles.
alter table public.ad_campaigns add constraint ad_campaigns_current_cycle
 foreign key (company_id, id, current_cycle_id) references public.ad_cycles(company_id, campaign_id, id);

-- Ad accounts and campaigns on the platform that the cycle's results come from.
create table public.ad_cycle_links (
 id uuid primary key default gen_random_uuid(),
 company_id uuid not null,
 cycle_id uuid not null,
 account_id text not null check (length(trim(account_id)) between 1 and 60),
 external_campaign_id text not null default '' check (length(external_campaign_id) <= 60),
 foreign key (company_id, cycle_id) references public.ad_cycles(company_id, id) on delete cascade,
 unique (cycle_id, account_id, external_campaign_id)
);
create index ad_cycle_links_cycle on public.ad_cycle_links(company_id, cycle_id);

-- History: creation, edits (before/after), status and current-cycle changes.
create table public.ad_campaign_events (
 id bigint generated always as identity primary key,
 company_id uuid not null,
 campaign_id uuid not null,
 cycle_id uuid,
 actor_id uuid not null,
 action text not null,
 detail jsonb not null default '{}',
 created_at timestamptz not null default now(),
 foreign key (company_id, campaign_id) references public.ad_campaigns(company_id, id)
);
create index ad_campaign_events_campaign on public.ad_campaign_events(company_id, campaign_id, created_at desc);

-- Read: only the company's administrators (the module is exclusive to them).
alter table public.ad_campaigns enable row level security;
alter table public.ad_cycles enable row level security;
alter table public.ad_cycle_links enable row level security;
alter table public.ad_campaign_events enable row level security;
create policy ad_campaigns_read on public.ad_campaigns for select to authenticated using (
 company_id in (select mavi_private.admin_companies()));
create policy ad_cycles_read on public.ad_cycles for select to authenticated using (
 exists (select 1 from public.ad_campaigns a where a.company_id = ad_cycles.company_id and a.id = ad_cycles.campaign_id));
create policy ad_cycle_links_read on public.ad_cycle_links for select to authenticated using (
 exists (select 1 from public.ad_cycles y where y.company_id = ad_cycle_links.company_id and y.id = ad_cycle_links.cycle_id));
create policy ad_campaign_events_read on public.ad_campaign_events for select to authenticated using (
 exists (select 1 from public.ad_campaigns a where a.company_id = ad_campaign_events.company_id and a.id = ad_campaign_events.campaign_id));
revoke all on public.ad_campaigns, public.ad_cycles, public.ad_cycle_links, public.ad_campaign_events from anon, authenticated;
grant select on public.ad_campaigns, public.ad_cycles, public.ad_cycle_links, public.ad_campaign_events to authenticated;

-- Write: only the company's administrators, like reading.
create function mavi_private.ad_can_write(c uuid) returns boolean
language sql stable security definer set search_path = '' as $$
 select mavi_private.admin(c)
$$;
revoke all on function mavi_private.ad_can_write(uuid) from public, anon;
grant execute on function mavi_private.ad_can_write(uuid) to authenticated;

-- Today in the company's time zone.
create function mavi_private.company_today(c uuid) returns date
language sql stable security definer set search_path = '' as $$
 select (now() at time zone coalesce((select timezone from public.companies where id = c), 'America/Sao_Paulo'))::date
$$;
revoke all on function mavi_private.company_today(uuid) from public, anon;
grant execute on function mavi_private.company_today(uuid) to authenticated;

create function mavi_private.ad_log(c uuid, p_campaign uuid, p_cycle uuid, p_action text, p_detail jsonb) returns void
language sql security definer set search_path = '' as $$
 insert into public.ad_campaign_events(company_id, campaign_id, cycle_id, actor_id, action, detail)
 values (c, p_campaign, p_cycle, auth.uid(), p_action, coalesce(p_detail, '{}'))
$$;
revoke all on function mavi_private.ad_log(uuid, uuid, uuid, text, jsonb) from public, anon, authenticated;

-- Fields that differ between two versions of a row: {"field": {"from": …, "to": …}}.
create function mavi_private.ad_changes(before jsonb, after jsonb, fields text[]) returns jsonb
language sql immutable set search_path = '' as $$
 select coalesce(jsonb_object_agg(f, jsonb_build_object('from', before -> f, 'to', after -> f)), '{}')
 from unnest(fields) f where (before -> f) is distinct from (after -> f)
$$;
revoke all on function mavi_private.ad_changes(jsonb, jsonb, text[]) from public, anon, authenticated;

create function mavi_private.ad_check_urls(p_briefing text, p_plan text) returns void
language plpgsql immutable set search_path = '' as $$ begin
 if coalesce(p_briefing, '') <> '' and p_briefing !~* '^https?://' then
  raise exception 'O link do briefing precisa começar com http:// ou https://' using errcode = '22023';
 end if;
 if coalesce(p_plan, '') <> '' and p_plan !~* '^https?://' then
  raise exception 'O link do plano de mídia precisa começar com http:// ou https://' using errcode = '22023';
 end if;
end $$;
revoke all on function mavi_private.ad_check_urls(text, text) from public, anon, authenticated;

create function public.create_ad_campaign(p_company uuid, p_contract uuid, p_name text, p_platform text,
 p_briefing_url text default '', p_media_plan_url text default '', p_notes text default '') returns uuid
language plpgsql security definer set search_path = '' as $$
declare result uuid; begin
 if not mavi_private.ad_can_write(p_company) then
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

create function public.update_ad_campaign(p_campaign uuid, p_version integer, p_name text, p_platform text,
 p_briefing_url text default '', p_media_plan_url text default '', p_notes text default '') returns void
language plpgsql security definer set search_path = '' as $$
declare a public.ad_campaigns; b public.ad_campaigns; begin
 select * into a from public.ad_campaigns where id = p_campaign for update;
 if not found or not mavi_private.ad_can_write(a.company_id) then
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

-- Active or inactive, always with a reason. Activating needs a current cycle.
create function public.set_ad_campaign_status(p_campaign uuid, p_status text, p_reason text) returns void
language plpgsql security definer set search_path = '' as $$
declare a public.ad_campaigns; begin
 select * into a from public.ad_campaigns where id = p_campaign for update;
 if not found or not mavi_private.ad_can_write(a.company_id) then
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

-- The current cycle only changes by hand (it is never switched automatically).
create function public.set_ad_campaign_current_cycle(p_campaign uuid, p_cycle uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare a public.ad_campaigns; begin
 select * into a from public.ad_campaigns where id = p_campaign for update;
 if not found or not mavi_private.ad_can_write(a.company_id) then
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

-- Validates a cycle's fields and replaces its platform links.
create function mavi_private.ad_cycle_checks(c uuid, p_campaign uuid, p_cycle uuid, p_start date, p_end date,
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
 select * into other from public.ad_cycles where company_id = c and campaign_id = p_campaign
  and id is distinct from p_cycle and start_date <= p_end and end_date >= p_start
 order by start_date limit 1;
 if found then
  raise exception 'O período conflita com o ciclo de % a % desta campanha',
   to_char(other.start_date, 'DD/MM/YYYY'), to_char(other.end_date, 'DD/MM/YYYY') using errcode = '23P01';
 end if;
end $$;
revoke all on function mavi_private.ad_cycle_checks(uuid, uuid, uuid, date, date, text, integer, numeric, text, text[])
 from public, anon, authenticated;

create function mavi_private.ad_set_links(c uuid, p_cycle uuid, p_links jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare l jsonb; begin
 if p_links is not null and jsonb_typeof(p_links) <> 'array' then
  raise exception 'Vínculos inválidos' using errcode = '22023';
 end if;
 delete from public.ad_cycle_links where cycle_id = p_cycle;
 for l in select * from jsonb_array_elements(coalesce(p_links, '[]')) loop
  if length(trim(coalesce(l ->> 'account_id', ''))) = 0 then
   raise exception 'Informe a conta de anúncio de cada vínculo' using errcode = '22023';
  end if;
  insert into public.ad_cycle_links(company_id, cycle_id, account_id, external_campaign_id)
  values (c, p_cycle, trim(l ->> 'account_id'), trim(coalesce(l ->> 'campaign_id', '')))
  on conflict do nothing;
 end loop;
 return (select coalesce(jsonb_agg(jsonb_build_object('account_id', account_id, 'campaign_id', external_campaign_id)
  order by account_id, external_campaign_id), '[]') from public.ad_cycle_links where cycle_id = p_cycle);
end $$;
revoke all on function mavi_private.ad_set_links(uuid, uuid, jsonb) from public, anon, authenticated;

-- A new cycle. Without a multiplier (M), it keeps the previous cycle's.
create function public.create_ad_cycle(p_campaign uuid, p_competence date, p_start date, p_end date,
 p_objective text, p_goal_results integer, p_budget numeric, p_multiplier numeric default null,
 p_destination text default 'external_page', p_landing_pages text[] default '{}', p_niche text default '',
 p_links jsonb default '[]', p_make_current boolean default false) returns uuid
language plpgsql security definer set search_path = '' as $$
declare a public.ad_campaigns; result uuid; inherited numeric; m numeric; links jsonb; begin
 select * into a from public.ad_campaigns where id = p_campaign for update;
 if not found or not mavi_private.ad_can_write(a.company_id) then
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

-- Editing a cycle (ended ones included). Without a multiplier (M), it keeps it.
create function public.update_ad_cycle(p_cycle uuid, p_version integer, p_competence date, p_start date, p_end date,
 p_objective text, p_goal_results integer, p_budget numeric, p_multiplier numeric default null,
 p_destination text default 'external_page', p_landing_pages text[] default '{}', p_niche text default '',
 p_links jsonb default '[]') returns void
language plpgsql security definer set search_path = '' as $$
declare y public.ad_cycles; z public.ad_cycles; a public.ad_campaigns; before_links jsonb; links jsonb;
 changes jsonb; begin
 select * into y from public.ad_cycles where id = p_cycle for update;
 if found then select * into a from public.ad_campaigns where id = y.campaign_id; end if;
 if not found or not mavi_private.ad_can_write(a.company_id) then
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

do $$ declare f text; begin
 for f in select p.oid::regprocedure::text from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname in ('create_ad_campaign','update_ad_campaign','set_ad_campaign_status',
   'set_ad_campaign_current_cycle','create_ad_cycle','update_ad_cycle') loop
  execute format('revoke all on function %s from public, anon', f);
  execute format('grant execute on function %s to authenticated', f);
 end loop;
end $$;

commit;
