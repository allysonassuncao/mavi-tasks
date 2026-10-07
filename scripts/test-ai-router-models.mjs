// MAVI · roteador de modelos (migration 20270602090000_ai_router_models): os
// modelos que o roteador pode escolher (só líderes; modelos de conversa
// cadastrados na empresa ou Claudes do servidor; nunca o Jev nem os que só
// transcrevem/geram imagem; lista vazia recusa), o histórico e a política.
import assert from "node:assert/strict";
import { createTestDatabase } from "./database-fixture.mjs";

const db = await createTestDatabase();
const uid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const SERVER = "00000000-0000-0000-0000-000000000000";
const [A, B, admin, ana] = [1, 2, 10, 11].map(uid);
await db.query(`insert into auth.users select unnest($1::uuid[])`, [[admin, ana]]);
await db.query(`insert into companies(id,name) values($1,'Make'),($2,'Outra')`, [A, B]);
await db.query(
  `insert into memberships(company_id,user_id,name,role,active) values ($1,$2,'Ana Admin','admin',true),($1,$3,'Ana','member',true)`,
  [A, admin, ana],
);
async function as(user) {
  await db.exec("reset role");
  await db.query(`select set_config('request.jwt.claim.sub',$1,false)`, [user ?? ""]);
  await db.exec(`set role ${user ? "authenticated" : "anon"}`);
}
async function rpc(name, args) {
  return (
    await db.query(`select to_jsonb(public.${name}(${args.map((_, i) => `$${i + 1}`).join(",")})) as result`, args)
  ).rows[0].result;
}
const sql = async (text, args = []) => {
  await db.exec("reset role");
  return (await db.query(text, args)).rows;
};
async function rejects(fn, pattern) {
  await assert.rejects(fn, (e) => pattern.test(e.message));
  await db.exec("reset role");
}
const [router] = await sql(
  `insert into mavi_private.ai_providers(company_id,name,kind,key_cipher,models) values
   ($1,'OpenRouter','openrouter','v1:k','[{"id":"anthropic/claude-sonnet-4.5","input":3,"output":15},{"id":"typesafe/jev-1","input":1,"output":1},{"id":"openai/gpt-image-1","input":1,"output":1}]') returning id`,
  [A],
);
const [theirs] = await sql(
  `insert into mavi_private.ai_providers(company_id,name,kind,key_cipher,models) values ($1,'Deles','openai','v1:z','[{"id":"gpt-5","input":1,"output":1}]') returning id`,
  [B],
);
const save = (models) => rpc("ai_router_save", [A, JSON.stringify({ route_models: models })]);

await as(ana);
await rejects(() => save([`${SERVER}|claude-haiku-4-5`]), /Só administradores e gestores/);
await as(admin);
await rejects(() => save([`${router.id}|typesafe/jev-1`]), /O Jev confere e audita respostas/);
await as(admin);
await rejects(() => save([`${router.id}|openai/gpt-image-1`]), /não conversa/);
await as(admin);
await rejects(() => save([`${theirs.id}|gpt-5`]), /Modelo não cadastrado/);
await as(admin);
await rejects(() => save([`${router.id}|nao-existe`]), /Modelo não cadastrado/);
await as(admin);
await rejects(() => save([`${SERVER}|gpt-5`]), /Modelo do servidor inválido/);
await as(admin);
await rejects(() => save(["lixo"]), /Modelo inválido/);
await as(admin);
await rejects(() => save([]), /pelo menos um modelo/);
console.log("PASS só líderes; nunca o Jev nem os que não conversam; só modelos cadastrados; lista vazia recusa");

await as(admin);
await save([`${router.id}|anthropic/claude-sonnet-4.5`, `${SERVER}|claude-haiku-4-5`, `${SERVER}|claude-haiku-4-5`]);
await as(admin);
assert.deepEqual((await rpc("ai_router_get", [A])).route_models.sort(), [`${SERVER}|claude-haiku-4-5`, `${router.id}|anthropic/claude-sonnet-4.5`].sort());
await as(ana);
const ctx = await rpc("ai_route_context", [A, null, null, null, "page"]);
assert.equal(ctx.route_models.length, 2);
// Voltar para "todos".
await as(admin);
await rpc("ai_router_save", [A, JSON.stringify({ route_models: null })]);
await as(ana);
assert.equal((await rpc("ai_route_context", [A, null, null, null, "page"])).route_models, null);
await as(admin);
const log = (await rpc("ai_settings_log", [A, "router", null, "route_models", null, null, null, null, 20])).items;
assert.deepEqual(log.map((l) => l.action), ["changed", "changed"]);
console.log("PASS salva sem repetir, volta para todos, histórico e a política de cada pergunta");
console.log("\n2 verificações dos modelos do roteamento passaram.");
