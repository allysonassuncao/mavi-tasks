// IA do MAVI · fase 4 (migration 20261024090000_ai_mcp): quem pode usar o
// servidor MCP (liberado por padrão para administradores e gestores;
// colaboradores só se um administrador liberar), a lista de empresas que o
// servidor usa, o registro de consumo "mcp" e "Consumo de IA" nos módulos que
// o administrador pode esconder.
import assert from "node:assert/strict";
import { createTestDatabase } from "./database-fixture.mjs";

const db = await createTestDatabase();
const uid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const [A, B, admin, manager, member, inactive] = [1, 2, 10, 11, 12, 13].map(uid);
await db.query(`insert into auth.users select unnest($1::uuid[])`, [
  [admin, manager, member, inactive],
]);
await db.query(`insert into companies(id,name) values($1,'Make'),($2,'Beta')`, [A, B]);
await db.query(
  `insert into memberships(company_id,user_id,name,role,active) values
   ($1,$3,'Ana Admin','admin',true),($1,$4,'Gabi Gestora','manager',true),
   ($1,$5,'Bruno Colab','member',true),($1,$6,'Inês Inativa','admin',false),
   ($2,$5,'Bruno Colab','admin',true)`,
  [A, B, admin, manager, member, inactive],
);
async function as(user) {
  await db.exec("reset role");
  await db.query(`select set_config('request.jwt.claim.sub',$1,false)`, [user ?? ""]);
  await db.exec(`set role ${user ? "authenticated" : "anon"}`);
}
const q = async (user, text, args = []) => {
  await as(user);
  return (await db.query(text, args)).rows;
};
const spaces = async (user) =>
  (await q(user, "select name, role, allowed from public.mcp_workspaces()")).map(
    (r) => `${r.name}:${r.role}:${r.allowed}`,
  );
const log = (user, company, module = "mcp") =>
  q(user, "select public.ai_log_usage($1,$2,'search',null,null,null,null,'m',0,0,0,0,10,0.001)", [
    company,
    module,
  ]);
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

await check("padrão: liberado para administradores e gestores, não para colaboradores", async () => {
  assert.deepEqual(await spaces(admin), ["Make:admin:true"]);
  assert.deepEqual(await spaces(manager), ["Make:manager:true"]);
  // Cada empresa tem a sua regra: admin na Beta, colaborador na Make.
  assert.deepEqual(await spaces(member), ["Beta:admin:true", "Make:member:false"]);
  assert.deepEqual(await spaces(inactive), []);
  assert.deepEqual(await spaces(null).catch((e) => e.message), "permission denied for function mcp_workspaces");
});

await check("só administradores liberam ou desligam; vale na hora", async () => {
  await assert.rejects(
    () => q(manager, "select public.set_member_mcp($1,$2,'on')", [A, member]),
    /Somente administradores/,
  );
  await assert.rejects(
    () => q(admin, "select public.set_member_mcp($1,$2,'talvez')", [A, member]),
    /Opção inválida/,
  );
  await assert.rejects(
    () => q(admin, "select public.set_member_mcp($1,$2,'on')", [A, uid(99)]),
    /não encontrado/,
  );
  await q(admin, "select public.set_member_mcp($1,$2,'on')", [A, member]);
  assert.deepEqual(await spaces(member), ["Beta:admin:true", "Make:member:true"]);
  await q(admin, "select public.set_member_mcp($1,$2,'off')", [A, manager]);
  assert.deepEqual(await spaces(manager), ["Make:manager:false"]);
  // Ninguém muda a própria coluna direto na tabela.
  for (const who of [manager, member])
    await q(who, "update memberships set mcp_access = 'on' where user_id = $1", [who]).catch(() => {});
  assert.deepEqual(await spaces(manager), ["Make:manager:false"]);
  await q(admin, "select public.set_member_mcp($1,$2,'default')", [A, member]);
  assert.deepEqual(await spaces(member), ["Beta:admin:true", "Make:member:false"]);
  await q(admin, "select public.set_member_mcp($1,$2,'on')", [A, member]);
});

await check("consumo 'mcp' só de quem pode usar o MCP naquela empresa", async () => {
  await assert.rejects(() => log(manager, A), /Sem permissão/);
  await log(manager, A, "assistant");
  await log(member, A);
  await log(admin, A);
  await db.exec("reset role");
  const r = (await db.query("select module, count(*)::int n from ai_usage group by module order by module")).rows;
  assert.deepEqual(r, [
    { module: "assistant", n: 1 },
    { module: "mcp", n: 2 },
  ]);
});

await check("'Consumo de IA' entra nos módulos que o administrador esconde", async () => {
  await q(admin, "select public.set_member_pages($1,$2,array['aiUsage','drive'])", [A, manager]);
  await db.exec("reset role");
  const [row] = (await db.query("select hidden_pages from memberships where company_id=$1 and user_id=$2", [A, manager])).rows;
  assert.deepEqual(row.hidden_pages, ["aiUsage", "drive"]);
  await assert.rejects(
    () => q(admin, "select public.set_member_pages($1,$2,array['nada'])", [A, manager]),
    /Módulo inválido/,
  );
});

await db.close();
console.log(`\n${passed} verificações do MCP aprovadas.`);
