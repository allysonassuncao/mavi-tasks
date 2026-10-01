// Pessoa nos Dashboards (migration 20270131090000_dashboard_person_roles):
// cada tarefa conta para todos que a executaram (não para o validador que
// está com ela agora), o atraso para quem estava com ela no vencimento, as
// horas estimadas divididas entre quem executou, a escolha "responsável
// atual" no painel, as vezes em Devolvida para quem devolveu e o Relatório
// por pessoa com as horas registradas e a carga separada por papel.
import assert from "node:assert/strict";
import { applyMigration, createTestDatabase } from "./database-fixture.mjs";

const MIGRATION = "20270131090000";
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
   ($1,$2,'André Validador','admin'),($1,$3,'Kauê Design','member'),
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
const team = await rpc("create_team", [A, "Design", [kaue, maria, andre]]);
const client = await rpc("create_client", [A, "Cliente X", ""]);
const product = await rpc("create_product", [A, "Social"]);
const contract = await rpc("create_contract", [A, client, product, "Social X", team]);

async function task(title, who, { due = "2099-01-01", minutes = 60 } = {}) {
  const [row] = await sql(
    `insert into tasks(company_id,contract_id,team_id,title,creator_id,assignee_id,due_date,original_due_date,
      status,estimated_minutes)
     values($1,$2,$3,$4,$5,$6,$7,$7,'progress',$8) returning id`,
    [A, contract, team, title, eva, who, due, minutes],
  );
  return row.id;
}
const move = (id, status, who) =>
  sql(
    `update tasks set status=$2, assignee_id=$3, version=version+1,
      delivered_at = case when $2 = 'done' then now() else delivered_at end where id=$1`,
    [id, status, who],
  );

// Before the migration: Kauê sends to André; Maria does it, is asked for a
// correction and sends it again; Kauê starts one that Maria finishes.
const kaueTask = await task("Arte do Kauê", kaue, { minutes: 120 });
await move(kaueTask, "review", andre);
const mariaTask = await task("Arte da Maria", maria, { minutes: 180 });
await move(mariaTask, "review", andre);
await move(mariaTask, "correction", maria);
await move(mariaTask, "review", andre);
const shared = await task("Arte dividida", kaue, { minutes: 240 });
await move(shared, "progress", maria);
await move(shared, "review", andre);

await db.exec("reset role");
await applyMigration(db, MIGRATION);

const executors = async (id) =>
  (await sql("select executor_ids from tasks where id=$1", [id]))[0].executor_ids;

await check("a migração preenche quem executou com o histórico", async () => {
  assert.deepEqual(await executors(kaueTask), [kaue]);
  assert.deepEqual(await executors(mariaTask), [maria]);
  assert.deepEqual(await executors(shared), [kaue, maria], "na ordem em que entraram");
});

await check("o trigger soma quem executa depois, sem repetir", async () => {
  await move(kaueTask, "rejected", kaue);
  await move(kaueTask, "review", andre);
  assert.deepEqual(await executors(kaueTask), [kaue]);
  // O validador que pega a correção para si também executou.
  const t = await task("Corrigida pelo André", kaue);
  await move(t, "review", andre);
  await move(t, "correction", andre);
  await move(t, "review", andre);
  assert.deepEqual(await executors(t), [kaue, andre]);
  await sql("update tasks set archived = true where id=$1", [t]);
});

const range = ["2020-01-01", "2030-01-01"];
const q = (ref, source, metric, extra = {}) => ({
  ref,
  source,
  metric,
  filters: [],
  ...extra,
});
const preview = (spec, vars = {}) =>
  as(andre).then(() => rpc("dashboard_preview", [A, spec, ...range, vars]));
const byKey = (rows) =>
  Object.fromEntries(rows.map((r) => [r.k, Math.round(Number(r.v) * 100) / 100]));
const table = (queries, extra = {}) => ({
  viz: "table",
  groupBy: "person",
  queries,
  ...extra,
});

await check("por pessoa: a tarefa conta para quem executou, não para o validador", async () => {
  const res = await preview(table([q("A", "tasks", "count")]));
  assert.deepEqual(byKey(res.series.A), { [kaue]: 2, [maria]: 2 });
});

await check("horas estimadas divididas entre quem executou", async () => {
  const res = await preview(table([q("A", "tasks", "estimated_hours")]));
  // Kauê: 2 h + metade de 4 h; Maria: 3 h + metade de 4 h.
  assert.deepEqual(byKey(res.series.A), { [kaue]: 4, [maria]: 5 });
});

await check("o total conta cada tarefa uma vez, mesmo filtrando pelas duas pessoas", async () => {
  const res = await preview(
    { viz: "stat", groupBy: "none", queries: [q("A", "tasks", "count"), q("B", "tasks", "estimated_hours")] },
    { filters: { people: [kaue, maria] } },
  );
  assert.equal(Number(res.series.A[0].v), 3);
  assert.equal(Number(res.series.B[0].v), 9);
  const kaueOnly = await preview(
    { viz: "stat", groupBy: "none", queries: [q("A", "tasks", "count")] },
    { filters: { people: [kaue] } },
  );
  assert.equal(Number(kaueOnly.series.A[0].v), 2, "as tarefas que o Kauê executou");
});

await check("no painel: responsável atual, como era", async () => {
  const res = await preview(
    table([q("A", "tasks", "count", { attribution: "assignee" }), q("B", "tasks", "estimated_hours", { attribution: "assignee" })]),
  );
  assert.deepEqual(byKey(res.series.A), { [andre]: 3 });
  assert.deepEqual(byKey(res.series.B), { [andre]: 9 });
});

await check("Quem executou: todos que executaram", async () => {
  const res = await preview(table([q("A", "tasks", "count")], { groupBy: "executor" }));
  assert.deepEqual(byKey(res.series.A), { [kaue]: 2, [maria]: 2 });
  assert.equal(res.series.A.find((r) => r.k === kaue).l, "Kauê Design");
});

await check("atribuição fora da lista é recusada", async () => {
  await assert.rejects(
    () => preview(table([q("A", "tasks", "count", { attribution: "boss" })])),
    /Atribuição inválida/,
  );
  await db.exec("reset role");
});

// Atrasos. Sent to validation before the due date and still there after:
// late for André. Held by Kauê past the due date, then sent: late for Kauê.
const due = "2026-09-10";
const dueEnd = "2026-09-11 03:00:00+00"; // fim do dia 10 em São Paulo
const reviewLate = await task("Atrasou na validação", kaue, { due });
await move(reviewLate, "review", andre);
const kaueLate = await task("Atrasou com o Kauê", kaue, { due });
await move(kaueLate, "review", andre);
await sql(
  `update task_status_periods set started_at = $2::timestamptz - interval '3 days',
     ended_at = case when ended_at is null then null else $2::timestamptz - interval '1 day' end
   where task_id = $1 and status = 'progress'`,
  [reviewLate, dueEnd],
);
await sql(
  `update task_status_periods set started_at = $2::timestamptz - interval '1 day' where task_id = $1 and status = 'review'`,
  [reviewLate, dueEnd],
);
await sql(
  `update task_status_periods set started_at = $2::timestamptz - interval '3 days',
     ended_at = $2::timestamptz + interval '1 day' where task_id = $1 and status = 'progress'`,
  [kaueLate, dueEnd],
);
await sql(
  `update task_status_periods set started_at = $2::timestamptz + interval '1 day' where task_id = $1 and status = 'review'`,
  [kaueLate, dueEnd],
);

await check("atrasada conta para quem estava com ela no vencimento", async () => {
  const res = await preview(table([q("A", "tasks", "late")]));
  assert.deepEqual(byKey(res.series.A), { [andre]: 1, [kaue]: 1 });
  const total = await preview({ viz: "stat", groupBy: "none", queries: [q("A", "tasks", "late")] });
  assert.equal(Number(total.series.A[0].v), 2);
  const assignee = await preview(table([q("A", "tasks", "late", { attribution: "assignee" })]));
  assert.deepEqual(byKey(assignee.series.A), { [andre]: 2 });
});

await check("prazo apertado conta para quem criou", async () => {
  await sql("update tasks set due_tight_reason = 'Cliente pediu' where id=$1", [kaueTask]);
  const res = await preview(table([q("A", "tasks", "tight_due")]));
  assert.deepEqual(byKey(res.series.A), { [eva]: 1 });
});

await check("Status das tarefas: tempo com quem segurou, devolução com quem devolveu", async () => {
  const returned = await task("Faltou o briefing", maria);
  await move(returned, "returned", eva);
  const spec = (metric) =>
    table([
      q("A", "status_history", metric, {
        filters: [{ field: "status", op: "in", values: ["returned"] }],
      }),
    ]);
  assert.deepEqual(byKey((await preview(spec("entries"))).series.A), { [maria]: 1 });
  const hours = byKey((await preview(spec("hours"))).series.A);
  assert.deepEqual(Object.keys(hours), [eva], "o tempo parado é de quem precisa responder");
  // Tempo validando é do validador.
  const review = await preview(
    table([q("A", "status_history", "hours", { filters: [{ field: "status", op: "in", values: ["review"] }] })]),
  );
  assert.deepEqual(Object.keys(byKey(review.series.A)), [andre]);
  await sql("update tasks set archived = true where id=$1", [returned]);
});

await check("Relatórios: horas registradas de quem registrou e carga por papel", async () => {
  const open = await task("Em andamento com a Maria", maria, { minutes: 90 });
  await sql(
    `insert into time_entries(company_id,task_id,user_id,started_at,ended_at,source) values
     ($1,$2,$3,'2026-09-02 12:00+00','2026-09-02 15:00+00','manual'),
     ($1,$4,$5,'2026-09-03 12:00+00','2026-09-03 13:30+00','manual')`,
    [A, kaueTask, kaue, open, maria],
  );
  await as(andre);
  const s = await rpc("report_summary", [A, "2026-09-01 03:00+00", "2026-10-01 03:00+00"]);
  const person = Object.fromEntries(s.by_person.map((p) => [p.id, p]));
  assert.equal(Number(person[kaue].minutes), 180);
  assert.equal(Number(person[maria].minutes), 90);
  assert.equal(Number(person[andre].minutes), 0, "o validador não registrou horas");
  assert.equal(person[andre].tasks, 0, "nada em execução com ele");
  assert.equal(Number(person[andre].estimated), 0);
  assert.equal(person[andre].reviewing, 5);
  assert.equal(person[maria].tasks, 1);
  assert.equal(Number(person[maria].estimated), 90);
});

console.log(`\n${passed} verificações passaram.`);
