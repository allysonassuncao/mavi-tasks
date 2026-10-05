// Alterações em massa e visões da lista (migration 20261117090000_task_bulk_edit):
// bulk_update_tasks aplica a mesma regra de cada tarefa a várias de uma vez
// (a que não pode mudar fica de fora com o motivo), a revisão não muda nada,
// o lote manda um aviso só, undo_task_bulk desfaz, e task_views é de cada um.
import assert from "node:assert/strict";
import { createTestDatabase } from "./database-fixture.mjs";

const db = await createTestDatabase();
const uid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const [A, admin, ana, bia, caio, out] = [1, 10, 11, 12, 13, 14].map(uid);
await db.query(`insert into auth.users select unnest($1::uuid[])`, [
  [admin, ana, bia, caio, out],
]);
await db.query(`insert into companies(id,name) values($1,'Empresa A')`, [A]);
await db.query(
  `insert into memberships(company_id,user_id,name,role) values
   ($1,$2,'Ana Admin','admin'),($1,$3,'Ana Souza','member'),
   ($1,$4,'Bia Lima','member'),($1,$5,'Caio Rocha','member'),
   ($1,$6,'Otto Fora','member')`,
  [A, admin, ana, bia, caio, out],
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
const bulk = (user, ids, change, preview = false) =>
  as(user).then(() =>
    rpc("bulk_update_tasks", [A, ids, JSON.stringify(change), preview]),
  );
const task = async (id) =>
  (
    await sql(
      "select status,assignee_id,team_id,due_date::text due,revision,version,internal_approved_by from tasks where id=$1",
      [id],
    )
  )[0];
const companyNotices = async () =>
  Number(
    (
      await sql("select count(*) n from realtime.messages where topic=$1", [
        `mavi:company:${A}`,
      ])
    )[0].n,
  );

await as(admin);
const design = await rpc("create_team", [A, "Design", [ana, bia, caio]]);
const client = await rpc("create_client", [A, "Clínica Sorriso", ""]);
const product = await rpc("create_product", [A, "Social"]);
const contract = await rpc("create_contract", [A, client, product, "Social", design]);
const other = await rpc("create_client", [A, "Padaria", ""]);
const otherContract = await rpc("create_contract", [A, other, product, "Padaria"]);
const newTask = (user, title, assignee, due = "2026-10-02", k = contract, start = null) =>
  as(user).then(() =>
    rpc("create_task", [A, k, title, assignee, due, null, null, "", "normal", 60, false, null, start]),
  );
const t1 = await newTask(admin, "Calendário de outubro", ana);
const t2 = await newTask(admin, "Campanha Outubro Rosa", ana);
const t3 = await newTask(admin, "Relatório mensal", ana);
const byAna = await newTask(ana, "Stories da semana", ana);
const hidden = await newTask(admin, "Tarefa do Otto", out);

await check("a revisão mostra o resultado e não muda nada", async () => {
  const notices = await companyNotices();
  const r = await bulk(admin, [t1, t2, t3], { kind: "assignee", value: bia }, true);
  assert.equal(r.preview, true);
  assert.equal(r.applied, 3);
  assert.deepEqual(
    r.results.map((x) => [x.ok, x.before.assignee_id, x.after.assignee_id]),
    [
      [true, ana, bia],
      [true, ana, bia],
      [true, ana, bia],
    ],
  );
  for (const id of [t1, t2, t3]) assert.equal((await task(id)).assignee_id, ana);
  assert.equal(await companyNotices(), notices);
  assert.equal(
    Number((await sql("select count(*) n from task_bulk_operations"))[0].n),
    0,
  );
});

let reassign;
await check("troca o responsável de várias, com um aviso só", async () => {
  const notices = await companyNotices();
  const r = await bulk(admin, [t1, t2, t2], { kind: "assignee", value: caio });
  reassign = r.operation;
  assert.equal(r.applied, 2);
  assert.equal(r.results.length, 2); // repetidas contam uma vez
  assert.equal((await task(t1)).assignee_id, caio);
  assert.equal((await task(t2)).assignee_id, caio);
  // Um aviso no tópico da empresa, em vez de um por tarefa, evento e comentário.
  const sent = await sql(
    "select payload from realtime.messages where topic=$1 order by id desc limit 1",
    [`mavi:company:${A}`],
  );
  assert.equal((await companyNotices()) - notices, 1);
  assert.equal(sent[0].payload.kind, "tasks");
  assert.deepEqual(new Set(sent[0].payload.tasks), new Set([t1, t2]));
  assert.ok(sent[0].payload.users.includes(ana) && sent[0].payload.users.includes(caio));
  // Quem recebeu ganha um aviso agrupado.
  const inbox = await sql(
    "select kind,title,body,link,task_id from notifications where user_id=$1",
    [caio],
  );
  assert.equal(inbox.length, 1);
  assert.equal(inbox[0].kind, "tasks_assigned");
  assert.equal(inbox[0].title, "Ana Admin passou 2 tarefas para você");
  assert.equal(inbox[0].task_id, null);
  assert.match(inbox[0].link, /^\/tarefas\?escopo=mine&lote=/);
});

await check("quem já é o responsável fica de fora com o motivo", async () => {
  const r = await bulk(admin, [t1, t3], { kind: "assignee", value: caio });
  assert.deepEqual(
    r.results.map((x) => [x.ok, x.reason]),
    [
      [false, "Já está com Caio Rocha"],
      [true, null],
    ],
  );
});

await check("cada pessoa só muda o que já poderia mudar uma por uma", async () => {
  // Ana criou "Stories"; t1 ela acompanha (já foi a responsável), e
  // participante também muda o prazo (migração 20270110090000). A do Otto
  // ela nem vê.
  const due1 = (await task(t1)).due;
  const r = await bulk(ana, [byAna, t1, hidden], { kind: "shift", value: 1, reason: "Cliente pediu" });
  assert.deepEqual(
    r.results.map((x) => [x.ok, x.reason]),
    [
      [true, null],
      [true, null],
      [false, "Tarefa não encontrada"],
    ],
  );
  await bulk(admin, [t1], { kind: "due", value: due1, reason: "Voltar ao prazo" });
  // Não vê a tarefa: não recebe nem o título.
  assert.equal(r.results[2].title, undefined);
  assert.equal((await task(byAna)).due, "2026-10-05");
  // Responsável: a regra do transition_task (Ana não é responsável, nem criou, nem é gestora).
  await as(admin);
  await rpc("transition_task", [t3, (await task(t3)).version, "move", "", "progress", ana]);
  const moved = await bulk(ana, [t3], { kind: "status", value: "review" });
  assert.equal(moved.applied, 1);
  const ruled = await bulk(ana, [t3], { kind: "assignee", value: bia });
  assert.equal(ruled.applied, 1);
  const denied = await bulk(ana, [t3], { kind: "status", value: "progress" });
  assert.equal(denied.applied, 0);
  assert.match(denied.results[0].reason, /Somente o responsável/);
});

await check("mudar só o prazo não apaga aprovações nem muda o status", async () => {
  const before = await task(t3);
  assert.equal(before.status, "review");
  const r = await bulk(admin, [t3], { kind: "shift", value: 1, reason: "Cliente atrasou o material" });
  assert.equal(r.applied, 1);
  const after = await task(t3);
  assert.equal(after.status, "review");
  assert.equal(after.revision, before.revision);
  // 02/10 é sexta: um dia útil depois é segunda, 05/10.
  assert.equal(after.due, "2026-10-05");
  const [event] = await sql(
    "select detail from task_events where task_id=$1 and action='due_changed'",
    [t3],
  );
  assert.deepEqual(event.detail, {
    old_due: "2026-10-02",
    new_due: "2026-10-05",
    reason: "Cliente atrasou o material",
    source: "bulk",
  });
  const back = await bulk(admin, [t3], { kind: "shift", value: -1, reason: "Material chegou" });
  assert.equal(back.applied, 1);
  assert.equal((await task(t3)).due, "2026-10-02");
});

await check("data fixa antes do início fica de fora", async () => {
  const late = await newTask(admin, "Landing de Natal", ana, "2026-10-20", contract, "2026-10-10");
  const r = await bulk(admin, [late, t1], { kind: "due", value: "2026-10-06", reason: "Campanha antecipada" });
  assert.deepEqual(
    r.results.map((x) => [x.ok, x.reason]),
    [
      [false, "O prazo ficaria antes do início (10/10)"],
      [true, null],
    ],
  );
  assert.equal((await task(t1)).due, "2026-10-06");
});

await check("status que pede descrição segue a regra e vira comentário", async () => {
  const none = await bulk(admin, [t1], { kind: "status", value: "correction" });
  assert.equal(none.results[0].reason, "Descreva a correção necessária");
  const r = await bulk(admin, [t1], {
    kind: "status",
    value: "correction",
    note: "Trocar a paleta",
  });
  assert.equal(r.applied, 1);
  assert.equal((await task(t1)).status, "correction");
  const comments = await sql("select body from comments where task_id=$1", [t1]);
  assert.ok(comments.some((c) => c.body.includes("Trocar a paleta")));
  const delivered = await bulk(admin, [t2], { kind: "status", value: "done" });
  assert.match(delivered.results[0].reason, /exige validação/);
});

await check("distribuir na equipe espalha por quem tem menos tarefas", async () => {
  const fresh = [];
  for (let i = 0; i < 3; i++) fresh.push(await newTask(admin, `Post ${i}`, admin));
  const loads = async () =>
    Object.fromEntries(
      (
        await sql(
          "select assignee_id, count(*)::int n from tasks where status<>'done' and assignee_id = any($1) group by 1",
          [[ana, bia, caio]],
        )
      ).map((r) => [r.assignee_id, r.n]),
    );
  const before = await loads();
  const r = await bulk(admin, fresh, { kind: "team", value: design });
  assert.equal(r.applied, 3);
  for (const id of fresh) {
    const t = await task(id);
    assert.ok([ana, bia, caio].includes(t.assignee_id));
    assert.equal(t.team_id, design);
  }
  // Cada uma foi para quem tinha menos naquele momento.
  const counts = { ...before };
  for (const x of r.results) {
    const min = Math.min(...[ana, bia, caio].map((u) => counts[u] ?? 0));
    assert.equal(counts[x.after.assignee_id] ?? 0, min);
    counts[x.after.assignee_id] = (counts[x.after.assignee_id] ?? 0) + 1;
  }
  const outside = await newTask(admin, "Pão de fermentação", admin, "2026-10-02", otherContract);
  const refused = await bulk(admin, [outside], { kind: "team", value: design });
  assert.equal(refused.results[0].reason, "A equipe Design não atende este cliente");
});

await check("desfazer volta o lote e só quem fez pode, uma vez", async () => {
  await as(bia);
  await assert.rejects(rpc("undo_task_bulk", [reassign]), /não encontrada/);
  // t1 mudou de status depois do lote: fica como está.
  await as(admin);
  const r = await rpc("undo_task_bulk", [reassign]);
  assert.deepEqual(r, { restored: 1, kept: 1 });
  assert.equal((await task(t2)).assignee_id, ana);
  assert.equal((await task(t1)).assignee_id, caio);
  const [undone] = await sql(
    "select action from task_events where task_id=$1 order by created_at desc, action limit 1",
    [t2],
  );
  assert.equal(undone.action, "bulk_undone");
  // O aviso de "passou 2 tarefas" some da caixa de quem recebeu.
  assert.equal(
    Number(
      (
        await sql("select count(*) n from notifications where user_id=$1 and link like $2", [
          caio,
          `%lote=${reassign}`,
        ])
      )[0].n,
    ),
    0,
  );
  await assert.rejects(rpc("undo_task_bulk", [reassign]), /já foi desfeita/);
});

await check("limite de 500 tarefas por vez", async () => {
  const many = Array.from({ length: 501 }, (_, i) => uid(1000 + i));
  await assert.rejects(bulk(admin, many, { kind: "shift", value: 1 }), /no máximo 500/);
  await assert.rejects(bulk(admin, [t1], { kind: "shift", value: 0 }), /de 1 a 365/);
  await assert.rejects(bulk(out, [], { kind: "shift", value: 1 }), /ao menos uma/);
});

await check("mudar o status escolhe quem fica com cada tarefa", async () => {
  // Migração 20270421090000: a sugestão do novo status, uma pessoa ou manter.
  const s1 = await newTask(bia, "Post do Dia das Crianças", ana);
  const s2 = await newTask(caio, "Reels da clínica", ana);
  const s3 = await newTask(bia, "Banner do site", ana);
  const r = await bulk(admin, [s1, s2], { kind: "status", value: "review", assignee: "suggested" });
  assert.deepEqual(
    r.results.map((x) => [x.ok, x.before.assignee_id, x.after.assignee_id]),
    [
      [true, ana, bia],
      [true, ana, caio],
    ],
  );
  assert.equal((await task(s1)).assignee_id, bia);
  // Quem recebeu ganha o aviso agrupado, dizendo o novo status.
  const [notice] = await sql(
    "select title from notifications where user_id=$1 and kind='tasks_assigned' and link like $2",
    [bia, `%lote=${r.operation}`],
  );
  assert.equal(notice.title, "Ana Admin moveu para Em validação e passou 1 tarefa para você");
  // Voltar para Correção sugere quem executou por último.
  const back = await bulk(admin, [s1], {
    kind: "status",
    value: "correction",
    note: "Faltou o logo",
    assignee: "suggested",
  });
  assert.equal(back.results[0].after.assignee_id, ana);
  // Uma pessoa para todas.
  const person = await bulk(admin, [s3], { kind: "status", value: "review", assignee: caio });
  assert.equal(person.results[0].after.assignee_id, caio);
  // Sem escolha (ou "keep"), cada uma fica com o responsável que tem.
  const kept = await bulk(admin, [s2], { kind: "status", value: "progress" });
  assert.equal(kept.results[0].after.assignee_id, caio);
  // Projeto validado pelo supervisor: vai para o supervisor da equipe.
  await as(admin);
  await rpc("update_team", [design, "Design", [ana, bia], [caio]]);
  const project = await rpc("create_project", [A, contract, "Validação pelo supervisor", null, true, "supervisor"]);
  const s4 = await as(bia).then(() =>
    rpc("create_task", [A, contract, "Folder da clínica", ana, "2026-10-02", project, design]),
  );
  const sup = await bulk(admin, [s4], { kind: "status", value: "review", assignee: "suggested" });
  assert.equal(sup.results[0].after.assignee_id, caio);
  await as(admin);
  await rpc("update_team", [design, "Design", [ana, bia, caio], []]);
  await assert.rejects(
    bulk(admin, [s2], { kind: "status", value: "review", assignee: out.replace("4000", "4999") }),
    /responsável ativo/,
  );
  await assert.rejects(
    bulk(admin, [s2], { kind: "status", value: "review", assignee: "ninguém" }),
    /responsável ativo/,
  );
});

await check("visões são de cada pessoa e uma abre por padrão", async () => {
  await as(ana);
  const first = await rpc("save_task_view", [A, null, "Pacotes do dia", JSON.stringify({ group: "pack" }), true]);
  const second = await rpc("save_task_view", [A, null, "Carga da equipe", JSON.stringify({ group: "assignee", then: "due" }), true]);
  const mine = (await db.query("select name,is_default from task_views order by name")).rows;
  assert.deepEqual(mine, [
    { name: "Carga da equipe", is_default: true },
    { name: "Pacotes do dia", is_default: false },
  ]);
  await as(bia);
  assert.equal((await db.query("select * from task_views")).rows.length, 0);
  await assert.rejects(
    rpc("save_task_view", [A, first.id, "Minha agora", "{}", false]),
    /não encontrada/,
  );
  await rpc("delete_task_view", [second.id]);
  assert.equal(Number((await sql("select count(*) n from task_views"))[0].n), 2);
  await as(ana);
  await rpc("delete_task_view", [second.id]);
  assert.equal(Number((await sql("select count(*) n from task_views"))[0].n), 1);
});

console.log(`${passed} verificações de alteração em massa passaram.`);
