// Módulos visíveis por pessoa (migration 20261007090000_member_modules): só
// administradores escolhem; a lista guarda os módulos escondidos, validados.
import assert from "node:assert/strict";
import { createTestDatabase } from "./database-fixture.mjs";

const db = await createTestDatabase();
const uid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const [A, B, admin, manager, member, outsider] = [1, 2, 10, 11, 12, 13].map(
  uid,
);
await db.query(`insert into auth.users select unnest($1::uuid[])`, [
  [admin, manager, member, outsider],
]);
await db.query(
  `insert into companies(id,name) values($1,'Empresa A'),($2,'Empresa B')`,
  [A, B],
);
await db.query(
  `insert into memberships(company_id,user_id,name,role) values
   ($1,$3,'Ana Admin','admin'),($1,$4,'Gabi Gestora','manager'),
   ($1,$5,'Caio Colaborador','member'),($2,$6,'Fora','admin')`,
  [A, B, admin, manager, member, outsider],
);
async function as(user) {
  await db.exec("reset role");
  await db.query(`select set_config('request.jwt.claim.sub',$1,false)`, [
    user ?? "",
  ]);
  await db.exec(`set role ${user ? "authenticated" : "anon"}`);
}
const set = async (who, target, hidden) => {
  await as(who);
  await db.query("select public.set_member_pages($1,$2,$3)", [
    A,
    target,
    hidden,
  ]);
};
const hidden = async (target) => {
  await db.exec("reset role");
  return (
    await db.query(
      "select hidden_pages from memberships where company_id=$1 and user_id=$2",
      [A, target],
    )
  ).rows[0].hidden_pages;
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

await check("todos veem tudo até alguém esconder", async () => {
  assert.deepEqual(await hidden(member), []);
});

await check(
  "administrador esconde módulos (sem repetir, em ordem)",
  async () => {
    await set(admin, member, ["reports", "agenda", "reports"]);
    assert.deepEqual(await hidden(member), ["agenda", "reports"]);
    await set(admin, member, []);
    assert.deepEqual(await hidden(member), []);
    // Also for another administrator, or for oneself.
    await set(admin, admin, ["storage"]);
    assert.deepEqual(await hidden(admin), ["storage"]);
  },
);

await check("só módulos conhecidos; perfil e configurações não", async () => {
  for (const page of ["settings", "profile", "xyz"])
    await assert.rejects(set(admin, member, [page]), /Módulo inválido/);
});

await check("gestor, colaborador e outra empresa não escolhem", async () => {
  for (const who of [manager, member, outsider])
    await assert.rejects(
      set(who, member, ["tasks"]),
      /Somente administradores/,
    );
  await as(admin);
  await assert.rejects(
    db.query("select public.set_member_pages($1,$2,$3)", [
      A,
      outsider,
      ["tasks"],
    ]),
    /Usuário não encontrado/,
  );
});

await check("ninguém muda a lista direto na tabela", async () => {
  await as(member);
  await db
    .query(
      "update memberships set hidden_pages='{}' where company_id=$1 and user_id=$2",
      [A, admin],
    )
    .catch(() => {});
  assert.deepEqual(await hidden(admin), ["storage"]);
});

console.log(`\n${passed} verificações de módulos por pessoa passaram.`);
