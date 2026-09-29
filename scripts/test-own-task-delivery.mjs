// Own tasks (migration 20261125090000_own_task_delivery): whoever creates a
// task for themselves delivers it without passing through Em validação.
import assert from "node:assert/strict";
import { applyMigration, createTestDatabase } from "./database-fixture.mjs";

const MIGRATION = "20261125090000";
const db = await createTestDatabase({ until: MIGRATION });
const uid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const [A, admin, member] = [1, 10, 11].map(uid);
await db.query(`insert into auth.users select unnest($1::uuid[])`, [
  [admin, member],
]);
await db.query(`insert into companies(id,name) values($1,'Empresa A')`, [A]);
await db.query(
  `insert into memberships(company_id,user_id,name,role) values
   ($1,$2,'Ana Admin','admin'),($1,$3,'Bruno Membro','member')`,
  [A, admin, member],
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

await applyMigration(db, MIGRATION);

await as(admin);
const team = await rpc("create_team", [A, "Equipe A", [member]]);
const client = await rpc("create_client", [A, "Cliente A", ""]);
const product = await rpc("create_product", [A, "Make Ads"]);
const contract = await rpc("create_contract", [
  A,
  client,
  product,
  "Contrato A",
  team,
]);
const newTask = async (creator, assignee, title, clientApproval = false) => {
  await as(creator);
  return rpc("create_task", [
    A,
    contract,
    title,
    assignee,
    "2026-10-05",
    null,
    team,
    "",
    "normal",
    60,
    clientApproval,
  ]);
};
const statusOf = async (id) =>
  (
    await sql(
      "select status,version,internal_approved_by,delivered_at from tasks where id=$1",
      [id],
    )
  )[0];
const deliver = async (user, id) => {
  const { version } = await statusOf(id);
  await as(user);
  return rpc("transition_task", [id, version, "move", "", "done", null]);
};

await check("quem criou a tarefa para si entrega direto", async () => {
  const task = await newTask(member, member, "Minha tarefa");
  await deliver(member, task);
  const row = await statusOf(task);
  assert.equal(row.status, "done");
  assert.ok(row.delivered_at);
});

await check("também de dentro de Em validação", async () => {
  const task = await newTask(member, member, "Enviei para validar");
  const { version } = await statusOf(task);
  await as(member);
  await rpc("transition_task", [task, version, "move", "", "review", null]);
  await deliver(member, task);
  assert.equal((await statusOf(task)).status, "done");
});

await check("tarefa criada por outra pessoa continua exigindo validação", async () => {
  const task = await newTask(admin, member, "Pedido da Ana");
  await assert.rejects(() => deliver(member, task), /exige validação/);
});

await check("o criador não entrega a tarefa de outra pessoa", async () => {
  const task = await newTask(member, admin, "Pedido do Bruno");
  await assert.rejects(() => deliver(member, task), /exige validação/);
});

await check("com aprovação do cliente, aguarda o cliente", async () => {
  const task = await newTask(member, member, "Post do cliente", true);
  await deliver(member, task);
  const row = await statusOf(task);
  assert.equal(row.status, "review");
  assert.equal(row.internal_approved_by, member);
});

await db.close();
console.log(`\n${passed} verificações da entrega da própria tarefa aprovadas.`);
