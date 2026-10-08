// MAVI · avaliação dinâmica (migrations 20270601090000_ai_eval_set e
// 20270617090000_ai_eval_dynamic): os registros de cada módulo (com login
// de membro ou o segredo do worker; um por minuto; 10 por módulo e 2 por
// pessoa; sigiloso pelo cliente; só pelo painel), os testes de um modelo
// (só líderes; provedor ligado e permitido; módulos escolhidos; sigilosos só
// nos provedores de dados sigilosos; um por modelo), o worker (segredo;
// registro inteiro e chave selada; vence/empata/perde, gasto; fecha no fim
// ou no teto), o detalhe, cancelar, a nota mais recente, a liberação no
// roteador e o teste semanal.
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

const one = (feature, n, extra = {}) => ({
  question: `Pergunta ${n}`,
  request: { instructions: "MAVI", context: "", messages: [{ role: "user", content: `Pergunta ${n}` }], tools: [],
    max_rounds: 0, effort: "low", max_tokens: 1000, calls: [{ name: "find_tasks", input: { n }, output: "ok" }] },
  answer: `Resposta ${n}`,
  model: "claude-sonnet-5",
  cost: 0.02,
  ms: 3000,
  rounds: 1,
  ...extra,
});
// Cada registro "aconteceu" há mais de um minuto (o banco aceita um por minuto em cada módulo).
const age = () => sql(`update ai_samples set created_at = created_at - interval '2 minutes'`);
const save = async (who, feature, n, { secret = null, client: k = null, company = A, extra } = {}) => {
  await as(who);
  await rpc("ai_sample_save", [secret, company, feature, k, JSON.stringify(one(feature, n, extra))]);
  await age();
};

await check("registros: login de membro ou segredo; um por minuto; só pelo painel", async () => {
  await as(null);
  await rejects(() => rpc("ai_sample_save", [null, A, "assistant", null, JSON.stringify(one("assistant", 0))]), /Sem permissão/);
  await as(admin);
  await rejects(() => rpc("ai_sample_save", [null, B, "assistant", null, JSON.stringify(one("assistant", 0))]), /Sem permissão/);
  await as(ana);
  await rpc("ai_sample_save", [null, A, "assistant", client, JSON.stringify(one("assistant", 1))]);
  // Outro no mesmo minuto: ignorado.
  await as(ana);
  await rpc("ai_sample_save", [null, A, "assistant", client, JSON.stringify(one("assistant", 2))]);
  await age();
  let rows = await sql(`select user_id, client_id, question, provider_name, model, chars from ai_samples`);
  assert.equal(rows.length, 1);
  assert.deepEqual([rows[0].user_id, rows[0].client_id, rows[0].question, rows[0].provider_name, rows[0].model],
    [ana, client, "Pergunta 1", "Servidor", "claude-sonnet-5"]);
  assert.ok(rows[0].chars > 100);
  // O worker, com o segredo: sem pessoa; o provedor da empresa vira o nome.
  await save(null, "client_radar", 1, { secret: SECRET, client, extra: { provider_id: prov.id } });
  rows = await sql(`select user_id, provider_name from ai_samples where feature = 'client_radar'`);
  assert.deepEqual([rows[0].user_id, rows[0].provider_name], [null, "OpenAI"]);
  // Inválidos: módulo, sem resposta, cliente de outra empresa.
  await as(null);
  await rpc("ai_sample_save", [SECRET, A, "Radar!", null, JSON.stringify(one("x", 1))]);
  await as(null);
  await rpc("ai_sample_save", [SECRET, A, "task_title", null, JSON.stringify(one("task_title", 1, { answer: " " }))]);
  assert.equal((await sql(`select count(*)::int n from ai_samples`))[0].n, 2);
  await as(ana);
  await rejects(() => db.query(`select * from ai_samples`), /permission denied/);
});

await check("registros: 10 por módulo e no máximo 2 da mesma pessoa; sigiloso pelo cliente", async () => {
  for (let n = 2; n <= 4; n++) await save(ana, "assistant", n);
  let rows = await sql(`select question from ai_samples where feature = 'assistant' order by created_at desc`);
  assert.deepEqual(rows.map((r) => r.question), ["Pergunta 4", "Pergunta 3"]);
  await save(manager, "assistant", 5);
  await save(admin, "assistant", 6);
  assert.equal((await sql(`select count(*)::int n from ai_samples where feature = 'assistant'`))[0].n, 4);
  for (let n = 2; n <= 12; n++) await save(null, "client_radar", n, { secret: SECRET });
  rows = await sql(`select question from ai_samples where feature = 'client_radar' order by created_at desc`);
  assert.equal(rows.length, 10);
  assert.equal(rows[0].question, "Pergunta 12");
  // Cliente sigiloso: o registro sai marcado.
  await sql(`insert into mavi_private.ai_router_scopes(company_id, scope_type, scope_id, sigiloso) values ($1, 'client', $2, true)`, [A, client]);
  await save(null, "client_temperature_text", 1, { secret: SECRET, client });
  await save(null, "client_temperature_text", 2, { secret: SECRET });
  rows = await sql(`select question, sigiloso from ai_samples where feature = 'client_temperature_text' order by question`);
  assert.deepEqual(rows.map((r) => [r.question, r.sigiloso]), [["Pergunta 1", true], ["Pergunta 2", false]]);
  await as(admin);
  const o = await rpc("ai_eval_overview", [A]);
  assert.deepEqual([...new Set(o.samples.map((x) => x.feature))].sort(), ["assistant", "client_radar", "client_temperature_text"]);
  assert.equal(o.samples.find((x) => x.feature === "client_radar").tools, 1);
  await as(ana);
  await rejects(() => rpc("ai_eval_overview", [A]), /Só administradores e gestores/);
});

let run;
await check("testar: só líderes; provedor ligado e permitido; módulos com registros; um por modelo", async () => {
  const start = (who, provider, model, cap, features) => as(who).then(() => rpc("ai_eval_run_start", [A, provider, model, cap, features]));
  await rejects(() => start(ana, prov.id, "gpt-5-mini", 1, ["assistant"]), /Só administradores e gestores/);
  await rejects(() => start(admin, other.id, "gpt-5-mini", 1, ["assistant"]), /provedor ligado/);
  await rejects(() => start(admin, prov.id, "gpt-4", 1, ["assistant"]), /provedor ligado/);
  await rejects(() => start(admin, null, "gpt-5", 1, ["assistant"]), /Claude do servidor/);
  await rejects(() => start(admin, prov.id, "gpt-5-mini", 100, ["assistant"]), /teto/);
  await rejects(() => start(admin, prov.id, "gpt-5-mini", 1, []), /pelo menos um módulo/);
  await rejects(() => start(admin, prov.id, "gpt-5-mini", 1, ["task_title"]), /Ainda não há registros/);
  // Provedores permitidos no Roteamento: os registros só vão para eles.
  await sql(`insert into mavi_private.ai_router_settings(company_id, providers) values ($1, array['00000000-0000-0000-0000-000000000000'::uuid])`, [A]);
  await rejects(() => start(admin, prov.id, "gpt-5-mini", 1, ["assistant"]), /não está entre os permitidos/);
  await sql(`update mavi_private.ai_router_settings set providers = null, secret_providers = array['00000000-0000-0000-0000-000000000000'::uuid] where company_id = $1`, [A]);
  run = await start(admin, prov.id, "gpt-5-mini", 0.05, ["assistant", "client_temperature_text"]);
  await rejects(() => start(admin, prov.id, "gpt-5-mini", 1, ["assistant"]), /já está em teste/);
  const [r] = await sql(`select status, kind, features, cases_total, provider_name from ai_eval_runs where id = $1`, [run]);
  // O registro do cliente sigiloso fica de fora (o OpenAI não é provedor de dados sigilosos).
  assert.deepEqual([r.status, r.kind, r.features, r.cases_total, r.provider_name],
    ["running", "dynamic", ["assistant", "client_temperature_text"], 5, "OpenAI"]);
  const snap = await sql(`select feature, question, reference, base_model, base_cost::float, base_ms from ai_eval_results where run_id = $1 order by feature, id limit 1`, [run]);
  assert.deepEqual(Object.values(snap[0]), ["assistant", "Pergunta 6", "Resposta 6", "claude-sonnet-5", 0.02, 3000]);
  // A Claude do servidor é provedor de dados sigilosos: entra o registro sigiloso.
  const srv = await start(admin, null, "claude-haiku-4-5", 1, ["client_temperature_text"]);
  assert.equal((await sql(`select cases_total from ai_eval_runs where id = $1`, [srv]))[0].cases_total, 2);
  await as(admin);
  await rpc("ai_eval_run_cancel", [A, srv]);
});

await check("os registros que um teste ainda vai usar não saem da fila", async () => {
  const before = (await sql(`select count(*)::int n from ai_samples where feature = 'assistant'`))[0].n;
  await save(manager, "assistant", 7);
  await save(manager, "assistant", 8);
  // A Gabi já tinha um (o 5): o mais antigo dela sairia, mas está no teste.
  assert.equal((await sql(`select count(*)::int n from ai_samples where feature = 'assistant'`))[0].n, before + 2);
});

await check("worker: segredo; o registro inteiro e a chave selada; vence/empata/perde; gasto; fecha no teto", async () => {
  await as(null);
  await rejects(() => rpc("ai_eval_claim", ["errado", 3]), /Sem permissão/);
  await as(null);
  const items = await rpc("ai_eval_claim", [SECRET, 1]);
  assert.equal(items.length, 1);
  const it = items[0];
  assert.equal(it.model, "gpt-5-mini");
  assert.deepEqual([it.provider.kind, it.provider.key_cipher, it.provider.price.id], ["openai", "v1:k", "gpt-5-mini"]);
  assert.equal(it.sample.feature, "assistant");
  assert.deepEqual(it.sample.request.calls, [{ name: "find_tasks", input: { n: 6 }, output: "ok" }]);
  assert.equal(it.sample.answer, "Resposta 6");
  await as(null);
  await rejects(() => rpc("ai_eval_store", [SECRET, it.id, "x", "draw", "", 1, "[]"]), /Resultado inválido/);
  await as(null);
  await rpc("ai_eval_store", [SECRET, it.id, "Resposta do modelo", "tie", "Iguais.", 1200,
    JSON.stringify([{ model: "gpt-5-mini", input: 100, output: 20, cost: 0.04, provider_id: prov.id, provider: "OpenAI" },
      { model: "claude-sonnet-5", input: 300, output: 40, cost: 0.02 }])]);
  // Gastou mais que o teto (0,05): o próximo pedido fecha o teste e pula o que faltava.
  await as(null);
  assert.deepEqual(await rpc("ai_eval_claim", [SECRET, 3]), []);
  const [r] = await sql(`select status, cases_done, cases_failed, score::float, passed, wins, ties, losses, avg_ms, cost_usd::float from ai_eval_runs where id = $1`, [run]);
  assert.deepEqual(Object.values(r), ["done", 1, 4, 1, 1, 0, 1, 0, 1200, 0.06]);
  const [x] = await sql(`select outcome, answer_cost::float, score::float, passed from ai_eval_results where id = $1`, [it.id]);
  assert.deepEqual(Object.values(x), ["tie", 0.04, 1, true]);
  assert.equal((await sql(`select count(*)::int n from ai_usage where kind = 'eval_set'`))[0].n, 2);
});

let run2;
await check("detalhe (as derrotas primeiro), o registro que saiu da fila, cancelar e a nota mais recente", async () => {
  await as(admin);
  run2 = await rpc("ai_eval_run_start", [A, null, "claude-haiku-4-5", 1, ["client_temperature_text"]]);
  await as(null);
  const items = await rpc("ai_eval_claim", [SECRET, 3]);
  assert.equal(items.length, 2);
  assert.equal(items[0].provider, null);
  await as(null);
  await rpc("ai_eval_store", [SECRET, items[0].id, "ok", "win", "Mais completa.", 900, "[]"]);
  await as(null);
  await rpc("ai_eval_store", [SECRET, items[1].id, "ruim", "loss", "Faltou o prazo.", 800, "[]"]);
  await as(admin);
  const detail = await rpc("ai_eval_run_detail", [A, run2]);
  assert.deepEqual(detail.map((d) => d.outcome), ["loss", "win"]);
  assert.equal(detail[0].reference.startsWith("Resposta"), true);
  const [r2] = await sql(`select status, score::float, passed, wins, losses from ai_eval_runs where id = $1`, [run2]);
  assert.deepEqual(Object.values(r2), ["done", 0.5, 1, 1, 1]);
  // Um registro que saiu antes de o worker pegar: pulado.
  await as(admin);
  const run3 = await rpc("ai_eval_run_start", [A, null, "claude-sonnet-5", 1, ["client_radar"]]);
  await sql(`delete from ai_samples where id = (select sample_id from ai_eval_results where run_id = $1 order by id limit 1)`, [run3]);
  await as(null);
  const left = await rpc("ai_eval_claim", [SECRET, 6]);
  // Dos 6 pegos, o que saiu da fila não vai para o worker.
  assert.equal(left.length, 5);
  assert.equal((await sql(`select count(*)::int n from ai_eval_results where run_id = $1 and status = 'skipped' and last_error = 'o registro saiu da fila'`, [run3]))[0].n, 1);
  await as(admin);
  await rpc("ai_eval_run_cancel", [A, run3]);
  const [r3] = await sql(`select status, cases_failed from ai_eval_runs where id = $1`, [run3]);
  assert.deepEqual([r3.status, r3.cases_failed], ["cancelled", 10]);
  await as(admin);
  const o = await rpc("ai_eval_overview", [A]);
  assert.deepEqual(o.latest.map((l) => [l.model, Number(l.score)]).sort(), [["claude-haiku-4-5", 0.5], ["gpt-5-mini", 1]]);
  const listed = o.runs.find((x) => x.id === run2);
  assert.deepEqual([listed.wins, listed.ties, listed.losses, Number(listed.base_cost), listed.base_ms], [1, 0, 1, 0.04, 3000]);
});

await check("liberação: só líderes; histórico; o roteador recebe só os aprovados com a nota mínima", async () => {
  // Um teste antigo do conjunto à mão não conta.
  await sql(`insert into ai_eval_runs(company_id, provider_id, provider_name, model, status, cases_total, cases_done, score, cap_usd, finished_at)
    values ($1, null, 'Servidor', 'claude-opus-5', 'done', 1, 1, 1, 1, now())`, [A]);
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
  assert.ok(["gate_enabled", "gate_min"].every((f) => log.some((l) => l.field === f)));
});

await check("teste semanal: só líderes salvam; até 3 modelos, os testados há mais tempo; desligado não testa", async () => {
  await as(ana);
  await rejects(() => rpc("ai_eval_settings_save", [A, true, 1]), /Só administradores e gestores/);
  await as(admin);
  await rejects(() => rpc("ai_eval_settings_save", [A, true, 50]), /teto por modelo/);
  await as(admin);
  await rpc("ai_eval_settings_save", [A, true, 0.5]);
  await as(admin);
  assert.deepEqual((await rpc("ai_eval_overview", [A])).settings, { weekly: true, weekly_cap: 0.5 });
  // A lista do roteador: o gpt-5-mini (testado), a Haiku (testada) e duas Claudes nunca testadas.
  const zero = "00000000-0000-0000-0000-000000000000";
  await sql(`update mavi_private.ai_router_settings set route_models = $2 where company_id = $1`,
    [A, [`${prov.id}|gpt-5-mini`, `${zero}|claude-haiku-4-5`, `${zero}|claude-opus-5`, `${zero}|claude-sonnet-4-6`]]);
  await sql(`update ai_eval_runs set status = 'done' where status = 'running'`);
  const n = (await sql(`select mavi_private.ai_eval_weekly() as n`))[0].n;
  assert.equal(n, 3);
  const runs = await sql(`select model, auto, cap_usd::float, features from ai_eval_runs where auto order by model`);
  assert.deepEqual(runs.map((r) => r.model), ["claude-opus-5", "claude-sonnet-4-6", "gpt-5-mini"]);
  assert.deepEqual([runs[0].cap_usd, runs[0].features], [0.5, ["assistant", "client_radar", "client_temperature_text"]]);
  await as(admin);
  await rpc("ai_eval_settings_save", [A, false, 0.5]);
  await sql(`update ai_eval_runs set status = 'done' where status = 'running'`);
  assert.equal((await sql(`select mavi_private.ai_eval_weekly() as n`))[0].n, 0);
});

console.log(`\n${passed} verificações da avaliação dinâmica passaram.`);
