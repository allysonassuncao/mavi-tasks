// Data de entrada da tarefa (migration 20270109090000_task_entry_date):
// quem pode mudar (criador, responsável, participantes, supervisor da equipe
// do responsável, gestor, administrador), o motivo obrigatório, os limites,
// o registro que não se apaga com o histórico e as métricas dos Dashboards.
import assert from "node:assert/strict";
import { createTestDatabase } from "./database-fixture.mjs";

const db = await createTestDatabase();
const uid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const [A, admin, gil, bia, sara, caio, duda, eva] = [1, 10, 11, 12, 13, 14, 15, 16].map(uid);
await db.query(`insert into auth.users select unnest($1::uuid[])`, [
  [admin, gil, bia, sara, caio, duda, eva],
]);
await db.query(`insert into companies(id,name) values($1,'Empresa A')`, [A]);
await db.query(
  `insert into memberships(company_id,user_id,name,role) values
   ($1,$2,'Ana Admin','admin'),($1,$3,'Gil Gestor','manager'),($1,$4,'Bia Design','member'),
   ($1,$5,'Sara Supervisora','member'),($1,$6,'Caio Vendas','member'),($1,$7,'Duda Mencionada','member'),
   ($1,$8,'Eva Criadora','member')`,
  [A, admin, gil, bia, sara, caio, duda, eva],
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
async function rejects(fn, pattern) {
  await assert.rejects(fn, pattern);
  await db.exec("reset role");
}

await as(admin);
// Sara supervisiona Design, onde a Bia está; Caio supervisiona Vendas.
const design = await rpc("create_team", [A, "Design", [bia, sara], [sara]]);
const sales = await rpc("create_team", [A, "Vendas", [caio], [caio]]);
const client = await rpc("create_client", [A, "Cliente X", "", [design, sales]]);
const product = await rpc("create_product", [A, "Social"]);
const contract = await rpc("create_contract", [A, client, product, "Social X"]);

// Criada em 10/10 às 12h (Brasília), prazo 20/10, da Eva para a Bia.
async function task({ delivered = null } = {}) {
  const [row] = await sql(
    `insert into tasks(company_id,contract_id,team_id,title,creator_id,assignee_id,due_date,original_due_date,
      created_at,status,internal_approved_by,delivered_at,participant_ids)
     values($1,$2,$3,'Tarefa',$4,$5,'2026-10-20','2026-10-20','2026-10-10 12:00-03',$6,$7,$8,$9) returning id`,
    [A, contract, design, eva, bia, delivered ? "done" : "progress", delivered ? eva : null, delivered,
      [duda]],
  );
  return row.id;
}
const row = async (id) => (await sql("select * from tasks where id=$1", [id]))[0];
async function change(user, id, date, reason = "Cliente pediu por e-mail antes") {
  const t = await row(id);
  await as(user);
  return rpc("set_task_entry_date", [id, t.version, date, reason]);
}

await check("quem não tem relação com a tarefa não muda (nem o supervisor de outra equipe)", async () => {
  const id = await task();
  await rejects(() => change(caio, id, "2026-10-08"), /Sem permissão/);
  assert.equal((await row(id)).entered_at, null);
});

await check("o motivo é obrigatório", async () => {
  const id = await task();
  await rejects(() => change(eva, id, "2026-10-08", "   "), /motivo/);
  await rejects(() => change(eva, id, "2026-10-08", "ok"), /motivo/);
});

await check("o criador ajusta: guarda a hora da criação no novo dia, o registro e o histórico", async () => {
  const id = await task();
  const before = await row(id);
  const t = await change(eva, id, "2026-10-08");
  assert.equal(t.version, before.version + 1);
  const [{ local }] = await sql(
    "select to_char(entered_at at time zone 'America/Sao_Paulo','YYYY-MM-DD HH24:MI') as local from tasks where id=$1",
    [id],
  );
  assert.equal(local, "2026-10-08 12:00");
  const [x] = await sql("select * from task_entry_changes where task_id=$1", [id]);
  assert.equal(x.changed_by, eva);
  assert.equal(x.reason, "Cliente pediu por e-mail antes");
  assert.equal(x.old_date.toISOString().slice(0, 10), "2026-10-10");
  assert.equal(x.new_date.toISOString().slice(0, 10), "2026-10-08");
  const [e] = await sql("select * from task_events where task_id=$1 and action='entry_changed'", [id]);
  assert.equal(e.id, x.id);
  assert.equal(e.detail.reason, "Cliente pediu por e-mail antes");
  assert.equal(e.detail.old_entry, "2026-10-10");
  assert.equal(e.detail.new_entry, "2026-10-08");
});

await check("responsável, participante, supervisor da equipe do responsável, gestor e admin ajustam", async () => {
  const id = await task();
  const days = ["2026-10-09", "2026-10-07", "2026-10-06", "2026-10-05", "2026-10-04"];
  for (const [i, user] of [bia, duda, sara, gil, admin].entries()) await change(user, id, days[i]);
  const rows = await sql("select changed_by from task_entry_changes where task_id=$1 order by created_at, id", [id]);
  assert.equal(rows.length, 5);
  // Quem já foi responsável continua podendo (é participante).
  await sql("update tasks set assignee_id=$1 where id=$2", [caio, id]);
  await change(bia, id, "2026-10-03");
});

await check("não passa do prazo nem da entrega, nem mais de 1 ano antes, nem a mesma data", async () => {
  const id = await task();
  await rejects(() => change(eva, id, "2026-10-21"), /depois do prazo \(20\/10\/2026\)/);
  await rejects(() => change(eva, id, "2026-10-10"), /já está com essa data/);
  await rejects(() => change(eva, id, "2025-10-09"), /1 ano antes/);
  const done = await task({ delivered: "2026-10-12 15:00-03" });
  await rejects(() => change(eva, done, "2026-10-13"), /depois da entrega \(12\/10\/2026\)/);
  await change(eva, done, "2026-10-11");
});

await check("versão antiga é recusada", async () => {
  const id = await task();
  const t = await row(id);
  await sql("update tasks set version=version+1 where id=$1", [id]);
  await as(eva);
  await rejects(() => rpc("set_task_entry_date", [id, t.version, "2026-10-08", "Cliente pediu antes"]), /mudou/);
});

await check("voltar ao dia da criação limpa o ajuste, mas os registros ficam", async () => {
  const id = await task();
  await change(eva, id, "2026-10-08");
  await change(eva, id, "2026-10-10", "Engano no ajuste anterior");
  assert.equal((await row(id)).entered_at, null);
  assert.equal((await sql("select 1 from task_entry_changes where task_id=$1", [id])).length, 2);
});

await check("o motivo continua na tarefa depois que o histórico de 1 mês se apaga", async () => {
  const id = await task();
  await change(bia, id, "2026-10-08");
  await sql("delete from task_events where task_id=$1", [id]);
  await as(bia);
  const extras = await rpc("task_extras", [id]);
  const e = extras.events.find((x) => x.action === "entry_changed");
  assert.equal(e.actor_id, bia);
  assert.equal(e.detail.reason, "Cliente pediu por e-mail antes");
  // Sem apagar, não repete.
  await change(bia, id, "2026-10-07");
  const again = await rpc("task_extras", [id]);
  assert.equal(again.events.filter((x) => x.action === "entry_changed").length, 2);
  // Quem não vê a tarefa não lê os ajustes.
  await as(caio);
  assert.equal((await db.query("select * from task_entry_changes where task_id=$1", [id])).rows.length, 0);
  await db.exec("reset role");
});

await check("Dashboards: ajustes por pessoa, deslocamento, entrada e prazo médio contado da entrada", async () => {
  await sql("delete from task_entry_changes");
  await sql("update tasks set archived=true");
  const id = await task({ delivered: "2026-10-12 12:00-03" });
  await change(eva, id, "2026-10-08"); // 2 dias antes
  await change(gil, id, "2026-10-11", "Na verdade entrou depois"); // 3 dias depois
  const other = await task();
  await change(eva, other, "2026-10-09"); // 1 dia antes
  await as(admin);
  const today = new Date().toISOString().slice(0, 10);
  const byPerson = await rpc("dashboard_preview", [A, {
    viz: "table",
    groupBy: "person",
    queries: ["changes", "earlier", "later", "avg_days", "tasks"].map((metric, i) => ({
      ref: "ABCDE"[i], source: "entry_changes", metric, filters: [],
    })),
  }, today, today, {}]);
  const v = (ref, k) => Number(byPerson.series[ref].find((r) => r.k === k)?.v);
  assert.equal(v("A", eva), 2);
  assert.equal(v("A", gil), 1);
  assert.equal(v("B", eva), 2);
  assert.equal(v("C", gil), 1);
  assert.equal(v("D", eva), 1.5);
  assert.equal(v("E", eva), 2);
  // Por cliente e só as da Eva (filtro de criador da tarefa também vale).
  const byClient = await rpc("dashboard_preview", [A, {
    viz: "stat",
    groupBy: "none",
    queries: [{ ref: "A", source: "entry_changes", metric: "changes", filters: [{ field: "client", values: [client] }] }],
  }, today, today, {}]);
  assert.equal(Number(byClient.series.A[0].v), 3);
  // Tarefas: entrou em 11/10 às 12h, entregue em 12/10 às 12h = 1 dia.
  const tasks = await rpc("dashboard_preview", [A, {
    viz: "table",
    groupBy: "none",
    queries: [
      { ref: "A", source: "tasks", metric: "lead_time_days", dateField: "delivered_at", filters: [] },
      { ref: "B", source: "tasks", metric: "entry_adjusted", dateField: "entered_at", filters: [] },
      { ref: "C", source: "tasks", metric: "count", dateField: "entered_at", filters: [] },
    ],
  }, "2026-10-09", "2026-10-12", {}]);
  assert.equal(Number(tasks.series.A[0].v), 1);
  assert.equal(Number(tasks.series.B[0].v), 2);
  assert.equal(Number(tasks.series.C[0].v), 2);
});

console.log(`\n${passed} verificações da data de entrada passaram.`);
