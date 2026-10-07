// MAVI · roteador (migration 20270612150000_ai_route_observed): a leitura
// conferida depois da resposta — o registro guarda o observado e a marca de
// subestimada; testes fora do ar só sem entregável e até 2 rodadas; a
// subestimada conta contra o sugerido no ranking; tipos que costumam ficar
// abaixo voltam na política; o desempenho e as últimas decisões mostram.
import assert from "node:assert/strict";
import { createTestDatabase } from "./database-fixture.mjs";

const db = await createTestDatabase();
const uid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const [A, admin, ana] = [1, 10, 11].map(uid);
await db.query(`insert into auth.users select unnest($1::uuid[])`, [[admin, ana]]);
await db.query(`insert into companies(id,name) values($1,'Make')`, [A]);
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
await as(admin);
await rpc("ai_router_save", [A, JSON.stringify({ eval_rate: 1 })]);
async function turn() {
  await as(ana);
  const conv = await rpc("ai_save_turn", [A, null, "{}", "assistant", "Monte a apresentação", "Pronto", "[]", "[]"]);
  const [m] = await sql(`select id from ai_messages where conversation_id = $1 and role = 'assistant'`, [conv]);
  return { conv, message: Number(m.id) };
}
const entry = (t, over = {}) =>
  JSON.stringify({
    surface: "page", feature: "mavi_page", task_type: "consulta", complexity: 1, mode: "auto",
    conversation_id: t.conv, message_id: t.message, used_model: "claude-sonnet-5", suggested_model: "deepseek-flash",
    rounds: 0, artifacts: 0, eval_candidate: { provider_id: null, model: "claude-haiku-4-5" }, ...over,
  });

// 6 consultas subestimadas (criaram apresentação) e 2 normais.
for (let i = 0; i < 6; i++) {
  const t = await turn();
  await as(ana);
  await rpc("ai_route_log", [A, entry(t, { rounds: 3, artifacts: 1, observed_complexity: 3, underestimated: true })]);
}
for (let i = 0; i < 2; i++) {
  const t = await turn();
  await as(ana);
  await rpc("ai_route_log", [A, entry(t, { observed_complexity: 1, underestimated: false })]);
}
// Uma com 3 rodadas, sem entregável: também não vira teste.
const t3 = await turn();
await as(ana);
await rpc("ai_route_log", [A, entry(t3, { rounds: 3, observed_complexity: 2 })]);

const rows = await sql(`select observed_complexity, underestimated from ai_route_decisions order by id`);
assert.deepEqual(rows.filter((r) => r.underestimated).length, 6);
assert.equal(rows[0].observed_complexity, 3);
const evals = await sql(`select count(*)::int n from ai_route_evals`);
assert.equal(evals[0].n, 2, "só as respostas sem entregável e com até 2 rodadas viram teste");
console.log("PASS registro com o observado e a marca; teste fora do ar só sem entregável e até 2 rodadas");

await sql(`select mavi_private.ai_route_rank_refresh()`);
const [dk] = await sql(`select eval_n, eval_ok, quality from mavi_private.ai_route_rank where model = 'deepseek-flash'`);
assert.deepEqual([dk.eval_n, dk.eval_ok], [6, 0]);
assert.equal(Number(dk.quality), Math.round(((0 + 0.85 * 5) / 11) * 1000) / 1000);
console.log("PASS a subestimada conta contra o modelo sugerido no ranking");

await as(ana);
const ctx = await rpc("ai_route_context", [A, null, null, null, "page"]);
assert.deepEqual(ctx.underestimated_types, ["consulta"]);
console.log("PASS tipos que costumam ficar abaixo voltam na política (5+ e 25%+ em 30 dias)");

await as(admin);
const st = await rpc("ai_route_stats", [A, 30]);
assert.equal(st.shadow.underestimated, 6);
await as(admin);
const recent = await rpc("ai_route_recent", [A, 20]);
assert.equal(recent.filter((r) => r.underestimated).length, 6);
assert.equal(recent.find((r) => r.underestimated).observed_complexity, 3);
console.log("PASS desempenho e últimas decisões mostram as subestimadas");
console.log("\n4 verificações da leitura conferida passaram.");
