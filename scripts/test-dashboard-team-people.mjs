// Equipe nos Dashboards (migration 20270209090000_dashboard_team_people):
// nas tarefas e nas horas, a equipe é as pessoas dela. As tarefas entregues
// direto a alguém da equipe (sem tasks.team_id) entram no filtro e no
// agrupamento, do mesmo jeito que o filtro Pessoa as contaria.
import assert from "node:assert/strict";
import { applyMigration, createTestDatabase } from "./database-fixture.mjs";

const MIGRATION = "20270209090000";
const db = await createTestDatabase({ until: MIGRATION });
const uid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const [A, andre, kaue, maria, eva] = [1, 10, 11, 12, 13].map(uid);
await db.query(`insert into auth.users select unnest($1::uuid[])`, [
  [andre, kaue, maria, eva],
]);
await db.query(
  `insert into companies(id,name,timezone) values($1,'Empresa A','America/Sao_Paulo')`,
  [A],
);
await db.query(
  `insert into memberships(company_id,user_id,name,role) values
   ($1,$2,'André Gestor','admin'),($1,$3,'Kauê Design','member'),
   ($1,$4,'Maria Design','member'),($1,$5,'Eva Atendimento','member')`,
  [A, andre, kaue, maria, eva],
);
async function as(user) {
  await db.exec("reset role");
  await db.query(`select set_config('request.jwt.claim.sub',$1,false)`, [
    user ?? "",
  ]);
  await db.exec(`set role ${user ? "authenticated" : "anon"}`);
}
async function rpc(name, args) {
  return (
    await db.query(
      `select to_jsonb(public.${name}(${args.map((_, i) => `$${i + 1}`).join(",")})) as result`,
      args,
    )
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

await as(andre);
const criativo = await rpc("create_team", [A, "Criativo", [kaue, maria]]);
const atendimento = await rpc("create_team", [A, "Atendimento", [eva]]);
const client = await rpc("create_client", [A, "Cliente X", ""]);
const product = await rpc("create_product", [A, "Social"]);
const contract = await rpc("create_contract", [A, client, product, "Social X"]);

async function task(title, who, team = null) {
  const [row] = await sql(
    `insert into tasks(company_id,contract_id,team_id,title,creator_id,assignee_id,due_date,original_due_date,
      status,estimated_minutes)
     values($1,$2,$3,$4,$5,$6,'2099-01-01','2099-01-01','progress',60) returning id`,
    [A, contract, team, title, andre, who],
  );
  return row.id;
}
// Entregues direto à pessoa (sem equipe na tarefa), como quase todas.
const kaueTasks = [await task("Arte 1", kaue), await task("Arte 2", kaue)];
const mariaTask = await task("Arte 3", maria);
const evaTask = await task("Briefing", eva);
// Enviada para o Criativo, mas está com a Eva.
const sentToTeam = await task("Enviada à equipe", eva, criativo);
await sql(
  `insert into time_entries(company_id,task_id,user_id,started_at,ended_at,source) values
   ($1,$2,$3,'2026-09-02 12:00+00','2026-09-02 14:00+00','manual'),
   ($1,$4,$5,'2026-09-03 12:00+00','2026-09-03 13:00+00','manual')`,
  [A, kaueTasks[0], kaue, evaTask, eva],
);

await db.exec("reset role");
await applyMigration(db, MIGRATION);

const range = ["2020-01-01", "2030-01-01"];
const q = (ref, source, metric, extra = {}) => ({ ref, source, metric, filters: [], ...extra });
const teamIs = (op, ...teams) => [{ field: "team", op, values: teams }];
const preview = (spec, vars = {}) =>
  as(andre).then(() => rpc("dashboard_preview", [A, spec, ...range, vars]));
const total = async (query, vars) =>
  Number((await preview({ viz: "stat", groupBy: "none", queries: [query] }, vars)).series.A[0].v);
const byKey = (rows) =>
  Object.fromEntries(rows.map((r) => [r.k, Math.round(Number(r.v) * 100) / 100]));

await check("filtro Equipe conta as tarefas das pessoas da equipe", async () => {
  assert.equal(await total(q("A", "tasks", "count", { filters: teamIs("in", criativo) })), 3);
  assert.equal(await total(q("A", "tasks", "count", { filters: teamIs("not_in", criativo) })), 2);
  assert.equal(await total(q("A", "tasks", "count", { filters: teamIs("in", atendimento) })), 2);
});

await check("o filtro de Equipe do dashboard também", async () => {
  assert.equal(await total(q("A", "tasks", "count"), { filters: { teams: [criativo] } }), 3);
});

await check("segue a escolha de para quem a tarefa conta", async () => {
  // A Maria executou a tarefa da Eva (que a recebeu de volta para validar).
  await sql(`update tasks set status='progress', assignee_id=$2, version=version+1 where id=$1`, [evaTask, maria]);
  await sql(`update tasks set status='review', assignee_id=$2, version=version+1 where id=$1`, [evaTask, eva]);
  const criativoTasks = (attribution) =>
    total(q("A", "tasks", "count", { attribution, filters: teamIs("in", criativo) }));
  assert.equal(await criativoTasks("roles"), 4, "quem executou: a Maria");
  assert.equal(await criativoTasks("assignee"), 3, "está com a Eva agora");
});

await check("agrupar por Equipe usa as pessoas, uma vez por equipe", async () => {
  // Kauê e Maria executam a mesma tarefa: uma vez no Criativo. A da Eva
  // que a Maria executou conta nas duas equipes.
  await sql(`update tasks set status='progress', assignee_id=$2, version=version+1 where id=$1`, [mariaTask, kaue]);
  const res = await preview({ viz: "table", groupBy: "team", queries: [q("A", "tasks", "count")] });
  assert.deepEqual(byKey(res.series.A), { [criativo]: 4, [atendimento]: 2 });
  const names = Object.fromEntries(res.series.A.map((r) => [r.k, r.l]));
  assert.equal(names[criativo], "Criativo");
});

await check("horas: de quem registrou, pela equipe dela", async () => {
  assert.equal(await total(q("A", "hours", "hours", { filters: teamIs("in", criativo) })), 2);
  assert.equal(await total(q("A", "hours", "hours", { filters: teamIs("in", atendimento) })), 1);
  const res = await preview({ viz: "table", groupBy: "team", queries: [q("A", "hours", "hours")] });
  assert.deepEqual(byKey(res.series.A), { [criativo]: 2, [atendimento]: 1 });
});

await check("quem não está em equipe nenhuma fica em Sem equipe", async () => {
  await sql(`update tasks set assignee_id=$2, version=version+1 where id=$1`, [sentToTeam, andre]);
  const res = await preview({
    viz: "table",
    groupBy: "team",
    queries: [q("A", "tasks", "count", { attribution: "assignee" })],
  });
  const empty = res.series.A.find((r) => r.k === null);
  assert.equal(Number(empty?.v), 1);
});

console.log(`\n${passed} verificações passaram.`);
