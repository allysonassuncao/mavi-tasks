// MAVI · um modelo para cada parte (migration 20261217090000_mavi_routes_questions):
// a bolinha e o módulo com regras próprias (o módulo sem regra segue a
// bolinha); busca na internet só pela Claude ou pelo OpenRouter; o escritor
// do canvas e a busca não herdam o padrão da empresa; cada skill com o seu
// modelo; e a resposta guarda as perguntas da MAVI.
import assert from "node:assert/strict";
import { createTestDatabase } from "./database-fixture.mjs";

const db = await createTestDatabase();
const uid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const [A, admin, manager, ana] = [1, 10, 11, 12].map(uid);
await db.query(`insert into auth.users select unnest($1::uuid[])`, [[admin, manager, ana]]);
await db.query(`insert into companies(id,name) values($1,'Make')`, [A]);
await db.query(
  `insert into memberships(company_id,user_id,name,role,active) values ($1,$2,'Ana Admin','admin',true),($1,$3,'Gil Gestor','manager',true),($1,$4,'Ana Souza','member',true)`,
  [A, admin, manager, ana],
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
const models = (...ids) => JSON.stringify(ids.map((id) => ({ id, input: 1, output: 5 })));
const provider = (name, kind, list) =>
  one(admin, "select public.ai_save_provider($1,null,$2,$3,null,$4::jsonb,'v1:abc','wxyz',true)", [A, name, kind, list]);
const feature = (user, provider, model, f) =>
  q(user, "select public.ai_set_route($1,'feature',null,$2,$3,$4)", [A, provider, model, f]);
const resolve = async (f) => {
  const r = await one(ana, "select public.ai_resolve_route($1,null,null,null,$2)", [A, f]);
  return r ? r.model : null;
};

const claude = await provider("Claude", "anthropic", models("claude-opus-5-5", "claude-sonnet-5-5"));
const router = await provider("OpenRouter", "openrouter", models("perplexity/sonar", "google/gemini-2.5-flash"));
const groq = await provider("Groq", "groq", models("llama-4"));

await check("a bolinha e o módulo: regras próprias; o módulo sem regra segue a bolinha", async () => {
  await q(admin, "select public.ai_set_route($1,'company',null,$2,'claude-opus-5-5')", [A, claude]);
  assert.equal(await resolve("mavi_page"), "claude-opus-5-5");
  await feature(manager, claude, "claude-sonnet-5-5", "assistant");
  assert.equal(await resolve("assistant"), "claude-sonnet-5-5");
  assert.equal(await resolve("mavi_page"), "claude-sonnet-5-5");
  await feature(manager, router, "google/gemini-2.5-flash", "mavi_page");
  assert.equal(await resolve("mavi_page"), "google/gemini-2.5-flash");
  assert.equal(await resolve("assistant"), "claude-sonnet-5-5");
  // A regra da pessoa vale para as duas.
  await q(admin, "select public.ai_set_route($1,'user',$2,$3,'claude-opus-5-5')", [A, ana, claude]);
  assert.equal(await resolve("mavi_page"), "claude-opus-5-5");
  await q(admin, "select public.ai_set_route($1,'user',$2,null,null)", [A, ana]);
});

await check("busca e escritor: não herdam a empresa; a busca só pela Claude ou pelo OpenRouter", async () => {
  assert.equal(await resolve("web_search"), null);
  assert.equal(await resolve("canvas_writer"), null);
  await assert.rejects(() => feature(manager, groq, "llama-4", "web_search"), /Claude \(Anthropic\) ou o OpenRouter/);
  await feature(manager, router, "perplexity/sonar", "web_search");
  await feature(manager, groq, "llama-4", "canvas_writer");
  assert.equal(await resolve("web_search"), "perplexity/sonar");
  assert.equal(await resolve("canvas_writer"), "llama-4");
  await assert.rejects(() => feature(ana, router, "perplexity/sonar", "web_search"), /Só administradores e gestores/);
});

await check("cada skill com o seu modelo; apagar a skill apaga a regra", async () => {
  const s = await one(
    manager,
    "select public.ai_skill_save($1,null,'relatorio','Relatório','Quando pedirem o relatório mensal.','Siga o modelo de relatório mensal do cliente.','[]'::jsonb,null,true)",
    [A],
  );
  assert.equal(await one(ana, "select public.ai_skill_route($1,$2)", [A, s.id]), null);
  await assert.rejects(
    () => q(manager, "select public.ai_set_route($1,'skill',$2,$3,'llama-4')", [A, uid(99), groq]),
    /Não encontrado na empresa/,
  );
  await q(manager, "select public.ai_set_route($1,'skill',$2,$3,'llama-4')", [A, s.id, groq]);
  const r = await one(ana, "select public.ai_skill_route($1,$2)", [A, s.id]);
  assert.deepEqual([r.scope, r.kind, r.model], ["skill", "groq", "llama-4"]);
  // A regra de skill não entra no resto da resolução.
  assert.equal(await resolve("assistant"), "claude-sonnet-5-5");
  await q(admin, "select public.ai_skill_delete($1)", [s.id]);
  await db.exec("reset role");
  assert.equal((await db.query("select count(*)::int n from mavi_private.ai_routes where scope_type = 'skill'")).rows[0].n, 0);
});

await check("a resposta guarda as perguntas da MAVI", async () => {
  const questions = [{ id: "question-01", ref: "Q1", type: "question", questions: [{ question: "Qual cliente?", options: ["4282", "4283"] }] }];
  const conv = await one(
    ana,
    "select public.ai_save_turn($1,null,'{}'::jsonb,'assistant','Relatório?','Antes, me diga:\n[[Q1]]','[]'::jsonb,'[]'::jsonb,$2::jsonb)",
    [A, JSON.stringify(questions)],
  );
  const [row] = await q(ana, "select artifacts from ai_messages where conversation_id=$1 and role='assistant'", [conv]);
  assert.equal(row.artifacts[0].type, "question");
});

console.log(`\n${passed} checks passed`);
