// Planejamento › Social Media (migration 20261210090000_social_media): o
// mesmo módulo do Social Leads, com a configuração, o produto, o squad e a
// equipe de criação próprios. A configuração de antes continua sendo a do
// Social Leads, e as tarefas de arte que ninguém editou passam a dizer
// "Planejamento › Social Leads".
import assert from "node:assert/strict";
import { applyMigration, createTestDatabase } from "./database-fixture.mjs";

const db = await createTestDatabase({ until: "20261210090000" });
const uid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const [A, admin, lorena, sofia, designer] = [1, 10, 12, 13, 14].map(uid);
const [leadsProduct, mediaProduct, leadsSquad, mediaSquad, design] = [
  20, 21, 22, 23, 24,
].map(uid);
const [aurora, forma, nova] = [30, 31, 32].map(uid);
const [leadsContract, mediaContract] = [40, 41].map(uid);
await db.query("insert into auth.users select unnest($1::uuid[])", [
  [admin, lorena, sofia, designer],
]);
await db.exec(`insert into companies(id,name) values('${A}','Make');
insert into memberships(company_id,user_id,name,role) values('${A}','${admin}','Ana Admin','admin'),
 ('${A}','${lorena}','Lorena Amaral','member'),('${A}','${sofia}','Sofia Social','member'),
 ('${A}','${designer}','Davi Designer','member');
insert into products(company_id,id,name) values('${A}','${leadsProduct}','Social Leads'),
 ('${A}','${mediaProduct}','Social Media');
insert into teams(company_id,id,name) values('${A}','${leadsSquad}','Squad Leads'),
 ('${A}','${mediaSquad}','Squad Media'),('${A}','${design}','Criação');
insert into team_members(company_id,team_id,user_id) values('${A}','${leadsSquad}','${lorena}'),
 ('${A}','${mediaSquad}','${sofia}'),('${A}','${design}','${designer}');
insert into clients(company_id,id,name) values('${A}','${aurora}','Aurora'),('${A}','${forma}','Forma'),
 ('${A}','${nova}','Nova');
insert into client_teams(company_id,client_id,team_id) values('${A}','${aurora}','${leadsSquad}'),
 ('${A}','${forma}','${mediaSquad}');
insert into contracts(company_id,id,client_id,product_id,name) values
 ('${A}','${leadsContract}','${aurora}','${leadsProduct}','Social Leads · Aurora'),
 ('${A}','${mediaContract}','${forma}','${mediaProduct}','Social Media · Forma');
insert into social_leads_settings(company_id,product_id,team_id,design_team_id)
 values('${A}','${leadsProduct}','${leadsSquad}','${design}');`);

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
/** A plan with post 1 approved, released (art task + cycle). */
async function released(user, contract) {
  await as(user);
  await db.query(
    "select public.save_social_leads_briefing($1,$2,$3,'ctwa',null,null)",
    [A, contract, { clientName: "Cliente" }],
  );
  const id = (
    await one(
      "select public.social_leads_write_plan($1,$2,null,$3,'x',null,'ai') as r",
      [A, contract, plan()],
    )
  ).r.id;
  await db.query("select public.social_leads_decide($1,1,'approved','')", [
    id,
  ]);
  await db.query("select public.social_leads_release($1,'{}')", [id]);
  await db.exec("reset role");
  return id;
}
const artTask = async (planId) =>
  one(
    `select t.* from tasks t join social_leads_posts x on x.task_id = t.id
     where x.plan_id = $1 and x.number = 1`,
    [planId],
  );

// Released before the migration: the untouched art task says "Onboarding".
const leadsPlan = await released(lorena, leadsContract);
assert.match(
  (await artTask(leadsPlan)).description,
  /Onde fica: Onboarding › Social Leads › /,
);
await applyMigration(db, "20261210090000");

await check(
  "a configuração de antes é a do Social Leads; tarefas intocadas trocam o texto",
  async () => {
    const s = await one("select module from social_leads_settings");
    assert.equal(s.module, "social_leads");
    const t = await artTask(leadsPlan);
    assert.match(t.description, /Onde fica: Planejamento › Social Leads › /);
    assert.doesNotMatch(t.description, /Onboarding/);
    const meeting = await one(
      "select description from tasks where title like 'Reunião de resultados%'",
    );
    assert.equal(
      meeting.description,
      "Apresente os resultados do mês ao cliente e gere o plano do próximo mês em Planejamento › Social Leads.",
    );
    // The task still follows the post (the text is recognized).
    await db.query(
      "update social_leads_posts set hook='Gancho novo' where plan_id=$1 and number=1",
      [leadsPlan],
    );
    assert.match((await artTask(leadsPlan)).description, /Gancho novo/);
  },
);

await check("configurar o Social Media: só líderes, produto próprio", async () => {
  await as(sofia);
  await assert.rejects(
    db.query(
      "select public.set_social_leads_settings($1,$2,$3,null,5,'social_media')",
      [A, mediaProduct, mediaSquad],
    ),
    /configuram o Social Media/,
  );
  await as(admin);
  await assert.rejects(
    db.query(
      "select public.set_social_leads_settings($1,$2,$3,null,5,'social_media')",
      [A, leadsProduct, mediaSquad],
    ),
    /já é o do Social Leads/,
  );
  await assert.rejects(
    db.query(
      "select public.set_social_leads_settings($1,$2,$3,null,5,'outro')",
      [A, mediaProduct, mediaSquad],
    ),
    /Módulo inválido/,
  );
  const before = (await one("select public.social_leads_portfolio($1,'social_media') as r", [A])).r;
  assert.deepEqual(before, { configured: false, module: "social_media", items: [] });
  await db.query(
    "select public.set_social_leads_settings($1,$2,$3,null,3,'social_media')",
    [A, mediaProduct, mediaSquad],
  );
  // Saving Social Leads again doesn't touch Social Media.
  await db.query("select public.set_social_leads_settings($1,$2,$3,$4,5)", [
    A,
    leadsProduct,
    leadsSquad,
    design,
  ]);
  await db.exec("reset role");
  const rows = (
    await db.query(
      "select module, product_id, team_id, art_days from social_leads_settings order by module",
    )
  ).rows;
  assert.deepEqual(rows, [
    { module: "social_leads", product_id: leadsProduct, team_id: leadsSquad, art_days: 5 },
    { module: "social_media", product_id: mediaProduct, team_id: mediaSquad, art_days: 3 },
  ]);
});

await check("cada carteira mostra os clientes do seu produto", async () => {
  await as(admin);
  const items = async (m) =>
    (
      await one("select public.social_leads_portfolio($1,$2) as r", [A, m])
    ).r.items.map((i) => i.client_name);
  assert.deepEqual(await items("social_leads"), ["Aurora"]);
  assert.deepEqual(await items("social_media"), ["Forma"]);
  // The old call (no module) is Social Leads.
  const old = (await one("select public.social_leads_portfolio($1) as r", [A])).r;
  assert.equal(old.module, "social_leads");
  assert.equal(old.product_id, leadsProduct);
});

await check(
  "adicionar cliente ao Social Media: o produto e o squad são os dele",
  async () => {
    // Sofia is of the Social Media squad: she may add any client there,
    // and none to Social Leads (Nova isn't served by a team of hers).
    await as(sofia);
    const addable = async (m) =>
      (
        await one("select public.social_leads_addable_clients($1,$2) as r", [
          A,
          m,
        ])
      ).r.map((c) => c.name);
    assert.deepEqual(await addable("social_media"), ["Aurora", "Nova"]);
    assert.deepEqual(await addable("social_leads"), ["Forma"]);
    const k = (
      await one(
        "select public.social_leads_add_client($1,$2,null,null,'social_media') as k",
        [A, nova],
      )
    ).k;
    await db.exec("reset role");
    const c = await one("select product_id, name from contracts where id=$1", [k]);
    assert.deepEqual(c, { product_id: mediaProduct, name: "Social Media · Nova" });
    assert.ok(
      await one(
        "select 1 as x from client_teams where client_id=$1 and team_id=$2",
        [nova, mediaSquad],
      ),
    );
    await as(sofia);
    await assert.rejects(
      db.query(
        "select public.social_leads_add_client($1,$2,null,null,'social_media')",
        [A, nova],
      ),
      /já está no Social Media/,
    );
    // Taking it out (added by mistake) speaks of Social Media too.
    await db.query("select public.social_leads_archive($1,true)", [k]);
    await db.query("select public.social_leads_archive($1,false)", [k]);
    await db.query("select public.social_leads_remove($1)", [k]);
    await db.exec("reset role");
    assert.equal(await one("select 1 as x from contracts where id=$1", [k]), undefined);
  },
);

await check(
  "liberar produção no Social Media: equipe, prazo e textos dele",
  async () => {
    const id = await released(sofia, mediaContract);
    const t = await artTask(id);
    assert.match(t.description, /Onde fica: Planejamento › Social Media › /);
    // No creative team in Social Media: its squad (not Social Leads' Criação).
    assert.equal(t.team_id, mediaSquad);
    const leads = await artTask(leadsPlan);
    assert.equal(
      (await one("select $1::date - $2::date as d", [t.due_date, leads.due_date])).d,
      -2,
    );
    const meeting = await one(
      "select description from tasks where contract_id=$1 and title like 'Reunião de resultados%'",
      [mediaContract],
    );
    assert.match(meeting.description, /em Planejamento › Social Media\.$/);
    // The campaign is named after the module.
    await as(admin);
    const campaign = (
      await one("select public.social_leads_create_campaign($1) as c", [id])
    ).c;
    await db.exec("reset role");
    const c = await one("select name, notes from ad_campaigns where id=$1", [
      campaign,
    ]);
    assert.equal(c.name, "Social Media · Cliente");
    assert.match(c.notes, /^Criada a partir do Social Media · /);
  },
);

await check("o aviso de plano pronto abre a página do módulo", async () => {
  await db.exec("reset role");
  const job = async (contract) =>
    (
      await one(
        "insert into social_leads_jobs(company_id,contract_id,kind,created_by) values($1,$2,'new',$3) returning id",
        [A, contract, admin],
      )
    ).id;
  const [leadsJob, mediaJob] = [
    await job(leadsContract),
    await job(mediaContract),
  ];
  await as(admin);
  await db.query("select public.social_leads_finish_job($1,null,null)", [leadsJob]);
  await db.query("select public.social_leads_finish_job($1,null,null)", [mediaJob]);
  await db.exec("reset role");
  const links = (
    await db.query(
      "select link from notifications where kind='social_leads' order by link",
    )
  ).rows.map((r) => r.link);
  assert.deepEqual(links, [
    `/onboarding/social-leads?contrato=${leadsContract}`,
    `/planejamento/social-media?contrato=${mediaContract}`,
  ]);
});

await check("Social Media pode ser escondido por pessoa", async () => {
  await as(admin);
  await db.query("select public.set_member_pages($1,$2,$3)", [
    A,
    sofia,
    ["socialMedia"],
  ]);
  await db.exec("reset role");
  const m = await one(
    "select hidden_pages from memberships where company_id=$1 and user_id=$2",
    [A, sofia],
  );
  assert.deepEqual(m.hidden_pages, ["socialMedia"]);
});

console.log(`\n${passed} verificações do Social Media passaram.`);
