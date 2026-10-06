// Customer Success (fase 2): importa o histórico do dash antigo
// (cs-make-dashboard, MySQL) para as tabelas cs_* do MAVI, num arquivo SQL
// para o editor do Supabase (roda como postgres; os checks das tabelas
// continuam valendo).
//
//   node scripts/import-cs-dash.mjs --input makem308_dashcs.sql --out-dir cs-dash-import
//
// Gera 02-importacao.sql: uma transação, idempotente (rodar de novo não
// duplica nada). Regras combinadas com o usuário (06/10/2026):
//  * a empresa é a que tem a planilha de CS configurada (cs_settings);
//  * os squads do dump são achados pelo nome/apelido em Configurações › Squads
//    (se algum não for achado, nada é gravado);
//  * a planilha continua mandando: o que já veio dela (clientes, ciclos, HS,
//    metas, eventos) fica como está; a importação só preenche o que falta —
//    os meses que não estão mais na planilha (source = 'import');
//  * o histórico de replanejamento entra inteiro (sem repetir foto);
//  * no fim, liga os clientes de CS aos clientes do MAVI (automático).
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseSqlDump, sqlString } from "./import-maso-campaigns.mjs";

const ORIGIN = { 1: "comercial", 2: "reativacao", 3: "troca" };
const REASON = { 1: "performance", 2: "financeiro", 3: "fechou", 4: "estrategia" };
const q = (v) => (v === null || v === undefined || v === "" ? "null" : sqlString(v));
const n = (v) => (v === null || v === undefined || v === "" ? "null" : String(Number(v)));
const b = (v) => (String(v) === "1" ? "true" : "false");

/** As linhas do dump que o MAVI usa, já normalizadas. */
export function readDump(text, file = "dump") {
  const t = parseSqlDump(text, file);
  const need = (name) => {
    const rows = t.get(name);
    if (!rows) throw new Error(`A tabela ${name} não está no arquivo ${file}.`);
    return rows;
  };
  return {
    squads: need("squads"),
    clients: need("clientes"),
    cycles: need("ciclos_pagamento"),
    payments: t.get("pagamentos_parcelas") ?? [],
    history: t.get("ciclos_historico") ?? [],
    hs: t.get("health_score_mensal") ?? [],
    goals: t.get("metas_squad") ?? [],
    events: t.get("eventos_cliente") ?? [],
    revenue: t.get("faturamento_real_squad_mes") ?? [],
    multipliers: t.get("multiplicador_mensal") ?? [],
  };
}

function values(rows, fn) {
  return rows.length ? rows.map((r) => `(${fn(r).join(", ")})`).join(",\n") : null;
}

export function renderImport(d, source) {
  const ext = new Map(d.clients.map((c) => [String(c.id), c.id_externo]));
  const out = [
    "-- Customer Success: IMPORTAÇÃO do histórico do dash antigo (migração 20270520090000).",
    `-- Origem: ${source} · ${d.clients.length} clientes, ${d.cycles.length} ciclos, ${d.hs.length} notas de HS,`,
    `--   ${d.goals.length} metas, ${d.events.length} eventos, ${d.payments.length} parcelas, ${d.history.length} fotos de replanejamento.`,
    "-- Uma transação; idempotente. O que já veio da planilha não é alterado.",
    "",
    "begin;",
    "",
    "create temp table cs_imp_company on commit drop as",
    " select company_id from public.cs_settings where sheet_id is not null;",
    "do $$ begin",
    " if (select count(*) from cs_imp_company) <> 1 then",
    "  raise exception 'Configure a planilha de CS (Equipe e configurações › Customer Success) de uma única empresa antes de importar.';",
    " end if;",
    "end $$;",
    "",
    "-- Squads do dash antigo → squads do MAVI (pelo nome ou apelido).",
    "create temp table cs_imp_squad(old_id integer primary key, nome text, squad_id uuid) on commit drop;",
    `insert into cs_imp_squad(old_id, nome) values\n${values(d.squads, (s) => [n(s.id), q(s.nome)])};`,
    "update cs_imp_squad set squad_id = mavi_private.cs_squad_match((select company_id from cs_imp_company), nome);",
    "do $$ declare v text; begin",
    " select string_agg(nome, ', ') into v from cs_imp_squad where squad_id is null;",
    " if v is not null then",
    "  raise exception 'Squads sem correspondente no MAVI: %. Crie-os (ou adicione o nome como apelido) em Equipe e configurações › Squads.', v;",
    " end if;",
    "end $$;",
    "",
    "-- Clientes: só os que a planilha ainda não trouxe.",
    "create temp table cs_imp_client(external_id text primary key, name text, squad integer, vertical text, origin text, kind text,",
    " trial_month integer, status text, entry_date date, churn_date date, reactivation_date date, churn_reason text, notes text) on commit drop;",
    `insert into cs_imp_client values\n${values(d.clients, (c) => [q(c.id_externo), q(c.nome), n(c.squad_id), q(c.vertical),
      q(ORIGIN[c.origem_id] ?? "comercial"), q(c.tipo_id), n(c.mes_de_trial), q(c.status_id), q(c.data_entrada), q(c.data_churn),
      q(c.data_reativacao), q(REASON[c.motivo_churn_id] ?? null), q(c.observacoes)])};`,
    "insert into public.cs_clients(company_id, external_id, name, squad_id, vertical, origin, kind, trial_month, status,",
    " entry_date, churn_date, reactivation_date, churn_reason, notes)",
    "select (select company_id from cs_imp_company), i.external_id, i.name, s.squad_id, i.vertical, i.origin, i.kind, i.trial_month,",
    " i.status, i.entry_date, i.churn_date, i.reactivation_date, i.churn_reason, i.notes",
    "from cs_imp_client i join cs_imp_squad s on s.old_id = i.squad",
    "on conflict (company_id, external_id) do nothing;",
    "",
    "-- Ciclos: os meses que a planilha não tem mais (os dela ficam como estão).",
    "create temp table cs_imp_cycle(external_id text, month date, squad integer, start_date date, end_date date, billing_date date,",
    " best numeric, probable numeric, probability text, paid numeric, paid_date date, status text, adimplencia text, acl boolean,",
    " acl_value numeric, fee_planned numeric, fee_paid numeric, m1_discounted boolean, notes text) on commit drop;",
    `insert into cs_imp_cycle values\n${values(d.cycles, (y) => [q(ext.get(String(y.cliente_id))), q(y.mes_competencia),
      n(y.squad_id), q(y.data_inicio_ciclo), q(y.data_fim_ciclo), q(y.data_cobranca), n(y.valor_planejado_melhor ?? 0),
      n(y.valor_planejado_provavel ?? 0), q(y.probabilidade), n(y.valor_pago ?? 0), q(y.data_pagamento), q(y.status_pagamento),
      q(y.adimplencia), b(y.eh_acl), String(y.eh_acl) === "1" ? n(y.valor_acl) : "null", n(y.valor_mensalidade_prevista),
      n(y.valor_mensalidade), b(y.m1_ja_descontado), q(y.observacoes)])};`,
    "insert into public.cs_cycles(company_id, cs_client_id, month, squad_id, start_date, end_date, billing_date, best, probable,",
    " probability, paid, paid_date, status, adimplencia, acl, acl_value, fee_planned, fee_paid, m1_discounted, notes, source)",
    "select k.company_id, k.id, i.month, s.squad_id, i.start_date, i.end_date, i.billing_date, coalesce(i.best, 0),",
    " coalesce(i.probable, 0), i.probability, coalesce(i.paid, 0), i.paid_date, i.status, i.adimplencia, i.acl,",
    " case when i.acl and i.acl_value > 0 then i.acl_value end, nullif(i.fee_planned, 0), nullif(i.fee_paid, 0),",
    " i.m1_discounted, i.notes, 'import'",
    "from cs_imp_cycle i",
    "join public.cs_clients k on k.company_id = (select company_id from cs_imp_company) and k.external_id = i.external_id",
    "left join cs_imp_squad s on s.old_id = i.squad",
    "on conflict (company_id, cs_client_id, month) do nothing;",
    "",
    "-- Parcelas (pagamento picado) dos ciclos importados.",
    "create temp table cs_imp_payment(external_id text, month date, ord integer, paid_date date, amount numeric) on commit drop;",
    ...(d.payments.length ? [`insert into cs_imp_payment values\n${values(d.payments, (p) => [q(ext.get(String(p.cliente_id))),
      q(p.mes_competencia), n(p.ordem), q(p.data_pagamento), n(p.valor)])};`] : []),
    "insert into public.cs_cycle_payments(company_id, cycle_id, ord, paid_date, amount)",
    "select y.company_id, y.id, i.ord, i.paid_date, i.amount",
    "from cs_imp_payment i",
    "join public.cs_clients k on k.company_id = (select company_id from cs_imp_company) and k.external_id = i.external_id",
    "join public.cs_cycles y on y.company_id = k.company_id and y.cs_client_id = k.id and y.month = i.month and y.source = 'import'",
    "where i.amount > 0",
    "on conflict (company_id, cycle_id, ord) do nothing;",
    "",
    "-- Fotos de replanejamento (sem repetir a mesma foto).",
    "create temp table cs_imp_history(n integer, external_id text, month date, end_date date, billing_date date,",
    " probable numeric, recorded_at timestamp) on commit drop;",
    ...(d.history.length ? [`insert into cs_imp_history values\n${values([...d.history].sort((x, y) => Number(x.id) - Number(y.id)),
      (h) => [n(h.id), q(ext.get(String(h.cliente_id))), q(h.mes_competencia), q(h.data_fim_ciclo), q(h.data_cobranca),
        n(h.valor_planejado_provavel), q(h.registrado_em)])};`] : []),
    "-- Na ordem do dash antigo (o id dele), para o trajeto da cobrança sair certo.",
    "insert into public.cs_cycle_history(company_id, cs_client_id, month, end_date, billing_date, probable, recorded_at)",
    "select k.company_id, k.id, i.month, i.end_date, i.billing_date, i.probable, i.recorded_at at time zone 'America/Sao_Paulo'",
    "from cs_imp_history i",
    "join public.cs_clients k on k.company_id = (select company_id from cs_imp_company) and k.external_id = i.external_id",
    "where not exists (select 1 from public.cs_cycle_history h where h.company_id = k.company_id and h.cs_client_id = k.id",
    " and h.month = i.month and h.recorded_at = i.recorded_at at time zone 'America/Sao_Paulo'",
    " and h.end_date is not distinct from i.end_date and h.billing_date is not distinct from i.billing_date",
    " and h.probable is not distinct from i.probable)",
    "order by i.n;",
    "",
    "-- Health Score: os meses que a planilha não tem mais.",
    "create temp table cs_imp_hs(external_id text, month date, creatives boolean, meeting boolean, payment boolean,",
    " perception boolean, goal boolean, score numeric, notes text) on commit drop;",
    ...(d.hs.length ? [`insert into cs_imp_hs values\n${values(d.hs, (h) => [q(ext.get(String(h.cliente_id))), q(h.mes_ref),
      b(h.c_aprovacao_criat), b(h.c_reuniao_align), b(h.c_pagamento_dia), b(h.c_percepcao_valor), b(h.c_meta_batida),
      n(h.score_pct), q(h.observacoes)])};`] : []),
    "insert into public.cs_health_scores(company_id, cs_client_id, month, creatives, meeting, payment, perception, goal,",
    " manual_score, notes, source)",
    "select k.company_id, k.id, i.month, i.creatives, i.meeting, i.payment, i.perception, i.goal,",
    " case when i.score > 0 then least(100, i.score) end, i.notes, 'import'",
    "from cs_imp_hs i",
    "join public.cs_clients k on k.company_id = (select company_id from cs_imp_company) and k.external_id = i.external_id",
    "on conflict (company_id, cs_client_id, month) do nothing;",
    "",
    "-- Metas por squad e mês.",
    "create temp table cs_imp_goal(squad integer, month date, revenue numeric, retention_pct numeric, ticket numeric, notes text)",
    " on commit drop;",
    ...(d.goals.length ? [`insert into cs_imp_goal values\n${values(d.goals, (g) => [n(g.squad_id), q(g.mes_ref),
      n(g.meta_faturamento), n(g.meta_retencao_pct), n(g.meta_ticket), q(g.observacoes)])};`] : []),
    "insert into public.cs_goals(company_id, squad_id, month, revenue, retention_pct, ticket, notes)",
    "select (select company_id from cs_imp_company), s.squad_id, i.month, i.revenue, i.retention_pct, i.ticket, i.notes",
    "from cs_imp_goal i join cs_imp_squad s on s.old_id = i.squad",
    "on conflict (company_id, squad_id, month) do nothing;",
    "",
    "-- Pares antigos de churn/reativação (aba EVENTOS).",
    "create temp table cs_imp_event(external_id text, kind text, date date, churn_reason text) on commit drop;",
    ...(d.events.length ? [`insert into cs_imp_event values\n${values(d.events, (e) => [q(ext.get(String(e.cliente_id))),
      q(e.tipo), q(e.data), q(REASON[e.motivo_churn_id] ?? null)])};`] : []),
    "insert into public.cs_client_events(company_id, cs_client_id, kind, date, churn_reason)",
    "select k.company_id, k.id, i.kind, i.date, i.churn_reason",
    "from cs_imp_event i",
    "join public.cs_clients k on k.company_id = (select company_id from cs_imp_company) and k.external_id = i.external_id",
    "on conflict (company_id, cs_client_id, kind, date) do nothing;",
    "",
    ...(d.revenue.length ? [
      "-- Faturamento oficial lançado à mão no dash antigo.",
      `insert into public.cs_official_revenue(company_id, squad_id, month, total, achieved, base_id_compl, new_tp_a, reactivation, note)\nselect (select company_id from cs_imp_company), s.squad_id, v.month::date, v.total, v.achieved, v.b, v.nt, v.r, v.note\nfrom (values\n${values(d.revenue, (r) => [n(r.squad_id), q(r.mes_ref), n(r.total), n(r.atingido), n(r.base_id_compl ?? 0), n(r.novos_tp_a ?? 0), n(r.reativacao ?? 0), q(r.observacao)])}\n) v(squad, month, total, achieved, b, nt, r, note) join cs_imp_squad s on s.old_id = v.squad\non conflict (company_id, squad_id, month) do nothing;`, ""] : []),
    ...(d.multipliers.length ? [
      "-- O M de cada cliente no mês, do dash antigo.",
      `insert into public.cs_multipliers(company_id, cs_client_id, month, value, notes)\nselect k.company_id, k.id, v.month::date, v.value, v.notes\nfrom (values\n${values(d.multipliers, (m) => [q(ext.get(String(m.cliente_id))), q(m.mes_ref), n(m.valor_m), q(m.observacoes)])}\n) v(external_id, month, value, notes)\njoin public.cs_clients k on k.company_id = (select company_id from cs_imp_company) and k.external_id = v.external_id\non conflict (company_id, cs_client_id, month) do nothing;`, ""] : []),
    "-- Liga os clientes novos ao cliente do MAVI (automático) e avisa as telas.",
    "select mavi_private.cs_link_auto((select company_id from cs_imp_company), null);",
    "select mavi_private.cs_changed((select company_id from cs_imp_company), 'sync');",
    "",
    "-- Resultado",
    "select (select count(*) from public.cs_clients where company_id = c.company_id) as clientes,",
    " (select count(*) from public.cs_cycles where company_id = c.company_id) as ciclos,",
    " (select count(*) from public.cs_cycles where company_id = c.company_id and source = 'import') as ciclos_importados,",
    " (select count(*) from public.cs_health_scores where company_id = c.company_id) as notas_hs,",
    " (select count(*) from public.cs_goals where company_id = c.company_id) as metas,",
    " (select count(*) from public.cs_cycle_history where company_id = c.company_id) as fotos_replanejamento",
    "from cs_imp_company c;",
    "",
    "commit;",
    "",
  ];
  return out.join("\n");
}

export async function main(argv, log = console.log) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--input" || a === "--out-dir") args[a.slice(2)] = argv[++i];
    else throw new Error(`Opção desconhecida: ${a}`);
  }
  if (!args.input || !args["out-dir"])
    throw new Error("Uso: node scripts/import-cs-dash.mjs --input makem308_dashcs.sql --out-dir <pasta>");
  const d = readDump(await readFile(args.input, "utf8"), args.input);
  const dir = resolve(args["out-dir"]);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "02-importacao.sql"), renderImport(d, args.input.split("/").pop()));
  log(`${d.clients.length} clientes, ${d.cycles.length} ciclos, ${d.hs.length} notas de HS, ${d.goals.length} metas, ` +
    `${d.events.length} eventos, ${d.payments.length} parcelas, ${d.history.length} fotos de replanejamento.`);
  log(`Arquivo em ${join(dir, "02-importacao.sql")}`);
  return d;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href)
  main(process.argv.slice(2)).catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
