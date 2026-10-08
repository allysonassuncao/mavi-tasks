// Social Leads e Social Media (migration 20270622090000_social_leads_release_due):
// no "Liberar produção" quem libera escolhe o prazo de entrega das tarefas de
// arte — uma data para todas ou uma por post; sem data, hoje + os dias da
// arte; nunca antes de hoje; antes do mínimo da regra, só com motivo.
import assert from "node:assert/strict";
import { createTestDatabase } from "./database-fixture.mjs";

const db = await createTestDatabase();
const uid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const [A, lorena, marina, julia, gone] = [1, 12, 14, 15, 16].map(uid);
const [product, squad] = [20, 22].map(uid);
const clients = [30, 31].map(uid);
const contracts = [40, 41].map(uid);
await db.query("insert into auth.users select unnest($1::uuid[])", [
  [lorena, marina, julia, gone],
]);
await db.exec(`insert into companies(id,name) values('${A}','Make');
insert into memberships(company_id,user_id,name,role,active) values('${A}','${lorena}','Lorena Amaral','member',true),
 ('${A}','${marina}','Marina Costa','member',true),('${A}','${julia}','Júlia Santos','member',true),
 ('${A}','${gone}','Saiu da Empresa','member',false);
insert into products(company_id,id,name) values('${A}','${product}','Social Leads');
insert into teams(company_id,id,name) values('${A}','${squad}','Squad');
insert into team_members(company_id,team_id,user_id) values('${A}','${squad}','${lorena}'),('${A}','${squad}','${marina}');
insert into clients(company_id,id,name) values('${A}','${clients[0]}','Aurora'),('${A}','${clients[1]}','Forma');
insert into client_teams(company_id,client_id,team_id) values('${A}','${clients[0]}','${squad}'),('${A}','${clients[1]}','${squad}');
insert into contracts(company_id,id,client_id,product_id,name) values
 ('${A}','${contracts[0]}','${clients[0]}','${product}','Social Leads · Aurora'),
 ('${A}','${contracts[1]}','${clients[1]}','${product}','Social Leads · Forma');
insert into social_leads_settings(company_id,product_id,team_id,art_days) values('${A}','${product}','${squad}',4);`);

async function as(user) {
  await db.exec("reset role");
  await db.query(`select set_config('request.jwt.claim.sub',$1,false)`, [
    user ?? "",
  ]);
  await db.exec(`set role ${user ? "authenticated" : "anon"}`);
}
const one = async (sql, params = []) => (await db.query(sql, params)).rows[0];
const all = async (sql, params = []) => (await db.query(sql, params)).rows;
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
/** A plan with posts 1, 2 and 3 approved. */
async function approvedPlan(contract) {
  await as(lorena);
  await db.query(
    "select public.save_social_leads_briefing($1,$2,$3,'ctwa',$4,null)",
    [A, contract, { clientName: "Cliente" }, julia],
  );
  const id = (
    await one(
      "select public.social_leads_write_plan($1,$2,null,$3,'x',null,'ai') as r",
      [A, contract, plan()],
    )
  ).r.id;
  for (const n of [1, 2, 3])
    await db.query("select public.social_leads_decide($1,$2,'approved','')", [
      id,
      n,
    ]);
  return id;
}
const dues = async (plan) => {
  await db.exec("reset role");
  const rows = await all(
    `select p.number, t.due_date::text as due, t.due_manual, t.due_tight_reason
     from social_leads_posts p join tasks t on t.id = p.task_id
     where p.plan_id = $1 order by p.number`,
    [plan],
  );
  return Object.fromEntries(rows.map((r) => [r.number, r]));
};
const { today } = await one(
  "select mavi_private.company_today($1)::text as today",
  [A],
);
const plus = async (n) =>
  (await one("select ($1::date + $2::int)::text as d", [today, n])).d;

await check("sem data: hoje + os dias da arte (como antes)", async () => {
  const id = await approvedPlan(contracts[0]);
  await as(lorena);
  await db.query("select public.social_leads_release($1,'{}')", [id]);
  const d = await dues(id);
  const expected = await plus(4);
  assert.deepEqual(
    [1, 2, 3].map((n) => d[n].due),
    [expected, expected, expected],
  );
  assert.ok(d[1].due_manual);
});

await check(
  "uma data para todos e outra para um post; antes de hoje não",
  async () => {
    const id = await approvedPlan(contracts[1]);
    const [all, one2, past] = [await plus(10), await plus(2), await plus(-1)];
    await as(lorena);
    await assert.rejects(
      db.query("select public.social_leads_release($1,$2)", [
        id,
        { 2: { team: squad, due: past } },
      ]),
      /Post 2: o prazo de entrega não pode ser antes de hoje/,
    );
    await assert.rejects(
      db.query("select public.social_leads_release($1,$2)", [
        id,
        { 1: { team: squad, due: "2026-02-31" } },
      ]),
      /Post 1: prazo de entrega inválido/,
    );
    await db.query("select public.social_leads_release($1,$2)", [
      id,
      { due: all, 2: { user: marina, due: one2 } },
    ]);
    const d = await dues(id);
    assert.deepEqual(
      [1, 2, 3].map((n) => d[n].due),
      [all, one2, all],
    );
  },
);

await check("antes do mínimo da regra: só com motivo", async () => {
  await db.exec("reset role");
  await db.query(
    "insert into task_due_rules(company_id,product_id,business_days,min_days) values($1,$2,6,5)",
    [A, product],
  );
  const contract = uid(42);
  await db.exec(`insert into clients(company_id,id,name) values('${A}','${uid(32)}','Brisa');
insert into client_teams(company_id,client_id,team_id) values('${A}','${uid(32)}','${squad}');
insert into contracts(company_id,id,client_id,product_id,name) values('${A}','${contract}','${uid(32)}','${product}','Social Leads · Brisa');`);
  const id = await approvedPlan(contract);
  const soon = today;
  await as(lorena);
  await assert.rejects(
    db.query("select public.social_leads_release($1,$2)", [
      id,
      { 3: { team: squad, due: soon } },
    ]),
    (e) => e.code === "MV002" && /^Post \d+: Este prazo fica antes do mínimo/.test(e.message),
  );
  const far = await plus(30);
  await db.query("select public.social_leads_release($1,$2)", [
    id,
    {
      1: { team: squad, due: far },
      2: { team: squad, due: far },
      3: { team: squad, due: soon, reason: "Lançamento do cliente" },
    },
  ]);
  const d = await dues(id);
  assert.equal(d[3].due, soon);
  assert.equal(d[3].due_tight_reason, "Lançamento do cliente");
  assert.equal(d[1].due, far);
});

console.log(`\n${passed} verificações do prazo ao liberar a produção passaram.`);
