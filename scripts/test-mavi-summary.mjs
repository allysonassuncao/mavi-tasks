// MAVI · conversas longas e reordenação (migration 20261222090000_mavi_cache_summary):
// o resumo acumulado só avança e só quem começou a conversa grava; as
// funcionalidades novas em "Quem usa qual modelo" ('conversation_summary'
// herda o padrão da empresa; 'mavi_rerank' não).
import assert from "node:assert/strict";
import { createTestDatabase } from "./database-fixture.mjs";

const db = await createTestDatabase();
const uid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const [A, admin, ana, bia] = [1, 10, 12, 13].map(uid);
await db.query(`insert into auth.users select unnest($1::uuid[])`, [[admin, ana, bia]]);
await db.query(`insert into companies(id,name) values($1,'Make')`, [A]);
await db.query(
  `insert into memberships(company_id,user_id,name,role,active) values ($1,$2,'Ana Admin','admin',true),($1,$3,'Ana Souza','member',true),($1,$4,'Bia Lima','member',true)`,
  [A, admin, ana, bia],
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
const turn = (user, conv, text) =>
  one(user, "select public.ai_save_turn($1,$2,'{}'::jsonb,'assistant',$3,'Resposta','[]'::jsonb,'[]'::jsonb)", [A, conv, text]);

await check("o resumo: só quem começou grava, só avança, e fica na conversa", async () => {
  const conv = await turn(ana, null, "Primeira pergunta");
  await turn(ana, conv, "Segunda pergunta");
  const ids = (await q(ana, "select id from ai_messages where conversation_id = $1 order by id", [conv])).map((r) => r.id);
  const summary = "Resumo: a Ana pediu o relatório de setembro do cliente 4282 e combinou o envio na sexta.";
  assert.equal(await one(ana, "select public.ai_conversation_summary_save($1,$2,$3)", [conv, summary, ids[1]]), true);
  await assert.rejects(() => q(bia, "select public.ai_conversation_summary_save($1,$2,$3)", [conv, summary, ids[1]]), /não encontrada/);
  await assert.rejects(() => q(ana, "select public.ai_conversation_summary_save($1,'curto',$2)", [conv, ids[1]]), /Resumo vazio/);
  await assert.rejects(() => q(ana, "select public.ai_conversation_summary_save($1,$2,999999)", [conv, summary]), /fora da conversa/);
  // Um resumo mais antigo (de uma resposta atrasada) não volta atrás.
  assert.equal(await one(ana, "select public.ai_conversation_summary_save($1,$2,$3)", [conv, `${summary} (velho)`, ids[0]]), false);
  const [row] = await q(ana, "select summary, summary_upto from ai_conversations where id = $1", [conv]);
  assert.equal(row.summary, summary);
  assert.equal(Number(row.summary_upto), Number(ids[1]));
});

await check("quem resume segue a empresa; a reordenação só com modelo escolhido", async () => {
  const models = JSON.stringify([{ id: "claude-opus-5-5", input: 5, output: 25 }, { id: "claude-haiku-4-5", input: 1, output: 5 }]);
  const provider = await one(admin, "select public.ai_save_provider($1,null,'Claude','anthropic',null,$2::jsonb,'v1:abc','wxyz',true)", [A, models]);
  await q(admin, "select public.ai_set_route($1,'company',null,$2,'claude-opus-5-5')", [A, provider]);
  const resolve = async (f) => (await one(ana, "select public.ai_resolve_route($1,null,null,null,$2)", [A, f]))?.model ?? null;
  assert.equal(await resolve("conversation_summary"), "claude-opus-5-5");
  assert.equal(await resolve("mavi_rerank"), null);
  await q(admin, "select public.ai_set_route($1,'feature',null,$2,'claude-haiku-4-5','mavi_rerank')", [A, provider]);
  await q(admin, "select public.ai_set_route($1,'feature',null,$2,'claude-haiku-4-5','conversation_summary')", [A, provider]);
  assert.equal(await resolve("mavi_rerank"), "claude-haiku-4-5");
  assert.equal(await resolve("conversation_summary"), "claude-haiku-4-5");
  await assert.rejects(() => q(ana, "select public.ai_set_route($1,'feature',null,$2,'claude-haiku-4-5','mavi_rerank')", [A, provider]), /Só administradores e gestores/);
  await assert.rejects(() => q(admin, "select public.ai_set_route($1,'feature',null,$2,'claude-haiku-4-5','inventada')", [A, provider]), /inválida/);
  // O validador e o assistente das skills (20261227090000): sem regra, o padrão da empresa.
  assert.equal(await resolve("skill_coach"), "claude-opus-5-5");
  await q(admin, "select public.ai_set_route($1,'feature',null,$2,'claude-haiku-4-5','skill_coach')", [A, provider]);
  assert.equal(await resolve("skill_coach"), "claude-haiku-4-5");
});

await check("o Consumo mostra os tokens lidos e gravados no cache", async () => {
  await q(ana, "select public.ai_log_usage($1,'assistant','ask',null,null,null,null,'claude-opus-5-5',1000,200,9000,500,0,0.05)", [A]);
  const r = await one(admin, "select public.ai_usage_report($1, current_date - 1, current_date + 1)", [A]);
  assert.deepEqual([Number(r.total.input_tokens), Number(r.total.cache_read_tokens), Number(r.total.cache_write_tokens)], [1000, 9000, 500]);
  assert.equal(Number(r.by_model[0].cache_read_tokens), 9000);
});

console.log(`\n${passed} checks passed`);
