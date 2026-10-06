begin;

-- Customer Success, fase 2 (pedido de 06/10/2026): o painel "CS Make" dentro
-- de Dashboards, com os blocos, as janelas de detalhe, a calculadora, o
-- Recebimento e o Ranking do dash antigo.
--
-- O painel é um tipo de dashboard ('cs'): a lista, o compartilhamento
-- (pessoas, equipes, link com senha ou público) e o acesso são os de
-- Dashboards. No lugar da grade de gráficos, a tela desenha o painel de CS
-- com o motor src/cs-engine.ts (porta fiel das regras do PHP, conferida
-- número a número contra o dash antigo por scripts/cs-parity.ts).
--
-- cs_dashboard_data devolve a base de CS inteira de uma vez (centenas de
-- clientes, ~600 ciclos por ano): as regras (M1, categoria histórica, squad
-- do mês, aniversário do trial) são intrincadas demais para agregar em SQL
-- genérico, e o mesmo motor serve ao link público e, na fase 4, à MAVI.

-- ------------------------------------------------------------ tipo do dashboard
alter table public.dashboards add column kind text not null default 'grid' check (kind in ('grid', 'cs'));
comment on column public.dashboards.kind is
 'grid: painéis do construtor; cs: o painel pronto de Customer Success (20270522090000).';
grant select (kind) on public.dashboards to authenticated;

-- Cria o painel de CS (administradores e gestores: quem lê os dados de CS).
create function public.create_cs_dashboard(p_company uuid, p_name text, p_description text default '')
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare d public.dashboards; begin
 if not mavi_private.cs_reader(p_company) then
  raise exception 'Somente administradores e gestores criam o painel de Customer Success.' using errcode = '42501';
 end if;
 if length(btrim(coalesce(p_name, ''))) not between 2 and 120 then
  raise exception 'Informe um nome de 2 a 120 caracteres.' using errcode = '22023';
 end if;
 insert into public.dashboards(company_id, name, description, panels, variables, kind, updated_by)
 values (p_company, btrim(p_name), left(coalesce(p_description, ''), 500), '[]', '{}', 'cs', auth.uid())
 returning * into d;
 return to_jsonb(d) - 'password_hash';
end $$;

-- ------------------------------------------------------------ ordem das fotos de replanejamento
-- Duas fotos podem ter o mesmo instante (a leitura grava várias numa rodada):
-- a ordem de gravação desempata, para o trajeto da cobrança sair na ordem certa.
alter table public.cs_cycle_history add column seq bigint generated always as identity;
create index cs_cycle_history_seq on public.cs_cycle_history(company_id, month, recorded_at, seq);

-- ------------------------------------------------------------ os dados
-- A base de CS de uma empresa, no formato que o motor recebe (CsData).
create function mavi_private.cs_snapshot(c uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
 select jsonb_build_object(
  'today', mavi_private.company_today(c),
  'squads', coalesce((select jsonb_agg(jsonb_build_object('id', s.id, 'name', s.name, 'color', s.color, 'sort', s.sort,
    'archived', s.archived) order by s.sort, s.name) from public.cs_squads s where s.company_id = c), '[]'),
  'clients', coalesce((select jsonb_agg(jsonb_build_object('id', k.id, 'external_id', k.external_id, 'name', k.name,
    'squad_id', k.squad_id, 'vertical', k.vertical, 'origin', k.origin, 'kind', k.kind, 'trial_month', k.trial_month,
    'status', k.status, 'entry_date', k.entry_date, 'churn_date', k.churn_date, 'reactivation_date', k.reactivation_date,
    'churn_reason', k.churn_reason, 'notes', k.notes, 'client_id', k.client_id)
    order by lpad(k.external_id, 20, '0')) from public.cs_clients k where k.company_id = c), '[]'),
  'cycles', coalesce((select jsonb_agg(jsonb_build_object('id', y.id, 'client', y.cs_client_id, 'month', y.month,
    'squad_id', y.squad_id, 'start_date', y.start_date, 'end_date', y.end_date, 'billing_date', y.billing_date,
    'best', y.best, 'probable', y.probable, 'probability', y.probability, 'paid', y.paid, 'paid_date', y.paid_date,
    'status', y.status, 'adimplencia', y.adimplencia, 'acl', y.acl, 'acl_value', y.acl_value,
    'fee_planned', y.fee_planned, 'fee_paid', y.fee_paid, 'm1_discounted', y.m1_discounted)
    order by y.month, y.created_at) from public.cs_cycles y where y.company_id = c), '[]'),
  'payments', coalesce((select jsonb_agg(jsonb_build_object('cycle', p.cycle_id, 'ord', p.ord, 'date', p.paid_date,
    'amount', p.amount) order by p.cycle_id, p.ord) from public.cs_cycle_payments p where p.company_id = c), '[]'),
  'hs', coalesce((select jsonb_agg(jsonb_build_object('client', h.cs_client_id, 'month', h.month,
    'creatives', h.creatives, 'meeting', h.meeting, 'payment', h.payment, 'perception', h.perception, 'goal', h.goal,
    'score', h.score, 'band', h.band) order by h.month, lpad(k.external_id, 20, '0'))
    from public.cs_health_scores h join public.cs_clients k on k.id = h.cs_client_id where h.company_id = c), '[]'),
  'goals', coalesce((select jsonb_agg(jsonb_build_object('squad_id', g.squad_id, 'month', g.month, 'revenue', g.revenue,
    'retention_pct', g.retention_pct, 'ticket', g.ticket) order by g.month) from public.cs_goals g where g.company_id = c), '[]'),
  'events', coalesce((select jsonb_agg(jsonb_build_object('client', e.cs_client_id, 'kind', e.kind, 'date', e.date,
    'churn_reason', e.churn_reason) order by e.date) from public.cs_client_events e where e.company_id = c), '[]'),
  'history', coalesce((select jsonb_agg(jsonb_build_object('client', h.cs_client_id, 'month', h.month,
    'end_date', h.end_date, 'billing_date', h.billing_date, 'probable', h.probable, 'recorded_at', h.recorded_at)
    order by h.recorded_at, h.seq) from public.cs_cycle_history h where h.company_id = c), '[]'),
  'official_revenue', coalesce((select jsonb_agg(jsonb_build_object('squad_id', o.squad_id, 'month', o.month,
    'achieved', o.achieved)) from public.cs_official_revenue o where o.company_id = c), '[]'),
  'multipliers', coalesce((select jsonb_agg(jsonb_build_object('client', m.cs_client_id, 'month', m.month,
    'value', m.value)) from public.cs_multipliers m where m.company_id = c), '[]'),
  'rules', coalesce((select jsonb_agg(jsonb_build_object('valid_from', r.valid_from, 'rules', r.rules)
    order by r.valid_from) from public.cs_rules r where r.company_id = c), '[]'),
  'sync', (select jsonb_build_object('finished_at', x.finished_at, 'status', x.status,
    'warnings', cardinality(x.warnings))
    from public.cs_sync_runs x where x.company_id = c order by x.started_at desc limit 1)
 )
$$;
revoke all on function mavi_private.cs_snapshot(uuid) from public, anon, authenticated;

-- Os dados do painel de CS: quem abre o dashboard (pessoas e equipes com
-- acesso, administradores e gestores) ou o link (público ou com senha).
create function public.cs_dashboard_data(p_dashboard uuid, p_token text default null, p_password text default null)
returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare d public.dashboards; acc text; begin
 if p_token is not null then select * into d from public.dashboards where share_token = p_token;
 else select * into d from public.dashboards where id = p_dashboard; end if;
 if not found or d.kind <> 'cs' then raise exception 'Painel de CS não encontrado.' using errcode = 'P0002'; end if;
 acc := mavi_private.dashboard_access(d, p_token, p_password);
 if acc = 'locked' then return jsonb_build_object('error', 'Muitas tentativas. Tente novamente em alguns minutos.'); end if;
 if acc = 'password' then return jsonb_build_object('error', 'Senha incorreta.'); end if;
 if acc is null then raise exception 'Sem acesso a este dashboard' using errcode = '42501'; end if;
 return mavi_private.cs_snapshot(d.company_id) || jsonb_build_object('access', acc);
end $$;
revoke all on function public.cs_dashboard_data(uuid, text, text) from public;
grant execute on function public.cs_dashboard_data(uuid, text, text) to anon, authenticated;

-- O link: o tipo do dashboard entra na resposta (a página pública escolhe
-- a tela). Igual à de 20270224090000 mais o campo kind.
create or replace function public.dashboard_shared(p_token text, p_password text default null) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare d public.dashboards; acc text; begin
  select * into d from public.dashboards where share_token = p_token;
  if not found or d.link_access = 'none' then
    raise exception 'Link inválido ou dashboard indisponível.' using errcode = 'P0002';
  end if;
  acc := mavi_private.dashboard_access(d, p_token, p_password);
  if acc = 'locked' then return jsonb_build_object('status', 'locked'); end if;
  if acc = 'password' then
    return jsonb_build_object('status', 'password', 'wrong', nullif(p_password, '') is not null);
  end if;
  if acc is null then raise exception 'Link inválido ou dashboard indisponível.' using errcode = 'P0002'; end if;
  return jsonb_build_object('status', 'ok', 'id', d.id, 'name', d.name, 'description', d.description,
   'panels', d.panels, 'variables', d.variables, 'updated_at', d.updated_at, 'records', d.link_records,
   'kind', d.kind,
   'timezone', (select timezone from public.companies where id = d.company_id),
   'company', (select name from public.companies where id = d.company_id));
end $$;

revoke all on function public.create_cs_dashboard(uuid, text, text) from public, anon;
grant execute on function public.create_cs_dashboard(uuid, text, text) to authenticated;

notify pgrst, 'reload schema';

commit;
