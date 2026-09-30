// MAVI · autoavaliação (migration 20270115090000_mavi_judge): os sinais de
// cada resposta (só na conversa de quem pergunta), o 👎 sem motivo, a fila
// do juiz (depois de 2 minutos, o limite por dia, ligar e desligar), o
// material (pergunta, resposta, passos, trechos das fontes citadas, dossiê
// do cliente e o que a pessoa já reclamou), a resposta ruim que vira
// avaliação da MAVI e a evidência dela no aprendizado (sozinha espera).
import assert from "node:assert/strict";
import { createTestDatabase } from "./database-fixture.mjs";

const db = await createTestDatabase();
const uid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const [A, admin, ana, bia] = [1, 10, 11, 12].map(uid);
const SECRET = "s".repeat(40);
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
await as(admin);
const team = await rpc("create_team", [A, "Equipe A", [ana, bia]]);
const client = await rpc("create_client", [A, "5022", "", [team]]);
const task = uid(500);
// Um trecho da base (uma tarefa do cliente) e um item do dossiê.
const [doc] = await sql(
  `insert into ai_documents(company_id, source_type, source_id, access, client_id, title, content_hash)
   values ($1,'task',$2,'client',$3,'Criar artes','h') returning id`,
  [A, task, client],
);
await sql(
  `insert into ai_chunks(company_id, document_id, ord, content, source_type, access, client_id)
   values ($1,$2,0,'Tarefa "Criar artes"\nO cliente pediu 8 posts até 10/10.','task','client',$3)`,
  [A, doc.id, client],
);
await sql(
  `insert into client_dossier_items(company_id, client_id, kind, text, origin) values ($1,$2,'prefers','Prefere vídeos curtos','mavi')`,
  [A, client],
);

async function turn(user, answer = "Agora vou puxar as reuniões de cada cliente.") {
  await as(user);
  const conv = await rpc("ai_save_turn", [
    A,
    null,
    JSON.stringify({ client }),
    "assistant",
    "Faça a passagem do 5022",
    answer,
    JSON.stringify([{ ref: "S1", type: "task", id: task, title: "Criar artes", date: null, client_id: client }]),
    JSON.stringify([{ label: "Chegou ao limite de passos desta resposta", detail: "limite de passos" }]),
  ]);
  const [m] = await sql(`select id from ai_messages where conversation_id = $1 and role = 'assistant'`, [conv]);
  return { conv, message: Number(m.id) };
}
const age = (minutes = 3) => sql(`update mavi_answer_checks set updated_at = now() - make_interval(mins => $1)`, [minutes]);

let t1;
await check("os sinais: só na conversa de quem pergunta, juntando sem repetir", async () => {
  t1 = await turn(ana);
  await as(bia);
  await rejects(() => rpc("mavi_answer_signal", [t1.message, ["capped"]]), /Resposta não encontrada/);
  await as(ana);
  await rpc("mavi_answer_signal", [t1.message, ["capped", "announce", "inventado"]]);
  await as(ana);
  await rpc("mavi_answer_signal", [t1.message, ["capped"]]);
  const [k] = await sql(`select signals, status, user_id from mavi_answer_checks`);
  assert.deepEqual([...k.signals].sort(), ["announce", "capped"]);
  assert.deepEqual([k.status, k.user_id], ["pending", ana]);
  await as(bia);
  await assert.rejects(() => db.query("select * from mavi_answer_checks"), /permission denied/);
  await db.exec("reset role");
});

await check("a fila espera 2 minutos; o material traz fontes, dossiê e o que a pessoa já reclamou", async () => {
  // Uma reclamação antiga da mesma pessoa.
  const old = await turn(ana, "Resposta antiga.");
  await as(ana);
  await rpc("mavi_feedback_vote", [old.message, "down", "format", "Quero em tabela"]);
  await sql(`delete from mavi_answer_checks where message_id = $1`, [old.message]);
  await as(null);
  assert.deepEqual(await rpc("mavi_judge_claim", [SECRET, 3]), []);
  await sql(`delete from net.requests`);
  await sql(`select mavi_private.ai_learning_kick()`);
  const kicks = (await sql(`select body from net.requests`)).length;
  await age();
  await sql(`select mavi_private.ai_learning_kick()`);
  assert.ok((await sql(`select body from net.requests`)).length > kicks, "a fila acorda o worker");
  await as(null);
  const [item] = await rpc("mavi_judge_claim", [SECRET, 3]);
  assert.equal(item.message, t1.message);
  assert.equal(item.question, "Faça a passagem do 5022");
  assert.equal(item.answer, "Agora vou puxar as reuniões de cada cliente.");
  assert.match(item.steps, /limite de passos/);
  assert.equal(item.client, "5022");
  assert.deepEqual(item.sources.map((s) => [s.ref, s.excerpt]), [["S1", 'Tarefa "Criar artes"\nO cliente pediu 8 posts até 10/10.']]);
  assert.deepEqual(item.dossier, [{ kind: "prefers", text: "Prefere vídeos curtos" }]);
  assert.deepEqual(item.person.map((p) => p.comment), ["Quero em tabela"]);
  // Pegou a vez: não vem de novo.
  await as(null);
  assert.deepEqual(await rpc("mavi_judge_claim", [SECRET, 3]), []);
});

await check("resposta ruim vira avaliação da MAVI (sem pessoa) e o gasto entra no consumo", async () => {
  await as(null);
  await rpc("mavi_judge_store", [
    SECRET,
    t1.message,
    JSON.stringify({ jev: { complete: 0.1, announce: 0.9 }, ok: false }),
    true,
    "incomplete",
    "Anunciou que ia puxar as reuniões e parou: devia ter montado uma tarefa longa.",
    JSON.stringify([{ model: "~typesafe/jev-latest", input: 3000, cost: 0.001 }, { model: "claude-opus-5-5", input: 5000, output: 300, cost: 0.03 }]),
  ]);
  const [f] = await sql(`select * from mavi_feedback where origin = 'judge'`);
  assert.equal(f.user_id, null);
  assert.equal(f.vote, "down");
  assert.equal(f.reason, "incomplete");
  assert.equal(f.client_id, client);
  assert.deepEqual([...f.signals].sort(), ["announce", "capped"]);
  assert.equal(f.verdict.jev.announce, 0.9);
  const [k] = await sql(`select status, judged_at from mavi_answer_checks where message_id = $1`, [t1.message]);
  assert.equal(k.status, "done");
  const usage = await sql(`select kind, module, cost_usd from ai_usage where kind = 'judge' order by cost_usd`);
  assert.deepEqual(usage.map((u) => [u.kind, u.module, Number(u.cost_usd)]), [["judge", "mavi", 0.001], ["judge", "mavi", 0.03]]);
  // A pessoa não vê a avaliação da MAVI como dela.
  await as(ana);
  assert.deepEqual(await rpc("mavi_feedback_mine", [t1.conv]), []);
  // Um sinal novo (a pessoa reclamou na pergunta seguinte) pede outra conferência.
  await as(ana);
  await rpc("mavi_answer_signal", [t1.message, ["frustration"]]);
  assert.equal((await sql(`select status from mavi_answer_checks where message_id = $1`, [t1.message]))[0].status, "pending");
  await age();
  await as(null);
  const [again] = await rpc("mavi_judge_claim", [SECRET, 3]);
  assert.deepEqual([...again.signals].sort(), ["announce", "capped", "frustration"]);
  // Desta vez está boa: a avaliação da MAVI (ainda não aprendida) sai.
  await as(null);
  await rpc("mavi_judge_store", [SECRET, t1.message, JSON.stringify({ ok: true }), false, null, null, null]);
  assert.equal((await sql(`select count(*)::int n from mavi_feedback where origin = 'judge'`))[0].n, 0);
});

await check("o 👎 sem motivo nem comentário pede a conferência da MAVI", async () => {
  const t2 = await turn(bia, "Os clientes estão bem.");
  await as(bia);
  await rpc("mavi_feedback_vote", [t2.message, "down", null, null]);
  const [k] = await sql(`select signals from mavi_answer_checks where message_id = $1`, [t2.message]);
  assert.deepEqual(k.signals, ["down_unexplained"]);
  // Com motivo, não precisa.
  const t3 = await turn(bia, "Outra.");
  await as(bia);
  await rpc("mavi_feedback_vote", [t3.message, "down", "wrong", null]);
  assert.equal((await sql(`select count(*)::int n from mavi_answer_checks where message_id = $1`, [t3.message]))[0].n, 0);
});

await check("desligada ou no limite do dia, a MAVI não confere", async () => {
  await age();
  await as(ana);
  await rejects(() => rpc("mavi_judge_set", [A, false, null]), /Só administradores e gestores/);
  await as(admin);
  assert.deepEqual(await rpc("mavi_judge_set", [A, false, null]), { enabled: false, daily_limit: 40 });
  await as(null);
  assert.deepEqual(await rpc("mavi_judge_claim", [SECRET, 3]), []);
  await as(admin);
  await rpc("mavi_judge_set", [A, true, 1]);
  // Já conferiu 1 hoje: o limite de 1 por dia segura.
  await as(null);
  assert.deepEqual(await rpc("mavi_judge_claim", [SECRET, 3]), []);
  await as(admin);
  await rpc("mavi_judge_set", [A, null, 40]);
  await as(null);
  assert.equal((await rpc("mavi_judge_claim", [SECRET, 3])).length, 1);
  await as(admin);
  await rejects(() => rpc("mavi_judge_set", [A, true, 900]), /0 a 500/);
});

await check("no aprendizado, a MAVI é uma evidência: sozinha espera, com uma pessoa entra em uso", async () => {
  const t4 = await turn(ana, "Mais uma.");
  await as(ana);
  await rpc("mavi_answer_signal", [t4.message, ["no_sources"]]);
  await as(null);
  await rpc("mavi_judge_store", [SECRET, t4.message, JSON.stringify({ ok: false }), true, "format", "Faltou a tabela.", null]);
  const [judge] = await sql(`select id from mavi_feedback where origin = 'judge'`);
  await sql(`update mavi_private.mavi_learning_state set dirty_at = now() - interval '11 minutes'`);
  await as(null);
  const claim = await rpc("mavi_learning_claim", [SECRET]);
  const j = claim.feedback.find((f) => f.id === Number(judge.id));
  assert.deepEqual([j.origin, j.user], ["judge", "mavi"]);
  await as(null);
  await rpc("mavi_learning_store", [SECRET, A, JSON.stringify([{ op: "add", scope: "company", kind: "format", text: "Mostre listas de clientes em tabela.", feedback: [String(judge.id)] }]), [Number(judge.id)], null]);
  const [l] = await sql(`select id, status, people from mavi_lessons`);
  assert.deepEqual([l.status, l.people], ["candidate", 1]);
  const [person] = await sql(`select id from mavi_feedback where user_id = $1 and reason = 'format'`, [ana]);
  await as(null);
  await rpc("mavi_learning_store", [SECRET, A, JSON.stringify([{ op: "update", id: l.id, text: "Mostre listas de clientes em tabela.", feedback: [String(person.id)] }]), [], null]);
  const [after] = await sql(`select status, people from mavi_lessons where id = $1`, [l.id]);
  assert.deepEqual([after.status, after.people], ["active", 2]);
});

await check("a aba do Painel mostra a autoavaliação e filtra as avaliações da MAVI", async () => {
  await as(admin);
  const r = await rpc("mavi_learning_report", [A, "2026-01-01", "2099-01-01", null, 50, 0]);
  assert.equal(r.judge.enabled, true);
  assert.equal(r.judge.daily_limit, 40);
  assert.ok(r.judge.checked >= 2);
  assert.equal(r.judge.bad, 1);
  assert.equal(r.judge.signals.capped >= 1, true);
  // Os números das pessoas não contam a MAVI.
  assert.equal(r.totals.down, 3);
  const judged = await rpc("mavi_learning_report", [A, "2026-01-01", "2099-01-01", "judge", 50, 0]);
  assert.deepEqual(judged.feedback.map((f) => f.origin), ["judge"]);
  assert.equal(judged.feedback_total, 1);
});

await check("o Jev da autoavaliação: o escolhido para ela e a regra aceita a funcionalidade", async () => {
  const jev = uid(801);
  await sql(
    `insert into mavi_private.ai_providers(id, company_id, name, kind, base_url, key_cipher, key_hint, models) values
     ($1,$2,'OpenRouter','openrouter','https://openrouter.ai/api/v1','v1:cifra','9xYz',
      '[{"id":"~typesafe/jev-latest","label":"Jev","input":0.042,"output":0},{"id":"openai/gpt-5.6","label":"GPT"}]')`,
    [jev, A],
  );
  await as(admin);
  await rpc("ai_set_route", [A, "feature", null, jev, "~typesafe/jev-latest", "mavi_judge_check"]);
  await rejects(() => rpc("ai_set_route", [A, "feature", null, jev, "openai/gpt-5.6", "mavi_judge_check"]), /usa o Jev/);
  await as(admin);
  await rpc("ai_set_route", [A, "feature", null, jev, "openai/gpt-5.6", "mavi_judge"]);
  await as(null);
  const route = await rpc("mavi_judge_jev", [SECRET, A]);
  assert.equal(route.model, "~typesafe/jev-latest");
  await as(null);
  await rejects(() => rpc("mavi_judge_jev", ["x".repeat(40), A]), /Sem permissão/);
});

console.log(`\n${passed} verificações da autoavaliação da MAVI passaram.`);
