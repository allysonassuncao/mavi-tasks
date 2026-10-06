begin;

-- Customer Success, fase 1 (pedido de 06/10/2026): o dashboard de CS da Make
-- (~/Desktop/github/cs-make-dashboard, PHP + MySQL + planilha) passa a viver
-- no MAVI. Nesta fase: a base de dados, os Squads (configuráveis como as
-- Equipes, mas separados delas), a leitura da planilha mestre do Google e a
-- ligação de cada cliente de CS ao cliente do MAVI.
--
-- Decisões do usuário:
--  * A planilha continua sendo a fonte da verdade por enquanto. O MAVI lê a
--    planilha (link público, exportação CSV de cada aba) a cada 10 minutos e
--    no "Sincronizar agora". As regras da leitura são as do dash antigo
--    (lib/sync-planilha.php): o que some da aba some do banco, com as mesmas
--    salvaguardas, e mais uma: sumiço em massa espera confirmação.
--  * O ciclo de CS é financeiro e não tem ligação com os ciclos das
--    Campanhas nem com Financeiro › Mídia.
--  * Squads são separados das Equipes. O squad de cada mês fica no ciclo
--    (cs_cycles.squad_id; nulo = herda o squad atual do cliente).
--  * O cliente de CS é ligado ao cliente do MAVI pelo código do MASO
--    (o número do começo do nome do cliente) ou pelo nome, e a ligação pode
--    ser corrigida à mão.
--  * As regras (comissão M1, pesos e faixas do Health Score, Ranking,
--    Recebimento) têm data de vigência (cs_rules). A tela de edição vem na
--    fase 3; os valores padrão são os do dash antigo.
--
-- Tudo passa pelas funções abaixo (nenhuma tabela é lida direto pelo
-- navegador). Nesta fase só administradores e gestores leem os dados de CS;
-- o painel em Dashboards (fase 2) abre o acesso para quem o painel liberar.

-- ------------------------------------------------------------ squads
create table public.cs_squads (
 id uuid primary key default gen_random_uuid(),
 company_id uuid not null references public.companies(id),
 name text not null check (length(btrim(name)) between 2 and 60),
 color text not null default '#8576cf' check (color ~ '^#[0-9a-f]{6}$'),
 -- Outros nomes do squad na planilha ("Squad 3", "Tão", "2"): a leitura
 -- reconhece o nome, cada apelido e qualquer texto que comece com eles.
 aliases text[] not null default '{}' check (cardinality(aliases) <= 20),
 sort integer not null default 0,
 archived boolean not null default false,
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 unique (company_id, id)
);
create unique index cs_squads_name on public.cs_squads(company_id, lower(btrim(name)));

-- As pessoas do squad e quem lidera (pode haver mais de um líder).
create table public.cs_squad_members (
 company_id uuid not null,
 squad_id uuid not null,
 user_id uuid not null,
 leader boolean not null default false,
 primary key (company_id, squad_id, user_id),
 foreign key (company_id, squad_id) references public.cs_squads(company_id, id) on delete cascade,
 foreign key (company_id, user_id) references public.memberships(company_id, user_id)
);

-- ------------------------------------------------------------ regras
-- Cada linha muda as regras a partir de um mês (valid_from). As chaves de
-- `rules` substituem as do padrão; os meses anteriores não mudam.
create table public.cs_rules (
 company_id uuid not null references public.companies(id),
 valid_from date not null check (extract(day from valid_from) = 1),
 rules jsonb not null check (jsonb_typeof(rules) = 'object'),
 reason text not null default '' check (length(reason) <= 500),
 set_by uuid,
 set_at timestamptz not null default now(),
 primary key (company_id, valid_from)
);

-- ------------------------------------------------------------ configuração
create table public.cs_settings (
 company_id uuid primary key references public.companies(id) on delete cascade,
 sheet_id text check (sheet_id ~ '^[A-Za-z0-9_-]{20,100}$'),
 enabled boolean not null default true,
 updated_by uuid,
 updated_at timestamptz not null default now(),
 -- A rodada do agendamento: quando tentou e quem está lendo agora.
 last_attempt_at timestamptz,
 claimed_at timestamptz
);

-- ------------------------------------------------------------ clientes
create table public.cs_clients (
 id uuid primary key default gen_random_uuid(),
 company_id uuid not null references public.companies(id),
 -- O ID da planilha (o código do cliente no MASO).
 external_id text not null check (external_id ~ '^[0-9]{1,20}$'),
 name text not null check (length(btrim(name)) between 1 and 200),
 -- O squad de AGORA. O dos meses passados fica em cs_cycles.squad_id.
 squad_id uuid not null,
 vertical text check (length(vertical) <= 120),
 origin text not null check (origin in ('comercial', 'reativacao', 'troca')),
 kind text not null default 'BASE' check (kind in ('TRIAL', 'BASE', 'BASE_RA')),
 -- Meses de trial cumpridos ao graduar (fica preenchido depois da graduação).
 trial_month smallint check (trial_month between 0 and 120),
 status text not null default 'ATIVO' check (status in ('ATIVO', 'MAKE_IN', 'INATIVO')),
 entry_date date not null,
 churn_date date,
 reactivation_date date,
 churn_reason text check (churn_reason in ('performance', 'financeiro', 'fechou', 'estrategia')),
 notes text check (length(notes) <= 5000),
 -- O cliente do MAVI. 'auto': a leitura liga pelo código ou pelo nome;
 -- 'manual': alguém escolheu (inclusive "sem cliente") e a leitura não mexe.
 client_id uuid,
 link_mode text not null default 'auto' check (link_mode in ('auto', 'manual')),
 link_rule text check (link_rule in ('code', 'name', 'manual')),
 linked_by uuid,
 linked_at timestamptz,
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 unique (company_id, id),
 unique (company_id, external_id),
 foreign key (company_id, squad_id) references public.cs_squads(company_id, id),
 foreign key (company_id, client_id) references public.clients(company_id, id) on delete set null (client_id)
);
create index cs_clients_client on public.cs_clients(company_id, client_id) where client_id is not null;
create index cs_clients_squad on public.cs_clients(company_id, squad_id);

-- Histórico das ligações com o cliente do MAVI (by nulo: a leitura).
create table public.cs_client_link_log (
 id uuid primary key default gen_random_uuid(),
 company_id uuid not null references public.companies(id),
 cs_client_id uuid not null,
 client_id uuid,
 previous_client_id uuid,
 mode text not null check (mode in ('auto', 'manual')),
 rule text,
 by uuid,
 at timestamptz not null default now(),
 foreign key (company_id, cs_client_id) references public.cs_clients(company_id, id) on delete cascade
);
create index cs_client_link_log_client on public.cs_client_link_log(company_id, cs_client_id, at desc);

-- Pares antigos de churn/reativação de quem churnou de novo (aba EVENTOS).
-- O par atual fica em cs_clients.churn_date/reactivation_date.
create table public.cs_client_events (
 id uuid primary key default gen_random_uuid(),
 company_id uuid not null,
 cs_client_id uuid not null,
 kind text not null check (kind in ('CHURN', 'REATIVACAO')),
 date date not null,
 churn_reason text check (churn_reason in ('performance', 'financeiro', 'fechou', 'estrategia')),
 created_at timestamptz not null default now(),
 unique (company_id, cs_client_id, kind, date),
 foreign key (company_id, cs_client_id) references public.cs_clients(company_id, id) on delete cascade
);
create index cs_client_events_date on public.cs_client_events(company_id, date);

-- ------------------------------------------------------------ ciclos
-- Um ciclo por cliente por mês de competência (aba "LANÇAMENTO MMM AAAA").
create table public.cs_cycles (
 id uuid primary key default gen_random_uuid(),
 company_id uuid not null,
 cs_client_id uuid not null,
 month date not null check (extract(day from month) = 1),
 -- O squad daquele mês; nulo = o squad atual do cliente.
 squad_id uuid,
 start_date date,
 end_date date,
 billing_date date,
 best numeric(14,2) not null default 0,
 probable numeric(14,2) not null default 0,
 probability text not null default 'PROVAVEL' check (probability in ('ALTA', 'PROVAVEL', 'BAIXA')),
 paid numeric(14,2) not null default 0,
 paid_date date,
 status text not null default 'PENDENTE' check (status in ('PAGO', 'PARCIAL', 'PENDENTE', 'PERDA', 'ISENTO')),
 adimplencia text not null default 'ADIMPLENTE' check (adimplencia in ('ADIMPLENTE', 'INADIMPLENTE', 'PERDA')),
 -- ACL: o ciclo inteiro (acl sem valor) ou só uma parcela (acl_value).
 acl boolean not null default false,
 acl_value numeric(14,2) check (acl_value > 0),
 -- Mensalidade pós-graduação: à parte, fora da meta e do faturamento.
 fee_planned numeric(14,2) check (fee_planned > 0),
 fee_paid numeric(14,2) check (fee_paid > 0),
 -- O valor pago já veio sem a comissão M1 (dados antigos importados).
 m1_discounted boolean not null default false,
 notes text check (length(notes) <= 5000),
 source text not null default 'sheet' check (source in ('sheet', 'import', 'app')),
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 check (acl or acl_value is null),
 unique (company_id, id),
 unique (company_id, cs_client_id, month),
 foreign key (company_id, cs_client_id) references public.cs_clients(company_id, id) on delete cascade,
 foreign key (company_id, squad_id) references public.cs_squads(company_id, id)
);
create index cs_cycles_month on public.cs_cycles(company_id, month);
create index cs_cycles_paid_date on public.cs_cycles(company_id, paid_date) where paid_date is not null;
create index cs_cycles_billing on public.cs_cycles(company_id, billing_date) where billing_date is not null;

-- Pagamento picado: cada entrada do ciclo (colunas PgtoNData/PgtoNValor).
create table public.cs_cycle_payments (
 company_id uuid not null,
 cycle_id uuid not null,
 ord smallint not null check (ord between 1 and 12),
 paid_date date not null,
 amount numeric(14,2) not null check (amount > 0),
 primary key (company_id, cycle_id, ord),
 foreign key (company_id, cycle_id) references public.cs_cycles(company_id, id) on delete cascade
);
create index cs_cycle_payments_date on public.cs_cycle_payments(company_id, paid_date);

-- Replanejamento: uma foto a cada mudança de fim do ciclo, cobrança ou
-- provável (a planilha sobrescreve; sem isso o ciclo que desliza três
-- semanas parece "sempre foi assim").
create table public.cs_cycle_history (
 id uuid primary key default gen_random_uuid(),
 company_id uuid not null,
 cs_client_id uuid not null,
 month date not null,
 end_date date,
 billing_date date,
 probable numeric(14,2),
 recorded_at timestamptz not null default now(),
 foreign key (company_id, cs_client_id) references public.cs_clients(company_id, id) on delete cascade
);
create index cs_cycle_history_cycle on public.cs_cycle_history(company_id, cs_client_id, month, recorded_at desc);

-- ------------------------------------------------------------ health score
create table public.cs_health_scores (
 company_id uuid not null,
 cs_client_id uuid not null,
 month date not null check (extract(day from month) = 1),
 creatives boolean not null default false,
 meeting boolean not null default false,
 payment boolean not null default false,
 perception boolean not null default false,
 goal boolean not null default false,
 -- Só a nota (sem os critérios), como nos meses importados.
 manual_score numeric(5,2) check (manual_score between 0 and 100),
 -- Calculados pelo gatilho com as regras do mês.
 score numeric(5,2) not null default 0,
 band text not null default 'CRITICO' check (band in ('SATISFEITO', 'ALERTA', 'CRITICO')),
 collection smallint check (collection between 1 and 9),
 notes text check (length(notes) <= 5000),
 source text not null default 'sheet' check (source in ('sheet', 'import', 'app')),
 updated_at timestamptz not null default now(),
 primary key (company_id, cs_client_id, month),
 foreign key (company_id, cs_client_id) references public.cs_clients(company_id, id) on delete cascade
);
create index cs_health_scores_month on public.cs_health_scores(company_id, month);

-- ------------------------------------------------------------ metas
create table public.cs_goals (
 company_id uuid not null,
 squad_id uuid not null,
 month date not null check (extract(day from month) = 1),
 revenue numeric(14,2) not null check (revenue >= 0),
 retention_pct numeric(6,2),
 ticket numeric(14,2),
 notes text check (length(notes) <= 2000),
 updated_at timestamptz not null default now(),
 primary key (company_id, squad_id, month),
 foreign key (company_id, squad_id) references public.cs_squads(company_id, id)
);

-- ------------------------------------------------------------ dados do dash antigo
-- Estas tabelas não estão na planilha: vêm da cópia do MySQL do dash
-- (importação da fase 1b).
-- Faturamento oficial de um squad no mês (rodapés da planilha antiga).
create table public.cs_official_revenue (
 company_id uuid not null,
 squad_id uuid not null,
 month date not null check (extract(day from month) = 1),
 total numeric(14,2) not null,
 achieved numeric(14,2) not null,
 base_id_compl numeric(14,2) not null default 0,
 new_tp_a numeric(14,2) not null default 0,
 reactivation numeric(14,2) not null default 0,
 note text check (length(note) <= 500),
 primary key (company_id, squad_id, month),
 foreign key (company_id, squad_id) references public.cs_squads(company_id, id)
);
-- O M (índice de performance) do cliente no mês, do dash antigo.
create table public.cs_multipliers (
 company_id uuid not null,
 cs_client_id uuid not null,
 month date not null check (extract(day from month) = 1),
 value numeric(8,2) not null,
 notes text,
 primary key (company_id, cs_client_id, month),
 foreign key (company_id, cs_client_id) references public.cs_clients(company_id, id) on delete cascade
);
-- Movimentações registradas à mão no dash antigo (perfil do cliente).
create table public.cs_movements (
 id uuid primary key default gen_random_uuid(),
 company_id uuid not null,
 cs_client_id uuid not null,
 kind text not null check (kind in ('ENTRADA', 'GRADUACAO', 'TROCA_SQUAD', 'REATIVACAO', 'CHURN', 'MAKE_IN_TO_ATIVO', 'EDICAO')),
 date date not null,
 phase_before text,
 phase_after text,
 squad_before uuid,
 squad_after uuid,
 churn_reason text check (churn_reason in ('performance', 'financeiro', 'fechou', 'estrategia')),
 notes text,
 by_name text,
 created_at timestamptz not null default now(),
 foreign key (company_id, cs_client_id) references public.cs_clients(company_id, id) on delete cascade
);
create index cs_movements_client on public.cs_movements(company_id, cs_client_id, date desc);
-- A qualidade dos dados de cada mês (avisos do dash antigo).
create table public.cs_data_quality (
 company_id uuid not null,
 squad_id uuid,
 month date not null check (extract(day from month) = 1),
 status text not null check (status in ('OK', 'SEM_DADOS', 'PARCIAL_DETALHE', 'DIVERGENTE', 'AVISO_MANUAL')),
 source text not null default 'agregada' check (source in ('agregada', 'detalhada', 'ambas', 'nenhuma')),
 aggregated numeric(14,2),
 detailed numeric(14,2),
 divergence_pct numeric(6,2),
 note text check (length(note) <= 500),
 updated_at timestamptz not null default now(),
 foreign key (company_id, squad_id) references public.cs_squads(company_id, id)
);
create unique index cs_data_quality_key on public.cs_data_quality(company_id, coalesce(squad_id, '00000000-0000-0000-0000-000000000000'::uuid), month);

-- ------------------------------------------------------------ leituras
create table public.cs_sync_runs (
 id uuid primary key default gen_random_uuid(),
 company_id uuid not null references public.companies(id) on delete cascade,
 trigger text not null check (trigger in ('schedule', 'manual')),
 by uuid,
 started_at timestamptz not null default now(),
 finished_at timestamptz not null default now(),
 status text not null check (status in ('ok', 'warning', 'error')),
 stats jsonb not null default '{}',
 tabs jsonb not null default '[]',
 warnings text[] not null default '{}',
 -- O que sumiu da planilha em massa e espera confirmação para sair do banco.
 blocked jsonb,
 error text
);
create index cs_sync_runs_company on public.cs_sync_runs(company_id, started_at desc);

-- ------------------------------------------------------------ acesso
alter table public.cs_squads enable row level security;
alter table public.cs_squad_members enable row level security;
alter table public.cs_rules enable row level security;
alter table public.cs_settings enable row level security;
alter table public.cs_clients enable row level security;
alter table public.cs_client_link_log enable row level security;
alter table public.cs_client_events enable row level security;
alter table public.cs_cycles enable row level security;
alter table public.cs_cycle_payments enable row level security;
alter table public.cs_cycle_history enable row level security;
alter table public.cs_health_scores enable row level security;
alter table public.cs_goals enable row level security;
alter table public.cs_official_revenue enable row level security;
alter table public.cs_multipliers enable row level security;
alter table public.cs_movements enable row level security;
alter table public.cs_data_quality enable row level security;
alter table public.cs_sync_runs enable row level security;
revoke all on public.cs_squads, public.cs_squad_members, public.cs_rules, public.cs_settings,
 public.cs_clients, public.cs_client_link_log, public.cs_client_events, public.cs_cycles,
 public.cs_cycle_payments, public.cs_cycle_history, public.cs_health_scores, public.cs_goals,
 public.cs_official_revenue, public.cs_multipliers, public.cs_movements, public.cs_data_quality,
 public.cs_sync_runs
 from public, anon, authenticated;

-- Quem vê os dados de CS nesta fase: administradores e gestores.
create function mavi_private.cs_reader(c uuid) returns boolean
language sql stable security definer set search_path = '' as $$
 select c is not null and mavi_private.leader(c)
$$;
revoke all on function mavi_private.cs_reader(uuid) from public, anon, authenticated;

create function mavi_private.cs_changed(c uuid, p_scope text) returns void
language sql security definer set search_path = '' as $$
 select mavi_private.broadcast(c, jsonb_build_object('kind', 'cs', 'scope', p_scope))
$$;
revoke all on function mavi_private.cs_changed(uuid, text) from public, anon, authenticated;

-- ------------------------------------------------------------ regras
-- Os valores do dash antigo (lib/calculos.php, lib/recebimento.php,
-- ranking_criterios(), gatilho do health_score_mensal).
create function mavi_private.cs_default_rules() returns jsonb
language sql immutable set search_path = '' as $$
 select jsonb_build_object(
  'm1_commission', 3000,
  'hs_weights', jsonb_build_object('goal', 30, 'perception', 25, 'payment', 20, 'meeting', 15, 'creatives', 10),
  'hs_bands', jsonb_build_object('satisfied', 80, 'alert', 50),
  'ranking_weights', jsonb_build_object('goal', 35, 'hs', 20, 'adimplencia', 15, 'retention', 15,
   'graduation', 10, 'realization', 5),
  'ranking_realization_cap', 1.2,
  'receiving', jsonb_build_object('red_day', 26, 'yellow_day', 22, 'max_shift_days', 5, 'floor_day', 20,
   'red_share_high', 35, 'red_share_medium', 25, 'history_months', 6))
$$;
revoke all on function mavi_private.cs_default_rules() from public, anon, authenticated;

-- As regras que valem no mês: o padrão com as mudanças vigentes, em ordem.
create function mavi_private.cs_rules_at(c uuid, p_month date) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare r jsonb := mavi_private.cs_default_rules(); x record; begin
 for x in select rules from public.cs_rules
  where company_id = c and valid_from <= date_trunc('month', p_month)::date order by valid_from loop
  r := r || x.rules;
 end loop;
 return r;
end $$;
revoke all on function mavi_private.cs_rules_at(uuid, date) from public, anon, authenticated;

-- Health Score: com algum critério marcado, a nota é a soma dos pesos; sem
-- critério, vale a nota digitada (meses antigos). A faixa vem da nota.
create function mavi_private.cs_health_score_calc() returns trigger
language plpgsql security definer set search_path = '' as $$
declare r jsonb := mavi_private.cs_rules_at(new.company_id, new.month); w jsonb := r->'hs_weights'; begin
 if not (new.creatives or new.meeting or new.payment or new.perception or new.goal)
  and coalesce(new.manual_score, 0) > 0 then
  new.score := new.manual_score;
 else
  new.score := least(100, greatest(0,
   case when new.creatives then coalesce((w->>'creatives')::numeric, 0) else 0 end
   + case when new.meeting then coalesce((w->>'meeting')::numeric, 0) else 0 end
   + case when new.payment then coalesce((w->>'payment')::numeric, 0) else 0 end
   + case when new.perception then coalesce((w->>'perception')::numeric, 0) else 0 end
   + case when new.goal then coalesce((w->>'goal')::numeric, 0) else 0 end));
 end if;
 new.band := case
  when new.score >= coalesce((r->'hs_bands'->>'satisfied')::numeric, 80) then 'SATISFEITO'
  when new.score >= coalesce((r->'hs_bands'->>'alert')::numeric, 50) then 'ALERTA'
  else 'CRITICO' end;
 new.updated_at := now();
 return new;
end $$;
revoke all on function mavi_private.cs_health_score_calc() from public, anon, authenticated;
create trigger cs_health_score_calc before insert or update on public.cs_health_scores
 for each row execute function mavi_private.cs_health_score_calc();

-- Os motivos de churn (os do dash antigo; "evitável" separa o que a Make
-- poderia ter impedido).
create function mavi_private.cs_churn_reasons()
returns table(key text, label text, avoidable boolean, sort integer)
language sql immutable set search_path = '' as $$
 values ('performance', 'Performance abaixo da expectativa', true, 1),
  ('financeiro', 'Financeiro / inadimplência', true, 2),
  ('fechou', 'Empresa fechou ou pivotou', false, 3),
  ('estrategia', 'Mudança de estratégia interna', false, 4)
$$;
grant execute on function mavi_private.cs_churn_reasons() to authenticated;

-- ------------------------------------------------------------ squads: leitura
-- O nome e os apelidos de cada squad, como a leitura compara (sem acento,
-- minúsculas).
create function mavi_private.cs_squad_keys(c uuid) returns table(squad_id uuid, key text)
language sql stable security definer set search_path = '' as $$
 select s.id, k.key
 from public.cs_squads s
 cross join lateral unnest(array[s.name] || s.aliases) as a(raw)
 cross join lateral (select mavi_private.fold(btrim(a.raw)) as key) k
 where s.company_id = c and k.key <> ''
$$;
revoke all on function mavi_private.cs_squad_keys(uuid) from public, anon, authenticated;

-- O squad de um texto da planilha: igual ao nome ou a um apelido, ou
-- começando com eles ("Primogênito" começa com o apelido "Primog").
-- Apelidos só de números ("2") precisam ser iguais.
create function mavi_private.cs_squad_match(c uuid, p_raw text) returns uuid
language sql stable security definer set search_path = '' as $$
 select k.squad_id
 from mavi_private.cs_squad_keys(c) k,
  (select mavi_private.fold(btrim(coalesce(p_raw, ''))) as v) t
 where t.v <> '' and (t.v = k.key
  or (k.key !~ '^[0-9]+$' and length(k.key) >= 3 and left(t.v, length(k.key)) = k.key))
 order by (t.v = k.key) desc, length(k.key) desc
 limit 1
$$;
revoke all on function mavi_private.cs_squad_match(uuid, text) from public, anon, authenticated;

create function public.cs_squads(p_company uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
 if not mavi_private.member(p_company) then
  raise exception 'Sem permissão' using errcode = '42501';
 end if;
 return coalesce((select jsonb_agg(jsonb_build_object(
   'id', s.id, 'name', s.name, 'color', s.color, 'aliases', to_jsonb(s.aliases),
   'sort', s.sort, 'archived', s.archived,
   'members', coalesce((select jsonb_agg(jsonb_build_object('user_id', m.user_id, 'leader', m.leader)
     order by m.leader desc, m.user_id)
    from public.cs_squad_members m where m.company_id = s.company_id and m.squad_id = s.id), '[]'),
   'clients', (select count(*) from public.cs_clients k
    where k.company_id = s.company_id and k.squad_id = s.id and k.status <> 'INATIVO'),
   'used', exists (select 1 from public.cs_clients k where k.company_id = s.company_id and k.squad_id = s.id)
    or exists (select 1 from public.cs_cycles y where y.company_id = s.company_id and y.squad_id = s.id)
    or exists (select 1 from public.cs_goals g where g.company_id = s.company_id and g.squad_id = s.id)
    or exists (select 1 from public.cs_official_revenue o where o.company_id = s.company_id and o.squad_id = s.id))
   order by s.archived, s.sort, s.name)
  from public.cs_squads s where s.company_id = p_company), '[]');
end $$;

-- Cria ou altera um squad (p_id nulo: novo). Só administradores.
create function public.save_cs_squad(p_company uuid, p_id uuid, p_name text, p_color text,
 p_aliases text[], p_users uuid[], p_leaders uuid[], p_archived boolean) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_name text := btrim(coalesce(p_name, '')); v_id uuid := p_id; v_aliases text[]; v_users uuid[];
 v_clash record; begin
 if not mavi_private.admin(p_company) then
  raise exception 'Somente administradores mudam os squads.' using errcode = '42501';
 end if;
 if length(v_name) not between 2 and 60 then
  raise exception 'O nome do squad precisa ter de 2 a 60 caracteres.' using errcode = '22023';
 end if;
 if coalesce(p_color, '') !~ '^#[0-9A-Fa-f]{6}$' then
  raise exception 'Cor inválida.' using errcode = '22023';
 end if;
 select coalesce(array_agg(a order by n), '{}') into v_aliases from (
  select distinct on (mavi_private.fold(btrim(a))) btrim(a) as a, n
  from unnest(coalesce(p_aliases, '{}')) with ordinality as x(a, n)
  where btrim(a) <> '' and mavi_private.fold(btrim(a)) <> mavi_private.fold(v_name)
  order by mavi_private.fold(btrim(a)), n) d;
 if cardinality(v_aliases) > 20 then
  raise exception 'No máximo 20 apelidos por squad.' using errcode = '22023';
 end if;
 if exists (select 1 from unnest(v_aliases) a where length(a) > 60) then
  raise exception 'Cada apelido pode ter até 60 caracteres.' using errcode = '22023';
 end if;
 if v_id is not null and not exists (select 1 from public.cs_squads where id = v_id and company_id = p_company) then
  raise exception 'Squad não encontrado.' using errcode = 'P0002';
 end if;
 -- Nome e apelidos não podem ser de outro squad (a leitura não saberia qual).
 select k.key, s.name into v_clash
 from mavi_private.cs_squad_keys(p_company) k join public.cs_squads s on s.id = k.squad_id
 where k.squad_id is distinct from v_id
  and k.key in (select mavi_private.fold(btrim(x)) from unnest(array[v_name] || v_aliases) x)
 limit 1;
 if found then
  raise exception 'O nome ou apelido "%" já é do squad %.', v_clash.key, v_clash.name using errcode = '23505';
 end if;
 select coalesce(array_agg(distinct u), '{}') into v_users
 from unnest(coalesce(p_users, '{}') || coalesce(p_leaders, '{}')) u;
 if exists (select 1 from unnest(v_users) u where not exists (
  select 1 from public.memberships m where m.company_id = p_company and m.user_id = u)) then
  raise exception 'Pessoa fora da empresa.' using errcode = '22023';
 end if;
 if v_id is null then
  insert into public.cs_squads(company_id, name, color, aliases, sort, archived)
  values (p_company, v_name, lower(p_color), v_aliases,
   coalesce((select max(sort) + 1 from public.cs_squads where company_id = p_company), 1),
   coalesce(p_archived, false))
  returning id into v_id;
 else
  update public.cs_squads set name = v_name, color = lower(p_color), aliases = v_aliases,
   archived = coalesce(p_archived, archived), updated_at = now()
  where id = v_id;
 end if;
 delete from public.cs_squad_members where company_id = p_company and squad_id = v_id and user_id <> all(v_users);
 insert into public.cs_squad_members as m(company_id, squad_id, user_id, leader)
 select p_company, v_id, u, u = any(coalesce(p_leaders, '{}')) from unnest(v_users) u
 on conflict (company_id, squad_id, user_id) do update set leader = excluded.leader
  where m.leader is distinct from excluded.leader;
 perform mavi_private.cs_changed(p_company, 'squads');
 return public.cs_squads(p_company);
end $$;

-- Exclui um squad que nunca foi usado (os usados são arquivados, para o
-- histórico continuar com o nome).
create function public.delete_cs_squad(p_squad uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare c uuid; begin
 select company_id into c from public.cs_squads where id = p_squad;
 if c is null or not mavi_private.admin(c) then
  raise exception 'Somente administradores mudam os squads.' using errcode = '42501';
 end if;
 if exists (select 1 from public.cs_clients where company_id = c and squad_id = p_squad)
  or exists (select 1 from public.cs_cycles where company_id = c and squad_id = p_squad)
  or exists (select 1 from public.cs_goals where company_id = c and squad_id = p_squad)
  or exists (select 1 from public.cs_official_revenue where company_id = c and squad_id = p_squad)
  or exists (select 1 from public.cs_data_quality where company_id = c and squad_id = p_squad) then
  raise exception 'Este squad já tem clientes, ciclos ou metas. Arquive em vez de excluir.' using errcode = '23503';
 end if;
 delete from public.cs_squads where id = p_squad;
 perform mavi_private.cs_changed(c, 'squads');
 return public.cs_squads(c);
end $$;

-- ------------------------------------------------------------ ligação com o cliente do MAVI
-- Liga os clientes de CS em modo automático: primeiro pelo código (o número
-- do começo do nome do cliente do MAVI, como "4862" ou "4862 - MaqFlex"),
-- depois pelo nome igual. Só liga quando há um único candidato (entre os
-- ativos, ou um único no total); senão fica sem cliente para alguém
-- escolher. p_cs_client nulo: todos.
create function mavi_private.cs_link_auto(c uuid, p_cs_client uuid) returns integer
language plpgsql security definer set search_path = '' as $$
declare v_n integer; begin
 with k as (
  select id, external_id, mavi_private.fold(btrim(name)) as fname
  from public.cs_clients
  where company_id = c and link_mode = 'auto' and (p_cs_client is null or id = p_cs_client)),
 m as (
  select k.id as kid, cl.id as client_id, cl.archived, 1 as pri
  from k join public.clients cl on cl.company_id = c and cl.name ~ '^\d'
   and substring(cl.name from '^\d+') = k.external_id
  union all
  select k.id, cl.id, cl.archived, 2
  from k join public.clients cl on cl.company_id = c and mavi_private.fold(btrim(cl.name)) = k.fname),
 agg as (
  select kid, pri, count(*) as n, count(*) filter (where not archived) as na,
   (array_agg(client_id) filter (where not archived))[1] as active1, (array_agg(client_id))[1] as any1
  from m group by kid, pri),
 pick as (
  select distinct on (kid) kid, case when na = 1 then active1 else any1 end as client_id, pri
  from agg where na = 1 or n = 1 order by kid, pri),
 res as (
  select k.id, p.client_id, case p.pri when 1 then 'code' when 2 then 'name' end as rule
  from k left join pick p on p.kid = k.id),
 upd as (
  update public.cs_clients t set client_id = res.client_id, link_rule = res.rule, linked_by = null,
   linked_at = now()
  from res, public.cs_clients old
  where t.id = res.id and old.id = t.id
   and (t.client_id is distinct from res.client_id or t.link_rule is distinct from res.rule)
  returning t.id, t.client_id, old.client_id as previous, t.link_rule),
 logged as (
  insert into public.cs_client_link_log(company_id, cs_client_id, client_id, previous_client_id, mode, rule)
  select c, id, client_id, previous, 'auto', link_rule from upd
  where client_id is distinct from previous
  returning 1)
 select count(*) into v_n from upd;
 return v_n;
end $$;
revoke all on function mavi_private.cs_link_auto(uuid, uuid) from public, anon, authenticated;

-- Uma linha da lista de clientes de CS.
create function mavi_private.cs_client_row(k public.cs_clients) returns jsonb
language sql stable security definer set search_path = '' as $$
 select jsonb_build_object(
  'id', k.id, 'external_id', k.external_id, 'name', k.name, 'squad_id', k.squad_id,
  'kind', k.kind, 'status', k.status, 'trial_month', k.trial_month, 'origin', k.origin,
  'entry_date', k.entry_date, 'churn_date', k.churn_date, 'reactivation_date', k.reactivation_date,
  'client_id', k.client_id, 'client_name', cl.name, 'client_archived', cl.archived,
  'link_mode', k.link_mode, 'link_rule', k.link_rule, 'linked_at', k.linked_at,
  'linked_by_name', (select m.name from public.memberships m where m.company_id = k.company_id and m.user_id = k.linked_by),
  -- Quantos clientes do MAVI têm esse código (mais de um: escolher à mão).
  'code_matches', (select count(*) from public.clients x where x.company_id = k.company_id and x.name ~ '^\d'
   and substring(x.name from '^\d+') = k.external_id),
  'cycles', (select count(*) from public.cs_cycles y where y.company_id = k.company_id and y.cs_client_id = k.id),
  'last_month', (select max(y.month) from public.cs_cycles y where y.company_id = k.company_id and y.cs_client_id = k.id))
 from (select 1) one
 left join public.clients cl on cl.company_id = k.company_id and cl.id = k.client_id
$$;
revoke all on function mavi_private.cs_client_row(public.cs_clients) from public, anon, authenticated;

create function public.cs_clients(p_company uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
 if not mavi_private.cs_reader(p_company) then
  raise exception 'Sem permissão' using errcode = '42501';
 end if;
 return coalesce((select jsonb_agg(mavi_private.cs_client_row(k)
   order by (k.status = 'INATIVO'), lower(k.name))
  from public.cs_clients k where k.company_id = p_company), '[]');
end $$;

-- Corrige a ligação: p_auto volta ao automático; senão fica o cliente
-- escolhido (nulo: "sem cliente no MAVI"). Administradores e gestores.
create function public.set_cs_client_link(p_cs_client uuid, p_client uuid, p_auto boolean) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare k public.cs_clients; before uuid; begin
 select * into k from public.cs_clients where id = p_cs_client;
 if not found or not mavi_private.cs_reader(k.company_id) then
  raise exception 'Sem permissão' using errcode = '42501';
 end if;
 before := k.client_id;
 if coalesce(p_auto, false) then
  update public.cs_clients set link_mode = 'auto' where id = k.id;
  perform mavi_private.cs_link_auto(k.company_id, k.id);
 else
  if p_client is not null and not exists (select 1 from public.clients where company_id = k.company_id and id = p_client) then
   raise exception 'Cliente não encontrado.' using errcode = 'P0002';
  end if;
  update public.cs_clients set link_mode = 'manual', client_id = p_client, link_rule = 'manual',
   linked_by = auth.uid(), linked_at = now()
  where id = k.id;
  insert into public.cs_client_link_log(company_id, cs_client_id, client_id, previous_client_id, mode, rule, by)
  values (k.company_id, k.id, p_client, before, 'manual', 'manual', auth.uid());
 end if;
 perform mavi_private.cs_changed(k.company_id, 'clients');
 select * into k from public.cs_clients where id = k.id;
 return mavi_private.cs_client_row(k);
end $$;

create function public.cs_client_link_log(p_cs_client uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare c uuid; begin
 select company_id into c from public.cs_clients where id = p_cs_client;
 if c is null or not mavi_private.cs_reader(c) then
  raise exception 'Sem permissão' using errcode = '42501';
 end if;
 return coalesce((select jsonb_agg(jsonb_build_object(
   'at', l.at, 'mode', l.mode, 'rule', l.rule,
   'client_name', (select x.name from public.clients x where x.company_id = c and x.id = l.client_id),
   'previous_name', (select x.name from public.clients x where x.company_id = c and x.id = l.previous_client_id),
   'by_name', (select m.name from public.memberships m where m.company_id = c and m.user_id = l.by))
   order by l.at desc)
  from public.cs_client_link_log l where l.company_id = c and l.cs_client_id = p_cs_client), '[]');
end $$;

-- ------------------------------------------------------------ configuração: telas
create function mavi_private.cs_run_row(r public.cs_sync_runs) returns jsonb
language sql stable security definer set search_path = '' as $$
 select jsonb_build_object('id', r.id, 'trigger', r.trigger, 'started_at', r.started_at,
  'finished_at', r.finished_at, 'status', r.status, 'stats', r.stats, 'tabs', r.tabs,
  'warnings', to_jsonb(r.warnings), 'blocked', r.blocked, 'error', r.error,
  'by_name', (select m.name from public.memberships m where m.company_id = r.company_id and m.user_id = r.by))
$$;
revoke all on function mavi_private.cs_run_row(public.cs_sync_runs) from public, anon, authenticated;

create function public.cs_settings(p_company uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare s public.cs_settings; r public.cs_sync_runs; begin
 if not mavi_private.cs_reader(p_company) then
  raise exception 'Sem permissão' using errcode = '42501';
 end if;
 select * into s from public.cs_settings where company_id = p_company;
 select * into r from public.cs_sync_runs where company_id = p_company order by started_at desc limit 1;
 return jsonb_build_object(
  'sheet_id', s.sheet_id,
  'enabled', coalesce(s.enabled, false),
  'can_edit', mavi_private.admin(p_company),
  'running', s.claimed_at is not null and s.claimed_at > now() - interval '3 minutes',
  'last_run', case when r.id is not null then mavi_private.cs_run_row(r) end,
  'last_ok_at', (select max(finished_at) from public.cs_sync_runs
   where company_id = p_company and status <> 'error'),
  'totals', jsonb_build_object(
   'clients', (select count(*) from public.cs_clients where company_id = p_company),
   'active', (select count(*) from public.cs_clients where company_id = p_company and status <> 'INATIVO'),
   'linked', (select count(*) from public.cs_clients where company_id = p_company and client_id is not null),
   'cycles', (select count(*) from public.cs_cycles where company_id = p_company),
   'months', coalesce((select jsonb_agg(jsonb_build_object('month', month, 'cycles', n) order by month desc)
    from (select month, count(*) n from public.cs_cycles where company_id = p_company group by month) x), '[]'),
   'hs_months', coalesce((select jsonb_agg(month order by month desc)
    from (select distinct month from public.cs_health_scores where company_id = p_company) x), '[]'),
   'goals', (select count(*) from public.cs_goals where company_id = p_company)));
end $$;

-- O link da planilha (ou só o ID dela). Só administradores.
create function public.save_cs_settings(p_company uuid, p_sheet text, p_enabled boolean) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_id text := nullif(btrim(coalesce(p_sheet, '')), ''); begin
 if not mavi_private.admin(p_company) then
  raise exception 'Somente administradores mudam a planilha de CS.' using errcode = '42501';
 end if;
 if v_id is not null then
  v_id := coalesce(substring(v_id from '/spreadsheets/d/([A-Za-z0-9_-]+)'), v_id);
  if v_id !~ '^[A-Za-z0-9_-]{20,100}$' then
   raise exception 'Cole o link da planilha do Google (docs.google.com/spreadsheets/d/...).' using errcode = '22023';
  end if;
 end if;
 insert into public.cs_settings as s(company_id, sheet_id, enabled, updated_by, updated_at)
 values (p_company, v_id, coalesce(p_enabled, true), auth.uid(), now())
 on conflict (company_id) do update set sheet_id = excluded.sheet_id, enabled = excluded.enabled,
  updated_by = excluded.updated_by, updated_at = now(),
  last_attempt_at = case when s.sheet_id is distinct from excluded.sheet_id then null else s.last_attempt_at end;
 perform mavi_private.cs_changed(p_company, 'settings');
 return public.cs_settings(p_company);
end $$;

create function public.cs_sync_runs(p_company uuid, p_limit integer default 20) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
 if not mavi_private.cs_reader(p_company) then
  raise exception 'Sem permissão' using errcode = '42501';
 end if;
 return coalesce((select jsonb_agg(mavi_private.cs_run_row(r) order by r.started_at desc)
  from (select * from public.cs_sync_runs where company_id = p_company
   order by started_at desc limit least(greatest(coalesce(p_limit, 20), 1), 100)) r), '[]');
end $$;

-- ------------------------------------------------------------ leitura da planilha
-- Sumiço em massa: 5 ou mais de uma vez e mais de 20% do que havia.
create function mavi_private.cs_mass(p_gone integer, p_existing integer) returns boolean
language sql immutable set search_path = '' as $$
 select p_gone >= 5 and p_gone > p_existing * 0.2
$$;
revoke all on function mavi_private.cs_mass(integer, integer) from public, anon, authenticated;

-- O agendamento (o segredo da MAVI) ou um administrador/gestor da empresa.
create function mavi_private.cs_sync_allowed(p_secret text, c uuid) returns boolean
language sql stable security definer set search_path = '' as $$
 select mavi_private.ai_secret_ok(p_secret) or (c is not null and mavi_private.cs_reader(c))
$$;
revoke all on function mavi_private.cs_sync_allowed(text, uuid) from public, anon, authenticated;

-- As planilhas a ler agora. Agendamento (p_company nulo): as que passaram
-- de 9 minutos sem leitura. Manual: a da empresa, se ninguém estiver lendo.
-- Marca a leitura como em andamento (claimed_at).
create function public.cs_sync_targets(p_secret text, p_company uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v jsonb; begin
 if p_company is null then
  if not mavi_private.ai_secret_ok(p_secret) then
   raise exception 'Sem permissão' using errcode = '42501';
  end if;
  with due as (
   select company_id from public.cs_settings
   where enabled and sheet_id is not null
    and (last_attempt_at is null or last_attempt_at < now() - interval '9 minutes')
    and (claimed_at is null or claimed_at < now() - interval '5 minutes')
   for update skip locked),
  upd as (
   update public.cs_settings s set claimed_at = now(), last_attempt_at = now()
   from due where s.company_id = due.company_id
   returning s.company_id, s.sheet_id)
  select coalesce(jsonb_agg(jsonb_build_object('company', company_id, 'sheet_id', sheet_id)), '[]') into v from upd;
  return v;
 end if;
 if not mavi_private.cs_sync_allowed(p_secret, p_company) then
  raise exception 'Sem permissão' using errcode = '42501';
 end if;
 if not exists (select 1 from public.cs_settings where company_id = p_company and sheet_id is not null) then
  raise exception 'Configure o link da planilha de CS antes de sincronizar.' using errcode = '22023';
 end if;
 update public.cs_settings set claimed_at = now(), last_attempt_at = now()
 where company_id = p_company and (claimed_at is null or claimed_at < now() - interval '2 minutes')
 returning jsonb_build_array(jsonb_build_object('company', company_id, 'sheet_id', sheet_id)) into v;
 if v is null then
  raise exception 'Uma leitura da planilha já está em andamento. Aguarde um minuto.' using errcode = '55P03';
 end if;
 return v;
end $$;

-- Grava o que a leitura trouxe (api/_cs-sync.ts monta p_payload a partir
-- das abas; as regras de cada linha estão lá). Tudo numa transação: ou entra
-- a planilha inteira, ou nada. p_error: a leitura falhou antes de gravar.
-- p_allow_removals: confirma o sumiço em massa que a leitura anterior
-- segurou (botão "Remover mesmo assim").
--
-- O que some da planilha some do banco, como no dash antigo:
--  * cliente fora da aba Clientes (com seus ciclos, HS e eventos);
--  * ciclo fora da aba do mês; HS cuja LINHA saiu da aba do mês (linha
--    vazia mantém o que havia); evento fora da aba EVENTOS.
-- Salvaguardas: aba sem nenhuma linha válida não apaga nada; mês sem aba
-- não é tocado; e sumiço em massa (5 ou mais e mais de 20% do que havia)
-- espera confirmação.
create function public.cs_sync_store(p_secret text, p_company uuid, p_payload jsonb, p_error text,
 p_trigger text, p_allow_removals boolean default false) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare c uuid := p_company; w text[] := '{}'; v_tabs jsonb := '[]'; v_stats jsonb; v_blocked jsonb := '[]';
 v_status text; v_run public.cs_sync_runs; v_trigger text := coalesce(p_trigger, 'manual');
 n_created integer := 0; n_updated integer := 0; n_removed integer := 0; n_existing integer;
 n_cycles integer := 0; n_cycles_removed integer := 0; n_payments integer := 0; n_history integer := 0;
 n_hs integer := 0; n_hs_removed integer := 0; n_goals integer := 0; n_events integer := 0;
 n_events_removed integer := 0; n_linked integer := 0; v_gone jsonb; x record; m record;
 v_seen integer; v_months date[]; begin
 if not mavi_private.cs_sync_allowed(p_secret, c) then
  raise exception 'Sem permissão' using errcode = '42501';
 end if;
 if v_trigger not in ('schedule', 'manual') then v_trigger := 'manual'; end if;
 perform pg_advisory_xact_lock(hashtextextended('cs_sync:' || c::text, 0));

 if p_error is not null or p_payload is null then
  insert into public.cs_sync_runs(company_id, trigger, by, status, error, stats)
  values (c, v_trigger, auth.uid(), 'error', left(coalesce(nullif(btrim(p_error), ''), 'Leitura sem dados.'), 2000),
   coalesce(p_payload->'meta', '{}'))
  returning * into v_run;
  update public.cs_settings set claimed_at = null where company_id = c;
  perform mavi_private.cs_changed(c, 'sync');
  return mavi_private.cs_run_row(v_run);
 end if;

 v_tabs := coalesce(p_payload->'tabs', '[]');
 select coalesce(array_agg(t), '{}') into w from jsonb_array_elements_text(coalesce(p_payload->'warnings', '[]')) t;

 -- Sem squads, nenhum cliente seria reconhecido: um aviso só, nada gravado.
 if not exists (select 1 from public.cs_squads where company_id = c) then
  insert into public.cs_sync_runs(company_id, trigger, by, status, stats, tabs, warnings)
  values (c, v_trigger, auth.uid(), 'warning', coalesce(p_payload->'meta', '{}'), v_tabs,
   array['⚠️ Nenhum squad cadastrado: crie os squads em Equipe e configurações › Squads (com os nomes da planilha) e sincronize de novo. Nada foi gravado.'])
  returning * into v_run;
  update public.cs_settings set claimed_at = null where company_id = c;
  perform mavi_private.cs_changed(c, 'sync');
  return mavi_private.cs_run_row(v_run);
 end if;

 -- ---------------------------------------------------------- clientes
 drop table if exists pg_temp._cs_cl;
 create temp table _cs_cl on commit drop as
 select distinct on (r.external_id) r.*, mavi_private.cs_squad_match(c, r.squad) as squad_uuid
 from jsonb_array_elements(coalesce(p_payload->'clients', '[]')) with ordinality as e(v, n)
 cross join lateral jsonb_to_record(e.v)
  as r(external_id text, name text, squad text, vertical text, origin text, kind text, trial_month integer,
   status text, entry_date date, churn_date date, reactivation_date date, churn_reason text, notes text)
 order by r.external_id, e.n desc;

 if jsonb_array_length(coalesce(p_payload->'clients', '[]')) > 0 then
  for x in select * from pg_temp._cs_cl where squad_uuid is null or origin is null order by external_id loop
   w := w || format('Cliente %s (%s): squad "%s" ou origem inválidos, ignorado. Confira o squad em Configurações › Squads (nome ou apelido).',
    x.external_id, x.name, coalesce(x.squad, ''));
  end loop;
  for x in select * from pg_temp._cs_cl where reactivation_date is not null and churn_date is null loop
   w := w || format('Cliente %s (%s): DataReativacao preenchida sem DataChurn — reativação só faz sentido após churn.',
    x.external_id, x.name);
  end loop;
  with up as (
   insert into public.cs_clients as t(company_id, external_id, name, squad_id, vertical, origin, kind,
    trial_month, status, entry_date, churn_date, reactivation_date, churn_reason, notes)
   select c, external_id, btrim(name), squad_uuid, nullif(btrim(vertical), ''), origin, kind,
    trial_month, status, entry_date, churn_date, reactivation_date, churn_reason, nullif(btrim(notes), '')
   from pg_temp._cs_cl where squad_uuid is not null and origin is not null
   on conflict (company_id, external_id) do update set name = excluded.name, squad_id = excluded.squad_id,
    vertical = excluded.vertical, origin = excluded.origin, kind = excluded.kind,
    trial_month = excluded.trial_month, status = excluded.status, entry_date = excluded.entry_date,
    churn_date = excluded.churn_date, reactivation_date = excluded.reactivation_date,
    churn_reason = excluded.churn_reason, notes = excluded.notes, updated_at = now()
   where (t.name, t.squad_id, t.vertical, t.origin, t.kind, t.trial_month, t.status, t.entry_date,
     t.churn_date, t.reactivation_date, t.churn_reason, t.notes)
    is distinct from (excluded.name, excluded.squad_id, excluded.vertical, excluded.origin, excluded.kind,
     excluded.trial_month, excluded.status, excluded.entry_date, excluded.churn_date,
     excluded.reactivation_date, excluded.churn_reason, excluded.notes)
   returning (xmax = 0) as inserted)
  select count(*) filter (where inserted), count(*) filter (where not inserted) into n_created, n_updated from up;

  -- Quem sumiu da aba Clientes.
  select count(*) into n_existing from public.cs_clients where company_id = c;
  select coalesce(jsonb_agg(jsonb_build_object('id', k.id, 'external_id', k.external_id, 'name', k.name)
    order by k.external_id), '[]')
  into v_gone from public.cs_clients k
  where k.company_id = c and not exists (select 1 from pg_temp._cs_cl l where l.external_id = k.external_id);
  if jsonb_array_length(v_gone) > 0 then
   if mavi_private.cs_mass(jsonb_array_length(v_gone), n_existing) and not coalesce(p_allow_removals, false) then
    v_blocked := v_blocked || jsonb_build_object('kind', 'clients', 'items', v_gone);
    w := w || format('⚠️ %s clientes sumiram da aba Clientes de uma vez. Por segurança, nada foi removido. Se estiver certo, use "Remover mesmo assim"; senão, confira a aba (filtro, linhas apagadas).',
     jsonb_array_length(v_gone));
   else
    delete from public.cs_clients k using jsonb_to_recordset(v_gone) g(id uuid)
    where k.company_id = c and k.id = g.id;
    get diagnostics n_removed = row_count;
    for x in select * from jsonb_to_recordset(v_gone) g(external_id text, name text) loop
     w := w || format('Cliente removido (sumiu da planilha): %s (%s). Ciclos, HS e eventos dele saíram junto.',
      x.name, x.external_id);
    end loop;
   end if;
  end if;
 else
  w := w || '⚠️ Nenhuma aba de CLIENTES reconhecida na planilha (ou a aba veio sem clientes válidos) — cadastros, reativações e clientes novos NÃO foram lidos e nada foi removido. Confira o cabeçalho da aba (ID na coluna A e Nome na B).'::text;
 end if;

 -- ---------------------------------------------------------- ciclos
 drop table if exists pg_temp._cs_cy;
 create temp table _cs_cy on commit drop as
 select distinct on (k.id, (mm->>'month')::date) (mm->>'month')::date as month, r.*, k.id as cs_client_id,
  case when nullif(btrim(r.squad), '') is not null then mavi_private.cs_squad_match(c, r.squad) end as squad_uuid
 from jsonb_array_elements(coalesce(p_payload->'cycles', '[]')) mm
 cross join lateral jsonb_array_elements(coalesce(mm->'rows', '[]')) with ordinality as e(v, n)
 cross join lateral jsonb_to_record(e.v)
  as r(external_id text, squad text, start_date date, end_date date, billing_date date, best numeric,
   probable numeric, probability text, paid numeric, paid_date date, status text, adimplencia text,
   acl boolean, acl_value numeric, fee_planned numeric, fee_paid numeric, payments jsonb)
 join public.cs_clients k on k.company_id = c and k.external_id = r.external_id
 order by k.id, (mm->>'month')::date, e.n desc;

 for x in
  select (mm->>'month')::date as month, r.external_id
  from jsonb_array_elements(coalesce(p_payload->'cycles', '[]')) mm
  cross join lateral jsonb_to_recordset(coalesce(mm->'rows', '[]')) as r(external_id text)
  where not exists (select 1 from public.cs_clients k where k.company_id = c and k.external_id = r.external_id)
  order by 1, 2 loop
  w := w || format('Ciclo %s: ID %s não existe na aba Clientes, ignorado.', to_char(x.month, 'MM/YYYY'), x.external_id);
 end loop;
 for x in select y.*, k.name from pg_temp._cs_cy y join public.cs_clients k on k.id = y.cs_client_id
  where nullif(btrim(y.squad), '') is not null and y.squad_uuid is null loop
  w := w || format('Ciclo %s de %s (%s): coluna Squad inválida ("%s"), ignorada — vale o squad do cliente.',
   to_char(x.month, 'MM/YYYY'), x.name, x.external_id, x.squad);
 end loop;

 -- Replanejamento: foto quando fim do ciclo, cobrança ou provável mudam.
 insert into public.cs_cycle_history(company_id, cs_client_id, month, end_date, billing_date, probable)
 select c, y.cs_client_id, y.month, y.end_date, y.billing_date, coalesce(y.probable, 0)
 from pg_temp._cs_cy y
 left join lateral (select true as found, h.end_date, h.billing_date, h.probable from public.cs_cycle_history h
  where h.company_id = c and h.cs_client_id = y.cs_client_id and h.month = y.month
  order by h.recorded_at desc limit 1) last on true
 where last.found is null or last.end_date is distinct from y.end_date or last.billing_date is distinct from y.billing_date
  or abs(coalesce(last.probable, 0) - coalesce(y.probable, 0)) > 0.009;
 get diagnostics n_history = row_count;

 with up as (
  insert into public.cs_cycles as t(company_id, cs_client_id, month, squad_id, start_date, end_date, billing_date,
   best, probable, probability, paid, paid_date, status, adimplencia, acl, acl_value, fee_planned, fee_paid, source)
  select c, cs_client_id, month, squad_uuid, start_date, end_date, billing_date, coalesce(best, 0),
   coalesce(probable, 0), probability, coalesce(paid, 0), paid_date, status, adimplencia, coalesce(acl, false),
   case when coalesce(acl, false) then acl_value end, fee_planned, fee_paid, 'sheet'
  from pg_temp._cs_cy
  on conflict (company_id, cs_client_id, month) do update set squad_id = excluded.squad_id,
   start_date = excluded.start_date, end_date = excluded.end_date, billing_date = excluded.billing_date,
   best = excluded.best, probable = excluded.probable, probability = excluded.probability, paid = excluded.paid,
   paid_date = excluded.paid_date, status = excluded.status, adimplencia = excluded.adimplencia,
   acl = excluded.acl, acl_value = excluded.acl_value, fee_planned = excluded.fee_planned,
   fee_paid = excluded.fee_paid, source = 'sheet', updated_at = now()
  where (t.squad_id, t.start_date, t.end_date, t.billing_date, t.best, t.probable, t.probability, t.paid,
    t.paid_date, t.status, t.adimplencia, t.acl, t.acl_value, t.fee_planned, t.fee_paid, t.source)
   is distinct from (excluded.squad_id, excluded.start_date, excluded.end_date, excluded.billing_date,
    excluded.best, excluded.probable, excluded.probability, excluded.paid, excluded.paid_date, excluded.status,
    excluded.adimplencia, excluded.acl, excluded.acl_value, excluded.fee_planned, excluded.fee_paid, 'sheet')
  returning 1)
 select count(*) into n_cycles from up;

 -- Parcelas: as da planilha substituem as do ciclo (só onde mudaram).
 with want as (
  select cy.id as cycle_id, (p->>'ord')::smallint as ord, (p->>'date')::date as paid_date,
   (p->>'amount')::numeric as amount
  from pg_temp._cs_cy y
  join public.cs_cycles cy on cy.company_id = c and cy.cs_client_id = y.cs_client_id and cy.month = y.month
  cross join lateral jsonb_array_elements(coalesce(y.payments, '[]')) p),
 cycles as (select cy.id from pg_temp._cs_cy y
  join public.cs_cycles cy on cy.company_id = c and cy.cs_client_id = y.cs_client_id and cy.month = y.month),
 del as (
  delete from public.cs_cycle_payments p using cycles
  where p.company_id = c and p.cycle_id = cycles.id
   and not exists (select 1 from want w2 where w2.cycle_id = p.cycle_id and w2.ord = p.ord
    and w2.paid_date = p.paid_date and w2.amount = p.amount)
  returning 1),
 ins as (
  insert into public.cs_cycle_payments as p(company_id, cycle_id, ord, paid_date, amount)
  select c, cycle_id, ord, paid_date, amount from want
  on conflict (company_id, cycle_id, ord) do update set paid_date = excluded.paid_date, amount = excluded.amount
   where (p.paid_date, p.amount) is distinct from (excluded.paid_date, excluded.amount)
  returning 1)
 select (select count(*) from ins) + (select count(*) from del) into n_payments;

 -- Ciclos que sumiram da aba do mês.
 for m in select (mm->>'month')::date as month from jsonb_array_elements(coalesce(p_payload->'cycles', '[]')) mm loop
  select count(*) into v_seen from pg_temp._cs_cy where month = m.month;
  if v_seen = 0 then
   w := w || format('Aba de ciclos %s veio sem linhas válidas — nada foi removido desse mês.', to_char(m.month, 'MM/YYYY'));
   continue;
  end if;
  select count(*) into n_existing from public.cs_cycles where company_id = c and month = m.month;
  select coalesce(jsonb_agg(jsonb_build_object('id', cy.id, 'external_id', k.external_id, 'name', k.name)
    order by k.external_id), '[]')
  into v_gone from public.cs_cycles cy join public.cs_clients k on k.id = cy.cs_client_id
  where cy.company_id = c and cy.month = m.month
   and not exists (select 1 from pg_temp._cs_cy y where y.month = m.month and y.cs_client_id = cy.cs_client_id);
  if jsonb_array_length(v_gone) = 0 then continue; end if;
  if mavi_private.cs_mass(jsonb_array_length(v_gone), n_existing) and not coalesce(p_allow_removals, false) then
   v_blocked := v_blocked || jsonb_build_object('kind', 'cycles', 'month', m.month, 'items', v_gone);
   w := w || format('⚠️ %s ciclos de %s sumiram da aba de uma vez. Por segurança, nada foi removido. Se estiver certo, use "Remover mesmo assim".',
    jsonb_array_length(v_gone), to_char(m.month, 'MM/YYYY'));
  else
   delete from public.cs_cycles cy using jsonb_to_recordset(v_gone) g(id uuid) where cy.company_id = c and cy.id = g.id;
   n_cycles_removed := n_cycles_removed + jsonb_array_length(v_gone);
   for x in select * from jsonb_to_recordset(v_gone) g(external_id text, name text) loop
    w := w || format('Ciclo %s removido (sumiu da planilha): %s (%s).', to_char(m.month, 'MM/YYYY'), x.name, x.external_id);
   end loop;
  end if;
 end loop;

 -- ---------------------------------------------------------- health score
 -- Toda linha com ID conhecido conta como "vista" (linha vazia mantém o que
 -- havia; só a linha excluída tira o HS do cliente no mês).
 drop table if exists pg_temp._cs_hs;
 create temp table _cs_hs on commit drop as
 select distinct on (k.id, (mm->>'month')::date) (mm->>'month')::date as month, r.*, k.id as cs_client_id
 from jsonb_array_elements(coalesce(p_payload->'hs', '[]')) mm
 cross join lateral jsonb_array_elements(coalesce(mm->'rows', '[]')) with ordinality as e(v, n)
 cross join lateral jsonb_to_record(e.v)
  as r(external_id text, empty boolean, creatives boolean, meeting boolean, payment boolean, perception boolean,
   goal boolean, manual_score numeric, collection integer, notes text)
 join public.cs_clients k on k.company_id = c and k.external_id = r.external_id
 order by k.id, (mm->>'month')::date, e.n desc;

 with up as (
  insert into public.cs_health_scores as t(company_id, cs_client_id, month, creatives, meeting, payment,
   perception, goal, manual_score, collection, notes, source)
  select c, cs_client_id, month, coalesce(creatives, false), coalesce(meeting, false), coalesce(payment, false),
   coalesce(perception, false), coalesce(goal, false), manual_score, collection, nullif(btrim(notes), ''), 'sheet'
  from pg_temp._cs_hs where not coalesce(empty, false)
  on conflict (company_id, cs_client_id, month) do update set creatives = excluded.creatives,
   meeting = excluded.meeting, payment = excluded.payment, perception = excluded.perception, goal = excluded.goal,
   manual_score = excluded.manual_score, collection = excluded.collection, notes = excluded.notes, source = 'sheet'
  where (t.creatives, t.meeting, t.payment, t.perception, t.goal, t.manual_score, t.collection, t.notes, t.source)
   is distinct from (excluded.creatives, excluded.meeting, excluded.payment, excluded.perception, excluded.goal,
    excluded.manual_score, excluded.collection, excluded.notes, 'sheet')
  returning 1)
 select count(*) into n_hs from up;

 for m in select (mm->>'month')::date as month from jsonb_array_elements(coalesce(p_payload->'hs', '[]')) mm loop
  select count(*) into v_seen from pg_temp._cs_hs where month = m.month;
  if v_seen = 0 then
   w := w || format('Aba de Health Score %s veio sem linhas válidas — nada foi removido desse mês.', to_char(m.month, 'MM/YYYY'));
   continue;
  end if;
  select count(*) into n_existing from public.cs_health_scores where company_id = c and month = m.month;
  select coalesce(jsonb_agg(jsonb_build_object('id', h.cs_client_id, 'external_id', k.external_id, 'name', k.name)
    order by k.external_id), '[]')
  into v_gone from public.cs_health_scores h join public.cs_clients k on k.id = h.cs_client_id
  where h.company_id = c and h.month = m.month
   and not exists (select 1 from pg_temp._cs_hs y where y.month = m.month and y.cs_client_id = h.cs_client_id);
  if jsonb_array_length(v_gone) = 0 then continue; end if;
  if mavi_private.cs_mass(jsonb_array_length(v_gone), n_existing) and not coalesce(p_allow_removals, false) then
   v_blocked := v_blocked || jsonb_build_object('kind', 'hs', 'month', m.month, 'items', v_gone);
   w := w || format('⚠️ %s linhas do Health Score de %s sumiram de uma vez. Por segurança, nada foi removido. Se estiver certo, use "Remover mesmo assim".',
    jsonb_array_length(v_gone), to_char(m.month, 'MM/YYYY'));
  else
   delete from public.cs_health_scores h using jsonb_to_recordset(v_gone) g(id uuid)
   where h.company_id = c and h.month = m.month and h.cs_client_id = g.id;
   n_hs_removed := n_hs_removed + jsonb_array_length(v_gone);
   for x in select * from jsonb_to_recordset(v_gone) g(external_id text, name text) loop
    w := w || format('HS %s removido (linha sumiu da aba): %s (%s).', to_char(m.month, 'MM/YYYY'), x.name, x.external_id);
   end loop;
  end if;
 end loop;

 -- ---------------------------------------------------------- metas
 for x in select g.squad from jsonb_to_recordset(coalesce(p_payload->'goals', '[]')) g(squad text)
  where mavi_private.cs_squad_match(c, g.squad) is null group by g.squad loop
  w := w || format('Metas: squad "%s" não reconhecido, linhas ignoradas. Confira o squad em Configurações › Squads (nome ou apelido).', x.squad);
 end loop;
 with g as (
  select distinct on (s, month) s, month, revenue, retention_pct, ticket, notes from (
   select mavi_private.cs_squad_match(c, r.squad) as s, r.*, e.n
   from jsonb_array_elements(coalesce(p_payload->'goals', '[]')) with ordinality as e(v, n)
   cross join lateral jsonb_to_record(e.v)
    as r(squad text, month date, revenue numeric, retention_pct numeric, ticket numeric, notes text)) z
  where s is not null order by s, month, n desc),
 up as (
  insert into public.cs_goals as t(company_id, squad_id, month, revenue, retention_pct, ticket, notes)
  select c, s, month, revenue, retention_pct, ticket, nullif(btrim(notes), '') from g
  on conflict (company_id, squad_id, month) do update set revenue = excluded.revenue,
   retention_pct = excluded.retention_pct, ticket = excluded.ticket, notes = excluded.notes, updated_at = now()
  where (t.revenue, t.retention_pct, t.ticket, t.notes)
   is distinct from (excluded.revenue, excluded.retention_pct, excluded.ticket, excluded.notes)
  returning 1)
 select count(*) into n_goals from up;

 -- ---------------------------------------------------------- eventos
 if p_payload ? 'events' and jsonb_typeof(p_payload->'events') = 'array' then
  for x in select e.external_id from jsonb_to_recordset(p_payload->'events') e(external_id text)
   where not exists (select 1 from public.cs_clients k where k.company_id = c and k.external_id = e.external_id) loop
   w := w || format('Evento: ID %s não existe na aba Clientes, ignorado.', x.external_id);
  end loop;
  drop table if exists pg_temp._cs_ev;
  create temp table _cs_ev on commit drop as
  select k.id as cs_client_id, e.kind, e.date,
   (array_agg(e.churn_reason order by e.n desc) filter (where e.churn_reason is not null))[1] as churn_reason
  from (select r.*, j.n from jsonb_array_elements(p_payload->'events') with ordinality as j(v, n)
   cross join lateral jsonb_to_record(j.v) as r(external_id text, kind text, date date, churn_reason text)) e
  join public.cs_clients k on k.company_id = c and k.external_id = e.external_id
  group by k.id, e.kind, e.date;
  with up as (
   insert into public.cs_client_events as t(company_id, cs_client_id, kind, date, churn_reason)
   select c, cs_client_id, kind, date, churn_reason from pg_temp._cs_ev
   on conflict (company_id, cs_client_id, kind, date) do update set churn_reason = excluded.churn_reason
    where t.churn_reason is distinct from excluded.churn_reason
   returning 1)
  select count(*) into n_events from up;
  if exists (select 1 from pg_temp._cs_ev) then
   for x in delete from public.cs_client_events e using public.cs_clients k
    where e.company_id = c and k.id = e.cs_client_id
     and not exists (select 1 from pg_temp._cs_ev v where v.cs_client_id = e.cs_client_id and v.kind = e.kind and v.date = e.date)
    returning k.name, e.kind, e.date loop
    n_events_removed := n_events_removed + 1;
    w := w || format('Evento removido (sumiu da aba): %s %s %s.', x.name, x.kind, to_char(x.date, 'DD/MM/YYYY'));
   end loop;
  end if;
 end if;

 -- 2º churn: quem reativou e churnou de novo precisa das DUAS linhas na aba
 -- EVENTOS (CHURN antigo e REATIVACAO antiga); sem a da reativação, ela some
 -- do net churn do mês dela (caso Nexus #4690, Set/26).
 for x in select k.external_id, k.name, k.reactivation_date, k.churn_date from public.cs_clients k
  where k.company_id = c and k.reactivation_date is not null and k.churn_date is not null
   and k.reactivation_date < k.churn_date
   and not exists (select 1 from public.cs_client_events e where e.company_id = c and e.cs_client_id = k.id
    and e.kind = 'REATIVACAO' and e.date = k.reactivation_date)
  order by k.reactivation_date loop
  w := w || format('⚠️ %s (#%s) reativou em %s e churnou de novo em %s, mas a aba EVENTOS não tem a linha "REATIVACAO %s" — essa reativação SUMIU do net churn de %s. Corrija adicionando em EVENTOS: %s | REATIVACAO | %s',
   x.name, x.external_id, to_char(x.reactivation_date, 'DD/MM/YYYY'), to_char(x.churn_date, 'DD/MM/YYYY'),
   to_char(x.reactivation_date, 'DD/MM/YYYY'), to_char(x.reactivation_date, 'MM/YYYY'),
   x.external_id, to_char(x.reactivation_date, 'DD/MM/YYYY'));
 end loop;

 -- ---------------------------------------------------------- ligação e registro
 n_linked := mavi_private.cs_link_auto(c, null);

 v_stats := jsonb_build_object(
  'clients_created', n_created, 'clients_updated', n_updated, 'clients_removed', n_removed,
  'cycles_upserted', n_cycles, 'cycles_removed', n_cycles_removed, 'payments_changed', n_payments,
  'replans', n_history, 'hs_upserted', n_hs, 'hs_removed', n_hs_removed, 'goals_upserted', n_goals,
  'events_upserted', n_events, 'events_removed', n_events_removed, 'links_changed', n_linked)
  || coalesce(p_payload->'meta', '{}');
 v_status := case when cardinality(w) > 0 then 'warning' else 'ok' end;
 insert into public.cs_sync_runs(company_id, trigger, by, started_at, status, stats, tabs, warnings, blocked)
 values (c, v_trigger, auth.uid(),
  coalesce((p_payload->'meta'->>'started_at')::timestamptz, now()), v_status, v_stats, v_tabs, w[1:500],
  case when jsonb_array_length(v_blocked) > 0 then v_blocked end)
 returning * into v_run;
 update public.cs_settings set claimed_at = null where company_id = c;
 delete from public.cs_sync_runs where company_id = c and started_at < now() - interval '60 days';
 perform mavi_private.cs_changed(c, 'sync');
 return mavi_private.cs_run_row(v_run);
end $$;

-- ------------------------------------------------------------ agendamento
-- A cada 5 minutos o banco vê se alguma planilha passou de 9 minutos sem
-- leitura e chama o servidor (/api/ai, com o segredo da MAVI).
create function mavi_private.cs_sync_kick() returns void
language plpgsql security definer set search_path = '' as $$
declare cfg mavi_private.ai_config; begin
 select * into cfg from mavi_private.ai_config where id;
 if not found then return; end if;
 if not exists (select 1 from public.cs_settings s where s.enabled and s.sheet_id is not null
  and (s.last_attempt_at is null or s.last_attempt_at < now() - interval '9 minutes')
  and (s.claimed_at is null or s.claimed_at < now() - interval '5 minutes')) then return; end if;
 perform net.http_post(url := cfg.url, body := '{"action":"cs-sync"}'::jsonb,
  headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || cfg.secret),
  timeout_milliseconds := 60000);
end $$;
revoke all on function mavi_private.cs_sync_kick() from public, anon, authenticated;

do $$ begin
 if exists (select 1 from pg_extension where extname = 'pg_cron') then
  perform cron.schedule('mavi-cs-sync', '*/5 * * * *', 'select mavi_private.cs_sync_kick();');
 end if;
end $$;

-- ------------------------------------------------------------ avisos de falhas
-- A leitura da planilha de CS entra nas rotinas do Painel da MAVI › Avisos.
create or replace function mavi_private.job_catalog()
returns table(job text, sort integer, label text, noun text, nouns text, fails boolean, stale_ok boolean,
 fail_after integer, stale_hours integer, link text)
language sql immutable set search_path = '' as $$
 values
  ('whatsapp_sweep', 1, 'Varredura do WhatsApp', null::text, null::text, true, true, 3, 6,
   '/mavi#whatsapp'),
  ('whatsapp_groups', 2, 'Leitura dos grupos do WhatsApp', 'grupo', 'grupos', true, false, 3, null::integer,
   '/mavi#whatsapp'),
  ('ads_sync', 3, 'Sincronização diária das campanhas', 'campanha', 'campanhas', true, true, 1, 30, '/campanhas'),
  ('ads_today', 4, 'Resultados de hoje das campanhas', 'campanha', 'campanhas', true, true, 4, null, '/campanhas'),
  ('campaign_insights', 5, 'Insights da MAVI nas campanhas', 'campanha', 'campanhas', true, false, 1, null,
   '/campanhas'),
  ('campaign_daily', 6, 'Leitura do dia da MAVI', 'campanha', 'campanhas', true, true, 1, null, '/campanhas'),
  ('make_leads', 7, 'Leads da página de captura da Make', null, null, false, true, null, 24, '/campanhas'),
  ('agent_sync', 8, 'Leitura do Agente Conversacional (n8n)', 'servidor', 'servidores', true, true, 2, 3,
   '/agente-conversacional'),
  ('social_media', 9, 'Publicação automática do Social Media', null, null, true, false, 1, null,
   '/planejamento/social-media'),
  ('radar', 10, 'Leituras do Radar do cliente', null, null, true, true, 3, null, '/radar'),
  ('temperature', 11, 'Leituras do Termômetro', null, null, true, true, 3, null, '/termometro'),
  ('task_recurrences', 12, 'Repetição de tarefas', 'tarefa', 'tarefas', true, false, 1, null, '/tarefas'),
  ('cs_sync', 13, 'Leitura da planilha de CS', null, null, true, true, 3, 2, '/configuracoes#config-cs')
$$;
revoke all on function mavi_private.job_catalog() from public, anon, authenticated;

create function mavi_private.job_cs_sync() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
 perform mavi_private.job_report(new.company_id, 'cs_sync', new.status <> 'error', new.error);
 return null;
end $$;
revoke all on function mavi_private.job_cs_sync() from public, anon, authenticated;
create trigger job_cs_sync after insert on public.cs_sync_runs
 for each row when (new.trigger = 'schedule') execute function mavi_private.job_cs_sync();

-- ------------------------------------------------------------ permissões
revoke all on function public.cs_squads(uuid) from public, anon;
grant execute on function public.cs_squads(uuid) to authenticated;
revoke all on function public.save_cs_squad(uuid, uuid, text, text, text[], uuid[], uuid[], boolean) from public, anon;
grant execute on function public.save_cs_squad(uuid, uuid, text, text, text[], uuid[], uuid[], boolean) to authenticated;
revoke all on function public.delete_cs_squad(uuid) from public, anon;
grant execute on function public.delete_cs_squad(uuid) to authenticated;
revoke all on function public.cs_clients(uuid) from public, anon;
grant execute on function public.cs_clients(uuid) to authenticated;
revoke all on function public.set_cs_client_link(uuid, uuid, boolean) from public, anon;
grant execute on function public.set_cs_client_link(uuid, uuid, boolean) to authenticated;
revoke all on function public.cs_client_link_log(uuid) from public, anon;
grant execute on function public.cs_client_link_log(uuid) to authenticated;
revoke all on function public.cs_settings(uuid) from public, anon;
grant execute on function public.cs_settings(uuid) to authenticated;
revoke all on function public.save_cs_settings(uuid, text, boolean) from public, anon;
grant execute on function public.save_cs_settings(uuid, text, boolean) to authenticated;
revoke all on function public.cs_sync_runs(uuid, integer) from public, anon;
grant execute on function public.cs_sync_runs(uuid, integer) to authenticated;
-- O agendamento chama como anônimo, com o segredo.
revoke all on function public.cs_sync_targets(text, uuid) from public;
grant execute on function public.cs_sync_targets(text, uuid) to anon, authenticated;
revoke all on function public.cs_sync_store(text, uuid, jsonb, text, text, boolean) from public;
grant execute on function public.cs_sync_store(text, uuid, jsonb, text, text, boolean) to anon, authenticated;

notify pgrst, 'reload schema';

commit;
