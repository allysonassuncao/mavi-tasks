// Comparação nos Dashboards (migration 20270314090000_dashboard_compare):
// cada painel também calcula as consultas no período de comparação — no
// app, na prévia do editor e no link compartilhado —, com todos os grupos e
// o intervalo do período; o cache separa cada comparação.
import assert from "node:assert/strict";
import { applyMigration, createTestDatabase } from "./database-fixture.mjs";

const MIGRATION = "20270314090000";
const db = await createTestDatabase({ until: MIGRATION });
const uid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const [A, andre, kaue, maria] = [1, 10, 11, 12].map(uid);
await db.query(`insert into auth.users select unnest($1::uuid[])`, [[andre, kaue, maria]]);
await db.query(
  `insert into companies(id,name,timezone) values($1,'Empresa A','America/Sao_Paulo')`,
  [A],
);
await db.query(
  `insert into memberships(company_id,user_id,name,role) values
   ($1,$2,'André Gestor','admin'),($1,$3,'Kauê Design','member'),($1,$4,'Maria Design','member')`,
  [A, andre, kaue, maria],
);
async function as(user) {
  await db.exec("reset role");
  await db.query(`select set_config('request.jwt.claim.sub',$1,false)`, [user ?? ""]);
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
const client = await rpc("create_client", [A, "Cliente X", ""]);
const product = await rpc("create_product", [A, "Social"]);
const contract = await rpc("create_contract", [A, client, product, "Social X"]);
async function task(who, createdAt) {
  await sql(
    `insert into tasks(company_id,contract_id,title,creator_id,assignee_id,due_date,original_due_date,
      status,estimated_minutes,created_at)
     values($1,$2,'Arte',$3,$4,'2099-01-01','2099-01-01','progress',60,$5)`,
    [A, contract, andre, who, createdAt],
  );
}
// Outubro (o período): Kauê 3, Maria 1. Setembro (a comparação): Kauê 1,
// Maria 2, e o André 1 — que não aparece em outubro.
for (const d of ["2026-10-01", "2026-10-01", "2026-10-02"]) await task(kaue, `${d} 15:00+00`);
await task(maria, "2026-10-03 15:00+00");
await task(kaue, "2026-09-01 15:00+00");
await task(maria, "2026-09-02 15:00+00");
await task(maria, "2026-09-03 15:00+00");
await task(andre, "2026-09-03 16:00+00");

await db.exec("reset role");
await applyMigration(db, MIGRATION);

const period = ["2026-10-01", "2026-10-03"];
const sept = ["2026-09-01", "2026-09-03"];
const count = (extra = {}) => ({ ref: "A", source: "tasks", metric: "count", filters: [], ...extra });
const preview = (spec, cmp = [null, null]) =>
  as(andre).then(() => rpc("dashboard_preview", [A, spec, ...period, {}, ...cmp]));
const byKey = (rows) => Object.fromEntries(rows.map((r) => [r.k, Number(r.v)]));

await check("sem comparação, nada muda", async () => {
  const res = await preview({ viz: "stat", groupBy: "none", queries: [count()] });
  assert.equal(Number(res.series.A[0].v), 4);
  assert.equal(res.compare, undefined);
  assert.equal(res.compare_range, undefined);
});

await check("Número: o total do período de comparação", async () => {
  const res = await preview({ viz: "stat", groupBy: "none", queries: [count()] }, sept);
  assert.equal(Number(res.compare.A[0].v), 4);
  assert.deepEqual(res.compare_range, { from: sept[0], to: sept[1] });
});

await check("com comparação, o Número não calcula mais o período anterior", async () => {
  const spec = { viz: "stat", groupBy: "none", compare: true, queries: [count()] };
  assert.ok((await preview(spec)).previous.A, "sem comparação: período anterior");
  assert.deepEqual((await preview(spec, sept)).previous, {});
});

await check("por tempo: mesmo intervalo e os dias preenchidos, um a um", async () => {
  const res = await preview({ viz: "line", groupBy: "time", queries: [count()] }, sept);
  assert.equal(res.interval, "day");
  assert.deepEqual(res.series.A.map((r) => [r.k, Number(r.v)]), [
    ["2026-10-01", 2], ["2026-10-02", 1], ["2026-10-03", 1],
  ]);
  assert.deepEqual(res.compare.A.map((r) => [r.k, Number(r.v)]), [
    ["2026-09-01", 1], ["2026-09-02", 1], ["2026-09-03", 2],
  ]);
});

await check("por categoria: todos os grupos, sem top N nem Outros", async () => {
  const res = await preview(
    { viz: "table", groupBy: "person", limit: 1, queries: [count({ attribution: "assignee" })] },
    sept,
  );
  assert.ok(res.series.A.some((r) => r.k === "__other__"), "o período tem o top 1 + Outros");
  assert.deepEqual(byKey(res.compare.A), { [kaue]: 1, [maria]: 2, [andre]: 1 });
});

await check("período de comparação inválido é recusado", async () => {
  const spec = { viz: "stat", groupBy: "none", queries: [count()] };
  await assert.rejects(preview(spec, ["2026-09-03", "2026-09-01"]), /comparação inválido/);
  await assert.rejects(preview(spec, ["2026-09-03", null]), /comparação inválido/);
  await assert.rejects(
    preview({ viz: "line", groupBy: "time", queries: [count()] }, ["2024-01-01", "2026-01-01"]),
    /agrupe por semana ou mês/,
  );
});

// Um dashboard salvo, aberto no app e pelo link público.
await as(andre);
const dash = await rpc("save_dashboard", [
  A,
  null,
  "Entregas",
  "",
  [{ id: "total", title: "Tarefas", x: 0, y: 0, w: 4, h: 3,
     spec: { viz: "stat", groupBy: "none", queries: [count()] } }],
  { range: { preset: "month" }, compare: { preset: "previous" }, compareOpen: true },
  null,
]);
assert.deepEqual(dash.variables.compare, { preset: "previous" }, "a comparação é salva");
await rpc("set_dashboard_sharing", [dash.id, "public", null, [], [], false]);
const token = (await sql(`select share_token from dashboards where id = $1`, [dash.id]))[0].share_token;
const panel = (who, cmp, link = false) =>
  as(who).then(() =>
    rpc("dashboard_panel_data", [
      link ? null : dash.id, "total", ...period, null, link ? token : null, null, false, ...cmp,
    ]),
  );

await check("no app e no link compartilhado", async () => {
  const app = await panel(andre, sept);
  assert.equal(Number(app.series.A[0].v), 4);
  assert.equal(Number(app.compare.A[0].v), 4);
  const link = await panel(null, ["2026-09-01", "2026-09-02"], true);
  assert.equal(Number(link.compare.A[0].v), 2);
});

await check("o cache separa cada período de comparação", async () => {
  const one = await panel(null, ["2026-09-01", "2026-09-01"], true);
  const two = await panel(null, ["2026-09-03", "2026-09-03"], true);
  assert.equal(Number(one.compare.A[0].v), 1);
  assert.equal(Number(two.compare.A[0].v), 2);
  const none = await panel(null, [null, null], true);
  assert.equal(none.compare, undefined);
});

await check("chamadas antigas (sem comparação) seguem funcionando", async () => {
  await as(andre);
  const res = await rpc("dashboard_panel_data", [dash.id, "total", ...period, null, null, null, false]);
  assert.equal(Number(res.series.A[0].v), 4);
  const old = await rpc("dashboard_preview", [A, { viz: "stat", groupBy: "none", queries: [count()] }, ...period, {}]);
  assert.equal(Number(old.series.A[0].v), 4);
});

console.log(`\n${passed} verificações da comparação nos Dashboards passaram.`);
await db.close?.();
