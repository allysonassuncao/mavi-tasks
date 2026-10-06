// Equipes pelo produto (migration 20270517090000_product_teams): ao adicionar
// um produto a um cliente, as equipes do produto passam a atender o cliente;
// trocar as equipes do produto atualiza todos os clientes; extras ficam.
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
   ($1,$2,'Ana Admin','admin'),($1,$3,'Bia Tráfego','member'),($1,$4,'Caio Criação','member')`,
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
const teamsOf = async (client) =>
  (
    await sql(
      `select t.name, ct.manual, ct.by_product from client_teams ct join teams t on t.id = ct.team_id
       where ct.client_id = $1 order by t.name`,
      [client],
    )
  ).map((r) => `${r.name}${r.manual ? "+extra" : ""}${r.by_product ? "+produto" : ""}`);
const sees = async (user, client) => {
  await as(user);
  const rows = (await db.query(`select id from clients where id = $1`, [client])).rows;
  return rows.length > 0;
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
const traffic = await rpc("create_team", [A, "Tráfego", [bia]]);
const creative = await rpc("create_team", [A, "Criação", [caio]]);
const ads = await rpc("create_product", [A, "Make Ads", [traffic]]);
const social = await rpc("create_product", [A, "Social"]);
const client = await rpc("create_client", [A, "Cliente X", ""]);
const legacy = await rpc("create_client", [A, "Cliente Antigo", "", [creative]]);

await check("cliente novo sem produto não tem equipe", async () => {
  assert.deepEqual(await teamsOf(client), []);
  assert.equal(await sees(bia, client), false);
});

await as(admin);
const adsX = await rpc("create_contract", [A, client, ads, "Make Ads X"]);
await check("adicionar o produto traz a equipe dele ao cliente", async () => {
  assert.deepEqual(await teamsOf(client), ["Tráfego+produto"]);
  assert.equal(await sees(bia, client), true);
  assert.equal(await sees(caio, client), false);
});

await as(admin);
await rpc("update_client", [client, "Cliente X", "", [creative]]);
await check("equipe extra no cliente soma às do produto", async () => {
  assert.deepEqual(await teamsOf(client), ["Criação+extra", "Tráfego+produto"]);
  assert.equal(await sees(caio, client), true);
});

await as(admin);
await rpc("update_client", [client, "Cliente X", "", []]);
await check("tirar os extras não tira a equipe do produto", async () => {
  assert.deepEqual(await teamsOf(client), ["Tráfego+produto"]);
});

await as(admin);
await rpc("update_product", [ads, "Make Ads", null, null, [creative]]);
await check("trocar a equipe do produto atualiza o cliente", async () => {
  assert.deepEqual(await teamsOf(client), ["Criação+produto"]);
  assert.equal(await sees(bia, client), false);
  assert.equal(await sees(caio, client), true);
});

await as(admin);
await rpc("update_product", [ads, "Make Ads Pro", null, null, null]);
await check("editar o produto sem p_teams mantém as equipes", async () => {
  assert.deepEqual(await teamsOf(client), ["Criação+produto"]);
});

await as(admin);
await rpc("update_client", [legacy, "Cliente Antigo", "", [creative, traffic]]);
await rpc("create_contract", [A, legacy, ads, "Make Ads Antigo"]);
await check("extra coberto pelo produto deixa de ser extra", async () => {
  assert.deepEqual(await teamsOf(legacy), ["Criação+produto", "Tráfego+extra"]);
});

await as(admin);
await rpc("update_product", [social, "Social", null, null, [traffic]]);
const socialX = await rpc("create_contract", [A, client, social, "Social X"]);
await check("dois produtos, duas equipes", async () => {
  assert.deepEqual(await teamsOf(client), ["Criação+produto", "Tráfego+produto"]);
});

// Com histórico, remover arquiva; sem histórico, exclui. Nos dois casos a
// equipe que só vinha por ele sai do cliente.
await sql(
  `insert into tasks(company_id,contract_id,title,assignee_id,due_date,original_due_date)
   values($1,$2,'Post',$3,current_date,current_date)`,
  [A, socialX, bia],
);
await as(admin);
assert.equal(await rpc("remove_contract", [socialX]), "archived");
await check("produto arquivado deixa de trazer a equipe", async () => {
  assert.deepEqual(await teamsOf(client), ["Criação+produto"]);
});
await check("tarefas sem equipe acompanham as equipes do cliente", async () => {
  const [t] = await sql(`select scope_teams from tasks where contract_id = $1`, [socialX]);
  assert.deepEqual(t.scope_teams, [creative]);
});

await sql(`update contracts set archived = false where id = $1`, [socialX]);
await check("produto reativado traz a equipe de volta", async () => {
  assert.deepEqual(await teamsOf(client), ["Criação+produto", "Tráfego+produto"]);
});

await as(admin);
assert.equal(await rpc("remove_contract", [adsX]), "deleted");
await check("produto excluído tira a equipe dele", async () => {
  assert.deepEqual(await teamsOf(client), ["Tráfego+produto"]);
});

// Social Leads e create_contract com p_team gravam direto: viram extras.
await as(admin);
await rpc("create_contract", [A, client, ads, "Make Ads 2", traffic]);
await check("p_team de chamadas antigas não duplica nem quebra", async () => {
  assert.deepEqual(await teamsOf(client), ["Criação+produto", "Tráfego+produto"]);
});

await check("membros leem as equipes dos produtos; anônimo não", async () => {
  await as(bia);
  const rows = (await db.query(`select * from product_teams`)).rows;
  assert.equal(rows.length, 2);
  await as(null);
  await assert.rejects(db.query(`select * from product_teams`));
});

await check("só líderes mudam as equipes do produto", async () => {
  await as(bia);
  await assert.rejects(rpc("update_product", [ads, "Make Ads", null, null, []]), /Sem permissão/);
  await assert.rejects(db.query(`insert into product_teams values($1,$2,$3)`, [A, ads, traffic]));
});

console.log(`\n${passed} verificações de equipes por produto passaram.`);
