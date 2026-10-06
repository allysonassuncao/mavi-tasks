begin;

-- Customer Success, fase 3 (pedido de 06/10/2026):
--
-- 1. Regras editáveis com vigência: comissão M1, pesos e faixas do Health
--    Score, pesos e teto do Ranking e as zonas do Recebimento. Só
--    administradores mudam, sempre com motivo, e só do mês atual em diante:
--    os meses fechados nunca mudam. Cada mudança fica no histórico
--    (cs_rules_log), que ninguém altera.
-- 2. As fontes de CS no construtor dos Dashboards (Financeiro, Carteira,
--    Saúde e Trial). Os números saem do mesmo motor do painel CS Make
--    (src/cs-engine.ts, conferido contra o dash antigo), calculado na tela
--    com os dados de cs_dashboard_data; o banco só confere o painel ao salvar
--    (dashboard_check). Só administradores e gestores montam painéis com
--    essas fontes; quem recebe o dashboard vê os números, como no CS Make.

-- ------------------------------------------------------------ regras
create table public.cs_rules_log (
 id uuid primary key default gen_random_uuid(),
 company_id uuid not null references public.companies(id) on delete cascade,
 valid_from date not null,
 action text not null check (action in ('set', 'delete')),
 before jsonb,
 after jsonb,
 reason text not null check (length(reason) between 3 and 500),
 by uuid,
 at timestamptz not null default now()
);
create index cs_rules_log_company on public.cs_rules_log(company_id, at desc);
alter table public.cs_rules_log enable row level security;
revoke all on public.cs_rules_log from public, anon, authenticated;

-- As regras completas a partir das enviadas: só as chaves conhecidas, e o
-- que faltar vem das que valem no mês.
create function mavi_private.cs_rules_pick(base jsonb, p jsonb) returns jsonb
language sql immutable set search_path = '' as $$
 select jsonb_build_object(
  'm1_commission', coalesce(p->'m1_commission', base->'m1_commission'),
  'hs_weights', coalesce(p->'hs_weights', base->'hs_weights'),
  'hs_bands', coalesce(p->'hs_bands', base->'hs_bands'),
  'ranking_weights', coalesce(p->'ranking_weights', base->'ranking_weights'),
  'ranking_realization_cap', coalesce(p->'ranking_realization_cap', base->'ranking_realization_cap'),
  'receiving', coalesce(p->'receiving', base->'receiving'))
$$;
revoke all on function mavi_private.cs_rules_pick(jsonb, jsonb) from public, anon, authenticated;

-- O que está errado nas regras, em palavras (nulo = tudo certo).
create function mavi_private.cs_rules_problem(r jsonb) returns text
language plpgsql immutable set search_path = '' as $$
declare k text; v numeric; total numeric := 0; rec jsonb := r->'receiving'; begin
 begin
  if (r->>'m1_commission')::numeric not between 0 and 100000 then
   return 'A comissão M1 vai de R$ 0 a R$ 100.000.';
  end if;
  foreach k in array array['goal', 'perception', 'payment', 'meeting', 'creatives'] loop
   v := (r->'hs_weights'->>k)::numeric;
   if v is null or v < 0 or v > 100 then return 'Cada peso do Health Score vai de 0 a 100.'; end if;
   total := total + v;
  end loop;
  if total <> 100 then return format('Os pesos do Health Score somam %s; precisam somar 100.', total); end if;
  if (r->'hs_bands'->>'satisfied')::numeric not between 1 and 100
   or (r->'hs_bands'->>'alert')::numeric not between 0 and 99
   or (r->'hs_bands'->>'alert')::numeric >= (r->'hs_bands'->>'satisfied')::numeric then
   return 'As faixas do Health Score: Alerta abaixo de Satisfeito, entre 0 e 100.';
  end if;
  total := 0;
  foreach k in array array['goal', 'hs', 'adimplencia', 'retention', 'graduation', 'realization'] loop
   v := (r->'ranking_weights'->>k)::numeric;
   if v is null or v < 0 or v > 100 then return 'Cada peso do Ranking vai de 0 a 100.'; end if;
   total := total + v;
  end loop;
  if total <= 0 then return 'Pelo menos um critério do Ranking precisa de peso.'; end if;
  if (r->>'ranking_realization_cap')::numeric not between 1 and 3 then
   return 'O teto do Provável realizado vai de 100% a 300%.';
  end if;
  if (rec->>'red_day')::int not between 2 and 31 or (rec->>'yellow_day')::int not between 1 and 30
   or (rec->>'yellow_day')::int >= (rec->>'red_day')::int then
   return 'Recebimento: o dia amarelo vem antes do vermelho (1 a 31).';
  end if;
  if (rec->>'floor_day')::int not between 1 and 30 or (rec->>'floor_day')::int >= (rec->>'red_day')::int then
   return 'Recebimento: o piso das sugestões vem antes do dia vermelho.';
  end if;
  if (rec->>'max_shift_days')::int not between 1 and 15 then
   return 'Recebimento: antecipar de 1 a 15 dias por mês.';
  end if;
  if (rec->>'red_share_high')::numeric not between 1 and 100 or (rec->>'red_share_medium')::numeric not between 1 and 100
   or (rec->>'red_share_medium')::numeric > (rec->>'red_share_high')::numeric then
   return 'Recebimento: o aviso médio da concentração vem antes do alto (1% a 100%).';
  end if;
  if (rec->>'history_months')::int not between 1 and 24 then
   return 'Recebimento: o histórico de pagamento usa de 1 a 24 meses.';
  end if;
 exception when others then
  return 'Regras incompletas ou com valor que não é número.';
 end;
 return null;
end $$;
revoke all on function mavi_private.cs_rules_problem(jsonb) from public, anon, authenticated;

-- As regras para a tela: as que valem hoje, as versões e o histórico.
create function public.cs_rules_admin(p_company uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare cur date; begin
 if not mavi_private.cs_reader(p_company) then
  raise exception 'Sem acesso às regras de Customer Success.' using errcode = '42501';
 end if;
 cur := date_trunc('month', mavi_private.company_today(p_company))::date;
 return jsonb_build_object(
  'defaults', mavi_private.cs_default_rules(),
  'current_month', cur,
  'current', mavi_private.cs_rules_at(p_company, cur),
  'can_edit', mavi_private.admin(p_company),
  'versions', coalesce((select jsonb_agg(jsonb_build_object('valid_from', r.valid_from, 'rules', r.rules,
    'reason', r.reason, 'set_at', r.set_at,
    'set_by_name', (select m.name from public.memberships m where m.company_id = r.company_id and m.user_id = r.set_by))
    order by r.valid_from desc) from public.cs_rules r where r.company_id = p_company), '[]'),
  'log', coalesce((select jsonb_agg(x order by (x->>'at') desc) from (
    select jsonb_build_object('valid_from', l.valid_from, 'action', l.action, 'before', l.before, 'after', l.after,
     'reason', l.reason, 'at', l.at,
     'by_name', (select m.name from public.memberships m where m.company_id = l.company_id and m.user_id = l.by)) x
    from public.cs_rules_log l where l.company_id = p_company order by l.at desc limit 50) t), '[]'));
end $$;

-- Grava (ou troca) as regras que valem a partir de um mês: só
-- administradores, só do mês atual em diante, motivo obrigatório. As notas
-- de HS desses meses são refeitas (pesos e faixas).
create function public.set_cs_rules(p_company uuid, p_valid_from date, p_rules jsonb, p_reason text)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v date := date_trunc('month', p_valid_from)::date; cur date; base jsonb; r jsonb; problem text; old jsonb; begin
 if not mavi_private.admin(p_company) then
  raise exception 'Somente administradores mudam as regras de Customer Success.' using errcode = '42501';
 end if;
 cur := date_trunc('month', mavi_private.company_today(p_company))::date;
 if v is null or v < cur then
  raise exception 'As regras valem do mês atual em diante: os meses fechados não mudam.' using errcode = '22023';
 end if;
 if v > (cur + interval '24 months')::date then
  raise exception 'Escolha um mês nos próximos dois anos.' using errcode = '22023';
 end if;
 if length(btrim(coalesce(p_reason, ''))) < 3 then
  raise exception 'Diga o motivo da mudança.' using errcode = '22023';
 end if;
 if jsonb_typeof(p_rules) <> 'object' then raise exception 'Regras inválidas.' using errcode = '22023'; end if;
 base := mavi_private.cs_rules_at(p_company, v);
 r := mavi_private.cs_rules_pick(base, p_rules);
 problem := mavi_private.cs_rules_problem(r);
 if problem is not null then raise exception '%', problem using errcode = '22023'; end if;
 select rules into old from public.cs_rules where company_id = p_company and valid_from = v;
 insert into public.cs_rules(company_id, valid_from, rules, reason, set_by, set_at)
 values (p_company, v, r, left(btrim(p_reason), 500), auth.uid(), now())
 on conflict (company_id, valid_from) do update set rules = excluded.rules, reason = excluded.reason,
  set_by = excluded.set_by, set_at = excluded.set_at;
 insert into public.cs_rules_log(company_id, valid_from, action, before, after, reason, by)
 values (p_company, v, 'set', coalesce(old, base), r, left(btrim(p_reason), 500), auth.uid());
 -- O gatilho do HS refaz nota e faixa com as regras do mês.
 update public.cs_health_scores set updated_at = now() where company_id = p_company and month >= v;
 perform mavi_private.cs_changed(p_company, 'rules');
 return public.cs_rules_admin(p_company);
end $$;

-- Tira uma versão (do mês atual em diante): os meses voltam às regras de antes.
create function public.delete_cs_rules(p_company uuid, p_valid_from date, p_reason text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v date := date_trunc('month', p_valid_from)::date; old jsonb; begin
 if not mavi_private.admin(p_company) then
  raise exception 'Somente administradores mudam as regras de Customer Success.' using errcode = '42501';
 end if;
 if v < date_trunc('month', mavi_private.company_today(p_company))::date then
  raise exception 'As regras de meses fechados não mudam.' using errcode = '22023';
 end if;
 if length(btrim(coalesce(p_reason, ''))) < 3 then
  raise exception 'Diga o motivo da mudança.' using errcode = '22023';
 end if;
 delete from public.cs_rules where company_id = p_company and valid_from = v returning rules into old;
 if old is null then raise exception 'Essa versão das regras não existe mais.' using errcode = 'P0002'; end if;
 insert into public.cs_rules_log(company_id, valid_from, action, before, after, reason, by)
 values (p_company, v, 'delete', old, mavi_private.cs_rules_at(p_company, v), left(btrim(p_reason), 500), auth.uid());
 update public.cs_health_scores set updated_at = now() where company_id = p_company and month >= v;
 perform mavi_private.cs_changed(p_company, 'rules');
 return public.cs_rules_admin(p_company);
end $$;

-- ------------------------------------------------------------ fontes de CS nos Dashboards
-- As listas abaixo são as de src/dashboard-catalog.ts (cs_finance,
-- cs_portfolio, cs_health, cs_trial): mude as duas juntas.
create function mavi_private.cs_query_check(c uuid, q jsonb, p_group text) returns void
language plpgsql stable security definer set search_path = '' as $$
declare src text := q->>'source'; metrics text[]; groups text[] := array['none', 'time', 'client', 'squad']; f jsonb; begin
 if not mavi_private.cs_reader(c) then
  raise exception 'As fontes de Customer Success são só de administradores e gestores.' using errcode = '42501';
 end if;
 case src
  when 'cs_finance' then
   metrics := array['revenue', 'planned', 'best', 'received', 'open', 'ticket', 'fees', 'goal', 'attainment'];
   groups := groups || array['cs_category', 'cs_adimplencia'];
  when 'cs_portfolio' then
   metrics := array['active', 'payers', 'new', 'reactivations', 'churns', 'net'];
   groups := groups || array['cs_reason'];
  when 'cs_health' then
   metrics := array['hs_avg', 'hs_clients', 'hs_critical', 'adimp_rate', 'cycles'];
   groups := groups || array['cs_band', 'cs_adimplencia', 'cs_category'];
  when 'cs_trial' then
   metrics := array['in_trial', 'graduated', 'grad_rate', 'trial_churns'];
   groups := groups || array['cs_phase'];
  else raise exception 'Fonte de dados inválida: %', src using errcode = '22023';
 end case;
 if not coalesce(q->>'metric', '') = any(metrics) then
  raise exception 'Métrica inválida: %', q->>'metric' using errcode = '22023';
 end if;
 if not p_group = any(groups) then
  raise exception 'Agrupamento inválido para a fonte de Customer Success: %', p_group using errcode = '22023';
 end if;
 if jsonb_typeof(coalesce(q->'filters', '[]'::jsonb)) <> 'array' then
  raise exception 'Filtros inválidos' using errcode = '22023';
 end if;
 for f in select value from jsonb_array_elements(coalesce(q->'filters', '[]'::jsonb)) loop
  if coalesce(f->>'field', '') not in ('client', 'squad', 'cs_kind') or coalesce(f->>'op', 'in') not in ('in', 'not_in')
   or jsonb_typeof(f->'values') <> 'array' or jsonb_array_length(f->'values') > 50 then
   raise exception 'Filtro inválido para a fonte de Customer Success' using errcode = '22023';
  end if;
 end loop;
end $$;
revoke all on function mavi_private.cs_query_check(uuid, jsonb, text) from public, anon, authenticated;

-- Um dashboard tem algum painel com fonte de CS?
create function mavi_private.dashboard_has_cs(p_panels jsonb) returns boolean
language sql immutable set search_path = '' as $$
 select exists (select 1 from jsonb_array_elements(coalesce(p_panels, '[]'::jsonb)) p,
  jsonb_array_elements(coalesce(p->'spec'->'queries', '[]'::jsonb)) q where q->>'source' like 'cs\_%')
$$;
revoke all on function mavi_private.dashboard_has_cs(jsonb) from public, anon, authenticated;

-- Igual à de 20261230090000, mais as fontes de CS (conferidas por
-- cs_query_check; não passam pelo SQL dos Dashboards) e seus agrupamentos.
create or replace function mavi_private.dashboard_check(c uuid, p_panels jsonb, p_variables jsonb) returns void
language plpgsql stable security definer set search_path = '' as $$
declare p jsonb; q jsonb; spec jsonb; ids text[] := '{}'; refs text[]; expr text; cs integer; begin
  if jsonb_typeof(p_panels) <> 'array' or jsonb_array_length(p_panels) > 48 then
    raise exception 'Um dashboard tem até 48 painéis' using errcode = '22023';
  end if;
  if octet_length(p_panels::text) > 300000 then raise exception 'Dashboard grande demais' using errcode = '22023'; end if;
  if jsonb_typeof(coalesce(p_variables, '{}'::jsonb)) <> 'object' then
    raise exception 'Variáveis inválidas' using errcode = '22023';
  end if;
  for p in select value from jsonb_array_elements(p_panels) loop
    if coalesce(p->>'id', '') !~ '^[a-z0-9-]{1,40}$' or p->>'id' = any(ids) then
      raise exception 'Painel com identificador inválido' using errcode = '22023';
    end if;
    ids := ids || (p->>'id');
    if length(coalesce(p->>'title', '')) > 120 then raise exception 'Título de painel longo demais' using errcode = '22023'; end if;
    if jsonb_typeof(p->'x') <> 'number' or jsonb_typeof(p->'y') <> 'number'
     or jsonb_typeof(p->'w') <> 'number' or jsonb_typeof(p->'h') <> 'number'
     or (p->>'x')::int not between 0 and 11 or (p->>'w')::int not between 1 and 12
     or (p->>'x')::int + (p->>'w')::int > 12 or (p->>'y')::int not between 0 and 2000
     or (p->>'h')::int not between 1 and 24 then
      raise exception 'Posição de painel inválida' using errcode = '22023';
    end if;
    spec := p->'spec';
    if coalesce(spec->>'viz', '') not in ('stat', 'line', 'area', 'bar', 'hbar', 'donut', 'table') then
      raise exception 'Visualização inválida' using errcode = '22023';
    end if;
    if coalesce(spec->>'groupBy', 'none') not in
     ('none', 'time', 'client', 'product', 'project', 'team', 'person', 'creator', 'status', 'priority', 'stage',
      'executor', 'previous', 'validator', 'notice', 'level', 'band', 'topic', 'theme', 'severity',
      'squad', 'cs_category', 'cs_adimplencia', 'cs_reason', 'cs_band', 'cs_phase') then
      raise exception 'Agrupamento inválido' using errcode = '22023';
    end if;
    if coalesce(spec->>'interval', 'auto') not in ('auto', 'day', 'week', 'month') then
      raise exception 'Intervalo inválido' using errcode = '22023';
    end if;
    if jsonb_typeof(spec->'queries') <> 'array' or jsonb_array_length(spec->'queries') not between 1 and 5 then
      raise exception 'Cada painel tem de 1 a 5 consultas' using errcode = '22023';
    end if;
    expr := coalesce(spec->'formula'->>'expr', '');
    if length(expr) > 200 or expr !~ '^[A-E0-9+*/(). -]*$' then
      raise exception 'Fórmula inválida: use A a E, números, + - * / e parênteses' using errcode = '22023';
    end if;
    -- Um painel é todo de CS ou todo das outras fontes (o de CS é calculado na tela).
    select count(*) into cs from jsonb_array_elements(spec->'queries') x where x->>'source' like 'cs\_%';
    if cs > 0 and cs < jsonb_array_length(spec->'queries') then
      raise exception 'Um painel não mistura fontes de Customer Success com as outras fontes.' using errcode = '22023';
    end if;
    refs := '{}';
    for q in select value from jsonb_array_elements(spec->'queries') loop
      if coalesce(q->>'ref', '') !~ '^[A-E]$' or q->>'ref' = any(refs) then
        raise exception 'Consulta inválida' using errcode = '22023';
      end if;
      refs := refs || (q->>'ref');
      if cs > 0 then
        perform mavi_private.cs_query_check(c, q, coalesce(spec->>'groupBy', 'none'));
      else
        perform mavi_private.dashboard_sql(c, q, coalesce(spec->>'groupBy', 'none'), 'month',
         current_date, current_date, coalesce(p_variables->'filters', '{}'::jsonb), 10);
      end if;
    end loop;
  end loop;
end $$;
revoke all on function mavi_private.dashboard_check(uuid, jsonb, jsonb) from public, anon, authenticated;

-- Os dados de CS de um dashboard: o painel CS Make ou um dashboard com
-- painéis de CS (igual à de 20270522090000, mais o segundo caso).
create or replace function public.cs_dashboard_data(p_dashboard uuid, p_token text default null, p_password text default null)
returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare d public.dashboards; acc text; begin
 if p_token is not null then select * into d from public.dashboards where share_token = p_token;
 else select * into d from public.dashboards where id = p_dashboard; end if;
 if not found or not (d.kind = 'cs' or mavi_private.dashboard_has_cs(d.panels)) then
  raise exception 'Painel de CS não encontrado.' using errcode = 'P0002';
 end if;
 acc := mavi_private.dashboard_access(d, p_token, p_password);
 if acc = 'locked' then return jsonb_build_object('error', 'Muitas tentativas. Tente novamente em alguns minutos.'); end if;
 if acc = 'password' then return jsonb_build_object('error', 'Senha incorreta.'); end if;
 if acc is null then raise exception 'Sem acesso a este dashboard' using errcode = '42501'; end if;
 return mavi_private.cs_snapshot(d.company_id) || jsonb_build_object('access', acc);
end $$;

-- A base de CS da empresa para quem monta painéis (prévia no editor, MAVI).
create function public.cs_company_data(p_company uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
 if not mavi_private.cs_reader(p_company) then
  raise exception 'As fontes de Customer Success são só de administradores e gestores.' using errcode = '42501';
 end if;
 return mavi_private.cs_snapshot(p_company) || jsonb_build_object('access', 'editor');
end $$;

revoke all on function public.cs_rules_admin(uuid), public.set_cs_rules(uuid, date, jsonb, text),
 public.delete_cs_rules(uuid, date, text), public.cs_company_data(uuid) from public, anon;
grant execute on function public.cs_rules_admin(uuid), public.set_cs_rules(uuid, date, jsonb, text),
 public.delete_cs_rules(uuid, date, text), public.cs_company_data(uuid) to authenticated;

notify pgrst, 'reload schema';

commit;
