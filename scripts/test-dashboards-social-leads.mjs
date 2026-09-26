// Dashboards: a fonte "Social Leads" (migration 20261020120000): aprovações
// e ajustes (quantidade e taxa), ajustes por post avaliado, tempo até a
// aprovação do plano e clientes por etapa, com os filtros e agrupamentos.
import assert from "node:assert/strict";
import { createTestDatabase } from "./database-fixture.mjs";

const db = await createTestDatabase();
const uid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const [A, admin, lorena] = [1, 10, 12].map(uid);
const [product, other, squad, design] = [20, 21, 22, 23].map(uid);
const clients = [30, 31, 32].map(uid);
const contracts = [40, 41, 42].map(uid);
const otherContract = uid(43);
await db.query("insert into auth.users select unnest($1::uuid[])", [
  [admin, lorena],
]);
await db.exec(`insert into companies(id,name) values('${A}','Make');
insert into memberships(company_id,user_id,name,role) values('${A}','${admin}','Ana Admin','admin'),('${A}','${lorena}','Lorena Amaral','member');
insert into products(company_id,id,name) values('${A}','${product}','Social Leads'),('${A}','${other}','Make Ads');
insert into teams(company_id,id,name) values('${A}','${squad}','Squad'),('${A}','${design}','Criação');
insert into team_members(company_id,team_id,user_id) values('${A}','${squad}','${lorena}');
insert into clients(company_id,id,name) values('${A}','${clients[0]}','Aurora'),('${A}','${clients[1]}','Forma'),('${A}','${clients[2]}','Stravitta');
insert into client_teams(company_id,client_id,team_id) values('${A}','${clients[0]}','${squad}'),('${A}','${clients[1]}','${squad}'),('${A}','${clients[2]}','${design}');
insert into contracts(company_id,id,client_id,product_id,name) values
 ('${A}','${contracts[0]}','${clients[0]}','${product}','SL · Aurora'),
 ('${A}','${contracts[1]}','${clients[1]}','${product}','SL · Forma'),
 ('${A}','${contracts[2]}','${clients[2]}','${product}','SL · Stravitta'),
 ('${A}','${otherContract}','${clients[0]}','${other}','Ads · Aurora');
insert into social_leads_settings(company_id,product_id,team_id) values('${A}','${product}','${squad}');`);

async function as(user) {
  await db.exec("reset role");
  await db.query(`select set_config('request.jwt.claim.sub',$1,false)`, [
    user ?? "",
  ]);
  await db.exec(`set role ${user ? "authenticated" : "anon"}`);
}
const one = async (sql, params = []) => (await db.query(sql, params)).rows[0];
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
const plan = () => ({
  diagnostico: { negocio: "Rede", comoQuerSerVista: "Confiável" },
  swot: { forcas: "F", fraquezas: "Fr", oportunidades: "O", ameacas: "A" },
  pilares: [1, 2, 3, 4].map((n) => ({ titulo: `P${n}`, descricao: `D${n}` })),
  publico: "25 a 55",
  campanha: {
    objetivo: "Cadastros",
    regiao: "Brasil",
    idadeGenero: "25–55",
    segmentacao: "Interesses",
    posicionamentos: "Advantage+",
    orcamento: "R$ 500",
    perguntasFormulario: [],
    roteamentoLead: "CRM",
  },
  alertas: [],
  posts: Array.from({ length: 8 }, (_, i) => ({
    numero: i + 1,
    badge: "posicionar",
    gancho: `Gancho ${i + 1}`,
    direcaoCopy: "Copy",
    direcaoVisual: "Visual",
    formato: "Imagem única",
    cta: "Seguir",
    ehAnuncio: i === 3,
  })),
});
const today = (await one("select current_date::text as d")).d;
const preview = async (spec, vars = {}) => {
  await as(admin);
  return (
    await one("select public.dashboard_preview($1,$2,$3,$4,$5) as r", [
      A,
      spec,
      today,
      today,
      vars,
    ])
  ).r;
};
const stat = (metric, extra = {}) => ({
  viz: "stat",
  groupBy: "none",
  queries: [{ ref: "A", source: "social_leads", metric, filters: [] }],
  ...extra,
});
const total = (r) => r.series.A[0].v;

// Aurora: plano com os 8 aprovados (post 1 teve 2 ajustes antes).
// Forma: plano compartilhado, 1 ajuste e 1 aprovação. Stravitta: só briefing.
await as(admin);
for (const k of contracts)
  await db.query(
    "select public.save_social_leads_briefing($1,$2,$3,'ctwa',$4,null)",
    [A, k, { clientName: "x" }, lorena],
  );
const aurora = (
  await one(
    "select public.social_leads_write_plan($1,$2,null,$3,'x',null,'ai') as r",
    [A, contracts[0], plan()],
  )
).r.id;
await db.query(
  "select public.social_leads_decide($1,1,'rejected','Trocar foto')",
  [aurora],
);
await db.query(
  "select public.social_leads_decide($1,1,'rejected','Texto menor')",
  [aurora],
);
for (let n = 1; n <= 8; n++)
  await db.query("select public.social_leads_decide($1,$2,'approved','')", [
    aurora,
    n,
  ]);
const forma = (
  await one(
    "select public.social_leads_write_plan($1,$2,null,$3,'x',null,'ai') as r",
    [A, contracts[1], plan()],
  )
).r.id;
await as(lorena);
await db.query("select public.social_leads_decide($1,1,'rejected','Não')", [
  forma,
]);
await db.query("select public.social_leads_decide($1,2,'approved','')", [
  forma,
]);

await check("aprovações, ajustes e as taxas", async () => {
  assert.equal(total(await preview(stat("approvals"))), 9);
  assert.equal(total(await preview(stat("rejections"))), 3);
  assert.equal(Number(total(await preview(stat("approval_rate")))), 75);
  assert.equal(Number(total(await preview(stat("rejection_rate")))), 25);
  // 3 adjustments over the 10 posts that got a decision.
  assert.equal(
    Number(total(await preview(stat("adjust_per_post"))).toFixed(4)),
    0.3,
  );
});

await check(
  "agrupar por cliente e por pessoa; filtrar por equipe",
  async () => {
    const byClient = await preview({
      ...stat("rejections"),
      viz: "bar",
      groupBy: "client",
    });
    assert.deepEqual(
      byClient.series.A.map((r) => [r.l, r.v]),
      [
        ["Aurora", 2],
        ["Forma", 1],
      ],
    );
    const byPerson = await preview({
      ...stat("approvals"),
      viz: "bar",
      groupBy: "person",
    });
    assert.deepEqual(
      byPerson.series.A.map((r) => [r.l, r.v]),
      [
        ["Ana Admin", 8],
        ["Lorena Amaral", 1],
      ],
    );
    // Criação serves only Stravitta, which has no decisions.
    const team = await preview(stat("approvals"), {
      filters: { teams: [design] },
    });
    assert.equal(total(team), 0);
    const squadOnly = await preview(stat("approvals"), {
      filters: { teams: [squad] },
    });
    assert.equal(total(squadOnly), 9);
    const byTime = await preview({
      ...stat("approvals"),
      viz: "line",
      groupBy: "time",
    });
    assert.equal(byTime.series.A.at(-1).v, 9);
  },
);

await check("tempo até a aprovação: só planos com os 8 aprovados", async () => {
  const r = await preview(stat("approval_days"));
  assert.ok(total(r) !== null && Number(total(r)) >= 0);
  const byClient = await preview({
    ...stat("approval_days"),
    viz: "bar",
    groupBy: "client",
  });
  assert.deepEqual(
    byClient.series.A.map((x) => x.l),
    ["Aurora"],
  );
});

await check("clientes por etapa (situação de hoje)", async () => {
  const r = await preview({
    ...stat("clients"),
    viz: "donut",
    groupBy: "stage",
  });
  assert.deepEqual(Object.fromEntries(r.series.A.map((x) => [x.l, x.v])), {
    "Aprovado / produção": 1,
    "Aguardando o cliente": 1,
    Briefing: 1,
  });
  assert.equal(total(await preview(stat("clients"))), 3);
  // The Ads contract isn't a Social Leads client.
  const byClient = await preview({
    ...stat("clients"),
    viz: "bar",
    groupBy: "client",
  });
  assert.equal(byClient.series.A.length, 3);
});

await check("combinações sem sentido são recusadas", async () => {
  await assert.rejects(
    preview({ ...stat("clients"), viz: "line", groupBy: "time" }),
    /situação de hoje/,
  );
  await assert.rejects(
    preview({ ...stat("approvals"), viz: "bar", groupBy: "stage" }),
    /Agrupamento inválido/,
  );
  await assert.rejects(
    preview({ ...stat("approvals"), viz: "bar", groupBy: "status" }),
    /Agrupamento inválido/,
  );
  await assert.rejects(
    preview({
      ...stat("approvals"),
      queries: [
        {
          ref: "A",
          source: "social_leads",
          metric: "approvals",
          filters: [{ field: "status", values: ["done"] }],
        },
      ],
    }),
    /Filtro inválido/,
  );
  await assert.rejects(preview(stat("nada")), /Métrica inválida/);
  // Tasks still group by stage? No.
  await assert.rejects(
    preview({
      viz: "bar",
      groupBy: "stage",
      queries: [{ ref: "A", source: "tasks", metric: "count", filters: [] }],
    }),
    /Agrupamento inválido/,
  );
});

// The "Modelo: Social Leads" of the app (socialLeadsPanels in src/dashboards.ts).
const TEMPLATE = [
  {
    id: "aprovacoes",
    title: "Aprovações de posts",
    x: 0,
    y: 0,
    w: 3,
    h: 3,
    spec: {
      viz: "stat",
      groupBy: "none",
      compare: true,
      queries: [
        {
          ref: "A",
          source: "social_leads",
          metric: "approvals",
          dateField: "event",
          filters: [],
        },
      ],
    },
  },
  {
    id: "taxa-aprovacao",
    title: "Taxa de aprovação",
    x: 3,
    y: 0,
    w: 3,
    h: 3,
    spec: {
      viz: "stat",
      groupBy: "none",
      compare: true,
      queries: [
        {
          ref: "A",
          source: "social_leads",
          metric: "approval_rate",
          dateField: "event",
          filters: [],
        },
      ],
      unit: "percent",
    },
  },
  {
    id: "reprovas",
    title: "Pedidos de ajuste",
    x: 6,
    y: 0,
    w: 3,
    h: 3,
    spec: {
      viz: "stat",
      groupBy: "none",
      compare: true,
      queries: [
        {
          ref: "A",
          source: "social_leads",
          metric: "rejections",
          dateField: "event",
          filters: [],
        },
      ],
    },
  },
  {
    id: "taxa-reprova",
    title: "Taxa de reprova",
    x: 9,
    y: 0,
    w: 3,
    h: 3,
    spec: {
      viz: "stat",
      groupBy: "none",
      compare: true,
      queries: [
        {
          ref: "A",
          source: "social_leads",
          metric: "rejection_rate",
          dateField: "event",
          filters: [],
        },
      ],
      unit: "percent",
    },
  },
  {
    id: "ajustes-post",
    title: "Ajustes por post avaliado",
    x: 0,
    y: 3,
    w: 4,
    h: 3,
    spec: {
      viz: "stat",
      groupBy: "none",
      compare: true,
      queries: [
        {
          ref: "A",
          source: "social_leads",
          metric: "adjust_per_post",
          dateField: "event",
          filters: [],
        },
      ],
      decimals: 2,
    },
  },
  {
    id: "tempo-aprovacao",
    title: "Tempo até a aprovação do plano",
    x: 4,
    y: 3,
    w: 4,
    h: 3,
    spec: {
      viz: "stat",
      groupBy: "none",
      compare: true,
      queries: [
        {
          ref: "A",
          source: "social_leads",
          metric: "approval_days",
          dateField: "event",
          filters: [],
        },
      ],
      unit: "days",
    },
  },
  {
    id: "clientes",
    title: "Clientes no Social Leads",
    x: 8,
    y: 3,
    w: 4,
    h: 3,
    spec: {
      viz: "stat",
      groupBy: "none",
      compare: false,
      queries: [
        {
          ref: "A",
          source: "social_leads",
          metric: "clients",
          dateField: "event",
          filters: [],
        },
      ],
    },
  },
  {
    id: "decisoes-tempo",
    title: "Aprovações × ajustes",
    x: 0,
    y: 6,
    w: 8,
    h: 5,
    spec: {
      viz: "line",
      groupBy: "time",
      interval: "auto",
      queries: [
        {
          ref: "A",
          source: "social_leads",
          metric: "approvals",
          dateField: "event",
          filters: [],
          label: "Aprovações",
        },
        {
          ref: "B",
          source: "social_leads",
          metric: "rejections",
          dateField: "event",
          filters: [],
          label: "Ajustes",
        },
      ],
    },
  },
  {
    id: "etapas",
    title: "Clientes por etapa",
    x: 8,
    y: 6,
    w: 4,
    h: 5,
    spec: {
      viz: "donut",
      groupBy: "stage",
      queries: [
        {
          ref: "A",
          source: "social_leads",
          metric: "clients",
          dateField: "event",
          filters: [],
        },
      ],
    },
  },
  {
    id: "por-cliente",
    title: "Por cliente",
    x: 0,
    y: 11,
    w: 12,
    h: 6,
    spec: {
      viz: "table",
      groupBy: "client",
      limit: 20,
      queries: [
        {
          ref: "A",
          source: "social_leads",
          metric: "approvals",
          dateField: "event",
          filters: [],
          label: "Aprovações",
        },
        {
          ref: "B",
          source: "social_leads",
          metric: "rejections",
          dateField: "event",
          filters: [],
          label: "Ajustes",
        },
        {
          ref: "C",
          source: "social_leads",
          metric: "approval_rate",
          dateField: "event",
          filters: [],
          label: "Taxa de aprovação",
        },
        {
          ref: "D",
          source: "social_leads",
          metric: "approval_days",
          dateField: "event",
          filters: [],
          label: "Dias até aprovar",
        },
      ],
    },
  },
];
await check("o modelo Social Leads salva e cada painel calcula", async () => {
  await as(admin);
  const saved = (
    await one(
      "select public.save_dashboard($1,null,'Social Leads','',$2,$3) as r",
      [A, JSON.stringify(TEMPLATE), { range: { preset: "30d" }, filters: {} }],
    )
  ).r;
  assert.ok(saved.id);
  for (const panel of TEMPLATE) {
    const r = await preview(panel.spec);
    assert.ok(r.series.A, panel.id);
  }
});

await check("as fontes antigas continuam iguais", async () => {
  const r = await preview({
    viz: "bar",
    groupBy: "client",
    queries: [{ ref: "A", source: "tasks", metric: "count", filters: [] }],
  });
  assert.ok(Array.isArray(r.series.A));
});

console.log(`\n${passed} verificações da fonte Social Leads passaram.`);
