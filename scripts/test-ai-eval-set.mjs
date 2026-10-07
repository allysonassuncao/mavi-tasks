// MAVI · roteador de modelos, fase 5 (migration 20270601090000_ai_eval_set):
// o conjunto de avaliação (só líderes; casos à mão e a partir de respostas
// com 👍, com o material congelado e sem repetir), os testes de um modelo
// (provedor ligado ou Claude do servidor, teto, um por modelo, até 100
// casos), o worker (segredo; material, chave selada; nota, aprovado com 0,7,
// gasto, tipo de pedido; fecha o teste no fim ou no teto), cancelar, o
// detalhe e a liberação no roteador (só modelos com a nota mínima).
import assert from "node:assert/strict";
import { createTestDatabase } from "./database-fixture.mjs";

const db = await createTestDatabase();
const uid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const SECRET = "s".repeat(40);
const [A, B, admin, ana, manager] = [1, 2, 10, 11, 13].map(uid);
await db.query(`insert into auth.users select unnest($1::uuid[])`, [[admin, ana, manager]]);
await db.query(`insert into companies(id,name) values($1,'Make'),($2,'Outra')`, [A, B]);
await db.query(
  `insert into memberships(company_id,user_id,name,role,active) values
   ($1,$2,'Ana Admin','admin',true),($1,$3,'Ana Equipe','member',true),($1,$4,'Gabi Gestora','manager',true)`,
  [A, admin, ana, manager],
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
await sql(`insert into mavi_private.ai_config(url, secret) values('https://app.example/api/ai', $1)`, [SECRET]);
const [prov] = await sql(
  `insert into mavi_private.ai_providers(company_id,name,kind,key_cipher,models) values
   ($1,'OpenAI','openai','v1:k','[{"id":"gpt-5-mini","input":0.25,"output":2}]') returning id`,
  [A],
);
const [other] = await sql(`insert into mavi_private.ai_providers(company_id,name,kind,key_cipher,models) values
  ($1,'Deles','openai','v1:z','[{"id":"gpt-5-mini","input":1,"output":1}]') returning id`, [B]);
await as(admin);
const team = await rpc("create_team", [A, "Equipe A", [ana]]);
const client = await rpc("create_client", [A, "5022", "", [team]]);

let manual;
await check("casos à mão: só líderes; pergunta e referência obrigatórias; editar refaz o tipo de pedido", async () => {
  await as(ana);
  await rejects(() => rpc("ai_eval_case_save", [A, null, "Qual o prazo?", "Sexta", null, null, true]), /Só administradores e gestores/);
  await as(admin);
  await rejects(() => rpc("ai_eval_case_save", [A, null, "", "Sexta", null, null, true]), /Escreva a pergunta/);
  await as(admin);
  await rejects(() => rpc("ai_eval_case_save", [A, null, "Qual o prazo?", " ", null, null, true]), /referência/);
  await as(manager);
  manual = await rpc("ai_eval_case_save", [A, null, "Qual o prazo do relatório?", "Toda sexta, até 18h.", client, "Combinado em 02/09: relatório às sextas.", true]);
  await sql(`update ai_eval_cases set task_type = 'consulta' where id = $1`, [manual]);
  await as(manager);
  await rpc("ai_eval_case_save", [A, manual, "Qual o prazo do relatório?", "Sexta, 18h.", client, "x", true]);
  assert.equal((await sql(`select task_type from ai_eval_cases where id = $1`, [manual]))[0].task_type, "consulta");
  await as(manager);
  await rpc("ai_eval_case_save", [A, manual, "Quando sai o relatório?", "Sexta, 18h.", client, "x", true]);
  assert.equal((await sql(`select task_type from ai_eval_cases where id = $1`, [manual]))[0].task_type, null);
});

let fromAnswer, message;
await check("a partir de uma resposta com 👍: sugestão, material congelado, sem repetir", async () => {
  await as(ana);
  const conv = await rpc("ai_save_turn", [A, null, JSON.stringify({ client }), "assistant", "Quem aprova as artes?", "A Bia aprova.", "[]", "[]"]);
  [{ id: message }] = await sql(`select id from ai_messages where conversation_id = $1 and role = 'assistant'`, [conv]);
  message = Number(message);
  await as(ana);
  await rpc("mavi_feedback_vote", [message, "up", null, null]);
  await as(admin);
  let o = await rpc("ai_eval_overview", [A]);
  assert.deepEqual(o.suggestions.map((s) => [s.message, s.question]), [[message, "Quem aprova as artes?"]]);
  await as(admin);
  fromAnswer = await rpc("ai_eval_case_from_message", [A, message]);
  await as(admin);
  assert.equal(await rpc("ai_eval_case_from_message", [A, message]), fromAnswer);
  const [c] = await sql(`select question, reference, origin, client_id, material from ai_eval_cases where id = $1`, [fromAnswer]);
  assert.deepEqual([c.question, c.reference, c.origin, c.client_id], ["Quem aprova as artes?", "A Bia aprova.", "answer", client]);
  assert.equal(c.material.client, "5022");
  await as(admin);
  o = await rpc("ai_eval_overview", [A]);
  assert.equal(o.suggestions.length, 0);
  assert.equal(o.cases.length, 2);
  await as(ana);
  await rejects(() => rpc("ai_eval_overview", [A]), /Só administradores e gestores/);
  await as(ana);
  assert.equal((await db.query(`select 1 from ai_eval_cases`)).rows.length, 0);
});

let run;
await check("testar: provedor ligado ou Claude do servidor; teto; um teste por modelo; casos ativos", async () => {
  await as(ana);
  await rejects(() => rpc("ai_eval_run_start", [A, prov.id, "gpt-5-mini", 1]), /Só administradores e gestores/);
  await as(admin);
  await rejects(() => rpc("ai_eval_run_start", [A, other.id, "gpt-5-mini", 1]), /provedor ligado/);
  await as(admin);
  await rejects(() => rpc("ai_eval_run_start", [A, prov.id, "gpt-4", 1]), /provedor ligado/);
  await as(admin);
  await rejects(() => rpc("ai_eval_run_start", [A, null, "gpt-5", 1]), /Claude do servidor/);
  await as(admin);
  await rejects(() => rpc("ai_eval_run_start", [A, prov.id, "gpt-5-mini", 100]), /teto/);
  await as(admin);
  run = await rpc("ai_eval_run_start", [A, prov.id, "gpt-5-mini", 0.05]);
  await as(admin);
  await rejects(() => rpc("ai_eval_run_start", [A, prov.id, "gpt-5-mini", 1]), /já está em teste/);
  const [r] = await sql(`select status, cases_total, provider_name from ai_eval_runs where id = $1`, [run]);
  assert.deepEqual([r.status, r.cases_total, r.provider_name], ["running", 2, "OpenAI"]);
  await sql(`update ai_eval_cases set active = false where company_id = $1`, [A]);
  await as(admin);
  await rejects(() => rpc("ai_eval_run_start", [A, null, "claude-haiku-4-5", 1]), /Ative pelo menos um caso/);
  await sql(`update ai_eval_cases set active = true where company_id = $1`, [A]);
});

await check("worker: segredo; caso com material e chave selada; nota, aprovado, gasto e tipo; fecha no teto", async () => {
  await as(null);
  await rejects(() => rpc("ai_eval_claim", ["errado", 3]), /Sem permissão/);
  await as(null);
  const items = await rpc("ai_eval_claim", [SECRET, 1]);
  assert.equal(items.length, 1);
  const it = items[0];
  assert.equal(it.model, "gpt-5-mini");
  assert.deepEqual([it.provider.kind, it.provider.key_cipher, it.provider.price.id], ["openai", "v1:k", "gpt-5-mini"]);
  assert.ok(it.case.question);
  await as(null);
  await rpc("ai_eval_store", [SECRET, it.id, "Resposta do modelo", 0.9, "Atendeu.", 1200, "consulta",
    JSON.stringify([{ model: "gpt-5-mini", input: 100, output: 20, cost: 0.06, provider_id: prov.id, provider: "OpenAI" }])]);
  // Gastou mais que o teto (0,05): o próximo pedido fecha o teste e pula o que faltava.
  await as(null);
  assert.deepEqual(await rpc("ai_eval_claim", [SECRET, 3]), []);
  const [r] = await sql(`select status, cases_done, cases_failed, score, passed, avg_ms, cost_usd from ai_eval_runs where id = $1`, [run]);
  assert.deepEqual([r.status, r.cases_done, r.cases_failed, Number(r.score), r.passed, r.avg_ms, Number(r.cost_usd)],
    ["done", 1, 1, 0.9, 1, 1200, 0.06]);
  const types = await sql(`select task_type from ai_eval_cases where task_type is not null`);
  assert.equal(types.length, 1);
  assert.equal((await sql(`select count(*)::int n from ai_usage where kind = 'eval_set'`))[0].n, 1);
});

await check("detalhe (os que não passaram primeiro), cancelar e a nota mais recente", async () => {
  await as(admin);
  const run2 = await rpc("ai_eval_run_start", [A, null, "claude-haiku-4-5", 1]);
  await as(null);
  const items = await rpc("ai_eval_claim", [SECRET, 3]);
  assert.equal(items.length, 2);
  assert.equal(items[0].provider, null);
  await as(null);
  await rpc("ai_eval_store", [SECRET, items[0].id, "ok", 0.95, "Bom.", 900, "consulta", "[]"]);
  await as(null);
  await rpc("ai_eval_store", [SECRET, items[1].id, "ruim", 0.4, "Faltou o prazo.", 800, "consulta", "[]"]);
  await as(admin);
  const detail = await rpc("ai_eval_run_detail", [A, run2]);
  assert.deepEqual(detail.map((d) => [Number(d.score), d.passed]), [[0.4, false], [0.95, true]]);
  const [r2] = await sql(`select status, score, passed from ai_eval_runs where id = $1`, [run2]);
  assert.deepEqual([r2.status, Number(r2.score), r2.passed], ["done", 0.675, 1]);
  // Cancelar: o que faltava fica pulado.
  await as(admin);
  const run3 = await rpc("ai_eval_run_start", [A, null, "claude-sonnet-5", 1]);
  await as(admin);
  await rpc("ai_eval_run_cancel", [A, run3]);
  const [r3] = await sql(`select status, cases_failed from ai_eval_runs where id = $1`, [run3]);
  assert.deepEqual([r3.status, r3.cases_failed], ["cancelled", 2]);
  await as(admin);
  const o = await rpc("ai_eval_overview", [A]);
  assert.deepEqual(o.latest.map((l) => [l.model, Number(l.score)]).sort(), [["claude-haiku-4-5", 0.675], ["gpt-5-mini", 0.9]]);
  assert.equal(o.runs.length, 3);
});

await check("liberação: só líderes; histórico; o roteador recebe só os aprovados com a nota mínima", async () => {
  await as(ana);
  let ctx = await rpc("ai_route_context", [A, null, null, null, "page"]);
  assert.deepEqual([ctx.gate, ctx.approved], [false, []]);
  await as(ana);
  await rejects(() => rpc("ai_router_save", [A, JSON.stringify({ gate_enabled: true })]), /Só administradores e gestores/);
  await as(admin);
  await rejects(() => rpc("ai_router_save", [A, JSON.stringify({ gate_min: 0.1 })]), /check/);
  await as(admin);
  await rpc("ai_router_save", [A, JSON.stringify({ gate_enabled: true, gate_min: 0.85 })]);
  await as(ana);
  ctx = await rpc("ai_route_context", [A, null, null, null, "page"]);
  assert.equal(ctx.gate, true);
  assert.deepEqual(ctx.approved, [{ provider_id: prov.id, model: "gpt-5-mini" }]);
  await as(admin);
  const log = (await rpc("ai_settings_log", [A, "router", null, null, null, null, null, null, 50])).items;
  assert.deepEqual(log.map((l) => l.field).sort(), ["gate_enabled", "gate_min"]);
  await as(admin);
  const g = await rpc("ai_router_get", [A]);
  assert.deepEqual([g.gate_enabled, Number(g.gate_min)], [true, 0.85]);
});

await check("excluir caso: só líderes; o resultado do teste fica sem o caso", async () => {
  await as(ana);
  await rejects(() => rpc("ai_eval_case_delete", [A, manual]), /Só administradores e gestores/);
  await as(admin);
  await rpc("ai_eval_case_delete", [A, manual]);
  assert.equal((await sql(`select count(*)::int n from ai_eval_cases where id = $1`, [manual]))[0].n, 0);
  assert.ok((await sql(`select count(*)::int n from ai_eval_results where case_id is null`))[0].n >= 1);
});

console.log(`\n${passed} verificações do conjunto de avaliação passaram.`);
