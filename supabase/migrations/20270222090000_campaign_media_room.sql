begin;

-- Campanhas × Financeiro › Mídia (migração 20270114090000_finance_media):
--  * O detalhe da campanha mostra o saldo de mídia do cliente + produto
--    (a conta do produto contratado), o que os ciclos ainda vão gastar
--    (reservado) e o que sobra para novos ciclos (disponível). Quem vê a
--    campanha vê esses números, mesmo sem o módulo Financeiro.
--  * Reservado: de cada ciclo ainda não encerrado (término hoje ou depois)
--    das campanhas não arquivadas do produto contratado, a verba menos o que
--    o ciclo já gastou (o gasto × M debitado no extrato). Ciclo encerrado
--    libera a sobra.
--  * Trava da verba: cadastrar um ciclo (ou aumentar a verba de um) só passa
--    se o que ele ainda vai gastar couber no disponível. Diminuir a verba,
--    mexer em outros campos ou cadastrar um ciclo já encerrado passa sempre.
--  * Liberação: administradores e gestores podem passar por cima com um
--    motivo, até o teto da empresa (media_settings.override_cap, que só os
--    administradores mudam em Financeiro › Mídia; começa em R$ 0, sem
--    liberação). A liberação fica no histórico da campanha.

-- ------------------------------------------------------------ teto da liberação
create table public.media_settings (
 company_id uuid primary key references public.companies(id) on delete cascade,
 -- Quanto administradores e gestores podem liberar acima do disponível.
 override_cap numeric(14,2) not null default 0 check (override_cap >= 0 and override_cap < 1000000000000),
 updated_by uuid,
 updated_at timestamptz not null default now()
);
alter table public.media_settings enable row level security;
revoke all on public.media_settings from anon, authenticated;

create function public.media_settings(p_company uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
 if not mavi_private.member(p_company) then raise exception 'Sem permissão' using errcode = '42501'; end if;
 return jsonb_build_object('override_cap', coalesce((
  select s.override_cap from public.media_settings s where s.company_id = p_company), 0));
end $$;

create function public.set_media_override_cap(p_company uuid, p_cap numeric) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
 if not mavi_private.admin(p_company) then
  raise exception 'Só administradores definem o limite da liberação' using errcode = '42501';
 end if;
 if p_cap is null or p_cap < 0 or p_cap >= 1000000000000 then
  raise exception 'Informe um valor de zero para cima' using errcode = '22023';
 end if;
 insert into public.media_settings(company_id, override_cap, updated_by)
 values (p_company, round(p_cap, 2), auth.uid())
 on conflict (company_id) do update set override_cap = excluded.override_cap,
  updated_by = excluded.updated_by, updated_at = now();
 return public.media_settings(p_company);
end $$;

-- ------------------------------------------------------------ reservado
-- O que cada ciclo aberto do produto contratado ainda vai gastar.
create function mavi_private.media_reservations(c uuid, p_contract uuid)
returns table(cycle_id uuid, campaign_id uuid, campaign_name text, start_date date, end_date date,
 budget numeric, spent numeric, remaining numeric)
language sql stable security definer set search_path = '' as $$
 select y.id, a.id, a.name, y.start_date, y.end_date, y.budget, coalesce(s.spent, 0),
  greatest(y.budget - coalesce(s.spent, 0), 0)
 from public.ad_campaigns a
 join public.ad_cycles y on y.company_id = a.company_id and y.campaign_id = a.id
 left join lateral (
  select sum(case e.kind when 'debit' then e.amount else -e.amount end) as spent
  from public.media_entries e where e.cycle_id = y.id and e.source = 'campaign'
 ) s on true
 where a.company_id = c and a.contract_id = p_contract and not a.archived
  and y.end_date >= mavi_private.company_today(c)
$$;
revoke all on function mavi_private.media_reservations(uuid, uuid) from public, anon, authenticated;

-- A trava: nulo quando a verba cabe; senão, a liberação (que o chamador
-- registra no histórico) ou o erro. p_cycle nulo: ciclo novo.
create function mavi_private.media_cycle_guard(a public.ad_campaigns, p_cycle uuid, p_end date,
 p_budget numeric, p_reason text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_today date := mavi_private.company_today(a.company_id); y public.ad_cycles;
 v_spent numeric := 0; v_old numeric := 0; v_need numeric; v_balance numeric; v_reserved numeric;
 v_available numeric; v_short numeric; v_cap numeric; v_reason text := btrim(coalesce(p_reason, '')); begin
 if p_end < v_today then return null; end if;
 -- Dois ciclos ao mesmo tempo na mesma conta não usam o mesmo dinheiro.
 perform pg_advisory_xact_lock(hashtextextended('media_room:' || a.contract_id::text, 0));
 if p_cycle is not null then
  select * into y from public.ad_cycles where id = p_cycle;
  select coalesce(sum(case e.kind when 'debit' then e.amount else -e.amount end), 0) into v_spent
  from public.media_entries e where e.cycle_id = p_cycle and e.source = 'campaign';
  if y.end_date >= v_today then v_old := greatest(y.budget - v_spent, 0); end if;
 end if;
 v_need := greatest(round(p_budget, 2) - v_spent, 0);
 -- Só o aumento conta.
 if v_need <= v_old then return null; end if;
 v_balance := mavi_private.media_balance(a.company_id, a.contract_id);
 select coalesce(sum(r.remaining), 0) into v_reserved
 from mavi_private.media_reservations(a.company_id, a.contract_id) r
 where p_cycle is null or r.cycle_id <> p_cycle;
 v_available := v_balance - v_reserved;
 v_short := v_need - v_available;
 if v_short <= 0 then return null; end if;
 if v_reason = '' then
  raise exception 'Saldo de mídia insuficiente: o disponível para ciclos é %, e o ciclo precisa de %. Faltam %.',
   mavi_private.brl(v_available), mavi_private.brl(v_need), mavi_private.brl(v_short)
   using errcode = 'P0001', hint = 'media_shortfall';
 end if;
 if not mavi_private.leader(a.company_id) then
  raise exception 'Só administradores e gestores liberam verba acima do saldo de mídia. Faltam %.',
   mavi_private.brl(v_short) using errcode = '42501';
 end if;
 v_cap := coalesce((select s.override_cap from public.media_settings s where s.company_id = a.company_id), 0);
 if v_short > v_cap then
  raise exception 'A liberação acima do saldo vai até % nesta empresa, e faltam %.',
   mavi_private.brl(v_cap), mavi_private.brl(v_short) using errcode = 'P0001', hint = 'media_shortfall';
 end if;
 if length(v_reason) < 3 then
  raise exception 'Escreva o motivo da liberação' using errcode = '22023';
 end if;
 return jsonb_build_object('shortfall', v_short, 'available', v_available, 'balance', v_balance,
  'reserved', v_reserved, 'need', v_need, 'budget', round(p_budget, 2), 'cap', v_cap,
  'reason', left(v_reason, 1000));
end $$;
revoke all on function mavi_private.media_cycle_guard(public.ad_campaigns, uuid, date, numeric, text)
 from public, anon, authenticated;

-- ------------------------------------------------------------ o painel da campanha
create function public.ad_media_room(p_campaign uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare a public.ad_campaigns; v_client uuid; v_client_name text; v_product_name text; m public.media_accounts;
 v_today date; v_reserved numeric; v_list jsonb; v_daily numeric; begin
 select * into a from public.ad_campaigns where id = p_campaign;
 select k.client_id, cl.name, p.name into v_client, v_client_name, v_product_name
 from public.contracts k
 join public.clients cl on cl.company_id = k.company_id and cl.id = k.client_id
 join public.products p on p.company_id = k.company_id and p.id = k.product_id
 where k.company_id = a.company_id and k.id = a.contract_id;
 if v_client is null or not mavi_private.module_client(a.company_id, 'campaigns', v_client) then
  raise exception 'Sem permissão' using errcode = '42501';
 end if;
 v_today := mavi_private.company_today(a.company_id);
 select * into m from public.media_accounts x where x.company_id = a.company_id and x.contract_id = a.contract_id;
 select coalesce(sum(r.remaining), 0),
  coalesce(jsonb_agg(jsonb_build_object('cycle_id', r.cycle_id, 'campaign_id', r.campaign_id,
   'campaign_name', r.campaign_name, 'start_date', r.start_date, 'end_date', r.end_date, 'budget', r.budget,
   'spent', r.spent, 'remaining', r.remaining) order by r.start_date, r.campaign_name), '[]')
 into v_reserved, v_list
 from mavi_private.media_reservations(a.company_id, a.contract_id) r;
 -- O ritmo: o gasto × M dos últimos 7 dias completos do produto contratado.
 select coalesce(sum(case e.kind when 'debit' then e.amount else -e.amount end), 0) / 7 into v_daily
 from public.media_entries e
 where e.company_id = a.company_id and e.contract_id = a.contract_id and e.source = 'campaign'
  and e.occurred_on between v_today - 7 and v_today - 1;
 return jsonb_build_object(
  'contract_id', a.contract_id, 'client_name', v_client_name, 'product_name', v_product_name,
  'balance', coalesce(m.balance, 0), 'min_balance', m.min_balance,
  'level', mavi_private.media_level(coalesce(m.balance, 0), m.min_balance),
  'entries', coalesce(m.entries, 0), 'reserved', v_reserved,
  'available', coalesce(m.balance, 0) - v_reserved, 'daily', round(greatest(v_daily, 0), 2),
  'reservations', v_list,
  'override_cap', coalesce((select s.override_cap from public.media_settings s where s.company_id = a.company_id), 0),
  'can_override', mavi_private.leader(a.company_id),
  -- Atalhos para o extrato e o lançamento: só quem usa o Financeiro › Mídia.
  'finance', mavi_private.module_client(a.company_id, 'financeMedia', v_client)
   and not exists (select 1 from public.memberships ms where ms.company_id = a.company_id
    and ms.user_id = auth.uid() and 'financeMedia' = any(ms.hidden_pages)));
end $$;

-- ------------------------------------------------------------ ciclos com a trava
-- As da migração 20270107090000_member_opt_in_full, com p_media_override (o
-- motivo da liberação) e a trava do saldo de mídia.
drop function public.create_ad_cycle(uuid, date, date, date, text, integer, numeric, numeric, text, text[], text,
 jsonb, boolean);
drop function public.update_ad_cycle(uuid, integer, date, date, date, text, integer, numeric, numeric, text, text[],
 text, jsonb);

create function public.create_ad_cycle(p_campaign uuid, p_competence date, p_start date, p_end date,
 p_objective text, p_goal_results integer, p_budget numeric, p_multiplier numeric default null,
 p_destination text default 'external_page', p_landing_pages text[] default '{}', p_niche text default '',
 p_links jsonb default '[]', p_make_current boolean default false, p_media_override text default null) returns uuid
language plpgsql security definer set search_path = '' as $$
declare a public.ad_campaigns; result uuid; inherited numeric; m numeric; links jsonb; release jsonb; begin
 select * into a from public.ad_campaigns where id = p_campaign for update;
 if not found or not (mavi_private.ad_can_write(a.company_id) and mavi_private.module_client(a.company_id, 'campaigns',
  (select k.client_id from public.contracts k where k.company_id = a.company_id and k.id = a.contract_id))) then
  raise exception 'Sem permissão' using errcode = '42501';
 end if;
 if a.archived then raise exception 'Campanha arquivada' using errcode = '22023'; end if;
 perform mavi_private.ad_cycle_checks(a.company_id, a.id, null, p_start, p_end, p_objective, p_goal_results,
  p_budget, p_destination, p_landing_pages);
 release := mavi_private.media_cycle_guard(a, null, p_end, p_budget, p_media_override);
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
 p_links jsonb default '[]', p_media_override text default null) returns void
language plpgsql security definer set search_path = '' as $$
declare y public.ad_cycles; z public.ad_cycles; a public.ad_campaigns; before_links jsonb; links jsonb;
 changes jsonb; release jsonb; begin
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
 if release is not null then
  perform mavi_private.ad_log(a.company_id, a.id, y.id, 'media_override', release);
 end if;
end $$;

revoke all on function public.create_ad_cycle(uuid, date, date, date, text, integer, numeric, numeric, text, text[],
 text, jsonb, boolean, text), public.update_ad_cycle(uuid, integer, date, date, date, text, integer, numeric, numeric,
 text, text[], text, jsonb, text), public.ad_media_room(uuid), public.media_settings(uuid),
 public.set_media_override_cap(uuid, numeric) from public, anon;
grant execute on function public.create_ad_cycle(uuid, date, date, date, text, integer, numeric, numeric, text, text[],
 text, jsonb, boolean, text), public.update_ad_cycle(uuid, integer, date, date, date, text, integer, numeric, numeric,
 text, text[], text, jsonb, text), public.ad_media_room(uuid), public.media_settings(uuid),
 public.set_media_override_cap(uuid, numeric) to authenticated;

commit;
