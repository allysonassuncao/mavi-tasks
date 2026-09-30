// Busca avançada com a tabela da lista (migração 20270124090000_task_search_rows):
// search_task_rows traz as tarefas inteiras (menos descrição e campos do
// template), até 2000, na ordem da relevância; search_tasks continua igual,
// em páginas de até 100, lendo dela; e cada um só vê as tarefas que já via.
import assert from "node:assert/strict";
import { createTestDatabase } from "./database-fixture.mjs";

const db = await createTestDatabase();
const uid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const [A, admin, doer, other] = [1, 10, 11, 12].map(uid);
await db.query(`insert into auth.users select unnest($1::uuid[])`, [[admin, doer, other]]);
await db.query(`insert into companies(id,name) values($1,'Empresa A')`, [A]);
await db.query(
  `insert into memberships(company_id,user_id,name,role) values
   ($1,$2,'Ana Admin','admin'),($1,$3,'Davi Faz','member'),($1,$4,'Olga Outra','member')`,
  [A, admin, doer, other],
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
const rows = async (text, args = []) => (await db.query(text, args)).rows;
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
const client = await rpc("create_client", [A, "Cliente A", ""]);
const product = await rpc("create_product", [A, "Make Ads"]);
const contract = await rpc("create_contract", [A, client, product, "Contrato A", null]);
const newTask = (title, assignee, description = "") =>
  rpc("create_task", [
    A, contract, title, assignee, "2026-10-05", null, null, description, "normal", 30, false,
    null, null, null, null,
  ]);
const inTitle = await newTask("Briefing da campanha", doer);
const inDescription = await newTask("Arte do post", doer, "<p>Seguir o briefing enviado</p>");
const others = await newTask("Briefing de outra pessoa", other);
for (let i = 0; i < 120; i++) await newTask(`Tarefa em lote ${i}`, doer);

await check("traz a tarefa inteira, sem descrição nem campos do template", async () => {
  await as(admin);
  const found = await rows("select * from search_task_rows($1,'briefing')", [A]);
  assert.deepEqual(
    found.map((r) => r.task.id).sort(),
    [others, inTitle, inDescription].sort(),
  );
  // Título antes da descrição (relevância), como a busca antiga.
  assert.deepEqual(found.map((r) => r.match_in).slice(-1), ["description"]);
  const row = found.find((r) => r.task.id === inDescription);
  assert.equal(row.task.description, undefined);
  assert.equal(row.task.custom_fields, undefined);
  for (const k of ["title", "status", "due_date", "creator_id", "parent_id", "estimated_minutes", "created_at"])
    assert.ok(k in row.task, `a linha da lista precisa de ${k}`);
  assert.match(row.snippet, /briefing/);
  assert.equal(Number(row.total), 3);
});

await check("sem termo, os filtros listam tudo de uma vez (além das 100 da busca antiga)", async () => {
  await as(admin);
  const all = await rows("select * from search_task_rows($1,'',p_assignee=>$2)", [A, doer]);
  assert.equal(all.length, 122);
  const page = await rows("select * from search_tasks($1,'',p_assignee=>$2,p_limit=>500)", [A, doer]);
  assert.equal(page.length, 100, "a busca antiga continua em páginas de até 100");
  assert.equal(Number(page[0].total), 122);
});

await check("search_tasks devolve o mesmo de antes, na mesma ordem", async () => {
  await as(admin);
  const old = await rows("select * from search_tasks($1,'briefing')", [A]);
  const full = await rows("select * from search_task_rows($1,'briefing')", [A]);
  assert.deepEqual(old.map((r) => r.task_id), full.map((r) => r.task.id));
  assert.deepEqual(old.map((r) => r.match_in), full.map((r) => r.match_in));
  const next = await rows("select * from search_tasks($1,'briefing',p_limit=>1,p_offset=>1)", [A]);
  assert.equal(next[0].task_id, full[1].task.id);
});

await check("cada um só encontra o que já podia ver", async () => {
  await as(doer);
  const found = await rows("select * from search_task_rows($1,'briefing')", [A]);
  assert.deepEqual(found.map((r) => r.task.id).sort(), [inDescription, inTitle].sort());
  await as(null);
  await assert.rejects(() => rows("select * from search_task_rows($1,'briefing')", [A]), /permission denied/);
});

console.log(`${passed} task search rows checks passed`);
process.exit(0);
