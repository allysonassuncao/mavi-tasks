// Customer Success, fase 2 (migration 20270522090000_cs_dashboard): a
// importação do histórico do dash antigo (scripts/import-cs-dash.mjs), o
// painel de CS como tipo de dashboard e o acesso aos dados (pessoas, equipes,
// link público e com senha).
import assert from "node:assert/strict";
import { createTestDatabase } from "./database-fixture.mjs";
import { readDump, renderImport } from "./import-cs-dash.mjs";

const db = await createTestDatabase();
const uid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const [A, admin, gestor, bia, caio, team] = [1, 10, 11, 12, 13, 20].map(uid);
await db.query(`insert into auth.users select unnest($1::uuid[])`, [[admin, gestor, bia, caio]]);
await db.query(`insert into companies(id,name) values($1,'Make')`, [A]);
await db.query(
  `insert into memberships(company_id,user_id,name,role) values
   ($1,$2,'Ana Admin','admin'),($1,$3,'Gil Gestor','manager'),($1,$4,'Bia CS','member'),($1,$5,'Caio Criação','member')`,
  [A, admin, gestor, bia, caio],
);
await db.query(`insert into teams(id, company_id, name) values ($1, $2, 'CS')`, [team, A]);
await db.query(`insert into team_members(company_id, team_id, user_id) values ($1, $2, $3)`, [A, team, bia]);
async function as(user) {
  await db.exec("reset role");
  await db.query(`select set_config('request.jwt.claim.sub',$1,false)`, [user ?? ""]);
  await db.exec(`set role ${user ? "authenticated" : "anon"}`);
}
async function rpc(name, args) {
  return (
    await db.query(`select to_jsonb(public.${name}(${args.map((_, i) => `$${i + 1}`).join(",")})) as result`, args)
  ).rows[0].result;
}
const sql = async (text, args = []) => {
  await db.exec("reset role");
  return (await db.query(text, args)).rows;
};
let passed = 0;
async function check(title, fn) {
  try {
    await fn();
    passed++;
    console.log(`PASS ${title}`);
  } catch (e) {
    console.error(`FAIL ${title}`);
    throw e;
  }
}

// Um dump do phpMyAdmin pequeno, com as mesmas tabelas e colunas do real.
const DUMP = `
INSERT INTO \`squads\` (\`id\`, \`nome\`, \`cor_hex\`, \`ativo\`, \`ordem\`, \`created_at\`) VALUES
(1, 'Primogênito', '#FF8000', 1, 1, '2026-05-05 23:17:12'),
(2, 'Tão Tão Perto', '#FFC266', 1, 2, '2026-05-05 23:17:12');
INSERT INTO \`clientes\` (\`id\`, \`id_externo\`, \`nome\`, \`squad_id\`, \`vertical\`, \`origem_id\`, \`tipo_id\`, \`mes_de_trial\`, \`status_id\`, \`data_entrada\`, \`data_churn\`, \`data_reativacao\`, \`motivo_churn_id\`, \`observacoes\`, \`created_at\`, \`updated_at\`) VALUES
(10, '4862', 'MaqFlex', 2, NULL, 1, 'BASE', 4, 'ATIVO', '2026-03-31', NULL, NULL, NULL, NULL, '2026-05-23 04:35:41', '2026-05-23 04:35:41'),
(11, '4486', 'Boteco em Casa', 1, NULL, 1, 'BASE', NULL, 'ATIVO', '2025-03-01', NULL, NULL, NULL, 'cliente \\'antigo\\'', '2026-05-23 04:35:41', '2026-05-23 04:35:41'),
(12, '4690', 'Nexus', 2, NULL, 2, 'BASE', NULL, 'INATIVO', '2025-12-01', '2026-08-30', '2026-07-16', 4, NULL, '2026-05-23 04:35:41', '2026-05-23 04:35:41');
INSERT INTO \`ciclos_pagamento\` (\`id\`, \`cliente_id\`, \`squad_id\`, \`mes_competencia\`, \`data_inicio_ciclo\`, \`data_fim_ciclo\`, \`data_cobranca\`, \`valor_planejado_melhor\`, \`valor_planejado_provavel\`, \`probabilidade\`, \`valor_pago\`, \`data_pagamento\`, \`status_pagamento\`, \`adimplencia\`, \`eh_acl\`, \`valor_acl\`, \`valor_mensalidade_prevista\`, \`valor_mensalidade\`, \`observacoes\`, \`m1_ja_descontado\`, \`created_at\`, \`updated_at\`) VALUES
(1, 10, NULL, '2026-03-01', '2026-03-31', '2026-04-30', '2026-03-31', '5000.00', '5000.00', 'ALTA', '5000.00', '2026-03-31', 'PAGO', 'ADIMPLENTE', 0, NULL, NULL, NULL, NULL, 0, '2026-05-23 04:35:41', '2026-05-23 04:35:41'),
(2, 11, 1, '2026-03-01', '2026-03-01', '2026-03-31', '2026-03-10', '4500.00', '4500.00', 'PROVAVEL', '4500.00', '2026-03-12', 'PAGO', 'ADIMPLENTE', 1, '1000.00', NULL, NULL, NULL, 0, '2026-05-23 04:35:41', '2026-05-23 04:35:41'),
(3, 11, NULL, '2026-09-01', '2026-08-31', '2026-09-19', '2026-09-03', '4500.00', '4500.00', 'ALTA', '4500.00', '2026-09-08', 'PAGO', 'ADIMPLENTE', 0, NULL, '1600.00', '1600.00', NULL, 0, '2026-05-23 04:35:41', '2026-05-23 04:35:41');
INSERT INTO \`pagamentos_parcelas\` (\`id\`, \`cliente_id\`, \`mes_competencia\`, \`ordem\`, \`data_pagamento\`, \`valor\`, \`created_at\`) VALUES
(1, 11, '2026-03-01', 1, '2026-03-12', '2250.00', '2026-08-01 10:00:00'),
(2, 11, '2026-03-01', 2, '2026-03-20', '2250.00', '2026-08-01 10:00:00');
INSERT INTO \`ciclos_historico\` (\`id\`, \`cliente_id\`, \`mes_competencia\`, \`data_fim_ciclo\`, \`data_cobranca\`, \`valor_planejado_provavel\`, \`registrado_em\`) VALUES
(1, 11, '2026-03-01', '2026-03-31', '2026-03-10', '4500.00', '2026-03-02 10:00:00'),
(2, 11, '2026-03-01', '2026-03-31', '2026-03-15', '4500.00', '2026-03-05 10:00:00');
INSERT INTO \`health_score_mensal\` (\`id\`, \`cliente_id\`, \`mes_ref\`, \`c_aprovacao_criat\`, \`c_reuniao_align\`, \`c_pagamento_dia\`, \`c_percepcao_valor\`, \`c_meta_batida\`, \`score_pct\`, \`faixa\`, \`observacoes\`, \`created_at\`, \`updated_at\`) VALUES
(1, 11, '2026-03-01', 1, 1, 1, 1, 0, '70.00', 'ALERTA', NULL, '2026-05-23 04:35:41', '2026-05-23 04:35:41'),
(2, 10, '2026-03-01', 0, 0, 0, 0, 0, '45.00', 'CRITICO', NULL, '2026-05-23 04:35:41', '2026-05-23 04:35:41');
INSERT INTO \`metas_squad\` (\`id\`, \`squad_id\`, \`mes_ref\`, \`meta_faturamento\`, \`meta_retencao_pct\`, \`meta_ticket\`, \`observacoes\`, \`created_at\`, \`updated_at\`) VALUES
(1, 1, '2026-03-01', '150000.00', NULL, NULL, NULL, '2026-05-23 04:35:41', '2026-05-23 04:35:41');
INSERT INTO \`eventos_cliente\` (\`id\`, \`cliente_id\`, \`tipo\`, \`data\`, \`motivo_churn_id\`, \`created_at\`) VALUES
(1, 12, 'CHURN', '2026-04-30', 4, '2026-08-01 10:00:00'),
(2, 12, 'REATIVACAO', '2026-07-16', NULL, '2026-08-01 10:00:00');
`;
const importSql = renderImport(readDump(DUMP, "teste.sql"), "teste.sql");
/** Roda o arquivo como o editor do Supabase (vários comandos, uma transação). */
async function runImport() {
  await db.exec("reset role");
  try {
    return await db.exec(importSql);
  } catch (e) {
    await db.exec("rollback").catch(() => undefined);
    throw e;
  }
}

await check("sem planilha configurada, a importação para com aviso", async () => {
  await assert.rejects(runImport(), /Configure a planilha de CS/);
});

await as(admin);
await rpc("save_cs_settings", [A, "https://docs.google.com/spreadsheets/d/1BY4n2nKKznZj0RDHU8fGUhYUbjFqC5i691ip3Zq1Ksc/edit", true]);
await rpc("save_cs_squad", [A, null, "Primogênito", "#ff8000", ["1"], [], [], false]);

await check("squad do dump sem correspondente: nada é gravado", async () => {
  await assert.rejects(runImport(), /Squads sem correspondente no MAVI: Tão Tão Perto/);
  assert.equal((await sql(`select count(*)::int n from cs_clients`))[0].n, 0);
});

await as(admin);
await rpc("save_cs_squad", [A, null, "Tão Tão Perto", "#ffc266", ["2"], [], [], false]);
// A planilha já trouxe o MaqFlex e o setembro do Boteco: a importação não mexe neles.
await as(null);
const secret = "s".repeat(40);
await sql(`insert into mavi_private.ai_config(url, secret) values('https://mavi.test/api/ai', $1)`, [secret]);
await rpc("cs_sync_store", [secret, A, JSON.stringify({
  tabs: [], warnings: [],
  clients: [
    { external_id: "4862", name: "MaqFlex (planilha)", squad: "Tão Tão Perto", vertical: null, origin: "comercial",
      kind: "BASE", trial_month: 4, status: "ATIVO", entry_date: "2026-03-31", churn_date: null, reactivation_date: null,
      churn_reason: null, notes: null },
    { external_id: "4486", name: "Boteco em Casa", squad: "Primogênito", vertical: null, origin: "comercial", kind: "BASE",
      trial_month: null, status: "ATIVO", entry_date: "2025-03-01", churn_date: null, reactivation_date: null,
      churn_reason: null, notes: null },
  ],
  cycles: [{ month: "2026-09-01", rows: [{ external_id: "4486", squad: null, start_date: "2026-08-31",
    end_date: "2026-09-19", billing_date: "2026-09-03", best: 4500, probable: 4500, probability: "ALTA", paid: 9999,
    paid_date: "2026-09-08", status: "PAGO", adimplencia: "ADIMPLENTE", acl: false, acl_value: null, fee_planned: null,
    fee_paid: null, payments: [] }] }],
  hs: [], goals: [], events: null, meta: {},
}), null, "schedule", false]);

await check("a importação preenche só o que falta e respeita a planilha", async () => {
  const r = await runImport();
  assert.ok(r);
  const clients = await sql(`select external_id, name, squad_id is not null as has_squad, notes from cs_clients order by 1`);
  assert.deepEqual(clients.map((c) => `${c.external_id}:${c.name}`), ["4486:Boteco em Casa", "4690:Nexus", "4862:MaqFlex (planilha)"]);
  const cycles = await sql(`select k.external_id, y.month::text, y.paid::float, y.source, y.acl, y.acl_value::float acl_value,
     y.fee_planned::float fee, s.name squad
    from cs_cycles y join cs_clients k on k.id = y.cs_client_id left join cs_squads s on s.id = y.squad_id order by 1, 2`);
  assert.deepEqual(cycles.map((c) => `${c.external_id}|${c.month}|${c.paid}|${c.source}`), [
    "4486|2026-03-01|4500|import", "4486|2026-09-01|9999|sheet", "4862|2026-03-01|5000|import",
  ]);
  const mar = cycles.find((c) => c.external_id === "4486" && c.month === "2026-03-01");
  assert.equal(mar.acl, true);
  assert.equal(mar.acl_value, 1000);
  assert.equal(mar.squad, "Primogênito", "o squad do mês vem do dump");
  assert.equal((await sql(`select count(*)::int n from cs_cycle_payments`))[0].n, 2);
  assert.equal((await sql(`select count(*)::int n from cs_cycle_history`))[0].n, 2 + 1, "2 fotos do dump + 1 da planilha");
  const hs = await sql(`select k.external_id, h.score::float, h.band from cs_health_scores h join cs_clients k on k.id = h.cs_client_id order by 1`);
  assert.deepEqual(hs.map((h) => `${h.external_id}:${h.score}:${h.band}`), ["4486:70:ALERTA", "4862:45:CRITICO"],
    "critérios recalculam a nota; sem critérios vale a nota do dump");
  assert.equal((await sql(`select count(*)::int n from cs_goals`))[0].n, 1);
  assert.equal((await sql(`select count(*)::int n from cs_client_events`))[0].n, 2);
});

await check("rodar a importação de novo não duplica nada", async () => {
  await runImport();
  assert.equal((await sql(`select count(*)::int n from cs_cycles`))[0].n, 3);
  assert.equal((await sql(`select count(*)::int n from cs_cycle_history`))[0].n, 3);
  assert.equal((await sql(`select count(*)::int n from cs_cycle_payments`))[0].n, 2);
});

let dash;
await check("só administradores e gestores criam o painel de CS", async () => {
  await as(bia);
  await assert.rejects(rpc("create_cs_dashboard", [A, "CS Make", ""]), /Somente administradores e gestores/);
  await as(gestor);
  dash = await rpc("create_cs_dashboard", [A, "CS Make", "Painel do time de CS"]);
  assert.equal(dash.kind, "cs");
  assert.equal(dash.password_hash, undefined);
  await as(admin);
  const list = (await db.query(`select kind from public.dashboards where id = $1`, [dash.id])).rows;
  assert.equal(list[0].kind, "cs");
});

await check("os dados do painel: gestor sim, colaborador só se compartilharem", async () => {
  await as(admin);
  const d = await rpc("cs_dashboard_data", [dash.id, null, null]);
  assert.equal(d.access, "editor");
  assert.equal(d.clients.length, 3);
  assert.equal(d.cycles.length, 3);
  assert.equal(d.squads.length, 2);
  assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(d.today));
  assert.equal(d.sync.status, "ok");
  assert.deepEqual(d.clients.map((c) => c.external_id), ["4486", "4690", "4862"], "pelo código");
  assert.equal(d.payments.length, 2);
  assert.equal(d.history.length, 3);
  await as(bia);
  await assert.rejects(rpc("cs_dashboard_data", [dash.id, null, null]), /Sem acesso/);
  await as(admin);
  await rpc("set_dashboard_sharing", [dash.id, "none", null, [], [team], false, null]);
  await as(bia);
  assert.equal((await rpc("cs_dashboard_data", [dash.id, null, null])).access, "viewer");
  await as(caio);
  await assert.rejects(rpc("cs_dashboard_data", [dash.id, null, null]), /Sem acesso/);
});

await check("link público e com senha", async () => {
  await as(admin);
  const shared = await rpc("set_dashboard_sharing", [dash.id, "public", null, [], [], false, null]);
  await as(null);
  const meta = await rpc("dashboard_shared", [shared.share_token, null]);
  assert.equal(meta.kind, "cs");
  assert.equal((await rpc("cs_dashboard_data", [null, shared.share_token, null])).clients.length, 3);
  await as(admin);
  const pw = await rpc("set_dashboard_sharing", [dash.id, "password", "senha-forte-1", [], [], false, null]);
  await as(null);
  assert.equal((await rpc("cs_dashboard_data", [null, pw.share_token, "errada"])).error, "Senha incorreta.");
  assert.equal((await rpc("cs_dashboard_data", [null, pw.share_token, "senha-forte-1"])).cycles.length, 3);
  await assert.rejects(rpc("cs_dashboard_data", [null, "x".repeat(64), null]), /não encontrado/);
});

await check("um dashboard comum não entrega dados de CS", async () => {
  await as(admin);
  const grid = await rpc("save_dashboard", [A, null, "Operação", "", "[]", "{}", null]);
  await assert.rejects(rpc("cs_dashboard_data", [grid.id, null, null]), /Painel de CS não encontrado/);
});

console.log(`\n${passed} verificações do painel de CS passaram.`);
