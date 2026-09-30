// MAVI · o custo de cada conversa (migration 20261224090000_mavi_conversation_cost):
// cada gasto ligado à conversa e à resposta, por modelo; os anexos contam na
// conversa em que foram usados; quem vê o custo.
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
const log = (user, { kind, model, cost, input = 0, output = 0, conversation = null, turn = null, attachment = null }) =>
  q(
    user,
    `select public.ai_log_usage($1,'assistant',$2,null,null,null,null,$3,$4,$5,0,0,0,$6,null,$7,$8,$9)`,
    [A, kind, model, input, output, cost, conversation, turn, attachment],
  );
const turnId = () => crypto.randomUUID();

let conv;
await check("os gastos da vez viram da resposta, por modelo; a conversa soma tudo", async () => {
  conv = await one(ana, "select public.ai_save_turn($1,null,'{}'::jsonb,'assistant','Oi','Olá','[]'::jsonb,'[]'::jsonb)", [A]);
  // A 2ª resposta: a Claude (com o fallback para o Opus), a busca nos vetores e uma imagem.
  const t = turnId();
  await log(ana, { kind: "ask", model: "claude-fable-5-1", cost: 0.3, input: 1000, output: 200, conversation: conv, turn: t });
  await log(ana, { kind: "ask", model: "claude-opus-4-8", cost: 0.1, input: 3000, output: 500, conversation: conv, turn: t });
  await log(ana, { kind: "image", model: "gpt-image-1", cost: 0.042, conversation: conv, turn: t });
  await one(ana, "select public.ai_save_turn($1,$2,'{}'::jsonb,'assistant','Faz a arte','Pronto','[]'::jsonb,'[]'::jsonb)", [A, conv]);
  assert.equal(await one(ana, "select public.ai_usage_close_turn($1,$2)", [conv, t]), 3);
  // Uma conversa nova sem a execução: a vez sem conversa ganha a conversa ao fechar.
  const t2 = turnId();
  await log(ana, { kind: "ask", model: "claude-opus-5-5", cost: 0.05, input: 500, turn: t2 });
  await one(ana, "select public.ai_save_turn($1,$2,'{}'::jsonb,'assistant','E o texto?','Aqui','[]'::jsonb,'[]'::jsonb)", [A, conv]);
  assert.equal(await one(ana, "select public.ai_usage_close_turn($1,$2)", [conv, t2]), 1);
  const cost = await one(ana, "select public.ai_conversation_cost($1)", [conv]);
  assert.equal(Number(cost.total.cost), 0.492);
  assert.equal(Number(cost.total.answers), 2);
  assert.deepEqual(
    cost.by_model.map((m) => [m.model, Number(m.cost), Number(m.input_tokens)]),
    [["claude-fable-5-1", 0.3, 1000], ["claude-opus-4-8", 0.1, 3000], ["claude-opus-5-5", 0.05, 500], ["gpt-image-1", 0.042, 0]],
  );
  assert.deepEqual(cost.by_model.find((m) => m.model === "gpt-image-1").kinds, ["image"]);
  assert.equal(cost.by_message.length, 2);
  assert.equal(Number(cost.by_message[0].cost), 0.442);
  assert.equal(cost.by_message[0].items.length, 3);
});

await check("anexo lido conta na conversa em que foi usado", async () => {
  await q(admin, "select public.ai_set_power($1,'attachments',true,true,'{}','{}','{}')", [A]);
  const a = await one(ana, "select public.ai_attachment_create($1,$2,'contrato.pdf','application/pdf',1000,'document',null)", [A, conv]);
  await log(ana, { kind: "attachment_index", model: "text-embedding-3-small", cost: 0.0001, attachment: a.id });
  const cost = await one(ana, "select public.ai_conversation_cost($1)", [conv]);
  assert.equal(Number(cost.total.cost), 0.4921);
  assert.ok(cost.by_kind.some((k) => k.kind === "attachment_index"));
});

await check("só quem começou a conversa ou gestores veem o custo; ninguém registra na conversa dos outros", async () => {
  assert.ok(await one(admin, "select public.ai_conversation_cost($1)", [conv]));
  await assert.rejects(() => q(bia, "select public.ai_conversation_cost($1)", [conv]), /não encontrada/);
  await assert.rejects(() => log(bia, { kind: "ask", model: "x", cost: 1, conversation: conv }), /Conversa inválida/);
  await assert.rejects(() => q(bia, "select public.ai_usage_close_turn($1,$2)", [conv, turnId()]), /não encontrada/);
  // O registro antigo (sem a conversa) continua funcionando.
  await q(bia, "select public.ai_log_usage($1,'assistant','ask',null,null,null,null,'m',1,1,0,0,0,0.001)", [A]);
});

console.log(`\n${passed} verificações passaram.`);
