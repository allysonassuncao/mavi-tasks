// Assistente MAVI · aprendizado com o feedback (migration
// 20261103090000_copilot_learning): 👍/👎 gravados na hora (um por pessoa,
// por alerta, por abertura), fila do worker por empresa, evidência para um
// aprendizado entrar em uso (2 pessoas ou um líder), o que líderes editam,
// pausam e excluem a MAVI não mexe nem recria, aprendizados no contexto da
// análise e a aba do Painel só para administradores e gestores.
import assert from "node:assert/strict";
import { createTestDatabase } from "./database-fixture.mjs";

const db = await createTestDatabase();
const uid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const [A, admin, ana, bia, outsider, manager] = [1, 10, 11, 12, 13, 14].map(
  uid,
);
const SECRET = "s".repeat(40);
await db.query(`insert into auth.users select unnest($1::uuid[])`, [
  [admin, ana, bia, outsider, manager],
]);
await db.query(`insert into companies(id,name) values($1,'Make')`, [A]);
await db.query(
  `insert into memberships(company_id,user_id,name,role,active) values
   ($1,$2,'Ana Admin','admin',true),($1,$3,'Ana Equipe','member',true),
   ($1,$4,'Bia Equipe','member',true),($1,$5,'Carla Fora','member',true),
   ($1,$6,'Gabi Gestora','manager',true)`,
  [A, admin, ana, bia, outsider, manager],
);
async function as(user) {
  await db.exec("reset role");
  await db.query(`select set_config('request.jwt.claim.sub',$1,false)`, [
    user ?? "",
  ]);
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

await sql(
  `insert into mavi_private.ai_config(url, secret) values('https://app.example/api/ai', $1)`,
  [SECRET],
);
await as(admin);
const team = await rpc("create_team", [A, "Equipe A", [ana, bia]]);
const client = await rpc("create_client", [A, "4282", "", [team]]);
const product = await rpc("create_product", [A, "Social Media"]);
const contract = await rpc("create_contract", [
  A,
  client,
  product,
  "Social · 4282",
  team,
]);
const [{ id: task }] = await sql(
  `insert into tasks(company_id, contract_id, title, description, assignee_id, creator_id, due_date, original_due_date)
   values ($1,$2,'Banner interno','',$3,$3,'2026-10-05','2026-10-05') returning id`,
  [A, contract, ana],
);
const alert = (title, kind = "missing") =>
  JSON.stringify({
    key: `${kind}:${title}`,
    kind,
    severity: "low",
    title,
    text: "texto",
    draft: "Banner interno",
  });
const S1 = uid(501);
const S2 = uid(502);

await check(
  "👍/👎 gravados na hora; mudar o voto troca; tirar apaga",
  async () => {
    await as(ana);
    await rpc("copilot_feedback_vote", [
      A,
      contract,
      null,
      S1,
      alert("Diga quem aprova"),
      "up",
      null,
      null,
    ]);
    await rpc("copilot_feedback_vote", [
      A,
      contract,
      null,
      S1,
      alert("Diga quem aprova"),
      "down",
      "obvious",
      "Tarefa interna, sem aprovação do cliente.",
    ]);
    let rows = await sql(`select * from copilot_feedback`);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].vote, "down");
    assert.equal(rows[0].reason, "obvious");
    assert.equal(rows[0].client_id, client);
    assert.equal(rows[0].product_id, product);
    assert.equal(rows[0].leader, false);
    // Motivo e comentário só no 👎.
    await as(ana);
    await rpc("copilot_feedback_vote", [
      A,
      contract,
      null,
      S1,
      alert("Outro"),
      "up",
      "wrong",
      "x",
    ]);
    rows = await sql(
      `select reason, comment from copilot_feedback where alert_title = 'Outro'`,
    );
    assert.deepEqual(rows[0], { reason: null, comment: "" });
    await as(ana);
    await rpc("copilot_feedback_vote", [
      A,
      contract,
      null,
      S1,
      alert("Outro"),
      null,
      null,
      null,
    ]);
    assert.equal(
      (await sql(`select count(*)::int n from copilot_feedback`))[0].n,
      1,
    );
    // A empresa entra na fila de aprendizado.
    assert.ok(
      (await sql(`select dirty_at from mavi_private.copilot_learning_state`))[0]
        .dirty_at,
    );
  },
);

await check(
  "quem não atende o cliente não vota; a tarefa criada fica ligada aos votos",
  async () => {
    await as(outsider);
    await rejects(
      () =>
        rpc("copilot_feedback_vote", [
          A,
          contract,
          null,
          S1,
          alert("x"),
          "up",
          null,
          null,
        ]),
      /Sem acesso/,
    );
    await as(ana);
    await rejects(
      () =>
        rpc("copilot_feedback_vote", [
          A,
          contract,
          null,
          S1,
          alert("x", "inventado"),
          "up",
          null,
          null,
        ]),
      /inválido/,
    );
    await rpc("copilot_feedback_attach", [A, S1, task]);
    assert.equal(
      (await sql(`select task_id from copilot_feedback`))[0].task_id,
      task,
    );
    await as(ana);
    await rejects(
      () => db.query(`select * from public.copilot_feedback`),
      /permission denied/,
    );
  },
);

await check(
  "worker: espera 10 min parado, lê os feedbacks novos e os aprendizados",
  async () => {
    await as(null);
    assert.equal(await rpc("ai_learning_claim", [SECRET]), null);
    await sql(`select mavi_private.ai_learning_kick()`);
    assert.equal(
      (
        await sql(
          `select count(*)::int n from net.requests where body->>'action' = 'ai-learning'`,
        )
      )[0].n,
      0,
    );
    await sql(
      `update mavi_private.copilot_learning_state set dirty_at = now() - interval '11 minutes'`,
    );
    await sql(`select mavi_private.ai_learning_kick()`);
    assert.equal(
      (
        await sql(
          `select count(*)::int n from net.requests where body->>'action' = 'ai-learning'`,
        )
      )[0].n,
      1,
    );
    await as(null);
    const claim = await rpc("ai_learning_claim", [SECRET]);
    assert.equal(claim.company, A);
    assert.equal(claim.feedback.length, 1);
    assert.equal(claim.feedback[0].client, "4282");
    assert.equal(claim.feedback[0].product, "Social Media");
    assert.equal(
      claim.feedback[0].comment,
      "Tarefa interna, sem aprovação do cliente.",
    );
    // Já em leitura: outro worker não pega.
    assert.equal(await rpc("ai_learning_claim", [SECRET]), null);
    await rejects(() => rpc("ai_learning_claim", ["errado"]), /Sem permissão/);
  },
);

let lesson;
await check(
  "um feedback de uma pessoa: aprendizado aguardando evidência",
  async () => {
    const [{ id: f1 }] = await sql(`select id from copilot_feedback`);
    await as(null);
    const n = await rpc("ai_learning_store", [
      SECRET,
      A,
      JSON.stringify([
        {
          op: "add",
          scope: "client",
          client_id: client,
          kind: "missing",
          text: "Não aponte falta de aprovação em tarefas internas do cliente 4282.",
          feedback: [String(f1)],
        },
        {
          op: "add",
          scope: "client",
          client_id: client,
          text: "Sem evidência não entra.",
          feedback: [],
        },
        {
          op: "add",
          scope: "client",
          client_id: uid(999),
          text: "Cliente de fora não entra.",
          feedback: [String(f1)],
        },
      ]),
      `{${f1}}`,
      JSON.stringify({
        model: "gpt-5.6-luna",
        input: 900,
        output: 80,
        cost: 0.003,
      }),
    ]);
    assert.equal(n, 1);
    [lesson] = await sql(`select * from copilot_lessons`);
    assert.equal(lesson.status, "candidate");
    assert.equal(lesson.people, 1);
    assert.equal(lesson.downs, 1);
    assert.equal(
      (await sql(`select learned_at from copilot_feedback`))[0].learned_at !==
        null,
      true,
    );
    const [state] = await sql(
      `select * from mavi_private.copilot_learning_state`,
    );
    assert.equal(state.dirty_at, null);
    assert.equal(state.running_until, null);
    const [usage] = await sql(`select * from ai_usage where kind = 'learning'`);
    assert.equal(usage.user_id, null);
    assert.equal(usage.module, "tasks");
  },
);

await check(
  "segunda pessoa confirma: entra em uso e vai para o contexto da análise",
  async () => {
    await as(bia);
    await rpc("copilot_feedback_vote", [
      A,
      contract,
      null,
      S2,
      alert("Diga quem aprova"),
      "down",
      "not_applicable",
      null,
    ]);
    const [{ id: f2 }] = await sql(
      `select id from copilot_feedback where user_id = $1`,
      [bia],
    );
    await as(null);
    await rpc("ai_learning_store", [
      SECRET,
      A,
      JSON.stringify([
        {
          op: "update",
          id: lesson.id,
          text: lesson.text,
          feedback: [String(f2)],
        },
      ]),
      `{${f2}}`,
      null,
    ]);
    const [l] = await sql(`select * from copilot_lessons where id = $1`, [
      lesson.id,
    ]);
    assert.equal(l.status, "active");
    assert.equal(l.people, 2);
    assert.equal(l.downs, 2);
    await as(ana);
    const ctx = await rpc("task_copilot_context", [
      A,
      contract,
      null,
      null,
      "banner interno",
      true,
    ]);
    assert.deepEqual(
      ctx.lessons.map((x) => x.id),
      [lesson.id],
    );
    // Relacionados não trazem aprendizados (não chamam modelo).
    const quick = await rpc("task_copilot_context", [
      A,
      contract,
      null,
      null,
      "banner interno",
      false,
    ]);
    assert.equal(quick.lessons, null);
  },
);

await check(
  "feedback de líder basta; aprendizado de outro cliente não entra",
  async () => {
    await as(manager);
    await rpc("copilot_feedback_vote", [
      A,
      contract,
      null,
      uid(503),
      alert("Case de outro nicho", "case"),
      "down",
      "not_applicable",
      "Cases de varejo não servem para B2B",
    ]);
    const [{ id: f3, leader }] = await sql(
      `select id, leader from copilot_feedback where user_id = $1`,
      [manager],
    );
    assert.equal(leader, true);
    await as(null);
    await rpc("ai_learning_store", [
      SECRET,
      A,
      JSON.stringify([
        {
          op: "add",
          scope: "product",
          product_id: product,
          kind: "case",
          text: "Em Social Media, só sugira cases do mesmo nicho.",
          feedback: [String(f3)],
        },
      ]),
      `{${f3}}`,
      null,
    ]);
    const [l] = await sql(`select * from copilot_lessons where kind = 'case'`);
    assert.equal(l.status, "active");
    assert.equal(l.has_leader, true);
    const other = await (async () => {
      await as(admin);
      return rpc("create_client", [A, "9001", "", [team]]);
    })();
    await as(admin);
    const otherContract = await rpc("create_contract", [
      A,
      other,
      product,
      "Social · 9001",
      team,
    ]);
    await as(ana);
    const ctx = await rpc("task_copilot_context", [
      A,
      otherContract,
      null,
      null,
      "x",
      true,
    ]);
    // O de produto vale; o do cliente 4282, não.
    assert.deepEqual(
      ctx.lessons.map((x) => x.kind),
      ["case"],
    );
  },
);

await check(
  "aba do Painel: só líderes; conferir, corrigir, pausar e excluir",
  async () => {
    await as(ana);
    await rejects(
      () =>
        rpc("copilot_learning_report", [
          A,
          "2026-01-01",
          "2030-01-01",
          null,
          50,
          0,
        ]),
      /Só administradores/,
    );
    await as(manager);
    const r = await rpc("copilot_learning_report", [
      A,
      "2026-01-01",
      "2030-01-01",
      null,
      50,
      0,
    ]);
    assert.equal(r.lessons.length, 2);
    assert.ok(r.lessons.every((l) => l.reviewed_at === null));
    assert.equal(r.feedback_total, 3);
    assert.equal(r.reasons.obvious, 1);
    const missing = r.kinds.find((k) => k.kind === "missing");
    assert.equal(missing.down, 2);
    const down = await rpc("copilot_learning_report", [
      A,
      "2026-01-01",
      "2030-01-01",
      "up",
      50,
      0,
    ]);
    assert.equal(down.feedback_total, 0);

    await rpc("copilot_lesson_set", [A, lesson.id, "review"]);
    await rpc("copilot_lesson_set", [A, lesson.id, "pause"]);
    let [l] = await sql(`select * from copilot_lessons where id = $1`, [
      lesson.id,
    ]);
    assert.equal(l.status, "paused");
    assert.equal(l.reviewed_by, manager);
    // Pausado não vai para a análise.
    await as(ana);
    assert.deepEqual(
      (
        await rpc("task_copilot_context", [A, contract, null, null, "x", true])
      ).lessons.map((x) => x.kind),
      ["case"],
    );
    // A MAVI não mexe no pausado.
    await as(null);
    assert.equal(
      await rpc("ai_learning_store", [
        SECRET,
        A,
        JSON.stringify([
          { op: "update", id: lesson.id, text: "Mudei", feedback: [] },
          { op: "retire", id: lesson.id },
        ]),
        "{}",
        null,
      ]),
      0,
    );
    // Excluir: a MAVI não recria o mesmo texto.
    await as(manager);
    await rpc("copilot_lesson_set", [A, lesson.id, "dismiss"]);
    const [{ id: anyFeedback }] = await sql(
      `select id from copilot_feedback limit 1`,
    );
    await as(null);
    assert.equal(
      await rpc("ai_learning_store", [
        SECRET,
        A,
        JSON.stringify([
          {
            op: "add",
            scope: "client",
            client_id: client,
            text: lesson.text,
            feedback: [String(anyFeedback)],
          },
        ]),
        "{}",
        null,
      ]),
      0,
    );
    // Líder escreve um aprendizado: em uso na hora, conferido, e a MAVI não muda.
    await as(admin);
    const mine = await rpc("copilot_lesson_save", [
      A,
      null,
      "company",
      null,
      null,
      "suggestion",
      "Sugestões só com base no histórico do cliente.",
    ]);
    [l] = await sql(`select * from copilot_lessons where id = $1`, [mine]);
    assert.equal(l.status, "active");
    assert.equal(l.origin, "person");
    assert.ok(l.reviewed_at);
    await as(null);
    assert.equal(
      await rpc("ai_learning_store", [
        SECRET,
        A,
        JSON.stringify([
          { op: "update", id: mine, text: "Outra coisa", feedback: [] },
        ]),
        "{}",
        null,
      ]),
      0,
    );
    await as(ana);
    await rejects(
      () =>
        rpc("copilot_lesson_save", [
          A,
          null,
          "company",
          null,
          null,
          null,
          "Posso?",
        ]),
      /Só administradores/,
    );
    await as(ana);
    await rejects(
      () => db.query(`select * from public.copilot_lessons`),
      /permission denied/,
    );
  },
);

await check(
  "copilot_learning entra nas regras por funcionalidade",
  async () => {
    await sql(
      `insert into mavi_private.ai_providers(id, company_id, name, kind, base_url, key_cipher, key_hint, models)
     values ($1,$2,'OpenAI','openai','https://api.openai.com/v1','v1:x','9xYz','[{"id":"gpt-5.6-luna","label":"Luna"}]')`,
      [uid(800), A],
    );
    await as(admin);
    await rpc("ai_set_route", [
      A,
      "feature",
      null,
      uid(800),
      "gpt-5.6-luna",
      "copilot_learning",
    ]);
    await rpc("ai_set_route", [
      A,
      "feature",
      null,
      uid(800),
      "gpt-5.6-luna",
      "task_copilot",
    ]);
    await as(null);
    assert.equal(
      (await rpc("ai_worker_route", [SECRET, A, "copilot_learning"])).model,
      "gpt-5.6-luna",
    );
  },
);

console.log(`\n${passed} verificações passaram.`);
