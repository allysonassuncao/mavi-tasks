// MAVI · tarefas longas (migration 20270111090000_mavi_long_tasks): o plano
// com o teto da empresa, a confirmação, a vez de cada fatia no servidor, as
// etapas com o gasto e as fontes, parar entregando o que já tem, o fim na
// conversa com o aviso e o teto no Painel.
import assert from "node:assert/strict";
import { createTestDatabase } from "./database-fixture.mjs";

const db = await createTestDatabase();
const uid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const [A, admin, ana, bia, c1, c2] = [1, 10, 12, 13, 21, 22].map(uid);
await db.query(`insert into auth.users select unnest($1::uuid[])`, [[admin, ana, bia]]);
await db.query(`insert into companies(id,name) values($1,'Make')`, [A]);
await db.query(
  `insert into memberships(company_id,user_id,name,role,active) values ($1,$2,'Ana Admin','admin',true),($1,$3,'Ana Souza','member',true),($1,$4,'Bia Lima','member',true)`,
  [A, admin, ana, bia],
);
await db.query(`insert into clients(id,company_id,name) values ($1,$3,'5022'),($2,$3,'5017')`, [c1, c2, A]);
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
const fails = async (user, text, args, pattern) => {
  await assert.rejects(() => q(user, text, args), pattern);
};
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
const conversation = async (user) =>
  (await one(user, "select public.ai_run_start($1,null,'Passagem de clientes','assistant','{}'::jsonb)", [A]))
    .conversation;
const steps = (list) => JSON.stringify(list);
const create = (user, conv, list, estimate = 4.2) =>
  one(
    user,
    "select public.ai_task_create($1,$2,'Passagem de clientes','Montar a passagem',$3::jsonb,$4::jsonb,$5,'assistant')",
    [A, conv, steps(list), JSON.stringify({ title: "Resumo da carteira", instructions: "Uma tabela" }), estimate],
  );

let task;
let conv;
await check("o plano nasce com o teto da empresa; só a dona da conversa vê", async () => {
  conv = await conversation(admin);
  const made = await create(admin, conv, [
    { title: "Cliente 5022", instructions: "Briefing e pendências", client_ids: [c1] },
    { title: "Cliente 5017", instructions: "Briefing e pendências", client_ids: [c2, "x"] },
  ]);
  task = made.id;
  assert.equal(Number(made.cap), 10);
  const t = await one(admin, "select public.ai_task_get($1)", [task]);
  assert.equal(t.status, "proposed");
  assert.equal(Number(t.estimate), 4.2);
  assert.deepEqual(t.steps.map((s) => [s.ord, s.title, s.client_ids]), [
    [1, "Cliente 5022", [c1]],
    [2, "Cliente 5017", [c2]],
  ]);
  assert.equal(t.closing.title, "Resumo da carteira");
  assert.equal(await one(bia, "select public.ai_task_get($1)", [task]), null);
  // A tabela não se lê direto: só pelas funções.
  await fails(bia, "select id from ai_tasks", [], /permission denied/);
  // Outra pessoa não monta tarefa na conversa de alguém.
  await fails(bia, "select public.ai_task_create($1,$2,'X x x','g','[{\"title\":\"a\"}]'::jsonb,null,0,'assistant')", [A, conv], /Só quem começou/);
});

await check("clientes que a pessoa não acessa ficam de fora do plano", async () => {
  const mine = await conversation(bia);
  await fails(
    bia,
    "select public.ai_task_create($1,$2,'Passagem','g',$3::jsonb,null,1,'assistant')",
    [A, mine, steps([{ title: "5022", instructions: "", client_ids: [c1] }])],
    /cliente que você não acessa/,
  );
  // Sem cliente, pode.
  const ok = await one(
    bia,
    "select public.ai_task_create($1,$2,'Resumo geral','g',$3::jsonb,null,1,'assistant')",
    [A, mine, steps([{ title: "Carteira", instructions: "" }])],
  );
  assert.ok(ok.id);
});

await check("teto: só líderes mudam; vale o de quando a pessoa confirma", async () => {
  await fails(ana, "select public.ai_set_task_cap($1,5)", [A], /Só administradores e gestores/);
  await fails(admin, "select public.ai_set_task_cap($1,500)", [A], /US\$ 0,50 a US\$ 100/);
  assert.equal(Number(await one(admin, "select public.ai_set_task_cap($1,6.5)", [A])), 6.5);
  assert.equal(Number(await one(ana, "select public.ai_task_cap($1)", [A])), 6.5);
  const t = await one(admin, "select public.ai_task_confirm($1)", [task]);
  assert.equal(t.status, "running");
  assert.equal(Number(t.cap), 6.5);
  await fails(admin, "select public.ai_task_confirm($1)", [task], /já foi decidida/);
  assert.equal(Number(await one(admin, "select public.ai_set_task_cap($1,null)", [A])), 10);
});

await check("uma fatia por vez; etapas com gasto e fontes sem repetir", async () => {
  const claimed = await one(admin, "select public.ai_task_claim($1,300)", [task]);
  assert.equal(claimed.slices, 1);
  assert.equal(await one(admin, "select public.ai_task_claim($1,300)", [task]), null);
  assert.equal(await one(bia, "select public.ai_task_get($1)", [task]), null);
  await fails(bia, "select public.ai_task_step_start($1,1)", [task], /não encontrada/);
  const started = await one(admin, "select public.ai_task_step_start($1,1)", [task]);
  assert.equal(started.run, true);
  const src = [{ ref: "S1", type: "task", id: "t1", title: "Tarefa", date: null, client_id: c1 }];
  const saved = await one(admin, "select public.ai_task_step_save($1,1,'done','## 5022\\nTexto [S1]',null,0.4,$2::jsonb)", [
    task,
    JSON.stringify(src),
  ]);
  assert.equal(Number(saved.spent), 0.4);
  // A mesma fonte de novo não duplica.
  await q(admin, "select public.ai_task_step_start($1,2)", [task]);
  await q(admin, "select public.ai_task_step_save($1,2,'pending',null,null,0.1,$2::jsonb)", [task, JSON.stringify(src)]);
  await db.exec("reset role");
  const [row] = (await db.query("select spent_usd, jsonb_array_length(sources) n from ai_tasks where id = $1", [task])).rows;
  assert.equal(Number(row.spent_usd), 0.5);
  assert.equal(row.n, 1);
  // A fatia caiu no meio: a etapa que rodava volta para a fila na próxima.
  await q(admin, "select public.ai_task_step_start($1,2)", [task]);
  await db.exec("reset role");
  await db.query("update ai_tasks set lease_until = now() - interval '1 second' where id = $1", [task]);
  const again = await one(admin, "select public.ai_task_claim($1,300)", [task]);
  assert.deepEqual(again.steps.map((s) => s.status), ["done", "pending"]);
  assert.equal(again.steps[0].result, "## 5022\\nTexto [S1]");
  assert.equal(again.sources.length, 1);
  // Na tela, sem o texto das etapas.
  assert.equal((await one(admin, "select public.ai_task_get($1)", [task])).steps[0].result, undefined);
});

await check("três tentativas: a etapa fica de fora", async () => {
  for (let i = 0; i < 2; i++) {
    await q(admin, "select public.ai_task_step_start($1,2)", [task]);
    await q(admin, "select public.ai_task_step_save($1,2,'pending',null,'caiu',0,'[]'::jsonb)", [task]);
  }
  const r = await one(admin, "select public.ai_task_step_start($1,2)", [task]);
  assert.equal(r.run, false);
  const t = await one(admin, "select public.ai_task_get($1)", [task]);
  assert.equal(t.steps[1].status, "error");
});

await check("pausa (token venceu) e volta; parar entrega o que já tem", async () => {
  await q(admin, "select public.ai_task_release($1,'paused','O acesso venceu')", [task]);
  let t = await one(admin, "select public.ai_task_get($1)", [task]);
  assert.deepEqual([t.status, t.pause_reason, t.lease_until], ["paused", "O acesso venceu", null]);
  assert.deepEqual((await one(admin, "select public.ai_tasks_active($1)", [A])).map((x) => x.status), ["paused"]);
  t = await one(admin, "select public.ai_task_claim($1,300)", [task]);
  assert.equal(t.status, "running");
  assert.equal(t.pause_reason, null);
  t = await one(admin, "select public.ai_task_stop($1)", [task]);
  assert.equal(t.status, "stopping");
  // Uma pausa não desfaz o pedido para parar.
  await q(admin, "select public.ai_task_release($1,'paused','x')", [task]);
  assert.equal((await one(admin, "select public.ai_task_get($1)", [task])).status, "stopping");
});

await check("o fim entra na conversa com o card do documento e avisa", async () => {
  await fails(
    admin,
    "select public.ai_task_finish($1,'Pronto','[]'::jsonb,$2::jsonb,'[]'::jsonb,'done')",
    [task, JSON.stringify([{ id: "x", type: "bogus" }])],
    /Anexos da resposta inválidos/,
  );
  const doc = [
    { id: "doc-1-abc", ref: "D1", type: "canvas", canvas: { kind: "document", title: "Passagem", markdown: "# Passagem\n\nTexto" } },
  ];
  const message = await one(
    admin,
    "select public.ai_task_finish($1,'Pronto: [[D1]]','[]'::jsonb,$2::jsonb,'[{\"label\":\"Tarefa longa\"}]'::jsonb,'done')",
    [task, JSON.stringify(doc)],
  );
  const [m] = await q(admin, "select role, content, artifacts from ai_messages where id = $1", [message]);
  assert.equal(m.role, "assistant");
  assert.equal(m.artifacts[0].ref, "D1");
  const t = await one(admin, "select public.ai_task_get($1)", [task]);
  // Parada pela pessoa: a entrega fica como cancelada, com a resposta.
  assert.deepEqual([t.status, Number(t.message)], ["cancelled", Number(message)]);
  const inbox = await q(admin, "select kind, title, link from notifications where user_id = $1", [admin]);
  assert.deepEqual(inbox, [
    { kind: "ai_answer", title: "A MAVI entregou o que já tinha da tarefa longa", link: `/mavi/conversas/${conv}` },
  ]);
  await fails(admin, "select public.ai_task_finish($1,'x','[]'::jsonb,'[]'::jsonb,'[]'::jsonb,'done')", [task], /já terminou/);
  await db.exec("reset role");
  const sent = (await db.query("select topic, payload from realtime.messages where event = 'ai_task' order by id desc limit 1")).rows[0];
  assert.equal(sent.topic, `mavi:inbox:${A}:${admin}`);
  assert.deepEqual([sent.payload.id, sent.payload.status, sent.payload.total], [task, "cancelled", 2]);
});

await check("o card da tarefa vale nas respostas salvas", async () => {
  const card = [{ id: "task-card-1", ref: "T1", type: "task", task }];
  await q(admin, "select public.ai_save_turn($1,$2,'{}'::jsonb,'assistant','Pergunta','Plano [[T1]]','[]'::jsonb,'[]'::jsonb,$3::jsonb)", [
    A,
    conv,
    JSON.stringify(card),
  ]);
  // O card inválido sai; a pergunta e a resposta ficam.
  await q(admin, "select public.ai_save_turn($1,$2,'{}'::jsonb,'assistant','Pergunta','Plano','[]'::jsonb,'[]'::jsonb,$3::jsonb)", [
    A,
    conv,
    JSON.stringify([{ id: "task-card-2", ref: "T2", type: "task", task: "nope" }]),
  ]);
  const [last] = await q(
    admin,
    "select content, artifacts from ai_messages where conversation_id = $1 and role = 'assistant' order by id desc limit 1",
    [conv],
  );
  assert.equal(last.content, "Plano");
  assert.deepEqual(last.artifacts, []);
});

await check("um plano novo substitui o que esperava confirmação; no máximo 3 rodando", async () => {
  const c = await conversation(ana);
  const first = await create(ana, c, [{ title: "Carteira", instructions: "" }]);
  const second = await create(ana, c, [{ title: "Carteira", instructions: "" }]);
  assert.equal((await one(ana, "select public.ai_task_get($1)", [first.id])).status, "cancelled");
  await q(ana, "select public.ai_task_confirm($1)", [second.id]);
  for (let i = 0; i < 2; i++) {
    const x = await create(ana, await conversation(ana), [{ title: "Carteira", instructions: "" }]);
    await q(ana, "select public.ai_task_confirm($1)", [x.id]);
  }
  await fails(ana, "select public.ai_task_create($1,$2,'Mais uma','g','[{\"title\":\"a\"}]'::jsonb,null,0,'assistant')", [
    A,
    await conversation(ana),
  ], /3 tarefas longas em andamento/);
  // A média das etapas feitas entra na estimativa (só de tarefas concluídas).
  const basis = await one(ana, "select public.ai_task_basis($1)", [A]);
  assert.equal(basis.steps, 0);
});

console.log(`\n${passed} verificações de tarefas longas passaram.`);
