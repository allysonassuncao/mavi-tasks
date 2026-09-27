// Indicadores de performance (migration 20261104090000_task_performance):
// o histórico de status por responsável (reconstruído do task_events na
// migração e mantido por trigger depois), quem executou a tarefa e as
// fontes "Status das tarefas" e "Validações" dos Dashboards.
import assert from "node:assert/strict";
import { applyMigration, createTestDatabase } from "./database-fixture.mjs";

const MIGRATION = "20261104090000";
const db = await createTestDatabase({ until: MIGRATION });
const uid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const [A, admin, member, manager] = [1, 10, 11, 12].map(uid);
await db.query(`insert into auth.users select unnest($1::uuid[])`, [
  [admin, member, manager],
]);
await db.query(
  `insert into companies(id,name,timezone) values($1,'Empresa A','America/Sao_Paulo')`,
  [A],
);
await db.query(
  `insert into memberships(company_id,user_id,name,role) values
   ($1,$2,'Ana Admin','admin'),($1,$3,'Bruno Membro','member'),($1,$4,'Gil Gestor','manager')`,
  [A, admin, member, manager],
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

await as(admin);
const team = await rpc("create_team", [A, "Equipe A", [member, manager]]);
const client = await rpc("create_client", [A, "Cliente A", ""]);
const product = await rpc("create_product", [A, "Make Ads"]);
const contract = await rpc("create_contract", [
  A,
  client,
  product,
  "Contrato A",
  team,
]);
const newTask = async (title, due = "2099-01-01") => {
  await as(admin);
  return rpc("create_task", [
    A,
    contract,
    title,
    member,
    due,
    null,
    team,
    "",
    "normal",
    60,
    false,
  ]);
};
const versionOf = async (id) =>
  (await sql("select version from tasks where id=$1", [id]))[0].version;
const move = async (who, id, status, assignee, note = "") => {
  const version = await versionOf(id);
  await as(who);
  return rpc("transition_task", [id, version, "move", note, status, assignee]);
};
const approve = async (id) => {
  const version = await versionOf(id);
  await as(admin);
  return rpc("transition_task", [
    id,
    version,
    "approve_internal",
    "Tudo certo",
    null,
    null,
  ]);
};
const periods = (id) =>
  sql(
    `select status,user_id,from_status,previous_user_id,moved_by,to_status,ended_by,ended_at
     from task_status_periods where task_id=$1 order by started_at,id`,
    [id],
  );

// Before the migration: one task corrected (still in Correção), one
// approved at the first try.
const corrected = await newTask("Corrigida antes");
await move(member, corrected, "review", admin);
await move(admin, corrected, "correction", member, "Preço errado na arte");
const approvedBefore = await newTask("Aprovada antes");
await move(member, approvedBefore, "review", admin);
await approve(approvedBefore);

await db.exec("reset role");
await applyMigration(db, MIGRATION);

await check("a migração reconstrói o histórico do task_events", async () => {
  const rows = await periods(corrected);
  assert.deepEqual(
    rows.map((r) => [r.status, r.user_id, r.from_status, r.previous_user_id]),
    [
      ["progress", member, null, null],
      ["review", admin, "progress", member],
      ["correction", member, "review", admin],
    ],
  );
  assert.equal(rows[1].to_status, "correction");
  assert.equal(rows[1].ended_by, admin, "quem reprovou");
  assert.equal(rows[2].ended_at, null, "a correção ainda está aberta");
});

await check("tarefa entregue não fica com período aberto", async () => {
  const rows = await periods(approvedBefore);
  assert.deepEqual(
    rows.map((r) => [r.status, r.to_status]),
    [
      ["progress", "review"],
      ["review", "done"],
    ],
  );
});

await check("quem executou vem do histórico", async () => {
  const rows = await sql(
    "select id,executor_id,assignee_id from tasks where id = any($1)",
    [[corrected, approvedBefore]],
  );
  for (const r of rows) assert.equal(r.executor_id, member);
  assert.equal(
    rows.find((r) => r.id === approvedBefore).assignee_id,
    admin,
    "a entregue ficou com quem validou",
  );
});

// After the migration, the trigger keeps the history.
const reworked = await newTask("Alterada e aprovada");
await move(member, reworked, "review", admin);
await move(admin, reworked, "rejected", member, "Trocar a foto");
await move(member, reworked, "review", admin);
// A change of hands inside the validation keeps who sent it.
await move(admin, reworked, "review", manager);
const version = await versionOf(reworked);
await as(manager);
await rpc("transition_task", [reworked, version, "move", "", "review", admin]);
await approve(reworked);
const returned = await newTask("Faltou informação");
await move(member, returned, "returned", admin, "Falta o briefing");

await check("o trigger abre e fecha os períodos a cada mudança", async () => {
  const rows = await periods(reworked);
  assert.deepEqual(
    rows.map((r) => [r.status, r.user_id, r.from_status]),
    [
      ["progress", member, null],
      ["review", admin, "progress"],
      ["rejected", member, "review"],
      ["review", admin, "rejected"],
      ["review", manager, "review"],
      ["review", admin, "review"],
    ],
  );
  assert.ok(
    rows.slice(3).every((r) => r.previous_user_id === member),
    "a troca de mãos mantém quem enviou para validação",
  );
  assert.equal(rows.at(-1).to_status, "done");
  assert.equal(rows[0].moved_by, admin, "quem criou");
  assert.equal(rows[1].moved_by, member, "quem enviou");
  assert.ok(
    rows.every((r) => r.ended_at),
    "entregue: nada aberto",
  );
  const [t] = await sql("select executor_id from tasks where id=$1", [
    reworked,
  ]);
  assert.equal(t.executor_id, member);
});

await check("reabrir abre um período vindo de Entregue", async () => {
  const task = await newTask("Reaberta");
  await move(member, task, "review", admin);
  await approve(task);
  const v = await versionOf(task);
  await as(admin);
  await rpc("transition_task", [
    task,
    v,
    "reopen",
    "Cliente pediu ajuste",
    "correction",
    member,
  ]);
  const rows = await periods(task);
  assert.equal(rows.at(-1).from_status, "done");
  assert.equal(rows.at(-1).status, "correction");
  await move(member, task, "review", admin);
  await approve(task);
});

await check("ninguém lê o histórico direto", async () => {
  await as(member);
  await assert.rejects(
    () => db.query("select * from task_status_periods"),
    /permission denied/,
  );
});

// A devolvida task that has been waiting for 5 hours.
await sql(
  `update task_status_periods set started_at = now() - interval '5 hours'
   where task_id=$1 and ended_at is null`,
  [returned],
);

const range = ["2020-01-01", "2030-01-01"];
const q = (ref, source, metric, extra = {}) => ({
  ref,
  source,
  metric,
  filters: [],
  ...extra,
});
const preview = (spec) =>
  as(admin).then(() => rpc("dashboard_preview", [A, spec, ...range, {}]));
const byKey = (rows) => Object.fromEntries(rows.map((r) => [r.k, Number(r.v)]));

await check(
  "Validações: envios, aprovadas, reprovadas e taxa por quem enviou",
  async () => {
    const res = await preview({
      viz: "table",
      groupBy: "person",
      queries: [
        q("A", "reviews", "sent", { dateField: "event" }),
        q("B", "reviews", "approved", { dateField: "event" }),
        q("C", "reviews", "reproved", { dateField: "event" }),
        q("D", "reviews", "approval_rate", { dateField: "event" }),
      ],
    });
    // Envios: corrigida 1, aprovada antes 1, alterada 2, reaberta 2.
    assert.deepEqual(byKey(res.series.A), { [member]: 6 });
    // Aprovadas: aprovada antes, alterada, reaberta duas vezes.
    assert.deepEqual(byKey(res.series.B), { [member]: 4 });
    // Reprovadas: corrigida e alterada (a reabertura não é reprovação).
    assert.deepEqual(byKey(res.series.C), { [member]: 2 });
    assert.ok(Math.abs(byKey(res.series.D)[member] - 66.67) < 0.01);
    assert.equal(res.series.A[0].l, "Bruno Membro");
  },
);

await check("Validações por quem validou", async () => {
  const res = await preview({
    viz: "table",
    groupBy: "validator",
    queries: [q("A", "reviews", "reproved", { dateField: "event" })],
  });
  // O gestor só repassou a validação: não decidiu nada.
  assert.deepEqual(byKey(res.series.A), { [admin]: 2, [manager]: 0 });
});

await check("Status das tarefas: vezes e tempo em cada status", async () => {
  const res = await preview({
    viz: "table",
    groupBy: "status",
    queries: [
      q("A", "status_history", "entries"),
      q("B", "status_history", "hours"),
    ],
  });
  const entries = byKey(res.series.A);
  assert.equal(entries.returned, 1);
  assert.equal(entries.correction, 2, "corrigida + reaberta");
  assert.equal(entries.rejected, 1);
  assert.equal(entries.review, 6, "trocas de mãos não contam como entrada");
  const hours = byKey(res.series.B);
  assert.ok(Math.abs(hours.returned - 5) < 0.01, "5 h em Devolvida");
});

await check("Status das tarefas: por responsável e pelo anterior", async () => {
  const spec = (groupBy) => ({
    viz: "table",
    groupBy,
    queries: [
      q("A", "status_history", "entries", {
        filters: [{ field: "status", op: "in", values: ["returned"] }],
      }),
    ],
  });
  // Devolvida fica com quem precisa completar a informação (o criador)…
  assert.deepEqual(byKey((await preview(spec("person"))).series.A), {
    [admin]: 1,
  });
  // …e foi devolvida por quem estava executando.
  assert.deepEqual(byKey((await preview(spec("previous"))).series.A), {
    [member]: 1,
  });
});

await check("reaberturas", async () => {
  const res = await preview({
    viz: "stat",
    groupBy: "none",
    queries: [q("A", "status_history", "reopens")],
  });
  assert.equal(Number(res.series.A[0].v), 1);
});

await check("Tarefas: aprovadas de primeira, retrabalho e prazos", async () => {
  const res = await preview({
    viz: "table",
    groupBy: "executor",
    queries: [
      q("A", "tasks", "first_pass_rate", { dateField: "delivered_at" }),
      q("B", "tasks", "rework_per_task", { dateField: "delivered_at" }),
      q("C", "tasks", "on_time_rate", { dateField: "delivered_at" }),
      q("D", "tasks", "lead_time_days", { dateField: "delivered_at" }),
    ],
  });
  // Entregues: aprovada antes (de primeira), alterada (1 retrabalho),
  // reaberta (1 retrabalho, voltou de Entregue).
  assert.ok(Math.abs(byKey(res.series.A)[member] - 33.33) < 0.01);
  assert.ok(Math.abs(byKey(res.series.B)[member] - 0.6667) < 0.01);
  assert.equal(byKey(res.series.C)[member], 100);
  assert.ok(byKey(res.series.D)[member] >= 0);
  assert.equal(
    res.series.A[0].l,
    "Bruno Membro",
    "quem executou, não quem validou",
  );
});

await check("prazo alterado, atraso e prazo original", async () => {
  const task = await newTask("Atrasada", "2026-01-10");
  await move(member, task, "review", admin);
  await approve(task);
  await sql(
    `update tasks set original_due_date='2026-01-05', delivered_at='2026-01-13 12:00-03' where id=$1`,
    [task],
  );
  const res = await preview({
    viz: "stat",
    groupBy: "none",
    queries: [
      q("A", "tasks", "rescheduled"),
      q("B", "tasks", "delay_days", { dateField: "delivered_at" }),
      q("C", "tasks", "on_time_original_rate", { dateField: "delivered_at" }),
    ],
  });
  assert.equal(Number(res.series.A[0].v), 1);
  assert.equal(Number(res.series.B[0].v), 3);
  assert.equal(Number(res.series.C[0].v), 75, "3 de 4 no prazo original");
});

await check("só nomes da lista, em cada fonte", async () => {
  await assert.rejects(
    () =>
      preview({
        viz: "table",
        groupBy: "previous",
        queries: [q("A", "tasks", "count")],
      }),
    /Agrupamento inválido para esta fonte/,
  );
  await assert.rejects(
    () =>
      preview({
        viz: "stat",
        groupBy: "none",
        queries: [
          q("A", "reviews", "sent", {
            filters: [{ field: "status", values: ["review"] }],
          }),
        ],
      }),
    /Filtro inválido para esta fonte/,
  );
  await assert.rejects(
    () =>
      preview({
        viz: "stat",
        groupBy: "none",
        queries: [q("A", "status_history", "drop table")],
      }),
    /Métrica inválida/,
  );
});

await check("por cliente e ao longo do tempo", async () => {
  const res = await preview({
    viz: "line",
    groupBy: "client",
    queries: [q("A", "status_history", "hours")],
  });
  assert.equal(res.series.A[0].l, "Cliente A");
  const series = await preview({
    viz: "line",
    groupBy: "time",
    interval: "month",
    queries: [q("A", "reviews", "approved", { dateField: "event" })],
  });
  assert.ok(series.series.A.reduce((s, r) => s + Number(r.v), 0) >= 4);
});

console.log(`\n${passed} verificações de performance passaram.`);
