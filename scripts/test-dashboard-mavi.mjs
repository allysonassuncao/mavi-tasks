// MAVI nos Dashboards (migration 20270201090000_dashboard_mavi): a
// funcionalidade 'dashboard_builder' em "Quem usa qual modelo" — sem regra,
// segue o padrão da empresa; com regra, o modelo escolhido; só líderes
// escolhem.
import assert from "node:assert/strict";
import { createTestDatabase } from "./database-fixture.mjs";

const db = await createTestDatabase();
const uid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const [A, admin, ana] = [1, 10, 12].map(uid);
await db.query(`insert into auth.users select unnest($1::uuid[])`, [[admin, ana]]);
await db.query(`insert into companies(id,name) values($1,'Make')`, [A]);
await db.query(
  `insert into memberships(company_id,user_id,name,role,active) values ($1,$2,'Ana Admin','admin',true),($1,$3,'Ana Souza','member',true)`,
  [A, admin, ana],
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
const one = async (user, text, args = []) => Object.values((await q(user, text, args))[0])[0];
let passed = 0;
async function check(title, fn) {
  try {
    await fn();
    passed++;
    console.log(`PASS ${title}`);
  } catch (e) {
    console.error(`FAIL ${title}`, String(e?.message ?? e).slice(0, 300));
    throw e;
  }
}
const models = JSON.stringify(["claude-opus-5-5", "claude-sonnet-5-5"].map((id) => ({ id, input: 1, output: 5 })));
const claude = await one(admin, "select public.ai_save_provider($1,null,'Claude','anthropic',null,$2::jsonb,'v1:abc','wxyz',true)", [
  A,
  models,
]);
const resolve = async () => {
  const r = await one(ana, "select public.ai_resolve_route($1,null,null,null,'dashboard_builder')", [A]);
  return r ? r.model : null;
};

await check("sem regra, os Dashboards seguem o padrão da empresa", async () => {
  await q(admin, "select public.ai_set_route($1,'company',null,$2,'claude-opus-5-5')", [A, claude]);
  assert.equal(await resolve(), "claude-opus-5-5");
});

await check("com regra, o modelo escolhido para os Dashboards", async () => {
  await q(admin, "select public.ai_set_route($1,'feature',null,$2,'claude-sonnet-5-5','dashboard_builder')", [A, claude]);
  assert.equal(await resolve(), "claude-sonnet-5-5");
  await q(admin, "select public.ai_set_route($1,'feature',null,null,null,'dashboard_builder')", [A]);
  assert.equal(await resolve(), "claude-opus-5-5");
});

await check("só administradores e gestores escolhem", async () => {
  await assert.rejects(
    () => q(ana, "select public.ai_set_route($1,'feature',null,$2,'claude-sonnet-5-5','dashboard_builder')", [A, claude]),
    /Só administradores e gestores/,
  );
  await db.exec("reset role");
});

await check("o custo entra no módulo dashboards", async () => {
  await q(
    ana,
    `select public.ai_log_usage($1,'dashboards','dashboard_builder',null,null,null,null,'claude-opus-5-5',100,50,0,0,0,0.01)`,
    [A],
  );
  await db.exec("reset role");
  const [row] = (await db.query("select module, kind from public.ai_usage where company_id = $1", [A])).rows;
  assert.deepEqual([row.module, row.kind], ["dashboards", "dashboard_builder"]);
});

console.log(`\n${passed} verificações passaram.`);
