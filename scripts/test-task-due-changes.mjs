// Prazo com motivo (migration 20270110090000_task_due_changes): quem muda o
// prazo direto na tarefa (criador, responsável, participantes, supervisor da
// equipe do responsável, gestor, administrador), o motivo obrigatório em todo
// caminho (tarefa, Editar, em massa, replanejamento), o registro que não se
// apaga com o histórico, o desfazer do lote e as métricas dos Dashboards.
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
const day = (d) => (d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10));

await as(admin);
// Sara supervisiona Design, onde a Bia está; Caio supervisiona Vendas.
const design = await rpc("create_team", [A, "Design", [bia, sara], [sara]]);
const sales = await rpc("create_team", [A, "Vendas", [caio], [caio]]);
const client = await rpc("create_client", [A, "Cliente X", "", [design, sales]]);
const product = await rpc("create_product", [A, "Social"]);
const contract = await rpc("create_contract", [A, client, product, "Social X"]);

// Da Eva para a Bia, na equipe Design, em validação e já aprovada por dentro.
async function task({ due = "2026-10-20", status = "review", owner = null } = {}) {
  const [row] = await sql(
    `insert into tasks(company_id,contract_id,team_id,title,creator_id,assignee_id,due_date,original_due_date,
      status,internal_approved_by,participant_ids)
     values($1,$2,$3,'Tarefa',$4,$5,$6,$6,$7,$8,$9) returning id`,
    [A, contract, owner ? sales : design, owner ?? eva, owner ?? bia, due, status, status === "review" ? eva : null,
      owner ? [] : [duda]],
  );
  return row.id;
}
const row = async (id) => (await sql("select * from tasks where id=$1", [id]))[0];
async function change(user, id, due, reason = "Cliente pediu mais tempo") {
  const t = await row(id);
  await as(user);
  return rpc("set_task_due", [id, t.version, due, reason]);
}

await check("sem relação com a tarefa não muda o prazo (nem o supervisor de outra equipe)", async () => {
  const id = await task();
  await rejects(() => change(caio, id, "2026-10-22"), /Sem permissão/);
  assert.equal(day((await row(id)).due_date), "2026-10-20");
});

await check("o motivo é obrigatório", async () => {
  const id = await task();
  await rejects(() => change(eva, id, "2026-10-22", "  "), /motivo/);
  await rejects(() => change(eva, id, "2026-10-22", "ok"), /motivo/);
});

await check("na tarefa: só a data muda (aprovação e status ficam), o registro e o histórico", async () => {
  const id = await task();
  const before = await row(id);
  const t = await change(eva, id, "2026-10-23");
  assert.equal(t.due_date, "2026-10-23");
  assert.equal(t.version, before.version + 1);
  assert.equal(t.status, "review");
  assert.equal(t.internal_approved_by, eva);
  assert.equal(t.due_manual, true);
  assert.equal(day(t.original_due_date), "2026-10-20");
  const [x] = await sql("select * from task_due_changes where task_id=$1", [id]);
  assert.equal(x.changed_by, eva);
  assert.equal(x.source, "task");
  assert.equal(x.reason, "Cliente pediu mais tempo");
  assert.equal(day(x.old_due), "2026-10-20");
  assert.equal(day(x.new_due), "2026-10-23");
  const [e] = await sql("select * from task_events where task_id=$1 and action='due_changed'", [id]);
  assert.equal(e.id, x.id);
  assert.equal(e.detail.reason, "Cliente pediu mais tempo");
  assert.equal(e.detail.old_due, "2026-10-20");
});

await check("responsável, participante, supervisor da equipe do responsável, gestor e admin mudam", async () => {
  const id = await task();
  const dates = ["2026-10-21", "2026-10-22", "2026-10-23", "2026-10-24", "2026-10-25"];
  for (const [i, user] of [bia, duda, sara, gil, admin].entries()) await change(user, id, dates[i]);
  assert.equal((await sql("select 1 from task_due_changes where task_id=$1", [id])).length, 5);
  // Quem já foi responsável continua podendo (é participante).
  await sql("update tasks set assignee_id=$1 where id=$2", [caio, id]);
  await change(bia, id, "2026-10-26");
});

await check("mesma data, antes do início e versão antiga são recusados", async () => {
  const id = await task();
  await rejects(() => change(eva, id, "2026-10-20"), /já tem esse prazo/);
  await sql("update tasks set start_date='2026-10-15' where id=$1", [id]);
  await rejects(() => change(eva, id, "2026-10-14"), /início planejado \(15\/10\/2026\)/);
  const t = await row(id);
  await sql("update tasks set version=version+1 where id=$1", [id]);
  await as(eva);
  await rejects(() => rpc("set_task_due", [id, t.version, "2026-10-22", "Cliente pediu"]), /mudou/);
});

await check("Editar tarefa: mudar o prazo pede o motivo; sem mudar, não", async () => {
  const id = await task({ status: "progress" });
  const edit = async (due, reason) => {
    const t = await row(id);
    await as(eva);
    return rpc("update_task", [id, t.version, "Tarefa", "", due, 0, "normal", null, null, reason, null, null, null, null]);
  };
  await rejects(() => edit("2026-10-27", null), /motivo da mudança de prazo/);
  await edit("2026-10-20", null);
  await edit("2026-10-27", "Escopo aumentou");
  const [x] = await sql("select * from task_due_changes where task_id=$1", [id]);
  assert.equal(x.source, "edit");
  assert.equal(x.reason, "Escopo aumentou");
});

await check("em massa: pede o motivo, vale para quem pode mudar o prazo e o desfazer tira o registro", async () => {
  const mine = await task({ status: "progress" });
  // Do Caio, em Vendas: a Bia não tem relação com ela.
  const other = await task({ status: "progress", owner: caio });
  await as(bia);
  await rejects(() => rpc("bulk_update_tasks", [A, [mine], { kind: "shift", value: 2 }, false]), /motivo/);
  await as(bia);
  const res = await rpc("bulk_update_tasks", [A, [mine, other], { kind: "shift", value: 2, reason: "Feriado local" }, false]);
  assert.equal(res.applied, 1);
  assert.match(res.results.find((r) => r.id === other).reason, /Sem acesso|Sem permissão|não encontrada/i);
  const [x] = await sql("select * from task_due_changes where task_id=$1", [mine]);
  assert.equal(x.source, "bulk");
  assert.equal(x.reason, "Feriado local");
  assert.equal(x.operation_id, res.operation);
  await as(bia);
  await rpc("undo_task_bulk", [res.operation]);
  assert.equal((await sql("select 1 from task_due_changes where task_id=$1", [mine])).length, 0);
  // A prévia não registra nada.
  await as(bia);
  await rpc("bulk_update_tasks", [A, [mine], { kind: "shift", value: 1, reason: "Só olhando" }, true]);
  assert.equal((await sql("select 1 from task_due_changes where task_id=$1", [mine])).length, 0);
});

await check("replanejamento: adiar pede o motivo", async () => {
  const id = await task({ status: "progress" });
  await as(admin);
  await rejects(() => rpc("apply_replan", [A, [{ task: id, due: "2026-10-28" }], null]), /motivo/);
  await as(admin);
  const res = await rpc("apply_replan", [A, [{ task: id, due: "2026-10-28" }], "Bia de férias"]);
  assert.equal(res.applied, 1);
  const [x] = await sql("select * from task_due_changes where task_id=$1", [id]);
  assert.equal(x.source, "replan");
  assert.equal(x.reason, "Bia de férias");
});

await check("o motivo continua na tarefa depois que o histórico de 1 mês se apaga", async () => {
  const id = await task();
  await change(bia, id, "2026-10-22");
  await sql("delete from task_events where task_id=$1", [id]);
  await as(bia);
  const extras = await rpc("task_extras", [id]);
  const e = extras.events.find((x) => x.action === "due_changed");
  assert.equal(e.actor_id, bia);
  assert.equal(e.detail.reason, "Cliente pediu mais tempo");
  await change(bia, id, "2026-10-23");
  const again = await rpc("task_extras", [id]);
  assert.equal(again.events.filter((x) => x.action === "due_changed").length, 2);
  // Quem não vê a tarefa não lê as mudanças.
  await as(caio);
  assert.equal((await db.query("select * from task_due_changes where task_id=$1", [id])).rows.length, 0);
  await db.exec("reset role");
});

await check("a data de entrada saiu", async () => {
  const cols = await sql("select 1 from information_schema.columns where table_name='tasks' and column_name='entered_at'");
  assert.equal(cols.length, 0);
  assert.equal((await sql("select to_regclass('public.task_entry_changes') as t"))[0].t, null);
});

await check("Dashboards: mudanças por pessoa, adiadas × antecipadas e dias movidos", async () => {
  await sql("delete from task_due_changes");
  await sql("update tasks set archived=true");
  const one = await task();
  await change(eva, one, "2026-10-23"); // +3
  await change(gil, one, "2026-10-21"); // -2
  const two = await task();
  await change(eva, two, "2026-10-21"); // +1
  await as(admin);
  const today = new Date().toISOString().slice(0, 10);
  const byPerson = await rpc("dashboard_preview", [A, {
    viz: "table",
    groupBy: "person",
    queries: ["changes", "later", "earlier", "avg_days", "tasks"].map((metric, i) => ({
      ref: "ABCDE"[i], source: "due_changes", metric, filters: [],
    })),
  }, today, today, {}]);
  const v = (ref, k) => Number(byPerson.series[ref].find((r) => r.k === k)?.v);
  assert.equal(v("A", eva), 2);
  assert.equal(v("A", gil), 1);
  assert.equal(v("B", eva), 2);
  assert.equal(v("C", gil), 1);
  assert.equal(v("D", eva), 2);
  assert.equal(v("E", eva), 2);
  const byClient = await rpc("dashboard_preview", [A, {
    viz: "stat",
    groupBy: "none",
    queries: [{ ref: "A", source: "due_changes", metric: "changes", filters: [{ field: "client", values: [client] }] }],
  }, today, today, {}]);
  assert.equal(Number(byClient.series.A[0].v), 3);
  // A fonte antiga não existe mais.
  await as(admin);
  await rejects(() => rpc("dashboard_preview", [A, {
    viz: "stat", groupBy: "none", queries: [{ ref: "A", source: "entry_changes", metric: "changes", filters: [] }],
  }, today, today, {}]), /Fonte de dados inválida/);
});

console.log(`\n${passed} verificações de mudança de prazo passaram.`);
