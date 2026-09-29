// Assistente MAVI · alertas que ajudam (migration 20261128090000_copilot_quality):
// os 👎 recentes do cliente (com comentário) e do produto (sem o comentário,
// que pode falar de outro cliente) e os 👍 vão para a análise; quem não
// atende o cliente não lê; o registro de cada análise fica só no banco e
// some depois de 14 dias.
import assert from "node:assert/strict";
import { createTestDatabase } from "./database-fixture.mjs";

const db = await createTestDatabase();
const uid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const [A, admin, ana, bia, outsider] = [1, 10, 11, 12, 13].map(uid);
await db.query(`insert into auth.users select unnest($1::uuid[])`, [
  [admin, ana, bia, outsider],
]);
await db.query(`insert into companies(id,name) values($1,'Make')`, [A]);
await db.query(
  `insert into memberships(company_id,user_id,name,role,active) values
   ($1,$2,'Ana Admin','admin',true),($1,$3,'Ana Equipe','member',true),
   ($1,$4,'Bia Equipe','member',true),($1,$5,'Carla Fora','member',true)`,
  [A, admin, ana, bia, outsider],
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

await as(admin);
const team = await rpc("create_team", [A, "Equipe A", [ana, bia]]);
const client = await rpc("create_client", [A, "4282", "", [team]]);
const other = await rpc("create_client", [A, "5060", "", [team]]);
const product = await rpc("create_product", [A, "Social Media"]);
const contract = await rpc("create_contract", [
  A,
  client,
  product,
  "Social · 4282",
  team,
]);
const otherContract = await rpc("create_contract", [
  A,
  other,
  product,
  "Social · 5060",
  team,
]);
const alert = (title, kind = "missing") =>
  JSON.stringify({
    key: `${kind}:${title}`,
    kind,
    severity: "low",
    title,
    text: "texto",
    draft: "Post",
  });
const vote = (
  contractId,
  session,
  title,
  v,
  reason = null,
  comment = null,
  kind,
) =>
  rpc("copilot_feedback_vote", [
    A,
    contractId,
    null,
    session,
    alert(title, kind),
    v,
    reason,
    comment,
  ]);

await check(
  "👎 do cliente com comentário, do produto sem; 👍 à parte",
  async () => {
    await as(ana);
    await vote(
      contract,
      uid(501),
      "Complete o briefing do anúncio",
      "down",
      "already",
      "O briefing está no anexo.",
    );
    await vote(
      contract,
      uid(501),
      "Já existe um post igual",
      "up",
      null,
      null,
      "duplicate",
    );
    await as(bia);
    // O mesmo alerta por outra pessoa não repete.
    await vote(
      contract,
      uid(502),
      "Complete o briefing do anúncio",
      "down",
      "already",
      null,
    );
    await vote(
      otherContract,
      uid(503),
      "Validar as alegações do produto",
      "down",
      "obvious",
      "Cliente 5060 aprova tudo por áudio.",
    );
    await as(ana);
    const m = await rpc("copilot_review_memory", [A, contract, null]);
    assert.equal(m.rejected.length, 2);
    const mine = m.rejected.find((r) => r.scope === "client");
    assert.equal(mine.title, "Complete o briefing do anúncio");
    assert.equal(mine.reason, "already");
    const prod = m.rejected.find((r) => r.scope === "product");
    assert.equal(prod.title, "Validar as alegações do produto");
    assert.equal(prod.comment, null);
    assert.deepEqual(m.helped, [
      { kind: "duplicate", title: "Já existe um post igual" },
    ]);
  },
);

await check("quem não atende o cliente não lê os feedbacks", async () => {
  await as(outsider);
  await rejects(
    () => rpc("copilot_review_memory", [A, contract, null]),
    /Sem acesso/,
  );
  await as(null);
  await rejects(
    () => rpc("copilot_review_memory", [A, contract, null]),
    /permission denied|Sem acesso/,
  );
});

await check(
  "registro da análise: só o banco lê e some depois de 14 dias",
  async () => {
    await sql(
      `insert into copilot_runs(company_id, client_id, created_at) values ($1,$2, now() - interval '15 days')`,
      [A, client],
    );
    await as(ana);
    await rpc("copilot_log_run", [
      A,
      client,
      null,
      "gpt-5.6-luna",
      "Rascunho",
      JSON.stringify([{ ref: "S1", similarity: 0.5 }]),
      '{"review":"x"}',
      JSON.stringify([{ kind: "missing", title: "Falta a medida" }]),
      "attention",
    ]);
    await rejects(
      () => db.query(`select * from copilot_runs`),
      /permission denied/,
    );
    const rows = await sql(
      `select model, verdict, sources, user_id from copilot_runs`,
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0].verdict, "attention");
    assert.equal(rows[0].user_id, ana);
    assert.equal(rows[0].sources[0].ref, "S1");
    await as(outsider);
    // Membro de outra empresa não grava.
    await as(uid(99));
    await rejects(
      () =>
        rpc("copilot_log_run", [
          A,
          client,
          null,
          "m",
          "",
          "[]",
          "",
          "[]",
          "ok",
        ]),
      /Sem acesso/,
    );
  },
);

console.log(`\n${passed} verificações passaram.`);
