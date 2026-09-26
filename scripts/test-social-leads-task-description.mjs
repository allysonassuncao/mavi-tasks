// Social Leads (migration 20261018120000_social_leads_task_description): a
// descrição das tarefas de arte em texto formatado, que o editor do app aceita
// sem perder nada, e as tarefas já criadas convertidas se ninguém as editou.
// Rode com --experimental-strip-types (lê src/rich-text.ts).
import assert from "node:assert/strict";
import { applyMigration, createTestDatabase } from "./database-fixture.mjs";
import { parseDescription, richTextPlain } from "../src/rich-text.ts";

const db = await createTestDatabase({ until: "20261018120000" });
const uid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const [A, admin, lorena, designer] = [1, 10, 12, 14].map(uid);
const [product, squad, design, client, contract] = [20, 22, 23, 24, 25].map(
  uid,
);
await db.query("insert into auth.users select unnest($1::uuid[])", [
  [admin, lorena, designer],
]);
await db.exec(`insert into companies(id,name) values('${A}','Make');
insert into memberships(company_id,user_id,name,role) values('${A}','${admin}','Ana Admin','admin'),
 ('${A}','${lorena}','Lorena Amaral','member'),('${A}','${designer}','Davi Designer','member');
insert into products(company_id,id,name) values('${A}','${product}','Social Leads');
insert into teams(company_id,id,name) values('${A}','${squad}','Squad'),('${A}','${design}','Criação');
insert into team_members(company_id,team_id,user_id) values('${A}','${squad}','${lorena}'),('${A}','${design}','${designer}');
insert into clients(company_id,id,name) values('${A}','${client}','Agente Stravitta');
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
    direcaoCopy: i === 1 ? "Abra com a dor.\n\nFeche com a prova." : "Copy",
    direcaoVisual: "Visual",
    formato: "Carrossel",
    cta: "Chamar no WhatsApp",
    ehAnuncio: i === 1,
  })),
});
const descriptions = () =>
  db
    .query(
      `select x.number, t.description from social_leads_posts x join tasks t on t.id = x.task_id
       where x.plan_id = $1 order by x.number`,
      [planId],
    )
    .then((r) => r.rows);

let planId;
await as(lorena);
await db.query(
  "select public.save_social_leads_briefing($1,$2,$3,'ctwa',$4,null)",
  [A, contract, { clientName: "Agente Stravitta" }, lorena],
);
planId = (
  await one(
    "select public.social_leads_write_plan($1,$2,null,$3,'x',null,'ai') as r",
    [A, contract, plan()],
  )
).r.id;
for (const n of [1, 2, 3])
  await db.query("select public.social_leads_decide($1,$2,'approved','')", [
    planId,
    n,
  ]);
await db.query("select public.social_leads_release($1,'{}')", [planId]);

await check(
  "tarefas já criadas passam para o texto formatado, menos as editadas",
  async () => {
    await db.exec("reset role");
    const before = await descriptions();
    assert.match(before[0].description, /^Gancho: Gancho 1\n/);
    await db.query(
      "update tasks set description = 'Texto que alguém escreveu' where id = (select task_id from social_leads_posts where plan_id = $1 and number = 3)",
      [planId],
    );
    await applyMigration(db, "20261018120000");
    const after = await descriptions();
    assert.ok(after[0].description.startsWith("mavi:richtext:v1:"));
    assert.ok(after[1].description.startsWith("mavi:richtext:v1:"));
    assert.equal(after[2].description, "Texto que alguém escreveu");
  },
);

await check(
  "o editor aceita a descrição sem perder nada, na ordem certa",
  async () => {
    const [first, ad] = await descriptions();
    for (const d of [first, ad]) {
      const raw = JSON.parse(d.description.slice("mavi:richtext:v1:".length));
      // The app's sanitizer keeps every node and mark.
      assert.deepEqual(parseDescription(d.description), raw);
    }
    const text = richTextPlain(ad.description).split("\n");
    assert.deepEqual(text, [
      "Este post também vira o anúncio do mês.",
      "GanchoGancho 2",
      "Direção de copyAbra com a dor.Feche com a prova.",
      "Direção visualVisual",
      "Formato: CarrosselChamada (CTA): Chamar no WhatsApp",
      "Como entregar",
      "Clique em “Abrir o post no plano”, logo abaixo desta descrição.No post, use “Enviar as artes” (imagem, vídeo ou PDF). Elas vão para o Drive do cliente e aparecem no link de aprovação.Só conclua esta tarefa depois que as artes estiverem no post.",
      "Onde fica: Onboarding › Social Leads › Mês 1 › Post 2",
    ]);
    const doc = parseDescription(ad.description);
    // Ad banner in bold + highlight.
    assert.deepEqual(doc.content[0].content[0].marks, [
      { type: "bold" },
      { type: "highlight" },
    ]);
    assert.deepEqual(
      doc.content[2].content.map((n) => n.type),
      // The blank line of the copy stays as a blank line.
      ["text", "hardBreak", "text", "hardBreak", "hardBreak", "text"],
    );
    assert.deepEqual(
      doc.content.map((n) => n.type),
      [
        "paragraph",
        "paragraph",
        "paragraph",
        "paragraph",
        "bulletList",
        "paragraph",
        "orderedList",
        "paragraph",
      ],
    );
    // Not an ad: no banner.
    assert.equal(
      richTextPlain(first.description).split("\n")[0],
      "GanchoGancho 1",
    );
  },
);

await check(
  "observação do cliente vira um tópico; novas liberações já saem formatadas",
  async () => {
    // A note the client left on a post approved later.
    await db.exec("reset role");
    await db.query(
      "update social_leads_posts set decision='approved', decided_at=now(), note='Trocar a foto' where plan_id=$1 and number=4",
      [planId],
    );
    await as(lorena);
    await db.query("select public.social_leads_release($1,'{}')", [planId]);
    await db.exec("reset role");
    const fourth = (await descriptions())[3];
    assert.equal(fourth.number, 4);
    const lines = richTextPlain(fourth.description).split("\n");
    assert.equal(lines[0], "GanchoGancho 4");
    assert.equal(lines[4], "Observação do clienteTrocar a foto");
  },
);

await check("o post é achado pela tarefa (índice e leitura)", async () => {
  await db.exec("reset role");
  assert.ok(
    await one(
      "select 1 from pg_indexes where indexname = 'social_leads_posts_task'",
    ),
  );
  await as(designer);
  const task = (
    await one(
      "select task_id from social_leads_posts where plan_id=$1 and number=1",
      [planId],
    )
  )?.task_id;
  assert.ok(task, "o designer da tarefa lê o post");
});

console.log(`\n${passed} verificações da descrição das tarefas passaram.`);
