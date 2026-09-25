// Campo "Projeto" por produto (migration 20261008090000_product_project_field):
// ligado por padrão; gestores e administradores mudam ao editar o produto.
import assert from "node:assert/strict";
import { createTestDatabase } from "./database-fixture.mjs";

const db = await createTestDatabase();
const uid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const [A, admin, manager, member] = [1, 10, 11, 12].map(uid);
await db.query(`insert into auth.users select unnest($1::uuid[])`, [
  [admin, manager, member],
]);
await db.query(`insert into companies(id,name) values($1,'Empresa A')`, [A]);
await db.query(
  `insert into memberships(company_id,user_id,name,role) values
   ($1,$2,'Ana Admin','admin'),($1,$3,'Gabi Gestora','manager'),
   ($1,$4,'Caio Colaborador','member')`,
  [A, admin, manager, member],
);
async function as(user) {
  await db.exec("reset role");
  await db.query(`select set_config('request.jwt.claim.sub',$1,false)`, [
    user ?? "",
  ]);
  await db.exec(`set role ${user ? "authenticated" : "anon"}`);
}
const update = async (who, args) => {
  await as(who);
  await db.query(
    "select public.update_product(p_product => $1, p_name => $2, p_color => $3, p_task_project_field => $4)",
    args,
  );
};
const field = async (product) => {
  await db.exec("reset role");
  return (
    await db.query(
      "select task_project_field, color from products where id=$1",
      [product],
    )
  ).rows[0];
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
const product = (
  await db.query("select public.create_product($1,$2) as id", [A, "Make Ads"])
).rows[0].id;

await check("produto novo mostra o campo Projeto (como antes)", async () => {
  assert.equal((await field(product)).task_project_field, true);
});

await check("gestor e administrador desligam e religam", async () => {
  await update(manager, [product, "Make Ads", null, false]);
  assert.equal((await field(product)).task_project_field, false);
  await update(admin, [product, "Make Ads", null, true]);
  assert.equal((await field(product)).task_project_field, true);
});

await check("sem o parâmetro, a escolha e a cor ficam como estão", async () => {
  await update(admin, [product, "Make Ads", "#123456", false]);
  await update(admin, [product, "Make Ads Pro", null, null]);
  assert.deepEqual(await field(product), {
    task_project_field: false,
    color: "#123456",
  });
});

await check("colaborador não muda", async () => {
  await assert.rejects(
    update(member, [product, "Make Ads", null, true]),
    /Sem permissão/,
  );
  assert.equal((await field(product)).task_project_field, false);
});

console.log(`\n${passed} verificações do campo Projeto por produto passaram.`);
