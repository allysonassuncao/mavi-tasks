// Avisos de novos aprendizados (migration 20270203090000_lesson_alerts):
// recursos extras por pessoa (um para o Copiloto, um para o Aprendizado da
// MAVI), só para administradores e gestores; quem liga para quem; um aviso
// por lote de aprendizados gravados pela MAVI; reescrito depois de conferido
// avisa de novo, ainda em "Novos" não; os ensinados por uma pessoa não avisam.
import assert from "node:assert/strict";
import { createTestDatabase } from "./database-fixture.mjs";

const db = await createTestDatabase();
const uid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const [A, admin, admin2, manager, ana, outsiderManager] = [
  1, 10, 11, 12, 13, 14,
].map(uid);
const SECRET = "s".repeat(40);
await db.query(`insert into auth.users select unnest($1::uuid[])`, [
  [admin, admin2, manager, ana, outsiderManager],
]);
await db.query(`insert into companies(id,name) values($1,'Make')`, [A]);
await db.query(
  `insert into memberships(company_id,user_id,name,role,active) values
   ($1,$2,'Ana Admin','admin',true),($1,$3,'Beto Admin','admin',true),
   ($1,$4,'Gabi Gestora','manager',true),($1,$5,'Ana Equipe','member',true),
   ($1,$6,'Hugo Gestor','manager',true)`,
  [A, admin, admin2, manager, ana, outsiderManager],
);
await db.query(
  `insert into mavi_private.ai_config(url, secret) values('https://app.example/api/ai', $1)`,
  [SECRET],
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
const inbox = async (kind) =>
  sql(
    `select user_id, title, body, link from notifications where kind = $1 order by user_id, created_at`,
    [kind],
  );
const clear = () => sql(`delete from notifications`);
const add = (text) => ({
  op: "add",
  scope: "company",
  text,
  feedback: ["999"],
});
const store = async (fn, ops) => {
  await as(null);
  return rpc(fn, [SECRET, A, JSON.stringify(ops), [], null]);
};

await as(admin);
// A gestora lidera a equipe da Ana; o Hugo, nenhuma.
await rpc("create_team", [A, "Equipe A", [ana, manager]]);
await sql(`update team_members set supervisor = true where user_id = $1`, [
  manager,
]);

await check("desligado por padrão", async () => {
  const rows = await sql(
    `select bool_or(lesson_alerts_copilot or lesson_alerts_mavi) on_ from memberships`,
  );
  assert.equal(rows[0].on_, false);
});

await check("quem liga para quem", async () => {
  await as(ana);
  await rejects(
    () => rpc("set_member_lesson_alerts", [A, ana, true, true]),
    /Administradores liberam/,
  );
  await as(manager);
  await rejects(
    () => rpc("set_member_lesson_alerts", [A, admin2, true, false]),
    /Administradores liberam/,
  );
  await rejects(
    () => rpc("set_member_lesson_alerts", [A, outsiderManager, true, false]),
    /Administradores liberam/,
  );
  // Um líder liga para si mesmo.
  await as(manager);
  await rpc("set_member_lesson_alerts", [A, manager, true, true]);
  await as(outsiderManager);
  await rpc("set_member_lesson_alerts", [A, outsiderManager, false, true]);
  // Colaborador não abre o Painel da MAVI: não pode ter.
  await as(admin);
  await rejects(
    () => rpc("set_member_lesson_alerts", [A, ana, true, false]),
    /só para administradores e gestores/,
  );
  await rpc("set_member_lesson_alerts", [A, ana, false, false]);
  await rpc("set_member_lesson_alerts", [A, admin2, true, false]);
  const rows = await sql(
    `select user_id, lesson_alerts_copilot c, lesson_alerts_mavi m from memberships
     where lesson_alerts_copilot or lesson_alerts_mavi order by user_id`,
  );
  assert.deepEqual(rows, [
    { user_id: admin2, c: true, m: false },
    { user_id: manager, c: true, m: true },
    { user_id: outsiderManager, c: false, m: true },
  ]);
});

let lessons;
await check("Copiloto: um aviso por lote, para quem ligou", async () => {
  await clear();
  const n = await store("ai_learning_store", [
    add("Tarefas internas não pedem aprovação do cliente."),
    add("Peça o formato da arte quando não vier na descrição."),
    add("Não aponte prazo curto em tarefas de urgência marcada."),
  ]);
  assert.equal(n, 3);
  const rows = await inbox("copilot_lessons");
  assert.deepEqual(
    rows.map((r) => r.user_id),
    [admin2, manager],
  );
  assert.equal(rows[0].title, "Copiloto: 3 aprendizados novos para conferir");
  assert.equal(
    rows[0].body,
    "Tarefas internas não pedem aprovação do cliente. · e mais 2",
  );
  assert.equal(rows[0].link, "/mavi#copiloto");
  assert.equal((await inbox("mavi_lessons")).length, 0);
  lessons = await sql(
    `select id, text from copilot_lessons order by created_at, text`,
  );
});

await check(
  "ensinado por uma pessoa não avisa; reescrito ainda em Novos também não",
  async () => {
    await clear();
    await as(admin);
    await rpc("copilot_lesson_save", [
      A,
      null,
      "company",
      null,
      null,
      null,
      "Sempre cite o cliente pelo código.",
    ]);
    await store("ai_learning_store", [
      {
        op: "update",
        id: lessons[0].id,
        text: `${lessons[0].text} Vale para todos.`,
        feedback: ["999"],
      },
    ]);
    assert.equal((await inbox("copilot_lessons")).length, 0);
  },
);

await check(
  "conferido e reescrito pela MAVI: volta para Novos e avisa",
  async () => {
    const [l] = await sql(
      `select id, text from copilot_lessons where id = $1`,
      [lessons[1].id],
    );
    await as(admin);
    await rpc("copilot_lesson_set", [A, l.id, "review"]);
    await store("ai_learning_store", [
      {
        op: "update",
        id: l.id,
        text: "Peça o formato e o tamanho da arte.",
        feedback: ["999"],
      },
    ]);
    const rows = await inbox("copilot_lessons");
    assert.equal(rows.length, 2);
    assert.equal(rows[0].title, "Copiloto: 1 aprendizado novo para conferir");
    assert.equal(rows[0].body, "Peça o formato e o tamanho da arte.");
  },
);

await check("só a evidência (mesmo texto) não avisa", async () => {
  await clear();
  const [l] = await sql(`select id, text from copilot_lessons where id = $1`, [
    lessons[2].id,
  ]);
  await as(admin);
  await rpc("copilot_lesson_set", [A, l.id, "review"]);
  await store("ai_learning_store", [
    { op: "update", id: l.id, text: l.text, feedback: ["998"] },
  ]);
  assert.equal((await inbox("copilot_lessons")).length, 0);
});

await check(
  "Aprendizado da MAVI: aviso próprio, para quem ligou esse",
  async () => {
    await clear();
    await store("mavi_learning_store", [
      add("Listas de clientes vão em tabela."),
    ]);
    const rows = await inbox("mavi_lessons");
    assert.deepEqual(
      rows.map((r) => r.user_id),
      [manager, outsiderManager],
    );
    assert.equal(
      rows[0].title,
      "Aprendizado da MAVI: 1 aprendizado novo para conferir",
    );
    assert.equal(rows[0].link, "/mavi#aprendizado");
    assert.equal((await inbox("copilot_lessons")).length, 0);
  },
);

await check(
  "quem deixou de ser líder ou foi desativado não recebe",
  async () => {
    await clear();
    await sql(`update memberships set role = 'member' where user_id = $1`, [
      manager,
    ]);
    await sql(`update memberships set active = false where user_id = $1`, [
      outsiderManager,
    ]);
    await store("mavi_learning_store", [
      add("Responda com a data no formato dd/mm."),
    ]);
    assert.equal((await inbox("mavi_lessons")).length, 0);
    await store("ai_learning_store", [
      add("Prazo de vídeo nunca é menor que 3 dias úteis."),
    ]);
    assert.deepEqual(
      (await inbox("copilot_lessons")).map((r) => r.user_id),
      [admin2],
    );
  },
);

await check("dois lotes em sequência: dois avisos", async () => {
  await clear();
  await store("ai_learning_store", [add("Lote um do Copiloto.")]);
  await store("ai_learning_store", [add("Lote dois do Copiloto.")]);
  const rows = await inbox("copilot_lessons");
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((r) => r.body).sort(), [
    "Lote dois do Copiloto.",
    "Lote um do Copiloto.",
  ]);
});

console.log(`\n${passed} passed`);
