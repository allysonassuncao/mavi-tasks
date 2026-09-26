// Social Leads (migration 20261019090000_social_leads_cycle_owners): quem
// recebe o "Acompanhamento quinzenal" e a "Reunião de resultados e novo
// plano" é escolhido no "Liberar produção"; sem escolha, quem liberou.
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
/** A plan with posts 1 and 2 approved, briefing responsible Júlia. */
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
  for (const n of [1, 2])
    await db.query("select public.social_leads_decide($1,$2,'approved','')", [
      id,
      n,
    ]);
  return id;
}
const cycleOwners = async (contract) => {
  await db.exec("reset role");
  const b = await one(
    "select cycle from social_leads_briefings where contract_id=$1",
    [contract],
  );
  const owner = async (id) =>
    (await one("select assignee_id from tasks where id=$1", [id])).assignee_id;
  return {
    followup: await owner(b.cycle.followup),
    meeting: await owner(b.cycle.meeting),
  };
};

await check("cada tarefa do ciclo vai para quem foi escolhido", async () => {
  const id = await approvedPlan(contracts[0]);
  await as(lorena);
  await assert.rejects(
    db.query("select public.social_leads_release($1,$2)", [
      id,
      { cycle: { followup: gone } },
    ]),
    /Responsável do ciclo inválido/,
  );
  await assert.rejects(
    db.query("select public.social_leads_release($1,$2)", [
      id,
      { cycle: { meeting: "x" } },
    ]),
    /Responsável do ciclo inválido/,
  );
  await assert.rejects(
    db.query("select public.social_leads_release($1,$2)", [
      id,
      { cycle: "Marina" },
    ]),
    /Responsável do ciclo inválido/,
  );
  // Nothing was created by the rejected calls.
  await db.exec("reset role");
  assert.equal((await one("select count(*)::int as n from tasks")).n, 0);
  await as(lorena);
  const r = (
    await one("select public.social_leads_release($1,$2) as r", [
      id,
      { 1: { user: marina }, cycle: { followup: marina, meeting: julia } },
    ])
  ).r;
  assert.deepEqual(r, { created: 2, cycle: true });
  assert.deepEqual(await cycleOwners(contracts[0]), {
    followup: marina,
    meeting: julia,
  });
});

await check(
  "sem escolha, o ciclo fica com quem liberou; depois não muda",
  async () => {
    const id = await approvedPlan(contracts[1]);
    await as(marina);
    await db.query("select public.social_leads_release($1,'{}')", [id]);
    // Marina released (the briefing's responsible is Júlia).
    assert.deepEqual(await cycleOwners(contracts[1]), {
      followup: marina,
      meeting: marina,
    });
    // The next release doesn't open the cycle again, whatever is sent.
    await as(lorena);
    await db.query("select public.social_leads_decide($1,3,'approved','')", [
      id,
    ]);
    const r = (
      await one("select public.social_leads_release($1,$2) as r", [
        id,
        { cycle: { followup: julia, meeting: julia } },
      ])
    ).r;
    assert.deepEqual(r, { created: 1, cycle: false });
    assert.deepEqual(await cycleOwners(contracts[1]), {
      followup: marina,
      meeting: marina,
    });
  },
);

console.log(`\n${passed} verificações dos responsáveis do ciclo passaram.`);
