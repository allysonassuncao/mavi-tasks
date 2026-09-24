// Programar repetição (migration 20260930180000_task_recurrence): a tarefa
// criada com repetição ganha uma cópia em cada data da série, aberta pela
// rotina mavi_private.run_task_recurrences (pg_cron em produção).
import assert from "node:assert/strict";
import { createTestDatabase } from "./database-fixture.mjs";

const db = await createTestDatabase();
const uid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const [A, admin, ana, bia, caio, outsider] = [1, 10, 11, 12, 13, 14].map(uid);
await db.query(`insert into auth.users select unnest($1::uuid[])`, [
  [admin, ana, bia, caio, outsider],
]);
await db.query(`insert into companies(id,name) values($1,'Empresa A')`, [A]);
await db.query(
  `insert into memberships(company_id,user_id,name,role) values
   ($1,$2,'Ana Admin','admin'),($1,$3,'Ana Social','member'),
   ($1,$4,'Bia Design','member'),($1,$5,'Caio Design','member'),
   ($1,$6,'Otto Outro','member')`,
  [A, admin, ana, bia, caio, outsider],
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
const next = async (frequency, anchor, after) =>
  (
    await sql(
      "select mavi_private.next_recurrence($1,$2::date,$3::date)::text as d",
      [frequency, anchor, after],
    )
  )[0].d;
const run = async (day) =>
  (
    await sql("select mavi_private.run_task_recurrences($1::date) as n", [day])
  )[0].n;
const today = (
  await sql("select mavi_private.company_today($1)::text as d", [A])
)[0].d;
const plus = async (days) =>
  (await sql("select ($1::date + $2::int)::text as d", [today, days]))[0].d;

await as(admin);
const design = await rpc("create_team", [A, "Design", [ana, bia, caio]]);
const client = await rpc("create_client", [A, "Cliente X", ""]);
const product = await rpc("create_product", [A, "Social"]);
const contract = await rpc("create_contract", [
  A,
  client,
  product,
  "Social X",
  design,
]);
const project = await rpc("create_project", [A, contract, "Lançamento", null]);
await rpc("save_task_template", [
  A,
  null,
  "Briefing",
  product,
  null,
  JSON.stringify([{ id: "rede", label: "Rede", type: "text", required: true }]),
  true,
]);

// create_task(company, contract, title, assignee, due, project, team,
//   description, priority, estimated, client_approval, parent, start, custom, repeat)
const create = (
  user,
  { assignee = ana, team = null, repeat = null, due = today } = {},
) =>
  as(user).then(() =>
    rpc("create_task", [
      A,
      contract,
      "Post do dia",
      assignee,
      due,
      project,
      team,
      "Legenda e arte",
      "high",
      90,
      false,
      null,
      null,
      JSON.stringify({ [`${templateId}.rede`]: "Instagram" }),
      repeat,
    ]),
  );
const [{ id: templateId }] = await sql("select id from task_templates");

await check("datas: todos os dias e dias úteis", async () => {
  assert.equal(await next("daily", "2026-09-25", "2026-09-25"), "2026-09-26");
  // Friday → Monday; Saturday → Monday.
  assert.equal(
    await next("weekdays", "2026-09-25", "2026-09-25"),
    "2026-09-28",
  );
  assert.equal(
    await next("weekdays", "2026-09-25", "2026-09-26"),
    "2026-09-28",
  );
  assert.equal(
    await next("weekdays", "2026-09-25", "2026-09-28"),
    "2026-09-29",
  );
});

await check("datas: semanal e quinzenal contam do início", async () => {
  assert.equal(await next("weekly", "2026-09-24", "2026-09-24"), "2026-10-01");
  assert.equal(await next("weekly", "2026-09-24", "2026-10-03"), "2026-10-08");
  assert.equal(
    await next("biweekly", "2026-09-24", "2026-09-24"),
    "2026-10-08",
  );
  assert.equal(
    await next("biweekly", "2026-09-24", "2026-10-08"),
    "2026-10-22",
  );
});

await check("datas: mensal usa o último dia em meses curtos", async () => {
  assert.equal(await next("monthly", "2026-01-31", "2026-01-31"), "2026-02-28");
  assert.equal(await next("monthly", "2026-01-31", "2026-02-28"), "2026-03-31");
  assert.equal(await next("monthly", "2026-09-24", "2026-12-30"), "2027-01-24");
});

let source;
await check("tarefa com repetição guarda a regra", async () => {
  // Admin sets it up for Ana.
  source = await create(admin, { repeat: "weekly", due: await plus(2) });
  const [r] = await sql(
    "select r.frequency,r.next_run::text,r.due_offset,r.assignee_id,r.active,t.recurrence_id=r.id as linked from task_recurrences r join tasks t on t.id=r.source_task_id where t.id=$1",
    [source],
  );
  assert.deepEqual(r, {
    frequency: "weekly",
    next_run: await plus(7),
    due_offset: 2,
    assignee_id: ana,
    active: true,
    linked: true,
  });
  const [e] = await sql(
    "select action,detail from task_events where task_id=$1 and action like 'recurrence%'",
    [source],
  );
  assert.deepEqual(e, {
    action: "recurrence_started",
    detail: { frequency: "weekly" },
  });
});

await check("antes da data nada abre", async () => {
  assert.equal(await run(await plus(6)), 0);
});

await check(
  "na data abre uma cópia igual, com o mesmo prazo relativo",
  async () => {
    const day = await plus(7);
    assert.equal(await run(day), 1);
    const [src] = await sql("select * from tasks where id=$1", [source]);
    const [copy] = await sql(
      "select * from tasks where recurrence_id=$1 and id<>$2",
      [src.recurrence_id, source],
    );
    for (const k of [
      "title",
      "description",
      "priority",
      "estimated_minutes",
      "project_id",
      "contract_id",
      "assignee_id",
      "creator_id",
      "custom_fields",
    ])
      assert.deepEqual(copy[k], src[k], k);
    assert.equal(copy.status, "progress");
    assert.equal(copy.due_date.toISOString().slice(0, 10), await plus(9));
    const [r] = await sql(
      "select next_run::text,copies from task_recurrences where id=$1",
      [src.recurrence_id],
    );
    assert.deepEqual(r, { next_run: await plus(14), copies: 1 });
  },
);

await check("rodar de novo no mesmo dia não duplica", async () => {
  assert.equal(await run(await plus(7)), 0);
});

await check("quem recebe a cópia é avisado e a vê", async () => {
  const [copy] = await sql(
    "select id from tasks where title='Post do dia' and id<>$1 order by created_at desc limit 1",
    [source],
  );
  const rows = await sql(
    "select actor_id from notifications where user_id=$1 and task_id=$2 and kind='assigned'",
    [ana, copy.id],
  );
  assert.deepEqual(rows, [{ actor_id: admin }]);
  await as(ana);
  const extras = await rpc("task_extras", [copy.id]);
  assert.equal(extras.recurrence.frequency, "weekly");
  assert.equal(extras.recurrence.active, true);
});

await check("dias sem rodar abrem uma só cópia e seguem", async () => {
  // Three weeks later: one copy, next date after that day.
  const [{ recurrence_id }] = await sql(
    "select recurrence_id from tasks where id=$1",
    [source],
  );
  const before = (
    await sql("select count(*)::int as n from tasks where recurrence_id=$1", [
      recurrence_id,
    ])
  )[0].n;
  assert.equal(await run(await plus(30)), 1);
  const after = (
    await sql("select count(*)::int as n from tasks where recurrence_id=$1", [
      recurrence_id,
    ])
  )[0].n;
  assert.equal(after, before + 1);
  const [r] = await sql(
    "select next_run::text from task_recurrences where id=$1",
    [recurrence_id],
  );
  assert.equal(r.next_run, await plus(35));
});

await check("tarefa para a equipe é distribuída a cada cópia", async () => {
  const id = await create(admin, {
    assignee: null,
    team: design,
    repeat: "daily",
  });
  const [{ recurrence_id }] = await sql(
    "select recurrence_id from tasks where id=$1",
    [id],
  );
  const got = new Set();
  for (let d = 1; d <= 3; d++) {
    await run(await plus(d));
    const [c] = await sql(
      "select assignee_id,team_id from tasks where recurrence_id=$1 order by created_at desc limit 1",
      [recurrence_id],
    );
    assert.equal(c.team_id, design);
    got.add(c.assignee_id);
  }
  assert.ok(got.size >= 2, "cópias vão para pessoas diferentes");
});

await check("imagens da descrição não vão para as cópias", async () => {
  const doc = {
    type: "doc",
    content: [
      { type: "paragraph", content: [{ type: "text", text: "Oi" }] },
      { type: "inlineImage", attrs: { imageId: uid(99) } },
    ],
  };
  const [{ d }] = await sql(
    "select mavi_private.description_for_copies($1) as d",
    ["mavi:richtext:v1:" + JSON.stringify(doc)],
  );
  assert.deepEqual(JSON.parse(d.slice(17)), {
    type: "doc",
    content: [doc.content[0]],
  });
});

await check("cliente arquivado: a cópia espera e guarda o motivo", async () => {
  const id = await create(ana, { repeat: "daily" });
  await as(admin);
  await rpc("set_client_archived", [client, true]);
  const day = await plus(1);
  await run(day);
  const [r] = await sql(
    "select r.last_error,r.next_run::text,r.copies from task_recurrences r join tasks t on t.recurrence_id=r.id where t.id=$1",
    [id],
  );
  assert.match(r.last_error, /arquivado/);
  assert.equal(r.next_run, day);
  assert.equal(r.copies, 0);
  await as(admin);
  await rpc("set_client_archived", [client, false]);
  await run(day);
  const [ok] = await sql(
    "select r.last_error,r.copies from task_recurrences r join tasks t on t.recurrence_id=r.id where t.id=$1",
    [id],
  );
  assert.deepEqual(ok, { last_error: null, copies: 1 });
});

await check("só quem programou ou um gestor para a repetição", async () => {
  const id = await create(ana, { repeat: "monthly" });
  await as(bia);
  await assert.rejects(rpc("stop_task_recurrence", [id]), /Sem acesso|pará-la/);
  await as(ana);
  await rpc("stop_task_recurrence", [id]);
  const [r] = await sql(
    "select r.active,r.stopped_by from task_recurrences r join tasks t on t.recurrence_id=r.id where t.id=$1",
    [id],
  );
  assert.deepEqual(r, { active: false, stopped_by: ana });
  // Stopped: no more copies.
  assert.equal((await run(await plus(400))) >= 0, true);
  const [n] = await sql(
    "select count(*)::int as n from tasks t join tasks s on s.recurrence_id=t.recurrence_id where s.id=$1",
    [id],
  );
  assert.equal(n.n, 1);
});

await check("gestor para a de outra pessoa", async () => {
  const id = await create(ana, { repeat: "weekdays" });
  await as(admin);
  await rpc("stop_task_recurrence", [id]);
  const [r] = await sql(
    "select r.active from task_recurrences r join tasks t on t.recurrence_id=r.id where t.id=$1",
    [id],
  );
  assert.equal(r.active, false);
});

await check("frequência inválida não cria a tarefa", async () => {
  await assert.rejects(create(ana, { repeat: "anual" }), /repete/);
  const rows = await sql(
    "select count(*)::int as n from tasks where title='Post do dia' and recurrence_id is null",
  );
  assert.equal(rows[0].n, 0);
});

await check("quem é de fora não vê a regra", async () => {
  await as(outsider);
  const { rows } = await db.query("select id from task_recurrences");
  assert.equal(rows.length, 0);
});

await check("sem repetição tudo continua igual", async () => {
  const id = await create(ana);
  const [t] = await sql("select recurrence_id from tasks where id=$1", [id]);
  assert.equal(t.recurrence_id, null);
});

console.log(`${passed} verificações de repetição de tarefas passaram.`);
