// MAVI · avaliação das respostas (migration 20270112090000_mavi_feedback):
// 👍/👎 por resposta de quem vê a conversa (uma por pessoa), o que o voto
// guarda (pergunta, trecho da resposta, passos, cliente e produto), a fila do
// worker (o mesmo agendamento do Copiloto), a evidência para o aprendizado
// entrar em uso (2 pessoas ou um líder), o que líderes editam, pausam e
// excluem a MAVI não mexe nem recria, o contexto de cada pergunta e a aba
// do Painel só para administradores e gestores.
import assert from "node:assert/strict";
import { createTestDatabase } from "./database-fixture.mjs";

const db = await createTestDatabase();
const uid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const [A, admin, ana, bia, carla] = [1, 10, 11, 12, 13].map(uid);
const SECRET = "s".repeat(40);
await db.query(`insert into auth.users select unnest($1::uuid[])`, [[admin, ana, bia, carla]]);
await db.query(`insert into companies(id,name) values($1,'Make')`, [A]);
await db.query(
  `insert into memberships(company_id,user_id,name,role,active) values
   ($1,$2,'Ana Admin','admin',true),($1,$3,'Ana Equipe','member',true),
   ($1,$4,'Bia Equipe','member',true),($1,$5,'Carla Fora','member',true)`,
  [A, admin, ana, bia, carla],
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
await as(admin);
const team = await rpc("create_team", [A, "Equipe A", [ana, bia]]);
const client = await rpc("create_client", [A, "5022", "", [team]]);
const product = await rpc("create_product", [A, "Make Ads"]);
const contract = await rpc("create_contract", [A, client, product, "Make Ads", null, null, []]).catch(async () => {
  await db.exec("reset role");
  return (
    await sql(
      `insert into contracts(company_id, client_id, product_id, name) values ($1,$2,$3,'Make Ads') returning id`,
      [A, client, product],
    )
  )[0].id;
});

/** Uma conversa de alguém com uma pergunta e uma resposta (e o escopo). */
async function turn(user, scope, question = "Como está o cliente?") {
  await as(user);
  const conv = await rpc("ai_save_turn", [A, null, JSON.stringify(scope), "assistant", question, "Está bem [S1].", "[]", JSON.stringify([{ label: "Buscando “cliente”", detail: "3 trechos" }])]);
  const [m] = await sql(`select id from ai_messages where conversation_id = $1 and role = 'assistant'`, [conv]);
  return { conv, message: Number(m.id) };
}
const vote = async (user, message, v, reason = null, comment = null) => {
  await as(user);
  return rpc("mavi_feedback_vote", [message, v, reason, comment]);
};

let a1;
await check("quem vê a conversa avalia; o voto guarda o que foi avaliado", async () => {
  a1 = await turn(ana, { contract }, "Faça a passagem do 5022");
  const r = await vote(ana, a1.message, "down", "incomplete", "  Parou no meio  ");
  assert.deepEqual(r, { message: a1.message, vote: "down", reason: "incomplete", comment: "Parou no meio" });
  const [f] = await sql(`select * from mavi_feedback`);
  assert.equal(f.client_id, client);
  assert.equal(f.product_id, product);
  assert.equal(f.question, "Faça a passagem do 5022");
  assert.equal(f.answer, "Está bem [S1].");
  assert.equal(f.steps, "Buscando “cliente” (3 trechos)");
  assert.equal(f.leader, false);
  // Outra pessoa, sem a conversa compartilhada, não avalia.
  await rejects(() => vote(bia, a1.message, "up"), /Sem acesso a esta conversa/);
  // Compartilhada, avalia.
  await sql(`insert into ai_conversation_shares(company_id, conversation_id, user_id) values ($1,$2,$3)`, [A, a1.conv, bia]).catch(
    async () => sql(`insert into ai_conversation_shares(company_id, conversation_id, user_id, shared_by) values ($1,$2,$3,$4)`, [A, a1.conv, bia, ana]),
  );
  await vote(bia, a1.message, "down", "wrong", "O CPL está errado");
  // O 👍 não guarda motivo nem comentário; votar de novo troca; nulo tira.
  await vote(ana, a1.message, "up", "wrong", "x");
  await as(ana);
  assert.deepEqual(await rpc("mavi_feedback_mine", [a1.conv]), [{ message: a1.message, vote: "up", reason: null, comment: "" }]);
  await vote(ana, a1.message, null);
  await as(ana);
  assert.deepEqual(await rpc("mavi_feedback_mine", [a1.conv]), []);
  await vote(ana, a1.message, "down", "incomplete", "Parou no meio");
  await rejects(() => vote(ana, a1.message, "meh"), /Voto inválido/);
  // A pergunta do usuário não se avalia.
  const [u] = await sql(`select id from ai_messages where conversation_id = $1 and role = 'user'`, [a1.conv]);
  await rejects(() => vote(ana, Number(u.id), "up"), /Resposta não encontrada/);
  // A tabela não se lê direto.
  await as(carla);
  await assert.rejects(() => db.query("select * from mavi_feedback"), /permission denied/);
  await db.exec("reset role");
});

await check("o contexto da pergunta: respostas recusadas no cliente (ou as da pessoa)", async () => {
  await as(ana);
  const ctx = await rpc("mavi_learning_context", [A, null, contract]);
  assert.deepEqual(ctx.lessons, []);
  assert.deepEqual(ctx.rejected.map((r) => r.comment).sort(), ["O CPL está errado", "Parou no meio"]);
  // Sem cliente: só as da própria pessoa.
  const c2 = await turn(carla, {}, "Quais clientes estão frios?");
  await vote(carla, c2.message, "down", "format", "Queria em tabela");
  await as(carla);
  const mine = await rpc("mavi_learning_context", [A, null, null]);
  assert.deepEqual(mine.rejected.map((r) => r.comment), ["Queria em tabela"]);
  await as(ana);
  assert.deepEqual((await rpc("mavi_learning_context", [A, null, null])).rejected.map((r) => r.comment), ["Parou no meio"]);
});

await check("a fila do worker: o mesmo agendamento do Copiloto acorda", async () => {
  await sql(`delete from net.requests`);
  await sql(`select mavi_private.ai_learning_kick()`);
  assert.equal((await sql(`select * from net.requests`)).length, 0, "ainda não passou 10 min");
  await sql(`update mavi_private.mavi_learning_state set dirty_at = now() - interval '11 minutes'`);
  await sql(`select mavi_private.ai_learning_kick()`);
  const [req] = await sql(`select body from net.requests`);
  assert.deepEqual(req.body, { action: "ai-learning" });
  await as(null);
  await rejects(() => rpc("mavi_learning_claim", ["errado".padEnd(40, "x")]), /Sem permissão/);
  await as(null);
  const claim = await rpc("mavi_learning_claim", [SECRET]);
  assert.equal(claim.company, A);
  assert.equal(claim.feedback.length, 3);
  const f = claim.feedback.find((x) => x.comment === "Parou no meio");
  assert.equal(f.client, "5022");
  assert.equal(f.product, "Make Ads");
  assert.equal(f.question, "Faça a passagem do 5022");
  // Pegou a vez: outra chamada não pega a mesma empresa.
  await as(null);
  assert.equal(await rpc("mavi_learning_claim", [SECRET]), null);
});

let lesson;
await check("evidência: 1 pessoa espera; 2 pessoas (ou um líder) entram em uso", async () => {
  const [fa] = await sql(`select id from mavi_feedback where comment = 'Parou no meio'`);
  const [fb] = await sql(`select id from mavi_feedback where comment = 'O CPL está errado'`);
  const [fc] = await sql(`select id from mavi_feedback where comment = 'Queria em tabela'`);
  await as(null);
  const changed = await rpc("mavi_learning_store", [
    SECRET,
    A,
    JSON.stringify([
      { op: "add", scope: "client", client_id: client, kind: "tasks", text: "No cliente 5022, faça a passagem completa como tarefa longa.", feedback: [String(fa.id), String(fb.id)] },
      { op: "add", scope: "company", kind: "format", text: "Listas de clientes vão em tabela, com a temperatura.", feedback: [String(fc.id)] },
      { op: "add", scope: "company", text: "x", feedback: [String(fc.id)] },
      { op: "add", scope: "client", text: "Sem cliente resolvido não entra.", feedback: [String(fc.id)] },
    ]),
    [fa.id, fb.id, fc.id],
    JSON.stringify({ model: "claude-opus-5-5", input: 1000, output: 200, cost: 0.02 }),
  ]);
  assert.equal(changed, 2);
  const rows = await sql(`select text, status, people, downs, scope from mavi_lessons order by text`);
  assert.deepEqual(rows.map((r) => [r.status, r.people, r.scope]), [
    ["candidate", 1, "company"],
    ["active", 2, "client"],
  ]);
  lesson = (await sql(`select id from mavi_lessons where scope = 'client'`))[0].id;
  assert.equal((await sql(`select count(*)::int n from mavi_feedback where learned_at is null`))[0].n, 0);
  const [usage] = await sql(`select module, kind, cost_usd from ai_usage where kind = 'learning'`);
  assert.deepEqual([usage.module, usage.kind, Number(usage.cost_usd)], ["mavi", "learning", 0.02]);
  assert.equal((await sql(`select dirty_at from mavi_private.mavi_learning_state`))[0].dirty_at, null);
  // O que está em uso vai para a pergunta; o que espera evidência, não.
  await as(ana);
  const ctx = await rpc("mavi_learning_context", [A, client, null]);
  assert.deepEqual(ctx.lessons.map((l) => l.text), ["No cliente 5022, faça a passagem completa como tarefa longa."]);
  // Aprendido: sai das "recusadas há pouco" (já virou aprendizado).
  assert.deepEqual(ctx.rejected, []);
  // Um voto de líder põe o candidato em uso.
  const b = await turn(admin, {}, "Lista dos clientes");
  await vote(admin, b.message, "down", "format", "Em tabela, por favor");
  const [fl] = await sql(`select id from mavi_feedback where user_id = $1`, [admin]);
  const [cand] = await sql(`select id from mavi_lessons where status = 'candidate'`);
  await as(null);
  await rpc("mavi_learning_store", [SECRET, A, JSON.stringify([{ op: "update", id: cand.id, text: "Listas de clientes vão em tabela, com a temperatura e as pendências.", feedback: [String(fl.id)] }]), [fl.id], null]);
  const [up] = await sql(`select status, has_leader, reviewed_at from mavi_lessons where id = $1`, [cand.id]);
  assert.deepEqual([up.status, up.has_leader, up.reviewed_at], ["active", true, null]);
});

await check("o que líderes decidem a MAVI não muda nem recria", async () => {
  await as(ana);
  await rejects(() => rpc("mavi_lesson_set", [A, lesson, "pause"]), /Só administradores e gestores/);
  await as(admin);
  await rpc("mavi_lesson_set", [A, lesson, "dismiss"]);
  await as(null);
  assert.equal(
    await rpc("mavi_learning_store", [SECRET, A, JSON.stringify([
      { op: "update", id: lesson, text: "Outro texto qualquer para o 5022.", feedback: [] },
      { op: "retire", id: lesson },
      { op: "add", scope: "client", client_id: client, text: "No cliente 5022, faça a passagem completa como tarefa longa.", feedback: ["1"] },
    ]), [], null]),
    0,
  );
  const [l] = await sql(`select status, text from mavi_lessons where id = $1`, [lesson]);
  assert.deepEqual([l.status, l.text], ["dismissed", "No cliente 5022, faça a passagem completa como tarefa longa."]);
  // O líder ensina direto: em uso na hora, de "person".
  await as(admin);
  const id = await rpc("mavi_lesson_save", [A, null, "product", null, product, "research", "Em Make Ads, comece pelos resultados das campanhas."]);
  const [p] = await sql(`select status, origin, reviewed_by from mavi_lessons where id = $1`, [id]);
  assert.deepEqual([p.status, p.origin, p.reviewed_by], ["active", "person", admin]);
  await as(ana);
  assert.deepEqual((await rpc("mavi_learning_context", [A, null, contract])).lessons.map((x) => [x.scope, x.text]), [
    ["product", "Em Make Ads, comece pelos resultados das campanhas."],
    ["company", "Listas de clientes vão em tabela, com a temperatura e as pendências."],
  ]);
  await as(admin);
  await rejects(() => rpc("mavi_lesson_save", [A, null, "company", null, null, "outro", "Texto válido aqui."]), /Tipo inválido/);
});

await check("a aba do Painel: só líderes, com os números e os feedbacks", async () => {
  await as(ana);
  await rejects(() => rpc("mavi_learning_report", [A, "2026-01-01", "2099-01-01", null, 50, 0]), /Só administradores e gestores/);
  await as(admin);
  const r = await rpc("mavi_learning_report", [A, "2026-01-01", "2099-01-01", null, 50, 0]);
  assert.equal(r.totals.down, 4);
  assert.equal(r.totals.people, 4);
  assert.equal(r.reasons.format, 2);
  assert.equal(r.feedback_total, 4);
  assert.equal(r.lessons.length, 3);
  assert.equal(r.feedback[0].question, "Lista dos clientes");
  const down = await rpc("mavi_learning_report", [A, "2026-01-01", "2099-01-01", "up", 50, 0]);
  assert.equal(down.feedback_total, 0);
});

await check("a funcionalidade do aprendizado aceita regra no Painel", async () => {
  const provider = uid(90);
  await sql(
    `insert into mavi_private.ai_providers(id, company_id, name, kind, base_url, key_cipher, key_hint, models) values
     ($1, $2, 'Claude', 'anthropic', null, 'v1:cifra', '1234', '[{"id":"claude-opus-5-5","input":4,"output":20}]')`,
    [provider, A],
  );
  await as(admin);
  await rpc("ai_set_route", [A, "feature", null, provider, "claude-opus-5-5", "mavi_learning"]);
  assert.equal((await sql(`select count(*)::int n from mavi_private.ai_routes where feature = 'mavi_learning'`))[0].n, 1);
});

console.log(`\n${passed} verificações da avaliação da MAVI passaram.`);
