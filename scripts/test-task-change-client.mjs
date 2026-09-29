// Editar tarefa: trocar o cliente (migration 20261215090000_task_change_client).
// A principal leva as subtarefas; subtarefa não troca sozinha; só em cliente
// aberto que a pessoa pode usar; projeto do novo produto; equipe que não
// atende o novo cliente sai; a repetição segue; o histórico registra.
import assert from "node:assert/strict";
import { createTestDatabase } from "./database-fixture.mjs";

const db = await createTestDatabase();
const uid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const [A, admin, bia, caio] = [1, 10, 11, 12].map(uid);
await db.query(`insert into auth.users select unnest($1::uuid[])`, [
  [admin, bia, caio],
]);
await db.query(`insert into companies(id,name) values($1,'Empresa A')`, [A]);
await db.query(
  `insert into memberships(company_id,user_id,name,role) values
   ($1,$2,'Ana Admin','admin'),($1,$3,'Bia Design','member'),($1,$4,'Caio Vendas','member')`,
  [A, admin, bia, caio],
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
async function task(contract, { team = null, parent = null, project = null, creator = admin } = {}) {
  const [row] = await sql(
    `insert into tasks(company_id,contract_id,team_id,parent_id,project_id,title,creator_id,assignee_id,due_date,original_due_date)
     values($1,$2,$3,$4,$5,'Tarefa',$6,$6,current_date + 5,current_date + 5) returning id`,
    [A, contract, team, parent, project, creator],
  );
  return row.id;
}
const row = async (id) =>
  (await sql("select * from tasks where id=$1", [id]))[0];
// update_task as the edit form sends it; contract/project only when moving.
async function edit(user, id, contract = null, project = null) {
  const t = await row(id);
  await as(user);
  return rpc("update_task", [
    id, t.version, t.title, t.description, t.due_date, t.estimated_minutes,
    t.priority, null, null, null, null, null, contract, project,
  ]);
}
async function rejects(fn, pattern) {
  await assert.rejects(fn, pattern);
  await db.exec("reset role");
}

await as(admin);
const design = await rpc("create_team", [A, "Design", [bia]]);
const sales = await rpc("create_team", [A, "Vendas", [caio]]);
const clientX = await rpc("create_client", [A, "Cliente X", "", [design, sales]]);
const clientY = await rpc("create_client", [A, "Cliente Y", "", [design]]);
const clientZ = await rpc("create_client", [A, "Cliente Z", "", []]);
const product = await rpc("create_product", [A, "Social"]);
const kX = await rpc("create_contract", [A, clientX, product, "Social X"]);
const kY = await rpc("create_contract", [A, clientY, product, "Social Y"]);
const kZ = await rpc("create_contract", [A, clientZ, product, "Social Z"]);
const projectX = await rpc("create_project", [A, kX, "Lançamento X"]);
const projectY = await rpc("create_project", [A, kY, "Lançamento Y"]);

await check("sem cliente novo, a edição segue como antes", async () => {
  const id = await task(kX, { project: projectX });
  const t = await edit(admin, id);
  assert.equal(t.contract_id, kX);
  assert.equal(t.project_id, projectX);
  const [e] = await sql(
    "select detail from task_events where task_id=$1 and action='edited'",
    [id],
  );
  assert.equal(e.detail.new_client, undefined);
});

await check("a principal troca de cliente e leva as subtarefas", async () => {
  const main = await task(kX, { team: design, project: projectX });
  const sub1 = await task(kX, { parent: main, team: sales, project: projectX });
  const sub2 = await task(kX, { parent: main });
  const t = await edit(admin, main, kY, projectY);
  assert.equal(t.contract_id, kY);
  assert.equal(t.project_id, projectY);
  // Design atende o Cliente Y; Vendas não.
  assert.equal(t.team_id, design);
  const s1 = await row(sub1);
  assert.equal(s1.contract_id, kY);
  assert.equal(s1.project_id, projectY);
  assert.equal(s1.team_id, null);
  assert.deepEqual(s1.scope_teams, [design]);
  assert.equal((await row(sub2)).contract_id, kY);
  const [e] = await sql(
    "select detail from task_events where task_id=$1 and action='edited'",
    [main],
  );
  assert.equal(e.detail.old_client, "Cliente X");
  assert.equal(e.detail.new_client, "Cliente Y");
  assert.equal(e.detail.new_product, "Social");
});

await check("sem projeto escolhido, a tarefa fica sem projeto", async () => {
  const id = await task(kX, { project: projectX });
  const t = await edit(admin, id, kY);
  assert.equal(t.contract_id, kY);
  assert.equal(t.project_id, null);
});

await check("subtarefa não troca de cliente sozinha", async () => {
  const main = await task(kX);
  const sub = await task(kX, { parent: main });
  await rejects(() => edit(admin, sub, kY), /tarefa principal/);
  assert.equal((await row(sub)).contract_id, kX);
});

await check("projeto de outro produto é recusado", async () => {
  const id = await task(kX);
  await rejects(() => edit(admin, id, kY, projectX), /projeto não é deste produto/);
  assert.equal((await row(id)).contract_id, kX);
});

await check("cliente arquivado é recusado", async () => {
  const id = await task(kX);
  await as(admin);
  await rpc("set_client_archived", [clientZ, true]);
  await rejects(() => edit(admin, id, kZ), /arquivado/);
  await as(admin);
  await rpc("set_client_archived", [clientZ, false]);
});

await check("só para cliente que a pessoa pode usar", async () => {
  // Bia (Design) cria no Cliente X; o Cliente Z não é atendido por equipe dela.
  const id = await task(kX, { creator: bia });
  await rejects(() => edit(bia, id, kZ), /Sem acesso/);
  const t = await edit(bia, id, kY);
  assert.equal(t.contract_id, kY);
});

await check("a repetição passa a abrir as cópias no novo cliente", async () => {
  const id = await task(kX, { team: sales, project: projectX });
  const [r] = await sql(
    `insert into task_recurrences(company_id,source_task_id,creator_id,frequency,anchor,next_run,
      contract_id,project_id,team_id,assignee_id,title,priority)
     values($1,$2,$3,'weekly',current_date,current_date + 7,$4,$5,$6,$3,'Tarefa','normal') returning id`,
    [A, id, admin, kX, projectX, sales],
  );
  await sql("update tasks set recurrence_id=$1 where id=$2", [r.id, id]);
  await edit(admin, id, kY, projectY);
  const [after] = await sql("select * from task_recurrences where id=$1", [r.id]);
  assert.equal(after.contract_id, kY);
  assert.equal(after.project_id, projectY);
  assert.equal(after.team_id, null);
});

console.log(`\n${passed} verificações passaram.`);
