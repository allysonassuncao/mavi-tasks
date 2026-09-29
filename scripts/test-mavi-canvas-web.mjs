// MAVI · canvas e internet (migration 20261216090000_mavi_canvas_web): os
// poderes 'canvas' e 'web' vêm desligados e seguem as regras dos outros; a
// resposta guarda o documento como anexo 'canvas'; o OpenRouter gera imagens.
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

await check("canvas e web vêm desligados; ligam como os outros poderes", async () => {
  assert.deepEqual(await one(ana, "select public.ai_my_powers($1)", [A]), []);
  const list = await one(admin, "select public.ai_powers_admin($1)", [A]);
  assert.deepEqual(list.map((p) => p.power), ["visuals", "images", "actions", "canvas", "web", "skills"]);
  await q(admin, "select public.ai_set_power($1,'canvas',true,true,'{}','{}','{}')", [A]);
  await q(admin, "select public.ai_set_power($1,'web',true,false,'{}',$2::uuid[],'{}')", [A, [admin]]);
  assert.deepEqual(await one(ana, "select public.ai_my_powers($1)", [A]), ["canvas"]);
  assert.deepEqual(await one(admin, "select public.ai_my_powers($1)", [A]), ["canvas", "web"]);
  await assert.rejects(() => q(admin, "select public.ai_set_power($1,'codigo',true,true,'{}','{}','{}')", [A]), /Poder inválido/);
});

await check("a resposta guarda o documento; a busca entra no registro de chamadas", async () => {
  const doc = [{ id: "canvas-0001", ref: "D1", type: "canvas", canvas: { kind: "document", title: "Relatório", markdown: "# Relatório\nTexto do relatório." } }];
  const conv = await one(
    ana,
    "select public.ai_save_turn($1,null,'{}'::jsonb,'assistant','Faz o relatório','[[D1]]','[]'::jsonb,'[]'::jsonb,$2::jsonb)",
    [A, JSON.stringify(doc)],
  );
  const [row] = await q(ana, "select artifacts from ai_messages where conversation_id=$1 and role='assistant'", [conv]);
  assert.equal(row.artifacts[0].canvas.kind, "document");
  await q(admin, "select public.ai_log_tool_calls($1,null,'assistant',$2::jsonb)", [
    A,
    JSON.stringify([{ tool: "web_search", power: "web", ok: true, ms: 0, cost: 0.01 }]),
  ]);
  await db.exec("reset role");
  const [call] = (await db.query("select tool, power, cost_usd from ai_tool_calls")).rows;
  assert.deepEqual([call.tool, call.power, Number(call.cost_usd)], ["web_search", "web", 0.01]);
});

await check("o OpenRouter gera imagens em Quem usa qual modelo", async () => {
  const router = await one(
    admin,
    "select public.ai_save_provider($1,null,'OpenRouter','openrouter',null,$2::jsonb,'v1:abc','wxyz',true)",
    [A, JSON.stringify([{ id: "google/gemini-2.5-flash-image", input: 0.3, output: 2.5 }, { id: "anthropic/claude-sonnet-5", input: 2, output: 10 }])],
  );
  const route = (model) => q(admin, "select public.ai_set_route($1,'feature',null,$2,$3,'image_generation')", [A, router, model]);
  await assert.rejects(() => route("anthropic/claude-sonnet-5"), /Escolha um modelo de imagem/);
  await route("google/gemini-2.5-flash-image");
  const r = await one(ana, "select public.ai_resolve_route($1,null,null,null,'image_generation')", [A]);
  assert.deepEqual([r.kind, r.model], ["openrouter", "google/gemini-2.5-flash-image"]);
});

console.log(`\n${passed} checks passed`);
