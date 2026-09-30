// Social Leads, nova leva (migration 20261121090000_social_leads_onboarding_v2):
// planos de 8 a 16 posts, textos exatos dos posts (histórico, link, tarefa),
// alertas marcados como lidos, clientes adicionados por quem não é líder e a
// pasta da prova social com envio pelo link público.
import assert from "node:assert/strict";
import { createTestDatabase } from "./database-fixture.mjs";
const SECRET = "s".repeat(40);

const db = await createTestDatabase();
const uid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const [A, admin, lorena, outsider, designer] = [1, 10, 12, 13, 14].map(uid);
const [product, squad, other, design, client, contract, loose] = [
  20, 22, 26, 23, 24, 25, 27,
].map(uid);
await db.query("insert into auth.users select unnest($1::uuid[])", [
  [admin, lorena, outsider, designer],
]);
await db.exec(`insert into companies(id,name) values('${A}','Make');
insert into memberships(company_id,user_id,name,role) values('${A}','${admin}','Ana Admin','admin'),
 ('${A}','${lorena}','Lorena Amaral','member'),('${A}','${outsider}','Caio Fora','member'),
 ('${A}','${designer}','Davi Designer','member');
insert into products(company_id,id,name) values('${A}','${product}','Social Leads');
insert into teams(company_id,id,name) values('${A}','${squad}','Squad'),('${A}','${other}','Outra'),
 ('${A}','${design}','Criação');
insert into team_members(company_id,team_id,user_id) values('${A}','${squad}','${lorena}'),
 ('${A}','${other}','${outsider}'),('${A}','${design}','${designer}');
insert into clients(company_id,id,name) values('${A}','${client}','Agente Stravitta'),('${A}','${loose}','Cliente Solto');
insert into client_teams(company_id,client_id,team_id) values('${A}','${client}','${squad}');
insert into contracts(company_id,id,client_id,product_id,name) values('${A}','${contract}','${client}','${product}','Social Leads · Stravitta');
insert into social_leads_settings(company_id,product_id,team_id,design_team_id) values('${A}','${product}','${squad}','${design}');`);

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
const plan = (count = 12, extra = {}) => ({
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
  alertas: ["Sem depoimentos reais: capte autorizações.", "Vertical sensível."],
  posts: Array.from({ length: count }, (_, i) => ({
    numero: i + 1,
    badge: "posicionar",
    gancho: `Gancho ${i + 1}`,
    direcaoCopy: "Copy",
    direcaoVisual: "Visual",
    formato: i % 2 ? "Reels" : "Carrossel",
    cta: "Seguir",
    textoImagem: i % 2 ? "" : `Card 1: Olá ${i + 1}\nCard 2: Fim`,
    textoVideo: i % 2 ? `Cena 1: fala ${i + 1}` : "",
    legenda: `Legenda do post ${i + 1} #marca`,
    ehAnuncio: i === 3,
    ...extra,
  })),
});
const write = (planId, content, reason = "edição manual", version = null) =>
  one(
    "select public.social_leads_write_plan($1,$2,$3,$4,$5,$6,'manual') as r",
    [A, contract, planId, content, reason, version],
  ).then((x) => x.r);

let planId;
await check("plano de 8 a 16 posts, com os textos exatos", async () => {
  await as(lorena);
  await db.query(
    "select public.save_social_leads_briefing($1,$2,$3,'form_nativo',null,null)",
    [A, contract, { clientName: "Agente Stravitta" }],
  );
  await assert.rejects(write(null, plan(17)), /de 8 a 16 posts \(tem 17\)/);
  await assert.rejects(write(null, plan(7)), /de 8 a 16 posts \(tem 7\)/);
  const bad = plan(10);
  bad.posts[9].numero = 11;
  await assert.rejects(write(null, bad), /fora de 1 a 10: 11/);
  planId = (await write(null, plan(12))).id;
  const posts = await all(
    "select number, image_text, video_text, caption from social_leads_posts where plan_id=$1 order by number",
    [planId],
  );
  assert.equal(posts.length, 12);
  assert.equal(posts[0].image_text, "Card 1: Olá 1\nCard 2: Fim");
  assert.equal(posts[1].video_text, "Cena 1: fala 2");
  assert.equal(posts[11].caption, "Legenda do post 12 #marca");
  const r = await one("select public.social_leads_portfolio($1) as r", [A]);
  assert.equal(r.r.items[0].plan.posts, 12);
});

await check(
  "editar um texto volta o post para pendente e entra no histórico",
  async () => {
    await as(lorena);
    await db.query("select public.social_leads_decide($1,1,'approved','')", [
      planId,
    ]);
    const v = (
      await one("select version from social_leads_plans where id=$1", [planId])
    ).version;
    const next = plan(12);
    next.posts[0].legenda = 'mavi:richtext:v1:{"type":"doc","content":[]}';
    await write(planId, next, "edição manual", v);
    const p = await one(
      "select decision, caption from social_leads_posts where plan_id=$1 and number=1",
      [planId],
    );
    assert.equal(p.decision, "pending");
    const e = await one(
      "select detail from social_leads_post_events where plan_id=$1 and number=1 and kind='edited' order by created_at desc, seq desc limit 1",
      [planId],
    );
    assert.equal(e.detail.before.caption, "Legenda do post 1 #marca");
    // Fora da regeneração, a quantidade de posts não muda.
    await assert.rejects(
      write(planId, plan(10), "edição manual", v + 1),
      /só muda ao regenerar/,
    );
  },
);

await check("regenerar com menos posts tira os que sobram", async () => {
  await as(lorena);
  await write(planId, plan(9), "regeneração do mês");
  const n = await one(
    "select count(*)::int as n, max(number) as m from social_leads_posts where plan_id=$1",
    [planId],
  );
  assert.deepEqual([n.n, n.m], [9, 9]);
});

await check(
  "plano aprovado é todos os posts aprovados (etapa e regeneração)",
  async () => {
    await as(lorena);
    for (let i = 1; i <= 8; i++)
      await db.query("select public.social_leads_decide($1,$2,'approved','')", [
        planId,
        i,
      ]);
    await db.exec("reset role");
    let stage = await one(
      "select mavi_private.social_leads_stage($1,$2) as s",
      [A, contract],
    );
    assert.equal(stage.s, "approval");
    await as(lorena);
    await db.query("select public.social_leads_decide($1,9,'approved','')", [
      planId,
    ]);
    await db.exec("reset role");
    stage = await one("select mavi_private.social_leads_stage($1,$2) as s", [
      A,
      contract,
    ]);
    assert.equal(stage.s, "production");
    await as(lorena);
    await assert.rejects(
      write(planId, plan(9), "regeneração do mês"),
      /todos os posts foram aprovados/,
    );
    await assert.rejects(
      db.query("select public.social_leads_start_job($1,$2,$3,'current')", [
        A,
        contract,
        planId,
      ]),
      /todos os posts foram aprovados/,
    );
  },
);

await check("a geração recebe a quantidade de posts escolhida", async () => {
  await as(lorena);
  await assert.rejects(
    db.query("select public.social_leads_start_job($1,$2,null,'new',17)", [
      A,
      contract,
    ]),
    /de 8 a 16/,
  );
  const ctx = (
    await one(
      "select public.social_leads_start_job($1,$2,null,'new',14) as r",
      [A, contract],
    )
  ).r;
  assert.equal(ctx.post_count, 14);
  await db.query("select public.social_leads_finish_job($1,null,'teste')", [
    ctx.job,
  ]);
  // Sem escolher: a quantidade do plano anterior.
  const again = (
    await one("select public.social_leads_start_job($1,$2,null,'new') as r", [
      A,
      contract,
    ])
  ).r;
  assert.equal(again.post_count, 9);
  await db.query("select public.social_leads_finish_job($1,null,'teste')", [
    again.job,
  ]);
});

await check(
  "o link do cliente e a tarefa de arte levam os textos",
  async () => {
    await as(lorena);
    const shared = (
      await one("select public.social_leads_share($1,true) as r", [planId])
    ).r;
    await as(null);
    const link = (
      await one("select public.social_leads_shared_plan($1) as r", [
        shared.share_token,
      ])
    ).r;
    assert.equal(link.posts[0].textoImagem, "Card 1: Olá 1\nCard 2: Fim");
    assert.equal(link.posts[1].textoVideo, "Cena 1: fala 2");
    await as(lorena);
    await db.query("select public.social_leads_release($1,'{}')", [planId]);
    const t = await one(
      "select t.id, t.description from tasks t join social_leads_posts x on x.task_id=t.id where x.plan_id=$1 and x.number=1",
      [planId],
    );
    assert.match(t.description, /Texto exato da\(s\) imagem\(ns\)/);
    assert.match(t.description, /Card 2: Fim/);
    // Editar o texto depois atualiza a tarefa que ninguém mexeu.
    await db.exec("reset role");
    await db.query(
      "update social_leads_posts set image_text='Card 1: Novo' where plan_id=$1 and number=1",
      [planId],
    );
    const after = await one("select description from tasks where id=$1", [
      t.id,
    ]);
    assert.match(after.description, /Card 1: Novo/);
  },
);

await check("alertas marcados como lidos, por quem vê o cliente", async () => {
  await as(lorena);
  const text = "Sem depoimentos reais: capte autorizações.";
  let r = await one("select public.social_leads_portfolio($1) as r", [A]);
  assert.equal(r.r.items[0].plan.alerts_unread, 2);
  await db.query("select public.social_leads_mark_alert($1,$2,'alerta',true)", [
    planId,
    text,
  ]);
  await db.query("select public.social_leads_mark_alert($1,$2,'alerta',true)", [
    planId,
    text,
  ]);
  const rows = await all(
    "select alert_text, read_by from social_leads_alert_reads where plan_id=$1",
    [planId],
  );
  assert.deepEqual(rows, [{ alert_text: text, read_by: lorena }]);
  r = await one("select public.social_leads_portfolio($1) as r", [A]);
  assert.equal(r.r.items[0].plan.alerts_unread, 1);
  await as(outsider);
  await assert.rejects(
    db.query("select public.social_leads_mark_alert($1,$2,'alerta',true)", [
      planId,
      text,
    ]),
    /Plano não encontrado/,
  );
  assert.equal((await all("select * from social_leads_alert_reads")).length, 0);
  await as(lorena);
  await db.query(
    "select public.social_leads_mark_alert($1,$2,'alerta',false)",
    [planId, text],
  );
  assert.equal((await all("select * from social_leads_alert_reads")).length, 0);
});

await check("quem não é líder adiciona clientes já cadastrados", async () => {
  // Cliente novo não é mais cadastrado pelo Social Leads (migração 20261122090000).
  await as(lorena);
  await assert.rejects(
    db.query(
      "select public.social_leads_add_client($1,null,'Clínica Nova',null)",
      [A],
    ),
    /Clientes novos são cadastrados em Clientes/,
  );
  await assert.rejects(
    db.query("select public.social_leads_add_client($1,$2,null,null)", [
      A,
      client,
    ]),
    /já está no Social Leads/,
  );
  // Quem é do squad adiciona qualquer cliente (o squad passa a atendê-lo).
  const k = (
    await one("select public.social_leads_add_client($1,$2,null,null) as r", [
      A,
      loose,
    ])
  ).r;
  const r = await one("select public.social_leads_portfolio($1) as r", [A]);
  const item = r.r.items.find((i) => i.contract_id === k);
  assert.ok(item && item.can_write);
  assert.equal(item.contract_name, "Social Leads · Cliente Solto");
});

await check(
  "pasta da prova social: o cliente envia pelo link público",
  async () => {
    await as(outsider);
    await assert.rejects(
      db.query(
        "select public.social_leads_proof_folder($1,$2,null,'Prova social')",
        [A, contract],
      ),
      /Sem permissão/,
    );
    await as(lorena);
    const f = (
      await one(
        "select public.social_leads_proof_folder($1,$2,null,'Prova social · Stravitta') as r",
        [A, contract],
      )
    ).r;
    assert.equal(f.public_upload, true);
    assert.ok(/^[0-9a-f]{64}$/.test(f.share_token));
    const b = await one(
      "select proof_folder from social_leads_briefings where contract_id=$1",
      [contract],
    );
    assert.equal(b.proof_folder, f.id);
    await as(null);
    const view = (
      await one("select public.drive_public_folder($1) as r", [f.share_token])
    ).r;
    assert.equal(view.upload, true);
    assert.equal(view.social_proof, true);
    assert.deepEqual(view.upload_types, ["image", "video", "audio", "pdf"]);
    await assert.rejects(
      db.query(
        "select * from public.drive_public_upload($1,'planilha.xlsx',10,'application/vnd.ms-excel')",
        [f.share_token],
      ),
      /não é aceito nesta pasta/,
    );
    // Only the server (with its secret) finishes a send.
    await db.exec("reset role");
    await db.query(
      "insert into mavi_private.ai_config(url, secret) values('https://app.example/api/ai', $1) on conflict do nothing",
      [SECRET],
    );
    await as(null);
    const up = await one(
      "select * from public.drive_public_upload($1,'../depoimento.mp4',2000,'video/mp4')",
      [f.share_token],
    );
    assert.ok(up.path.endsWith(up.id));
    await assert.rejects(
      db.query("select public.drive_public_upload_done($1,$2,$3)", [
        "x".repeat(40),
        f.share_token,
        up.id,
      ]),
      /Sem permissão/,
    );
    await db.query("select public.drive_public_upload_done($1,$2,$3)", [
      SECRET,
      f.share_token,
      up.id,
    ]);
    await assert.rejects(
      db.query("select public.drive_public_upload_done($1,$2,$3)", [
        SECRET,
        f.share_token,
        up.id,
      ]),
      /Envio não encontrado/,
    );
    await db.exec("reset role");
    const file = await one(
      "select name, status, folder_id, contract_id, uploaded_by from drive_files where id=$1",
      [up.id],
    );
    assert.deepEqual(file, {
      name: ".._depoimento.mp4",
      status: "ready",
      folder_id: f.id,
      contract_id: contract,
      uploaded_by: lorena,
    });
    const audit = await one(
      "select actor_id from drive_audit where file_id=$1 and action='public_upload_completed'",
      [up.id],
    );
    assert.equal(audit.actor_id, null);
    // A geração vê os arquivos da pasta.
    await as(lorena);
    const ctx = (
      await one("select public.social_leads_start_job($1,$2,null,'new') as r", [
        A,
        contract,
      ])
    ).r;
    assert.deepEqual(ctx.media.socialProofFolder, [
      { name: ".._depoimento.mp4", type: "video/mp4" },
    ]);
    await db.query("select public.social_leads_finish_job($1,null,'teste')", [
      ctx.job,
    ]);
    // Desligar: o link antigo para de funcionar e o envio também.
    await db.query(
      "select public.social_leads_proof_folder($1,$2,$3,null,false)",
      [A, contract, f.id],
    );
    await as(null);
    assert.equal(
      (await one("select public.drive_public_folder($1) as r", [f.share_token]))
        .r,
      null,
    );
    await assert.rejects(
      db.query(
        "select * from public.drive_public_upload($1,'a.png',10,'image/png')",
        [f.share_token],
      ),
      /não recebe arquivos/,
    );
  },
);

await check(
  "compartilhamento do Drive: desligar o link desliga o envio",
  async () => {
    await as(lorena);
    const f = (
      await one(
        "select public.social_leads_proof_folder($1,$2,null,'Depoimentos') as r",
        [A, contract],
      )
    ).r;
    await db.query("select public.set_drive_folder_sharing($1,false,'{}')", [
      f.id,
    ]);
    await db.exec("reset role");
    const row = await one(
      "select visibility, public_upload from drive_folders where id=$1",
      [f.id],
    );
    assert.deepEqual(row, { visibility: "private", public_upload: false });
    await as(lorena);
    await assert.rejects(
      db.query("select public.set_drive_folder_upload($1,true)", [f.id]),
      /link público da pasta antes/,
    );
  },
);

console.log(`\n${passed} verificações da nova leva do Social Leads passaram.`);
