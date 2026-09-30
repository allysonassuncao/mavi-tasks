// MAVI · base de comportamento por pessoa (migration 20270117090000_mavi_person):
// quem vê e edita (a pessoa, administradores e gestores; gestor não vê
// administradores), o que o sistema sabe sem modelo (papel, equipes,
// clientes mais consultados, histórico das avaliações), a fila do worker
// (avaliações, reclamações e conversas novas; uma vez por dia ou uma hora
// depois de um comentário), o que a MAVI pode mudar, e o contexto da pergunta
// e do juiz.
import assert from "node:assert/strict";
import { createTestDatabase } from "./database-fixture.mjs";

const db = await createTestDatabase();
const uid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const [A, admin, gil, ana, bia] = [1, 10, 11, 12, 13].map(uid);
const SECRET = "s".repeat(40);
await db.query(`insert into auth.users select unnest($1::uuid[])`, [[admin, gil, ana, bia]]);
await db.query(`insert into companies(id,name) values($1,'Make')`, [A]);
await db.query(
  `insert into memberships(company_id,user_id,name,role,active) values
   ($1,$2,'Ana Admin','admin',true),($1,$3,'Gil Gestor','manager',true),($1,$4,'Ana Equipe','member',true),($1,$5,'Bia Equipe','member',true)`,
  [A, admin, gil, ana, bia],
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
const team = await rpc("create_team", [A, "Squad Primogênito", [ana, bia]]);
const client = await rpc("create_client", [A, "5022", "", [team]]);
const due = () => sql(`update mavi_private.mavi_person_state set dirty_at = now() - interval '20 minutes'`);

let conv;
let message;
await check("conversas e avaliações marcam a pessoa; um comentário atualiza mais cedo", async () => {
  await as(ana);
  conv = await rpc("ai_save_turn", [A, null, JSON.stringify({ client }), "assistant", "Quais clientes estão frios?", "Estão bem.", "[]", "[]"]);
  const [m] = await sql(`select id from ai_messages where conversation_id = $1 and role = 'assistant'`, [conv]);
  message = Number(m.id);
  let [s] = await sql(`select urgent, dirty_at from mavi_private.mavi_person_state where user_id = $1`, [ana]);
  assert.equal(s.urgent, false);
  assert.ok(s.dirty_at);
  await as(ana);
  await rpc("mavi_feedback_vote", [message, "down", "format", "Sempre quero em tabela"]);
  [s] = await sql(`select urgent from mavi_private.mavi_person_state where user_id = $1`, [ana]);
  assert.equal(s.urgent, true);
  // O gasto da MAVI no cliente conta nos "clientes que mais consulta".
  await sql(
    `insert into ai_usage(company_id, user_id, module, kind, client_id, model, cost_usd) values ($1,$2,'assistant','ask',$3,'m',0.01),($1,$2,'assistant','ask',$3,'m',0.01)`,
    [A, ana, client],
  );
});

await check("a fila: 15 minutos parada; a leitura traz avaliações, reclamações e perguntas", async () => {
  await as(null);
  assert.equal(await rpc("mavi_person_claim", [SECRET]), null);
  // Uma reclamação na pergunta seguinte.
  await as(ana);
  await rpc("ai_save_turn", [A, conv, "{}", "assistant", "Me mande o que te pedi", "Aqui está.", "[]", "[]"]);
  await as(ana);
  await rpc("mavi_answer_signal", [message, ["frustration"]]);
  await due();
  await sql(`delete from net.requests`);
  await sql(`select mavi_private.ai_learning_kick()`);
  assert.equal((await sql(`select count(*)::int n from net.requests`))[0].n, 1);
  await as(null);
  const claim = await rpc("mavi_person_claim", [SECRET]);
  assert.equal(claim.user, ana);
  assert.equal(claim.name, "Ana Equipe");
  assert.deepEqual(claim.facts.teams, ["Squad Primogênito"]);
  assert.deepEqual(claim.facts.clients.map((c) => [c.name, c.n]), [["5022", 2]]);
  assert.deepEqual(claim.feedback.map((f) => f.comment), ["Sempre quero em tabela"]);
  assert.equal(claim.frustrations[0].said, "Me mande o que te pedi");
  assert.deepEqual(claim.questions, ["Me mande o que te pedi", "Quais clientes estão frios?"]);
  // Pegou a vez.
  await as(null);
  assert.equal(await rpc("mavi_person_claim", [SECRET]), null);
});

let item;
await check("a MAVI grava itens novos; o que alguém fixou ou removeu ela não mexe", async () => {
  await as(null);
  const n = await rpc("mavi_person_store", [
    SECRET,
    A,
    ana,
    JSON.stringify([
      { op: "add", kind: "preference", text: "Responda listas de clientes em tabela." },
      { op: "add", kind: "frustration", text: "Não pare no meio: ela pede o resultado completo." },
      { op: "add", kind: "outro", text: "inválido" },
      { op: "add", kind: "context", text: "x" },
    ]),
    JSON.stringify({ model: "claude-opus-5-5", input: 900, output: 100, cost: 0.01 }),
  ]);
  assert.equal(n, 2);
  const [s] = await sql(`select built_at, urgent, dirty_at from mavi_private.mavi_person_state where user_id = $1`, [ana]);
  assert.ok(s.built_at);
  assert.deepEqual([s.urgent, s.dirty_at], [false, null]);
  assert.equal((await sql(`select count(*)::int n from ai_usage where kind = 'profile'`))[0].n, 1);
  // Lido hoje: só amanhã de novo (ou uma hora depois de um comentário novo).
  await as(ana);
  await rpc("ai_save_turn", [A, null, "{}", "assistant", "Outra pergunta", "Resposta.", "[]", "[]"]);
  await due();
  await as(null);
  assert.equal(await rpc("mavi_person_claim", [SECRET]), null);
  // A pessoa fixa um item e remove outro.
  const [pref] = await sql(`select id from mavi_person_traits where kind = 'preference'`);
  const [frus] = await sql(`select id from mavi_person_traits where kind = 'frustration'`);
  item = pref.id;
  await as(ana);
  await rpc("mavi_person_trait_set", [A, pref.id, "pin"]);
  await as(ana);
  await rpc("mavi_person_trait_set", [A, frus.id, "dismiss"]);
  await as(null);
  assert.equal(
    await rpc("mavi_person_store", [SECRET, A, ana, JSON.stringify([
      { op: "update", id: pref.id, text: "Outro texto qualquer." },
      { op: "retire", id: pref.id },
      { op: "retire", id: frus.id },
      { op: "add", kind: "frustration", text: "Não pare no meio: ela pede o resultado completo." },
    ]), null]),
    0,
  );
  assert.deepEqual((await sql(`select text, pinned, dismissed from mavi_person_traits order by kind`)).map((r) => [r.pinned, r.dismissed]), [
    [false, true],
    [true, false],
  ]);
});

await check("quem vê e edita: a pessoa e os líderes; gestor não vê administradores", async () => {
  await as(ana);
  const mine = await rpc("mavi_person_profile", [A, null]);
  assert.equal(mine.self, true);
  assert.equal(mine.items.length, 2);
  assert.deepEqual(mine.facts.teams, ["Squad Primogênito"]);
  assert.equal(mine.history.down, 1);
  assert.equal(mine.history.reasons.format, 1);
  assert.equal(mine.history.recent[0].comment, "Sempre quero em tabela");
  // Colega não vê.
  await as(bia);
  await rejects(() => rpc("mavi_person_profile", [A, ana]), /Sem acesso/);
  await as(bia);
  await rejects(() => rpc("mavi_person_trait_set", [A, item, "dismiss"]), /não encontrado/);
  // Gestor vê a colaboradora e escreve como líder.
  await as(gil);
  assert.equal((await rpc("mavi_person_profile", [A, ana])).self, false);
  await as(gil);
  const id = await rpc("mavi_person_trait_save", [A, ana, null, "context", "Cuida da carteira do Squad Primogênito."]);
  const [row] = await sql(`select origin, pinned from mavi_person_traits where id = $1`, [id]);
  assert.deepEqual([row.origin, row.pinned], ["leader", true]);
  // Gestor não vê o administrador; o administrador vê todo mundo.
  await as(gil);
  await rejects(() => rpc("mavi_person_profile", [A, admin]), /Sem acesso/);
  await as(admin);
  assert.ok(await rpc("mavi_person_profile", [A, gil]));
  // A própria pessoa escreve (origem "person").
  await as(ana);
  const own = await rpc("mavi_person_trait_save", [A, null, null, "preference", "Seja direta, sem introdução."]);
  assert.equal((await sql(`select origin from mavi_person_traits where id = $1`, [own]))[0].origin, "person");
  await as(ana);
  await rejects(() => rpc("mavi_person_trait_save", [A, null, null, "humor", "Algo aqui"]), /Tipo inválido/);
  await as(bia);
  await assert.rejects(() => db.query("select * from mavi_person_traits"), /permission denied/);
  await db.exec("reset role");
});

await check("em cada pergunta e no juiz: os itens de quem pergunta (sem os removidos)", async () => {
  await as(ana);
  const ctx = await rpc("mavi_person_context", [A]);
  assert.deepEqual(ctx.items.map((i) => i.text).sort(), [
    "Cuida da carteira do Squad Primogênito.",
    "Responda listas de clientes em tabela.",
    "Seja direta, sem introdução.",
  ]);
  assert.deepEqual(ctx.facts.clients.map((c) => c.name), ["5022"]);
  await as(bia);
  assert.deepEqual((await rpc("mavi_person_context", [A])).items, []);
  await as(null);
  const judge = await rpc("mavi_judge_person", [SECRET, message]);
  assert.equal(judge.length, 3);
  await as(null);
  await rejects(() => rpc("mavi_judge_person", ["x".repeat(40), message]), /Sem permissão/);
});

console.log(`\n${passed} verificações da base de comportamento passaram.`);
