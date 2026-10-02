// Registros por trás de cada painel (migration 20270224090000_dashboard_records):
// a lista sai da mesma consulta do painel e o valor recalculado sobre ela
// confere com o painel — no total, numa categoria clicada, em "Outros", por
// período, em médias e taxas. Pelo link, só quando o dashboard mostra.
import assert from "node:assert/strict";
import { applyMigration, createTestDatabase } from "./database-fixture.mjs";

const MIGRATION = "20270224090000";
const db = await createTestDatabase({ until: MIGRATION });
await applyMigration(db, MIGRATION);
const uid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const [A, andre, kaue, maria, eva] = [1, 10, 11, 12, 13].map(uid);
await db.query(`insert into auth.users select unnest($1::uuid[])`, [[andre, kaue, maria, eva]]);
await db.query(`insert into companies(id,name,timezone) values($1,'Empresa A','America/Sao_Paulo')`, [A]);
await db.query(
  `insert into memberships(company_id,user_id,name,role) values
   ($1,$2,'André Gestor','admin'),($1,$3,'Kauê Design','member'),
   ($1,$4,'Maria Design','member'),($1,$5,'Eva Atendimento','member')`,
  [A, andre, kaue, maria, eva],
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
const team = await rpc("create_team", [A, "Design", [kaue, maria]]);
const clientX = await rpc("create_client", [A, "Cliente X", ""]);
const clientY = await rpc("create_client", [A, "Cliente Y", ""]);
const product = await rpc("create_product", [A, "Social"]);
const contractX = await rpc("create_contract", [A, clientX, product, "Social X", team]);
const contractY = await rpc("create_contract", [A, clientY, product, "Social Y", team]);

async function task(title, who, { contract = contractX, due = "2099-01-01", created = "2026-09-10 12:00+00" } = {}) {
  const [row] = await sql(
    `insert into tasks(company_id,contract_id,title,creator_id,assignee_id,due_date,original_due_date,
      status,estimated_minutes,created_at)
     values($1,$2,$3,$4,$5,$6,$6,'progress',60,$7) returning id`,
    [A, contract, title, andre, who, due, created],
  );
  return row.id;
}
const deliver = (id, at) =>
  sql(
    `update tasks set status='done', internal_approved_by=$3, delivered_at=$2, version=version+1 where id=$1`,
    [id, at, andre],
  );
const k1 = await task("Arte 1", kaue, { due: "2026-09-15" });
const k2 = await task("Arte 2", kaue, { contract: contractY, created: "2026-09-20 12:00+00" });
const m1 = await task("Arte 3", maria, { due: "2026-09-15" });
const e1 = await task("Briefing", eva, { contract: contractY });
await deliver(k1, "2026-09-14 15:00+00"); // no prazo
await deliver(m1, "2026-09-18 15:00+00"); // atrasada
await sql(
  `insert into time_entries(company_id,task_id,user_id,started_at,ended_at,source) values
   ($1,$2,$3,'2026-09-12 12:00+00','2026-09-12 14:00+00','manual'),
   ($1,$4,$5,'2026-09-13 12:00+00','2026-09-13 13:30+00','manual')`,
  [A, k1, kaue, m1, maria],
);

const q = (ref, source, metric, extra = {}) => ({ ref, source, metric, filters: [], ...extra });
const panel = (id, spec) => ({ id, title: id, x: 0, y: 0, w: 6, h: 4, spec });
const panels = [
  panel("total", { viz: "stat", groupBy: "none", queries: [q("A", "tasks", "count")] }),
  panel("person", { viz: "bar", groupBy: "person", limit: 1, queries: [q("A", "tasks", "count")] }),
  panel("hours", { viz: "bar", groupBy: "person", queries: [q("A", "hours", "hours")] }),
  panel("ontime", {
    viz: "stat",
    groupBy: "none",
    queries: [q("A", "tasks", "on_time_rate", { dateField: "delivered_at" })],
  }),
  panel("time", { viz: "bar", groupBy: "time", interval: "month", queries: [q("A", "tasks", "count")] }),
  panel("formula", {
    viz: "stat",
    groupBy: "none",
    formula: { expr: "A / B", label: "Horas por tarefa" },
    queries: [q("A", "hours", "hours"), q("B", "hours", "tasks")],
  }),
];
await as(andre);
const dash = await rpc("save_dashboard", [A, null, "Conferência", "", panels, { range: { preset: "30d" } }, null]);
const range = ["2026-09-01", "2026-09-30"];
const records = (panelId, ref, { keys = null, exclude = null, token = null } = {}) =>
  rpc("dashboard_panel_records", [token ? null : dash.id, panelId, ref, ...range, null, keys, exclude, token, null, true]);
const data = (panelId) =>
  rpc("dashboard_panel_data", [dash.id, panelId, ...range, null, null, null, true]);
const ids = (r) => r.rows.map((x) => x.id).sort();

await check("total: um registro por tarefa, e o valor confere com o painel", async () => {
  await as(andre);
  const r = await records("total", "A");
  const panelValue = Number((await data("total")).series.A[0].v);
  assert.equal(r.kind, "task");
  assert.equal(r.total, 4);
  assert.equal(Number(r.value), panelValue);
  assert.deepEqual(ids(r), [k1, k2, m1, e1].sort());
  const arte1 = r.rows.find((x) => x.id === k1);
  assert.equal(arte1.title, "Arte 1");
  assert.equal(arte1.client, "Cliente X");
  assert.equal(arte1.assignee, "Kauê Design");
  assert.equal(r.can_open, true);
});

await check("barra clicada: só os registros da categoria, com o valor da barra", async () => {
  const r = await records("person", "A", { keys: [kaue] });
  const bar = (await data("person")).series.A.find((x) => x.k === kaue);
  assert.equal(Number(r.value), Number(bar.v));
  assert.deepEqual(ids(r), [k1, k2].sort());
  assert.ok(r.rows.every((x) => x.k === kaue && x.l === "Kauê Design"));
});

await check("Outros: todas as categorias menos as mostradas", async () => {
  const shown = (await data("person")).series.A.filter((x) => x.k !== "__other__").map((x) => x.k);
  assert.deepEqual(shown, [kaue]);
  const r = await records("person", "A", { exclude: shown });
  const other = (await data("person")).series.A.find((x) => x.k === "__other__");
  assert.equal(Number(r.value), Number(other.v));
  assert.deepEqual(ids(r), [m1, e1].sort());
});

await check("horas: um registro por lançamento, com a duração de cada um", async () => {
  const r = await records("hours", "A", { keys: [kaue] });
  assert.equal(r.kind, "entry");
  assert.equal(r.total, 1);
  assert.equal(Number(r.rows[0].v), 2);
  assert.equal(r.rows[0].title, "Arte 1");
  assert.equal(r.rows[0].person, "Kauê Design");
  const all = await records("hours", "A");
  assert.equal(Number(all.value), 3.5);
});

await check("taxa: a tarefa atrasada entra com 0, a no prazo com 100", async () => {
  const r = await records("ontime", "A");
  assert.equal(Number(r.value), 50);
  const v = Object.fromEntries(r.rows.map((x) => [x.id, Number(x.v)]));
  assert.deepEqual(v, { [k1]: 100, [m1]: 0 });
});

await check("por período: o mês clicado", async () => {
  const series = (await data("time")).series.A;
  const sept = series.find((x) => x.k === "2026-09-01");
  const r = await records("time", "A", { keys: ["2026-09-01"] });
  assert.equal(Number(r.value), Number(sept.v));
  assert.equal(r.total, 4);
});

await check("fórmula: cada consulta tem os seus registros", async () => {
  const a = await records("formula", "A");
  const b = await records("formula", "B");
  assert.equal(a.kind, "entry");
  assert.equal(b.kind, "task");
  assert.equal(Number(b.value), 2);
  assert.deepEqual(ids(b), [k1, m1].sort());
});

await check("o modo registros não vaza pela consulta normal", async () => {
  await as(andre);
  const spec = { viz: "stat", groupBy: "none", queries: [{ ...q("A", "tasks", "count"), __rows: true }] };
  const res = await rpc("dashboard_preview", [A, spec, ...range, {}]);
  assert.equal(Number(res.series.A[0].v), 4);
});

await check("link público: sem a opção ligada, nada de registros", async () => {
  await as(andre);
  const shared = await rpc("set_dashboard_sharing", [dash.id, "public", null, [], [], false, null]);
  assert.equal(shared.link_records, false);
  await as(null);
  const r = await records("total", "A", { token: shared.share_token });
  assert.match(r.error, /não estão disponíveis/);
  const page = await rpc("dashboard_shared", [shared.share_token, null]);
  assert.equal(page.records, false);
});

await check("link público com a opção ligada: lista sem abrir as tarefas", async () => {
  await as(andre);
  const shared = await rpc("set_dashboard_sharing", [dash.id, "public", null, [], [], false, true]);
  assert.equal(shared.link_records, true);
  await as(null);
  const r = await records("total", "A", { token: shared.share_token });
  assert.equal(r.total, 4);
  assert.equal(r.can_open, false);
  assert.equal((await rpc("dashboard_shared", [shared.share_token, null])).records, true);
  // Nulo mantém a opção como está.
  await as(andre);
  const again = await rpc("set_dashboard_sharing", [dash.id, "public", null, [], [], false, null]);
  assert.equal(again.link_records, true);
});

await check("quem não tem acesso não vê os registros", async () => {
  await as(eva);
  await assert.rejects(() => records("total", "A"), /Sem acesso/);
});

await check("leitor do dashboard vê a lista inteira", async () => {
  await as(andre);
  await rpc("set_dashboard_sharing", [dash.id, "none", null, [eva], [], false, null]);
  await as(eva);
  const r = await records("total", "A");
  assert.equal(r.total, 4);
  assert.equal(r.can_open, true);
});

console.log(`\n${passed} verificações passaram.`);
