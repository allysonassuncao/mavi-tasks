// Social Leads, fase 2 (migration 20261016090000_social_leads_production):
// liberar produção (tarefas de arte para a equipe de criação, sem repetir),
// o ciclo do cliente (quinzenal e mensal, uma vez), artes no Drive (e no
// link do cliente só com o token certo) e a campanha criada a partir do plano.
import assert from "node:assert/strict";
import { createTestDatabase } from "./database-fixture.mjs";

const db = await createTestDatabase();
const uid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const [A, admin, lorena, designer, designer2, outsider] = [
  1, 10, 12, 14, 15, 13,
].map(uid);
const [product, squad, design, client, contract] = [20, 22, 23, 24, 25].map(
  uid,
);
const [art1, art2, doc] = [40, 41, 42].map(uid);
await db.query("insert into auth.users select unnest($1::uuid[])", [
  [admin, lorena, designer, designer2, outsider],
]);
await db.exec(`insert into companies(id,name) values('${A}','Make');
insert into memberships(company_id,user_id,name,role) values('${A}','${admin}','Ana Admin','admin'),
 ('${A}','${lorena}','Lorena Amaral','member'),('${A}','${designer}','Davi Designer','member'),
 ('${A}','${designer2}','Duda Designer','member'),('${A}','${outsider}','Caio Fora','member');
insert into products(company_id,id,name) values('${A}','${product}','Social Leads');
insert into teams(company_id,id,name) values('${A}','${squad}','Squad'),('${A}','${design}','Criação');
insert into team_members(company_id,team_id,user_id) values('${A}','${squad}','${lorena}'),
 ('${A}','${design}','${designer}'),('${A}','${design}','${designer2}');
insert into clients(company_id,id,name) values('${A}','${client}','Agente Stravitta');
insert into client_teams(company_id,client_id,team_id) values('${A}','${client}','${squad}');
insert into contracts(company_id,id,client_id,product_id,name) values('${A}','${contract}','${client}','${product}','Social Leads · Stravitta');
insert into drive_files(id,company_id,name,content_type,size_bytes,path,status,uploaded_by) values
 ('${art1}','${A}','post1-feed.png','image/png',1000,'drive/a/art1','ready','${designer}'),
 ('${art2}','${A}','post1-reels.mp4','video/mp4',2000,'drive/a/art2','ready','${designer}'),
 ('${doc}','${A}','planilha.xlsx','application/vnd.ms-excel',10,'drive/a/doc','ready','${designer}');`);

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

let planId, token;
await check("configuração: equipe de criação e prazo, só líderes", async () => {
  await as(lorena);
  await assert.rejects(
    db.query("select public.set_social_leads_settings($1,$2,$3,$4,$5)", [
      A,
      product,
      squad,
      design,
      4,
    ]),
    /Somente administradores/,
  );
  await as(admin);
  await assert.rejects(
    db.query("select public.set_social_leads_settings($1,$2,$3,$4,$5)", [
      A,
      product,
      squad,
      design,
      99,
    ]),
    /de 1 a 60 dias/,
  );
  await db.query("select public.set_social_leads_settings($1,$2,$3,$4,$5)", [
    A,
    product,
    squad,
    design,
    4,
  ]);
  await as(lorena);
  await db.query(
    "select public.save_social_leads_briefing($1,$2,$3,'form_nativo',$4,null)",
    [A, contract, { clientName: "Agente Stravitta" }, lorena],
  );
  planId = (
    await one(
      "select public.social_leads_write_plan($1,$2,null,$3,'x',null,'ai') as r",
      [A, contract, plan()],
    )
  ).r.id;
});

await check(
  "liberar produção: uma tarefa por post aprovado, para a equipe de criação",
  async () => {
    await as(lorena);
    await assert.rejects(
      db.query("select public.social_leads_release($1)", [planId]),
      /Nenhum post aprovado/,
    );
    for (const n of [1, 2, 3])
      await db.query("select public.social_leads_decide($1,$2,'approved','')", [
        planId,
        n,
      ]);
    await db.query(
      "select public.social_leads_decide($1,4,'rejected','Trocar a foto')",
      [planId],
    );
    const r = (
      await one("select public.social_leads_release($1) as r", [planId])
    ).r;
    assert.deepEqual(r, { created: 3, cycle: true });
    await db.exec("reset role");
    const tasks = await all(
      `select x.number, t.title, t.team_id, t.assignee_id, t.priority, t.due_date - current_date as days, t.description
     from social_leads_posts x join tasks t on t.id = x.task_id where x.plan_id = $1 order by x.number`,
      [planId],
    );
    assert.equal(tasks.length, 3);
    assert.equal(tasks[0].title, "Arte do post 1 · Mês 1 · Agente Stravitta");
    assert.ok(tasks.every((t) => t.team_id === design && t.days === 4));
    // Spread across the team (fewest open tasks first).
    assert.deepEqual(
      new Set(tasks.map((t) => t.assignee_id)),
      new Set([designer, designer2]),
    );
    assert.match(
      tasks[0].description,
      /Gancho: Gancho 1\nDireção de copy: Copy/,
    );
    // The creative team now serves the client.
    assert.ok(
      await one(
        "select 1 from client_teams where client_id=$1 and team_id=$2",
        [client, design],
      ),
    );
    // Releasing again creates only the new ones.
    await as(lorena);
    await db.query("select public.social_leads_decide($1,4,'approved','')", [
      planId,
    ]);
    await assert.rejects(
      db.query("select public.social_leads_release($1,$2)", [
        planId,
        { 4: { user: uid(99) } },
      ]),
      /Post 4: responsável inválido/,
    );
    // Now to one person: Caio (outside the client's teams).
    const again = (
      await one("select public.social_leads_release($1,$2) as r", [
        planId,
        { 4: { user: outsider } },
      ])
    ).r;
    assert.deepEqual(again, { created: 1, cycle: false });
    await db.exec("reset role");
    assert.deepEqual(
      await one(
        "select priority, assignee_id, team_id from tasks t join social_leads_posts x on x.task_id=t.id where x.plan_id=$1 and x.number=4",
        [planId],
      ),
      { priority: "high", assignee_id: outsider, team_id: null },
    );
  },
);

await check("cada post pode ir para uma equipe ou uma pessoa", async () => {
  await as(lorena);
  const month2 = (
    await one(
      "select public.social_leads_write_plan($1,$2,null,$3,'x',null,'ai') as r",
      [A, contract, plan()],
    )
  ).r.id;
  for (const n of [1, 2, 3])
    await db.query("select public.social_leads_decide($1,$2,'approved','')", [
      month2,
      n,
    ]);
  await assert.rejects(
    db.query("select public.social_leads_release($1,$2)", [
      month2,
      { 1: { team: uid(98) } },
    ]),
    /Post 1: equipe não encontrada/,
  );
  const r = (
    await one("select public.social_leads_release($1,$2) as r", [
      month2,
      { 1: { team: squad }, 2: { user: lorena } },
    ])
  ).r;
  assert.deepEqual(r, { created: 3, cycle: false });
  await db.exec("reset role");
  const tasks = await all(
    `select x.number, t.team_id, t.assignee_id from social_leads_posts x join tasks t on t.id = x.task_id
     where x.plan_id = $1 order by x.number`,
    [month2],
  );
  assert.deepEqual(tasks.slice(0, 2), [
    { number: 1, team_id: squad, assignee_id: lorena },
    { number: 2, team_id: null, assignee_id: lorena },
  ]);
  // Without a choice, the creative team.
  assert.equal(tasks[2].team_id, design);
  await db.query("delete from social_leads_plans where id=$1", [month2]);
});

await check(
  "o ciclo do cliente: quinzenal e mensal, para a responsável, uma vez",
  async () => {
    await db.exec("reset role");
    const b = await one(
      "select cycle from social_leads_briefings where contract_id=$1",
      [contract],
    );
    const rows = await all(
      `select t.title, t.assignee_id, r.frequency from tasks t join task_recurrences r on r.id = t.recurrence_id
     where t.id in ($1,$2) order by r.frequency`,
      [b.cycle.followup, b.cycle.meeting],
    );
    assert.deepEqual(rows, [
      {
        title: "Acompanhamento quinzenal · Agente Stravitta",
        assignee_id: lorena,
        frequency: "biweekly",
      },
      {
        title: "Reunião de resultados e novo plano · Agente Stravitta",
        assignee_id: lorena,
        frequency: "monthly",
      },
    ]);
  },
);

await check(
  "artes: imagem, vídeo ou PDF do Drive, por quem grava",
  async () => {
    await as(designer);
    const saved = (
      await one("select public.social_leads_set_arts($1,1,$2) as r", [
        planId,
        [{ id: art1 }, { id: art2 }],
      ])
    ).r;
    assert.deepEqual(
      saved.map((a) => a.name),
      ["post1-feed.png", "post1-reels.mp4"],
    );
    await assert.rejects(
      db.query("select public.social_leads_set_arts($1,2,$2)", [
        planId,
        [{ id: doc }],
      ]),
      /imagem, vídeo ou PDF/,
    );
    await as(outsider);
    await assert.rejects(
      db.query("select public.social_leads_set_arts($1,1,'[]')", [planId]),
      /Plano não encontrado/,
    );
    // Content edits keep the task and the arts.
    await as(lorena);
    const v = (
      await one("select version from social_leads_plans where id=$1", [planId])
    ).version;
    const next = plan();
    next.posts[0].gancho = "Novo gancho";
    await db.query(
      "select public.social_leads_write_plan($1,$2,$3,$4,'edição',$5,'manual')",
      [A, contract, planId, next, v],
    );
    const p1 = await one(
      "select task_id, arts from social_leads_posts where plan_id=$1 and number=1",
      [planId],
    );
    assert.ok(p1.task_id);
    assert.equal(p1.arts.length, 2);
  },
);

await check(
  "o link do cliente mostra as artes e só libera o arquivo com o token certo",
  async () => {
    await as(lorena);
    token = (
      await one("select public.social_leads_share($1,true,false) as s", [
        planId,
      ])
    ).s.share_token;
    await as(null);
    const view = (
      await one("select public.social_leads_shared_plan($1) as v", [token])
    ).v;
    assert.deepEqual(view.posts[0].arts, [
      { id: art1, name: "post1-feed.png", type: "image/png" },
      { id: art2, name: "post1-reels.mp4", type: "video/mp4" },
    ]);
    assert.ok(
      !JSON.stringify(view).includes("drive/a/"),
      "o link não expõe o caminho do arquivo",
    );
    const hit = await all(
      "select * from public.social_leads_public_art($1,$2)",
      [token, art1],
    );
    assert.deepEqual(hit, [
      {
        path: "drive/a/art1",
        name: "post1-feed.png",
        content_type: "image/png",
      },
    ]);
    assert.equal(
      (
        await all("select * from public.social_leads_public_art($1,$2)", [
          token,
          doc,
        ])
      ).length,
      0,
    );
    assert.equal(
      (
        await all("select * from public.social_leads_public_art($1,$2)", [
          "0".repeat(64),
          art1,
        ])
      ).length,
      0,
    );
    await as(lorena);
    await db.query("select public.social_leads_share($1,false,false)", [
      planId,
    ]);
    await as(null);
    assert.equal(
      (
        await all("select * from public.social_leads_public_art($1,$2)", [
          token,
          art1,
        ])
      ).length,
      0,
    );
  },
);

await check(
  "campanha: só líderes criam, e a carteira mostra se está no ar",
  async () => {
    await as(lorena);
    await assert.rejects(
      db.query("select public.social_leads_create_campaign($1)", [planId]),
      /Somente administradores/,
    );
    let item = (await one("select public.social_leads_portfolio($1) as r", [A]))
      .r.items[0];
    assert.equal(item.campaign, null);
    assert.equal(item.plan.tasks, 4);
    assert.equal(item.plan.arts, 1);
    await as(admin);
    const id = (
      await one("select public.social_leads_create_campaign($1) as id", [
        planId,
      ])
    ).id;
    const c = await one(
      "select name, platform, status, notes from ad_campaigns where id=$1",
      [id],
    );
    assert.equal(c.name, "Social Leads · Agente Stravitta");
    assert.equal(c.platform, "meta");
    assert.equal(c.status, "inactive");
    assert.match(c.notes, /Anúncio: Post 4: Gancho 4/);
    item = (await one("select public.social_leads_portfolio($1) as r", [A])).r
      .items[0];
    assert.deepEqual(item.campaign, { id, name: c.name, active: false });
    await db.exec("reset role");
    await db.query("update ad_campaigns set status='active' where id=$1", [id]);
    // Collaborators see that it's live, not which campaign.
    await as(lorena);
    item = (await one("select public.social_leads_portfolio($1) as r", [A])).r
      .items[0];
    assert.deepEqual(item.campaign, { id: null, name: null, active: true });
  },
);

console.log(`\n${passed} verificações da produção passaram.`);
