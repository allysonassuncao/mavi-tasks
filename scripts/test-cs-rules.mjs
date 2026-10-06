// Customer Success, fase 3 (migration 20270523090000_cs_rules_sources): as
// regras com vigência (só administradores, só do mês atual em diante, com
// motivo e histórico; o Health Score é refeito) e as fontes de CS no
// construtor dos Dashboards (conferidas ao salvar; dados para quem recebe).
import assert from "node:assert/strict";
import { createTestDatabase } from "./database-fixture.mjs";

const db = await createTestDatabase();
const uid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const [A, admin, gestor, bia, team] = [1, 10, 11, 12, 20].map(uid);
await db.query(`insert into auth.users select unnest($1::uuid[])`, [[admin, gestor, bia]]);
await db.query(`insert into companies(id,name) values($1,'Make')`, [A]);
await db.query(
  `insert into memberships(company_id,user_id,name,role) values
   ($1,$2,'Ana Admin','admin'),($1,$3,'Gil Gestor','manager'),($1,$4,'Bia CS','member')`,
  [A, admin, gestor, bia],
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

// O mês corrente no fuso da empresa (nunca current_date: o teste roda em UTC).
const cur = (await sql(`select date_trunc('month', mavi_private.company_today($1))::date::text m`, [A]))[0].m;
const prev = (await sql(`select ($1::date - interval '1 month')::date::text m`, [cur]))[0].m;
const next = (await sql(`select ($1::date + interval '1 month')::date::text m`, [cur]))[0].m;

await as(admin);
const squads = await rpc("save_cs_squad", [A, null, "Primogênito", "#ff8000", ["1"], [], [], false]);
const squad = squads[0].id;
await sql(`insert into cs_clients(company_id, external_id, name, squad_id, origin, kind, status, entry_date)
  values ($1, '4486', 'Boteco em Casa', $2, 'comercial', 'BASE', 'ATIVO', '2025-03-01')`, [A, squad]);
const client = (await sql(`select id from cs_clients`))[0].id;
// Meta batida (30) + percepção (25) = 55 → Alerta pelas faixas padrão.
for (const m of [prev, cur])
  await sql(`insert into cs_health_scores(company_id, cs_client_id, month, goal, perception, source)
    values ($1, $2, $3, true, true, 'sheet')`, [A, client, m]);
const hs = async () =>
  (await sql(`select month::text m, score::float s, band from cs_health_scores order by month`)).map((h) => `${h.m}:${h.s}:${h.band}`);

const NEW_RULES = {
  m1_commission: 2500,
  hs_weights: { goal: 40, perception: 25, payment: 15, meeting: 10, creatives: 10 },
  hs_bands: { satisfied: 80, alert: 60 },
};

await check("gestor consulta, colaborador não; só administrador muda", async () => {
  await as(gestor);
  const r = await rpc("cs_rules_admin", [A]);
  assert.equal(r.can_edit, false);
  assert.equal(r.current.m1_commission, 3000);
  assert.equal(r.current_month, cur);
  await assert.rejects(rpc("set_cs_rules", [A, cur, JSON.stringify(NEW_RULES), "teste"]), /Somente administradores/);
  await as(bia);
  await assert.rejects(rpc("cs_rules_admin", [A]), /Sem acesso/);
});

await check("os meses fechados não mudam; regras erradas e sem motivo não passam", async () => {
  await as(admin);
  await assert.rejects(rpc("set_cs_rules", [A, prev, JSON.stringify(NEW_RULES), "teste"]), /mês atual em diante/);
  await assert.rejects(rpc("set_cs_rules", [A, cur, JSON.stringify(NEW_RULES), " "]), /motivo/);
  await assert.rejects(
    rpc("set_cs_rules", [A, cur, JSON.stringify({ hs_weights: { goal: 50, perception: 25, payment: 15, meeting: 10, creatives: 10 } }), "x pesos"]),
    /somam 110/,
  );
  await assert.rejects(
    rpc("set_cs_rules", [A, cur, JSON.stringify({ hs_bands: { satisfied: 50, alert: 60 } }), "faixas"]),
    /Alerta abaixo de Satisfeito/,
  );
  assert.equal((await sql(`select count(*)::int n from cs_rules`))[0].n, 0);
});

await check("a nova regra vale do mês em diante e refaz o HS só desses meses", async () => {
  await as(admin);
  const r = await rpc("set_cs_rules", [A, cur, JSON.stringify(NEW_RULES), "Novo contrato comercial"]);
  assert.equal(r.current.m1_commission, 2500);
  assert.equal(r.current.ranking_weights.goal, 35, "o que não veio fica como estava");
  assert.deepEqual(await hs(), [`${prev}:55:ALERTA`, `${cur}:65:ALERTA`]);
  assert.equal(r.versions.length, 1);
  assert.equal(r.log.length, 1);
  assert.equal(r.log[0].before.m1_commission, 3000);
  assert.equal(r.log[0].after.m1_commission, 2500);
  assert.equal(r.log[0].by_name, "Ana Admin");
  // O painel lê as versões junto com os dados.
  const snap = (await sql(`select mavi_private.cs_snapshot($1) s`, [A]))[0].s;
  assert.equal(snap.rules[0].valid_from, cur);
});

await check("versão futura, troca e remoção ficam no histórico", async () => {
  await as(admin);
  let r = await rpc("set_cs_rules", [A, next, JSON.stringify({ m1_commission: 2000 }), "Comissão menor em breve"]);
  assert.equal(r.current.m1_commission, 2500, "a futura ainda não vale");
  assert.equal(r.versions.find((v) => v.valid_from === next).rules.hs_weights.goal, 40, "parte da versão anterior");
  r = await rpc("set_cs_rules", [A, next, JSON.stringify({ m1_commission: 1800 }), "Corrigindo o valor"]);
  assert.equal(r.versions.length, 2);
  await assert.rejects(rpc("delete_cs_rules", [A, prev, "x"]), /meses fechados/);
  r = await rpc("delete_cs_rules", [A, cur, "Voltar ao padrão neste mês"]);
  assert.equal(r.current.m1_commission, 3000);
  assert.deepEqual(await hs(), [`${prev}:55:ALERTA`, `${cur}:55:ALERTA`]);
  assert.deepEqual(r.log.map((l) => l.action), ["delete", "set", "set", "set"]);
  await as(admin);
  await assert.rejects(db.query(`delete from public.cs_rules_log`), /permission denied/);
});

const csPanel = (queries, groupBy = "none") => ({
  id: "p1", title: "Faturamento", x: 0, y: 0, w: 3, h: 3, spec: { viz: groupBy === "none" ? "stat" : "bar", groupBy, queries },
});
const csQuery = (metric, extra = {}) => ({ ref: "A", source: "cs_finance", metric, filters: [], ...extra });

let grid;
await check("painel com fonte de CS: conferido ao salvar", async () => {
  await as(gestor);
  grid = await rpc("save_dashboard", [A, null, "Financeiro CS", "", JSON.stringify([csPanel([csQuery("revenue")], "squad")]), "{}", null]);
  await assert.rejects(
    rpc("save_dashboard", [A, null, "Errado", "", JSON.stringify([csPanel([csQuery("lucro")])]), "{}", null]),
    /Métrica inválida/,
  );
  await assert.rejects(
    rpc("save_dashboard", [A, null, "Errado", "", JSON.stringify([csPanel([csQuery("revenue")], "cs_band")]), "{}", null]),
    /Agrupamento inválido para a fonte/,
  );
  await assert.rejects(
    rpc("save_dashboard", [A, null, "Misturado", "", JSON.stringify([csPanel([csQuery("revenue"),
      { ref: "B", source: "tasks", metric: "count", dateField: "created_at", filters: [] }])]), "{}", null]),
    /não mistura/,
  );
  await assert.rejects(
    rpc("save_dashboard", [A, null, "Filtro", "", JSON.stringify([csPanel([csQuery("revenue",
      { filters: [{ field: "person", values: [bia] }] })])]), "{}", null]),
    /Filtro inválido/,
  );
});

await check("colaborador não monta painel de CS; quem recebe o dashboard vê os dados", async () => {
  await as(bia);
  await assert.rejects(
    rpc("save_dashboard", [A, null, "Meu CS", "", JSON.stringify([csPanel([csQuery("revenue")])]), "{}", null]),
    /Sem permissão|só de administradores e gestores/,
  );
  await assert.rejects(rpc("cs_company_data", [A]), /só de administradores e gestores/);
  await assert.rejects(rpc("cs_dashboard_data", [grid.id, null, null]), /Sem acesso/);
  await as(admin);
  await rpc("set_dashboard_sharing", [grid.id, "none", null, [], [team], false, null]);
  await as(bia);
  const d = await rpc("cs_dashboard_data", [grid.id, null, null]);
  assert.equal(d.access, "viewer");
  assert.equal(d.clients.length, 1);
  await as(gestor);
  assert.equal((await rpc("cs_company_data", [A])).access, "editor");
});

console.log(`\n${passed} verificações das regras e das fontes de CS passaram.`);
