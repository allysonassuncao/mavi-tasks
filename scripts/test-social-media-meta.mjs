// Planejamento › Social Media › Agendamento, fase 2 (migration
// 20270316090000_social_media_meta): conexão do Meta só do Social Media (pela
// agência, só líderes, ou pelo link do cliente), tokens fora do alcance da
// tela, fila de publicação acordando o worker, fim com sucesso ou de volta ao
// lembrete (e a conexão marcada quando o token cai).
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
  for (const n of [1, 2, 4])
    await db.query(
      `insert into drive_files(id, company_id, name, content_type, size_bytes, path, status, uploaded_by)
       values ($1, $2, $3, $4, 10, $5, 'ready', $6) on conflict do nothing`,
      [
        uid(900 + n),
        A,
        `arte${n}`,
        n === 2 ? "video/mp4" : "image/png",
        `${A}/drive/arte${n}-${id}`,
        admin,
      ],
    );
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
const SECRET = "s".repeat(40);
await db.exec(
  `insert into mavi_private.ai_config(url, secret) values ('https://app.test/api/ai', '${SECRET}')`,
);
const cipher = (n) => `v1:token-${n}`;

await check(
  "pela agência: só líderes começam; o login guarda as Páginas sem expor o token",
  async () => {
    await as(sofia);
    await assert.rejects(
      db.query("select public.social_media_begin_connect($1)", [mediaContract]),
      /só administradores e gestores/,
    );
    await as(admin);
    await assert.rejects(
      db.query("select public.social_media_begin_connect($1)", [leadsContract]),
      /é do Social Media/,
    );
    const state = (
      await one("select public.social_media_begin_connect($1) as s", [
        mediaContract,
      ])
    ).s;
    await as(null);
    const stored = (
      await one(
        "select public.social_media_store_pending($1,'Ana no Facebook',$2) as r",
        [
          state,
          JSON.stringify([
            {
              id: "111",
              name: "Forma Página",
              ig_id: "999",
              ig_username: "forma",
              token_cipher: cipher(1),
            },
            {
              id: "222",
              name: "Outra",
              ig_id: null,
              ig_username: null,
              token_cipher: cipher(2),
            },
          ]),
        ],
      )
    ).r;
    assert.equal(stored.via, "agency");
    assert.equal(stored.pages, 2);
    // O estado só vale uma vez.
    await assert.rejects(
      db.query("select public.social_media_store_pending($1,'x','[]')", [
        state,
      ]),
      /expirou/,
    );
    await as(sofia);
    await assert.rejects(
      db.query("select public.social_media_pending_pages($1)", [
        stored.pending,
      ]),
      /expirou/,
    );
    await as(admin);
    const pages = (
      await one("select public.social_media_pending_pages($1) as r", [
        stored.pending,
      ])
    ).r;
    assert.equal(JSON.stringify(pages).includes("v1:"), false);
    assert.deepEqual(
      pages.pages.map((p) => p.name),
      ["Forma Página", "Outra"],
    );
    await assert.rejects(
      db.query("select public.social_media_choose_page($1,'333')", [
        stored.pending,
      ]),
      /uma das Páginas/,
    );
    await db.query("select public.social_media_choose_page($1,'111')", [
      stored.pending,
    ]);
    await as(sofia);
    const acc = await one(
      "select page_id, page_name, ig_user_id, ig_username, connected_via, connected_name from social_media_accounts where contract_id=$1",
      [mediaContract],
    );
    assert.deepEqual(acc, {
      page_id: "111",
      page_name: "Forma Página",
      ig_user_id: "999",
      ig_username: "forma",
      connected_via: "agency",
      connected_name: "Ana no Facebook",
    });
    await assert.rejects(
      db.query("select * from mavi_private.sm_tokens"),
      /permission denied/,
    );
  },
);

await check(
  "pelo link: o cliente entra e escolhe a Página, sem login no MAVI",
  async () => {
    await as(outsider);
    await assert.rejects(
      db.query("select public.social_media_connect_link($1)", [mediaContract]),
      /Cliente não encontrado/,
    );
    await as(sofia);
    const token = (
      await one("select public.social_media_connect_link($1) as t", [
        mediaContract,
      ])
    ).t;
    assert.equal(
      (
        await one("select public.social_media_connect_link($1) as t", [
          mediaContract,
        ])
      ).t,
      token,
    );
    await as(null);
    const info = (
      await one("select public.social_media_link_info($1) as r", [token])
    ).r;
    assert.equal(info.client, "Cliente");
    assert.equal(info.page_name, "Forma Página");
    const state = (
      await one("select public.social_media_begin_link_connect($1) as s", [
        token,
      ])
    ).s;
    const stored = (
      await one(
        "select public.social_media_store_pending($1,'Dono da Forma',$2) as r",
        [
          state,
          JSON.stringify([
            {
              id: "444",
              name: "Forma Oficial",
              ig_id: "888",
              ig_username: "formaoficial",
              token_cipher: cipher(4),
            },
          ]),
        ],
      )
    ).r;
    assert.equal(stored.via, "client");
    assert.equal(stored.link, token);
    const pending = (
      await one("select public.social_media_link_pending($1,$2) as r", [
        token,
        stored.pending,
      ])
    ).r;
    assert.equal(pending.pages[0].ig_username, "formaoficial");
    await db.query("select public.social_media_link_choose($1,$2,'444')", [
      token,
      stored.pending,
    ]);
    await db.exec("reset role");
    const acc = await one(
      "select page_id, connected_via, connected_by from social_media_accounts where contract_id=$1",
      [mediaContract],
    );
    assert.deepEqual(acc, {
      page_id: "444",
      connected_via: "client",
      connected_by: null,
    });
    assert.equal(
      (
        await one(
          "select page_token_cipher from mavi_private.sm_tokens where contract_id=$1",
          [mediaContract],
        )
      ).page_token_cipher,
      cipher(4),
    );
    // Um link trocado para de funcionar.
    await as(sofia);
    await db.query("select public.social_media_connect_link($1,true)", [
      mediaContract,
    ]);
    await as(null);
    await assert.rejects(
      db.query("select public.social_media_link_info($1)", [token]),
      /Link inválido/,
    );
  },
);

await check(
  "na hora, conectado: fila do Meta e o worker acordado; ninguém mexe enquanto publica",
  async () => {
    await as(sofia);
    await save(mediaPlan, [
      {
        number: 1,
        at: local(2),
        destinations: ["instagram", "facebook"],
        first_comment: "#forma",
      },
      { number: 2, at: local(3), destinations: ["instagram", "story"] },
    ]);
    await db.exec("reset role");
    await db.query(
      "update social_media_schedules set scheduled_at = now() - interval '1 minute' where plan_id=$1",
      [mediaPlan],
    );
    await db.exec("delete from net.requests");
    assert.equal(
      (await one("select mavi_private.social_media_run_schedules() as n")).n,
      2,
    );
    const rows = (
      await db.query(
        "select number, status from social_media_schedules where plan_id=$1 order by number",
        [mediaPlan],
      )
    ).rows;
    assert.deepEqual(rows, [
      { number: 1, status: "publishing" },
      { number: 2, status: "publishing" },
    ]);
    const req = await one("select url, body, headers from net.requests");
    assert.equal(req.url, "https://app.test/api/social-media");
    assert.deepEqual(req.body, { action: "publish" });
    assert.equal(req.headers.Authorization, `Bearer ${SECRET}`);
    // Sem lembrete enquanto o Meta publica.
    assert.equal(
      (
        await one(
          "select count(*)::int as n from notifications where title like 'Hora de publicar%'",
        )
      ).n,
      0,
    );
    await as(sofia);
    await assert.rejects(
      save(mediaPlan, [
        { number: 1, at: local(5), destinations: ["instagram"] },
      ]),
      /sendo publicado/,
    );
    await assert.rejects(
      db.query("select public.social_media_schedule_cancel($1,1)", [mediaPlan]),
      /sendo publicado/,
    );
    await assert.rejects(
      db.query("select public.social_media_disconnect($1)", [mediaContract]),
      /sendo publicado/,
    );
  },
);

await check(
  "o worker: só com o segredo, reserva e recebe tudo para publicar",
  async () => {
    await as(null);
    await assert.rejects(
      db.query("select public.social_media_claim_publish('errado')"),
      /Sem permissão/,
    );
    const jobs = (
      await one("select public.social_media_claim_publish($1) as r", [SECRET])
    ).r;
    assert.equal(jobs.length, 2);
    const j = jobs.find((x) => x.number === 1);
    assert.equal(j.page_id, "444");
    assert.equal(j.ig_user_id, "888");
    assert.equal(j.token_cipher, cipher(4));
    assert.equal(j.caption, "Legenda 1");
    assert.equal(j.first_comment, "#forma");
    assert.deepEqual(
      j.arts.map((a) => [a.type, a.path.endsWith(`arte1-${mediaPlan}`)]),
      [["image/png", true]],
    );
    // Reservados: a próxima chamada não pega de novo.
    assert.equal(
      (await one("select public.social_media_claim_publish($1) as r", [SECRET]))
        .r.length,
      0,
    );
    // Vídeo processando: guarda o andamento e solta para a próxima rodada.
    await db.query("select public.social_media_publish_progress($1,$2,2,$3)", [
      SECRET,
      mediaPlan,
      JSON.stringify({ instagram: { container: "c1" } }),
    ]);
    // Não volta na mesma rodada; na do próximo minuto, sim.
    assert.equal(
      (await one("select public.social_media_claim_publish($1) as r", [SECRET]))
        .r.length,
      0,
    );
    await db.exec("reset role");
    await db.query(
      "update social_media_schedules set claimed_at = claimed_at - interval '61 seconds' where plan_id=$1 and number=2",
      [mediaPlan],
    );
    await as(null);
    const again = (
      await one("select public.social_media_claim_publish($1) as r", [SECRET])
    ).r;
    assert.deepEqual(
      again.map((x) => [x.number, x.state.instagram.container]),
      [[2, "c1"]],
    );
  },
);

await check(
  "fim: publicado pelo Meta com o link; ou de volta ao lembrete, e a conexão marcada",
  async () => {
    await as(null);
    await db.query(
      "select public.social_media_publish_done($1,$2,1,$3,true,'https://www.instagram.com/p/abc',null,false,'Sem permissão de comentar.')",
      [SECRET, mediaPlan, JSON.stringify({ instagram: { id: "m1" } })],
    );
    await db.query(
      "select public.social_media_publish_done($1,$2,2,'{}',false,null,'Stories: o token expirou.',true)",
      [SECRET, mediaPlan],
    );
    await db.exec("reset role");
    const rows = (
      await db.query(
        "select number, status, published_via, published_url, error from social_media_schedules where plan_id=$1 order by number",
        [mediaPlan],
      )
    ).rows;
    assert.deepEqual(rows, [
      {
        number: 1,
        status: "published",
        published_via: "meta",
        published_url: "https://www.instagram.com/p/abc",
        error: null,
      },
      {
        number: 2,
        status: "due",
        published_via: null,
        published_url: null,
        error: "Stories: o token expirou.",
      },
    ]);
    const ev = await one(
      "select actor_name, detail from social_leads_post_events where plan_id=$1 and number=1 and kind='published'",
      [mediaPlan],
    );
    assert.deepEqual(ev, {
      actor_name: "Meta",
      detail: { url: "https://www.instagram.com/p/abc", via: "meta" },
    });
    const titles = (
      await db.query(
        "select distinct title from notifications where title ilike '%post%' order by title",
      )
    ).rows.map((r) => r.title);
    assert.deepEqual(titles, [
      "Não deu para publicar o post 2 de Cliente pelo Meta",
      "Post 1 de Cliente publicado, sem o primeiro comentário",
    ]);
    assert.match(
      (
        await one(
          "select connection_error from social_media_accounts where contract_id=$1",
          [mediaContract],
        )
      ).connection_error,
      /token expirou/,
    );
    // Com a conexão com erro, a próxima hora marcada vira lembrete.
    await as(sofia);
    await save(mediaPlan, [
      { number: 4, at: local(2), destinations: ["facebook"] },
    ]);
    await db.exec("reset role");
    await db.query(
      "update social_media_schedules set scheduled_at = now() - interval '1 minute' where plan_id=$1 and number=4",
      [mediaPlan],
    );
    await db.query("select mavi_private.social_media_run_schedules()");
    assert.equal(
      (
        await one(
          "select status from social_media_schedules where plan_id=$1 and number=4",
          [mediaPlan],
        )
      ).status,
      "due",
    );
    // O Meta publicou: desfazer não vale.
    await as(sofia);
    await assert.rejects(
      db.query("select public.social_media_schedule_published($1,1,false)", [
        mediaPlan,
      ]),
      /apague o post na rede/,
    );
  },
);

await check("desconectar tira o token e os dados da Página", async () => {
  await as(sofia);
  await db.query("select public.social_media_disconnect($1)", [mediaContract]);
  await db.exec("reset role");
  assert.equal(
    (await one("select count(*)::int as n from mavi_private.sm_tokens")).n,
    0,
  );
  assert.deepEqual(
    await one(
      "select page_id, connection_error from social_media_accounts where contract_id=$1",
      [mediaContract],
    ),
    { page_id: null, connection_error: null },
  );
});

console.log(`\n${passed} checks passed`);
