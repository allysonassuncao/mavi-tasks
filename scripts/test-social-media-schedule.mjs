// Planejamento › Social Media › Agendamento (migration
// 20270315090000_social_media_schedule): só posts aprovados com arte, data no
// fuso da empresa, na hora marcada o aviso para quem agendou, quem fez a arte
// e a equipe de criação do cliente; publicado à mão; calendário no link do
// cliente (liga/desliga); o Social Leads fica de fora.
import assert from "node:assert/strict";
import { createTestDatabase } from "./database-fixture.mjs";

const db = await createTestDatabase();
const uid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const [A, admin, sofia, designer, outsider, designer2] = [
  1, 10, 13, 14, 15, 16,
].map(uid);
const [leadsProduct, mediaProduct, mediaSquad, design, otherDesign] = [
  20, 21, 23, 24, 25,
].map(uid);
const [aurora, forma] = [30, 31].map(uid);
const [leadsContract, mediaContract] = [40, 41].map(uid);
await db.query("insert into auth.users select unnest($1::uuid[])", [
  [admin, sofia, designer, outsider, designer2],
]);
await db.exec(`insert into companies(id,name,timezone) values('${A}','Make','America/Sao_Paulo');
insert into memberships(company_id,user_id,name,role) values('${A}','${admin}','Ana Admin','admin'),
 ('${A}','${sofia}','Sofia Social','member'),('${A}','${designer}','Davi Designer','member'),
 ('${A}','${outsider}','Otto','member'),('${A}','${designer2}','Dani Designer','member');
insert into products(company_id,id,name) values('${A}','${leadsProduct}','Social Leads'),
 ('${A}','${mediaProduct}','Social Media');
insert into teams(company_id,id,name) values('${A}','${mediaSquad}','Squad Media'),('${A}','${design}','Criação'),
 ('${A}','${otherDesign}','Outra criação');
insert into team_members(company_id,team_id,user_id) values('${A}','${mediaSquad}','${sofia}'),
 ('${A}','${design}','${designer}'),('${A}','${otherDesign}','${designer2}');
insert into clients(company_id,id,name) values('${A}','${aurora}','Aurora'),('${A}','${forma}','Forma');
insert into client_teams(company_id,client_id,team_id) values('${A}','${aurora}','${mediaSquad}'),
 ('${A}','${forma}','${mediaSquad}'),('${A}','${forma}','${design}');
insert into contracts(company_id,id,client_id,product_id,name) values
 ('${A}','${leadsContract}','${aurora}','${leadsProduct}','Social Leads · Aurora'),
 ('${A}','${mediaContract}','${forma}','${mediaProduct}','Social Media · Forma');
insert into social_leads_settings(company_id,module,product_id,team_id,design_team_id) values
 ('${A}','social_leads','${leadsProduct}','${mediaSquad}',null),
 ('${A}','social_media','${mediaProduct}','${mediaSquad}','${design}');`);

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
const content = () => ({
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
    legenda: `Legenda ${i + 1}`,
  })),
});
/** A plan with posts 1–4 approved and released; 1, 2 and 4 with art. */
async function plan(contract) {
  await as(sofia);
  await db.query(
    "select public.save_social_leads_briefing($1,$2,$3,'ctwa',null,null)",
    [A, contract, { clientName: "Cliente" }],
  );
  const id = (
    await one(
      "select public.social_leads_write_plan($1,$2,null,$3,'x',null,'ai') as r",
      [A, contract, content()],
    )
  ).r.id;
  for (const n of [1, 2, 3, 4])
    await db.query("select public.social_leads_decide($1,$2,'approved','')", [
      id,
      n,
    ]);
  await db.query("select public.social_leads_release($1,$2)", [
    id,
    { 1: { user: designer } },
  ]);
  await db.exec("reset role");
  const art = (n, type = "image/png") => [
    { id: uid(900 + n), name: `arte${n}`, type, size: 10 },
  ];
  for (const [n, type] of [
    [1, "image/png"],
    [2, "video/mp4"],
    [4, "image/png"],
  ])
    await db.query(
      "update social_leads_posts set arts=$3 where plan_id=$1 and number=$2",
      [id, n, JSON.stringify(art(n, type))],
    );
  return id;
}
const local = (days, time = "10:00") => {
  const d = new Date(Date.now() + days * 86_400_000);
  const s = d.toLocaleDateString("en-CA", { timeZone: "America/Sao_Paulo" });
  return `${s}T${time}`;
};
const save = (planId, items) =>
  db.query("select public.social_media_schedule_save($1,$2) as n", [
    planId,
    JSON.stringify(items),
  ]);

const mediaPlan = await plan(mediaContract);
const leadsPlan = await plan(leadsContract);

await check(
  "só aprovados com arte, destinos válidos e data no futuro",
  async () => {
    await as(sofia);
    await assert.rejects(
      save(mediaPlan, [
        { number: 3, at: local(2), destinations: ["instagram"] },
      ]),
      /envie a arte antes de agendar/,
    );
    await assert.rejects(
      save(mediaPlan, [
        { number: 5, at: local(2), destinations: ["instagram"] },
      ]),
      /só posts aprovados/,
    );
    await assert.rejects(
      save(mediaPlan, [{ number: 1, at: local(2), destinations: ["tiktok"] }]),
      /escolha onde publicar/,
    );
    await assert.rejects(
      save(mediaPlan, [
        { number: 1, at: local(-1), destinations: ["instagram"] },
      ]),
      /no futuro/,
    );
    await assert.rejects(
      save(mediaPlan, [
        { number: 1, at: "amanhã", destinations: ["instagram"] },
      ]),
      /data e hora inválidas/,
    );
    await assert.rejects(
      save(mediaPlan, [
        {
          number: 2,
          at: local(2),
          destinations: ["instagram"],
          cover: { art: uid(5) },
        },
      ]),
      /capa do Reels inválida/,
    );
  },
);

await check(
  "o Social Leads não tem agendamento; quem não atende o cliente não agenda",
  async () => {
    await as(sofia);
    await assert.rejects(
      save(leadsPlan, [
        { number: 1, at: local(2), destinations: ["instagram"] },
      ]),
      /é do Social Media/,
    );
    await as(outsider);
    await assert.rejects(
      save(mediaPlan, [
        { number: 1, at: local(2), destinations: ["instagram"] },
      ]),
      /Plano não encontrado/,
    );
  },
);

await check(
  "agenda (inclusive o anúncio), no fuso da empresa, com histórico",
  async () => {
    await as(sofia);
    const r = await save(mediaPlan, [
      {
        number: 1,
        at: local(2, "18:30"),
        destinations: ["facebook", "instagram", "instagram"],
      },
      {
        number: 2,
        at: local(3),
        destinations: ["instagram", "story"],
        caption: "Só no agendamento",
        first_comment: "#marca",
        cover: { seconds: 2 },
      },
      { number: 4, at: local(4), destinations: ["instagram"] },
    ]);
    assert.equal(r.rows[0].n, 3);
    const s = await one(
      `select to_char(scheduled_at at time zone 'America/Sao_Paulo','HH24:MI') as hm, destinations, caption, status
     from social_media_schedules where plan_id=$1 and number=1`,
      [mediaPlan],
    );
    assert.deepEqual(s, {
      hm: "18:30",
      destinations: ["facebook", "instagram"],
      caption: null,
      status: "scheduled",
    });
    const ev = await one(
      "select kind, actor_name from social_leads_post_events where plan_id=$1 and number=1 and kind='scheduled'",
      [mediaPlan],
    );
    assert.deepEqual(ev, { kind: "scheduled", actor_name: "Sofia Social" });
    const p = (
      await one(
        "select public.social_leads_portfolio($1,'social_media') as r",
        [A],
      )
    ).r.items[0].plan;
    assert.equal(p.scheduled, 3);
    assert.equal(p.published, 0);
  },
);

await check(
  "a MAVI recebe os posts com arte e o que já está agendado",
  async () => {
    await as(sofia);
    const c = (
      await one("select public.social_media_schedule_context($1,$2,$3) as r", [
        A,
        mediaContract,
        mediaPlan,
      ])
    ).r;
    assert.equal(c.client_name, "Cliente");
    assert.equal(c.timezone, "America/Sao_Paulo");
    assert.deepEqual(
      c.posts.map((p) => [p.numero, p.video, p.ehAnuncio, !!p.agendado]),
      [
        [1, false, false, true],
        [2, true, false, true],
        [4, false, true, true],
      ],
    );
  },
);

await check(
  "na hora: aviso para quem agendou, quem fez a arte e a criação do cliente",
  async () => {
    await db.exec("reset role");
    await db.query(
      "update social_media_schedules set scheduled_at = now() - interval '1 minute' where plan_id=$1 and number=1",
      [mediaPlan],
    );
    // Post 4 deixou de estar aprovado: falha, com o motivo.
    await db.query(
      "update social_media_schedules set scheduled_at = now() - interval '1 minute' where plan_id=$1 and number=4",
      [mediaPlan],
    );
    await db.query(
      "update social_leads_posts set decision='pending', decided_at=null, decided_via=null, decided_by=null where plan_id=$1 and number=4",
      [mediaPlan],
    );
    const n = await one(
      "select mavi_private.social_media_run_schedules() as n",
    );
    assert.equal(n.n, 2);
    const rows = (
      await db.query(
        "select number, status, error is not null as err from social_media_schedules where plan_id=$1 order by number",
        [mediaPlan],
      )
    ).rows;
    assert.deepEqual(rows, [
      { number: 1, status: "due", err: false },
      { number: 2, status: "scheduled", err: false },
      { number: 4, status: "failed", err: true },
    ]);
    const notes = (
      await db.query(
        "select user_id, title, link from notifications where kind='social_leads' and title like '%post 1 %' order by user_id",
      )
    ).rows;
    // Sofia agendou, Davi fez a arte e é da Criação do cliente; Dani é de outra criação.
    assert.deepEqual(
      notes.map((r) => r.user_id),
      [sofia, designer].sort(),
    );
    assert.match(notes[0].title, /Hora de publicar o post 1 de Cliente/);
    assert.match(
      notes[0].link,
      /^\/planejamento\/social-media\?contrato=.+&mes=1&secao=agendamento&post=1$/,
    );
    // Rodar de novo não avisa de novo.
    assert.equal(
      (await one("select mavi_private.social_media_run_schedules() as n")).n,
      0,
    );
  },
);

await check("publicado à mão, com link; desfazer volta a esperar", async () => {
  await as(sofia);
  await assert.rejects(
    db.query(
      "select public.social_media_schedule_published($1,1,true,'http://x')",
      [mediaPlan],
    ),
    /https:\/\//,
  );
  await db.query(
    "select public.social_media_schedule_published($1,1,true,'https://instagram.com/p/abc')",
    [mediaPlan],
  );
  let s = await one(
    "select status, published_via, published_url from social_media_schedules where plan_id=$1 and number=1",
    [mediaPlan],
  );
  assert.deepEqual(s, {
    status: "published",
    published_via: "manual",
    published_url: "https://instagram.com/p/abc",
  });
  await assert.rejects(
    save(mediaPlan, [{ number: 1, at: local(5), destinations: ["instagram"] }]),
    /já foi publicado/,
  );
  await assert.rejects(
    db.query("select public.social_media_schedule_cancel($1,1)", [mediaPlan]),
    /já foi publicado/,
  );
  await db.query("select public.social_media_schedule_published($1,1,false)", [
    mediaPlan,
  ]);
  s = await one(
    "select status, published_url from social_media_schedules where plan_id=$1 and number=1",
    [mediaPlan],
  );
  assert.deepEqual(s, { status: "due", published_url: null });
  await db.query("select public.social_media_schedule_published($1,1,true)", [
    mediaPlan,
  ]);
});

await check(
  "falhou: agendar de novo com outra hora volta para a fila",
  async () => {
    await as(admin);
    await db.query("select public.social_leads_decide($1,4,'approved','')", [
      mediaPlan,
    ]);
    await save(mediaPlan, [
      { number: 4, at: local(6), destinations: ["instagram"] },
    ]);
    const s = await one(
      "select status, error from social_media_schedules where plan_id=$1 and number=4",
      [mediaPlan],
    );
    assert.deepEqual(s, { status: "scheduled", error: null });
    await db.query("select public.social_media_schedule_cancel($1,4)", [
      mediaPlan,
    ]);
    assert.equal(
      (
        await one(
          "select count(*)::int as n from social_media_schedules where plan_id=$1 and number=4",
          [mediaPlan],
        )
      ).n,
      0,
    );
  },
);

await check(
  "calendário no link: só leitura, liga/desliga por cliente, nunca no Social Leads",
  async () => {
    await as(sofia);
    await db.exec("reset role");
    await db.query(
      "update social_leads_plans set share_enabled=true where id in ($1,$2)",
      [mediaPlan, leadsPlan],
    );
    const tokens = Object.fromEntries(
      (
        await db.query("select id, share_token from social_leads_plans")
      ).rows.map((r) => [r.id, r.share_token]),
    );
    const token = async (id) => tokens[id];
    await as(null);
    const shared = (
      await one("select public.social_leads_shared_plan($1) as r", [
        await token(mediaPlan),
      ])
    ).r;
    assert.deepEqual(
      shared.calendar.map((c) => [c.numero, c.published, c.url]),
      [
        [1, true, null],
        [2, false, null],
      ],
    );
    const leads = (
      await one("select public.social_leads_shared_plan($1) as r", [
        await token(leadsPlan),
      ])
    ).r;
    assert.equal(leads.calendar, null);
    await as(outsider);
    await assert.rejects(
      db.query("select public.social_media_set_link_calendar($1,false)", [
        mediaContract,
      ]),
      /Cliente não encontrado/,
    );
    await as(sofia);
    await db.query("select public.social_media_set_link_calendar($1,false)", [
      mediaContract,
    ]);
    await as(null);
    const off = (
      await one("select public.social_leads_shared_plan($1) as r", [
        await token(mediaPlan),
      ])
    ).r;
    assert.equal(off.calendar, null);
  },
);

await check(
  "a sugestão de datas é uma funcionalidade em Quem usa qual modelo",
  async () => {
    await db.exec("reset role");
    await db.query(
      `insert into mavi_private.ai_routes(company_id, scope_type, feature, provider_id, model)
     select $1, 'feature', 'social_media_schedule', null, 'x' where false`,
      [A],
    );
    const c = await one(
      "select pg_get_constraintdef(oid) as d from pg_constraint where conname='ai_routes_feature_check'",
    );
    assert.match(c.d, /social_media_schedule/);
  },
);

console.log(`\n${passed} checks passed`);
