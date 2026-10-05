// Termômetro · correções do time e aprendizado da MAVI (migration
// 20270508090000_temperature_corrections): corrigir o assunto, os sinais e as
// notas de uma leitura (o que o Jev disse fica guardado e uma nova leitura do
// Jev mantém as correções), retirar e devolver uma leitura, tirar um sinal de
// alerta do cliente, quem pode corrigir, as regras da MAVI (lote, o que um
// líder mexeu fica como está) e o que vai ao worker.
import assert from "node:assert/strict";
import { createTestDatabase } from "./database-fixture.mjs";

const db = await createTestDatabase();
const uid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const [A, admin, supervisor, member, outsider] = [1, 10, 11, 12, 13].map(uid);
const SECRET = "s".repeat(40);
await db.query(`insert into auth.users select unnest($1::uuid[])`, [[admin, supervisor, member, outsider]]);
await db.query(`insert into companies(id,name) values($1,'Make')`, [A]);
await db.query(
  `insert into memberships(company_id,user_id,name,email,role,active) values
   ($1,$2,'Ana Admin','ana@make.com','admin',true),($1,$3,'Sara Supervisora','sara@make.com','member',true),
   ($1,$4,'Bruno Equipe','bruno@make.com','member',true),($1,$5,'Carla Fora','carla@make.com','member',true)`,
  [A, admin, supervisor, member, outsider],
);
async function as(user) {
  await db.exec("reset role");
  await db.query(`select set_config('request.jwt.claim.sub',$1,false)`, [user ?? ""]);
  await db.exec(`set role ${user ? "authenticated" : "anon"}`);
}
async function rpc(name, args) {
  return (
    await db.query(
      `select to_jsonb(public.${name}(${args.map((_, i) => `$${i + 1}`).join(",")})) as result`,
      args,
    )
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
const team = await rpc("create_team", [A, "Equipe A", [member], [supervisor]]);
const client = await rpc("create_client", [A, "4282", "", [team]]);
const other = await rpc("create_client", [A, "9001", "", []]);
await rpc("temperature_settings", [A]);

const answers = (v) => ({
  satisfacao: { v, c: 0.9, e: 0.9 },
  permanencia: { v, c: 0.9, e: 0.9 },
  relacao: { v, c: 0.9, e: 0.9 },
});
let n = 900;
/** Uma leitura já lida pelo Jev, `days` dias atrás. */
async function signal(cl, days, v, flags = {}, reason = "resultados") {
  const id = uid(n++);
  await sql(
    `insert into temperature_signals(id, company_id, client_id, source_type, source_id, title, occurred_at, day,
      status, answers, flags, reason, excerpt, client_lines, evaluated_at, version)
     values ($1, $2, $3, 'meeting', $4, 'Reunião', now() - $5::int * interval '1 day',
      (now() at time zone 'America/Sao_Paulo')::date - $5::int, 'done', $6, $7, $8, 'O cliente falou do contrato.', 3,
      now(), 1)`,
    [id, A, cl, uid(n++), days, answers(v), flags, { key: reason, p: { [reason]: 0.8 } }],
  );
  return id;
}
const temp = async (user, cl = client) => {
  await as(user);
  return rpc("client_temperature", [A, cl, 30, 40]);
};

const s1 = await signal(client, 2, 20, { cancelamento: 0.9 });
const s2 = await signal(client, 5, 30, { cancelamento: 0.8, cobranca_prazo: 0.75 }, "prazos");
const s3 = await signal(client, 40, 80);
const s4 = await signal(other, 1, 50);

await check("quem corrige: líderes e supervisores das equipes do cliente", async () => {
  assert.equal((await temp(admin)).can_correct, true);
  assert.equal((await temp(supervisor)).can_correct, true);
  assert.equal((await temp(member)).can_correct, false);
  await as(member);
  await rejects(() => rpc("correct_temperature_signal", [A, s1, { reason: "prazos" }, null]), /supervisores/);
  await as(supervisor);
  // O supervisor não é de nenhuma equipe do outro cliente.
  await rejects(() => rpc("correct_temperature_signal", [A, s4, { reason: "prazos" }, null]), /supervisores/);
  await as(outsider);
  await rejects(() => rpc("remove_temperature_signal", [A, s1, "não conta"]), /supervisores/);
});

await check("o alerta antes das correções", async () => {
  const t = await temp(admin);
  assert.deepEqual(t.current.flags.map((f) => f.key).sort(), ["cancelamento", "cobranca_prazo"]);
  assert.equal(t.signals.length, 3);
  assert.equal(t.signals[0].corrected, null);
});

await check("corrigir o assunto, um sinal e uma nota; o que o Jev disse fica guardado", async () => {
  await as(supervisor);
  const r = await rpc("correct_temperature_signal", [
    A,
    s1,
    { reason: "financeiro", flags: { cancelamento: false, financeiro: true }, answers: { permanencia: { v: 75 }, relacao: { e: 0 } } },
    "Era brincadeira sobre as férias; o assunto era a verba.",
  ]);
  assert.equal(r.changes, 5);
  const [g] = await sql(`select * from temperature_signals where id = $1`, [s1]);
  assert.equal(g.reason.key, "financeiro");
  assert.equal(g.flags.cancelamento, 0);
  assert.equal(g.flags.financeiro, 1);
  assert.equal(g.answers.permanencia.v, 75);
  assert.equal(g.answers.relacao.e, 0);
  assert.equal(g.answers.satisfacao.v, 20);
  assert.equal(g.jev.reason.key, "resultados");
  assert.equal(g.jev.flags.cancelamento, 0.9);
  assert.equal(g.corrected_by, supervisor);
  const t = await temp(admin);
  const shown = t.signals.find((s) => s.id === s1);
  assert.equal(shown.reason, "financeiro");
  assert.equal(shown.corrected.jev.reason, "resultados");
  assert.equal(shown.corrected.by, "Sara Supervisora");
  // O sinal da leitura s2 ainda segura "Fala em cancelar"; "Questiona o custo" entrou.
  assert.deepEqual(t.current.flags.map((f) => f.key).sort(), ["cancelamento", "cobranca_prazo", "financeiro"]);
  const fb = await sql(`select kind, key, before, after, note from temperature_feedback order by id`);
  assert.deepEqual(fb.map((f) => `${f.kind}:${f.key ?? ""}`).sort(), [
    "flag:cancelamento", "flag:financeiro", "reason:", "score:permanencia", "score:relacao",
  ]);
  assert.equal(fb[0].before, "resultados");
  assert.equal(fb[0].after, "financeiro");
  assert.match(fb[0].note, /férias/);
});

await check("uma nova leitura do Jev mantém as correções", async () => {
  await sql(
    `update temperature_signals set answers = $2, flags = $3, reason = $4, evaluated_at = now() + interval '1 second'
     where id = $1`,
    [s1, answers(10), { cancelamento: 0.95, financeiro: 0.1 }, { key: "prazos", p: { prazos: 1 } }],
  );
  const [g] = await sql(`select * from temperature_signals where id = $1`, [s1]);
  assert.equal(g.jev.reason.key, "prazos");
  assert.equal(g.reason.key, "financeiro");
  assert.equal(g.flags.cancelamento, 0);
  assert.equal(g.flags.financeiro, 1);
  assert.equal(g.answers.permanencia.v, 75);
  assert.equal(g.answers.satisfacao.v, 10);
});

await check("desfazer volta ao que o Jev disse; igual ao Jev não vira correção", async () => {
  await as(admin);
  const r = await rpc("correct_temperature_signal", [A, s1, { reason: "prazos", answers: { permanencia: null } }, null]);
  assert.equal(r.changes, 2);
  const [g] = await sql(`select * from temperature_signals where id = $1`, [s1]);
  assert.equal(g.reason.key, "prazos");
  assert.equal(g.overrides.reason, undefined);
  assert.equal(g.answers.permanencia.v, 10);
  await as(admin);
  assert.equal((await rpc("correct_temperature_signal", [A, s1, { reason: "prazos" }, null])).changes, 0);
  await as(admin);
  await rejects(() => rpc("correct_temperature_signal", [A, s1, { reason: "nada" }, null]), /Assunto desconhecido/);
  await as(admin);
  await rejects(() => rpc("correct_temperature_signal", [A, s1, { flags: { satisfacao: true } }, null]), /Sinal de alerta desconhecido/);
});

await check("tirar o sinal de alerta do cliente tira de todas as leituras da janela", async () => {
  await as(supervisor);
  await rejects(() => rpc("clear_temperature_flag", [A, client, "cancelamento", ""]), /Conte por que/);
  await as(supervisor);
  assert.equal(await rpc("clear_temperature_flag", [A, client, "cancelamento", "Ninguém falou em sair."]), 1);
  const t = await temp(admin);
  assert.ok(!t.current.flags.some((f) => f.key === "cancelamento"));
  const [g] = await sql(`select flags, jev from temperature_signals where id = $1`, [s2]);
  assert.equal(g.flags.cancelamento, 0);
  assert.equal(g.flags.cobranca_prazo, 0.75);
  assert.equal(g.jev.flags.cancelamento, 0.8);
});

await check("retirar uma leitura tira do cálculo; devolver traz de volta", async () => {
  const before = (await temp(admin)).current.signals;
  await as(supervisor);
  await rejects(() => rpc("remove_temperature_signal", [A, s2, ""]), /Conte por que/);
  await as(supervisor);
  await rpc("remove_temperature_signal", [A, s2, "Reunião interna do time."]);
  let t = await temp(admin);
  assert.equal(t.current.signals, before - 1);
  assert.ok(!t.current.flags.some((f) => f.key === "cobranca_prazo"));
  const shown = t.signals.find((s) => s.id === s2);
  assert.equal(shown.removed.reason, "Reunião interna do time.");
  assert.equal(shown.removed.by, "Sara Supervisora");
  assert.equal(shown.removed.auto, false);
  assert.equal(t.sources.meeting.removed, 1);
  assert.equal(t.sources.meeting.skipped, 0);
  // O documento mudou: a leitura não volta à fila enquanto estiver retirada.
  await sql(`update temperature_signals set status = 'pending', dirty_at = now() where id = $1`, [s2]);
  assert.equal((await sql(`select status from temperature_signals where id = $1`, [s2]))[0].status, "skipped");
  await as(admin);
  await rejects(() => rpc("correct_temperature_signal", [A, s2, { reason: "prazos" }, null]), /Devolva/);
  await as(admin);
  await rpc("restore_temperature_signal", [A, s2, null]);
  t = await temp(admin);
  assert.equal(t.current.signals, before);
  const [g] = await sql(`select status, kept, removed_at from temperature_signals where id = $1`, [s2]);
  assert.deepEqual([g.status, g.kept, g.removed_at], ["done", true, null]);
});

await check("a MAVI retira sozinha, mas não a leitura que uma pessoa devolveu", async () => {
  await as(null);
  assert.equal(await rpc("ai_temperature_irrelevant", [SECRET, [s2, s3]]), 1);
  const t = await temp(admin);
  const shown = t.signals.find((s) => s.id === s3);
  assert.equal(shown.removed.auto, true);
  assert.equal(shown.removed.by, null);
  assert.equal(t.signals.find((s) => s.id === s2).removed, null);
  await as(admin);
  await rpc("restore_temperature_signal", [A, s3, "Era com o cliente, sim."]);
  const [fb] = await sql(`select kind, before, note from temperature_feedback where kind = 'restore' and signal_id = $1`, [s3]);
  assert.equal(fb.before.auto, true);
});

await check("o worker recebe as regras em uso e os exemplos", async () => {
  await as(null);
  const l = await rpc("ai_temperature_learning", [SECRET, A]);
  assert.deepEqual(l.lessons, {});
  assert.ok(l.examples.length >= 7);
  assert.ok(l.examples.every((e) => e.kind !== "restore"));
  assert.equal(l.examples.at(-1).client, "4282");
  await rejects(() => rpc("ai_temperature_learning", ["x".repeat(40), A]), /Sem permissão/);
});

await check("as regras: lote parado há 10 minutos, o que um líder mexeu fica, falha conta", async () => {
  await as(null);
  assert.equal(await rpc("ai_temperature_lessons_claim", [SECRET]), null);
  await sql(`update temperature_feedback set created_at = now() - interval '11 minutes'`);
  // O agendamento acorda o worker para escrever as regras.
  await sql(`delete from net.requests`);
  await sql(`select mavi_private.ai_temperature_kick()`);
  assert.equal((await sql(`select count(*)::int as n from net.requests`))[0].n, 1);
  await as(null);
  const c = await rpc("ai_temperature_lessons_claim", [SECRET]);
  assert.equal(c.company, A);
  assert.ok(c.feedback.length >= 8);
  assert.ok(c.indicators.some((i) => i.key === "cancelamento"));
  assert.equal(c.reasons.length, 8);
  // Reservada: outro worker não pega.
  await as(null);
  assert.equal(await rpc("ai_temperature_lessons_claim", [SECRET]), null);
  await as(null);
  const done = await rpc("ai_temperature_lessons_store", [
    SECRET,
    A,
    [
      { op: "add", key: "cancelamento", text: "Brincadeira sobre férias ou folga não é falar em cancelar.", feedback: [1, 2] },
      { op: "add", key: "leitura", text: "Reunião só com o time da agência não conta.", feedback: [3] },
      { op: "add", key: "inexistente", text: "Não entra: a chave não existe." },
    ],
    c.feedback.map((f) => f.id),
    { model: "gpt", input: 100, output: 20, cost: 0.001 },
  ]);
  assert.equal(done, 2);
  assert.equal((await sql(`select count(*)::int as n from temperature_feedback where learned_at is null`))[0].n, 0);
  assert.equal((await sql(`select count(*)::int as n from ai_usage where kind = 'temperature_learning'`))[0].n, 1);
  await as(admin);
  const learning = await rpc("temperature_learning", [A]);
  assert.equal(learning.lessons.length, 2);
  const cancel = learning.lessons.find((l) => l.key === "cancelamento");
  assert.equal(cancel.origin, "mavi");
  assert.equal(cancel.feedback, 2);
  // Um líder edita: a MAVI não muda mais; excluída some e a MAVI não mexe.
  await as(admin);
  await rpc("save_temperature_lesson", [A, cancel.id, "cancelamento", "Férias e folgas não são cancelamento.", "active"]);
  const leitura = learning.lessons.find((l) => l.key === "leitura");
  await as(admin);
  await rpc("delete_temperature_lesson", [A, leitura.id]);
  await as(null);
  await rpc("ai_temperature_lessons_store", [
    SECRET, A,
    [{ op: "update", id: cancel.id, text: "A MAVI tentou mudar." }, { op: "retire", id: leitura.id }],
    [], null,
  ]);
  await as(admin);
  const after = await rpc("temperature_learning", [A]);
  assert.deepEqual(after.lessons.map((l) => [l.key, l.text, l.locked]), [
    ["cancelamento", "Férias e folgas não são cancelamento.", true],
  ]);
  await as(null);
  const l = await rpc("ai_temperature_learning", [SECRET, A]);
  assert.deepEqual(l.lessons, { cancelamento: ["Férias e folgas não são cancelamento."] });
  // Pausada não vai ao Jev.
  await as(admin);
  await rpc("save_temperature_lesson", [A, cancel.id, "cancelamento", "Férias e folgas não são cancelamento.", "paused"]);
  await as(null);
  assert.deepEqual((await rpc("ai_temperature_learning", [SECRET, A])).lessons, {});
  await as(admin);
  await rpc("save_temperature_lesson", [A, null, "motivo", "Pedido de verba nova é Financeiro, não Resultados.", "active"]);
  await as(member);
  await rejects(() => rpc("save_temperature_lesson", [A, null, "motivo", "Não pode.", "active"]), /Sem permissão/);
  await as(admin);
  await rejects(() => rpc("save_temperature_lesson", [A, null, "xyz", "Chave que não existe.", "active"]), /Escolha/);
  // Falhou 5 vezes: o lote conta como lido.
  await as(supervisor);
  await rpc("correct_temperature_signal", [A, s3, { reason: "elogio" }, null]);
  await sql(`update temperature_feedback set created_at = now() - interval '11 minutes' where learned_at is null`);
  for (let i = 0; i < 5; i++) {
    await sql(`update temperature_settings set lessons_until = null`);
    await as(null);
    assert.equal((await rpc("ai_temperature_lessons_claim", [SECRET])).company, A);
    await as(null);
    await rpc("ai_temperature_lessons_fail", [SECRET, A, "sem provedor"]);
  }
  assert.equal((await sql(`select count(*)::int as n from temperature_feedback where learned_at is null`))[0].n, 0);
});

await check("mudar a reunião de cliente apaga as correções e a retirada", async () => {
  await as(supervisor);
  await rpc("remove_temperature_signal", [A, s1, "Era do outro cliente."]);
  await sql(`update temperature_signals set client_id = $2 where id = $1`, [s1, other]);
  const [g] = await sql(`select overrides, removed_at, jev from temperature_signals where id = $1`, [s1]);
  assert.deepEqual([g.overrides, g.removed_at, g.jev], [{}, null, null]);
});

console.log(`\n${passed} verificações passaram.`);
