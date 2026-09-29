// Equipes responsáveis de cada tarefa (migration 20261205090000_task_scope_teams):
// tasks.scope_teams é a equipe da tarefa ou, sem equipe, as equipes do
// cliente — as abas "Equipes" e "Outras" filtram por ela em vez de mandar
// todos os contratos na URL.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createTestDatabase } from "./database-fixture.mjs";

const MIGRATION = "20261205090000_task_scope_teams.sql";
const db = await createTestDatabase({ until: MIGRATION });
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
async function task(contract, team = null, title = "Tarefa") {
  const [row] = await sql(
    `insert into tasks(company_id,contract_id,team_id,title,creator_id,assignee_id,due_date,original_due_date)
     values($1,$2,$3,$4,$5,$5,current_date,current_date) returning id`,
    [A, contract, team, title, admin],
  );
  return row.id;
}
const teamsOf = async (id) =>
  (await sql("select scope_teams from tasks where id=$1", [id]))[0].scope_teams;

await as(admin);
const design = await rpc("create_team", [A, "Design", [bia]]);
const sales = await rpc("create_team", [A, "Vendas", [caio]]);
const client = await rpc("create_client", [A, "Cliente X", "", [design]]);
const other = await rpc("create_client", [A, "Cliente Y", "", []]);
const product = await rpc("create_product", [A, "Social"]);
const contract = await rpc("create_contract", [A, client, product, "Social X"]);
const otherContract = await rpc("create_contract", [
  A,
  other,
  product,
  "Social Y",
]);
const before = {
  clientTask: await task(contract),
  ownTeam: await task(otherContract, sales),
  orphan: await task(otherContract),
};

await db.exec(await readFile(`supabase/migrations/${MIGRATION}`, "utf8"));

await check("preenche as tarefas que já existiam", async () => {
  assert.deepEqual(await teamsOf(before.clientTask), [design]);
  assert.deepEqual(await teamsOf(before.ownTeam), [sales]);
  assert.deepEqual(await teamsOf(before.orphan), []);
});

await check("tarefa nova: a equipe dela ou as do cliente", async () => {
  assert.deepEqual(await teamsOf(await task(contract, sales)), [sales]);
  assert.deepEqual(await teamsOf(await task(contract)), [design]);
});

await check("mudar equipe ou contrato da tarefa recalcula", async () => {
  const id = await task(contract);
  await sql("update tasks set team_id=$2 where id=$1", [id, sales]);
  assert.deepEqual(await teamsOf(id), [sales]);
  await sql("update tasks set team_id=null, contract_id=$2 where id=$1", [
    id,
    otherContract,
  ]);
  assert.deepEqual(await teamsOf(id), []);
});

await check("ninguém grava a coluna direto", async () => {
  await sql("update tasks set scope_teams=$2 where id=$1", [
    before.orphan,
    [design],
  ]);
  assert.deepEqual(await teamsOf(before.orphan), []);
});

await check("equipes do cliente mudam: tarefas sem equipe acompanham", async () => {
  await as(admin);
  await rpc("update_client", [client, "Cliente X", "", [design, sales]]);
  assert.deepEqual(
    await teamsOf(before.clientTask),
    [design, sales].sort(),
  );
  // Com equipe própria, fica com a dela.
  const own = await task(contract, sales);
  await as(admin);
  await rpc("update_client", [client, "Cliente X", "", []]);
  assert.deepEqual(await teamsOf(before.clientTask), []);
  assert.deepEqual(await teamsOf(own), [sales]);
});

await check("contrato muda de cliente: tarefas sem equipe acompanham", async () => {
  await as(admin);
  await rpc("update_client", [other, "Cliente Y", "", [sales]]);
  assert.deepEqual(await teamsOf(before.orphan), [sales]);
  await as(admin);
  await rpc("update_client", [client, "Cliente X", "", [design]]);
  await as(admin);
  await rpc("update_contract", [otherContract, "Social Y", client, product]);
  assert.deepEqual(await teamsOf(before.orphan), [design]);
  assert.deepEqual(await teamsOf(before.ownTeam), [sales]);
});

await check("abas Equipes/Outras pelo filtro de sobreposição", async () => {
  const mine = (
    await sql(
      "select id from tasks where company_id=$1 and scope_teams && $2::uuid[]",
      [A, [design]],
    )
  ).map((r) => r.id);
  const rest = (
    await sql(
      "select id from tasks where company_id=$1 and not scope_teams && $2::uuid[]",
      [A, [design]],
    )
  ).map((r) => r.id);
  assert.ok(mine.includes(before.clientTask));
  assert.ok(rest.includes(before.ownTeam));
  const [{ total }] = await sql(
    "select count(*)::int as total from tasks where company_id=$1",
    [A],
  );
  assert.equal(mine.length + rest.length, total);
});

console.log(`${passed} checks passed`);
