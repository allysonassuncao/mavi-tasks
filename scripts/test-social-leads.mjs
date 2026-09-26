// Onboarding › Social Leads (migration 20261013090000_social_leads): carteira
// pelo produto contratado, briefing com versão, plano com 4 pilares/8 posts/1
// anúncio, versões antes de toda escrita, trava do plano aprovado, link do
// cliente sem dados internos, gerações uma por vez e avisos ao vivo.
import assert from "node:assert/strict";
import { createTestDatabase } from "./database-fixture.mjs";

const db = await createTestDatabase();
const uid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const [A, B, admin, manager, lorena, outsider, other] = [
  1, 2, 10, 11, 12, 13, 14,
].map(uid);
const [product, otherProduct, squad, client, client2, contract, contract2] = [
  20, 21, 22, 23, 24, 25, 26,
].map(uid);
await db.query(`insert into auth.users select unnest($1::uuid[])`, [
  [admin, manager, lorena, outsider, other],
]);
await db.query(
  `insert into companies(id,name) values($1,'Make'),($2,'Outra')`,
  [A, B],
);
await db.query(
  `insert into memberships(company_id,user_id,name,role) values
   ($1,$3,'Ana Admin','admin'),($1,$4,'Gabi Gestora','manager'),
   ($1,$5,'Lorena Amaral','member'),($1,$6,'Caio Fora','member'),($2,$7,'Outra','admin')`,
  [A, B, admin, manager, lorena, outsider, other],
);
await db.exec(
  `insert into products(company_id,id,name) values($1,$2,'Social Leads'),($1,$3,'Make Ads');
   insert into teams(company_id,id,name) values($1,$4,'Squad Social Leads');
   insert into team_members(company_id,team_id,user_id) values($1,$4,$5);
   insert into clients(company_id,id,name) values($1,$6,'Agente Stravitta'),($1,$7,'Ótica Clara');
   insert into client_teams(company_id,client_id,team_id) values($1,$6,$4);
   insert into contracts(company_id,id,client_id,product_id,name) values
    ($1,$8,$6,$2,'Social Leads · Stravitta'),($1,$9,$7,$2,'Social Leads · Ótica'),
    ($1,gen_random_uuid(),$6,$3,'Make Ads · Stravitta')`.replace(
    /\$(\d)/g,
    (_, i) =>
      `'${[A, product, otherProduct, squad, lorena, client, client2, contract, contract2][i - 1]}'`,
  ),
);

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

function plan(overrides = {}) {
  const posts = Array.from({ length: 8 }, (_, i) => ({
    numero: i + 1,
    badge: ["posicionar", "autoridade", "oferta"][i % 3],
    gancho: `Gancho ${i + 1}`,
    direcaoCopy: `Copy ${i + 1}`,
    direcaoVisual: `Visual ${i + 1}`,
    formato: "Imagem única",
    cta: "Seguir a página",
    ehAnuncio: i === 3,
  }));
  return {
    diagnostico: { negocio: "Rede de agentes", comoQuerSerVista: "Confiável" },
    swot: { forcas: "F", fraquezas: "Fr", oportunidades: "O", ameacas: "A" },
    pilares: [1, 2, 3, 4].map((n) => ({ titulo: `P${n}`, descricao: `D${n}` })),
    publico: "25 a 55 anos",
    campanha: {
      objetivo: "Cadastros",
      regiao: "Brasil",
      idadeGenero: "25–55",
      segmentacao: "Interesses",
      posicionamentos: "Advantage+",
      orcamento: "R$ 500/mês",
      perguntasFormulario: ["Nome", "WhatsApp"],
      roteamentoLead: "CRM",
    },
    alertas: ["Bloqueio: sem Instagram"],
    posts,
    ...overrides,
  };
}
const write = (who, planId, content, reason = "edição", version = null) =>
  as(who).then(() =>
    one("select public.social_leads_write_plan($1,$2,$3,$4,$5,$6,'ai') as r", [
      A,
      contract,
      planId,
      content,
      reason,
      version,
    ]).then((r) => r.r),
  );

await check("módulo Onboarding pode ser escondido por pessoa", async () => {
  await as(admin);
  await db.query("select public.set_member_pages($1,$2,$3)", [
    A,
    outsider,
    ["onboarding"],
  ]);
  await db.exec("reset role");
  assert.deepEqual(
    (
      await one("select hidden_pages from memberships where user_id=$1", [
        outsider,
      ])
    ).hidden_pages,
    ["onboarding"],
  );
});

await check(
  "sem configuração a carteira avisa; só líderes configuram",
  async () => {
    await as(lorena);
    const r = (await one("select public.social_leads_portfolio($1) as r", [A]))
      .r;
    assert.equal(r.configured, false);
    await assert.rejects(
      db.query("select public.set_social_leads_settings($1,$2,$3)", [
        A,
        product,
        squad,
      ]),
      /Somente administradores e gestores/,
    );
    await as(manager);
    await db.query("select public.set_social_leads_settings($1,$2,$3)", [
      A,
      product,
      squad,
    ]);
  },
);

await check(
  "a carteira segue a visibilidade do produto contratado",
  async () => {
    await as(admin);
    let r = (await one("select public.social_leads_portfolio($1) as r", [A])).r;
    assert.deepEqual(
      r.items.map((i) => i.client_name),
      ["Agente Stravitta", "Ótica Clara"],
    );
    assert.ok(r.items.every((i) => i.can_write));
    await as(lorena);
    r = (await one("select public.social_leads_portfolio($1) as r", [A])).r;
    assert.deepEqual(
      r.items.map((i) => i.contract_id),
      [contract],
    );
    assert.equal(r.items[0].can_write, true);
    await as(outsider);
    r = (await one("select public.social_leads_portfolio($1) as r", [A])).r;
    assert.deepEqual(r.items, []);
    await as(other);
    await assert.rejects(
      db.query("select public.social_leads_portfolio($1)", [A]),
      /Sem acesso/,
    );
  },
);

await check("briefing: campos conhecidos, versão e conflito", async () => {
  await as(outsider);
  await assert.rejects(
    db.query(
      "select public.save_social_leads_briefing($1,$2,$3,null,null,null)",
      [A, contract, {}],
    ),
    /Sem permissão/,
  );
  await as(lorena);
  await assert.rejects(
    db.query(
      "select public.save_social_leads_briefing($1,$2,$3,null,null,null)",
      [A, contract, { hacker: "x" }],
    ),
    /Campo desconhecido/,
  );
  const v1 = (
    await one(
      "select public.save_social_leads_briefing($1,$2,$3,'form_nativo',$4,null) as v",
      [
        A,
        contract,
        { clientName: "Agente Stravitta", igHandle: "@orenatolive", notes: "" },
        lorena,
      ],
    )
  ).v;
  assert.equal(v1, 1);
  const v2 = (
    await one(
      "select public.save_social_leads_briefing($1,$2,$3,'form_nativo',$4,1) as v",
      [
        A,
        contract,
        { clientName: "Agente Stravitta", segment: "Afiliados" },
        lorena,
      ],
    )
  ).v;
  assert.equal(v2, 2);
  await assert.rejects(
    db.query("select public.save_social_leads_briefing($1,$2,$3,null,null,1)", [
      A,
      contract,
      {},
    ]),
    /Outra pessoa salvou/,
  );
  const b = await one(
    "select fields from social_leads_briefings where contract_id=$1",
    [contract],
  );
  // Campos vazios não são guardados.
  assert.deepEqual(b.fields, {
    clientName: "Agente Stravitta",
    segment: "Afiliados",
  });
});

let planId;
await check("a estrutura do plano é conferida", async () => {
  const bad = [
    [{ pilares: plan().pilares.slice(0, 3) }, /exatamente 4 pilares/],
    [{ posts: plan().posts.slice(0, 7) }, /exatamente 8 posts/],
    [
      { posts: plan().posts.map((p) => ({ ...p, ehAnuncio: true })) },
      /exatamente um post que vira anúncio \(tem 8\)/,
    ],
    [{ posts: plan().posts.map((p) => ({ ...p, ehAnuncio: false })) }, /tem 0/],
    [
      {
        posts: plan().posts.map((p, i) =>
          i === 2 ? { ...p, badge: "venda" } : p,
        ),
      },
      /Pilar do post 3 inválido/,
    ],
    [
      {
        posts: plan().posts.map((p, i) => (i === 2 ? { ...p, numero: 2 } : p)),
      },
      /Post 2 repetido/,
    ],
    [
      {
        posts: plan().posts.map((p, i) =>
          i === 5 ? { ...p, gancho: "  " } : p,
        ),
      },
      /Gancho do post 6 está vazio/,
    ],
    [{ publico: "" }, /Público está vazio/],
  ];
  for (const [o, msg] of bad)
    await assert.rejects(write(lorena, null, plan(o)), msg);
  const r = await write(lorena, null, plan());
  planId = r.id;
  await db.exec("reset role");
  const p = await one(
    "select month_number,label,source from social_leads_plans where id=$1",
    [planId],
  );
  assert.deepEqual(p, { month_number: 1, label: "Mês 1", source: "ai" });
  const posts = await all(
    "select number,decision,is_ad from social_leads_posts where plan_id=$1 order by number",
    [planId],
  );
  assert.equal(posts.length, 8);
  assert.ok(posts.every((x) => x.decision === "pending"));
  assert.deepEqual(
    posts.filter((x) => x.is_ad).map((x) => x.number),
    [4],
  );
  // O mês seguinte ganha o próximo número.
  const r2 = await write(lorena, null, plan());
  await db.exec("reset role");
  assert.equal(
    (
      await one("select month_number from social_leads_plans where id=$1", [
        r2.id,
      ])
    ).month_number,
    2,
  );
  await db.query("delete from social_leads_plans where id=$1", [r2.id]);
});

await check("o token do link não é lido direto da tabela", async () => {
  await as(lorena);
  await assert.rejects(
    db.query("select share_token from social_leads_plans"),
    /permission denied/,
  );
  assert.equal((await all("select id from social_leads_plans")).length, 1);
  await as(outsider);
  assert.equal((await all("select id from social_leads_plans")).length, 0);
  assert.equal((await all("select * from social_leads_posts")).length, 0);
});

await check(
  "decisão da equipe e edição: só o post alterado volta a pendente",
  async () => {
    await as(lorena);
    await db.query(
      "select public.social_leads_decide($1,1,'approved','ótimo')",
      [planId],
    );
    await db.query(
      "select public.social_leads_decide($1,2,'rejected','trocar a foto')",
      [planId],
    );
    const v = (
      await one("select version from social_leads_plans where id=$1", [planId])
    ).version;
    const changed = plan();
    changed.posts[1].gancho = "Novo gancho do 2";
    await write(lorena, planId, changed, "importação da conversa no chat", v);
    const posts = await all(
      "select number,decision,note,decided_via from social_leads_posts where plan_id=$1 and number<=2 order by number",
      [planId],
    );
    assert.deepEqual(posts, [
      { number: 1, decision: "approved", note: "ótimo", decided_via: "team" },
      { number: 2, decision: "pending", note: "", decided_via: null },
    ]);
    const rev = await all(
      "select number,reason,content from social_leads_revisions where plan_id=$1",
      [planId],
    );
    assert.equal(rev.length, 1);
    assert.equal(rev[0].reason, "importação da conversa no chat");
    assert.equal(rev[0].content.posts[1].status, "reprovado");
    assert.equal(rev[0].content.posts[1].observacao, "trocar a foto");
    // Versão antiga: conflito.
    await assert.rejects(
      write(lorena, planId, plan(), "edição", v),
      /O plano mudou/,
    );
  },
);

await check(
  "regenerar zera as decisões e trava com o plano todo aprovado",
  async () => {
    await as(lorena);
    await write(lorena, planId, plan(), "regeneração do mês");
    await as(lorena);
    assert.equal(
      (
        await one(
          "select count(*)::int n from social_leads_posts where plan_id=$1 and decision='pending'",
          [planId],
        )
      ).n,
      8,
    );
    for (let n = 1; n <= 8; n++)
      await db.query("select public.social_leads_decide($1,$2,'approved','')", [
        planId,
        n,
      ]);
    await assert.rejects(
      write(lorena, planId, plan(), "regeneração do mês"),
      /Plano aprovado/,
    );
    await as(lorena);
    await assert.rejects(
      db.query("select public.social_leads_start_job($1,$2,$3,'current')", [
        A,
        contract,
        planId,
      ]),
      /Plano aprovado/,
    );
    // Reabrir um post destrava.
    await db.query("select public.social_leads_decide($1,8,'pending','')", [
      planId,
    ]);
  },
);

await check(
  "link do cliente: desligado, dados internos fora, decisão com origem",
  async () => {
    await as(lorena);
    const share = (
      await one("select public.social_leads_share($1,false,false) as s", [
        planId,
      ])
    ).s;
    await as(null);
    await assert.rejects(
      db.query("select public.social_leads_shared_plan($1)", [
        share.share_token,
      ]),
      /Link inválido ou desativado/,
    );
    await as(lorena);
    const on = (
      await one("select public.social_leads_share($1,true,false) as s", [
        planId,
      ])
    ).s;
    assert.equal(on.share_enabled, true);
    assert.ok(on.shared_at);
    await as(null);
    const view = (
      await one("select public.social_leads_shared_plan($1) as v", [
        on.share_token,
      ])
    ).v;
    assert.equal(view.client, "Agente Stravitta");
    assert.equal(view.responsible, "Lorena Amaral");
    assert.equal(view.posts.length, 8);
    const text = JSON.stringify(view);
    for (const hidden of [
      "alertas",
      "orcamento",
      "posicionamentos",
      "perguntasFormulario",
      "roteamentoLead",
      "swot",
      "segmentacao",
      "Bloqueio",
    ])
      assert.ok(!text.includes(hidden), `o link não pode mostrar ${hidden}`);
    await assert.rejects(
      db.query(
        "select public.social_leads_client_decide($1,8,'rejected','  ')",
        [on.share_token],
      ),
      /Conte o que você quer ajustar/,
    );
    await db.query(
      "select public.social_leads_client_decide($1,8,'rejected','Trocar a cor')",
      [on.share_token],
    );
    await db.exec("reset role");
    assert.deepEqual(
      await one(
        "select decision,note,decided_via,decided_by from social_leads_posts where plan_id=$1 and number=8",
        [planId],
      ),
      {
        decision: "rejected",
        note: "Trocar a cor",
        decided_via: "link",
        decided_by: null,
      },
    );
    // Trocar o link invalida o anterior.
    await as(lorena);
    const renewed = (
      await one("select public.social_leads_share($1,true,true) as s", [planId])
    ).s;
    assert.notEqual(renewed.share_token, on.share_token);
    await as(null);
    await assert.rejects(
      db.query("select public.social_leads_client_decide($1,8,'approved','')", [
        on.share_token,
      ]),
      /Link inválido/,
    );
  },
);

await check(
  "restaurar uma versão arquiva a atual e volta as decisões",
  async () => {
    await as(lorena);
    const before = (
      await one(
        "select count(*)::int n from social_leads_revisions where plan_id=$1",
        [planId],
      )
    ).n;
    const first = await one(
      "select id from social_leads_revisions where plan_id=$1 and number=1",
      [planId],
    );
    await db.query("select public.social_leads_restore($1,null)", [first.id]);
    assert.equal(
      (
        await one(
          "select count(*)::int n from social_leads_revisions where plan_id=$1",
          [planId],
        )
      ).n,
      before + 1,
    );
    const posts = await all(
      "select number,decision,hook from social_leads_posts where plan_id=$1 and number<=2 order by number",
      [planId],
    );
    assert.deepEqual(posts, [
      { number: 1, decision: "approved", hook: "Gancho 1" },
      { number: 2, decision: "rejected", hook: "Gancho 2" },
    ]);
  },
);

await check("uma geração por vez; quem abriu fecha", async () => {
  await as(lorena);
  const ctx = (
    await one("select public.social_leads_start_job($1,$2,null,'new') as r", [
      A,
      contract,
    ])
  ).r;
  assert.equal(ctx.client_name, "Agente Stravitta");
  assert.equal(ctx.next_month, 2);
  assert.equal(ctx.briefing.segment, "Afiliados");
  assert.equal(ctx.previous.posts.length, 8);
  await assert.rejects(
    db.query("select public.social_leads_start_job($1,$2,null,'new')", [
      A,
      contract,
    ]),
    /Já existe uma geração em andamento/,
  );
  await as(admin);
  await assert.rejects(
    db.query("select public.social_leads_finish_job($1,null,null)", [ctx.job]),
    /Geração não encontrada/,
  );
  await as(lorena);
  await db.query("select public.social_leads_finish_job($1,null,'Falhou')", [
    ctx.job,
  ]);
  const j = await one(
    "select status,error from social_leads_jobs where id=$1",
    [ctx.job],
  );
  assert.deepEqual(j, { status: "failed", error: "Falhou" });
  // Sem briefing não gera.
  await as(admin);
  await assert.rejects(
    db.query("select public.social_leads_start_job($1,$2,null,'new')", [
      A,
      contract2,
    ]),
    /Preencha o briefing/,
  );
});

await check(
  "importação do artefato mantém as decisões e não duplica",
  async () => {
    await db.exec("reset role");
    const content = plan();
    content.label = "Mês 1";
    content.posts[0].status = "aprovado";
    content.posts[2].status = "reprovado";
    content.posts[2].observacao = "Não gostei";
    const args = [
      A,
      contract2,
      admin,
      { clientName: "Ótica Clara" },
      "ctwa",
      lorena,
      content,
      "2026-09-16T22:00:00Z",
    ];
    const id = (
      await one(
        "select mavi_private.social_leads_import($1,$2,$3,$4,$5,$6,$7,$8) as id",
        args,
      )
    ).id;
    const again = (
      await one(
        "select mavi_private.social_leads_import($1,$2,$3,$4,$5,$6,$7,$8) as id",
        args,
      )
    ).id;
    assert.equal(id, again);
    const p = await one(
      "select month_number,source,created_at from social_leads_plans where id=$1",
      [id],
    );
    assert.equal(p.source, "artifact");
    assert.equal(
      new Date(p.created_at).toISOString(),
      "2026-09-16T22:00:00.000Z",
    );
    const posts = await all(
      "select number,decision,note from social_leads_posts where plan_id=$1 and number in (1,2,3) order by number",
      [id],
    );
    assert.deepEqual(posts, [
      { number: 1, decision: "approved", note: "" },
      { number: 2, decision: "pending", note: "" },
      { number: 3, decision: "rejected", note: "Não gostei" },
    ]);
    // Só o script de importação, no SQL Editor, chega a ela.
    await as(lorena);
    await assert.rejects(
      db.query(
        "select mavi_private.social_leads_import($1,$2,$3,$4,$5,$6,$7,$8)",
        args,
      ),
      /permission denied/,
    );
  },
);

await check(
  "o ajuste pela IA recebe o plano só de quem pode gravar",
  async () => {
    await as(lorena);
    const ctx = (
      await one("select public.social_leads_adjust_context($1,$2,$3) as r", [
        A,
        contract,
        planId,
      ])
    ).r;
    assert.equal(ctx.client_name, "Agente Stravitta");
    assert.equal(ctx.plan.posts.length, 8);
    assert.equal(ctx.plan.label, "Mês 1");
    await as(outsider);
    await assert.rejects(
      db.query("select public.social_leads_adjust_context($1,$2,$3)", [
        A,
        contract,
        planId,
      ]),
      /Sem permissão/,
    );
  },
);

await check(
  "mudanças são avisadas no tópico da empresa, só com ids",
  async () => {
    await db.exec("reset role");
    const msgs = await all(
      "select topic,payload from realtime.messages where payload->>'kind'='social_leads' order by id",
    );
    assert.ok(msgs.length > 0);
    assert.ok(msgs.every((m) => m.topic === `mavi:company:${A}`));
    assert.ok(msgs.some((m) => m.payload.table === "social_leads_posts"));
    assert.ok(
      msgs.every(
        (m) => Object.keys(m.payload).sort().join() === "contract,kind,table",
      ),
    );
  },
);

console.log(`\n${passed} verificações do Social Leads passaram.`);
