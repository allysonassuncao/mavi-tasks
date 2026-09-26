// IA do MAVI · fase 2 (migration 20261022090000_ai_assistant): conversas
// salvas (só quem começou continua), compartilhamento só com quem já veria as
// fontes citadas (com aviso na caixa de entrada), limites mensais e relatório
// de consumo para líderes.
import assert from "node:assert/strict";
import { createTestDatabase } from "./database-fixture.mjs";

const db = await createTestDatabase();
const uid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const [A, admin, teamMember, outsider, manager] = [1, 10, 11, 12, 13].map(uid);
await db.query(`insert into auth.users select unnest($1::uuid[])`, [
  [admin, teamMember, outsider, manager],
]);
await db.query(`insert into companies(id,name) values($1,'Make')`, [A]);
await db.query(
  `insert into memberships(company_id,user_id,name,role,active) values
   ($1,$2,'Ana Admin','admin',true),($1,$3,'Bruno Equipe','member',true),
   ($1,$4,'Carla Fora','member',true),($1,$5,'Gabi Gestora','manager',true)`,
  [A, admin, teamMember, outsider, manager],
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
const sees = async (user, table, where, args) => {
  await as(user);
  return (await db.query(`select 1 from ${table} where ${where}`, args)).rows
    .length;
};
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
const team = await rpc("create_team", [A, "Equipe A", [teamMember]]);
const client = await rpc("create_client", [A, "4282", "", [team]]);
const meetingSource = (id) => ({
  ref: "S1",
  type: "meeting",
  id,
  title: "Alinhamento",
  client_id: client,
});

let conversation;
await check("primeira pergunta abre a conversa; a seguinte entra nela", async () => {
  await as(teamMember);
  conversation = await rpc("ai_save_turn", [
    A,
    null,
    { client },
    "meetings",
    "  Qual   a verba\n do cliente?  ",
    "A verba é 3 mil [S1].",
    JSON.stringify([meetingSource(uid(90))]),
    JSON.stringify([{ label: "Buscando “verba”", detail: "1 trecho" }]),
  ]);
  await as(teamMember);
  assert.equal(
    await rpc("ai_save_turn", [A, conversation, {}, "meetings", "E outubro?", "Igual.", "[]", "[]"]),
    conversation,
  );
  const [c] = await sql(`select title, scope, module, owner_id from ai_conversations where id=$1`, [conversation]);
  assert.deepEqual(
    [c.title, c.scope, c.module, c.owner_id],
    ["Qual a verba do cliente?", { client }, "meetings", teamMember],
  );
  const msgs = await sql(`select role, content from ai_messages where conversation_id=$1 order by id`, [conversation]);
  assert.deepEqual(
    msgs.map((m) => m.role),
    ["user", "assistant", "user", "assistant"],
  );
});

await check("só quem começou continua, renomeia, apaga e compartilha", async () => {
  await as(admin);
  await assert.rejects(
    () => rpc("ai_save_turn", [A, conversation, {}, "x", "Oi", "Olá", "[]", "[]"]),
    /Só quem começou/,
  );
  await as(admin);
  await assert.rejects(() => rpc("ai_rename_conversation", [conversation, "X"]), /Só quem começou/);
  await as(admin);
  await assert.rejects(() => rpc("ai_share_conversation", [conversation, [outsider]]), /Só quem começou/);
  await as(teamMember);
  await rpc("ai_rename_conversation", [conversation, "Verba de outubro"]);
  assert.equal((await sql(`select title from ai_conversations where id=$1`, [conversation]))[0].title, "Verba de outubro");
});

await check("cada um vê só as próprias conversas (líder também)", async () => {
  assert.equal(await sees(teamMember, "ai_messages", "conversation_id=$1", [conversation]), 4);
  assert.equal(await sees(admin, "ai_conversations", "id=$1", [conversation]), 0);
  assert.equal(await sees(outsider, "ai_messages", "conversation_id=$1", [conversation]), 0);
});

await check("compartilhar: recusa quem não veria a fonte; aceita quem veria; avisa na caixa de entrada", async () => {
  await as(teamMember);
  const r = await rpc("ai_share_conversation", [conversation, [outsider, manager, teamMember]]);
  assert.deepEqual(r.shared, [manager]);
  assert.deepEqual(r.refused, [{ user: outsider, reason: "não tem acesso a alguma fonte citada" }]);
  assert.equal(await sees(manager, "ai_messages", "conversation_id=$1", [conversation]), 4);
  assert.equal(await sees(outsider, "ai_conversations", "id=$1", [conversation]), 0);
  const [n] = await sql(`select kind, user_id, actor_id, title, body, link, task_id from notifications where kind='ai_share'`);
  assert.deepEqual(
    [n.user_id, n.actor_id, n.title, n.body, n.link, n.task_id],
    [manager, teamMember, "Bruno Equipe compartilhou uma conversa da IA", "Verba de outubro", `/visao-geral?conversa=${conversation}`, null],
  );
  // Quem recebe vê a lista de com quem foi compartilhada, mas não continua.
  assert.equal(await sees(manager, "ai_conversation_shares", "conversation_id=$1", [conversation]), 1);
  await as(manager);
  await assert.rejects(
    () => rpc("ai_save_turn", [A, conversation, {}, "x", "Oi", "Olá", "[]", "[]"]),
    /Só quem começou/,
  );
});

await check("tarefa citada: só quem vê a tarefa recebe", async () => {
  await as(admin);
  const product = await rpc("create_product", [A, "Make Ads"]);
  const contract = await rpc("create_contract", [A, client, product, "Make Ads", team]);
  const [{ id: task }] = await sql(
    `insert into tasks(company_id, contract_id, title, assignee_id, creator_id, due_date, original_due_date)
     values ($1,$2,'Criativos',$3,$3,'2026-10-05','2026-10-05') returning id`,
    [A, contract, admin],
  );
  await as(admin);
  const own = await rpc("ai_save_turn", [
    A, null, {}, "assistant", "Tarefas?", "Uma [S1].",
    JSON.stringify([{ ref: "S1", type: "task", id: task, title: "Criativos", client_id: client }]), "[]",
  ]);
  await as(admin);
  const r = await rpc("ai_share_conversation", [own, [teamMember, manager]]);
  assert.deepEqual(r.shared, [manager]);
  assert.equal(r.refused[0].user, teamMember);
});

await check("parar de compartilhar tira o acesso", async () => {
  await as(teamMember);
  await rpc("ai_share_conversation", [conversation, []]);
  assert.equal(await sees(manager, "ai_conversations", "id=$1", [conversation]), 0);
});

await check("apagar a conversa apaga as mensagens", async () => {
  await as(teamMember);
  await rpc("ai_delete_conversation", [conversation]);
  assert.equal((await sql(`select count(*)::int n from ai_messages where conversation_id=$1`, [conversation]))[0].n, 0);
});

await check("limites: só líderes definem; aviso aos 80%, bloqueio aos 100%", async () => {
  await as(teamMember);
  await assert.rejects(() => rpc("ai_set_limit", [A, "company", null, 10]), /Só administradores e gestores/);
  await as(manager);
  await rpc("ai_set_limit", [A, "company", null, 10]);
  await as(manager);
  await rpc("ai_set_limit", [A, "client", client, 5]);
  await as(manager);
  await rpc("ai_set_limit", [A, "user", teamMember, 100]);
  await as(teamMember);
  assert.deepEqual(await rpc("ai_check_limits", [A, client, null, null]), { blocked: false, message: null, warnings: [] });
  await as(teamMember);
  await rpc("ai_log_usage", [A, "meetings", "ask", client, null, null, null, "m", 1, 1, 0, 0, 0, 4.2]);
  await as(teamMember);
  const warn = await rpc("ai_check_limits", [A, client, null, null]);
  assert.equal(warn.blocked, false);
  assert.deepEqual(warn.warnings, ["O uso de IA deste cliente está em 84% do limite do mês."]);
  // Fora do cliente, o limite dele não vale.
  await as(teamMember);
  assert.deepEqual((await rpc("ai_check_limits", [A, null, null, null])).warnings, []);
  await as(teamMember);
  await rpc("ai_log_usage", [A, "meetings", "ask", client, null, null, null, "m", 1, 1, 0, 0, 0, 1]);
  await as(teamMember);
  const block = await rpc("ai_check_limits", [A, client, null, null]);
  assert.equal(block.blocked, true);
  assert.equal(block.message, "O limite mensal de IA deste cliente (US$ 5,00) foi atingido. Fale com um administrador ou gestor.");
  // Tirar o limite libera.
  await as(manager);
  await rpc("ai_set_limit", [A, "client", client, null]);
  await as(teamMember);
  assert.equal((await rpc("ai_check_limits", [A, client, null, null])).blocked, false);
});

await check("limites e consumo: só líderes leem; relatório por pessoa, cliente e módulo", async () => {
  assert.equal(await sees(teamMember, "ai_limits", "true", []), 0);
  await as(teamMember);
  await assert.rejects(() => rpc("ai_usage_report", [A, "2026-01-01", "2099-12-31"]), /Sem permissão/);
  await as(admin);
  const r = await rpc("ai_usage_report", [A, "2026-01-01", "2099-12-31"]);
  assert.equal(Number(r.total.cost), 5.2);
  assert.equal(r.total.asks, 2);
  assert.deepEqual(r.by_user.map((x) => [x.id, Number(x.cost), x.asks]), [[teamMember, 5.2, 2]]);
  assert.deepEqual(r.by_client.map((x) => x.id), [client]);
  assert.deepEqual(r.by_module.map((x) => x.id), ["meetings"]);
  const company = r.limits.find((l) => l.type === "company");
  assert.deepEqual([Number(company.monthly_usd), Number(company.month_spent)], [10, 5.2]);
});

await db.close();
console.log(`\n${passed} verificações do assistente aprovadas.`);
