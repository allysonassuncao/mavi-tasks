// Status flow change (migration 20260929110000_correction_status): Correção
// joins, Em delegação leaves, and tasks still in it move to Em andamento.
import assert from "node:assert/strict";
import { applyMigration, createTestDatabase } from "./database-fixture.mjs";

const MIGRATION = "20260929110000";
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
const newTask = async (title) => {
  await as(admin);
  return rpc("create_task", [
    A,
    contract,
    title,
    member,
    "2026-10-05",
    null,
    team,
    "",
    "normal",
    60,
    true,
  ]);
};
// Before the migration, a task still waiting Em delegação, with a timer on.
const waiting = await newTask("Ainda em delegação");
await as(member);
const timer = await rpc("start_timer", [waiting]);
const statusOf = async (id) =>
  (await sql("select status,version,revision from tasks where id=$1", [id]))[0];
await check("antes da migração a tarefa está em delegação", async () =>
  assert.equal((await statusOf(waiting)).status, "open"),
);

await db.exec("reset role");
await applyMigration(db, MIGRATION);

await check("tarefas em delegação passam para Em andamento", async () => {
  assert.equal((await statusOf(waiting)).status, "progress");
  const [event] = await sql(
    "select detail from task_events where task_id=$1 and detail->>'from'='open'",
    [waiting],
  );
  assert.equal(event.detail.to, "progress", "fica no histórico");
});

await check("a migração não pausa quem já estava trabalhando", async () => {
  const [row] = await sql("select ended_at from time_entries where id=$1", [
    timer.id,
  ]);
  assert.equal(row.ended_at, null);
});

await check("tarefa nova começa Em andamento", async () => {
  const task = await newTask("Nova");
  assert.equal((await statusOf(task)).status, "progress");
});

const move = async (id, status, note = "") => {
  const { version } = await statusOf(id);
  await as(admin);
  return rpc("transition_task", [id, version, "move", note, status, member]);
};

await check("não é mais possível voltar para Em delegação", async () => {
  const task = await newTask("Sem delegação");
  await assert.rejects(() => move(task, "open"), /Status inválido/);
});

await check("Correção exige descrever o que corrigir", async () => {
  const task = await newTask("Precisa de correção");
  await assert.rejects(
    () => move(task, "correction", ""),
    /Descreva a correção necessária/,
  );
});

await check("Correção abre nova revisão e registra o pedido", async () => {
  const task = await newTask("Corrigir legenda");
  await move(task, "review", "");
  const before = (await statusOf(task)).revision;
  await move(task, "correction", "A legenda está com o preço errado");
  const after = await statusOf(task);
  assert.equal(after.status, "correction");
  assert.equal(after.revision, before + 1);
  const comments = await sql(
    "select body from comments where task_id=$1 and body like '%Correção%'",
    [task],
  );
  assert.ok(comments.some((c) => c.body.includes("preço errado")));
});

await check("de Correção a tarefa volta a andar livremente", async () => {
  const task = await newTask("Corrigida");
  await move(task, "correction", "Ajustar o logotipo");
  await move(task, "progress", "");
  assert.equal((await statusOf(task)).status, "progress");
});

await db.close();
console.log(`\n${passed} verificações do fluxo de status aprovadas.`);
