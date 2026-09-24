// Dashboards (migration 20260930140000_dashboards): the query engine (only
// whitelisted names, always scoped to the company), sharing (people, teams,
// public link, password with lockout), cache and editing.
import assert from "node:assert/strict";
import { createTestDatabase } from "./database-fixture.mjs";

const db = await createTestDatabase();
const uid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const [A, B, admin, manager, viewer, teamViewer, member, outsider] = [
  1, 2, 10, 11, 12, 13, 14, 15,
].map(uid);
await db.query(`insert into auth.users select unnest($1::uuid[])`, [
  [admin, manager, viewer, teamViewer, member, outsider],
]);
await db.query(
  `insert into companies(id,name,timezone) values($1,'Empresa A','America/Sao_Paulo'),($2,'Empresa B','America/Sao_Paulo')`,
  [A, B],
);
await db.query(
  `insert into memberships(company_id,user_id,name,role) values
   ($1,$3,'Ana Admin','admin'),($1,$4,'Gil Gestor','manager'),
   ($1,$5,'Vera Viewer','member'),($1,$6,'Téo Equipe','member'),
   ($1,$7,'Bia Membro','member'),($2,$8,'Outra Empresa','admin')`,
  [A, B, admin, manager, viewer, teamViewer, member, outsider],
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

// Two clients; tasks with known statuses and dates; hours on them.
await as(admin);
const team = await rpc("create_team", [A, "Equipe", [teamViewer]]);
const aurora = await rpc("create_client", [A, "Aurora", "", [team]]);
const norte = await rpc("create_client", [A, "Norte", "", [team]]);
const product = await rpc("create_product", [A, "Make Ads"]);
const kAurora = await rpc("create_contract", [A, aurora, product, "Ads", team]);
const kNorte = await rpc("create_contract", [A, norte, product, "Ads", team]);
await as(outsider);
const clientB = await rpc("create_client", [B, "Cliente B", ""]);
const productB = await rpc("create_product", [B, "Produto B"]);
const kB = await rpc("create_contract", [B, clientB, productB, "B", null]);

// Aurora: 3 tasks (1 done on time, 1 done late, 1 open overdue); Norte: 1
// open; company B: 5 tasks that must never show up.
await sql(
  `insert into tasks(id,company_id,contract_id,title,creator_id,assignee_id,due_date,original_due_date,status,internal_approved_by,delivered_at,created_at,estimated_minutes)
   values
   ($1,$5,$6,'Entregue no prazo',$8,$8,'2026-09-10','2026-09-10','done',$8,'2026-09-09 15:00-03','2026-09-01 10:00-03',120),
   ($2,$5,$6,'Entregue com atraso',$8,$9,'2026-09-05','2026-09-05','done',$8,'2026-09-08 15:00-03','2026-09-03 10:00-03',60),
   ($3,$5,$6,'Aberta atrasada',$8,$9,'2026-09-02','2026-09-02','progress',null,null,'2026-09-02 10:00-03',30),
   ($4,$5,$7,'Norte aberta',$8,$9,'2099-01-01','2099-01-01','progress',null,null,'2026-09-15 10:00-03',0)`,
  [uid(101), uid(102), uid(103), uid(104), A, kAurora, kNorte, admin, member],
);
await sql(
  `insert into tasks(company_id,contract_id,title,creator_id,assignee_id,due_date,original_due_date,created_at)
   select $1,$2,'Tarefa B '||n,$3,$3,'2026-09-10','2026-09-10','2026-09-05 10:00-03' from generate_series(1,5) n`,
  [B, kB, outsider],
);
await sql(
  `insert into time_entries(company_id,task_id,user_id,started_at,ended_at,source) values
   ($1,$2,$4,'2026-09-02 09:00-03','2026-09-02 11:00-03','manual'),
   ($1,$2,$5,'2026-09-03 09:00-03','2026-09-03 09:30-03','timer'),
   ($1,$3,$5,'2026-09-15 09:00-03','2026-09-15 10:00-03','manual')`,
  [A, uid(101), uid(104), admin, member],
);

const range = ["2026-09-01", "2026-09-30"];
const q = (ref, source, metric, extra = {}) => ({
  ref,
  source,
  metric,
  filters: [],
  ...extra,
});
const preview = (spec, vars = {}, user = admin, company = A) =>
  as(user).then(() =>
    rpc("dashboard_preview", [company, spec, ...range, vars]),
  );
const total = (res, ref = "A") => Number(res.series[ref][0].v);

await check("contagem, horas estimadas, atraso e prazo médio", async () => {
  const res = await preview({
    viz: "stat",
    groupBy: "none",
    queries: [
      q("A", "tasks", "count"),
      q("B", "tasks", "estimated_hours"),
      q("C", "tasks", "late"),
      q("D", "tasks", "lead_time_days"),
    ],
  });
  assert.equal(total(res, "A"), 4, "só as tarefas da empresa A");
  assert.equal(total(res, "B"), 3.5);
  assert.equal(total(res, "C"), 2, "entregue com atraso + aberta vencida");
  // (8d 5h + 5d 5h) / 2 = 6,7083 dias
  assert.ok(Math.abs(total(res, "D") - 6.7083) < 0.01);
});

await check(
  "horas: soma, lançamentos, pessoas e tarefas distintas",
  async () => {
    const res = await preview({
      viz: "table",
      groupBy: "none",
      queries: [
        q("A", "hours", "hours"),
        q("B", "hours", "entries"),
        q("C", "hours", "people"),
        q("D", "hours", "tasks"),
      ],
    });
    assert.equal(total(res, "A"), 3.5);
    assert.equal(total(res, "B"), 3);
    assert.equal(total(res, "C"), 2);
    assert.equal(total(res, "D"), 2);
  },
);

await check("agrupa por cliente com nomes e por status", async () => {
  const res = await preview({
    viz: "bar",
    groupBy: "client",
    queries: [q("A", "tasks", "count"), q("B", "hours", "hours")],
  });
  assert.deepEqual(
    res.series.A.map((r) => [r.l, Number(r.v)]),
    [
      ["Aurora", 3],
      ["Norte", 1],
    ],
  );
  assert.deepEqual(
    res.series.B.map((r) => [r.l, Number(r.v)]),
    [
      ["Aurora", 2.5],
      ["Norte", 1],
    ],
  );
  const byStatus = await preview({
    viz: "donut",
    groupBy: "status",
    queries: [q("A", "tasks", "count")],
  });
  assert.deepEqual(
    Object.fromEntries(byStatus.series.A.map((r) => [r.k, Number(r.v)])),
    { done: 2, progress: 2 },
  );
});

await check("série no tempo preenche os dias sem dados", async () => {
  const res = await preview({
    viz: "line",
    groupBy: "time",
    interval: "day",
    queries: [q("A", "hours", "hours")],
  });
  assert.equal(res.interval, "day");
  assert.equal(res.series.A.length, 30);
  assert.equal(Number(res.series.A[1].v), 2, "2 de setembro");
  assert.equal(Number(res.series.A[3].v), 0, "4 de setembro, sem horas");
  const weekly = await preview({
    viz: "bar",
    groupBy: "time",
    interval: "auto",
    queries: [q("A", "tasks", "count", { dateField: "due_date" })],
  });
  assert.equal(weekly.interval, "day", "até 62 dias o automático é diário");
});

await check("top N junta o resto em Outros (só em somas)", async () => {
  const res = await preview({
    viz: "hbar",
    groupBy: "client",
    limit: 1,
    queries: [q("A", "tasks", "count")],
  });
  assert.deepEqual(
    res.series.A.map((r) => [
      r.k === "__other__" ? "Outros" : r.l,
      Number(r.v),
    ]),
    [
      ["Aurora", 3],
      ["Outros", 1],
    ],
  );
  const avg = await preview({
    viz: "hbar",
    groupBy: "client",
    limit: 1,
    queries: [q("A", "hours", "people")],
  });
  assert.equal(avg.series.A.length, 1, "contagem distinta não soma em Outros");
  const formula = await preview({
    viz: "hbar",
    groupBy: "client",
    limit: 1,
    formula: { expr: "A / B", label: "Horas por tarefa" },
    queries: [q("A", "hours", "hours"), q("B", "tasks", "count")],
  });
  assert.equal(formula.series.A.length, 2, "com fórmula vêm todos os grupos");
});

await check("filtros da consulta e do dashboard", async () => {
  const done = await preview({
    viz: "stat",
    groupBy: "none",
    queries: [
      q("A", "tasks", "count", {
        filters: [{ field: "status", op: "in", values: ["done"] }],
      }),
      q("B", "tasks", "count", {
        filters: [{ field: "late", values: ["true"] }],
      }),
      q("C", "tasks", "count", {
        filters: [{ field: "client", op: "not_in", values: [aurora] }],
      }),
    ],
  });
  assert.equal(total(done, "A"), 2);
  assert.equal(total(done, "B"), 2);
  assert.equal(total(done, "C"), 1);
  const scoped = await preview(
    {
      viz: "stat",
      groupBy: "none",
      queries: [q("A", "tasks", "count"), q("B", "hours", "hours")],
    },
    { filters: { people: [member], clients: [aurora] } },
  );
  assert.equal(total(scoped, "A"), 2, "tarefas de Bia na Aurora");
  assert.equal(total(scoped, "B"), 0.5, "horas de Bia na Aurora");
});

await check("comparação com o período anterior", async () => {
  const res = await preview({
    viz: "stat",
    groupBy: "none",
    compare: true,
    queries: [q("A", "tasks", "count")],
  });
  assert.equal(Number(res.previous.A[0].v), 0, "agosto sem tarefas");
});

await check("nomes fora da lista e SQL em valores são recusados", async () => {
  const bad = [
    { viz: "stat", groupBy: "none", queries: [q("A", "users", "count")] },
    { viz: "stat", groupBy: "none", queries: [q("A", "tasks", "sum(id)")] },
    {
      viz: "stat",
      groupBy: "none",
      queries: [
        q("A", "tasks", "count", {
          filters: [{ field: "title; drop table tasks", values: ["x"] }],
        }),
      ],
    },
    { viz: "stat", groupBy: "t.title", queries: [q("A", "tasks", "count")] },
    {
      viz: "stat",
      groupBy: "none",
      queries: [q("A", "tasks", "count", { dateField: "now()" })],
    },
    {
      viz: "stat",
      groupBy: "none",
      formula: { expr: "A; select 1", label: "" },
      queries: [q("A", "tasks", "count")],
    },
    { viz: "stat", groupBy: "status", queries: [q("A", "hours", "hours")] },
  ];
  for (const spec of bad) await assert.rejects(preview(spec));
  // A value is always a quoted literal: an injection attempt is just an
  // invalid id.
  await assert.rejects(
    preview({
      viz: "stat",
      groupBy: "none",
      queries: [
        q("A", "tasks", "count", {
          filters: [{ field: "client", values: ["'); drop table tasks; --"] }],
        }),
      ],
    }),
    /uuid/,
  );
  assert.equal((await sql("select count(*)::int n from tasks"))[0].n, 9);
});

await check("somente gestores da empresa montam dashboards", async () => {
  const spec = {
    viz: "stat",
    groupBy: "none",
    queries: [q("A", "tasks", "count")],
  };
  await assert.rejects(preview(spec, {}, member), /Sem permissão/);
  await assert.rejects(preview(spec, {}, outsider), /Sem permissão/);
  await as(member);
  await assert.rejects(
    rpc("save_dashboard", [A, null, "Meu", "", [], {}, null]),
    /Sem permissão/,
  );
  // A leader of B filtering by A's client still only sees B's data.
  const cross = await preview(
    spec,
    { filters: { clients: [aurora] } },
    outsider,
    B,
  );
  assert.equal(total(cross), 0);
});

const panels = [
  {
    id: "entregas",
    title: "Entregas",
    x: 0,
    y: 0,
    w: 4,
    h: 3,
    spec: { viz: "stat", groupBy: "none", queries: [q("A", "tasks", "count")] },
  },
  {
    id: "por-cliente",
    title: "Por cliente",
    x: 4,
    y: 0,
    w: 8,
    h: 4,
    spec: {
      viz: "bar",
      groupBy: "client",
      queries: [q("A", "tasks", "count")],
    },
  },
];
let dash;
await check("salvar, validar e conflito de versão", async () => {
  await as(manager);
  dash = await rpc("save_dashboard", [
    A,
    null,
    "Operação",
    "Visão geral",
    panels,
    { range: { preset: "month" }, filters: { clients: [aurora] } },
    null,
  ]);
  assert.equal(dash.version, 1);
  assert.equal(dash.password_hash, undefined, "o hash nunca sai do banco");
  await as(manager);
  await assert.rejects(
    rpc("save_dashboard", [
      A,
      dash.id,
      "Operação",
      "",
      [{ ...panels[0], x: 10, w: 4 }],
      {},
      1,
    ]),
    /Posição/,
  );
  await as(admin);
  const v2 = await rpc("save_dashboard", [
    A,
    dash.id,
    "Operação",
    "Visão geral",
    panels,
    { range: { preset: "month" }, filters: { clients: [aurora] } },
    1,
  ]);
  assert.equal(v2.version, 2);
  await as(manager);
  await assert.rejects(
    rpc("save_dashboard", [A, dash.id, "Operação", "", panels, {}, 1]),
    /alterado por outra pessoa/,
  );
  dash = v2;
});

const data = (user, extra = {}) =>
  as(user).then(() =>
    rpc("dashboard_panel_data", [
      extra.token ? null : dash.id,
      extra.panel ?? "entregas",
      ...range,
      extra.vars ?? null,
      extra.token ?? null,
      extra.password ?? null,
      extra.fresh ?? false,
    ]),
  );

await check("pessoas e equipes escolhidas veem; os demais não", async () => {
  await as(admin);
  await rpc("set_dashboard_sharing", [
    dash.id,
    "none",
    null,
    [viewer],
    [team],
    false,
  ]);
  assert.equal(total(await data(viewer)), 3, "filtro salvo: só Aurora");
  assert.equal(total(await data(teamViewer)), 3);
  await assert.rejects(data(member), /Sem acesso/);
  await assert.rejects(data(outsider), /Sem acesso/);
  await as(viewer);
  assert.equal(
    (await db.query("select id from dashboards")).rows.length,
    1,
    "quem foi escolhido lê o dashboard",
  );
  await as(member);
  assert.equal((await db.query("select id from dashboards")).rows.length, 0);
});

await check(
  "só gestores trocam os filtros; os demais só o período",
  async () => {
    const vars = { filters: { clients: [] } };
    assert.equal(total(await data(admin, { vars, fresh: true })), 4);
    assert.equal(total(await data(viewer, { vars, fresh: true })), 3);
  },
);

await check("link público abre sem login; sem link, nada", async () => {
  const [{ share_token: token }] = await sql(
    "select share_token from dashboards where id=$1",
    [dash.id],
  );
  await assert.rejects(
    as(null).then(() => rpc("dashboard_shared", [token, null])),
    /indisponível/,
  );
  await as(admin);
  await rpc("set_dashboard_sharing", [dash.id, "public", null, [], [], false]);
  await as(null);
  const shared = await rpc("dashboard_shared", [token, null]);
  assert.equal(shared.status, "ok");
  assert.equal(shared.name, "Operação");
  assert.equal(shared.timezone, "America/Sao_Paulo");
  assert.equal(total(await data(null, { token })), 3);
  await assert.rejects(
    data(null),
    /Sem acesso/,
    "sem token, anônimo não entra",
  );
  await assert.rejects(data(null, { token: "0".repeat(64) }), /não encontrado/);
  // A new link invalidates the old one.
  await as(admin);
  await rpc("set_dashboard_sharing", [dash.id, "public", null, [], [], true]);
  await assert.rejects(
    as(null).then(() => rpc("dashboard_shared", [token, null])),
    /indisponível/,
  );
});

await check("link com senha, tentativas e bloqueio", async () => {
  await as(admin);
  await assert.rejects(
    rpc("set_dashboard_sharing", [dash.id, "password", null, [], [], false]),
    /Defina uma senha/,
  );
  await as(admin);
  await assert.rejects(
    rpc("set_dashboard_sharing", [dash.id, "password", "123", [], [], false]),
    /6 a 72/,
  );
  await as(admin);
  const s = await rpc("set_dashboard_sharing", [
    dash.id,
    "password",
    "segredo-forte",
    [],
    [],
    false,
  ]);
  assert.equal(s.has_password, true);
  const token = s.share_token;
  await as(null);
  assert.deepEqual(await rpc("dashboard_shared", [token, null]), {
    status: "password",
    wrong: false,
  });
  await as(null);
  assert.equal((await rpc("dashboard_shared", [token, "errada"])).wrong, true);
  assert.equal(
    (await rpc("dashboard_shared", [token, "segredo-forte"])).status,
    "ok",
  );
  assert.equal(
    total(await data(null, { token, password: "segredo-forte", fresh: true })),
    3,
  );
  assert.match((await data(null, { token, password: "x" })).error, /Senha/);
  for (let i = 0; i < 9; i++)
    await as(null).then(() => rpc("dashboard_shared", [token, "chute"]));
  await as(null);
  assert.equal(
    (await rpc("dashboard_shared", [token, "segredo-forte"])).status,
    "locked",
    "após 10 erros nem a senha certa entra",
  );
  // A signed-in leader is not affected, and a new password resets it.
  assert.equal(total(await data(admin)), 3);
  await as(admin);
  await rpc("set_dashboard_sharing", [
    dash.id,
    "password",
    "outra-senha",
    [],
    [],
    false,
  ]);
  await as(null);
  assert.equal(
    (await rpc("dashboard_shared", [token, "outra-senha"])).status,
    "ok",
  );
});

await check("cache de 60 segundos, renovável por quem tem acesso", async () => {
  const first = await data(admin, { panel: "por-cliente", fresh: true });
  const again = await data(admin, { panel: "por-cliente" });
  assert.equal(again.computed_at, first.computed_at, "veio do cache");
  await sql(
    "update mavi_private.dashboard_cache set created_at = now() - interval '2 minutes'",
  );
  const expired = await data(admin, { panel: "por-cliente" });
  assert.notEqual(expired.computed_at, first.computed_at);
});

await check(
  "excluir: só gestores, e leva compartilhamento e cache",
  async () => {
    await as(member);
    await assert.rejects(rpc("delete_dashboard", [dash.id]), /Sem permissão/);
    await as(manager);
    await rpc("delete_dashboard", [dash.id]);
    assert.equal(
      (await sql("select count(*)::int n from dashboard_members")).at(0).n,
      0,
    );
    assert.equal(
      (await sql("select count(*)::int n from mavi_private.dashboard_cache"))[0]
        .n,
      0,
    );
  },
);

console.log(`\n${passed} verificações de dashboards passaram.`);
