// Desativar usuário com fila (migration 20270616090000_deactivate_member_handover):
// update_member só desativa quem é responsável e/ou criador de tarefas não
// entregues ou de repetições ativas com p_handover, um usuário ativo, que fica
// no lugar da pessoa em cada papel (mesmo status, cronômetro pausado); quem
// recebe ganha um aviso só. member_open_work conta a fila para o formulário.
import assert from "node:assert/strict";
import { createTestDatabase } from "./database-fixture.mjs";

const db = await createTestDatabase();
const uid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const [A, admin, ana, bia, caio, dani] = [1, 10, 11, 12, 13, 14].map(uid);
await db.query(`insert into auth.users select unnest($1::uuid[])`, [
  [admin, ana, bia, caio, dani],
]);
await db.query(`insert into companies(id,name) values($1,'Empresa A')`, [A]);
await db.query(
  `insert into memberships(company_id,user_id,name,role) values
   ($1,$2,'Ana Admin','admin'),($1,$3,'Ana Souza','member'),
   ($1,$4,'Bia Lima','member'),($1,$5,'Caio Rocha','member'),
   ($1,$6,'Dani Reis','member')`,
  [A, admin, ana, bia, caio, dani],
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
const update = (who, user, name, active, handover) =>
  as(who).then(() =>
    db.query(
      "select public.update_member($1,$2,$3,'member',$4,'{}'::uuid[],$5)",
      [A, user, name, active, handover],
    ),
  );
const active = async (user) =>
  (
    await sql(
      "select active from memberships where company_id=$1 and user_id=$2",
      [A, user],
    )
  )[0].active;

await as(admin);
const design = await rpc("create_team", [A, "Design", [ana, bia, caio]]);
const client = await rpc("create_client", [A, "Clínica Sorriso", ""]);
const product = await rpc("create_product", [A, "Social"]);
const contract = await rpc("create_contract", [A, client, product, "Social", design]);
const newTask = (user, title, assignee, repeat = null) =>
  as(user).then(() =>
    rpc("create_task", [
      A, contract, title, assignee, "2026-12-02", null, null, "", "normal", 60,
      false, null, null, "[]", repeat,
    ]),
  );
const t1 = await newTask(admin, "Calendário de dezembro", ana);
const t2 = await newTask(ana, "Stories da semana", ana);
const t3 = await newTask(admin, "Relatório mensal", ana, "weekly");
const delivered = await newTask(ana, "Post entregue", ana);
const byAnaForBia = await newTask(ana, "Arte para a Bia", bia);
const repeatForBia = await newTask(ana, "Post semanal", bia, "weekly");
// t2 em validação; uma entregue (Ana criou e é a responsável: entrega direto).
await as(ana);
let [{ version }] = await sql("select version from tasks where id=$1", [t2]);
await as(ana);
await db.query("select public.transition_task($1,$2,'move','',$3)", [
  t2,
  version,
  "review",
]);
[{ version }] = await sql("select version from tasks where id=$1", [delivered]);
await as(ana);
await db.query("select public.transition_task($1,$2,'move','',$3)", [
  delivered,
  version,
  "done",
]);
// Cronômetro rodando em t1.
await sql(
  "insert into time_entries(company_id,task_id,user_id,started_at,source) values($1,$2,$3,now()-interval '20 minutes','timer')",
  [A, t1, ana],
);

await check("member_open_work conta a fila (só líderes)", async () => {
  await as(admin);
  const work = await rpc("member_open_work", [A, ana]);
  // t1, t3 (responsável), t2 (os dois), byAnaForBia e repeatForBia (criadora).
  assert.equal(work.tasks, 5);
  assert.equal(work.as_assignee, 3);
  assert.equal(work.as_creator, 3);
  assert.deepEqual(work.by_status, { progress: 4, review: 1 });
  assert.equal(work.recurrences, 2);
  await as(bia);
  await assert.rejects(rpc("member_open_work", [A, ana]), /Sem permissão/);
});

await check("sem novo responsável, não desativa", async () => {
  await assert.rejects(
    update(admin, ana, "Ana Souza", false, null),
    /Ana Souza tem 5 tarefas não entregues e 2 repetições na fila: escolha quem assume/,
  );
  assert.equal(await active(ana), true);
});

await check("o novo responsável precisa ser outro usuário ativo", async () => {
  await update(admin, dani, "Dani Reis", false, null); // fila vazia: desativa direto
  assert.equal(await active(dani), false);
  await assert.rejects(
    update(admin, ana, "Ana Souza", false, dani),
    /Escolha um usuário ativo/,
  );
  await assert.rejects(
    update(admin, ana, "Ana Souza", false, ana),
    /Escolha um usuário ativo/,
  );
  assert.equal(await active(ana), true);
});

await check("desativa e passa a fila para quem assume", async () => {
  await update(admin, ana, "Ana Souza", false, caio);
  assert.equal(await active(ana), false);
  const rows = await sql(
    "select id,status,assignee_id,creator_id from tasks where id = any($1) order by title",
    [[t1, t2, t3, delivered, byAnaForBia]],
  );
  const by = Object.fromEntries(rows.map((r) => [r.id, r]));
  // Mesmo status; Caio fica no lugar de Ana em cada papel.
  assert.deepEqual(by[t1], { id: t1, status: "progress", assignee_id: caio, creator_id: admin });
  assert.deepEqual(by[t2], { id: t2, status: "review", assignee_id: caio, creator_id: caio });
  assert.equal(by[t3].assignee_id, caio);
  assert.deepEqual(by[byAnaForBia], { id: byAnaForBia, status: "progress", assignee_id: bia, creator_id: caio });
  // A entregue fica como está.
  assert.equal(by[delivered].assignee_id, ana);
  assert.equal(by[delivered].creator_id, ana);
});

await check("repetição, cronômetro, histórico e aviso", async () => {
  const [r] = await sql(
    "select assignee_id,creator_id from task_recurrences where source_task_id=$1",
    [t3],
  );
  assert.deepEqual(r, { assignee_id: caio, creator_id: admin });
  const [r2] = await sql(
    "select assignee_id,creator_id from task_recurrences where source_task_id=$1",
    [repeatForBia],
  );
  assert.deepEqual(r2, { assignee_id: bia, creator_id: caio });
  const [e] = await sql(
    "select ended_at is not null as paused from time_entries where task_id=$1",
    [t1],
  );
  assert.equal(e.paused, true);
  const events = await sql(
    "select detail->>'from' f,detail->>'to' t,detail->>'assignee_to' a from task_events where task_id=$1 and actor_id=$2 and detail->>'assignee_from'=$3",
    [t2, admin, ana],
  );
  assert.deepEqual(events, [{ f: "review", t: "review", a: caio }]);
  const creatorEvents = await sql(
    "select task_id,detail->>'creator_to' c from task_events where action='creator_changed' and detail->>'creator_from'=$1 order by task_id",
    [ana],
  );
  assert.deepEqual(
    creatorEvents.map((e) => [e.task_id, e.c]),
    [t2, byAnaForBia, repeatForBia].sort().map((id) => [id, caio]),
  );
  const comments = await sql(
    "select body from comments where task_id=$1 and body like '%Usuário desativado: Ana Souza%'",
    [t2],
  );
  assert.equal(comments.length, 1);
  assert.match(comments[0].body, /Responsável alterado · Responsável: Caio Rocha · Criador: Caio Rocha/);
  const [onlyCreator] = await sql(
    "select body from comments where task_id=$1 and body like '%Usuário desativado%'",
    [byAnaForBia],
  );
  assert.match(onlyCreator.body, /Criador alterado · Criador: Caio Rocha/);
  const notes = await sql(
    "select title from notifications where user_id=$1 and kind='tasks_assigned'",
    [caio],
  );
  assert.deepEqual(notes, [
    {
      title:
        "Ana Admin desativou Ana Souza e passou para você 3 tarefas como responsável e 3 tarefas como criador",
    },
  ]);
});

await check("reativar não pede ninguém", async () => {
  await update(admin, ana, "Ana Souza", true, null);
  assert.equal(await active(ana), true);
});

console.log(`\n${passed} verificações passaram.`);
await db.close();
