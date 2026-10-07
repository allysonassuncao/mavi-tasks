// MAVI · roteador de modelos, fase 4 (migration 20270531090000_ai_router_learning):
// a configuração do aprendizado (só líderes, com histórico), a amostra para
// a autoavaliação (só a resposta de quem pergunta, no sorteio e até 30% do
// limite do juiz), os testes fora do ar (entram pelo registro do roteador,
// o worker pega com o material e a chave selada do candidato, grava o
// veredito e o gasto, respeita o teto do dia), o ranking interno (respostas
// boas + testes, nota suavizada) na política de cada pergunta, e os tipos de
// pedido em que a pessoa teve respostas ruins há pouco.
import assert from "node:assert/strict";
import { createTestDatabase } from "./database-fixture.mjs";

const db = await createTestDatabase();
const uid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const SECRET = "s".repeat(40);
const [A, admin, ana, bia] = [1, 10, 11, 12].map(uid);
await db.query(`insert into auth.users select unnest($1::uuid[])`, [[admin, ana, bia]]);
await db.query(`insert into companies(id,name) values($1,'Make')`, [A]);
await db.query(
  `insert into memberships(company_id,user_id,name,role,active) values
   ($1,$2,'Ana Admin','admin',true),($1,$3,'Ana Equipe','member',true),($1,$4,'Bia Equipe','member',true)`,
  [A, admin, ana, bia],
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
async function turn(user, q = "Qual o e-mail do cliente?", a = "contato@x.com") {
  await as(user);
  const conv = await rpc("ai_save_turn", [A, null, "{}", "assistant", q, a, "[]", "[]"]);
  const [m] = await sql(`select id from ai_messages where conversation_id = $1 and role = 'assistant'`, [conv]);
  return { conv, message: Number(m.id) };
}
const entry = (t, over = {}) =>
  JSON.stringify({
    surface: "page", feature: "mavi_page", task_type: "consulta", complexity: 1, mode: "auto",
    conversation_id: t.conv, message_id: t.message, used_model: "claude-opus-5-5", total_ms: 3000, cost_usd: 0.03,
    eval_candidate: { provider_id: prov.id, model: "gpt-5-mini" }, ...over,
  });

await check("configuração do aprendizado: padrões, só líderes salvam, histórico", async () => {
  await as(admin);
  const g = await rpc("ai_router_get", [A]);
  assert.deepEqual([Number(g.judge_sample), g.eval_enabled, Number(g.eval_rate), Number(g.eval_daily_cap)], [0.1, true, 0.2, 0.5]);
  await as(ana);
  await rejects(() => rpc("ai_router_save", [A, JSON.stringify({ eval_rate: 1 })]), /Só administradores e gestores/);
  await as(admin);
  await rejects(() => rpc("ai_router_save", [A, JSON.stringify({ judge_sample: 0.9 })]), /check/);
  await as(admin);
  await rpc("ai_router_save", [A, JSON.stringify({ judge_sample: 0.5, eval_rate: 1, eval_daily_cap: 0.05 })]);
  await as(admin);
  const log = (await rpc("ai_settings_log", [A, "router", null, null, null, null, null, null, 50])).items;
  assert.deepEqual(log.map((l) => l.field).sort(), ["eval_daily_cap", "eval_rate", "judge_sample"]);
  assert.deepEqual(log.find((l) => l.field === "eval_rate").new, { eval_rate: 1 });
});

await check("amostra: só a resposta de quem pergunta; no sorteio; até 30% do limite do juiz", async () => {
  const mine = await turn(ana);
  await as(bia);
  await rejects(() => rpc("mavi_answer_sample", [mine.message]), /Resposta não encontrada/);
  // Metade sorteada, até 12 por dia (30% de 40).
  let yes = 0;
  for (let i = 0; i < 40; i++) {
    const t = await turn(ana, `Pergunta ${i}`);
    await as(ana);
    if (await rpc("mavi_answer_sample", [t.message])) yes++;
  }
  assert.ok(yes >= 1 && yes <= 12, `sorteadas: ${yes}`);
  const [k] = await sql(`select count(*)::int n from mavi_answer_checks where 'sample' = any(signals)`);
  assert.equal(k.n, yes);
  // Desligada (0): nada entra.
  await as(admin);
  await rpc("ai_router_save", [A, JSON.stringify({ judge_sample: 0 })]);
  const t = await turn(ana);
  await as(ana);
  assert.equal(await rpc("mavi_answer_sample", [t.message]), false);
});

let evalId;
await check("testes fora do ar: entram pelo registro; sem candidato, igual ao usado ou com falha, não", async () => {
  const t1 = await turn(ana);
  await as(ana);
  await rpc("ai_route_log", [A, entry(t1)]);
  const t2 = await turn(ana);
  await as(ana);
  await rpc("ai_route_log", [A, entry(t2, { eval_candidate: { provider_id: null, model: "claude-opus-5-5" } })]);
  const t3 = await turn(ana);
  await as(ana);
  await rpc("ai_route_log", [A, entry(t3, { error: "caiu" })]);
  await as(ana);
  await rpc("ai_route_log", [A, entry(t3, { conversation_id: null, message_id: null })]);
  const evals = await sql(`select * from ai_route_evals order by id`);
  assert.equal(evals.length, 1);
  assert.deepEqual([Number(evals[0].message_id), evals[0].candidate_model, evals[0].base_model, evals[0].status],
    [t1.message, "gpt-5-mini", "claude-opus-5-5", "pending"]);
  evalId = Number(evals[0].id);
  // Provedor de fora no candidato: recusa.
  await as(ana);
  await rejects(() => rpc("ai_route_log", [A, entry(t1, { eval_candidate: { provider_id: uid(99), model: "x" } })]), /Provedor inválido/);
});

await check("worker: espera 2 minutos; pega com o material e a chave selada; grava veredito e gasto; teto do dia", async () => {
  await as(null);
  assert.deepEqual(await rpc("ai_route_eval_claim", [SECRET, 2]), []);
  await sql(`update ai_route_evals set created_at = now() - interval '3 minutes'`);
  await as(null);
  await rejects(() => rpc("ai_route_eval_claim", ["errado", 2]), /Sem permissão/);
  await as(null);
  const [item] = await rpc("ai_route_eval_claim", [SECRET, 2]);
  assert.equal(item.id, evalId);
  assert.equal(item.material.question, "Qual o e-mail do cliente?");
  assert.equal(item.material.answer, "contato@x.com");
  assert.deepEqual([item.candidate.kind, item.candidate.key_cipher, item.candidate.price.id], ["openai", "v1:k", "gpt-5-mini"]);
  await as(null);
  assert.deepEqual(await rpc("ai_route_eval_claim", [SECRET, 2]), []);
  await as(null);
  await rpc("ai_route_eval_store", [SECRET, evalId, "É contato@x.com.", "same", 0.8, "Mesma informação.",
    JSON.stringify([{ model: "gpt-5-mini", input: 100, output: 20, cost: 0.03, provider_id: prov.id, provider: "OpenAI" },
      { model: "claude-sonnet-5", input: 300, output: 50, cost: 0.03 }])]);
  const [e] = await sql(`select status, verdict, cost_usd from ai_route_evals where id = $1`, [evalId]);
  assert.deepEqual([e.status, e.verdict, Number(e.cost_usd)], ["done", "same", 0.06]);
  const usage = await sql(`select kind, model from ai_usage where kind = 'route_eval' order by id`);
  assert.equal(usage.length, 2);
  // Gastou mais que o teto (0,05): os próximos esperam o dia seguinte.
  const t = await turn(ana);
  await as(ana);
  await rpc("ai_route_log", [A, entry(t)]);
  await sql(`update ai_route_evals set created_at = now() - interval '3 minutes' where status = 'pending'`);
  await as(null);
  assert.deepEqual(await rpc("ai_route_eval_claim", [SECRET, 2]), []);
});

await check("ranking: respostas boas e testes, nota suavizada; entra na política; pessoa com respostas ruins sobe", async () => {
  await sql(`delete from ai_route_decisions`);
  // 8 consultas boas com o Opus e 2 ruins (👎 e ferramenta com erro).
  for (let i = 0; i < 10; i++) {
    const t = await turn(ana, `Consulta ${i}`);
    await as(ana);
    await rpc("ai_route_log", [A, entry(t, { eval_candidate: null, tools_failed: i === 9 ? 1 : 0 })]);
    if (i === 8) {
      await as(ana);
      await rpc("mavi_feedback_vote", [t.message, "down", "wrong", ""]);
    }
  }
  await sql(`select mavi_private.ai_route_rank_refresh()`);
  const rank = await sql(`select task_type, model, live_n, live_good, eval_n, eval_ok, quality from mavi_private.ai_route_rank order by model`);
  const opus = rank.find((r) => r.model === "claude-opus-5-5");
  assert.deepEqual([opus.live_n, opus.live_good], [10, 8]);
  assert.equal(Number(opus.quality), Math.round(((8 + 0.85 * 5) / 15) * 1000) / 1000);
  const mini = rank.find((r) => r.model === "gpt-5-mini");
  assert.deepEqual([mini.eval_n, mini.eval_ok, Number(mini.quality)], [1, 1, Math.round(((1 + 0.85 * 5) / 6) * 1000) / 1000]);
  await as(bia);
  const ctx = await rpc("ai_route_context", [A, null, null, null, "page"]);
  // Só com 5 ou mais respostas: o mini (1 teste) fica de fora.
  assert.deepEqual(ctx.stats.map((s) => [s.task_type, s.model, s.n]), [["consulta", "claude-opus-5-5", 10]]);
  assert.deepEqual(ctx.person_bad, []);
  // A Bia teve duas respostas ruins em análises: sobe nesse tipo.
  for (let i = 0; i < 2; i++) {
    const t = await turn(bia, `Análise ${i}`);
    await as(bia);
    await rpc("ai_route_log", [A, entry(t, { task_type: "analise", eval_candidate: null })]);
    await as(bia);
    await rpc("mavi_feedback_vote", [t.message, "down", "incomplete", ""]);
  }
  await as(bia);
  assert.deepEqual((await rpc("ai_route_context", [A, null, null, null, "page"])).person_bad, ["analise"]);
  await as(ana);
  assert.deepEqual((await rpc("ai_route_context", [A, null, null, null, "page"])).person_bad, []);
});

await check("painel: ranking, testes e gasto só para líderes; atualizar agora", async () => {
  await as(ana);
  await rejects(() => rpc("ai_route_learning", [A]), /Só administradores e gestores/);
  await as(ana);
  await rejects(() => rpc("ai_route_rank_now", [A]), /Só administradores e gestores/);
  await as(admin);
  assert.ok((await rpc("ai_route_rank_now", [A])) >= 1);
  await as(admin);
  const l = await rpc("ai_route_learning", [A]);
  assert.ok(l.rank.some((r) => r.model === "gpt-5-mini" && r.eval_ok === 1));
  assert.equal(l.evals.find((e) => e.id === evalId).question, "Qual o e-mail do cliente?");
  assert.equal(Number(l.spent_today), 0.06);
  assert.ok(l.samples_today >= 1);
  await as(ana);
  assert.equal((await db.query(`select 1 from ai_route_evals`)).rows.length, 0);
});

console.log(`\n${passed} verificações do aprendizado do roteador passaram.`);
