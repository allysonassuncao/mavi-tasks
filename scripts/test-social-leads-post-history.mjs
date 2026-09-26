// Social Leads (migration 20261020090000_social_leads_post_history): o
// histórico de cada post. Criação, decisões da equipe e do cliente (com a
// observação), reabertura, edições (antes e depois, com o motivo), troca do
// anúncio sem registros falsos, artes, tarefa de arte, comentários e o que já
// existia antes da migração.
import assert from "node:assert/strict";
import { applyMigration, createTestDatabase } from "./database-fixture.mjs";

const db = await createTestDatabase({ until: "20261020090000" });
const uid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const [A, lorena, marina, outsider] = [1, 12, 14, 13].map(uid);
const [product, squad, design, client, contract, art1] = [
  20, 22, 23, 24, 25, 40,
].map(uid);
await db.query("insert into auth.users select unnest($1::uuid[])", [
  [lorena, marina, outsider],
]);
await db.exec(`insert into companies(id,name) values('${A}','Make');
insert into memberships(company_id,user_id,name,role) values('${A}','${lorena}','Lorena Amaral','member'),
 ('${A}','${marina}','Marina Costa','member'),('${A}','${outsider}','Caio Fora','member');
insert into products(company_id,id,name) values('${A}','${product}','Social Leads');
insert into teams(company_id,id,name) values('${A}','${squad}','Squad'),('${A}','${design}','Criação');
insert into team_members(company_id,team_id,user_id) values('${A}','${squad}','${lorena}'),('${A}','${design}','${marina}');
insert into clients(company_id,id,name) values('${A}','${client}','Agente Stravitta');
insert into client_teams(company_id,client_id,team_id) values('${A}','${client}','${squad}');
insert into contracts(company_id,id,client_id,product_id,name) values('${A}','${contract}','${client}','${product}','Social Leads · Stravitta');
insert into social_leads_settings(company_id,product_id,team_id,design_team_id) values('${A}','${product}','${squad}','${design}');
insert into drive_files(id,company_id,name,content_type,size_bytes,path,status,uploaded_by) values
 ('${art1}','${A}','post1-feed.png','image/png',1000,'drive/a/art1','ready','${marina}');`);

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
const plan = (change = {}) => ({
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
    ...(change[i + 1] ?? {}),
  })),
});
const events = async (planId, number) => {
  await db.exec("reset role");
  return (
    await db.query(
      `select kind, via, actor_id, actor_name, note, detail from social_leads_post_events
       where plan_id=$1 and number=$2 order by created_at, seq`,
      [planId, number],
    )
  ).rows;
};

// ---- Antes da migração: um plano com decisões, tarefa e artes.
await as(lorena);
await db.query(
  "select public.save_social_leads_briefing($1,$2,$3,'ctwa',$4,null)",
  [A, contract, { clientName: "Stravitta" }, lorena],
);
const old = (
  await one(
    "select public.social_leads_write_plan($1,$2,null,$3,'x',null,'ai') as r",
    [A, contract, plan()],
  )
).r.id;
await db.query(
  "select public.social_leads_decide($1,1,'approved','Pode seguir')",
  [old],
);
await db.query("select public.social_leads_release($1,'{}')", [old]);
await as(marina);
await db.query("select public.social_leads_set_arts($1,1,$2)", [
  old,
  [{ id: art1 }],
]);
await db.exec("reset role");
const token = (
  await one("select share_token from social_leads_plans where id=$1", [old])
).share_token;
await db.query("update social_leads_plans set share_enabled=true where id=$1", [
  old,
]);
await as(null);
await db.query(
  "select public.social_leads_client_decide($1,2,'rejected','Trocar a foto')",
  [token],
);
await db.exec("reset role");
await applyMigration(db, "20261020090000");

await check("o que já existia vira histórico (uma vez)", async () => {
  const first = await events(old, 1);
  assert.deepEqual(
    first.map((e) => [e.kind, e.via, e.actor_name]),
    [
      ["created", "ai", "Lorena Amaral"],
      ["approved", "team", "Lorena Amaral"],
      ["task", "team", "Lorena Amaral"],
      ["arts", "team", ""],
    ],
  );
  assert.equal(first[1].note, "Pode seguir");
  assert.equal(first[2].detail.team, "Criação");
  assert.deepEqual(
    first[3].detail.added.map((a) => a.name),
    ["post1-feed.png"],
  );
  const second = await events(old, 2);
  assert.deepEqual(
    second.map((e) => [e.kind, e.via, e.actor_name, e.note]),
    [
      ["created", "ai", "Lorena Amaral", ""],
      ["rejected", "link", "Stravitta", "Trocar a foto"],
    ],
  );
  // Running the migration again adds nothing.
  await applyMigration(db, "20261020090000");
  assert.equal((await events(old, 1)).length, 4);
});

let planId;
await check("plano novo: um registro de criação por post", async () => {
  await as(lorena);
  planId = (
    await one(
      "select public.social_leads_write_plan($1,$2,null,$3,'x',null,'ai') as r",
      [A, contract, plan()],
    )
  ).r.id;
  await db.exec("reset role");
  const r = await one(
    "select count(*)::int as n, count(distinct number)::int as posts from social_leads_post_events where plan_id=$1 and kind='created'",
    [planId],
  );
  assert.deepEqual(r, { n: 8, posts: 8 });
});

await check(
  "decisões da equipe e do cliente, com observação e reabertura",
  async () => {
    await as(lorena);
    await db.query(
      "select public.social_leads_decide($1,3,'rejected','Cliente quer foto da fachada')",
      [planId],
    );
    await db.query(
      "select public.social_leads_decide($1,3,'rejected','E o texto mais curto')",
      [planId],
    );
    await db.query("select public.social_leads_decide($1,3,'pending','')", [
      planId,
    ]);
    await db.exec("reset role");
    await db.query(
      "update social_leads_plans set share_enabled=true where id=$1",
      [planId],
    );
    const t = (
      await one("select share_token from social_leads_plans where id=$1", [
        planId,
      ])
    ).share_token;
    await as(null);
    await db.query(
      "select public.social_leads_client_decide($1,3,'approved','Agora sim')",
      [t],
    );
    const list = (await events(planId, 3)).slice(1);
    assert.deepEqual(
      list.map((e) => [e.kind, e.via, e.actor_name, e.note]),
      [
        ["rejected", "team", "Lorena Amaral", "Cliente quer foto da fachada"],
        ["rejected", "team", "Lorena Amaral", "E o texto mais curto"],
        ["reopened", "team", "Lorena Amaral", ""],
        ["approved", "link", "Stravitta", "Agora sim"],
      ],
    );
    assert.equal(list[3].actor_id, null);
  },
);

await check(
  "edição: antes e depois, motivo, e o post volta a pendente",
  async () => {
    await as(lorena);
    const v = (
      await one("select version from social_leads_plans where id=$1", [planId])
    ).version;
    await db.query(
      "select public.social_leads_write_plan($1,$2,$3,$4,'Post 3 editado',$5,'manual')",
      [
        A,
        contract,
        planId,
        plan({ 3: { gancho: "Gancho novo", cta: "Chamar no WhatsApp" } }),
        v,
      ],
    );
    const last = (await events(planId, 3)).at(-1);
    assert.equal(last.kind, "edited");
    assert.equal(last.via, "team");
    assert.deepEqual(last.detail, {
      before: { hook: "Gancho 3", cta: "Seguir" },
      after: { hook: "Gancho novo", cta: "Chamar no WhatsApp" },
      reason: "Post 3 editado",
      reset: true,
    });
    // Only the edited post got an event (the others didn't change).
    await db.exec("reset role");
    assert.equal(
      (
        await one(
          "select count(*)::int as n from social_leads_post_events where plan_id=$1 and kind='edited'",
          [planId],
        )
      ).n,
      1,
    );
  },
);

await check(
  "trocar o anúncio registra os dois posts, sem registros falsos",
  async () => {
    await as(lorena);
    const v = (
      await one("select version from social_leads_plans where id=$1", [planId])
    ).version;
    await db.query(
      "select public.social_leads_write_plan($1,$2,$3,$4,'ajuste pedido à IA',$5,'ai','Post 5 vira o anúncio')",
      [
        A,
        contract,
        planId,
        plan({
          3: { gancho: "Gancho novo", cta: "Chamar no WhatsApp" },
          4: { ehAnuncio: false },
          5: { ehAnuncio: true },
        }),
        v,
      ],
    );
    const four = (await events(planId, 4)).at(-1);
    const five = (await events(planId, 5)).at(-1);
    assert.deepEqual(
      [four.kind, four.via, four.detail.before, four.detail.after],
      ["edited", "ai", { is_ad: true }, { is_ad: false }],
    );
    assert.equal(four.detail.summary, "Post 5 vira o anúncio");
    assert.deepEqual(
      [five.detail.before, five.detail.after],
      [{ is_ad: false }, { is_ad: true }],
    );
    // An edit elsewhere doesn't touch the ad's history.
    const v2 = (
      await one("select version from social_leads_plans where id=$1", [planId])
    ).version;
    const before = (await events(planId, 5)).length;
    await as(lorena);
    await db.query(
      "select public.social_leads_write_plan($1,$2,$3,$4,'Post 1 editado',$5,'manual')",
      [
        A,
        contract,
        planId,
        plan({
          1: { gancho: "Outro" },
          3: { gancho: "Gancho novo", cta: "Chamar no WhatsApp" },
          4: { ehAnuncio: false },
          5: { ehAnuncio: true },
        }),
        v2,
      ],
    );
    assert.equal((await events(planId, 5)).length, before);
  },
);

await check("artes enviadas e retiradas entram no histórico", async () => {
  await as(lorena);
  await db.query("select public.social_leads_set_arts($1,6,$2)", [
    planId,
    [{ id: art1 }],
  ]);
  await db.query("select public.social_leads_set_arts($1,6,'[]')", [planId]);
  const [added, removed] = (await events(planId, 6)).slice(-2);
  assert.deepEqual(
    [added.kind, added.actor_name, added.detail.added.map((a) => a.name)],
    ["arts", "Lorena Amaral", ["post1-feed.png"]],
  );
  assert.deepEqual(removed.detail, { added: [], removed: ["post1-feed.png"] });
});

await check("comentários: quem vê o cliente comenta", async () => {
  await as(outsider);
  await assert.rejects(
    db.query("select public.social_leads_comment($1,2,'oi')", [planId]),
    /Plano não encontrado/,
  );
  await as(lorena);
  await assert.rejects(
    db.query("select public.social_leads_comment($1,2,'  ')", [planId]),
    /Escreva o comentário/,
  );
  await assert.rejects(
    db.query("select public.social_leads_comment($1,9,'oi')", [planId]),
    /Post não encontrado/,
  );
  await db.query(
    "select public.social_leads_comment($1,2,' Falei com o cliente: prefere vídeo. ')",
    [planId],
  );
  const last = (await events(planId, 2)).at(-1);
  assert.deepEqual(
    [last.kind, last.actor_name, last.note],
    ["comment", "Lorena Amaral", "Falei com o cliente: prefere vídeo."],
  );
  await db.exec("reset role");
  const msg = await one(
    "select payload from realtime.messages where event='change' order by id desc limit 1",
  );
  assert.equal(msg.payload.table, "social_leads_post_events");
});

await check(
  "o histórico é lido por quem vê o cliente, e ninguém grava direto",
  async () => {
    await as(lorena);
    assert.ok(
      (
        await db.query(
          "select 1 from social_leads_post_events where plan_id=$1",
          [planId],
        )
      ).rows.length > 0,
    );
    await assert.rejects(
      db.query(
        "insert into social_leads_post_events(company_id,contract_id,plan_id,number,kind,via) values($1,$2,$3,1,'comment','team')",
        [A, contract, planId],
      ),
      /permission denied/,
    );
    await as(outsider);
    assert.equal(
      (await db.query("select 1 from social_leads_post_events")).rows.length,
      0,
    );
  },
);

console.log(`\n${passed} verificações do histórico dos posts passaram.`);
